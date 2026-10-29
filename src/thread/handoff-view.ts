/**
 * What `thread show`, the session card and the inbox say about a session's
 * handoffs (epic home-base-mbnjv D2, D9, C9; built by home-base-mbnjv.3).
 *
 * ONE LINK FORMAT (C9). A handoff link is two labels: the successor's session
 * bead carries `continues:<predecessor>` and the predecessor's carries
 * `continued-by:<successor>` (linkContinuation in session-handoff.ts writes
 * both). The legacy bd thread system's metadata.continuesFrom is not read
 * here.
 *
 * HALF-WRITTEN LINKS. When only one of the two labels exists, the link is
 * printed as half-written, naming the label that is missing. It is never
 * treated as linked, and never as unlinked. A half link is found from the
 * bead that holds its one label: a bead naming this session in a
 * `continued-by:` label that this session does not answer cannot be found
 * from this session without reading every bead, so it shows from that bead's
 * side only.
 *
 * REFUSALS (D2). recordRefusal (handoff-gate.ts) labels the session bead
 * `handoff-refused` and appends a note line "handoff refused: <reason> —
 * <detail>". `handoffRefusalOf` reads them back.
 *
 * CRITICAL RULE 7. A bead that cannot be read stops the walk in that
 * direction and says why; the chain is then printed as incomplete, never as
 * ending there.
 */

import type {EnvLike} from './paths';

import {brShow, describeBrFailed, findBeadsWorkspace} from '../beads/br';
import {CHAIN_WALK_LIMIT} from './handoff-chain';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  HANDOFF_REFUSED_LABEL,
} from './session-bead';
import {locateSessionBead} from './session-handoff';

// ---------------------------------------------------------------------------
// One bead's own records
// ---------------------------------------------------------------------------

/** The words every refusal line starts with (recordRefusal writes them). */
export const HANDOFF_REFUSED_WORDS = 'handoff refused:';

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

/** The predecessors a bead names (`continues:`), in label order. */
export function continuesOf(labels: readonly string[]): string[] {
  return labelsWith(labels, CONTINUES_LABEL_PREFIX);
}

/** The successors a bead names (`continued-by:`), in label order. */
export function continuedByOf(labels: readonly string[]): string[] {
  return labelsWith(labels, CONTINUED_BY_LABEL_PREFIX);
}

/** True when a bead's labels carry anything about handing off. */
export function hasHandoffRecord(labels: readonly string[]): boolean {
  return labels.some(
    (label) =>
      label === HANDED_OFF_LABEL ||
      label === HANDOFF_REFUSED_LABEL ||
      label.startsWith(CONTINUES_LABEL_PREFIX) ||
      label.startsWith(CONTINUED_BY_LABEL_PREFIX),
  );
}

/**
 * The newest refusal on a session bead: the text of its newest note line from
 * "handoff refused:" on. Null when the bead is not labelled handoff-refused.
 * A label with no such line says so, rather than reading as no refusal.
 */
export function handoffRefusalOf(
  labels: readonly string[],
  notes: string | null,
): string | null {
  if (!labels.includes(HANDOFF_REFUSED_LABEL)) return null;
  const lines = (notes ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const at = line.indexOf(HANDOFF_REFUSED_WORDS);
    if (at >= 0) return line.slice(at).trim();
  }
  return `${HANDOFF_REFUSED_WORDS} reason not recorded (the session bead is labelled ${HANDOFF_REFUSED_LABEL}, but its notes hold no "${HANDOFF_REFUSED_WORDS}" line)`;
}

/**
 * When the session handed off: the stamp of its newest "handed off" note line
 * (handOff writes `- <stamp>: handed off` or `- <stamp>: handed off — <note>`).
 * Null when it carries no `handed-off` label; "unknown" words when the label
 * has no dated line.
 */
export function handedOffAtOf(
  labels: readonly string[],
  notes: string | null,
): string | null {
  if (!labels.includes(HANDED_OFF_LABEL)) return null;
  const lines = (notes ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^- (.+?): handed off(?: —|$)/.exec(lines[index] ?? '');
    if (match?.[1] != null) return match[1];
  }
  return 'at an unknown time (no dated "handed off" note line)';
}

// ---------------------------------------------------------------------------
// The chain, both ways
// ---------------------------------------------------------------------------

export interface ChainViewBead {
  id: string;
  labels: readonly string[];
  notes: string | null;
  title: string;
}

export type ChainViewBeadRead =
  | {bead: ChainViewBead; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; reason: string};

export interface ChainViewReaders {
  showBead: (beadId: string) => ChainViewBeadRead;
}

export interface ChainNode {
  beadId: string;
  /** null when the session never handed off (no `handed-off` label). */
  handedOffAt: string | null;
  /** The newest "handoff refused: …" line, or null (handoffRefusalOf). */
  refusal: string | null;
  title: string;
}

/**
 * The link between two neighbouring sessions. `complete`: both labels.
 * `onlyContinues`: the later one says it continues the earlier one, and the
 * earlier one has no `continued-by:` for it. `onlyContinued`: the reverse.
 */
export type ChainLinkState = 'complete' | 'onlyContinued' | 'onlyContinues';

export interface HandoffChainView {
  /** `links[i]` joins `nodes[i]` and `nodes[i + 1]`. */
  links: ChainLinkState[];
  /** Oldest first. */
  nodes: ChainNode[];
  /**
   * Why the walk stopped before a chain end, each one naming the bead; empty
   * when both ends were reached.
   */
  problems: string[];
  /** The index in `nodes` of the session the walk started from. */
  selfIndex: number;
}

function nodeOf(bead: ChainViewBead): ChainNode {
  return {
    beadId: bead.id,
    handedOffAt: handedOffAtOf(bead.labels, bead.notes),
    refusal: handoffRefusalOf(bead.labels, bead.notes),
    title: bead.title,
  };
}

/**
 * The whole chain through `startBeadId`: back through `continues:` to the
 * first session, forward through `continued-by:` to the newest. A neighbour
 * is followed through whichever half of the link exists, and the state of
 * every link is kept.
 */
export function readHandoffChain(
  startBeadId: string,
  readers: ChainViewReaders,
  options: {limit?: number} = {},
): HandoffChainView | {kind: 'failed'; reason: string} {
  const limit = options.limit ?? CHAIN_WALK_LIMIT;
  const start = readers.showBead(startBeadId);
  if (start.kind !== 'found') {
    return {kind: 'failed', reason: `${startBeadId}: ${start.reason}`};
  }
  const seen = new Set<string>([start.bead.id]);
  const problems: string[] = [];

  const walk = (
    direction: 'back' | 'forward',
  ): {beads: ChainViewBead[]; links: ChainLinkState[]} => {
    const beads: ChainViewBead[] = [];
    const links: ChainLinkState[] = [];
    let current = start.bead;
    for (;;) {
      const next =
        direction === 'back'
          ? continuesOf(current.labels)
          : continuedByOf(current.labels);
      const label =
        direction === 'back'
          ? CONTINUES_LABEL_PREFIX
          : CONTINUED_BY_LABEL_PREFIX;
      if (next.length === 0) return {beads, links};
      if (next.length > 1) {
        problems.push(
          `${current.id} names ${next.length} ${direction === 'back' ? 'predecessors' : 'successors'} (${next.map((id) => `${label}${id}`).join(', ')}), so the chain ${direction === 'back' ? 'before' : 'after'} it is not shown`,
        );
        return {beads, links};
      }
      const [nextId = ''] = next;
      if (seen.has(nextId)) {
        problems.push(`the chain loops back to ${nextId}`);
        return {beads, links};
      }
      if (beads.length >= limit) {
        problems.push(
          `the chain is longer than ${limit} sessions ${direction === 'back' ? 'before' : 'after'} ${startBeadId}; the walk stopped at ${current.id}`,
        );
        return {beads, links};
      }
      const read = readers.showBead(nextId);
      if (read.kind !== 'found') {
        problems.push(
          `${current.id} names ${label}${nextId}, but ${nextId} could not be read: ${read.reason}`,
        );
        return {beads, links};
      }
      seen.add(nextId);
      const back = direction === 'back';
      const reverse = back
        ? continuedByOf(read.bead.labels).includes(current.id)
        : continuesOf(read.bead.labels).includes(current.id);
      let state: ChainLinkState = 'complete';
      if (!reverse) state = back ? 'onlyContinues' : 'onlyContinued';
      beads.push(read.bead);
      links.push(state);
      current = read.bead;
    }
  };

  const before = walk('back');
  const after = walk('forward');
  const nodes = [
    ...[...before.beads].reverse().map(nodeOf),
    nodeOf(start.bead),
    ...after.beads.map(nodeOf),
  ];
  return {
    links: [...[...before.links].reverse(), ...after.links],
    nodes,
    problems,
    selfIndex: before.beads.length,
  };
}

/** The real reader: the sessions index first, then `cwd`'s beads DB. */
export function realChainViewReaders(input: {
  cwd: string;
  env: EnvLike;
  fallbackDbs?: readonly string[];
}): ChainViewReaders {
  const {env} = input;
  const fallbacks = [...(input.fallbackDbs ?? [])];
  const space = findBeadsWorkspace(input.cwd);
  if (space.kind === 'found' && !fallbacks.includes(space.db)) {
    fallbacks.push(space.db);
  }
  return {
    showBead: (beadId) => {
      const located = locateSessionBead(beadId, env, fallbacks);
      if (located.kind === 'failed') {
        return {kind: 'failed', reason: located.reason};
      }
      if (located.kind === 'notFound') {
        return {
          kind: 'notFound',
          reason: `not found in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
        };
      }
      const shown = brShow({db: located.db, env}, beadId);
      if (shown.kind === 'failed') {
        return {kind: 'failed', reason: describeBrFailed(shown)};
      }
      if (shown.kind === 'notFound') {
        return {kind: 'notFound', reason: `not found in ${located.db}`};
      }
      return {
        bead: {
          id: shown.issue.id,
          labels: shown.issue.labels,
          notes: shown.issue.notes,
          title: shown.issue.title,
        },
        kind: 'found',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** One link in words, from the earlier session's side. */
export function linkWords(
  state: ChainLinkState,
  earlier: string,
  later: string,
): string {
  switch (state) {
    case 'complete':
      return `linked (${CONTINUED_BY_LABEL_PREFIX}${later} on ${earlier}, ${CONTINUES_LABEL_PREFIX}${earlier} on ${later})`;
    case 'onlyContinues':
      return `⚠️ half-written link: ${later} has ${CONTINUES_LABEL_PREFIX}${earlier}, but ${earlier} has no ${CONTINUED_BY_LABEL_PREFIX}${later}`;
    case 'onlyContinued':
      return `⚠️ half-written link: ${earlier} has ${CONTINUED_BY_LABEL_PREFIX}${later}, but ${later} has no ${CONTINUES_LABEL_PREFIX}${earlier}`;
  }
}

/** The unattended-handoff count line, from walkUnattendedChain's answer. */
export type UnattendedCountView =
  | {count: number; kind: 'counted'; newest: string}
  | {kind: 'unknown'; newest: string | null; reason: string};

export function unattendedWords(view: UnattendedCountView): string {
  if (view.kind === 'counted') {
    return `${view.count}, counted back from ${view.newest}, the newest session`;
  }
  return view.newest == null
    ? `unknown: ${view.reason}`
    : `unknown, counted back from ${view.newest}: ${view.reason}`;
}

/**
 * The "Handoff chain" section's lines (plain text; the caller indents and
 * paints). Each session: its number, bead id, title and when it handed off,
 * then the link to the next one; then the unattended count and any problem.
 */
export function chainLines(
  chain: HandoffChainView,
  unattended: UnattendedCountView,
): string[] {
  const lines: string[] = [];
  for (const [index, node] of chain.nodes.entries()) {
    const self = index === chain.selfIndex ? ' (this session)' : '';
    const item: string[] = [
      `${index + 1}. ${node.beadId}${self}: "${node.title}"`,
      `   handed off: ${node.handedOffAt ?? 'no'}`,
    ];
    if (node.refusal != null) item.push(`   ${node.refusal}`);
    const link = chain.links[index];
    const next = chain.nodes[index + 1];
    if (link != null && next != null) {
      item.push(
        `   link to ${index + 2}: ${linkWords(link, node.beadId, next.beadId)}`,
      );
    }
    lines.push(item.join('\n'));
  }
  lines.push(
    `Handoffs in a row since Justin last typed: ${unattendedWords(unattended)}`,
  );
  for (const problem of chain.problems) {
    lines.push(`⚠️ The chain is incomplete: ${problem}`);
  }
  return lines;
}
