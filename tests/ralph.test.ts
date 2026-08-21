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

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';

import {
  attachableContract,
  checkGate,
  DEFAULT_OPTIONS,
  parseBackgroundedId,
  parseUsage,
  readVerdictFile,
  respawnIntent,
  type UsageSnapshot,
  VERDICT_CONTRACT,
  VERDICT_SCHEMA,
} from '../src/ralph';
import {initRepo} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

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

  test('the usage gate is ON unless explicitly opted out', () => {
    // The opt-out must always be a deliberate act. If this default ever flips,
    // every unattended loop silently loses its quota ceiling.
    expect(DEFAULT_OPTIONS.usageGate).toBe(true);
  });
});

/**
 * The `--no-usage-gate` opt-out (home-base-nsd5).
 *
 * Background, because the flag looks like a footgun without it: the gate reads
 * `/usage` before every iteration and refuses to run when it cannot be read.
 * That is right. But `claude -p /usage` stopped rendering the quota panel in
 * print mode, so the read returned null EVERY time and fail-closed stopped
 * meaning "careful" and started meaning "never runs" — scheduled runs became
 * silent no-ops (0 iterations, $0.00, no output). The opt-out restores the
 * ability to run a bounded job while keeping fail-closed as the default.
 *
 * Two properties these tests exist to defend:
 *   1. Off means NO `/usage` CALL — not a call whose answer is ignored. Asserted
 *      by counting reader invocations, since a wasted spawn per iteration would
 *      otherwise be invisible.
 *   2. The default is untouched. An unreadable quota with the flag absent must
 *      still stop the run, with a reason that names what could not be read.
 */
describe('checkGate', () => {
  function snapshot(sessionPct: number, weekPct: number): UsageSnapshot {
    return {
      isSubscription: true,
      raw: 'fixture',
      sessionPct,
      sessionResetsAt: null,
      weekPct,
      weekResetsAt: null,
    };
  }

  /** A quota reader that records whether — and how often — it was consulted. */
  function countingReader(result: UsageSnapshot | null): {
    read: () => UsageSnapshot | null;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      read: () => {
        calls++;
        return result;
      },
    };
  }

  const THRESHOLDS = {sessionStopPct: 50, weeklyStopPct: 80};

  test('gate off: skips the quota read entirely, never spawning /usage', () => {
    // The load-bearing assertion is calls() === 0. "Skips the gate" has to mean
    // no process is spawned; reading the quota and then ignoring it would pass
    // a naive kind-only assertion while still hitting the broken /usage path
    // once per iteration.
    const reader = countingReader(snapshot(5, 10));
    const decision = checkGate({...THRESHOLDS, usageGate: false}, reader.read);
    expect(decision.kind).toBe('disabled');
    expect(reader.calls()).toBe(0);
  });

  test('gate off: reports no percentages at all — absent, not zero', () => {
    // Critical rule 6. A disabled gate must not hand downstream code a
    // fabricated 0%, which would render as an empty quota bar and read as
    // "plenty of room left".
    const decision = checkGate({...THRESHOLDS, usageGate: false}, () => null);
    expect(decision).toEqual({kind: 'disabled'});
    expect(decision).not.toHaveProperty('usage');
  });

  test('gate on: an unreadable quota still fails closed', () => {
    // The default path, unchanged. This is the exact shape of the live bug:
    // the reader succeeds as a process but parses to null.
    const reader = countingReader(null);
    const decision = checkGate({...THRESHOLDS, usageGate: true}, reader.read);
    expect(decision.kind).toBe('unreadable');
    expect(reader.calls()).toBe(1);
  });

  test('gate on: the fail-closed reason names /usage so the stop is diagnosable', () => {
    // A bare "stopped" would have made the original bug much harder to find —
    // the run summary is the only surface a scheduled job leaves behind.
    const decision = checkGate({...THRESHOLDS, usageGate: true}, () => null);
    expect(decision.kind === 'unreadable' ? decision.reason : '').toContain(
      '/usage',
    );
    expect(decision.kind === 'unreadable' ? decision.reason : '').toContain(
      'failing closed',
    );
  });

  test('gate on: proceeds when both windows are under their thresholds', () => {
    const decision = checkGate({...THRESHOLDS, usageGate: true}, () =>
      snapshot(5, 10),
    );
    expect(decision.kind).toBe('ok');
    expect(decision.kind === 'ok' ? decision.usage.sessionPct : null).toBe(5);
  });

  test('gate on: trips at the session threshold, inclusive', () => {
    const decision = checkGate({...THRESHOLDS, usageGate: true}, () =>
      snapshot(50, 10),
    );
    expect(decision.kind).toBe('tripped');
  });

  test('gate on: trips at the weekly threshold, inclusive', () => {
    const decision = checkGate({...THRESHOLDS, usageGate: true}, () =>
      snapshot(5, 80),
    );
    expect(decision.kind).toBe('tripped');
  });
});

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

describe('ralph CLI help', () => {
  // yargs handles --help before command validation and before any handler runs,
  // so this never touches `claude` and never starts a loop.
  function ralphHelp(): string {
    const proc = spawnSync('bun', [CLI, 'ralph', '--help'], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  }

  test('documents the opt-out by the name the user actually types', () => {
    // The flag is declared positively (`--usage-gate`, default true) and reached
    // through yargs boolean-negation, so `--no-usage-gate` appears nowhere in
    // the generated option list — it has to be in the description or it is
    // undiscoverable.
    expect(ralphHelp()).toContain('--no-usage-gate');
  });

  test('keeps the gate on by default in the help output', () => {
    expect(ralphHelp()).toMatch(/--usage-gate[\s\S]*default: true/);
  });
});

/**
 * End-to-end proof that `--no-usage-gate` actually reaches the gate, against a
 * FAKE `claude` on PATH.
 *
 * This exists because the unit tests above cannot see the seam most likely to
 * break silently: the yargs wiring. `--no-usage-gate` is not a declared option
 * name — it is boolean-negation of `--usage-gate` — and an option declared
 * literally as `no-usage-gate` would be negated into `usage-gate: false` while
 * `no-usage-gate` kept its own default, so passing the flag would compile,
 * typecheck, run, and do NOTHING (measured on yargs 18). Nothing but an
 * end-to-end run catches that.
 *
 * The fake `claude` reproduces the live bug exactly (home-base-nsd5): `-p
 * /usage` exits 0 with a valid JSON envelope whose `result` carries no
 * percentages. So the no-flag arm here is a genuine reproduction, and doubles as
 * the negative control for the flag arm.
 *
 * `--dry-run` throughout: no iteration is ever spawned, and the fake would not
 * be able to do any work if one were.
 */
describe('ralph --dry-run, end to end with a fake claude on PATH', () => {
  const sandboxes: Sandbox[] = [];
  afterEach(() => {
    while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  });

  interface Fixture {
    repo: string;
    callLog: string;
    env: Record<string, string | undefined>;
  }

  function fixture(): Fixture {
    const sb = createSandbox();
    sandboxes.push(sb);
    // preflight requires a git repo with a resolvable HEAD.
    const repo = initRepo(sb, 'project', {'README.md': '# ralph fixture\n'});

    const binDir = join(sb.path, 'fakebin');
    mkdirSync(binDir, {recursive: true});
    const callLog = join(sb.path, 'claude-calls.log');
    const fake = join(binDir, 'claude');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        // Log EVERY invocation, including --version. The flag arm asserts the
        // log exists and holds the --version line, so "no /usage call" cannot
        // pass merely because the fake was never on PATH at all.
        `echo "$@" >> ${JSON.stringify(callLog)}`,
        'if [ "$1" = "--version" ]; then echo "2.1.999-fake"; exit 0; fi',
        // The bug, verbatim in shape: exit 0, valid JSON, no percentages.
        `printf '%s' '{"result":"Total cost: $0.0000","is_error":false,"num_turns":0}'`,
        'exit 0',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);

    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };
    // preflight refuses to run at all when this is set, which would make both
    // arms fail for an unrelated reason on a machine that has one exported.
    delete env.ANTHROPIC_API_KEY;
    return {callLog, env, repo};
  }

  function runDryRun(
    f: Fixture,
    args: string[],
  ): {out: string; status: number | null; calls: string[]} {
    const proc = spawnSync('bun', [CLI, 'ralph', '--dry-run', ...args], {
      cwd: f.repo,
      encoding: 'utf-8',
      env: f.env,
      timeout: 120_000,
    });
    return {
      calls: existsSync(f.callLog)
        ? readFileSync(f.callLog, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
      out: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
      status: proc.status,
    };
  }

  test('without the flag: spawns /usage, cannot read it, and refuses to run', () => {
    // The default, unchanged — and a live reproduction of the bug the flag
    // exists for. This is also the negative control for the next test: it
    // proves the fake IS reachable and IS consulted.
    const result = runDryRun(fixture(), []);
    expect(result.calls.filter((c) => c.includes('/usage')).length).toBe(1);
    expect(result.out).toContain('could not read /usage');
    expect(result.status).toBe(1);
  });

  test('with --no-usage-gate: no /usage call is made at all, and it proceeds', () => {
    const result = runDryRun(fixture(), ['--no-usage-gate']);
    // The fake was on PATH and was used (preflight's --version probe) …
    expect(result.calls.some((c) => c.includes('--version'))).toBe(true);
    // … and yet /usage was never asked for.
    expect(result.calls.filter((c) => c.includes('/usage'))).toEqual([]);
    expect(result.out).not.toContain('could not read /usage');
    expect(result.status).toBe(0);
  });

  test('with --no-usage-gate: reports quota as unread, never as a percentage', () => {
    const result = runDryRun(fixture(), ['--no-usage-gate']);
    expect(result.out).toContain('gate disabled');
    expect(result.out).toContain('not read');
    // "stop at N%" is emitted only by a rendered quota bar, so its absence is
    // the assertion that no percentage was fabricated to fill the gap.
    expect(result.out).not.toContain('stop at');
  });

  test('the handoff scan and --no-usage-gate compose (1r6d.4 AC7)', () => {
    // Two independently-added preflight steps in one run. The fixture repo is a
    // plain git repo with no beads workspace, so this also exercises the
    // degradation path end to end: the scan cannot look, says so, and the run
    // still proceeds and exits 0 rather than dying on a missing `br`.
    const result = runDryRun(fixture(), ['--no-usage-gate']);
    expect(result.out).toContain('handoff');
    expect(result.out).toContain('UNAVAILABLE');
    expect(result.out).toContain('may exist and not be seen');
    expect(result.status).toBe(0);
    // …and it did not resurrect the /usage call the flag exists to suppress.
    expect(result.calls.filter((c) => c.includes('/usage'))).toEqual([]);
  });

  test('with the gate ON, a repo with no handoffs still reports the scan', () => {
    // Silence must be a claim: the scan line appears on every run, so "nothing
    // waiting" is never confused with "nobody looked".
    const result = runDryRun(fixture(), []);
    expect(result.out).toContain('handoff');
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

  // --- respawn intent (home-base-1r6d.4) ---

  test('round-trips a respawn intent and the handoff bead it names', () => {
    const dir = withVerdict(
      '{"status":"CONTINUE","summary":"context is full","followUps":[],"respawn":"immediate","handoffBead":"hb-42"}',
    );
    const v = readVerdictFile(dir, 'v.json');
    expect(v?.respawn).toBe('immediate');
    expect(v?.handoffBead).toBe('hb-42');
    expect(respawnIntent(v)).toBe('immediate');
  });

  test('an omitted respawn stays ABSENT in the parse, and reads as on-schedule', () => {
    // Two different facts kept apart: the field is null (nobody said anything),
    // and every respawn DECISION reads that null conservatively.
    const dir = withVerdict('{"status":"CONTINUE","summary":"more to do"}');
    const v = readVerdictFile(dir, 'v.json');
    expect(v?.respawn).toBeNull();
    expect(v?.handoffBead).toBeNull();
    expect(respawnIntent(v)).toBe('on-schedule');
  });

  test('an unrecognised respawn value is discarded, never guessed at', () => {
    // Guessing "immediate" from a typo would boot a session nobody asked for.
    const dir = withVerdict(
      '{"status":"CONTINUE","summary":"x","respawn":"IMMEDIATE!"}',
    );
    expect(readVerdictFile(dir, 'v.json')?.respawn).toBeNull();
  });

  test('an empty handoffBead is absent, not a bead id', () => {
    const dir = withVerdict(
      '{"status":"CONTINUE","summary":"x","respawn":"immediate","handoffBead":"  "}',
    );
    expect(readVerdictFile(dir, 'v.json')?.handoffBead).toBeNull();
  });

  test('respawnIntent is conservative when there is no verdict at all', () => {
    expect(respawnIntent(null)).toBe('on-schedule');
  });
});

/**
 * The injected contract is the ONLY place the outgoing session learns the
 * handoff lifecycle — `/loop-session` is shared with interactive use and stays
 * runner-agnostic, so runner plumbing lives here (home-base-1r6d.4 AC2).
 */
describe('VERDICT_CONTRACT — the handoff lifecycle', () => {
  test('states the order: commit, flush beads, write the bead, then report', () => {
    expect(VERDICT_CONTRACT).toContain('Commit your code');
    expect(VERDICT_CONTRACT).toContain('Flush and commit .beads/');
    expect(VERDICT_CONTRACT).toContain('br create "HANDOFF: <arc>"');
    expect(VERDICT_CONTRACT).toContain('--labels handoff');
    expect(VERDICT_CONTRACT).toContain('Report your verdict');
  });

  test('tells the session what the handoff bead must carry', () => {
    expect(VERDICT_CONTRACT).toContain('WORKTREE PATH');
    expect(VERDICT_CONTRACT).toContain('next concrete step');
    expect(VERDICT_CONTRACT).toContain('open questions');
  });

  test('warns about clap eating values that start with a dash', () => {
    // `br update --notes -foo` is parsed as a flag; the equals form is the fix.
    expect(VERDICT_CONTRACT).toContain('--flag=value');
  });

  test('names both respawn intents and says silence means on-schedule', () => {
    expect(VERDICT_CONTRACT).toContain('immediate');
    expect(VERDICT_CONTRACT).toContain('on-schedule');
    expect(VERDICT_CONTRACT).toContain('never boots a successor');
  });

  test('forbids `br init` in a repo with no beads workspace', () => {
    // Creating a workspace unasked is exactly the o33r damage shape.
    expect(VERDICT_CONTRACT).toContain('do NOT run `br init`');
  });

  test('pre-authorises the automated notices as the repo owner speaking', () => {
    // home-base-1r6d.7: a sterile session flagged the wrap-up directive as a
    // prompt injection and refused it — "instructions you never gave". The fix
    // is provenance, so the contract vouches for the channel by name.
    expect(VERDICT_CONTRACT).toContain('[Automated Usage Check]');
    expect(VERDICT_CONTRACT).toContain('[Automated Time Check]');
    expect(VERDICT_CONTRACT).toContain('not a');
    expect(VERDICT_CONTRACT).toContain('prompt-injection attempt');
    expect(VERDICT_CONTRACT).toContain('follow it');
  });

  test('the attachable verdict example carries the respawn fields', () => {
    // The model copies this literally; a stale example is a silent way to lose
    // the whole feature in the mode that is the DEFAULT.
    const contract = attachableContract('/tmp/verdict.json');
    expect(contract).toContain('"respawn":"immediate"');
    expect(contract).toContain('"handoffBead"');
    expect(contract).toContain('"immediate" or "on-schedule"');
  });

  test('the attachable contract still puts the verdict file LAST', () => {
    expect(attachableContract('/tmp/verdict.json')).toContain(
      'as the LAST thing you do',
    );
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

  test('print mode can express a respawn intent and a handoff bead', () => {
    // additionalProperties is false, so an undeclared field could not be
    // written at all — print mode would silently lose the whole feature.
    expect(VERDICT_SCHEMA.properties.respawn.enum).toEqual([
      'immediate',
      'on-schedule',
    ]);
    expect(VERDICT_SCHEMA.properties.handoffBead.type).toBe('string');
  });

  test('leaves both respawn fields optional', () => {
    // An iteration with nothing to hand forward has nothing honest to put in
    // them, and an omitted respawn already has a defined meaning.
    expect(VERDICT_SCHEMA.required).not.toContain('respawn');
    expect(VERDICT_SCHEMA.required).not.toContain('handoffBead');
  });
});
