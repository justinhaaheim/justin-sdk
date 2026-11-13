/**
 * Shorter repeat status reports (home-base-1rxt0.4, design D2, D3 and D6 on
 * that bead): what is new or changed since the last report, and which
 * questions print on one line. Justin, 2026-11-12 (verbatim on
 * home-base-sg9q9.2): "some sort of clear visual indicator for new/changed
 * items", "P2+ are in full the first time", and "the first status report after
 * the new handoff should print everything in full".
 *
 * PURE: no filesystem, no clock. report-snapshots.ts reads the saved
 * snapshots and the transcript's turn boundary, and Part 1 (part-one.ts)
 * renders what this module decides.
 *
 * D6: the LAST REPORT is the newest snapshot saved at or before the end of
 * Claude's previous turn (the transcript's newest `turn_duration`). Every run
 * inside one turn therefore compares against the same snapshot, so running
 * `thread status` twice in a turn shows the same markers both times.
 *
 * Nothing here is ever a reassuring default (critical rule 7): with no last
 * report, or one that could not be read, nothing is marked AND every question
 * prints in full, and an unreadable one is said in Part 1.
 */

import type {AskBeadView} from './ask-render';

import {createHash} from 'crypto';

/** D2: a request or question new since the last report, or changed. */
export type ItemMark = 'changed' | 'new';

/** D2: before a request or question that is new since the last report. */
export const NEW_MARK = '🆕';

/** D2: before a request or question that changed since the last report. */
export const CHANGED_MARK = '🔄';

export function markEmoji(mark: ItemMark): string {
  return mark === 'new' ? NEW_MARK : CHANGED_MARK;
}

/**
 * One report's items: `r:<request id>` or `q:<question id>`, each to the
 * fingerprint of what the report showed for it.
 */
export type SnapshotItems = Record<string, string>;

/** What one `thread status` run showed, saved in local state (D6). */
export interface ReportSnapshot {
  at: string;
  items: SnapshotItems;
}

/**
 * The report this one is compared with. `first`: there is none (the first
 * report of a session, a successor's included). `unknown`: it could not be
 * established, and `reason` says why.
 */
export type ReportBaseline =
  | {kind: 'first'}
  | {kind: 'found'; snapshot: ReportSnapshot}
  | {kind: 'unknown'; reason: string};

/** What `thread status` hands Part 1. */
export interface ReportDelta {
  baseline: ReportBaseline;
  /**
   * D3: unchanged P2 to P4 questions may print on one line. False when the
   * knob `componentConfig.thread.compactQuestions` is off or `--full` was
   * given.
   */
  compact: boolean;
}

/** How Part 1 shows one question. */
export interface QuestionShown {
  compact: boolean;
  mark: ItemMark | null;
}

export function requestKey(id: string): string {
  return `r:${id}`;
}

export function questionKey(id: string): string {
  return `q:${id}`;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

/**
 * A question's content: its title, priority and description (the context,
 * options, header and default all live in the description). Never its number
 * in the list, which moves when another question is filed.
 */
export function questionFingerprint(question: AskBeadView): string {
  return digest([
    question.title,
    question.priority,
    question.description ?? null,
  ]);
}

/** What Part 1 shows for a request, without its number. */
export interface RequestShape {
  children: readonly {icon: string; id: string; title: string}[];
  icon: string;
  stage: string | null;
  title: string;
}

/**
 * A request's content as Part 1 shows it: title, icon (done, open, blocked),
 * stage and children. Not the "blocked on question N" words, whose number
 * moves when another question is filed; the 🛑 icon already says it.
 */
export function requestFingerprint(request: RequestShape): string {
  return digest([
    request.title,
    request.icon,
    request.stage,
    request.children.map((child) => [child.id, child.icon, child.title]),
  ]);
}

/** D2: new, changed, or neither. Nothing is marked without a last report. */
export function markOf(
  key: string,
  fingerprint: string,
  baseline: ReportBaseline,
): ItemMark | null {
  if (baseline.kind !== 'found') return null;
  const before = baseline.snapshot.items[key];
  if (before === undefined) return 'new';
  return before === fingerprint ? null : 'changed';
}

/** D3: only P2 to P4 questions ever print on one line. */
export function compactPriority(priority: number | null): boolean {
  return priority === 2 || priority === 3 || priority === 4;
}

/**
 * D3: one line, or in full. One line only for a P2 to P4 question that the
 * last report showed with the same content. In full for P0, P1 and an unknown
 * priority, for a new or changed question, when there is no last report (the
 * first report of a session) or it could not be read, with the knob off, and
 * under `--full`.
 */
export function questionShown(
  question: AskBeadView,
  delta: ReportDelta | null,
): QuestionShown {
  if (delta == null) return {compact: false, mark: null};
  const fingerprint = questionFingerprint(question);
  const key = questionKey(question.id);
  const mark = markOf(key, fingerprint, delta.baseline);
  const compact =
    delta.compact &&
    delta.baseline.kind === 'found' &&
    compactPriority(question.priority) &&
    delta.baseline.snapshot.items[key] === fingerprint;
  return {compact, mark};
}

/** "3", "3 and 4", "3, 4 and 5". */
function numberList(numbers: readonly number[]): string {
  const words = numbers.map(String);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/**
 * D3: the one line at the end of the questions, when any of them is on one
 * line. Null when none is.
 */
export function compactQuestionsNote(
  numbers: readonly number[],
): string | null {
  if (numbers.length === 0) return null;
  return numbers.length === 1
    ? `Question ${numberList(numbers)} has not changed since the last report, so it is on one line. Ask for the full report to see it in full.`
    : `Questions ${numberList(numbers)} have not changed since the last report, so each is on one line. Ask for the full report to see them in full.`;
}

/** Said in Part 1 when the last report could not be established. */
export function baselineProblem(baseline: ReportBaseline): string | null {
  return baseline.kind === 'unknown'
    ? `Nothing is marked new or changed, and every question is in full: ${baseline.reason}`
    : null;
}

// ---------------------------------------------------------------------------
// D6: which saved snapshot is the last report
// ---------------------------------------------------------------------------

/** The end of Claude's previous turn, from the transcript. */
export type TurnEndRead =
  | {at: string; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'};

/** This session's saved snapshots, oldest first. */
export type SnapshotsRead =
  | {kind: 'found'; snapshots: readonly ReportSnapshot[]}
  | {kind: 'none'}
  | {kind: 'unknown'; reason: string};

/**
 * D6: the newest snapshot saved at or before the end of the previous turn.
 * The transcript is read only when there are snapshots to choose from.
 */
export function chooseBaseline(
  snapshots: SnapshotsRead,
  readTurnEnd: () => TurnEndRead,
): ReportBaseline {
  if (snapshots.kind === 'unknown') {
    return {
      kind: 'unknown',
      reason: `could not read the earlier reports of this session: ${snapshots.reason}`,
    };
  }
  if (snapshots.kind === 'none') return {kind: 'first'};
  const end = readTurnEnd();
  if (end.kind === 'failed') {
    return {
      kind: 'unknown',
      reason: `could not tell when the previous turn ended: ${end.reason}`,
    };
  }
  // No turn has ended yet: every report so far is this turn's.
  if (end.kind === 'none') return {kind: 'first'};
  const endMs = Date.parse(end.at);
  if (Number.isNaN(endMs)) {
    return {
      kind: 'unknown',
      reason: `the previous turn's end has an unreadable time ${JSON.stringify(end.at)}`,
    };
  }
  for (let index = snapshots.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots.snapshots[index];
    if (snapshot == null) continue;
    const atMs = Date.parse(snapshot.at);
    if (!Number.isNaN(atMs) && atMs <= endMs) {
      return {kind: 'found', snapshot};
    }
  }
  // Snapshots, but all from this turn: no earlier turn printed a report.
  return {kind: 'first'};
}
