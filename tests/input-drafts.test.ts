/**
 * The unsent-drafts store (home-base-yukaf.2, D-DRAFTS): one file per session
 * under <threads state dir>/input-drafts/, written atomically, cleared without
 * losing the text, and never named after anything that is not a session id.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  clearInputDraft,
  inputDraftPath,
  inputDraftsDir,
  listInputDrafts,
  readInputDraft,
  writeInputDraft,
} from '../src/thread/input-drafts';

const SID = '3f2a9c10-1111-4222-8333-000000000001';
const OTHER = '3f2a9c10-1111-4222-8333-000000000002';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function env(): {JUSTIN_THREADS_STATE_DIR: string} {
  const dir = mkdtempSync(join(tmpdir(), 'input-drafts-'));
  dirs.push(dir);
  return {JUSTIN_THREADS_STATE_DIR: join(dir, 'state')};
}

describe('input-drafts store', () => {
  test('write then read round-trips every field, at <state>/input-drafts/<sid>.json', () => {
    const e = env();
    const written = writeInputDraft(
      {
        at: '2026-10-18T12:00:00.000Z',
        sessionId: SID,
        source: 'undo',
        surfaceId: 'SURF-1',
        text: 'line one\n  line two',
        workspaceId: 'WS-1',
      },
      e,
    );
    expect(written.kind).toBe('written');
    const path = join(
      e.JUSTIN_THREADS_STATE_DIR,
      'input-drafts',
      `${SID}.json`,
    );
    expect(inputDraftPath(SID, e)).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      at: '2026-10-18T12:00:00.000Z',
      clearedAt: null,
      clearedBy: null,
      missingSince: null,
      previous: [],
      sentMatch: false,
      source: 'undo',
      surfaceId: 'SURF-1',
      text: 'line one\n  line two',
      workspaceId: 'WS-1',
    });
    const read = readInputDraft(SID, e);
    expect(read).toEqual({
      draft: {
        at: '2026-10-18T12:00:00.000Z',
        clearedAt: null,
        clearedBy: null,
        missingSince: null,
        previous: [],
        sentMatch: false,
        source: 'undo',
        surfaceId: 'SURF-1',
        text: 'line one\n  line two',
        workspaceId: 'WS-1',
      },
      kind: 'present',
      path,
    });
    // No temporary file is left behind.
    expect(readdirSync(inputDraftsDir(e))).toEqual([`${SID}.json`]);
  });

  test('a file written before F18 (no previous) still reads, and a write over an unreadable file is refused', () => {
    const e = env();
    const path = inputDraftPath(SID, e);
    mkdirSync(inputDraftsDir(e), {recursive: true});
    writeFileSync(
      path,
      JSON.stringify({
        at: '2026-10-18T12:00:00.000Z',
        clearedAt: null,
        source: 'scan',
        surfaceId: null,
        text: 'old shape',
        workspaceId: null,
      }),
    );
    expect(readInputDraft(SID, e)).toMatchObject({
      draft: {previous: [], text: 'old shape'},
      kind: 'present',
    });
    writeFileSync(path, 'not json');
    const refused = writeInputDraft(
      {
        sessionId: SID,
        source: 'scan',
        surfaceId: null,
        text: 'new text',
        workspaceId: null,
      },
      e,
    );
    expect(refused.kind).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe('not json');
  });

  // home-base-yukaf.14 F22.
  test('a write uses a per-process temporary name, so a leftover at the old fixed name cannot block it', () => {
    const e = env();
    mkdirSync(inputDraftsDir(e), {recursive: true});
    mkdirSync(`${inputDraftPath(SID, e)}.tmp`);
    const written = writeInputDraft(
      {
        sessionId: SID,
        source: 'scan',
        surfaceId: null,
        text: 'still written',
        workspaceId: null,
      },
      e,
    );
    expect(written.kind).toBe('written');
    expect(readInputDraft(SID, e)).toMatchObject({
      draft: {text: 'still written'},
    });
  });

  test('a second write replaces the observation (the latest one is kept)', () => {
    const e = env();
    const base = {
      sessionId: SID,
      source: 'undo' as const,
      surfaceId: null,
      workspaceId: null,
    };
    writeInputDraft(
      {...base, at: '2026-10-18T12:00:00.000Z', text: 'first'},
      e,
    );
    writeInputDraft(
      {...base, at: '2026-10-18T12:05:00.000Z', text: 'second'},
      e,
    );
    const read = readInputDraft(SID, e);
    expect(read.kind === 'present' ? read.draft.text : null).toBe('second');
  });

  test('clear sets clearedAt and keeps the text; clearing again keeps the first clearedAt', () => {
    const e = env();
    writeInputDraft(
      {
        at: '2026-10-18T12:00:00.000Z',
        sessionId: SID,
        source: 'scan',
        surfaceId: null,
        text: 'keep me',
        workspaceId: null,
      },
      e,
    );
    const cleared = clearInputDraft(SID, e, '2026-10-18T13:00:00.000Z');
    expect(cleared.kind).toBe('cleared');
    const again = clearInputDraft(SID, e, '2026-10-18T14:00:00.000Z');
    expect(again.kind === 'cleared' ? again.draft.clearedAt : null).toBe(
      '2026-10-18T13:00:00.000Z',
    );
    const read = readInputDraft(SID, e);
    expect(read.kind === 'present' ? read.draft : null).toMatchObject({
      clearedAt: '2026-10-18T13:00:00.000Z',
      text: 'keep me',
    });
  });

  test('absent, and a file that cannot be parsed is failed, never absent (rule 7)', () => {
    const e = env();
    expect(readInputDraft(SID, e).kind).toBe('absent');
    expect(clearInputDraft(SID, e).kind).toBe('absent');
    mkdirSync(inputDraftsDir(e), {recursive: true});
    writeFileSync(inputDraftPath(SID, e), '{not json');
    expect(readInputDraft(SID, e).kind).toBe('failed');
    writeFileSync(
      inputDraftPath(SID, e),
      JSON.stringify({text: 'no other fields'}),
    );
    expect(readInputDraft(SID, e).kind).toBe('failed');
  });

  test('a session id that is not a file name is refused by every entry point, and nothing is written', () => {
    const e = env();
    for (const bad of ['../escape', '.hidden', 'a/b', '', '-dash']) {
      const written = writeInputDraft(
        {
          sessionId: bad,
          source: 'undo',
          surfaceId: null,
          text: 'x',
          workspaceId: null,
        },
        e,
      );
      expect(written.kind).toBe('failed');
      expect(written.kind === 'failed' ? written.reason : '').toContain(
        'refused',
      );
      const read = readInputDraft(bad, e);
      expect(read.kind).toBe('failed');
      expect(clearInputDraft(bad, e).kind).toBe('failed');
      expect(() => inputDraftPath(bad, e)).toThrow('refused');
    }
    expect(existsSync(inputDraftsDir(e))).toBe(false);
  });

  test('list: an absent store is read and empty; drafts newest first; a bad file is a failure, not dropped silently', () => {
    const e = env();
    expect(listInputDrafts(e)).toEqual({
      drafts: [],
      failures: [],
      kind: 'read',
    });
    const base = {source: 'undo' as const, surfaceId: null, workspaceId: null};
    writeInputDraft(
      {...base, at: '2026-10-18T12:00:00.000Z', sessionId: SID, text: 'older'},
      e,
    );
    writeInputDraft(
      {
        ...base,
        at: '2026-10-18T12:30:00.000Z',
        sessionId: OTHER,
        text: 'newer',
      },
      e,
    );
    writeFileSync(join(inputDraftsDir(e), 'broken-1.json'), 'nope');
    const listed = listInputDrafts(e);
    if (listed.kind !== 'read') throw new Error('expected read');
    expect(listed.drafts.map((entry) => entry.sessionId)).toEqual([OTHER, SID]);
    expect(listed.failures).toHaveLength(1);
    expect(listed.failures[0]).toContain('broken-1.json');
  });
});
