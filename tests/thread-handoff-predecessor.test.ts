/**
 * The predecessor watcher of `thread handoff` (home-base-mbnjv.4, epic C6):
 * exit and close act only after the handshake, only on the caller's own tab,
 * and every outcome is noted. Injected time, readers and a fake cmux; one
 * describe block uses a real br bead and a real message log file. No test
 * reaches the real cmux. tests/fixtures/handoff-predecessor/idle-claude.txt
 * is a real screen (its README says where from); the other screens are
 * derived from it here and say so.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {
  BackgroundRead,
  LabelsRead,
  PredecessorLogRecord,
  PredecessorWatch,
  PredecessorWatchDeps,
  TranscriptMark,
  TranscriptTailRead,
} from '../src/thread/handoff-predecessor';
import type {MessageLine, MessageLogRead} from '../src/thread/message-log';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, brUpdate, findBeadsWorkspace, runBr} from '../src/beads/br';
import {
  backgroundOnScreen,
  backgroundReaderOf,
  checkBackground,
  checkLink,
  checkScreen,
  checkStop,
  emptyLedger,
  focusCommandOf,
  foldLedgerLine,
  predecessorActArgs,
  readTranscriptTail,
  realPredecessorWatchDeps,
  runPredecessorWatch,
  TAB_CHANGING_VERBS,
  TOMBSTONE_HEADLINE,
  tombstoneCommand,
  tombstoneLines,
  transcriptMarkOf,
  watcherStartedNote,
} from '../src/thread/handoff-predecessor';
import {serializeMessageLine} from '../src/thread/message-log';
import {
  findInputBox,
  screenLines,
  statusLineIdOf,
} from '../src/thread/pane-join';
import {main, predecessorWatchSchema} from '../src/thread/predecessor-watch';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

/** The session of the real idle screen. */
const OLD = 'aa693548-b000-4b39-8cf4-90a380854827';
const WS = 'AAAA0000-1111-4222-8333-0000000000b2';
const SURF = 'CCCC0000-1111-4222-8333-0000000000c3';
const OTHER = 'EEEE0000-1111-4222-8333-0000000000e5';
const SUCC = 'FFFF0000-1111-4222-8333-0000000000f6';
const HANDED = new Date('2030-01-01T10:00:00.000Z');
const ms = (iso: string) => new Date(iso).getTime();

const FIXTURES = join(import.meta.dir, 'fixtures', 'handoff-predecessor');
const IDLE = readFileSync(join(FIXTURES, 'idle-claude.txt'), 'utf8');
/** Synthetic: the idle screen with a working spinner above the box. */
const WORKING = IDLE.replace(
  '✻ Brewed for 2s · done 6:07 AM',
  '✢ Inferring… (12s · ↓ 1.2k tokens)',
);
/** Synthetic: the idle screen with text typed in the box. */
const TYPED = IDLE.replace(/\n❯ ?\n/u, '\n❯ wait, one more thing\n').replace(
  ' · ← 19 agents',
  '',
);
/** Synthetic: the idle screen of another session. */
const OTHER_SESSION = IDLE.replace(OLD, 'bbbbbbbb-b000-4b39-8cf4-90a380854827');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function watchOf(
  mode: 'close' | 'exit',
  more: Partial<PredecessorWatch> = {},
): PredecessorWatch {
  const focusCommand = focusCommandOf(SUCC, WS);
  return {
    caller: {
      beadId: 't-old',
      db: '/nowhere/beads.db',
      sessionId: OLD,
      surfaceId: SURF,
      workspaceId: WS,
    },
    handedOffAt: HANDED.toISOString(),
    logPath: '/nowhere/handoff-predecessor.jsonl',
    mode,
    pollMs: 5_000,
    settleMs: 5_000,
    successor: {
      name: '[HOME] migrate the db',
      surfaceId: SUCC,
      surfaceRef: 'surface:306',
    },
    timeoutMs: 20 * 60_000,
    tombstone: tombstoneLines({
      focusCommand,
      handedOffAt: HANDED,
      sessionId: OLD,
      successorName: '[HOME] migrate the db',
      timeZone: 'America/Los_Angeles',
    }),
    ...more,
  };
}

const line = (
  role: 'assistant' | 'user',
  event: MessageLine['event'],
  at: string,
): MessageLine => ({at, cwd: '/repo', event, role, text: `${role} at ${at}`});

/** The turn that ran thread handoff, then its Stop 30 s later. */
const STOPPED: MessageLine[] = [
  line('user', 'UserPromptSubmit', '2030-01-01T09:58:00.000Z'),
  line('assistant', 'Stop', '2030-01-01T10:00:30.000Z'),
];

const logOf = (lines: MessageLine[]): MessageLogRead => ({
  failures: [],
  kind: 'read',
  lines,
  path: '/state/messages/x.jsonl',
});

const LINKED: LabelsRead = {
  kind: 'ok',
  labels: ['handed-off', 'continued-by:t-new'],
};
const UNLINKED: LabelsRead = {kind: 'ok', labels: ['handed-off']};
/** The successor this handoff started: it links back from the new tab (F10). */
const THE_SUCCESSOR: LabelsRead = {
  kind: 'ok',
  labels: ['session', 'continues:t-old', `cmux-surface:${SUCC}`],
};

const turnEnd = (at: string): TranscriptMark => ({
  at,
  kind: 'turnEnd',
  typed: false,
  what: 'turn_duration',
});
/** The transcript of the turn that ran thread handoff: it ended after the Stop line. */
const ENDED: TranscriptTailRead = {
  kind: 'read',
  marks: [
    turnEnd('2030-01-01T09:58:20.000Z'),
    turnEnd('2030-01-01T10:00:30.500Z'),
  ],
  path: '/projects/x/old.jsonl',
};

function treeWith(surfaces: string[]): string {
  return JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: WS,
            panes: [
              {
                id: 'DDDD0000-1111-4222-8333-0000000000d4',
                ref: 'pane:285',
                surfaces: surfaces.map((id, index) => ({
                  id,
                  ref: `surface:${300 + index}`,
                })),
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * A fake cmux. The tree lists SURF until close-surface; read-screen answers
 * the next of `screens` (the last repeats) and, after respawn-pane, a screen
 * holding the tombstone.
 */
function fakeCmux(
  input: {
    act?: CmuxCall;
    screens?: string[];
    tombstoneShows?: boolean;
    tree?: CmuxCall;
  } = {},
) {
  const calls: string[][] = [];
  const screens = input.screens ?? [IDLE];
  let read = 0;
  let closed = false;
  let respawned = false;
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    if (args.includes('tree')) {
      if (input.tree != null) return Promise.resolve(input.tree);
      return Promise.resolve({
        kind: 'ok',
        stdout: treeWith(closed ? [OTHER] : [OTHER, SURF]),
      });
    }
    if (args[0] === 'read-screen') {
      if (respawned) {
        const shown =
          input.tombstoneShows === false
            ? 'Last login: today\n❯'
            : `Last login: today\n${TOMBSTONE_HEADLINE}\n❯`;
        return Promise.resolve({kind: 'ok', stdout: shown});
      }
      const text = screens[Math.min(read, screens.length - 1)] ?? '';
      read += 1;
      return Promise.resolve({kind: 'ok', stdout: text});
    }
    if (args[0] === 'respawn-pane' || args[0] === 'close-surface') {
      const answer = input.act ?? {kind: 'ok', stdout: 'OK\n'};
      if (answer.kind === 'ok') {
        if (args[0] === 'close-surface') closed = true;
        else respawned = true;
      }
      return Promise.resolve(answer);
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `the fake cmux does not know ${args.join(' ')}`,
    });
  };
  return {calls, run};
}

/** A session that never launched background work (mbnjv.13). */
const NO_BACKGROUND: BackgroundRead = {
  kind: 'read',
  path: '/projects/x/old.jsonl',
  tasks: [],
  unreadable: [],
};

function depsOf(input: {
  background?: BackgroundRead | (() => BackgroundRead);
  cmux: ReturnType<typeof fakeCmux>;
  labels: LabelsRead | (() => LabelsRead);
  log: MessageLogRead | (() => MessageLogRead);
  logError?: string;
  startMs?: number;
  /** Every other bead's labels (default: THE_SUCCESSOR). */
  successorLabels?: LabelsRead;
  transcript?: TranscriptTailRead | (() => TranscriptTailRead);
}) {
  let now = input.startMs ?? ms('2030-01-01T10:01:00.000Z');
  const notes: string[] = [];
  const records: PredecessorLogRecord[] = [];
  const transcript = input.transcript ?? ENDED;
  const background = input.background ?? NO_BACKGROUND;
  const deps: PredecessorWatchDeps = {
    appendLog: (record) => {
      records.push(record);
      return input.logError ?? null;
    },
    clock: () => now,
    readBackground: () =>
      typeof background === 'function' ? background() : background,
    readLabels: (id) => {
      if (id !== 't-old') return input.successorLabels ?? THE_SUCCESSOR;
      return typeof input.labels === 'function' ? input.labels() : input.labels;
    },
    readLog: () => (typeof input.log === 'function' ? input.log() : input.log),
    readTranscript: () =>
      typeof transcript === 'function' ? transcript() : transcript,
    recordNote: (text) => {
      notes.push(text);
      return {kind: 'recorded'};
    },
    run: input.cmux.run,
    sleep: (wait) => {
      now += wait;
      return Promise.resolve();
    },
    verifyMs: 10_000,
    verifyPollMs: 500,
  };
  return {deps, elapsed: () => now, notes, records};
}

const TAB_VERBS = new Set<string>([
  ...TAB_CHANGING_VERBS,
  'close-workspace',
  'focus-panel',
  'rename-tab',
  'select-workspace',
  'send',
  'send-key',
]);

/** AC3: every call that changes a tab names exactly the captured surface and workspace. */
function tabChanging(calls: string[][]): string[][] {
  const changing = calls.filter((args) => TAB_VERBS.has(args[0] ?? ''));
  for (const args of changing) {
    const surface = args[args.indexOf('--surface') + 1];
    const workspace = args[args.indexOf('--workspace') + 1];
    expect(args.includes('--surface')).toBe(true);
    expect(surface).toBe(SURF);
    expect(workspace).toBe(WS);
  }
  return changing;
}

describe('exit and close act only when (a) and (b) both hold (AC1)', () => {
  test('exit: one respawn-pane on the captured tab with the tombstone, verified and noted', async () => {
    const cmux = fakeCmux();
    const watch = watchOf('exit');
    const {deps, notes, records} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
    });
    const outcome = await runPredecessorWatch(watch, deps);
    expect(outcome.kind).toBe('acted');
    const acts = tabChanging(cmux.calls);
    expect(acts).toEqual([
      [
        'respawn-pane',
        '--workspace',
        WS,
        '--surface',
        SURF,
        '--command',
        tombstoneCommand(watch.tombstone),
      ],
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith(
      `predecessor exited: Claude Code in this tab was ended with cmux respawn-pane and the tab shows a tombstone; the tab shows the tombstone (handshake: continued-by:t-new, which continues:t-old from the new tab ${SUCC}; the turn ended at 2030-01-01T10:00:30.500Z (transcript turn_duration), the final message is in the message log (a Stop line at 2030-01-01T10:00:30.000Z)`,
    );
    expect(records.map((record) => record.event)).toEqual(['acted']);
    expect(records[0]?.surfaceId).toBe(SURF);
  });

  test('close: one close-surface on the captured tab, verified by the tree', async () => {
    const cmux = fakeCmux();
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    const outcome = await runPredecessorWatch(watchOf('close'), deps);
    expect(outcome.kind).toBe('acted');
    expect(tabChanging(cmux.calls)).toEqual([
      ['close-surface', '--workspace', WS, '--surface', SURF],
    ]);
    expect(notes[0]).toStartWith(
      "predecessor closed: this session's tab was closed with cmux close-surface; the tab is gone",
    );
  });

  test('(a) alone does not act: the timeout keeps the tab and names (b)', async () => {
    const cmux = fakeCmux();
    const before = [
      line('user', 'UserPromptSubmit', '2030-01-01T09:58:00.000Z'),
    ];
    const {deps, elapsed, notes, records} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(before),
    });
    const outcome = await runPredecessorWatch(watchOf('exit'), deps);
    expect(outcome.kind).toBe('kept');
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(cmux.calls.some((args) => args[0] === 'read-screen')).toBe(false);
    expect(elapsed() - ms('2030-01-01T10:01:00.000Z')).toBe(20 * 60_000);
    expect(notes).toEqual([
      'predecessor kept: handshake failed: (b) stop: no line in the message log since the handoff at 2030-01-01T10:00:00.000Z (the session has not yielded); screen: not read yet: (a), (b) and the tab come first (gave up after 20 min without acting)',
    ]);
    expect(records.map((record) => record.event)).toEqual(['kept']);
  });

  test('(b) alone does not act: the timeout keeps the tab and names (a)', async () => {
    const cmux = fakeCmux();
    const {deps, notes} = depsOf({cmux, labels: UNLINKED, log: logOf(STOPPED)});
    const outcome = await runPredecessorWatch(watchOf('close'), deps);
    expect(outcome.kind).toBe('kept');
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes[0]).toStartWith(
      'predecessor kept: handshake failed: (a) link: t-old has no continued-by: label (the successor has not run thread request --continues)',
    );
  });

  test('a user line after the Stop: no act, and the watch ends at once', async () => {
    const cmux = fakeCmux();
    const typed = [
      ...STOPPED,
      line('user', 'UserPromptSubmit', '2030-01-01T10:00:40.000Z'),
    ];
    const {deps, elapsed, notes} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(typed),
    });
    const outcome = await runPredecessorWatch(watchOf('exit'), deps);
    expect(outcome.kind).toBe('kept');
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(elapsed()).toBe(ms('2030-01-01T10:01:00.000Z'));
    expect(notes).toEqual([
      'predecessor kept: handshake failed: (b) stop: Justin typed into this session after the handoff (a user line at 2030-01-01T10:00:40.000Z)',
    ]);
  });

  test('a later Stop after a user line still never acts', async () => {
    const cmux = fakeCmux();
    const again = [
      ...STOPPED,
      line('user', 'UserPromptSubmit', '2030-01-01T10:00:40.000Z'),
      line('assistant', 'Stop', '2030-01-01T10:00:50.000Z'),
    ];
    const {deps} = depsOf({cmux, labels: LINKED, log: logOf(again)});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'kept',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
  });

  test('a vanished surface: no act, and the watch ends at once', async () => {
    const cmux = fakeCmux({tree: {kind: 'ok', stdout: treeWith([OTHER])}});
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    const outcome = await runPredecessorWatch(watchOf('close'), deps);
    expect(outcome.kind).toBe('kept');
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes).toEqual([
      `predecessor kept: handshake failed: surface: the tab is gone: surface ${SURF} is not in workspace ${WS}`,
    ]);
  });

  test('a closed workspace counts as a vanished surface', async () => {
    const cmux = fakeCmux({
      tree: {
        kind: 'failed',
        reason:
          'cmux --json --id-format both failed: Error: not_found: Workspace not found',
      },
    });
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'kept',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes[0]).toContain('surface: the tab is gone');
  });

  test('re-checked immediately before acting: a user line in between stops the act', async () => {
    const cmux = fakeCmux();
    let reads = 0;
    const log = () => {
      reads += 1;
      return logOf(
        reads === 1
          ? STOPPED
          : [
              ...STOPPED,
              line('user', 'UserPromptSubmit', '2030-01-01T10:00:59.000Z'),
            ],
      );
    };
    const {deps, notes} = depsOf({cmux, labels: LINKED, log});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'kept',
    );
    expect(reads).toBe(2);
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes[0]).toContain(
      'Justin typed into this session after the handoff',
    );
  });

  test('a Stop younger than the settle time waits, then acts', async () => {
    const cmux = fakeCmux();
    const {deps, elapsed} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
      startMs: ms('2030-01-01T10:00:31.000Z'),
    });
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'acted',
    );
    expect(elapsed()).toBeGreaterThanOrEqual(ms('2030-01-01T10:00:35.000Z'));
  });
});

describe("the caller's own screen must show this session, idle", () => {
  test('working, typed text, or another session: no act; idle later: act', async () => {
    const cmux = fakeCmux({screens: [WORKING, TYPED, OTHER_SESSION, IDLE]});
    const {deps} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'acted',
    );
    const reads = cmux.calls.filter((args) => args[0] === 'read-screen');
    // 3 refusals, then the idle read and its re-read, then the verification.
    expect(reads.length).toBe(6);
    expect(tabChanging(cmux.calls)).toHaveLength(1);
  });

  test('a screen that never settles: the timeout says why', async () => {
    const cmux = fakeCmux({screens: [WORKING]});
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    expect((await runPredecessorWatch(watchOf('close'), deps)).kind).toBe(
      'kept',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes[0]).toContain(
      'screen: the session is working ("✢ Inferring… (12s · ↓ 1.2k tokens)")',
    );
  });

  test('each screen alone: only the idle screen of this session passes', () => {
    const why = (text: string) => {
      const condition = checkScreen({kind: 'ok', stdout: text}, OLD);
      return condition.ok ? 'ok' : condition.why;
    };
    expect(TYPED).not.toBe(IDLE);
    expect(why(IDLE)).toBe('ok');
    expect(why(WORKING)).toBe(
      'the session is working ("✢ Inferring… (12s · ↓ 1.2k tokens)")',
    );
    expect(why(TYPED)).toBe('text is typed in the input box');
    expect(why(OTHER_SESSION)).toBe(
      `the tab shows session bbbbbbbb-b000-4b39-8cf4-90a380854827, not ${OLD}`,
    );
    expect(why('Last login: today\n❯')).toBe(
      'the tab shows no Claude Code input box',
    );
    expect(
      checkScreen({kind: 'failed', reason: 'cmux read-screen failed: x'}, OLD)
        .ok,
    ).toBe(false);
  });

  test('the real idle screen of a named session is read (its top rule carries the name)', () => {
    const lines = screenLines(IDLE);
    const box = findInputBox(lines);
    expect(box?.draft).toBe('');
    expect(statusLineIdOf(IDLE)).toBe(OLD);
  });
});

describe('an act that fails or cannot be verified keeps the record honest', () => {
  test('respawn-pane failing: noted as kept, with the reason', async () => {
    const cmux = fakeCmux({
      act: {kind: 'failed', reason: 'cmux respawn-pane failed: boom'},
    });
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'actFailed',
    );
    expect(notes).toEqual([
      'predecessor kept: cmux respawn-pane on this tab failed: cmux respawn-pane failed: boom',
    ]);
  });

  test('an OK act the screen never shows is noted as NOT verified', async () => {
    const cmux = fakeCmux({tombstoneShows: false});
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'actFailed',
    );
    expect(notes[0]).toContain(
      'but this is NOT verified: cmux answered OK and after 10 s the tab does not show the tombstone',
    );
  });
});

describe('the tombstone (AC4)', () => {
  test('names the successor, the local time, the focus command and the resume command', () => {
    expect(focusCommandOf(SUCC, WS)).toBe(
      `cmux focus-panel --panel ${SUCC} --workspace ${WS}`,
    );
    expect(watchOf('exit').tombstone).toEqual([
      '',
      TOMBSTONE_HEADLINE,
      '',
      '   Handed off to:   [HOME] migrate the db',
      '   At:              Tue 2030-01-01 2:00 am',
      '',
      '   Go to the new tab:',
      `      cmux focus-panel --panel ${SUCC} --workspace ${WS}`,
      '',
      '   Read or resume this session:',
      `      claude --resume ${OLD}`,
      '',
    ]);
  });

  test('sh prints exactly those lines, then execs the login shell', () => {
    const lines = tombstoneLines({
      focusCommand: focusCommandOf(SUCC, WS),
      handedOffAt: HANDED,
      sessionId: OLD,
      successorName: `[HOME] it's "quoted" $HOME \`x\``,
      timeZone: 'America/Los_Angeles',
    });
    const command = tombstoneCommand(lines);
    expect(command).toEndWith('; exec "${SHELL:-/bin/zsh}" -l');
    const printed = execFileSync('/bin/sh', ['-lc', command], {
      encoding: 'utf8',
      env: {...process.env, SHELL: '/usr/bin/true'},
    });
    expect(printed).toBe(`${lines.join('\n')}\n`);
  });

  test('exit respawns with the tombstone; close sends no command at all', () => {
    const exit = predecessorActArgs(watchOf('exit'));
    expect(exit.slice(0, 6)).toEqual([
      'respawn-pane',
      '--workspace',
      WS,
      '--surface',
      SURF,
      '--command',
    ]);
    expect(predecessorActArgs(watchOf('close'))).toEqual([
      'close-surface',
      '--workspace',
      WS,
      '--surface',
      SURF,
    ]);
  });
});

/** The log as the capture leaves it after its rewrite: every line backfill (mbnjv.11). */
const REWRITTEN: MessageLine[] = [
  line('user', 'backfill', '2030-01-01T09:58:00.000Z'),
  line('assistant', 'backfill', '2030-01-01T09:58:10.000Z'),
  line('user', 'backfill', '2030-01-01T09:59:00.000Z'),
  line('assistant', 'backfill', '2030-01-01T10:00:30.000Z'),
];

const why = (condition: ReturnType<typeof checkStop>): string =>
  condition.ok ? `MET: ${condition.saw}` : condition.why;

describe('(b) reads the ended turn from the transcript (home-base-mbnjv.11, F21)', () => {
  const at = {
    handedOffAt: HANDED,
    nowMs: ms('2030-01-01T10:05:00.000Z'),
    settleMs: 5_000,
  };

  test('AC1: a log of backfill lines only passes once the transcript shows the turn ended', () => {
    const met = checkStop({...at, log: logOf(REWRITTEN), transcript: ENDED});
    expect(why(met)).toBe(
      'MET: the turn ended at 2030-01-01T10:00:30.500Z (transcript turn_duration), the final message is in the message log (a backfill line at 2030-01-01T10:00:30.000Z), nothing typed or run since the handoff',
    );
    // Before the settle time it waits.
    const young = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      nowMs: ms('2030-01-01T10:00:32.000Z'),
      transcript: ENDED,
    });
    expect(why(young)).toBe(
      'the turn ended at 2030-01-01T10:00:30.500Z, 2 s ago; waiting until it is 5 s old',
    );
  });

  test('AC1 negative control: a user line after the handoff still refuses, finally', () => {
    const typed = checkStop({
      ...at,
      log: logOf([
        ...REWRITTEN,
        line('user', 'backfill', '2030-01-01T10:00:40.000Z'),
      ]),
      transcript: ENDED,
    });
    expect(typed).toEqual({
      final: true,
      ok: false,
      why: 'Justin typed into this session after the handoff (a user line at 2030-01-01T10:00:40.000Z)',
    });
  });

  test('a turn that has not ended, a session active again, a missing transcript: all wait', () => {
    const notEnded = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      transcript: {...ENDED, marks: [turnEnd('2030-01-01T09:58:20.000Z')]},
    });
    expect(why(notEnded)).toBe(
      'the transcript shows no ended turn (turn_duration) since the handoff at 2030-01-01T10:00:00.000Z',
    );
    const busy = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      transcript: {
        ...ENDED,
        marks: [
          ...ENDED.marks,
          {
            at: '2030-01-01T10:00:50.000Z',
            kind: 'activity',
            typed: false,
            what: 'an assistant record',
          },
        ],
      },
    });
    expect(busy.ok || busy.final).toBe(false);
    expect(why(busy)).toBe(
      'the session is active again: the transcript has an assistant record after its last ended turn',
    );
    const missing = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      transcript: {kind: 'missing', reason: 'no old.jsonl under /projects'},
    });
    expect(why(missing)).toBe(
      'the transcript was not found: no old.jsonl under /projects',
    );
    expect(
      checkStop({...at, log: {kind: 'missing', path: '/p'}, transcript: ENDED})
        .ok,
    ).toBe(false);
  });

  test('F21: a slash command after the handoff turn ended refuses finally, even after a later ended turn', () => {
    const slash: TranscriptMark = {
      at: '2030-01-01T10:00:45.000Z',
      kind: 'activity',
      typed: true,
      what: 'the command /model',
    };
    const after = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      transcript: {...ENDED, marks: [...ENDED.marks, slash]},
    });
    expect(after).toEqual({
      final: true,
      ok: false,
      why: "someone ran the command /model in this session after the handoff's turn ended (at 2030-01-01T10:00:45.000Z)",
    });
    const later = checkStop({
      ...at,
      log: logOf(REWRITTEN),
      transcript: {
        ...ENDED,
        marks: [...ENDED.marks, slash, turnEnd('2030-01-01T10:02:00.000Z')],
      },
    });
    expect(later.ok || !later.final).toBe(false);
  });

  test('the real transcript reader: idle records ignored, /model and sidechains classified, partial lines skipped', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const path = join(sb.path, 'old.jsonl');
    const rec = (value: object) => JSON.stringify(value);
    const records = [
      rec({message: {content: 'go'}, timestamp: 't1', type: 'user'}),
      rec({
        message: {content: [{text: 'done', type: 'text'}]},
        timestamp: 't2',
        type: 'assistant',
      }),
      rec({subtype: 'stop_hook_summary', timestamp: 't3', type: 'system'}),
      rec({subtype: 'turn_duration', timestamp: 't4', type: 'system'}),
      // Idle records Claude Code writes after a turn (measured list).
      rec({subtype: 'away_summary', timestamp: 't5', type: 'system'}),
      rec({type: 'ai-title'}),
      rec({type: 'last-prompt'}),
      rec({operation: 'enqueue', type: 'queue-operation'}),
      // A subagent record is not this session's activity.
      rec({isSidechain: true, timestamp: 't6', type: 'assistant'}),
      // A bare /model, as measured in a real transcript.
      rec({
        isMeta: true,
        message: {
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
        },
        timestamp: 't7',
        type: 'user',
      }),
      rec({
        message: {
          content:
            '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
        },
        timestamp: 't7',
        type: 'user',
      }),
      rec({timestamp: 't8', type: 'brand-new-type'}),
      'not json at all',
    ];
    writeFileSync(path, `${records.join('\n')}\n{"type":"user","mess`);
    const read = readTranscriptTail(path);
    if (read.kind !== 'read') throw new Error(read.reason);
    expect(
      read.marks.map(
        (mark) => `${mark.kind}${mark.typed ? '!' : ''} ${mark.what}`,
      ),
    ).toEqual([
      'activity a user record',
      'activity an assistant record',
      'turnEnd turn_duration',
      'activity! a local command',
      'activity! the command /model',
      'activity a brand-new-type record (not a known idle record)',
      'activity a line that is not valid JSON',
    ]);
    // A tail that starts mid-record drops the partial first line.
    const tail = readTranscriptTail(path, 200);
    if (tail.kind !== 'read') throw new Error(tail.reason);
    expect(tail.marks.every((mark) => mark.at !== 't1')).toBe(true);
    expect(readTranscriptTail(join(sb.path, 'none.jsonl')).kind).toBe(
      'missing',
    );
    expect(transcriptMarkOf({type: 'mode'})).toBeNull();
  });
});

describe('(a) is only THIS handoff’s successor (fix round F10)', () => {
  const base = {
    callerBeadId: 't-old',
    callerLabels: LINKED,
    successorSurfaceId: SUCC,
  };

  test('a continued-by: to a bead that does not link back does not satisfy (a)', () => {
    const stale = checkLink({
      ...base,
      labelsOf: () => ({
        kind: 'ok',
        labels: ['session', `cmux-surface:${SUCC}`],
      }),
    });
    expect(stale).toEqual({
      final: false,
      ok: false,
      why: "continued-by:t-new is not this handoff's successor: it has no continues:t-old",
    });
  });

  test('a successor in a different tab does not satisfy (a)', () => {
    const elsewhere = checkLink({
      ...base,
      labelsOf: () => ({
        kind: 'ok',
        labels: ['continues:t-old', `cmux-surface:${OTHER}`],
      }),
    });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.ok ? '' : elsewhere.why).toBe(
      `continued-by:t-new is not this handoff's successor: its cmux-surface: is ${OTHER}, not the new tab ${SUCC}`,
    );
  });

  test('the right successor does, among stale links, whatever the uuid case', () => {
    const met = checkLink({
      ...base,
      callerLabels: {
        kind: 'ok',
        labels: ['continued-by:t-older', 'continued-by:t-new'],
      },
      labelsOf: (id) =>
        id === 't-new'
          ? {
              kind: 'ok',
              labels: ['continues:t-old', `cmux-surface:${SUCC.toLowerCase()}`],
            }
          : {kind: 'failed', reason: 'br show failed'},
    });
    expect(met).toEqual({
      ok: true,
      saw: `continued-by:t-new, which continues:t-old from the new tab ${SUCC}`,
    });
  });

  test('the watcher never acts on a stale continued-by: alone (the 20-minute timeout keeps the tab)', async () => {
    const cmux = fakeCmux();
    const {deps, notes} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
      successorLabels: {kind: 'ok', labels: ['continued-by:t-x']},
    });
    expect((await runPredecessorWatch(watchOf('close'), deps)).kind).toBe(
      'kept',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes[0]).toContain(
      "(a) link: continued-by:t-new is not this handoff's successor: it has no continues:t-old and it has no cmux-surface: label",
    );
  });
});

describe('F17, F18, F19', () => {
  test('F17: a question in the final report above an empty box passes; a real dialog does not', () => {
    const question = IDLE.replace(
      '⏺ ready',
      '⏺ Do you want to merge it now?\n  ❯ 1. Merge\n    2. Wait\n  Enter to confirm · Esc to cancel',
    );
    expect(question).not.toBe(IDLE);
    expect(checkScreen({kind: 'ok', stdout: question}, OLD).ok).toBe(true);
    const lines = screenLines(IDLE);
    const box = findInputBox(lines);
    if (box == null) throw new Error('fixture has no box');
    // A real permission dialog replaces the input box.
    const dialog = [
      ...lines.slice(0, box.top),
      '────────────────────────────────────────',
      ' Bash command',
      '   rm -rf build',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');
    expect(checkScreen({kind: 'ok', stdout: dialog}, OLD)).toEqual({
      final: false,
      ok: false,
      why: 'the tab shows a permission prompt ("Do you want to …")',
    });
  });

  test('F18: a handshake that holds only after the limit (the Mac slept) does not act', async () => {
    const cmux = fakeCmux();
    const {deps, notes} = depsOf({cmux, labels: LINKED, log: logOf(STOPPED)});
    let jumped = false;
    const clock = deps.clock;
    deps.clock = () => {
      // The first reading starts the watch; every later one is 3 hours on.
      if (!jumped) {
        jumped = true;
        return clock();
      }
      return clock() + 3 * 60 * 60_000;
    };
    expect((await runPredecessorWatch(watchOf('exit'), deps)).kind).toBe(
      'kept',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
    expect(notes).toEqual([
      'predecessor kept: the handshake held only after the 20-minute limit had passed (180 min since the watch started; the Mac may have slept), so it did not act',
    ]);
  });

  test('F19: a log line that cannot be written is named on the bead', async () => {
    const cmux = fakeCmux();
    const {deps, notes, records} = depsOf({
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
      logError: 'EACCES: permission denied',
    });
    expect((await runPredecessorWatch(watchOf('close'), deps)).kind).toBe(
      'acted',
    );
    expect(records.map((record) => record.event)).toEqual(['acted']);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBe(
      'predecessor log NOT written (/nowhere/handoff-predecessor.jsonl): EACCES: permission denied; the outcome above is recorded only on this bead',
    );
  });

  test('F19: the watcher-started note names the pid, the log, and a failed started line', () => {
    expect(
      watcherStartedNote({
        logError: null,
        logPath: '/state/handoff-predecessor.jsonl',
        mode: 'exit',
        pid: 4242,
        successorSurfaceId: SUCC,
      }),
    ).toBe(
      `predecessor watcher started: this tab will exit once the successor in tab ${SUCC} links back and this session's turn has ended; watcher pid 4242; log /state/handoff-predecessor.jsonl`,
    );
    expect(
      watcherStartedNote({
        logError: 'ENOSPC',
        logPath: '/state/l.jsonl',
        mode: 'close',
        pid: null,
        successorSurfaceId: SUCC,
      }),
    ).toEndWith(
      'watcher pid ?; its started line was NOT logged to /state/l.jsonl: ENOSPC',
    );
  });
});

describe('the child entry (predecessor-watch.ts)', () => {
  test('--help prints and exits 0; no plan exits 2; a bad plan exits 2', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main([])).toBe(2);
    const sb = createSandbox();
    sandboxes.push(sb);
    const bad = join(sb.path, 'bad.json');
    writeFileSync(bad, JSON.stringify({mode: 'exit'}));
    expect(await main([bad])).toBe(2);
  });

  test('the schema accepts the plan the parent builds', () => {
    const watch = watchOf('exit');
    const parsed = predecessorWatchSchema.safeParse(
      JSON.parse(JSON.stringify(watch)),
    );
    expect(parsed.success).toBe(true);
  });
});

describe('real br and a real message log', () => {
  function world() {
    needBr();
    const sb = createSandbox();
    sandboxes.push(sb);
    const stateDir = join(sb.path, 'state');
    const projects = join(sb.path, 'projects');
    const env: Record<string, string | undefined> = {
      HOME: join(sb.path, 'home'),
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: stateDir,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: projects,
    };
    // mbnjv.11: a real transcript whose turn ended after the handoff.
    mkdirSync(join(projects, '-repo'), {recursive: true});
    writeFileSync(
      join(projects, '-repo', `${OLD}.jsonl`),
      [
        {
          message: {content: 'hand off'},
          timestamp: '2030-01-01T09:59:00.000Z',
          type: 'user',
        },
        {
          message: {content: [{text: 'Handed off.', type: 'text'}]},
          timestamp: '2030-01-01T10:00:30.000Z',
          type: 'assistant',
        },
        {
          subtype: 'stop_hook_summary',
          timestamp: '2030-01-01T10:00:30.400Z',
          type: 'system',
        },
        {
          subtype: 'turn_duration',
          timestamp: '2030-01-01T10:00:30.500Z',
          type: 'system',
        },
        {
          subtype: 'away_summary',
          timestamp: '2030-01-01T10:00:50.000Z',
          type: 'system',
        },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(''),
    );
    const repo = initRepo(sb, 'pred-repo', {'README.md': '# r\n'});
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    const created = runBr(repo, ['create', 'the old session', '--silent']);
    if (!created.ok)
      throw new Error(`br create failed: ${created.reason ?? '?'}`);
    const beadId = created.stdout.trim();
    const space = findBeadsWorkspace(repo);
    if (space.kind !== 'found') throw new Error('no beads workspace');
    // The log as the capture's rewrite leaves it: backfill lines only.
    mkdirSync(join(stateDir, 'messages'), {recursive: true});
    writeFileSync(
      join(stateDir, 'messages', `${OLD}.jsonl`),
      REWRITTEN.map(serializeMessageLine).join(''),
    );
    // F10: the successor's own bead, in the new tab, linking back.
    const succ = runBr(repo, ['create', 'the successor', '--silent']);
    if (!succ.ok) throw new Error(`br create failed: ${succ.reason ?? '?'}`);
    const successorId = succ.stdout.trim();
    const linked = brUpdate({db: space.db, env}, successorId, {
      addLabels: [`continues:${beadId}`, `cmux-surface:${SUCC}`],
    });
    if (linked.kind !== 'ok') throw new Error('successor labels failed');
    const watch = watchOf('exit', {
      caller: {
        beadId,
        db: space.db,
        sessionId: OLD,
        surfaceId: SURF,
        workspaceId: WS,
      },
      logPath: join(stateDir, 'handoff-predecessor.jsonl'),
    });
    return {beadId, db: space.db, env, successorId, watch};
  }

  function realish(
    w: ReturnType<typeof world>,
    cmux: ReturnType<typeof fakeCmux>,
  ) {
    let now = ms('2030-01-01T10:01:00.000Z');
    return {
      ...realPredecessorWatchDeps(w.watch, w.env),
      clock: () => now,
      run: cmux.run,
      sleep: (wait: number) => {
        now += wait;
        return Promise.resolve();
      },
    };
  }

  test('linked and stopped (a backfill-only log, a real transcript): acts, and notes "predecessor exited" on the bead and in the log', async () => {
    const w = world();
    const label = brUpdate({db: w.db, env: w.env}, w.beadId, {
      addLabels: [`continued-by:${w.successorId}`],
    });
    expect(label.kind).toBe('ok');
    const cmux = fakeCmux();
    const outcome = await runPredecessorWatch(w.watch, realish(w, cmux));
    expect(outcome.kind).toBe('acted');
    const shown = brShow({db: w.db, env: w.env}, w.beadId);
    if (shown.kind !== 'ok') throw new Error(shown.kind);
    expect(shown.issue.notes ?? '').toContain(
      'predecessor exited: Claude Code in this tab was ended',
    );
    const log = readFileSync(w.watch.logPath, 'utf8').trim().split('\n');
    expect(
      log.map((text) => (JSON.parse(text) as {event: string}).event),
    ).toEqual(['acted']);
  });

  test('never linked: the timeout notes "predecessor kept: handshake failed: (a)" on the bead', async () => {
    const w = world();
    // Six polls, not 240: each poll runs a real `br show`.
    w.watch.timeoutMs = 30_000;
    const cmux = fakeCmux();
    const outcome = await runPredecessorWatch(w.watch, realish(w, cmux));
    expect(outcome.kind).toBe('kept');
    expect(tabChanging(cmux.calls)).toEqual([]);
    const shown = brShow({db: w.db, env: w.env}, w.beadId);
    if (shown.kind !== 'ok') throw new Error(shown.kind);
    expect(shown.issue.notes ?? '').toContain(
      `predecessor kept: handshake failed: (a) link: ${w.beadId} has no continued-by: label`,
    );
    const log = readFileSync(w.watch.logPath, 'utf8').trim().split('\n');
    expect(
      log.map((text) => (JSON.parse(text) as {event: string}).event),
    ).toEqual(['kept']);
  });
});

// ---------------------------------------------------------------------------
// mbnjv.13: background work keeps the old tab open
// ---------------------------------------------------------------------------

/** The record shapes MEASURED on Claude Code 2.1.312 (see the source's header). */
const shellLaunch = (id: string, at: string) =>
  JSON.stringify({
    message: {
      content: [
        {
          content: `Command running in background with ID: ${id}.`,
          tool_use_id: `toolu_${id}`,
          type: 'tool_result',
        },
      ],
    },
    timestamp: at,
    toolUseResult: {
      backgroundTaskId: id,
      interrupted: false,
      stderr: '',
      stdout: '',
    },
    type: 'user',
  });
const agentLaunch = (id: string, at: string) =>
  JSON.stringify({
    message: {
      content: [
        {
          content: [{text: 'Async agent launched successfully.', type: 'text'}],
          tool_use_id: `toolu_${id}`,
          type: 'tool_result',
        },
      ],
    },
    timestamp: at,
    toolUseResult: {agentId: id, isAsync: true, status: 'async_launched'},
    type: 'user',
  });
const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`;
/** Idle: a user record (origin task-notification). */
const notifiedAsUser = (id: string, status: string, at: string) =>
  JSON.stringify({
    message: {content: notification(id, status), role: 'user'},
    origin: {kind: 'task-notification'},
    promptSource: 'system',
    timestamp: at,
    type: 'user',
  });
/** Busy: a queued_command attachment. */
const notifiedAsAttachment = (id: string, status: string, at: string) =>
  JSON.stringify({
    attachment: {prompt: notification(id, status), type: 'queued_command'},
    timestamp: at,
    type: 'attachment',
  });
const sendMessage = (to: string, at: string) =>
  JSON.stringify({
    message: {
      content: [
        {
          id: 'toolu_send',
          input: {message: 'go on', to},
          name: 'SendMessage',
          type: 'tool_use',
        },
      ],
    },
    timestamp: at,
    type: 'assistant',
  });

function ledgerOf(lines: string[]): BackgroundRead {
  const ledger = emptyLedger();
  for (const entry of lines) foldLedgerLine(ledger, entry);
  return {
    kind: 'read',
    path: '/x.jsonl',
    tasks: [...ledger.tasks.values()],
    unreadable: ledger.unreadable,
  };
}

describe('mbnjv.13: the background-task ledger', () => {
  test('a launched shell and subagent with no notification are running', () => {
    const work = checkBackground(
      ledgerOf([
        shellLaunch('bbw8zweuw', '2030-01-01T09:59:00.000Z'),
        agentLaunch('af0722cd71175bf26', '2030-01-01T09:59:01.000Z'),
      ]),
    );
    expect(work.ok ? '' : work.why).toBe(
      'background work is still running: background shell bbw8zweuw (launched 2030-01-01T09:59:00.000Z, no notification that it ended); subagent af0722cd71175bf26 (launched 2030-01-01T09:59:01.000Z, no notification that it ended)',
    );
  });

  test('each ends on its terminal notification, as a user record or a queued attachment', () => {
    const read = ledgerOf([
      shellLaunch('bbw8zweuw', '2030-01-01T09:59:00.000Z'),
      agentLaunch('af0722cd71175bf26', '2030-01-01T09:59:01.000Z'),
      notifiedAsUser('bbw8zweuw', 'completed', '2030-01-01T10:01:00.000Z'),
      notifiedAsAttachment(
        'af0722cd71175bf26',
        'failed',
        '2030-01-01T10:02:00.000Z',
      ),
    ]);
    expect(checkBackground(read)).toEqual({
      ok: true,
      saw: 'all 2 background tasks of this session have ended',
    });
  });

  test('killed and stopped end a task; any other status leaves it running', () => {
    const ended = ledgerOf([
      shellLaunch('a', '2030-01-01T09:59:00.000Z'),
      shellLaunch('b', '2030-01-01T09:59:00.000Z'),
      notifiedAsUser('a', 'killed', '2030-01-01T10:00:00.000Z'),
      notifiedAsUser('b', 'stopped', '2030-01-01T10:00:00.000Z'),
    ]);
    expect(checkBackground(ended).ok).toBe(true);
    const odd = ledgerOf([
      shellLaunch('a', '2030-01-01T09:59:00.000Z'),
      notifiedAsUser('a', 'running', '2030-01-01T10:00:00.000Z'),
    ]);
    expect(checkBackground(odd).ok).toBe(false);
  });

  test('a tool result or an assistant message quoting a notification ends nothing', () => {
    const quoted = JSON.stringify({
      message: {
        content: [
          {
            content: notification('a', 'completed'),
            tool_use_id: 't',
            type: 'tool_result',
          },
        ],
      },
      timestamp: '2030-01-01T10:00:00.000Z',
      type: 'user',
    });
    const said = JSON.stringify({
      message: {
        content: [{text: notification('a', 'completed'), type: 'text'}],
      },
      timestamp: '2030-01-01T10:00:00.000Z',
      type: 'assistant',
    });
    const read = ledgerOf([
      shellLaunch('a', '2030-01-01T09:59:00.000Z'),
      quoted,
      said,
    ]);
    expect(checkBackground(read).ok).toBe(false);
  });

  test('SendMessage to a finished subagent reopens it until it notifies again', () => {
    const lines = [
      agentLaunch('ag1', '2030-01-01T09:59:00.000Z'),
      notifiedAsUser('ag1', 'completed', '2030-01-01T10:00:00.000Z'),
      sendMessage('ag1', '2030-01-01T10:01:00.000Z'),
    ];
    expect(checkBackground(ledgerOf(lines)).ok).toBe(false);
    lines.push(
      notifiedAsAttachment('ag1', 'completed', '2030-01-01T10:02:00.000Z'),
    );
    expect(checkBackground(ledgerOf(lines)).ok).toBe(true);
  });

  test('an async launch without an id, or a launch-shaped line that is not JSON, counts as running', () => {
    const noId = JSON.stringify({
      timestamp: '2030-01-01T09:59:00.000Z',
      toolUseResult: {isAsync: true, status: 'async_launched'},
      type: 'user',
    });
    const work = checkBackground(
      ledgerOf([noId, '{"toolUseResult":{"backgroundTaskId":"x"']),
    );
    expect(work.ok ? '' : work.why).toBe(
      'background work is still running: an async launch at 2030-01-01T09:59:00.000Z whose agent id could not be read; a launch-shaped line that is not valid JSON ({"toolUseResult":{"backgroundTaskId":"x"…)',
    );
  });

  test("a subagent's own records (sidechain) launch nothing in the caller", () => {
    const side = JSON.stringify({
      ...(JSON.parse(shellLaunch('s', '2030-01-01T09:59:00.000Z')) as object),
      isSidechain: true,
    });
    expect(checkBackground(ledgerOf([side])).ok).toBe(true);
  });

  test('an unreadable or missing transcript counts as running', () => {
    expect(checkBackground({kind: 'missing', reason: 'no x.jsonl'}).ok).toBe(
      false,
    );
    expect(checkBackground({kind: 'failed', reason: 'EACCES'}).ok).toBe(false);
  });

  test('backgroundReaderOf reads a real file incrementally, across a partial line and a multibyte character', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const projects = join(sb.path, 'projects');
    mkdirSync(join(projects, '-repo'), {recursive: true});
    const file = join(projects, '-repo', `${OLD}.jsonl`);
    const env = {
      HOME: join(sb.path, 'home'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: projects,
    };
    const first = JSON.stringify({
      message: {content: 'hé ✻ start'},
      type: 'user',
    });
    writeFileSync(
      file,
      `${first}\n${shellLaunch('bg1', '2030-01-01T09:59:00.000Z')}\n`,
    );
    const read = backgroundReaderOf(OLD, env);
    expect(checkBackground(read()).ok).toBe(false);
    const done = notifiedAsUser('bg1', 'completed', '2030-01-01T10:01:00.000Z');
    // Half a line first (Claude Code is writing it): still running.
    writeFileSync(file, done.slice(0, 40), {flag: 'a'});
    expect(checkBackground(read()).ok).toBe(false);
    writeFileSync(file, `${done.slice(40)}\n`, {flag: 'a'});
    expect(checkBackground(read())).toEqual({
      ok: true,
      saw: 'all 1 background tasks of this session have ended',
    });
  });
});

describe('mbnjv.13: the screen shows background shells', () => {
  /** MEASURED: the old tab of live run 20261029T183321Z (B), idle with 2 shells running. */
  const SHELLS = readFileSync(
    join(FIXTURES, 'idle-claude-background-shells.txt'),
    'utf8',
  );
  const SHELLS_SESSION = '65c65740-9fda-4916-925f-ba96fe6513ec';

  test('the measured screen refuses, naming the shells', () => {
    expect(checkScreen({kind: 'ok', stdout: SHELLS}, SHELLS_SESSION)).toEqual({
      final: false,
      ok: false,
      why: 'the tab shows background work still running ("2 shells still running")',
    });
  });

  test('the same screen with no shell counts passes', () => {
    const quiet = SHELLS.replace(' · 2 shells still running', '').replace(
      ' · 2 shells',
      '',
    );
    expect(checkScreen({kind: 'ok', stdout: quiet}, SHELLS_SESSION).ok).toBe(
      true,
    );
  });

  test('a report above the box that mentions shells does not count', () => {
    const lines = screenLines(IDLE);
    const box = findInputBox(lines);
    expect(box).not.toBeNull();
    const report = ['I left 3 shells still running earlier.', ...lines];
    expect(backgroundOnScreen(report, (box?.top ?? 0) + 1)).toBeNull();
  });
});

describe('mbnjv.13: the watcher waits for background work', () => {
  test('a running task keeps the watcher waiting; after it ends and a later turn ends it acts', async () => {
    const cmux = fakeCmux();
    let polls = 0;
    const launched = shellLaunch('bg1', '2030-01-01T09:59:00.000Z');
    const activity: TranscriptMark = {
      at: '2030-01-01T10:05:00.000Z',
      kind: 'activity',
      typed: false,
      what: 'a user record',
    };
    const world = depsOf({
      // The task notifies after 30 polls; its notification starts a turn
      // (activity after the last end) that ends 4 polls later.
      background: () =>
        polls < 30
          ? ledgerOf([launched])
          : ledgerOf([
              launched,
              notifiedAsUser('bg1', 'completed', '2030-01-01T10:05:00.000Z'),
            ]),
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
      transcript: () =>
        polls < 30
          ? ENDED
          : {
              ...ENDED,
              marks:
                polls < 34
                  ? [...ENDED.marks, activity]
                  : [
                      ...ENDED.marks,
                      activity,
                      turnEnd('2030-01-01T10:05:20.000Z'),
                    ],
            },
    });
    const sleep = world.deps.sleep;
    world.deps.sleep = (wait) => {
      polls += 1;
      return sleep(wait);
    };
    const outcome = await runPredecessorWatch(watchOf('exit'), world.deps);
    expect(outcome.kind).toBe('acted');
    expect(polls).toBeGreaterThanOrEqual(34);
    expect(outcome.detail).toContain(
      'all 1 background tasks of this session have ended',
    );
  });

  test('a task that never ends: kept after the limit, the note names it, the tab untouched', async () => {
    const cmux = fakeCmux();
    const world = depsOf({
      background: ledgerOf([shellLaunch('bg1', '2030-01-01T09:59:00.000Z')]),
      cmux,
      labels: LINKED,
      log: logOf(STOPPED),
    });
    const outcome = await runPredecessorWatch(watchOf('close'), world.deps);
    expect(outcome.kind).toBe('kept');
    expect(outcome.detail).toContain(
      '(b) background work: background work is still running: background shell bg1',
    );
    expect(tabChanging(cmux.calls)).toEqual([]);
  });
});
