/**
 * The bead export gate (home-base-jm5kg.11.3). Real git and real commits in a
 * scratch repo. Each refusal has its clean twin beside it as the control.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  checkStagedExport,
  exportLineProblems,
  runPreCommitBeadsExport,
} from '../src/pre-commit-beads-export/check';
import {git, initRepo} from './git-fixtures';
import {createSandbox} from './sandbox';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const RECORD = '{"id":"t-1","title":"one"}';
const OTHER = '{"id":"t-2","title":"two"}';
const CLEAN = `${RECORD}\n${OTHER}\n`;
const MARKED = `<<<<<<< ours\n${RECORD}\n||||||| base\n${OTHER}\n=======\n${OTHER}\n>>>>>>> theirs\n`;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function scratchRepo(): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  const repo = initRepo(sb, 'export-repo', {'README.md': '# p\n'});
  mkdirSync(join(repo, '.beads'), {recursive: true});
  return repo;
}

function stage(repo: string, text: string): void {
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), text);
  git(repo, ['add', '.beads/issues.jsonl']);
}

describe('which lines are not bead records', () => {
  test('all four marker lines and a broken line are named, and a clean export has none', () => {
    expect(exportLineProblems(CLEAN)).toEqual([]);
    expect(exportLineProblems('')).toEqual([]);
    expect(exportLineProblems(MARKED).map((entry) => entry.line)).toEqual([
      1, 3, 5, 7,
    ]);
    expect(exportLineProblems(`${RECORD}\n{"id":"t-\n`)).toEqual([
      {line: 2, what: 'not valid JSON: {"id":"t-'},
    ]);
  });
});

describe('the staged blob decides', () => {
  test('markers in the blob with a clean working file are refused', () => {
    const repo = scratchRepo();
    stage(repo, MARKED);
    writeFileSync(join(repo, '.beads', 'issues.jsonl'), CLEAN);
    expect(checkStagedExport(repo).kind).toBe('bad');
  });

  test('a clean blob with markers in the working file passes', () => {
    const repo = scratchRepo();
    stage(repo, CLEAN);
    writeFileSync(join(repo, '.beads', 'issues.jsonl'), MARKED);
    expect(checkStagedExport(repo)).toEqual({kind: 'clean'});
  });

  test('markers in an export this commit does not stage pass', () => {
    const repo = scratchRepo();
    writeFileSync(join(repo, '.beads', 'issues.jsonl'), MARKED);
    expect(checkStagedExport(repo)).toEqual({kind: 'notStaged'});
  });

  test('a staged deletion passes', () => {
    const repo = scratchRepo();
    stage(repo, CLEAN);
    git(repo, ['commit', '-qm', 'export']);
    git(repo, ['rm', '-q', '.beads/issues.jsonl']);
    expect(checkStagedExport(repo)).toEqual({kind: 'notStaged'});
  });

  test('from a subdirectory it still finds the export', () => {
    const repo = scratchRepo();
    stage(repo, MARKED);
    expect(checkStagedExport(join(repo, '.beads')).kind).toBe('bad');
  });

  test('a staged entry whose blob cannot be read could not be checked', () => {
    const repo = scratchRepo();
    git(repo, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${'1'.repeat(40)},.beads/issues.jsonl`,
    ]);
    expect(checkStagedExport(repo).kind).toBe('failed');
  });

  test('outside a git repo it could not check, and that refuses', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const said: string[] = [];
    const code = runPreCommitBeadsExport({
      cwd: sb.path,
      print: (line) => said.push(line),
    });
    expect(code).toBe(1);
    expect(said.join('\n')).toContain('could not be checked');
  });
});

describe('a real commit through a real hook', () => {
  function withHook(repo: string): void {
    const hooks = join(repo, 'hooks');
    mkdirSync(hooks, {recursive: true});
    const hook = join(hooks, 'pre-commit');
    writeFileSync(
      hook,
      `#!/bin/sh\nexec bun run ${CLI} pre-commit-beads-export\n`,
    );
    chmodSync(hook, 0o755);
    git(repo, ['config', 'core.hooksPath', hooks]);
  }

  function commit(repo: string) {
    return spawnSync('git', ['commit', '-m', 'export'], {
      cwd: repo,
      encoding: 'utf8',
    });
  }

  test('a marker-bearing export is refused and nothing lands; the clean one commits', () => {
    const repo = scratchRepo();
    withHook(repo);
    const before = git(repo, ['rev-parse', 'HEAD']);

    stage(repo, MARKED);
    const refused = commit(repo);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Commit refused');
    expect(refused.stderr).toContain('line 1: conflict marker: <<<<<<< ours');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);

    stage(repo, CLEAN);
    const passed = commit(repo);
    expect(passed.status).toBe(0);
    expect(git(repo, ['rev-parse', 'HEAD'])).not.toBe(before);
  }, 60_000);

  test('its --help runs no check and lists it on the top-level help', () => {
    const help = spawnSync('bun', ['run', CLI, '--help'], {encoding: 'utf8'});
    expect(help.stdout).toContain('pre-commit-beads-export');
    const own = spawnSync(
      'bun',
      ['run', CLI, 'pre-commit-beads-export', '--help'],
      {cwd: '/', encoding: 'utf8'},
    );
    expect(own.status).toBe(0);
    expect(own.stderr).not.toContain('Commit refused');
  }, 60_000);
});
