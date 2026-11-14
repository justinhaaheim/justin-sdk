/**
 * Question ids like BD107 (home-base-1rxt0.4 D4, dispatch B; numbered
 * machine-wide by home-base-4wfoz, D2 in home-base-l2ejg.3). The fixtures are
 * synthetic, except the two session chains of home-base-4wfoz's description,
 * whose real old labels are copied below.
 *
 * Each rule sits beside a control that fails when the rule is taken away: the
 * two chains would show BD1, BD4 and BD7 twice if old ids were still shown,
 * the duplicate would print twice without the guard, the old questions would
 * be numbered in another order without the sort, and a counter that could not
 * be read would hand out a number if a failed read were taken as "no file".
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {describeAskOutcome, fileAsk} from '../src/thread/ask';
import {renderAsks} from '../src/thread/ask-render';
import {chainRootOf} from '../src/thread/handoff-number';
import {PART_ONE_RULE, PART_ONE_SEPARATOR} from '../src/thread/part-one';
import {
  questionCounterPath,
  type reserveQuestionNumbers,
} from '../src/thread/question-counter';
import {
  chainNumbersOf,
  maxQuestionNumber,
  parseQuestionIdLabel,
  parseShortId,
  planQuestionIds,
  questionIdLabel,
  questionIdOf,
  questionIdsShown,
} from '../src/thread/question-ids';
import {readShownQuestionIds} from '../src/thread/question-ids-read';
import {fileRequest} from '../src/thread/request';
import {answerSessionQuestions} from '../src/thread/session-answer';
import {ensureSessionBead, resolveSession} from '../src/thread/session-bead';
import {runThreadStatus} from '../src/thread/session-report';
import {runThreadStopCheck} from '../src/thread/stop-check';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

const SESSION = '9d000001-aaaa-4bbb-8ccc-0123456789ab';
const SUCCESSOR = '9d000002-aaaa-4bbb-8ccc-0123456789ab';
const OTHER_CHAIN = '9d000003-aaaa-4bbb-8ccc-0123456789ab';

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
  test('parseShortId reads BD107 in any case, and nothing else', () => {
    expect(parseShortId('BD107')).toBe(107);
    expect(parseShortId(' bd12 ')).toBe(12);
    expect(parseShortId('Bd3')).toBe(3);
    for (const text of ['7', 'Q7', 'BD', 'BD0', 'BD07', 'BD7a', 'B7', '#7']) {
      expect(parseShortId(text)).toBeNull();
    }
  });

  test('a label is read in the D2 form and the old per-chain form', () => {
    expect(questionIdLabel(107)).toBe('qid:107');
    expect(parseQuestionIdLabel('qid:107')).toEqual({
      form: 'machine',
      number: 107,
    });
    expect(parseQuestionIdLabel('qid:t-abc:2:7')).toEqual({
      form: 'chain',
      number: 7,
      root: 't-abc:2',
    });
    for (const label of [
      'qid:t-a:x',
      'qid:0',
      'qid:',
      'qid:t-a::5',
      'qid:5\\',
    ]) {
      expect(parseQuestionIdLabel(label)).toEqual({form: 'unreadable'});
    }
    expect(parseQuestionIdLabel('sid:x')).toBeNull();
  });

  test('only a D2 label is an id; an old one alone is none, and two D2 ids or an unreadable one is bad', () => {
    expect(questionIdOf(['ask', 'sid:x'])).toEqual({kind: 'none'});
    expect(questionIdOf(['ask', 'qid:t-a:4'])).toEqual({kind: 'none'});
    expect(questionIdOf(['qid:t-a:4', 'qid:104'])).toEqual({
      kind: 'one',
      number: 104,
    });
    expect(questionIdOf(['qid:101', 'qid:102']).kind).toBe('bad');
    expect(questionIdOf(['qid:t-a:x']).kind).toBe('bad');
  });

  test('old numbers and the highest number are read from either form', () => {
    expect(chainNumbersOf(['qid:t-a:4', 'qid:104', 'qid:t-b:2:9'])).toEqual([
      4, 9,
    ]);
    expect(
      maxQuestionNumber(['qid:t-a:3', 'qid:t-a:23', 'qid:12', 'qid:x', 'ask']),
    ).toBe(23);
    expect(maxQuestionNumber(['qid:t-a:3', 'qid:150'])).toBe(150);
  });

  test('planQuestionIds: most urgent first, then oldest, onto the numbers given', () => {
    const planned = planQuestionIds(
      [
        question('t-a.4', [], 3, 1),
        question('t-a.2', [], 1, 5),
        question('t-a.3', [], 1, 2),
        question('t-a.1', [], null, 0),
      ],
      [105, 106, 107, 108],
    );
    expect(planned).toEqual([
      {id: 't-a.3', number: 105},
      {id: 't-a.2', number: 106},
      {id: 't-a.4', number: 107},
      {id: 't-a.1', number: 108},
    ]);
    expect(planQuestionIds([question('t-a.4', [], 3, 1)], [])).toEqual([]);
  });
});

describe('questionIdsShown: never one id twice in a report', () => {
  test('of two questions that share a number, the later one shows its bead id; an old id is not shown', () => {
    const shown = questionIdsShown([
      question('t-b.9', ['qid:102'], 2, 7),
      question('t-a.2', ['qid:102'], 3, 1),
      question('t-a.3', ['qid:103'], 3, 2),
      question('t-a.4', ['qid:t-a:4'], 3, 3),
    ]);
    expect(shown.byId.get('t-a.2')).toEqual({text: 'BD102', why: null});
    expect(shown.byId.get('t-a.3')).toEqual({text: 'BD103', why: null});
    expect(shown.byId.get('t-b.9')?.text).toBe('t-b.9');
    expect(shown.byId.has('t-a.4')).toBe(false);
    expect(shown.notes).toEqual([
      't-b.9 is shown by its bead id because BD102 is also the id of t-a.2, filed earlier. Answer it by its bead id.',
    ]);
  });

  test('every shown text is unique, whatever the labels', () => {
    const questions = Array.from({length: 30}, (_, index) =>
      question(
        `t-q.${index}`,
        [
          index % 2 === 0
            ? `qid:${index % 4}`
            : `qid:t-${index % 3}:${index % 4}`,
        ],
        2,
        index,
      ),
    );
    // Index 0, 4, 8 … carry the label `qid:0`, which holds no number.
    const texts = [...questionIdsShown(questions).byId.values()].map(
      (entry) => entry.text,
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('the two real chains of home-base-4wfoz: no old id is shown, so BD1, BD4 and BD7 cannot mean two questions', () => {
    // Copied from home-base's export, 2026-11-14 (the mayor chain's root is
    // home-base-yf73y; the job-alerts chain's is home-base-sg9q9).
    const mayor = [
      question('home-base-l5jmb.4', ['ask', 'qid:home-base-yf73y:1'], 2, 1),
      question('home-base-l5jmb.2', ['ask', 'qid:home-base-yf73y:4'], 1, 2),
      question('home-base-uv408.3', ['ask', 'qid:home-base-yf73y:7'], 2, 3),
    ];
    const jobAlerts = [
      question('home-base-sg9q9.4', ['ask', 'qid:home-base-sg9q9:1'], 1, 4),
      question('home-base-omojj.1', ['ask', 'qid:home-base-sg9q9:4'], 2, 5),
      question('home-base-omojj.3', ['ask', 'qid:home-base-sg9q9:7'], 3, 6),
    ];
    for (const report of [mayor, jobAlerts]) {
      expect(questionIdsShown(report).byId.size).toBe(0);
    }
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
    const ids = new Map([['t-a.2', 'BD102']]);
    const full = renderAsks(asks, {ids, style: PLAIN_STYLE});
    expect(full.split('\n')[0]).toBe('1. [BD102] 🟡 P2 · **Keep it?** (t-a.2)');
    const compact = renderAsks(asks, {
      ids,
      shown: new Map([['t-a.2', {compact: true, mark: 'changed' as const}]]),
      style: PLAIN_STYLE,
    });
    expect(compact).toBe('1. 🔄 [BD102] 🟡 P2 · **Keep it?** (t-a.2)');
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
  state: string;
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
    state: join(sb.path, 'state'),
  };
  sandboxOf.set(w, sb);
  return w;
}

/** A second session in the same repo, on a chain of its own. */
function secondSession(
  w: World,
  sessionId: string,
  minute: number,
): {env: Record<string, string | undefined>; sessionBead: string} {
  const sb = sandboxOf.get(w);
  if (sb == null) throw new Error('no sandbox');
  const env = envFor(sb, sessionId);
  const filed = ensureSessionBead({
    cwd: w.repo,
    env,
    firstPrompt: {at: at(minute).toISOString(), text: 'Watch the jobs'},
    now: at(minute),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  writeTranscript(w.projects, w.repo, sessionId);
  return {env, sessionBead: filed.beadId};
}

type Filed = Extract<Awaited<ReturnType<typeof fileAsk>>, {kind: 'filed'}>;

async function ask(
  w: World,
  priority: string,
  title: string,
  env = w.env,
  readShownIds?: typeof readShownQuestionIds,
  reserve?: typeof reserveQuestionNumbers,
): Promise<{id: string; outcome: Filed; shortId: null | string}> {
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
    readShownIds,
    recommend: null,
    reserveQuestionNumbers: reserve,
    sessionId: null,
    // A request of this world's first session; a second session's question
    // is filed without one.
    to: env === w.env ? w.request : null,
  });
  if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
  return {id: outcome.id, outcome, shortId: outcome.shortId};
}

/** Swap a question's labels, as a hand edit or an older SDK would leave them. */
function relabel(w: World, id: string, remove: string[], add: string[]): void {
  const moved = runBr(w.repo, [
    'update',
    id,
    ...remove.map((label) => `--remove-label=${label}`),
    ...add.map((label) => `--add-label=${label}`),
  ]);
  if (!moved.ok) throw new Error(`br update ${id} failed`);
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

/** What the brackets on a question's line hold, or null for none. */
function bracketOf(out: string, id: string): null | string {
  return /^\d+\. (?:\S+ )?\[([^\]]+)\] /u.exec(lineOf(out, id))?.[1] ?? null;
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

function statusOf(w: World, id: string): string {
  const shown = runBr(w.repo, ['show', id, '--json']);
  if (!shown.ok) throw new Error(`br show ${id} failed`);
  const parsed: unknown = JSON.parse(shown.stdout);
  const issue = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
  return issue != null && typeof issue === 'object' && 'status' in issue
    ? String((issue as {status: unknown}).status)
    : '';
}

function idLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith('qid:')).sort();
}

function answer(w: World, id: string, text: string, env = w.env) {
  return answerSessionQuestions({
    ask: id,
    cwd: w.repo,
    env,
    selector: null,
    sessionId: null,
    style: PLAIN_STYLE,
    text,
  });
}

describe('thread ask and thread status: ids end to end', () => {
  test('ask numbers each question once from BD100, and every report shows the same ids', async () => {
    const w = await world();
    const p3 = await ask(w, '3', 'Gzip the output?');
    const p0 = await ask(w, '0', 'Which bucket?');
    expect(p3.shortId).toBe('BD100');
    expect(p0.shortId).toBe('BD101');
    expect(idLabels(labelsOf(w, p3.id))).toEqual(['qid:100']);
    const first = await status(w, at(1));
    // The list keeps its priority numbering; the id follows the number.
    expect(lineOf(first, p0.id)).toMatch(/^1\. \[BD101\] 🛑 P0 · /u);
    expect(lineOf(first, p3.id)).toMatch(/^2\. \[BD100\] ⚪ P3 · /u);
    // The turn ends with the block pasted (home-base-sg9q9.11 F1: only a
    // report Justin was shown counts), then the next turn: the P3 is one line,
    // and keeps its id.
    const start = first.indexOf(PART_ONE_RULE);
    const end = first.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length;
    const stop = runThreadStopCheck({
      env: w.env,
      now: at(2),
      stdin: JSON.stringify({
        cwd: w.repo,
        hook_event_name: 'Stop',
        last_assistant_message: first.slice(start, end),
        session_id: SESSION,
      }),
    });
    expect(stop.exitCode).toBe(0);
    writeFileSync(
      join(w.projects, 'ids-repo', `${SESSION}.jsonl`),
      `${JSON.stringify({durationMs: 1, subtype: 'turn_duration', timestamp: at(2).toISOString(), type: 'system'})}\n`,
      {flag: 'a'},
    );
    const next = await status(w, at(3));
    expect(next).not.toContain('Context for Gzip the output?');
    expect(lineOf(next, p3.id)).toMatch(/^2\. \[BD100\] ⚪ P3 · /u);
    expect(idLabels(labelsOf(w, p3.id))).toEqual(['qid:100']);
  });

  test('questions filed before D2 get a new id at the first report, even when they hold an old one, in priority then age order, written once', async () => {
    const w = await world();
    // One question that keeps its id: BD100.
    const kept = await ask(w, '4', 'Labelled already?');
    const old = [];
    for (const [priority, title, oldLabel] of [
      ['3', 'Old P3?', `qid:${w.sessionBead}:3`],
      ['1', 'Old P1, first?', `qid:${w.sessionBead}:1`],
      ['1', 'Old P1, second?', null],
    ] as const) {
      const filed = await ask(w, priority, title);
      // As if filed before D2: an old per-chain label, or none at all.
      relabel(
        w,
        filed.id,
        [questionIdLabel(Number(filed.shortId?.slice(2)))],
        oldLabel == null ? [] : [oldLabel],
      );
      old.push(filed.id);
    }
    const [p3, p1a, p1b] = old;
    if (p3 == null || p1a == null || p1b == null) throw new Error('no ids');
    // The counter handed out 100 to 103 at filing; the next are 104 on, most
    // urgent first, then oldest.
    const out = await status(w, at(1));
    expect(lineOf(out, p1a)).toMatch(/^1\. \[BD104\] /u);
    expect(lineOf(out, p1b)).toMatch(/^2\. \[BD105\] /u);
    expect(lineOf(out, p3)).toMatch(/^3\. \[BD106\] /u);
    expect(lineOf(out, kept.id)).toMatch(/^4\. \[BD100\] /u);
    // No old id is shown.
    expect(out).not.toMatch(/\[BD[13]\]/u);
    const again = await status(w, at(2));
    expect(lineOf(again, p3)).toBe(lineOf(out, p3));
    // The old label stays, never rewritten; the new one is added once.
    expect(idLabels(labelsOf(w, p3))).toEqual([
      'qid:106',
      `qid:${w.sessionBead}:3`,
    ]);
  });

  test('the two real chains of home-base-4wfoz: after each session reports, no two open questions share an id', async () => {
    const w = await world();
    const jobs = secondSession(w, OTHER_CHAIN, 10);
    // The six open questions of the description, with their real old labels:
    // BD1, BD4 and BD7 in each chain.
    const chains = [
      {env: w.env, root: 'home-base-yf73y'},
      {env: jobs.env, root: 'home-base-sg9q9'},
    ];
    const filed: {env: typeof w.env; id: string}[] = [];
    for (const chain of chains) {
      for (const [priority, number] of [
        ['1', 1],
        ['2', 4],
        ['3', 7],
      ] as const) {
        const q = await ask(
          w,
          priority,
          `${chain.root} BD${number}?`,
          chain.env,
        );
        relabel(
          w,
          q.id,
          [questionIdLabel(Number(q.shortId?.slice(2)))],
          [`qid:${chain.root}:${number}`],
        );
        filed.push({env: chain.env, id: q.id});
      }
    }
    const mayorReport = await status(w, at(11), w.env);
    const jobsReport = await status(w, at(12), jobs.env);
    const shown = filed.map(({env, id}) =>
      bracketOf(env === w.env ? mayorReport : jobsReport, id),
    );
    // Every question has an id, every id is new (100 and above), and no id
    // names two questions across the two reports.
    for (const text of shown) expect(text).toMatch(/^BD[1-9][0-9]{2,}$/u);
    expect(new Set(shown).size).toBe(filed.length);
    for (const report of [mayorReport, jobsReport]) {
      expect(report).not.toMatch(/\[BD[147]\]/u);
    }
  });

  test('a successor keeps the carried ids, and its own come from the same counter', async () => {
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
    expect(c.shortId).toBe('BD102');
    const out = await status(w, at(6), env2);
    expect(lineOf(out, a.id)).toContain('[BD100]');
    expect(lineOf(out, b.id)).toContain('[BD101]');
    expect(lineOf(out, c.id)).toContain('[BD102]');
  });

  test('two questions with one id in a report: the later shows its bead id, and the report says so', async () => {
    const w = await world();
    const mine = await ask(w, '2', 'Keep the old export?');
    // A hand-edited label: the counter never hands one number out twice.
    const other = await ask(w, '3', 'Hand-labelled?');
    relabel(w, other.id, ['qid:101'], ['qid:100']);
    const out = await status(w, at(1));
    expect(lineOf(out, mine.id)).toContain('[BD100]');
    expect(lineOf(out, other.id)).toContain(`[${other.id}]`);
    expect(out.split('[BD100]').length - 1).toBe(1);
    expect(out).toContain(
      `${other.id} is shown by its bead id because BD100 is also the id of ${mine.id}, filed earlier.`,
    );
  });

  test('a counter that cannot be read mints nothing: the question shows its bead id and the report says why, once', async () => {
    const w = await world();
    const filed = await ask(w, '2', 'Keep the old export?');
    // A question from before D2, holding only an old id.
    relabel(w, filed.id, ['qid:100'], [`qid:${w.sessionBead}:4`]);
    writeFileSync(questionCounterPath(w.env), '{"last": "lots"}\n');
    const out = await status(w, at(1));
    expect(bracketOf(out, filed.id)).toBeNull();
    expect(lineOf(out, filed.id)).toContain(`(${filed.id})`);
    expect(out).not.toMatch(/\[BD[0-9]+\]/u);
    const why =
      '1 question has no id yet, so it is shown by bead id: the question counter could not be read:';
    expect(out.split(why).length - 1).toBe(1);
    expect(out).toContain('holds no "last" number');
    expect(idLabels(labelsOf(w, filed.id))).toEqual([`qid:${w.sessionBead}:4`]);

    // thread ask files the question without an id, and says so.
    const next = await ask(w, '3', 'Rename the job?');
    expect(next.shortId).toBeNull();
    expect(next.outcome.shownAs.kind).toBe('none');
    expect(idLabels(labelsOf(w, next.id))).toEqual([]);
    const printed = describeAskOutcome(next.outcome, PLAIN_STYLE);
    expect(printed.lines[1]).toStartWith(
      `⚠️ No id like BD107 yet, so refer to it by its bead id: ${next.id}.`,
    );
  });
});

describe('thread answer --ask with a short id', () => {
  test('BD101 and bd101 answer the question that holds it; an unknown id is refused', async () => {
    const w = await world();
    const first = await ask(w, '2', 'Keep the old export?');
    const second = await ask(w, '3', 'Rename the job?');
    const missing = await answer(w, 'BD109', 'yes');
    expect(missing.kind).toBe('failed');
    expect(missing.kind === 'failed' ? missing.reason : '').toContain(
      'No question in any known repo holds BD109.',
    );
    const done = await answer(w, 'bd101', 'no rename');
    expect(done).toMatchObject({
      id: second.id,
      kind: 'answeredOne',
      shortId: 'BD101',
      title: 'Rename the job?',
    });
    const closed = runBr(w.repo, ['show', second.id, '--json']);
    expect(closed.stdout).toContain('answer: no rename');
    const open = runBr(w.repo, ['show', first.id, '--json']);
    expect(open.stdout).not.toContain('answer: no rename');
    // A bare number is not an id.
    const bare = await answer(w, '1', 'yes');
    expect(bare.kind).toBe('failed');
  });

  test('an id another session holds is refused with where it lives, and nothing is written', async () => {
    const w = await world();
    const jobs = secondSession(w, OTHER_CHAIN, 10);
    const mine = await ask(w, '2', 'Keep the old export?');
    const theirs = await ask(w, '2', 'Let jobs control cmux?', jobs.env);
    expect(theirs.shortId).toBe('BD101');
    const refused = await answer(w, 'BD101', 'yes');
    expect(refused.kind).toBe('failed');
    const reason = refused.kind === 'failed' ? refused.reason : '';
    expect(reason).toContain(
      `BD101 is not an open question of this session (${w.sessionBead}`,
    );
    expect(reason).toContain('nothing was recorded');
    expect(reason).toContain(
      `${theirs.id} in ids-repo, filed under ${jobs.sessionBead}`,
    );
    expect(reason).toContain('"Let jobs control cmux?" (open)');
    expect(reason).toContain('Did you mean that question?');
    expect(statusOf(w, theirs.id)).toBe('open');
    expect(statusOf(w, mine.id)).toBe('open');
  });

  test('an old per-chain id answers inside its own session when it names one question there', async () => {
    const w = await world();
    const jobs = secondSession(w, OTHER_CHAIN, 10);
    // Each chain's BD4 from before D2.
    const mine = await ask(w, '2', 'Stop the threads push?');
    relabel(w, mine.id, ['qid:100'], ['qid:home-base-yf73y:4']);
    const theirs = await ask(w, '2', 'Let jobs control cmux?', jobs.env);
    relabel(w, theirs.id, ['qid:101'], ['qid:home-base-sg9q9:4']);
    // Each session's report gives its question a new id.
    await status(w, at(11), w.env);
    await status(w, at(12), jobs.env);
    const done = await answer(w, 'BD4', 'yes, stop it');
    expect(done).toMatchObject({
      id: mine.id,
      kind: 'answeredOne',
      title: 'Stop the threads push?',
    });
    expect(statusOf(w, theirs.id)).toBe('open');
  });

  test('an id that names two questions of this session is refused, and nothing is written', async () => {
    const w = await world();
    const first = await ask(w, '2', 'Keep the old export?');
    const other = await ask(w, '3', 'Hand-labelled?');
    relabel(w, other.id, ['qid:101'], ['qid:100']);
    const shared = await answer(w, 'BD100', 'yes');
    expect(shared.kind).toBe('failed');
    const reason = shared.kind === 'failed' ? shared.reason : '';
    expect(reason).toContain('BD100 names 2 open questions of');
    expect(reason).toContain(`${first.id} "Keep the old export?"`);
    expect(reason).toContain(`${other.id} "Hand-labelled?"`);
    expect(reason).toContain('Which one did you mean?');
    expect(statusOf(w, first.id)).toBe('open');
    expect(statusOf(w, other.id)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// home-base-sg9q9.11 F4: thread ask prints only what the report shows
// ---------------------------------------------------------------------------

describe('thread ask prints the id the report shows, never a guess', () => {
  test('two questions share a number: ask names the new one by its bead id, as the report does', async () => {
    const w = await world();
    // The older question is hand-labelled 101. The real counter would skip
    // past it (it reads every export), so a counter that does not is
    // injected: the guard below is for a number shared despite the counter.
    const other = await ask(w, '3', 'Hand-labelled?');
    relabel(w, other.id, ['qid:100'], ['qid:101']);
    const mine = await ask(
      w,
      '2',
      'Keep the old export?',
      w.env,
      undefined,
      () => ({
        kind: 'reserved',
        numbers: [101],
      }),
    );
    expect(mine.shortId).toBe('BD101');
    expect(idLabels(labelsOf(w, mine.id))).toEqual(['qid:101']);
    const why = `BD101 is also the id of ${other.id}, filed earlier`;
    expect(mine.outcome.shownAs).toEqual({kind: 'beadId', why});

    const printed = describeAskOutcome(mine.outcome, PLAIN_STYLE);
    const text = printed.lines.join('\n');
    expect(printed.exitCode).toBe(0);
    // The first line keeps the shape a caller parses: `ask <bead id> · …`.
    expect(/^ask (\S+) · /.exec(printed.lines[0] ?? '')?.[1]).toBe(mine.id);
    expect(printed.lines[0]).toStartWith(
      `ask ${mine.id} · 🟡 P2 · filed under ${w.sessionBead}`,
    );
    expect(text).not.toContain('BD101 ·');
    expect(text).not.toContain('[BD101]');
    expect(printed.lines[1]).toBe(
      `⚠️ The report shows this question by its bead id, because ${why}. Answer it by its bead id: ${mine.id}.`,
    );
    expect(text).toContain(`1. [${mine.id}] 🟡 P2 · `);

    // The report agrees: the new question by its bead id, the older as BD101.
    const out = await status(w, at(1));
    expect(lineOf(out, mine.id)).toContain(`[${mine.id}]`);
    expect(lineOf(out, other.id)).toContain('[BD101]');
  });

  test('no shared number: ask prints its BD id, as before', async () => {
    const w = await world();
    const only = await ask(w, '2', 'Keep the old export?');
    expect(only.outcome.shownAs).toEqual({kind: 'short', text: 'BD100'});
    const printed = describeAskOutcome(only.outcome, PLAIN_STYLE);
    expect(printed.lines[0]).toStartWith(`ask ${only.id} · BD100 · 🟡 P2 · `);
    expect(printed.lines[1]).toBe('');
  });

  test('a read that fails or throws prints "could not check" and no BD id', async () => {
    const w = await world();
    const problem =
      'the beads export could not be read: /x/issues.jsonl: EACCES';
    const failed = await ask(w, '2', 'Keep the old export?', w.env, () => ({
      kind: 'unreadable',
      problems: [problem],
    }));
    const thrown = await ask(w, '3', 'Rename the job?', w.env, () => {
      throw new Error('export vanished');
    });
    // The labels were written; only what the report shows is unknown.
    expect(failed.shortId).toBe('BD100');
    expect(thrown.shortId).toBe('BD101');
    expect(failed.outcome.shownAs).toEqual({
      kind: 'unchecked',
      why: `some of this session's questions could not be read: ${problem}`,
    });
    expect(thrown.outcome.shownAs).toEqual({
      kind: 'unchecked',
      why: "reading this session's questions threw: export vanished",
    });
    for (const [filed, planned] of [
      [failed, 'BD100'],
      [thrown, 'BD101'],
    ] as const) {
      const printed = describeAskOutcome(filed.outcome, PLAIN_STYLE);
      const text = printed.lines.join('\n');
      expect(printed.exitCode).toBe(0);
      expect(printed.lines[0]).toMatch(
        new RegExp(`^ask ${filed.id} · [⚪🟡]`, 'u'),
      );
      expect(text).not.toContain(planned);
      expect(printed.lines[1]).toStartWith(
        `⚠️ Could not check which id the report shows for this question, so refer to it by its bead id: ${filed.id}. Why: `,
      );
    }
  });

  test('a question the export does not hold yet is still counted, so a lagging export cannot hide a shared number', async () => {
    const w = await world();
    const other = await ask(w, '3', 'Hand-labelled?');
    relabel(w, other.id, ['qid:100'], ['qid:101']);
    const resolution = resolveSession({env: w.env, sessionId: SESSION});
    if (resolution.kind !== 'found') throw new Error(resolution.kind);
    // Filed after `other`, with number 101, and absent from the export.
    const lagging = {
      createdAt: at(30).toISOString(),
      id: `${w.sessionBead}.99`,
      labels: ['ask', `sid:${SESSION}`, 'qid:101'],
      priority: 2,
    };
    const read = readShownQuestionIds({include: lagging, session: resolution});
    if (read.kind !== 'read') throw new Error(read.problems.join('; '));
    expect(read.open.map((entry) => entry.id)).not.toContain(lagging.id);
    expect(read.shown.byId.get(lagging.id)).toEqual({
      text: lagging.id,
      why: `BD101 is also the id of ${other.id}, filed earlier`,
    });
    expect(read.shown.byId.get(other.id)).toEqual({text: 'BD101', why: null});
  });
});
