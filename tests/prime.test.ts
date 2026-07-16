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

import {assemble} from '../src/plugin/lib/prime';
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

  test('markdown carries the "# Critical Rules" header; text does not', () => {
    const prompts = promptsFixture();
    const out = assemble(
      {format: 'markdown', partition: 'universal', promptsDir: prompts.path},
      RN_PROJECT(),
    );
    expect(out.markdown.startsWith('# Critical Rules')).toBe(true);
    expect(out.text).not.toContain('# Critical Rules');
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
