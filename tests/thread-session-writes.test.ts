/**
 * Which files a session wrote, from its own transcript (home-base-j8q3e.6 D1,
 * D2, D3), pure: the scan of one transcript's text, the match of a checkout's
 * dirty porcelain entries to it, and the time rule. The end-to-end cases (two
 * sessions in one checkout, a write older than the commit, an unreadable
 * transcript) are in thread-session-untracked.test.ts.
 */

import {describe, expect, test} from 'bun:test';

import {
  commandNames,
  commandSegments,
  commandWritesPath,
  isReadOnlySegment,
  newestWriteOf,
  ownDirtyPaths,
  readWrittenPaths,
  unquotePorcelainPath,
  writtenPathsFromText,
} from '../src/thread/session-writes';

const TOP = '/dev/repo';

function use(
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp?: string,
): string {
  return JSON.stringify({
    message: {content: [{id, input, name, type: 'tool_use'}]},
    ...(timestamp == null ? {} : {timestamp}),
    type: 'assistant',
  });
}

describe('writtenPathsFromText (D1)', () => {
  test('Edit, Write, MultiEdit and NotebookEdit paths and Bash commands are collected; other tools are not', () => {
    const text = [
      use('t1', 'Edit', {file_path: '/dev/repo/a.ts'}, '2030-01-01T09:00:00Z'),
      use('t2', 'Write', {file_path: '/dev/repo/b.ts'}, '2030-01-01T09:01:00Z'),
      use(
        't3',
        'MultiEdit',
        {file_path: '/dev/repo/c.ts'},
        '2030-01-01T09:02:00Z',
      ),
      use(
        't4',
        'NotebookEdit',
        {notebook_path: '/dev/repo/d.ipynb'},
        '2030-01-01T09:03:00Z',
      ),
      use('t5', 'Bash', {command: 'echo hi > e.txt'}, '2030-01-01T09:04:00Z'),
      use('t6', 'Read', {file_path: '/dev/repo/f.ts'}, '2030-01-01T09:05:00Z'),
      'not json "tool_use" "name":"Edit"',
    ].join('\n');
    const evidence = writtenPathsFromText(text, 'main.jsonl');
    expect(evidence.paths.map((write) => write.path)).toEqual([
      '/dev/repo/a.ts',
      '/dev/repo/b.ts',
      '/dev/repo/c.ts',
      '/dev/repo/d.ipynb',
    ]);
    expect(evidence.commands).toEqual([
      {
        command: 'echo hi > e.txt',
        file: 'main.jsonl',
        writtenAt: '2030-01-01T09:04:00Z',
      },
    ]);
    expect(evidence.unparsedLines).toBe(1);
  });

  test('a tool_use id repeated by an undated api-request-blob record is one write, keeping the dated time', () => {
    const text = [
      use('dup', 'Edit', {file_path: '/dev/repo/a.ts'}),
      use('dup', 'Edit', {file_path: '/dev/repo/a.ts'}, '2030-01-01T09:00:00Z'),
    ].join('\n');
    expect(writtenPathsFromText(text, 'f').paths).toEqual([
      {file: 'f', path: '/dev/repo/a.ts', writtenAt: '2030-01-01T09:00:00Z'},
    ]);
  });

  test('D2: a transcript that cannot be read is a failure, never an empty list', () => {
    const read = readWrittenPaths('/nonexistent/dir/session.jsonl');
    expect(read.ok).toBe(false);
  });
});

describe('matching a dirty entry to the writes (D1)', () => {
  const at = '2030-01-01T09:00:00.000Z';
  const ms = Date.parse(at);

  test('an Edit of the absolute path matches; an untracked directory entry matches writes inside it', () => {
    const evidence = {
      commands: [],
      paths: [{file: 'f', path: '/dev/repo/src/new/x.ts', writtenAt: at}],
    };
    expect(newestWriteOf('src/new/x.ts', TOP, evidence)).toEqual({at: ms});
    expect(newestWriteOf('src/new/', TOP, evidence)).toEqual({at: ms});
    expect(newestWriteOf('src/other.ts', TOP, evidence)).toBeNull();
  });

  test('a Bash command naming the path, relative or absolute, matches; a longer path containing it does not', () => {
    expect(commandNames('git add a.ts && git commit', 'a.ts')).toBe(true);
    expect(commandNames('cat ./a.ts', './a.ts')).toBe(true);
    expect(commandNames('cp x "/dev/repo/a.ts"', '/dev/repo/a.ts')).toBe(true);
    expect(commandNames('cat data.ts', 'a.ts')).toBe(false);
    expect(commandNames('cat lib/a.ts', 'a.ts')).toBe(false);
    expect(commandNames('cat a.tsx', 'a.ts')).toBe(false);
    const evidence = {
      commands: [{command: 'sed -i s/x/y/ ./a.ts', file: 'f', writtenAt: at}],
      paths: [],
    };
    expect(newestWriteOf('a.ts', TOP, evidence)).toEqual({at: ms});
  });

  test('a quoted porcelain path is unquoted before matching', () => {
    expect(unquotePorcelainPath('"a b.txt"')).toBe('a b.txt');
    expect(unquotePorcelainPath('"caf\\303\\251.md"')).toBe('café.md');
    expect(unquotePorcelainPath('plain.ts')).toBe('plain.ts');
  });
});

describe('the time rule (D3)', () => {
  const write = (path: string, writtenAt: string | null) => ({
    commands: [],
    paths: [{file: 'f', path: `${TOP}/${path}`, writtenAt}],
  });

  test("a write older than the last commit is not this session's; a newer one is; a never-committed path counts on any write", () => {
    const committed = Date.parse('2030-01-01T10:00:00.000Z');
    const older = write('a.ts', '2030-01-01T09:00:00.000Z');
    const newer = write('a.ts', '2030-01-01T11:00:00.000Z');
    const commits = new Map([['a.ts', committed]]);
    expect(
      ownDirtyPaths({
        dirty: ['a.ts'],
        evidence: older,
        lastCommitMs: commits,
        top: TOP,
      }),
    ).toEqual([]);
    expect(
      ownDirtyPaths({
        dirty: ['a.ts'],
        evidence: newer,
        lastCommitMs: commits,
        top: TOP,
      }),
    ).toEqual(['a.ts']);
    expect(
      ownDirtyPaths({
        dirty: ['a.ts'],
        evidence: older,
        lastCommitMs: new Map([['a.ts', null]]),
        top: TOP,
      }),
    ).toEqual(['a.ts']);
  });

  test("a write in the same second as the commit (git keeps whole seconds) is the commit's, not later work", () => {
    const committed = Date.parse('2030-01-01T10:00:00.000Z');
    expect(
      ownDirtyPaths({
        dirty: ['a.ts'],
        evidence: write('a.ts', '2030-01-01T10:00:00.700Z'),
        lastCommitMs: new Map([['a.ts', committed]]),
        top: TOP,
      }),
    ).toEqual([]);
  });

  test('a write no record dates cannot be shown older than the commit, so it counts', () => {
    expect(
      ownDirtyPaths({
        dirty: ['a.ts'],
        evidence: write('a.ts', null),
        lastCommitMs: new Map([['a.ts', Date.parse('2030-01-01T10:00:00Z')]]),
        top: TOP,
      }),
    ).toEqual(['a.ts']);
  });
});

describe('j8q3e.13 F3: a Bash command counts only when it writes the path', () => {
  const writes = (command: string, path = 'config.json'): boolean =>
    commandWritesPath(command, TOP, path);

  test('a read-only verb does not write what it names', () => {
    for (const command of [
      'cat config.json',
      'jq . config.json',
      'git diff config.json',
      'git --no-pager log -p -- config.json',
      'git -C /dev/repo show HEAD:config.json',
      'ls -la config.json',
      'head -20 ./config.json',
      'grep -n x /dev/repo/config.json',
      'rg x config.json | head',
      'wc -l config.json && stat config.json',
      'bun test config.json',
    ]) {
      expect([command, writes(command)]).toEqual([command, false]);
    }
  });

  test('a redirect, tee, or any other verb writes it', () => {
    for (const command of [
      'echo x > config.json',
      'cat a.json >> config.json',
      'jq .a other.json >config.json',
      'cat other.json | tee config.json',
      'git add config.json',
      'bun run fix config.json',
      'sed -i s/a/b/ config.json',
      'cd /dev/repo && git add config.json',
      'cat x; cp other.json config.json',
    ]) {
      expect([command, writes(command)]).toEqual([command, true]);
    }
  });

  test('after a cd out of the checkout, a relative path is not this checkout’s; its absolute path still is', () => {
    expect(writes('cd ../other && git add package.json', 'package.json')).toBe(
      false,
    );
    expect(
      writes('cd ~/elsewhere && git add package.json', 'package.json'),
    ).toBe(false);
    expect(writes('cd $DIR && git add package.json', 'package.json')).toBe(
      false,
    );
    expect(
      writes('cd ../other && cp x /dev/repo/package.json', 'package.json'),
    ).toBe(true);
    // A cd inside the checkout moves what a relative path means.
    expect(writes('cd pkg && git add package.json', 'pkg/package.json')).toBe(
      true,
    );
    expect(writes('cd pkg && git add package.json', 'package.json')).toBe(
      false,
    );
  });

  test('quoted separators do not split a command', () => {
    expect(
      commandSegments(`git commit -m 'a; b && c | d' && git push`),
    ).toEqual([`git commit -m 'a; b && c | d'`, 'git push']);
    expect(commandSegments('a|b||c&&d;e\nf |& g')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
  });

  test('isReadOnlySegment names the verbs; bun run is not read-only', () => {
    expect(isReadOnlySegment('FOO=1 cat x')).toBe(true);
    expect(isReadOnlySegment('git status')).toBe(true);
    expect(isReadOnlySegment('git commit -m x')).toBe(false);
    expect(isReadOnlySegment('bun run tools')).toBe(false);
    expect(isReadOnlySegment('/bin/cat x')).toBe(true);
  });

  test('newestWriteOf: a session that only read the dirty file has no write of it', () => {
    const at = '2030-01-01T09:00:00.000Z';
    const readOnly = {
      commands: [{command: 'cat config.json', file: 'f', writtenAt: at}],
      paths: [],
    };
    expect(newestWriteOf('config.json', TOP, readOnly)).toBeNull();
    const wrote = {
      commands: [{command: 'echo {} > config.json', file: 'f', writtenAt: at}],
      paths: [],
    };
    expect(newestWriteOf('config.json', TOP, wrote)).toEqual({
      at: Date.parse(at),
    });
  });
});
