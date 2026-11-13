/**
 * Shorter repeat status reports (home-base-1rxt0.4, dispatch A: D1, D2, D3,
 * D6 and `thread status --full`). The fixtures are synthetic.
 *
 * Each rule has a control that fails when the rule is taken away: a question
 * that must stay in full sits beside one that must not, and every "same both
 * times" check is next to a run whose markers really differ.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {reportSnapshotsPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {
  isSeparatorLine,
  PART_ONE_RULE,
  PART_ONE_SEPARATOR,
  stripPastedPartOne,
} from '../src/thread/part-one';
import {
  CHANGED_MARK,
  chooseBaseline,
  compactQuestionsNote,
  markOf,
  NEW_MARK,
  questionFingerprint,
  questionKey,
  questionShown,
  type ReportBaseline,
  type ReportDelta,
  type ReportSnapshot,
  type SnapshotsRead,
} from '../src/thread/report-delta';
import {
  blockShownIn,
  markReportsShown,
  readNewestTurnEnd,
  readReportSnapshots,
  REPORT_SNAPSHOTS_KEPT,
  saveReportSnapshot,
  snapshotBlockOf,
} from '../src/thread/report-snapshots';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {runThreadStatus} from '../src/thread/session-report';
import {runThreadStopCheck} from '../src/thread/stop-check';
import {
  decideTrimGuard,
  normalizeBlockLine,
  normalizeText,
  readStatusBlocks,
} from '../src/thread/trim-guard';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

const SESSION = '5e551011-dddd-4eee-8fff-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function at(minute: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 9, minute));
}

const P2_QUESTION = {
  description: null,
  id: 't-q2',
  priority: 2,
  title: 'Keep the old export?',
};

function found(items: Record<string, string>): ReportBaseline {
  return {
    kind: 'found',
    snapshot: {
      at: at(0).toISOString(),
      block: {digest: 'd', lines: 3},
      items,
      shownAt: at(0).toISOString(),
    },
  };
}

/** A snapshot saved at `minute`, shown at `shown` (null: never pasted). */
function snap(
  minute: number,
  items: Record<string, string>,
  shown: null | number,
): ReportSnapshot {
  return {
    at: at(minute).toISOString(),
    block: {digest: `d${minute}`, lines: 3},
    items,
    shownAt: shown == null ? null : at(shown).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// D2, D3: the pure rules
// ---------------------------------------------------------------------------

describe('markOf (D2)', () => {
  test('new, changed, unchanged; nothing marked without a last report', () => {
    const baseline = found({'q:a': 'f1', 'q:b': 'f2'});
    expect(markOf('q:a', 'f1', baseline)).toBeNull();
    expect(markOf('q:b', 'other', baseline)).toBe('changed');
    expect(markOf('q:c', 'f3', baseline)).toBe('new');
    expect(markOf('q:c', 'f3', {kind: 'first'})).toBeNull();
    expect(markOf('q:c', 'f3', {kind: 'unknown', reason: 'x'})).toBeNull();
  });
});

describe('questionShown (D3)', () => {
  const same = (priority: number | null) => ({...P2_QUESTION, priority});
  const seen = (priority: number | null): ReportDelta => ({
    baseline: found({
      [questionKey(P2_QUESTION.id)]: questionFingerprint(same(priority)),
    }),
    compact: true,
  });

  test('P2 to P4 unchanged: one line, no marker', () => {
    for (const priority of [2, 3, 4]) {
      expect(questionShown(same(priority), seen(priority))).toEqual({
        compact: true,
        mark: null,
      });
    }
  });

  test('P0, P1 and an unknown priority: always in full', () => {
    for (const priority of [0, 1, null]) {
      expect(questionShown(same(priority), seen(priority)).compact).toBe(false);
    }
  });

  test('changed content: in full, with the changed marker', () => {
    const delta = seen(2);
    expect(
      questionShown(
        {...P2_QUESTION, title: 'Keep the old export a week?'},
        delta,
      ),
    ).toEqual({compact: false, mark: 'changed'});
    expect(
      questionShown({...P2_QUESTION, description: 'Context: x'}, delta),
    ).toEqual({compact: false, mark: 'changed'});
    // A priority change is a content change.
    expect(questionShown(same(3), delta)).toEqual({
      compact: false,
      mark: 'changed',
    });
  });

  test('new: in full, with the new marker', () => {
    expect(questionShown({...P2_QUESTION, id: 't-other'}, seen(2))).toEqual({
      compact: false,
      mark: 'new',
    });
  });

  test('the knob off or --full, no last report, or an unreadable one: in full', () => {
    expect(questionShown(same(2), {...seen(2), compact: false}).compact).toBe(
      false,
    );
    expect(
      questionShown(same(2), {baseline: {kind: 'first'}, compact: true}),
    ).toEqual({compact: false, mark: null});
    expect(
      questionShown(same(2), {
        baseline: {kind: 'unknown', reason: 'x'},
        compact: true,
      }),
    ).toEqual({compact: false, mark: null});
    expect(questionShown(same(2), null)).toEqual({compact: false, mark: null});
  });

  test('the note at the end of the questions', () => {
    expect(compactQuestionsNote([])).toBeNull();
    expect(compactQuestionsNote([3])).toBe(
      'Question 3 has not changed since the last report, so it is on one line. Ask for the full report to see it in full.',
    );
    expect(compactQuestionsNote([2, 3, 5])).toBe(
      'Questions 2, 3 and 5 have not changed since the last report, so each is on one line. Ask for the full report to see them in full.',
    );
  });
});

// ---------------------------------------------------------------------------
// D6: which snapshot is the last report
// ---------------------------------------------------------------------------

describe('chooseBaseline (D6)', () => {
  const snapshots: SnapshotsRead = {
    kind: 'found',
    snapshots: [
      snap(1, {'q:a': 'turn1'}, 2),
      snap(5, {'q:a': 'turn2-first'}, null),
      snap(9, {'q:a': 'turn2-last'}, 10),
      snap(21, {'q:a': 'this-turn'}, 22),
    ],
  };

  test('the newest shown snapshot at or before the previous turn ended', () => {
    const baseline = chooseBaseline(snapshots, () => ({
      at: at(10).toISOString(),
      kind: 'found',
    }));
    expect(baseline).toEqual({
      kind: 'found',
      snapshot: snap(9, {'q:a': 'turn2-last'}, 10),
    });
  });

  test('F1: a snapshot never pasted is skipped; none pasted is the first report', () => {
    // Turn 2 ran status twice and pasted neither: turn 1's report is the last.
    const unpasted: SnapshotsRead = {
      kind: 'found',
      snapshots: [
        snap(1, {'q:a': 'turn1'}, 2),
        snap(5, {'q:a': 'turn2-first'}, null),
        snap(9, {'q:a': 'turn2-last'}, null),
      ],
    };
    expect(
      chooseBaseline(unpasted, () => ({
        at: at(10).toISOString(),
        kind: 'found',
      })),
    ).toEqual({kind: 'found', snapshot: snap(1, {'q:a': 'turn1'}, 2)});
    // No report was ever pasted: everything in full, nothing marked.
    const never: SnapshotsRead = {
      kind: 'found',
      snapshots: [snap(1, {'q:a': 'x'}, null), snap(9, {'q:a': 'y'}, null)],
    };
    expect(
      chooseBaseline(never, () => ({at: at(10).toISOString(), kind: 'found'})),
    ).toEqual({kind: 'first'});
  });

  test('every snapshot is from this turn, or no turn has ended: the first report', () => {
    expect(
      chooseBaseline(snapshots, () => ({
        at: at(0).toISOString(),
        kind: 'found',
      })),
    ).toEqual({kind: 'first'});
    expect(chooseBaseline(snapshots, () => ({kind: 'none'}))).toEqual({
      kind: 'first',
    });
  });

  test('no snapshots: the first report, and the transcript is not read', () => {
    let read = false;
    expect(
      chooseBaseline({kind: 'none'}, () => {
        read = true;
        return {kind: 'none'};
      }),
    ).toEqual({kind: 'first'});
    expect(read).toBe(false);
  });

  test('what could not be read is unknown, never the first report', () => {
    expect(
      chooseBaseline({kind: 'unknown', reason: 'EACCES'}, () => ({
        kind: 'none',
      })),
    ).toEqual({
      kind: 'unknown',
      reason: 'could not read the earlier reports of this session: EACCES',
    });
    expect(
      chooseBaseline(snapshots, () => ({kind: 'failed', reason: 'gone'})),
    ).toEqual({
      kind: 'unknown',
      reason: 'could not tell when the previous turn ended: gone',
    });
    expect(
      chooseBaseline(snapshots, () => ({at: 'yesterday', kind: 'found'})).kind,
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// The transcript's turn end, and the snapshot file
// ---------------------------------------------------------------------------

function record(type: string, minute: number, extra: object = {}): string {
  return JSON.stringify({timestamp: at(minute).toISOString(), type, ...extra});
}

function turnEnd(minute: number, extra: object = {}): string {
  return record('system', minute, {subtype: 'turn_duration', ...extra});
}

describe('readNewestTurnEnd', () => {
  function transcript(lines: string[]): string {
    const sb = createSandbox();
    sandboxes.push(sb);
    const path = join(sb.path, 't.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  }

  test('the newest turn_duration, found behind a long current turn', () => {
    const filler = record('user', 30, {message: {content: 'x'.repeat(4000)}});
    const path = transcript([
      turnEnd(3),
      record('assistant', 4),
      turnEnd(10),
      ...Array.from({length: 200}, () => filler),
    ]);
    // A 1 KB first window cannot see it; the window grows until it does.
    expect(readNewestTurnEnd(path, 1024)).toEqual({
      at: at(10).toISOString(),
      kind: 'found',
    });
  });

  test('a blocked Stop (stop_hook_summary only) and a subagent record are not turn ends', () => {
    const path = transcript([
      turnEnd(3),
      record('system', 8, {subtype: 'stop_hook_summary'}),
      turnEnd(9, {isSidechain: true}),
    ]);
    expect(readNewestTurnEnd(path)).toEqual({
      at: at(3).toISOString(),
      kind: 'found',
    });
  });

  test('none in the whole file; a missing file is a failure, not none', () => {
    expect(readNewestTurnEnd(transcript([record('user', 1)]), 8)).toEqual({
      kind: 'none',
    });
    const missing = readNewestTurnEnd('/nonexistent/t.jsonl');
    expect(missing.kind).toBe('failed');
  });
});

describe('the snapshot file', () => {
  function env(): Record<string, string> {
    const sb = createSandbox();
    sandboxes.push(sb);
    return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
  }

  test('saved, read back oldest first, the newest kept', () => {
    const e = env();
    expect(readReportSnapshots(SESSION, e)).toEqual({kind: 'none'});
    for (let index = 0; index < REPORT_SNAPSHOTS_KEPT + 2; index += 1) {
      const saved = saveReportSnapshot({
        at: new Date(at(0).getTime() + index * 1000),
        block: {digest: `d${index}`, lines: 4},
        env: e,
        items: {'q:a': String(index)},
        sessionId: SESSION,
      });
      expect(saved.kind).toBe('saved');
    }
    const read = readReportSnapshots(SESSION, e);
    if (read.kind !== 'found') throw new Error(read.kind);
    expect(read.snapshots).toHaveLength(REPORT_SNAPSHOTS_KEPT);
    expect(read.snapshots[0]?.items).toEqual({'q:a': '2'});
    expect(read.snapshots[0]?.block).toEqual({digest: 'd2', lines: 4});
    expect(read.snapshots[0]?.shownAt).toBeNull();
    expect(read.snapshots.at(-1)?.items).toEqual({
      'q:a': String(REPORT_SNAPSHOTS_KEPT + 1),
    });
  });

  test('a malformed line is skipped; a file of nothing but is unknown', () => {
    const e = env();
    const path = reportSnapshotsPath(SESSION, e);
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, 'not json\n');
    expect(readReportSnapshots(SESSION, e).kind).toBe('unknown');
    // F1: a block or shownAt of the wrong shape is malformed too.
    for (const bad of [
      {block: {digest: 'd', lines: 0}},
      {block: 'd'},
      {shownAt: 'yesterday'},
    ]) {
      appendFileSync(
        path,
        `${JSON.stringify({at: at(1).toISOString(), items: {}, ...bad})}\n`,
      );
    }
    expect(readReportSnapshots(SESSION, e).kind).toBe('unknown');
    // A line saved before F1 (no block, no shownAt) is read, never as shown.
    appendFileSync(
      path,
      `${JSON.stringify({at: at(1).toISOString(), items: {'q:a': 'f'}})}\n`,
    );
    const read = readReportSnapshots(SESSION, e);
    if (read.kind !== 'found') throw new Error(read.kind);
    expect(read.snapshots).toEqual([
      {
        at: at(1).toISOString(),
        block: null,
        items: {'q:a': 'f'},
        shownAt: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// F1 (home-base-sg9q9.11): only a report Justin was shown is the last report
// ---------------------------------------------------------------------------

const BLOCK_TEXT = [
  PART_ONE_RULE,
  '',
  '**Session:** [X] Speed up the export',
  '',
  '**Last activity:** 9:01am',
  '',
  '1. [BD1] ⚪ P3 · [Answer] **Gzip the output?** (t-q3)',
  '',
  PART_ONE_SEPARATOR,
].join('\n');

describe('F1: the Stop hook marks the reports a final message showed', () => {
  function env(): Record<string, string> {
    const sb = createSandbox();
    sandboxes.push(sb);
    return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
  }

  function saveAt(e: Record<string, string>, minute: number, text: string) {
    const saved = saveReportSnapshot({
      at: at(minute),
      block: snapshotBlockOf(text),
      env: e,
      items: {'q:t-q3': String(minute)},
      sessionId: SESSION,
    });
    expect(saved.kind).toBe('saved');
  }

  function shownAts(e: Record<string, string>): (null | string)[] {
    const read = readReportSnapshots(SESSION, e);
    if (read.kind !== 'found') throw new Error(read.kind);
    return read.snapshots.map((snapshot) => snapshot.shownAt);
  }

  test('a block pasted whole, with Part 2 after it, marks its snapshot, once', () => {
    const e = env();
    saveAt(e, 1, BLOCK_TEXT);
    const reply = `${BLOCK_TEXT}\n\n## Deviations\n\n- none`;
    expect(
      markReportsShown({env: e, now: at(2), reply, sessionId: SESSION}),
    ).toMatchObject({kind: 'marked', marked: [at(1).toISOString()]});
    expect(shownAts(e)).toEqual([at(2).toISOString()]);
    // Pasted again later: the first showing stands.
    expect(
      markReportsShown({env: e, now: at(4), reply, sessionId: SESSION}).kind,
    ).toBe('noMatch');
    expect(shownAts(e)).toEqual([at(2).toISOString()]);
    // The next save keeps it.
    saveAt(e, 5, BLOCK_TEXT.replace('9:01am', '9:05am'));
    expect(shownAts(e)).toEqual([at(2).toISOString(), null]);
  });

  test('a reply with no block reads nothing; a cut block or an old snapshot marks nothing', () => {
    const e = env();
    // No file at all, and still no read: the common Stop.
    expect(
      markReportsShown({
        env: e,
        now: at(2),
        reply: 'I am waiting for the players.',
        sessionId: SESSION,
      }),
    ).toEqual({kind: 'noBlock'});
    saveAt(e, 1, BLOCK_TEXT);
    const cut = BLOCK_TEXT.split('\n')
      .filter((line) => !line.includes('Gzip'))
      .join('\n');
    expect(
      markReportsShown({env: e, now: at(2), reply: cut, sessionId: SESSION})
        .kind,
    ).toBe('noMatch');
    // A snapshot saved before F1 has no block, so no reply can show it.
    const path = reportSnapshotsPath(SESSION, e);
    appendFileSync(
      path,
      `${JSON.stringify({at: at(3).toISOString(), items: {}})}\n`,
    );
    expect(shownAts(e)).toEqual([null, null]);
    expect(
      markReportsShown({
        env: e,
        now: at(4),
        reply: BLOCK_TEXT,
        sessionId: SESSION,
      }),
    ).toMatchObject({kind: 'marked', marked: [at(1).toISOString()]});
    expect(shownAts(e)).toEqual([at(4).toISOString(), null]);
  });

  test('the block digest is the trim guard comparison: volatile fields may differ, nothing else', () => {
    const saved = snapshotBlockOf(BLOCK_TEXT);
    if (saved == null) throw new Error('no block');
    const later = normalizeText(BLOCK_TEXT.replace('9:01am', '9:30am'));
    expect(blockShownIn(saved, later)).toBe(true);
    const retitled = normalizeText(BLOCK_TEXT.replace('Gzip', 'Zstd'));
    expect(blockShownIn(saved, retitled)).toBe(false);
    // Text that does not start with the rule line is no block.
    expect(snapshotBlockOf(`Hello\n${BLOCK_TEXT}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D1: the block's last line
// ---------------------------------------------------------------------------

describe('the block ends with a line of ♒ (D1)', () => {
  test('the separator is ♒, and an old ─── block is still recognised', () => {
    expect(PART_ONE_SEPARATOR).toMatch(/^(?:♒){3,}$/u);
    expect(isSeparatorLine(PART_ONE_SEPARATOR)).toBe(true);
    expect(isSeparatorLine('─'.repeat(28))).toBe(true);
    expect(isSeparatorLine('♒♒')).toBe(false);
    for (const end of [PART_ONE_SEPARATOR, '─'.repeat(28)]) {
      expect(
        stripPastedPartOne(
          `${PART_ONE_RULE}\n\n**Session:** [X] t\n\n${end}\n\nMy own words.`,
        ),
      ).toBe('My own words.');
    }
  });

  test('the trim guard reads any line of ♒ as the separator, and nothing else as one', () => {
    for (const line of ['♒♒♒', '♒️♒️♒️♒️', `  ${PART_ONE_SEPARATOR} `]) {
      expect(normalizeBlockLine(line)).toBe(PART_ONE_SEPARATOR);
    }
    expect(normalizeBlockLine('♒♒ water')).toBe('♒♒ water');
    expect(normalizeBlockLine('─'.repeat(28))).toBe('─'.repeat(28));
  });
});

// ---------------------------------------------------------------------------
// `thread status`, end to end
// ---------------------------------------------------------------------------

interface World {
  env: Record<string, string | undefined>;
  questions: {p0: string; p1: string; p2: string; p3: string};
  repo: string;
  request: string;
  transcript: string;
}

async function world(knobs: Record<string, unknown> = {}): Promise<World> {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, sessionBeads: true, trimGuard: true, ...knobs},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CHORES_STATE_DIR: join(sb.path, 'chores-state'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    VITALS_STATE_DIR: join(sb.path, 'vitals-state'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'delta-repo', {'README.md': '# delta\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: at(0).toISOString(), text: 'Speed up the export'},
    now: at(0),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  const base = {cwd: repo, env, now: at(0), sessionId: null};
  const request = await fileRequest({
    ...base,
    bead: null,
    doneWhen: null,
    here: false,
    title: 'Make the export faster',
  });
  if (request.kind !== 'filed') throw new Error('request not filed');
  const ask = async (priority: string, question: string): Promise<string> => {
    const outcome = await fileAsk({
      approve: false,
      context: [`Context for ${question}`],
      cwd: repo,
      default: priority === '0' ? null : 'I keep going as planned.',
      do: false,
      env,
      header: null,
      options: [],
      priority,
      question,
      recommend: null,
      sessionId: null,
      to: request.id,
    });
    if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
    return outcome.id;
  };
  const questions = {
    p0: await ask('0', 'Which bucket?'),
    p1: await ask('1', 'Ship it on Friday?'),
    p2: await ask('2', 'Keep the old export a week?'),
    p3: await ask('3', 'Gzip the output?'),
  };
  const dir = join(sb.path, 'projects', 'delta-repo');
  mkdirSync(dir, {recursive: true});
  const transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(
    transcript,
    `${JSON.stringify({
      cwd: repo,
      message: {content: 'Speed up the export', role: 'user'},
      sessionId: SESSION,
      timestamp: at(0).toISOString(),
      type: 'user',
    })}\n`,
  );
  return {env, questions, repo, request: request.id, transcript};
}

/** One `thread status` run, in-process, at `now`: its whole stdout. */
async function status(
  w: World,
  now: Date,
  options: {full?: boolean} = {},
): Promise<string> {
  const printed: string[] = [];
  const spy = captureWriteStdout((text) => printed.push(text));
  try {
    const code = await runThreadStatus({
      cwd: w.repo,
      env: w.env,
      full: options.full ?? false,
      now,
      sessionId: null,
      style: PLAIN_STYLE,
      timeZone: 'UTC',
    });
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return printed.join('\n');
}

/** Part 1 as printed: the 🛑 line through the ♒ line. */
function block(out: string): string {
  const start = out.indexOf(PART_ONE_RULE);
  const end = out.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length;
  return out.slice(start, end);
}

/** The line of question `id`, and whether the lines after it are its body. */
function questionLine(out: string, id: string): string {
  return out.split('\n').find((line) => line.includes(`(${id})`)) ?? '';
}

function inFull(out: string, title: string): boolean {
  return out.includes(`Context for ${title}`);
}

/** A final message that pastes `out`'s block, then Claude's own words. */
function pasted(out: string): string {
  return `${block(out)}\n\n## Things you should know\n\n- none`;
}

/** The Stop hook, as Claude Code runs it, on Claude's final message. */
function stopHook(
  w: World,
  message: string,
  minute: number,
  extra: object = {},
): void {
  const result = runThreadStopCheck({
    env: w.env,
    now: at(minute),
    stdin: JSON.stringify({
      cwd: w.repo,
      hook_event_name: 'Stop',
      last_assistant_message: message,
      session_id: SESSION,
      stop_hook_active: false,
      transcript_path: w.transcript,
      ...extra,
    }),
  });
  expect(result.exitCode).toBe(0);
}

/**
 * Claude's turn ended at `minute` with `message` as its final message: the
 * Stop hook runs on it, then Claude Code writes the turn's end.
 */
function endTurn(w: World, minute: number, message: string): void {
  stopHook(w, message, minute);
  appendFileSync(w.transcript, `${turnEnd(minute)}\n`);
}

/** A final message with no status block in it. */
const NO_BLOCK = 'I am waiting for the players to report. Nothing to show yet.';

/** File one more question, for request `w.request`. */
async function askMore(
  w: World,
  priority: string,
  question: string,
): Promise<string> {
  const outcome = await fileAsk({
    approve: false,
    context: [`Context for ${question}`],
    cwd: w.repo,
    default: 'I keep going as planned.',
    do: false,
    env: w.env,
    header: null,
    options: [],
    priority,
    question,
    recommend: null,
    sessionId: null,
    to: w.request,
  });
  if (outcome.kind !== 'filed') throw new Error(outcome.kind);
  return outcome.id;
}

describe('thread status: repeat reports (D1, D2, D3, D6)', () => {
  test('the first report of a session: every question in full, nothing marked, ♒ last', async () => {
    const w = await world();
    const first = await status(w, at(1));
    const again = await status(w, at(2));
    for (const out of [first, again]) {
      for (const title of [
        'Which bucket?',
        'Ship it on Friday?',
        'Keep the old export a week?',
        'Gzip the output?',
      ]) {
        expect(inFull(out, title)).toBe(true);
      }
      expect(out).not.toContain(NEW_MARK);
      expect(out).not.toContain(CHANGED_MARK);
      expect(out).not.toContain('Ask for the full report');
      expect(block(out).trimEnd().split('\n').at(-1)).toBe(PART_ONE_SEPARATOR);
    }
    expect(block(again)).toBe(block(first));
  });

  test('the next turn: unchanged P2 and P3 on one line, P0 and P1 in full, the same both times', async () => {
    const w = await world();
    await status(w, at(1));
    endTurn(w, 3, pasted(await status(w, at(2))));
    const first = await status(w, at(5));
    const again = await status(w, at(6));
    expect(block(again)).toBe(block(first));
    expect(inFull(first, 'Which bucket?')).toBe(true);
    expect(inFull(first, 'Ship it on Friday?')).toBe(true);
    expect(inFull(first, 'Keep the old export a week?')).toBe(false);
    expect(inFull(first, 'Gzip the output?')).toBe(false);
    expect(questionLine(first, w.questions.p3)).toMatch(
      /^4\. \[BD4\] ⚪ P3 · \[Answer\] \*\*Gzip the output\?\*\* \(t-[^)]+\)$/u,
    );
    expect(first).toContain(
      '*Questions 3 and 4 have not changed since the last report, so each is on one line. Ask for the full report to see them in full.*',
    );
    expect(first).not.toContain(NEW_MARK);
    expect(first).not.toContain(CHANGED_MARK);
  });

  test('a new question, a changed question and a new request are marked, in place, and stay marked all turn', async () => {
    const w = await world();
    endTurn(w, 3, pasted(await status(w, at(1))));
    const retitled = runBr(w.repo, [
      'update',
      w.questions.p3,
      '--title',
      'Gzip the output, or zstd?',
    ]);
    expect(retitled.ok).toBe(true);
    const outcome = await fileAsk({
      approve: false,
      context: ['Context for Rename the job?'],
      cwd: w.repo,
      default: 'I keep the name.',
      do: false,
      env: w.env,
      header: null,
      options: [],
      priority: '4',
      question: 'Rename the job?',
      recommend: null,
      sessionId: null,
      to: w.request,
    });
    if (outcome.kind !== 'filed') throw new Error(outcome.kind);
    const request = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: at(4),
      sessionId: null,
      title: 'Write the runbook',
    });
    if (request.kind !== 'filed') throw new Error(request.kind);
    const first = await status(w, at(5));
    const again = await status(w, at(6));
    expect(block(again)).toBe(block(first));
    expect(questionLine(first, outcome.id)).toContain(
      `5. ${NEW_MARK} [BD5] ⚪ P4 · `,
    );
    expect(inFull(first, 'Rename the job?')).toBe(true);
    expect(questionLine(first, w.questions.p3)).toContain(
      `4. ${CHANGED_MARK} [BD4] ⚪ P3 · `,
    );
    // Changed, so in full: its context (filed under the old title) is shown.
    expect(first).toContain('Context for Gzip the output?');
    // Unchanged: the P2 is one line and carries no marker.
    expect(questionLine(first, w.questions.p2)).toMatch(
      /^3\. \[BD3\] 🟡 P2 · /u,
    );
    expect(questionLine(first, request.id)).toContain(
      `${NEW_MARK} 🔲 **Write the runbook**`,
    );
    expect(questionLine(first, w.request)).not.toContain(NEW_MARK);
    // The next turn: nothing new any more, and the P3 and P4 are one line.
    endTurn(w, 7, pasted(again));
    const next = await status(w, at(8));
    expect(next).not.toContain(NEW_MARK);
    expect(next).not.toContain(CHANGED_MARK);
    expect(inFull(next, 'Rename the job?')).toBe(false);
  });

  test('the knob off, and --full: every question in full, the markers kept', async () => {
    const off = await world({compactQuestions: false});
    endTurn(off, 3, pasted(await status(off, at(1))));
    const offOut = await status(off, at(5));
    expect(inFull(offOut, 'Gzip the output?')).toBe(true);
    expect(offOut).not.toContain('Ask for the full report');

    const w = await world();
    endTurn(w, 3, pasted(await status(w, at(1))));
    runBr(w.repo, ['update', w.questions.p2, '--title', 'Keep it a month?']);
    const full = await status(w, at(5), {full: true});
    expect(inFull(full, 'Gzip the output?')).toBe(true);
    expect(full).not.toContain('Ask for the full report');
    expect(questionLine(full, w.questions.p2)).toContain(CHANGED_MARK);
    const compact = await status(w, at(6));
    expect(inFull(compact, 'Gzip the output?')).toBe(false);
  });

  test('the trim guard passes a pasted compact block, from either run of the turn', async () => {
    const w = await world();
    endTurn(w, 3, pasted(await status(w, at(1))));
    const first = await status(w, at(5));
    const again = await status(w, at(6));
    expect(inFull(first, 'Gzip the output?')).toBe(false);
    for (const out of [first, again]) {
      const decision = decideTrimGuard({
        agentId: null,
        braked: false,
        lastAssistantMessage: `${block(out)}\n\n## Things you should know\n\n- none`,
        saved: readStatusBlocks(SESSION, w.env),
        sessionId: SESSION,
        stopHookActive: false,
      });
      expect(decision.action).toBe('pass');
    }
    // Control: a compact line cut out of the paste is caught.
    const cut = block(first)
      .split('\n')
      .filter((line) => !line.includes(`(${w.questions.p3})`))
      .join('\n');
    expect(
      decideTrimGuard({
        agentId: null,
        braked: false,
        lastAssistantMessage: cut,
        saved: readStatusBlocks(SESSION, w.env),
        sessionId: SESSION,
        stopHookActive: false,
      }).action,
    ).toBe('block');
    expect(normalizeText(block(first)).starts).toEqual([0]);
  });

  test('a snapshot file that cannot be read: said in Part 1, and every question in full', async () => {
    const w = await world();
    const path = reportSnapshotsPath(SESSION, w.env);
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, 'garbage\n');
    appendFileSync(w.transcript, `${turnEnd(3)}\n`);
    const out = await status(w, at(5));
    expect(out).toContain(
      'Nothing is marked new or changed, and every question is in full',
    );
    expect(inFull(out, 'Gzip the output?')).toBe(true);
  });
});

describe('F1 (home-base-sg9q9.11): the last report is one Justin was shown', () => {
  test('a turn that ran thread status and never pasted it: the next report shows its new question in full, with 🆕', async () => {
    const w = await world();
    endTurn(w, 3, pasted(await status(w, at(1))));
    const rename = await askMore(w, '3', 'Rename the job?');
    const unseen = await status(w, at(5));
    expect(questionLine(unseen, rename)).toContain(`${NEW_MARK} [BD5]`);
    // The turn ends with no block: Justin never saw this report.
    endTurn(w, 7, NO_BLOCK);
    const next = await status(w, at(8));
    expect(questionLine(next, rename)).toContain(`${NEW_MARK} [BD5]`);
    expect(inFull(next, 'Rename the job?')).toBe(true);
    // What he did see stays as designed: unchanged P2 and P3 on one line.
    expect(inFull(next, 'Gzip the output?')).toBe(false);
    expect(inFull(next, 'Keep the old export a week?')).toBe(false);
  });

  test('the block was pasted: the next report compacts as designed', async () => {
    const w = await world();
    endTurn(w, 3, pasted(await status(w, at(1))));
    const rename = await askMore(w, '3', 'Rename the job?');
    const seen = await status(w, at(5));
    expect(inFull(seen, 'Rename the job?')).toBe(true);
    endTurn(w, 7, pasted(seen));
    const next = await status(w, at(8));
    expect(questionLine(next, rename)).not.toContain(NEW_MARK);
    expect(inFull(next, 'Rename the job?')).toBe(false);
    expect(inFull(next, 'Gzip the output?')).toBe(false);
  });

  test('no report ever pasted: the next turn marks nothing and prints every question in full', async () => {
    const w = await world();
    await status(w, at(1));
    endTurn(w, 3, NO_BLOCK);
    const out = await status(w, at(5));
    for (const title of ['Keep the old export a week?', 'Gzip the output?']) {
      expect(inFull(out, title)).toBe(true);
    }
    expect(out).not.toContain(NEW_MARK);
    expect(out).not.toContain('Ask for the full report');
  });

  test('the Stop hook marks a pasted report with the trim guard off, and never for a subagent', async () => {
    const w = await world({trimGuard: false});
    const out = await status(w, at(1));
    const shown = (): (null | string)[] => {
      const read = readReportSnapshots(SESSION, w.env);
      if (read.kind !== 'found') throw new Error(read.kind);
      return read.snapshots.map((snapshot) => snapshot.shownAt);
    };
    // A subagent's final message goes to its parent session, not to Justin.
    stopHook(w, pasted(out), 2, {agent_id: 'a1b2c3'});
    expect(shown()).toEqual([null]);
    stopHook(w, pasted(out), 2);
    expect(shown()).toEqual([at(2).toISOString()]);
  });
});
