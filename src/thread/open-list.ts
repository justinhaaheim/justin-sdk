/**
 * `thread open --list` (home-base-yukaf.22 item 6): the recorded runs of
 * `thread open`, newest first, so `--undo --run <stamp>` has something to
 * point at. Justin, 2026-10-19: "Think of it like a dataview filter, and cmux
 * is the dataview, showing me the sessions. It'd be nice to be able to toggle
 * something on/off and have the additional windows appear/disappear." A
 * filtered run makes a window appear; `--undo --run <stamp>` makes it go.
 *
 * Read-only: it reads `<threads state dir>/opens/*.json` and nothing else (no
 * cmux, no ps). A record that cannot be read is listed as such, never
 * skipped (rule 7); a missing directory is "no run recorded", said with its
 * path.
 */

import type {OutputStyle} from '../cli-style';
import type {EnvLike} from './paths';

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {activityWords, opensDir} from './open';
import {tildeText} from './part-one';

const RECORD_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z\.json$/u;

const runSchema = z.looseObject({
  argv: z.array(z.string()).optional(),
  at: z.string().optional(),
  cutoffDays: z.number().optional(),
  filters: z
    .looseObject({
      includeOpen: z.boolean().optional(),
      limit: z.number().nullable().optional(),
      repos: z.array(z.string()).optional(),
      since: z.string().optional(),
      sinceWords: z.string().optional(),
    })
    .optional(),
  finishedAt: z.string().nullable().optional(),
  moved: z
    .array(z.looseObject({movedAt: z.string().nullable().optional()}))
    .optional(),
  previousUndos: z.array(z.unknown()).optional(),
  undo: z
    .looseObject({
      closed: z.array(z.unknown()).optional(),
      finishedAt: z.string().nullable().optional(),
      kept: z.array(z.unknown()).optional(),
      movedBack: z.array(z.unknown()).optional(),
      startedAt: z.string().optional(),
    })
    .nullable()
    .optional(),
  windows: z
    .array(
      z.looseObject({
        workspaces: z
          .array(z.looseObject({workspaceId: z.string().nullable()}))
          .optional(),
      }),
    )
    .optional(),
});

export interface RunSummary {
  argv: string[];
  at: string | null;
  /** The filters in words, one per line (older records: the window only). */
  filters: {label: string; value: string}[];
  finishedAt: string | null;
  moved: number;
  opened: number;
  path: string;
  /** Why the file could not be read; null when it was. */
  readFailure: string | null;
  stamp: string;
  /** The undo in words: not undone, undone at …, started and not finished. */
  undo: string;
  windows: number;
}

export type RunsRead =
  | {dir: string; kind: 'failed'; reason: string}
  | {dir: string; kind: 'none'}
  | {dir: string; kind: 'read'; runs: RunSummary[]};

function filterWords(
  parsed: z.infer<typeof runSchema>,
): {label: string; value: string}[] {
  const filters = parsed.filters;
  if (filters == null) {
    const days = parsed.cutoffDays;
    return [
      {
        label: 'Since',
        value:
          days == null
            ? 'not recorded'
            : `${days} day${days === 1 ? '' : 's'} (recorded before the other filters were)`,
      },
    ];
  }
  const repos = filters.repos ?? [];
  return [
    {
      label: 'Since',
      value: `${filters.since ?? '?'}${filters.sinceWords == null ? '' : ` (the last ${filters.sinceWords})`}`,
    },
    {
      label: 'Repo',
      value: repos.length === 0 ? 'every repo' : repos.join(', '),
    },
    {
      label: 'Limit',
      value: filters.limit == null ? 'none' : String(filters.limit),
    },
    {label: 'Include open', value: filters.includeOpen === true ? 'on' : 'off'},
  ];
}

function undoWords(parsed: z.infer<typeof runSchema>, now: Date): string {
  const undo = parsed.undo;
  const earlier = parsed.previousUndos?.length ?? 0;
  const before =
    earlier === 0
      ? ''
      : ` (after ${earlier} earlier undo${earlier === 1 ? '' : 's'})`;
  if (undo == null) return 'no: its windows are still recorded as open';
  if (undo.finishedAt == null) {
    return `started ${activityWords(undo.startedAt ?? null, now)} and not finished${before}`;
  }
  const closed = undo.closed?.length ?? 0;
  const kept = undo.kept?.length ?? 0;
  const back = undo.movedBack?.length ?? 0;
  return `yes, ${activityWords(undo.finishedAt, now)}: closed ${closed}, kept ${kept}${back > 0 ? `, moved back ${back}` : ''}${before}`;
}

/** Every recorded run, newest first. */
export function readRuns(env: EnvLike, now: Date): RunsRead {
  const dir = opensDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT')
      return {dir, kind: 'none'};
    return {dir, kind: 'failed', reason: String(error)};
  }
  const files = names
    .filter((name) => RECORD_FILE.test(name))
    .sort()
    .reverse();
  if (files.length === 0) return {dir, kind: 'none'};
  const runs = files.map((name): RunSummary => {
    const path = join(dir, name);
    const stamp = name.replace(/\.json$/u, '');
    const empty: RunSummary = {
      argv: [],
      at: null,
      filters: [],
      finishedAt: null,
      moved: 0,
      opened: 0,
      path,
      readFailure: null,
      stamp,
      undo: 'unknown',
      windows: 0,
    };
    let parsed: z.infer<typeof runSchema>;
    try {
      const result = runSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8')) as unknown,
      );
      if (!result.success) {
        return {
          ...empty,
          readFailure: `not a thread open record: ${result.error.issues[0]?.message ?? 'invalid'}`,
        };
      }
      parsed = result.data;
    } catch (error) {
      return {...empty, readFailure: String(error)};
    }
    const windows = parsed.windows ?? [];
    return {
      argv: parsed.argv ?? [],
      at: parsed.at ?? null,
      filters: filterWords(parsed),
      finishedAt: parsed.finishedAt ?? null,
      moved: (parsed.moved ?? []).filter((entry) => entry.movedAt != null)
        .length,
      opened: windows.reduce(
        (sum, window) =>
          sum +
          (window.workspaces ?? []).filter((entry) => entry.workspaceId != null)
            .length,
        0,
      ),
      path,
      readFailure: null,
      stamp,
      undo: undoWords(parsed, now),
      windows: windows.length,
    };
  });
  return {dir, kind: 'read', runs};
}

const LABELS = [
  'When',
  'Typed',
  'Since',
  'Repo',
  'Limit',
  'Include open',
  'Opened',
  'Moved in',
  'Undone',
  'Undo it',
].map((label) => ({label, value: ''}));

export function renderRuns(
  read: RunsRead,
  now: Date,
  style: OutputStyle,
): string {
  const prose = (text: string): string =>
    wrapHanging(text, {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width: style.width,
    });
  const count = read.kind === 'read' ? read.runs.length : 0;
  const blocks = [
    sectionHeader(`thread open runs (${count})`, {
      color: style.color,
      emoji: '🗂️',
    }),
    prose(
      'Each run of thread open is a filtered view of your sessions: a run makes its window appear, and thread open --undo --run <stamp> makes it disappear again (keeping any workspace with unsent text, Claude working, or use since the run). Newest first.',
    ),
  ];
  if (read.kind === 'none') {
    blocks.push(
      prose(
        `No run of thread open is recorded (${tildeText(read.dir)} holds no record).`,
      ),
    );
    return spacedList(blocks);
  }
  if (read.kind === 'failed') {
    blocks.push(
      prose(
        `⚠️ ${tildeText(read.dir)} could not be read, so the runs are unknown: ${read.reason}`,
      ),
    );
    return spacedList(blocks);
  }
  const labelWidth = fieldLabelWidth(LABELS);
  blocks.push(
    spacedList(
      read.runs.map((run) => {
        const title = wrapHanging(paint(run.stamp, ['bold'], style.color), {
          hang: BODY_COLUMN + 4,
          indent: BODY_COLUMN,
          width: style.width,
        });
        const fields =
          run.readFailure == null
            ? [
                {label: 'When', value: activityWords(run.at, now)},
                {
                  label: 'Typed',
                  value: `thread open ${run.argv.join(' ')}`.trimEnd(),
                },
                ...run.filters,
                {
                  label: 'Opened',
                  value: `${run.opened} workspace${run.opened === 1 ? '' : 's'} in ${run.windows} window${run.windows === 1 ? '' : 's'}${run.finishedAt == null ? ' (the run did not finish)' : ''}`,
                },
                {label: 'Moved in', value: String(run.moved)},
                {label: 'Undone', value: run.undo},
                {
                  label: 'Undo it',
                  value: `bun run justin-sdk thread open --undo --run ${run.stamp}`,
                },
              ]
            : [
                {label: 'Record', value: tildeText(run.path)},
                {
                  label: 'Why',
                  value: `⚠️ could not be read: ${run.readFailure}`,
                },
              ];
        return [
          title,
          fieldLines(fields, {
            color: style.color,
            indent: stepColumn(1),
            labelWidth,
            width: style.width,
          }),
        ].join('\n');
      }),
    ),
  );
  return spacedList(blocks);
}

/** Exit 0 listed (or none recorded) · 1 the directory could not be read. */
export async function runThreadOpenList(options: {
  env?: EnvLike;
  json: boolean;
  now?: Date;
  style?: OutputStyle;
}): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const read = readRuns(env, now);
  const output = options.json
    ? JSON.stringify(read, null, 2)
    : renderRuns(read, now, options.style ?? outputStyle(process.stdout));
  await writeStdout(`${output}\n`);
  return read.kind === 'failed' ? 1 : 0;
}
