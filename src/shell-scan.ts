/**
 * shell-scan — the shell scanner the PreToolUse hooks share: `scanShell`
 * (quotes, substitutions, heredocs, comments, newlines) and `simpleCommands`
 * (shell-quote's tokens split into simple commands).
 *
 * Moved here verbatim from thread/session-guard.ts (home-base-mbnjv.5, which
 * still re-exports both) by home-base-n1qy7.15.1 (D7): the file-access audit
 * hook runs on EVERY tool call, and importing session-guard costs about 41 ms
 * because it reaches zod through thread/config, against about 2 ms for this
 * leaf (measured 2026-11-28 on this Mac). A LEAF on purpose: it imports only
 * shell-quote's types.
 */

import type parse from 'shell-quote/parse';

// ---------------------------------------------------------------------------
// The scanner: substitutions, heredocs, comments, newlines
// ---------------------------------------------------------------------------

/** What a `$(…)`, backtick or `<(…)` leaves in the outer command's place. */
export const SUBSTITUTION_PLACEHOLDER = '__guard_substitution__';

export type ShellScan =
  | {ok: false; why: string}
  | {
      ok: true;
      /** Every substitution's inner text, to be classified on its own. */
      substitutions: string[];
      /** The command with substitutions replaced and newlines turned into `;`. */
      text: string;
    };

type Read = {end: number; inner: string; ok: true} | {ok: false; why: string};

/** From just after `$(` / `<(` / `>(`: up to the matching `)`. */
function readParens(raw: string, start: number): Read {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) {
        return {end: i + 1, inner: raw.slice(start, i), ok: true};
      }
    }
  }
  return {ok: false, why: 'an unclosed $( or <('};
}

/** From just after a backtick: up to the next unescaped one. */
function readBackticks(raw: string, start: number): Read {
  let inner = '';
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      inner += next === '`' || next === '\\' || next === '$' ? next : c + next;
      i++;
      continue;
    }
    if (c === '`') return {end: i + 1, inner, ok: true};
    inner += c;
  }
  return {ok: false, why: 'an unclosed backtick'};
}

/** The substitutions in text the shell expands like a double-quoted string. */
function substitutionsIn(text: string): Read[] {
  const found: Read[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const read = readParens(text, i + 2);
      found.push(read);
      if (!read.ok) return found;
      i = read.end - 1;
    } else if (c === '`') {
      const read = readBackticks(text, i + 1);
      found.push(read);
      if (!read.ok) return found;
      i = read.end - 1;
    }
  }
  return found;
}

interface PendingHeredoc {
  delimiter: string;
  /** False when any part of the delimiter was quoted: the body is literal. */
  expands: boolean;
  stripTabs: boolean;
}

/** At `<<` (not `<<<`): the heredoc's delimiter, or null when it has none. */
function readHeredocOperator(
  raw: string,
  at: number,
): {end: number; heredoc: PendingHeredoc} | null {
  let i = at + 2;
  const stripTabs = raw[i] === '-';
  if (stripTabs) i++;
  while (raw[i] === ' ' || raw[i] === '\t') i++;
  let delimiter = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (quote != null) {
      if (c === quote) quote = null;
      else delimiter += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
      continue;
    }
    if (c === '\\' && i + 1 < raw.length) {
      quoted = true;
      delimiter += raw[i + 1];
      i++;
      continue;
    }
    if (/[\s;&|<>()]/.test(c ?? ' ')) break;
    delimiter += c;
  }
  if (delimiter === '') return null;
  return {end: i, heredoc: {delimiter, expands: !quoted, stripTabs}};
}

/**
 * Read the command once, left to right. Substitutions are cut out (their
 * inner text is returned for classification, a placeholder word stays), a
 * heredoc body is dropped (scanned for substitutions when its delimiter is
 * unquoted, as the shell expands it), comments are dropped, a line
 * continuation joins its lines, and every other newline becomes `;`.
 */
export function scanShell(raw: string): ShellScan {
  let text = '';
  const substitutions: string[] = [];
  let quote: '"' | "'" | null = null;
  let wordStart = true;
  const pending: PendingHeredoc[] = [];

  const takeSubstitution = (read: Read): string | null => {
    if (!read.ok) return read.why;
    substitutions.push(read.inner);
    text += SUBSTITUTION_PLACEHOLDER;
    return null;
  };

  let i = 0;
  while (i < raw.length) {
    const c = raw[i] ?? '';
    if (quote === "'") {
      text += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      text += next == null ? c : c + next;
      i += next == null ? 1 : 2;
      wordStart = false;
      continue;
    }
    if (c === '$' && raw[i + 1] === '(') {
      const read = readParens(raw, i + 2);
      const failed = takeSubstitution(read);
      if (failed != null || !read.ok) return {ok: false, why: failed ?? '?'};
      i = read.end;
      wordStart = false;
      continue;
    }
    if (c === '`') {
      const read = readBackticks(raw, i + 1);
      const failed = takeSubstitution(read);
      if (failed != null || !read.ok) return {ok: false, why: failed ?? '?'};
      i = read.end;
      wordStart = false;
      continue;
    }
    if (quote === '"') {
      text += c;
      if (c === '"') quote = null;
      i++;
      continue;
    }
    // Unquoted from here on.
    if (c === "'" || c === '"') {
      quote = c;
      text += c;
      i++;
      wordStart = false;
      continue;
    }
    if (c === '#' && wordStart) {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      // Mid-word `#` is literal to the shell (`justin-sdk#v1.2.3`), but
      // shell-quote starts a comment there; escaped, it stays in the word.
      text += '\\#';
      i++;
      continue;
    }
    if ((c === '<' || c === '>') && raw[i + 1] === '(') {
      const read = readParens(raw, i + 2);
      text += ' ';
      const failed = takeSubstitution(read);
      if (failed != null || !read.ok) return {ok: false, why: failed ?? '?'};
      i = read.end;
      wordStart = false;
      continue;
    }
    if (c === '<' && raw[i + 1] === '<' && raw[i + 2] !== '<') {
      const op = readHeredocOperator(raw, i);
      if (op != null) {
        pending.push(op.heredoc);
        text += ' << __guard_heredoc__ ';
        i = op.end;
        wordStart = true;
        continue;
      }
    }
    if (c === '\n') {
      text += ' ; ';
      i++;
      wordStart = true;
      // Heredoc bodies start on the line after their operator, in order.
      for (const heredoc of pending) {
        while (i < raw.length) {
          const lineEnd = raw.indexOf('\n', i);
          const end = lineEnd < 0 ? raw.length : lineEnd;
          const line = raw.slice(i, end);
          i = lineEnd < 0 ? raw.length : lineEnd + 1;
          const bare = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
          if (bare === heredoc.delimiter) break;
          if (heredoc.expands) {
            for (const read of substitutionsIn(line)) {
              if (!read.ok) return {ok: false, why: read.why};
              substitutions.push(read.inner);
            }
          }
        }
      }
      pending.length = 0;
      continue;
    }
    text += c;
    wordStart = /[\s;&|()<>]/.test(c);
    i++;
  }
  if (quote != null) {
    return {
      ok: false,
      why: `an unclosed ${quote === "'" ? 'single' : 'double'} quote`,
    };
  }
  return {ok: true, substitutions, text};
}

// ---------------------------------------------------------------------------
// Simple commands
// ---------------------------------------------------------------------------

/** The type of one shell-quote token, for callers of simpleCommands. */
export type ShellToken = parse.ParseEntry;

/** Operators that redirect: the word after one is a file, not an argument. */
const REDIRECT_OPS = new Set([
  '<<<',
  '<<-',
  '<<',
  '>>',
  '>&',
  '>|',
  '&>>',
  '&>',
  '<&',
  '<>',
  '<',
  '>',
]);

type Token = parse.ParseEntry;

/** The parser's tokens split into simple commands' words. */
export function simpleCommands(tokens: readonly Token[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let skipNext = false;
  const push = (word: string): void => {
    if (skipNext) {
      skipNext = false;
      return;
    }
    current.push(word);
  };
  for (const token of tokens) {
    if (typeof token === 'string') {
      push(token);
      continue;
    }
    if ('comment' in token) continue;
    if (token.op === 'glob') {
      push(token.pattern);
      continue;
    }
    if (REDIRECT_OPS.has(token.op)) {
      // `2>&1`: the 2 is a descriptor, not an argument.
      const last = current.at(-1);
      if (last != null && /^\d+$/.test(last)) current.pop();
      skipNext = true;
      continue;
    }
    // Every other operator ends a simple command: ; && || | |& & ( ) ;; …
    skipNext = false;
    if (current.length > 0) commands.push(current);
    current = [];
  }
  if (current.length > 0) commands.push(current);
  return commands;
}
