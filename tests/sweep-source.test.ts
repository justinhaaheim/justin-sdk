/**
 * SWEEP PROVENANCE (home-base-ovzv): what code is this sweep about to
 * propagate, and does it refuse to propagate an unreleased build?
 *
 * Three levels:
 *
 *  - `describeSweepSource` over INJECTED git output — every verdict, including
 *    the ones only a failed probe can produce;
 *  - `resolveSweepSource` against REAL git fixtures — the `.git`-entry check
 *    that keeps a packaged copy from reporting its host repo's provenance;
 *  - `runSweep` itself — the header, the refusal (before any repo is touched),
 *    `--allow-unreleased`, and the dry-run warning.
 */

import {describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync} from 'fs';
import {join} from 'path';

import {runSweep, SWEEP_WORKTREE_SEGMENTS} from '../src/sweep';
import {
  describeSweepSource,
  formatSweepSource,
  readSweepSourceInputs,
  resolveSweepSource,
  type SweepSource,
  type SweepSourceInputs,
} from '../src/sweep-source';
import {git, initRepo, write} from './git-fixtures';
import {createSandbox} from './sandbox';

/** A checkout whose every probe succeeded: clean, one tag, one sha. */
const AT_TAG: SweepSourceInputs = {
  branch: 'main',
  hasGitEntry: true,
  headSha: 'abc1234def5678',
  porcelain: '',
  tagsAtHead: 'v0.32.0\n',
};

function inputs(overrides: Partial<SweepSourceInputs>): SweepSourceInputs {
  return {...AT_TAG, ...overrides};
}

describe('describeSweepSource', () => {
  test('no .git entry of either kind → packaged (a bunx cache or node_modules copy)', () => {
    expect(describeSweepSource(inputs({hasGitEntry: false}))).toEqual({
      kind: 'packaged',
    });
  });

  test('a clean checkout at a tag → tag, naming the tag and the sha', () => {
    expect(describeSweepSource(AT_TAG)).toEqual({
      kind: 'tag',
      sha: 'abc1234def5678',
      tag: 'v0.32.0',
    });
  });

  test('a v-prefixed tag wins when both shapes point at HEAD', () => {
    // The measured nondeterminism this rule exists for: the repo carries both
    // `0.14.0` and `v0.14.0` (justin-sdk CLAUDE.md).
    const source = describeSweepSource(
      inputs({tagsAtHead: '0.14.0\nv0.14.0\n'}),
    );
    expect(source).toEqual({
      kind: 'tag',
      sha: 'abc1234def5678',
      tag: 'v0.14.0',
    });
  });

  test('with no v-prefixed tag, the tie breaks by sort order (stable, not arbitrary)', () => {
    const source = describeSweepSource(inputs({tagsAtHead: 'zeta\n0.14.0\n'}));
    expect(source).toEqual({kind: 'tag', sha: 'abc1234def5678', tag: '0.14.0'});
  });

  test('a branch with no tag → unreleased, naming the branch', () => {
    expect(
      describeSweepSource(inputs({branch: 'thread-followups', tagsAtHead: ''})),
    ).toEqual({
      branch: 'thread-followups',
      dirty: false,
      kind: 'unreleased',
      sha: 'abc1234def5678',
    });
  });

  test('a detached HEAD with no tag → unreleased with a null branch', () => {
    expect(describeSweepSource(inputs({branch: null, tagsAtHead: ''}))).toEqual(
      {
        branch: null,
        dirty: false,
        kind: 'unreleased',
        sha: 'abc1234def5678',
      },
    );
  });

  test('a DIRTY tree is unreleased even sitting exactly on a tag', () => {
    // The running bytes are not the tagged bytes, and the union has no way to
    // say "tag, but modified" — so saying "tag" would hide the modification.
    expect(
      describeSweepSource(inputs({porcelain: ' M src/sweep.ts\n'})),
    ).toEqual({
      branch: 'main',
      dirty: true,
      kind: 'unreleased',
      sha: 'abc1234def5678',
    });
  });

  test('a FAILED status probe is unreleased with dirty=null — never "clean, at a tag"', () => {
    expect(describeSweepSource(inputs({porcelain: null}))).toEqual({
      branch: 'main',
      dirty: null,
      kind: 'unreleased',
      sha: 'abc1234def5678',
    });
  });

  test('a FAILED sha probe is unreleased with sha=null, even with a tag and a clean tree', () => {
    expect(describeSweepSource(inputs({headSha: null}))).toEqual({
      branch: 'main',
      dirty: false,
      kind: 'unreleased',
      sha: null,
    });
  });

  test('a FAILED tag probe is unreleased — a command that could not run is not a release', () => {
    expect(describeSweepSource(inputs({tagsAtHead: null})).kind).toBe(
      'unreleased',
    );
  });
});

describe('formatSweepSource', () => {
  test('renders each verdict', () => {
    expect(formatSweepSource({kind: 'packaged'})).toBe('packaged');
    expect(
      formatSweepSource({kind: 'tag', sha: 'abc1234def', tag: 'v0.32.0'}),
    ).toBe('v0.32.0');
    expect(
      formatSweepSource({
        branch: 'ovzv',
        dirty: false,
        kind: 'unreleased',
        sha: 'abc1234def5678',
      }),
    ).toBe('UNRELEASED: branch ovzv @ abc1234');
    expect(
      formatSweepSource({
        branch: 'ovzv',
        dirty: true,
        kind: 'unreleased',
        sha: 'abc1234def5678',
      }),
    ).toBe('UNRELEASED: branch ovzv @ abc1234, dirty');
    expect(
      formatSweepSource({
        branch: null,
        dirty: null,
        kind: 'unreleased',
        sha: null,
      }),
    ).toBe('UNRELEASED: detached HEAD @ sha unknown, dirty unknown');
  });
});

describe('resolveSweepSource against real git', () => {
  test('a checkout on a branch with no tag reads as unreleased, and dirtying it shows', () => {
    const sb = createSandbox();
    const repo = initRepo(sb, 'sdk', {'package.json': '{}\n'});

    const clean = resolveSweepSource(repo);
    expect(clean.kind).toBe('unreleased');
    expect(clean).toMatchObject({branch: 'main', dirty: false});
    expect((clean as {sha: string | null}).sha).toMatch(/^[0-9a-f]{40}$/);

    write(repo, 'package.json', '{"changed": true}\n');
    expect(resolveSweepSource(repo)).toMatchObject({
      dirty: true,
      kind: 'unreleased',
    });
    sb.cleanup();
  });

  test('a clean checkout at a tag reads as that tag', () => {
    const sb = createSandbox();
    const repo = initRepo(sb, 'sdk', {'package.json': '{}\n'});
    git(repo, ['tag', 'v1.2.3']);

    expect(resolveSweepSource(repo)).toMatchObject({
      kind: 'tag',
      tag: 'v1.2.3',
    });
    sb.cleanup();
  });

  test('a directory with no .git INSIDE a git repo is packaged — not the host repo’s provenance', () => {
    // The node_modules case, and the reason the `.git` check short-circuits
    // before any `git -C` call: `git -C` walks UP, so an installed copy under a
    // consumer repo sitting on a release tag would otherwise report that tag as
    // the SDK's own — unreleased code reading as released.
    const sb = createSandbox();
    const host = initRepo(sb, 'consumer', {'package.json': '{}\n'});
    git(host, ['tag', 'v9.9.9']);
    const installed = join(
      host,
      'node_modules',
      '@justinhaaheim',
      'justin-sdk',
    );
    mkdirSync(installed, {recursive: true});

    expect(resolveSweepSource(host)).toMatchObject({kind: 'tag'});
    expect(resolveSweepSource(installed)).toEqual({kind: 'packaged'});
    expect(readSweepSourceInputs(installed)).toEqual({
      branch: null,
      hasGitEntry: false,
      headSha: null,
      porcelain: null,
      tagsAtHead: null,
    });
    sb.cleanup();
  });
});

// ---------------------------------------------------------------------------
// The gate in runSweep
// ---------------------------------------------------------------------------

const UNRELEASED: SweepSource = {
  branch: 'thread-followups',
  dirty: false,
  kind: 'unreleased',
  sha: '9f9f9f9f9f9f9f9f9f',
};
const AT_A_RELEASE_TAG: SweepSource = {
  kind: 'tag',
  sha: '1111111111111111111111111111111111111111',
  tag: 'v9.9.9',
};

async function captureLog<T>(
  fn: () => Promise<T>,
): Promise<{value: T; out: string}> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const value = await fn();
    return {out: lines.join('\n'), value};
  } finally {
    console.log = original;
  }
}

/**
 * A plain directory is enough for every test here: the refusal must happen
 * BEFORE the first repo, and a repo that IS reached announces itself with the
 * `▸ <name>` line and is then blocked as "not a git repository". So `▸` is the
 * marker for "the gate let this through", with no e2e fixture to build.
 */
function targetDir(sbPath: string, name: string): string {
  const dir = join(sbPath, name);
  mkdirSync(dir, {recursive: true});
  return dir;
}

describe('runSweep provenance gate', () => {
  test('a non-dry-run sweep from an unreleased checkout REFUSES, exit 1, before touching any repo', async () => {
    const sb = createSandbox();
    const repo = targetDir(sb.path, 'target');

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
        source: UNRELEASED,
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('REFUSING to sweep');
    // The message has to carry what to do about it, and what was run.
    expect(out).toContain('UNRELEASED: branch thread-followups @ 9f9f9f9');
    expect(out).toContain('--allow-unreleased');
    expect(out).toContain('Nothing was touched.');
    // Nothing was touched, proven: no repo ever announced itself, and no
    // per-repo summary was produced.
    expect(out).not.toContain('▸ target');
    expect(out).not.toContain('Summary');
    expect(existsSync(join(repo, ...SWEEP_WORKTREE_SEGMENTS))).toBe(false);
    sb.cleanup();
  });

  test('--allow-unreleased proceeds, warning loudly', async () => {
    const sb = createSandbox();
    const repo = targetDir(sb.path, 'target');

    const {out} = await captureLog(() =>
      runSweep({
        allowUnreleased: true,
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
        source: UNRELEASED,
      }),
    );

    expect(out).toContain('sweeping from an UNRELEASED justin-sdk');
    expect(out).toContain('--allow-unreleased');
    expect(out).not.toContain('REFUSING');
    expect(out).toContain('▸ target');
    sb.cleanup();
  });

  test('--dry-run from an unreleased checkout proceeds with the warning, never the refusal', async () => {
    const sb = createSandbox();
    const repo = targetDir(sb.path, 'target');

    const {out} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        dryRun: true,
        logDir: join(sb.path, 'logs'),
        repos: [repo],
        source: UNRELEASED,
      }),
    );

    expect(out).toContain('sweeping from an UNRELEASED justin-sdk');
    expect(out).toContain('dry-run: nothing will change');
    expect(out).not.toContain('REFUSING');
    expect(out).toContain('▸ target');
    sb.cleanup();
  });

  test('a tagged source proceeds with no warning, and the header names the tag', async () => {
    const sb = createSandbox();
    const repo = targetDir(sb.path, 'target');

    const {out} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
        source: AT_A_RELEASE_TAG,
      }),
    );

    expect(out).toContain('(v9.9.9)');
    expect(out).not.toContain('REFUSING');
    expect(out).not.toContain('UNRELEASED');
    expect(out).toContain('▸ target');
    sb.cleanup();
  });

  test('a packaged source proceeds — its pin is its provenance', async () => {
    const sb = createSandbox();
    const repo = targetDir(sb.path, 'target');

    const {out} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
        source: {kind: 'packaged'},
      }),
    );

    expect(out).toContain('(packaged)');
    expect(out).not.toContain('REFUSING');
    expect(out).toContain('▸ target');
    sb.cleanup();
  });

  test('the header names the running version, not yargs’ guess', async () => {
    const sb = createSandbox();
    const {out} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        dryRun: true,
        logDir: join(sb.path, 'logs'),
        repos: [],
        source: AT_A_RELEASE_TAG,
      }),
    );

    const pkg = (await Bun.file(
      join(import.meta.dirname, '..', 'package.json'),
    ).json()) as {version: string};
    expect(out).toContain(`justin-sdk sweep ${pkg.version}`);
    sb.cleanup();
  });
});
