/**
 * scripts/restore-thread-records.ts (home-base-k0b8n.19, design D-E, AC 5).
 *
 * Everything runs against a FIXTURE threads repo: a real git repo whose
 * `.beads/issues.jsonl` history reproduces the erasure (a reported thread, then
 * the backfill commit that replaced it, then a later unrelated commit), and
 * whose `bun run bd` is the stateful fake (tests/fake-bd.ts) holding the "now"
 * records. The script runs unmodified: it reads git, spawns bd through the real
 * adapter, and commits with the real `commitThreadsRepo`. Nothing here can
 * reach ~/Dev/threads — every run pins JUSTIN_THREADS_REPO_DIR, and the first
 * assertion of every write test is that the fixture is what it resolved.
 */

import {describe, expect, spyOn, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  REPORT_SOURCE,
  type RestoreOptions,
  runRestore,
} from '../scripts/restore-thread-records';
import {PLAIN_STYLE} from '../src/cli-style';
import {BACKFILL_DESCRIPTION_MARKER} from '../src/thread/backfill-ownership';
import {NO_REPORT_GLANCE, runThreadShow} from '../src/thread/show';
import {createFakeBd, type FakeBd, type FakeIssue} from './fake-bd';

const SCRIPT = join(
  import.meta.dirname,
  '..',
  'scripts',
  'restore-thread-records.ts',
);

/** A rendered report, as far as `isRenderedReport` is concerned. */
const REPORT_NOTES = [
  '🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑',
  '',
  '⚡ ✅ Work completed · 🙋 needs your answers · 📈 100% · no P0 asks',
  '',
  '**Thread:** the fixture arc, reported for real',
  '',
  '🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️',
].join('\n');

const REPORTED_AT = '2026-09-20T01:22:16.133Z';

/** th-a1 BEFORE the damage: the pre-7e637d8 shape — a report under 'backfill'. */
function reported(): FakeIssue {
  return {
    description: 'GOAL: land the fixture arc\nSTOPPED: ✅ Work completed',
    id: 'th-a1',
    metadata: {
      askIds: ['th-a1.1'],
      cwd: '/Users/jhaa/Dev/pretend-repo',
      goal: 'land the fixture arc',
      lastUserMessage: 'Continue',
      messagesSource: 'backfill',
      progressPercent: 100,
      reportCount: 1,
      reportedAt: REPORTED_AT,
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      source: 'backfill',
      stopReasonKind: 'completed',
    },
    notes: REPORT_NOTES,
    parent: null,
    status: 'in_progress',
    title: 'the fixture arc, reported for real',
    type: 'thread',
  };
}

/**
 * th-a1 AFTER `thread backfill` rewrote it: the erased shape. `notes` is the
 * backfill body; th-mq0's quoted its session's last message, a status report.
 */
function damaged(
  notes = 'LAST CLAUDE RESPONSE (verbatim):\n\nsomething the session said',
): FakeIssue {
  return {
    description: `${BACKFILL_DESCRIPTION_MARKER} — this session never reported.\n\nrepo pretend-repo`,
    id: 'th-a1',
    metadata: {
      askIds: ['th-a1.1'],
      backfillOnly: 'x',
      cwd: '/Users/jhaa/Dev/pretend-repo/.claude/worktrees/w',
      goal: null,
      lastUserMessage: 'Continue',
      messagesSource: 'backfill',
      progressPercent: null,
      reportCount: 0,
      reportedAt: null,
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      source: 'backfill',
      stopReasonKind: null,
    },
    notes,
    parent: null,
    status: 'in_progress',
    title: 'You are the /conductor. Repo ~/Dev/pretend-repo…',
    type: 'thread',
  };
}

/** A thread the damaging commit never touched. */
function untouched(later = false): FakeIssue {
  return {
    description: 'another session',
    id: 'th-b2',
    metadata: {
      lastUserMessage: later ? 'a later capture' : 'hi',
      source: 'start',
    },
    notes: 'NO REPORT YET.',
    parent: null,
    status: 'in_progress',
    title: 'another session',
    type: 'thread',
  };
}

function ask(): FakeIssue {
  return {
    description: 'an ask the report made',
    id: 'th-a1.1',
    metadata: {kind: 'approve', threadId: 'th-a1'},
    parent: 'th-a1',
    status: 'open',
    title: 'Approve the fixture?',
    type: 'ask',
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** One JSONL line in the shape the fake's own export writes (fake-bd `shape`). */
function jsonlLine(issue: FakeIssue): string {
  return JSON.stringify({
    close_reason: issue.closeReason ?? null,
    description: issue.description ?? '',
    id: issue.id,
    issue_type: issue.type,
    metadata: issue.metadata ?? {},
    notes: issue.notes ?? '',
    parent: issue.parent ?? null,
    status: issue.status,
    title: issue.title,
  });
}

function commitStore(
  dir: string,
  issues: FakeIssue[],
  message: string,
): string {
  writeFileSync(
    join(dir, '.beads', 'issues.jsonl'),
    `${issues.map(jsonlLine).join('\n')}\n`,
  );
  git(dir, ['add', '.beads/issues.jsonl']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

interface Fixture {
  commits: {damage: string; later: string; pre: string};
  dir: string;
  env: Record<string, string | undefined>;
  fake: FakeBd;
}

function fixture(damagedNotes?: string): Fixture {
  const fake = createFakeBd();
  const root = mkdtempSync(join(tmpdir(), 'thread-restore-'));
  mkdirSync(join(root, 'xdg'), {recursive: true});
  git(fake.dir, ['init', '-q', '-b', 'main']);
  git(fake.dir, ['config', 'user.email', 'test@example.com']);
  git(fake.dir, ['config', 'user.name', 'Test']);
  git(fake.dir, ['config', 'commit.gpgsign', 'false']);
  const pre = commitStore(
    fake.dir,
    [reported(), ask(), untouched()],
    'thread th-a1: report',
  );
  const damage = commitStore(
    fake.dir,
    [damaged(damagedNotes), ask(), untouched()],
    'thread backfill: 0 created, 1 refreshed',
  );
  const later = commitStore(
    fake.dir,
    [damaged(damagedNotes), ask(), untouched(true)],
    'thread th-b2: capture',
  );
  const state = fake.read();
  state.issues = [damaged(damagedNotes), ask(), untouched(true)];
  state.exportJsonl = true;
  fake.write(state);
  return {
    commits: {damage, later, pre},
    dir: fake.dir,
    env: {
      ...fake.env,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
    },
    fake,
  };
}

async function restore(
  f: Fixture,
  options: Partial<RestoreOptions> & {ids: string[]},
): Promise<{code: number; out: string}> {
  const lines: string[] = [];
  const code = await runRestore({
    apply: false,
    autoCommit: true,
    autoPush: false,
    damagedAt: null,
    env: f.env,
    from: `${f.commits.damage}~1`,
    style: PLAIN_STYLE,
    write: (text) => lines.push(text),
    ...options,
  });
  return {code, out: lines.join('\n')};
}

function liveIssue(f: Fixture, id: string): FakeIssue {
  const found = f.fake.read().issues.find((candidate) => candidate.id === id);
  if (found == null) throw new Error(`fixture has no ${id}`);
  return found;
}

/** Every MUTATING bd command the fake received (reads — show, list, comments — are not). */
function writes(f: Fixture): string[] {
  return f.fake
    .read()
    .log.filter((entry) =>
      /^(update|create|close|reopen|delete|comments add) /.test(entry),
    );
}

function head(f: Fixture): string {
  return git(f.dir, ['rev-parse', 'HEAD']).trim();
}

function jsonlDirty(f: Fixture): string {
  return git(f.dir, [
    'status',
    '--porcelain',
    '--',
    '.beads/issues.jsonl',
  ]).trim();
}

/** What `thread show <id> --full` prints, without colour. */
async function show(f: Fixture, id: string): Promise<string> {
  const printed: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation(
    (...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '));
    },
  );
  try {
    await runThreadShow({env: f.env, full: true, threadId: id});
  } finally {
    spy.mockRestore();
  }
  return Bun.stripANSI(printed.join('\n'));
}

describe('restore-thread-records (k0b8n.19 D-E)', () => {
  test('--help prints usage and does nothing else: no bd call, no git write', () => {
    const f = fixture();
    const run = spawnSync('bun', [SCRIPT, '--help'], {
      encoding: 'utf8',
      env: f.env as NodeJS.ProcessEnv,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY RUN BY DEFAULT');
    expect(run.stdout).toContain('--apply');
    expect(run.stdout).toContain('--damaged-at');
    expect(f.fake.read().log).toEqual([]);
    expect(head(f)).toBe(f.commits.later);
    expect(jsonlDirty(f)).toBe('');
  });

  test('the dry run writes nothing, and prints every field it would write', async () => {
    const f = fixture();
    const before = f.fake.read().issues;
    const {code, out} = await restore(f, {ids: ['th-a1']});

    expect(out).toContain(
      `threads repo  ${f.dir} (resolved from: JUSTIN_THREADS_REPO_DIR)`,
    );
    expect(code).toBe(0);
    expect(f.fake.read().issues).toEqual(before);
    expect(writes(f)).toEqual([]);
    expect(head(f)).toBe(f.commits.later);
    expect(jsonlDirty(f)).toBe('');

    expect(out).toContain('DRY RUN (nothing is written)');
    expect(out).toContain(
      'thread backfill: 0 created, 1 refreshed (derived: the only child of --from on the path to HEAD)',
    );
    expect(out).toContain('th-a1 — WOULD RESTORE');
    expect(out).toContain('title — the write CHANGES it');
    expect(out).toContain('description — the write CHANGES it');
    expect(out).toContain('notes — the write CHANGES it');
    expect(out).toContain(
      'status — NOT written: "in_progress" at --from, "in_progress" now',
    );
    expect(out).toContain(
      `source — writes "${REPORT_SOURCE}", NOT the snapshot's "backfill"`,
    );
    expect(out).toContain(
      'reportCount\n               --from  1\n               now     0',
    );
    expect(out).toContain('askIds = ["th-a1.1"]');
    expect(out).toContain('which the write does not send (1): backfillOnly');
    expect(out).toContain('all 14 identical');
    expect(out).toContain(`reportCount 0 → prints "${NO_REPORT_GLANCE}"`);
    expect(out).toContain(
      'isRenderedReport(notes) true · reportCount 1 → prints the stored report',
    );
    expect(out).toContain(`report #1 · reported ${REPORTED_AT}`);
    expect(out).toContain('DRY RUN — nothing was written. Re-run with --apply');
  });

  test('a damaged body that quotes a report is predicted as "no report yet", as show prints it (k0b8n.20)', async () => {
    // th-mq0's shape: the backfill body quoted the session's last message, a
    // status report, so the notes look rendered although nothing reported.
    const f = fixture(`LAST CLAUDE RESPONSE (verbatim):\n\n${REPORT_NOTES}`);
    const {code, out} = await restore(f, {ids: ['th-a1']});
    expect(code).toBe(0);
    expect(out).toContain(
      `now    isRenderedReport(notes) true · reportCount 0 → prints "${NO_REPORT_GLANCE}" (the "no report yet" view)`,
    );
    expect(out).toContain(
      'isRenderedReport(notes) true · reportCount 1 → prints the stored report',
    );
    // The prediction and `show` agree.
    expect(await show(f, 'th-a1')).toContain(NO_REPORT_GLANCE);
  });

  test('--apply restores title, description, notes and metadata, writes source report, and commits', async () => {
    const f = fixture();
    expect(await show(f, 'th-a1')).toContain(NO_REPORT_GLANCE);

    const {code, out} = await restore(f, {apply: true, ids: ['th-a1']});
    expect(out).toContain(`threads repo  ${f.dir}`);
    expect(code).toBe(0);

    const want = reported();
    const got = liveIssue(f, 'th-a1');
    expect(got.title).toBe(want.title);
    expect(got.description).toBe(want.description ?? '');
    expect(got.notes).toBe(want.notes ?? '');
    const wantMeta = want.metadata ?? {};
    const gotMeta = got.metadata ?? {};
    for (const key of Object.keys(wantMeta)) {
      if (key === 'source') continue;
      expect({key, value: gotMeta[key]}).toEqual({key, value: wantMeta[key]});
    }
    // The one deliberate deviation from the snapshot (D-E).
    expect(wantMeta.source).toBe('backfill');
    expect(gotMeta.source).toBe(REPORT_SOURCE);
    // bd MERGES: a key only the backfill added is left alone, and so is status.
    expect(gotMeta.backfillOnly).toBe('x');
    expect(got.status).toBe('in_progress');

    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0]).toStartWith('update th-a1 --title');
    expect(out).toContain('th-a1  written and verified');

    // Committed the way every thread command commits.
    const short = (sha: string): string => sha.slice(0, 7);
    expect(git(f.dir, ['log', '-1', '--format=%s']).trim()).toBe(
      `thread restore: th-a1 to their records at ${short(f.commits.pre)} (undoing ${short(f.commits.damage)})`,
    );
    expect(jsonlDirty(f)).toBe('');
    const committed = git(f.dir, ['show', 'HEAD:.beads/issues.jsonl']);
    expect(committed).toContain(JSON.stringify(want.title));

    // What AC 7 checks on the real store: `thread show --full` prints the report.
    const printed = await show(f, 'th-a1');
    expect(printed).not.toContain(NO_REPORT_GLANCE);
    expect(printed).toContain('⚡ ✅ Work completed');
    expect(printed).toContain(`report #1 · reported ${REPORTED_AT}`);
  });

  test('refuses an id whose written field changed after the damaging commit, and writes nothing', async () => {
    const f = fixture();
    const state = f.fake.read();
    const live = state.issues.find((candidate) => candidate.id === 'th-a1');
    if (live == null) throw new Error('fixture has no th-a1');
    live.notes = 'a real edit made after the damage';
    live.metadata = {...live.metadata, lastUserMessage: 'a later message'};
    f.fake.write(state);
    const before = f.fake.read().issues;

    const {code, out} = await restore(f, {apply: true, ids: ['th-a1']});

    expect(out).toContain(`threads repo  ${f.dir}`);
    expect(code).toBe(1);
    expect(writes(f)).toEqual([]);
    expect(f.fake.read().issues).toEqual(before);
    expect(head(f)).toBe(f.commits.later);
    expect(out).toContain('th-a1 — REFUSED');
    expect(out).toContain('changed after the damaging commit');
    expect(out).toContain(
      'in 2 field(s) this restore would write: notes, metadata.lastUserMessage',
    );
    expect(out).toContain('NOTHING WAS WRITTEN');
  });

  test('a later change to a field it does NOT write is no refusal, and survives the write', async () => {
    const f = fixture();
    const state = f.fake.read();
    const live = state.issues.find((candidate) => candidate.id === 'th-a1');
    if (live == null) throw new Error('fixture has no th-a1');
    live.status = 'closed';
    live.metadata = {...live.metadata, backfillOnly: 'changed later'};
    f.fake.write(state);

    const {code, out} = await restore(f, {apply: true, ids: ['th-a1']});

    expect(code).toBe(0);
    expect(out).toContain('th-a1 — WILL RESTORE');
    const got = liveIssue(f, 'th-a1');
    expect(got.title).toBe(reported().title);
    expect(got.status).toBe('closed');
    expect(got.metadata?.backfillOnly).toBe('changed later');
  });

  test('one refused id means nothing is written for any id', async () => {
    const f = fixture();
    const before = f.fake.read().issues;
    // th-b2 was never damaged, so there is nothing to restore for it.
    const {code, out} = await restore(f, {
      apply: true,
      ids: ['th-a1', 'th-b2'],
    });

    expect(code).toBe(1);
    expect(out).toContain('th-a1 — WILL RESTORE');
    expect(out).toContain('th-b2 — REFUSED');
    expect(out).toContain('did not change any field this restore writes');
    expect(writes(f)).toEqual([]);
    expect(f.fake.read().issues).toEqual(before);
    expect(head(f)).toBe(f.commits.later);
  });

  test('a second --apply finds the record already restored and writes nothing', async () => {
    const f = fixture();
    expect((await restore(f, {apply: true, ids: ['th-a1']})).code).toBe(0);
    const afterFirst = head(f);

    const {code, out} = await restore(f, {apply: true, ids: ['th-a1']});

    expect(code).toBe(0);
    expect(out).toContain('th-a1 — ALREADY RESTORED');
    expect(writes(f)).toHaveLength(1);
    expect(head(f)).toBe(afterFirst);
  });

  test('refuses ids it cannot restore, and inputs it cannot resolve', async () => {
    const f = fixture();

    const missing = await restore(f, {ids: ['th-zz']});
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(
      'th-zz is not in .beads/issues.jsonl at --from',
    );

    const notThread = await restore(f, {ids: ['th-a1.1']});
    expect(notThread.code).toBe(1);
    expect(notThread.out).toContain('is "ask" at --from, not a thread');

    const backwards = await restore(f, {
      damagedAt: f.commits.pre,
      from: f.commits.later,
      ids: ['th-a1'],
    });
    expect(backwards.code).toBe(2);
    expect(backwards.out).toContain('is not an ancestor of --damaged-at');

    const noChild = await restore(f, {from: f.commits.later, ids: ['th-a1']});
    expect(noChild.code).toBe(2);
    expect(noChild.out).toContain('has 0 children on the path to HEAD');

    const badRev = await restore(f, {from: 'no-such-commit', ids: ['th-a1']});
    expect(badRev.code).toBe(2);
    expect(badRev.out).toContain('"no-such-commit" is not a commit');

    expect(writes(f)).toEqual([]);
  });

  test('an unreadable live record is a refusal, never "unchanged"', async () => {
    const f = fixture();
    // bd itself fails. (Removing the `bd` script is NOT enough: `bun run bd`
    // then falls back to running the fake's own bd.ts from the directory.)
    writeFileSync(
      join(f.dir, 'broken-bd.ts'),
      "console.error('error: bd is broken'); process.exit(1);\n",
    );
    writeFileSync(
      join(f.dir, 'package.json'),
      JSON.stringify({
        name: 'broken-bd',
        scripts: {bd: `bun ${join(f.dir, 'broken-bd.ts')}`},
      }),
    );

    const {code, out} = await restore(f, {apply: true, ids: ['th-a1']});

    expect(code).toBe(1);
    expect(out).toContain("could not read th-a1's live record");
    expect(out).toContain('NOTHING WAS WRITTEN');
    expect(head(f)).toBe(f.commits.later);
  });
});
