/**
 * Tests for the component registry (component-registry.ts) and the name →
 * installer dispatch (components.ts).
 *
 * These are pure and offline apart from a package.json fixture, which is what
 * the `includeIf` predicates read. The actual installer dispatch is exercised
 * end-to-end by add.test.ts / init.test.ts / update.test.ts; here we cover the
 * registry's own bookkeeping, the computed `core` preset, `resolveComponents`
 * (epic home-base-dchjw D3, constraint F1) and the unknown-name null path, which
 * must NOT run an installer.
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  COMPONENT_INCLUDE_IF,
  COMPONENT_NAMES,
  componentApplicability,
  componentNameForConfigName,
  configNameFor,
  coreConfigNames,
  corePreset,
  resolveComponents,
  unknownComponentNames,
} from '../src/component-registry';
import {runComponentByConfigName} from '../src/components';

const roots: string[] = [];

/** A project root whose package.json declares `deps` as dependencies. */
function fixture(deps: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'jsdk-components-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: Object.fromEntries(deps.map((d) => [d, '*'])),
      name: 'fixture',
    }),
  );
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, {force: true, recursive: true});
});

describe('component registry: ordering', () => {
  test('base-setup is first (the implicit foundation)', () => {
    expect(COMPONENT_NAMES[0]).toBe('base-setup');
  });

  test('the retired prompts and claude-md components are gone', () => {
    expect(COMPONENT_NAMES).not.toContain('prompts');
    expect(COMPONENT_NAMES).not.toContain('claude-md');
  });

  test('config names are unique across all components', () => {
    const configNames = COMPONENT_NAMES.map(configNameFor);
    expect(new Set(configNames).size).toBe(configNames.length);
  });

  test('base-setup keeps its name; everything else gets a -setup suffix', () => {
    expect(configNameFor('base-setup')).toBe('base-setup');
    expect(configNameFor('beads')).toBe('beads-setup');
    expect(configNameFor('gh-actions')).toBe('gh-actions-setup');
  });
});

describe('component registry: core is computed, not listed', () => {
  test('core is every APPLICABLE component except the implicit base-setup, in a plain node project', () => {
    // `beads` is absent, and that is the dchjw.19 change: it gained
    // `includeIf: [isBeadsRust]`, which is false for a repo with no
    // `.beads/metadata.json` — including this fixture. `eas` is absent for the
    // same reason (isExpo).
    const root = fixture(['typescript']);
    expect(corePreset(root)).toEqual([
      'gitignore',
      'prettier',
      'tsconfig',
      'eslint',
      'husky',
      'gh-actions',
      'time-check',
      'usage-check',
      'thread-hooks',
      'critical-rules',
    ]);
    expect(corePreset(root)).not.toContain('base-setup');
  });

  test('beads is in core for a beads_rust repo and NOT for a Dolt one', () => {
    // The positive half matters as much as the negative: without it, deleting
    // the component outright would pass the assertion above.
    const br = fixture([]);
    mkdirSync(join(br, '.beads'), {recursive: true});
    writeFileSync(
      join(br, '.beads', 'metadata.json'),
      JSON.stringify({database: 'beads.db', jsonl_export: 'issues.jsonl'}),
    );
    expect(corePreset(br)).toContain('beads');

    const dolt = fixture([]);
    mkdirSync(join(dolt, '.beads'), {recursive: true});
    writeFileSync(
      join(dolt, '.beads', 'metadata.json'),
      JSON.stringify({backend: 'dolt', database: 'dolt'}),
    );
    expect(corePreset(dolt)).not.toContain('beads');
  });

  test('the four components the old OPT_IN_ONLY list withheld are in core', () => {
    // Justin, 2026-09-18: time-check, usage-check, thread-hooks and
    // critical-rules are part of the default install. The old `all` preset
    // excluded all four — including critical-rules, which is the point of the
    // SDK — while including the retired `prompts`.
    const core: string[] = corePreset(fixture([]));
    for (const name of [
      'time-check',
      'usage-check',
      'thread-hooks',
      'critical-rules',
    ]) {
      expect(core).toContain(name);
    }
  });

  test('eas is gated on isExpo: absent without expo, present with it', () => {
    expect(COMPONENT_INCLUDE_IF.eas).toEqual(['isExpo']);
    expect(corePreset(fixture(['react', 'react-native']))).not.toContain('eas');
    // The negative control for the gate: the ONLY difference is the dependency.
    expect(corePreset(fixture(['react', 'expo']))).toContain('eas');
  });

  test('applicability names the gate that excluded a component', () => {
    const entry = componentApplicability(fixture([])).find(
      (e) => e.name === 'eas',
    );
    expect(entry).toBeDefined();
    expect(entry?.applicable).toBe(false);
    expect(entry?.includeIf).toEqual(['isExpo']);
    expect(entry?.unknownPredicates).toEqual([]);
  });

  test('coreConfigNames is core in -setup spelling', () => {
    const root = fixture([]);
    expect(coreConfigNames(root)).toEqual(corePreset(root).map(configNameFor));
  });
});

describe('component registry: resolveComponents', () => {
  test('an ABSENT components key resolves to core, and says so', () => {
    const root = fixture([]);
    const resolved = resolveComponents({}, root);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe('core');
    // base-setup first (it is always installed), then core.
    expect(resolved.components).toEqual([
      'base-setup',
      ...coreConfigNames(root),
    ]);
    // The whole point of F1: `{}` must not resolve to nothing.
    expect(resolved.components.length).toBeGreaterThan(0);
  });

  test('a listed components key is honoured verbatim', () => {
    const resolved = resolveComponents(
      {components: ['base-setup', 'beads-setup']},
      fixture([]),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe('config');
    expect(resolved.components).toEqual(['base-setup', 'beads-setup']);
    // base-setup is not duplicated when the config already names it.
    expect(resolved.components.filter((n) => n === 'base-setup')).toHaveLength(
      1,
    );
  });

  test('an EMPTY array is a statement, not an absence — it does NOT become core', () => {
    const root = fixture([]);
    const resolved = resolveComponents({components: []}, root);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe('config');
    // Only the implicit foundation, which every enrolled repo has by
    // construction — and none of the core components.
    expect(resolved.components).toEqual(['base-setup']);
    expect(resolved.components).not.toContain('beads-setup');
  });

  test('a components key of the wrong type FAILS — it never reads as empty', () => {
    for (const bad of [{components: 'beads-setup'}, {components: [1, 2]}]) {
      const resolved = resolveComponents(bad, fixture([]));
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toContain('components');
    }
  });

  test('a config that is not an object FAILS', () => {
    expect(resolveComponents(null, fixture([])).ok).toBe(false);
    expect(resolveComponents([], fixture([])).ok).toBe(false);
    expect(resolveComponents('nope', fixture([])).ok).toBe(false);
  });

  test('a config that omits base-setup still resolves WITH it', () => {
    // Doctor keys its BUN / ENV_HYDRATION / SDK-pin checks on base-setup. A
    // repo that stopped listing it must not silently lose them.
    const resolved = resolveComponents(
      {components: ['beads-setup']},
      fixture([]),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.components).toEqual(['base-setup', 'beads-setup']);
  });

  test('unknown names survive resolution and are reported, not dropped', () => {
    const resolved = resolveComponents(
      {components: ['beads-setup', 'prompts-setup']},
      fixture([]),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.components).toContain('prompts-setup');
    expect(unknownComponentNames(resolved.components)).toEqual([
      'prompts-setup',
    ]);
  });
});

describe('components: dispatch', () => {
  test('componentNameForConfigName maps back, and is null for a stranger', () => {
    expect(componentNameForConfigName('beads-setup')).toBe('beads');
    expect(componentNameForConfigName('base-setup')).toBe('base-setup');
    expect(componentNameForConfigName('claude-md-setup')).toBeNull();
  });

  test('runComponentByConfigName returns null for an unknown config name (runs no installer)', () => {
    const result = runComponentByConfigName('totally-made-up-setup', {
      projectRoot: '/tmp/does-not-matter',
      quiet: true,
      force: false,
    });
    expect(result).toBeNull();
  });
});
