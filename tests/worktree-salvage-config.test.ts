/**
 * Where worktree-salvage writes (D4). Every case passes its own env, so the
 * machine's real ~/.config is never read.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync} from 'fs';
import {join} from 'path';

import {
  configFilePath,
  describeDestinationSource,
  resolveDestination,
} from '../src/worktree-salvage/config';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
const restoreModes: {mode: number; path: string}[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (restoreModes.length > 0) {
    const item = restoreModes.pop();
    if (item != null) chmodSync(item.path, item.mode);
  }
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function envFor(sb: Sandbox) {
  return {
    HOME: join(sb.path, 'home'),
    XDG_CONFIG_HOME: join(sb.path, 'config'),
    XDG_DATA_HOME: join(sb.path, 'data'),
  };
}

function writeConfig(sb: Sandbox, text: string): void {
  sb.writeFile('config/worktree-salvage/config.json', text);
}

describe('resolveDestination', () => {
  test('no config file: the XDG data fallback, marked as not backed up', () => {
    const sb = track();
    const env = envFor(sb);
    const destination = resolveDestination(null, {env});
    expect(destination).toEqual({
      configFile: join(sb.path, 'config/worktree-salvage/config.json'),
      dir: join(sb.path, 'data/worktree-salvage'),
      source: 'fallback',
    });
    expect(describeDestinationSource(destination)).toContain('NOT BACKED UP');
  });

  test('a config file with outDir: that directory, with ~ expanded', () => {
    const sb = track();
    writeConfig(sb, '{"outDir": "~/Dropbox/Data/worktree-salvage"}');
    const destination = resolveDestination(null, {env: envFor(sb)});
    expect(destination.dir).toBe(
      join(sb.path, 'home/Dropbox/Data/worktree-salvage'),
    );
    expect(destination.source).toBe('config');
  });

  test('--out wins over the config, and a relative --out resolves against cwd', () => {
    const sb = track();
    writeConfig(sb, '{"outDir": "/somewhere/else"}');
    const destination = resolveDestination('saves', {
      cwd: sb.path,
      env: envFor(sb),
    });
    expect(destination).toMatchObject({
      dir: join(sb.path, 'saves'),
      source: 'flag',
    });
  });

  test('an unparsable config THROWS rather than falling back', () => {
    const sb = track();
    writeConfig(sb, '{"outDir": ');
    expect(() => resolveDestination(null, {env: envFor(sb)})).toThrow(
      'is not valid JSON',
    );
  });

  test('a config with no outDir throws', () => {
    const sb = track();
    writeConfig(sb, '{"out": "/x"}');
    expect(() => resolveDestination(null, {env: envFor(sb)})).toThrow(
      'needs a non-empty string "outDir"',
    );
  });

  test('a config naming a relative outDir throws', () => {
    const sb = track();
    writeConfig(sb, '{"outDir": "relative/dir"}');
    expect(() => resolveDestination(null, {env: envFor(sb)})).toThrow(
      'names a relative outDir',
    );
  });

  test('a config that exists but cannot be read throws', () => {
    const sb = track();
    writeConfig(sb, '{"outDir": "/x"}');
    const file = configFilePath(envFor(sb));
    restoreModes.push({mode: 0o644, path: file});
    chmodSync(file, 0o000);
    expect(() => resolveDestination(null, {env: envFor(sb)})).toThrow(
      'exists but could not be read',
    );
  });
});
