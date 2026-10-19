/**
 * `thread drafts scan` (home-base-yukaf.4): fake cmux tree, fake screens, a
 * temporary threads state dir. Nothing here talks to the real cmux or ps.
 */
import type {CmuxCall} from '../src/thread/cmux';

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {
  dismissDrafts,
  normalizedText,
  renderScan,
  runThreadDraftsList,
  runThreadDraftsScan,
  scanDrafts,
  type ScanResult,
} from '../src/thread/drafts-scan';
import {
  inputDraftsDir,
  readInputDraft,
  writeInputDraft,
} from '../src/thread/input-drafts';
import {appendMessageLine} from '../src/thread/message-log';
import {NO_BREAK_SPACE} from '../src/thread/pane-join';

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const RULE = '─'.repeat(40);
const CLAUDE = '/Users/j/.local/bin/claude';

interface FakePane {
  /** null: read-screen fails for it. */
  screen: string | null;
  surfaceId: string;
  tty: string | null;
  type?: string;
}

/** A Claude screen: the box with `draft` in it, the status line with `id`. */
function claudeScreen(draft: string, id: string | null): string {
  return [
    '⏺ Done.',
    '',
    `  ${RULE} label ─`,
    `❯${draft === '' ? NO_BREAK_SPACE : ` ${draft}`}`,
    RULE,
    id == null ? '  ~/Dev/a  main' : `  ~/Dev/a  main  ⌗ ${id}`,
  ]
    .join('\n')
    .replace(`  ${RULE} label ─`, `${RULE} label ─`);
}

function fakeCmux(panes: readonly FakePane[], treeFails = false) {
  const calls: string[] = [];
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push(args.join(' '));
    if (args[0] === 'ping') {
      return Promise.resolve({kind: 'ok', stdout: 'PONG\n'});
    }
    if (args.includes('tree')) {
      if (treeFails) {
        return Promise.resolve({
          kind: 'failed',
          reason: 'cmux: Failed to connect to socket',
        });
      }
      return Promise.resolve({
        kind: 'ok',
        stdout: JSON.stringify({
          windows: [
            {
              id: 'WIN-1',
              ref: 'window:1',
              workspaces: [
                {
                  id: 'WS-1',
                  panes: panes.map((pane, index) => ({
                    ref: `pane:${index + 1}`,
                    surfaces: [
                      {
                        id: pane.surfaceId,
                        ref: `surface:${index + 1}`,
                        title: 'x',
                        tty: pane.tty,
                        type: pane.type ?? 'terminal',
                      },
                    ],
                  })),
                  ref: 'workspace:1',
                  title: 'ws',
                },
              ],
            },
          ],
        }),
      });
    }
    if (args[0] === 'read-screen') {
      const ref = args[args.indexOf('--surface') + 1] ?? '';
      const pane = panes[Number(ref.replace('surface:', '')) - 1];
      return Promise.resolve(
        pane?.screen == null
          ? {kind: 'failed', reason: 'read-screen failed: surface not ready'}
          : {kind: 'ok', stdout: pane.screen},
      );
    }
    return Promise.resolve({kind: 'failed', reason: `unexpected ${args[0]}`});
  };
  return {calls, run};
}

function psOf(rows: readonly {command: string; pid: number; tty: string}[]) {
  const stdout = [
    '  PID  PPID TT       ELAPSED COMMAND',
    ...rows.map((row) => `${row.pid} 1 ${row.tty} 01:00 ${row.command}`),
  ].join('\n');
  return () => Promise.resolve({kind: 'ok' as const, stdout});
}

let dir = '';
let env: Record<string, string> = {};
let hookStorePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drafts-scan-'));
  env = {
    CMUX_SOCKET_PATH: join(dir, 'cmux.sock'),
    HOME: dir,
    JUSTIN_THREADS_STATE_DIR: join(dir, 'state'),
  };
  hookStorePath = join(dir, 'hook-sessions.json');
  writeFileSync(hookStorePath, JSON.stringify({sessions: {}}));
});

afterEach(() => {
  rmSync(dir, {force: true, recursive: true});
});

const NOW = '2026-10-18T12:00:00.000Z';

async function scan(
  panes: readonly FakePane[],
  ps = psOf([]),
): Promise<ScanResult> {
  const result = await scanDrafts({
    env,
    hookStorePath,
    nowIso: () => NOW,
    ps,
    run: fakeCmux(panes).run,
  });
  if (result.kind !== 'scanned') throw new Error(result.reason);
  return result;
}

function sent(sessionId: string, text: string): void {
  const outcome = appendMessageLine(messageLogPath(sessionId, env), {
    at: '2026-10-18T11:00:00.000Z',
    cwd: '/Users/j/Dev/a',
    event: 'UserPromptSubmit',
    role: 'user',
    text,
  });
  expect(outcome.kind).not.toBe('failed');
}

describe('thread drafts scan', () => {
  test('a draft in a placed pane is stored under the session the status line shows', async () => {
    const result = await scan([
      {
        screen: claudeScreen('fix the flaky test', S1),
        surfaceId: 'SURF-1',
        tty: 'ttys001',
      },
      // A shell pane: no input box, not a Claude pane.
      {screen: '~/Dev/a\n❯ ls\n', surfaceId: 'SURF-2', tty: 'ttys002'},
    ]);
    expect(result.claudePanes).toBe(1);
    expect(result.found).toMatchObject([
      {
        outcome: 'stored',
        placedBy: 'screen',
        sessionId: S1,
        text: 'fix the flaky test',
      },
    ]);
    const stored = readInputDraft(S1, env);
    expect(stored).toMatchObject({
      draft: {
        at: NOW,
        clearedAt: null,
        source: 'scan',
        surfaceId: 'SURF-1',
        text: 'fix the flaky test',
        workspaceId: 'WS-1',
      },
      kind: 'present',
    });
  });

  test('the same text already stored and live leaves its `at` alone', async () => {
    writeInputDraft(
      {
        at: '2026-10-18T09:00:00.000Z',
        sessionId: S1,
        source: 'undo',
        surfaceId: 'SURF-1',
        text: 'fix the flaky test',
        workspaceId: 'WS-1',
      },
      env,
    );
    const result = await scan([
      {
        screen: claudeScreen('fix the flaky test', S1),
        surfaceId: 'SURF-1',
        tty: 'ttys001',
      },
    ]);
    expect(result.found.map((entry) => entry.outcome)).toEqual(['unchanged']);
    expect(readInputDraft(S1, env)).toMatchObject({
      draft: {at: '2026-10-18T09:00:00.000Z', source: 'undo'},
    });
  });

  test('changed text replaces the stored draft', async () => {
    writeInputDraft(
      {
        at: '2026-10-18T09:00:00.000Z',
        sessionId: S1,
        source: 'scan',
        surfaceId: null,
        text: 'fix the',
        workspaceId: null,
      },
      env,
    );
    const result = await scan([
      {
        screen: claudeScreen('fix the flaky test', S1),
        surfaceId: 'SURF-1',
        tty: 'ttys001',
      },
    ]);
    expect(result.found.map((entry) => entry.outcome)).toEqual(['stored']);
    expect(readInputDraft(S1, env)).toMatchObject({
      draft: {at: NOW, text: 'fix the flaky test'},
    });
  });

  test('an empty box clears a stored draft and keeps its text', async () => {
    writeInputDraft(
      {
        at: '2026-10-18T09:00:00.000Z',
        sessionId: S1,
        source: 'scan',
        surfaceId: 'SURF-1',
        text: 'half a thought',
        workspaceId: 'WS-1',
      },
      env,
    );
    const result = await scan([
      {screen: claudeScreen('', S1), surfaceId: 'SURF-1', tty: 'ttys001'},
    ]);
    expect(result.found).toEqual([]);
    expect(result.cleared).toMatchObject([
      {sessionId: S1, text: 'half a thought', why: 'emptyBox'},
    ]);
    expect(readInputDraft(S1, env)).toMatchObject({
      draft: {clearedAt: NOW, text: 'half a thought'},
    });
  });

  describe('a second pane of the session (home-base-yukaf.14 F18)', () => {
    const storeOn = (surfaceId: string, text: string): void => {
      const written = writeInputDraft(
        {
          at: '2026-10-18T09:00:00.000Z',
          sessionId: S1,
          source: 'undo',
          surfaceId,
          text,
          workspaceId: 'WS-1',
        },
        env,
      );
      expect(written.kind).toBe('written');
    };

    test('an empty box on another surface leaves the draft alone while its own surface is still there', async () => {
      storeOn('SURF-OLD', 'half a thought');
      const result = await scan([
        // The reopened session: a new process, an empty box.
        {screen: claudeScreen('', S1), surfaceId: 'SURF-NEW', tty: 'ttys001'},
        // The pane the draft was typed in still exists (Claude exited there).
        {screen: '~/Dev/a\n❯\n', surfaceId: 'SURF-OLD', tty: 'ttys002'},
      ]);
      expect(result.cleared).toEqual([]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: null, surfaceId: 'SURF-OLD', text: 'half a thought'},
      });
    });

    test('an empty box clears the draft once the surface it was typed in is gone', async () => {
      storeOn('SURF-GONE', 'half a thought');
      const result = await scan([
        {screen: claudeScreen('', S1), surfaceId: 'SURF-NEW', tty: 'ttys001'},
      ]);
      expect(result.cleared).toMatchObject([{sessionId: S1, why: 'emptyBox'}]);
    });

    test('different text from another pane keeps the earlier live text in previous', async () => {
      storeOn('SURF-OLD', 'the first idea');
      const result = await scan([
        {
          screen: claudeScreen('a second idea', S1),
          surfaceId: 'SURF-NEW',
          tty: 'ttys001',
        },
      ]);
      expect(result.found.map((entry) => entry.outcome)).toEqual(['stored']);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {
          previous: [
            {
              at: '2026-10-18T09:00:00.000Z',
              surfaceId: 'SURF-OLD',
              text: 'the first idea',
            },
          ],
          surfaceId: 'SURF-NEW',
          text: 'a second idea',
        },
      });
    });
  });

  describe('drafts he no longer wants (home-base-yukaf.14 F2)', () => {
    const store = (n: string, surfaceId: string | null): void => {
      expect(
        writeInputDraft(
          {
            at: '2026-10-18T09:00:00.000Z',
            sessionId: n,
            source: 'scan',
            surfaceId,
            text: `text of ${n.slice(0, 4)}`,
            workspaceId: 'WS-1',
          },
          env,
        ).kind,
      ).toBe('written');
    };

    test('dismiss clears the named drafts (text kept), and thread drafts no longer lists them', async () => {
      store(S1, 'SURF-1');
      const result = dismissDrafts({
        env,
        json: false,
        nowIso: () => NOW,
        sessionIds: [S1, '0000dead-1111-4222-8333-000000000000'],
      });
      expect(result.exitCode).toBe(1);
      expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
        'dismissed',
        'absent',
      ]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: NOW, clearedBy: 'dismissed', text: 'text of aaaa'},
      });
      expect(
        dismissDrafts({env, json: false, sessionIds: [S1]}).outcomes,
      ).toEqual([{kind: 'alreadyCleared', sessionId: S1}]);
      expect(dismissDrafts({env, json: false, sessionIds: []}).exitCode).toBe(
        2,
      );
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...args) => {
        lines.push(args.join(' '));
      });
      const write = spyOn(process.stdout, 'write').mockImplementation(
        (chunk: string | Uint8Array) => {
          lines.push(String(chunk));
          return true;
        },
      );
      try {
        expect(await runThreadDraftsList({env, json: true})).toBe(0);
      } finally {
        spy.mockRestore();
        write.mockRestore();
      }
      expect(lines.join('')).not.toContain(S1);
    });

    test('a draft whose pane is gone is cleared on the second scan in a row, not the first', async () => {
      store(S1, 'SURF-GONE');
      const first = await scan([]);
      expect(first.cleared).toEqual([]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: null, missingSince: NOW},
      });
      const second = await scan([]);
      expect(second.cleared).toMatchObject([{sessionId: S1, why: 'missing'}]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedBy: 'missing', text: 'text of aaaa'},
      });
    });

    test('the two-scan count resets when the pane is seen again, and a draft with no surface is never cleared this way', async () => {
      store(S1, 'SURF-1');
      store(S2, null);
      // First scan: SURF-1 is gone, so S1 is marked missing; S2 has no surface.
      await scan([]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {missingSince: NOW},
      });
      // Second scan: S1's pane is back and shows the same text.
      await scan([
        {
          screen: claudeScreen('text of aaaa', S1),
          surfaceId: 'SURF-1',
          tty: 'ttys001',
        },
      ]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: null, missingSince: null},
      });
      await scan([]);
      const last = await scan([]);
      expect(last.cleared.map((entry) => entry.sessionId)).toEqual([S1]);
      expect(readInputDraft(S2, env)).toMatchObject({
        draft: {clearedAt: null, missingSince: null},
      });
    });
  });

  describe('text equal to the newest sent message (F23)', () => {
    const box = (text: string) => [
      {screen: claudeScreen(text, S1), surfaceId: 'SURF-1', tty: 'ttys001'},
    ];

    test('a box still holding it is unsent: stored with sentMatch, and listed with its note', async () => {
      sent(S1, 'continue');
      const result = await scan(box('continue'));
      expect(result.found.map((entry) => entry.outcome)).toEqual([
        'storedSentMatch',
      ]);
      expect(result.cleared).toEqual([]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: null, sentMatch: true, text: 'continue'},
      });
      expect(renderScan(result, PLAIN_STYLE)).toContain(
        'stored (the same text as your newest sent message)',
      );
      expect(renderScan(result, PLAIN_STYLE)).toContain(
        '1 draft found (1 newly stored, 0 unchanged)',
      );
      // The next scan leaves it alone.
      const again = await scan(box('continue'));
      expect(again.found.map((entry) => entry.outcome)).toEqual(['unchanged']);
    });

    test('a live draft of other text is kept under previous, whitespace collapsed for the match', async () => {
      writeInputDraft(
        {
          at: '2026-10-18T09:00:00.000Z',
          sessionId: S1,
          source: 'scan',
          surfaceId: 'SURF-1',
          text: 'something longer I was writing',
          workspaceId: 'WS-1',
        },
        env,
      );
      sent(S1, 'go with   option a');
      const result = await scan(box('go with option a'));
      expect(result.found.map((entry) => entry.outcome)).toEqual([
        'storedSentMatch',
      ]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {
          previous: [{text: 'something longer I was writing'}],
          sentMatch: true,
          text: 'go with option a',
        },
      });
    });

    test('with its pane gone, a sent-match draft is cleared only by a LATER send', async () => {
      sent(S1, 'yes'); // 11:00
      await scan(box('yes')); // stored at NOW, 12:00, as a sent-match
      expect((await scan([])).cleared).toEqual([]);
      expect(readInputDraft(S1, env)).toMatchObject({
        draft: {clearedAt: null, sentMatch: true},
      });
      appendMessageLine(messageLogPath(S1, env), {
        at: '2026-10-18T12:30:00.000Z',
        cwd: '/Users/j/Dev/a',
        event: 'UserPromptSubmit',
        role: 'user',
        text: 'yes',
      });
      expect((await scan([])).cleared).toMatchObject([
        {sessionId: S1, why: 'sent'},
      ]);
    });
  });

  test('a stored draft of a session no pane shows is cleared once it appears as sent', async () => {
    writeInputDraft(
      {
        at: '2026-10-18T09:00:00.000Z',
        sessionId: S2,
        source: 'undo',
        surfaceId: null,
        text: 'ship it\n  today',
        workspaceId: null,
      },
      env,
    );
    sent(S2, 'ship it today');
    const result = await scan([]);
    expect(result.cleared).toMatchObject([
      {sessionId: S2, surfaceRef: null, why: 'sent'},
    ]);
    expect(readInputDraft(S2, env)).toMatchObject({draft: {clearedAt: NOW}});
  });

  test('a pane with no session id on screen is placed by the claude process on its tty', async () => {
    const result = await scan(
      [
        {
          screen: claudeScreen('placed by ps', null),
          surfaceId: 'SURF-1',
          tty: 'ttys001',
        },
      ],
      psOf([{command: `${CLAUDE} --resume ${S2}`, pid: 501, tty: 'ttys001'}]),
    );
    expect(result.unplaced).toEqual([]);
    expect(result.found).toMatchObject([
      {outcome: 'stored', placedBy: 'process', sessionId: S2},
    ]);
  });

  test('a pane no source can place is reported, and nothing is stored', async () => {
    const result = await scan(
      [
        {
          screen: claudeScreen('who am i', null),
          surfaceId: 'SURF-1',
          tty: 'ttys001',
        },
      ],
      psOf([{command: `${CLAUDE} --settings {}`, pid: 501, tty: 'ttys001'}]),
    );
    expect(result.found).toEqual([]);
    expect(result.unplaced).toMatchObject([
      {
        draft: 'who am i',
        surfaceRef: 'surface:1',
        why: 'no session id on screen, and no claude process on its tty names a session',
      },
    ]);
    expect(existsSync(inputDraftsDir(env))).toBe(false);
    expect(renderScan(result, PLAIN_STYLE)).toContain('Unplaced panes (1)');
  });

  test('two panes showing one session are both unplaced, never guessed', async () => {
    const result = await scan([
      {screen: claudeScreen('one', S1), surfaceId: 'SURF-1', tty: 'ttys001'},
      {screen: claudeScreen('two', S1), surfaceId: 'SURF-2', tty: 'ttys002'},
    ]);
    expect(result.found).toEqual([]);
    expect(result.unplaced.map((entry) => entry.draft)).toEqual(['one', 'two']);
    expect(existsSync(inputDraftsDir(env))).toBe(false);
  });

  test('a screen that cannot be read is its own outcome, not "no drafts"', async () => {
    const result = await scan([
      {screen: null, surfaceId: 'SURF-1', tty: 'ttys001'},
    ]);
    expect(result.unreadable).toMatchObject([{surfaceRef: 'surface:1'}]);
    expect(renderScan(result, PLAIN_STYLE)).toContain(
      'Screens that could not be read (1)',
    );
  });

  test('cmux unreachable: exit 2, the reason names cmux, and nothing is written', async () => {
    writeInputDraft(
      {
        at: '2026-10-18T09:00:00.000Z',
        sessionId: S1,
        source: 'scan',
        surfaceId: null,
        text: 'keep',
        workspaceId: null,
      },
      env,
    );
    const {calls, run} = fakeCmux([], true);
    const code = await runThreadDraftsScan({
      deps: {hookStorePath, nowIso: () => NOW, ps: psOf([]), run},
      env,
      json: true,
      style: PLAIN_STYLE,
    });
    expect(code).toBe(2);
    expect(calls.some((call) => call.startsWith('read-screen'))).toBe(false);
    expect(readdirSync(inputDraftsDir(env))).toEqual([`${S1}.json`]);
    expect(readInputDraft(S1, env)).toMatchObject({
      draft: {at: '2026-10-18T09:00:00.000Z', clearedAt: null},
    });
  });

  test('F3: an unreachable cmux names the socket and where it came from, env or last-socket-path', async () => {
    // Ping refused, as when launchd's process cannot reach the socket.
    const pingFails = (): Promise<CmuxCall> =>
      Promise.resolve({
        kind: 'failed',
        reason: 'cmux: Failed to connect to socket',
      });
    const reasonOf = async (
      over: Record<string, string>,
      run: (args: readonly string[]) => Promise<CmuxCall> = pingFails,
    ): Promise<string> => {
      const lines: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args) => {
        lines.push(args.join(' '));
      });
      try {
        expect(
          await runThreadDraftsScan({
            deps: {hookStorePath, nowIso: () => NOW, ps: psOf([]), run},
            env: over,
            json: false,
            style: PLAIN_STYLE,
          }),
        ).toBe(2);
      } finally {
        spy.mockRestore();
      }
      return lines.join('\n');
    };
    expect(await reasonOf(env)).toContain(
      `cmux cannot be reached at the socket ${env.CMUX_SOCKET_PATH} (from CMUX_SOCKET_PATH)`,
    );
    // launchd's environment: no CMUX_SOCKET_PATH, the file cmux writes.
    const home = join(dir, 'home');
    mkdirSync(join(home, '.local/state/cmux'), {recursive: true});
    writeFileSync(
      join(home, '.local/state/cmux/last-socket-path'),
      '/x/cmux.sock\n',
    );
    const {CMUX_SOCKET_PATH: _unused, ...rest} = env;
    expect(await reasonOf({...rest, HOME: home})).toContain(
      'cmux cannot be reached at the socket /x/cmux.sock (from ~/.local/state/cmux/last-socket-path)',
    );
    // A ping that answers and a tree read that fails names it too.
    expect(await reasonOf(env, fakeCmux([], true).run)).toContain(
      `cmux: Failed to connect to socket, at the socket ${env.CMUX_SOCKET_PATH} (from CMUX_SOCKET_PATH)`,
    );
  });

  test('normalizedText collapses the wrap a screen adds', () => {
    expect(normalizedText('a long\n  line  of text ')).toBe(
      'a long line of text',
    );
  });
});
