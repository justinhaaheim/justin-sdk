/**
 * The web dashboard's model and its actions (home-base-yukaf.11, D-WEB): what
 * a card is, what version it carries, and which ONE command each button runs.
 * Pure: no server, no files, no processes, so the page renderer and the server
 * both import it and the tests call it directly.
 *
 * THE COMMANDS ARE THE TUI'S. Each one mirrors src/threads-dash/state.ts
 * (`markCommand`, `readCommand`, `unreadCommand`, `openCommand`) in
 * home-base, with one difference: the TUI spells the SDK as `bun run
 * justin-sdk thread …` from home-base's root, and this runs the SDK that is
 * serving the page (`process.execPath` + this package's own cli.ts, the way
 * capture's detached child does), so the page works from any repo.
 */

import type {InboxJson} from './session-inbox';

import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

import {type CardFact, type InboxSection, type YouAsked} from './session-card';
import {sessionDisplayName} from './session-name';

/** What a button can ask for. `resumeCommand` runs nothing: it returns the line. */
export const DASHBOARD_ACTIONS = [
  'archive',
  'done',
  'open',
  'read',
  'resumeCommand',
  'unread',
] as const;

export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];

export function isDashboardAction(value: unknown): value is DashboardAction {
  return (
    typeof value === 'string' &&
    (DASHBOARD_ACTIONS as readonly string[]).includes(value)
  );
}

/** F24: why Open makes no new workspace for a session with no checkout. */
export const NO_CHECKOUT =
  'Not available: no checkout recorded for this session, and claude --resume from the wrong directory finds nothing.';

/** One session as the page shows it: the inbox card minus the heavy model. */
export interface DashboardSession {
  card: {
    action: {command: string | null; text: string};
    age: string | null;
    emoji: string;
    facts: CardFact[];
    optional: {command: string; text: string} | null;
    pane: string | null;
    repoTag: string | null;
    resume: string;
    status: string;
    title: string;
    /** F1 (home-base-yukaf.14): the second "You need to" line, or null. */
    unsent: {command: string | null; text: string} | null;
    youAsked: YouAsked;
  };
  /** F24: the checkout `claude --resume` must run in; null when unknown. */
  checkout: string | null;
  /** The unsent input-box text (D-DRAFTS), or null. */
  inputDraft: string | null;
  lastActivityAt: string | null;
  /** What `thread read --seen` takes; null = no reply from Claude recorded. */
  lastAssistantAt: string | null;
  /** F6: this row stands for this many sessions; null = not folded. */
  repeats: number | null;
  repo: string | null;
  section: InboxSection;
  sessionBeadId: string | null;
  sessionId: string;
  /** This CARD's version (`cardVersion`): what every action must carry. */
  stateVersion: string;
  title: string;
  tracked: boolean;
  /** True / false, or null when it could not be told (D-READ-STATE). */
  unread: boolean | null;
}

export interface DashboardInbox {
  /** What the inbox could not read, each with its reason. Shown on the page. */
  problems: string[];
  /** Why every `unread` is null, when the read marks could not be read. */
  readMarksFailure: string | null;
  sessions: DashboardSession[];
  /** The bead's `stateVersion`: sha256 over every session's id + lastActivityAt. */
  stateVersion: string;
  summary: {count: number; emoji: string; key: string; title: string}[];
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * One card's version: sha256 of the session id, its session bead id, its
 * section and its last activity. An action carries the version of the card
 * it was pressed on, and the server refuses it when the session's version now
 * differs: the card changed since the page showed it.
 *
 * PER CARD, NOT PER INBOX (a deviation from the bead's wording, recorded on
 * home-base-yukaf.11). A working session's lastActivityAt moves every few
 * seconds, so a version over the WHOLE inbox would refuse almost every click
 * while any other session was working. The inbox-wide version is still
 * computed (`inboxVersion`) and served; the refusal uses this one.
 */
export function cardVersion(s: {
  lastActivityAt: string | null;
  section: string;
  sessionBeadId: string | null;
  sessionId: string;
}): string {
  return sha256([s.sessionId, s.sessionBeadId, s.section, s.lastActivityAt]);
}

/** The bead's stateVersion: sha256 over every session's id + lastActivityAt. */
export function inboxVersion(
  sessions: readonly {lastActivityAt: string | null; sessionId: string}[],
): string {
  return sha256(sessions.map((s) => [s.sessionId, s.lastActivityAt]));
}

/** The page's model of `thread inbox --json` (`inboxJson`). */
export function dashboardInboxOf(json: InboxJson): DashboardInbox {
  const problems: string[] = [];
  if (json.readMarks.kind === 'failed') {
    problems.push(
      `Read / unread could not be checked: ${json.readMarks.reason}`,
    );
  }
  if (!json.panes.ok) {
    problems.push(
      `The cmux panes could not be looked up (${json.panes.reason}), so Open makes a new workspace where the card knows no pane.`,
    );
  }
  if (json.inputDrafts.kind === 'failed') {
    problems.push(
      `Unsent input-box text could not be read: ${json.inputDrafts.reason}`,
    );
  }
  if (json.corrupt.length > 0) {
    problems.push(
      `${json.corrupt.length} line(s) of the sessions index (${json.indexPath}) could not be parsed, so those sessions are missing here.`,
    );
  }
  const sessions = json.sessions.map((row): DashboardSession => {
    const card = row.card;
    const base = {
      lastActivityAt: row.lastActivityAt,
      section: row.section,
      sessionBeadId: row.sessionBeadId,
      sessionId: row.sessionId,
    };
    return {
      card: {
        action: {command: card.action.command, text: card.action.text},
        age: card.age,
        emoji: card.emoji,
        facts: card.facts,
        optional:
          card.optional == null
            ? null
            : {command: card.optional.command, text: card.optional.text},
        pane: card.pane,
        repoTag: card.repoTag,
        resume: card.resume,
        status: card.status,
        title: card.title,
        unsent:
          card.unsent == null
            ? null
            : {command: card.unsent.command, text: card.unsent.text},
        youAsked: card.youAsked,
      },
      checkout: row.checkout,
      inputDraft: row.inputDraft?.text ?? null,
      lastAssistantAt: row.lastAssistantAt,
      repeats: row.repeats?.count ?? null,
      repo: row.repo,
      stateVersion: cardVersion(base),
      title: row.title,
      tracked: row.tracked,
      unread: row.unread,
      ...base,
    };
  });
  return {
    problems,
    readMarksFailure:
      json.readMarks.kind === 'failed' ? json.readMarks.reason : null,
    sessions,
    stateVersion: inboxVersion(sessions),
    summary: json.summary.map((entry) => ({
      count: entry.count,
      emoji: entry.emoji,
      key: entry.key,
      title: entry.title,
    })),
  };
}

// ── The command each button runs ────────────────────────────────────────────

/** argv for a mark, or one shell line copied from the inbox JSON (the pane line). */
export type DashboardCommand =
  | {argv: string[]; kind: 'argv'}
  | {kind: 'shell'; line: string};

/** How the log and the page print a command. */
export function dashboardCommandText(command: DashboardCommand): string {
  if (command.kind === 'shell') return command.line;
  return command.argv
    .map((arg) =>
      /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ');
}

/** `thread archive`'s reason from this page; written as "archived: <this>". */
export const DASHBOARD_ARCHIVE_REASON =
  'archived from the threads web dashboard';

/** This package's own CLI: the child runs the SDK that serves the page. */
const CLI_PATH = fileURLToPath(new URL('../cli.ts', import.meta.url));

/** `bun <this SDK's cli.ts> thread <args>`. */
export function sdkThreadArgv(args: readonly string[]): string[] {
  return [process.execPath, CLI_PATH, 'thread', ...args];
}

export type ActionPlan =
  /** Refused before anything runs: the reason is shown verbatim (409). */
  | {kind: 'refused'; reason: string}
  /** Exactly one command to run. */
  | {command: DashboardCommand; kind: 'run'}
  /** Nothing to run: the text is the answer (the resume command). */
  | {kind: 'show'; text: string};

const UNTRACKED_REFUSAL =
  'Not available: this session has no session bead, so there is nothing to mark done or archive. Marks for untracked sessions are not built yet.';

/**
 * Which ONE command `action` runs for `s`, or why it is refused. The page
 * disables a refused button with this reason as its tooltip, and the server
 * calls it again on the freshly read session before running anything.
 */
export function planAction(
  action: DashboardAction,
  s: DashboardSession,
  readMarksFailure: string | null = null,
): ActionPlan {
  switch (action) {
    case 'archive':
      if (!s.tracked || s.sessionBeadId == null) {
        return {kind: 'refused', reason: UNTRACKED_REFUSAL};
      }
      return {
        command: {
          argv: sdkThreadArgv([
            'archive',
            s.sessionBeadId,
            '--reason',
            DASHBOARD_ARCHIVE_REASON,
          ]),
          kind: 'argv',
        },
        kind: 'run',
      };
    case 'done':
      if (!s.tracked || s.sessionBeadId == null) {
        return {kind: 'refused', reason: UNTRACKED_REFUSAL};
      }
      return {
        command: {
          argv: sdkThreadArgv(['done', '--session', s.sessionId]),
          kind: 'argv',
        },
        kind: 'run',
      };
    case 'read':
      if (s.lastAssistantAt == null) {
        return {
          kind: 'refused',
          reason:
            'Not available: no reply from Claude is recorded for this session, so it has no read state.',
        };
      }
      return {
        command: {
          argv: sdkThreadArgv([
            'read',
            s.sessionId,
            '--seen',
            s.lastAssistantAt,
          ]),
          kind: 'argv',
        },
        kind: 'run',
      };
    case 'unread':
      if (s.unread == null) {
        return {
          kind: 'refused',
          reason:
            readMarksFailure == null
              ? 'Not available: no reply from Claude is recorded for this session, so it has no read state.'
              : `Not available: read / unread could not be checked: ${readMarksFailure}`,
        };
      }
      return {
        command: {argv: sdkThreadArgv(['unread', s.sessionId]), kind: 'argv'},
        kind: 'run',
      };
    case 'open':
      // The TUI's `o`: the session's cmux pane when the inbox knows it,
      // otherwise a new workspace running the resume command, named the way
      // the workspace-naming hook would name it (home-base-j8q3e.5 D8).
      if (s.card.pane != null) {
        return {command: {kind: 'shell', line: s.card.pane}, kind: 'run'};
      }
      // F24 (home-base-yukaf.14, D-LAYOUT): claude --resume finds a session
      // only from its own checkout, so the new workspace starts there; with
      // no checkout recorded, a workspace that cannot resume is not opened.
      // A resume line that starts with `cd '<dir>'` (untracked sessions)
      // sets its own directory.
      if (s.checkout == null && !/^cd\s/u.test(s.card.resume)) {
        return {kind: 'refused', reason: NO_CHECKOUT};
      }
      return {
        command: {
          argv: [
            'cmux',
            'new-workspace',
            '--name',
            sessionDisplayName(s.card.repoTag, s.card.title),
            ...(s.checkout == null ? [] : ['--cwd', s.checkout]),
            '--command',
            s.card.resume,
          ],
          kind: 'argv',
        },
        kind: 'run',
      };
    case 'resumeCommand':
      return {kind: 'show', text: s.card.resume};
  }
}
