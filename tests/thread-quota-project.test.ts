/**
 * A project's spend over the last 24 hours (request home-base-ys9t7.5 D3,
 * built by home-base-ys9t7.5.2): the window edge, the typed-line cut-off,
 * worktree folding, and the mtime filter, over real transcript files.
 *
 * Every request is 1 % of the week at TEST_RATES, so N % means N requests.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {utimesSync} from 'fs';
import {join} from 'path';

import {
  measureProjectSpend,
  PROJECT_WINDOW_MS,
} from '../src/thread/quota-project';
import {assistant, jsonl, kickoff, TEST_RATES, typed} from './quota-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const HOUR = 60 * 60 * 1000;

function projectsWorld() {
  const sb = createSandbox();
  sandboxes.push(sb);
  const root = join(sb.path, 'projects');
  // Real wall-clock time: the mtime filter compares against the files' own
  // mtimes, which are "now" when written.
  const now = Date.now();
  return {
    measure: (checkoutPath = '/repo', nowMs = now) =>
      measureProjectSpend({
        checkoutPath,
        dollarsPerWeekPercent: TEST_RATES,
        nowMs,
        projectsRoot: root,
      }),
    now,
    root,
    write: (dir: string, name: string, lines: string[]) => {
      sb.writeFile(`projects/${dir}/${name}`, jsonl(lines));
    },
  };
}

describe('measureProjectSpend', () => {
  test('the window edge: a request just inside 24 h counts, one just outside does not', async () => {
    const w = projectsWorld();
    const start = w.now - PROJECT_WINDOW_MS;
    w.write('-repo', 's1.jsonl', [
      assistant({atMs: start - 1000, requestId: 'outside'}),
      assistant({atMs: start, requestId: 'at-the-edge'}),
      assistant({atMs: start + 1000, requestId: 'inside'}),
    ]);
    const spend = await w.measure();
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.windowStartMs).toBe(start);
    expect(spend.requests).toBe(2);
    expect(spend.spend.weekPercent).toBe(2);
    expect(spend.firstCountedAtMs).toBe(start);
  });

  test('the typed-line cut-off: only requests after Justin last typed in ANY session of the project', async () => {
    const w = projectsWorld();
    w.write('-repo', 's1.jsonl', [
      typed(w.now - 5 * HOUR),
      assistant({atMs: w.now - 4 * HOUR, requestId: 'r1'}), // before s2's typed line
    ]);
    w.write('-repo--claude-worktrees-wt', 's2.jsonl', [
      kickoff(w.now - 3.5 * HOUR),
      typed(w.now - 3 * HOUR, 'Justin steps in on the worktree session'),
      assistant({atMs: w.now - 2 * HOUR, requestId: 'r2'}),
    ]);
    w.write('-repo', 's3.jsonl', [
      kickoff(w.now - 90 * 60 * 1000),
      assistant({atMs: w.now - HOUR, requestId: 'r3'}),
    ]);
    const spend = await w.measure();
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.latestTypedAtMs).toBe(w.now - 3 * HOUR);
    expect(spend.cutoffMs).toBe(w.now - 3 * HOUR);
    expect(spend.requests).toBe(2);
  });

  test('worktree folding: the repo and its .claude/worktrees checkouts are one project; a lookalike repo is not', async () => {
    const w = projectsWorld();
    w.write('-repo', 'main.jsonl', [
      assistant({atMs: w.now - HOUR, requestId: 'main'}),
    ]);
    w.write('-repo--claude-worktrees-wt', 'wt.jsonl', [
      assistant({atMs: w.now - HOUR, requestId: 'wt'}),
    ]);
    w.write('-repo--claude-worktrees-wt', 'wt/subagents/agent-x.jsonl', [
      assistant({atMs: w.now - HOUR, requestId: 'sub', sidechain: true}),
    ]);
    w.write('-repo-2', 'other.jsonl', [
      assistant({atMs: w.now - HOUR, requestId: 'other'}),
    ]);
    // From the main checkout and from inside the worktree: the same project.
    for (const checkout of ['/repo', '/repo/.claude/worktrees/wt']) {
      const spend = await w.measure(checkout);
      expect(spend.kind).toBe('known');
      if (spend.kind !== 'known') continue;
      expect(spend.projectSlug).toBe('-repo');
      expect(spend.dirs.map((dir) => dir.split('/').at(-1))).toEqual([
        '-repo',
        '-repo--claude-worktrees-wt',
      ]);
      expect(spend.files).toBe(3);
      expect(spend.requests).toBe(3);
    }
  });

  test('a file last modified before the window is not read', async () => {
    const w = projectsWorld();
    w.write('-repo', 'old.jsonl', [
      // Dated inside the window but in a file whose mtime says otherwise:
      // proves the mtime filter, not the date filter, kept it out.
      assistant({atMs: w.now - HOUR, requestId: 'old'}),
    ]);
    const old = (w.now - 25 * HOUR) / 1000;
    utimesSync(join(w.root, '-repo', 'old.jsonl'), old, old);
    w.write('-repo', 'new.jsonl', [
      assistant({atMs: w.now - HOUR, requestId: 'new'}),
    ]);
    const spend = await w.measure();
    expect(spend).toMatchObject({files: 1, kind: 'known', requests: 1});
  });

  test('an unlistable transcripts root is unknown, never zero', async () => {
    const w = projectsWorld();
    const spend = await measureProjectSpend({
      checkoutPath: '/repo',
      dollarsPerWeekPercent: TEST_RATES,
      nowMs: w.now,
      projectsRoot: join(w.root, 'does-not-exist'),
    });
    expect(spend.kind).toBe('unknown');
    if (spend.kind === 'unknown') {
      expect(spend.reason).toContain('could not be listed');
    }
  });
});
