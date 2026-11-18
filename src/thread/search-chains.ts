/**
 * `thread search` by handoff chain (home-base-lasun L1, L2). Justin,
 * 2026-11-15: "We need to be able to do searches/groupings/operations over
 * session sequences (to me the term "thread" encompasses potentially multiple
 * sessions)".
 *
 * GROUPING (L1). Every matched row whose session has a session bead is placed
 * in its handoff chain by the ONE chain walk (chain-walk.ts): the chain is
 * keyed by its root, the bead chainRootOf names, so two sessions of one chain
 * always land in one block. A session with no session bead is its own block,
 * marked as having no chain. A row whose chain cannot be read (its session
 * bead is unknown, the walk failed or never reached the root) is its own block
 * that says the chain is unknown and why; a chain walked only in part says so
 * too. Either makes the search exit 2 (critical rule 7): a grouping built on a
 * chain that was not read could put a session in the wrong block or name the
 * wrong newest session, which is the failure `thread focus` exists to prevent.
 *
 * The walk is memoized per search: every member of a walked chain maps to the
 * same walk, so a chain with several matching sessions is walked once.
 */

import type {Field} from '../cli-style';
import type {ChainWalk} from './chain-walk';
import type {SearchRow} from './search';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  pad,
  paint,
  wrapHanging,
} from '../cli-style';

/** One step of indentation (cli-style's uniform step). */
export const GROUP_STEP = BODY_COLUMN - HEADER_COLUMN;

/** The newest session of a chain, as far as the walk read it. */
export interface SearchChainNewest {
  beadId: string;
  /** Its display name: `[Scorpio-12]`. */
  name: string;
  /** The command that resumes it, from the search corpus; null when none is recorded. */
  resumeCommand: null | string;
  sessionId: null | string;
  title: string;
}

/**
 * Which chain a row belongs to. `chain`: its session bead's chain was walked
 * (`problems` non-empty when only part of it could be read). `noChain`: a
 * MEASURED absence, the sessions index records no session bead for it, so it
 * has no handoff links. `unknown`: its chain could not be read.
 */
export interface SearchRowChain {
  /** The grouping key: the root bead id, `session:<id>` or `unknown:<id>`. */
  key: string;
  kind: 'chain' | 'noChain' | 'unknown';
  /** The chain's name (`Scorpio`), null when it has none. */
  name: null | string;
  /** The newest session the walk reached; null without a chain. */
  newest: null | SearchChainNewest;
  /** Why there is no chain (`noChain` only). */
  noChainReason: null | string;
  /** What could not be read, each in words; empty for a whole chain or none. */
  problems: string[];
  /** The chain's first session bead; null without one. */
  root: null | string;
  /** How many sessions the walk read; null without a chain. */
  sessions: null | number;
}

export interface SearchChainGroup {
  chain: SearchRowChain;
  /** The rows of this chain that matched, newest first, each carrying `chain`. */
  rows: SearchRow[];
}

/** What grouping reads, injected so tests need no real state. */
export interface ChainGroupingReaders {
  /** The resume command the corpus records for a session id, or null. */
  resumeOf: (sessionId: string) => null | string;
  /** The walk through one session bead (walkChain with the real readers). */
  walkOf: (beadId: string) => ChainWalk;
}

function noChain(key: string, reason: string): SearchRowChain {
  return {
    key,
    kind: 'noChain',
    name: null,
    newest: null,
    noChainReason: reason,
    problems: [],
    root: null,
    sessions: null,
  };
}

function unknownChain(key: string, problems: string[]): SearchRowChain {
  return {
    key,
    kind: 'unknown',
    name: null,
    newest: null,
    noChainReason: null,
    problems,
    root: null,
    sessions: null,
  };
}

/**
 * The rows, in their order, grouped by chain (L1). The groups are in the order
 * of their first row, so the newest match leads as before; a group's rows keep
 * their order. Every row comes back carrying its `chain`.
 */
export function groupByChain(
  rows: readonly SearchRow[],
  readers: ChainGroupingReaders,
): SearchChainGroup[] {
  const walks = new Map<string, ChainWalk>();
  const walkThrough = (beadId: string): ChainWalk => {
    const known = walks.get(beadId);
    if (known != null) return known;
    const walk = readers.walkOf(beadId);
    walks.set(beadId, walk);
    if (walk.kind !== 'failed') {
      for (const member of walk.members) walks.set(member.beadId, walk);
    }
    return walk;
  };

  const chainOf = (row: SearchRow, index: number): SearchRowChain => {
    const own = row.sessionId ?? row.threadId ?? `row-${index}`;
    const bead = row.sessionBead;
    if (bead == null) {
      return unknownChain(`unknown:${own}`, [
        `the session bead of ${own} was not looked up`,
      ]);
    }
    if (bead.kind === 'none') return noChain(`session:${own}`, bead.reason);
    if (bead.kind === 'unknown') {
      return unknownChain(`unknown:${own}`, [
        `the session bead of ${own} could not be read: ${bead.reason}`,
      ]);
    }
    const walk = walkThrough(bead.beadId);
    if (walk.kind === 'failed') {
      return unknownChain(`unknown:${bead.beadId}`, [
        `the chain of ${bead.beadId} could not be read: ${walk.reason}`,
      ]);
    }
    const problems = walk.kind === 'incomplete' ? walk.problems : [];
    if (walk.root == null) {
      // The walk back stopped short of the first session: which chain this
      // is cannot be said, so it is never merged with another block.
      return unknownChain(`unknown:${bead.beadId}`, problems);
    }
    const newest = walk.members.at(-1) ?? null;
    return {
      key: walk.root,
      kind: 'chain',
      name: walk.chainName,
      newest:
        newest == null
          ? null
          : {
              beadId: newest.beadId,
              name: newest.name,
              resumeCommand:
                newest.sessionId == null
                  ? null
                  : readers.resumeOf(newest.sessionId),
              sessionId: newest.sessionId,
              title: newest.title,
            },
      noChainReason: null,
      problems,
      root: walk.root,
      sessions: walk.members.length,
    };
  };

  const groups = new Map<string, SearchChainGroup>();
  rows.forEach((row, index) => {
    const chain = chainOf(row, index);
    const placed: SearchRow = {...row, chain};
    const group = groups.get(chain.key);
    if (group == null) groups.set(chain.key, {chain, rows: [placed]});
    else group.rows.push(placed);
  });
  return [...groups.values()];
}

/** `Scorpio`, or `of home-base-yf73y` with no name. */
function chainLabel(chain: SearchRowChain): string {
  return chain.name ?? `of ${chain.root ?? chain.key}`;
}

/** Every problem of the groups, each naming its chain: what makes the search exit 2. */
export function chainProblems(groups: readonly SearchChainGroup[]): string[] {
  return groups.flatMap((group) =>
    group.chain.problems.map((problem) =>
      group.chain.kind === 'unknown'
        ? `chain unknown: ${problem}`
        : `chain ${chainLabel(group.chain)} read only in part: ${problem}`,
    ),
  );
}

/** The block's first line: which chain, and how many of its sessions matched. */
export function groupHeading(group: SearchChainGroup): string {
  const {chain} = group;
  const matched = group.rows.length;
  if (chain.kind === 'noChain')
    return 'No chain: this session has no session bead';
  if (chain.kind === 'unknown') {
    return `Chain unknown: ${matched} matching session${matched === 1 ? '' : 's'}`;
  }
  const of =
    chain.sessions == null
      ? ''
      : ` of ${chain.sessions} session${chain.sessions === 1 ? '' : 's'}`;
  const name =
    chain.name == null
      ? `Chain of ${chain.root ?? '?'}`
      : `Chain ${chain.name}`;
  return `${name}: ${matched}${of} matched`;
}

const GROUP_LABELS = ['Newest', 'Resume', 'Why', 'Incomplete'] as const;
const GROUP_LABEL_WIDTH = fieldLabelWidth(
  GROUP_LABELS.map((label) => ({label, value: ''})),
);

/**
 * One block, man-page style: the heading at the header column, the chain's
 * fields stacked under it, then each matching row one step in, a blank line
 * between them. `renderRow` is search.ts's renderSearchRow, given the width
 * left after the step.
 */
export function renderSearchGroup(
  group: SearchChainGroup,
  renderRow: (row: SearchRow, width: null | number) => string,
  options: {color: boolean; width: null | number},
): string {
  const {color, width} = options;
  const {chain} = group;
  const missing = (text: string): string => paint(text, ['dim'], color);
  const fields: Field[] = [];
  if (chain.kind === 'chain') {
    const newest = chain.newest;
    fields.push({
      label: 'Newest',
      value:
        newest == null
          ? missing('unknown')
          : `${newest.name} ${newest.title}`.trim(),
    });
    fields.push({
      label: 'Resume',
      value:
        newest?.resumeCommand == null
          ? missing('no resume command recorded for the newest session')
          : paint(newest.resumeCommand, ['cyan'], color),
    });
  }
  if (chain.noChainReason != null) {
    fields.push({label: 'Why', value: chain.noChainReason});
  }
  for (const problem of chain.problems) {
    fields.push({
      label: chain.kind === 'unknown' ? 'Why' : 'Incomplete',
      value: problem,
    });
  }
  const inner = width == null ? null : Math.max(20, width - GROUP_STEP);
  const rows = group.rows.flatMap((row) => [
    '',
    renderRow(row, inner)
      .split('\n')
      .map((line) => (line === '' ? line : `${pad(GROUP_STEP)}${line}`))
      .join('\n'),
  ]);
  return [
    wrapHanging(paint(`⛓️ ${groupHeading(group)}`, ['bold'], color), {
      hang: BODY_COLUMN,
      indent: HEADER_COLUMN,
      width,
    }),
    ...(fields.length === 0
      ? []
      : [
          fieldLines(fields, {
            color,
            indent: BODY_COLUMN,
            labelWidth: GROUP_LABEL_WIDTH,
            width,
          }),
        ]),
    ...rows,
  ].join('\n');
}
