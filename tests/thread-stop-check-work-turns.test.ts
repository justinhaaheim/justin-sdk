/**
 * The refusal experiment: `componentConfig.thread.enforceMode: 'workTurns'`
 * (home-base-k0b8n.11, epic decision K12).
 *
 * The existing suite (thread-stop-check.test.ts) is deliberately UNTOUCHED and
 * still passes: an absent mode is `reportShaped`, which is today's behaviour.
 * This file covers the new branches, the decision log, `--stats`, and the knob.
 *
 * NEGATIVE CONTROLS: recorded on home-base-k0b8n.11's notes, each with the line
 * broken and the assertion that went red.
 */

import type {StopCheckInputs} from '../src/thread/stop-check';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {DEFAULT_COMPONENT_CONFIG} from '../src/sdk-config';
import {stopCheckLogPath} from '../src/thread/archive';
import {resolveThreadConfig} from '../src/thread/config';
import {
  decideStopCheck,
  GIT_COMMIT_COMMAND,
  measureTurnInTranscript,
  renderStopCheckStats,
  runThreadStopCheck,
} from '../src/thread/stop-check';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const SESSION_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROSE = 'Done — fixed the bug and committed it.';

/** A workTurns turn that committed: blocks. Every row patches this once. */
const WORK: StopCheckInputs = {
  agentId: null,
  archive: {kind: 'none'},
  enforce: true,
  lastAssistantMessage: PROSE,
  lastUserMessageAt: 1_000_000,
  markerExists: false,
  minTurnMinutes: 20,
  mode: 'workTurns',
  sessionId: SESSION_ID,
  stopHookActive: false,
  turn: {commits: 1, minutes: 3},
};

describe('decideStopCheck · workTurns (K12), one row per branch', () => {
  test('a turn that ran git commit and yields in prose is BLOCKED, saying why', () => {
    const decision = decideStopCheck(WORK);
    expect(decision).toMatchObject({action: 'block', why: 'workTurnCommitted'});
    expect(decision.reason).toBe(
      'This turn committed work and no report was recorded; run bun run justin-sdk thread prepare then thread report --file and paste its output.',
    );
  });

  test('a LONG turn with no commit is blocked, and the reason names its minutes', () => {
    const decision = decideStopCheck({
      ...WORK,
      turn: {commits: 0, minutes: 25.7},
    });
    expect(decision).toMatchObject({action: 'block', why: 'workTurnLong'});
    expect(decision.reason).toStartWith(
      'This turn ran 25 minutes and no report was recorded;',
    );
  });

  test('a short turn with no commit passes (lightTurn); at the threshold it blocks', () => {
    expect(
      decideStopCheck({...WORK, turn: {commits: 0, minutes: 19.9}}),
    ).toMatchObject({action: 'pass', why: 'lightTurn'});
    expect(
      decideStopCheck({...WORK, turn: {commits: 0, minutes: 20}}),
    ).toMatchObject({action: 'block', why: 'workTurnLong'});
    expect(
      decideStopCheck({
        ...WORK,
        minTurnMinutes: 5,
        turn: {commits: 0, minutes: 6},
      }),
    ).toMatchObject({action: 'block', why: 'workTurnLong'});
  });

  test('a report archived AFTER his last message passes', () => {
    expect(
      decideStopCheck({...WORK, archive: {at: 1_000_001, kind: 'newest'}}),
    ).toMatchObject({action: 'pass', why: 'archiveNewer'});
    // Negative control in-line: one archived BEFORE it does not count.
    expect(
      decideStopCheck({...WORK, archive: {at: 999_999, kind: 'newest'}}),
    ).toMatchObject({action: 'block'});
  });

  test('the guards pass: subagent, stop_hook_active, marker, knob off, unmeasured turn', () => {
    expect(decideStopCheck({...WORK, agentId: 'a1'}).why).toBe('subagent');
    expect(decideStopCheck({...WORK, stopHookActive: true}).why).toBe(
      'stopHookActive',
    );
    expect(decideStopCheck({...WORK, markerExists: true}).why).toBe(
      'markerPresent',
    );
    expect(decideStopCheck({...WORK, enforce: false}).why).toBe('knobOff');
    expect(decideStopCheck({...WORK, turn: null}).why).toBe('turnUnknown');
    expect(
      decideStopCheck({...WORK, turn: {commits: Number.NaN, minutes: 3}}).why,
    ).toBe('turnUnknown');
    expect(
      decideStopCheck({...WORK, archive: {error: 'x', kind: 'unknown'}}).why,
    ).toBe('archiveUnknown');
  });

  test('reportShaped — explicit or ABSENT — passes the same prose turn (today’s behaviour)', () => {
    expect(decideStopCheck({...WORK, mode: 'reportShaped'})).toEqual({
      action: 'pass',
      reason: null,
      why: 'notAReport',
    });
    const {minTurnMinutes, mode, turn, ...legacy} = WORK;
    expect([minTurnMinutes, mode, turn]).toHaveLength(3);
    expect(decideStopCheck(legacy)).toEqual({
      action: 'pass',
      reason: null,
      why: 'notAReport',
    });
  });
});

describe('GIT_COMMIT_COMMAND', () => {
  test('matches a command that runs git commit, and nothing that merely mentions it', () => {
    for (const command of [
      "git commit -m 'x'",
      'git add a && git commit -m x',
      'git -C /repo commit -m x',
      'git -c user.name=x commit',
      'git commit',
    ]) {
      expect(GIT_COMMIT_COMMAND.test(command)).toBe(true);
    }
    for (const command of [
      'git status',
      'git commit-tree HEAD^{tree}',
      'git log --grep commit',
      'br create "commit the thing"',
    ]) {
      expect(GIT_COMMIT_COMMAND.test(command)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The IO wrapper, the log, --stats
// ---------------------------------------------------------------------------

interface Fixture {
  env: Record<string, string | undefined>;
  project: Sandbox;
  state: Sandbox;
  transcriptPath: string;
}

function record(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** Justin's message at 10:00, then a Bash `git commit` tool call at 10:02. */
function workTurnFixture(
  thread: Record<string, unknown> = {enforce: true, enforceMode: 'workTurns'},
  commit = true,
): Fixture {
  const project = track(createProjectSandbox());
  const state = track(createSandbox());
  const xdg = track(createSandbox());
  mkdirSync(join(xdg.path, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg.path, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread}}),
  );
  const transcripts = track(createSandbox());
  const dir = join(transcripts.path, '-tmp-work');
  mkdirSync(dir, {recursive: true});
  const transcriptPath = join(dir, `${SESSION_ID}.jsonl`);
  const command = commit ? "git add . && git commit -m 'fix'" : 'git status';
  writeFileSync(
    transcriptPath,
    [
      record({
        message: {content: 'an older message', role: 'user'},
        timestamp: '2026-09-23T09:00:00.000Z',
        type: 'user',
      }),
      // A commit BEFORE his last message belongs to an earlier turn.
      record({
        message: {
          content: [
            {
              id: 't0',
              input: {command: 'git commit -m old'},
              name: 'Bash',
              type: 'tool_use',
            },
          ],
          role: 'assistant',
        },
        timestamp: '2026-09-23T09:01:00.000Z',
        type: 'assistant',
      }),
      record({
        message: {content: 'fix the bug', role: 'user'},
        timestamp: '2026-09-23T10:00:00.000Z',
        type: 'user',
      }),
      record({
        message: {
          content: [
            {id: 't1', input: {command}, name: 'Bash', type: 'tool_use'},
          ],
          role: 'assistant',
        },
        timestamp: '2026-09-23T10:02:00.000Z',
        type: 'assistant',
      }),
      record({
        message: {
          content: [{content: 'ok', tool_use_id: 't1', type: 'tool_result'}],
          role: 'user',
        },
        timestamp: '2026-09-23T10:02:01.000Z',
        toolUseResult: {stdout: 'ok'},
        type: 'user',
      }),
    ].join(''),
  );
  return {
    env: {
      HOME: project.path,
      JUSTIN_THREADS_STATE_DIR: state.path,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: transcripts.path,
      XDG_CONFIG_HOME: xdg.path,
    },
    project,
    state,
    transcriptPath,
  };
}

function stopPayload(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    cwd: fixture.project.path,
    hook_event_name: 'Stop',
    last_assistant_message: PROSE,
    prompt_id: 'feed0000-1111-2222-3333-444444444444',
    session_id: SESSION_ID,
    transcript_path: fixture.transcriptPath,
    ...extra,
  });
}

function quiet<T>(body: () => T): {err: string; out: string; value: T} {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    const value = body();
    return {err: err.join('\n'), out: out.join('\n'), value};
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function logLines(fixture: Fixture): Record<string, unknown>[] {
  return readFileSync(stopCheckLogPath(fixture.env), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AT_10_05 = new Date('2026-09-23T10:05:00.000Z');

describe('measureTurnInTranscript', () => {
  test('counts only the commits since his LAST message, and the minutes since it', () => {
    const fixture = workTurnFixture();
    expect(
      measureTurnInTranscript(fixture.transcriptPath, AT_10_05.getTime()),
    ).toEqual({
      at: Date.parse('2026-09-23T10:00:00.000Z'),
      turn: {commits: 1, minutes: 5},
    });
  });
});

describe('runThreadStopCheck · workTurns', () => {
  test('a turn with a git commit is refused ONCE with the reason; the retry passes; both are logged', () => {
    const fixture = workTurnFixture();
    const first = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(first.value.exitCode).toBe(2);
    expect(first.value.decision.why).toBe('workTurnCommitted');
    expect(first.err).toContain(
      'This turn committed work and no report was recorded',
    );
    expect(JSON.parse(first.out)).toMatchObject({decision: 'block'});

    const second = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(second.value.exitCode).toBe(0);
    expect(second.value.decision.why).toBe('markerPresent');
    expect(second.out).toBe('');

    expect(logLines(fixture)).toEqual([
      {
        action: 'block',
        at: '2026-09-23T10:05:00.000Z',
        cwd: fixture.project.path,
        mode: 'workTurns',
        sessionId: SESSION_ID,
        turnCommits: 1,
        turnMinutes: 5,
        why: 'workTurnCommitted',
      },
      {
        action: 'pass',
        at: '2026-09-23T10:05:00.000Z',
        cwd: fixture.project.path,
        mode: 'workTurns',
        sessionId: SESSION_ID,
        // Measured before the marker is consulted, so the pass says what it saw.
        turnCommits: 1,
        turnMinutes: 5,
        why: 'markerPresent',
      },
    ]);
  });

  test('stop_hook_active passes (Claude Code’s own loop guard)', () => {
    const fixture = workTurnFixture();
    const run = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture, {stop_hook_active: true}),
      }),
    );
    expect(run.value).toMatchObject({
      decision: {why: 'stopHookActive'},
      exitCode: 0,
    });
  });

  test('a report archived after his last message: exit 0', () => {
    const fixture = workTurnFixture();
    const reports = join(fixture.state.path, 'reports', SESSION_ID);
    mkdirSync(reports, {recursive: true});
    writeFileSync(join(reports, '2026-09-23T10-04-00.000Z.json'), '{}\n');
    const run = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(run.value).toMatchObject({
      decision: {why: 'archiveNewer'},
      exitCode: 0,
    });
  });

  test('a short turn with no commit passes, and the pass is logged with its measurement', () => {
    const fixture = workTurnFixture(undefined, false);
    const run = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(run.value).toMatchObject({
      decision: {why: 'lightTurn'},
      exitCode: 0,
    });
    expect(logLines(fixture)).toMatchObject([
      {action: 'pass', turnCommits: 0, turnMinutes: 5, why: 'lightTurn'},
    ]);
  });

  test('reportShaped (enforce on, no mode): the same commit turn passes as notAReport, and is logged', () => {
    const fixture = workTurnFixture({enforce: true});
    const run = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(run).toMatchObject({
      err: '',
      out: '',
      value: {decision: {why: 'notAReport'}, exitCode: 0},
    });
    expect(logLines(fixture)).toMatchObject([
      {
        action: 'pass',
        mode: 'reportShaped',
        turnCommits: null,
        why: 'notAReport',
      },
    ]);
  });

  test('an UNWRITABLE log never changes the decision: the block still happens', () => {
    const fixture = workTurnFixture();
    // A directory where the log file should be: every append fails (EISDIR).
    mkdirSync(stopCheckLogPath(fixture.env), {recursive: true});
    const run = quiet(() =>
      runThreadStopCheck({
        env: fixture.env,
        now: AT_10_05,
        stdin: stopPayload(fixture),
      }),
    );
    expect(run.value).toMatchObject({
      decision: {why: 'workTurnCommitted'},
      exitCode: 2,
    });
  });
});

describe('thread stop-check --stats', () => {
  test('counts by action and why, blank lines between groups', () => {
    const text = [
      {action: 'pass', at: '2026-09-23T10:00:00.000Z', why: 'knobOff'},
      {action: 'pass', at: '2026-09-23T10:01:00.000Z', why: 'knobOff'},
      {action: 'pass', at: '2026-09-23T10:02:00.000Z', why: 'lightTurn'},
      {
        action: 'block',
        at: '2026-09-23T10:03:00.000Z',
        why: 'workTurnCommitted',
      },
    ]
      .map((line) => JSON.stringify(line))
      .concat(['not json'])
      .join('\n');
    expect(renderStopCheckStats(text, '/state/stop-check.jsonl', false)).toBe(
      [
        '  🛑 STOP-CHECK DECISIONS',
        '',
        '      4 decisions logged · 2026-09-23T10:00:00.000Z → 2026-09-23T10:03:00.000Z',
        '      /state/stop-check.jsonl',
        '',
        '      block 1',
        '         workTurnCommitted       1',
        '',
        '      pass 3',
        '         knobOff                 2',
        '         lightTurn               1',
        '',
        '      1 line(s) were not decision lines and were skipped',
        '',
      ].join('\n'),
    );
  });
});

describe('the knobs', () => {
  test('enforceMode and enforceMinTurnMinutes resolve, default, and name a typo', () => {
    const fixture = workTurnFixture({
      enforce: true,
      enforceMinTurnMinutes: 7,
      enforceMode: 'workTurns',
    });
    const armed = resolveThreadConfig({
      cwd: fixture.project.path,
      env: fixture.env,
    });
    expect(armed).toMatchObject({
      enforceMinTurnMinutes: 7,
      enforceMinTurnMinutesSource: 'user',
      enforceMode: 'workTurns',
      enforceModeSource: 'user',
    });

    const typo = workTurnFixture({enforceMode: 'workturns'});
    const resolved = resolveThreadConfig({
      cwd: typo.project.path,
      env: typo.env,
    });
    expect(resolved.enforceMode).toBe('reportShaped');
    expect(resolved.enforceMinTurnMinutes).toBe(20);
    // The schema names it, and the file contributes nothing (the sdk-config rule).
    expect(resolved.problems.join('\n')).toContain(
      'componentConfig.thread.enforceMode: Invalid option',
    );
    expect(DEFAULT_COMPONENT_CONFIG.thread).toMatchObject({
      enforceMinTurnMinutes: 20,
      enforceMode: 'reportShaped',
    });
  });
});
