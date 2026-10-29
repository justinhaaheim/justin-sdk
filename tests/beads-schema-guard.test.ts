/**
 * No br runs on a beads database whose schema is newer than that br writes
 * (home-base-dj5m9.1.6 F9; layer 2 of the decision in home-base-dj5m9.1.7).
 *
 * br 0.1.37 reads AND writes a schema-19 DB that br 0.7.6 made, without
 * refusing, and its export drops the fields only 0.7.6 has (measured
 * 2026-10-29, `bun run measure:br-downgrade`). So every `{db}` call reads the
 * DB's `PRAGMA user_version` first and refuses when the br about to run (the
 * one the DB's checkout pins, picked by cwd here: tests/br-by-cwd.ts) writes
 * an older schema.
 *
 * Real brs 0.1.37 and 0.7.6, throwaway checkouts under $TMPDIR.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.6): make
 * `oldBrOnNewDbRefusal` return null → "a br 0.7.6 DB with br 0.1.37 running"
 * fails: 0.1.37 lists the 0.7.6 DB (`ok`), and so does the unreadable-schema
 * test.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {cpSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brList, brSchemaWritten, readDbSchema, runBr} from '../src/beads/br';
import {brByCwd, withPath} from './br-by-cwd';
import {installedBr} from './pinned-br';
import {createSandbox} from './sandbox';

const BR_076 = installedBr('0.7.6');
const BR_0137 = installedBr('0.1.37');
const missing = [BR_076, BR_0137].find((br) => br.kind !== 'installed');
if (missing?.kind === 'unresolved') {
  console.warn(
    `SKIPPED: the schema-guard tests in beads-schema-guard.test.ts need br 0.1.37 and 0.7.6 installed (${missing.reason})`,
  );
}
const withBoth = test.skipIf(missing != null);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function brPath(version: '0.1.37' | '0.7.6'): string {
  const br = version === '0.7.6' ? BR_076 : BR_0137;
  if (br.kind !== 'installed') throw new Error(br.reason);
  return br.path;
}

/**
 * A checkout pinned to `runs` whose `.beads/` holds a DB that `madeBy` made
 * (made in another directory and copied in, WAL included).
 */
function checkoutWithDb(
  madeBy: '0.1.37' | '0.7.6',
  runs: '0.1.37' | '0.7.6',
): {calls: ReturnType<typeof brByCwd>['calls']; db: string; path: string} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const shim = brByCwd(sb);
  const maker = join(sb.path, 'maker');
  const checkout = join(sb.path, 'checkout');
  mkdirSync(maker, {recursive: true});
  mkdirSync(checkout, {recursive: true});
  shim.pin(maker, brPath(madeBy));
  shim.pin(checkout, brPath(runs));
  withPath(shim.path, () => {
    const init = runBr(maker, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  });
  cpSync(join(maker, '.beads'), join(checkout, '.beads'), {recursive: true});
  return {
    calls: shim.calls,
    db: join(checkout, '.beads', 'beads.db'),
    path: shim.path,
  };
}

describe('an old br on a new beads database (F9)', () => {
  test('the measured schemas: 0.1.37 writes 4, 0.4.1 writes 17, 0.7.6 writes 19', () => {
    expect(brSchemaWritten({major: 0, minor: 1, patch: 37})).toBe(4);
    expect(brSchemaWritten({major: 0, minor: 4, patch: 1})).toBe(17);
    expect(brSchemaWritten({major: 0, minor: 7, patch: 6})).toBe(19);
    expect(brSchemaWritten({major: 0, minor: 9, patch: 0})).toBe(19);
    expect(brSchemaWritten({major: 0, minor: 1, patch: 0})).toBeNull();
  });

  withBoth(
    'a br 0.7.6 DB with br 0.1.37 running: refused, and br never runs on it',
    () => {
      const repo = checkoutWithDb('0.7.6', '0.1.37');
      withPath(repo.path, () => {
        const schema = readDbSchema(repo.db);
        expect(schema).toEqual({kind: 'read', schema: 19});
        const before = repo.calls().length;
        const listed = brList({db: repo.db}, {all: true});
        expect(listed.kind).toBe('failed');
        if (listed.kind !== 'failed') return;
        expect(listed.reason).toContain('is on schema 19');
        expect(listed.reason).toContain('br 0.1.37');
        const ran = repo
          .calls()
          .slice(before)
          .filter((call) => !call.args.startsWith('--version'));
        expect(ran).toEqual([]);
      });
    },
  );

  withBoth('the same br 0.7.6 DB with br 0.7.6 running: it runs', () => {
    const repo = checkoutWithDb('0.7.6', '0.7.6');
    withPath(repo.path, () => {
      expect(brList({db: repo.db}, {all: true}).kind).toBe('ok');
    });
  });

  withBoth('a br 0.1.37 DB with br 0.1.37 running: it runs', () => {
    const repo = checkoutWithDb('0.1.37', '0.1.37');
    withPath(repo.path, () => {
      expect(readDbSchema(repo.db)).toEqual({kind: 'read', schema: 4});
      expect(brList({db: repo.db}, {all: true}).kind).toBe('ok');
    });
  });

  withBoth('a schema that cannot be read is refused, never "fine"', () => {
    const repo = checkoutWithDb('0.7.6', '0.7.6');
    writeFileSync(join(repo.db), 'this is not a SQLite database');
    withPath(repo.path, () => {
      expect(readDbSchema(repo.db).kind).toBe('failed');
      const listed = brList({db: repo.db}, {all: true});
      expect(listed.kind).toBe('failed');
      if (listed.kind !== 'failed') return;
      expect(listed.reason).toContain(
        'the schema of the beads database could not be read',
      );
    });
  });
});
