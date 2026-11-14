/**
 * How a chain's name is spelled (home-base-l2ejg.11, D5 in home-base-l2ejg.3).
 * Pure: no file, no br. The registry that hands names out is chain-names.ts.
 *
 * A name is a pool name (chain-name-pool.ts) and a generation. Generation 1 is
 * the name alone, `Moe`. Once every pool name is taken, the next generation
 * adds a Roman numeral: `Moe II`, then `Moe III`. No digits, so it cannot be
 * confused with the handoff number in the same mark (`[Moe II-4]`).
 *
 * Three spellings of one name:
 *   text   `Moe II`        in titles and in the registry
 *   label  `chain:Moe_II`  on session beads; a br label holds no space
 *   mark   `[Moe II-4]`    in a session name (session-name.ts builds it)
 */

import {CHAIN_NAME_POOL} from './chain-name-pool';
import {CHAIN_NAME_LABEL_PREFIX} from './session-bead';

export interface ChainName {
  /** A pool name: a capital, then lower-case letters. */
  base: string;
  /** 1 for the name alone, 2 for `II`, and so on. */
  generation: number;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** `n` in Roman numerals, for n from 1. */
export function romanNumeral(n: number): string {
  let rest = n;
  let text = '';
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      text += numeral;
      rest -= value;
    }
  }
  return text;
}

/** The value of a Roman numeral this file writes, or null for anything else. */
function romanValue(text: string): null | number {
  if (!/^[IVXLCDM]+$/u.test(text)) return null;
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const here = ROMAN.find(([, numeral]) => numeral === text[index])?.[0];
    const next = ROMAN.find(([, numeral]) => numeral === text[index + 1])?.[0];
    if (here == null) return null;
    value += next != null && next > here ? -here : here;
  }
  // Only the canonical spelling reads: "IIII" or "VX" is not one we wrote.
  return value >= 1 && romanNumeral(value) === text ? value : null;
}

/** `Moe`, or `Moe II` from generation 2. */
export function chainNameText(name: ChainName): string {
  return name.generation <= 1
    ? name.base
    : `${name.base} ${romanNumeral(name.generation)}`;
}

/** The label: `chain:Moe`, or `chain:Moe_II`. */
export function chainNameLabel(name: ChainName): string {
  return `${CHAIN_NAME_LABEL_PREFIX}${chainNameText(name).replace(' ', '_')}`;
}

/** The pool names, for the parser's membership check. */
const POOL = new Set(CHAIN_NAME_POOL);

const NAME_SHAPE = /^([A-Z][a-z]+)(?:[ _]([IVXLCDM]+))?$/u;

/**
 * A name in its text (`Moe II`) or label-value (`Moe_II`) spelling, or null.
 * `pool` decides which bases count; by default the real pool, so text that
 * merely looks like a name (`[HOME][Notes] …`) is never read as the tool's.
 * A generation of 1 is never spelled `I`, so `Moe I` is null.
 */
export function parseChainName(
  text: string,
  pool: ReadonlySet<string> = POOL,
): ChainName | null {
  const match = NAME_SHAPE.exec(text);
  if (match == null) return null;
  const [, base, numeral] = match;
  if (base == null || !pool.has(base)) return null;
  if (numeral == null) return {base, generation: 1};
  const generation = romanValue(numeral);
  return generation == null || generation < 2 ? null : {base, generation};
}

/** What a bead's `chain:` labels say. */
export type ChainNameLabels =
  | {kind: 'none'}
  | {kind: 'one'; name: ChainName}
  /** Two different names, or one that is not a pool name: never a guess. */
  | {kind: 'unreadable'; reason: string};

/**
 * The chain name the labels hold. The same label twice counts once. Two
 * different names happen when a session named as its own chain is later
 * linked to a predecessor (the link adds the predecessor's): the capture's
 * self-heal resolves that, and until then the name is not shown.
 */
export function chainNameOfLabels(labels: readonly string[]): ChainNameLabels {
  const values = [
    ...new Set(
      labels
        .filter((label) => label.startsWith(CHAIN_NAME_LABEL_PREFIX))
        .map((label) => label.slice(CHAIN_NAME_LABEL_PREFIX.length)),
    ),
  ];
  const [only] = values;
  if (only == null) return {kind: 'none'};
  if (values.length > 1) {
    return {
      kind: 'unreadable',
      reason: `the bead has ${values.length} ${CHAIN_NAME_LABEL_PREFIX} labels (${values.join(', ')})`,
    };
  }
  const name = parseChainName(only);
  return name == null
    ? {
        kind: 'unreadable',
        reason: `the label ${CHAIN_NAME_LABEL_PREFIX}${only} is not a chain name`,
      }
    : {kind: 'one', name};
}

/** Whether two names are the same name. */
export function sameChainName(a: ChainName, b: ChainName): boolean {
  return a.base === b.base && a.generation === b.generation;
}
