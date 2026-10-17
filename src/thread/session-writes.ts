/**
 * Which files THIS session wrote, from its own transcript (home-base-j8q3e.6
 * D1-D3). The inbox used to put every uncommitted file of a shared checkout on
 * every untracked session that had ever run there (measured 2026-10-17: about
 * 25 home-base cards said "commit the 1 uncommitted file" for a file a
 * different live session was editing). Now an untracked card names a dirty
 * file only when the session's own transcript shows it writing that path,
 * after the path's last commit.
 *
 * D1, "the session wrote it": the path is the `file_path` of an Edit, Write or
 * MultiEdit tool_use, or the `notebook_path` of a NotebookEdit, or it appears
 * in the command of a Bash tool_use. The main transcript and every subagent
 * transcript beside it count (a player's edits are the session's work). The
 * shape copies session-commits.ts: a pure scan of one file's text, and a
 * reader over main plus subagents.
 *
 * D2, critical rule 7: a transcript that cannot be read is `{ok: false}`,
 * never "it wrote nothing" — the card then says the files could not be
 * attributed and goes to "Check it by hand".
 *
 * D3, the time rule: a write counts only when it is newer than the path's
 * last commit (`git log -1 --format=%ct -- <path>`). Without it, a session
 * that edited a file weeks ago, since committed, is blamed the day another
 * session dirties the same path.
 */

import {readFileSync} from 'fs';
import {homedir} from 'os';
import {basename, isAbsolute, join, relative, resolve} from 'path';

import {subagentTranscripts} from './session-commits';

/** The tools whose input names the file they write (D1). */
const PATH_TOOLS: Readonly<Record<string, 'file_path' | 'notebook_path'>> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Write: 'file_path',
};

/** A raw-line filter before any parse: one of D1's tools, as a tool_use. */
const TOOL_NAME_IN_RAW = /"name":"(?:Bash|Edit|MultiEdit|NotebookEdit|Write)"/;

export interface PathWrite {
  file: string;
  /** Absolute, as the tool_use names it (`resolve`d). */
  path: string;
  /** The tool_use record's time; null when no record of it carries one. */
  writtenAt: string | null;
}

export interface BashWrite {
  command: string;
  file: string;
  /** The tool_use record's time; null when no record of it carries one. */
  writtenAt: string | null;
}

export interface WriteEvidence {
  commands: BashWrite[];
  /** Every transcript file read, the main one first. */
  files: string[];
  paths: PathWrite[];
  /** Lines that were not JSON (a line being written is the usual cause). */
  unparsedLines: number;
}

function stringField(value: unknown, key: string): string | null {
  if (value == null || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : null;
}

function contentBlocks(record: unknown): unknown[] {
  if (record == null || typeof record !== 'object') return [];
  const message = (record as {message?: unknown}).message;
  if (message == null || typeof message !== 'object') return [];
  const content = (message as {content?: unknown}).content;
  return Array.isArray(content) ? content : [];
}

/**
 * D1's evidence in one transcript file's text. Pure: the tests drive it with
 * literal JSONL. A tool_use id seen twice (Claude Code's `api-request-blob`
 * record repeats an assistant message with no timestamp, home-base-j8q3e.1.4)
 * is one write, dated by the first record that carries a time.
 */
export function writtenPathsFromText(
  text: string,
  file: string,
): Omit<WriteEvidence, 'files'> {
  const byId = new Map<
    string,
    {kind: 'bash' | 'path'; value: string; writtenAt: string | null}
  >();
  let unparsedLines = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') || !TOOL_NAME_IN_RAW.test(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      unparsedLines += 1;
      continue;
    }
    const at = stringField(record, 'timestamp');
    for (const block of contentBlocks(record)) {
      if (block == null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type !== 'tool_use' || typeof entry.name !== 'string') continue;
      const id = stringField(entry, 'id');
      if (id == null) continue;
      let found: {kind: 'bash' | 'path'; value: string} | null = null;
      if (entry.name === 'Bash') {
        const command = stringField(entry.input, 'command');
        if (command != null) found = {kind: 'bash', value: command};
      } else {
        const key = PATH_TOOLS[entry.name];
        const path = key == null ? null : stringField(entry.input, key);
        if (path != null) found = {kind: 'path', value: resolve(path)};
      }
      if (found == null) continue;
      byId.set(id, {...found, writtenAt: byId.get(id)?.writtenAt ?? at});
    }
  }
  const paths: PathWrite[] = [];
  const commands: BashWrite[] = [];
  for (const entry of byId.values()) {
    if (entry.kind === 'path') {
      paths.push({file, path: entry.value, writtenAt: entry.writtenAt});
    } else {
      commands.push({command: entry.value, file, writtenAt: entry.writtenAt});
    }
  }
  return {commands, paths, unparsedLines};
}

/**
 * D1 over the main transcript and every subagent transcript beside it, or why
 * one of them could not be read (D2: never an empty list for that).
 */
export function readWrittenPaths(
  transcriptPath: string,
): {evidence: WriteEvidence; ok: true} | {ok: false; reason: string} {
  const subagents = subagentTranscripts(transcriptPath);
  if (!subagents.ok) return subagents;
  const files = [transcriptPath, ...subagents.files];
  const evidence: WriteEvidence = {
    commands: [],
    files,
    paths: [],
    unparsedLines: 0,
  };
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const one = writtenPathsFromText(text, file);
    evidence.paths.push(...one.paths);
    evidence.commands.push(...one.commands);
    evidence.unparsedLines += one.unparsedLines;
  }
  return {evidence, ok: true};
}

// ---------------------------------------------------------------------------
// Matching a checkout's dirty paths to the evidence (pure)
// ---------------------------------------------------------------------------

/**
 * One `git status --porcelain` path, unquoted. git C-quotes a path holding
 * special characters ("a b.txt", octal escapes for non-ASCII bytes).
 */
export function unquotePorcelainPath(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  const simple: Readonly<Record<string, number>> = {
    '"': 0x22,
    '\\': 0x5c,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1, index + 4));
    if (octal != null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (simple[next] != null) {
      bytes.push(simple[next]);
      index += 1;
    } else {
      bytes.push(...Buffer.from(char, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The paths one porcelain entry names: both sides of a rename (`old -> new`). */
export function porcelainSides(entry: string): string[] {
  return entry.split(' -> ').map(unquotePorcelainPath);
}

/** Characters that may sit right before or after a path named in a command. */
const BEFORE = /[\s'"=(;&|<>:`]/;
const AFTER = /[\s'";&|)<>`:]/;

/** Every index at which `command` names `needle` as a whole path. */
function namedAt(command: string, needle: string): number[] {
  if (needle === '') return [];
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = command.indexOf(needle, from);
    if (at < 0) return found;
    const before = at === 0 ? '' : (command[at - 1] ?? '');
    const after = command[at + needle.length] ?? '';
    const startOk = before === '' || BEFORE.test(before);
    // A directory entry ("dir/") already ends in its separator, so whatever
    // follows it is a path inside the directory.
    const endOk = after === '' || AFTER.test(after) || needle.endsWith('/');
    if (startOk && endOk) found.push(at);
    from = at + 1;
  }
}

/** Does `command` name `needle` as a whole path (not inside a longer one)? */
export function commandNames(command: string, needle: string): boolean {
  return namedAt(command, needle).length > 0;
}

// ---------------------------------------------------------------------------
// Which paths a Bash command WRITES (home-base-j8q3e.13 F3)
// ---------------------------------------------------------------------------

/**
 * F3: verbs whose command only reads the paths it names. Measured 2026-10-17:
 * 25 home-base transcripts name justin-sdk.config.json in a Bash command, and
 * most of them are cat, jq, git diff or ls, so counting every named path as
 * written blamed sessions that had only read the file. `bun run <x>` is NOT
 * read-only: a script may write anything.
 */
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'cat',
  'diff',
  'file',
  'grep',
  'head',
  'jq',
  'less',
  'ls',
  'more',
  'open',
  'rg',
  'stat',
  'tail',
  'wc',
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  'blame',
  'diff',
  'grep',
  'log',
  'show',
  'status',
]);

/**
 * F3: the simple commands of a Bash command, split on `&&`, `||`, `;`, `|`
 * and newlines outside quotes. Pure.
 */
export function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  const push = (): void => {
    if (current.trim() !== '') segments.push(current.trim());
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    const next = command[index + 1] ?? '';
    if (quote != null) {
      current += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && next !== '') {
        current += next;
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === '\\' && next !== '') {
      current += char + next;
      index += 1;
    } else if (char === '\n' || char === ';') {
      push();
    } else if ((char === '&' || char === '|') && next === char) {
      push();
      index += 1;
    } else if (char === '|') {
      push();
      if (next === '&') index += 1;
    } else {
      current += char;
    }
  }
  push();
  return segments;
}

/** A segment's words from its command name on: env assignments and `time` dropped. */
function commandWords(segment: string): string[] {
  const words = segment
    .replace(/^[\s({!]+/u, '')
    .split(/\s+/u)
    .filter((word) => word !== '');
  let start = 0;
  while (
    start < words.length &&
    (/^[A-Za-z_]\w*=/u.test(words[start] ?? '') || words[start] === 'time')
  ) {
    start += 1;
  }
  return words.slice(start);
}

function unquoteWord(word: string): string {
  return word.replace(/^['"]|['"]$/gu, '');
}

/** F3: does this simple command only read the paths it names? */
export function isReadOnlySegment(segment: string): boolean {
  const [first, ...rest] = commandWords(segment);
  if (first == null) return true;
  const verb = basename(unquoteWord(first));
  if (READ_ONLY_VERBS.has(verb)) return true;
  if (verb === 'bun') return rest[0] === 'test';
  if (verb !== 'git') return false;
  // git's own options come before its subcommand; -C and -c take a value.
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? '';
    if (word === '-C' || word === '-c') {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return READ_ONLY_GIT.has(word);
  }
  return false;
}

/**
 * F3: where a `cd` segment leaves the command, for matching paths relative to
 * the checkout: the new directory when it is inside `top`, null when it is
 * outside the checkout or cannot be told (`cd -`, a variable, a glob). undefined
 * when the segment is not a `cd`.
 */
function cdResult(
  segment: string,
  base: string | null,
  top: string,
): string | null | undefined {
  const words = commandWords(segment);
  if (words[0] !== 'cd') return undefined;
  const target = unquoteWord(
    words
      .slice(1)
      .filter((word) => word !== '-P' && word !== '-L')
      .join(' '),
  );
  let directory: string | null;
  if (target === '' || target === '~') directory = homedir();
  else if (target.startsWith('~/'))
    directory = join(homedir(), target.slice(2));
  else if (target === '-' || /[$`*?]/u.test(target)) directory = null;
  else if (isAbsolute(target)) directory = resolve(target);
  else directory = base == null ? null : resolve(base, target);
  if (directory == null) return null;
  return directory === top || directory.startsWith(`${top}/`)
    ? directory
    : null;
}

/** F3: is the path at `at` the target of an output redirection (`>`, `>>`, `2>`)? */
function redirectedAt(segment: string, at: number): boolean {
  return segment.slice(0, at).trimEnd().endsWith('>');
}

/**
 * F3: does `command` write `side` (one porcelain path, relative to `top`)?
 * Per simple command: a read-only verb (READ_ONLY_VERBS, a read-only git
 * subcommand, `bun test`) counts the path only as the target of `>` or `>>`;
 * any other verb counts it wherever it is named (`tee`, `echo x > f`, `git
 * add`, `bun run`). A relative path is matched against the directory the
 * command is in: the checkout's top, moved by each `cd`; after a `cd` out of
 * the checkout only the absolute path is matched. Pure.
 */
export function commandWritesPath(
  command: string,
  top: string,
  side: string,
): boolean {
  const isDir = side.endsWith('/');
  const absolute = resolve(top, side);
  // Every needle below holds the path's last component.
  if (!command.includes(basename(absolute))) return false;
  const absoluteNeedle = isDir ? `${absolute}/` : absolute;
  let base: string | null = top;
  for (const segment of commandSegments(command)) {
    const moved = cdResult(segment, base, top);
    if (moved !== undefined) {
      base = moved;
      continue;
    }
    const needles = [absoluteNeedle];
    if (base != null) {
      const rel = relative(base, absolute);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
        const relNeedle = isDir ? `${rel}/` : rel;
        needles.push(relNeedle, `./${relNeedle}`);
      }
    }
    const readOnly = isReadOnlySegment(segment);
    for (const needle of needles) {
      for (const at of namedAt(segment, needle)) {
        if (!readOnly || redirectedAt(segment, at)) return true;
      }
    }
  }
  return false;
}

/**
 * The newest write of one dirty porcelain entry in `evidence`, D1's match:
 * an Edit/Write path equal to its absolute form (or inside it, for an
 * untracked directory entry `dir/`), or a Bash command that writes it
 * (`commandWritesPath`, j8q3e.13 F3: named relative to the checkout or
 * absolute, by a verb that does not only read it). `{at: null}` = a matching
 * write no record dates; null = no write matches.
 */
export function newestWriteOf(
  entry: string,
  top: string,
  evidence: Pick<WriteEvidence, 'commands' | 'paths'>,
): {at: number | null} | null {
  let newest: number | null = null;
  let matched = false;
  let undated = false;
  const consider = (writtenAt: string | null): void => {
    matched = true;
    const ms = writtenAt == null ? Number.NaN : Date.parse(writtenAt);
    if (Number.isNaN(ms)) {
      undated = true;
      return;
    }
    if (newest == null || ms > newest) newest = ms;
  };
  for (const side of porcelainSides(entry)) {
    const isDir = side.endsWith('/');
    const absolute = resolve(top, side);
    for (const write of evidence.paths) {
      if (
        write.path === absolute ||
        (isDir && write.path.startsWith(`${absolute}/`))
      ) {
        consider(write.writtenAt);
      }
    }
    // j8q3e.13 F3: a command that only reads the path does not count.
    for (const write of evidence.commands) {
      if (commandWritesPath(write.command, top, side)) {
        consider(write.writtenAt);
      }
    }
  }
  if (!matched) return null;
  // An undated write cannot be shown older than the last commit, so it counts.
  return {at: undated ? null : newest};
}

/** git stores whole seconds; a write must beat the commit by more than this. */
export const COMMIT_TIME_SLACK_MS = 1000;

/**
 * D3: the dirty entries this session wrote after their last commit. Pure.
 * `lastCommitMs` has, for each entry the session wrote, the path's last
 * commit time (null = never committed: any write counts).
 */
export function ownDirtyPaths(input: {
  dirty: readonly string[];
  evidence: Pick<WriteEvidence, 'commands' | 'paths'>;
  lastCommitMs: ReadonlyMap<string, number | null>;
  top: string;
}): string[] {
  const own: string[] = [];
  for (const entry of input.dirty) {
    const write = newestWriteOf(entry, input.top, input.evidence);
    if (write == null) continue;
    const committed = input.lastCommitMs.get(entry) ?? null;
    if (
      committed == null ||
      write.at == null ||
      write.at > committed + COMMIT_TIME_SLACK_MS
    ) {
      own.push(entry);
    }
  }
  return own;
}

/** The porcelain entries this session wrote at all: the ones whose last commit must be read. */
export function writtenDirtyPaths(
  dirty: readonly string[],
  top: string,
  evidence: Pick<WriteEvidence, 'commands' | 'paths'>,
): string[] {
  return dirty.filter((entry) => newestWriteOf(entry, top, evidence) != null);
}
