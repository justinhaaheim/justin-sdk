/**
 * CLI STYLE — the one place SDK command output gets its colour, its spacing,
 * its indentation and its wrapping (home-base-k0b8n.10, epic K11).
 *
 * Justin, 2026-09-23: "when in doubt USE EMPTY LINES. It's much better to have
 * too many empty lines than too few." His reference is a man page (`man cp`):
 * section headers near the left edge in bold colour, everything else indented
 * under them, a blank line between every item, wrapped lines hanging at the
 * body's indent, colour on the words that matter. The rules are K11 on epic
 * home-base-k0b8n; home-base's CLAUDE.md carries the short form. This module is
 * the primitives, so every command gets the same style from one place instead
 * of hand-rolling escape codes and padding again.
 *
 * THE COLUMNS. Section headers at HEADER_COLUMN (2), body at BODY_COLUMN (6),
 * nested detail (an ask's context, its options, its default) at DETAIL_COLUMN
 * (9). Only headers and a glance line sit left of the body.
 *
 * TWO GATES, DELIBERATELY SEPARATE:
 *  - `shouldStyle` decides COLOUR: NO_COLOR wins, FORCE_COLOR forces, otherwise
 *    only a TTY gets escapes. Piped output is what Claude reads, and an escape
 *    code there is noise it has to parse past.
 *  - `terminalWidth` decides WRAPPING: a TTY with known columns, or a
 *    FORCE_COLOR run with a numeric COLUMNS (the "render the terminal view into
 *    a file so it can be read" case). Anything else is null, and null means
 *    NEVER WRAP — critical rule 14: piped text is wrapped by whatever displays
 *    it, never by us.
 *
 * WHY WRAPPING GOES THROUGH A PARSER (measured 2026-09-23, bun 1.4.2).
 * `Bun.wrapAnsi` is the wrapper (a Bun built-in, so no dependency and no
 * hand-rolled width math), but at a wrap point it re-opens only the LAST SGR
 * code it saw: `ESC[1mESC[31m…` continues as red without bold, and a combined
 * `ESC[1;31m` is not re-opened at all. So `wrapHanging` splits styled text into
 * runs, lets Bun wrap the PLAIN text, and re-emits each run's full style on
 * every line it lands on, closing it before the line ends. Every wrapped line
 * therefore carries complete escapes of its own, and an underline can never
 * leak onto the indentation of the line below.
 */

/** A style this module knows how to emit. `accent` is the section-header colour. */
export type StyleName =
  | 'accent'
  | 'bold'
  | 'cyan'
  | 'dim'
  | 'green'
  | 'italic'
  | 'red'
  | 'underline'
  | 'yellow';

/** Where a stream is going. `process.stdout` satisfies it. */
export interface StyleStream {
  columns?: number;
  isTTY?: boolean;
}

/** The environment, read-only. `process.env` satisfies it. */
export type StyleEnv = Readonly<Record<string, string | undefined>>;

/** Section headers. */
export const HEADER_COLUMN = 2;
/** Everything a section says. */
export const BODY_COLUMN = 6;
/** What belongs to one body item: an ask's context, options and default. */
export const DETAIL_COLUMN = 9;
/** No line is wrapped wider than this, however wide the terminal is (K11 3). */
export const MAX_WIDTH = 120;
/**
 * Below this many columns of text, wrapping makes output worse, not better —
 * one word per line under a deep indent — so the line is left whole.
 */
const MIN_WRAP_COLUMNS = 20;

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

/**
 * The SGR parameter for each style.
 *
 * Accent is MAGENTA because every other colour already means something here
 * (K11 rule 4): red is P0 and mistakes, yellow is P1 and unknowns, green is the
 * recommended option, cyan is a command you can run.
 */
const SGR: Record<StyleName, string> = {
  accent: '35',
  bold: '1',
  cyan: '36',
  dim: '2',
  green: '32',
  italic: '3',
  red: '31',
  underline: '4',
  yellow: '33',
};

function isSet(value: string | undefined): boolean {
  return value != null && value !== '';
}

/**
 * Whether this process should emit ANSI colour. Honours NO_COLOR (which wins)
 * and FORCE_COLOR; otherwise only an interactive terminal gets escapes.
 *
 * Moved here from repo-status/pretty.ts (k0b8n.10), unchanged in behaviour: it
 * was already the gate the thread renderers borrowed, and one gate in one place
 * is the point of this module.
 */
export function shouldStyle(
  stream: StyleStream = process.stdout,
  env: StyleEnv = process.env,
): boolean {
  if (isSet(env.NO_COLOR)) return false;
  if (isSet(env.FORCE_COLOR)) return true;
  return stream.isTTY === true;
}

/**
 * The column count a FORCE_COLOR run may borrow from COLUMNS, or null.
 *
 * Parsed strictly: `Number('')` is 0 and `parseInt('80x')` is 80, and neither
 * is a width anyone set (critical rule 7).
 */
function columnsFromEnv(env: StyleEnv): number | null {
  const raw = env.COLUMNS?.trim() ?? '';
  if (!/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : null;
}

/**
 * The width to wrap to, or null for "do not wrap".
 *
 * `min(columns − 2, 120)` on a TTY whose width is known. A non-TTY is null,
 * whatever COLUMNS says — unless FORCE_COLOR is set, which is an explicit
 * request for the terminal rendering and is how that rendering is captured to a
 * file for review (`FORCE_COLOR=1 COLUMNS=100 … > out.txt`).
 */
export function terminalWidth(
  stream: StyleStream = process.stdout,
  env: StyleEnv = process.env,
): number | null {
  let columns: number | null = null;
  if (
    stream.isTTY === true &&
    typeof stream.columns === 'number' &&
    stream.columns > 0
  ) {
    columns = stream.columns;
  } else if (isSet(env.FORCE_COLOR)) {
    columns = columnsFromEnv(env);
  }
  if (columns == null) return null;
  return Math.min(columns - 2, MAX_WIDTH);
}

/**
 * `text` in `styles`, or `text` unchanged when colour is off.
 *
 * Always closed with a full reset, so painted pieces can be concatenated freely.
 * Do NOT paint a string that already contains a painted piece: the inner reset
 * ends the outer style early. Compose side by side instead.
 */
export function paint(
  text: string,
  styles: readonly StyleName[],
  color: boolean,
): string {
  if (!color || styles.length === 0 || text === '') return text;
  return `${ESC}${styles.map((style) => SGR[style]).join(';')}m${text}${RESET}`;
}

/**
 * How one command run prints: whether it colours, and the width it wraps to
 * (null = never wrap). Decided once, from the stream it prints to, and passed
 * down — so a renderer is a pure function a test can call with `PLAIN_STYLE`.
 */
export interface OutputStyle {
  color: boolean;
  width: number | null;
}

/** No escapes, no wrapping: what a pipe gets, and what tests render. */
export const PLAIN_STYLE: OutputStyle = {color: false, width: null};

/** The style for `stream`: `shouldStyle` for colour, `terminalWidth` for wrapping. */
export function outputStyle(
  stream: StyleStream = process.stdout,
  env: StyleEnv = process.env,
): OutputStyle {
  return {color: shouldStyle(stream, env), width: terminalWidth(stream, env)};
}

/** Spaces. */
export function pad(columns: number): string {
  return ' '.repeat(Math.max(0, columns));
}

/**
 * The columns `text` occupies on a terminal: ANSI escapes count zero, an emoji
 * (including one carrying VS16, like ⚠️) counts two. `Bun.stringWidth` does the
 * measuring, so no width table is hand-rolled here.
 */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * `text` followed by enough spaces to fill `columns` DISPLAY columns — the
 * table-column pad that `String.padEnd` gets wrong for emoji and for painted
 * text. Never truncates: a value wider than the column pushes the rest right.
 */
export function padEndWidth(text: string, columns: number): string {
  return `${text}${pad(columns - displayWidth(text))}`;
}

/**
 * A section header at HEADER_COLUMN: at most one emoji, then the title in bold
 * accent (K11 rules 2, 4, 5).
 */
export function sectionHeader(
  title: string,
  options: {color: boolean; emoji?: string | null},
): string {
  const emoji =
    options.emoji == null || options.emoji === '' ? '' : `${options.emoji} `;
  return `${pad(HEADER_COLUMN)}${emoji}${paint(title, ['bold', 'accent'], options.color)}`;
}

/**
 * Blocks joined by exactly one blank line — the K11 rule-1 separator.
 * Empty blocks are dropped, so a caller never has to guard against a double
 * blank line.
 */
export function spacedList(blocks: readonly string[]): string {
  return blocks.filter((block) => block !== '').join('\n\n');
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** A run of text and the SGR parameters active over it. */
interface Run {
  codes: string[];
  text: string;
}

// Built with the constructor rather than a literal so the ESC byte is spelled
// once, and so eslint's no-control-regex does not fire on a deliberate match.
const SGR_PATTERN = new RegExp(`${ESC.replace('[', '\\[')}([0-9;]*)m`, 'gu');

const FOREGROUND = /^(?:3[0-7]|9[0-7]|38)$/u;

/** Apply one SGR parameter list to the active set. */
function applySgr(active: string[], params: string): string[] {
  let next = [...active];
  const codes = params === '' ? ['0'] : params.split(';');
  for (const code of codes) {
    if (code === '0' || code === '') next = [];
    else if (code === '22') next = next.filter((c) => c !== '1' && c !== '2');
    else if (code === '23') next = next.filter((c) => c !== '3');
    else if (code === '24') next = next.filter((c) => c !== '4');
    else if (code === '39') next = next.filter((c) => !FOREGROUND.test(c));
    else if (!next.includes(code)) next.push(code);
  }
  return next;
}

/** Split styled text into runs of plain text, each with its active style. */
function toRuns(text: string): Run[] {
  const runs: Run[] = [];
  let active: string[] = [];
  let last = 0;
  for (const match of text.matchAll(SGR_PATTERN)) {
    const index = match.index;
    if (index > last) {
      runs.push({codes: active, text: text.slice(last, index)});
    }
    active = applySgr(active, match[1] ?? '');
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({codes: active, text: text.slice(last)});
  return runs;
}

/** The styled text of plain range [start, end), every run closed. */
function emitRange(runs: readonly Run[], start: number, end: number): string {
  let out = '';
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    const from = Math.max(start, runStart);
    const to = Math.min(end, runEnd);
    if (from >= to) continue;
    const piece = run.text.slice(from - runStart, to - runStart);
    out +=
      run.codes.length === 0
        ? piece
        : `${ESC}${run.codes.join(';')}m${piece}${RESET}`;
  }
  return out;
}

type Wrapper = (text: string, columns: number, options: object) => string;

/**
 * `Bun.wrapAnsi`, when this Bun has it. It exists in bun-types 1.3.11 and in
 * the 1.4.2 measured here; nothing pins the Bun that consumer repos run, so an
 * older runtime degrades to UNWRAPPED output — the same content, one long line —
 * rather than a crash.
 */
function bunWrapper(): Wrapper | null {
  const candidate = (Bun as {wrapAnsi?: Wrapper}).wrapAnsi;
  return typeof candidate === 'function' ? candidate : null;
}

/**
 * The [start, end) ranges of `plain` that the wrapper breaks it into.
 *
 * Each wrapped line is located back in the original, skipping only the
 * whitespace the wrapper trimmed at the break. Null when a line cannot be
 * located — the caller then prints the line unwrapped rather than guessing.
 */
function lineRanges(
  plain: string,
  wrapped: readonly string[],
): [number, number][] | null {
  const ranges: [number, number][] = [];
  let cursor = 0;
  for (const line of wrapped) {
    while (cursor < plain.length && /\s/u.test(plain[cursor] ?? '')) {
      cursor += 1;
    }
    if (line === '') continue;
    if (!plain.startsWith(line, cursor)) return null;
    ranges.push([cursor, cursor + line.length]);
    cursor += line.length;
  }
  return ranges;
}

export interface WrapOptions {
  /** Column continuation lines start at. */
  hang: number;
  /** Column the first line starts at. */
  indent: number;
  /** Wrap width, or null to print the text UNWRAPPED (every non-TTY). */
  width: number | null;
}

function wrapOne(text: string, options: WrapOptions): string {
  const {hang, indent, width} = options;
  const unwrapped = `${pad(indent)}${text}`;
  if (text === '') return '';
  if (width == null) return unwrapped;
  const firstColumns = width - indent;
  const restColumns = width - hang;
  if (Math.min(firstColumns, restColumns) < MIN_WRAP_COLUMNS) return unwrapped;
  const wrap = bunWrapper();
  if (wrap == null) return unwrapped;

  const runs = toRuns(text);
  const plain = runs.map((run) => run.text).join('');
  if (Bun.stringWidth(plain) <= firstColumns) return unwrapped;

  const wrapOptions = {hard: true, trim: true, wordWrap: true};
  // The first line gets the width left after `indent`, the rest the width left
  // after `hang` — two passes, so neither is shortchanged for the other.
  const first = lineRanges(
    plain,
    wrap(plain, firstColumns, wrapOptions).split('\n'),
  );
  const firstRange = first?.[0];
  if (firstRange == null) return unwrapped;
  const restStart = firstRange[1];
  const restPlain = plain.slice(restStart);
  const rest = lineRanges(
    restPlain,
    wrap(restPlain, restColumns, wrapOptions).split('\n'),
  );
  if (rest == null) return unwrapped;

  const lines = [
    `${pad(indent)}${emitRange(runs, firstRange[0], firstRange[1])}`,
  ];
  for (const [start, end] of rest) {
    lines.push(
      `${pad(hang)}${emitRange(runs, restStart + start, restStart + end)}`,
    );
  }
  return lines.join('\n');
}

/**
 * One logical line, indented, and wrapped with a hanging indent.
 *
 * `width: null` returns the text on one line at `indent` — never wrapped. On a
 * TTY the first line starts at `indent` and every continuation at `hang`, each
 * carrying its own complete escapes (see the header for why that needs a
 * parser). An explicit newline inside `text` starts a new physical line at
 * `hang`.
 */
export function wrapHanging(text: string, options: WrapOptions): string {
  const physical = text.split('\n');
  return physical
    .map((line, index) =>
      wrapOne(line, {
        ...options,
        indent: index === 0 ? options.indent : options.hang,
      }),
    )
    .join('\n');
}
