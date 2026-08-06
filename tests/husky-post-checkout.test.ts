/**
 * The `.husky/post-checkout` auto-hydration preamble, over REAL git
 * (home-base-v170.12).
 *
 * These tests run an actual `git worktree add` against an actual husky-shaped
 * repo, because every load-bearing fact here IS git/husky behavior and mocking
 * it would test nothing. All four were verified empirically before the preamble
 * was written:
 *
 *  1. git runs post-checkout with cwd = the NEW worktree (so bare
 *     `worktree-setup`, which defaults to cwd, targets the right tree).
 *  2. `[ -d node_modules ]` is FALSE there — the guard fires exactly once, at
 *     creation.
 *  3. `git worktree list --porcelain`'s first line, read from inside the new
 *     tree, is the MAIN worktree — the SDK-resolution anchor.
 *  4. A non-zero post-checkout makes `git worktree add` ITSELF exit non-zero
 *     (the tree is still created). That is why the preamble must be non-fatal:
 *     an offline hydrate would otherwise look like a failed worktree creation.
 *
 * The husky shim is reproduced faithfully, including `sh -e` (errexit) — the
 * thing the preamble's `||` handling has to survive — and lives ONLY in the
 * primary checkout, since husky's `.husky/_` is gitignored and therefore absent
 * from every fresh worktree. Git resolves the relative `core.hooksPath` against
 * the primary, so the shim and the hook TEXT come from the primary while cwd is
 * the new tree.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, existsSync, mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {
  composePostCheckout,
  readPostCheckoutPreamble,
} from '../src/husky-setup';
import {initPrimary} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop()?.cleanup();
  }
});

/** This SDK checkout — the CLI the fixture's fake `justin-sdk` binary runs. */
const SDK_ROOT = resolve(import.meta.dirname, '..');

/**
 * husky v9's `_/h` shim, reduced to the parts that matter here: locate the
 * user hook next to `_` (relative to `$0`, i.e. in the PRIMARY checkout) and run
 * it with `sh -e`. The relative `node_modules/.bin` PATH prepend is kept because
 * husky really does it, and in a fresh worktree it resolves to nothing — which
 * is precisely why the preamble cannot rely on it.
 */
const HUSKY_SHIM = `#!/usr/bin/env sh
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n
[ ! -f "$s" ] && exit 0
export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
`;

/** Observable proof that hydration ran, with cwd = the new worktree. */
const MARKER_FILE = '.hydration-marker';
const MARKER_SCRIPT = `printf hydrated > ${MARKER_FILE}`;

function preamble(): string {
  const text = readPostCheckoutPreamble();
  if (text == null) throw new Error('preamble template unreadable');
  return text;
}

/**
 * A husky-shaped primary checkout whose post-checkout hook is the REAL composed
 * hook text, plus a `node_modules/.bin/justin-sdk` that the preamble's own
 * resolution chain discovers on its own — so the shipped chain is what runs,
 * not a test-only substitute.
 *
 * The hook text comes from `composePostCheckout` rather than a full
 * `runHuskySetup` on purpose: base-setup would add the SDK as a github: devDep,
 * and then the hydration's `bun install` would need the network. This fixture
 * stays hermetic.
 */
function huskyPrimary(
  sb: Sandbox,
  options: {sdkBin: string; hookText?: string},
): string {
  const composed = composePostCheckout(options.hookText ?? null, preamble());
  if (!('content' in composed)) {
    throw new Error(`unexpected composition: ${composed.kind}`);
  }

  const primary = initPrimary(sb, {
    '.gitignore': 'node_modules/\n',
    '.husky/post-checkout': composed.content,
    'package.json': `${JSON.stringify(
      {
        name: 'fixture-root',
        scripts: {'worktree-source:lint:MARKER': MARKER_SCRIPT},
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
  });

  // Untracked on purpose (husky gitignores `.husky/_`), so no worktree has it.
  mkdirSync(join(primary, '.husky', '_'), {recursive: true});
  writeFileSync(join(primary, '.husky', '_', 'post-checkout'), HUSKY_SHIM);
  chmodSync(join(primary, '.husky', '_', 'post-checkout'), 0o755);

  // The primary's installed SDK binary — first link of the resolution chain.
  mkdirSync(join(primary, 'node_modules', '.bin'), {recursive: true});
  const binPath = join(primary, 'node_modules', '.bin', 'justin-sdk');
  writeFileSync(binPath, options.sdkBin);
  chmodSync(binPath, 0o755);

  spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], {cwd: primary});
  return primary;
}

function mkdirParent(path: string): void {
  mkdirSync(join(path, '..'), {recursive: true});
}

/** `git worktree add`, capturing status + the hook's output. */
function addWorktree(
  primary: string,
  dest: string,
): {output: string; status: number | null} {
  mkdirParent(dest);
  const run = spawnSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'worktree-probe', dest, 'main'],
    {cwd: primary, encoding: 'utf-8'},
  );
  return {output: `${run.stdout ?? ''}${run.stderr ?? ''}`, status: run.status};
}

describe('.husky/post-checkout auto-hydration over real git', () => {
  test('a fresh worktree hydrates itself: worktree-setup runs, exit 0', () => {
    const sb = track(createSandbox());
    const primary = huskyPrimary(sb, {
      sdkBin: `#!/bin/sh\nexec bun ${JSON.stringify(join(SDK_ROOT, 'src', 'cli.ts'))} "$@"\n`,
    });
    const dest = join(sb.path, 'wt');

    const added = addWorktree(primary, dest);

    // The preamble fired (guard saw an absent node_modules) …
    expect(added.output).toContain('Fresh checkout detected');
    // … the real worktree-setup ran, with cwd = the NEW tree …
    expect(added.output).toContain('worktree-setup');
    expect(existsSync(join(dest, MARKER_FILE))).toBe(true);
    // … and it hydrated THIS tree, not the primary.
    expect(existsSync(join(primary, MARKER_FILE))).toBe(false);
    // Worktree creation itself stayed clean.
    expect(added.status).toBe(0);
    expect(added.output).not.toContain('WARNING');
  }, 60_000);

  test('a failing hydrate warns and still exits 0 — worktree creation is never blocked', () => {
    const sb = track(createSandbox());
    const primary = huskyPrimary(sb, {
      // Stands in for every real failure of this shape: offline, bun missing,
      // a corrupt bunx cache, a broken SDK pin.
      sdkBin: '#!/bin/sh\necho "simulated hydrate failure" >&2\nexit 1\n',
    });
    const dest = join(sb.path, 'wt');

    const added = addWorktree(primary, dest);

    expect(added.status).toBe(0);
    expect(added.output).toContain('simulated hydrate failure');
    expect(added.output).toContain('this tree is NOT hydrated');
    // The warning names the exact manual command, the whole point of warning.
    expect(added.output).toContain(
      'bunx github:justinhaaheim/justin-sdk worktree-setup',
    );
    // Nothing was hydrated, and the tree still exists to be fixed by hand.
    expect(existsSync(join(dest, MARKER_FILE))).toBe(false);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
  }, 60_000);

  test('an ordinary branch switch in a hydrated tree skips the preamble entirely', () => {
    const sb = track(createSandbox());
    const primary = huskyPrimary(sb, {
      // Would fail loudly if it ever ran — the node_modules guard must not
      // let it. This is the "branch switches stay free" claim, tested.
      sdkBin: '#!/bin/sh\necho "MUST NOT RUN" >&2\nexit 1\n',
    });

    // The fixture's primary has node_modules (it holds the fake SDK binary),
    // which is exactly the state of any established checkout.
    expect(existsSync(join(primary, 'node_modules'))).toBe(true);
    spawnSync('git', ['branch', 'other', 'main'], {cwd: primary});
    const switched = spawnSync('git', ['checkout', '-q', 'other'], {
      cwd: primary,
      encoding: 'utf-8',
    });
    const output = `${switched.stdout ?? ''}${switched.stderr ?? ''}`;

    expect(switched.status).toBe(0);
    expect(output).not.toContain('MUST NOT RUN');
    expect(output).not.toContain('Fresh checkout detected');
    expect(existsSync(join(primary, MARKER_FILE))).toBe(false);
  }, 60_000);
});
