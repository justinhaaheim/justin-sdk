/**
 * `thread nudge` — the PostToolUse commit nudge (status report v4, epic
 * home-base-vzwbj.4 D3; built by home-base-vzwbj.4.4 design item 3).
 *
 * Installed by thread-hooks-setup as `PostToolUse` with matcher `Bash`. After
 * a Bash call that ran `git commit`, when the session has NO request in
 * progress, it puts ONE line into Claude's context (PostToolUse output reaches
 * the model; hook-output.ts mirrors it to Justin):
 *
 *   [thread] you committed but no request is in progress for this session —
 *   if this is work Justin asked for, run: bun run justin-sdk thread request "…"
 *
 * THE DECISION TABLE, in order — the first row that matches decides:
 *   payload not JSON, or no session_id   silent  (cannot tell whose session)
 *   agent_id present                     silent  (a subagent: its conductor
 *                                                 owns the requests, and
 *                                                 `thread request` refuses
 *                                                 subagents)
 *   tool is not Bash, or the command
 *     is not a `git commit`              silent
 *   componentConfig.thread.nudge or
 *     .sessionBeads off                  silent
 *   no session bead for the session      silent  (`thread request` would
 *                                                 refuse; nothing to nudge to)
 *   a request in progress                silent
 *   already nudged this turn             silent
 *   otherwise                            the line
 *
 * ONCE PER TURN: a marker at `<state dir>/nudge-marks/<session id>.json`
 * holds the time of the session's last user message in the message log when
 * it spoke; a new prompt changes that time, so the marker no longer matches.
 * When the log has no user line to key on, it speaks without a marker: it
 * cannot prove it already spoke this turn, and a repeated one-line nudge is
 * noise, while a missing one hides work with no request (the direction
 * critical rule 7 forbids). When the session's beads cannot be read — or the
 * sessions index cannot, or it has a corrupt line naming this session — it
 * speaks for the same reason, with the VARIANT line (home-base-vzwbj.4.9 R7,
 * R9): "I could not check whether a request is in progress (<reason>)", never
 * the claim that none is.
 *
 * THE LAST-REQUEST WARNING (home-base-yukaf.3, epic home-base-yukaf decision
 * D-LAST-REQUEST-WARNING). The same hook, a second decision, its own marker.
 * After a Bash call that ran `br close <ids…>` (`brCloseIds`), it says:
 *
 *   [thread] you closed the last open request in this session ("<title>").
 *   Before you stop: re-read Justin's first message — … file it: thread request "…"
 *
 * Its table, in order:
 *   payload unreadable, no session_id,
 *     a subagent, not Bash              silent  (as above)
 *   no `br close` naming a bead id      silent  (`br close` with NO id closes
 *                                                 br's last-touched bead, which
 *                                                 this cannot name)
 *   the knobs off                       silent  (the same two knobs)
 *   no session bead for the session     silent
 *   none of the ids is a request of
 *     this session                      silent  (a non-request bead)
 *   a request of this session is still
 *     open (ids just closed count as
 *     closed: the export may lag)       silent
 *   already warned this turn            silent  (its own marker,
 *                                                 lastRequestMarkPath)
 *   otherwise                           the line
 * Rule 7: when the session's beads cannot be read (an export, the sessions
 * index, or a corrupt index line), "that was the last request" is not a
 * measured fact, so it speaks the VARIANT, which names the ids and the reason
 * and asks the same question — never the claim, and never silence.
 *
 * Both decisions can speak on one call (`br close X && git commit`); the two
 * lines then go out as one context block.
 *
 * Always exits 0 and never blocks; nothing here can stop a tool call.
 */

import type {EnvLike} from './paths';
import type {SessionTree, TreeIssue} from './session-tree';

import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname} from 'path';

import {BEAD_ID_SOURCE} from '../beads/br';
import {emitHookOutput} from '../hook-output';
import {sdkRun} from '../sdk-invocation';
import {lastRequestMarkPath, nudgeMarkPath} from './archive';
import {readMessageLog} from './message-log';
import {isGitCommitCommand, stripQuotedText} from './session-commits';
import {
  corruptSightingsNote,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';
import {readSessionTree} from './session-tree';

const NUDGE_COMMAND = sdkRun('thread request "<what he asked for>"');

export const NUDGE_LINE = `[thread] you committed but no request is in progress for this session — if this is work Justin asked for, run: ${NUDGE_COMMAND}`;

/**
 * The variant for a check that could not be made (home-base-vzwbj.4.9 R7):
 * the beads or the sessions index could not be read, so "no request is in
 * progress" is not a measured fact and is not said.
 */
export function nudgeUncheckedLine(reason: string): string {
  return `[thread] you committed; I could not check whether a request is in progress (${reason.replace(/\s+/g, ' ').trim()}) — if this is work Justin asked for, run: ${NUDGE_COMMAND}`;
}

export type NudgeDecision =
  | {
      kind: 'speak';
      marked: boolean;
      /** R7: why the request check could not be made; null = it was made. */
      unchecked: string | null;
      why: string;
    }
  | {kind: 'silent'; why: string};

/** The one line a speaking decision prints. */
export function nudgeLine(
  decision: Extract<NudgeDecision, {kind: 'speak'}>,
): string {
  return decision.unchecked == null
    ? NUDGE_LINE
    : nudgeUncheckedLine(decision.unchecked);
}

interface Payload {
  agentId: string | null;
  command: string | null;
  cwd: string | null;
  /** tool_response stdout and stderr joined; null when it carries neither. */
  output: string | null;
  sessionId: string | null;
  toolName: string | null;
}

function toolOutput(response: unknown): string | null {
  if (response == null || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const parts = [record.stdout, record.stderr].filter(
    (part): part is string => typeof part === 'string',
  );
  return parts.length === 0 ? null : parts.join('\n');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseNudgePayload(raw: string): Payload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const input = record.tool_input;
  return {
    agentId: text(record.agent_id),
    command:
      input != null && typeof input === 'object'
        ? text((input as Record<string, unknown>).command)
        : null,
    cwd: text(record.cwd),
    output: toolOutput(record.tool_response),
    sessionId: text(record.session_id),
    toolName: text(record.tool_name),
  };
}

/** The turn key: the time of the newest user line, or null when there is none. */
function turnKey(sessionId: string, env: EnvLike): string | null {
  const log = readMessageLog(sessionId, env);
  if (log.kind !== 'read') return null;
  const users = log.lines.filter((line) => line.role === 'user');
  return users.at(-1)?.at ?? null;
}

/**
 * This session's beads, read from files only (the sessions index, then the
 * exports it names). `unreadable`: the check cannot be made — the index
 * failed, or it has a corrupt line for this session and no readable `created`
 * line (R9). `tree.problems` also carries a corrupt line seen beside a
 * readable one: the tree may then be partial.
 */
type SessionBeads =
  | {kind: 'noSessionBead'}
  | {kind: 'tree'; problems: string[]; tree: SessionTree}
  | {kind: 'unreadable'; reason: string};

function readSessionBeads(sessionId: string, env: EnvLike): SessionBeads {
  const sightings = readSessionSightings(sessionId, env);
  // R9: a corrupt index line that mentions this session may be the session
  // bead's own `created` line, or a second DB's: the check is then partial.
  const corruptNote = corruptSightingsNote(sightings);
  if (sightings.kind === 'failed') {
    return {
      kind: 'unreadable',
      reason: `the sessions index is unreadable: ${sightings.error}`,
    };
  }
  const list = sightings.kind === 'read' ? sightings.sightings : [];
  const created = sessionBeadSighting(list);
  if (created == null) {
    return corruptNote == null
      ? {kind: 'noSessionBead'}
      : {kind: 'unreadable', reason: corruptNote};
  }
  const tree = readSessionTree({
    beadsDirs: [created.beadsDir, ...list.map((entry) => entry.beadsDir)],
    sessionBeadId: created.beadId,
    sessionId,
  });
  return {
    kind: 'tree',
    problems: [...tree.problems, ...(corruptNote != null ? [corruptNote] : [])],
    tree,
  };
}

function readMark(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed != null && typeof parsed === 'object'
      ? text((parsed as Record<string, unknown>).turn)
      : null;
  } catch {
    // No marker (or an unreadable one): not yet nudged this turn.
    return null;
  }
}

function writeMark(path: string, turn: string, now: Date): boolean {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      `${JSON.stringify({at: now.toISOString(), turn})}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Speak at most once per turn, keyed by the newest user line (see the
 * header). No user line to key on: speak, unmarked.
 */
function oncePerTurn(input: {
  env: EnvLike;
  markPath: string;
  now: Date;
  sessionId: string;
}): {kind: 'already'} | {kind: 'speak'; marked: boolean} {
  const turn = turnKey(input.sessionId, input.env);
  if (turn == null) return {kind: 'speak', marked: false};
  if (readMark(input.markPath) === turn) return {kind: 'already'};
  return {kind: 'speak', marked: writeMark(input.markPath, turn, input.now)};
}

/** The decision, and the marker write when it speaks. Prints nothing. */
export async function decideNudge(input: {
  env: EnvLike;
  now: Date;
  raw: string;
}): Promise<NudgeDecision> {
  const {env, now} = input;
  const payload = parseNudgePayload(input.raw);
  if (payload == null) return {kind: 'silent', why: 'payload is not JSON'};
  if (payload.sessionId == null) {
    return {kind: 'silent', why: 'payload has no session_id'};
  }
  if (payload.agentId != null) {
    return {kind: 'silent', why: `subagent (agent_id=${payload.agentId})`};
  }
  if (payload.toolName !== 'Bash') {
    return {kind: 'silent', why: `tool ${payload.toolName ?? '(none)'}`};
  }
  if (payload.command == null || !isGitCommitCommand(payload.command)) {
    return {kind: 'silent', why: 'not a git commit'};
  }
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd: payload.cwd ?? process.cwd(), env});
  if (!config.sessionBeads || !config.nudge) {
    return {
      kind: 'silent',
      why: `knob off (sessionBeads=${config.sessionBeads}, nudge=${config.nudge})`,
    };
  }

  const sessionId = payload.sessionId;
  const beads = readSessionBeads(sessionId, env);
  let beadsUnreadable: string | null = null;
  if (beads.kind === 'noSessionBead') {
    return {kind: 'silent', why: 'no session bead for this session'};
  }
  if (beads.kind === 'unreadable') {
    beadsUnreadable = beads.reason;
  } else {
    if (
      beads.tree.requests.some((node) => node.request.status === 'in_progress')
    ) {
      return {kind: 'silent', why: 'a request is in progress'};
    }
    if (beads.problems.length > 0) beadsUnreadable = beads.problems.join('; ');
  }

  const why =
    beadsUnreadable == null
      ? 'no request in progress'
      : `the beads could not be read (${beadsUnreadable})`;
  const unchecked = beadsUnreadable;
  const once = oncePerTurn({
    env,
    markPath: nudgeMarkPath(sessionId, env),
    now,
    sessionId,
  });
  if (once.kind === 'already') {
    return {kind: 'silent', why: 'already nudged this turn'};
  }
  return {kind: 'speak', marked: once.marked, unchecked, why};
}

// ---------------------------------------------------------------------------
// The last-request warning (home-base-yukaf.3, D-LAST-REQUEST-WARNING)
// ---------------------------------------------------------------------------

const LAST_REQUEST_TAIL = `Before you stop: re-read Justin's first message — does everything he asked for exist, or is it answered in your message? If anything is missing, even a conditional or uncertain ask, file it: ${sdkRun('thread request "…"')}`;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The line, naming the request (or requests) the command closed. */
export function lastRequestLine(titles: readonly string[]): string {
  const quoted = titles.map((title) => `"${oneLine(title)}"`).join(', ');
  const what =
    titles.length === 1 ? 'the last open request' : 'the last open requests';
  return `[thread] you closed ${what} in this session (${quoted}). ${LAST_REQUEST_TAIL}`;
}

/**
 * The variant for a check that could not be made (rule 7): the session's
 * beads could not all be read, so "that was the last request" is unknown.
 */
export function lastRequestUncheckedLine(
  ids: readonly string[],
  reason: string,
): string {
  return `[thread] you closed ${ids.join(', ')}; I could not check whether that was the last open request in this session (${oneLine(reason)}). ${LAST_REQUEST_TAIL}`;
}

/**
 * br options that take a value, before or after the subcommand (`br --help`
 * and `br close --help`, br 0.x, read 2026-10-18). A value never counts as an
 * id: `--reason not-needed` must not close a bead called `not-needed`.
 */
const BR_VALUE_OPTIONS = new Set([
  '--actor',
  '--db',
  '--lock-timeout',
  '--reason',
  '--session',
]);

const BEAD_ID_TOKEN = new RegExp(String.raw`^(?:${BEAD_ID_SOURCE})$`);

function takesValue(token: string): boolean {
  if (token.includes('=')) return false;
  if (BR_VALUE_OPTIONS.has(token)) return true;
  // `-r <reason>`, or a short cluster ending in r (`-fr <reason>`).
  return /^-[a-zA-Z]*r$/.test(token);
}

/**
 * `plain` (quotes already stripped) without its shell comments: a `#` that
 * starts a word runs to the end of its line (home-base-yukaf.14 F14).
 */
function stripShellComments(plain: string): string {
  return plain
    .split('\n')
    .map((line) => line.replace(/(?:^|\s)#.*$/, ''))
    .join('\n');
}

/** `FOO=bar` before a command word. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The bead ids every `br close` in `command` names, in order, each once.
 * Quoted text is ignored (stripQuotedText), so `echo "br close x-1"` and a
 * reason that mentions an id are not closes. Shell comments are ignored, and
 * `br` counts only as the COMMAND word of a simple command (first word, after
 * any `VAR=value`; `/path/to/br` too), so `# br close x-1` and
 * `echo br close x-1` close nothing (F14). Global options may come before
 * `close` (`br --db <path> close <id>`); option values are skipped; a token
 * counts only when it has the bead id shape (`home-base-abcde`,
 * `home-base-abcde.12`). A `br close` asking for `--help`/`-h` closes nothing.
 * `br close` with no id (br's last-touched bead) and an id held in a shell
 * variable name nothing, so they give no ids. `br update <id> --status
 * closed` is no close: br 0.5.12 refuses it (exit 4, "terminal-state
 * transitions must go through `br close`"; measured 2026-10-18).
 */
export function brCloseIds(command: string): string[] {
  const plain = stripShellComments(stripQuotedText(command));
  const ids: string[] = [];
  for (const segment of plain.split(/;|&&|\|\||\||&|\n|\(|\)/)) {
    const words = segment.split(/\s+/).filter((token) => token !== '');
    let first = 0;
    while (first < words.length && ENV_ASSIGNMENT.test(words[first] ?? '')) {
      first += 1;
    }
    const commandWord = words[first] ?? '';
    if (commandWord !== 'br' && !commandWord.endsWith('/br')) continue;
    const tokens = words.slice(first + 1);
    let index = 0;
    while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
      index += takesValue(tokens[index] ?? '') ? 2 : 1;
    }
    if (tokens[index] !== 'close') continue;
    const found: string[] = [];
    let help = false;
    for (index += 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (token === '--help' || token === '-h') {
        help = true;
        break;
      }
      if (token.startsWith('-')) {
        if (takesValue(token)) index += 1;
        continue;
      }
      if (BEAD_ID_TOKEN.test(token)) found.push(token);
    }
    if (!help) ids.push(...found);
  }
  return [...new Set(ids)];
}

/**
 * The ids br's own output says it did NOT close (F14), read from the Bash
 * tool_response's stdout and stderr. A whole close br refuses exits non-zero
 * (3, measured with br 0.5.12, 2026-10-18), and a failed Bash call fires
 * PostToolUseFailure, not PostToolUse, so this hook never sees it. What does
 * reach it is a refusal whose exit code a later step hid (`br close x; echo`,
 * `br close x | tail`), and br prints that refusal as
 * `Skipped <id>: <why>` or `Issue not found: <id>`.
 */
export function brRefusedIds(output: string): Set<string> {
  const refused = new Set<string>();
  const pattern = new RegExp(
    String.raw`(?:Skipped|Issue not found:)\s+(${BEAD_ID_SOURCE})\b`,
    'g',
  );
  for (const match of output.matchAll(pattern)) {
    if (match[1] != null) refused.add(match[1]);
  }
  return refused;
}

/**
 * Closed or tombstoned — session-status.ts `isOpen`, negated. Not imported:
 * session-status pulls in session-model (git, transcripts, usage-check), and
 * this hook runs on every commit and close.
 */
function isClosedStatus(status: string): boolean {
  return status === 'closed' || status === 'tombstone';
}

export type LastRequestDecision =
  | {
      /** The bead ids the command closed. */
      closedIds: string[];
      kind: 'speak';
      marked: boolean;
      /** The titles of the requests among them (empty when unchecked). */
      titles: string[];
      /** Rule 7: why the check could not be made; null = it was made. */
      unchecked: string | null;
      why: string;
    }
  | {kind: 'silent'; why: string};

/** The one line a speaking last-request decision prints. */
export function lastRequestNudgeLine(
  decision: Extract<LastRequestDecision, {kind: 'speak'}>,
): string {
  return decision.unchecked == null
    ? lastRequestLine(decision.titles)
    : lastRequestUncheckedLine(decision.closedIds, decision.unchecked);
}

/** The last-request decision, and its marker write when it speaks. */
export async function decideLastRequestNudge(input: {
  env: EnvLike;
  now: Date;
  raw: string;
}): Promise<LastRequestDecision> {
  const {env, now} = input;
  const payload = parseNudgePayload(input.raw);
  if (payload == null) return {kind: 'silent', why: 'payload is not JSON'};
  if (payload.sessionId == null) {
    return {kind: 'silent', why: 'payload has no session_id'};
  }
  if (payload.agentId != null) {
    return {kind: 'silent', why: `subagent (agent_id=${payload.agentId})`};
  }
  if (payload.toolName !== 'Bash') {
    return {kind: 'silent', why: `tool ${payload.toolName ?? '(none)'}`};
  }
  const namedIds = payload.command == null ? [] : brCloseIds(payload.command);
  if (namedIds.length === 0) {
    return {kind: 'silent', why: 'not a br close of a bead id'};
  }
  const refused = brRefusedIds(payload.output ?? '');
  const closedIds = namedIds.filter((id) => !refused.has(id));
  if (closedIds.length === 0) {
    return {
      kind: 'silent',
      why: `br refused the close (${namedIds.join(', ')})`,
    };
  }
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd: payload.cwd ?? process.cwd(), env});
  if (!config.sessionBeads || !config.nudge) {
    return {
      kind: 'silent',
      why: `knob off (sessionBeads=${config.sessionBeads}, nudge=${config.nudge})`,
    };
  }

  const sessionId = payload.sessionId;
  const beads = readSessionBeads(sessionId, env);
  if (beads.kind === 'noSessionBead') {
    return {kind: 'silent', why: 'no session bead for this session'};
  }
  let unchecked: string | null = null;
  let titles: string[] = [];
  if (beads.kind === 'unreadable') {
    unchecked = beads.reason;
  } else {
    const closed = new Set(closedIds);
    const requests = beads.tree.requests.map((node) => node.request);
    const byId = new Map(requests.map((request) => [request.id, request]));
    const closedRequests = closedIds
      .map((id) => byId.get(id))
      .filter((request): request is TreeIssue => request != null);
    const problems = beads.problems.join('; ');
    if (closedRequests.length === 0) {
      // An id may be a request held in the export that could not be read.
      if (problems === '') {
        return {
          kind: 'silent',
          why: `closed no request of this session (${closedIds.join(', ')})`,
        };
      }
      unchecked = problems;
    } else {
      const stillOpen = requests.filter(
        (request) => !isClosedStatus(request.status) && !closed.has(request.id),
      );
      if (stillOpen.length > 0) {
        return {
          kind: 'silent',
          why: `${stillOpen.length} request${stillOpen.length === 1 ? '' : 's'} of this session still open (${stillOpen.map((request) => request.id).join(', ')})`,
        };
      }
      // Another request may sit in the export that could not be read.
      if (problems !== '') unchecked = problems;
      titles = closedRequests.map((request) => request.title);
    }
  }

  const once = oncePerTurn({
    env,
    markPath: lastRequestMarkPath(sessionId, env),
    now,
    sessionId,
  });
  if (once.kind === 'already') {
    return {kind: 'silent', why: 'already warned this turn'};
  }
  return {
    closedIds,
    kind: 'speak',
    marked: once.marked,
    titles: unchecked == null ? titles : [],
    unchecked,
    why:
      unchecked == null
        ? 'closed the last open request of this session'
        : `the beads could not be read (${unchecked})`,
  };
}

function failedDecision(error: unknown): {kind: 'silent'; why: string} {
  return {
    kind: 'silent',
    why: `failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * The hook: read stdin, make both decisions, print at most one hook-JSON
 * line (the commit nudge, the last-request warning, or both). Always 0.
 */
export async function runThreadNudgeHook(
  args: {env?: EnvLike; explain?: boolean; now?: Date; stdin?: string} = {},
): Promise<number> {
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  let raw: string;
  try {
    raw = args.stdin ?? readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  // Never block a tool call over the nudge's own failure.
  let commit: NudgeDecision;
  try {
    commit = await decideNudge({env, now, raw});
  } catch (error) {
    commit = failedDecision(error);
  }
  let lastRequest: LastRequestDecision;
  try {
    lastRequest = await decideLastRequestNudge({env, now, raw});
  } catch (error) {
    lastRequest = failedDecision(error);
  }
  if (args.explain === true) {
    console.error(`thread nudge: ${commit.kind} — ${commit.why}`);
    console.error(
      `thread nudge (last request): ${lastRequest.kind} — ${lastRequest.why}`,
    );
  }
  const lines = [
    commit.kind === 'speak' ? nudgeLine(commit) : null,
    lastRequest.kind === 'speak' ? lastRequestNudgeLine(lastRequest) : null,
  ].filter((line): line is string => line != null);
  if (lines.length > 0) {
    emitHookOutput({event: 'PostToolUse', forClaude: lines.join('\n')});
  }
  return 0;
}
