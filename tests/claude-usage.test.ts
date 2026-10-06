/**
 * Tests for the ONE `/usage` panel parser (src/claude-usage.ts,
 * home-base-jptgj.1).
 *
 * The fixture is the real panel `claude -p /usage --output-format json`
 * returned in `.result` on 2026-09-26 at 16:10 PDT (quoted in jptgj.1's
 * description). The "What's contributing" section continued with more lines of
 * the same shape; the bead elided them, and so does this fixture.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {tmpdir} from 'node:os';

import {CLAUDE_BIN_ENV} from '../src/claude-bin';
import {
  type ChildRunner,
  parseUsagePanel,
  readUsagePanel,
  resetsTextWithoutZone,
  resolveResetInstant,
  USAGE_PANEL_ARGS,
  USAGE_PANEL_TIMEOUT_MS,
  type UsagePanel,
  usagePanelCwd,
  type UsagePanelParse,
} from '../src/claude-usage';
import {type ChildOptions, type ChildOutcome} from '../src/justin-loop/child';

const REAL_PANEL_2026_09_26 = `You are currently using your subscription to power your Claude Code usage

Current session: 14% used · resets Sep 26 at 7:29pm (America/Los_Angeles)
Current week (all models): 1% used · resets Oct 3 at 3:59pm (America/Los_Angeles)
Current week (Fable): 0% used · resets Oct 3 at 4pm (America/Los_Angeles)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 12525 requests · 13 sessions
  98% of your usage came from subagent-heavy sessions`;

/** 2026-09-26 16:10 PDT, when the fixture was captured. */
const SAMPLED_AT = new Date('2026-09-26T23:10:00Z');

const SESSION_LINE =
  'Current session: 14% used · resets Sep 26 at 7:29pm (America/Los_Angeles)';
const WEEK_LINE =
  'Current week (all models): 1% used · resets Oct 3 at 3:59pm (America/Los_Angeles)';

function okPanel(parsed: UsagePanelParse): UsagePanel {
  if (parsed.kind !== 'ok') {
    throw new Error(`expected an ok parse, got: ${parsed.reason}`);
  }
  return parsed.panel;
}

function instant(resetsText: string, sampledAt: Date): string | null {
  const resolved = resolveResetInstant(resetsText, sampledAt);
  return resolved.kind === 'ok' ? resolved.resetsAt : null;
}

describe('parseUsagePanel — the real 2026-09-26 panel', () => {
  test('reads session 14, week 1 and Fable 0 with their absolute reset instants', () => {
    const panel = okPanel(parseUsagePanel(REAL_PANEL_2026_09_26, SAMPLED_AT));
    expect(panel.session).toEqual({
      pct: 14,
      resetsAt: '2026-09-27T02:29:00Z',
      resetsAtError: null,
      resetsText: 'Sep 26 at 7:29pm (America/Los_Angeles)',
    });
    expect(panel.week).toEqual({
      pct: 1,
      resetsAt: '2026-10-03T22:59:00Z',
      resetsAtError: null,
      resetsText: 'Oct 3 at 3:59pm (America/Los_Angeles)',
    });
    expect(panel.weekByModel).toEqual({
      Fable: {
        pct: 0,
        resetsAt: '2026-10-03T23:00:00Z',
        resetsAtError: null,
        resetsText: 'Oct 3 at 4pm (America/Los_Angeles)',
      },
    });
    expect(panel.isSubscription).toBe(true);
  });

  test('the all-models line never lands in weekByModel, and Fable never becomes the week', () => {
    const panel = okPanel(parseUsagePanel(REAL_PANEL_2026_09_26, SAMPLED_AT));
    expect(Object.keys(panel.weekByModel)).toEqual(['Fable']);
    expect(panel.week.pct).toBe(1);
  });

  test('the "What\'s contributing" percentages are not quota lines', () => {
    // "98% of your usage came from…" must never be read as a window.
    const panel = okPanel(parseUsagePanel(REAL_PANEL_2026_09_26, SAMPLED_AT));
    expect(panel.session.pct).not.toBe(98);
    expect(panel.week.pct).not.toBe(98);
  });
});

describe('parseUsagePanel — per-model lines are read generically', () => {
  test('every "Current week (<Model>)" line is kept under its own name', () => {
    const panel = okPanel(
      parseUsagePanel(
        [
          SESSION_LINE,
          WEEK_LINE,
          'Current week (Fable): 30% used · resets Oct 3 at 4pm (America/Los_Angeles)',
          'Current week (Sonnet only): 12% used · resets Oct 3 at 4pm (America/Los_Angeles)',
        ].join('\n'),
        SAMPLED_AT,
      ),
    );
    expect(Object.keys(panel.weekByModel).sort()).toEqual([
      'Fable',
      'Sonnet only',
    ]);
    expect(panel.weekByModel.Fable?.pct).toBe(30);
    expect(panel.weekByModel['Sonnet only']?.pct).toBe(12);
  });

  test('a panel with no per-model line parses, with an EMPTY weekByModel — not a 0% one', () => {
    const panel = okPanel(
      parseUsagePanel([SESSION_LINE, WEEK_LINE].join('\n'), SAMPLED_AT),
    );
    expect(panel.weekByModel).toEqual({});
    expect(panel.week.pct).toBe(1);
  });

  test('a decimal percentage is read whole, not truncated', () => {
    const panel = okPanel(
      parseUsagePanel(
        'Current session: 12.5% used\nCurrent week (all models): 40% used',
        SAMPLED_AT,
      ),
    );
    expect(panel.session.pct).toBe(12.5);
  });
});

describe('parseUsagePanel — fails closed, never 0%', () => {
  test('a panel missing the session line is a FAILED parse naming the line', () => {
    const parsed = parseUsagePanel(
      REAL_PANEL_2026_09_26.replace(`${SESSION_LINE}\n`, ''),
      SAMPLED_AT,
    );
    expect(parsed.kind).toBe('failed');
    expect(parsed).not.toHaveProperty('panel');
    expect(parsed.kind === 'failed' ? parsed.reason : '').toContain(
      '`Current session: N% used`',
    );
  });

  test('a panel missing the all-models week line is a FAILED parse, even with a per-model line', () => {
    // Fable's weekly line must never stand in for the all-models one.
    const parsed = parseUsagePanel(
      REAL_PANEL_2026_09_26.replace(`${WEEK_LINE}\n`, ''),
      SAMPLED_AT,
    );
    expect(parsed.kind).toBe('failed');
    expect(parsed.kind === 'failed' ? parsed.reason : '').toContain(
      '`Current week (all models): N% used`',
    );
  });

  test('empty and unrelated text fail', () => {
    expect(parseUsagePanel('', SAMPLED_AT).kind).toBe('failed');
    expect(parseUsagePanel('Credit balance: $12.00', SAMPLED_AT).kind).toBe(
      'failed',
    );
  });

  test('API billing is flagged rather than assumed to be a subscription', () => {
    const panel = okPanel(
      parseUsagePanel([SESSION_LINE, WEEK_LINE].join('\n'), SAMPLED_AT),
    );
    expect(panel.isSubscription).toBe(false);
  });
});

describe('reset instants', () => {
  test('the minute-less form ("4pm") is on the hour', () => {
    expect(instant('Oct 3 at 4pm (America/Los_Angeles)', SAMPLED_AT)).toBe(
      '2026-10-03T23:00:00Z',
    );
  });

  test('12am is midnight and 12pm is noon', () => {
    expect(instant('Sep 28 at 12am (America/Los_Angeles)', SAMPLED_AT)).toBe(
      '2026-09-28T07:00:00Z',
    );
    expect(instant('Sep 28 at 12pm (America/Los_Angeles)', SAMPLED_AT)).toBe(
      '2026-09-28T19:00:00Z',
    );
  });

  test('year rollover: a Jan 2 reset sampled on Dec 30 is NEXT year', () => {
    const dec30 = new Date('2026-12-30T20:00:00Z'); // Dec 30, 12:00 PST
    expect(instant('Jan 2 at 4pm (America/Los_Angeles)', dec30)).toBe(
      '2027-01-03T00:00:00Z',
    );
    // …and the whole panel carries it through.
    const panel = okPanel(
      parseUsagePanel(
        'Current session: 3% used · resets Dec 30 at 5pm (America/Los_Angeles)\n' +
          'Current week (all models): 50% used · resets Jan 2 at 4pm (America/Los_Angeles)',
        dec30,
      ),
    );
    expect(panel.session.resetsAt).toBe('2026-12-31T01:00:00Z');
    expect(panel.week.resetsAt).toBe('2027-01-03T00:00:00Z');
  });

  test('a reset text a few minutes stale is NOT pushed a whole year forward', () => {
    // Sampled 00:05 on Jan 1 local; the panel still says Dec 31 23:59.
    const jan1 = new Date('2027-01-01T08:05:00Z');
    expect(instant('Dec 31 at 11:59pm (America/Los_Angeles)', jan1)).toBe(
      '2027-01-01T07:59:00Z',
    );
  });

  test('daylight saving: each side of the Nov 1 2026 change gets its own offset', () => {
    const oct30 = new Date('2026-10-30T19:00:00Z');
    expect(instant('Oct 31 at 4pm (America/Los_Angeles)', oct30)).toBe(
      '2026-10-31T23:00:00Z', // PDT, UTC-7
    );
    expect(instant('Nov 1 at 4pm (America/Los_Angeles)', oct30)).toBe(
      '2026-11-02T00:00:00Z', // PST, UTC-8
    );
  });

  test('the zone is honoured, including non-hour offsets', () => {
    expect(instant('Oct 3 at 4pm (Europe/London)', SAMPLED_AT)).toBe(
      '2026-10-03T15:00:00Z',
    );
    expect(instant('Oct 3 at 4pm (Asia/Kolkata)', SAMPLED_AT)).toBe(
      '2026-10-03T10:30:00Z',
    );
  });

  test('month names may be abbreviated or spelled out', () => {
    expect(instant('Sept 28 at 4pm (America/Los_Angeles)', SAMPLED_AT)).toBe(
      '2026-09-28T23:00:00Z',
    );
    expect(
      instant('September 28 at 4pm (America/Los_Angeles)', SAMPLED_AT),
    ).toBe('2026-09-28T23:00:00Z');
  });

  test('a garbled reset keeps the percentage and nulls the instant WITH a reason', () => {
    const panel = okPanel(
      parseUsagePanel(
        'Current session: 14% used · resets sometime soon, probably\n' +
          WEEK_LINE,
        SAMPLED_AT,
      ),
    );
    expect(panel.session.pct).toBe(14);
    expect(panel.session.resetsText).toBe('sometime soon, probably');
    expect(panel.session.resetsAt).toBeNull();
    expect(panel.session.resetsAtError).toContain('unrecognised reset text');
    // The other window is unaffected.
    expect(panel.week.resetsAt).toBe('2026-10-03T22:59:00Z');
  });

  test('a reset with no zone is not guessed into one', () => {
    const resolved = resolveResetInstant('Oct 3 at 4pm', SAMPLED_AT);
    expect(resolved.kind).toBe('failed');
  });

  test('an unknown zone fails with a reason that names it', () => {
    const resolved = resolveResetInstant(
      'Oct 3 at 4pm (Mars/Olympus)',
      SAMPLED_AT,
    );
    expect(resolved.kind === 'failed' ? resolved.reason : '').toContain(
      'unknown time zone "Mars/Olympus"',
    );
  });

  test('a date that is not in the calendar fails rather than rolling over', () => {
    // Date.UTC would quietly turn Feb 30 into Mar 2.
    const resolved = resolveResetInstant(
      'Feb 30 at 4pm (America/Los_Angeles)',
      SAMPLED_AT,
    );
    expect(resolved.kind).toBe('failed');
  });

  test('a line with no reset clause has a null resetsText, not an empty one', () => {
    const panel = okPanel(
      parseUsagePanel(
        'Current session: 7% used\nCurrent week (all models): 11% used',
        SAMPLED_AT,
      ),
    );
    expect(panel.session.resetsText).toBeNull();
    expect(panel.session.resetsAt).toBeNull();
    expect(panel.session.resetsAtError).toContain('no "· resets …" clause');
  });

  test('an invalid sample time fails the instant rather than inventing a year', () => {
    const resolved = resolveResetInstant(
      'Oct 3 at 4pm (America/Los_Angeles)',
      new Date(Number.NaN),
    );
    expect(resolved.kind).toBe('failed');
  });
});

describe('resetsTextWithoutZone', () => {
  test('drops the trailing zone and nothing else', () => {
    expect(
      resetsTextWithoutZone('Jul 16 at 10:50pm (America/Los_Angeles)'),
    ).toBe('Jul 16 at 10:50pm');
    expect(resetsTextWithoutZone('Jul 16')).toBe('Jul 16');
  });
});

describe('readUsagePanel — an injected runner for each outcome', () => {
  const previousBin = process.env[CLAUDE_BIN_ENV];
  afterEach(() => {
    if (previousBin == null) delete process.env[CLAUDE_BIN_ENV];
    else process.env[CLAUDE_BIN_ENV] = previousBin;
  });

  interface Call {
    args: string[];
    bin: string;
    opts: ChildOptions;
  }

  function outcome(over: Partial<ChildOutcome>): ChildOutcome {
    return {
      durationMs: 5,
      error: null,
      signal: null,
      status: 0,
      stderr: '',
      stdout: '',
      timedOut: false,
      timeoutMs: USAGE_PANEL_TIMEOUT_MS,
      truncated: false,
      ...over,
    };
  }

  function runner(result: ChildOutcome): {calls: Call[]; run: ChildRunner} {
    const calls: Call[] = [];
    return {
      calls,
      run: (bin, args, opts) => {
        calls.push({args, bin, opts});
        return Promise.resolve(result);
      },
    };
  }

  const clock = (): Date => SAMPLED_AT;

  test('a readable panel comes back ok, parsed at the injected sample time', async () => {
    const fake = runner(
      outcome({stdout: JSON.stringify({result: REAL_PANEL_2026_09_26})}),
    );
    const read = await readUsagePanel({
      claudeBin: '/abs/claude',
      now: clock,
      run: fake.run,
    });
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.sampledAt).toBe('2026-09-26T23:10:00.000Z');
    expect(read.raw).toBe(REAL_PANEL_2026_09_26);
    expect(read.panel.session.resetsAt).toBe('2026-09-27T02:29:00Z');
    expect(read.panel.weekByModel.Fable?.pct).toBe(0);
  });

  test('it runs `claude -p /usage --output-format json --no-session-persistence`, bounded', async () => {
    const fake = runner(
      outcome({stdout: JSON.stringify({result: REAL_PANEL_2026_09_26})}),
    );
    await readUsagePanel({claudeBin: '/abs/claude', now: clock, run: fake.run});
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.bin).toBe('/abs/claude');
    expect(fake.calls[0]?.args).toEqual([
      '-p',
      '/usage',
      '--output-format',
      'json',
      '--no-session-persistence',
    ]);
    expect(fake.calls[0]?.args).toEqual([...USAGE_PANEL_ARGS]);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(60_000);
  });

  test('it runs from the neutral temp dir, never the caller repo (F1)', async () => {
    // A `claude -p` run inside an enrolled repo fires that repo's SessionStart
    // hook, which creates a thread bead per read (home-base-jptgj F1).
    const fake = runner(
      outcome({stdout: JSON.stringify({result: REAL_PANEL_2026_09_26})}),
    );
    await readUsagePanel({claudeBin: '/abs/claude', now: clock, run: fake.run});
    const cwd = fake.calls[0]?.opts.cwd;
    expect(cwd).toBe(tmpdir());
    expect(cwd).toBe(usagePanelCwd());
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).not.toContain('/Dev/home-base');
  });

  test('with no claudeBin it spawns what resolveClaudeBin resolves', async () => {
    process.env[CLAUDE_BIN_ENV] = '/override/claude';
    const fake = runner(
      outcome({stdout: JSON.stringify({result: REAL_PANEL_2026_09_26})}),
    );
    await readUsagePanel({now: clock, run: fake.run});
    expect(fake.calls[0]?.bin).toBe('/override/claude');
  });

  test('a CHILD FAILURE is named as one, with the exit code', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({status: 3, stdout: 'boom'})).run,
    });
    expect(read.kind).toBe('failed');
    expect(read.kind === 'failed' ? read.reason : '').toBe(
      'claude -p /usage exited 3',
    );
    expect(read.sampledAt).toBe('2026-09-26T23:10:00.000Z');
  });

  test('a timeout is a failure even when the child exited 0', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({status: 0, stdout: '{"res', timedOut: true})).run,
    });
    expect(read.kind === 'failed' ? read.reason : '').toContain(
      'did not finish within',
    );
  });

  test('a binary that cannot be spawned is named as such', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({error: 'spawn claude ENOENT', status: null})).run,
    });
    expect(read.kind === 'failed' ? read.reason : '').toContain(
      'could not run: spawn claude ENOENT',
    );
  });

  test('UNPARSEABLE JSON is named as unparseable JSON', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({stdout: 'not json at all'})).run,
    });
    expect(read.kind === 'failed' ? read.reason : '').toContain(
      'unparseable JSON',
    );
  });

  test('a MISSING `result` field is named as a missing field', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({stdout: '{"type":"result","subtype":"success"}'}))
        .run,
    });
    expect(read.kind === 'failed' ? read.reason : '').toContain(
      'no string `result` field',
    );
  });

  test('an UNRECOGNISED panel is named separately, and its text is kept', async () => {
    const read = await readUsagePanel({
      now: clock,
      run: runner(outcome({stdout: '{"result":"Credit balance: $12.00"}'})).run,
    });
    expect(read.kind).toBe('failed');
    if (read.kind !== 'failed') return;
    expect(read.reason).toContain('no recognisable quota lines');
    expect(read.reason).not.toContain('unparseable JSON');
    expect(read.raw).toBe('Credit balance: $12.00');
  });
});
