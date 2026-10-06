/**
 * `thread show` on a backfill body that QUOTES a status report
 * (home-base-k0b8n.20).
 *
 * A backfill body is the session's last Claude response, verbatim, and that
 * response is often a status report. Its 🛑 rule and ⚡ glance made
 * `isRenderedReport` true, so `show` printed a bead that records zero reports
 * as a stored report, and the compact view turned the quote into "nothing needs
 * you — nothing went wrong" and "NOT RECORDED — no thread bead". The fix reuses
 * k0b8n.19's `backfillOwnership`: an `owned` body is never a report. Every
 * other verdict keeps the k0b8n.14 rule, which these tests also pin.
 *
 * The bead is built with backfill's own builders (`backfillDescription`,
 * `backfillNotes`, `backfillMetadata`), so the fixture has the shape backfill
 * writes rather than a copy of it.
 */

import type {BackfillSession} from '../src/thread/backfill';

import {describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {BODY_COLUMN} from '../src/cli-style';
import {
  backfillDescription,
  backfillMetadata,
  backfillNotes,
} from '../src/thread/backfill';
import {backfillOwnership} from '../src/thread/backfill-ownership';
import {
  NO_REPORT_GLANCE,
  renderStoredNotes,
  runThreadShow,
  showsNotesAsReport,
} from '../src/thread/show';
import {createFakeBd, type FakeIssue} from './fake-bd';

/**
 * A v2 status report, as a session's last message. Lines are kept short so a
 * run on a real terminal (where `show` wraps to its width) prints them whole.
 */
const QUOTED_REPORT = [
  '🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑',
  '',
  '⚡ ✅ Work completed · 🙋 answers · 📈 90% · 🛑 1 P0 ask',
  '',
  '**Thread:** the quoted arc',
  '',
  '**Stop reason:** The gates are green.',
  '',
  '**What I did:**',
  '',
  '- ✅ Built the quoted thing',
  '',
  '**Asks — everything I need from you:**',
  '',
  '  1. 🛑 P0 · [Approve Y/n] Ship it? (th-q1.1)',
  '',
  "     If you don't answer: I stop here.",
  '',
  'Answer: bun run justin-sdk thread answer th-q1',
  '🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️',
].join('\n');

const SESSION_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * A finished session, as far as the three body builders read one. The cast is
 * the local idiom for a partial fixture: every field they read is here.
 */
function session(lastAssistantMessage: string): BackfillSession {
  return {
    lastTimestamp: '2026-09-24T18:00:00.000Z',
    messages: {
      cwd: '/Users/jhaa/Dev/pretend-repo',
      failures: [],
      firstCwd: '/Users/jhaa/Dev/pretend-repo',
      firstTimestamp: '2026-09-24T17:00:00.000Z',
      firstUserMessage: 'Build the quoted thing',
      gitBranch: 'main',
      lastAssistantMessage,
      lastUserMessage: 'go',
      resumeCommand: `cd /Users/jhaa/Dev/pretend-repo && claude --resume ${SESSION_ID}`,
    },
    projectDir: '/p',
    sessionId: SESSION_ID,
    transcriptPath: '/t.jsonl',
  } as unknown as BackfillSession;
}

const GIT = {
  branch: 'main',
  repo: 'pretend-repo',
  repoPath: '/Users/jhaa/Dev/pretend-repo',
};

/** The thread bead `thread backfill` writes for a session that never reported. */
function backfillBead(lastAssistantMessage = QUOTED_REPORT): FakeIssue {
  const s = session(lastAssistantMessage);
  return {
    description: backfillDescription(s, GIT),
    id: 'th-bf1',
    metadata: backfillMetadata(s, GIT),
    notes: backfillNotes(s),
    parent: null,
    status: 'open',
    title: 'Build the quoted thing',
    type: 'thread',
  };
}

/**
 * One state dir for every run in this file, so the compact and --full outputs
 * name the same (absent) message log path and can be compared whole.
 */
const ROOT = mkdtempSync(join(tmpdir(), 'thread-show-backfill-'));

/** What `thread show <id>` prints against a fake bd holding `issue`. */
async function show(issue: FakeIssue, full: boolean): Promise<string> {
  const fake = createFakeBd();
  const state = fake.read();
  state.issues = [issue];
  fake.write(state);
  const printed: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation(
    (...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '));
    },
  );
  try {
    await runThreadShow({
      env: {
        ...fake.env,
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        JUSTIN_THREADS_REPO_DIR: fake.dir,
        JUSTIN_THREADS_STATE_DIR: join(ROOT, 'state'),
        XDG_CONFIG_HOME: join(ROOT, 'xdg'),
      },
      full,
      threadId: issue.id,
    });
  } finally {
    spy.mockRestore();
  }
  return Bun.stripANSI(printed.join('\n'));
}

/** The notes as the "not a report" path prints them: verbatim, body-indented. */
function asPlainNotes(notes: string): string[] {
  return notes
    .split('\n')
    .map((line) => (line === '' ? '' : `${' '.repeat(BODY_COLUMN)}${line}`));
}

describe('a backfill body quoting a report is not a report (k0b8n.20)', () => {
  const bead = backfillBead();

  test('the fixture is the case: owned by backfill, notes that look rendered', () => {
    expect(backfillOwnership(bead)).toEqual({kind: 'owned'});
    expect(bead.metadata?.reportCount).toBe(0);
    expect(bead.notes).toStartWith('LAST CLAUDE RESPONSE (verbatim):\n\n🛑');
    expect(showsNotesAsReport(bead)).toBe(false);
  });

  test('renderStoredNotes prints "no report yet" and the notes unstyled, compact and --full alike', () => {
    const notes = bead.notes ?? '';
    const want = [NO_REPORT_GLANCE, '', ...asPlainNotes(notes)].join('\n');
    for (const full of [false, true]) {
      expect(renderStoredNotes(bead, {color: false, full, width: null})).toBe(
        want,
      );
    }
  });

  test('thread show prints "no report yet" and the notes unstyled, in both modes', async () => {
    const notes = bead.notes ?? '';
    const compact = await show(bead, false);
    const full = await show(bead, true);
    // The whole notes region, pinned contiguously: glance, then every line of
    // the notes, verbatim, at the body indent. A per-line check would prove nothing here: the MESSAGES
    // block prints `lastAssistantMessage` — the same quote — at the same
    // indent, fix or no fix.
    const region = [NO_REPORT_GLANCE, '', ...asPlainNotes(notes)].join('\n');
    for (const out of [compact, full]) {
      expect(out).toContain(' · report #0 · ');
      expect(out).toContain(`\n\n${region}\n\n`);
      // What the compactor made of the quote before the fix.
      expect(out).not.toContain('MUST-SEE');
      expect(out).not.toContain('nothing needs you');
      expect(out).not.toContain('NOT RECORDED');
    }
    expect(compact).toBe(full);
  });

  test('a backfill body quoting ordinary text still says "no report yet"', () => {
    const plain = backfillBead('Done. Everything committed.');
    expect(backfillOwnership(plain)).toEqual({kind: 'owned'});
    const out = renderStoredNotes(plain, {
      color: false,
      full: false,
      width: null,
    });
    expect(out.split('\n')[0]).toBe(NO_REPORT_GLANCE);
  });
});

describe('every other thread keeps the k0b8n.14 rule', () => {
  test('a report written onto a backfill-labelled bead still renders as a report', () => {
    const reported: FakeIssue = {
      ...backfillBead(),
      description: 'GOAL: the quoted arc',
      metadata: {
        ...backfillBead().metadata,
        reportCount: 1,
        reportedAt: '2026-09-24T18:05:00.000Z',
      },
      notes: QUOTED_REPORT,
    };
    expect(backfillOwnership(reported).kind).toBe('reported');
    expect(showsNotesAsReport(reported)).toBe(true);
    const out = renderStoredNotes(reported, {
      color: false,
      full: false,
      width: null,
    });
    expect(out).toContain('MUST-SEE');
    expect(out).not.toContain(NO_REPORT_GLANCE);
  });

  test('an unproven backfill bead is not treated as owned: the quote still renders as before', () => {
    // No marker on the description, so ownership is unproven. Unknown routes
    // to "not owned", and a display keeps today's rendering (design, k0b8n.20).
    const unproven: FakeIssue = {
      ...backfillBead(),
      description: 'something other than backfill wrote this',
    };
    expect(backfillOwnership(unproven).kind).toBe('unproven');
    expect(showsNotesAsReport(unproven)).toBe(true);
    expect(
      renderStoredNotes(unproven, {color: false, full: false, width: null}),
    ).toContain('MUST-SEE');
  });

  test('a real stored report on a report-written bead is compacted as before', () => {
    const real: FakeIssue = {
      description: 'GOAL: the quoted arc',
      id: 'th-r1',
      metadata: {reportCount: 1, source: 'report'},
      notes: QUOTED_REPORT,
      status: 'in_progress',
      title: 'the quoted arc',
      type: 'thread',
    };
    expect(backfillOwnership(real).kind).toBe('notBackfill');
    const compact = renderStoredNotes(real, {
      color: false,
      full: false,
      width: null,
    });
    expect(compact).toContain('MUST-SEE');
    expect(
      renderStoredNotes(real, {color: false, full: true, width: null}),
    ).toContain('**Stop reason:** The gates are green.');
  });
});
