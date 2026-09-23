/**
 * `thread backfill` — a thread bead for every session, not just the polite ones
 * (home-base-k0b8n.3, decision K5).
 *
 * Everything here runs against the STATEFUL FAKE bd (tests/fake-bd.ts) and a
 * FAKE `~/.claude/projects` under $TMPDIR. Nothing reads the real home and
 * nothing writes the real threads repo. The transcripts are written by hand
 * rather than copied from a real session, because the facts under test are
 * about TIMESTAMPS and FILE LAYOUT — which record dates the session, which file
 * is a session at all — and a real slice pins neither.
 *
 * NEGATIVE CONTROLS are recorded on home-base-k0b8n.3's notes: each one names
 * the line that was broken, the assertion that went red, and the restore.
 */

import type {ThreadFacts} from '../src/thread/facts';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, mkdtempSync, utimesSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  backfillThreads,
  describeBackfill,
  discoverSessionFiles,
  runThreadBackfill,
  scanSessions,
} from '../src/thread/backfill';
import {bdContext} from '../src/thread/bd';
import {
  backfilledHiddenLine,
  buildBoard,
  renderByRepo,
} from '../src/thread/board';
import {writeReportToBd} from '../src/thread/report';
import {validateThreadReport} from '../src/thread/schema';
import {startThread} from '../src/thread/start';
import {projectDirSlug} from '../src/thread/transcript-messages';
import {createFakeBd, type FakeBd, type FakeIssue} from './fake-bd';
import {examplePayload} from './thread-schema.test';

const DAY = 86_400_000;
const SESSION = '7f3c1e20-aaaa-4bbb-8ccc-0123456789ab';
const CWD = '/Users/jhaa/Dev/pretend-repo';

interface Harness {
  env: Record<string, string | undefined>;
  fake: FakeBd;
  projects: string;
  root: string;
}

function harness(): Harness {
  const fake = createFakeBd();
  const root = mkdtempSync(join(tmpdir(), 'thread-backfill-'));
  const projects = join(root, 'projects');
  const stateDir = join(root, 'state');
  const xdg = join(root, 'xdg');
  mkdirSync(projects, {recursive: true});
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  // The knobs the thread feature needs; `backfill` itself does not read them,
  // but `thread start` (the adoption tests) does.
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {autoCommit: false, enabled: true, startOnSessionStart: true},
      },
    }),
  );
  return {
    env: {
      ...fake.env,
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: stateDir,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: projects,
      XDG_CONFIG_HOME: xdg,
    },
    fake,
    projects,
    root,
  };
}

interface TranscriptSpec {
  /** Force the file's mtime, to separate it from the records inside. */
  atime?: Date;
  branch?: string;
  cwd?: string;
  /** Override the FILENAME's session id (default: sessionId). */
  fileName?: string;
  lines?: string[];
  /** Override the directory the file lands in (default: the cwd's slug). */
  projectDir?: string;
  sessionId?: string;
}

/** One transcript on disk. Returns its path. */
function writeTranscript(
  h: Harness,
  spec: TranscriptSpec & {records: Record<string, unknown>[]},
): string {
  const cwd = spec.cwd ?? CWD;
  const dir = join(h.projects, spec.projectDir ?? projectDirSlug(cwd));
  mkdirSync(dir, {recursive: true});
  const name = spec.fileName ?? `${spec.sessionId ?? SESSION}.jsonl`;
  const path = join(dir, name);
  writeFileSync(
    path,
    `${spec.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  if (spec.atime != null) utimesSync(path, spec.atime, spec.atime);
  return path;
}

function userRecord(
  text: string,
  at: Date,
  spec: TranscriptSpec = {},
): Record<string, unknown> {
  return {
    cwd: spec.cwd ?? CWD,
    gitBranch: spec.branch ?? 'main',
    message: {content: text, role: 'user'},
    sessionId: spec.sessionId ?? SESSION,
    timestamp: at.toISOString(),
    type: 'user',
  };
}

function assistantRecord(
  text: string,
  at: Date,
  spec: TranscriptSpec = {},
): Record<string, unknown> {
  return {
    cwd: spec.cwd ?? CWD,
    gitBranch: spec.branch ?? 'main',
    message: {
      content: [{text, type: 'text'}],
      model: 'claude-opus-5',
      role: 'assistant',
    },
    sessionId: spec.sessionId ?? SESSION,
    timestamp: at.toISOString(),
    type: 'assistant',
  };
}

/** A complete two-message session, `ageDays` old. */
function writeSession(
  h: Harness,
  ageDays: number,
  spec: TranscriptSpec & {
    assistant?: string;
    now?: Date;
    user?: string;
  } = {},
): string {
  const now = spec.now ?? new Date();
  const at = new Date(now.getTime() - ageDays * DAY);
  return writeTranscript(h, {
    ...spec,
    records: [
      userRecord(spec.user ?? 'do the thing please', at, spec),
      assistantRecord(spec.assistant ?? 'I did the thing.', at, spec),
    ],
  });
}

function threads(h: Harness): FakeIssue[] {
  return h.fake.read().issues.filter((issue) => issue.type === 'thread');
}

function metaOf(issue: FakeIssue): Record<string, unknown> {
  return issue.metadata ?? {};
}

/** The facts a REAL report attaches. Nothing here comes from the backfill. */
function reportFacts(now: Date): ThreadFacts {
  return {
    aheadBehind: {ahead: 1, behind: 0},
    autofillFailures: [],
    branch: 'main',
    cwd: CWD,
    dirty: false,
    entrypoint: 'cli',
    firstUserMessage: 'the brief',
    firstUserMessageAt: null,
    headSha: 'deadbee',
    isWorktree: false,
    lastAssistantMessage: 'Done — here is the report.',
    lastAssistantMessageAt: null,
    lastUserMessage: 'go',
    lastUserMessageAt: null,
    model: 'claude-opus-5',
    repo: 'pretend-repo',
    repoPath: CWD,
    reportedAt: now.toISOString(),
    resumeCommand: `cd '${CWD}' && claude --resume ${SESSION}`,
    sessionId: SESSION,
    startedAt: new Date(now.getTime() - DAY).toISOString(),
    tokensAtStop: 42,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function silence(): void {
  spies.push(spyOn(console, 'log').mockImplementation(() => undefined));
  spies.push(spyOn(console, 'error').mockImplementation(() => undefined));
}

function captureStdout(): string[] {
  const lines: string[] = [];
  spies.push(
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    }),
  );
  return lines;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  spies.push(
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    }),
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery: what counts as a session, and when it was last active', () => {
  test('THE DISCRIMINATING ONE: mtime NOW, last record 40 days ago — OUT of a 30-day window', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 40, {atime: now, now});

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.sessionsInWindow).toBe(0);
    expect(summary.created).toBe(0);
    // Read, and then excluded by what was INSIDE it — not skipped unread. If
    // the window were decided by mtime this file would be in, and if the mtime
    // pre-filter were doing the excluding the count below would be 1.
    expect(summary.scan.filesRead).toBe(1);
    expect(summary.scan.skippedOldMtime).toBe(0);
    expect(summary.scan.skippedOutOfWindow).toBe(1);
    expect(threads(h)).toHaveLength(0);
  });

  test('the same transcript one day inside the window IS imported', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 29, {atime: now, now});

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.sessionsInWindow).toBe(1);
    expect(summary.created).toBe(1);
  });

  test('agent-*.jsonl is a SUBAGENT, not a session: counted, never imported', () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    writeTranscript(h, {
      fileName: 'agent-9c1f2a30-bbbb-4ccc-8ddd-0123456789ab.jsonl',
      records: [userRecord('review my plan', now), assistantRecord('ok', now)],
    });

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});

    expect(discovery.skippedAgentFiles).toBe(1);
    expect(discovery.files).toHaveLength(1);
    expect(discovery.files[0]?.fileSessionId).toBe(SESSION);
  });

  test('a subagent transcript under <uuid>/subagents/ is never reached — the scan is one level deep', () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    const nested = join(h.projects, projectDirSlug(CWD), SESSION, 'subagents');
    mkdirSync(nested, {recursive: true});
    writeFileSync(
      join(nested, 'agent-1.jsonl'),
      `${JSON.stringify(userRecord('sub', now))}\n`,
    );

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});

    expect(discovery.files).toHaveLength(1);
    expect(discovery.files[0]?.path.includes('subagents')).toBe(false);
    // Not even counted as an agent file: it was never enumerated at all.
    expect(discovery.skippedAgentFiles).toBe(0);
  });

  test('a justin-loop e2e fixture project directory is skipped BY NAME, and says which', () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    writeTranscript(h, {
      projectDir:
        '-private-var-folders-rz-0lzmwtn54x5-T-justin-loop-e2e-a-6S7JYc-repo',
      records: [userRecord('loop fixture prompt', now)],
      sessionId: '11111111-2222-4333-8444-555555555555',
    });

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});

    expect(discovery.files).toHaveLength(1);
    expect(discovery.skippedFixtureDirs).toHaveLength(1);
    expect(discovery.skippedFixtureDirs[0]).toContain('justin-loop-e2e-a');
    expect(discovery.skippedFixtureDirs[0]).toContain('e2e-justin-loop.ts');
  });

  test('a .jsonl that is not <uuid>.jsonl is counted, not guessed at', () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    writeTranscript(h, {
      fileName: 'notes.jsonl',
      records: [userRecord('not a session', now)],
    });

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});

    expect(discovery.files).toHaveLength(1);
    expect(discovery.skippedNonSessionFiles).toBe(1);
  });

  test('an UPPERCASE uuid is still a session (63 of them exist on this machine)', () => {
    const h = harness();
    const now = new Date();
    writeTranscript(h, {
      fileName: '74A3F4F7-26B3-40F5-9616-6FDC4EF62A67.jsonl',
      records: [userRecord('hello', now)],
    });

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});

    expect(discovery.skippedNonSessionFiles).toBe(0);
    expect(discovery.files).toHaveLength(1);
  });

  test('an unreadable transcripts root is a FAILURE, never "no sessions"', async () => {
    const h = harness();
    const summary = await backfillThreads({
      days: 30,
      env: {...h.env, JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(h.root, 'gone')},
    });

    expect(summary.sessionsInWindow).toBe(0);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain('readdir');
    expect(summary.failures[0]).toContain('the scan saw NOTHING');
  });

  test('the mtime pre-filter never opens a months-old file, and says how many it skipped', () => {
    const h = harness();
    const now = new Date();
    const old = new Date(now.getTime() - 200 * DAY);
    writeSession(h, 200, {atime: old, now});
    writeSession(h, 1, {
      now,
      sessionId: '22222222-3333-4444-8555-666666666666',
    });

    const discovery = discoverSessionFiles({
      env: h.env,
      windowStart: new Date(now.getTime() - 30 * DAY),
    });

    expect(discovery.skippedOldMtime).toBe(1);
    expect(discovery.files).toHaveLength(1);
  });

  test('a transcript with no timestamp anywhere is a NAMED SKIP, never a run failure (F1)', () => {
    const h = harness();
    const path = writeTranscript(h, {
      records: [{message: {content: 'hi', role: 'user'}, type: 'user'}],
    });

    const discovery = discoverSessionFiles({env: h.env, windowStart: null});
    const scan = scanSessions(discovery.files, new Date(0));

    expect(scan.sessions).toHaveLength(0);
    expect(scan.skippedUndated).toBe(1);
    // NAMED: the count alone would leave three permanently-undated files on this
    // machine unidentifiable. NOT a failure: it does not mean the run failed.
    expect(scan.undatedFiles).toEqual([path]);
    expect(scan.failures).toEqual([]);
  });

  test('THE F1 ACCEPTANCE: an undated transcript EXITS 0 and names itself under a note', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    const undated = writeTranscript(h, {
      records: [{message: {content: 'hi', role: 'user'}, type: 'user'}],
      sessionId: '33333333-4444-4555-8666-777777777777',
    });
    const out = captureStdout();
    const err = captureStderr();

    const code = await runThreadBackfill({
      autoCommit: false,
      days: 30,
      env: h.env,
      now,
    });

    // The whole point: the daily chore is GREEN on a machine that has one of
    // these for ever, while the file is still named on every run.
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 created');
    const stderr = err.join('\n');
    expect(stderr).toContain('note: 1 transcript carries no timestamp');
    expect(stderr).toContain(undated);
    // A note, not a warning: nothing about the run went wrong.
    expect(stderr).not.toContain('⚠️');
  });

  test('the NEGATIVE CONTROL for F1: a projects root that cannot be read still EXITS 1', async () => {
    const h = harness();
    const err = captureStderr();
    captureStdout();

    const code = await runThreadBackfill({
      autoCommit: false,
      days: 30,
      env: {...h.env, JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(h.root, 'gone')},
    });

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('⚠️');
  });

  test('--json carries the undated paths, so the skip is not text-only', async () => {
    const h = harness();
    const now = new Date();
    const undated = writeTranscript(h, {
      records: [{message: {content: 'hi', role: 'user'}, type: 'user'}],
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.scan.skippedUndated).toBe(1);
    expect(summary.scan.undatedFiles).toEqual([undated]);
    expect(summary.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe('creating a backfill bead (K5)', () => {
  test('an OPEN bead, titled from the first user message, noted with the last Claude response', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 2, {
      assistant: 'Here is the status report you asked for.',
      now,
      user: 'first line of the brief\nsecond line nobody titles with',
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.created).toBe(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('no bead was created');
    // OPEN, not in_progress: this session is not running, it ended.
    expect(bead.status).toBe('open');
    expect(bead.title).toBe('first line of the brief');
    expect(bead.notes).toContain('Here is the status report you asked for.');
    expect(bead.description).toContain('BACKFILLED FROM THE TRANSCRIPT');
    expect(bead.description).toContain('claude --resume');
    const meta = metaOf(bead);
    expect(meta.source).toBe('backfill');
    expect(meta.sessionId).toBe(SESSION);
    expect(meta.reportCount).toBe(0);
    expect(meta.reportedAt).toBeNull();
    expect(meta.firstUserMessage).toContain('first line of the brief');
    expect(meta.lastAssistantMessage).toBe(
      'Here is the status report you asked for.',
    );
    expect(meta.lastActivityAt).toBe(
      new Date(now.getTime() - 2 * DAY).toISOString(),
    );
    expect(String(meta.resumeCommand)).toContain(`claude --resume ${SESSION}`);
  });

  test('a title longer than 100 characters is cut, and says it was', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now, user: 'x'.repeat(400)});

    await backfillThreads({days: 30, env: h.env, now});

    const title = threads(h)[0]?.title ?? '';
    expect(title).toHaveLength(100);
    expect(title.endsWith('…')).toBe(true);
  });

  test('a session with nothing Justin said is COUNTED and never imported', async () => {
    const h = harness();
    const now = new Date();
    writeTranscript(h, {
      records: [
        // A hook-only session: an injected reminder and Claude's reply.
        {
          cwd: CWD,
          message: {
            content: '<system-reminder>be good</system-reminder>',
            role: 'user',
          },
          sessionId: SESSION,
          timestamp: now.toISOString(),
          type: 'user',
        },
        assistantRecord('ok', now),
      ],
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.created).toBe(0);
    expect(summary.sessionsInWindow).toBe(0);
    expect(summary.scan.skippedNoUserMessage).toBe(1);
    expect(threads(h)).toHaveLength(0);
    expect(describeBackfill(summary)).toContain('1 skipped (no user message)');
  });

  test('the SECOND run creates nothing and writes nothing (idempotency)', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});

    const first = await backfillThreads({days: 30, env: h.env, now});
    expect(first.created).toBe(1);

    const logBefore = h.fake.read().log.length;
    const second = await backfillThreads({days: 30, env: h.env, now});

    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(threads(h)).toHaveLength(1);
    // Exactly ONE bd command on the second run: the single up-front list.
    expect(h.fake.read().log.length - logBefore).toBe(1);
  });

  test('--dry-run counts what it WOULD do and writes nothing at all', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});

    const summary = await backfillThreads({
      days: 30,
      dryRun: true,
      env: h.env,
      now,
    });

    expect(summary.created).toBe(1);
    expect(summary.dryRun).toBe(true);
    expect(threads(h)).toHaveLength(0);
    expect(describeBackfill(summary)).toContain('DRY RUN, nothing was written');

    // K11 (k0b8n.10): a header at column 2, then each fact at the body column
    // with a blank line between — it used to be one 250-character line.
    const lines = describeBackfill(summary).split('\n');
    expect(lines[0]).toBe('  📼 backfill — DRY RUN, nothing was written');
    expect(lines.filter((_line, index) => index % 2 === 1)).toEqual([
      '',
      '',
      '',
    ]);
    const facts = lines.filter((_line, index) => index > 0 && index % 2 === 0);
    expect(facts).toHaveLength(3);
    for (const fact of facts) expect(fact).toMatch(/^ {6}\S/u);
    expect(facts[2]).toStartWith('      message logs: ');
    expect(describeBackfill(summary)).not.toContain('\u001b');
    expect(describeBackfill(summary, {color: true, width: null})).toContain(
      '\u001b[33mDRY RUN, nothing was written\u001b[0m',
    );
  });

  test('--json still COMMITS, and its stdout is still only the JSON (D13)', async () => {
    // The exemption this replaces left beads written and uncommitted whenever
    // anything ran with --json — including the chores job, if it ever grows a
    // --json. The commit line goes to STDERR, so it was never able to corrupt
    // the document it was held back to protect.
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    const out = captureStdout();
    const err = captureStderr();

    await runThreadBackfill({
      autoCommit: true,
      days: 30,
      env: h.env,
      json: true,
      now,
    });

    // The fake threads repo is a real directory but NOT a git repo, so the
    // commit FAILS — which is the observable proof that it was attempted.
    expect(err.join('\n')).toContain('could NOT be committed');
    expect(out).toHaveLength(1);
    const parsed: unknown = JSON.parse(out[0] ?? '');
    expect((parsed as {created: number}).created).toBe(1);
  });

  test('a bd read failure is NOT RECORDED loud, and nothing is written (D5)', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});

    const summary = await backfillThreads({
      days: 30,
      env: {...h.env, JUSTIN_THREADS_REPO_DIR: join(h.root, 'not-a-workspace')},
      now,
    });

    expect(summary.created).toBe(0);
    // The sessions were still MEASURED — the failure is about bd, and saying
    // "0 sessions" here would blame the transcripts.
    expect(summary.sessionsInWindow).toBe(1);
    expect(summary.failures.join('\n')).toContain('NOT RECORDED');
  });
});

// ---------------------------------------------------------------------------
// Refreshing
// ---------------------------------------------------------------------------

describe('refreshing an existing thread (K5)', () => {
  test('a backfill bead is rewritten when the transcript ADVANCES, and not before', async () => {
    const h = harness();
    const now = new Date();
    const path = writeSession(h, 3, {now, user: 'the original brief'});

    await backfillThreads({days: 30, env: h.env, now});
    const firstNotes = threads(h)[0]?.notes ?? '';

    // Nothing new: no write.
    const quiet = await backfillThreads({days: 30, env: h.env, now});
    expect(quiet.refreshed).toBe(0);
    expect(quiet.unchanged).toBe(1);

    // The session was resumed and said more.
    writeFileSync(
      path,
      [
        JSON.stringify(
          userRecord('the original brief', new Date(now.getTime() - 3 * DAY)),
        ),
        JSON.stringify(
          assistantRecord(
            'I did the thing.',
            new Date(now.getTime() - 3 * DAY),
          ),
        ),
        JSON.stringify(userRecord('one more thing', now)),
        JSON.stringify(assistantRecord('done, here is the report', now)),
        '',
      ].join('\n'),
    );

    const advanced = await backfillThreads({days: 30, env: h.env, now});

    expect(advanced.refreshed).toBe(1);
    expect(advanced.refreshedBackfill).toBe(1);
    expect(threads(h)).toHaveLength(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    expect(bead.notes).not.toBe(firstNotes);
    expect(bead.notes).toContain('done, here is the report');
    expect(metaOf(bead).lastUserMessage).toBe('one more thing');
    expect(metaOf(bead).lastActivityAt).toBe(now.toISOString());
    // Still OPEN: a refresh must never claim the session came back to life.
    expect(bead.status).toBe('open');
    // And still titled by the FIRST message, which did not change.
    expect(bead.title).toBe('the original brief');
  });

  test('a STARTED-but-never-reported thread gets its messages and NOTHING else', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now, user: 'what the session was for'});
    // A bead as `thread start` wrote it BEFORE k0b8n.1 existed: no messages.
    h.fake.write({
      ...h.fake.read(),
      issues: [
        {
          description: 'NO REPORT YET — started but never reported.',
          id: 'jl-t9',
          metadata: {
            reportCount: 0,
            reportedAt: null,
            sessionId: SESSION,
            source: 'start',
            threadStartedAt: new Date(now.getTime() - DAY).toISOString(),
          },
          notes: 'NO REPORT YET.',
          parent: null,
          status: 'in_progress',
          title: '(untitled) pretend-repo session 7f3c1e20',
          type: 'thread',
        },
      ],
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.created).toBe(0);
    expect(summary.refreshed).toBe(1);
    expect(summary.refreshedMessages).toBe(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    // THE BODY IS THE REPORT PATH'S. Untouched, all four of them.
    expect(bead.title).toBe('(untitled) pretend-repo session 7f3c1e20');
    expect(bead.description).toBe(
      'NO REPORT YET — started but never reported.',
    );
    expect(bead.notes).toBe('NO REPORT YET.');
    expect(bead.status).toBe('in_progress');
    // The messages, and the stamp that says who filled them in.
    expect(metaOf(bead).firstUserMessage).toBe('what the session was for');
    expect(metaOf(bead).lastAssistantMessage).toBe('I did the thing.');
    expect(metaOf(bead).messagesSource).toBe('backfill');
    expect(metaOf(bead).source).toBe('start');
  });

  test('a PRE-K4 reported thread — SOME messages, not all — is refreshed even with no new activity', async () => {
    // The real case k0b8n.1 found on th-lve: every bead written before
    // 2026-09-19 carries a `lastUserMessage` (cut at 1500 chars, with raw
    // pasted_content tags) and NO `firstUserMessage` at all. Nothing about that
    // session will ever advance again, so "the transcript moved on" cannot be
    // the trigger — "any one of the K4 fields is missing" has to be, and the
    // rewrite replaces ALL of them together rather than the missing one.
    const h = harness();
    const now = new Date();
    const at = new Date(now.getTime() - DAY);
    writeSession(h, 1, {
      assistant: 'the real last response',
      now,
      user: 'the real first message',
    });
    h.fake.write({
      ...h.fake.read(),
      issues: [
        {
          description: 'the report',
          id: 'jl-t9',
          metadata: {
            lastUserMessage: 'a 1500-char truncat',
            lastUserMessageAt: at.toISOString(),
            // reportedAt EQUALS the transcript's last record, so `advanced` is
            // false and only the missing-field trigger can fire.
            reportedAt: at.toISOString(),
            sessionId: SESSION,
            source: 'report',
          },
          notes: 'the rendered report',
          parent: null,
          status: 'in_progress',
          title: 'a real report',
          type: 'thread',
        },
      ],
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.refreshed).toBe(1);
    expect(summary.refreshedMessages).toBe(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    expect(metaOf(bead).firstUserMessage).toBe('the real first message');
    // The truncated one is REPLACED, not left beside the new fields.
    expect(metaOf(bead).lastUserMessage).toBe('the real first message');
    expect(metaOf(bead).lastAssistantMessage).toBe('the real last response');
    expect(metaOf(bead).messagesSource).toBe('backfill');
    // The body still belongs to the report path.
    expect(bead.title).toBe('a real report');
    expect(bead.notes).toBe('the rendered report');
  });

  test('a reported thread that already has its messages, with no new activity, is UNTOUCHED', async () => {
    const h = harness();
    const now = new Date();
    const at = new Date(now.getTime() - DAY);
    writeSession(h, 1, {now});
    h.fake.write({
      ...h.fake.read(),
      issues: [
        {
          description: 'the report',
          id: 'jl-t9',
          metadata: {
            firstUserMessage: 'do the thing please',
            firstUserMessageAt: at.toISOString(),
            lastAssistantMessage: 'I did the thing.',
            lastAssistantMessageAt: at.toISOString(),
            lastUserMessage: 'do the thing please',
            lastUserMessageAt: at.toISOString(),
            reportedAt: now.toISOString(),
            resumeCommand: `cd '${CWD}' && claude --resume ${SESSION}`,
            sessionId: SESSION,
            source: 'report',
          },
          notes: 'the rendered report',
          parent: null,
          status: 'in_progress',
          title: 'a real report',
          type: 'thread',
        },
      ],
    });
    const logBefore = h.fake.read().log.length;

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.refreshed).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(h.fake.read().log.length - logBefore).toBe(1); // the list, nothing else
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    expect(metaOf(bead).messagesSource).toBeUndefined();
  });

  test('a field that is null because the TRANSCRIPT has none is not rewritten every run', async () => {
    // The loop this guards: "any K4 field is null" stays true forever for a
    // session Claude never answered, and that session's transcript will never
    // advance again — so the trigger fires on every tick. Without the
    // patch-equality check the hourly job would rewrite the same bytes onto the
    // same bead 24 times a day, for ever.
    const h = harness();
    const now = new Date();
    const at = new Date(now.getTime() - DAY);
    writeTranscript(h, {
      records: [userRecord('a question nobody answered', at)],
    });
    h.fake.write({
      ...h.fake.read(),
      issues: [
        {
          description: 'NO REPORT YET',
          id: 'jl-t9',
          metadata: {sessionId: SESSION, source: 'start'},
          notes: 'NO REPORT YET.',
          parent: null,
          status: 'in_progress',
          title: '(untitled) session',
          type: 'thread',
        },
      ],
    });

    const first = await backfillThreads({days: 30, env: h.env, now});
    expect(first.refreshed).toBe(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    // Still null, and honestly so — the transcript has no assistant text.
    expect(metaOf(bead).lastAssistantMessage).toBeNull();

    const logBefore = h.fake.read().log.length;
    const second = await backfillThreads({days: 30, env: h.env, now});

    expect(second.refreshed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(h.fake.read().log.length - logBefore).toBe(1); // the list, nothing else
  });

  test('a CLOSED thread is never touched, and never duplicated', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    h.fake.write({
      ...h.fake.read(),
      issues: [
        {
          closeReason: 'Justin closed it',
          description: 'done',
          id: 'jl-t9',
          metadata: {sessionId: SESSION, source: 'report'},
          notes: 'the report',
          parent: null,
          status: 'closed',
          title: 'a finished thread',
          type: 'thread',
        },
      ],
    });
    const logBefore = h.fake.read().log.length;

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.created).toBe(0);
    expect(summary.refreshed).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(threads(h)).toHaveLength(1);
    expect(threads(h)[0]?.status).toBe('closed');
    expect(threads(h)[0]?.notes).toBe('the report');
    expect(h.fake.read().log.length - logBefore).toBe(1);
  });

  test('two beads for one session is a FAILURE (D1), and nothing is written for it', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    const duplicate = (id: string): FakeIssue => ({
      description: '',
      id,
      metadata: {sessionId: SESSION, source: 'backfill'},
      notes: '',
      parent: null,
      status: 'open',
      title: id,
      type: 'thread',
    });
    h.fake.write({
      ...h.fake.read(),
      issues: [duplicate('jl-t1'), duplicate('jl-t2')],
    });

    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.created).toBe(0);
    expect(summary.refreshed).toBe(0);
    expect(summary.failures.join('\n')).toContain('D1 says one');
    expect(threads(h)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Adoption — one bead per session, whoever gets there first (D1)
// ---------------------------------------------------------------------------

describe('adoption: a backfilled session that later runs keeps ONE bead', () => {
  test('thread start ADOPTS the backfill bead in place', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now, user: 'the brief that titled it'});
    await backfillThreads({days: 30, env: h.env, now});
    const backfilled = threads(h)[0];
    if (backfilled == null) throw new Error('nothing was backfilled');

    const outcome = await startThread({
      autoCommit: false,
      cwd: h.root,
      env: h.env,
      sessionId: SESSION,
    });

    expect(outcome.kind).toBe('created');
    expect(threads(h)).toHaveLength(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    expect(bead.id).toBe(backfilled.id);
    // No longer a backfill row: the session is RUNNING and belongs on the board.
    expect(bead.status).toBe('in_progress');
    expect(metaOf(bead).source).toBe('start');
    expect(bead.description).toContain('NO REPORT YET');
    // The good title survives the adoption.
    expect(bead.title).toBe('the brief that titled it');
  });

  test('thread start leaves a CLOSED backfill bead closed', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now});
    await backfillThreads({days: 30, env: h.env, now});
    const state = h.fake.read();
    const bead = state.issues.find((issue) => issue.type === 'thread');
    if (bead == null) throw new Error('nothing was backfilled');
    bead.status = 'closed';
    h.fake.write(state);

    const outcome = await startThread({
      autoCommit: false,
      cwd: h.root,
      env: h.env,
      sessionId: SESSION,
    });

    expect(outcome.kind).toBe('existing');
    expect(threads(h)).toHaveLength(1);
    expect(threads(h)[0]?.status).toBe('closed');
  });

  test('thread report REWRITES the backfill bead: one bead, source report, in_progress', async () => {
    const h = harness();
    const now = new Date();
    writeSession(h, 1, {now, user: 'the brief'});
    await backfillThreads({days: 30, env: h.env, now});
    const backfilled = threads(h)[0];
    if (backfilled == null) throw new Error('nothing was backfilled');
    silence();

    const raw = examplePayload();
    raw.asks = [];
    raw.priorAsks = [];
    raw.title = 'the session finally reported';
    const validated = validateThreadReport(raw);
    if (validated.status !== 'ok')
      throw new Error('the example payload stopped validating');
    const ctx = bdContext(h.env);
    ctx.repoDir = h.fake.dir;
    const result = await writeReportToBd({
      ctx,
      facts: reportFacts(now),
      payload: validated.payload,
      sessionId: SESSION,
    });

    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('unreachable');
    expect(result.threadId).toBe(backfilled.id);
    expect(threads(h)).toHaveLength(1);
    const bead = threads(h)[0];
    if (bead == null) throw new Error('the bead vanished');
    expect(bead.id).toBe(backfilled.id);
    expect(bead.status).toBe('in_progress');
    expect(metaOf(bead).source).toBe('report');
    expect(metaOf(bead).messagesSource).toBe('report');
  });
});

// ---------------------------------------------------------------------------
// The board (K6)
// ---------------------------------------------------------------------------

describe('the board hides backfilled sessions by default (K6)', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const rows = () => [
    {
      id: 'jl-t1',
      metadata: {
        repo: 'home-base',
        reportedAt: '2026-09-19T11:00:00.000Z',
        source: 'report',
      },
      status: 'in_progress',
      title: 'a real report',
    },
    {
      id: 'jl-t2',
      metadata: {
        repo: 'home-base',
        source: 'backfill',
        startedAt: '2026-09-18T11:00:00.000Z',
      },
      status: 'open',
      // Deliberately does NOT contain the word "backfill": the tag assertion
      // below has to come from the renderer, not from the title.
      title: 'a session that ended quietly',
    },
  ];

  test('by default the backfilled row is folded away and COUNTED', () => {
    const data = buildBoard(rows(), [], now);

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.id).toBe('jl-t1');
    expect(data.hiddenBackfilled).toBe(1);
    expect(data.hiddenContinued).toBe(0);
  });

  test('--all shows it, tagged so it is not mistaken for a live session', () => {
    const data = buildBoard(rows(), [], now, {includeBackfilled: true});
    expect(data.rows).toHaveLength(2);
    expect(data.hiddenBackfilled).toBe(0);
    expect(data.rows.find((row) => row.id === 'jl-t2')?.backfilled).toBe(true);

    const rendered = renderByRepo(data, 'thread');
    expect(rendered).toContain('a session that ended quietly');
    // The TAG, from the renderer — and not the "no report yet" row a
    // start-only thread gets, which would say a session is still in flight.
    expect(rendered).toContain('📼 backfill');
    expect(rendered).not.toContain('no report yet');
  });

  test('a backfilled thread with an OPEN ASK is never hidden', () => {
    const data = buildBoard(
      rows(),
      [
        {
          id: 'jl-t2.1',
          metadata: {priority: 0},
          parent: 'jl-t2',
          status: 'open',
          title: 'answer me',
        },
      ],
      now,
    );

    expect(data.rows).toHaveLength(2);
    expect(data.hiddenBackfilled).toBe(0);
  });

  test('the count line names the flag that shows them', () => {
    expect(backfilledHiddenLine(0)).toBeNull();
    expect(backfilledHiddenLine(1)).toBe(
      '1 backfilled session hidden (--all shows them)',
    );
    expect(backfilledHiddenLine(7)).toBe(
      '7 backfilled sessions hidden (--all shows them)',
    );
  });
});
