/**
 * `thread stage <request> <stage>… [--unset]` (status report v4, epic
 * home-base-vzwbj.4 D1 "STAGES"; built by home-base-vzwbj.4.3): mark how far a
 * request got. Each stage is a `stage:<name>` label on the REQUEST bead; the
 * names come from `componentConfig.thread.stages` (default code-done, tested,
 * built, link-sent, approved) and anything else is refused, the ladder
 * printed. Unreached stages are never filled in: Part 1 shows the highest one
 * marked and the next.
 *
 * WHICH DB: the request is looked up in the session's beads DB first (through
 * the sessions index, when CLAUDE_CODE_SESSION_ID / --session names a session
 * that has one), then in the current directory's — the same order `thread
 * request --bead` uses (epic D1). A lookup that FAILS stops the command: a
 * "not here" guess could mark a same-id bead in the next DB (rule 7).
 *
 * Exit: 0 marked · 1 not found, br failed, knob off · 2 usage (no stage, a name
 * off the ladder, a bead that is not a request).
 */

import type {BrTarget} from '../beads/br';
import type {EnvLike} from './paths';

import {
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsDb,
  findBeadsWorkspace,
} from '../beads/br';
import {sdkRun} from '../sdk-invocation';
import {REQUEST_LABEL, STAGE_LABEL_PREFIX} from './session-bead';
import {readSessionSightings} from './session-index';
import {sessionBeadsKnob, sessionIdFrom} from './session-select';
import {stageReached} from './session-status';

export interface ThreadStageOptions {
  cwd?: string;
  env?: EnvLike;
  /** The request bead's id. */
  request: string | null;
  /** `--session`, else CLAUDE_CODE_SESSION_ID; optional here. */
  sessionId: string | null;
  stages: string[];
  /** `--unset`: remove these stages instead of adding them. */
  unset: boolean;
}

export type ThreadStageOutcome =
  | {
      db: string;
      id: string;
      kind: 'marked';
      ladder: readonly string[];
      /** The request's stage labels after the change, ladder order. */
      now: string[];
      reached: {next: string | null; reached: string} | null;
      title: string;
      unset: boolean;
    }
  | {id: string; kind: 'notFound'; problems: string[]; searched: string[]}
  | {id: string; kind: 'notRequest'; title: string}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'unknownStage'; ladder: readonly string[]; names: string[]}
  | {kind: 'usage'; message: string};

/** Where to look for the request: the session's DBs, then the cwd's. */
function placesToLook(
  cwd: string,
  env: EnvLike,
  sessionIdOption: string | null,
): {places: string[]; problems: string[]} {
  const places: string[] = [];
  const problems: string[] = [];
  const session = sessionIdFrom(sessionIdOption, env);
  if (session.ok) {
    const read = readSessionSightings(session.id, env);
    if (read.kind === 'failed') {
      problems.push(
        `the sessions index is unreadable: ${read.path}: ${read.error}`,
      );
    } else if (read.kind === 'read') {
      for (const sighting of read.sightings) {
        const db = findBeadsDb(sighting.beadsDir);
        if (db.kind === 'found') places.push(db.db);
        else problems.push(`could not use ${sighting.beadsDir}: ${db.reason}`);
      }
    }
  }
  const workspace = findBeadsWorkspace(cwd);
  if (workspace.kind === 'found') places.push(workspace.db);
  return {places: [...new Set(places)], problems};
}

/** The decision half: validates, writes the labels, prints nothing. */
export async function markStage(
  options: ThreadStageOptions,
): Promise<ThreadStageOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const id = options.request?.trim() ?? '';
  const names = [
    ...new Set(
      options.stages.map((name) => name.trim()).filter((name) => name !== ''),
    ),
  ];
  if (id === '' || names.length === 0) {
    return {
      kind: 'usage',
      message: `give a request and at least one stage: ${sdkRun('thread stage <request id> <stage>… [--unset]')}`,
    };
  }

  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};

  const {resolveThreadConfig} = await import('./config');
  const ladder = resolveThreadConfig({cwd, env}).stages;
  const unknown = names.filter((name) => !ladder.includes(name));
  if (unknown.length > 0) return {kind: 'unknownStage', ladder, names: unknown};

  const {places, problems} = placesToLook(cwd, env, options.sessionId);
  if (places.length === 0) {
    return {
      kind: 'failed',
      reason:
        problems[0] ??
        'no beads DB to look in: this session has none recorded and the current directory has no beads workspace',
    };
  }
  for (const db of places) {
    const target: BrTarget = {db, env};
    const shown = brShow(target, id);
    if (shown.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `could not look up ${id} in ${db}: ${describeBrFailed(shown)}`,
      };
    }
    if (shown.kind === 'notFound') continue;
    const {issue} = shown;
    if (!issue.labels.includes(REQUEST_LABEL)) {
      return {id, kind: 'notRequest', title: issue.title};
    }
    const labels = names.map((name) => `${STAGE_LABEL_PREFIX}${name}`);
    const written = brUpdate(
      target,
      id,
      options.unset ? {removeLabels: labels} : {addLabels: labels},
    );
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `br update failed, no stage was ${options.unset ? 'removed' : 'marked'}: ${describeBrFailed(written)}`,
      };
    }
    const after = new Set(issue.labels);
    for (const label of labels) {
      if (options.unset) after.delete(label);
      else after.add(label);
    }
    const now = ladder.filter((name) =>
      after.has(`${STAGE_LABEL_PREFIX}${name}`),
    );
    return {
      db,
      id,
      kind: 'marked',
      ladder,
      now,
      reached: stageReached([...after], ladder),
      title: issue.title,
      unset: options.unset,
    };
  }
  return {id, kind: 'notFound', problems, searched: places};
}

export function describeStageOutcome(outcome: ThreadStageOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'marked': {
      const reached =
        outcome.reached == null
          ? 'Stage reached: none marked'
          : `Stage reached: ${outcome.reached.reached}${outcome.reached.next == null ? ' (the last stage)' : ` (next: ${outcome.reached.next})`}`;
      return {
        exitCode: 0,
        lines: [
          `Request ${outcome.id} ("${outcome.title}")`,
          `Stages marked: ${outcome.now.length === 0 ? 'none' : outcome.now.join(', ')}`,
          reached,
        ],
      };
    }
    case 'unknownStage':
      return {
        exitCode: 2,
        lines: [
          `thread stage: ${outcome.names.map((name) => JSON.stringify(name)).join(', ')} ${outcome.names.length === 1 ? 'is' : 'are'} not on the stage ladder. The ladder (componentConfig.thread.stages), in order: ${outcome.ladder.join(', ')}`,
        ],
      };
    case 'notRequest':
      return {
        exitCode: 2,
        lines: [
          `thread stage: ${outcome.id} ("${outcome.title}") is not a request (it has no \`${REQUEST_LABEL}\` label). Adopt it first: ${sdkRun(`thread request --bead ${outcome.id}`)}`,
        ],
      };
    case 'notFound':
      return {
        exitCode: 1,
        lines: [
          `thread stage: ${outcome.id} was not found in ${outcome.searched.join(' or ')}.`,
          ...outcome.problems.map((problem) => `  ⚠️ also: ${problem}`),
        ],
      };
    case 'disabled':
    case 'failed':
      return {exitCode: 1, lines: [`thread stage: ${outcome.reason}`]};
    case 'usage':
      return {exitCode: 2, lines: [`thread stage: ${outcome.message}`]};
  }
}

/** `thread stage`: mark, print, return the exit code. */
export async function runThreadStage(
  options: ThreadStageOptions,
): Promise<number> {
  const {exitCode, lines} = describeStageOutcome(await markStage(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
