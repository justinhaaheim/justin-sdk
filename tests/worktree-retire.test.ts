/**
 * worktree-retire (home-base-rub4v.1.1). Every test builds scratch repos with
 * linked worktrees under $TMPDIR; nothing here touches a real checkout. The
 * process check and the terminal prompt are injected, so no test needs lsof
 * or a TTY except the one that exercises the real lsof reader.
 */

import type {WorktreeEvidence} from '../src/worktree-retire/evidence';
import type {ProcessHandle} from '../src/worktree-retire/processes';
import type {RetireIo, RunSeams} from '../src/worktree-retire/run';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawn} from 'child_process';
import {createHash} from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {runPlanCommand} from '../src/worktree-retire/plan';
import {
  parseLsofFields,
  processesInside,
  readLsof,
} from '../src/worktree-retire/processes';
import {removeWorktree, runRunCommand} from '../src/worktree-retire/run';
import {
  addLinkedWorktree,
  addSubmodule,
  git,
  initPrimary,
  initRepo,
  withFileSubmodulesAllowed,
  write,
} from './git-fixtures';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) {
    // A test may leave a read-only directory behind on purpose.
    try {
      chmodSync(join(sb.path, 'wt', 'done', 'locked-dir'), 0o755);
    } catch {
      // not that test
    }
    sb.cleanup();
  }
});

const NO_PROCESS: ProcessHandle[] = [
  {command: 'elsewhere', fd: 'cwd', path: '/', pid: 1},
];

interface World {
  env: Record<string, string>;
  primary: string;
  sb: Sandbox;
  wt: string;
}

/**
 * A repo with two commits on main and one finished worktree `wt/done` on
 * branch `done`: no commit outside main, clean, a beads DB (ignored), a cache
 * (node_modules, ignored). Optionally an initialized, clean, pushed submodule.
 */
function world(options: {submodule?: boolean} = {}): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const primary = initPrimary(sb, {
    '.gitignore':
      'node_modules/\ntmp/\n.beads/*.db\n.beads/*.db-wal\n.beads/*.db-shm\n.beads/.br_history/\n',
    'a.txt': 'one\n',
    'locked-dir/kept.txt': 'tracked\n',
  });
  write(primary, 'b.txt', 'two\n');
  git(primary, ['add', 'b.txt']);
  git(primary, ['commit', '-qm', 'second']);
  if (options.submodule === true) {
    const source = initRepo(sb, 'sub-src', {'s.txt': 's\n'});
    const bare = join(sb.path, 'sub.git');
    git(sb.path, ['clone', '-q', '--bare', source, bare]);
    withFileSubmodulesAllowed(() => addSubmodule(primary, bare, 'sub'));
  }
  const wt = realpathSync(
    addLinkedWorktree(primary, join(sb.path, 'wt', 'done'), 'done'),
  );
  if (options.submodule === true) {
    withFileSubmodulesAllowed(() =>
      git(wt, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '-q',
      ]),
    );
  }
  write(wt, '.beads/beads.db', 'pretend sqlite\n');
  write(wt, '.beads/beads.db-wal', 'wal bytes\n');
  write(wt, '.beads/.br_history/issues.1.jsonl', '{"id":"x"}\n');
  write(wt, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  return {
    env: {
      HOME: sb.path,
      XDG_CONFIG_HOME: join(sb.path, 'config'),
      XDG_DATA_HOME: join(sb.path, 'data'),
      XDG_STATE_HOME: join(sb.path, 'state'),
    },
    primary: realpathSync(primary),
    sb,
    wt,
  };
}

function io(w: World, extra: {answer?: string | null; tty?: boolean} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const retireIo: RetireIo = {
    cwd: w.primary,
    env: w.env,
    isTty: extra.tty ?? true,
    prompt: () =>
      Promise.resolve(extra.answer === undefined ? '1' : extra.answer),
    stderr: (text) => {
      err.push(text);
      return Promise.resolve();
    },
    stderrStyle: PLAIN_STYLE,
    stdout: (text) => {
      out.push(text);
      return Promise.resolve();
    },
    stdoutStyle: PLAIN_STYLE,
  };
  return {err, io: retireIo, out};
}

function processes(handles: ProcessHandle[]) {
  return () => ({ok: true as const, value: handles});
}

async function plan(
  w: World,
  handles: ProcessHandle[] = NO_PROCESS,
): Promise<{file: string; out: string}> {
  const {io: retireIo, out, err} = io(w);
  const code = await runPlanCommand(
    {
      candidates: true,
      paths: [w.primary],
      repo: w.primary,
      seams: {readProcesses: processes(handles)},
    },
    retireIo,
  );
  expect(err.join('')).toBe('');
  expect(code).toBe(0);
  const dir = join(w.env.XDG_STATE_HOME ?? '', 'worktree-retire', 'plans');
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return {file: join(dir, files[0] ?? ''), out: out.join('')};
}

async function run(
  w: World,
  planFile: string,
  extra: {
    answer?: string | null;
    seams?: RunSeams;
    tty?: boolean;
  } = {},
) {
  const captured = io(w, extra);
  const code = await runRunCommand(
    {
      planFile,
      seams: {readProcesses: processes(NO_PROCESS), ...extra.seams},
    },
    captured.io,
  );
  return {code, err: captured.err.join(''), out: captured.out.join('')};
}

function branchExists(w: World, branch: string): boolean {
  try {
    git(w.primary, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Every entry under `root` (.git included): type, size, mode, mtime, content hash. */
function snapshot(
  root: string,
  skip: readonly string[] = [],
): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (skip.includes(abs)) continue;
      const stat = lstatSync(abs);
      const meta = `${stat.mode}:${stat.size}:${stat.mtimeMs}`;
      if (stat.isDirectory()) {
        result.set(abs, `dir:${meta}`);
        walk(abs);
      } else if (stat.isSymbolicLink()) {
        result.set(abs, `link:${meta}:${readlinkSync(abs)}`);
      } else {
        const hash = createHash('sha256')
          .update(readFileSync(abs))
          .digest('hex');
        result.set(abs, `file:${meta}:${hash}`);
      }
    }
  };
  walk(root);
  return result;
}

function changedEntries(
  before: Map<string, string>,
  after: Map<string, string>,
) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

describe('worktree-retire plan', () => {
  test('writes nothing but its plan file, and gives each worktree a verdict with reasons', async () => {
    const w = world({submodule: true});
    const outside = addLinkedWorktree(
      w.primary,
      join(w.sb.path, 'wt', 'ahead'),
      'ahead',
    );
    write(outside, 'new.txt', 'work\n');
    git(outside, ['add', 'new.txt']);
    git(outside, ['commit', '-qm', 'work not in main']);
    // A stale index stat: a plain `git status` would rewrite the index here.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(w.wt, 'a.txt'), past, past);
    const state = join(w.sb.path, 'state');
    const before = snapshot(w.sb.path, [state]);

    const {file, out} = await plan(w);

    expect(changedEntries(before, snapshot(w.sb.path, [state]))).toEqual([]);
    expect(readdirSync(state)).toEqual(['worktree-retire']);
    const written = JSON.parse(readFileSync(file, 'utf-8')) as {
      worktrees: WorktreeEvidence[];
    };
    const byName = new Map(written.worktrees.map((e) => [e.name, e]));
    expect(byName.get('done')?.verdict).toBe('eligible');
    expect(byName.get('done')?.submodules).toMatchObject({
      ok: true,
      value: [{initialized: true, path: 'sub', verified: true}],
    });
    expect(byName.get('done')?.beads).toMatchObject({
      ok: true,
      value: [
        {path: '.beads/.br_history/issues.1.jsonl', sha256: null},
        {path: '.beads/beads.db'},
        {path: '.beads/beads.db-wal'},
      ],
    });
    expect(byName.get('ahead')?.reasons).toEqual([
      '1 commit not in main (git cherry)',
    ]);
    expect(byName.get('primary')?.reasons).toEqual(['main checkout']);
    expect(out).toContain('Eligible to retire: 1');
    expect(out).toContain('Not eligible: 2');

    // Negative control: the snapshot sees an index rewrite.
    git(w.wt, ['status']);
    expect(changedEntries(before, snapshot(w.sb.path, [state]))).toContain(
      join(w.primary, '.git', 'worktrees', 'done', 'index'),
    );
  }, 30_000);

  test('a failed process check makes every worktree ineligible, never eligible', async () => {
    const w = world();
    const {io: retireIo, out} = io(w);
    await runPlanCommand(
      {
        candidates: true,
        paths: [],
        repo: w.primary,
        seams: {readProcesses: () => ({error: 'lsof: denied', ok: false})},
      },
      retireIo,
    );
    expect(out.join('')).toContain('Eligible to retire: 0');
    expect(out.join('')).toContain(
      'checking for live processes failed: lsof: denied',
    );
  }, 30_000);

  test('an ignored file that is not a cache makes it ineligible', async () => {
    const w = world();
    write(w.wt, 'tmp/.keep-dir/.gitkeep', '');
    chmodSync(join(w.wt, 'tmp'), 0o755);
    const withFile = await plan(w);
    expect(withFile.out).toContain(
      'ignored files that are not caches: tmp/ (1 file, 0 bytes)',
    );
  }, 30_000);
});

describe('worktree-retire run: refusals', () => {
  test('refuses without a TTY, and on a wrong typed count; the right count removes it', async () => {
    const w = world();
    const {file} = await plan(w);

    const noTty = await run(w, file, {tty: false});
    expect(noTty.code).toBe(2);
    expect(noTty.err).toContain('it needs a terminal');
    expect(existsSync(w.wt)).toBe(true);

    const wrong = await run(w, file, {answer: '2'});
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('you typed "2", not 1');
    expect(existsSync(w.wt)).toBe(true);

    const none = await run(w, file, {answer: null});
    expect(none.code).toBe(2);
    expect(existsSync(w.wt)).toBe(true);
    expect(existsSync(join(w.sb.path, 'data'))).toBe(false);

    // Negative control: the same plan, a terminal and the right count.
    const right = await run(w, file, {answer: '1'});
    expect(right.code).toBe(0);
    expect(existsSync(w.wt)).toBe(false);
    expect(branchExists(w, 'done')).toBe(true);
  }, 30_000);
});

/** One change per case, made after the plan and before the run. */
const CHANGES: {
  change: (w: World) => RunSeams | undefined;
  expect: string;
  name: string;
}[] = [
  {
    change: (w) => {
      write(w.wt, 'c.txt', 'new\n');
      git(w.wt, ['add', 'c.txt']);
      git(w.wt, ['commit', '-qm', 'late work']);
      return undefined;
    },
    expect: 'commits not in main: was "0", now "1"',
    name: 'a new commit',
  },
  {
    change: (w) => {
      write(w.wt, 'untracked.txt', 'new\n');
      return undefined;
    },
    expect: '?? untracked.txt',
    name: 'a new untracked file',
  },
  {
    change: (w) => {
      write(w.wt, 'a.txt', 'changed\n');
      return undefined;
    },
    expect: ' M a.txt',
    name: 'a modified file',
  },
  {
    change: (w) => {
      git(w.wt, ['reset', '-q', '--hard', 'HEAD~1']);
      return undefined;
    },
    expect: 'head: was',
    name: 'a moved HEAD',
  },
  {
    change: (w) => {
      write(w.wt, 'tmp/notes.md', 'mine\n');
      return undefined;
    },
    expect: 'tmp/ (1 file, 5 bytes)',
    name: 'a new non-cache ignored file',
  },
  {
    change: (w) => ({
      readProcesses: processes([
        ...NO_PROCESS,
        {command: 'claude', fd: 'cwd', path: w.wt, pid: 4242},
      ]),
    }),
    expect: 'pid 4242 (claude): cwd',
    name: 'a live process with its cwd inside',
  },
  {
    change: (w) => {
      git(w.primary, ['worktree', 'lock', w.wt]);
      return undefined;
    },
    expect: 'locked: was "not locked", now "locked"',
    name: 'a lock',
  },
];

describe('worktree-retire run: evidence changed since the plan', () => {
  for (const testCase of CHANGES) {
    test(`${testCase.name}: skipped, nothing removed; without it, removed`, async () => {
      const control = world();
      const controlPlan = await plan(control);
      const removed = await run(control, controlPlan.file);
      expect(removed.code).toBe(0);
      expect(existsSync(control.wt)).toBe(false);

      const w = world();
      const {file} = await plan(w);
      const seams = testCase.change(w);
      const skipped = await run(w, file, {seams});
      expect(skipped.code).toBe(1);
      expect(existsSync(w.wt)).toBe(true);
      expect(skipped.out).toContain('changed since the plan');
      expect(skipped.out).toContain(testCase.expect);
      expect(existsSync(join(w.sb.path, 'data'))).toBe(false);
    }, 30_000);
  }
});

describe('worktree-retire run: the beads copy', () => {
  test('a copy that does not verify keeps the worktree; a good copy is verified and kept', async () => {
    const w = world();
    const {file} = await plan(w);
    const corrupt = await run(w, file, {
      seams: {
        copyFile: (source, dest) => {
          writeFileSync(dest, 'not the bytes\n');
          const bytes = readFileSync(source);
          return {
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        },
      },
    });
    expect(corrupt.code).toBe(1);
    expect(corrupt.out).toContain(
      'the beads copy failed, so the worktree was NOT removed',
    );
    expect(existsSync(w.wt)).toBe(true);

    const full = await run(w, file, {
      seams: {freeBytes: () => 10, now: new Date(Date.now() + 2_000)},
    });
    expect(full.code).toBe(1);
    expect(full.out).toContain('free at');
    expect(existsSync(w.wt)).toBe(true);

    // Negative control: the real copy.
    const good = await run(w, file, {
      seams: {now: new Date(Date.now() + 5_000)},
    });
    expect(good.code).toBe(0);
    expect(existsSync(w.wt)).toBe(false);
    const backups = join(w.sb.path, 'data', 'beads-backups', 'primary');
    const stamps = readdirSync(backups).sort();
    const kept = join(backups, stamps.at(-1) ?? '', 'done');
    expect(readFileSync(join(kept, '.beads', 'beads.db'), 'utf-8')).toBe(
      'pretend sqlite\n',
    );
    expect(
      readFileSync(
        join(kept, '.beads', '.br_history', 'issues.1.jsonl'),
        'utf-8',
      ),
    ).toBe('{"id":"x"}\n');
    const log = readFileSync(
      join(w.sb.path, 'state', 'worktree-retire', 'log.jsonl'),
      'utf-8',
    );
    expect(log).toContain('"step":"beads-copy"');
    expect(log).toContain('"forced":false');
  }, 30_000);
});

describe('worktree-retire run: --force', () => {
  test('a clean, pushed submodule is the one case that removes with --force, and the branch survives', async () => {
    const w = world({submodule: true});
    const {file} = await plan(w);
    const result = await run(w, file);
    expect(result.out).toContain('removed (--force: verified submodules only)');
    expect(result.code).toBe(0);
    expect(existsSync(w.wt)).toBe(false);
    expect(branchExists(w, 'done')).toBe(true);
  }, 30_000);

  test('without a verified submodule, git refusing is a failure and --force is never tried', async () => {
    const w = world({submodule: true});
    const {file} = await plan(w);
    const planned = (
      JSON.parse(readFileSync(file, 'utf-8')) as {worktrees: WorktreeEvidence[]}
    ).worktrees.find((e) => e.name === 'done');
    if (planned?.submodules?.ok !== true) throw new Error('fixture');
    const unverified: WorktreeEvidence = {
      ...planned,
      submodules: {
        ok: true,
        value: planned.submodules.value.map((s) => ({...s, verified: false})),
      },
    };
    const result = removeWorktree(w.primary, unverified);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('containing submodules');
    expect(existsSync(join(w.wt, 'sub', 's.txt'))).toBe(true);
    // Negative control: the verified evidence removes it.
    expect(removeWorktree(w.primary, planned)).toEqual({
      forced: true,
      ok: true,
    });
  }, 30_000);

  test('a removal that fails part-way reports what is left', async () => {
    const w = world();
    const {file} = await plan(w);
    chmodSync(join(w.wt, 'locked-dir'), 0o555);
    const result = await run(w, file);
    expect(result.code).toBe(1);
    expect(existsSync(w.wt)).toBe(true);
    expect(result.out).toContain('git worktree remove failed');
    expect(result.out).toContain('the directory is still there');
  }, 30_000);
});

describe('the process check', () => {
  test('lsof fields parse into handles, and only paths inside the worktree count', () => {
    const handles = parseLsofFields(
      'p10\ncclaude\nfcwd\nn/r/wt/a\nf12w\nn/r/wt/a/.claude/.cc-writes/x\np11\nczsh\nfcwd\nn/r/wt/ab\n',
    );
    expect(handles).toHaveLength(3);
    expect(processesInside(handles, '/r/wt/a')).toEqual([
      'pid 10 (claude): cwd, open .claude/.cc-writes/x',
    ]);
    expect(processesInside(handles, '/r/wt')).toHaveLength(2);
  });

  test('the real lsof sees a process whose cwd is inside, and refuses a listing that cannot see itself', async () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const child = spawn('sleep', ['30'], {cwd: sb.path, stdio: 'ignore'});
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const read = readLsof();
      if (!read.ok) throw new Error(read.error);
      expect(processesInside(read.value, sb.path).join('\n')).toContain(
        `pid ${child.pid ?? -1} (sleep): cwd`,
      );
      const blind = readLsof(process.pid, '/no/such/cwd');
      expect(blind.ok).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);
});
