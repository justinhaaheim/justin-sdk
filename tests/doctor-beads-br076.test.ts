/**
 * doctor's BR and BR_DB checks under br 0.7.6 (home-base-dj5m9.1.3, step 2c/2d
 * of the br 0.7.6 plan in home-base-pp1vx.1.1).
 *
 * BR_DB used to check `<root>/.beads/beads.db` and offer `br init`. From br
 * 0.4.1 on a linked worktree uses the PRIMARY checkout's DB, so that was a
 * false failure in every worktree, and its fix created a DB of the worktree's
 * own, which br 0.7.6 then prefers over the primary's (measured here, below).
 * BR compared the installed br with versions.json, so a repo that had moved to
 * a newer br was told to go back.
 *
 * Real git and real br in throwaway repos under $TMPDIR, as in
 * beads-worktree-db.test.ts: the 0.7.6 tests put mise's installed 0.7.6 first on
 * PATH for their own run, the 0.1.37 tests mise's installed 0.1.37, whatever
 * home-base pins (home-base-dj5m9.1.4), and each skips loudly when its br is
 * not installed. Fake brs
 * (a shell script first on PATH) stand in where a test needs a br that fails
 * or reports a version no real br has. Nothing here touches a real repo.
 *
 * NEGATIVE CONTROLS: each describe block names the source change that turns
 * it red; the dispatch report for home-base-dj5m9.1.3 records each run.
 */

import type {CheckResult} from '../src/check-runner';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join, resolve} from 'path';

import {runBr} from '../src/beads/br';
import {stripAnsi} from '../src/check-runner';
import {
  brDbCheckResult,
  brVersionCheckResult,
  renderDoctor,
} from '../src/doctor';
import {getPinnedToolVersion} from '../src/setup-helpers';
import {addLinkedWorktree, git, initRepo} from './git-fixtures';
import {installedBr, needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const BR_076 = installedBr('0.7.6');
if (BR_076.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.7.6 tests in doctor-beads-br076.test.ts cannot run (${BR_076.reason})`,
  );
}
const with076 = test.skipIf(BR_076.kind !== 'installed');

const BR_0137 = installedBr('0.1.37');
if (BR_0137.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.1.37 tests in doctor-beads-br076.test.ts cannot run (${BR_0137.reason})`,
  );
}
const with0137 = test.skipIf(BR_0137.kind !== 'installed');
const withBoth = test.skipIf(
  BR_0137.kind !== 'installed' || BR_076.kind !== 'installed',
);

/** versions.json's pin, read the way doctor reads it. */
const SDK_PIN = getPinnedToolVersion('beads_rust');
if (SDK_PIN == null) throw new Error('versions.json pins no beads_rust');

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
async function withPathFirst<T>(
  dir: string,
  fn: () => T | Promise<T>,
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

async function with076Br<T>(fn: () => T | Promise<T>): Promise<T> {
  if (BR_076.kind !== 'installed') throw new Error(BR_076.reason);
  return await withPathFirst(BR_076.dir, fn);
}

async function with0137Br<T>(fn: () => T | Promise<T>): Promise<T> {
  if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
  return await withPathFirst(BR_0137.dir, fn);
}

/**
 * A directory holding a fake `br`: `--version` prints `br <version>`; `list`
 * prints `listOut` to stdout and exits `listCode`; anything else exits 0.
 */
function fakeBrDir(
  sb: Sandbox,
  options: {
    listCode?: number;
    listOut?: string;
    version: string;
    versionCode?: number;
  },
): string {
  const dir = join(sb.path, `fake-br-${readdirSync(sb.path).length}`);
  mkdirSync(dir, {recursive: true});
  const listOut = (options.listOut ?? '').replaceAll("'", '');
  writeFileSync(
    join(dir, 'br'),
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo 'br ${options.version}'; exit ${options.versionCode ?? 0}; fi`,
      `if [ "$1" = "list" ]; then printf '%s\\n' '${listOut}'; exit ${options.listCode ?? 0}; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'br'), 0o755);
  return dir;
}

/** The SYNC_CONFLICT body br 0.7.6 prints (measured 2026-10-26), shortened. */
const SYNC_CONFLICT_BODY = JSON.stringify({
  error: {
    code: 'SYNC_CONFLICT',
    message:
      'Sync conflict: engine recovery refused before opening: WAL contains frames that may hold committed, uncheckpointed changes',
  },
});

const DOCTOR_CONFIG = {components: ['beads-setup']};

interface Repo {
  primary: string;
  primaryDb: string;
  worktree: string;
}

/**
 * A committed repo with a br workspace and a linked worktree at
 * `<primary>/.claude/worktrees/wt`, as Claude Code makes them. `.beads/` is
 * committed (br's own .gitignore keeps `*.db` out), so the worktree has a
 * `.beads/` and no DB. Run with the br under test first on PATH: `br init`
 * writes that br's schema. `misePin` is committed as the repo's mise.toml.
 */
function repoWithWorktree(
  sb: Sandbox,
  options: {beads?: boolean; misePin?: string} = {},
): Repo {
  const files: Record<string, string> = {
    'README.md': '# repo\n',
    'justin-sdk.config.json': `${JSON.stringify(DOCTOR_CONFIG)}\n`,
  };
  if (options.misePin != null) {
    files['mise.toml'] =
      `[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "${options.misePin}", exe = "br" }\n`;
  }
  const primary = initRepo(sb, 'repo', files);
  if (options.beads !== false) {
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
  return {primary, primaryDb: join(primary, '.beads', 'beads.db'), worktree};
}

/** Every string a CheckResult could show or run. */
function adviceText(result: CheckResult): string {
  return [result.message ?? '', result.fix ?? '', result.fixCommand ?? ''].join(
    '\n',
  );
}

/** The BR_DB line of a rendered doctor report, and the lines under it. */
function brDbSection(report: string): string {
  const lines = stripAnsi(report).split('\n');
  const start = lines.findIndex((line) => line.includes('BR_DB'));
  if (start === -1) throw new Error(`no BR_DB line in:\n${report}`);
  return lines.slice(start, start + 4).join('\n');
}

// ---------------------------------------------------------------------------
// AC1: a linked worktree with no DB under br 0.7.6 passes on the primary's
// NEGATIVE CONTROL: put back the old BR_DB body (`existsSync(.beads/beads.db)`
// → `br init`) and these go red on `pass` and on the `br init` assertions.
// ---------------------------------------------------------------------------

describe('BR_DB finds the database the way br does', () => {
  with076(
    'br 0.7.6, linked worktree with no DB: BR_DB passes on the primary checkout DB, and nothing says br init',
    async () => {
      await with076Br(async () => {
        const repo = repoWithWorktree(sandbox(), {misePin: '0.7.6'});
        expect(existsSync(join(repo.worktree, '.beads', 'beads.db'))).toBe(
          false,
        );

        const result = brDbCheckResult(repo.worktree);
        expect(result.pass).toBe(true);
        expect(result.message).toContain(repo.primaryDb);
        expect(result.message).toContain('br 0.7.6 shares');
        expect(adviceText(result)).not.toContain('br init');

        // The whole doctor run, as a session start sees it. BR passes too: the
        // repo pins 0.7.6, at or above versions.json, so it is not told to go
        // back. (A BR warning would not hide BR_DB: check-runner skips
        // children only under an error-severity failure.)
        const run = await renderDoctor(repo.worktree, {});
        expect(stripAnsi(run.report)).toMatch(/✓ BR \[\d+ms\]\n\s+br 0\.7\.6/);
        const section = brDbSection(run.report);
        expect(section).toContain('✓ BR_DB');
        expect(stripAnsi(run.report)).not.toContain('br init');
        // Doctor read; it did not create a DB in the worktree.
        expect(existsSync(join(repo.worktree, '.beads', 'beads.db'))).toBe(
          false,
        );
      });
    },
  );

  with0137(
    'br 0.1.37, linked worktree with no DB: passes, says br makes it on first use, offers no br init, creates nothing',
    async () => {
      await with0137Br(() => {
        const repo = repoWithWorktree(sandbox());
        const before = readdirSync(join(repo.worktree, '.beads')).sort();

        const result = brDbCheckResult(repo.worktree);
        expect(result.pass).toBe(true);
        expect(result.message).toContain('keeps one per worktree');
        expect(adviceText(result)).not.toContain('br init');
        expect(result.fixCommand).toBeUndefined();
        expect(readdirSync(join(repo.worktree, '.beads')).sort()).toEqual(
          before,
        );
      });
    },
  );

  with076(
    'br 0.7.6, linked worktree whose primary has no DB either: fails, and says to set beads up in the primary, never br init here',
    async () => {
      await with076Br(() => {
        const sb = sandbox();
        const repo = repoWithWorktree(sb, {beads: false, misePin: '0.7.6'});
        mkdirSync(join(repo.worktree, '.beads'), {recursive: true});

        const result = brDbCheckResult(repo.worktree);
        expect(result.pass).toBe(false);
        expect(result.fixCommand).toBeUndefined();
        expect(result.fix).toContain(`the primary checkout (${repo.primary})`);
        expect(result.fix).toContain('do not run `br init` here');
        expect(result.fix).toContain('br 0.7.6 would use it instead');
      });
    },
  );

  test('the PRIMARY checkout with no DB keeps the old result, br init included', () => {
    const sb = sandbox();
    const primary = initRepo(sb, 'plain', {'README.md': '# plain\n'});
    const result = brDbCheckResult(primary);
    expect(result).toEqual({
      fix: 'Run: br init',
      fixCommand: 'br init',
      message: '.beads/beads.db not found — beads not initialized',
      pass: false,
    });
  });
});

// ---------------------------------------------------------------------------
// home-base-q7c7: the PRIMARY checkout of a fresh clone with a committed .beads/
// NEGATIVE CONTROL: make missingBeadsDbResult return the old primary result
// (`br init`) for every primary checkout, and the AC1 test goes red on the
// rendered BR_DB line (`✗ BR_DB`, `Fix: Run: br init`) and the AC2 test on the
// logged `br init`. Each other test names its own break.
// ---------------------------------------------------------------------------

/**
 * The primary checkout of a fresh local clone of a repo whose `.beads/` is
 * committed: what a remote session or a new machine starts from. The origin's
 * workspace is made by the br first on PATH (`br init`, then one `br create`
 * per title) and committed; br's own .gitignore keeps the database out, so the
 * clone has `.beads/` and no database.
 */
function freshCloneWithBeads(
  sb: Sandbox,
  titles: string[],
): {clone: string; origin: string} {
  const origin = initRepo(sb, 'origin', {
    'README.md': '# origin\n',
    'justin-sdk.config.json': `${JSON.stringify(DOCTOR_CONFIG)}\n`,
  });
  const init = runBr(origin, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  for (const title of titles) {
    const created = runBr(origin, ['create', title, '-q']);
    if (!created.ok) {
      throw new Error(`br create failed: ${created.reason ?? '?'}`);
    }
  }
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-qm', 'beads']);
  const clone = join(sb.path, 'clone');
  git(sb.path, ['clone', '-q', origin, clone]);
  return {clone, origin};
}

/**
 * The same shape without a br: `.beads/` files written by hand, committed, and
 * cloned. For the tests that run a fake br, or none.
 */
function freshCloneWithFiles(
  sb: Sandbox,
  beadsFiles: Record<string, string>,
): string {
  const origin = initRepo(sb, 'origin', {
    'README.md': '# origin\n',
    'justin-sdk.config.json': `${JSON.stringify(DOCTOR_CONFIG)}\n`,
    ...beadsFiles,
  });
  const clone = join(sb.path, 'clone');
  git(sb.path, ['clone', '-q', origin, clone]);
  return clone;
}

/**
 * A logging `br` for asserting what doctor EXECUTED, not its exit code. Each
 * call appends `<cwd>\t<args>` to a log. `init` is recorded and never run, so a
 * regression that reaches `br init` writes nothing anywhere, whatever the cwd;
 * every other call runs `realBr`.
 */
function loggingBr(
  sb: Sandbox,
  realBr: string,
): {calls: () => {args: string; cwd: string}[]; dir: string} {
  const dir = join(sb.path, 'logging-br');
  mkdirSync(dir, {recursive: true});
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'br'),
    [
      '#!/bin/sh',
      `printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${log}'`,
      'if [ "$1" = "init" ]; then exit 0; fi',
      `exec '${realBr}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'br'), 0o755);
  return {
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => {
              const [cwd = '', args = ''] = line.split('\t');
              return {args, cwd};
            })
        : [],
    dir,
  };
}

/** Was this logged br call an `init`? */
function isInit(call: {args: string}): boolean {
  return /(^|\s)init(\s|$)/.test(call.args);
}

/** `br` as a person types it. `runBr` appends `--no-auto-import`, so not that. */
function plainBr(
  cwd: string,
  args: string[],
): {status: number | null; stdout: string} {
  const proc = spawnSync('br', args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  return {status: proc.status, stdout: proc.stdout ?? ''};
}

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

/**
 * `justin-sdk doctor --fix --yes`, as setup-env runs it in a remote session, in
 * a subprocess started in `cwd` with `pathFirst` first on PATH.
 *
 * A subprocess, not `renderDoctor`, for two reasons. check-runner spawns a
 * fixCommand with `Bun.spawn` and no `env`, which hands the child the
 * environment Bun STARTED with: a br put first on `process.env.PATH` at run
 * time never sees the fix (measured 2026-11-07 on Bun 1.4.2, home-base-q7c7;
 * an in-process control run logged no `br init` while the startup PATH's real
 * br initialised the fixture). And the fix runs in `process.cwd()`, which
 * in-process is the SDK checkout.
 */
function doctorFixCli(
  cwd: string,
  pathFirst: string,
): {out: string; status: number | null} {
  const proc = spawnSync(process.execPath, [CLI, 'doctor', '--fix', '--yes'], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${pathFirst}${delimiter}${process.env.PATH ?? ''}`,
    },
    timeout: 120_000,
  });
  return {
    out: stripAnsi(`${proc.stdout ?? ''}${proc.stderr ?? ''}`),
    status: proc.status,
  };
}

describe('BR_DB in the primary checkout of a fresh clone (home-base-q7c7)', () => {
  with0137(
    'premise: br 0.1.37 creates the database on first use there and imports every committed issue',
    async () => {
      await with0137Br(() => {
        const sb = sandbox();
        const {clone, origin} = freshCloneWithBeads(sb, [
          'one',
          'two',
          'three',
        ]);
        const committed = readFileSync(
          join(clone, '.beads', 'issues.jsonl'),
          'utf8',
        )
          .split('\n')
          .filter((line) => line !== '');
        expect(committed).toHaveLength(3);
        const db = join(clone, '.beads', 'beads.db');
        expect(existsSync(db)).toBe(false);

        const list = plainBr(clone, ['list', '--json']);
        expect(list.status).toBe(0);
        expect(existsSync(db)).toBe(true);
        const listed = JSON.parse(list.stdout) as {issues: unknown[]};
        expect(listed.issues).toHaveLength(3);

        // --no-auto-import too: the database is made from the export either way.
        const second = join(sb.path, 'clone-no-auto-import');
        git(sb.path, ['clone', '-q', origin, second]);
        const quiet = plainBr(second, ['list', '--json', '--no-auto-import']);
        expect(quiet.status).toBe(0);
        expect(
          (JSON.parse(quiet.stdout) as {issues: unknown[]}).issues,
        ).toHaveLength(3);
      });
    },
  );

  with0137(
    'AC1: br 0.1.37, committed .beads/ and no DB: BR_DB passes, no fixCommand, nothing says br init, doctor creates nothing',
    async () => {
      await with0137Br(async () => {
        const sb = sandbox();
        const {clone} = freshCloneWithBeads(sb, ['one']);
        expect(existsSync(join(clone, '.beads', 'beads.db'))).toBe(false);
        expect(existsSync(join(clone, '.beads', 'issues.jsonl'))).toBe(true);
        const before = readdirSync(join(clone, '.beads')).sort();

        // The rendered report first, so the negative control shows the line.
        const run = await renderDoctor(clone, {});
        const section = brDbSection(run.report);
        expect(section).toContain('✓ BR_DB');
        expect(section).toContain(
          'br 0.1.37 creates it from the committed .beads/ on first use',
        );
        expect(stripAnsi(run.report)).not.toContain('br init');

        const result = brDbCheckResult(clone);
        expect(result.pass).toBe(true);
        expect(result.fixCommand).toBeUndefined();
        expect(adviceText(result)).not.toContain('br init');
        expect(readdirSync(join(clone, '.beads')).sort()).toEqual(before);
      });
    },
  );

  with0137(
    'AC2: doctor --fix --yes there runs no br init, by what a logging br shim recorded',
    async () => {
      if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
      const sb = sandbox();
      const {clone} = await with0137Br(() => freshCloneWithBeads(sb, ['one']));
      const shim = loggingBr(sb, BR_0137.path);

      const run = doctorFixCli(clone, shim.dir);

      const calls = shim.calls();
      // The shim was the br doctor ran, in this clone.
      expect(calls.some((call) => call.cwd === clone)).toBe(true);
      expect(calls.filter(isInit)).toEqual([]);
      expect(run.out).not.toContain('→ BR_DB');
      expect(run.out).toContain('✓ BR_DB');
      expect(existsSync(join(clone, '.beads', 'beads.db'))).toBe(false);
    },
  );

  with0137(
    'AC2 CONTROL: the same shim records br init when doctor --fix --yes runs in a repo with no .beads/',
    () => {
      if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
      const sb = sandbox();
      const repo = initRepo(sb, 'plain', {
        'README.md': '# plain\n',
        'justin-sdk.config.json': `${JSON.stringify(DOCTOR_CONFIG)}\n`,
      });
      const shim = loggingBr(sb, BR_0137.path);

      const run = doctorFixCli(repo, shim.dir);

      const inits = shim.calls().filter(isInit);
      expect(inits.length).toBeGreaterThan(0);
      expect(inits.every((call) => call.cwd === repo)).toBe(true);
      expect(run.out).toContain('→ BR_DB: br init');
    },
  );

  // NEGATIVE CONTROL: return a pass when the version is `failed` and this goes
  // red on `pass`/`severity`.
  test('AC4: br version unreadable there: an UNKNOWN warn with no fixCommand, never a pass', async () => {
    const sb = sandbox();
    const clone = freshCloneWithFiles(sb, {
      '.beads/config.yaml': 'issue_prefix: t\n',
      '.beads/issues.jsonl': '',
    });
    const broken = fakeBrDir(sb, {version: '?', versionCode: 3});

    await withPathFirst(broken, () => {
      const result = brDbCheckResult(clone);
      expect(result.pass).toBe(false);
      expect(result.severity).toBe('warn');
      expect(result.message?.startsWith('UNKNOWN:')).toBe(true);
      expect(result.message).toContain('could not be read');
      expect(result.fixCommand).toBeUndefined();
    });
  });

  // NEGATIVE CONTROL: drop the `brSharesWorktreeDb` branch (pass on any read
  // version) and this goes red on `pass`.
  test('a br that shares one database across worktrees (a fake 0.7.6) there: a WARN naming br list, no fixCommand', async () => {
    const sb = sandbox();
    const clone = freshCloneWithFiles(sb, {
      '.beads/config.yaml': 'issue_prefix: t\n',
      '.beads/issues.jsonl': '',
    });
    const fake = fakeBrDir(sb, {version: '0.7.6'});

    await withPathFirst(fake, () => {
      const result = brDbCheckResult(clone);
      expect(result.pass).toBe(false);
      expect(result.severity).toBe('warn');
      expect(result.fixCommand).toBeUndefined();
      expect(result.message).toContain('not on br 0.7.6');
      expect(result.fix).toContain('Run `br list` here once');
      expect(result.fix).toContain('Do not run `br init`');
    });
  });

  // NEGATIVE CONTROL: give the `legacy` branch `fixCommand: 'br init'` and
  // this goes red on `fixCommand`.
  test('AC5: a .beads/ holding neither a database nor a tracked artifact: red, the reason named, no fixCommand', () => {
    const sb = sandbox();
    const clone = freshCloneWithFiles(sb, {'.beads/notes.txt': 'not beads\n'});

    const result = brDbCheckResult(clone);
    expect(result.pass).toBe(false);
    expect(result.severity).toBeUndefined();
    expect(result.fixCommand).toBeUndefined();
    expect(result.message).toContain(
      '.beads/ exists with neither a database nor a tracked config',
    );
  });

  test('a Dolt (bd) workspace with a config.yaml: classified legacy, not a fresh clone, so no pass and no fixCommand', () => {
    const sb = sandbox();
    const clone = freshCloneWithFiles(sb, {
      '.beads/config.yaml': 'issue_prefix: t\n',
      '.beads/metadata.json': '{"backend": "dolt"}\n',
    });

    const result = brDbCheckResult(clone);
    expect(result.pass).toBe(false);
    expect(result.fixCommand).toBeUndefined();
    expect(result.message).toContain('old Dolt (bd) backend');
  });

  // NEGATIVE CONTROL: remove the `.beads/beads.db` guard in
  // primaryMissingDbResult and detectBeadsWorkspace runs `br list` (which
  // imports); the logged `list` call turns this red.
  test('a directory that is not a git checkout, with a .beads/beads.db: red, no fixCommand, and no br list run', async () => {
    const sb = sandbox();
    const dir = join(sb.path, 'not-git');
    mkdirSync(join(dir, '.beads'), {recursive: true});
    writeFileSync(join(dir, '.beads', 'beads.db'), '');
    const fake = fakeBrDir(sb, {version: SDK_PIN});
    const shim = loggingBr(sb, join(fake, 'br'));

    const result = await withPathFirst(shim.dir, () => brDbCheckResult(dir));
    expect(
      shim.calls().filter((call) => /(^|\s)list(\s|$)/.test(call.args)),
    ).toEqual([]);
    expect(result.pass).toBe(false);
    expect(result.fixCommand).toBeUndefined();
    expect(result.message).toContain(
      `${join(dir, '.beads', 'beads.db')} exists`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: a linked worktree's own DB shadows the primary's under a sharing br
// NEGATIVE CONTROL: make worktreeDbShadowResult return null and the 0.7.6 test
// goes red on `pass`/`severity`; the 0.1.37 test is the in-file control.
// ---------------------------------------------------------------------------

describe('BR_DB warns when a worktree DB shadows the primary one', () => {
  with076(
    'br 0.7.6: a worktree that ran br init has its own DB, br uses it, and BR_DB WARNS that it shadows the primary DB',
    async () => {
      await with076Br(() => {
        const repo = repoWithWorktree(sandbox(), {misePin: '0.7.6'});
        // What the old doctor advice did: `br init` in the worktree. br 0.7.6
        // makes a DB there and uses it from then on (measured: `br where`).
        const init = runBr(repo.worktree, ['init', '--prefix', 't', '-q']);
        expect(init.ok).toBe(true);
        const own = join(repo.worktree, '.beads', 'beads.db');
        expect(existsSync(own)).toBe(true);
        const where = runBr(repo.worktree, ['where']);
        expect(where.stdout).toContain(`database: ${own}`);

        const result = brDbCheckResult(repo.worktree);
        expect(result.pass).toBe(false);
        expect(result.severity).toBe('warn');
        expect(result.message).toContain(own);
        expect(result.message).toContain(
          `It shadows the primary checkout's ${repo.primaryDb}`,
        );
        expect(result.fixCommand).toBeUndefined();
        expect(result.fix).toContain('never delete');
      });
    },
  );

  with0137(
    'br 0.1.37: a worktree with its own DB is normal (one DB per worktree), so no warning',
    async () => {
      await with0137Br(() => {
        const repo = repoWithWorktree(sandbox());
        const init = runBr(repo.worktree, ['init', '--prefix', 't', '-q']);
        expect(init.ok).toBe(true);

        const result = brDbCheckResult(repo.worktree);
        expect(result).toEqual({pass: true});
      });
    },
  );

  test('an unreadable br version in a worktree with its own DB is an UNKNOWN warn, never "not shared"', async () => {
    const sb = sandbox();
    // Build with the pinned br, then read the version with a br that fails.
    needBr();
    const repo = repoWithWorktree(sb);
    const init = runBr(repo.worktree, ['init', '--prefix', 't', '-q']);
    expect(init.ok).toBe(true);
    const broken = fakeBrDir(sb, {version: '?', versionCode: 3});

    await withPathFirst(broken, () => {
      const result = brDbCheckResult(repo.worktree);
      expect(result.pass).toBe(false);
      expect(result.severity).toBe('warn');
      expect(result.message).toContain('UNKNOWN');
      expect(result.message).toContain('could not be read');
    });
  });
});

// ---------------------------------------------------------------------------
// br list failures: no `br doctor --fix`, and exit 6 named
// NEGATIVE CONTROL: put back `fixCommand: 'br doctor --fix'` and the
// fixCommand assertions go red.
// ---------------------------------------------------------------------------

describe('BR_DB advice when br list fails', () => {
  test("a fake br that exits 6: SYNC_CONFLICT is named, the advice is br's own (no rebuild), and nothing is auto-run", async () => {
    const sb = sandbox();
    const primary = initRepo(sb, 'repo', {'README.md': '# r\n'});
    mkdirSync(join(primary, '.beads'));
    writeFileSync(join(primary, '.beads', 'beads.db'), 'not read by the fake');
    const fake = fakeBrDir(sb, {
      listCode: 6,
      listOut: SYNC_CONFLICT_BODY,
      version: '0.7.6',
    });

    await withPathFirst(fake, () => {
      const result = brDbCheckResult(primary);
      expect(result.pass).toBe(false);
      expect(result.fixCommand).toBeUndefined();
      expect(result.message).toContain('br list exited 6: SYNC_CONFLICT');
      expect(result.message).toContain('Exit 6 is SYNC_CONFLICT');
      expect(result.fix).toContain('Do not repair, rebuild or move');
      expect(adviceText(result)).not.toContain('br doctor --fix');
    });
  });

  test('any other failure: the advice names the version differences and runs nothing', async () => {
    const sb = sandbox();
    const primary = initRepo(sb, 'repo', {'README.md': '# r\n'});
    mkdirSync(join(primary, '.beads'));
    writeFileSync(join(primary, '.beads', 'beads.db'), '');
    const fake = fakeBrDir(sb, {listCode: 3, version: SDK_PIN});

    await withPathFirst(fake, () => {
      const result = brDbCheckResult(primary);
      expect(result.pass).toBe(false);
      expect(result.fixCommand).toBeUndefined();
      expect(result.message).toContain('br list exited 3');
      expect(result.message).not.toContain('SYNC_CONFLICT');
      expect(result.fix).toContain(
        'br 0.1.37 spells it `--repair` and has no `--fix`',
      );
      expect(result.fix).toContain("repairs the PRIMARY checkout's database");
    });
  });

  withBoth(
    'real brs: a br 0.1.37 DB holding WAL frames, read by br 0.7.6, is exit 6 and gets the SYNC_CONFLICT advice',
    async () => {
      const sb = sandbox();
      const primary = initRepo(sb, 'repo', {'README.md': '# r\n'});
      // br 0.1.37 writes the DB and leaves its WAL (measured).
      await with0137Br(() => {
        const init = runBr(primary, ['init', '--prefix', 't', '-q']);
        expect(init.ok).toBe(true);
        const create = runBr(primary, ['create', 'one', '-q']);
        expect(create.ok).toBe(true);
      });
      expect(existsSync(join(primary, '.beads', 'beads.db-wal'))).toBe(true);

      await with076Br(() => {
        const result = brDbCheckResult(primary);
        expect(result.pass).toBe(false);
        expect(result.message).toContain('br list exited 6: SYNC_CONFLICT');
        expect(result.fixCommand).toBeUndefined();
        expect(result.fix).toContain('Do not repair, rebuild or move');
      });
    },
  );
});

// ---------------------------------------------------------------------------
// AC3 (doctor half): a repo pinned above versions.json is never pulled down
// NEGATIVE CONTROL: make brExpectation ignore `order.kind === 'above'` (always
// expect the SDK pin) and the "above" tests go red; the "below" test is the
// in-file control that the old behaviour stands.
// ---------------------------------------------------------------------------

/** A version above any SDK pin this suite will meet. */
const ABOVE = '99.0.0';

function pinnedProject(sb: Sandbox, pin: string): string {
  const root = initRepo(sb, `pin-${pin.replaceAll('.', '-')}`, {
    'mise.toml': `[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "${pin}", exe = "br" }\n`,
  });
  return root;
}

describe('BR never pulls a repo pinned above versions.json down', () => {
  test('repo pins a br newer than the SDK and runs it: BR passes with an info line', async () => {
    const sb = sandbox();
    const root = pinnedProject(sb, ABOVE);
    await withPathFirst(fakeBrDir(sb, {version: ABOVE}), () => {
      const result = brVersionCheckResult(root);
      expect(result.pass).toBe(true);
      expect(result.message).toContain(`this repo pins ${ABOVE}`);
      expect(result.message).toContain(`newer than the SDK's ${SDK_PIN}`);
      expect(result.message).toContain('never pulls a pin down');
    });
  });

  test("repo pins a newer br but runs the SDK's: the mismatch is against the repo's pin, not versions.json", async () => {
    const sb = sandbox();
    const root = pinnedProject(sb, ABOVE);
    await withPathFirst(fakeBrDir(sb, {version: SDK_PIN}), () => {
      const result = brVersionCheckResult(root);
      expect(result.pass).toBe(false);
      expect(result.severity).toBe('warn');
      expect(result.message).toBe(
        `Version mismatch: expected ${ABOVE} (from mise.toml), got ${SDK_PIN}`,
      );
    });
  });

  test("repo pins a newer br and has none installed: the download advice names the repo's version", async () => {
    const sb = sandbox();
    const root = pinnedProject(sb, ABOVE);
    await withPathFirst(fakeBrDir(sb, {version: '', versionCode: 127}), () => {
      const result = brVersionCheckResult(root);
      expect(result.pass).toBe(false);
      expect(result.fixCommand).toContain(`--version v${ABOVE}`);
      expect(result.fixCommand).not.toContain(`v${SDK_PIN}`);
    });
  });

  test('CONTROL: a repo pinned BELOW the SDK keeps the old warning against versions.json', async () => {
    const sb = sandbox();
    const root = pinnedProject(sb, '0.0.1');
    await withPathFirst(fakeBrDir(sb, {version: '0.0.1'}), () => {
      const result = brVersionCheckResult(root);
      expect(result).toEqual({
        fix: 'Run: mise install',
        fixCommand: 'mise install',
        message: `Version mismatch: expected ${SDK_PIN} (from versions.json), got 0.0.1`,
        pass: false,
        severity: 'warn',
      });
    });
  });

  test('a pin that cannot be ordered (latest) gets no direct-download advice', async () => {
    const sb = sandbox();
    const root = pinnedProject(sb, 'latest');
    await withPathFirst(fakeBrDir(sb, {version: '', versionCode: 127}), () => {
      const result = brVersionCheckResult(root);
      expect(result.pass).toBe(false);
      expect(result.fixCommand).toBe('mise install');
    });
  });
});
