/**
 * home-base-7nn2f: a finished session in a SHARED checkout keeps one inbox
 * section while other sessions dirty that checkout and commit it.
 *
 * On 2026-11-06 two finished sessions in home-base's main checkout moved from
 * Done to To land and back with every save and commit of a third session
 * there: a session's `git.uncommitted` was then every dirty file in its
 * checkout. Since commit 72d3bbb7 it is only the dirty files its own
 * transcript wrote after their last commit (`attributeUncommitted`). This file
 * runs the whole path `thread inbox` runs — `readInbox`: session beads, the
 * message log, the transcript, real git, `deriveStatus`, `deriveAction`,
 * `sectionFor` — so that the case that flipped stays covered.
 *
 * The fixture is the case that flipped: sessions A and B each wrote a file,
 * committed it and closed their only request, on `main` (merge state
 * `isDefault`). Session C, the third, then writes G and edits A's F. Each
 * `test` below is one inbox read; they run in order and each one changes the
 * checkout first. Commit dates are pinned (`commitAt`), because whether a
 * write is a session's own is decided by comparing its transcript time with
 * the path's last commit time.
 *
 * A's and B's transcripts carry no `git commit` record: with every request
 * closed, neither the status nor the action reads the session's commit count.
 *
 * NEGATIVE CONTROL (2026-11-07): with `measureGit`'s old line,
 * `uncommitted: shared.uncommitted`, put back, both read 2 tests fail (A and B
 * are `toLand`, rule 6, uncommitted ['G.ts'] then ['F.ts', 'G.ts']) and read 3
 * passes again: the Done, To land, Done the watcher saw. The last test fails
 * on B. Recorded in home-base-7nn2f.
 */

import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brClose, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {type InboxRow, readInbox} from '../src/thread/session-inbox';
import {measured} from '../src/thread/session-model';
import {git, initRepo, write} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const t = (hhmm: string): string => `2030-01-01T${hhmm}:00.000Z`;

const A = '7ee20000-1111-4222-8333-000000000041';
const B = '7ee20000-1111-4222-8333-000000000042';
const C = '7ee20000-1111-4222-8333-000000000043';

let sb: Sandbox;
let env: Record<string, string | undefined>;
let repo: string;
const transcripts: Record<string, string> = {};

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, text);
}

/** One transcript record: an Edit or Write of `file` (the shape thread-own-uncommitted.test.ts writes). */
function writeRecord(
  sessionId: string,
  tool: 'Edit' | 'Write',
  file: string,
  at: string,
): object {
  return {
    cwd: repo,
    message: {
      content: [
        {
          id: `toolu_${sessionId.slice(-2)}_${at}`,
          input:
            tool === 'Write'
              ? {content: 'x\n', file_path: file}
              : {file_path: file, new_string: 'y', old_string: 'x'},
          name: tool,
          type: 'tool_use',
        },
      ],
      role: 'assistant',
    },
    sessionId,
    timestamp: at,
    type: 'assistant',
  };
}

function appendRecords(sessionId: string, records: object[]): void {
  const path = transcripts[sessionId];
  if (path == null) throw new Error(`no transcript for ${sessionId}`);
  appendFileSync(
    path,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
}

/**
 * A tracked session in `repo`: its session bead, a message log whose last line
 * is Claude's, and a transcript holding `between` and a closing assistant
 * record at `end`.
 */
function trackedSession(
  sessionId: string,
  title: string,
  times: {end: string; start: string},
  between: object[],
): void {
  const filed = ensureSessionBead({
    cwd: repo,
    env: {...env, CLAUDE_CODE_SESSION_ID: sessionId},
    firstPrompt: {at: times.start, text: title},
    now: new Date(times.start),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  writeFile(
    messageLogPath(sessionId, env),
    [
      serializeMessageLine({
        at: times.start,
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        text: title,
      }),
      serializeMessageLine({
        at: times.end,
        cwd: repo,
        event: 'Stop',
        role: 'assistant',
        text: 'Done.',
      }),
    ].join(''),
  );
  const path = join(
    sb.path,
    'projects',
    repo.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  );
  transcripts[sessionId] = path;
  writeFile(path, '');
  appendRecords(sessionId, [
    {
      cwd: repo,
      message: {content: title, role: 'user'},
      sessionId,
      timestamp: times.start,
      type: 'user',
    },
    ...between,
    {
      cwd: repo,
      message: {
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
          input_tokens: 10,
        },
      },
      sessionId,
      timestamp: times.end,
      type: 'assistant',
    },
  ]);
}

async function requestFor(
  sessionId: string,
  title: string,
  close: boolean,
): Promise<void> {
  const filed = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env,
    here: false,
    now: NOW,
    sessionId,
    title,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  if (close && brClose({cwd: repo}, filed.id, 'done').kind !== 'ok') {
    throw new Error(`could not close ${filed.id}`);
  }
}

/** Commit `paths` with both git dates pinned to `at`. */
function commitAt(paths: string[], at: string, message: string): void {
  git(repo, ['add', '--', ...paths]);
  execFileSync('git', ['commit', '-qm', message], {
    cwd: repo,
    env: {...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function readRows(): Promise<Record<string, InboxRow>> {
  const result = await readInbox({
    cwd: repo,
    days: 30,
    env,
    now: NOW,
    repo: null,
  });
  if (result.kind !== 'read') throw new Error(result.reason);
  const rows: Record<string, InboxRow> = {};
  for (const id of [A, B, C]) {
    const row = result.read.rows.find((entry) => entry.sessionId === id);
    if (row?.loaded == null) throw new Error(`session ${id} did not load`);
    rows[id] = row;
  }
  return rows;
}

function rowOf(rows: Record<string, InboxRow>, id: string): InboxRow {
  const row = rows[id];
  if (row == null) throw new Error(`no row for ${id}`);
  return row;
}

/** What the inbox says about one session, and the git facts it said it from. */
function verdict(row: InboxRow) {
  return {
    checkoutDirty: row.loaded?.model.git.checkoutDirty,
    rule: row.card.action.rule,
    section: row.section,
    status: row.loaded?.status.kind,
    uncommitted: row.loaded?.model.git.uncommitted,
  };
}

beforeAll(async () => {
  needBr();
  sb = createSandbox();
  const xdg = join(sb.path, 'xdg');
  writeFile(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  repo = initRepo(sb, 'shared', {'README.md': '# shared\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);

  // A writes F at 09:10, commits it at 09:20, and closes its request.
  trackedSession(
    A,
    'Roll out the handoff rule',
    {end: t('09:30'), start: t('09:00')},
    [writeRecord(A, 'Write', join(repo, 'F.ts'), t('09:10'))],
  );
  write(repo, 'F.ts', 'a\n');
  commitAt(['F.ts'], t('09:20'), 'feat: F');
  await requestFor(A, 'Roll out the handoff rule', true);

  // B, the other finished session in the same checkout, does the same with H.
  trackedSession(
    B,
    'Add the reclaim plans',
    {end: t('09:35'), start: t('09:05')},
    [writeRecord(B, 'Write', join(repo, 'H.ts'), t('09:12'))],
  );
  write(repo, 'H.ts', 'b\n');
  commitAt(['H.ts'], t('09:25'), 'feat: H');
  await requestFor(B, 'Add the reclaim plans', true);

  // C, the third session, has an open request and has written nothing yet.
  trackedSession(
    C,
    'Back up the shortcuts',
    {end: t('10:00'), start: t('09:50')},
    [],
  );
  await requestFor(C, 'Back up the shortcuts', false);
  // Real br and three session beads: give the hook room, as the inbox test does.
}, 120_000);

afterAll(() => {
  sb.cleanup();
});

describe('a finished session in a checkout other sessions dirty (home-base-7nn2f)', () => {
  test('read 1, clean checkout: A and B are Done, on the default branch', async () => {
    const rows = await readRows();
    for (const id of [A, B]) {
      expect(verdict(rowOf(rows, id))).toEqual({
        checkoutDirty: measured([]),
        rule: 9,
        section: 'done',
        status: 'done',
        uncommitted: measured([]),
      });
      expect(rowOf(rows, id).loaded?.model.git.merged).toEqual(
        measured('isDefault'),
      );
    }
  });

  test("read 2, C's uncommitted G: A and B stay Done, and G is C's", async () => {
    write(repo, 'G.ts', 'c\n');
    appendRecords(C, [writeRecord(C, 'Write', join(repo, 'G.ts'), t('10:10'))]);
    const rows = await readRows();
    for (const id of [A, B]) {
      expect(verdict(rowOf(rows, id))).toEqual({
        checkoutDirty: measured(['G.ts']),
        rule: 9,
        section: 'done',
        status: 'done',
        uncommitted: measured([]),
      });
    }
    // The dirt is seen, and it is attributed: the test cannot pass by missing it.
    expect(rowOf(rows, C).loaded?.model.git.uncommitted).toEqual(
      measured(['G.ts']),
    );
  });

  test('read 2, C also edits F, which A wrote and committed earlier: A and B stay Done', async () => {
    write(repo, 'F.ts', 'a, edited by C\n');
    appendRecords(C, [writeRecord(C, 'Edit', join(repo, 'F.ts'), t('10:20'))]);
    const rows = await readRows();
    for (const id of [A, B]) {
      expect(verdict(rowOf(rows, id))).toEqual({
        checkoutDirty: measured(['F.ts', 'G.ts']),
        rule: 9,
        section: 'done',
        status: 'done',
        uncommitted: measured([]),
      });
    }
    expect(rowOf(rows, C).loaded?.model.git.uncommitted).toEqual(
      measured(['F.ts', 'G.ts']),
    );
  });

  test("read 3, C's dirt committed: A and B are still Done", async () => {
    commitAt(['F.ts', 'G.ts'], t('11:00'), 'feat: G, and F edited');
    const rows = await readRows();
    for (const id of [A, B]) {
      expect(verdict(rowOf(rows, id))).toEqual({
        checkoutDirty: measured([]),
        rule: 9,
        section: 'done',
        status: 'done',
        uncommitted: measured([]),
      });
    }
  });

  test("A's own write to F after F's last commit, with F dirty: A is To land, B stays Done", async () => {
    write(repo, 'F.ts', 'a, written by A again\n');
    appendRecords(A, [writeRecord(A, 'Write', join(repo, 'F.ts'), t('11:10'))]);
    const rows = await readRows();
    expect(verdict(rowOf(rows, A))).toEqual({
      checkoutDirty: measured(['F.ts']),
      rule: 6,
      section: 'toLand',
      status: 'doneUnmerged',
      uncommitted: measured(['F.ts']),
    });
    expect(verdict(rowOf(rows, B))).toEqual({
      checkoutDirty: measured(['F.ts']),
      rule: 9,
      section: 'done',
      status: 'done',
      uncommitted: measured([]),
    });
  });
});
