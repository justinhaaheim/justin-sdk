/**
 * `thread full-report` (home-base-1rxt0.14): the UserPromptSubmit hook that
 * answers a typed `/full-report` with the full status report as the block
 * reason shown to Justin.
 *
 * Nobody can type into a live Claude Code session from a test, so this proves
 * everything up to the hook's JSON output:
 *   - the exact JSON a blocked `/full-report` emits;
 *   - knob off, or any other prompt: nothing at all;
 *   - anything thrown or failed: a hook message and NO block (fail open);
 *   - a report over Claude Code's 10,000-character hook cap is cut at a line
 *     and says so;
 *   - one real run: the dispatcher, the CLI subcommand and the report child,
 *     wired together, on a throwaway repo.
 *
 * NEGATIVE CONTROLS were run by hand behind a temporary env var and removed
 * before commit; the bead's notes record each one and what failed.
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {planDispatch, runHookDispatch} from '../src/hook-dispatch';
import {CLAUDE_CODE_HOOK_TEXT_CAP} from '../src/hook-output';
import {HOOK_HANDLERS} from '../src/hook-registry';
import {
  cutLine,
  fitFullReport,
  fullReportHook,
  type FullReportHookDeps,
  reportChildArgv,
  reportChildEnv,
  type ReportRun,
} from '../src/thread/full-report-hook';
import {createProjectSandbox, type Sandbox} from './sandbox';

const SESSION = '11111111-2222-3333-4444-555555555555';
const REPORT = '🛑🛑🛑\n\n**Status:** fine\n\n────\n';

function payload(prompt: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cwd: '/nowhere',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session_id: SESSION,
    ...extra,
  });
}

function okRun(stdout: string): ReportRun {
  return {exitCode: 0, spawnError: null, stderr: '', stdout, timedOut: false};
}

/** Deps that record their calls. */
function recording(
  knob: boolean | (() => Promise<boolean>),
  run: ReportRun | (() => Promise<ReportRun>),
) {
  const calls = {knob: 0, report: [] as {cwd: string; sessionId: string}[]};
  const deps: FullReportHookDeps = {
    knobOn: async () => {
      calls.knob += 1;
      return typeof knob === 'function' ? await knob() : knob;
    },
    runReport: async (args) => {
      calls.report.push({cwd: args.cwd, sessionId: args.sessionId});
      return typeof run === 'function' ? await run() : run;
    },
  };
  return {calls, deps};
}

async function hook(
  stdin: string,
  deps: Partial<FullReportHookDeps>,
): Promise<string> {
  return await fullReportHook({cwd: '/fallback', deps, env: {}, stdin});
}

function parsed(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('a blocked /full-report', () => {
  test('emits exactly {decision: block, reason: the report}, and nothing else', async () => {
    const {calls, deps} = recording(true, okRun(REPORT));
    const stdout = await hook(payload('/full-report'), deps);
    expect(stdout).toBe(
      `${JSON.stringify({decision: 'block', reason: REPORT.trimEnd()})}\n`,
    );
    // The report is for the payload's session, run where the session is.
    expect(calls.report).toEqual([{cwd: '/nowhere', sessionId: SESSION}]);
  });

  test('surrounding whitespace in the prompt is still /full-report', async () => {
    const {deps} = recording(true, okRun(REPORT));
    expect(parsed(await hook(payload('  /full-report\n'), deps)).decision).toBe(
      'block',
    );
  });

  test('no systemMessage: the reason is shown to Justin already, so a copy would print it twice', async () => {
    const {deps} = recording(true, okRun(REPORT));
    const json = parsed(await hook(payload('/full-report'), deps));
    expect(Object.keys(json).sort()).toEqual(['decision', 'reason']);
  });

  test('ANSI colour in the report is stripped', async () => {
    const esc = String.fromCharCode(27);
    const {deps} = recording(true, okRun(`${esc}[1mbold${esc}[0m\n`));
    expect(parsed(await hook(payload('/full-report'), deps)).reason).toBe(
      'bold',
    );
  });
});

describe('knob off, or not our prompt: nothing at all', () => {
  test('knob off: empty stdout, and the report is never run', async () => {
    const {calls, deps} = recording(false, okRun(REPORT));
    expect(await hook(payload('/full-report'), deps)).toBe('');
    expect(calls.knob).toBe(1);
    expect(calls.report).toEqual([]);
  });

  test('another prompt: empty stdout, and not even the knob is read', async () => {
    for (const prompt of [
      'hello',
      '/full-report please',
      '/full-reports',
      '',
      null,
      42,
    ]) {
      const {calls, deps} = recording(true, okRun(REPORT));
      expect(await hook(payload(prompt), deps)).toBe('');
      expect(calls.knob).toBe(0);
    }
  });

  test('an unreadable payload: empty stdout', async () => {
    const {calls, deps} = recording(true, okRun(REPORT));
    expect(await hook('not json', deps)).toBe('');
    expect(await hook('', deps)).toBe('');
    expect(calls.knob).toBe(0);
  });
});

describe('fail open: an error never blocks the prompt', () => {
  async function failOpen(
    deps: Partial<FullReportHookDeps>,
    stdin: string = payload('/full-report'),
  ): Promise<string> {
    const stdout = await hook(stdin, deps);
    const json = parsed(stdout);
    expect(json.decision).toBeUndefined();
    expect(json.reason).toBeUndefined();
    expect(json.hookSpecificOutput).toBeUndefined();
    const message = json.systemMessage as string;
    expect(message).toStartWith('⚠️ /full-report could not answer by itself: ');
    expect(message).toContain('Your prompt went to Claude instead');
    return message;
  }

  test('the knob read throws', async () => {
    const {deps} = recording(
      () => Promise.reject(new Error('config exploded')),
      okRun(REPORT),
    );
    expect(await failOpen(deps)).toContain('it threw (config exploded)');
  });

  test('the report run throws', async () => {
    const {deps} = recording(true, () =>
      Promise.reject(new Error('spawn exploded')),
    );
    expect(await failOpen(deps)).toContain('it threw (spawn exploded)');
  });

  test('the report command fails: its exit code and first stderr line are named', async () => {
    const {deps} = recording(true, {
      exitCode: 1,
      spawnError: null,
      stderr: '\nthread status: no session bead for this session\nmore\n',
      stdout: '',
      timedOut: false,
    });
    expect(await failOpen(deps)).toContain(
      'failed (exit 1): thread status: no session bead for this session',
    );
  });

  test('the report command hangs past the limit', async () => {
    const {deps} = recording(true, {
      exitCode: null,
      spawnError: null,
      stderr: '',
      stdout: 'half a rep',
      timedOut: true,
    });
    expect(await failOpen(deps)).toContain('was stopped after 20 s');
  });

  test('the report command does not start', async () => {
    const {deps} = recording(true, {
      exitCode: null,
      spawnError: 'ENOENT',
      stderr: '',
      stdout: '',
      timedOut: false,
    });
    expect(await failOpen(deps)).toContain('did not start (ENOENT)');
  });

  test('the report command prints nothing', async () => {
    const {deps} = recording(true, okRun('  \n'));
    expect(await failOpen(deps)).toContain('printed nothing');
  });

  test('the payload has no session_id', async () => {
    const {calls, deps} = recording(true, okRun(REPORT));
    expect(
      await failOpen(deps, payload('/full-report', {session_id: undefined})),
    ).toContain('no session_id');
    expect(calls.report).toEqual([]);
  });
});

describe('the 10,000-character cap', () => {
  /** A report shaped like a real one: ~13 KB over ~240 lines, with emoji. */
  function bigReport(): string {
    return Array.from(
      {length: 240},
      (_, i) => `🟡 P2 · line ${i + 1} ${'x'.repeat(48)}`,
    ).join('\n');
  }

  test('a report that fits is the reason unchanged', () => {
    expect(fitFullReport(REPORT, SESSION)).toBe(REPORT.trimEnd());
  });

  test('a report over the cap fits, keeps whole leading lines, and ends saying how to see the rest', () => {
    const report = bigReport();
    expect(report.length).toBeGreaterThan(CLAUDE_CODE_HOOK_TEXT_CAP);
    const fitted = fitFullReport(report, SESSION);
    expect(fitted.length).toBeLessThanOrEqual(CLAUDE_CODE_HOOK_TEXT_CAP);

    const lines = fitted.split('\n');
    const last = lines.at(-1) ?? '';
    const kept = lines.slice(0, -2);
    expect(lines.at(-2)).toBe('');
    // Whole lines, in order, from the top: nothing cut mid-line.
    expect(kept).toEqual(report.split('\n').slice(0, kept.length));
    const hidden = 240 - kept.length;
    expect(hidden).toBeGreaterThan(0);
    expect(last).toBe(cutLine(hidden, SESSION, CLAUDE_CODE_HOOK_TEXT_CAP));
    expect(last).toContain(`${hidden} more lines not shown`);
    expect(last).toContain(
      `bun run justin-sdk thread status --full --session ${SESSION}`,
    );
  });

  test('it keeps as much as fits: one more line would not', () => {
    const report = bigReport();
    const fitted = fitFullReport(report, SESSION);
    const kept = fitted.split('\n').slice(0, -2);
    const withOneMore = [
      ...report.split('\n').slice(0, kept.length + 1),
      '',
      cutLine(240 - kept.length - 1, SESSION, CLAUDE_CODE_HOOK_TEXT_CAP),
    ].join('\n');
    expect(withOneMore.length).toBeGreaterThan(CLAUDE_CODE_HOOK_TEXT_CAP);
  });

  test('one line longer than the cap: only the cut line, still under the cap', () => {
    const fitted = fitFullReport(
      'y'.repeat(CLAUDE_CODE_HOOK_TEXT_CAP * 2),
      SESSION,
    );
    expect(fitted).toBe(cutLine(1, SESSION, CLAUDE_CODE_HOOK_TEXT_CAP));
    expect(fitted).toContain('1 more line not shown');
  });

  test('the blocked JSON carries the fitted report', async () => {
    const {deps} = recording(true, okRun(bigReport()));
    const reason = parsed(await hook(payload('/full-report'), deps))
      .reason as string;
    expect(reason.length).toBeLessThanOrEqual(CLAUDE_CODE_HOOK_TEXT_CAP);
    expect(reason).toContain('more lines not shown');
  });
});

describe('the report child', () => {
  test('runs thread status --full for the payload session, read-only', () => {
    const argv = reportChildArgv(SESSION);
    expect(argv.slice(1, 2)[0]).toEndWith('/src/cli.ts');
    expect(argv.slice(2)).toEqual([
      'thread',
      'status',
      '--full',
      '--session',
      SESSION,
    ]);
    const env = reportChildEnv({
      CLAUDE_CODE_SESSION_ID: SESSION,
      HOME: '/home/x',
    });
    // Not the session's own run: no snapshot, no trim-guard block, no ids.
    expect('CLAUDE_CODE_SESSION_ID' in env).toBe(false);
    expect(env.NO_COLOR).toBe('1');
    expect(env.HOME).toBe('/home/x');
    expect(env.JUSTIN_SDK_HEALTH_NOTICES).toBe('off');
  });
});

describe('one real run: dispatcher → thread full-report → thread status', () => {
  const sandboxes: Sandbox[] = [];
  const xdg = mkdtempSync(join(tmpdir(), 'jsdk-full-report-xdg-'));
  afterAll(() => {
    for (const sandbox of sandboxes) sandbox.cleanup();
    rmSync(xdg, {force: true, recursive: true});
  });

  /**
   * A throwaway repo whose project config sets the knob. Session beads are
   * off there, so `thread status` answers SESSION BEADS: DISABLED (exit 0):
   * a real report child, with no session state to read or write.
   */
  function repo(fullReportCommand: boolean): string {
    const sandbox = createProjectSandbox({
      justinSdkConfig: {componentConfig: {thread: {fullReportCommand}}},
    });
    sandboxes.push(sandbox);
    return sandbox.path;
  }

  const onlyFullReport = HOOK_HANDLERS.filter(
    (h) => h.id === 'thread full-report',
  );

  async function dispatch(root: string, prompt: string) {
    return await runHookDispatch({
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        XDG_CONFIG_HOME: xdg,
        XDG_STATE_HOME: join(xdg, 'state'),
      },
      event: 'UserPromptSubmit',
      // Only this handler: the real capture, time-check and the rest would
      // write state for a made-up session.
      handlers: onlyFullReport,
      stdin: JSON.stringify({
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        session_id: SESSION,
      }),
    });
  }

  test('knob on: the prompt is blocked with what thread status printed', async () => {
    const out = await dispatch(repo(true), '/full-report');
    expect(out.exitCode).toBe(0);
    const json = parsed(out.stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toStartWith('SESSION BEADS: DISABLED');
    expect(json.systemMessage).toBeUndefined();
  }, 30_000);

  test('knob off: the dispatcher prints nothing, so the prompt goes through', async () => {
    const out = await dispatch(repo(false), '/full-report');
    expect(out).toEqual({exitCode: 0, stderr: '', stdout: ''});
  }, 30_000);

  test('any other prompt: the dispatcher does not even start the handler', () => {
    const root = repo(true);
    const plan = (prompt: string) => {
      const result = planDispatch({
        env: {CLAUDE_PROJECT_DIR: root},
        event: 'UserPromptSubmit',
        handlers: onlyFullReport,
        stdin: JSON.stringify({cwd: root, prompt}),
      });
      return result.ok ? result.handlers.map((h) => h.id) : result.reason;
    };
    expect(plan('/full-report')).toEqual(['thread full-report']);
    expect(plan('hello')).toEqual([]);
    expect(plan('/full-report now')).toEqual([]);
  });
});
