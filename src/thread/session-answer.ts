/**
 * `thread answer` with the sessionBeads knob ON — Justin answers the session's
 * open questions in his terminal (status report v4, epic home-base-vzwbj.4
 * D5; built by home-base-vzwbj.4.2). With the knob off, command.ts runs the
 * old answer page / `--classic` walk (answer-ui.ts) exactly as before.
 *
 *   thread answer [session bead id | session id | question id]
 *       walks the session's OPEN questions, most urgent first. Each is printed
 *       in full, then one line is read:
 *         text   → br close <id> --reason "answer: <text>"
 *         Enter  → skipped; it stays open
 *         d      → "answer: default taken — <default>" (refused for a P0,
 *                  which has no default by definition)
 *       Each answer is written before the next question is shown, so a ctrl-C
 *       mid-walk loses nothing already typed.
 *   thread answer --ask <id> "<text>"
 *       answers one question, no prompt.
 *
 * The answer is the question bead's CLOSE REASON, never a comment (critical
 * rule 3.2). The web answer page is not retargeted in this push (D5).
 *
 * Exit: 0 ran (answered, skipped, or nothing open) · 1 a write or a read
 * failed, or the session/question could not be found · 2 usage.
 */

import type {BrIssue} from '../beads/br';
import type {OutputStyle} from '../cli-style';
import type {EnvLike} from './paths';
import type {FoundSession} from './session-select';

import {createInterface} from 'readline';

import {
  brClose,
  brShow,
  describeBrFailed,
  findBeadsDb,
  findBeadsWorkspace,
} from '../beads/br';
import {outputStyle} from '../cli-style';
import {
  ANSWER_PREFIX,
  ASK_LABEL,
  DEFAULT_TAKEN_PREFIX,
  oneLine,
  parseAsk,
  QUESTION_BEAD_TYPE,
} from './ask-format';
import {renderAsk, sortAsks} from './ask-render';
import {readSessionIndex} from './session-index';
import {
  selectSession,
  sessionBeadsKnob,
  sessionBeadsLabelled,
} from './session-select';

/** How the walk talks to the terminal. Tests inject a scripted one. */
export interface AnswerTerminal {
  print(text: string): void;
  /** One line, or null at end of input (ctrl-D, or a closed pipe). */
  readLine(prompt: string): Promise<string | null>;
}

export interface SessionAnswerOptions {
  /** `--ask <id>`: answer this one question with `text`, no prompt. */
  ask: string | null;
  cwd?: string;
  env?: EnvLike;
  /** A session bead id, a session id, or a question id (the positional). */
  selector: string | null;
  /** `--session`, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  style?: OutputStyle;
  terminal?: AnswerTerminal;
  /** The one-shot answer text (with `--ask`). */
  text: string | null;
}

/** The close reason an answer is stored as. */
export function answerReason(text: string): string {
  return `${ANSWER_PREFIX}${text}`;
}

/** The default's text, or why `d` cannot take it. */
export function takeDefault(
  question: Pick<BrIssue, 'description' | 'priority'>,
): {ok: false; reason: string} | {ok: true; reason: string} {
  if (question.priority === 0) {
    return {
      ok: false,
      reason:
        'a P0 has no default — the session is stopped until you answer. Type an answer, or press Enter to skip.',
    };
  }
  const parsed = parseAsk(question.description);
  if (!parsed.ok) {
    return {
      ok: false,
      reason:
        'this question is not in the ask format, so its default is unknown. Type an answer, or press Enter to skip.',
    };
  }
  const text =
    parsed.ask.default.kind === 'text'
      ? parsed.ask.default.text
      : parsed.ask.default.why;
  return {ok: true, reason: answerReason(`${DEFAULT_TAKEN_PREFIX}${text}`)};
}

/**
 * The real terminal: readline's async iterator, which BUFFERS lines. A plain
 * `rl.question()` loses lines that arrive while no question is pending — a
 * piped answer file would drop every line after the first.
 */
function createReadlineTerminal(): {
  close: () => void;
  terminal: AnswerTerminal;
} {
  const rl = createInterface({input: process.stdin, terminal: false});
  const lines = rl[Symbol.asyncIterator]();
  return {
    close: () => rl.close(),
    terminal: {
      print: (text) => console.log(text),
      async readLine(prompt) {
        process.stdout.write(prompt);
        const next = await lines.next();
        if (next.done === true) {
          process.stdout.write('\n');
          return null;
        }
        return next.value;
      },
    },
  };
}

type Located =
  | {db: string; issue: BrIssue; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; searched: string[]};

/**
 * Find one bead by id: in the DBs of a session the index names it under (its
 * id starts with a recorded bead's id plus "."), then in the cwd's DB.
 */
function locateBead(id: string, cwd: string, env: EnvLike): Located {
  const dbs: string[] = [];
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${index.path}: ${index.error}`,
    };
  }
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) {
        if (id !== sighting.beadId && !id.startsWith(`${sighting.beadId}.`)) {
          continue;
        }
        const db = findBeadsDb(sighting.beadsDir);
        if (db.kind === 'found' && !dbs.includes(db.db)) dbs.push(db.db);
      }
    }
  }
  const here = findBeadsWorkspace(cwd);
  if (here.kind === 'found' && !dbs.includes(here.db)) dbs.push(here.db);
  for (const db of dbs) {
    const shown = brShow({db, env}, id);
    if (shown.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `could not look up ${id} in ${db}: ${describeBrFailed(shown)}`,
      };
    }
    if (shown.kind === 'ok') return {db, issue: shown.issue, kind: 'found'};
  }
  return {kind: 'notFound', searched: dbs};
}

function refuseNonQuestion(issue: BrIssue): string | null {
  if (issue.issueType !== QUESTION_BEAD_TYPE) {
    return `${issue.id} is a ${issue.issueType}, not a question`;
  }
  if (issue.status === 'closed') {
    return `${issue.id} is already closed (${issue.closeReason ?? 'no reason recorded'})`;
  }
  return null;
}

interface WalkItem {
  db: string;
  issue: BrIssue;
}

interface WalkResult {
  answered: string[];
  failures: string[];
  skipped: string[];
}

/** The walk itself: print, read, write, next. */
export async function walkQuestions(
  items: readonly WalkItem[],
  terminal: AnswerTerminal,
  style: OutputStyle,
  env?: EnvLike,
): Promise<WalkResult> {
  const result: WalkResult = {answered: [], failures: [], skipped: []};
  const ordered = sortAsks(items.map((item) => ({...item.issue, item})));
  let stopped = false;
  for (const [index, entry] of ordered.entries()) {
    if (stopped) {
      result.skipped.push(entry.id);
      continue;
    }
    const {db, issue} = entry.item;
    terminal.print('');
    terminal.print(renderAsk(issue, index + 1, style));
    terminal.print('');
    const hint =
      issue.priority === 0
        ? 'Enter skips'
        : 'Enter skips · d takes the default';
    for (;;) {
      const line = await terminal.readLine(`  Your answer (${hint}) › `);
      if (line == null) {
        stopped = true;
        result.skipped.push(issue.id);
        break;
      }
      const text = oneLine(line);
      if (text === '') {
        terminal.print(`  ↷ ${issue.id} skipped — it stays open.`);
        result.skipped.push(issue.id);
        break;
      }
      let reason: string;
      if (text.toLowerCase() === 'd') {
        const taken = takeDefault(issue);
        if (!taken.ok) {
          terminal.print(`  ✋ ${taken.reason}`);
          continue;
        }
        reason = taken.reason;
      } else {
        reason = answerReason(text);
      }
      const closed = brClose({db, env}, issue.id, reason);
      if (closed.kind === 'failed') {
        const failure = `${issue.id} was NOT recorded: ${describeBrFailed(closed)}`;
        terminal.print(`  ⚠️ ${failure}`);
        result.failures.push(failure);
      } else {
        terminal.print(`  ✓ ${issue.id} recorded: ${reason}`);
        result.answered.push(issue.id);
      }
      break;
    }
  }
  return result;
}

export type SessionAnswerOutcome =
  | {id: string; kind: 'answeredOne'; reason: string}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'nothingOpen'; problems: string[]; session: string}
  | {kind: 'usage'; message: string}
  | {kind: 'walked'; problems: string[]; result: WalkResult};

function sessionLabel(session: FoundSession): string {
  return `${session.bead.id} "${session.bead.title}"`;
}

/** The whole command, minus printing the outcome. */
export async function answerSessionQuestions(
  options: SessionAnswerOptions,
): Promise<SessionAnswerOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const style = options.style ?? outputStyle(process.stdout);
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};

  // ---- one-shot ----
  if (options.ask != null) {
    const id = options.ask.trim();
    const text = options.text == null ? '' : oneLine(options.text);
    if (id === '' || text === '') {
      return {
        kind: 'usage',
        message:
          'give the question id and the answer: thread answer --ask <id> "<answer>"',
      };
    }
    const located = locateBead(id, cwd, env);
    if (located.kind === 'failed')
      return {kind: 'failed', reason: located.reason};
    if (located.kind === 'notFound') {
      return {
        kind: 'failed',
        reason: `${id} was not found${located.searched.length > 0 ? ` in ${located.searched.join(' or ')}` : ' (no beads DB to look in: not a recorded session and no beads workspace here)'}`,
      };
    }
    const refusal = refuseNonQuestion(located.issue);
    if (refusal != null) return {kind: 'failed', reason: refusal};
    const reason = answerReason(text);
    const closed = brClose({db: located.db, env}, id, reason);
    if (closed.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `${id} was NOT recorded: ${describeBrFailed(closed)}`,
      };
    }
    return {id, kind: 'answeredOne', reason};
  }

  // ---- the walk: a session's open questions, or one question ----
  const selection = selectSession({
    env,
    selector: options.selector,
    sessionIdOption: options.sessionId,
  });
  let items: WalkItem[];
  let problems: string[] = [];
  let label: string;
  if (selection.kind === 'found') {
    const open = sessionBeadsLabelled(
      selection.session,
      {
        all: false,
        label: ASK_LABEL,
        types: [QUESTION_BEAD_TYPE],
      },
      env,
    );
    problems = open.problems;
    items = open.issues
      .filter((entry) => entry.issue.status !== 'closed')
      .map((entry) => ({db: entry.db, issue: entry.issue}));
    label = sessionLabel(selection.session);
  } else if (
    selection.kind === 'noSession' &&
    options.selector != null &&
    options.selector.trim() !== ''
  ) {
    // Not a session: perhaps the id of one question.
    const id = options.selector.trim();
    const located = locateBead(id, cwd, env);
    if (located.kind === 'failed')
      return {kind: 'failed', reason: located.reason};
    if (located.kind === 'notFound') {
      return {
        kind: 'failed',
        reason: `${id} is not a session bead, a session id or a question that could be found (${selection.reason})`,
      };
    }
    const refusal = refuseNonQuestion(located.issue);
    if (refusal != null) return {kind: 'failed', reason: refusal};
    items = [{db: located.db, issue: located.issue}];
    label = id;
  } else if (selection.kind === 'checkoutMissing') {
    return {
      kind: 'failed',
      reason: `this session's beads live in ${selection.checkoutPath}, which no longer exists`,
    };
  } else {
    return {
      kind: 'failed',
      reason:
        selection.kind === 'noSession'
          ? `${selection.reason}. From a plain terminal, name the session: thread answer <session bead id>`
          : selection.reason,
    };
  }

  if (items.length === 0) {
    if (problems.length > 0) {
      return {kind: 'failed', reason: problems.join('; ')};
    }
    return {kind: 'nothingOpen', problems, session: label};
  }
  const own = options.terminal == null ? createReadlineTerminal() : null;
  const terminal = options.terminal ?? own?.terminal;
  if (terminal == null) return {kind: 'failed', reason: 'no terminal'};
  try {
    terminal.print(
      `${items.length} open question${items.length === 1 ? '' : 's'} for ${label}:`,
    );
    const result = await walkQuestions(items, terminal, style, env);
    return {kind: 'walked', problems, result};
  } finally {
    own?.close();
  }
}

export function describeSessionAnswerOutcome(outcome: SessionAnswerOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'answeredOne':
      return {
        exitCode: 0,
        lines: [`✓ ${outcome.id} recorded: ${outcome.reason}`],
      };
    case 'nothingOpen':
      return {
        exitCode: 0,
        lines: [`No open questions for ${outcome.session}.`],
      };
    case 'walked': {
      const {answered, failures, skipped} = outcome.result;
      const lines = [
        '',
        `Answered ${answered.length} · skipped ${skipped.length}${failures.length > 0 ? ` · NOT recorded ${failures.length}` : ''}`,
        ...outcome.problems.map(
          (problem) => `⚠️ ${problem} — questions there were not shown.`,
        ),
      ];
      return {
        exitCode: failures.length > 0 || outcome.problems.length > 0 ? 1 : 0,
        lines,
      };
    }
    case 'usage':
      return {exitCode: 2, lines: [`thread answer: ${outcome.message}`]};
    case 'disabled':
    case 'failed':
      return {exitCode: 1, lines: [`thread answer: ${outcome.reason}`]};
  }
}

/** `thread answer` (knob on): answer, print, return the exit code. */
export async function runSessionAnswer(
  options: SessionAnswerOptions,
): Promise<number> {
  const {exitCode, lines} = describeSessionAnswerOutcome(
    await answerSessionQuestions(options),
  );
  const write = exitCode === 1 ? console.error : console.log;
  for (const line of lines) write(line);
  return exitCode;
}
