/**
 * Status report v4, dispatch 2 (home-base-vzwbj.4.2): questions for Justin as
 * beads — `thread ask`, the ask grammar and renderer, `thread answers`,
 * `thread answer`, Justin's marks (`note`, `done`, `archive`), and the answers
 * on the prompt-time context line.
 *
 * Like dispatch 1's suite (thread-session-beads.test.ts), everything that
 * touches beads runs the REAL `br` in throwaway workspaces under $TMPDIR, and
 * `needBr()` THROWS when br is missing — no silent pass.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.2's notes.
 */

import type {AskFields} from '../src/thread/ask-format';
import type {AnswerTerminal} from '../src/thread/session-answer';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brCreate, brList, brShow, runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {markAnswersDelivered, parseInstant} from '../src/thread/answer-store';
import {
  describeAnswersOutcome,
  readAnswers,
  runThreadAnswers,
} from '../src/thread/answers';
import {answersDeliveredPath, messageLogPath} from '../src/thread/archive';
import {describeAskOutcome, fileAsk, validateAsk} from '../src/thread/ask';
import {
  P0_NO_DEFAULT,
  P4_NO_DEFAULT,
  parseAsk,
  parseOptionFlag,
  renderAskDescription,
} from '../src/thread/ask-format';
import {renderAsk, renderAsks} from '../src/thread/ask-render';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {answerSessionQuestions} from '../src/thread/session-answer';
import {ensureSessionBead, toLabel} from '../src/thread/session-bead';
import {appendSessionSighting} from '../src/thread/session-index';
import {
  composeSessionContext,
  sessionContextLine,
} from '../src/thread/session-line';
import {
  appendNote,
  closeSession,
  describeCloseOutcome,
  noteSession,
  noteStamp,
} from '../src/thread/session-marks';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';

const ON = {enabled: true, sessionBeads: true};

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** console.log, captured for one test. */
function captureLog(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  spies.push(spy);
  return lines;
}

function beadsRepo(sb: Sandbox, name: string, prefix = 't'): string {
  const root = initRepo(sb, name, {'README.md': `# ${name}\n`});
  const init = runBr(root, ['init', '--prefix', prefix, '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  return root;
}

interface World {
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
  sessionBead: string;
}

/** A state dir, the knobs, a beads repo, and this session's bead filed in it. */
function world(knobs: Record<string, unknown> = ON): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: knobs}}),
  );
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = beadsRepo(sb, 'asks-repo');
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2026-10-11T09:00:00.000Z', text: 'Build the export'},
    now: new Date('2026-10-11T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') {
    throw new Error(`session bead not filed: ${filed.detail}`);
  }
  return {env, repo, sb, sessionBead: filed.beadId};
}

function show(w: World, id: string) {
  const shown = brShow({cwd: w.repo}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue;
}

function questions(w: World) {
  const listed = brList({cwd: w.repo}, {all: true, types: ['question']});
  if (listed.kind !== 'ok') throw new Error('br list failed');
  return listed.issues;
}

const VALID = {
  approve: false,
  context: ['The nightly export reads every table.'],
  default: 'I use Postgres.',
  do: false,
  header: 'Export DB',
  options: ['Postgres: already running', 'SQLite: no server'],
  priority: '2',
  question: 'Which database should the export use?',
  recommend: 'a',
};

async function ask(
  w: World,
  overrides: Partial<typeof VALID> & {to?: string | null} = {},
) {
  return await fileAsk({
    ...VALID,
    cwd: w.repo,
    env: w.env,
    sessionId: null,
    to: null,
    ...overrides,
  });
}

/** A message-log assistant line, as the Stop hook writes it. */
function logYield(w: World, at: string): void {
  const path = messageLogPath(SESSION, w.env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    serializeMessageLine({
      at: '2026-10-11T09:00:00.000Z',
      cwd: w.repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text: 'Build the export',
    }) +
      serializeMessageLine({
        at,
        cwd: w.repo,
        event: 'Stop',
        role: 'assistant',
        text: 'Here is where it stands.',
      }),
  );
}

/** Wait until the wall clock has moved on (br stamps closed_at with real time). */
async function tick(): Promise<void> {
  await Bun.sleep(15);
}

function closeWith(w: World, id: string, reason: string): void {
  const out = runBr(w.repo, ['close', id, `--reason=${reason}`]);
  if (!out.ok) throw new Error(`br close ${id}: ${out.reason ?? '?'}`);
}

// ---------------------------------------------------------------------------

describe('validateAsk: every refusal in the design, one line each', () => {
  const refusals: [string, Partial<typeof VALID>, RegExp][] = [
    ['no priority', {priority: ''}, /--priority is required/],
    ['a priority out of range', {priority: '7'}, /--priority must be 0–4/],
    ['a P0 with a default', {priority: '0'}, /a P0 has no --default/],
    [
      'a P1 without a default',
      {default: '', priority: '1'},
      /a P1 needs --default/,
    ],
    ['a P2 without a default', {default: ''}, /a P2 needs --default/],
    [
      'a P3 without a default',
      {default: '', priority: '3'},
      /a P3 needs --default/,
    ],
    [
      'exactly one option',
      {options: ['Postgres: fine'], recommend: ''},
      /exactly one --option/,
    ],
    [
      '--recommend naming a missing option',
      {recommend: 'c'},
      /--recommend c names an option that does not exist/,
    ],
    [
      '--recommend with no options',
      {options: [], recommend: 'a'},
      /there are no --option values/,
    ],
    [
      'a question over 200 characters',
      {question: 'x'.repeat(201)},
      /the question is 201 characters; the limit is 200/,
    ],
    [
      'a header over 12 characters',
      {header: 'Export database'},
      /--header is 15 characters/,
    ],
    ['no question', {question: '   '}, /give the question/],
  ];
  for (const [name, overrides, reason] of refusals) {
    test(`refuses ${name}`, () => {
      const result = validateAsk({...VALID, ...overrides});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(reason);
      expect(result.reason).not.toContain('\n');
    });
  }

  test('accepts a P4 with no default (FYI), and a P0 records "the session stops here"', () => {
    const p4 = validateAsk({...VALID, default: '', priority: '4'});
    expect(p4.ok).toBe(true);
    if (p4.ok)
      expect(p4.fields.default).toEqual({kind: 'none', why: P4_NO_DEFAULT});
    const p0 = validateAsk({
      ...VALID,
      default: null as unknown as string,
      priority: 'P0',
    });
    expect(p0.ok).toBe(true);
    if (p0.ok) {
      expect(p0.priority).toBe(0);
      expect(p0.fields.default).toEqual({kind: 'none', why: P0_NO_DEFAULT});
    }
  });

  test('infers the form: options → pick, none → answer, --do → do, --approve → approve', () => {
    const form = (overrides: Partial<typeof VALID>) => {
      const result = validateAsk({...VALID, ...overrides});
      return result.ok ? result.fields.form : result.reason;
    };
    expect(form({})).toBe('pick');
    expect(form({options: [], recommend: ''})).toBe('answer');
    expect(form({do: true, options: [], recommend: ''})).toBe('do');
    expect(form({approve: true, options: [], recommend: ''})).toBe('approve');
    expect(form({approve: true, do: true})).toMatch(/--do and --approve/);
  });
});

describe('the ask grammar', () => {
  const FIXTURES: AskFields[] = [
    {
      context: [
        'The nightly export reads every table.',
        'Postgres is up: port 5432.',
      ],
      default: {kind: 'text', text: 'I use Postgres: the safe choice.'},
      form: 'pick',
      header: 'Export DB',
      options: [
        {label: 'Postgres', why: 'already running: one less service: really'},
        {label: 'SQLite at 12:30', why: null},
        {label: 'Both', why: 'two copies'},
      ],
      recommended: 0,
    },
    {
      context: [],
      default: {kind: 'none', why: P0_NO_DEFAULT},
      form: 'answer',
      header: null,
      options: [],
      recommended: null,
    },
    {
      context: ['- a context line that starts with a dash'],
      default: {kind: 'none', why: P4_NO_DEFAULT},
      form: 'do',
      header: 'Device',
      options: [],
      recommended: null,
    },
    {
      context: [],
      default: {kind: 'text', text: 'none: I keep going'},
      form: 'approve',
      header: null,
      options: [
        {label: 'Yes', why: null},
        {label: 'No', why: 'then I stop: and say so'},
      ],
      recommended: 1,
    },
  ];

  FIXTURES.forEach((fixture, index) => {
    test(`round-trips fixture ${index + 1}: parseAsk(render(ask)) equals ask`, () => {
      const parsed = parseAsk(renderAskDescription(fixture));
      expect(parsed).toEqual({ask: fixture, ok: true});
    });
  });

  test('--option splits on the FIRST ": ", so a why with colons survives', () => {
    expect(parseOptionFlag('Postgres: fast: and: here')).toEqual({
      label: 'Postgres',
      why: 'fast: and: here',
    });
    expect(parseOptionFlag('Run at 12:30')).toEqual({
      label: 'Run at 12:30',
      why: null,
    });
    expect(parseOptionFlag('  Spaced    out  ')).toEqual({
      label: 'Spaced out',
      why: null,
    });
    // A colon with no space after it is part of the label; " : " splits.
    expect(parseOptionFlag('Ratio 16:9 : wide')).toEqual({
      label: 'Ratio 16:9',
      why: 'wide',
    });
  });

  test('the written description is what the design shows', () => {
    const [first] = FIXTURES;
    if (first == null) throw new Error('no fixture');
    expect(renderAskDescription(first)).toBe(
      [
        'Form: pick',
        'Header: Export DB',
        '',
        'Context:',
        '- The nightly export reads every table.',
        '- Postgres is up: port 5432.',
        '',
        'Options:',
        'a. (Recommended) Postgres: already running: one less service: really',
        'b. SQLite at 12:30',
        'c. Both: two copies',
        '',
        'Default: I use Postgres: the safe choice.',
      ].join('\n'),
    );
  });

  const MALFORMED: [string, string][] = [
    ['free text', 'Please pick a database.'],
    ['an empty description', ''],
    ['an unknown form', 'Form: choose\n\nDefault: x'],
    ['one option', 'Form: pick\n\nOptions:\na. Only\n\nDefault: x'],
    [
      'two recommendations',
      'Form: pick\n\nOptions:\na. (Recommended) A\nb. (Recommended) B\n\nDefault: x',
    ],
    [
      'letters out of order',
      'Form: pick\n\nOptions:\na. A\nc. C\n\nDefault: x',
    ],
    ['no default line', 'Form: answer\nHeader: Hi'],
    ['text after the default', 'Form: answer\n\nDefault: x\nmore'],
  ];
  for (const [name, text] of MALFORMED) {
    test(`refuses ${name}, keeping the raw text`, () => {
      const parsed = parseAsk(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.raw).toBe(text);
    });
  }
});

describe('the ask renderer', () => {
  const question = (
    overrides: Partial<{
      description: string | null;
      id: string;
      priority: number | null;
      title: string;
    }>,
  ) => ({
    description: renderAskDescription({
      context: [
        'The nightly export reads every table.',
        'Postgres is already running.',
      ],
      default: {kind: 'text', text: 'I use Postgres.'},
      form: 'pick',
      header: null,
      options: [
        {label: 'Postgres', why: 'already running'},
        {label: 'SQLite', why: 'no server'},
      ],
      recommended: 0,
    }),
    id: 't-abc.2',
    priority: 2,
    title: 'Which database should the export use?',
    ...overrides,
  });

  test('markdown: a context line starting with a list marker stays one plain bullet (pp1vx.14.1)', () => {
    const steps = question({
      description: renderAskDescription({
        context: [
          '1. Run `cd ~/Dev/x`.',
          '2) then this',
          '- a dash line',
          '* a star line',
          '1.5 GB is not a marker',
          'Step 1: already safe',
        ],
        default: {kind: 'text', text: 'I wait.'},
        form: 'answer',
        header: null,
        options: [],
        recommended: null,
      }),
    });
    const text = renderAsks([steps], {style: PLAIN_STYLE});
    expect(text).toContain('- 1\\. Run `cd ~/Dev/x`.');
    expect(text).toContain('- 2\\) then this');
    expect(text).toContain('- \\- a dash line');
    expect(text).toContain('- \\* a star line');
    expect(text).toContain('- 1.5 GB is not a marker');
    expect(text).toContain('- Step 1: already safe');
    // The terminal (ANSI) rendering has no markdown to misread: unchanged.
    const ansi = renderAsk(steps, 1, {color: true, width: null});
    expect(ansi).toContain('1. Run `cd ~/Dev/x`.');
    expect(ansi).not.toContain('1\\.');
  });

  test('markdown: numbered, badge, bold question, context, options, italic default, a blank line after every item and between options', () => {
    const p0 = question({
      description: renderAskDescription({
        context: [],
        default: {kind: 'none', why: P0_NO_DEFAULT},
        form: 'answer',
        header: 'Deploy',
        options: [],
        recommended: null,
      }),
      id: 't-abc.3',
      priority: 0,
      title: 'May I deploy to production?',
    });
    const p4 = question({
      description: renderAskDescription({
        context: [],
        default: {kind: 'none', why: P4_NO_DEFAULT},
        form: 'answer',
        header: null,
        options: [],
        recommended: null,
      }),
      id: 't-abc.4',
      priority: 4,
      title: 'The old cache folder is gone.',
    });
    expect(renderAsks([p4, question({}), p0], {style: PLAIN_STYLE})).toBe(
      [
        '1. 🛑 P0 · [Answer] Deploy · **May I deploy to production?** (t-abc.3)',
        '',
        "   *If you don't answer: I stop here; this one is yours.*",
        '',
        '2. 🟡 P2 · [Pick a/b] **Which database should the export use?** (t-abc.2)',
        '',
        '   - The nightly export reads every table.',
        '   - Postgres is already running.',
        '',
        '   - a. (Recommended) Postgres — already running',
        '',
        '   - b. SQLite — no server',
        '',
        "   *If you don't answer: I use Postgres.*",
        '',
        '3. ⚪ P4 · [Answer] **The old cache folder is gone.** (t-abc.4)',
        '',
        "   *If you don't answer: nothing changes — FYI, no reply expected.*",
      ].join('\n'),
    );
  });

  test('an unparseable description renders as written under a ⚠️ line, never nothing', () => {
    const text = renderAsk(
      question({description: 'Pick one:\nPostgres or SQLite?', priority: 3}),
      1,
      PLAIN_STYLE,
    );
    expect(text).toBe(
      [
        '1. ⚪ P3 · **Which database should the export use?** (t-abc.2)',
        '',
        '   ⚠️ Not in the ask format (the first line is not "Form: …"); shown as written:',
        '',
        '   Pick one:',
        '   Postgres or SQLite?',
      ].join('\n'),
    );
    expect(renderAsk(question({description: null}), 1, PLAIN_STYLE)).toContain(
      '⚠️ This question has no description',
    );
  });

  test('ANSI: bold question, red P0 badge, green recommendation, italic default, the same blank lines', () => {
    const style = {color: true, width: null};
    const text = renderAsk(question({}), 1, style);
    expect(text).toMatchSnapshot();
    expect(text).toContain(
      '\u001b[1mWhich database should the export use?\u001b[0m',
    );
    expect(text).toContain(
      "\u001b[3mIf you don't answer: I use Postgres.\u001b[0m",
    );
    expect(text).toContain('\u001b[1;32m(Recommended)\u001b[0m');
    // A blank line between every block: badge line, context, a, b, default.
    expect(text.split('\n\n')).toHaveLength(5);
    expect(renderAsk(question({priority: 0}), 1, style)).toContain(
      '\u001b[1;31m🛑 P0\u001b[0m',
    );
  });
});

describe('thread ask (real br)', () => {
  test('files ONE question bead under the session bead when no request is in progress, with priority, labels and a parseable description', async () => {
    const w = world();
    const outcome = await ask(w);
    expect(outcome.kind).toBe('filed');
    if (outcome.kind !== 'filed') return;
    expect(outcome.parent).toBe(w.sessionBead);
    expect(outcome.request).toBeNull();
    expect(outcome.unlinkedWhy).toContain('no request is in progress');
    const issue = show(w, outcome.id);
    expect(issue.issueType).toBe('question');
    expect(issue.priority).toBe(2);
    expect(issue.labels.sort()).toEqual(['ask', `sid:${SESSION}`]);
    expect(issue.title).toBe(VALID.question);
    expect(issue.id.startsWith(`${w.sessionBead}.`)).toBe(true);
    const parsed = parseAsk(issue.description);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ask).toEqual(outcome.fields);
    expect(questions(w)).toHaveLength(1);
    const printed = describeAskOutcome(outcome, PLAIN_STYLE);
    expect(printed.exitCode).toBe(0);
    expect(printed.lines[0]).toMatch(
      new RegExp(`^ask ${outcome.id} · 🟡 P2 · filed under ${w.sessionBead}`),
    );
    expect(printed.lines.join('\n')).toContain(
      `1. 🟡 P2 · [Pick a/b] Export DB · **${VALID.question}** (${outcome.id})`,
    );
  });

  test("links the session's ONLY in-progress request by label (the parent stays the session bead); with two, links none and says why", async () => {
    const w = world();
    const first = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: 'Build the export',
    });
    expect(first.kind).toBe('filed');
    if (first.kind !== 'filed') return;
    const linked = await ask(w);
    expect(linked.kind).toBe('filed');
    if (linked.kind !== 'filed') return;
    expect(linked.parent).toBe(w.sessionBead);
    expect(linked.request?.id).toBe(first.id);
    expect(show(w, linked.id).labels).toContain(toLabel(first.id));

    const second = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: 'Fix the import',
    });
    expect(second.kind).toBe('filed');
    const unlinked = await ask(w, {question: 'And the import?'});
    expect(unlinked.kind).toBe('filed');
    if (unlinked.kind !== 'filed') return;
    expect(unlinked.parent).toBe(w.sessionBead);
    expect(unlinked.request).toBeNull();
    expect(unlinked.unlinkedWhy).toContain('2 requests are in progress');
    expect(
      show(w, unlinked.id).labels.filter((label) => label.startsWith('to:')),
    ).toEqual([]);
  });

  test('--to links the named bead (session DB, then the current directory’s); a --to in neither is refused', async () => {
    const w = world();
    const other = brCreate({cwd: w.repo}, {title: 'Some task', type: 'task'});
    expect(other.kind).toBe('ok');
    if (other.kind !== 'ok') return;
    const filed = await ask(w, {to: other.id});
    expect(filed.kind === 'filed' && filed.parent).toBe(w.sessionBead);
    expect(filed.kind === 'filed' && filed.request?.id).toBe(other.id);
    // A bead only the CURRENT DIRECTORY's DB holds (the conductor in main
    // filing for a request in its worktree's DB) is linked too.
    const elsewhere = beadsRepo(w.sb, 'elsewhere-repo', 'e');
    const there = brCreate(
      {cwd: elsewhere},
      {title: 'Elsewhere task', type: 'task'},
    );
    if (there.kind !== 'ok') throw new Error('elsewhere bead not filed');
    const cross = await fileAsk({
      ...VALID,
      cwd: elsewhere,
      env: w.env,
      sessionId: null,
      to: there.id,
    });
    expect(cross.kind).toBe('filed');
    if (cross.kind !== 'filed') return;
    expect(cross.parent).toBe(w.sessionBead);
    expect(cross.request?.id).toBe(there.id);
    expect(show(w, cross.id).labels).toContain(toLabel(there.id));
    const missing = await ask(w, {to: 't-nope'});
    expect(missing.kind).toBe('failed');
    if (missing.kind === 'failed')
      expect(missing.reason).toContain(
        "is in neither this session's beads DB nor the current directory's",
      );
  });

  test('an invalid ask exits 2 and files NOTHING', async () => {
    const w = world();
    const outcome = await ask(w, {default: 'x', priority: '0'});
    expect(outcome.kind).toBe('invalid');
    expect(describeAskOutcome(outcome, PLAIN_STYLE).exitCode).toBe(2);
    expect(questions(w)).toHaveLength(0);
  });

  test('knob off: refused, nothing filed', async () => {
    const w = world();
    const off = {...w.env, XDG_CONFIG_HOME: join(w.sb.path, 'off-xdg')};
    const outcome = await fileAsk({
      ...VALID,
      cwd: w.repo,
      env: off,
      sessionId: null,
      to: null,
    });
    expect(outcome.kind).toBe('disabled');
    expect(questions(w)).toHaveLength(0);
  });
});

describe('thread answers: only what Claude has not been shown yet (R1: delivery, not yield time)', () => {
  test('lists every answer not yet delivered — one closed BEFORE the last assistant line included — then marks them, so the next run says "No new answers."', async () => {
    const w = world();
    const ids: string[] = [];
    for (const question of [
      'Mid-turn one?',
      'New one?',
      'Withdrawn?',
      'Still open?',
    ]) {
      const filed = await ask(w, {question});
      if (filed.kind !== 'filed') throw new Error(filed.kind);
      ids.push(filed.id);
    }
    const [midId, newId, withdrawnId] = ids as [string, string, string, string];
    // Answered while Claude was mid-turn: the close time PRECEDES the yield.
    closeWith(w, midId, 'answer: b, before the yield');
    await tick();
    logYield(w, new Date().toISOString());
    await tick();
    closeWith(w, newId, 'answer: use SQLite: it is fine');
    closeWith(w, withdrawnId, 'no longer needed');

    const outcome = await readAnswers({
      all: false,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.answered.map((entry) => entry.issue.id).sort()).toEqual(
      [midId, newId].sort(),
    );
    const printed = describeAnswersOutcome(outcome, PLAIN_STYLE);
    expect(printed.exitCode).toBe(0);
    const text = printed.lines.join('\n');
    expect(text).toContain('New answers (not shown to you before): 2');
    expect(text).toContain(`**New one?** (${newId})`);
    expect(text).toContain(`**Mid-turn one?** (${midId})`);
    expect(text).toContain("Justin's answer: use SQLite: it is fine");

    // runThreadAnswers prints them and records them as delivered.
    const out = captureLog();
    expect(
      await runThreadAnswers({
        all: false,
        cwd: w.repo,
        env: w.env,
        sessionId: null,
        style: PLAIN_STYLE,
      }),
    ).toBe(0);
    expect(out.join('\n')).toContain('Mid-turn one?');
    const again = await readAnswers({
      all: false,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    expect(describeAnswersOutcome(again, PLAIN_STYLE)).toEqual({
      exitCode: 0,
      lines: ['No new answers.'],
    });

    // --all ignores the marker.
    const all = await readAnswers({
      all: true,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    expect(
      all.kind === 'read' && all.answered.map((entry) => entry.issue.id).sort(),
    ).toEqual([newId, midId].sort());
  });

  test('"No new answers." when every answer was already delivered', async () => {
    const w = world();
    const filed = await ask(w);
    if (filed.kind !== 'filed') throw new Error(filed.kind);
    closeWith(w, filed.id, 'answer: a');
    expect(markAnswersDelivered(SESSION, [filed.id], w.env).kind).toBe(
      'written',
    );
    const outcome = await readAnswers({
      all: false,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    const printed = describeAnswersOutcome(outcome, PLAIN_STYLE);
    expect(printed).toEqual({exitCode: 0, lines: ['No new answers.']});
  });

  test('a beads DB that cannot be read is a FAILURE (exit 1, named), never "No new answers."', async () => {
    const w = world();
    // A beads.db that br cannot open: br exits 2 with DATABASE_ERROR "Is a
    // directory" (measured 2026-10-11, br 0.1.37). A garbage FILE would not do:
    // br 0.1.37 moves a corrupt database to .br_recovery, rebuilds it from the
    // JSONL and answers "no issues" with exit 0.
    const broken = join(w.sb.path, 'broken-repo');
    mkdirSync(join(broken, '.beads', 'beads.db'), {recursive: true});
    appendSessionSighting(
      {
        at: '2026-10-11T10:00:00.000Z',
        beadId: 'b-1',
        beadsDir: join(broken, '.beads'),
        branch: 'main',
        checkoutPath: broken,
        event: 'adopted-in',
        repo: 'broken-repo',
        sessionId: SESSION,
      },
      w.env,
    );
    const outcome = await readAnswers({
      all: false,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    const printed = describeAnswersOutcome(outcome, PLAIN_STYLE);
    expect(printed.exitCode).toBe(1);
    expect(printed.lines.join('\n')).toContain('could not read');
    expect(printed.lines.join('\n')).not.toContain('No new answers.');
  });

  test('an unreadable delivered marker lists EVERY answer, and says why', async () => {
    const w = world();
    const filed = await ask(w);
    if (filed.kind !== 'filed') throw new Error(filed.kind);
    closeWith(w, filed.id, 'answer: a');
    expect(markAnswersDelivered(SESSION, [filed.id], w.env).kind).toBe(
      'written',
    );
    writeFileSync(answersDeliveredPath(SESSION, w.env), '{not a list');
    const outcome = await readAnswers({
      all: false,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
    });
    const printed = describeAnswersOutcome(outcome, PLAIN_STYLE);
    expect(printed.exitCode).toBe(0);
    expect(printed.lines.join('\n')).toContain(
      'Could not tell which answers you have already been shown',
    );
    expect(printed.lines.join('\n')).toContain("Justin's answer: a");
  });

  test("br's microsecond close times compare correctly with the log's milliseconds", () => {
    expect(parseInstant('2026-10-11T12:50:18.229905Z')).toBe(
      Date.parse('2026-10-11T12:50:18.229Z'),
    );
    expect(parseInstant('not a time')).toBeNull();
    expect(parseInstant(null)).toBeNull();
  });
});

/** A terminal that types `inputs` in order and records what was printed. */
function scripted(inputs: (string | null)[]): {
  printed: string[];
  terminal: AnswerTerminal;
} {
  const printed: string[] = [];
  const queue = [...inputs];
  return {
    printed,
    terminal: {
      print: (text) => printed.push(text),
      readLine: (prompt) => {
        printed.push(prompt);
        return Promise.resolve(
          queue.length === 0 ? null : (queue.shift() ?? null),
        );
      },
    },
  };
}

describe('thread answer (Justin, in the terminal)', () => {
  test('the walk: text answers, Enter skips (stays open), d takes the default, d on a P0 is refused', async () => {
    const w = world();
    const p3 = await ask(w, {
      default: 'I keep the old name.',
      priority: '3',
      question: 'Rename the module?',
    });
    const p0 = await ask(w, {
      default: '',
      options: [],
      priority: '0',
      question: 'May I delete the old table?',
      recommend: '',
    });
    const p2 = await ask(w, {question: 'Which database?'});
    if (p3.kind !== 'filed' || p0.kind !== 'filed' || p2.kind !== 'filed')
      throw new Error('not filed');
    const {printed, terminal} = scripted(['d', 'Yes, it is empty', '', 'd']);
    const outcome = await answerSessionQuestions({
      ask: null,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: null,
      style: PLAIN_STYLE,
      terminal,
      text: null,
    });
    expect(outcome.kind).toBe('walked');
    if (outcome.kind !== 'walked') return;
    // Most urgent first: P0, then P2, then P3.
    expect(outcome.result.answered).toEqual([p0.id, p3.id]);
    expect(outcome.result.skipped).toEqual([p2.id]);
    expect(printed.join('\n')).toContain('a P0 has no default');
    expect(show(w, p0.id).closeReason).toBe('answer: Yes, it is empty');
    expect(show(w, p2.id).status).not.toBe('closed');
    expect(show(w, p3.id).closeReason).toBe(
      'answer: default taken — I keep the old name.',
    );
  });

  test('--ask answers one question non-interactively; a closed or non-question bead is refused', async () => {
    const w = world();
    const filed = await ask(w);
    if (filed.kind !== 'filed') throw new Error(filed.kind);
    const one = await answerSessionQuestions({
      ask: filed.id,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: null,
      text: 'b, but only for now',
    });
    expect(one).toEqual({
      id: filed.id,
      kind: 'answeredOne',
      reason: 'answer: b, but only for now',
    });
    expect(show(w, filed.id).closeReason).toBe('answer: b, but only for now');
    const again = await answerSessionQuestions({
      ask: filed.id,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: null,
      text: 'c',
    });
    expect(again.kind === 'failed' && again.reason).toContain('already closed');
    const notQuestion = await answerSessionQuestions({
      ask: w.sessionBead,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: null,
      text: 'c',
    });
    expect(notQuestion.kind === 'failed' && notQuestion.reason).toContain(
      'not a question',
    );
  });

  test('a question id as the positional walks just that question; a session bead id from a plain terminal works', async () => {
    const w = world();
    const a = await ask(w, {question: 'First?'});
    const b = await ask(w, {question: 'Second?'});
    if (a.kind !== 'filed' || b.kind !== 'filed') throw new Error('not filed');
    const plain = {...w.env, CLAUDE_CODE_SESSION_ID: undefined};
    const single = scripted(['only this']);
    const one = await answerSessionQuestions({
      ask: null,
      cwd: w.repo,
      env: plain,
      selector: b.id,
      sessionId: null,
      style: PLAIN_STYLE,
      terminal: single.terminal,
      text: null,
    });
    expect(one.kind === 'walked' && one.result.answered).toEqual([b.id]);
    const bySession = scripted(['first answer']);
    const walked = await answerSessionQuestions({
      ask: null,
      cwd: w.sb.path,
      env: plain,
      selector: w.sessionBead,
      sessionId: null,
      style: PLAIN_STYLE,
      terminal: bySession.terminal,
      text: null,
    });
    expect(walked.kind === 'walked' && walked.result.answered).toEqual([a.id]);
  });
});

describe("Justin's marks: note, done, archive", () => {
  test('note appends a dated line, keeping what was there', async () => {
    const w = world();
    const at = new Date(2026, 9, 11, 14, 5);
    expect(noteStamp(at)).toBe('2026-10-11 14:05');
    expect(appendNote('earlier text\n', 'second', at)).toBe(
      'earlier text\n- 2026-10-11 14:05: second',
    );
    const first = await noteSession({
      cwd: w.repo,
      env: w.env,
      now: at,
      session: null,
      text: 'Looks good so far',
    });
    expect(first.kind).toBe('noted');
    const later = new Date(2026, 9, 11, 15, 30);
    await noteSession({
      cwd: w.repo,
      env: w.env,
      now: later,
      session: w.sessionBead,
      text: 'Ship it',
    });
    expect(show(w, w.sessionBead).notes).toBe(
      '- 2026-10-11 14:05: Looks good so far\n- 2026-10-11 15:30: Ship it',
    );
  });

  test('done closes the open questions, the open requests and the session with "done: Justin — …"; an answered question keeps its answer', async () => {
    const w = world();
    const request = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: 'Build the export',
    });
    if (request.kind !== 'filed') throw new Error(request.kind);
    const open = await ask(w, {question: 'Open one?'});
    const answered = await ask(w, {question: 'Answered one?'});
    if (open.kind !== 'filed' || answered.kind !== 'filed')
      throw new Error('not filed');
    closeWith(w, answered.id, 'answer: yes');
    const outcome = await closeSession('done', {
      cwd: w.repo,
      env: w.env,
      reason: 'wrapped up',
      selector: null,
      sessionId: null,
    });
    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') return;
    expect(outcome.failures).toEqual([]);
    expect(outcome.sessionClosed).toBe(true);
    for (const id of [open.id, request.id, w.sessionBead]) {
      expect(show(w, id).status).toBe('closed');
      expect(show(w, id).closeReason).toBe('done: Justin — wrapped up');
    }
    expect(show(w, answered.id).closeReason).toBe('answer: yes');
  });

  test('done is final over open children: it closes the request and the session anyway, leaves the children open, and LISTS them', async () => {
    const w = world();
    const request = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: 'Build the export',
    });
    if (request.kind !== 'filed') throw new Error(request.kind);
    const subTask = brCreate(
      {cwd: w.repo},
      {parent: request.id, title: 'A sub-task', type: 'task'},
    );
    const sideBead = brCreate(
      {cwd: w.repo},
      {
        parent: w.sessionBead,
        title: 'A follow-up filed under the session',
        type: 'task',
      },
    );
    if (subTask.kind !== 'ok' || sideBead.kind !== 'ok')
      throw new Error('child');
    const outcome = await closeSession('done', {
      cwd: w.repo,
      env: w.env,
      reason: null,
      selector: null,
      sessionId: null,
    });
    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') return;
    expect(outcome.failures).toEqual([]);
    expect(outcome.sessionClosed).toBe(true);
    expect(show(w, request.id).closeReason).toBe('done: Justin');
    expect(show(w, w.sessionBead).closeReason).toBe('done: Justin');
    expect(show(w, subTask.id).status).toBe('open');
    expect(show(w, sideBead.id).status).toBe('open');
    expect(outcome.leftOpen.map((bead) => bead.id).sort()).toEqual(
      [sideBead.id, subTask.id].sort(),
    );
    const printed = describeCloseOutcome('thread done', outcome);
    expect(printed.exitCode).toBe(0);
    const text = printed.lines.join('\n');
    expect(text).toContain('Left open (still in the backlog): 2');
    expect(text).toContain(`  - ${subTask.id} · A sub-task`);
    expect(text).toContain(
      `  - ${sideBead.id} · A follow-up filed under the session`,
    );
  });

  test('done closes NOTHING when one of the session’s beads DBs cannot be read', async () => {
    const w = world();
    const broken = join(w.sb.path, 'broken-repo');
    mkdirSync(join(broken, '.beads', 'beads.db'), {recursive: true});
    appendSessionSighting(
      {
        at: '2026-10-11T10:00:00.000Z',
        beadId: 'b-1',
        beadsDir: join(broken, '.beads'),
        branch: 'main',
        checkoutPath: broken,
        event: 'adopted-in',
        repo: 'broken-repo',
        sessionId: SESSION,
      },
      w.env,
    );
    const outcome = await closeSession('done', {
      cwd: w.repo,
      env: w.env,
      reason: null,
      selector: null,
      sessionId: null,
    });
    expect(outcome.kind === 'failed' && outcome.reason).toContain(
      'nothing was closed',
    );
    expect(show(w, w.sessionBead).status).toBe('in_progress');
  });

  test('archive needs --reason, closes with "archived: …" and labels the session bead archived', async () => {
    const w = world();
    const open = await ask(w);
    if (open.kind !== 'filed') throw new Error(open.kind);
    const usage = await closeSession('archive', {
      cwd: w.repo,
      env: w.env,
      reason: null,
      selector: null,
      sessionId: null,
    });
    expect(usage.kind).toBe('usage');
    expect(show(w, w.sessionBead).status).toBe('in_progress');
    const outcome = await closeSession('archive', {
      cwd: w.repo,
      env: w.env,
      reason: 'superseded by the v5 plan',
      selector: w.sessionBead,
      sessionId: null,
    });
    expect(outcome.kind === 'closed' && outcome.sessionClosed).toBe(true);
    const session = show(w, w.sessionBead);
    expect(session.closeReason).toBe('archived: superseded by the v5 plan');
    expect(session.labels).toContain('archived');
    expect(show(w, open.id).closeReason).toBe(
      'archived: superseded by the v5 plan',
    );
  });

  // R4 (home-base-vzwbj.4.9): archive must not close an epic it only adopted.
  test('R4: archive RELEASES an adopted epic (open, unlabelled, children untouched) while the request this session created is closed', async () => {
    const w = world();
    const epic = brCreate(
      {cwd: w.repo},
      {status: 'in_progress', title: 'The big epic', type: 'epic'},
    );
    if (epic.kind !== 'ok') throw new Error(epic.reason);
    const epicChild = brCreate(
      {cwd: w.repo},
      {parent: epic.id, title: 'Epic child', type: 'task'},
    );
    if (epicChild.kind !== 'ok') throw new Error(epicChild.reason);
    const base = {
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
    };
    const adopted = await fileRequest({...base, bead: epic.id, title: null});
    const created = await fileRequest({
      ...base,
      bead: null,
      title: 'A request this session made',
    });
    if (adopted.kind !== 'filed' || created.kind !== 'filed')
      throw new Error('not filed');

    const outcome = await closeSession('archive', {
      cwd: w.repo,
      env: w.env,
      reason: 'parked',
      selector: null,
      sessionId: null,
    });
    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') return;
    expect(outcome.failures).toEqual([]);
    expect(outcome.released).toEqual([{id: epic.id, title: 'The big epic'}]);

    const epicNow = show(w, epic.id);
    expect(epicNow.status).toBe('in_progress');
    expect(epicNow.labels).not.toContain('request');
    expect(epicNow.labels).not.toContain(`sid:${SESSION}`);
    expect(show(w, epicChild.id).status).toBe('open');
    expect(show(w, created.id).closeReason).toBe('archived: parked');
    expect(show(w, w.sessionBead).closeReason).toBe('archived: parked');
    // The epic's own child is not "left open" by this archive: it was never
    // under anything the archive closed.
    expect(outcome.leftOpen.map((bead) => bead.id)).not.toContain(epicChild.id);
    const text = describeCloseOutcome('thread archive', outcome).lines.join(
      '\n',
    );
    expect(text).toContain('Released back to the backlog');
    expect(text).toContain(`  - ${epic.id} · The big epic`);
  });
});

describe('the prompt-time line carries new answers', () => {
  test('composeSessionContext: the count on the line, then one bullet per answer', () => {
    const text = composeSessionContext({
      answers: [
        {answer: 'b', id: 't-1.2', question: 'Which database?'},
        {
          answer: 'default taken — I keep the name.',
          id: 't-1.3',
          question: 'Rename it?',
        },
      ],
      beadId: 't-1',
      kind: 'session',
      requests: {done: 0, kind: 'counted', open: 1},
      title: 'Build the export',
      titleProblem: null,
    });
    const [line, ...bullets] = text.split('\n');
    expect(line).toContain(' · new answers from Justin: 2 · ');
    expect(bullets).toEqual([
      '- Which database? (t-1.2) → Justin: b',
      '- Rename it? (t-1.3) → Justin: default taken — I keep the name.',
    ]);
  });

  // R1 (home-base-vzwbj.4.9): delivery, not yield time.
  test('end to end from the files: an answer recorded mid-turn (closed BEFORE the last assistant line) is shown ONCE, then not again', async () => {
    const w = world();
    const midTurn = await ask(w, {question: 'Mid-turn?'});
    const later = await ask(w, {question: 'Later?'});
    if (midTurn.kind !== 'filed' || later.kind !== 'filed')
      throw new Error('not filed');
    // Justin answers while Claude is still working; Claude then yields.
    closeWith(w, midTurn.id, 'answer: old');
    await tick();
    logYield(w, new Date().toISOString());
    const first =
      sessionContextLine({cwd: w.repo, env: w.env, sessionId: SESSION}) ?? '';
    expect(first).toContain('new answers from Justin: 1');
    expect(first.split('\n').slice(1)).toEqual([
      `- Mid-turn? (${midTurn.id}) → Justin: old`,
    ]);
    const second =
      sessionContextLine({cwd: w.repo, env: w.env, sessionId: SESSION}) ?? '';
    expect(second).not.toContain('new answers');
    expect(second.split('\n')).toHaveLength(1);
    closeWith(w, later.id, 'answer: new: with a colon');
    const third =
      sessionContextLine({cwd: w.repo, env: w.env, sessionId: SESSION}) ?? '';
    expect(third).toContain('new answers from Justin: 1');
    expect(third.split('\n').slice(1)).toEqual([
      `- Later? (${later.id}) → Justin: new: with a colon`,
    ]);
  });
});

describe('the CLI', () => {
  function cli(
    w: World,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: string;
    } = {},
  ) {
    const cliEntry = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const env = Object.fromEntries(
      Object.entries({...process.env, ...w.env, ...options.env}).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    const run = Bun.spawnSync([process.execPath, cliEntry, 'thread', ...args], {
      cwd: options.cwd ?? w.repo,
      env,
      stdin:
        options.stdin != null
          ? new TextEncoder().encode(options.stdin)
          : 'ignore',
    });
    return {
      code: run.exitCode,
      err: run.stderr.toString(),
      out: run.stdout.toString(),
    };
  }

  test('ask → answer (piped into the readline walk) → answers → note → done, end to end', () => {
    const w = world();
    const invalid = cli(w, ['ask', 'Which', 'database?', '--priority', '2']);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('a P2 needs --default');
    const filed = cli(w, [
      'ask',
      'Which database?',
      '-p',
      '2',
      '--option',
      'Postgres: up: really',
      '--option',
      'SQLite',
      '--recommend',
      'a',
      '--default',
      'Postgres',
      '--context',
      'one',
      '--context',
      'two',
    ]);
    expect(filed.err).toBe('');
    expect(filed.code).toBe(0);
    const id = /^ask (\S+)/.exec(filed.out)?.[1] ?? '';
    expect(filed.out).toContain('- a. (Recommended) Postgres — up: really');
    // Two empty lines between the context bullets: Claude may paste this, and
    // Claude Code drops one (home-base-j8q3e.1.10 F7, as in Part 1).
    expect(filed.out).toContain('   - one\n\n\n   - two');
    const second = cli(w, [
      'ask',
      'Rename it?',
      '-p',
      '3',
      '--default',
      'I keep it',
    ]);
    const secondId = /^ask (\S+)/.exec(second.out)?.[1] ?? '';

    const walked = cli(w, ['answer'], {stdin: 'Postgres, please\n\n'});
    expect(walked.code).toBe(0);
    expect(walked.out).toContain(`✓ ${id} recorded: answer: Postgres, please`);
    expect(walked.out).toContain(`↷ ${secondId} skipped`);
    expect(show(w, id).closeReason).toBe('answer: Postgres, please');
    expect(show(w, secondId).status).not.toBe('closed');

    const answers = cli(w, ['answers']);
    expect(answers.code).toBe(0);
    expect(answers.out).toContain("Justin's answer: Postgres, please");

    expect(cli(w, ['note', 'All', 'good']).code).toBe(0);
    const done = cli(w, ['done', '--reason', 'finished']);
    expect(done.code).toBe(0);
    expect(show(w, secondId).closeReason).toBe('done: Justin — finished');
    expect(show(w, w.sessionBead).closeReason).toBe('done: Justin — finished');
  });

  test('thread archive by session bead id from a plain terminal: --reason required, then closed and labelled', () => {
    const w = world();
    const plain = {CLAUDE_CODE_SESSION_ID: undefined};
    const usage = cli(w, ['archive', w.sessionBead], {env: plain});
    expect(usage.code).toBe(2);
    expect(usage.err).toContain('needs --reason');
    const archived = cli(
      w,
      ['archive', w.sessionBead, '--reason', 'no longer needed'],
      {env: plain},
    );
    expect(archived.err).toBe('');
    expect(archived.code).toBe(0);
    expect(show(w, w.sessionBead).closeReason).toBe(
      'archived: no longer needed',
    );
    expect(show(w, w.sessionBead).labels).toContain('archived');
  });

  test('knob off: thread answer --ask is refused (the legacy answer path is untouched), and thread answers points at thread inbox', () => {
    const w = world();
    const off = {XDG_CONFIG_HOME: join(w.sb.path, 'off-xdg')};
    const answer = cli(w, ['answer', '--ask', 't-1', 'yes'], {env: off});
    expect(answer.code).toBe(2);
    expect(answer.err).toContain('needs componentConfig.thread.sessionBeads');
    const answers = cli(w, ['answers'], {env: off});
    expect(answers.code).toBe(1);
    expect(answers.err).toContain('thread inbox');
  });
});
