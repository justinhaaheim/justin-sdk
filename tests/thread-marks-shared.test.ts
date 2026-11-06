/**
 * `thread done` / `thread archive` on a session that handed off must not close
 * or drop what its successor took over (home-base-npbse.1.3). Real br in $TMPDIR
 * workspaces; each test names the acceptance criterion it proves.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead, sidLabel} from '../src/thread/session-bead';
import {
  closeSession,
  describeCloseOutcome,
  unmarkSession,
} from '../src/thread/session-marks';
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

setDefaultTimeout(60_000);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: Record<string, string>;
  env: Record<string, string | undefined>;
  repo: string;
}

function world(sessions: readonly string[] = [OLD, NEW]): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, nameWorkspaces: false, sessionBeads: true},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'marks-repo', {'README.md': '# p\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const beads: Record<string, string> = {};
  for (const session of sessions) {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: session,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    beads[session] = filed.beadId;
    const path = messageLogPath(session, env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
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

function beadOf(w: World, session: string): string {
  const id = w.beads[session];
  if (id == null) throw new Error(`no bead for ${session}`);
  return id;
}

function shown(w: World, id: string) {
  const read = brShow({cwd: w.repo}, id);
  if (read.kind !== 'ok') throw new Error(`br show ${id}: ${read.kind}`);
  return read.issue;
}

async function request(
  w: World,
  session: string,
  title: string,
): Promise<string> {
  const filed = await fileRequest({
    bead: null,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    sessionId: session,
    title,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  return filed.id;
}

async function adopt(w: World, session: string, id: string): Promise<void> {
  const filed = await fileRequest({
    bead: id,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    sessionId: session,
    title: null,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
}

async function ask(
  w: World,
  session: string,
  question: string,
): Promise<string> {
  const filed = await fileAsk({
    approve: false,
    context: [],
    cwd: w.repo,
    default: 'I keep them.',
    do: false,
    env: w.env,
    header: null,
    options: [],
    priority: '2',
    question,
    recommend: null,
    sessionId: session,
    to: null,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  return filed.id;
}

function epicBead(w: World, title: string): string {
  const made = runBr(w.repo, ['create', title, '-t', 'epic', '--silent']);
  if (!made.ok) throw new Error(`br create: ${made.reason ?? '?'}`);
  return made.stdout.trim();
}

async function pickUp(w: World): Promise<void> {
  const outcome = await fileRequest({
    bead: null,
    continues: beadOf(w, OLD),
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    sessionId: NEW,
    title: null,
  });
  if (outcome.kind !== 'handoffPickup' || outcome.pickup.kind !== 'picked-up') {
    throw new Error(JSON.stringify(outcome));
  }
}

async function partOne(w: World, session: string): Promise<string> {
  const load = await loadSessionReport({
    asIfYielded: true,
    cwd: w.repo,
    env: w.env,
    now: NOW,
    selector: null,
    sessionId: session,
  });
  if (load.kind !== 'loaded') throw new Error(JSON.stringify(load));
  return renderThreadStatus(load, {
    now: NOW,
    style: {color: false, width: null},
    timeZone: 'UTC',
  });
}

/** A world after a pickup: a filed request, an adopted one and a question. */
async function handedOff(w: World) {
  const filed = await request(w, OLD, 'Migrate the orders table');
  const adopted = epicBead(w, 'The billing epic');
  await adopt(w, OLD, adopted);
  const question = await ask(w, OLD, 'Keep the old index?');
  await pickUp(w);
  return {adopted, filed, question};
}

function mark(w: World, mode: 'archive' | 'done', session: string) {
  return closeSession(mode, {
    cwd: w.repo,
    env: w.env,
    reason: 'tab finished',
    selector: beadOf(w, session),
    sessionId: null,
  });
}

describe.each(['done', 'archive'] as const)(
  'thread %s on a predecessor after a pickup (home-base-npbse.1.3)',
  (mode) => {
    test(`AC ${mode === 'done' ? '1 and 2' : '3'}: every carried request and question stays open and with the successor`, async () => {
      const w = world();
      const {adopted, filed, question} = await handedOff(w);
      const before = await partOne(w, NEW);
      expect(before).toContain('0 of 2 requests done');

      const outcome = await mark(w, mode, OLD);

      if (outcome.kind !== 'closed') throw new Error(JSON.stringify(outcome));
      expect(outcome.closed).toEqual([]);
      expect(outcome.released).toEqual([]);
      expect(outcome.sessionClosed).toBe(true);
      expect(outcome.failures).toEqual([]);
      const mySid = sidLabel(OLD);
      const theirSid = sidLabel(NEW);
      for (const id of [filed, adopted]) {
        const bead = shown(w, id);
        expect(bead.status).not.toBe('closed');
        expect(bead.labels).toContain('request');
        expect(bead.labels).toContain(theirSid);
        expect(bead.labels).not.toContain(mySid);
      }
      const carried = shown(w, question);
      expect(carried.status).not.toBe('closed');
      expect(carried.labels).toContain(theirSid);
      expect(carried.labels).not.toContain(mySid);

      const after = await partOne(w, NEW);
      expect(after).toContain('0 of 2 requests done');
      expect(after).toContain('Migrate the orders table');
      expect(after).toContain('The billing epic');
      expect(after).toContain('Keep the old index?');
    });
  },
);

describe('what no other session holds (home-base-npbse.1.3)', () => {
  test('AC 4: a request and question of this session alone are closed, an adopted one released, as before', async () => {
    const w = world();
    const filed = await request(w, OLD, 'Migrate the orders table');
    const adopted = epicBead(w, 'The billing epic');
    await adopt(w, OLD, adopted);
    const question = await ask(w, OLD, 'Keep the old index?');

    const outcome = await mark(w, 'done', OLD);

    if (outcome.kind !== 'closed') throw new Error(JSON.stringify(outcome));
    expect(outcome.leftWithOthers).toEqual([]);
    expect(outcome.closed.map((bead) => bead.id).sort()).toEqual(
      [filed, question].sort(),
    );
    expect(outcome.released.map((bead) => bead.id)).toEqual([adopted]);
    expect(shown(w, filed).status).toBe('closed');
    expect(shown(w, question).status).toBe('closed');
    // Adoption set in_progress; a release leaves the status untouched.
    expect(shown(w, adopted).status).toBe('in_progress');
    expect(shown(w, adopted).labels).not.toContain('request');
    expect(shown(w, adopted).labels).not.toContain(sidLabel(OLD));
  });

  test('AC 4: the last session holding a bead closes it', async () => {
    const w = world();
    const {filed, question} = await handedOff(w);
    await mark(w, 'done', OLD);

    const outcome = await mark(w, 'done', NEW);

    if (outcome.kind !== 'closed') throw new Error(JSON.stringify(outcome));
    expect(outcome.leftWithOthers).toEqual([]);
    expect(shown(w, question).status).toBe('closed');
    // NEW did not create it, so it is released, as any adopted request is.
    expect(outcome.released.map((bead) => bead.id)).toContain(filed);
    expect(shown(w, filed).labels).not.toContain('request');
  });
});

describe('thread unmark (home-base-npbse.1.3)', () => {
  test('AC 5, shared: the session label comes back, and nothing else changed', async () => {
    const w = world();
    const {adopted, filed, question} = await handedOff(w);
    const labelsBefore = [filed, adopted, question].map((id) =>
      [...shown(w, id).labels].sort(),
    );
    const statusesBefore = [filed, adopted, question].map(
      (id) => shown(w, id).status,
    );
    await mark(w, 'archive', OLD);

    const undone = await unmarkSession({
      cwd: w.repo,
      env: w.env,
      session: beadOf(w, OLD),
    });

    if (undone.kind !== 'unmarked') throw new Error(JSON.stringify(undone));
    expect(undone.failures).toEqual([]);
    expect([...undone.heldAgain].sort()).toEqual(
      [filed, adopted, question].sort(),
    );
    expect(undone.relabelled).toEqual([]);
    expect(
      [filed, adopted, question].map((id) => [...shown(w, id).labels].sort()),
    ).toEqual(labelsBefore);
    expect([filed, adopted, question].map((id) => shown(w, id).status)).toEqual(
      statusesBefore,
    );
    expect(shown(w, beadOf(w, OLD)).status).not.toBe('closed');
    expect(shown(w, beadOf(w, OLD)).labels).not.toContain('archived');
  });

  test('AC 5, unshared: closed beads reopen and a released request gets its labels back', async () => {
    const w = world();
    const filed = await request(w, OLD, 'Migrate the orders table');
    const adopted = epicBead(w, 'The billing epic');
    await adopt(w, OLD, adopted);
    const question = await ask(w, OLD, 'Keep the old index?');
    await mark(w, 'done', OLD);

    const undone = await unmarkSession({
      cwd: w.repo,
      env: w.env,
      session: beadOf(w, OLD),
    });

    if (undone.kind !== 'unmarked') throw new Error(JSON.stringify(undone));
    expect(undone.failures).toEqual([]);
    expect(undone.heldAgain).toEqual([]);
    expect(undone.relabelled).toEqual([adopted]);
    expect(shown(w, filed).status).not.toBe('closed');
    expect(shown(w, question).status).not.toBe('closed');
    expect(shown(w, adopted).labels).toContain('request');
    expect(shown(w, adopted).labels).toContain(sidLabel(OLD));
  });
});

describe('what the mark prints (home-base-npbse.1.3)', () => {
  test('AC 6: each bead left with another session is named by id, title and session', async () => {
    const w = world();
    const {adopted, filed, question} = await handedOff(w);

    const outcome = await mark(w, 'done', OLD);

    const {exitCode, lines} = describeCloseOutcome('thread done', outcome);
    const text = lines.join('\n');
    expect(exitCode).toBe(0);
    expect(text).toContain('Left with another session');
    const holder = `${beadOf(w, NEW)} (${NEW})`;
    expect(text).toContain(
      `${filed} · Migrate the orders table · held by ${holder}`,
    );
    expect(text).toContain(`${adopted} · The billing epic · held by ${holder}`);
    expect(text).toContain(
      `${question} · Keep the old index? · held by ${holder}`,
    );
    // Its own heading only, so it never reads as "still in the backlog".
    expect(text).not.toContain('Left open (still in the backlog)');
  });
});
