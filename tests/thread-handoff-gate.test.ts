/**
 * The handoff gate (epic home-base-mbnjv D2, built by home-base-mbnjv.1): one
 * test per refusal reason, a pass, the order, the kill switch file, the live
 * count, and recordRefusal against real br. Every reader is a fake except in
 * the kill-switch and recordRefusal tests, which use $TMPDIR worlds; nothing
 * reaches cmux, ps or claude.
 */

import type {OkSample, Sample, SamplesRead} from '../src/claude-usage-samples';
import type {UnattendedChain} from '../src/thread/handoff-chain';
import type {LiveSessionCountRead} from '../src/thread/live-count';
import type {LiveSessions} from '../src/thread/live-sessions';
import type {QuotaGateRead} from '../src/thread/quota-gate';
import type {QuotaVerdict} from '../src/thread/quota-verdict';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {readSamples} from '../src/claude-usage-samples';
import {
  consumeGuardPass,
  guardPassPath,
  writeGuardPass,
} from '../src/thread/guard-pass';
import {
  HANDOFF_REFUSAL_INSTRUCTIONS,
  HANDOFF_REFUSAL_REASONS,
  type HandoffGateReaders,
  type HandoffGateResult,
  type HandoffRefusalReason,
  isSandboxDenial,
  readKillSwitch,
  recordRefusal,
  runHandoffGate,
  runQuotaCheck,
} from '../src/thread/handoff-gate';
import {countLiveSessions} from '../src/thread/live-count';
import {ensureSessionBead} from '../src/thread/session-bead';
import {spawnGate} from '../src/thread/spawn-gate';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const NOW = new Date('2030-01-01T12:00:00.000Z');
/** The session idle-claude.txt's status line shows (`⌗ aa693548-…`). */
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
const LIMITS = {
  maxLiveSessions: 20,
  maxUnattendedHandoffs: 3,
  usage: {maxSampleAgeMinutes: 150, maxSessionPercent: 85, maxWeekPercent: 90},
};

function window(pct: number) {
  return {pct, resetsAt: null, resetsAtError: null, resetsText: null};
}

function okSample(input: {
  minutesAgo: number;
  session?: number;
  week?: number;
}): OkSample {
  return {
    ok: true,
    raw: 'panel',
    sampledAt: new Date(
      NOW.getTime() - input.minutesAgo * 60_000,
    ).toISOString(),
    schema: 1,
    session: window(input.session ?? 16),
    week: window(input.week ?? 60),
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

const COUNTED: LiveSessionCountRead = {
  bySource: {agents: 1, hookStore: 0, ps: 16, screen: 0},
  kind: 'counted',
  sessionIds: 17,
  total: 17,
  unplaced: {background: 0, pane: 0, process: 0},
};

function chainOf(
  unattendedHandoffs: number,
): Extract<UnattendedChain, {kind: 'counted'}> {
  return {kind: 'counted', links: [], unattendedHandoffs};
}

/** Readers that all pass; each test breaks one. */
function passingReaders(
  overrides: Partial<HandoffGateReaders> = {},
): HandoffGateReaders {
  return {
    callerScreen: () => ({kind: 'read', text: IDLE_SCREEN}),
    chain: () => chainOf(1),
    guard: () => ({kind: 'registered', where: ['/fake/.claude/settings.json']}),
    guardPass: () => ({kind: 'valid', path: '/fake/guard-pass/x.json'}),
    killSwitch: () => ({kind: 'off', path: '/fake/handoff-off'}),
    launchRecord: () => ({kind: 'none'}),
    liveSessions: () => COUNTED,
    pingCmux: () => ({kind: 'ok'}),
    usage: () => history(okSample({minutesAgo: 30})),
    ...overrides,
  };
}

async function gate(
  overrides: Partial<HandoffGateReaders> = {},
  env: Record<string, string | undefined> = PANE_ENV,
): Promise<HandoffGateResult> {
  return await runHandoffGate({
    env,
    limits: LIMITS,
    now: NOW,
    readers: passingReaders(overrides),
  });
}

/** Refused with `reason`, and the message carries the final instructions. */
function expectRefused(
  result: HandoffGateResult,
  reason: HandoffRefusalReason,
  detailPart: string,
): void {
  expect(result.kind).toBe('refused');
  if (result.kind !== 'refused') return;
  expect(result.reason).toBe(reason);
  expect(result.detail).toContain(detailPart);
  const lines = result.message.split('\n');
  expect(lines[0]).toBe(`handoff refused: ${reason}: ${result.detail}`);
  for (const instruction of HANDOFF_REFUSAL_INSTRUCTIONS) {
    expect(lines).toContain(instruction);
  }
}

describe('the final-refusal message', () => {
  test('says no successor started, final, finish the report with the block, never another way', () => {
    const text = HANDOFF_REFUSAL_INSTRUCTIONS.join('\n');
    expect(text).toContain('No successor was started.');
    expect(text).toContain('This refusal is final');
    expect(text).toContain(
      'Finish your final report, include the handoff block printed above for Justin, and stop.',
    );
    expect(text).toContain('no cmux command, no claude command');
  });
});

describe('runHandoffGate', () => {
  test('passes when every check passes, and reports what it measured', async () => {
    const result = await gate();
    expect(result.kind).toBe('pass');
    if (result.kind !== 'pass') return;
    expect(result.facts.usage.sessionPercent).toBe(16);
    expect(result.facts.usage.ageMinutes).toBe(30);
    expect(result.facts.liveSessions.total).toBe(17);
    expect(result.facts.chain).toEqual(chainOf(1));
    expect(result.facts.surfaceId).toBe(PANE_ENV.CMUX_SURFACE_ID);
  });

  test('requireCmuxPane false (the spawn gate, mbnjv.2): no pane passes, and the facts say null, not ""', async () => {
    const result = await runHandoffGate({
      env: {},
      limits: LIMITS,
      now: NOW,
      readers: passingReaders({chain: null}),
      requireCmuxPane: false,
    });
    expect(result.kind).toBe('pass');
    if (result.kind !== 'pass') return;
    expect(result.facts.surfaceId).toBeNull();
    expect(result.facts.workspaceId).toBeNull();
    expect(result.facts.chain).toEqual({kind: 'skipped'});
  });

  test('requireCmuxPane false still runs every other check', async () => {
    const result = await runHandoffGate({
      env: {},
      limits: LIMITS,
      now: NOW,
      readers: passingReaders({
        chain: null,
        pingCmux: () => ({kind: 'failed', reason: 'socket refused'}),
      }),
      requireCmuxPane: false,
    });
    expectRefused(result, 'cmuxUnreachable', 'socket refused');
  });

  test('killSwitch: the file is present', async () => {
    const result = await gate({
      killSwitch: () => ({
        kind: 'on',
        path: '/fake/handoff-off',
        reason: 'Justin is away until Monday',
      }),
    });
    expectRefused(result, 'killSwitch', 'Justin is away until Monday');
  });

  test('notInCmuxPane: no CMUX_SURFACE_ID', async () => {
    const result = await gate(
      {},
      {CMUX_WORKSPACE_ID: PANE_ENV.CMUX_WORKSPACE_ID},
    );
    expectRefused(result, 'notInCmuxPane', 'CMUX_SURFACE_ID is not set');
  });

  test('notInCmuxPane: neither id', async () => {
    const result = await gate({}, {});
    expectRefused(
      result,
      'notInCmuxPane',
      'CMUX_WORKSPACE_ID and CMUX_SURFACE_ID are not set',
    );
  });

  test('cmuxUnreachable: the ping fails', async () => {
    const result = await gate({
      pingCmux: () => ({kind: 'failed', reason: 'connect ENOENT /x.sock'}),
    });
    expectRefused(result, 'cmuxUnreachable', 'connect ENOENT /x.sock');
    // Not the sandbox: the gate's own refusal, exit 3 in thread handoff.
    expect(result.kind === 'refused' && result.ranInSandbox).toBe(false);
  });

  test('cmuxUnreachable: Operation not permitted means the CALL ran inside the sandbox (mbnjv.9 AC4)', async () => {
    // The text measured in live run 20261029T154357Z.
    const eperm =
      'cmux ping failed: Error: Failed to connect to socket at /Users/x/.local/state/cmux/cmux.sock (Operation not permitted, errno 1)';
    const result = await gate({
      pingCmux: () => ({kind: 'failed', reason: eperm}),
    });
    expectRefused(result, 'cmuxUnreachable', eperm);
    expect(result.kind === 'refused' && result.ranInSandbox).toBe(true);
    expect(result.kind === 'refused' ? result.detail : '').toContain(
      'this call ran inside the Claude Code sandbox',
    );
    expect(isSandboxDenial(eperm)).toBe(true);
    expect(isSandboxDenial('connect ENOENT /x.sock')).toBe(false);
    expect(isSandboxDenial('connect ECONNREFUSED /x.sock')).toBe(false);
  });

  test('usageUnknown: no samples file', async () => {
    const result = await gate({
      usage: () => ({kind: 'missing', path: '/fake/samples.jsonl'}),
    });
    expectRefused(result, 'usageUnknown', 'there is no usage history');
  });

  test('usageUnknown: the newest sample is a failed read', async () => {
    const failed: Sample = {
      ok: false,
      reason: 'claude -p /usage timed out',
      sampledAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      schema: 1,
    };
    const result = await gate({
      usage: () => history(okSample({minutesAgo: 70}), failed),
    });
    expectRefused(result, 'usageUnknown', 'is a failed read');
  });

  test('usageUnknown: the newest sample is older than maxSampleAgeMinutes', async () => {
    const result = await gate({
      usage: () => history(okSample({minutesAgo: 151})),
    });
    expectRefused(
      result,
      'usageUnknown',
      'is 151 minutes old (2030-01-01T09:29:00.000Z), older than the 150-minute limit',
    );
  });

  test('usageUnknown: the history cannot be read, or holds no sample', async () => {
    expectRefused(
      await gate({
        usage: () => ({
          kind: 'failed',
          path: '/fake/samples.jsonl',
          reason: 'EACCES',
        }),
      }),
      'usageUnknown',
      'EACCES',
    );
    expectRefused(
      await gate({usage: () => history()}),
      'usageUnknown',
      'holds no readable sample',
    );
  });

  test('usageHigh: the session window is over its ceiling', async () => {
    const result = await gate({
      usage: () => history(okSample({minutesAgo: 5, session: 86})),
    });
    expectRefused(
      result,
      'usageHigh',
      'the 5-hour session window is at 86 % (ceiling 85 %)',
    );
  });

  test('usageHigh: the week window is over its ceiling; at the ceiling passes', async () => {
    expectRefused(
      await gate({
        usage: () => history(okSample({minutesAgo: 5, week: 91})),
      }),
      'usageHigh',
      'the week window is at 91 % (ceiling 90 %)',
    );
    const atCeiling = await gate({
      usage: () => history(okSample({minutesAgo: 5, session: 85, week: 90})),
    });
    expect(atCeiling.kind).toBe('pass');
  });

  test('chainUnknown: the walk could not read the chain', async () => {
    const result = await gate({
      chain: () => ({
        kind: 'unknown',
        links: [],
        reason: 'the message log of t-2 could not be read',
      }),
    });
    expectRefused(
      result,
      'chainUnknown',
      'the message log of t-2 could not be read',
    );
  });

  test('tooManyUnattendedHandoffs: the count reached the limit', async () => {
    const result = await gate({chain: () => chainOf(3)});
    expectRefused(
      result,
      'tooManyUnattendedHandoffs',
      '3 handoffs in a row since Justin last typed',
    );
    const below = await gate({chain: () => chainOf(2)});
    expect(below.kind).toBe('pass');
  });

  test('liveSessionsUnknown: the count failed', async () => {
    const result = await gate({
      liveSessions: () => ({kind: 'failed', reason: 'ps failed: EPERM'}),
    });
    expectRefused(result, 'liveSessionsUnknown', 'ps failed: EPERM');
  });

  test('tooManyLiveSessions: the successor would exceed the limit', async () => {
    const result = await gate({
      liveSessions: () => ({...COUNTED, sessionIds: 20, total: 20}),
    });
    expectRefused(
      result,
      'tooManyLiveSessions',
      'the successor would make 21, and the limit is 20',
    );
    const below = await gate({
      liveSessions: () => ({...COUNTED, sessionIds: 19, total: 19}),
    });
    expect(below.kind).toBe('pass');
  });

  test('a reader that throws refuses with its own reason, never passes', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    expectRefused(await gate({killSwitch: boom}), 'killSwitch', 'boom');
    expectRefused(await gate({pingCmux: boom}), 'cmuxUnreachable', 'boom');
    expectRefused(await gate({usage: boom}), 'usageUnknown', 'boom');
    expectRefused(await gate({chain: boom}), 'chainUnknown', 'boom');
    expectRefused(
      await gate({liveSessions: boom}),
      'liveSessionsUnknown',
      'boom',
    );
  });

  test('checks run in the documented order: the kill switch wins over everything', async () => {
    const result = await gate(
      {
        chain: () => ({kind: 'unknown', links: [], reason: 'x'}),
        killSwitch: () => ({kind: 'on', path: '/x', reason: 'off for now'}),
        liveSessions: () => ({kind: 'failed', reason: 'x'}),
        pingCmux: () => ({kind: 'failed', reason: 'x'}),
        usage: () => ({kind: 'missing', path: '/x'}),
      },
      {},
    );
    expect(result.kind === 'refused' && result.reason).toBe('killSwitch');
    // `subagent` comes first in the list but is the guard's, never the gate's.
    expect(HANDOFF_REFUSAL_REASONS[0]).toBe('subagent');
    expect(HANDOFF_REFUSAL_REASONS[1]).toBe('killSwitch');
  });

  test('chain null (the spawn gate, C4) skips the chain and passes', async () => {
    const result = await gate({chain: null});
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.facts.chain).toEqual({kind: 'skipped'});
    }
  });
});

describe('fix round 2 (home-base-mbnjv.8): F2, F20, F11, F14, F16', () => {
  test('F2: the week is under its ceiling but one model window is over it: usageHigh, naming the model', async () => {
    const sample: OkSample = {
      ...okSample({minutesAgo: 30, week: 60}),
      weekByModel: {opus: window(40), sonnet: window(97)},
    };
    const result = await gate({usage: () => history(sample)});
    expectRefused(
      result,
      'usageHigh',
      'the sonnet week window is at 97 % (ceiling 90 %)',
    );
    if (result.kind === 'refused') expect(result.detail).not.toContain('opus');
    const atCeiling: OkSample = {
      ...okSample({minutesAgo: 30}),
      weekByModel: {sonnet: window(90)},
    };
    expect((await gate({usage: () => history(atCeiling)})).kind).toBe('pass');
  });

  test('F20: an unreadable LAST line refuses (usageUnknown), never an older sample in its place', async () => {
    const read: SamplesRead = {
      kind: 'ok',
      lastLineUnreadable: true,
      path: '/fake/samples.jsonl',
      samples: [okSample({minutesAgo: 30})],
      unreadable: [{line: 7, reason: 'not JSON: Unexpected end'}],
    };
    expectRefused(
      await gate({usage: () => read}),
      'usageUnknown',
      'the newest line of the usage history (/fake/samples.jsonl line 7) could not be read: not JSON: Unexpected end',
    );
  });

  test('F20: readSamples flags an unreadable last line, and not an unreadable middle one', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const good = JSON.stringify(okSample({minutesAgo: 10}));
    const lastBad = join(sb.path, 'last-bad.jsonl');
    writeFileSync(lastBad, `${good}\n{"half":\n`);
    const middleBad = join(sb.path, 'middle-bad.jsonl');
    writeFileSync(middleBad, `{"half":\n${good}\n`);
    const a = readSamples(lastBad);
    const b = readSamples(middleBad);
    expect(a.kind === 'ok' && a.lastLineUnreadable).toBe(true);
    expect(b.kind === 'ok' && b.lastLineUnreadable).toBe(false);
  });

  test('F16: the caller tab shows this session: passes', async () => {
    expect((await gate()).kind).toBe('pass');
  });

  test('F16: the caller tab shows ANOTHER session (inherited CMUX ids): notInCmuxPane naming both', async () => {
    expectRefused(
      await gate(
        {},
        {
          ...PANE_ENV,
          CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-0000-4000-8000-000000000001',
        },
      ),
      'notInCmuxPane',
      `tab ${PANE_ENV.CMUX_SURFACE_ID} (CMUX_SURFACE_ID) shows session ${SCREEN_SESSION}, not this session bbbbbbbb-0000-4000-8000-000000000001`,
    );
  });

  test('F16: an unreadable screen, or one with no status-line id, refuses', async () => {
    expectRefused(
      await gate({
        callerScreen: () => ({kind: 'unreadable', reason: 'no such surface'}),
      }),
      'notInCmuxPane',
      'screen could not be read (no such surface), so it is not proven to show this session',
    );
    expectRefused(
      await gate({callerScreen: () => ({kind: 'read', text: 'zsh $ \n'})}),
      'notInCmuxPane',
      'shows no session id on its status line',
    );
    expectRefused(
      await gate({callerScreen: () => Promise.reject(new Error('boom'))}),
      'notInCmuxPane',
      'boom',
    );
  });

  test('F16: requireCmuxPane false (the spawn gate) never reads the screen', async () => {
    let read = 0;
    const result = await runHandoffGate({
      env: {},
      limits: LIMITS,
      now: NOW,
      readers: passingReaders({
        callerScreen: () => {
          read += 1;
          return {kind: 'unreadable', reason: 'x'};
        },
      }),
      requireCmuxPane: false,
    });
    expect(result.kind).toBe('pass');
    expect(read).toBe(0);
  });

  test('F11: a launch record on the caller bead refuses (alreadyHandedOff); unreadable refuses; null skips', async () => {
    expectRefused(
      await gate({
        launchRecord: () => ({
          detail: 'hb-1 carries the successor-started label',
          kind: 'started',
        }),
      }),
      'alreadyHandedOff',
      'this session already started a successor (hb-1 carries the successor-started label). Only one successor per session: Justin can start another by hand from the handoff block',
    );
    expectRefused(
      await gate({
        launchRecord: () => ({kind: 'failed', reason: 'br is down'}),
      }),
      'alreadyHandedOff',
      'could not be checked: br is down',
    );
    expect((await gate({launchRecord: null})).kind).toBe('pass');
  });

  test('F14: no guard pass, a stale one or a mismatched one refuses (guardNotSeen)', async () => {
    expectRefused(
      await gate({guardPass: () => ({kind: 'missing', path: '/p.json'})}),
      'guardNotSeen',
      'no guard pass at /p.json, so the session guard is not proven to have checked this call',
    );
    expectRefused(
      await gate({
        guardPass: () => ({ageMs: 61_000, kind: 'stale', path: '/p.json'}),
      }),
      'guardNotSeen',
      'is 61 s old (limit 60 s)',
    );
    expectRefused(
      await gate({
        guardPass: () => ({kind: 'mismatch', path: '/p.json', sub: 'spawn'}),
      }),
      'guardNotSeen',
      'was written for a different call (thread spawn with other flags)',
    );
  });
});

describe('the guard pass (F14, guard-pass.ts)', () => {
  const HANDOFF = [
    './node_modules/.bin/justin-sdk',
    'thread',
    'handoff',
    '--note',
    'costs $5',
  ];
  const ARGV = ['thread', 'handoff', '--note', 'costs '];
  function world(): Record<string, string> {
    const sb = createSandbox();
    sandboxes.push(sb);
    return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
  }

  test('no pass refuses; a written pass for this call is valid once (single use); the values may differ, the flags may not', () => {
    const env = world();
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('missing');
    expect(
      writeGuardPass({env, now: NOW, sessionId: sid, words: HANDOFF}).kind,
    ).toBe('written');
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('valid');
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('missing');
  });

  test('a stale pass refuses, and a pass for another call (spawn, or a dry run) is a mismatch', () => {
    const env = world();
    const sid = 'aaaaaaaa-0000-4000-8000-000000000002';
    writeGuardPass({
      env,
      now: new Date(NOW.getTime() - 61_000),
      sessionId: sid,
      words: HANDOFF,
    });
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('stale');
    writeGuardPass({
      env,
      now: NOW,
      sessionId: sid,
      words: ['justin-sdk', 'thread', 'spawn'],
    });
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('mismatch');
    writeGuardPass({
      env,
      now: NOW,
      sessionId: sid,
      words: [...HANDOFF, '--dry-run'],
    });
    expect(
      consumeGuardPass({env, now: NOW, sessionId: sid, words: ARGV}).kind,
    ).toBe('mismatch');
    expect(guardPassPath(sid, env)).toContain(
      join('guard-pass', `${sid}.json`),
    );
  });
});

describe('readKillSwitch: <threads state dir>/handoff-off', () => {
  function stateWorld(): {env: Record<string, string>; stateDir: string} {
    const sb = createSandbox();
    sandboxes.push(sb);
    const stateDir = join(sb.path, 'state');
    mkdirSync(stateDir, {recursive: true});
    return {env: {JUSTIN_THREADS_STATE_DIR: stateDir}, stateDir};
  }

  test('absent: off', () => {
    const {env} = stateWorld();
    expect(readKillSwitch(env).kind).toBe('off');
  });

  test('present and empty: on, "the kill switch file exists"', () => {
    const {env, stateDir} = stateWorld();
    writeFileSync(join(stateDir, 'handoff-off'), '\n');
    expect(readKillSwitch(env)).toMatchObject({
      kind: 'on',
      reason: 'the kill switch file exists',
    });
  });

  test('present with text: on, the trimmed text is the reason', () => {
    const {env, stateDir} = stateWorld();
    writeFileSync(join(stateDir, 'handoff-off'), '  testing the mayor  \n');
    expect(readKillSwitch(env)).toMatchObject({
      kind: 'on',
      reason: 'testing the mayor',
    });
  });

  test('present but unreadable (a directory): still on', () => {
    const {env, stateDir} = stateWorld();
    mkdirSync(join(stateDir, 'handoff-off'));
    const read = readKillSwitch(env);
    expect(read.kind).toBe('on');
    if (read.kind === 'on') {
      expect(read.reason).toContain('the kill switch file exists');
    }
  });
});

describe('countLiveSessions', () => {
  test('counts processes: a cleared session showing two ids on one pid is one', () => {
    const live: LiveSessions = {
      bySessionId: new Map([
        ['a', {pid: 10, source: 'ps', surfaceId: 's1', workspaceId: 'w'}],
        [
          'a-cleared',
          {pid: 10, source: 'screen', surfaceId: 's1', workspaceId: 'w'},
        ],
        ['b', {pid: 11, source: 'agents', surfaceId: null, workspaceId: null}],
        ['c', {pid: null, source: 'screen', surfaceId: 's3', workspaceId: 'w'}],
      ]),
      kind: 'read',
      unplaced: [
        {
          detail: 'x',
          kind: 'pane',
          pid: 12,
          surfaceId: 's4',
          surfaceRef: 'surface:4',
          tty: 'ttys004',
          workspaceId: 'w',
        },
      ],
      workspacesBySessionId: new Map(),
    };
    expect(countLiveSessions(live)).toEqual({
      bySource: {agents: 1, hookStore: 0, ps: 1, screen: 2},
      kind: 'counted',
      sessionIds: 4,
      // pids 10 and 11, the pid-less c, the unplaced pane.
      total: 4,
      unplaced: {background: 0, pane: 1, process: 0},
    });
  });

  test('a failed read is failed, never 0 (rule 7)', () => {
    expect(
      countLiveSessions({kind: 'failed', reason: 'cmux tree: timed out'}),
    ).toEqual({kind: 'failed', reason: 'cmux tree: timed out'});
  });
});

describe('recordRefusal (real br)', () => {
  test('labels the session bead handoff-refused and appends the note line', () => {
    needBr();
    const sb = createSandbox();
    sandboxes.push(sb);
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      HOME: join(sb.path, 'home'),
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
      XDG_CONFIG_HOME: join(sb.path, 'xdg'),
    };
    const repo = initRepo(sb, 'refusal-repo', {'README.md': '# r\n'});
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    const filed = ensureSessionBead({
      cwd: repo,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: '01d00000-1111-4222-8333-0000000000a1',
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    const db = join(repo, '.beads', 'beads.db');

    const outcome = recordRefusal({
      beadId: filed.beadId,
      db,
      detail: 'the week window is at 93 % (ceiling 90 %)',
      env,
      now: NOW,
      reason: 'usageHigh',
    });
    expect(outcome).toEqual({
      kind: 'recorded',
      line: 'handoff refused: usageHigh — the week window is at 93 % (ceiling 90 %)',
    });
    const shown = brShow({db, env}, filed.beadId);
    if (shown.kind !== 'ok') throw new Error(`br show: ${shown.kind}`);
    expect(shown.issue.labels).toContain('handoff-refused');
    expect(shown.issue.notes ?? '').toMatch(
      /^- .+: handoff refused: usageHigh — the week window is at 93 % \(ceiling 90 %\)$/m,
    );
  });

  test('a bead that does not exist: failed, nothing recorded', () => {
    needBr();
    const sb = createSandbox();
    sandboxes.push(sb);
    const repo = initRepo(sb, 'refusal-missing', {'README.md': '# r\n'});
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    const outcome = recordRefusal({
      beadId: 't-nope',
      db: join(repo, '.beads', 'beads.db'),
      detail: 'x',
      env: {HOME: join(sb.path, 'home')},
      reason: 'killSwitch',
    });
    expect(outcome.kind).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The spend quota at the gates (home-base-ys9t7.5 D7, dispatch 2 item 2)
// ---------------------------------------------------------------------------

describe('the spend quota at the handoff and spawn gates', () => {
  const OVER: Record<
    'quotaChainSpent' | 'quotaProjectSpent' | 'quotaUnknown' | 'quotaWeekFloor',
    {detail: string; verdict: QuotaVerdict}
  > = {
    quotaChainSpent: {
      detail:
        'this chain has spent 5.4 % of your week since you last typed, limit 5 %',
      verdict: {
        attended: false,
        kind: 'over',
        over: [
          {atLeast: false, limit: 'chain', limitPercent: 5, spentPercent: 5.4},
        ],
        unknown: [],
      },
    },
    quotaProjectSpent: {
      detail:
        'this project has spent 11 % of your week in the last 24 hours since you last typed, limit 10 %',
      verdict: {
        attended: false,
        kind: 'over',
        over: [
          {
            atLeast: false,
            limit: 'project',
            limitPercent: 10,
            spentPercent: 11,
          },
        ],
        unknown: [],
      },
    },
    quotaUnknown: {
      detail:
        'the spend quota could not be measured: week: no fresh usage sample',
      verdict: {
        attendance: {kind: 'unattended', latestTypedAtMs: null},
        kind: 'unknown',
        reasons: ['week: no fresh usage sample'],
      },
    },
    quotaWeekFloor: {
      detail:
        'your week is at 83 %, and no unattended work runs at or past 75 %',
      verdict: {
        attended: false,
        kind: 'over',
        over: [
          {limit: 'floor', limitPercent: 75, weekPercent: 83, window: 'week'},
        ],
        unknown: [],
      },
    },
  };

  function quotaReaders(
    read: QuotaGateRead,
    logged: Record<string, unknown>[],
  ): Partial<HandoffGateReaders> {
    return {
      quota: () => read,
      quotaLog: (line) => {
        logged.push(line);
        return null;
      },
    };
  }

  /** The handoff gate, or the spawn gate's shape of it (no chain, no pane). */
  async function gateFor(
    purpose: 'handoff' | 'spawn',
    overrides: Partial<HandoffGateReaders>,
  ): Promise<HandoffGateResult> {
    if (purpose === 'handoff') return await gate(overrides);
    return await runHandoffGate({
      env: {},
      limits: LIMITS,
      now: NOW,
      readers: passingReaders({chain: null, launchRecord: null, ...overrides}),
      requireCmuxPane: false,
    });
  }

  for (const purpose of ['handoff', 'spawn'] as const) {
    for (const [reason, {detail, verdict}] of Object.entries(OVER)) {
      const measured = (mode: 'enforce' | 'observe'): QuotaGateRead => ({
        facts: null,
        kind: 'measured',
        mode,
        purpose,
        sessionId: 's-1',
        verdict,
      });

      test(`${purpose}, ${reason}: enforce refuses, with the numbers and the limit`, async () => {
        const logged: Record<string, unknown>[] = [];
        const result = await gateFor(
          purpose,
          quotaReaders(measured('enforce'), logged),
        );
        expectRefused(result, reason as HandoffRefusalReason, detail);
        expect(logged).toMatchObject([
          {action: 'refused', kind: 'gate', mode: 'enforce', purpose, reason},
        ]);
      });

      test(`${purpose}, ${reason}: observe logs the would-be refusal and passes`, async () => {
        const logged: Record<string, unknown>[] = [];
        const result = await gateFor(
          purpose,
          quotaReaders(measured('observe'), logged),
        );
        expect(result.kind).toBe('pass');
        expect(logged).toMatchObject([
          {action: 'wouldRefuse', detail, mode: 'observe', purpose, reason},
        ]);
      });
    }

    test(`${purpose}: mode off skips, logging nothing`, async () => {
      const logged: Record<string, unknown>[] = [];
      const result = await gateFor(
        purpose,
        quotaReaders({kind: 'off'}, logged),
      );
      expect(result.kind).toBe('pass');
      expect(logged).toEqual([]);
    });
  }

  test('a quota reader that throws refuses with quotaUnknown', async () => {
    const result = await gate({
      quota: () => {
        throw new Error('br exploded');
      },
    });
    expectRefused(result, 'quotaUnknown', 'br exploded');
  });

  test('thread spawn with successor off still runs the quota alone', async () => {
    const box = createSandbox();
    sandboxes.push(box);
    box.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        componentConfig: {thread: {handoff: {successor: false}}},
      }),
    );
    const env = {
      HOME: join(box.path, 'home'),
      XDG_CONFIG_HOME: join(box.path, 'x'),
    };
    const refusedRun = await spawnGate(
      {cwd: box.path, env, now: NOW},
      {
        quotaCheck: ({now}) =>
          runQuotaCheck(
            quotaReaders(
              {
                facts: null,
                kind: 'measured',
                mode: 'enforce',
                purpose: 'spawn',
                sessionId: null,
                verdict: OVER.quotaWeekFloor.verdict,
              },
              [],
            ),
            now,
          ),
      },
    );
    expect(refusedRun?.exitCode).toBe(3);
    expect(refusedRun?.lines[0]).toContain('quotaWeekFloor');
    const offRun = await spawnGate(
      {cwd: box.path, env, now: NOW},
      {
        quotaCheck: ({now}) =>
          runQuotaCheck(quotaReaders({kind: 'off'}, []), now),
      },
    );
    expect(offRun).toBeNull();
  });
});
