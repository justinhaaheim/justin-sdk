/**
 * The documented lint-on-edit hook prints nothing for a file outside the project
 * (home-base-p05kz.4 change 5). No SDK installer writes this entry: this doc is
 * the only SDK source of it, and the audit counted 704 skip lines in two weeks.
 */

import {expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {resolve} from 'path';

test('the PostToolUse snippet in base-setup.md has no skip message', () => {
  const doc = readFileSync(
    resolve(import.meta.dirname, '..', 'docs', 'base-setup.md'),
    'utf-8',
  );
  const line = doc.split('\n').find((l) => l.includes('lint:fix:file --'));
  expect(line).toBeDefined();
  expect(line).not.toContain('echo');
  expect(line).not.toContain('Skipping');
});
