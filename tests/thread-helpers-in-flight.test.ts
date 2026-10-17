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
import {mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {measured, readActivity, unmeasured} from '../src/thread/session-model';
import {deriveStatus, HELPER_WINDOW_MS} from '../src/thread/session-status';
import {untrackedVerdict} from '../src/thread/session-untracked';
import {readHelperTail} from '../src/thread/transcript-messages';

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

  test('a helper older than the 15-minute window (killed): not working', () => {
    const old = new Date(NOW.getTime() - HELPER_WINDOW_MS - 1000).toISOString();
    expect(status({helpersInFlight: [old]}).kind).toBe('openWork');
  });

  test('unmeasured helpers, or an undated one, never claim working (rule 7)', () => {
    expect(status({helpersInFlight: null}).kind).toBe('openWork');
    expect(status({helpersInFlight: [null]}).kind).toBe('openWork');
  });

  test("Claude's own recent record without helpers: working, helpers 0", () => {
    expect(status({lastRecordAt: at('11:59')})).toEqual({
      helpers: 0,
      kind: 'working',
      lastRecordAt: at('11:59'),
    });
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
});
