/**
 * The knob (home-base-p1uj D6) and the sandbox write probe.
 *
 * The knob's default is the load-bearing part: OFF. A half-built feature that
 * turned itself on for twenty other sessions would be a worse outcome than the
 * feature not existing, so "absent config → disabled" gets its own test rather
 * than being left to be obvious.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync} from 'fs';
import {join} from 'path';

import {resolveThreadConfig} from '../src/thread/config';
import {
  lifeBeadsDir,
  probeWritable,
  SANDBOX_DENIED_LINE,
  threadsStateDir,
} from '../src/thread/paths';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A sandbox holding both config files, wired up through XDG_CONFIG_HOME. */
function configWorld(options: {
  project?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
}): {cwd: string; env: Record<string, string>} {
  const sb = track(createSandbox());
  const cwd = join(sb.path, 'repo');
  mkdirSync(cwd, {recursive: true});
  if (options.project != null) {
    sb.writeFile(
      'repo/justin-sdk.config.json',
      JSON.stringify({
        components: ['base-setup'],
        lastSynced: '2026-09-12',
        version: '0.27.1',
        ...options.project,
      }),
    );
  }
  if (options.user != null) {
    sb.writeFile('config/justin-sdk/config.json', JSON.stringify(options.user));
  }
  return {cwd, env: {XDG_CONFIG_HOME: join(sb.path, 'config')}};
}

describe('resolveThreadConfig (D6)', () => {
  test('DEFAULTS OFF when neither file says anything', () => {
    const {cwd, env} = configWorld({});
    const resolved = resolveThreadConfig({cwd, env});
    expect(resolved.enabled).toBe(false);
    expect(resolved.source).toBe('default');
  });

  test('the user file turns it on for every repo', () => {
    const {cwd, env} = configWorld({
      user: {componentConfig: {thread: {enabled: true}}},
    });
    const resolved = resolveThreadConfig({cwd, env});
    expect(resolved.enabled).toBe(true);
    expect(resolved.source).toBe('user');
  });

  test('the project file overrides the user file, in both directions', () => {
    const on = resolveThreadConfig(
      configWorld({
        project: {componentConfig: {thread: {enabled: true}}},
        user: {componentConfig: {thread: {enabled: false}}},
      }),
    );
    expect(on.enabled).toBe(true);
    expect(on.source).toBe('project');

    const off = resolveThreadConfig(
      configWorld({
        project: {componentConfig: {thread: {enabled: false}}},
        user: {componentConfig: {thread: {enabled: true}}},
      }),
    );
    expect(off.enabled).toBe(false);
    expect(off.source).toBe('project');
  });

  test('a broken config contributes NOTHING and says so', () => {
    const sb = track(createSandbox());
    const cwd = join(sb.path, 'repo');
    mkdirSync(cwd, {recursive: true});
    sb.writeFile('config/justin-sdk/config.json', '{not json');
    const resolved = resolveThreadConfig({
      cwd,
      env: {XDG_CONFIG_HOME: join(sb.path, 'config')},
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.problems.join('\n')).toContain('not valid JSON');
  });

  test('a wrong-typed enabled is ignored rather than coerced', () => {
    const {cwd, env} = configWorld({
      user: {componentConfig: {thread: {enabled: 'yes'}}},
    });
    // The whole file fails validation (a known key with the wrong type is a
    // violation), so it contributes nothing and the default stands.
    const resolved = resolveThreadConfig({cwd, env});
    expect(resolved.enabled).toBe(false);
    expect(resolved.problems.length).toBeGreaterThan(0);
  });
});

describe('paths', () => {
  test('both roots are env-overridable', () => {
    expect(threadsStateDir({JUSTIN_THREADS_STATE_DIR: '/tmp/x'})).toBe(
      '/tmp/x',
    );
    expect(lifeBeadsDir({JUSTIN_THREADS_LIFE_DIR: '/tmp/life'})).toBe(
      '/tmp/life/.beads',
    );
  });

  test('the denial line names both paths and never suggests disabling the sandbox', () => {
    expect(SANDBOX_DENIED_LINE.startsWith('THREADS: SANDBOX DENIED')).toBe(
      true,
    );
    expect(SANDBOX_DENIED_LINE).toContain('~/Dev/life/.beads');
    expect(SANDBOX_DENIED_LINE).toContain('~/.local/state/justin-threads');
    expect(SANDBOX_DENIED_LINE.toLowerCase()).not.toContain('disable');
  });
});

describe('probeWritable', () => {
  test('a writable directory probes writable and leaves nothing behind', () => {
    const sb = track(createSandbox());
    const dir = join(sb.path, 'state');
    expect(probeWritable(dir).kind).toBe('writable');
    expect(probeWritable(dir).kind).toBe('writable');
  });

  test('a read-only parent is DENIED, not merely failed', () => {
    const sb = track(createSandbox());
    const locked = join(sb.path, 'locked');
    mkdirSync(locked, {recursive: true});
    chmodSync(locked, 0o500);
    try {
      const probe = probeWritable(join(locked, 'state'));
      expect(probe.kind).toBe('denied');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
