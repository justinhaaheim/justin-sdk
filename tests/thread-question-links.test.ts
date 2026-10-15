/**
 * Fix round C of status report v4 (home-base-vzwbj.4.16): a finished request
 * could not be closed while its optional questions were open, so a done
 * session showed as ⚠️ open work and the inbox told Justin to resume it.
 *
 *   G1  questions are children of the SESSION bead; the request is a `to:`
 *       label (old-shape questions — children of the request — still count)
 *   G2  `thread status` says what to do with each open request when the yield
 *       would be ⚠️, and the verdict line says what ⚠️ leads to
 *   G3  the help text says the v4 design
 *   G4  a ✅ Done session with an open P1/P2 stays in the default inbox
 *
 * Every test runs the PINNED br (tests/pinned-br.ts) in a throwaway workspace
 * under $TMPDIR, with the knob in an isolated XDG config, cwd set on every
 * call, the sessions index in the sandbox (JUSTIN_THREADS_STATE_DIR) and a
 * made-up session id. NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.16's
 * notes.
 */

import type {SessionStatus} from '../src/thread/session-status';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brClose, brCreate, runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {ASK_LABEL, renderAskDescription} from '../src/thread/ask-format';
import {serializeMessageLine} from '../src/thread/message-log';
import {partOneView, renderPartOne} from '../src/thread/part-one';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead, sidLabel, toLabel} from '../src/thread/session-bead';
import {readInbox, renderInbox} from '../src/thread/session-inbox';
import {
  loadSessionReport,
  OPEN_WORK_CONSEQUENCE,
  renderThreadStatus,
  verdictLines,
} from '../src/thread/session-report';
import {whatToMark} from '../src/thread/session-status';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TZ = 'UTC';
const ON = {enabled: true, sessionBeads: true};

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function at(hhmm: string): string {
  return `2030-01-01T${hhmm}:00.000Z`;
}

/** A made-up session id per world (never the conductor's). */
function sid(n: number): string {
  return `9e5711c5-4160-4c00-8000-${String(n).padStart(12, '0')}`;
}

interface World {
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
  session: string;
  sessionBead: string;
}

function newSandbox(): {env: Record<string, string | undefined>; sb: Sandbox} {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: ON}}),
  );
  return {
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
      XDG_CONFIG_HOME: xdg,
    },
    sb,
  };
}

function beadsRepo(sb: Sandbox, name: string): string {
  const repo = initRepo(sb, name, {'README.md': `# ${name}\n`});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  return repo;
}

/** A session bead for session `n` in `repo`, its prompt and Claude's yield logged. */
function sessionIn(
  base: {env: Record<string, string | undefined>; sb: Sandbox},
  repo: string,
  n: number,
  prompt: string,
): World {
  const session = sid(n);
  const env = {...base.env, CLAUDE_CODE_SESSION_ID: session};
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: at('09:00'), text: prompt},
    now: new Date(at('09:00')),
    sessionId: session,
  });
  if (filed.kind !== 'created') {
    throw new Error(`session bead not filed: ${filed.detail}`);
  }
  const log = messageLogPath(session, env);
  mkdirSync(dirname(log), {recursive: true});
  writeFileSync(
    log,
    serializeMessageLine({
      at: at('09:00'),
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text: prompt,
    }) +
      serializeMessageLine({
        at: at('09:30'),
        cwd: repo,
        event: 'Stop',
        role: 'assistant',
        text: 'Here is where it stands.',
      }),
  );
  return {env, repo, sb: base.sb, session, sessionBead: filed.beadId};
}

function world(): World {
  const base = newSandbox();
  return sessionIn(
    base,
    beadsRepo(base.sb, 'links-repo'),
    1,
    'Find out why the export is slow',
  );
}

async function request(w: World, title: string): Promise<string> {
  const filed = await fileRequest({
    bead: null,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    sessionId: null,
    title,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  return filed.id;
}

async function ask(
  w: World,
  input: {
    default?: string | null;
    priority: string;
    question: string;
    to: string | null;
  },
): Promise<string> {
  const outcome = await fileAsk({
    approve: false,
    context: [],
    cwd: w.repo,
    default: input.default ?? null,
    do: false,
    env: w.env,
    header: null,
    options: [],
    priority: input.priority,
    question: input.question,
    recommend: null,
    sessionId: null,
    to: input.to,
  });
  if (outcome.kind !== 'filed') throw new Error(JSON.stringify(outcome));
  return outcome.id;
}

/** An OLD-SHAPE question: a child of the request, as D1 filed them before 2026-10-12. */
function oldShapeQuestion(
  w: World,
  parent: string,
  priority: number,
  question: string,
): string {
  const created = brCreate(
    {cwd: w.repo},
    {
      description: renderAskDescription({
        context: [],
        default:
          priority === 0
            ? {kind: 'none', why: 'the session stops here'}
            : {kind: 'text', text: 'I go on without it.'},
        form: 'answer',
        header: null,
        options: [],
        recommended: null,
      }),
      labels: [ASK_LABEL, sidLabel(w.session)],
      parent,
      priority,
      title: question,
      type: 'question',
    },
  );
  if (created.kind !== 'ok') throw new Error('old-shape question not filed');
  return created.id;
}

/** The pinned br run directly, for its EXIT CODE (pinned-br put it first on PATH). */
function brExit(
  cwd: string,
  args: string[],
): {code: number | null; text: string} {
  const run = spawnSync('br', [...args, '--no-auto-import'], {
    cwd,
    encoding: 'utf8',
  });
  return {code: run.status, text: `${run.stdout}${run.stderr}`};
}

async function report(w: World, asIfYielded: boolean) {
  const load = await loadSessionReport({
    asIfYielded,
    cwd: w.repo,
    env: w.env,
    now: NOW,
    selector: null,
    sessionId: null,
  });
  if (load.kind !== 'loaded') throw new Error(JSON.stringify(load));
  return load;
}

function partOne(load: Awaited<ReturnType<typeof report>>): string {
  return renderPartOne(
    partOneView({
      action: load.action,
      counts: load.counts,
      model: load.model,
      now: NOW,
      optional: load.optional,
      status: load.status,
      timeZone: TZ,
    }),
    PLAIN_STYLE,
  );
}

/**
 * Part 1's "You need to" field and, when present, its "Optional" field, as
 * markdown (home-base-j8q3e.1.7.2: both come from the dashboard's functions).
 * Throws when Part 1 has no "You need to" line, so a missing line can never
 * pass a `not.toContain`.
 */
function youText(load: Awaited<ReturnType<typeof report>>): string {
  const lines = partOne(load).split('\n');
  const you = lines.find((line) => line.includes('**You need to:**'));
  if (you == null) throw new Error('Part 1 has no "You need to" line');
  const optional = lines.find((line) => line.includes('**Optional:**'));
  return optional == null ? you : `${you}\n${optional}`;
}

function cli(w: World, args: string[]) {
  const cliEntry = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...w.env,
      FORCE_COLOR: undefined,
      NO_COLOR: '1',
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );
  const run = Bun.spawnSync([process.execPath, cliEntry, 'thread', ...args], {
    cwd: w.repo,
    env,
    stdin: 'ignore',
  });
  return {
    code: run.exitCode,
    err: run.stderr.toString(),
    out: run.stdout.toString(),
  };
}

// ---------------------------------------------------------------------------
// G1
// ---------------------------------------------------------------------------

describe('G1: a question is a child of the session bead, linked to its request by label', () => {
  test('AC1: thread ask --to R files under the session bead with label to:<R>, and no parent-child edge to R', async () => {
    const w = world();
    const r = await request(w, 'Find out why the export is slow');
    const run = cli(w, [
      'ask',
      'Should the export also gzip its output?',
      '--priority',
      '3',
      '--default',
      'I leave it uncompressed.',
      '--to',
      r,
    ]);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    const id = /^ask (\S+) · /.exec(run.out)?.[1] ?? '';
    expect(run.out.split('\n')[0]).toBe(
      `ask ${id} · ⚪ P3 · filed under ${w.sessionBead} (for ${r}: Find out why the export is slow)`,
    );
    const shown = runBr(w.repo, ['show', id, '--json']);
    expect(shown.ok).toBe(true);
    const [record] = JSON.parse(shown.stdout) as {
      dependencies?: {dependency_type: string; id: string}[];
      labels?: string[];
      parent?: string;
    }[];
    const parents = (record?.dependencies ?? [])
      .filter((dep) => dep.dependency_type === 'parent-child')
      .map((dep) => dep.id);
    expect(parents).toEqual([w.sessionBead]);
    expect((record?.dependencies ?? []).map((dep) => dep.id)).not.toContain(r);
    expect(record?.labels).toContain(toLabel(r));
    // br refuses `.` in a label, so the request's dots are written as `:`.
    expect(toLabel(r)).toBe(`to:${r.replaceAll('.', ':')}`);
  });

  test('AC2 (new shape): a request with an open P3 filed --to it closes with plain br close; Part 1 shows it ✅ and the question still listed and counted', async () => {
    const w = world();
    const r = await request(w, 'Find out why the export is slow');
    const q = await ask(w, {
      default: 'I leave it uncompressed.',
      priority: '3',
      question: 'Should the export also gzip its output?',
      to: r,
    });
    const closed = brExit(w.repo, [
      'close',
      r,
      '--reason=answered in the report',
    ]);
    expect({code: closed.code, text: closed.text}).toMatchObject({code: 0});
    expect(closed.text).not.toContain('Skipped');

    const load = await report(w, true);
    expect(load.model.beads.requests[0]?.questions.map((x) => x.id)).toEqual([
      q,
    ]);
    const markdown = partOne(load);
    expect(markdown).toContain(
      `1. ✅ **Find out why the export is slow** (${r})`,
    );
    expect(markdown).toContain('## Questions for you');
    expect(markdown).toContain(
      `**Should the export also gzip its output?** (${q})`,
    );
    expect(load.counts.optional).toBe(1);
    expect(markdown).toContain('(1 optional question)');
    expect(load.status.kind).not.toBe('waiting');
    expect(load.status.kind).toBe('done');
    expect(youText(load)).not.toContain('resume it');
  });

  test('AC2 (old shape): a question that is a CHILD of the request is still listed and counted; plain br close is refused, --force closes it', async () => {
    const w = world();
    const r = await request(w, 'Find out why the export is slow');
    const q = oldShapeQuestion(w, r, 3, 'Should the export also gzip?');
    const load = await report(w, true);
    expect(load.model.beads.requests[0]?.questions.map((x) => x.id)).toEqual([
      q,
    ]);
    expect(load.model.beads.requests[0]?.children).toEqual([]);

    const refused = brExit(w.repo, ['close', r, '--reason=done']);
    expect(refused.code).toBe(3);
    expect(refused.text).toContain('parent issue has 1/1 open children');
    const forced = brExit(w.repo, ['close', r, '--reason=done', '--force']);
    expect(forced.code).toBe(0);

    const after = await report(w, true);
    const markdown = partOne(after);
    expect(markdown).toContain(
      `1. ✅ **Find out why the export is slow** (${r})`,
    );
    expect(markdown).toContain(`**Should the export also gzip?** (${q})`);
    expect(after.counts.optional).toBe(1);
    expect(after.status.kind).not.toBe('waiting');
    expect(youText(after)).not.toContain('resume it');
  });

  test('AC3: "blocked on question N" for a P0 linked by label AND for a P0 that is the request’s child', async () => {
    const w = world();
    const labelled = await request(w, 'Write the export runbook');
    const parented = await request(w, 'Pick the export bucket');
    const p0Label = await ask(w, {
      priority: '0',
      question: 'Which region does the runbook cover?',
      to: labelled,
    });
    const p0Child = oldShapeQuestion(w, parented, 0, 'Which bucket?');
    const load = await report(w, true);
    expect(load.status).toEqual({kind: 'waiting', openP0: 2});
    const nodes = load.model.beads.requests;
    expect(nodes.map((node) => node.questions.map((x) => x.id))).toEqual([
      [p0Label],
      [p0Child],
    ]);
    const view = partOneView({
      action: load.action,
      counts: load.counts,
      model: load.model,
      now: NOW,
      optional: load.optional,
      status: load.status,
      timeZone: TZ,
    });
    expect(view.requests.map((entry) => entry.id)).toEqual([
      labelled,
      parented,
    ]);
    const blocked = view.requests.map((entry) => entry.blockedOn ?? '');
    for (const words of blocked) {
      expect(words).toMatch(/^blocked on question [12]$/);
    }
    expect(new Set(blocked).size).toBe(2);
    const markdown = partOne(load);
    expect(markdown).toContain(
      `🛑 **Write the export runbook** (${labelled}) — blocked on question`,
    );
    expect(markdown).toContain(
      `🛑 **Pick the export bucket** (${parented}) — blocked on question`,
    );
  });
});

// ---------------------------------------------------------------------------
// G2
// ---------------------------------------------------------------------------

function normalized(text: string, w: World): string {
  return text
    .split(w.sb.path)
    .join('<sandbox>')
    .split(w.sessionBead)
    .join('t-SESS');
}

/** The "What to mark" block through the verdict: what G2 changed. */
function marksBlock(text: string): string {
  const start = text.indexOf('**What to mark:**');
  return start === -1
    ? text.slice(text.indexOf('Nothing to mark.'))
    : text.slice(start);
}

describe('G2: thread status says what to do with each open request when the yield would be ⚠️', () => {
  async function threeRequests() {
    const w = world();
    const linked = await request(w, 'Find out why the export is slow');
    await ask(w, {
      default: 'I leave it uncompressed.',
      priority: '3',
      question: 'Should the export also gzip its output?',
      to: linked,
    });
    const oldShape = await request(w, 'Find out which change broke search');
    oldShapeQuestion(w, oldShape, 2, 'Should I revert the search change?');
    const withChild = await request(w, 'Write the export runbook');
    const child = brCreate(
      {cwd: w.repo},
      {parent: withChild, title: 'Draft the restore section', type: 'task'},
    );
    if (child.kind !== 'ok') throw new Error('child not filed');
    return {child: child.id, linked, oldShape, w, withChild};
  }

  test('AC4: one entry per open request, the close command, --force only for old-shape question children, an open child listed instead', async () => {
    const {child, linked, oldShape, w, withChild} = await threeRequests();
    const load = await report(w, true);
    expect(load.status.kind).toBe('openWork');
    const marks = whatToMark(load.model, load.status).filter(
      (mark) => mark.kind === 'requestOpenNoBlocker',
    );
    expect(
      marks.map((mark) =>
        mark.kind === 'requestOpenNoBlocker' ? mark.request.id : null,
      ),
    ).toEqual([linked, oldShape, withChild]);

    const out = renderThreadStatus(load, {
      now: NOW,
      style: PLAIN_STYLE,
      timeZone: TZ,
    });
    const block = marksBlock(out);
    expect(block).toContain(
      `  - work done → \`br close ${linked} --reason "…"\` (its open question for Justin stays open; questions never keep a request open)`,
    );
    const forced = block.split('\n').filter((line) => line.includes('--force'));
    expect(forced).toHaveLength(1);
    expect(forced[0]).toContain(`br close ${oldShape} --reason "…" --force`);
    expect(block).not.toContain(`br close ${withChild}`);
    expect(block).toContain(
      `  - work done → 1 child bead is still open: ${child} — close it first`,
    );
    expect(normalized(block, w)).toMatchSnapshot();
  });

  test('AC4: no such entry under 🛑 (an open P0) or 💬 (no request)', async () => {
    const {linked, w} = await threeRequests();
    await ask(w, {priority: '0', question: 'Which bucket?', to: linked});
    const waiting = await report(w, true);
    expect(waiting.status.kind).toBe('waiting');
    const kinds = whatToMark(waiting.model, waiting.status).map(
      (mark) => mark.kind,
    );
    expect(kinds).not.toContain('requestOpenNoBlocker');
    expect(
      renderThreadStatus(waiting, {now: NOW, style: PLAIN_STYLE, timeZone: TZ}),
    ).not.toContain('nothing blocks it');

    const answered = world();
    const quiet = await report(answered, true);
    expect(quiet.status.kind).toBe('answered');
    expect(whatToMark(quiet.model, quiet.status)).toEqual([]);
  });

  test('AC5: the verdict line carries the consequence for ⚠️ and for no other verdict', () => {
    const statuses: SessionStatus[] = [
      {kind: 'waiting', openP0: 1},
      {kind: 'working', lastRecordAt: at('11:59')},
      {kind: 'handedOff', successor: null},
      {contextTokens: 900_000, kind: 'outOfContext', wrapUpAt: 800_000},
      {by: 'requests', kind: 'done', reason: null},
      {by: 'justin', kind: 'done', reason: 'done: Justin'},
      {kind: 'doneUnmerged', notMerged: true, uncommitted: 0},
      {kind: 'answered'},
      {kind: 'unknown', reasons: ['git failed']},
      {kind: 'openWork'},
    ];
    for (const style of [PLAIN_STYLE, {color: true, width: 100}]) {
      for (const status of statuses) {
        const lines = verdictLines(status, style);
        const said = lines.join('\n').includes(OPEN_WORK_CONSEQUENCE.trim());
        expect({kind: status.kind, lines: lines.length, said}).toEqual({
          kind: status.kind,
          lines: status.kind === 'openWork' ? 2 : 1,
          said: status.kind === 'openWork',
        });
      }
    }
    expect(verdictLines({kind: 'openWork'}, PLAIN_STYLE)).toEqual([
      'If you stop now the inbox will say: ⚠️ Open work, no blocker — Justin will be told to resume this session.',
      'Close what is done, file the P0 that blocks you, or run `bun run justin-sdk thread handoff`.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// G3
// ---------------------------------------------------------------------------

describe('G3: the help text says the v4 design', () => {
  /** Help text with yargs' wrapping undone, so a sentence is one string. */
  function help(w: World, args: string[]): string {
    const run = cli(w, [...args, '--help']);
    expect(run.code).toBe(0);
    return run.out.replace(/\s+/g, ' ');
  }

  test('AC6: thread, thread request, thread ask and thread status --help each carry the v4 wording', () => {
    const w = world();
    const raw = cli(w, ['--help']).out;
    const top = raw.slice(0, raw.indexOf('Commands:'));
    expect(top).not.toContain('~/Dev/threads');
    expect(top.replace(/\s+/g, ' ')).toContain(
      'each question for Justin a bead under the session bead, and Part 1 of the report generated by `thread status`',
    );
    const finished =
      'When a request is finished: br close <id> --reason "…". Your open questions to Justin never keep it open.';
    expect(help(w, ['request'])).toContain(finished);
    expect(help(w, ['status'])).toContain(finished);
    expect(help(w, ['ask'])).toContain(
      'Its parent is the session bead; --to links it to a request',
    );
  });
});

// ---------------------------------------------------------------------------
// G4
// ---------------------------------------------------------------------------

describe('G4: a ✅ Done session with an open P1 or P2 stays in the default inbox', () => {
  test('AC7: Done + open P2 → "Done, with questions for you"; Done + only a P3 → only with --all; --all lists Done and Archived', async () => {
    const base = newSandbox();
    const repo = beadsRepo(base.sb, 'inbox-repo');
    const w = sessionIn(base, repo, 1, 'Fix the date parser');
    const r = await request(w, 'Fix the date parser');
    const p2 = await ask(w, {
      default: 'I keep the old format too.',
      priority: '2',
      question: 'Should the parser drop the old date format?',
      to: r,
    });
    expect(brExit(repo, ['close', r, '--reason=fixed']).code).toBe(0);
    // A second session, archived by Justin.
    const archived = sessionIn(base, repo, 2, 'Try the new linter');
    if (
      brClose({cwd: repo}, archived.sessionBead, 'archived: not worth it')
        .kind !== 'ok'
    ) {
      throw new Error('archive failed');
    }

    const read = async () => {
      const result = await readInbox({
        cwd: repo,
        days: 30,
        env: base.env,
        now: NOW,
        repo: null,
      });
      if (result.kind !== 'read') throw new Error(result.reason);
      return result.read;
    };
    const render = (
      inbox: Awaited<ReturnType<typeof read>>,
      all: boolean,
    ): string =>
      renderInbox(inbox, {
        all,
        days: 30,
        now: NOW,
        order: 'status',
        style: PLAIN_STYLE,
        timeZone: TZ,
      });

    const first = await read();
    const row = first.rows.find((entry) => entry.sessionId === w.session);
    expect(row?.section).toBe('doneQuestions');
    const view = render(first, false);
    expect(view).toContain('## ✅ Done, with questions for you (1)');
    expect(view).toContain('[INBOX-REPO] Fix the date parser');
    expect(view).not.toContain('Try the new linter');

    const load = await report(w, false);
    expect(load.status.kind).toBe('done');
    // home-base-j8q3e.1.7.2: Part 1 says what the dashboard card says — D3
    // rule 9, and the card's Optional line with the command that answers.
    expect(youText(load)).toBe(
      `* **You need to:** **Nothing. You can close its pane.**\n* **Optional:** 1 optional question; its default applies if you skip it. To answer: \`bun run justin-sdk thread answer ${w.sessionBead}\``,
    );

    // Answer the P2; leave only a P3.
    expect(brClose({cwd: repo}, p2, 'answer: yes, drop it').kind).toBe('ok');
    await ask(w, {
      default: 'I leave the log line as it is.',
      priority: '3',
      question: 'Should the parser log the old format it saw?',
      to: r,
    });
    const second = await read();
    expect(
      second.rows.find((entry) => entry.sessionId === w.session)?.section,
    ).toBe('done');
    const quiet = render(second, false);
    expect(quiet).not.toContain('Fix the date parser');
    expect(quiet).not.toContain('Done, with questions for you');
    const all = render(second, true);
    expect(all).toContain('## ✅ Done (1)');
    expect(all).toContain('[INBOX-REPO] Fix the date parser');
    expect(all).toContain('## 🗄️ Archived (1)');
    expect(all).toContain('[INBOX-REPO] Try the new linter');
    // Only the P3 is left: still nothing required, and the card's Optional
    // line counts every P1–P4, so it names the one P3.
    expect(youText(await report(w, false))).toBe(
      `* **You need to:** **Nothing. You can close its pane.**\n* **Optional:** 1 optional question; its default applies if you skip it. To answer: \`bun run justin-sdk thread answer ${w.sessionBead}\``,
    );
  });
});
