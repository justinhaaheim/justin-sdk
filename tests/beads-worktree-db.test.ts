/**
 * Which beads DB the SDK uses from a linked worktree, by br version
 * (home-base-dj5m9.1.1, step 2a of the br 0.7.6 plan in home-base-pp1vx.1.1).
 *
 * br 0.1.37 keeps one DB per worktree; from 0.4.1 on, a linked worktree with no
 * DB of its own uses the PRIMARY checkout's. `findBeadsWorkspace` mirrors that,
 * and `resolveRecordedBeadsDb` resolves the `.beads/` directories the sessions
 * index recorded under 0.1.37 to wherever their beads live now.
 *
 * Everything runs the REAL br and REAL git in throwaway repos under $TMPDIR:
 * which DB br picks is br's behaviour, so the 0.7.6 tests also ask br itself
 * (`br where`) and check the SDK agrees. The 0.1.37 tests and the 0.7.6 tests
 * each put mise's installed br of THAT version first on PATH for their own run
 * only (`installedBr`), whatever home-base pins, and print a loud SKIPPED line
 * when it is not installed (home-base-dj5m9.1.4: the suite passes with either
 * pinned). The version-free tests run the pinned br (tests/pinned-br.ts).
 * Nothing here touches a real repo's beads.
 *
 * NEGATIVE CONTROLS (run by hand, recorded in the dispatch report for
 * home-base-dj5m9.1.1): each describe block names the change that turns it red.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join, relative} from 'path';

import {
  BR_SHARED_DB_SINCE,
  brCreate,
  brSharesWorktreeDb,
  findBeadsDb,
  findBeadsWorkspace,
  parseBrVersion,
  resolveRecordedBeadsDb,
  runBr,
} from '../src/beads/br';
import {sessionIndexPath} from '../src/thread/archive';
import {ensureSessionBead, resolveSession} from '../src/thread/session-bead';
import {locateSessionBead} from '../src/thread/session-handoff';
import {
  appendSessionSighting,
  readSessionSightings,
} from '../src/thread/session-index';
import {sessionBeadsLabelled} from '../src/thread/session-select';
import {addLinkedWorktree, git, initRepo} from './git-fixtures';
import {installedBr, needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '0dbd0d0d-5e55-4a11-8b0b-1234567890ab';

const BR_076 = installedBr('0.7.6');
if (BR_076.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.7.6 tests in beads-worktree-db.test.ts cannot run (${BR_076.reason})`,
  );
}
const with076 = test.skipIf(BR_076.kind !== 'installed');

const BR_0137 = installedBr('0.1.37');
if (BR_0137.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.1.37 tests in beads-worktree-db.test.ts cannot run (${BR_0137.reason})`,
  );
}
const with0137 = test.skipIf(BR_0137.kind !== 'installed');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function sandbox(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

/** Run `fn` with `dir` first on PATH, then put PATH back. */
function withPathFirst<T>(dir: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved ?? ''}`;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/** Run `fn` with br 0.7.6 first on PATH (the caller is a `with076` test). */
function with076Br<T>(fn: () => T): T {
  if (BR_076.kind !== 'installed') throw new Error(BR_076.reason);
  return withPathFirst(BR_076.dir, fn);
}

/** Run `fn` with br 0.1.37 first on PATH (the caller is a `with0137` test). */
function with0137Br<T>(fn: () => T): T {
  if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
  return withPathFirst(BR_0137.dir, fn);
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

interface Repo {
  primary: string;
  /** The primary checkout's DB. */
  primaryDb: string;
  /** A linked worktree at `<primary>/.claude/worktrees/wt`, with no DB. */
  worktree: string;
}

/**
 * A committed repo with a br workspace and a linked worktree where Claude Code
 * puts them. `.beads/` is committed (its `*.db` is gitignored by br), so the
 * worktree has a `.beads/` without a DB, as every real worktree does. Run it
 * with the br the test is about first on PATH: `br init` writes that br's
 * schema.
 */
function repoWithWorktree(sb: Sandbox, beads = true): Repo {
  const primary = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  if (beads) {
    const init = runBr(primary, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    git(primary, ['add', '-A']);
    git(primary, ['commit', '-qm', 'beads']);
  }
  const worktree = addLinkedWorktree(
    primary,
    join(primary, '.claude', 'worktrees', 'wt'),
    'wt-branch',
  );
  const primaryDb = join(primary, '.beads', 'beads.db');
  // Fixture sanity: the premise of every test below.
  expect(existsSync(primaryDb)).toBe(beads);
  expect(findBeadsDb(join(worktree, '.beads')).kind).toBe('none');
  return {primary, primaryDb, worktree};
}

/** Give the worktree a DB of its own: a copy of the primary's, as the probe did. */
function giveWorktreeItsOwnDb(repo: Repo): string {
  const own = join(repo.worktree, '.beads', 'beads.db');
  mkdirSync(join(repo.worktree, '.beads'), {recursive: true});
  copyFileSync(repo.primaryDb, own);
  return own;
}

/** What `br where` says the database is, from `cwd` (br 0.7.6). */
function brWhereDb(cwd: string): string {
  const out = runBr(cwd, ['where']);
  if (!out.ok) throw new Error(`br where failed: ${out.reason ?? '?'}`);
  const line = out.stdout
    .split('\n')
    .find((entry) => entry.trim().startsWith('database:'));
  if (line == null)
    throw new Error(`br where named no database: ${out.stdout}`);
  return line.trim().slice('database:'.length).trim();
}

// ---------------------------------------------------------------------------
// The version rule
// ---------------------------------------------------------------------------

describe('which br versions share the primary checkout DB', () => {
  test('parseBrVersion reads br --version, past a warning line, and refuses anything else', () => {
    expect(parseBrVersion('br 0.7.6\n')).toEqual({
      major: 0,
      minor: 7,
      patch: 6,
      text: '0.7.6',
    });
    expect(parseBrVersion('mise WARN something\nbr 0.1.37\n')?.text).toBe(
      '0.1.37',
    );
    expect(parseBrVersion('')).toBeNull();
    expect(parseBrVersion('bd version 0.7.6')).toBeNull();
    expect(parseBrVersion('br version unknown')).toBeNull();
  });

  test('0.4.1 and later share; 0.4.0 and earlier (0.1.37, 0.3.2: measured per-worktree) do not', () => {
    expect(BR_SHARED_DB_SINCE).toEqual({major: 0, minor: 4, patch: 1});
    const shares = (text: string): boolean => {
      const parsed = parseBrVersion(`br ${text}`);
      if (parsed == null) throw new Error(text);
      return brSharesWorktreeDb(parsed);
    };
    expect(shares('0.1.37')).toBe(false);
    expect(shares('0.3.2')).toBe(false);
    expect(shares('0.4.0')).toBe(false);
    expect(shares('0.4.1')).toBe(true);
    expect(shares('0.5.10')).toBe(true);
    expect(shares('0.7.6')).toBe(true);
    expect(shares('1.0.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findBeadsWorkspace
// NEGATIVE CONTROL: set BR_SHARED_DB_SINCE to {major: 99, …} and the 0.7.6
// tests go red (`none`); set it to {major: 0, minor: 0, patch: 0} and the
// 0.1.37 ones do (`found` via primary).
// ---------------------------------------------------------------------------

describe('findBeadsWorkspace mirrors br discovery by version', () => {
  with076(
    'br 0.7.6, linked worktree with no DB: the primary checkout DB, the same one br uses',
    () => {
      with076Br(() => {
        const repo = repoWithWorktree(sandbox());
        const found = findBeadsWorkspace(repo.worktree);
        expect(found).toEqual({
          beadsDir: join(repo.primary, '.beads'),
          brVersion: '0.7.6',
          db: repo.primaryDb,
          kind: 'found',
          primaryRoot: repo.primary,
          root: repo.worktree,
          via: 'primary',
        });
        // br agrees: this is ITS discovery, measured, not the SDK's opinion.
        expect(brWhereDb(repo.worktree)).toBe(repo.primaryDb);
        // From a subdirectory of the worktree too.
        const sub = join(repo.worktree, 'sub');
        mkdirSync(sub);
        expect(findBeadsWorkspace(sub)).toMatchObject({
          db: repo.primaryDb,
          root: repo.worktree,
          via: 'primary',
        });
        expect(brWhereDb(sub)).toBe(repo.primaryDb);
      });
    },
  );

  with076(
    'br 0.7.6, linked worktree WITH its own DB: that DB, which br uses too',
    () => {
      with076Br(() => {
        const repo = repoWithWorktree(sandbox());
        const own = giveWorktreeItsOwnDb(repo);
        expect(findBeadsWorkspace(repo.worktree)).toEqual({
          beadsDir: join(repo.worktree, '.beads'),
          db: own,
          kind: 'found',
          root: repo.worktree,
          via: 'checkout',
        });
        expect(brWhereDb(repo.worktree)).toBe(own);
      });
    },
  );

  with076('br 0.7.6, the primary checkout: its own DB, as before', () => {
    with076Br(() => {
      const repo = repoWithWorktree(sandbox());
      expect(findBeadsWorkspace(repo.primary)).toEqual({
        beadsDir: join(repo.primary, '.beads'),
        db: repo.primaryDb,
        kind: 'found',
        root: repo.primary,
        via: 'checkout',
      });
    });
  });

  with0137(
    'br 0.1.37, linked worktree with no DB: none, with the same reason as before',
    () => {
      with0137Br(() => {
        const repo = repoWithWorktree(sandbox());
        const before = findBeadsDb(join(repo.worktree, '.beads'));
        expect(findBeadsWorkspace(repo.worktree)).toEqual({
          kind: 'none',
          reason: before.kind === 'none' ? before.reason : 'not none',
        });
      });
    },
  );

  with0137(
    'br 0.1.37, linked worktree with its own DB, and the primary: their own DBs',
    () => {
      with0137Br(() => {
        const repo = repoWithWorktree(sandbox());
        expect(findBeadsWorkspace(repo.primary)).toMatchObject({
          db: repo.primaryDb,
          via: 'checkout',
        });
        const own = giveWorktreeItsOwnDb(repo);
        expect(findBeadsWorkspace(repo.worktree)).toMatchObject({
          db: own,
          root: repo.worktree,
          via: 'checkout',
        });
      });
    },
  );

  test('an unreadable br version is failed, never a guess', () => {
    needBr();
    const sb = sandbox();
    const repo = repoWithWorktree(sb);
    const failing = fakeBrDir(sb, 'mise ERROR no br for you', 3);
    const out = withPathFirst(failing, () => findBeadsWorkspace(repo.worktree));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.reason).toContain('br --version exited 3');
      expect(out.reason).toContain('could not be read');
    }
    // A br that runs but prints no version is the same: not knowing.
    const sb2 = sandbox();
    const repo2 = repoWithWorktree(sb2);
    const garbled = fakeBrDir(sb2, 'beads, probably', 0);
    const out2 = withPathFirst(garbled, () =>
      findBeadsWorkspace(repo2.worktree),
    );
    expect(out2.kind).toBe('failed');
    if (out2.kind === 'failed') {
      expect(out2.reason).toContain('printed no version');
    }
  });

  test('a repo with no beads anywhere is none, and br is never asked', () => {
    needBr();
    const sb = sandbox();
    const repo = repoWithWorktree(sb, false);
    // A br that would fail if it ran: `none` proves the version was not asked.
    const failing = fakeBrDir(sb, 'should not run', 3);
    const out = withPathFirst(failing, () => findBeadsWorkspace(repo.worktree));
    expect(out.kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// resolveRecordedBeadsDb
// NEGATIVE CONTROL: make it `return own` whenever the recorded dir has no DB
// (the old findBeadsDb behaviour) and every `via: 'primary'` case goes red.
// ---------------------------------------------------------------------------

describe('resolveRecordedBeadsDb: an old sessions-index beadsDir, resolved at read time', () => {
  test('a recorded dir that still holds its DB is used as is', () => {
    needBr();
    const repo = repoWithWorktree(sandbox());
    const own = giveWorktreeItsOwnDb(repo);
    expect(resolveRecordedBeadsDb(join(repo.worktree, '.beads'))).toEqual({
      beadsDir: join(repo.worktree, '.beads'),
      db: own,
      kind: 'found',
      via: 'recorded',
    });
  });

  with076(
    'br 0.7.6: a worktree whose DB was moved aside resolves to the primary DB',
    () => {
      with076Br(() => {
        const repo = repoWithWorktree(sandbox());
        // The upgrade moves a worktree's 0.1.37 DB aside; br ignores the name.
        writeFileSync(
          join(repo.worktree, '.beads', 'beads.db.moved-aside'),
          'old',
        );
        const recorded = join(repo.worktree, '.beads');
        expect(resolveRecordedBeadsDb(recorded)).toEqual({
          beadsDir: join(repo.primary, '.beads'),
          brVersion: '0.7.6',
          db: repo.primaryDb,
          kind: 'found',
          primaryRoot: repo.primary,
          recordedBeadsDir: recorded,
          via: 'primary',
        });
      });
    },
  );

  with076(
    'br 0.7.6: a worktree that no longer exists resolves to the primary DB, found by its path',
    () => {
      with076Br(() => {
        const repo = repoWithWorktree(sandbox());
        const recorded = join(repo.worktree, '.beads');
        git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
        expect(existsSync(repo.worktree)).toBe(false);
        expect(resolveRecordedBeadsDb(recorded)).toMatchObject({
          db: repo.primaryDb,
          kind: 'found',
          primaryRoot: repo.primary,
          via: 'primary',
        });
        // Its directory lingering, empty, is still not a checkout.
        mkdirSync(join(repo.worktree, '.beads'), {recursive: true});
        expect(resolveRecordedBeadsDb(recorded)).toMatchObject({
          db: repo.primaryDb,
          via: 'primary',
        });
      });
    },
  );

  with076(
    'br 0.7.6: a gone worktree outside .claude/worktrees/ cannot be traced, and is none',
    () => {
      with076Br(() => {
        const sb = sandbox();
        const repo = repoWithWorktree(sb);
        const elsewhere = addLinkedWorktree(
          repo.primary,
          join(sb.path, 'sibling-wt'),
          'sibling-branch',
        );
        // Alive, git finds the primary from anywhere.
        expect(resolveRecordedBeadsDb(join(elsewhere, '.beads'))).toMatchObject(
          {db: repo.primaryDb, via: 'primary'},
        );
        git(repo.primary, ['worktree', 'remove', '--force', elsewhere]);
        const out = resolveRecordedBeadsDb(join(elsewhere, '.beads'));
        expect(out.kind).toBe('none');
        if (out.kind === 'none') {
          expect(out.reason).toContain('cannot be traced');
        }
      });
    },
  );

  with0137(
    'br 0.1.37: a worktree without a DB, alive or gone, stays none with its old reason',
    () => {
      with0137Br(() => {
        const repo = repoWithWorktree(sandbox());
        const recorded = join(repo.worktree, '.beads');
        // What the readers got before this change: findBeadsDb's own answer.
        const oldAnswer = (): unknown => findBeadsDb(recorded);
        expect(oldAnswer()).toMatchObject({kind: 'none'});
        expect<unknown>(resolveRecordedBeadsDb(recorded)).toEqual(oldAnswer());
        git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
        expect(oldAnswer()).toMatchObject({kind: 'none'});
        expect<unknown>(resolveRecordedBeadsDb(recorded)).toEqual(oldAnswer());
      });
    },
  );

  test('a gone worktree whose repo br version cannot be read is failed', () => {
    needBr();
    const sb = sandbox();
    const repo = repoWithWorktree(sb);
    const recorded = join(repo.worktree, '.beads');
    git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
    const failing = fakeBrDir(sb, 'no br here', 4);
    const out = withPathFirst(failing, () => resolveRecordedBeadsDb(recorded));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.reason).toContain('exited 4');
  });
});

// ---------------------------------------------------------------------------
// The readers
// NEGATIVE CONTROL: put `findBeadsDb(known.beadsDir)` and the old
// `!existsSync(known.checkoutPath) ||` back in resolveSession and the 0.7.6
// tests below go red (checkoutMissing); revert any one reader to findBeadsDb and
// the source scan goes red.
// ---------------------------------------------------------------------------

interface World {
  env: Record<string, string | undefined>;
}

function world(sb: Sandbox): World {
  return {
    env: {
      CLAUDE_CODE_SESSION_ID: SESSION,
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    },
  };
}

/** A session bead and one request in `db`, the way 0.1.37-era sessions left them. */
function seedSession(db: string): {beadId: string; requestId: string} {
  const session = brCreate(
    {db},
    {
      labels: ['session', `sid:${SESSION}`],
      priority: 3,
      status: 'in_progress',
      title: 'An old session',
      type: 'session',
    },
  );
  if (session.kind !== 'ok') throw new Error(session.reason);
  const request = brCreate(
    {db},
    {
      labels: ['request', `sid:${SESSION}`],
      priority: 3,
      status: 'in_progress',
      title: 'An old request',
      type: 'task',
    },
  );
  if (request.kind !== 'ok') throw new Error(request.reason);
  return {beadId: session.id, requestId: request.id};
}

/** The index line a 0.1.37-era session wrote: its worktree's `.beads/`. */
function recordOldSighting(w: World, worktree: string, beadId: string): void {
  const appended = appendSessionSighting(
    {
      at: '2026-10-20T09:00:00.000Z',
      beadId,
      beadsDir: join(worktree, '.beads'),
      branch: 'wt-branch',
      checkoutPath: worktree,
      event: 'created',
      repo: 'repo',
      sessionId: SESSION,
    },
    w.env,
  );
  if (appended.kind !== 'appended') throw new Error(appended.error);
}

describe('readers of the sessions index resolve old worktree entries', () => {
  with076(
    'br 0.7.6: a fresh worktree files its session bead in the primary DB, and finds it after the worktree is gone',
    () => {
      with076Br(() => {
        const sb = sandbox();
        const w = world(sb);
        const repo = repoWithWorktree(sb);
        const filed = ensureSessionBead({
          cwd: repo.worktree,
          env: w.env,
          firstPrompt: {at: '2026-10-26T09:00:00.000Z', text: 'Do the thing'},
          now: new Date('2026-10-26T09:00:01.000Z'),
          sessionId: SESSION,
        });
        expect(filed.kind).toBe('created');
        const read = readSessionSightings(SESSION, w.env);
        expect(read.kind).toBe('read');
        if (read.kind !== 'read') return;
        expect(read.sightings[0]).toMatchObject({
          beadsDir: join(repo.primary, '.beads'),
          branch: 'wt-branch',
          checkoutPath: repo.worktree,
        });
        expect(resolveSession({env: w.env, sessionId: SESSION})).toMatchObject({
          db: repo.primaryDb,
          kind: 'found',
        });
        git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
        expect(resolveSession({env: w.env, sessionId: SESSION})).toMatchObject({
          checkoutPath: repo.worktree,
          db: repo.primaryDb,
          kind: 'found',
        });
      });
    },
  );

  with076(
    'br 0.7.6: an OLD index entry naming a worktree with no DB reaches the primary DB, alive and gone',
    () => {
      with076Br(() => {
        const sb = sandbox();
        const w = world(sb);
        const repo = repoWithWorktree(sb);
        const seeded = seedSession(repo.primaryDb);
        recordOldSighting(w, repo.worktree, seeded.beadId);
        const index = readFileSync(sessionIndexPath(w.env), 'utf8');

        for (const phase of ['alive', 'gone'] as const) {
          if (phase === 'gone') {
            git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
          }
          const found = resolveSession({env: w.env, sessionId: SESSION});
          expect({phase, ...found}).toMatchObject({
            beadsDir: join(repo.worktree, '.beads'),
            db: repo.primaryDb,
            kind: 'found',
            phase,
          });
          if (found.kind !== 'found') continue;
          expect(found.bead.id).toBe(seeded.beadId);
          const requests = sessionBeadsLabelled(
            found,
            {all: true, label: 'request'},
            w.env,
          );
          expect({phase, problems: requests.problems}).toEqual({
            phase,
            problems: [],
          });
          expect(requests.issues.map((entry) => entry.issue.id)).toEqual([
            seeded.requestId,
          ]);
          expect(locateSessionBead(seeded.beadId, w.env, [])).toMatchObject({
            db: repo.primaryDb,
            kind: 'found',
          });
        }
        // Resolved at read time: the index itself is never rewritten.
        expect(readFileSync(sessionIndexPath(w.env), 'utf8')).toBe(index);
      });
    },
  );

  with0137(
    'br 0.1.37: the same old entry stays checkoutMissing once its worktree DB is gone',
    () => {
      with0137Br(() => {
        const sb = sandbox();
        const w = world(sb);
        const repo = repoWithWorktree(sb);
        const seeded = seedSession(repo.primaryDb);
        recordOldSighting(w, repo.worktree, seeded.beadId);
        expect(resolveSession({env: w.env, sessionId: SESSION})).toMatchObject({
          beadId: seeded.beadId,
          kind: 'checkoutMissing',
        });
        expect(locateSessionBead(seeded.beadId, w.env, [])).toMatchObject({
          kind: 'notFound',
          searched: [],
        });
        git(repo.primary, ['worktree', 'remove', '--force', repo.worktree]);
        expect(resolveSession({env: w.env, sessionId: SESSION}).kind).toBe(
          'checkoutMissing',
        );
      });
    },
  );

  test('every reader of a sessions-index beadsDir opens it through resolveRecordedBeadsDb', () => {
    // findBeadsDb on a recorded directory is the old, worktree-blind lookup.
    // It may appear only in br.ts (where the resolver is built from it) and in
    // session-line.ts, whose files-only check is on the cwd's checkout, not on
    // an index entry (see the dispatch report for home-base-dj5m9.1.1).
    const src = join(import.meta.dir, '..', 'src');
    const allowed = new Set(['beads/br.ts', 'thread/session-line.ts']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = relative(src, path);
        if (allowed.has(rel)) continue;
        if (/\bfindBeadsDb\s*\(/.test(readFileSync(path, 'utf8'))) {
          offenders.push(rel);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
    // And the readers named in home-base-dj5m9.1.1 do use the resolver.
    for (const rel of [
      'thread/session-answer.ts',
      'thread/session-bead.ts',
      'thread/session-handoff.ts',
      'thread/session-select.ts',
      'thread/session-stage.ts',
    ]) {
      expect({
        rel,
        uses: readFileSync(join(src, rel), 'utf8').includes(
          'resolveRecordedBeadsDb(',
        ),
      }).toEqual({rel, uses: true});
    }
  });
});
