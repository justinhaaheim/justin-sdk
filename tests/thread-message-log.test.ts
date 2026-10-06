/**
 * The message log keeps EVERY yield and EVERY human message
 * (home-base-k0b8n.18).
 *
 * Three bugs, one per decision on the bead:
 *
 *  - D-18A. A conductor wakes on task notifications and yields at every one of
 *    them, with no human message in between. The old turn model kept the LAST
 *    text before the next human message, so one Stop survived per human
 *    message (4 of 19 on session 5a3c3420). A yield is now a Stop.
 *  - D-18B. A message Justin sends while Claude is working is written as a
 *    `queued_command` attachment, never as a user record, so no reader saw it
 *    (all four on session 3078e057).
 *  - D-18C. The rewrite kept a live line only when it was stamped after the
 *    transcript's last record, so the two bugs above erased what the live
 *    hooks HAD captured. A live line now goes only when the transcript has the
 *    same message.
 *
 * THE RECORD SHAPES below are copied from the real transcripts (5a3c3420 and
 * 3078e057), keys and all, with the content replaced — including the order
 * Claude Code writes them in: a task-notification attachment lands AFTER the
 * text it woke Claude for, stamped earlier.
 *
 * NEGATIVE CONTROLS: recorded on home-base-k0b8n.18's notes, each with the line
 * broken and the assertion that went red.
 */

import type {MessageLine} from '../src/thread/message-log';

import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {messageLogPath} from '../src/thread/archive';
import {memoizedTranscript, seedMessageLogOnce} from '../src/thread/capture';
import {
  carriedLiveLines,
  linesFromTurns,
  mergeCarriedLines,
  parseMessageLine,
  serializeMessageLine,
  syncMessageLogFromTranscript,
} from '../src/thread/message-log';
import {
  extractTranscriptMessages,
  extractTranscriptTurns,
  queuedPromptText,
} from '../src/thread/transcript-messages';

const SESSION = '7d3f2c1a-5b6e-4f70-8a91-b2c3d4e5f601';
const CWD = '/Users/x/Dev/repo';

type Rec = Record<string, unknown>;

function base(at: string, extra: Rec): Rec {
  return {
    cwd: CWD,
    entrypoint: 'cli',
    isSidechain: false,
    sessionId: SESSION,
    timestamp: at,
    userType: 'external',
    ...extra,
  };
}

/** A prompt Justin typed at the input box. */
const human = (at: string, text: string): Rec =>
  base(at, {message: {content: text, role: 'user'}, type: 'user'});

/** Claude text, with the empty thinking block real records carry. */
const said = (at: string, text: string): Rec =>
  base(at, {
    message: {
      content: [
        {signature: 'sig', thinking: '', type: 'thinking'},
        {text, type: 'text'},
      ],
      role: 'assistant',
    },
    type: 'assistant',
  });

const toolUse = (at: string): Rec =>
  base(at, {
    message: {
      content: [{id: 'toolu_1', input: {}, name: 'Bash', type: 'tool_use'}],
      role: 'assistant',
    },
    type: 'assistant',
  });

const toolResult = (at: string): Rec =>
  base(at, {
    message: {
      content: [{content: 'ok', tool_use_id: 'toolu_1', type: 'tool_result'}],
      role: 'user',
    },
    toolUseResult: {stdout: 'ok'},
    type: 'user',
  });

/** The Stop hooks ran. `hookErrors` non-empty = a hook refused the yield. */
const stopHookSummary = (at: string, hookErrors: string[] = []): Rec =>
  base(at, {
    hasOutput: true,
    hookAdditionalContext: [],
    hookCount: 5,
    hookErrors,
    hookInfos: [{command: 'bun run justin-sdk thread capture', durationMs: 5}],
    level: 'suggestion',
    preventedContinuation: false,
    stopReason: '',
    subtype: 'stop_hook_summary',
    type: 'system',
  });

const turnDuration = (at: string): Rec =>
  base(at, {
    durationMs: 904_427,
    messageCount: 401,
    pendingBackgroundAgentCount: 1,
    subtype: 'turn_duration',
    type: 'system',
  });

/** A queued message. `timestamp` false = a pre-v2.1.170 attachment, no stamp. */
function queued(
  at: string,
  commandMode: string,
  prompt: unknown,
  options: {origin?: string; timestamp?: boolean} = {},
): Rec {
  return base(at, {
    attachment: {
      commandMode,
      ...(options.origin == null ? {} : {origin: {kind: options.origin}}),
      prompt,
      source_uuid: 'b6c1d2e3-0000-4000-8000-000000000001',
      ...(options.timestamp === false ? {} : {timestamp: at}),
      type: 'queued_command',
    },
    type: 'attachment',
  });
}

const TASK_NOTIFICATION =
  '<task-notification>\n<task-id>a0925c7d1ff48827e</task-id>\n<tool-use-id>toolu_01A9</tool-use-id>\n<status>completed</status>\n<summary>Agent "dispatch 1" completed</summary>\n</task-notification>';

const HAND_BACK =
  '<agent-message from="ab3aa885ae7ad6aeb">\n[Subagent hand-back] The text below is the final report of a subagent you dispatched.\n\nDispatch 2 landed: 396 pass.\n</agent-message>';

function writeTranscript(records: readonly Rec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-message-log-'));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(
    path,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
  return path;
}

function transcriptLines(path: string): MessageLine[] {
  return linesFromTurns(extractTranscriptTurns(path).turns);
}

const summary = (lines: readonly MessageLine[]): string[] =>
  lines.map((line) => `${line.role}: ${line.text}`);

// ---------------------------------------------------------------------------
// The conductor shape (5a3c3420): four Stops between two human messages
// ---------------------------------------------------------------------------

const BRIEF_AT = '2026-09-19T10:51:00.297Z';

/**
 * A human brief, then FOUR Stops each woken by a task notification, then the
 * next human message. Each Stop carries both marks, summary first, a few ms
 * apart, as 2,386 of 4,004 real Stops do. Narration and tool calls sit between
 * them, which the old rule and the new one must both leave out.
 */
const CONDUCTOR: Rec[] = [
  human(BRIEF_AT, 'You are the /conductor. Build the thing.'),
  said('2026-09-19T10:51:05.514Z', 'Prime directive check: greenfield.'),
  toolUse('2026-09-19T10:51:06.000Z'),
  toolResult('2026-09-19T10:51:07.000Z'),
  said('2026-09-19T11:06:04.513Z', 'YIELD 1: all three scopes are on beads.'),
  toolUse('2026-09-19T11:06:04.600Z'),
  toolResult('2026-09-19T11:06:04.650Z'),
  stopHookSummary('2026-09-19T11:06:04.695Z'),
  turnDuration('2026-09-19T11:06:04.703Z'),
  // Woken by a finished player: the text first, the attachment after it,
  // stamped EARLIER — exactly as Claude Code writes it.
  said('2026-09-19T11:25:02.079Z', 'Dispatch 1 landed. Verifying its claims.'),
  queued('2026-09-19T11:24:38.952Z', 'task-notification', TASK_NOTIFICATION),
  toolUse('2026-09-19T11:25:03.000Z'),
  toolResult('2026-09-19T11:25:04.000Z'),
  said('2026-09-19T11:28:08.710Z', 'YIELD 2: dispatch 2 is running.'),
  stopHookSummary('2026-09-19T11:28:08.841Z'),
  turnDuration('2026-09-19T11:28:08.846Z'),
  // An older transcript's notification: a user record, all noise.
  human('2026-09-19T12:02:36.515Z', TASK_NOTIFICATION),
  said('2026-09-19T12:02:42.462Z', 'Dispatch 2 landed with 396 pass.'),
  said('2026-09-19T12:04:52.524Z', 'YIELD 3: dispatch 3 is running.'),
  stopHookSummary('2026-09-19T12:04:52.699Z'),
  turnDuration('2026-09-19T12:04:52.703Z'),
  queued('2026-09-19T12:48:37.651Z', 'task-notification', TASK_NOTIFICATION),
  said('2026-09-19T12:50:54.446Z', 'YIELD 4: the verdict is on the beads.'),
  stopHookSummary('2026-09-19T12:50:54.565Z'),
  turnDuration('2026-09-19T12:50:54.570Z'),
  human('2026-09-23T08:17:37.468Z', 'Give me a brief description.'),
  said('2026-09-23T08:17:54.345Z', 'YIELD 5: here it is.'),
  stopHookSummary('2026-09-23T08:17:54.465Z'),
  turnDuration('2026-09-23T08:17:54.474Z'),
];

const CONDUCTOR_LINES = [
  'user: You are the /conductor. Build the thing.',
  'assistant: YIELD 1: all three scopes are on beads.',
  'assistant: YIELD 2: dispatch 2 is running.',
  'assistant: YIELD 3: dispatch 3 is running.',
  'assistant: YIELD 4: the verdict is on the beads.',
  'user: Give me a brief description.',
  'assistant: YIELD 5: here it is.',
];

describe('D-18A · a yield is a Stop', () => {
  test('AC 1: four task-notification Stops between two human messages are four yields, one per Stop, no duplicates', () => {
    const lines = transcriptLines(writeTranscript(CONDUCTOR));
    expect(summary(lines)).toEqual(CONDUCTOR_LINES);
    // Each yield carries its OWN record's stamp, not the marker's.
    expect(lines[1]?.at).toBe('2026-09-19T11:06:04.513Z');
    expect(lines[4]?.at).toBe('2026-09-19T12:50:54.446Z');
  });

  test('either mark alone is a Stop: a refused yield (summary only) and an error turn (turn_duration only)', () => {
    const lines = transcriptLines(
      writeTranscript([
        human('2026-09-23T11:00:00.000Z', 'run the suite'),
        said('2026-09-23T11:11:55.875Z', 'Dispatch 8 is waiting on its suite.'),
        // stop-check refused this yield: the hooks ran, the turn went on, so
        // there is no turn_duration (317 such Stops measured).
        stopHookSummary('2026-09-23T11:11:56.007Z', [
          'This turn committed work and no report was recorded.',
        ]),
        said('2026-09-23T11:13:19.537Z', 'Interim report recorded.'),
        stopHookSummary('2026-09-23T11:13:19.656Z'),
        turnDuration('2026-09-23T11:13:19.664Z'),
        human('2026-09-24T06:18:43.091Z', 'Continue'),
        // An API error ends the turn with no Stop hooks, so no summary (247
        // such Stops measured in sessions that otherwise have one).
        said(
          '2026-09-24T06:22:19.477Z',
          'API Error: 529 Overloaded. This is a server-side issue.',
        ),
        turnDuration('2026-09-24T06:22:19.492Z'),
        human('2026-09-24T06:31:28.665Z', 'Continue'),
      ]),
    );
    expect(summary(lines)).toEqual([
      'user: run the suite',
      'assistant: Dispatch 8 is waiting on its suite.',
      'assistant: Interim report recorded.',
      'user: Continue',
      'assistant: API Error: 529 Overloaded. This is a server-side issue.',
      'user: Continue',
    ]);
  });

  test('a Stop with no text since the last yield emits nothing (a tool-only turn)', () => {
    const lines = transcriptLines(
      writeTranscript([
        human('2026-09-23T10:00:00.000Z', 'go'),
        said('2026-09-23T10:00:01.000Z', 'Started.'),
        stopHookSummary('2026-09-23T10:00:01.100Z'),
        turnDuration('2026-09-23T10:00:01.110Z'),
        queued(
          '2026-09-23T10:05:00.000Z',
          'task-notification',
          TASK_NOTIFICATION,
        ),
        toolUse('2026-09-23T10:05:01.000Z'),
        toolResult('2026-09-23T10:05:02.000Z'),
        stopHookSummary('2026-09-23T10:05:03.000Z'),
        turnDuration('2026-09-23T10:05:03.010Z'),
      ]),
    );
    expect(summary(lines)).toEqual(['user: go', 'assistant: Started.']);
  });
});

describe('AC 3 · a turn that ended with no Stop still yields its last text', () => {
  test('an Esc-interrupted turn yields at the next human message; the live tail yields at the end of the file', () => {
    const lines = transcriptLines(
      writeTranscript([
        human('2026-09-23T08:41:54.804Z', 'about the settings file'),
        said(
          '2026-09-23T08:46:14.177Z',
          'Main is back to its committed state.',
        ),
        said('2026-09-23T08:46:23.654Z', 'Branch is current with main.'),
        toolUse('2026-09-23T08:46:24.000Z'),
        // No Stop mark: Justin pressed Esc and typed.
        human('2026-09-23T08:52:10.549Z', 'Continue'),
        said('2026-09-23T08:52:13.495Z', 'Continuing: writing the scope.'),
        stopHookSummary('2026-09-23T08:52:13.600Z'),
        turnDuration('2026-09-23T08:52:13.610Z'),
        human('2026-09-23T09:00:00.000Z', 'next'),
        said('2026-09-23T09:00:05.000Z', 'Still working on it.'),
      ]),
    );
    expect(summary(lines)).toEqual([
      'user: about the settings file',
      'assistant: Branch is current with main.',
      'user: Continue',
      'assistant: Continuing: writing the scope.',
      'user: next',
      'assistant: Still working on it.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// D-18B · queued messages (3078e057)
// ---------------------------------------------------------------------------

const QUEUED_AT = '2026-09-25T07:53:33.120Z';
const QUEUED_TEXT =
  'Oh, and if there are any scripts that would be helpful, write those too.';

/** 3078e057's shape: a queued human message, a hand-back and a notification. */
const QUEUED: Rec[] = [
  human('2026-09-25T07:50:37.415Z', 'Codify this process into a skill.'),
  said('2026-09-25T07:52:33.916Z', 'Running repo-status from inside works.'),
  toolUse('2026-09-25T07:52:34.000Z'),
  // Injected mid-turn: written at the injection point (after text stamped
  // later than it), stamped when Justin pressed Enter.
  queued(QUEUED_AT, 'prompt', QUEUED_TEXT, {origin: 'human'}),
  toolResult('2026-09-25T07:53:40.000Z'),
  queued('2026-09-25T07:53:41.000Z', 'prompt', HAND_BACK, {origin: 'peer'}),
  queued('2026-09-25T07:53:42.000Z', 'task-notification', TASK_NOTIFICATION),
  said('2026-09-25T07:53:47.268Z', 'Good idea. Checking the threads data.'),
  said('2026-09-25T08:10:37.099Z', 'Skill and scripts are committed.'),
  stopHookSummary('2026-09-25T08:10:37.262Z'),
  turnDuration('2026-09-25T08:10:37.268Z'),
];

describe('D-18B · a queued human message is a user message', () => {
  test('AC 2: a queued prompt with his words is a user line at ITS timestamp; a hand-back and a notification are not', () => {
    const lines = transcriptLines(writeTranscript(QUEUED));
    expect(summary(lines)).toEqual([
      'user: Codify this process into a skill.',
      `user: ${QUEUED_TEXT}`,
      'assistant: Skill and scripts are committed.',
    ]);
    expect(lines[1]?.at).toBe(QUEUED_AT);
    const all = JSON.stringify(lines);
    expect(all).not.toContain('Subagent hand-back');
    expect(all).not.toContain('Dispatch 2 landed');
    expect(all).not.toContain('task-notification');
  });

  test('the narration before a queued message is NOT a yield: the message joins the running turn, which yields at its own Stop', () => {
    const lines = transcriptLines(writeTranscript(QUEUED));
    expect(summary(lines)).not.toContain(
      'assistant: Running repo-status from inside works.',
    );
  });

  test('extractTranscriptMessages: the last thing he said is the queued message, at its timestamp', () => {
    const messages = extractTranscriptMessages(writeTranscript(QUEUED));
    expect(messages.lastUserMessage).toBe(QUEUED_TEXT);
    expect(messages.lastUserMessageAt).toBe(QUEUED_AT);
    expect(messages.firstUserMessage).toBe('Codify this process into a skill.');
  });

  test('a block-array prompt, and an old attachment with no timestamp of its own', () => {
    const lines = transcriptLines(
      writeTranscript([
        human('2026-06-09T03:30:00.000Z', 'start'),
        said('2026-06-09T03:31:00.000Z', 'working'),
        queued(
          '2026-06-09T03:37:59.015Z',
          'prompt',
          [
            {text: 'also check the', type: 'text'},
            {source: {data: 'x', type: 'base64'}, type: 'image'},
            {text: 'second screen', type: 'text'},
          ],
          {timestamp: false},
        ),
        said('2026-06-09T03:40:00.000Z', 'Both done.'),
        turnDuration('2026-06-09T03:40:00.100Z'),
      ]),
    );
    expect(summary(lines)).toEqual([
      'user: start',
      'user: also check the\nsecond screen',
      'assistant: Both done.',
    ]);
    expect(lines[1]?.at).toBe('2026-06-09T03:37:59.015Z');
  });

  test('queuedPromptText: the same substantive filter as a user record', () => {
    const record = (commandMode: string, prompt: unknown) =>
      queued('2026-09-25T00:00:00.000Z', commandMode, prompt) as never;
    expect(queuedPromptText(record('prompt', 'hello'))).toBe('hello');
    expect(queuedPromptText(record('prompt', HAND_BACK))).toBeNull();
    expect(
      queuedPromptText(
        record(
          'prompt',
          '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="peer">\nLanded.\n</cross-session-message>',
        ),
      ),
    ).toBeNull();
    // task-notification mode is noise whatever its text says.
    expect(queuedPromptText(record('task-notification', 'hello'))).toBeNull();
    expect(
      queuedPromptText(
        record('prompt', '<system-reminder>injected</system-reminder>  '),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-18C · the carry rule
// ---------------------------------------------------------------------------

function live(
  role: 'assistant' | 'user',
  text: string,
  at: string,
): MessageLine {
  return {
    at,
    cwd: CWD,
    event: role === 'user' ? 'UserPromptSubmit' : 'Stop',
    role,
    text,
  };
}

/** Milliseconds after `at`, the way a hook's clock trails its record. */
function after(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

/**
 * What the live hooks logged for CONDUCTOR + one message the transcript does
 * not have yet: every prompt and every Stop, each stamped a little after the
 * record it describes (the hook's clock, not the transcript's).
 */
function conductorLiveLog(): MessageLine[] {
  return [
    live(
      'user',
      'You are the /conductor. Build the thing.',
      after(BRIEF_AT, 90),
    ),
    live(
      'assistant',
      'YIELD 1: all three scopes are on beads.',
      after('2026-09-19T11:06:04.513Z', 180),
    ),
    live(
      'assistant',
      'YIELD 2: dispatch 2 is running.',
      after('2026-09-19T11:28:08.710Z', 130),
    ),
    live(
      'assistant',
      'YIELD 3: dispatch 3 is running.',
      after('2026-09-19T12:04:52.524Z', 170),
    ),
    live(
      'assistant',
      'YIELD 4: the verdict is on the beads.',
      after('2026-09-19T12:50:54.446Z', 120),
    ),
    live(
      'user',
      'Give me a brief description.',
      after('2026-09-23T08:17:37.468Z', 90),
    ),
    live(
      'assistant',
      'YIELD 5: here it is.',
      after('2026-09-23T08:17:54.345Z', 120),
    ),
    // The turn in flight: its Stop is logged, the transcript has not caught up.
    live(
      'assistant',
      'YIELD 6: not in the transcript yet.',
      '2026-09-23T08:30:00.000Z',
    ),
  ];
}

function stateEnv(): Record<string, string> {
  return {
    JUSTIN_THREADS_STATE_DIR: mkdtempSync(
      join(tmpdir(), 'thread-msglog-state-'),
    ),
  };
}

function writeLog(env: Record<string, string>, lines: readonly MessageLine[]) {
  const path = messageLogPath(SESSION, env);
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, lines.map(serializeMessageLine).join(''));
  return path;
}

function readLog(path: string): MessageLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseMessageLine(line))
    .filter((line): line is MessageLine => line != null);
}

describe('D-18C · a live line is never dropped for its timestamp alone', () => {
  test('AC 4: a live line OLDER than the transcript end that the transcript lacks is carried, in `at` order', () => {
    const fromTranscript = transcriptLines(writeTranscript(CONDUCTOR));
    const missed = live(
      'user',
      'a message the transcript never recorded',
      '2026-09-19T12:00:00.000Z',
    );
    const carried = carriedLiveLines(
      [...conductorLiveLog().slice(0, 7), missed],
      fromTranscript,
    );
    expect(carried).toEqual([missed]);
    const merged = mergeCarriedLines(fromTranscript, carried);
    // Between YIELD 2 (11:28) and YIELD 3 (12:04), where it happened.
    expect(summary(merged).slice(2, 5)).toEqual([
      'assistant: YIELD 2: dispatch 2 is running.',
      'user: a message the transcript never recorded',
      'assistant: YIELD 3: dispatch 3 is running.',
    ]);
  });

  test('AC 4: a live line the transcript also has appears ONCE, even when the writers trimmed differently', () => {
    const fromTranscript = transcriptLines(writeTranscript(CONDUCTOR));
    const carried = carriedLiveLines(
      [
        live(
          'assistant',
          '  YIELD 2: dispatch 2 is running.\n',
          '2026-09-19T11:28:09.000Z',
        ),
        live(
          'user',
          'Give me a brief description.\n\n',
          '2026-09-23T08:17:37.600Z',
        ),
      ],
      fromTranscript,
    );
    expect(carried).toEqual([]);
  });

  test('AC 4: the backfill rewrite of a live-captured conductor keeps every Stop, duplicates nothing, then converges', () => {
    const env = stateEnv();
    const transcript = writeTranscript(CONDUCTOR);
    const path = writeLog(env, conductorLiveLog());
    const first = syncMessageLogFromTranscript({
      env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    expect(first).toMatchObject({carried: 1, kind: 'written', messages: 8});
    const rebuilt = readLog(path);
    expect(summary(rebuilt)).toEqual([
      ...CONDUCTOR_LINES,
      'assistant: YIELD 6: not in the transcript yet.',
    ]);
    // Every live line is there, and each message exactly once.
    const texts = summary(rebuilt);
    expect(new Set(texts).size).toBe(texts.length);
    for (const line of conductorLiveLog()) {
      expect(texts).toContain(`${line.role}: ${line.text}`);
    }
    // Only the line the transcript lacks is still a live line.
    expect(rebuilt.filter((line) => line.event !== 'backfill')).toHaveLength(1);
    expect(
      syncMessageLogFromTranscript({
        env,
        sessionId: SESSION,
        transcriptPath: transcript,
      }),
    ).toMatchObject({carried: 1, kind: 'unchanged'});
  });

  test('AC 4: the capture seed (k0b8n.16) builds the same log as the backfill', () => {
    const transcriptPath = writeTranscript(CONDUCTOR);
    const backfillEnv = stateEnv();
    const backfillPath = writeLog(backfillEnv, conductorLiveLog());
    syncMessageLogFromTranscript({
      env: backfillEnv,
      sessionId: SESSION,
      transcriptPath,
    });

    const seedEnv = stateEnv();
    const seedPath = writeLog(seedEnv, conductorLiveLog());
    const seeded = seedMessageLogOnce(
      {env: seedEnv, sessionId: SESSION},
      memoizedTranscript({env: seedEnv, sessionId: SESSION, transcriptPath}),
    );
    expect(seeded).toMatchObject({carried: 1, kind: 'seeded', messages: 8});
    expect(readFileSync(seedPath, 'utf8')).toBe(
      readFileSync(backfillPath, 'utf8'),
    );
  });

  test('a queued message the live hook logged converges with the transcript line: once, at the transcript position', () => {
    const env = stateEnv();
    const transcript = writeTranscript(QUEUED);
    // UserPromptSubmit fires for a queued message ~90 ms after he sends it
    // (measured on 3078e057), long before it is injected into the turn.
    const path = writeLog(env, [
      live(
        'user',
        'Codify this process into a skill.',
        '2026-09-25T07:50:37.526Z',
      ),
      live('user', QUEUED_TEXT, after(QUEUED_AT, 89)),
      live(
        'assistant',
        'Skill and scripts are committed.',
        '2026-09-25T08:10:37.300Z',
      ),
    ]);
    syncMessageLogFromTranscript({
      env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    const rebuilt = readLog(path);
    expect(summary(rebuilt)).toEqual([
      'user: Codify this process into a skill.',
      `user: ${QUEUED_TEXT}`,
      'assistant: Skill and scripts are committed.',
    ]);
    expect(rebuilt.every((line) => line.event === 'backfill')).toBe(true);
  });

  test('a carried line with no usable `at` is kept, last, rather than dropped', () => {
    const fromTranscript = transcriptLines(writeTranscript(CONDUCTOR));
    const undated: MessageLine = {
      at: null,
      cwd: null,
      event: 'Stop',
      role: 'assistant',
      text: 'undated',
    };
    const merged = mergeCarriedLines(
      fromTranscript,
      carriedLiveLines([undated], fromTranscript),
    );
    expect(merged.at(-1)).toEqual(undated);
    expect(merged).toHaveLength(fromTranscript.length + 1);
  });
});
