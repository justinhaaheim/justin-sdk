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
  /** ps lines that vanish right after the first live read (kwand.24 R1, the re-check). */
  goneProcs?: string[];
  /** ps lines that appear right after the first live read (kwand.21 F2, second pass). */
  lateProcs?: string[];
  /**
   * The screen a surface shows from its second read-screen on, by surface
   * number (kwand.27, the re-check). The plan reads each screen once; the
   * fake live read uses the pane's first screen.
   */
  laterScreens?: Record<number, string>;
  noOwn?: boolean;
  options?: Partial<CloseOptions>;
  own?: number;
  procs?: string[];
  /**
   * ps lines that appear right before the first live read, so after the
   * plan's own view was read (kwand.26: a pid missing from the gate's ps).
   */
  procsBeforeLive?: string[];
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
  const procLines = [...(input.procs ?? [])];
  let liveReads = 0;
  const screenReads = new Map<number, number>();
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
      if (pane == null) {
        return Promise.resolve({
          kind: 'failed',
          reason: 'no surface',
          timedOut: false,
        });
      }
      const reads = (screenReads.get(pane.surface) ?? 0) + 1;
      screenReads.set(pane.surface, reads);
      const later = input.laterScreens?.[pane.surface];
      return Promise.resolve({
        kind: 'ok',
        stdout: reads > 1 && later != null ? later : pane.screen,
      });
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
    readLive: () => {
      events.push('read-live');
      if (liveReads === 0) procLines.push(...(input.procsBeforeLive ?? []));
      const live = {
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
      };
      liveReads += 1;
      if (liveReads === 1) {
        procLines.push(...(input.lateProcs ?? []));
        for (const gone of input.goneProcs ?? []) {
          const at = procLines.indexOf(gone);
          if (at !== -1) procLines.splice(at, 1);
        }
      }
      return Promise.resolve(live);
    },
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
  w.events.filter((event) => !event.startsWith('read-'));
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
    [
      '--close-shared-tty without --all-except (kwand.21 F1)',
      {
        allExcept: false,
        closeSharedTty: true,
        workspaces: ['workspace:1'],
      },
      ONLY,
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

  test('kwand.21 F3: a CMUX_WORKSPACE_ID that names no workspace in the tree is exit 2, with nothing read past the tree or written', async () => {
    // A dry run: with --apply and the check removed, the fake clock never
    // lets the window-gone poll end, so the negative control would hang.
    const {result, w} = await plan({
      own: 77,
      procs: [...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      workspaces: withOwn([ws(2, IDLE_SHELL)]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      `CMUX_WORKSPACE_ID is ${wsId(77)}, and no workspace in the cmux tree has that uuid`,
    );
    expect(w.events).toEqual([]);
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

describe('shared tty (K7, made opt-in by kwand.21 F1)', () => {
  /** Workspaces 1 and 2 both report ttys05; 2 is the own workspace's neighbour. */
  function shared(
    onTty: string[],
    screens: [string, string] = [IDLE_SHELL, IDLE_SHELL],
    extra: Partial<WorldInput> = {},
  ): WorldInput {
    return {
      procs: [...OWN_PROCS, ...onTty],
      workspaces: withOwn([
        {n: 1, panes: [{screen: screens[0], surface: 1, tty: 'ttys05'}]},
        {n: 2, panes: [{screen: screens[1], surface: 2, tty: 'ttys05'}]},
      ]),
      ...extra,
    };
  }
  const FLAG = {options: {closeSharedTty: true}};

  test('without --close-shared-tty a shared-tty workspace is kept as before, with the manual command', async () => {
    const {keptKinds, planned, result} = await plan(
      shared(shellProcs('ttys05', 5000)),
    );
    expect(planned).toEqual([]);
    expect(keptKinds.get('workspace:1')).toEqual(['sharedTty']);
    expect(keptKinds.get('workspace:2')).toEqual(['sharedTty']);
    expect(result.output).toContain(
      `cmux close-workspace --workspace ${wsId(1)} --window ${WINDOW}`,
    );
    expect(result.state?.allExcept?.closeSharedTty).toBe(false);
    expect(result.state?.allExcept?.sharedTty).toEqual({
      keptFor: 2,
      passedByRule: 0,
      workspaces: 2,
    });
  });

  test('with it, only shells on the shared tty and an idle prompt on each own screen: both are planned, counted as passed by the rule', async () => {
    const {planned, result} = await plan(
      shared(shellProcs('ttys05', 5000), undefined, FLAG),
    );
    expect(planned).toEqual(['workspace:1', 'workspace:2']);
    expect(result.state?.allExcept?.sharedTty).toEqual({
      keptFor: 0,
      passedByRule: 2,
      workspaces: 2,
    });
  });

  test('with it, a shared-tty pane with a blank screen is kept; its neighbour with an idle prompt passes', async () => {
    const {keptKinds, planned} = await plan(
      shared(shellProcs('ttys05', 5000), ['', IDLE_SHELL], FLAG),
    );
    // kwand.27 changed this expectation: the blank screen now keeps the
    // workspace as unknown on its own, ahead of the gate's sharedTty, which
    // still shows the shared-tty check did not pass it.
    expect(keptKinds.get('workspace:1')).toEqual(['unknown', 'sharedTty']);
    expect(planned).toEqual(['workspace:2']);
  });

  test('with it, anything else on the shared tty keeps both, with the manual command', async () => {
    const {keptKinds, result} = await plan(
      shared(
        [...shellProcs('ttys05', 5000), '5002 5001 ttys05 01:00 vim notes.md'],
        undefined,
        FLAG,
      ),
    );
    expect(keptKinds.get('workspace:1')).toEqual(['sharedTty', 'running']);
    expect(result.output).toContain(
      `cmux close-workspace --workspace ${wsId(1)} --window ${WINDOW}`,
    );
  });

  test('with it but a Claude process placed in no workspace, both are kept as unknown, naming the pid', async () => {
    const {keptKinds, planned, result} = await plan(
      shared(
        [...shellProcs('ttys05', 5000), `7777 1 ttys77 01:00 ${CLAUDE} --x`],
        undefined,
        FLAG,
      ),
    );
    expect(planned).toEqual([]);
    expect(keptKinds.get('workspace:1')).toEqual(['unknown', 'sharedTty']);
    expect(keptKinds.get('workspace:2')).toEqual(['unknown', 'sharedTty']);
    expect(result.state?.allExcept?.counts.keptByKind.unknown).toBe(2);
    expect(result.state?.allExcept?.unplaced).toEqual({
      keptFor: 2,
      noWorkspace: 0,
      pids: [7777],
      unnamed: 1,
    });
    expect(result.output).toContain(
      '1 live Claude process could not be placed in any workspace (pid 7777)',
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

describe('a Claude placed in no workspace keeps weak-evidence panes (kwand.21 F2)', () => {
  /**
   * Workspace 3: a blank screen, shells on its own tty. Workspace 4: an idle
   * prompt, no process at all on its tty. Workspace 2: an idle prompt with
   * shells on its own tty (strong evidence, the control).
   */
  function weakWorld(extraProcs: string[]): WorldInput {
    return {
      procs: [
        ...OWN_PROCS,
        ...shellProcs('ttys02', 2000),
        ...shellProcs('ttys03', 3000),
        ...extraProcs,
      ],
      workspaces: withOwn([ws(2, IDLE_SHELL), ws(3, ''), ws(4, IDLE_SHELL)]),
    };
  }
  /** No session id anywhere: in live.unplaced. */
  const UNNAMED = `7777 1 ttys77 01:00 ${CLAUDE} --x`;
  /** Named on its command line, but its tty is on no tab: placed in no workspace. */
  const NO_WORKSPACE = `7778 1 ttys78 01:00 ${CLAUDE} --session-id ${sid(8)}`;

  // kwand.24 R1 changed this expectation: workspace 4 (no process at all on
  // its tty) was planned here and is now kept as unknown on its own.
  // kwand.27 changed it again: workspace 3 (a blank screen) was planned here
  // and is now kept as unknown on its own.
  test('without one, the strong-evidence pane is planned; the blank pane (kwand.27) and the pane whose tty runs nothing (kwand.24 R1) are kept as unknown', async () => {
    const {keptKinds, planned, result} = await plan(weakWorld([]));
    expect(planned).toEqual(['workspace:2']);
    expect(keptKinds.get('workspace:3')).toEqual(['unknown']);
    expect(keptKinds.get('workspace:4')).toEqual(['unknown']);
    expect(result.state?.allExcept?.unplaced).toEqual({
      keptFor: 0,
      noWorkspace: 0,
      pids: [],
      unnamed: 0,
    });
  });

  test('an unplaced Claude (no session named) keeps them as unknown, even without --close-shared-tty; the strong-evidence workspace still closes', async () => {
    const {keptKinds, planned, result} = await plan(weakWorld([UNNAMED]));
    expect(planned).toEqual(['workspace:2']);
    // kwand.27 changed this expectation: the blank-screen unknown, then F2's.
    expect(keptKinds.get('workspace:3')).toEqual(['unknown', 'unknown']);
    // kwand.24 R1 changed this expectation: the R1 unknown, then the F2 one.
    expect(keptKinds.get('workspace:4')).toEqual(['unknown', 'unknown']);
    expect(result.state?.allExcept?.unplaced.unnamed).toBe(1);
    expect(result.output).toContain('pane surface:3 shows a blank screen');
    expect(result.output).toContain(
      "no process runs on pane surface:4's tty ttys04",
    );
  });

  test('a session named but placed in no workspace keeps them the same way', async () => {
    const {keptKinds, planned, result} = await plan(weakWorld([NO_WORKSPACE]));
    expect(planned).toEqual(['workspace:2']);
    // kwand.27 changed this expectation: the blank-screen unknown, then F2's.
    expect(keptKinds.get('workspace:3')).toEqual(['unknown', 'unknown']);
    // kwand.24 R1 changed this expectation: the R1 unknown, then the F2 one.
    expect(keptKinds.get('workspace:4')).toEqual(['unknown', 'unknown']);
    expect(result.state?.allExcept?.unplaced).toEqual({
      keptFor: 2,
      noWorkspace: 1,
      pids: [7778],
      unnamed: 0,
    });
  });

  // kwand.27 changed this world: a blank pane (workspace 3 here before) is now
  // kept by the plan itself and never reaches the re-check, so the weak
  // evidence is a shared tty that --close-shared-tty let through the plan.
  test('--apply: one that appears after the plan keeps the weak pane at its re-check, with nothing signalled or closed there', async () => {
    const {keptKinds, result, w} = await plan({
      lateProcs: [UNNAMED],
      options: {apply: true, closeSharedTty: true},
      procs: [...OWN_PROCS, ...shellProcs('ttys05', 5000)],
      workspaces: withOwn([
        {n: 1, panes: [{screen: IDLE_SHELL, surface: 1, tty: 'ttys05'}]},
        {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
      ]),
    });
    expect(result.state?.planned.map((entry) => entry.workspaceRef)).toEqual([
      'workspace:1',
      'workspace:2',
    ]);
    expect(writes(w)).toEqual([
      'record-tabs',
      'log closing',
      'log closing',
      'log kept',
      'log kept',
    ]);
    expect(keptKinds.get('workspace:1')).toEqual(['unknown']);
    expect(keptKinds.get('workspace:2')).toEqual(['unknown']);
    expect(result.state?.closed).toEqual([]);
  });
});

describe('a pane whose tty runs no process at all is kept as unknown (kwand.24)', () => {
  const NO_PROCESS =
    'no process at all runs on tty ttys04, which pane surface:4 reports';
  const NO_UNPLACED = {keptFor: 0, noWorkspace: 0, pids: [], unnamed: 0};

  test('R1: a blank screen with zero processes on its tty is kept as unknown with nothing unplaced, with or without --close-shared-tty', async () => {
    for (const closeSharedTty of [false, true]) {
      const {keptKinds, planned, result} = await plan({
        options: {closeSharedTty},
        procs: [...OWN_PROCS, ...shellProcs('ttys02', 2000)],
        workspaces: withOwn([ws(2, IDLE_SHELL), ws(4, '')]),
      });
      expect(planned).toEqual(['workspace:2']);
      // kwand.27 changed this expectation: R1's unknown, then the blank
      // screen's (each keep is independent; the first names the Kept as).
      expect(keptKinds.get('workspace:4')).toEqual(['unknown', 'unknown']);
      expect(result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
      expect(result.output).toContain(NO_PROCESS);
    }
  });

  test('R1: a non-blank idle prompt with zero processes on its tty is still kept (the empty tty is the gap, not the screen)', async () => {
    const {keptKinds, planned, result} = await plan({
      procs: [...OWN_PROCS, ...shellProcs('ttys02', 2000)],
      workspaces: withOwn([ws(2, IDLE_SHELL), ws(4, IDLE_SHELL)]),
    });
    expect(planned).toEqual(['workspace:2']);
    expect(keptKinds.get('workspace:4')).toEqual(['unknown']);
    expect(result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
    expect(result.state?.allExcept?.counts.keptByKind.unknown).toBe(1);
  });

  test('R1 at the re-check: the plan saw shells on the tty, the re-check sees none, so it is kept with nothing signalled or closed', async () => {
    const shells = shellProcs('ttys04', 4000);
    const {keptKinds, result, w} = await plan({
      goneProcs: shells,
      options: {apply: true},
      procs: [...OWN_PROCS, ...shells],
      workspaces: withOwn([ws(4, IDLE_SHELL)]),
    });
    expect(result.state?.planned.map((entry) => entry.workspaceRef)).toEqual([
      'workspace:4',
    ]);
    expect(writes(w)).toEqual(['record-tabs', 'log closing', 'log kept']);
    expect(keptKinds.get('workspace:4')).toEqual(['unknown']);
    expect(result.state?.closed).toEqual([]);
    noForce(w);
  });

  test('R3: with --close-shared-tty, a shared tty with zero processes does not pass the shared-tty check', async () => {
    const {keptKinds, planned, result} = await plan({
      options: {closeSharedTty: true},
      procs: OWN_PROCS,
      workspaces: withOwn([
        {n: 1, panes: [{screen: IDLE_SHELL, surface: 1, tty: 'ttys05'}]},
        {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
      ]),
    });
    expect(planned).toEqual([]);
    expect(keptKinds.get('workspace:1')).toEqual(['unknown', 'sharedTty']);
    expect(keptKinds.get('workspace:2')).toEqual(['unknown', 'sharedTty']);
    expect(result.state?.allExcept?.sharedTty).toEqual({
      keptFor: 2,
      passedByRule: 0,
      workspaces: 2,
    });
  });

  // kwand.27 changed this world: the weak evidence was a blank pane, which the
  // plan now keeps on its own, so it is a shared tty (workspaces 3 and 4)
  // that --close-shared-tty lets through while every Claude is placed.
  test('R2: a second Claude process of a session already placed, on a tty no tab reports, counts as unplaced and keeps the weak-evidence workspace', async () => {
    const SECOND = `7779 1 ttys79 01:00 ${CLAUDE} --session-id ${sid(1)} --settings x`;
    const base: WorldInput = {
      facts: [fact(1)],
      options: {closeSharedTty: true},
      procs: [claudeProc(1), ...OWN_PROCS, ...shellProcs('ttys05', 5000)],
      workspaces: withOwn([
        ws(1, idleClaude(sid(1))),
        {n: 3, panes: [{screen: IDLE_SHELL, surface: 3, tty: 'ttys05'}]},
        {n: 4, panes: [{screen: IDLE_SHELL, surface: 4, tty: 'ttys05'}]},
      ]),
    };
    // Control: one process, placed; the shells-only shared tty is planned.
    const one = await plan(base);
    expect(one.planned).toEqual(['workspace:1', 'workspace:3', 'workspace:4']);
    const two = await plan({...base, procs: [...(base.procs ?? []), SECOND]});
    expect(two.planned).toEqual(['workspace:1']);
    expect(two.keptKinds.get('workspace:3')).toEqual(['unknown', 'sharedTty']);
    expect(two.keptKinds.get('workspace:4')).toEqual(['unknown', 'sharedTty']);
    expect(two.result.state?.allExcept?.unplaced).toEqual({
      keptFor: 2,
      noWorkspace: 1,
      pids: [7779],
      unnamed: 0,
    });
    expect(two.result.output).toContain(
      '1 live Claude process could not be placed in any workspace (pid 7779)',
    );
  });
});

describe('a pane with a blank screen is kept as unknown (kwand.27)', () => {
  const BLANK = 'pane surface:3 shows a blank screen';
  const NO_UNPLACED = {keptFor: 0, noWorkspace: 0, pids: [], unnamed: 0};
  /** Workspace 3 alone on ttys03, which runs only a login and a shell. */
  function shellsOnly(screen: string, closeSharedTty: boolean): WorldInput {
    return {
      options: {closeSharedTty},
      procs: [...OWN_PROCS, ...shellProcs('ttys03', 3000)],
      workspaces: withOwn([ws(3, screen)]),
    };
  }

  test('a blank screen on a tty no other pane reports, running only shells, with nothing unplaced, is kept as unknown, with or without --close-shared-tty', async () => {
    for (const closeSharedTty of [false, true]) {
      const {keptKinds, planned, result} = await plan(
        shellsOnly('', closeSharedTty),
      );
      expect(planned).toEqual([]);
      expect(keptKinds.get('workspace:3')).toEqual(['unknown']);
      expect(result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
      expect(result.state?.allExcept?.sharedTty.workspaces).toBe(0);
      expect(
        result.state?.kept.find((entry) => entry.workspaceRef === 'workspace:3')
          ?.unknownCause,
      ).toBe('blankScreen');
      expect(result.output).toContain(BLANK);
    }
  });

  test('a non-blank idle prompt on the same tty still closes: the keep is about the blank screen only', async () => {
    for (const closeSharedTty of [false, true]) {
      const {keptKinds, planned} = await plan(
        shellsOnly(IDLE_SHELL, closeSharedTty),
      );
      expect(planned).toEqual(['workspace:3']);
      expect(keptKinds.has('workspace:3')).toBe(false);
    }
  });

  test('at the re-check: the plan saw an idle prompt, the re-check sees a blank screen, so it is kept with nothing signalled or closed', async () => {
    const {keptKinds, result, w} = await plan({
      ...shellsOnly(IDLE_SHELL, false),
      laterScreens: {3: ''},
      options: {apply: true},
    });
    expect(result.state?.planned.map((entry) => entry.workspaceRef)).toEqual([
      'workspace:3',
    ]);
    expect(writes(w)).toEqual(['record-tabs', 'log closing', 'log kept']);
    expect(keptKinds.get('workspace:3')).toEqual(['unknown']);
    const kept = result.state?.kept.find(
      (entry) => entry.workspaceRef === 'workspace:3',
    );
    expect(kept?.reasons[0]).toContain(BLANK);
    expect(kept?.unknownCause).toBe('blankScreen');
    expect(result.state?.closed).toEqual([]);
    noForce(w);
  });

  test('a named close still passes a blank pane whose tty runs only shells (kwand.20: unchanged)', async () => {
    const w = world({
      ...shellsOnly('', false),
      options: {allExcept: false, dryRun: true, workspaces: ['workspace:3']},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.state?.planned.map((entry) => entry.workspaceRef)).toEqual([
      'workspace:3',
    ]);
    expect(result.state?.kept).toEqual([]);
  });
});

describe('the "Kept as" line of an unknown keep says what happened (kwand.27)', () => {
  const UNSEEN = 'unknown (a Claude process could be running here unseen)';
  const NO_PROCESS_TTY =
    'unknown (no process runs on the terminal a tab reports, so what runs in that tab cannot be seen)';
  const BLANK_SCREEN =
    'unknown (a tab shows a blank screen, so what runs in it cannot be seen)';
  const UNREAD = 'unknown (a fact could not be read)';
  /** Every "Kept as" value in the text output, in order. */
  const keptAsValues = (output: string): string[] =>
    [...output.matchAll(/^\s*Kept as:\s+(.+)$/gmu)].map(
      (match) => match[1] ?? '',
    );

  test('the unplaced, zero-process and blank-screen keeps never say a fact could not be read; the JSON kind stays unknown and unknownCause names the cause', async () => {
    const UNNAMED = `7777 1 ttys77 01:00 ${CLAUDE} --x`;
    const {keptKinds, result} = await plan({
      procs: [
        ...OWN_PROCS,
        ...shellProcs('ttys05', 5000),
        ...shellProcs('ttys03', 3000),
        UNNAMED,
      ],
      // 1 and 2 share ttys05 (weak, not blank); 3 is blank; 4's tty runs nothing.
      workspaces: withOwn([
        {n: 1, panes: [{screen: IDLE_SHELL, surface: 1, tty: 'ttys05'}]},
        {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
        ws(3, ''),
        ws(4, IDLE_SHELL),
      ]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['unknown', 'sharedTty']);
    expect(keptKinds.get('workspace:3')).toEqual(['unknown', 'unknown']);
    expect(keptKinds.get('workspace:4')).toEqual(['unknown', 'unknown']);
    const causes = new Map(
      (result.state?.kept ?? []).map((entry) => [
        entry.workspaceRef,
        entry.unknownCause,
      ]),
    );
    expect(causes.get('workspace:1')).toBe('unseenClaude');
    expect(causes.get('workspace:2')).toBe('unseenClaude');
    expect(causes.get('workspace:3')).toBe('blankScreen');
    expect(causes.get('workspace:4')).toBe('noProcessTty');
    expect(causes.get('workspace:9')).toBeUndefined();
    const values = keptAsValues(result.output);
    expect(values.filter((value) => value === UNSEEN)).toHaveLength(2);
    expect(values.filter((value) => value === BLANK_SCREEN)).toHaveLength(1);
    expect(values.filter((value) => value === NO_PROCESS_TTY)).toHaveLength(1);
    expect(values).toContain("this command's own workspace");
    expect(values).toHaveLength(5);
    expect(
      values.filter((value) => value.includes('a fact could not be read')),
    ).toEqual([]);
  });

  test('a fact that could not be read still says so', async () => {
    const {keptKinds, result} = await plan({
      facts: [fact(1, {flags: null, unreadable: 'br failed'})],
      procs: [claudeProc(1), ...OWN_PROCS],
      workspaces: withOwn([ws(1, idleClaude(sid(1)))]),
    });
    expect(keptKinds.get('workspace:1')).toEqual(['unknown']);
    const causeOf = (ref: string) =>
      result.state?.kept.find((entry) => entry.workspaceRef === ref)
        ?.unknownCause;
    expect(causeOf('workspace:1')).toBe('unreadFact');
    // The own workspace has no unknown reason, so no cause at all.
    expect(causeOf('workspace:9')).toBeUndefined();
    expect(keptAsValues(result.output)).toContain(UNREAD);
  });

  test('--help names every cause and the blank-screen keep', () => {
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = Bun.spawnSync(
      [process.execPath, cli, 'thread', 'close', '--help'],
      {
        env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off', NO_COLOR: '1'},
        stdin: 'ignore',
      },
    );
    expect(run.exitCode).toBe(0);
    const help = run.stdout.toString().replaceAll(/\s+/gu, ' ');
    expect(help).toContain(
      'A tab whose screen is blank keeps its workspace as unknown, whatever runs on its terminal',
    );
    for (const cause of [UNSEEN, NO_PROCESS_TTY, BLANK_SCREEN, UNREAD]) {
      // --help quotes the words inside the parentheses.
      const words = cause.slice('unknown ('.length, -1);
      expect(help).toContain(`"${words}"`);
    }
  });
});

describe('a Claude on a shared tty counts as placed when its session is in a workspace with a tab reporting that tty (kwand.26)', () => {
  const NO_UNPLACED = {keptFor: 0, noWorkspace: 0, pids: [], unnamed: 0};
  /** Claude 1 (pid 1001, named on its command line) on ttys05, beside its login and shell. */
  const CLAUDE_ON_05 = [claudeProc(1, 'ttys05'), ...shellProcs('ttys05', 5000)];
  /**
   * Workspaces 1 and 2 both report ttys05: 1 shows session 1's status line
   * (the screen join places the session there), 2 an idle prompt. Workspaces
   * 3 and 4 share ttys06, which runs only shells, each with an idle prompt:
   * --close-shared-tty lets them through only while every Claude is placed.
   */
  function sharedClaude(extra: Partial<WorldInput> = {}): WorldInput {
    return {
      facts: [fact(1)],
      options: {closeSharedTty: true},
      procs: [...OWN_PROCS, ...CLAUDE_ON_05, ...shellProcs('ttys06', 6000)],
      workspaces: withOwn([
        {
          n: 1,
          panes: [{screen: idleClaude(sid(1)), surface: 1, tty: 'ttys05'}],
        },
        {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
        {n: 3, panes: [{screen: IDLE_SHELL, surface: 3, tty: 'ttys06'}]},
        {n: 4, panes: [{screen: IDLE_SHELL, surface: 4, tty: 'ttys06'}]},
      ]),
      ...extra,
    };
  }

  test('with --close-shared-tty it is not unplaced, every tab reporting its tty stays kept as sharedTty, and the shells-only shared tty passes again', async () => {
    const {keptKinds, planned, result} = await plan(sharedClaude());
    const all = result.state?.allExcept;
    expect(all?.unplaced).toEqual(NO_UNPLACED);
    expect(all?.placedOnSharedTty).toEqual([1001]);
    expect(planned).toEqual(['workspace:3', 'workspace:4']);
    for (const ref of ['workspace:1', 'workspace:2']) {
      expect(keptKinds.get(ref)?.[0]).toBe('sharedTty');
      expect(keptKinds.get(ref)).not.toContain('unknown');
    }
    expect(all?.counts.keptByKind).toEqual({own: 1, sharedTty: 2});
    expect(all?.sharedTty).toEqual({
      keptFor: 2,
      passedByRule: 2,
      workspaces: 4,
    });
    expect(result.output).toContain(
      '1 live Claude process on a shared tty (pid 1001) counted as placed, since its session is in a workspace with a tab that reports its tty',
    );
  });

  test('without --close-shared-tty nothing more closes, and the shells-only shared tty is kept as sharedTty, not unknown', async () => {
    const {keptKinds, planned, result} = await plan(
      sharedClaude({options: {}}),
    );
    expect(planned).toEqual([]);
    expect(result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
    expect(result.state?.allExcept?.placedOnSharedTty).toEqual([1001]);
    expect(keptKinds.get('workspace:3')).toEqual(['sharedTty']);
    expect(keptKinds.get('workspace:4')).toEqual(['sharedTty']);
  });

  test('the compound stale case is still kept, by the blank-screen keep: every tab reporting the Claude’s tty is stale, and its real tab reports a shells-only tty with a blank screen', async () => {
    const {keptKinds, planned, result} = await plan(
      sharedClaude({
        procs: [
          ...OWN_PROCS,
          ...CLAUDE_ON_05,
          ...shellProcs('ttys06', 6000),
          ...shellProcs('ttys07', 7000),
        ],
        workspaces: withOwn([
          // Stale: it still shows session 1's last screen, which places the session here.
          {
            n: 1,
            panes: [{screen: idleClaude(sid(1)), surface: 1, tty: 'ttys05'}],
          },
          {n: 2, panes: [{screen: IDLE_SHELL, surface: 2, tty: 'ttys05'}]},
          {n: 3, panes: [{screen: IDLE_SHELL, surface: 3, tty: 'ttys06'}]},
          {n: 4, panes: [{screen: IDLE_SHELL, surface: 4, tty: 'ttys06'}]},
          // The Claude's real tab: it reports ttys07, where only shells run, and is blank.
          {n: 7, panes: [{screen: '', surface: 7, tty: 'ttys07'}]},
        ]),
      }),
    );
    expect(result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
    expect(result.state?.allExcept?.placedOnSharedTty).toEqual([1001]);
    expect(planned).toEqual(['workspace:3', 'workspace:4']);
    expect(keptKinds.get('workspace:7')).toEqual(['unknown']);
    expect(
      result.state?.kept.find((entry) => entry.workspaceRef === 'workspace:7')
        ?.unknownCause,
    ).toBe('blankScreen');
  });

  test('a Claude on a shared tty whose session is placed only in a workspace with no tab reporting that tty stays unplaced', async () => {
    // Session 1 runs in workspace 1 on its own ttys01; a second process of
    // it runs on ttys05, which workspaces 2 and 5 report.
    const SECOND = `7779 1 ttys05 01:00 ${CLAUDE} --session-id ${sid(1)} --settings x`;
    const input = (screenOf2: string): WorldInput => ({
      facts: [fact(1)],
      options: {closeSharedTty: true},
      procs: [
        claudeProc(1),
        ...OWN_PROCS,
        SECOND,
        ...shellProcs('ttys05', 5000),
        ...shellProcs('ttys06', 6000),
      ],
      workspaces: withOwn([
        ws(1, idleClaude(sid(1))),
        {n: 2, panes: [{screen: screenOf2, surface: 2, tty: 'ttys05'}]},
        {n: 5, panes: [{screen: IDLE_SHELL, surface: 5, tty: 'ttys05'}]},
        {n: 3, panes: [{screen: IDLE_SHELL, surface: 3, tty: 'ttys06'}]},
        {n: 4, panes: [{screen: IDLE_SHELL, surface: 4, tty: 'ttys06'}]},
      ]),
    });
    const elsewhere = await plan(input(IDLE_SHELL));
    expect(elsewhere.result.state?.allExcept?.unplaced).toEqual({
      keptFor: 4,
      noWorkspace: 1,
      pids: [7779],
      unnamed: 0,
    });
    expect(elsewhere.result.state?.allExcept?.placedOnSharedTty).toEqual([]);
    expect(elsewhere.planned).toEqual(['workspace:1']);
    expect(elsewhere.keptKinds.get('workspace:3')).toEqual([
      'unknown',
      'sharedTty',
    ]);
    // Control: workspace 2 shows session 1's status line, so the session is
    // placed with a tab reporting ttys05 as well, and the second process is placed.
    const withTab = await plan(input(idleClaude(sid(1))));
    expect(withTab.result.state?.allExcept?.unplaced).toEqual(NO_UNPLACED);
    expect(withTab.result.state?.allExcept?.placedOnSharedTty).toEqual([7779]);
    expect(withTab.planned).toEqual([
      'workspace:1',
      'workspace:3',
      'workspace:4',
    ]);
  });

  test('a Claude on a shared tty missing from the plan’s own ps (it started after the plan read ps) stays unplaced, so no tab reporting its tty is planned', async () => {
    const late = await plan(
      sharedClaude({
        procs: [
          ...OWN_PROCS,
          ...shellProcs('ttys05', 5000),
          ...shellProcs('ttys06', 6000),
        ],
        procsBeforeLive: [claudeProc(1, 'ttys05')],
      }),
    );
    expect(late.result.state?.allExcept?.unplaced.pids).toEqual([1001]);
    expect(late.result.state?.allExcept?.placedOnSharedTty).toEqual([]);
    expect(late.planned).toEqual([]);
    expect(late.keptKinds.get('workspace:2')).toContain('sharedTty');
    expect(late.keptKinds.get('workspace:3')).toEqual(['unknown', 'sharedTty']);
  });

  test('--apply: the re-check reads the placement against its own view, so the shells-only shared tty closes and the tabs reporting the Claude’s tty stay', async () => {
    const {result, w} = await plan(
      sharedClaude({options: {apply: true, closeSharedTty: true}}),
    );
    expect(writes(w)).toEqual([
      'record-tabs',
      'log closing',
      'log closing',
      `close-workspace ${wsId(3)}`,
      'log closed',
      `close-workspace ${wsId(4)}`,
      'log closed',
    ]);
    expect(result.state?.closed.map((entry) => entry.workspaceRef)).toEqual([
      'workspace:3',
      'workspace:4',
    ]);
    noForce(w);
  });

  test('--help names the shared-tty exception', () => {
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = Bun.spawnSync(
      [process.execPath, cli, 'thread', 'close', '--help'],
      {
        env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off', NO_COLOR: '1'},
        stdin: 'ignore',
      },
    );
    expect(run.exitCode).toBe(0);
    const help = run.stdout.toString().replaceAll(/\s+/gu, ' ');
    expect(help).toContain(
      'One exception: a Claude process on a shared tty counts as placed when its session is placed in a workspace that holds one of the tabs reporting that tty.',
    );
  });
});
