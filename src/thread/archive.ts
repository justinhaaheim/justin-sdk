/**
 * The report archive and the failure spool (home-base-p1uj D5).
 *
 * Two jobs, both about never losing a report:
 *
 *  - ARCHIVE. Every validated payload is written to
 *    `<stateDir>/reports/<sessionId>/<timestamp>.json` BEFORE a single bd
 *    command runs. bd can be locked, sandboxed, or simply missing; the payload
 *    is the expensive artefact and it must survive all three.
 *  - SPOOL. When the bd write then fails, the same document is written to
 *    `<stateDir>/spool/<sessionId>-<timestamp>.json`, which is what `thread
 *    board` drains later. The archive alone is not enough: it records every
 *    report, so nothing in it says which ones never reached a bead.
 *
 * Both return a Result. A failed archive is a NAMED failure the caller prints —
 * never a silently skipped write, because the one thing worse than a report
 * that did not reach bd is a report that reached nothing at all and said so
 * nowhere.
 */

import type {ThreadFacts} from './facts';
import type {EnvLike} from './paths';
import type {ThreadReportPayload} from './schema';

import {mkdirSync, readdirSync, statSync, writeFileSync} from 'fs';
import {join} from 'path';

import {probeErrorMessage, threadsStateDir} from './paths';

/** What gets written to disk: the payload, the facts, and the provenance. */
export interface ArchivedReport {
  facts: ThreadFacts;
  payload: ThreadReportPayload;
  reportedAt: string;
  schemaVersion: number;
  sessionId: string;
  /** Set on a spooled copy: why bd did not take it. Absent in the archive. */
  spoolReason?: string;
}

export type WriteResult =
  | {ok: true; path: string}
  | {error: string; ok: false; path: string};

/**
 * A filesystem-safe stamp. `:` is legal on APFS but is rendered as `/` by
 * Finder and is a path separator on other platforms, so ISO's colons and the
 * fractional dot become dashes. Sorts lexicographically, which is the only
 * ordering the drain path needs.
 */
export function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function writeJson(path: string, dir: string, body: unknown): WriteResult {
  try {
    mkdirSync(dir, {recursive: true});
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    return {ok: true, path};
  } catch (error) {
    return {error: probeErrorMessage(error), ok: false, path};
  }
}

/**
 * The parent of every per-session archive directory.
 *
 * Exported because `thread search` (k0b8n.2, K8) reads the whole archive rather
 * than one session's, and the directory layout must be spelled in exactly one
 * place: a search that hardcoded `<state>/reports` would go quietly blind the
 * day this moved.
 */
export function reportsRootDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'reports');
}

export function reportsDir(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(reportsRootDir(env), sessionId);
}

export function spoolDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'spool');
}

/** Where `thread prepare` tells Claude to write its payload. */
export function draftPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(threadsStateDir(env), 'drafts', `${sessionId}.json`);
}

/** Write the archive copy. Call BEFORE any bd command. */
export function archiveReport(
  report: ArchivedReport,
  env: EnvLike = process.env,
): WriteResult {
  const dir = reportsDir(report.sessionId, env);
  return writeJson(
    join(dir, `${fileStamp(report.reportedAt)}.json`),
    dir,
    report,
  );
}

/**
 * Where a FAILED `thread start` leaves its trace (home-base-p1uj.3).
 *
 * Deliberately NOT `spool/`. The spool is drained by `thread board`, which
 * reads every file in it as an `ArchivedReport` and replays it through
 * `writeReportToBd`; a start record has no payload and no asks, so putting one
 * there would either wedge the drain or, worse, get half-applied. The two also
 * want different fates: a spooled report MUST eventually reach bd or Justin
 * loses work, whereas a failed start is only a missed head start — the session's
 * first real report still creates the bead. So this is an audit trail, not a
 * queue, and nothing drains it.
 *
 * It exists at all because the alternative is silence: a hook that swallows
 * every bd failure at session start is exactly the calm, invisible failure
 * rule 6 is about.
 */
export function startFailuresDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'start-failures');
}

export interface StartFailureRecord {
  facts: ThreadFacts;
  sessionId: string;
  startedAt: string;
}

export function recordStartFailure(
  record: StartFailureRecord,
  reason: string,
  env: EnvLike = process.env,
): WriteResult {
  const dir = startFailuresDir(env);
  const name = `${record.sessionId}-${fileStamp(record.startedAt)}.json`;
  return writeJson(join(dir, name), dir, {
    ...record,
    kind: 'threadStartFailed',
    reason,
  });
}

/**
 * Where the Stop hook remembers that it has already blocked one turn
 * (home-base-p1uj.15).
 *
 * Keyed by session AND turn, because a blocked Stop hands Claude another turn
 * whose Stop fires again: without the marker the second decision is identical to
 * the first and the session is wedged in a block loop. Claude Code's own
 * `stop_hook_active` flag is the first guard and this file is the second — two,
 * because the flag is only documented to be set on the NEXT Stop input, and a
 * wedged session is a much worse failure than a missed nag.
 *
 * An empty file in the state dir, not a record: nothing ever reads its contents,
 * only whether it is there. They are tiny and they are per-turn, so nothing
 * prunes them for now.
 */
export function stopMarkPath(
  sessionId: string,
  turnKey: string,
  env: EnvLike = process.env,
): string {
  return join(
    threadsStateDir(env),
    'stop-marks',
    `${sessionId}-${fileStamp(turnKey)}`,
  );
}

/**
 * Where every session's messages are logged (home-base-k0b8n.9, K10 b/e).
 *
 * One `<sessionId>.jsonl` per session: an append-only line per prompt and per
 * final Claude message, written by the `thread capture` hook and rewritten from
 * the transcript by `thread backfill`. It is an INDEX of the transcript, not an
 * archive of it — the transcript stays the source of truth — so it lives here
 * beside the report archive (D5), is never committed to the threads repo and is
 * never pushed (K10 anti-decision 2).
 */
export function messagesDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'messages');
}

export function messageLogPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(messagesDir(env), `${sessionId}.jsonl`);
}

/**
 * The capture child's per-session lock and its dirty stamp (K10 c).
 *
 * The lock serialises bd writers for ONE session: at most one child per session
 * talks to bd at a time. A child that finds it held writes the dirty stamp and
 * leaves; the holder sees the stamp and runs once more, so the newest message
 * always lands without two writers racing.
 */
export function captureLocksDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'capture-locks');
}

export function captureLockPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(captureLocksDir(env), `${sessionId}.lock`);
}

export function captureDirtyPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(captureLocksDir(env), `${sessionId}.dirty`);
}

/**
 * The SEEDED stamp (home-base-k0b8n.16): present once the capture child has
 * rewritten this session's log from its transcript. A sidecar rather than a
 * line in the log, so the log stays pure message lines for every reader and
 * the backfill's authoritative rewrite cannot erase it. Only a SUCCESSFUL
 * seed writes it; a seed that could not read the transcript leaves it absent,
 * so the next capture tries again.
 */
export function captureSeedStampPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(captureLocksDir(env), `${sessionId}.seeded`);
}

/**
 * One JSON line per `thread stop-check` run, passes included (k0b8n.11, K12),
 * so "has the refusal ever kicked in" is `thread stop-check --stats`, not an
 * archaeology dig through transcripts.
 */
export function stopCheckLogPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'stop-check.jsonl');
}

/**
 * One JSON line per capture-child run: what it did to which bead, or why it
 * could not (K10 c). The child runs detached with its stdio ignored, so this
 * file is the ONLY place a bd failure can be loud.
 */
export function captureRunLogPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'capture.jsonl');
}

/** Drop the marker. A failure is NAMED — the caller must not block without it. */
export function writeStopMark(
  sessionId: string,
  turnKey: string,
  env: EnvLike = process.env,
): WriteResult {
  const path = stopMarkPath(sessionId, turnKey, env);
  try {
    mkdirSync(join(threadsStateDir(env), 'stop-marks'), {recursive: true});
    writeFileSync(path, '');
    return {ok: true, path};
  } catch (error) {
    return {error: probeErrorMessage(error), ok: false, path};
  }
}

export function stopMarkExists(
  sessionId: string,
  turnKey: string,
  env: EnvLike = process.env,
): boolean {
  try {
    return statSync(stopMarkPath(sessionId, turnKey, env)).isFile();
  } catch {
    // Absent, or unreadable. Both mean "no proof we have blocked this turn",
    // and the caller's marker WRITE is what decides whether it may block at all,
    // so guessing wrong here cannot wedge anything.
    return false;
  }
}

/**
 * When this session last had a report archived — the measurement the Stop hook
 * compares against Justin's last message (home-base-p1uj.15).
 *
 * THREE STATES, not two (rule 6). "I looked and this session has archived
 * nothing" is the finding that justifies a block; "I could not look" is not, and
 * collapsing the second into the first would turn a sandbox denial into an
 * accusation. `unknown` carries the failure so the caller can pass silently and
 * still say why when asked.
 */
export type ArchiveProbe =
  | {kind: 'none'}
  | {at: number; kind: 'newest'}
  | {error: string; kind: 'unknown'};

export function newestArchivedReportAt(
  sessionId: string,
  env: EnvLike = process.env,
): ArchiveProbe {
  const dir = reportsDir(sessionId, env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : '';
    // ENOENT is the ANSWER "this session has archived nothing", because the
    // per-session directory is created by the first archive write. Anything else
    // — EPERM under the sandbox, EACCES, a file where the directory should be —
    // is a failed measurement.
    if (code === 'ENOENT') return {kind: 'none'};
    return {
      error: `readdir ${dir}: ${probeErrorMessage(error)}`,
      kind: 'unknown',
    };
  }

  let newest: number | null = null;
  let failures = 0;
  let lastError = '';
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const at = statSync(join(dir, name)).mtimeMs;
      if (newest == null || at > newest) newest = at;
    } catch (error) {
      failures += 1;
      lastError = probeErrorMessage(error);
    }
  }
  if (newest != null) return {at: newest, kind: 'newest'};
  // Nothing readable. An empty directory is a real "none"; one whose entries all
  // failed to stat is not.
  if (failures > 0) {
    return {
      error: `stat ${failures} archived report(s) in ${dir}: ${lastError}`,
      kind: 'unknown',
    };
  }
  return {kind: 'none'};
}

/** Write the spool copy, with the reason bd did not take it. */
export function spoolReport(
  report: ArchivedReport,
  reason: string,
  env: EnvLike = process.env,
): WriteResult {
  const dir = spoolDir(env);
  const name = `${report.sessionId}-${fileStamp(report.reportedAt)}.json`;
  return writeJson(join(dir, name), dir, {...report, spoolReason: reason});
}
