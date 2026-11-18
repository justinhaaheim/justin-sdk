/**
 * `thread close --all-except` (home-base-kwand.7). cmux, ps, kill, the clock,
 * the hook store, the session facts (the inbox), the tab record and cmux's
 * session file are fakes; the live join is the real one over the fake world.
 * Decision D3: no test reaches the real cmux, ps or any process. Every outside
 * effect is one event, so a test can say nothing was signalled or closed.
 */

import type {CloseDeps, CloseOptions} from '../src/thread/close';
import type {
  KeepKind,
  SessionFacts,
  SessionFactsRead,
} from '../src/thread/close-all-except';
import type {CmuxCall} from '../src/thread/cmux';
import type {RawTree} from '../src/thread/pane-join';
import type {PidCommand} from '../src/thread/workspace-close';

import {afterEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {closesLogPath, closeWorkspaces} from '../src/thread/close';
import {parseKeepActive} from '../src/thread/close-all-except';
import {joinLiveSessions} from '../src/thread/live-sessions';
import {
  flattenTree,
  NO_BREAK_SPACE,
  parseProcessList,
} from '../src/thread/pane-join';

const CLAUDE = '/Users/jhaa/.local/bin/claude';
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function sid(n: number): string {
  return `${`0000000${n}`.slice(-8)}-1111-4222-8333-000000000000`;
}
function wsId(n: number): string {
  return `C${`000000${n}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
}
function surfId(n: number): string {
  return `E${`000000${n}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
}
const WINDOW = 'B0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const RULE = '─'.repeat(40);

function idleClaude(session: string): string {
  return [
    '⏺ Done.',
    '',
    RULE,
    `❯${NO_BREAK_SPACE}`,
    RULE,
    `  ◈ v2.1.302   ⌗ ${session}`,
  ].join('\n');
}
function draftClaude(session: string): string {
  return idleClaude(session).replace(`❯${NO_BREAK_SPACE}`, '❯ half a thought');
}
function workingClaude(session: string): string {
  return idleClaude(session).replace('⏺ Done.', '✢ Inferring… (2m 40s)');
}
const IDLE_SHELL = 'Last login: Tue Nov 17 on ttys001\n\n~/Dev\n❯ ';

interface Pane {
  screen: string;
  surface: number;
  tty: string;
}
interface Ws {
  n: number;
  panes: Pane[];
  pinned?: boolean;
}

/** One pane workspace n on ttys0n. */
function ws(n: number, screen: string, extra: Partial<Ws> = {}): Ws {
  return {n, panes: [{screen, surface: n, tty: `ttys0${n}`}], ...extra};
}
function claudeProc(n: number, tty = `ttys0${n}`): string {
  return `${1000 + n} 1 ${tty} 01:00 ${CLAUDE} --session-id ${sid(n)} --settings x`;
}
function shellProcs(tty: string, base: number): string[] {
  return [
    `${base} 1 ${tty} 01:00 /usr/bin/login -pflq jhaa /bin/zsh`,
    `${base + 1} ${base} ${tty} 01:00 -zsh`,
  ];
}

/** A tracked session, idle three days, unmarked, its last turn replied. */
function fact(n: number, over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    ending: {at: new Date(NOW - 72 * HOUR).toISOString(), kind: 'replied'},
    flags: {emoji: [], labels: [], problems: [], undecodable: []},
    lastActivityAt: new Date(NOW - 72 * HOUR).toISOString(),
    sessionBeadId: `bead-${n}`,
    sessionId: sid(n),
    tracked: true,
    unreadable: null,
    ...over,
  };
}

interface WorldInput {
  facts?: SessionFacts[];
  factsRead?: SessionFactsRead;
  noOwn?: boolean;
  options?: Partial<CloseOptions>;
  own?: number;
  procs?: string[];
  recordFails?: boolean;
  refuseClose?: Record<string, string>;
  workspaces: Ws[];
}

function world(input: WorldInput) {
  const root = mkdtempSync(join(tmpdir(), 'thread-close-all-'));
  dirs.push(root);
  const stateDir = join(root, 'state');
  const env: Record<string, string> = {
    CMUX_SOCKET_PATH: '/tmp/thread-close-all-test/cmux.sock',
    HOME: '/nonexistent',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    ...(input.noOwn === true ? {} : {CMUX_WORKSPACE_ID: wsId(input.own ?? 9)}),
  };
  const logPath = closesLogPath(env);
  const events: string[] = [];
  const calls: string[][] = [];
  let workspaces = [...input.workspaces];
  const killed = new Set<number>();
  const procLines = input.procs ?? [];
  const psText = (): string =>
    `${[
      '  PID  PPID TTY      ELAPSED COMMAND',
      ...procLines.filter(
        (line) => !killed.has(Number(line.trim().split(' ')[0])),
      ),
    ].join('\n')}\n`;
  const rawTree = (): RawTree & {windows: {id: string}[]} => ({
    windows: [
      {
        id: WINDOW,
        ref: 'window:1',
        workspaces: workspaces.map((entry) => ({
          id: wsId(entry.n),
          panes: entry.panes.map((pane) => ({
            ref: `pane:${pane.surface}`,
            surfaces: [
              {
                id: surfId(pane.surface),
                ref: `surface:${pane.surface}`,
                title: 'x',
                tty: pane.tty,
                type: 'terminal',
              },
            ],
          })),
          pinned: entry.pinned ?? false,
          ref: `workspace:${entry.n}`,
          title: `title ${entry.n}`,
        })),
      },
    ],
  });
  const panes = (): Pane[] => workspaces.flatMap((entry) => entry.panes);
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    if (args[0] === 'ping')
      return Promise.resolve({kind: 'ok', stdout: 'PONG'});
    if (args.includes('tree')) {
      return Promise.resolve({kind: 'ok', stdout: JSON.stringify(rawTree())});
    }
    if (args[0] === 'read-screen') {
      const target = value(args, '--surface');
      const pane = panes().find(
        (entry) =>
          `surface:${entry.surface}` === target ||
          surfId(entry.surface) === target,
      );
      return Promise.resolve(
        pane == null
          ? {kind: 'failed', reason: 'no surface', timedOut: false}
          : {kind: 'ok', stdout: pane.screen},
      );
    }
    if (args[0] === 'close-workspace') {
      const target = value(args, '--workspace');
      events.push(`close-workspace ${target}`);
      const refusal = input.refuseClose?.[target];
      if (refusal != null) {
        return Promise.resolve({
          kind: 'failed',
          reason: refusal,
          timedOut: false,
        });
      }
      workspaces = workspaces.filter((entry) => wsId(entry.n) !== target);
      return Promise.resolve({kind: 'ok', stdout: 'OK'});
    }
    events.push(`unexpected cmux ${args.join(' ')}`);
    return Promise.resolve({
      kind: 'failed',
      reason: 'unknown',
      timedOut: false,
    });
  };
  const factsRead: SessionFactsRead = input.factsRead ?? {
    bySession: new Map(
      (input.facts ?? []).map((entry) => [entry.sessionId, entry]),
    ),
    kind: 'read',
    partial: null,
    testSessions: new Set(),
  };
  const deps: Partial<CloseDeps> = {
    appendLog: (line) => {
      events.push(`log ${line.outcome.split(':')[0]}`);
      mkdirSync(stateDir, {recursive: true});
      appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      return null;
    },
    commandOf: (pid): Promise<PidCommand> => {
      const proc = parseProcessList(psText()).find(
        (entry) => entry.pid === pid,
      );
      return Promise.resolve(
        proc == null
          ? {kind: 'gone'}
          : {command: proc.command, kind: 'running'},
      );
    },
    exitTimeoutMs: 15_000,
    kill: (pid) => {
      events.push(`kill ${pid}`);
      killed.add(pid);
      return null;
    },
    nowMs: () => NOW,
    ps: () => Promise.resolve({kind: 'ok', stdout: psText()}),
    readHookStore: () => ({ok: true, value: {}}),
    readLive: () =>
      Promise.resolve({
        kind: 'read' as const,
        ...joinLiveSessions({
          agents: [],
          procs: parseProcessList(psText()),
          screens: new Map(
            panes().map((pane) => [
              `surface:${pane.surface}`,
              {kind: 'read' as const, text: pane.screen},
            ]),
          ),
          store: {},
          surfaces: flattenTree(rawTree()),
        }),
      }),
    readSessionFacts: () => {
      events.push('read-facts');
      return Promise.resolve(factsRead);
    },
    readSessionFile: () => ({
      ageMs: 120_000,
      createdAt: new Date(NOW - 120_000).toISOString(),
      kind: 'read',
      path: '/x/session-com.cmuxterm.app.json',
      workspaces: workspaces.length,
    }),
    recordTabs: () => {
      events.push('record-tabs');
      return input.recordFails === true
        ? {kind: 'failed', reason: 'the live file is not there'}
        : {kind: 'recorded', words: 'recorded: 1 windows'};
    },
    resumeOf: (sessionId) => ({
      checkout: '/Users/x/Dev/repo-a',
      command: `cd '/Users/x/Dev/repo-a' && claude --resume ${sessionId}`,
      kind: 'found',
      repo: 'repo-a',
      warning: null,
    }),
    run,
    sleep: () => Promise.resolve(),
    windowGoneTimeoutMs: 1000,
  };
  const options: CloseOptions = {
    allExcept: true,
    dryRun: false,
    env,
    json: false,
    sessions: [],
    style: PLAIN_STYLE,
    workspaces: [],
    ...input.options,
  };
  return {calls, deps, events, options};
}

type World = ReturnType<typeof world>;

/** Anything that changes something: a log line, a signal, a close, a record. */
const writes = (w: World): string[] =>
  w.events.filter((event) => !event.startsWith('read-facts'));
const noForce = (w: World): void => {
  expect(w.calls.some((args) => args.includes('--force'))).toBe(false);
};

async function plan(input: WorldInput) {
  const w = world(input);
  const result = await closeWorkspaces(w.options, w.deps);
  const keptKinds = new Map<string, KeepKind[]>(
    (result.state?.kept ?? []).map((entry) => [
      entry.workspaceRef ?? entry.workspaceId,
      entry.reasonKinds ?? [],
    ]),
  );
  const planned = (result.state?.planned ?? []).map(
    (entry) => entry.workspaceRef,
  );
  return {keptKinds, planned, result, w};
}

/** Own workspace 9 (an idle shell), plus the workspaces given. */
function withOwn(workspaces: Ws[]): Ws[] {
  return [ws(9, IDLE_SHELL), ...workspaces];
}
const OWN_PROCS = shellProcs('ttys09', 9000);

describe('dry run by default (K4)', () => {
  test('without --apply nothing is signalled, closed, written or recorded; the clean workspaces are planned', async () => {
    const {planned, result, w} = await plan({
      facts: [fact(1)],
      procs: [claudeProc(1), ...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      workspaces: withOwn([ws(1, idleClaude(sid(1))), ws(2, IDLE_SHELL)]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.state?.dryRun).toBe(true);
    expect(planned).toEqual(['workspace:1', 'workspace:2']);
    expect(writes(w)).toEqual([]);
    expect(result.output).toContain('dry run (the default)');
    expect(result.output).toContain('running process');
    noForce(w);
  });

  test('--dry-run means the default; --apply with --dry-run is refused', async () => {
    const quiet = await plan({
      options: {dryRun: true},
      procs: OWN_PROCS,
      workspaces: withOwn([]),
    });
    expect(quiet.result.exitCode).toBe(0);
    expect(quiet.result.state?.dryRun).toBe(true);
    const both = await plan({
      options: {apply: true, dryRun: true},
      workspaces: withOwn([]),
    });
    expect(both.result.exitCode).toBe(2);
    expect(both.w.calls).toEqual([]);
  });
});

describe('keep rules (K2), each with its kind', () => {
  test('(a) the own workspace is kept as own', async () => {
    const {keptKinds, planned} = await plan({
      procs: OWN_PROCS,
      workspaces: withOwn([]),
    });
    expect(planned).toEqual([]);
    expect(keptKinds.get('workspace:9')).toEqual(['own']);
  });

  test('(b) a marked chain keeps its workspace', async () => {
    const {keptKinds} = await plan({
      facts: [
        fact(1, {
          flags: {
            emoji: ['⭐'],
            labels: ['mark:2b50'],
            problems: [],
            undecodable: [],
          },
        }),
      ],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['marked']);
  });

  test('(c) working now, from the transcript or from the screen', async () => {
    const {keptKinds} = await plan({
      facts: [
        fact(1, {
          ending: {
            at: null,
            inFlight: 'toolCall',
            kind: 'workingNow',
            lastRecordAt: new Date(NOW - 60_000).toISOString(),
          },
        }),
        fact(2),
      ],
      options: {keepActive: '0'},
      procs: [claudeProc(1), claudeProc(2), ...OWN_PROCS],
      workspaces: withOwn([
        ws(1, idleClaude(sid(1))),
        ws(2, workingClaude(sid(2))),
      ]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['working']);
    expect(keptKinds.get('workspace:2')).toEqual(['working']);
  });

  test('(d) unsent text keeps it', async () => {
    const {keptKinds} = await plan({
      facts: [fact(1)],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, draftClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['unsentText']);
  });

  test('(e) an untracked session keeps it', async () => {
    const {keptKinds} = await plan({
      facts: [fact(1, {flags: null, sessionBeadId: null, tracked: false})],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['untracked']);
  });

  test('(f) activity within --keep-active keeps it; outside it does not', async () => {
    const recent = fact(1, {
      lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    const kept = await plan({
      facts: [recent],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(kept.keptKinds.get('workspace:1')).toEqual(['recentlyActive']);
    const short = await plan({
      facts: [recent],
      options: {keepActive: '1h'},
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(short.planned).toEqual(['workspace:1']);
  });

  test('(g) --keep by workspace ref, session id and session bead id', async () => {
    for (const given of ['workspace:1', sid(1), 'bead-1']) {
      const {keptKinds, result} = await plan({
        facts: [fact(1)],
        options: {keep: [given]},
        procs: [claudeProc(1), ...OWN_PROCS],
        workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
      });
      expect(result.exitCode).toBe(0);
      expect(keptKinds.get('workspace:1')).toEqual(['keepFlag']);
    }
  });

  test('(h) a pinned workspace is counted under pinned (K6), with every reason listed', async () => {
    const {keptKinds, result} = await plan({
      procs: [...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      workspaces: withOwn([ws(2, IDLE_SHELL, {pinned: true})]),
    });
    expect(keptKinds.get('workspace:2')).toEqual(['pinned']);
    expect(result.state?.allExcept?.counts.keptByKind).toEqual({
      own: 1,
      pinned: 1,
    });
    expect(result.output).toContain('Kept as');
  });

  test('K6: several reasons count once, under the first in K2 order', async () => {
    const {keptKinds, result} = await plan({
      facts: [
        fact(1, {
          flags: {
            emoji: ['⭐'],
            labels: ['mark:2b50'],
            problems: [],
            undecodable: [],
          },
          lastActivityAt: new Date(NOW - HOUR).toISOString(),
        }),
      ],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, draftClaude(sid(1)), {pinned: true})]),
    });
    expect(keptKinds.get('workspace:1')).toEqual([
      'marked',
      'recentlyActive',
      'pinned',
      'unsentText',
    ]);
    expect(result.state?.allExcept?.counts.keptByKind.marked).toBe(1);
    expect(result.state?.allExcept?.counts.kept).toBe(2);
  });
});

describe('unknown keeps (K3) and missing rows (K9)', () => {
  test('marks that could not be read keep it as unknown, never as unmarked', async () => {
    const {keptKinds} = await plan({
      facts: [fact(1, {flags: null, unreadable: 'br failed'})],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['unknown']);
  });

  test('a null last activity keeps it as unknown, never as idle', async () => {
    const {keptKinds} = await plan({
      facts: [
        fact(1, {
          ending: {kind: 'unknown', reason: 'no transcript'},
          lastActivityAt: null,
        }),
      ],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['unknown', 'unknown']);
  });

  test('a live session with no inbox row is kept: untracked, or unknown when the load was partial', async () => {
    const whole = await plan({
      facts: [],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(whole.keptKinds.get('workspace:1')).toEqual(['untracked']);
    const partial = await plan({
      factsRead: {
        bySession: new Map(),
        kind: 'read',
        partial: '2 lines of the sessions index could not be read',
        testSessions: new Set(),
      },
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(partial.keptKinds.get('workspace:1')).toEqual(['unknown']);
  });

  test('an inbox that cannot be read refuses the run before planning', async () => {
    const {result, w} = await plan({
      factsRead: {kind: 'failed', reason: 'the sessions index is unreadable'},
      procs: OWN_PROCS,
      workspaces: withOwn([]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('the sessions index is unreadable');
    expect(writes(w)).toEqual([]);
  });

  test('K10: a workspace with no Claude session and an idle shell is planned', async () => {
    const {planned} = await plan({
      procs: [...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      workspaces: withOwn([ws(2, IDLE_SHELL)]),
    });
    expect(planned).toEqual(['workspace:2']);
  });
});

describe('refusals (K11, K2 a, --keep)', () => {
  const MIXED = 'chooses its own targets';
  const ONLY = 'only go with --all-except';
  const refusals: [string, Partial<CloseOptions>, string][] = [
    ['--all-except with a workspace', {workspaces: ['workspace:1']}, MIXED],
    ['--all-except with --session', {sessions: [sid(1)]}, MIXED],
    ['--all-except with --tab', {tab: true}, MIXED],
    ['--all-except with --handed-off', {handedOff: true}, MIXED],
    [
      '--apply without --all-except',
      {allExcept: false, apply: true, workspaces: ['workspace:1']},
      ONLY,
    ],
    [
      '--keep without --all-except',
      {allExcept: false, keep: ['workspace:1'], workspaces: ['workspace:1']},
      ONLY,
    ],
    [
      '--keep-active without --all-except',
      {allExcept: false, keepActive: '2h', workspaces: ['workspace:1']},
      ONLY,
    ],
    [
      'a --keep-active that is not a duration',
      {keepActive: 'soon'},
      'takes a duration',
    ],
  ];
  for (const [name, options, words] of refusals) {
    test(`${name} is exit 2, before any cmux call`, async () => {
      const {result, w} = await plan({options, workspaces: withOwn([])});
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(words);
      expect(w.calls).toEqual([]);
    });
  }

  test('outside cmux (no CMUX_WORKSPACE_ID) is exit 2', async () => {
    const {result, w} = await plan({noOwn: true, workspaces: withOwn([])});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('CMUX_WORKSPACE_ID');
    expect(w.calls).toEqual([]);
  });

  test('a --keep that matches nothing is exit 2 and closes nothing', async () => {
    const {result, w} = await plan({
      facts: [fact(1)],
      options: {apply: true, keep: ['workspace:77']},
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('workspace:77');
    expect(writes(w)).toEqual([]);
  });

  test('parseKeepActive', () => {
    expect(parseKeepActive('24h')).toBe(24 * HOUR);
    expect(parseKeepActive('30m')).toBe(30 * 60_000);
    expect(parseKeepActive('2d')).toBe(48 * HOUR);
    expect(parseKeepActive('0')).toBe(0);
    expect(parseKeepActive('1.5h')).toBeNull();
    expect(parseKeepActive('')).toBeNull();
  });
});

describe('--apply', () => {
  test('a failed tab record refuses with nothing closed or signalled', async () => {
    const {result, w} = await plan({
      facts: [fact(1)],
      options: {apply: true},
      procs: [claudeProc(1), ...OWN_PROCS],
      recordFails: true,
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(result.exitCode).toBe(2);
    expect(writes(w)).toEqual(['record-tabs']);
  });

  test('the tab record runs first, then the one close pipeline; no cmux call carries --force (K5)', async () => {
    const {result, w} = await plan({
      facts: [fact(1)],
      options: {apply: true},
      procs: [claudeProc(1), ...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      refuseClose: {
        [wsId(2)]:
          'confirmation_required: Workspace has a running process; retry with --force',
      },
      workspaces: withOwn([ws(1, idleClaude(sid(1))), ws(2, IDLE_SHELL)]),
    });
    expect(writes(w)).toEqual([
      'record-tabs',
      'log closing',
      'log closing',
      'kill 1001',
      `close-workspace ${wsId(1)}`,
      'log closed',
      `close-workspace ${wsId(2)}`,
      'log failed',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.state?.allExcept?.counts).toMatchObject({
      failed: 1,
      wouldClose: 1,
    });
    expect(result.state?.failed[0]?.claudeStopped).toBe(false);
    noForce(w);
  });
});

describe('shared tty (K7)', () => {
  /** Workspaces 1 and 2 both report ttys05; 2 is the own workspace's neighbour. */
  function shared(onTty: string[]): WorldInput {
    return {
      procs: [...OWN_PROCS, ...onTty],
      workspaces: withOwn([
        {n: 1, panes: [{screen: IDLE_SHELL, surface: 1, tty: 'ttys05'}]},
        {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
      ]),
    };
  }

  test('only shells on the shared tty: both are planned, counted as passed by the rule', async () => {
    const {planned, result} = await plan(shared(shellProcs('ttys05', 5000)));
    expect(planned).toEqual(['workspace:1', 'workspace:2']);
    expect(result.state?.allExcept?.sharedTty).toEqual({
      keptFor: 0,
      passedByRule: 2,
      workspaces: 2,
    });
  });

  test('anything else on the shared tty keeps both, with the manual command', async () => {
    const {keptKinds, result} = await plan(
      shared([
        ...shellProcs('ttys05', 5000),
        '5002 5001 ttys05 01:00 vim notes.md',
      ]),
    );
    expect(keptKinds.get('workspace:1')).toEqual(['sharedTty', 'running']);
    expect(result.output).toContain(
      `cmux close-workspace --workspace ${wsId(1)} --window ${WINDOW}`,
    );
  });

  test('a named close keeps the shells-only shared tty, as before', async () => {
    const input = shared(shellProcs('ttys05', 5000));
    const w = world({
      ...input,
      options: {allExcept: false, dryRun: true, workspaces: ['workspace:1']},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.state?.kept[0]?.reasonKinds).toEqual(['sharedTty']);
  });
});
