/**
 * A QUESTION for Justin (an "ask"), as a bead (status report v4, epic
 * home-base-vzwbj.4 D1/D3; built by home-base-vzwbj.4.2).
 *
 * The bead itself carries the question (its TITLE), the priority (its
 * PRIORITY, P0–P4) and the labels `ask` + `sid:<session id>`. Everything else
 * Claude gives `thread ask` — a short header, context bullets, options with the
 * recommended one, the default, the form — is written into the bead's
 * DESCRIPTION in ONE fixed grammar that this module both writes and parses:
 *
 *   Form: pick
 *   Header: Export DB
 *
 *   Context:
 *   - The nightly export reads every table.
 *   - Postgres is already running.
 *
 *   Options:
 *   a. (Recommended) Postgres: already running, one less service
 *   b. SQLite: no server, but a second copy of the data
 *
 *   Default: I use Postgres.
 *
 * - `Form:` is always first: pick | approve | answer | do.
 * - `Header:` is optional (AskUserQuestion's short chip, ≤ 12 characters).
 * - `Context:` and `Options:` are optional blocks. Options are lettered from
 *   `a` in order, there are none or at least two, and at most one carries
 *   `(Recommended) `. An option is `<Label>` or `<Label>: <why>`, split on the
 *   FIRST colon+space, so a why may itself contain colons (and a label never
 *   does: `--option` splits it the same way).
 * - Last comes EITHER `Default: <what Claude does if he never answers>` OR
 *   `No default: <why>` — a P0 records `No default: the session stops here`
 *   (it has none by definition) and a P4 filed without one records `No
 *   default: FYI, no reply expected`. Two keys, not a sentinel value, so no
 *   default text can be mistaken for "none".
 * - Every value is ONE line; blank lines between blocks carry nothing and are
 *   skipped. Anything else is a parse failure, and callers render the raw
 *   description under a ⚠️ line — never nothing (`renderAsks`).
 *
 * CONTRACT later dispatches rely on: `parseAsk(description)` →
 * `{ok: true, ask} | {ok: false, raw, reason}`, and the close-reason prefixes
 * below (`answer:`, `done: Justin`, `archived:`), and the label `archived`.
 */

export const ASK_LABEL = 'ask';
export const QUESTION_BEAD_TYPE = 'question';

/** Close reasons — the v4 answer store is the bead's close reason, never a comment (critical rule 3.2). */
export const ANSWER_PREFIX = 'answer: ';
export const DEFAULT_TAKEN_PREFIX = 'default taken — ';
export const DONE_PREFIX = 'done: Justin';
export const ARCHIVED_PREFIX = 'archived: ';
export const ARCHIVED_LABEL = 'archived';

/** The question is the bead title; detail goes in `--context` (design item 1). */
export const QUESTION_MAX = 200;
/** AskUserQuestion's header cap. */
export const HEADER_MAX = 12;

export const P0_NO_DEFAULT = 'the session stops here';
export const P4_NO_DEFAULT = 'FYI, no reply expected';

export type AskForm = 'answer' | 'approve' | 'do' | 'pick';

export const ASK_FORMS: readonly AskForm[] = [
  'pick',
  'approve',
  'answer',
  'do',
];

export interface AskOption {
  label: string;
  /** The text after the first `: `, or null when the option is a bare label. */
  why: string | null;
}

/** What happens if Justin never answers. */
export type AskDefault =
  | {kind: 'none'; why: string}
  | {kind: 'text'; text: string};

/** The structured fields of one ask — everything but the question and the priority. */
export interface AskFields {
  context: string[];
  default: AskDefault;
  form: AskForm;
  header: string | null;
  options: AskOption[];
  /** Index into `options` of the recommended one, or null. */
  recommended: number | null;
}

export type ParsedAsk =
  | {ask: AskFields; ok: true}
  | {ok: false; raw: string; reason: string};

/** Whitespace collapsed: every grammar value is one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The letter of option `index`: a, b, c, … */
export function optionLetter(index: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + index);
}

/** The index of option letter `letter`, or null when it is not a single a–z letter. */
export function optionIndex(letter: string): number | null {
  const normal = letter.trim().toLowerCase();
  if (!/^[a-z]$/.test(normal)) return null;
  return normal.charCodeAt(0) - 'a'.charCodeAt(0);
}

const RECOMMENDED_MARK = '(Recommended) ';
const OPTION_SPLIT = ': ';

/**
 * One `--option "Label: why"`, split on the FIRST colon+space so a why that
 * contains colons survives. No `: ` → a bare label.
 */
export function parseOptionFlag(raw: string): AskOption {
  const text = oneLine(raw);
  const at = text.indexOf(OPTION_SPLIT);
  if (at === -1) return {label: text, why: null};
  const label = text.slice(0, at).trim();
  const why = text.slice(at + OPTION_SPLIT.length).trim();
  return {label, why: why === '' ? null : why};
}

/** One option line's text, without its letter. */
function optionText(option: AskOption, recommended: boolean): string {
  const body =
    option.why == null
      ? option.label
      : `${option.label}${OPTION_SPLIT}${option.why}`;
  return `${recommended ? RECOMMENDED_MARK : ''}${body}`;
}

/** The description the ask bead carries. `parseAsk` reads it back exactly. */
export function renderAskDescription(ask: AskFields): string {
  const blocks: string[] = [];
  const head = [`Form: ${ask.form}`];
  if (ask.header != null) head.push(`Header: ${ask.header}`);
  blocks.push(head.join('\n'));
  if (ask.context.length > 0) {
    blocks.push(
      ['Context:', ...ask.context.map((line) => `- ${line}`)].join('\n'),
    );
  }
  if (ask.options.length > 0) {
    blocks.push(
      [
        'Options:',
        ...ask.options.map(
          (option, index) =>
            `${optionLetter(index)}. ${optionText(option, index === ask.recommended)}`,
        ),
      ].join('\n'),
    );
  }
  blocks.push(
    ask.default.kind === 'text'
      ? `Default: ${ask.default.text}`
      : `No default: ${ask.default.why}`,
  );
  return blocks.join('\n\n');
}

function isForm(value: string): value is AskForm {
  return (ASK_FORMS as readonly string[]).includes(value);
}

/** `Key: value` → value, or null when the line is not that key. */
function valueOf(line: string, key: string): string | null {
  const prefix = `${key}: `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/**
 * Read an ask description back. STRICT: the keys, their order, the option
 * letters and the one-recommendation rule are all checked, and anything else
 * is `{ok: false, raw, reason}` so the caller can show the text as written.
 */
export function parseAsk(description: string | null): ParsedAsk {
  const raw = description ?? '';
  const fail = (reason: string): ParsedAsk => ({ok: false, raw, reason});
  const lines = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return fail('the description is empty');

  let cursor = 0;
  const next = (): string | null => lines[cursor] ?? null;

  const formText = valueOf(next() ?? '', 'Form');
  if (formText == null) return fail('the first line is not "Form: …"');
  if (!isForm(formText)) {
    return fail(
      `Form ${JSON.stringify(formText)} is not one of ${ASK_FORMS.join(', ')}`,
    );
  }
  cursor += 1;

  let header: string | null = null;
  const headerText = valueOf(next() ?? '', 'Header');
  if (headerText != null) {
    if (headerText.trim() === '') return fail('Header is empty');
    header = headerText;
    cursor += 1;
  }

  const context: string[] = [];
  if (next() === 'Context:') {
    cursor += 1;
    while (next()?.startsWith('- ') === true) {
      context.push((next() ?? '').slice(2));
      cursor += 1;
    }
    if (context.length === 0) return fail('"Context:" has no "- " lines');
  }

  const options: AskOption[] = [];
  let recommended: number | null = null;
  if (next() === 'Options:') {
    cursor += 1;
    for (;;) {
      const line = next();
      const letter = optionLetter(options.length);
      if (line == null) break;
      if (!line.startsWith(`${letter}. `)) break;
      let text = line.slice(letter.length + 2);
      if (text.startsWith(RECOMMENDED_MARK)) {
        if (recommended != null)
          return fail('more than one option is (Recommended)');
        recommended = options.length;
        text = text.slice(RECOMMENDED_MARK.length);
      }
      const option = parseOptionFlag(text);
      if (option.label === '') return fail(`option ${letter} has no label`);
      options.push(option);
      cursor += 1;
    }
    if (options.length < 2) {
      return fail(
        `"Options:" lists ${options.length} lettered option(s); a choice needs two or more, lettered from a`,
      );
    }
  }

  const last = next() ?? '';
  const defaultText = valueOf(last, 'Default');
  const noDefault = valueOf(last, 'No default');
  let askDefault: AskDefault;
  if (defaultText != null && defaultText.trim() !== '') {
    askDefault = {kind: 'text', text: defaultText};
  } else if (noDefault != null && noDefault.trim() !== '') {
    askDefault = {kind: 'none', why: noDefault};
  } else {
    return fail(
      `expected "Default: …" or "No default: …", found ${JSON.stringify(last.slice(0, 80))}`,
    );
  }
  cursor += 1;
  if (cursor !== lines.length) {
    return fail(
      `unexpected text after the default: ${JSON.stringify((next() ?? '').slice(0, 80))}`,
    );
  }

  return {
    ask: {
      context,
      default: askDefault,
      form: formText,
      header,
      options,
      recommended,
    },
    ok: true,
  };
}
