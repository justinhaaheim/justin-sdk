/**
 * Part 1's "🔎 Code review findings" section (home-base epic home-base-g22jt
 * D16, built by home-base-g22jt.7 item 5). Justin, 2026-11-21: "any time this
 * code review process is done the FINDINGS of the review are shared with me
 * directly in the next status report -- so I can see what the review is
 * surfacing, and whether it turned out to be an actual bug or not."
 *
 * Three steps, kept out of part-one.ts so the thread code changes in few
 * lines (another session works there):
 *   - `loadCodeReviews` (session-report.ts calls it) reads home-base
 *     review-gate's ledger through `../review-ledger`, which imports zod, so
 *     it is loaded with `await import` (the CLI's static tree stays zod-free).
 *     It never throws: anything that goes wrong is ONE line in the section.
 *   - `codeReviewsShown` (partOneView calls it) decides, against the last
 *     report, which reviews are new or changed and which collapse to a line.
 *   - `markdownCodeReviews` / `ansiCodeReviews` print it, and `reviewMarks`
 *     gives What to mark its items.
 *
 * A review shows when its line's `buildCost.sessionId` is this session (a
 * subagent carries its parent's id, so a conductor's report shows its
 * players' reviews). A successor also shows its predecessors' reviews whose
 * confirmed findings still lack an outcome.
 */

import type {OutputStyle} from '../cli-style';
import type * as ReviewLedger from '../review-ledger';
import type {ItemMark, ReportBaseline, SnapshotItems} from './report-delta';

import {existsSync} from 'fs';
import {dirname} from 'path';

import {
  BODY_COLUMN,
  markdownItems,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {blockDigest, markEmoji, markOf} from './report-delta';
import {CONTINUES_LABEL_PREFIX} from './session-bead';

export const CODE_REVIEWS_HEADING = 'Code review findings';
const EMOJI = '🔎';
/** Unreadable ledger lines named in the section before "and N more". */
const UNREADABLE_SHOWN = 3;

/** One finding, as the section prints it: plain data, no zod. */
export interface FindingView {
  /** The exact `review-gate outcome` command for it. */
  command: string;
  /** No outcome recorded (a rejected one has the verifier's). */
  lacksOutcome: boolean;
  /** CONFIRMED and no outcome: a What to mark item. */
  needsOutcome: boolean;
  number: number;
  /** What became of it, in words, or "none recorded". */
  outcome: string;
  reason: string | null;
  summary: string;
  verdict: string;
  where: string;
}

export interface ReviewData {
  branch: string;
  cost: string;
  endedAt: string;
  findings: FindingView[];
  id: string;
  model: string;
  /** False: a review of a session this one continues. */
  own: boolean;
  reviewer: string;
  status: string;
}

export type CodeReviewsLoad =
  | {kind: 'failed'; reason: string}
  | {kind: 'none'}
  | {
      kind: 'read';
      notes: string[];
      reviews: ReviewData[];
      /** `<path>:<line>: <error>` for each ledger line that did not parse. */
      unreadable: string[];
    };

/** Where the session's predecessors come from; null when it continues none. */
export type PredecessorIds = () => Promise<
  {ids: string[]; kind: 'ids'} | {kind: 'failed'; reason: string}
>;

/**
 * The session ids of the sessions this one continues (its handoff chain,
 * oldest first, chain-walk.ts), or null when its bead continues none. The
 * walk is loaded and run only when asked.
 */
export function chainPredecessors(
  session: null | {id: string; labels: readonly string[]},
  input: {cwd: string; env: Readonly<Record<string, string | undefined>>},
): null | PredecessorIds {
  if (session == null) return null;
  if (!session.labels.some((l) => l.startsWith(CONTINUES_LABEL_PREFIX))) {
    return null;
  }
  return async () => {
    const chain = await import('./chain-walk');
    const walk = chain.walkChain(
      session.id,
      chain.realChainWalkReaders({cwd: input.cwd, env: input.env}),
    );
    if (walk.kind === 'failed') return {kind: 'failed', reason: walk.reason};
    if (walk.kind === 'incomplete') {
      return {kind: 'failed', reason: walk.problems.join('; ')};
    }
    const ids = walk.members
      .slice(0, walk.startIndex)
      .map((m) => m.sessionId)
      .filter((id): id is string => id != null);
    return {ids, kind: 'ids'};
  };
}

function usdText(value: number | null): string {
  return value == null ? 'unknown' : `$${value.toFixed(2)}`;
}

function findingView(
  entry: ReviewLedger.NumberedFinding,
  outcome: ReviewLedger.OutcomeLine | null,
  ledger: typeof ReviewLedger,
  reviewId: string,
): FindingView {
  const f = entry.finding;
  const where =
    f.file == null
      ? '(no file)'
      : `${f.file}${f.line == null ? '' : `:${f.line}`}${f.lineNote == null ? '' : ` (${f.lineNote})`}`;
  return {
    command: ledger.outcomeCommand(reviewId, entry.number),
    lacksOutcome: ledger.lacksOutcome(entry, outcome),
    needsOutcome: ledger.needsOutcome(entry, outcome),
    number: entry.number,
    outcome: ledger.outcomeWords(entry, outcome) ?? 'none recorded',
    reason: f.reason ?? null,
    summary:
      entry.kind === 'finding'
        ? (entry.finding.shortSummary ?? f.summary)
        : f.summary,
    verdict:
      entry.kind === 'rejected'
        ? 'REJECTED'
        : (entry.finding.verdict ??
          (entry.finding.reports == null
            ? 'no verdict (single-pass reviewer)'
            : 'no verdict')),
    where,
  };
}

function reviewData(
  review: ReviewLedger.ReviewLine,
  outcomes: ReadonlyMap<string, ReviewLedger.OutcomeLine>,
  ledger: typeof ReviewLedger,
  own: boolean,
): ReviewData {
  const models =
    review.modelsSeen == null || review.modelsSeen.length === 0
      ? ''
      : ` (seen: ${review.modelsSeen.join(', ')})`;
  return {
    branch: review.branch,
    cost: `${usdText(review.reviewCost.usd)} for the review, ${usdText(review.buildCost.usd)} for the build`,
    endedAt: review.endedAt,
    findings: ledger
      .numberedFindings(review)
      .map((entry) =>
        findingView(
          entry,
          outcomes.get(ledger.outcomeKey(review.id, entry.number)) ?? null,
          ledger,
          review.id,
        ),
      ),
    id: review.id,
    model: `${review.modelAsked ?? 'none'}${models}`,
    own,
    reviewer: `${review.reviewer.name} (${review.reviewer.version}), ${review.passes} pass${review.passes === 'single' ? '' : 'es'}`,
    status:
      review.status === 'ok'
        ? 'ok'
        : `FAILED: ${review.error ?? 'no reason recorded'}`,
  };
}

/**
 * The section's data for this session, read now. `none`: nothing to show (no
 * ledger directory, or no review of this session or of an unresolved
 * predecessor). Never throws: a permission error, a parse crash or any other
 * exception is `failed`, one line in the section, and the rest of the block
 * is untouched.
 */
export async function loadCodeReviews(input: {
  env: Readonly<Record<string, string | undefined>>;
  /** Test seam: the ledger module, else `await import('../review-ledger')`. */
  loadLedger?: () => Promise<typeof ReviewLedger>;
  predecessors: PredecessorIds | null;
  sessionId: string;
}): Promise<CodeReviewsLoad> {
  try {
    const ledger = await (
      input.loadLedger ?? (() => import('../review-ledger'))
    )();
    const path = ledger.ledgerPath(input.env);
    if (!existsSync(dirname(path))) return {kind: 'none'};
    const read = ledger.readLedger(path);
    const outcomes = ledger.latestOutcomes(read);
    const reviews = ledger.reviewsOf(read);
    const unresolved = (review: ReviewLedger.ReviewLine): boolean =>
      ledger
        .numberedFindings(review)
        .some((entry) =>
          ledger.needsOutcome(
            entry,
            outcomes.get(ledger.outcomeKey(review.id, entry.number)) ?? null,
          ),
        );
    const own = reviews.filter(
      (r) => r.buildCost.sessionId === input.sessionId,
    );
    const notes: string[] = [];
    let before: ReviewLedger.ReviewLine[] = [];
    const ids = new Set([input.sessionId]);
    // Walk the chain only when some other session's review is unresolved:
    // otherwise no predecessor can have one, and the walk costs br reads.
    const candidates = reviews.filter(
      (r) =>
        r.buildCost.sessionId != null &&
        r.buildCost.sessionId !== input.sessionId &&
        unresolved(r),
    );
    if (input.predecessors != null && candidates.length > 0) {
      const found = await input.predecessors();
      if (found.kind === 'failed') {
        notes.push(
          `⚠️ The reviews of the sessions this one continues could not be looked up: ${found.reason}`,
        );
      } else {
        for (const id of found.ids) ids.add(id);
        const earlier = new Set(found.ids);
        before = candidates.filter(
          (r) =>
            r.buildCost.sessionId != null && earlier.has(r.buildCost.sessionId),
        );
      }
    }
    const namesUs = read.unreadable.some((u) =>
      [...ids].some((id) => u.text.includes(id)),
    );
    if (
      own.length === 0 &&
      before.length === 0 &&
      notes.length === 0 &&
      !namesUs
    ) {
      return {kind: 'none'};
    }
    const unreadable = read.unreadable.map(
      (u) => `${path}:${String(u.lineNo)}: ${u.error}`,
    );
    return {
      kind: 'read',
      notes,
      reviews: [
        ...before.map((r) => reviewData(r, outcomes, ledger, false)),
        ...own.map((r) => reviewData(r, outcomes, ledger, true)),
      ],
      unreadable,
    };
  } catch (error) {
    return {
      kind: 'failed',
      reason: String(error instanceof Error ? error.message : error),
    };
  }
}

export interface ReviewShown extends ReviewData {
  /** Shown before, unchanged, and every finding has an outcome: one line. */
  collapsed: boolean;
  mark: ItemMark | null;
  when: string;
}

export type CodeReviewsView =
  | {kind: 'failed'; line: string}
  | {
      kind: 'shown';
      notes: string[];
      reviews: ReviewShown[];
      unreadable: string[];
    };

export function codeReviewKey(id: string): string {
  return `cr:${id}`;
}

function fingerprintOf(review: ReviewData): string {
  return blockDigest([
    review.status,
    ...review.findings.map((f) => `${f.number}|${f.verdict}|${f.outcome}`),
  ]);
}

/**
 * The section as this report shows it, and the snapshot items the next
 * report compares with (the block's new-since-last-report mechanism,
 * report-delta.ts). Null when there is no section.
 */
export function codeReviewsShown(
  load: CodeReviewsLoad | null | undefined,
  options: {baseline: ReportBaseline | null; when: (at: Date) => string},
): {snapshot: SnapshotItems; view: CodeReviewsView | null} {
  if (load == null || load.kind === 'none') return {snapshot: {}, view: null};
  if (load.kind === 'failed') {
    return {
      snapshot: {},
      view: {
        kind: 'failed',
        line: `⚠️ The review-gate ledger could not be read, so any findings of this session's reviews are not shown: ${load.reason}`,
      },
    };
  }
  const snapshot: SnapshotItems = {};
  const reviews = load.reviews.map((review): ReviewShown => {
    const key = codeReviewKey(review.id);
    const fingerprint = fingerprintOf(review);
    snapshot[key] = fingerprint;
    const baseline = options.baseline;
    const mark = baseline == null ? null : markOf(key, fingerprint, baseline);
    const seenUnchanged = baseline?.kind === 'found' && mark == null;
    const at = Date.parse(review.endedAt);
    return {
      ...review,
      collapsed: seenUnchanged && review.findings.every((f) => !f.lacksOutcome),
      mark,
      when: Number.isNaN(at) ? review.endedAt : options.when(new Date(at)),
    };
  });
  return {
    snapshot,
    view: {
      kind: 'shown',
      notes: load.notes,
      reviews,
      unreadable: load.unreadable,
    },
  };
}

/** What to mark: one item per confirmed finding with no outcome. */
export function reviewMarks(
  view: CodeReviewsView | null | undefined,
): {code: string; sub: []; text: string}[] {
  if (view?.kind !== 'shown') return [];
  return view.reviews.flatMap((review) =>
    review.findings
      .filter((f) => f.needsOutcome)
      .map((f) => ({
        code: f.command,
        sub: [] as [],
        text: `Record what became of confirmed finding ${String(f.number)} of the review of ${review.branch} (${f.summary}):`,
      })),
  );
}

function short(id: string): string {
  return id.slice(0, 8);
}

function reviewTitle(review: ReviewShown): string {
  const mark = review.mark == null ? '' : ` ${markEmoji(review.mark)}`;
  const whose = review.own ? '' : ', from a session this one continues';
  return `Review ${short(review.id)}${mark} of ${review.branch}${whose}`;
}

function collapsedLine(review: ReviewShown): string {
  return `${reviewTitle(review)}: every finding has an outcome. \`review-gate show ${short(review.id)}\``;
}

function unreadableLines(unreadable: readonly string[]): string[] {
  if (unreadable.length === 0) return [];
  const shown = unreadable.slice(0, UNREADABLE_SHOWN);
  const more = unreadable.length - shown.length;
  return [
    `⚠️ ${String(unreadable.length)} ledger line(s) could not be read and are not counted: ${shown.join('; ')}${more > 0 ? `; and ${String(more)} more (\`review-gate log\`)` : ''}`,
  ];
}

function findingFields(f: FindingView): [string, string][] {
  const fields: [string, string][] = [
    ['Where', f.where],
    ['Verdict', f.verdict],
  ];
  if (f.reason != null) fields.push(['Reason', f.reason]);
  fields.push(['Outcome', f.outcome]);
  return fields;
}

function reviewFields(review: ReviewShown): [string, string][] {
  return [
    ['Reviewer', review.reviewer],
    ['Model', review.model],
    ['Date', review.when],
    ['Cost', review.cost],
    ['Status', review.status],
  ];
}

/** Markdown (how Claude reads `thread status`): the block's spacing rules. */
export function markdownCodeReviews(
  view: CodeReviewsView | null | undefined,
): string {
  if (view == null) return '';
  const heading = `## ${EMOJI} ${CODE_REVIEWS_HEADING}`;
  if (view.kind === 'failed') return spacedList([heading, `*${view.line}*`]);
  const blocks = view.reviews.map((review) => {
    if (review.collapsed) return collapsedLine(review);
    const findings =
      review.findings.length === 0
        ? '*No findings.*'
        : markdownItems(
            review.findings.map((f) =>
              [
                `${String(f.number)}. **${f.summary}**`,
                ...findingFields(f).map(
                  ([label, value]) => `   - **${label}:** ${value}`,
                ),
              ].join('\n'),
            ),
          );
    return spacedList([
      `**${reviewTitle(review)}**`,
      reviewFields(review)
        .map(([label, value]) => `- **${label}:** ${value}`)
        .join('\n'),
      findings,
    ]);
  });
  return spacedList([
    heading,
    ...blocks,
    ...[...view.notes, ...unreadableLines(view.unreadable)].map(
      (n) => `*${n}*`,
    ),
  ]);
}

/** On a TTY (`thread show`, `thread status` by hand): the same, man-page style. */
export function ansiCodeReviews(
  view: CodeReviewsView | null | undefined,
  style: OutputStyle,
): string {
  if (view == null) return '';
  const line = (text: string, indent: number, hang = indent): string =>
    wrapHanging(text, {hang, indent, width: style.width});
  const heading = sectionHeader(CODE_REVIEWS_HEADING, {
    color: style.color,
    emoji: EMOJI,
  });
  if (view.kind === 'failed') {
    return spacedList([
      heading,
      line(paint(view.line, ['italic'], style.color), BODY_COLUMN),
    ]);
  }
  const label = (text: string): string =>
    paint(`${text}:`, ['bold'], style.color);
  const blocks = view.reviews.map((review) => {
    if (review.collapsed) return line(collapsedLine(review), BODY_COLUMN);
    return spacedList([
      line(paint(reviewTitle(review), ['bold'], style.color), BODY_COLUMN),
      reviewFields(review)
        .map(([l, v]) =>
          line(`${label(l)} ${v}`, BODY_COLUMN + 2, BODY_COLUMN + 4),
        )
        .join('\n'),
      ...review.findings.map((f) =>
        [
          line(
            `${String(f.number)}. ${paint(f.summary, ['bold'], style.color)}`,
            BODY_COLUMN + 2,
            BODY_COLUMN + 5,
          ),
          ...findingFields(f).map(([l, v]) =>
            line(`${label(l)} ${v}`, BODY_COLUMN + 5, BODY_COLUMN + 7),
          ),
        ].join('\n'),
      ),
    ]);
  });
  return spacedList([
    heading,
    ...blocks,
    ...[...view.notes, ...unreadableLines(view.unreadable)].map((n) =>
      line(paint(n, ['italic'], style.color), BODY_COLUMN),
    ),
  ]);
}
