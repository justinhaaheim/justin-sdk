/**
 * `thread status --changes` and `thread status --report-file` (home-base-88y8m
 * D1 and D2, built by home-base-88y8m.1). The fixtures are synthetic.
 *
 * Each rule sits beside a control that fails when the rule is taken away: an
 * item that must be left out sits beside one that must be kept, and every
 * "same as the full report" check compares against a real full-report run.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {PLAIN_STYLE} from '../src/cli-style';
import {reportSnapshotsPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {
  PART_ONE_RULE,
  PART_ONE_SEPARATOR,
  PROGRESS_HEADING,
} from '../src/thread/part-one';
import {
  answeredSinceLine,
  CHANGED_MARK,
  CHANGES_ALL_SHOWN_FIRST,
  NEW_MARK,
  questionsLeftSince,
  unchangedCountLine,
} from '../src/thread/report-delta';
import {
  readReportSnapshots,
  snapshotBlockOf,
} from '../src/thread/report-snapshots';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  CHANGES_WITH_FULL_REFUSAL,
  runThreadStatus,
  SESSION_BEADS_ENABLED_LINE,
  VERDICT_LABEL,
  writeReportFile,
} from '../src/thread/session-report';
import {runThreadStopCheck} from '../src/thread/stop-check';
import {readStatusBlocks} from '../src/thread/trim-guard';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox, type Sandbox} from './sandbox';

const SESSION = '5e551011-cccc-4ccc-8ccc-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function at(minute: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 9, minute));
}

// ---------------------------------------------------------------------------
// The pure lines (report-delta.ts)
// ---------------------------------------------------------------------------

describe('the count lines and the answered line (D1)', () => {
  test('a count line for the rest, and one when nothing changed', () => {
    expect(unchangedCountLine('request', 1, 3)).toBe(
      '2 more requests have not changed since the last report.',
    );
    expect(unchangedCountLine('question', 2, 3)).toBe(
      '1 more question has not changed since the last report.',
    );
    expect(unchangedCountLine('request', 0, 3)).toBe(
      'No request has changed since the last report (3 unchanged).',
    );
    expect(unchangedCountLine('question', 0, 1)).toBe(
      'No question has changed since the last report (1 unchanged).',
    );
    // Every item shown, or none at all: nothing to count.
    expect(unchangedCountLine('request', 3, 3)).toBeNull();
    expect(unchangedCountLine('question', 0, 0)).toBeNull();
  });

  test('the questions that left: only against a found last report', () => {
    const found = {
      kind: 'found' as const,
      snapshot: {
        at: at(0).toISOString(),
        block: null,
        items: {'q:a': 'f', 'q:b': 'f', 'r:a': 'f'},
        message: null,
        shownAt: at(0).toISOString(),
      },
    };
    expect(questionsLeftSince(found, new Set(['a']))).toEqual(['b']);
    // A request key is never a question.
    expect(questionsLeftSince(found, new Set(['a', 'b']))).toEqual([]);
    expect(questionsLeftSince({kind: 'first'}, new Set())).toEqual([]);
    expect(
      questionsLeftSince({kind: 'unknown', reason: 'x'}, new Set()),
    ).toEqual([]);
    expect(
      answeredSinceLine([
        {id: 'Q105', title: 'Ship it?'},
        {id: 't-9', title: null},
      ]),
    ).toBe('Answered or closed since the last report: Q105 (Ship it?), t-9.');
    expect(answeredSinceLine([])).toBeNull();
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

/** File a question for request `w.request`. */
async function ask(w: World, priority: string, question: string) {
  const outcome = await fileAsk({
    approve: false,
    context: [`Context for ${question}`],
    cwd: w.repo,
    default: priority === '0' ? null : 'I keep going as planned.',
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
  if (outcome.kind !== 'filed') throw new Error(`ask: ${outcome.kind}`);
  return outcome.id;
}

async function world(): Promise<World> {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, sessionBeads: true, trimGuard: true},
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
  const repo = initRepo(sb, 'changes-repo', {'README.md': '# changes\n'});
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
  const request = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env,
    here: false,
    now: at(0),
    sessionId: null,
    title: 'Make the export faster',
  });
  if (request.kind !== 'filed') throw new Error('request not filed');
  const w: World = {
    env,
    questions: {p0: '', p1: '', p2: '', p3: ''},
    repo,
    request: request.id,
    transcript: '',
  };
  w.questions = {
    p0: await ask(w, '0', 'Which bucket?'),
    p1: await ask(w, '1', 'Ship it on Friday?'),
    p2: await ask(w, '2', 'Keep the old export a week?'),
    p3: await ask(w, '3', 'Gzip the output?'),
  };
  const dir = join(sb.path, 'projects', 'changes-repo');
  mkdirSync(dir, {recursive: true});
  w.transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(
    w.transcript,
    `${JSON.stringify({
      cwd: repo,
      message: {content: 'Speed up the export', role: 'user'},
      sessionId: SESSION,
      timestamp: at(0).toISOString(),
      type: 'user',
    })}\n`,
  );
  return w;
}

interface Run {
  code: number;
  stderr: string;
  stdout: string;
}

/** One `thread status` run, in-process, at `now`. */
async function run(
  w: World,
  now: Date,
  options: {
    changes?: boolean;
    color?: boolean;
    full?: boolean;
    reportFile?: string;
    sessionId?: string;
  } = {},
): Promise<Run> {
  const printed: string[] = [];
  const errors: string[] = [];
  const spy = captureWriteStdout((text) => printed.push(text));
  const errorSpy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    },
  );
  try {
    const code = await runThreadStatus({
      changes: options.changes ?? false,
      cwd: w.repo,
      env: w.env,
      full: options.full ?? false,
      now,
      reportFile: options.reportFile ?? null,
      sessionId: options.sessionId ?? null,
      style: options.color === true ? {color: true, width: 100} : PLAIN_STYLE,
      timeZone: 'UTC',
    });
    return {code, stderr: errors.join('\n'), stdout: printed.join('\n')};
  } finally {
    spy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function status(
  w: World,
  now: Date,
  options: {changes?: boolean; full?: boolean} = {},
): Promise<string> {
  const out = await run(w, now, options);
  expect(out.code).toBe(0);
  return out.stdout;
}

/** Part 1 as printed: the 🛑 line through the ♒ line. */
function block(out: string): string {
  const start = out.indexOf(PART_ONE_RULE);
  const end = out.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length;
  return out.slice(start, end);
}

/**
 * One numbered item of the block (a request or a question), from its first
 * line up to the next item, note, heading or rule.
 */
function itemText(out: string, id: string): string | null {
  const lines = block(out).split('\n');
  const start = lines.findIndex(
    (line) => /^\d+\. /u.test(line) && line.includes(`(${id})`),
  );
  if (start < 0) return null;
  let end = start + 1;
  while (
    end < lines.length &&
    !/^(?:\d+\. |\*|---$|## )/u.test(lines[end] ?? '')
  ) {
    end += 1;
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** The block's text before `## Progress`: the header. */
function header(out: string): string {
  return block(out).split(`## ${PROGRESS_HEADING}`)[0] ?? '';
}

/** The block's last section: Repo through Pane, and the ♒ line. */
function footer(out: string): string {
  return block(out).split('\n---\n').at(-1) ?? '';
}

/** His messages: the section that starts with Your first message. */
function messagesSection(out: string): string {
  const text = block(out);
  const start = text.indexOf('**Your first message:**');
  return text.slice(start, text.indexOf('\n---\n', start));
}

function inFull(out: string, title: string): boolean {
  return out.includes(`Context for ${title}`);
}

function stopHook(w: World, message: string, minute: number): void {
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
    }),
  });
  expect(result.exitCode).toBe(0);
}

/** Claude's turn ended at `minute` with `out`'s block pasted. */
function endTurnPasting(w: World, minute: number, out: string): void {
  stopHook(w, `${block(out)}\n\n## Things you should know\n\n- none`, minute);
  appendFileSync(
    w.transcript,
    `${JSON.stringify({
      subtype: 'turn_duration',
      timestamp: at(minute).toISOString(),
      type: 'system',
    })}\n`,
  );
}

/** A world whose first report was pasted, then changed: see the body. */
async function changedWorld(): Promise<{
  newAsk: string;
  newRequest: string;
  w: World;
}> {
  const w = await world();
  endTurnPasting(w, 3, await status(w, at(1)));
  // Changed: the P3's title. New: a P4 question and a request.
  const retitled = runBr(w.repo, [
    'update',
    w.questions.p3,
    '--title',
    'Gzip the output, or zstd?',
  ]);
  expect(retitled.ok).toBe(true);
  const newAsk = await ask(w, '4', 'Rename the job?');
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
  return {newAsk, newRequest: request.id, w};
}

describe('thread status --changes against a found last report (D1)', () => {
  test('only the new and changed items, each exactly as the full report prints it, and a count line per section', async () => {
    const {newAsk, newRequest, w} = await changedWorld();
    const full = await status(w, at(5));
    const changes = await status(w, at(5), {changes: true});

    // Kept: the new request, the changed P3 and the new P4, each whole and
    // under the number the full report gives it.
    for (const id of [newRequest, w.questions.p3, newAsk]) {
      const item = itemText(changes, id);
      expect(item).not.toBeNull();
      expect(item).toBe(itemText(full, id));
    }
    expect(itemText(changes, newRequest)).toContain(NEW_MARK);
    expect(itemText(changes, w.questions.p3)).toStartWith(
      `4. ${CHANGED_MARK} [Q103]`,
    );
    expect(itemText(changes, newAsk)).toStartWith(`5. ${NEW_MARK} [Q104]`);
    expect(inFull(changes, 'Rename the job?')).toBe(true);
    // home-base-88y8m.8 R1: the unchanged P0 is kept whole, because the
    // header's You need to names it; its request is not kept.
    expect(header(changes)).toContain('Which bucket?');
    expect(itemText(changes, w.questions.p0)).toBe(
      itemText(full, w.questions.p0),
    );
    expect(inFull(changes, 'Which bucket?')).toBe(true);
    // Left out: the unchanged request and the unchanged P1 and P2 under it.
    for (const id of [w.request, w.questions.p1, w.questions.p2]) {
      expect(itemText(full, id)).not.toBeNull();
      expect(itemText(changes, id)).toBeNull();
    }
    expect(block(changes)).toContain(
      '*1 more request has not changed since the last report.*',
    );
    expect(block(changes)).toContain(
      '*2 more questions have not changed since the last report.*',
    );
    // The fold note belongs to the full report only.
    expect(changes).not.toContain('Ask for the full report');
    expect(full).toContain('Ask for the full report');

    // Header, his messages and the footer: as the full report prints them.
    expect(header(changes)).toBe(header(full));
    expect(messagesSection(changes)).toBe(messagesSection(full));
    expect(footer(changes)).toBe(footer(full));
    expect(footer(changes)).toContain('**Resume:**');
    // Stdout still carries what Claude needs after the block.
    expect(changes).toStartWith(SESSION_BEADS_ENABLED_LINE);
    expect(changes).toContain(VERDICT_LABEL);
  });

  test('nothing changed: each section says so, with how many are unchanged', async () => {
    const w = await world();
    // No P0 open, so nothing a printed line names is kept (R1).
    expect(
      runBr(w.repo, ['close', w.questions.p0, '--reason', 'answered']).ok,
    ).toBe(true);
    endTurnPasting(w, 3, await status(w, at(1)));
    const changes = await status(w, at(5), {changes: true});
    expect(block(changes)).toContain(
      '*No request has changed since the last report (1 unchanged).*',
    );
    expect(block(changes)).toContain(
      '*No question has changed since the last report (3 unchanged).*',
    );
    expect(block(changes)).toContain('## Questions for you');
    for (const id of Object.values(w.questions)) {
      expect(itemText(changes, id)).toBeNull();
    }
    expect(itemText(changes, w.request)).toBeNull();
  });

  test('a question answered or closed since the last report is named, with its id and title', async () => {
    const w = await world();
    endTurnPasting(w, 3, await status(w, at(1)));
    const before = await status(w, at(4), {changes: true});
    expect(before).not.toContain('Answered or closed since the last report');
    const closed = runBr(w.repo, [
      'close',
      w.questions.p2,
      '--reason',
      'answered',
    ]);
    expect(closed.ok).toBe(true);
    const after = await status(w, at(5), {changes: true});
    expect(block(after)).toContain(
      '*Answered or closed since the last report: Q102 (Keep the old export a week?).*',
    );
    // Not in the full report (D1 is the changes-only mode).
    expect(await status(w, at(5))).not.toContain(
      'Answered or closed since the last report',
    );
  });

  test('on a terminal the same items and lines print in ANSI', async () => {
    const {newAsk, w} = await changedWorld();
    const out = await run(w, at(5), {changes: true, color: true});
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Rename the job?');
    // R1: the unchanged P0 is kept, because You need to names it; the
    // unchanged P1 is left out.
    expect(out.stdout).toContain(`(${w.questions.p0})`);
    expect(out.stdout).not.toContain(`(${w.questions.p1})`);
    expect(out.stdout).toContain(
      '2 more questions have not changed since the last report.',
    );
    expect(out.stdout).toContain(
      '1 more request has not changed since the last report.',
    );
    expect(out.stdout).toContain(`(${newAsk})`);
  });
});

describe('thread status --changes keeps every question a printed line names (home-base-88y8m.8 R1)', () => {
  test('the trigger: an unchanged P0 shown last turn, and its request reaches a new stage', async () => {
    const w = await world();
    // A second request with its own question, both unchanged throughout: the
    // control that the rule keeps what is named, not everything.
    const other = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: at(0),
      sessionId: null,
      title: 'Archive the old runs',
    });
    if (other.kind !== 'filed') throw new Error(other.kind);
    const otherAsk = await fileAsk({
      approve: false,
      context: ['Context for Keep a year of runs?'],
      cwd: w.repo,
      default: 'I keep a year.',
      do: false,
      env: w.env,
      header: null,
      options: [],
      priority: '2',
      question: 'Keep a year of runs?',
      recommend: null,
      sessionId: null,
      to: other.id,
    });
    if (otherAsk.kind !== 'filed') throw new Error(otherAsk.kind);
    endTurnPasting(w, 3, await status(w, at(1)));
    // This turn the request reaches a new stage; no question changes.
    expect(
      runBr(w.repo, ['update', w.request, '--add-label', 'stage:code-done']).ok,
    ).toBe(true);
    const full = await status(w, at(5), {full: true});
    const changes = await status(w, at(5), {changes: true});

    // The request is kept, and its lines name the P0.
    const request = itemText(changes, w.request) ?? '';
    expect(request).toContain(CHANGED_MARK);
    expect(request).toContain('blocked on question 1');
    const waiting = /Waiting on you: (Q\d+) Which bucket\?/u.exec(request);
    expect(waiting).not.toBeNull();
    const named = waiting?.[1] ?? '';
    // That question is in the block, whole, under the number the line gives.
    const p0 = itemText(changes, w.questions.p0);
    expect(p0).toStartWith(`1. [${named}]`);
    expect(p0).toBe(itemText(full, w.questions.p0));
    expect(p0).toContain('Context for Which bucket?');
    expect(header(changes)).toContain('Which bucket?');
    // Every other question under the kept request is kept whole too.
    for (const id of [w.questions.p1, w.questions.p2, w.questions.p3]) {
      expect(itemText(changes, id)).not.toBeNull();
      expect(itemText(changes, id)).toBe(itemText(full, id));
    }
    // Control: the unchanged request and its question are left out.
    expect(itemText(changes, other.id)).toBeNull();
    expect(itemText(changes, otherAsk.id)).toBeNull();
    expect(itemText(full, otherAsk.id)).not.toBeNull();
    expect(block(changes)).toContain(
      '*1 more question has not changed since the last report.*',
    );
    expect(block(changes)).not.toContain('No question has changed');
  });
});

describe('thread status --changes with no usable last report (D1, critical rule 7)', () => {
  test('first report: every item whole, why, and no "unchanged" line', async () => {
    const w = await world();
    const full = await status(w, at(1));
    const changes = await status(w, at(1), {changes: true});
    for (const id of [w.request, ...Object.values(w.questions)]) {
      expect(itemText(changes, id)).toBe(itemText(full, id));
    }
    expect(block(changes)).toContain(`*${CHANGES_ALL_SHOWN_FIRST}*`);
    expect(changes).not.toContain('unchanged');
    expect(changes).not.toContain('changed since the last report');
    expect(full).not.toContain(CHANGES_ALL_SHOWN_FIRST);
  });

  test('R6 (home-base-88y8m.8): a report saved but never marked shown is no report he saw, and the line claims no more than that', async () => {
    const w = await world();
    // A report was printed, and the turn ended, but the Stop hook never
    // marked it shown: chooseBaseline gives `first`, as for no report at all.
    expect((await run(w, at(1))).code).toBe(0);
    const saved = readReportSnapshots(SESSION, w.env);
    if (saved.kind !== 'found') throw new Error(saved.kind);
    expect(saved.snapshots.every((entry) => entry.shownAt == null)).toBe(true);
    appendFileSync(
      w.transcript,
      `${JSON.stringify({subtype: 'turn_duration', timestamp: at(3).toISOString(), type: 'system'})}\n`,
    );
    const changes = await status(w, at(5), {changes: true});
    expect(block(changes)).toContain(
      '*Every request and question is shown: no report of this session that you saw could be found.*',
    );
    expect(changes).not.toContain('you have not seen a report');
    for (const id of [w.request, ...Object.values(w.questions)]) {
      expect(itemText(changes, id)).not.toBeNull();
    }
  });

  test('an unreadable last report: every item whole, the reason, and no "unchanged" line', async () => {
    const w = await world();
    const path = reportSnapshotsPath(SESSION, w.env);
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, 'garbage\n');
    appendFileSync(
      w.transcript,
      `${JSON.stringify({subtype: 'turn_duration', timestamp: at(3).toISOString(), type: 'system'})}\n`,
    );
    const changes = await status(w, at(5), {changes: true});
    for (const id of [w.request, ...Object.values(w.questions)]) {
      expect(itemText(changes, id)).not.toBeNull();
    }
    expect(changes).toContain(
      'Nothing is marked new or changed, and every question is in full',
    );
    expect(changes).not.toContain('unchanged');
    expect(changes).not.toContain('changed since the last report');
    expect(changes).not.toContain(CHANGES_ALL_SHOWN_FIRST);
  });
});

describe('what --changes saves (D1)', () => {
  test('the saved block is the printed one, the items are every item, and pasting it makes it the next baseline', async () => {
    const {w} = await changedWorld();
    const changes = await status(w, at(5), {changes: true});
    const printed = block(changes);

    const snapshots = readReportSnapshots(SESSION, w.env);
    if (snapshots.kind !== 'found') throw new Error(snapshots.kind);
    const saved = snapshots.snapshots.at(-1);
    expect(saved?.at).toBe(at(5).toISOString());
    expect(saved?.block).toEqual(snapshotBlockOf(printed));
    // Every item, not only the three printed: 2 requests and 5 questions.
    const keys = Object.keys(saved?.items ?? {});
    expect(keys.filter((key) => key.startsWith('r:'))).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith('q:'))).toHaveLength(5);
    for (const id of Object.values(w.questions)) {
      expect(keys).toContain(`q:${id}`);
    }
    // The trim guard holds the same block.
    const blocks = readStatusBlocks(SESSION, w.env);
    if (blocks.kind !== 'found') throw new Error(blocks.kind);
    expect(blocks.blocks.at(-1)?.text).toBe(printed);

    // Pasted: the Stop hook marks this snapshot shown, and the next turn
    // compares with it, so the P3 changed before it is no longer changed.
    endTurnPasting(w, 7, changes);
    const after = readReportSnapshots(SESSION, w.env);
    if (after.kind !== 'found') throw new Error(after.kind);
    expect(
      after.snapshots.find((entry) => entry.at === at(5).toISOString())
        ?.shownAt,
    ).toBe(at(7).toISOString());
    const next = await status(w, at(8), {changes: true});
    expect(next).not.toContain(CHANGED_MARK);
    expect(next).not.toContain(NEW_MARK);
    // The open P0 is kept whole (R1); the other four are counted.
    expect(block(next)).toContain(
      '*4 more questions have not changed since the last report.*',
    );
  });
});

describe('thread status --changes --full (D1)', () => {
  test('refused with exit 2 and one line, before anything is printed or saved', async () => {
    const w = await world();
    const out = await run(w, at(1), {changes: true, full: true});
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(CHANGES_WITH_FULL_REFUSAL);
    expect(out.stderr.split('\n')).toHaveLength(1);
    expect(readReportSnapshots(SESSION, w.env)).toEqual({kind: 'none'});
  });
});

describe('thread status --report-file (D2)', () => {
  function reportPath(name: string): string {
    const sb = createSandbox();
    sandboxes.push(sb);
    return join(sb.path, name);
  }

  test('the full report, markers on, no question on one line, and nothing meant for Claude', async () => {
    const {newAsk, w} = await changedWorld();
    const path = reportPath('report.md');
    const plain = await status(w, at(5));
    const out = await run(w, at(5), {reportFile: path});
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    // Stdout is what it is without the flag.
    expect(out.stdout).toBe(plain);

    const file = readFileSync(path, 'utf8');
    expect(file.split('\n')[0]).toBe(PART_ONE_RULE);
    expect(file.trimEnd().split('\n').at(-1)).toBe(PART_ONE_SEPARATOR);
    // Every question whole, the unchanged P2 included (stdout folds it).
    expect(inFull(plain, 'Keep the old export a week?')).toBe(false);
    expect(inFull(file, 'Keep the old export a week?')).toBe(true);
    expect(inFull(file, 'Which bucket?')).toBe(true);
    expect(file).not.toContain('Ask for the full report');
    // The markers.
    expect(file).toContain(`4. ${CHANGED_MARK} [Q103]`);
    expect(file).toContain(`5. ${NEW_MARK} [Q104]`);
    expect(file).toContain(`(${newAsk})`);
    // Nothing after the ♒ line.
    expect(file).not.toContain(SESSION_BEADS_ENABLED_LINE);
    expect(file).not.toContain('What to mark');
    expect(file).not.toContain('Nothing to mark');
    expect(file).not.toContain(VERDICT_LABEL);
  });

  test('with --changes: stdout is the changes-only block, the file is still the full report', async () => {
    const {w} = await changedWorld();
    const path = reportPath('report.md');
    const out = await run(w, at(5), {changes: true, reportFile: path});
    expect(out.code).toBe(0);
    expect(itemText(out.stdout, w.questions.p1)).toBeNull();
    const file = readFileSync(path, 'utf8');
    expect(itemText(file, w.questions.p1)).not.toBeNull();
    expect(file).not.toContain('have not changed since the last report.');
  });

  test('a file that cannot be written: stdout still printed, the path on stderr, exit 1', async () => {
    const w = await world();
    const path = join(reportPath('missing-dir'), 'report.md');
    const out = await run(w, at(1), {reportFile: path});
    expect(out.code).toBe(1);
    expect(block(out.stdout)).toContain('**Session:**');
    expect(out.stderr).toContain(
      `thread status: the report file was not written to ${path}: `,
    );
    expect(existsSync(path)).toBe(false);
  });

  test('R2 (home-base-88y8m.8): written through a temporary file and a rename, so a failed write leaves the earlier file whole', () => {
    const path = reportPath('report.md');
    const dir = join(path, '..');
    expect(writeReportFile(path, 'FIRST REPORT')).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('FIRST REPORT\n');
    // A good write leaves no temporary file behind.
    expect(readdirSync(dir)).toEqual(['report.md']);
    // The temporary file cannot be written (a directory sits at its name),
    // standing in for a write that fails partway: the report at the path is
    // the earlier one, whole, as reportFileFailedLine says.
    const temp = `${path}.${process.pid}.tmp`;
    mkdirSync(temp);
    const failed = writeReportFile(path, 'SECOND REPORT');
    expect(failed).not.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('FIRST REPORT\n');
    // Control: once the name is free, the same write replaces the file.
    rmSync(temp, {recursive: true});
    expect(writeReportFile(path, 'SECOND REPORT')).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('SECOND REPORT\n');
    expect(readdirSync(dir)).toEqual(['report.md']);
  });

  test('another session looked up: the file is written, and nothing is saved for either session', async () => {
    const w = await world();
    const path = reportPath('report.md');
    const out = await run(w, at(1), {reportFile: path, sessionId: SESSION});
    expect(out.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toStartWith(PART_ONE_RULE);
    // Control for the read-only lookup: the env names this session, so this
    // run IS its own and saved; one with the env cleared below does not.
    expect(readReportSnapshots(SESSION, w.env).kind).toBe('found');
    const lookup: World = {
      ...w,
      env: {...w.env, CLAUDE_CODE_SESSION_ID: undefined},
    };
    const path2 = reportPath('lookup.md');
    const before = readReportSnapshots(SESSION, w.env);
    const out2 = await run(lookup, at(2), {
      reportFile: path2,
      sessionId: SESSION,
    });
    expect(out2.code).toBe(0);
    expect(readFileSync(path2, 'utf8')).toStartWith(PART_ONE_RULE);
    expect(readReportSnapshots(SESSION, w.env)).toEqual(before);
  });
});
