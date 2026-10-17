/**
 * worktree-salvage's porcelain v2 parser and checkout reader (D2, critical
 * rule 7). The parser is pure; the reader runs against real repos.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {
  parsePorcelainV2,
  readCheckoutFacts,
  readStatus,
} from '../src/worktree-salvage/status';
import {
  addSubmodule,
  git,
  initPrimary,
  initRepo,
  withFileSubmodulesAllowed,
  write,
} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const H = 'a'.repeat(40);
const I = 'b'.repeat(40);
const Z = '0'.repeat(40);

function records(...lines: string[]): string {
  return `${lines.join('\0')}\0`;
}

describe('parsePorcelainV2', () => {
  test('parses every record type, keeping spaces in paths', () => {
    const parsed = parsePorcelainV2(
      records(
        `1 .M N... 100644 100644 100644 ${H} ${H} dir with space/a file.txt`,
        `2 R. N... 100644 100644 100644 ${H} ${I} R100 new name.txt`,
        'old name.txt',
        `1 D. N... 100644 000000 000000 ${H} ${Z} gone.txt`,
        `1 .D N... 100644 100644 000000 ${H} ${H} gone-from-worktree.txt`,
        `1 A. N... 000000 100644 100644 ${Z} ${I} added.txt`,
        `1 .T N... 100644 100644 120000 ${H} ${H} now-a-link`,
        `u UU N... 100644 100644 100644 100644 ${H} ${I} ${H} conflict.txt`,
        '? untracked file.txt',
        '? nested/',
        `1 .M S.M. 160000 160000 160000 ${H} ${H} sub`,
        '! tmp/',
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const {entries, ignored, nested} = parsed.value;
    expect(
      entries.map((entry) => [
        entry.path,
        entry.kind,
        entry.status,
        entry.inWorktree,
      ]),
    ).toEqual([
      ['dir with space/a file.txt', 'modified', '.M', true],
      ['new name.txt', 'renamed', 'R.', true],
      ['gone.txt', 'deleted', 'D.', false],
      ['gone-from-worktree.txt', 'deleted', '.D', false],
      ['added.txt', 'added', 'A.', true],
      ['now-a-link', 'type-changed', '.T', true],
      ['conflict.txt', 'unmerged', 'UU', true],
      ['untracked file.txt', 'untracked', '??', true],
    ]);
    expect(entries[1]?.origPath).toBe('old name.txt');
    expect(entries[2]?.headBlob).toBe(H);
    expect(entries[2]?.indexBlob).toBeNull();
    expect(entries[4]?.headBlob).toBeNull();
    expect(nested).toEqual([
      {kind: 'nested-repository', path: 'nested', submoduleState: null},
      {kind: 'submodule', path: 'sub', submoduleState: 'S.M.'},
    ]);
    expect(ignored).toEqual(['tmp/']);
  });

  test('an empty listing is a clean checkout, not a failure', () => {
    expect(parsePorcelainV2('')).toEqual({
      ok: true,
      value: {entries: [], ignored: [], nested: []},
    });
  });

  test('an unrecognised record is a failure naming it, never skipped', () => {
    const parsed = parsePorcelainV2(records('X something new'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('X something new');
  });

  test('a rename with no original path is a failure', () => {
    const parsed = parsePorcelainV2(
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 new.txt\0`,
    );
    expect(parsed.ok).toBe(false);
  });

  test('a truncated ordinary record is a failure', () => {
    const parsed = parsePorcelainV2(records('1 .M N... 100644'));
    expect(parsed.ok).toBe(false);
  });
});

describe('readStatus and readCheckoutFacts', () => {
  test('a directory that is not a git checkout is a typed failure, never an empty status', () => {
    const sb = track();
    sb.mkdir('plain');
    const status = readStatus(join(sb.path, 'plain'));
    expect(status.ok).toBe(false);
    const facts = readCheckoutFacts(join(sb.path, 'plain'));
    expect(facts.ok).toBe(false);
    if (!facts.ok)
      expect(facts.error).toContain('is not inside a git checkout');
  });

  test('a submodule with changes inside is recorded as a nested checkout, not as entries', () => {
    const sb = track();
    const source = initRepo(sb, 'subsource', {'inner.txt': 'inner\n'});
    const primary = initPrimary(sb, {'top.txt': 'top\n'});
    withFileSubmodulesAllowed(() => {
      addSubmodule(primary, source, 'vendor/sub');
    });
    write(primary, 'vendor/sub/inner.txt', 'changed inside the submodule\n');
    const status = readStatus(primary);
    if (!status.ok) throw new Error(status.error);
    expect(status.value.parsed.entries).toEqual([]);
    expect(status.value.parsed.nested).toEqual([
      {kind: 'submodule', path: 'vendor/sub', submoduleState: 'S.M.'},
    ]);
  });

  test('a detached HEAD has no branch and no upstream, which is not a failure', () => {
    const sb = track();
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    git(primary, ['checkout', '-q', '--detach']);
    const facts = readCheckoutFacts(primary);
    if (!facts.ok) throw new Error(facts.error);
    expect(facts.value.branch).toBeNull();
    expect(facts.value.upstream).toEqual({ok: true, value: null});
  });
});
