/**
 * `worktree-retire plan` (home-base-rub4v.1.1): READ-ONLY. For each named
 * linked worktree, or with --candidates every linked worktree of the repo, it
 * records the evidence and a verdict with each reason, writes the plan as JSON
 * under $XDG_STATE_HOME/worktree-retire/plans/<repo>-<stamp>.json, and prints
 * it. The plan file is the ONLY thing it writes.
 */

import type {OutputStyle} from '../cli-style';
import type {CommandIo} from '../worktree-salvage/save';
import type {ProcessReader} from './processes';

import {mkdirSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {join, resolve} from 'path';
import {z} from 'zod';

import {
  fieldLines,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
} from '../cli-style';
import {formatLocalTimestamp} from '../date';
import {getSdkVersion} from '../sdk-identity';
import {formatBytes, formatCount} from '../worktree-salvage/save';
import {
  EvidenceSchema,
  gatherEvidence,
  readRepoContext,
  type WorktreeEvidence,
} from './evidence';
import {readLsof} from './processes';

export const PLAN_SCHEMA_VERSION = 1;

export const PlanSchema = z.object({
  createdAt: z.string(),
  defaultBranch: z.string(),
  /** `checked: N processes`, or why the process check failed. */
  processCheck: z.string(),
  repoName: z.string(),
  repoRoot: z.string(),
  schema: z.literal(PLAN_SCHEMA_VERSION),
  sdkVersion: z.string().nullable(),
  worktrees: z.array(EvidenceSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

type Env = CommandIo['env'];

function homeOf(env: Env): string {
  const fromEnv = env.HOME;
  return fromEnv != null && fromEnv !== '' ? fromEnv : homedir();
}

function xdg(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value != null && value !== '' ? value : join(homeOf(env), fallback);
}

/** `$XDG_STATE_HOME/worktree-retire` (default `~/.local/state/…`). */
export function stateDir(env: Env): string {
  return join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'worktree-retire');
}

/** `$XDG_DATA_HOME/beads-backups` (default `~/.local/share/…`), beside beads-backup's. */
export function beadsBackupsDir(env: Env): string {
  return join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'beads-backups');
}

export function homeFor(env: Env): string {
  return homeOf(env);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write the plan with `wx` (never over another plan). Returns its path. */
export function writePlanFile(plan: Plan, env: Env, now: Date): string {
  const dir = join(stateDir(env), 'plans');
  mkdirSync(dir, {recursive: true});
  const stem = `${plan.repoName}-${formatLocalTimestamp(now)}`;
  for (let attempt = 1; ; attempt += 1) {
    const file = join(
      dir,
      attempt === 1 ? `${stem}.json` : `${stem}-${attempt}.json`,
    );
    try {
      writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, {flag: 'wx'});
      return file;
    } catch (error) {
      const code = (error as {code?: unknown}).code;
      if (code !== 'EEXIST' || attempt >= 100) throw error;
    }
  }
}

function beadsSummary(evidence: WorktreeEvidence): string {
  if (evidence.beads == null) return 'not read';
  if (!evidence.beads.ok) return `UNKNOWN: ${evidence.beads.error}`;
  const files = evidence.beads.value;
  if (files.length === 0) return 'none';
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const db = files.filter((file) => file.sha256 != null).length;
  return `${formatCount(files.length, 'file')}, ${formatBytes(bytes)}, copied before removal (${formatCount(db, 'DB file')} with sha256)`;
}

function transcriptsSummary(evidence: WorktreeEvidence): string {
  const files = evidence.transcripts.files;
  const count = files.ok
    ? formatCount(files.value, 'file')
    : `UNKNOWN: ${files.error}`;
  return `${evidence.transcripts.dir}\n(${count}, left in place)`;
}

function recordFields(evidence: WorktreeEvidence) {
  const fields = [
    {label: 'path', value: evidence.path},
    {
      label: 'branch',
      value: `${evidence.branch ?? '(detached)'} at ${evidence.head?.slice(0, 8) ?? '?'}`,
    },
  ];
  if (evidence.verdict === 'ineligible') {
    fields.push({label: 'why', value: evidence.reasons.join('\n')});
    return fields;
  }
  fields.push({label: 'beads', value: beadsSummary(evidence)});
  if (evidence.submodules?.ok === true) {
    for (const state of evidence.submodules.value) {
      if (!state.initialized) continue;
      fields.push({
        label: 'submodule',
        value: `${state.path}: ${state.detail}\n(git refuses to remove a worktree holding one; --force is used for this case only)`,
      });
    }
  }
  fields.push({label: 'transcripts', value: transcriptsSummary(evidence)});
  return fields;
}

function renderRecord(evidence: WorktreeEvidence, style: OutputStyle): string {
  const title = `${' '.repeat(stepColumn(0))}${paint(evidence.name, ['bold'], style.color)}`;
  return `${title}\n${fieldLines(recordFields(evidence), {
    color: style.color,
    indent: stepColumn(1),
    labelWidth: 14,
    width: style.width,
  })}`;
}

/** The plan, man-page style: what it covers, then the eligible, then the rest. */
export function renderPlan(
  plan: Plan,
  planFile: string | null,
  style: OutputStyle,
  options: {eligibleOnly?: boolean} = {},
): string {
  const eligible = plan.worktrees.filter((w) => w.verdict === 'eligible');
  const ineligible = plan.worktrees.filter((w) => w.verdict !== 'eligible');
  const overview = [
    {label: 'repo', value: plan.repoRoot},
    {label: 'main', value: plan.defaultBranch},
    {label: 'made', value: plan.createdAt},
    {label: 'processes', value: plan.processCheck},
  ];
  if (planFile != null) overview.push({label: 'plan file', value: planFile});
  const blocks = [
    sectionHeader('Worktree retire plan', {color: style.color, emoji: '🧹'}),
    fieldLines(overview, {
      color: style.color,
      indent: stepColumn(0),
      width: style.width,
    }),
    sectionHeader(`Eligible to retire: ${eligible.length}`, {
      color: style.color,
      emoji: '✅',
    }),
    ...(eligible.length === 0
      ? [`${' '.repeat(stepColumn(0))}none`]
      : eligible.map((w) => renderRecord(w, style))),
  ];
  if (options.eligibleOnly !== true) {
    blocks.push(
      sectionHeader(`Not eligible: ${ineligible.length}`, {
        color: style.color,
        emoji: '⛔',
      }),
      ...(ineligible.length === 0
        ? [`${' '.repeat(stepColumn(0))}none`]
        : ineligible.map((w) => renderRecord(w, style))),
    );
  }
  return spacedList(blocks);
}

export interface PlanSeams {
  now?: Date;
  readProcesses?: ProcessReader;
}

export interface PlanCommandArgs {
  candidates: boolean;
  paths: string[];
  /** `--repo`; null means the repo the cwd is in. */
  repo: string | null;
  seams?: PlanSeams;
}

/** Build the plan in memory. Exported for tests and for `run`'s fresh read. */
export function buildPlan(
  args: PlanCommandArgs,
  io: Pick<CommandIo, 'cwd' | 'env'>,
): {error: string; ok: false} | {ok: true; value: Plan} {
  const readProcesses = args.seams?.readProcesses ?? (() => readLsof());
  const processes = readProcesses();
  const context = readRepoContext(resolve(io.cwd, args.repo ?? '.'), {
    home: homeOf(io.env),
    processes,
  });
  if (!context.ok) return context;
  const targets: string[] = [];
  if (args.candidates) {
    targets.push(...context.value.worktrees.slice(1).map((w) => w.path));
  }
  for (const path of args.paths) targets.push(resolve(io.cwd, path));
  const seen = new Set<string>();
  const worktrees: WorktreeEvidence[] = [];
  for (const target of targets) {
    const evidence = gatherEvidence(context.value, target);
    if (seen.has(evidence.path)) continue;
    seen.add(evidence.path);
    worktrees.push(evidence);
  }
  const uniquePids = processes.ok
    ? new Set(processes.value.map((handle) => handle.pid)).size
    : 0;
  return {
    ok: true,
    value: {
      createdAt: (args.seams?.now ?? new Date()).toISOString(),
      defaultBranch: context.value.defaultBranch,
      processCheck: processes.ok
        ? `checked: ${formatCount(uniquePids, 'process', 'processes')} (lsof)`
        : `NOT CHECKED, so nothing is eligible: ${processes.error}`,
      repoName: context.value.repoName,
      repoRoot: context.value.repoRoot,
      schema: PLAN_SCHEMA_VERSION,
      sdkVersion: getSdkVersion(),
      worktrees,
    },
  };
}

/** `worktree-retire plan`. Exit 0 with the plan written; 1 when it could not be made; 2 on usage. */
export async function runPlanCommand(
  args: PlanCommandArgs,
  io: CommandIo,
): Promise<number> {
  if (!args.candidates && args.paths.length === 0) {
    await io.stderr(
      'worktree-retire plan: name one or more worktrees, or pass --candidates for every linked worktree of the repo\n',
    );
    return 2;
  }
  const plan = buildPlan(args, io);
  if (!plan.ok) {
    await io.stderr(
      `worktree-retire plan: no plan was written, because the repo could not be read: ${plan.error}\n`,
    );
    return 1;
  }
  let file: string;
  try {
    file = writePlanFile(plan.value, io.env, args.seams?.now ?? new Date());
  } catch (error) {
    await io.stderr(
      `worktree-retire plan: the plan could not be written: ${messageOf(error)}\n`,
    );
    return 1;
  }
  await io.stdout(`${renderPlan(plan.value, file, io.stdoutStyle)}\n`);
  return 0;
}
