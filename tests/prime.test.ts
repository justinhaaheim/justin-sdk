/**
 * Tests for the prime assembler — specifically the universal/conditional/full
 * partition (home-base-r3pb.2) and the src/rules -> src/guidelines path
 * fallback (home-base-r3pb.1).
 *
 * assemble() reads a prompts dir (via the promptsDir override, skipping the
 * managed clone) and a project root (a package.json drives the includeIf
 * predicates). We build both in sandboxes.
 */

import {describe, test, expect, afterEach} from 'bun:test';

import {assemble, numberHeaders} from '../src/plugin/lib/prime';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A prompts fixture with two universal modules and one RN-gated module. */
function promptsFixture(rulesDir = 'src/rules'): Sandbox {
  const sb = track(createSandbox());
  sb.writeFile(
    `${rulesDir}/index.md`,
    ['@./universal-a.md', '@./universal-b.md', '@./rn-only.md'].join('\n\n'),
  );
  sb.writeFile(`${rulesDir}/universal-a.md`, 'UNIVERSAL_A');
  sb.writeFile(`${rulesDir}/universal-b.md`, 'UNIVERSAL_B');
  sb.writeFile(
    `${rulesDir}/rn-only.md`,
    '---\nincludeIf: [isReactNative]\n---\n\nRN_ONLY',
  );
  return sb;
}

/** A project root whose package.json deps drive the predicates. */
function projectRoot(deps: Record<string, string>): string {
  const sb = track(createSandbox());
  sb.writeFile('package.json', JSON.stringify({dependencies: deps}));
  return sb.path;
}

const RN_PROJECT = () => projectRoot({expo: '*'});
const PLAIN_PROJECT = () => projectRoot({lodash: '*'});

/** A prompts fixture with one universal module and one beads_rust-gated one. */
function beadsPromptsFixture(): Sandbox {
  const sb = track(createSandbox());
  sb.writeFile(
    'src/rules/index.md',
    ['@./universal-a.md', '@./beads-only.md'].join('\n\n'),
  );
  sb.writeFile('src/rules/universal-a.md', 'UNIVERSAL_A');
  sb.writeFile(
    'src/rules/beads-only.md',
    '---\nincludeIf: [isBeadsRust]\n---\n\nBEADS_ONLY',
  );
  return sb;
}

/** A project root with a `.beads/metadata.json` of the given shape. */
function beadsProject(metadata: string | null): string {
  const sb = track(createSandbox());
  sb.writeFile('package.json', JSON.stringify({dependencies: {lodash: '*'}}));
  if (metadata !== null) sb.writeFile('.beads/metadata.json', metadata);
  return sb.path;
}

// Real shapes, copied verbatim from disk 2026-07-30.
const BR_METADATA = '{"database":"beads.db","jsonl_export":"issues.jsonl"}';
const BD_DOLT_METADATA =
  '{"database":"dolt","backend":"dolt","dolt_mode":"embedded","dolt_database":"jl","project_id":"f52bcf30"}';

function beadsRuleIncluded(projectPath: string): boolean {
  const prompts = beadsPromptsFixture();
  const out = assemble(
    {format: 'markdown', partition: 'conditional', promptsDir: prompts.path},
    projectPath,
  );
  return out.text.includes('BEADS_ONLY');
}

describe('isBeadsRust predicate', () => {
  test('matches a beads_rust project', () => {
    expect(beadsRuleIncluded(beadsProject(BR_METADATA))).toBe(true);
  });

  // The whole point of this predicate: Justin has a project on Yegge's
  // Dolt-backed `bd`, and his br-specific guidance must not show up there.
  test("does NOT match Yegge's Dolt-backed bd project", () => {
    expect(beadsRuleIncluded(beadsProject(BD_DOLT_METADATA))).toBe(false);
  });

  test('does NOT match a project with no .beads/ at all', () => {
    expect(beadsRuleIncluded(beadsProject(null))).toBe(false);
  });

  test('does NOT match when metadata.json is unparseable', () => {
    expect(beadsRuleIncluded(beadsProject('{not json'))).toBe(false);
  });

  // Degrade toward showing the rules, not silently dropping them, if br's
  // metadata schema shifts under us.
  test('still matches if br changes its schema, so long as it is not dolt', () => {
    expect(beadsRuleIncluded(beadsProject('{"database":"beads-v2.sqlite"}'))).toBe(
      true,
    );
  });
});

describe('numberHeaders', () => {
  test('numbers headings with their full dotted path, resetting deeper levels', () => {
    const input = [
      '# A',
      'body',
      '# B',
      '## B.a',
      '## B.b',
      '### B.b.i',
      '# C',
      '## C.a',
    ].join('\n');
    expect(numberHeaders(input).split('\n')).toEqual([
      '# 1. A',
      'body',
      '# 2. B',
      '## 2.1 B.a',
      '## 2.2 B.b',
      '### 2.2.1 B.b.i',
      '# 3. C',
      '## 3.1 C.a',
    ]);
  });

  test('leaves headings inside fenced code blocks alone', () => {
    const input = [
      '# Real',
      '```sh',
      '# not a heading',
      '```',
      '## Also real',
    ].join('\n');
    expect(numberHeaders(input).split('\n')).toEqual([
      '# 1. Real',
      '```sh',
      '# not a heading',
      '```',
      '## 1.1 Also real',
    ]);
  });

  test('pads a skipped intermediate level so the path stays well-formed', () => {
    const input = ['# A', '### A.deep', '## A.b'].join('\n');
    expect(numberHeaders(input).split('\n')).toEqual([
      '# 1. A',
      '### 1.1.1 A.deep',
      '## 1.2 A.b',
    ]);
  });

  test('prefix namespaces the numbers (P-1 / P-1.1 / P-2, no trailing period)', () => {
    const input = ['# A', '## A.a', '## A.b', '# B'].join('\n');
    expect(numberHeaders(input, 'P-').split('\n')).toEqual([
      '# P-1 A',
      '## P-1.1 A.a',
      '## P-1.2 A.b',
      '# P-2 B',
    ]);
  });
});

describe('prime assemble() partition', () => {
  test("'universal' includes only non-includeIf modules (RN project)", () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.text).toContain('UNIVERSAL_A');
    expect(out.text).toContain('UNIVERSAL_B');
    expect(out.text).not.toContain('RN_ONLY');
    expect(out.count).toBe(2);
  });

  test("'conditional' includes only matching includeIf modules (RN project)", () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'conditional', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.text).toContain('RN_ONLY');
    expect(out.text).not.toContain('UNIVERSAL_A');
    expect(out.text).not.toContain('UNIVERSAL_B');
    expect(out.count).toBe(1);
  });

  test("'conditional' is empty on a project the predicate doesn't match", () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'conditional', promptsDir: prompts.path},
      PLAIN_PROJECT(),
    );
    expect(out.count).toBe(0);
    expect(out.text).toBe('');
  });

  test("'full' includes universal + matching conditional (RN project)", () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'full', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.text).toContain('UNIVERSAL_A');
    expect(out.text).toContain('UNIVERSAL_B');
    expect(out.text).toContain('RN_ONLY');
    expect(out.count).toBe(3);
  });

  test("'full' drops a conditional whose predicate is false (plain project)", () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'full', promptsDir: prompts.path},
      PLAIN_PROJECT(),
    );
    expect(out.text).toContain('UNIVERSAL_A');
    expect(out.text).not.toContain('RN_ONLY');
    expect(out.count).toBe(2);
  });

  test('defaults to full when no partition is given', () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.count).toBe(3);
  });

  test('markdown carries an UNNUMBERED "# Critical Rules" title; text does not', () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.markdown.startsWith('# Critical Rules\n')).toBe(true);
    expect(out.text).not.toContain('Critical Rules');
  });

  test('title is skipped by the numbering: modules still start at 1', () => {
    const sb = track(createSandbox());
    sb.writeFile('src/rules/index.md', '@./a.md\n\n@./b.md');
    sb.writeFile('src/rules/a.md', '# Alpha\n\n## Alpha sub');
    sb.writeFile('src/rules/b.md', '# Beta');
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: sb.path},
      PLAIN_PROJECT(),
    );
    // The title takes no number and does not consume the "1" slot, and the
    // standalone document and the hook-injected body number identically.
    expect(out.markdown.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Critical Rules',
      '# 1. Alpha',
      '## 1.1 Alpha sub',
      '# 2. Beta',
    ]);
    expect(out.text).toContain('# 1. Alpha');
    expect(out.text).toContain('## 1.1 Alpha sub');
    expect(out.text).toContain('# 2. Beta');
  });

  test("the 'conditional' hook injection is P-namespaced; 'universal' is plain", () => {
    const sb = track(createSandbox());
    sb.writeFile('src/rules/index.md', '@./u.md\n\n@./rn.md');
    sb.writeFile('src/rules/u.md', '# Universal\n\n## Universal sub');
    sb.writeFile(
      'src/rules/rn.md',
      '---\nincludeIf: [isReactNative]\n---\n\n# RN one\n\n## RN sub\n\n# RN two',
    );
    // Conditional partition (the hook injection) → P- prefix, starting at P-1.
    const cond = assemble(
      {format: 'markdown', partition: 'conditional', promptsDir: sb.path},
      RN_PROJECT(),
    );
    expect(cond.text.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# P-1 RN one',
      '## P-1.1 RN sub',
      '# P-2 RN two',
    ]);
    // Universal partition (the autoloaded file) → plain, unaffected by the prefix.
    const uni = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: sb.path},
      RN_PROJECT(),
    );
    expect(uni.text).toContain('# 1. Universal');
    expect(uni.text).toContain('## 1.1 Universal sub');
    expect(uni.text).not.toContain('P-');
  });
});

describe('prime assemble() partition — nested refs & invariants', () => {
  /** index -> universal parent that itself @-refs an RN-gated child. */
  function nestedUniversalParent(): Sandbox {
    const sb = track(createSandbox());
    sb.writeFile('src/rules/index.md', '@./parent-u.md');
    sb.writeFile('src/rules/parent-u.md', 'PARENT_U\n\n@./nested-c.md');
    sb.writeFile(
      'src/rules/nested-c.md',
      '---\nincludeIf: [isReactNative]\n---\n\nNESTED_C',
    );
    return sb;
  }
  /** index -> RN-gated parent that itself @-refs a universal child. */
  function nestedConditionalParent(): Sandbox {
    const sb = track(createSandbox());
    sb.writeFile('src/rules/index.md', '@./parent-c.md');
    sb.writeFile(
      'src/rules/parent-c.md',
      '---\nincludeIf: [isReactNative]\n---\n\nPARENT_C\n\n@./nested-u.md',
    );
    sb.writeFile('src/rules/nested-u.md', 'NESTED_U');
    return sb;
  }

  test('a nested conditional child travels with its universal parent (not lost)', () => {
    const prompts = nestedUniversalParent();
    const uni = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    // parent is top-level universal -> kept, and its nested conditional child
    // rides along (partition gating is top-level only).
    expect(uni.text).toContain('PARENT_U');
    expect(uni.text).toContain('NESTED_C');
    // conditional half gets neither (the whole subtree already went to universal)
    const cond = assemble(
      {format: 'markdown', partition: 'conditional', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(cond.text).toBe('');
  });

  test('a nested universal child travels with its conditional parent', () => {
    const prompts = nestedConditionalParent();
    const cond = assemble(
      {format: 'markdown', partition: 'conditional', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(cond.text).toContain('PARENT_C');
    expect(cond.text).toContain('NESTED_U');
    const uni = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(uni.text).toBe('');
  });

  test('universal ∪ conditional === full for nested mixes (RN project)', () => {
    for (const fixture of [nestedUniversalParent, nestedConditionalParent]) {
      const prompts = fixture();
      const opts = {format: 'markdown' as const, promptsDir: prompts.path};
      const uni = assemble({...opts, partition: 'universal'}, RN_PROJECT());
      const cond = assemble({...opts, partition: 'conditional'}, RN_PROJECT());
      const full = assemble({...opts, partition: 'full'}, RN_PROJECT());
      expect(uni.count + cond.count).toBe(full.count);
      for (const token of ['PARENT_U', 'NESTED_C', 'PARENT_C', 'NESTED_U']) {
        const inHalves = uni.text.includes(token) || cond.text.includes(token);
        expect(inHalves).toBe(full.text.includes(token));
      }
    }
  });

  test('universal partition is project-independent (same for RN and plain)', () => {
    const prompts = promptsFixture();
    const opts = {
      format: 'markdown' as const,
      partition: 'universal' as const,
      promptsDir: prompts.path,
    };
    const rn = assemble(opts, RN_PROJECT());
    const plain = assemble(opts, PLAIN_PROJECT());
    expect(rn.text).toBe(plain.text);
    expect(rn.count).toBe(plain.count);
  });
});

describe('prime assemble() path fallback', () => {
  test('reads src/rules when present', () => {
    const prompts = promptsFixture('src/rules');
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.count).toBe(2);
  });

  test('falls back to legacy src/guidelines when src/rules is absent', () => {
    const prompts = promptsFixture('src/guidelines');
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.text).toContain('UNIVERSAL_A');
    expect(out.count).toBe(2);
  });
});
