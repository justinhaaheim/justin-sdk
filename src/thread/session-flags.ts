/**
 * Justin's flags on a session: a SET of emoji marks, ⭐ by default
 * (home-base-kwand.5, gap G6 of epic home-base-kwand; decision D4, from
 * Justin's answer to Q173 on 2026-11-17: "a session can have an arbitrary
 * number of marks/emojis turned on/off. Default is ⭐️. … model it as a set").
 *
 * FLAGS IN CODE, MARKS TO JUSTIN. `SessionCard.marks` (session-name.ts) is
 * already the chain name, handoff number and mayor role that the tab title
 * shows. These are something else, so the code and the JSON call them flags.
 *
 * STORAGE (D4). One label per flag on the SESSION bead: `mark:<code points>`,
 * the emoji's Unicode code points in lowercase hex joined by `-`, after the
 * variation selectors U+FE0F and U+FE0E are dropped. br allows only letters,
 * digits, hyphen, underscore and colon in a label (measured 2026-11-17:
 * `mark:⭐` refused), and at most BR_LABEL_MAX characters. ⭐ and ⭐️ are one
 * flag, `mark:2b50`. Decoding is generic, so any emoji works with no code
 * change. A `mark:` label that does not decode is ignored and reported, never
 * thrown; so is one that is not in the canonical spelling (`mark:02b50`),
 * because removing a flag removes the canonical label only and a star that
 * could never be cleared would be worse than one that is reported.
 *
 * CHAINS (D4). A chain (a session and its handed-off successors) shows the
 * union of its sessions' flags. Adding a flag adds it to the chain's NEWEST
 * session; removing one removes it from EVERY session of the chain, so the
 * union loses it. A walk that cannot read the whole chain is refused before
 * anything is written: its newest session, or which sessions hold the flag,
 * would be a guess (critical rule 7).
 *
 * UNDO. Each change is one `flag` record in marks-undo.jsonl, written BEFORE
 * the first br write; a change whose record cannot be written is refused.
 * `thread unmark --mark <id>` reverses it, which is what the dashboard's `u`
 * runs (D-GMAIL-KEYS).
 *
 * Exit: 0 written, or nothing to change · 1 not written (the reason is
 * printed) · 2 usage.
 */

import type {EnvLike} from './paths';

import {brUpdate, describeBrFailed, findBeadsWorkspace} from '../beads/br';
import {
  realChainWalkReaders,
  registryChainNames,
  resolveChainStart,
  walkChain,
} from './chain-walk';
import {appendMarkUndo, undoLine} from './marks-undo';
import {
  BR_LABEL_MAX,
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  SESSION_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {locateSessionBead} from './session-handoff';

// ---------------------------------------------------------------------------
// Encoding and decoding (D4)
// ---------------------------------------------------------------------------

export const FLAG_LABEL_PREFIX = 'mark:';

/** The default flag: U+2B50. Justin types it ⭐️ (with U+FE0F); both are one flag. */
export const STAR = '⭐';

/** STAR's label; a test holds it equal to `encodeFlag(STAR)`. */
export const STAR_LABEL = 'mark:2b50';

const VARIATION_SELECTORS = new Set([0xfe0e, 0xfe0f]);
const KEYCAP = 0x20e3;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const PRESENTATION = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPH_ONE = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/u;
const CANONICAL_BODY = /^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6})*$/u;
const GRAPHEMES = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

function codePointsOf(text: string): number[] {
  const points: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0);
    if (point != null) points.push(point);
  }
  return points;
}

/**
 * One emoji: a single grapheme holding a pictograph, a regional indicator
 * (a flag of a country) or a keycap. Plain text such as `x` is not one.
 */
export function isOneEmoji(text: string): boolean {
  if (text === '') return false;
  if ([...GRAPHEMES.segment(text)].length !== 1) return false;
  return PICTOGRAPHIC.test(text) || codePointsOf(text).includes(KEYCAP);
}

export type EncodedFlag =
  | {kind: 'ok'; label: string}
  | {kind: 'refused'; reason: string};

/** The label for an emoji (D4), or why it cannot be one. */
export function encodeFlag(emoji: string): EncodedFlag {
  const points = codePointsOf(emoji.trim()).filter(
    (point) => !VARIATION_SELECTORS.has(point),
  );
  const bare = String.fromCodePoint(...points);
  if (!isOneEmoji(bare)) {
    return {
      kind: 'refused',
      reason: `${JSON.stringify(emoji)} is not one emoji`,
    };
  }
  const label = `${FLAG_LABEL_PREFIX}${points.map((point) => point.toString(16)).join('-')}`;
  if (label.length > BR_LABEL_MAX) {
    return {
      kind: 'refused',
      reason: `${emoji} needs the label ${label}, which is ${label.length} characters, and br takes at most ${BR_LABEL_MAX}`,
    };
  }
  return {kind: 'ok', label};
}

/**
 * The emoji to show for code points with the variation selectors dropped.
 * U+FE0F goes back after a pictograph whose default is text style (❤ U+2764),
 * unless a skin-tone modifier follows it, and before a keycap's U+20E3: the
 * places a terminal needs it to draw the emoji in colour.
 */
export function displayFlag(points: readonly number[]): string {
  let text = '';
  for (const [index, point] of points.entries()) {
    const char = String.fromCodePoint(point);
    const next = points[index + 1];
    const nextChar = next == null ? null : String.fromCodePoint(next);
    text += char;
    if (next === KEYCAP && KEYCAP_BASE.test(char)) {
      text += '️';
      continue;
    }
    if (
      PICTOGRAPH_ONE.test(char) &&
      !PRESENTATION.test(char) &&
      (nextChar == null || !MODIFIER.test(nextChar))
    ) {
      text += '️';
    }
  }
  return text;
}

export type FlagLabelRead =
  | {emoji: string; kind: 'flag'; label: string}
  | {kind: 'notAFlag'}
  | {kind: 'undecodable'; label: string; reason: string};

/** What one label says: a flag, not a flag, or a `mark:` label that does not decode. */
export function decodeFlagLabel(label: string): FlagLabelRead {
  if (!label.startsWith(FLAG_LABEL_PREFIX)) return {kind: 'notAFlag'};
  const body = label.slice(FLAG_LABEL_PREFIX.length);
  if (!CANONICAL_BODY.test(body)) {
    return {
      kind: 'undecodable',
      label,
      reason: 'it is not lowercase hex code points joined by "-"',
    };
  }
  const points = body.split('-').map((hex) => Number.parseInt(hex, 16));
  const bad = points.find(
    (point) =>
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff) ||
      VARIATION_SELECTORS.has(point),
  );
  if (bad != null) {
    return {
      kind: 'undecodable',
      label,
      reason: `${bad.toString(16)} is not a code point a flag can hold`,
    };
  }
  const bare = String.fromCodePoint(...points);
  const again = encodeFlag(bare);
  if (again.kind === 'refused') {
    return {kind: 'undecodable', label, reason: again.reason};
  }
  if (again.label !== label) {
    return {
      kind: 'undecodable',
      label,
      reason: `it is not spelled the way a flag is written (${again.label}), so removing the flag would not remove it`,
    };
  }
  return {emoji: displayFlag(points), kind: 'flag', label};
}

/** A session's flags, or a chain's: the set, as labels and as emoji. */
export interface FlagSet {
  /** Each flag as the emoji to show, in the order of `labels`. */
  emoji: string[];
  /** The `mark:` labels, sorted, each once. */
  labels: string[];
  /** `mark:` labels that do not decode, each with why: ignored, and reported. */
  undecodable: {label: string; reason: string}[];
}

/** The union of several beads' labels' flags (D4: a chain shows the union). */
export function unionFlagSets(
  labelSets: readonly (readonly string[])[],
): FlagSet {
  const flags = new Map<string, string>();
  const undecodable = new Map<string, string>();
  for (const labels of labelSets) {
    for (const label of labels) {
      const read = decodeFlagLabel(label);
      if (read.kind === 'flag') flags.set(read.label, read.emoji);
      if (read.kind === 'undecodable') undecodable.set(read.label, read.reason);
    }
  }
  const sorted = [...flags.keys()].sort();
  return {
    emoji: sorted.map((label) => flags.get(label) ?? ''),
    labels: sorted,
    undecodable: [...undecodable.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, reason]) => ({label, reason})),
  };
}

/** The flags in a set of labels, plus the `mark:` labels that do not decode. */
export function flagsOfLabels(labels: readonly string[]): FlagSet {
  return unionFlagSets([labels]);
}

// ---------------------------------------------------------------------------
// A chain's flags, for the inbox
// ---------------------------------------------------------------------------

/** Every chain's member cap; past it the union says it stopped. */
export const CHAIN_FLAGS_LIMIT = 200;

/** A chain's union, and the sessions whose flags could not be read. */
export interface ChainFlags extends FlagSet {
  /** Each session of the chain whose labels could not be read, with why: the union may lack its flags. */
  problems: string[];
}

/**
 * The union of the flags of every session bead linked to `startId` by a
 * handoff (`continues:`, `continued-by:`, and beads whose `continues:` names
 * it), read from what one inbox run holds. A bead it cannot read is named in
 * `problems`, never left out silently (rule 7).
 */
export function chainFlagsOf(input: {
  /** The beads that carry `continues:<beadId>`. */
  continuing: (beadId: string) => readonly string[];
  labelsOf: (
    beadId: string,
  ) =>
    | {kind: 'found'; labels: readonly string[]}
    | {kind: 'unknown'; reason: string};
  startId: string;
}): ChainFlags {
  const seen = new Set<string>([input.startId]);
  const queue = [input.startId];
  const labelSets: (readonly string[])[] = [];
  const problems: string[] = [];
  for (let id = queue.shift(); id != null; id = queue.shift()) {
    const read = input.labelsOf(id);
    if (read.kind === 'unknown') {
      problems.push(`${id}: ${read.reason}`);
      continue;
    }
    labelSets.push(read.labels);
    const linked = [
      ...read.labels
        .filter(
          (label) =>
            label.startsWith(CONTINUES_LABEL_PREFIX) ||
            label.startsWith(CONTINUED_BY_LABEL_PREFIX),
        )
        .map((label) => label.slice(label.indexOf(':') + 1)),
      ...input.continuing(id),
    ];
    for (const next of linked) {
      if (seen.has(next)) continue;
      if (seen.size >= CHAIN_FLAGS_LIMIT) {
        problems.push(
          `the chain has more than ${CHAIN_FLAGS_LIMIT} sessions; ${next} and any beyond it were not read`,
        );
        queue.length = 0;
        break;
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return {...unionFlagSets(labelSets), problems};
}

// ---------------------------------------------------------------------------
// thread star / unstar / flag
// ---------------------------------------------------------------------------

export type FlagOp = 'add' | 'remove';

/** A chain member, oldest first, as the command needs it. */
export interface FlagChainMember {
  beadId: string;
  /** The Claude session id from its one `sid:` label; null when unknown. */
  sessionId: null | string;
}

export type FlagChainRead =
  | {kind: 'chain'; members: FlagChainMember[]}
  | {kind: 'failed'; reason: string};

export type FlagBeadRead =
  | {db: string; kind: 'found'; labels: readonly string[]; title: string}
  | {kind: 'failed'; reason: string};

/** What the command reads and writes; injected, so tests choose each answer. */
export interface FlagDeps {
  /** The chain a ref names (a chain name, a session id or its first 8+ characters, a bead id), oldest first. */
  chainOf: (ref: string) => FlagChainRead;
  /** One session bead, read NOW from the beads DB that holds it, in any repo. */
  locate: (beadId: string) => FlagBeadRead;
  update: (
    db: string,
    beadId: string,
    change: {addLabels?: string[]; removeLabels?: string[]},
  ) => {kind: 'failed'; reason: string} | {kind: 'ok'};
}

export interface FlagSessionOptions {
  cwd?: string;
  deps?: FlagDeps;
  emoji: string;
  env?: EnvLike;
  op: FlagOp;
  ref: null | string;
}

/** One bead's label change, as written and as the undo record holds it. */
export interface FlagChange {
  added: string[];
  db: string;
  id: string;
  removed: string[];
  title: string;
}

export type FlagSessionOutcome =
  | {
      emoji: string;
      /** The br writes that failed, each named; the undo record covers them too. */
      failures: string[];
      kind: 'changed';
      label: string;
      op: FlagOp;
      undoId: string;
      /** The changes br made. */
      written: FlagChange[];
    }
  | {
      emoji: string;
      kind: 'unchanged';
      label: string;
      op: FlagOp;
      /** The bead(s) looked at, for the line that says nothing changed. */
      targets: {id: string; title: string}[];
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'usage'; message: string};

function sidOf(labels: readonly string[]): null | string {
  const sids = labels.filter((label) => label.startsWith(SID_LABEL_PREFIX));
  const [only] = sids;
  return sids.length === 1 && only != null
    ? only.slice(SID_LABEL_PREFIX.length)
    : null;
}

/** The real reads and writes: the one chain walk, br through the DB the index names. */
export function realFlagDeps(input: {cwd: string; env: EnvLike}): FlagDeps {
  const {cwd, env} = input;
  const space = findBeadsWorkspace(cwd);
  const fallbackDbs = space.kind === 'found' ? [space.db] : [];
  return {
    chainOf: (ref) => {
      const readers = realChainWalkReaders({cwd, env});
      const start = resolveChainStart({env, readers, value: ref});
      if (start.kind === 'failed') return start;
      const walk = walkChain(start.beadId, readers, {
        chainNameOfRoot: registryChainNames(env),
      });
      if (walk.kind === 'failed') return walk;
      if (walk.kind === 'incomplete') {
        return {
          kind: 'failed',
          reason: `the chain of ${start.beadId} could not be read whole, so its newest session and the sessions holding the flag are unknown: ${walk.problems.join('; ')}`,
        };
      }
      return {
        kind: 'chain',
        members: walk.members.map((member) => ({
          beadId: member.beadId,
          sessionId: member.sessionId,
        })),
      };
    },
    locate: (beadId) => {
      const located = locateSessionBead(beadId, env, fallbackDbs);
      if (located.kind === 'failed') return located;
      if (located.kind === 'notFound') {
        return {
          kind: 'failed',
          reason: `${beadId} was not found in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
        };
      }
      return {
        db: located.db,
        kind: 'found',
        labels: located.labels,
        title: located.title,
      };
    },
    update: (db, beadId, change) => {
      const written = brUpdate({db, env}, beadId, change);
      return written.kind === 'ok'
        ? written
        : {kind: 'failed', reason: describeBrFailed(written)};
    },
  };
}

/**
 * Add or remove one flag on the chain `ref` names (D4). Every bead is read
 * before the first write, and the undo record is written before it too.
 */
export function flagSession(options: FlagSessionOptions): FlagSessionOutcome {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const ref = options.ref?.trim() ?? '';
  if (ref === '') {
    return {
      kind: 'usage',
      message:
        'name the session: its session bead id, its claude session id (or the first 8 or more characters of it), or its chain name',
    };
  }
  const encoded = encodeFlag(options.emoji);
  if (encoded.kind === 'refused') {
    return {kind: 'usage', message: encoded.reason};
  }
  const {label} = encoded;
  const emoji = flagsOfLabels([label]).emoji[0] ?? options.emoji;
  const deps = options.deps ?? realFlagDeps({cwd, env});
  const chain = deps.chainOf(ref);
  if (chain.kind === 'failed') {
    return {kind: 'failed', reason: `nothing was written: ${chain.reason}`};
  }
  const newest = chain.members.at(-1);
  if (newest == null) {
    return {
      kind: 'failed',
      reason: `nothing was written: ${ref} names a chain with no sessions`,
    };
  }
  // add: the newest session only; remove: every session of the chain.
  const targets = options.op === 'add' ? [newest] : chain.members;
  const read: {bead: Extract<FlagBeadRead, {kind: 'found'}>; id: string}[] = [];
  for (const member of targets) {
    const bead = deps.locate(member.beadId);
    if (bead.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `nothing was written: session bead ${member.beadId} could not be read: ${bead.reason}`,
      };
    }
    if (!bead.labels.includes(SESSION_LABEL)) {
      return {
        kind: 'failed',
        reason: `nothing was written: ${member.beadId} is not a session bead (it has no "${SESSION_LABEL}" label)`,
      };
    }
    read.push({bead, id: member.beadId});
  }
  const changes = read.flatMap(({bead, id}): FlagChange[] => {
    const has = bead.labels.includes(label);
    if (options.op === 'add' && !has) {
      return [
        {added: [label], db: bead.db, id, removed: [], title: bead.title},
      ];
    }
    if (options.op === 'remove' && has) {
      return [
        {added: [], db: bead.db, id, removed: [label], title: bead.title},
      ];
    }
    return [];
  });
  if (changes.length === 0) {
    return {
      emoji,
      kind: 'unchanged',
      label,
      op: options.op,
      targets: read.map(({bead, id}) => ({id, title: bead.title})),
    };
  }
  const newestRead = read.find(({id}) => id === newest.beadId);
  const recorded = appendMarkUndo(
    {
      at: new Date().toISOString(),
      closed: [],
      labelChanges: changes.map(({added, db, id, removed}) => ({
        added,
        db,
        id,
        removed,
      })),
      labelsAdded: [],
      leftWithOthers: [],
      mode: 'flag',
      released: [],
      sessionBeadId: newest.beadId,
      // The newest session's DB; unread for a flag record, kept for the shape.
      sessionDb: newestRead?.bead.db ?? changes[0]?.db ?? '',
      // `thread unmark --session <id>` finds the record by this. '' when the
      // newest bead names no single session: never a session id, so no
      // selector matches it, and `--mark <id>` still does.
      sessionId:
        newest.sessionId ??
        (newestRead == null ? null : sidOf(newestRead.bead.labels)) ??
        '',
    },
    env,
  );
  if (recorded.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `nothing was written: the undo record could not be written, and a change \`thread unmark\` could not reverse is refused: ${recorded.error}`,
    };
  }
  const failures: string[] = [];
  const written: FlagChange[] = [];
  for (const change of changes) {
    const result = deps.update(change.db, change.id, {
      ...(change.added.length > 0 ? {addLabels: change.added} : {}),
      ...(change.removed.length > 0 ? {removeLabels: change.removed} : {}),
    });
    if (result.kind === 'failed') {
      failures.push(
        `${change.id} (${change.title}) was NOT changed: ${result.reason}`,
      );
    } else {
      written.push(change);
    }
  }
  return {
    emoji,
    failures,
    kind: 'changed',
    label,
    op: options.op,
    undoId: recorded.id,
    written,
  };
}

export function describeFlagOutcome(
  command: string,
  outcome: FlagSessionOutcome,
): {exitCode: 0 | 1 | 2; lines: string[]} {
  switch (outcome.kind) {
    case 'usage':
      return {exitCode: 2, lines: [`${command}: ${outcome.message}`]};
    case 'failed':
      return {exitCode: 1, lines: [`${command}: ${outcome.reason}`]};
    case 'unchanged': {
      const what =
        outcome.op === 'add'
          ? `already has ${outcome.emoji}`
          : `has no ${outcome.emoji} on any of its sessions`;
      const names = outcome.targets
        .map((target) => `${target.id} "${target.title}"`)
        .join(', ');
      return {
        exitCode: 0,
        lines: [`${command}: nothing to change: ${names} ${what}`],
      };
    }
    case 'changed': {
      const verb = outcome.op === 'add' ? 'added to' : 'removed from';
      const lines = outcome.written.map(
        (change) =>
          `${outcome.emoji} ${verb} session ${change.id} "${change.title}" (${outcome.label})`,
      );
      if (outcome.failures.length > 0) {
        lines.push('', '⚠️ Not changed:', '');
        for (const failure of outcome.failures)
          lines.push(`  - ${failure}`, '');
      }
      // Printed on a partial failure too: the record was written first.
      lines.push('', undoLine(outcome.undoId));
      return {exitCode: outcome.failures.length > 0 ? 1 : 0, lines};
    }
  }
}

export function runThreadFlag(
  command: string,
  options: FlagSessionOptions,
): number {
  const {exitCode, lines} = describeFlagOutcome(command, flagSession(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
