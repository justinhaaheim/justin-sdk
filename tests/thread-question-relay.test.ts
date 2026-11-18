/**
 * `thread answer --ask <Q n | bead id> --relay` (home-base-l2ejg.6; D8 in
 * home-base-l2ejg.3): a question in ANOTHER repo is answered at its source.
 * The older `BD<n>` still relays; a `Q<n>` at or below 99 is refused with a
 * question back (home-base-88y8m D6).
 *
 * The fixtures are two (and once three) throwaway repos with real br
 * databases, sharing one threads state dir, so the sessions index knows them
 * all, as it knows Justin's repos. The caller always runs in `home`; the
 * questions live in `other`.
 *
 * Each refusal has a control: the relay must write nothing, so every negative
 * test checks the source after the refusal, not only the message.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {fileAsk} from '../src/thread/ask';
import {listPositionRefusal} from '../src/thread/question-ids';
import {
  answerSessionQuestions,
  describeSessionAnswerOutcome,
} from '../src/thread/session-answer';
import {ensureSessionBead} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

const HOME_SESSION = '9e000001-aaaa-4bbb-8ccc-0123456789ab';
const OTHER_SESSION = '9e000002-aaaa-4bbb-8ccc-0123456789ab';
const CLONE_SESSION = '9e000003-aaaa-4bbb-8ccc-0123456789ab';

/** Each test spawns br a few dozen times; the CPU is shared. */
const SLOW = 60_000;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function at(minute: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 9, minute));
}

type Env = Record<string, string | undefined>;

function envFor(sb: Sandbox, sessionId: string): Env {
  return {
    CHORES_STATE_DIR: join(sb.path, 'chores-state'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: sessionId,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    VITALS_STATE_DIR: join(sb.path, 'vitals-state'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg'),
  };
}

interface Session {
  bead: string;
  env: Env;
  repo: string;
}

interface World {
  home: Session;
  other: Session;
  sb: Sandbox;
}

/** A session in `repo`: its bead, and its sighting in the index. */
function sessionIn(
  sb: Sandbox,
  repo: string,
  sessionId: string,
  title: string,
  minute: number,
): Session {
  const env = envFor(sb, sessionId);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: at(minute).toISOString(), text: title},
    now: at(minute),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  return {bead: filed.beadId, env, repo};
}

/** A repo with a br database of prefix `prefix`, and one session in it. */
function repoWithSession(
  sb: Sandbox,
  name: string,
  prefix: string,
  sessionId: string,
  title: string,
  minute: number,
): Session {
  const repo = initRepo(sb, name, {'README.md': `# ${name}\n`});
  const init = runBr(repo, ['init', '--prefix', prefix, '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  return sessionIn(sb, repo, sessionId, title, minute);
}

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  mkdirSync(join(sb.path, 'xdg', 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(sb.path, 'xdg', 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const home = repoWithSession(
    sb,
    'home-repo',
    'hm',
    HOME_SESSION,
    'Run the mayor',
    0,
  );
  const other = repoWithSession(
    sb,
    'other-repo',
    'ob',
    OTHER_SESSION,
    'Speed up the sync job',
    5,
  );
  return {home, other, sb};
}

/** A question filed by `session`, as `thread ask` files it. */
async function ask(
  session: Session,
  priority: string,
  title: string,
): Promise<{id: string; shortId: null | string}> {
  const outcome = await fileAsk({
    approve: false,
    context: [`Context for ${title}`],
    cwd: session.repo,
    default: priority === '0' ? null : 'I go on.',
    do: false,
    env: session.env,
    header: null,
    options: [],
    priority,
    question: title,
    recommend: null,
    sessionId: null,
    to: null,
  });
  if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
  return {id: outcome.id, shortId: outcome.shortId};
}

/** `thread answer --ask <id> [--relay] <text>`, run from the home repo. */
function answer(w: World, id: string, text: string, relay = true) {
  return answerSessionQuestions({
    ask: id,
    cwd: w.home.repo,
    env: w.home.env,
    relay,
    selector: null,
    sessionId: null,
    style: PLAIN_STYLE,
    text,
  });
}

function show(repo: string, id: string): Record<string, unknown> {
  const shown = runBr(repo, ['show', id, '--json']);
  if (!shown.ok) throw new Error(`br show ${id} failed: ${shown.stderr}`);
  const parsed: unknown = JSON.parse(shown.stdout);
  const issue: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (issue == null || typeof issue !== 'object') throw new Error('no issue');
  return issue as Record<string, unknown>;
}

function statusOf(repo: string, id: string): string {
  return String(show(repo, id).status);
}

function closeReasonOf(repo: string, id: string): null | string {
  const reason = show(repo, id).close_reason;
  return typeof reason === 'string' ? reason : null;
}

function relabel(repo: string, id: string, remove: string[], add: string[]) {
  const moved = runBr(repo, [
    'update',
    id,
    ...remove.map((label) => `--remove-label=${label}`),
    ...add.map((label) => `--add-label=${label}`),
  ]);
  if (!moved.ok) throw new Error(`br update ${id} failed`);
}

/** A question bead filed straight with br: not under any session bead. */
function standaloneQuestion(repo: string, title: string): string {
  const created = runBr(repo, ['create', title, '-t', 'question', '--silent']);
  if (!created.ok) throw new Error(`br create failed: ${created.stderr}`);
  const id = created.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (id === '') throw new Error('br create printed no id');
  return id;
}

function reasonOf(outcome: Awaited<ReturnType<typeof answer>>): string {
  return outcome.kind === 'failed' ? outcome.reason : `(${outcome.kind})`;
}

// ---------------------------------------------------------------------------

describe('thread answer --relay answers a question at its source', () => {
  test(
    'a Q id held in another repo: refused without --relay as before, answered there with it, and the reply names its question, repo and session',
    async () => {
      const w = world();
      const mine = await ask(w.home, '2', 'Keep the mayor list?');
      const theirs = await ask(w.other, '1', 'Drop the nightly sync?');
      expect(theirs.shortId).toBe('Q101');

      // Without --relay: D2's refusal, unchanged, and nothing written.
      const refused = await answer(w, 'Q101', 'yes, drop it', false);
      expect(reasonOf(refused)).toContain(
        `Q101 is not an open question of this session (${w.home.bead}`,
      );
      expect(reasonOf(refused)).toContain('Did you mean that question?');
      expect(statusOf(w.other.repo, theirs.id)).toBe('open');

      const relayed = await answer(w, 'q101', 'yes, drop it');
      expect(relayed).toMatchObject({
        id: theirs.id,
        kind: 'relayed',
        reason: 'answer: yes, drop it',
        repo: 'other-repo',
        session: {id: w.other.bead, title: 'Speed up the sync job'},
        shortId: 'Q101',
        sids: [OTHER_SESSION],
        step: 'session',
        title: 'Drop the nightly sync?',
      });
      // Written at the source, and only there.
      expect(statusOf(w.other.repo, theirs.id)).toBe('closed');
      expect(closeReasonOf(w.other.repo, theirs.id)).toBe(
        'answer: yes, drop it',
      );
      expect(statusOf(w.home.repo, mine.id)).toBe('open');

      const printed = describeSessionAnswerOutcome(relayed);
      expect(printed.exitCode).toBe(0);
      expect(printed.lines).toEqual([
        `✓ ${theirs.id} [Q101] recorded at its source: answer: yes, drop it`,
        '  Question: Drop the nightly sync?',
        `  Repo:     other-repo (${join(w.other.repo, '.beads', 'beads.db')})`,
        `  Session:  ${w.other.bead} "Speed up the sync job"`,
      ]);
    },
    SLOW,
  );

  test(
    'Q101, q101 and BD101 relay to the same question (D6)',
    async () => {
      const w = world();
      await ask(w.home, '2', 'Keep the mayor list?');
      const theirs = await ask(w.other, '1', 'Drop the nightly sync?');
      expect(theirs.shortId).toBe('Q101');
      for (const typed of ['Q101', 'q101', 'BD101']) {
        const relayed = await answer(w, typed, `yes (${typed})`);
        expect(relayed).toMatchObject({
          id: theirs.id,
          kind: 'relayed',
          shortId: 'Q101',
        });
        expect(closeReasonOf(w.other.repo, theirs.id)).toBe(
          `answer: yes (${typed})`,
        );
        // Open again, so the next form has the same question to answer.
        expect(runBr(w.other.repo, ['reopen', theirs.id]).ok).toBe(true);
      }
    },
    SLOW,
  );

  test(
    'a bead id: a question under its session is found in that session’s database, and a bead under no session by its repo’s prefix',
    async () => {
      const w = world();
      const underSession = await ask(w.other, '2', 'Rename the sync job?');
      const loose = standaloneQuestion(w.other.repo, 'Move the cron to 3am?');

      const one = await answer(w, underSession.id, 'call it sync-nightly');
      expect(one).toMatchObject({
        id: underSession.id,
        kind: 'relayed',
        session: {id: w.other.bead},
        step: 'session',
      });
      expect(closeReasonOf(w.other.repo, underSession.id)).toBe(
        'answer: call it sync-nightly',
      );

      const two = await answer(w, loose, 'yes, 3am');
      expect(two).toMatchObject({
        id: loose,
        kind: 'relayed',
        repo: 'other-repo',
        session: null,
        shortId: null,
        step: 'repo',
        title: 'Move the cron to 3am?',
      });
      expect(closeReasonOf(w.other.repo, loose)).toBe('answer: yes, 3am');
      const printed = describeSessionAnswerOutcome(two);
      expect(printed.lines.at(-1)).toBe(
        '  Session:  not filed under a session bead, and no session recorded on it',
      );
    },
    SLOW,
  );
});

describe('thread answer --relay refuses, writing nothing', () => {
  test(
    'Q7 and Q99 could be list positions: refused with a question back, and nothing is written (D6)',
    async () => {
      const w = world();
      // A guess would answer this one: it holds a hand-made label 99.
      const low = await ask(w.other, '2', 'Hand-labelled low?');
      relabel(w.other.repo, low.id, ['qid:100'], ['qid:99']);
      for (const [typed, shown] of [
        ['Q7', 'Q7'],
        ['q99', 'Q99'],
        ['Q99', 'Q99'],
      ] as const) {
        const refused = await answer(w, typed, 'yes');
        expect(refused).toEqual({
          kind: 'failed',
          reason: listPositionRefusal(shown),
        });
        expect(describeSessionAnswerOutcome(refused).exitCode).toBe(1);
        expect(statusOf(w.other.repo, low.id)).toBe('open');
      }
      // Control: BD99 is not a list position, and relays to that question.
      expect(await answer(w, 'BD99', 'yes')).toMatchObject({
        id: low.id,
        kind: 'relayed',
      });
      expect(statusOf(w.other.repo, low.id)).toBe('closed');
    },
    SLOW,
  );

  test(
    'no match: an unknown Q or BD id, an id only an old per-chain label holds, an unknown bead id, and an unknown prefix',
    async () => {
      const w = world();
      const q = await ask(w.other, '2', 'Keep the old export?');
      const old = await ask(w.other, '3', 'Stop the push?');
      // As if filed before D2: only an old per-chain id, BD4.
      relabel(w.other.repo, old.id, ['qid:101'], ['qid:ob-root:4']);

      for (const typed of ['Q999', 'BD999']) {
        const missing = await answer(w, typed, 'yes');
        expect(reasonOf(missing)).toContain(
          `no question in any known repo's export holds ${typed}.`,
        );
        expect(reasonOf(missing)).toContain('Nothing was recorded.');
      }
      const unknown = await answer(w, 'Q999', 'yes');

      const perChain = await answer(w, 'BD4', 'yes');
      expect(reasonOf(perChain)).toContain(
        'One question holds it as an old per-chain id, which names different questions in different chains and is never relayed',
      );
      expect(reasonOf(perChain)).toContain(old.id);

      const noBead = await answer(w, 'ob-zzzz9', 'yes');
      expect(reasonOf(noBead)).toContain(
        'ob-zzzz9 is not in any database that could hold it',
      );

      const noPrefix = await answer(w, 'zz-abc12', 'yes');
      expect(reasonOf(noPrefix)).toContain(
        'no known repo holds zz-abc12: no session the index records was filed under it, and no repo with a recorded session uses the prefix zz-',
      );

      for (const id of [q.id, old.id]) {
        expect(statusOf(w.other.repo, id)).toBe('open');
      }
      expect(describeSessionAnswerOutcome(unknown).exitCode).toBe(1);
    },
    SLOW,
  );

  test(
    'two matches: a Q id two questions hold, and a bead id in the primary databases of two repos that share a prefix',
    async () => {
      const w = world();
      const first = await ask(w.other, '2', 'Keep the old export?');
      const second = await ask(w.other, '3', 'Hand-labelled?');
      // A hand-edited label: the counter never hands one number out twice.
      relabel(w.other.repo, second.id, ['qid:101'], ['qid:100']);

      const shared = await answer(w, 'Q100', 'yes');
      expect(reasonOf(shared)).toContain('Q100 is held by 2 questions:');
      expect(reasonOf(shared)).toContain(`${first.id} in other-repo`);
      expect(reasonOf(shared)).toContain(`${second.id} in other-repo`);
      expect(reasonOf(shared)).toContain('Which one did you mean?');

      // A second checkout of `other` as its own primary: the same beads, and
      // a session recorded there, so the prefix `ob` names two repos.
      const loose = standaloneQuestion(w.other.repo, 'Move the cron?');
      const clone = initRepo(w.sb, 'other-clone', {'README.md': '# clone\n'});
      cpSync(join(w.other.repo, '.beads'), join(clone, '.beads'), {
        recursive: true,
      });
      sessionIn(w.sb, clone, CLONE_SESSION, 'Try the clone', 9);

      const twice = await answer(w, loose, 'yes');
      expect(reasonOf(twice)).toContain(
        `${loose} is in 2 databases of the primary checkouts of the repos that use its prefix, so which one is its source cannot be told:`,
      );
      expect(reasonOf(twice)).toContain('Nothing was recorded.');

      for (const id of [first.id, second.id, loose]) {
        expect(statusOf(w.other.repo, id)).toBe('open');
      }
      expect(statusOf(clone, loose)).toBe('open');
    },
    SLOW,
  );

  test(
    'an unreadable source database: refused with why, and its export is unchanged',
    async () => {
      const w = world();
      const q = await ask(w.other, '2', 'Keep the old export?');
      const beads = join(w.other.repo, '.beads');
      const exportPath = join(beads, 'issues.jsonl');
      const before = readFileSync(exportPath);
      // The database is no longer SQLite; the export still names the question.
      for (const suffix of ['-wal', '-shm']) {
        rmSync(join(beads, `beads.db${suffix}`), {force: true});
      }
      writeFileSync(join(beads, 'beads.db'), 'not a database\n'.repeat(200));

      for (const id of ['Q100', q.id]) {
        const refused = await answer(w, id, 'yes');
        expect(reasonOf(refused)).toContain(
          `${q.id} was looked for in the database of the session it was filed under, and one database could not be read, so it may be there:`,
        );
        expect(reasonOf(refused)).toContain('Nothing was recorded.');
      }
      expect(readFileSync(exportPath).equals(before)).toBe(true);
    },
    SLOW,
  );

  test(
    'an export that trails its database: the export still says Q100, the database no longer does, so the fresh read refuses',
    async () => {
      const w = world();
      const q = await ask(w.other, '2', 'Keep the old export?');
      // Relabelled in the database only: the export keeps qid:100.
      const moved = runBr(w.other.repo, [
        '--no-auto-flush',
        'update',
        q.id,
        '--remove-label=qid:100',
        '--add-label=qid:150',
      ]);
      expect(moved.ok).toBe(true);
      const exported = readFileSync(
        join(w.other.repo, '.beads', 'issues.jsonl'),
        'utf8',
      );
      expect(exported).toContain('"qid:100"');

      const refused = await answer(w, 'Q100', 'yes');
      expect(reasonOf(refused)).toBe(
        `${q.id} no longer holds Q100 in ${join(w.other.repo, '.beads', 'beads.db')} (it holds Q150), though its export did. Nothing was recorded.`,
      );
      expect(statusOf(w.other.repo, q.id)).toBe('open');
    },
    SLOW,
  );

  test(
    'a question already closed at its source: refused, and its first answer stays',
    async () => {
      const w = world();
      const q = await ask(w.other, '2', 'Keep the old export?');
      const closed = runBr(w.other.repo, [
        'close',
        q.id,
        '--reason=answer: no, drop it',
      ]);
      expect(closed.ok).toBe(true);

      for (const id of ['Q100', q.id]) {
        const refused = await answer(w, id, 'yes, keep it');
        expect(reasonOf(refused)).toBe(
          `${q.id} is already closed at its source (answer: no, drop it). Nothing was recorded.`,
        );
      }
      expect(closeReasonOf(w.other.repo, q.id)).toBe('answer: no, drop it');
    },
    SLOW,
  );
});
