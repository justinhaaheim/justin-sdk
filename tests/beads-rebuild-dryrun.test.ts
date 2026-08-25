/**
 * The exit-code contract of `beads-rebuild-dryrun` is the whole product.
 *
 * 0 = compared, nothing would be lost. 1 = compared, content would be DESTROYED. 2 = the check could not run. The dangerous confusion is between 1 and 2: a failed measurement wearing a finding's clothes, or worse, wearing an all-clear's. The tool's own control set caught exactly that once — an unspawnable `br` threw and the process exited 1 — so both "could not measure" shapes are pinned here.
 *
 * Fixtures are REAL beads workspaces built by a REAL `br`, because the behavior under test IS br's: what `br sync --import-only` reconstructs from a JSONL, and what it therefore silently drops. A mocked `br` would only test this file's idea of br.
 *
 * `br` is resolved once at MODULE LOAD so `test.skipIf` can use it: a machine without br must report these as SKIPPED, never as green (critical rule 6 — silence must be a claim).
 */

import {Database} from 'bun:sqlite';
import {afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
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

function runBr(cwd: string, args: string[]): string {
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
  return (proc.stdout?.toString() ?? '').trim();
}

/**
 * The ids `br` minted for the fixture. They are random per workspace, so every test that names an issue reads them from here rather than hard-coding a prefix that would silently match nothing.
 */
interface FixtureIds {
  /** Two comments, two labels, depends on BETA, and is depended on BY gamma — the one issue that exercises every compared table at once, in both dependency directions. */
  alpha: string;
  /** One comment, one label. */
  beta: string;
  /** Depends on ALPHA. No content of its own. */
  gamma: string;
  /** Deliberately bare: no comments, dependencies or labels, so dropping it from the JSONL loses exactly ONE thing and the count in the report stays readable. */
  delta: string;
}

let ids: FixtureIds | null = null;

function requireIds(): FixtureIds {
  if (ids == null) throw new Error('no fixture ids');
  return ids;
}

/**
 * One real workspace WITH CONTENT, built once and copied per test.
 *
 * The original fixture here was two issues carrying no comments, dependencies or labels. Those three tables were compared by code that never ran against anything, so the suite proved the tool detects a lost ISSUE and proved nothing whatsoever about a lost COMMENT, DEPENDENCY or LABEL — which is the content most likely to live in a database and not in the JSONL, i.e. the entire reason this gate exists (home-base-97lo). Content here also makes the clean-workspace cases mean something: they now show that comment/dependency/label comparison does not FALSE-positive either.
 */
let template: Sandbox | null = null;

beforeAll(() => {
  if (!hasBr) return;
  const sb = createSandbox();
  runBr(sb.path, ['init', '--prefix', 'fx']);
  // `br q` is quick-capture: it creates the issue and prints ONLY its id.
  const alpha = runBr(sb.path, ['q', 'Alpha fixture issue']);
  const beta = runBr(sb.path, ['q', 'Beta fixture issue']);
  const gamma = runBr(sb.path, ['q', 'Gamma fixture issue']);
  const delta = runBr(sb.path, ['q', 'Delta fixture issue']);

  runBr(sb.path, ['comments', 'add', alpha, 'alpha first comment']);
  runBr(sb.path, ['comments', 'add', alpha, 'alpha second comment']);
  runBr(sb.path, ['comments', 'add', beta, 'beta only comment']);
  // Both directions through alpha: alpha depends on beta, gamma depends on alpha.
  runBr(sb.path, ['dep', 'add', alpha, beta]);
  runBr(sb.path, ['dep', 'add', gamma, alpha]);
  runBr(sb.path, ['label', 'add', alpha, 'alpha-label']);
  runBr(sb.path, ['label', 'add', alpha, 'shared-label']);
  runBr(sb.path, ['label', 'add', beta, 'beta-label']);
  runBr(sb.path, ['sync', '--flush-only']);

  // Assert the fixture is the shape the tests assume, in the DATABASE and in the JSONL. A workspace that quietly failed to attach its content would make every "would be LOST" assertion below vacuous, and a workspace that failed to flush would make "nothing would be lost" mean nothing.
  const lines = readFileSync(join(sb.path, '.beads', 'issues.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length !== 4) {
    throw new Error(
      `fixture setup failed: expected 4 issues in issues.jsonl, found ${lines.length}`,
    );
  }
  const db = new Database(join(sb.path, '.beads', 'beads.db'), {
    readonly: true,
  });
  const counts: Record<string, number> = {};
  for (const table of ['issues', 'comments', 'dependencies', 'labels']) {
    counts[table] =
      db.query<{n: number}, []>(`select count(*) as n from ${table}`).get()
        ?.n ?? -1;
  }
  db.close();
  const expected = {comments: 3, dependencies: 2, issues: 4, labels: 3};
  for (const [table, want] of Object.entries(expected)) {
    if (counts[table] !== want) {
      throw new Error(
        `fixture setup failed: expected ${want} rows in ${table}, found ${counts[table]}`,
      );
    }
  }

  ids = {alpha, beta, delta, gamma};
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

/**
 * Every JSONL record, in file order. The exporter writes one issue per line with its labels, dependencies and comments nested inside — so removing a nested entry here, and leaving the issue itself in place, is exactly the drift shape where an issue survives the rebuild and a piece of its content does not.
 */
interface JsonlIssue {
  id: string;
  labels?: string[];
  dependencies?: {depends_on_id: string}[];
  comments?: {text: string}[];
  [key: string]: unknown;
}

function readJsonl(beadsDir: string): JsonlIssue[] {
  return readFileSync(join(beadsDir, 'issues.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as JsonlIssue);
}

function writeJsonl(beadsDir: string, records: JsonlIssue[]): void {
  writeFileSync(
    join(beadsDir, 'issues.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

/**
 * Edit ONE issue's JSONL record in place. Throws when the id is not there, so a fixture that silently changed shape fails loudly here instead of producing a test that asserts nothing.
 */
function editJsonlIssue(
  beadsDir: string,
  id: string,
  edit: (record: JsonlIssue) => void,
): void {
  const records = readJsonl(beadsDir);
  const target = records.find((r) => r.id === id);
  if (target == null) {
    throw new Error(`no issue ${id} in the fixture JSONL`);
  }
  edit(target);
  writeJsonl(beadsDir, records);
}

/** Remove an issue from the JSONL entirely, leaving it in the database only — content the rebuild DESTROYS. */
function dropJsonlIssue(beadsDir: string, id: string): void {
  const records = readJsonl(beadsDir);
  const kept = records.filter((r) => r.id !== id);
  if (kept.length === records.length) {
    throw new Error(`no issue ${id} in the fixture JSONL`);
  }
  writeJsonl(beadsDir, kept);
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

      expect(output).toContain('issues        : 4 now -> 4 after the rebuild');
      // The fixture carries comments, dependencies and labels, so this is also the no-FALSE-positive case for all three: a gate that cried loss on clean content would be as useless as one that missed it.
      expect(output).not.toContain('would be LOST');
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
      expect(output).toContain('issues        : 4 now -> 4 after the rebuild');
      expect(output).not.toContain('content_hash');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );

  test.skipIf(!hasBr)(
    'a row that exists only in the database would be LOST (1)',
    () => {
      const beadsDir = workspace();
      dropJsonlIssue(beadsDir, requireIds().delta);

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

/**
 * The three drift shapes this gate was actually built for.
 *
 * A whole issue vanishing from the JSONL is the easy case, and the exit-code contract above already pins it. The dangerous case is the quiet one: the issue is in the JSONL, so the counts match and every count-based check (`br doctor`, `sync --status`) reports a clean workspace — but a comment, a dependency or a label lives only in the database and the rebuild would erase it. Each test below removes exactly ONE nested entry from the JSONL and leaves everything else intact, then insists the tool names the thing that would go.
 *
 * Each also asserts the ISSUE was NOT reported lost. That is the discriminator: without it a test could pass on the already-covered "issue missing" branch and prove nothing about the branch it is named for.
 */
describe('beads-rebuild-dryrun detects content lost from inside an issue', () => {
  test.skipIf(!hasBr)('a COMMENT that exists only in the database (1)', () => {
    const beadsDir = workspace();
    const {alpha} = requireIds();
    editJsonlIssue(beadsDir, alpha, (record) => {
      const before = record.comments?.length ?? 0;
      record.comments = (record.comments ?? []).filter(
        (c) => c.text !== 'alpha second comment',
      );
      if (record.comments.length !== before - 1) {
        throw new Error('fixture drift: alpha had no "alpha second comment"');
      }
    });

    const {exitCode, output} = captureOutput(() =>
      runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
    );

    // The SPECIFIC missing comment, by its text — asserted before the exit code so a broken comment comparison fails here, on the thing it failed to see, rather than on a bare number.
    expect(output).toContain(`issue ${alpha}: a comments entry would be LOST`);
    expect(output).toContain('alpha second comment');
    expect(output).not.toContain('would NOT survive the rebuild');
    expect(output).toContain('WOULD BE LOST (1)');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
  });

  test.skipIf(!hasBr)(
    'a DEPENDENCY that exists only in the database (1)',
    () => {
      const beadsDir = workspace();
      const {alpha, gamma} = requireIds();
      // Gamma depends on alpha. Removing it from gamma's record leaves both issues present and only the edge missing.
      editJsonlIssue(beadsDir, gamma, (record) => {
        const before = record.dependencies?.length ?? 0;
        record.dependencies = (record.dependencies ?? []).filter(
          (d) => d.depends_on_id !== alpha,
        );
        if (record.dependencies.length !== before - 1) {
          throw new Error(`fixture drift: ${gamma} did not depend on ${alpha}`);
        }
      });

      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(output).toContain(`issue ${gamma}: a deps entry would be LOST`);
      // Naming the other END of the edge: a report that says "a dependency" without saying which is not actionable.
      expect(output).toContain(alpha);
      expect(output).not.toContain('would NOT survive the rebuild');
      expect(output).toContain('WOULD BE LOST (1)');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
    },
  );

  test.skipIf(!hasBr)('a LABEL that exists only in the database (1)', () => {
    const beadsDir = workspace();
    const {alpha} = requireIds();
    editJsonlIssue(beadsDir, alpha, (record) => {
      const before = record.labels?.length ?? 0;
      record.labels = (record.labels ?? []).filter((l) => l !== 'shared-label');
      if (record.labels.length !== before - 1) {
        throw new Error('fixture drift: alpha did not carry "shared-label"');
      }
    });

    const {exitCode, output} = captureOutput(() =>
      runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
    );

    expect(output).toContain(`issue ${alpha}: a labels entry would be LOST`);
    expect(output).toContain('shared-label');
    expect(output).not.toContain('would NOT survive the rebuild');
    expect(output).toContain('WOULD BE LOST (1)');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
  });
});

/**
 * Two things the tool must never do quietly: pass off a row-COUNT comparison as a row comparison, and treat `''` and `NULL` as the same value.
 */
describe('beads-rebuild-dryrun states the limits of its own comparison', () => {
  test.skipIf(!hasBr)(
    'names the row-compared and the count-only tables, on the all-clear too',
    () => {
      const beadsDir = workspace();
      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
      expect(output).toContain(
        'compared row-by-row : issues, comments, dependencies, labels',
      );
      // Named, not merely counted — a content table this tool does not know about has to be visible by name rather than waved through as "no change".
      expect(output).toContain('compared by COUNT ONLY');
      expect(output).toContain('events');
      expect(output).toContain('metadata');
      expect(output).toContain(
        'This all-clear covers the row-by-row tables named above',
      );
    },
  );

  test.skipIf(!hasBr)(
    'reports an empty-string field that becomes NULL instead of calling them equal',
    () => {
      const beadsDir = workspace();
      const {beta} = requireIds();
      // `assignee` is NULL in a fresh row and is not carried in the JSONL, so the rebuild restores it as NULL. Setting it to "" in the database — the one place the two states can be made to differ, since the JSONL has no spelling for either — leaves the pair "" now / NULL after: no content on either side, but not the same state. Under the previous `norm`, which folded both to null, this compared EQUAL and was never reported at all.
      const db = new Database(join(beadsDir, 'beads.db'));
      db.run('update issues set assignee = ? where id = ?', ['', beta]);
      db.close();

      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr()}),
      );

      expect(output).toContain('EMPTY-STATE CHANGES (1)');
      expect(output).toContain(
        `issue ${beta} field assignee: "" now, NULL after the rebuild`,
      );
      expect(output).toContain('both empty, but NOT the same state');
      // Reported, but not loss: nothing moved, so the gate must not block the migration over it.
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
    },
  );
});

/**
 * The catch-all in `runBeadsRebuildDryRun` is the last thing standing between an unforeseen throw and an exit code that means "I measured, and there is loss". It was only ever proven by hand-editing the source, which protects nothing — hence the injectable seam.
 */
describe('beads-rebuild-dryrun catch-all', () => {
  test.skipIf(!hasBr)(
    'an unforeseen throw is COULD NOT RUN (2), never a finding, and the temp copy is still removed',
    () => {
      const beadsDir = workspace();
      const strayBefore = strayTempDirs();

      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({
          beadsDir,
          brBin: requireBr(),
          onStagedForTest: () => {
            throw new Error('injected fault');
          },
        }),
      );

      // "unexpected failure" is the catch-all's own wording — proof the throw went through it rather than through a `cannotCheck`, which is the branch the other exit-2 tests already cover.
      expect(output).toContain('unexpected failure: Error: injected fault');
      expect(output).toContain('This is NOT an all-clear');
      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.cannotCheck);
      expect(exitCode).not.toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
      expect(exitCode).not.toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
      expect(strayTempDirs()).toEqual(strayBefore);
    },
  );
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

  test.skipIf(!hasBr)(
    '--keep prints WHERE it kept the working copy, and the copy is there',
    () => {
      const beadsDir = workspace();
      const {exitCode, output} = captureOutput(() =>
        runBeadsRebuildDryRun({beadsDir, brBin: requireBr(), keep: true}),
      );

      expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.safe);
      const match = /kept the working copy at (\S+)/.exec(output);
      // A working copy nobody can find is not kept, it is leaked.
      expect(match).not.toBeNull();
      const kept = match?.[1] ?? '';
      expect(existsSync(join(kept, '.beads', 'beads.db'))).toBe(true);
      rmSync(kept, {force: true, recursive: true});
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
    dropJsonlIssue(beadsDir, requireIds().delta);
    const {exitCode, output} = runCli(beadsDir);
    expect(output).toContain('WOULD BE LOST (1)');
    expect(exitCode).toBe(BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent);
  });
});
