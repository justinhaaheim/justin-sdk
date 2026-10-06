/**
 * `justin-sdk forensics` (home-base-lj3x9).
 *
 * The worktree facts run against a REAL git repo in $TMPDIR, because what is
 * under test is git behaviour: linked worktrees, a branch with no upstream,
 * a beads file that differs between branches. The session side reuses the
 * thread extractor, which has its own tests; what is tested here is the part
 * this module adds — placing a session in a repo, the coverage counts, and the
 * rule-7 distinctions in the rendering.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {preview, renderRepo, renderRepos} from '../src/forensics/render';
import {
  buildThreadIndex,
  type ForensicsSession,
  type RepoResolution,
  repoRootFromPath,
  resolveRepoRoot,
  summarizeRepos,
} from '../src/forensics/sessions';
import {
  branchOnlyOpenBeads,
  parseWorktreePorcelain,
  readRepoWorktrees,
} from '../src/forensics/worktrees';
import {addLinkedWorktree, git, initPrimary, write} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

let sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes) sb.cleanup();
  sandboxes = [];
});
function sandbox(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

function session(overrides: Partial<ForensicsSession>): ForensicsSession {
  return {
    branch: 'main',
    cwd: '/r',
    failures: [],
    firstTimestamp: '2026-09-20T00:00:00.000Z',
    firstUserMessage: 'first',
    lastAssistantMessage: 'reply',
    lastTimestamp: '2026-09-20T01:00:00.000Z',
    lastUserMessage: 'last',
    repoResolvedBy: 'git',
    repoRoot: '/r',
    resumeCommand: "cd '/r' && claude --resume s1",
    sessionId: 's1',
    thread: null,
    transcriptPath: '/t/s1.jsonl',
    ...overrides,
  };
}

describe('placing a session in a repo', () => {
  test('a worktree path belongs to the checkout above .claude/worktrees', () => {
    expect(
      repoRootFromPath('/Users/j/Dev/app/.claude/worktrees/feat/src'),
    ).toBe('/Users/j/Dev/app');
    expect(repoRootFromPath('/Users/j/Dev/app/pkg/x')).toBe(
      '/Users/j/Dev/app/pkg/x',
    );
  });

  test('a deleted subdirectory resolves to the repo its surviving ancestor is in', () => {
    const sb = sandbox();
    const primary = initPrimary(sb, {'README.md': 'x'});
    const cache = new Map<string, RepoResolution>();
    const gone = resolveRepoRoot(join(primary, 'projects', 'gone-sdk'), cache);
    expect(gone).toEqual({by: 'path', root: primary});
    const removedWorktree = resolveRepoRoot(
      join(primary, '.claude', 'worktrees', 'old'),
      cache,
    );
    expect(removedWorktree).toEqual({by: 'path', root: primary});
  });

  test('a live linked worktree resolves to its main checkout through git', () => {
    const sb = sandbox();
    const primary = initPrimary(sb, {'README.md': 'x'});
    const linked = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'feat'),
      'feat',
    );
    expect(resolveRepoRoot(linked, new Map<string, RepoResolution>())).toEqual({
      by: 'git',
      root: primary,
    });
  });
});

describe('thread coverage', () => {
  test('unreadable threads make coverage null, never zeros', () => {
    const {summaries} = summarizeRepos([session({})], false);
    expect(summaries[0]?.coverage).toBeNull();
    const text = renderRepos(
      {
        days: 14,
        failures: [],
        now: new Date('2026-09-20T02:00:00.000Z'),
        outsideRoot: {directories: 0, sessions: 0},
        root: '/',
        summaries,
        threads: {error: 'bd list — the sandbox refused it', ok: false},
        unplaced: 0,
      },
      PLAIN_STYLE,
    );
    expect(text).toContain('thread coverage unknown');
    expect(text).toContain('UNKNOWN, not zero');
    expect(text).not.toContain('0 reported');
  });

  test('--root hides repos outside it, and counts what it hid', () => {
    const probe = '/private/var/folders/T/capture-entrypoint-probe-bg-x';
    const {outsideRoot, summaries} = summarizeRepos(
      [
        session({repoRoot: '/Users/j/Dev/app', sessionId: 'a'}),
        session({repoRoot: '/Users/j/Dev/app', sessionId: 'b'}),
        session({repoResolvedBy: 'path', repoRoot: probe, sessionId: 'c'}),
        // A sibling whose name merely STARTS with the root is outside it.
        session({repoRoot: '/Users/j/Dev-old/x', sessionId: 'd'}),
      ],
      true,
      '/Users/j/Dev',
    );
    expect(summaries.map((s) => s.repoRoot)).toEqual(['/Users/j/Dev/app']);
    expect(outsideRoot).toEqual({directories: 2, sessions: 2});
    const text = renderRepos(
      {
        days: 14,
        failures: [],
        now: new Date('2026-09-20T02:00:00.000Z'),
        outsideRoot,
        root: '/Users/j/Dev',
        summaries,
        threads: {bySession: new Map(), ok: true},
        unplaced: 0,
      },
      PLAIN_STYLE,
    );
    expect(text).toContain(
      '2 session(s) in 2 directories outside /Users/j/Dev are not listed',
    );
    expect(text).not.toContain(probe);
    // `/` lists everything.
    expect(
      summarizeRepos(
        [session({repoResolvedBy: 'path', repoRoot: probe})],
        true,
        '/',
      ).summaries,
    ).toHaveLength(1);
  });

  test('counts reported, never-reported and thread-less sessions separately', () => {
    const thread = (id: string, source: string) => ({
      id,
      mergeState: null,
      openAsks: 0,
      source,
      status: 'open',
      title: id,
    });
    const {summaries} = summarizeRepos(
      [
        session({sessionId: 'a', thread: thread('th-a', 'report')}),
        session({sessionId: 'b', thread: thread('th-b', 'backfill')}),
        session({sessionId: 'c', thread: thread('th-c', 'start')}),
        session({sessionId: 'd', thread: null}),
      ],
      true,
    );
    expect(summaries[0]?.coverage).toEqual({
      backfilled: 1,
      none: 1,
      reported: 1,
      started: 1,
    });
  });

  test('open asks join to their thread by parent, else by metadata.threadId', () => {
    const index = buildThreadIndex(
      [{id: 'th-1', metadata: {sessionId: 's1', source: 'report'}, title: 'T'}],
      [
        {id: 'th-1.1', parent: 'th-1'},
        {id: 'x', metadata: {threadId: 'th-1'}},
        {id: 'y', parent: 'th-other'},
      ],
    );
    expect(index.get('s1')?.openAsks).toBe(2);
    expect(index.get('s1')?.source).toBe('report');
  });
});

describe('worktree facts', () => {
  test('parses git worktree list --porcelain, primary first', () => {
    const entries = parseWorktreePorcelain(
      [
        'worktree /r',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /r/.claude/worktrees/x',
        'HEAD bbb',
        'detached',
        'locked',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(entries).toEqual([
      {
        bare: false,
        branch: 'main',
        head: 'aaa',
        locked: false,
        path: '/r',
        prunable: false,
      },
      {
        bare: false,
        branch: null,
        head: 'bbb',
        locked: true,
        path: '/r/.claude/worktrees/x',
        prunable: true,
      },
    ]);
  });

  test('branch-only beads: open, and absent from the baseline in any status', () => {
    const line = (id: string, status: string) =>
      JSON.stringify({id, priority: 1, status, title: `t ${id}`});
    const baseline = [line('a', 'open'), line('c', 'closed')].join('\n');
    const branch = [
      line('a', 'open'),
      line('b', 'open'),
      line('c', 'open'),
      line('d', 'closed'),
      '{not json',
    ].join('\n');
    const diff = branchOnlyOpenBeads(branch, baseline);
    expect(diff.beads.map((bead) => bead.id)).toEqual(['b']);
    expect(diff.malformed).toBe(1);
    expect(
      branchOnlyOpenBeads(branch, null).beads.map((bead) => bead.id),
    ).toEqual(['a', 'b', 'c']);
  });

  test('a real repo: unpushed branch reads "no upstream", never "0 unpushed"', () => {
    const sb = sandbox();
    const primary = initPrimary(sb, {
      '.beads/issues.jsonl': `${JSON.stringify({id: 'x-1', status: 'open', title: 'on main'})}\n`,
    });
    const linked = addLinkedWorktree(primary, join(sb.path, 'feat-wt'), 'feat');
    write(
      linked,
      '.beads/issues.jsonl',
      [
        JSON.stringify({id: 'x-1', status: 'open', title: 'on main'}),
        JSON.stringify({id: 'x-2', status: 'open', title: 'branch only'}),
      ].join('\n'),
    );
    git(linked, ['add', '-A']);
    git(linked, ['commit', '-qm', 'branch work']);
    write(linked, 'scratch.txt', 'uncommitted');

    const repo = readRepoWorktrees(primary);
    expect(repo.baseline).toBe('main');
    const [main, feat] = repo.worktrees;
    expect(main?.isPrimary).toBe(true);
    expect(main?.uncommitted).toEqual([]);
    expect(feat?.branch).toBe('feat');
    expect(feat?.vsBaseline).toEqual({ahead: 1, behind: 0});
    expect(feat?.upstream).toBe('none');
    expect(feat?.uncommitted).toEqual(['?? scratch.txt']);
    expect(feat?.branchOnlyBeads).toEqual({
      beads: [
        {id: 'x-2', priority: null, status: 'open', title: 'branch only'},
      ],
      kind: 'measured',
    });

    const text = renderRepo(
      {
        chars: 400,
        days: 14,
        failures: [],
        now: new Date(),
        sessions: [],
        threads: {bySession: new Map(), ok: true},
        worktrees: repo,
      },
      PLAIN_STYLE,
    );
    expect(text).toContain(
      'no upstream: its commits exist on this machine only',
    );
    expect(text).not.toContain('0 unpushed');
    expect(text).toContain('open beads only on this branch (1): x-2');
  });
});

describe('previews', () => {
  test('collapse whitespace and say how much was cut', () => {
    expect(preview('a\n\n  b', 400)).toBe('a b');
    expect(preview('abcdefghij', 4)).toBe('abcd… (+6 chars)');
    expect(preview('abcdefghij', 0)).toBe('abcdefghij');
  });
});
