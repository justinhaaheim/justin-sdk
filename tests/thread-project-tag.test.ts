/**
 * home-base-bomy5.7.1: each repo declares a short `projectTag` in its own
 * justin-sdk.config.json, and every session name says "[TAG] <title>".
 *
 * Four fixture repos, each with one tracked session, read through ONE inbox
 * whose caller sits in the HOME repo:
 *   home-base        projectTag "HOME"        → [HOME]
 *   audio-journal-1  projectTag "AJ"          → [AJ]   (plus an untracked session)
 *   plain            no projectTag            → [PLAIN]
 *   broken           projectTag "home base!"  → [BROKEN], and a config problem
 */
import type {InboxRead} from '../src/thread/session-inbox';
import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, utimesSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {resolveRepoTag, resolveThreadConfig} from '../src/thread/config';
import {serializeMessageLine} from '../src/thread/message-log';
import {partOneView, renderPartOne} from '../src/thread/part-one';
import {ensureSessionBead} from '../src/thread/session-bead';
import {unreadableAction} from '../src/thread/session-card';
import {handoffBlock} from '../src/thread/session-handoff';
import {inboxJson, readInbox, renderInbox} from '../src/thread/session-inbox';
import {untrackedLine} from '../src/thread/session-untracked';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TZ = 'UTC';
const AT = '2030-01-01T10:00:00.000Z';

let sb: Sandbox;
let env: Record<string, string | undefined>;
const repos: Record<string, string> = {};
const ids: Record<string, string> = {};
const beads: Record<string, string> = {};
const UNTRACKED = '1b0c0000-1111-4222-8333-0000000000ff';

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, text);
}

function transcript(id: string, cwd: string, text: string): void {
  const path = join(
    sb.path,
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${id}.jsonl`,
  );
  writeFile(
    path,
    [
      {
        cwd,
        entrypoint: 'cli',
        message: {content: text, role: 'user'},
        sessionId: id,
        timestamp: AT,
        type: 'user',
        uuid: `${id}-u`,
      },
      {
        cwd,
        message: {
          role: 'assistant',
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1000,
            input_tokens: 10,
          },
        },
        sessionId: id,
        timestamp: AT,
        type: 'assistant',
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  // The scan windows by file time, so date it at NOW like its records.
  utimesSync(path, NOW, NOW);
}

/** A session bead, a message log and a transcript for one session in `repo`. */
function trackedSession(n: number, repo: string, title: string): void {
  const id = `1b0c0000-1111-4222-8333-${String(n).padStart(12, '0')}`;
  const filed = ensureSessionBead({
    cwd: repo,
    env: {...env, CLAUDE_CODE_SESSION_ID: id},
    firstPrompt: {at: AT, text: title},
    now: new Date(AT),
    sessionId: id,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  ids[title] = id;
  beads[title] = filed.beadId;
  writeFile(
    messageLogPath(id, env),
    serializeMessageLine({
      at: AT,
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text: title,
    }),
  );
  transcript(id, repo, title);
}

const CONFIGS: Record<string, object | null> = {
  'audio-journal-1': {projectTag: 'AJ'},
  broken: {projectTag: 'home base!'},
  'home-base': {projectTag: 'HOME'},
  plain: null,
};

const TITLES: Record<string, string> = {
  'audio-journal-1': 'Sort the voice memos',
  broken: 'Fix the broken tag',
  'home-base': 'Fix the login bug',
  plain: 'Tidy the plain repo',
};

beforeAll(() => {
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
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  let n = 0;
  for (const [name, config] of Object.entries(CONFIGS)) {
    const files: Record<string, string> = {'README.md': `# ${name}\n`};
    if (config != null) {
      files['justin-sdk.config.json'] = `${JSON.stringify(config)}\n`;
    }
    const repo = initRepo(sb, name, files);
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);
    repos[name] = repo;
    n += 1;
    trackedSession(n, repo, TITLES[name] ?? name);
  }
  // A session in the AJ repo with no session bead: the ❔ Not tracked kind.
  transcript(UNTRACKED, repos['audio-journal-1'] ?? '', 'Export the memos');
});

afterAll(() => {
  sb.cleanup();
});

/** The inbox as the HOME repo's caller reads it. */
async function read(): Promise<InboxRead> {
  const result = await readInbox({
    cwd: repos['home-base'] ?? '',
    days: 30,
    devRoot: sb.path,
    env,
    now: NOW,
    repo: null,
  });
  if (result.kind !== 'read') throw new Error(result.reason);
  return result.read;
}

function rowOf(r: InboxRead, sessionId: string) {
  const row = r.rows.find((candidate) => candidate.sessionId === sessionId);
  if (row == null) throw new Error(`no row for ${sessionId}`);
  return row;
}

describe('projectTag resolution (home-base-bomy5.7.1)', () => {
  test('valid → the tag; absent → the folder uppercased; invalid → the folder uppercased AND a named problem', () => {
    const tagOf = (name: string): string =>
      resolveRepoTag({checkout: repos[name] ?? null, env, repo: name});
    expect(tagOf('home-base')).toBe('HOME');
    expect(tagOf('audio-journal-1')).toBe('AJ');
    expect(tagOf('plain')).toBe('PLAIN');
    expect(tagOf('broken')).toBe('BROKEN');

    const plain = resolveThreadConfig({cwd: repos.plain, env});
    expect(plain.projectTag).toBeNull();
    expect(plain.problems).toEqual([]);

    const broken = resolveThreadConfig({cwd: repos.broken, env});
    expect(broken.projectTag).toBeNull();
    expect(broken.problems).toHaveLength(1);
    expect(broken.problems[0]).toContain('projectTag');
    expect(broken.problems[0]).toContain('"home base!"');
    // The bad tag costs only the tag: the file's other settings still apply.
    expect(broken.enabled).toBe(true);
  });

  test('a user-level projectTag is ignored: the tag is per repo', () => {
    const xdg = join(sb.path, 'xdg-user-tag');
    writeFile(
      join(xdg, 'justin-sdk', 'config.json'),
      JSON.stringify({projectTag: 'USER'}),
    );
    expect(
      resolveRepoTag({
        checkout: repos.plain ?? null,
        env: {...env, XDG_CONFIG_HOME: xdg},
        repo: 'plain',
      }),
    ).toBe('PLAIN');
  });

  test('a checkout that is gone falls back to the folder name; an unknown repo has no tag', () => {
    expect(
      resolveRepoTag({checkout: join(sb.path, 'nowhere'), env, repo: 'gone'}),
    ).toBe('GONE');
    expect(resolveRepoTag({checkout: null, env, repo: null})).toBeNull();
  });
});

describe('the dashboard shows each session its OWN repo tag (AC 2)', () => {
  test('thread inbox --json: card.repoTag and model.repoTag per repo; card.repo stays the folder', async () => {
    const json = inboxJson(await read());
    const byId = new Map(json.sessions.map((s) => [s.sessionId, s]));
    for (const [name, want] of [
      ['home-base', 'HOME'],
      ['audio-journal-1', 'AJ'],
      ['plain', 'PLAIN'],
      ['broken', 'BROKEN'],
    ] as const) {
      const s = byId.get(ids[TITLES[name] ?? ''] ?? '');
      expect({name, repo: s?.card.repo, tag: s?.card.repoTag}).toEqual({
        name,
        repo: name,
        tag: want,
      });
      expect(s?.model?.repoTag).toBe(want);
    }
    expect(byId.get(UNTRACKED)?.card.repoTag).toBe('AJ');
  });

  test('the printed inbox heads each card "[TAG] <title>"', async () => {
    const text = renderInbox(await read(), {
      all: true,
      days: 30,
      now: NOW,
      order: 'recent',
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    expect(text).toContain('[HOME] Fix the login bug');
    expect(text).toContain('[AJ] Sort the voice memos');
    expect(text).toContain('[PLAIN] Tidy the plain repo');
    expect(text).toContain('[BROKEN] Fix the broken tag');
    expect(text).not.toContain('[HOME-BASE]');
    expect(text).not.toContain('[AUDIO-JOURNAL-1]');
  });

  test('the untracked one-liner says "[AJ] <his first message>"', async () => {
    const row = rowOf(await read(), UNTRACKED);
    expect(untrackedLine(row.card, 'Export the memos')).toStartWith(
      '❔ [AJ] Export the memos',
    );
  });
});

describe('Part 1 and the handoff block (AC 1)', () => {
  test('Part 1 Session line: [HOME], [AJ], [PLAIN], [BROKEN]', async () => {
    const r = await read();
    for (const [name, want] of [
      ['home-base', '[HOME] Fix the login bug'],
      ['audio-journal-1', '[AJ] Sort the voice memos'],
      ['plain', '[PLAIN] Tidy the plain repo'],
      ['broken', '[BROKEN] Fix the broken tag'],
    ] as const) {
      const row = rowOf(r, ids[TITLES[name] ?? ''] ?? '');
      if (row.loaded == null) throw new Error(`${name} did not load`);
      const text = renderPartOne(
        partOneView({
          // Only the Session line is checked; the action line is a stand-in.
          action: unreadableAction('not checked here'),
          counts: row.loaded.counts,
          model: row.loaded.model,
          now: NOW,
          optional: null,
          status: row.loaded.status,
          timeZone: TZ,
        }),
        PLAIN_STYLE,
      );
      const session = text
        .split('\n')
        .find((line) => line.includes('Session:'));
      expect({name, session}).toEqual({
        name,
        session: expect.stringContaining(want) as string,
      });
    }
  });

  test('the handoff block names the session "[AJ] <title>", called from the HOME repo', async () => {
    const title = TITLES['audio-journal-1'] ?? '';
    const block = await handoffBlock({
      cwd: repos['audio-journal-1'] ?? '',
      env,
      note: null,
      now: NOW,
      sessionBeadId: beads[title] ?? '',
      sessionId: ids[title] ?? '',
      timeZone: TZ,
    });
    if (!block.ok) throw new Error(block.reason);
    expect(block.text).toContain(
      `- **Session:** [AJ] ${title} (${beads[title] ?? ''})`,
    );
  });
});
