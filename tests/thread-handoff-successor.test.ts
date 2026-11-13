/**
 * `thread handoff` with and without componentConfig.thread.handoff.successor
 * (home-base-mbnjv.2). Real br and the real handOff() in $TMPDIR workspaces;
 * cmux, the gate and the clock are injected fakes, so no test reaches the
 * real cmux, reads a real screen, or opens anything. The three screens in
 * tests/fixtures/handoff-successor/ are real: captured by the M1 measurement
 * (2026-10-29, Claude Code 2.1.312, a throwaway cmux workspace).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {HandoffGateResult} from '../src/thread/handoff-gate';
import type {
  PredecessorWatch,
  WatcherStart,
} from '../src/thread/handoff-predecessor';
import type {ThreadHandoffCommandOptions} from '../src/thread/handoff-successor';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, brUpdate, runBr} from '../src/beads/br';
import {stripAnsi} from '../src/check-runner';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {
  handoffDeferralMessage,
  readLaunchRecord,
  runHandoffGate,
} from '../src/thread/handoff-gate';
import {
  classifySuccessorScreen,
  HANDOFF_DEFERRED_SUMMARY_NEXT,
  HANDOFF_REFUSED_SUMMARY_NEXT,
  HANDOFF_STEP_FAILED_INSTRUCTIONS,
  parseNewSurface,
  SANDBOXED_CALL_INSTRUCTIONS,
  SUCCESSOR_STARTED_NEXT,
  successorClaudeWords,
  successorCommand,
  successorName,
  threadHandoffCommand,
} from '../src/thread/handoff-successor';
import {handoffSummary} from '../src/thread/handoff-summary';
import {serializeMessageLine} from '../src/thread/message-log';
import {NO_BREAK_SPACE} from '../src/thread/pane-join';
import {predecessorWatchSchema} from '../src/thread/predecessor-watch';
import {fileRequest} from '../src/thread/request';
import {
  kickoffText,
  TYPED_COMMAND_BYTE_LIMIT,
  zshWord,
} from '../src/thread/respawn';
import {ensureSessionBead, MAYOR_ROLE_LABEL} from '../src/thread/session-bead';
import {describeHandoffOutcome, handOff} from '../src/thread/session-handoff';
import {selectSession} from '../src/thread/session-select';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-0000000000a1';
const WS = 'AAAA0000-1111-4222-8333-0000000000b2';
const SURF = 'CCCC0000-1111-4222-8333-0000000000c3';
const PANE = 'DDDD0000-1111-4222-8333-0000000000d4';
const SOCK = '/tmp/handoff-successor-test/cmux.sock';
const NOW = new Date('2030-01-01T10:00:00.000Z');

const FIXTURES = join(import.meta.dir, 'fixtures', 'handoff-successor');
const screen = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const TRUST_DIALOG = screen('trust-dialog.txt');
const ZSH_BEFORE_CLAUDE = screen('zsh-before-claude.txt');
const CLAUDE_UP = screen('claude-up-working.txt');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string;
  env: Record<string, string | undefined>;
  repo: string;
  stateDir: string;
}

function world(handoff: Record<string, unknown> | null): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  const thread: Record<string, unknown> = {enabled: true, sessionBeads: true};
  if (handoff != null) thread.handoff = handoff;
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread}}),
  );
  const stateDir = join(sb.path, 'state');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: OLD,
    CMUX_SOCKET_PATH: SOCK,
    CMUX_SURFACE_ID: SURF,
    CMUX_WORKSPACE_ID: WS,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'handoff-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: OLD,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  // home-base-6n7my.2 D3: a first session's log says it began on his words, so
  // its successor is #1. Without a log the number is unknown.
  const logPath = messageLogPath(OLD, env);
  mkdirSync(dirname(logPath), {recursive: true});
  writeFileSync(
    logPath,
    serializeMessageLine({
      at: '2030-01-01T09:00:00.000Z',
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text: 'migrate the db',
    }),
  );
  return {beadId: filed.beadId, env, repo, stateDir};
}

const ON = {successor: true};

/** The tree JSON cmux prints for --workspace WS: one pane holding SURF. */
const TREE = JSON.stringify({
  windows: [
    {
      workspaces: [
        {
          id: WS,
          panes: [
            {
              id: PANE,
              ref: 'pane:285',
              surfaces: [{id: SURF, ref: 'surface:300'}],
            },
          ],
          ref: 'workspace:191',
        },
      ],
    },
  ],
});

/**
 * A fake cmux: records every call. `tree` answers TREE, `new-surface` the
 * measured "OK surface:306 pane:285 workspace:191", `rename-tab` OK, and
 * `read-screen` the next of `screens` (the last one repeats).
 */
function fakeCmux(
  input: {
    newSurface?: CmuxCall;
    /** `rename-tab`'s answer (mbnjv.3); default OK. */
    renameTab?: CmuxCall;
    screens?: string[];
    tree?: CmuxCall;
  } = {},
) {
  const calls: string[][] = [];
  const screens = input.screens ?? [CLAUDE_UP];
  let read = 0;
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    if (args.includes('tree')) {
      return Promise.resolve(input.tree ?? {kind: 'ok', stdout: TREE});
    }
    if (args[0] === 'new-surface') {
      return Promise.resolve(
        input.newSurface ?? {
          kind: 'ok',
          stdout: 'OK surface:306 pane:285 workspace:191\n',
        },
      );
    }
    if (args[0] === 'rename-tab') {
      return Promise.resolve(input.renameTab ?? {kind: 'ok', stdout: 'OK\n'});
    }
    if (args[0] === 'read-screen') {
      const text = screens[Math.min(read, screens.length - 1)] ?? '';
      read += 1;
      return Promise.resolve({kind: 'ok', stdout: text});
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `the fake cmux does not know ${args.join(' ')}`,
      timedOut: false,
    });
  };
  return {calls, run};
}

/** A fake clock: sleep advances it, so a timeout costs no real time. */
function fakeTime() {
  let now = 0;
  return {
    clock: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const PASS: HandoffGateResult = {
  facts: {
    chain: {kind: 'skipped'},
    guardPassNote: null,
    liveSessions: {
      bySource: {agents: 0, hookStore: 0, ps: 3, screen: 0},
      kind: 'counted',
      sessionIds: 3,
      total: 3,
      unplaced: {background: 0, pane: 0, process: 0},
    },
    surfaceId: SURF,
    usage: {
      ageMinutes: 10,
      sampledAt: '2030-01-01T09:50:00.000Z',
      sessionPercent: 10,
      weekPercent: 20,
    },
    workspaceId: WS,
  },
  kind: 'pass',
};

const REFUSED: HandoffGateResult = {
  detail: 'the 5-hour session window is at 91 % (ceiling 85 %)',
  kind: 'refused',
  message:
    'handoff refused: usageHigh: the 5-hour session window is at 91 % (ceiling 85 %)\n\nNo successor was started.',
  ranInSandbox: false,
  reason: 'usageHigh',
};

function gateOf(result: HandoffGateResult) {
  const seen: unknown[] = [];
  const gate = (input: unknown) => {
    seen.push(input);
    return Promise.resolve(result);
  };
  return {gate, seen};
}

function opts(
  w: World,
  more: Partial<ThreadHandoffCommandOptions> = {},
): ThreadHandoffCommandOptions {
  return {
    cwd: w.repo,
    dryRun: false,
    env: w.env,
    model: null,
    note: 'pick up at step 3',
    now: NOW,
    sessionId: null,
    // The output does not depend on whether the test's stdout is a TTY.
    style: PLAIN_STYLE,
    to: null,
    ...more,
  };
}

function deps(
  cmux: ReturnType<typeof fakeCmux>,
  gate: ReturnType<typeof gateOf>,
) {
  return {
    ...fakeTime(),
    gate: gate.gate,
    run: cmux.run,
    successorPollMs: 500,
    successorTimeoutMs: 2000,
  };
}

function bead(w: World) {
  const shown = brShow({cwd: w.repo}, w.beadId);
  if (shown.kind !== 'ok') throw new Error(`br show: ${shown.kind}`);
  return shown.issue;
}

/**
 * home-base-9ihcl.6: the summary's commands start in the session's checkout,
 * so they work from any terminal (a bare `bun run justin-sdk` outside a repo
 * reaches whatever justin-sdk is on PATH).
 */
function inRepo(w: World): string {
  const selected = selectSession({
    env: w.env,
    selector: null,
    sessionIdOption: null,
  });
  if (selected.kind !== 'found') throw new Error(selected.kind);
  const checkout = selected.session.checkoutPath;
  if (checkout == null) throw new Error('no checkout recorded');
  return `cd ${zshWord(checkout)} && `;
}

const handoffsDir = (w: World) => join(w.stateDir, 'handoffs');
const blockPathOf = (w: World) => join(handoffsDir(w), `${OLD}.md`);

/** Every call that could open, type into or close something: none allowed. */
function writeCalls(calls: readonly string[][]): string[][] {
  const readOnly = (args: readonly string[]) =>
    args.includes('tree') || args[0] === 'read-screen' || args[0] === 'ping';
  return calls.filter((args) => !readOnly(args));
}

// ---------------------------------------------------------------------------

describe('knob off (D10): thread handoff exactly as before', () => {
  test('routes to handOff() and prints describeHandoffOutcome(), byte for byte', async () => {
    const w = world(null);
    const fixed = {
      block: '🤝 **HANDOFF** — fixed block',
      followUpFailures: [],
      kind: 'handedOff' as const,
      requests: {kind: 'counted' as const, open: 1, total: 2},
      successor: {kind: 'noBeadYet' as const, sessionId: 'abc'},
    };
    const asked: unknown[] = [];
    const cmux = fakeCmux();
    const gate = gateOf(PASS);
    const result = await threadHandoffCommand(opts(w, {to: 'abc'}), {
      ...deps(cmux, gate),
      handOff: (input) => {
        asked.push(input);
        return Promise.resolve(fixed);
      },
    });
    const expected = describeHandoffOutcome(fixed);
    expect(result.exitCode).toBe(expected.exitCode);
    expect(result.lines).toEqual(expected.lines);
    expect(asked).toEqual([
      {
        cwd: w.repo,
        env: w.env,
        note: 'pick up at step 3',
        now: NOW,
        sessionId: null,
        to: 'abc',
      },
    ]);
    expect(cmux.calls).toEqual([]);
    expect(gate.seen).toEqual([]);
  });

  test('a real handoff: the same lines and the same bead as the old path, no tab, no file', async () => {
    const before = world(null);
    const legacy = describeHandoffOutcome(
      await handOff({
        cwd: before.repo,
        env: before.env,
        note: 'pick up at step 3',
        now: NOW,
        sessionId: null,
        to: null,
      }),
    );
    const w = world(null);
    const cmux = fakeCmux();
    const gate = gateOf(PASS);
    const result = await threadHandoffCommand(opts(w), deps(cmux, gate));
    const normalise = (lines: string[], id: string) =>
      lines.map((line) => line.replaceAll(id, '<BEAD>'));
    expect(result.exitCode).toBe(0);
    expect(result.exitCode).toBe(legacy.exitCode);
    expect(normalise(result.lines, w.beadId)).toEqual(
      normalise(legacy.lines, before.beadId),
    );
    expect(bead(w).labels).toEqual(bead(before).labels);
    expect(bead(w).notes).toBe(bead(before).notes);
    expect(bead(w).labels).toContain('handed-off');
    expect(cmux.calls).toEqual([]);
    expect(gate.seen).toEqual([]);
    expect(existsSync(handoffsDir(w))).toBe(false);
  });

  test('--dry-run and --model are refused with exit 2 and nothing written', async () => {
    for (const more of [{dryRun: true}, {model: 'haiku'}]) {
      const w = world(null);
      const cmux = fakeCmux();
      const result = await threadHandoffCommand(
        opts(w, more),
        deps(cmux, gateOf(PASS)),
      );
      expect(result.exitCode).toBe(2);
      expect(result.lines.join('\n')).toContain(
        'needs componentConfig.thread.handoff.successor on',
      );
      expect(bead(w).labels).not.toContain('handed-off');
      expect(cmux.calls).toEqual([]);
    }
  });
});

describe('knob on: refusals before anything is written (exit 2)', () => {
  test('--session naming another session refuses; nothing written, no gate', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const gate = gateOf(PASS);
    const other = '0e400000-1111-4222-8333-00000000ffff';
    const result = await threadHandoffCommand(
      opts(w, {sessionId: other}),
      deps(cmux, gate),
    );
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain(
      `--session ${other} is not the session this runs in (${OLD})`,
    );
    expect(gate.seen).toEqual([]);
    expect(cmux.calls).toEqual([]);
    expect(bead(w).labels).not.toContain('handed-off');
  });

  test('--session naming this session is fine', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w, {sessionId: OLD}),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
  });

  test("this tab's pane is not in the workspace: exit 2, nothing written", async () => {
    const w = world(ON);
    const tree = TREE.replace(SURF, 'EEEE0000-1111-4222-8333-0000000000e5');
    const cmux = fakeCmux({tree: {kind: 'ok', stdout: tree}});
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain(
      `surface ${SURF} is not in workspace ${WS}`,
    );
    expect(writeCalls(cmux.calls)).toEqual([]);
    expect(bead(w).labels).not.toContain('handed-off');
    expect(existsSync(handoffsDir(w))).toBe(false);
  });

  test('home-base-8vywn: a claude line of 1,000 bytes or more is refused; nothing written, no gate, no cmux, dry run too', async () => {
    for (const dryRun of [false, true]) {
      const w = world(ON);
      const cmux = fakeCmux();
      const gate = gateOf(PASS);
      const model = 'm'.repeat(TYPED_COMMAND_BYTE_LIMIT);
      const result = await threadHandoffCommand(
        opts(w, {dryRun, model}),
        deps(cmux, gate),
      );
      expect(result.exitCode).toBe(2);
      const text = result.lines.join('\n');
      expect(text).toContain('thread handoff: refused:');
      expect(text).toContain('bytes');
      expect(text).toContain('Nothing was written.');
      expect(gate.seen).toEqual([]);
      expect(cmux.calls).toEqual([]);
      expect(bead(w).labels).not.toContain('handed-off');
      expect(existsSync(handoffsDir(w))).toBe(false);
    }
  });

  test('--to links only, as before: no gate, no cmux', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const gate = gateOf(PASS);
    const result = await threadHandoffCommand(
      opts(w, {to: '0e400000-1111-4222-8333-00000000aaaa'}),
      deps(cmux, gate),
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('has no session bead yet');
    expect(gate.seen).toEqual([]);
    expect(cmux.calls).toEqual([]);
    expect(bead(w).labels).toContain('handed-off');
  });
});

describe('knob on: the gate refuses (exit 3, C2)', () => {
  test('hands off, records the refusal, prints the block and the message, opens nothing', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(REFUSED)),
    );
    expect(result.exitCode).toBe(3);
    expect(result.launch).toBeNull();
    const text = result.lines.join('\n');
    expect(text).toContain('🤝 **HANDOFF**');
    expect(text).toContain('pick up at step 3');
    expect(text).toContain(
      `Recorded on ${w.beadId}: handoff refused: usageHigh — the 5-hour session window is at 91 % (ceiling 85 %)`,
    );
    // home-base-9ihcl.6: the refusal, what to end the turn with, the summary.
    expect(result.lines.slice(-5)).toEqual([
      REFUSED.message,
      '',
      HANDOFF_REFUSED_SUMMARY_NEXT,
      '',
      [
        '🤝 **Handed off**',
        '',
        '- **This session:** the first session of its chain (no number)',
        '- **New tab:** none opened: the handoff was refused (usageHigh): the 5-hour session window is at 91 % (ceiling 85 %)',
        '- **Requests:** none filed',
        `- **Full report:** \`${inRepo(w)}bun run justin-sdk thread show ${w.beadId}\``,
      ].join('\n'),
    ]);
    const issue = bead(w);
    expect(issue.labels).toContain('handed-off');
    expect(issue.labels).toContain('handoff-refused');
    expect(issue.notes).toContain('handoff refused: usageHigh —');
    expect(cmux.calls).toEqual([]);
    expect(existsSync(handoffsDir(w))).toBe(false);
  });

  test('cmux answered Operation not permitted: the call ran inside the sandbox, exit 2, NOTHING written (mbnjv.9 design 3, F9)', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const sandboxed: HandoffGateResult = {
      detail:
        'this call ran inside the Claude Code sandbox, so it could not reach cmux (the socket answered Operation not permitted). cmux said: … (Operation not permitted, errno 1)',
      kind: 'refused',
      message: 'unused: exit 2 prints its own lines',
      ranInSandbox: true,
      reason: 'cmuxUnreachable',
    };
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(sandboxed)),
    );
    expect(result.exitCode).toBe(2);
    expect(result.launch).toBeNull();
    const text = result.lines.join('\n');
    expect(text).toContain(
      'thread handoff: refused: this call ran inside the Claude Code sandbox',
    );
    expect(text).toContain('Nothing was written.');
    for (const line of SANDBOXED_CALL_INSTRUCTIONS)
      expect(text).toContain(line);
    // Nothing written: no handoff, no refusal, no block, no cmux call.
    const issue = bead(w);
    expect(issue.labels).not.toContain('handed-off');
    expect(issue.labels).not.toContain('handoff-refused');
    expect(cmux.calls).toEqual([]);
    expect(existsSync(handoffsDir(w))).toBe(false);
  });
});

describe('knob on: the gate passes', () => {
  test('a tab mark that fails is reported and the exit stays 0 (mbnjv.3)', async () => {
    const w = world(ON);
    const cmux = fakeCmux({
      renameTab: {
        kind: 'failed',
        reason: 'cmux rename-tab failed: boom',
        timedOut: false,
      },
      screens: [CLAUDE_UP],
    });
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      '⚠️ not marked handed off: cmux rename-tab failed: boom',
    );
  });

  test('exit 0: the exact new-surface argv, the block file, and the next step', async () => {
    const w = world(ON);
    const cmux = fakeCmux({screens: [ZSH_BEFORE_CLAUDE, CLAUDE_UP]});
    const result = await threadHandoffCommand(
      opts(w, {model: 'haiku'}),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);

    const selected = selectSession({
      env: w.env,
      selector: null,
      sessionIdOption: null,
    });
    if (selected.kind !== 'found') throw new Error(selected.kind);
    const {session} = selected;
    const name = successorName(session, w.env);
    expect(name).toBe('[HANDOFF-REPO][#1] migrate the db');
    const blockPath = blockPathOf(w);
    const kickoff = kickoffText(blockPath, w.beadId, null);
    expect(kickoff).toContain(
      `bun run justin-sdk thread request --continues ${w.beadId}`,
    );
    expect(kickoff.startsWith('/')).toBe(false);

    expect(cmux.calls[0]).toEqual([
      '--json',
      '--id-format',
      'both',
      'tree',
      '--workspace',
      WS,
    ]);
    expect(cmux.calls[1]).toEqual([
      'new-surface',
      '--workspace',
      WS,
      '--pane',
      PANE,
      '--working-directory',
      session.checkoutPath,
      '--command',
      `claude --permission-mode auto --remote-control '[HANDOFF-REPO][#1] migrate the db' --name '[HANDOFF-REPO][#1] migrate the db' --model haiku 'You are the successor of a handed-off Claude Code session. Read ${blockPath}. First run the command under its pick-up section: bun run justin-sdk thread request --continues ${w.beadId}. Every open request and question carries over to this session; the note is the order to take them in, not the whole scope. Then continue the work the block describes, starting from its note.'`,
      '--focus',
      'false',
    ]);
    expect(cmux.calls.slice(2)).toEqual([
      ['read-screen', '--workspace', WS, '--surface', 'surface:306'],
      ['read-screen', '--workspace', WS, '--surface', 'surface:306'],
      // mbnjv.3 (D8, AC4): the caller's own tab, CMUX_SURFACE_ID, is marked.
      [
        'rename-tab',
        '--workspace',
        WS,
        '--surface',
        SURF,
        '--',
        // home-base-9ihcl.10: the original of a chain names its successor's
        // number, and its own name carries no H mark.
        '↪ handed off to #1: [HANDOFF-REPO] migrate the db',
      ],
    ]);
    // AC4: no rename call targets any other surface (not the successor's).
    const renames = cmux.calls.filter((call) => call[0] === 'rename-tab');
    expect(renames).toHaveLength(1);
    expect(renames[0]?.[4]).toBe(w.env.CMUX_SURFACE_ID);
    expect(result.lines.join('\n')).toContain(
      'renamed "↪ handed off to #1: [HANDOFF-REPO] migrate the db"',
    );

    expect(bead(w).labels).toContain('handed-off');
    const block = readFileSync(blockPath, 'utf8');
    expect(block).toContain('🤝 **HANDOFF**');
    expect(block).toContain('pick up at step 3');

    const text = result.lines.join('\n');
    expect(text).toContain(blockPath);
    expect(text).toContain('surface:306 "[HANDOFF-REPO][#1] migrate the db"');
    // home-base-9ihcl.6: the next step, then the short summary, last.
    expect(result.lines.at(-3)).toBe(SUCCESSOR_STARTED_NEXT);
    expect(result.lines.at(-1)).toBe(
      [
        '🤝 **Handed off**',
        '',
        '- **This session:** the first session of its chain (no number)',
        `- **New tab:** #1 opened. Focus it: \`${inRepo(w)}bun run justin-sdk thread focus ${w.beadId}\``,
        '- **Requests:** none filed',
        `- **Full report:** \`${inRepo(w)}bun run justin-sdk thread show ${w.beadId}\``,
      ].join('\n'),
    );
    expect(result.launch).toEqual({
      blockPath,
      caller: {paneId: PANE, surfaceId: SURF, workspaceId: WS},
      name,
      successor: {
        paneRef: 'pane:285',
        surfaceRef: 'surface:306',
        workspaceRef: 'workspace:191',
      },
    });
  });

  test('the permission mode comes from the knob', async () => {
    const w = world({permissionMode: 'acceptEdits', successor: true});
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    expect(cmux.calls[1]?.[8]).toStartWith(
      'claude --permission-mode acceptEdits --remote-control ',
    );
  });

  test('zsh receives every word of the claude line literally', () => {
    const tricky = `it's "$HOME" and \`date\` =ls`;
    const words = successorClaudeWords({
      kickoff: tricky,
      model: 'haiku',
      name: `[R] a 'quoted' $name`,
      permissionMode: 'auto',
    });
    const probe = successorCommand(words).replace(
      /^claude /u,
      `printf '%s\\n' `,
    );
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
    });
    expect(printed).toBe(`${words.slice(1).join('\n')}\n`);
  });

  test('a dialog on screen: exit 1, the screen quoted, nothing answered', async () => {
    const w = world(ON);
    const cmux = fakeCmux({screens: [ZSH_BEFORE_CLAUDE, TRUST_DIALOG]});
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain(
      'the successor tab surface:306 ("[HANDOFF-REPO][#1] migrate the db") is waiting on the folder-trust dialog',
    );
    expect(text).toContain('Nothing was answered and no key was sent');
    expect(text).toContain(
      '│  Quick safety check: Is this a project you created',
    );
    expect(text).toContain('│  ❯ No, exit');
    expect(text).toContain(`the block is in ${blockPathOf(w)}`);
    expect(text).toContain('🤝 **HANDOFF**');
    expect(result.lines.slice(-3)).toEqual([
      ...HANDOFF_STEP_FAILED_INSTRUCTIONS,
    ]);
    // new-surface is the only call that is not a read: no send, no send-key.
    expect(writeCalls(cmux.calls).map((args) => args[0])).toEqual([
      'new-surface',
    ]);
    expect(result.launch?.successor.surfaceRef).toBe('surface:306');
  });

  test('a screen that never shows Claude Code: exit 1, the last screen quoted', async () => {
    const w = world(ON);
    const cmux = fakeCmux({screens: [ZSH_BEFORE_CLAUDE]});
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain(
      'could not confirm the successor started within 2 s (tab surface:306, "[HANDOFF-REPO][#1] migrate the db"): no Claude Code input box on the screen',
    );
    expect(text).toContain('The last screen:');
    expect(text).toContain('│ Last login:');
    // 0, 500, 1000, 1500, 2000 ms: five reads, then the time is up.
    const reads = cmux.calls.filter((args) => args[0] === 'read-screen');
    expect(reads).toHaveLength(5);
    expect(writeCalls(cmux.calls).map((args) => args[0])).toEqual([
      'new-surface',
    ]);
  });

  test('new-surface failing: exit 1, says the session WAS handed off and where the block is', async () => {
    const w = world(ON);
    const cmux = fakeCmux({
      newSurface: {
        kind: 'failed',
        reason: 'cmux new-surface --workspace x failed: Error: pane not found',
        timedOut: false,
      },
    });
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('the session WAS handed off');
    expect(text).toContain(`the block is in ${blockPathOf(w)}`);
    expect(text).toContain('Error: pane not found');
    expect(existsSync(blockPathOf(w))).toBe(true);
    expect(bead(w).labels).toContain('handed-off');
    expect(cmux.calls.filter((args) => args[0] === 'read-screen')).toEqual([]);
    expect(result.launch).toBeNull();
  });

  test('new-surface exiting 0 without a surface ref is a failure, not a start', async () => {
    const w = world(ON);
    const cmux = fakeCmux({newSurface: {kind: 'ok', stdout: ''}});
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('cmux printed ""');
  });
});

describe('home-base-9ihcl.10 and .6: the old tab names its own place, and the run ends with the short summary', () => {
  /** This session as the #2 of a mayor chain (the labels a link writes). */
  function h2Mayor(w: World): void {
    const written = brUpdate({cwd: w.repo}, w.beadId, {
      addLabels: ['continues:t-earlier', 'handoff-number:2', MAYOR_ROLE_LABEL],
    });
    if (written.kind === 'failed') throw new Error('br update failed');
  }

  test('exit 0 from #2: the old tab reads #2 handed off to #3, the new tab #3, and no two tabs share a number', async () => {
    const w = world(ON);
    h2Mayor(w);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    const opened = cmux.calls.find((call) => call[0] === 'new-surface') ?? [];
    const command = opened[opened.indexOf('--command') + 1] ?? '';
    expect(command).toContain(
      "--name '[MAYOR][HANDOFF-REPO][#3] migrate the db'",
    );
    const renames = cmux.calls.filter((call) => call[0] === 'rename-tab');
    expect(renames).toEqual([
      [
        'rename-tab',
        '--workspace',
        WS,
        '--surface',
        SURF,
        '--',
        '↪ #2 handed off to #3: [MAYOR][HANDOFF-REPO] migrate the db',
      ],
    ]);
    // The negative-control target: the old title carries the successor's
    // name (and so its [#3]) if the successor's name is put back.
    const oldTitle = renames[0]?.at(-1) ?? '';
    expect(oldTitle).not.toContain('[#3] migrate the db');
    expect(oldTitle.match(/#\d+/gu)).toEqual(['#2', '#3']);
    expect(result.launch?.name).toBe(
      '[MAYOR][HANDOFF-REPO][#3] migrate the db',
    );

    expect(result.lines.at(-1)).toBe(
      [
        '🤝 **Handed off**',
        '',
        '- **This session:** #2',
        `- **New tab:** #3 opened. Focus it: \`${inRepo(w)}bun run justin-sdk thread focus ${w.beadId}\``,
        '- **Requests:** none filed',
        `- **Full report:** \`${inRepo(w)}bun run justin-sdk thread show ${w.beadId}\``,
      ].join('\n'),
    );
  });

  test('a session whose number cannot be established: #? on both sides, never a guess', async () => {
    const w = world(ON);
    // continues another bead, no number label, and that bead does not exist.
    const written = brUpdate({cwd: w.repo}, w.beadId, {
      addLabels: ['continues:t-missing'],
    });
    if (written.kind === 'failed') throw new Error('br update failed');
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    const renames = cmux.calls.filter((call) => call[0] === 'rename-tab');
    expect(renames[0]?.at(-1)).toBe(
      '↪ #? handed off to #?: [HANDOFF-REPO] migrate the db',
    );
    const summary = result.lines.at(-1) ?? '';
    expect(summary).toContain('- **This session:** #? (unknown: ');
    expect(summary).toContain('- **New tab:** #? opened.');
  });

  test('exit 4 (cmux too slow): the deferral, what to end the turn with, then the summary; requests counted', async () => {
    const w = world(ON);
    h2Mayor(w);
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: OLD,
      title: 'Migrate the orders table',
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    const detail = 'cmux did not answer ping within 60 s';
    const deferred: HandoffGateResult = {
      detail,
      kind: 'deferred',
      message: handoffDeferralMessage('cmuxSlow', detail),
      reason: 'cmuxSlow',
    };
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w),
      deps(cmux, gateOf(deferred)),
    );
    expect(result.exitCode).toBe(4);
    expect(writeCalls(cmux.calls)).toEqual([]);
    expect(result.lines.slice(-5)).toEqual([
      deferred.message,
      '',
      HANDOFF_DEFERRED_SUMMARY_NEXT,
      '',
      [
        '🤝 **Handed off**',
        '',
        '- **This session:** #2',
        `- **New tab:** none opened: the handoff was deferred (cmuxSlow): ${detail}`,
        '- **Requests:** 1 open of 1',
        `- **Full report:** \`${inRepo(w)}bun run justin-sdk thread show ${w.beadId}\``,
      ].join('\n'),
    ]);
    // Everything the handoff records is unchanged: labelled, and deferred.
    expect(bead(w).labels).toContain('handed-off');
    expect(bead(w).labels).toContain('handoff-deferred');
  });

  test('the handoff itself was not recorded: no summary', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(opts(w), {
      ...deps(cmux, gateOf(REFUSED)),
      handOff: () => Promise.resolve({kind: 'failed', reason: 'br exited 2'}),
    });
    expect(result.exitCode).toBe(3);
    const text = result.lines.join('\n');
    expect(text).toContain(
      '⚠️ The handoff itself was NOT recorded: br exited 2',
    );
    expect(text).not.toContain('🤝 **Handed off**');
    expect(text).not.toContain(HANDOFF_REFUSED_SUMMARY_NEXT);
  });

  test('a TTY gets the same four fields as bold labels, no markdown', async () => {
    const w = world(ON);
    h2Mayor(w);
    const result = await threadHandoffCommand(
      opts(w, {style: {color: true, width: null}}),
      deps(fakeCmux(), gateOf(PASS)),
    );
    const summary = result.lines.at(-1) ?? '';
    expect(summary).not.toContain('**');
    const plain = stripAnsi(summary);
    expect(summary).not.toBe(plain);
    expect(plain).toBe(
      [
        '  🤝 Handed off',
        '',
        '      This session:  #2',
        `      New tab:       #3 opened. Focus it: ${inRepo(w)}bun run justin-sdk thread focus ${w.beadId}`,
        '      Requests:      none filed',
        `      Full report:   ${inRepo(w)}bun run justin-sdk thread show ${w.beadId}`,
      ].join('\n'),
    );
  });

  test('the pure summary: bare commands without a checkout, a quoted one with a space, and every request count', () => {
    const base = {
      own: {kind: 'known' as const, number: 1},
      sessionBeadId: 't-1',
      tab: {kind: 'opened' as const},
    };
    const bare = handoffSummary(
      {...base, checkout: null, requests: {kind: 'counted', open: 0, total: 3}},
      PLAIN_STYLE,
    );
    expect(bare).toContain('`bun run justin-sdk thread focus t-1`');
    expect(bare).toContain('- **Requests:** 0 open of 3');
    const spaced = handoffSummary(
      {
        ...base,
        checkout: '/a b',
        requests: {kind: 'partial', open: 2, reason: 'x', total: 5},
      },
      PLAIN_STYLE,
    );
    expect(spaced).toContain(
      "- **Full report:** `cd '/a b' && bun run justin-sdk thread show t-1`",
    );
    expect(spaced).toContain(
      '- **Requests:** 2 open of 5 (⚠️ not all counted: x)',
    );
    const unknown = handoffSummary(
      {
        ...base,
        checkout: null,
        requests: {kind: 'unknown', reason: 'the bead export is behind'},
      },
      PLAIN_STYLE,
    );
    expect(unknown).toContain(
      '- **Requests:** unknown: the bead export is behind',
    );
  });
});

describe('knob on: --dry-run', () => {
  test('home-base-6n7my.2: a mayor`s dry run shows both marks and the mayor sentence, and writes nothing', async () => {
    const w = world(ON);
    const added = runBr(w.repo, [
      'update',
      w.beadId,
      '--add-label=session-role:mayor',
    ]);
    if (!added.ok) throw new Error(added.reason ?? 'br update failed');
    const before = bead(w).labels;
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w, {dryRun: true}),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toMatch(
      /Successor name:\s+\[MAYOR\]\[HANDOFF-REPO\]\[#1\] migrate the db/u,
    );
    // home-base-9ihcl.10: the dry run shows what this tab would be renamed to.
    expect(text).toMatch(
      /This tab after:\s+↪ handed off to #1: \[MAYOR\]\[HANDOFF-REPO\] migrate the db/u,
    );
    expect(text).not.toContain('🤝 **Handed off**');
    expect(text).toContain('load the mayor skill with the Skill tool');
    expect(text).toMatch(/Kickoff:\s+You are the successor of a handed-off/u);
    expect(bead(w).labels).toEqual(before);
    expect(existsSync(handoffsDir(w))).toBe(false);
  });

  test('prints the gate, the block path, the full argv and the kickoff; writes and opens nothing', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w, {dryRun: true}),
      deps(cmux, gateOf(PASS)),
    );
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('Dry run: nothing written or opened');
    expect(text).toMatch(
      /Successor name:\s+\[HANDOFF-REPO\]\[#1\] migrate the db/u,
    );
    expect(text).not.toContain('mayor');
    expect(text).toMatch(/Gate:\s+passed/u);
    expect(text).toContain(blockPathOf(w));
    expect(text).toContain(`"--socket","${SOCK}","new-surface"`);
    expect(text).toContain(`"--pane","${PANE}"`);
    expect(text).toContain(`thread request --continues ${w.beadId}`);
    expect(writeCalls(cmux.calls)).toEqual([]);
    expect(existsSync(handoffsDir(w))).toBe(false);
    expect(bead(w).labels).not.toContain('handed-off');
  });

  test('home-base-npbse.1.2: the variable and the check-only kickoff come with autoPickup on, and neither without it', async () => {
    const dryText = async (handoff: Record<string, unknown>) => {
      const w = world(handoff);
      const result = await threadHandoffCommand(
        opts(w, {dryRun: true}),
        deps(fakeCmux(), gateOf(PASS)),
      );
      return {beadId: w.beadId, text: result.lines.join('\n')};
    };
    const on = await dryText({...ON, autoPickup: true});
    expect(on.text).toContain(`JUSTIN_SDK_CONTINUES=${on.beadId}`);
    expect(on.text).toContain('if it says the pickup is not done');
    expect(on.text).not.toContain('First run the command');
    const off = await dryText(ON);
    expect(off.text).not.toContain('JUSTIN_SDK_CONTINUES');
    expect(off.text).not.toContain('if it says the pickup is not done');
    expect(off.text).toContain('First run the command');
  });

  test('home-base-p05kz.3 item 8: the gate is told which kind of run this is', async () => {
    const dry = gateOf(PASS);
    await threadHandoffCommand(
      opts(world(ON), {dryRun: true}),
      deps(fakeCmux(), dry),
    );
    expect(dry.seen[0]).toMatchObject({dryRun: true});
    const real = gateOf(REFUSED);
    await threadHandoffCommand(
      opts(world(ON), {dryRun: false}),
      deps(fakeCmux(), real),
    );
    expect(real.seen[0]).toMatchObject({dryRun: false});
  });

  test('home-base-p05kz.3 item 8: a dry run with no valid pass says what a real run would do, and writes nothing', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const note = 'no guard pass at /p.json';
    const result = await threadHandoffCommand(
      opts(w, {dryRun: true}),
      deps(
        cmux,
        gateOf({
          ...PASS,
          facts: {
            ...PASS.facts,
            guardPassNote: note,
          },
        } as HandoffGateResult),
      ),
    );
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toMatch(/Gate:\s+passed/u);
    expect(text).toContain(`A real run would refuse (guardNotSeen): ${note}`);
    expect(writeCalls(cmux.calls)).toEqual([]);
    expect(bead(w).labels).not.toContain('handed-off');
    expect(bead(w).labels).not.toContain('handoff-refused');
  });

  test('a refusing gate is printed, and still nothing is written', async () => {
    const w = world(ON);
    const cmux = fakeCmux();
    const result = await threadHandoffCommand(
      opts(w, {dryRun: true}),
      deps(cmux, gateOf(REFUSED)),
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('would refuse: usageHigh');
    expect(cmux.calls).toEqual([]);
    expect(bead(w).labels).not.toContain('handed-off');
    expect(bead(w).labels).not.toContain('handoff-refused');
  });
});

describe('thread handoff --help (AC6)', () => {
  test('exits 0, leads with the version header, and documents the knob, the exit codes and the bare call', () => {
    const w = world(null);
    const cliEntry = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...w.env,
        FORCE_COLOR: undefined,
        NO_COLOR: '1',
      }).filter((entry): entry is [string, string] => entry[1] != null),
    );
    const run = Bun.spawnSync(
      [process.execPath, cliEntry, 'thread', 'handoff', '--help'],
      {cwd: w.repo, env, stdin: 'ignore'},
    );
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    expect(out.split('\n')[0]).toMatch(
      /^justin-sdk (?:v\d+\.\d+\.\d+|version unknown)/u,
    );
    const flat = out.replace(/\s+/gu, ' ');
    expect(flat).toContain(
      'THE KNOB. componentConfig.thread.handoff.successor, default false',
    );
    expect(flat).toContain(
      '0 Handed off, and the successor started. Write your final report now and end your turn.',
    );
    expect(flat).toContain('1 A step failed. The output says what WAS done');
    expect(flat).toContain('2 Nothing was written: the message says why.');
    expect(flat).toContain(
      '3 The gate refused. The session WAS handed off and the refusal is recorded; nothing was opened. This is final',
    );
    expect(flat).toContain(
      'RUN IT BARE, from the repository root, where node_modules is: ./node_modules/.bin/justin-sdk thread handoff --note',
    );
    expect(flat).toContain('a `cd X && …` prefix');
    expect(flat).toContain('run `cd <repository root>` as its own Bash call');
    expect(flat).not.toContain('bun run justin-sdk thread handoff');
    // --help does nothing else.
    expect(bead(w).labels).not.toContain('handed-off');
  });
});

describe('the pure parts', () => {
  test('parseNewSurface reads the measured answer and nothing less', () => {
    expect(parseNewSurface('OK surface:306 pane:285 workspace:191\n')).toEqual({
      paneRef: 'pane:285',
      surfaceRef: 'surface:306',
      workspaceRef: 'workspace:191',
    });
    expect(parseNewSurface('OK pane:285 workspace:191')).toBeNull();
    expect(parseNewSurface('ERROR surface:306')).toBeNull();
    expect(parseNewSurface('')).toBeNull();
  });

  test('the real M1 screens classify as measured', () => {
    expect(classifySuccessorScreen(TRUST_DIALOG)).toEqual({
      kind: 'dialog',
      label: 'the folder-trust dialog',
    });
    expect(classifySuccessorScreen(ZSH_BEFORE_CLAUDE)).toEqual({
      kind: 'notYet',
      why: 'no Claude Code input box on the screen',
    });
    expect(classifySuccessorScreen(CLAUDE_UP)).toEqual({kind: 'started'});
  });

  test('a box still holding typed text is not a start', () => {
    // The empty box's line is "❯" plus U+00A0; typed text also removes the
    // "← N agents" footer hint, which Claude Code draws only for an empty box.
    const typed = CLAUDE_UP.replace(
      new RegExp(`^❯${NO_BREAK_SPACE}?\\s*$`, 'mu'),
      '❯ some text left unsent',
    ).replace(' · ← 19 agents', '');
    expect(typed).not.toBe(CLAUDE_UP);
    expect(typed).toContain('❯ some text left unsent');
    expect(classifySuccessorScreen(typed)).toEqual({
      kind: 'notYet',
      why: 'the input box still holds text, so the kickoff may not have been submitted',
    });
    // The same box showing Claude Code's own suggestion (footer kept) is up.
    const suggested = CLAUDE_UP.replace(
      new RegExp(`^❯${NO_BREAK_SPACE}?\\s*$`, 'mu'),
      '❯ some suggestion',
    );
    expect(classifySuccessorScreen(suggested)).toEqual({kind: 'started'});
  });
});

describe('mbnjv.4: what happens to the old tab (predecessor keep, exit, close)', () => {
  const SUCC = 'FFFF0000-1111-4222-8333-0000000000f6';
  /** TREE plus the successor's tab, so its uuid can be read from its ref. */
  const TREE_WITH_SUCCESSOR = JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: WS,
            panes: [
              {
                id: PANE,
                ref: 'pane:285',
                surfaces: [
                  {id: SURF, ref: 'surface:300'},
                  {id: SUCC, ref: 'surface:306'},
                ],
              },
            ],
            ref: 'workspace:191',
          },
        ],
      },
    ],
  });

  function watcher(
    start: WatcherStart = {
      kind: 'started',
      logError: null,
      pid: 4242,
      watchPath: '/w.json',
    },
  ) {
    const started: PredecessorWatch[] = [];
    const startWatcher = (watch: PredecessorWatch) => {
      started.push(watch);
      return start;
    };
    return {startWatcher, started};
  }

  async function handOffWith(
    mode: string | null,
    start?: WatcherStart,
    tree: string = TREE_WITH_SUCCESSOR,
  ) {
    const w = world(mode == null ? ON : {...ON, predecessor: mode});
    const cmux = fakeCmux({
      screens: [CLAUDE_UP],
      tree: {kind: 'ok', stdout: tree},
    });
    const spy = watcher(start);
    const result = await threadHandoffCommand(opts(w), {
      ...deps(cmux, gateOf(PASS)),
      startWatcher: spy.startWatcher,
    });
    return {cmux, result, spy, w};
  }

  test('keep (the default) never starts a watcher and prints nothing new', async () => {
    const {cmux, result, spy} = await handOffWith(null);
    expect(result.exitCode).toBe(0);
    expect(spy.started).toEqual([]);
    expect(result.lines.join('\n')).not.toContain('Old tab when done');
    expect(cmux.calls.filter((args) => args.includes('tree'))).toHaveLength(1);
  });

  test('keep, named explicitly, never starts a watcher either', async () => {
    const {spy} = await handOffWith('keep');
    expect(spy.started).toEqual([]);
  });

  test('exit: one watcher, on the tab CMUX_SURFACE_ID named, with the tombstone', async () => {
    const {result, spy, w} = await handOffWith('exit');
    expect(result.exitCode).toBe(0);
    expect(spy.started).toHaveLength(1);
    const watch = spy.started[0];
    if (watch == null) throw new Error('no watch');
    expect(watch.caller).toEqual({
      beadId: w.beadId,
      db: watch.caller.db,
      sessionId: OLD,
      surfaceId: SURF,
      workspaceId: WS,
    });
    expect(watch.caller.db).toContain('.beads');
    expect(watch.mode).toBe('exit');
    expect(watch.handedOffAt).toBe(NOW.toISOString());
    expect(watch.successor).toEqual({
      name: '[HANDOFF-REPO][#1] migrate the db',
      surfaceId: SUCC,
      surfaceRef: 'surface:306',
    });
    expect(watch.timeoutMs).toBe(20 * 60_000);
    expect(watch.logPath).toBe(join(w.stateDir, 'handoff-predecessor.jsonl'));
    expect(watch.tombstone).toContain(
      `      cmux focus-panel --panel ${SUCC} --workspace ${WS}`,
    );
    expect(watch.tombstone).toContain(`      claude --resume ${OLD}`);
    expect(watch.tombstone).toContain(
      '   Handed off to:   [HANDOFF-REPO][#1] migrate the db',
    );
    expect(
      predecessorWatchSchema.safeParse(JSON.parse(JSON.stringify(watch)))
        .success,
    ).toBe(true);
    const text = result.lines.join('\n');
    expect(text).toMatch(
      /Old tab when done:\s+Claude Code here exits and the tab shows a tombstone once the successor has linked/u,
    );
    expect(text).toContain('watcher pid 4242');
    // F19: the bead says a watcher runs, before any outcome.
    expect(bead(w).notes ?? '').toContain(
      `predecessor watcher started: this tab will exit once the successor in tab ${SUCC} links back and this session's turn has ended; watcher pid 4242`,
    );
  });

  test('F6/F10: the new tab id cannot be read: no watcher, no focus command, said and noted', async () => {
    // A tree without the successor's tab: its ref resolves to no uuid.
    const {result, spy, w} = await handOffWith(
      'exit',
      undefined,
      TREE_WITH_SUCCESSOR.replaceAll('surface:306', 'surface:999'),
    );
    expect(result.exitCode).toBe(0);
    expect(spy.started).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain("⚠️ kept: the new tab's id could not be read (");
    expect(text).toContain(
      "so the successor's link could not be verified and no focus command could be written",
    );
    expect(text).not.toContain('focus-panel');
    expect(bead(w).notes ?? '').toContain(
      "predecessor kept: no watcher was started: the new tab's id could not be read",
    );
  });

  test('F19: a started line that could not be logged is said and noted', async () => {
    const {result, w} = await handOffWith('close', {
      kind: 'started',
      logError: 'EACCES',
      pid: 7,
      watchPath: '/w.json',
    });
    expect(result.lines.join('\n')).toContain(
      '⚠️ the started line was NOT logged: EACCES',
    );
    expect(bead(w).notes ?? '').toContain('its started line was NOT logged');
  });

  test('close: the same capture, mode close', async () => {
    const {result, spy} = await handOffWith('close');
    expect(result.exitCode).toBe(0);
    expect(
      spy.started.map((watch) => [watch.mode, watch.caller.surfaceId]),
    ).toEqual([['close', SURF]]);
    expect(result.lines.join('\n')).toContain(
      'this tab closes once the successor has linked',
    );
  });

  test('a watcher that does not start keeps the tab: said, noted on the bead, exit 0', async () => {
    const {result, w} = await handOffWith('exit', {
      kind: 'failed',
      reason: 'spawn EPERM',
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      '⚠️ kept: the watcher that would exit it did not start: spawn EPERM',
    );
    expect(bead(w).notes ?? '').toContain(
      'predecessor kept: the watcher did not start: spawn EPERM',
    );
    const log = readFileSync(
      join(w.stateDir, 'handoff-predecessor.jsonl'),
      'utf8',
    );
    const record = JSON.parse(log.trim()) as {
      event: string;
      note: string;
      surfaceId: string;
    };
    expect(record).toMatchObject({
      event: 'startFailed',
      note: 'recorded',
      surfaceId: SURF,
    });
  });

  test('--dry-run says what would happen and starts nothing', async () => {
    const w = world({...ON, predecessor: 'close'});
    const cmux = fakeCmux();
    const spy = watcher();
    const result = await threadHandoffCommand(opts(w, {dryRun: true}), {
      ...deps(cmux, gateOf(PASS)),
      startWatcher: spy.startWatcher,
    });
    expect(result.exitCode).toBe(0);
    expect(spy.started).toEqual([]);
    expect(result.lines.join('\n')).toContain(
      '(no watcher is started by a dry run)',
    );
  });
});

describe('F11 (home-base-mbnjv.8): one successor per session', () => {
  function reasonOf(result: HandoffGateResult): string {
    return result.kind === 'refused' ? result.reason : 'pass';
  }

  /** The gate with every reader passing except the REAL launch record. */
  async function secondGate(w: World) {
    const selected = selectSession({
      env: w.env,
      selector: null,
      sessionIdOption: null,
    });
    if (selected.kind !== 'found') throw new Error(selected.kind);
    const {session} = selected;
    return await runHandoffGate({
      env: {CMUX_SURFACE_ID: SURF, CMUX_WORKSPACE_ID: WS},
      limits: {
        maxLiveSessions: 20,
        maxUnattendedHandoffs: 3,
        usage: {
          maxSampleAgeMinutes: 150,
          maxSessionPercent: 85,
          maxWeekPercent: 90,
        },
      },
      now: NOW,
      readers: {
        callerScreen: () => ({
          kind: 'unreadable',
          reason: 'not reached',
          timedOut: false,
        }),
        chain: null,
        guard: () => ({kind: 'registered', where: []}),
        guardPass: () => ({kind: 'valid', path: '/p'}),
        killSwitch: () => ({kind: 'off', path: '/k'}),
        launchRecord: () =>
          readLaunchRecord({
            beadId: session.bead.id,
            db: session.db,
            env: w.env,
          }),
        liveSessions: () => ({
          kind: 'failed',
          reason: 'not reached',
          timedOut: false,
        }),
        pingCmux: () => ({
          kind: 'failed',
          reason: 'not reached',
          timedOut: false,
        }),
        usage: () => ({kind: 'missing', path: '/u'}),
      },
    });
  }

  test('after exit 0 the bead carries the launch record, and a second handoff is refused (alreadyHandedOff)', async () => {
    const w = world(ON);
    expect(reasonOf(await secondGate(w))).toBe('cmuxUnreachable'); // before: goes past
    const cmux = fakeCmux({screens: [CLAUDE_UP]});
    const first = await threadHandoffCommand(opts(w), deps(cmux, gateOf(PASS)));
    expect(first.exitCode).toBe(0);
    expect(bead(w).labels ?? []).toContain('successor-started');
    expect(bead(w).notes ?? '').toContain(
      `successor launch started: from tab ${SURF} into pane ${PANE} of workspace ${WS}, successor "[HANDOFF-REPO][#1] migrate the db"`,
    );
    const second = await secondGate(w);
    expect(second.kind).toBe('refused');
    expect(second.kind === 'refused' && second.reason).toBe('alreadyHandedOff');
    expect(second.kind === 'refused' && second.detail).toContain(
      'Justin can start another by hand from the handoff block',
    );
  });

  test('after exit 1 with the tab opened (screen never confirmed), a second handoff is refused too', async () => {
    const w = world(ON);
    const cmux = fakeCmux({screens: [ZSH_BEFORE_CLAUDE]});
    const first = await threadHandoffCommand(opts(w), deps(cmux, gateOf(PASS)));
    expect(first.exitCode).toBe(1);
    expect(first.launch).not.toBeNull();
    expect(reasonOf(await secondGate(w))).toBe('alreadyHandedOff');
  });

  test('a launch record that cannot be written: exit 1 and new-surface is never called', async () => {
    const w = world(ON);
    const cmux = fakeCmux({screens: [CLAUDE_UP]});
    const result = await threadHandoffCommand(opts(w), {
      ...deps(cmux, gateOf(PASS)),
      recordLaunch: () => ({
        kind: 'failed',
        reason: 'br is locked',
        timedOut: false,
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain(
      'the launch record could not be written (br is locked), so a second handoff could not be stopped; no successor was started',
    );
    expect(writeCalls(cmux.calls)).toEqual([]);
  });
});
