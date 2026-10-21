/**
 * `thread open`'s draft restore (home-base-yukaf.34). cmux is a fake runner
 * holding a small model of windows, workspaces and panes; each pane's screen
 * comes from a test's function of (reads so far, texts sent to it), built
 * from a real captured Claude screen (fixtures/pane-screen-s24-0655.txt,
 * surface:24, 2026-10-17 06:55: an empty input box, `❯` plus U+00A0). The
 * clock and the sleep are fakes, so the 30 s readiness timeout runs at once.
 * The drafts store is the real one, in a temporary state directory. No test
 * reaches the real cmux (D-NO-LIVE-RUNS); none types into a real pane.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {LiveSessions} from '../src/thread/live-sessions';
import type {
  OpenCandidate,
  OpenDeps,
  OpenOptions,
  OpenRecord,
} from '../src/thread/open';

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {readInputDraft, writeInputDraft} from '../src/thread/input-drafts';
import {
  openedTargets,
  opensDir,
  openSessions,
  writeRecordFile,
} from '../src/thread/open';
import {
  BACKSLASH_REASON,
  ESCAPE_REASON,
  PASTE_REASON,
  restorableText,
  RESTORE_READY_TIMEOUT_MS,
  sendArgs,
} from '../src/thread/open-restore';
import {NO_BREAK_SPACE} from '../src/thread/pane-join';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 60 * 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-open-restore-'));
  dirs.push(dir);
  return dir;
}

/** A session id from a short number, uuid-shaped and lowercase. */
function sid(n: number): string {
  return `${`0000000${n}`.slice(-8)}-1111-4222-8333-000000000000`;
}

// ---------------------------------------------------------------------------
// Screens, from a real capture
// ---------------------------------------------------------------------------

const FIXTURE = readFileSync(
  join(import.meta.dir, 'fixtures', 'pane-screen-s24-0655.txt'),
  'utf8',
);
const FIXTURE_SESSION = 'b7a11012-82a6-45ad-ae5d-a9e4c7c673e1';
const EMPTY_BOX = `❯${NO_BREAK_SPACE}`;

/** The captured idle screen, showing `session` on its status line. */
function idle(session: string): string {
  return FIXTURE.replace(FIXTURE_SESSION, session);
}

/**
 * The idle screen with `text` in the box, wrapped at 40 columns the way the
 * box wraps: continuation lines indented two spaces.
 */
function typed(session: string, text: string): string {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 40) {
    lines.push(rest.slice(0, 40).trimEnd());
    rest = rest.slice(40);
  }
  lines.push(rest);
  const box = [
    `❯ ${lines[0] ?? ''}`,
    ...lines.slice(1).map((line) => `  ${line}`),
  ];
  return idle(session).replace(EMPTY_BOX, box.join('\n'));
}

/** vim NORMAL mode, as measured: status letter N, no "-- INSERT --". */
function vimNormal(session: string): string {
  return idle(session).replace('  I  ✱', '  N  ✱').replace('-- INSERT -- ', '');
}

/** Claude working: a spinner line right above the box's top rule. */
function working(session: string): string {
  const lines = idle(session).split('\n');
  const prompt = lines.findIndex((line) => line === EMPTY_BOX);
  lines.splice(prompt - 1, 0, '✢ Inferring… (2m 40s · ↓ 9.8k tokens)');
  return lines.join('\n');
}

const ZSH = ['Last login: Mon Oct 20', '', ' jhaa  repo-a  main', '❯'].join(
  '\n',
);

// ---------------------------------------------------------------------------
// The fake cmux
// ---------------------------------------------------------------------------

interface FakeSurface {
  id: string;
  ref: string;
  /** The session `claude --resume` was started with; null for a shell. */
  session: string | null;
}

interface FakeWorkspace {
  id: string;
  ref: string;
  surfaces: FakeSurface[];
}

type ScreenFn = (
  surface: FakeSurface,
  read: number,
  sent: readonly string[],
) => string | null;

/** By default: Claude is ready at once, and the box shows whatever was sent. */
const DEFAULT_SCREEN: ScreenFn = (surface, _read, sent) => {
  if (surface.session == null) return ZSH;
  return sent.length === 0
    ? idle(surface.session)
    : typed(surface.session, sent.join(''));
};

interface Fake {
  calls: string[][];
  /** For each send: the newest record's restore entries on disk at that moment. */
  entriesAtSend: unknown[];
  reads: Map<string, number>;
  run: (args: readonly string[]) => Promise<CmuxCall>;
  sends: () => string[][];
  setScreen: (fn: ScreenFn) => void;
  windows: Map<string, {ref: string; workspaces: FakeWorkspace[]}>;
}

function commandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-') && arg !== 'both') ?? '';
}

const SESSION_IN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

function fakeCmux(stateDir: string, failSend: string | null = null): Fake {
  const calls: string[][] = [];
  const windows = new Map<string, {ref: string; workspaces: FakeWorkspace[]}>();
  const reads = new Map<string, number>();
  const sent = new Map<string, string[]>();
  const entriesAtSend: unknown[] = [];
  let screen: ScreenFn = DEFAULT_SCREEN;
  let next = 0;
  const uuid = (prefix: string): string => {
    next += 1;
    return `${prefix}${`000000${next}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
  };
  const surface = (session: string | null): FakeSurface => {
    const id = uuid('E');
    return {id, ref: `surface:${next}`, session};
  };
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';
  const allSurfaces = (): FakeSurface[] =>
    [...windows.values()].flatMap((window) =>
      window.workspaces.flatMap((workspace) => workspace.surfaces),
    );
  const newestRecord = (): Record<string, unknown> | null => {
    const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
    if (!existsSync(dir)) return null;
    const name = readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .at(-1);
    return name == null
      ? null
      : (JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
          string,
          unknown
        >);
  };
  const respond = (args: readonly string[]): CmuxCall => {
    calls.push([...args]);
    switch (commandOf(args)) {
      case 'ping':
        return {kind: 'ok', stdout: 'PONG\n'};
      case 'new-window': {
        const id = uuid('B');
        const workspace = {
          id: uuid('D'),
          ref: `workspace:${next}`,
          surfaces: [surface(null)],
        };
        windows.set(id, {ref: `window:${next}`, workspaces: [workspace]});
        return {kind: 'ok', stdout: `OK ${id}\n`};
      }
      case 'workspace': {
        const list = windows.get(value(args, '--window'))?.workspaces ?? [];
        return {
          kind: 'ok',
          stdout: JSON.stringify({
            workspaces: list.map((entry) => ({id: entry.id, ref: entry.ref})),
          }),
        };
      }
      case 'new-workspace': {
        const window = windows.get(value(args, '--window'));
        if (window == null) return {kind: 'failed', reason: 'no such window'};
        const session = SESSION_IN.exec(value(args, '--command'))?.[0] ?? null;
        const id = uuid('C');
        const ref = `workspace:${next}`;
        window.workspaces.push({id, ref, surfaces: [surface(session)]});
        return {kind: 'ok', stdout: `OK ${ref}\n`};
      }
      case 'reorder-workspaces':
        return {kind: 'ok', stdout: 'OK\n'};
      case 'close-workspace': {
        for (const window of windows.values()) {
          window.workspaces = window.workspaces.filter(
            (entry) => entry.id !== value(args, '--workspace'),
          );
        }
        return {kind: 'ok', stdout: 'OK\n'};
      }
      case 'tree':
        return {
          kind: 'ok',
          stdout: JSON.stringify({
            windows: [...windows.entries()].map(([id, window]) => ({
              id,
              ref: window.ref,
              workspaces: window.workspaces.map((workspace) => ({
                id: workspace.id,
                panes: [
                  {
                    ref: `pane:${workspace.ref}`,
                    surfaces: workspace.surfaces.map((entry) => ({
                      id: entry.id,
                      ref: entry.ref,
                      title: null,
                      tty: `ttys${entry.ref.slice('surface:'.length)}`,
                      type: 'terminal',
                    })),
                  },
                ],
                ref: workspace.ref,
                title: workspace.ref,
              })),
            })),
          }),
        };
      case 'read-screen': {
        const ref = value(args, '--surface');
        const found = allSurfaces().find((entry) => entry.ref === ref);
        if (found == null) return {kind: 'failed', reason: `no surface ${ref}`};
        const read = reads.get(ref) ?? 0;
        reads.set(ref, read + 1);
        const text = screen(found, read, sent.get(ref) ?? []);
        return text == null
          ? {
              kind: 'failed',
              reason: 'internal_error: Failed to read terminal text',
            }
          : {kind: 'ok', stdout: text};
      }
      case 'send': {
        entriesAtSend.push(
          (newestRecord()?.restore as {entries?: unknown} | undefined)
            ?.entries ?? null,
        );
        if (failSend != null) return {kind: 'failed', reason: failSend};
        const ref = value(args, '--surface');
        // The text is the argument after `--`.
        const text = args[args.indexOf('--') + 1] ?? '';
        sent.set(ref, [...(sent.get(ref) ?? []), text]);
        return {kind: 'ok', stdout: 'OK\n'};
      }
      default:
        return {
          kind: 'failed',
          reason: `the fake does not know ${commandOf(args)}`,
        };
    }
  };
  return {
    calls,
    entriesAtSend,
    reads,
    run: (args) => Promise.resolve(respond(args)),
    sends: () => calls.filter((args) => commandOf(args) === 'send'),
    setScreen: (fn) => {
      screen = fn;
    },
    windows,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function cand(n: number): OpenCandidate {
  return {
    checkout: '/dev/repo-a',
    lastActivityAt: new Date(NOW.getTime() - n * HOUR).toISOString(),
    repo: 'repo-a',
    repoTag: 'A',
    section: 'unsentDraft',
    sessionBeadId: `bead-${n}`,
    sessionId: sid(n),
    sessions: 1,
    title: `session ${n}`,
    tracked: true,
  };
}

const NO_LIVE: LiveSessions = {
  bySessionId: new Map(),
  kind: 'read',
  unplaced: [],
  workspacesBySessionId: new Map(),
};

interface Setup {
  clock: {ms: number};
  deps: Partial<OpenDeps>;
  env: Record<string, string>;
  fake: Fake;
  options: OpenOptions;
  stateDir: string;
}

function setup(
  candidates: OpenCandidate[],
  over: Partial<OpenOptions> = {},
  failSend: string | null = null,
): Setup {
  const stateDir = join(tempDir(), 'state');
  const env = {
    CMUX_SOCKET_PATH: '/tmp/thread-open-restore-test/cmux.sock',
    HOME: '/nonexistent',
    JUSTIN_THREADS_STATE_DIR: stateDir,
  };
  const fake = fakeCmux(stateDir, failSend);
  const clock = {ms: 0};
  const options: OpenOptions = {
    argv: [],
    color: false,
    days: null,
    dryRun: false,
    env,
    forceUnplaced: false,
    include: [],
    includeUntracked: false,
    json: false,
    now: NOW,
    perProject: false,
    run: null,
    style: PLAIN_STYLE,
    undo: false,
    ...over,
  };
  const deps: Partial<OpenDeps> = {
    checkoutExists: () => true,
    configSince: () => ({problems: [], since: '7d', source: 'default'}),
    lateLive: () => Promise.resolve({kind: 'notLive'}),
    pid: 4242,
    readCandidates: () => Promise.resolve({candidates, kind: 'read'}),
    readLive: () => Promise.resolve(NO_LIVE),
    // The real store, in this test's state dir; a fake clock and sleep.
    restore: {
      nowIso: () => new Date(NOW.getTime() + clock.ms).toISOString(),
      nowMs: () => clock.ms,
      sleep: (ms) => {
        clock.ms += ms;
        return Promise.resolve();
      },
    },
    run: fake.run,
  };
  return {clock, deps, env, fake, options, stateDir};
}

/** Store a draft for session n, seen in a pane that is gone now. */
function storeDraft(
  s: Setup,
  n: number,
  text: string,
  surfaceId = 'OLD-SURFACE',
): void {
  const written = writeInputDraft(
    {
      at: '2026-10-19T09:00:00.000Z',
      sessionId: sid(n),
      source: 'scan',
      surfaceId,
      text,
      workspaceId: 'OLD-WORKSPACE',
    },
    s.env,
  );
  expect(written.kind).toBe('written');
}

/** The workspace uuid and surface ref this run opened for session n. */
function paneOf(
  s: Setup,
  n: number,
): {surfaceRef: string; workspaceId: string} {
  for (const window of s.fake.windows.values()) {
    for (const workspace of window.workspaces) {
      const [surface] = workspace.surfaces;
      if (surface?.session === sid(n)) {
        return {surfaceRef: surface.ref, workspaceId: workspace.id};
      }
    }
  }
  throw new Error(`no workspace for ${sid(n)}`);
}

function entries(
  record: OpenRecord | null,
): {kind: string; reason: string | null}[] {
  return (record?.restore.entries ?? []).map((entry) => ({
    kind: entry.kind,
    reason: entry.reason,
  }));
}

const TWO_LINES = 'please finish the restore\n  and tell me what is left';
const ONE_LINE = 'please finish the restore and tell me what is left';

// ---------------------------------------------------------------------------
// The text (pure)
// ---------------------------------------------------------------------------

describe('restorableText: what may be typed', () => {
  test('every whitespace run holding a line break becomes one space; tabs become spaces', () => {
    expect(restorableText(TWO_LINES)).toEqual({
      collapsed: true,
      kind: 'ok',
      text: ONE_LINE,
    });
    expect(restorableText('a\r\n\r\nb\tc')).toEqual({
      collapsed: true,
      kind: 'ok',
      text: 'a b c',
    });
    expect(restorableText('  yes, record it  ')).toEqual({
      collapsed: false,
      kind: 'ok',
      text: 'yes, record it',
    });
  });

  test('an escape sequence cmux reads, any other backslash, a control character and a paste stand-in are refused', () => {
    expect(restorableText('first\\nsecond')).toEqual({
      kind: 'refused',
      reason: ESCAPE_REASON,
    });
    expect(restorableText('a tab\\there')).toEqual({
      kind: 'refused',
      reason: ESCAPE_REASON,
    });
    expect(restorableText('C:\\Users\\jhaa')).toEqual({
      kind: 'refused',
      reason: BACKSLASH_REASON,
    });
    expect(restorableText('see [Pasted text #1 +4 lines] above')).toEqual({
      kind: 'refused',
      reason: PASTE_REASON,
    });
    const control = restorableText(`stop${String.fromCharCode(3)}here`);
    expect(control.kind).toBe('refused');
    expect(control.kind === 'refused' ? control.reason : '').toContain(
      'U+0003',
    );
    expect(restorableText('\n  \n').kind).toBe('refused');
  });

  test('sendArgs names the workspace and the surface and puts the text after --, with nothing after it', () => {
    expect(sendArgs('WS', 'surface:9', '-n looks like a flag')).toEqual([
      'send',
      '--workspace',
      'WS',
      '--surface',
      'surface:9',
      '--',
      '-n looks like a flag',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A real run (fake cmux)
// ---------------------------------------------------------------------------

describe('thread open restores a stored draft, never pressing Enter', () => {
  test('the collapsed text is sent once, with the exact argv and no Enter, then seen in the box and recorded', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    const result = await openSessions(s.options, s.deps);
    const pane = paneOf(s, 1);
    // THE argv: workspace and surface named, the text after --, newlines collapsed.
    expect(s.fake.sends()).toEqual([
      [
        'send',
        '--workspace',
        pane.workspaceId,
        '--surface',
        pane.surfaceRef,
        '--',
        ONE_LINE,
      ],
    ]);
    // Nothing that presses Enter: no send-key, no newline, no \n or \r anywhere.
    expect(s.fake.calls.some((args) => commandOf(args) === 'send-key')).toBe(
      false,
    );
    for (const arg of s.fake.calls.flat()) {
      expect(arg.includes('\n') || arg.includes('\r')).toBe(false);
      expect(/\\[nrt]/u.test(arg)).toBe(false);
    }
    // D-RECORD: the entry was on disk, as 'sending', when the send ran.
    expect(s.fake.entriesAtSend).toEqual([
      [expect.objectContaining({kind: 'sending', sessionId: sid(1)})],
    ]);
    expect(result.exitCode).toBe(0);
    expect(entries(result.record)).toEqual([{kind: 'restored', reason: null}]);
    // The draft file: marked, its text and clearedAt untouched.
    const read = readInputDraft(sid(1), s.env);
    expect(read.kind).toBe('present');
    if (read.kind !== 'present') return;
    const surfaceId = [...s.fake.windows.values()]
      .flatMap((window) => window.workspaces)
      .find((workspace) => workspace.id === pane.workspaceId)?.surfaces[0]?.id;
    expect(read.draft).toMatchObject({
      clearedAt: null,
      restoredSurfaceId: surfaceId,
      restoredText: ONE_LINE,
      text: TWO_LINES,
    });
    expect(read.draft.restoredAt).not.toBeNull();
    // The output.
    expect(result.output).toContain('✍️ Restored drafts (1)');
    expect(result.output).toContain('please finish the restore');
    expect(result.output).toContain('on one line');
    expect(result.output).toContain('NOT sent');
    expect(result.output).toContain(pane.workspaceId);
    expect(result.output).not.toContain('Draft not restored');
  });

  test('it waits while Claude starts: a shell, then a blank screen, then the empty box', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, 'yes, record it on the epic');
    s.fake.setScreen((surface, read, sent) => {
      if (surface.session == null) return ZSH;
      if (sent.length > 0) return typed(surface.session, sent.join(''));
      if (read < 3) return ZSH;
      if (read < 6) return '';
      return idle(surface.session);
    });
    const result = await openSessions(s.options, s.deps);
    expect(entries(result.record)).toEqual([{kind: 'restored', reason: null}]);
    expect(s.fake.sends()).toHaveLength(1);
    expect(s.clock.ms).toBeLessThan(RESTORE_READY_TIMEOUT_MS);
  });

  test('a box that already holds text is never written', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen((surface) =>
      surface.session == null ? ZSH : typed(surface.session, 'something new'),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('boxHasText');
    expect(entry?.reason).toContain('already holds text ("something new")');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('⚠️ Draft not restored (1)');
    // The text in full, every line.
    expect(result.output).toContain('please finish the restore');
    expect(result.output).toContain('  and tell me what is left');
    const read = readInputDraft(sid(1), s.env);
    expect(
      read.kind === 'present' ? read.draft.restoredAt : 'absent',
    ).toBeNull();
  });

  test('the readiness timeout: "the box never appeared", after 30 s of reads every 500 ms, and nothing sent', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen(() => ZSH);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('noBox');
    expect(entry?.reason).toContain('the box never appeared');
    expect(s.clock.ms).toBe(RESTORE_READY_TIMEOUT_MS);
    // A read at 0, 500, …, 30000 ms.
    expect(s.fake.reads.get(paneOf(s, 1).surfaceRef)).toBe(61);
    expect(result.output).toContain('not restored: the box never appeared');
    expect(result.exitCode).toBe(0);
  });

  test('a screen that cannot be read is its own outcome, not "no box", and nothing is sent', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen(() => null);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('screenUnreadable');
    expect(entry?.reason).toContain('the screen could not be read');
    expect(result.exitCode).toBe(1);
  });

  test('a box that does not show the text after the send is "⚠️ not restored", with no second send', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    // The box stays empty whatever is sent.
    s.fake.setScreen((surface) =>
      surface.session == null ? ZSH : idle(surface.session),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toHaveLength(1);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('mismatch');
    expect(entry?.reason).toContain('does not show it: the box is empty');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('⚠️ Draft not restored (1)');
    const read = readInputDraft(sid(1), s.env);
    expect(
      read.kind === 'present' ? read.draft.restoredAt : 'absent',
    ).toBeNull();
  });

  test('a screen unreadable after the send is a third outcome, not a mismatch, with no second send', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen((surface, _read, sent) =>
      surface.session == null
        ? ZSH
        : sent.length > 0
          ? null
          : idle(surface.session),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toHaveLength(1);
    expect(entries(result.record).map((entry) => entry.kind)).toEqual([
      'unreadableAfter',
    ]);
    expect(result.exitCode).toBe(1);
  });

  test('a failed send is reported once and not retried', async () => {
    const s = setup([cand(1)], {}, 'socket closed');
    storeDraft(s, 1, TWO_LINES);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toHaveLength(1);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('sendFailed');
    expect(entry?.reason).toContain('socket closed');
    expect(result.exitCode).toBe(1);
  });

  test('a pane showing another session is never written', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen((surface) =>
      surface.session == null ? ZSH : idle(sid(9)),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(entries(result.record).map((entry) => entry.kind)).toEqual([
      'otherSession',
    ]);
  });

  test('vim NORMAL mode is never typed into', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen((surface) =>
      surface.session == null ? ZSH : vimNormal(surface.session),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(entries(result.record).map((entry) => entry.kind)).toEqual([
      'vimNormal',
    ]);
  });

  test('Claude still working after 30 s: not ready, nothing sent', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.fake.setScreen((surface) =>
      surface.session == null ? ZSH : working(surface.session),
    );
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    const [entry] = entries(result.record);
    expect(entry?.kind).toBe('notReady');
    expect(entry?.reason).toContain('Claude was still working');
  });

  test('a draft whose original pane is still in the live tree is not typed; the output names the command that selects it', async () => {
    const s = setup([cand(1)]);
    // The draft's original pane, still open in another window.
    s.fake.windows.set('A0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA', {
      ref: 'window:1',
      workspaces: [
        {
          id: 'F0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          ref: 'workspace:1',
          surfaces: [
            {
              id: 'F0000002-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
              ref: 'surface:1',
              session: null,
            },
          ],
        },
      ],
    });
    storeDraft(s, 1, TWO_LINES, 'F0000002-AAAA-4AAA-8AAA-AAAAAAAAAAAA');
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    // The new pane was never read: nothing was going to be typed there.
    expect(s.fake.reads.get(paneOf(s, 1).surfaceRef)).toBeUndefined();
    expect(entries(result.record).map((entry) => entry.kind)).toEqual([
      'stillOpen',
    ]);
    const [entry] = result.record?.restore.entries ?? [];
    expect(entry?.focusCommand).toBe(
      'cmux select-workspace --workspace F0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    );
    expect(entry?.reason).toBe(
      'your unsent text may still be in its original pane (surface:1), which is still open, so it is not typed a second time: cmux select-workspace --workspace F0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    );
    expect(result.output).toContain(
      '👉 Unsent text whose original pane is still open (1)',
    );
    expect(result.output).toContain('cmux select-workspace --workspace');
    // Not restored, so the text is printed in full.
    expect(result.output).toContain('  and tell me what is left');
    expect(result.exitCode).toBe(0);
  });

  test('a draft with an escape sequence is refused before the pane is read, and printed in full', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, 'run it\\nthen stop');
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(s.fake.reads.size).toBe(0);
    expect(entries(result.record)).toEqual([
      {kind: 'refused', reason: ESCAPE_REASON},
    ]);
    expect(result.output).toContain(
      'contains an escape sequence cmux would interpret',
    );
    expect(result.output).toContain('run it\\nthen stop');
  });

  test('a cleared draft, and a session with none, are left alone and unlisted', async () => {
    const s = setup([cand(1), cand(2)]);
    storeDraft(s, 1, 'sent already');
    const cleared = readInputDraft(sid(1), s.env);
    expect(cleared.kind).toBe('present');
    const {clearInputDraft} = await import('../src/thread/input-drafts');
    clearInputDraft(sid(1), s.env, NOW.toISOString(), 'sent');
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(s.fake.reads.size).toBe(0);
    expect(result.record?.restore.entries).toEqual([]);
    expect(result.output).toContain('✍️ Restored drafts (0)');
    expect(result.output).toContain(
      'No session this run opened had unsent text stored.',
    );
  });

  test('when the record cannot be rewritten before the send, nothing is typed', async () => {
    const s = setup([cand(1)]);
    storeDraft(s, 1, TWO_LINES);
    s.deps.writeRecord = (path, record, first) =>
      record.restore.entries.some((entry) => entry.kind === 'sending')
        ? 'EROFS: read-only file system'
        : writeRecordFile(path, record, first);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(entries(result.record).map((entry) => entry.kind)).toEqual([
      'notTried',
    ]);
    expect(result.exitCode).toBe(1);
  });

  test('--no-restore reads no draft pane and sends nothing', async () => {
    const s = setup([cand(1)], {restore: false});
    storeDraft(s, 1, TWO_LINES);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.sends()).toEqual([]);
    expect(s.fake.calls.some((args) => commandOf(args) === 'read-screen')).toBe(
      false,
    );
    expect(result.record?.restore).toEqual({enabled: false, entries: []});
    expect(result.output).toContain('off (--no-restore)');
    expect(result.output).not.toContain('Restored drafts');
    expect(result.exitCode).toBe(0);
  });
});

describe('--dry-run', () => {
  test('prints "Would restore N drafts" with the first line of each, and types nothing', async () => {
    const s = setup([cand(1), cand(2), cand(3)], {dryRun: true});
    storeDraft(s, 1, TWO_LINES);
    storeDraft(s, 2, 'yes, record it on the epic');
    storeDraft(s, 3, 'C:\\Users\\jhaa is where it is');
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    // Only the tree is read (for the original panes); no screen, no send, no window.
    expect(s.fake.calls.map(commandOf)).toEqual(['ping', 'tree']);
    expect(result.output).toContain('✍️ Would restore 2 drafts');
    expect(result.output).toContain('please finish the restore');
    expect(result.output).toContain('yes, record it on the epic');
    // The first line only, under the would-restore section.
    const section = result.output.slice(
      result.output.indexOf('Would restore 2 drafts'),
      result.output.indexOf('Would not restore'),
    );
    expect(section).not.toContain('and tell me what is left');
    expect(entries(result.record)).toEqual([
      {kind: 'wouldRestore', reason: null},
      {kind: 'wouldRestore', reason: null},
      {kind: 'refused', reason: BACKSLASH_REASON},
    ]);
    expect(result.output).toContain('⚠️ Would not restore (1)');
    expect(result.output).toContain('C:\\Users\\jhaa is where it is');
    // A dry run writes nothing: no record, no draft change.
    expect(existsSync(opensDir(s.env))).toBe(false);
    const read = readInputDraft(sid(1), s.env);
    expect(
      read.kind === 'present' ? read.draft.restoredAt : 'absent',
    ).toBeNull();
  });

  test('with --no-restore it reads no tree and plans nothing', async () => {
    const s = setup([cand(1)], {dryRun: true, restore: false});
    storeDraft(s, 1, TWO_LINES);
    const result = await openSessions(s.options, s.deps);
    expect(s.fake.calls.map(commandOf)).toEqual(['ping']);
    expect(result.output).not.toContain('Would restore');
  });
});

describe('openedTargets: only what the run opened', () => {
  test('a workspace moved in with --include-open is never a target; an unresolved uuid has none', () => {
    const planned = (n: number): OpenRecord['planned'][number] => ({
      checkout: '/dev/repo-a',
      command: `claude --resume ${sid(n)}`,
      lastActivityAt: null,
      name: `[A] session ${n}`,
      repo: 'repo-a',
      repoTag: 'A',
      section: 'needsYou',
      sessionBeadId: null,
      sessionId: sid(n),
      title: `session ${n}`,
    });
    const rec = {
      planned: [planned(1), planned(3)],
      windows: [
        {
          defaultWorkspaceIds: [],
          reordered: true,
          repo: null,
          // sid(2) was moved in: it is in the order, not in workspaces.
          sessionIds: [sid(1), sid(2), sid(3)],
          strayClosed: [],
          windowId: 'W',
          workspaces: [
            {
              sessionId: sid(1),
              workspaceId: 'WS-1',
              workspaceRef: 'workspace:1',
            },
            {sessionId: sid(3), workspaceId: null, workspaceRef: 'workspace:3'},
          ],
        },
      ],
    } as unknown as OpenRecord;
    expect(openedTargets(rec)).toEqual([
      {
        name: '[A] session 1',
        problem: null,
        sessionId: sid(1),
        workspaceId: 'WS-1',
        workspaceRef: 'workspace:1',
      },
      {
        name: '[A] session 3',
        problem: null,
        sessionId: sid(3),
        workspaceId: null,
        workspaceRef: 'workspace:3',
      },
    ]);
  });
});
