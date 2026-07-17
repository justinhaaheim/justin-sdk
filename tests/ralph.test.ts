/**
 * Tests for `justin-sdk ralph`.
 *
 * The focus is `parseUsage`, which is the highest-consequence pure function in
 * the runner: it reads the REAL subscription quota out of `/usage` text and is
 * the only thing standing between a loop and eating the whole 5-hour window.
 * A silent misparse is the worst failure mode available — returning null (which
 * the loop treats as fail-closed) is always correct when the shape is unknown,
 * but returning a WRONG number is not. So these tests pin the happy path, the
 * fail-closed path, and the boundary between them.
 *
 * The verbatim fixture below is real output captured from
 * `claude -p "/usage" --output-format json` on 2026-07-16 (v2.1.212), with the
 * separator character (·) preserved exactly as emitted.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  DEFAULT_OPTIONS,
  parseBackgroundedId,
  parseUsage,
  readVerdictFile,
  VERDICT_SCHEMA,
} from '../src/ralph';

const REAL_USAGE_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Jul 16 at 10:50pm (America/Los_Angeles)
Current week (all models): 10% used · resets Jul 18 at 4pm (America/Los_Angeles)
Current week (Fable): 2% used · resets Jul 18 at 4pm (America/Los_Angeles)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 647 requests · 8 sessions
  91% of your usage came from subagent-heavy sessions`;

describe('parseUsage', () => {
  test('parses real /usage output', () => {
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage).not.toBeNull();
    expect(usage?.sessionPct).toBe(5);
    expect(usage?.weekPct).toBe(10);
    expect(usage?.isSubscription).toBe(true);
  });

  test('extracts reset timestamps', () => {
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage?.sessionResetsAt).toBe('Jul 16 at 10:50pm');
    expect(usage?.weekResetsAt).toBe('Jul 18 at 4pm');
  });

  test('does not confuse the per-model week line with the all-models line', () => {
    // "Current week (Fable): 2%" must never be read as the all-models number,
    // or the weekly gate would read far too low and never trip.
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage?.weekPct).toBe(10);
    expect(usage?.weekPct).not.toBe(2);
  });

  test('reads high percentages, not just single digits', () => {
    const usage = parseUsage(
      'Current session: 100% used · resets Jul 16 at 10:50pm\n' +
        'Current week (all models): 87% used · resets Jul 18 at 4pm',
    );
    expect(usage?.sessionPct).toBe(100);
    expect(usage?.weekPct).toBe(87);
  });

  test('fails closed on unrecognized output', () => {
    // Anything we cannot read must be null so the loop refuses to spend quota
    // it cannot measure, rather than defaulting to 0% and running free.
    expect(parseUsage('')).toBeNull();
    expect(parseUsage('Some unrelated CLI output')).toBeNull();
    expect(parseUsage('Credit balance: $12.00')).toBeNull();
  });

  test('fails closed when only the session line is present', () => {
    // A partial parse is a misparse: without the weekly number the weekly gate
    // would silently never trip.
    expect(parseUsage('Current session: 42% used · resets Jul 16')).toBeNull();
  });

  test('flags API billing rather than assuming subscription', () => {
    const usage = parseUsage(
      'Current session: 5% used · resets Jul 16 at 10:50pm\n' +
        'Current week (all models): 10% used · resets Jul 18 at 4pm',
    );
    expect(usage).not.toBeNull();
    expect(usage?.isSubscription).toBe(false);
  });
});

describe('defaults', () => {
  test("session gate defaults to Justin's 50%", () => {
    expect(DEFAULT_OPTIONS.sessionStopPct).toBe(50);
  });

  test('defaults to pausing rather than burning through the gate', () => {
    expect(DEFAULT_OPTIONS.onGateHit).toBe('pause');
  });

  test('never resumes a session — fresh context per iteration is the technique', () => {
    // Guard against someone "helpfully" adding --resume later.
    expect(DEFAULT_OPTIONS.prompt).toBe('/loop-session');
  });
});

describe('parseBackgroundedId', () => {
  // Verbatim `claude --bg` banner, captured 2026-07-16 (v2.1.212).
  const BANNER = `warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)
backgrounded · 1a7289b9 · ralph-probe-DELETEME
  claude agents             list sessions
  claude attach 1a7289b9    open in this terminal
  claude logs 1a7289b9      show recent output
  claude stop 1a7289b9      stop this session`;

  test('extracts the session id from the real banner', () => {
    expect(parseBackgroundedId(BANNER)).toBe('1a7289b9');
  });

  test('is not fooled by the warning line that precedes it', () => {
    // The banner is preceded by a --session-id warning that also contains <id>.
    expect(parseBackgroundedId(BANNER)).not.toBe('<id>');
  });

  test('returns null when dispatch produced no banner', () => {
    expect(parseBackgroundedId('')).toBeNull();
    expect(parseBackgroundedId('some error happened')).toBeNull();
  });
});

describe('readVerdictFile', () => {
  function withVerdict(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-verdict-'));
    writeFileSync(join(dir, 'v.json'), contents);
    return dir;
  }

  test('reads a well-formed verdict', () => {
    const dir = withVerdict(
      '{"status":"CONTINUE","summary":"did a thing","followUps":["hb-1"]}',
    );
    const verdict = readVerdictFile(dir, 'v.json');
    expect(verdict?.status).toBe('CONTINUE');
    expect(verdict?.summary).toBe('did a thing');
    expect(verdict?.followUps).toEqual(['hb-1']);
  });

  test('treats a missing file as a crash, not a success', () => {
    // In attachable mode there is no --json-schema forcing a verdict, so a
    // missing file is the normal shape of "the iteration died". It must never
    // read as an implicit pass.
    const dir = mkdtempSync(join(tmpdir(), 'ralph-verdict-'));
    expect(readVerdictFile(dir, 'nope.json')).toBeNull();
  });

  test('rejects an invalid status rather than passing it through', () => {
    const dir = withVerdict('{"status":"DONE","summary":"x","followUps":[]}');
    expect(readVerdictFile(dir, 'v.json')).toBeNull();
  });

  test('rejects malformed JSON', () => {
    const dir = withVerdict('{not json');
    expect(readVerdictFile(dir, 'v.json')).toBeNull();
  });

  test('tolerates a missing followUps list', () => {
    // Worth being lenient here: the shape is model-authored, and losing an
    // iteration over an omitted empty array would be silly.
    const dir = withVerdict('{"status":"COMPLETE","summary":"done"}');
    expect(readVerdictFile(dir, 'v.json')?.followUps).toEqual([]);
  });
});

describe('attachable defaults', () => {
  test('defaults to attachable — Justin asked for it explicitly', () => {
    expect(DEFAULT_OPTIONS.mode).toBe('attachable');
  });

  test('bounds the blocked wait so an iteration cannot strand', () => {
    // The entire reason this bound exists: block-and-wait with no bound is how
    // 17 sessions on this machine ended up blocked for up to 43 days.
    expect(DEFAULT_OPTIONS.blockedWaitMin).toBeGreaterThan(0);
    expect(DEFAULT_OPTIONS.blockedWaitMin).toBeLessThanOrEqual(60);
  });
});

describe('VERDICT_SCHEMA', () => {
  test('pins the four stop states the loop switches on', () => {
    expect(VERDICT_SCHEMA.properties.status.enum).toEqual([
      'CONTINUE',
      'COMPLETE',
      'BLOCKED',
      'FAILED',
    ]);
  });

  test('requires every field the runner reads', () => {
    expect(VERDICT_SCHEMA.required).toEqual(['status', 'summary', 'followUps']);
  });
});
