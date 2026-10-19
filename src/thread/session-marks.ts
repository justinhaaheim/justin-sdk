/**
 * Justin's marks on a session (status report v4, epic home-base-vzwbj.4 D1
 * "JUSTIN'S MARKS"; built by home-base-vzwbj.4.2) — thin wrappers over br in
 * the beads DB that holds the session bead.
 *
 *   thread note "<text>"            appends `- <YYYY-MM-DD HH:mm>: <text>` to the
 *                                   session bead's notes (read, append, write —
 *                                   `br update --notes` replaces; never a comment)
 *   thread done [session] [--reason "<text>"]
 *                                   closes the session's open questions, then its
 *                                   open requests, then the session bead, each
 *                                   with `done: Justin — <text>` (or `done:
 *                                   Justin` with no reason). Knob on only; the
 *                                   legacy `thread done` is untouched (done.ts).
 *   thread archive [session] --reason "<why>"
 *                                   the same with `archived: <why>`, and the
 *                                   label `archived` on the session bead.
 *
 * Requests and questions are found by label (`request` / `ask` + `sid:<id>`)
 * in EVERY beads DB the index names for the session, so a request adopted in a
 * second checkout is closed too. A DB that cannot be read stops done/archive
 * before anything is closed: closing the session over requests nobody could
 * see would hide them (rule 7).
 *
 * JUSTIN'S MARK IS THE AUTHORITY (conductor decision, 2026-10-11, on Justin's
 * 2026-10-08 words: he will "mark sessions as complete and/or archive them if
 * he deems the remaining items low priority/not needed"; he rejected gates).
 * So every close passes br's `--force`: br otherwise refuses to close a bead
 * whose children are open (exit 3, "parent issue has N open children",
 * measured 2026-10-11), and `--force` closes the parent and LEAVES the
 * children open. Nothing is hidden: the children still open afterwards are
 * read back (`br show` → `dependents`) and printed under "Left open (still in
 * the backlog):" with id and title.
 *
 * ONLY WHAT THE SESSION CREATED IS CLOSED (home-base-vzwbj.4.9 R4): a request
 * adopted with `thread request --bead` (its parent is not the session bead)
 * is RELEASED instead — its `request` and `sid:` labels removed, its status
 * untouched — and printed under "Released back to the backlog:". Archiving a
 * session that worked on an epic must not close the epic.
 *
 *   thread unmark [--session <bead|sid>]
 *                                   reverses the newest done/archive not yet
 *                                   undone (for that session, or of all):
 *                                   reopens each bead it closed and puts back
 *                                   the status it had, removes the label it
 *                                   added, gives released requests their
 *                                   request and sid labels back (home-base-
 *                                   yukaf.9, D-GMAIL-KEYS; the record is the
 *                                   one closeSession writes BEFORE it closes,
 *                                   marks-undo.ts).
 *
 * Exit: 0 written · 1 a read or write failed, or no session · 2 usage.
 * `thread unmark`: 0 restored · 1 a br call failed (named) · 2 nothing to undo.
 */

import type {BrIssue} from '../beads/br';
import type {MarkUndoRecord} from './marks-undo';
import type {EnvLike} from './paths';
import type {FoundSession, LocatedIssue} from './session-select';
import type {StatusFileWrite} from './status-file';

import {
  brChildren,
  brClose,
  brReopen,
  brShow,
  brUpdate,
  describeBrFailed,
} from '../beads/br';
import {
  ARCHIVED_LABEL,
  ARCHIVED_PREFIX,
  ASK_LABEL,
  DONE_PREFIX,
  oneLine,
  QUESTION_BEAD_TYPE,
} from './ask-format';
import {
  appendMarkUndo,
  appendUndone,
  marksUndoPath,
  newestUndoable,
  readMarksUndo,
  undoableById,
  undoLine,
} from './marks-undo';
import {REQUEST_LABEL, sidLabel} from './session-bead';
import {
  selectSession,
  sessionBeadsKnob,
  sessionBeadsLabelled,
} from './session-select';
import {
  statusAfterClose,
  writeStatusAfterClose,
  writeStatusForSession,
} from './session-status-file';
import {
  describeStop,
  realScheduleStopDeps,
  scheduleSessionStop,
  type ScheduleStopDeps,
} from './session-stop';

type Selected =
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; session: FoundSession};

async function selectForMark(input: {
  cwd: string;
  env: EnvLike;
  selector: string | null;
  sessionId: string | null;
}): Promise<Selected> {
  const knob = await sessionBeadsKnob(input.cwd, input.env);
  if (!knob.ok) return {kind: 'failed', reason: knob.reason};
  const selection = selectSession({
    env: input.env,
    selector: input.selector,
    sessionIdOption: input.sessionId,
  });
  switch (selection.kind) {
    case 'found':
      return selection;
    case 'checkoutMissing':
      return {
        kind: 'failed',
        reason: `this session's beads live in ${selection.checkoutPath}, which no longer exists (or no longer holds a beads database)`,
      };
    case 'failed':
      return {kind: 'failed', reason: selection.reason};
    case 'noSession':
      return {
        kind: 'failed',
        reason:
          input.selector == null || input.selector.trim() === ''
            ? `${selection.reason}. From a plain terminal, name the session: its session bead id, or --session <claude session id>`
            : selection.reason,
      };
  }
}

// ---------------------------------------------------------------------------
// thread note
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD HH:mm` in local time — the stamp Justin reads. */
export function noteStamp(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/** The notes after appending one dated line. */
export function appendNote(
  existing: string | null,
  text: string,
  now: Date,
): string {
  const line = `- ${noteStamp(now)}: ${text}`;
  const before = existing?.trimEnd() ?? '';
  return before === '' ? line : `${before}\n${line}`;
}

export interface ThreadNoteOptions {
  cwd?: string;
  env?: EnvLike;
  now?: Date;
  /** `--session`: a session bead id or a session id; else CLAUDE_CODE_SESSION_ID. */
  session: string | null;
  text: string | null;
}

export type ThreadNoteOutcome =
  | {beadId: string; kind: 'noted'; line: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'usage'; message: string};

export async function noteSession(
  options: ThreadNoteOptions,
): Promise<ThreadNoteOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const text = options.text == null ? '' : oneLine(options.text);
  if (text === '') {
    return {kind: 'usage', message: 'give the note: thread note "<text>"'};
  }
  const selected = await selectForMark({
    cwd,
    env,
    selector: options.session,
    sessionId: null,
  });
  if (selected.kind === 'failed') return selected;
  const {session} = selected;
  // resolveSession read the bead with `br show` just now, so these notes are
  // current to within the time it took to get here.
  const notes = appendNote(session.bead.notes, text, now);
  const written = brUpdate({db: session.db, env}, session.bead.id, {notes});
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the note was NOT written: ${describeBrFailed(written)}`,
    };
  }
  return {
    beadId: session.bead.id,
    kind: 'noted',
    line: `- ${noteStamp(now)}: ${text}`,
  };
}

export function describeNoteOutcome(outcome: ThreadNoteOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'noted':
      return {
        exitCode: 0,
        lines: [`session ${outcome.beadId} · note added: ${outcome.line}`],
      };
    case 'usage':
      return {exitCode: 2, lines: [`thread note: ${outcome.message}`]};
    case 'failed':
      return {exitCode: 1, lines: [`thread note: ${outcome.reason}`]};
  }
}

export async function runThreadNote(
  options: ThreadNoteOptions,
): Promise<number> {
  const {exitCode, lines} = describeNoteOutcome(await noteSession(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}

// ---------------------------------------------------------------------------
// thread done / thread archive
// ---------------------------------------------------------------------------

export interface CloseSessionOptions {
  cwd?: string;
  env?: EnvLike;
  /** `done`: optional text after `done: Justin — `. `archive`: required. */
  reason: string | null;
  /** The positional: a session bead id or a session id. */
  selector: string | null;
  /** `--session`, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  /**
   * yukaf.22 `--stop`: after the mark is written and printed, SIGTERM the
   * session's Claude process a few seconds later (session-stop.ts). Default
   * false. The cmux workspace is never closed.
   */
  stop?: boolean;
}

export type CloseMode = 'archive' | 'done';

interface ClosedBead {
  id: string;
  title: string;
}

export type CloseSessionOutcome =
  | {
      alreadyClosed: boolean;
      closed: ClosedBead[];
      failures: string[];
      kind: 'closed';
      /** Children of the closed beads that are still open (br --force leaves them). */
      leftOpen: ClosedBead[];
      /** Why some children could not be read back; non-empty means exit 1. */
      leftOpenProblems: string[];
      mode: CloseMode;
      reason: string;
      /**
       * R4: adopted requests (`thread request --bead`), released rather than
       * closed — labels removed, status untouched.
       */
      released: ClosedBead[];
      session: ClosedBead;
      /** True when the session bead itself is closed at the end. */
      sessionClosed: boolean;
      /** The claude session id the mark was for (yukaf.22 --stop needs it). */
      sessionId: string;
      /**
       * The status line's file, rewritten once the session bead is closed
       * (home-base-yukaf.6); null when the session bead is still open.
       */
      statusFile: StatusFileWrite | null;
      /**
       * F11: the id of the undo record this mark wrote (`thread unmark --mark
       * <id>` reverses exactly it); null when nothing changed, so no record.
       */
      undoId: string | null;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'usage'; message: string};

/** The close reason for a mode. */
export function closeReasonFor(mode: CloseMode, text: string | null): string {
  const reason = text == null ? '' : oneLine(text);
  if (mode === 'archive') return `${ARCHIVED_PREFIX}${reason}`;
  return reason === '' ? DONE_PREFIX : `${DONE_PREFIX} — ${reason}`;
}

/** Deepest first, so a child is closed before the bead it hangs under. */
function deepestFirst(entries: readonly LocatedIssue[]): LocatedIssue[] {
  const depth = (issue: BrIssue): number => issue.id.split('.').length;
  return [...entries].sort((a, b) => depth(b.issue) - depth(a.issue));
}

export async function closeSession(
  mode: CloseMode,
  options: CloseSessionOptions,
): Promise<CloseSessionOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (
    mode === 'archive' &&
    (options.reason == null || oneLine(options.reason) === '')
  ) {
    return {
      kind: 'usage',
      message:
        'thread archive needs --reason "<why>" (it is written as "archived: <why>")',
    };
  }
  const selected = await selectForMark({
    cwd,
    env,
    selector: options.selector,
    sessionId: options.sessionId,
  });
  if (selected.kind === 'failed') return selected;
  const {session} = selected;
  const reason = closeReasonFor(mode, options.reason);

  const questions = sessionBeadsLabelled(
    session,
    {
      all: false,
      label: ASK_LABEL,
      types: [QUESTION_BEAD_TYPE],
    },
    env,
  );
  const requests = sessionBeadsLabelled(
    session,
    {
      all: false,
      label: REQUEST_LABEL,
    },
    env,
  );
  const problems = [...new Set([...questions.problems, ...requests.problems])];
  if (problems.length > 0) {
    return {
      kind: 'failed',
      reason: `nothing was closed — some of this session's beads could not be read, and closing the session over them would hide them: ${problems.join('; ')}`,
    };
  }

  // R4 (home-base-vzwbj.4.9): only what THIS session created is closed. A
  // request whose parent is the session bead was filed by `thread request`; one
  // adopted with `thread request --bead` keeps its own parent (or none) and is
  // RELEASED — its request and sid labels removed, its status untouched — so
  // archiving a session never closes an epic it merely worked on. The session
  // bead's children are read from br (a request in another DB is never one of
  // them); if they cannot be read, nothing is closed.
  const sessionChildren = brChildren({db: session.db, env}, session.bead.id);
  if (sessionChildren.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: `nothing was closed — could not tell which requests this session created (the children of ${session.bead.id}): ${sessionChildren.kind === 'notFound' ? 'br cannot find it' : describeBrFailed(sessionChildren)}`,
    };
  }
  const createdHere = new Set(
    sessionChildren.children.map((child) => child.id),
  );
  const isCreated = (entry: LocatedIssue): boolean =>
    entry.db === session.db && createdHere.has(entry.issue.id);

  const closed: ClosedBead[] = [];
  const released: ClosedBead[] = [];
  const failures: string[] = [];
  const open = (entry: LocatedIssue): boolean =>
    entry.issue.status !== 'closed' &&
    entry.issue.status !== 'tombstone' &&
    entry.issue.id !== session.bead.id;
  const openRequests = requests.issues.filter(open);
  const toRelease = openRequests.filter((item) => !isCreated(item));
  const order = [
    ...deepestFirst(questions.issues.filter(open)),
    ...deepestFirst(openRequests.filter(isCreated)),
  ];
  const alreadyClosed = session.bead.status === 'closed';
  const addArchivedLabel =
    mode === 'archive' && !session.bead.labels.includes(ARCHIVED_LABEL);

  // D-GMAIL-KEYS (home-base-yukaf.9): the undo record is written BEFORE
  // anything changes, and a mark whose record cannot be written is refused,
  // so `thread unmark` can always put back exactly what this closes.
  const undo = {
    at: new Date().toISOString(),
    closed: [
      ...order.map((entry) => ({
        db: entry.db,
        id: entry.issue.id,
        priorStatus: entry.issue.status,
      })),
      ...(alreadyClosed
        ? []
        : [
            {
              db: session.db,
              id: session.bead.id,
              priorStatus: session.bead.status,
            },
          ]),
    ],
    labelsAdded: addArchivedLabel ? [ARCHIVED_LABEL] : [],
    mode,
    released: toRelease.map((entry) => ({db: entry.db, id: entry.issue.id})),
    sessionBeadId: session.bead.id,
    sessionDb: session.db,
    sessionId: session.sessionId,
  };
  // F11 (home-base-yukaf.14): the record's id goes back to the caller and is
  // printed, so the TUI's `u` reverses THIS record. Nothing to change → no
  // record → null, and the TUI pushes nothing to undo.
  let undoId: string | null = null;
  if (
    undo.closed.length > 0 ||
    undo.released.length > 0 ||
    undo.labelsAdded.length > 0
  ) {
    const recorded = appendMarkUndo(undo, env);
    if (recorded.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `nothing was closed — the undo record could not be written, and a mark that \`thread unmark\` could not reverse is refused: ${recorded.error}`,
      };
    }
    undoId = recorded.id;
  }

  if (addArchivedLabel) {
    const labelled = brUpdate({db: session.db, env}, session.bead.id, {
      addLabels: [ARCHIVED_LABEL],
    });
    if (labelled.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `nothing was closed — the label "${ARCHIVED_LABEL}" could not be added to ${session.bead.id}: ${describeBrFailed(labelled)}`,
      };
    }
  }

  for (const entry of toRelease) {
    const result = brUpdate({db: entry.db, env}, entry.issue.id, {
      removeLabels: [REQUEST_LABEL, sidLabel(session.sessionId)],
    });
    if (result.kind === 'failed') {
      failures.push(
        `${entry.issue.id} (${entry.issue.title}) was NOT released (it still carries the request label): ${describeBrFailed(result)}`,
      );
    } else {
      released.push({id: entry.issue.id, title: entry.issue.title});
    }
  }
  for (const entry of order) {
    const result = brClose({db: entry.db, env}, entry.issue.id, reason, {
      force: true,
    });
    if (result.kind === 'failed') {
      failures.push(
        `${entry.issue.id} (${entry.issue.title}) was NOT closed: ${describeBrFailed(result)}`,
      );
    } else {
      closed.push({id: entry.issue.id, title: entry.issue.title});
    }
  }

  let sessionClosed = alreadyClosed;
  if (!alreadyClosed) {
    const result = brClose({db: session.db, env}, session.bead.id, reason, {
      force: true,
    });
    if (result.kind === 'failed') {
      failures.push(
        `the session bead ${session.bead.id} was NOT closed: ${describeBrFailed(result)}`,
      );
    } else {
      sessionClosed = true;
    }
  }

  // What --force left open: the open children of the session bead and of every
  // request, read back AFTER the closes so the states are current.
  // Released requests are not closed, so their children are not listed here.
  const parents = [
    {db: session.db, id: session.bead.id},
    ...requests.issues
      .filter((entry) => entry.issue.id !== session.bead.id)
      .filter(
        (entry) =>
          isCreated(entry) ||
          entry.issue.status === 'closed' ||
          entry.issue.status === 'tombstone',
      )
      .map((entry) => ({db: entry.db, id: entry.issue.id})),
  ];
  const leftOpen: ClosedBead[] = [];
  const leftOpenProblems: string[] = [];
  const seen = new Set<string>();
  for (const parent of parents) {
    const children = brChildren({db: parent.db, env}, parent.id);
    if (children.kind !== 'ok') {
      leftOpenProblems.push(
        `could not list the children of ${parent.id}: ${children.kind === 'notFound' ? 'br cannot find it' : describeBrFailed(children)}`,
      );
      continue;
    }
    for (const child of children.children) {
      if (child.status === 'closed' || child.status === 'tombstone') continue;
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      leftOpen.push({id: child.id, title: child.title});
    }
  }
  // D-STATUSLINE (home-base-yukaf.6): the mark shows on the next status-line
  // render, from what was just closed, without waiting for a capture. Only
  // when the session bead really is closed: an open one is not marked.
  const statusFile = sessionClosed
    ? writeStatusAfterClose(
        env,
        session.sessionId,
        statusAfterClose({
          closedIds: new Set(closed.map((bead) => bead.id)),
          mode,
          now: new Date(),
          questions: questions.issues,
          releasedIds: new Set(released.map((bead) => bead.id)),
          requests: requests.issues,
          sessionBeadId: session.bead.id,
        }),
      )
    : null;
  return {
    alreadyClosed,
    closed,
    failures,
    kind: 'closed',
    leftOpen,
    leftOpenProblems,
    mode,
    reason,
    released,
    session: {id: session.bead.id, title: session.bead.title},
    sessionClosed,
    sessionId: session.sessionId,
    statusFile,
    undoId,
  };
}

export function describeCloseOutcome(
  command: string,
  outcome: CloseSessionOutcome,
): {exitCode: 0 | 1 | 2; lines: string[]} {
  switch (outcome.kind) {
    case 'closed': {
      const lines = [
        outcome.alreadyClosed
          ? `session ${outcome.session.id} "${outcome.session.title}" was already closed`
          : outcome.sessionClosed
            ? `session ${outcome.session.id} "${outcome.session.title}" closed · ${outcome.reason}`
            : `session ${outcome.session.id} "${outcome.session.title}" is STILL OPEN`,
      ];
      if (outcome.closed.length > 0) {
        lines.push('', `Closed with it (${outcome.closed.length}):`, '');
        for (const bead of outcome.closed)
          lines.push(`  - ${bead.id} · ${bead.title}`, '');
      }
      if (outcome.released.length > 0) {
        lines.push(
          '',
          `Released back to the backlog (adopted, not created here — left open, request label removed): ${outcome.released.length}`,
          '',
        );
        for (const bead of outcome.released)
          lines.push(`  - ${bead.id} · ${bead.title}`, '');
      }
      if (outcome.leftOpen.length > 0) {
        lines.push(
          '',
          `Left open (still in the backlog): ${outcome.leftOpen.length}`,
          '',
        );
        for (const bead of outcome.leftOpen)
          lines.push(`  - ${bead.id} · ${bead.title}`, '');
      }
      if (outcome.leftOpenProblems.length > 0) {
        lines.push('', '⚠️ What was left open could not all be read:', '');
        for (const problem of outcome.leftOpenProblems)
          lines.push(`  - ${problem}`, '');
      }
      if (outcome.failures.length > 0) {
        lines.push('', '⚠️ Not closed:', '');
        for (const failure of outcome.failures)
          lines.push(`  - ${failure}`, '');
      }
      // The mark itself succeeded; only the status line will lag, so this is
      // said but does not change the exit code.
      if (outcome.statusFile?.kind === 'failed') {
        lines.push(
          '',
          `⚠️ The status line will not show this until the next prompt: ${outcome.statusFile.path} could not be written: ${outcome.statusFile.error}`,
        );
      }
      // F11: printed on success AND on a partial failure, since the record was
      // written before the first br call either way.
      if (outcome.undoId != null) lines.push('', undoLine(outcome.undoId));
      const failed =
        outcome.failures.length > 0 || outcome.leftOpenProblems.length > 0;
      return {exitCode: failed ? 1 : 0, lines};
    }
    case 'usage':
      return {exitCode: 2, lines: [`${command}: ${outcome.message}`]};
    case 'failed':
      return {exitCode: 1, lines: [`${command}: ${outcome.reason}`]};
  }
}

/**
 * yukaf.22 `--stop`, after the mark's own lines: only when the mark left the
 * session bead closed (now or already), so a failed or partial mark never
 * ends the session. Returns the extra lines and the exit code they add.
 */
export async function stopAfterMark(
  outcome: CloseSessionOutcome,
  deps: ScheduleStopDeps,
): Promise<{exitCode: 0 | 1; lines: string[]}> {
  if (outcome.kind !== 'closed') {
    return {
      exitCode: 0,
      lines: [
        'Not stopped: the mark was not made, so the session keeps running.',
      ],
    };
  }
  if (!outcome.sessionClosed && !outcome.alreadyClosed) {
    return {
      exitCode: 0,
      lines: [
        'Not stopped: the session bead is still open, so the session keeps running.',
      ],
    };
  }
  return describeStop(
    await scheduleSessionStop(outcome.sessionId, deps),
    outcome.sessionId,
  );
}

/** What runSessionClose uses; each is injectable for tests (G10, home-base-yukaf.25). */
export interface RunSessionCloseDeps {
  close?: (
    mode: CloseMode,
    options: CloseSessionOptions,
  ) => Promise<CloseSessionOutcome>;
  stop?: ScheduleStopDeps;
  /** One printed line; default console.log for out, console.error for err. */
  write?: (line: string, stream: 'err' | 'out') => void;
}

export async function runSessionClose(
  mode: CloseMode,
  options: CloseSessionOptions,
  deps: RunSessionCloseDeps = {},
): Promise<number> {
  const command = mode === 'done' ? 'thread done' : 'thread archive';
  const print =
    deps.write ??
    ((line: string, stream: 'err' | 'out'): void => {
      (stream === 'out' ? console.log : console.error)(line);
    });
  const outcome = await (deps.close ?? closeSession)(mode, options);
  const {exitCode, lines} = describeCloseOutcome(command, outcome);
  for (const line of lines) print(line, exitCode === 0 ? 'out' : 'err');
  if (options.stop !== true) return exitCode;
  // The mark is written and printed; only now is the stop looked at.
  const stop = await stopAfterMark(
    outcome,
    deps.stop ?? realScheduleStopDeps(options.env ?? process.env),
  );
  for (const line of ['', ...stop.lines]) {
    print(line, stop.exitCode === 0 ? 'out' : 'err');
  }
  // A failed mark keeps its own exit code; else the stop's decides.
  return exitCode === 0 ? stop.exitCode : exitCode;
}

// ---------------------------------------------------------------------------
// thread unmark
// ---------------------------------------------------------------------------

export interface UnmarkOptions {
  cwd?: string;
  env?: EnvLike;
  /**
   * `--mark`: the id of one undo record (`thread done`/`archive` print it,
   * F11). That record and no other is reversed; null = pick by --session.
   */
  mark?: string | null;
  now?: Date;
  /** `--session`: a session bead id or a claude session id; null = the newest mark of all. */
  session: string | null;
}

export type UnmarkOutcome =
  | {
      failures: string[];
      kind: 'unmarked';
      labelsRemoved: string[];
      mode: CloseMode;
      relabelled: string[];
      /** Each bead put back, with the status it has again. */
      reopened: {id: string; status: string}[];
      sessionBeadId: string;
      /** How the status line's file went after a full restore; null otherwise. */
      statusFile: string | null;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'nothing'; reason: string};

/**
 * D-GMAIL-KEYS (home-base-yukaf.9). Reverses the newest undoable mark: the
 * beads are reopened in the REVERSE of the order they were closed (the session
 * bead first, so a request is never reopened under a closed parent), each one
 * read first so a bead that is already open is only given its status back.
 * Any failure leaves the record undoable, so running it again retries what is
 * left; only a full restore appends the `undone` line.
 */
export async function unmarkSession(
  options: UnmarkOptions,
): Promise<UnmarkOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const read = readMarksUndo(env);
  if (read.kind === 'failed') return {kind: 'failed', reason: read.reason};
  const markId = options.mark?.trim() ?? '';
  let record: MarkUndoRecord | null;
  if (markId === '') {
    record = newestUndoable(read.records, options.session);
  } else {
    const byId = undoableById(read.records, markId);
    if (byId.kind !== 'found') {
      return {
        kind: 'nothing',
        reason:
          byId.kind === 'alreadyUndone'
            ? `nothing to undo: the mark ${markId} in ${marksUndoPath(env)} is already undone`
            : `nothing to undo: ${marksUndoPath(env)} holds no mark with the id ${markId}`,
      };
    }
    record = byId.record;
  }
  if (record == null) {
    const scope =
      options.session == null || options.session.trim() === ''
        ? 'no done or archive mark'
        : `no done or archive mark for ${options.session.trim()}`;
    return {
      kind: 'nothing',
      reason: `nothing to undo: ${marksUndoPath(env)} holds ${scope} that is not already undone`,
    };
  }

  const failures: string[] = [];
  const reopened: {id: string; status: string}[] = [];
  for (const bead of [...record.closed].reverse()) {
    const target = {db: bead.db, env};
    const shown = brShow(target, bead.id);
    if (shown.kind === 'failed') {
      failures.push(
        `${bead.id} was NOT reopened: it could not be read: ${describeBrFailed(shown)}`,
      );
      continue;
    }
    if (shown.kind === 'notFound') {
      failures.push(
        `${bead.id} was NOT reopened: br cannot find it in ${bead.db}`,
      );
      continue;
    }
    let status = shown.issue.status;
    if (status === 'closed') {
      const result = brReopen(target, bead.id);
      if (result.kind === 'failed') {
        failures.push(
          `${bead.id} was NOT reopened: ${describeBrFailed(result)}`,
        );
        continue;
      }
      status = 'open';
    }
    if (status !== bead.priorStatus) {
      const result = brUpdate(target, bead.id, {status: bead.priorStatus});
      if (result.kind === 'failed') {
        failures.push(
          `${bead.id} was reopened but its status is NOT back to ${bead.priorStatus}: ${describeBrFailed(result)}`,
        );
        continue;
      }
    }
    reopened.push({id: bead.id, status: bead.priorStatus});
  }

  const labelsRemoved: string[] = [];
  if (record.labelsAdded.length > 0) {
    const result = brUpdate({db: record.sessionDb, env}, record.sessionBeadId, {
      removeLabels: record.labelsAdded,
    });
    if (result.kind === 'failed') {
      failures.push(
        `the label ${record.labelsAdded.join(', ')} was NOT removed from ${record.sessionBeadId}: ${describeBrFailed(result)}`,
      );
    } else {
      labelsRemoved.push(...record.labelsAdded);
    }
  }

  const relabelled: string[] = [];
  for (const bead of record.released) {
    const result = brUpdate({db: bead.db, env}, bead.id, {
      addLabels: [REQUEST_LABEL, sidLabel(record.sessionId)],
    });
    if (result.kind === 'failed') {
      failures.push(
        `${bead.id} did NOT get its request labels back: ${describeBrFailed(result)}`,
      );
    } else {
      relabelled.push(bead.id);
    }
  }

  let statusFile: string | null = null;
  if (failures.length === 0) {
    const done = appendUndone(record.id, now.toISOString(), env);
    if (done.kind === 'failed') {
      failures.push(
        `everything was put back, but the record could not be marked undone (running \`thread unmark\` again only re-checks the same beads): ${done.error}`,
      );
    }
    // D-STATUSLINE: the status line stops saying done or archived now, not at
    // the next capture. A failure here only delays that, so it is said, not fatal.
    const written = await writeStatusForSession({
      cwd,
      env,
      keepNewer: false,
      now,
      sessionId: record.sessionId,
    });
    statusFile =
      written.kind === 'failed'
        ? `not rewritten: ${written.error}`
        : written.kind === 'skipped'
          ? `not rewritten: ${written.reason}`
          : 'rewritten';
  }
  return {
    failures,
    kind: 'unmarked',
    labelsRemoved,
    mode: record.mode,
    relabelled,
    reopened,
    sessionBeadId: record.sessionBeadId,
    statusFile,
  };
}

export function describeUnmarkOutcome(outcome: UnmarkOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'nothing':
      return {exitCode: 2, lines: [`thread unmark: ${outcome.reason}`]};
    case 'failed':
      return {exitCode: 1, lines: [`thread unmark: ${outcome.reason}`]};
    case 'unmarked': {
      const lines = [
        outcome.failures.length === 0
          ? `session ${outcome.sessionBeadId}: the ${outcome.mode} mark is undone`
          : `session ${outcome.sessionBeadId}: the ${outcome.mode} mark is only PARTLY undone`,
      ];
      if (outcome.reopened.length > 0) {
        lines.push('', `Reopened (${outcome.reopened.length}):`, '');
        for (const bead of outcome.reopened)
          lines.push(`  - ${bead.id} · ${bead.status}`, '');
      }
      if (outcome.labelsRemoved.length > 0) {
        lines.push('', `Label removed: ${outcome.labelsRemoved.join(', ')}`);
      }
      if (outcome.relabelled.length > 0) {
        lines.push(
          '',
          `Request labels given back: ${outcome.relabelled.join(', ')}`,
        );
      }
      if (outcome.failures.length > 0) {
        lines.push(
          '',
          '⚠️ Not put back (run `thread unmark` again to retry; the record is kept):',
          '',
        );
        for (const failure of outcome.failures)
          lines.push(`  - ${failure}`, '');
      }
      if (outcome.statusFile != null && outcome.statusFile !== 'rewritten') {
        lines.push('', `⚠️ The status line file was ${outcome.statusFile}`);
      }
      return {exitCode: outcome.failures.length > 0 ? 1 : 0, lines};
    }
  }
}

export async function runThreadUnmark(options: UnmarkOptions): Promise<number> {
  const {exitCode, lines} = describeUnmarkOutcome(await unmarkSession(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
