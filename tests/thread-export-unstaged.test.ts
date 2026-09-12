/**
 * A bd write that LANDED and then failed only while exporting (home-base-p1uj.10).
 *
 * THE BUG. In the Claude Code sandbox with `~/Dev/life/.beads` allowlisted and
 * `~/Dev/life/.git` not, bd creates the bead in Dolt, then its auto-export
 * `git add` is refused and bd exits 1. The adapter called that a failed write,
 * so `thread report` printed NOT RECORDED, spooled the payload and exited 1 —
 * while the thread bead existed. The next `board` drain re-applied the spool,
 * closing the "orphan" asks and creating them again: every in-sandbox report
 * doubled its asks and lied about having recorded nothing.
 *
 * MEASURED 2026-09-12 (bd 1.1.0, sandbox on, `bd create … --silent`): exit 1,
 * stdout `jl-rg5a.1`, stderr the auto-export/index.lock text the fake emits
 * verbatim below. The bead was there afterwards.
 */

import {describe, expect, test} from 'bun:test';

import {bdContext, isExportOnlyFailure} from '../src/thread/bd';
import {createFakeBd} from './fake-bd';
import {validateThreadReport} from '../src/thread/schema';
import {writeReportToBd} from '../src/thread/report';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

const SESSION = 'sess-export-unstaged';

/** The exact stderr bd 1.1.0 prints when its auto-export git add is refused. */
const REAL_STDERR = [
  'beads: auto-export warning: no Dolt remote configured.',
  'beads: .beads/issues.jsonl is an export, not cross-machine sync or source of truth.',
  "beads: repair: add a git origin, then run 'bd dolt remote add origin <git-remote-url>' and 'bd dolt push'.",
  "Error: auto-export: git add failed: exit status 128: fatal: Unable to create '/Users/jhaa/Dev/life/.git/index.lock': Operation not permitted",
  'error: "bd" exited with code 1',
].join('\n');

function facts(): ThreadFacts {
  return {
    aheadBehind: {ahead: 0, behind: 0},
    autofillFailures: [],
    branch: 'thread-answer-feedback',
    cwd: '/tmp',
    dirty: false,
    entrypoint: 'cli',
    headSha: 'abc123',
    isWorktree: false,
    lastUserMessage: 'go',
    model: 'claude-opus-5',
    reportedAt: '2026-09-12T19:00:00.000Z',
    repo: 'justin-sdk',
    repoPath: '/tmp',
    sessionId: SESSION,
    startedAt: '2026-09-12T18:00:00.000Z',
    tokensAtStop: 1,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

function payload(): ThreadReportPayload {
  const raw = examplePayload();
  raw.priorAsks = [];
  const validated = validateThreadReport(raw);
  if (validated.status !== 'ok') throw new Error('fixture payload is invalid');
  return validated.payload;
}

describe('isExportOnlyFailure', () => {
  test('the measured auto-export stderr is a post-write failure', () => {
    expect(isExportOnlyFailure(REAL_STDERR)).toBe(true);
  });

  test('a bare EPERM is NOT — that is a refused write', () => {
    // This is what the sandbox refusing Dolt's own LOCK looks like. Reading it
    // as "recorded" would be the exact inversion this bug was.
    expect(isExportOnlyFailure('openat LOCK: operation not permitted')).toBe(
      false,
    );
    expect(isExportOnlyFailure('')).toBe(false);
  });

  test('a lock message is NOT, even alongside the word export', () => {
    expect(
      isExportOnlyFailure(
        'beads: export complete\nembeddeddolt: another process holds the exclusive lock',
      ),
    ).toBe(false);
  });

  test('BOTH halves are required — an auto-export mention alone is not enough', () => {
    expect(
      isExportOnlyFailure(
        'beads: auto-export warning: no Dolt remote configured.',
      ),
    ).toBe(false);
  });
});

describe('a report whose every write dies in auto-export', () => {
  test('is RECORDED, with the export flagged — not spooled as a failure', async () => {
    const fake = createFakeBd(0, null, true);
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;

    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payload(),
      sessionId: SESSION,
    });

    // `written` is what keeps the payload out of the spool, so the next board
    // drain cannot re-apply it and double the asks.
    expect(outcome.status).toBe('written');
    // And the state it left behind is NAMED, not silent.
    expect(ctx.exportUnstaged).toBe(true);

    const issues = fake.read().issues;
    expect(issues.filter((issue) => issue.type === 'thread')).toHaveLength(1);
    expect(issues.filter((issue) => issue.type === 'ask')).toHaveLength(2);
  });

  test('a genuinely refused write is still a failure', async () => {
    // Same fake, same non-zero exit — but the stderr is a refusal, not an
    // export miss. The loud path has to survive the fix.
    const fake = createFakeBd(1, null, false); // the 1st `create -t ask` dies
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;

    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payload(),
      sessionId: SESSION,
    });

    expect(outcome.status).toBe('bdFailed');
    expect(ctx.exportUnstaged).toBe(false);
  });
});
