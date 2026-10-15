/**
 * Status report v4, dispatch 3 (home-base-vzwbj.4.3): the session model, the
 * derived status, stages, `thread status`, `thread show` and Part 1.
 *
 * Like dispatches 1 and 2, everything that touches beads runs the REAL `br`
 * in throwaway workspaces under $TMPDIR, and `needBr()` THROWS when br is
 * missing — no silent pass. Times are pinned: every fixture lives on
 * 2030-01-01 (UTC), its commits carry 2030 dates through GIT_*_DATE, and the
 * renderer is given `now` and `timeZone: 'UTC'`, so the snapshots cannot drift
 * with the wall clock. Bead ids are random per run, so snapshots replace the
 * session bead's id (and every child id built on it) with `t-SESS`, and the
 * sandbox path with `<sandbox>`.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.3's notes.
 */

import type {MergeState} from '../src/thread/session-model';
import type {
  CommitsFact,
  SessionStatus,
  StatusFacts,
} from '../src/thread/session-status';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brClose, brCreate, brShow, runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {
  type MessageLine,
  serializeMessageLine,
} from '../src/thread/message-log';
import {
  COMMIT_EXAMPLE_CUT,
  PART_ONE_RULE,
  PART_ONE_SEPARATOR,
  partOneView,
  renderPartOne,
  statusWords,
  stripPastedPartOne,
} from '../src/thread/part-one';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {sectionFor} from '../src/thread/session-card';
import {loadSession, measured, unmeasured} from '../src/thread/session-model';
import {
  cutMessage,
  loadSessionReport,
  renderSessionShow,
  renderThreadStatus,
  routesToLegacyThread,
  USER_MESSAGE_CUT,
} from '../src/thread/session-report';
import {describeStageOutcome, markStage} from '../src/thread/session-stage';
import {
  deriveStatus,
  stageReached,
  whatToMark,
} from '../src/thread/session-status';
import {createFakeBd} from './fake-bd';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';
import {bashCallRecords} from './transcript-records';

const SESSION = '5e551011-cccc-4ddd-8eee-0123456789ab';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const ON = {enabled: true, sessionBeads: true};
const TZ = 'UTC';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function at(hhmm: string): string {
  return `2030-01-01T${hhmm}:00.000Z`;
}

/** git with pinned author and committer dates. */
function gitAt(cwd: string, args: string[], when: string): void {
  execFileSync('git', args, {
    cwd,
    env: {...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface World {
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
  sessionBead: string;
}

/** A state dir, the knobs, a beads repo, and this session's bead filed in it. */
function world(
  options: {
    cmux?: boolean;
    /** The first prompt the session bead is titled from (D1 placeholder). */
    firstPrompt?: string;
    knobs?: Record<string, unknown>;
    name?: string;
  } = {},
): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: options.knobs ?? ON}}),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID:
      options.cmux === true
        ? 'A1B2C3D4-0000-4000-8000-00000000000S'
        : undefined,
    CMUX_WORKSPACE_ID:
      options.cmux === true
        ? 'A1B2C3D4-0000-4000-8000-00000000000W'
        : undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, options.name ?? 'export-repo', {
    'README.md': '# export\n',
  });
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {
      at: at('09:00'),
      text: options.firstPrompt ?? 'Look at the export',
    },
    now: new Date(at('09:00')),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') {
    throw new Error(`session bead not filed: ${filed.detail}`);
  }
  return {env, repo, sb, sessionBead: filed.beadId};
}

function writeLog(w: World, lines: MessageLine[]): void {
  const path = messageLogPath(SESSION, w.env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, lines.map(serializeMessageLine).join(''));
}

function user(when: string, cwd: string, text: string): MessageLine {
  return {at: at(when), cwd, event: 'UserPromptSubmit', role: 'user', text};
}

function claude(when: string, cwd: string, text: string): MessageLine {
  return {at: at(when), cwd, event: 'Stop', role: 'assistant', text};
}

/**
 * A transcript whose last record is at `last`, carrying `tokens` of context;
 * `between` records (Bash calls, say) go between its first and last record.
 */
function writeTranscript(
  w: World,
  cwd: string,
  last: string,
  tokens: number,
  between: object[] = [],
): void {
  const dir = join(w.sb.path, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, {recursive: true});
  const records = [
    {
      cwd,
      entrypoint: 'cli',
      message: {content: 'hello', role: 'user'},
      sessionId: SESSION,
      timestamp: at('09:00'),
      type: 'user',
    },
    ...between,
    {
      cwd,
      message: {
        model: 'claude-opus-5',
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: tokens - 100,
          input_tokens: 100,
        },
      },
      sessionId: SESSION,
      timestamp: at(last),
      type: 'assistant',
    },
  ];
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

function normalize(text: string, w: World): string {
  return text
    .split(w.sb.path)
    .join('<sandbox>')
    .split(w.sessionBead)
    .join('t-SESS');
}

// eslint-disable-next-line no-control-regex -- matching the ANSI escape byte is the point
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The ONE sanctioned ` · `: the ask renderer's badge line, `1. 🛑 P0 · …`
 * (home-base-vzwbj.4.3 brief). Every other line joining fields with ` · ` is
 * the long row Justin rejected ("Do NOT lay things out in long rows").
 */
const ASK_BADGE_LINE = /^\s*\d+\. \S+ P[0-4?] · /u;

function dotRows(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => line.includes(' · ') && !ASK_BADGE_LINE.test(line));
}

async function report(
  w: World,
  asIfYielded: boolean,
  selector: string | null = null,
) {
  const load = await loadSessionReport({
    asIfYielded,
    cwd: w.repo,
    env: w.env,
    now: NOW,
    selector,
    sessionId: null,
  });
  if (load.kind !== 'loaded') {
    throw new Error(`not loaded: ${JSON.stringify(load)}`);
  }
  return load;
}

/**
 * Part 1, rendered. ANSI wraps at 100 columns, except where a fixture prints
 * sandbox paths: those vary in length per run, so wrapping them would make
 * the line breaks — and the snapshot — differ from run to run (`wrap: false`).
 */
function partOne(
  load: Awaited<ReturnType<typeof report>>,
  color: boolean,
  wrap = true,
): string {
  return renderPartOne(
    partOneView({
      action: load.action,
      counts: load.counts,
      model: load.model,
      now: NOW,
      optional: load.optional,
      status: load.status,
      timeZone: TZ,
    }),
    color ? {color: true, width: wrap ? 100 : null} : PLAIN_STYLE,
  );
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/** A question, an answer, nothing else: no request, no commit, clean tree. */
function questionOnly(): World {
  const w = world({
    firstPrompt: 'What does the nightly export do with deleted rows?',
    name: 'question-repo',
  });
  writeLog(w, [
    user('09:00', w.repo, 'What does the nightly export do with deleted rows?'),
    claude(
      '09:05',
      w.repo,
      'It skips them: the query filters on deleted_at IS NULL.',
    ),
  ]);
  writeTranscript(w, w.repo, '09:05', 41_200);
  return w;
}

interface WorkWorld extends World {
  children: {index: string; profile: string};
  p0: string;
  p3: string;
  request1: string;
  request2: string;
  worktree: string;
}

/**
 * A work session: two requests (one with stages and two children, one with a
 * P0 question under it), a P3 question, two commits in a linked worktree that
 * is not merged, one uncommitted file, and cmux ids on the session bead.
 */
async function workSession(): Promise<WorkWorld> {
  const w = world({
    cmux: true,
    firstPrompt:
      'Make the nightly export twice as fast, and write a runbook for it.',
    name: 'work-repo',
  });
  const worktree = join(w.repo, '.claude', 'worktrees', 'export');
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'feature/export', worktree, 'main'],
    {
      cwd: w.repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  writeFileSync(join(worktree, 'export.ts'), 'export const v = 1;\n');
  gitAt(worktree, ['add', 'export.ts'], at('10:00'));
  gitAt(worktree, ['commit', '-qm', 'feat: faster export'], at('10:00'));
  writeFileSync(join(worktree, 'export.ts'), 'export const v = 2;\n');
  gitAt(worktree, ['commit', '-qam', 'feat: batch the export'], at('10:30'));
  writeFileSync(join(worktree, 'RUNBOOK.md'), '# draft\n');

  const base = {cwd: w.repo, env: w.env, now: NOW, sessionId: null};
  const r1 = await fileRequest({
    ...base,
    bead: null,
    doneWhen: null,
    here: false,
    title: 'Make the nightly export twice as fast',
  });
  const r2 = await fileRequest({
    ...base,
    bead: null,
    doneWhen: null,
    here: false,
    title: 'Write the export runbook',
  });
  if (r1.kind !== 'filed' || r2.kind !== 'filed')
    throw new Error('requests not filed');
  const profile = brCreate(
    {cwd: w.repo},
    {parent: r1.id, title: 'Profile the slow query', type: 'task'},
  );
  const index = brCreate(
    {cwd: w.repo},
    {parent: r1.id, title: 'Add the missing index', type: 'task'},
  );
  if (profile.kind !== 'ok' || index.kind !== 'ok')
    throw new Error('children not filed');
  const closed = brClose({cwd: w.repo}, profile.id, 'done');
  if (closed.kind !== 'ok') throw new Error('child not closed');
  const staged = await markStage({
    cwd: w.repo,
    env: w.env,
    request: r1.id,
    sessionId: null,
    stages: ['code-done', 'tested'],
    unset: false,
  });
  if (staged.kind !== 'marked')
    throw new Error(`stage not marked: ${staged.kind}`);
  const askBase = {
    approve: false,
    cwd: w.repo,
    do: false,
    env: w.env,
    header: null,
    recommend: null,
    sessionId: null,
  };
  const p0 = await fileAsk({
    ...askBase,
    context: ['The runbook has to name the bucket the export writes to.'],
    default: null,
    options: [
      'exports-prod: the bucket the cron job uses',
      'exports-archive: the older bucket',
    ],
    priority: '0',
    question: 'Which S3 bucket should the runbook point at?',
    recommend: 'a',
    to: r2.id,
  });
  const p3 = await fileAsk({
    ...askBase,
    context: ['Compressed files are a third of the size.'],
    default: 'I leave the output uncompressed.',
    options: [],
    priority: '3',
    question: 'Should the export also gzip its output?',
    to: r1.id,
  });
  if (p0.kind !== 'filed' || p3.kind !== 'filed')
    throw new Error(`asks not filed: ${p0.kind} ${p3.kind}`);

  writeLog(w, [
    user(
      '09:00',
      w.repo,
      'Make the nightly export twice as fast, and write a runbook for it.\nUse the worktree.',
    ),
    claude('09:40', worktree, 'Started on the export.'),
    user('10:50', worktree, 'keep going'),
    claude(
      '11:30',
      worktree,
      `${PART_ONE_RULE}\n\n**Session:** [WORK-REPO] stale pasted copy\n\n${PART_ONE_SEPARATOR}\n\n- The export is batched; the runbook waits on the bucket question.`,
    ),
  ]);
  // The session's two commits, as its transcript records them: the first with
  // -q (no confirmation line — attributed by its commit window), the second
  // printing git's `[branch sha] subject` line.
  const second = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: worktree,
    encoding: 'utf8',
  }).trim();
  writeTranscript(w, worktree, '11:30', 312_400, [
    ...bashCallRecords({
      at: '2030-01-01T09:59:59.000Z',
      command: "git commit -qm 'feat: faster export'",
      cwd: worktree,
      endAt: '2030-01-01T10:00:01.000Z',
      id: 'toolu_commit_1',
      output: '',
      sessionId: SESSION,
    }),
    ...bashCallRecords({
      at: '2030-01-01T10:29:58.000Z',
      command: "git commit -am 'feat: batch the export'",
      cwd: worktree,
      endAt: '2030-01-01T10:30:02.000Z',
      id: 'toolu_commit_2',
      output: `[feature/export ${second}] feat: batch the export\n 1 file changed, 1 insertion(+), 1 deletion(-)`,
      sessionId: SESSION,
    }),
  ]);
  return {
    ...w,
    children: {index: index.id, profile: profile.id},
    p0: p0.id,
    p3: p3.id,
    request1: r1.id,
    request2: r2.id,
    worktree,
  };
}

/** A session whose checkout (and the beads in it) has been deleted. */
function unreadableCheckout(): World {
  const w = world({
    firstPrompt: 'Clean up the old export cron entries.',
    name: 'gone-repo',
  });
  writeLog(w, [
    user('09:00', w.repo, 'Clean up the old export cron entries.'),
    claude(
      '09:20',
      w.repo,
      'Removed two entries; one is left for you to check.',
    ),
  ]);
  writeTranscript(w, w.repo, '09:20', 88_000);
  rmSync(w.repo, {force: true, recursive: true});
  return w;
}

/**
 * F14 (home-base-vzwbj.4.9): a session whose transcript holds 14 `git commit`
 * commands that matched no commit in this checkout (they committed in another
 * one) and a release script whose output carries 2 confirmation lines from
 * another checkout — the conductor's real session, in miniature.
 */
function commitsElsewhere(): World {
  const w = world({
    firstPrompt: 'Tidy the release scripts in the other checkout.',
    name: 'commits-repo',
  });
  writeLog(w, [
    user('09:00', w.repo, 'Tidy the release scripts in the other checkout.'),
    claude('09:40', w.repo, 'Tidied; the commits are in the other checkout.'),
  ]);
  const calls = Array.from({length: 14}, (_, index) => {
    const minute = String(index + 10).padStart(2, '0');
    return bashCallRecords({
      at: `2030-01-01T09:${minute}:00.000Z`,
      command: `git -C ../the-release-checkout commit -qm "script ${index + 1}: drop the unused flags and the dead branches"`,
      cwd: w.repo,
      endAt: `2030-01-01T09:${minute}:02.000Z`,
      id: `toolu_elsewhere_${index + 1}`,
      output: '',
      sessionId: SESSION,
    });
  }).flat();
  writeTranscript(w, w.repo, '09:40', 52_000, [
    ...calls,
    ...bashCallRecords({
      at: '2030-01-01T09:30:00.000Z',
      command: 'bun run release',
      cwd: w.repo,
      endAt: '2030-01-01T09:30:05.000Z',
      id: 'toolu_release',
      output:
        '[main 1a2b3c4] release: v1.2.3\n[main 5d6e7f8] release: tag v1.2.3',
      sessionId: SESSION,
    }),
  ]);
  return w;
}

// ---------------------------------------------------------------------------
// deriveStatus: the D2 precedence, one row per branch
// ---------------------------------------------------------------------------

describe('deriveStatus follows epic D2 exactly', () => {
  const counted = (count: number): CommitsFact => ({count, kind: 'counted'});
  const commitsUnmeasured = (reason: string): CommitsFact => ({
    kind: 'unmeasured',
    reason,
  });
  /** An open request, nothing else: ⚠️ open work. Each row flips from here. */
  const BASE: StatusFacts = {
    beadProblems: [],
    commits: counted(0),
    contextTokens: 100_000,
    handedOff: false,
    lastMessageRole: 'assistant',
    lastRecordAt: at('11:00'),
    merged: measured<MergeState>('merged'),
    openP0: 0,
    requests: {closed: 0, total: 1},
    sessionCloseReason: null,
    successor: null,
    uncommitted: measured(0),
    wrapUpAt: 470_000,
  };
  const live = {asIfYielded: false, now: NOW};
  const yielded = {asIfYielded: true, now: NOW};
  const noRequest = {requests: {closed: 0, total: 0}};

  const rows: [
    string,
    Partial<StatusFacts>,
    typeof live,
    SessionStatus['kind'],
  ][] = [
    ['the baseline: an open request is open work', {}, live, 'openWork'],
    ['an open P0 is waiting on you', {openP0: 1}, live, 'waiting'],
    [
      'an open P0 beats working, handed off, out of context and done',
      {
        contextTokens: 900_000,
        handedOff: true,
        lastRecordAt: at('11:59'),
        openP0: 2,
        requests: {closed: 1, total: 1},
        sessionCloseReason: 'done: Justin',
      },
      live,
      'waiting',
    ],
    [
      'a record 1 minute old is working',
      {lastRecordAt: at('11:59')},
      live,
      'working',
    ],
    [
      'a record 4 minutes old is not working',
      {lastRecordAt: at('11:56')},
      live,
      'openWork',
    ],
    [
      'as-if-yielded never says working',
      {lastRecordAt: at('11:59')},
      yielded,
      'openWork',
    ],
    [
      'working beats handed off',
      {handedOff: true, lastRecordAt: at('11:59')},
      live,
      'working',
    ],
    [
      'the handed-off label is handed off',
      {handedOff: true},
      live,
      'handedOff',
    ],
    [
      'handed off beats out of context',
      {contextTokens: 900_000, handedOff: true},
      live,
      'handedOff',
    ],
    [
      'tokens at wrapUpAt are out of context',
      {contextTokens: 470_000},
      live,
      'outOfContext',
    ],
    [
      'tokens below wrapUpAt are not',
      {contextTokens: 469_999},
      live,
      'openWork',
    ],
    [
      'no wrapUpAt configured is never out of context',
      {contextTokens: 900_000, wrapUpAt: null},
      live,
      'openWork',
    ],
    [
      'out of context beats done',
      {contextTokens: 500_000, requests: {closed: 1, total: 1}},
      live,
      'outOfContext',
    ],
    [
      'every request closed is done',
      {requests: {closed: 2, total: 2}},
      live,
      'done',
    ],
    [
      'some requests open is not done',
      {requests: {closed: 1, total: 2}},
      live,
      'openWork',
    ],
    [
      'Justin ran thread done: done',
      {sessionCloseReason: 'done: Justin — shipped'},
      live,
      'done',
    ],
    [
      'Justin archived it: done (this dispatch’s decision)',
      {sessionCloseReason: 'archived: not needed'},
      live,
      'done',
    ],
    [
      'closed by someone else is not Justin’s mark',
      {sessionCloseReason: 'closed by a script'},
      live,
      'openWork',
    ],
    [
      'requests all closed but a beads export unreadable: unknown, never done',
      {
        beadProblems: ['could not read /x/.beads/issues.jsonl'],
        requests: {closed: 1, total: 1},
      },
      live,
      'unknown',
    ],
    [
      'no request, Claude last, no commits, clean: answered',
      noRequest,
      live,
      'answered',
    ],
    [
      'no request but the last line is Justin’s: open work',
      {...noRequest, lastMessageRole: 'user'},
      live,
      'openWork',
    ],
    [
      'as-if-yielded counts Claude’s coming yield as the last line',
      {...noRequest, lastMessageRole: 'user'},
      yielded,
      'answered',
    ],
    [
      'no request + commits unmeasurable: unknown, never answered',
      {...noRequest, commits: commitsUnmeasured('checkout unreadable: /gone')},
      live,
      'unknown',
    ],
    [
      'no request + tree unmeasurable: unknown, never answered',
      {...noRequest, uncommitted: unmeasured('git status failed')},
      live,
      'unknown',
    ],
    [
      'no request + a dirty tree (ignoring .beads): open work',
      {...noRequest, uncommitted: measured(2)},
      live,
      'openWork',
    ],
    [
      'no request + 3 commits: open work',
      {...noRequest, commits: counted(3)},
      live,
      'openWork',
    ],
    [
      'no request + a beads export unreadable: unknown',
      {...noRequest, beadProblems: ['could not read x']},
      live,
      'unknown',
    ],
    // R2 (home-base-vzwbj.4.9): ✅ Done by requests needs the work landed.
    [
      'R2: requests all closed, merged, clean: done',
      {merged: measured<MergeState>('merged'), requests: {closed: 1, total: 1}},
      live,
      'done',
    ],
    [
      'R2: requests all closed on the default branch itself, clean: done',
      {
        merged: measured<MergeState>('isDefault'),
        requests: {closed: 1, total: 1},
      },
      live,
      'done',
    ],
    [
      'R2: requests all closed but the branch is not merged: done, not merged',
      {
        merged: measured<MergeState>('notMerged'),
        requests: {closed: 1, total: 1},
      },
      live,
      'doneUnmerged',
    ],
    [
      'R2: requests all closed, merged, but a dirty tree: done, not merged',
      {requests: {closed: 1, total: 1}, uncommitted: measured(2)},
      live,
      'doneUnmerged',
    ],
    [
      'R2: requests all closed, the merge state unmeasured: unknown, never done',
      {
        merged: unmeasured<MergeState>('checkout unreadable: /gone'),
        requests: {closed: 1, total: 1},
      },
      live,
      'unknown',
    ],
    [
      'R2: requests all closed, the tree unmeasured: unknown, never done',
      {
        requests: {closed: 1, total: 1},
        uncommitted: unmeasured<number>('git status failed'),
      },
      live,
      'unknown',
    ],
    [
      'R2: Justin marked it done on an unmerged, dirty branch: done (his mark wins)',
      {
        merged: measured<MergeState>('notMerged'),
        requests: {closed: 0, total: 1},
        sessionCloseReason: 'done: Justin',
        uncommitted: measured(3),
      },
      live,
      'done',
    ],
    // R3 (home-base-vzwbj.4.9): a partial commit count is never zero.
    [
      'R3: no request + a PARTIAL commit count (a commit command matched no commit here): open work, never answered',
      {...noRequest, commits: {kind: 'partial', matched: 0, unmatched: 1}},
      live,
      'openWork',
    ],
    [
      'an open request + an unreadable checkout: unknown (unknown precedes open work)',
      {commits: commitsUnmeasured('checkout unreadable: /gone')},
      live,
      'unknown',
    ],
  ];

  for (const [name, overrides, options, expected] of rows) {
    test(name, () => {
      expect(deriveStatus({...BASE, ...overrides}, options).kind).toBe(
        expected,
      );
    });
  }

  test('R2: done, not merged says which of merged and clean is missing, in the words and the You line', () => {
    const both = deriveStatus(
      {
        ...BASE,
        merged: measured<MergeState>('notMerged'),
        requests: {closed: 1, total: 1},
        uncommitted: measured(2),
      },
      live,
    );
    expect(both).toEqual({
      kind: 'doneUnmerged',
      notMerged: true,
      uncommitted: 2,
    });
    expect(statusWords(both)).toBe(
      '🔀 Done, not merged — every request is closed, but the branch is not merged into the default branch and 2 uncommitted paths',
    );
    const dirtyOnly = deriveStatus(
      {...BASE, requests: {closed: 1, total: 1}, uncommitted: measured(1)},
      live,
    );
    expect(statusWords(dirtyOnly)).toBe(
      '🔀 Done, not merged — every request is closed, but 1 uncommitted path',
    );
    // home-base-j8q3e.1 D3 rule 6 / D5: never hidden under Done — To land.
    expect(sectionFor(6, both, null)).toBe('toLand');
    expect(
      statusWords(
        deriveStatus(
          {
            ...BASE,
            merged: measured<MergeState>('notMerged'),
            sessionCloseReason: 'done: Justin',
          },
          live,
        ),
      ),
    ).toBe('✅ Done — done: Justin');
  });

  test('unknown names every unmeasurable path', () => {
    const status = deriveStatus(
      {
        ...BASE,
        ...noRequest,
        commits: commitsUnmeasured('checkout unreadable: /gone'),
        uncommitted: unmeasured('checkout unreadable: /gone'),
      },
      live,
    );
    expect(status).toEqual({
      kind: 'unknown',
      reasons: ['checkout unreadable: /gone'],
    });
  });
});

describe('stageReached', () => {
  const ladder = ['code-done', 'tested', 'built', 'link-sent', 'approved'];
  test('the highest rung marked, and the next', () => {
    expect(
      stageReached(['stage:code-done', 'stage:built', 'request'], ladder),
    ).toEqual({next: 'link-sent', reached: 'built'});
  });
  test('the last rung has no next', () => {
    expect(stageReached(['stage:approved'], ladder)).toEqual({
      next: null,
      reached: 'approved',
    });
  });
  test('no stage label, or only one off the ladder, is null', () => {
    expect(stageReached(['request'], ladder)).toBeNull();
    expect(stageReached(['stage:shipped'], ladder)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The model and Part 1, against real br, git, a log and a transcript
// ---------------------------------------------------------------------------

describe('fixture 1: a question-only session', () => {
  test('the model: no request, no commit, clean tree, Claude last → 💬 answered', async () => {
    const w = questionOnly();
    const load = await report(w, false);
    expect(load.model.beads.requests).toEqual([]);
    expect(load.model.git.commits).toEqual(
      measured({
        count: 0,
        shas: [],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: [],
      }),
    );
    // br init's .beads/ is untracked and is the ONLY thing git sees: excluded.
    expect(load.model.git.uncommitted).toEqual(measured([]));
    expect(load.model.transcript.contextTokens).toEqual(measured(41_200));
    expect(load.status).toEqual({kind: 'answered'});
    expect(whatToMark(load.model, load.status)).toEqual([]);
  });

  test('Part 1 snapshot, markdown and ANSI', async () => {
    const w = questionOnly();
    const load = await report(w, false);
    const markdown = normalize(partOne(load, false), w);
    const ansi = normalize(partOne(load, true), w);
    expect(markdown).toMatchSnapshot();
    expect(ansi).toMatchSnapshot();
    expect(dotRows(markdown)).toEqual([]);
    expect(dotRows(ansi)).toEqual([]);
    expect(markdown).not.toContain('Requests:');
    expect(markdown).not.toContain('Questions for you:');
  });

  test('thread status: Part 1, "Nothing to mark.", the verdict', async () => {
    const w = questionOnly();
    const load = await report(w, true);
    const out = renderThreadStatus(load, {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out.split('\n')[0]).toBe('SESSION BEADS: ENABLED');
    expect(out).toContain(PART_ONE_RULE);
    expect(out).toContain('\n\nNothing to mark.\n\n');
    expect(out).not.toContain('What to mark');
    expect(out.trimEnd().split('\n').at(-1)).toBe(
      'If you stop now the inbox will say: 💬 Answered',
    );
  });
});

describe('fixture 2: a work session with two requests, stages, a P0 and a P3', () => {
  test('the model reads the whole tree from the export', async () => {
    const w = await workSession();
    const load = await report(w, false);
    const {beads, git} = load.model;
    expect(beads.requests.map((node) => node.request.id)).toEqual([
      w.request1,
      w.request2,
    ]);
    expect(
      beads.requests[0]?.children.map((child) => [child.id, child.status]),
    ).toEqual([
      [w.children.profile, 'closed'],
      [w.children.index, 'open'],
    ]);
    expect(beads.requests[1]?.questions.map((q) => q.id)).toEqual([w.p0]);
    expect(beads.questions.map((q) => q.id).sort()).toEqual(
      [w.p0, w.p3].sort(),
    );
    // Measured in the WORKTREE (the log's newest cwd), not the main checkout.
    expect(git.checkoutSource).toBe('logCwd');
    expect(git.branch).toEqual(measured('feature/export'));
    expect(git.merged).toEqual(measured('notMerged'));
    expect(git.worktree).toEqual(
      measured({kind: 'linked', path: '.claude/worktrees/export'}),
    );
    // Both commits come from the transcript (home-base-vzwbj.4.4 item 4):
    // the -q one by its commit window, the other by git's confirmation line.
    expect(git.commits.ok && git.commits.value.source).toBe('transcript');
    expect(git.commits.ok && git.commits.value.count).toBe(2);
    expect(git.uncommitted).toEqual(measured(['RUNBOOK.md']));
    expect(git.unpushed).toEqual(measured({kind: 'noUpstream'}));
    expect(load.model.cmux.workspace).toBe(
      'A1B2C3D4-0000-4000-8000-00000000000W',
    );
    expect(load.status).toEqual({kind: 'waiting', openP0: 1});
    expect(load.counts).toMatchObject({
      blocking: 1,
      fyi: 0,
      optional: 1,
      requestsDone: 0,
      requestsTotal: 2,
    });
    // R10 (home-base-vzwbj.4.9): requests exist, so "commits with no request"
    // does not apply — null, never a fabricated measured 0.
    expect(load.counts.commitsWithNoRequest).toBeNull();
  });

  test('Part 1 snapshot, markdown and ANSI', async () => {
    const w = await workSession();
    const load = await report(w, false);
    const markdown = normalize(partOne(load, false), w);
    const ansi = normalize(partOne(load, true), w);
    expect(markdown).toMatchSnapshot();
    expect(ansi).toMatchSnapshot();
    expect(dotRows(markdown)).toEqual([]);
    expect(dotRows(ansi)).toEqual([]);
  });

  test('every field on its own line; field groups are tight bullet lists; a blank line before every other list item and every group', async () => {
    const w = await workSession();
    const lines = partOne(await report(w, false), false).split('\n');
    // A field bullet, `- **Label:** value` (or `* **…`, F4) at the left edge
    // (item 5).
    const isField = (line: string | undefined): boolean =>
      line != null && /^[-*] \*\*[^*]+:\*\* /.test(line);
    lines.forEach((line, index) => {
      if (isField(line)) {
        // Tight inside a group: the line above is another field bullet, or
        // the blank line that opens the group.
        const previous = lines[index - 1];
        expect({ok: previous === '' || isField(previous), previous}).toEqual({
          ok: true,
          previous,
        });
      } else if (/^\s*(?:\d+\.|-) /.test(line)) {
        expect({line, previous: lines[index - 1]}).toEqual({
          line,
          previous: '',
        });
      }
      // A field line never carries a second **Label:**.
      expect((line.match(/\*\*[^*]+:\*\*/g) ?? []).length).toBeLessThanOrEqual(
        1,
      );
    });
    // home-base-j8q3e.1.7.2: the requests sit under "## Progress", and the
    // questions under their own heading.
    expect(lines).toContain('## Progress');
    expect(lines).toContain('## Questions for you');
    expect(lines.at(-1)).toBe(PART_ONE_SEPARATOR);
  });

  // F4 (home-base-vzwbj.4.9): two `-` lists one blank line apart are ONE loose
  // list in CommonMark; alternating markers keeps the groups apart.
  test('F4: no two adjacent field groups share a bullet marker, and both markers are used', async () => {
    const w = await workSession();
    for (const markdown of [
      partOne(await report(w, false), false),
      partOne(await report(questionOnly(), false), false),
    ]) {
      const blocks = markdown.split('\n\n');
      const markers = blocks.map(
        (block) => /^([-*]) \*\*[^*]+:\*\* /.exec(block)?.[1] ?? null,
      );
      markers.forEach((marker, index) => {
        const next = markers[index + 1];
        if (marker != null && next != null) {
          expect({adjacent: [marker, next], at: index}).not.toEqual({
            adjacent: [marker, marker],
            at: index,
          });
        }
      });
      expect(markers.filter((marker) => marker === '-').length).toBeGreaterThan(
        0,
      );
      expect(markers.filter((marker) => marker === '*').length).toBeGreaterThan(
        0,
      );
      // Part 1 still starts with the Session field (R6's strip rule), now on
      // its own line rather than in a group (home-base-j8q3e.1.7.2).
      expect(blocks[1]?.startsWith('**Session:**')).toBe(true);
    }
  });

  test('F5: with no upstream, Unpushed says what git measured — never "never been pushed"', async () => {
    const w = await workSession();
    const markdown = partOne(await report(w, false), false);
    expect(markdown).not.toContain('never been pushed');
    expect(markdown).toContain(
      '**Unpushed:** no upstream branch is configured, so nothing shows these commits were pushed anywhere',
    );
  });

  test('F10: Your last message — the newest user line — sits right under Your first message', async () => {
    const w = await workSession();
    const lines = partOne(await report(w, false), false).split('\n');
    const first = lines.findIndex((line) =>
      line.includes('**Your first message:**'),
    );
    // home-base-j8q3e.1.7.2: each label over its message as a `>` quote.
    expect(lines.slice(first, first + 7)).toEqual([
      '**Your first message:**',
      '',
      '> "Make the nightly export twice as fast, and write a runbook for it."',
      '',
      '**Your last message:**',
      '',
      '> "keep going"',
    ]);
    // One user message: only the first is shown.
    const single = partOne(await report(questionOnly(), false), false);
    expect(single).toContain('**Your first message:**');
    expect(single).not.toContain('Your last message');
  });

  test('thread status lists only what cannot be derived — here, nothing — and says 🛑', async () => {
    const w = await workSession();
    const out = renderThreadStatus(await report(w, true), {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out).toContain('Nothing to mark.');
    expect(out.trimEnd().split('\n').at(-1)).toBe(
      'If you stop now the inbox will say: 🛑 Waiting on you',
    );
  });

  test('thread show: Part 1 live, Claude’s last message with the pasted Part 1 stripped, your messages', async () => {
    const w = await workSession();
    const out = normalize(
      renderSessionShow(await report(w, false), {
        full: false,
        now: NOW,
        style: PLAIN_STYLE,
        timeZone: TZ,
      }),
      w,
    );
    const [part1, rest = ''] = out.split(`${PART_ONE_SEPARATOR}\n`);
    expect(part1).toContain(
      '**Session:** [WORK-REPO] Make the nightly export twice as fast',
    );
    expect(rest).toContain(
      '**From Claude:**\n\n- The export is batched; the runbook waits on the bucket question.',
    );
    expect(rest).not.toContain('stale pasted copy');
    expect(rest).not.toContain(PART_ONE_RULE);
    expect(rest).toContain(
      '**Your messages:**\n\n1. (Tuesday 1/1, 9:00 am) Make the nightly export twice as fast, and write a runbook for it.\n   Use the worktree.\n\n2. (Tuesday 1/1, 10:50 am) keep going',
    );
  });

  test('a request id and a question id both resolve to their session', async () => {
    const w = await workSession();
    for (const id of [w.request2, w.p3, w.sessionBead, SESSION]) {
      const loaded = await loadSession({
        cwd: w.repo,
        env: {...w.env, CLAUDE_CODE_SESSION_ID: undefined},
        selector: id,
        sessionIdOption: null,
      });
      expect({
        id,
        kind: loaded.kind,
        sessionId: loaded.kind === 'loaded' ? loaded.model.sessionId : null,
      }).toEqual({
        id,
        kind: 'loaded',
        sessionId: SESSION,
      });
    }
    const missing = await loadSession({
      cwd: w.repo,
      env: w.env,
      selector: 't-nope',
      sessionIdOption: null,
    });
    expect(missing.kind).toBe('noSession');
  });
});

describe('fixture 3: a session whose checkout is gone', () => {
  test('the model: every git measurement fails with the path; the beads are unreadable; ❔ unknown', async () => {
    const w = unreadableCheckout();
    const load = await report(w, false);
    const {git} = load.model;
    for (const value of [
      git.branch,
      git.commits,
      git.uncommitted,
      git.unpushed,
    ]) {
      expect(value.ok).toBe(false);
      expect(value.ok ? '' : value.reason).toContain(
        `checkout unreadable: ${w.repo} no longer exists`,
      );
    }
    expect(load.model.beads.session).toBeNull();
    expect(load.model.beads.problems[0]).toContain(
      join(w.repo, '.beads', 'issues.jsonl'),
    );
    expect(load.status.kind).toBe('unknown');
    const yielded = await report(w, true);
    expect(yielded.status.kind).toBe('unknown');
  });

  test('Part 1 snapshot, markdown and ANSI', async () => {
    const w = unreadableCheckout();
    const load = await report(w, false);
    const markdown = normalize(partOne(load, false), w);
    const ansi = normalize(partOne(load, true, false), w);
    expect(markdown).toMatchSnapshot();
    expect(ansi).toMatchSnapshot();
    expect(dotRows(markdown)).toEqual([]);
    expect(dotRows(ansi)).toEqual([]);
  });

  test('thread status never says "Nothing to mark." when it could not check', async () => {
    const w = unreadableCheckout();
    const out = renderThreadStatus(await report(w, true), {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out).not.toContain('Nothing to mark.');
    expect(out).toContain(
      '⚠️ Could not check commits with no request filed: checkout unreadable',
    );
    expect(out).toContain(
      'If you stop now the inbox will say: ❔ Unknown — checkout unreadable',
    );
  });
});

// ---------------------------------------------------------------------------
// What to mark: the three underivable conditions
// ---------------------------------------------------------------------------

// F6 (home-base-vzwbj.4.9): a conductor waiting on its players writes nothing
// to its own transcript; their subagent transcripts carry the activity.
describe('F6: last activity reads the subagent transcripts too', () => {
  function subagentDir(w: World): string {
    const dir = join(
      w.sb.path,
      'projects',
      w.repo.replace(/[^a-zA-Z0-9]/g, '-'),
      SESSION,
      'subagents',
    );
    mkdirSync(dir, {recursive: true});
    return dir;
  }

  test('a subagent record newer than the main transcript makes the session 🏃 working and is the time Part 1 shows', async () => {
    const w = questionOnly(); // main transcript ends at 09:05
    writeFileSync(
      join(subagentDir(w), 'agent-a1b2c3.jsonl'),
      `${[
        {
          isSidechain: true,
          sessionId: SESSION,
          timestamp: at('11:00'),
          type: 'user',
        },
        {
          isSidechain: true,
          sessionId: SESSION,
          timestamp: at('11:58'),
          type: 'assistant',
        },
        // Written at the subagent's stop: not conversation, never counted.
        {
          isSidechain: true,
          sessionId: SESSION,
          timestamp: at('11:59'),
          type: 'system',
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    );
    const load = await report(w, false);
    expect(load.model.transcript.lastRecordAt).toEqual(measured(at('11:58')));
    expect(load.status).toEqual({kind: 'working', lastRecordAt: at('11:58')});
    expect(partOne(load, false)).toContain(
      '**Last activity:** Tue 2030-01-01 11:58 am',
    );
  });

  test('an older subagent record changes nothing; an unreadable subagent file makes the time unknown, named', async () => {
    const w = questionOnly();
    const dir = subagentDir(w);
    writeFileSync(
      join(dir, 'agent-old.jsonl'),
      `${JSON.stringify({isSidechain: true, sessionId: SESSION, timestamp: at('09:01'), type: 'assistant'})}\n`,
    );
    expect((await report(w, false)).model.transcript.lastRecordAt).toEqual(
      measured(at('09:05')),
    );
    // A DIRECTORY with a transcript's name: listed, then unreadable.
    mkdirSync(join(dir, 'agent-broken.jsonl'));
    const lastRecordAt = (await report(w, false)).model.transcript.lastRecordAt;
    expect(lastRecordAt.ok).toBe(false);
    expect(lastRecordAt.ok ? '' : lastRecordAt.reason).toContain(
      'agent-broken.jsonl',
    );
  });
});

describe('fixture 4: 14 commit commands that matched nothing here (F14)', () => {
  test('Part 1 snapshot, markdown and ANSI', async () => {
    const w = commitsElsewhere();
    const load = await report(w, false);
    const markdown = normalize(partOne(load, false), w);
    const ansi = normalize(partOne(load, true), w);
    expect(markdown).toMatchSnapshot();
    expect(ansi).toMatchSnapshot();
    expect(dotRows(markdown)).toEqual([]);
    expect(dotRows(ansi)).toEqual([]);
  });

  test('the line says only the count; the warning and at most 3 examples sit under it, then "and N more"', async () => {
    const w = commitsElsewhere();
    const load = await report(w, false);
    // Every command is still in the model (`thread show --json`).
    const commits = load.model.git.commits;
    expect(
      commits.ok && commits.value.source === 'transcript'
        ? commits.value.unmatchedCalls
        : [],
    ).toHaveLength(14);
    const lines = partOne(load, false).split('\n');
    const row = lines.findIndex((line) =>
      /^[-*] \*\*Commits this session:\*\* /.test(line),
    );
    expect(lines[row]).toMatch(/^[-*] \*\*Commits this session:\*\* 0$/);
    expect(lines[row + 1]).toBe(
      '  - ⚠️ 14 commit commands matched no commit in this checkout (committed elsewhere, or failed); 2 confirmation lines belong to another checkout',
    );
    const examples = lines.slice(row + 2, row + 5);
    for (const example of examples) {
      expect(example).toMatch(/^ {4}- `git -C \.\.\/the-release-checkout /);
      const code = /`([^`]*)`/.exec(example)?.[1] ?? '';
      expect(code.length).toBeLessThanOrEqual(COMMIT_EXAMPLE_CUT + 1);
    }
    expect(lines[row + 5]).toBe('    - and 11 more');
    expect(lines[row + 6] ?? '').not.toMatch(/^ {4}- /);
  });
});

describe('whatToMark', () => {
  test('a request whose children are all closed but which is still open', async () => {
    const w = questionOnly();
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: null,
      title: 'Tidy the export logs',
    });
    if (filed.kind !== 'filed') throw new Error('not filed');
    const child = brCreate(
      {cwd: w.repo},
      {parent: filed.id, title: 'Delete the stale log files', type: 'task'},
    );
    if (child.kind !== 'ok') throw new Error('child not filed');
    brClose({cwd: w.repo}, child.id, 'done');
    const load = await report(w, true);
    // The yield would be ⚠️: G2's entry (home-base-vzwbj.4.16) supersedes
    // requestChildrenClosed and carries it as childrenAllClosed.
    expect(load.status.kind).toBe('openWork');
    const marks = whatToMark(load.model, load.status);
    expect(
      marks.map((mark) => [
        mark.kind,
        mark.kind === 'requestOpenNoBlocker' && mark.childrenAllClosed,
      ]),
    ).toEqual([['requestOpenNoBlocker', true]]);
    // Under any other verdict, requestChildrenClosed fires as before.
    expect(
      whatToMark(load.model, {by: 'requests', kind: 'done', reason: null}).map(
        (mark) => mark.kind,
      ),
    ).toEqual(['requestChildrenClosed']);
    const out = renderThreadStatus(load, {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out).toContain(
      `**What to mark:**\n\n- Request ${filed.id} ("Tidy the export logs") is in progress, every child bead is closed, and nothing blocks it.\n  - work done → \`br close ${filed.id} --reason "…"\``,
    );
    expect(out).toContain(
      'If you stop now the inbox will say: ⚠️ Open work, no blocker',
    );
  });

  test('commits with no request filed, and the title still the first line', async () => {
    const w = questionOnly();
    writeFileSync(join(w.repo, 'notes.md'), 'x\n');
    gitAt(w.repo, ['add', 'notes.md'], at('09:03'));
    gitAt(w.repo, ['commit', '-qm', 'docs: notes'], at('09:03'));
    // The session's own commit, as its transcript records it (item 4).
    writeTranscript(
      w,
      w.repo,
      '09:05',
      41_200,
      bashCallRecords({
        at: '2030-01-01T09:02:59.000Z',
        command: "git add notes.md && git commit -qm 'docs: notes'",
        cwd: w.repo,
        endAt: '2030-01-01T09:03:01.000Z',
        id: 'toolu_notes',
        output: '',
        sessionId: SESSION,
      }),
    );
    const load = await report(w, true);
    expect(
      whatToMark(load.model, load.status).map((mark) => mark.kind),
    ).toEqual(['noRequest', 'autoTitle']);
    const out = renderThreadStatus(load, {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out).toContain(
      '1 commit in this session, and no request filed: file one',
    );
    expect(out).toContain('- **Commits this session:** 1 — no request filed');
    expect(out).toContain(
      'If you stop now the inbox will say: ⚠️ Open work, no blocker',
    );
  });

  test('an uncommitted edit outside .beads/ with no request filed', async () => {
    const w = questionOnly();
    writeFileSync(join(w.repo, 'scratch.ts'), 'x\n');
    const load = await report(w, true);
    expect(whatToMark(load.model, load.status)[0]).toEqual({
      commits: 0,
      kind: 'noRequest',
      uncommitted: 1,
      unmatchedCommits: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// thread stage
// ---------------------------------------------------------------------------

describe('thread stage', () => {
  async function requestIn(w: World): Promise<string> {
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: null,
      title: 'Ship it',
    });
    if (filed.kind !== 'filed') throw new Error('not filed');
    return filed.id;
  }

  test('sets and unsets stage labels', async () => {
    const w = world();
    const id = await requestIn(w);
    const base = {cwd: w.repo, env: w.env, request: id, sessionId: null};
    const set = await markStage({
      ...base,
      stages: ['code-done', 'built'],
      unset: false,
    });
    expect(set).toMatchObject({
      kind: 'marked',
      now: ['code-done', 'built'],
      reached: {next: 'link-sent', reached: 'built'},
    });
    const shown = brShow({cwd: w.repo}, id);
    expect(
      shown.kind === 'ok'
        ? shown.issue.labels.filter((l) => l.startsWith('stage:')).sort()
        : null,
    ).toEqual(['stage:built', 'stage:code-done']);
    const unset = await markStage({...base, stages: ['built'], unset: true});
    expect(unset).toMatchObject({
      kind: 'marked',
      now: ['code-done'],
      reached: {next: 'tested', reached: 'code-done'},
    });
    expect(describeStageOutcome(unset).lines).toContain(
      'Stage reached: code-done (next: tested)',
    );
  });

  test('refuses a name off the ladder, printing the ladder (exit 2), and writes nothing', async () => {
    const w = world();
    const id = await requestIn(w);
    const outcome = await markStage({
      cwd: w.repo,
      env: w.env,
      request: id,
      sessionId: null,
      stages: ['tested', 'shipped'],
      unset: false,
    });
    expect(outcome).toMatchObject({kind: 'unknownStage', names: ['shipped']});
    const {exitCode, lines} = describeStageOutcome(outcome);
    expect(exitCode).toBe(2);
    expect(lines[0]).toContain('"shipped" is not on the stage ladder');
    expect(lines[0]).toContain('code-done, tested, built, link-sent, approved');
    const shown = brShow({cwd: w.repo}, id);
    expect(
      shown.kind === 'ok'
        ? shown.issue.labels.filter((l) => l.startsWith('stage:'))
        : null,
    ).toEqual([]);
  });

  test('the ladder comes from componentConfig.thread.stages', async () => {
    const w = world({knobs: {...ON, stages: ['drafted', 'reviewed']}});
    const id = await requestIn(w);
    const base = {
      cwd: w.repo,
      env: w.env,
      request: id,
      sessionId: null,
      unset: false,
    };
    expect((await markStage({...base, stages: ['tested']})).kind).toBe(
      'unknownStage',
    );
    expect(await markStage({...base, stages: ['drafted']})).toMatchObject({
      kind: 'marked',
      reached: {next: 'reviewed', reached: 'drafted'},
    });
  });

  test('a malformed ladder is NAMED as a config problem and the default is used', async () => {
    const {resolveThreadConfig} = await import('../src/thread/config');
    for (const stages of [['tested', 'has space'], [], ['tested', 'tested']]) {
      const w = world({knobs: {...ON, stages}});
      const config = resolveThreadConfig({cwd: w.repo, env: w.env});
      expect(config.stages).toEqual([
        'code-done',
        'tested',
        'built',
        'link-sent',
        'approved',
      ]);
      expect(config.stagesSource).toBe('default');
      expect(config.problems.join('\n')).toContain(
        'componentConfig.thread.stages in the user config',
      );
    }
  });

  test('refuses a bead that is not a request, and needs the knob', async () => {
    const w = world();
    const plain = brCreate(
      {cwd: w.repo},
      {title: 'Not a request', type: 'task'},
    );
    if (plain.kind !== 'ok') throw new Error('not filed');
    const notRequest = await markStage({
      cwd: w.repo,
      env: w.env,
      request: plain.id,
      sessionId: null,
      stages: ['tested'],
      unset: false,
    });
    expect(describeStageOutcome(notRequest).exitCode).toBe(2);
    expect(notRequest.kind).toBe('notRequest');
    const off = world({knobs: {enabled: true}});
    const disabled = await markStage({
      cwd: off.repo,
      env: off.env,
      request: 't-x',
      sessionId: null,
      stages: ['tested'],
      unset: false,
    });
    expect(disabled.kind).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// The strip rule and the message cut (thread show)
// ---------------------------------------------------------------------------

describe('stripPastedPartOne', () => {
  test('removes from the rule line through the separator, inclusive', () => {
    const text = `${PART_ONE_RULE}\n\n**Session:** x\n\n${PART_ONE_SEPARATOR}\n\nMy answer.`;
    expect(stripPastedPartOne(text)).toBe('My answer.');
  });
  test('keeps text before and after, and strips every pasted copy', () => {
    const block = `${PART_ONE_RULE}\n- **Session:** y\n- **Status:** z\n${PART_ONE_SEPARATOR}`;
    expect(
      stripPastedPartOne(`Intro.\n${block}\nMiddle.\n${block}\nEnd.`),
    ).toBe('Intro.\nMiddle.\nEnd.');
  });
  // R6 (home-base-vzwbj.4.9): the strip is bounded.
  test('R6: a legacy report (rule … 🕉️, no separator) followed later by a separator line is left whole, Claude’s text included', () => {
    const text = [
      PART_ONE_RULE,
      '',
      '⚡ ✅ Work completed',
      '',
      '🕉️'.repeat(28),
      '',
      'Claude’s own words that must survive.',
      '',
      PART_ONE_SEPARATOR,
      '',
      'More of Claude’s words.',
    ].join('\n');
    expect(stripPastedPartOne(text)).toBe(text);
  });
  test('R6: two pasted Part 1s are both stripped, the text between them kept', () => {
    const block = `${PART_ONE_RULE}\n\n- **Session:** [HOME] x\n- **Started:** y\n\n${PART_ONE_SEPARATOR}`;
    expect(
      stripPastedPartOne(
        `${block}\n\nFirst answer.\n\n${block}\n\nSecond answer.`,
      ),
    ).toBe('First answer.\n\n\nSecond answer.');
  });
  test('R6: a lone line of 🛑 used for emphasis is not a Part 1, even with a separator later', () => {
    const text = `Heads up:\n🛑🛑🛑\nThis is important.\n${PART_ONE_SEPARATOR}\nThe rest.`;
    expect(stripPastedPartOne(text)).toBe(text);
  });
  test('R6: a rule whose Part 1 is cut off by a second rule before any separator: the first is left, the second stripped', () => {
    const real = `${PART_ONE_RULE}\n- **Session:** b\n${PART_ONE_SEPARATOR}`;
    const text = `${PART_ONE_RULE}\n- **Session:** a\nhalf a paste\n${real}\nAfter.`;
    expect(stripPastedPartOne(text)).toBe(
      `${PART_ONE_RULE}\n- **Session:** a\nhalf a paste\nAfter.`,
    );
  });
  test('a rule with NO separator after it is left alone (a legacy report ends in 🕉️)', () => {
    const legacy = `${PART_ONE_RULE}\n\n⚡ ✅ Work completed\n\n${'🕉️'.repeat(28)}`;
    expect(stripPastedPartOne(legacy)).toBe(legacy);
  });
  test('a separator with no rule before it is left alone', () => {
    expect(stripPastedPartOne(`Text\n${PART_ONE_SEPARATOR}\nMore`)).toBe(
      `Text\n${PART_ONE_SEPARATOR}\nMore`,
    );
  });
});

describe('cutMessage', () => {
  test(`cuts at ${USER_MESSAGE_CUT} characters and says how much is left; --full keeps all`, () => {
    const long = 'a'.repeat(USER_MESSAGE_CUT + 25);
    expect(cutMessage(long, false)).toBe(
      `${'a'.repeat(USER_MESSAGE_CUT)}… (25 more characters; --full shows them)`,
    );
    expect(cutMessage(long, true)).toBe(long);
    expect(cutMessage('short', false)).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe('the CLI', () => {
  function cli(
    w: World,
    args: string[],
    env: Record<string, string | undefined> = {},
  ) {
    const cliEntry = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const merged = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...w.env,
        ...env,
        FORCE_COLOR: undefined,
        NO_COLOR: '1',
      }).filter((entry): entry is [string, string] => entry[1] != null),
    );
    const run = Bun.spawnSync([process.execPath, cliEntry, 'thread', ...args], {
      cwd: w.repo,
      env: merged,
      stdin: 'ignore',
    });
    return {
      code: run.exitCode,
      err: run.stderr.toString(),
      out: run.stdout.toString(),
    };
  }

  test('thread status with the knob OFF prints SESSION BEADS: DISABLED and exits 0', () => {
    const w = world({knobs: {enabled: true}});
    const run = cli(w, ['status']);
    expect(run.code).toBe(0);
    expect(run.out.startsWith('SESSION BEADS: DISABLED')).toBe(true);
  });

  test('thread status on a question-only session: Part 1 and "Nothing to mark."', () => {
    const w = questionOnly();
    const run = cli(w, ['status']);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain('SESSION BEADS: ENABLED');
    expect(run.out).toContain(PART_ONE_RULE);
    expect(run.out).toContain('Nothing to mark.');
    expect(run.out).toContain(
      'If you stop now the inbox will say: 💬 Answered',
    );
  });

  test('thread show <request id> prints Part 1 live; with the knob off the legacy show runs', async () => {
    const w = await workSession();
    const run = cli(w, ['show', w.request2], {
      CLAUDE_CODE_SESSION_ID: undefined,
    });
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain(PART_ONE_RULE);
    expect(run.out).toContain('**From Claude:**');
    const off = cli(w, ['show'], {
      JUSTIN_THREADS_REPO_DIR: join(w.sb.path, 'no-threads'),
      XDG_CONFIG_HOME: join(w.sb.path, 'no-config'),
    });
    expect(off.out).not.toContain(PART_ONE_RULE);
    expect(off.err).toContain('thread show:');
  });

  // R8 (home-base-vzwbj.4.9): with the knob on, a legacy thread id still
  // reaches the legacy handler.
  test('R8: thread show th-… with the knob ON prints the legacy thread; a v4 id stays v4', async () => {
    const w = await workSession();
    const fake = createFakeBd();
    try {
      const state = fake.read();
      state.issues = [
        {
          id: 'th-r8leg',
          status: 'open',
          title: 'A legacy thread from before v4',
          type: 'thread',
        },
      ];
      fake.write(state);
      // fake.env is a copy of process.env: only what it CHANGES goes over the
      // world's own isolated env (state dir, config).
      const legacyEnv: Record<string, string | undefined> = {
        JUSTIN_THREADS_REPO_DIR: fake.dir,
      };
      for (const [key, value] of Object.entries(fake.env)) {
        if (process.env[key] !== value) legacyEnv[key] = value;
      }
      const run = cli(w, ['show', 'th-r8leg'], legacyEnv);
      expect({code: run.code, err: run.err}).toEqual({code: 0, err: ''});
      expect(run.out).toContain('A legacy thread from before v4');
      expect(run.out).not.toContain(PART_ONE_RULE);
      const v4 = cli(w, ['show', w.request2], legacyEnv);
      expect(v4.out).toContain(PART_ONE_RULE);
    } finally {
      fake.cleanup();
    }
  });

  test('R8: routesToLegacyThread — v4 first; then the th- shape, or an id the legacy export holds', async () => {
    const w = await workSession();
    const fake = createFakeBd();
    try {
      mkdirSync(join(fake.dir, '.beads'), {recursive: true});
      writeFileSync(
        join(fake.dir, '.beads', 'issues.jsonl'),
        `${JSON.stringify({id: 'old-legacy1', title: 'x'})}\n`,
      );
      const env = {...w.env, JUSTIN_THREADS_REPO_DIR: fake.dir};
      const routes = (selector: string | null): boolean =>
        routesToLegacyThread({cwd: w.repo, env, selector});
      expect(routes(null)).toBe(false);
      expect(routes(w.request2)).toBe(false);
      expect(routes(w.sessionBead)).toBe(false);
      expect(routes('th-anything')).toBe(true);
      expect(routes('old-legacy1')).toBe(true);
      expect(routes('zz-nowhere')).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test('thread stage refuses a name off the ladder with exit 2', async () => {
    const w = world();
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: null,
      title: 'Ship it',
    });
    if (filed.kind !== 'filed') throw new Error('not filed');
    const bad = cli(w, ['stage', filed.id, 'shipped']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('code-done, tested, built, link-sent, approved');
    const good = cli(w, ['stage', filed.id, 'tested']);
    expect(good.code).toBe(0);
    expect(good.out).toContain('Stage reached: tested (next: built)');
  });
});
