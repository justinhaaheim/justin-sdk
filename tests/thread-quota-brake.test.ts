/**
 * `thread brake` (request home-base-ys9t7.5 D6, D10; dispatch 2 item 4): the
 * decision table row by row, the allow-list, the cache and the quota log
 * lines it writes. The measurement is faked; the verdict is the REAL
 * quotaVerdict over fake spends, so attendance flows from the group's typed
 * lines exactly as in a live run.
 */

import type {QuotaReport} from '../src/thread/quota-command';
import type {GroupSpend} from '../src/thread/quota-group';
import type {QuotaLimits} from '../src/thread/quota-knob';
import type {ProjectSpend} from '../src/thread/quota-project';
import type {SpendTotals} from '../src/thread/quota-spend';
import type {WeekReading} from '../src/thread/quota-week';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import {join} from 'path';

import {
  brakeAllows,
  brakeHook,
  type BrakeHookDeps,
  type BrakeKnobs,
} from '../src/thread/quota-brake';
import {
  brakeStatePath,
  readBrakeState,
  sessionBraked,
} from '../src/thread/quota-brake-state';
import {quotaLogPath} from '../src/thread/quota-log';
import {readTypedTail} from '../src/thread/quota-read';
import {quotaVerdict} from '../src/thread/quota-verdict';
import {KICKOFF_OPENING} from '../src/thread/respawn';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const NOW = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;
const SESSION = '11111111-2222-3333-4444-555555555555';

const LIMITS: QuotaLimits = {
  attendedGraceMinutes: 30,
  chainWeekPercent: 5,
  dollarsPerWeekPercent: {fable: 12.9, opus: 32.3, other: 12.9, sonnet: 16.8},
  floorWeekPercent: 75,
  projectDayWeekPercent: 10,
};

function totals(weekPercent: number): SpendTotals {
  const zero = {usd: 0, weekPercent: 0};
  return {
    byFamily: {
      fable: {usd: weekPercent * 12.9, weekPercent},
      opus: zero,
      other: zero,
      sonnet: zero,
    },
    usd: weekPercent * 12.9,
    weekPercent,
  };
}

/** A known group: `spent` % unattended, typed `typedMinutesAgo` (null: never). */
function knownGroup(spent: number, typedMinutesAgo: number | null): GroupSpend {
  const typedAt = typedMinutesAgo == null ? null : NOW - typedMinutesAgo * MIN;
  return {
    firstUnattendedAtMs: NOW - 50 * MIN,
    kind: 'known',
    latestTypedAtMs: typedAt,
    members: [
      {
        beadId: 'b-1',
        files: [],
        sessionId: SESSION,
        spawnKickoff: false,
        typedLines: 1,
      },
    ],
    requests: 3,
    root: 'b-1',
    spend: totals(spent),
    typed: {kind: 'complete', latestTypedAtMs: typedAt},
    unparseableLines: 0,
  };
}

/** A group whose spend has an unpriced model, typed `typedMinutesAgo`. */
function unpricedGroup(typedMinutesAgo: number | null): GroupSpend {
  return {
    kind: 'unknown',
    lowerBound: totals(1),
    members: [{beadId: 'b-1', sessionId: SESSION, spawnKickoff: false}],
    reason: 'no list price for claude-unreleased-9',
    typed: {
      kind: 'complete',
      latestTypedAtMs:
        typedMinutesAgo == null ? null : NOW - typedMinutesAgo * MIN,
    },
  };
}

const PROJECT: ProjectSpend = {
  cutoffMs: NOW - 24 * 60 * MIN,
  dirs: [],
  files: 1,
  firstCountedAtMs: null,
  kind: 'known',
  latestTypedAtMs: null,
  projectSlug: '-repo',
  requests: 1,
  spend: totals(1),
  unparseableLines: 0,
  windowStartMs: NOW - 24 * 60 * MIN,
};

function week(percent: number): WeekReading {
  return {
    allModels: {
      ageMinutes: 5,
      at: new Date(NOW - 5 * MIN).toISOString(),
      measuredBy: 'statusline',
      path: '/scratch/live.json',
      percent,
      sessionId: null,
      source: 'live',
    },
    byModel: {},
    kind: 'known',
    notes: [],
  };
}

/** A fake measurement over the real verdict; counts its calls. */
function measuring(group: GroupSpend, weekPercent = 40) {
  const calls = {count: 0};
  const measure: BrakeHookDeps['measure'] = () => {
    calls.count += 1;
    const verdict = quotaVerdict({
      group,
      limits: LIMITS,
      nowMs: NOW,
      project: PROJECT,
      purpose: 'running',
      week: week(weekPercent),
    });
    const report = {
      group,
      nowMs: NOW,
      project: PROJECT,
      sessionId: SESSION,
      week: week(weekPercent),
    } as unknown as QuotaReport;
    return Promise.resolve({
      limits: LIMITS,
      report,
      verdict,
      verdictText: verdict.kind,
    });
  };
  return {calls, measure};
}

interface Harness {
  dir: string;
  env: Record<string, string>;
  logLines: () => Record<string, unknown>[];
  transcript: string;
}

function harness(): Harness {
  const box = createSandbox();
  sandboxes.push(box);
  box.writeFile('t.jsonl', '');
  return {
    dir: box.path,
    env: {JUSTIN_THREADS_STATE_DIR: join(box.path, 'state')},
    logLines: () => {
      const path = quotaLogPath({
        JUSTIN_THREADS_STATE_DIR: join(box.path, 'state'),
      });
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    transcript: join(box.path, 't.jsonl'),
  };
}

function knobs(
  mode: BrakeKnobs['mode'],
  recheckSeconds = 60,
): () => BrakeKnobs {
  return () => ({attendedGraceMinutes: 30, mode, recheckSeconds});
}

function payload(
  h: Harness,
  call: {
    agentId?: string;
    command?: string;
    sessionId?: string | null;
    toolName?: string;
  } = {},
): string {
  const record: Record<string, unknown> = {
    cwd: h.dir,
    hook_event_name: 'PreToolUse',
    tool_input:
      call.command == null ? {file_path: '/x'} : {command: call.command},
    tool_name: call.toolName ?? 'Bash',
    transcript_path: h.transcript,
  };
  if (call.sessionId !== null) record.session_id = call.sessionId ?? SESSION;
  if (call.agentId != null) {
    record.agent_id = call.agentId;
    record.agent_type = 'player';
  }
  return JSON.stringify(record);
}

const LS = {command: 'ls -la'};

/** A prompt Justin typed at `atMs`, as a transcript line. */
function typedLine(atMs: number, text = 'Justin asks for something'): string {
  return JSON.stringify({
    message: {content: text, role: 'user'},
    timestamp: new Date(atMs).toISOString(),
    type: 'user',
  });
}

/** A tool result at `atMs`: a user record that is never typed. */
function toolResultLine(atMs: number): string {
  return JSON.stringify({
    message: {
      content: [{content: 'output', type: 'tool_result'}],
      role: 'user',
    },
    timestamp: new Date(atMs).toISOString(),
    toolUseResult: {stdout: 'output'},
    type: 'user',
  });
}

describe('the decision table', () => {
  test('mode off: allow, nothing measured, nothing written', async () => {
    const h = harness();
    const {calls, measure} = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('off'), measure},
    );
    expect(result).toMatchObject({action: null, exitCode: 0, stderr: ''});
    expect(calls.count).toBe(0);
    expect(existsSync(join(h.dir, 'state'))).toBe(false);
  });

  test('no session id in the payload: allow, nothing written', async () => {
    const h = harness();
    const {calls, measure} = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, {...LS, sessionId: null})},
      {knobs: knobs('enforce'), measure},
    );
    expect(result).toMatchObject({action: null, exitCode: 0});
    expect(calls.count).toBe(0);
    expect(existsSync(join(h.dir, 'state'))).toBe(false);
  });

  test('fine: allow', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: measuring(knownGroup(1, null)).measure,
      },
    );
    expect(result).toMatchObject({action: 'allow', exitCode: 0, stderr: ''});
  });

  test('over, enforce: denied with the limit, the numbers and what to do', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: measuring(knownGroup(5.4, null)).measure,
      },
    );
    expect(result.action).toBe('deny');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'this chain has spent 5.4 % of your week since you last typed, limit 5 %',
    );
    for (const words of [
      'Write your final report now and stop.',
      'Do not hand off and do not spawn a session.',
      'Do not retry this call and do not work around this brake.',
      'A /loop session calls ScheduleWakeup with stop.',
      'Justin typing in this session resets it.',
    ]) {
      expect(result.stderr).toContain(words);
    }
    const brake = h.logLines().find((line) => line.kind === 'brake');
    expect(brake).toMatchObject({
      action: 'deny',
      agentId: null,
      mode: 'enforce',
      sessionId: SESSION,
      toolName: 'Bash',
      transcriptPath: h.transcript,
    });
  });

  test('over, observe: a would-deny is logged and the call is allowed', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('observe'),
        measure: measuring(knownGroup(9, null)).measure,
      },
    );
    expect(result).toMatchObject({
      action: 'wouldDeny',
      exitCode: 0,
      stderr: '',
    });
    expect(h.logLines().map((line) => line.kind)).toEqual(['recheck', 'brake']);
    expect(h.logLines()[1]).toMatchObject({
      action: 'wouldDeny',
      mode: 'observe',
    });
  });

  test('a subagent call is braked with its parent, and the log names it', async () => {
    const h = harness();
    const result = await brakeHook(
      {
        env: h.env,
        nowMs: NOW,
        stdin: payload(h, {agentId: 'a-77', command: 'ls'}),
      },
      {
        knobs: knobs('enforce'),
        measure: measuring(knownGroup(9, null)).measure,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(h.logLines().find((line) => line.kind === 'brake')).toMatchObject({
      agentId: 'a-77',
      agentType: 'player',
      transcriptPath: h.transcript,
    });
  });

  test('attended session with unpriced spend is allowed (unknown + attended)', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: measuring(unpricedGroup(5), 90).measure,
      },
    );
    expect(result.action).toBe('allowAttendedUnknown');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'allowed because Justin typed here recently',
    );
    expect(h.logLines().find((line) => line.kind === 'brake')).toMatchObject({
      action: 'allowAttendedUnknown',
    });
  });

  test('unattended session with unpriced spend is denied in enforce', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: measuring(unpricedGroup(45), 10).measure,
      },
    );
    expect(result.action).toBe('deny');
    expect(result.stderr).toContain('could not be measured');
  });

  test('a throw inside the measurement: attended allows, unattended denies (enforce)', async () => {
    const h = harness();
    const throwing: BrakeHookDeps['measure'] = () =>
      Promise.reject(new Error('br exploded'));
    // ys9t7.5.6: own attendance is asked first by the attended fast path. A
    // session it proves attended never reaches the measurement, so this row
    // is reached when Justin types between that read and the failure's.
    const asked = {count: 0};
    const attended = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: throwing,
        ownAttendance: () => {
          asked.count += 1;
          return Promise.resolve(
            asked.count === 1
              ? ({kind: 'unknown', reason: 'no typed line yet'} as const)
              : ({kind: 'attended', latestTypedAtMs: NOW - 2 * MIN} as const),
          );
        },
      },
    );
    expect(asked.count).toBe(2);
    expect(attended).toMatchObject({
      action: 'allowAttendedUnknown',
      exitCode: 0,
    });
    expect(attended.stderr).toContain('br exploded');

    const h2 = harness();
    const unattended = await brakeHook(
      {env: h2.env, nowMs: NOW, stdin: payload(h2, LS)},
      {
        knobs: knobs('enforce'),
        measure: throwing,
        ownAttendance: () =>
          Promise.resolve({kind: 'unknown', reason: 'no typed line'} as const),
      },
    );
    expect(unattended).toMatchObject({action: 'deny', exitCode: 2});
    expect(unattended.stderr).toContain('the brake failed (br exploded)');
  });

  test('the mode cannot be read: the one fail-open row, said on stderr', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: () => {
          throw new Error('config gone');
        },
      },
    );
    expect(result).toMatchObject({action: null, exitCode: 0});
    expect(result.stderr).toContain('the quota mode could not be read');
  });
});

describe('home-base-ys9t7.5.4 second dispatch: F2 and a session with no bead yet', () => {
  /** A session whose bead is not filed yet: the group cannot be read. */
  const noBead: GroupSpend = {
    kind: 'unknown',
    lowerBound: null,
    members: [],
    reason: 'no session bead: not filed yet',
    typed: {kind: 'unknown', reason: 'no session bead: not filed yet'},
  };

  test('F2: an over session in observe logs one would-deny per recompute, not one per call', async () => {
    const h = harness();
    const deps = {
      knobs: knobs('observe', 60),
      measure: measuring(knownGroup(9, null)).measure,
    };
    for (const offset of [0, 1_000, 2_000, 59_000]) {
      const result = await brakeHook(
        {env: h.env, nowMs: NOW + offset, stdin: payload(h, LS)},
        deps,
      );
      expect(result.action).toBe('wouldDeny');
    }
    expect(h.logLines().map((line) => line.kind)).toEqual(['recheck', 'brake']);
    // The next recompute writes the next pair.
    await brakeHook(
      {env: h.env, nowMs: NOW + 61_000, stdin: payload(h, LS)},
      deps,
    );
    expect(h.logLines().map((line) => line.kind)).toEqual([
      'recheck',
      'brake',
      'recheck',
      'brake',
    ]);
  });

  test('F2: a deny in enforce still writes one line per denied call', async () => {
    const h = harness();
    const deps = {
      knobs: knobs('enforce', 60),
      measure: measuring(knownGroup(9, null)).measure,
    };
    for (const offset of [0, 1_000]) {
      const result = await brakeHook(
        {env: h.env, nowMs: NOW + offset, stdin: payload(h, LS)},
        deps,
      );
      expect(result.action).toBe('deny');
    }
    expect(h.logLines().map((line) => line.kind)).toEqual([
      'recheck',
      'brake',
      'brake',
    ]);
  });

  test('no session bead yet, Justin typed here 2 min ago: allowed by the attended fast path, nothing measured (enforce)', async () => {
    // ys9t7.5.6: this case used to reach the measured-unknown row below; the
    // fast path now allows it before the group is read.
    const h = harness();
    appendFileSync(h.transcript, `${typedLine(NOW - 2 * MIN)}\n`);
    const {calls, measure} = measuring(noBead);
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(0);
    expect(result).toMatchObject({action: 'allow', exitCode: 0});
    expect(h.logLines()[0]).toMatchObject({
      attendedFastPath: true,
      kind: 'recheck',
    });
  });

  test('a measured unknown, Justin typed between the two reads: allowed, from its own transcript (enforce)', async () => {
    // The measured-unknown row is reached once the fast path's read did not
    // prove attended; its own read can still prove it a moment later.
    const h = harness();
    const asked = {count: 0};
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {
        knobs: knobs('enforce'),
        measure: measuring(noBead).measure,
        ownAttendance: () => {
          asked.count += 1;
          return Promise.resolve(
            asked.count === 1
              ? ({kind: 'unknown', reason: 'no typed line yet'} as const)
              : ({kind: 'attended', latestTypedAtMs: NOW - MIN} as const),
          );
        },
      },
    );
    expect(asked.count).toBe(2);
    expect(result).toMatchObject({action: 'allowAttendedUnknown', exitCode: 0});
    expect(h.logLines()[0]).toMatchObject({
      kind: 'recheck',
      ownTranscriptAttended: true,
    });
  });

  test('no session bead yet in a spawned child: its kickoff is not typing, so it is braked (enforce)', async () => {
    const h = harness();
    appendFileSync(h.transcript, `${typedLine(NOW - 2 * MIN)}\n`);
    const result = await brakeHook(
      {
        env: {...h.env, JUSTIN_SDK_SPAWN_KICKOFF: '1'},
        nowMs: NOW,
        stdin: payload(h, LS),
      },
      {knobs: knobs('enforce'), measure: measuring(noBead).measure},
    );
    expect(result).toMatchObject({action: 'deny', exitCode: 2});
  });

  test('no session bead yet and nobody typed: braked (enforce)', async () => {
    const h = harness();
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure: measuring(noBead).measure},
    );
    expect(result).toMatchObject({action: 'deny', exitCode: 2});
  });
});

describe('the allow-list while braked', () => {
  const bash = (command: string): boolean =>
    brakeAllows({command, toolName: 'Bash'});

  test('thread status, br update and git commit are allowed', () => {
    expect(bash('bun run justin-sdk thread status')).toBe(true);
    expect(bash('./node_modules/.bin/justin-sdk thread quota --json')).toBe(
      true,
    );
    expect(
      bash(
        'bun run --cwd "${CLAUDE_PROJECT_DIR:-.}" justin-sdk thread ask "x" --priority 3',
      ),
    ).toBe(true);
    expect(bash("br update home-1 --notes 'state'")).toBe(true);
    expect(bash('br --db /x/.beads/beads.db show home-1')).toBe(true);
    expect(bash("git commit -m 'feat: x' -- a.ts")).toBe(true);
    expect(bash('cd /repo/wt && git add a.ts && git commit -m done')).toBe(
      true,
    );
    expect(bash('git -C /repo status')).toBe(true);
    expect(bash('git push')).toBe(true);
    expect(bash('git push origin main')).toBe(true);
  });

  test('ls, an Edit call, and `thread status && rm x` are denied', () => {
    expect(bash('ls')).toBe(false);
    expect(brakeAllows({command: null, toolName: 'Edit'})).toBe(false);
    expect(bash('bun run justin-sdk thread status && rm x')).toBe(false);
  });

  test('force pushes, deletes, other thread commands and smuggled programs are denied', () => {
    for (const command of [
      'git push -f',
      'git push --force',
      'git push --force-with-lease',
      'git push -uf origin x',
      'git push origin +main',
      'git push origin :old',
      'git push --delete origin x',
      'git reset --hard',
      'bun run justin-sdk thread handoff --note x',
      'bun run justin-sdk thread spawn ~/Dev/x',
      'rm x justin-sdk thread status',
      'bun run evil.ts justin-sdk thread status',
      'br delete home-1',
      'git commit -m "$(rm -rf x)"',
      'bash -c "git status"',
      'echo $(',
    ]) {
      expect([command, bash(command)]).toEqual([command, false]);
    }
  });

  test('the two tools the deny message tells a session to call', () => {
    expect(brakeAllows({command: null, toolName: 'ScheduleWakeup'})).toBe(true);
    expect(brakeAllows({command: null, toolName: 'SubagentHandback'})).toBe(
      true,
    );
  });

  test('a braked, enforced call on the list goes through', async () => {
    const h = harness();
    const result = await brakeHook(
      {
        env: h.env,
        nowMs: NOW,
        stdin: payload(h, {command: "git commit -m 'final' -- a.ts"}),
      },
      {
        knobs: knobs('enforce'),
        measure: measuring(knownGroup(9, null)).measure,
      },
    );
    expect(result).toMatchObject({action: 'allowListed', exitCode: 0});
  });
});

describe('the cached decision', () => {
  test('no recompute inside recheckSeconds; one after; tmp + rename leaves one file', async () => {
    const h = harness();
    const {calls, measure} = measuring(knownGroup(9, null));
    const deps = {knobs: knobs('enforce', 60), measure};
    const first = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      deps,
    );
    const second = await brakeHook(
      {env: h.env, nowMs: NOW + 59_000, stdin: payload(h, LS)},
      deps,
    );
    expect([first.recomputed, second.recomputed, calls.count]).toEqual([
      true,
      false,
      1,
    ]);
    expect(second.exitCode).toBe(2);
    const third = await brakeHook(
      {env: h.env, nowMs: NOW + 60_000, stdin: payload(h, LS)},
      deps,
    );
    expect([third.recomputed, calls.count]).toEqual([true, 2]);

    const dir = join(h.dir, 'state', 'quota-brake');
    expect(readdirSync(dir)).toEqual([`${SESSION}.json`]);
    const read = readBrakeState(SESSION, h.env);
    expect(read.kind === 'read' ? read.state.state : read.kind).toBe('braked');
    expect(brakeStatePath(SESSION, h.env)).toBe(join(dir, `${SESSION}.json`));
    expect(sessionBraked(SESSION, h.env)).toBe(true);
    expect(h.logLines().filter((line) => line.kind === 'recheck')).toHaveLength(
      2,
    );
  });

  test('another mode recomputes; observe is never "braked" for the Stop hook', async () => {
    const h = harness();
    const {calls, measure} = measuring(knownGroup(9, null));
    await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('observe'), measure},
    );
    expect(sessionBraked(SESSION, h.env)).toBe(false);
    await brakeHook(
      {env: h.env, nowMs: NOW + 1000, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(2);
    expect(sessionBraked(SESSION, h.env)).toBe(true);
  });

  test('Justin typing resets a braked cache at once', async () => {
    const h = harness();
    const {calls, measure} = measuring(knownGroup(9, null));
    const deps = {knobs: knobs('enforce', 600), measure};
    await brakeHook({env: h.env, nowMs: NOW, stdin: payload(h, LS)}, deps);
    // A tool record (not typed) does not reset it.
    appendFileSync(
      h.transcript,
      `${JSON.stringify({message: {content: [{type: 'tool_result'}], role: 'user'}, timestamp: new Date(NOW).toISOString(), type: 'user'})}\n`,
    );
    await brakeHook(
      {env: h.env, nowMs: NOW + 1000, stdin: payload(h, LS)},
      deps,
    );
    expect(calls.count).toBe(1);
    appendFileSync(
      h.transcript,
      `${JSON.stringify({message: {content: 'keep going please', role: 'user'}, timestamp: new Date(NOW + 2000).toISOString(), type: 'user'})}\n`,
    );
    const reset = await brakeHook(
      {env: h.env, nowMs: NOW + 3000, stdin: payload(h, LS)},
      deps,
    );
    // The reset recomputes, and since ys9t7.5.6 the typed line it found
    // allows through the attended fast path, with no second measurement.
    expect(reset).toMatchObject({
      action: 'allow',
      exitCode: 0,
      recomputed: true,
    });
    expect(calls.count).toBe(1);
  });
});

describe('home-base-ys9t7.5.6: the attended fast path', () => {
  /** A prompt Justin sent while Claude worked: a queued_command attachment. */
  function queuedLine(atMs: number, prompt: string): string {
    return JSON.stringify({
      attachment: {
        commandMode: 'prompt',
        prompt,
        timestamp: new Date(atMs).toISOString(),
        type: 'queued_command',
      },
      timestamp: new Date(atMs).toISOString(),
      type: 'attachment',
    });
  }

  function write(h: Harness, lines: string[]): void {
    appendFileSync(h.transcript, `${lines.join('\n')}\n`);
  }

  test('typed 2 min ago in its own transcript: allowed with no group read and no pricing', async () => {
    const h = harness();
    write(h, [typedLine(NOW - 2 * MIN), toolResultLine(NOW - MIN)]);
    // Measured, this group is over its chain limit: the fast path must not ask.
    const {calls, measure} = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(0);
    expect(result).toMatchObject({
      action: 'allow',
      exitCode: 0,
      recomputed: true,
      stderr: '',
    });
    const lines = h.logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      attendance: 'attended',
      attendedFastPath: true,
      attendedUntil: new Date(NOW + 28 * MIN).toISOString(),
      kind: 'recheck',
      latestTypedAt: new Date(NOW - 2 * MIN).toISOString(),
      mode: 'enforce',
      sessionId: SESSION,
    });
    // No spend: nothing was measured.
    for (const key of [
      'unattended',
      'week',
      'members',
      'unattendedWeekPercent',
    ]) {
      expect([key, key in (lines[0] ?? {})]).toEqual([key, false]);
    }
    const read = readBrakeState(SESSION, h.env);
    expect(read.kind === 'read' ? read.state : read).toMatchObject({
      attendedUntilMs: NOW + 28 * MIN,
      state: 'clear',
    });
    expect(sessionBraked(SESSION, h.env)).toBe(false);
  });

  test('the cache holds until the grace runs out, past recheckSeconds, then the full path runs', async () => {
    const h = harness();
    write(h, [typedLine(NOW - 20 * MIN), toolResultLine(NOW - 19 * MIN)]);
    const {calls, measure} = measuring(knownGroup(9, null));
    const deps = {knobs: knobs('enforce', 60), measure};
    const at = async (offsetMs: number) =>
      await brakeHook(
        {env: h.env, nowMs: NOW + offsetMs, stdin: payload(h, LS)},
        deps,
      );

    const first = await at(0);
    const pastRecheck = await at(5 * MIN);
    const lastCachedMs = await at(10 * MIN - 1);
    expect([
      first.recomputed,
      pastRecheck.recomputed,
      lastCachedMs.recomputed,
    ]).toEqual([true, false, false]);
    expect([first.action, pastRecheck.action, lastCachedMs.action]).toEqual([
      'allow',
      'allow',
      'allow',
    ]);
    expect(calls.count).toBe(0);

    // The grace ran out (typed 30 min ago): recomputed, and measured.
    const graceOver = await at(10 * MIN);
    expect(graceOver.recomputed).toBe(true);
    expect(calls.count).toBe(1);
    expect(graceOver).toMatchObject({action: 'deny', exitCode: 2});
  });

  test('a grace knob shortened after the fast path cached takes effect at once', async () => {
    const h = harness();
    write(h, [typedLine(NOW - 20 * MIN)]);
    const {calls, measure} = measuring(knownGroup(9, null));
    await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(0);
    const shorter = await brakeHook(
      {env: h.env, nowMs: NOW + MIN, stdin: payload(h, LS)},
      {
        knobs: () => ({
          attendedGraceMinutes: 15,
          mode: 'enforce',
          recheckSeconds: 60,
        }),
        measure,
      },
    );
    expect(shorter.recomputed).toBe(true);
    expect(calls.count).toBe(1);
  });

  test('typed 31 minutes ago: the full path', async () => {
    const h = harness();
    write(h, [typedLine(NOW - 31 * MIN), toolResultLine(NOW - MIN)]);
    const {calls, measure} = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(1);
    expect(result).toMatchObject({action: 'deny', exitCode: 2});
    expect(h.logLines()[0]).not.toHaveProperty('attendedFastPath');
  });

  test('a typed line dated after now is not used: the full path', async () => {
    const h = harness();
    write(h, [typedLine(NOW + 5 * MIN)]);
    const {calls, measure} = measuring(knownGroup(9, null));
    await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(1);
  });

  test('a kickoff or machine line is never typing (classifyUserLine): the full path', async () => {
    const machine = [
      `${KICKOFF_OPENING} Read the handoff on bead home-1 and continue.`,
      '<task-notification><status>completed</status></task-notification>',
      'Another Claude session sent a message: please look at x',
      '# Autonomous loop tick 4',
      '[home-base backfill, sent by home-base session abc123; Justin approved this message] go on',
      // The shape a subagent's hand-back has in a real transcript (session
      // 3dbc86df, 2026-10-30).
      'Another Claude session sent a message:\n<agent-message from="a745b8caededf98df">\n[Subagent hand-back] The text below is the final report of a subagent.\n</agent-message>',
    ];
    for (const text of machine) {
      const h = harness();
      write(h, [typedLine(NOW - MIN, text)]);
      const {calls, measure} = measuring(knownGroup(9, null));
      const result = await brakeHook(
        {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
        {knobs: knobs('enforce'), measure},
      );
      expect([text, calls.count, result.action]).toEqual([text, 1, 'deny']);
    }
    // A queued machine prompt is not typing either.
    const h = harness();
    write(h, [
      queuedLine(
        NOW - MIN,
        '<agent-message from="player">done</agent-message>',
      ),
    ]);
    const {calls, measure} = measuring(knownGroup(9, null));
    await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(1);
  });

  test('a prompt Justin queued while Claude worked is typing: the fast path', async () => {
    const h = harness();
    write(h, [
      typedLine(NOW - 50 * MIN),
      queuedLine(NOW - 3 * MIN, 'also fix the readme'),
    ]);
    const {calls, measure} = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: h.env, nowMs: NOW, stdin: payload(h, LS)},
      {knobs: knobs('enforce'), measure},
    );
    expect(calls.count).toBe(0);
    expect(result.action).toBe('allow');
  });

  test('a spawned child: its kickoff is dropped by position, a later typed line is not', async () => {
    const env = (h: Harness) => ({...h.env, JUSTIN_SDK_SPAWN_KICKOFF: '1'});
    // Only the kickoff: the full path.
    const kickoffOnly = harness();
    write(kickoffOnly, [
      typedLine(NOW - 5 * MIN, '/conductor build the thing'),
      toolResultLine(NOW - 4 * MIN),
    ]);
    const a = measuring(knownGroup(9, null));
    await brakeHook(
      {env: env(kickoffOnly), nowMs: NOW, stdin: payload(kickoffOnly, LS)},
      {knobs: knobs('enforce'), measure: a.measure},
    );
    expect(a.calls.count).toBe(1);
    // Justin typed into it later: the fast path.
    const typedLater = harness();
    write(typedLater, [
      typedLine(NOW - 10 * MIN, '/conductor build the thing'),
      toolResultLine(NOW - 9 * MIN),
      typedLine(NOW - 2 * MIN, 'stop and tell me where you are'),
    ]);
    const b = measuring(knownGroup(9, null));
    const result = await brakeHook(
      {env: env(typedLater), nowMs: NOW, stdin: payload(typedLater, LS)},
      {knobs: knobs('enforce'), measure: b.measure},
    );
    expect(b.calls.count).toBe(0);
    expect(result.action).toBe('allow');
  });
});

describe('home-base-ys9t7.5.6: readTypedTail, the tail read', () => {
  const since = NOW - 30 * MIN;

  test('finds the latest typed line across chunk boundaries, multibyte text and a line longer than a chunk', () => {
    const h = harness();
    const lines = [
      typedLine(NOW - 40 * MIN, 'an older line'),
      typedLine(NOW - 10 * MIN, 'naïve café ✓ — the newest typed line'),
    ];
    for (let i = 0; i < 40; i++) lines.push(toolResultLine(NOW - 9 * MIN + i));
    appendFileSync(h.transcript, `${lines.join('\n')}\n`);
    for (const chunkBytes of [7, 64, 1000, 64 * 1024]) {
      const read = readTypedTail(h.transcript, {
        chunkBytes,
        dropFirstPrompt: false,
        sinceMs: since,
      });
      expect([chunkBytes, read]).toMatchObject([
        chunkBytes,
        {kind: 'read', latestTypedAtMs: NOW - 10 * MIN},
      ]);
    }
    const long = harness();
    appendFileSync(
      long.transcript,
      `${typedLine(NOW - 5 * MIN, 'y'.repeat(5000))}\n${toolResultLine(NOW - MIN)}\n`,
    );
    expect(
      readTypedTail(long.transcript, {
        chunkBytes: 64,
        dropFirstPrompt: false,
        sinceMs: since,
      }),
    ).toMatchObject({
      latestTypedAtMs: NOW - 5 * MIN,
    });
  });

  test('stops at a user record dated before the grace, without reading back to an older typed line', () => {
    const h = harness();
    // Old work after the old typed line, so the stop is well before the start.
    const old: string[] = [];
    for (let i = 0; i < 50; i++) old.push(toolResultLine(NOW - 119 * MIN));
    const recent: string[] = [];
    for (let i = 0; i < 200; i++)
      recent.push(toolResultLine(NOW - 20 * MIN + i));
    const lines = [
      typedLine(NOW - 120 * MIN),
      ...old,
      toolResultLine(NOW - 40 * MIN),
      ...recent,
    ];
    appendFileSync(h.transcript, `${lines.join('\n')}\n`);
    const size = statSync(h.transcript).size;
    const read = readTypedTail(h.transcript, {
      chunkBytes: 1024,
      dropFirstPrompt: false,
      sinceMs: since,
    });
    expect(read).toMatchObject({kind: 'read', latestTypedAtMs: null});
    expect(read.kind === 'read' && read.bytesRead < size).toBe(true);

    // Control: with no record dated before the grace after the typed line,
    // it reads back to that line.
    const control = harness();
    appendFileSync(
      control.transcript,
      `${[typedLine(NOW - 120 * MIN), ...recent].join('\n')}\n`,
    );
    expect(
      readTypedTail(control.transcript, {
        chunkBytes: 1024,
        dropFirstPrompt: false,
        sinceMs: since,
      }),
    ).toMatchObject({
      latestTypedAtMs: NOW - 120 * MIN,
    });
  });

  test('a line cut mid-append is skipped; a missing file is a failure, never "no typed line"', () => {
    const h = harness();
    appendFileSync(
      h.transcript,
      `${typedLine(NOW - 2 * MIN)}\n{"type":"user","message":{"content":"half`,
    );
    expect(
      readTypedTail(h.transcript, {dropFirstPrompt: false, sinceMs: since}),
    ).toMatchObject({
      latestTypedAtMs: NOW - 2 * MIN,
    });
    expect(
      readTypedTail(join(h.dir, 'gone.jsonl'), {
        dropFirstPrompt: false,
        sinceMs: since,
      }).kind,
    ).toBe('failed');
  });
});
