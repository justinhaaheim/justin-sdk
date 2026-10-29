/**
 * Which beads JSONL export the SDK's readers read from a linked worktree, by br
 * version (home-base-dj5m9.1.2, step 2b of the br 0.7.6 plan in
 * home-base-pp1vx.1.1).
 *
 * br rewrites the `issues.jsonl` beside the DB it used. br 0.1.37 keeps a DB per
 * worktree; from 0.4.1 on, a worktree with no DB of its own uses the primary
 * checkout's, and br rewrites the PRIMARY's export. The worktree's own export
 * is committed, so it is still there, frozen at the branch point. Each reader
 * must read the file br writes: the worktree's under 0.1.37 (as before), the
 * primary's under 0.7.6.
 *
 * THE FIXTURE (`staleRepo`). A real git repo and a real br: mise's installed
 * 0.1.37 or 0.7.6, first on PATH for its own test whatever home-base pins
 * (home-base-dj5m9.1.4), or the pinned br for the tests that are about no
 * version. The session bead,
 * request 1 (in progress, under epic 1) are created in the primary's DB and
 * committed; a linked worktree is cut from that commit, so its committed
 * export holds that state. Then, in the primary's DB only: the session bead is
 * retitled, request 1 is closed, and request 2 is filed under a new epic 2.
 * The sessions index names the WORKTREE's `.beads/`, the way a 0.1.37-era
 * session recorded it. So every reader shows which file it read:
 *   - worktree's (stale): "Stale title", request 1 in progress, epic 1 only.
 *   - primary's (live): "Live title", request 1 closed, request 2, epics 1, 2.
 *
 * Nothing here touches a real repo's beads: every repo is under $TMPDIR.
 *
 * NEGATIVE CONTROLS (run by hand, recorded in the dispatch report and the
 * bead's notes for home-base-dj5m9.1.2): each describe block names the change
 * that turns it red.
 */

import type {CreatedBead} from '../src/thread/session-created';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join, relative} from 'path';

import {
  brClose,
  brCreate,
  type BrCreateOutcome,
  brUpdate,
  type BrWriteOutcome,
  findBeadsDb,
  runBr,
} from '../src/beads/br';
import {BEADS_JSONL, recordedBeadsJsonl} from '../src/beads/jsonl';
import {decideNudge} from '../src/thread/nudge';
import {findRelatedEpics} from '../src/thread/related-epics';
import {lookUpSessionBeads} from '../src/thread/search';
import {resolveCreatedBeads} from '../src/thread/session-created';
import {appendSessionSighting} from '../src/thread/session-index';
import {
  beadsWorkspaceNear,
  sessionContextLine,
} from '../src/thread/session-line';
import {
  createLoadCache,
  loadSession,
  measured,
  resolveSessionId,
} from '../src/thread/session-model';
import {loadSessionReport, relatedEpicsOf} from '../src/thread/session-report';
import {readBeadsExport, readSessionTree} from '../src/thread/session-tree';
import {addLinkedWorktree, git, initRepo} from './git-fixtures';
import {installedBr, needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '0dbd0d0d-1a1a-4b2b-8c3c-0123456789ab';
/** A session with no bead yet, for the not-filed-yet line. */
const NEW_SESSION = '0dbd0d0d-2b2b-4c3c-8d4d-0123456789ab';
const STALE_TITLE = 'Stale title';
const LIVE_TITLE = 'Live title';
const NOW = new Date('2026-10-26T12:00:00.000Z');
/** Generous: a fixture is ~12 br runs, and loadSession reads git too. */
const TIMEOUT_MS = 60_000;

const BR_076 = installedBr('0.7.6');
if (BR_076.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.7.6 tests in beads-worktree-jsonl.test.ts cannot run (${BR_076.reason})`,
  );
}

const BR_0137 = installedBr('0.1.37');
if (BR_0137.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.1.37 tests in beads-worktree-jsonl.test.ts cannot run (${BR_0137.reason})`,
  );
}

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function sandbox(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

type Version = '0.1.37' | '0.7.6';

/** The export each version's readers must read for the worktree's entry. */
const READS: Record<Version, 'primary' | 'worktree'> = {
  '0.1.37': 'worktree',
  '0.7.6': 'primary',
};

/** Run `fn` under br `version`, then put PATH back (async-safe). */
async function underBr<T>(
  version: Version,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = process.env.PATH;
  const br = version === '0.7.6' ? BR_076 : BR_0137;
  if (br.kind !== 'installed') throw new Error(br.reason);
  process.env.PATH = `${br.dir}${delimiter}${saved ?? ''}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/** Run `fn` with `dir` first on PATH (async-safe). */
async function withPathFirst<T>(
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved ?? ''}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/** A directory holding a `br` that is not a br: it says `said` and exits `code`. */
function fakeBrDir(sb: Sandbox, said: string, code: number): string {
  const dir = join(sb.path, `fake-br-${code}`);
  mkdirSync(dir, {recursive: true});
  const path = join(dir, 'br');
  writeFileSync(path, `#!/bin/sh\necho '${said}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return dir;
}

function created(outcome: BrCreateOutcome): string {
  if (outcome.kind !== 'ok') throw new Error(outcome.reason);
  return outcome.id;
}

function wrote(outcome: BrWriteOutcome): void {
  if (outcome.kind !== 'ok') throw new Error(outcome.reason);
}

interface StaleRepo {
  /** Epic 1: request 1's parent, in both exports. */
  e1: string;
  /** Epic 2: request 2's parent, in the primary's export only. */
  e2: string;
  env: Record<string, string | undefined>;
  primary: string;
  primaryJsonl: string;
  /** Request 1: in progress in the worktree's export, closed in the primary's. */
  r1: string;
  /** Request 2: in the primary's export only. */
  r2: string;
  sb: Sandbox;
  sessionBead: string;
  worktree: string;
  /** What the sessions index recorded: the worktree's `.beads/`. */
  worktreeBeads: string;
  worktreeJsonl: string;
}

/** See the header. Call it under the br the test is about. */
function staleRepo(): StaleRepo {
  const sb = sandbox();
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, nudge: true, sessionBeads: true},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    // No cmux unless a test sets it: the suite may itself run inside cmux.
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    XDG_CONFIG_HOME: xdg,
  };
  const primary = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  const init = runBr(primary, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const db = join(primary, '.beads', 'beads.db');
  const sid = `sid:${SESSION}`;

  // The branch point: what the worktree's committed export will hold.
  const sessionBead = created(
    brCreate(
      {db},
      {
        labels: ['session', sid],
        priority: 3,
        status: 'in_progress',
        title: STALE_TITLE,
        type: 'session',
      },
    ),
  );
  const e1 = created(
    brCreate({db}, {priority: 2, title: 'Epic one', type: 'epic'}),
  );
  const r1 = created(
    brCreate(
      {db},
      {
        labels: ['request', sid],
        parent: e1,
        priority: 3,
        status: 'in_progress',
        title: 'First request',
        type: 'task',
      },
    ),
  );
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'beads at the branch point']);
  const worktree = addLinkedWorktree(
    primary,
    join(primary, '.claude', 'worktrees', 'wt'),
    'wt-branch',
  );

  // After the branch, in the primary's DB only: what br 0.7.6 does with every
  // write made from the worktree.
  wrote(brUpdate({db}, sessionBead, {title: LIVE_TITLE}));
  wrote(brClose({db}, r1, 'done'));
  const e2 = created(
    brCreate({db}, {priority: 2, title: 'Epic two', type: 'epic'}),
  );
  const r2 = created(
    brCreate(
      {db},
      {
        labels: ['request', sid],
        parent: e2,
        priority: 3,
        title: 'Second request',
        type: 'task',
      },
    ),
  );

  // The index line a 0.1.37-era session wrote: its worktree's `.beads/`.
  const worktreeBeads = join(worktree, '.beads');
  const appended = appendSessionSighting(
    {
      at: '2026-10-20T09:00:00.000Z',
      beadId: sessionBead,
      beadsDir: worktreeBeads,
      branch: 'wt-branch',
      checkoutPath: worktree,
      event: 'created',
      repo: 'repo',
      sessionId: SESSION,
    },
    env,
  );
  if (appended.kind !== 'appended') throw new Error(appended.error);

  const primaryJsonl = join(primary, '.beads', BEADS_JSONL);
  const worktreeJsonl = join(worktreeBeads, BEADS_JSONL);
  // Fixture sanity: the premise of every test below.
  expect(findBeadsDb(worktreeBeads).kind).toBe('none');
  const stale = readFileSync(worktreeJsonl, 'utf8');
  const live = readFileSync(primaryJsonl, 'utf8');
  expect(stale).toContain(STALE_TITLE);
  expect(stale).not.toContain(r2);
  expect(live).toContain(LIVE_TITLE);
  expect(live).toContain(r2);
  return {
    e1,
    e2,
    env,
    primary,
    primaryJsonl,
    r1,
    r2,
    sb,
    sessionBead,
    worktree,
    worktreeBeads,
    worktreeJsonl,
  };
}

/**
 * One test per br version, each run under mise's installed br of that version
 * whatever home-base pins, and skipped with the SKIPPED line above when it is
 * not installed.
 */
function eachBr(
  name: string,
  body: (repo: StaleRepo, version: Version) => Promise<void> | void,
): void {
  test.skipIf(BR_0137.kind !== 'installed')(
    `br 0.1.37 reads the worktree's export: ${name}`,
    async () => {
      await underBr('0.1.37', async () => {
        await body(staleRepo(), '0.1.37');
      });
    },
    TIMEOUT_MS,
  );
  test.skipIf(BR_076.kind !== 'installed')(
    `br 0.7.6 reads the primary's export: ${name}`,
    async () => {
      await underBr('0.7.6', async () => {
        await body(staleRepo(), '0.7.6');
      });
    },
    TIMEOUT_MS,
  );
}

/** What the readers see, by which export they read. */
function expected(repo: StaleRepo, version: Version) {
  const live = READS[version] === 'primary';
  return {
    epics: live ? [repo.e1, repo.e2] : [repo.e1],
    jsonl: live ? repo.primaryJsonl : repo.worktreeJsonl,
    requestCounts: live
      ? 'requests: 1 open, 1 done'
      : 'requests: 1 open, 0 done',
    requests: live
      ? [
          [repo.r1, 'closed'],
          [repo.r2, 'open'],
        ]
      : [[repo.r1, 'in_progress']],
    title: live ? LIVE_TITLE : STALE_TITLE,
  };
}

// ---------------------------------------------------------------------------
// The shared locator, and the one reader every tree reader uses
// NEGATIVE CONTROL: put `const path = join(beadsDir, 'issues.jsonl')` back in
// readBeadsExport and every 0.7.6 test in this block and the next goes red
// (they read the worktree's stale file); set BR_SHARED_DB_SINCE to
// {major: 0, minor: 0, patch: 0} and the 0.1.37 ones do (they read main's).
// ---------------------------------------------------------------------------

describe('recordedBeadsJsonl and readBeadsExport: the export beside the DB br uses', () => {
  eachBr('a recorded worktree .beads/ without a DB', (repo, version) => {
    const want = expected(repo, version);
    expect(recordedBeadsJsonl(repo.worktreeBeads)).toEqual({
      kind: 'found',
      path: want.jsonl,
      via: version === '0.7.6' ? 'primary' : 'noDatabase',
    });
    const read = readBeadsExport(repo.worktreeBeads);
    expect(read).toMatchObject({kind: 'read', path: want.jsonl});
    // The primary's own entry reads its own file under every version.
    expect(readBeadsExport(join(repo.primary, '.beads'))).toMatchObject({
      kind: 'read',
      path: repo.primaryJsonl,
    });
  });

  test(
    'a worktree that still holds its own DB reads its own export, under every br',
    () => {
      // Version-free: the pinned br builds the fixture.
      needBr();
      const repo = staleRepo();
      mkdirSync(repo.worktreeBeads, {recursive: true});
      writeFileSync(join(repo.worktreeBeads, 'beads.db'), '');
      expect(recordedBeadsJsonl(repo.worktreeBeads)).toEqual({
        kind: 'found',
        path: repo.worktreeJsonl,
        via: 'recorded',
      });
    },
    TIMEOUT_MS,
  );

  test(
    'a br version that cannot be read is a failed read, never some file',
    async () => {
      // Version-free: the pinned br builds the fixture.
      needBr();
      const repo = staleRepo();
      const failing = fakeBrDir(repo.sb, 'no br for you', 3);
      const out = await withPathFirst(failing, () =>
        readBeadsExport(repo.worktreeBeads),
      );
      expect(out.kind).toBe('failed');
      if (out.kind === 'failed') {
        expect(out.reason).toContain('could not be told');
        expect(out.reason).toContain('exited 3');
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The readers listed in home-base-dj5m9.1.2
// NEGATIVE CONTROL: as above (readBeadsExport) for session-tree, nudge,
// session-model, search, related-epics, session-report and session-created.
// For the prompt line: put `const path = join(beadsDir, 'issues.jsonl')` back
// in readExportedSessionIssues and the 0.7.6 session-line test goes red; make
// beadsWorkspaceNear `return own.kind === 'found' ? found : none` and the
// 0.7.6 not-filed-yet test goes red.
// ---------------------------------------------------------------------------

describe('each reader reads the export br writes', () => {
  eachBr('session-line: the prompt-time line', (repo, version) => {
    const want = expected(repo, version);
    const line =
      sessionContextLine({
        cwd: repo.worktree,
        env: repo.env,
        sessionId: SESSION,
      }) ?? '';
    expect(line).toContain(`session ${repo.sessionBead} "${want.title}"`);
    expect(line).toContain(want.requestCounts);
  });

  eachBr(
    'session-line: beadsWorkspaceNear, before the session has a bead',
    (repo, version) => {
      expect(beadsWorkspaceNear(repo.worktree)).toEqual(
        version === '0.7.6' ? {kind: 'found'} : {kind: 'none'},
      );
      const line = sessionContextLine({
        cwd: repo.worktree,
        env: repo.env,
        sessionId: NEW_SESSION,
      });
      if (version === '0.7.6') {
        expect(line).toContain('session bead: not filed yet');
      } else {
        // As before: no workspace br would use, so no line at all.
        expect(line).toBeNull();
      }
      // The primary checkout, and a subdirectory of the worktree.
      expect(beadsWorkspaceNear(repo.primary)).toEqual({kind: 'found'});
      const sub = join(repo.worktree, 'sub');
      mkdirSync(sub);
      expect(beadsWorkspaceNear(sub)).toEqual(
        beadsWorkspaceNear(repo.worktree),
      );
    },
  );

  eachBr('session-tree: readSessionTree', (repo, version) => {
    const want = expected(repo, version);
    const tree = readSessionTree({
      beadsDirs: [repo.worktreeBeads],
      sessionBeadId: repo.sessionBead,
      sessionId: SESSION,
    });
    expect(tree.problems).toEqual([]);
    expect(tree.session?.title).toBe(want.title);
    expect(
      tree.requests.map((node) => [node.request.id, node.request.status]),
    ).toEqual(want.requests);
  });

  eachBr('nudge: decideNudge after a git commit', async (repo, version) => {
    const decision = await decideNudge({
      env: repo.env,
      now: NOW,
      raw: JSON.stringify({
        cwd: repo.worktree,
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
        tool_input: {command: "git commit -qm 'docs: tidy'"},
        tool_name: 'Bash',
        tool_response: {stderr: '', stdout: ''},
      }),
    });
    if (READS[version] === 'primary') {
      // Request 1 is closed in the live export: nothing is in progress.
      expect(decision).toMatchObject({kind: 'speak', unchecked: null});
    } else {
      expect(decision).toEqual({
        kind: 'silent',
        why: 'a request is in progress',
      });
    }
  });

  eachBr(
    'session-model: loadSession, with and without the inbox cache',
    async (repo, version) => {
      const want = expected(repo, version);
      for (const cache of [null, createLoadCache()]) {
        const load = await loadSession({
          ...(cache != null ? {cache} : {}),
          cwd: repo.worktree,
          env: repo.env,
          selector: null,
          sessionIdOption: SESSION,
        });
        expect(load.kind).toBe('loaded');
        if (load.kind !== 'loaded') continue;
        expect(load.model.beads.problems).toEqual([]);
        expect(load.model.beads.session?.title).toBe(want.title);
        expect(
          load.model.beads.requests.map((node) => [
            node.request.id,
            node.request.status,
          ]),
        ).toEqual(want.requests);
      }
    },
  );

  eachBr(
    'session-model: resolveSessionId from a request id the index does not name',
    (repo, version) => {
      // A cwd outside any repo, so only the index's directories are searched.
      const out = resolveSessionId({
        cwd: repo.sb.path,
        env: repo.env,
        selector: repo.r2,
        sessionIdOption: null,
      });
      if (READS[version] === 'primary') {
        expect(out).toEqual({kind: 'found', sessionId: SESSION});
      } else {
        expect(out.kind).toBe('noSession');
        if (out.kind === 'noSession') {
          expect(out.reason).toContain(repo.worktreeJsonl);
        }
      }
    },
  );

  eachBr('search: lookUpSessionBeads', (repo, version) => {
    expect(lookUpSessionBeads([SESSION], repo.env).get(SESSION)).toEqual({
      beadId: repo.sessionBead,
      kind: 'found',
      title: expected(repo, version).title,
    });
  });

  eachBr('related-epics: findRelatedEpics', (repo, version) => {
    const tree = readSessionTree({
      beadsDirs: [repo.worktreeBeads],
      sessionBeadId: repo.sessionBead,
      sessionId: SESSION,
    });
    const related = findRelatedEpics({
      created: measured({found: [], missing: [], notCreatedThen: []}),
      sessionDirs: [repo.worktreeBeads],
      tree,
    });
    expect(related.problems).toEqual([]);
    expect(related.epics.map((entry) => entry.epic.id)).toEqual(
      expected(repo, version).epics,
    );
  });

  eachBr(
    'session-report: thread show reads the related epics from the same exports',
    async (repo, version) => {
      const load = await loadSessionReport({
        asIfYielded: false,
        cwd: repo.worktree,
        env: repo.env,
        now: NOW,
        selector: null,
        sessionId: SESSION,
      });
      expect(load.kind).toBe('loaded');
      if (load.kind !== 'loaded') return;
      expect(load.model.beads.session?.title).toBe(
        expected(repo, version).title,
      );
      expect(relatedEpicsOf(load).epics.map((entry) => entry.epic.id)).toEqual(
        expected(repo, version).epics,
      );
    },
  );

  eachBr(
    'session-created: a bead the session created, looked up in its directories',
    (repo, version) => {
      // The call that made request 2, timed to its created_at (F6).
      const line = readFileSync(repo.primaryJsonl, 'utf8')
        .split('\n')
        .find((entry) => entry.includes(`"id":${JSON.stringify(repo.r2)}`));
      const createdAt =
        line == null
          ? null
          : ((JSON.parse(line) as {created_at?: string}).created_at ?? null);
      expect(createdAt).not.toBeNull();
      const call: CreatedBead = {
        createdAt,
        cwd: null,
        file: 'transcript.jsonl',
        id: repo.r2,
        resultAt: null,
      };
      const out = resolveCreatedBeads({
        created: [call],
        sessionDirs: [repo.worktreeBeads],
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      if (READS[version] === 'primary') {
        expect(out.value.found.map((issue) => issue.id)).toEqual([repo.r2]);
        expect(out.value.missing).toEqual([]);
      } else {
        expect(out.value.found).toEqual([]);
        expect(out.value.missing).toEqual([
          {id: repo.r2, searched: [repo.worktreeJsonl]},
        ]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// beadsWorkspaceNear stays cheap, and says what it could not tell
// NEGATIVE CONTROL: ask brVersionIn before reading the primary's .beads/ and
// the no-beads test goes red (the failing fake br runs); make a failed version
// `return {kind: 'none'}` and the unreadable-version test goes red.
// ---------------------------------------------------------------------------

describe('beadsWorkspaceNear: files first, the br version only when it decides', () => {
  test('a worktree in a repo with no beads anywhere is none, and br is never asked', async () => {
    needBr();
    const sb = sandbox();
    const primary = initRepo(sb, 'plain', {'README.md': '# plain\n'});
    const worktree = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'wt'),
      'wt-branch',
    );
    const failing = fakeBrDir(sb, 'should not run', 3);
    expect(
      await withPathFirst(failing, () => beadsWorkspaceNear(worktree)),
    ).toEqual({kind: 'none'});
  });

  test(
    'an unreadable br version is said in the line, never read as no workspace',
    async () => {
      // Version-free: the pinned br builds the fixture.
      needBr();
      const repo = staleRepo();
      const failing = fakeBrDir(repo.sb, 'mise ERROR no br for you', 3);
      const near = await withPathFirst(failing, () =>
        beadsWorkspaceNear(repo.worktree),
      );
      expect(near.kind).toBe('failed');
      if (near.kind === 'failed') {
        expect(near.reason).toContain('br --version exited 3');
      }
      const line =
        (await withPathFirst(failing, () =>
          sessionContextLine({
            cwd: repo.worktree,
            env: repo.env,
            sessionId: NEW_SESSION,
          }),
        )) ?? '';
      expect(line).toContain(
        'whether this checkout has a beads workspace is unknown',
      );
      expect(line).toContain('br --version exited 3');
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// No reader builds the path itself
// NEGATIVE CONTROL: put `join(beadsDir, 'issues.jsonl')` back in any thread
// reader and this goes red.
// ---------------------------------------------------------------------------

/** A quoted `issues.jsonl` string in code (comments use backticks). */
const JSONL_LITERAL = /['"]issues\.jsonl['"]/;

describe('the export path is built in one place', () => {
  test('no thread reader spells the issues.jsonl path itself', () => {
    const dir = join(import.meta.dir, '..', 'src', 'thread');
    // Two files may, for the LEGACY threads repo's bd export, which is not a
    // br workspace and has no worktrees: session-report.ts
    // (routesToLegacyThread) and session-untracked.ts (readOldReports).
    const legacy: Record<string, string> = {
      'session-report.ts': 'threadsBeadsDir(',
      'session-untracked.ts': 'join(repoDir, ',
    };
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((entry) =>
      entry.endsWith('.ts'),
    )) {
      const allowedOn = legacy[name] ?? null;
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!JSONL_LITERAL.test(line)) continue;
        if (allowedOn != null && line.includes(allowedOn)) continue;
        offenders.push(
          `${relative(join(import.meta.dir, '..'), join(dir, name))}: ${line.trim()}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
