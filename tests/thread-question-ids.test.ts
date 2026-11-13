/**
 * Question ids like BD7 (home-base-1rxt0.4 D4, dispatch B). The fixtures are
 * synthetic.
 *
 * Each rule sits beside a control that fails when the rule is taken away: the
 * successor's new question would be BD1 again without the chain walk, the
 * duplicate would print twice without the guard, and the old questions would
 * be numbered in another order without the sort.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {fileAsk} from '../src/thread/ask';
import {renderAsks} from '../src/thread/ask-render';
import {chainRootOf} from '../src/thread/handoff-number';
import {
  chainMaxNumber,
  parseShortId,
  planQuestionIds,
  questionIdLabelFor,
  questionIdOf,
  questionIdsShown,
} from '../src/thread/question-ids';
import {fileRequest} from '../src/thread/request';
import {answerSessionQuestions} from '../src/thread/session-answer';
import {ensureSessionBead} from '../src/thread/session-bead';
import {runThreadStatus} from '../src/thread/session-report';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

const SESSION = '9d000001-aaaa-4bbb-8ccc-0123456789ab';
const SUCCESSOR = '9d000002-aaaa-4bbb-8ccc-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function at(minute: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 9, minute));
}

function question(
  id: string,
  labels: string[],
  priority: number | null,
  minute: number,
): {createdAt: string; id: string; labels: string[]; priority: number | null} {
  return {createdAt: at(minute).toISOString(), id, labels, priority};
}

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

describe('short ids and their labels', () => {
  test('parseShortId reads BD7 in any case, and nothing else', () => {
    expect(parseShortId('BD7')).toBe(7);
    expect(parseShortId(' bd12 ')).toBe(12);
    expect(parseShortId('Bd3')).toBe(3);
    for (const text of ['7', 'Q7', 'BD', 'BD0', 'BD07', 'BD7a', 'B7', '#7']) {
      expect(parseShortId(text)).toBeNull();
    }
  });

  test('a label holds the chain root with its dots written as colons', () => {
    const label = questionIdLabelFor('t-abc.2', 7);
    expect(label).toEqual({label: 'qid:t-abc:2:7', ok: true});
    expect(questionIdOf(['ask', 'qid:t-abc:2:7'])).toEqual({
      kind: 'one',
      number: 7,
    });
    expect(questionIdLabelFor(`t-${'x'.repeat(60)}`, 1).ok).toBe(false);
  });

  test('no id, two ids, and an unreadable id are told apart', () => {
    expect(questionIdOf(['ask', 'sid:x'])).toEqual({kind: 'none'});
    expect(questionIdOf(['qid:t-a:1', 'qid:t-a:2']).kind).toBe('bad');
    expect(questionIdOf(['qid:t-a:x']).kind).toBe('bad');
  });

  test("chainMaxNumber counts only its own chain's labels", () => {
    const labels = ['qid:t-a:3', 'qid:t-a:12', 'qid:t-b:40', 'qid:t-a:2:9'];
    expect(chainMaxNumber(labels, 't-a')).toBe(12);
    expect(chainMaxNumber(labels, 't-a.2')).toBe(9);
    expect(chainMaxNumber(labels, 't-c')).toBe(0);
  });

  test('planQuestionIds: most urgent first, then oldest, after the highest', () => {
    const planned = planQuestionIds(
      [
        question('t-a.4', [], 3, 1),
        question('t-a.2', [], 1, 5),
        question('t-a.3', [], 1, 2),
        question('t-a.1', [], null, 0),
      ],
      4,
    );
    expect(planned).toEqual([
      {id: 't-a.3', number: 5},
      {id: 't-a.2', number: 6},
      {id: 't-a.4', number: 7},
      {id: 't-a.1', number: 8},
    ]);
  });
});

describe('questionIdsShown: never one id twice in a report', () => {
  test('of two questions that share a number, the later one shows its bead id', () => {
    const shown = questionIdsShown([
      question('t-b.9', ['qid:t-b:2'], 2, 7),
      question('t-a.2', ['qid:t-a:2'], 3, 1),
      question('t-a.3', ['qid:t-a:3'], 3, 2),
      question('t-a.4', [], 3, 3),
    ]);
    expect(shown.byId.get('t-a.2')).toEqual({text: 'BD2', why: null});
    expect(shown.byId.get('t-a.3')).toEqual({text: 'BD3', why: null});
    expect(shown.byId.get('t-b.9')?.text).toBe('t-b.9');
    expect(shown.byId.has('t-a.4')).toBe(false);
    expect(shown.notes).toEqual([
      't-b.9 is shown by its bead id because BD2 is also the id of t-a.2, filed earlier. Answer it by its bead id.',
    ]);
  });

  test('every shown text is unique, whatever the labels', () => {
    const questions = Array.from({length: 30}, (_, index) =>
      question(`t-q.${index}`, [`qid:t-${index % 3}:${index % 4}`], 2, index),
    );
    // Index 0, 4, 8 … carry the label `…:0`, which holds no number.
    const texts = [...questionIdsShown(questions).byId.values()].map(
      (entry) => entry.text,
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('the id goes in brackets after the number, in the full and the one-line form', () => {
    const asks = [
      {
        description: null,
        id: 't-a.2',
        priority: 2,
        title: 'Keep it?',
      },
    ];
    const ids = new Map([['t-a.2', 'BD2']]);
    const full = renderAsks(asks, {ids, style: PLAIN_STYLE});
    expect(full.split('\n')[0]).toBe('1. [BD2] 🟡 P2 · **Keep it?** (t-a.2)');
    const compact = renderAsks(asks, {
      ids,
      shown: new Map([['t-a.2', {compact: true, mark: 'changed' as const}]]),
      style: PLAIN_STYLE,
    });
    expect(compact).toBe('1. 🔄 [BD2] 🟡 P2 · **Keep it?** (t-a.2)');
  });
});

describe('chainRootOf', () => {
  const beads = new Map<string, string[]>([
    ['t-c', ['continues:t-b']],
    ['t-b', ['continues:t-a', 'handoff-number:1']],
    ['t-a', []],
    ['t-loop1', ['continues:t-loop2']],
    ['t-loop2', ['continues:t-loop1']],
    ['t-two', ['continues:t-a', 'continues:t-b']],
  ]);
  const readers = {
    showBead: (id: string) => {
      const labels = beads.get(id);
      return labels == null
        ? {kind: 'notFound' as const, reason: `${id} not here`}
        : {kind: 'found' as const, labels, title: id};
    },
  };

  test('walks past a stamped handoff number to the first session', () => {
    expect(
      chainRootOf({id: 't-c', labels: beads.get('t-c') ?? []}, readers),
    ).toEqual({kind: 'known', root: 't-a'});
    expect(chainRootOf({id: 't-a', labels: []}, readers)).toEqual({
      kind: 'known',
      root: 't-a',
    });
  });

  test('a loop, two predecessors, or a missing bead is unknown', () => {
    for (const id of ['t-loop1', 't-two']) {
      expect(chainRootOf({id, labels: beads.get(id) ?? []}, readers).kind).toBe(
        'unknown',
      );
    }
    expect(
      chainRootOf({id: 't-x', labels: ['continues:t-gone']}, readers).kind,
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// End to end, with a real br
// ---------------------------------------------------------------------------

interface World {
  env: Record<string, string | undefined>;
  projects: string;
  repo: string;
  request: string;
  sessionBead: string;
}

function envFor(
  sb: Sandbox,
  sessionId: string,
): Record<string, string | undefined> {
  return {
    CHORES_STATE_DIR: join(sb.path, 'chores-state'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: sessionId,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    VITALS_STATE_DIR: join(sb.path, 'vitals-state'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg'),
  };
}

function writeTranscript(projects: string, repo: string, id: string): void {
  const dir = join(projects, 'ids-repo');
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      cwd: repo,
      message: {content: 'Tidy the export', role: 'user'},
      sessionId: id,
      timestamp: at(0).toISOString(),
      type: 'user',
    })}\n`,
  );
}

const sandboxOf = new Map<World, Sandbox>();

async function world(): Promise<World> {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  mkdirSync(join(sb.path, 'xdg', 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(sb.path, 'xdg', 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, sessionBeads: true, trimGuard: true},
      },
    }),
  );
  const env = envFor(sb, SESSION);
  const repo = initRepo(sb, 'ids-repo', {'README.md': '# ids\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: at(0).toISOString(), text: 'Tidy the export'},
    now: at(0),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  const request = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env,
    here: false,
    now: at(0),
    sessionId: null,
    title: 'Tidy the export',
  });
  if (request.kind !== 'filed') throw new Error('request not filed');
  const projects = join(sb.path, 'projects');
  writeTranscript(projects, repo, SESSION);
  const w = {
    env,
    projects,
    repo,
    request: request.id,
    sessionBead: filed.beadId,
  };
  sandboxOf.set(w, sb);
  return w;
}

async function ask(
  w: World,
  priority: string,
  title: string,
  env = w.env,
): Promise<{id: string; shortId: null | string}> {
  const outcome = await fileAsk({
    approve: false,
    context: [`Context for ${title}`],
    cwd: w.repo,
    default: priority === '0' ? null : 'I go on.',
    do: false,
    env,
    header: null,
    options: [],
    priority,
    question: title,
    recommend: null,
    sessionId: null,
    to: w.request,
  });
  if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
  return {id: outcome.id, shortId: outcome.shortId};
}

async function status(w: World, now: Date, env = w.env): Promise<string> {
  const printed: string[] = [];
  const spy = captureWriteStdout((text) => printed.push(text));
  try {
    const code = await runThreadStatus({
      cwd: w.repo,
      env,
      now,
      sessionId: null,
      style: PLAIN_STYLE,
      timeZone: 'UTC',
    });
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return printed.join('\n');
}

function lineOf(out: string, id: string): string {
  return out.split('\n').find((line) => line.includes(`(${id})`)) ?? '';
}

function labelsOf(w: World, id: string): string[] {
  const shown = runBr(w.repo, ['show', id, '--json']);
  if (!shown.ok) throw new Error(`br show ${id} failed`);
  const parsed: unknown = JSON.parse(shown.stdout);
  const issue = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
  const labels =
    issue != null && typeof issue === 'object' && 'labels' in issue
      ? (issue as {labels: unknown}).labels
      : [];
  return Array.isArray(labels) ? labels.map(String) : [];
}

function idLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith('qid:'));
}

describe('thread ask and thread status: ids end to end', () => {
  test('ask numbers each question once, and every report shows the same ids', async () => {
    const w = await world();
    const p3 = await ask(w, '3', 'Gzip the output?');
    const p0 = await ask(w, '0', 'Which bucket?');
    expect(p3.shortId).toBe('BD1');
    expect(p0.shortId).toBe('BD2');
    expect(idLabels(labelsOf(w, p3.id))).toEqual([`qid:${w.sessionBead}:1`]);
    const first = await status(w, at(1));
    // The list keeps its priority numbering; the id follows the number.
    expect(lineOf(first, p0.id)).toMatch(/^1\. \[BD2\] 🛑 P0 · /u);
    expect(lineOf(first, p3.id)).toMatch(/^2\. \[BD1\] ⚪ P3 · /u);
    // The next turn: the P3 is one line, and keeps its id.
    writeFileSync(
      join(w.projects, 'ids-repo', `${SESSION}.jsonl`),
      `${JSON.stringify({durationMs: 1, subtype: 'turn_duration', timestamp: at(2).toISOString(), type: 'system'})}\n`,
      {flag: 'a'},
    );
    const next = await status(w, at(3));
    expect(next).not.toContain('Context for Gzip the output?');
    expect(lineOf(next, p3.id)).toMatch(/^2\. \[BD1\] ⚪ P3 · /u);
    expect(idLabels(labelsOf(w, p3.id))).toEqual([`qid:${w.sessionBead}:1`]);
  });

  test('questions filed before ids get one at the first report, in priority then age order, written once', async () => {
    const w = await world();
    // One question that keeps its id: the chain's highest number, BD1.
    const kept = await ask(w, '4', 'Labelled already?');
    const old = [];
    for (const [priority, title] of [
      ['3', 'Old P3?'],
      ['1', 'Old P1, first?'],
      ['1', 'Old P1, second?'],
    ] as const) {
      const filed = await ask(w, priority, title);
      // As if filed before ids existed.
      runBr(w.repo, [
        'update',
        filed.id,
        `--remove-label=qid:${w.sessionBead}:${filed.shortId?.slice(2) ?? ''}`,
      ]);
      old.push(filed.id);
    }
    const [p3, p1a, p1b] = old;
    if (p3 == null || p1a == null || p1b == null) throw new Error('no ids');
    // Numbered after the chain's highest (BD1), most urgent first, then oldest.
    const out = await status(w, at(1));
    expect(lineOf(out, p1a)).toMatch(/^1\. \[BD2\] /u);
    expect(lineOf(out, p1b)).toMatch(/^2\. \[BD3\] /u);
    expect(lineOf(out, p3)).toMatch(/^3\. \[BD4\] /u);
    expect(lineOf(out, kept.id)).toMatch(/^4\. \[BD1\] /u);
    const again = await status(w, at(2));
    expect(lineOf(again, p3)).toBe(lineOf(out, p3));
    expect(idLabels(labelsOf(w, p3))).toEqual([`qid:${w.sessionBead}:4`]);
  });

  test('a successor keeps the carried ids, and numbers its own after them', async () => {
    const w = await world();
    const a = await ask(w, '2', 'Keep the old export?');
    const b = await ask(w, '3', 'Rename the job?');
    await status(w, at(1));
    // The handoff: a successor bead that continues this one, and the open
    // questions carried to it (handoff-pickup.ts adds its sid label).
    const sb = sandboxOf.get(w);
    if (sb == null) throw new Error('no sandbox');
    const env2 = envFor(sb, SUCCESSOR);
    const next = ensureSessionBead({
      cwd: w.repo,
      env: env2,
      firstPrompt: {at: at(5).toISOString(), text: 'Continue'},
      now: at(5),
      sessionId: SUCCESSOR,
    });
    if (next.kind !== 'created') throw new Error(next.detail);
    runBr(w.repo, [
      'update',
      next.beadId,
      `--add-label=continues:${w.sessionBead}`,
    ]);
    for (const id of [a.id, b.id]) {
      runBr(w.repo, ['update', id, `--add-label=sid:${SUCCESSOR}`]);
    }
    writeTranscript(w.projects, w.repo, SUCCESSOR);
    const c = await ask(w, '2', 'Ship on Friday?', env2);
    expect(c.shortId).toBe('BD3');
    const out = await status(w, at(6), env2);
    expect(lineOf(out, a.id)).toContain('[BD1]');
    expect(lineOf(out, b.id)).toContain('[BD2]');
    expect(lineOf(out, c.id)).toContain('[BD3]');
  });

  test('two questions with one id in a report: the later shows its bead id, and the report says so', async () => {
    const w = await world();
    const mine = await ask(w, '2', 'Keep the old export?');
    // A question from another chain, held by this session (as an adopted
    // request's question would be), whose number is also 1.
    const other = await ask(w, '3', 'From the other chain?');
    runBr(w.repo, [
      'update',
      other.id,
      `--remove-label=qid:${w.sessionBead}:2`,
      '--add-label=qid:t-elsewhere:1',
    ]);
    const out = await status(w, at(1));
    expect(lineOf(out, mine.id)).toContain('[BD1]');
    expect(lineOf(out, other.id)).toContain(`[${other.id}]`);
    expect(out.split('[BD1]').length - 1).toBe(1);
    expect(out).toContain(
      `${other.id} is shown by its bead id because BD1 is also the id of ${mine.id}, filed earlier.`,
    );
  });
});

describe('thread answer --ask with a short id', () => {
  test('BD2 and bd2 answer the question shown as BD2; an unknown id is refused', async () => {
    const w = await world();
    const first = await ask(w, '2', 'Keep the old export?');
    const second = await ask(w, '3', 'Rename the job?');
    const answer = (id: string, text: string) =>
      answerSessionQuestions({
        ask: id,
        cwd: w.repo,
        env: w.env,
        selector: null,
        sessionId: null,
        style: PLAIN_STYLE,
        text,
      });
    const missing = await answer('BD9', 'yes');
    expect(missing.kind).toBe('failed');
    const done = await answer('bd2', 'no rename');
    expect(done).toMatchObject({
      id: second.id,
      kind: 'answeredOne',
      shortId: 'BD2',
      title: 'Rename the job?',
    });
    const closed = runBr(w.repo, ['show', second.id, '--json']);
    expect(closed.stdout).toContain('answer: no rename');
    const open = runBr(w.repo, ['show', first.id, '--json']);
    expect(open.stdout).not.toContain('answer: no rename');
    // A bare number is not an id.
    const bare = await answer('1', 'yes');
    expect(bare.kind).toBe('failed');
  });

  test('a number two questions share answers the one shown with it, never the other', async () => {
    const w = await world();
    await ask(w, '2', 'Keep the old export?');
    const other = await ask(w, '3', 'From the other chain?');
    runBr(w.repo, [
      'update',
      other.id,
      `--remove-label=qid:${w.sessionBead}:2`,
      '--add-label=qid:t-elsewhere:1',
    ]);
    const shared = await answerSessionQuestions({
      ask: 'BD1',
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: null,
      style: PLAIN_STYLE,
      text: 'yes',
    });
    // BD1 is the one shown as BD1; the other is answered by its bead id.
    expect(shared).toMatchObject({kind: 'answeredOne', shortId: 'BD1'});
    expect(shared.kind === 'answeredOne' ? shared.id : '').not.toBe(other.id);
  });
});
