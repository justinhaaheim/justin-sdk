/**
 * Picking up a handoff with `thread request --continues` (home-base-npbse.1.1).
 * Real br in $TMPDIR workspaces; `needBr()` throws when br is missing. Each test
 * names the acceptance criterion it proves.
 */

import type {PickUpDeps} from '../src/thread/handoff-pickup';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, brUpdate, runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {
  captureLockPath,
  messageLogPath,
  sessionIndexPath,
} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {
  realChainReaders,
  walkUnattendedChain,
} from '../src/thread/handoff-chain';
import {runHandoffGate} from '../src/thread/handoff-gate';
import {serializeMessageLine} from '../src/thread/message-log';
import {describeRequestOutcome, fileRequest} from '../src/thread/request';
import {kickoffText} from '../src/thread/respawn';
import {answerSessionQuestions} from '../src/thread/session-answer';
import {ensureSessionBead} from '../src/thread/session-bead';
import {describeHandoffOutcome, handOff} from '../src/thread/session-handoff';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {
  loadSessionReport,
  renderThreadStatus,
} from '../src/thread/session-report';
import {exportRecordById, readSessionTree} from '../src/thread/session-tree';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const GRAND = 'a1d00000-1111-4222-8333-000000000001';
const OLD = '01d00000-1111-4222-8333-000000000002';
const NEW = '0e400000-1111-4222-8333-000000000003';
const OTHER = '07400000-1111-4222-8333-000000000004';
const NOW = new Date('2030-01-01T12:00:00.000Z');

// Each test makes dozens of real br calls, and each pickup makes about twenty.
setDefaultTimeout(60_000);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: Record<string, string>;
  env: Record<string, string | undefined>;
  repo: string;
  sandbox: Sandbox;
}

/** Files `session`'s bead and its first message log line; returns the bead id. */
function addSession(
  w: World,
  session: string,
  text = 'migrate the db',
): string {
  const filed = ensureSessionBead({
    cwd: w.repo,
    env: {...w.env, CLAUDE_CODE_SESSION_ID: session},
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: session,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  w.beads[session] = filed.beadId;
  const path = messageLogPath(session, w.env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    serializeMessageLine({
      at: '2030-01-01T09:00:00.000Z',
      cwd: w.repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text,
    }),
  );
  return filed.beadId;
}

function world(sessions: readonly string[] = [GRAND, OLD, NEW]): World {
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
  const repo = initRepo(sb, 'pickup-repo', {'README.md': '# p\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const w: World = {beads: {}, env, repo, sandbox: sb};
  for (const session of sessions) addSession(w, session);
  return w;
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

async function adopt(w: World, session: string, id: string) {
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
  to: string | null = null,
) {
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
    to,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  return filed.id;
}

function closeBead(w: World, id: string, reason: string): void {
  const closed = runBr(w.repo, ['close', id, '--reason', reason]);
  if (!closed.ok) throw new Error(`br close ${id}: ${closed.reason ?? '?'}`);
}

function pickUp(
  w: World,
  options: {
    deps?: Partial<PickUpDeps>;
    lockWaitMs?: number;
    predecessor?: string;
    session?: string;
    title?: string;
  } = {},
) {
  return fileRequest({
    bead: null,
    continues: options.predecessor ?? beadOf(w, OLD),
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    ...(options.deps != null ? {pickupDeps: options.deps} : {}),
    // home-base-ttztr: a running holder is waited for longer; keep it short here.
    ...(options.lockWaitMs != null
      ? {
          pickupLockHolderWaitMs: options.lockWaitMs * 2,
          pickupLockPollMs: 10,
          pickupLockWaitMs: options.lockWaitMs,
        }
      : {}),
    sessionId: options.session ?? NEW,
    title: options.title ?? null,
  });
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

/** Every byte a run could change: the beads export and the sessions index. */
function writesSnapshot(w: World): {export: string; index: string} {
  return {
    export: readFileSync(join(w.repo, '.beads', 'issues.jsonl'), 'utf8'),
    index: readFileSync(sessionIndexPath(w.env), 'utf8'),
  };
}

/** A bead's parents, from the export: BrIssue does not carry them. */
function parentsOf(w: World, id: string): string[] {
  const dir = join(w.repo, '.beads');
  const path = join(dir, 'issues.jsonl');
  const found = exportRecordById(readFileSync(path, 'utf8'), id, dir, path);
  if (found.kind !== 'found') throw new Error(`${id}: ${found.kind}`);
  return found.issue.parentIds;
}

/** Every one of `wanted` is among the bead's labels. */
function expectLabels(w: World, id: string, wanted: readonly string[]): void {
  const {labels} = shown(w, id);
  expect(wanted.filter((label) => !labels.includes(label))).toEqual([]);
}

/** Occurrences of `text` in `haystack`. */
function count(haystack: string, text: string): number {
  return haystack.split(text).length - 1;
}

/** OLD with: its own request, one adopted from GRAND, and a closed one. */
async function chain(w: World) {
  const adopted = await request(w, GRAND, 'Adopted from the session before');
  await adopt(w, OLD, adopted);
  const own = await request(w, OLD, 'Filed by the old session');
  const closed = await request(w, OLD, 'Finished by the old session');
  closeBead(w, closed, 'done');
  return {adopted, closed, own};
}

describe('thread request --continues carries the work over', () => {
  test('AC1: its children and the requests it adopted show in the successor, closed ones do not', async () => {
    const w = world();
    const {adopted, closed, own} = await chain(w);
    expect(shown(w, adopted).labels).toContain(`sid:${OLD}`);
    expect(await partOne(w, NEW)).not.toContain(own);

    const outcome = await pickUp(w);
    expect(outcome).toMatchObject({
      kind: 'handoffPickup',
      pickup: {
        alreadyHeld: {questions: [], requests: []},
        carried: {
          questions: [],
          requests: [
            {id: adopted, title: 'Adopted from the session before'},
            {id: own, title: 'Filed by the old session'},
          ],
        },
        kind: 'picked-up',
        wrote: true,
      },
    });
    expect(describeRequestOutcome(outcome).exitCode).toBe(0);

    const text = await partOne(w, NEW);
    expect(text).toContain(`**Adopted from the session before** (${adopted})`);
    expect(text).toContain(`**Filed by the old session** (${own})`);
    expect(text).not.toContain(closed);
    expect(text).not.toContain('Finished by the old session');
    expect(text).not.toContain('No requests filed');

    // Adoption added labels and moved nothing.
    expectLabels(w, adopted, [
      'request',
      `sid:${GRAND}`,
      `sid:${OLD}`,
      `sid:${NEW}`,
    ]);
    expect(parentsOf(w, adopted)).toEqual([beadOf(w, GRAND)]);
    expect(parentsOf(w, own)).toEqual([beadOf(w, OLD)]);
    expect(shown(w, closed).labels).not.toContain(`sid:${NEW}`);

    // The link, the end state and the record on both beads.
    const newBead = beadOf(w, NEW);
    const oldBead = beadOf(w, OLD);
    expectLabels(w, newBead, [`continues:${oldBead}`, 'picked-up']);
    expect(shown(w, oldBead).labels).toContain(`continued-by:${newBead}`);
    const record = `picked up by ${newBead}: 2 requests, 0 questions carried over`;
    expect(shown(w, newBead).notes).toContain(record);
    expect(shown(w, oldBead).notes).toContain(record);

    const lines = describeRequestOutcome(outcome).lines.join('\n');
    // One empty line between list items (the terminal output style).
    expect(lines).toContain(
      `  request ${adopted} · Adopted from the session before\n\n  request ${own} · Filed by the old session`,
    );
  });

  test('AC2: unanswered questions show in Part 1 and the inbox, answered ones do not, and the successor can answer them', async () => {
    const w = world();
    const {own} = await chain(w);
    const open = await ask(w, OLD, 'Drop the unused columns?', own);
    const walked = await ask(w, OLD, 'Keep the old index?', own);
    const answered = await ask(w, OLD, 'Rename the table?');
    const answer = await answerSessionQuestions({
      ask: answered,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: OLD,
      text: 'yes',
    });
    expect(answer.kind).toBe('answeredOne');
    expect(shown(w, open).labels).toContain(`to:${own.replaceAll('.', ':')}`);
    expect(await partOne(w, NEW)).not.toContain('Drop the unused columns?');

    const outcome = await pickUp(w);
    expect(outcome).toMatchObject({
      pickup: {
        carried: {
          questions: [
            {id: open, title: 'Drop the unused columns?'},
            {id: walked, title: 'Keep the old index?'},
          ],
        },
        kind: 'picked-up',
      },
    });

    const text = await partOne(w, NEW);
    expect(text).toContain('Drop the unused columns?');
    expect(text).not.toContain('Rename the table?');

    const inbox = await readInbox({
      cwd: w.repo,
      days: 30,
      env: w.env,
      now: NOW,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(inbox.reason);
    const card = inboxJson(inbox.read).sessions.find(
      (session) => session.sessionId === NEW,
    );
    expect(card).toMatchObject({card: {optional: {count: 2}}});

    // Its parent, its to: label and its first sid: stay; only the sid: is new.
    expectLabels(w, open, [
      'ask',
      `sid:${OLD}`,
      `sid:${NEW}`,
      `to:${own.replaceAll('.', ':')}`,
    ]);
    expect(parentsOf(w, open)).toEqual([beadOf(w, OLD)]);

    // Answered from the successor: one close, and it leaves both views.
    const fromSuccessor = await answerSessionQuestions({
      ask: open,
      cwd: w.repo,
      env: w.env,
      selector: null,
      sessionId: NEW,
      text: 'drop them',
    });
    expect(fromSuccessor.kind).toBe('answeredOne');
    expect(shown(w, open).status).toBe('closed');
    expect(shown(w, open).closeReason).toBe('answer: drop them');
    expect(await partOne(w, NEW)).not.toContain('Drop the unused columns?');

    // The inbox's own command, `thread answer <successor bead>`, walks it too.
    const walk = await answerSessionQuestions({
      ask: null,
      cwd: w.repo,
      env: w.env,
      selector: beadOf(w, NEW),
      sessionId: null,
      style: PLAIN_STYLE,
      terminal: {
        print: () => undefined,
        readLine: () => Promise.resolve('keep it'),
      },
      text: null,
    });
    expect(walk).toMatchObject({
      kind: 'walked',
      result: {answered: [walked]},
    });
    expect(shown(w, walked).closeReason).toBe('answer: keep it');
  });

  test('AC3: a second run writes nothing and says so', async () => {
    const w = world();
    const {own} = await chain(w);
    await ask(w, OLD, 'Drop the unused columns?', own);
    await pickUp(w);
    const before = writesSnapshot(w);

    let writes = 0;
    const counting: typeof brUpdate = (...args) => {
      writes += 1;
      return brUpdate(...args);
    };
    let links = 0;
    const second = await pickUp(w, {
      deps: {
        link: () => {
          links += 1;
          return {kind: 'failed', reason: 'the second run must not link'};
        },
        update: counting,
      },
    });
    expect(writes).toBe(0);
    expect(links).toBe(0);
    expect(writesSnapshot(w)).toEqual(before);
    expect(second).toMatchObject({
      pickup: {
        carried: {questions: [], requests: []},
        kind: 'picked-up',
        wrote: false,
      },
    });
    const {exitCode, lines} = describeRequestOutcome(second);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('Nothing to do');
    expect(lines.join('\n')).toContain('Nothing was written');
  });

  test('AC4: a successor that adopted some by hand ends with each request exactly once and no duplicate label', async () => {
    const w = world();
    const {adopted, own} = await chain(w);
    await adopt(w, NEW, own);

    const outcome = await pickUp(w);
    expect(outcome).toMatchObject({
      pickup: {
        alreadyHeld: {
          requests: [{id: own, title: 'Filed by the old session'}],
        },
        carried: {
          requests: [{id: adopted, title: 'Adopted from the session before'}],
        },
        kind: 'picked-up',
      },
    });
    const text = await partOne(w, NEW);
    expect(count(text, `(${own})`)).toBe(1);
    expect(count(text, `(${adopted})`)).toBe(1);

    // Re-adopting by hand after the pickup adds no second label either.
    await adopt(w, NEW, own);
    for (const id of [own, adopted]) {
      const {labels} = shown(w, id);
      expect(labels.filter((label) => label === `sid:${NEW}`)).toHaveLength(1);
      expect(labels.filter((label) => label === 'request')).toHaveLength(1);
      expect(new Set(labels).size).toBe(labels.length);
    }
    // The record counts what the successor holds, hand adoptions included.
    expect(shown(w, beadOf(w, NEW)).notes).toContain(
      '2 requests, 0 questions carried over',
    );
  });

  test('AC5: a predecessor continued by another session is refused once, naming it, and nothing else moves', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    const {own} = await chain(w);
    const first = await pickUp(w);
    expect(first).toMatchObject({pickup: {kind: 'picked-up'}});
    const newBead = beadOf(w, NEW);
    const oldBead = beadOf(w, OLD);
    const otherBead = beadOf(w, OTHER);
    const oldLabels = shown(w, oldBead).labels;

    const refused = await pickUp(w, {session: OTHER});
    expect(refused).toMatchObject({
      pickup: {
        continuedBy: newBead,
        kind: 'not-a-successor',
        recordedNow: true,
      },
    });
    const {exitCode, lines} = describeRequestOutcome(refused);
    expect(exitCode).toBe(2);
    expect(lines.join('\n')).toContain(newBead);

    const mine = shown(w, otherBead);
    expect(mine.labels).toContain('not-a-successor');
    expect(mine.labels).not.toContain('picked-up');
    expect(mine.labels.some((label) => label.startsWith('continues:'))).toBe(
      false,
    );
    expect(mine.notes).toContain(
      `not linked: ${oldBead} is already continued by ${newBead}`,
    );
    expect(shown(w, oldBead).labels).toEqual(oldLabels);
    expect(shown(w, own).labels).not.toContain(`sid:${OTHER}`);

    // Again: the same answer, and not one more byte.
    const before = writesSnapshot(w);
    const again = await pickUp(w, {session: OTHER});
    expect(again).toMatchObject({
      pickup: {
        continuedBy: newBead,
        kind: 'not-a-successor',
        recordedNow: false,
      },
    });
    expect(describeRequestOutcome(again).exitCode).toBe(2);
    expect(describeRequestOutcome(again).lines.join('\n')).toContain(newBead);
    expect(writesSnapshot(w)).toEqual(before);
  });

  test('AC6: a failure on one adoption of several names that step, and running it again finishes the rest', async () => {
    const w = world();
    const {adopted, own} = await chain(w);
    const third = await request(w, OLD, 'A third open request');
    const question = await ask(w, OLD, 'Drop the unused columns?', own);

    const failing: typeof brUpdate = (target, id, input) =>
      id === own
        ? {
            command: 'br update',
            detail: [],
            kind: 'failed',
            reason: 'database is locked',
          }
        : brUpdate(target, id, input);
    const stopped = await pickUp(w, {deps: {update: failing}});
    expect(stopped).toMatchObject({
      pickup: {
        done: {
          carried: {
            questions: [{id: question}],
            requests: [{id: adopted}, {id: third}],
          },
          link: {oldBeadId: beadOf(w, OLD)},
          pickedUpLabelled: false,
        },
        kind: 'failed',
        step: 'adopt-requests',
      },
    });
    const told = describeRequestOutcome(stopped);
    expect(told.exitCode).toBe(1);
    const said = told.lines.join('\n');
    expect(said).toContain('adopt-requests');
    expect(said).toContain(own);
    expect(said).toContain('database is locked');
    expect(said).toContain('Running the same command again finishes it');
    expect(said).toContain(
      `bun run justin-sdk thread request --continues ${beadOf(w, OLD)}`,
    );
    expect(shown(w, own).labels).not.toContain(`sid:${NEW}`);
    expect(shown(w, beadOf(w, NEW)).labels).not.toContain('picked-up');
    expect(shown(w, beadOf(w, OLD)).notes ?? '').not.toContain('picked up by');

    const finished = await pickUp(w);
    expect(finished).toMatchObject({
      pickup: {
        alreadyHeld: {
          questions: [{id: question}],
          requests: [{id: adopted}, {id: third}],
        },
        carried: {questions: [], requests: [{id: own}]},
        kind: 'picked-up',
      },
    });
    expect(describeRequestOutcome(finished).exitCode).toBe(0);
    expect(shown(w, own).labels).toContain(`sid:${NEW}`);
    expect(shown(w, beadOf(w, NEW)).labels).toContain('picked-up');
    for (const bead of [beadOf(w, NEW), beadOf(w, OLD)]) {
      expect(shown(w, bead).notes).toContain(
        '3 requests, 1 question carried over',
      );
    }
  });

  test('AC7: the handoff block and the kickoff say everything carries over and the note is only the order', async () => {
    const w = world();
    await chain(w);
    const outcome = await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'start with the backfill',
      now: NOW,
      sessionId: OLD,
      timeZone: 'UTC',
      to: null,
    });
    const block = describeHandoffOutcome(outcome).lines.join('\n');
    expect(block).toContain(
      'Every open request and question above carries over to the new session.',
    );
    expect(block).toContain(
      'The note is the order to take them in, not the whole scope.',
    );
    const kickoff = kickoffText('/state/x.md', 't-old', null);
    expect(kickoff).toContain(
      'Every open request and question carries over to this session',
    );
    expect(kickoff).toContain(
      'the note is the order to take them in, not the whole scope',
    );
  });

  test('AC8: --help says what the pickup does, and no longer says it only links', () => {
    const entry = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = Bun.spawnSync(
      [process.execPath, entry, 'thread', 'request', '--help'],
      {env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'}},
    );
    const help = run.stdout.toString().replaceAll(/\s+/g, ' ');
    expect(run.exitCode).toBe(0);
    expect(help).not.toContain('only links');
    expect(help).toContain('adopt every open request');
    expect(help).toContain('carry over its unanswered questions');
    expect(help).toContain('Run it again at any time');
    expect(help).toContain('not-a-successor');
    expect(help).toContain('Each session has one predecessor');
  });
});

/** The labels of a bead that start with `continues:`, sorted. */
function continuesLabels(w: World, id: string): string[] {
  return shown(w, id)
    .labels.filter((label) => label.startsWith('continues:'))
    .sort();
}

/**
 * The real gate over the real chain walk against the scratch DB. Every other
 * reader passes, and none of them reads real state.
 */
function nextHandoffGate(w: World, session: string) {
  return runHandoffGate({
    env: {...w.env, CLAUDE_CODE_SESSION_ID: session},
    limits: {
      maxLiveSessions: 20,
      maxUnattendedHandoffs: 3,
      usage: {
        check: false,
        maxSampleAgeMinutes: 150,
        maxSessionPercent: 85,
        maxWeekPercent: 90,
      },
    },
    now: NOW,
    readers: {
      callerScreen: () => {
        throw new Error('requireCmuxPane is false: the screen is not read');
      },
      chain: () =>
        walkUnattendedChain(
          beadOf(w, session),
          realChainReaders({cwd: w.repo, env: w.env}),
        ),
      guard: () => ({kind: 'registered', where: ['/fake/settings.json']}),
      guardPass: () => ({kind: 'valid', path: '/fake/guard-pass.json'}),
      killSwitch: () => ({kind: 'off', path: '/fake/handoff-off'}),
      launchRecord: null,
      liveSessions: () => ({
        bySource: {agents: 0, hookStore: 0, ps: 1, screen: 0},
        kind: 'counted',
        sessionIds: 1,
        total: 1,
        unplaced: {background: 0, pane: 0, process: 0},
      }),
      pingCmux: () => ({kind: 'ok'}),
      usage: () => {
        throw new Error('usage.check is false: the usage is not read');
      },
    },
    requireCmuxPane: false,
  });
}

describe('one predecessor per successor (home-base-npbse.1.4)', () => {
  test('AC2: --continues A then --continues B is refused naming A, no byte moves, and A again writes nothing', async () => {
    const w = world();
    const {own} = await chain(w);
    const stillThere = await request(w, GRAND, 'Still with the session before');
    const oldBead = beadOf(w, OLD);
    const grandBead = beadOf(w, GRAND);
    const newBead = beadOf(w, NEW);

    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    expect(shown(w, own).labels).toContain(`sid:${NEW}`);
    const before = writesSnapshot(w);

    const refused = await pickUp(w, {predecessor: grandBead});
    expect(refused).toMatchObject({
      kind: 'handoffPickup',
      pickup: {
        alreadyContinues: [oldBead],
        kind: 'already-continues',
        newBeadId: newBead,
        oldBeadId: grandBead,
      },
    });
    const {exitCode, lines} = describeRequestOutcome(refused);
    const text = lines.join('\n');
    console.log(`the refusal, exit ${exitCode}:\n${text}`);
    expect(exitCode).toBe(2);
    expect(text).toContain(
      `refused: this session already continues ${oldBead}, and a session continues only one predecessor, so it cannot also continue ${grandBead}.`,
    );
    expect(text).toContain('nothing was written');
    expect(text).toContain(`thread request --continues ${oldBead}`);
    // The predecessor's side has its own words: this is not that refusal.
    expect(text).not.toContain('not-a-successor');
    expect(text).not.toContain('is not the successor of');

    expect(writesSnapshot(w)).toEqual(before);
    expect(continuesLabels(w, newBead)).toEqual([`continues:${oldBead}`]);
    expect(shown(w, newBead).labels).not.toContain('not-a-successor');
    expect(
      shown(w, grandBead).labels.filter((label) =>
        label.startsWith('continued-by:'),
      ),
    ).toEqual([]);
    expect(shown(w, stillThere).labels).not.toContain(`sid:${NEW}`);

    const again = await pickUp(w);
    expect(again).toMatchObject({pickup: {kind: 'picked-up', wrote: false}});
    expect(describeRequestOutcome(again).exitCode).toBe(0);
    expect(writesSnapshot(w)).toEqual(before);
  });

  test('AC3: after that sequence the next handoff passes the gate; with two labels it is refused naming both', async () => {
    const w = world();
    await chain(w);
    const oldBead = beadOf(w, OLD);
    const grandBead = beadOf(w, GRAND);
    const newBead = beadOf(w, NEW);
    await pickUp(w);
    await pickUp(w, {predecessor: grandBead});

    const next = await nextHandoffGate(w, NEW);
    if (next.kind !== 'pass') throw new Error(JSON.stringify(next));
    expect(next.facts.chain).toMatchObject({
      kind: 'counted',
      links: [{beadId: newBead, continues: oldBead}],
    });

    // A bead damaged before this rule existed keeps the gate's own refusal.
    const damaged = brUpdate({cwd: w.repo}, newBead, {
      addLabels: [`continues:${grandBead}`],
    });
    if (damaged.kind === 'failed') throw new Error('the label was not added');
    const refused = await nextHandoffGate(w, NEW);
    if (refused.kind !== 'refused') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toBe('chainUnknown');
    expect(refused.detail).toContain(`continues:${oldBead}`);
    expect(refused.detail).toContain(`continues:${grandBead}`);
  });

  test('this side is checked first: a predecessor another session continues does not label this one not-a-successor', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    await chain(w);
    const oldBead = beadOf(w, OLD);
    const grandBead = beadOf(w, GRAND);
    const newBead = beadOf(w, NEW);
    await pickUp(w);
    expect(
      await pickUp(w, {predecessor: grandBead, session: OTHER}),
    ).toMatchObject({pickup: {kind: 'picked-up'}});

    const refused = await pickUp(w, {predecessor: grandBead});
    expect(refused).toMatchObject({
      pickup: {alreadyContinues: [oldBead], kind: 'already-continues'},
    });
    expect(shown(w, newBead).labels).not.toContain('not-a-successor');
    expect(shown(w, newBead).notes ?? '').not.toContain('not linked:');
  });

  test('a predecessor that does not exist gets the same refusal, before anything looks for it', async () => {
    const w = world();
    await chain(w);
    await pickUp(w);
    const refused = await pickUp(w, {predecessor: 't-no-such-bead'});
    expect(refused).toMatchObject({
      pickup: {alreadyContinues: [beadOf(w, OLD)], kind: 'already-continues'},
    });
  });

  test('with a title it still files the request, says why nothing linked, and exits 2', async () => {
    const w = world();
    await chain(w);
    const oldBead = beadOf(w, OLD);
    const grandBead = beadOf(w, GRAND);
    await pickUp(w);
    const filed = await pickUp(w, {
      predecessor: grandBead,
      title: 'Something new',
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    const {exitCode, lines} = describeRequestOutcome(filed);
    const text = lines.join('\n');
    expect(exitCode).toBe(2);
    expect(text).toContain(`${filed.id} WAS filed`);
    expect(text).toContain(
      `this session was NOT linked to ${grandBead}: this session already continues ${oldBead}`,
    );
    expect(text).not.toContain('is not the successor of');
    expect(filed.continued).toBeNull();
    expect(continuesLabels(w, beadOf(w, NEW))).toEqual([
      `continues:${oldBead}`,
    ]);
  });

  test('a session already holding two labels can finish either one, and a third is refused naming both', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    await chain(w);
    const oldBead = beadOf(w, OLD);
    const grandBead = beadOf(w, GRAND);
    const newBead = beadOf(w, NEW);
    const damaged = brUpdate({cwd: w.repo}, newBead, {
      addLabels: [`continues:${oldBead}`, `continues:${grandBead}`],
    });
    if (damaged.kind === 'failed') throw new Error('the labels were not added');
    const both = [`continues:${grandBead}`, `continues:${oldBead}`].sort();

    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    expect(continuesLabels(w, newBead)).toEqual(both);

    const refused = await pickUp(w, {predecessor: beadOf(w, OTHER)});
    if (refused.kind !== 'handoffPickup') {
      throw new Error(JSON.stringify(refused));
    }
    const {pickup} = refused;
    if (pickup.kind !== 'already-continues') {
      throw new Error(JSON.stringify(pickup));
    }
    expect([...pickup.alreadyContinues].sort()).toEqual(
      [grandBead, oldBead].sort(),
    );
    const {exitCode, lines} = describeRequestOutcome(refused);
    const text = lines.join('\n');
    expect(exitCode).toBe(2);
    expect(text).toContain('already has 2 continues: labels');
    expect(text).not.toContain('To finish or check');
    expect(continuesLabels(w, newBead)).toEqual(both);
  });
});

describe('the pickup when something is off', () => {
  test('the per-session lock: held by a live process it fails naming the step and writes nothing; it is free afterwards', async () => {
    const w = world();
    await chain(w);
    const path = captureLockPath(NEW, w.env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, String(process.ppid));
    const before = writesSnapshot(w);
    const held = await pickUp(w, {lockWaitMs: 40});
    expect(held).toMatchObject({pickup: {kind: 'failed', step: 'lock'}});
    expect(describeRequestOutcome(held).exitCode).toBe(1);
    expect(writesSnapshot(w)).toEqual(before);
    // The holder's lock is untouched, then a free lock lets it run and frees it.
    expect(readFileSync(path, 'utf8')).toBe(String(process.ppid));
    rmSync(path);
    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    expect(existsSync(path)).toBe(false);
  });

  test('the lock is held while the pickup writes', async () => {
    const w = world();
    await chain(w);
    const path = captureLockPath(NEW, w.env);
    let heldDuringWrite = false;
    const spying: typeof brUpdate = (...args) => {
      heldDuringWrite ||= existsSync(path);
      return brUpdate(...args);
    };
    await pickUp(w, {deps: {update: spying}});
    expect(heldDuringWrite).toBe(true);
  });

  test('an export it could not read is never reported as picked up, and what it could read still moves', async () => {
    const w = world();
    const {own} = await chain(w);
    const deps: Partial<PickUpDeps> = {
      readTree: (input) => {
        const tree = readSessionTree(input);
        return {
          ...tree,
          problems: ['/gone/.beads/issues.jsonl does not exist'],
        };
      },
    };
    const outcome = await pickUp(w, {deps});
    expect(outcome).toMatchObject({
      pickup: {
        done: {pickedUpLabelled: false},
        kind: 'failed',
        step: 'read-predecessor',
      },
    });
    expect(describeRequestOutcome(outcome).lines.join('\n')).toContain(
      '/gone/.beads/issues.jsonl',
    );
    expect(shown(w, own).labels).toContain(`sid:${NEW}`);
    expect(shown(w, beadOf(w, NEW)).labels).not.toContain('picked-up');
    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    expect(shown(w, beadOf(w, NEW)).labels).toContain('picked-up');
  });

  test('a failed title: a to d hold, so picked-up is set, exit 1, and running it again finishes it', async () => {
    const w = world();
    await request(w, OLD, 'Migrate the orders table');
    const newBead = beadOf(w, NEW);
    const failing: typeof brUpdate = (target, id, input) =>
      input.title != null
        ? {
            command: 'br update',
            detail: [],
            kind: 'failed',
            reason: 'database is locked',
          }
        : brUpdate(target, id, input);
    const stopped = await pickUp(w, {deps: {update: failing}});
    expect(stopped).toMatchObject({
      pickup: {
        done: {pickedUpLabelled: true, renamedSession: null},
        kind: 'failed',
        step: 'title',
      },
    });
    expect(describeRequestOutcome(stopped).exitCode).toBe(1);
    expectLabels(w, newBead, ['auto-title', 'picked-up']);

    const finished = await pickUp(w);
    expect(finished).toMatchObject({
      pickup: {
        kind: 'picked-up',
        renamedSession: {beadId: newBead, title: 'Migrate the orders table'},
      },
    });
    expect(shown(w, newBead).title).toBe('Migrate the orders table');
    expect(shown(w, newBead).labels).not.toContain('auto-title');
  });

  test('a failed link stops before anything moves, and running it again finishes it', async () => {
    const w = world();
    const {own} = await chain(w);
    const stopped = await pickUp(w, {
      deps: {
        link: () => ({
          kind: 'failed',
          reason: 'database is locked',
        }),
      },
    });
    expect(stopped).toMatchObject({
      pickup: {done: {link: null}, kind: 'failed', step: 'link'},
    });
    expect(shown(w, own).labels).not.toContain(`sid:${NEW}`);
    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
  });

  test('a half-written link is repaired', async () => {
    const w = world();
    const newBead = beadOf(w, NEW);
    const oldBead = beadOf(w, OLD);
    const half = brUpdate({cwd: w.repo}, newBead, {
      addLabels: [`continues:${oldBead}`],
    });
    expect(half.kind).toBe('ok');
    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    expect(shown(w, oldBead).labels).toContain(`continued-by:${newBead}`);
  });

  test('a bead that is not a session bead is refused before anything is written', async () => {
    const w = world();
    const own = await request(w, OLD, 'Filed by the old session');
    const before = writesSnapshot(w);
    const outcome = await pickUp(w, {predecessor: own});
    expect(outcome).toMatchObject({
      pickup: {kind: 'failed', step: 'find-predecessor'},
    });
    expect(describeRequestOutcome(outcome).lines.join('\n')).toContain(
      'is not a session bead',
    );
    expect(writesSnapshot(w)).toEqual(before);
  });

  test('a session bead the index does not know is still found through its sid: label', async () => {
    const w = world();
    const own = await request(w, OLD, 'Filed by the old session');
    const index = sessionIndexPath(w.env);
    const kept = readFileSync(index, 'utf8')
      .split('\n')
      .filter((line) => !line.includes(OLD))
      .join('\n');
    writeFileSync(index, kept);
    expect(await pickUp(w)).toMatchObject({
      pickup: {carried: {requests: [{id: own}]}, kind: 'picked-up'},
    });
  });

  test('a request in another checkout’s DB is adopted there, and the successor can see it', async () => {
    const w = world();
    const second = initRepo(w.sandbox, 'second-repo', {'README.md': '# s\n'});
    const init = runBr(second, ['init', '--prefix', 'u', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    const filed = await fileRequest({
      bead: null,
      cwd: second,
      doneWhen: null,
      env: w.env,
      here: true,
      now: NOW,
      sessionId: OLD,
      title: 'Filed in the other checkout',
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    expect(filed.id.startsWith('u-')).toBe(true);

    expect(await pickUp(w)).toMatchObject({
      pickup: {carried: {requests: [{id: filed.id}]}, kind: 'picked-up'},
    });
    const there = brShow({cwd: second}, filed.id);
    expect(there.kind === 'ok' && there.issue.labels).toContain(`sid:${NEW}`);
    expect(await partOne(w, NEW)).toContain(
      `**Filed in the other checkout** (${filed.id})`,
    );

    // The new index line is written once.
    const before = writesSnapshot(w);
    expect(await pickUp(w)).toMatchObject({pickup: {wrote: false}});
    expect(writesSnapshot(w)).toEqual(before);
  });

  test('with a title it files the request and does the whole pickup', async () => {
    const w = world();
    const {own} = await chain(w);
    const filed = await pickUp(w, {title: 'Finish the migration'});
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    expect(filed.continued?.oldBeadId).toBe(beadOf(w, OLD));
    expect(filed.followUpFailures).toEqual([]);
    expect(shown(w, own).labels).toContain(`sid:${NEW}`);
    expect(shown(w, beadOf(w, NEW)).labels).toContain('picked-up');
    // The title rule named it after its first request, not its predecessor.
    expect(shown(w, beadOf(w, NEW)).title).toBe('Finish the migration');
    const {exitCode, lines} = describeRequestOutcome(filed);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain(`request ${own} ·`);
  });

  test('with a title, a predecessor continued by another session still files the request and exits 2', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    await chain(w);
    expect(await pickUp(w)).toMatchObject({pickup: {kind: 'picked-up'}});
    const filed = await pickUp(w, {session: OTHER, title: 'Something new'});
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    const {exitCode, lines} = describeRequestOutcome(filed);
    expect(exitCode).toBe(2);
    expect(lines.join('\n')).toContain(`${filed.id} WAS filed`);
    expect(lines.join('\n')).toContain(beadOf(w, NEW));
  });
});

// ---------------------------------------------------------------------------
// home-base-1vcgs: a predecessor resumed after its successor, handed off again
// ---------------------------------------------------------------------------

/** D2's reader, answering the same for every successor. */
function activityOf(kind: 'failed' | 'stopped' | 'working') {
  return () =>
    Promise.resolve(
      kind === 'failed'
        ? {kind: 'failed' as const, reason: 'the test cannot read it'}
        : {
            activity:
              kind === 'working'
                ? {kind: 'working' as const, lastRecordAt: NOW.toISOString()}
                : {kind: 'stopped' as const},
            kind: 'read' as const,
            sessionId: OTHER,
          },
    );
}

function numberLabel(w: World, id: string): string | undefined {
  return shown(w, id).labels.find((label) =>
    label.startsWith('handoff-number:'),
  );
}

describe('a session resumed after its successor, then handed off again (home-base-1vcgs)', () => {
  test('AC1: S1 stopped, P hands off again, S2 is linked, holds P’s work and the next number', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    const {own} = await chain(w);
    const question = await ask(w, OLD, 'Keep the old index?');
    const oldBead = beadOf(w, OLD);
    const s1 = beadOf(w, OTHER);
    const s2 = beadOf(w, NEW);
    // S1 (the 10/24 session) continues P.
    expect(await pickUp(w, {session: OTHER})).toMatchObject({
      pickup: {kind: 'picked-up'},
    });
    // P is resumed and hands off again, minutes after S1 was created.
    const handed = await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'again',
      now: new Date(Date.now() + 3 * 60_000),
      readSuccessorActivity: activityOf('stopped'),
      sessionId: OLD,
      timeZone: 'UTC',
      to: null,
    });
    expect(handed.kind).toBe('handedOff');
    expect(describeHandoffOutcome(handed).lines.join('\n')).toContain(
      `This session was already continued by ${s1}, which has stopped; the new successor becomes the newest.`,
    );

    const second = await pickUp(w);
    expect(second).toMatchObject({
      pickup: {kind: 'picked-up', replaces: [s1]},
    });
    expect(describeRequestOutcome(second).lines.join('\n')).toContain(
      'this session is now its newest successor',
    );
    expectLabels(w, s2, [`continues:${oldBead}`, 'picked-up']);
    expect(shown(w, s2).labels).not.toContain('not-a-successor');
    expectLabels(w, oldBead, [`continued-by:${s1}`, `continued-by:${s2}`]);
    expect(shown(w, own).labels).toContain(`sid:${NEW}`);
    expect(shown(w, question).labels).toContain(`sid:${NEW}`);
    // D4: S1 is the first handoff, so S2 is the second, never a second #1.
    expect(numberLabel(w, s1)).toBe('handoff-number:1');
    expect(numberLabel(w, s2)).toBe('handoff-number:2');
  });

  test('AC2: the /clear case: S1 linked, P has not handed off since, a second session is refused', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    await chain(w);
    const oldBead = beadOf(w, OLD);
    const s1 = beadOf(w, OTHER);
    // P hands off BEFORE S1 exists (S1's bead is created after the kickoff).
    expect(
      (
        await handOff({
          cwd: w.repo,
          env: w.env,
          note: null,
          now: new Date(Date.now() - 5 * 60_000),
          sessionId: OLD,
          timeZone: 'UTC',
          to: null,
        })
      ).kind,
    ).toBe('handedOff');
    expect(await pickUp(w, {session: OTHER})).toMatchObject({
      pickup: {kind: 'picked-up'},
    });
    const refused = await pickUp(w);
    expect(refused).toMatchObject({
      pickup: {continuedBy: s1, kind: 'not-a-successor', recordedNow: true},
    });
    expect(shown(w, oldBead).labels).not.toContain(
      `continued-by:${beadOf(w, NEW)}`,
    );
    expect(
      shown(w, beadOf(w, NEW)).labels.some((label) =>
        label.startsWith('continues:'),
      ),
    ).toBe(false);
  });

  test('AC3: thread handoff refuses up front, writing nothing, while S1 works or cannot be read', async () => {
    const w = world([GRAND, OLD, NEW, OTHER]);
    await chain(w);
    expect(await pickUp(w, {session: OTHER})).toMatchObject({
      pickup: {kind: 'picked-up'},
    });
    const s1 = beadOf(w, OTHER);
    for (const kind of ['working', 'failed'] as const) {
      const before = writesSnapshot(w);
      const outcome = await handOff({
        cwd: w.repo,
        env: w.env,
        note: 'again',
        now: new Date(Date.now() + 3 * 60_000),
        readSuccessorActivity: activityOf(kind),
        sessionId: OLD,
        timeZone: 'UTC',
        to: null,
      });
      expect(outcome.kind).toBe('refused');
      const {exitCode, lines} = describeHandoffOutcome(outcome);
      expect(exitCode).toBe(2);
      expect(lines.join('\n')).toContain(
        kind === 'working'
          ? `${s1} continues this session and is working now`
          : `whether it is working now could not be read`,
      );
      expect(writesSnapshot(w)).toEqual(before);
      expect(shown(w, beadOf(w, OLD)).labels).not.toContain('handed-off');
    }
  });
});

// ---------------------------------------------------------------------------
// home-base-1vcgs.2: a request the newer of two successors carries
// ---------------------------------------------------------------------------

/**
 * Two sessions filed one after the other, the older with the smaller bead id.
 * br sorts labels, so a predecessor's first `continued-by:` is the smaller id,
 * and the old rule (follow the first label) is wrong only when that is the
 * older session. Bead ids are hashes, so sessions are filed until a later one
 * has a larger id than the smallest filed before it. All twelve failing needs
 * twelve ids in strictly falling order: odds of 1 in 12 factorial.
 */
function olderThenNewer(w: World): {newer: string; older: string} {
  let smallest: {bead: string; session: string} | null = null;
  for (let tried = 0; tried < 12; tried += 1) {
    const session = `5b000000-1111-4222-8333-0000000000${tried.toString(16).padStart(2, '0')}`;
    const bead = addSession(w, session, `successor number ${tried}`);
    if (smallest != null && bead > smallest.bead) {
      return {newer: session, older: smallest.session};
    }
    if (smallest == null || bead < smallest.bead) smallest = {bead, session};
  }
  throw new Error('no two sessions got bead ids in their creation order');
}

describe('a request the newer of two successors carries (home-base-1vcgs.2)', () => {
  test('thread status and the inbox show it carried by the newer one, not dropped by the older one', async () => {
    const w = world([OLD]);
    const {newer, older} = olderThenNewer(w);
    const s1 = beadOf(w, older);
    const s2 = beadOf(w, newer);
    await request(w, OLD, 'Filed before the first handoff');
    expect(await pickUp(w, {session: older})).toMatchObject({
      pickup: {kind: 'picked-up'},
    });
    // P is resumed after S1 stopped, files more work, and hands off again.
    const late = await request(w, OLD, 'Filed after the first successor');
    const handed = await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'again',
      now: new Date(Date.now() + 3 * 60_000),
      readSuccessorActivity: activityOf('stopped'),
      sessionId: OLD,
      timeZone: 'UTC',
      to: null,
    });
    expect(handed.kind).toBe('handedOff');
    expect(await pickUp(w, {session: newer})).toMatchObject({
      pickup: {kind: 'picked-up', replaces: [s1]},
    });

    // Each pickup titles its successor after P's first request, so the two
    // get titles of their own here, to tell them apart in the lines.
    const newerTitle = 'The newer successor';
    for (const [id, title] of [
      [s1, 'The older successor'],
      [s2, newerTitle],
    ] as const) {
      const retitled = brUpdate({cwd: w.repo}, id, {title});
      if (retitled.kind === 'failed') throw new Error(`retitle ${id}`);
    }

    // The fixture: P's first continued-by: names the older S1, S1 does not
    // hold the late request, and S2 does.
    const oldBead = beadOf(w, OLD);
    expect(
      shown(w, oldBead).labels.filter((label) =>
        label.startsWith('continued-by:'),
      ),
    ).toEqual([`continued-by:${s1}`, `continued-by:${s2}`]);
    expect(shown(w, late).labels).toContain(`sid:${newer}`);
    expect(shown(w, late).labels).not.toContain(`sid:${older}`);

    // thread status (Part 1) of P.
    const load = await loadSessionReport({
      asIfYielded: true,
      cwd: w.repo,
      env: w.env,
      now: NOW,
      selector: null,
      sessionId: OLD,
    });
    if (load.kind !== 'loaded') throw new Error(JSON.stringify(load));
    const line = load.requestStates.get(late);
    expect(line?.carriedBy ?? '').toEndWith(` ${newerTitle}`);
    expect(line?.state).not.toContain('does not hold this request');
    const text = renderThreadStatus(load, {
      now: NOW,
      style: {color: false, width: null},
      timeZone: 'UTC',
    });
    expect(text).toContain(`Carried by ${line?.carriedBy ?? '?'}: `);
    expect(text).not.toContain('which does not hold this request');

    // The inbox (and the dashboard that reads it): P's card says the same.
    const inbox = await readInbox({
      cwd: w.repo,
      days: 30,
      env: w.env,
      now: NOW,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(inbox.reason);
    const card = inbox.read.rows.find((row) => row.sessionId === OLD)?.card;
    const asked = card?.youAsked;
    const inboxLine =
      asked?.kind === 'requests'
        ? asked.requests.find((entry) => entry.id === late)?.stateLine
        : null;
    expect(inboxLine?.carriedBy ?? '').toEndWith(` ${newerTitle}`);
    expect(inboxLine?.state).not.toContain('does not hold this request');
  });
});
