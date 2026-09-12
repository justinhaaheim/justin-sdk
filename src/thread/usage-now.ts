/**
 * `justin-sdk usage-now` — how many tokens of context THIS session has used,
 * on demand (home-base-p1uj.1, item 10).
 *
 * The `usage-check` HOOK already computes this, but only when a setpoint is
 * crossed and only into the transcript. A session writing its wrap-up report
 * needs the number NOW, and the number it needs is the same one: the last
 * assistant record's `input_tokens + cache_creation + cache_read`. So this
 * reuses `readTranscriptFacts` rather than reimplementing the measurement —
 * there must be exactly one definition of "context size" in this SDK.
 *
 * "Usage" here is CONTEXT, not subscription quota. `/usage` and justin-loop's
 * usage gate report a completely different number; nothing here talks to a
 * server.
 *
 * RULE 6: an unmeasurable context prints UNKNOWN with the reason and exits 1.
 * It is never 0 — a session at 0 tokens and a session whose transcript could
 * not be read are opposite facts, and the number is read by wrap-up logic.
 */

import {findTranscript} from './facts';
import {formatTokens, readTranscriptFacts} from '../usage-check';

import type {EnvLike} from './paths';

export interface UsageNowOptions {
  env?: EnvLike;
  json?: boolean;
  sessionId?: string | null;
  transcriptPath?: string | null;
}

export interface UsageNowResult {
  contextTokens: number | null;
  reason: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
}

/** Measure, without printing. Never throws. */
export function measureUsageNow(options: UsageNowOptions = {}): UsageNowResult {
  const env = options.env ?? process.env;
  const sessionId =
    options.sessionId != null && options.sessionId !== ''
      ? options.sessionId
      : (env.CLAUDE_CODE_SESSION_ID ?? null);

  let transcriptPath: string | null = null;
  if (options.transcriptPath != null && options.transcriptPath !== '') {
    transcriptPath = options.transcriptPath;
  } else if (sessionId == null || sessionId === '') {
    return {
      contextTokens: null,
      reason:
        'no session id: CLAUDE_CODE_SESSION_ID is unset and neither --session nor --transcript was passed',
      sessionId: null,
      transcriptPath: null,
    };
  } else {
    const lookup = findTranscript(sessionId, env);
    if (lookup.status === 'found') {
      transcriptPath = lookup.path;
    } else {
      return {
        contextTokens: null,
        reason:
          lookup.status === 'not-found'
            ? `no ${sessionId}.jsonl under ${lookup.searched}`
            : lookup.error,
        sessionId,
        transcriptPath: null,
      };
    }
  }

  try {
    const facts = readTranscriptFacts({
      lowestSetpoint: Number.MAX_SAFE_INTEGER,
      scope: 'session',
      transcriptPath,
    });
    if (facts.contextTokens == null) {
      return {
        contextTokens: null,
        reason: `no assistant record carrying message.usage was found in ${transcriptPath}`,
        sessionId,
        transcriptPath,
      };
    }
    return {
      contextTokens: facts.contextTokens,
      reason: null,
      sessionId,
      transcriptPath,
    };
  } catch (error) {
    return {
      contextTokens: null,
      reason: `could not read ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      sessionId,
      transcriptPath,
    };
  }
}

export function runUsageNow(options: UsageNowOptions = {}): number {
  const result = measureUsageNow(options);
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return result.contextTokens == null ? 1 : 0;
  }
  if (result.contextTokens == null) {
    console.error(
      `usage-now: UNKNOWN — ${result.reason ?? 'no reason recorded'}`,
    );
    return 1;
  }
  console.log(
    `${formatTokens(result.contextTokens)} tokens of context (session ${result.sessionId ?? 'unknown'})`,
  );
  return 0;
}
