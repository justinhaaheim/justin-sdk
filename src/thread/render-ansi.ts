/**
 * THE TERMINAL RENDERING (home-base-p1uj D14; laid out like a man page since
 * home-base-k0b8n.10, K11) — what Justin reads in a shell.
 *
 * Same document as the markdown, laid out the way `man cp` is (Justin's
 * reference, 2026-09-23): section headings near the left edge in bold colour
 * with their emoji, everything else INDENTED under them, a blank line between
 * every item, and — on a terminal whose width is known — long lines wrapped
 * with a hanging indent that keeps the body column. His words on the old
 * output: "When all the text is right up against the edge of the terminal
 * window it looks very cramped and ugly."
 *
 *   column 0   the 🛑/🕉️ rules and the ⚡ glance line
 *   column 2   section headings, the where block, the pointer, the Answer line
 *   column 6   fields, list items, the numbered asks
 *   column 9   what belongs to one ask: its context, each option, its default
 *
 * COLOUR CARRIES MEANING (K11 rule 4): headings bold + the accent colour; a P0
 * ask bold red, P1 yellow, P2 plain, P3/P4 dim, an unknown priority yellow; the
 * recommended option green; bead ids dim; a command cyan; a MISTAKE bold red.
 *
 * IT STYLES THE MARKDOWN rather than walking the model again — see
 * `report-lines.ts` for why, and for the classifier that makes it safe. The same
 * styling therefore works on a report that is only text (the thread bead's
 * stored notes), which is what `thread show` has. It runs the text through
 * `normalizeReportText` first, so a report stored before 2026-09-23 gets the
 * same spacing, emoji headings and de-duplicated option letters as a new one.
 *
 * COLOUR IS A CHOICE, NOT A GUESS. `color` is explicit; callers pass
 * `shouldStyle()` from src/cli-style.ts, so a piped or redirected report has no
 * escape codes. With `color: false` the output is the normalized MARKDOWN —
 * no layout, no wrapping — because that is the form Claude reads and pastes.
 * `width` is `terminalWidth()`: null (every non-TTY) means never wrap.
 */

import type {ReportLine} from './report-lines';
import type {ReportModel} from './report-model';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  HEADER_COLUMN,
  type OutputStyle,
  paint,
  PLAIN_STYLE,
  type StyleName,
  wrapHanging,
} from '../cli-style';
import {stripOptionLabel} from './render';
import {normalizeReportText, renderMarkdown} from './render-markdown';
import {
  classifyReport,
  isRenderedReport,
  parseOptionLine,
} from './report-lines';

export interface AnsiOptions {
  /** Emit escapes and the man-page layout. False returns the markdown. */
  color?: boolean;
  /** Wrap width from `terminalWidth()`; null or absent never wraps. */
  width?: number | null;
}

/**
 * How loud an ask is (D15, K11 rule 4). Exported so every surface that prints
 * an ask — board, inbox, prepare, the answer walk — colours priority the same
 * way as the report does.
 */
export function priorityStyles(priority: number | null): StyleName[] {
  if (priority == null) return ['yellow'];
  if (priority === 0) return ['bold', 'red'];
  if (priority === 1) return ['yellow'];
  if (priority >= 3) return ['dim'];
  return [];
}

/** The labels an ask bead's description opens its paragraphs with. */
const RESTATED_LABEL = /^(CONTEXT:|OPTIONS:|IF UNANSWERED:)(.*)$/u;

/**
 * An ask bead's stored description, laid out at `column` (K11 rules 1–4): a
 * blank line between every paragraph and between every option, labels bold,
 * the recommended option green, each line hang-wrapped on a terminal. Blank
 * lines stay empty — an indented blank line is only trailing whitespace.
 *
 * Shared by `thread inbox`, `thread prepare` (at the detail column, under the
 * ask's heading) and the `thread answer` walk (at the body column, under its
 * `── n/N ──` header), so an ask reads the same wherever it is shown.
 *
 * Option text goes through `stripOptionLabel`, because ask beads written before
 * k0b8n.10 STORE the double letter (`a. (Recommended) a. Discard it`): these
 * surfaces are where those are read back, so this is where they are cleaned
 * (K11 rule 7). Only lines after `OPTIONS:` are read as options, so a context
 * sentence that happens to begin "a. " is left alone.
 */
export function layRestatedAsk(
  restated: string,
  style: OutputStyle = PLAIN_STYLE,
  column: number = DETAIL_COLUMN,
): string[] {
  const {color, width} = style;
  const out: string[] = [];
  const blank = (): void => {
    if (out.length > 0 && out.at(-1) !== '') out.push('');
  };
  let inOptions = false;
  for (const raw of restated.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      blank();
      continue;
    }
    const labelled = RESTATED_LABEL.exec(line);
    if (labelled != null) inOptions = labelled[1] === 'OPTIONS:';
    const option = inOptions ? parseOptionLine(line) : null;
    if (option != null) {
      blank();
      const letter = `${option.letter}.`;
      const text = stripOptionLabel(option.letter, option.text);
      const rest = option.recommended
        ? paint(`(Recommended) ${text}`, ['green'], color)
        : text;
      out.push(
        wrapHanging(`${paint(letter, ['bold'], color)} ${rest}`, {
          hang: column + letter.length + 1,
          indent: column,
          width,
        }),
      );
      continue;
    }
    const text =
      labelled == null
        ? line
        : `${paint(labelled[1] ?? '', ['bold'], color)}${labelled[2] ?? ''}`;
    out.push(wrapHanging(text, {hang: column, indent: column, width}));
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

/**
 * A detail line keeps its ask's COLOUR but not its weight: a P0's context in
 * red, a P3's dim. Bold is for the ask line itself, so the eye finds the ask
 * first and reads down into it.
 */
function detailStyles(priority: number | null): StyleName[] {
  return priorityStyles(priority).filter((style) => style !== 'bold');
}

/**
 * `styles` plus bold — unless the line is dim. Bold and dim are the same SGR
 * attribute (intensity), so asking for both gets whichever the terminal honours
 * last; a P3 option letter must stay as quiet as its ask.
 */
function emphasised(styles: readonly StyleName[]): StyleName[] {
  return styles.includes('dim') ? [...styles] : [...styles, 'bold'];
}

/** A line laid out: where it starts, where its wrapped lines hang, and its text. */
interface Laid {
  hang: number;
  indent: number;
  text: string;
  /** False for lines that must never be wrapped (the emoji rules). */
  wrap: boolean;
}

/** `(th-sep.1)` at the end of an ask line — split off so it can be dimmed. */
const TRAILING_ID = /^(.*) (\([a-z][\w-]*(?:\.\d+)*\))$/u;

/** `Context: …` / `If you don't answer: …` — a detail's label, bolded. */
const DETAIL_LABEL =
  /^(Context:|If you don't answer:|CONTEXT:|IF UNANSWERED:|OPTIONS:)(.*)$/u;

/** A leading bead id on a Prior-asks / Beads-touched bullet. */
const LEADING_ID = /^([a-z][\w-]*(?:\.\d+)*)( .*)$/u;

/** The sections whose bullets open with a bead id. */
const ID_SECTIONS = /Prior asks|Beads touched/u;

function layAsk(line: ReportLine, color: boolean): Laid {
  const number = line.label ?? '';
  const styles = priorityStyles(line.priority);
  const body = `${number}. ${line.rest}`;
  const split = TRAILING_ID.exec(body);
  const text =
    split == null
      ? paint(body, styles, color)
      : `${paint(split[1] ?? '', styles, color)} ${paint(split[2] ?? '', ['dim'], color)}`;
  return {
    hang: BODY_COLUMN + number.length + 2,
    indent: BODY_COLUMN,
    text,
    wrap: true,
  };
}

function layAskDetail(line: ReportLine, color: boolean): Laid {
  const styles = detailStyles(line.priority);
  const option = parseOptionLine(line.rest);
  if (option != null) {
    const letter = `${option.letter}.`;
    const rest = `${option.recommended ? '(Recommended) ' : ''}${option.text}`;
    const restStyles: StyleName[] = option.recommended
      ? [...styles.filter((style) => style === 'dim'), 'green']
      : styles;
    return {
      hang: DETAIL_COLUMN + letter.length + 1,
      indent: DETAIL_COLUMN,
      text: `${paint(letter, emphasised(styles), color)} ${paint(rest, restStyles, color)}`,
      wrap: true,
    };
  }
  const labelled = DETAIL_LABEL.exec(line.rest);
  const text =
    labelled == null
      ? paint(line.rest, styles, color)
      : `${paint(labelled[1] ?? '', emphasised(styles), color)}${paint(labelled[2] ?? '', styles, color)}`;
  return {hang: DETAIL_COLUMN, indent: DETAIL_COLUMN, text, wrap: true};
}

function layLine(
  line: ReportLine,
  color: boolean,
  section: string | null,
): Laid | null {
  switch (line.kind) {
    case 'blank':
      return null;
    case 'rule':
      return {
        hang: 0,
        indent: 0,
        text: paint(line.text, ['cyan'], color),
        wrap: false,
      };
    case 'glance':
      return {
        hang: 2,
        indent: 0,
        text: paint(line.text, ['bold'], color),
        wrap: true,
      };
    case 'where':
      return {
        hang: HEADER_COLUMN + 3,
        indent: HEADER_COLUMN,
        text: paint(line.text, ['dim'], color),
        wrap: true,
      };
    case 'heading':
      return {
        hang: HEADER_COLUMN + 3,
        indent: HEADER_COLUMN,
        text: paint(line.label ?? '', ['bold', 'accent'], color),
        wrap: true,
      };
    case 'field':
      return {
        hang: BODY_COLUMN + 2,
        indent: BODY_COLUMN,
        text: `${paint(`${line.label ?? ''}:`, ['bold', 'underline'], color)} ${line.rest}`,
        wrap: true,
      };
    case 'ask':
      return layAsk(line, color);
    case 'askDetail':
      return layAskDetail(line, color);
    case 'bullet': {
      const id =
        section != null && ID_SECTIONS.test(section)
          ? LEADING_ID.exec(line.rest)
          : null;
      const body =
        id == null
          ? line.rest
          : `${paint(id[1] ?? '', ['dim'], color)}${id[2] ?? ''}`;
      return {
        hang: BODY_COLUMN + 2,
        indent: BODY_COLUMN,
        text: `${paint('•', ['dim'], color)} ${body}`,
        wrap: true,
      };
    }
    // A mistake is the only bullet that reaches the compact report (D23), and it
    // gets the same weight as a P0 ask: bold red. Justin's definition is
    // "careless, wrong, against the spec or the rules" — if it is dim, it is not
    // a mistake, it is an FYI, and it should have been filed as one.
    case 'mistake':
      return {
        hang: BODY_COLUMN + 2,
        indent: BODY_COLUMN,
        text: paint(`• ${line.text.slice(2)}`, ['bold', 'red'], color),
        wrap: true,
      };
    case 'numbered': {
      const number = /^(\d+\. )/u.exec(line.text)?.[1] ?? '';
      return {
        hang: BODY_COLUMN + number.length,
        indent: BODY_COLUMN,
        text: line.text,
        wrap: true,
      };
    }
    case 'continuation':
      return {
        hang: DETAIL_COLUMN,
        indent: DETAIL_COLUMN,
        text: line.rest,
        wrap: true,
      };
    case 'pointer': {
      // The pointer is quiet, but the command at its end is a thing to run.
      const at = line.text.indexOf('everything: ');
      const text =
        at === -1
          ? paint(line.text, ['dim'], color)
          : `${paint(line.text.slice(0, at + 'everything: '.length), ['dim'], color)}${paint(line.text.slice(at + 'everything: '.length), ['cyan'], color)}`;
      return {hang: HEADER_COLUMN + 3, indent: HEADER_COLUMN, text, wrap: true};
    }
    case 'note':
      return {
        hang: BODY_COLUMN + 2,
        indent: BODY_COLUMN,
        text: `${paint(line.label ?? '', ['bold'], color)}${line.rest}`,
        wrap: true,
      };
    case 'command': {
      const rest = line.text.slice('Answer: '.length);
      return {
        hang: HEADER_COLUMN + 2,
        indent: HEADER_COLUMN,
        text: `${paint('Answer:', ['bold'], color)} ${paint(rest, ['cyan'], color)}`,
        wrap: true,
      };
    }
    case 'text': {
      // A line nobody recognised is part of a multi-line value — Justin's own
      // words, often. Its own leading spaces are kept on top of the body
      // column, so an indented line in his message stays indented.
      const leading = /^ */u.exec(line.text)?.[0].length ?? 0;
      return {
        hang: BODY_COLUMN + leading,
        indent: BODY_COLUMN + leading,
        text: line.text.slice(leading),
        wrap: true,
      };
    }
  }
}

/**
 * Style an already-rendered report. Used by `renderAnsi` and by every surface
 * that has the stored text and no model (`thread show`, the answer walk).
 *
 * Text that is NOT a rendered report (a start placeholder's "NO REPORT YET"
 * notes — home-base-k0b8n.14) is returned unchanged: styling it as a report is
 * how it came to be printed as one.
 */
export function ansiFromReportText(
  markdown: string,
  options: AnsiOptions = {},
): string {
  if (!isRenderedReport(markdown)) return markdown;
  const normalized = normalizeReportText(markdown);
  if (options.color === false) return normalized;
  const color = true;
  const width = options.width ?? null;
  let section: string | null = null;
  const out: string[] = [];
  for (const line of classifyReport(normalized)) {
    if (line.kind === 'heading') section = line.label;
    const laid = layLine(line, color, section);
    if (laid == null) {
      out.push('');
      continue;
    }
    out.push(
      wrapHanging(laid.text, {
        hang: laid.hang,
        indent: laid.indent,
        width: laid.wrap ? width : null,
      }),
    );
  }
  return out.join('\n');
}

/** The whole report, styled for a terminal. */
export function renderAnsi(
  model: ReportModel,
  options: AnsiOptions = {},
): string {
  return ansiFromReportText(renderMarkdown(model), options);
}
