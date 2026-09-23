/**
 * MIGRATION NEVER DELETES (home-base-dchjw.20).
 *
 * `stepMigrateOldBeads` used to `cpSync` a `.beads/` it had classified as
 * `legacy` into `tmp/` and then `rmSync(.beads, {recursive: true, force:
 * true})` — unattended, no flag, no prompt, no dry-run, keeping only whatever
 * `issues.jsonl` the copy happened to contain. The classification could fire on
 * a live Dolt (`bd`) database: the first full-fleet `sweep --component install
 * --dry-run` printed `life: adopt: beads-setup`, one non-dry run from
 * destroying ~/Dev/life.
 *
 * Every test here asserts the same thing from a different angle: after the
 * migration code has run, the bytes are still on disk. The refusals are paired
 * with NEGATIVE CONTROLS — a fixture differing by exactly the one feature under
 * test, which goes through — because a refusal that fired on everything would
 * pass a test that only ever proves it fired.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'fs';
import {join} from 'path';

import {
  detectBeadsWorkspace,
  inspectLegacyBeadsDir,
  moveLegacyBeadsAside,
} from '../src/beads-setup';
import {createSandbox, type Sandbox} from './sandbox';

let sb: Sandbox;
afterEach(() => sb?.cleanup());

/** The JSONL a real migration would carry across. */
const ISSUES_JSONL =
  '{"id":"alpha-1","title":"first"}\n{"id":"alpha-2","title":"second"}\n';

/** A `.beads/` whose every entry beads-setup recognises, with issues in it. */
function writeGenuineLegacyBeads(sandbox: Sandbox): void {
  sandbox.writeFile('.beads/.gitignore', '*.db\n');
  sandbox.writeFile('.beads/.local_version', '0.1.37\n');
  sandbox.writeFile('.beads/.sync.lock', '');
  sandbox.writeFile('.beads/config.yaml', 'issue_prefix: alpha\n');
  sandbox.writeFile('.beads/issues.jsonl', ISSUES_JSONL);
  sandbox.writeFile('.beads/last-touched', '2026-09-18\n');
  sandbox.writeFile('.beads/metadata.json', '{"database": "beads.db"}\n');
}

/** Everything under `dir`, one path → bytes, so a lossy move cannot pass. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length + 1)] = readFileSync(full, 'utf-8');
  }
  return out;
}

function legacyDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith('.beads.legacy-'));
}

describe('legacy .beads/ migration refuses rather than deleting', () => {
  test('a Dolt workspace SURVIVES: metadata names dolt → refused, nothing moved, nothing deleted', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    sb.writeFile('.beads/metadata.json', '{"backend": "dolt"}\n');
    const before = snapshot(join(sb.path, '.beads'));

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('Dolt');
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('a Dolt workspace SURVIVES: an embeddeddolt directory is enough on its own, even with unreadable metadata', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    sb.writeFile('.beads/embeddeddolt/.dolt/config.json', '{}\n');
    const before = snapshot(join(sb.path, '.beads'));

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    // The DOLT-LAYOUT reason specifically, not the generic unknown-entry one:
    // `embeddeddolt` is also an unrecognised name, so asserting only that it is
    // mentioned would pass with the Dolt layout check deleted. Measured — that
    // is exactly what the first version of this test did.
    expect(result.reason).toContain('carries a Dolt (`bd`) layout');
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('NEGATIVE CONTROL for the Dolt refusals: the same fixture without a dolt marker is moved', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('moved');
    expect(legacyDirs(sb.path)).toHaveLength(1);
  });

  test('an unrecognised file SURVIVES: the whole directory is left alone and the file is named', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    sb.writeFile('.beads/handwritten-notes.md', '# do not lose me\n');
    const before = snapshot(join(sb.path, '.beads'));

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('handwritten-notes.md');
    expect(snapshot(join(sb.path, '.beads'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('NEGATIVE CONTROL for the unknown-file refusal: byte-identical fixture minus that one file is moved', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('moved');
    expect(legacyDirs(sb.path)).toHaveLength(1);
  });

  test('per-process br lock files are recognised, not treated as unknown', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    sb.writeFile('.beads/.br-db-write-a1370da84d407097a0e865f2.lock', '');
    sb.writeFile('.beads/.br-db-openers-34817d60d8891c32139ae66b.lock', '');

    const inspection = inspectLegacyBeadsDir(sb.path);

    expect(inspection.ok).toBe(true);
  });

  test('a symlinked .beads SURVIVES: the link is not moved and the target is untouched', () => {
    sb = createSandbox();
    sb.writeFile('elsewhere/.gitignore', '*.db\n');
    sb.writeFile('elsewhere/issues.jsonl', ISSUES_JSONL);
    symlinkSync(join(sb.path, 'elsewhere'), join(sb.path, '.beads'));
    const before = snapshot(join(sb.path, 'elsewhere'));

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('SYMLINK');
    expect(lstatSync(join(sb.path, '.beads')).isSymbolicLink()).toBe(true);
    expect(snapshot(join(sb.path, 'elsewhere'))).toEqual(before);
    expect(legacyDirs(sb.path)).toEqual([]);
  });

  test('an occupied .beads.legacy-<ts> SURVIVES: the move refuses instead of renaming over it', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    const now = new Date('2026-09-18T12:34:56.000Z');
    sb.writeFile('.beads.legacy-2026-09-18T12-34-56/issues.jsonl', 'earlier\n');

    const result = moveLegacyBeadsAside(sb.path, {now});

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('already exists');
    expect(existsSync(join(sb.path, '.beads'))).toBe(true);
    expect(
      readFileSync(
        join(sb.path, '.beads.legacy-2026-09-18T12-34-56', 'issues.jsonl'),
        'utf-8',
      ),
    ).toBe('earlier\n');
  });
});

describe('a genuine legacy .beads/ is MOVED, not deleted', () => {
  test('every byte survives at .beads.legacy-<timestamp>/ and .beads/ is clear for br init', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    const before = snapshot(join(sb.path, '.beads'));
    const now = new Date('2026-09-18T12:34:56.000Z');

    const result = moveLegacyBeadsAside(sb.path, {now});

    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') throw new Error('unreachable');

    // The destination is beside .beads/, timestamped, and holds EVERYTHING —
    // a rename that dropped half the tree would pass an existsSync check.
    expect(result.movedTo).toBe(
      join(sb.path, '.beads.legacy-2026-09-18T12-34-56'),
    );
    expect(snapshot(result.movedTo)).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    // Nothing was copied into tmp/: the move IS the preservation, and tmp/ is
    // gitignored and disposable — the wrong home for the only surviving copy.
    expect(existsSync(join(sb.path, 'tmp'))).toBe(false);

    // …and the path br init needs is free.
    expect(existsSync(join(sb.path, '.beads'))).toBe(false);
  });

  test('the JSONL handed to the import step points INTO the moved directory', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') throw new Error('unreachable');
    expect(result.jsonlPath).toBe(join(result.movedTo, 'issues.jsonl'));
    expect(readFileSync(result.jsonlPath ?? '', 'utf-8')).toBe(ISSUES_JSONL);
  });

  test('an empty issues.jsonl reports no importable data rather than an empty import', () => {
    sb = createSandbox();
    writeGenuineLegacyBeads(sb);
    sb.writeFile('.beads/issues.jsonl', '\n  \n');

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') throw new Error('unreachable');
    expect(result.jsonlPath).toBeNull();
    // Still moved, not deleted: nothing to import is not a licence to discard.
    expect(readFileSync(join(result.movedTo, 'issues.jsonl'), 'utf-8')).toBe(
      '\n  \n',
    );
  });

  test('a half-broken workspace with no data is moved too (the other legacy shape)', () => {
    sb = createSandbox();
    sb.writeFile('.beads/.gitignore', '*.db\n');
    sb.writeFile('.beads/.sync.lock', '');

    // Precondition: this really is the shape that reaches migration.
    expect(detectBeadsWorkspace(sb.path).kind).toBe('legacy');

    const result = moveLegacyBeadsAside(sb.path);

    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') throw new Error('unreachable');
    expect(result.kept).toEqual(['.gitignore', '.sync.lock']);
    expect(existsSync(join(result.movedTo, '.gitignore'))).toBe(true);
  });
});
