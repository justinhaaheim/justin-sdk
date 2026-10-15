#!/usr/bin/env bun
/**
 * Does a br WRITE overwrite an `issues.jsonl` that `git pull` moved past the
 * database? (home-base-vzwbj.4.9 P1: every SDK br call carries
 * `--no-auto-import`, and br auto-flushes the DB to the JSONL after a write —
 * so a capture child's `br create` right after a pull could replace the pulled
 * export with the DB's older view.)
 *
 * For each write (`br create`, `br update`), in its OWN throwaway workspace
 * under the OS temp dir:
 *   1. `git init` + `br init`, one bead created (the DB and the JSONL agree).
 *   2. A simulated pull: the JSONL is rewritten 1.1 s later with that bead's
 *      title changed and a second bead appended (newer AND different).
 *   3. The write, with `--no-auto-import`, exactly as the SDK sends it.
 *   4. The JSONL is read back: is the pulled title still there, is the pulled
 *      bead still there, is the new write there?
 *
 * Touches nothing outside the temp workspaces, which it deletes at the end
 * (`--keep` leaves them). Uses the br home-base PINS (`mise which br` from the
 * repo root), not whatever the temp dir's mise would pick; `--br <path>`
 * overrides. Spends no tokens.
 *
 *   bun run measure:br-export-clobber [--br <path>] [--keep] [--json]
 */

import {spawnSync} from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const HELP = `measure-br-export-clobber — does a br write overwrite a JSONL that git pull moved past the DB?

Usage: bun run measure:br-export-clobber [--br <path>] [--keep] [--json]

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

function run(
  command: string,
  args: string[],
  cwd: string,
): {status: number | null; stderr: string; stdout: string} {
  const proc = spawnSync(command, args, {cwd, encoding: 'utf-8'});
  if (proc.error != null) {
    throw new Error(`${command} could not run: ${proc.error.message}`);
  }
  return {
    status: proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: (proc.stdout ?? '').trim(),
  };
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The signals a guard could read at one moment: the three files' mtimes and
 * br's own read-only `br sync --status --json` verdict.
 */
interface Snapshot {
  dbMtime: string | null;
  jsonlMtime: string | null;
  syncStatus: string;
  walMtime: string | null;
}

function mtimeOf(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function snapshot(br: string, workspace: string): Snapshot {
  const status = run(
    br,
    ['sync', '--status', '--json', '--no-auto-import'],
    workspace,
  );
  let syncStatus = `exit ${status.status ?? '?'}: ${status.stdout !== '' ? status.stdout : status.stderr}`;
  try {
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    syncStatus = `jsonl_newer=${String(parsed.jsonl_newer)} db_newer=${String(parsed.db_newer)} dirty_count=${String(parsed.dirty_count)}`;
  } catch {
    // Not JSON: the raw text above is the measurement.
  }
  return {
    dbMtime: mtimeOf(join(workspace, '.beads', 'beads.db')),
    jsonlMtime: mtimeOf(join(workspace, '.beads', 'issues.jsonl')),
    syncStatus,
    walMtime: mtimeOf(join(workspace, '.beads', 'beads.db-wal')),
  };
}

interface Result {
  afterCreate: Snapshot;
  afterPull: Snapshot;
  afterWrite: Snapshot;
  brVersion: string;
  newWriteInJsonl: boolean;
  pulledBeadKept: boolean;
  pulledTitleKept: boolean;
  verdict: 'clobbered' | 'kept';
  workspace: string;
  write: 'create' | 'update';
  writeExit: number | null;
  writeStderr: string;
}

function measure(br: string, write: 'create' | 'update'): Result {
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), `br-export-clobber-${write}-`)),
  );
  const git = run('git', ['init', '-q'], workspace);
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  const init = run(br, ['init', '--prefix', 'clob', '-q'], workspace);
  if (init.status !== 0) throw new Error(`br init failed: ${init.stderr}`);
  const first = run(
    br,
    ['create', '--title=Original title', '--silent', '--no-auto-import'],
    workspace,
  );
  const firstId = first.stdout.split('\n').pop()?.trim() ?? '';
  if (first.status !== 0 || firstId === '') {
    throw new Error(`br create failed: ${first.stderr}`);
  }
  const jsonlPath = join(workspace, '.beads', 'issues.jsonl');
  const afterCreate = snapshot(br, workspace);
  const before = readFileSync(jsonlPath, 'utf8');
  const lines = before.split('\n').filter((line) => line.trim() !== '');
  if (!lines.some((line) => line.includes(firstId))) {
    throw new Error(`the export does not hold ${firstId} after br create`);
  }

  // The simulated pull: newer (1.1 s later) and different (an edited title,
  // and a bead the DB has never seen).
  sleepSync(1100);
  const pulled = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.id !== firstId) return line;
    return JSON.stringify({
      ...record,
      title: 'EDITED BY PULL',
      updated_at: new Date().toISOString(),
    });
  });
  const firstRecord = JSON.parse(
    lines.find((line) => line.includes(firstId)) ?? '{}',
  ) as Record<string, unknown>;
  pulled.push(
    JSON.stringify({
      ...firstRecord,
      created_at: new Date().toISOString(),
      id: 'clob-pulled',
      title: 'ADDED BY PULL',
      updated_at: new Date().toISOString(),
    }),
  );
  writeFileSync(jsonlPath, `${pulled.join('\n')}\n`);
  const afterPull = snapshot(br, workspace);

  const writeRun =
    write === 'create'
      ? run(
          br,
          [
            'create',
            '--title=Written after the pull',
            '--silent',
            '--no-auto-import',
          ],
          workspace,
        )
      : run(
          br,
          ['update', firstId, '--add-label=after-pull', '--no-auto-import'],
          workspace,
        );
  const after = readFileSync(jsonlPath, 'utf8');
  const newWriteInJsonl =
    write === 'create'
      ? after.includes('Written after the pull')
      : after.includes('after-pull');
  const pulledTitleKept = after.includes('EDITED BY PULL');
  const pulledBeadKept = after.includes('clob-pulled');
  return {
    afterCreate,
    afterPull,
    afterWrite: snapshot(br, workspace),
    brVersion: run(br, ['--version'], workspace).stdout,
    newWriteInJsonl,
    pulledBeadKept,
    pulledTitleKept,
    verdict: pulledTitleKept && pulledBeadKept ? 'kept' : 'clobbered',
    workspace,
    write,
    writeExit: writeRun.status,
    writeStderr: writeRun.stderr,
  };
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
  const results = (['create', 'update'] as const).map((write) =>
    measure(br, write),
  );
  if (args.json) {
    console.log(JSON.stringify({br, results}, null, 2));
  } else {
    console.log(`br: ${br}`);
    for (const result of results) {
      console.log('');
      console.log(
        `  br ${result.write} --no-auto-import (${result.brVersion})`,
      );
      console.log(`    verdict:            ${result.verdict}`);
      console.log(`    pulled title kept:  ${result.pulledTitleKept}`);
      console.log(`    pulled bead kept:   ${result.pulledBeadKept}`);
      console.log(`    new write exported: ${result.newWriteInJsonl}`);
      console.log(`    write exit:         ${result.writeExit ?? 'killed'}`);
      for (const [label, shot] of [
        ['after the first create (normal)', result.afterCreate],
        ['after the simulated pull', result.afterPull],
        [`after the ${result.write}`, result.afterWrite],
      ] as const) {
        console.log('');
        console.log(`    ${label}:`);
        console.log(`      br sync --status:  ${shot.syncStatus}`);
        console.log(`      beads.db mtime:    ${shot.dbMtime ?? 'absent'}`);
        console.log(`      beads.db-wal:      ${shot.walMtime ?? 'absent'}`);
        console.log(`      issues.jsonl:      ${shot.jsonlMtime ?? 'absent'}`);
      }
      if (result.writeStderr !== '') {
        console.log(
          `    br stderr:          ${result.writeStderr.split('\n').join('\n                        ')}`,
        );
      }
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
