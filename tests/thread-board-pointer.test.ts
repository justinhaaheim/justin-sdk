/**
 * Bare `thread board` points to the session dashboard (home-base-j8q3e.1.6,
 * conductor's option a, 2026-10-15).
 *
 * What must hold: the bare command still DRAINS THE SPOOL (nothing else does)
 * and still prints the threads repo's BACKLOG lines (the SDK's own warnings send
 * people here for them), and then prints a pointer to `threads` / `thread inbox`
 * instead of the per-thread list. It makes no bd listing at all, so a bd that
 * cannot be read does not turn it red. Every flag keeps the old list.
 *
 * The run below is hermetic: a temp state dir for the spool, and a temp git
 * repo standing in for ~/Dev/threads with an uncommitted `issues.jsonl`. The
 * env it passes carries no PATH, so bd is unreachable on any machine: if the
 * bare path reached the listing it would print "could not list threads" and
 * exit 1.
 *
 * NEGATIVE CONTROL, run 2026-10-15: with the `isPointerView` branch in
 * `runThreadBoard` disabled (`if (false && isPointerView(options))`), the run
 * test failed at `expect(err.join('\n')).not.toContain('could not list')`,
 * receiving `thread board: could not list threads — bd list -t thread --limit
 * 0 --json — bd is unreachable (Executable not found in $PATH: "bun")`: the
 * bare command fell through to the bd listing. Restoring the branch returned
 * all four tests to green.
 */

import type {SpoolApplier} from '../src/thread/drain';

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {spoolDir} from '../src/thread/archive';
import {
  isPointerView,
  renderBoardPointer,
  runThreadBoard,
} from '../src/thread/board';

const PLAIN = {color: false, width: null};

describe('renderBoardPointer', () => {
  test('names both dashboards and every flag that still shows the old list', () => {
    const text = renderBoardPointer(PLAIN);
    expect(text).toContain('threads');
    expect(text).toContain('bun run justin-sdk thread inbox');
    for (const flag of ['--recent', '--all', '--open-asks', '--json']) {
      expect(text).toContain(flag);
    }
  });

  test('plain style emits no escape byte', () => {
    expect(renderBoardPointer(PLAIN)).not.toContain('\u001b');
  });
});

describe('isPointerView', () => {
  test('only the bare command is the pointer; every flag keeps the old list', () => {
    expect(isPointerView({})).toBe(true);
    expect(isPointerView({view: 'repo'})).toBe(true);
    expect(isPointerView({view: 'recent'})).toBe(false);
    expect(isPointerView({view: 'openAsks'})).toBe(false);
    expect(isPointerView({json: true})).toBe(false);
    expect(
      isPointerView({includeBackfilled: true, includeContinued: true}),
    ).toBe(false);
  });
});

describe('bare runThreadBoard', () => {
  let stateDir: string;
  let repoDir: string;

  function git(args: string[]): void {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=board-test',
        '-c',
        'user.email=board-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {cwd: repoDir, encoding: 'utf8'},
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'board-pointer-state-'));
    repoDir = mkdtempSync(join(tmpdir(), 'board-pointer-repo-'));
    git(['init', '--quiet']);
    mkdirSync(join(repoDir, '.beads'));
    writeFileSync(join(repoDir, '.beads', 'issues.jsonl'), '{"id":"a"}\n');
    git(['add', '.beads/issues.jsonl']);
    git(['commit', '--quiet', '-m', 'seed']);
    // Uncommitted: the backlog line the bare command must still print.
    writeFileSync(
      join(repoDir, '.beads', 'issues.jsonl'),
      '{"id":"a"}\n{"id":"b"}\n',
    );
  });

  afterEach(() => {
    rmSync(stateDir, {force: true, recursive: true});
    rmSync(repoDir, {force: true, recursive: true});
  });

  test('drains the spool, points to the dashboard, prints the backlog, exits 0', async () => {
    const env = {
      JUSTIN_THREADS_REPO_DIR: repoDir,
      JUSTIN_THREADS_STATE_DIR: stateDir,
    };
    // An invalid spool file is KEPT and named by the drain, so its line proves
    // the drain ran without anything being applied or committed.
    const spool = spoolDir(env);
    mkdirSync(spool, {recursive: true});
    writeFileSync(join(spool, 'sess-x-a.json'), '{"not": "a report"}\n');
    const neverApply: SpoolApplier = () => {
      throw new Error('the bare board must not apply an invalid spool file');
    };

    const out: string[] = [];
    const err: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      out.push(args.map(String).join(' '));
    });
    const errorSpy = spyOn(console, 'error').mockImplementation((...args) => {
      err.push(args.map(String).join(' '));
    });
    let code: number;
    try {
      code = await runThreadBoard({
        apply: neverApply,
        autoCommit: false,
        env,
        style: PLAIN,
      });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    const text = out.join('\n');

    expect(err.join('\n')).not.toContain('could not list');
    expect(code).toBe(0);
    // 1. The drain ran first.
    expect(out[0]).toContain('1 STILL SPOOLED');
    // 2. The pointer, in place of the list.
    expect(text).toContain('Your session dashboard has moved');
    expect(text).toContain('bun run justin-sdk thread inbox');
    expect(text).not.toContain('no open threads');
    // 3. The backlog line, after the pointer.
    const backlogAt = text.indexOf('has UNCOMMITTED changes (+1/-0 lines)');
    expect(backlogAt).toBeGreaterThan(
      text.indexOf('Your session dashboard has moved'),
    );
  });
});
