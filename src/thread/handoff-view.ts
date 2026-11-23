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

import type {BackStep, ContinuingLookup, ForwardStep} from './chain-step';
import type {EnvLike} from './paths';

import {brShow, describeBrFailed, findBeadsWorkspace} from '../beads/br';
import {stepBack, stepForward} from './chain-step';
import {CHAIN_WALK_LIMIT} from './handoff-chain';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  HANDOFF_DEFERRED_LABEL,
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

/** The words every deferral line starts with (recordDeferral writes them). */
export const HANDOFF_DEFERRED_WORDS = 'handoff deferred:';

/**
 * A handoff that did not start a successor and has not been followed by one:
 * what `thread inbox --json` gives each session (home-base-89c8h.3).
 */
export interface HandoffStop {
  /** The note line's stamp, as written; null when no line was readable. */
  at: string | null;
  /** The line's detail, or what the bead says when no line was readable. */
  detail: string;
  /** The reason the line names; null when no line was readable. */
  reason: string | null;
  state: 'deferred' | 'refused';
}

/** recordRefusal's and recordDeferral's line: "- <stamp>: <words> <reason> — <detail>". */
const HANDOFF_STOP_LINE =
  /^- (.+?): handoff (refused|deferred): (\S+) — (.*)$/u;

/**
 * Why a handoff stopped short, from the bead's labels and its newest note line
 * for a label it carries. Null when it carries neither label, or when a
 * successor is linked: then the stop is history, the rule statusWithRefusal
 * uses. A pass removes handoff-deferred, so an old deferred line alone is
 * nothing. A label with no readable line says so, and is never null (rule 7).
 */
export function handoffStopOf(
  labels: readonly string[],
  notes: string | null,
): HandoffStop | null {
  if (continuedByOf(labels).length > 0) return null;
  const refused = labels.includes(HANDOFF_REFUSED_LABEL);
  const deferred = labels.includes(HANDOFF_DEFERRED_LABEL);
  if (!refused && !deferred) return null;
  const lines = (notes ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HANDOFF_STOP_LINE.exec(lines[index] ?? '');
    const state = match?.[2];
    if (state === 'refused' ? refused : state === 'deferred' && deferred) {
      return {
        at: match?.[1] ?? null,
        detail: match?.[4] ?? '',
        reason: match?.[3] ?? null,
        state: state === 'refused' ? 'refused' : 'deferred',
      };
    }
  }
  const label = refused ? HANDOFF_REFUSED_LABEL : HANDOFF_DEFERRED_LABEL;
  const words = refused ? HANDOFF_REFUSED_WORDS : HANDOFF_DEFERRED_WORDS;
  return {
    at: null,
    detail: `the session bead is labelled ${label}, but its notes hold no readable "${words}" line`,
    reason: null,
    state: refused ? 'refused' : 'deferred',
  };
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
  /** br's created_at, for the newest of two successors (home-base-1vcgs D3). */
  createdAt?: null | string;
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
  /**
   * The reverse search for a half-written link (home-base-lasun.1 F1): the
   * beads that carry `continues:<beadId>`, asked at a bead with no
   * `continued-by:`. Absent where the walk models no reverse search
   * (overarching.ts's cached walk, tests written before it): the forward walk
   * then ends at a bead with no `continued-by:`, as it did before.
   */
  findContinuing?: (beadId: string) => ContinuingLookup;
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

/** A back step that stopped thread show's walk, in its words. */
function backWords(
  step: Exclude<BackStep<ChainViewBead>, {kind: 'next' | 'root'}>,
  currentId: string,
  startBeadId: string,
  limit: number,
): string {
  switch (step.kind) {
    case 'loop':
      return `the chain loops back to ${step.id}`;
    case 'tooLong':
      return `the chain is longer than ${limit} sessions before ${startBeadId}; the walk stopped at ${currentId}`;
    case 'twoPredecessors':
      return `${currentId} names ${step.ids.length} predecessors (${step.ids.map((id) => `${CONTINUES_LABEL_PREFIX}${id}`).join(', ')}), so the chain before it is not shown`;
    case 'unreadable':
      return `${currentId} names ${CONTINUES_LABEL_PREFIX}${step.id}, but ${step.id} could not be read: ${step.read.reason}`;
  }
}

/** A forward step that stopped thread show's walk, in its words. */
function forwardWords(
  step: Exclude<ForwardStep<ChainViewBead>, {kind: 'end' | 'next'}>,
  currentId: string,
  startBeadId: string,
  limit: number,
): string {
  switch (step.kind) {
    case 'loop':
      return `the chain loops back to ${step.id}`;
    case 'reverseFailed':
      return `could not check whether a session continues ${currentId} (it has no ${CONTINUED_BY_LABEL_PREFIX} label): ${step.reason}`;
    case 'tooLong':
      return `the chain is longer than ${limit} sessions after ${startBeadId}; the walk stopped at ${currentId}`;
    case 'twoContinuing':
      return `${step.ids.length} sessions carry ${CONTINUES_LABEL_PREFIX}${currentId} (${step.ids.join(', ')}), so the chain after it is not shown`;
    case 'twoSuccessors':
      return `${currentId} names ${step.ids.length} successors (${step.ids.map((id) => `${CONTINUED_BY_LABEL_PREFIX}${id}`).join(', ')}), so the chain after it is not shown`;
    case 'unreadable':
      return step.via === 'continues'
        ? `${step.id} carries ${CONTINUES_LABEL_PREFIX}${currentId}, but ${step.id} could not be read: ${step.read.reason}`
        : `${currentId} names ${CONTINUED_BY_LABEL_PREFIX}${step.id}, but ${step.id} could not be read: ${step.read.reason}`;
  }
}

/**
 * The whole chain through `startBeadId`: back through `continues:` to the
 * first session, forward through `continued-by:` to the newest, and, at a
 * bead with no `continued-by:`, through the reverse search when the readers
 * have one (home-base-lasun.1 F1). A neighbour is followed through whichever
 * half of the link exists, and the state of every link is kept. The steps
 * are chain-step.ts's, shared with every chain reader.
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

  const before: {beads: ChainViewBead[]; links: ChainLinkState[]} = {
    beads: [],
    links: [],
  };
  for (let current = start.bead; ; ) {
    const step = stepBack(
      current,
      {limit, seen, taken: before.beads.length},
      readers.showBead,
    );
    if (step.kind === 'root') break;
    if (step.kind === 'next') {
      before.beads.push(step.bead);
      before.links.push(step.link);
      current = step.bead;
      continue;
    }
    problems.push(backWords(step, current.id, startBeadId, limit));
    break;
  }

  const {findContinuing} = readers;
  const after: {beads: ChainViewBead[]; links: ChainLinkState[]} = {
    beads: [],
    links: [],
  };
  for (let current = start.bead; ; ) {
    const step = stepForward(
      current,
      {limit, seen, taken: after.beads.length},
      {
        findContinuing:
          findContinuing == null ? null : (bead) => findContinuing(bead.id),
        readBead: readers.showBead,
      },
    );
    if (step.kind === 'end') break;
    if (step.kind === 'next') {
      after.beads.push(step.bead);
      after.links.push(step.link);
      current = step.bead;
      continue;
    }
    problems.push(forwardWords(step, current.id, startBeadId, limit));
    break;
  }
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
          createdAt: shown.issue.createdAt,
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
