/**
 * The exit-code contract of `beads-rebuild-dryrun` is the whole product.
 *
 * 0 = compared, nothing would be lost. 1 = compared, content would be DESTROYED. 2 = the check could not run. The dangerous confusion is between 1 and 2: a failed measurement wearing a finding's clothes, or worse, wearing an all-clear's. The tool's own control set caught exactly that once — an unspawnable `br` threw and the process exited 1 — so both "could not measure" shapes are pinned here.
 *
 * Fixtures are REAL beads workspaces built by a REAL `br`, because the behavior under test IS br's: what `br sync --import-only` reconstructs from a JSONL, and what it therefore silently drops. A mocked `br` would only test this file's idea of br.
 *
 * `br` is resolved once at MODULE LOAD so `test.skipIf` can use it: a machine without br must report these as SKIPPED, never as green (critical rule 6 — silence must be a claim).
 */

import {afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {homedir, tmpdir} from 'os';
import {join, resolve} from 'path';

import {
  BEADS_REBUILD_DRYRUN_EXIT,
  runBeadsRebuildDryRun,
} from '../src/beads-rebuild-dryrun';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

/**
 * A `br` that works with an arbitrary cwd. Plain `br` is preferred, but on this fleet it is a mise shim that resolves its version from the *current directory's* config — and the dry run deliberately runs br in a temp directory, where such a shim resolves to nothing. So fall back to the concrete binary path mise reports.
 */
function resolveBrBinary(): string | null {
  const direct = Bun.spawnSync(['br', '--version'], {
    cwd: tmpdir(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (direct.exitCode === 0) return 'br';

  const viaMise = Bun.spawnSync(['mise', 'which', 'br'], {
    cwd: resolve(import.meta.dirname, '..'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (viaMise.exitCode !== 0) return null;
  const path = (viaMise.stdout?.toString() ?? '').trim();
  return path !== '' && existsSync(path) ? path : null;
}

function brVersion(bin: string): string | null {
  const proc = Bun.spawnSync([bin, '--version'], {
    cwd: tmpdir(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const text = (proc.stdout?.toString() ?? '').trim();
  return text === '' ? null : text;
}

/**
 * A SECOND br, from the 0.4 line — the version the fleet migration rebuilds WITH. Found by asking each installed mise build for its own `--version`, never by trusting a directory name. Absent on a machine that has only one br, in which case the cross-version test skips rather than pretending to have run.
 */
function resolveBr04(): string | null {
  const root = join(
    homedir(),
    '.local/share/mise/installs/github-dicklesworthstone-beads-rust',
  );
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort().reverse()) {
    const candidate = join(root, name, 'br');
    if (!existsSync(candidate)) continue;
    if (brVersion(candidate)?.startsWith('br 0.4') === true) return candidate;
  }
  return null;
}

const BR = resolveBrBinary();
const hasBr = BR != null;

function requireBr(): string {
  if (BR == null) throw new Error('no br binary resolved');
  return BR;
}

const BR_04 = resolveBr04();
/** Only meaningful when the two builds really are different versions. */
const hasCrossVersionBr =
  hasBr && BR_04 != null && brVersion(requireBr()) !== brVersion(BR_04);

function requireBr04(): string {
  if (BR_04 == null) throw new Error('no br 0.4.x binary resolved');
  return BR_04;
}

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function runBr(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync([requireBr(), ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `fixture setup failed: br ${args.join(' ')} exited ${proc.exitCode}\n${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`,
    );
  }
}

/**
 * One real two-issue workspace, built once and copied per test — `br init` plus two `br create`s is the slow part of this file, and every case starts from the same clean state anyway.
 */
let template: Sandbox | null = null;

beforeAll(() => {
  if (!hasBr) return;
  const sb = createSandbox();
  runBr(sb.path, ['init', '--prefix', 'fx']);
  runBr(sb.path, ['create', 'First fixture issue', '-t', 'task', '-p', '1']);
  runBr(sb.path, ['create', 'Second fixture issue', '-t', 'bug', '-p', '0']);
  runBr(sb.path, ['sync', '--flush-only']);

  // Assert the fixture is the shape the tests assume. A workspace that quietly failed to flush would make "nothing would be lost" mean nothing.
  const lines = readFileSync(join(sb.path, '.beads', 'issues.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length !== 2) {
    throw new Error(
      `fixture setup failed: expected 2 issues in issues.jsonl, found ${lines.length}`,
    );
  }
  template = sb;
});

/** A fresh copy of the template workspace. Returns the path to its `.beads`. */
function workspace(): string {
  if (template == null) throw new Error('no template workspace');
  const sb = track(createSandbox());
  cpSync(join(template.path, '.beads'), join(sb.path, '.beads'), {
    recursive: true,
  });
  return join(sb.path, '.beads');
}

/** Drop the last issue from the JSONL, leaving it in the database only — the drift shape whose rebuild destroys content. */
function dropLastJsonlLine(beadsDir: string): void {
  const jsonl = join(beadsDir, 'issues.jsonl');
  const lines = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  writeFileSync(jsonl, `${lines.slice(0, -1).join('\n')}\n`);
}

function captureOutput(fn: () => number): {output: string; exitCode: number} {
  const lines: string[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = collect();
  console.error = collect();
  try {
    const exitCode = fn();
    return {exitCode, output: lines.join('\n')};
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Temp working copies the tool has left behind, by name. */
function strayTempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('beads-dryrun-'))
    .sort();
}

/** Every file under a directory, mapped to a hash of its bytes. Recursive because `br init` leaves a `.br_history/` subtree in `.beads/`, and "the live workspace is only ever read" is a claim about all of it. */
function fileHashes(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, fileHashes(join(dir, entry.name), rel));
    } else {
      out[rel] = Bun.hash(readFileSync(join(dir, entry.name))).toString();
    }
  }
  return out;
}

describe('beads-rebuild-dryrun exit-code contract', () => {
  test.skipIf(!hasBr)(
    'a workspace whose JSONL covers the database is safe (0)',
    () => {
      const beadsDir = workspace();
      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(output).toContain('issues        : 2 now -> 2 after the rebuild');
      expect(output).toContain('dependency or label would be lost');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );

  /**
   * The migration this gate exists for: the workspace was written by one br line and is rebuilt by another. Only here does `content_hash` get recomputed differently, which is why it sits in NOT_COMPARED — with it compared, this clean workspace reports one FATAL per issue and the gate blocks a migration that loses nothing.
   */
  test.skipIf(!hasCrossVersionBr)(
    'a rebuild by a DIFFERENT br version is safe, and the recomputed content_hash is not mistaken for loss',
    () => {
      const beadsDir = workspace();
      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr04()}),
      );

      // Proof the other br really did the rebuild rather than declining it.
      expect(output).toContain('Imported from JSONL');
      expect(output).toContain('issues        : 2 now -> 2 after the rebuild');
      expect(output).not.toContain('content_hash');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );

  test.skipIf(!hasBr)(
    'a row that exists only in the database would be LOST (1)',
    () => {
      const beadsDir = workspace();
      dropLastJsonlLine(beadsDir);

      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(output).toContain('WOULD BE LOST (1)');
      expect(output).toContain('would NOT survive the rebuild');
      expect(output).toContain('NOT SAFE to delete beads.db');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
    },
  );

  test.skipIf(!hasBr)(
    'a br that cannot be spawned is COULD NOT RUN (2), never a finding',
    () => {
      const beadsDir = workspace();
      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({
          beadsDir,
          brBin: join(beadsDir, 'no-such-br-binary'),
        }),
      );

      expect(output).toContain('CHECK COULD NOT RUN');
      expect(output).toContain('This is NOT an all-clear');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.cannotCheck);
      expect(exitCode).not.toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
      expect(exitCode).not.toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );

  test.skipIf(!hasBr)(
    'a br that exits 0 without writing a database is COULD NOT RUN (2)',
    () => {
      const beadsDir = workspace();
      const fakeBr = join(beadsDir, '..', 'fake-br.sh');
      writeFileSync(fakeBr, '#!/bin/sh\necho "pretending to import"\nexit 0\n');
      chmodSync(fakeBr, 0o755);

      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: fakeBr}),
      );

      expect(output).toContain('reported success but produced no database');
      expect(output).toContain('This is NOT an all-clear');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.cannotCheck);
      expect(exitCode).not.toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );

  test('a workspace that is not there is COULD NOT RUN (2)', () => {
    const sb = track(createSandbox());
    const {exitCode, output} = captureOutput(() =>
      runBeadsRebuildDryRun({beadsDir: join(sb.path, '.beads')}),
    );

    expect(output).toContain('CHECK COULD NOT RUN — no database at');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.cannotCheck);
  });
});

describe('beads-rebuild-dryrun leaves nothing behind', () => {
  test.skipIf(!hasBr)(
    'the source workspace is byte-identical afterwards and the temp copy is gone',
    () => {
      const beadsDir = workspace();
      const before = fileHashes(beadsDir);
      const strayBefore = strayTempDirs();

      const {exitCode} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
      expect(fileHashes(beadsDir)).toEqual(before);
      expect(strayTempDirs()).toEqual(strayBefore);
    },
  );
});

describe('the beads-rebuild-dryrun CLI', () => {
  function runCli(beadsDir: string): {exitCode: number | null; output: string} {
    const proc = Bun.spawnSync(
      [
        'bun',
        CLI,
        'beads-rebuild-dryrun',
        '--beads',
        beadsDir,
        '--br',
        requireBr(),
      ],
      {cwd: tmpdir(), stderr: 'pipe', stdout: 'pipe'},
    );
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`,
    };
  }

  test.skipIf(!hasBr)('exits 0 on a workspace the JSONL covers', () => {
    const {exitCode, output} = runCli(workspace());
    expect(output).toContain('Safe to delete beads.db');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
  });

  test.skipIf(!hasBr)('exits 1 when a database-only row would be lost', () => {
    const beadsDir = workspace();
    dropLastJsonlLine(beadsDir);
    const {exitCode, output} = runCli(beadsDir);
    expect(output).toContain('WOULD BE LOST (1)');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
  });
});
