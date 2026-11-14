/**
 * The git pin (tests/pinned-git.ts, home-base-ejsq2.2).
 *
 * What these tests hold it to:
 *  - In this run, on a Mac with xcrun, the preload pinned git: a child `git`
 *    resolves to the pin's symlink, which points at the binary the shim runs,
 *    and the shim's own environment variables do not appear.
 *  - Given a shim, an xcrun and a binary of the same version, it pins: one new
 *    directory, holding only `git`, first on PATH, once.
 *  - Every reason not to pin (no xcrun, xcrun failing, versions that differ,
 *    a git on PATH that is not the shim, no git at all) leaves PATH alone,
 *    makes no directory, and prints exactly one line naming the reason.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

import {
  applyGitPin,
  GIT_SHIM,
  type GitPin,
  type GitPinInputs,
  installedGitPin,
  resolveGitPin,
  unpinnedLine,
} from './pinned-git';

const sandbox = mkdtempSync(join(tmpdir(), 'pinned-git-test-'));
afterAll(() => {
  rmSync(sandbox, {force: true, recursive: true});
});

let worldCount = 0;

/** An executable sh script at `path`. */
function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

type World = {
  inputs: GitPinInputs;
  /** Directories `makeDir` handed out. */
  made: string[];
  /** The fake binary the fake xcrun names. */
  real: string;
  /** Exists only once the fake xcrun has run. */
  xcrunRan: string;
};

/**
 * A fake shim on a PATH of its own, a fake binary it "forwards to", and a
 * fake xcrun that names that binary. Each prints the version it is given.
 */
function world(options?: {
  realVersion?: string;
  shimVersion?: string;
  xcrunBody?: string;
}): World {
  worldCount += 1;
  const root = join(sandbox, `world-${worldCount}`);
  const bin = join(root, 'bin');
  const realDir = join(root, 'real');
  mkdirSync(bin, {recursive: true});
  mkdirSync(realDir, {recursive: true});
  const shim = script(
    join(bin, 'git'),
    `echo '${options?.shimVersion ?? 'git version 9.9.9 (test)'}'`,
  );
  const real = script(
    join(realDir, 'git'),
    `echo '${options?.realVersion ?? 'git version 9.9.9 (test)'}'`,
  );
  const xcrunRan = join(root, 'xcrun-ran');
  const xcrun = script(
    join(root, 'xcrun'),
    `touch '${xcrunRan}'\n${options?.xcrunBody ?? `echo '${real}'`}`,
  );
  const made: string[] = [];
  return {
    inputs: {
      makeDir: () => {
        const dir = mkdtempSync(join(root, 'pin-'));
        made.push(dir);
        return dir;
      },
      path: bin,
      shim,
      xcrun,
    },
    made,
    real,
    xcrunRan,
  };
}

/** Apply `pin` to a copy of an env; return the copy and every line warned. */
function applied(
  pin: GitPin,
  path = '/a:/b',
): {env: {PATH?: string}; lines: string[]} {
  const env: {PATH?: string} = {PATH: path};
  const lines: string[] = [];
  applyGitPin(pin, env, (line) => lines.push(line));
  return {env, lines};
}

describe('this run', () => {
  const onMacWithXcrun =
    process.platform === 'darwin' &&
    existsSync('/usr/bin/xcrun') &&
    existsSync(GIT_SHIM);

  test('the preload decided, and on a Mac with xcrun it pinned', () => {
    const pin = installedGitPin();
    expect(pin).not.toBeNull();
    if (pin == null) return;
    if (onMacWithXcrun) {
      expect(pin).toMatchObject({kind: 'pinned'});
    } else {
      expect(pin.kind).toBe('unpinned');
      if (pin.kind === 'unpinned') expect(pin.reason).not.toBe('');
    }
  });

  test.if(onMacWithXcrun)(
    'a child git resolves to the pin, which is the binary the shim runs, not the shim',
    () => {
      const pin = installedGitPin();
      if (pin?.kind !== 'pinned') throw new Error('expected a pinned git');
      expect(readdirSync(pin.dir)).toEqual(['git']);
      // pinned-br.ts may have put br's directory in front; the pin follows it.
      const entries = (process.env.PATH ?? '').split(delimiter);
      const firstGitDir = entries.find((dir) => existsSync(join(dir, 'git')));
      expect(firstGitDir).toBe(pin.dir);

      const resolved = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf-8',
      }).trim();
      expect(resolved).toBe(join(pin.dir, 'git'));
      expect(realpathSync(resolved)).toBe(realpathSync(pin.target));
      expect(realpathSync(resolved)).not.toBe(realpathSync(GIT_SHIM));

      const version = execFileSync('git', ['--version'], {
        encoding: 'utf-8',
      }).trim();
      expect(version).toBe(pin.version);
      expect(
        execFileSync(GIT_SHIM, ['--version'], {encoding: 'utf-8'}).trim(),
      ).toBe(pin.version);
    },
  );

  test.if(onMacWithXcrun && process.env.SDKROOT == null)(
    'the shim did not run: git children do not get the SDKROOT it adds',
    () => {
      // A `!` alias runs under sh, with git's own environment. Only the one
      // variable is printed: the rest of the environment holds tokens.
      const alias = 'alias.sdkroot=!echo "sdkroot=[$SDKROOT]"';
      const viaPin = execFileSync('git', ['-c', alias, 'sdkroot'], {
        encoding: 'utf-8',
      }).trim();
      const viaShim = execFileSync(GIT_SHIM, ['-c', alias, 'sdkroot'], {
        encoding: 'utf-8',
      }).trim();
      // The control: the shim does add it on this machine.
      expect(viaShim).toMatch(/^sdkroot=\[\/.+\]$/);
      expect(viaPin).toBe('sdkroot=[]');
    },
  );
});

describe('it pins when the shim, xcrun and the binary agree', () => {
  test('one new directory, holding only a git symlink to the binary', () => {
    const w = world();
    const pin = resolveGitPin(w.inputs);
    expect(pin).toEqual({
      dir: w.made[0] ?? 'no directory made',
      kind: 'pinned',
      target: w.real,
      version: 'git version 9.9.9 (test)',
    });
    expect(w.made).toHaveLength(1);
    const dir = w.made[0] ?? '';
    expect(readdirSync(dir)).toEqual(['git']);
    expect(readlinkSync(join(dir, 'git'))).toBe(w.real);
  });

  test('applied, it goes first on PATH, once, and a child resolves to it', () => {
    const w = world();
    const pin = resolveGitPin(w.inputs);
    if (pin.kind !== 'pinned') throw new Error(pin.reason);
    const {env, lines} = applied(pin, `${w.inputs.path}${delimiter}/usr/bin`);
    expect(lines).toEqual([]);
    expect(env.PATH).toBe(
      `${pin.dir}${delimiter}${w.inputs.path}${delimiter}/usr/bin`,
    );
    applyGitPin(pin, env, (line) => lines.push(line));
    expect(env.PATH).toBe(
      `${pin.dir}${delimiter}${w.inputs.path}${delimiter}/usr/bin`,
    );
    const resolved = execFileSync('sh', ['-c', 'command -v git'], {
      encoding: 'utf-8',
      env: {PATH: `${env.PATH ?? ''}${delimiter}/bin`},
    }).trim();
    expect(resolved).toBe(join(pin.dir, 'git'));
  });
});

describe('NEGATIVE CONTROL: anything wrong leaves PATH alone and says why, once', () => {
  function expectUnpinned(w: World, reason: RegExp): void {
    const pin = resolveGitPin(w.inputs);
    expect(pin.kind).toBe('unpinned');
    if (pin.kind !== 'unpinned') return;
    expect(pin.reason).toMatch(reason);
    expect(w.made).toEqual([]);
    const {env, lines} = applied(pin);
    expect(env).toEqual({PATH: '/a:/b'});
    expect(lines).toEqual([unpinnedLine(pin.reason)]);
    expect(lines[0]).toStartWith('git NOT pinned for this test run (');
  }

  test('no xcrun at all (Linux, a cloud session)', () => {
    const w = world();
    w.inputs.xcrun = join(sandbox, 'no-such-xcrun');
    expectUnpinned(w, /no-such-xcrun could not run/);
  });

  test('xcrun fails', () => {
    const w = world({
      xcrunBody: "echo 'xcrun: error: no developer tools' >&2; exit 1",
    });
    expectUnpinned(w, /--find git exited 1: xcrun: error: no developer tools/);
  });

  test('xcrun names a binary of another version', () => {
    const w = world({realVersion: 'git version 0.0.1 (other)'});
    expectUnpinned(
      w,
      /reports "git version 0\.0\.1 \(other\)", but .* reports "git version 9\.9\.9 \(test\)"/,
    );
  });

  test('xcrun names a path that does not exist', () => {
    const w = world({xcrunBody: `echo '${join(sandbox, 'gone', 'git')}'`});
    expectUnpinned(w, /does not resolve/);
  });

  test('the git on PATH is not the shim: xcrun is never asked', () => {
    const w = world();
    w.inputs.shim = '/somewhere/else/git';
    expectUnpinned(w, /is not the xcrun shim|, not the xcrun shim/);
    expect(existsSync(w.xcrunRan)).toBe(false);
  });

  test('no git on PATH', () => {
    const w = world();
    w.inputs.path = join(sandbox, 'empty-path');
    expectUnpinned(w, /^no git on PATH$/);
    expect(existsSync(w.xcrunRan)).toBe(false);
  });
});
