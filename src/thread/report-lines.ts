/**
 * THE LINE CLASSIFIER (home-base-p1uj D14) — how ansi and html know what they
 * are looking at.
 *
 * `renderAnsi` and `renderHtml` are pure functions of the report model, and both
 * of them get there by styling `renderMarkdown`'s output rather than walking the
 * model a second time. That is a deliberate choice, and this file is the reason
 * it is safe:
 *
 *  - THREE WALKERS WOULD DRIFT. The old single `renderReport` grew four
 *    audiences before it broke; three independent walkers over the same model
 *    would disagree about a section within a week, and only one of them would be
 *    under snapshot.
 *  - THE STORED REPORT IS TEXT, NOT A MODEL. `thread show` and the browser
 *    answer page have the thread bead's `notes` field and no payload (D10
 *    requires the bead to be a complete report on its own). Without a classifier
 *    they could only print a `<pre>` — which is exactly what the answer page did
 *    until now. With one, every surface styles the same document the same way.
 *
 * The coupling to the markdown's shape is real, and it is held by tests: the
 * ansi and html snapshots move visibly if a heading changes, and
 * `classifiesEveryLine` asserts that no line of the fixture's rendering falls
 * through to `text` unrecognised.
 */

/** What a line of a rendered report IS. */
export type ReportLineKind =
  | 'ask'
  | 'askDetail'
  | 'blank'
  | 'bullet'
  /** `Answer: justin-sdk thread answer th-x` — the line Justin acts on. */
  | 'command'
  /** An indented continuation, e.g. the `A:` under a restated question. */
  | 'continuation'
  | 'field'
  | 'glance'
  | 'heading'
  /** A bold-prefixed aside that is not a field, e.g. the compact footer. */
  | 'note'
  | 'numbered'
  | 'rule'
  /**
   * NOTHING RECOGNISED IT. Kept as its own member rather than folded into
   * `text`-as-default, because a line shape the classifier does not know would
   * render unstyled on every surface and nothing would say so. A test asserts
   * this bucket is empty for the fixture's rendering.
   */
  | 'text'
  | 'where';

export interface ReportLine {
  /** The `**Field:**` label, without the asterisks. Null when there is none. */
  label: string | null;
  kind: ReportLineKind;
  /**
   * The ask priority this line belongs to, 0-4. Null on every line that is not
   * part of an ask — NOT 0, which is a real priority and the loudest one.
   */
  priority: number | null;
  /** The line minus its label markup, ready to be styled. */
  rest: string;
  /** The line exactly as the markdown rendered it. */
  text: string;
}

/** `  3. (P3) · [Answer] …` — the number, the marker, and the rest. */
const ASK_LINE =
  /^ {2}(\d+)\. (🛑 P0|P1|P2|\(P3\)|\(P4\)|\(P\? -?\d+\)) · (.*)$/u;

/** `**Field:** value` — a label with content after it. */
const FIELD_LINE = /^\*\*([^*]+):\*\* (.*)$/u;

/** `**Heading:**` alone on its line. */
const HEADING_LINE = /^\*\*([^*]+):\*\*$/u;

/** `**Anything.** the rest` — a bold-prefixed aside with no colon. */
const NOTE_LINE = /^\*\*([^*]+)\*\*(.*)$/u;

/** The line that ends every report. */
const COMMAND_PREFIX = 'Answer: ';

const MARKER_PRIORITY: Record<string, number> = {
  '(P3)': 3,
  '(P4)': 4,
  P1: 1,
  P2: 2,
  '🛑 P0': 0,
};

function priorityOfMarker(marker: string): number | null {
  const known = MARKER_PRIORITY[marker];
  if (known != null) return known;
  // `(P? 7)` — a priority the renderer did not recognise either. It stays
  // unknown rather than being rounded to a real one.
  return null;
}

/**
 * The ask currently being printed, threaded through its continuation lines.
 *
 * A wrapper object rather than a bare `number | null`, because P0 IS 0 and
 * "inside a P0 ask" must not be confusable with "inside no ask" — the exact
 * shape of conflation critical rule 6 bans, and here it would strip the red off
 * the one ask that has to be unmissable.
 */
export interface AskCarry {
  priority: number | null;
}

/**
 * Classify one rendered line.
 *
 * `carry` is the ask currently being printed: an ask's context, options and
 * default are indented continuation lines and must be styled with the ask they
 * belong to, not with whatever the previous heading was.
 */
export function classifyReportLine(
  text: string,
  carry: AskCarry | null,
): ReportLine {
  if (text === '') {
    return {kind: 'blank', label: null, priority: null, rest: '', text};
  }
  if (/^(?:🛑|🕉️|⏭️)+$/u.test(text)) {
    return {kind: 'rule', label: null, priority: null, rest: text, text};
  }
  if (text.startsWith('⚡ ')) {
    return {
      kind: 'glance',
      label: null,
      priority: null,
      rest: text.slice(2),
      text,
    };
  }
  const ask = ASK_LINE.exec(text);
  if (ask != null) {
    return {
      kind: 'ask',
      label: ask[1] ?? null,
      priority: priorityOfMarker(ask[2] ?? ''),
      rest: `${ask[2] ?? ''} · ${ask[3] ?? ''}`,
      text,
    };
  }
  if (text.startsWith('     ') && carry != null) {
    return {
      kind: 'askDetail',
      label: null,
      priority: carry.priority,
      rest: text.trimStart(),
      text,
    };
  }
  const heading = HEADING_LINE.exec(text);
  if (heading != null) {
    return {
      kind: 'heading',
      label: heading[1] ?? null,
      priority: null,
      rest: '',
      text,
    };
  }
  const field = FIELD_LINE.exec(text);
  if (field != null) {
    return {
      kind: 'field',
      label: field[1] ?? null,
      priority: null,
      rest: field[2] ?? '',
      text,
    };
  }
  const note = NOTE_LINE.exec(text);
  if (note != null) {
    return {
      kind: 'note',
      label: note[1] ?? null,
      priority: null,
      rest: note[2] ?? '',
      text,
    };
  }
  if (text.startsWith(COMMAND_PREFIX)) {
    return {kind: 'command', label: null, priority: null, rest: text, text};
  }
  if (/^(?:📦|🌲) /u.test(text)) {
    return {kind: 'where', label: null, priority: null, rest: text, text};
  }
  if (text.startsWith('- ')) {
    return {
      kind: 'bullet',
      label: null,
      priority: null,
      rest: text.slice(2),
      text,
    };
  }
  if (/^\d+\. /u.test(text)) {
    return {kind: 'numbered', label: null, priority: null, rest: text, text};
  }
  if (/^ {3}\S/u.test(text)) {
    return {
      kind: 'continuation',
      label: null,
      priority: null,
      rest: text.trimStart(),
      text,
    };
  }
  return {kind: 'text', label: null, priority: null, rest: text, text};
}

/**
 * Classify a whole rendered report, threading the current ask's priority
 * through its continuation lines.
 */
export function classifyReport(markdown: string): ReportLine[] {
  const lines: ReportLine[] = [];
  let carry: AskCarry | null = null;
  for (const text of markdown.split('\n')) {
    const line = classifyReportLine(text, carry);
    if (line.kind === 'ask') carry = {priority: line.priority};
    else if (line.kind !== 'askDetail') carry = null;
    lines.push(line);
  }
  return lines;
}
