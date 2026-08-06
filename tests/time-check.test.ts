/**
 * Tests for time-check — the UserPromptSubmit hook that gives a transcript a
 * wall-clock.
 *
 * The bulk of this file guards two classes of bug that would each fail
 * silently in production:
 *
 *  1. FALSY-ZERO. `notifyOnNewDayBoundaryHour: 0` is the SHIPPED DEFAULT and is
 *     falsy in JS, as is `gapHours: 0`. Any `if (config.x)` check would
 *     disable the default configuration while looking correct.
 *  2. TRANSCRIPT SHAPE. Real transcripts interleave entries that carry no
 *     timestamp (`mode`, `ai-title`, `last-prompt`) with non-message entries
 *     that DO (`attachment`, `system`). Both "read the last line" and "read the
 *     last line with a timestamp" therefore give wrong answers. The fixtures
 *     below reproduce that layout rather than an idealised one.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  decide,
  formatGap,
  formatLocalIso,
  formatReport,
  readTimeCheckConfig,
  resolveConfig,
  scanTranscript,
  TIME_CHECK_DEFAULTS,
  TIME_CHECK_MARKER,
  runTimeCheck,
  workingDayKey,
} from '../src/time-check';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'time-check-'));
}

function writeConfig(dir: string, config: unknown): void {
  writeFileSync(
    join(dir, 'justin-sdk.config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------------------

describe('config: absence means disabled', () => {
  test('no justin-sdk.config.json at all', () => {
    expect(readTimeCheckConfig(tempDir())).toBeNull();
  });

  test('config with no componentConfig section', () => {
    const dir = tempDir();
    writeConfig(dir, {components: ['base-setup'], version: '0.12.1'});
    expect(readTimeCheckConfig(dir)).toBeNull();
  });

  test('componentConfig without a time-check key', () => {
    const dir = tempDir();
    writeConfig(dir, {componentConfig: {beads: {}}, version: '0.12.1'});
    expect(readTimeCheckConfig(dir)).toBeNull();
  });

  test('malformed JSON does not throw — a broken config must not cost a turn', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'justin-sdk.config.json'), '{not json', 'utf8');
    expect(readTimeCheckConfig(dir)).toBeNull();
  });

  test('resolveConfig(null) is disabled', () => {
    expect(resolveConfig(null)).toBeNull();
  });

  test('enabled:false is disabled even with other keys set', () => {
    expect(resolveConfig({enabled: false, gapHours: 4})).toBeNull();
  });
});

describe('config: falsy-zero must survive', () => {
  test('notifyOnNewDayBoundaryHour: 0 is kept, not treated as absent', () => {
    const resolved = resolveConfig({notifyOnNewDayBoundaryHour: 0});
    expect(resolved?.notifyOnNewDayBoundaryHour).toBe(0);
  });

  test('gapHours: 0 is kept, not replaced by the default', () => {
    const resolved = resolveConfig({gapHours: 0});
    expect(resolved?.gapHours).toBe(0);
  });

  test('the shipped defaults round-trip through resolveConfig unchanged', () => {
    const resolved = resolveConfig({...TIME_CHECK_DEFAULTS});
    expect(resolved).toEqual(TIME_CHECK_DEFAULTS);
  });

  test('explicit null disables a trigger (distinct from 0 and from absent)', () => {
    const resolved = resolveConfig({
      gapHours: null,
      notifyOnNewDayBoundaryHour: null,
    });
    expect(resolved?.gapHours).toBeNull();
    expect(resolved?.notifyOnNewDayBoundaryHour).toBeNull();
  });

  test('omitted keys fall back to defaults', () => {
    const resolved = resolveConfig({enabled: true});
    expect(resolved?.gapHours).toBe(TIME_CHECK_DEFAULTS.gapHours);
    expect(resolved?.notifyOnNewDayBoundaryHour).toBe(
      TIME_CHECK_DEFAULTS.notifyOnNewDayBoundaryHour,
    );
  });

  test('a config file carrying boundary 0 survives the read+resolve path', () => {
    const dir = tempDir();
    writeConfig(dir, {
      componentConfig: {
        'time-check': {enabled: true, notifyOnNewDayBoundaryHour: 0},
      },
    });
    expect(
      resolveConfig(readTimeCheckConfig(dir))?.notifyOnNewDayBoundaryHour,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('workingDayKey', () => {
  test('boundary 0 is the plain calendar date', () => {
    expect(workingDayKey(new Date(2026, 7, 6, 0, 30), 0)).toBe('2026-08-06');
    expect(workingDayKey(new Date(2026, 7, 5, 23, 30), 0)).toBe('2026-08-05');
  });

  test('boundary 5: a 2am message still belongs to the previous working day', () => {
    // The reason this exists: Justin works past midnight, so a calendar-day
    // boundary would fire mid-session.
    expect(workingDayKey(new Date(2026, 7, 6, 2, 0), 5)).toBe('2026-08-05');
    expect(workingDayKey(new Date(2026, 7, 5, 23, 0), 5)).toBe('2026-08-05');
  });

  test('boundary 5: after 5am it is the new working day', () => {
    expect(workingDayKey(new Date(2026, 7, 6, 5, 1), 5)).toBe('2026-08-06');
  });
});

// ---------------------------------------------------------------------------

const CFG = {
  enabled: true,
  gapHours: 8,
  notifyOnNewDayBoundaryHour: 0,
};

describe('decide', () => {
  test('silent on the first prompt (no prior message to measure from)', () => {
    const now = new Date(2026, 7, 6, 12, 0);
    expect(
      decide({config: CFG, lastCheck: null, lastMessage: null, now}),
    ).toBeNull();
  });

  test('fires on gap when the threshold is met', () => {
    const now = new Date(2026, 7, 6, 12, 0);
    const lastMessage = new Date(2026, 7, 6, 3, 0); // 9h earlier
    expect(decide({config: CFG, lastCheck: now, lastMessage, now})).toBe('gap');
  });

  test('silent when the gap is under threshold and the day has not changed', () => {
    const now = new Date(2026, 7, 6, 12, 0);
    const lastMessage = new Date(2026, 7, 6, 11, 0); // 1h
    const lastCheck = new Date(2026, 7, 6, 9, 0); // same day
    expect(decide({config: CFG, lastCheck, lastMessage, now})).toBeNull();
  });

  test('fires on a new day even when messages are steady — the drip case', () => {
    // The hole a bare gap threshold leaves: messages every few hours, forever,
    // never exceeding gapHours, so a pure gap rule prints nothing for weeks.
    const now = new Date(2026, 7, 6, 1, 0);
    const lastMessage = new Date(2026, 7, 5, 22, 0); // only 3h
    const lastCheck = new Date(2026, 7, 5, 22, 0); // previous calendar day
    expect(decide({config: CFG, lastCheck, lastMessage, now})).toBe('new-day');
  });

  test('new-day respects the boundary hour: 1am with boundary 5 does NOT fire', () => {
    const config = {...CFG, notifyOnNewDayBoundaryHour: 5};
    const now = new Date(2026, 7, 6, 1, 0);
    const lastMessage = new Date(2026, 7, 5, 22, 0);
    expect(
      decide({config, lastCheck: lastMessage, lastMessage, now}),
    ).toBeNull();
  });

  test('gapHours: null disables the gap trigger entirely', () => {
    const config = {...CFG, gapHours: null};
    const now = new Date(2026, 7, 6, 12, 0);
    const lastMessage = new Date(2026, 7, 6, 0, 30); // 11.5h, same day
    expect(
      decide({
        config,
        lastCheck: new Date(2026, 7, 6, 0, 30),
        lastMessage,
        now,
      }),
    ).toBeNull();
  });

  test('notifyOnNewDayBoundaryHour: null disables the daily trigger', () => {
    const config = {...CFG, notifyOnNewDayBoundaryHour: null};
    const now = new Date(2026, 7, 6, 1, 0);
    const lastMessage = new Date(2026, 7, 5, 23, 0); // 2h, but a new day
    expect(
      decide({config, lastCheck: lastMessage, lastMessage, now}),
    ).toBeNull();
  });

  test('with no prior check, the daily trigger baselines off the last message', () => {
    // A session that simply runs past the boundary still gets its stamp.
    const now = new Date(2026, 7, 6, 1, 0);
    const lastMessage = new Date(2026, 7, 5, 23, 0);
    expect(decide({config: CFG, lastCheck: null, lastMessage, now})).toBe(
      'new-day',
    );
  });
});

// ---------------------------------------------------------------------------

describe('formatting', () => {
  test('formatGap drops empty leading units', () => {
    expect(formatGap(32 * 60_000)).toBe('32m');
    expect(formatGap((4 * 60 + 32) * 60_000)).toBe('4h 32m');
    expect(formatGap(((3 * 24 + 4) * 60 + 32) * 60_000)).toBe('3d 4h 32m');
  });

  test('formatGap keeps a zero hour once days are present', () => {
    expect(formatGap((3 * 24 * 60 + 5) * 60_000)).toBe('3d 0h 5m');
  });

  test('formatGap clamps negatives rather than emitting nonsense', () => {
    expect(formatGap(-5000)).toBe('0m');
  });

  test('formatLocalIso emits an offset, not a Z', () => {
    const iso = formatLocalIso(new Date(2026, 7, 6, 0, 25, 33));
    expect(iso).toMatch(/^2026-08-06T00:25:33[+-]\d{2}:\d{2}$/);
  });

  test('formatReport matches the agreed three-line shape', () => {
    const now = new Date(2026, 7, 6, 0, 25, 33);
    const lastMessage = new Date(now.getTime() - 9 * 3_600_000);
    const lines = formatReport(now, lastMessage).split('\n');
    expect(lines[0]).toBe(TIME_CHECK_MARKER);
    expect(lines[1]).toMatch(/^Current: Thursday 2026-08-06T00:25:33/);
    expect(lines[2]).toBe('Time since last message: 9h 0m');
  });
});

// ---------------------------------------------------------------------------

describe('emit: both channels', () => {
  /**
   * The stamp has to reach TWO readers that do not overlap: `systemMessage`
   * renders in Justin's terminal but never enters the model's context, while
   * `additionalContext` reaches the model and is invisible to Justin. Emitting
   * only one is the bug this guards — the original version printed plain stdout,
   * so the model got the stamp and Justin saw nothing.
   */
  function captureRun(dir: string, transcript: string): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      runTimeCheck({
        stdin: JSON.stringify({cwd: dir, transcript_path: transcript}),
      });
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  }

  test('emits systemMessage AND additionalContext, with identical text', () => {
    const dir = tempDir();
    writeConfig(dir, {
      componentConfig: {
        'time-check': {enabled: true, gapHours: 0},
      },
    });
    const transcript = join(dir, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: '2026-08-05T10:00:00.000Z',
        type: 'assistant',
      }),
      'utf8',
    );

    const parsed = JSON.parse(captureRun(dir, transcript)) as {
      hookSpecificOutput?: {additionalContext?: string; hookEventName?: string};
      systemMessage?: string;
    };
    expect(parsed.systemMessage).toContain(TIME_CHECK_MARKER);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput?.additionalContext).toBe(
      parsed.systemMessage,
    );
  });

  test('stays completely silent when not due (no empty envelope)', () => {
    const dir = tempDir();
    writeConfig(dir, {
      componentConfig: {
        'time-check': {
          enabled: true,
          gapHours: 999,
          notifyOnNewDayBoundaryHour: null,
        },
      },
    });
    const transcript = join(dir, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({timestamp: new Date().toISOString(), type: 'assistant'}),
      'utf8',
    );
    expect(captureRun(dir, transcript)).toBe('');
  });
});

describe('scanTranscript', () => {
  /** Mirrors the real file layout, including entries that break naive scans. */
  function writeTranscript(dir: string, entries: unknown[]): string {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      entries.map((e) => JSON.stringify(e)).join('\n'),
      'utf8',
    );
    return path;
  }

  test('missing file degrades to nulls instead of throwing', () => {
    expect(scanTranscript(join(tempDir(), 'nope.jsonl'))).toEqual({
      lastCheck: null,
      lastMessage: null,
    });
  });

  test('finds the last assistant message and ignores trailing metadata', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      {timestamp: '2026-08-06T00:00:00.000Z', type: 'assistant'},
      {timestamp: '2026-08-06T01:00:00.000Z', type: 'assistant'},
      // These carry NO timestamp and sit at the tail in real transcripts.
      {type: 'last-prompt'},
      {type: 'ai-title'},
      {type: 'mode'},
    ]);
    const facts = scanTranscript(path);
    expect(facts.lastMessage?.toISOString()).toBe('2026-08-06T01:00:00.000Z');
  });

  test('a timestamped NON-message entry is not mistaken for a message', () => {
    // `system` and `attachment` both carry timestamps, so "last entry with a
    // timestamp" is the wrong rule.
    const dir = tempDir();
    const path = writeTranscript(dir, [
      {timestamp: '2026-08-06T01:00:00.000Z', type: 'assistant'},
      {timestamp: '2026-08-06T02:00:00.000Z', type: 'system'},
      {timestamp: '2026-08-06T03:00:00.000Z', type: 'file-history-delta'},
    ]);
    expect(scanTranscript(path).lastMessage?.toISOString()).toBe(
      '2026-08-06T01:00:00.000Z',
    );
  });

  test('finds our own prior time-check attachment', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      {
        attachment: {
          content: `${TIME_CHECK_MARKER}\nCurrent: ...`,
          hookEvent: 'UserPromptSubmit',
          type: 'hook_success',
        },
        timestamp: '2026-08-05T09:00:00.000Z',
        type: 'attachment',
      },
      {timestamp: '2026-08-06T01:00:00.000Z', type: 'assistant'},
    ]);
    const facts = scanTranscript(path);
    expect(facts.lastCheck?.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    expect(facts.lastMessage?.toISOString()).toBe('2026-08-06T01:00:00.000Z');
  });

  test("another hook's output is not mistaken for ours", () => {
    // Justin's timestamp-hook.sh also fires on UserPromptSubmit.
    const dir = tempDir();
    const path = writeTranscript(dir, [
      {
        attachment: {
          content: '[38;5;245m 2026-08-06 1:21:59am[0m',
          hookEvent: 'UserPromptSubmit',
          type: 'hook_success',
        },
        timestamp: '2026-08-06T08:21:59.000Z',
        type: 'attachment',
      },
      {timestamp: '2026-08-06T08:22:00.000Z', type: 'assistant'},
    ]);
    expect(scanTranscript(path).lastCheck).toBeNull();
  });

  test('a truncated trailing line (live file) is skipped, not fatal', () => {
    const dir = tempDir();
    const path = join(dir, 'partial.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({timestamp: '2026-08-06T01:00:00.000Z', type: 'assistant'})}\n{"type":"assist`,
      'utf8',
    );
    expect(scanTranscript(path).lastMessage?.toISOString()).toBe(
      '2026-08-06T01:00:00.000Z',
    );
  });
});
