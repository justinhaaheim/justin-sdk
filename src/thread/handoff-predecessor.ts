/**
 * What happens to the OLD tab after `thread handoff` started its successor
 * (epic home-base-mbnjv D6 and C6; built by home-base-mbnjv.4). The knob is
 * componentConfig.thread.handoff.predecessor:
 *
 *   keep  (default) nothing happens; no watcher is started.
 *   exit  Claude Code in the old tab is ended and the tab shows a tombstone:
 *         who it was handed off to and when, the command that focuses the
 *         successor's tab, `claude --resume <old session id>`, then a shell.
 *   close the old tab is closed.
 *
 * NEVER ON A TIMER (C6). exit and close act only from a DETACHED watcher
 * (predecessor-watch.ts, started by thread handoff the way capture.ts and
 * session-stop.ts start their children) and only when every one of these
 * holds, read twice, the second time immediately before acting:
 *   (a) THE successor this handoff started has linked itself (fix round F10):
 *       the caller's bead carries continued-by:B, B carries
 *       continues:<caller bead> (linkContinuation writes both when the
 *       successor runs `thread request --continues`), and B's cmux-surface:
 *       label is the uuid of the tab this handoff opened. A continued-by: from
 *       an earlier handoff, a --to link or a pasted block never satisfies it;
 *   (b) the caller's turn ENDED after the handoff and nothing was typed or
 *       run since (home-base-mbnjv.11, F21): its transcript's newest
 *       turn_duration record is dated after the handoff and at least settleMs
 *       old, and no message record, no compaction and no record of an unknown
 *       type follows it; no slash command was run after the handoff's turn
 *       ended; the message log holds an assistant line since the handoff (its
 *       final message is recorded, in any writer's spelling: a capture
 *       rewrite turns the live Stop line into a backfill line) and no user
 *       line since the handoff (Justin has not typed into the old session);
 *   the surface captured from the caller's CMUX_SURFACE_ID at handoff time is
 *   still in the same workspace (read-only tree);
 *   and that tab's screen shows Claude Code idle at an empty input box with
 *   THIS session's id in Justin's status line ("⌗ <id>"), no dialog drawn from
 *   the box down, nothing working (a check this bead adds: a Stop hook that
 *   blocks makes Claude continue after a Stop, and the screen is the only
 *   place that shows it; an empty box means nothing Justin typed is lost).
 *
 * WHY THE TRANSCRIPT FOR (b) (home-base-mbnjv.11, measured 2026-10-29). The
 * message log's `event` is not durable: the capture child's one-time seed
 * and the hourly `thread backfill` chore rewrite the log from the transcript
 * and turn every live Stop line the transcript also has into a `backfill`
 * line (live run 20261029T162445Z: S2's log held four lines, all backfill).
 * A backfill assistant line is not proof of an ended turn either:
 * extractTranscriptTurns emits the transcript's live tail at end of file. The
 * transcript's turn_duration is: on Claude Code 2.1.312 every ended turn
 * writes one, and a Stop that a hook blocked writes stop_hook_summary only
 * (transcript-messages.ts isStopMarker, 4,004 Stops measured 2026-09-25).
 * Records Claude Code writes while idle (away_summary, ai-title, last-prompt,
 * mode and the rest of IDLE_RECORD_TYPES) are ignored; everything else counts
 * as activity, so an unknown record waits. A bare slash command typed into
 * the old tab (/model, /clear, /copy) is never a message-log line (capture
 * skips it) but IS a user record in the transcript (measured, F21).
 * RESIDUAL (F21): a command that writes nothing to the transcript and leaves
 * no dialog on screen is invisible to the watcher.
 * A user line after the handoff or a vanished surface ends the watch at once,
 * without acting. Otherwise it gives up after timeoutMs (20 minutes), again
 * without acting. Every outcome is written on the caller's bead
 * ("predecessor exited: …", "predecessor closed: …", "predecessor kept: …")
 * and as a line of <threads state dir>/handoff-predecessor.jsonl.
 *
 * ONLY THE CALLER'S OWN TAB. The one surface any call here changes is the
 * uuid captured from CMUX_SURFACE_ID when thread handoff ran, always with
 * --workspace and --surface (cmux defaults a missing --surface to the
 * FOCUSED tab for respawn-pane). Never a lookup by name, title or marker.
 *
 * MEASURED 2026-10-29 (home-base-mbnjv.4 notes, cmux 0.64.24, Claude Code
 * 2.1.312, throwaway tabs):
 * - `respawn-pane --command` runs the text under
 *   `/usr/bin/login … /bin/bash … -c exec -l /bin/sh -lc '<text>'` (POSIX
 *   sh, not a typed zsh). It ended the old login/zsh/claude processes at
 *   once; Claude Code ran its exit path (it appended its cost-state records)
 *   and every message record stayed byte-identical; `claude --resume` showed
 *   the whole conversation. A command that ends leaves Ghostty's "Press any
 *   key to close the window", so the tombstone ends by exec'ing a login shell.
 * - `close-surface` closed a tab running an idle Claude Code with no
 *   confirmation. Its reply named a different ref than the tab's, so success
 *   is verified by uuid in the tree, never read from the reply.
 * - `focus-panel --panel <uuid> --workspace <uuid>` selects that tab and
 *   brings its workspace forward: the tombstone's focus command.
 * - cmux applies acts asynchronously: the tree shows them on a later read,
 *   so the verification polls.
 */

import type {CmuxCall, CmuxRunner, PaneOfSurfaceRead} from './cmux';
import type {HandoffPredecessorMode} from './defaults';
import type {MessageLogRead} from './message-log';
import type {EnvLike} from './paths';

import {spawn} from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {brShow, brUpdate, describeBrFailed} from '../beads/br';
import {silencedChildEnv} from '../health-notices';
import {oneLine} from './ask-format';
import {readPaneOfSurface, realCmuxRunner} from './cmux';
import {findTranscript} from './facts';
import {continuedByOf, continuesOf} from './handoff-view';
import {readMessageLog} from './message-log';
import {
  dialogOnScreen,
  findInputBox,
  screenLines,
  statusLineIdOf,
  workingIndicator,
} from './pane-join';
import {absoluteWhen} from './part-one';
import {threadsStateDir} from './paths';
import {liveSocketPath, zshWord} from './respawn';
import {CMUX_SURFACE_LABEL_PREFIX} from './session-bead';
import {appendNote} from './session-marks';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the watcher reads the handshake ("every few seconds", C6). */
export const PREDECESSOR_POLL_MS = 5_000;

/** When the watcher gives up without acting (C6: 20 minutes). */
export const PREDECESSOR_TIMEOUT_MS = 20 * 60_000;

/** How old the Stop line must be, so the yield's other Stop hooks can finish. */
export const PREDECESSOR_SETTLE_MS = 5_000;

/** How long an act is verified (cmux applies it asynchronously). */
export const PREDECESSOR_VERIFY_MS = 10_000;

/** How often the verification reads. */
export const PREDECESSOR_VERIFY_POLL_MS = 500;

/** The tombstone's first line; the exit verification looks for it. */
export const TOMBSTONE_HEADLINE = '🤝 This Claude Code session was handed off.';

/** The outcome log under the threads state dir (one JSON object per line). */
export const PREDECESSOR_LOG_FILE = 'handoff-predecessor.jsonl';

/** Where thread handoff writes each watcher's plan. */
export const PREDECESSOR_WATCH_DIR = 'handoff-watch';

/** The detached child's entry file: this package's own build, never a PATH lookup. */
export const PREDECESSOR_WATCH_PATH = fileURLToPath(
  new URL('./predecessor-watch.ts', import.meta.url),
);

/** The cmux verbs that change a tab; every one of them must name the caller's surface. */
export const TAB_CHANGING_VERBS = ['close-surface', 'respawn-pane'] as const;

/**
 * How much of the transcript's end the watcher reads each poll. (b) needs
 * only the records since the handoff's turn; a tail with no ended turn since
 * the handoff waits, the cautious side.
 */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Records Claude Code writes while a session sits idle, which therefore say
 * nothing about activity (home-base-mbnjv.11 / F21). MEASURED 2026-10-29,
 * read-only, over 59 transcripts modified in the last 4 days (828 ended
 * turns): every record type found between a turn's last Stop mark and the
 * next user or assistant record. Anything not listed counts as activity, so a
 * record type a newer Claude Code adds makes the watcher wait (and name it).
 * Left out on purpose: attachment (4 of 828 gaps; task notifications arrive
 * as attachments) and system/compact_boundary (a /compact).
 */
export const IDLE_RECORD_TYPES: ReadonlySet<string> = new Set([
  'agent-name',
  'ai-title',
  'artifact-autoreact-ledger',
  'atis-latch',
  'bridge-session',
  'cost-state',
  'custom-title',
  'file-history-snapshot',
  'frame-link',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'relocated',
  'system/away_summary',
  'system/stop_hook_summary',
  'tools-used',
  'worktree-state',
]);

// ---------------------------------------------------------------------------
// The plan the watcher runs
// ---------------------------------------------------------------------------

export type PredecessorActMode = Exclude<HandoffPredecessorMode, 'keep'>;

/** What thread handoff hands the watcher, as JSON in a file. */
export interface PredecessorWatch {
  caller: {
    beadId: string;
    /** The beads DB holding the caller's session bead. */
    db: string;
    sessionId: string;
    /** CMUX_SURFACE_ID when thread handoff ran: the ONLY tab acted on. */
    surfaceId: string;
    /** CMUX_WORKSPACE_ID when thread handoff ran. */
    workspaceId: string;
  };
  /** When thread handoff ran (ISO); (b) counts only what came after it. */
  handedOffAt: string;
  logPath: string;
  mode: PredecessorActMode;
  pollMs: number;
  settleMs: number;
  /**
   * The tab this handoff opened. `surfaceId` is its uuid, read from the tree
   * right after new-surface; (a) requires the successor's bead to carry
   * cmux-surface:<this uuid> (F10). thread handoff starts no watcher when
   * the uuid cannot be read.
   */
  successor: {name: string; surfaceId: string; surfaceRef: string};
  timeoutMs: number;
  /** exit: the lines the tab shows (built at handoff time, in local time). */
  tombstone: string[];
}

/** `cmux focus-panel --panel <surface> --workspace <workspace>` (measured). */
export function focusCommandOf(surface: string, workspaceId: string): string {
  return ['cmux', 'focus-panel', '--panel', surface, '--workspace', workspaceId]
    .map(zshWord)
    .join(' ');
}

/** The tombstone (D6): who, when, how to get there, how to come back. */
export function tombstoneLines(input: {
  focusCommand: string;
  handedOffAt: Date;
  sessionId: string;
  successorName: string;
  timeZone?: string;
}): string[] {
  return [
    '',
    TOMBSTONE_HEADLINE,
    '',
    `   Handed off to:   ${input.successorName}`,
    `   At:              ${absoluteWhen(input.handedOffAt, input.timeZone)}`,
    '',
    '   Go to the new tab:',
    `      ${input.focusCommand}`,
    '',
    '   Read or resume this session:',
    `      claude --resume ${input.sessionId}`,
    '',
  ];
}

/**
 * The text respawn-pane runs under `/bin/sh -lc` (measured): print the
 * tombstone, then become a login shell, so the tab never shows Ghostty's
 * "Press any key to close the window". Every line is single-quoted
 * (zshWord's quoting is POSIX sh's too).
 */
export function tombstoneCommand(lines: readonly string[]): string {
  return `printf '%s\\n' ${lines.map(zshWord).join(' ')}; exec "\${SHELL:-/bin/zsh}" -l`;
}

/** The one tab-changing call of each mode: always --workspace and --surface. */
export function predecessorActArgs(watch: PredecessorWatch): string[] {
  const {surfaceId, workspaceId} = watch.caller;
  if (watch.mode === 'close') {
    return [
      'close-surface',
      '--workspace',
      workspaceId,
      '--surface',
      surfaceId,
    ];
  }
  return [
    'respawn-pane',
    '--workspace',
    workspaceId,
    '--surface',
    surfaceId,
    '--command',
    tombstoneCommand(watch.tombstone),
  ];
}

// ---------------------------------------------------------------------------
// The handshake, one half at a time (pure)
// ---------------------------------------------------------------------------

/** One condition: met (with what was seen) or not (why; `final` ends the watch). */
export type Condition =
  | {final: boolean; ok: false; why: string}
  | {ok: true; saw: string};

export type LabelsRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'ok'; labels: string[]};

/**
 * (a): THE successor this handoff started has linked itself (fix round F10).
 * Met only by a bead B with all three: the caller carries continued-by:B, B
 * carries continues:<caller bead>, and B's cmux-surface: label is the uuid of
 * the tab this handoff opened. Never final: the right successor can still
 * link after a wrong candidate was seen.
 */
export function checkLink(input: {
  callerBeadId: string;
  callerLabels: LabelsRead;
  labelsOf: (beadId: string) => LabelsRead;
  successorSurfaceId: string;
}): Condition {
  const {callerBeadId, successorSurfaceId} = input;
  if (input.callerLabels.kind === 'failed') {
    return {
      final: false,
      ok: false,
      why: `${callerBeadId} could not be read: ${input.callerLabels.reason}`,
    };
  }
  const candidates = continuedByOf(input.callerLabels.labels);
  if (candidates.length === 0) {
    return {
      final: false,
      ok: false,
      why: `${callerBeadId} has no continued-by: label (the successor has not run thread request --continues)`,
    };
  }
  const wanted = successorSurfaceId.toLowerCase();
  const misses: string[] = [];
  for (const candidate of candidates) {
    const read = input.labelsOf(candidate);
    if (read.kind === 'failed') {
      misses.push(`${candidate} could not be read: ${read.reason}`);
      continue;
    }
    const linksBack = continuesOf(read.labels).includes(callerBeadId);
    const surfaces = read.labels
      .filter((label) => label.startsWith(CMUX_SURFACE_LABEL_PREFIX))
      .map((label) => label.slice(CMUX_SURFACE_LABEL_PREFIX.length));
    const inNewTab = surfaces.some((id) => id.toLowerCase() === wanted);
    if (linksBack && inNewTab) {
      return {
        ok: true,
        saw: `continued-by:${candidate}, which continues:${callerBeadId} from the new tab ${successorSurfaceId}`,
      };
    }
    const wrong: string[] = [];
    if (!linksBack) wrong.push(`it has no continues:${callerBeadId}`);
    if (!inNewTab) {
      wrong.push(
        surfaces.length === 0
          ? 'it has no cmux-surface: label'
          : `its cmux-surface: is ${surfaces.join(', ')}, not the new tab ${successorSurfaceId}`,
      );
    }
    misses.push(
      `continued-by:${candidate} is not this handoff's successor: ${wrong.join(' and ')}`,
    );
  }
  return {final: false, ok: false, why: misses.join('; ')};
}

function timeOf(at: string | null): number | null {
  if (at == null) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * One transcript record as (b) sees it: the end of a turn, or activity
 * (`typed`: a slash command or local command someone ran in the tab).
 * Idle records and subagent (sidechain) records are not marks at all.
 */
export interface TranscriptMark {
  at: string | null;
  kind: 'activity' | 'turnEnd';
  typed: boolean;
  what: string;
}

export type TranscriptTailRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'; reason: string}
  | {kind: 'read'; marks: TranscriptMark[]; path: string};

function recordText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (block == null || typeof block !== 'object') return '';
      const text = (block as {text?: unknown}).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/u;

/**
 * Classify one parsed transcript record for (b). MEASURED shapes
 * (home-base-mbnjv.11): an ended turn is `system`/`turn_duration`; a bare
 * `/model` is three user records, `<local-command-caveat>` (isMeta), the
 * `<command-name>/model</command-name>` envelope and `<local-command-stdout>`.
 */
export function transcriptMarkOf(record: unknown): TranscriptMark | null {
  if (record == null || typeof record !== 'object') return null;
  const r = record as {
    isSidechain?: unknown;
    message?: {content?: unknown};
    subtype?: unknown;
    timestamp?: unknown;
    type?: unknown;
  };
  if (r.isSidechain === true) return null;
  const type = typeof r.type === 'string' ? r.type : '(no type)';
  const name =
    typeof r.subtype === 'string' && r.subtype !== ''
      ? `${type}/${r.subtype}`
      : type;
  const at = typeof r.timestamp === 'string' ? r.timestamp : null;
  if (name === 'system/turn_duration') {
    return {at, kind: 'turnEnd', typed: false, what: 'turn_duration'};
  }
  if (IDLE_RECORD_TYPES.has(name)) return null;
  if (type === 'user') {
    const text = recordText(r.message?.content);
    const command = COMMAND_NAME.exec(text)?.[1];
    if (command != null) {
      return {
        at,
        kind: 'activity',
        typed: true,
        what: `the command ${command}`,
      };
    }
    if (
      text.includes('<local-command-caveat>') ||
      text.includes('<local-command-stdout>')
    ) {
      return {at, kind: 'activity', typed: true, what: 'a local command'};
    }
    return {at, kind: 'activity', typed: false, what: 'a user record'};
  }
  if (type === 'assistant') {
    return {at, kind: 'activity', typed: false, what: 'an assistant record'};
  }
  return {
    at,
    kind: 'activity',
    typed: false,
    what: `a ${name} record (not a known idle record)`,
  };
}

/**
 * The marks in the transcript's last `maxBytes` bytes, in file order. A
 * partial first line (the tail started mid-record) and a partial last line
 * (Claude Code is writing it) are skipped; an unparseable complete line is a
 * mark of activity, never silently dropped (rule 7: unknown waits).
 */
export function readTranscriptTail(
  path: string,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): TranscriptTailRead {
  let text: string;
  let truncated: boolean;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const got = readSync(
          fd,
          buffer,
          read,
          length - read,
          size - length + read,
        );
        if (got === 0) break;
        read += got;
      }
      text = buffer.subarray(0, read).toString('utf8');
      truncated = size > length;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as {code?: unknown}).code;
    return code === 'ENOENT'
      ? {kind: 'missing', reason: `${path} does not exist`}
      : {kind: 'failed', reason: `${path} could not be read: ${String(error)}`};
  }
  const pieces = text.split('\n');
  if (truncated) pieces.shift();
  // The last piece is '' after a final newline, or a line still being written.
  pieces.pop();
  const marks: TranscriptMark[] = [];
  for (const piece of pieces) {
    if (piece.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(piece);
    } catch {
      marks.push({
        at: null,
        kind: 'activity',
        typed: false,
        what: 'a line that is not valid JSON',
      });
      continue;
    }
    const mark = transcriptMarkOf(record);
    if (mark != null) marks.push(mark);
  }
  return {kind: 'read', marks, path};
}

/**
 * (b): the caller's turn ENDED after the handoff, its final message is
 * recorded, and nothing was typed or run since (home-base-mbnjv.11, F21; the
 * file header says why the transcript). Message-log lines are in append
 * order, so everything from the first line dated at or after the handoff is
 * "since the handoff". A user line there, or a slash command in the
 * transcript after the handoff's turn ended, is final: Justin is using the
 * old session, and a later Stop must never make it look finished.
 */
export function checkStop(input: {
  handedOffAt: Date;
  log: MessageLogRead;
  nowMs: number;
  settleMs: number;
  transcript: TranscriptTailRead;
}): Condition {
  const {log} = input;
  if (log.kind === 'missing') {
    return {
      final: false,
      ok: false,
      why: `there is no message log at ${log.path}`,
    };
  }
  if (log.kind === 'failed') {
    return {
      final: false,
      ok: false,
      why: `the message log ${log.path} could not be read: ${log.error}`,
    };
  }
  const handed = input.handedOffAt.getTime();
  const first = log.lines.findIndex((line) => {
    const at = timeOf(line.at);
    return at != null && at >= handed;
  });
  const handedText = input.handedOffAt.toISOString();
  if (first < 0) {
    return {
      final: false,
      ok: false,
      why: `no line in the message log since the handoff at ${handedText} (the session has not yielded)`,
    };
  }
  const since = log.lines.slice(first);
  const typed = since.find((line) => line.role === 'user');
  if (typed != null) {
    return {
      final: true,
      ok: false,
      why: `Justin typed into this session after the handoff (a user line at ${typed.at ?? 'an unknown time'})`,
    };
  }
  // Any writer's spelling: a live Stop line, or the backfill line a capture
  // rewrite turned it into (mbnjv.11). Since there is no user line here,
  // every line since the handoff is an assistant line.
  const recorded = since[since.length - 1];
  if (recorded == null) {
    return {
      final: false,
      ok: false,
      why: 'the message log has no line since the handoff',
    };
  }
  const {transcript} = input;
  if (transcript.kind !== 'read') {
    return {
      final: false,
      ok: false,
      why: `the transcript ${transcript.kind === 'missing' ? 'was not found' : 'could not be read'}: ${transcript.reason}`,
    };
  }
  const marks = transcript.marks;
  const firstEnd = marks.findIndex((mark) => {
    const at = timeOf(mark.at);
    return mark.kind === 'turnEnd' && at != null && at >= handed;
  });
  if (firstEnd < 0) {
    return {
      final: false,
      ok: false,
      why: `the transcript shows no ended turn (turn_duration) since the handoff at ${handedText}`,
    };
  }
  const ran = marks.slice(firstEnd + 1).find((mark) => mark.typed);
  if (ran != null) {
    return {
      final: true,
      ok: false,
      why: `someone ran ${ran.what} in this session after the handoff's turn ended (at ${ran.at ?? 'an unknown time'})`,
    };
  }
  const lastEnd = marks.findLastIndex((mark) => mark.kind === 'turnEnd');
  const after = marks.slice(lastEnd + 1)[0];
  if (after != null) {
    return {
      final: false,
      ok: false,
      why: `the session is active again: the transcript has ${after.what} after its last ended turn`,
    };
  }
  const end = marks[lastEnd];
  const endAt = timeOf(end?.at ?? null);
  if (endAt == null) {
    return {
      final: false,
      ok: false,
      why: 'the last ended turn in the transcript has no time',
    };
  }
  const age = input.nowMs - endAt;
  if (age < input.settleMs) {
    return {
      final: false,
      ok: false,
      why: `the turn ended at ${end?.at ?? '?'}, ${Math.max(0, Math.round(age / 1000))} s ago; waiting until it is ${Math.round(input.settleMs / 1000)} s old`,
    };
  }
  return {
    ok: true,
    saw: `the turn ended at ${end?.at ?? '?'} (transcript turn_duration), the final message is in the message log (a ${recorded.event} line at ${recorded.at ?? '?'}), nothing typed or run since the handoff`,
  };
}

// ---------------------------------------------------------------------------
// Background work (home-base-mbnjv.13)
// ---------------------------------------------------------------------------

/**
 * exit and close end everything still running in the old tab: a subagent
 * mid-commit, a run_in_background shell. A task that is still running writes
 * NOTHING to the caller's transcript, so (b) alone cannot see it. The
 * watcher therefore keeps a ledger of the session's background tasks from
 * its WHOLE transcript (not the 8 MiB tail: a launch can be hours old), and
 * waits while any launch has no terminal notification.
 *
 * MEASURED 2026-10-29 (Claude Code 2.1.312, read-only over this machine's
 * transcripts; home-base-mbnjv.13 notes):
 * - A background shell's launch is the user record carrying its tool result,
 *   with toolUseResult.backgroundTaskId (e.g. "bbw8zweuw").
 * - A background subagent's launch: toolUseResult {isAsync: true, status:
 *   "async_launched", agentId}. input.run_in_background is NOT reliable: the
 *   Agent calls in conductor session 62dd8629 had none and ran async.
 * - The end of either is a `<task-notification>` naming `<task-id>` and a
 *   `<status>`: a user record (origin.kind task-notification) when the
 *   session was idle, or an attachment {type: queued_command, prompt} when it
 *   was busy. Statuses seen: completed 13,446, failed 538, killed 130,
 *   stopped 18 (`running` appears only in TaskOutput results).
 * - A finished subagent can be resumed with SendMessage (input.to = its id),
 *   and then notifies again: a SendMessage to a known id reopens it.
 * Anything unreadable that looks like a launch counts as running (rule 7).
 */
export interface BackgroundTask {
  /** null while running; the terminal notification once it arrived. */
  ended: {at: string | null; status: string} | null;
  id: string;
  kind: 'agent' | 'shell';
  launchedAt: string | null;
}

export type BackgroundRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'; reason: string}
  | {
      kind: 'read';
      path: string;
      tasks: BackgroundTask[];
      /** Launch-shaped records whose task id could not be read: running. */
      unreadable: string[];
    };

/** A notification status that ends a task; any other leaves it running. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
]);

/** Words a line must hold to be parsed for the ledger (a cheap prefilter). */
const LEDGER_WORDS = [
  'backgroundTaskId',
  'async_launched',
  '"isAsync"',
  '<task-notification>',
  '"SendMessage"',
];

/** The ledger as it is folded, record by record, in file order. */
export interface BackgroundLedger {
  tasks: Map<string, BackgroundTask>;
  unreadable: string[];
}

export function emptyLedger(): BackgroundLedger {
  return {tasks: new Map(), unreadable: []};
}

/** The text a notification record carries: a user record's content, or a queued attachment's prompt. */
function notificationText(r: Record<string, unknown>): string | null {
  if (r.type === 'user') {
    const content = (r.message as {content?: unknown} | undefined)?.content;
    // A tool result is never a notification, even when it quotes one.
    if (
      Array.isArray(content) &&
      content.some(
        (block: unknown) =>
          (block as {type?: unknown} | null)?.type === 'tool_result',
      )
    ) {
      return null;
    }
    return recordText(content);
  }
  if (r.type === 'attachment') {
    const prompt = (r.attachment as {prompt?: unknown} | undefined)?.prompt;
    return typeof prompt === 'string' ? prompt : null;
  }
  return null;
}

/** Fold one transcript line into the ledger (mutates it). */
export function foldLedgerLine(ledger: BackgroundLedger, line: string): void {
  if (!LEDGER_WORDS.some((word) => line.includes(word))) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    ledger.unreadable.push(
      `a launch-shaped line that is not valid JSON (${line.slice(0, 80)}…)`,
    );
    return;
  }
  if (parsed == null || typeof parsed !== 'object') return;
  const r = parsed as Record<string, unknown>;
  if (r.isSidechain === true) return;
  const at = typeof r.timestamp === 'string' ? r.timestamp : null;
  const launch = (id: string, kind: BackgroundTask['kind']): void => {
    ledger.tasks.set(id, {ended: null, id, kind, launchedAt: at});
  };
  const result = r.toolUseResult;
  if (result != null && typeof result === 'object') {
    const t = result as Record<string, unknown>;
    if (typeof t.backgroundTaskId === 'string' && t.backgroundTaskId !== '') {
      launch(t.backgroundTaskId, 'shell');
    }
    if (t.isAsync === true || t.status === 'async_launched') {
      if (typeof t.agentId === 'string' && t.agentId !== '') {
        launch(t.agentId, 'agent');
      } else {
        ledger.unreadable.push(
          `an async launch at ${at ?? 'an unknown time'} whose agent id could not be read`,
        );
      }
    }
  }
  const text = notificationText(r);
  if (text?.trimStart().startsWith('<task-notification>') === true) {
    const id = /<task-id>([^<]+)<\/task-id>/u.exec(text)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/u.exec(text)?.[1]?.trim();
    const task = id == null ? undefined : ledger.tasks.get(id);
    if (task != null && status != null && TERMINAL_TASK_STATUSES.has(status)) {
      task.ended = {at, status};
    }
  }
  if (r.type === 'assistant') {
    const content = (r.message as {content?: unknown} | undefined)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const b = block as {
        input?: {to?: unknown};
        name?: unknown;
        type?: unknown;
      };
      const to = b.input?.to;
      if (b.type !== 'tool_use' || b.name !== 'SendMessage') continue;
      if (typeof to !== 'string') continue;
      const task = ledger.tasks.get(to);
      if (task != null) task.ended = null;
    }
  }
}

/**
 * The work condition: no background task of this session is running. Never
 * final: a task that ends lets the watch go on (and its notification starts
 * a turn, which (b) then waits out).
 */
export function checkBackground(read: BackgroundRead): Condition {
  if (read.kind !== 'read') {
    return {
      final: false,
      ok: false,
      why: `the session's background tasks could not be read, so they count as running: ${read.reason}`,
    };
  }
  const running = read.tasks.filter((task) => task.ended == null);
  if (running.length > 0 || read.unreadable.length > 0) {
    const named = running.map(
      (task) =>
        `${task.kind === 'agent' ? 'subagent' : 'background shell'} ${task.id} (launched ${task.launchedAt ?? 'at an unknown time'}, no notification that it ended)`,
    );
    return {
      final: false,
      ok: false,
      why: `background work is still running: ${[...named, ...read.unreadable].join('; ')}`,
    };
  }
  return {
    ok: true,
    saw:
      read.tasks.length === 0
        ? 'no background task was launched in this session'
        : `all ${read.tasks.length} background tasks of this session have ended`,
  };
}

/**
 * A reader of one session's background-task ledger. The transcript is found
 * once, then read INCREMENTALLY: each call reads only the bytes appended
 * since the last complete line, so a long transcript is parsed once per
 * watch. A file that shrank is read again from the start.
 */
export function backgroundReaderOf(
  sessionId: string,
  env: EnvLike,
): () => BackgroundRead {
  let path: string | null = null;
  let offset = 0;
  let ledger = emptyLedger();
  return () => {
    if (path == null) {
      const found = findTranscript(sessionId, env);
      if (found.status === 'failed')
        return {kind: 'failed', reason: found.error};
      if (found.status === 'not-found') {
        return {
          kind: 'missing',
          reason: `no ${sessionId}.jsonl under ${found.searched}`,
        };
      }
      path = found.path;
    }
    try {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size < offset) {
          offset = 0;
          ledger = emptyLedger();
        }
        // Bytes, not strings: a chunk boundary may split a UTF-8 character.
        // `offset` is always the start of the first incomplete line.
        const chunk = 8 * 1024 * 1024;
        let pending = Buffer.alloc(0);
        let pos = offset;
        while (pos < size) {
          const length = Math.min(chunk, size - pos);
          const buffer = Buffer.alloc(length);
          const got = readSync(fd, buffer, 0, length, pos);
          if (got === 0) break;
          pos += got;
          const data = Buffer.concat([pending, buffer.subarray(0, got)]);
          const cut = data.lastIndexOf(0x0a);
          if (cut < 0) {
            pending = data;
            continue;
          }
          for (const line of data
            .subarray(0, cut)
            .toString('utf8')
            .split('\n')) {
            if (line.trim() !== '') foldLedgerLine(ledger, line);
          }
          offset += cut + 1;
          pending = data.subarray(cut + 1);
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return {
        kind: 'failed',
        reason: `${path} could not be read: ${String(error)}`,
      };
    }
    return {
      kind: 'read',
      path,
      tasks: [...ledger.tasks.values()],
      unreadable: [...ledger.unreadable],
    };
  };
}

/** The captured surface is still in the captured workspace. */
export function checkSurface(read: PaneOfSurfaceRead): Condition {
  if (read.kind === 'found') return {ok: true, saw: 'the tab is still there'};
  if (read.kind === 'notFound') {
    return {final: true, ok: false, why: `the tab is gone: ${read.reason}`};
  }
  // `tree --workspace <closed workspace>` fails "not_found: Workspace not
  // found" (measured, mbnjv.2): the tab went with its workspace.
  if (read.reason.includes('not_found')) {
    return {final: true, ok: false, why: `the tab is gone: ${read.reason}`};
  }
  return {
    final: false,
    ok: false,
    why: `the tab could not be checked: ${read.reason}`,
  };
}

/**
 * The screen's own count of running background work (mbnjv.13), read from
 * the turn's last line just above the box down to the footer, never from the
 * report above it. MEASURED live (run 20261029T183321Z, Claude Code 2.1.312,
 * idle with a background shell running): the turn line ends
 * "· 2 shells still running" and the mode line reads
 * "⏵⏵ auto mode on · 2 shells · ← 19 agents". Two shells while the
 * transcript launched one: a subagent's own background shell outlives the
 * subagent and shows ONLY here, so the screen is a second, independent
 * signal next to the transcript ledger.
 */
const BACKGROUND_ON_SCREEN: readonly RegExp[] = [
  /\b\d+ shells? still running\b/u,
  /· \d+ shells?\b/u,
  /\b\d+ background (?:tasks?|shells?|agents?)\b/u,
  /\b\d+ monitors?\b/u,
];

export function backgroundOnScreen(
  lines: readonly string[],
  boxTop: number,
): string | null {
  for (const line of lines.slice(Math.max(0, boxTop - 3))) {
    for (const pattern of BACKGROUND_ON_SCREEN) {
      const match = pattern.exec(line);
      if (match != null) return match[0];
    }
  }
  return null;
}

/** The caller's own tab shows THIS session, idle, at an empty input box. */
export function checkScreen(call: CmuxCall, sessionId: string): Condition {
  if (call.kind === 'failed') {
    return {
      final: false,
      ok: false,
      why: `the tab's screen could not be read: ${call.reason}`,
    };
  }
  const lines = screenLines(call.stdout);
  const box = findInputBox(lines);
  if (box == null) {
    const dialog = dialogOnScreen(lines);
    return {
      final: false,
      ok: false,
      why:
        dialog == null
          ? 'the tab shows no Claude Code input box'
          : `the tab shows ${dialog}`,
    };
  }
  // F17: only what is drawn from the box's top rule down can be a dialog
  // here. The final report above the box may well say "Do you want to …" or
  // "❯ 1."; a real dialog replaces the box (no box, above) or sits below it.
  // dialogOnScreen's own meaning is unchanged for open-undo and pane-backfill.
  const dialog = dialogOnScreen(lines.slice(box.top));
  if (dialog != null) {
    return {final: false, ok: false, why: `the tab shows ${dialog}`};
  }
  const shown = statusLineIdOf(call.stdout);
  if (shown?.toLowerCase() !== sessionId.toLowerCase()) {
    return {
      final: false,
      ok: false,
      why:
        shown == null
          ? `the tab's status line shows no session id, so it is not proven to be session ${sessionId}`
          : `the tab shows session ${shown}, not ${sessionId}`,
    };
  }
  const working = workingIndicator(lines);
  if (working != null) {
    return {
      final: false,
      ok: false,
      why: `the session is working ("${working}")`,
    };
  }
  const busy = backgroundOnScreen(lines, box.top);
  if (busy != null) {
    return {
      final: false,
      ok: false,
      why: `the tab shows background work still running ("${busy}")`,
    };
  }
  if (box.draft !== '' && !box.suggested) {
    return {final: false, ok: false, why: 'text is typed in the input box'};
  }
  return {
    ok: true,
    saw: 'Claude Code idle at an empty box, showing this session',
  };
}

/** Every condition of one read, labelled as the bead note names them. */
export interface HandshakeView {
  link: Condition;
  screen: Condition;
  stop: Condition;
  surface: Condition;
  /** No background task of the session is running (mbnjv.13). */
  work: Condition;
}

const LABELS: Record<keyof HandshakeView, string> = {
  link: '(a) link',
  screen: 'screen',
  stop: '(b) stop',
  surface: 'surface',
  work: '(b) background work',
};

const ORDER: readonly (keyof HandshakeView)[] = [
  'link',
  'stop',
  'work',
  'surface',
  'screen',
];

export type WatchDecision =
  | {kind: 'act'}
  | {kind: 'giveUp'; why: string}
  | {kind: 'wait'; why: string};

/** The unmet conditions in words: "(a) link: …; (b) stop: …". */
export function unmetWords(view: HandshakeView): string {
  return ORDER.flatMap((key) => {
    const condition = view[key];
    return condition.ok ? [] : [`${LABELS[key]}: ${condition.why}`];
  }).join('; ');
}

/** Act only when EVERY condition is met; a final failure ends the watch. */
export function decideWatch(view: HandshakeView): WatchDecision {
  for (const key of ORDER) {
    const condition = view[key];
    if (!condition.ok && condition.final) {
      return {kind: 'giveUp', why: `${LABELS[key]}: ${condition.why}`};
    }
  }
  const met = ORDER.every((key) => view[key].ok);
  return met ? {kind: 'act'} : {kind: 'wait', why: unmetWords(view)};
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export type NoteOutcome = {kind: 'failed'; reason: string} | {kind: 'recorded'};

export interface PredecessorLogRecord {
  at: string;
  beadId: string;
  detail: string;
  event: 'acted' | 'actFailed' | 'kept' | 'started' | 'startFailed';
  mode: PredecessorActMode;
  /** "recorded", or why the bead note was not written. */
  note: string;
  sessionId: string;
  surfaceId: string;
  workspaceId: string;
}

export interface PredecessorWatchDeps {
  /** One outcome line; null when written, else why not (F19: noted on the bead). */
  appendLog: (record: PredecessorLogRecord) => string | null;
  clock: () => number;
  /** The caller's background-task ledger, from its whole transcript (mbnjv.13). */
  readBackground: () => BackgroundRead;
  /** Any bead's labels in the caller's beads DB: the caller's and each candidate successor's (F10). */
  readLabels: (beadId: string) => LabelsRead;
  readLog: () => MessageLogRead;
  /** The tail of the caller's own transcript (mbnjv.11). */
  readTranscript: () => TranscriptTailRead;
  /** Note `text` on the caller's session bead. */
  recordNote: (text: string) => NoteOutcome;
  /** Every cmux call: the tree, the screen, the one act. */
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  verifyMs: number;
  verifyPollMs: number;
}

export type WatchOutcome =
  | {detail: string; kind: 'acted'}
  | {detail: string; kind: 'actFailed'}
  | {detail: string; kind: 'kept'};

const NOT_YET: Condition = {
  final: false,
  ok: false,
  why: 'not read yet: (a), (b) and the tab come first',
};

/** Read every condition once. The screen is read only once the rest hold. */
export async function readHandshake(
  watch: PredecessorWatch,
  deps: PredecessorWatchDeps,
): Promise<HandshakeView> {
  const {beadId, sessionId, surfaceId, workspaceId} = watch.caller;
  const link = checkLink({
    callerBeadId: beadId,
    callerLabels: deps.readLabels(beadId),
    labelsOf: deps.readLabels,
    successorSurfaceId: watch.successor.surfaceId,
  });
  const stop = checkStop({
    handedOffAt: new Date(watch.handedOffAt),
    log: deps.readLog(),
    nowMs: deps.clock(),
    settleMs: watch.settleMs,
    transcript: deps.readTranscript(),
  });
  const work = checkBackground(deps.readBackground());
  const surface = checkSurface(
    await readPaneOfSurface(deps.run, workspaceId, surfaceId),
  );
  if (!(link.ok && stop.ok && work.ok && surface.ok)) {
    return {link, screen: NOT_YET, stop, surface, work};
  }
  const call = await deps.run([
    'read-screen',
    '--workspace',
    workspaceId,
    '--surface',
    surfaceId,
  ]);
  return {link, screen: checkScreen(call, sessionId), stop, surface, work};
}

/** Poll after the act until the tree or the screen shows it, or time is up. */
async function verifyAct(
  watch: PredecessorWatch,
  deps: PredecessorWatchDeps,
): Promise<{ok: boolean; saw: string}> {
  const {surfaceId, workspaceId} = watch.caller;
  const start = deps.clock();
  let saw = 'nothing read';
  for (;;) {
    if (watch.mode === 'close') {
      const pane = await readPaneOfSurface(deps.run, workspaceId, surfaceId);
      const gone = checkSurface(pane);
      if (!gone.ok && gone.final) return {ok: true, saw: 'the tab is gone'};
      saw = gone.ok ? 'the tab is still listed' : gone.why;
    } else {
      const call = await deps.run([
        'read-screen',
        '--workspace',
        workspaceId,
        '--surface',
        surfaceId,
      ]);
      if (call.kind === 'ok' && call.stdout.includes(TOMBSTONE_HEADLINE)) {
        return {ok: true, saw: 'the tab shows the tombstone'};
      }
      saw =
        call.kind === 'ok'
          ? 'the tab does not show the tombstone'
          : `the screen could not be read: ${call.reason}`;
    }
    if (deps.clock() - start >= deps.verifyMs) return {ok: false, saw};
    await deps.sleep(deps.verifyPollMs);
  }
}

function finish(
  watch: PredecessorWatch,
  deps: PredecessorWatchDeps,
  outcome: WatchOutcome,
): WatchOutcome {
  const noted = deps.recordNote(outcome.detail);
  const logError = deps.appendLog({
    at: new Date(deps.clock()).toISOString(),
    beadId: watch.caller.beadId,
    detail: outcome.detail,
    event: outcome.kind,
    mode: watch.mode,
    note: noted.kind === 'recorded' ? 'recorded' : noted.reason,
    sessionId: watch.caller.sessionId,
    surfaceId: watch.caller.surfaceId,
    workspaceId: watch.caller.workspaceId,
  });
  // F19: a log line that could not be written is named on the bead, so the
  // outcome is never recorded in neither place without saying so.
  if (logError != null) {
    deps.recordNote(
      `predecessor log NOT written (${watch.logPath}): ${logError}; the outcome above is recorded only on this bead`,
    );
  }
  return outcome;
}

async function act(
  watch: PredecessorWatch,
  view: HandshakeView,
  deps: PredecessorWatchDeps,
): Promise<WatchOutcome> {
  const how = watch.mode === 'close' ? 'close-surface' : 'respawn-pane';
  const call = await deps.run(predecessorActArgs(watch));
  if (call.kind === 'failed') {
    return finish(watch, deps, {
      detail: `predecessor kept: cmux ${how} on this tab failed: ${call.reason}`,
      kind: 'actFailed',
    });
  }
  const verified = await verifyAct(watch, deps);
  const handshake = [view.link, view.stop, view.work]
    .map((condition) => (condition.ok ? condition.saw : ''))
    .join('; ');
  const done =
    watch.mode === 'close'
      ? `predecessor closed: this session's tab was closed with cmux close-surface`
      : `predecessor exited: Claude Code in this tab was ended with cmux respawn-pane and the tab shows a tombstone`;
  if (!verified.ok) {
    return finish(watch, deps, {
      detail: `${done}, but this is NOT verified: cmux answered OK and after ${Math.round(deps.verifyMs / 1000)} s ${verified.saw} (handshake: ${handshake})`,
      kind: 'actFailed',
    });
  }
  return finish(watch, deps, {
    detail: `${done}; ${verified.saw} (handshake: ${handshake})`,
    kind: 'acted',
  });
}

/**
 * The watch (C6). Reads the handshake every pollMs; when every condition
 * holds it reads it AGAIN and acts only if it still holds. Gives up without
 * acting on a final failure or after timeoutMs.
 */
export async function runPredecessorWatch(
  watch: PredecessorWatch,
  deps: PredecessorWatchDeps,
): Promise<WatchOutcome> {
  const started = deps.clock();
  for (;;) {
    const first = await readHandshake(watch, deps);
    let decision = decideWatch(first);
    let view = first;
    if (decision.kind === 'act') {
      view = await readHandshake(watch, deps);
      decision = decideWatch(view);
      // F18: the limit is checked right before acting, not only while
      // waiting: after the Mac slept past it, the first read on wake must
      // not act.
      const late = deps.clock() - started;
      if (decision.kind === 'act' && late >= watch.timeoutMs) {
        return finish(watch, deps, {
          detail: `predecessor kept: the handshake held only after the ${Math.round(watch.timeoutMs / 60_000)}-minute limit had passed (${Math.round(late / 60_000)} min since the watch started; the Mac may have slept), so it did not act`,
          kind: 'kept',
        });
      }
      if (decision.kind === 'act') return await act(watch, view, deps);
    }
    if (decision.kind === 'giveUp') {
      return finish(watch, deps, {
        detail: `predecessor kept: handshake failed: ${decision.why}`,
        kind: 'kept',
      });
    }
    const waited = deps.clock() - started;
    if (waited >= watch.timeoutMs) {
      return finish(watch, deps, {
        detail: `predecessor kept: handshake failed: ${unmetWords(view)} (gave up after ${Math.round(waited / 60_000)} min without acting)`,
        kind: 'kept',
      });
    }
    await deps.sleep(watch.pollMs);
  }
}

// ---------------------------------------------------------------------------
// The real readers and writers
// ---------------------------------------------------------------------------

/** cmux through the live socket, quiet (the same env thread handoff uses). */
export function liveCmuxRunner(env: EnvLike): CmuxRunner {
  const socket = liveSocketPath(env);
  const cmuxEnv =
    'path' in socket
      ? {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path}
      : {...env, CMUX_QUIET: '1'};
  return realCmuxRunner(undefined, cmuxEnv);
}

/** Append "- <stamp>: <text>" to a session bead's notes (one br write). */
export function appendSessionNote(input: {
  beadId: string;
  db: string;
  env: EnvLike;
  now: Date;
  text: string;
}): NoteOutcome {
  const shown = brShow({db: input.db, env: input.env}, input.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${input.beadId} could not be read: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {kind: 'failed', reason: `${input.beadId} is not in ${input.db}`};
  }
  const written = brUpdate({db: input.db, env: input.env}, input.beadId, {
    notes: appendNote(shown.issue.notes, oneLine(input.text), input.now),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${input.beadId} was not updated: ${describeBrFailed(written)}`,
    };
  }
  return {kind: 'recorded'};
}

/** One JSON line in the outcome log; null when written, else why not. */
export function appendPredecessorLog(
  path: string,
  record: PredecessorLogRecord,
): string | null {
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return null;
  } catch (error) {
    return String(error);
  }
}

/**
 * A reader of one session's transcript tail. The file is found once (a scan
 * of every project directory, facts.ts findTranscript) and then re-read by
 * path; not found yet is "missing", which waits.
 */
export function transcriptReaderOf(
  sessionId: string,
  env: EnvLike,
): () => TranscriptTailRead {
  let path: string | null = null;
  return () => {
    if (path == null) {
      const found = findTranscript(sessionId, env);
      if (found.status === 'failed') {
        return {kind: 'failed', reason: found.error};
      }
      if (found.status === 'not-found') {
        return {
          kind: 'missing',
          reason: `no ${sessionId}.jsonl under ${found.searched}`,
        };
      }
      path = found.path;
    }
    return readTranscriptTail(path);
  };
}

/**
 * Half (b) for a session, read from the real files: the one reading the
 * watcher acts on, exported so the live harness checks "the old session
 * ended its turn" the same way (mbnjv.11 AC3).
 */
export function readStopCondition(input: {
  env: EnvLike;
  handedOffAt: Date;
  nowMs?: number;
  sessionId: string;
  settleMs?: number;
}): Condition {
  return checkStop({
    handedOffAt: input.handedOffAt,
    log: readMessageLog(input.sessionId, input.env),
    nowMs: input.nowMs ?? Date.now(),
    settleMs: input.settleMs ?? PREDECESSOR_SETTLE_MS,
    transcript: transcriptReaderOf(input.sessionId, input.env)(),
  });
}

export function realPredecessorWatchDeps(
  watch: PredecessorWatch,
  env: EnvLike,
): PredecessorWatchDeps {
  const {beadId, db, sessionId} = watch.caller;
  return {
    appendLog: (record) => appendPredecessorLog(watch.logPath, record),
    clock: () => Date.now(),
    readBackground: backgroundReaderOf(sessionId, env),
    readLabels: (id) => {
      const shown = brShow({db, env}, id);
      if (shown.kind === 'ok') return {kind: 'ok', labels: shown.issue.labels};
      return {
        kind: 'failed',
        reason:
          shown.kind === 'notFound' ? `not in ${db}` : describeBrFailed(shown),
      };
    },
    readLog: () => readMessageLog(sessionId, env),
    readTranscript: transcriptReaderOf(sessionId, env),
    recordNote: (text) =>
      appendSessionNote({beadId, db, env, now: new Date(), text}),
    run: liveCmuxRunner(env),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    verifyMs: PREDECESSOR_VERIFY_MS,
    verifyPollMs: PREDECESSOR_VERIFY_POLL_MS,
  };
}

// ---------------------------------------------------------------------------
// Starting the watcher (thread handoff, after the successor started)
// ---------------------------------------------------------------------------

export function predecessorLogPath(env: EnvLike): string {
  return join(threadsStateDir(env), PREDECESSOR_LOG_FILE);
}

export type WatcherStart =
  | {kind: 'failed'; reason: string}
  | {
      kind: 'started';
      /** Why the `started` log line was not written, or null (F19). */
      logError: string | null;
      pid: number | null;
      watchPath: string;
    };

/**
 * Write the plan to <threads state dir>/handoff-watch/<session id>.json and
 * start `bun predecessor-watch.ts <that file>` DETACHED (its own process
 * group, stdio ignored, unref'd: the pattern of capture.ts and closeLater,
 * which 1r6d.34.5 measured to outlive the Bash tool call), then log
 * `started`. thread handoff runs outside the sandbox (D4), so the child
 * can reach cmux's socket.
 */
export function startPredecessorWatch(
  watch: PredecessorWatch,
  env: EnvLike,
): WatcherStart {
  const watchPath = join(
    threadsStateDir(env),
    PREDECESSOR_WATCH_DIR,
    `${watch.caller.sessionId}.json`,
  );
  try {
    mkdirSync(dirname(watchPath), {recursive: true});
    writeFileSync(watchPath, `${JSON.stringify(watch, null, 2)}\n`);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${watchPath} could not be written: ${String(error)}`,
    };
  }
  let pid: number | null;
  try {
    const child = spawn(process.execPath, [PREDECESSOR_WATCH_PATH, watchPath], {
      detached: true,
      env: silencedChildEnv(env) as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    // An async spawn failure must not crash thread handoff after the start.
    child.on('error', () => undefined);
    child.unref();
    pid = child.pid ?? null;
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the watcher could not be started: ${String(error)}`,
    };
  }
  if (pid == null) {
    return {
      kind: 'failed',
      reason: 'the watcher has no pid, so it is not proven to run',
    };
  }
  const logError = appendPredecessorLog(watch.logPath, {
    at: new Date().toISOString(),
    beadId: watch.caller.beadId,
    detail: `watcher pid ${pid} started from ${watchPath}`,
    event: 'started',
    mode: watch.mode,
    note: 'written by thread handoff as the watcher-started note (F19)',
    sessionId: watch.caller.sessionId,
    surfaceId: watch.caller.surfaceId,
    workspaceId: watch.caller.workspaceId,
  });
  return {kind: 'started', logError, pid, watchPath};
}

/**
 * The bead note thread handoff writes once the watcher runs (F19), so a
 * watcher that dies before any outcome still left a trace on the bead.
 */
export function watcherStartedNote(input: {
  logError: string | null;
  logPath: string;
  mode: PredecessorActMode;
  pid: number | null;
  successorSurfaceId: string;
}): string {
  const verb = input.mode === 'close' ? 'close' : 'exit';
  const logged =
    input.logError == null
      ? `log ${input.logPath}`
      : `its started line was NOT logged to ${input.logPath}: ${input.logError}`;
  return `predecessor watcher started: this tab will ${verb} once the successor in tab ${input.successorSurfaceId} links back and this session's turn has ended; watcher pid ${input.pid ?? '?'}; ${logged}`;
}
