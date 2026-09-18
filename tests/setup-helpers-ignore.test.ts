/**
 * Unit tests for the ignore-file helpers in setup-helpers.ts
 * (`normalizeIgnorePattern` / `ensureIgnoreEntries`), the shared dedupe used by
 * gitignore-setup, prettier-setup and beads-setup.
 *
 * The installers' own tests assert the end-to-end result; these pin the
 * semantics the three of them rely on, including the ones deliberately NOT
 * normalized.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, statSync} from 'fs';
import {join} from 'path';

import {
  ensureIgnoreEntries,
  normalizeIgnorePattern,
} from '../src/setup-helpers';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

describe('normalizeIgnorePattern', () => {
  test('collapses the spellings that mean the same path', () => {
    expect(normalizeIgnorePattern('  dist  ')).toBe('dist');
    expect(normalizeIgnorePattern('dist/')).toBe('dist');
    expect(normalizeIgnorePattern('**/dist')).toBe('dist');
    expect(normalizeIgnorePattern('**/dist/')).toBe('dist');
    expect(normalizeIgnorePattern('**/.claude/worktrees/')).toBe(
      '.claude/worktrees',
    );
  });

  test('keeps a leading slash: /tmp and tmp are different patterns', () => {
    expect(normalizeIgnorePattern('/tmp')).toBe('/tmp');
    expect(normalizeIgnorePattern('tmp')).toBe('tmp');
    expect(normalizeIgnorePattern('/tmp')).not.toBe(
      normalizeIgnorePattern('tmp'),
    );
  });
});

describe('ensureIgnoreEntries', () => {
  test('creates the file when it does not exist', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');

    const result = ensureIgnoreEntries(path, ['tmp/', 'dist/']);
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['tmp/', 'dist/']);
    expect(readFileSync(path, 'utf-8')).toBe('tmp/\ndist/\n');
  });

  test('a second call over the same entries writes nothing at all', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');

    ensureIgnoreEntries(path, ['tmp/', 'dist/']);
    const mtimeBefore = statSync(path).mtimeMs;
    const contentBefore = readFileSync(path, 'utf-8');

    const result = ensureIgnoreEntries(path, ['tmp/', 'dist/']);
    expect(result.changed).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(contentBefore);
    // Not merely "same bytes": the file was never opened for writing.
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  /**
   * dchjw.15. The trailing slash is NOT a spelling variant: `tmp/` ignores the
   * DIRECTORY and `tmp` ignores anything of that name, a file included. It is
   * normalized away for MATCHING and must never be removed by a REWRITE — a
   * baseline entry spelled without it would otherwise widen every repo's
   * directory-only rule, silently, on the next install.
   */
  describe('a trailing slash is matched loosely and never stripped', () => {
    test('an existing tmp/ survives a slash-less baseline entry untouched', () => {
      const sb = track(createSandbox());
      const path = join(sb.path, '.gitignore');
      sb.writeFile('.gitignore', '# header\ntmp/\n');

      const result = ensureIgnoreEntries(path, ['tmp']);
      // Matched, so nothing was appended...
      expect(result.added).toEqual([]);
      // ...and nothing was rewritten either: the file already says it.
      expect(result.rewritten).toEqual([]);
      expect(result.changed).toBe(false);
      expect(readFileSync(path, 'utf-8')).toBe('# header\ntmp/\n');
    });

    test('a globstar IS dropped, but the slash still survives', () => {
      const sb = track(createSandbox());
      const path = join(sb.path, '.gitignore');
      sb.writeFile('.gitignore', '**/tmp/\n');

      const result = ensureIgnoreEntries(path, ['tmp']);
      expect(result.rewritten).toEqual([{from: '**/tmp/', to: 'tmp/'}]);
      expect(readFileSync(path, 'utf-8')).toBe('tmp/\n');
    });

    test('the other direction still adopts the canonical spelling', () => {
      const sb = track(createSandbox());
      const path = join(sb.path, '.gitignore');
      sb.writeFile('.gitignore', 'tmp\n');

      // ADDING a slash is allowed and deliberate: the baseline entry is the
      // canonical spelling, and narrowing to "the directory" is what the SDK
      // means by it. Only REMOVING one is forbidden, because that widens a
      // rule the repo already chose.
      const result = ensureIgnoreEntries(path, ['tmp/']);
      expect(result.rewritten).toEqual([{from: 'tmp', to: 'tmp/'}]);
      expect(readFileSync(path, 'utf-8')).toBe('tmp/\n');
    });
  });

  test('rewrites a near-miss spelling in place instead of appending', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.prettierignore');
    sb.writeFile('.prettierignore', '# header\nkeep-me\n.claude/worktrees\n');

    const result = ensureIgnoreEntries(path, ['**/.claude/worktrees/']);
    expect(result.added).toEqual([]);
    expect(result.rewritten).toEqual([
      {from: '.claude/worktrees', to: '**/.claude/worktrees/'},
    ]);
    expect(readFileSync(path, 'utf-8')).toBe(
      '# header\nkeep-me\n**/.claude/worktrees/\n',
    );
  });

  test('collapses repeats of one entry, keeping the first position', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');
    sb.writeFile('.gitignore', 'dist\nkeep-me\ndist/\n**/dist\n');

    const result = ensureIgnoreEntries(path, ['dist/']);
    expect(result.removed).toEqual(['dist/', '**/dist']);
    expect(readFileSync(path, 'utf-8')).toBe('dist/\nkeep-me\n');
  });

  test('never matches a comment or a negation', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');
    sb.writeFile('.gitignore', '# dist\n!dist/keep.txt\n');

    const result = ensureIgnoreEntries(path, ['dist/']);
    expect(result.added).toEqual(['dist/']);
    expect(readFileSync(path, 'utf-8')).toBe(
      '# dist\n!dist/keep.txt\n\ndist/\n',
    );
  });

  test('appends under an optional section header, separated by a blank line', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.prettierignore');
    sb.writeFile('.prettierignore', 'existing\n');

    ensureIgnoreEntries(path, ['.beads'], {sectionHeader: 'Beads data'});
    expect(readFileSync(path, 'utf-8')).toBe(
      'existing\n\n# Beads data\n.beads\n',
    );
  });

  test('a file with no trailing newline does not get its last line fused', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');
    sb.writeFile('.gitignore', 'no-trailing-newline');

    ensureIgnoreEntries(path, ['tmp/']);
    expect(readFileSync(path, 'utf-8')).toBe('no-trailing-newline\n\ntmp/\n');
  });

  test('leaves entries it was not asked about completely alone', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');
    const before = 'secrets/\nsecrets/\n.env\n';
    sb.writeFile('.gitignore', before);

    ensureIgnoreEntries(path, ['tmp/']);
    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('.env');
    // The duplicate `secrets/` is NOT ours to collapse — only baseline entries
    // are reconciled.
    expect(after.split('\n').filter((line) => line === 'secrets/').length).toBe(
      2,
    );
  });

  test('does not create a file when nothing is requested', () => {
    const sb = track(createSandbox());
    const path = join(sb.path, '.gitignore');

    const result = ensureIgnoreEntries(path, []);
    expect(result.changed).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
