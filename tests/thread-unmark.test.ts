/**
 * `thread unmark` and the undo record `thread done` / `thread archive` write
 * (home-base-yukaf.9, epic home-base-yukaf D-GMAIL-KEYS).
 *
 * THE FAKE br. Every br call the code under test makes goes through a SPY: a
 * tiny `br` script first on the world's PATH that appends `<verb> <id>
 * <record|no-record>` to a log — whether marks-undo.jsonl existed at the
 * moment of that call — can be told to fail one `<verb> <id>`, and otherwise
 * execs the pinned real br. So the order is proven (no write before the
 * record) while the reopen and status semantics are br's own, not a fake's.
 *
 * NEGATIVE CONTROLS (run once, 2026-10-18, recorded in home-base-yukaf.9's
 * notes): with the archived label added BEFORE the record (the order the code
 * had before this bead), "the undo record is written before any br write"
 * failed with `update <session bead> no-record`; with the status restore
 * skipped, "unmark reopens every closed bead with its prior status" failed on
 * the session bead's status (open, expected in_progress).
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join} from 'path';

import {brCreate, brUpdate, runBr} from '../src/beads/br';
import {marksUndoPath, readMarksUndo, undoIdOf} from '../src/thread/marks-undo';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  closeSession,
  describeCloseOutcome,
  describeUnmarkOutcome,
  runThreadUnmark,
  unmarkSession,
} from '../src/thread/session-marks';
import {initRepo} from './git-fixtures';
import {needBr, PINNED_BR} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** The spy: logs each call, fails the one named by SPY_BR_FAIL, else runs the real br. */
const SPY_BR = `#!/bin/sh
verb=""; id=""; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    --db) skip=1 ;;
    -*) ;;
    *) if [ -z "$verb" ]; then verb="$a"; elif [ -z "$id" ]; then id="$a"; fi ;;
  esac
done
if [ -n "$SPY_BR_LOG" ]; then
  if [ -f "$SPY_UNDO_FILE" ]; then rec=record; else rec=no-record; fi
  printf '%s %s %s\\n' "$verb" "$id" "$rec" >> "$SPY_BR_LOG"
fi
if [ -n "$SPY_BR_FAIL" ] && [ "$verb $id" = "$SPY_BR_FAIL" ]; then
  echo "spy br: told to fail $verb $id" >&2
  exit 1
fi
exec "$SPY_REAL_BR" "$@"
`;

interface World {
  env: Record<string, string | undefined>;
  log: string;
  repo: string;
  sb: Sandbox;
  stateDir: string;
}

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  // The pinned binary itself (pinned-br.ts), never a mise shim: a shim run
  // from a $TMPDIR cwd resolves mise's global br instead.
  const real =
    PINNED_BR.kind === 'pinned'
      ? PINNED_BR.path
      : Bun.which('br', {PATH: process.env.PATH ?? ''});
  if (real == null) throw new Error('br is not on PATH');
  const spyDir = join(sb.path, 'spy-bin');
  mkdirSync(spyDir, {recursive: true});
  writeFileSync(join(spyDir, 'br'), SPY_BR);
  chmodSync(join(spyDir, 'br'), 0o755);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const stateDir = join(sb.path, 'state');
  const log = join(sb.path, 'br-calls.log');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    PATH: `${spyDir}${delimiter}${process.env.PATH ?? ''}`,
    SPY_BR_FAIL: undefined,
    SPY_BR_LOG: undefined,
    SPY_REAL_BR: real,
    XDG_CONFIG_HOME: xdg,
  };
  env.SPY_UNDO_FILE = marksUndoPath(env);
  const repo = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  return {env, log, repo, sb, stateDir};
}

function show(w: World, id: string): {labels: string[]; status: string} {
  const out = runBr(w.repo, ['show', id, '--json']);
  if (!out.ok) throw new Error(`br show failed: ${out.reason ?? '?'}`);
  const [record] = JSON.parse(out.stdout) as {
    labels?: string[];
    status: string;
  }[];
  if (record == null) throw new Error('no record');
  return {labels: [...(record.labels ?? [])].sort(), status: record.status};
}

function quiet(): void {
  for (const method of ['log', 'error'] as const) {
    spies.push(spyOn(console, method).mockImplementation(() => undefined));
  }
}

/**
 * A session bead (in_progress), two requests it filed (one in_progress, one
 * open), and one request adopted from an epic (in_progress).
 */
async function seeded(w: World) {
  const bead = ensureSessionBead({
    cwd: w.repo,
    env: w.env,
    firstPrompt: {at: '2026-10-18T09:00:00.000Z', text: 'Build the thing'},
    now: new Date('2026-10-18T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (bead.kind !== 'created') throw new Error(JSON.stringify(bead));
  const request = async (extra: {bead?: string; title?: string}) => {
    const filed = await fileRequest({
      bead: extra.bead ?? null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      sessionId: null,
      title: extra.title ?? null,
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    return filed.id;
  };
  const working = await request({title: 'Write the file'});
  const waiting = await request({title: 'Render it'});
  expect(brUpdate({cwd: w.repo}, working, {status: 'in_progress'}).kind).toBe(
    'ok',
  );
  expect(brUpdate({cwd: w.repo}, waiting, {status: 'open'}).kind).toBe('ok');
  const epic = brCreate({cwd: w.repo}, {title: 'Epic', type: 'epic'});
  if (epic.kind !== 'ok') throw new Error(epic.reason);
  const child = brCreate(
    {cwd: w.repo},
    {parent: epic.id, title: 'Existing bug', type: 'bug'},
  );
  if (child.kind !== 'ok') throw new Error(child.reason);
  const adopted = await request({bead: child.id});
  const session = show(w, bead.beadId);
  expect(session.status).toBe('in_progress');
  return {adopted, sessionBeadId: bead.beadId, waiting, working};
}

function calls(w: World): string[] {
  if (!existsSync(w.log)) return [];
  return readFileSync(w.log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

const WRITE_VERBS = new Set(['close', 'reopen', 'update']);

async function archive(w: World) {
  return await closeSession('archive', {
    cwd: w.repo,
    env: w.env,
    reason: 'not needed',
    selector: null,
    sessionId: SESSION,
  });
}

describe('the undo record (thread done / thread archive)', () => {
  test('the undo record is written before any br write, and names exactly what the mark changes', async () => {
    const w = world();
    quiet();
    const ids = await seeded(w);
    w.env.SPY_BR_LOG = w.log;
    const outcome = await archive(w);
    expect(outcome.kind).toBe('closed');

    const writes = calls(w).filter((line) =>
      WRITE_VERBS.has(line.split(' ')[0] ?? ''),
    );
    expect(writes.length).toBeGreaterThan(0);
    // Every write, the first one included, saw the record already on disk.
    expect(writes.filter((line) => !line.endsWith(' record'))).toEqual([]);
    expect(writes.some((line) => line.startsWith('close '))).toBe(true);

    const read = readMarksUndo(w.env);
    if (read.kind !== 'read') throw new Error(read.reason);
    expect(read.records).toHaveLength(1);
    const [record] = read.records;
    expect(record).toMatchObject({
      labelsAdded: ['archived'],
      mode: 'archive',
      released: [{id: ids.adopted}],
      sessionBeadId: ids.sessionBeadId,
      sessionId: SESSION,
      undoneAt: null,
    });
    // The session bead is closed LAST, so it is last in the record.
    expect(
      record?.closed.map((bead) => [bead.id, bead.priorStatus]).sort(),
    ).toEqual(
      [
        [ids.sessionBeadId, 'in_progress'],
        [ids.waiting, 'open'],
        [ids.working, 'in_progress'],
      ].sort(),
    );
    expect(record?.closed.at(-1)?.id).toBe(ids.sessionBeadId);
  });

  test('a record that cannot be written refuses the mark: nothing is closed or labelled', async () => {
    const w = world();
    quiet();
    const ids = await seeded(w);
    // A directory where the file goes: the append fails with EISDIR.
    mkdirSync(marksUndoPath(w.env), {recursive: true});
    w.env.SPY_BR_LOG = w.log;
    const outcome = await archive(w);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('the undo record could not be written');
    expect(
      calls(w).filter((line) => WRITE_VERBS.has(line.split(' ')[0] ?? '')),
    ).toEqual([]);
    expect(show(w, ids.sessionBeadId)).toMatchObject({status: 'in_progress'});
    expect(show(w, ids.sessionBeadId).labels).not.toContain('archived');
  });
});

describe('thread unmark', () => {
  test('unmark reopens every closed bead with its prior status, removes the label, and gives the released request its labels back', async () => {
    const w = world();
    quiet();
    const ids = await seeded(w);
    expect((await archive(w)).kind).toBe('closed');
    expect(show(w, ids.working).status).toBe('closed');
    expect(show(w, ids.adopted).labels).toEqual([]);

    const outcome = await unmarkSession({env: w.env, session: SESSION});
    expect(describeUnmarkOutcome(outcome).exitCode).toBe(0);
    expect(show(w, ids.sessionBeadId)).toMatchObject({status: 'in_progress'});
    expect(show(w, ids.sessionBeadId).labels).not.toContain('archived');
    expect(show(w, ids.working).status).toBe('in_progress');
    expect(show(w, ids.waiting).status).toBe('open');
    expect(show(w, ids.adopted)).toEqual({
      labels: ['request', `sid:${SESSION}`],
      status: 'in_progress',
    });

    const read = readMarksUndo(w.env);
    if (read.kind !== 'read') throw new Error(read.reason);
    expect(read.records[0]?.undoneAt).not.toBeNull();
    // Undone once: there is nothing left to undo for this session.
    expect(await runThreadUnmark({env: w.env, session: SESSION})).toBe(2);
  });

  test('the session bead id selects the mark too, and unmark with no session takes the newest', async () => {
    const w = world();
    quiet();
    const ids = await seeded(w);
    expect(
      (
        await closeSession('done', {
          cwd: w.repo,
          env: w.env,
          reason: null,
          selector: null,
          sessionId: SESSION,
        })
      ).kind,
    ).toBe('closed');
    expect(await runThreadUnmark({env: w.env, session: 'someone-else'})).toBe(
      2,
    );
    expect(await runThreadUnmark({env: w.env, session: null})).toBe(0);
    expect(show(w, ids.sessionBeadId).status).toBe('in_progress');
  });

  test('nothing to undo exits 2 and says so', async () => {
    const w = world();
    const errors: string[] = [];
    spies.push(
      spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.join(' '));
      }),
    );
    expect(await runThreadUnmark({env: w.env, session: null})).toBe(2);
    expect(errors.join('\n')).toContain('nothing to undo');
  });

  test('a failing br names the id, exits 1, and leaves the record so a second run finishes', async () => {
    const w = world();
    quiet();
    const ids = await seeded(w);
    expect((await archive(w)).kind).toBe('closed');

    w.env.SPY_BR_FAIL = `reopen ${ids.working}`;
    const failed = await unmarkSession({env: w.env, session: SESSION});
    const described = describeUnmarkOutcome(failed);
    expect(described.exitCode).toBe(1);
    expect(described.lines.join('\n')).toContain(
      `${ids.working} was NOT reopened`,
    );
    const kept = readMarksUndo(w.env);
    if (kept.kind !== 'read') throw new Error(kept.reason);
    expect(kept.records[0]?.undoneAt).toBeNull();
    expect(show(w, ids.working).status).toBe('closed');
    // What could be put back was.
    expect(show(w, ids.sessionBeadId).status).toBe('in_progress');

    w.env.SPY_BR_FAIL = undefined;
    const retried = await unmarkSession({env: w.env, session: SESSION});
    expect(describeUnmarkOutcome(retried).exitCode).toBe(0);
    expect(show(w, ids.working).status).toBe('in_progress');
    expect(show(w, ids.waiting).status).toBe('open');
  });

  describe('the undo id (home-base-yukaf.14 F11)', () => {
    test('a mark prints the id of the record it wrote, and --mark reverses exactly that record', async () => {
      const w = world();
      quiet();
      const ids = await seeded(w);
      const outcome = await archive(w);
      if (outcome.kind !== 'closed') throw new Error(outcome.kind);
      const read = readMarksUndo(w.env);
      if (read.kind !== 'read') throw new Error(read.reason);
      expect(outcome.undoId).toBe(read.records[0]?.id ?? 'missing');
      const printed = describeCloseOutcome('thread archive', outcome);
      expect(printed.exitCode).toBe(0);
      expect(undoIdOf(printed.lines.join('\n'))).toBe(outcome.undoId);

      expect(
        await runThreadUnmark({
          env: w.env,
          mark: '00000000-0000-4000-8000-000000000000',
          session: null,
        }),
      ).toBe(2);
      expect(show(w, ids.sessionBeadId).status).toBe('closed');
      expect(
        await runThreadUnmark({
          env: w.env,
          mark: outcome.undoId,
          session: null,
        }),
      ).toBe(0);
      expect(show(w, ids.sessionBeadId).status).toBe('in_progress');
      // Undone once: the same id is now nothing to undo.
      expect(
        await runThreadUnmark({
          env: w.env,
          mark: outcome.undoId,
          session: null,
        }),
      ).toBe(2);
    });

    test('a mark that changes nothing writes no record and prints no undo id, so the TUI has nothing to push', async () => {
      const w = world();
      quiet();
      await seeded(w);
      expect((await archive(w)).kind).toBe('closed');
      const again = await archive(w);
      if (again.kind !== 'closed') throw new Error(again.kind);
      expect(again.alreadyClosed).toBe(true);
      expect(again.undoId).toBeNull();
      const printed = describeCloseOutcome('thread archive', again);
      expect(printed.exitCode).toBe(0);
      expect(undoIdOf(printed.lines.join('\n'))).toBeNull();
      const read = readMarksUndo(w.env);
      if (read.kind !== 'read') throw new Error(read.reason);
      expect(read.records).toHaveLength(1);
    });

    test('a partial failure (exit 1) still prints the id of the record it wrote', async () => {
      const w = world();
      quiet();
      const ids = await seeded(w);
      w.env.SPY_BR_FAIL = `close ${ids.working}`;
      const outcome = await archive(w);
      if (outcome.kind !== 'closed') throw new Error(outcome.kind);
      const printed = describeCloseOutcome('thread archive', outcome);
      expect(printed.exitCode).toBe(1);
      const read = readMarksUndo(w.env);
      if (read.kind !== 'read') throw new Error(read.reason);
      expect(undoIdOf(printed.lines.join('\n'))).toBe(
        read.records[0]?.id ?? 'missing',
      );
    });
  });

  test('an unreadable undo file is a failure (exit 1), never "nothing to undo"', async () => {
    const w = world();
    quiet();
    mkdirSync(w.stateDir, {recursive: true});
    writeFileSync(marksUndoPath(w.env), 'not json\n');
    const outcome = await unmarkSession({env: w.env, session: null});
    expect(outcome.kind).toBe('failed');
    expect(describeUnmarkOutcome(outcome).exitCode).toBe(1);
  });
});
