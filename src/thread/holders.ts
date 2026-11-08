/**
 * `thread holders <bead>` (home-base-5uu56.2.3): which sessions already hold a
 * bead, in any repo, and how far each got. READ-ONLY: it writes nothing.
 *
 * Built after 2026-11-08, when a session asked Justin to start a session to
 * build bac-fn0a, which a browser-automation-central session had built and
 * merged on 2026-11-03. The bead said so the whole time: a `sid:` label naming
 * that session, `stage:tested`, and "MERGED" in its notes. Nothing made a
 * session look.
 *
 * The bead is looked up in `--db` when given, else the current directory's
 * beads, else every DB the sessions index names (a session anywhere may have
 * filed or adopted it). Each `sid:` label is one holder; its status is the
 * same derived status the inbox shows (deriveStatus over loadSession).
 *
 * A DB that could not be read while the bead was not found elsewhere makes the
 * answer `failed`, never `notFound` (critical rule 7): the bead may be in it.
 */

import type {EnvLike} from './paths';
import type {SessionStatus} from './session-status';

import {
  brShow,
  describeBrFailed,
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {writeStdout} from '../write-stdout';
import {
  REQUEST_LABEL,
  SID_LABEL_PREFIX,
  STAGE_LABEL_PREFIX,
} from './session-bead';
import {whereWords} from './session-card';
import {readSessionIndex} from './session-index';
import {loadSession} from './session-model';
import {deriveStatus, statusFactsOf} from './session-status';

export interface Holder {
  /** Null when the session could not be loaded; `problem` says why. */
  problem: string | null;
  sessionBeadId: string | null;
  sessionId: string;
  status: SessionStatus | null;
  /** True when this holder is the session running the command. */
  thisSession: boolean;
  title: string | null;
}

export interface HeldBead {
  db: string;
  id: string;
  isRequest: boolean;
  notesFirstLine: string | null;
  stages: string[];
  status: string;
  title: string;
}

export type HoldersOutcome =
  | {bead: HeldBead; holders: Holder[]; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; searched: string[]};

/** The DBs to look in, in order, without repeats. */
function candidateDbs(input: {cwd: string; db: string | null; env: EnvLike}): {
  dbs: string[];
  problems: string[];
} {
  if (input.db != null) return {dbs: [input.db], problems: []};
  const dbs: string[] = [];
  const problems: string[] = [];
  const add = (db: string): void => {
    if (!dbs.includes(db)) dbs.push(db);
  };
  const here = findBeadsWorkspace(input.cwd);
  if (here.kind === 'found') add(here.db);
  if (here.kind === 'failed') problems.push(`${input.cwd}: ${here.reason}`);
  const index = readSessionIndex(input.env);
  if (index.kind === 'failed') {
    problems.push(`the sessions index ${index.path}: ${index.error}`);
  }
  if (index.kind === 'read') {
    const dirs = new Set(
      index.sessions.flatMap((session) =>
        session.sightings.map((sighting) => sighting.beadsDir),
      ),
    );
    for (const dir of dirs) {
      const resolved = resolveRecordedBeadsDb(dir);
      if (resolved.kind === 'found') add(resolved.db);
      // A recorded directory that is gone holds nothing to find: `none` is a
      // measured absence, `failed` is not.
      if (resolved.kind === 'failed')
        problems.push(`${dir}: ${resolved.reason}`);
    }
  }
  return {dbs, problems};
}

export async function findHolders(input: {
  beadId: string;
  cwd: string;
  db: string | null;
  env: EnvLike;
  now?: Date;
}): Promise<HoldersOutcome> {
  const {beadId, cwd, env} = input;
  const {dbs, problems} = candidateDbs(input);
  let found: {
    db: string;
    issue: {
      labels: string[];
      notes: string | null;
      status: string;
      title: string;
    };
  } | null = null;
  for (const db of dbs) {
    const shown = brShow({db, env}, beadId);
    if (shown.kind === 'ok') {
      found = {db, issue: shown.issue};
      break;
    }
    if (shown.kind !== 'notFound') {
      problems.push(`${db}: ${describeBrFailed(shown)}`);
    }
  }
  if (found == null) {
    return problems.length > 0
      ? {
          kind: 'failed',
          reason: `${beadId} was not found, and these could not be read, so it may be in one of them: ${problems.join('; ')}`,
        }
      : {kind: 'notFound', searched: dbs};
  }

  const {labels} = found.issue;
  const now = input.now ?? new Date();
  const me = env.CLAUDE_CODE_SESSION_ID ?? null;
  const holders: Holder[] = [];
  for (const sessionId of labels
    .filter((label) => label.startsWith(SID_LABEL_PREFIX))
    .map((label) => label.slice(SID_LABEL_PREFIX.length))) {
    const loaded = await loadSession({
      cwd,
      env,
      selector: sessionId,
      sessionIdOption: null,
    });
    if (loaded.kind !== 'loaded') {
      holders.push({
        problem: loaded.kind === 'noSession' ? loaded.reason : loaded.detail,
        sessionBeadId: null,
        sessionId,
        status: null,
        thisSession: sessionId === me,
        title: null,
      });
      continue;
    }
    const {model} = loaded;
    holders.push({
      problem: null,
      sessionBeadId: model.sessionBeadId,
      sessionId,
      status: deriveStatus(statusFactsOf(model), {asIfYielded: false, now}),
      thisSession: sessionId === me,
      title: model.beads.session?.title ?? null,
    });
  }

  const notesFirstLine =
    found.issue.notes
      ?.split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null;
  return {
    bead: {
      db: found.db,
      id: beadId,
      isRequest: labels.includes(REQUEST_LABEL),
      notesFirstLine,
      stages: labels
        .filter((label) => label.startsWith(STAGE_LABEL_PREFIX))
        .map((label) => label.slice(STAGE_LABEL_PREFIX.length)),
      status: found.issue.status,
      title: found.issue.title,
    },
    holders,
    kind: 'found',
  };
}

/** The lines the command prints, and its exit code. */
export function describeHolders(outcome: HoldersOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  if (outcome.kind === 'failed') {
    return {exitCode: 1, lines: [`thread holders: ${outcome.reason}`]};
  }
  if (outcome.kind === 'notFound') {
    return {
      exitCode: 2,
      lines: [
        `thread holders: not found in ${outcome.searched.length > 0 ? outcome.searched.join(', ') : 'any beads DB (none to search)'}`,
      ],
    };
  }
  const {bead, holders} = outcome;
  const lines = [
    `${bead.id} · ${bead.title}`,
    '',
    `  status:   ${bead.status}${bead.isRequest ? ' (a request)' : ''}`,
    `  stages:   ${bead.stages.length > 0 ? bead.stages.join(', ') : 'none marked'}`,
    ...(bead.notesFirstLine == null
      ? []
      : [`  notes:    ${bead.notesFirstLine}`]),
    `  in:       ${bead.db}`,
    '',
  ];
  if (holders.length === 0) {
    lines.push('No session holds it: it has no sid: label.');
    return {exitCode: 0, lines};
  }
  lines.push(
    `Held by ${holders.length} ${holders.length === 1 ? 'session' : 'sessions'}:`,
  );
  for (const holder of holders) {
    lines.push('');
    lines.push(
      `  ${holder.sessionBeadId ?? '(session bead unknown)'} · ${holder.title ?? '(title unknown)'}${holder.thisSession ? '  ← this session' : ''}`,
    );
    lines.push(
      `    status:   ${holder.status != null ? whereWords(holder.status) : `unknown (${holder.problem ?? 'not loaded'})`}`,
    );
    lines.push(`    resume:   claude --resume ${holder.sessionId}`);
  }
  return {exitCode: 0, lines};
}

export async function runThreadHolders(input: {
  beadId: string;
  db: string | null;
}): Promise<number> {
  const outcome = await findHolders({
    beadId: input.beadId,
    cwd: process.cwd(),
    db: input.db,
    env: process.env,
  });
  const {exitCode, lines} = describeHolders(outcome);
  await writeStdout(`${lines.join('\n')}\n`);
  return exitCode;
}
