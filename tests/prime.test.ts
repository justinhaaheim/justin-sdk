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
