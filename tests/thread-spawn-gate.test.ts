/**
 * The spawn gate (epic home-base-mbnjv C4, home-base-mbnjv.2): `thread spawn`
 * runs the handoff gate when componentConfig.thread.handoff.successor is on
 * in the repo it runs in, refuses with exit 3, and records the refusal on
 * the caller's session bead. Off, it is unchanged. Real br; cmux and the gate
 * are injected fakes, except where a test says it runs the real readers (and
 * then no cmux socket exists, so nothing is reached).
 */

import type {OkSample, Sample, SamplesRead} from '../src/claude-usage-samples';
import type {CmuxCall} from '../src/thread/cmux';
import type {
  HandoffGateReaders,
  HandoffGateResult,
} from '../src/thread/handoff-gate';
import type {SpawnGateOutcome} from '../src/thread/spawn-gate';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {writeGuardPass} from '../src/thread/guard-pass';
import {ensureSessionBead} from '../src/thread/session-bead';
import {spawnSession} from '../src/thread/spawn';
import {
  SPAWN_REFUSAL_INSTRUCTIONS,
  spawnGate,
  spawnUsageUnknownNote,
} from '../src/thread/spawn-gate';
import {THREAD_GUARD_HOOK_COMMAND} from '../src/thread-hooks-setup';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SID = '01d00000-1111-4222-8333-0000000000a1';
const SOCK = '/tmp/spawn-gate-test/cmux.sock';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string | null;
  env: Record<string, string | undefined>;
  repo: string;
  stateDir: string;
}

function world(input: {
  bead: boolean;
  successor: boolean | null;
  /** componentConfig.thread.handoff.usage, when a test sets it. */
  usage?: Record<string, unknown>;
}): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  // home-base-11ya7.9: spawning must be allowed here, or spawnSession refuses
  // before the gate these tests are about.
  const thread: Record<string, unknown> = {
    enabled: true,
    sessionBeads: true,
    spawn: {allowed: true},
  };
  if (input.successor != null) {
    thread.handoff = {
      successor: input.successor,
      ...(input.usage == null ? {} : {usage: input.usage}),
    };
  }
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread}}),
  );
  const stateDir = join(sb.path, 'state');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SID,
    CMUX_SOCKET_PATH: SOCK,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'spawn-gate-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  let beadId: string | null = null;
  if (input.bead) {
    const filed = ensureSessionBead({
      cwd: repo,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'start a thing'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: SID,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    beadId = filed.beadId;
  }
  return {beadId, env, repo, stateDir};
}

function stopOf(
  outcome: SpawnGateOutcome,
): Extract<SpawnGateOutcome, {kind: 'stop'}> {
  if (outcome.kind !== 'stop') {
    throw new Error(`expected a stop, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function goOf(
  outcome: SpawnGateOutcome,
): Extract<SpawnGateOutcome, {kind: 'go'}> {
  if (outcome.kind !== 'go') {
    throw new Error(`expected a go, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function beadNotes(w: World): string {
  const shown = brShow({cwd: w.repo}, w.beadId ?? '');
  if (shown.kind !== 'ok') throw new Error(shown.kind);
  return shown.issue.notes ?? '';
}

const REFUSED: HandoffGateResult = {
  detail: 'Justin turned handoffs off',
  kind: 'refused',
  message: 'unused here: it is worded for thread handoff',
  ranInSandbox: false,
  reason: 'killSwitch',
};

/** A real Claude Code screen with its input box (home-base-mbnjv.2 M1). */
const CLAUDE_UP = readFileSync(
  join(
    import.meta.dir,
    'fixtures',
    'handoff-successor',
    'claude-up-working.txt',
  ),
  'utf8',
);

/** The new workspace as `cmux tree` lists it: one pane, one tab. */
const TREE = JSON.stringify({
  windows: [
    {
      id: 'W-1',
      ref: 'window:1',
      workspaces: [
        {
          id: 'DDDDDDDD-0000-4000-8000-00000000000D',
          panes: [
            {
              id: 'P-9',
              ref: 'pane:90',
              surfaces: [
                {id: 'EEEEEEEE-0000-4000-8000-00000000000E', ref: 'surface:90'},
              ],
            },
          ],
          ref: 'workspace:9',
        },
      ],
    },
  ],
});

/**
 * A fake cmux: ping, new-workspace and the tree answer as cmux does, and
 * read-screen shows claude's input box (home-base-edf4y).
 */
function fakeCmux() {
  const calls: string[][] = [];
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    if (args.includes('tree'))
      return Promise.resolve({kind: 'ok', stdout: TREE});
    if (args[0] === 'read-screen') {
      return Promise.resolve({kind: 'ok', stdout: CLAUDE_UP});
    }
    const stdout = args[0] === 'ping' ? 'PONG\n' : 'OK workspace:9\n';
    return Promise.resolve({kind: 'ok', stdout});
  };
  return {calls, run};
}

const spawnOptions = (w: World) => ({
  cwd: w.repo,
  dir: w.repo,
  dryRun: false,
  env: w.env,
  kickoff: null,
  model: null,
  name: null,
  remoteControl: false,
});

describe('thread spawn and the handoff gate', () => {
  test('knob off: the gate is never consulted and spawn opens as before', async () => {
    const w = world({bead: true, successor: null});
    const gate = () => {
      throw new Error('the gate must not run with the knob off');
    };
    expect(await spawnGate({cwd: w.repo, env: w.env}, {gate})).toEqual({
      kind: 'go',
      usageUnknown: null,
    });
    const cmux = fakeCmux();
    const result = await spawnSession(spawnOptions(w), {run: cmux.run});
    expect(result.exitCode).toBe(0);
    expect(cmux.calls.map((args) => args[0])).toEqual([
      'ping',
      'new-workspace',
      // home-base-ys9t7.9.1 B3: the tree read that finds workspace:9's uuid.
      '--json',
      // home-base-edf4y: the new tab's lookup, then its screen.
      '--json',
      'read-screen',
    ]);
  });

  test('knob on, gate refuses: exit 3, nothing opened, recorded on the caller’s bead', async () => {
    const w = world({bead: true, successor: true});
    const cmux = fakeCmux();
    const gate = (cwd: string, env: typeof w.env) =>
      spawnGate({cwd, env}, {gate: () => Promise.resolve(REFUSED)});
    const result = await spawnSession(spawnOptions(w), {
      gate: (input) => gate(input.cwd, input.env),
      run: cmux.run,
    });
    expect(result.exitCode).toBe(3);
    expect(cmux.calls).toEqual([]);
    expect(result.lines.slice(0, 5)).toEqual([
      'thread spawn: refused by the handoff gate: killSwitch: Justin turned handoffs off',
      '',
      ...SPAWN_REFUSAL_INSTRUCTIONS,
    ]);
    expect(result.lines.at(-1)).toBe(
      `Recorded on ${w.beadId}: handoff refused: killSwitch — thread spawn: Justin turned handoffs off`,
    );
    const shown = brShow({cwd: w.repo}, w.beadId ?? '');
    if (shown.kind !== 'ok') throw new Error(shown.kind);
    expect(shown.issue.labels).toContain('handoff-refused');
    expect(shown.issue.notes).toContain(
      'handoff refused: killSwitch — thread spawn: Justin turned handoffs off',
    );
  });

  test('knob on, gate refuses, the caller has no session bead: exit 3, says it was not recorded', async () => {
    const w = world({bead: false, successor: true});
    const result = stopOf(
      await spawnGate(
        {cwd: w.repo, env: w.env},
        {gate: () => Promise.resolve(REFUSED)},
      ),
    );
    expect(result.exitCode).toBe(3);
    expect(result.lines.at(-1)).toStartWith(
      'Not recorded: the calling session has no session bead',
    );
  });

  test('knob on, gate passes: spawn goes on', async () => {
    const w = world({bead: true, successor: true});
    const pass: HandoffGateResult = {
      facts: {
        chain: {kind: 'skipped'},
        guardPassNote: null,
        liveSessions: {
          bySource: {agents: 0, hookStore: 0, ps: 1, screen: 0},
          kind: 'counted',
          sessionIds: 1,
          total: 1,
          unplaced: {background: 0, pane: 0, process: 0},
        },
        surfaceId: null,
        usage: {
          ageMinutes: 5,
          sampledAt: '2030-01-01T09:55:00.000Z',
          sessionPercent: 1,
          weekPercent: 1,
        },
        workspaceId: null,
      },
      kind: 'pass',
    };
    expect(
      await spawnGate(
        {cwd: w.repo, env: w.env},
        {gate: () => Promise.resolve(pass)},
      ),
    ).toEqual({kind: 'go', usageUnknown: null});
  });

  test('the real spawn gate does not require a cmux pane: it gets past that check', async () => {
    const w = world({bead: true, successor: true});
    // No pane, and no cmux socket anywhere: the pane check is skipped, so the
    // first refusal is cmux being unreachable, and no cmux is ever run. The
    // session guard is registered (home-base-mbnjv.5), so that check passes.
    mkdirSync(join(w.repo, '.claude'), {recursive: true});
    writeFileSync(
      join(w.repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {hooks: [{command: THREAD_GUARD_HOOK_COMMAND}], matcher: 'Bash'},
          ],
        },
      }),
    );
    const env = {...w.env, CMUX_SOCKET_PATH: undefined};
    // F14 (home-base-mbnjv.8): the guard's one-time pass for this call, as
    // the guard writes it when it allows `thread spawn`.
    const words = ['./node_modules/.bin/justin-sdk', 'thread', 'spawn'];
    writeGuardPass({
      env,
      now: new Date(),
      sessionId: SID,
      words,
    });
    const result = stopOf(
      await spawnGate({
        commandWords: words.slice(1),
        cwd: w.repo,
        env,
      }),
    );
    expect(result.exitCode).toBe(3);
    expect(result.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: cmuxUnreachable:',
    );
  });
});

// ---------------------------------------------------------------------------
// home-base-kj353: usage.onUnknown governs a spawn as it governs a handoff.
// These run the REAL spawn gate (its limits, runHandoffGate) with fake
// readers, so what the spawn gate hands the handoff gate is what is tested.
// ---------------------------------------------------------------------------

const GATE_NOW = new Date('2030-01-01T12:00:00.000Z');

function usageWindow(pct: number) {
  return {pct, resetsAt: null, resetsAtError: null, resetsText: null};
}

function okSample(input: {minutesAgo: number; week?: number}): OkSample {
  return {
    ok: true,
    raw: 'panel',
    sampledAt: new Date(
      GATE_NOW.getTime() - input.minutesAgo * 60_000,
    ).toISOString(),
    schema: 1,
    session: usageWindow(16),
    week: usageWindow(input.week ?? 60),
    weekByModel: {},
  };
}

function history(...samples: Sample[]): SamplesRead {
  return {
    kind: 'ok',
    lastLineUnreadable: false,
    path: '/fake/samples.jsonl',
    samples,
    unreadable: [],
  };
}

const FAILED_SAMPLE: Sample = {
  ok: false,
  reason: 'claude -p /usage timed out',
  sampledAt: new Date(GATE_NOW.getTime() - 10 * 60_000).toISOString(),
  schema: 1,
};

/** The spawn set of readers (no chain, no launch record), all passing. */
function spawnReaders(usage: HandoffGateReaders['usage']): HandoffGateReaders {
  return {
    callerScreen: () => {
      throw new Error('a spawn never reads its caller’s screen');
    },
    chain: null,
    guard: () => ({kind: 'registered', where: ['/fake/.claude/settings.json']}),
    guardPass: () => ({kind: 'valid', path: '/fake/guard-pass/x.json'}),
    killSwitch: () => ({kind: 'off', path: '/fake/handoff-off'}),
    launchRecord: null,
    liveSessions: () => ({
      bySource: {agents: 0, hookStore: 0, ps: 3, screen: 0},
      kind: 'counted',
      sessionIds: 3,
      total: 3,
      unplaced: {background: 0, pane: 0, process: 0},
    }),
    pingCmux: () => ({kind: 'ok'}),
    usage,
  };
}

/** The four causes of an unknown reading the bead names, and what each says. */
const UNKNOWN_CAUSES: [string, HandoffGateReaders['usage'], string][] = [
  [
    'a failed newest sample (the 2026-11-18 refusal)',
    () => history(okSample({minutesAgo: 70}), FAILED_SAMPLE),
    'is a failed read',
  ],
  [
    'a sample older than maxSampleAgeMinutes',
    () => history(okSample({minutesAgo: 433})),
    'is 433 minutes old',
  ],
  [
    'no usage history',
    () => ({kind: 'missing', path: '/fake/samples.jsonl'}),
    'there is no usage history',
  ],
  [
    'an unreadable usage history',
    () => ({kind: 'failed', path: '/fake/samples.jsonl', reason: 'EACCES'}),
    'EACCES',
  ],
];

const LET_THROUGH =
  '⚠️ unknown; the usage check let the spawn go on (usage.onUnknown is allow): ';

describe('usage.onUnknown reaches thread spawn (home-base-kj353)', () => {
  for (const [name, usage, detail] of UNKNOWN_CAUSES) {
    test(`allow (the default) lets ${name} through, and notes it on the caller’s bead`, async () => {
      const w = world({bead: true, successor: true});
      const outcome = goOf(
        await spawnGate(
          {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
          {readers: () => spawnReaders(usage)},
        ),
      );
      expect(outcome.usageUnknown?.detail).toContain(detail);
      expect(outcome.usageUnknown?.noted).toEqual({
        beadId: w.beadId ?? '?',
        kind: 'noted',
      });
      expect(beadNotes(w)).toContain(
        spawnUsageUnknownNote(outcome.usageUnknown?.detail ?? '?'),
      );
    });
  }

  test('the Usage line is on every outcome after the gate: opened, cmux refused, cmux unconfirmed, workspace unconfirmed', async () => {
    const w = world({bead: true, successor: true});
    const [, usage, detail] = UNKNOWN_CAUSES[0] ?? [];
    if (usage == null || detail == null) throw new Error('no cause');
    const gate = (input: {cwd: string; env: typeof w.env}) =>
      spawnGate(
        {commandWords: [], cwd: input.cwd, env: input.env, now: GATE_NOW},
        {readers: () => spawnReaders(usage)},
      );
    const opened = fakeCmux();
    const cmuxes: [string, (args: readonly string[]) => Promise<CmuxCall>][] = [
      ['opened', opened.run],
      [
        'cmux cannot be reached',
        (args) =>
          args[0] === 'ping'
            ? Promise.resolve({
                kind: 'failed',
                reason: 'no socket',
                timedOut: false,
              })
            : opened.run(args),
      ],
      [
        'cmux did not confirm a new workspace',
        (args) =>
          args[0] === 'new-workspace'
            ? Promise.resolve({kind: 'ok', stdout: 'ERROR nope\n'})
            : opened.run(args),
      ],
      [
        'a workspace WAS opened',
        (args) =>
          args.includes('tree')
            ? Promise.resolve({
                kind: 'failed',
                reason: 'tree unreadable',
                timedOut: false,
              })
            : opened.run(args),
      ],
    ];
    const exits: Record<string, number> = {};
    for (const [outcome, run] of cmuxes) {
      const result = await spawnSession(spawnOptions(w), {gate, run});
      exits[outcome] = result.exitCode;
      const text = result.lines.join('\n');
      if (outcome !== 'opened') expect(text).toContain(outcome);
      expect(text).toContain(LET_THROUGH);
      expect(text).toContain(detail);
    }
    expect(exits).toEqual({
      'a workspace WAS opened': 1,
      'cmux cannot be reached': 2,
      'cmux did not confirm a new workspace': 1,
      opened: 0,
    });
  });

  test('a known reading prints no Usage line and writes no note', async () => {
    const w = world({bead: true, successor: true});
    const before = beadNotes(w);
    const gate = (input: {cwd: string; env: typeof w.env}) =>
      spawnGate(
        {commandWords: [], cwd: input.cwd, env: input.env, now: GATE_NOW},
        {
          readers: () =>
            spawnReaders(() => history(okSample({minutesAgo: 30}))),
        },
      );
    const result = await spawnSession(spawnOptions(w), {
      gate,
      run: fakeCmux().run,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).not.toContain('Usage');
    expect(beadNotes(w)).toBe(before);
  });

  test('a caller with no session bead: the output says the note was not recorded, and why', async () => {
    const w = world({bead: false, successor: true});
    const [, usage] = UNKNOWN_CAUSES[0] ?? [];
    if (usage == null) throw new Error('no cause');
    const result = await spawnSession(spawnOptions(w), {
      gate: (input) =>
        spawnGate(
          {commandWords: [], cwd: input.cwd, env: input.env, now: GATE_NOW},
          {readers: () => spawnReaders(usage)},
        ),
      run: fakeCmux().run,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      '(not noted: the calling session has no session bead (',
    );
  });

  test('a note that cannot be written: the output says so, with br’s reason', async () => {
    const w = world({bead: true, successor: true});
    const [, usage] = UNKNOWN_CAUSES[0] ?? [];
    if (usage == null) throw new Error('no cause');
    const outcome = goOf(
      await spawnGate(
        {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
        {
          appendNote: (input) => ({
            kind: 'failed',
            reason: `${input.beadId} was not updated: database is locked`,
          }),
          readers: () => spawnReaders(usage),
        },
      ),
    );
    expect(outcome.usageUnknown?.noted).toEqual({
      kind: 'notNoted',
      reason: `${w.beadId ?? '?'} was not updated: database is locked`,
    });
  });

  test('a fresh reading over a ceiling still refuses: usageHigh, exit 3', async () => {
    const w = world({bead: true, successor: true});
    const result = stopOf(
      await spawnGate(
        {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
        {
          readers: () =>
            spawnReaders(() => history(okSample({minutesAgo: 30, week: 95}))),
        },
      ),
    );
    expect(result.exitCode).toBe(3);
    expect(result.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: usageHigh: the week window is at 95 % (ceiling 90 %)',
    );
  });

  test('a stale reading whose week was over its ceiling and has not reset still refuses: usageHigh, exit 3', async () => {
    const w = world({bead: true, successor: true});
    const result = stopOf(
      await spawnGate(
        {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
        {
          readers: () =>
            spawnReaders(() => history(okSample({minutesAgo: 433, week: 95}))),
        },
      ),
    );
    expect(result.exitCode).toBe(3);
    expect(result.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: usageHigh: the week window was at 95 % (ceiling 90 %)',
    );
    expect(result.lines[0]).toContain('the current reading is unknown');
  });

  test('usage.onUnknown refuse: an unknown reading refuses with usageUnknown, as before', async () => {
    const w = world({
      bead: true,
      successor: true,
      usage: {onUnknown: 'refuse'},
    });
    const [, usage, detail] = UNKNOWN_CAUSES[0] ?? [];
    if (usage == null || detail == null) throw new Error('no cause');
    const result = stopOf(
      await spawnGate(
        {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
        {readers: () => spawnReaders(usage)},
      ),
    );
    expect(result.exitCode).toBe(3);
    expect(result.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: usageUnknown:',
    );
    expect(result.lines[0]).toContain(detail);
    expect(beadNotes(w)).not.toContain('usage unknown at spawn');
  });

  test('with the pacing hold on, an unknown reading still refuses as paceUnknown', async () => {
    const w = world({bead: true, successor: true, usage: {paceHold: true}});
    const [, usage] = UNKNOWN_CAUSES[0] ?? [];
    if (usage == null) throw new Error('no cause');
    const result = stopOf(
      await spawnGate(
        {commandWords: [], cwd: w.repo, env: w.env, now: GATE_NOW},
        {readers: () => spawnReaders(usage)},
      ),
    );
    expect(result.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: paceUnknown:',
    );
  });
});

// runHandoffGate's requireCmuxPane itself is tested in
// thread-handoff-gate.test.ts, beside the gate's other checks.
