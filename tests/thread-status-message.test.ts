/**
 * `thread status --message` and the questions a message names
 * (home-base-88y8m D4 and D5, built by home-base-88y8m.2). The fixtures are
 * synthetic: two repos, each with its own session, sharing one state dir, so
 * the machine-wide question counter and the sessions index span both.
 *
 * Each rule sits beside a control that fails when the rule is taken away.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {recordedBeadsJsonl} from '../src/beads/jsonl';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath, reportSnapshotsPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {ANSWER_PREFIX} from '../src/thread/ask-format';
import {appendMessageLine} from '../src/thread/message-log';
import {
  questionIdsNamed,
  resolveMessageQuestions,
} from '../src/thread/message-questions';
import {
  CLAUDE_MESSAGE_HEADING,
  OTHER_QUESTIONS_HEADING,
  PART_ONE_RULE,
  PART_ONE_SEPARATOR,
  QUESTIONS_HEADING,
} from '../src/thread/part-one';
import {
  newestShownMessage,
  readReportSnapshots,
} from '../src/thread/report-snapshots';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  messageNotShownLine,
  runSessionShow,
  runThreadStatus,
} from '../src/thread/session-report';
import {runThreadStopCheck} from '../src/thread/stop-check';
import {readStatusBlocks} from '../src/thread/trim-guard';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

/**
 * home-base-88y8m.8 R7: a test that builds two worlds takes about 3.5 s alone
 * and passed bun's 5 s limit under load; the relay tests' timeout.
 */
const SLOW = 60_000;

const SESSION_A = '5e551011-aaaa-4aaa-8aaa-0123456789ab';
const SESSION_B = '5e551011-bbbb-4bbb-8bbb-0123456789ab';

const sandboxes: Sandbox[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function at(minute: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 9, minute));
}

// ---------------------------------------------------------------------------
// The scanner (pure)
// ---------------------------------------------------------------------------

describe('the question ids a message names (D5)', () => {
  test('Q<n> and BD<n>, any case, whole words, each number once', () => {
    expect(
      questionIdsNamed(
        'See Q131 and bd131 again, (q200), BD7x, FAQ12, Q1.\nAlso BD300.',
      ),
    ).toEqual([
      {number: 131, written: 'Q131'},
      {number: 200, written: 'q200'},
      {number: 1, written: 'Q1'},
      {number: 300, written: 'BD300'},
    ]);
    expect(questionIdsNamed('nothing here, not even Q0 or BD')).toEqual([]);
  });

  test('a number at or below the floor is never looked up, and says so', () => {
    const looked: number[] = [];
    const resolved = resolveMessageQuestions({
      env: {},
      firstDirs: [],
      locate: ({number}) => {
        looked.push(number);
        return {found: [], problems: []};
      },
      open: [],
      text: 'Q3 and Q120',
    });
    expect(looked).toEqual([120]);
    expect(resolved.items.map((item) => item.kind)).toEqual(['note', 'note']);
    expect(JSON.stringify(resolved.items[0])).toContain('Q3 is not looked up');
    expect(JSON.stringify(resolved.items[1])).toContain(
      'Q120 matches no question',
    );
    // home-base-88y8m.8 R3: an unfound id may have been filed moments ago.
    expect(JSON.stringify(resolved.items[1])).toContain(
      'An export can trail its database by a moment after a question is filed.',
    );
  });

  test('a lookup that throws is a line, never dropped', () => {
    const resolved = resolveMessageQuestions({
      env: {},
      firstDirs: [],
      locate: () => {
        throw new Error('disk on fire');
      },
      open: [],
      text: 'BD150',
    });
    expect(resolved.items).toEqual([
      {kind: 'note', text: '⚠️ BD150 could not be looked up: disk on fire'},
    ]);
  });
});

// ---------------------------------------------------------------------------
// Two repos, two sessions
// ---------------------------------------------------------------------------

interface Side {
  env: Record<string, string | undefined>;
  questions: string[];
  repo: string;
  request: string;
  session: string;
  transcript: string;
}

interface Two {
  a: Side;
  b: Side;
  root: string;
}

async function ask(side: Side, priority: string, question: string) {
  const outcome = await fileAsk({
    approve: false,
    context: [`Context for ${question}`],
    cwd: side.repo,
    default: priority === '0' ? null : 'I keep going as planned.',
    do: false,
    env: side.env,
    header: null,
    options: [],
    priority,
    question,
    recommend: null,
    sessionId: null,
    to: side.request,
  });
  if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
  return outcome.id;
}

async function makeSide(
  sb: Sandbox,
  base: Record<string, string | undefined>,
  name: string,
  session: string,
  title: string,
  asks: [string, string][],
): Promise<Side> {
  const env = {...base, CLAUDE_CODE_SESSION_ID: session};
  const repo = initRepo(sb, name, {'README.md': `# ${name}\n`});
  const init = runBr(repo, ['init', '--prefix', name.slice(-1), '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: at(0).toISOString(), text: title},
    now: at(0),
    sessionId: session,
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
    title: `${title}: the request`,
  });
  if (request.kind !== 'filed') throw new Error('request not filed');
  const s: Side = {
    env,
    questions: [],
    repo,
    request: request.id,
    session,
    transcript: '',
  };
  for (const [priority, question] of asks) {
    s.questions.push(await ask(s, priority, question));
  }
  const dir = join(sb.path, 'projects', name);
  mkdirSync(dir, {recursive: true});
  s.transcript = join(dir, `${session}.jsonl`);
  writeFileSync(
    s.transcript,
    `${JSON.stringify({
      cwd: repo,
      message: {content: title, role: 'user'},
      sessionId: session,
      timestamp: at(0).toISOString(),
      type: 'user',
    })}\n`,
  );
  return s;
}

async function two(): Promise<Two> {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, sessionBeads: true, trimGuard: true},
      },
    }),
  );
  const base: Record<string, string | undefined> = {
    CHORES_STATE_DIR: join(sb.path, 'chores-state'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(sb.path, 'threads-repo'),
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    VITALS_STATE_DIR: join(sb.path, 'vitals-state'),
    XDG_CONFIG_HOME: xdg,
  };
  // B first, so its questions get Q100 and Q101 from the shared counter.
  const b = await makeSide(sb, base, 'repo-b', SESSION_B, 'Sweep the SDK', [
    ['2', 'Bump every repo today?'],
    ['3', 'Skip the archived repos?'],
  ]);
  const a = await makeSide(
    sb,
    base,
    'repo-a',
    SESSION_A,
    'Speed up the export',
    [
      ['1', 'Ship it on Friday?'],
      ['3', 'Gzip the output?'],
    ],
  );
  return {a, b, root: sb.path};
}

interface Run {
  code: number;
  stderr: string;
  stdout: string;
}

async function captured(body: () => Promise<number>): Promise<Run> {
  const printed: string[] = [];
  const errors: string[] = [];
  const spy = captureWriteStdout((text) => printed.push(text));
  const errorSpy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    },
  );
  try {
    const code = await body();
    return {code, stderr: errors.join('\n'), stdout: printed.join('\n')};
  } finally {
    spy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function status(
  s: Side,
  now: Date,
  options: {
    changes?: boolean;
    color?: boolean;
    full?: boolean;
    message?: string;
    reportFile?: string;
  } = {},
): Promise<Run> {
  return await captured(
    async () =>
      await runThreadStatus({
        changes: options.changes ?? false,
        cwd: s.repo,
        env: s.env,
        full: options.full ?? false,
        message: options.message ?? null,
        now,
        reportFile: options.reportFile ?? null,
        sessionId: null,
        style: options.color === true ? {color: true, width: 100} : PLAIN_STYLE,
        timeZone: 'UTC',
      }),
  );
}

async function show(s: Side, now: Date): Promise<string> {
  const out = await captured(
    async () =>
      await runSessionShow({
        cwd: s.repo,
        env: s.env,
        full: false,
        now,
        selector: null,
        sessionId: s.session,
        style: PLAIN_STYLE,
        timeZone: 'UTC',
      }),
  );
  expect(out.code).toBe(0);
  return out.stdout;
}

function block(out: string): string {
  const start = out.indexOf(PART_ONE_RULE);
  const end = out.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length;
  return out.slice(start, end);
}

function writeMessage(t: Two, name: string, text: string): string {
  const path = join(t.root, name);
  writeFileSync(path, text);
  return path;
}

/** Where each landmark is in a block; -1 when absent. */
function order(text: string): {
  footer: number;
  message: number;
  other: number;
  questions: number;
} {
  return {
    footer: text.indexOf('**Repo:**'),
    message: text.indexOf(`## ${CLAUDE_MESSAGE_HEADING}`),
    other: text.indexOf(`## ${OTHER_QUESTIONS_HEADING}`),
    questions: text.indexOf(`## ${QUESTIONS_HEADING}`),
  };
}

function expectMessageInPlace(text: string, message: string): void {
  const where = order(text);
  expect(where.message).toBeGreaterThan(where.questions);
  expect(where.footer).toBeGreaterThan(where.message);
  expect(text).toContain(
    `## ${CLAUDE_MESSAGE_HEADING}\n\n${message}\n\n---\n\n`,
  );
}

function stopHook(s: Side, message: string, minute: number): void {
  const result = runThreadStopCheck({
    env: s.env,
    now: at(minute),
    stdin: JSON.stringify({
      cwd: s.repo,
      hook_event_name: 'Stop',
      last_assistant_message: message,
      session_id: s.session,
      stop_hook_active: false,
      transcript_path: s.transcript,
    }),
  });
  expect(result.exitCode).toBe(0);
}

/**
 * Claude's turn ended at `minute` with `out`'s block as the whole message: the
 * Stop hook ran, and (as the capture hook does) the message log holds it.
 */
function endTurnPasting(s: Side, minute: number, out: string): void {
  stopHook(s, block(out), minute);
  const log = messageLogPath(s.session, s.env);
  if (!existsSync(log)) {
    appendMessageLine(log, {
      at: at(0).toISOString(),
      cwd: s.repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text: 'Speed it up',
    });
  }
  appendMessageLine(log, {
    at: at(minute).toISOString(),
    cwd: s.repo,
    event: 'Stop',
    role: 'assistant',
    text: block(out),
  });
  appendFileSync(
    s.transcript,
    `${JSON.stringify({
      subtype: 'turn_duration',
      timestamp: at(minute).toISOString(),
      type: 'system',
    })}\n`,
  );
}

const REPLY = [
  '## Answers',
  '',
  '- **You asked:** why was it slow?',
  '',
  '',
  '- **Answer:** the index was cold.',
  '',
  '```',
  'bun run export',
  '```',
].join('\n');

// ---------------------------------------------------------------------------
// D4: the message section
// ---------------------------------------------------------------------------

describe('thread status --message (D4)', () => {
  test('verbatim as From Claude, after the questions and before the footer, in plain, --full, --changes and the report file', async () => {
    const t = await two();
    // CRLF line ends and trailing blank lines are normalised away.
    const path = writeMessage(
      t,
      'reply.md',
      `${REPLY.replaceAll('\n', '\r\n')}\r\n\r\n\n`,
    );
    const plain = await status(t.a, at(1), {message: path});
    expect(plain.code).toBe(0);
    expectMessageInPlace(block(plain.stdout), REPLY);
    // Nothing of the message after the block: it is inside it.
    expect(
      plain.stdout.slice(plain.stdout.indexOf(PART_ONE_SEPARATOR)),
    ).not.toContain('the index was cold');

    const full = await status(t.a, at(1), {full: true, message: path});
    expectMessageInPlace(block(full.stdout), REPLY);

    endTurnPasting(t.a, 2, plain.stdout);
    const changes = await status(t.a, at(3), {changes: true, message: path});
    expect(changes.code).toBe(0);
    // Under --changes nothing changed, and the message is still shown.
    expect(block(changes.stdout)).toContain('No question has changed');
    expectMessageInPlace(block(changes.stdout), REPLY);

    const file = join(t.root, 'report.md');
    const filed = await status(t.a, at(3), {
      changes: true,
      message: path,
      reportFile: file,
    });
    expect(filed.code).toBe(0);
    const written = await Bun.file(file).text();
    expectMessageInPlace(written, REPLY);

    // Control: without --message there is no such section.
    const none = await status(t.a, at(3));
    expect(order(block(none.stdout)).message).toBe(-1);
  });

  test('on a TTY the message keeps its lines and sits before the footer', async () => {
    const t = await two();
    const path = writeMessage(t, 'reply.md', REPLY);
    const out = await status(t.a, at(1), {color: true, message: path});
    expect(out.code).toBe(0);
    const text = block(out.stdout);
    expect(text).toContain(CLAUDE_MESSAGE_HEADING);
    expect(text).toContain('  - **Answer:** the index was cold.');
    expect(text.indexOf('the index was cold')).toBeLessThan(
      text.indexOf('Repo:'),
    );
  });

  test('an unreadable, empty or block-ending message file: exit 2, why, and nothing printed or saved', async () => {
    const t = await two();
    const cases: [string, string][] = [
      [join(t.root, 'missing.md'), 'could not be read'],
      [writeMessage(t, 'empty.md', '\n  \n\n'), 'it is empty'],
      [
        writeMessage(t, 'rule.md', `fine\n${PART_ONE_SEPARATOR}\nmore`),
        'line 2 is a line of',
      ],
      [
        writeMessage(t, 'om.md', `fine\n${'🕉️'.repeat(29)}`),
        'line 2 is a line of 🕉',
      ],
      [
        writeMessage(t, 'om-one.md', 'fine\n 🕉 \nmore'),
        'line 2 is a line of 🕉',
      ],
    ];
    for (const [path, why] of cases) {
      const out = await status(t.a, at(1), {
        message: path,
        reportFile: join(t.root, 'never.md'),
      });
      expect(out.code).toBe(2);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain(why);
      expect(out.stderr).toContain(path);
    }
    expect(existsSync(reportSnapshotsPath(SESSION_A, t.a.env))).toBe(false);
    expect(readStatusBlocks(SESSION_A, t.a.env).kind).not.toBe('found');
    expect(existsSync(join(t.root, 'never.md'))).toBe(false);
    // Control: the same run with a good file saves both.
    const good = await status(t.a, at(1), {
      message: writeMessage(t, 'ok.md', 'ok'),
    });
    expect(good.code).toBe(0);
    expect(existsSync(reportSnapshotsPath(SESSION_A, t.a.env))).toBe(true);
    expect(readStatusBlocks(SESSION_A, t.a.env).kind).toBe('found');
  });

  test('F3: a sentence that mentions 🕉 is kept, and thread show still finds the block it is in', async () => {
    const t = await two();
    const message =
      'The old report ended with a line of 🕉️; this sentence only mentions 🕉 twice: 🕉🕉.';
    const out = await status(t.a, at(1), {
      message: writeMessage(t, 'om-prose.md', message),
    });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expectMessageInPlace(block(out.stdout), message);
    // The bounds read the same line test: the pasted block is found and
    // stripped as Part 1, so thread show shows the message inside it.
    endTurnPasting(t.a, 2, out.stdout);
    const shown = await show(t.a, at(5));
    expectMessageInPlace(
      block(shown),
      `*Written Tue 2030-01-01 9:01 am.*\n\n${message}`,
    );
    expect(shown).toContain('its message is in Part 1 above');
  });

  test('the snapshot stores the message, and pasting the block marks it shown', async () => {
    const t = await two();
    const path = writeMessage(t, 'reply.md', REPLY);
    const out = await status(t.a, at(1), {message: path});
    const before = readReportSnapshots(SESSION_A, t.a.env);
    if (before.kind !== 'found') throw new Error(before.kind);
    expect(before.snapshots.at(-1)?.message).toBe(REPLY);
    expect(before.snapshots.at(-1)?.shownAt).toBeNull();
    endTurnPasting(t.a, 2, out.stdout);
    const after = readReportSnapshots(SESSION_A, t.a.env);
    if (after.kind !== 'found') throw new Error(after.kind);
    expect(after.snapshots.at(-1)?.shownAt).toBe(at(2).toISOString());
    // A run without --message stores null.
    await status(t.a, at(3));
    const third = readReportSnapshots(SESSION_A, t.a.env);
    if (third.kind !== 'found') throw new Error(third.kind);
    expect(third.snapshots.at(-1)?.message).toBeNull();
  });

  test('nothing is written to the threads repo (a private session writes nothing new there)', async () => {
    const t = await two();
    const threads = t.a.env.JUSTIN_THREADS_REPO_DIR ?? '';
    const listing = (): string[] =>
      existsSync(threads)
        ? readdirSync(threads, {recursive: true}).map(String)
        : [];
    const before = listing();
    const path = writeMessage(t, 'reply.md', 'See Q100.');
    const out = await status(t.a, at(1), {
      message: path,
      reportFile: join(t.root, 'report.md'),
    });
    expect(out.code).toBe(0);
    endTurnPasting(t.a, 2, out.stdout);
    await show(t.a, at(3));
    expect(listing()).toEqual(before);
  });
});

describe('thread status --message with session beads off (home-base-88y8m.8 R5)', () => {
  test('the message is never dropped silently: a stderr line and exit 1', async () => {
    const t = await two();
    const path = writeMessage(t, 'reply.md', REPLY);
    // Control: with session beads on, the same run shows it and exits 0.
    const on = await status(t.a, at(1), {message: path});
    expect(on.code).toBe(0);
    expect(on.stderr).toBe('');
    expectMessageInPlace(block(on.stdout), REPLY);

    writeFileSync(
      join(t.root, 'xdg', 'justin-sdk', 'config.json'),
      JSON.stringify({
        componentConfig: {thread: {enabled: true, sessionBeads: false}},
      }),
    );
    const logged: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      },
    );
    try {
      const off = await status(t.a, at(2), {message: path});
      expect(logged.join('\n')).toStartWith('SESSION BEADS: DISABLED');
      expect(off.code).toBe(1);
      expect(off.stderr).toBe(
        messageNotShownLine(path, 'session beads are off here'),
      );
      // Control: the same run without --message is the plain "off" answer.
      const plain = await status(t.a, at(2));
      expect(plain.code).toBe(0);
      expect(plain.stderr).toBe('');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('thread show and the stored message (D4)', () => {
  test("the newest shown report's message, with its time, inside Part 1", async () => {
    const t = await two();
    const path = writeMessage(t, 'reply.md', REPLY);
    const out = await status(t.a, at(1), {message: path});
    endTurnPasting(t.a, 2, out.stdout);
    const shown = await show(t.a, at(5));
    const part = block(shown);
    expectMessageInPlace(part, `*Written Tue 2030-01-01 9:01 am.*\n\n${REPLY}`);
    // The pasted block was the whole last message: said, not "only a Part 1".
    expect(shown).toContain('its message is in Part 1 above');
    expect(shown).not.toContain('was only a pasted Part 1');
  });

  test('R4 (home-base-88y8m.8): a malformed line after the newest shown report makes its message unknown, never the older one', async () => {
    const t = await two();
    const out = await status(t.a, at(1), {
      message: writeMessage(t, 'reply.md', REPLY),
    });
    endTurnPasting(t.a, 2, out.stdout);
    expect(newestShownMessage(SESSION_A, t.a.env).kind).toBe('found');
    const path = reportSnapshotsPath(SESSION_A, t.a.env);
    const saved = readFileSync(path, 'utf8');
    // A line that cannot be read, after the shown one: it may be a newer
    // shown report, with no message or another one.
    writeFileSync(path, `${saved}{"at": "not a snapshot"\n`);
    const read = newestShownMessage(SESSION_A, t.a.env);
    expect(read.kind).toBe('unknown');
    expect(JSON.stringify(read)).toContain(
      'line 2 could not be parsed, and it comes after the newest report you were shown',
    );
    const shown = await show(t.a, at(5));
    expect(block(shown)).toContain('could not be read');
    expect(block(shown)).not.toContain('the index was cold');
    // Control: the same line BEFORE the shown report hides nothing.
    writeFileSync(path, `{"at": "not a snapshot"\n${saved}`);
    expect(newestShownMessage(SESSION_A, t.a.env)).toMatchObject({
      kind: 'found',
      message: REPLY,
    });
    expect(block(await show(t.a, at(6)))).toContain('the index was cold');
  });

  test('R4 (home-base-88y8m.8): "its message is in Part 1 above" only when the last message is the report the message was stored with', async () => {
    const t = await two();
    const first = await status(t.a, at(1), {
      message: writeMessage(t, 'reply.md', REPLY),
    });
    endTurnPasting(t.a, 2, first.stdout);
    // Control: the last message is that report, so it is said.
    expect(await show(t.a, at(3))).toContain('its message is in Part 1 above');
    // A later turn ends with another block that was never marked shown (the
    // Stop hook did not run): the stored message is still the newest shown
    // one, but the last message is not its report.
    const second = await status(t.a, at(4));
    appendMessageLine(messageLogPath(SESSION_A, t.a.env), {
      at: at(5).toISOString(),
      cwd: t.a.repo,
      event: 'Stop',
      role: 'assistant',
      text: block(second.stdout),
    });
    const shown = await show(t.a, at(6));
    expect(block(shown)).toContain('the index was cold');
    expect(shown).not.toContain('its message is in Part 1 above');
    expect(shown).toContain(
      '(Claude’s last message was only a pasted Part 1.)',
    );
  });

  test('a session that never used --message shows what it showed before', async () => {
    const t = await two();
    const out = await status(t.a, at(1));
    endTurnPasting(t.a, 2, out.stdout);
    const shown = await show(t.a, at(5));
    expect(order(block(shown)).message).toBe(-1);
    expect(shown).toContain(
      '(Claude’s last message was only a pasted Part 1.)',
    );
  });

  test(
    'a newer shown report without a message shows none, never the older one',
    async () => {
      const t = await two();
      const first = await status(t.a, at(1), {
        message: writeMessage(t, 'reply.md', REPLY),
      });
      endTurnPasting(t.a, 2, first.stdout);
      const second = await status(t.a, at(3));
      endTurnPasting(t.a, 4, second.stdout);
      const shown = await show(t.a, at(5));
      expect(order(block(shown)).message).toBe(-1);
      // Control: before the second paste the message is there.
      const t2 = await two();
      const again = await status(t2.a, at(1), {
        message: writeMessage(t2, 'reply.md', REPLY),
      });
      endTurnPasting(t2.a, 2, again.stdout);
      expect(order(block(await show(t2.a, at(5)))).message).toBeGreaterThan(-1);
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// D5: the questions the message names
// ---------------------------------------------------------------------------

describe('the questions a message names (D5)', () => {
  test("another session's questions, whole, with session, repo and state", async () => {
    const t = await two();
    // B's own run gives its questions Q100 and Q101.
    expect((await status(t.b, at(1))).code).toBe(0);
    const [b1 = '', b2 = ''] = t.b.questions;
    const closed = runBr(t.b.repo, [
      'close',
      b2,
      '--reason',
      `${ANSWER_PREFIX}Yes, skip them.`,
    ]);
    expect(closed.ok).toBe(true);
    const path = writeMessage(
      t,
      'reply.md',
      'Waiting on Q100 from the sweep; bd101 is settled.',
    );
    const out = await status(t.a, at(2), {message: path});
    expect(out.code).toBe(0);
    const text = block(out.stdout);
    const where = order(text);
    expect(where.other).toBeGreaterThan(where.questions);
    expect(where.message).toBeGreaterThan(where.other);
    const section = text.slice(where.other, where.message);
    // Whole: the context line is there, not only the title.
    expect(section).toContain('Context for Bump every repo today?');
    expect(section).toContain('Context for Skip the archived repos?');
    expect(section).toContain(`[Q100]`);
    expect(section).toContain(`(${b1})`);
    expect(section).toContain('from the session "');
    expect(section).toContain('in repo-b: open');
    expect(section).toContain('in repo-b: answered');
    expect(section).toContain('> Yes, skip them.');
    // Numbered after A's own two questions, so no number is shown twice.
    expect(section).toMatch(/^3\. \[Q10[01]\]/mu);
    expect(section).toMatch(/^4\. \[Q10[01]\]/mu);
    // The report file holds the same section.
    const file = join(t.root, 'report.md');
    await status(t.a, at(2), {message: path, reportFile: file});
    expect(await Bun.file(file).text()).toContain(section);
    // thread show runs the same resolution over the stored message.
    endTurnPasting(t.a, 3, out.stdout);
    expect(block(await show(t.a, at(4)))).toContain(section);
    // Control: a message that names no id has no such section.
    const plain = await status(t.a, at(5), {
      message: writeMessage(t, 'plain.md', 'No ids here.'),
    });
    expect(order(block(plain.stdout)).other).toBe(-1);
  });

  test('a closed question without an answer says so', async () => {
    const t = await two();
    await status(t.b, at(1));
    const [b1 = ''] = t.b.questions;
    expect(runBr(t.b.repo, ['close', b1, '--reason', 'not needed']).ok).toBe(
      true,
    );
    const out = await status(t.a, at(2), {
      message: writeMessage(t, 'reply.md', 'Q100'),
    });
    expect(block(out.stdout)).toContain(
      'in repo-b: closed, with no answer (not needed)',
    );
  });

  test("F1 and F2: the section is named for what it holds, this session's own answered question included, and only an open question keeps its default line", async () => {
    const t = await two();
    await status(t.b, at(1));
    const [b1 = '', b2 = ''] = t.b.questions;
    const [a1 = '', a2 = ''] = t.a.questions;
    // B's second question and A's own first one are answered; B's first is
    // still open. Ids: B's Q100 and Q101, then A's Q102 and Q103.
    for (const [repo, id] of [
      [t.b.repo, b2],
      [t.a.repo, a1],
    ] as const) {
      expect(
        runBr(repo, ['close', id, '--reason', `${ANSWER_PREFIX}Settled.`]).ok,
      ).toBe(true);
    }
    const path = writeMessage(
      t,
      'reply.md',
      'Q100 is still open; Q101 and Q102 are settled.',
    );
    const fallback = "If you don't answer: I keep going as planned.";
    for (const color of [false, true]) {
      const out = await status(t.a, at(2), {color, message: path});
      expect(out.code).toBe(0);
      const text = color ? out.stdout : block(out.stdout);
      // F1: the heading says what the section holds.
      expect(text).toContain(
        color
          ? 'Other questions the message names'
          : '## Other questions the message names',
      );
      expect(text).not.toContain('Questions from other sessions');
      const start = text.indexOf('Other questions the message names');
      const end = text.indexOf(CLAUDE_MESSAGE_HEADING, start);
      const section = text.slice(start, end);
      const item = (id: string): string => {
        const from = section.indexOf(`(${id})`);
        const next = [b1, b2, a1]
          .map((other) => section.indexOf(`(${other})`))
          .filter((index) => index > from)
          .sort((x, y) => x - y)[0];
        return section.slice(from, next ?? section.length);
      };
      for (const id of [b1, b2, a1]) expect(section).toContain(`(${id})`);
      // This session's own answered question is in the section (F1's cause).
      expect(section).toContain('in repo-a: answered');
      // F2: the open one keeps its default; the answered ones have none.
      expect(item(b1)).toContain(fallback);
      expect(item(b2)).not.toContain(fallback);
      expect(item(a1)).not.toContain(fallback);
      expect(section.split(fallback).length - 1).toBe(1);
      // Control: A's own open question in Questions for you keeps its line.
      const questions = text.slice(0, start);
      expect(questions).toContain(`(${a2})`);
      expect(questions).toContain(fallback);
    }
  });

  test('an own open question that --changes leaves out is kept whole when the message names it', async () => {
    const t = await two();
    await status(t.b, at(1));
    const first = await status(t.a, at(2));
    endTurnPasting(t.a, 3, first.stdout);
    const [a1 = ''] = t.a.questions;
    // A's P1 got Q102 when it was filed (after B's Q100 and Q101).
    const named = await status(t.a, at(4), {
      changes: true,
      message: writeMessage(t, 'reply.md', 'Still waiting on BD102.'),
    });
    const text = block(named.stdout);
    const questions = text.slice(order(text).questions, order(text).message);
    expect(questions).toContain(`(${a1})`);
    expect(questions).toContain('Context for Ship it on Friday?');
    expect(questions).toContain('1 more question has not changed');
    expect(order(text).other).toBe(-1);
    // Control: the same run naming nothing leaves it out.
    const unnamed = await status(t.a, at(4), {
      changes: true,
      message: writeMessage(t, 'none.md', 'Nothing named.'),
    });
    expect(block(unnamed.stdout)).not.toContain(`(${a1})`);
  });

  test('an id that matches nothing, matches two questions, or cannot be read: one line each', async () => {
    const t = await two();
    await status(t.b, at(1));
    // Two beads in repo-b carry qid:150.
    for (const id of [t.b.request, t.b.questions[0] ?? '']) {
      expect(runBr(t.b.repo, ['update', id, '--add-label', 'qid:150']).ok).toBe(
        true,
      );
    }
    const out = await status(t.a, at(2), {
      message: writeMessage(t, 'reply.md', 'Q999 and Q150.'),
    });
    const text = block(out.stdout);
    // home-base-88y8m.8 R3: with the relay's caveat, spelled out here so a
    // change to either is seen.
    expect(text).toContain(
      "*⚠️ Q999 matches no question in any repo this Mac's sessions index knows. An export can trail its database by a moment after a question is filed. It may have been filed just now.*",
    );
    expect(text).toContain(
      '*⚠️ Q150 is the id of 2 questions, so none is shown:',
    );

    // repo-b's export cannot be read: never "matches no question".
    const exported = recordedBeadsJsonl(join(t.b.repo, '.beads'));
    if (exported.kind !== 'found') throw new Error(exported.kind);
    chmodSync(exported.path, 0o000);
    restore.push(() => chmodSync(exported.path, 0o644));
    const unread = await status(t.a, at(3), {
      message: writeMessage(t, 'reply2.md', 'Q100'),
    });
    const unreadText = block(unread.stdout);
    expect(unreadText).toContain('*⚠️ Q100 could not be looked up:');
    expect(unreadText).toContain(exported.path);
    expect(unreadText).not.toContain('Q100 matches no question');
  });
});
