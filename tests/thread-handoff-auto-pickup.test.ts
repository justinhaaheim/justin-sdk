/**
 * The system does the handoff pickup by itself, behind a switch
 * (home-base-npbse.1.2). Real br in $TMPDIR workspaces, real capture passes; each
 * test names the acceptance criterion it proves.
 */

import type {PickUpDeps} from '../src/thread/handoff-pickup';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, type brUpdate, runBr} from '../src/beads/br';
import {captureRunLogPath, messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {applyCapture, runThreadCaptureApply} from '../src/thread/capture';
import {
  pickupState,
  predecessorInFirstLine,
  successorMark,
} from '../src/thread/handoff-auto-pickup';
import {runAutoPickup} from '../src/thread/handoff-auto-pickup-run';
import {pickUpHandoff} from '../src/thread/handoff-pickup';
import {successorClaudeWords} from '../src/thread/handoff-successor';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {KICKOFF_OPENING, kickoffText} from '../src/thread/respawn';
import {ensureSessionBead, sidLabel} from '../src/thread/session-bead';
import {handOff} from '../src/thread/session-handoff';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {sessionContextLine} from '../src/thread/session-line';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {spawnCommand} from '../src/thread/spawn';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-000000000002';
const NEW = '0e400000-1111-4222-8333-000000000003';
const OTHER = '07400000-1111-4222-8333-000000000004';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const NOT_DONE = 'handoff pickup not done:';
const RETRY_TAIL = 'it retries at the next prompt or turn end; to retry now:';

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

function logFirstLine(
  env: World['env'],
  repo: string,
  session: string,
  text: string,
): void {
  const path = messageLogPath(session, env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    serializeMessageLine({
      at: '2030-01-01T09:00:00.000Z',
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text,
    }),
  );
}

function world(
  firstLines: Partial<Record<string, string>> = {},
  sessions: readonly string[] = [OLD, NEW],
  autoPickup = true,
): World {
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
          handoff: {autoPickup},
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
  const repo = initRepo(sb, 'auto-repo', {'README.md': '# p\n'});
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
    logFirstLine(env, repo, session, firstLines[session] ?? 'migrate the db');
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

async function request(w: World, session: string, title: string) {
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

async function ask(w: World, session: string, question: string) {
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

/** The predecessor's work: one request and one question. */
async function work(w: World) {
  return {
    question: await ask(w, OLD, 'Keep the old index?'),
    request: await request(w, OLD, 'Migrate the orders table'),
  };
}

type PassOptions = Partial<Parameters<typeof applyCapture>[0]> & {
  continues?: string;
};

async function pass(w: World, session: string, options: PassOptions = {}) {
  const {continues, ...rest} = options;
  const outcome = await applyCapture({
    autoCommit: false,
    autoPickup: true,
    cwd: w.repo,
    env: {
      ...w.env,
      ...(continues != null ? {JUSTIN_SDK_CONTINUES: continues} : {}),
    },
    nameWorkspaces: false,
    now: NOW,
    sessionBeads: true,
    sessionId: session,
    ...rest,
  });
  if (outcome.kind !== 'ran') throw new Error(JSON.stringify(outcome));
  return outcome;
}

/** A pickup attempt whose every label write fails, as a br outage would. */
function failingAttempt(input: Parameters<typeof runAutoPickup>[0]) {
  const update: typeof brUpdate = () => ({
    command: 'br update',
    detail: [],
    kind: 'failed',
    reason: 'the beads DB is locked',
  });
  const deps: Partial<PickUpDeps> = {update};
  return runAutoPickup(input, {
    pickUp: (pickInput, pickDeps) =>
      pickUpHandoff(pickInput, {...pickDeps, ...deps}),
  });
}

function exported(w: World): string {
  return readFileSync(join(w.repo, '.beads', 'issues.jsonl'), 'utf8');
}

async function partOne(w: World, session: string): Promise<string> {
  const load = await loadSessionReport({
    asIfYielded: true,
    cwd: w.repo,
    env: {...w.env, CLAUDE_CODE_SESSION_ID: session},
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

describe('one capture pass picks up a marked successor (home-base-npbse.1.2)', () => {
  test('AC 1: a marked successor whose model ran nothing is linked with every open request and question, after one pass', async () => {
    const w = world();
    const {question, request: filed} = await work(w);

    const outcome = await pass(w, NEW, {continues: beadOf(w, OLD)});

    expect(outcome.pickup).toMatchObject({
      carriedQuestions: 1,
      carriedRequests: 1,
      kind: 'picked-up',
      wrote: true,
    });
    const labels = shown(w, beadOf(w, NEW)).labels;
    expect(labels).toContain('picked-up');
    expect(labels).toContain(`continues:${beadOf(w, OLD)}`);
    expect(shown(w, beadOf(w, OLD)).labels).toContain(
      `continued-by:${beadOf(w, NEW)}`,
    );
    expect(shown(w, filed).labels).toContain(sidLabel(NEW));
    expect(shown(w, filed).labels).toContain('request');
    expect(shown(w, question).labels).toContain(sidLabel(NEW));
    const status = await partOne(w, NEW);
    expect(status).toContain('Migrate the orders table');
    expect(status).toContain('Keep the old index?');
  });

  test('AC 2: a failed attempt retries on the next pass and then holds; after that a pass writes nothing', async () => {
    const w = world();
    const {request: filed} = await work(w);
    const continues = beadOf(w, OLD);

    const failed = await pass(w, NEW, {continues, runPickup: failingAttempt});
    expect(failed.pickup).toMatchObject({kind: 'failed'});
    const notesAfterFirst = shown(w, beadOf(w, NEW)).notes;
    await pass(w, NEW, {continues, runPickup: failingAttempt});
    expect(shown(w, beadOf(w, NEW)).notes).toBe(notesAfterFirst);
    expect(shown(w, beadOf(w, NEW)).labels).not.toContain('picked-up');

    const held = await pass(w, NEW, {continues});
    expect(held.pickup).toMatchObject({kind: 'picked-up', wrote: true});
    expect(shown(w, filed).labels).toContain(sidLabel(NEW));

    const before = exported(w);
    const again = await pass(w, NEW, {continues});
    expect(again.pickup).toEqual({kind: 'held', label: 'picked-up'});
    expect(exported(w)).toBe(before);
  });

  test('the gate: one real capture pass against a scratch DB, its capture.jsonl record printed', async () => {
    const w = world();
    await work(w);
    await runThreadCaptureApply({
      autoCommit: false,
      cwd: w.repo,
      env: {...w.env, JUSTIN_SDK_CONTINUES: beadOf(w, OLD)},
      now: NOW,
      sessionId: NEW,
    });
    const line =
      readFileSync(captureRunLogPath(w.env), 'utf8')
        .trim()
        .split('\n')
        .at(-1) ?? '{}';
    console.log(`capture.jsonl record: ${line}`);
    const record = JSON.parse(line) as {pickup?: {kind?: string}};
    expect(record.pickup?.kind).toBe('picked-up');
  });

  test('AC 3: an unmarked session does no pickup and no extra br write, with the knob on', async () => {
    const w = world();
    await work(w);
    const before = exported(w);
    const outcome = await pass(w, NEW);
    expect(outcome.pickup).toBeUndefined();
    expect(exported(w)).toBe(before);
    expect(shown(w, beadOf(w, NEW)).labels).not.toContain('picked-up');
  });

  test('AC 5: a throw in the pickup changes nothing else in the capture, and capture.jsonl names it', async () => {
    const w = world({}, [OLD, NEW, OTHER]);
    await work(w);
    const boom = () => {
      throw new Error('boom in the pickup');
    };
    const thrown = await pass(w, NEW, {
      continues: beadOf(w, OLD),
      runPickup: boom,
    });
    const plain = await pass(w, OTHER);
    expect(thrown.pickup).toMatchObject({kind: 'failed', step: 'threw'});
    expect(JSON.stringify(thrown.pickup)).toContain('boom in the pickup');
    expect(thrown.sessionBead?.kind).toBe(plain.sessionBead?.kind);
    expect(thrown.statusFile?.kind).toBe(plain.statusFile?.kind);
    expect(thrown.last.kind).toBe(plain.last.kind);
    expect(thrown.passes).toBe(plain.passes);
    expect(thrown.seed.kind).toBe(plain.seed.kind);

    await runThreadCaptureApply({
      autoCommit: false,
      autoPickup: true,
      cwd: w.repo,
      env: {...w.env, JUSTIN_SDK_CONTINUES: beadOf(w, OLD)},
      nameWorkspaces: false,
      now: NOW,
      runPickup: boom,
      sessionBeads: true,
      sessionId: NEW,
    });
    const records = readFileSync(captureRunLogPath(w.env), 'utf8')
      .trim()
      .split('\n');
    const record = JSON.parse(records.at(-1) ?? '{}') as {
      pickup?: {reason?: string; step?: string};
      sessionBead?: {kind?: string};
    };
    expect(record.pickup?.step).toBe('threw');
    expect(record.pickup?.reason).toContain('boom in the pickup');
    expect(record.sessionBead?.kind).toBe('exists');
  });

  test('AC 6: /clear in a successor (same variable, new session id) makes no second link, says not-a-successor once, and never nags', async () => {
    const w = world({}, [OLD, NEW, OTHER]);
    await work(w);
    const continues = beadOf(w, OLD);
    await pass(w, NEW, {continues});

    const before = shown(w, continues).labels;
    const first = await pass(w, OTHER, {continues});
    expect(first.pickup).toMatchObject({kind: 'not-a-successor'});
    const after = shown(w, beadOf(w, OTHER));
    expect(after.labels).toContain('not-a-successor');
    expect(after.labels).not.toContain(`continues:${continues}`);
    expect(shown(w, continues).labels).toEqual(before);
    const notes = after.notes;

    const second = await pass(w, OTHER, {continues});
    expect(second.pickup).toEqual({kind: 'held', label: 'not-a-successor'});
    expect(shown(w, beadOf(w, OTHER)).notes).toBe(notes);

    const line = sessionContextLine({
      cwd: w.repo,
      env: {...w.env, JUSTIN_SDK_CONTINUES: continues},
      sessionId: OTHER,
    });
    expect(line).not.toContain(NOT_DONE);
    expect(await partOne(w, OTHER)).not.toContain(NOT_DONE);
  });
});

describe('the knob off (home-base-npbse.1.2)', () => {
  test('AC 4: no pickup, no new variable in the successor command, and the kickoff word for word as before', async () => {
    const w = world({}, [OLD, NEW], false);
    await work(w);
    const before = exported(w);
    const outcome = await pass(w, NEW, {
      autoPickup: false,
      continues: beadOf(w, OLD),
    });
    expect(outcome.pickup).toBeUndefined();
    expect(exported(w)).toBe(before);
    expect(
      sessionContextLine({
        cwd: w.repo,
        env: {...w.env, JUSTIN_SDK_CONTINUES: beadOf(w, OLD)},
        sessionId: NEW,
      }),
    ).not.toContain(NOT_DONE);

    const words = successorClaudeWords({
      continues: null,
      kickoff: 'k',
      model: null,
      name: 'n',
      permissionMode: 'auto',
    });
    expect(words[0]).toBe('claude');
    expect(words.join(' ')).not.toContain('JUSTIN_SDK_CONTINUES');
    expect(kickoffText('/s/b.md', 't-old', null)).toBe(
      `${KICKOFF_OPENING} Read /s/b.md. First run the command under its pick-up section: bun run justin-sdk thread request --continues t-old. Every open request and question carries over to this session; the note is the order to take them in, not the whole scope. Then continue the work the block describes, starting from its note.`,
    );
  });

  test('item 2: with the knob on, the successor command types the variable before claude', () => {
    const words = successorClaudeWords({
      continues: 't-old',
      kickoff: 'k',
      model: null,
      name: 'n',
      permissionMode: 'auto',
    });
    expect(words.slice(0, 2)).toEqual(['JUSTIN_SDK_CONTINUES=t-old', 'claude']);
  });

  test('item 6: with the knob on, the kickoff says to check and names the command as the fallback', () => {
    const text = kickoffText('/s/b.md', 't-old', null, {autoPickup: true});
    expect(text.startsWith(KICKOFF_OPENING)).toBe(true);
    expect(text).toContain(
      'Check that bun run justin-sdk thread status shows the requests carried over; if it says the pickup is not done, run: bun run justin-sdk thread request --continues t-old.',
    );
    expect(text).not.toContain('First run the command');
    expect(predecessorInFirstLine(text)).toBe('t-old');
  });
});

describe('what marks a successor (home-base-npbse.1.2)', () => {
  const knobOff = kickoffText('/s/b.md', 't-a1.2', null);
  const knobOn = kickoffText('/s/b.md', 't-a1.2', null, {autoPickup: true});
  const mayor = '/conductor You continue session bead t-a1.2. Pick it up.';

  test('AC 7: only the real kickoff or the exact mayor form, at the start', () => {
    expect(predecessorInFirstLine(knobOff)).toBe('t-a1.2');
    expect(predecessorInFirstLine(knobOn)).toBe('t-a1.2');
    expect(predecessorInFirstLine(mayor)).toBe('t-a1.2');
    expect(
      predecessorInFirstLine('/conductor You continue session bead t-a.'),
    ).toBe('t-a');
    for (const text of [
      'what does thread request --continues t-a1.2 do?',
      'run bun run justin-sdk thread request --continues t-a1.2 for me',
      'look at t-a1.2 please',
      `Earlier today: ${KICKOFF_OPENING} Read x. --continues t-a1.2`,
      'please /conductor You continue session bead t-a1.2.',
      '/conductor You continue session t-a1.2.',
      KICKOFF_OPENING,
    ]) {
      expect(predecessorInFirstLine(text)).toBeNull();
    }
  });

  test('AC 7: the launch variable wins, and an empty one is no mark', () => {
    expect(
      successorMark({env: {JUSTIN_SDK_CONTINUES: 't-b'}, firstUserText: mayor}),
    ).toEqual({predecessorBeadId: 't-b', via: 'env'});
    expect(
      successorMark({env: {JUSTIN_SDK_CONTINUES: ' '}, firstUserText: 'hi'}),
    ).toBeNull();
    expect(successorMark({env: {}, firstUserText: mayor})).toEqual({
      predecessorBeadId: 't-a1.2',
      via: 'first-line',
    });
  });

  test('AC 7, by name: a first message that only mentions --continues <id> takes over nothing', async () => {
    const w = world();
    const {request: filed} = await work(w);
    logFirstLine(
      w.env,
      w.repo,
      NEW,
      `what does thread request --continues ${beadOf(w, OLD)} do?`,
    );
    const before = exported(w);
    const outcome = await pass(w, NEW);
    expect(outcome.pickup).toBeUndefined();
    expect(exported(w)).toBe(before);
    expect(shown(w, filed).labels).not.toContain(sidLabel(NEW));
  });

  test('AC 7: a real kickoff as the first message is a successor', async () => {
    const w = world();
    const {request: filed} = await work(w);
    logFirstLine(
      w.env,
      w.repo,
      NEW,
      kickoffText('/s/b.md', beadOf(w, OLD), null),
    );
    const outcome = await pass(w, NEW);
    expect(outcome.pickup).toMatchObject({kind: 'picked-up'});
    expect(shown(w, filed).labels).toContain(sidLabel(NEW));
  });

  test('AC 7: the mayor form as the first message is a successor', async () => {
    const w = world();
    const {request: filed} = await work(w);
    logFirstLine(
      w.env,
      w.repo,
      NEW,
      `/conductor You continue session bead ${beadOf(w, OLD)}. Go on.`,
    );
    const outcome = await pass(w, NEW);
    expect(outcome.pickup).toMatchObject({kind: 'picked-up'});
    expect(shown(w, filed).labels).toContain(sidLabel(NEW));
  });

  test('AC 7: thread spawn --continues types the variable, and nothing without it', () => {
    const base = {
      kickoffFile: null,
      model: null,
      name: 'n',
      remoteControl: false,
    };
    expect(spawnCommand({...base, continues: 't-old'})).toContain(
      'JUSTIN_SDK_CONTINUES=t-old claude',
    );
    expect(spawnCommand(base)).not.toContain('JUSTIN_SDK_CONTINUES');
  });
});

describe('a failure is named (home-base-npbse.1.2)', () => {
  test('AC 8: the [thread] line and thread status say the wording until it holds, then stop', async () => {
    const w = world();
    await work(w);
    const continues = beadOf(w, OLD);
    const env = {...w.env, JUSTIN_SDK_CONTINUES: continues};
    const command = `bun run justin-sdk thread request --continues ${continues}`;

    // Marked, before any attempt finished.
    expect(sessionContextLine({cwd: w.repo, env, sessionId: NEW})).toContain(
      `${NOT_DONE} the first attempt has not finished; ${RETRY_TAIL}`,
    );

    await pass(w, NEW, {continues, runPickup: failingAttempt});

    const line = sessionContextLine({cwd: w.repo, env, sessionId: NEW}) ?? '';
    expect(line).toContain(NOT_DONE);
    expect(line).toContain('the beads DB is locked');
    expect(line).toContain(`${RETRY_TAIL} ${command}`);
    const status = await partOne(w, NEW);
    expect(status).toContain(NOT_DONE);
    expect(status).toContain('the beads DB is locked');
    expect(status).toContain(command);

    await pass(w, NEW, {continues});

    expect(
      sessionContextLine({cwd: w.repo, env, sessionId: NEW}),
    ).not.toContain(NOT_DONE);
    expect(await partOne(w, NEW)).not.toContain(NOT_DONE);
  });

  test('AC 8: an unmarked session and another session’s environment get no wording', () => {
    const w = world();
    const noBrRead = () => {
      throw new Error('an unmarked session must make no br read');
    };
    expect(
      pickupState({
        autoPickup: true,
        env: w.env,
        exportLabels: [],
        ownSession: true,
        readLabels: noBrRead,
        sessionId: NEW,
      }),
    ).toEqual({kind: 'notOwed'});
    expect(
      pickupState({
        autoPickup: true,
        env: {...w.env, JUSTIN_SDK_CONTINUES: 't-x'},
        exportLabels: [],
        ownSession: false,
        readLabels: noBrRead,
        sessionId: NEW,
      }),
    ).toEqual({kind: 'notOwed'});
  });

  async function inboxCard(w: World, session: string, now: Date) {
    const inbox = await readInbox({
      cwd: w.repo,
      days: 30,
      env: w.env,
      now,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(inbox.reason);
    return JSON.stringify(
      inboxJson(inbox.read).sessions.find(
        (entry) => entry.sessionId === session,
      ),
    );
  }

  test('AC 8: the inbox says "handed off, not picked up" 10 minutes after the handoff, and stops once it holds', async () => {
    const w = world();
    await work(w);
    const handedOff = await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'context full',
      now: NOW,
      sessionId: OLD,
      to: null,
    });
    expect(handedOff.kind).not.toBe('failed');
    expect(shown(w, beadOf(w, OLD)).labels).toContain('pickup-expected');

    const soon = new Date(NOW.getTime() + 9 * 60_000);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(await inboxCard(w, OLD, soon)).not.toContain('not picked up');
    expect(await inboxCard(w, OLD, later)).toContain(
      'Handed off, not picked up',
    );

    await pass(w, NEW, {continues: beadOf(w, OLD)});
    expect(await inboxCard(w, OLD, later)).not.toContain('not picked up');
  });

  test('AC 8: a handoff from before the knob is not reported as not picked up', async () => {
    const w = world({}, [OLD, NEW], false);
    await work(w);
    await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'context full',
      now: NOW,
      sessionId: OLD,
      to: null,
    });
    expect(shown(w, beadOf(w, OLD)).labels).not.toContain('pickup-expected');
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(await inboxCard(w, OLD, later)).not.toContain('not picked up');
  });
});
