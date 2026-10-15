#!/usr/bin/env bun
/**
 * Does `br sync --import-only` run git, or touch anything outside the beads DB?
 * (home-base-vzwbj.4.14 acceptance criterion 1, measured for the fix round
 * home-base-j8q3e.1.10 F3.)
 *
 * Every SDK br call passes `--no-auto-import` because br's AUTO-import was seen
 * to run a real `git merge origin/main` in a worktree (home-base c2u5). Before
 * the v4 write path may import on its own, we need to know whether the
 * explicit import is free of that.
 *
 * Each case runs in its OWN throwaway workspace under the OS temp dir:
 *   1. A bare `origin` repo and a clone, with `br init`, one bead, pushed.
 *   2. A second clone edits that bead's title in issues.jsonl, adds a bead,
 *      and pushes; the first clone runs a real `git pull`. issues.jsonl is now
 *      ahead of the DB (`jsonl_newer: true`), exactly as after a merge.
 *   3. The second clone pushes one more commit and the first clone FETCHES it,
 *      so `origin/main` is ahead of HEAD: any hidden `git merge origin/main`
 *      would move HEAD.
 *   4. A bead exists only in the DB (created, then its export line removed by
 *      hand), so an import that deletes DB rows the export lacks is visible.
 *   5. The command under test runs with a `git` shim first on PATH that logs
 *      every invocation and then runs the real git.
 *   6. Read back: the git calls, HEAD, `git status --porcelain`, the export's
 *      bytes, `br sync --status`, and the DB's view of the three beads.
 *
 * Touches nothing outside the temp workspaces, which it deletes at the end
 * (`--keep` leaves them). Uses the br home-base PINS (`mise which br` from the
 * repo root); `--br <path>` overrides. Spends no tokens.
 *
 *   bun run measure:br-import-only [--br <path>] [--keep] [--json]
 */

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const HELP = `measure-br-import-only — does \`br sync --import-only\` run git, or touch the working tree?

Usage: bun run measure:br-import-only [--br <path>] [--keep] [--json]

  --br <path>  the br binary to measure (default: the one home-base's mise.toml pins,
               resolved with \`mise which br\` from the repo root)
  --keep       leave the temp workspaces in place and print their paths
  --json       print the results as JSON

Writes only inside throwaway workspaces under the OS temp dir.`;

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

interface Args {
  br: string | null;
  json: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {br: null, json: false, keep: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--json') args.json = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--br' && next != null) {
      args.br = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  return args;
}

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): RunResult {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: env == null ? process.env : {...process.env, ...env},
  });
  if (proc.error != null) {
    throw new Error(`${command} could not run: ${proc.error.message}`);
  }
  return {
    status: proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: (proc.stdout ?? '').trim(),
  };
}

/** The text a reader needs from a run: stderr when it said anything, else stdout. */
function said(result: RunResult): string {
  return result.stderr !== '' ? result.stderr : result.stdout;
}

function must(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    throw new Error(`${what} exited ${result.status ?? '?'}: ${said(result)}`);
  }
  return result;
}

function pinnedBr(): string {
  const which = run('mise', ['which', 'br'], REPO_ROOT);
  if (which.status !== 0 || which.stdout === '') {
    throw new Error(
      `mise which br (from ${REPO_ROOT}) failed: ${which.stderr !== '' ? which.stderr : `exit ${which.status ?? '?'}`}; pass --br <path>`,
    );
  }
  return which.stdout;
}

function realGit(): string {
  const which = must(run('which', ['git'], REPO_ROOT), 'which git');
  return which.stdout.split('\n')[0] ?? 'git';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gitIn(cwd: string, args: string[]): RunResult {
  return must(run('git', args, cwd), `git ${args.join(' ')}`);
}

function configureIdentity(cwd: string): void {
  gitIn(cwd, ['config', 'user.email', 'measure@example.invalid']);
  gitIn(cwd, ['config', 'user.name', 'measure']);
  gitIn(cwd, ['config', 'commit.gpgsign', 'false']);
}

interface State {
  dbView: string;
  exportSha: string;
  head: string;
  porcelain: string;
  syncStatus: string;
}

function readState(br: string, clone: string, ids: string[]): State {
  const status = run(
    br,
    ['sync', '--status', '--json', '--no-auto-import'],
    clone,
  );
  let syncStatus = `exit ${status.status ?? '?'}: ${status.stdout !== '' ? status.stdout : status.stderr}`;
  try {
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    syncStatus = `jsonl_newer=${String(parsed.jsonl_newer)} db_newer=${String(parsed.db_newer)}`;
  } catch {
    // Not JSON: the raw text above is the measurement.
  }
  const view = ids.map((id) => {
    const shown = run(br, ['show', id, '--json', '--no-auto-import'], clone);
    if (shown.status !== 0)
      return `${id}: absent (exit ${shown.status ?? '?'})`;
    try {
      const parsed: unknown = JSON.parse(shown.stdout);
      const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<
        string,
        unknown
      >;
      return `${id}: ${JSON.stringify(record.title)}`;
    } catch {
      return `${id}: unparseable`;
    }
  });
  return {
    dbView: view.join(' | '),
    exportSha: createHash('sha256')
      .update(readFileSync(join(clone, '.beads', 'issues.jsonl')))
      .digest('hex')
      .slice(0, 12),
    head: gitIn(clone, ['rev-parse', 'HEAD']).stdout,
    porcelain: gitIn(clone, ['status', '--porcelain']).stdout,
    syncStatus,
  };
}

interface Case {
  args: string[];
  label: string;
}

interface Result {
  after: State;
  before: State;
  exit: number | null;
  gitCalls: string[];
  label: string;
  originAhead: boolean;
  stderr: string;
  workspace: string;
}

function measure(br: string, gitPath: string, testCase: Case): Result {
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), 'br-import-only-')),
  );
  const origin = join(workspace, 'origin.git');
  const clone = join(workspace, 'clone');
  const other = join(workspace, 'other');
  must(
    run('git', ['init', '-q', '--bare', '-b', 'main', origin], workspace),
    'git init --bare',
  );
  must(
    run('git', ['init', '-q', '-b', 'main', clone], workspace),
    'git init clone',
  );
  configureIdentity(clone);
  gitIn(clone, ['remote', 'add', 'origin', origin]);
  must(run(br, ['init', '--prefix', 'imp', '-q'], clone), 'br init');
  const created = must(
    run(
      br,
      ['create', '--title=Original title', '--silent', '--no-auto-import'],
      clone,
    ),
    'br create',
  );
  const firstId = created.stdout.split('\n').pop()?.trim() ?? '';
  writeFileSync(join(clone, 'README.md'), 'fixture\n');
  gitIn(clone, ['add', '-A']);
  gitIn(clone, ['commit', '-q', '-m', 'fixture']);
  gitIn(clone, ['push', '-q', '-u', 'origin', 'main']);

  // The other clone edits the bead and adds one, then pushes.
  must(run('git', ['clone', '-q', origin, other], workspace), 'git clone');
  configureIdentity(other);
  sleepSync(1100);
  const exportPath = join(other, '.beads', 'issues.jsonl');
  const lines = readFileSync(exportPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const firstRecord = JSON.parse(
    lines.find((line) => line.includes(firstId)) ?? '{}',
  ) as Record<string, unknown>;
  const now = new Date().toISOString();
  const pulled = lines.map((line) =>
    line.includes(firstId)
      ? JSON.stringify({
          ...firstRecord,
          title: 'EDITED BY PULL',
          updated_at: now,
        })
      : line,
  );
  pulled.push(
    JSON.stringify({
      ...firstRecord,
      created_at: now,
      id: 'imp-pulled',
      title: 'ADDED BY PULL',
      updated_at: now,
    }),
  );
  writeFileSync(exportPath, `${pulled.join('\n')}\n`);
  gitIn(other, ['add', '-A']);
  gitIn(other, ['commit', '-q', '-m', 'edit beads']);
  gitIn(other, ['push', '-q']);

  // A bead only the DB holds: created, then its export line removed by hand.
  const local = must(
    run(
      br,
      ['create', '--title=Only in the DB', '--silent', '--no-auto-import'],
      clone,
    ),
    'br create (db only)',
  );
  const localId = local.stdout.split('\n').pop()?.trim() ?? '';
  gitIn(clone, ['checkout', '-q', '--', '.beads/issues.jsonl']);

  // The real pull moves issues.jsonl past the DB.
  gitIn(clone, ['pull', '-q', '--no-rebase']);

  // origin/main gets ahead of HEAD: a hidden merge would move HEAD.
  writeFileSync(join(other, 'later.txt'), 'later\n');
  gitIn(other, ['add', '-A']);
  gitIn(other, ['commit', '-q', '-m', 'later']);
  gitIn(other, ['push', '-q']);
  gitIn(clone, ['fetch', '-q']);
  const originAhead =
    gitIn(clone, ['rev-list', '--count', 'HEAD..origin/main']).stdout !== '0';

  const ids = [firstId, 'imp-pulled', localId];
  const before = readState(br, clone, ids);

  const shimDir = join(workspace, 'shim');
  mkdirSync(shimDir);
  const log = join(workspace, 'git-calls.log');
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${gitPath}' "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
  const measured = run(br, testCase.args, clone, {
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
  });
  const gitCalls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
  return {
    after: readState(br, clone, ids),
    before,
    exit: measured.status,
    gitCalls,
    label: testCase.label,
    originAhead,
    stderr: measured.stderr,
    workspace,
  };
}

const CASES: Case[] = [
  {
    args: ['sync', '--import-only', '--no-auto-import'],
    label: 'br sync --import-only --no-auto-import (what the SDK would send)',
  },
  {args: ['sync', '--import-only'], label: 'br sync --import-only'},
  {
    args: ['list', '--json'],
    label: 'br list --json (control: plain auto-import)',
  },
  // POSITIVE CONTROL for the shim: br spawns `git rev-parse --show-toplevel`
  // by bare name under `stats` (the string is in the 0.1.37 binary). If this
  // case logs no git call, the shim is blind and every "none" above is void.
  {
    args: ['stats', '--no-auto-import'],
    label: 'br stats --no-auto-import (positive control: the shim sees git)',
  },
];

function printState(label: string, state: State): void {
  console.log(`    ${label}:`);
  console.log(`      HEAD:               ${state.head.slice(0, 12)}`);
  console.log(
    `      git status:         ${state.porcelain === '' ? '(clean)' : state.porcelain.split('\n').join(' ; ')}`,
  );
  console.log(`      issues.jsonl sha:   ${state.exportSha}`);
  console.log(`      br sync --status:   ${state.syncStatus}`);
  console.log(`      DB view:            ${state.dbView}`);
}

function main(): number {
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
  const br = args.br ?? pinnedBr();
  const gitPath = realGit();
  const version = run(br, ['--version'], REPO_ROOT).stdout;
  const results = CASES.map((testCase) => measure(br, gitPath, testCase));
  if (args.json) {
    console.log(JSON.stringify({br, results, version}, null, 2));
  } else {
    console.log(`br: ${br} (${version})`);
    for (const result of results) {
      console.log('');
      console.log(`  ${result.label}`);
      console.log(`    exit:               ${result.exit ?? 'killed'}`);
      console.log(`    origin/main ahead:  ${result.originAhead}`);
      console.log(
        `    git calls:          ${result.gitCalls.length === 0 ? 'none' : result.gitCalls.join(' ; ')}`,
      );
      if (result.stderr !== '') {
        console.log(`    stderr:             ${result.stderr.split('\n')[0]}`);
      }
      printState('before', result.before);
      printState('after', result.after);
      if (args.keep) console.log(`    workspace:          ${result.workspace}`);
    }
  }
  if (!args.keep) {
    for (const result of results) {
      rmSync(result.workspace, {force: true, recursive: true});
    }
  }
  return 0;
}

process.exit(main());
