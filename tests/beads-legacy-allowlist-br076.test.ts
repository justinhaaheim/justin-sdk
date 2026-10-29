/**
 * beads-setup's legacy-migration allowlist knows br 0.7.6's local files
 * (home-base-dj5m9.1.6 F8).
 *
 * `inspectLegacyBeadsDir` refuses a `.beads/` holding any entry it does not
 * recognise. It did not know the sidecars br 0.7.6 leaves, so the first
 * beads-setup after the switch refused. The allowlist now reads the SAME list
 * the `.gitignore` step writes (`BR076_BEADS_IGNORE_ENTRIES`), so the two
 * cannot drift; the first test builds one entry per pattern of that list.
 * The second runs the real br 0.7.6 in a throwaway repo and inspects the
 * `.beads/` it leaves.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.6): drop
 * `...BR076_ENTRY_PATTERNS` from `isKnownBeadsEntry` → both tests fail, naming
 * `beads.db-fsqlite-ns-gate` among the unrecognised entries.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {
  BR076_BEADS_IGNORE_ENTRIES,
  inspectLegacyBeadsDir,
} from '../src/beads-setup';
import {brByCwd, withPath} from './br-by-cwd';
import {initRepo} from './git-fixtures';
import {installedBr} from './pinned-br';
import {createSandbox} from './sandbox';

const BR_076 = installedBr('0.7.6');
if (BR_076.kind !== 'installed') {
  console.warn(
    `SKIPPED: the real br 0.7.6 test in beads-legacy-allowlist-br076.test.ts cannot run (${BR_076.reason})`,
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

describe('the legacy-migration allowlist knows br 0.7.6 (F8)', () => {
  test('one entry per pattern of BR076_BEADS_IGNORE_ENTRIES is recognised', () => {
    const sb = sandbox();
    const beads = join(sb.path, '.beads');
    mkdirSync(beads, {recursive: true});
    writeFileSync(join(beads, 'issues.jsonl'), '');
    for (const pattern of BR076_BEADS_IGNORE_ENTRIES) {
      const name = pattern.replace(/\/$/, '').replaceAll('*', 'beads.db');
      if (pattern.endsWith('/')) mkdirSync(join(beads, name));
      else writeFileSync(join(beads, name), '');
    }
    const inspected = inspectLegacyBeadsDir(sb.path);
    expect(inspected).toMatchObject({ok: true});
  });

  test.skipIf(BR_076.kind !== 'installed')(
    'the .beads/ a real br 0.7.6 leaves is recognised, entry by entry',
    () => {
      if (BR_076.kind !== 'installed') return;
      const sb = sandbox();
      const shim = brByCwd(sb);
      const repo = initRepo(sb, 'repo', {'README.md': '# repo\n'});
      shim.pin(repo, BR_076.path);
      withPath(shim.path, () => {
        expect(runBr(repo, ['init', '--prefix', 't', '-q']).ok).toBe(true);
        expect(
          runBr(repo, [
            'create',
            'allowlist probe [TEST_DATA_DELETABLE 135b9742-d65b-4fdb-b552-448746598ee9 ]',
            '--silent',
          ]).ok,
        ).toBe(true);
      });
      const inspected = inspectLegacyBeadsDir(repo);
      if (!inspected.ok) throw new Error(inspected.reason);
      expect(inspected.entries).toContain('beads.db-fsqlite-ns-gate');
    },
  );
});
