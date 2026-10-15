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
 * Exit: 0 written · 1 a read or write failed, or no session · 2 usage.
 */

import type {BrIssue} from '../beads/br';
import type {EnvLike} from './paths';
import type {FoundSession, LocatedIssue} from './session-select';

import {brChildren, brClose, brUpdate, describeBrFailed} from '../beads/br';
import {
  ARCHIVED_LABEL,
  ARCHIVED_PREFIX,
  ASK_LABEL,
  DONE_PREFIX,
  oneLine,
  QUESTION_BEAD_TYPE,
} from './ask-format';
import {REQUEST_LABEL, sidLabel} from './session-bead';
import {
  selectSession,
  sessionBeadsKnob,
  sessionBeadsLabelled,
} from './session-select';

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

  if (mode === 'archive' && !session.bead.labels.includes(ARCHIVED_LABEL)) {
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
  for (const entry of openRequests.filter((item) => !isCreated(item))) {
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
  const order = [
    ...deepestFirst(questions.issues.filter(open)),
    ...deepestFirst(openRequests.filter(isCreated)),
  ];
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

  const alreadyClosed = session.bead.status === 'closed';
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

export async function runSessionClose(
  mode: CloseMode,
  options: CloseSessionOptions,
): Promise<number> {
  const command = mode === 'done' ? 'thread done' : 'thread archive';
  const {exitCode, lines} = describeCloseOutcome(
    command,
    await closeSession(mode, options),
  );
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
