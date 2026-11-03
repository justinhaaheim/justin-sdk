/**
 * The /usage history's record format (src/claude-usage-samples.ts): an ok
 * sample whose panel showed no 5-hour window carries `session: null`
 * (home-base-jm5kg.19 D3), still schema 1, and the line validator tells that
 * apart from an absent or malformed session window.
 */
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {type UsagePanelRead} from '../src/claude-usage';
import {
  appendSample,
  readSamples,
  type Sample,
  sampleFromRead,
  SCHEMA,
} from '../src/claude-usage-samples';

const WEEK = {
  pct: 3,
  resetsAt: '2026-11-07T23:00:00Z',
  resetsAtError: null,
  resetsText: 'Nov 7 at 3pm (America/Los_Angeles)',
};

/** An ok read of a panel with no `Current session` line. */
const NO_SESSION_READ: UsagePanelRead = {
  kind: 'ok',
  panel: {
    isSubscription: true,
    session: null,
    week: WEEK,
    weekByModel: {Fable: {...WEEK, pct: 1}},
  },
  raw: 'Current week (all models): 3% used · resets Nov 7 at 3pm (America/Los_Angeles)',
  sampledAt: '2026-11-03T06:57:59.797Z',
};

/**
 * An ok record as the sampler wrote them before 2026-10-30, with a session
 * window (the shape of the real 2026-10-30T19:57Z record, raw trimmed).
 */
const OLD_RECORD = {
  ok: true,
  raw: 'Current session: 5% used · resets Oct 30 at 1pm (America/Los_Angeles)',
  sampledAt: '2026-10-30T19:57:10.341Z',
  schema: 1,
  session: {
    pct: 5,
    resetsAt: '2026-10-30T20:00:00Z',
    resetsAtError: null,
    resetsText: 'Oct 30 at 1pm (America/Los_Angeles)',
  },
  trigger: 'hourly',
  week: WEEK,
  weekByModel: {},
};

function scratchPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'claude-usage-samples-')),
    'samples.jsonl',
  );
}

describe('an ok sample with no 5-hour window (jm5kg.19 D3)', () => {
  test('sampleFromRead keeps session null, never a 0% window', () => {
    const sample = sampleFromRead(NO_SESSION_READ, {trigger: 'hourly'});
    expect(sample).toMatchObject({ok: true, schema: SCHEMA, session: null});
  });

  test('round-trips through appendSample and readSamples: session null, nothing unreadable', () => {
    const path = scratchPath();
    const sample = sampleFromRead(NO_SESSION_READ, {trigger: 'hourly'});
    appendSample(path, sample);
    // The line on disk says null explicitly; the key is not dropped.
    expect(readFileSync(path, 'utf-8')).toContain('"session":null');
    const read = readSamples(path);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.unreadable).toEqual([]);
    expect(read.lastLineUnreadable).toBe(false);
    expect(read.samples).toEqual([sample]);
  });

  test('an old record with a session window still reads, beside a new null one', () => {
    const path = scratchPath();
    writeFileSync(path, `${JSON.stringify(OLD_RECORD)}\n`);
    appendSample(path, sampleFromRead(NO_SESSION_READ));
    const read = readSamples(path);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.unreadable).toEqual([]);
    const [old, current] = read.samples as [Sample, Sample];
    expect(old.ok && old.session).toEqual(OLD_RECORD.session);
    expect(current.ok && current.session).toBeNull();
  });

  test('an ABSENT session key and a malformed session window are still unreadable lines', () => {
    const path = scratchPath();
    const {session: _dropped, ...absent} = OLD_RECORD;
    const malformed = {...OLD_RECORD, session: {pct: '5'}};
    writeFileSync(
      path,
      `${JSON.stringify(absent)}\n${JSON.stringify(malformed)}\n`,
    );
    const read = readSamples(path);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.samples).toEqual([]);
    expect(read.unreadable.map((entry) => entry.line)).toEqual([1, 2]);
    for (const entry of read.unreadable) {
      expect(entry.reason).toContain('no valid session window');
    }
    expect(read.lastLineUnreadable).toBe(true);
  });
});
