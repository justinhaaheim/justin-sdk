/**
 * `thread dashboard --web` (home-base-yukaf.11, D-WEB): the server's checks,
 * proven against a real Bun.serve on 127.0.0.1 with a FAKE inbox loader and a
 * FAKE runner. The runner records each command instead of running it, so no
 * test here archives, marks done or opens anything for real.
 *
 * Run with the sandbox off: binding a local port is refused inside it.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {renderConfigSchema} from '../src/sdk-config';
import {resolveThreadConfig} from '../src/thread/config';
import {
  cardVersion,
  DASHBOARD_ARCHIVE_REASON,
  type DashboardCommand,
  type DashboardInbox,
  dashboardInboxOf,
  type DashboardSession,
  inboxVersion,
  NO_CHECKOUT,
  planAction,
} from '../src/thread/dashboard-plan';
import {
  type CommandRun,
  createDashboardServer,
  type DashboardLogEntry,
  dashboardLogPath,
  type DashboardServer,
  type InboxLoad,
  runThreadDashboard,
  runThreadDashboardWeb,
  TUI_ELSEWHERE,
} from '../src/thread/dashboard-web';
import {type InboxJson} from '../src/thread/session-inbox';

const SID_A = 'aaaa1111-0000-4000-8000-00000000000a';
const SID_B = 'bbbb2222-0000-4000-8000-00000000000b';
const SID_U = 'cccc3333-0000-4000-8000-00000000000c';

function session(
  overrides: Partial<Omit<DashboardSession, 'stateVersion'>> &
    Pick<DashboardSession, 'sessionId'>,
): DashboardSession {
  const base: Omit<DashboardSession, 'stateVersion'> = {
    card: {
      action: {command: null, text: 'Read Claude’s last reply.'},
      age: '5 minutes ago',
      emoji: '🛑',
      facts: [{label: 'Branch', value: 'main'}],
      optional: null,
      pane: null,
      repoTag: 'DEMO',
      resume: `claude --resume ${overrides.sessionId}`,
      status: '🛑 Needs you',
      title: `Title of ${overrides.sessionId.slice(0, 4)}`,
      unsent: null,
      youAsked: {kind: 'requests', requests: []},
    },
    checkout: '/Users/x/Dev/repo-a',
    inputDraft: null,
    lastActivityAt: '2026-10-18T10:00:00.000Z',
    lastAssistantAt: '2026-10-18T09:59:00.000Z',
    repeats: null,
    repo: 'demo-app',
    section: 'needsYou',
    sessionBeadId: `bead-${overrides.sessionId.slice(0, 4)}`,
    title: `Title of ${overrides.sessionId.slice(0, 4)}`,
    tracked: true,
    unread: true,
    ...overrides,
  };
  return {...base, stateVersion: cardVersion(base)};
}

function inboxOf(sessions: DashboardSession[]): DashboardInbox {
  return {
    problems: [],
    readMarksFailure: null,
    sessions,
    stateVersion: inboxVersion(sessions),
    summary: [
      {
        count: sessions.length,
        emoji: '🛑',
        key: 'needsYou',
        title: 'Needs you',
      },
    ],
  };
}

const untracked = (): DashboardSession =>
  session({
    section: 'notTracked',
    sessionBeadId: null,
    sessionId: SID_U,
    tracked: false,
  });

/** A session the state served, by id (default: the first); throws when absent. */
function pick(
  sessions: readonly DashboardSession[],
  id: string | null = null,
): DashboardSession {
  const found =
    id == null ? sessions[0] : sessions.find((s) => s.sessionId === id);
  if (found == null) throw new Error(`no session ${id ?? '[0]'} was served`);
  return found;
}

/** A loader that answers `inbox` every time. */
function fixed(inbox: DashboardInbox): () => Promise<InboxLoad> {
  return () => Promise.resolve({inbox, kind: 'read'});
}

/** A loader whose next answer the test sets, counting every read. */
function fakeLoader(initial: InboxLoad) {
  const state = {current: initial, reads: 0};
  return {
    load: (): Promise<InboxLoad> => {
      state.reads += 1;
      return Promise.resolve(state.current);
    },
    state,
  };
}

/** A runner that records commands and never runs one. */
function fakeRunner(result: Partial<CommandRun> = {}) {
  const calls: DashboardCommand[] = [];
  return {
    calls,
    run: (command: DashboardCommand): Promise<CommandRun> => {
      calls.push(command);
      return Promise.resolve({
        error: null,
        status: 0,
        stderr: '',
        stdout: 'ok',
        ...result,
      });
    },
  };
}

const servers: DashboardServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function setup(
  sessions: DashboardSession[] = [
    session({sessionId: SID_A}),
    session({sessionId: SID_B}),
    untracked(),
  ],
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dashboard-web-'));
  const loader = fakeLoader({inbox: inboxOf(sessions), kind: 'read'});
  const runner = fakeRunner();
  const server = createDashboardServer({
    loadInbox: loader.load,
    runner: runner.run,
    stateDir,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const act = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/action`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    });
    return {
      body: (await res.json()) as Record<string, unknown>,
      status: res.status,
    };
  };
  const state = async () => {
    const res = await fetch(`${base}/api/state?t=${server.token}`);
    return {
      body: (await res.json()) as {
        error?: string;
        sessions: DashboardSession[];
        stateVersion: string;
      },
      status: res.status,
    };
  };
  const log = (): DashboardLogEntry[] => {
    try {
      return readFileSync(dashboardLogPath(stateDir), 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DashboardLogEntry);
    } catch {
      return [];
    }
  };
  return {act, base, loader, log, runner, server, state, stateDir};
}

/** The body a card's button sends, from what /api/state served. */
function bodyFor(s: DashboardSession, token: string, action: string) {
  return {
    action,
    sessionBeadId: s.sessionBeadId,
    sessionId: s.sessionId,
    stateVersion: s.stateVersion,
    token,
  };
}

describe('the token', () => {
  test('a GET without the right ?t= is 401, and an action without the body token runs nothing', async () => {
    const t = setup();
    expect((await fetch(`${t.base}/`)).status).toBe(401);
    expect((await fetch(`${t.base}/api/state?t=wrong`)).status).toBe(401);
    const a = pick((await t.state()).body.sessions);
    const missing = await t.act({
      ...bodyFor(a, t.server.token, 'archive'),
      token: undefined,
    });
    expect(missing.status).toBe(401);
    const wrong = await t.act(bodyFor(a, 'not-the-token', 'archive'));
    expect(wrong.status).toBe(401);
    expect(t.runner.calls).toHaveLength(0);
    expect(
      (await fetch(`${t.base}/api/quit`, {body: '{}', method: 'POST'})).status,
    ).toBe(401);
    // NEGATIVE CONTROL: the right token is accepted, so 401 was the token.
    expect((await fetch(`${t.base}/?t=${t.server.token}`)).status).toBe(200);
    expect((await t.act(bodyFor(a, t.server.token, 'archive'))).status).toBe(
      200,
    );
    expect(t.runner.calls).toHaveLength(1);
  });
});

describe('the refusals (409): nothing runs', () => {
  test('a stale card version is refused once the session has new activity', async () => {
    const t = setup();
    const shown = pick((await t.state()).body.sessions, SID_A);
    // Session A gets new activity after the page showed it.
    t.loader.state.current = {
      inbox: inboxOf([
        session({lastActivityAt: '2026-10-18T10:05:00.000Z', sessionId: SID_A}),
        session({sessionId: SID_B}),
        untracked(),
      ]),
      kind: 'read',
    };
    const stale = await t.act(bodyFor(shown, t.server.token, 'archive'));
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toContain(
      'changed since the page showed it',
    );
    expect(String(stale.body.error)).toContain('Nothing was run');
    expect(t.runner.calls).toHaveLength(0);
    // NEGATIVE CONTROL: the fresh version for the same session runs.
    const fresh = pick((await t.state()).body.sessions, SID_A);
    expect(fresh.stateVersion).not.toBe(shown.stateVersion);
    expect(
      (await t.act(bodyFor(fresh, t.server.token, 'archive'))).status,
    ).toBe(200);
    expect(t.runner.calls).toHaveLength(1);
  });

  test('a session that moved section is refused too', async () => {
    const t = setup();
    const shown = pick((await t.state()).body.sessions);
    t.loader.state.current = {
      inbox: inboxOf([session({section: 'archived', sessionId: SID_A})]),
      kind: 'read',
    };
    const moved = await t.act(bodyFor(shown, t.server.token, 'done'));
    expect(moved.status).toBe(409);
    expect(String(moved.body.error)).toContain('"archived"');
    expect(t.runner.calls).toHaveLength(0);
  });

  test('activity in ANOTHER session does not refuse (per-card versions, recorded deviation)', async () => {
    const t = setup();
    const shown = (await t.state()).body;
    const a = pick(shown.sessions, SID_A);
    t.loader.state.current = {
      inbox: inboxOf([
        session({sessionId: SID_A}),
        session({lastActivityAt: '2026-10-18T10:09:00.000Z', sessionId: SID_B}),
        untracked(),
      ]),
      kind: 'read',
    };
    // The inbox-wide stateVersion moved...
    expect((await t.state()).body.stateVersion).not.toBe(shown.stateVersion);
    // ...and A's card did not, so A's button still works.
    expect((await t.act(bodyFor(a, t.server.token, 'archive'))).status).toBe(
      200,
    );
    expect(t.runner.calls).toHaveLength(1);
  });

  test('a mismatched session bead id is refused', async () => {
    const t = setup();
    const a = pick((await t.state()).body.sessions);
    const mismatched = await t.act({
      ...bodyFor(a, t.server.token, 'archive'),
      sessionBeadId: 'bead-bbbb',
    });
    expect(mismatched.status).toBe(409);
    expect(String(mismatched.body.error)).toContain(
      'has session bead bead-bbbb, but the inbox now says bead-aaaa',
    );
    // null against a tracked session is a mismatch too, not "untracked".
    expect(
      (
        await t.act({
          ...bodyFor(a, t.server.token, 'archive'),
          sessionBeadId: null,
        })
      ).status,
    ).toBe(409);
    expect(t.runner.calls).toHaveLength(0);
    // NEGATIVE CONTROL: the right bead id runs.
    expect((await t.act(bodyFor(a, t.server.token, 'archive'))).status).toBe(
      200,
    );
    expect(t.runner.calls).toHaveLength(1);
  });

  test('a session no longer in the inbox is refused', async () => {
    const t = setup();
    const a = pick((await t.state()).body.sessions);
    t.loader.state.current = {
      inbox: inboxOf([session({sessionId: SID_B})]),
      kind: 'read',
    };
    const gone = await t.act(bodyFor(a, t.server.token, 'archive'));
    expect(gone.status).toBe(409);
    expect(String(gone.body.error)).toContain('is not in the inbox any more');
    expect(t.runner.calls).toHaveLength(0);
  });

  test('archive and done on an untracked session are refused', async () => {
    const t = setup();
    const u = pick((await t.state()).body.sessions, SID_U);
    for (const action of ['archive', 'done']) {
      const refused = await t.act(bodyFor(u, t.server.token, action));
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toContain('no session bead');
    }
    expect(t.runner.calls).toHaveLength(0);
  });

  test('a malformed request is a 400 and runs nothing', async () => {
    const t = setup();
    const a = pick((await t.state()).body.sessions);
    expect(
      (await t.act({...bodyFor(a, t.server.token, 'delete')})).status,
    ).toBe(400);
    expect(
      (
        await t.act({
          ...bodyFor(a, t.server.token, 'archive'),
          stateVersion: '',
        })
      ).status,
    ).toBe(400);
    expect(
      (await t.act({...bodyFor(a, t.server.token, 'archive'), sessionId: 42}))
        .status,
    ).toBe(400);
    const notJson = await fetch(`${t.base}/api/action`, {
      body: 'archive please',
      method: 'POST',
    });
    expect(notJson.status).toBe(400);
    expect(t.runner.calls).toHaveLength(0);
  });
});

describe('a valid action runs exactly one command, with the right ids, and is logged', () => {
  test('archive, done, read, unread, open: one command each, naming this session', async () => {
    const t = setup([
      session({sessionId: SID_A}),
      session({
        card: {
          ...session({sessionId: SID_B}).card,
          pane: 'cmux select-workspace --workspace W-B',
        },
        sessionId: SID_B,
      }),
    ]);
    const sessions = (await t.state()).body.sessions;
    const a = pick(sessions, SID_A);
    const b = pick(sessions, SID_B);
    const tail = (command: DashboardCommand | undefined): string[] =>
      command?.kind === 'argv' ? command.argv.slice(2) : [];

    expect((await t.act(bodyFor(a, t.server.token, 'archive'))).status).toBe(
      200,
    );
    expect(t.runner.calls).toHaveLength(1);
    const archive = t.runner.calls[0];
    expect(archive?.kind === 'argv' ? archive.argv[0] : null).toBe(
      process.execPath,
    );
    expect(tail(archive)).toEqual([
      'thread',
      'archive',
      'bead-aaaa',
      '--reason',
      DASHBOARD_ARCHIVE_REASON,
    ]);

    expect((await t.act(bodyFor(a, t.server.token, 'done'))).status).toBe(200);
    expect(tail(t.runner.calls[1])).toEqual([
      'thread',
      'done',
      '--session',
      SID_A,
    ]);

    expect((await t.act(bodyFor(a, t.server.token, 'read'))).status).toBe(200);
    expect(tail(t.runner.calls[2])).toEqual([
      'thread',
      'read',
      SID_A,
      '--seen',
      '2026-10-18T09:59:00.000Z',
    ]);

    expect((await t.act(bodyFor(a, t.server.token, 'unread'))).status).toBe(
      200,
    );
    expect(tail(t.runner.calls[3])).toEqual(['thread', 'unread', SID_A]);

    // Open: the known pane line, else a new cmux workspace running the resume.
    expect((await t.act(bodyFor(b, t.server.token, 'open'))).status).toBe(200);
    expect(t.runner.calls[4]).toEqual({
      kind: 'shell',
      line: 'cmux select-workspace --workspace W-B',
    });
    expect((await t.act(bodyFor(a, t.server.token, 'open'))).status).toBe(200);
    expect(t.runner.calls[5]).toEqual({
      argv: [
        'cmux',
        'new-workspace',
        '--name',
        '[DEMO] Title of aaaa',
        // F24: the new workspace starts in the session's checkout.
        '--cwd',
        '/Users/x/Dev/repo-a',
        '--command',
        `claude --resume ${SID_A}`,
      ],
      kind: 'argv',
    });

    // resumeCommand answers with the line and runs nothing.
    const resume = await t.act(bodyFor(a, t.server.token, 'resumeCommand'));
    expect(resume.status).toBe(200);
    expect(resume.body.text).toBe(`claude --resume ${SID_A}`);
    expect(t.runner.calls).toHaveLength(6);
  });

  test('the log holds a running line before the command and an outcome line after; refusals are logged too', async () => {
    const t = setup();
    const a = pick((await t.state()).body.sessions);
    await t.act(bodyFor(a, t.server.token, 'archive'));
    const lines = t.log();
    expect(lines.map((line) => [line.phase, line.outcome])).toEqual([
      ['running', null],
      ['outcome', 'ran'],
    ]);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId ?? 'missing');
    expect(lines[1]?.request).toEqual({
      action: 'archive',
      sessionBeadId: 'bead-aaaa',
      sessionId: SID_A,
      stateVersion: a.stateVersion,
      tokenOk: true,
    });
    expect(lines[1]?.command).toContain(
      `thread archive bead-aaaa --reason '${DASHBOARD_ARCHIVE_REASON}'`,
    );
    expect(lines[1]?.exit).toBe(0);
    // A refusal: one outcome line with the reason, and no token in the log.
    await t.act({
      ...bodyFor(a, t.server.token, 'archive'),
      sessionBeadId: 'bead-zzzz',
    });
    const refused = t.log()[2];
    expect(refused?.outcome).toBe('refused');
    expect(refused?.httpStatus).toBe(409);
    expect(refused?.reason).toContain('bead-zzzz');
    expect(readFileSync(dashboardLogPath(t.stateDir), 'utf8')).not.toContain(
      t.server.token,
    );
  });

  test('a command that fails is a 502 with its output, logged as failed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dashboard-web-'));
    const s = session({sessionId: SID_A});
    const runner = fakeRunner({
      status: 1,
      stderr: 'br: database is locked',
      stdout: '',
    });
    const server = createDashboardServer({
      loadInbox: fixed(inboxOf([s])),
      runner: runner.run,
      stateDir,
    });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/action`, {
      body: JSON.stringify(bodyFor(s, server.token, 'done')),
      method: 'POST',
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as {error: string}).error).toContain(
      'br: database is locked',
    );
    const last =
      readFileSync(dashboardLogPath(stateDir), 'utf8')
        .trim()
        .split('\n')
        .pop() ?? '';
    expect((JSON.parse(last) as DashboardLogEntry).outcome).toBe('failed');
  });

  test('a log that cannot be written refuses the action before anything runs', async () => {
    const blocker = join(
      mkdtempSync(join(tmpdir(), 'dashboard-web-')),
      'not-a-dir',
    );
    writeFileSync(blocker, 'a file where the state dir should be');
    const s = session({sessionId: SID_A});
    const runner = fakeRunner();
    const server = createDashboardServer({
      loadInbox: fixed(inboxOf([s])),
      runner: runner.run,
      stateDir: blocker,
    });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/action`, {
      body: JSON.stringify(bodyFor(s, server.token, 'archive')),
      method: 'POST',
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as {error: string}).error).toContain(
      'nothing was run',
    );
    expect(runner.calls).toHaveLength(0);
  });
});

describe('rule 7: an unreadable inbox is never an empty page', () => {
  test('state is a 500 with the reason, the page says it, and an action runs nothing', async () => {
    const t = setup();
    const a = pick((await t.state()).body.sessions);
    t.loader.state.current = {
      kind: 'failed',
      reason: 'the sessions index is unreadable: /x: EACCES',
    };
    const state = await t.state();
    expect(state.status).toBe(500);
    expect(state.body.error).toContain('EACCES');
    const page = await fetch(`${t.base}/?t=${t.server.token}`);
    expect(page.status).toBe(500);
    expect(await page.text()).toContain(
      'The inbox could not be read: the sessions index is unreadable: /x: EACCES',
    );
    const action = await t.act(bodyFor(a, t.server.token, 'archive'));
    expect(action.status).toBe(500);
    expect(t.runner.calls).toHaveLength(0);
  });

  test('a loader that throws is a failed read with its message', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dashboard-web-'));
    const server = createDashboardServer({
      loadInbox: () => Promise.reject(new Error('bd exploded')),
      runner: fakeRunner().run,
      stateDir,
    });
    servers.push(server);
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/state?t=${server.token}`,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as {error: string}).error).toContain(
      'bd exploded',
    );
  });
});

describe('the page', () => {
  test('cards by section, each carrying its ids, with the four buttons and a see-more toggle; nothing external', async () => {
    const t = setup();
    const res = await fetch(`${t.base}/?t=${t.server.token}`);
    const html = await res.text();
    expect(res.headers.get('content-security-policy')).toContain(
      "script-src 'nonce-",
    );
    expect(html).toContain('🛑 Needs you (2)');
    expect(html).toContain('❔ Not tracked (1)');
    const a = pick((await t.state()).body.sessions, SID_A);
    expect(html).toContain(
      `data-session-id="${SID_A}" data-bead-id="bead-aaaa" data-version="${a.stateVersion}"`,
    );
    for (const label of [
      'Open in cmux',
      'Mark read',
      'Done',
      'Archive',
      'See more',
      'Copy resume command',
    ]) {
      expect(html).toContain(label);
    }
    // The untracked card has no bead id, and its Archive is disabled with why.
    expect(html).toContain(`data-session-id="${SID_U}" data-version=`);
    expect(html).toMatch(
      /data-action="archive" disabled title="Not available: this session has no session bead/,
    );
    expect(html).not.toMatch(
      /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!127\.0\.0\.1)/,
    );
  });

  test('titles are escaped, so a session title cannot inject markup', async () => {
    const evil = session({
      card: {
        ...session({sessionId: SID_A}).card,
        title: '<img src=x onerror=alert(1)>',
      },
      sessionId: SID_A,
    });
    const t = setup([evil]);
    const html = await (await fetch(`${t.base}/?t=${t.server.token}`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('quit and the command', () => {
  test('POST /api/quit stops the server', async () => {
    const t = setup();
    const res = await fetch(`${t.base}/api/quit`, {
      body: JSON.stringify({token: t.server.token}),
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await t.server.done).toBe('quit');
    await Bun.sleep(400);
    let reached = true;
    try {
      await fetch(`${t.base}/api/state?t=${t.server.token}`);
    } catch {
      reached = false;
    }
    expect(reached).toBe(false);
  });

  test('runThreadDashboardWeb prints the URL and exits 0 once the page quits', async () => {
    const env = {
      JUSTIN_THREADS_STATE_DIR: mkdtempSync(join(tmpdir(), 'dashboard-web-')),
    };
    const printed: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) =>
      printed.push(parts.map(String).join(' '));
    let url = '';
    try {
      const code = await runThreadDashboardWeb({
        env,
        loadInbox: fixed(inboxOf([session({sessionId: SID_A})])),
        onReady: (server) => {
          url = server.url;
          void fetch(`http://127.0.0.1:${server.port}/api/quit`, {
            body: JSON.stringify({token: server.token}),
            method: 'POST',
          });
        },
        openBrowser: false,
        runner: fakeRunner().run,
      });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f-]{36}$/);
    expect(printed).toContain(url);
  });

  test('--tui outside home-base prints how to run it and exits 2', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'not-home-base-'));
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) =>
      errors.push(parts.map(String).join(' '));
    try {
      expect(
        await runThreadDashboard({
          cwd,
          env: {HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'xdg')},
          ui: 'tui',
        }),
      ).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors).toContain(TUI_ELSEWHERE);
  });
});

describe('the dashboardUi knob (D-WEB)', () => {
  test('default tui, read from the user file, a misspelling named and ignored, listed by config schema', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dashboard-knob-'));
    const env = {HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'xdg')};
    expect(resolveThreadConfig({cwd, env})).toMatchObject({
      dashboardUi: 'tui',
      dashboardUiSource: 'default',
    });
    const file = join(env.XDG_CONFIG_HOME, 'justin-sdk', 'config.json');
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(
      file,
      JSON.stringify({componentConfig: {thread: {dashboardUi: 'web'}}}),
    );
    expect(resolveThreadConfig({cwd, env})).toMatchObject({
      dashboardUi: 'web',
      dashboardUiSource: 'user',
    });
    writeFileSync(
      file,
      JSON.stringify({componentConfig: {thread: {dashboardUi: 'webb'}}}),
    );
    const bad = resolveThreadConfig({cwd, env});
    expect(bad.dashboardUi).toBe('tui');
    expect(bad.problems.join('\n')).toContain(
      // The schema names it first (the whole file is then a problem, as for
      // answerUi); resolveThreadConfig's own check is the second guard.
      'componentConfig.thread.dashboardUi: Invalid option: expected one of "tui"|"web"',
    );
    expect(
      renderConfigSchema({
        env: {XDG_CONFIG_HOME: '/xdg'},
        projectRoot: '/repo',
      }),
    ).toMatch(/componentConfig\.thread\.dashboardUi +[^\n]*· +default "tui"/);
  });
});

// home-base-yukaf.14 F24. NEGATIVE CONTROL in the bead notes.
describe('Open with no known pane (F24)', () => {
  test('a session with no checkout recorded is refused, never opened where claude --resume finds nothing', () => {
    const s = session({checkout: null, sessionId: SID_A});
    expect(planAction('open', s)).toEqual({
      kind: 'refused',
      reason: NO_CHECKOUT,
    });
    expect(planAction('open', session({sessionId: SID_A}))).toMatchObject({
      command: {argv: expect.arrayContaining(['--cwd']) as unknown},
      kind: 'run',
    });
  });
});

describe('dashboardInboxOf', () => {
  test('maps the inbox JSON, gives each card its version, and names what could not be read', () => {
    const row = {
      card: session({sessionId: SID_A}).card,
      inputDraft: {
        at: '2026-10-18T10:00:00.000Z',
        surfaceId: null,
        text: 'half a thought',
        workspaceId: null,
      },
      lastActivityAt: '2026-10-18T10:00:00.000Z',
      lastAssistantAt: null,
      repeats: {count: 3, oldestAt: null, sessionIds: [SID_A]},
      repo: 'demo-app',
      section: 'unsentDraft',
      sessionBeadId: 'bead-aaaa',
      sessionId: SID_A,
      title: 'Title of aaaa',
      tracked: true,
      unread: null,
    };
    const json = {
      corrupt: [],
      indexPath: '/state/sessions.jsonl',
      inputDrafts: {failures: [], kind: 'read', unshown: []},
      panes: {ok: false, reason: 'cmux is not running'},
      readMarks: {kind: 'failed', reason: 'read-marks.jsonl: EACCES'},
      sessions: [row],
      summary: [
        {
          count: 1,
          emoji: '✍️',
          key: 'unsentDraft',
          lines: 0,
          title: 'Unsent text in the input box',
        },
      ],
    } as unknown as InboxJson;
    const inbox = dashboardInboxOf(json);
    expect(inbox.sessions[0]).toMatchObject({
      inputDraft: 'half a thought',
      repeats: 3,
      section: 'unsentDraft',
      unread: null,
    });
    expect(inbox.sessions[0]?.stateVersion).toBe(
      cardVersion({
        lastActivityAt: row.lastActivityAt,
        section: row.section,
        sessionBeadId: 'bead-aaaa',
        sessionId: SID_A,
      }),
    );
    expect(inbox.readMarksFailure).toBe('read-marks.jsonl: EACCES');
    expect(inbox.problems.join('\n')).toContain('cmux is not running');
    expect(inbox.problems.join('\n')).toContain(
      'Read / unread could not be checked',
    );
  });
});
