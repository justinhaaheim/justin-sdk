/**
 * file-audit — the audit log of Claude Code's file access outside ~/Dev
 * (home-base-n1qy7.15.1, stage 1 of home-base-n1qy7.15).
 *
 * Justin, 2026-11-27: "At a very minimum I want to have a clear audit log of
 * when claude code has accessed files outside of ~/Dev/ so that I can
 * see/audit access retroactively." And: "it's entirely possible we implement
 * this and then I realize it's too noisy, and we have to tweak things."
 *
 * `justin-sdk file-audit hook` is a PreToolUse handler on EVERY tool. It
 * appends one JSONL line to `$XDG_STATE_HOME/claude-file-audit/access.jsonl`
 * for a tool call that names a path outside ~/Dev, a Bash call that runs
 * outside the sandbox, or a payload it cannot read. It LOGS ONLY (D5): it
 * prints nothing to stdout and returns no decision on any path, so it cannot
 * block or change a tool call.
 *
 * WHAT A HOOK CAN SEE. Tool arguments, not what a process opens. A Bash line
 * says `confidence: "arguments-only"`: `cat ~/x` is seen, a script that reads
 * ~/x is not. Only the OS sandbox enforces for subprocesses.
 *
 * A LEAF ON PURPOSE (D7). It runs on every tool call in every enrolled repo,
 * so it imports node builtins and the shell-scan leaf, and reads its knob and
 * the sandbox settings by hand, never through sdk-config (zod).
 *
 * UNKNOWN IS NEVER "INSIDE" OR "SANDBOXED" (critical rule 7): a path that
 * cannot be resolved is logged, settings that cannot be read are logged as
 * `source: "unknown"`, and a payload that cannot be read is logged as
 * `unparsed`.
 */

import {readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import parse from 'shell-quote/parse';

import {scanShell, type ShellToken, simpleCommands} from '../shell-scan';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Where the log is, and the knob
// ---------------------------------------------------------------------------

/** What an absent `componentConfig["file-audit"].enabled` means. */
export const FILE_AUDIT_ENABLED_DEFAULT = true;

/** The log's directory name under the XDG state home. */
export const FILE_AUDIT_STATE_DIR = 'claude-file-audit';

/** The log's file name. */
export const FILE_AUDIT_LOG_FILE = 'access.jsonl';

/** At most this many paths per line (D4). */
export const MAX_PATHS = 50;

/** At most this many characters of a Bash command or a raw payload (D4). */
export const MAX_TEXT = 2000;

function homeOf(env: Env): string {
  const home = env.HOME;
  return home != null && home !== '' ? home : homedir();
}

function xdg(env: Env, key: string, fallback: string[]): string {
  const value = env[key];
  return value != null && value !== '' && isAbsolute(value)
    ? value
    : join(homeOf(env), ...fallback);
}

/** `$XDG_STATE_HOME/claude-file-audit/access.jsonl`, or under ~/.local/state. */
export function auditLogPath(env: Env = process.env): string {
  return join(
    xdg(env, 'XDG_STATE_HOME', ['.local', 'state']),
    FILE_AUDIT_STATE_DIR,
    FILE_AUDIT_LOG_FILE,
  );
}

/** The user config file, the same join as sdk-config's `userConfigPath`. */
export function fileAuditUserConfigPath(env: Env = process.env): string {
  return join(
    xdg(env, 'XDG_CONFIG_HOME', ['.config']),
    'justin-sdk',
    'config.json',
  );
}

/** One file's `componentConfig["file-audit"].enabled`: the boolean, or null. */
function knobIn(path: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Absent or unreadable: neither turns logging off. The cautious direction
    // for an audit log is to keep logging.
    return null;
  }
  const value = (
    (
      (parsed as {componentConfig?: unknown} | null)?.componentConfig as
        | Record<string, unknown>
        | undefined
    )?.['file-audit'] as {enabled?: unknown} | undefined
  )?.enabled;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Is the audit log on here? `false` in the USER file turns it off everywhere;
 * `false` in the repo's justin-sdk.config.json turns it off in that repo
 * (description item 3). Anything else, a file that cannot be read included,
 * leaves it on.
 */
export function fileAuditEnabled(args: {
  env: Env;
  projectRoot: string | null;
}): boolean {
  if (knobIn(fileAuditUserConfigPath(args.env)) === false) return false;
  if (
    args.projectRoot != null &&
    knobIn(join(args.projectRoot, 'justin-sdk.config.json')) === false
  ) {
    return false;
  }
  return FILE_AUDIT_ENABLED_DEFAULT;
}

// ---------------------------------------------------------------------------
// Paths (D1, D2)
// ---------------------------------------------------------------------------

export type PathCategory = 'claude-state' | 'other' | 'temp';
export type PathAccess = 'read' | 'search' | 'unknown' | 'write';

export interface LoggedPath {
  access: PathAccess;
  category: PathCategory;
  raw: string;
  /** The realpath (or nearest existing parent plus the rest), or null. */
  resolved: string | null;
}

/** Device files that are never logged (D1). */
const DEVICE_FILES = new Set([
  '/dev/null',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/tty',
]);

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The places D1 compares against, measured once per call. */
export interface AuditPlaces {
  /** ~/.claude, literally and as a realpath. */
  claudeState: string[];
  /** The realpath of ~/Dev: the only inside. */
  dev: string;
  home: string;
  /** /tmp, /var/folders, their /private forms, and $TMPDIR. */
  temp: string[];
}

export function auditPlaces(env: Env): AuditPlaces {
  const home = homeOf(env);
  const claude = join(home, '.claude');
  const temp = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  const tmpdir = env.TMPDIR;
  if (tmpdir != null && tmpdir !== '' && isAbsolute(tmpdir)) {
    const trimmed = tmpdir.replace(/\/+$/, '');
    temp.push(trimmed, realOrSelf(trimmed));
  }
  return {
    claudeState: [claude, realOrSelf(claude)],
    dev: realOrSelf(join(home, 'Dev')),
    home,
    temp,
  };
}

function under(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
  );
}

/**
 * `~`, `~/x`, `$HOME/x` and `${HOME}/x` with the home directory put in.
 * `~other/x` (another user's home) is null: it cannot be resolved here.
 */
export function expandHome(raw: string, home: string): string | null {
  if (raw === '~' || raw === '$HOME' || raw === '${HOME}') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  if (raw.startsWith('$HOME/')) return join(home, raw.slice(6));
  if (raw.startsWith('${HOME}/')) return join(home, raw.slice(8));
  if (raw.startsWith('~')) return null;
  return raw;
}

/**
 * The realpath of an absolute path. When it does not exist (a file about to be
 * written), the realpath of its nearest existing parent with the rest
 * appended, so a new file under a symlink that leaves ~/Dev is still outside.
 * Null when not even `/` resolves.
 */
export function resolveReal(absolute: string): string | null {
  let current = resolve(absolute);
  const rest: string[] = [];
  for (let depth = 0; depth < 512; depth++) {
    try {
      const real = realpathSync(current);
      return rest.length === 0 ? real : join(real, ...[...rest].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      rest.push(basename(current));
      current = parent;
    }
  }
  return null;
}

/**
 * One path as D2 resolves it, or null when it is a device file or is inside
 * ~/Dev (nothing to log). A relative path resolves against `cwd`; with no
 * cwd it cannot be resolved, so it is logged.
 */
export function classifyPath(
  raw: string,
  access: PathAccess,
  cwd: string | null,
  places: AuditPlaces,
): LoggedPath | null {
  if (DEVICE_FILES.has(raw)) return null;
  const expanded = expandHome(raw, places.home);
  let absolute: string | null = null;
  if (expanded != null) {
    if (isAbsolute(expanded)) absolute = expanded;
    else if (cwd != null && isAbsolute(cwd)) absolute = resolve(cwd, expanded);
  }
  if (absolute != null && DEVICE_FILES.has(resolve(absolute))) return null;
  const resolved = absolute == null ? null : resolveReal(absolute);
  if (resolved != null && under(resolved, places.dev)) return null;
  const compared = resolved ?? absolute ?? raw;
  const category: PathCategory = places.temp.some((root) =>
    under(compared, root),
  )
    ? 'temp'
    : places.claudeState.some((root) => under(compared, root))
      ? 'claude-state'
      : 'other';
  return {access, category, raw, resolved};
}

/** The literal prefix of a glob pattern before its first glob character. */
export function globPrefix(pattern: string): string {
  const index = pattern.search(/[*?[{]/);
  return index < 0 ? pattern : pattern.slice(0, index);
}

// ---------------------------------------------------------------------------
// Bash (D2, D3)
// ---------------------------------------------------------------------------

/** Is this Bash word a path by D2's rule? */
function looksLikePath(word: string): boolean {
  if (word === '' || word.includes('__guard_substitution__')) return false;
  if (word.startsWith('/') || word.startsWith('~')) return true;
  if (word === '$HOME' || word === '${HOME}') return true;
  if (word.startsWith('$HOME/') || word.startsWith('${HOME}/')) return true;
  return word.startsWith('..') || word.includes('/');
}

/** `NAME=value` (a shell assignment), or `-x=value` / `--opt=value`. */
const VALUE_AFTER_EQUALS = /^(?:[A-Za-z_][A-Za-z0-9_]*|--?[^=\s]+)=/;

/**
 * The path a Bash word names, or null. A word that starts with `/`, `~` or
 * `$HOME` is taken whole. `D=/x`, `-f=/x` and `--file=/x` name the part after
 * the first `=` (F1, seen live: `D=/private/tmp/…` used to resolve as a
 * relative path under the cwd and be dropped); their value is tested on its
 * own, and nothing is collected when it is not a path.
 */
function pathWord(word: string): string | null {
  if (
    word.startsWith('/') ||
    word.startsWith('~') ||
    word.startsWith('$HOME') ||
    word.startsWith('${HOME}')
  ) {
    return looksLikePath(word) ? word : null;
  }
  const assignment = VALUE_AFTER_EQUALS.exec(word);
  if (assignment != null) {
    const value = word.slice(assignment[0].length);
    return looksLikePath(value) ? value : null;
  }
  return looksLikePath(word) ? word : null;
}

/** Every top-level and substituted command's tokens; null when unreadable. */
function tokensOf(raw: string, depth = 0): ShellToken[][] | null {
  if (depth > 4) return [];
  const scan = scanShell(raw);
  if (!scan.ok) return null;
  let tokens: ShellToken[];
  try {
    tokens = parse<never>(scan.text, (key: string) => `$${key}`);
  } catch {
    return null;
  }
  const all: ShellToken[][] = [tokens];
  for (const inner of scan.substitutions) {
    const nested = tokensOf(inner, depth + 1);
    if (nested == null) return null;
    all.push(...nested);
  }
  return all;
}

/**
 * The path-like words of a Bash command, redirect targets included, or null
 * when the command cannot be read (an unclosed quote or substitution).
 */
export function bashPathWords(command: string): string[] | null {
  const groups = tokensOf(command);
  if (groups == null) return null;
  const words: string[] = [];
  for (const tokens of groups) {
    for (const token of tokens) {
      if (typeof token === 'string') {
        const path = pathWord(token);
        if (path != null) words.push(path);
      } else if ('op' in token && token.op === 'glob') {
        const prefix = globPrefix(token.pattern);
        if (looksLikePath(prefix)) words.push(prefix);
      }
    }
  }
  return words;
}

export type UnsandboxedSource =
  | 'excludedCommands'
  | 'flag'
  | 'sandboxDisabled'
  | 'unknown';

export interface Unsandboxed {
  /** True when this is read from settings, not from the payload. */
  inferred: boolean;
  /** The excludedCommands pattern that matched, or null. */
  pattern: string | null;
  /** Which simple command matched the pattern, or null. */
  position: 'first' | 'later' | null;
  source: UnsandboxedSource;
  /** For `unknown`: what could not be read. */
  why: string | null;
}

/** The merged sandbox settings, or why they could not be read. */
export type SandboxSettings =
  | {enabled: boolean; excludedCommands: string[]; ok: true}
  | {ok: false; why: string};

function errorCode(error: unknown): string | null {
  return error != null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as {code: unknown}).code === 'string'
    ? (error as {code: string}).code
    : null;
}

/**
 * Claude Code's sandbox settings merged across user, project and local
 * settings files: `enabled` from the last file that sets it, the
 * excludedCommands of all three. An absent file contributes nothing; a file
 * that exists and cannot be read, or whose `sandbox` is the wrong shape, makes
 * the whole answer unknown (D3: a failed read never reads as "sandboxed").
 * Managed settings are not read.
 */
export function readSandboxSettings(args: {
  env: Env;
  projectRoot: string | null;
}): SandboxSettings {
  const files = [join(homeOf(args.env), '.claude', 'settings.json')];
  if (args.projectRoot != null) {
    files.push(
      join(args.projectRoot, '.claude', 'settings.json'),
      join(args.projectRoot, '.claude', 'settings.local.json'),
    );
  }
  let enabled = false;
  const excludedCommands: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      return {
        ok: false,
        why: `could not read ${file} (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {ok: false, why: `${file} is not valid JSON`};
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {ok: false, why: `${file} is not a JSON object`};
    }
    const sandbox = (parsed as {sandbox?: unknown}).sandbox;
    if (sandbox === undefined) continue;
    if (
      sandbox == null ||
      typeof sandbox !== 'object' ||
      Array.isArray(sandbox)
    ) {
      return {
        ok: false,
        why: `${file} has a sandbox value that is not an object`,
      };
    }
    const fields = sandbox as {enabled?: unknown; excludedCommands?: unknown};
    if (typeof fields.enabled === 'boolean') enabled = fields.enabled;
    if (Array.isArray(fields.excludedCommands)) {
      for (const pattern of fields.excludedCommands) {
        if (typeof pattern === 'string') excludedCommands.push(pattern);
      }
    }
  }
  return {enabled, excludedCommands, ok: true};
}

/**
 * Does an excludedCommands pattern match one simple command? `prefix *` and
 * `prefix:*` match the prefix alone or followed by arguments; any other `*`
 * matches anything; otherwise the command must be the pattern exactly. This is
 * this module's reading of Claude Code's matching (inferred, not measured).
 */
export function excludedPatternMatches(
  pattern: string,
  command: string,
): boolean {
  const trimmed = pattern.trim();
  const prefix = trimmed.endsWith(' *')
    ? trimmed.slice(0, -2)
    : trimmed.endsWith(':*')
      ? trimmed.slice(0, -2)
      : null;
  if (prefix != null && !prefix.includes('*')) {
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (trimmed.includes('*')) {
    const source = trimmed
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(command);
  }
  return command === trimmed;
}

/**
 * Which of D3's sources says this Bash call runs outside the sandbox, or null
 * when none does. Order: the payload's flag, then unreadable settings, then a
 * sandbox that is not enabled, then excludedCommands. `bun` as the first word
 * is never excluded, and a command whose first simple command does not match
 * but a later one does is logged with `position: "later"` (measured: a leading
 * `cd` keeps the whole command sandboxed, home-base CLAUDE.md Sandbox).
 */
export function unsandboxedSource(args: {
  command: string;
  flag: boolean;
  settings: SandboxSettings;
}): Unsandboxed | null {
  const none = {pattern: null, position: null, why: null};
  if (args.flag) return {...none, inferred: false, source: 'flag'};
  if (!args.settings.ok) {
    return {
      ...none,
      inferred: true,
      source: 'unknown',
      why: args.settings.why,
    };
  }
  if (!args.settings.enabled) {
    return {...none, inferred: true, source: 'sandboxDisabled'};
  }
  const patterns = args.settings.excludedCommands;
  if (patterns.length === 0) return null;
  const scan = scanShell(args.command);
  if (!scan.ok) return null;
  let commands: string[][];
  try {
    commands = simpleCommands(
      parse<never>(scan.text, (key: string) => `$${key}`),
    );
  } catch {
    return null;
  }
  for (const [index, words] of commands.entries()) {
    if (index === 0 && words[0] === 'bun') continue;
    const text = words.join(' ');
    const pattern = patterns.find((p) => excludedPatternMatches(p, text));
    if (pattern != null) {
      return {
        inferred: true,
        pattern,
        position: index === 0 ? 'first' : 'later',
        source: 'excludedCommands',
        why: null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One tool call
// ---------------------------------------------------------------------------

export type AuditReason = 'outside-path' | 'unparsed' | 'unsandboxed';

export interface AuditLine {
  agent_id: string | null;
  agent_type: string | null;
  command: string | null;
  command_truncated: boolean;
  confidence: 'arguments-only' | 'tool-input' | null;
  cwd: string | null;
  paths: LoggedPath[];
  paths_truncated: boolean;
  permission_mode: string | null;
  /** The raw payload, cut to MAX_TEXT, on an unparsed line only. */
  raw?: string | null;
  raw_truncated?: boolean;
  reasons: AuditReason[];
  session_id: string | null;
  tool: string | null;
  tool_use_id: string | null;
  ts: string;
  unsandboxed: Unsandboxed | null;
  v: 1;
  /** On an unparsed line: what could not be read. */
  why?: string;
}

/** The tools whose path fields D2 names, and the access each means. */
const FILE_TOOL_FIELDS: Record<
  string,
  {access: PathAccess; field: string; optional: boolean}
> = {
  Edit: {access: 'write', field: 'file_path', optional: false},
  Glob: {access: 'search', field: 'path', optional: true},
  Grep: {access: 'search', field: 'path', optional: true},
  MultiEdit: {access: 'write', field: 'file_path', optional: false},
  NotebookEdit: {access: 'write', field: 'notebook_path', optional: false},
  Read: {access: 'read', field: 'file_path', optional: false},
  Write: {access: 'write', field: 'file_path', optional: false},
};

/** Keys whose values are file content or edit text: never logged (D4). */
const CONTENT_KEYS = /"(?:content|old_string|new_string|new_source|edits)"\s*:/;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function cut(value: string): {text: string; truncated: boolean} {
  return value.length > MAX_TEXT
    ? {text: value.slice(0, MAX_TEXT), truncated: true}
    : {text: value, truncated: false};
}

/**
 * The raw payload as an unparsed line may carry it: cut to MAX_TEXT, and null
 * when it looks like it holds file content or edit strings, which are never
 * logged, not even in a payload this hook could not read.
 */
function rawForLog(raw: string): {raw: string | null; raw_truncated: boolean} {
  if (CONTENT_KEYS.test(raw)) return {raw: null, raw_truncated: false};
  const {text: value, truncated} = cut(raw);
  return {raw: value, raw_truncated: truncated};
}

/** Every string value under `value` that is one whole path (D2, MCP rule). */
function wholePathStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > MAX_PATHS * 4) return;
  if (typeof value === 'string') {
    if (
      (value.startsWith('/') || value.startsWith('~/')) &&
      !/\s/.test(value)
    ) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) wholePathStrings(item, out, depth + 1);
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      wholePathStrings(item, out, depth + 1);
    }
  }
}

export interface AuditInput {
  env: Env;
  now: Date;
  raw: string;
}

export type AuditOutcome =
  | {kind: 'log'; line: AuditLine}
  | {kind: 'nothing'}
  | {kind: 'off'};

function unparsedLine(
  base: Partial<AuditLine>,
  raw: string,
  why: string,
  now: Date,
): AuditLine {
  return {
    agent_id: null,
    agent_type: null,
    command: null,
    command_truncated: false,
    confidence: null,
    cwd: null,
    paths: [],
    paths_truncated: false,
    permission_mode: null,
    session_id: null,
    tool: null,
    tool_use_id: null,
    unsandboxed: null,
    ...base,
    ...rawForLog(raw),
    reasons: ['unparsed'],
    ts: now.toISOString(),
    v: 1,
    why,
  };
}

/** The project root a hook belongs to: CLAUDE_PROJECT_DIR, else the cwd. */
function projectRootOf(env: Env, cwd: string | null): string | null {
  const dir = env.CLAUDE_PROJECT_DIR;
  return dir != null && dir !== '' ? dir : cwd;
}

/**
 * Decide what one PreToolUse payload logs. Pure apart from reading the file
 * system (realpath, the knob, the sandbox settings); `runFileAuditHook`
 * appends the line.
 */
export function auditToolCall(input: AuditInput): AuditOutcome {
  const {env, now, raw} = input;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (!fileAuditEnabled({env, projectRoot: projectRootOf(env, null)})) {
      return {kind: 'off'};
    }
    return {
      kind: 'log',
      line: unparsedLine({}, raw, 'the payload is not JSON', now),
    };
  }
  if (
    payload == null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    if (!fileAuditEnabled({env, projectRoot: projectRootOf(env, null)})) {
      return {kind: 'off'};
    }
    return {
      kind: 'log',
      line: unparsedLine({}, raw, 'the payload is not a JSON object', now),
    };
  }

  const fields = payload as Record<string, unknown>;
  const cwd = nonEmpty(fields.cwd);
  if (!fileAuditEnabled({env, projectRoot: projectRootOf(env, cwd)})) {
    return {kind: 'off'};
  }
  const tool = nonEmpty(fields.tool_name);
  const base = {
    agent_id: nonEmpty(fields.agent_id),
    agent_type: nonEmpty(fields.agent_type),
    cwd,
    permission_mode: nonEmpty(fields.permission_mode),
    session_id: nonEmpty(fields.session_id),
    tool,
    tool_use_id: nonEmpty(fields.tool_use_id),
  };
  const input_ = fields.tool_input;
  if (tool == null) {
    return {
      kind: 'log',
      line: unparsedLine(base, raw, 'the payload has no tool_name', now),
    };
  }
  if (input_ == null || typeof input_ !== 'object' || Array.isArray(input_)) {
    return {
      kind: 'log',
      line: unparsedLine(
        base,
        raw,
        'the payload has no tool_input object',
        now,
      ),
    };
  }
  const toolInput = input_ as Record<string, unknown>;
  const places = auditPlaces(env);
  const found: LoggedPath[] = [];
  const seen = new Set<string>();
  const add = (word: string, access: PathAccess, from: string | null): void => {
    const logged = classifyPath(word, access, from, places);
    if (logged == null) return;
    const key = `${logged.raw}\u0000${logged.resolved ?? ''}\u0000${access}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(logged);
  };

  let command: string | null = null;
  let unsandboxed: Unsandboxed | null = null;
  let confidence: AuditLine['confidence'] = 'tool-input';
  const fileTool = FILE_TOOL_FIELDS[tool];

  if (tool === 'Bash') {
    confidence = 'arguments-only';
    command = typeof toolInput.command === 'string' ? toolInput.command : null;
    if (command == null) {
      return {
        kind: 'log',
        line: unparsedLine(
          base,
          raw,
          'a Bash call with no command string',
          now,
        ),
      };
    }
    if (cwd != null) add(cwd, 'unknown', null);
    const words = bashPathWords(command);
    if (words == null) {
      const {text: shown, truncated} = cut(command);
      return {
        kind: 'log',
        line: {
          ...unparsedLine(base, '', 'the Bash command could not be read', now),
          command: shown,
          command_truncated: truncated,
          confidence,
          paths: found,
          raw: null,
          raw_truncated: false,
        },
      };
    }
    for (const word of words) add(word, 'unknown', cwd);
    unsandboxed = unsandboxedSource({
      command,
      flag: toolInput.dangerouslyDisableSandbox === true,
      settings: readSandboxSettings({
        env,
        projectRoot: projectRootOf(env, cwd),
      }),
    });
  } else if (fileTool != null) {
    const value = toolInput[fileTool.field];
    if (typeof value === 'string' && value !== '') {
      add(value, fileTool.access, cwd);
    } else if (value == null && fileTool.optional) {
      // Grep or Glob with no path searches the cwd (D2).
      if (cwd == null) {
        return {
          kind: 'log',
          line: unparsedLine(base, raw, `${tool} with no path and no cwd`, now),
        };
      }
      add(cwd, fileTool.access, null);
    } else {
      return {
        kind: 'log',
        line: unparsedLine(
          base,
          raw,
          `${tool} without a string ${fileTool.field}`,
          now,
        ),
      };
    }
    if (tool === 'Glob' && typeof toolInput.pattern === 'string') {
      const pattern = toolInput.pattern;
      if (pattern.startsWith('/') || pattern.startsWith('~')) {
        add(globPrefix(pattern), 'search', cwd);
      }
    }
  } else {
    confidence = 'arguments-only';
    const strings: string[] = [];
    wholePathStrings(toolInput, strings);
    for (const value of strings) add(value, 'unknown', cwd);
  }

  const reasons: AuditReason[] = [];
  if (found.length > 0) reasons.push('outside-path');
  if (unsandboxed != null) reasons.push('unsandboxed');
  if (reasons.length === 0) return {kind: 'nothing'};

  const shown = command == null ? null : cut(command);
  return {
    kind: 'log',
    line: {
      ...base,
      command: shown?.text ?? null,
      command_truncated: shown?.truncated ?? false,
      confidence,
      paths: found.slice(0, MAX_PATHS),
      paths_truncated: found.length > MAX_PATHS,
      reasons,
      ts: now.toISOString(),
      unsandboxed,
      v: 1,
    },
  };
}
