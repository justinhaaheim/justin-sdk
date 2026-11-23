/**
 * `thread status` What to mark: an open question of this session whose named
 * work has moved since the question was filed (home-base-5uu56.2.5). Advisory,
 * for Claude: READ-ONLY, it changes and closes nothing.
 *
 * Built after 2026-11-08, when session home-base-2ignt restated a P0 question
 * asking Justin to start a session to build bac-fn0a. Another session had
 * built and merged it five days earlier, and the bead said so (stage:code-done,
 * stage:tested, notes MERGED). `thread holders` is the manual check; this is
 * the automatic one, at the moment Claude is about to yield.
 *
 * S1, which beads a question names: the targets of its `to:` labels (`to:` +
 * the id with each `.` written as `:`, session-bead.ts toLabel), and every
 * bead id in its title and description (the description holds its context,
 * options and default, ask-format.ts). A text id counts only when its prefix
 * is a known beads prefix: that of a beads DB the sessions index names, read
 * from the bead ids it recorded there. Ids are found with spawn-holders.ts's
 * `beadIdsIn`, and each prefix's DB is opened with `resolveRecordedBeadsDb`,
 * the one way every reader of an index `beadsDir` opens a DB (as holders.ts
 * does). The question itself and its parent session bead are not targets.
 *
 * S2, what "moved" means (measured 2026-11-21 on home-base's export, all 230
 * open questions): closed after the question's created time, OR still open
 * with a `stage:` label and updated after it. "Updated after" alone hit 106 of
 * 230, routine label writes, and was rejected as noise.
 *
 * S4 (critical rule 7): a named bead that cannot be read (its DB unreadable or
 * busy, the id not found, a time that cannot be parsed) is never "not moved".
 * It is one "could not check" line, once for all such ids.
 *
 * S5: one br call per database (`brShowMany`), whatever the number of ids; a
 * missing id costs one more call (br names only the first missing id).
 */

import type {BrShowManyOutcome, RecordedBeadsDb} from '../beads/br';
import type {EnvLike} from './paths';
import type {SessionIndexRead} from './session-index';
import type {TreeIssue} from './session-tree';

import {
  brShowMany,
  describeBrFailed,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {parseInstant} from './answer-store';
import {questionIdOf, shortIdText} from './question-ids';
import {STAGE_LABEL_PREFIX, TO_LABEL_PREFIX} from './session-bead';
import {readSessionIndex} from './session-index';
import {beadIdsIn, prefixOfBeadId} from './spawn-holders';

/** One named bead that moved after the question was filed (S2). */
export interface MovedBead {
  /** When it closed (`closed`) or was last updated (`staged`), in ms. */
  at: number;
  how: 'closed' | 'staged';
  id: string;
  /** Its `stage:` names, for `staged`. */
  stages: string[];
}

export interface MovedQuestion {
  /** The question's created time, in ms. */
  filedAt: number;
  moved: MovedBead[];
  question: TreeIssue;
}

/** A named bead, or a question, that could not be checked (S4). */
export interface UncheckedNamed {
  /** The question ids (Q188, or the bead id) that name it. */
  namedBy: string[];
  reason: string;
  /** The bead id, or the question's own id when its filed time is unreadable. */
  what: string;
}

export interface QuestionMoves {
  moved: MovedQuestion[];
  unchecked: UncheckedNamed[];
}

/** The readers, injectable for tests; the real ones by default. */
export interface QuestionMoveReaders {
  readIndex: () => SessionIndexRead;
  resolveDb: (beadsDir: string) => RecordedBeadsDb;
  showMany: (db: string, ids: readonly string[]) => BrShowManyOutcome;
}

export function realQuestionMoveReaders(env: EnvLike): QuestionMoveReaders {
  return {
    readIndex: () => readSessionIndex(env),
    resolveDb: resolveRecordedBeadsDb,
    showMany: (db, ids) => brShowMany({db, env}, ids),
  };
}

/** `to:home-base-kwand:19` → `home-base-kwand.19` (toLabel, read back). */
export function toTargetOf(label: string): string | null {
  if (!label.startsWith(TO_LABEL_PREFIX)) return null;
  const id = label.slice(TO_LABEL_PREFIX.length).replaceAll(':', '.');
  return id === '' ? null : id;
}

/** What the report calls a question: its Q id, else its bead id. */
export function questionName(question: TreeIssue): string {
  const read = questionIdOf(question.labels);
  return read.kind === 'one' ? shortIdText(read.number) : question.id;
}

/**
 * Each known prefix and the index `beadsDir`s recorded for it, in the order
 * they are tried: this session's own directories first, then primary
 * checkouts, then worktrees. The prefix of a directory is the prefix of the
 * bead ids the index recorded there.
 */
export function prefixDirsOf(
  index: Extract<SessionIndexRead, {kind: 'read'}>,
  ownDirs: readonly string[],
): Map<string, string[]> {
  const byPrefix = new Map<string, Set<string>>();
  for (const session of index.sessions) {
    for (const sighting of session.sightings) {
      const prefix = prefixOfBeadId(sighting.beadId);
      if (prefix == null) continue;
      const dirs = byPrefix.get(prefix) ?? new Set<string>();
      dirs.add(sighting.beadsDir);
      byPrefix.set(prefix, dirs);
    }
  }
  const own = new Set(ownDirs);
  const rank = (dir: string): number => {
    if (own.has(dir)) return 0;
    return dir.includes('/.claude/worktrees/') ? 2 : 1;
  };
  const ordered = new Map<string, string[]>();
  for (const [prefix, dirs] of byPrefix) {
    ordered.set(
      prefix,
      [...dirs].sort((a, b) =>
        rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b),
      ),
    );
  }
  return ordered;
}

/**
 * S1: the beads `question` names, in order of first mention, without the
 * question itself and its parent session bead. `to:` targets are kept whatever
 * their prefix (they are beads by construction); text ids only with a known
 * prefix.
 */
export function beadsNamedBy(
  question: TreeIssue,
  knownPrefixes: Iterable<string>,
  notTargets: ReadonlySet<string>,
): string[] {
  const named: string[] = [];
  for (const label of question.labels) {
    const target = toTargetOf(label);
    if (target != null) named.push(target);
  }
  const text = `${question.title}\n${question.description ?? ''}`;
  for (const prefix of knownPrefixes) named.push(...beadIdsIn(text, prefix));
  const skip = new Set([question.id, ...question.parentIds, ...notTargets]);
  return [...new Set(named)].filter((id) => !skip.has(id));
}

/** The DB for one prefix: the first of its directories that resolves to one. */
function dbForPrefix(
  dirs: readonly string[],
  resolveDb: QuestionMoveReaders['resolveDb'],
): {db: string; ok: true} | {ok: false; reason: string} {
  const problems: string[] = [];
  for (const dir of dirs) {
    const resolved = resolveDb(dir);
    if (resolved.kind === 'found') return {db: resolved.db, ok: true};
    problems.push(`${dir}: ${resolved.reason}`);
  }
  return {
    ok: false,
    reason: `no beads DB for it could be opened (${problems.join('; ')})`,
  };
}

/** S2: has `bead` moved after `filedAt`? Null: no; a string: why it cannot be told. */
function movedAfter(
  bead: {
    closedAt: string | null;
    id: string;
    labels: string[];
    status: string;
    updatedAt: string | null;
  },
  filedAt: number,
): MovedBead | null | string {
  if (bead.status === 'closed') {
    const at = parseInstant(bead.closedAt);
    if (at == null) return 'it is closed, and its closed time cannot be read';
    return at > filedAt ? {at, how: 'closed', id: bead.id, stages: []} : null;
  }
  const stages = bead.labels
    .filter((label) => label.startsWith(STAGE_LABEL_PREFIX))
    .map((label) => label.slice(STAGE_LABEL_PREFIX.length));
  if (stages.length === 0) return null;
  const at = parseInstant(bead.updatedAt);
  if (at == null) return 'it has a stage, and its updated time cannot be read';
  return at > filedAt ? {at, how: 'staged', id: bead.id, stages} : null;
}

/**
 * The check: for each open question, the named beads that moved after it was
 * filed (S2), and every named bead that could not be checked (S4). Never
 * throws: a reader that throws is a "could not check" for what it was reading.
 */
export function checkQuestionMoves(input: {
  /** This session's own `.beads/` directories, tried first (model.sightings). */
  ownDirs: readonly string[];
  questions: readonly TreeIssue[];
  readers: QuestionMoveReaders;
  /** The session bead: never a target (S1). */
  sessionBeadId: string | null;
}): QuestionMoves {
  const {questions, readers} = input;
  const unchecked: UncheckedNamed[] = [];
  if (questions.length === 0) return {moved: [], unchecked};

  let index: SessionIndexRead;
  try {
    index = readers.readIndex();
  } catch (error) {
    index = {
      error: error instanceof Error ? error.message : String(error),
      kind: 'failed',
      path: '(the sessions index)',
    };
  }
  if (index.kind !== 'read') {
    // Without the index no prefix is known, so which text is a bead id cannot
    // be told: one line for every question, never silence.
    return {
      moved: [],
      unchecked: [
        {
          namedBy: questions.map(questionName),
          reason:
            index.kind === 'failed'
              ? `the sessions index ${index.path} could not be read: ${index.error}`
              : `there is no sessions index at ${index.path}, so no beads prefix is known`,
          what: 'the beads these questions name',
        },
      ],
    };
  }
  const prefixDirs = prefixDirsOf(index, input.ownDirs);
  const notTargets = new Set(
    input.sessionBeadId == null ? [] : [input.sessionBeadId],
  );

  // Every named id, with the questions that name it.
  const namedBy = new Map<string, string[]>();
  const perQuestion: {filedAt: number; ids: string[]; question: TreeIssue}[] =
    [];
  for (const question of questions) {
    const ids = beadsNamedBy(question, prefixDirs.keys(), notTargets);
    if (ids.length === 0) continue;
    const filedAt = parseInstant(question.createdAt);
    if (filedAt == null) {
      unchecked.push({
        namedBy: [questionName(question)],
        reason: 'its created time cannot be read',
        what: question.id,
      });
      continue;
    }
    perQuestion.push({filedAt, ids, question});
    for (const id of ids) {
      namedBy.set(id, [...(namedBy.get(id) ?? []), questionName(question)]);
    }
  }

  // Group the ids by DB: one br call per DB (S5).
  const byDb = new Map<string, string[]>();
  const dbOfPrefix = new Map<
    string,
    {db: string; ok: true} | {ok: false; reason: string}
  >();
  const failedIds = new Map<string, string>();
  for (const id of namedBy.keys()) {
    const prefix = prefixOfBeadId(id);
    const dirs = prefix == null ? undefined : prefixDirs.get(prefix);
    if (prefix == null || dirs == null) {
      failedIds.set(
        id,
        `no beads DB this Mac's sessions index knows has the prefix ${prefix ?? '(none)'}`,
      );
      continue;
    }
    let found = dbOfPrefix.get(prefix);
    if (found == null) {
      try {
        found = dbForPrefix(dirs, readers.resolveDb);
      } catch (error) {
        found = {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      dbOfPrefix.set(prefix, found);
    }
    if (!found.ok) {
      failedIds.set(id, found.reason);
      continue;
    }
    byDb.set(found.db, [...(byDb.get(found.db) ?? []), id]);
  }

  const read = new Map<string, Parameters<typeof movedAfter>[0]>();
  for (const [db, ids] of byDb) {
    let shown: BrShowManyOutcome;
    try {
      shown = readers.showMany(db, ids);
    } catch (error) {
      for (const id of ids) {
        failedIds.set(
          id,
          `${db} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (shown.kind === 'failed') {
      for (const id of ids) {
        failedIds.set(
          id,
          `${db} could not be read: ${describeBrFailed(shown)}`,
        );
      }
      continue;
    }
    for (const id of shown.notFound) failedIds.set(id, `not found in ${db}`);
    for (const issue of shown.issues) read.set(issue.id, issue);
  }

  const moved: MovedQuestion[] = [];
  for (const entry of perQuestion) {
    const movedBeads: MovedBead[] = [];
    for (const id of entry.ids) {
      const bead = read.get(id);
      if (bead == null) continue;
      const verdict = movedAfter(bead, entry.filedAt);
      if (typeof verdict === 'string') failedIds.set(id, verdict);
      else if (verdict != null) movedBeads.push(verdict);
    }
    if (movedBeads.length > 0) {
      moved.push({
        filedAt: entry.filedAt,
        moved: movedBeads,
        question: entry.question,
      });
    }
  }
  for (const [id, reason] of failedIds) {
    unchecked.push({namedBy: namedBy.get(id) ?? [], reason, what: id});
  }
  return {moved, unchecked};
}

/** A date as YYYY-MM-DD in `timeZone` (undefined: this machine's). */
function dayOf(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-CA', {timeZone});
}

/** What to mark: one line per moved question, then one could-not-check line. */
export function questionMoveMarks(
  moves: QuestionMoves | null | undefined,
  timeZone?: string,
): {code: string | null; sub: []; text: string}[] {
  if (moves == null) return [];
  const marks: {code: string | null; sub: []; text: string}[] = [];
  for (const entry of moves.moved) {
    const filed = dayOf(entry.filedAt, timeZone);
    const what = entry.moved
      .map((bead) =>
        bead.how === 'closed'
          ? `${bead.id}, closed ${dayOf(bead.at, timeZone)}`
          : `${bead.id}, open with stage ${bead.stages.join(', ')} and updated ${dayOf(bead.at, timeZone)}`,
      )
      .join('; ');
    marks.push({
      code: `br close ${entry.question.id} --reason "…"`,
      sub: [],
      text: `⚠️ ${questionName(entry.question)} ("${entry.question.title}") names ${what}, after the question was filed (${filed}). Check that the question still holds: if it does, restate it with thread ask; if not, close it:`,
    });
  }
  if (moves.unchecked.length > 0) {
    const parts = moves.unchecked.map(
      (item) =>
        `${item.what}${item.namedBy.length > 0 ? ` (named by ${item.namedBy.join(', ')})` : ''}: ${item.reason}`,
    );
    marks.push({
      code: null,
      sub: [],
      text: `⚠️ Could not check whether the work these open questions name has moved since they were filed: ${parts.join('; ')}.`,
    });
  }
  return marks;
}
