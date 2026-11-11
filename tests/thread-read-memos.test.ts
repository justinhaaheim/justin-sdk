/**
 * home-base-9uzxw.16 part 2: the inbox's small repeated reads are kept in
 * memory until the file changes (src/thread/file-memo.ts): each config file's
 * text (`readTextMemoized`, behind both config readers) and an untracked
 * session's last assistant line (`readLastAssistantLineMemoized`). Each answer
 * equals the uncached reader's, a second read of an unchanged file reads
 * nothing, and a change is seen on the next read.
 */

import {afterAll, beforeEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {readProjectConfig} from '../src/sdk-config';
import {
  FILE_MEMO_KNOB,
  fileMemoStats,
  readTextMemoized,
  resetFileMemo,
} from '../src/thread/file-memo';
import {
  readLastAssistantLine,
  readLastAssistantLineMemoized,
  serializeMessageLine,
  TAIL_READ_BYTES,
} from '../src/thread/message-log';

const MARKER = '[TEST_DATA_DELETABLE 9b0eb49b-f4dd-43f5-93e5-f6e6f3de4ef9 ]';
const root = mkdtempSync(join(tmpdir(), 'read-memos-test-'));
const savedKnob = process.env[FILE_MEMO_KNOB];

afterAll(() => {
  rmSync(root, {force: true, recursive: true});
  if (savedKnob == null) delete process.env[FILE_MEMO_KNOB];
  else process.env[FILE_MEMO_KNOB] = savedKnob;
});

beforeEach(() => {
  delete process.env[FILE_MEMO_KNOB];
  resetFileMemo();
});

function message(role: 'assistant' | 'user', text: string, at: string): string {
  return serializeMessageLine({
    at,
    cwd: '/fixture/Dev/memo',
    event: 'backfill',
    role,
    text: `${text} ${MARKER}`,
  });
}

describe('an untracked session’s last assistant line', () => {
  test('equals the tail reader’s answer, reads nothing the second time, and sees an append', () => {
    const path = join(root, 'log-1.jsonl');
    writeFileSync(
      path,
      message('user', 'Start', '2030-01-01T09:00:00.000Z') +
        message('assistant', 'First answer', '2030-01-01T09:01:00.000Z') +
        message('user', 'More', '2030-01-01T09:02:00.000Z'),
    );
    const first = readLastAssistantLineMemoized(path);
    expect(first).toEqual(readLastAssistantLine(path));
    expect(first.kind).toBe('found');

    const before = fileMemoStats();
    expect(readLastAssistantLineMemoized(path)).toEqual(first);
    const after = fileMemoStats();
    expect(after.hits).toBe(before.hits + 1);
    expect(after.reads).toBe(before.reads);

    appendFileSync(
      path,
      message('assistant', 'Second answer', '2030-01-01T09:03:00.000Z'),
    );
    const grown = readLastAssistantLineMemoized(path);
    expect(grown).toEqual(readLastAssistantLine(path));
    expect(JSON.stringify(grown)).toContain('Second answer');
  });

  test('an assistant line older than the tail window, no assistant line, and no log at all', () => {
    const old = join(root, 'log-2.jsonl');
    writeFileSync(
      old,
      message('assistant', 'Long ago', '2030-01-01T08:00:00.000Z') +
        message(
          'user',
          'x'.repeat(TAIL_READ_BYTES),
          '2030-01-01T08:01:00.000Z',
        ),
    );
    expect(readLastAssistantLineMemoized(old)).toEqual(
      readLastAssistantLine(old),
    );
    expect(JSON.stringify(readLastAssistantLineMemoized(old))).toContain(
      'Long ago',
    );

    const none = join(root, 'log-3.jsonl');
    writeFileSync(none, message('user', 'Only me', '2030-01-01T09:00:00.000Z'));
    expect(readLastAssistantLineMemoized(none)).toEqual({kind: 'none'});
    expect(readLastAssistantLine(none)).toEqual({kind: 'none'});

    const missing = join(root, 'log-missing.jsonl');
    expect(readLastAssistantLineMemoized(missing)).toEqual(
      readLastAssistantLine(missing),
    );
  });
});

describe('a config file’s text', () => {
  test('is read once until it changes, and the config read sees the change', () => {
    const repo = mkdtempSync(join(root, 'repo-'));
    const path = join(repo, 'justin-sdk.config.json');
    writeFileSync(path, JSON.stringify({projectTag: 'ONE'}));
    const first = readProjectConfig(repo);
    expect(first.status).toBe('ok');

    const before = fileMemoStats();
    expect(readProjectConfig(repo)).toEqual(first);
    const after = fileMemoStats();
    expect(after.hits).toBe(before.hits + 1);
    expect(after.reads).toBe(before.reads);

    writeFileSync(path, JSON.stringify({projectTag: 'TWO2'}));
    const changed = readProjectConfig(repo);
    expect(JSON.stringify(changed)).toContain('TWO2');
  });

  test(`${FILE_MEMO_KNOB}=off gives null, so the reader reads the file itself`, () => {
    const path = join(root, 'plain.json');
    writeFileSync(path, '{}');
    expect(readTextMemoized(path)).toBe('{}');
    process.env[FILE_MEMO_KNOB] = 'off';
    expect(readTextMemoized(path)).toBeNull();
    expect(readProjectConfig(root).status).toBe('absent');
  });
});
