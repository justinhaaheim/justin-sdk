/**
 * The quota's week reader (request home-base-ys9t7.5 D4, D11; reader built by
 * home-base-ys9t7.5.2, moved onto the statusline store's live.json by
 * home-base-ys9t7.5.3).
 *
 * The all-models week is the newer of live.json's seven-day window and the
 * newest /usage sample; the per-model weeks come from the sample only; older
 * than maxAgeMinutes is unknown. Every path points at the sandbox through
 * CLAUDE_USAGE_DATA_DIR and CLAUDE_USAGE_STATE_DIR, and live.json is written
 * with the store's own `writeLive`, so the test uses the store's real format.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {type LiveWindow, storePaths, writeLive} from '../src/claude-usage-live';
import {readWeekReading} from '../src/thread/quota-week';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const NOW = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;
const SID = '11112222-3333-4444-5555-666677778888';
/** A seven-day reset two days ahead: a current window. */
const WEEK_RESET_S = Math.floor((NOW + 2 * 24 * 60 * MIN) / 1000);

function window(pct: number) {
  return {pct, resetsAt: null, resetsAtError: null, resetsText: 'Jan 4'};
}

function sample(
  minutesAgo: number,
  week: number,
  byModel: Record<string, number> = {},
) {
  return JSON.stringify({
    ok: true,
    raw: '',
    sampledAt: new Date(NOW - minutesAgo * MIN).toISOString(),
    schema: 1,
    session: window(5),
    week: window(week),
    weekByModel: Object.fromEntries(
      Object.entries(byModel).map(([model, pct]) => [model, window(pct)]),
    ),
  });
}

function liveWeek(
  minutesAgo: number,
  pct: number,
  options: {resetsAt?: number; source?: 'statusline' | 'usage'} = {},
): LiveWindow {
  const source = options.source ?? 'statusline';
  return {
    at: new Date(NOW - minutesAgo * MIN).toISOString(),
    pct,
    resetsAt: options.resetsAt ?? WEEK_RESET_S,
    sessionId: source === 'statusline' ? SID : null,
    source,
  };
}

function readerWorld(samples: string[], live: LiveWindow | null) {
  const sb = createSandbox();
  sandboxes.push(sb);
  const env = {
    CLAUDE_USAGE_CACHE_DIR: join(sb.path, 'cache'),
    CLAUDE_USAGE_DATA_DIR: join(sb.path, 'data'),
    CLAUDE_USAGE_STATE_DIR: join(sb.path, 'state'),
  };
  sb.writeFile('data/samples.jsonl', `${samples.join('\n')}\n`);
  if (live != null) {
    writeLive(storePaths(env).live, {
      five_hour: null,
      schema: 1,
      seven_day: live,
    });
  }
  return readWeekReading({env, maxAgeMinutes: 150, nowMs: NOW});
}

describe('readWeekReading: live.json and the samples', () => {
  test('a newer live.json beats an older sample for the all-models week; per-model weeks come from the sample', () => {
    const reading = readerWorld([sample(30, 40, {Fable: 55})], liveWeek(5, 42));
    expect(reading.kind).toBe('known');
    if (reading.kind !== 'known') return;
    expect(reading.allModels).toMatchObject({
      measuredBy: 'statusline',
      percent: 42,
      sessionId: SID,
      source: 'live',
    });
    expect(reading.allModels.path.endsWith('live.json')).toBe(true);
    expect(reading.allModels.ageMinutes).toBe(5);
    expect(reading.byModel.Fable).toMatchObject({
      ageMinutes: 30,
      percent: 55,
      source: 'samples',
    });
  });

  test('an older live.json loses to a newer sample', () => {
    const reading = readerWorld(
      [sample(10, 40, {Fable: 50})],
      liveWeek(50, 39),
    );
    expect(reading).toMatchObject({
      allModels: {measuredBy: 'usage', percent: 40, source: 'samples'},
      byModel: {Fable: {percent: 50, source: 'samples'}},
      kind: 'known',
    });
  });

  test('a live.json written by the sampler names the sample as what measured it', () => {
    const reading = readerWorld(
      [sample(40, 40)],
      liveWeek(3, 41, {source: 'usage'}),
    );
    expect(reading).toMatchObject({
      allModels: {
        measuredBy: 'usage',
        percent: 41,
        sessionId: null,
        source: 'live',
      },
      kind: 'known',
    });
  });

  test('both stale: unknown, with both reasons named', () => {
    const reading = readerWorld(
      [sample(200, 40, {Fable: 55})],
      liveWeek(180, 41),
    );
    expect(reading.kind).toBe('unknown');
    const notes = reading.notes.join('\n');
    expect(notes).toContain('the samples reading is 200 minutes old');
    expect(notes).toContain('the live reading is 180 minutes old');
  });

  test('a stale sample is unknown even beside a fresh live.json: the per-model weeks would be unknown', () => {
    const reading = readerWorld([sample(200, 40)], liveWeek(5, 42));
    expect(reading.kind).toBe('unknown');
  });

  test('no live.json: the sample alone, and the missing file is named', () => {
    const reading = readerWorld([sample(10, 40)], null);
    expect(reading).toMatchObject({
      allModels: {percent: 40, source: 'samples'},
      kind: 'known',
    });
    expect(reading.notes.join('\n')).toContain(
      'no statusline store reading at',
    );
  });

  test('a live.json window that has already reset is not used', () => {
    const reading = readerWorld(
      [sample(30, 40)],
      liveWeek(5, 97, {resetsAt: Math.floor((NOW - MIN) / 1000)}),
    );
    expect(reading).toMatchObject({
      allModels: {percent: 40, source: 'samples'},
      kind: 'known',
    });
    expect(reading.notes.join('\n')).toContain('is of a window that reset at');
  });

  test('a corrupt live.json is named, never read as a reading', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const env = {
      CLAUDE_USAGE_DATA_DIR: join(sb.path, 'data'),
      CLAUDE_USAGE_STATE_DIR: join(sb.path, 'state'),
    };
    sb.writeFile('data/samples.jsonl', `${sample(10, 40)}\n`);
    sb.writeFile('state/live.json', '{not json');
    const reading = readWeekReading({env, maxAgeMinutes: 150, nowMs: NOW});
    expect(reading).toMatchObject({
      allModels: {source: 'samples'},
      kind: 'known',
    });
    expect(reading.notes.join('\n')).toContain('is not JSON');
  });
});
