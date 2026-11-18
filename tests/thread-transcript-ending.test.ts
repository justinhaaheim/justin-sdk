/**
 * home-base-kwand.4 (G12, D5): how a main transcript ends, on synthetic
 * transcripts, and with liveness beside it. Each rule's negative control is
 * recorded in the bead's notes.
 */

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  cachedTranscriptEnding,
  resetTranscriptCacheMemory,
  TRANSCRIPT_CACHE_KNOB,
} from '../src/thread/transcript-cache';
import {
  endingFoldOfBytes,
  endingLine,
  endingOfFold,
  readTranscriptEnding,
  sessionEnding,
  type TranscriptEnding,
  WORKING_NOW_WINDOW_MS,
} from '../src/thread/transcript-ending';

let dir = '';
let saved: {cache: string | undefined; xdg: string | undefined};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-ending-'));
  saved = {
    cache: process.env[TRANSCRIPT_CACHE_KNOB],
    xdg: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_CACHE_HOME = join(dir, 'cache');
  delete process.env[TRANSCRIPT_CACHE_KNOB];
});

afterAll(() => {
  if (saved.xdg == null) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = saved.xdg;
  if (saved.cache == null) delete process.env[TRANSCRIPT_CACHE_KNOB];
  else process.env[TRANSCRIPT_CACHE_KNOB] = saved.cache;
  rmSync(dir, {force: true, recursive: true});
});

// ── Records, as Claude Code writes them (only the fields the walk reads) ──

let clock = Date.parse('2026-11-17T20:00:00.000Z');
function at(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

const r = {
  attachment: (type = 'hook_success') => ({
    attachment: {type},
    timestamp: at(),
    type: 'attachment',
  }),
  awaySummary: () => ({
    subtype: 'away_summary',
    timestamp: at(),
    type: 'system',
  }),
  bareCommand: () => ({
    message: {
      content:
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      role: 'user',
    },
    timestamp: at(),
    type: 'user',
  }),
  interrupt: () => ({
    message: {
      content: [
        {text: '[Request interrupted by user for tool use]', type: 'text'},
      ],
      role: 'user',
    },
    timestamp: at(),
    type: 'user',
  }),
  interruptedResult: (id = 't1') => ({
    message: {
      content: [
        {
          content: '[Request interrupted by user for tool use]',
          is_error: true,
          tool_use_id: id,
          type: 'tool_result',
        },
      ],
      role: 'user',
    },
    timestamp: at(),
    toolUseResult: 'Error: [Request interrupted by user for tool use]',
    type: 'user',
  }),
  lastPrompt: () => ({lastPrompt: 'x', type: 'last-prompt'}),
  meta: () => ({
    isMeta: true,
    message: {content: 'Base directory for this skill: …', role: 'user'},
    timestamp: at(),
    type: 'user',
  }),
  notification: () => ({
    message: {
      content:
        '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>',
      role: 'user',
    },
    timestamp: at(),
    type: 'user',
  }),
  prompt: (text = 'please do the thing') => ({
    message: {content: text, role: 'user'},
    timestamp: at(),
    type: 'user',
  }),
  queue: () => ({
    operation: 'enqueue',
    timestamp: at(),
    type: 'queue-operation',
  }),
  reply: (stopReason: string | null = 'end_turn') => ({
    message: {
      content: [{text: 'All done.', type: 'text'}],
      role: 'assistant',
      stop_reason: stopReason,
    },
    timestamp: at(),
    type: 'assistant',
  }),
  result: (id = 't1') => ({
    message: {
      content: [{content: 'ok', tool_use_id: id, type: 'tool_result'}],
      role: 'user',
    },
    timestamp: at(),
    toolUseResult: {stdout: 'ok'},
    type: 'user',
  }),
  sidechainCall: () => ({
    isSidechain: true,
    message: {content: [{id: 's1', input: {}, name: 'Bash', type: 'tool_use'}]},
    timestamp: at(),
    type: 'assistant',
  }),
  stopSummary: () => ({
    subtype: 'stop_hook_summary',
    timestamp: at(),
    type: 'system',
  }),
  thinking: () => ({
    message: {content: [{thinking: '…', type: 'thinking'}], role: 'assistant'},
    timestamp: at(),
    type: 'assistant',
  }),
  toolCall: (id = 't1') => ({
    message: {
      content: [{id, input: {command: 'ls'}, name: 'Bash', type: 'tool_use'}],
      role: 'assistant',
      stop_reason: 'tool_use',
    },
    timestamp: at(),
    type: 'assistant',
  }),
  turnDuration: () => ({
    durationMs: 1000,
    subtype: 'turn_duration',
    timestamp: at(),
    type: 'system',
  }),
};

function jsonl(records: object[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function endingOf(records: object[]): TranscriptEnding {
  return endingOfFold(endingFoldOfBytes(Buffer.from(jsonl(records))));
}

let fileCount = 0;
function writeTranscript(records: object[]): string {
  fileCount += 1;
  const path = join(dir, `session-${fileCount}.jsonl`);
  writeFileSync(path, jsonl(records));
  return path;
}

/** A finished first turn, so a file has stop marks. */
function finishedTurn(): object[] {
  return [
    r.prompt('first'),
    r.toolCall('t0'),
    r.result('t0'),
    r.reply(),
    r.stopSummary(),
    r.turnDuration(),
  ];
}

// ── The walk ─────────────────────────────────────────────────────────────

describe('how a transcript ends', () => {
  test('a tool call with no result is cut off', () => {
    const call = r.toolCall('t1');
    const ending = endingOf([...finishedTurn(), r.prompt(), call]);
    expect(ending).toEqual({
      at: call.timestamp,
      inFlight: 'toolCall',
      kind: 'cutOff',
    });
  });

  test('a tool result with no reply after it is cut off', () => {
    const result = r.result('t1');
    const ending = endingOf([
      ...finishedTurn(),
      r.prompt(),
      r.toolCall('t1'),
      result,
    ]);
    expect(ending).toEqual({
      at: result.timestamp,
      inFlight: 'toolResult',
      kind: 'cutOff',
    });
  });

  test('a prompt with no reply is cut off', () => {
    const prompt = r.prompt('one more thing');
    const ending = endingOf([...finishedTurn(), prompt]);
    expect(ending).toEqual({
      at: prompt.timestamp,
      inFlight: 'prompt',
      kind: 'cutOff',
    });
  });

  test('"[Request interrupted by user]" is cut off, as a tool result or as text', () => {
    const asResult = r.interruptedResult('t1');
    expect(
      endingOf([...finishedTurn(), r.prompt(), r.toolCall('t1'), asResult]),
    ).toEqual({at: asResult.timestamp, inFlight: 'interrupt', kind: 'cutOff'});
    const asText = r.interrupt();
    expect(
      endingOf([
        ...finishedTurn(),
        r.prompt(),
        r.toolCall('t1'),
        r.interruptedResult('t1'),
        asText,
      ]),
    ).toEqual({at: asText.timestamp, inFlight: 'interrupt', kind: 'cutOff'});
  });

  test('a task notification with no reply is cut off (it wakes an idle session)', () => {
    const notification = r.notification();
    const ending = endingOf([...finishedTurn(), notification]);
    expect(ending).toEqual({
      at: notification.timestamp,
      inFlight: 'notification',
      kind: 'cutOff',
    });
  });

  test('a turn ended by turn_duration only is replied', () => {
    const mark = r.turnDuration();
    expect(endingOf([r.prompt(), r.reply(), mark])).toEqual({
      at: mark.timestamp,
      kind: 'replied',
    });
  });

  test('a turn ended by stop_hook_summary only is replied', () => {
    const mark = r.stopSummary();
    expect(endingOf([r.prompt(), r.reply(), mark])).toEqual({
      at: mark.timestamp,
      kind: 'replied',
    });
  });

  test('a turn ended by both marks is replied, at the later one', () => {
    const summary = r.stopSummary();
    const duration = r.turnDuration();
    expect(endingOf([r.prompt(), r.reply(), summary, duration])).toEqual({
      at: duration.timestamp,
      kind: 'replied',
    });
  });

  test("a resume's trailing records do not change either verdict", () => {
    const noise = [
      r.attachment('hook_success'),
      r.attachment('hook_system_message'),
      r.queue(),
      r.lastPrompt(),
      r.awaySummary(),
      {subtype: 'bridge_status', timestamp: at(), type: 'system'},
      r.meta(),
      r.bareCommand(),
      r.sidechainCall(),
      {type: 'cost-state'},
      'not json at all',
    ];
    const replied = [r.prompt(), r.reply(), r.turnDuration()];
    const cut = [...finishedTurn(), r.prompt(), r.toolCall('t1')];
    const lines = (records: (object | string)[]): string =>
      records
        .map((record) =>
          typeof record === 'string' ? record : JSON.stringify(record),
        )
        .join('\n');
    const of = (records: (object | string)[]): TranscriptEnding =>
      endingOfFold(endingFoldOfBytes(Buffer.from(lines(records))));
    expect(of([...replied, ...noise])).toEqual(of(replied));
    expect(of([...replied, ...noise]).kind).toBe('replied');
    expect(of([...cut, ...noise])).toEqual(of(cut));
    expect(of([...cut, ...noise]).kind).toBe('cutOff');
  });

  test('an assistant reply with no stop mark after it, in a file with marks, is cut off', () => {
    const reply = r.reply();
    expect(endingOf([...finishedTurn(), r.prompt(), reply])).toEqual({
      at: reply.timestamp,
      inFlight: 'reply',
      kind: 'cutOff',
    });
    const thinking = r.thinking();
    expect(endingOf([...finishedTurn(), r.prompt(), thinking])).toEqual({
      at: thinking.timestamp,
      inFlight: 'thinking',
      kind: 'cutOff',
    });
  });

  describe('a file with neither stop mark (claude -p, very old sessions)', () => {
    test('a last reply that ended the turn is replied', () => {
      const reply = r.reply('end_turn');
      expect(endingOf([r.prompt(), r.toolCall(), r.result(), reply])).toEqual({
        at: reply.timestamp,
        kind: 'replied',
      });
    });

    test('a last reply that does not say so is unknown, with the reason', () => {
      const ending = endingOf([r.prompt(), r.reply(null)]);
      expect(ending.kind).toBe('unknown');
      expect(ending.kind === 'unknown' && ending.reason).toContain(
        'no end-of-turn marks',
      );
    });

    test('a tool call at its end is still cut off', () => {
      const call = r.toolCall();
      expect(endingOf([r.prompt(), call])).toEqual({
        at: call.timestamp,
        inFlight: 'toolCall',
        kind: 'cutOff',
      });
    });
  });

  test('no conversation record is unknown', () => {
    const ending = endingOf([r.bareCommand(), r.attachment(), r.lastPrompt()]);
    expect(ending).toEqual({
      kind: 'unknown',
      reason: 'the transcript holds no conversation record',
    });
  });

  test('a missing file is unknown, naming it', () => {
    const missing = join(dir, 'no-such-session.jsonl');
    const ending = readTranscriptEnding(missing);
    expect(ending.kind).toBe('unknown');
    expect(ending.kind === 'unknown' && ending.reason).toContain(
      `could not open ${missing}`,
    );
  });
});

// ── The cache keeps the walk and folds a grown file ──────────────────────

describe('the transcript cache', () => {
  test('gives what a full read gives, before and after the file grows', () => {
    resetTranscriptCacheMemory();
    const path = writeTranscript([...finishedTurn()]);
    expect(cachedTranscriptEnding(path)).toEqual(readTranscriptEnding(path));
    expect(cachedTranscriptEnding(path)?.kind).toBe('replied');
    // Grows into a cut-off turn: folded from the new lines (same answer as a full read).
    appendFileSync(path, jsonl([r.prompt(), r.toolCall('t9')]));
    const folded = cachedTranscriptEnding(path);
    expect(folded).toEqual(readTranscriptEnding(path));
    expect(folded?.kind).toBe('cutOff');
    // Then a resume appends attachments only: still cut off.
    appendFileSync(path, jsonl([r.attachment(), r.queue()]));
    expect(cachedTranscriptEnding(path)).toEqual(folded);
    // And the turn finishes.
    appendFileSync(path, jsonl([r.result('t9'), r.reply(), r.turnDuration()]));
    expect(cachedTranscriptEnding(path)?.kind).toBe('replied');
    expect(cachedTranscriptEnding(path)).toEqual(readTranscriptEnding(path));
  });

  test('says nothing when it is off (the caller reads the file)', () => {
    const path = writeTranscript([...finishedTurn()]);
    process.env[TRANSCRIPT_CACHE_KNOB] = 'off';
    try {
      expect(cachedTranscriptEnding(path)).toBeNull();
    } finally {
      delete process.env[TRANSCRIPT_CACHE_KNOB];
    }
  });
});

// ── Liveness is a separate fact (D5) ─────────────────────────────────────

describe('with liveness', () => {
  const now = new Date('2026-11-18T03:00:00.000Z');
  const cut: TranscriptEnding = {
    at: '2026-11-18T02:39:32.000Z',
    inFlight: 'notification',
    kind: 'cutOff',
  };
  const minutesAgo = (minutes: number): string =>
    new Date(now.getTime() - minutes * 60_000).toISOString();

  test('a live session with a recent record is working now', () => {
    const recent = minutesAgo(2);
    expect(sessionEnding(cut, {lastRecordAt: recent, live: true, now})).toEqual(
      {
        at: cut.at,
        inFlight: 'notification',
        kind: 'workingNow',
        lastRecordAt: recent,
      },
    );
  });

  test('a live session idle after a cut-off is still cut off, and says it runs', () => {
    const idle = minutesAgo(WORKING_NOW_WINDOW_MS / 60_000 + 1);
    const ending = sessionEnding(cut, {lastRecordAt: idle, live: true, now});
    expect(ending).toEqual({...cut, live: true});
    expect(endingLine(ending, now)).toContain('cut off mid-turn');
    expect(endingLine(ending, now)).toContain('runs again');
  });

  test('a recent record with no live process is cut off', () => {
    expect(
      sessionEnding(cut, {lastRecordAt: minutesAgo(1), live: false, now}),
    ).toEqual({...cut, live: false});
  });

  test('a recent record whose liveness could not be checked is unknown, never a verdict', () => {
    const ending = sessionEnding(cut, {
      lastRecordAt: minutesAgo(1),
      live: null,
      now,
    });
    expect(ending.kind).toBe('unknown');
  });

  test('replied and unknown pass through whatever runs', () => {
    const replied: TranscriptEnding = {at: minutesAgo(1), kind: 'replied'};
    expect(
      sessionEnding(replied, {lastRecordAt: minutesAgo(1), live: true, now}),
    ).toEqual(replied);
  });

  test("the card's line names the time and what was in flight", () => {
    const line = endingLine({...cut, live: false}, now);
    expect(line).toMatch(
      /^✂️ cut off mid-turn at \S+: a background task's notification had no reply$/,
    );
  });
});
