/**
 * Tests for `justin-sdk skill`.
 *
 * The value of this command is that its two churning sections — the component
 * table and the command list — are DERIVED rather than written, so they cannot
 * drift from reality the way `agent.ts` (whose header asks the reader to "keep
 * this in sync") inevitably does. These tests guard that property, not the
 * prose.
 *
 * The strongest guarantee is a compile-time one: COMPONENT_BLURBS is typed
 * `Record<ComponentName, string>`, so adding a component without describing it
 * fails `tsc`, not just these tests. Negative-control-verified — see the
 * commit message.
 */

import {describe, expect, test} from 'bun:test';

import {COMPONENT_NAMES, DEPENDENCY_ORDER} from '../src/components';
import {buildSkill} from '../src/skill';

describe('skill: derived component table', () => {
  const skill = buildSkill();

  test('every component in the registry appears', () => {
    for (const name of COMPONENT_NAMES) {
      expect(skill).toContain(name);
    }
  });

  test('opt-in-only components are listed separately from the default set', () => {
    const optIn = COMPONENT_NAMES.filter((n) => !DEPENDENCY_ORDER.includes(n));
    expect(optIn.length).toBeGreaterThan(0);

    const [before, after] = skill.split('OPT-IN ONLY');
    expect(after).toBeDefined();
    // Each opt-in component is described below the divider…
    for (const name of optIn) {
      expect(after).toContain(name);
    }
    // …and each default component above it.
    for (const name of DEPENDENCY_ORDER) {
      expect(before).toContain(name);
    }
  });

  test('time-check is presented as opt-in, not default', () => {
    const [, after] = skill.split('OPT-IN ONLY');
    expect(after).toContain('time-check');
  });
});

describe('skill: derived command list', () => {
  const skill = buildSkill();

  test('captures real commands from the CLI help', () => {
    // A representative spread, including `skill` itself — if the capture broke,
    // these would vanish rather than silently going stale.
    for (const cmd of ['doctor', 'signal', 'add', 'update', 'prime', 'skill']) {
      expect(skill).toContain(`justin-sdk ${cmd}`);
    }
  });

  test('the capture did not swallow the section into a stub', () => {
    const commandsBlock = skill.split('## Commands')[1] ?? '';
    // The help block wraps across many lines; a broken capture collapses to
    // one or two.
    expect(commandsBlock.split('\n').length).toBeGreaterThan(10);
  });
});

describe('skill: the gotchas that cost real time', () => {
  const skill = buildSkill();

  test('warns that bunx #main does not re-resolve, and gives the fix', () => {
    expect(skill).toContain('bunx-*justin-sdk*');
    expect(skill).toContain("Cannot find package 'yargs'");
  });

  test('documents the bare-semver tag format', () => {
    expect(skill).toContain('BARE semver');
  });

  test('states the SDK version it was built from', () => {
    expect(skill).toMatch(/Version of the copy you are reading: \d+\.\d+\.\d+/);
  });
});
