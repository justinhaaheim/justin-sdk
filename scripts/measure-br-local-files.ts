#!/usr/bin/env bun
/**
 * measure-br-local-files — which local-only files a br leaves in a repo that
 * its `.beads/.gitignore` does not cover (home-base-dj5m9.1.5, item 5).
 *
 * WHY. `.beads/.gitignore` is written once, by the `br init` that made the
 * workspace. Every repo of Justin's was made by br 0.1.37 or older. A newer
 * br writes new sidecar files beside its DB; any the old ignore file misses
 * shows up as untracked, and `git add -A` (or beads-setup's own
 * `git add .beads/`) commits it.
 *
 * WHAT. Two scratch git repos under the OS temp dir, each with a linked
 * worktree that has no DB of its own:
 *   - `upgraded`: made by --old-br (its `.beads/.gitignore`, or with
 *     --gitignores-from, that checkout's `.beads/.gitignore` and root
 *     `.gitignore` copied over it), its WAL checkpointed as the upgrade plan
 *     does, then used by --new-br. The real upgrade path. Skipped without
 *     --old-br.
 *   - `fresh`: made by --new-br (its own `.beads/.gitignore`).
 * In each, the new br runs the commands the SDK and its users run (list,
 * show, create, update, close, label, dep, sync, doctor, history, where,
 * info), from the main checkout and from the worktree. Then
 * `git status --porcelain --untracked-files=all` in both checkouts lists
 * every path git would add (`??`) or reports changed, and `--ignored` lists
 * what is ignored and by which rule. The same report follows a
 * `br doctor --repair`, which (on 0.7.6) appends to both ignore files.
 * Every bead title carries the --marker test-data UUID. The scratch repos are
 * removed afterwards unless --keep. Files named by --gitignores-from are only
 * read.
 *
 *   bun run measure:br-local-files --new-br <path> [--old-br <path>] [--gitignores-from <checkout>] --marker <uuid> [--keep]
 */

import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const HELP = `measure-br-local-files — local-only files a br leaves that .beads/.gitignore misses

Usage: bun run measure:br-local-files --new-br <path> [--old-br <path>] [--gitignores-from <checkout>] --marker <uuid> [--keep]

  --new-br <path>              the br whose files are measured (for the 0.7.6 flip: 0.7.6)
  --old-br <path>              the br that made the workspace in the "upgraded" repo (0.1.37)
  --gitignores-from <checkout> in the "upgraded" repo, use this checkout's .beads/.gitignore
                               and root .gitignore (read only) instead of what the old br wrote
  --marker <uuid>              the session's test-data UUID, put in every bead title
  --keep                       leave the scratch repos in place and print their paths

Writes only inside scratch git repos under the OS temp dir.`;

interface Args {
  gitignoresFrom: string | null;
  keep: boolean;
  marker: string;
  newBr: string;
  oldBr: string | null;
}

function parseArgs(argv: string[]): Args | null {
  let newBr: string | null = null;
  let oldBr: string | null = null;
  let gitignoresFrom: string | null = null;
  let marker: string | null = null;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--keep') keep = true;
    else if (arg === '--new-br' && next != null) {
      newBr = next;
      index += 1;
    } else if (arg === '--old-br' && next != null) {
      oldBr = next;
      index += 1;
    } else if (arg === '--gitignores-from' && next != null) {
      gitignoresFrom = next;
      index += 1;
    } else if (arg === '--marker' && next != null) {
      marker = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (newBr == null || marker == null) {
    throw new Error('--new-br and --marker are required');
  }
  return {gitignoresFrom, keep, marker, newBr, oldBr};
}

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function run(command: string, args: readonly string[], cwd: string): RunResult {
  const proc = spawnSync(command, args, {cwd, encoding: 'utf-8'});
  if (proc.error != null) {
    throw new Error(`${command} could not run: ${proc.error.message}`);
  }
  return {
    status: proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: proc.stdout ?? '',
  };
}

function must(command: string, args: readonly string[], cwd: string): string {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? '?'}: ${result.stderr !== '' ? result.stderr : result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/** `git status` lines under the checkout, in porcelain v1, one per path. */
function statusLines(checkout: string, ignored: boolean): string[] {
  return must(
    'git',
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      ...(ignored ? ['--ignored=matching'] : []),
    ],
    checkout,
  )
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** What git would add, what changed, and what is ignored by which rule. */
function report(
  lines: string[],
  main: string,
  wt: string,
  gitignoreAtCommit: string,
): void {
  const gitignoreNow = readFileSync(
    join(main, '.beads', '.gitignore'),
    'utf-8',
  );
  lines.push(
    `  .beads/.gitignore rewritten by the new br: ${gitignoreNow !== gitignoreAtCommit}`,
  );
  for (const [name, checkout] of [
    ['main', main],
    ['worktree', wt],
  ] as const) {
    const status = statusLines(checkout, false);
    const untracked = status.filter((line) => line.startsWith('??'));
    const changed = status.filter((line) => !line.startsWith('??'));
    lines.push(
      `  ${name}: NOT ignored, would be added (??): ${untracked.length === 0 ? 'none' : ''}`,
      ...untracked.map((line) => {
        const path = line.slice(3);
        return path.endsWith('.gitignore')
          ? `    ${path}, which says: ${JSON.stringify(readFileSync(join(checkout, path), 'utf-8'))}`
          : `    ${path}`;
      }),
      `  ${name}: tracked files changed: ${changed.length === 0 ? 'none' : ''}`,
      ...changed.map((line) => `    ${line}`),
      `  ${name}: ignored (!!), with the rule that ignores it:`,
      ...statusLines(checkout, true)
        .filter((line) => line.startsWith('!!'))
        .map((line) => {
          const path = line.slice(3);
          const rule = run('git', ['check-ignore', '-v', path], checkout);
          return `    ${path}  ←  ${rule.status === 0 ? (rule.stdout.split('\t')[0] ?? '?') : `check-ignore exit ${rule.status ?? '?'}`}`;
        }),
    );
  }
}

function exercise(
  label: string,
  root: string,
  maker: string,
  newBr: string,
  tag: string,
  gitignoresFrom: string | null = null,
): string[] {
  const main = join(root, label);
  const wt = join(root, `${label}-wt`);
  const lines = [
    `${label}: workspace made by ${must(maker, ['--version'], root)}`,
  ];
  mkdirSync(main);
  must('git', ['init', '-q', '-b', 'main'], main);
  must('git', ['config', 'user.email', 'probe@example.invalid'], main);
  must('git', ['config', 'user.name', 'probe'], main);
  must(maker, ['init', '--prefix', 'f'], main);
  if (gitignoresFrom != null) {
    for (const file of [join('.beads', '.gitignore'), '.gitignore']) {
      const from = join(gitignoresFrom, file);
      if (existsSync(from)) copyFileSync(from, join(main, file));
      else rmSync(join(main, file), {force: true});
    }
    lines.push(`  ignore files copied from ${gitignoresFrom}`);
  }
  must(maker, ['create', `seed ${tag}`, '--silent'], main);
  must('git', ['add', '-A'], main);
  must('git', ['commit', '-qm', 'seed'], main);
  const gitignoreAtCommit = readFileSync(
    join(main, '.beads', '.gitignore'),
    'utf-8',
  );
  must('git', ['worktree', 'add', '-q', wt, '-b', 'wtb'], main);
  if (maker !== newBr) {
    // The upgrade plan's own step (home-base-pp1vx.1.1): an old br's WAL
    // frames make br 0.7.6 refuse with exit 6, so the WAL is checkpointed
    // before the new br first opens the DB.
    must(
      'sqlite3',
      [join(main, '.beads', 'beads.db'), 'PRAGMA wal_checkpoint(TRUNCATE);'],
      main,
    );
    lines.push(
      "  the old br's WAL checkpointed before the new br opened the DB",
    );
  }

  const failed: string[] = [];
  const br = (args: string[], cwd: string): string => {
    const result = run(newBr, args, cwd);
    if (result.status !== 0) {
      failed.push(
        `${args.join(' ')} (in ${cwd === main ? 'main' : 'worktree'}) exited ${result.status ?? '?'}: ${(result.stderr !== '' ? result.stderr : result.stdout).split('\n')[0] ?? ''}`,
      );
    }
    return result.stdout.trim();
  };
  for (const cwd of [main, wt]) {
    const where = cwd === main ? 'main' : 'worktree';
    br(['where'], cwd);
    br(['info'], cwd);
    br(['list', '--json'], cwd);
    const a = br(['create', `${where} a ${tag}`, '--silent'], cwd);
    const b = br(
      ['create', `${where} b ${tag}`, '--silent', '--parent', a],
      cwd,
    );
    br(['show', a, '--json'], cwd);
    br(['update', a, '--status', 'in_progress'], cwd);
    br(['label', 'add', b, 'probe'], cwd);
    br(['dep', 'add', a, b], cwd);
    br(['close', b, '--reason', 'probe'], cwd);
    br(['ready'], cwd);
    br(['sync', '--flush-only'], cwd);
    br(['sync', '--import-only'], cwd);
    br(['history', 'list'], cwd);
    br(['doctor'], cwd);
  }
  lines.push(
    '  AFTER THE ORDINARY COMMANDS (doctor without --repair included)',
  );
  report(lines, main, wt, gitignoreAtCommit);
  br(['doctor', '--repair'], main);
  lines.push('  AFTER `br doctor --repair` in the main checkout');
  report(lines, main, wt, gitignoreAtCommit);
  lines.push(
    failed.length === 0
      ? '  every br command exited 0'
      : `  br commands that did not exit 0 (doctor exits 1 on any WARN; listed so nothing is hidden):\n${failed.map((line) => `    ${line}`).join('\n')}`,
  );
  return lines;
}

function measure(args: Args): string[] {
  const tag = `[TEST_DATA_DELETABLE ${args.marker} ]`;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'br-local-files-'));
  const lines = [
    `new br: ${must(args.newBr, ['--version'], root)}`,
    `scratch: ${root}`,
  ];
  try {
    if (args.oldBr != null) {
      lines.push(
        ...exercise(
          'upgraded',
          root,
          args.oldBr,
          args.newBr,
          tag,
          args.gitignoresFrom,
        ),
      );
    } else {
      lines.push('upgraded: SKIPPED, no --old-br given');
    }
    lines.push(...exercise('fresh', root, args.newBr, args.newBr, tag));
    if (args.keep) lines.push(`kept: ${root}`);
  } finally {
    if (!args.keep) rmSync(root, {force: true, recursive: true});
  }
  return lines;
}

function cli(): number {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 2;
  }
  if (args == null) {
    console.log(HELP);
    return 0;
  }
  try {
    console.log(measure(args).join('\n'));
    return 0;
  } catch (error) {
    console.error(
      `measurement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(cli());
}
