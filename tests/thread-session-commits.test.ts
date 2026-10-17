/**
 * Which commits a session made (home-base-vzwbj.4.4 design item 4, folding in
 * home-base-vzwbj.4.7): attributed from the session's transcript — git's
 * confirmation lines AND the time windows of the Bash calls that ran `git
 * commit` (most real commits here use -q and print no confirmation; measured
 * 2026-10-11) — with the `--since` count only as a LABELLED fallback when the
 * transcript cannot be read.
 *
 * The shared-checkout fixtures use the REAL br and git in $TMPDIR, like the
 * other v4 tests; `needBr()` throws when br is missing.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.4's notes.
 */

import type {GitRun, GitRunner} from '../src/thread/session-commits';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {
  type MessageLine,
  serializeMessageLine,
} from '../src/thread/message-log';
import {partOneView, renderPartOne} from '../src/thread/part-one';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  attributeCommits,
  commitEvidenceFromText,
  isGitCommitCommand,
  stripQuotedText,
} from '../src/thread/session-commits';
import {measured} from '../src/thread/session-model';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {commitsFactOf, deriveStatus} from '../src/thread/session-status';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';
import {bashCallRecords, readCallRecords} from './transcript-records';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TZ = 'UTC';
const A = 'a0000000-1111-4222-8333-000000000001';
const B = 'b0000000-1111-4222-8333-000000000002';
const C = 'c0000000-1111-4222-8333-000000000003';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function at(hhmmss: string): string {
  return `2030-01-01T${hhmmss}.000Z`;
}

function lines(records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

// ---------------------------------------------------------------------------
// Recognising a commit command
// ---------------------------------------------------------------------------

describe('isGitCommitCommand', () => {
  const rows: [string, boolean][] = [
    ["git commit -qm 'feat: x'", true],
    [
      'git add a.ts && git commit -q -F /tmp/msg.txt && git log --oneline -1',
      true,
    ],
    ["git -C /repo commit -m 'y'", true],
    ['git --no-pager commit --amend --no-edit', true],
    ["cd /x && git commit -m 'a; b' 2>&1 | tail -2", true],
    ['git commit --help', false],
    ['git commit -h', false],
    ['git commit --dry-run', false],
    ['echo "git commit -m x"', false],
    ["printf 'git commit'", false],
    ['git log --oneline -3', false],
    ['git commit-tree abc123', false],
    ['git status; git commit -h', false],
    ['git status; git commit -qm done', true],
  ];
  for (const [command, expected] of rows) {
    test(`${JSON.stringify(command)} → ${expected}`, () => {
      expect(isGitCommitCommand(command)).toBe(expected);
    });
  }
});

// R3 (home-base-vzwbj.4.9): one left-to-right quote tokenizer.
describe('stripQuotedText', () => {
  const rows: [string, string][] = [
    ['echo "git commit"', 'echo ""'],
    // The order bug: the apostrophes in "can't" and "won't" must not pair.
    [`echo "can't" && git commit -qm "won't"`, 'echo "" && git commit -qm ""'],
    [`git commit -m 'it'"'"'s'`, `git commit -m ''""''`],
    [`echo 'a "b" c'; git commit`, `echo ''; git commit`],
    [`echo "a \\"q\\" b" && git commit`, 'echo "" && git commit'],
    [`echo $'it\\'s' && git commit`, `echo '' && git commit`],
    [`echo \\' && git commit`, `echo \\' && git commit`],
    ['echo "unterminated && git commit', 'echo ""'],
    ['git commit -qm plain', 'git commit -qm plain'],
  ];
  for (const [command, expected] of rows) {
    test(`${JSON.stringify(command)} → ${JSON.stringify(expected)}`, () => {
      expect(stripQuotedText(command)).toBe(expected);
    });
  }

  test('the order-bug input is recognised as a commit', () => {
    expect(isGitCommitCommand(`echo "can't" && git commit -qm "won't"`)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence from the transcript text
// ---------------------------------------------------------------------------

describe('commitEvidenceFromText', () => {
  const base = {cwd: '/repo', sessionId: A};

  test('a confirmation line in a Bash result is evidence; the same text in a Read result is not', () => {
    const text = lines([
      ...bashCallRecords({
        ...base,
        at: at('10:00:00'),
        command: "git commit -m 'feat: x'",
        endAt: at('10:00:02'),
        id: 'toolu_1',
        output: '[main 1a2b3c4] feat: x\n 1 file changed',
      }),
      ...readCallRecords({
        ...base,
        at: at('10:01:00'),
        id: 'toolu_2',
        output: '[main 9f9f9f9] a commit line inside a file',
      }),
    ]);
    const evidence = commitEvidenceFromText(text, 't.jsonl');
    expect(evidence.confirmations).toEqual([
      {file: 't.jsonl', shortSha: '1a2b3c4', subject: 'feat: x'},
    ]);
    expect(evidence.calls).toEqual([
      {
        command: "git commit -m 'feat: x'",
        endedAt: at('10:00:02'),
        file: 't.jsonl',
        startedAt: at('10:00:00'),
      },
    ]);
  });

  test('root-commit and detached HEAD confirmations are recognised', () => {
    const text = lines([
      ...bashCallRecords({
        ...base,
        at: at('10:00:00'),
        command: 'bun run make-commits',
        endAt: at('10:00:05'),
        id: 'toolu_3',
        output:
          '[main (root-commit) abcdef0] init\n[detached HEAD 1234567] wip',
      }),
    ]);
    const evidence = commitEvidenceFromText(text, 't.jsonl');
    expect(evidence.confirmations.map((entry) => entry.shortSha)).toEqual([
      'abcdef0',
      '1234567',
    ]);
    // Not a `git commit` command: a confirmation, but no window.
    expect(evidence.calls).toEqual([]);
  });

  test('a -q commit prints nothing but leaves a window; one with no result yet has an open end', () => {
    const text = lines([
      ...bashCallRecords({
        ...base,
        at: at('10:00:00'),
        command: "git commit -qm 'feat: quiet'",
        endAt: at('10:00:03'),
        id: 'toolu_4',
        output: '',
      }),
      ...bashCallRecords({
        ...base,
        at: at('11:00:00'),
        command: "git commit -qm 'feat: still running'",
        endAt: null,
        id: 'toolu_5',
        output: '',
      }),
    ]);
    const evidence = commitEvidenceFromText(text, 't.jsonl');
    expect(evidence.confirmations).toEqual([]);
    expect(
      evidence.calls.map((call) => [call.startedAt, call.endedAt]),
    ).toEqual([
      [at('10:00:00'), at('10:00:03')],
      [at('11:00:00'), null],
    ]);
  });

  // F1 (home-base-j8q3e.1.4): the record shape measured in session f7cb268b on
  // 2026-10-15. An undated `api-request-blob` repeats the assistant message
  // after (or before) the dated one; the call must keep its time.
  test('an undated api-request-blob repeating a commit call does not erase its time', () => {
    const call = bashCallRecords({
      ...base,
      at: at('10:00:00'),
      command: "git commit -qm 'feat: x'",
      endAt: at('10:00:02'),
      id: 'toolu_blob',
      output: '',
    });
    const assistant = call[0] as {message: unknown};
    const blob = {
      hash: 'e2754021',
      message: assistant.message,
      sessionId: A,
      type: 'api-request-blob',
    };
    for (const order of [
      [assistant, blob, ...call.slice(1)],
      [blob, assistant, ...call.slice(1)],
    ]) {
      const evidence = commitEvidenceFromText(lines(order), 't.jsonl');
      expect(evidence.calls.map((entry) => entry.startedAt)).toEqual([
        at('10:00:00'),
      ]);
    }
    // A call that ONLY an undated record carries stays undated (rule 7).
    const onlyBlob = commitEvidenceFromText(
      lines([blob, ...call.slice(1)]),
      't.jsonl',
    );
    expect(onlyBlob.calls.map((entry) => entry.startedAt)).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// Resolving: both sources, table-driven, with a scripted git
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function scriptedGit(script: Record<string, GitRun>): {
  calls: string[][];
  git: GitRunner;
} {
  const calls: string[][] = [];
  return {
    calls,
    git: (args) => {
      calls.push(args);
      const key = args[0] === 'log' ? 'log' : (args[3] ?? args.join(' '));
      return script[key] ?? {kind: 'exit', status: 128, stderr: 'unscripted'};
    },
  };
}

function seconds(iso: string): number {
  return Date.parse(iso) / 1000;
}

// R3 (home-base-vzwbj.4.9): commit evidence that matched no commit makes the
// count PARTIAL, and a partial count never derives 💬 answered.
describe('R3: the three inputs that used to read as "0 commits" are partial, never answered', () => {
  const base = {cwd: '/repo', sessionId: A};
  const noRequestFacts = {
    beadProblems: [],
    contextTokens: 1000,
    handedOff: false,
    helpersInFlight: [],
    lastMessageRole: 'assistant' as const,
    lastRecordAt: null,
    merged: measured<'isDefault' | 'merged' | 'notMerged'>('isDefault'),
    openP0: 0,
    requests: {closed: 0, total: 0},
    sessionCloseReason: null,
    successor: null,
    uncommitted: measured(0),
    wrapUpAt: null,
  };
  async function verdict(text: string, script: Record<string, GitRun>) {
    const evidence = commitEvidenceFromText(text, 't.jsonl');
    const attributed = await attributeCommits(
      evidence,
      scriptedGit(script).git,
    );
    if (!attributed.ok) throw new Error(attributed.reason);
    const fact = commitsFactOf(measured(attributed.value));
    const status = deriveStatus(
      {...noRequestFacts, commits: fact},
      {asIfYielded: true, now: new Date(at('12:00:00'))},
    );
    return {fact, status: status.kind, value: attributed.value};
  }

  test('`git -C ../other commit`: its window catches no commit in this checkout', async () => {
    const result = await verdict(
      lines(
        bashCallRecords({
          ...base,
          at: at('10:00:00'),
          command: "git -C ../other commit -qm 'elsewhere'",
          endAt: at('10:00:02'),
          id: 'toolu_1',
          output: '',
        }),
      ),
      {log: {kind: 'ok', stdout: ''}},
    );
    expect(result.value.unmatchedCalls).toEqual([
      "git -C ../other commit -qm 'elsewhere'",
    ]);
    expect(result.fact).toEqual({kind: 'partial', matched: 0, unmatched: 1});
    expect(result.status).toBe('openWork');
  });

  test('a script that commits (`bun run sdk:publish`) and prints a commit line that is not in this checkout', async () => {
    const result = await verdict(
      lines(
        bashCallRecords({
          ...base,
          at: at('10:00:00'),
          command: 'bun run sdk:publish',
          endAt: at('10:01:00'),
          id: 'toolu_1',
          output: 'tests pass\n[main 7e7e7e7] chore(release): v0.9.0\n',
        }),
      ),
      {'7e7e7e7^{commit}': {kind: 'exit', status: 1, stderr: ''}},
    );
    expect(result.value.unresolved).toEqual(['7e7e7e7']);
    expect(result.fact).toEqual({kind: 'partial', matched: 0, unmatched: 1});
    expect(result.status).toBe('openWork');
  });

  test(`the quote-order bug: echo "can't" && git commit -qm "won't" is a commit call`, async () => {
    const result = await verdict(
      lines(
        bashCallRecords({
          ...base,
          at: at('10:00:00'),
          command: `echo "can't" && git commit -qm "won't"`,
          endAt: at('10:00:02'),
          id: 'toolu_1',
          output: "can't",
        }),
      ),
      {log: {kind: 'ok', stdout: ''}},
    );
    expect(result.fact.kind).toBe('partial');
    expect(result.status).not.toBe('answered');
  });

  test('a commit command whose window DID catch a commit is counted, not partial', async () => {
    const result = await verdict(
      lines(
        bashCallRecords({
          ...base,
          at: at('10:00:00'),
          command: "git commit -qm 'here'",
          endAt: at('10:00:02'),
          id: 'toolu_1',
          output: '',
        }),
      ),
      {log: {kind: 'ok', stdout: `${SHA_A} ${seconds(at('10:00:01'))}`}},
    );
    expect(result.fact).toEqual({count: 1, kind: 'counted'});
  });
});

describe('attributeCommits', () => {
  const window = (start: string, end: string | null) => ({
    command: 'git commit -q',
    endedAt: end,
    file: 't.jsonl',
    startedAt: start,
  });

  test('source 1, confirmation lines: a short sha that resolves counts; one that does not is reported, not counted', async () => {
    const {git} = scriptedGit({
      '1111111^{commit}': {kind: 'ok', stdout: `${SHA_A}\n`},
      '2222222^{commit}': {kind: 'exit', status: 1, stderr: ''},
    });
    const result = await attributeCommits(
      {
        calls: [],
        confirmations: [
          {file: 't', shortSha: '1111111', subject: 'x'},
          {file: 't', shortSha: '2222222', subject: 'y'},
          {file: 't', shortSha: '1111111', subject: 'x again'},
        ],
      },
      git,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        count: 1,
        shas: [SHA_A],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: ['2222222'],
      },
    });
  });

  test('source 2, commit windows: only commits whose committer time falls inside a window (±1 s) count', async () => {
    const {calls, git} = scriptedGit({
      log: {
        kind: 'ok',
        stdout: [
          `${SHA_A} ${seconds(at('10:00:02'))}`, // inside window 1
          `${SHA_B} ${seconds(at('10:15:00'))}`, // another session's commit
          `${SHA_C} ${seconds(at('10:30:06'))}`, // 1 s after window 2 ends: inside
        ].join('\n'),
      },
    });
    const result = await attributeCommits(
      {
        calls: [
          window(at('10:00:00'), at('10:00:03')),
          window(at('10:30:00'), at('10:30:05')),
        ],
        confirmations: [],
      },
      git,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        count: 2,
        shas: [SHA_A, SHA_C],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: [],
      },
    });
    expect(calls[0]?.slice(0, 2)).toEqual(['log', '--all']);
  });

  test('both sources union by full sha', async () => {
    const {git} = scriptedGit({
      '1111111^{commit}': {kind: 'ok', stdout: SHA_A},
      log: {kind: 'ok', stdout: `${SHA_A} ${seconds(at('10:00:01'))}`},
    });
    const result = await attributeCommits(
      {
        calls: [window(at('10:00:00'), at('10:00:02'))],
        confirmations: [{file: 't', shortSha: '1111111', subject: 'x'}],
      },
      git,
    );
    expect(result.ok && result.value.count).toBe(1);
  });

  test('no evidence at all is a MEASURED 0 (the transcript was read and shows no commit)', async () => {
    const {calls, git} = scriptedGit({});
    expect(await attributeCommits({calls: [], confirmations: []}, git)).toEqual(
      {
        ok: true,
        value: {
          count: 0,
          shas: [],
          source: 'transcript',
          unmatchedCalls: [],
          unresolved: [],
        },
      },
    );
    expect(calls).toEqual([]);
  });

  test('rule 7: git failing, or a commit call with no timestamp, is unknown — never 0', async () => {
    const failing = scriptedGit({
      log: {kind: 'error', message: 'spawn git ENOENT'},
    });
    const viaLog = await attributeCommits(
      {calls: [window(at('10:00:00'), at('10:00:02'))], confirmations: []},
      failing.git,
    );
    expect(viaLog.ok).toBe(false);
    expect(viaLog.ok ? '' : viaLog.reason).toContain('could not run');

    const badSha = scriptedGit({
      '1111111^{commit}': {kind: 'exit', status: 128, stderr: 'fatal: bad'},
    });
    const viaSha = await attributeCommits(
      {
        calls: [],
        confirmations: [{file: 't', shortSha: '1111111', subject: ''}],
      },
      badSha.git,
    );
    expect(viaSha.ok).toBe(false);

    const undated = await attributeCommits(
      {
        calls: [{...window(at('10:00:00'), null), startedAt: null}],
        confirmations: [],
      },
      scriptedGit({}).git,
    );
    expect(undated.ok).toBe(false);
    expect(undated.ok ? '' : undated.reason).toContain('no timestamp');
  });
});

// ---------------------------------------------------------------------------
// The shared checkout (home-base-vzwbj.4.7's scenario), real git and br
// ---------------------------------------------------------------------------

interface Shared {
  beads: Record<string, string>;
  commits: {a: string; b: string; player: string};
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
}

function gitAt(cwd: string, args: string[], when: string): void {
  execFileSync('git', args, {
    cwd,
    env: {...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function head(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function transcriptPath(sb: Sandbox, cwd: string, session: string): string {
  return join(
    sb.path,
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${session}.jsonl`,
  );
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, text);
}

function transcript(
  session: string,
  cwd: string,
  between: object[],
  last: string,
): string {
  return lines([
    {
      cwd,
      entrypoint: 'cli',
      message: {content: 'hello', role: 'user'},
      sessionId: session,
      timestamp: at('09:00:00'),
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
          cache_read_input_tokens: 40_000,
          input_tokens: 100,
        },
      },
      sessionId: session,
      timestamp: last,
      type: 'assistant',
    },
  ]);
}

/**
 * One checkout, three sessions, all first prompted at 09:00: A commits at
 * 10:00 (with -q) and its player commits at 11:00 (in a subagent file); B
 * commits at 10:30 (printing git's confirmation line); C only asks a question.
 */
function sharedCheckout(): Shared {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  writeFile(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'shared-repo', {'README.md': '# shared\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  // The beads export is committed so the tree is clean apart from the work.
  const beads: Record<string, string> = {};
  for (const [session, text] of [
    [A, 'Fix the importer'],
    [B, 'Tidy the docs'],
    [C, 'What does the importer do with blank rows?'],
  ] as const) {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: at('09:00:00'), text},
      now: new Date(at('09:00:00')),
      sessionId: session,
    });
    if (filed.kind !== 'created') throw new Error(`not filed: ${filed.detail}`);
    beads[session] = filed.beadId;
    const log: MessageLine[] = [
      {
        at: at('09:00:00'),
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        text,
      },
      {
        at: at('11:50:00'),
        cwd: repo,
        event: 'Stop',
        role: 'assistant',
        text: 'Done.',
      },
    ];
    writeFile(
      messageLogPath(session, env),
      log.map(serializeMessageLine).join(''),
    );
  }

  writeFileSync(join(repo, 'importer.ts'), 'export const a = 1;\n');
  gitAt(repo, ['add', 'importer.ts'], at('10:00:01'));
  gitAt(repo, ['commit', '-qm', 'fix: importer'], at('10:00:01'));
  const a = head(repo);
  writeFileSync(join(repo, 'DOCS.md'), '# docs\n');
  gitAt(repo, ['add', 'DOCS.md'], at('10:30:01'));
  gitAt(repo, ['commit', '-qm', 'docs: tidy'], at('10:30:01'));
  const b = head(repo);
  writeFileSync(join(repo, 'importer.ts'), 'export const a = 2;\n');
  gitAt(repo, ['commit', '-qam', 'test: importer'], at('11:00:01'));
  const player = head(repo);

  const pathA = transcriptPath(sb, repo, A);
  writeFile(
    pathA,
    transcript(
      A,
      repo,
      bashCallRecords({
        at: at('10:00:00'),
        command: "git add importer.ts && git commit -qm 'fix: importer'",
        cwd: repo,
        endAt: at('10:00:02'),
        id: 'toolu_a1',
        output: '',
        sessionId: A,
      }),
      at('11:50:00'),
    ),
  );
  // A's player: a subagent transcript beside A's (isSidechain records).
  writeFile(
    join(dirname(pathA), A, 'subagents', 'agent-p1.jsonl'),
    lines(
      bashCallRecords({
        at: at('11:00:00'),
        command: "git commit -qam 'test: importer'",
        cwd: repo,
        endAt: at('11:00:02'),
        id: 'toolu_p1',
        isSidechain: true,
        output: '',
        sessionId: A,
      }),
    ),
  );
  writeFile(
    transcriptPath(sb, repo, B),
    transcript(
      B,
      repo,
      bashCallRecords({
        at: at('10:30:00'),
        command: "git add DOCS.md && git commit -m 'docs: tidy'",
        cwd: repo,
        endAt: at('10:30:02'),
        id: 'toolu_b1',
        output: `[main ${b.slice(0, 7)}] docs: tidy\n 1 file changed, 1 insertion(+)`,
        sessionId: B,
      }),
      at('11:50:00'),
    ),
  );
  writeFile(
    transcriptPath(sb, repo, C),
    transcript(C, repo, [], at('11:50:00')),
  );
  return {beads, commits: {a, b, player}, env, repo, sb};
}

async function load(w: Shared, session: string, asIfYielded = true) {
  const loaded = await loadSessionReport({
    asIfYielded,
    cwd: w.repo,
    env: w.env,
    now: NOW,
    selector: null,
    sessionId: session,
  });
  if (loaded.kind !== 'loaded') throw new Error(JSON.stringify(loaded));
  return loaded;
}

describe('a checkout three sessions share (home-base-vzwbj.4.7)', () => {
  test('each session counts only the commits it made — a player’s commit is its session’s', async () => {
    const w = sharedCheckout();
    const a = await load(w, A);
    const commitsA = a.model.git.commits;
    expect(commitsA.ok && commitsA.value.source).toBe('transcript');
    expect(
      commitsA.ok && commitsA.value.source === 'transcript'
        ? [...commitsA.value.shas].sort()
        : null,
    ).toEqual([w.commits.a, w.commits.player].sort());
    const b = await load(w, B);
    expect(b.model.git.commits).toEqual({
      ok: true,
      value: {
        count: 1,
        shas: [w.commits.b],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: [],
      },
    });
  });

  test('a question-only session in that checkout is 💬 answered and has nothing to mark', async () => {
    const w = sharedCheckout();
    const c = await load(w, C);
    expect(c.model.git.commits.ok && c.model.git.commits.value.count).toBe(0);
    expect(c.status).toEqual({kind: 'answered'});
    const out = renderThreadStatus(c, {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(out).toContain('Nothing to mark.');
    expect(out).toContain('- **Commits this session:** 0');
  });

  test('no transcript: the --since count, LABELLED as the fallback in Part 1', async () => {
    const w = sharedCheckout();
    const {rmSync} = await import('fs');
    rmSync(transcriptPath(w.sb, w.repo, C));
    const c = await load(w, C);
    expect(c.model.git.commits.ok && c.model.git.commits.value).toMatchObject({
      count: 3,
      source: 'sinceFirstPrompt',
    });
    const text = renderPartOne(
      partOneView({
        action: c.action,
        counts: c.counts,
        model: c.model,
        now: NOW,
        optional: c.optional,
        status: c.status,
        timeZone: TZ,
      }),
      PLAIN_STYLE,
    );
    // F14 (home-base-vzwbj.4.9): the count on the line, why it is the
    // fallback on a ⚠️ line under it.
    expect(text).toContain(
      "- **Commits this session:** 3 — no request filed\n  - ⚠️ counted on this branch since your first prompt, so other sessions' commits may be included: the transcript could not be read — no transcript",
    );
    expect(c.status.kind).toBe('openWork');
  });
});
