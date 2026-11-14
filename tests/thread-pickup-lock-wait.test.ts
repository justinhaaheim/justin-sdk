/**
 * `thread request --continues` while the capture hook's background pickup holds
 * the session's lock (home-base-ttztr). On 2026-11-13 two successor sessions ran
 * the command while that pickup held the lock past the 30 s wait, and it failed
 * twice in a row at step "lock". Real br in $TMPDIR workspaces; the timescale is
 * shortened (a 100 ms short wait stands for the 30 s one). A running holder is
 * the test's parent process, which outlives every test.
 */

import type {CapturePickupOutcome} from '../src/thread/handoff-auto-pickup';
import type {ThreadRequestOptions} from '../src/thread/request';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {captureLockPath, messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {runAutoPickup} from '../src/thread/handoff-auto-pickup-run';
import {serializeMessageLine} from '../src/thread/message-log';
import {describeRequestOutcome, fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-000000000002';
const NEW = '0e400000-1111-4222-8333-000000000003';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const NOT_DONE = 'handoff pickup not done:';
const RUNNING = 'handoff pickup running in the background';
const SHORT_WAIT_MS = 100;
/** Past the short wait: the background pickup "held the lock over 30 s". */
const HOOK_DELAY_MS = 300;
const RUNNING_PID = process.ppid;

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

function world(): World {
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
  const repo = initRepo(sb, 'lock-wait-repo', {'README.md': '# p\n'});
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

/** The successor's own environment, marked as `thread handoff` marks it. */
function ownEnv(w: World): World['env'] {
  return {
    ...w.env,
    CLAUDE_CODE_SESSION_ID: NEW,
    JUSTIN_SDK_CONTINUES: bead(w, OLD),
  };
}

/** OLD with two open requests and one unanswered question. */
async function predecessorWork(w: World): Promise<void> {
  for (const title of ['Keep the migration going', 'Write the rollback']) {
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: OLD,
      title,
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  }
  const asked = await fileAsk({
    approve: false,
    context: [],
    cwd: w.repo,
    default: 'I index the users table first.',
    do: false,
    env: w.env,
    header: null,
    options: [],
    priority: '2',
    question: 'Which table do I index first?',
    recommend: null,
    sessionId: OLD,
    to: null,
  });
  if (asked.kind !== 'filed') throw new Error(JSON.stringify(asked));
}

/** The capture hook's own pickup attempt, as its capture child runs it. */
function hookPickup(w: World): Promise<CapturePickupOutcome | null> {
  return runAutoPickup({cwd: w.repo, env: ownEnv(w), now: NOW, sessionId: NEW});
}

function holdLock(w: World, holder: string): string {
  const path = captureLockPath(NEW, w.env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, holder);
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manualPickup(
  w: World,
  extra: Partial<ThreadRequestOptions> = {},
): ReturnType<typeof fileRequest> {
  return fileRequest({
    bead: null,
    continues: bead(w, OLD),
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    pickupLockHolderWaitMs: 30_000,
    pickupLockPollMs: 10,
    pickupLockWaitMs: SHORT_WAIT_MS,
    sessionId: NEW,
    title: null,
    ...extra,
  });
}

async function status(w: World): Promise<string> {
  const load = await loadSessionReport({
    asIfYielded: true,
    cwd: w.repo,
    env: ownEnv(w),
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

describe('thread request --continues while the background pickup holds the lock', () => {
  test('it waits past the short wait for the running holder, then says the background attempt did it, exit 0', async () => {
    const w = world();
    await predecessorWork(w);
    const lock = holdLock(w, String(RUNNING_PID));
    const waits: string[] = [];
    const hook: {run: Promise<CapturePickupOutcome | null> | null} = {
      run: null,
    };

    const started = Date.now();
    const outcome = await manualPickup(w, {
      // The hook's pickup ends after the short wait has run out, then the hook
      // releases the lock, as applyCapture does.
      onPickupLockWait: (line) => {
        waits.push(line);
        hook.run = sleep(HOOK_DELAY_MS).then(async () => {
          const done = await hookPickup(w);
          rmSync(lock);
          return done;
        });
      },
    });

    expect(outcome).toMatchObject({
      kind: 'handoffPickup',
      lockWait: {holderPid: RUNNING_PID, pickedUpBefore: false},
      pickup: {kind: 'picked-up', wrote: false},
    });
    expect(Date.now() - started).toBeGreaterThan(HOOK_DELAY_MS);
    expect(await hook.run).toMatchObject({
      carriedQuestions: 1,
      carriedRequests: 2,
      kind: 'picked-up',
      wrote: true,
    });
    const {exitCode, lines} = describeRequestOutcome(outcome);
    const text = lines.join('\n');
    expect(exitCode).toBe(0);
    expect(text).toContain(
      `Nothing to do: the background attempt already picked up ${bead(w, OLD)}`,
    );
    expect(text).toContain('with 2 requests, 1 question.');
    expect(text).toContain(
      `which held this session's lock; the pickup was not done when the wait began.`,
    );
    expect(text).toContain('Already here (2 requests, 1 question):');
    expect(waits).toEqual([
      `thread request: process ${RUNNING_PID} holds this session's lock, most likely the capture hook's background run; waiting for it, up to 30 s.`,
    ]);
    expect(existsSync(lock)).toBe(false);
  });

  test('control: a pickup done before the wait began is not credited to the holder', async () => {
    const w = world();
    await predecessorWork(w);
    expect(await hookPickup(w)).toMatchObject({kind: 'picked-up'});
    const lock = holdLock(w, String(RUNNING_PID));

    const outcome = await manualPickup(w, {
      onPickupLockWait: () => {
        void sleep(HOOK_DELAY_MS).then(() => rmSync(lock));
      },
    });

    expect(outcome).toMatchObject({
      lockWait: {pickedUpBefore: true},
      pickup: {kind: 'picked-up', wrote: false},
    });
    const {exitCode, lines} = describeRequestOutcome(outcome);
    const text = lines.join('\n');
    expect(exitCode).toBe(0);
    expect(text).toContain(
      `Nothing to do: session ${bead(w, NEW)} has already picked up ${bead(w, OLD)}`,
    );
    expect(text).toContain(`This command first waited`);
    expect(text).not.toContain('the background attempt');
  });

  test('a running holder that never lets go: it fails at the longer bound, names the process and says to check thread status', async () => {
    const w = world();
    await predecessorWork(w);
    const lock = holdLock(w, String(RUNNING_PID));
    const before = readFileSync(join(w.repo, '.beads', 'issues.jsonl'), 'utf8');

    const started = Date.now();
    const outcome = await manualPickup(w, {pickupLockHolderWaitMs: 400});

    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(outcome).toMatchObject({
      pickup: {kind: 'failed', step: 'lock'},
    });
    const {exitCode, lines} = describeRequestOutcome(outcome);
    const text = lines.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain(
      `process ${RUNNING_PID} still holds this session's lock after`,
    );
    expect(text).toContain('thread status in a minute');
    expect(readFileSync(join(w.repo, '.beads', 'issues.jsonl'), 'utf8')).toBe(
      before,
    );
    expect(readFileSync(lock, 'utf8')).toBe(String(RUNNING_PID));
  });

  test("a lock whose holder is measurably gone is taken at once, by capture.ts's own rule", async () => {
    const w = world();
    await predecessorWork(w);
    const dead = Bun.spawnSync(['true']).pid;
    holdLock(w, String(dead));
    const waits: string[] = [];

    const outcome = await manualPickup(w, {
      onPickupLockWait: (line) => waits.push(line),
    });

    expect(outcome).toMatchObject({
      lockWait: null,
      pickup: {kind: 'picked-up', wrote: true},
    });
    expect(waits).toEqual([]);
  });

  test("a lock that names no pid gets the short wait and today's failure", async () => {
    const w = world();
    await predecessorWork(w);
    holdLock(w, 'not a pid');

    const started = Date.now();
    const outcome = await manualPickup(w);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({
      lockWait: null,
      pickup: {kind: 'failed', step: 'lock'},
    });
    expect(describeRequestOutcome(outcome).lines.join('\n')).toContain(
      "another process held this session's lock for 0 s, or the lock could not be taken",
    );
  });
});

describe('thread status while the background pickup holds the lock', () => {
  test('What to mark says it is running and offers thread status, not the pickup command', async () => {
    const w = world();
    holdLock(w, String(RUNNING_PID));

    const text = await status(w);

    expect(text).toContain(
      `${RUNNING} (process ${RUNNING_PID} holds this session's lock); run thread status again in a minute:`,
    );
    expect(text).toContain('thread status`');
    expect(text).not.toContain(NOT_DONE);
    expect(text).not.toContain('--continues');
  });

  test("controls: no lock, a gone holder, or a lock it cannot read all keep today's line and command", async () => {
    const w = world();
    const command = `thread request --continues ${bead(w, OLD)}`;

    const free = await status(w);
    expect(free).toContain(NOT_DONE);
    expect(free).toContain(command);
    expect(free).not.toContain(RUNNING);

    holdLock(w, String(Bun.spawnSync(['true']).pid));
    const gone = await status(w);
    expect(gone).toContain(NOT_DONE);
    expect(gone).toContain(command);
    expect(gone).not.toContain(RUNNING);

    holdLock(w, 'not a pid');
    const unreadable = await status(w);
    expect(unreadable).toContain(NOT_DONE);
    expect(unreadable).toContain(command);
    expect(unreadable).not.toContain(RUNNING);
  });
});
