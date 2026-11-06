/**
 * A pickup that succeeded while the bead export lags the database
 * (home-base-jm5kg.11.2). Real br in $TMPDIR workspaces. On 2026-11-06 `thread
 * status` said "handoff pickup not done" and Unknown for three minutes after the
 * capture hook had picked up 9 requests, because the session bead was not in the
 * export. Each `it behaves` test has its control beside it: the same world with
 * the fact it depends on taken away.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {messageLogPath, sessionIndexPath} from '../src/thread/archive';
import {
  pickupState,
  writePickupFailure,
} from '../src/thread/handoff-auto-pickup';
import {runAutoPickup} from '../src/thread/handoff-auto-pickup-run';
import {serializeMessageLine} from '../src/thread/message-log';
import {describeRequestOutcome, fileRequest} from '../src/thread/request';
import {
  CMUX_SURFACE_LABEL_PREFIX,
  ensureSessionBead,
} from '../src/thread/session-bead';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {sessionContextLine} from '../src/thread/session-line';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {workspaceSyncRecord} from '../src/thread/workspace-name';
import {syncWorkspaceForCapture} from '../src/thread/workspace-name-session';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-000000000002';
const NEW = '0e400000-1111-4222-8333-000000000003';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const NOT_DONE = 'handoff pickup not done:';
const DONE_LINE = 'Handoff pickup: done.';
const UNCHECKED = 'Could not check the handoff pickup';
const NO_BR_ON_PATH = '/nonexistent-no-br-here';

setDefaultTimeout(90_000);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: Record<string, string>;
  env: Record<string, string | undefined>;
  repo: string;
}

function world(knobs: Record<string, unknown> = {}): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {
          enabled: true,
          handoff: {autoPickup: true},
          nameWorkspaces: false,
          sessionBeads: true,
          ...knobs,
        },
      },
    }),
  );
  const env: World['env'] = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(sb.path, 'no-threads-repo'),
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'behind-repo', {'README.md': '# p\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
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
  return {beads, env, repo};
}

function bead(w: World, session: string): string {
  const id = w.beads[session];
  if (id == null) throw new Error(`no bead for ${session}`);
  return id;
}

function exportPath(w: World): string {
  return join(w.repo, '.beads', 'issues.jsonl');
}

/** The export no longer holds this bead: what a lagging export looks like. */
function dropFromExport(w: World, id: string): void {
  const kept = readFileSync(exportPath(w), 'utf8')
    .split('\n')
    .filter((line) => !line.includes(`"id":${JSON.stringify(id)}`));
  writeFileSync(exportPath(w), kept.join('\n'));
}

/** A database write that br does not export, which is one unexported change. */
function labelInDbOnly(w: World, id: string, label: string): void {
  const out = runBr(w.repo, [
    'update',
    id,
    '--add-label',
    label,
    '--no-auto-flush',
  ]);
  if (!out.ok) throw new Error(`br update failed: ${out.reason ?? '?'}`);
}

/** The session is marked by its launch variable, as `thread handoff` types it. */
function ownEnv(w: World): World['env'] {
  return {
    ...w.env,
    CLAUDE_CODE_SESSION_ID: NEW,
    JUSTIN_SDK_CONTINUES: bead(w, OLD),
  };
}

async function status(w: World, env: World['env']): Promise<string> {
  const load = await loadSessionReport({
    asIfYielded: true,
    cwd: w.repo,
    env,
    now: NOW,
    selector: null,
    sessionId: NEW,
  });
  if (load.kind !== 'loaded') throw new Error(JSON.stringify(load));
  return renderThreadStatus(load, {
    now: NOW,
    style: {color: false, width: null},
    timeZone: 'UTC',
  });
}

describe('thread status when the export is behind the database', () => {
  test('AC 1: bead in the database, absent from the export, picked up: the pickup reads as done and the status names the lag', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'picked-up');
    dropFromExport(w, bead(w, NEW));

    const text = await status(w, ownEnv(w));

    expect(text).toContain(DONE_LINE);
    expect(text).toContain('⏳ Export behind');
    expect(text).toContain('1 change behind');
    expect(text).toContain('br rewrites it at the next bead write');
    expect(text).toContain('Nothing to mark.');
    expect(text).not.toContain(NOT_DONE);
    expect(text).not.toContain('❔ Unknown');
    expect(text).not.toContain('--continues');
    expect(text).not.toContain('no request filed');
    expect(text).not.toContain('No requests filed');
  });

  test('markers in the export are named, because no later write will clear them; AC 1 is the control', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'picked-up');
    dropFromExport(w, bead(w, NEW));
    const text = readFileSync(exportPath(w), 'utf8');
    writeFileSync(
      exportPath(w),
      `<<<<<<< ours\n=======\n>>>>>>> theirs\n${text}`,
    );

    const said = await status(w, ownEnv(w));

    expect(said).toContain(DONE_LINE);
    expect(said).toContain(
      'br will not rewrite it while it holds merge conflict markers',
    );
    expect(said).not.toContain('br rewrites it at the next bead write');
  });

  test('AC 1 control: the same world with no picked-up label says not done, and names the command', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'some-other-label');
    dropFromExport(w, bead(w, NEW));

    const text = await status(w, ownEnv(w));

    expect(text).toContain(NOT_DONE);
    expect(text).toContain(`thread request --continues ${bead(w, OLD)}`);
    expect(text).not.toContain(DONE_LINE);
    expect(text).toContain('⏳ Export behind');
  });

  test('a stale label on a bead the export DOES hold: the database settles it', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'picked-up');

    const text = await status(w, ownEnv(w));

    expect(text).toContain(DONE_LINE);
    expect(text).not.toContain(NOT_DONE);
    expect(text).not.toContain('⏳ Export behind');
  });

  test('a bead in neither place stays Unknown: the lag wording is not a blanket', async () => {
    const w = world();
    const id = bead(w, NEW);
    dropFromExport(w, id);
    const del = runBr(w.repo, ['delete', id, '--force', '--no-auto-flush']);
    if (!del.ok) throw new Error(`br delete failed: ${del.reason ?? '?'}`);

    const text = await status(w, ownEnv(w));

    expect(text).toContain('❔ Unknown');
    expect(text).not.toContain('⏳ Export behind');
    expect(text).not.toContain(DONE_LINE);
    expect(text).not.toContain(NOT_DONE);
  });

  test('AC 2: a failed br read reads as could not check, never as not done or done', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'picked-up');
    dropFromExport(w, bead(w, NEW));

    const text = await status(w, {...ownEnv(w), PATH: NO_BR_ON_PATH});

    expect(text).toContain(UNCHECKED);
    expect(text).not.toContain(NOT_DONE);
    expect(text).not.toContain(DONE_LINE);
    expect(text).toContain('could not be checked');
  });

  test('the inbox shows the lag, not Unknown, and its control shows Unknown when the bead is gone', async () => {
    const w = world();
    labelInDbOnly(w, bead(w, NEW), 'picked-up');
    dropFromExport(w, bead(w, NEW));
    const card = async (): Promise<string> => {
      const inbox = await readInbox({
        cwd: w.repo,
        days: 30,
        env: w.env,
        now: NOW,
        repo: null,
      });
      if (inbox.kind !== 'read') throw new Error(inbox.reason);
      return JSON.stringify(
        inboxJson(inbox.read).sessions.find((entry) => entry.sessionId === NEW),
      );
    };

    const behind = await card();
    expect(behind).toContain('"status":{"behind"');
    expect(behind).toContain('1 change behind');
    expect(behind).not.toContain(NOT_DONE);

    const del = runBr(w.repo, [
      'delete',
      bead(w, NEW),
      '--force',
      '--no-auto-flush',
    ]);
    if (!del.ok) throw new Error(`br delete failed: ${del.reason ?? '?'}`);
    const gone = await card();
    expect(gone).not.toContain('"status":{"behind"');
    expect(gone).toContain('"kind":"unknown"');
  });
});

describe('the [thread] line', () => {
  function line(w: World, env: World['env']): string {
    return sessionContextLine({cwd: w.repo, env, sessionId: NEW}) ?? '';
  }

  test('says nothing about the pickup when only the database shows it; its control says not done', () => {
    const w = world();
    dropFromExport(w, bead(w, NEW));
    const before = line(w, ownEnv(w));
    expect(before).toContain(NOT_DONE);

    labelInDbOnly(w, bead(w, NEW), 'picked-up');
    dropFromExport(w, bead(w, NEW));
    const after = line(w, ownEnv(w));
    expect(after).not.toContain(NOT_DONE);
    expect(after).not.toContain('could not check');
  });

  test('a failed br read says could not check', () => {
    const w = world();
    dropFromExport(w, bead(w, NEW));

    const said = line(w, {...ownEnv(w), PATH: NO_BR_ON_PATH});

    expect(said).toContain('handoff pickup: could not check:');
    expect(said).not.toContain(NOT_DONE);
  });
});

describe('pickupState: every source, read or not', () => {
  const read = (...labels: string[]) => ({kind: 'read' as const, labels});
  const failed = {kind: 'failed' as const, reason: 'the beads DB is locked'};
  const noRead = () => {
    throw new Error('this answer needs no br read');
  };
  function state(
    w: World,
    readLabels: Parameters<typeof pickupState>[0]['readLabels'],
    exportLabels: readonly string[] | null = null,
  ) {
    return pickupState({
      autoPickup: true,
      env: ownEnv(w),
      exportLabels,
      ownSession: true,
      readLabels,
      sessionId: NEW,
    });
  }
  function failureFile(w: World): string {
    return join(
      w.env.JUSTIN_THREADS_STATE_DIR ?? '',
      'handoff-pickup',
      `${NEW}.json`,
    );
  }

  test('the export showing the label answers with no br read', () => {
    const w = world();
    expect(state(w, noRead, ['picked-up'])).toEqual({
      kind: 'done',
      via: 'export',
    });
  });

  test('the knob off is not owed, with no br read', () => {
    const w = world();
    expect(
      pickupState({
        autoPickup: false,
        env: ownEnv(w),
        exportLabels: null,
        ownSession: true,
        readLabels: noRead,
        sessionId: NEW,
      }),
    ).toEqual({kind: 'notOwed'});
  });

  test('the database label beats a recorded failure', () => {
    const w = world();
    writePickupFailure(
      NEW,
      {
        at: NOW.toISOString(),
        predecessorBeadId: bead(w, OLD),
        reason: 'the beads DB was locked',
        step: 'record',
      },
      ownEnv(w),
    );
    expect(state(w, () => read('picked-up'))).toEqual({
      kind: 'done',
      via: 'database',
    });
  });

  test('no label and a recorded failure is not done, with that reason', () => {
    const w = world();
    writePickupFailure(
      NEW,
      {
        at: NOW.toISOString(),
        predecessorBeadId: bead(w, OLD),
        reason: 'the beads DB was locked',
        step: 'record',
      },
      ownEnv(w),
    );
    expect(state(w, () => read())).toMatchObject({
      kind: 'notDone',
      reason: 'the beads DB was locked',
    });
  });

  test('a failed database read is could not check, whatever else is known', () => {
    const w = world();
    expect(state(w, () => failed)).toEqual({
      kind: 'couldNotCheck',
      reason: failed.reason,
    });
    writePickupFailure(
      NEW,
      {
        at: NOW.toISOString(),
        predecessorBeadId: bead(w, OLD),
        reason: 'older failure',
        step: 'record',
      },
      ownEnv(w),
    );
    expect(state(w, () => failed).kind).toBe('couldNotCheck');
  });

  test('a corrupt failure file is could not check unless the label settles it', () => {
    const w = world();
    mkdirSync(dirname(failureFile(w)), {recursive: true});
    writeFileSync(failureFile(w), '{not json');
    expect(state(w, () => read()).kind).toBe('couldNotCheck');
    expect(state(w, () => read('picked-up')).kind).toBe('done');

    writeFileSync(failureFile(w), '"a bare string"');
    expect(state(w, () => read()).kind).toBe('couldNotCheck');
  });

  test('an unreadable message log with no launch variable is could not check, not "not a successor"', () => {
    const w = world();
    const path = messageLogPath(NEW, w.env);
    writeFileSync(path, '');
    const env = {...w.env, CLAUDE_CODE_SESSION_ID: NEW};
    const asked = (): ReturnType<typeof pickupState> =>
      pickupState({
        autoPickup: true,
        env,
        exportLabels: [],
        ownSession: true,
        readLabels: () => read(),
        sessionId: NEW,
      });
    // Control: a log that reads, with nothing marked, owes nothing.
    expect(asked()).toEqual({kind: 'notOwed'});

    // A directory where the file should be is a read that fails with EISDIR.
    Bun.spawnSync(['rm', path]);
    mkdirSync(path);
    expect(asked().kind).toBe('couldNotCheck');
  });
});

describe('the capture hook', () => {
  const failingCmux = () =>
    Promise.resolve({
      kind: 'failed' as const,
      reason: 'cmux is not here',
      timedOut: false,
    });

  async function nameStep(w: World) {
    return await syncWorkspaceForCapture({
      cwd: w.repo,
      enabled: true,
      env: w.env,
      lookup: {
        kind: 'found',
        session: {
          beadId: bead(w, NEW),
          labels: [`sid:${NEW}`, `${CMUX_SURFACE_LABEL_PREFIX}surface-1`],
          repo: w.repo,
          repoTag: null,
          sessionId: NEW,
          title: 'A real title',
        },
      },
      run: failingCmux,
    });
  }

  test('the workspace name step records a retry, not a failure, while the export is behind; its control reaches cmux', async () => {
    const w = world({nameWorkspaces: true, workspaceDescription: true});

    // Control: the export holds the bead, so the step goes on to cmux.
    const onward = await nameStep(w);
    expect(onward.kind).toBe('failed');
    expect(JSON.stringify(onward)).not.toContain('could not be read');

    dropFromExport(w, bead(w, NEW));
    const outcome = await nameStep(w);
    expect(outcome.kind).toBe('notReady');
    const record = workspaceSyncRecord(outcome);
    expect(record.kind).toBe('notReady');
    expect(record.detail).toContain('the next capture retries');
  });
});

describe('thread request --continues on a session already picked up', () => {
  function snapshot(w: World) {
    const updated = [bead(w, OLD), bead(w, NEW)].map((id) => {
      const shown = brShow({cwd: w.repo}, id);
      if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
      return `${id} ${shown.issue.updatedAt ?? '?'} ${shown.issue.notes ?? ''}`;
    });
    return {
      export: readFileSync(exportPath(w), 'utf8'),
      index: readFileSync(sessionIndexPath(w.env), 'utf8'),
      updated,
    };
  }

  function continues(w: World) {
    return fileRequest({
      bead: null,
      continues: bead(w, OLD),
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: NEW,
      title: null,
    });
  }

  test('AC 3: it writes nothing and exits 0, and the first run is its control', async () => {
    const w = world();
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: OLD,
      title: 'Migrate the orders table',
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));

    const before = snapshot(w);
    const first = await continues(w);
    expect(first).toMatchObject({
      kind: 'handoffPickup',
      pickup: {kind: 'picked-up', wrote: true},
    });
    const held = snapshot(w);
    // Control: the snapshot sees a run that wrote.
    expect(held.export).not.toBe(before.export);
    expect(held.updated).not.toEqual(before.updated);

    const again = await continues(w);
    expect(again).toMatchObject({
      kind: 'handoffPickup',
      pickup: {kind: 'picked-up', wrote: false},
    });
    expect(describeRequestOutcome(again).exitCode).toBe(0);
    expect(snapshot(w)).toEqual(held);
  });

  test('the capture hook on a session already picked up also writes nothing', async () => {
    const w = world();
    const first = await runAutoPickup({
      cwd: w.repo,
      env: ownEnv(w),
      now: NOW,
      sessionId: NEW,
    });
    expect(first?.kind).toBe('picked-up');
    const held = snapshot(w);

    const again = await runAutoPickup({
      cwd: w.repo,
      env: ownEnv(w),
      now: NOW,
      sessionId: NEW,
    });

    // Not `held`: both beads still carry auto-title, so it looks again, and
    // finds nothing to do.
    expect(again).toMatchObject({kind: 'picked-up', wrote: false});
    expect(snapshot(w)).toEqual(held);
  });
});
