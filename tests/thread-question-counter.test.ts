/**
 * The machine-wide question counter (home-base-4wfoz, D2 in
 * home-base-l2ejg.3). The fixtures are synthetic; every state dir and export
 * lives in the test's own $TMPDIR sandbox.
 *
 * Each rule has a control that fails when the rule is taken away: the seed
 * test fails without the export scan (100 instead of 251), the failure tests
 * fail when a failed read is taken as "nothing there", and the race test fails
 * without the lock (every child gets 100).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  qidLabelsIn,
  questionCounterPath,
  reserveQuestionNumbers,
} from '../src/thread/question-counter';
import {assignMissingQuestionIds} from '../src/thread/question-id-assign';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

interface Fixture {
  env: Record<string, string | undefined>;
  root: string;
}

function fixture(): Fixture {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {
    env: {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')},
    root: sb.path,
  };
}

/** One export line holding `labels`, as br writes it. */
function line(id: string, status: string, labels: string[]): string {
  return JSON.stringify({
    description: `Question ${id}`,
    id,
    issue_type: 'question',
    labels,
    status,
    title: `Question ${id}?`,
  });
}

/** A repo's `.beads/` with a (fake) DB and an export of `lines`. */
function beadsDir(f: Fixture, repo: string, lines: string[]): string {
  const dir = join(f.root, repo, '.beads');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'beads.db'), '');
  writeFileSync(join(dir, 'issues.jsonl'), `${lines.join('\n')}\n`);
  return dir;
}

/** The sessions index naming `dirs`, one session each. */
function sessionsIndex(f: Fixture, dirs: string[]): void {
  const state = join(f.root, 'state');
  mkdirSync(state, {recursive: true});
  writeFileSync(
    join(state, 'sessions.jsonl'),
    dirs
      .map((dir, index) =>
        JSON.stringify({
          at: '2030-01-01T09:00:00.000Z',
          beadId: `t-s${index}`,
          beadsDir: dir,
          branch: 'main',
          checkoutPath: join(dir, '..'),
          event: 'created',
          repo: `repo${index}`,
          sessionId: `0000000${index}-aaaa-4bbb-8ccc-0123456789ab`,
        }),
      )
      .map((text) => `${text}\n`)
      .join(''),
  );
}

function reserve(f: Fixture, count: number) {
  return reserveQuestionNumbers({count, env: f.env});
}

describe('the seed: above 99 and above every number any export holds', () => {
  test('with no export holding a number, the first id is Q100, and the counter only goes up', () => {
    const f = fixture();
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [100]});
    expect(reserve(f, 3)).toEqual({kind: 'reserved', numbers: [101, 102, 103]});
    const saved: unknown = JSON.parse(
      readFileSync(questionCounterPath(f.env), 'utf8'),
    );
    expect(saved).toMatchObject({last: 103});
    expect(reserve(f, 0)).toEqual({kind: 'reserved', numbers: []});
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [104]});
  });

  test('the first id is above every qid number in every known export, old form or new, open or closed', () => {
    const f = fixture();
    const a = beadsDir(f, 'repo-a', [
      line('t-a.1', 'closed', ['ask', 'qid:home-base-yf73y:7']),
      line('t-a.2', 'closed', ['ask', 'qid:250']),
      line('t-a.3', 'open', ['ask', 'sid:x']),
    ]);
    const b = beadsDir(f, 'repo-b', [
      line('t-b.1', 'open', ['ask', 'qid:home-base-sg9q9:23']),
    ]);
    // Control: exports the sessions index does not name are not read.
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [100]});
    sessionsIndex(f, [a, b]);
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [251]});
  });

  test("the caller's own dir is read even when the index does not name it", () => {
    const f = fixture();
    const own = beadsDir(f, 'repo-own', [line('t-o.1', 'open', ['qid:180'])]);
    expect(
      reserveQuestionNumbers({beadsDirs: [own], count: 1, env: f.env}),
    ).toEqual({kind: 'reserved', numbers: [181]});
  });

  test('a missing counter file is re-derived the same way; a present one wins when higher', () => {
    const f = fixture();
    const a = beadsDir(f, 'repo-a', [line('t-a.1', 'open', ['qid:250'])]);
    sessionsIndex(f, [a]);
    mkdirSync(join(f.root, 'state', 'question-ids'), {recursive: true});
    writeFileSync(questionCounterPath(f.env), '{"last": 300}\n');
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [301]});
    // The file is lost; the labels it handed out are in the export.
    writeFileSync(
      join(a, 'issues.jsonl'),
      `${[line('t-a.1', 'open', ['qid:250']), line('t-a.2', 'open', ['qid:301'])].join('\n')}\n`,
    );
    rmSync(questionCounterPath(f.env));
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [302]});
  });

  test('a label-shaped string inside a description is not a label', () => {
    const bytes = Buffer.from(
      `${JSON.stringify({description: 'see "qid:999" and qid:998', labels: ['qid:12', 'qid:t-a:3']})}\n`,
    );
    expect(qidLabelsIn(bytes)).toEqual(['qid:12', 'qid:t-a:3']);
  });
});

describe('failure is not empty: nothing is handed out, and the counter is left as it was', () => {
  test("a gone worktree's dir holds nothing, and is not a failure", () => {
    const f = fixture();
    const a = beadsDir(f, 'repo-a', [line('t-a.1', 'open', ['qid:140'])]);
    sessionsIndex(f, [a, join(f.root, 'gone-repo', '.beads')]);
    expect(reserve(f, 1)).toEqual({kind: 'reserved', numbers: [141]});
  });

  test('an export that cannot be read', () => {
    const f = fixture();
    const a = beadsDir(f, 'repo-a', [line('t-a.1', 'open', ['qid:140'])]);
    const broken = join(f.root, 'repo-b', '.beads');
    mkdirSync(join(broken, 'issues.jsonl'), {recursive: true});
    writeFileSync(join(broken, 'beads.db'), '');
    sessionsIndex(f, [a, broken]);
    const outcome = reserve(f, 2);
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      join(broken, 'issues.jsonl'),
    );
    expect(existsSync(questionCounterPath(f.env))).toBe(false);
  });

  test('a sessions index that cannot be read', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'state', 'sessions.jsonl'), {recursive: true});
    const outcome = reserve(f, 1);
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'sessions index',
    );
    expect(existsSync(questionCounterPath(f.env))).toBe(false);
  });

  test('a counter file that holds no number', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'state', 'question-ids'), {recursive: true});
    writeFileSync(questionCounterPath(f.env), '{"last": "lots"}\n');
    const outcome = reserve(f, 1);
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'holds no "last" number',
    );
    expect(readFileSync(questionCounterPath(f.env), 'utf8')).toBe(
      '{"last": "lots"}\n',
    );
  });

  test('br refusing every label write: one line names the reason once, with every question it stopped', () => {
    const f = fixture();
    const dir = beadsDir(f, 'repo-a', []);
    const questions = ['t-a.1', 't-a.2', 't-a.3'].map((id, index) => ({
      beadsDir: dir,
      createdAt: `2030-01-01T09:0${index}:00.000Z`,
      id,
      labels: ['ask', `qid:t-a:${index + 1}`],
      priority: 2,
    }));
    const reason = 'Schema version mismatch: expected 19, found 4';
    const ids = assignMissingQuestionIds({
      beadsDir: dir,
      env: f.env,
      questions,
      reserve: () => ({kind: 'reserved', numbers: [100, 101, 102]}),
      update: () => ({
        command: 'br update',
        detail: [],
        kind: 'failed',
        reason,
      }),
    });
    expect(ids.assigned).toEqual([]);
    expect(ids.problems).toEqual([
      `t-a.1, t-a.2, t-a.3 have no id, so they are shown by bead id: br could not write the id label: ${reason}`,
    ]);
  });
});

describe('the lock: racing callers never share a number', () => {
  test('four processes reading the counter at the same moment get four different numbers', async () => {
    const f = fixture();
    const child = join(
      import.meta.dirname,
      'fixtures',
      'reserve-question-number-child.ts',
    );
    // Each child holds the lock 150 ms between its read and its write, so
    // without the lock every one of them reads the same `last`.
    const startAt = Date.now() + 1500;
    const env = Object.fromEntries(
      Object.entries({...process.env, ...f.env}).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    const runs = Array.from({length: 4}, () =>
      Bun.spawn([process.execPath, child, String(startAt), '150'], {
        env,
        stderr: 'pipe',
        stdout: 'pipe',
      }),
    );
    const outcomes = await Promise.all(
      runs.map(async (run) => {
        const text = await new Response(run.stdout).text();
        expect(await run.exited).toBe(0);
        return JSON.parse(text) as {kind: string; numbers?: number[]};
      }),
    );
    const numbers = outcomes.flatMap((outcome) => outcome.numbers ?? []);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'reserved',
      'reserved',
      'reserved',
      'reserved',
    ]);
    expect([...numbers].sort((x, y) => x - y)).toEqual([100, 101, 102, 103]);
  }, 15_000);
});
