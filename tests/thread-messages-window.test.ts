/**
 * home-base-6ujwi.1: `thread messages --sessions <n>` (D1, D4), private
 * sessions left out and counted (D3), and the `--annotate` reply line that
 * skips a pasted status block (D5).
 *
 * The chain comes from injected readers; the message logs, the private marks,
 * the sessions index and the user config live under a scratch directory named
 * by the env, so nothing here reads the real state dir or ~/.config.
 *
 * The fixture text is generic on purpose: home-base is pushed to GitHub.
 */

import type {
  ChainBead,
  ChainBeadLookup,
  ChainWalkReaders,
} from '../src/thread/chain-walk';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {messageLogPath} from '../src/thread/archive';
import {serializeMessageLine} from '../src/thread/message-log';
import {runThreadMessages} from '../src/thread/messages-command';
import {
  PART_ONE_RULE,
  PART_ONE_SECTION_RULE,
  PART_ONE_SEPARATOR,
} from '../src/thread/part-one';
import {markSessionPrivate} from '../src/thread/privacy';
import {appendSessionSighting} from '../src/thread/session-index';
import {THREADS_STATE_DIR_ENV_VAR} from '../src/thread/status-file';
import {replyPreview} from '../src/thread/transcript-actions';
import {captureWriteStdout} from './capture-stdout';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

function sessionOf(id: string): string {
  return `${id}0000000-test-session`;
}

/** a ← b ← … ← f, fully linked. */
function linkedChain(ids: readonly string[]): ChainBead[] {
  return ids.map((id, index) => ({
    beadsDir: '/fake/.beads',
    id,
    labels: [
      `sid:${sessionOf(id)}`,
      ...(index > 0 ? [`continues:${ids[index - 1] ?? ''}`] : []),
      ...(index < ids.length - 1
        ? [`continued-by:${ids[index + 1] ?? ''}`]
        : []),
    ],
    notes: null,
    title: `title of ${id}`,
  }));
}

function readersOf(beads: readonly ChainBead[]): ChainWalkReaders {
  const byId = new Map(beads.map((entry) => [entry.id, entry]));
  return {
    findContinuing: (beadId) => ({
      ids: beads
        .filter((entry) => entry.labels.includes(`continues:${beadId}`))
        .map((entry) => entry.id),
      kind: 'read',
    }),
    readBead: (beadId): ChainBeadLookup => {
      const found = byId.get(beadId);
      return found == null
        ? {kind: 'notFound', reason: 'not in the fake'}
        : {bead: found, kind: 'found'};
    },
  };
}

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, {force: true, recursive: true});
  }
});

function scratchEnv(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'thread-messages-window-'));
  scratchDirs.push(root);
  return {
    HOME: join(root, 'home'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'transcripts'),
    [THREADS_STATE_DIR_ENV_VAR]: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
}

/** Each session's log: two messages of his, each answered; cwd as given. */
function writeLogs(
  env: Record<string, string>,
  ids: readonly string[],
  cwd: (id: string) => null | string = () => '/work/public-repo',
): void {
  for (const id of ids) {
    const path = messageLogPath(sessionOf(id), env);
    mkdirSync(dirname(path), {recursive: true});
    const lines = [1, 2].flatMap((n) => [
      {
        at: `2026-11-1${IDS.indexOf(id)}T0${n}:00:00.000Z`,
        cwd: cwd(id),
        event: 'backfill' as const,
        role: 'user' as const,
        text: `words of session ${id}, number ${n}`,
      },
      {
        at: `2026-11-1${IDS.indexOf(id)}T0${n}:05:00.000Z`,
        cwd: cwd(id),
        event: 'backfill' as const,
        role: 'assistant' as const,
        text: `reply in ${id}`,
      },
    ]);
    writeFileSync(path, lines.map(serializeMessageLine).join(''));
  }
}

/** The current session's sighting, so the own-chain path finds its bead. */
function recordCurrentSession(env: Record<string, string>, id: string): void {
  const outcome = appendSessionSighting(
    {
      at: '2026-11-18T00:00:00.000Z',
      beadId: id,
      beadsDir: '/fake/.beads',
      branch: 'main',
      checkoutPath: '/work/public-repo',
      event: 'created',
      repo: 'public-repo',
      sessionId: sessionOf(id),
    },
    env,
  );
  if (outcome.kind !== 'appended') throw new Error(outcome.error);
}

interface JsonRun {
  code: number;
  json: {
    counts: {matched: number; messages: number};
    messages: {beadId: string; text: string}[];
    private: {
      beadId: string;
      messages: number;
      name: string;
      reason: string;
    }[];
    problems: string[];
    sessionsRead: string[];
    window: null | {asked: number; endsAt: string; held: number};
  };
  text: string;
}

async function run(
  options: Parameters<typeof runThreadMessages>[0],
): Promise<{code: number; text: string}> {
  const pieces: string[] = [];
  const spy = captureWriteStdout((text) => pieces.push(text));
  try {
    const code = await runThreadMessages({
      color: false,
      width: null,
      ...options,
    });
    return {code, text: pieces.join('\n')};
  } finally {
    spy.mockRestore();
  }
}

async function runJson(
  options: Parameters<typeof runThreadMessages>[0],
): Promise<JsonRun> {
  const result = await run({...options, json: true});
  return {...result, json: JSON.parse(result.text) as JsonRun['json']};
}

// ---------------------------------------------------------------------------
// The window (D1, D4)
// ---------------------------------------------------------------------------

describe('thread messages --sessions (D1)', () => {
  test('from the current session: it and the 2 before it, oldest first, never a later one', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    recordCurrentSession(env, 'e');
    const result = await runJson({
      env: {...env, CLAUDE_CODE_SESSION_ID: sessionOf('e')},
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.code).toBe(0);
    expect(result.json.sessionsRead).toEqual(['c', 'd', 'e']);
    expect(result.json.messages.map((message) => message.text)).toEqual([
      'words of session c, number 1',
      'words of session c, number 2',
      'words of session d, number 1',
      'words of session d, number 2',
      'words of session e, number 1',
      'words of session e, number 2',
    ]);
    expect(result.json.window).toEqual({asked: 3, endsAt: 'e', held: 3});
  });

  test('--chain <bead> --sessions 3: that session and the 2 before it, not the whole chain', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    const result = await runJson({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: '3',
    });
    expect(result.code).toBe(0);
    expect(result.json.sessionsRead).toEqual(['b', 'c', 'd']);
    expect(new Set(result.json.messages.map((m) => m.beadId))).toEqual(
      new Set(['b', 'c', 'd']),
    );
  });

  test('the header says the window', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    const result = await run({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.text).toContain(
      'Window:    3 sessions, ending at d (--sessions 3)',
    );
  });

  test('a chain shorter than n says how many sessions it has', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    const result = await run({
      chain: 'b',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.code).toBe(0);
    expect(result.text).toContain(
      'Window:    2 sessions, ending at b (--sessions 3): the chain has only 2 sessions up to there',
    );
  });

  test('an unreadable log in the window still exits 2 and is named', async () => {
    const env = scratchEnv();
    writeLogs(env, ['a', 'b', 'd', 'e', 'f']);
    const result = await run({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.code).toBe(2);
    expect(result.text).toContain('INCOMPLETE');
    expect(result.text).toContain(
      `has no message log at ${messageLogPath(sessionOf('c'), env)}`,
    );
  });

  test('a value that is not a positive whole number exits 2 with the reason', async () => {
    for (const bad of [0, -1, 2.5, 'three', '']) {
      const result = await runJson({
        chain: 'd',
        env: scratchEnv(),
        readers: readersOf(linkedChain(IDS)),
        sessions: bad,
      });
      expect({bad, code: result.code}).toEqual({bad, code: 2});
      expect(
        String((result.json as unknown as {error: string}).error),
      ).toContain('--sessions takes a positive whole number');
    }
  });

  test('without --sessions the sessions read are as before: --chain reads the whole chain', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    const result = await runJson({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
    });
    expect(result.json.sessionsRead).toEqual(IDS);
    expect(result.json.window).toBeNull();
    expect(result.json.private).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Private sessions (D3)
// ---------------------------------------------------------------------------

describe('private sessions in the window (D3)', () => {
  test('a session marked private: none of its words print, and the output names it and counts them', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    const marked = markSessionPrivate(sessionOf('c'), env);
    expect(marked.kind).toBe('marked');
    const options = {
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    };
    const json = await runJson(options);
    expect(json.code).toBe(0);
    // Still one of the 3: the window is not extended past it.
    expect(json.json.sessionsRead).toEqual(['b', 'c', 'd']);
    expect(json.json.messages.map((message) => message.beadId)).toEqual([
      'b',
      'b',
      'd',
      'd',
    ]);
    expect(json.json.private).toHaveLength(1);
    expect(json.json.private[0]?.beadId).toBe('c');
    expect(json.json.private[0]?.messages).toBe(2);
    expect(json.json.private[0]?.reason).toContain('was marked private');
    expect(json.json.counts.messages).toBe(4);

    const text = await run(options);
    expect(text.text).not.toContain('words of session c');
    expect(text.text).toContain('🔒 PRIVATE');
    expect(text.text).toContain('c: 2 messages of his left out.');
    expect(text.text).toContain('Private:   1 session, 2 messages of his');
  });

  test('a private session is never searched: a query matching only its words finds nothing and says so', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    markSessionPrivate(sessionOf('c'), env);
    const result = await run({
      chain: 'd',
      env,
      query: 'session c',
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.code).toBe(1);
    expect(result.text).not.toContain('words of session c');
    expect(result.text).toContain(
      'No message of his matches outside the private sessions named above',
    );
  });

  test('privacy that cannot be established counts as private, with its reason', async () => {
    const env = scratchEnv();
    // Session c's log records no working directory, so privacy.ts cannot tell.
    writeLogs(env, IDS, (id) => (id === 'c' ? null : '/work/public-repo'));
    const result = await runJson({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.json.private.map((entry) => entry.beadId)).toEqual(['c']);
    expect(result.json.private[0]?.reason).toContain(
      'working directory of session',
    );
    expect(result.json.private[0]?.reason).toContain('is unknown');
    expect(result.json.messages.some((m) => m.beadId === 'c')).toBe(false);
  });

  test('a session in a repo the user config lists as private is left out too', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS, (id) =>
      id === 'b' ? '/work/secret-repo/sub' : '/work/public-repo',
    );
    const config = join(env.XDG_CONFIG_HOME ?? '', 'justin-sdk', 'config.json');
    mkdirSync(dirname(config), {recursive: true});
    writeFileSync(
      config,
      JSON.stringify({
        componentConfig: {thread: {privateRepos: ['/work/secret-repo']}},
      }),
    );
    const result = await runJson({
      chain: 'd',
      env,
      readers: readersOf(linkedChain(IDS)),
      sessions: 3,
    });
    expect(result.json.private.map((entry) => entry.beadId)).toEqual(['b']);
    expect(result.json.private[0]?.reason).toContain(
      'componentConfig.thread.privateRepos',
    );
    expect(result.json.messages.map((message) => message.beadId)).toEqual([
      'c',
      'c',
      'd',
      'd',
    ]);
  });

  test('--context refuses a message of a private session', async () => {
    const env = scratchEnv();
    writeLogs(env, IDS);
    recordCurrentSession(env, 'c');
    markSessionPrivate(sessionOf('c'), env);
    const result = await run({
      context: 'c0000000.1',
      env,
      json: true,
      readers: readersOf(linkedChain(IDS)),
    });
    expect(result.code).toBe(2);
    expect(result.text).not.toContain('words of session c');
    expect(result.text).toContain('counts as private');
  });
});

// ---------------------------------------------------------------------------
// The annotate reply line (D5)
// ---------------------------------------------------------------------------

/** A Part 1 as `thread status` pastes it, optionally with Claude's message in it. */
function partOne(fromClaude: null | string): string {
  return [
    PART_ONE_RULE,
    '',
    '**Session:** [MAYOR][Moe-3] A test session',
    '',
    PART_ONE_SECTION_RULE,
    '',
    '- **Status:** Open work',
    '',
    PART_ONE_SECTION_RULE,
    '',
    '## Questions for you',
    '',
    '1. 🟡 P2 [Q131] A question',
    ...(fromClaude == null
      ? []
      : ['', PART_ONE_SECTION_RULE, '', '## From Claude', '', fromClaude]),
    '',
    PART_ONE_SECTION_RULE,
    '',
    '- **Repo:** test-repo',
    '* **Resume:** `claude --resume x`',
    '',
    PART_ONE_SEPARATOR,
  ].join('\n');
}

describe('the --annotate reply line (D5)', () => {
  test("a block with Claude's message in it shows that message, never the block", () => {
    const message = '## Answers\n\n- **Your question:** answered here.';
    const preview = replyPreview(partOne(message));
    expect(preview).toEqual({
      kind: 'text',
      text: '## Answers - **Your question:** answered here.',
    });
  });

  test('a block with words after it shows the words after it', () => {
    const preview = replyPreview(
      `${partOne(null)}\n\nI did the thing you asked for.`,
    );
    expect(preview).toEqual({
      kind: 'text',
      text: 'I did the thing you asked for.',
    });
  });

  test('a reply that is only the block says so', () => {
    expect(replyPreview(partOne(null))).toEqual({kind: 'blockOnly'});
  });

  test('a legacy report, closed by its line of 🕉, is only the block too', () => {
    const legacy = [
      '🛑'.repeat(28),
      '',
      '**Stop reason:** ✅ Work completed',
      '**What I did:** things',
      '🕉️'.repeat(29),
    ].join('\n');
    expect(replyPreview(legacy)).toEqual({kind: 'blockOnly'});
  });

  test('a handoff summary is a real reply and is shown as it is', () => {
    const summary =
      '🤝 **Handed off**\n\n- **Chain:** Moe\n- **This session:** #3';
    expect(replyPreview(summary)).toEqual({
      kind: 'text',
      text: '🤝 **Handed off** - **Chain:** Moe - **This session:** #3',
    });
  });

  test('a lone 🛑 line used for emphasis is not a block and stays', () => {
    const text = `${PART_ONE_RULE}\nStop: this is not a report.`;
    expect(replyPreview(text)).toEqual({
      kind: 'text',
      text: `${PART_ONE_RULE} Stop: this is not a report.`,
    });
  });
});
