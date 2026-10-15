/**
 * Sessions with no session bead on the dashboard (epic home-base-j8q3e.1
 * design D6; home-base-j8q3e.1.2). Two layers:
 *
 *  - PURE: `untrackedVerdict` over a fixture session — one test per evidence
 *    kind of D6 (unmerged branch, uncommitted files, working, out of context,
 *    an open blocking old-report question), the one-liner, and rule 10 for an
 *    unreadable checkout or a failed git call (critical rule 7).
 *  - END TO END: `readInbox` over real git repos under a fixture ~/Dev, real
 *    transcripts, a real session bead (br) and a fixture old-report export —
 *    discovery, exclusion of the tracked session, sessions outside the dev
 *    root, subagent transcripts, and the JSON.
 *
 * NEGATIVE CONTROLS: recorded in home-base-j8q3e.1.2's notes.
 */

import type {UntrackedSession} from '../src/thread/session-untracked';
import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, utimesSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {serializeMessageLine} from '../src/thread/message-log';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  inboxJson,
  type InboxRead,
  readInbox,
  renderInbox,
} from '../src/thread/session-inbox';
import {measured, unmeasured} from '../src/thread/session-model';
import {
  untrackedCard,
  untrackedLine,
  untrackedVerdict,
} from '../src/thread/session-untracked';
import {addLinkedWorktree, git, initRepo, write} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const t = (hhmm: string): string => `2030-01-01T${hhmm}:00.000Z`;

// ---------------------------------------------------------------------------
// Pure: the verdict
// ---------------------------------------------------------------------------

function fixture(over: Partial<UntrackedSession> = {}): UntrackedSession {
  return {
    checkout: '/dev/alpha',
    contextTokens: measured(40_000),
    firstMessage: 'Speed up the importer',
    firstMessageAt: t('09:00'),
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      defaultBranch: measured('main'),
      merged: measured('isDefault'),
      uncommitted: measured([]),
      unpushed: measured({kind: 'noUpstream'}),
    },
    lastActivityAt: measured(t('10:00')),
    lastMessage: 'thanks',
    lastReply: 'The importer now streams rows.',
    messagesFrom: 'transcript',
    oldReport: measured(null),
    repo: 'alpha',
    repoResolvedBy: 'git',
    repoRoot: '/dev/alpha',
    resume: "cd '/dev/alpha' && claude --resume s-1",
    scannedLastAt: t('10:00'),
    sessionId: 's-1',
    testDataMarker: false,
    transcriptPath: '/projects/-dev-alpha/s-1.jsonl',
    wrapUpAt: 150_000,
    ...over,
  };
}

const RESUME = "cd '/dev/alpha' && claude --resume s-1";

describe('D6 verdict: one line when nothing open is found', () => {
  test('a stopped session on a clean default branch is one line, "nothing open found"', () => {
    const session = fixture();
    const verdict = untrackedVerdict(session, NOW);
    expect(verdict).toEqual({
      action: {
        command: RESUME,
        rule: null,
        text: 'Read Claude\'s last reply: "The importer now streams rows."',
      },
      display: 'line',
      evidence: [],
      unmeasured: [],
    });
    const card = untrackedCard(session, verdict, NOW);
    expect(untrackedLine(card, session.firstMessage)).toBe(
      '❔ [ALPHA] Speed up the importer (2 hours ago) · nothing open found',
    );
    expect(card.section).toBe('notTracked');
  });

  test('open questions in its old report that are not blocking are not evidence', () => {
    const verdict = untrackedVerdict(
      fixture({
        oldReport: measured({
          blockingAsks: 0,
          openAsks: 3,
          threadId: 'th-1',
          title: 'Importer speed-up',
        }),
      }),
      NOW,
    );
    expect(verdict.display).toBe('line');
  });
});

describe('D6 verdict: a full card for each kind of evidence of open work', () => {
  test('a branch not merged into the default branch: full card, rule 6 merge', () => {
    const verdict = untrackedVerdict(
      fixture({
        git: {
          ...fixture().git,
          aheadOfDefault: measured(3),
          branch: measured('feature'),
          merged: measured('notMerged'),
        },
      }),
      NOW,
    );
    expect(verdict.display).toBe('card');
    expect(verdict.evidence).toEqual(['unmerged']);
    expect(verdict.action).toEqual({
      command: null,
      rule: 6,
      text: 'Land it: merge feature into main (3 commits)',
    });
  });

  test('uncommitted files in its checkout: full card, rule 6 commit', () => {
    const verdict = untrackedVerdict(
      fixture({
        git: {...fixture().git, uncommitted: measured(['a.ts', 'b.ts'])},
      }),
      NOW,
    );
    expect(verdict.display).toBe('card');
    expect(verdict.evidence).toEqual(['uncommitted']);
    expect(verdict.action).toEqual({
      command: null,
      rule: 6,
      text: 'Land it: commit the 2 uncommitted files on main',
    });
  });

  test('working now (last record a minute ago): full card, rule 2', () => {
    const verdict = untrackedVerdict(
      fixture({lastActivityAt: measured('2030-01-01T11:59:00.000Z')}),
      NOW,
    );
    expect(verdict.display).toBe('card');
    expect(verdict.evidence).toEqual(['working']);
    expect(verdict.action).toEqual({
      command: null,
      rule: 2,
      text: 'Nothing yet. Claude is working.',
    });
  });

  test('out of context (context at or above wrapUpAt): full card, rule 4', () => {
    const verdict = untrackedVerdict(
      fixture({contextTokens: measured(150_000)}),
      NOW,
    );
    expect(verdict.display).toBe('card');
    expect(verdict.evidence).toEqual(['outOfContext']);
    expect(verdict.action).toEqual({
      command: RESUME,
      rule: 4,
      text: 'Resume it and ask Claude for a handoff:',
    });
    // No threshold configured is a real answer: not out of context.
    expect(
      untrackedVerdict(
        fixture({contextTokens: measured(150_000), wrapUpAt: null}),
        NOW,
      ).display,
    ).toBe('line');
  });

  test('an open blocking question in its old report: full card, read the last reply', () => {
    const session = fixture({
      oldReport: measured({
        blockingAsks: 1,
        openAsks: 2,
        threadId: 'th-1',
        title: 'Importer speed-up',
      }),
    });
    const verdict = untrackedVerdict(session, NOW);
    expect(verdict.display).toBe('card');
    expect(verdict.evidence).toEqual(['blockingAsks']);
    expect(verdict.action.rule).toBeNull();
    expect(verdict.action.text).toBe(
      'Read Claude\'s last reply: "The importer now streams rows."',
    );
    const card = untrackedCard(session, verdict, NOW);
    expect(card.facts).toContainEqual({
      label: 'Old report',
      value: '2 open questions, 1 blocking (thread th-1)',
    });
    expect(card.title).toBe('Importer speed-up');
  });
});

describe('D6 verdict: what could not be measured is rule 10, never one line (critical rule 7)', () => {
  test('an unreadable checkout: full card, "Check it by hand" with the reason', () => {
    const reason = 'checkout unreadable: /dev/gone no longer exists';
    const session = fixture({
      git: {
        aheadOfDefault: unmeasured(reason),
        branch: unmeasured(reason),
        defaultBranch: unmeasured(reason),
        merged: unmeasured(reason),
        uncommitted: unmeasured(reason),
        unpushed: unmeasured(reason),
      },
    });
    const verdict = untrackedVerdict(session, NOW);
    expect(verdict.display).toBe('card');
    expect(verdict.unmeasured).toEqual([reason]);
    expect(verdict.action).toEqual({
      command: RESUME,
      rule: 10,
      text: `Check it by hand: ${reason}`,
    });
    expect(untrackedCard(session, verdict, NOW).facts).toEqual([
      {label: 'Checkout', value: '⚠️ /dev/gone no longer exists'},
    ]);
  });

  test('a failed git call: full card, rule 10', () => {
    const reason =
      'git merge-base --is-ancestor feature main exited 128: fatal: bad object';
    const verdict = untrackedVerdict(
      fixture({git: {...fixture().git, merged: unmeasured(reason)}}),
      NOW,
    );
    expect(verdict.display).toBe('card');
    expect(verdict.action.rule).toBe(10);
    expect(verdict.action.text).toContain('exited 128');
  });

  test('rule 10 comes before every other rule, working included', () => {
    const verdict = untrackedVerdict(
      fixture({
        git: {...fixture().git, uncommitted: unmeasured('git status failed')},
        lastActivityAt: measured('2030-01-01T11:59:00.000Z'),
      }),
      NOW,
    );
    expect(verdict.action.rule).toBe(10);
  });

  test('unknown last activity, or old reports that could not be read, are rule 10 too', () => {
    expect(
      untrackedVerdict(
        fixture({lastActivityAt: unmeasured('could not read the transcript')}),
        NOW,
      ).action.rule,
    ).toBe(10);
    expect(
      untrackedVerdict(
        fixture({oldReport: unmeasured('could not read issues.jsonl')}),
        NOW,
      ).action.rule,
    ).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// End to end: readInbox over a fixture ~/Dev
// ---------------------------------------------------------------------------

let sb: Sandbox;
let env: Record<string, string | undefined>;
let devRoot: string;
let alpha: string;
let beta: string;
let trunk: string;
let feature: string;
let goneWorktree: string;
let elsewhere: string;

function sid(n: number): string {
  return `2c0d0000-1111-4222-8333-${String(n).padStart(12, '0')}`;
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, text);
}

/** A transcript for session `n`, run in `cwd`, dated so the window holds it. */
function transcript(
  n: number,
  cwd: string,
  first: string,
  reply: string,
  lastAt: string,
): string {
  const id = sid(n);
  const path = join(
    sb.path,
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${id}.jsonl`,
  );
  writeFile(
    path,
    `${[
      {
        cwd,
        entrypoint: 'cli',
        message: {content: first, role: 'user'},
        sessionId: id,
        timestamp: t('09:00'),
        type: 'user',
        uuid: `${id}-u`,
      },
      {
        cwd,
        message: {
          content: [{text: reply, type: 'text'}],
          role: 'assistant',
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1000,
            input_tokens: 10,
          },
        },
        sessionId: id,
        timestamp: lastAt,
        type: 'assistant',
        uuid: `${id}-a`,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
  // Discovery skips a file whose mtime is older than the window (backfill's
  // pre-filter), and the window here is in 2030.
  utimesSync(path, NOW, NOW);
  return id;
}

beforeAll(() => {
  needBr();
  sb = createSandbox();
  devRoot = join(sb.path, 'Dev');
  const xdg = join(sb.path, 'xdg');
  writeFile(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(sb.path, 'threads'),
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  // A real repo commits `.claude/worktrees/` to .gitignore (home-base
  // CLAUDE.md); without it the linked worktrees below are untracked files of
  // alpha's main checkout.
  alpha = initRepo(sb, 'Dev/alpha', {
    '.gitignore': '.claude/worktrees/\n',
    'README.md': '# a\n',
  });
  beta = initRepo(sb, 'Dev/beta', {'README.md': '# b\n'});
  trunk = initRepo(sb, 'Dev/trunk', {'README.md': '# t\n'});
  git(trunk, ['branch', '-m', 'main', 'trunk']);
  elsewhere = initRepo(sb, 'elsewhere/probe', {'README.md': '# p\n'});
  feature = addLinkedWorktree(
    alpha,
    join(alpha, '.claude', 'worktrees', 'feature'),
    'feature',
  );
  write(feature, 'feature.ts', 'export const x = 1;\n');
  git(feature, ['add', '-A']);
  git(feature, ['commit', '-qm', 'feature work']);
  goneWorktree = addLinkedWorktree(
    alpha,
    join(alpha, '.claude', 'worktrees', 'gone'),
    'gone-branch',
  );
  write(beta, 'draft.md', 'not committed\n');
  const init = runBr(alpha, ['init', '--prefix', 'u', '-q']);
  if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);

  // 1 one line: alpha main, clean, stopped two hours ago
  transcript(
    1,
    alpha,
    'What does the importer do?',
    'It reads rows.',
    t('10:00'),
  );
  // 2 unmerged: the feature worktree, one commit main lacks
  transcript(2, feature, 'Build the feature', 'Built it.', t('09:30'));
  // 3 uncommitted: beta has a file not committed; its message log says more
  const s3 = transcript(3, beta, 'Draft the notes', 'Drafted.', t('09:20'));
  writeFile(
    messageLogPath(s3, env),
    [
      serializeMessageLine({
        at: t('09:00'),
        cwd: beta,
        event: 'UserPromptSubmit',
        role: 'user',
        text: 'Draft the release notes (from the log)',
      }),
      serializeMessageLine({
        at: t('09:20'),
        cwd: beta,
        event: 'Stop',
        role: 'assistant',
        text: 'Drafted them in draft.md.',
      }),
    ].join(''),
  );
  // 4 working: alpha main, last record a minute ago
  transcript(4, alpha, 'Refactor the parser', 'Working on it.', t('11:59'));
  // 5 blocking old-report question: alpha main, clean
  const s5 = transcript(5, alpha, 'Pick a bucket', 'Which bucket?', t('08:00'));
  writeFile(
    join(sb.path, 'threads', '.beads', 'issues.jsonl'),
    `${[
      {
        id: 'th-1',
        issue_type: 'thread',
        metadata: {sessionId: s5},
        status: 'open',
        title: 'Export bucket choice',
      },
      {
        dependencies: [
          {depends_on_id: 'th-1', issue_id: 'th-1.1', type: 'parent-child'},
        ],
        id: 'th-1.1',
        issue_type: 'ask',
        metadata: {priority: 0, threadId: 'th-1'},
        priority: 0,
        status: 'open',
        title: 'Which bucket?',
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`,
  );
  // 6 unreadable checkout: its worktree was removed after it ran
  transcript(6, goneWorktree, 'Try the gone idea', 'Tried.', t('07:00'));
  rmSync(goneWorktree, {force: true, recursive: true});
  // 7 failed git measurement: trunk has no main and no origin/HEAD
  transcript(7, trunk, 'Tidy the trunk repo', 'Tidied.', t('06:00'));
  // 8 outside the dev root (a test probe in a temp directory)
  transcript(8, elsewhere, 'Probe something', 'Probed.', t('05:00'));
  // 9 tracked: a session bead in the index, so never Not tracked
  const s9 = transcript(9, alpha, 'Tracked work', 'Done.', t('04:00'));
  const filed = ensureSessionBead({
    cwd: alpha,
    env: {...env, CLAUDE_CODE_SESSION_ID: s9},
    firstPrompt: {at: t('04:00'), text: 'Tracked work'},
    now: new Date(t('04:00')),
    sessionId: s9,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  // 10 a subagent of session 1: never a session of its own
  const subagent = join(
    sb.path,
    'projects',
    alpha.replace(/[^a-zA-Z0-9]/g, '-'),
    sid(1),
    'subagents',
    'agent-abc.jsonl',
  );
  writeFile(
    subagent,
    `${JSON.stringify({
      cwd: alpha,
      isSidechain: true,
      message: {content: 'Subagent prompt', role: 'user'},
      sessionId: sid(1),
      timestamp: t('09:59'),
      type: 'user',
    })}\n`,
  );
  utimesSync(subagent, NOW, NOW);
});

afterAll(() => {
  sb.cleanup();
});

async function read(): Promise<InboxRead> {
  const result = await readInbox({
    cwd: alpha,
    days: 30,
    devRoot,
    env,
    now: NOW,
    repo: null,
  });
  if (result.kind !== 'read') throw new Error(result.reason);
  return result.read;
}

function rowOf(r: InboxRead, n: number) {
  return r.rows.filter((row) => row.sessionId === sid(n));
}

describe('thread inbox lists every session under the dev root (D6, end to end)', () => {
  test('each untracked session is listed once, under Not tracked, as a card or one line by its evidence', async () => {
    const r = await read();
    const shape = (n: number) =>
      rowOf(r, n).map((row) => ({
        display: row.display,
        evidence: row.untracked?.verdict.evidence ?? null,
        rule: row.card.action.rule,
        section: row.section,
        tracked: row.tracked,
      }));
    expect({
      blocking: shape(5),
      failedGit: shape(7),
      gone: shape(6),
      oneLine: shape(1),
      uncommitted: shape(3),
      unmerged: shape(2),
      working: shape(4),
    }).toEqual({
      blocking: [
        {
          display: 'card',
          evidence: ['blockingAsks'],
          rule: null,
          section: 'notTracked',
          tracked: false,
        },
      ],
      failedGit: [
        {
          display: 'card',
          evidence: [],
          rule: 10,
          section: 'notTracked',
          tracked: false,
        },
      ],
      gone: [
        {
          display: 'card',
          evidence: [],
          rule: 10,
          section: 'notTracked',
          tracked: false,
        },
      ],
      oneLine: [
        {
          display: 'line',
          evidence: [],
          rule: null,
          section: 'notTracked',
          tracked: false,
        },
      ],
      uncommitted: [
        {
          display: 'card',
          evidence: ['uncommitted'],
          rule: 6,
          section: 'notTracked',
          tracked: false,
        },
      ],
      unmerged: [
        {
          display: 'card',
          evidence: ['unmerged'],
          rule: 6,
          section: 'notTracked',
          tracked: false,
        },
      ],
      working: [
        {
          display: 'card',
          evidence: ['working'],
          rule: 2,
          section: 'notTracked',
          tracked: false,
        },
      ],
    });
  });

  test('the words: rule 6 names the branch and commits, rule 10 the reason, and the message log wins over the transcript', async () => {
    const r = await read();
    expect(rowOf(r, 2)[0]?.card.action.text).toBe(
      'Land it: merge feature into main (1 commit)',
    );
    expect(rowOf(r, 6)[0]?.card.action.text).toMatch(
      /^Check it by hand: checkout unreadable: .*\/Dev\/alpha\/\.claude\/worktrees\/gone no longer exists$/,
    );
    expect(rowOf(r, 7)[0]?.card.action.text).toContain('no default branch');
    expect(rowOf(r, 3)[0]?.card.youAsked).toEqual({
      firstMessage: 'Draft the release notes (from the log)',
      kind: 'untracked',
    });
    expect(rowOf(r, 3)[0]?.untracked?.session.messagesFrom).toBe('messageLog');
    expect(rowOf(r, 6)[0]?.repo).toBe('alpha');
    expect(rowOf(r, 2)[0]?.repo).toBe('alpha');
  });

  test('a session with a session bead appears once, tracked, never under Not tracked', async () => {
    const r = await read();
    const rows = rowOf(r, 9);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tracked).toBe(true);
    expect(rows[0]?.section).not.toBe('notTracked');
  });

  test('a session outside the dev root is not listed but counted; a subagent transcript is never a session', async () => {
    const r = await read();
    expect(rowOf(r, 8)).toHaveLength(0);
    expect(r.untracked.outsideRoot).toEqual({directories: 1, sessions: 1});
    expect(rowOf(r, 1)).toHaveLength(1);
    expect(
      r.rows.filter(
        (row) =>
          row.untracked?.session.transcriptPath.includes('/subagents/') ===
          true,
      ),
    ).toEqual([]);
    expect(r.rows.map((row) => row.sessionId).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 9].map(sid).sort(),
    );
  });

  test('--json carries tracked false, the display, the evidence and the facts', async () => {
    const r = await read();
    const json = inboxJson(r) as {
      sessions: Record<string, unknown>[];
      untracked: {oldReports: unknown; outsideRoot: unknown};
    };
    const one = json.sessions.find((entry) => entry.sessionId === sid(1));
    expect(one).toMatchObject({
      display: 'line',
      section: 'notTracked',
      sessionBeadId: null,
      tracked: false,
      untracked: {
        checkout: alpha,
        evidence: [],
        firstMessage: 'What does the importer do?',
        lastReply: 'It reads rows.',
        line: '❔ [ALPHA] What does the importer do? (2 hours ago) · nothing open found',
        messagesFrom: 'transcript',
        oldReport: {ok: true, value: null},
        repo: 'alpha',
        repoRoot: alpha,
        unmeasured: [],
      },
    });
    expect(
      json.sessions.find((entry) => entry.sessionId === sid(9))?.tracked,
    ).toBe(true);
    expect(json.untracked.oldReports).toMatchObject({
      corrupt: [],
      kind: 'read',
      sessions: 1,
    });
  });

  test('the printed inbox counts Not tracked in the summary and prints the one-liner', async () => {
    const r = await read();
    const text = renderInbox(r, {
      all: false,
      days: 30,
      now: NOW,
      order: 'recent',
      style: PLAIN_STYLE,
      timeZone: 'UTC',
    });
    expect(text).toContain(
      '- **❔ Not tracked:** 7 (6 with something open or unreadable, 1 with nothing open found)',
    );
    expect(text).toContain(
      '❔ [ALPHA] What does the importer do? (2 hours ago) · nothing open found',
    );
    expect(text).toContain(
      'outside <dev> is not listed'.replace(
        '<dev>',
        devRoot.replace(process.env.HOME ?? '', '~'),
      ),
    );
  });
});
