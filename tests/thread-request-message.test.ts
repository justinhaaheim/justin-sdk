/**
 * `thread request` attaches the message of Justin's that led to the request
 * (home-base-6ujwi.3, D9 to D14), behind componentConfig.thread.requestMessage.
 * Real br in throwaway repos (the pinned one, tests/pinned-br.ts); every state
 * file, message log and transcript under a temp dir; cmux is a fake. The
 * failed-write case puts a fake br first on PATH that refuses a description
 * write and passes everything else to the real one.
 */

import type {MessageLine} from '../src/thread/message-log';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, writeFileSync} from 'fs';
import {delimiter, dirname, join} from 'path';

import {brShow, brUpdate, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {serializeMessageLine} from '../src/thread/message-log';
import {markSessionPrivate} from '../src/thread/privacy';
import {describeRequestOutcome, fileRequest} from '../src/thread/request';
import {
  fenceFor,
  localWhen,
  logLagReason,
  REQUEST_MESSAGE_HEADING,
  sectionKeys,
} from '../src/thread/request-message';
import {ensureSessionBead} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr, PINNED_BR} from './pinned-br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const SESSION = '7c1e9a42-aaaa-4bbb-8ccc-0123456789ab';
const PREFIX = SESSION.slice(0, 8);

interface World {
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
  sessionBeadId: string;
  transcripts: string;
}

function world(knob: boolean | null): World {
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
          sessionBeads: true,
          ...(knob == null ? {} : {requestMessage: knob}),
        },
      },
    }),
  );
  const transcripts = join(sb.path, 'transcripts');
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: transcripts,
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2026-11-18T09:00:00.000Z', text: 'First'},
    now: new Date('2026-11-18T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return {
    db: join(repo, '.beads', 'beads.db'),
    env,
    repo,
    sb,
    sessionBeadId: filed.beadId,
    transcripts,
  };
}

interface Said {
  at: string;
  role?: 'assistant' | 'user';
  text: string;
}

/** The session's message log, as the capture hook writes it. */
function writeLog(w: World, entries: readonly Said[]): void {
  const path = messageLogPath(SESSION, w.env);
  mkdirSync(dirname(path), {recursive: true});
  const lines: MessageLine[] = entries.map((entry) => ({
    at: entry.at,
    cwd: w.repo,
    event: entry.role === 'assistant' ? 'Stop' : 'UserPromptSubmit',
    role: entry.role ?? 'user',
    text: entry.text,
  }));
  writeFileSync(path, lines.map(serializeMessageLine).join(''));
}

/** The session's Claude Code transcript: one user record per prompt. */
function writeTranscript(w: World, entries: readonly Said[]): void {
  const dir = join(w.transcripts, '-tmp-repo');
  mkdirSync(dir, {recursive: true});
  const records = entries.map((entry) =>
    entry.role === 'assistant'
      ? {
          message: {content: [{text: entry.text, type: 'text'}]},
          timestamp: entry.at,
          type: 'assistant',
        }
      : {
          message: {content: entry.text, role: 'user'},
          timestamp: entry.at,
          type: 'user',
        },
  );
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
}

/** The log and the transcript agree, as they do when nothing failed. */
function said(w: World, entries: readonly Said[]): void {
  writeLog(w, entries);
  writeTranscript(w, entries);
}

function noCmux() {
  return () =>
    Promise.resolve({
      kind: 'failed' as const,
      reason: 'no cmux',
      timedOut: false,
    });
}

async function request(
  w: World,
  title: null | string,
  extra: {bead?: string; overarching?: boolean; short?: string} = {},
) {
  const outcome = await fileRequest({
    bead: extra.bead ?? null,
    cmux: noCmux(),
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    overarching: extra.overarching === true,
    sessionId: null,
    short: extra.short ?? null,
    title,
  });
  return {outcome, ...describeRequestOutcome(outcome)};
}

function filedId(outcome: Awaited<ReturnType<typeof fileRequest>>): string {
  if (outcome.kind !== 'filed') throw new Error(JSON.stringify(outcome));
  return outcome.id;
}

function descriptionOf(w: World, id: string): null | string {
  const shown = brShow({db: w.db, env: {}}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue.description;
}

function headings(text: null | string): number {
  return (text ?? '')
    .split('\n')
    .filter((line) => line === REQUEST_MESSAGE_HEADING).length;
}

/** A bead filed by hand, with a description of its own. */
function handFiled(w: World, description: string): string {
  const created = runBr(w.repo, [
    'create',
    '--title=Filed by hand',
    '--type=task',
    `--description=${description}`,
    '--silent',
  ]);
  if (!created.ok) throw new Error(created.reason ?? 'br create failed');
  return created.stdout.trim().split('\n').pop() ?? '';
}

const ASKED = 'Please build the CSV export.\nIt should   keep the spacing.';
const ASKED_AT = '2026-11-18T09:05:00.000Z';

describe('thread request --- the message that led to it (home-base-6ujwi.3)', () => {
  test('knob on: a new request carries his newest message, verbatim, with its id and time', async () => {
    needBr();
    const w = world(true);
    said(w, [
      {at: '2026-11-18T09:00:00.000Z', text: 'First'},
      {at: '2026-11-18T09:01:00.000Z', role: 'assistant', text: 'Done.'},
      {at: ASKED_AT, text: ASKED},
    ]);
    const {exitCode, lines, outcome} = await request(w, 'Add a CSV export');
    expect(exitCode).toBe(0);
    const description = descriptionOf(w, filedId(outcome));
    expect(description).toContain(REQUEST_MESSAGE_HEADING);
    expect(description).toContain(`Message \`${PREFIX}.2\``);
    expect(description).toContain(localWhen(ASKED_AT));
    expect(description).toContain(`\`\`\`\n${ASKED}\n\`\`\``);
    expect(lines).toContain(
      `  Justin's message ${PREFIX}.2 (${localWhen(ASKED_AT)}) is attached to the description`,
    );
  });

  test('--bead appends after the existing text and changes none of it', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const existing = 'Its own words.\n\n- one\n- two';
    const id = handFiled(w, existing);
    const {exitCode} = await request(w, null, {bead: id});
    expect(exitCode).toBe(0);
    const description = descriptionOf(w, id) ?? '';
    expect(
      description.startsWith(`${existing}\n\n${REQUEST_MESSAGE_HEADING}\n`),
    ).toBe(true);
    expect(description).toContain(`Message \`${PREFIX}.1\``);
  });

  test('F1: --bead twice, with a new message of his between, writes nothing the second time and prints no line', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const id = handFiled(w, 'Its own words.');
    const first = await request(w, null, {bead: id});
    expect(first.lines.some((line) => line.includes(`${PREFIX}.1`))).toBe(true);
    const afterFirst = descriptionOf(w, id);
    said(w, [
      {at: ASKED_AT, text: ASKED},
      {at: '2026-11-18T10:00:00.000Z', text: 'Something else entirely.'},
    ]);
    const second = await request(w, null, {bead: id});
    expect(second.exitCode).toBe(0);
    expect(descriptionOf(w, id)).toBe(afterFirst);
    expect(
      second.outcome.kind === 'filed'
        ? second.outcome.requestMessage
        : 'not filed',
    ).toBeNull();
    expect(second.lines.some((line) => line.includes("Justin's message"))).toBe(
      false,
    );
  });

  test('F1: --short and --overarching on a request this session already holds write nothing', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const filed = await request(w, 'Add a CSV export');
    const id = filedId(filed.outcome);
    const afterFiling = descriptionOf(w, id);
    expect(headings(afterFiling)).toBe(1);
    said(w, [
      {at: ASKED_AT, text: ASKED},
      {at: '2026-11-18T10:00:00.000Z', text: 'Something else entirely.'},
    ]);
    const short = await request(w, null, {bead: id, short: 'CSV export'});
    expect(short.exitCode).toBe(0);
    expect(descriptionOf(w, id)).toBe(afterFiling);
    const over = await request(w, null, {bead: id, overarching: true});
    expect(over.exitCode).toBe(0);
    expect(descriptionOf(w, id)).toBe(afterFiling);
    expect(
      [...short.lines, ...over.lines].some((line) =>
        line.includes("Justin's message"),
      ),
    ).toBe(false);
  });

  test('F1: --overarching with a new title still attaches', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const {outcome} = await request(w, 'The whole push', {overarching: true});
    expect(descriptionOf(w, filedId(outcome))).toContain(
      `Message \`${PREFIX}.1\``,
    );
  });

  test('knob off: the description is as before, the message log is not read, and no line is printed', async () => {
    needBr();
    const w = world(null);
    // A directory where the log should be: any read of it fails loudly.
    mkdirSync(messageLogPath(SESSION, w.env), {recursive: true});
    const existing = 'Its own words.';
    const id = handFiled(w, existing);
    const {exitCode, lines, outcome} = await request(w, null, {bead: id});
    expect(exitCode).toBe(0);
    expect(
      outcome.kind === 'filed' ? outcome.requestMessage : 'not filed',
    ).toBeNull();
    expect(descriptionOf(w, id)).toBe(existing);
    expect(lines.some((line) => line.includes("Justin's message"))).toBe(false);
  });

  test('knob on with an unreadable log: nothing is written, and the line says why', async () => {
    needBr();
    const w = world(true);
    mkdirSync(messageLogPath(SESSION, w.env), {recursive: true});
    const id = handFiled(w, 'Its own words.');
    const {exitCode, lines} = await request(w, null, {bead: id});
    expect(exitCode).toBe(0);
    expect(descriptionOf(w, id)).toBe('Its own words.');
    expect(lines.some((line) => line.includes('could not be read'))).toBe(true);
  });

  test('a session with no message of his: one line saying so and how it began', async () => {
    needBr();
    const w = world(true);
    const labelled = brUpdate({db: w.db, env: {}}, w.sessionBeadId, {
      addLabels: ['spawn-kickoff', 'spawned-by:t-mayor'],
    });
    expect(labelled.kind).toBe('ok');
    said(w, [{at: ASKED_AT, text: '/conductor Work on t-abc. Read it first.'}]);
    const {exitCode, lines, outcome} = await request(w, 'Build t-abc');
    expect(exitCode).toBe(0);
    const description = descriptionOf(w, filedId(outcome)) ?? '';
    expect(description).toBe(
      `${REQUEST_MESSAGE_HEADING}\n\nNo message of Justin's precedes this request in this session: it was started by session bead t-mayor, from a kickoff.`,
    );
    expect(lines.some((line) => line.includes('no message of Justin'))).toBe(
      true,
    );
  });

  test('a private session: nothing is written to the bead, and the line says why', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const marked = markSessionPrivate(SESSION, w.env);
    expect(marked.kind).toBe('marked');
    const id = handFiled(w, 'Its own words.');
    const {exitCode, lines} = await request(w, null, {bead: id});
    expect(exitCode).toBe(0);
    expect(descriptionOf(w, id)).toBe('Its own words.');
    expect(
      lines.some(
        (line) => line.includes('NOT attached') && line.includes('private'),
      ),
    ).toBe(true);
  });

  test('the log lagging the transcript: nothing attached, and the section and the line say it could not be established', async () => {
    needBr();
    const w = world(true);
    writeLog(w, [{at: '2026-11-18T09:00:00.000Z', text: 'First'}]);
    writeTranscript(w, [
      {at: '2026-11-18T09:00:00.000Z', text: 'First'},
      {at: ASKED_AT, text: ASKED},
    ]);
    const {exitCode, lines, outcome} = await request(w, 'Add a CSV export');
    expect(exitCode).toBe(0);
    const description = descriptionOf(w, filedId(outcome)) ?? '';
    expect(description).toContain(
      "Justin's message could not be established, so nothing was attached",
    );
    expect(description).not.toContain('First');
    expect(
      lines.some((line) => line.includes('could not be established')),
    ).toBe(true);
  });

  test('no transcript: it says the transcript was not found, and attaches nothing', async () => {
    needBr();
    const w = world(true);
    writeLog(w, [{at: ASKED_AT, text: ASKED}]);
    mkdirSync(join(w.transcripts, '-tmp-repo'), {recursive: true});
    const {exitCode, outcome} = await request(w, 'Add a CSV export');
    expect(exitCode).toBe(0);
    const description = descriptionOf(w, filedId(outcome)) ?? '';
    expect(description).toContain('transcript was not found');
    expect(description).not.toContain(ASKED);
  });

  test('a message holding runs of backticks is still verbatim inside a longer fence', async () => {
    needBr();
    const w = world(true);
    const text =
      'Run this:\n```\nbun test\n```\nand `x` and ````five````? No, four.';
    said(w, [{at: ASKED_AT, text}]);
    const {outcome} = await request(w, 'Run the tests');
    const description = descriptionOf(w, filedId(outcome)) ?? '';
    expect(description).toContain(`\`\`\`\`\`\n${text}\n\`\`\`\`\``);
  });

  test('a failed write leaves the request filed and the exit code 0, and prints the failure', async () => {
    needBr();
    const w = world(true);
    said(w, [{at: ASKED_AT, text: ASKED}]);
    const real =
      PINNED_BR.kind === 'pinned' ? PINNED_BR.path : (Bun.which('br') ?? 'br');
    const fakeDir = join(w.sb.path, 'fake-br');
    mkdirSync(fakeDir, {recursive: true});
    const fake = join(fakeDir, 'br');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'for a in "$@"; do case "$a" in --description=*) echo "fake br: description writes refused" >&2; exit 1;; esac; done',
        `exec "${real}" "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${saved ?? ''}`;
    let result: Awaited<ReturnType<typeof request>>;
    try {
      result = await request(w, 'Add a CSV export');
    } finally {
      process.env.PATH = saved;
    }
    expect(result.exitCode).toBe(0);
    const id = filedId(result.outcome);
    expect(descriptionOf(w, id)).toBeNull();
    const line = result.lines.find((entry) => entry.includes('NOT attached'));
    expect(line).toContain('⚠️');
    expect(line).toContain('description writes refused');
    expect(line).toContain(`thread request --bead ${id}`);
  });
});

describe('request-message pieces', () => {
  test('the fence is longer than the longest backtick run', () => {
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('a `````` b')).toBe('```````');
  });

  test('a heading quoted inside a message is not a section', () => {
    const quoted = [
      REQUEST_MESSAGE_HEADING,
      '',
      'Message `aaaaaaaa.1`, sent then.',
      '',
      '````',
      REQUEST_MESSAGE_HEADING,
      '',
      'Message `bbbbbbbb.9`, quoted.',
      '````',
    ].join('\n');
    expect([...sectionKeys(quoted)]).toEqual(['message:aaaaaaaa.1']);
  });

  test('the same words sent again, missing from the log, count as a lag', () => {
    const message = (n: number, text: string) => ({
      at: '2026-11-18T09:00:00.000Z',
      id: `${PREFIX}.${n}`,
      logIndex: n,
      ordinal: n,
      sessionId: SESSION,
      text,
    });
    const log = [message(1, 'yes')];
    expect(
      logLagReason({logMessages: log, transcriptMessages: log}),
    ).toBeNull();
    expect(
      logLagReason({
        logMessages: log,
        transcriptMessages: [message(1, 'yes'), message(2, 'yes')],
      }),
    ).toContain('missed one');
  });
});
