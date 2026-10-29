/**
 * beads-setup under br 0.7.6 (home-base-dj5m9.1.3, step 2c/2d of the br 0.7.6
 * plan in home-base-pp1vx.1.1).
 *
 * Two hazards, each the destructive direction:
 *   1. A failing `br list` on an existing `.beads/beads.db` was classified
 *      `legacy`, and migration then MOVED `.beads/` aside, ran `br init` and
 *      imported the JSONL. br 0.7.6 exits 6 (SYNC_CONFLICT) on a live 0.1.37
 *      database that still holds WAL frames, and says "do not delete or
 *      replace the WAL or rebuild this database from JSONL" (measured
 *      2026-10-26). Now no `br list` failure moves anything.
 *   2. The mise pin step rewrote any pin to versions.json's, so a repo already
 *      on a newer br would be pulled back to the SDK's. Now only a pin BELOW
 *      the SDK's is rewritten.
 *
 * Fake brs are shell scripts first on PATH; the real-br tests use mise's
 * installed 0.1.37 (the writer) and 0.7.6 (the reader) by version, whatever
 * home-base pins (home-base-dj5m9.1.4), skipping loudly when either is not
 * installed. base-setup runs against a local bare remote
 * (`sdkRemoteWithOwnTag`), so nothing here touches the network or a real repo.
 *
 * NEGATIVE CONTROLS: each describe block names the source change that turns
 * it red; the dispatch report for home-base-dj5m9.1.3 records each run.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join} from 'path';

import {runBr} from '../src/beads/br';
import {
  applyBeadsMiseToolPin,
  BEADS_IMPORT_COMMAND,
  BEADS_MISE_TOOL_KEY,
  beadsSetupRefusal,
  compareBrPin,
  detectBeadsWorkspace,
  runBeadsSetup,
} from '../src/beads-setup';
import {exec, getPinnedToolVersion} from '../src/setup-helpers';
import {initRepo, sdkRemoteWithOwnTag} from './git-fixtures';
import {installedBr} from './pinned-br';
import {createProjectSandbox, createSandbox} from './sandbox';

const BR_076 = installedBr('0.7.6');
if (BR_076.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.7.6 tests in beads-setup-br076.test.ts cannot run (${BR_076.reason})`,
  );
}
const BR_0137 = installedBr('0.1.37');
if (BR_0137.kind !== 'installed') {
  console.warn(
    `SKIPPED: the br 0.1.37-to-0.7.6 tests in beads-setup-br076.test.ts cannot run (${BR_0137.reason})`,
  );
}
const withBoth = test.skipIf(
  BR_0137.kind !== 'installed' || BR_076.kind !== 'installed',
);

const SDK_PIN = getPinnedToolVersion('beads_rust');
if (SDK_PIN == null) throw new Error('versions.json pins no beads_rust');

/** A version above any SDK pin this suite will meet. */
const ABOVE = '99.0.0';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

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

/**
 * A fake `br` in its own sandbox. `--version` prints `br <version>`. `list`
 * exits `listCode` (printing `listOut` to stdout). With `listWhenPinned`, the
 * cwd's mise.toml decides instead: before the pin step has written a
 * beads_rust entry, `list` exits `listCode`; after it, `listWhenPinned`. That
 * models a br that turns unreadable once the pin changes (`6`), or one that
 * could not run until the pin step put it right (`0`). Anything else exits 0.
 */
function fakeBr(options: {
  listCode?: number;
  listOut?: string;
  listWhenPinned?: number;
  version: string;
}): string {
  const dir = join(track(createSandbox()).path, 'bin');
  mkdirSync(dir, {recursive: true});
  const listOut = (options.listOut ?? '').replaceAll("'", '');
  const plain = `printf '%s\\n' '${listOut}'; exit ${options.listCode ?? 0}`;
  const pinned =
    options.listWhenPinned === 0
      ? `echo '{"issues":[]}'; exit 0`
      : `printf '%s\\n' '${listOut}'; exit ${options.listWhenPinned ?? 0}`;
  const list =
    options.listWhenPinned == null
      ? plain
      : `if grep -q beads_rust mise.toml 2>/dev/null; then ${pinned}; fi; ${plain}`;
  writeFileSync(
    join(dir, 'br'),
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo 'br ${options.version}'; exit 0; fi`,
      `if [ "$1" = "list" ]; then ${list}; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'br'), 0o755);
  return dir;
}

const SYNC_CONFLICT_BODY = JSON.stringify({
  error: {
    code: 'SYNC_CONFLICT',
    message:
      'Sync conflict: engine recovery refused before opening: WAL contains frames that may hold committed, uncheckpointed changes',
  },
});

/** A br 0.1.37-shaped `.beads/` with a database file (bytes the fake never reads). */
function writeBeadsWithDb(root: string): void {
  mkdirSync(join(root, '.beads'), {recursive: true});
  writeFileSync(join(root, '.beads', '.gitignore'), '*.db\n');
  writeFileSync(
    join(root, '.beads', 'beads.db'),
    'SQLite format 3\0 live data',
  );
  writeFileSync(join(root, '.beads', 'beads.db-wal'), 'uncheckpointed frames');
  writeFileSync(join(root, '.beads', 'config.yaml'), 'issue_prefix: live\n');
  writeFileSync(
    join(root, '.beads', 'issues.jsonl'),
    '{"id":"live-1","title":"one"}\n',
  );
}

/** Everything under `dir`, path → bytes, so a lossy or moved tree cannot pass. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length + 1)] = readFileSync(full, 'latin1');
  }
  return out;
}

function legacyDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith('.beads.legacy-'));
}

// ---------------------------------------------------------------------------
// AC4: never move .beads/ aside on br exit 6 or an unclassified failure
// NEGATIVE CONTROL: make detectBeadsWorkspace return the old
// `{kind: 'legacy', reason: 'beads.db present but `br list` failed'}` and drop
// the up-front refusal, and the runBeadsSetup tests go red: .beads/ is moved.
// ---------------------------------------------------------------------------

describe('a br list failure never moves .beads/ aside', () => {
  test('a fake br exiting 6: the state is unreadable (exit 6, SYNC_CONFLICT), not legacy', async () => {
    const root = track(createSandbox()).path;
    writeBeadsWithDb(root);
    const fake = fakeBr({
      listCode: 6,
      listOut: SYNC_CONFLICT_BODY,
      version: SDK_PIN,
    });

    await withPathFirst(fake, () => {
      const state = detectBeadsWorkspace(root);
      expect(state.kind).toBe('unreadable');
      if (state.kind !== 'unreadable') throw new Error('unreachable');
      expect(state.exitCode).toBe(6);
      expect(state.detail).toContain('br list exited 6: SYNC_CONFLICT');

      const refusal = beadsSetupRefusal(root);
      expect(refusal).toContain('Exit 6 is SYNC_CONFLICT');
      expect(refusal).toContain('nothing in .beads/ was moved');
    });
  });

  test('runBeadsSetup with a br that exits 6: refuses before writing anything, .beads/ byte-identical', async () => {
    const sb = track(createProjectSandbox());
    writeBeadsWithDb(sb.path);
    const before = snapshot(join(sb.path, '.beads'));
    const topBefore = readdirSync(sb.path).sort();
    const fake = fakeBr({
      listCode: 6,
      listOut: SYNC_CONFLICT_BODY,
      version: SDK_PIN,
    });

    const exitCode = await withPathFirst(fake, () =>
      runBeadsSetup({
        noCommit: true,
        projectRoot: sb.path,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
        yes: true,
      }),
    );

    expect(exitCode).toBe(1);
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
    // Refused at step -1: not even mise.toml or the SDK config was written.
    expect(readdirSync(sb.path).sort()).toEqual(topBefore);
  });

  test('runBeadsSetup whose br turns unreadable after the pin step: step 3 refuses, .beads/ byte-identical', async () => {
    const sb = track(createProjectSandbox());
    writeBeadsWithDb(sb.path);
    const before = snapshot(join(sb.path, '.beads'));
    const fake = fakeBr({
      listOut: SYNC_CONFLICT_BODY,
      listWhenPinned: 6,
      version: SDK_PIN,
    });

    const exitCode = await withPathFirst(fake, () =>
      runBeadsSetup({
        noCommit: true,
        projectRoot: sb.path,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
        yes: true,
      }),
    );

    expect(exitCode).toBe(1);
    // The pin step ran (this is the step-3 guard, not the up-front one)...
    expect(readFileSync(join(sb.path, 'mise.toml'), 'utf-8')).toContain(
      BEADS_MISE_TOOL_KEY,
    );
    // ...and still nothing in .beads/ moved, and no br init or import ran.
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('an UNCLASSIFIED failure (exit 3, nothing on stdout) is refused at step 3, after the br install step', async () => {
    const sb = track(createProjectSandbox());
    writeBeadsWithDb(sb.path);
    const before = snapshot(join(sb.path, '.beads'));
    const fake = fakeBr({listCode: 3, version: SDK_PIN});

    await withPathFirst(fake, async () => {
      const state = detectBeadsWorkspace(sb.path);
      expect(state).toMatchObject({exitCode: 3, kind: 'unreadable'});
      // Not refused up front: only br's own exit 6 is (see the next test).
      expect(beadsSetupRefusal(sb.path)).toBeNull();
      const exitCode = await runBeadsSetup({
        noCommit: true,
        projectRoot: sb.path,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
        yes: true,
      });
      expect(exitCode).toBe(1);
    });
    expect(existsSync(join(sb.path, 'mise.toml'))).toBe(true);
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('a br that cannot run until the pin step puts it right is NOT refused: the run goes through and .beads/ is untouched', async () => {
    // A machine that has not installed the repo's pin yet: mise's shim fails
    // before step 2 installs it. Refusing at step -1 would stop the run that
    // installs br.
    const sb = track(createProjectSandbox());
    writeBeadsWithDb(sb.path);
    const before = snapshot(join(sb.path, '.beads'));
    const fake = fakeBr({listCode: 1, listWhenPinned: 0, version: SDK_PIN});

    const exitCode = await withPathFirst(fake, async () => {
      expect(detectBeadsWorkspace(sb.path)).toMatchObject({
        exitCode: 1,
        kind: 'unreadable',
      });
      return await runBeadsSetup({
        noCommit: true,
        projectRoot: sb.path,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
      });
    });

    expect(exitCode).toBe(0);
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  withBoth(
    'real brs: a br 0.1.37 DB with WAL frames, under br 0.7.6, is unreadable (exit 6) and runBeadsSetup leaves it byte-identical',
    async () => {
      if (BR_076.kind !== 'installed') throw new Error(BR_076.reason);
      if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
      const sb = track(createProjectSandbox());
      // br 0.1.37 writes the DB and leaves its WAL (measured).
      await withPathFirst(BR_0137.dir, () => {
        expect(runBr(sb.path, ['init', '--prefix', 'live', '-q']).ok).toBe(
          true,
        );
        expect(runBr(sb.path, ['create', 'one', '-q']).ok).toBe(true);
      });
      const db = join(sb.path, '.beads', 'beads.db');
      const wal = `${db}-wal`;
      const dbBytes = readFileSync(db);
      const walBytes = readFileSync(wal);
      expect(walBytes.length).toBeGreaterThan(0);

      const exitCode = await withPathFirst(BR_076.dir, async () => {
        const state = detectBeadsWorkspace(sb.path);
        expect(state).toMatchObject({exitCode: 6, kind: 'unreadable'});
        return await runBeadsSetup({
          noCommit: true,
          projectRoot: sb.path,
          quiet: true,
          sdkRepoUrl: sdkRemoteWithOwnTag(track),
          yes: true,
        });
      });

      expect(exitCode).toBe(1);
      expect(readFileSync(db).equals(dbBytes)).toBe(true);
      expect(readFileSync(wal).equals(walBytes)).toBe(true);
      expect(legacyDirs(sb.path)).toEqual([]);
    },
  );

  test('CONTROL: a .beads/ with neither a database nor a tracked config is still the legacy case', () => {
    const root = track(createSandbox()).path;
    mkdirSync(join(root, '.beads'));
    writeFileSync(join(root, '.beads', '.gitignore'), '*.db\n');
    expect(detectBeadsWorkspace(root)).toEqual({
      kind: 'legacy',
      reason: '.beads/ exists with neither a database nor a tracked config',
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 (beads-setup half): a pin above versions.json is never rewritten
// NEGATIVE CONTROL: drop the `compareBrPin` branch in applyBeadsMiseToolPin and
// the "kept" tests go red (the pin is rewritten to versions.json's).
// ---------------------------------------------------------------------------

describe('the mise pin step never pulls a repo down', () => {
  test('compareBrPin orders plain versions, v-prefixed too, and calls anything else unordered', () => {
    expect(compareBrPin('0.7.6', '0.1.37')).toEqual({kind: 'above'});
    expect(compareBrPin('v0.7.6', '0.1.37')).toEqual({kind: 'above'});
    expect(compareBrPin('0.1.37', '0.7.6')).toEqual({kind: 'below'});
    expect(compareBrPin('0.1.40', '0.1.37')).toEqual({kind: 'above'});
    expect(compareBrPin('1.0.0', '0.99.99')).toEqual({kind: 'above'});
    expect(compareBrPin('v0.1.37', '0.1.37')).toEqual({kind: 'same'});
    expect(compareBrPin('latest', '0.1.37').kind).toBe('unordered');
    expect(compareBrPin('0.7', '0.1.37').kind).toBe('unordered');
  });

  const pinned = (version: string): string =>
    `[tools]\n${BEADS_MISE_TOOL_KEY} = { version = "${version}", exe = "br" }\n`;

  test('a pin ABOVE the SDK is kept, not rewritten', () => {
    expect(applyBeadsMiseToolPin(pinned('0.7.6'), '0.1.37')).toEqual({
      kind: 'kept-higher',
      pinned: '0.7.6',
    });
  });

  test('a pin that cannot be ordered is kept too, with the reason', () => {
    const outcome = applyBeadsMiseToolPin(pinned('latest'), '0.1.37');
    expect(outcome.kind).toBe('kept-unordered');
  });

  test('CONTROL: a pin BELOW the SDK is still rewritten, as before', () => {
    const outcome = applyBeadsMiseToolPin(pinned('0.1.30'), '0.1.37');
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') throw new Error('unreachable');
    expect(outcome.content).toBe(pinned('0.1.37'));
  });

  /** A repo with a committed-style .beads/ (no DB), so no br init runs. */
  function trackedBeadsProject(pin: string): string {
    const sb = track(createProjectSandbox());
    writeFileSync(join(sb.path, 'mise.toml'), pinned(pin));
    mkdirSync(join(sb.path, '.beads'));
    writeFileSync(join(sb.path, '.beads', 'config.yaml'), 'issue_prefix: x\n');
    return sb.path;
  }

  test('runBeadsSetup in a repo pinned above the SDK and running that br: exit 0, mise.toml byte-identical', async () => {
    const root = trackedBeadsProject(ABOVE);
    const before = readFileSync(join(root, 'mise.toml'), 'utf-8');

    const exitCode = await withPathFirst(fakeBr({version: ABOVE}), () =>
      runBeadsSetup({
        noCommit: true,
        projectRoot: root,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
      }),
    );

    expect(exitCode).toBe(0);
    expect(readFileSync(join(root, 'mise.toml'), 'utf-8')).toBe(before);
  });

  test('CONTROL: runBeadsSetup in a repo pinned below the SDK rewrites the pin to the SDK one', async () => {
    const root = trackedBeadsProject('0.0.1');

    const exitCode = await withPathFirst(fakeBr({version: SDK_PIN}), () =>
      runBeadsSetup({
        noCommit: true,
        projectRoot: root,
        quiet: true,
        sdkRepoUrl: sdkRemoteWithOwnTag(track),
      }),
    );

    expect(exitCode).toBe(0);
    expect(readFileSync(join(root, 'mise.toml'), 'utf-8')).toBe(
      pinned(SDK_PIN),
    );
  });
});

// ---------------------------------------------------------------------------
// The two br commands beads-setup runs, on br 0.7.6 (the brief's check)
// NEGATIVE CONTROL: these run the shipped strings; changing either string to
// one 0.7.6 rejects (e.g. `--orphans permit`) turns them red.
// ---------------------------------------------------------------------------

describe('the br commands beads-setup runs still work on br 0.7.6', () => {
  withBoth(
    "`br init --prefix '<p>'` (stepInitBeads) and the JSONL import (BEADS_IMPORT_COMMAND) on br 0.7.6",
    async () => {
      if (BR_076.kind !== 'installed') throw new Error(BR_076.reason);
      if (BR_0137.kind !== 'installed') throw new Error(BR_0137.reason);
      // A JSONL written by br 0.1.37, as a migration would carry.
      const sb = track(createSandbox());
      const source = initRepo(sb, 'source', {'README.md': '# s\n'});
      await withPathFirst(BR_0137.dir, () => {
        expect(runBr(source, ['init', '--prefix', 'imp', '-q']).ok).toBe(true);
        expect(runBr(source, ['create', 'first', '-q']).ok).toBe(true);
        expect(runBr(source, ['create', 'second', '-q']).ok).toBe(true);
      });
      const jsonl = readFileSync(
        join(source, '.beads', 'issues.jsonl'),
        'utf-8',
      );
      expect(jsonl.trim().split('\n')).toHaveLength(2);

      const target = initRepo(sb, 'target', {'README.md': '# t\n'});
      await withPathFirst(BR_076.dir, () => {
        expect(exec('br --version', target).stdout).toBe('br 0.7.6');
        // The exact strings beads-setup runs, through the same exec.
        const init = exec(`br init --prefix 'imp'`, target);
        expect(init.exitCode).toBe(0);
        expect(existsSync(join(target, '.beads', 'beads.db'))).toBe(true);

        writeFileSync(join(target, '.beads', 'issues.jsonl'), jsonl);
        const imported = exec(BEADS_IMPORT_COMMAND, target);
        expect(imported.exitCode).toBe(0);

        const list = exec('br list --all --json', target);
        expect(list.exitCode).toBe(0);
        const data = JSON.parse(list.stdout) as {issues?: {title: string}[]};
        expect((data.issues ?? []).map((issue) => issue.title).sort()).toEqual([
          'first',
          'second',
        ]);
      });
    },
  );
});
