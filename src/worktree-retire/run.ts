/**
 * `worktree-retire run <plan file>` (home-base-rub4v.1.1). JUSTIN RUNS THIS;
 * Claude never does (project-forensics act.md: removing a worktree is his).
 *
 * It refuses without a TTY, prints the plan, and asks him to type the number
 * of worktrees it will remove. Then, for each eligible worktree, in the
 * design's order:
 *   1. read items 1-8 again; any difference from the plan skips it, loudly;
 *   2. copy every ignored file under `.beads/` to
 *      $XDG_DATA_HOME/beads-backups/<repo>/<stamp>-retire/<worktree>/ and
 *      verify each copy by sha256 (the copy's, and the source's again, so a
 *      source written during the copy fails too); a failure keeps the worktree;
 *   3. print where its Claude transcripts are, and leave them there;
 *   4. `git worktree remove <path>` WITHOUT --force. The only --force: git
 *      refused because the worktree holds submodules, and step 1 just verified
 *      every initialized one clean, on a remote branch, with no local-only
 *      commits and no stash, and git status is read clean again right before.
 *      A removal that fails part-way is reported with `git status` of what is
 *      left (JOURNAL 2026-10-29: a sandboxed removal deleted 37 tracked files
 *      before failing on the write-protected .claude/settings.json);
 *   5. append one JSON line per step to $XDG_STATE_HOME/worktree-retire/log.jsonl.
 * The branch is never touched; `git worktree remove` keeps it.
 */

import type {OutputStyle} from '../cli-style';
import type {Measured} from '../worktree-salvage/status';
import type {WorktreeEvidence} from './evidence';
import type {ProcessReader} from './processes';

import {execFileSync} from 'child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from 'fs';
import {dirname, join} from 'path';
import {createInterface} from 'readline/promises';

import {paint, sectionHeader, spacedList, stepColumn} from '../cli-style';
import {formatLocalTimestamp} from '../date';
import {
  type CommandIo,
  copyRegular,
  formatBytes,
  formatCount,
  processIo,
  sha256OfFile,
} from '../worktree-salvage/save';
import {runGit} from '../worktree-salvage/status';
import {gatherEvidence, readRepoContext, recheckDifferences} from './evidence';
import {
  beadsBackupsDir,
  homeFor,
  type Plan,
  PlanSchema,
  renderPlan,
  stateDir,
} from './plan';
import {readLsof} from './processes';

/** What `run` needs beyond CommandIo: is there a terminal, and how to ask. */
export interface RetireIo extends CommandIo {
  isTty: boolean;
  /** Ask one question; null when the input ended without an answer. */
  prompt: (question: string) => Promise<string | null>;
}

export function processRetireIo(): RetireIo {
  return {
    ...processIo(),
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: async (question) => {
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await reader.question(question);
      } catch {
        return null;
      } finally {
        reader.close();
      }
    },
  };
}

/** Test seams. Production passes none. */
export interface RunSeams {
  /** Copies one file and returns the bytes and sha256 it read. Default: worktree-salvage's copyRegular. */
  copyFile?: (
    source: string,
    dest: string,
    mode: number,
  ) => {bytes: number; sha256: string};
  /** Free bytes at a directory, or null when unknown. Default: statfs. */
  freeBytes?: (dir: string) => number | null;
  now?: Date;
  readProcesses?: ProcessReader;
}

export interface RunCommandArgs {
  planFile: string;
  seams?: RunSeams;
}

type Outcome =
  | {kind: 'failed'; name: string; reason: string}
  | {forced: boolean; kind: 'removed'; name: string}
  | {kind: 'skipped'; name: string; reason: string};

const FREE_SPACE_MARGIN = 16 * 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultFreeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Read and validate a plan file. */
export function readPlanFile(path: string): Measured<Plan> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return {error: `cannot read ${path}: ${messageOf(error)}`, ok: false};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {error: `${path} is not JSON: ${messageOf(error)}`, ok: false};
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    return {
      error: `${path} is not a worktree-retire plan: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      ok: false,
    };
  }
  return {ok: true, value: parsed.data};
}

/**
 * Step 2: copy every beads file of `evidence` under `destDir`, verified.
 * Returns the copy's manifest path, or why it failed. Never writes into a
 * directory that already exists.
 */
export function copyBeads(
  evidence: WorktreeEvidence,
  destDir: string,
  seams: RunSeams = {},
): Measured<{bytes: number; files: number; manifest: string | null}> {
  if (evidence.beads?.ok !== true) {
    return {error: 'the beads files were not listed', ok: false};
  }
  const files = evidence.beads.value;
  if (files.length === 0) {
    return {ok: true, value: {bytes: 0, files: 0, manifest: null}};
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  try {
    mkdirSync(dirname(destDir), {recursive: true});
    mkdirSync(destDir);
  } catch (error) {
    return {
      error: `cannot create ${destDir}: ${messageOf(error)}`,
      ok: false,
    };
  }
  const free = (seams.freeBytes ?? defaultFreeBytes)(destDir);
  if (free == null) {
    return {
      error: `the free space at ${destDir} could not be measured`,
      ok: false,
    };
  }
  if (free < total + FREE_SPACE_MARGIN) {
    return {
      error: `${formatBytes(total)} to copy, but only ${formatBytes(free)} free at ${destDir}`,
      ok: false,
    };
  }
  const copy = seams.copyFile ?? copyRegular;
  const copied: {bytes: number; path: string; sha256: string}[] = [];
  for (const file of files) {
    const source = join(evidence.path, file.path);
    const dest = join(destDir, file.path);
    try {
      mkdirSync(dirname(dest), {recursive: true});
      const read = copy(source, dest, lstatSync(source).mode);
      const destHash = sha256OfFile(dest);
      const sourceHash = sha256OfFile(source);
      if (destHash !== read.sha256) {
        return {
          error: `the copy of ${file.path} does not match what was read (sha256 ${destHash.slice(0, 12)} against ${read.sha256.slice(0, 12)})`,
          ok: false,
        };
      }
      if (sourceHash !== read.sha256) {
        return {
          error: `${file.path} changed while it was being copied`,
          ok: false,
        };
      }
      copied.push({bytes: read.bytes, path: file.path, sha256: read.sha256});
    } catch (error) {
      return {
        error: `copying ${file.path} failed: ${messageOf(error)}`,
        ok: false,
      };
    }
  }
  const manifest = join(destDir, 'manifest.json');
  try {
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          branch: evidence.branch,
          files: copied,
          head: evidence.head,
          worktree: evidence.path,
        },
        null,
        2,
      )}\n`,
      {flag: 'wx'},
    );
  } catch (error) {
    return {
      error: `writing ${manifest} failed: ${messageOf(error)}`,
      ok: false,
    };
  }
  return {
    ok: true,
    value: {bytes: total, files: copied.length, manifest},
  };
}

function git(
  cwd: string,
  args: readonly string[],
): {ok: false; stderr: string} | {ok: true} {
  try {
    execFileSync('git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true};
  } catch (error) {
    const stderr =
      error != null && typeof error === 'object' && 'stderr' in error
        ? String((error as {stderr: unknown}).stderr).trim()
        : messageOf(error);
    return {ok: false, stderr};
  }
}

/** What is left of a worktree whose removal failed part-way. */
function leftover(path: string): string {
  if (!existsSync(path)) return 'the directory is gone';
  const status = runGit(path, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status.ok) {
    const rows = status.value.split('\n').filter((line) => line !== '');
    return rows.length === 0
      ? 'the directory is still there; git status shows nothing changed'
      : `the directory is still there; git status shows ${formatCount(rows.length, 'path')}:\n${rows.slice(0, 20).join('\n')}${rows.length > 20 ? `\n… and ${rows.length - 20} more` : ''}`;
  }
  try {
    const names = readdirSync(path);
    return `the directory is still there and git cannot read it (${status.error}); it holds: ${names.slice(0, 20).join(', ')}`;
  } catch (error) {
    return `the directory is still there and cannot be read: ${messageOf(error)}`;
  }
}

function branchExists(repoRoot: string, branch: string | null): boolean {
  if (branch == null) return false;
  return runGit(repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).ok;
}

/** Step 4. */
export function removeWorktree(
  repoRoot: string,
  evidence: WorktreeEvidence,
): {forced: boolean; ok: true} | {ok: false; reason: string} {
  const plain = git(repoRoot, ['worktree', 'remove', evidence.path]);
  let forced = false;
  if (!plain.ok) {
    const submodules =
      evidence.submodules?.ok === true
        ? evidence.submodules.value.filter((state) => state.initialized)
        : null;
    const forceAllowed =
      plain.stderr.includes('containing submodules') &&
      submodules != null &&
      submodules.length > 0 &&
      submodules.every((state) => state.verified);
    if (!forceAllowed) {
      return {
        ok: false,
        reason: `git worktree remove failed: ${plain.stderr}\n${leftover(evidence.path)}`,
      };
    }
    const status = runGit(evidence.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (!status.ok || status.value.trim() !== '') {
      return {
        ok: false,
        reason: `git refused because of its submodules, and --force was NOT used: git status is ${status.ok ? 'no longer clean' : `unreadable (${status.error})`}`,
      };
    }
    const force = git(repoRoot, [
      'worktree',
      'remove',
      '--force',
      evidence.path,
    ]);
    if (!force.ok) {
      return {
        ok: false,
        reason: `git worktree remove --force (verified submodules only) failed: ${force.stderr}\n${leftover(evidence.path)}`,
      };
    }
    forced = true;
  }
  if (existsSync(evidence.path)) {
    return {
      ok: false,
      reason: `git reported success, but ${leftover(evidence.path)}`,
    };
  }
  if (!branchExists(repoRoot, evidence.branch)) {
    return {
      ok: false,
      reason: `the worktree is removed, but its branch ${evidence.branch ?? '(none)'} cannot be found`,
    };
  }
  return {forced, ok: true};
}

function indentBlock(text: string, columns: number): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${' '.repeat(columns)}${line}`))
    .join('\n');
}

function renderOutcomes(outcomes: readonly Outcome[], style: OutputStyle) {
  const removed = outcomes.filter((o) => o.kind === 'removed');
  const notRemoved = outcomes.filter(
    (o): o is Exclude<Outcome, {kind: 'removed'}> => o.kind !== 'removed',
  );
  const blocks = [
    sectionHeader(`Removed: ${removed.length}`, {
      color: style.color,
      emoji: '✅',
    }),
    removed.length === 0
      ? indentBlock('none', stepColumn(0))
      : removed
          .map((o) =>
            indentBlock(
              `${o.name}${o.kind === 'removed' && o.forced ? ' (--force: verified submodules only)' : ''}`,
              stepColumn(0),
            ),
          )
          .join('\n'),
  ];
  if (notRemoved.length > 0) {
    blocks.push(
      sectionHeader(`Not removed: ${notRemoved.length}`, {
        color: style.color,
        emoji: '⛔',
      }),
      ...notRemoved.map((o) =>
        [
          indentBlock(
            `${paint(o.name, ['bold'], style.color)}: ${o.kind === 'skipped' ? 'skipped' : 'FAILED'}`,
            stepColumn(0),
          ),
          indentBlock(o.reason, stepColumn(1)),
        ].join('\n'),
      ),
    );
  }
  return spacedList(blocks);
}

/** `worktree-retire run`. 0: every eligible worktree removed. 1: any not removed. 2: refused. */
export async function runRunCommand(
  args: RunCommandArgs,
  io: RetireIo = processRetireIo(),
): Promise<number> {
  if (!io.isTty) {
    await io.stderr(
      'worktree-retire run: refused, nothing removed: it needs a terminal, because you confirm by typing the count\n',
    );
    return 2;
  }
  const read = readPlanFile(args.planFile);
  if (!read.ok) {
    await io.stderr(
      `worktree-retire run: refused, nothing removed: ${read.error}\n`,
    );
    return 2;
  }
  const plan = read.value;
  const eligible = plan.worktrees.filter((w) => w.verdict === 'eligible');
  await io.stdout(
    `${renderPlan(plan, args.planFile, io.stdoutStyle, {eligibleOnly: true})}\n\n`,
  );
  if (eligible.length === 0) {
    await io.stdout('Nothing to remove.\n');
    return 0;
  }
  const seams = args.seams ?? {};
  const stamp = formatLocalTimestamp(seams.now ?? new Date());
  const backupRoot = join(
    beadsBackupsDir(io.env),
    plan.repoName,
    `${stamp}-retire`,
  );
  const count = String(eligible.length);
  const answer = await io.prompt(
    `Each one is checked again first. Beads files are copied to ${backupRoot}/.\nType ${count} to remove these ${count} worktrees, or anything else to stop: `,
  );
  const logPath = join(stateDir(io.env), 'log.jsonl');
  const log = (entry: Record<string, unknown>): string | null => {
    try {
      mkdirSync(dirname(logPath), {recursive: true});
      appendFileSync(
        logPath,
        `${JSON.stringify({at: new Date().toISOString(), plan: args.planFile, run: stamp, ...entry})}\n`,
      );
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };
  if (answer?.trim() !== count) {
    log({outcome: 'refused', step: 'confirm', typed: answer});
    await io.stderr(
      `worktree-retire run: refused, nothing removed: you typed ${JSON.stringify(answer?.trim() ?? '')}, not ${count}\n`,
    );
    return 2;
  }
  const logError = log({
    count: eligible.length,
    outcome: 'ok',
    step: 'confirm',
  });
  if (logError != null) {
    await io.stderr(
      `worktree-retire run: refused, nothing removed: the log ${logPath} cannot be written: ${logError}\n`,
    );
    return 1;
  }
  const readProcesses = seams.readProcesses ?? (() => readLsof());
  const outcomes: Outcome[] = [];
  for (const planned of eligible) {
    const name = planned.name;
    await io.stdout(`\n${paint(name, ['bold'], io.stdoutStyle.color)}\n`);
    const context = readRepoContext(plan.repoRoot, {
      defaultBranch: plan.defaultBranch,
      home: homeFor(io.env),
      processes: readProcesses(),
    });
    if (!context.ok) {
      const reason = `the repo could not be read again: ${context.error}`;
      log({
        outcome: 'skipped',
        reason,
        step: 'recheck',
        worktree: planned.path,
      });
      outcomes.push({kind: 'skipped', name, reason});
      continue;
    }
    const now = gatherEvidence(context.value, planned.path);
    const differences = recheckDifferences(planned, now);
    if (differences.length > 0 || now.verdict !== 'eligible') {
      const reason = `changed since the plan, so it was left alone:\n${(differences.length > 0 ? differences : now.reasons).join('\n')}`;
      log({
        differences,
        outcome: 'skipped',
        reasons: now.reasons,
        step: 'recheck',
        worktree: planned.path,
      });
      await io.stdout(`${indentBlock(`SKIPPED: ${reason}`, stepColumn(0))}\n`);
      outcomes.push({kind: 'skipped', name, reason});
      continue;
    }
    log({outcome: 'ok', step: 'recheck', worktree: planned.path});
    const copied = copyBeads(now, join(backupRoot, name), seams);
    if (!copied.ok) {
      const reason = `the beads copy failed, so the worktree was NOT removed: ${copied.error}`;
      log({
        outcome: 'failed',
        reason,
        step: 'beads-copy',
        worktree: planned.path,
      });
      await io.stdout(`${indentBlock(`FAILED: ${reason}`, stepColumn(0))}\n`);
      outcomes.push({kind: 'failed', name, reason});
      continue;
    }
    log({
      bytes: copied.value.bytes,
      files: copied.value.files,
      manifest: copied.value.manifest,
      outcome: 'ok',
      step: 'beads-copy',
      worktree: planned.path,
    });
    await io.stdout(
      `${indentBlock(
        copied.value.files === 0
          ? 'beads: none to keep'
          : `beads: ${formatCount(copied.value.files, 'file')}, ${formatBytes(copied.value.bytes)}, verified, in ${dirname(copied.value.manifest ?? '')}`,
        stepColumn(0),
      )}\n`,
    );
    log({
      dir: now.transcripts.dir,
      outcome: 'left in place',
      step: 'transcripts',
      worktree: planned.path,
    });
    await io.stdout(
      `${indentBlock(`transcripts: left in place at ${now.transcripts.dir}`, stepColumn(0))}\n`,
    );
    const removed = removeWorktree(plan.repoRoot, now);
    if (!removed.ok) {
      log({
        outcome: 'failed',
        reason: removed.reason,
        step: 'remove',
        worktree: planned.path,
      });
      await io.stdout(
        `${indentBlock(`FAILED: ${removed.reason}`, stepColumn(0))}\n`,
      );
      outcomes.push({kind: 'failed', name, reason: removed.reason});
      continue;
    }
    log({
      forced: removed.forced,
      outcome: 'ok',
      step: 'remove',
      worktree: planned.path,
    });
    await io.stdout(
      `${indentBlock(`removed${removed.forced ? ' (--force: verified submodules only)' : ''}; branch ${now.branch ?? ''} kept`, stepColumn(0))}\n`,
    );
    outcomes.push({forced: removed.forced, kind: 'removed', name});
  }
  await io.stdout(`\n${renderOutcomes(outcomes, io.stdoutStyle)}\n`);
  return outcomes.every((o) => o.kind === 'removed') ? 0 : 1;
}
