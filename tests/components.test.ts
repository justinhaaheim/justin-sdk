/**
 * Tests for the shared component registry (components.ts) — the single
 * source of truth for component ordering, the short ↔ config-name mapping,
 * and name→installer dispatch that add/init/update all consume.
 *
 * These are pure and offline. The actual installer dispatch is exercised
 * end-to-end by add.test.ts / init.test.ts / update.test.ts; here we only
 * cover the registry's own bookkeeping (and the unknown-name null path,
 * which must NOT run an installer).
 */

import {describe, expect, test} from 'bun:test';

import {
  COMPONENT_NAMES,
  configNameFor,
  DEPENDENCY_ORDER,
  runComponentByConfigName,
} from '../src/components';

describe('components: ordering', () => {
  test('base-setup is first (the implicit foundation)', () => {
    expect(COMPONENT_NAMES[0]).toBe('base-setup');
  });

  test('DEPENDENCY_ORDER is the canonical order minus the opt-in-only components', () => {
    expect(DEPENDENCY_ORDER).toEqual(
      COMPONENT_NAMES.filter(
        (name) =>
          name !== 'base-setup' && name !== 'eas' && name !== 'time-check',
      ),
    );
    expect(DEPENDENCY_ORDER).not.toContain('base-setup');
  });

  test('time-check is opt-in only — its hook fires on every prompt', () => {
    // Installing it via `init`/`all` would spend a process spawn per prompt in
    // every project just to print nothing.
    expect(COMPONENT_NAMES).toContain('time-check');
    expect(DEPENDENCY_ORDER).not.toContain('time-check');
  });

  test('DEPENDENCY_ORDER matches the documented init/all order', () => {
    expect(DEPENDENCY_ORDER).toEqual([
      'gitignore',
      'prettier',
      'tsconfig',
      'eslint',
      'husky',
      'gh-actions',
      'prompts',
      'claude-md',
      'beads',
    ]);
  });
});

describe('components: name mapping', () => {
  test('base-setup keeps its name; everything else gets a -setup suffix', () => {
    expect(configNameFor('base-setup')).toBe('base-setup');
    expect(configNameFor('beads')).toBe('beads-setup');
    expect(configNameFor('gh-actions')).toBe('gh-actions-setup');
    expect(configNameFor('claude-md')).toBe('claude-md-setup');
  });

  test('config names are unique across all components', () => {
    const configNames = COMPONENT_NAMES.map(configNameFor);
    expect(new Set(configNames).size).toBe(configNames.length);
  });
});

describe('components: runComponentByConfigName', () => {
  test('returns null for an unknown config name (runs no installer)', () => {
    // Unknown names short-circuit to null BEFORE any installer is invoked,
    // so this asserts the skip-with-warning path without side effects. The
    // happy-path dispatch (real config name → installer) is covered e2e by
    // add/init/update tests, which run in throwaway sandboxes.
    const result = runComponentByConfigName('totally-made-up-setup', {
      projectRoot: '/tmp/does-not-matter',
      quiet: true,
      force: false,
    });
    expect(result).toBeNull();
  });
});
