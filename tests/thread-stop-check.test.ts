/**
 * The Stop hook that will not let a hand-written status report pass as a
 * recorded one (home-base-p1uj.15).
 *
 * EVERY BRANCH CARRIES ITS NEGATIVE CONTROL, and the control is RUN rather than
 * described: each row in the table below names the inputs, the branch that must
 * decide them, and a one-field patch that must flip the outcome. A row whose
 * control does not flip is a row that was passing for the wrong reason — the
 * usual way a hook test goes green while the hook does nothing.
 *
 * The bar is set by what this thing can do wrong. Failing to block costs a
 * report that goes unrecorded, which is today's behaviour; blocking wrongly
 * takes a turn away from a session that did nothing wrong, and blocking twice
 * wedges it. So the loop guards and the "could not measure" paths get as much
 * coverage as the one case that blocks.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, readdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  decideStopCheck,
  describeStopCheck,
  epochMs,
  looksLikeStatusReport,
  runThreadStopCheck,
  STOP_CHECK_BLOCK_REASON,
  type StopCheckInputs,
  type StopCheckWhy,
} from '../src/thread/stop-check';
import {newestArchivedReportAt} from '../src/thread/archive';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** The delimiters the template mandates and every renderer emits. */
const REPORT_TEXT = [
  '🛑'.repeat(28),
  '',
  '**Stop reason:** ✅ Work completed',
  '**You asked me to:** build the Stop hook',
  '',
  '🕉️'.repeat(29),
].join('\n');

const SESSION_ID = '9f0c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5';

/** The one set of inputs that blocks. Every row below is this, patched once. */
const BLOCKING: StopCheckInputs = {
  agentId: null,
  archive: {kind: 'none'},
  enforce: true,
  lastAssistantMessage: REPORT_TEXT,
  lastUserMessageAt: 1_000_000,
  markerExists: false,
  sessionId: SESSION_ID,
  stopHookActive: false,
};

interface BranchCase {
  /** The one-field patch that must flip this row's outcome. */
  control: Partial<StopCheckInputs>;
  controlAction: 'block' | 'pass';
  controlWhy: StopCheckWhy;
  name: string;
  patch: Partial<StopCheckInputs>;
  why: StopCheckWhy;
  action: 'block' | 'pass';
}

const BRANCHES: BranchCase[] = [
  {
    action: 'pass',
    control: {enforce: true},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'the knob is off — nothing else can reach a block past it',
    patch: {enforce: false},
    why: 'knobOff',
  },
  {
    action: 'pass',
    control: {agentId: null},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'a subagent Stop is never blocked',
    patch: {agentId: 'agent-7f3a'},
    why: 'subagent',
  },
  {
    action: 'pass',
    control: {stopHookActive: false},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'Claude Code says a Stop hook already blocked this turn',
    patch: {stopHookActive: true},
    why: 'stopHookActive',
  },
  {
    action: 'pass',
    control: {markerExists: false},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'our own marker says we already blocked this turn',
    patch: {markerExists: true},
    why: 'markerPresent',
  },
  {
    action: 'pass',
    control: {lastAssistantMessage: REPORT_TEXT},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'the final message is not a report at all',
    patch: {lastAssistantMessage: 'Done — the tests pass.'},
    why: 'notAReport',
  },
  {
    action: 'pass',
    control: {sessionId: SESSION_ID},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'no session id to key anything by',
    patch: {sessionId: null},
    why: 'noSessionId',
  },
  {
    action: 'pass',
    control: {lastUserMessageAt: 1_000_000},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'the last user message could not be measured (UNKNOWN passes)',
    patch: {lastUserMessageAt: null},
    why: 'lastUserMessageUnknown',
  },
  {
    action: 'pass',
    control: {archive: {kind: 'none'}},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'the archive could not be read (UNKNOWN passes, never accuses)',
    patch: {archive: {error: 'readdir: EPERM', kind: 'unknown'}},
    why: 'archiveUnknown',
  },
  {
    action: 'pass',
    control: {archive: {at: 999_999, kind: 'newest'}},
    controlAction: 'block',
    controlWhy: 'notRecorded',
    name: 'a report was archived after the last user message',
    patch: {archive: {at: 1_000_001, kind: 'newest'}},
    why: 'archiveNewer',
  },
  {
    action: 'block',
    control: {archive: {at: 1_000_001, kind: 'newest'}},
    controlAction: 'pass',
    controlWhy: 'archiveNewer',
    name: 'a report was written and this session archived nothing',
    patch: {},
    why: 'notRecorded',
  },
];

describe('decideStopCheck — one row per branch, each with its negative control', () => {
  for (const branch of BRANCHES) {
    test(branch.name, () => {
      const inputs = {...BLOCKING, ...branch.patch};
      const decision = decideStopCheck(inputs);
      expect(decision.why).toBe(branch.why);
      expect(decision.action).toBe(branch.action);
      expect(decision.reason).toBe(
        branch.action === 'block' ? STOP_CHECK_BLOCK_REASON : null,
      );
      // A pass must be SILENT as well as permissive — the reason is the only
      // thing ever shown to Claude, so a non-null one on a pass would be a
      // message with no block attached to it.
      expect(describeStopCheck(decision)).toContain(
        branch.action === 'block' ? 'BLOCK' : 'pass',
      );

      // NEGATIVE CONTROL: flip the one fact this branch turned on.
      const control = decideStopCheck({...inputs, ...branch.control});
      expect(control.why).toBe(branch.controlWhy);
      expect(control.action).toBe(branch.controlAction);
      expect(control.action).not.toBe(decision.action);
    });
  }

  test('the knob outranks every other reason to block', () => {
    // Not redundant with the row above: this pins the ORDER. Everything here is
    // block-shaped and two other guards are also armed, so a branch that ran
    // ahead of `enforce` would show up as a different `why`.
    const decision = decideStopCheck({
      ...BLOCKING,
      agentId: null,
      enforce: false,
      markerExists: false,
      stopHookActive: false,
    });
    expect(decision.why).toBe('knobOff');
    expect(decideStopCheck({...BLOCKING, enforce: true}).action).toBe('block');
  });

  test('an archive written at the same instant as the message counts as newer', () => {
    // `>=`, not `>`: mtime and the transcript timestamp come from two different
    // clocks at one-millisecond resolution, and a tie is a report that WAS
    // recorded. The tie must fall on the side that does not accuse.
    expect(
      decideStopCheck({
        ...BLOCKING,
        archive: {at: 1_000_000, kind: 'newest'},
      }).action,
    ).toBe('pass');
    expect(
      decideStopCheck({
        ...BLOCKING,
        archive: {at: 999_999, kind: 'newest'},
      }).action,
    ).toBe('block');
  });

  test('a NaN timestamp is UNKNOWN, never a measurement', () => {
    expect(
      decideStopCheck({...BLOCKING, lastUserMessageAt: Number.NaN}).why,
    ).toBe('lastUserMessageUnknown');
  });
});

describe('looksLikeStatusReport', () => {
  test('both delimiters present', () => {
    expect(looksLikeStatusReport(REPORT_TEXT)).toBe(true);
    expect(looksLikeStatusReport(`\n\n${REPORT_TEXT}\n\n`)).toBe(true);
  });

  test('one delimiter is not enough', () => {
    const topOnly = REPORT_TEXT.replace('🕉️'.repeat(29), 'done');
    const bottomOnly = REPORT_TEXT.replace('🛑'.repeat(28), 'hi');
    expect(looksLikeStatusReport(topOnly)).toBe(false);
    expect(looksLikeStatusReport(bottomOnly)).toBe(false);
  });

  test('a lone badge emoji is prose, not a report', () => {
    expect(
      looksLikeStatusReport('🛑 Blocked on you — I need a decision. 🕉️'),
    ).toBe(false);
  });

  test('nothing is not a report', () => {
    expect(looksLikeStatusReport(null)).toBe(false);
    expect(looksLikeStatusReport('')).toBe(false);
  });

  test('a report that does not start with the rule is not a report', () => {
    // NEGATIVE CONTROL for the leading-whitespace allowance: only whitespace may
    // precede the rule, not prose.
    expect(looksLikeStatusReport(`Here you go:\n${REPORT_TEXT}`)).toBe(false);
  });
});

describe('newestArchivedReportAt — three states, not two', () => {
  test('no directory for this session means none, not unknown', () => {
    const sb = track(createSandbox());
    const probe = newestArchivedReportAt(SESSION_ID, {
      JUSTIN_THREADS_STATE_DIR: sb.path,
    });
    expect(probe.kind).toBe('none');
  });

  test('an archived report reports its mtime', () => {
    const sb = track(createSandbox());
    const dir = join(sb.path, 'reports', SESSION_ID);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, '2026-09-14T00-00-00-000Z.json'), '{}\n');
    const probe = newestArchivedReportAt(SESSION_ID, {
      JUSTIN_THREADS_STATE_DIR: sb.path,
    });
    expect(probe.kind).toBe('newest');
    if (probe.kind === 'newest') {
      expect(probe.at).toBeGreaterThan(0);
    }
  });

  test('an unreadable directory is unknown, not none', () => {
    // NEGATIVE CONTROL for the branch above: the same session, the same state
    // dir, one chmod apart — "I looked and found nothing" must not be how "I
    // could not look" is reported.
    const sb = track(createSandbox());
    const dir = join(sb.path, 'reports', SESSION_ID);
    mkdirSync(dir, {recursive: true});
    chmodSync(dir, 0o000);
    try {
      const probe = newestArchivedReportAt(SESSION_ID, {
        JUSTIN_THREADS_STATE_DIR: sb.path,
      });
      expect(probe.kind).toBe('unknown');
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('epochMs', () => {
  test('parses a transcript timestamp', () => {
    expect(epochMs('2026-09-14T01:57:00.000Z')).toBe(
      Date.parse('2026-09-14T01:57:00.000Z'),
    );
  });
  test('absent and unparseable are both null', () => {
    expect(epochMs(null)).toBeNull();
    expect(epochMs('')).toBeNull();
    expect(epochMs('last tuesday')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The IO wrapper, end to end
// ---------------------------------------------------------------------------

interface Captured {
  err: string;
  out: string;
}

/** Run something with console.log/console.error captured. */
function capture<T>(body: () => T): {captured: Captured; value: T} {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    const value = body();
    return {captured: {err: err.join('\n'), out: out.join('\n')}, value};
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** A project with the `enforce` knob set in a throwaway XDG user config. */
function armedSandbox(enforce: boolean): {
  env: Record<string, string | undefined>;
  project: Sandbox;
  state: Sandbox;
  transcriptPath: string;
} {
  const project = track(createProjectSandbox());
  const state = track(createSandbox());
  const xdg = track(createSandbox());
  mkdirSync(join(xdg.path, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg.path, 'justin-sdk', 'config.json'),
    `${JSON.stringify({componentConfig: {thread: {enforce}}}, null, 2)}\n`,
  );

  // A transcript whose last user message is at a known instant.
  const transcripts = track(createSandbox());
  const projectDir = join(transcripts.path, '-tmp-scratch');
  mkdirSync(projectDir, {recursive: true});
  const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        message: {content: 'wrap up please', role: 'user'},
        timestamp: '2026-09-14T10:00:00.000Z',
        type: 'user',
      }),
      JSON.stringify({
        message: {content: [{text: REPORT_TEXT, type: 'text'}], role: 'assistant'},
        timestamp: '2026-09-14T10:05:00.000Z',
        type: 'assistant',
      }),
      '',
    ].join('\n'),
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

function payload(
  fixture: ReturnType<typeof armedSandbox>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    cwd: fixture.project.path,
    hook_event_name: 'Stop',
    last_assistant_message: REPORT_TEXT,
    prompt_id: 'c0ffee00-1111-2222-3333-444444444444',
    session_id: SESSION_ID,
    transcript_path: fixture.transcriptPath,
    ...overrides,
  });
}

describe('runThreadStopCheck', () => {
  test('blocks a hand-written report once, then passes on the retry', () => {
    const fixture = armedSandbox(true);

    const first = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
    );
    expect(first.value.exitCode).toBe(2);
    expect(first.value.decision.why).toBe('notRecorded');
    expect(first.captured.err).toContain(STOP_CHECK_BLOCK_REASON);
    expect(JSON.parse(first.captured.out)).toEqual({
      decision: 'block',
      reason: STOP_CHECK_BLOCK_REASON,
      systemMessage: STOP_CHECK_BLOCK_REASON,
    });
    // The loop guard is a file, and it exists now.
    expect(readdirSync(join(fixture.state.path, 'stop-marks'))).toHaveLength(1);

    // NEGATIVE CONTROL for the marker: the identical payload a second time must
    // NOT block. A hook that blocks the same turn twice wedges the session.
    const second = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
    );
    expect(second.value.exitCode).toBe(0);
    expect(second.value.decision.why).toBe('markerPresent');
    expect(second.captured.out).toBe('');
    expect(second.captured.err).toBe('');
  });

  test('passes when a report was archived after the last user message', () => {
    const fixture = armedSandbox(true);
    const dir = join(fixture.state.path, 'reports', SESSION_ID);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'report.json'), '{}\n');

    const run = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('archiveNewer');
    expect(run.captured.out).toBe('');
  });

  test('the knob off is silent and blocks nothing', () => {
    const fixture = armedSandbox(false);
    const run = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('knobOff');
    expect(run.captured.out).toBe('');
    expect(run.captured.err).toBe('');
  });

  test('a subagent Stop is never blocked', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        stdin: payload(fixture, {agent_id: 'agent-7f3a', agent_type: 'player'}),
      }),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('subagent');
  });

  test('stop_hook_active passes even with the marker gone', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        stdin: payload(fixture, {stop_hook_active: true}),
      }),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('stopHookActive');
  });

  test('a final message that is not a report passes without touching the disk', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        stdin: payload(fixture, {last_assistant_message: 'Committed as a02701c.'}),
      }),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('notAReport');
  });

  test('a payload that is not JSON passes and says which branch decided', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: 'not json at all'}),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('unreadablePayload');
  });

  test('an unfindable transcript is UNKNOWN and passes', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        explain: true,
        stdin: payload(fixture, {transcript_path: '/nope/missing.jsonl'}),
      }),
    );
    expect(run.value.exitCode).toBe(0);
    expect(run.value.decision.why).toBe('lastUserMessageUnknown');
    expect(run.captured.err).toContain('UNKNOWN');
  });

  test('finds the transcript by session id when the payload omits the path', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        stdin: payload(fixture, {transcript_path: null}),
      }),
    );
    // Found it, measured it, and reached the real verdict — not the UNKNOWN one.
    expect(run.value.decision.why).toBe('notRecorded');
    expect(run.value.exitCode).toBe(2);
  });

  test('withholds the block when the loop guard cannot be written', () => {
    const fixture = armedSandbox(true);
    // The archive dir must stay READABLE (so the measurement succeeds and the
    // verdict really is "block") while the state dir refuses the marker write.
    const marks = join(fixture.state.path, 'stop-marks');
    mkdirSync(marks, {recursive: true});
    chmodSync(marks, 0o500);
    try {
      const run = capture(() =>
        runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
      );
      expect(run.value.exitCode).toBe(0);
      expect(run.value.decision.why).toBe('markerWriteFailed');
      expect(run.captured.out).toBe('');
      expect(run.captured.err).toContain('not blocking');
    } finally {
      chmodSync(marks, 0o755);
    }
  });

  test('--explain reports the branch and the elapsed time', () => {
    const fixture = armedSandbox(false);
    const run = capture(() =>
      runThreadStopCheck({
        env: fixture.env,
        explain: true,
        stdin: payload(fixture),
      }),
    );
    expect(run.captured.err).toContain('enforce is off');
    expect(run.captured.err).toMatch(/\d+ms/);
  });

  test('the whole run stays well under the 500ms budget', () => {
    const fixture = armedSandbox(true);
    const run = capture(() =>
      runThreadStopCheck({env: fixture.env, stdin: payload(fixture)}),
    );
    expect(run.value.elapsedMs).toBeLessThan(500);
  });
});
