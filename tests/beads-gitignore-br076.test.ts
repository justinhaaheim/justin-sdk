/**
 * beads-setup makes both ignore files cover br 0.7.6's local files
 * (home-base-dj5m9.1.5, item 5).
 *
 * `.beads/.gitignore` is written once, by the `br init` that made the
 * workspace. br 0.7.6 leaves five sidecars beside its DB that a 0.1.37-made
 * file does not ignore, and `br doctor --repair` writes `.doctor/` at the repo
 * root (measured with `bun run measure:br-local-files`; the list is on
 * `BR076_BEADS_IGNORE_ENTRIES`). `ensureBeadsGitignores` adds them to the ROOT
 * `.gitignore` as `.beads/<pattern>`, because beads-setup never changes a
 * committed `.beads/`; these tests prove it on the files alone, on a real
 * 0.1.37 workspace used by a real 0.7.6, and through `runBeadsSetup`.
 *
 * Every repo is under $TMPDIR; nothing here touches a real beads DB.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.5): drop
 * `'*-fsqlite-ns-gate'` from BR076_BEADS_IGNORE_ENTRIES and the 0.7.6 test
 * fails with `.beads/beads.db-fsqlite-ns-gate` in the untracked list.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  BR076_BEADS_IGNORE_ENTRIES,
  BR076_ROOT_IGNORE_ENTRIES,
  ensureBeadsGitignores,
  runBeadsSetup,
} from '../src/beads-setup';
import {git, initRepo} from './git-fixtures';
import {installedBr, needBr} from './pinned-br';
import {createProjectSandbox, createSandbox} from './sandbox';

/** A test-data marker for the bead titles (test-data-marker rule). */
const TAG = '[TEST_DATA_DELETABLE c3544428-ba57-47be-a2ea-134a46f1ef9b ]';

/** The database half of the `.beads/.gitignore` br 0.1.37's `br init` wrote. */
const OLD_BEADS_GITIGNORE =
  '# Database\n*.db\n*.db-journal\n*.db-shm\n*.db-wal\n\n# Lock files\n*.lock\n';

const BR_0137 = installedBr('0.1.37');
const BR_076 = installedBr('0.7.6');
const BOTH_BRS = BR_0137.kind === 'installed' && BR_076.kind === 'installed';
if (!BOTH_BRS) {
  console.warn(
    `SKIPPED: the br 0.1.37 → 0.7.6 test in beads-gitignore-br076.test.ts did NOT run, so it proves nothing (${BR_0137.kind === 'installed' ? '' : `0.1.37: ${BR_0137.reason}; `}${BR_076.kind === 'installed' ? '' : `0.7.6: ${BR_076.reason}`})`,
  );
}

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function sandbox(make: () => Sandbox = createSandbox): Sandbox {
  const sb = make();
  sandboxes.push(sb);
  return sb;
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf-8').split('\n');
}

describe('ensureBeadsGitignores (files only)', () => {
  test('adds every line to the ROOT .gitignore, once, and never touches .beads/', () => {
    const sb = sandbox();
    sb.writeFile('.beads/.gitignore', OLD_BEADS_GITIGNORE);
    sb.writeFile('.gitignore', 'node_modules/\n');
    expect(ensureBeadsGitignores(sb.path)).toEqual([
      ...BR076_ROOT_IGNORE_ENTRIES,
    ]);
    const root = lines(join(sb.path, '.gitignore'));
    expect(root[0]).toBe('node_modules/');
    for (const pattern of BR076_BEADS_IGNORE_ENTRIES) {
      expect(root).toContain(`.beads/${pattern}`);
    }
    expect(root).toContain('.doctor/');
    // beads-setup never changes a committed .beads/ (home-base-o33r AC2b).
    expect(readFileSync(join(sb.path, '.beads', '.gitignore'), 'utf-8')).toBe(
      OLD_BEADS_GITIGNORE,
    );

    const rootBytes = readFileSync(join(sb.path, '.gitignore'));
    expect(ensureBeadsGitignores(sb.path)).toEqual([]);
    expect(readFileSync(join(sb.path, '.gitignore'))).toEqual(rootBytes);
  });
});

describe('a br 0.1.37 workspace used by br 0.7.6', () => {
  test.skipIf(!BOTH_BRS)(
    'with the lines added, git sees no untracked file and neither ignore file changes, doctor --repair included',
    () => {
      if (BR_0137.kind !== 'installed' || BR_076.kind !== 'installed') {
        throw new Error('unreachable: skipIf guards this');
      }
      const oldBr = BR_0137.path;
      const newBr = BR_076.path;
      const sb = sandbox();
      const repo = initRepo(sb, 'repo', {'README.md': '# repo\n'});
      const br = (bin: string, args: string[]) => {
        const out = spawnSync(bin, args, {cwd: repo, encoding: 'utf-8'});
        // stdout only: 0.7.6's first open says on stderr that it rebuilt
        // the schema-4 DB, which is not part of the id `create` prints.
        return {code: out.status, said: out.stdout.trim()};
      };
      expect(br(oldBr, ['init', '--prefix', 'g', '-q']).code).toBe(0);
      expect(br(oldBr, ['create', `seed ${TAG}`, '--silent']).code).toBe(0);
      ensureBeadsGitignores(repo);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'old br workspace']);
      // The upgrade plan's own step: without it 0.7.6 refuses (exit 6).
      const checkpoint = spawnSync(
        'sqlite3',
        [join(repo, '.beads', 'beads.db'), 'PRAGMA wal_checkpoint(TRUNCATE);'],
        {encoding: 'utf-8'},
      );
      expect(checkpoint.status).toBe(0);

      const created = br(newBr, ['create', `new ${TAG}`, '--silent']);
      expect(created.code).toBe(0);
      expect(br(newBr, ['close', created.said, '--reason', 'probe']).code).toBe(
        0,
      );
      expect(br(newBr, ['sync', '--flush-only']).code).toBe(0);
      // doctor exits 1 on any WARN; its writes are what is measured here.
      br(newBr, ['doctor']);
      const status = () =>
        git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])
          .split('\n')
          .filter((line) => line.trim() !== '');

      // What the ordinary commands left that `git add -A` would commit: none.
      // Checked BEFORE doctor --repair, which appends any missing line itself.
      expect(
        status()
          .filter((line) => line.startsWith('??'))
          .map((line) => line.slice(3)),
      ).toEqual([]);

      expect(br(newBr, ['doctor', '--repair']).code).toBe(0);
      // doctor --repair writes .doctor/ at the root: ignored, and the root
      // .gitignore unchanged. It still appends its lines to .beads/.gitignore,
      // which is the only file it reads (see BR076_ROOT_IGNORE_ENTRIES).
      expect(
        status().filter((line) => !line.endsWith('.beads/.gitignore')),
      ).toEqual([' M .beads/issues.jsonl']);
      // The premise: 0.7.6 really wrote the sidecars and .doctor/.
      expect(existsSync(join(repo, '.beads', 'beads.db-wal-cert'))).toBe(true);
      expect(existsSync(join(repo, '.doctor'))).toBe(true);
    },
    60_000,
  );
});

describe('runBeadsSetup', () => {
  test('adds the br 0.7.6 lines to the root .gitignore (step 8)', async () => {
    needBr();
    const sb = sandbox(createProjectSandbox);
    writeFileSync(join(sb.path, '.gitignore'), 'node_modules/\n');
    const exitCode = await runBeadsSetup({
      noCommit: true,
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);
    const root = lines(join(sb.path, '.gitignore'));
    for (const entry of BR076_ROOT_IGNORE_ENTRIES) {
      expect(root).toContain(entry);
    }
  }, 60_000);
});
