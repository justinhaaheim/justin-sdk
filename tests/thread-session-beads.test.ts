/**
 * Status report v4, dispatch 1 (home-base-vzwbj.4.1): the session bead filed
 * in the repo on the first captured prompt, the sessions index, `thread
 * request`, `thread title`, the prompt-time context line, and the shared br
 * adapter they all use.
 *
 * EVERYTHING here runs the REAL `br` binary in throwaway workspaces (`git init`
 * + `br init --prefix t` under $TMPDIR): the behaviours under test — `--db`
 * targeting, `--parent` refusing a foreign id, the absent `labels` key, the
 * JSONL export the prompt hook reads — are br's, and a fake would only test the
 * fake. The ~/Dev/threads half of capture runs against the stateful fake bd, as
 * tests/thread-capture.test.ts does.
 *
 * NO SILENT PASS WITHOUT br (acceptance criterion 7): every test that needs br
 * calls `needBr()`, which THROWS when br is not on PATH, so the suite goes red
 * rather than quietly green.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.1's notes — the line broken,
 * the assertion that went red, and the restore.
 */

import type {SpawnOutcome} from '../src/thread/capture';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {
  brChildren,
  brClose,
  brCreate,
  brList,
  brShow,
  brSpawnEnv,
  brUpdate,
  describeBrFailed,
  EXPORT_AND_DB_BOTH_AHEAD_REASON,
  findBeadsDb,
  findBeadsWorkspace,
  parseBrIssues,
  runBr,
} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {
  captureRunLogPath,
  messageLogPath,
  sessionIndexPath,
} from '../src/thread/archive';
import {
  runThreadCaptureApply,
  runThreadCaptureHook,
} from '../src/thread/capture';
import {serializeMessageLine} from '../src/thread/message-log';
import {
  fileRequest,
  renameSession,
  runThreadRequest,
} from '../src/thread/request';
import {
  cutOnWord,
  ensureSessionBead,
  resolveSession,
  sessionTitleFrom,
} from '../src/thread/session-bead';
import {
  appendSessionSighting,
  readSessionIndex,
  readSessionSightings,
} from '../src/thread/session-index';
import {
  composeSessionLine,
  REQUEST_HINT,
  sessionContextLine,
} from '../src/thread/session-line';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {createFakeBd} from './fake-bd';
import {git, initRepo} from './git-fixtures';
import {needBr, PINNED_BR, pinnedBrVersion} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';
const OTHER_SESSION = '0babe000-1111-4222-8333-444455556666';

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function sandbox(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

/** A committed git repo with a br workspace (`br init --prefix <prefix>`). */
function beadsRepo(sb: Sandbox, name: string, prefix = 't'): string {
  const root = initRepo(sb, name, {'README.md': `# ${name}\n`});
  const init = runBr(root, ['init', '--prefix', prefix, '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  return root;
}

interface World {
  env: Record<string, string | undefined>;
  sb: Sandbox;
  stateDir: string;
}

/** An isolated state dir and user config carrying the thread knobs. */
function world(knobs: Record<string, unknown>): World {
  const sb = sandbox();
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: knobs}}),
  );
  const stateDir = join(sb.path, 'state');
  return {
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: SESSION,
      // No cmux unless a test sets it: the suite may itself run inside cmux.
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: stateDir,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
      XDG_CONFIG_HOME: xdg,
    },
    sb,
    stateDir,
  };
}

const ON = {enabled: true, sessionBeads: true};

function sessionBeads(root: string, sessionId = SESSION) {
  const listed = brList(
    {cwd: root},
    {all: true, labels: [`sid:${sessionId}`], types: ['session']},
  );
  if (listed.kind !== 'ok') throw new Error(`br list failed: ${listed.reason}`);
  return listed.issues;
}

function indexLines(w: World): string[] {
  const path = sessionIndexPath(w.env);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** File the session bead the way the capture child does. */
function fileSessionBead(
  w: World,
  cwd: string,
  firstPromptText = 'Build the thing',
) {
  return ensureSessionBead({
    cwd,
    env: w.env,
    firstPrompt: {at: '2026-10-11T09:00:00.000Z', text: firstPromptText},
    now: new Date('2026-10-11T09:00:01.000Z'),
    sessionId: SESSION,
  });
}

function rawShow(root: string, id: string): Record<string, unknown> {
  const out = runBr(root, ['show', id, '--json']);
  if (!out.ok) throw new Error(`br show failed: ${out.reason ?? '?'}`);
  const parsed = JSON.parse(out.stdout) as Record<string, unknown>[];
  const [record] = parsed;
  if (record == null) throw new Error('no record');
  return record;
}

function captureStdout(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  spies.push(spy);
  return lines;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.join(' '));
    },
  );
  spies.push(spy);
  return lines;
}

// F11 (home-base-vzwbj.4.9, bead .4.11): every real-br test runs the br
// home-base pins, even from a $TMPDIR cwd where mise would pick its global br.
test('F11: the br the adapter spawns from a temp-workspace cwd is the version mise.toml pins', () => {
  needBr();
  const pin = pinnedBrVersion();
  if (!pin.ok) throw new Error(pin.reason);
  expect(PINNED_BR).toMatchObject({kind: 'pinned', version: pin.version});
  const sb = sandbox();
  const said = runBr(sb.path, ['--version']);
  expect(said.ok).toBe(true);
  expect(said.stdout.trim()).toBe(`br ${pin.version}`);
});

// P2 (home-base-vzwbj.4.9): the target's env is merged over process.env, and
// an undefined value UNSETS the variable. Measured 2026-10-11 on br 0.1.37:
// BEADS_DIR redirects a `{cwd}` call to another workspace (BEADS_DB does not).
describe('P2: br runs with the caller env merged over process.env', () => {
  test('brSpawnEnv: a value overrides, undefined unsets, the rest is process.env', () => {
    const saved = process.env.P2_PROBE;
    process.env.P2_PROBE = 'from-process';
    try {
      const merged = brSpawnEnv({OTHER: 'set', P2_PROBE: undefined});
      expect(merged.P2_PROBE).toBeUndefined();
      expect(merged.OTHER).toBe('set');
      expect(merged.PATH).toBe(process.env.PATH);
      expect(brSpawnEnv({P2_PROBE: 'over'}).P2_PROBE).toBe('over');
      expect(brSpawnEnv(undefined).P2_PROBE).toBe('from-process');
    } finally {
      if (saved === undefined) delete process.env.P2_PROBE;
      else process.env.P2_PROBE = saved;
    }
  });

  test('a BEADS_DIR exported in the shell redirects a {cwd} call; the target env unsets it', () => {
    needBr();
    const sb = sandbox();
    const a = beadsRepo(sb, 'env-a', 'aa');
    const b = beadsRepo(sb, 'env-b', 'bb');
    const inA = brCreate({cwd: a}, {title: 'Lives in A', type: 'task'});
    const inB = brCreate({cwd: b}, {title: 'Lives in B', type: 'task'});
    if (inA.kind !== 'ok' || inB.kind !== 'ok') throw new Error('create');
    const saved = process.env.BEADS_DIR;
    process.env.BEADS_DIR = join(a, '.beads');
    try {
      const ids = (out: ReturnType<typeof brList>): string[] =>
        out.kind === 'ok' ? out.issues.map((issue) => issue.id) : [out.reason];
      // The hazard: Justin's shell variable wins over the cwd.
      expect(ids(brList({cwd: b}, {all: true}))).toEqual([inA.id]);
      // The fix: the caller's env says "not set", and br finds b's DB.
      expect(
        ids(brList({cwd: b, env: {BEADS_DIR: undefined}}, {all: true})),
      ).toEqual([inB.id]);
      // runBr takes the same env.
      const listed = runBr(b, ['list', '--json', '--all'], {
        BEADS_DIR: undefined,
      });
      expect(listed.stdout).toContain(inB.id);
      expect(listed.stdout).not.toContain(inA.id);
    } finally {
      if (saved === undefined) delete process.env.BEADS_DIR;
      else process.env.BEADS_DIR = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// The br adapter
// ---------------------------------------------------------------------------

describe('br adapter (src/beads/br.ts)', () => {
  test('findBeadsWorkspace: found / none (no .beads) / none (not git) / failed', () => {
    needBr();
    const sb = sandbox();
    const repo = beadsRepo(sb, 'with-beads');
    const plain = initRepo(sb, 'no-beads', {'a.txt': 'a\n'});
    const loose = join(sb.path, 'loose');
    mkdirSync(loose);

    const found = findBeadsWorkspace(repo);
    expect(found).toMatchObject({
      beadsDir: join(repo, '.beads'),
      db: join(repo, '.beads', 'beads.db'),
      kind: 'found',
      root: repo,
    });
    expect(findBeadsWorkspace(plain).kind).toBe('none');
    const notGit = findBeadsWorkspace(loose);
    expect(notGit.kind).toBe('none');
    if (notGit.kind === 'none')
      expect(notGit.reason).toContain('not inside a git');
    expect(findBeadsWorkspace(join(sb.path, 'vanished')).kind).toBe('failed');
  });

  test('create / list / show / update / close, with labels ABSENT read as []', () => {
    needBr();
    const sb = sandbox();
    const repo = beadsRepo(sb, 'adapter');
    const bare = brCreate({cwd: repo}, {title: 'No labels', type: 'task'});
    expect(bare.kind).toBe('ok');
    if (bare.kind !== 'ok') return;
    const labelled = brCreate(
      {cwd: repo},
      {
        labels: ['a', 'b:c'],
        priority: 1,
        status: 'in_progress',
        title: 'Labelled',
        type: 'question',
      },
    );
    if (labelled.kind !== 'ok') throw new Error(labelled.reason);

    const listed = brList({cwd: repo}, {all: true});
    if (listed.kind !== 'ok') throw new Error(listed.reason);
    const byId = new Map(listed.issues.map((issue) => [issue.id, issue]));
    expect(byId.get(bare.id)?.labels).toEqual([]);
    expect(byId.get(labelled.id)).toMatchObject({
      issueType: 'question',
      labels: ['a', 'b:c'],
      priority: 1,
      status: 'in_progress',
    });

    expect(brShow({cwd: repo}, 'zz-nope').kind).toBe('notFound');
    expect(
      brUpdate({cwd: repo}, bare.id, {addLabels: ['x'], title: 'Renamed'}).kind,
    ).toBe('ok');
    const shown = brShow({cwd: repo}, bare.id);
    expect(shown).toMatchObject({
      issue: {labels: ['x'], title: 'Renamed'},
      kind: 'ok',
    });
    expect(brClose({cwd: repo}, bare.id, 'done').kind).toBe('ok');
    expect(brList({cwd: repo}, {all: false})).toMatchObject({kind: 'ok'});
    const open = brList({cwd: repo}, {all: false});
    if (open.kind !== 'ok') throw new Error(open.reason);
    expect(open.issues.map((issue) => issue.id)).toEqual([labelled.id]);
  });

  test('a FAILED br call is a failure, never an empty answer', () => {
    needBr();
    const sb = sandbox();
    const repo = beadsRepo(sb, 'failing');
    // A parent that is not in this DB: br refuses (verified 2026-10-11).
    const orphan = brCreate(
      {cwd: repo},
      {parent: 't-nothere', title: 'x', type: 'task'},
    );
    expect(orphan.kind).toBe('failed');
    if (orphan.kind === 'failed') expect(orphan.reason).toMatch(/not found/i);
    // A --db that does not exist: refused by name, not as "br is missing".
    const gone = brList(
      {db: join(sb.path, 'gone', '.beads', 'beads.db')},
      {all: true},
    );
    expect(gone.kind).toBe('failed');
    if (gone.kind === 'failed')
      expect(gone.reason).toContain('beads database not found');
  });

  test('--db writes to ANOTHER checkout from any cwd', () => {
    needBr();
    const sb = sandbox();
    const a = beadsRepo(sb, 'a', 'aa');
    const b = beadsRepo(sb, 'b', 'bb');
    const made = brCreate(
      {db: join(a, '.beads', 'beads.db')},
      {title: 'into a', type: 'task'},
    );
    if (made.kind !== 'ok') throw new Error(made.reason);
    expect(made.id.startsWith('aa-')).toBe(true);
    const inB = brList({cwd: b}, {all: true});
    expect(inB).toMatchObject({issues: [], kind: 'ok'});
  });

  // F3 (home-base-vzwbj.4.9): every exported br helper has a test of its own.
  test('brChildren: a parent-child dependent list, notFound for a missing id', () => {
    needBr();
    const sb = sandbox();
    const repo = beadsRepo(sb, 'children');
    const parent = brCreate({cwd: repo}, {title: 'Parent', type: 'epic'});
    if (parent.kind !== 'ok') throw new Error(parent.reason);
    const kid = brCreate(
      {cwd: repo},
      {parent: parent.id, title: 'Kid', type: 'task'},
    );
    const done = brCreate(
      {cwd: repo},
      {parent: parent.id, title: 'Done kid', type: 'task'},
    );
    if (kid.kind !== 'ok' || done.kind !== 'ok') throw new Error('create');
    expect(brClose({cwd: repo}, done.id, 'finished').kind).toBe('ok');
    const children = brChildren({cwd: repo}, parent.id);
    if (children.kind !== 'ok') throw new Error(children.kind);
    expect(
      children.children
        .map((child) => `${child.id}:${child.status}:${child.title}`)
        .sort(),
    ).toEqual([`${done.id}:closed:Done kid`, `${kid.id}:open:Kid`].sort());
    expect(brChildren({cwd: repo}, kid.id)).toEqual({children: [], kind: 'ok'});
    expect(brChildren({cwd: repo}, 't-nothere')).toEqual({
      id: 't-nothere',
      kind: 'notFound',
    });
  });

  test('findBeadsDb: found / none (no db file) / failed (no directory)', () => {
    needBr();
    const sb = sandbox();
    const repo = beadsRepo(sb, 'dbfind');
    expect(findBeadsDb(join(repo, '.beads'))).toEqual({
      db: join(repo, '.beads', 'beads.db'),
      kind: 'found',
    });
    const empty = join(sb.path, 'empty-beads');
    mkdirSync(empty);
    expect(findBeadsDb(empty).kind).toBe('none');
    expect(findBeadsDb(join(sb.path, 'no-such-dir')).kind).not.toBe('found');
  });

  test('parseBrIssues: labels absent read as [], a record with no id is refused; describeBrFailed joins the detail', () => {
    const parsed = parseBrIssues([
      {id: 'x-1', issue_type: 'task', priority: 2, status: 'open', title: 'A'},
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.issues[0]?.labels).toEqual([]);
    expect(parseBrIssues([{title: 'no id'}]).ok).toBe(false);
    expect(
      describeBrFailed({
        command: 'br x',
        detail: ['second', 'third'],
        kind: 'failed',
        reason: 'first',
      }),
    ).toBe('first\n  second\n  third');
  });
});

// ---------------------------------------------------------------------------
// P1 (home-base-vzwbj.4.9): no write while the export is ahead of the DB
// ---------------------------------------------------------------------------

/**
 * What `git pull` does to a checkout: issues.jsonl changes under the DB. The
 * bead's title and updated_at are rewritten in the export only (the shape
 * scripts/measure-br-export-clobber.ts measured br 0.1.37 clobbering).
 */
function simulatePull(root: string, id: string, title: string): void {
  const path = join(root, '.beads', 'issues.jsonl');
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record.id === id
        ? JSON.stringify({
            ...record,
            title,
            updated_at: new Date().toISOString(),
          })
        : line;
    });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function requestOptions(
  w: World,
  cwd: string,
  extra: Partial<Parameters<typeof fileRequest>[0]>,
) {
  return {
    bead: null,
    cwd,
    doneWhen: null,
    env: w.env,
    here: false,
    sessionId: null,
    title: null,
    ...extra,
  };
}

function syncStatus(root: string): Record<string, unknown> {
  const status = runBr(root, ['sync', '--status', '--json']);
  if (!status.ok) throw new Error(`br sync --status: ${status.reason ?? '?'}`);
  return JSON.parse(status.stdout) as Record<string, unknown>;
}

/**
 * A REAL merge that moves issues.jsonl past the DB (home-base-j8q3e.1.10 F3,
 * the state the conductor hit after each of four merges into main on
 * 2026-10-15): a side branch commits an edited export (as another checkout's
 * br would), main merges it. The DB never saw the edit.
 */
function mergeEditedExport(root: string, id: string, title: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'beads before the side branch']);
  git(root, ['checkout', '-qb', 'side']);
  simulatePull(root, id, title);
  git(root, ['commit', '-qam', 'edit the export on the side branch']);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
}

describe('P1 + F3: a br write after a pull imports the export first, and never clobbers it', () => {
  test('after a real merge, update, create and close go through; the merged edit survives in the DB and the export', () => {
    needBr();
    const sb = sandbox();
    const root = beadsRepo(sb, 'pulled');
    const filed = brCreate(
      {cwd: root},
      {title: 'Original title', type: 'task'},
    );
    if (filed.kind !== 'ok') throw new Error(filed.reason);
    mergeEditedExport(root, filed.id, 'EDITED BY PULL');
    // The state that used to refuse every v4 write (home-base-vzwbj.4.14).
    expect(syncStatus(root)).toMatchObject({
      db_newer: false,
      jsonl_newer: true,
    });
    const head = git(root, ['rev-parse', 'HEAD']);

    const updated = brUpdate({cwd: root}, filed.id, {
      addLabels: ['after-pull'],
    });
    expect(updated).toEqual({kind: 'ok'});
    const created = brCreate({cwd: root}, {title: 'New', type: 'task'});
    expect(created.kind).toBe('ok');
    const closed = brClose({cwd: root}, filed.id, 'done');
    expect(closed).toEqual({kind: 'ok'});

    const exported = readFileSync(join(root, '.beads', 'issues.jsonl'), 'utf8');
    expect(exported).toContain('EDITED BY PULL');
    expect(exported).toContain('after-pull');
    expect(exported).not.toContain('Original title');
    expect(brShow({cwd: root}, filed.id)).toMatchObject({
      issue: {status: 'closed', title: 'EDITED BY PULL'},
      kind: 'ok',
    });
    expect(syncStatus(root)).toMatchObject({jsonl_newer: false});
    // The import ran no git: HEAD did not move.
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
  });

  test('a {db} target imports too', () => {
    needBr();
    const sb = sandbox();
    const root = beadsRepo(sb, 'pulled-db');
    const filed = brCreate({cwd: root}, {title: 'Original', type: 'task'});
    if (filed.kind !== 'ok') throw new Error(filed.reason);
    simulatePull(root, filed.id, 'EDITED BY PULL');
    const db = findBeadsWorkspace(root);
    if (db.kind !== 'found') throw new Error(db.kind);
    expect(
      brUpdate({db: db.db}, filed.id, {addLabels: ['after-pull']}),
    ).toEqual({kind: 'ok'});
    expect(brShow({db: db.db}, filed.id)).toMatchObject({
      issue: {labels: ['after-pull'], title: 'EDITED BY PULL'},
      kind: 'ok',
    });
  });

  test('when the DB ALSO holds an unexported edit, nothing is imported or written, and the words say why', () => {
    needBr();
    const sb = sandbox();
    const root = beadsRepo(sb, 'both-ahead');
    const filed = brCreate({cwd: root}, {title: 'Original', type: 'task'});
    if (filed.kind !== 'ok') throw new Error(filed.reason);
    // An edit the DB holds but never exported.
    expect(
      runBr(root, [
        'update',
        filed.id,
        '--title=EDITED IN THE DB',
        '--no-auto-flush',
      ]).ok,
    ).toBe(true);
    simulatePull(root, filed.id, 'EDITED BY PULL');
    expect(syncStatus(root)).toMatchObject({
      db_newer: true,
      jsonl_newer: true,
    });

    const updated = brUpdate({cwd: root}, filed.id, {addLabels: ['x']});
    expect(updated).toMatchObject({
      kind: 'failed',
      reason: EXPORT_AND_DB_BOTH_AHEAD_REASON,
    });
    const exported = readFileSync(join(root, '.beads', 'issues.jsonl'), 'utf8');
    expect(exported).toContain('EDITED BY PULL');
    expect(exported).not.toContain('"x"');
    expect(syncStatus(root)).toMatchObject({jsonl_newer: true});
  });

  test('an export br cannot import (merge conflict markers) is a refusal that names the import failure', () => {
    needBr();
    const sb = sandbox();
    const root = beadsRepo(sb, 'conflicted');
    const filed = brCreate({cwd: root}, {title: 'Original', type: 'task'});
    if (filed.kind !== 'ok') throw new Error(filed.reason);
    const path = join(root, '.beads', 'issues.jsonl');
    const line = readFileSync(path, 'utf8').trim();
    const conflicted = `<<<<<<< HEAD\n${line}\n=======\n${line.replace('Original', 'Theirs')}\n>>>>>>> side\n`;
    writeFileSync(path, conflicted);

    const created = brCreate({cwd: root}, {title: 'New', type: 'task'});
    expect(created.kind).toBe('failed');
    if (created.kind === 'failed') {
      expect(created.reason).toContain(
        'issues.jsonl is newer than the beads DB and importing it failed, so nothing was written',
      );
      expect(created.reason).toContain('br sync --import-only');
    }
    expect(readFileSync(path, 'utf8')).toBe(conflicted);
  });

  test('a freshly initialised workspace (br says jsonl_newer, the export is empty) is writable', () => {
    needBr();
    const sb = sandbox();
    const root = beadsRepo(sb, 'fresh');
    const status = runBr(root, ['sync', '--status', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({jsonl_newer: true});
    expect(readFileSync(join(root, '.beads', 'issues.jsonl'), 'utf8')).toBe('');
    expect(brCreate({cwd: root}, {title: 'First', type: 'task'}).kind).toBe(
      'ok',
    );
  });

  test('after a merge, the capture child files the session bead on the first prompt, over the merged export', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'pulled-capture');
    const other = brCreate({cwd: repo}, {title: 'Some work', type: 'task'});
    if (other.kind !== 'ok') throw new Error(other.reason);
    mergeEditedExport(repo, other.id, 'Changed on another machine');
    const outcome = fileSessionBead(w, repo);
    expect(outcome.kind).toBe('created');
    expect(sessionBeads(repo)).toHaveLength(1);
    expect(
      readFileSync(join(repo, '.beads', 'issues.jsonl'), 'utf8'),
    ).toContain('Changed on another machine');
  });

  test('after a merge, thread request files the request on turn 1', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'pulled-request');
    const session = fileSessionBead(w, repo);
    if (session.kind !== 'created') throw new Error(session.kind);
    const other = brCreate({cwd: repo}, {title: 'Some work', type: 'task'});
    if (other.kind !== 'ok') throw new Error(other.reason);
    mergeEditedExport(repo, other.id, 'Changed on another machine');
    const filed = await fileRequest(
      requestOptions(w, repo, {title: 'Fix the login bug'}),
    );
    expect(filed).toMatchObject({kind: 'filed'});
    const exported = readFileSync(join(repo, '.beads', 'issues.jsonl'), 'utf8');
    expect(exported).toContain('Fix the login bug');
    expect(exported).toContain('Changed on another machine');
  });
});

// ---------------------------------------------------------------------------
// The sessions index
// ---------------------------------------------------------------------------

describe('sessions index', () => {
  test('groups by session, newest first, and REPORTS a corrupt line', () => {
    const w = world(ON);
    const base = {
      beadsDir: '/r/.beads',
      branch: 'main',
      checkoutPath: '/r',
      repo: 'r',
    };
    appendSessionSighting(
      {
        ...base,
        at: '2026-10-11T01:00:00.000Z',
        beadId: 't-1',
        event: 'created',
        sessionId: SESSION,
      },
      w.env,
    );
    appendSessionSighting(
      {
        ...base,
        at: '2026-10-11T03:00:00.000Z',
        beadId: 'o-1',
        event: 'created',
        sessionId: OTHER_SESSION,
      },
      w.env,
    );
    writeFileSync(
      sessionIndexPath(w.env),
      `${readFileSync(sessionIndexPath(w.env), 'utf8')}{not json\n`,
    );
    appendSessionSighting(
      {
        ...base,
        at: '2026-10-11T02:00:00.000Z',
        beadId: 't-9',
        beadsDir: '/s/.beads',
        checkoutPath: '/s',
        event: 'adopted-in',
        sessionId: SESSION,
      },
      w.env,
    );

    const read = readSessionIndex(w.env);
    if (read.kind !== 'read') throw new Error(read.kind);
    expect(read.sessions.map((s) => s.sessionId)).toEqual([
      OTHER_SESSION,
      SESSION,
    ]);
    expect(read.sessions[1]?.sightings.map((s) => s.beadId)).toEqual([
      't-9',
      't-1',
    ]);
    expect(read.corrupt).toHaveLength(1);
    expect(read.corrupt[0]).toMatchObject({lineNumber: 3});

    const one = readSessionSightings(SESSION, w.env);
    if (one.kind !== 'read') throw new Error(one.kind);
    expect(one.sightings.map((s) => s.event)).toEqual([
      'adopted-in',
      'created',
    ]);
  });

  test('no file is `missing`; an unreadable one is `failed`, not empty', () => {
    const w = world(ON);
    expect(readSessionIndex(w.env).kind).toBe('missing');
    mkdirSync(sessionIndexPath(w.env), {recursive: true});
    expect(readSessionIndex(w.env).kind).toBe('failed');
    expect(readSessionSightings(SESSION, w.env).kind).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The session bead
// ---------------------------------------------------------------------------

describe('session bead (ensureSessionBead)', () => {
  test('title: first line, cut at 100 on a word boundary with an ellipsis', () => {
    expect(sessionTitleFrom('\n  Fix the   login bug\nmore detail')).toBe(
      'Fix the login bug',
    );
    const long = `${'word '.repeat(40)}end`;
    const cut = cutOnWord(long);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith('word…')).toBe(true);
    expect(cutOnWord('x'.repeat(150))).toHaveLength(100);
    expect(sessionTitleFrom('   \n  ')).toBeNull();
  });

  test('CREATES exactly one session bead + one index line; a second call creates nothing', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'repo-one');
    const first = fileSessionBead(
      w,
      repo,
      'Make the export faster\nand also other stuff',
    );
    expect(first.kind).toBe('created');
    const beads = sessionBeads(repo);
    expect(beads).toHaveLength(1);
    const [bead] = beads;
    if (bead == null || first.kind !== 'created') throw new Error('no bead');
    expect(bead.id).toBe(first.beadId);
    expect(bead).toMatchObject({
      issueType: 'session',
      priority: 2,
      status: 'in_progress',
      title: 'Make the export faster',
    });
    expect([...bead.labels].sort()).toEqual([
      'auto-title',
      'session',
      `sid:${SESSION}`,
    ]);
    expect(bead.description).toBe(
      [
        `Session: ${SESSION}`,
        `Resume: claude --resume ${SESSION}`,
        'Repo: repo-one',
        'Branch: main',
        `Checkout: ${repo}`,
        'Started: 2026-10-11T09:00:00.000Z',
      ].join('\n'),
    );
    expect(indexLines(w)).toHaveLength(1);
    expect(JSON.parse(indexLines(w)[0] ?? '{}')).toMatchObject({
      beadId: bead.id,
      beadsDir: join(repo, '.beads'),
      branch: 'main',
      checkoutPath: repo,
      event: 'created',
      repo: 'repo-one',
      sessionId: SESSION,
    });

    const second = fileSessionBead(w, repo, 'a later prompt');
    expect(second).toMatchObject({beadId: bead.id, kind: 'exists'});
    expect(sessionBeads(repo)).toHaveLength(1);
    expect(indexLines(w)).toHaveLength(1);
  });

  test('cmux ids become labels when the env carries them', () => {
    needBr();
    const w = world(ON);
    w.env.CMUX_SURFACE_ID = '7F7A0362-C632-442C-86CF-A02C62441183';
    w.env.CMUX_WORKSPACE_ID = '3B01219B-CA43-4D96-8CD2-C499EEE9E35B';
    const repo = beadsRepo(w.sb, 'cmux-repo');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const [bead] = sessionBeads(repo);
    // `cmux-ws:`, not the bead's `cmux-workspace:` — br caps labels at 50
    // characters and `cmux-workspace:` + a UUID is 51 (deviation, in notes).
    expect([...(bead?.labels ?? [])].sort()).toEqual([
      'auto-title',
      'cmux-surface:7F7A0362-C632-442C-86CF-A02C62441183',
      'cmux-ws:3B01219B-CA43-4D96-8CD2-C499EEE9E35B',
      'session',
      `sid:${SESSION}`,
    ]);
  });

  test('a cmux id br would refuse is LEFT OFF and named, never fatal', () => {
    needBr();
    const w = world(ON);
    w.env.CMUX_SURFACE_ID = 'A'.repeat(40);
    w.env.CMUX_WORKSPACE_ID = 'has,comma';
    const repo = beadsRepo(w.sb, 'cmux-long');
    const made = fileSessionBead(w, repo);
    expect(made.kind).toBe('created');
    expect(made.detail).toContain('label left off: cmux-surface:');
    expect(made.detail).toContain('CMUX_WORKSPACE_ID is not a plain token');
    const [bead] = sessionBeads(repo);
    expect([...(bead?.labels ?? [])].sort()).toEqual([
      'auto-title',
      'session',
      `sid:${SESSION}`,
    ]);
  });

  test('a session that MOVED to another checkout keeps its one bead', () => {
    needBr();
    const w = world(ON);
    const main = beadsRepo(w.sb, 'main-co', 'mm');
    const other = beadsRepo(w.sb, 'other-co', 'oo');
    expect(fileSessionBead(w, main).kind).toBe('created');
    expect(fileSessionBead(w, other).kind).toBe('exists');
    expect(sessionBeads(other)).toHaveLength(0);
  });

  test('a bead the index lost is FOUND in the DB and the index repaired', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'repair');
    const made = fileSessionBead(w, repo);
    if (made.kind !== 'created') throw new Error(made.kind);
    rmSync(sessionIndexPath(w.env));
    const again = fileSessionBead(w, repo);
    expect(again).toMatchObject({beadId: made.beadId, kind: 'exists'});
    expect(sessionBeads(repo)).toHaveLength(1);
    expect(indexLines(w)).toHaveLength(1);
  });

  test('no beads workspace → noWorkspace, nothing written', () => {
    needBr();
    const w = world(ON);
    const plain = initRepo(w.sb, 'plain', {'a.txt': 'a\n'});
    expect(fileSessionBead(w, plain).kind).toBe('noWorkspace');
    expect(existsSync(sessionIndexPath(w.env))).toBe(false);
  });

  test('an UNREADABLE index fails closed: no bead is filed on a guess', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'unreadable-index');
    mkdirSync(sessionIndexPath(w.env), {recursive: true});
    expect(fileSessionBead(w, repo).kind).toBe('failed');
    expect(sessionBeads(repo)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capture: the hook and the detached child, end to end (AC 1, 3, 4)
// ---------------------------------------------------------------------------

interface CaptureWorld extends World {
  fake: ReturnType<typeof createFakeBd>;
  repo: string;
}

function captureWorld(knobs: Record<string, unknown>): CaptureWorld {
  const w = world(knobs);
  const fake = createFakeBd();
  // fake.env is a copy of process.env: spread it FIRST so this world's
  // isolation (state dir, config, no cmux) wins over the real shell's values.
  w.env = {...fake.env, ...w.env, JUSTIN_THREADS_REPO_DIR: fake.dir};
  return {...w, fake, repo: beadsRepo(w.sb, 'captured')};
}

function prompt(cw: CaptureWorld, text: string, event = 'UserPromptSubmit') {
  return JSON.stringify({
    cwd: cw.repo,
    hook_event_name: event,
    session_id: SESSION,
    transcript_path: join(cw.sb.path, 'no-transcripts', `${SESSION}.jsonl`),
    ...(event === 'UserPromptSubmit'
      ? {prompt: text}
      : {last_assistant_message: text}),
  });
}

function runHook(cw: CaptureWorld, stdin: string) {
  return runThreadCaptureHook({
    env: cw.env,
    spawnApply: (): SpawnOutcome => ({kind: 'spawned', pid: null}),
    stdin,
  });
}

async function runChild(cw: CaptureWorld) {
  await runThreadCaptureApply({
    autoCommit: false,
    cwd: cw.repo,
    env: cw.env,
    hookElapsedMs: 1,
    sessionId: SESSION,
  });
}

function runRecords(cw: CaptureWorld): Record<string, unknown>[] {
  return readFileSync(captureRunLogPath(cw.env), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function threadBeads(cw: CaptureWorld) {
  return cw.fake.read().issues.filter((issue) => issue.type === 'thread');
}

describe('capture with sessionBeads ON', () => {
  test('first prompt: ONE session bead, ONE index line, the thread bead as before; second prompt: nothing more', async () => {
    needBr();
    const cw = captureWorld(ON);
    const out = captureStdout();

    const first = runHook(cw, prompt(cw, 'Please speed up the export'));
    expect(first.contextLine).toContain('session bead: not filed yet');
    await runChild(cw);
    expect(sessionBeads(cw.repo)).toHaveLength(1);
    expect(indexLines(cw)).toHaveLength(1);
    expect(threadBeads(cw)).toHaveLength(1);
    expect(runRecords(cw).at(-1)?.sessionBead).toMatchObject({kind: 'created'});

    const second = runHook(cw, prompt(cw, 'and now the import'));
    const [bead] = sessionBeads(cw.repo);
    expect(second.contextLine).toBe(
      `[thread] session ${bead?.id ?? '?'} "Please speed up the export" · requests: none yet · ${REQUEST_HINT}`,
    );
    await runChild(cw);
    expect(sessionBeads(cw.repo)).toHaveLength(1);
    expect(indexLines(cw)).toHaveLength(1);
    expect(threadBeads(cw)).toHaveLength(1);
    expect(runRecords(cw).at(-1)?.sessionBead).toMatchObject({kind: 'exists'});

    // Exactly one stdout line per prompt, each the helper's JSON carrying the
    // context line to Claude and its mirror to Justin.
    expect(out).toHaveLength(2);
    const json = JSON.parse(out[1] ?? '{}') as {
      hookSpecificOutput?: {additionalContext: string; hookEventName: string};
      systemMessage?: string;
    };
    expect(json.hookSpecificOutput).toEqual({
      additionalContext: second.contextLine ?? '',
      hookEventName: 'UserPromptSubmit',
    });
    expect(json.systemMessage).toBe(second.contextLine ?? '');
  });

  // P3 (home-base-vzwbj.4.9): finish() throwing after the emit must not make
  // the catch path print the line a second time.
  test('P3: the context line is printed once even when finish() throws after printing it', () => {
    needBr();
    const cw = captureWorld(ON);
    const out = captureStdout();
    let calls = 0;
    const stderr: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        calls += 1;
        // The first --explain write, right after the emit, throws.
        if (calls === 1) throw new Error('stderr went away');
        stderr.push(args.join(' '));
      },
    );
    spies.push(spy);
    const result = runThreadCaptureHook({
      env: cw.env,
      explain: true,
      spawnApply: (): SpawnOutcome => ({kind: 'spawned', pid: null}),
      stdin: prompt(cw, 'Print me once'),
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.join('\n')).toContain('stderr went away');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('session bead: not filed yet');
  });

  // F2 (home-base-vzwbj.4.9): `--apply` run by hand, with no --cwd.
  test('F2: the REAL CLI `thread capture --apply <sid>` with no --cwd files the bead from the current directory and the record names the default', () => {
    needBr();
    const cw = captureWorld(ON);
    captureStdout();
    runHook(cw, prompt(cw, 'A hand-run capture'));
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const run = Bun.spawnSync(
      [process.execPath, cli, 'thread', 'capture', '--apply', SESSION],
      {cwd: cw.repo, env: {...cw.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'}},
    );
    expect(run.exitCode).toBe(0);
    expect(sessionBeads(cw.repo)).toHaveLength(1);
    const record = runRecords(cw).at(-1) ?? {};
    expect(String(record.cwdDefaulted)).toMatch(
      /^cwd defaulted to \/.*\/captured$/,
    );
    expect(record.sessionBead).toMatchObject({kind: 'created'});
    expect(String((record.sessionBead as {detail?: unknown}).detail)).toContain(
      '(cwd defaulted to ',
    );
  });

  test('the Stop event prints nothing; the line measures its own cost', () => {
    needBr();
    const cw = captureWorld(ON);
    const out = captureStdout();
    const stop = runHook(cw, prompt(cw, 'done', 'Stop'));
    expect(stop.contextLine).toBeNull();
    expect(out).toHaveLength(0);
    const upon = runHook(cw, prompt(cw, 'a prompt'));
    expect(typeof upon.contextLineMs).toBe('number');
  });

  test('a repo with no beads workspace: no line, no session bead', async () => {
    needBr();
    const cw = captureWorld(ON);
    rmSync(join(cw.repo, '.beads'), {force: true, recursive: true});
    const out = captureStdout();
    const result = runHook(cw, prompt(cw, 'hello'));
    expect(result.contextLine).toBeNull();
    expect(out).toHaveLength(0);
    await runChild(cw);
    expect(runRecords(cw).at(-1)?.sessionBead).toMatchObject({
      kind: 'noWorkspace',
    });
    expect(existsSync(sessionIndexPath(cw.env))).toBe(false);
  });
});

describe('capture with sessionBeads OFF (the default)', () => {
  test('no line, no session bead, no index, no sessionBead field — the thread bead as before', async () => {
    needBr();
    const cw = captureWorld({enabled: true});
    const out = captureStdout();
    const result = runHook(cw, prompt(cw, 'Please speed up the export'));
    expect(result.contextLine).toBeNull();
    expect(result.contextLineMs).toBeNull();
    await runChild(cw);
    expect(out).toHaveLength(0);
    expect(sessionBeads(cw.repo)).toHaveLength(0);
    expect(existsSync(sessionIndexPath(cw.env))).toBe(false);
    expect(threadBeads(cw)).toHaveLength(1);
    const record = runRecords(cw).at(-1) ?? {};
    expect('sessionBead' in record).toBe(false);
    expect('contextLineMs' in record).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The context line
// ---------------------------------------------------------------------------

describe('context line', () => {
  test('counts open and done requests from the beads export', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'line-repo');
    expect(fileSessionBead(w, repo, 'First words').kind).toBe('created');
    const filed = await fileRequest({
      bead: null,
      cwd: repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: 'Ship the parser',
    });
    if (filed.kind !== 'filed') throw new Error(filed.kind);
    const [bead] = sessionBeads(repo);
    const line = sessionContextLine({
      cwd: repo,
      env: w.env,
      sessionId: SESSION,
    });
    expect(line).toBe(
      `[thread] session ${bead?.id ?? '?'} "Ship the parser" · requests: 1 open, 0 done · ${REQUEST_HINT}`,
    );
    expect(brClose({cwd: repo}, filed.id, 'done').kind).toBe('ok');
    expect(
      sessionContextLine({cwd: repo, env: w.env, sessionId: SESSION}),
    ).toContain('requests: 0 open, 1 done');
  });

  test('an unreadable export is UNKNOWN, never "none yet"', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'no-export');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    rmSync(join(repo, '.beads', 'issues.jsonl'));
    const line =
      sessionContextLine({cwd: repo, env: w.env, sessionId: SESSION}) ?? '';
    expect(line).toContain('requests: unknown (could not read');
    expect(line).not.toContain('none yet');
  });

  test('dispatch 2 can append parts without rewriting the line', () => {
    expect(
      composeSessionLine({
        beadId: 't-1',
        extras: ['answers: 1 new'],
        kind: 'session',
        requests: {done: 0, kind: 'counted', open: 1},
        title: 'X',
        titleProblem: null,
      }),
    ).toBe(
      `[thread] session t-1 "X" · requests: 1 open, 0 done · answers: 1 new · ${REQUEST_HINT}`,
    );
  });
});

// ---------------------------------------------------------------------------
// thread request and thread title (AC 2)
// ---------------------------------------------------------------------------

describe('thread request', () => {
  test('creates a task UNDER the session bead, renames the session once, prints the id', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'req');
    const session = fileSessionBead(w, repo);
    if (session.kind !== 'created') throw new Error(session.kind);
    const out = captureStdout();

    expect(
      await runThreadRequest(
        requestOptions(w, repo, {
          doneWhen: 'tests pass',
          title: 'Fix the  login\nbug',
        }),
      ),
    ).toBe(0);
    const [line] = out;
    const id = /^request (\S+) · Fix the login bug$/.exec(line ?? '')?.[1];
    if (id == null) throw new Error(`unexpected output: ${out.join('\n')}`);
    expect(id.startsWith(`${session.beadId}.`)).toBe(true);
    const req = rawShow(repo, id);
    expect(req).toMatchObject({
      acceptance_criteria: 'tests pass',
      issue_type: 'task',
      priority: 2,
      status: 'in_progress',
    });
    expect([...((req.labels as string[] | undefined) ?? [])].sort()).toEqual([
      'request',
      `sid:${SESSION}`,
    ]);
    const renamed = brShow({cwd: repo}, session.beadId);
    expect(renamed).toMatchObject({
      issue: {title: 'Fix the login bug'},
      kind: 'ok',
    });
    if (renamed.kind === 'ok')
      expect(renamed.issue.labels).not.toContain('auto-title');

    // The SECOND request does not rename.
    const second = await fileRequest(
      requestOptions(w, repo, {title: 'Also the logout bug'}),
    );
    expect(second).toMatchObject({kind: 'filed', renamedSession: null});
    expect(brShow({cwd: repo}, session.beadId)).toMatchObject({
      issue: {title: 'Fix the login bug'},
    });
  });

  test('a title starting with a dash is filed as text, not read as a br flag', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'dash');
    const session = fileSessionBead(w, repo);
    if (session.kind !== 'created') throw new Error(session.kind);
    const filed = await fileRequest(
      requestOptions(w, repo, {
        doneWhen: '--force must not appear',
        title: '-x flag looking title',
      }),
    );
    expect(filed).toMatchObject({
      kind: 'filed',
      title: '-x flag looking title',
    });
    if (filed.kind !== 'filed') return;
    expect(rawShow(repo, filed.id)).toMatchObject({
      acceptance_criteria: '--force must not appear',
      title: '-x flag looking title',
    });
    expect(brShow({cwd: repo}, session.beadId)).toMatchObject({
      issue: {title: '-x flag looking title'},
    });
  });

  test('--db targeting: run from ANOTHER checkout, the request lands in the session’s DB', async () => {
    needBr();
    const w = world(ON);
    const home = beadsRepo(w.sb, 'home', 'hh');
    const elsewhere = beadsRepo(w.sb, 'elsewhere', 'ee');
    expect(fileSessionBead(w, home).kind).toBe('created');
    const filed = await fileRequest(
      requestOptions(w, elsewhere, {title: 'Do it over there'}),
    );
    expect(filed).toMatchObject({inCheckout: home, kind: 'filed'});
    if (filed.kind === 'filed') expect(filed.id.startsWith('hh-')).toBe(true);
    expect(brList({cwd: elsewhere}, {all: true})).toMatchObject({
      issues: [],
      kind: 'ok',
    });
    expect(indexLines(w)).toHaveLength(1);
  });

  test('thread title first: the session keeps that title through the first request', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'titled');
    const session = fileSessionBead(w, repo);
    if (session.kind !== 'created') throw new Error(session.kind);
    expect(
      await renameSession({
        cwd: repo,
        env: w.env,
        sessionId: null,
        title: '[HOME] Monday threads overhaul',
      }),
    ).toMatchObject({kind: 'renamed'});
    const after = brShow({cwd: repo}, session.beadId);
    expect(after).toMatchObject({
      issue: {title: '[HOME] Monday threads overhaul'},
    });
    if (after.kind === 'ok')
      expect(after.issue.labels).not.toContain('auto-title');
    expect(
      await fileRequest(requestOptions(w, repo, {title: 'The actual work'})),
    ).toMatchObject({renamedSession: null});
    expect(brShow({cwd: repo}, session.beadId)).toMatchObject({
      issue: {title: '[HOME] Monday threads overhaul'},
    });
  });

  test('--bead adopts in the session’s DB: in_progress + labels, parent untouched, no index line', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'adopt');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const epic = brCreate({cwd: repo}, {title: 'Epic', type: 'epic'});
    if (epic.kind !== 'ok') throw new Error(epic.reason);
    const child = brCreate(
      {cwd: repo},
      {parent: epic.id, title: 'Existing bug', type: 'bug'},
    );
    if (child.kind !== 'ok') throw new Error(child.reason);
    const adopted = await fileRequest(
      requestOptions(w, repo, {bead: child.id}),
    );
    expect(adopted).toMatchObject({
      id: child.id,
      kind: 'filed',
      mode: 'adopted',
      title: 'Existing bug',
    });
    const shown = rawShow(repo, child.id);
    expect(shown.status).toBe('in_progress');
    expect([...((shown.labels as string[] | undefined) ?? [])].sort()).toEqual([
      'request',
      `sid:${SESSION}`,
    ]);
    expect(child.id.startsWith(`${epic.id}.`)).toBe(true);
    const deps = runBr(repo, ['dep', 'list', child.id, '--json']);
    expect(deps.stdout).toContain(epic.id);
    expect(indexLines(w)).toHaveLength(1);
  });

  test('--bead falls back to the cwd’s DB and records it in the index ONCE', async () => {
    needBr();
    const w = world(ON);
    const home = beadsRepo(w.sb, 'home2', 'hh');
    const wt = beadsRepo(w.sb, 'worktree2', 'ww');
    expect(fileSessionBead(w, home).kind).toBe('created');
    const local = brCreate({cwd: wt}, {title: 'Worktree bug', type: 'bug'});
    const local2 = brCreate(
      {cwd: wt},
      {title: 'Second worktree bug', type: 'bug'},
    );
    if (local.kind !== 'ok' || local2.kind !== 'ok') throw new Error('create');
    expect(
      await fileRequest(requestOptions(w, wt, {bead: local.id})),
    ).toMatchObject({inCheckout: wt, kind: 'filed'});
    expect(indexLines(w)).toHaveLength(2);
    expect(JSON.parse(indexLines(w)[1] ?? '{}')).toMatchObject({
      beadId: local.id,
      beadsDir: join(wt, '.beads'),
      event: 'adopted-in',
    });
    expect(
      await fileRequest(requestOptions(w, wt, {bead: local2.id})),
    ).toMatchObject({kind: 'filed'});
    expect(indexLines(w)).toHaveLength(2);
    // The line unions both DBs.
    expect(
      sessionContextLine({cwd: wt, env: w.env, sessionId: SESSION}),
    ).toContain('requests: 2 open, 0 done');
  });

  // F1 (home-base-vzwbj.4.9): adopting an epic or any bead with open children.
  test('F1: --bead on an in_progress epic with an open child sends no status, adds the labels, says so, and the title rule fires', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'adopt-epic');
    const session = fileSessionBead(w, repo);
    if (session.kind !== 'created') throw new Error(session.kind);
    const epic = brCreate(
      {cwd: repo},
      {status: 'in_progress', title: 'The big epic', type: 'epic'},
    );
    if (epic.kind !== 'ok') throw new Error(epic.reason);
    const child = brCreate(
      {cwd: repo},
      {parent: epic.id, title: 'Open child', type: 'task'},
    );
    if (child.kind !== 'ok') throw new Error(child.reason);
    const out = captureStdout();
    expect(
      await runThreadRequest(requestOptions(w, repo, {bead: epic.id})),
    ).toBe(0);
    expect(out.join('\n')).toContain(
      'adopted; status already in_progress, left as it was',
    );
    const shown = rawShow(repo, epic.id);
    expect(shown.status).toBe('in_progress');
    expect([...((shown.labels as string[] | undefined) ?? [])].sort()).toEqual([
      'request',
      `sid:${SESSION}`,
    ]);
    expect(brShow({cwd: repo}, session.beadId)).toMatchObject({
      issue: {title: 'The big epic'},
    });
  });

  test('F1: --bead on a bead br refuses to claim (blocked) still adopts: labels only, status left, said out loud', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'adopt-blocked');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const blocker = brCreate({cwd: repo}, {title: 'Blocker', type: 'task'});
    const blocked = brCreate(
      {cwd: repo},
      {title: 'Blocked task', type: 'task'},
    );
    if (blocker.kind !== 'ok' || blocked.kind !== 'ok') throw new Error('x');
    // A `blocks` dependency: every br version refuses this claim (0.5.12 and
    // 0.1.37 both say "cannot claim blocked issue", measured 2026-10-11).
    const dep = runBr(repo, ['dep', 'add', blocked.id, blocker.id]);
    expect(dep.ok).toBe(true);
    const out = captureStdout();
    expect(
      await runThreadRequest(requestOptions(w, repo, {bead: blocked.id})),
    ).toBe(0);
    const said = out.join('\n');
    expect(said).toContain('adopted; status left open');
    expect(said).toContain(blocker.id);
    const shown = rawShow(repo, blocked.id);
    expect(shown.status).toBe('open');
    expect([...((shown.labels as string[] | undefined) ?? [])].sort()).toEqual([
      'request',
      `sid:${SESSION}`,
    ]);
  });

  // F11 collapsed this to one half: the whole suite runs the pinned br
  // (tests/pinned-br.ts), the version of the live repro.
  test('F1: --bead on an open task with an open child — br 0.1.37 (home-base’s pin) refuses the claim and the labels still land', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'adopt-parent');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const task = brCreate({cwd: repo}, {title: 'Parent task', type: 'task'});
    if (task.kind !== 'ok') throw new Error(task.reason);
    const kid = brCreate(
      {cwd: repo},
      {parent: task.id, title: 'Kid', type: 'task'},
    );
    if (kid.kind !== 'ok') throw new Error(kid.reason);
    const outcome = await fileRequest(requestOptions(w, repo, {bead: task.id}));
    const shown = rawShow(repo, task.id);
    expect(outcome.kind).toBe('filed');
    expect([...((shown.labels as string[] | undefined) ?? [])].sort()).toEqual([
      'request',
      `sid:${SESSION}`,
    ]);
    expect(shown.status).toBe('open');
    expect(outcome).toMatchObject({
      adoptedStatus: {kind: 'left', status: 'open'},
    });
  });

  /** The session's first prompt in its message log, logged `ageMs` ago. */
  function logFirstPrompt(w: World, ageMs: number): void {
    const path = messageLogPath(SESSION, w.env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      serializeMessageLine({
        at: new Date(Date.now() - ageMs).toISOString(),
        cwd: null,
        event: 'UserPromptSubmit',
        role: 'user',
        text: 'Build the thing',
      }),
    );
  }

  // P7 (home-base-vzwbj.4.9): a first-turn request races the capture child.
  // F13: only a first prompt younger than 30 s is still in that race.
  test('P7: a sighting that lands 1 s after the call is waited for, and the request is filed', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'race');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    logFirstPrompt(w, 2000);
    const indexPath = sessionIndexPath(w.env);
    const line = readFileSync(indexPath, 'utf8');
    rmSync(indexPath);
    const late = setTimeout(() => {
      writeFileSync(indexPath, line);
    }, 1000);
    const started = Date.now();
    try {
      const filed = await fileRequest(
        requestOptions(w, repo, {title: 'First-turn request'}),
      );
      expect(filed).toMatchObject({kind: 'filed', title: 'First-turn request'});
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      clearTimeout(late);
    }
  });

  test('P7: with no sighting at all it waits, then refuses naming the race first and the knob second', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'race-none');
    logFirstPrompt(w, 2000);
    const started = Date.now();
    const refused = await fileRequest(
      requestOptions(w, repo, {sessionWaitMs: 400, title: 'x'}),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(refused.kind).toBe('noSession');
    if (refused.kind !== 'noSession') return;
    expect(refused.reason).toStartWith(
      'no session bead yet — the capture hook files it a moment after the first prompt (waited 0.4 s)',
    );
    expect(refused.reason).toContain(
      'retry, or check componentConfig.thread.sessionBeads',
    );
  });

  // F13 (home-base-vzwbj.4.9): the wait is only for a first prompt still in
  // the race; everything else is refused at once, saying why.
  test('F13: an OLD first prompt refuses in under 200 ms, without waiting, and says why', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'race-old');
    logFirstPrompt(w, 60_000);
    const started = Date.now();
    const refused = await fileRequest(requestOptions(w, repo, {title: 'x'}));
    expect(Date.now() - started).toBeLessThan(200);
    expect(refused.kind).toBe('noSession');
    if (refused.kind !== 'noSession') return;
    expect(refused.reason).toContain(
      '(not waited for: the first prompt was logged 60 s ago, so the capture hook has had its chance)',
    );
  });

  test('F13: no message log at all (capture never ran, the knob was off) refuses at once', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'race-nolog');
    const started = Date.now();
    const refused = await fileRequest(requestOptions(w, repo, {title: 'x'}));
    expect(Date.now() - started).toBeLessThan(200);
    expect(refused).toMatchObject({kind: 'noSession'});
    expect(JSON.stringify(refused)).toContain(
      'not waited for: this session has no message log',
    );
  });

  // R9 (home-base-vzwbj.4.9): a half-written index line for this session.
  test('R9: a truncated index line for this session is NAMED in the line, the request refusal and Part 1, and the capture child still heals the index', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'corrupt-index');
    const indexPath = sessionIndexPath(w.env);
    mkdirSync(join(indexPath, '..'), {recursive: true});
    writeFileSync(
      indexPath,
      `{"at":"2026-10-11T09:00:01.000Z","beadId":"t-xyz","sessionId":"${SESSION}","ev\n`,
    );
    const named = `sessions index has a corrupt line for this session: ${indexPath}:1`;

    // The line: not "not filed yet" alone — the corrupt line is said.
    expect(
      sessionContextLine({cwd: repo, env: w.env, sessionId: SESSION}),
    ).toContain(named);

    // The refusal.
    const refused = await fileRequest(
      requestOptions(w, repo, {sessionWaitMs: 0, title: 'x'}),
    );
    expect(refused.kind).toBe('noSession');
    if (refused.kind === 'noSession') expect(refused.reason).toContain(named);

    // The capture child's heal path runs, and its outcome names the line.
    const healed = fileSessionBead(w, repo);
    expect(healed.kind).toBe('created');
    expect(healed.detail).toContain(named);
    expect(indexLines(w)).toHaveLength(2);

    // Part 1 (thread status): the corrupt line is a beads problem, said.
    const load = await loadSessionReport({
      asIfYielded: true,
      cwd: repo,
      env: w.env,
      now: new Date('2026-10-11T10:00:00.000Z'),
      selector: null,
      sessionId: null,
    });
    if (load.kind !== 'loaded') throw new Error(load.kind);
    const rendered = renderThreadStatus(load, {
      now: new Date('2026-10-11T10:00:00.000Z'),
      style: PLAIN_STYLE,
      timeZone: 'UTC',
    });
    expect(rendered).toContain(named);
    // And the line, now that the bead exists, still says it.
    expect(
      sessionContextLine({cwd: repo, env: w.env, sessionId: SESSION}),
    ).toContain(named);
  });

  test('--bead that exists nowhere: exit 1, both DBs named', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'nowhere');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const err = captureStderr();
    expect(
      await runThreadRequest(requestOptions(w, repo, {bead: 't-zzzz'})),
    ).toBe(1);
    expect(err.join('\n')).toContain('t-zzzz was not found in');
  });

  test('REFUSES when the session’s checkout is gone, naming the path; --here files in cwd', async () => {
    needBr();
    const w = world(ON);
    const gone = beadsRepo(w.sb, 'gone-checkout', 'gg');
    const here = beadsRepo(w.sb, 'still-here', 'sh');
    expect(fileSessionBead(w, gone).kind).toBe('created');
    rmSync(gone, {force: true, recursive: true});
    const err = captureStderr();

    expect(
      await runThreadRequest(requestOptions(w, here, {title: 'Keep going'})),
    ).toBe(1);
    expect(err.join('\n')).toContain(gone);
    expect(err.join('\n')).toContain('--here');
    expect(brList({cwd: here}, {all: true})).toMatchObject({
      issues: [],
      kind: 'ok',
    });

    const filed = await fileRequest(
      requestOptions(w, here, {here: true, title: 'Keep going'}),
    );
    expect(filed).toMatchObject({inCheckout: here, kind: 'filed'});
    if (filed.kind === 'filed') expect(filed.id.startsWith('sh-')).toBe(true);
    expect(indexLines(w)).toHaveLength(2);
  });

  test('no session bead / knob off / subagent / usage: each refuses loudly', async () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'refusals');
    expect(
      await fileRequest(
        requestOptions(w, repo, {sessionWaitMs: 0, title: 'x'}),
      ),
    ).toMatchObject({kind: 'noSession'});
    const off = world({enabled: true});
    expect(
      await fileRequest(requestOptions(off, repo, {title: 'x'})),
    ).toMatchObject({kind: 'disabled'});
    expect(
      await fileRequest(requestOptions(w, repo, {agentId: 'a1', title: 'x'})),
    ).toMatchObject({kind: 'subagent'});
    expect(
      await fileRequest(requestOptions(w, repo, {bead: 't-1', title: 'x'})),
    ).toMatchObject({kind: 'usage'});
    expect(
      await fileRequest(requestOptions(w, repo, {bead: 't-1', doneWhen: 'y'})),
    ).toMatchObject({kind: 'usage'});
    const err = captureStderr();
    expect(await runThreadRequest(requestOptions(w, repo, {}))).toBe(2);
    expect(err.join('\n')).toContain('exactly one of');
    expect(brList({cwd: repo}, {all: true})).toMatchObject({
      issues: [],
      kind: 'ok',
    });
  });

  test('resolveSession names the checkout when it is gone', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'resolve');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    expect(resolveSession({env: w.env, sessionId: SESSION})).toMatchObject({
      checkoutPath: repo,
      kind: 'found',
    });
    rmSync(repo, {force: true, recursive: true});
    expect(resolveSession({env: w.env, sessionId: SESSION})).toMatchObject({
      checkoutPath: repo,
      kind: 'checkoutMissing',
    });
    expect(resolveSession({env: w.env, sessionId: OTHER_SESSION}).kind).toBe(
      'none',
    );
  });
});

describe('the CLI', () => {
  test('`thread request` and `thread title` exist and run end to end', () => {
    needBr();
    const w = world(ON);
    const repo = beadsRepo(w.sb, 'cli-repo');
    expect(fileSessionBead(w, repo).kind).toBe('created');
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const env = Object.fromEntries(
      Object.entries({...process.env, ...w.env}).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    const run = (args: string[]) =>
      Bun.spawnSync([process.execPath, cli, 'thread', ...args], {
        cwd: repo,
        env,
      });
    const titled = run(['title', 'A clear name']);
    expect(titled.exitCode).toBe(0);
    expect(titled.stdout.toString()).toContain('A clear name');
    const requested = run([
      'request',
      'Do',
      'the',
      'work',
      '--done-when',
      'it works',
    ]);
    expect(requested.stderr.toString()).toBe('');
    expect(requested.exitCode).toBe(0);
    expect(requested.stdout.toString()).toMatch(/^request \S+ · Do the work/);
  });
});
