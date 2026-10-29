/**
 * How a question for Justin is PRINTED (status report v4, epic
 * home-base-vzwbj.4 D4; built by home-base-vzwbj.4.2). Imported by `thread
 * ask`, `thread answer`, `thread answers`, and later by Part 1 and the inbox.
 *
 * Justin's rules, verbatim on the epic: "asks STILL need an empty newline after
 * each numbered item", "they could use better bold/italic/formatting", and "I
 * really need to see ALL the questions … aggressively prioritize them so I can
 * easily determine what to skip". So, per question:
 *
 *   1. 🛑 P0 · **Which database should the export use?** (t-abc.2)
 *
 *      - The nightly export reads every table.
 *
 *      - a. (Recommended) Postgres — already running
 *
 *      - b. SQLite — no server
 *
 *      *If you don't answer: I stop here; this one is yours.*
 *
 * with a blank line between every block, between options, and after every
 * item. Badges: 🛑 P0 · 🟡 P1–P2 · ⚪ P3–P4. A header, when the ask has one,
 * sits between the badge and the question. Markdown when the output is not
 * coloured (a pipe: what Claude reads), ANSI through cli-style.ts on a TTY.
 * A description that is not in the ask grammar is shown as written under a ⚠️
 * line — never dropped.
 */

import type {OutputStyle, StyleName} from '../cli-style';
import type {AskFields} from './ask-format';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  markdownItems,
  pad,
  paint,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {optionLetter, parseAsk} from './ask-format';

/** The fields of a question bead the renderer reads. `BrIssue` satisfies it. */
export interface AskBeadView {
  description: string | null;
  id: string;
  priority: number | null;
  /** The question itself. */
  title: string;
}

/** The priority badge: 🛑 P0 · 🟡 P1–P2 · ⚪ P3–P4. */
export function priorityBadge(priority: number | null): string {
  if (priority === 0) return '🛑 P0';
  if (priority === 1 || priority === 2) return `🟡 P${priority}`;
  if (priority === 3 || priority === 4) return `⚪ P${priority}`;
  return '❔ P?';
}

function badgeStyles(priority: number | null): StyleName[] {
  if (priority === 0) return ['bold', 'red'];
  if (priority === 1 || priority === 2) return ['bold', 'yellow'];
  return ['dim'];
}

/**
 * Most urgent first (P0 … P4, an unknown priority last), keeping the given
 * order among equals.
 */
export function sortAsks<T extends AskBeadView>(asks: readonly T[]): T[] {
  const rank = (priority: number | null): number => priority ?? 99;
  return [...asks]
    .map((ask, index) => ({ask, index}))
    .sort((a, b) => {
      const byRank = rank(a.ask.priority) - rank(b.ask.priority);
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((entry) => entry.ask);
}

/**
 * The form tag on the badge line, as the legacy rule printed it
 * (home-base-vzwbj.4.4 design item 6f): `[Pick a/b]`, `[Approve Y/n]`,
 * `[Answer]`, `[Do]`. It tells Justin what kind of reply is wanted before he
 * reads the question. A pick with fewer than two options says `[Pick]`.
 */
export function formTag(ask: AskFields): string {
  switch (ask.form) {
    case 'pick': {
      const letters = ask.options.map((_, index) => optionLetter(index));
      return letters.length >= 2 ? `[Pick ${letters.join('/')}]` : '[Pick]';
    }
    case 'approve':
      return '[Approve Y/n]';
    case 'answer':
      return '[Answer]';
    case 'do':
      return '[Do]';
  }
}

/** The sentence after "If you don't answer: ". */
export function defaultSentence(
  ask: AskFields,
  priority: number | null,
): string {
  if (ask.default.kind === 'text') return ask.default.text;
  if (priority === 0) return 'I stop here; this one is yours.';
  if (priority === 4) return `nothing changes — ${ask.default.why}.`;
  return `no default was recorded (${ask.default.why}).`;
}

interface Block {
  /** Lines of the block, already styled; each is one logical line. */
  lines: string[];
}

/**
 * Empty lines between sibling list items in the MARKDOWN rendering: the
 * questions, and the context bullets and options inside one (they are one
 * nested list). 1 is plain CommonMark; 2 is what Claude Code's terminal needs
 * to show an empty row between them (MARKDOWN_ITEM_GAP, home-base-j8q3e.1.7.2).
 * The ANSI rendering ignores it: a terminal print keeps one blank line.
 */
export type ItemGap = 1 | 2;

/**
 * A context line that starts with a list marker (`1.`, `1)`, `-`, `*`, `+`)
 * would become a list NESTED under its own bullet in markdown: on 2026-10-20 a
 * `--context "1. … 2. … 3. …"` drew as "- i." with steps 2 and 3 run inline
 * (home-base-pp1vx.14.1). The marker is backslash-escaped, which Claude Code
 * draws as the plain character (docs/reference/claude-code-markdown-rendering.md,
 * case 23). Only the markdown rendering needs it; a terminal print has no
 * markdown to misread.
 */
export function escapeLeadingListMarker(line: string): string {
  return line
    .replace(/^(\s*)(\d+)([.)])(?=\s|$)/u, '$1$2\\$3')
    .replace(/^(\s*)([-*+])(?=\s|$)/u, '$1\\$2');
}

function markdownItem(
  question: AskBeadView,
  number: number,
  gap: ItemGap,
): string {
  const marker = `${number}. `;
  const indent = pad(marker.length);
  const parsed = parseAsk(question.description);
  const header =
    parsed.ok && parsed.ask.header != null ? `${parsed.ask.header} · ` : '';
  const form = parsed.ok ? `${formTag(parsed.ask)} ` : '';
  const first = `${marker}${priorityBadge(question.priority)} · ${form}${header}**${question.title}** (${question.id})`;
  const blocks: Block[] = [];
  if (!parsed.ok) {
    blocks.push({
      lines:
        parsed.raw.trim() === ''
          ? [
              `⚠️ This question has no description (it was not filed with thread ask).`,
            ]
          : [`⚠️ Not in the ask format (${parsed.reason}); shown as written:`],
    });
    if (parsed.raw.trim() !== '') {
      blocks.push({lines: parsed.raw.trim().split('\n')});
    }
  } else {
    const {ask} = parsed;
    const context = ask.context.map(
      (line) => `- ${escapeLeadingListMarker(line)}`,
    );
    const options = ask.options.map((option, index) => {
      const mark = index === ask.recommended ? '(Recommended) ' : '';
      const why = option.why == null ? '' : ` — ${option.why}`;
      return `- ${optionLetter(index)}. ${mark}${option.label}${why}`;
    });
    const fallback = `*If you don't answer: ${defaultSentence(ask, question.priority)}*`;
    if (gap === 2) {
      // The context bullets and the options are ONE nested list in markdown,
      // so every one of them is a sibling of the next: two empty lines each.
      const items = [...context, ...options].map((line) => `${indent}${line}`);
      return spacedList([first, markdownItems(items), `${indent}${fallback}`]);
    }
    if (context.length > 0) blocks.push({lines: context});
    for (const option of options) blocks.push({lines: [option]});
    blocks.push({lines: [fallback]});
  }
  return [
    first,
    ...blocks.map((block) =>
      block.lines
        .map((line) => (line === '' ? '' : `${indent}${line}`))
        .join('\n'),
    ),
  ].join('\n\n');
}

function ansiItem(
  question: AskBeadView,
  number: number,
  style: OutputStyle,
): string {
  const {color, width} = style;
  const parsed = parseAsk(question.description);
  const wrap = (text: string, indent: number, hang: number): string =>
    wrapHanging(text, {hang, indent, width});
  const header =
    parsed.ok && parsed.ask.header != null
      ? `${paint(parsed.ask.header, ['italic'], color)} · `
      : '';
  const form = parsed.ok
    ? `${paint(formTag(parsed.ask), ['cyan'], color)} `
    : '';
  const marker = `${number}. `;
  const first = wrap(
    `${paint(marker, ['bold'], color)}${paint(priorityBadge(question.priority), badgeStyles(question.priority), color)} · ${form}${header}${paint(question.title, ['bold'], color)} ${paint(`(${question.id})`, ['dim'], color)}`,
    BODY_COLUMN,
    BODY_COLUMN + marker.length,
  );
  const blocks: string[] = [first];
  if (!parsed.ok) {
    blocks.push(
      wrap(
        parsed.raw.trim() === ''
          ? '⚠️ This question has no description (it was not filed with thread ask).'
          : `⚠️ Not in the ask format (${parsed.reason}); shown as written:`,
        DETAIL_COLUMN,
        DETAIL_COLUMN + 3,
      ),
    );
    if (parsed.raw.trim() !== '') {
      blocks.push(
        parsed.raw
          .trim()
          .split('\n')
          .map((line) => wrap(line, DETAIL_COLUMN, DETAIL_COLUMN))
          .join('\n'),
      );
    }
    return blocks.join('\n\n');
  }
  const {ask} = parsed;
  if (ask.context.length > 0) {
    blocks.push(
      ask.context
        .map((line) =>
          wrap(
            `${paint('-', ['dim'], color)} ${line}`,
            DETAIL_COLUMN,
            DETAIL_COLUMN + 2,
          ),
        )
        .join('\n'),
    );
  }
  ask.options.forEach((option, index) => {
    const recommended = index === ask.recommended;
    const letter = paint(`${optionLetter(index)}.`, ['bold'], color);
    const mark = recommended
      ? `${paint('(Recommended)', ['bold', 'green'], color)} `
      : '';
    const label = paint(
      option.label,
      recommended ? ['bold', 'green'] : ['bold'],
      color,
    );
    const why = option.why == null ? '' : ` — ${option.why}`;
    blocks.push(
      wrap(`${letter} ${mark}${label}${why}`, DETAIL_COLUMN, DETAIL_COLUMN + 3),
    );
  });
  blocks.push(
    wrap(
      paint(
        `If you don't answer: ${defaultSentence(ask, question.priority)}`,
        ['italic'],
        color,
      ),
      DETAIL_COLUMN,
      DETAIL_COLUMN,
    ),
  );
  return blocks.join('\n\n');
}

/** One question as item `number`: markdown when uncoloured, ANSI when coloured. */
export function renderAsk(
  question: AskBeadView,
  number: number,
  style: OutputStyle,
  gap: ItemGap = 1,
): string {
  return style.color
    ? ansiItem(question, number, style)
    : markdownItem(question, number, gap);
}

/**
 * Every question, most urgent first, numbered from 1, a blank line after each
 * item (two in markdown with `itemGap: 2`, for text Claude Code will draw).
 * Empty input renders as an empty string (the caller says "none").
 */
export function renderAsks(
  questions: readonly AskBeadView[],
  options: {itemGap?: ItemGap; style: OutputStyle},
): string {
  const gap = options.itemGap ?? 1;
  const items = sortAsks(questions).map((question, index) =>
    renderAsk(question, index + 1, options.style, gap),
  );
  return !options.style.color && gap === 2
    ? markdownItems(items)
    : items.join('\n\n');
}
