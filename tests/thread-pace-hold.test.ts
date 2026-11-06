/**
 * The pacing hold at the handoff and spawn gates (home-base-jm5kg.17): off, the
 * gate's result does not change in any way; on, it refuses at hold level with
 * the numbers, and refuses when the pace is unknown. The week ceiling stays
 * first and refuses at 91 % either way (the bead's anti-decision).
 */

import type {OkSample, SamplesRead} from '../src/claude-usage-samples';
import type {
  HandoffGateLimits,
  HandoffGateReaders,
  HandoffGateResult,
} from '../src/thread/handoff-gate';
import type {LiveSessionCountRead} from '../src/thread/live-count';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {resolveThreadConfig} from '../src/thread/config';
import {
  checkPaceHold,
  HANDOFF_REFUSAL_REASONS,
  runHandoffGate,
} from '../src/thread/handoff-gate';
import {WEEK_WINDOW_MS} from '../src/thread/pacing';
import {spawnGate} from '../src/thread/spawn-gate';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const NOW = new Date('2030-01-01T12:00:00.000Z');
const SAMPLED_MS = NOW.getTime() - 30 * 60_000;
const SCREEN_SESSION = 'aa693548-b000-4b39-8cf4-90a380854827';
const IDLE_SCREEN = readFileSync(
  join(import.meta.dir, 'fixtures/handoff-predecessor/idle-claude.txt'),
  'utf8',
);
const PANE_ENV = {
  CLAUDE_CODE_SESSION_ID: SCREEN_SESSION,
  CMUX_SURFACE_ID: 'SURF0000-1111-4222-8333-0000000000c3',
  CMUX_WORKSPACE_ID: 'AAAA0000-1111-4222-8333-0000000000b2',
};
const COUNTED: LiveSessionCountRead = {
  bySource: {agents: 1, hookStore: 0, ps: 16, screen: 0},
  kind: 'counted',
  sessionIds: 17,
  total: 17,
  unplaced: {background: 0, pane: 0, process: 0},
};

/** A sample read half an hour ago, `elapsed` % of the way through its week. */
function paced(input: {
  elapsed?: number;
  resetsAt?: string | null;
  week: number;
}): OkSample {
  const resetsAt =
    input.resetsAt === undefined
      ? new Date(
          SAMPLED_MS + WEEK_WINDOW_MS * (1 - (input.elapsed ?? 50) / 100),
        ).toISOString()
      : input.resetsAt;
  return {
    ok: true,
    raw: 'panel',
    sampledAt: new Date(SAMPLED_MS).toISOString(),
    schema: 1,
    session: null,
    week: {
      pct: input.week,
      resetsAt,
      resetsAtError: resetsAt == null ? 'fixture: no reset' : null,
      resetsText: null,
    },
    weekByModel: {},
  };
}

function history(sample: OkSample): SamplesRead {
  return {
    kind: 'ok',
    lastLineUnreadable: false,
    path: '/fake/samples.jsonl',
    samples: [sample],
    unreadable: [],
  };
}

function readersFor(sample: OkSample): HandoffGateReaders {
  return {
    callerScreen: () => ({kind: 'read', text: IDLE_SCREEN}),
    chain: () => ({kind: 'counted', links: [], unattendedHandoffs: 1}),
    guard: () => ({kind: 'registered', where: ['/fake/.claude/settings.json']}),
    guardPass: () => ({kind: 'valid', path: '/fake/guard-pass/x.json'}),
    killSwitch: () => ({kind: 'off', path: '/fake/handoff-off'}),
    launchRecord: () => ({kind: 'none'}),
    liveSessions: () => COUNTED,
    pingCmux: () => ({kind: 'ok'}),
    usage: () => history(sample),
  };
}

function limits(usage: {
  check?: boolean;
  paceHold?: boolean;
}): HandoffGateLimits {
  return {
    maxLiveSessions: 20,
    maxUnattendedHandoffs: 3,
    usage: {
      maxSampleAgeMinutes: 150,
      maxSessionPercent: 85,
      maxWeekPercent: 90,
      ...usage,
    },
  };
}

async function gate(
  sample: OkSample,
  usage: {check?: boolean; paceHold?: boolean},
): Promise<HandoffGateResult> {
  return await runHandoffGate({
    env: PANE_ENV,
    limits: limits(usage),
    now: NOW,
    readers: readersFor(sample),
  });
}

function refusal(result: HandoffGateResult): {detail: string; reason: string} {
  if (result.kind !== 'refused') throw new Error(`gate said ${result.kind}`);
  return {detail: result.detail, reason: result.reason};
}

/** 80 % used half way through the week: 30 points ahead, hold level. */
const HOLD_LEVEL = paced({elapsed: 50, week: 80});

describe('the knob off', () => {
  test.each<{name: string; usage: {paceHold?: boolean}}>([
    {name: 'absent', usage: {}},
    {name: 'false', usage: {paceHold: false}},
  ])('$name: hold level passes, with the same result', async ({usage}) => {
    const result = await gate(HOLD_LEVEL, usage);
    expect(result.kind).toBe('pass');
    if (result.kind !== 'pass') return;
    expect(result.facts.usage).toEqual({
      ageMinutes: 30,
      sampledAt: HOLD_LEVEL.sampledAt,
      sessionPercent: null,
      weekPercent: 80,
    });
  });

  test('an unknown pace passes too: nothing about the pace is even read', async () => {
    const noReset = paced({resetsAt: null, week: 80});
    expect((await gate(noReset, {paceHold: false})).kind).toBe('pass');
  });
});

describe('the knob on', () => {
  test('hold level refuses, with the numbers in the detail', async () => {
    const {detail, reason} = refusal(await gate(HOLD_LEVEL, {paceHold: true}));
    expect(reason).toBe('paceHold');
    expect(detail).toContain('the week is at 80 %');
    expect(detail).toContain('50.0 % of it elapsed');
    expect(detail).toContain('30.0 points ahead of an even pace');
    expect(detail).toContain('hold above 25');
    expect(detail).toContain(HOLD_LEVEL.sampledAt);
    expect(detail).toContain(HOLD_LEVEL.week.resetsAt ?? 'no reset');
  });

  test('the refusal message is the gate’s usual one, final', async () => {
    const result = await gate(HOLD_LEVEL, {paceHold: true});
    if (result.kind !== 'refused') throw new Error(result.kind);
    expect(result.message.split('\n')[0]).toBe(
      `handoff refused: paceHold: ${result.detail}`,
    );
    expect(result.message).toContain('This refusal is final');
  });

  test.each([
    {level: 'even', week: 50},
    {level: 'ok, at the warn margin', week: 60},
    {level: 'warn', week: 61},
    {level: 'warn, at the hold margin', week: 75},
  ])(
    '$level ($week used, half way through the week) passes',
    async ({week}) => {
      expect((await gate(paced({week}), {paceHold: true})).kind).toBe('pass');
    },
  );

  test('just over the hold margin refuses', async () => {
    expect(
      refusal(await gate(paced({week: 76}), {paceHold: true})).reason,
    ).toBe('paceHold');
  });

  test('a missing reset refuses: unknown never passes', async () => {
    const {detail, reason} = refusal(
      await gate(paced({resetsAt: null, week: 40}), {paceHold: true}),
    );
    expect(reason).toBe('paceUnknown');
    expect(detail).toContain('fixture: no reset');
  });

  test('a week that has since reset refuses as unknown, not as a verdict', async () => {
    const passed = new Date(SAMPLED_MS + 60_000).toISOString();
    const {detail, reason} = refusal(
      await gate(paced({resetsAt: passed, week: 75}), {paceHold: true}),
    );
    expect(reason).toBe('paceUnknown');
    expect(detail).toContain('no reading of the new week yet');
  });

  test('`usage.check: false` skips it: no sample is read', async () => {
    const result = await gate(HOLD_LEVEL, {check: false, paceHold: true});
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.facts.usage).toHaveProperty('skipped');
    }
  });
});

describe('the week ceiling stays (the bead’s anti-decision)', () => {
  // 91 % at 95 % elapsed is behind an even pace: only the ceiling can refuse it.
  const OVER_CEILING = paced({elapsed: 95, week: 91});

  test('91 % refuses with the knob off', async () => {
    const {detail, reason} = refusal(await gate(OVER_CEILING, {}));
    expect(reason).toBe('usageHigh');
    expect(detail).toContain('the week window is at 91 % (ceiling 90 %)');
  });

  test('91 % refuses with the knob on, on the ceiling and not the pace', async () => {
    const {reason} = refusal(await gate(OVER_CEILING, {paceHold: true}));
    expect(reason).toBe('usageHigh');
  });

  test('over both limits, the ceiling answers first', async () => {
    const {reason} = refusal(
      await gate(paced({elapsed: 20, week: 91}), {paceHold: true}),
    );
    expect(reason).toBe('usageHigh');
  });

  test('90 % at 95 % elapsed passes with the knob off: at the ceiling is not over it', async () => {
    expect((await gate(paced({elapsed: 95, week: 90}), {})).kind).toBe('pass');
  });

  test('a stale read still refuses as usageUnknown before the pace is asked', async () => {
    const stale = {
      ...paced({week: 40}),
      sampledAt: new Date(NOW.getTime() - 151 * 60_000).toISOString(),
    };
    expect(refusal(await gate(stale, {paceHold: true})).reason).toBe(
      'usageUnknown',
    );
  });

  test('the new reasons sit after the ceiling’s, in the order the gate checks', () => {
    const at = (reason: (typeof HANDOFF_REFUSAL_REASONS)[number]) =>
      HANDOFF_REFUSAL_REASONS.indexOf(reason);
    expect(at('usageHigh')).toBeLessThan(at('paceUnknown'));
    expect(at('paceUnknown')).toBeLessThan(at('paceHold'));
    expect(at('paceHold')).toBeLessThan(at('chainUnknown'));
  });
});

describe('checkPaceHold', () => {
  test('null at warn level: only hold refuses', () => {
    expect(
      checkPaceHold(
        history(paced({week: 70})),
        {maxSampleAgeMinutes: 150},
        NOW,
      ),
    ).toBeNull();
  });

  test('the gate’s own age limit decides what is stale', () => {
    const hold = checkPaceHold(
      history(paced({week: 40})),
      {maxSampleAgeMinutes: 10},
      NOW,
    );
    expect(hold?.reason).toBe('paceUnknown');
    expect(hold?.detail).toContain('older than the 10-minute limit');
  });
});

function configWorld(usage: Record<string, unknown> | null): {
  cwd: string;
  env: Record<string, string>;
} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const cwd = join(sb.path, 'repo');
  mkdirSync(cwd, {recursive: true});
  const handoff = usage == null ? {successor: true} : {successor: true, usage};
  sb.writeFile(
    'repo/justin-sdk.config.json',
    JSON.stringify({
      componentConfig: {thread: {handoff}},
      components: ['base-setup'],
    }),
  );
  return {cwd, env: {XDG_CONFIG_HOME: join(sb.path, 'config')}};
}

describe('the knob reaches the gate from the config, and on to `thread spawn`', () => {
  function spawnWith(
    world: {cwd: string; env: Record<string, string>},
    sample: OkSample,
  ) {
    return spawnGate(
      {commandWords: [], cwd: world.cwd, env: world.env, now: NOW},
      {
        gate: (input) =>
          runHandoffGate({
            env: input.env,
            limits: input.limits,
            now: input.now,
            readers: {...readersFor(sample), chain: null, launchRecord: null},
            requireCmuxPane: false,
          }),
      },
    );
  }

  test('on in the project config: a spawn exits 3, and prints the numbers', async () => {
    const result = await spawnWith(configWorld({paceHold: true}), HOLD_LEVEL);
    expect(result?.exitCode).toBe(3);
    const text = (result?.lines ?? []).join('\n');
    expect(text).toContain('refused by the handoff gate: paceHold');
    expect(text).toContain('30.0 points ahead of an even pace');
    expect(text).toContain('do not retry the spawn');
  });

  test('not mentioned in the config: the same spawn goes on', async () => {
    expect(await spawnWith(configWorld(null), HOLD_LEVEL)).toBeNull();
  });

  test('home-base’s own config leaves the hold off', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const {paceHold, paceHoldSource} = resolveThreadConfig({
      cwd: join(import.meta.dir, '..', '..', '..'),
      env: {XDG_CONFIG_HOME: join(sb.path, 'nothing-here')},
    }).handoff.usage;
    expect(paceHold).toBe(false);
    expect(paceHoldSource).toBe('default');
  });
});
