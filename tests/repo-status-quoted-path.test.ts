/**
 * A filename git had to QUOTE must not read as a filename that is not there
 * (home-base-qyu1.26).
 *
 * `changedPaths` consumed `git show --name-status` raw, and git applies
 * `core.quotePath` — default TRUE — to that output. `d/café.txt` therefore
 * arrived as the literal characters `"d/caf\303\251.txt"`, surrounding quotes
 * included. Nothing on any ref is called that, so every lookup of it came back
 * empty, and for a DELETED path "empty on the baseline" was `deletion-reflected`
 * — the most reassuring per-file verdict in `content.ts`. It feeds
 * `allFilesReflected` -> `allContentOnBaseline` -> `merged` with
 * `provenSafe: true`, the only field `plan`/`apply` act on.
 *
 * ── Why this one is worse than qyu1.24, which it otherwise resembles ─────────
 *
 * qyu1.24 needed a destroyed tree object. This needs NOTHING. The fixture below
 * is a healthy repo built entirely out of `git init`, `git add`, `git rm` — no
 * corruption, no shim, no transient. The trigger is a filename, and `café.txt`,
 * a CJK document name or an emoji asset are ordinary things for a repo to have
 * once held. That makes it the most reachable member of the false-provenSafe
 * family: every repo that ever deleted such a file on a branch was exposed.
 *
 * ── It was never only a non-ASCII bug ───────────────────────────────────────
 *
 * The old parser also `.trim()`ed each field, so `keep/trailing space ` — pure
 * 7-bit ASCII — lost its final space and resolved nowhere, producing the same
 * lie. `-z` fixes both at once, because under `-z` the record IS the filename:
 * no quoting, and no whitespace to strip.
 *
 * ── What each block is for ──────────────────────────────────────────────────
 *
 *   1. the mechanism, measured at the git level (quoting happens; the quoted
 *      string resolves nowhere while the real one resolves)
 *   2. the gauntlet: nine filename families, each deleted while the baseline
 *      still holds the file, all of which must read `deletion-not-reflected`
 *   3. the CONTROLS, in the same repo: a tricky-named deletion the baseline DID
 *      take still reads `deletion-reflected` and still reaches the safe group,
 *      so "refuse everything" fails here
 *   4. renames, whose `-z` framing is three records and whose answer is the
 *      POST-state path
 *   5. the `:(literal)` classifier from qyu1.24, whose behaviour on control
 *      characters was an explicit open question — measured here, and it holds
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  proveContentOnBaseline,
  verifyCommitFiles,
  type FileVerdict,
} from '../src/repo-status/content';
import {buildPlan, type CleanupPlan} from '../src/repo-status/plan';
import {
  buildReport,
  type BranchRow,
  type RepoStatusReport,
} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/**
 * Explicit per-test timeout for the arms that build the fixture repo and then
 * shell out to git many times (home-base-r47v F3).
 *
 * WHY: bun's default is 5s, and these are the slowest tests in the suite —
 * measured unloaded at 1.6–2.4s each, and one of them was observed taking 5.7s
 * during a full-suite run on a busy machine (it passes in isolation every time).
 * A ~2.4x load factor on a 2.4s test is not a bug worth chasing; a wall-clock
 * failure that only appears under load is a flake that trains people to re-run
 * the suite instead of reading it. The generous number is deliberate: these
 * assertions are about git's behaviour, never about speed.
 */
const GIT_FIXTURE_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

/** Run git without throwing, keeping the exit status and stderr. */
function gitRun(
  cwd: string,
  args: string[],
): {status: number; stderr: string; stdout: string} {
  const result = spawnSync('git', args, {cwd, encoding: 'utf-8'});
  return {
    status: result.status ?? -1,
    stderr: (result.stderr ?? '').trim(),
    stdout: result.stdout ?? '',
  };
}

// ---------------------------------------------------------------------------
// The gauntlet
// ---------------------------------------------------------------------------

/**
 * One basename per family of character git has to deal with specially.
 *
 * UNICODE NORMALISATION IS A LIVE HAZARD HERE, so it is checked rather than
 * hoped for. These literals are NFC (é as U+00E9); macOS hands filenames back
 * from the filesystem DECOMPOSED (`e` + U+0301) and only git's
 * `core.precomposeunicode` — on by default there, irrelevant on Linux — puts
 * them back together. If that ever stopped holding, every path here would
 * silently become a statement about a differently-spelled file. `buildFixture`
 * therefore asserts that `git ls-files` reports back exactly these strings, so a
 * normalisation change fails loudly at fixture-build time instead of quietly
 * passing. The emoji is escaped only because it is outside the BMP and reads
 * badly in diffs.
 */
const TRICKY: {name: string; quoted: boolean; slug: string}[] = [
  {name: 'café.txt', quoted: true, slug: 'accent'},
  {name: '日本語.txt', quoted: true, slug: 'cjk'},
  {name: 'emoji\u{1f600}.txt', quoted: true, slug: 'emoji'},
  {name: 'with\ttab.txt', quoted: true, slug: 'tab'},
  {name: 'with\nnewline.txt', quoted: true, slug: 'newline'},
  {name: 'with"quote.txt', quoted: true, slug: 'quote'},
  {name: 'with\\back.txt', quoted: true, slug: 'backslash'},
  // Not quoted by git — but the OLD parser's `.trim()` ate the final space, so
  // this pure-ASCII name produced the identical lie.
  {name: 'trailing space ', quoted: false, slug: 'trailing-space'},
  // Not quoted, not trimmed: the family that was ALWAYS handled correctly, kept
  // so a fix that broke ordinary paths shows up here.
  {name: 'with space.txt', quoted: false, slug: 'space'},
];

/** The families the old parser mangled — the ones that produced `merged`. */
const MANGLED = TRICKY.filter((t) => t.slug !== 'space');

const keptPath = (t: {name: string}): string => `keep/${t.name}`;
const gonePath = (t: {name: string}): string => `gone/${t.name}`;

const RENAME_BODY = [
  'a body long and distinctive enough that git pairs it with its own',
  'rename target and with nothing else in the same commit',
  'line three',
  '',
].join('\n');

const RENAME_SRC = 'rename-src.txt';
const RENAME_DST = 'renamé-dst.txt';
const AFTER_RENAME = 'zz-after-rename.txt';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function commit(repo: string, msg: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function write(repo: string, file: string, body: string): void {
  writeFileSync(join(repo, file), body);
}

function initRepo(sb: Sandbox, name: string): string {
  const repo = join(sb.path, name);
  mkdirSync(repo, {recursive: true});
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

/** A branch off `M1` that deletes exactly `paths`, and nothing else. */
function branchDeleting(
  repo: string,
  branch: string,
  paths: string[],
): string {
  git(repo, ['checkout', '-q', '-b', branch, 'M1']);
  git(repo, ['rm', '-q', '--', ...paths]);
  const sha = commit(repo, `${branch}: drop ${paths.length} path(s)`);
  git(repo, ['checkout', '-q', 'main']);
  return sha;
}

interface Fixture {
  /** Deletes every `keep/*` name — the baseline still has every one of them. */
  dropKeptSha: string;
  /** Deletes only the names the old parser mangled. */
  dropQuotedSha: string;
  /** Deletes every `gone/*` name — the baseline dropped them too. */
  dropGoneSha: string;
  /** The ASCII control: deletions genuinely reflected, plus an identical add. */
  genuineDeleteSha: string;
  /** A rename and a delete in ONE commit — three records then two. */
  renameSha: string;
  repo: string;
}

/**
 *   M0    anchor, rename-src, gone1, gone2, keep/<9 tricky>, gone/<9 tricky>
 *   main  M0 -- M1 (edit anchor) -- M2 (rm gone1 + every gone/*, add also.txt)
 *              -- M3 (rm gone2)
 *
 *   Every branch below forks at M1, so `git cherry` finds no patch-id match for
 *   any of them (main deletes the same paths in a DIFFERENT commit shape) and
 *   the verdict has to come from the per-file comparison — the code under test.
 *
 *   NOTHING is corrupted. This repo is exactly what `git init` builds.
 */
function buildFixture(sb: Sandbox): Fixture {
  const repo = initRepo(sb, 'repo');
  mkdirSync(join(repo, 'keep'), {recursive: true});
  mkdirSync(join(repo, 'gone'), {recursive: true});

  write(repo, 'anchor.txt', 'anchor\n');
  write(repo, RENAME_SRC, RENAME_BODY);
  // Sorts AFTER `rename-src.txt`, which is the point: git orders the records by
  // path, so this is what puts a status record on the far side of a rename
  // TRIPLET, where a one-path-per-status parser is already running off by one.
  write(repo, AFTER_RENAME, 'after\n');
  write(repo, 'gone1.txt', 'one\n');
  write(repo, 'gone2.txt', 'two\n');
  for (const t of TRICKY) {
    write(repo, keptPath(t), `kept ${t.slug}\n`);
    write(repo, gonePath(t), `gone ${t.slug}\n`);
  }
  commit(repo, 'M0');

  // The whole fixture rests on those names surviving `git add` byte-for-byte;
  // a filesystem that normalised or refused one would make every assertion
  // below a statement about some OTHER file.
  const tracked = new Set(
    git(repo, ['ls-files', '-z']).split('\0').filter((p) => p.length > 0),
  );
  for (const t of TRICKY) {
    for (const path of [keptPath(t), gonePath(t)]) {
      if (!tracked.has(path)) {
        throw new Error(
          `fixture did not record ${JSON.stringify(path)} — got ${JSON.stringify([...tracked])}`,
        );
      }
    }
  }

  write(repo, 'anchor.txt', 'anchor edited on main\n');
  commit(repo, 'M1: edit anchor');
  git(repo, ['tag', 'M1']);

  const dropKeptSha = branchDeleting(
    repo,
    'drop-kept',
    TRICKY.map(keptPath),
  );
  const dropQuotedSha = branchDeleting(
    repo,
    'drop-quoted',
    MANGLED.map(keptPath),
  );
  const dropGoneSha = branchDeleting(repo, 'drop-gone', TRICKY.map(gonePath));

  // The ASCII control, from qyu1.24: it drops both files in ONE commit where
  // main drops them in two, so no patch-id matches and the verdict comes from
  // the same per-file path the mangled branches go down.
  git(repo, ['checkout', '-q', '-b', 'genuine-delete', 'M1']);
  git(repo, ['rm', '-q', '--', 'gone1.txt', 'gone2.txt']);
  write(repo, 'also.txt', 'also\n');
  const genuineDeleteSha = commit(repo, 'genuine-delete: drop both, add also');
  git(repo, ['checkout', '-q', 'main']);

  // A rename AND two deletes in one commit, one either side of the rename in
  // git's path order: `D\0path\0R100\0old\0new\0D\0path\0`. A parser that took
  // one path per status would read `old` for the rename and then run one record
  // behind for everything after it.
  git(repo, ['checkout', '-q', '-b', 'rename-then-delete', 'M1']);
  git(repo, ['mv', RENAME_SRC, RENAME_DST]);
  git(repo, [
    'rm',
    '-q',
    '--',
    keptPath(TRICKY[0] as {name: string}),
    AFTER_RENAME,
  ]);
  const renameSha = commit(repo, 'rename-then-delete: mv and rm');
  git(repo, ['checkout', '-q', 'main']);

  git(repo, ['rm', '-q', '--', 'gone1.txt', ...TRICKY.map(gonePath)]);
  write(repo, 'also.txt', 'also\n');
  commit(repo, 'M2: rm gone1 and every gone/*, add also');
  git(repo, ['rm', '-q', '--', 'gone2.txt']);
  commit(repo, 'M3: rm gone2');

  return {
    dropGoneSha,
    dropKeptSha,
    dropQuotedSha,
    genuineDeleteSha,
    renameSha,
    repo,
  };
}

function reportFor(repo: string): RepoStatusReport {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

function rowsFor(repo: string): BranchRow[] {
  const rows = reportFor(repo).branches;
  if (rows == null) throw new Error('expected branch rows');
  return rows;
}

function byName(rows: BranchRow[], name: string): BranchRow {
  const row = rows.find((r) => r.name === name);
  if (row == null) throw new Error(`no row for ${name}`);
  return row;
}

function planFor(repo: string): CleanupPlan {
  const plan = buildPlan(reportFor(repo));
  if (plan == null) throw new Error('expected a plan');
  return plan;
}

function statuses(files: FileVerdict[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) out[file.path] = file.status;
  return out;
}

function expectAll(
  files: FileVerdict[],
  paths: string[],
  status: string,
): void {
  const expected: Record<string, string> = {};
  for (const path of paths) expected[path] = status;
  expect(statuses(files)).toEqual(expected);
}

// ---------------------------------------------------------------------------
// 1. The mechanism
// ---------------------------------------------------------------------------

describe('the quoting is real and the quoted string is not a path', () => {
  test('`--name-status` C-quotes; `-z` hands back the stored bytes', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const args = ['--name-status', '--format=', '-m', '--first-parent'];

    // What the parser used to read. Note there is no way to get the real name
    // back out of this: the quoting is applied per byte, and undoing it means
    // re-implementing git's C-quote reader in TypeScript.
    const quoted = gitRun(fx.repo, ['show', ...args, fx.renameSha]).stdout;
    expect(quoted).toContain('D\t"keep/caf\\303\\251.txt"');
    expect(quoted).toContain('R100\trename-src.txt\t"renam\\303\\251-dst.txt"');

    // What it reads now: NUL-terminated records, no quoting, status separate,
    // and the rename spending THREE records where every other status spends two.
    const raw = gitRun(fx.repo, ['show', '-z', ...args, fx.renameSha]).stdout;
    expect(raw).toBe(
      `D\0keep/café.txt\0R100\0${RENAME_SRC}\0${RENAME_DST}\0D\0${AFTER_RENAME}\0`,
    );
  });

  test('the quoted spelling resolves nowhere while the real one resolves', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // THIS is the whole bug in two commands. The parser handed the first string
    // to the baseline lookup; git answered "no such path"; the D-status branch
    // called that a reflected deletion.
    const asQuoted = gitRun(fx.repo, [
      'rev-parse',
      'main:"keep/caf\\303\\251.txt"',
    ]);
    const asStored = gitRun(fx.repo, ['rev-parse', 'main:keep/café.txt']);
    expect(asQuoted.status).not.toBe(0);
    expect(asStored.status).toBe(0);

    // And the classifier agrees the quoted spelling is a genuine ABSENCE, not a
    // failed read — so nothing downstream had any signal that anything was off.
    const ls = gitRun(fx.repo, [
      'ls-tree',
      '--full-tree',
      'main',
      '--',
      ':(literal)"keep/caf\\303\\251.txt"',
    ]);
    expect({status: ls.status, stdout: ls.stdout}).toEqual({
      status: 0,
      stdout: '',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The gauntlet
// ---------------------------------------------------------------------------

describe('a deletion the baseline did NOT take never reads as reflected', () => {
  test('every filename family answers `deletion-not-reflected`', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.dropKeptSha, 'main', fx.repo);
    // The assertion is on the WHOLE map, so a path arriving under a mangled
    // spelling fails as a missing key rather than passing unnoticed.
    expectAll(files, TRICKY.map(keptPath), 'deletion-not-reflected');
    expect(files).toHaveLength(TRICKY.length);
  });

  test('the branch is refused, and the plan proposes nothing for it', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const proof = proveContentOnBaseline('drop-quoted', 'main', fx.repo);
    expect(proof.allContentOnBaseline).toBe(false);

    // Before the fix this row read `merged` / `provenSafe: true` — on a repo
    // with nothing wrong with it — and the plan offered to archive and delete
    // the branch. `drop-quoted` holds ONLY mangled names for exactly that
    // reason: one correctly-read path would have masked the lie.
    const row = byName(rowsFor(fx.repo), 'drop-quoted');
    expect(row.provenSafe).toBe(false);
    expect(row.disposition).not.toBe('merged');

    const plan = planFor(fx.repo);
    expect(plan.safe.map((a) => a.branch)).not.toContain('drop-quoted');
    expect(plan.needsJudgment.map((a) => a.branch)).toContain('drop-quoted');
  }, GIT_FIXTURE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 3. The controls — a fix that refuses everything fails here
// ---------------------------------------------------------------------------

describe('deletions the baseline DID take still read as reflected', () => {
  test('tricky names included — this is the qyu1.24 classifier on live input', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // `rev-parse main:gone/café.txt` fails here because the path is genuinely
    // gone from main, so every one of these goes through the `:(literal)`
    // ls-tree classifier — with a tab, a newline, a quote and a backslash in
    // the pathspec. qyu1.24 shipped that classifier with its control-character
    // behaviour explicitly unproven; this is the proof.
    const files = verifyCommitFiles(fx.dropGoneSha, 'main', fx.repo);
    expectAll(files, TRICKY.map(gonePath), 'deletion-reflected');

    const row = byName(rowsFor(fx.repo), 'drop-gone');
    expect({disposition: row.disposition, provenSafe: row.provenSafe}).toEqual({
      disposition: 'merged',
      provenSafe: true,
    });
  }, GIT_FIXTURE_TIMEOUT_MS);

  test('the ASCII control is still merged, and still acted on', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.genuineDeleteSha, 'main', fx.repo);
    expect(statuses(files)).toEqual({
      'also.txt': 'identical',
      'gone1.txt': 'deletion-reflected',
      'gone2.txt': 'deletion-reflected',
    });

    // A healthy repo's per-file JSON carries no key that did not exist before
    // qyu1.24 — the byte-identity bar, asserted rather than assumed.
    for (const file of files) {
      expect(Object.keys(file).sort()).toEqual(['path', 'status']);
    }

    const plan = planFor(fx.repo);
    expect(
      plan.safe
        .filter((a) => a.action === 'archive-local-branch')
        .map((a) => a.branch)
        .sort(),
    ).toEqual(['drop-gone', 'genuine-delete']);
  }, GIT_FIXTURE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 4. Renames
// ---------------------------------------------------------------------------

describe('a rename resolves to the post-state path', () => {
  test('three records then two, with the delete after it still aligned', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.renameSha, 'main', fx.repo);
    // Two things at once: the rename answers `renamé-dst.txt` (not the `old`
    // record, and not a quoted spelling), and the `D` record AFTER the triplet
    // is still read as a status rather than as a path. An off-by-one there
    // would put `zz-after-rename.txt` in the status slot and a status letter in
    // the path slot — and a garbage path resolves nowhere, which is
    // `deletion-reflected` all over again.
    //
    // `rename-src.txt` was NOT in this map when qyu1.26 wrote it, and its
    // arrival is qyu1.27 landing rather than a regression: the rename's old
    // half is now checked as the deletion it is, and main — which created
    // `rename-src.txt` in M0 and never removed it — has not taken that
    // deletion. Whole-map `toEqual` is what forced this to be declared instead
    // of slipping through, which is exactly why it is written that way.
    expect(statuses(files)).toEqual({
      'keep/café.txt': 'deletion-not-reflected',
      'rename-src.txt': 'deletion-not-reflected',
      'renamé-dst.txt': 'absent-on-baseline',
      'zz-after-rename.txt': 'deletion-not-reflected',
    });
    expect(files.find((f) => f.path === 'rename-src.txt')?.renamedTo).toBe(
      RENAME_DST,
    );

    const row = byName(rowsFor(fx.repo), 'rename-then-delete');
    expect(row.provenSafe).toBe(false);
  }, GIT_FIXTURE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 5. The `:(literal)` classifier, measured directly
// ---------------------------------------------------------------------------

describe('`:(literal)` survives every filename family', () => {
  test('present answers with a line, absent answers with nothing, neither errors', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const results = TRICKY.map((t) => {
      const present = gitRun(fx.repo, [
        'ls-tree',
        '--full-tree',
        'main',
        '--',
        `:(literal)${keptPath(t)}`,
      ]);
      const absent = gitRun(fx.repo, [
        'ls-tree',
        '--full-tree',
        'main',
        '--',
        `:(literal)${gonePath(t)}`,
      ]);
      return {
        absent: {status: absent.status, empty: absent.stdout.trim() === ''},
        present: {status: present.status, empty: present.stdout.trim() === ''},
        slug: t.slug,
      };
    });

    expect(results).toEqual(
      TRICKY.map((t) => ({
        absent: {status: 0, empty: true},
        present: {status: 0, empty: false},
        slug: t.slug,
      })),
    );
  });

  /**
   * A KNOWN WART, pinned so it is not rediscovered as a surprise: `git rev-parse
   * <ref>:<path>` does NOT fail for a path containing `*`, `[` or `?`. It exits
   * 0 and echoes the argument back verbatim, because rev-parse also serves as an
   * argument splitter and a glob is an argument to it. `lookupPathOnRef` reads
   * that as `{kind: 'present', sha: '<ref>:<path>'}` — a fabricated sha for a
   * path that is not there.
   *
   * It degrades SAFE in every reachable shape (a fabricated `present` makes a
   * deletion `deletion-not-reflected` and a modification `differs`, both of
   * which keep the branch out of the safe group), which is why it is recorded
   * here rather than changed under qyu1.26: correcting it moves verdicts TOWARD
   * `provenSafe`, and that is not a change to make as a side effect of a
   * different fix. This test exists so the next reader finds a measurement
   * instead of rediscovering a surprise.
   */
  test('rev-parse echoes a glob path back instead of failing (known wart)', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const glob = gitRun(fx.repo, ['rev-parse', 'main:gone/star*.txt']);
    expect({status: glob.status, stdout: glob.stdout.trim()}).toEqual({
      status: 0,
      stdout: 'main:gone/star*.txt',
    });

    // The same absent path with no glob character fails, the way the rest of
    // this module assumes every absent path does.
    expect(gitRun(fx.repo, ['rev-parse', 'main:gone/star.txt']).status).not.toBe(
      0,
    );

    // `:(literal)` is unaffected either way — it answers "absent" for both.
    for (const path of ['gone/star*.txt', 'gone/star.txt']) {
      const ls = gitRun(fx.repo, [
        'ls-tree',
        '--full-tree',
        'main',
        '--',
        `:(literal)${path}`,
      ]);
      expect({status: ls.status, stdout: ls.stdout.trim()}).toEqual({
        status: 0,
        stdout: '',
      });
    }
  });
});
