/**
 * repo-status's opt-in views: `status --checkouts`, `status --sessions` and
 * `repo-status repos` (home-base-39co9.5; first built as `justin-sdk
 * forensics`, home-base-lj3x9), plus the ledger's per-row PR line (R4).
 *
 * The checkout facts run against a REAL git repo in $TMPDIR, because what is
 * under test is git behaviour: linked worktrees, a branch with no upstream, a
 * beads file that differs between branches, a squash-merge. The session side
 * reuses the thread extractor, which has its own tests; what is tested here is
 * placing a session in a repo, the coverage counts, the rule-7 distinctions,
 * and the layout rules Justin set on 2026-10-05 (uniform indent step, vertical
 * fields, blank lines between records and before sub-headings).
 */

import type {BranchRow, RepoStatusReport} from '../src/repo-status/report';

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  branchOnlyOpenBeads,
  parseWorktreePorcelain,
} from '../src/repo-status/checkouts';
import {prDetail, renderReportPretty} from '../src/repo-status/pretty';
import {buildReport} from '../src/repo-status/report';
import {
  buildThreadIndex,
  type RepoResolution,
  repoRootFromPath,
  resolveRepoRoot,
  type SessionFacts,
  summarizeRepos,
} from '../src/repo-status/sessions';
import {
  preview,
  renderCheckouts,
  renderRepos,
  renderSessions,
} from '../src/repo-status/views';
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

function session(overrides: Partial<SessionFacts>): SessionFacts {
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

/** The leading-space count of every non-blank line. */
function indents(text: string): number[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
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

describe('repo-status repos: thread coverage', () => {
  test('unreadable threads make coverage null, never zeros', () => {
    const {summaries} = summarizeRepos([session({})], false);
    expect(summaries[0]?.coverage).toBeNull();
    const text = renderRepos(
      {
        days: 14,
        failures: [],
        glances: new Map(),
        now: new Date('2026-09-20T02:00:00.000Z'),
        outsideRoot: {directories: 0, sessions: 0},
        root: '/',
        summaries,
        threads: {error: 'bd list — the sandbox refused it', ok: false},
        unplaced: 0,
      },
      PLAIN_STYLE,
    );
    expect(text).toContain(
      'thread coverage:  UNKNOWN (thread beads unreadable)',
    );
    expect(text).toContain('UNKNOWN, not zero');
    expect(text).not.toContain('reported:');
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
        glances: new Map(),
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

describe('checkout facts', () => {
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

  /**
   * main; `feat` (unmerged, never pushed, a branch-only bead and an
   * uncommitted file) in a linked worktree; `squashed` (squash-merged into
   * main, so AHEAD 1 by commit identity and merged by content) in another.
   */
  function fixture(): {primary: string; report: RepoStatusReport} {
    const sb = sandbox();
    const primary = initPrimary(sb, {
      '.beads/issues.jsonl': `${JSON.stringify({id: 'x-1', status: 'open', title: 'on main'})}\n`,
    });
    const feat = addLinkedWorktree(primary, join(sb.path, 'feat-wt'), 'feat');
    write(
      feat,
      '.beads/issues.jsonl',
      [
        JSON.stringify({id: 'x-1', status: 'open', title: 'on main'}),
        JSON.stringify({id: 'x-2', status: 'open', title: 'branch only'}),
      ].join('\n'),
    );
    git(feat, ['add', '-A']);
    git(feat, ['commit', '-qm', 'branch work']);
    write(feat, 'scratch.txt', 'uncommitted');

    const squashed = addLinkedWorktree(
      primary,
      join(sb.path, 'squash-wt'),
      'squashed',
    );
    write(squashed, 'squash.txt', 'landed by squash\n');
    git(squashed, ['add', '-A']);
    git(squashed, ['commit', '-qm', 'squash me']);
    git(primary, ['merge', '-q', '--squash', 'squashed']);
    git(primary, ['commit', '-qm', 'squash-merge squashed']);

    const report = buildReport({
      checkouts: true,
      cwd: primary,
      prs: false,
      submodules: false,
    });
    if (report == null) throw new Error('expected a report');
    return {primary, report};
  }

  test('a real repo: the facts, with "no upstream" never read as "0 unpushed"', () => {
    const {report} = fixture();
    const checkouts = report.checkouts?.checkouts ?? [];
    const [main, feat, squashed] = checkouts;
    expect(main?.isPrimary).toBe(true);
    expect(main?.state?.dirty).toBe(false);
    expect(feat?.branch).toBe('feat');
    expect(feat?.upstream).toBe('none');
    expect(feat?.state?.samplePaths).toEqual(['scratch.txt']);
    expect(feat?.branchOnlyBeads).toEqual({
      beads: [
        {id: 'x-2', priority: null, status: 'open', title: 'branch only'},
      ],
      kind: 'measured',
    });
    expect(squashed?.branch).toBe('squashed');

    const text = renderCheckouts(report, PLAIN_STYLE);
    expect(text).toContain(
      'none — its unmerged commits exist on this machine only',
    );
    expect(text).not.toContain('unpushed:');
    expect(text).toContain('Open beads only on this branch (1)');
    expect(text).toContain('x-2  branch only');
  });

  test('merge state is the ledger verdict by content, never an identity count (AC1)', () => {
    const {report} = fixture();
    const row = report.branches?.find((r) => r.name === 'squashed');
    // The premise: by identity the squash-merged branch is still ahead.
    expect(row?.ahead).toBe(1);
    expect(row?.disposition).toBe('merged');

    const text = renderCheckouts(report, PLAIN_STYLE);
    const squashedBlock = text.slice(text.indexOf('\n      squashed\n'));
    expect(squashedBlock).toContain(
      'merge state:   merged — every commit is on the baseline by content',
    );
    const featBlock = text.slice(
      text.indexOf('\n      feat\n'),
      text.indexOf('\n      squashed\n'),
    );
    expect(featBlock).toContain('merge state:   NOT merged — unmerged work');
    // Nothing in the view counts commits by identity.
    expect(text).not.toMatch(/commits? not on main/u);
    expect(text).not.toMatch(/main commits missing/u);
    expect(text).not.toMatch(/\bahead\b/u);
  });

  test('layout: one indent step, vertical bold-labelled fields, blank lines between records (R5)', () => {
    const {report} = fixture();
    const text = renderCheckouts(report, PLAIN_STYLE);
    // Header at 2, records at 6, fields at 10, nested items at 14 — and a
    // multi-line value (the uncommitted paths) at its value column.
    const used = new Set(indents(text));
    for (const column of used) {
      expect([2, 6, 10, 14, 25]).toContain(column);
    }
    expect(text).not.toContain(' · ');
    // Sibling records are separated by a blank line.
    expect(text).toContain('\n\n      feat\n');
    expect(text).toContain('\n\n      squashed\n');
    // A sub-heading has a blank line above it.
    expect(text).toContain('\n\n          Open beads only on this branch (1)');
    // Every field in every record shares one value column.
    const valueColumns = new Set(
      text
        .split('\n')
        .filter((line) => /^ {10}[a-z][a-z ]*: +\S/u.test(line))
        .map((line) => /^ {10}[a-z][a-z ]*: +/u.exec(line)?.[0].length),
    );
    expect(valueColumns.size).toBe(1);
  });

  test('labels are bold on a TTY', () => {
    const {report} = fixture();
    const text = renderCheckouts(report, {color: true, width: null});
    expect(text).toContain('\u001b[1mmerge state:\u001b[0m');
  });
});

describe('status --sessions', () => {
  test('one record per session: vertical fields, messages under sub-headings', () => {
    const text = renderSessions(
      {
        chars: 400,
        days: 14,
        failures: [],
        sessions: [
          session({
            thread: {
              id: 'th-1',
              mergeState: 'merged',
              openAsks: 2,
              source: 'report',
              status: 'open',
              title: 'Reported title',
            },
          }),
          session({sessionId: 's2'}),
        ],
        threads: {bySession: new Map(), ok: true},
        windowStart: '2026-09-06T00:00:00.000Z',
      },
      new Date('2026-09-20T02:00:00.000Z'),
      PLAIN_STYLE,
    );
    expect(text).toContain('\n      Reported title\n');
    expect(text).toContain('          thread:       th-1\n');
    expect(text).toContain('          recorded by:  thread report\n');
    expect(text).toContain('          open asks:    2\n');
    expect(text).toContain(
      '\n\n          Your first message\n\n              first\n',
    );
    expect(text).toContain(
      "\n\n          Claude's last response\n\n              reply\n",
    );
    // The second session has no thread, said as such.
    expect(text).toContain('          thread:       none\n');
    expect(text).not.toContain(' · ');
    for (const column of new Set(indents(text))) {
      expect([2, 6, 10, 14]).toContain(column);
    }
  });

  test('unreadable threads are UNKNOWN, never "none"', () => {
    const text = renderSessions(
      {
        chars: 400,
        days: 14,
        failures: [],
        sessions: [session({})],
        threads: {error: 'bd refused', ok: false},
        windowStart: '2026-09-06T00:00:00.000Z',
      },
      new Date('2026-09-20T02:00:00.000Z'),
      PLAIN_STYLE,
    );
    expect(text).toContain('thread:       UNKNOWN (thread beads unreadable)');
    expect(text).not.toContain('thread:       none');
  });
});

describe('the ledger names every PR (R4)', () => {
  const pr = {
    baseRefName: 'main',
    isDraft: false,
    number: 42,
    state: 'MERGED',
    url: 'https://github.com/o/r/pull/42',
  };

  test('a merged row with a PR gets its own PR line', () => {
    const row = {pr, why: 'no unique commits; fully contained'} as BranchRow;
    expect(prDetail(row)).toBe('PR #42 is merged, into main');
  });

  test('no line when there is no PR, or when the verdict already names it', () => {
    expect(prDetail({pr: null, why: 'x'} as BranchRow)).toBeNull();
    expect(
      prDetail({
        pr: {...pr, state: 'OPEN'},
        why: '1 commit exists only here; PR #42 is open',
      } as BranchRow),
    ).toBeNull();
  });

  test('the rendered ledger shows it under the row', () => {
    const sb = sandbox();
    const primary = initPrimary(sb, {'README.md': 'x'});
    git(primary, ['branch', 'landed']);
    const report = buildReport({cwd: primary, prs: false, submodules: false});
    if (report?.branches == null) throw new Error('expected rows');
    const withPr: RepoStatusReport = {
      ...report,
      branches: report.branches.map((r) =>
        r.name === 'landed' ? {...r, pr} : r,
      ),
    };
    const text = renderReportPretty(withPr);
    expect(text).toMatch(/ {2}landed .*\n {6}PR #42 is merged, into main\n/u);
  });
});

describe('previews', () => {
  test('collapse whitespace and say how much was cut', () => {
    expect(preview('a\n\n  b', 400)).toBe('a b');
    expect(preview('abcdefghij', 4)).toBe('abcd… (+6 chars)');
    expect(preview('abcdefghij', 0)).toBe('abcdefghij');
  });
});
