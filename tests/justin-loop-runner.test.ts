/**
 * Tests for `justin-sdk justin-loop` — the run-level surface: the usage gate,
 * the defaults, the session contract, and the CLI wiring.
 *
 * The per-session behaviour (what the runner does with a handoff bead once a
 * session ends, and how it proves the predecessor is gone) lives in
 * tests/justin-loop-session.test.ts.
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
  blockedWaitDescription,
  type BootContext,
  bootContract,
  checkGate,
  DEFAULT_OPTIONS,
  parseBackgroundedId,
  parseUsage,
  REAL_DEPS,
  sessionContract,
  timeoutDescription,
  type UsageSnapshot,
} from '../src/justin-loop/runner';
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

  test('never resumes a session — fresh context per session is the technique', () => {
    // Guard against someone "helpfully" adding --resume later.
    expect(DEFAULT_OPTIONS.prompt).toBe('/loop-session');
  });

  test('the usage gate is ON unless explicitly opted out', () => {
    // The opt-out must always be a deliberate act. If this default ever flips,
    // every unattended loop silently loses its quota ceiling.
    expect(DEFAULT_OPTIONS.usageGate).toBe(true);
  });

  test('there is NO wall-clock timeout by default (D7)', () => {
    // The 2026-09-07 pilot's worst failure: a 45-minute timeout fired, declared
    // CRASH, did NOT stop the session, and spawned a successor onto the live
    // predecessor (home-base-1r6d.31/.32). Sessions are bounded by the ~300k
    // wrap-up notice, not by minutes. 0 means none — and it must stay 0.
    expect(DEFAULT_OPTIONS.timeoutMin).toBe(0);
  });

  test('the chain is three sessions long by default (D7)', () => {
    expect(DEFAULT_OPTIONS.maxSessions).toBe(3);
  });

  test('the ledger lives outside git, under ~/.local/state — never tmp/ (D9)', () => {
    // tmp/ was where the verdict file and the old ledger lived, and both are
    // gone. A ledger inside the repo is a file every session has to remember not
    // to commit.
    expect(DEFAULT_OPTIONS.stateDir).toContain(
      '.local/state/justin-sdk/justin-loop',
    );
    expect(DEFAULT_OPTIONS.stateDir).not.toContain('tmp');
  });

  test('the header describes the timeout policy it will actually apply', () => {
    expect(timeoutDescription(0)).toContain('no wall-clock timeout');
    expect(timeoutDescription(0)).toContain('--timeout-min');
    expect(timeoutDescription(45)).toContain('45m');
    expect(timeoutDescription(45)).not.toContain('no wall-clock timeout');
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

describe('justin-loop CLI help (AC6)', () => {
  // yargs handles --help before command validation and before any handler runs,
  // so this never touches `claude` and never starts a loop.
  function help(...argv: string[]): {out: string; status: number | null} {
    const proc = spawnSync('bun', [CLI, ...argv], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return {
      out: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
      status: proc.status,
    };
  }

  test('documents the opt-out by the name the user actually types', () => {
    // The flag is declared positively (`--usage-gate`, default true) and reached
    // through yargs boolean-negation, so `--no-usage-gate` appears nowhere in
    // the generated option list — it has to be in the description or it is
    // undiscoverable.
    expect(help('justin-loop', '--help').out).toContain('--no-usage-gate');
  });

  test('keeps the gate on by default in the help output', () => {
    expect(help('justin-loop', '--help').out).toMatch(
      /--usage-gate[\s\S]*default: true/,
    );
  });

  test('`justin-loop` is the documented entry, listed by the top-level help', () => {
    const top = help('--help').out;
    expect(top).toContain('justin-loop');
    // The old name is not advertised anywhere: it is rewritten before yargs.
    expect(top).not.toContain('ralph');
  });

  test('the runner flags are on the justin-loop command itself', () => {
    const out = help('justin-loop', '--help').out;
    for (const flag of [
      '--max-sessions',
      '--timeout-min',
      '--label',
      '--state-dir',
      '--blocked-wait-min',
    ]) {
      expect(out).toContain(flag);
    }
  });

  test('the handoff subcommands are still nested under it', () => {
    expect(help('justin-loop', '--help').out).toContain('handoff');
  });

  test('PRINT MODE AND ITS FLAGS ARE GONE (D2)', () => {
    // The whole `--mode print` path was deleted: a headless session cannot be
    // attached or answered, and the handoff helper needs no structured output.
    // If any of these reappear in help, the verdict-file design has crept back.
    const out = help('justin-loop', '--help').out;
    // Anchored, because `--permission-mode` legitimately contains `--mode`.
    expect(out).not.toMatch(/(^|\s)--mode\b/);
    expect(out).not.toContain('--verdict-path');
    expect(out).not.toContain('--max-budget-usd');
    expect(out).not.toContain('json-schema');
    expect(out).not.toContain('verdict');
  });

  test('the help says the bead is the control channel, not a file', () => {
    expect(help('justin-loop', '--help').out).toContain('handoff bead');
  });

  test('--max-iterations still works, hidden, and is not advertised', () => {
    // One release of grace for a scheduled invocation that predates the rename.
    expect(help('justin-loop', '--help').out).not.toContain('--max-iterations');
  });

  test('`ralph` prints the deprecation line and delegates (D1)', () => {
    const result = help('ralph', '--help');
    expect(result.out).toContain(
      'ralph is now justin-loop; the ralph name goes away in the next release',
    );
    // Delegated, not merely warned about: this IS the justin-loop help.
    expect(result.out).toContain('--max-sessions');
    expect(result.out).toContain('handoff bead');
    expect(result.status).toBe(0);
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
describe('justin-loop --dry-run, end to end with a fake claude on PATH', () => {
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
    const repo = initRepo(sb, 'project', {
      'README.md': '# justin-loop fixture\n',
    });

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
    const proc = spawnSync('bun', [CLI, 'justin-loop', '--dry-run', ...args], {
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

describe('REAL_DEPS.dispatch — a failed dispatch says WHY', () => {
  const sandboxes: Sandbox[] = [];
  afterEach(() => {
    while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  });

  /**
   * Put a scripted `claude` first on PATH. `REAL_DEPS.dispatch` resolves the
   * binary from PATH at call time, so this is the whole injection point.
   */
  function withFakeClaude<T>(body: string, run: (repo: string) => T): T {
    const sb = createSandbox();
    sandboxes.push(sb);
    const repo = initRepo(sb, 'project', {'README.md': '# fixture\n'});
    const binDir = join(sb.path, 'fakebin');
    mkdirSync(binDir, {recursive: true});
    const fake = join(binDir, 'claude');
    writeFileSync(fake, `#!/bin/sh\n${body}\n`);
    chmodSync(fake, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${binDir}:${original ?? ''}`;
    try {
      return run(repo);
    } finally {
      process.env.PATH = original;
    }
  }

  test('a non-zero exit carries stderr into the banner, not an empty string', () => {
    // The real refusal, verbatim (measured 2026-09-09, claude 2.1.266):
    // `--bg` with bypassPermissions needs a one-time interactive acceptance.
    // Before home-base-1r6d.33.10 this reached the run summary as
    // "`claude --bg` printed no id: \"\"" — a failed measurement rendered as an
    // empty value, which is exactly what critical rule 6 forbids.
    const refusal =
      '--bg with bypassPermissions requires accepting the disclaimer first.';
    const banner = withFakeClaude(
      `echo ${JSON.stringify(refusal)} >&2\nexit 1`,
      (repo) => REAL_DEPS.dispatch(repo, ['--bg', 'hello']),
    );
    expect(banner).toContain(refusal);
    expect(banner).toContain('exited 1');
    // …and it is still not mistaken for a successful dispatch.
    expect(parseBackgroundedId(banner)).toBeNull();
  });

  test('a successful dispatch returns stdout unchanged, with nothing appended', () => {
    // The negative control for the arm above: the failure text must never leak
    // into a good banner, and the id must still parse.
    const banner = withFakeClaude(
      `echo "backgrounded · abc12345 · a name"\nexit 0`,
      (repo) => REAL_DEPS.dispatch(repo, ['--bg', 'hello']),
    );
    expect(banner).toBe('backgrounded · abc12345 · a name\n');
    expect(parseBackgroundedId(banner)).toBe('abc12345');
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

/**
 * The injected contract is the ONLY place a session learns the justin-loop
 * protocol — `/loop-session` is shared with interactive use and stays
 * runner-agnostic, so runner plumbing lives here (home-base-1r6d.33.4).
 */
describe('sessionContract — the handoff protocol', () => {
  const LABEL = 'justin-loop-3';
  /** The directory the runner was launched in — the beads workspace it scans. */
  const CWD = '/Users/jhaa/Dev/home-base';
  const contract = sessionContract({
    blockedWaitMin: null,
    cwd: CWD,
    label: LABEL,
  });
  /** The worst case for size: contract + the longest boot preamble. */
  const pickupBoot: BootContext = {
    cwd: CWD,
    label: LABEL,
    plan: {
      kind: 'handoff',
      match: {
        handoff: {
          arc: 'the arc',
          branch: 'worktree-the-arc',
          contextTokens: 301_000,
          createdAt: '2026-09-08T03:00:00Z',
          disposition: 'continue',
          from: 'justin-loop-2',
          next: 'Carry on with the arc.',
          openQuestions: [],
          schemaVersion: 1,
          state: 'Half done.',
          // A worktree, deliberately NOT the runner's own directory: the two are
          // different places, and the contract has to name both (1r6d.33.9).
          worktree: '/Users/jhaa/Dev/home-base/.claude/worktrees/the-arc',
        },
        row: {
          id: 'hoff-42',
          labels: ['handoff'],
          notes: '{}',
          status: 'open',
          title: 'HANDOFF continue: the arc',
          updatedAt: '2026-09-08T03:00:00Z',
        },
      },
    },
  };

  test('tells the session its own label, and stamps it onto --from (D5)', () => {
    // Identity is the whole of D5: the runner matches the handoff to the
    // session by this string, so a session that does not know its label cannot
    // write a handoff the runner will accept.
    expect(contract).toContain(`\`${LABEL}\``);
    expect(contract).toContain(`--from=${LABEL}`);
  });

  test('teaches the helper command with every flag it takes (D4)', () => {
    // Hand-written JSON in a notes field is what D4 exists to prevent, so the
    // contract has to carry the whole invocation, not a gesture at it.
    expect(contract).toContain('justin-sdk justin-loop handoff');
    for (const flag of [
      '--disposition=',
      '--arc=',
      '--worktree=',
      '--branch=',
      '--state=',
      '--next=',
      '--open-question=',
      '--context-tokens=',
    ]) {
      expect(contract).toContain(flag);
    }
  });

  test('names the directory to run the helper and the claim from (1r6d.33.9)', () => {
    // `br` resolves its workspace from the process's own cwd, and the runner
    // scans the directory IT was launched in. A conductor session that pins
    // every `br` to its worktree therefore writes its handoff into
    // `<worktree>/.beads/`, where the runner never looks — and the run reads as
    // a session that wrote no handoff at all, which is the failure this text
    // prevents. Both commands that touch the runner's database are named.
    expect(contract).toContain(`\`${CWD}\``);
    expect(contract).toContain('br close');
    // Whitespace-collapsed so the assertion survives a re-wrap of the prose.
    expect(contract.replace(/\s+/g, ' ')).toContain(
      `RUN THAT HELPER — and the \`br close\` that claims a handoff — FROM \`${CWD}\`, the directory this loop was started in: the runner reads THAT repo's beads database, not a worktree's`,
    );

    // Interpolated from the argument, not a constant that happens to be
    // home-base: the same contract for another repo names that repo.
    const elsewhere = sessionContract({
      blockedWaitMin: null,
      cwd: '/Users/jhaa/Dev/nature-sounds',
      label: LABEL,
    });
    expect(elsewhere).toContain('`/Users/jhaa/Dev/nature-sounds`');
    expect(elsewhere).not.toContain(CWD);
  });

  test('states the order: commit, flush beads, hand off, then stop', () => {
    // Order is load-bearing: a handoff written before the commit points at a
    // branch that does not have the work on it.
    const commit = contract.indexOf('Commit your code');
    const flush = contract.indexOf('Flush and commit `.beads/`');
    const handoff = contract.indexOf('justin-sdk justin-loop handoff');
    const end = contract.indexOf('End your turn');
    expect(commit).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(commit);
    expect(handoff).toBeGreaterThan(flush);
    expect(end).toBeGreaterThan(handoff);
  });

  test('names the three dispositions and what each does to the loop (D2)', () => {
    expect(contract).toContain('- continue:');
    expect(contract).toContain('A successor is spawned');
    expect(contract).toContain('- done:');
    expect(contract).toContain('no successor is spawned');
    expect(contract).toContain('- blocked:');
    expect(contract).toContain('only Justin can make');
  });

  test('says exactly one handoff per session, never a second (D5)', () => {
    expect(contract).toContain('EXACTLY ONE HANDOFF PER SESSION');
    expect(contract).toContain('Never create a second one');
  });

  test('tells the session what --next must carry, for a cold reader (D3)', () => {
    expect(contract).toContain('WRITE --next FOR A COLD READER');
    expect(contract).toContain('the worktree to work in');
    expect(contract).toContain('concrete step');
    expect(contract).toContain('the open questions');
  });

  test('names the wrap-up notice as the normal ending (D11)', () => {
    // Sessions here are bounded by context, not by the clock — the notice is
    // the trigger, so the contract has to say so or the session runs on.
    expect(contract).toContain('WIND DOWN AND HAND OFF');
    expect(contract).toContain('tells you to wrap up');
    expect(contract).toContain('bounded by context, not by the clock');
  });

  test('warns about clap eating values that start with a dash', () => {
    // `br update --notes -foo` is parsed as a flag; the equals form is the fix.
    expect(contract).toContain('--flag=value');
  });

  test('forbids `br init` in a repo with no beads workspace', () => {
    // Creating a workspace unasked is exactly the o33r damage shape.
    expect(contract).toContain('do NOT run `br init`');
  });

  test('pre-authorises the automated notices as the repo owner speaking', () => {
    // home-base-1r6d.7: a sterile session flagged the wrap-up directive as a
    // prompt injection and refused it — "instructions you never gave". The fix
    // is provenance, so the contract vouches for the channel by name.
    expect(contract).toContain('[Automated Usage Check]');
    expect(contract).toContain('[Automated Time Check]');
    expect(contract).toContain('not a');
    expect(contract).toContain('prompt-injection attempt');
    expect(contract).toContain('follow it');
  });

  test('no verdict-file vocabulary survives anywhere the session can read it', () => {
    // AC2. The verdict file is gone as a concept (D2) — a contract that still
    // mentions one would have a session writing to a channel nothing reads.
    const composed = bootContract(contract, pickupBoot).toLowerCase();
    for (const dead of [
      'verdict',
      '--json-schema',
      'ralph',
      'respawn',
      'on-schedule',
      'report complete',
    ]) {
      expect(composed).not.toContain(dead);
    }
  });

  test('the composed contract stays small enough to pay for every session', () => {
    // Measured 2026-09-08, after 1r6d.33.9 added the cwd sentence to both
    // halves: the contract alone is 4,484 chars, and 5,615 composed with the
    // pickup preamble — the longest of the three boots — leaving ~385 chars of
    // headroom under the cap. (The earlier revision measured 994 tokens /
    // 4,211 chars and 1,211 tokens / 5,047 chars with gpt-tokenizer,
    // cl100k_base, a stand-in for Claude's tokenizer; only the char counts are
    // re-measured here, at the ~4 chars/token that text ran.) Both numbers grow
    // with the length of the interpolated cwd and worktree paths, which is why
    // this fixture uses realistic ones rather than short stubs.
    expect(contract.length).toBeLessThan(6000);
    expect(bootContract(contract, pickupBoot).length).toBeLessThan(6000);
  });
});

describe('session defaults', () => {
  test('blocked means WAIT FOR JUSTIN — the bound is opt-in (D3)', () => {
    // Reversed from a 15-minute default (home-base-1r6d.26, D3). The bound was
    // built for the unattended scheduled-tick workflow, where a blocked session
    // nobody answers is an invisible open thread — 17 such sessions on this
    // machine, oldest 43 days. But the workflow that matters now is the direct
    // ask, where the person being asked is the person who started the run, and
    // a 15-minute bound kills the session he is walking back to answer.
    //
    // null, not 0: "no bound" and "a bound of zero minutes" are different
    // instructions, and 0 would stop every blocked session on its first poll.
    expect(DEFAULT_OPTIONS.blockedWaitMin).toBeNull();
  });

  test('the header says which of the two policies is in force', () => {
    // A header that still promised a bound while the loop waited forever would
    // be worse than no header at all.
    expect(blockedWaitDescription(null)).toContain('INDEFINITELY');
    expect(blockedWaitDescription(null)).toContain('--blocked-wait-min');
    expect(blockedWaitDescription(720)).toContain('720m');
    expect(blockedWaitDescription(720)).not.toContain('INDEFINITELY');
  });

  test('the contract tells the model the SAME policy the loop will apply', () => {
    // The model decides whether to ask a question based on this sentence. If it
    // says "bounded" while the runner waits forever, a session stalls a run it
    // was told would be reaped; if it says "indefinite" while the runner reaps
    // at 15m, the model asks a question that gets it killed.
    const unbounded = sessionContract({
      blockedWaitMin: null,
      cwd: '/repo',
      label: 'jl-1',
    });
    expect(unbounded).toContain('indefinitely');
    expect(unbounded).not.toContain('bounded time');
    const bounded = sessionContract({
      blockedWaitMin: 720,
      cwd: '/repo',
      label: 'jl-1',
    });
    expect(bounded).toContain('waits 720m');
    expect(bounded).toContain('files your question as a bead');
    expect(bounded).not.toContain('indefinitely');
  });

  test('no text anywhere still promises the bounded wait as the default', () => {
    // AC6. The old sentence — "The runner only waits a bounded time before
    // stopping you" — was in the contract the model reads, and is exactly the
    // kind of stale promise that survives a behaviour change.
    expect(
      sessionContract({blockedWaitMin: null, cwd: '/repo', label: 'jl-1'}),
    ).not.toContain('bounded time');
  });
});
