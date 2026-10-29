/**
 * scripts/migrate-ask-parents.ts (home-base-vzwbj.4.16 acceptance criterion
 * 8): old-shape questions — `ask` beads that are CHILDREN of a request — move
 * under their session bead with the `to:<request>` label, ids and statuses
 * unchanged, dry run by default.
 *
 * Runs the PINNED br (tests/pinned-br.ts) in throwaway workspaces under
 * $TMPDIR, with made-up session ids. Never against a real database. The
 * --apply test runs once per br version (mise's installed 0.1.37 and 0.7.6,
 * whatever home-base pins, home-base-dj5m9.1.4): what a plain close of the
 * request does afterwards differs between them.
 * NEGATIVE CONTROL: recorded in home-base-vzwbj.4.16's notes.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  applyMove,
  planMigration,
  runMigration,
} from '../scripts/migrate-ask-parents';
import {brChildren, brClose, brCreate, brShow, runBr} from '../src/beads/br';
import {fileAsk} from '../src/thread/ask';
import {ASK_LABEL} from '../src/thread/ask-format';
import {fileRequest} from '../src/thread/request';
import {
  ensureSessionBead,
  REQUEST_LABEL,
  sidLabel,
  toLabel,
} from '../src/thread/session-bead';
import {readSessionTree} from '../src/thread/session-tree';
import {initRepo} from './git-fixtures';
import {installedBr, needBr, underInstalledBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '9e5711c5-0a19-4c00-8000-000000000001';

const BRS = [
  {br: installedBr('0.1.37'), version: '0.1.37'},
  {br: installedBr('0.7.6'), version: '0.7.6'},
] as const;
for (const {br} of BRS) {
  if (br.kind !== 'installed') {
    console.warn(
      `SKIPPED: a per-version --apply test in thread-migrate-ask-parents.test.ts cannot run (${br.reason})`,
    );
  }
}

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function quiet(): string[] {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  const error = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.join(' '));
    },
  );
  spies.push(log, error);
  return lines;
}

interface World {
  closedQuestion: string;
  env: Record<string, string | undefined>;
  newShape: string;
  openQuestion: string;
  repo: string;
  request: string;
  sb: Sandbox;
  sessionBead: string;
}

/**
 * A session bead, one request, an OPEN old-shape P3 and a CLOSED (answered)
 * old-shape P2 under it, and a new-shape question that must not move.
 */
async function world(): Promise<World> {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'migrate-repo', {'README.md': '# m\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'Fix search'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  const request = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env,
    here: false,
    sessionId: null,
    title: 'Find out which change broke search',
  });
  if (request.kind !== 'filed') throw new Error(JSON.stringify(request));
  const oldShape = (title: string, priority: number): string => {
    const created = brCreate(
      {cwd: repo},
      {
        labels: [ASK_LABEL, sidLabel(SESSION)],
        parent: request.id,
        priority,
        title,
        type: 'question',
      },
    );
    if (created.kind !== 'ok') throw new Error('old-shape question not filed');
    return created.id;
  };
  const openQuestion = oldShape('Should I revert the search change?', 3);
  const closedQuestion = oldShape('Which index should search use?', 2);
  if (
    brClose({cwd: repo}, closedQuestion, 'answer: the new one').kind !== 'ok'
  ) {
    throw new Error('close failed');
  }
  const asked = await fileAsk({
    approve: false,
    context: [],
    cwd: repo,
    default: 'I leave it.',
    do: false,
    env,
    header: null,
    options: [],
    priority: '3',
    question: 'Should search log slow queries?',
    recommend: null,
    sessionId: null,
    to: request.id,
  });
  if (asked.kind !== 'filed') throw new Error(JSON.stringify(asked));
  return {
    closedQuestion,
    env,
    newShape: asked.id,
    openQuestion,
    repo,
    request: request.id,
    sb,
    sessionBead: filed.beadId,
  };
}

function childIds(w: World, id: string): string[] {
  const children = brChildren({cwd: w.repo}, id);
  if (children.kind !== 'ok') throw new Error(`children of ${id}`);
  return children.children.map((child) => child.id).sort();
}

describe('migrate-ask-parents', () => {
  test('--help prints the help and writes nothing; no --cwd is refused', () => {
    needBr();
    const script = join(
      import.meta.dirname,
      '..',
      'scripts',
      'migrate-ask-parents.ts',
    );
    const help = Bun.spawnSync([process.execPath, script, '--help'], {
      stdin: 'ignore',
    });
    expect(help.exitCode).toBe(0);
    const text = help.stdout.toString();
    expect(text).toContain('DRY RUN BY DEFAULT');
    expect(text).toContain('--apply');
    expect(text).toContain('--dry-run');
    const bare = Bun.spawnSync([process.execPath, script], {stdin: 'ignore'});
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr.toString()).toContain('Missing required argument: cwd');
  });

  test('the CLI defaults to a dry run: it prints the moves and the br commands, and the database is unchanged', async () => {
    const w = await world();
    const exportBefore = readFileSync(
      join(w.repo, '.beads', 'issues.jsonl'),
      'utf8',
    );
    const script = join(
      import.meta.dirname,
      '..',
      'scripts',
      'migrate-ask-parents.ts',
    );
    const run = Bun.spawnSync([process.execPath, script, '--cwd', w.repo], {
      env: Object.fromEntries(
        Object.entries({...process.env, ...w.env}).filter(
          (entry): entry is [string, string] => entry[1] != null,
        ),
      ),
      stdin: 'ignore',
    });
    const out = run.stdout.toString();
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    expect(out).toContain('dry run (nothing is written; --apply writes)');
    expect(out).toContain(
      `br update ${w.openQuestion} --add-label=${toLabel(w.request)} --parent=`,
    );
    expect(out).toContain(
      `br update ${w.openQuestion} --parent=${w.sessionBead}`,
    );
    expect(out).toContain(w.closedQuestion);
    expect(out).not.toContain(w.newShape);
    expect(out).toContain('2 to move, 0 refused.');
    expect(childIds(w, w.request)).toEqual(
      [w.closedQuestion, w.openQuestion].sort(),
    );
    expect(readFileSync(join(w.repo, '.beads', 'issues.jsonl'), 'utf8')).toBe(
      exportBefore,
    );
  });

  async function applyAndClose(version: '0.1.37' | '0.7.6'): Promise<void> {
    const w = await world();
    const plan = planMigration({cwd: w.repo, env: w.env});
    expect(plan.kind).toBe('planned');
    if (plan.kind !== 'planned') return;
    expect(plan.moves.map((move) => move.question.id).sort()).toEqual(
      [w.closedQuestion, w.openQuestion].sort(),
    );
    expect(plan.refusals).toEqual([]);
    for (const move of plan.moves) expect(move.session.id).toBe(w.sessionBead);

    const lines = quiet();
    expect(runMigration({apply: true, cwd: w.repo, env: w.env})).toBe(0);
    expect(lines.join('\n')).toContain(
      '2 to move (2 moved, 0 failed), 0 refused.',
    );

    // The request has no question children left; the session bead has all three.
    expect(childIds(w, w.request)).toEqual([]);
    const underSession = childIds(w, w.sessionBead);
    for (const id of [w.openQuestion, w.closedQuestion, w.newShape]) {
      expect({id, underSession: underSession.includes(id)}).toEqual({
        id,
        underSession: true,
      });
    }
    for (const [id, status] of [
      [w.openQuestion, 'open'],
      [w.closedQuestion, 'closed'],
    ] as const) {
      const shown = brShow({cwd: w.repo}, id);
      expect(shown.kind).toBe('ok');
      if (shown.kind !== 'ok') return;
      expect({
        id,
        labels: shown.issue.labels.sort(),
        status: shown.issue.status,
      }).toEqual({
        id,
        labels: [ASK_LABEL, sidLabel(SESSION), toLabel(w.request)].sort(),
        status,
      });
    }
    const answered = brShow({cwd: w.repo}, w.closedQuestion);
    expect(answered.kind === 'ok' && answered.issue.closeReason).toBe(
      'answer: the new one',
    );

    // The session tree still finds every question for the request (by label).
    const tree = readSessionTree({
      beadsDirs: [join(w.repo, '.beads')],
      sessionBeadId: w.sessionBead,
      sessionId: SESSION,
    });
    expect(
      tree.requests[0]?.questions.map((question) => question.id).sort(),
    ).toEqual([w.closedQuestion, w.newShape, w.openQuestion].sort());

    // The point of it all: the plain close. It works on br 0.1.37. From
    // 0.2.22 on (0.7.6 here; measured 2026-10-26 by
    // scripts/measure-br-contract.ts) br also counts the OPEN moved question as
    // a child by its dot-notation id, and says so; the answered one does not.
    const close = runBr(w.repo, ['close', w.request, '--reason=found it']);
    if (version === '0.1.37') {
      expect({ok: close.ok, reason: close.reason}).toEqual({
        ok: true,
        reason: null,
      });
    } else {
      expect(close.ok).toBe(false);
      expect(close.stderr ?? '').toContain(
        `parent issue has 1 open dot-notation child issue(s): ${w.openQuestion}`,
      );
    }

    // Run again: nothing left to move.
    const again = planMigration({cwd: w.repo, env: w.env});
    expect(again.kind === 'planned' && again.moves).toEqual([]);
  }

  for (const {br, version} of BRS) {
    test.skipIf(br.kind !== 'installed')(
      `br ${version}: --apply moves each old-shape question under the session bead with to:<request>, ids and statuses unchanged; ${version === '0.1.37' ? 'the request then closes with plain br close' : 'the open one, a dot-notation child by id, still blocks a plain close'}`,
      async () => {
        await underInstalledBr(br, async () => {
          await applyAndClose(version);
        });
      },
    );
  }

  test('a question whose session bead is not in the DB is refused by name (exit 1) and left where it is', async () => {
    const w = await world();
    const stray = brCreate(
      {cwd: w.repo},
      {
        labels: [REQUEST_LABEL, 'sid:00000000-0000-4000-8000-0000000000aa'],
        title: 'A request from another session',
        type: 'task',
      },
    );
    if (stray.kind !== 'ok') throw new Error('stray not filed');
    const orphan = brCreate(
      {cwd: w.repo},
      {
        labels: [ASK_LABEL, 'sid:00000000-0000-4000-8000-0000000000aa'],
        parent: stray.id,
        priority: 3,
        title: 'A question from another session',
        type: 'question',
      },
    );
    if (orphan.kind !== 'ok') throw new Error('orphan not filed');
    const plan = planMigration({cwd: w.repo, env: w.env});
    if (plan.kind !== 'planned') throw new Error(plan.reason);
    expect(plan.refusals.map((refusal) => refusal.question)).toEqual([
      {id: orphan.id, title: 'A question from another session'},
    ]);
    expect(plan.refusals[0]?.reason).toContain('no session bead');
    const lines = quiet();
    expect(runMigration({apply: true, cwd: w.repo, env: w.env})).toBe(1);
    expect(lines.join('\n')).toContain(`NOT MOVED — no session bead`);
    expect(childIds(w, stray.id)).toEqual([orphan.id]);
  });

  test('applyMove reads its write back: a move whose read-back disagrees is a failure, never "moved"', async () => {
    const w = await world();
    const plan = planMigration({cwd: w.repo, env: w.env});
    if (plan.kind !== 'planned') throw new Error(plan.reason);
    const [move] = plan.moves;
    if (move == null) throw new Error('no move');
    // Claim the question was in a status it is not in: the read-back says so.
    const result = applyMove(
      {...move, question: {...move.question, status: 'deferred'}},
      {db: plan.db, env: w.env},
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('its status changed from deferred to');
    }
  });
});
