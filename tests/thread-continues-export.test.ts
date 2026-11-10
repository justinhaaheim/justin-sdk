/**
 * Does every write of a `continues:` or `continued-by:` label leave the beads
 * export (`.beads/issues.jsonl`) current when it returns? (home-base-9ihcl.4.1,
 * item 1.) `thread focus` asks br 0.1.37 `br list --all -l continues:<head>`,
 * which takes about 14 s on home-base's database; reading the export instead
 * is safe only if the export can never lag a link write.
 *
 * linkContinuation (session-handoff.ts) is the one function that writes these
 * labels (its own comment, home-base-6n7my.2 D4): `thread handoff --to`, the
 * auto pickup and `thread request --continues` all reach it. It writes through
 * brUpdate, which passes `--no-auto-import` and never `--no-auto-flush`, after
 * a `br sync --status` freshness check (exportAheadOfDb). The handoff-number
 * self-heal (healHandoffNumber) writes only `handoff-number:` labels.
 *
 * ANSWER (2026-11-10, br 0.1.37): no, not always. Every state the freshness
 * check can see is safe: the link reaches the export, or nothing is written.
 * But conflict markers that land in the export AFTER the check and BEFORE the
 * write (a git checkout -m or apply --3way on the export, as on 2026-11-06)
 * leave `continues:<old>` in the database and not in the export, and the
 * export stays behind until the markers are resolved and another write
 * flushes. The last test below builds exactly that with a br shim.
 *
 * Real br (the pinned 0.1.37) in $TMPDIR repos. Each case reads the export
 * file from disk right after the write returns, and the database through br.
 *
 * ITEM 2 (the second describe): so `thread focus` reads the export only when
 * br confirms it is the database's state (continuing-read.ts): sha256 of the
 * bytes equal to `jsonl_content_hash`, `dirty_count` 0, neither side newer,
 * the status read AFTER the bytes. Every other state, the race above among
 * them, falls back to br list, and the answer is br list's: the same beads in
 * the same order.
 */

import type {BrSyncStatus, BrSyncStatusOutcome} from '../src/beads/br';
import type {ExportCheckDeps} from '../src/thread/continuing-read';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';

import {
  brCreate,
  brExportLag,
  brList,
  brShow,
  brSyncStatus,
  findBeadsWorkspace,
  runBr,
} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {
  checkExport,
  continuingInDb,
  continuingInExport,
  exportPathOf,
  realExportCheckDeps,
} from '../src/thread/continuing-read';
import {realFocusReaders} from '../src/thread/focus';
import {startTimings} from '../src/thread/inbox-timings';
import {serializeMessageLine} from '../src/thread/message-log';
import {ensureSessionBead} from '../src/thread/session-bead';
import {linkContinuation} from '../src/thread/session-handoff';
import {initRepo} from './git-fixtures';
import {needBr, PINNED_BR} from './pinned-br';
import {createSandbox} from './sandbox';

setDefaultTimeout(120_000);

const OLD = '0a000000-1111-4222-8333-0000000000e1';
const NEW = '0b000000-1111-4222-8333-0000000000e2';

interface World {
  beads: Record<string, string>;
  db: string;
  env: Record<string, string | undefined>;
  exportPath: string;
  repo: string;
  root: string;
}

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'link-repo', {'README.md': '# l\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const space = findBeadsWorkspace(repo);
  if (space.kind !== 'found') throw new Error('no beads workspace');
  const beads: Record<string, string> = {};
  for (const session of [OLD, NEW]) {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: session,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    beads[session] = filed.beadId;
    const log = messageLogPath(session, env);
    mkdirSync(dirname(log), {recursive: true});
    writeFileSync(
      log,
      serializeMessageLine({
        at: '2030-01-01T09:00:00.000Z',
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        text: 'migrate the db',
      }),
    );
  }
  return {
    beads,
    db: space.db,
    env,
    exportPath: join(space.beadsDir, 'issues.jsonl'),
    repo,
    root: sb.path,
  };
}

function beadOf(w: World, session: string): string {
  const id = w.beads[session];
  if (id == null) throw new Error(`no bead for ${session}`);
  return id;
}

/** The labels of `id` as the export file on disk holds them right now. */
function exportLabels(w: World, id: string): string[] {
  const needle = `"id":${JSON.stringify(id)}`;
  const line = readFileSync(w.exportPath, 'utf8')
    .split('\n')
    .find((raw) => raw.includes(needle) && raw.startsWith('{'));
  if (line == null) throw new Error(`${id} is not in the export`);
  const record = JSON.parse(line) as {labels?: string[]};
  return record.labels ?? [];
}

/** The labels of `id` in the database, through br. */
function dbLabels(w: World, id: string): string[] {
  const shown = brShow({db: w.db, env: w.env}, id);
  if (shown.kind !== 'ok') throw new Error(`could not read ${id}`);
  return shown.issue.labels;
}

function dirtyCount(w: World): number {
  const lag = brExportLag({db: w.db, env: w.env});
  if (!lag.ok) throw new Error(lag.failed.reason);
  return lag.lag.dirtyCount;
}

function link(
  w: World,
  env: Record<string, string | undefined> = w.env,
): ReturnType<typeof linkContinuation> {
  return linkContinuation({
    cwd: w.repo,
    env,
    newSession: {beadId: beadOf(w, NEW), db: w.db},
    oldBeadId: beadOf(w, OLD),
  });
}

/**
 * The export's text with git's conflict markers around an unrelated bead's
 * line, as `git checkout -m` wrote them on 2026-11-06 (home-base-jm5kg.11.3).
 */
function markedExport(w: World): string {
  const other = brCreate(
    {db: w.db, env: w.env},
    {title: 'unrelated', type: 'task'},
  );
  if (other.kind !== 'ok') throw new Error('br create failed');
  const lines = readFileSync(w.exportPath, 'utf8').split('\n');
  const at = lines.findIndex((raw) => raw.includes(`"id":"${other.id}"`));
  const line = lines[at];
  if (line == null) throw new Error('unrelated bead not exported');
  lines.splice(
    at,
    1,
    '<<<<<<< ours',
    line,
    '||||||| base',
    line,
    '=======',
    line.replace('"title":"unrelated"', '"title":"unrelated, theirs"'),
    '>>>>>>> theirs',
  );
  return lines.join('\n');
}

/**
 * An env whose PATH runs `br` through a shim: `body` (sh lines that see the
 * arguments as "$@") first, then the real pinned br.
 */
function shimmedBr(w: World, name: string, body: string[]): World['env'] {
  const shimDir = join(w.root, `shim-${name}`);
  mkdirSync(shimDir, {recursive: true});
  const realBr =
    'dir' in PINNED_BR ? join(PINNED_BR.dir, 'br') : (Bun.which('br') ?? '');
  writeFileSync(
    join(shimDir, 'br'),
    ['#!/bin/sh', ...body, `exec '${realBr}' "$@"`, ''].join('\n'),
  );
  chmodSync(join(shimDir, 'br'), 0o755);
  return {
    ...w.env,
    PATH: [shimDir, process.env.PATH ?? ''].join(delimiter),
  };
}

/**
 * Item 1's race: a br shim that, on the first `update`, puts a marked export
 * in place and then runs the real br. That is a git checkout -m landing on
 * the export between exportAheadOfDb's `br sync --status` and `br update`.
 */
function markersOnFirstUpdate(w: World): World['env'] {
  const marked = join(w.root, 'marked.jsonl');
  writeFileSync(marked, markedExport(w));
  const once = join(w.root, 'inject-once');
  writeFileSync(once, '');
  return shimmedBr(w, 'markers', [
    `case " $* " in *" update "*) if [ -f '${once}' ]; then rm '${once}'; cp '${marked}' '${w.exportPath}'; fi;; esac`,
  ]);
}

describe('item 1: a link write and the export', () => {
  test('linkContinuation leaves both labels in the export when it returns', () => {
    const w = world();
    const linked = link(w);
    expect(linked.kind).toBe('linked');
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(exportLabels(w, newId)).toContain(`continues:${oldId}`);
    expect(exportLabels(w, oldId)).toContain(`continued-by:${newId}`);
    expect(dirtyCount(w)).toBe(0);
  });

  test('control: a write with --no-auto-flush is in the database and not in the export', () => {
    // Proves exportLabels reads the file as it is, not the database: the same
    // label, written the way the export cannot see, is missing from it.
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    const written = runBr(w.repo, [
      'update',
      newId,
      `--add-label=continues:${oldId}`,
      '--no-auto-flush',
    ]);
    expect(written.ok).toBe(true);
    expect(dbLabels(w, newId)).toContain(`continues:${oldId}`);
    expect(exportLabels(w, newId)).not.toContain(`continues:${oldId}`);
    expect(dirtyCount(w)).toBeGreaterThan(0);
  });

  test('an export ahead of the database is imported first, and the link still reaches the export', () => {
    const w = world();
    // A pulled edit: another bead's title changed in the export only.
    const other = brCreate(
      {db: w.db, env: w.env},
      {title: 'unrelated', type: 'task'},
    );
    if (other.kind !== 'ok') throw new Error('br create failed');
    const text = readFileSync(w.exportPath, 'utf8');
    writeFileSync(
      w.exportPath,
      text.replace('"title":"unrelated"', '"title":"unrelated, pulled"'),
    );
    const linked = link(w);
    expect(linked.kind).toBe('linked');
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(exportLabels(w, newId)).toContain(`continues:${oldId}`);
    expect(exportLabels(w, oldId)).toContain(`continued-by:${newId}`);
  });

  test('conflict markers already in the export: the link is refused and nothing is written, so nothing lags', () => {
    const w = world();
    writeFileSync(w.exportPath, markedExport(w));
    const linked = link(w);
    expect(linked.kind).toBe('failed');
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(dbLabels(w, newId)).not.toContain(`continues:${oldId}`);
    expect(dbLabels(w, oldId)).not.toContain(`continued-by:${newId}`);
  });

  test('FAILS ITEM 1: markers that land between the freshness check and the write leave continues: in the database and not in the export', () => {
    const w = world();
    const env = markersOnFirstUpdate(w);

    const linked = link(w, env);
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    // The first write passed its check and landed in the database only; the
    // second write's check then saw the markers and refused.
    expect(linked.kind).toBe('failed');
    expect(dbLabels(w, newId)).toContain(`continues:${oldId}`);
    expect(dbLabels(w, oldId)).not.toContain(`continued-by:${newId}`);
    // So `br list -l continues:<old>` finds the successor, and the export
    // does not: a reader of the export would say "nothing continues it".
    const listed = runBr(w.repo, [
      'list',
      '--json',
      '--limit',
      '0',
      '--all',
      '-l',
      `continues:${oldId}`,
    ]);
    expect(listed.ok).toBe(true);
    expect(listed.stdout).toContain(newId);
    expect(exportLabels(w, newId)).not.toContain(`continues:${oldId}`);
    expect(dirtyCount(w)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Item 2: the checked export read
// ---------------------------------------------------------------------------

/** The reverse-link check of one database, as `thread focus` runs it. */
function reverse(
  w: World,
  headBeadId: string,
  options: {deps?: ExportCheckDeps; env?: World['env']} = {},
): {fallback: null | string; ids: string[]} {
  const read = continuingInDb({
    db: w.db,
    deps: options.deps,
    env: options.env ?? w.env,
    headBeadId,
  });
  if (read.kind === 'failed') throw new Error(read.reason);
  return {
    fallback: read.source.kind === 'brList' ? read.source.fallback : null,
    ids: read.ids,
  };
}

/** What the export file alone says, unchecked: what the check guards against. */
function exportAlone(w: World, headBeadId: string): string[] {
  const found = continuingInExport({
    db: w.db,
    headBeadId,
    path: w.exportPath,
    text: readFileSync(w.exportPath, 'utf8'),
  });
  if (!found.ok) throw new Error(found.reason);
  return found.ids;
}

function brListIds(w: World, headBeadId: string): string[] {
  const listed = brList(
    {db: w.db, env: w.env},
    {all: true, labels: [`continues:${headBeadId}`]},
  );
  if (listed.kind === 'failed') throw new Error(listed.reason);
  return listed.issues.map((issue) => issue.id);
}

function brOk(w: World, args: string[]): void {
  const ran = runBr(w.repo, args);
  if (!ran.ok) throw new Error(`br ${args.join(' ')}: ${ran.reason ?? '?'}`);
}

describe('item 2: the reverse-link check reads the export only when br confirms it', () => {
  test('a current export is used: no successor, then the linked one, as br list says', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(exportPathOf(w.db)).toBe(w.exportPath);
    expect(reverse(w, oldId)).toEqual({fallback: null, ids: []});
    expect(link(w).kind).toBe('linked');
    expect(reverse(w, oldId)).toEqual({fallback: null, ids: [newId]});
    expect(brListIds(w, oldId)).toEqual([newId]);
  });

  test('the same beads in the same order as br list: priorities, creation order, closed, deferred, in progress, deleted', () => {
    const w = world();
    const head = 't-head';
    const make = (title: string, priority: number): string => {
      const created = brCreate(
        {db: w.db, env: w.env},
        {labels: [`continues:${head}`], priority, title, type: 'task'},
      );
      if (created.kind !== 'ok') throw new Error(created.reason);
      return created.id;
    };
    const a = make('a', 2);
    const b = make('b', 0);
    const c = make('c', 3);
    const d = make('d', 2);
    const e = make('e', 1);
    const f = make('f', 2);
    const g = make('g', 4);
    const gone = make('gone', 1);
    brOk(w, ['update', d, '--status', 'deferred']);
    brOk(w, ['update', c, '--status', 'in_progress']);
    brOk(w, ['close', f, '--reason', 'done']);
    brOk(w, ['delete', gone, '--force']);

    const listed = brListIds(w, head);
    // br 0.1.37's order, as measured: priority, then the newest created first;
    // the deleted bead is left out, the closed and deferred ones are not.
    expect(listed).toEqual([b, e, f, d, a, c, g]);
    // br 0.1.37's `delete` leaves its change unexported (measured here), so
    // the check falls back until a write flushes; then the export answers.
    expect(reverse(w, head)).toEqual({
      fallback: 'dirty_count 1, db_newer',
      ids: listed,
    });
    brOk(w, ['sync', '--flush-only']);
    expect(reverse(w, head)).toEqual({fallback: null, ids: listed});
    // And the fallback (status refused) gives br list's own answer.
    const real = realExportCheckDeps(w.env);
    const refused: BrSyncStatusOutcome = {
      failed: {command: 'br sync', detail: [], kind: 'failed', reason: 'no'},
      ok: false,
    };
    const viaList = reverse(w, head, {
      deps: {readBytes: real.readBytes, syncStatus: () => refused},
    });
    expect(viaList.ids).toEqual(listed);
    expect(viaList.fallback).toBe('br sync --status failed: no');
  });

  test('dirty_count > 0 (a write that did not flush): br list, which finds the successor', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    brOk(w, [
      'update',
      newId,
      `--add-label=continues:${oldId}`,
      '--no-auto-flush',
    ]);
    const read = reverse(w, oldId);
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toContain('dirty_count 1');
    // The file is the one br stored a hash of; only the counts tell.
    expect(read.fallback).not.toContain('sha256');
    expect(exportAlone(w, oldId)).toEqual([]);
  });

  test('an export put back to its bytes before the link (a git checkout): br list, which finds the successor', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    const before = readFileSync(w.exportPath);
    expect(link(w).kind).toBe('linked');
    writeFileSync(w.exportPath, before);
    const read = reverse(w, oldId);
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toMatch(/sha256 .* br stored/);
    expect(read.fallback).toContain('jsonl_newer');
    expect(exportAlone(w, oldId)).toEqual([]);
  });

  test('a missing export: br list', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(link(w).kind).toBe('linked');
    renameSync(w.exportPath, `${w.exportPath}.away`);
    const read = reverse(w, oldId);
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toMatch(/^the export could not be read: .*ENOENT/);
  });

  test('a failed br sync --status: br list', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(link(w).kind).toBe('linked');
    const env = shimmedBr(w, 'no-sync', [
      `case " $* " in *" sync "*) echo 'shim: sync refused' >&2; exit 1;; esac`,
    ]);
    const read = reverse(w, oldId, {env});
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toMatch(
      /^br sync --status failed: .*shim: sync refused/s,
    );
  });

  test('an export that does not parse where the label is: br list', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(link(w).kind).toBe('linked');
    // Bytes br vouches for (its status reports their hash) but with the
    // successor's line broken: the check passes, the lookup cannot answer.
    const broken = Buffer.from(
      readFileSync(w.exportPath, 'utf8')
        .split('\n')
        .map((raw) =>
          raw.includes(`"id":"${newId}"`)
            ? `{"id":"${newId}","labels":["continues:${oldId}"]`
            : raw,
        )
        .join('\n'),
    );
    const sha = createHash('sha256').update(broken).digest('hex');
    const read = reverse(w, oldId, {
      deps: {
        readBytes: () => broken,
        syncStatus: () => ({
          ok: true,
          status: {
            dbNewer: false,
            dirtyCount: 0,
            jsonlContentHash: sha,
            jsonlNewer: false,
          },
        }),
      },
    });
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toMatch(/^the export did not parse: line \d+ of /);
  });

  test("item 1's race (markers between a link's check and its write): br list, which finds the successor", () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(link(w, markersOnFirstUpdate(w)).kind).toBe('failed');
    const read = reverse(w, oldId);
    expect(read.ids).toEqual([newId]);
    expect(read.fallback).toMatch(/dirty_count [1-9]/);
    // A plain read of the export would have said "nothing continues it".
    expect(exportAlone(w, oldId)).toEqual([]);
  });

  test('a write that flushes between the read and the status: only the hash tells, and it falls back', () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    const real = realExportCheckDeps(w.env);
    let wrote = false;
    const read = reverse(w, oldId, {
      deps: {
        readBytes: real.readBytes,
        syncStatus: (db) => {
          // The bytes were read before this; br now writes and flushes.
          brOk(w, ['update', newId, `--add-label=continues:${oldId}`]);
          wrote = true;
          return real.syncStatus(db);
        },
      },
    });
    expect(wrote).toBe(true);
    expect(read.ids).toEqual([newId]);
    // dirty_count 0 and neither side newer: the hash is the only guard here.
    expect(read.fallback).toMatch(
      /^the export's sha256 [0-9a-f]{12} is not the [0-9a-f]{12} br stored$/,
    );
  });

  test("thread focus's timings name where the answer came from, and why", () => {
    const w = world();
    const oldId = beadOf(w, OLD);
    const newId = beadOf(w, NEW);
    expect(link(w).kind).toBe('linked');
    const timings = startTimings();
    let names: string[];
    try {
      const readers = realFocusReaders({cwd: w.repo, env: w.env, timings});
      expect(readers.continuing(oldId, w.db)).toEqual({
        ids: [newId],
        kind: 'read',
      });
      brOk(w, ['update', oldId, '--add-label=x', '--no-auto-flush']);
      expect(readers.continuing(oldId, w.db)).toEqual({
        ids: [newId],
        kind: 'read',
      });
    } finally {
      names = timings.finish().phases.map((phase) => phase.name);
    }
    expect(names.slice(0, 3)).toEqual([
      `export check ${w.db}`,
      `reverse links from the export ${w.exportPath}`,
      `export check ${w.db}`,
    ]);
    expect(names).toHaveLength(4);
    expect(names[3]).toMatch(
      /^reverse links from br list, export not used \(.*dirty_count 1.*\) /,
    );
    expect(names[3]?.endsWith(` ${w.db}`)).toBe(true);
  });
});

describe('item 2: each condition alone decides (a stated br status)', () => {
  const DB = '/nowhere/.beads/beads.db';
  const bytes = Buffer.from('{"id":"t-1","title":"x"}\n');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const agrees: BrSyncStatus = {
    dbNewer: false,
    dirtyCount: 0,
    jsonlContentHash: sha,
    jsonlNewer: false,
  };

  function check(
    status: BrSyncStatusOutcome,
    readBytes: () => Buffer = () => bytes,
  ): {calls: string[]; result: ReturnType<typeof checkExport>} {
    const calls: string[] = [];
    const result = checkExport(DB, {
      readBytes: (path) => {
        calls.push(`read ${path}`);
        return readBytes();
      },
      syncStatus: (db) => {
        calls.push(`status ${db}`);
        return status;
      },
    });
    return {calls, result};
  }

  test('control: everything agrees, so the export is used, and its bytes are read before the status', () => {
    const {calls, result} = check({ok: true, status: agrees});
    expect(result).toEqual({
      kind: 'current',
      path: '/nowhere/.beads/issues.jsonl',
      text: bytes.toString('utf8'),
    });
    expect(calls).toEqual([
      'read /nowhere/.beads/issues.jsonl',
      `status ${DB}`,
    ]);
  });

  test.each([
    [
      'a hash br did not store',
      {jsonlContentHash: '0'.repeat(64)},
      `the export's sha256 ${sha.slice(0, 12)} is not the 000000000000 br stored`,
    ],
    [
      'no stored hash',
      {jsonlContentHash: null},
      'br stored no hash of the export',
    ],
    ['dirty_count 2', {dirtyCount: 2}, 'dirty_count 2'],
    ['jsonl_newer', {jsonlNewer: true}, 'jsonl_newer'],
    ['db_newer', {dbNewer: true}, 'db_newer'],
  ] as const)('%s alone: not used', (_name, change, reason) => {
    const {result} = check({ok: true, status: {...agrees, ...change}});
    expect(result).toEqual({
      kind: 'notCurrent',
      path: '/nowhere/.beads/issues.jsonl',
      reason,
    });
  });

  test('every failing condition is named', () => {
    const {result} = check({
      ok: true,
      status: {
        dbNewer: true,
        dirtyCount: 3,
        jsonlContentHash: '1'.repeat(64),
        jsonlNewer: true,
      },
    });
    expect(result.kind === 'notCurrent' ? result.reason : '').toBe(
      `the export's sha256 ${sha.slice(0, 12)} is not the 111111111111 br stored, dirty_count 3, jsonl_newer, db_newer`,
    );
  });

  test('a failed status call: not used', () => {
    const {result} = check({
      failed: {
        command: 'br sync --status --json',
        detail: ['database is locked'],
        kind: 'failed',
        reason: 'br exited 1',
      },
      ok: false,
    });
    expect(result).toEqual({
      kind: 'notCurrent',
      path: '/nowhere/.beads/issues.jsonl',
      reason: 'br sync --status failed: br exited 1\n  database is locked',
    });
  });

  test('an export that cannot be read: not used, and br is not asked', () => {
    const {calls, result} = check({ok: true, status: agrees}, () => {
      throw new Error('EACCES: permission denied');
    });
    expect(result).toEqual({
      kind: 'notCurrent',
      path: '/nowhere/.beads/issues.jsonl',
      reason: 'the export could not be read: EACCES: permission denied',
    });
    expect(calls).toEqual(['read /nowhere/.beads/issues.jsonl']);
  });
});

describe('brSyncStatus on the pinned br', () => {
  test('a fresh repo: the stored hash is the sha256 of the export file', () => {
    const w = world();
    const status = brSyncStatus({db: w.db, env: w.env});
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status.dirtyCount).toBe(0);
    expect(status.status.jsonlNewer).toBe(false);
    expect(status.status.dbNewer).toBe(false);
    expect(status.status.jsonlContentHash).toBe(
      createHash('sha256').update(readFileSync(w.exportPath)).digest('hex'),
    );
  });
});
