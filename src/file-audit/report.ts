/**
 * `justin-sdk file-audit report` — a readable summary of the file-access audit
 * log (home-base-n1qy7.15.1, description item 4), grouped by top-level folder,
 * in the repo's terminal output style (cli-style.ts).
 *
 * Temp files and ~/.claude are hidden unless `--all`: the log keeps them (D1),
 * the report counts them and says how to see them. A line the report cannot
 * read is counted and named, never skipped silently, and a log that cannot be
 * read is an error, never "nothing logged" (critical rule 7).
 */

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';

import {
  BODY_COLUMN,
  fieldLines,
  type OutputStyle,
  outputStyle,
  pad,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {type AuditLine, auditLogPath, type LoggedPath} from './audit';

type Env = Record<string, string | undefined>;

/** `7d`, `12h`, `30m`, `2w`: a window in milliseconds, or null when not one. */
export function parseSinceWindow(value: string): number | null {
  const match = /^(\d+)([mhdw])$/.exec(value.trim());
  if (match == null) return null;
  const count = Number(match[1]);
  const unit = {d: 86_400_000, h: 3_600_000, m: 60_000, w: 604_800_000}[
    match[2] as 'd' | 'h' | 'm' | 'w'
  ];
  return count > 0 ? count * unit : null;
}

/** The folder a path is grouped under: `~/<first>`, or `/<first>[/<second>]`. */
export function topFolder(path: string, home: string): string {
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1).split('/')[0] ?? ''}`;
  }
  const parts = path.split('/').filter((part) => part !== '');
  const first = parts[0];
  if (first == null) return '/';
  if (['private', 'Users', 'Volumes'].includes(first) && parts[1] != null) {
    return `/${first}/${parts[1]}`;
  }
  return `/${first}`;
}

function tilde(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`)
    ? `~/${path.slice(home.length + 1)}`
    : path;
}

function shownPath(path: LoggedPath): string {
  return path.resolved ?? path.raw;
}

function hidden(path: LoggedPath, all: boolean): boolean {
  return !all && path.category !== 'other';
}

function localTime(iso: string): string {
  const date = new Date(iso);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

interface FolderGroup {
  access: Map<string, number>;
  calls: number;
  last: string;
  paths: Set<string>;
}

interface UnsandboxedGroup {
  calls: number;
  example: string | null;
  last: string;
}

export interface ReportSummary {
  folders: Map<string, FolderGroup>;
  hiddenCalls: number;
  logged: number;
  unparsed: {calls: number; lastWhy: string | null};
  unreadableLines: number;
  unsandboxed: Map<string, UnsandboxedGroup>;
}

function isAuditLine(value: unknown): value is AuditLine {
  if (value == null || typeof value !== 'object') return false;
  const line = value as Partial<AuditLine>;
  return (
    line.v === 1 &&
    typeof line.ts === 'string' &&
    !Number.isNaN(Date.parse(line.ts)) &&
    Array.isArray(line.reasons) &&
    Array.isArray(line.paths)
  );
}

/** Read the log's text into a summary. Pure. */
export function summarizeAuditLog(args: {
  all: boolean;
  home: string;
  now: Date;
  sinceMs: number | null;
  text: string;
}): ReportSummary {
  const summary: ReportSummary = {
    folders: new Map(),
    hiddenCalls: 0,
    logged: 0,
    unparsed: {calls: 0, lastWhy: null},
    unreadableLines: 0,
    unsandboxed: new Map(),
  };
  const cutoff =
    args.sinceMs == null ? null : args.now.getTime() - args.sinceMs;
  for (const rawLine of args.text.split('\n')) {
    if (rawLine.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      summary.unreadableLines += 1;
      continue;
    }
    if (!isAuditLine(parsed)) {
      summary.unreadableLines += 1;
      continue;
    }
    const line = parsed;
    if (cutoff != null && Date.parse(line.ts) < cutoff) continue;
    summary.logged += 1;

    const visible = line.paths.filter((path) => !hidden(path, args.all));
    const unsandboxed = line.unsandboxed;
    const unparsed = line.reasons.includes('unparsed');
    if (visible.length === 0 && unsandboxed == null && !unparsed) {
      summary.hiddenCalls += 1;
      continue;
    }

    const touched = new Set<string>();
    for (const path of visible) {
      const folder = topFolder(shownPath(path), args.home);
      const group = summary.folders.get(folder) ?? {
        access: new Map<string, number>(),
        calls: 0,
        last: line.ts,
        paths: new Set<string>(),
      };
      if (!touched.has(folder)) {
        group.calls += 1;
        touched.add(folder);
      }
      group.access.set(path.access, (group.access.get(path.access) ?? 0) + 1);
      group.paths.add(tilde(shownPath(path), args.home));
      if (line.ts > group.last) group.last = line.ts;
      summary.folders.set(folder, group);
    }

    if (unsandboxed != null) {
      const key =
        unsandboxed.source === 'excludedCommands'
          ? `excludedCommands (${unsandboxed.pattern ?? '?'}${unsandboxed.position === 'later' ? ', a later command' : ''})`
          : unsandboxed.source;
      const group = summary.unsandboxed.get(key) ?? {
        calls: 0,
        example: null,
        last: line.ts,
      };
      group.calls += 1;
      if (line.ts >= group.last) {
        group.last = line.ts;
        group.example = line.command ?? group.example;
      }
      summary.unsandboxed.set(key, group);
    }

    if (unparsed) {
      summary.unparsed.calls += 1;
      summary.unparsed.lastWhy = line.why ?? summary.unparsed.lastWhy;
    }
  }
  return summary;
}

const SHOWN_PATHS = 5;
const EXAMPLE_CHARS = 160;

/** The report text for a summary. Pure, so tests render it with PLAIN_STYLE. */
export function renderAuditReport(args: {
  all: boolean;
  logPath: string;
  since: string;
  style: OutputStyle;
  summary: ReportSummary;
}): string {
  const {style, summary} = args;
  const {color, width} = style;
  const fieldOptions = (indent: number) => ({color, indent, width});

  const overview = fieldLines(
    [
      {label: 'log', value: args.logPath},
      {
        label: 'window',
        value:
          args.since === 'all'
            ? 'everything in the log'
            : `the last ${args.since}`,
      },
      {label: 'calls logged', value: String(summary.logged)},
      {
        label: 'hidden',
        value: args.all
          ? 'nothing (--all)'
          : `${summary.hiddenCalls} call(s) that touched only temp files or ~/.claude; show them with ${paint('--all', ['cyan'], color)}`,
      },
      {
        label: 'unreadable lines',
        value:
          summary.unreadableLines === 0
            ? '0'
            : paint(
                `${summary.unreadableLines} line(s) of the log could not be read`,
                ['yellow'],
                color,
              ),
      },
    ],
    fieldOptions(BODY_COLUMN),
  );

  const folders = [...summary.folders.entries()].sort((a, b) =>
    b[1].calls !== a[1].calls
      ? b[1].calls - a[1].calls
      : a[0].localeCompare(b[0]),
  );
  const folderBlocks = folders.map(([folder, group]) => {
    const paths = [...group.paths].sort();
    const listed = paths.slice(0, SHOWN_PATHS);
    if (paths.length > SHOWN_PATHS) {
      listed.push(`(and ${paths.length - SHOWN_PATHS} more)`);
    }
    return [
      `${pad(BODY_COLUMN)}${paint(folder, ['bold'], color)}`,
      fieldLines(
        [
          {label: 'calls', value: String(group.calls)},
          {
            label: 'access',
            value: [...group.access.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => `${kind} ${count}`)
              .join(', '),
          },
          {label: 'last', value: localTime(group.last)},
          {label: 'paths', value: listed.join('\n')},
        ],
        fieldOptions(stepColumn(1)),
      ),
    ].join('\n');
  });

  const unsandboxedBlocks = [...summary.unsandboxed.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([source, group]) => {
      const example =
        group.example == null
          ? '(none recorded)'
          : group.example.length > EXAMPLE_CHARS
            ? `${group.example.slice(0, EXAMPLE_CHARS)}…`
            : group.example;
      return [
        `${pad(BODY_COLUMN)}${paint(source, ['bold'], color)}`,
        fieldLines(
          [
            {label: 'calls', value: String(group.calls)},
            {label: 'last', value: localTime(group.last)},
            {label: 'latest', value: example.replace(/\n/g, ' ⏎ ')},
          ],
          fieldOptions(stepColumn(1)),
        ),
      ].join('\n');
    });

  const sections = [
    sectionHeader('File access outside ~/Dev', {color, emoji: '🔎'}),
    overview,
    sectionHeader('By folder', {color, emoji: '📁'}),
    folderBlocks.length === 0
      ? `${pad(BODY_COLUMN)}none in this window`
      : spacedList(folderBlocks),
    sectionHeader('Bash outside the sandbox', {color, emoji: '🔓'}),
    unsandboxedBlocks.length === 0
      ? `${pad(BODY_COLUMN)}none in this window`
      : spacedList(unsandboxedBlocks),
  ];
  if (summary.unparsed.calls > 0) {
    sections.push(
      sectionHeader('Calls the hook could not read', {color, emoji: '❓'}),
      fieldLines(
        [
          {label: 'calls', value: String(summary.unparsed.calls)},
          {
            label: 'latest why',
            value: summary.unparsed.lastWhy ?? '(none recorded)',
          },
        ],
        fieldOptions(BODY_COLUMN),
      ),
    );
  }
  return `${spacedList(sections)}\n`;
}

/** The CLI: read the log, print the report. Returns the exit code. */
export async function runFileAuditReport(args: {
  all: boolean;
  env?: Env;
  now?: Date;
  since: string;
}): Promise<number> {
  const env = args.env ?? process.env;
  const logPath = auditLogPath(env);
  const sinceMs = args.since === 'all' ? null : parseSinceWindow(args.since);
  if (args.since !== 'all' && sinceMs == null) {
    process.stderr.write(
      `justin-sdk file-audit report: --since takes a window such as 30m, 12h, 7d or 2w, or "all", not "${args.since}"\n`,
    );
    return 1;
  }
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? (error as {code: unknown}).code
        : null;
    if (code === 'ENOENT') {
      await writeStdout(
        `${pad(BODY_COLUMN)}No audit log yet at ${logPath}: the hook has logged nothing on this Mac.\n`,
      );
      return 0;
    }
    process.stderr.write(
      `justin-sdk file-audit report: could not read ${logPath} (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return 1;
  }
  const home = env.HOME != null && env.HOME !== '' ? env.HOME : homedir();
  const summary = summarizeAuditLog({
    all: args.all,
    home,
    now: args.now ?? new Date(),
    sinceMs,
    text,
  });
  await writeStdout(
    renderAuditReport({
      all: args.all,
      logPath,
      since: args.since,
      style: outputStyle(process.stdout, env),
      summary,
    }),
  );
  return 0;
}
