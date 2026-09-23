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
  /** `Answer: bun run justin-sdk thread answer th-x` — the line Justin acts on. */
  | 'command'
  /** An indented continuation, e.g. the `A:` under a restated question. */
  | 'continuation'
  | 'field'
  | 'glance'
  | 'heading'
  /**
   * A deviation of kind `mistake` (D23) — the one bullet that reaches the
   * compact report, and the one every medium has to make unmissable. Its own
   * kind rather than a `bullet`, because a mistake styled like a bullet is a
   * mistake Justin scrolls past.
   */
  | 'mistake'
  /** A bold-prefixed aside that is not a field, e.g. the compact footer. */
  | 'note'
  | 'numbered'
  /** The compact report's `📎 … everything: bun run justin-sdk thread show …` pointer. */
  | 'pointer'
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
  kind: ReportLineKind;
  /** The `**Field:**` label, without the asterisks. Null when there is none. */
  label: string | null;
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

/**
 * The bullet a `mistake` deviation wears (D23), and the only hook any surface
 * has for finding one in a stored report.
 *
 * It lives HERE, in the file with no imports, and `render-markdown` builds its
 * prefix from it — the other direction would be a cycle, and two literals would
 * be a mistake that silently stopped being must-see.
 */
export const MISTAKE_BULLET = '- ⚠️ MISTAKE — ';

/** The compact report's pointer line. */
export const POINTER_PREFIX = '📎 ';

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
  // A line of spaces is a blank line. A carried ask reproduces its bead's
  // description under a five-space indent, so every blank line in that
  // description arrives here as `     ` — and it separates, it does not say.
  if (text.trim() === '') {
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
  if (text.startsWith(MISTAKE_BULLET)) {
    return {
      kind: 'mistake',
      label: null,
      priority: null,
      rest: text.slice(MISTAKE_BULLET.length),
      text,
    };
  }
  if (text.startsWith(POINTER_PREFIX)) {
    return {
      kind: 'pointer',
      label: null,
      priority: null,
      rest: text.slice(POINTER_PREFIX.length),
      text,
    };
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
 *
 * THE CARRY SURVIVES BLANK LINES (home-base-k0b8n.10, K11 rule 1). An ask's
 * context, options and default are now separated from each other by a blank
 * line, so "the previous line was not a detail" no longer means "this ask is
 * over". Only a line that starts something else — a heading, a field, a bullet,
 * the next ask — ends it. An unrecognised `text` line keeps it too: that is a
 * multi-line value (a context with a newline in it) still being printed.
 */
export function classifyReport(markdown: string): ReportLine[] {
  const lines: ReportLine[] = [];
  let carry: AskCarry | null = null;
  for (const text of markdown.split('\n')) {
    const line = classifyReportLine(text, carry);
    if (line.kind === 'ask') carry = {priority: line.priority};
    else if (
      line.kind !== 'askDetail' &&
      line.kind !== 'blank' &&
      line.kind !== 'text'
    ) {
      carry = null;
    }
    lines.push(line);
  }
  return lines;
}

/** One lettered option, as a surface needs it to style one. */
export interface OptionLine {
  letter: string;
  recommended: boolean;
  text: string;
}

/**
 * `- a. (Recommended) text` or `a. (Recommended) text` → its parts, or null
 * when the detail line is not an option.
 *
 * Both spellings, because both exist: the nested-list form is what the markdown
 * renders now (K11 rule 6), and every report stored before 2026-09-23 has the
 * bare form. Expects the line's `rest` — indentation already removed.
 */
export function parseOptionLine(rest: string): OptionLine | null {
  const match = /^(?:- )?([a-z])\. (\(Recommended\) )?(.*)$/u.exec(rest);
  if (match == null) return null;
  return {
    letter: match[1] ?? '',
    recommended: match[2] != null,
    text: match[3] ?? '',
  };
}

/**
 * Does this text look like a RENDERED REPORT at all (home-base-k0b8n.14)?
 *
 * A thread bead that `thread start` or `thread capture` made carries
 * placeholder notes ("NO REPORT YET. …"), not a report, and every report
 * surface used to style them as one — the compactor turned "nothing reported"
 * into "nothing needs you — nothing went wrong, nothing is blocking", which is
 * a measured reassurance nobody measured (rule 7). Every rendered report, v1
 * included, opens with the 🛑 rule; every v2 report carries the ⚡ glance line.
 * Text with neither is passed through as what it is.
 */
export function isRenderedReport(text: string): boolean {
  return classifyReport(text).some(
    (line) =>
      line.kind === 'glance' ||
      (line.kind === 'rule' && line.text.startsWith('🛑')),
  );
}
