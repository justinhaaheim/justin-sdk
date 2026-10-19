/**
 * Justin's read / unread marks (home-base-yukaf.9, epic home-base-yukaf
 * D-READ-STATE): the store, the derivation, `thread read` / `thread unread`,
 * and the pinnedProjects knob (D-PINS). No br: these are local files only.
 *
 * NEGATIVE CONTROL (run once, 2026-10-18): with `unreadFrom` returning false
 * for a session with no marks, "no marks is unread" failed (false, expected
 * true); restored, green.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {messageLogPath} from '../src/thread/archive';
import {resolveThreadConfig} from '../src/thread/config';
import {serializeMessageLine} from '../src/thread/message-log';
import {pinnedFirst} from '../src/thread/pinned-projects';
import {
  appendReadMark,
  markAllRead,
  markRead,
  type ReadMark,
  readMarksPath,
  readReadMarks,
  unreadFor,
  unreadFrom,
} from '../src/thread/read-marks';
import {createSandbox} from './sandbox';

const SID = '9e000000-1111-4222-8333-000000000001';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function env(): Record<string, string | undefined> {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg'),
  };
}

const mark = (
  kind: ReadMark['mark'],
  at: string,
  seen: string | null,
): ReadMark => ({at, mark: kind, seenAssistantAt: seen, sessionId: SID});

describe('unreadFrom (D-READ-STATE)', () => {
  const T9 = '2030-01-01T09:00:00.000Z';
  const T10 = '2030-01-01T10:00:00.000Z';

  test('no marks is unread', () => {
    expect(unreadFrom([], T9)).toBe(true);
  });

  test('read, then newer assistant activity, is unread; read up to date is not', () => {
    expect(unreadFrom([mark('read', T9, T9)], T10)).toBe(true);
    expect(unreadFrom([mark('read', T10, T10)], T10)).toBe(false);
    // Read before Claude had written anything, and now it has.
    expect(unreadFrom([mark('read', T9, null)], T10)).toBe(true);
  });

  test('unread after read is unread, whatever the times say', () => {
    expect(
      unreadFrom([mark('read', T10, T10), mark('unread', T10, T10)], T10),
    ).toBe(true);
    // And a later read wins again.
    expect(
      unreadFrom(
        [
          mark('read', T9, T10),
          mark('unread', T9, T10),
          mark('read', T10, T10),
        ],
        T10,
      ),
    ).toBe(false);
  });

  test('no assistant activity to compare is null, never false', () => {
    expect(unreadFrom([mark('read', T10, T10)], null)).toBeNull();
    expect(unreadFrom([], 'not a time')).toBeNull();
  });
});

describe('the read-marks store', () => {
  test('append, then read back by session in file order; no file is no marks', () => {
    const e = env();
    const empty = readReadMarks(e);
    expect(empty.kind).toBe('read');
    expect(appendReadMark(mark('read', 'a', null), e).kind).toBe('ok');
    expect(appendReadMark(mark('unread', 'b', null), e).kind).toBe('ok');
    const read = readReadMarks(e);
    if (read.kind !== 'read') throw new Error(read.reason);
    expect(read.bySessionId.get(SID)?.map((m) => m.mark)).toEqual([
      'read',
      'unread',
    ]);
  });

  test('an unreadable file is a failure, and every session then reads as null', () => {
    const e = env();
    mkdirSync(dirname(readMarksPath(e)), {recursive: true});
    writeFileSync(readMarksPath(e), 'not json\n');
    const read = readReadMarks(e);
    expect(read.kind).toBe('failed');
    expect(unreadFor(read, SID, '2030-01-01T09:00:00.000Z')).toBeNull();
  });

  test('a partial last line (an append in flight) is skipped, not a failure', () => {
    const e = env();
    appendReadMark(mark('read', 'a', null), e);
    writeFileSync(
      readMarksPath(e),
      `${readFileSync(readMarksPath(e), 'utf8')}{"at":"b","ma`,
    );
    expect(readReadMarks(e).kind).toBe('read');
  });
});

describe('thread read / thread unread', () => {
  test('read with no --seen records the message log’s last assistant line', () => {
    const e = env();
    const path = messageLogPath(SID, e);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      [
        serializeMessageLine({
          at: '2030-01-01T09:00:00.000Z',
          cwd: null,
          event: 'Stop',
          role: 'assistant',
          text: 'done',
        }),
        serializeMessageLine({
          at: '2030-01-01T09:05:00.000Z',
          cwd: null,
          event: 'UserPromptSubmit',
          role: 'user',
          text: 'thanks',
        }),
      ].join(''),
    );
    const outcome = markRead({
      env: e,
      mark: 'read',
      seen: null,
      sessionId: SID,
    });
    expect(outcome).toMatchObject({
      kind: 'marked',
      mark: {mark: 'read', seenAssistantAt: '2030-01-01T09:00:00.000Z'},
    });
  });

  test('--seen is taken as given; a bad one or a bad session id is usage', () => {
    const e = env();
    expect(
      markRead({
        env: e,
        mark: 'read',
        seen: '2030-01-01T08:00:00.000Z',
        sessionId: SID,
      }),
    ).toMatchObject({mark: {seenAssistantAt: '2030-01-01T08:00:00.000Z'}});
    expect(
      markRead({env: e, mark: 'read', seen: 'yesterday', sessionId: SID}).kind,
    ).toBe('usage');
    expect(
      markRead({env: e, mark: 'unread', seen: null, sessionId: '../x'}).kind,
    ).toBe('usage');
  });

  test('a mark that cannot be written is a failure', () => {
    const e = env();
    mkdirSync(readMarksPath(e), {recursive: true});
    expect(
      markRead({env: e, mark: 'unread', seen: null, sessionId: SID}).kind,
    ).toBe('failed');
  });
});

describe('pinnedProjects (D-PINS)', () => {
  test('pinnedFirst moves the pins to the front in config order, ignoring case', () => {
    expect(
      pinnedFirst(['beta', 'home-base', 'alpha'], ['Alpha', 'home-base', 'x']),
    ).toEqual(['alpha', 'home-base', 'beta']);
    expect(pinnedFirst(['beta', 'alpha'], [])).toEqual(['beta', 'alpha']);
  });

  test('the knob defaults to [], is read from the user file, and a bad value is named and ignored', () => {
    const e = env();
    const cwd = e.JUSTIN_THREADS_STATE_DIR ?? '';
    mkdirSync(cwd, {recursive: true});
    expect(resolveThreadConfig({cwd, env: e})).toMatchObject({
      pinnedProjects: [],
      pinnedProjectsSource: 'default',
    });
    const file = join(e.XDG_CONFIG_HOME ?? '', 'justin-sdk', 'config.json');
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(
      file,
      JSON.stringify({
        componentConfig: {thread: {pinnedProjects: ['home-base']}},
      }),
    );
    expect(resolveThreadConfig({cwd, env: e})).toMatchObject({
      pinnedProjects: ['home-base'],
      pinnedProjectsSource: 'user',
    });
    writeFileSync(
      file,
      JSON.stringify({
        componentConfig: {thread: {pinnedProjects: 'home-base'}},
      }),
    );
    const bad = resolveThreadConfig({cwd, env: e});
    expect(bad.pinnedProjects).toEqual([]);
    expect(bad.problems.join('\n')).toContain('pinnedProjects');
  });
});

describe('thread read --all (home-base-yukaf.14 F7)', () => {
  test('marks each unread row read once, up to its assistant activity; read and unknown rows write nothing', () => {
    const e = env();
    const at = (n: number) => `2030-01-01T0${n}:00:00.000Z`;
    const sid = (n: number) => `9e000000-1111-4222-8333-00000000000${n}`;
    const outcome = markAllRead(
      [
        {lastAssistantAt: at(1), sessionId: sid(1), unread: true},
        {lastAssistantAt: at(2), sessionId: sid(2), unread: false},
        {lastAssistantAt: null, sessionId: sid(3), unread: null},
        {lastAssistantAt: at(4), sessionId: sid(4), unread: true},
        // Listed twice (search hit and row): one record.
        {lastAssistantAt: at(4), sessionId: sid(4), unread: true},
      ],
      {env: e, now: new Date(at(9))},
    );
    expect(outcome).toEqual({
      alreadyRead: 1,
      failures: [],
      marked: [sid(1), sid(4)],
      unknown: 1,
    });
    const marks = readReadMarks(e);
    if (marks.kind !== 'read') throw new Error('marks unreadable');
    expect([...marks.bySessionId.keys()].sort()).toEqual([sid(1), sid(4)]);
    expect(marks.bySessionId.get(sid(4))).toEqual([
      {at: at(9), mark: 'read', seenAssistantAt: at(4), sessionId: sid(4)},
    ]);
    // Read now, and unread again once Claude writes after it.
    expect(unreadFor(marks, sid(1), at(1))).toBe(false);
    expect(unreadFor(marks, sid(1), at(5))).toBe(true);
  });

  test('a failed write is named per session, never counted as marked', () => {
    const e = env();
    const path = readMarksPath(e);
    mkdirSync(path, {recursive: true}); // a directory where the file goes
    const outcome = markAllRead(
      [
        {
          lastAssistantAt: '2030-01-01T01:00:00.000Z',
          sessionId: SID,
          unread: true,
        },
      ],
      {env: e},
    );
    expect(outcome.marked).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toContain(SID);
  });
});
