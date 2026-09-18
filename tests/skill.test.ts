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

import {COMPONENT_INCLUDE_IF, COMPONENT_NAMES} from '../src/component-registry';
import {buildSkill} from '../src/skill';

describe('skill: derived component table', () => {
  const skill = buildSkill();

  test('every component in the registry appears', () => {
    for (const name of COMPONENT_NAMES) {
      expect(skill).toContain(name);
    }
  });

  test('a gated component prints its gate, and there is no opt-in divider', () => {
    // The OPT-IN ONLY divider is gone with OPT_IN_ONLY itself (D3): a component
    // is applicable to a repo or it is not, and the skill is a static document
    // that cannot know which repo it will be read in. The gate is what it can
    // honestly print.
    expect(skill).not.toContain('OPT-IN ONLY');
    for (const [name, gate] of Object.entries(COMPONENT_INCLUDE_IF)) {
      expect(skill).toContain(`[includeIf ${(gate ?? []).join(', ')}]`);
      expect(skill).toContain(name);
    }
    expect(skill).toContain('[implicit]');
  });

  test('time-check is presented as part of core (D3), not as opt-in', () => {
    expect(skill).not.toContain('OPT-IN ONLY');
    expect(skill).toContain('time-check');
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
