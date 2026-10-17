/**
 * `thread inbox` with componentConfig.thread.sessionBeads on
 * (home-base-vzwbj.4.4 design item 1): every indexed session in the window,
 * in sections, grouped by repo, newest first, never dropping one it cannot
 * read. Real br and git in $TMPDIR; `needBr()` throws when br is missing.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.4's notes.
 */

import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brClose, brUpdate, runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {handOff} from '../src/thread/session-handoff';
import {
  inboxJson,
  type InboxOrder,
  type InboxRead,
  readInbox,
  renderInbox,
} from '../src/thread/session-inbox';
import {loadSession} from '../src/thread/session-model';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TZ = 'UTC';

function sid(n: number): string {
  return `1b0c0000-1111-4222-8333-${String(n).padStart(12, '0')}`;
}

let sb: Sandbox;
let env: Record<string, string | undefined>;
let alpha: string;
let beta: string;
let gone: string;
const beads: Record<string, string> = {};

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, text);
}

/**
 * A session bead, a message log and a transcript for session `n` in `repo`;
 * `world` defaults to this file's shared one, `between` goes between the
 * transcript's two records.
 */
function session(
  n: number,
  repo: string,
  title: string,
  times: {log: string; record: string},
  world: {env: Record<string, string | undefined>; root: string} | null = null,
  between: object[] = [],
): string {
  const id = sid(n);
  const w = world ?? {env, root: sb.path};
  const filed = ensureSessionBead({
    cwd: repo,
    env: {...w.env, CLAUDE_CODE_SESSION_ID: id},
    firstPrompt: {at: times.log, text: title},
    now: new Date(times.log),
    sessionId: id,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  beads[id] = filed.beadId;
  writeFile(
    messageLogPath(id, w.env),
    [
      serializeMessageLine({
        at: times.log,
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        text: title,
      }),
      serializeMessageLine({
        at: times.log,
        cwd: repo,
        event: 'Stop',
        role: 'assistant',
        text: 'Here is what I found.',
      }),
    ].join(''),
  );
  writeFile(
    join(w.root, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`),
    [
      {
        cwd: repo,
        message: {content: 'hi', role: 'user'},
        sessionId: id,
        timestamp: times.log,
        type: 'user',
      },
      ...between,
      {
        cwd: repo,
        message: {
          role: 'assistant',
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1000,
            input_tokens: 10,
          },
        },
        sessionId: id,
        timestamp: times.record,
        type: 'assistant',
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n'),
  );
  return id;
}

/** The request filed for each session by `request()` (the last one). */
const requestIds: Record<string, string> = {};
function requestOf(sessionId: string): string {
  return requestIds[sessionId] ?? '(no request filed)';
}

async function request(id: string, repo: string, title: string) {
  const filed = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env,
    here: false,
    now: NOW,
    sessionId: id,
    title,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  requestIds[id] = filed.id;
  return filed.id;
}

const t = (hhmm: string): string => `2030-01-01T${hhmm}:00.000Z`;

beforeAll(async () => {
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
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  alpha = initRepo(sb, 'alpha', {'README.md': '# a\n'});
  beta = initRepo(sb, 'beta', {'README.md': '# b\n'});
  gone = initRepo(sb, 'gone', {'README.md': '# g\n'});
  for (const repo of [alpha, beta, gone]) {
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);
  }

  // 1 waiting on you (an open P0) — alpha
  const s1 = session(1, alpha, 'Pick the export bucket', {
    log: t('10:00'),
    record: t('10:05'),
  });
  const r1 = await request(s1, alpha, 'Write the export runbook');
  const asked = await fileAsk({
    approve: false,
    context: [],
    cwd: alpha,
    default: null,
    do: false,
    env,
    header: null,
    options: ['prod: the cron bucket', 'archive: the old one'],
    priority: '0',
    question: 'Which bucket?',
    recommend: 'a',
    sessionId: s1,
    to: r1,
  });
  if (asked.kind !== 'filed') throw new Error(asked.kind);
  // 2 open work (a request in progress) — alpha, OLDER than 1
  const s2 = session(2, alpha, 'Speed up the importer', {
    log: t('08:00'),
    record: t('08:30'),
  });
  await request(s2, alpha, 'Speed up the importer');
  // 3 working (last record a minute ago) — beta
  const s3 = session(3, beta, 'Refactor the parser', {
    log: t('11:00'),
    record: t('11:59'),
  });
  await request(s3, beta, 'Refactor the parser');
  // 4 handed off — beta
  const s4 = session(4, beta, 'Migrate the orders table', {
    log: t('07:00'),
    record: t('07:30'),
  });
  await request(s4, beta, 'Migrate the orders table');
  const handed = await handOff({
    cwd: beta,
    env,
    note: 'half done',
    now: NOW,
    sessionId: s4,
    to: null,
  });
  if (handed.kind !== 'handedOff') throw new Error(JSON.stringify(handed));
  // 5 answered (a question, no request, no commit, clean tree) — alpha
  session(5, alpha, 'What does the importer do with blank rows?', {
    log: t('09:00'),
    record: t('09:02'),
  });
  // 6 done (its only request closed) — alpha
  const s6 = session(6, alpha, 'Fix the date parser', {
    log: t('06:00'),
    record: t('06:30'),
  });
  const r6 = await request(s6, alpha, 'Fix the date parser');
  if (brClose({cwd: alpha}, r6, 'fixed').kind !== 'ok')
    throw new Error('close');
  // 7 archived by Justin — beta
  const s7 = session(7, beta, 'Try the new linter', {
    log: t('05:00'),
    record: t('05:10'),
  });
  if (
    brClose({cwd: beta}, beads[s7] ?? '', 'archived: not worth it').kind !==
    'ok'
  ) {
    throw new Error('archive');
  }
  // 8 its checkout is gone — gone
  session(8, gone, 'Clean up the cron entries', {
    log: t('04:00'),
    record: t('04:10'),
  });
  rmSync(gone, {force: true, recursive: true});
  // 9 outside the 30-day window — alpha
  session(9, alpha, 'An old question', {
    log: '2029-11-01T09:00:00.000Z',
    record: '2029-11-01T09:05:00.000Z',
  });
});

afterAll(() => {
  sb.cleanup();
});

async function read(
  options: {days?: number; repo?: string | null} = {},
): Promise<InboxRead> {
  const result = await readInbox({
    cwd: alpha,
    days: options.days ?? 30,
    env,
    now: NOW,
    repo: options.repo ?? null,
  });
  if (result.kind !== 'read') throw new Error(result.reason);
  return result.read;
}

function render(
  r: InboxRead,
  options: {all?: boolean; order?: InboxOrder} = {},
): string {
  return renderInbox(r, {
    all: options.all ?? false,
    days: 30,
    now: NOW,
    order: options.order ?? 'recent',
    style: PLAIN_STYLE,
    timeZone: TZ,
  })
    .split(sb.path)
    .join('<sandbox>');
}

function sectionOfTitle(r: InboxRead, title: string): string | null {
  return r.rows.find((row) => row.title === title)?.section ?? null;
}

/** The card headings of a rendering, in order. */
function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\*\*.+\*\*(?: \(.+\))?$/u.test(line));
}

describe('thread inbox: sections (j8q3e.1 D5)', () => {
  test('every session in the window is in the section its D3 rule gives; the one outside the window is not listed', async () => {
    const r = await read();
    expect(r.rows).toHaveLength(8);
    expect({
      answered: sectionOfTitle(r, 'What does the importer do with blank rows?'),
      archived: sectionOfTitle(r, 'Try the new linter'),
      done: sectionOfTitle(r, 'Fix the date parser'),
      gone: r.rows.find((row) => row.sessionId === sid(8))?.section,
      handedOff: sectionOfTitle(r, 'Migrate the orders table'),
      openWork: sectionOfTitle(r, 'Speed up the importer'),
      waiting: sectionOfTitle(r, 'Write the export runbook'),
      working: sectionOfTitle(r, 'Refactor the parser'),
    }).toEqual({
      answered: 'answered',
      archived: 'archived',
      done: 'done',
      gone: 'checkByHand',
      handedOff: 'handedOff',
      openWork: 'stoppedOpen',
      waiting: 'needsYou',
      working: 'working',
    });
    expect(r.rows.some((row) => row.title === 'An old question')).toBe(false);
    expect((await read({days: 90})).rows).toHaveLength(9);
  });

  test('the summary comes first: one line per non-empty section, in D5 order', async () => {
    const text = render(await read());
    expect(text).toContain(
      [
        '## 📊 Summary',
        '',
        '- **🛑 Needs you:** 1',
        '- **⚠️ Stopped with work open:** 1',
        '- **❔ Check by hand:** 1',
        '- **🏃 Working:** 1',
        '- **🤝 Handed off or out of context:** 1',
        '- **💬 Answered:** 1',
        // j8q3e.7 D8: this test runs no pane lookup.
        '- **🪟 Open panes with no request record:** unknown (the pane lookup was not run)',
        '',
        '## 🕒 Sessions, newest first',
      ].join('\n'),
    );
  });

  test('by default ONE list, newest last activity first, each card naming its section; Done and Archived only with --all', async () => {
    const r = await read();
    const text = render(r);
    expect(headings(text)).toEqual([
      '**🏃 [BETA] Refactor the parser** (1 minute ago)',
      '**🛑 [ALPHA] Write the export runbook** (1 hour ago)',
      '**💬 [ALPHA] What does the importer do with blank rows?** (2 hours ago)',
      '**⚠️ [ALPHA] Speed up the importer** (3 hours ago)',
      '**🤝 [BETA] Migrate the orders table** (4 hours ago)',
      // Its beads went with its checkout, so the title is unknown too.
      '**❔ [GONE] ⚠️ title unknown (the session bead could not be read)** (7 hours ago)',
    ]);
    expect(text).toContain('- **Section:** 🏃 Working');
    expect(text).toContain(
      '2 sessions are done or archived and hidden; --all shows them.',
    );
    const all = headings(render(r, {all: true}));
    expect(all).toContain('**✅ [ALPHA] Fix the date parser** (5 hours ago)');
    expect(all).toContain('**✅ [BETA] Try the new linter** (6 hours ago)');
  });

  test('--by-status prints the sections in D5 order; Done and Archived only with --all', async () => {
    const r = await read();
    const headers = render(r, {order: 'status'})
      .split('\n')
      .filter((line) => line.startsWith('## ') && !line.includes('Summary'));
    expect(headers).toEqual([
      '## 🛑 Needs you (1)',
      '## ⚠️ Stopped with work open (1)',
      '## ❔ Check by hand (1)',
      '## 🏃 Working (1)',
      '## 🤝 Handed off or out of context (1)',
      '## 💬 Answered (1)',
    ]);
    const all = render(r, {all: true, order: 'status'})
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(all.slice(-2)).toEqual(['## ✅ Done (1)', '## 🗄️ Archived (1)']);
  });

  test('--by-repo groups by repo (the newest group first), newest session first inside', async () => {
    const text = render(await read(), {order: 'repo'});
    const groups = text
      .split('\n')
      .filter((line) => line.startsWith('## ') && !line.includes('Summary'));
    expect(groups).toEqual([
      '## 📁 beta (2)',
      '## 📁 alpha (3)',
      '## 📁 gone (1)',
    ]);
    const alphaGroup = text.slice(
      text.indexOf('## 📁 alpha'),
      text.indexOf('## 📁 gone'),
    );
    expect(headings(alphaGroup)).toEqual([
      '**🛑 [ALPHA] Write the export runbook** (1 hour ago)',
      '**💬 [ALPHA] What does the importer do with blank rows?** (2 hours ago)',
      '**⚠️ [ALPHA] Speed up the importer** (3 hours ago)',
    ]);
  });

  test('each card is D2: You asked, Where it is, ONE You need to line, Resume', async () => {
    const text = render(await read());
    const s1 = beads[sid(1)] ?? '';
    const s5 = beads[sid(5)] ?? '';
    expect(text).toContain(
      [
        '**🛑 [ALPHA] Write the export runbook** (1 hour ago)',
        '',
        '- **Section:** 🛑 Needs you',
        '- **You asked:**',
        '  - 🛑 Write the export runbook',
        '- **Where it is:** 🛑 Waiting on you (1 blocking question)',
        `- **You need to:** **Answer: Which bucket?** \`bun run justin-sdk thread answer ${s1}\``,
        `- **Resume:** \`claude --resume ${sid(1)}\``,
      ].join('\n'),
    );
    expect(text).toContain(
      [
        '- **Section:** 💬 Answered',
        '- **You asked:** (no request filed) "What does the importer do with blank rows?"',
        '- **Where it is:** 💬 Answered',
        `- **You need to:** **Nothing. Read the answer if you have not:** \`bun run justin-sdk thread show ${s5}\``,
      ].join('\n'),
    );
    expect(text).toContain(
      '- **You need to:** **Claude stopped with 1 of 1 request unfinished and no question for you. Resume it and say continue.**',
    );
    // Exactly one "You need to" line per card.
    expect(text.split('- **You need to:**').length - 1).toBe(
      headings(text).length,
    );
  });
});

describe('thread inbox: never drops what it cannot read', () => {
  test('the session whose checkout is gone is a ❔ card under Check by hand, rule 10, with the path', async () => {
    const r = await read();
    const row = r.rows.find((entry) => entry.sessionId === sid(8));
    expect(row?.section).toBe('checkByHand');
    expect(row?.card.action.rule).toBe(10);
    expect(row?.unreadable).toContain(`${gone} no longer exists`);
    const text = render(r);
    expect(text).toContain(
      '  - **Checkout:** ⚠️ <sandbox>/gone no longer exists',
    );
    expect(text).toContain(
      '- **You need to:** **Check it by hand: checkout unreadable: <sandbox>/gone no longer exists; <sandbox>/gone/.beads/issues.jsonl does not exist**',
    );
    // What he asked is unknown, but his first message still says what it was.
    expect(text).toContain(
      '- **You asked:** ⚠️ unknown (<sandbox>/gone/.beads/issues.jsonl does not exist); your first message: "Clean up the cron entries"',
    );
    expect(text).toContain(`claude --resume ${sid(8)}`);
  });
});

describe('thread inbox: --repo and --json', () => {
  test('--repo keeps one repo (by name or checkout path)', async () => {
    const byName = await read({repo: 'beta'});
    expect(new Set(byName.rows.map((row) => row.repo))).toEqual(
      new Set(['beta']),
    );
    expect(byName.rows).toHaveLength(3);
    const byPath = await read({repo: alpha});
    expect(new Set(byPath.rows.map((row) => row.repo))).toEqual(
      new Set(['alpha']),
    );
  });

  test('--json emits one record per session with its card (requests, stage, action and rule, section), git facts, status and model (log summarised)', async () => {
    const json = inboxJson(await read()) as {
      sessions: {
        action: {command: string | null; rule: number; text: string};
        card: {
          section: string;
          sectionTitle: string;
          youAsked: {kind: string; requests?: unknown[]};
        };
        git: unknown;
        model: {log: unknown} | null;
        section: string;
        sessionId: string;
        status: {kind: string} | null;
      }[];
      summary: {count: number; key: string}[];
    };
    expect(json.sessions).toHaveLength(8);
    const first = json.sessions[0];
    expect(first?.sessionId).toBe(sid(3));
    expect(first?.status?.kind).toBe('working');
    expect(first?.section).toBe('working');
    expect(first?.action).toEqual({
      command: null,
      rule: 2,
      text: 'Nothing yet. Claude is working.',
    });
    expect(first?.card.sectionTitle).toBe('Working');
    expect(first?.card.youAsked.requests).toEqual([
      {
        icon: '🔲',
        id: first?.sessionId == null ? '' : requestOf(first.sessionId),
        nextStage: null,
        stage: null,
        state: 'open',
        title: 'Refactor the parser',
      },
    ]);
    expect(first?.git).toEqual({
      aheadOfDefault: {ok: true, value: 0},
      branch: {ok: true, value: 'main'},
      defaultBranch: {ok: true, value: 'main'},
      merged: {ok: true, value: 'isDefault'},
      uncommitted: {ok: true, value: 0},
      unpushed: {ok: true, value: {kind: 'noUpstream'}},
    });
    expect(first?.model?.log).toEqual({kind: 'read', lines: 2});
    // Every section of the summary, Done and Archived included.
    expect(json.summary.map((entry) => entry.key)).toEqual([
      'needsYou',
      'stoppedOpen',
      'checkByHand',
      'working',
      'handedOff',
      'answered',
      'done',
      'archived',
    ]);
  });
});

// R5 (home-base-vzwbj.4.9): the window must never hide a session that is
// waiting on Justin. Runs LAST: it adds session 10 to the shared fixture.
describe('thread inbox: the window never hides a waiting session (R5)', () => {
  test('a 40-day-old open P0 is listed under Needs you with --days 30, and the hidden-count line names what the window did hide', async () => {
    const s10 = session(10, alpha, 'An old blocking question', {
      log: '2029-11-22T09:00:00.000Z',
      record: '2029-11-22T09:05:00.000Z',
    });
    const r10 = await request(s10, alpha, 'Ship the old thing');
    const asked = await fileAsk({
      approve: false,
      context: [],
      cwd: alpha,
      default: null,
      do: false,
      env,
      header: null,
      options: [],
      priority: '0',
      question: 'Still want the old thing?',
      recommend: null,
      sessionId: s10,
      to: r10,
    });
    if (asked.kind !== 'filed') throw new Error(asked.kind);

    const r = await read({days: 30});
    const row = r.rows.find((entry) => entry.sessionId === s10);
    expect(row?.section).toBe('needsYou');
    // Session 9 ("An old question", 💬 answered, 61 days old) is the one the
    // window hid — counted, not silently dropped.
    expect(r.rows.some((entry) => entry.sessionId === sid(9))).toBe(false);
    expect(r.hiddenByAge).toEqual({answered: 1});
    const text = render(r);
    expect(text).toContain(
      '1 older session hidden (no activity in the last 30 days; --days): 1 💬 answered.',
    );
    expect(text).toContain('- **🛑 Needs you:** 2');
  });
});

// ---------------------------------------------------------------------------
// j8q3e.1 D4 (amended 2026-10-15): landing stages per repo — the bead's AC 3
// ---------------------------------------------------------------------------

describe('thread inbox: landing stages per repo (D4, D3 rule 7)', () => {
  test('a closed, merged request staged code-done and tested: an app repo says build the app, home-base says try it; with no stage, both are Done', async () => {
    const own = createSandbox();
    try {
      const xdg = join(own.path, 'xdg');
      writeFile(
        join(xdg, 'justin-sdk', 'config.json'),
        JSON.stringify({
          componentConfig: {thread: {enabled: true, sessionBeads: true}},
        }),
      );
      const ownEnv = {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        JUSTIN_THREADS_STATE_DIR: join(own.path, 'state'),
        JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(own.path, 'projects'),
        XDG_CONFIG_HOME: xdg,
      };
      const world = {env: ownEnv, root: own.path};
      const app = initRepo(own, 'app', {'README.md': '# app\n'});
      // home-base's own ladder, committed, as justin-sdk.config.json sets it.
      const homeBase = initRepo(own, 'home-base', {
        'README.md': '# hb\n',
        'justin-sdk.config.json': `${JSON.stringify({componentConfig: {thread: {stages: ['code-done', 'tested', 'approved']}}}, null, 2)}\n`,
      });
      for (const repo of [app, homeBase]) {
        const init = runBr(repo, ['init', '--prefix', 't', '-q']);
        if (!init.ok) throw new Error(init.reason ?? 'br init');
      }
      const finished = async (
        n: number,
        repo: string,
        title: string,
        stages: string[],
      ): Promise<string> => {
        const id = session(
          n,
          repo,
          title,
          {log: t('10:00'), record: t('10:05')},
          world,
        );
        const filed = await fileRequest({
          bead: null,
          cwd: repo,
          doneWhen: null,
          env: ownEnv,
          here: false,
          now: NOW,
          sessionId: id,
          title,
        });
        if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
        if (stages.length > 0) {
          const staged = brUpdate({cwd: repo}, filed.id, {
            addLabels: stages.map((stage) => `stage:${stage}`),
          });
          if (staged.kind === 'failed') throw new Error('stage');
        }
        if (brClose({cwd: repo}, filed.id, 'done').kind !== 'ok') {
          throw new Error('close');
        }
        return id;
      };
      const appBuild = await finished(31, app, 'Add the CSV export', [
        'code-done',
        'tested',
      ]);
      const hbBuild = await finished(32, homeBase, 'Add the CSV export', [
        'code-done',
        'tested',
      ]);
      const appLook = await finished(
        33,
        app,
        'Find why the export is slow',
        [],
      );
      const hbLook = await finished(
        34,
        homeBase,
        'Find why the export is slow',
        [],
      );
      const result = await readInbox({
        cwd: app,
        days: 30,
        env: ownEnv,
        now: NOW,
        repo: null,
      });
      if (result.kind !== 'read') throw new Error(result.reason);
      const row = (id: string) =>
        result.read.rows.find((entry) => entry.sessionId === id);
      for (const id of [appBuild, hbBuild, appLook, hbLook]) {
        // D4: rule 7 never changes the derived status.
        expect(row(id)?.loaded?.status.kind).toBe('done');
      }
      expect(row(appBuild)?.section).toBe('toLand');
      const asked = row(appBuild)?.card.youAsked;
      const requestId =
        asked?.kind === 'requests' ? (asked.requests[0]?.id ?? '?') : '?';
      expect(row(appBuild)?.card.action).toEqual({
        command: `bun run justin-sdk thread stage ${requestId} built --session ${appBuild}`,
        rule: 7,
        text: 'Land it: build the app, then mark it built:',
      });
      expect(row(hbBuild)?.section).toBe('toLand');
      expect(row(hbBuild)?.card.action.text).toBe(
        'Try it, then mark it approved:',
      );
      expect(row(appLook)?.section).toBe('done');
      expect(row(hbLook)?.section).toBe('done');
      const text = renderInbox(result.read, {
        all: false,
        days: 30,
        now: NOW,
        order: 'status',
        style: PLAIN_STYLE,
        timeZone: TZ,
      });
      expect(text).toContain('## 🛬 To land (2)');
      expect(text).toContain(
        '  - ✅ Add the CSV export (stage: tested, next: built)',
      );
      expect(text).toContain(
        '  - ✅ Add the CSV export (stage: tested, next: approved)',
      );
      expect(text).toContain(
        '- **You need to:** **Land it: build the app, then mark it built:**',
      );
      expect(text).toContain(
        '- **You need to:** **Try it, then mark it approved:**',
      );
      expect(text).toContain(
        '2 sessions are done or archived and hidden; --all shows them.',
      );
    } finally {
      own.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// F7 (home-base-vzwbj.4.9): concurrent loads sharing one run-scoped cache
// ---------------------------------------------------------------------------

describe('thread inbox: concurrent loads (F7)', () => {
  test('one at a time and eight at a time give the identical inbox', async () => {
    const base = {cwd: alpha, days: 30, env, now: NOW, repo: null};
    const one = await readInbox({...base, concurrency: 1});
    const eight = await readInbox({...base, concurrency: 8});
    if (one.kind !== 'read' || eight.kind !== 'read') throw new Error('read');
    expect(eight.read.rows.length).toBeGreaterThan(5);
    expect(JSON.stringify(inboxJson(eight.read))).toBe(
      JSON.stringify(inboxJson(one.read)),
    );
  });

  test('every row from the shared cache equals that session loaded ALONE — the gone checkout fails only its own row', async () => {
    const r = await read();
    const goneRow = r.rows.find((row) => row.sessionId === sid(8));
    expect(goneRow?.loaded?.model.git.branch.ok).toBe(false);
    for (const row of r.rows) {
      if (row.loaded == null) continue;
      const alone = await loadSession({
        cwd: alpha,
        env,
        selector: null,
        sessionIdOption: row.sessionId,
      });
      if (alone.kind !== 'loaded') throw new Error(alone.kind);
      expect({
        id: row.sessionId,
        model: JSON.stringify(row.loaded.model),
      }).toEqual({id: row.sessionId, model: JSON.stringify(alone.model)});
    }
  });

  test('a session whose commits cannot be attributed does not change the row of a session in the SAME checkout', async () => {
    const own = createSandbox();
    try {
      const xdg = join(own.path, 'xdg');
      writeFile(
        join(xdg, 'justin-sdk', 'config.json'),
        JSON.stringify({
          componentConfig: {thread: {enabled: true, sessionBeads: true}},
        }),
      );
      const ownEnv = {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        JUSTIN_THREADS_STATE_DIR: join(own.path, 'state'),
        JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(own.path, 'projects'),
        XDG_CONFIG_HOME: xdg,
      };
      const repo = initRepo(own, 'shared', {'README.md': '# s\n'});
      const init = runBr(repo, ['init', '--prefix', 't', '-q']);
      if (!init.ok) throw new Error(init.reason ?? 'br init');
      const world = {env: ownEnv, root: own.path};
      // A commit call with NO timestamp: its commits cannot be windowed.
      const broken = session(
        21,
        repo,
        'The broken one',
        {log: t('10:00'), record: t('10:05')},
        world,
        [
          {
            cwd: repo,
            message: {
              content: [
                {
                  id: 'toolu_x',
                  input: {command: 'git commit -qm wip'},
                  name: 'Bash',
                  type: 'tool_use',
                },
              ],
              role: 'assistant',
            },
            sessionId: sid(21),
            type: 'assistant',
          },
        ],
      );
      const healthy = session(
        22,
        repo,
        'The healthy one',
        {log: t('10:10'), record: t('10:15')},
        world,
      );
      const result = await readInbox({
        cwd: repo,
        days: 30,
        env: ownEnv,
        now: NOW,
        repo: null,
      });
      if (result.kind !== 'read') throw new Error(result.reason);
      const row = (id: string) =>
        result.read.rows.find((entry) => entry.sessionId === id);
      const brokenCommits = row(broken)?.loaded?.model.git.commits;
      expect(brokenCommits?.ok).toBe(false);
      expect(brokenCommits?.ok === false ? brokenCommits.reason : '').toContain(
        'no timestamp',
      );
      const alone = await loadSession({
        cwd: repo,
        env: ownEnv,
        selector: null,
        sessionIdOption: healthy,
      });
      if (alone.kind !== 'loaded') throw new Error(alone.kind);
      expect(alone.model.git.commits.ok).toBe(true);
      expect(JSON.stringify(row(healthy)?.loaded?.model)).toBe(
        JSON.stringify(alone.model),
      );
    } finally {
      own.cleanup();
    }
  });
});
