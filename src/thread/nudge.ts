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
 * Always exits 0 and never blocks; nothing here can stop a tool call.
 */

import type {EnvLike} from './paths';

import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname} from 'path';

import {emitHookOutput} from '../hook-output';
import {sdkRun} from '../sdk-invocation';
import {nudgeMarkPath} from './archive';
import {readMessageLog} from './message-log';
import {isGitCommitCommand} from './session-commits';
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
  sessionId: string | null;
  toolName: string | null;
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
  const sightings = readSessionSightings(sessionId, env);
  // R9: a corrupt index line that mentions this session may be the session
  // bead's own `created` line, or a second DB's: the check is then partial.
  const corruptNote = corruptSightingsNote(sightings);
  let beadsUnreadable: string | null = null;
  if (sightings.kind === 'failed') {
    beadsUnreadable = `the sessions index is unreadable: ${sightings.error}`;
  } else {
    const list = sightings.kind === 'read' ? sightings.sightings : [];
    const created = sessionBeadSighting(list);
    if (created == null) {
      if (corruptNote == null) {
        return {kind: 'silent', why: 'no session bead for this session'};
      }
      beadsUnreadable = corruptNote;
    } else {
      const tree = readSessionTree({
        beadsDirs: [created.beadsDir, ...list.map((entry) => entry.beadsDir)],
        sessionBeadId: created.beadId,
        sessionId,
      });
      if (tree.requests.some((node) => node.request.status === 'in_progress')) {
        return {kind: 'silent', why: 'a request is in progress'};
      }
      const problems = [
        ...tree.problems,
        ...(corruptNote != null ? [corruptNote] : []),
      ];
      if (problems.length > 0) beadsUnreadable = problems.join('; ');
    }
  }

  const turn = turnKey(sessionId, env);
  const why =
    beadsUnreadable == null
      ? 'no request in progress'
      : `the beads could not be read (${beadsUnreadable})`;
  const unchecked = beadsUnreadable;
  if (turn == null) return {kind: 'speak', marked: false, unchecked, why};
  const markPath = nudgeMarkPath(sessionId, env);
  if (readMark(markPath) === turn) {
    return {kind: 'silent', why: 'already nudged this turn'};
  }
  return {
    kind: 'speak',
    marked: writeMark(markPath, turn, now),
    unchecked,
    why,
  };
}

/** The hook: read stdin, decide, print at most one line. Always 0. */
export async function runThreadNudgeHook(
  args: {env?: EnvLike; explain?: boolean; now?: Date; stdin?: string} = {},
): Promise<number> {
  const env = args.env ?? process.env;
  let raw: string;
  try {
    raw = args.stdin ?? readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let decision: NudgeDecision;
  try {
    decision = await decideNudge({env, now: args.now ?? new Date(), raw});
  } catch (error) {
    // Never block a tool call over the nudge's own failure.
    decision = {
      kind: 'silent',
      why: `failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (args.explain === true) {
    console.error(`thread nudge: ${decision.kind} — ${decision.why}`);
  }
  if (decision.kind === 'speak') {
    emitHookOutput({event: 'PostToolUse', forClaude: nudgeLine(decision)});
  }
  return 0;
}
