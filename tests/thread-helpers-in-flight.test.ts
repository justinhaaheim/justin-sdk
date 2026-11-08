/**
 * F10 (home-base-j8q3e.1.10): a session whose helper agents (subagents) are
 * still in flight reads 🏃 Working, with "Nothing yet. Claude's helper agents
 * are still working." — also while a helper sits inside one long tool call
 * (no record for minutes), and also "if you stop now" (asIfYielded).
 *
 * The tails below are the shapes measured on the conductor session's 14
 * helpers (2026-10-15): finished ones end with the tool_result of
 * SubagentHandback; running ones with an assistant tool_use.
 *
 * NEGATIVE CONTROL (run once, dispatch 11): with deriveStatus's helper check
 * removed, the deriveStatus rows and the card test in
 * thread-session-card.test.ts failed; restored, they pass.
 */

import type {StatusFacts} from '../src/thread/session-status';
import type {UntrackedSession} from '../src/thread/session-untracked';

import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {DONE_PREFIX} from '../src/thread/ask-format';
import {neverHiddenByAge} from '../src/thread/session-inbox';
import {measured, readActivity, unmeasured} from '../src/thread/session-model';
import {
  deriveStatus,
  HELPER_WINDOW_MS,
  quietHelperReason,
} from '../src/thread/session-status';
import {untrackedVerdict} from '../src/thread/session-untracked';
import {
  HANDBACK_TOOL,
  HELPER_QUIET_LIMIT_MS,
  readHelperTail,
  readOpenBackgroundShells,
} from '../src/thread/transcript-messages';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const at = (hhmm: string): string => `2030-01-01T${hhmm}:00.000Z`;

type Rec = Record<string, unknown>;
const user = (time: string, content: unknown): Rec => ({
  isSidechain: true,
  message: {content, role: 'user'},
  timestamp: at(time),
  type: 'user',
});
const assistant = (time: string, content: unknown[]): Rec => ({
  isSidechain: true,
  message: {content, role: 'assistant'},
  timestamp: at(time),
  type: 'assistant',
});
const toolUse = (id: string, name: string): Rec => ({
  id,
  input: {},
  name,
  type: 'tool_use',
});
const toolResult = (id: string): Rec => ({
  content: 'ok',
  tool_use_id: id,
  type: 'tool_result',
});
const attachment = (time: string): Rec => ({
  attachment: {type: 'hook'},
  timestamp: at(time),
  type: 'attachment',
});

const dir = mkdtempSync(join(tmpdir(), 'helpers-in-flight-'));
function file(name: string, records: Rec[]): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  return path;
}

const PROMPT = user('11:00', 'Dispatch 1: build it');

describe('readHelperTail: in flight or finished, from the last conversation record', () => {
  const cases: [string, Rec[], boolean][] = [
    [
      'running: an assistant tool_use (Bash), the shape of a long tool call',
      [PROMPT, assistant('11:01', [toolUse('t1', 'Bash')])],
      true,
    ],
    [
      'running: a thinking-only record',
      [PROMPT, assistant('11:01', [{thinking: '…', type: 'thinking'}])],
      true,
    ],
    [
      'running: a tool result that answers Bash',
      [
        PROMPT,
        assistant('11:01', [toolUse('t1', 'Bash')]),
        user('11:02', [toolResult('t1')]),
      ],
      true,
    ],
    ['running: only the prompt so far', [PROMPT], true],
    [
      'finished: the tool result of SubagentHandback, then an attachment',
      [
        PROMPT,
        assistant('11:01', [toolUse('t9', 'SubagentHandback')]),
        user('11:02', [toolResult('t9')]),
        attachment('11:03'),
      ],
      false,
    ],
    [
      'finished: handing back, its result not yet written',
      [PROMPT, assistant('11:01', [toolUse('t9', 'SubagentHandback')])],
      false,
    ],
    [
      'finished: a final text reply with no tool_use (a helper without SubagentHandback)',
      [PROMPT, assistant('11:01', [{text: 'Done.', type: 'text'}])],
      false,
    ],
  ];
  for (const [name, records, inFlight] of cases) {
    test(name, () => {
      const read = readHelperTail(
        file(`${name.length}-${inFlight}.jsonl`, records),
      );
      expect(read.kind).toBe('found');
      if (read.kind !== 'found') return;
      expect(read.inFlight).toBe(inFlight);
      // The time is the last CONVERSATION record's, never the attachment's.
      const last = records.findLast((r) => r.type !== 'attachment');
      expect(read.at).toBe(last?.timestamp as string);
    });
  }

  test('an unreadable file fails, naming the path', () => {
    const read = readHelperTail(join(dir, 'missing.jsonl'));
    expect(read.kind).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// home-base-yd1co.2 D1: a text-ended tail is a finish, or a wait on its shell
// ---------------------------------------------------------------------------

/**
 * The shapes below are copied from helper a3909f4b of session a4286b3b
 * (Claude Code 2.1.319), trimmed: its launch of shell bzppr8q22 at
 * 2026-11-07T00:14:04.770Z, its turn ending in text at 00:14:06.844Z, the idle
 * notification at 00:38:43.135Z and a busy one (`queued_command`) at
 * 2026-11-06T23:46:08.067Z.
 */
const shellLaunch = (time: string, toolId: string, taskId: string): Rec => ({
  isSidechain: true,
  message: {
    content: [
      {
        content: `Command running in background with ID: ${taskId}. Output is being written to: /private/tmp/claude-501/x/tasks/${taskId}.output. You will be notified when it completes — do not poll that file or sleep while waiting.`,
        is_error: false,
        tool_use_id: toolId,
        type: 'tool_result',
      },
    ],
    role: 'user',
  },
  timestamp: at(time),
  toolUseResult: {
    backgroundTaskId: taskId,
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    stderr: '',
    stdout: '',
  },
  type: 'user',
});
const taskNotification = (taskId: string, toolId: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Background command "Run the whole suite again" completed (exit code 0)</summary>\n</task-notification>`;
const NOTIFICATION_PREAMBLE =
  '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.';
/** The helper was idle: a meta user record with string content. */
const notifiedIdle = (time: string, taskId: string, toolId: string): Rec => ({
  isMeta: true,
  isSidechain: true,
  message: {
    content: `${NOTIFICATION_PREAMBLE}\n\n${taskNotification(taskId, toolId)}`,
    role: 'user',
  },
  origin: {kind: 'task-notification', producer: 'session-task'},
  timestamp: at(time),
  type: 'user',
});
/** The helper was busy: a queued_command attachment. */
const notifiedBusy = (time: string, taskId: string, toolId: string): Rec => ({
  attachment: {
    commandMode: 'task-notification',
    origin: {kind: 'task-notification', producer: 'session-task'},
    prompt: taskNotification(taskId, toolId),
    type: 'queued_command',
  },
  isSidechain: true,
  timestamp: at(time),
  type: 'attachment',
});
/** Ending the turn to wait: a thinking record, then text, no tool_use. */
const endTurnInText = (time: string): Rec[] => [
  assistant(time, [{signature: 'sig', thinking: '', type: 'thinking'}]),
  assistant(time, [
    {
      text: "I've started it again with nothing else of mine running. I'll write the report once it finishes.",
      type: 'text',
    },
  ]),
];
const launchBash = (time: string, toolId: string): Rec =>
  assistant(time, [toolUse(toolId, 'Bash')]);

describe("readHelperTail D1 (home-base-yd1co.2): text with no tool_use, and the helper's own shells", () => {
  const cases: [string, Rec[], boolean][] = [
    [
      'waiting: ended in text while its background shell is open',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'bzppr8q22'),
        ...endTurnInText('11:02'),
      ],
      true,
    ],
    [
      'waiting: two shells, only one of them notified',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'bshell001'),
        launchBash('11:02', 'toolu_2'),
        shellLaunch('11:02', 'toolu_2', 'bshell002'),
        notifiedBusy('11:03', 'bshell001', 'toolu_1'),
        ...endTurnInText('11:04'),
      ],
      true,
    ],
    [
      'finished: ended in text, its shell notified while it was idle',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'bzppr8q22'),
        ...endTurnInText('11:02'),
        notifiedIdle('11:20', 'bzppr8q22', 'toolu_1'),
        assistant('11:21', [{text: 'All green. Done.', type: 'text'}]),
      ],
      false,
    ],
    [
      'finished: ended in text, its shell notified while it was busy',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'bgo8rmuka'),
        launchBash('11:02', 'toolu_2'),
        notifiedBusy('11:03', 'bgo8rmuka', 'toolu_1'),
        user('11:03', [toolResult('toolu_2')]),
        assistant('11:04', [{text: 'Done.', type: 'text'}]),
      ],
      false,
    ],
    [
      'finished: handing back with a shell still open (a handback is final)',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'borphan01'),
        assistant('11:02', [toolUse('t9', HANDBACK_TOOL)]),
      ],
      false,
    ],
    [
      "finished: the handback's result with a shell still open",
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'borphan01'),
        assistant('11:02', [toolUse('t9', HANDBACK_TOOL)]),
        user('11:02', [toolResult('t9')]),
      ],
      false,
    ],
    [
      'running: the idle notification itself is the last record (it has just been woken)',
      [
        PROMPT,
        launchBash('11:01', 'toolu_1'),
        shellLaunch('11:01', 'toolu_1', 'bzppr8q22'),
        ...endTurnInText('11:02'),
        notifiedIdle('11:20', 'bzppr8q22', 'toolu_1'),
      ],
      true,
    ],
  ];
  for (const [name, records, inFlight] of cases) {
    test(name, () => {
      const read = readHelperTail(file(`d1-${name}.jsonl`, records), {
        now: NOW,
      });
      expect(read).toEqual({
        at: records.findLast((r) => r.type !== 'attachment')
          ?.timestamp as string,
        inFlight,
        kind: 'found',
      });
    });
  }

  test('the whole-file scan finds a launch that lies outside the tail window', () => {
    const filler: Rec[] = [];
    for (let index = 0; index < 300; index += 1) {
      filler.push(
        assistant('11:10', [toolUse(`toolu_f${index}`, 'Read')]),
        user('11:10', [
          {
            content: 'x'.repeat(1200),
            tool_use_id: `toolu_f${index}`,
            type: 'tool_result',
          },
        ]),
      );
    }
    const launch = shellLaunch('11:01', 'toolu_1', 'bfar00001');
    const path = file('d1-far-launch.jsonl', [
      PROMPT,
      launchBash('11:01', 'toolu_1'),
      launch,
      ...filler,
      ...endTurnInText('11:50'),
    ]);
    // The tail read is 256 KiB (LAST_RECORD_WINDOW_BYTES); the launch ends
    // further back than that, so only the whole-file scan can see it.
    const text = readFileSync(path, 'utf8');
    const launchEnd =
      Buffer.byteLength(
        text.slice(0, text.indexOf(JSON.stringify(launch))),
        'utf8',
      ) + Buffer.byteLength(JSON.stringify(launch), 'utf8');
    expect(Buffer.byteLength(text, 'utf8') - launchEnd).toBeGreaterThan(
      256 * 1024,
    );
    expect(readOpenBackgroundShells(path)).toEqual({
      kind: 'read',
      open: ['bfar00001'],
    });
    expect(readHelperTail(path, {now: NOW})).toEqual({
      at: at('11:50'),
      inFlight: true,
      kind: 'found',
    });
  });

  test('a text-ended tail 2 hours old or older is not scanned: finished, whatever is open', () => {
    const path = file('d1-old-tail.jsonl', [
      user('09:00', 'Dispatch 1: build it'),
      launchBash('09:01', 'toolu_1'),
      shellLaunch('09:01', 'toolu_1', 'bold00001'),
      ...endTurnInText('10:00'),
    ]);
    // Exactly 2 hours: an in-flight verdict could change nothing (D2).
    expect(readHelperTail(path, {now: NOW})).toEqual({
      at: at('10:00'),
      inFlight: false,
      kind: 'found',
    });
    // A minute younger, and the open shell counts.
    expect(
      readHelperTail(path, {now: new Date(NOW.getTime() - 60_000)}),
    ).toEqual({at: at('10:00'), inFlight: true, kind: 'found'});
  });
});

describe('readActivity: helpers in flight, read with the last activity', () => {
  test('one running and one finished helper: one in flight; the newest record is the running one', () => {
    const main = file('session.jsonl', [
      {message: {content: 'go'}, timestamp: at('10:00'), type: 'user'},
    ]);
    const subagents = join(dir, 'session', 'subagents');
    mkdirSync(subagents, {recursive: true});
    writeFileSync(
      join(subagents, 'agent-run.jsonl'),
      `${[PROMPT, assistant('11:40', [toolUse('t1', 'Bash')])].map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    writeFileSync(
      join(subagents, 'agent-done.jsonl'),
      `${[PROMPT, assistant('11:01', [toolUse('t9', 'SubagentHandback')]), user('11:02', [toolResult('t9')])].map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const activity = readActivity(main);
    expect(activity.lastRecordAt).toEqual(measured(at('11:40')));
    expect(activity.helpers).toEqual(
      measured([
        {
          agentFile: join(subagents, 'agent-run.jsonl'),
          lastRecordAt: at('11:40'),
        },
      ]),
    );
  });
});

describe('deriveStatus step 2 with helpers (F10)', () => {
  /** An open request, Claude's own last record an hour old: ⚠️ open work. */
  const BASE: StatusFacts = {
    activityUnmeasured: [],
    beadProblems: [],
    commits: {count: 0, kind: 'counted'},
    contextTokens: 100_000,
    handedOff: false,
    helpersInFlight: [],
    lastMessageRole: 'assistant',
    lastRecordAt: at('11:00'),
    merged: measured('isDefault'),
    openP0: 0,
    requests: {closed: 0, total: 1},
    sessionCloseReason: null,
    successor: null,
    uncommitted: measured(0),
    wrapUpAt: 150_000,
  };
  const status = (over: Partial<StatusFacts>, asIfYielded = false) =>
    deriveStatus({...BASE, ...over}, {asIfYielded, now: NOW});

  test('no helper in flight: open work', () => {
    expect(status({}).kind).toBe('openWork');
  });

  test('a helper in flight, 10 minutes old (inside a long tool call): working, by helpers', () => {
    expect(status({helpersInFlight: [at('11:50')]})).toEqual({
      helpers: 1,
      kind: 'working',
      lastRecordAt: at('11:00'),
    });
  });

  test('"if you stop now" still counts the helpers (conductor decision)', () => {
    expect(status({helpersInFlight: [at('11:50')]}, true).kind).toBe('working');
  });

  test('unmeasured helpers, or an undated one, never claim working (rule 7)', () => {
    expect(status({helpersInFlight: null}).kind).not.toBe('working');
    expect(status({helpersInFlight: [null]}).kind).not.toBe('working');
  });

  test("Claude's own recent record without helpers: working, helpers 0", () => {
    expect(status({lastRecordAt: at('11:59')})).toEqual({
      helpers: 0,
      kind: 'working',
      lastRecordAt: at('11:59'),
    });
  });
});

describe('deriveStatus: the three bands of a helper in flight (home-base-yd1co.2 D2, D3)', () => {
  /** The same open-work base as above: ⚠️ open work with no helper. */
  const BASE: StatusFacts = {
    activityUnmeasured: [],
    beadProblems: [],
    commits: {count: 0, kind: 'counted'},
    contextTokens: 100_000,
    handedOff: false,
    helpersInFlight: [],
    lastMessageRole: 'assistant',
    lastRecordAt: at('11:00'),
    merged: measured('isDefault'),
    openP0: 0,
    requests: {closed: 0, total: 1},
    sessionCloseReason: null,
    successor: null,
    uncommitted: measured(0),
    wrapUpAt: 150_000,
  };
  const ago = (ms: number): string =>
    new Date(NOW.getTime() - ms).toISOString();
  const MINUTE = 60_000;
  const quiet = (ms: number) => ({
    kind: 'unknown',
    reasons: [quietHelperReason(ago(ms))],
  });

  const rows: [string, Partial<StatusFacts>, boolean, unknown][] = [
    [
      'under 15 minutes (14:59): working',
      {helpersInFlight: [ago(HELPER_WINDOW_MS - 1000)]},
      false,
      {helpers: 1, kind: 'working', lastRecordAt: at('11:00')},
    ],
    [
      'exactly 15 minutes: unknown, naming when it last wrote',
      {helpersInFlight: [ago(HELPER_WINDOW_MS)]},
      false,
      quiet(HELPER_WINDOW_MS),
    ],
    [
      'an hour: unknown',
      {helpersInFlight: [ago(60 * MINUTE)]},
      false,
      quiet(60 * MINUTE),
    ],
    [
      'a second under 2 hours: unknown',
      {helpersInFlight: [ago(HELPER_QUIET_LIMIT_MS - 1000)]},
      false,
      quiet(HELPER_QUIET_LIMIT_MS - 1000),
    ],
    [
      'exactly 2 hours: no longer evidence, the verdict it would otherwise get',
      {helpersInFlight: [ago(HELPER_QUIET_LIMIT_MS)]},
      false,
      {kind: 'openWork'},
    ],
    [
      'three hours: the verdict it would otherwise get',
      {helpersInFlight: [ago(3 * 60 * MINUTE)]},
      false,
      {kind: 'openWork'},
    ],
    [
      '"if you stop now" reads the band too',
      {helpersInFlight: [ago(60 * MINUTE)]},
      true,
      quiet(60 * MINUTE),
    ],
    [
      'one helper working and one quiet: working wins',
      {helpersInFlight: [ago(60 * MINUTE), ago(5 * MINUTE)]},
      false,
      {helpers: 1, kind: 'working', lastRecordAt: at('11:00')},
    ],
    [
      "Justin's mark over the unknown band",
      {
        helpersInFlight: [ago(60 * MINUTE)],
        sessionCloseReason: `${DONE_PREFIX} 2030-01-01`,
      },
      false,
      {by: 'justin', kind: 'done', reason: `${DONE_PREFIX} 2030-01-01`},
    ],
    [
      'handed off over the unknown band',
      {handedOff: true, helpersInFlight: [ago(60 * MINUTE)]},
      false,
      {kind: 'handedOff', successor: null},
    ],
    // home-base-o5atv.3 O1: out of context replaces only open work, so a
    // quiet helper's unknown wins over it (it was the other way round).
    [
      'the unknown band over out of context (O1)',
      {contextTokens: 160_000, helpersInFlight: [ago(60 * MINUTE)]},
      false,
      quiet(60 * MINUTE),
    ],
    [
      'every request closed, merged and clean, a helper quiet: unknown, not Done',
      {helpersInFlight: [ago(60 * MINUTE)], requests: {closed: 1, total: 1}},
      false,
      quiet(60 * MINUTE),
    ],
    [
      'an open P0 still comes first',
      {helpersInFlight: [ago(60 * MINUTE)], openP0: 1},
      false,
      {kind: 'waiting', openP0: 1},
    ],
  ];
  for (const [name, over, asIfYielded, expected] of rows) {
    test(name, () => {
      expect(deriveStatus({...BASE, ...over}, {asIfYielded, now: NOW})).toEqual(
        expected as ReturnType<typeof deriveStatus>,
      );
    });
  }

  test('the reason is the same text on every read: an absolute time, not an age', () => {
    const facts = {...BASE, helpersInFlight: [at('11:00')]};
    const first = deriveStatus(facts, {asIfYielded: false, now: NOW});
    const later = deriveStatus(facts, {
      asIfYielded: false,
      now: new Date(NOW.getTime() + 30 * MINUTE),
    });
    expect(later).toEqual(first);
    expect(first.kind === 'unknown' && first.reasons[0]).toContain(
      'a helper agent last wrote at ',
    );
  });
});

describe('deriveStatus D5 (home-base-yd1co.2): unreadable activity is said, never read as stopped', () => {
  const BASE: StatusFacts = {
    activityUnmeasured: [],
    beadProblems: [],
    commits: {count: 1, kind: 'counted'},
    contextTokens: 100_000,
    handedOff: false,
    helpersInFlight: [],
    lastMessageRole: 'assistant',
    lastRecordAt: at('09:00'),
    merged: measured('isDefault'),
    openP0: 0,
    requests: {closed: 0, total: 1},
    sessionCloseReason: null,
    successor: null,
    uncommitted: measured(0),
    wrapUpAt: 150_000,
  };
  const status = (over: Partial<StatusFacts>) =>
    deriveStatus({...BASE, ...over}, {asIfYielded: false, now: NOW});
  const GONE = 'no transcript s-1.jsonl under /projects';

  test('helpers and last record unmeasured with open work: unknown, naming the reason, marked activityUnread', () => {
    expect(
      status({
        activityUnmeasured: [GONE],
        helpersInFlight: null,
        lastRecordAt: null,
      }),
    ).toEqual({activityUnread: true, kind: 'unknown', reasons: [GONE]});
  });

  test('only the last record unmeasured: unknown', () => {
    expect(
      status({
        activityUnmeasured: ['no user or assistant record carries a timestamp'],
        lastRecordAt: null,
      }),
    ).toEqual({
      activityUnread: true,
      kind: 'unknown',
      reasons: ['no user or assistant record carries a timestamp'],
    });
  });

  test('a helper in flight with no time on its records: unknown', () => {
    expect(status({helpersInFlight: [null]})).toEqual({
      activityUnread: true,
      kind: 'unknown',
      reasons: ['a helper agent in flight has no readable time on its records'],
    });
  });

  test('unmeasured helpers with no reason given still say so', () => {
    expect(status({helpersInFlight: null})).toEqual({
      activityUnread: true,
      kind: 'unknown',
      reasons: ['the helper agents could not be measured'],
    });
  });

  test('a closed, merged, clean session keeps Done; an answered one keeps Answered', () => {
    const unread = {
      activityUnmeasured: [GONE],
      helpersInFlight: null,
      lastRecordAt: null,
    };
    expect(status({...unread, requests: {closed: 1, total: 1}})).toEqual({
      by: 'requests',
      kind: 'done',
      reason: null,
    });
    expect(
      status({
        ...unread,
        commits: {count: 0, kind: 'counted'},
        requests: {closed: 0, total: 0},
      }),
    ).toEqual({kind: 'answered'});
  });

  test('beside another unknown fact: one unknown naming both, NOT marked (it was ❔ before, and stays exempt)', () => {
    expect(
      status({
        activityUnmeasured: [GONE],
        commits: {kind: 'unmeasured', reason: 'git log failed'},
        helpersInFlight: null,
      }),
    ).toEqual({kind: 'unknown', reasons: ['git log failed', GONE]});
  });

  test("the inbox's age filter: hides the activityUnread unknown exactly as it hid open work", () => {
    const replaced = status({
      activityUnmeasured: [GONE],
      helpersInFlight: null,
    });
    const wouldHaveBeen = status({});
    expect(wouldHaveBeen).toEqual({kind: 'openWork'});
    expect(neverHiddenByAge(wouldHaveBeen)).toBe(false);
    expect(neverHiddenByAge(replaced)).toBe(false);
    // Every other ❔, 🛑 and ⏳ stay exempt.
    expect(
      neverHiddenByAge({kind: 'unknown', reasons: ['git log failed']}),
    ).toBe(true);
    expect(neverHiddenByAge({kind: 'waiting', openP0: 1})).toBe(true);
    expect(
      neverHiddenByAge({
        kind: 'unknown',
        reasons: [quietHelperReason(at('11:00'))],
      }),
    ).toBe(true);
  });
});

describe('untrackedVerdict with helpers (F10)', () => {
  const session = (over: Partial<UntrackedSession>): UntrackedSession => ({
    checkout: '/dev/alpha',
    contextTokens: measured(40_000),
    dirt: null,
    firstMessage: 'Build it',
    firstMessageAt: at('09:00'),
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      defaultBranch: measured('main'),
      localDefaultBehind: measured(null),
      merged: measured('isDefault'),
      uncommitted: measured([]),
      unpushed: unmeasured('not read'),
    },
    helpers: measured([]),
    lastActivityAt: measured(at('11:00')),
    lastMessage: null,
    lastReply: 'Dispatched a player.',
    messagesFrom: 'messageLog',
    oldReport: measured(null),
    repo: 'alpha',
    repoResolvedBy: 'git',
    repoRoot: '/dev/alpha',
    repoTag: 'ALPHA',
    resume: 'claude --resume s-1',
    scannedLastAt: at('11:00'),
    sessionId: 's-1',
    testDataMarker: false,
    transcriptPath: '/projects/-dev-alpha/s-1.jsonl',
    wrapUpAt: 150_000,
    ...over,
  });

  test('a helper in flight: a working card with the helper wording', () => {
    const verdict = untrackedVerdict(
      session({
        helpers: measured([
          {agentFile: '/x/agent-a.jsonl', lastRecordAt: at('11:50')},
        ]),
      }),
      NOW,
    );
    expect(verdict.evidence).toContain('working');
    expect(verdict.display).toBe('card');
    expect(verdict.action.text).toBe(
      "Nothing yet. Claude's helper agents are still working.",
    );
  });

  test('no helper in flight: one line, no request recorded', () => {
    const verdict = untrackedVerdict(session({}), NOW);
    expect(verdict.evidence).toEqual([]);
    expect(verdict.display).toBe('line');
  });

  test('a helper quiet for an hour (home-base-yd1co.2 D6): Check it by hand, naming when it last wrote, not stopped', () => {
    const verdict = untrackedVerdict(
      session({
        helpers: measured([
          {agentFile: '/x/agent-a.jsonl', lastRecordAt: at('11:00')},
        ]),
      }),
      NOW,
    );
    expect(verdict.evidence).toEqual([]);
    expect(verdict.display).toBe('card');
    expect(verdict.unmeasured).toEqual([quietHelperReason(at('11:00'))]);
    expect(verdict.action).toEqual({
      command: 'claude --resume s-1',
      rule: 10,
      text: `Check it by hand: ${quietHelperReason(at('11:00'))}`,
    });
  });

  test('a helper last heard from 2 hours ago or more: the verdict it would otherwise get', () => {
    const verdict = untrackedVerdict(
      session({
        helpers: measured([
          {agentFile: '/x/agent-a.jsonl', lastRecordAt: at('10:00')},
        ]),
      }),
      NOW,
    );
    expect(verdict.display).toBe('line');
    expect(verdict.unmeasured).toEqual([]);
  });
});
