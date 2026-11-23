/**
 * `thread status` warns when an open question names work that moved after the
 * question was filed (home-base-5uu56.2.5). Real br in throwaway repos, every
 * state file under a temp JUSTIN_THREADS_STATE_DIR.
 *
 * Questions are built in memory with a chosen created time (an hour before, or
 * an hour after, the real br writes), so "after the question was filed" is
 * decided by the test, not by the clock.
 */

import type {TreeIssue} from '../src/thread/session-tree';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {fileAsk} from '../src/thread/ask';
import {
  checkQuestionMoves,
  questionMoveMarks,
  realQuestionMoveReaders,
  toTargetOf,
} from '../src/thread/question-moved';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {runThreadStatus} from '../src/thread/session-report';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr, PINNED_BR} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '5ec0d000-aaaa-4bbb-8ccc-0123456789ab';
const OTHER = '5ec0d000-2222-4bbb-8ccc-0123456789ab';
const THIRD = '5ec0d000-3333-4bbb-8ccc-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface Repo {
  beadsDir: string;
  path: string;
  sessionBeadId: string;
}

interface World {
  env: Record<string, string | undefined>;
  sb: Sandbox;
}

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  return {
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: SESSION,
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
      XDG_CONFIG_HOME: xdg,
    },
    sb,
  };
}

/** A repo with beads prefix `prefix`, its session bead filed for `sessionId`. */
function repo(w: World, prefix: string, sessionId: string): Repo {
  const path = initRepo(w.sb, `repo-${prefix}`, {'README.md': `# ${prefix}\n`});
  const init = runBr(path, ['init', '--prefix', prefix, '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: path,
    env: w.env,
    firstPrompt: {at: '2026-11-21T09:00:00.000Z', text: `Work in ${prefix}`},
    now: new Date('2026-11-21T09:00:01.000Z'),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return {
    beadsDir: join(path, '.beads'),
    path,
    sessionBeadId: filed.beadId,
  };
}

function br(r: Repo, args: string[]): string {
  const out = runBr(r.path, args);
  if (!out.ok) throw new Error(`br ${args.join(' ')}: ${out.reason ?? '?'}`);
  return out.stdout.trim();
}

function create(r: Repo, title: string): string {
  return br(r, ['create', title, '--silent']);
}

const HOUR = 3_600_000;
/** Filed before the br writes in the test, and filed after them. */
const BEFORE = (): string => new Date(Date.now() - HOUR).toISOString();
const AFTER = (): string => new Date(Date.now() + HOUR).toISOString();

let questionCount = 0;
function question(
  r: Repo,
  input: {
    createdAt: string;
    description?: string;
    labels?: string[];
    number?: number;
    title?: string;
  },
): TreeIssue {
  questionCount += 1;
  const id = `${r.sessionBeadId}.${String(100 + questionCount)}`;
  return {
    beadsDir: r.beadsDir,
    closeReason: null,
    closedAt: null,
    createdAt: input.createdAt,
    description: input.description ?? 'Form: answer\n\nDefault: I go on.',
    id,
    issueType: 'question',
    labels: [
      'ask',
      `sid:${SESSION}`,
      ...(input.number == null ? [] : [`qid:${String(input.number)}`]),
      ...(input.labels ?? []),
    ],
    notes: null,
    parentIds: [r.sessionBeadId],
    priority: 3,
    status: 'open',
    title: input.title ?? 'Should I build it?',
    updatedAt: input.createdAt,
  };
}

function toLabelOf(id: string): string {
  return `to:${id.replaceAll('.', ':')}`;
}

function check(w: World, r: Repo, questions: TreeIssue[]) {
  return checkQuestionMoves({
    ownDirs: [r.beadsDir],
    questions,
    readers: realQuestionMoveReaders(w.env),
    sessionBeadId: r.sessionBeadId,
  });
}

describe('checkQuestionMoves (home-base-5uu56.2.5)', () => {
  test('a to: bead closed after the question was filed gets the line; one closed before does not', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const target = create(r, 'Fix the throttling');
    br(r, ['close', target, '--reason', 'built']);

    const filedBefore = question(r, {
      createdAt: BEFORE(),
      labels: [toLabelOf(target)],
      number: 188,
    });
    const filedAfter = question(r, {
      createdAt: AFTER(),
      labels: [toLabelOf(target)],
    });
    const moves = check(w, r, [filedBefore, filedAfter]);
    expect(moves.unchecked).toEqual([]);
    expect(moves.moved.map((entry) => entry.question.id)).toEqual([
      filedBefore.id,
    ]);
    expect(moves.moved[0]?.moved).toMatchObject([{how: 'closed', id: target}]);

    const [line] = questionMoveMarks(moves, 'UTC');
    expect(line?.text).toContain(
      `⚠️ Q188 ("Should I build it?") names ${target}, closed `,
    );
    expect(line?.text).toContain('after the question was filed');
    expect(line?.code).toBe(`br close ${filedBefore.id} --reason "…"`);
  });

  test('a bead named only in the context text, closed after, counts', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const target = create(r, 'Upgrade bun');
    br(r, ['close', target, '--reason', 'done']);
    const q = question(r, {
      createdAt: BEFORE(),
      description: `Form: answer\n\nContext:\n- The suite work in ${target} needs a newer bun.\n\nDefault: I wait.`,
    });
    const moves = check(w, r, [q]);
    expect(moves.unchecked).toEqual([]);
    expect(moves.moved[0]?.moved).toMatchObject([{how: 'closed', id: target}]);
  });

  test('an open bead with a stage: label updated after counts; one with no stage label does not', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const staged = create(r, 'Build the Brave fix');
    const plain = create(r, 'Tidy the docs');
    const q = question(r, {
      createdAt: BEFORE(),
      labels: [toLabelOf(staged), toLabelOf(plain)],
    });
    br(r, ['update', staged, '--add-label', 'stage:code-done']);
    br(r, ['update', plain, '--add-label', 'routine']);

    const moves = check(w, r, [q]);
    expect(moves.unchecked).toEqual([]);
    expect(moves.moved).toHaveLength(1);
    expect(moves.moved[0]?.moved).toEqual([
      expect.objectContaining({
        how: 'staged',
        id: staged,
        stages: ['code-done'],
      }),
    ]);
    expect(questionMoveMarks(moves, 'UTC')[0]?.text).toContain(
      `${staged}, open with stage code-done and updated `,
    );
  });

  test('a bead in a second repo the sessions index knows counts (the Brave case)', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    // Another session filed its session bead in repo u, so the index knows u.
    const other = repo(w, 'u', OTHER);
    const brave = create(other, 'Fix the Brave throttling');
    br(other, ['update', brave, '--add-label', 'stage:code-done']);
    br(other, ['update', brave, '--add-label', 'stage:tested']);
    const q = question(r, {
      createdAt: BEFORE(),
      title: `Start a session in the other repo to build ${brave}?`,
    });
    const moves = check(w, r, [q]);
    expect(moves.unchecked).toEqual([]);
    expect(moves.moved[0]?.moved).toEqual([
      expect.objectContaining({how: 'staged', id: brave}),
    ]);
  });

  test('a named bead that cannot be read is a could-not-check line, never silence (rule 7)', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    // Repo v is known to the index, then its database goes away.
    const gone = repo(w, 'v', THIRD);
    rmSync(join(gone.beadsDir, 'beads.db'), {force: true});
    const q = question(r, {
      createdAt: BEFORE(),
      description:
        'Form: answer\n\nContext:\n- Also see t-zzzz9.\n\nDefault: I go on.',
      labels: [toLabelOf('v-abc1')],
      number: 190,
    });
    const moves = check(w, r, [q]);
    expect(moves.moved).toEqual([]);
    expect(moves.unchecked.map((item) => item.what).sort()).toEqual([
      't-zzzz9',
      'v-abc1',
    ]);
    const lines = questionMoveMarks(moves, 'UTC');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('⚠️ Could not check');
    expect(lines[0]?.text).toContain('t-zzzz9 (named by Q190): not found in');
    expect(lines[0]?.text).toContain(
      'v-abc1 (named by Q190): no beads DB for it could be opened',
    );
  });

  test('the question itself and its session bead are never targets', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const q = question(r, {
      createdAt: BEFORE(),
      title: `Asked in ${r.sessionBeadId}`,
    });
    const moves = check(w, r, [
      {
        ...q,
        description: `Form: answer\n\nContext:\n- I am ${q.id}.\n\nDefault: I go on.`,
      },
    ]);
    expect(moves).toEqual({moved: [], unchecked: []});
  });

  test('one br read per database, however many beads are named (S5)', () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const other = repo(w, 'u', OTHER);
    const inT = [create(r, 'a'), create(r, 'b'), create(r, 'c')];
    const inU = [create(other, 'd'), create(other, 'e')];
    for (const id of inT) br(r, ['close', id, '--reason', 'x']);
    for (const id of inU) br(other, ['close', id, '--reason', 'x']);
    const questions = [
      question(r, {
        createdAt: BEFORE(),
        labels: inT.slice(0, 2).map(toLabelOf),
      }),
      question(r, {
        createdAt: BEFORE(),
        title: `Is ${inT[2] ?? ''} or ${inU.join(' or ')} still wanted?`,
      }),
    ];

    // A br on PATH that logs each call, then runs the pinned br BY PATH: a
    // mise shim would look br up on PATH again and find this wrapper.
    if (PINNED_BR.kind !== 'pinned') {
      throw new Error(
        `the pinned br is needed to count calls: ${PINNED_BR.reason}`,
      );
    }
    const real = PINNED_BR.path;
    const bin = join(w.sb.path, 'counting-bin');
    mkdirSync(bin, {recursive: true});
    const log = join(w.sb.path, 'br-calls.log');
    writeFileSync(log, '');
    writeFileSync(
      join(bin, 'br'),
      `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, 'br'), 0o755);
    const env = {...w.env, PATH: `${bin}:${process.env.PATH ?? ''}`};

    const moves = checkQuestionMoves({
      ownDirs: [r.beadsDir],
      questions,
      readers: realQuestionMoveReaders(env),
      sessionBeadId: r.sessionBeadId,
    });
    expect(moves.unchecked).toEqual([]);
    expect(
      moves.moved.flatMap((entry) => entry.moved.map((bead) => bead.id)).sort(),
    ).toEqual([...inT, ...inU].sort());
    const shows = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => ` ${line} `.includes(' show '));
    expect(shows).toHaveLength(2);
    // A dozen br writes set this world up: room past bun's 5 s on a busy Mac.
  }, 30_000);
});

describe('thread status prints it in What to mark', () => {
  test('a question filed --to a request that was then closed', async () => {
    const w = world();
    const r = repo(w, 't', SESSION);
    const filed = await fileRequest({
      bead: null,
      cmux: () =>
        Promise.resolve({kind: 'failed', reason: 'no cmux', timedOut: false}),
      continues: null,
      cwd: r.path,
      doneWhen: null,
      env: w.env,
      here: false,
      overarching: false,
      sessionId: null,
      title: 'Build the export',
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    const asked = await fileAsk({
      approve: false,
      context: ['The export reads every table.'],
      cwd: r.path,
      default: 'I use Postgres.',
      do: false,
      env: w.env,
      header: null,
      options: [],
      priority: '3',
      question: 'Postgres or SQLite?',
      recommend: null,
      sessionId: null,
      to: filed.id,
    });
    if (asked.kind !== 'filed') throw new Error(`ask: ${asked.kind}`);
    br(r, ['close', filed.id, '--reason', 'built']);

    const printed: string[] = [];
    const errors: string[] = [];
    const spy = captureWriteStdout((text) => printed.push(text));
    const errorSpy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      },
    );
    let code: number;
    try {
      code = await runThreadStatus({
        cwd: r.path,
        env: w.env,
        sessionId: null,
        style: PLAIN_STYLE,
        timeZone: 'UTC',
      });
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(code).toBe(0);
    const marks = printed.join('\n').split('**What to mark:**')[1] ?? '';
    expect(marks).toContain(
      `("Postgres or SQLite?") names ${filed.id}, closed `,
    );
    expect(marks).toContain(`\`br close ${asked.id} --reason "…"\``);
  }, 30_000);
});

describe('toTargetOf', () => {
  test('reads a to: label back to the id it names', () => {
    expect(toTargetOf('to:home-base-kwand:19')).toBe('home-base-kwand.19');
    expect(toTargetOf('to:home-base-1vcgs')).toBe('home-base-1vcgs');
    expect(toTargetOf('sid:abc')).toBeNull();
  });
});
