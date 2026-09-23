/**
 * `justin-sdk thread capture` — record every prompt and every Claude yield, at
 * every turn, whether or not a status report is ever written (home-base-k0b8n.9,
 * decision K10).
 *
 * Justin, 2026-09-23: "regardless of whether the agent ever files the formal
 * status report I still want the thread tooling to capture whatever claude's
 * yield message is to me … by default all user messages and all claude yield
 * messages are captured by the tooling, and therefore the threads tooling should
 * (hopefully) always be up to date."
 *
 * ONE COMMAND, TWO HOOKS: `UserPromptSubmit` (payload `prompt`) and `Stop`
 * (payload `last_assistant_message` — the transcript LAGS the in-memory turn,
 * see stop-check.ts's header, so the yield comes from the payload). Each run:
 *
 *  (a) SKIPS a subagent (`agent_id`), a `claude -p` run, an empty message, and
 *      any repo where `componentConfig.thread.enabled && .capture` is false.
 *  (b) APPENDS one line to `<stateDir>/messages/<sessionId>.jsonl`,
 *      synchronously (message-log.ts). That is the whole cost a turn pays.
 *  (c) SPAWNS a DETACHED child (`thread capture --apply <sessionId>`) that
 *      finds or creates the thread bead and merges the log's TAIL into its
 *      metadata, serialised per session by a lock + dirty stamp.
 *  (d) The child COMMITS the threads repo and never pushes (K10 d).
 *
 * THE HOOK NEVER BLOCKS AND NEVER SPEAKS. Exit 0 on every path, including a
 * thrown one. Nothing on stdout, ever: a UserPromptSubmit hook's stdout is
 * injected into the model's context, and a capture that talked to the model on
 * every prompt would be a worse bug than one that captured nothing. Failures go
 * to stderr (the hook) or to `<stateDir>/capture.jsonl` (the child, whose stdio
 * is ignored).
 *
 * WHY NOT INSIDE stop-check (K10 anti-decision 1): stop-check is gated on
 * `enforce` and promises it never writes; capture is default-on and always
 * writes. One process with two contracts is how a knob-off guarantee erodes.
 */

import type {BdContext, BdFailure, BdIssue} from './bd';
import type {CommitOutcome} from './commit';
import type {AppendOutcome, MessageLine} from './message-log';
import type {EnvLike} from './paths';

import {spawn} from 'child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {fileURLToPath} from 'url';

import {silencedChildEnv} from '../health-notices';
import {
  captureDirtyPath,
  captureLockPath,
  captureLocksDir,
  captureRunLogPath,
  captureSeedStampPath,
  messageLogPath,
} from './archive';
import {
  bdContext,
  describeBdFailure,
  findThreadBySession,
  mergeMetadata,
  setThreadInProgress,
} from './bd';
import {commitThreadsRepo, pidAlive} from './commit';
import {resolveThreadConfig} from './config';
// Already in the hook's import graph through ./archive, so static costs nothing.
import {findTranscript} from './facts';
import {
  appendMessageLine,
  isSafeSessionId,
  readMessageLog,
  syncMessageLogFromTurns,
} from './message-log';
import {probeErrorMessage} from './paths';
import {
  buildResumeCommand,
  extractTranscriptTurns,
  stripHarnessNoise,
  type TranscriptTurns,
} from './transcript-messages';

/** The entrypoint a `claude -p` session runs under (measured, see below). */
export const NON_INTERACTIVE_ENTRYPOINT = 'sdk-cli';

/**
 * `metadata.messagesSource` when capture wrote the message fields (K10 c),
 * beside 'report', 'start' and 'backfill'.
 */
export const CAPTURE_MESSAGES_SOURCE = 'capture';

/** The detached child's bounded retry loop (K10 c). */
export const MAX_APPLY_PASSES = 5;

/** The two events this hook records. Anything else is a no-op. */
export type CaptureEvent = 'Stop' | 'UserPromptSubmit';

export type CaptureSkip =
  | 'badSessionId'
  | 'emptyText'
  | 'knobOff'
  | 'noSessionId'
  | 'nonInteractive'
  | 'subagent'
  | 'unreadablePayload'
  | 'unsupportedEvent';

/** The hook payload, as much of it as capture reads. */
export interface CaptureHookInput {
  agent_id?: string | null;
  cwd?: string | null;
  hook_event_name?: string | null;
  last_assistant_message?: string | null;
  prompt?: string | null;
  session_id?: string | null;
  transcript_path?: string | null;
}

export type CaptureDecision =
  | {detail: string; kind: 'skip'; why: CaptureSkip}
  | {
      cwd: string | null;
      event: CaptureEvent;
      kind: 'capture';
      line: MessageLine;
      sessionId: string;
      transcriptPath: string | null;
    };

/**
 * A slash command with no arguments (`/copy`, `/loop-session`).
 *
 * K2 renders such an envelope as NOTHING in the transcript, so a backfilled log
 * never contains it; capturing it live would make the two logs of one session
 * disagree. With arguments it is Justin's brief (`/conductor <the brief>`) and
 * is kept verbatim, exactly as K2 keeps it.
 */
const BARE_SLASH_COMMAND = /^\/\S+$/;

/** A prompt's text as K2 would store it. '' means "nothing of his". */
export function capturedUserText(prompt: string): string {
  const trimmed = prompt.trim();
  if (BARE_SLASH_COMMAND.test(trimmed)) return '';
  return stripHarnessNoise(prompt);
}

/**
 * A yield's text as K3's `assistantText` would store it: trimmed, and nothing
 * else. NOT noise-stripped — Claude quoting `<system-reminder>` in a reply is
 * Claude's words, and the backfill does not strip assistant text either, so
 * stripping here would make a live line differ from its backfilled twin.
 */
export function capturedAssistantText(text: string): string {
  return text.trim();
}

/**
 * Everything the hook decides BEFORE the knob, as a pure function.
 *
 * ORDER: the event first (anything else is not ours), then the subagent guard
 * (a player's prompts are its conductor's business), then `claude -p`, then the
 * session id, then the text. The knob is read by the caller AFTER this, because
 * it costs two file reads and every earlier skip is free.
 *
 * NON-INTERACTIVE, MEASURED 2026-09-23 (scripts/probe-capture-entrypoint.ts,
 * claude 2.1.280): a `claude -p` session's hooks see CLAUDE_CODE_ENTRYPOINT=
 * `sdk-cli` and its transcript records `entrypoint: "sdk-cli"`; a justin-loop
 * `claude --bg` session's hooks see `cli` and its transcript records `cli` (as
 * do all 25 e2e fixture transcripts on this machine). The payload itself
 * carries no entrypoint. So `sdk-cli` is skipped and `--bg` is kept, per K10.
 */
export function decideCapture(
  input: CaptureHookInput,
  context: {entrypoint: string | null; now: Date},
): CaptureDecision {
  const event = input.hook_event_name;
  if (event !== 'UserPromptSubmit' && event !== 'Stop') {
    return {
      detail: `hook_event_name ${JSON.stringify(event ?? null)} is not UserPromptSubmit or Stop`,
      kind: 'skip',
      why: 'unsupportedEvent',
    };
  }
  if (input.agent_id != null && input.agent_id !== '') {
    return {
      detail: `subagent (agent_id=${input.agent_id}); its conductor owns the thread`,
      kind: 'skip',
      why: 'subagent',
    };
  }
  if (context.entrypoint === NON_INTERACTIVE_ENTRYPOINT) {
    return {
      detail: `CLAUDE_CODE_ENTRYPOINT=${NON_INTERACTIVE_ENTRYPOINT} (a claude -p run)`,
      kind: 'skip',
      why: 'nonInteractive',
    };
  }
  const sessionId = input.session_id ?? null;
  if (sessionId == null || sessionId === '') {
    return {
      detail: 'no session_id in the payload',
      kind: 'skip',
      why: 'noSessionId',
    };
  }
  if (!isSafeSessionId(sessionId)) {
    return {
      detail: `session_id ${JSON.stringify(sessionId)} is not a safe file name`,
      kind: 'skip',
      why: 'badSessionId',
    };
  }
  const role = event === 'UserPromptSubmit' ? 'user' : 'assistant';
  const raw =
    event === 'UserPromptSubmit'
      ? (input.prompt ?? '')
      : (input.last_assistant_message ?? '');
  const text =
    role === 'user' ? capturedUserText(raw) : capturedAssistantText(raw);
  if (text === '') {
    return {
      detail: `the ${role === 'user' ? 'prompt' : 'last assistant message'} is empty after stripping harness noise`,
      kind: 'skip',
      why: 'emptyText',
    };
  }
  const cwd = input.cwd != null && input.cwd !== '' ? input.cwd : null;
  return {
    cwd,
    event,
    kind: 'capture',
    line: {at: context.now.toISOString(), cwd, event, role, text},
    sessionId,
    transcriptPath:
      input.transcript_path != null && input.transcript_path !== ''
        ? input.transcript_path
        : null,
  };
}

// ---------------------------------------------------------------------------
// The hook (K10 a, b, and the spawn of c)
// ---------------------------------------------------------------------------

/** The absolute path of the CLI this module ships in. The child runs THIS code. */
export const CLI_PATH = fileURLToPath(new URL('../cli.ts', import.meta.url));

export interface ApplyRequest {
  cwd: string | null;
  env: EnvLike;
  /**
   * The hook's synchronous wall time up to the spawn, ms. Handed to the child,
   * which records it in capture.jsonl — the only place a REAL hook run's
   * timing survives, since the hook itself prints nothing (K10 b budget).
   */
  hookElapsedMs: number | null;
  sessionId: string;
  transcriptPath: string | null;
}

export type SpawnOutcome =
  | {error: string; kind: 'failed'}
  | {kind: 'spawned'; pid: number | null};

/**
 * Start `thread capture --apply` DETACHED and return at once (K10 c).
 *
 * `detached` puts the child in its own process group, `stdio: 'ignore'` gives
 * it nothing tied to the hook's pipes, and `unref` lets this process exit
 * without waiting. `process.execPath` + this package's own cli.ts means the
 * child runs the SAME build as the hook — not whatever `justin-sdk` a PATH
 * lookup would find from the payload's cwd.
 */
export function spawnDetachedApply(request: ApplyRequest): SpawnOutcome {
  const args = [CLI_PATH, 'thread', 'capture', '--apply', request.sessionId];
  if (request.cwd != null) args.push('--cwd', request.cwd);
  if (request.transcriptPath != null) {
    args.push('--transcript', request.transcriptPath);
  }
  if (request.hookElapsedMs != null) {
    args.push('--hook-ms', String(request.hookElapsedMs));
  }
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      env: silencedChildEnv(request.env) as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    // An async spawn failure (ENOENT) must not become an unhandled 'error' that
    // crashes the hook after it has already done its job. It is still said.
    child.on('error', (error) => {
      console.error(
        `[thread capture] the bead update child failed to start: ${probeErrorMessage(error)}`,
      );
    });
    child.unref();
    return {kind: 'spawned', pid: child.pid ?? null};
  } catch (error) {
    return {error: probeErrorMessage(error), kind: 'failed'};
  }
}

/** One line for `--explain`. */
export function describeCaptureHook(
  decision: CaptureDecision,
  append: AppendOutcome | null,
  spawned: SpawnOutcome | null,
): string {
  if (decision.kind === 'skip')
    return `skip (${decision.why}): ${decision.detail}`;
  const head = `${decision.event} → ${decision.line.role} line for ${decision.sessionId}`;
  if (append == null) return `${head}: not written`;
  if (append.kind === 'failed') return `${head}: NOT LOGGED — ${append.error}`;
  if (append.kind === 'duplicate') {
    return `${head}: duplicate, not appended (${append.reason}); bead update ${spawned?.kind ?? 'not started'}`;
  }
  return `${head}: appended to ${append.path}; bead update ${spawned?.kind === 'spawned' ? `spawned (pid ${spawned.pid ?? '?'})` : `FAILED to start${spawned?.kind === 'failed' ? ` — ${spawned.error}` : ''}`}`;
}

export interface CaptureHookResult {
  append: AppendOutcome | null;
  decision: CaptureDecision;
  /** Wall time of the synchronous part, ms (K10 b budget: < 50). */
  elapsedMs: number;
  /** ALWAYS 0. A field so a test can assert it on every path. */
  exitCode: 0;
  spawn: SpawnOutcome | null;
}

/**
 * The hook. SYNCHRONOUS, ALWAYS RETURNS exit 0, never throws, prints nothing
 * to stdout.
 */
export function runThreadCaptureHook(
  args: {
    env?: EnvLike;
    explain?: boolean;
    now?: Date;
    spawnApply?: (request: ApplyRequest) => SpawnOutcome;
    stdin?: string;
  } = {},
): CaptureHookResult {
  const started = performance.now();
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  const explain = args.explain === true;
  let append: AppendOutcome | null = null;
  let spawned: SpawnOutcome | null = null;

  const finish = (decision: CaptureDecision): CaptureHookResult => {
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    if (explain) {
      console.error(
        `[thread capture] ${describeCaptureHook(decision, append, spawned)}`,
      );
      console.error(`[thread capture] ${elapsedMs}ms (synchronous part)`);
    }
    return {append, decision, elapsedMs, exitCode: 0, spawn: spawned};
  };

  let input: CaptureHookInput;
  try {
    const raw = args.stdin ?? readFileSync(0, 'utf8');
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the payload is not a JSON object');
    }
    input = parsed as CaptureHookInput;
  } catch (error) {
    return finish({
      detail: `unreadable payload: ${probeErrorMessage(error)}`,
      kind: 'skip',
      why: 'unreadablePayload',
    });
  }

  try {
    const decision = decideCapture(input, {
      entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
      now,
    });
    if (decision.kind === 'skip') return finish(decision);

    const config = resolveThreadConfig({
      cwd: decision.cwd ?? undefined,
      env,
    });
    if (!config.captureActive) {
      return finish({
        detail: !config.enabled
          ? `componentConfig.thread.enabled is not true (resolved from: ${config.source})`
          : `componentConfig.thread.capture is false (resolved from: ${config.captureSource})`,
        kind: 'skip',
        why: 'knobOff',
      });
    }

    append = appendMessageLine(
      messageLogPath(decision.sessionId, env),
      decision.line,
    );
    if (append.kind === 'failed') {
      console.error(
        `[thread capture] message NOT logged: ${append.path} (${append.error})`,
      );
      return finish(decision);
    }
    // A DUPLICATE still spawns: the log is already right, but the bead may not
    // be — the child applies the log's tail, never this payload, so running it
    // again is harmless and is what heals a bead a failed child left behind.
    const spawnApply = args.spawnApply ?? spawnDetachedApply;
    spawned = spawnApply({
      cwd: decision.cwd,
      env,
      hookElapsedMs: Math.round((performance.now() - started) * 10) / 10,
      sessionId: decision.sessionId,
      transcriptPath: decision.transcriptPath,
    });
    if (spawned.kind === 'failed') {
      console.error(
        `[thread capture] logged, but the bead update could not be started: ${spawned.error}`,
      );
    }
    return finish(decision);
  } catch (error) {
    console.error(
      `[thread capture] unexpected failure, nothing blocked: ${probeErrorMessage(error)}`,
    );
    return finish({
      detail: `internal failure: ${probeErrorMessage(error)}`,
      kind: 'skip',
      why: 'unreadablePayload',
    });
  }
}

// ---------------------------------------------------------------------------
// The detached child (K10 c, d)
// ---------------------------------------------------------------------------

/** What one log says about its session, read from its lines. */
export interface LogSummary {
  count: number;
  firstUser: MessageLine | null;
  lastAssistant: MessageLine | null;
  lastUser: MessageLine | null;
  /** The newest `at` among the lines — the session's last known activity. */
  newestAt: string | null;
}

export function summarizeLog(lines: readonly MessageLine[]): LogSummary {
  const summary: LogSummary = {
    count: lines.length,
    firstUser: null,
    lastAssistant: null,
    lastUser: null,
    newestAt: null,
  };
  for (const line of lines) {
    if (line.role === 'user') {
      summary.firstUser ??= line;
      summary.lastUser = line;
    } else {
      summary.lastAssistant = line;
    }
    if (
      line.at != null &&
      (summary.newestAt == null || line.at > summary.newestAt)
    )
      summary.newestAt = line.at;
  }
  return summary;
}

function metaText(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function autofillFailureList(meta: Record<string, unknown>): string[] {
  const value = meta.autofillFailures;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function otherAutofillFailures(meta: Record<string, unknown>): string[] {
  return autofillFailureList(meta).filter(
    (entry) => !entry.startsWith('resumeCommand:'),
  );
}

/**
 * The metadata keys capture owns, from the log's TAIL (K10 c).
 *
 * A key the log cannot speak to is NOT SENT, rather than sent as null: a log
 * that holds only Claude's lines (capture was installed mid-session) says
 * nothing about Justin's last message, and `--metadata` merges, so a null here
 * would erase a value the report or the backfill measured. `firstUserMessage`
 * is filled only where the bead has none — the first message of a session is
 * the transcript's to say, and the log may have started late.
 */
export function capturePatch(
  summary: LogSummary,
  meta: Record<string, unknown>,
  resume: ResumeFill | null = null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    messageCount: summary.count,
    messagesSource: CAPTURE_MESSAGES_SOURCE,
  };
  // k0b8n.15: ONLY when the bead has no resume command. One a report or the
  // backfill wrote is theirs, and is never overwritten from here.
  if (resume != null && metaText(meta, 'resumeCommand') == null) {
    const others = otherAutofillFailures(meta);
    if (resume.command != null) {
      patch.resumeCommand = resume.command;
      // A reason recorded by an earlier failed attempt is now false. Dropped
      // only when there was one, so an untouched list is not rewritten.
      if (others.length !== autofillFailureList(meta).length) {
        patch.autofillFailures = others;
      }
    } else {
      // Still unbuildable: the reason goes where `thread show` looks for it,
      // keyed `resumeCommand:`, so it never prints "no reason recorded".
      patch.autofillFailures = [...others, resume.failure];
    }
  }
  if (summary.lastUser != null) {
    patch.lastUserMessage = summary.lastUser.text;
    patch.lastUserMessageAt = summary.lastUser.at;
  }
  if (summary.lastAssistant != null) {
    patch.lastAssistantMessage = summary.lastAssistant.text;
    patch.lastAssistantMessageAt = summary.lastAssistant.at;
  }
  if (summary.newestAt != null) patch.lastActivityAt = summary.newestAt;
  if (metaText(meta, 'firstUserMessage') == null && summary.firstUser != null) {
    patch.firstUserMessage = summary.firstUser.text;
    patch.firstUserMessageAt = summary.firstUser.at;
  }
  return patch;
}

/**
 * Would merging `patch` change anything? By VALUE: `autofillFailures` is an
 * array, and comparing arrays by identity would call every pass a change and
 * turn an unchanged log into a bd write per turn.
 */
function patchChanges(
  patch: Record<string, unknown>,
  meta: Record<string, unknown>,
): boolean {
  return Object.entries(patch).some(
    ([key, value]) =>
      JSON.stringify(meta[key] ?? null) !== JSON.stringify(value ?? null),
  );
}

// ---- the transcript, read at most once per child (k0b8n.15, k0b8n.16) -------

/**
 * The transcript as one child run read it. `unavailable` is a MEASURED failure
 * to read it, carrying why — never an empty transcript (rule 7).
 */
export type TranscriptRead =
  | {error: string; kind: 'unavailable'}
  | {extracted: TranscriptTurns; kind: 'read'; path: string};

/**
 * Read this session's transcript: the payload's path when the hook passed one,
 * else the by-session-id search `thread start` uses. ONE forward pass
 * (`extractTranscriptTurns`), shared by the seed and the resume fill.
 */
export function readTranscriptForCapture(
  options: Pick<ApplyOptions, 'env' | 'sessionId' | 'transcriptPath'>,
): TranscriptRead {
  const env = options.env ?? process.env;
  let path = options.transcriptPath ?? null;
  if (path == null || path === '') {
    const lookup = findTranscript(options.sessionId, env);
    if (lookup.status !== 'found') {
      return {
        error:
          lookup.status === 'failed'
            ? lookup.error
            : `no transcript for ${options.sessionId} under ${lookup.searched}`,
        kind: 'unavailable',
      };
    }
    path = lookup.path;
  }
  try {
    return {extracted: extractTranscriptTurns(path), kind: 'read', path};
  } catch (error) {
    return {
      error: `read ${path}: ${probeErrorMessage(error)}`,
      kind: 'unavailable',
    };
  }
}

/** `readTranscriptForCapture`, run at most once however often it is asked. */
export function memoizedTranscript(
  options: Pick<ApplyOptions, 'env' | 'sessionId' | 'transcriptPath'>,
): () => TranscriptRead {
  let read: TranscriptRead | null = null;
  return () => (read ??= readTranscriptForCapture(options));
}

/** A resume command, or the `resumeCommand:`-keyed reason there is none. */
export type ResumeFill =
  | {command: null; failure: string}
  | {command: string; failure: string | null};

/**
 * The resume command the BACKFILL would compute (k0b8n.15): the same
 * `buildResumeCommand`, fed the same first/last record cwd and the session id
 * the transcript records, exactly as `extractTranscriptMessages` feeds it.
 */
export function resumeFillFrom(transcript: TranscriptRead): ResumeFill {
  if (transcript.kind === 'unavailable') {
    return {command: null, failure: `resumeCommand: ${transcript.error}`};
  }
  const built = buildResumeCommand({
    firstCwd: transcript.extracted.firstCwd,
    lastCwd: transcript.extracted.lastCwd,
    sessionId: transcript.extracted.sessionId,
    transcriptPath: transcript.path,
  });
  if (built.command != null) {
    return {command: built.command, failure: built.failure};
  }
  return {
    command: null,
    failure: built.failure ?? 'resumeCommand: no reason given by the builder',
  };
}

// ---- the seed (k0b8n.16) -----------------------------------------------------

/**
 * What seeding this session's log did. Only `seeded` writes the stamp, so a
 * session whose transcript could not be read is tried again next capture.
 */
export type SeedOutcome =
  | {kind: 'alreadySeeded'}
  | {error: string; kind: 'failed'}
  | {
      carried: number;
      kind: 'seeded';
      messages: number;
      /** False when the log already said exactly this (the backfill got here first). */
      rewrote: boolean;
      /** Set when the stamp could not be written: the next capture seeds again. */
      stampError: string | null;
    };

export function isLogSeeded(sessionId: string, env: EnvLike): boolean {
  try {
    return statSync(captureSeedStampPath(sessionId, env)).isFile();
  } catch {
    return false;
  }
}

/**
 * Rebuild the log from the transcript ONCE per session (home-base-k0b8n.16).
 *
 * WHY: a session already running when the capture hooks landed has a log that
 * starts mid-session — the conductor's held four Stop lines and no user line,
 * so its bead's "Last user message" stayed on a four-day-old brief. The fix is
 * the backfill's own authoritative rewrite (`syncMessageLogFromTurns`, with its
 * carry rule for live lines newer than the transcript), run by the capture
 * child the first time it sees the session, then never again: the sidecar
 * stamp marks it. Called with the per-session lock held, before the first
 * pass, so the pass applies the seeded log's tail.
 *
 * SYNCHRONOUS on purpose: the lock is taken and the first pass reads the log
 * before the child's first await, which is what the convergence argument in
 * `applyCapture` leans on (and what its test pins).
 */
export function seedMessageLogOnce(
  options: Pick<ApplyOptions, 'env' | 'sessionId'>,
  transcript: () => TranscriptRead,
): SeedOutcome {
  const env = options.env ?? process.env;
  if (isLogSeeded(options.sessionId, env)) return {kind: 'alreadySeeded'};
  const read = transcript();
  if (read.kind === 'unavailable') return {error: read.error, kind: 'failed'};
  const synced = syncMessageLogFromTurns({
    env,
    extracted: read.extracted,
    sessionId: options.sessionId,
  });
  if (synced.kind === 'failed') return {error: synced.error, kind: 'failed'};
  let stampError: string | null = null;
  try {
    mkdirSync(captureLocksDir(env), {recursive: true});
    writeFileSync(
      captureSeedStampPath(options.sessionId, env),
      `${JSON.stringify({at: new Date().toISOString(), from: read.path})}\n`,
    );
  } catch (error) {
    stampError = probeErrorMessage(error);
  }
  return {
    carried: synced.carried,
    kind: 'seeded',
    messages: synced.messages,
    rewrote: synced.kind === 'written',
    stampError,
  };
}

/** What one pass did to the bead. */
export type ApplyPassOutcome =
  | {kind: 'noLog'}
  | {error: string; kind: 'logUnreadable'}
  | {failure: BdFailure; kind: 'bdFailed'; stage: string}
  | {
      adopted: boolean;
      created: boolean;
      kind: 'applied';
      /** Set when a status write failed; the metadata write still happened. */
      statusFailure: BdFailure | null;
      threadId: string;
      wrote: boolean;
    };

export interface ApplyOptions {
  /** Overrides componentConfig.thread.autoCommit. Tests pin it. */
  autoCommit?: boolean;
  cwd?: string | null;
  env?: EnvLike;
  /** The spawning hook's synchronous ms (`--hook-ms`), recorded as-is. */
  hookElapsedMs?: number | null;
  now?: Date;
  sessionId: string;
  transcriptPath?: string | null;
}

/**
 * ONE pass: read the whole log, find or create the thread, merge the tail.
 *
 * FIND OR CREATE, never duplicate: `findThreadBySession` returns a MEASURED
 * absence or a failure, and only the former creates — through `thread
 * start`'s own create path, so the bead is exactly the one `thread start`
 * would have made (placeholder title, "NO REPORT YET" body, start metadata).
 *
 * OWNERSHIP (K5, K10 c): the title, description, notes and status of an
 * existing bead are never touched — the report path owns them — with ONE
 * exception: a bead `thread backfill` made (`source: 'backfill'`, status
 * `open`) is moved to `in_progress`, because its session is demonstrably live.
 * Its BODY stays as the backfill wrote it. A CLOSED thread keeps its status:
 * capture refreshes its messages and nothing else.
 */
export async function applyCaptureOnce(
  options: ApplyOptions,
  ctx: BdContext = bdContext(options.env ?? process.env),
  transcript: () => TranscriptRead = memoizedTranscript(options),
): Promise<ApplyPassOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const log = readMessageLog(options.sessionId, env);
  if (log.kind === 'missing') return {kind: 'noLog'};
  if (log.kind === 'failed') return {error: log.error, kind: 'logUnreadable'};
  const summary = summarizeLog(log.lines);

  const found = await findThreadBySession(ctx, options.sessionId);
  if (!found.ok)
    return {failure: found.failure, kind: 'bdFailed', stage: 'lookup'};

  let thread: BdIssue | null = found.value;
  let meta: Record<string, unknown> = thread?.metadata ?? {};
  let created = false;
  let adopted = false;
  let statusFailure: BdFailure | null = null;

  if (thread == null) {
    const {collectThreadFacts} = await import('./facts');
    const {createStartThread, startThreadFields} = await import('./start');
    const facts = collectThreadFacts({
      cwd: options.cwd ?? undefined,
      env,
      now,
      sessionId: options.sessionId,
      transcriptPath: options.transcriptPath ?? null,
    });
    const fields = startThreadFields({
      facts,
      sessionId: options.sessionId,
      startedAt: now.toISOString(),
    });
    const made = await createStartThread(ctx, fields);
    if (!made.ok)
      return {failure: made.failure, kind: 'bdFailed', stage: 'create'};
    created = true;
    statusFailure = made.statusFailure;
    thread = {
      id: made.threadId,
      metadata: fields.metadata,
      status: 'in_progress',
    };
    meta = fields.metadata;
  } else if (thread.status === 'open' && meta.source === 'backfill') {
    const moved = await setThreadInProgress(ctx, thread.id);
    if (moved.ok) adopted = true;
    else statusFailure = moved.failure;
  }

  // k0b8n.15: a start- or capture-created bead has no resume command (start
  // ran before the transcript existed). The transcript is read only then.
  const resume =
    metaText(meta, 'resumeCommand') == null
      ? resumeFillFrom(transcript())
      : null;
  const patch = capturePatch(summary, meta, resume);
  if (!patchChanges(patch, meta)) {
    return {
      adopted,
      created,
      kind: 'applied',
      statusFailure,
      threadId: thread.id,
      wrote: created || adopted,
    };
  }
  const merged = await mergeMetadata(ctx, thread.id, patch);
  if (!merged.ok)
    return {failure: merged.failure, kind: 'bdFailed', stage: 'metadata'};
  return {
    adopted,
    created,
    kind: 'applied',
    statusFailure,
    threadId: thread.id,
    wrote: true,
  };
}

// ---- the per-session lock ---------------------------------------------------

/**
 * Take the session's lock, or return false AT ONCE — never wait (K10 c).
 *
 * The O_EXCL + pid pattern of `acquireCommitLock`: a holder that died leaves its
 * pid behind, and a MEASURABLY dead owner's lock is stolen. "Could not tell"
 * leaves it alone; the dirty stamp still records that there is work.
 */
export function tryCaptureLock(sessionId: string, env: EnvLike): boolean {
  const path = captureLockPath(sessionId, env);
  try {
    mkdirSync(captureLocksDir(env), {recursive: true});
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      let owner: number | null = null;
      try {
        const raw = readFileSync(path, 'utf8').trim();
        owner = /^[0-9]+$/.test(raw) ? Number(raw) : null;
      } catch {
        owner = null;
      }
      if (owner == null || owner === process.pid || pidAlive(owner) !== false) {
        return false;
      }
      try {
        rmSync(path, {force: true});
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseCaptureLock(sessionId: string, env: EnvLike): void {
  try {
    rmSync(captureLockPath(sessionId, env), {force: true});
  } catch {
    // A stranded lock is stolen by the next child's dead-pid test.
  }
}

function dirtyExists(sessionId: string, env: EnvLike): boolean {
  try {
    return statSync(captureDirtyPath(sessionId, env)).isFile();
  } catch {
    return false;
  }
}

function clearDirty(sessionId: string, env: EnvLike): void {
  try {
    rmSync(captureDirtyPath(sessionId, env), {force: true});
  } catch {
    // Left in place, it only costs one extra (idempotent) pass.
  }
}

function markDirty(sessionId: string, env: EnvLike): void {
  try {
    mkdirSync(captureLocksDir(env), {recursive: true});
    writeFileSync(captureDirtyPath(sessionId, env), `${Date.now()}\n`);
  } catch {
    // Cannot even mark: the holder may miss this message until the next turn,
    // whose child applies the log's tail, which includes it.
  }
}

export type CaptureApplyOutcome =
  | {kind: 'deferred'}
  | {
      commit: CommitOutcome | null;
      kind: 'ran';
      last: ApplyPassOutcome;
      passes: number;
      /** What the one-time seed did before the first pass (k0b8n.16). */
      seed: SeedOutcome;
    };

/**
 * The child's whole job: take the lock, apply until no newer message is
 * waiting, release, commit once (K10 c, d).
 *
 * THE CONVERGENCE ARGUMENT. Every pass applies the log's TAIL, never the
 * payload that spawned it, so a late pass is always at least as new as an early
 * one. A child that finds the lock held marks the session dirty and tries the
 * lock ONCE more — closing the window where the holder released between the
 * first try and the mark — then leaves. The holder clears the mark before each
 * pass and loops while one reappears; after releasing it checks once more and
 * re-takes the lock if a mark landed in between. So the newest message is
 * always applied by SOMEONE, and at most one bd writer per session exists.
 */
export async function applyCapture(
  options: ApplyOptions,
): Promise<CaptureApplyOutcome> {
  const env = options.env ?? process.env;
  const {sessionId} = options;
  if (!tryCaptureLock(sessionId, env)) {
    markDirty(sessionId, env);
    if (!tryCaptureLock(sessionId, env)) return {kind: 'deferred'};
  }
  // ONE context for every pass, so an export-only failure any pass hit
  // (`exportUnstaged`) reaches the commit below instead of being forgotten.
  const ctx = bdContext(env);
  // ONE transcript read per child, shared by the seed and the resume fill.
  const transcript = memoizedTranscript(options);
  let holding = true;
  let passes = 0;
  let last: ApplyPassOutcome = {kind: 'noLog'};
  let wrote = false;
  let threadId: string | null = null;
  let seed: SeedOutcome = {kind: 'alreadySeeded'};
  try {
    // Under the lock, before the first pass: the pass then applies the seeded
    // log's tail. A thrown seed is a failed one, never a lost capture.
    try {
      seed = seedMessageLogOnce(options, transcript);
    } catch (error) {
      seed = {error: probeErrorMessage(error), kind: 'failed'};
    }
    for (;;) {
      do {
        clearDirty(sessionId, env);
        last = await applyCaptureOnce(options, ctx, transcript);
        passes += 1;
        if (last.kind === 'applied') {
          wrote ||= last.wrote;
          threadId = last.threadId;
        }
      } while (
        last.kind === 'applied' &&
        dirtyExists(sessionId, env) &&
        passes < MAX_APPLY_PASSES
      );
      releaseCaptureLock(sessionId, env);
      holding = false;
      if (
        last.kind !== 'applied' ||
        passes >= MAX_APPLY_PASSES ||
        !dirtyExists(sessionId, env)
      ) {
        break;
      }
      if (!tryCaptureLock(sessionId, env)) break;
      holding = true;
    }
  } finally {
    if (holding) releaseCaptureLock(sessionId, env);
  }

  // ONE commit per child, PUSH FORCED OFF (K10 d): a push per turn per session
  // is network noise, and the next report / backfill / answer pushes the whole
  // branch anyway.
  let commit: CommitOutcome | null = null;
  if (wrote && threadId != null) {
    commit = commitThreadsRepo(`thread ${threadId}: capture`, {
      autoCommit: options.autoCommit,
      autoPush: false,
      dir: ctx.repoDir,
      env,
      exportUnstaged: ctx.exportUnstaged,
    });
  }
  return {commit, kind: 'ran', last, passes, seed};
}

/** The one JSON line a child run appends to `<stateDir>/capture.jsonl`. */
export function captureRunRecord(
  sessionId: string,
  outcome: CaptureApplyOutcome | {error: string; kind: 'threw'},
  elapsedMs: number,
  now: Date,
  hookElapsedMs: number | null = null,
): Record<string, unknown> {
  // hookElapsedMs is null when the child was started by hand (no --hook-ms):
  // "not measured", never 0.
  const base = {at: now.toISOString(), elapsedMs, hookElapsedMs, sessionId};
  if (outcome.kind === 'threw') {
    return {...base, error: outcome.error, outcome: 'threw'};
  }
  if (outcome.kind === 'deferred') {
    return {...base, outcome: 'deferred'};
  }
  const {last} = outcome;
  const record: Record<string, unknown> = {
    ...base,
    commit: outcome.commit?.kind ?? null,
    outcome: last.kind,
    passes: outcome.passes,
    // k0b8n.16: the seed is once per session, so this is where "was it
    // seeded, and from what" is answered after the fact.
    seed: outcome.seed,
  };
  if (last.kind === 'applied') {
    record.threadId = last.threadId;
    record.created = last.created;
    record.adopted = last.adopted;
    record.wrote = last.wrote;
    if (last.statusFailure != null) {
      record.statusFailure = describeBdFailure(last.statusFailure);
    }
  } else if (last.kind === 'bdFailed') {
    record.stage = last.stage;
    record.error = describeBdFailure(last.failure);
  } else if (last.kind === 'logUnreadable') {
    record.error = last.error;
  }
  return record;
}

/**
 * `thread capture --apply <sessionId>`: the detached child's entry point.
 *
 * ALWAYS RESOLVES 0 and never throws. Its stdio is ignored, so the run record
 * in capture.jsonl is where a failure is loud (K10 c). A bd failure is not
 * spooled anywhere else: the message log already holds every message, written
 * BEFORE any bd call (the D5 property), and the next turn's child — or the
 * backfill, whose transcript is newer than the bead's lastActivityAt — applies
 * it again from the log.
 */
export async function runThreadCaptureApply(
  options: ApplyOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const started = performance.now();
  let outcome: CaptureApplyOutcome | {error: string; kind: 'threw'};
  try {
    outcome = await applyCapture(options);
  } catch (error) {
    outcome = {error: probeErrorMessage(error), kind: 'threw'};
  }
  const elapsedMs = Math.round(performance.now() - started);
  try {
    mkdirSync(captureLocksDir(env), {recursive: true});
    appendFileSync(
      captureRunLogPath(env),
      `${JSON.stringify(captureRunRecord(options.sessionId, outcome, elapsedMs, new Date(), options.hookElapsedMs ?? null))}\n`,
    );
  } catch {
    // Nowhere left to say it: stdio is ignored. The message log still holds
    // the message, and the next run applies it.
  }
  return 0;
}
