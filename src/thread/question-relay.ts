/**
 * `thread answer --ask <BD n | bead id> --relay "<answer>"` (home-base-l2ejg.6;
 * D8 in home-base-l2ejg.3): answer a question of ANY session, in ANY repo, at
 * its source. The mayor links to other projects' questions instead of copying
 * them into home-base, so an answer has to reach the one copy that exists.
 *
 * WHERE THE QUESTION IS
 * - `BD<n>`: every export the sessions index knows is read for the label
 *   `qid:<n>` (locateQuestionId, which the D2 refusal uses too). Only D2's form
 *   counts: an old per-chain id names different questions in different chains,
 *   so it is never relayed. Exactly one question must hold it, and every export
 *   must have been read: an export that could not be read may hold a second.
 * - A bead id, and the one bead a `BD<n>` named: its SOURCE database is looked
 *   for in three steps, and the first step that holds it decides.
 *     1. `session`: the database of the session it was filed under (a question
 *        is a dot-child of its session bead; the index records that bead's
 *        `.beads/`). Measured 2026-11-14: each of the 244 recorded sessions
 *        resolves to exactly one database.
 *     2. `repo`: the PRIMARY checkout's database of every repo whose session
 *        beads share its prefix (`home-base-` for `home-base-l2ejg.6`).
 *     3. `worktree`: that repo's worktree databases. Measured 2026-11-14: the
 *        `home-base` prefix resolves to 7 databases, the primary and 6 worktree
 *        copies, which is why the primary is asked first.
 *   A step that finds the bead in two databases, or cannot read one of its
 *   databases, refuses: the bead could be in either, and a guess could put the
 *   answer where no session reads it.
 *
 * BEFORE THE WRITE the question is read again at its source, last thing, and
 * refused when it is closed (answered elsewhere since, or by Claude), gone, not
 * a question, or no longer holds the id that was typed. The dashboard's `i`
 * does the same (src/threads-dash/answer.ts recordAnswer).
 *
 * THE WRITE is `brClose` on that database, which runs through callBr: br runs
 * with its working directory at that checkout, so mise picks the br THAT repo
 * pins, and a database on a schema newer than that br writes is refused.
 *
 * Every refusal writes nothing and says why (critical rule 7: a read that
 * failed is never "not there"). Nothing here throws on a br failure.
 */

import type {BrIssue} from '../beads/br';
import type {EnvLike} from './paths';

import {statSync} from 'fs';
import {dirname} from 'path';

import {
  brClose,
  brShow,
  describeBrFailed,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {QUESTION_BEAD_TYPE} from './ask-format';
import {
  locatedWords,
  locateQuestionId,
  repoOfBeadsDir,
} from './question-id-locate';
import {parseShortId, questionIdOf, shortIdText} from './question-ids';
import {readSessionIndex} from './session-index';

/** Which step of the lookup found the source (see the header). */
export type RelayStep = 'repo' | 'session' | 'worktree';

/** A database that may hold the bead, and the repo it belongs to. */
interface Candidate {
  db: string;
  repo: string;
}

export type RelayOutcome =
  | {
      /** The source database written. */
      db: string;
      id: string;
      kind: 'relayed';
      /** The close reason written. */
      reason: string;
      repo: string;
      /** The bead it was filed under, or null for a bead not under one. */
      session: {id: string; title: null | string} | null;
      /** Its `BD<n>`, or null when it has no D2 id. */
      shortId: null | string;
      /** The session ids its `sid:` labels name. */
      sids: string[];
      step: RelayStep;
      title: string;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'refused'; reason: string};

const SID_PREFIX = 'sid:';

/** `home-base` for `home-base-l2ejg.6`; null when the id has no prefix. */
export function beadIdPrefix(id: string): null | string {
  const at = id.lastIndexOf('-');
  return at <= 0 ? null : id.slice(0, at);
}

/** The bead `id` is a dot-child of, or null: `t-abc` for `t-abc.3`. */
function parentOf(id: string): null | string {
  const at = id.lastIndexOf('.');
  return at <= 0 ? null : id.slice(0, at);
}

/** Is `checkout` a primary checkout (its `.git` is a directory)? */
function primaryCheckout(checkout: string): boolean | {reason: string} {
  try {
    return statSync(`${checkout}/.git`).isDirectory();
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    return {
      reason: `whether ${checkout} is a primary checkout could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The databases of each step, and the dirs that could not be resolved. */
interface Steps {
  repo: {candidates: Candidate[]; unresolved: string[]};
  session: {candidates: Candidate[]; unresolved: string[]};
  worktree: {candidates: Candidate[]; unresolved: string[]};
}

type StepsRead =
  | {kind: 'read'; steps: Steps}
  | {kind: 'refused'; reason: string};

function addCandidate(list: Candidate[], candidate: Candidate): void {
  if (!list.some((known) => known.db === candidate.db)) list.push(candidate);
}

/** Every database the sessions index can name for `id`, by step. */
function stepsFor(id: string, env: EnvLike): StepsRead {
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'refused',
      reason: `the sessions index ${index.path} could not be read, so where ${id} lives is unknown: ${index.error}`,
    };
  }
  const steps: Steps = {
    repo: {candidates: [], unresolved: []},
    session: {candidates: [], unresolved: []},
    worktree: {candidates: [], unresolved: []},
  };
  if (index.kind === 'missing') return {kind: 'read', steps};
  const prefix = beadIdPrefix(id);
  for (const session of index.sessions) {
    for (const sighting of session.sightings) {
      const ownSession =
        id === sighting.beadId || id.startsWith(`${sighting.beadId}.`);
      const samePrefix =
        prefix != null && beadIdPrefix(sighting.beadId) === prefix;
      if (!ownSession && !samePrefix) continue;
      const resolved = resolveRecordedBeadsDb(sighting.beadsDir);
      // A recorded dir with no database now (a gone worktree): it holds
      // nothing, the measured absence holders.ts and the counter skip too.
      if (resolved.kind === 'none') continue;
      const step: keyof Steps = ownSession ? 'session' : 'repo';
      if (resolved.kind === 'failed') {
        steps[step].unresolved.push(`${sighting.beadsDir}: ${resolved.reason}`);
        continue;
      }
      const candidate: Candidate = {
        db: resolved.db,
        repo: repoOfBeadsDir(resolved.beadsDir, sighting.repo),
      };
      if (ownSession) {
        addCandidate(steps.session.candidates, candidate);
        continue;
      }
      const primary = primaryCheckout(dirname(dirname(resolved.db)));
      if (primary === true) addCandidate(steps.repo.candidates, candidate);
      else if (primary === false) {
        addCandidate(steps.worktree.candidates, candidate);
      } else steps.repo.unresolved.push(primary.reason);
    }
  }
  // A database already asked in an earlier step is not asked again.
  const asked = new Set(steps.session.candidates.map((c) => c.db));
  steps.repo.candidates = steps.repo.candidates.filter((c) => !asked.has(c.db));
  for (const c of steps.repo.candidates) asked.add(c.db);
  steps.worktree.candidates = steps.worktree.candidates.filter(
    (c) => !asked.has(c.db),
  );
  return {kind: 'read', steps};
}

/** Each step's databases, in words. */
const WHERE: Record<RelayStep, string> = {
  repo: 'the primary checkouts of the repos that use its prefix',
  session: 'the database of the session it was filed under',
  worktree: 'the worktrees of the repos that use its prefix',
};

type StepLookup =
  | {candidate: Candidate; issue: BrIssue; kind: 'one'}
  | {kind: 'none'; searched: string[]}
  | {kind: 'refused'; reason: string};

/** Ask every database of one step for `id`. */
function lookInStep(
  id: string,
  step: RelayStep,
  databases: Steps[RelayStep],
  env: EnvLike,
): StepLookup {
  const hits: {candidate: Candidate; issue: BrIssue}[] = [];
  const failures = [...databases.unresolved];
  for (const candidate of databases.candidates) {
    const shown = brShow({db: candidate.db, env}, id);
    if (shown.kind === 'ok') hits.push({candidate, issue: shown.issue});
    else if (shown.kind === 'failed') {
      failures.push(`${candidate.db}: ${describeBrFailed(shown)}`);
    }
  }
  const where = WHERE[step];
  if (failures.length > 0) {
    return {
      kind: 'refused',
      reason: `${id} was looked for in ${where}, and ${failures.length === 1 ? 'one database' : `${failures.length} databases`} could not be read, so it may be there${hits.length > 0 ? ` as well as in ${hits.map((hit) => hit.candidate.db).join(', ')}` : ''}: ${failures.join('; ')}`,
    };
  }
  const [only] = hits;
  if (only != null && hits.length === 1) {
    return {candidate: only.candidate, issue: only.issue, kind: 'one'};
  }
  if (hits.length > 1) {
    return {
      kind: 'refused',
      reason: `${id} is in ${hits.length} databases of ${where}, so which one is its source cannot be told: ${hits.map((hit) => `${hit.candidate.db} (${hit.candidate.repo}, ${hit.issue.status})`).join('; ')}`,
    };
  }
  return {
    kind: 'none',
    searched: databases.candidates.map((candidate) => candidate.db),
  };
}

type SourceLookup =
  | {candidate: Candidate; issue: BrIssue; kind: 'found'; step: RelayStep}
  | {kind: 'refused'; reason: string};

/** The one database that is `id`'s source, by the steps of the header. */
export function locateRelaySource(id: string, env: EnvLike): SourceLookup {
  const read = stepsFor(id, env);
  if (read.kind === 'refused') return read;
  const searched: string[] = [];
  for (const step of ['session', 'repo', 'worktree'] as const) {
    const looked = lookInStep(id, step, read.steps[step], env);
    if (looked.kind === 'refused') return looked;
    if (looked.kind === 'one') {
      return {
        candidate: looked.candidate,
        issue: looked.issue,
        kind: 'found',
        step,
      };
    }
    searched.push(...looked.searched);
  }
  const prefix = beadIdPrefix(id);
  return {
    kind: 'refused',
    reason:
      searched.length === 0
        ? `no known repo holds ${id}: no session the index records was filed under it${prefix == null ? '' : `, and no repo with a recorded session uses the prefix ${prefix}-`}`
        : `${id} is not in any database that could hold it (${searched.join(', ')})`,
  };
}

/** The one bead `BD<number>` names, in every known export, or why not. */
function beadOfShortId(
  number: number,
  env: EnvLike,
): {id: string; kind: 'one'} | {kind: 'refused'; reason: string} {
  const text = shortIdText(number);
  let located: ReturnType<typeof locateQuestionId>;
  try {
    located = locateQuestionId({env, number});
  } catch (error) {
    return {
      kind: 'refused',
      reason: `where ${text} lives could not be looked up: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (located.problems.length > 0) {
    return {
      kind: 'refused',
      reason: `${text} could not be looked up in every repo, so a second question may hold it: ${located.problems.join('; ')}. Answer it by its bead id`,
    };
  }
  const machine = located.found.filter((entry) => entry.form === 'machine');
  const old = located.found.filter((entry) => entry.form === 'chain');
  const [only] = machine;
  if (only != null && machine.length === 1) return {id: only.id, kind: 'one'};
  if (machine.length > 1) {
    return {
      kind: 'refused',
      reason: `${text} is held by ${machine.length} questions: ${machine.map(locatedWords).join('; ')}. Which one did you mean? Answer it by its bead id`,
    };
  }
  const oldWords =
    old.length === 0
      ? ''
      : ` ${old.length === 1 ? 'One question holds' : `${old.length} questions hold`} it as an old per-chain id, which names different questions in different chains and is never relayed: ${old.map(locatedWords).join('; ')}.`;
  return {
    kind: 'refused',
    reason: `no question in any known repo's export holds ${text}.${oldWords} An export can trail its database by a moment after a question is filed. Which question did you mean? Answer it by its bead id`,
  };
}

/** Why the fresh read must not be answered, or null when it may be. */
function freshRefusal(
  issue: BrIssue,
  shortNumber: null | number,
  db: string,
): null | string {
  if (issue.issueType !== QUESTION_BEAD_TYPE) {
    return `${issue.id} is a ${issue.issueType}, not a question`;
  }
  if (issue.status === 'closed') {
    return `${issue.id} is already closed at its source (${issue.closeReason ?? 'no reason recorded'})`;
  }
  if (issue.status === 'tombstone') {
    return `${issue.id} is deleted at its source (tombstone)`;
  }
  if (shortNumber != null) {
    const read = questionIdOf(issue.labels);
    if (read.kind !== 'one' || read.number !== shortNumber) {
      return `${issue.id} no longer holds ${shortIdText(shortNumber)} in ${db} (${read.kind === 'one' ? `it holds ${shortIdText(read.number)}` : read.kind === 'bad' ? read.reason : 'it has no id'}), though its export did`;
    }
  }
  return null;
}

/**
 * Answer `ask` (a `BD<n>` or a bead id) at its source with the close reason
 * `reason`. The whole relay; refusals write nothing.
 */
export function relayAnswer(input: {
  ask: string;
  env: EnvLike;
  reason: string;
}): RelayOutcome {
  const {env, reason} = input;
  const ask = input.ask.trim();
  const shortNumber = parseShortId(ask);
  let id = ask;
  if (shortNumber != null) {
    const named = beadOfShortId(shortNumber, env);
    if (named.kind === 'refused') {
      return {
        kind: 'refused',
        reason: `${named.reason}. Nothing was recorded.`,
      };
    }
    id = named.id;
  }
  const source = locateRelaySource(id, env);
  if (source.kind === 'refused') {
    return {kind: 'refused', reason: `${source.reason}. Nothing was recorded.`};
  }
  const {candidate, step} = source;
  const target = {db: candidate.db, env};

  // The session it was filed under, for the reader; read before the fresh
  // read so that one is the last thing before the write.
  const parentId = parentOf(id);
  let session: {id: string; title: null | string} | null = null;
  if (parentId != null) {
    const parent = brShow(target, parentId);
    session = {
      id: parentId,
      title: parent.kind === 'ok' ? parent.issue.title : null,
    };
  }

  // The fresh read at the source, right before the write.
  const fresh = brShow(target, id);
  if (fresh.kind === 'failed') {
    return {
      kind: 'refused',
      reason: `${id} could not be read again in ${candidate.db} just before writing: ${describeBrFailed(fresh)}. Nothing was recorded.`,
    };
  }
  if (fresh.kind === 'notFound') {
    return {
      kind: 'refused',
      reason: `${id} is no longer in ${candidate.db}. Nothing was recorded.`,
    };
  }
  const refusal = freshRefusal(fresh.issue, shortNumber, candidate.db);
  if (refusal != null) {
    return {kind: 'refused', reason: `${refusal}. Nothing was recorded.`};
  }
  const closed = brClose(target, id, reason);
  if (closed.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${id} was NOT recorded in ${candidate.repo} (${candidate.db}): ${describeBrFailed(closed)}`,
    };
  }
  const read = questionIdOf(fresh.issue.labels);
  return {
    db: candidate.db,
    id,
    kind: 'relayed',
    reason,
    repo: candidate.repo,
    session,
    shortId: read.kind === 'one' ? shortIdText(read.number) : null,
    sids: fresh.issue.labels
      .filter((label) => label.startsWith(SID_PREFIX))
      .map((label) => label.slice(SID_PREFIX.length)),
    step,
    title: fresh.issue.title,
  };
}

/** The lines a relay prints. */
export function relayedLines(
  outcome: Extract<RelayOutcome, {kind: 'relayed'}>,
): string[] {
  const session =
    outcome.session == null
      ? outcome.sids.length > 0
        ? `not filed under a session bead; its session${outcome.sids.length === 1 ? '' : 's'}: ${outcome.sids.join(', ')}`
        : 'not filed under a session bead, and no session recorded on it'
      : `${outcome.session.id} ${outcome.session.title == null ? '(its title could not be read)' : `"${outcome.session.title}"`}`;
  return [
    `✓ ${outcome.id}${outcome.shortId == null ? '' : ` [${outcome.shortId}]`} recorded at its source: ${outcome.reason}`,
    `  Question: ${outcome.title}`,
    `  Repo:     ${outcome.repo} (${outcome.db})`,
    `  Session:  ${session}`,
  ];
}
