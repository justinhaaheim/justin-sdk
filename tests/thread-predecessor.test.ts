/**
 * D18 — a justin-loop successor links to its predecessor's thread without
 * anyone typing an id (home-base-k0b8n.5).
 *
 * `continuesFrom` takes a THREAD BEAD id. A successor session cannot know one:
 * what the runner can give it is its predecessor's CLAUDE SESSION id, on
 * `JUSTIN_LOOP_PREDECESSOR_SESSION_ID`. These tests cover the bridge between the
 * two and the three outcomes it must keep apart:
 *
 *   found          link exactly as `--continues-from <bead>` would have.
 *   notFound       bd was read; there is no thread for that session. UNLINKED,
 *                  said by name, report still written.
 *   lookupFailed   bd could not be read. UNLINKED, said DIFFERENTLY, report
 *                  still written.
 *
 * NEITHER MISS MAY REFUSE. `refusedContinuation` exists for an EXPLICIT
 * `continuesFrom` naming a bad bead, where a typo would silently swallow the
 * asks the feature carries. Nobody typed this one, and throwing away a status
 * report because a predecessor could not be looked up is the worse error.
 *
 * Driven against the real subprocess fake (tests/fake-bd.ts) and through
 * `runThreadReport` itself rather than `writeReportToBd`, because the thing
 * being proved is the WIRING — that the environment variable reaches the bd
 * write at all — and a test that called the resolver itself and then handed the
 * answer to the writer would prove only that the test can do it.
 *
 * NEGATIVE CONTROLS: recorded on home-base-k0b8n.5.
 */

import type {ThreadReportPayload} from '../src/thread/schema';

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {type OutputStyle, PLAIN_STYLE} from '../src/cli-style';
import {reportsDir} from '../src/thread/archive';
import {bdContext} from '../src/thread/bd';
import {
  applyPredecessor,
  linkArchivedPredecessor,
  lookupFailedLine,
  notFoundLine,
  PREDECESSOR_SESSION_ENV,
  predecessorSessionId,
  resolvePredecessor,
} from '../src/thread/predecessor';
import {runThreadPrepare} from '../src/thread/prepare';
import {compactStoredReport} from '../src/thread/render-markdown';
import {runThreadReport} from '../src/thread/report';
import {createFakeBd, type FakeIssue, type FakeState} from './fake-bd';
import {examplePayload} from './thread-schema.test';

const OLD_SESSION = 'sess-old-uuid-0001';
const OLD_THREAD = 'jl-old';
const OLD_ASK = 'jl-old.1';
const SESSION = 'sess-new-uuid-0002';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedPredecessor(): FakeIssue[] {
  return [
    {
      description: 'GOAL: the arc\nYOU ASKED ME TO: start it',
      id: OLD_THREAD,
      metadata: {
        askIds: [OLD_ASK],
        reportCount: 3,
        reportedAt: '2026-09-18T22:00:00.000Z',
        sessionId: OLD_SESSION,
      },
      notes: 'the old report',
      parent: null,
      status: 'in_progress',
      title: 'the session that started this arc',
      type: 'thread',
    },
    {
      description: [
        '[Answer] Paste the exact error text?',
        '',
        'CONTEXT: it came up in the last session',
        '',
        'IF UNANSWERED: I leave it open.',
        '',
        `Thread: ${OLD_THREAD}`,
      ].join('\n'),
      id: OLD_ASK,
      metadata: {
        askIndex: 0,
        defaultAction: 'I leave it open.',
        kind: 'answer',
        priority: 3,
        reportCount: 3,
        threadId: OLD_THREAD,
      },
      notes: '',
      parent: OLD_THREAD,
      status: 'open',
      title: 'Paste the exact error text?',
      type: 'ask',
    },
  ] as FakeIssue[];
}

interface Fixture {
  env: Record<string, string | undefined>;
  fake: ReturnType<typeof createFakeBd>;
  payloadPath: string;
  stateDir: string;
}

const noop = (): void => {
  /* the report's own output is captured, not printed */
};

function fixture(options: {
  continuesFrom?: string | null;
  failLookupFor?: string | null;
  predecessorSession?: string | null;
  seed?: boolean;
}): Fixture {
  const fake = createFakeBd();
  const state: FakeState = fake.read();
  state.issues = options.seed === false ? [] : seedPredecessor();
  state.failThreadLookupFor = options.failLookupFor ?? null;
  fake.write(state);

  const stateDir = mkdtempSync(join(tmpdir(), 'thread-pred-state-'));
  const payload = examplePayload();
  payload.continuesFrom = options.continuesFrom ?? null;
  payload.priorAsks = [];
  const payloadPath = join(stateDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload));

  // `prepare` is knob-gated and prints DISABLED before it does any work, so the
  // fixture cwd carries a project config that turns the knob on. `report` is
  // not gated and ignores this.
  writeFileSync(
    join(stateDir, 'justin-sdk.config.json'),
    JSON.stringify({componentConfig: {thread: {enabled: true}}}),
  );

  const env: Record<string, string | undefined> = {
    ...fake.env,
    CLAUDE_CODE_SESSION_ID: SESSION,
    JUSTIN_THREADS_REPO_DIR: fake.dir,
    JUSTIN_THREADS_STATE_DIR: stateDir,
    // The user-level config layer must not reach into this fixture: the machine
    // running the test has a real one, and it would decide the knob.
    XDG_CONFIG_HOME: join(stateDir, 'xdg'),
  };
  if (options.predecessorSession != null) {
    env[PREDECESSOR_SESSION_ENV] = options.predecessorSession;
  } else {
    delete env[PREDECESSOR_SESSION_ENV];
  }
  return {env, fake, payloadPath, stateDir};
}

interface ReportRun {
  exitCode: number;
  stderr: string;
}

async function report(
  f: Fixture,
  options: {continuesFromSession?: string | null} = {},
): Promise<ReportRun> {
  let stderr = '';
  const realError = console.error;
  const realLog = console.log;
  console.error = (...parts: unknown[]) => {
    stderr += `${parts.map(String).join(' ')}\n`;
  };
  console.log = noop;
  try {
    const exitCode = await runThreadReport({
      autoCommit: false,
      continuesFromSession: options.continuesFromSession ?? null,
      cwd: f.stateDir,
      env: f.env,
      file: f.payloadPath,
      sessionId: SESSION,
    });
    return {exitCode, stderr};
  } finally {
    console.error = realError;
    console.log = realLog;
  }
}

/**
 * The PAYLOAD SKELETON only — the half a session actually copies.
 *
 * Asserting on the whole of `prepare`'s output is not enough: the "THREAD THIS
 * SESSION CONTINUES" prose prints `"continuesFrom": "<id>"` too, so a check
 * over the full text passes on a skeleton that was never prefilled. Measured:
 * the negative control that blanked the skeleton reddened NOTHING until this
 * slice existed.
 */
function skeletonOf(stdout: string): string {
  const at = stdout.indexOf('WRITE YOUR PAYLOAD, THEN REPORT');
  if (at < 0) throw new Error('prepare printed no payload section');
  return stdout.slice(at);
}

async function prepare(
  f: Fixture,
  options: {
    continuesFrom?: string | null;
    continuesFromSession?: string;
    style?: OutputStyle;
  } = {},
): Promise<{exitCode: number; stdout: string}> {
  let stdout = '';
  const realLog = console.log;
  console.log = (...parts: unknown[]) => {
    stdout += `${parts.map(String).join(' ')}\n`;
  };
  try {
    const exitCode = await runThreadPrepare({
      continuesFrom: options.continuesFrom ?? null,
      continuesFromSession: options.continuesFromSession ?? null,
      cwd: f.stateDir,
      env: f.env,
      sessionId: SESSION,
      // Pinned, so a run from a terminal renders exactly what CI does.
      style: options.style ?? PLAIN_STYLE,
    });
    return {exitCode, stdout};
  } finally {
    console.log = realLog;
  }
}

function threadOf(f: Fixture): FakeIssue | undefined {
  return f.fake
    .read()
    .issues.find(
      (row) =>
        row.type === 'thread' &&
        row.metadata?.sessionId === SESSION &&
        row.id !== OLD_THREAD,
    );
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

describe('predecessorSessionId: the flag wins, the environment is the fallback', () => {
  test('the flag is used when it is given', () => {
    expect(
      predecessorSessionId('from-flag', {
        [PREDECESSOR_SESSION_ENV]: 'from-env',
      }),
    ).toBe('from-flag');
  });

  test('the environment is used when the flag is absent', () => {
    expect(
      predecessorSessionId(null, {[PREDECESSOR_SESSION_ENV]: 'from-env'}),
    ).toBe('from-env');
  });

  test('an EMPTY value on either side is null, never a session id', () => {
    // `''` is not a session id. Treating it as one would send the resolver
    // looking up a session that cannot exist and report the miss as a fact
    // about a real predecessor (critical rule 7).
    expect(predecessorSessionId('  ', {[PREDECESSOR_SESSION_ENV]: '  '})).toBe(
      null,
    );
    expect(predecessorSessionId(null, {})).toBe(null);
    expect(predecessorSessionId('  ', {[PREDECESSOR_SESSION_ENV]: 'x'})).toBe(
      'x',
    );
  });
});

describe('resolvePredecessor: three outcomes, three facts', () => {
  test('none — nothing named a predecessor', async () => {
    const f = fixture({});
    const ctx = bdContext(f.env);
    ctx.repoDir = f.fake.dir;
    expect((await resolvePredecessor({ctx, env: f.env})).kind).toBe('none');
  });

  test('found — the predecessor’s thread bead', async () => {
    const f = fixture({predecessorSession: OLD_SESSION});
    const ctx = bdContext(f.env);
    ctx.repoDir = f.fake.dir;
    const link = await resolvePredecessor({ctx, env: f.env});
    expect(link.kind).toBe('found');
    if (link.kind !== 'found') throw new Error('unreachable');
    expect(link.threadId).toBe(OLD_THREAD);
    expect(link.sessionId).toBe(OLD_SESSION);
  });

  test('notFound — bd was read and holds no thread for that session', async () => {
    const f = fixture({predecessorSession: 'sess-that-never-reported'});
    const ctx = bdContext(f.env);
    ctx.repoDir = f.fake.dir;
    const link = await resolvePredecessor({ctx, env: f.env});
    expect(link.kind).toBe('notFound');
    if (link.kind !== 'notFound') throw new Error('unreachable');
    expect(link.line).toContain('has no thread bead');
    expect(link.line).toContain('not linked');
    expect(link.line).toContain('sess-that-never-reported');
  });

  test('lookupFailed — bd could not be read, and it does NOT say "no thread"', async () => {
    const f = fixture({
      failLookupFor: OLD_SESSION,
      predecessorSession: OLD_SESSION,
    });
    const ctx = bdContext(f.env);
    ctx.repoDir = f.fake.dir;
    const link = await resolvePredecessor({ctx, env: f.env});
    expect(link.kind).toBe('lookupFailed');
    if (link.kind !== 'lookupFailed') throw new Error('unreachable');
    expect(link.line).toContain('could not look up predecessor session');
    expect(link.line).toContain('not linked');
    // THE WHOLE POINT: it must not be sayable as the other miss. A failed
    // lookup reported as "there is no thread" is a fabricated measurement.
    expect(link.line).not.toBe(notFoundLine(OLD_SESSION));
    expect(link.line).not.toContain('has no thread bead');
  });

  test('the two miss lines are different sentences', () => {
    expect(notFoundLine('s')).not.toBe(lookupFailedLine('s', 'bd exploded'));
  });
});

describe('applyPredecessor: an explicit continuesFrom always wins', () => {
  test('an explicit id beats a resolved one, and says it ignored it', () => {
    const applied = applyPredecessor('jl-typed', {
      issue: {id: OLD_THREAD} as never,
      kind: 'found',
      sessionId: OLD_SESSION,
      threadId: OLD_THREAD,
    });
    expect(applied.continuesFrom).toBe('jl-typed');
    expect(applied.note).toContain('given explicitly');
    expect(applied.note).toContain(OLD_SESSION);
  });

  test('a miss leaves continuesFrom null and carries its own line', () => {
    for (const kind of ['notFound', 'lookupFailed'] as const) {
      const applied = applyPredecessor(null, {
        kind,
        line: `the ${kind} line`,
        sessionId: OLD_SESSION,
      });
      expect(applied.continuesFrom).toBe(null);
      expect(applied.note).toBe(`the ${kind} line`);
    }
  });

  test('nothing named a predecessor: no link and nothing to say', () => {
    expect(applyPredecessor(null, {kind: 'none'})).toEqual({
      continuesFrom: null,
      note: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The wiring, through `thread prepare` itself
// ---------------------------------------------------------------------------

describe('thread prepare prefills continuesFrom from the predecessor (D18)', () => {
  test('the env var prefills the skeleton and lists the predecessor’s asks', async () => {
    const f = fixture({predecessorSession: OLD_SESSION});
    const run = await prepare(f);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('THREADS: ENABLED');
    expect(run.stdout).toContain('PREDECESSOR SESSION');
    expect(run.stdout).toContain(
      `continuesFrom ${OLD_THREAD}, resolved from predecessor session ${OLD_SESSION}`,
    );
    // The PAYLOAD SKELETON is prefilled — that is the half that reaches the
    // report, and a section the session reads but never copies changes nothing.
    expect(skeletonOf(run.stdout)).toContain(
      `"continuesFrom": "${OLD_THREAD}"`,
    );
    // …and the predecessor's still-open ask is on screen as one to disposition.
    expect(run.stdout).toContain('Paste the exact error text?');
  });

  test('--continues-from-session does the same thing', async () => {
    const f = fixture({});
    const run = await prepare(f, {continuesFromSession: OLD_SESSION});
    expect(skeletonOf(run.stdout)).toContain(
      `"continuesFrom": "${OLD_THREAD}"`,
    );
  });

  test('NOT FOUND is named and prepare still prints a skeleton', async () => {
    const f = fixture({predecessorSession: 'sess-that-never-reported'});
    const run = await prepare(f);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('has no thread bead');
    expect(skeletonOf(run.stdout)).toContain('"continuesFrom": null');
    expect(run.stdout).not.toContain('Paste the exact error text?');
  });

  test('an explicit --continues-from still wins over the env var', async () => {
    const f = fixture({predecessorSession: 'sess-that-never-reported'});
    const run = await prepare(f, {continuesFrom: OLD_THREAD});
    expect(skeletonOf(run.stdout)).toContain(
      `"continuesFrom": "${OLD_THREAD}"`,
    );
    expect(run.stdout).toContain('given explicitly');
  });

  test('NEGATIVE CONTROL: with no predecessor the skeleton is unlinked and silent', async () => {
    const f = fixture({});
    const run = await prepare(f);
    expect(skeletonOf(run.stdout)).toContain('"continuesFrom": null');
    expect(run.stdout).not.toContain('PREDECESSOR SESSION');
  });

  test('K11: the FIRST line stays byte-exact under colour, and every section is a spaced header', async () => {
    // The rule text branches on `THREADS: ENABLED` as the first line, so the
    // man-page restyle (k0b8n.10) must never paint, indent or prefix it.
    const f = fixture({});
    const painted = await prepare(f, {style: {color: true, width: 100}});
    expect(painted.stdout.split('\n')[0]).toBe('THREADS: ENABLED');
    expect(painted.stdout).toContain('\u001b[1;35mTHIS SESSION’S THREAD');
    const plain = await prepare(f);
    expect(plain.stdout.split('\n')[0]).toBe('THREADS: ENABLED');
    expect(plain.stdout).not.toContain('\u001b');
    // Headers at column 2 with a blank line under each; the skeleton's JSON
    // stays at column 0 so it copies into a file verbatim.
    expect(plain.stdout).toContain('\n  🧵 THIS SESSION’S THREAD\n\n      ');
    expect(plain.stdout).toContain('\n\n{\n');
    // The guidance is spaced and unwrapped: one sentence per line.
    expect(plain.stdout).toContain(
      '\n      Most things are not must-see. Demote what is not. A compact report that is long is a compact report he stops reading.\n',
    );
    expect(plain.stdout).toContain(
      '\n      P0 — I cannot proceed without this\n\n      P1 — ',
    );
  });
});

// ---------------------------------------------------------------------------
// The wiring, through `thread report` itself
// ---------------------------------------------------------------------------

describe('thread report links through the environment (D18)', () => {
  test('a found predecessor links exactly like --continues-from', async () => {
    const f = fixture({predecessorSession: OLD_SESSION});
    const run = await report(f);
    expect(run.exitCode).toBe(0);

    const thread = threadOf(f);
    expect(thread).toBeDefined();
    expect(thread?.metadata?.continuesFrom).toBe(OLD_THREAD);

    // …and the D21 union actually ran: the predecessor's open ask was in this
    // report's coverage set, so it was closed rather than left stranded on a
    // thread nobody will look at again.
    const oldAsk = f.fake.read().issues.find((row) => row.id === OLD_ASK);
    expect(oldAsk?.status).toBe('closed');

    // AC4: the STORED report — which is what `thread show` prints verbatim —
    // names the predecessor, and survives the compaction `show` applies.
    const notes = thread?.notes ?? '';
    expect(notes).toContain(`Continues from:** ${OLD_THREAD}`);
    expect(compactStoredReport(notes)).toContain(
      `Continues from:** ${OLD_THREAD}`,
    );
  });

  test('--continues-from-session does the same thing, explicitly', async () => {
    const f = fixture({});
    const run = await report(f, {continuesFromSession: OLD_SESSION});
    expect(run.exitCode).toBe(0);
    expect(threadOf(f)?.metadata?.continuesFrom).toBe(OLD_THREAD);
  });

  test('NOT FOUND is named and the report is written UNLINKED', async () => {
    const f = fixture({predecessorSession: 'sess-that-never-reported'});
    const run = await report(f);
    // Written, not refused. Exit 2 is the refusal code; this path must not use it.
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('has no thread bead');
    expect(run.stderr).toContain('sess-that-never-reported');
    expect(run.stderr).not.toContain('REFUSED');
    const thread = threadOf(f);
    expect(thread).toBeDefined();
    expect(thread?.metadata?.continuesFrom ?? null).toBe(null);
    // The predecessor's ask is untouched: nothing claimed to carry it.
    expect(f.fake.read().issues.find((row) => row.id === OLD_ASK)?.status).toBe(
      'open',
    );
  });

  test('LOOKUP FAILED is named DIFFERENTLY and the report is still written', async () => {
    const f = fixture({
      failLookupFor: OLD_SESSION,
      predecessorSession: OLD_SESSION,
    });
    const run = await report(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('could not look up predecessor session');
    expect(run.stderr).not.toContain('has no thread bead');
    expect(run.stderr).not.toContain('REFUSED');
    expect(threadOf(f)?.metadata?.continuesFrom ?? null).toBe(null);
  });

  test('a payload continuesFrom WINS over the environment', async () => {
    // Both are present and they disagree. The typed one is someone saying it on
    // purpose; the variable is the runner saying it automatically.
    const f = fixture({
      continuesFrom: OLD_THREAD,
      predecessorSession: 'sess-that-never-reported',
    });
    const run = await report(f);
    expect(run.exitCode).toBe(0);
    expect(threadOf(f)?.metadata?.continuesFrom).toBe(OLD_THREAD);
    // And it did not quietly also complain about the predecessor it ignored.
    expect(run.stderr).not.toContain('has no thread bead');
    expect(run.stderr).toContain('given explicitly');
  });

  test('NEGATIVE CONTROL: with no predecessor at all, nothing is linked and nothing is said', async () => {
    const f = fixture({});
    const run = await report(f);
    expect(run.exitCode).toBe(0);
    expect(threadOf(f)?.metadata?.continuesFrom ?? null).toBe(null);
    expect(run.stderr).not.toContain('predecessor');
    expect(f.fake.read().issues.find((row) => row.id === OLD_ASK)?.status).toBe(
      'open',
    );
  });
});

// ---------------------------------------------------------------------------
// The link SURVIVES the spool (home-base-685h F9)
//
// `thread report` resolves the predecessor AFTER the archive, and that ordering
// is deliberate: archive-before-bd is the rule-6 property report.ts exists to
// guarantee, and `runBd` is an unbounded spawnSync, so a hung bd must cost the
// link and not the payload. The consequence was that a report bd REFUSED and
// that `thread board` drained later was written unlinked — the environment that
// carried the predecessor id is gone by then, and nothing anywhere recorded that
// a link had been intended.
// ---------------------------------------------------------------------------

describe('F9: the archived payload carries the predecessor SESSION id', () => {
  /** The one archived payload this fixture's report wrote. */
  function archived(f: Fixture): Record<string, unknown> {
    const dir = reportsDir(SESSION, f.env);
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    const [only] = files;
    if (only == null) throw new Error(`no archived report in ${dir}`);
    const doc = JSON.parse(readFileSync(join(dir, only), 'utf8')) as {
      payload: Record<string, unknown>;
    };
    return doc.payload;
  }

  test('a report run with the env var archives the session id', async () => {
    const f = fixture({predecessorSession: OLD_SESSION});
    const run = await report(f);
    expect(run.exitCode).toBe(0);
    expect(archived(f).continuesFromSession).toBe(OLD_SESSION);
  });

  test('the flag is archived too, and wins over the environment', async () => {
    const f = fixture({predecessorSession: 'sess-from-the-env'});
    const run = await report(f, {continuesFromSession: OLD_SESSION});
    expect(run.exitCode).toBe(0);
    expect(archived(f).continuesFromSession).toBe(OLD_SESSION);
  });

  test('with no predecessor it is null — never an empty string', async () => {
    const f = fixture({});
    await report(f);
    expect(archived(f).continuesFromSession).toBeNull();
  });
});

describe('F9: a drained payload resolves its own predecessor', () => {
  function ctxOf(f: Fixture): ReturnType<typeof bdContext> {
    const ctx = bdContext(f.env);
    ctx.repoDir = f.fake.dir;
    return ctx;
  }

  function payloadWith(session: string | null): ThreadReportPayload {
    const payload = examplePayload();
    payload.continuesFrom = null;
    payload.continuesFromSession = session;
    payload.priorAsks = [];
    return payload as unknown as ThreadReportPayload;
  }

  test('FOUND — the archived session id becomes continuesFrom', async () => {
    const f = fixture({});
    const linked = await linkArchivedPredecessor(
      payloadWith(OLD_SESSION),
      ctxOf(f),
    );
    expect(linked.payload.continuesFrom).toBe(OLD_THREAD);
    expect(linked.note).toContain('resolved from predecessor session');
  });

  test('NOT FOUND — it proceeds unlinked, with the named line', async () => {
    const f = fixture({});
    const linked = await linkArchivedPredecessor(
      payloadWith('sess-that-never-reported'),
      ctxOf(f),
    );
    expect(linked.payload.continuesFrom ?? null).toBeNull();
    expect(linked.note).toBe(notFoundLine('sess-that-never-reported'));
  });

  test('LOOKUP FAILED — a DIFFERENT line, and still unlinked', async () => {
    // The distinction the whole module exists for: "the predecessor has no
    // thread" is a measurement, "I could not look" is not.
    const f = fixture({failLookupFor: OLD_SESSION});
    const linked = await linkArchivedPredecessor(
      payloadWith(OLD_SESSION),
      ctxOf(f),
    );
    expect(linked.payload.continuesFrom ?? null).toBeNull();
    expect(linked.note).toContain('could not look up predecessor session');
    expect(linked.note).not.toContain('has no thread bead');
  });

  test('NEGATIVE CONTROL: no archived session id means no bd call at all', async () => {
    const f = fixture({});
    const before = f.fake.read().log.length;
    const linked = await linkArchivedPredecessor(payloadWith(null), ctxOf(f));
    expect(linked.payload.continuesFrom ?? null).toBeNull();
    expect(linked.note).toBeNull();
    expect(f.fake.read().log.length).toBe(before);
  });

  test('an EXPLICIT continuesFrom wins, and nothing is looked up underneath it', async () => {
    const f = fixture({});
    const payload = payloadWith(OLD_SESSION);
    payload.continuesFrom = 'th-typed-by-hand';
    const before = f.fake.read().log.length;
    const linked = await linkArchivedPredecessor(payload, ctxOf(f));
    expect(linked.payload.continuesFrom).toBe('th-typed-by-hand');
    expect(f.fake.read().log.length).toBe(before);
  });

  test('the DRAINING session’s own environment is never consulted', async () => {
    // The hazard this guards: a drain runs in whatever session is draining, and
    // that session may have a predecessor of its own. Reading the ambient
    // variable would link someone else's report to it — a fabricated fact.
    const f = fixture({predecessorSession: OLD_SESSION});
    const linked = await linkArchivedPredecessor(payloadWith(null), ctxOf(f));
    expect(linked.payload.continuesFrom ?? null).toBeNull();
    expect(linked.note).toBeNull();
  });
});
