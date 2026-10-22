/**
 * `thread open`'s draft restore (home-base-yukaf.34): once a real run has
 * opened its workspaces, the unsent text stored for each reopened session
 * (input-drafts.ts, decision D-DRAFTS of epic home-base-yukaf) is typed back
 * into that session's new input box, and left there UNSENT.
 *
 * Justin, 2026-10-20, after the first real run: "I didn't see any in-progress
 * text restored though. Not sure if I was supposed to?"; 2026-10-17: "we can
 * either put that text back in the text box or … flag to me in a very obvious
 * way".
 *
 * THE ONE THING IT MUST NEVER DO is submit a message. A restore that sends a
 * half-written message to a live session is worse than no restore. So:
 *
 * - `cmux send` does not press Enter by itself, but it reads the two-character
 *   sequences \n and \r INSIDE its text as Enter, and \t as Tab (`cmux send
 *   --help`, read 2026-10-20). A draft holding any backslash is never sent:
 *   those three are the only documented sequences, so what any other one
 *   (or a doubled backslash) does is unmeasured, and it is not measured on a
 *   live pane.
 * - A real newline or carriage return typed into a terminal is the Enter key.
 *   Every run of whitespace that holds a line break is collapsed to one space
 *   ("restored on one line"); a tab becomes a space; any other control
 *   character refuses the draft.
 * - The text goes after `--`, and `--workspace` and `--surface` are always
 *   named: without `--surface`, cmux types into the CALLER's own pane
 *   ($CMUX_SURFACE_ID, `cmux send --help`).
 * - One `cmux send` per draft. No `send-key`, no retry.
 *
 * WHERE: only into the single pane of a workspace this run OPENED (the
 * record's windows[].workspaces), never a workspace moved in with
 * --include-open, never a pane the run did not create.
 *
 * WHEN: the pane is read (`cmux read-screen`) every RESTORE_POLL_MS for up to
 * RESTORE_READY_TIMEOUT_MS, until it shows an EMPTY Claude input box (`❯` plus
 * U+00A0, findInputBox) with this session's `⌗ <id>` on the status line under
 * it, Claude not working and vim not in NORMAL mode. A box that already holds
 * text, or a pane showing another session, stops at once: nothing is typed.
 * So does a box showing Claude Code's prompt suggestion (home-base-yukaf.36
 * D4: findInputBox `suggested`), and the CHECK below never takes a
 * suggestion for the typed text. Neither the scan nor a close stores a
 * suggestion, so none is typed back from the store.
 *
 * CHECK: after the send the screen is read again (RESTORE_CONFIRM_READS times,
 * RESTORE_CONFIRM_MS apart: the app may still be drawing), and the draft only
 * counts as restored when draftIsMessage (pane-join.ts) finds the typed text
 * in the box; that comparison tolerates a box scrolled to the text's tail and
 * Claude Code's "[Pasted text #N]" stand-in. Then the draft file gets
 * restoredAt, restoredSurfaceId and restoredText; its text and clearedAt are
 * unchanged, because the text is still unsent.
 *
 * D-RECORD for the one write: the restore entry is in the open record, with
 * kind 'sending', BEFORE the send; a record that cannot be rewritten means
 * nothing is typed.
 *
 * CRITICAL RULE 7: "the screen could not be read", "the box never appeared"
 * and "typed, but the box does not show it" are distinct outcomes, and none
 * of them, nor any other, is counted as restored.
 *
 * An opened session whose draft still has its original pane in the live
 * cmux tree (the stored surfaceId) is not typed into: the output names the
 * command that selects that pane.
 */

import type {OutputStyle} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {InputDraftRead} from './input-drafts';
import type {LiveSurface, SourceRead} from './pane-join';
import type {EnvLike} from './paths';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  fieldLabelWidth,
  fieldLines,
  pad,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {markInputDraftRestored, readInputDraft} from './input-drafts';
import {
  draftIsMessage,
  findInputBox,
  readLiveSurfaces,
  readScreenForBox,
  screenLines,
  screenSessionId,
  SUGGESTION_EVIDENCE,
  vimMode,
  workingIndicator,
} from './pane-join';
import {selectWorkspaceCommand} from './session-card';

/** How often the new pane is read while Claude starts. */
export const RESTORE_POLL_MS = 500;

/** How long Claude gets to show an empty input box. */
export const RESTORE_READY_TIMEOUT_MS = 30_000;

/** After the send: how far apart, and how many times, the screen is read. */
export const RESTORE_CONFIRM_MS = 1000;
export const RESTORE_CONFIRM_READS = 5;

// ---------------------------------------------------------------------------
// The text (pure)
// ---------------------------------------------------------------------------

/** Built from code points: the editing tools rewrite these escapes into the invisible characters. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LINE_BREAK_RUN = new RegExp(
  `\\s*[\\n\\r${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]\\s*`,
  'gu',
);
const LINE_BREAK = new RegExp(
  `[\\n\\r${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`,
  'u',
);
const TAB_LIKE = /[\t\v\f]/gu;
const DOCUMENTED_ESCAPE = /\\[nrt]/u;
const PASTE_STAND_IN = /\[Pasted text #\d+/u;

export const ESCAPE_REASON =
  'it contains an escape sequence cmux would interpret (cmux send reads \\n and \\r inside its text as Enter, and \\t as Tab)';

export const BACKSLASH_REASON =
  'it contains a backslash: cmux send reads backslash escape sequences inside its text, and only \\n and \\r (Enter) and \\t (Tab) are documented, so what any other one does is unmeasured';

export const PASTE_REASON =
  'it contains "[Pasted text #N]", the stand-in Claude Code shows for pasted text the screen never showed, so typing it back would not bring back what was pasted';

/** A C0 or C1 control character, or DEL: a terminal reads it as a key. */
function controlCharacter(text: string): string | null {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return character;
  }
  return null;
}

export type RestorableText =
  | {
      /** A line break was collapsed: the text goes in on one line. */
      collapsed: boolean;
      kind: 'ok';
      /** Exactly what `cmux send` is given. */
      text: string;
    }
  | {kind: 'refused'; reason: string};

/**
 * The stored draft as it may be typed, or why it may not. Pure. Every run of
 * whitespace holding a line break becomes one space (the wrapped lines'
 * indentation goes with it); tabs, vertical tabs and form feeds become
 * spaces; then the ends are trimmed.
 */
export function restorableText(stored: string): RestorableText {
  if (DOCUMENTED_ESCAPE.test(stored)) {
    return {kind: 'refused', reason: ESCAPE_REASON};
  }
  if (stored.includes('\\')) return {kind: 'refused', reason: BACKSLASH_REASON};
  if (PASTE_STAND_IN.test(stored)) {
    return {kind: 'refused', reason: PASTE_REASON};
  }
  const text = stored
    .replace(LINE_BREAK_RUN, ' ')
    .replace(TAB_LIKE, ' ')
    .trim();
  const control = controlCharacter(text);
  if (control != null) {
    const code = (control.codePointAt(0) ?? 0)
      .toString(16)
      .toUpperCase()
      .padStart(4, '0');
    return {
      kind: 'refused',
      reason: `it contains the control character U+${code}, which a terminal reads as a key press`,
    };
  }
  if (text === '') {
    return {
      kind: 'refused',
      reason: 'nothing is left to type once its line breaks are removed',
    };
  }
  return {collapsed: LINE_BREAK.test(stored), kind: 'ok', text};
}

/**
 * The one write: `cmux send`, the workspace and the surface always named, the
 * text after `--`. Nothing presses Enter: no trailing newline, no `\n` (the
 * text was refused if it held a backslash), no `send-key`.
 */
export function sendArgs(
  workspaceId: string,
  surfaceRef: string,
  text: string,
): string[] {
  return [
    'send',
    '--workspace',
    workspaceId,
    '--surface',
    surfaceRef,
    '--',
    text,
  ];
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * What became of one stored draft. `restored` and (dry run) `wouldRestore`
 * are the only kinds that count as restored.
 */
export type RestoreKind =
  /** The box already held text: nothing typed. */
  | 'boxHasText'
  /** Typed, but the box does not show it afterwards. */
  | 'mismatch'
  /** No Claude input box appeared within the timeout. */
  | 'noBox'
  /** A box appeared, but no session id under it, or Claude kept working. */
  | 'notReady'
  /** The run record could not be rewritten before the send: nothing typed. */
  | 'notTried'
  /** The pane shows another session: nothing typed. */
  | 'otherSession'
  /** The text, or the workspace, rules it out before the pane is read. */
  | 'refused'
  | 'restored'
  /** The pane's screen could not be read (before anything was typed). */
  | 'screenUnreadable'
  | 'sendFailed'
  /** Written before the send; a record left at this kind means the run died there. */
  | 'sending'
  /** The draft's original pane is still in the live tree: not typed. */
  | 'stillOpen'
  | 'storeUnreadable'
  | 'treeUnreadable'
  /** Typed, then the screen could not be read: whether it is there is unknown. */
  | 'unreadableAfter'
  | 'vimNormal'
  /** The workspace this run opened is no longer in the tree. */
  | 'workspaceGone'
  | 'wouldRestore';

/**
 * The kinds that are a read or a write that FAILED (thread open exits 1), as
 * opposed to a decision made from what was read. A screen that cannot be
 * read is a failure; a box that never appears is an observation.
 */
const FAILED_KINDS: ReadonlySet<RestoreKind> = new Set<RestoreKind>([
  'mismatch',
  'notTried',
  'screenUnreadable',
  'sendFailed',
  'sending',
  'storeUnreadable',
  'treeUnreadable',
  'unreadableAfter',
]);

export interface DraftRestore {
  /** A line break was collapsed into a space for the send. */
  collapsed: boolean;
  /** `cmux select-workspace …` for the pane that still holds the text (stillOpen). */
  focusCommand: string | null;
  kind: RestoreKind;
  /** The workspace name, as thread open names it. */
  name: string;
  /** Why it was not restored; null when it was (or would be). */
  reason: string | null;
  /** Restored, but the draft file could not be marked so (the text IS in the box). */
  recordFailure: string | null;
  /** When the box was seen to hold the text; null when it was not. */
  restoredAt: string | null;
  /** When the send was made; null when nothing was sent. */
  sentAt: string | null;
  sessionId: string;
  /** The draft as stored, verbatim; null when the store could not be read. */
  storedText: string | null;
  /** The new pane it is (or was to be) typed into. */
  surfaceId: string | null;
  surfaceRef: string | null;
  /** What is (or would be) typed, line breaks collapsed; null when refused before that. */
  text: string | null;
  workspaceId: string | null;
  workspaceRef: string | null;
}

export interface RestoreRecord {
  /** false: --no-restore. */
  enabled: boolean;
  /** One per opened (or, in a dry run, planned) session with a live draft. */
  entries: DraftRestore[];
}

/** Whether any restore step failed (a read, the send, or the check). */
export function restoreFailed(record: RestoreRecord): boolean {
  return record.entries.some(
    (entry) => FAILED_KINDS.has(entry.kind) || entry.recordFailure != null,
  );
}

/** One session the run opened (or would open), and the workspace it got. */
export interface RestoreTarget {
  name: string;
  /** Why this workspace cannot take the draft at all; null when it can. */
  problem: string | null;
  sessionId: string;
  /** null in a dry run (nothing is opened) or when the uuid was not recorded. */
  workspaceId: string | null;
  workspaceRef: string | null;
}

export interface RestoreDeps {
  markRestored: (
    sessionId: string,
    restore: {at: string; surfaceId: string; text: string},
  ) => {kind: 'failed'; reason: string} | {kind: 'marked'};
  nowIso: () => string;
  nowMs: () => number;
  readDraft: (sessionId: string) => InputDraftRead;
  /** The live tree's surfaces with refs, ttys and workspace uuids. */
  readSurfaces: () => Promise<SourceRead<LiveSurface[]>>;
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
}

export function realRestoreDeps(run: CmuxRunner, env: EnvLike): RestoreDeps {
  return {
    markRestored: (sessionId, restore) =>
      markInputDraftRestored(sessionId, restore, env),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    readDraft: (sessionId) => readInputDraft(sessionId, env),
    readSurfaces: async () => await readLiveSurfaces(run),
    run,
    sleep: async (ms) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

// ---------------------------------------------------------------------------
// Reading the pane
// ---------------------------------------------------------------------------

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const TIMEOUT_WORDS = `${RESTORE_READY_TIMEOUT_MS / 1000} s`;

export type Readiness =
  | {kind: 'boxHasText'; reason: string}
  | {kind: 'noBox'; reason: string}
  | {kind: 'notReady'; reason: string}
  | {kind: 'otherSession'; reason: string}
  | {kind: 'ready'}
  | {kind: 'screenUnreadable'; reason: string}
  | {kind: 'vimNormal'; reason: string};

/**
 * Read the new pane until it shows an empty input box ready for text, or
 * stops being a pane that may be typed into, or the timeout passes. The
 * outcome at the timeout is what the LAST read showed, so an unreadable
 * screen and a screen with no box stay distinct (rule 7).
 */
export async function waitForEmptyBox(
  ref: string,
  sessionId: string,
  deps: Pick<RestoreDeps, 'nowMs' | 'run' | 'sleep'>,
): Promise<Readiness> {
  const want = sessionId.toLowerCase();
  const start = deps.nowMs();
  let last: Readiness = {
    kind: 'noBox',
    reason: `the box never appeared: ${ref} was not read`,
  };
  for (;;) {
    const screen = await readScreenForBox(deps.run, ref);
    if (screen.kind === 'unreadable') {
      last = {
        kind: 'screenUnreadable',
        reason: `the screen could not be read: cmux read-screen of ${ref} failed for ${TIMEOUT_WORDS} (last: ${screen.reason})`,
      };
    } else {
      const lines = screenLines(screen.text);
      const box = findInputBox(lines);
      if (box == null) {
        last = {
          kind: 'noBox',
          reason: `the box never appeared: ${ref} showed no Claude input box within ${TIMEOUT_WORDS}`,
        };
      } else if (box.draft !== '') {
        // yukaf.36 D4: a box showing Claude Code's suggestion is not typed
        // into either. Its value is empty, but typing over a suggestion has
        // not been measured, so this stays as cautious as before; only the
        // reason is told apart.
        return {
          kind: 'boxHasText',
          reason: box.suggested
            ? `the input box of ${ref} shows Claude Code's suggestion ("${cut(box.draft, 80)}"; ${SUGGESTION_EVIDENCE}), and nothing is typed into a box that shows one`
            : `the input box of ${ref} already holds text ("${cut(box.draft, 80)}"), and nothing is ever typed into a box that has some`,
        };
      } else {
        const shown = screenSessionId(lines, box);
        const working = workingIndicator(lines);
        if (shown != null && shown !== want) {
          return {
            kind: 'otherSession',
            reason: `${ref} shows session ${shown}, not ${want}, so nothing is typed there`,
          };
        }
        if (shown == null) {
          last = {
            kind: 'notReady',
            reason: `${ref} showed an empty input box, but its status line never showed the session id (⌗ ${want}) within ${TIMEOUT_WORDS}`,
          };
        } else if (working != null) {
          last = {
            kind: 'notReady',
            reason: `Claude was still working in ${ref} after ${TIMEOUT_WORDS} ("${cut(working, 70)}")`,
          };
        } else if (vimMode(lines, box) === 'normal') {
          return {
            kind: 'vimNormal',
            reason: `the input box of ${ref} is in vim NORMAL mode, where typed text is read as commands`,
          };
        } else {
          return {kind: 'ready'};
        }
      }
    }
    if (deps.nowMs() - start >= RESTORE_READY_TIMEOUT_MS) return last;
    await deps.sleep(RESTORE_POLL_MS);
  }
}

export type Confirmation =
  | {kind: 'mismatch'; reason: string}
  | {kind: 'restored'}
  | {kind: 'unreadableAfter'; reason: string};

/**
 * After the send: read the screen up to RESTORE_CONFIRM_READS times until the
 * box holds the typed text. Never sends again. A last read that failed is
 * `unreadableAfter`, never a mismatch and never restored.
 */
export async function confirmRestored(
  ref: string,
  text: string,
  deps: Pick<RestoreDeps, 'run' | 'sleep'>,
): Promise<Confirmation> {
  let last: Confirmation = {
    kind: 'unreadableAfter',
    reason: `the text was typed into ${ref}, but its screen was not read afterwards`,
  };
  for (let attempt = 0; attempt < RESTORE_CONFIRM_READS; attempt += 1) {
    await deps.sleep(RESTORE_CONFIRM_MS);
    const screen = await readScreenForBox(deps.run, ref);
    if (screen.kind === 'unreadable') {
      last = {
        kind: 'unreadableAfter',
        reason: `the text was typed into ${ref}, but its screen could not be read afterwards, so whether the box holds it is unknown (${screen.reason}); look at that pane`,
      };
      continue;
    }
    const lines = screenLines(screen.text);
    const box = findInputBox(lines);
    // yukaf.36 D4: Claude Code's suggestion is never the restored text, even
    // when it reads the same: it is drawn only while the box is EMPTY.
    if (box != null && !box.suggested && draftIsMessage(box.draft, text))
      return {kind: 'restored'};
    const working = workingIndicator(lines);
    const shown =
      box == null
        ? 'no input box is on screen'
        : box.draft === ''
          ? 'the box is empty'
          : box.suggested
            ? `the box is empty and shows only Claude Code's suggestion "${cut(box.draft, 80)}" (${SUGGESTION_EVIDENCE})`
            : `the box holds "${cut(box.draft, 80)}"`;
    last = {
      kind: 'mismatch',
      reason: `the text was typed into ${ref}, but the input box does not show it: ${shown}${
        working == null
          ? ''
          : `, and Claude is working ("${cut(working, 60)}"), so the text may have been SUBMITTED`
      }; look at that pane, it may hold part of the text`,
    };
  }
  return last;
}

// ---------------------------------------------------------------------------
// Planning and restoring
// ---------------------------------------------------------------------------

function blankEntry(target: RestoreTarget): DraftRestore {
  return {
    collapsed: false,
    focusCommand: null,
    kind: 'wouldRestore',
    name: target.name,
    reason: null,
    recordFailure: null,
    restoredAt: null,
    sentAt: null,
    sessionId: target.sessionId,
    storedText: null,
    surfaceId: null,
    surfaceRef: null,
    text: null,
    workspaceId: target.workspaceId,
    workspaceRef: target.workspaceRef,
  };
}

type Prepared =
  /** No live draft: nothing to restore, and nothing to say. */
  | {kind: 'none'}
  | {entry: DraftRestore; kind: 'decided'}
  | {
      entry: DraftRestore;
      kind: 'go';
      storedSurfaceId: string | null;
      storedWorkspaceId: string | null;
      text: string;
    };

/** The draft and its text, before any pane is read. */
function prepare(
  target: RestoreTarget,
  deps: Pick<RestoreDeps, 'readDraft'>,
): Prepared {
  const entry = blankEntry(target);
  const read = deps.readDraft(target.sessionId);
  if (read.kind === 'absent') return {kind: 'none'};
  if (read.kind === 'failed') {
    entry.kind = 'storeUnreadable';
    entry.reason = `the stored draft could not be read, so whether this session has unsent text cannot be told: ${read.reason}`;
    return {entry, kind: 'decided'};
  }
  if (read.draft.clearedAt != null) return {kind: 'none'};
  entry.storedText = read.draft.text;
  const text = restorableText(read.draft.text);
  if (text.kind === 'refused') {
    entry.kind = 'refused';
    entry.reason = text.reason;
    return {entry, kind: 'decided'};
  }
  entry.text = text.text;
  entry.collapsed = text.collapsed;
  if (target.problem != null) {
    entry.kind = 'refused';
    entry.reason = target.problem;
    return {entry, kind: 'decided'};
  }
  return {
    entry,
    kind: 'go',
    storedSurfaceId: read.draft.surfaceId,
    storedWorkspaceId: read.draft.workspaceId,
    text: text.text,
  };
}

/** Scope item 3: the draft's own pane is still open, so it is not typed again. */
function markStillOpen(
  prepared: Extract<Prepared, {kind: 'go'}>,
  surfaces: readonly LiveSurface[],
): boolean {
  const stored = prepared.storedSurfaceId?.toUpperCase() ?? null;
  if (stored == null) return false;
  const found = surfaces.find(
    (surface) => surface.id?.toUpperCase() === stored,
  );
  if (found == null) return false;
  const workspace = found.workspaceId ?? prepared.storedWorkspaceId;
  const command = workspace == null ? null : selectWorkspaceCommand(workspace);
  prepared.entry.kind = 'stillOpen';
  prepared.entry.focusCommand = command;
  // "may": the pane is open, but what its box holds now is not read here
  // (measured 2026-10-20: a draft's original pane can hold another session
  // since; its box then no longer shows this text).
  prepared.entry.reason = `your unsent text may still be in its original pane (${found.ref}), which is still open, so it is not typed a second time: ${
    command ?? `its workspace uuid is unknown`
  }`;
  return true;
}

/**
 * --dry-run: what a real run would do with each planned session's draft,
 * from the store and one read of the live tree (read-only). Pane-dependent
 * outcomes (box, send, check) cannot be known before the pane exists.
 */
export async function planRestores(
  targets: readonly RestoreTarget[],
  deps: Pick<RestoreDeps, 'readDraft' | 'readSurfaces'>,
): Promise<DraftRestore[]> {
  const prepared = targets.map((target) => prepare(target, deps));
  const going = prepared.filter(
    (item): item is Extract<Prepared, {kind: 'go'}> => item.kind === 'go',
  );
  const surfaces = going.length === 0 ? null : await deps.readSurfaces();
  for (const item of going) {
    if (surfaces == null) continue;
    if (!surfaces.ok) {
      item.entry.kind = 'treeUnreadable';
      item.entry.reason = `the cmux tree could not be read, so whether the draft's original pane is still open cannot be told: ${surfaces.reason}`;
      continue;
    }
    markStillOpen(item, surfaces.value);
  }
  return prepared.flatMap((item) => (item.kind === 'none' ? [] : [item.entry]));
}

/**
 * A real run: restore each opened session's draft, in order, one pane at a
 * time, rewriting the record after every step. Returns false when the record
 * could not be rewritten (then nothing more is typed).
 */
export async function restoreDrafts(
  targets: readonly RestoreTarget[],
  record: RestoreRecord,
  deps: RestoreDeps,
  save: () => boolean,
): Promise<boolean> {
  for (const target of targets) {
    const prepared = prepare(target, deps);
    if (prepared.kind === 'none') continue;
    record.entries.push(prepared.entry);
    if (prepared.kind === 'decided') {
      if (!save()) return false;
      continue;
    }
    const {entry, text} = prepared;
    const settle = (kind: RestoreKind, reason: string): boolean => {
      entry.kind = kind;
      entry.reason = reason;
      return save();
    };
    const workspaceId = target.workspaceId;
    if (workspaceId == null) {
      if (
        !settle(
          'refused',
          'the uuid of the workspace this run opened for it was not recorded, so its pane cannot be told from any other',
        )
      ) {
        return false;
      }
      continue;
    }
    const surfaces = await deps.readSurfaces();
    if (!surfaces.ok) {
      if (
        !settle(
          'treeUnreadable',
          `the cmux tree could not be read, so neither the new pane nor the draft's original pane could be checked: ${surfaces.reason}`,
        )
      ) {
        return false;
      }
      continue;
    }
    if (markStillOpen(prepared, surfaces.value)) {
      if (!save()) return false;
      continue;
    }
    const want = workspaceId.toUpperCase();
    const panes = surfaces.value.filter(
      (surface) => surface.workspaceId?.toUpperCase() === want,
    );
    const [pane] = panes;
    if (pane == null) {
      if (
        !settle(
          'workspaceGone',
          'the workspace this run opened for it is no longer in the cmux tree',
        )
      ) {
        return false;
      }
      continue;
    }
    if (panes.length > 1) {
      if (
        !settle(
          'refused',
          `the workspace this run opened for it has ${panes.length} panes, so which one holds its Claude cannot be told`,
        )
      ) {
        return false;
      }
      continue;
    }
    entry.surfaceId = pane.id ?? null;
    entry.surfaceRef = pane.ref;
    const ready = await waitForEmptyBox(pane.ref, target.sessionId, deps);
    if (ready.kind !== 'ready') {
      if (!settle(ready.kind, ready.reason)) return false;
      continue;
    }
    // D-RECORD for the one write: on disk before the send, or nothing is sent.
    entry.kind = 'sending';
    entry.sentAt = deps.nowIso();
    entry.reason =
      'the send was started, and the run stopped before its outcome was written; look at that pane';
    if (!save()) {
      entry.kind = 'notTried';
      entry.sentAt = null;
      entry.reason =
        'the run record could not be rewritten, so nothing was typed (no record, no write)';
      return false;
    }
    const sent = await deps.run(sendArgs(workspaceId, pane.ref, text));
    if (sent.kind === 'failed') {
      if (
        !settle(
          'sendFailed',
          `cmux send failed (${sent.reason}); part of the text may be in the input box of ${pane.ref}: look at it`,
        )
      ) {
        return false;
      }
      continue;
    }
    const check = await confirmRestored(pane.ref, text, deps);
    if (check.kind !== 'restored') {
      if (!settle(check.kind, check.reason)) return false;
      continue;
    }
    entry.kind = 'restored';
    entry.reason = null;
    entry.restoredAt = deps.nowIso();
    if (entry.surfaceId == null) {
      entry.recordFailure =
        'the new pane has no uuid in the cmux tree, so the draft file was not marked restored';
    } else {
      const marked = deps.markRestored(target.sessionId, {
        at: entry.restoredAt,
        surfaceId: entry.surfaceId,
        text,
      });
      if (marked.kind === 'failed') entry.recordFailure = marked.reason;
    }
    if (!save()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABELS = [
  'Text',
  'Typed',
  'Workspace',
  'Pane',
  'Why',
  'Session',
  'Recorded',
].map((label) => ({label, value: ''}));

function block(
  title: string,
  fields: {label: string; value: string}[],
  style: OutputStyle,
): string {
  return [
    wrapHanging(paint(title, ['bold'], style.color), {
      hang: BODY_COLUMN + 4,
      indent: BODY_COLUMN,
      width: style.width,
    }),
    fieldLines(fields, {
      color: style.color,
      indent: stepColumn(1),
      labelWidth: fieldLabelWidth(LABELS),
      width: style.width,
    }),
  ].join('\n');
}

/** The draft exactly as stored, every line indented, never wrapped. */
function verbatim(text: string): string {
  return text
    .split('\n')
    .map((line) => `${pad(DETAIL_COLUMN + 2)}${line}`)
    .join('\n');
}

function prose(text: string, style: OutputStyle): string {
  return wrapHanging(text, {
    hang: BODY_COLUMN,
    indent: BODY_COLUMN,
    width: style.width,
  });
}

function firstLine(entry: DraftRestore): string {
  return (entry.storedText ?? entry.text ?? '').split('\n')[0] ?? '';
}

function workspaceWords(entry: DraftRestore): string {
  const ref = entry.surfaceRef == null ? '' : `, pane ${entry.surfaceRef}`;
  if (entry.workspaceId == null) return `the new workspace${ref}`;
  return `${entry.workspaceRef ?? 'opened'} (${entry.workspaceId})${ref}`;
}

const ONE_LINE =
  'on one line: its line breaks became spaces, because a line break typed into the box would press Enter';

/**
 * The restore's sections for renderOpen: what was (or would be) restored,
 * what is still in its original pane, and what was not restored. Nothing when
 * --no-restore, or when the run opened nothing and found no draft.
 */
export function renderRestore(
  record: RestoreRecord,
  dryRun: boolean,
  opened: number,
  style: OutputStyle,
): string[] {
  if (!record.enabled) return [];
  if (opened === 0 && record.entries.length === 0) return [];
  const header = (text: string, emoji: string): string =>
    sectionHeader(text, {color: style.color, emoji});
  const restoredKind: RestoreKind = dryRun ? 'wouldRestore' : 'restored';
  const done = record.entries.filter((entry) => entry.kind === restoredKind);
  const stillOpen = record.entries.filter(
    (entry) => entry.kind === 'stillOpen',
  );
  const notRestored = record.entries.filter(
    (entry) => entry.kind !== restoredKind && entry.kind !== 'stillOpen',
  );
  const blocks: string[] = [];
  blocks.push(
    header(
      dryRun
        ? `Would restore ${done.length} ${done.length === 1 ? 'draft' : 'drafts'}`
        : `Restored drafts (${done.length})`,
      '✍️',
    ),
  );
  if (done.length === 0) {
    blocks.push(
      prose(
        record.entries.length === 0
          ? dryRun
            ? 'No session it would open has unsent text stored.'
            : 'No session this run opened had unsent text stored.'
          : 'None (see below).',
        style,
      ),
    );
  } else {
    blocks.push(
      prose(
        dryRun
          ? 'Each would be typed into its new input box once Claude shows it empty, and never sent.'
          : 'Typed into the input box and NOT sent: press Enter in that pane to send it, or clear it.',
        style,
      ),
    );
    blocks.push(
      spacedList(
        done.map((entry) =>
          block(
            entry.name,
            [
              {label: 'Text', value: firstLine(entry)},
              ...(entry.collapsed ? [{label: 'Typed', value: ONE_LINE}] : []),
              {label: 'Workspace', value: workspaceWords(entry)},
              ...(entry.recordFailure == null
                ? []
                : [
                    {
                      label: 'Recorded',
                      value: `NOT recorded in the draft file: ${entry.recordFailure}`,
                    },
                  ]),
            ],
            style,
          ),
        ),
      ),
    );
  }
  if (stillOpen.length > 0) {
    blocks.push(
      header(
        `Unsent text whose original pane is still open (${stillOpen.length})`,
        '👉',
      ),
    );
    blocks.push(
      prose(
        'Not typed into the new workspace. If the text is no longer in that pane, here it is in full:',
        style,
      ),
    );
    blocks.push(
      spacedList(
        stillOpen.map((entry) =>
          [
            block(
              entry.name,
              [
                {label: 'Session', value: entry.sessionId},
                {label: 'Pane', value: entry.reason ?? ''},
              ],
              style,
            ),
            ...(entry.storedText == null ? [] : [verbatim(entry.storedText)]),
          ].join('\n\n'),
        ),
      ),
    );
  }
  if (notRestored.length > 0) {
    blocks.push(
      header(
        dryRun
          ? `Would not restore (${notRestored.length})`
          : `Draft not restored (${notRestored.length})`,
        '⚠️',
      ),
    );
    blocks.push(
      prose(
        dryRun
          ? 'A real run would type nothing for these. The text is in the drafts store (thread drafts lists it); here it is in full:'
          : 'Nothing was typed for these unless the reason says so. The text is still in the drafts store (thread drafts lists it); here it is in full:',
        style,
      ),
    );
    blocks.push(
      spacedList(
        notRestored.map((entry) =>
          [
            block(
              entry.name,
              [
                {label: 'Session', value: entry.sessionId},
                {label: 'Workspace', value: workspaceWords(entry)},
                {
                  label: 'Why',
                  value: `${dryRun ? 'would not restore' : 'not restored'}: ${entry.reason ?? ''}`,
                },
              ],
              style,
            ),
            ...(entry.storedText == null ? [] : [verbatim(entry.storedText)]),
          ].join('\n\n'),
        ),
      ),
    );
  }
  return blocks;
}
