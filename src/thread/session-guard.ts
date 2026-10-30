/**
 * thread guard — the PreToolUse [Bash] seatbelt of epic home-base-mbnjv (D3b,
 * C8; built by home-base-mbnjv.5).
 *
 * Justin, 2026-10-29: "claude doesn't try to hack around it (i don't want
 * claude 'going rogue' like that opening new cc sessions)". `thread handoff`
 * (a successor) and `thread spawn` (unrelated work) are the only doors; this
 * hook refuses the raw commands that would go around them:
 *
 *   1. any `cmux` subcommand that is not on the allowlist below;
 *   2. any `claude` invocation that is not one of the read-only forms below;
 *   3. `thread handoff`, `thread spawn` or `thread respawn` from a SUBAGENT
 *      (the payload carries agent_id): a subagent's Bash environment equals
 *      its parent's (measured 2026-10-29, epic design field), so it would
 *      hand off its parent. That refusal is recorded on the parent's session
 *      bead (recordRefusal, reason `subagent`).
 *
 * A SEATBELT AGAINST HONEST MISTAKES, NOT A BOUNDARY AGAINST AN ADVERSARY. A
 * command built at run time (`$C -p x` with C=claude), a script file, or an
 * alias is not seen. The rule text (home-base-mbnjv.6) is the first control;
 * this enforces it for the shapes a session actually types.
 *
 * DENYING: exit 2 with the message on stderr, the worktree-salvage pattern.
 * Claude Code blocks the call and shows stderr to Claude, and the dispatcher
 * passes a child's exit 2 and stderr through (mergeHandlerOutputs).
 *
 * PARSING: a small scanner here (quotes, `$(…)`, backticks, `<(…)`, heredocs,
 * comments, line continuations, newlines), then shell-quote's tokenizer
 * (vetted in home-base-mbnjv.5's notes) for words and operators. Split on
 * ; && || | |& & ( ) and newlines; skip VAR=value assignments, the shell
 * keywords that precede a command (if, then, do, !, {), and the wrappers env,
 * command, exec, nohup, time, builtin, nice, timeout; match the program by
 * basename. Recurse into `sh|bash|zsh|dash -c '<string>'`, `eval`, `env -S`,
 * every `$(…)`, backtick and process substitution, and unquoted heredoc bodies.
 * A command that cannot be read (an unclosed quote, `$(` or backtick) is
 * allowed unless it contains the whole word cmux or claude; then it is denied
 * as "could not read this command".
 *
 * Inert unless componentConfig.thread.handoff.successor is on in the project
 * (install writes the entry only there; this re-check covers an entry left
 * behind after the knob went off).
 */

import type {EnvLike} from './paths';

import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import parse from 'shell-quote/parse';

import {SDK_HANDOFF_CALL} from '../sdk-invocation';
import {writeGuardPass} from './guard-pass';

// ---------------------------------------------------------------------------
// The lists (home-base-mbnjv.5 design field carries the same lists and why)
// ---------------------------------------------------------------------------

/**
 * cmux subcommands that only READ: they print state and change nothing. The
 * test each one passes: it cannot start a process in, type into, move, close
 * or open any pane, tab, workspace or window.
 */
export const CMUX_READ_ONLY_SUBCOMMANDS = [
  'identify',
  'tree',
  'read-screen',
  'read-selection',
  'capture-pane',
  'current-window',
  'current-workspace',
  'ping',
  'version',
  'capabilities',
  'top',
  'memory',
  'surface-health',
  'sidebar-state',
  'browser-status',
  'help',
  'guide',
  'docs',
] as const;

/**
 * Every `list-*` subcommand is read-only too: list-windows, list-workspaces,
 * list-panes, list-pane-surfaces, list-panels, list-notifications,
 * list-status, list-log, list-buffers.
 */
export const CMUX_READ_ONLY_PREFIX = 'list-';

/**
 * Allowed although not read-only, each decided explicitly:
 *  - notify: posts a notification. It opens, types into and closes nothing.
 *  - browser, markdown, diff: VIEWER panels. They can open a browser or
 *    markdown pane, but such a pane runs no shell and no Claude Code, and
 *    nothing here can type into a terminal through it. Sessions use browser
 *    panes to test web UI. A terminal pane is what a session could be started
 *    in, so every way to open one (new-pane, new-surface, new-split,
 *    new-workspace, the bare path form) stays denied.
 *    Accepted residual: a browser pane pointed at claude.ai could drive a
 *    cloud session. A seatbelt, not a boundary.
 */
export const CMUX_ALLOWED_ACTIONS = [
  'notify',
  'browser',
  'markdown',
  'diff',
] as const;

/** Options cmux accepts before the subcommand, each with whether it takes a value. */
const CMUX_GLOBAL_OPTIONS: ReadonlyMap<string, boolean> = new Map([
  ['--id-format', true],
  ['--json', false],
  ['--password', true],
  ['--socket', true],
]);

/** Words that print help or the version wherever they stand first. */
const HELP_WORDS = new Set(['--help', '-h']);
const CMUX_INFO_WORDS = new Set(['--help', '-h', '--skill', '--version', '-v']);

/**
 * claude's subcommands (claude 2.1.312 `--help`), so `<subcommand> --help` is
 * allowed for exactly these and never for a prompt that ends in --help.
 */
const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'config',
  'doctor',
  'gateway',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade',
]);

/** The read-only claude forms, as the deny message lists them. */
export const CLAUDE_ALLOWED_FORMS = [
  'claude --version',
  'claude -v',
  'claude --help',
  'claude -h',
  'claude <subcommand> --help',
  'claude agents --json',
  'claude mcp list',
  'claude mcp get <name>',
  'claude config get <key>',
  'claude config list',
  'claude doctor',
  'claude logs <id>',
] as const;

/** The SDK thread subcommands a subagent may not run. */
const SUBAGENT_DENIED_THREAD_COMMANDS = new Set([
  'handoff',
  'respawn',
  'spawn',
]);

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type GuardDenyReason =
  | 'claude'
  | 'cmux'
  | 'subagentThread'
  | 'unreadable';

export type GuardVerdict =
  | {kind: 'allow'}
  | {
      /** The simple command that was refused, words joined by spaces. */
      command: string;
      kind: 'deny';
      reason: GuardDenyReason;
      /** One sentence: why that command is refused. */
      why: string;
    };

const ALLOW: GuardVerdict = {kind: 'allow'};

function deny(
  reason: GuardDenyReason,
  words: readonly string[],
  why: string,
): GuardVerdict {
  return {command: words.join(' '), kind: 'deny', reason, why};
}

/** The whole word cmux or claude, as the unreadable rule looks for it. */
const SESSION_WORD = /(?<![\w.-])(?:claude|cmux)(?![\w.-])/;

function unreadable(raw: string, why: string): GuardVerdict {
  if (!SESSION_WORD.test(raw)) return ALLOW;
  return {
    command: raw.trim(),
    kind: 'deny',
    reason: 'unreadable',
    why: `could not read this command (${why}), and it names cmux or claude`,
  };
}

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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** Shell words that may stand before a command without being one. */
const PREFIX_KEYWORDS = new Set([
  '!',
  'do',
  'elif',
  'else',
  'if',
  'then',
  'until',
  'while',
  '{',
]);

/**
 * F13: launchers that run a command, with the options of each that take a
 * value as a separate word. An option not listed is taken to be a flag; one
 * that is listed but glued to its value (`-oL`, `-n5`) is one word.
 */
const LAUNCHER_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['caffeinate', new Set(['-t', '-w'])],
  [
    'sudo',
    new Set([
      '-C',
      '-D',
      '-g',
      '-p',
      '-R',
      '-r',
      '-T',
      '-t',
      '-U',
      '-u',
      '--chdir',
      '--chroot',
      '--close-from',
      '--group',
      '--other-user',
      '--prompt',
      '--role',
      '--type',
      '--user',
      '--command-timeout',
    ]),
  ],
  [
    'xargs',
    new Set([
      '-a',
      '-d',
      '-E',
      '-I',
      '-J',
      '-L',
      '-n',
      '-P',
      '-R',
      '-S',
      '-s',
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-chars',
      '--max-lines',
      '--max-procs',
    ]),
  ],
  ['stdbuf', new Set(['-e', '-i', '-o', '--error', '--input', '--output'])],
  ['unbuffer', new Set<string>()],
]);

/** F13: `<program> <sub>` spellings of bunx / npx / pnpx. */
const PACKAGE_RUNNER_ALIASES = new Map<string, string>([
  ['bun x', 'bunx'],
  ['npm exec', 'npx'],
  ['npm x', 'npx'],
  ['pnpm dlx', 'pnpx'],
  ['pnpm exec', 'pnpx'],
  ['yarn dlx', 'npx'],
  ['yarn exec', 'npx'],
]);

/**
 * Remove leading options from `rest` in place: `--` ends them; a word in
 * `valued` also removes the next word; `--name=value` is one word.
 */
function stripOptions(rest: string[], valued: ReadonlySet<string>): void {
  while (rest[0]?.startsWith('-') === true) {
    const word = rest[0];
    if (word === '--') {
      rest.shift();
      return;
    }
    rest.splice(0, valued.has(word) ? 2 : 1);
  }
}

/**
 * F13: terminal multiplexers start their command as a string or as the words
 * after their options (`tmux new-session -d 'claude --bg'`, `zellij run --
 * claude --bg`, `screen -dmS x claude --bg`). Their option grammars are wide,
 * so instead of parsing them every later word is classified as a script, and
 * so is every tail of the words: the first denial is the multiplexer's.
 */
const MULTIPLEXERS = new Set(['screen', 'tmux', 'zellij']);

type Unwrapped =
  | {kind: 'command'; words: string[]}
  | {kind: 'lookup'}
  | {kind: 'none'}
  | {kind: 'split'; script: string};

/**
 * Strip what stands before the program: assignments, keywords and the
 * wrappers. `command -v x` only looks x up, so it runs nothing.
 */
export function unwrapCommand(words: readonly string[]): Unwrapped {
  const rest = [...words];
  for (;;) {
    const first = rest[0];
    if (first == null) return {kind: 'none'};
    if (ASSIGNMENT.test(first) || PREFIX_KEYWORDS.has(first)) {
      rest.shift();
      continue;
    }
    const program = basename(first);
    if (program === 'env') {
      rest.shift();
      while (rest[0] != null) {
        const word = rest[0];
        if (ASSIGNMENT.test(word)) rest.shift();
        else if (['-S', '--split-string'].includes(word)) {
          return {kind: 'split', script: rest.slice(1).join(' ')};
        } else if (['-u', '--unset', '-C', '--chdir', '-P'].includes(word)) {
          rest.splice(0, 2);
        } else if (word.startsWith('-')) rest.shift();
        else break;
      }
      continue;
    }
    if (program === 'command') {
      rest.shift();
      while (rest[0]?.startsWith('-') === true) {
        if (/[vV]/.test(rest[0])) return {kind: 'lookup'};
        rest.shift();
      }
      continue;
    }
    if (program === 'exec') {
      rest.shift();
      while (rest[0]?.startsWith('-') === true) {
        rest.splice(0, rest[0] === '-a' ? 2 : 1);
      }
      continue;
    }
    if (program === 'nohup' || program === 'builtin') {
      rest.shift();
      continue;
    }
    if (program === 'time') {
      rest.shift();
      while (rest[0]?.startsWith('-') === true) rest.shift();
      continue;
    }
    if (program === 'nice') {
      rest.shift();
      while (rest[0]?.startsWith('-') === true) {
        rest.splice(0, rest[0] === '-n' ? 2 : 1);
      }
      continue;
    }
    if (program === 'timeout') {
      rest.shift();
      while (rest[0]?.startsWith('-') === true) {
        const takesValue = ['-s', '--signal', '-k', '--kill-after'].includes(
          rest[0],
        );
        rest.splice(0, takesValue ? 2 : 1);
      }
      rest.shift(); // the duration
      continue;
    }
    // F13 (home-base-mbnjv.8): launchers that run the words after their own
    // options as a command. Each strips its options (and the values the
    // listed ones take) and goes round again on what is left.
    const valued = LAUNCHER_VALUE_OPTIONS.get(program);
    if (valued != null) {
      rest.shift();
      stripOptions(rest, valued);
      continue;
    }
    if (program === 'script') {
      // macOS `script [-adkpqr] [-F pipe] [-t time] [file [command …]]`;
      // util-linux `script -c "<command>" [file]`.
      rest.shift();
      const call = rest.findIndex((w) => w === '-c' || w === '--command');
      if (call >= 0) return {kind: 'split', script: rest[call + 1] ?? ''};
      stripOptions(rest, new Set(['-F', '-t']));
      rest.shift(); // the typescript file
      continue;
    }
    if (program === 'watch') {
      // watch runs its command through `sh -c` with the words joined.
      rest.shift();
      stripOptions(rest, new Set(['-n', '--interval', '-q', '--equexit']));
      return {kind: 'split', script: rest.join(' ')};
    }
    // `bun x`, `npm exec` / `npm x`, `pnpm dlx` / `pnpm exec`, `yarn dlx` /
    // `yarn exec`: the same as bunx / npx / pnpx, which classifyWords reads.
    const runner = PACKAGE_RUNNER_ALIASES.get(`${program} ${rest[1] ?? ''}`);
    if (runner != null) {
      rest.splice(0, 2, runner);
      continue;
    }
    return {kind: 'command', words: rest};
  }
}

// ---------------------------------------------------------------------------
// The programs
// ---------------------------------------------------------------------------

function cmuxAllowed(sub: string): boolean {
  return (
    (CMUX_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(sub) ||
    sub.startsWith(CMUX_READ_ONLY_PREFIX) ||
    (CMUX_ALLOWED_ACTIONS as readonly string[]).includes(sub)
  );
}

/** `cmux …` (the words after the program). */
export function cmuxVerdict(words: readonly string[]): GuardVerdict {
  const args = words.slice(1);
  let i = 0;
  while (i < args.length) {
    const word = args[i] ?? '';
    if (CMUX_INFO_WORDS.has(word)) return ALLOW;
    const takesValue = CMUX_GLOBAL_OPTIONS.get(word);
    if (takesValue == null && !word.startsWith('-')) break;
    i += takesValue === true ? 2 : 1;
  }
  const sub = args[i];
  if (sub == null) {
    return deny('cmux', words, 'bare `cmux` launches or focuses the app');
  }
  if (sub.includes('/') || sub.startsWith('.') || sub.startsWith('~')) {
    return deny(
      'cmux',
      words,
      '`cmux <path>` opens a directory in a new workspace',
    );
  }
  const next = args[i + 1];
  if (next != null && HELP_WORDS.has(next)) return ALLOW;
  if (cmuxAllowed(sub)) return ALLOW;
  return deny(
    'cmux',
    words,
    `\`cmux ${sub}\` is not on the read-only allowlist: it can start a process in, type into, move, close or open a pane, tab, workspace or window`,
  );
}

function claudeAllowed(args: readonly string[]): boolean {
  const [first, second] = args;
  if (args.length === 1 && first != null) {
    return ['--version', '-v', '--help', '-h', 'doctor'].includes(first);
  }
  if (first == null) return false;
  if (
    args.length === 2 &&
    CLAUDE_SUBCOMMANDS.has(first) &&
    HELP_WORDS.has(second ?? '')
  ) {
    return true;
  }
  if (first === 'agents') return args.length === 2 && second === '--json';
  if (first === 'mcp') {
    return (
      (second === 'list' && args.length === 2) ||
      (second === 'get' && args.length === 3)
    );
  }
  if (first === 'config') {
    return (
      (second === 'list' && args.length === 2) ||
      (second === 'get' && args.length === 3)
    );
  }
  return first === 'logs';
}

/** `claude …` (the words after the program). */
export function claudeVerdict(words: readonly string[]): GuardVerdict {
  const args = words.slice(1);
  if (claudeAllowed(args)) return ALLOW;
  const first = args[0];
  let what: string;
  if (first == null) what = 'bare `claude` starts an interactive session';
  else if (args.includes('--bg'))
    what = '`claude --bg` starts a background session';
  else if (args.some((a) => ['-p', '--print'].includes(a))) {
    what = '`claude -p` runs a Claude session';
  } else if (
    args.some((a) => ['-c', '--continue', '-r', '--resume'].includes(a))
  ) {
    what = '`claude --continue` / `--resume` reopens a session';
  } else if (CLAUDE_SUBCOMMANDS.has(first)) {
    what = `\`claude ${first}\` can start, attach to, change or stop sessions`;
  } else what = 'a `claude` prompt or flag starts a session';
  return deny('claude', words, `${what}; only the read-only forms are allowed`);
}

/**
 * `thread handoff|spawn|respawn …` in any spelling that runs the SDK: a word
 * before `thread` that contains justin-sdk (`bun run justin-sdk`, the bin by
 * path `./node_modules/.bin/justin-sdk` that SDK_HANDOFF_CALL spells, a bunx
 * spec) or is a cli.ts / cli-main.ts path.
 */
export function threadCommandIn(
  words: readonly string[],
  /**
   * The subcommands to look for. Default: the ones a subagent may not run.
   * The quota brake passes its allow-list (quota-brake.ts).
   */
  subcommands: ReadonlySet<string> = SUBAGENT_DENIED_THREAD_COMMANDS,
): string | null {
  for (let i = 0; i + 1 < words.length; i++) {
    const sub = words[i + 1] ?? '';
    if (words[i] !== 'thread' || !subcommands.has(sub)) {
      continue;
    }
    const sdk = words
      .slice(0, i)
      .some(
        (w) =>
          w.includes('justin-sdk') ||
          basename(w) === 'cli.ts' ||
          basename(w) === 'cli-main.ts',
      );
    if (sdk) return sub;
  }
  return null;
}

/**
 * F14 (home-base-mbnjv.8): the words of the first top-level simple command
 * that runs `thread handoff` or `thread spawn` through the SDK, or null. Only
 * the top level: a call nested in `bash -c` gets no guard pass, so the
 * command refuses it (guardNotSeen), the cautious side; the rule says to run
 * it bare anyway.
 */
export function threadCallWords(raw: string): string[] | null {
  const scan = scanShell(raw);
  if (!scan.ok) return null;
  let tokens: Token[];
  try {
    tokens = parse<never>(scan.text, (key: string) => `$${key}`);
  } catch {
    return null;
  }
  for (const words of simpleCommands(tokens)) {
    const unwrapped = unwrapCommand(words);
    if (unwrapped.kind !== 'command') continue;
    const sub = threadCommandIn(unwrapped.words);
    if (sub === 'handoff' || sub === 'spawn') return unwrapped.words;
  }
  return null;
}

const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);

/**
 * Shell options whose value is the next word (F13: `bash -o pipefail -c …`
 * read `pipefail` as the script's name and missed the `-c`).
 */
const SHELL_VALUE_OPTIONS = new Set([
  '+O',
  '+o',
  '-O',
  '-o',
  '--init-file',
  '--rcfile',
]);

/** The script after `-c` (alone or in a cluster such as -lc), if any. */
function shellScript(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (SHELL_VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('+')) continue;
    if (!arg.startsWith('-') || arg.startsWith('--')) {
      if (arg.startsWith('--')) continue;
      return null;
    }
    if (arg.slice(1).includes('c')) return args[i + 1] ?? null;
  }
  return null;
}

const MAX_DEPTH = 8;

interface ClassifyOptions {
  depth?: number;
  /** The payload carried agent_id: the call came from a subagent. */
  subagent: boolean;
}

/** classifyCommand, passed in: a script inside a command is classified whole. */
type Recurse = (raw: string, options: ClassifyOptions) => GuardVerdict;

function classifyWords(
  words: readonly string[],
  options: Required<ClassifyOptions>,
  classifyScript: Recurse,
): GuardVerdict {
  const unwrapped = unwrapCommand(words);
  if (unwrapped.kind === 'none' || unwrapped.kind === 'lookup') return ALLOW;
  if (unwrapped.kind === 'split') {
    return classifyScript(unwrapped.script, {
      depth: options.depth + 1,
      subagent: options.subagent,
    });
  }
  const rest = unwrapped.words;
  const first = rest[0] ?? '';
  if (first.includes(SUBSTITUTION_PLACEHOLDER)) {
    // The program is whatever a substitution prints: not knowable here.
    return unreadable(words.join(' '), 'the program is a command substitution');
  }
  const program = basename(first);
  const nested = {depth: options.depth + 1, subagent: options.subagent};
  if (SHELLS.has(program)) {
    const script = shellScript(rest.slice(1));
    if (script != null) return classifyScript(script, nested);
  }
  if (program === 'eval') {
    return classifyScript(rest.slice(1).join(' '), nested);
  }
  if (['bunx', 'npx', 'pnpx'].includes(program)) {
    const at = rest.findIndex((w, i) => i > 0 && !w.startsWith('-'));
    const pkg = at < 0 ? '' : (rest[at] ?? '');
    if (
      pkg === '@anthropic-ai/claude-code' ||
      pkg.startsWith('@anthropic-ai/claude-code@')
    ) {
      return claudeVerdict(['claude', ...rest.slice(at + 1)]);
    }
    // F13: `npx claude --bg`, `npm exec -- cmux send x`: the package's bin
    // runs with the words after it, so they are read as a command.
    if (at > 0) return classifyWords(rest.slice(at), options, classifyScript);
  }
  if (MULTIPLEXERS.has(program)) {
    for (let i = 1; i < rest.length; i++) {
      const asScript = classifyScript(rest[i] ?? '', nested);
      if (asScript.kind === 'deny') return asScript;
      const asTail = classifyWords(rest.slice(i), nested, classifyScript);
      if (asTail.kind === 'deny') return asTail;
    }
    return ALLOW;
  }
  if (program === 'cmux') return cmuxVerdict(rest);
  if (program === 'claude') return claudeVerdict(rest);
  if (options.subagent) {
    const sub = threadCommandIn(rest);
    if (sub != null) {
      return deny(
        'subagentThread',
        rest,
        `a subagent may not run \`thread ${sub}\`: it shares its parent's session id, so it would act for the session that dispatched it`,
      );
    }
  }
  return ALLOW;
}

/** Classify one Bash command: the first refused simple command wins. */
export function classifyCommand(
  raw: string,
  options: ClassifyOptions,
): GuardVerdict {
  const resolved = {depth: options.depth ?? 0, subagent: options.subagent};
  if (resolved.depth > MAX_DEPTH) return unreadable(raw, 'it nests too deeply');
  const scan = scanShell(raw);
  if (!scan.ok) return unreadable(raw, scan.why);
  for (const inner of scan.substitutions) {
    const verdict = classifyCommand(inner, {
      depth: resolved.depth + 1,
      subagent: resolved.subagent,
    });
    if (verdict.kind === 'deny') return verdict;
  }
  let tokens: Token[];
  try {
    // Variables stay as written ($HOME), so a path keeps its basename.
    tokens = parse<never>(scan.text, (key: string) => `$${key}`);
  } catch (error) {
    return unreadable(
      raw,
      `the parser failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const words of simpleCommands(tokens)) {
    const verdict = classifyWords(words, resolved, classifyCommand);
    if (verdict.kind === 'deny') return verdict;
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** What every refusal tells Claude to do instead. */
export const GUARD_DOORS = [
  'Sessions never start or drive other sessions with raw cmux or claude commands.',
  `- To hand this session off to a fresh one: run \`${SDK_HANDOFF_CALL} --note "<what the successor needs>"\`, bare, from the repository root.`,
  '- To start unrelated work in a new workspace: run `bun run justin-sdk thread spawn`.',
  'Either command may refuse. A refusal is final: finish your report and stop. Do not look for another way.',
] as const;

/** The allowed forms, built from the lists so the message cannot drift. */
export function guardAllowedLine(): string {
  return [
    `Still allowed: read-only cmux (${[...CMUX_READ_ONLY_SUBCOMMANDS, `${CMUX_READ_ONLY_PREFIX}*`].join(', ')}),`,
    `cmux ${CMUX_ALLOWED_ACTIONS.join(', ')}, \`cmux <subcommand> --help\`,`,
    `and ${CLAUDE_ALLOWED_FORMS.map((f) => `\`${f}\``).join(', ')}.`,
  ].join(' ');
}

export function guardDenialMessage(
  verdict: Extract<GuardVerdict, {kind: 'deny'}>,
  recorded: string | null = null,
): string {
  const head = `thread guard: refused \`${verdict.command}\`: ${verdict.why}.`;
  if (verdict.reason === 'subagentThread') {
    return [
      head,
      '',
      `Finish your work and report to the session that dispatched you. That session decides whether to run \`${SDK_HANDOFF_CALL}\`.`,
      ...(recorded == null ? [] : ['', recorded]),
    ].join('\n');
  }
  return [head, '', ...GUARD_DOORS, '', guardAllowedLine()].join('\n');
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface GuardPayload {
  agentId: string | null;
  agentType: string | null;
  command: string | null;
  cwd: string | null;
  sessionId: string | null;
  toolName: string | null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The fields the guard reads, or null when the payload is not a JSON object. */
export function parseGuardPayload(raw: string): GuardPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const input = record.tool_input;
  const command =
    input != null && typeof input === 'object'
      ? nonEmptyText((input as Record<string, unknown>).command)
      : null;
  return {
    agentId: nonEmptyText(record.agent_id),
    agentType: nonEmptyText(record.agent_type),
    command,
    cwd: nonEmptyText(record.cwd),
    sessionId: nonEmptyText(record.session_id),
    toolName: nonEmptyText(record.tool_name),
  };
}

export interface GuardHookDeps {
  /** classifyCommand; injected so a test can make it throw (F14). */
  classify: typeof classifyCommand;
  /** Is componentConfig.thread.handoff.successor on for this project? */
  knobOn: (projectRoot: string, env: EnvLike) => Promise<boolean> | boolean;
  /** Record a subagent's refused thread command; returns the line to print. */
  recordSubagent: (input: {
    agentId: string;
    agentType: string | null;
    command: string;
    env: EnvLike;
    now: Date;
    sessionId: string | null;
  }) => Promise<string> | string;
  /** writeGuardPass; injected in tests. */
  writePass: typeof writeGuardPass;
}

async function realKnobOn(projectRoot: string, env: EnvLike): Promise<boolean> {
  const {resolveThreadConfig} = await import('./config');
  return resolveThreadConfig({cwd: projectRoot, env}).handoff.successor;
}

async function realRecordSubagent(
  input: Parameters<GuardHookDeps['recordSubagent']>[0],
): Promise<string> {
  const {recordSubagentRefusal} = await import('./guard-refusal');
  return recordSubagentRefusal(input);
}

export interface GuardHookResult {
  exitCode: 0 | 2;
  stderr: string;
}

/**
 * F14 (home-base-mbnjv.8): when the guard cannot do its job (a throw, a
 * payload it cannot read), it denies any call whose text holds the whole word
 * claude or cmux and allows the rest, saying so on stderr. It never fails
 * open on the calls it exists for.
 */
function failedGuard(stdin: string, why: string): GuardHookResult {
  if (SESSION_WORD.test(stdin)) {
    return {
      exitCode: 2,
      stderr: `thread guard: refused: ${why}, and this call names cmux or claude, so it is refused rather than let through unchecked.\n\n${GUARD_DOORS.join('\n')}\n`,
    };
  }
  return {
    exitCode: 0,
    stderr: `thread guard: ${why}; this call was not checked\n`,
  };
}

async function guardHookUnsafe(
  args: {env?: EnvLike; now?: Date; stdin: string},
  deps: Partial<GuardHookDeps>,
): Promise<GuardHookResult> {
  const env = args.env ?? process.env;
  const payload = parseGuardPayload(args.stdin);
  if (payload == null) {
    return failedGuard(args.stdin, 'the hook payload is not a JSON object');
  }
  if (payload.toolName !== 'Bash' || payload.command == null) {
    return {exitCode: 0, stderr: ''};
  }
  const projectRoot =
    nonEmptyText(env.CLAUDE_PROJECT_DIR) ?? payload.cwd ?? process.cwd();
  if (!(await (deps.knobOn ?? realKnobOn)(projectRoot, env))) {
    return {exitCode: 0, stderr: ''};
  }
  const verdict = (deps.classify ?? classifyCommand)(payload.command, {
    subagent: payload.agentId != null,
  });
  if (verdict.kind === 'allow') {
    // F14: the pass `thread handoff|spawn` needs, for main sessions only (a
    // subagent's call is denied above). A failed write is said on stderr; the
    // command then refuses with guardNotSeen, the cautious side.
    const words =
      payload.agentId == null ? threadCallWords(payload.command) : null;
    if (words == null) return {exitCode: 0, stderr: ''};
    if (payload.sessionId == null) {
      return {
        exitCode: 0,
        stderr:
          'thread guard: no session_id in the payload, so no guard pass was written; thread handoff/spawn will refuse (guardNotSeen)\n',
      };
    }
    const written = (deps.writePass ?? writeGuardPass)({
      env,
      now: args.now ?? new Date(),
      sessionId: payload.sessionId,
      words,
    });
    return {
      exitCode: 0,
      stderr:
        written.kind === 'written'
          ? ''
          : `thread guard: the guard pass was NOT written (${written.reason}); thread handoff/spawn will refuse (guardNotSeen)\n`,
    };
  }
  let recorded: string | null = null;
  if (verdict.reason === 'subagentThread' && payload.agentId != null) {
    try {
      recorded = await (deps.recordSubagent ?? realRecordSubagent)({
        agentId: payload.agentId,
        agentType: payload.agentType,
        command: verdict.command,
        env,
        now: args.now ?? new Date(),
        sessionId: payload.sessionId,
      });
    } catch (error) {
      recorded = `⚠️ The refusal was NOT recorded: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {exitCode: 2, stderr: `${guardDenialMessage(verdict, recorded)}\n`};
}

/**
 * One PreToolUse run: allow (exit 0, nothing printed) or deny (exit 2, the
 * message on stderr). Any failure of its own goes through failedGuard (F14).
 * An allowed `thread handoff|spawn` from a main session leaves the one-time
 * guard pass the command needs (guard-pass.ts).
 */
export async function guardHook(
  args: {env?: EnvLike; now?: Date; stdin: string},
  deps: Partial<GuardHookDeps> = {},
): Promise<GuardHookResult> {
  try {
    return await guardHookUnsafe(args, deps);
  } catch (error) {
    return failedGuard(
      args.stdin,
      `the guard failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The CLI: read stdin once, decide, print, exit. */
export async function runThreadGuardHook(
  args: {explain?: boolean} = {},
): Promise<number> {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
  const result = await guardHook({stdin});
  if (args.explain === true && result.exitCode === 0) {
    process.stderr.write('thread guard: allowed\n');
  }
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}
