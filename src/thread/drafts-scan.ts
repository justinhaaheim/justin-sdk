/**
 * `thread drafts scan` and `thread drafts` (home-base-yukaf.4, decision
 * D-DRAFTS of epic home-base-yukaf): unsent text in a Claude Code input box,
 * recorded so that closing a pane never loses it.
 *
 * Justin, 2026-10-17: "it just happens to me fairly often that I'm writing
 * something and then I get distracted … the message is also not in the
 * transcript, it's not tracked in threads it's not anywhere else it's just
 * literally just kind of ephemeral text that's sitting in a text box".
 *
 * THE SCAN, read-only on cmux: read the tree (with ttys), read every
 * surface's screen, keep the Claude panes (findInputBox finds a box), and
 * place each one in a session — by the `⌗ <uuid>` Justin's status line shows
 * below the box, else by the liveness join of live-sessions.ts (a claude
 * process on the pane's tty whose argv or hook-store entry names exactly one
 * session). A pane that cannot be placed is reported, never guessed. Then,
 * per placed pane, the store (input-drafts.ts):
 *   - text in the box → written (source 'scan'), unless the stored text is
 *     identical and still live (then its `at` is left alone);
 *   - an empty box → a stored live draft is cleared (clearedAt);
 *   - text equal to the session's newest SENT user line (message log,
 *     whitespace collapsed) is still in the box, so it is unsent: written
 *     with sentMatch true and shown with a note (F23, home-base-yukaf.14).
 * After the panes, a stored live draft whose session was not seen is cleared
 * when its text equals that session's newest sent line (sent from elsewhere);
 * a sentMatch draft only when that line is newer than the draft.
 *
 * WHAT A SCREEN CAN AND CANNOT SAY (measured on the fixtures in
 * scripts/__fixtures__/pane-backfill and 1,029 input boxes in the 24 cmux
 * captures of 2026-10-17, Claude Code 2.1.302): an empty box with nothing in
 * it is `❯` plus U+00A0, so findInputBox reads it as ''. `read-screen` is
 * plain text, so Claude Code's prompt suggestion (a suggested next prompt it
 * draws dimmed in an EMPTY box after a turn, home-base-yukaf.36) reads exactly
 * like typed text. findInputBox marks it `suggested` only when the line under
 * the box ends with "← N agents" (pane-join.ts EMPTY_INPUT_FOOTER); such a box
 * counts as EMPTY here (D2): nothing is stored, a stored draft is cleared as
 * for an empty box, and the pane is listed under "Claude's suggestion, not
 * your typing" with its text. Without that hint a suggestion is read as
 * typed. A draft taller than the screen pushes the box's top rule off it: no
 * box is found, and that pane is not a Claude pane to this scan.
 *
 * CRITICAL RULE 7: cmux unreachable (exit 2, nothing written), a screen that
 * could not be read, a pane that could not be placed, and a store that could
 * not be written are each their own outcome in the output, never "no drafts".
 */

import type {OutputStyle} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {InputDraft, InputDraftList} from './input-drafts';
import type {
  HookStore,
  LiveSurface,
  ProcessRunner,
  ScreenRead,
} from './pane-join';
import type {EnvLike} from './paths';

import {homedir} from 'node:os';
import {basename} from 'node:path';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  fieldLines,
  HEADER_COLUMN,
  outputStyle,
  pad,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {realCmuxRunner} from './cmux';
import {
  clearInputDraft,
  listInputDrafts,
  readInputDraft,
  setInputDraftMissing,
  writeInputDraft,
} from './input-drafts';
import {joinLiveSessions} from './live-sessions';
import {readMessageLog} from './message-log';
import {
  defaultHookStorePath,
  findInputBox,
  paneFailureReason,
  readHookStore,
  readLiveSurfaces,
  readProcesses,
  readScreen,
  realProcessRunner,
  SCREEN_CONCURRENCY,
  screenLines,
  screenSessionId,
  SUGGESTION_EVIDENCE,
} from './pane-join';
import {tildeText} from './part-one';
import {liveSocketPath, socketSettingsJson} from './respawn';
import {selectWorkspaceCommand} from './session-card';
import {readSessionIndex} from './session-index';

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** What the scan did with the text it saw in one placed pane. */
export type FoundOutcome =
  /** Written to the store. */
  | 'stored'
  /**
   * F23: written to the store, marked sentMatch: the text equals the
   * session's newest sent message (typed again, not sent).
   */
  | 'storedSentMatch'
  /** The store could not be written (the text is still printed in full). */
  | 'storeFailed'
  /** The store already held this exact text, live: left as it was. */
  | 'unchanged';

export interface PanePlace {
  /** How the pane was placed: its status line, or a claude process on its tty. */
  placedBy: 'process' | 'screen';
  repo: string | null;
  sessionId: string;
  surfaceId: string | null;
  surfaceRef: string;
  workspaceId: string | null;
}

export interface FoundDraft extends PanePlace {
  /** Why the store write failed, for `storeFailed`; else null. */
  failure: string | null;
  outcome: FoundOutcome;
  /** The store file, when it was written or already held the text. */
  path: string | null;
  text: string;
}

export interface ClearedDraft {
  repo: string | null;
  sessionId: string;
  /**
   * yukaf.36 D2: the suggestion the box showed when a draft was cleared as
   * 'emptyBox' because the box held only Claude Code's suggestion; else null.
   */
  suggestion: string | null;
  /** The pane the box was seen empty in; null for a draft cleared as sent elsewhere. */
  surfaceRef: string | null;
  text: string;
  why: 'emptyBox' | 'missing' | 'sent';
}

export interface UnplacedDraftPane {
  /** The text in its box, '' when empty: printed, never stored. */
  draft: string;
  /** yukaf.36: the text is Claude Code's suggestion, not typed. */
  suggested: boolean;
  surfaceId: string | null;
  surfaceRef: string;
  why: string;
  workspaceId: string | null;
}

/**
 * yukaf.36 D2: a placed pane whose box shows only Claude Code's suggestion.
 * Nothing is stored for it; it is listed so the text never vanishes silently.
 */
export interface SuggestionPane extends PanePlace {
  text: string;
}

export interface ScanResult {
  /** Claude panes (an input box was found on screen). */
  claudePanes: number;
  cleared: ClearedDraft[];
  /** Placed panes whose box was empty (a box showing only a suggestion is counted in `suggestions`). */
  emptyPlaced: number;
  /** Store writes, store reads, and sources that failed: each named. */
  failures: string[];
  found: FoundDraft[];
  kind: 'scanned';
  /** yukaf.36 D2: placed panes showing Claude Code's suggestion, not typing. */
  suggestions: SuggestionPane[];
  surfacesRead: number;
  unplaced: UnplacedDraftPane[];
  unreadable: {reason: string; surfaceRef: string}[];
}

export type ScanOutcome = ScanResult | {kind: 'unreachable'; reason: string};

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface ScanDeps {
  env: EnvLike;
  hookStorePath: string;
  /** The time a write or clear is stamped with (ISO). */
  nowIso: () => string;
  ps: ProcessRunner;
  run: CmuxRunner;
}

/** Whitespace collapsed: a screen wraps long text and indents its continuation lines. */
export function normalizedText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The session's newest SENT user line, whitespace collapsed; null when the
 * log holds none. `failed` when the log exists and could not be read.
 */
function newestSentText(
  sessionId: string,
  env: EnvLike,
):
  | {at: string | null; kind: 'read'; text: string | null}
  | {kind: 'failed'; reason: string} {
  const log = readMessageLog(sessionId, env);
  if (log.kind === 'missing') return {at: null, kind: 'read', text: null};
  if (log.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the message log ${tildeText(log.path)} could not be read: ${log.error}`,
    };
  }
  const user = log.lines.filter((line) => line.role === 'user').at(-1);
  return {
    at: user?.at ?? null,
    kind: 'read',
    text: user == null ? null : normalizedText(user.text),
  };
}

/**
 * F23: was a stored draft sent? Its text equals the newest sent message,
 * and, for a draft stored as a sent-match (it already equalled that message
 * when it was seen), the message was sent AFTER the draft was seen. A time
 * that does not parse proves no later send, so the sent-match is kept.
 */
function draftWasSent(
  draft: {at: string; sentMatch: boolean; text: string},
  sent: {at: string | null; text: string | null},
): boolean {
  if (sent.text == null || sent.text !== normalizedText(draft.text)) {
    return false;
  }
  if (!draft.sentMatch) return true;
  const sentMs = sent.at == null ? Number.NaN : Date.parse(sent.at);
  const seenMs = Date.parse(draft.at);
  return Number.isFinite(sentMs) && Number.isFinite(seenMs) && sentMs > seenMs;
}

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker),
  );
  return results;
}

/** The repo a session belongs to: the sessions index, else its recorded cwd's folder. */
function repoResolver(
  env: EnvLike,
  store: HookStore | null,
): (sessionId: string) => string | null {
  const index = readSessionIndex(env);
  const fromIndex = new Map<string, string>();
  if (index.kind === 'read') {
    for (const indexed of index.sessions) {
      const repo = indexed.sightings.find((s) => s.repo != null)?.repo;
      if (repo != null) fromIndex.set(indexed.sessionId, repo);
    }
  }
  return (sessionId) => {
    const known = fromIndex.get(sessionId);
    if (known != null) return known;
    const cwd = store?.sessions?.[sessionId]?.cwd ?? null;
    return cwd == null || cwd === '' ? null : basename(cwd);
  };
}

interface ClaudePane {
  draft: string;
  shownId: string | null;
  /** yukaf.36 D1: `draft` is Claude Code's suggestion (findInputBox). */
  suggested: boolean;
  surface: LiveSurface;
}

/** Read every pane, place the Claude ones, and update the store. */
export async function scanDrafts(deps: ScanDeps): Promise<ScanOutcome> {
  const surfaces = await readLiveSurfaces(deps.run);
  if (!surfaces.ok) {
    return {
      kind: 'unreachable',
      reason: paneFailureReason('cmux tree', surfaces.reason),
    };
  }
  const failures: string[] = [];
  const unreadable: ScanResult['unreadable'] = [];
  const toRead = surfaces.value.filter((surface) => surface.type !== 'browser');
  const reads = await mapLimited(
    toRead,
    SCREEN_CONCURRENCY,
    async (surface) => await readScreen(deps.run, surface.ref),
  );
  const screens = new Map<string, ScreenRead>();
  const panes: ClaudePane[] = [];
  for (const [index, surface] of toRead.entries()) {
    const read = reads[index];
    if (read == null) continue;
    screens.set(surface.ref, read);
    if (read.kind === 'unreadable') {
      unreadable.push({
        reason: paneFailureReason('cmux read-screen', read.reason),
        surfaceRef: surface.ref,
      });
      continue;
    }
    const lines = screenLines(read.text);
    const box = findInputBox(lines);
    if (box == null) continue;
    panes.push({
      draft: box.draft,
      shownId: screenSessionId(lines, box),
      suggested: box.suggested,
      surface,
    });
  }

  // The fallback placement: the liveness join (ps argv, the hook store),
  // only for panes whose status line shows no id. Read once, lazily.
  const store = readHookStore(deps.hookStorePath);
  const needsJoin = panes.some((pane) => pane.shownId == null);
  let joinFailure: string | null = null;
  const sessionsBySurface = new Map<string, string[]>();
  if (needsJoin) {
    const procs = await readProcesses(deps.ps);
    if (!store.ok || !procs.ok) {
      joinFailure = [
        store.ok ? null : paneFailureReason('hook store', store.reason),
        procs.ok ? null : paneFailureReason('ps', procs.reason),
      ]
        .filter((part): part is string => part != null)
        .join('; ');
      failures.push(
        `panes with no session id on screen could not be placed: ${joinFailure}`,
      );
    } else {
      // agents: null. Only the pane placement below is read from the join,
      // and a background worker is on no cmux pane.
      const joined = joinLiveSessions({
        agents: null,
        procs: procs.value,
        screens,
        store: store.value,
        surfaces: surfaces.value,
      });
      for (const [sessionId, live] of joined.bySessionId) {
        // A session placed by the screen join is the status line again;
        // only ps and the hook store place a pane the screen did not.
        if (live.surfaceId == null || live.source === 'screen') continue;
        const key = live.surfaceId.toUpperCase();
        sessionsBySurface.set(key, [
          ...(sessionsBySurface.get(key) ?? []),
          sessionId,
        ]);
      }
    }
  }

  const repoOf = repoResolver(deps.env, store.ok ? store.value : null);
  const unplaced: UnplacedDraftPane[] = [];
  const placed: (PanePlace & {draft: string; suggested: boolean})[] = [];
  for (const pane of panes) {
    const base = {
      draft: pane.draft,
      suggested: pane.suggested,
      surfaceId: pane.surface.id ?? null,
      surfaceRef: pane.surface.ref,
      workspaceId: pane.surface.workspaceId ?? null,
    };
    let sessionId = pane.shownId;
    let placedBy: PanePlace['placedBy'] = 'screen';
    if (sessionId == null) {
      const candidates =
        pane.surface.id == null
          ? []
          : (sessionsBySurface.get(pane.surface.id.toUpperCase()) ?? []);
      if (candidates.length === 1) {
        sessionId = candidates[0] ?? null;
        placedBy = 'process';
      } else {
        unplaced.push({
          ...base,
          why:
            joinFailure != null
              ? `no session id on screen, and ${joinFailure}`
              : candidates.length > 1
                ? `no session id on screen, and its tty names ${candidates.length} sessions (${candidates.join(', ')})`
                : 'no session id on screen, and no claude process on its tty names a session',
        });
        continue;
      }
    }
    if (sessionId == null) continue;
    placed.push({...base, placedBy, repo: repoOf(sessionId), sessionId});
  }

  // Two panes showing one session: neither is trusted with that session's draft.
  const panesPerSession = new Map<string, number>();
  for (const pane of placed) {
    panesPerSession.set(
      pane.sessionId,
      (panesPerSession.get(pane.sessionId) ?? 0) + 1,
    );
  }

  const found: FoundDraft[] = [];
  const cleared: ClearedDraft[] = [];
  const suggestions: SuggestionPane[] = [];
  const clearOne = (
    sessionId: string,
    draft: InputDraft,
    why: ClearedDraft['why'],
    surfaceRef: string | null,
    suggestion: string | null,
  ): void => {
    const result = clearInputDraft(sessionId, deps.env, deps.nowIso(), why);
    if (result.kind === 'failed') {
      failures.push(result.reason);
      return;
    }
    cleared.push({
      repo: repoOf(sessionId),
      sessionId,
      suggestion,
      surfaceRef,
      text: draft.text,
      why,
    });
  };
  const liveSurfaceIds = new Set(
    surfaces.value
      .map((surface) => surface.id?.toUpperCase() ?? null)
      .filter((id): id is string => id != null),
  );
  const emptyBoxClears = (stored: InputDraft, surfaceId: string | null) => {
    const storedOn = stored.surfaceId?.toUpperCase() ?? null;
    if (storedOn == null) return true;
    if (storedOn === surfaceId?.toUpperCase()) return true;
    return !liveSurfaceIds.has(storedOn);
  };
  const seen = new Set<string>();
  let emptyPlaced = 0;
  for (const pane of placed) {
    if ((panesPerSession.get(pane.sessionId) ?? 0) > 1) {
      unplaced.push({
        draft: pane.draft,
        suggested: pane.suggested,
        surfaceId: pane.surfaceId,
        surfaceRef: pane.surfaceRef,
        why: `another pane shows the same session (${pane.sessionId})`,
        workspaceId: pane.workspaceId,
      });
      continue;
    }
    seen.add(pane.sessionId);
    // yukaf.36 D2: a box showing only Claude Code's suggestion is an EMPTY
    // box for storing and clearing. Its text is listed, never stored.
    if (pane.suggested) {
      suggestions.push({
        placedBy: pane.placedBy,
        repo: pane.repo,
        sessionId: pane.sessionId,
        surfaceId: pane.surfaceId,
        surfaceRef: pane.surfaceRef,
        text: pane.draft,
        workspaceId: pane.workspaceId,
      });
    }
    const typed = pane.suggested ? '' : pane.draft;
    const stored = readInputDraft(pane.sessionId, deps.env);
    if (stored.kind === 'failed') {
      failures.push(stored.reason);
      if (typed !== '') {
        found.push({
          ...pane,
          failure: stored.reason,
          outcome: 'storeFailed',
          path: null,
          text: typed,
        });
      }
      continue;
    }
    const live =
      stored.kind === 'present' && stored.draft.clearedAt == null
        ? stored.draft
        : null;
    if (typed === '') {
      if (!pane.suggested) emptyPlaced += 1;
      // F18 (home-base-yukaf.14): only the pane the draft was typed in
      // clears it, or this pane when that one is gone (the pane is the
      // session's only one here: two panes of a session are unplaced above).
      // A reopened session's fresh, empty box beside the old pane must not
      // erase what the old pane still holds.
      if (live != null && emptyBoxClears(live, pane.surfaceId)) {
        clearOne(
          pane.sessionId,
          live,
          'emptyBox',
          pane.surfaceRef,
          pane.suggested ? pane.draft : null,
        );
      }
      continue;
    }
    const sent = newestSentText(pane.sessionId, deps.env);
    if (sent.kind === 'failed') failures.push(sent.reason);
    // F23 (home-base-yukaf.14): text equal to the newest SENT message
    // ("continue", "yes" typed again) used to be dropped as sent. A box that
    // still holds it has not sent it, so it is stored, marked sentMatch, and
    // shown with a note. A live draft of other text moves into `previous`.
    const sentMatch =
      sent.kind === 'read' && sent.text === normalizedText(typed);
    if (live?.text === typed && live.sentMatch === sentMatch) {
      found.push({
        ...pane,
        failure: null,
        outcome: 'unchanged',
        path: stored.kind === 'present' ? stored.path : null,
        text: typed,
      });
      continue;
    }
    const written = writeInputDraft(
      {
        at: deps.nowIso(),
        sentMatch,
        sessionId: pane.sessionId,
        source: 'scan',
        surfaceId: pane.surfaceId,
        text: typed,
        workspaceId: pane.workspaceId,
      },
      deps.env,
    );
    if (written.kind === 'failed') failures.push(written.reason);
    found.push({
      ...pane,
      failure: written.kind === 'failed' ? written.reason : null,
      outcome:
        written.kind !== 'written'
          ? 'storeFailed'
          : sentMatch
            ? 'storedSentMatch'
            : 'stored',
      path: written.kind === 'written' ? written.path : null,
      text: typed,
    });
  }

  // A live draft whose session no pane showed: sent from elsewhere?
  const listed: InputDraftList = listInputDrafts(deps.env);
  if (listed.kind === 'failed') {
    failures.push(listed.reason);
  } else {
    failures.push(...listed.failures);
    const missingSince = (sessionId: string, at: string | null): void => {
      const marked = setInputDraftMissing(sessionId, at, deps.env);
      if (marked.kind === 'failed') failures.push(marked.reason);
    };
    for (const entry of listed.drafts) {
      if (entry.draft.clearedAt != null) continue;
      // F2's two-scan rule resets whenever a pane shows the session again.
      if (seen.has(entry.sessionId)) {
        if (entry.draft.missingSince != null) {
          missingSince(entry.sessionId, null);
        }
        continue;
      }
      const sent = newestSentText(entry.sessionId, deps.env);
      if (sent.kind === 'failed') {
        failures.push(sent.reason);
        continue;
      }
      if (draftWasSent(entry.draft, sent)) {
        clearOne(entry.sessionId, entry.draft, 'sent', null, null);
        continue;
      }
      // F2 (home-base-yukaf.14): no pane shows the session AND the surface
      // it was typed in is not in the cmux tree. The first scan that sees
      // this records missingSince; the next one that still sees it clears
      // the draft (text kept). A draft with no recorded surface is never
      // cleared this way: nothing says its pane is gone.
      const on = entry.draft.surfaceId?.toUpperCase() ?? null;
      const paneGone = on != null && !liveSurfaceIds.has(on);
      if (!paneGone) {
        if (entry.draft.missingSince != null) {
          missingSince(entry.sessionId, null);
        }
        continue;
      }
      if (entry.draft.missingSince == null) {
        missingSince(entry.sessionId, deps.nowIso());
      } else {
        clearOne(entry.sessionId, entry.draft, 'missing', null, null);
      }
    }
  }

  return {
    claudePanes: panes.length,
    cleared,
    emptyPlaced,
    failures,
    found,
    kind: 'scanned',
    suggestions,
    surfacesRead: toRead.length,
    unplaced,
    unreadable,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const OUTCOME_WORDS: Record<FoundOutcome, string> = {
  storeFailed: 'NOT STORED',
  stored: 'stored',
  storedSentMatch: 'stored (the same text as your newest sent message)',
  unchanged: 'already stored, unchanged',
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Text verbatim, one step in from the fields, never wrapped. */
function verbatim(text: string): string {
  return text
    .split('\n')
    .map((line) => `${pad(DETAIL_COLUMN + 2)}${line}`)
    .join('\n');
}

function firstLine(text: string): string {
  const [first = ''] = text.split('\n');
  return text.includes('\n') ? `${first} …` : first;
}

function block(
  title: string,
  emoji: string,
  entries: readonly string[],
  style: OutputStyle,
): string {
  if (entries.length === 0) return '';
  return spacedList([
    sectionHeader(`${title} (${entries.length})`, {color: style.color, emoji}),
    ...entries,
  ]);
}

function fields(
  entries: readonly ({label: string; value: string} | null)[],
  style: OutputStyle,
): string {
  return fieldLines(
    entries.filter(
      (entry): entry is {label: string; value: string} => entry != null,
    ),
    {color: style.color, indent: BODY_COLUMN, width: style.width},
  );
}

export function renderScan(result: ScanResult, style: OutputStyle): string {
  const code = (text: string): string => paint(text, ['cyan'], style.color);
  const found = result.found.map((entry) => {
    const outcome =
      entry.outcome === 'storeFailed'
        ? paint(
            `${OUTCOME_WORDS.storeFailed}: ${entry.failure ?? 'unknown'}`,
            ['bold', 'red'],
            style.color,
          )
        : `${OUTCOME_WORDS[entry.outcome]}${entry.path == null ? '' : ` (${tildeText(entry.path)})`}`;
    return [
      fields(
        [
          {label: 'Session', value: entry.sessionId},
          {label: 'Repo', value: entry.repo ?? 'unknown'},
          {
            label: 'Pane',
            value:
              entry.workspaceId == null
                ? entry.surfaceRef
                : `${code(selectWorkspaceCommand(entry.workspaceId))} (${entry.surfaceRef})`,
          },
          {
            label: 'Placed by',
            value:
              entry.placedBy === 'screen'
                ? 'the session id its status line shows'
                : 'the claude process on its tty',
          },
          {label: 'Store', value: outcome},
          {label: 'Text', value: ''},
        ],
        style,
      ),
      verbatim(entry.text),
    ].join('\n');
  });
  const cleared = result.cleared.map((entry) =>
    fields(
      [
        {label: 'Session', value: entry.sessionId},
        {label: 'Repo', value: entry.repo ?? 'unknown'},
        {
          label: 'Why',
          value:
            entry.why === 'emptyBox'
              ? entry.suggestion == null
                ? `its input box is empty now (${entry.surfaceRef ?? 'pane unknown'})`
                : `its input box shows only Claude Code's suggestion now, "${firstLine(entry.suggestion)}", which is not your typing (${entry.surfaceRef ?? 'pane unknown'})`
              : entry.why === 'missing'
                ? 'its pane was gone in two scans in a row (the text is kept in the file)'
                : 'the text equals the newest message you sent in that session',
        },
        {label: 'Text', value: firstLine(entry.text)},
      ],
      style,
    ),
  );
  // yukaf.36 D2: listed so a suggestion never disappears silently.
  const suggestions = result.suggestions.map((entry) =>
    [
      fields(
        [
          {label: 'Session', value: entry.sessionId},
          {label: 'Repo', value: entry.repo ?? 'unknown'},
          {
            label: 'Pane',
            value:
              entry.workspaceId == null
                ? entry.surfaceRef
                : `${code(selectWorkspaceCommand(entry.workspaceId))} (${entry.surfaceRef})`,
          },
          {label: 'Store', value: 'nothing stored: the box counts as empty'},
          {label: 'Why', value: SUGGESTION_EVIDENCE},
          {label: 'Text', value: ''},
        ],
        style,
      ),
      verbatim(entry.text),
    ].join('\n'),
  );
  const unplaced = result.unplaced.map((entry) => {
    const head = fields(
      [
        {label: 'Pane', value: entry.surfaceRef},
        entry.workspaceId == null
          ? null
          : {
              label: 'Open it',
              value: code(selectWorkspaceCommand(entry.workspaceId)),
            },
        {label: 'Why', value: entry.why},
        {
          label: 'Text',
          value:
            entry.draft === ''
              ? '(the box is empty)'
              : entry.suggested
                ? `Claude Code's suggestion, not your typing (${SUGGESTION_EVIDENCE}):`
                : '',
        },
      ],
      style,
    );
    return entry.draft === '' ? head : `${head}\n${verbatim(entry.draft)}`;
  });
  const unreadable = result.unreadable.map((entry) =>
    fields(
      [
        {label: 'Pane', value: entry.surfaceRef},
        {label: 'Why', value: entry.reason},
      ],
      style,
    ),
  );
  const failures = result.failures.map((failure) =>
    wrapHanging(`- ${tildeText(failure)}`, {
      hang: BODY_COLUMN + 2,
      indent: BODY_COLUMN,
      width: style.width,
    }),
  );
  const newDrafts = result.found.filter(
    (entry) =>
      entry.outcome === 'stored' || entry.outcome === 'storedSentMatch',
  ).length;
  const unchanged = result.found.filter(
    (entry) => entry.outcome === 'unchanged',
  ).length;
  const live = result.found.length;
  const summary = [
    `Read ${plural(result.surfacesRead, 'pane', 'panes')}: ${plural(result.claudePanes, 'Claude input box', 'Claude input boxes')}, ${result.claudePanes - result.unplaced.length} placed in a session.`,
    `${plural(live, 'draft', 'drafts')} found (${newDrafts} newly stored, ${unchanged} unchanged), ${result.emptyPlaced} empty, ${result.suggestions.length} showing Claude's suggestion, ${result.cleared.length} cleared, ${result.unplaced.length} unplaced, ${plural(result.unreadable.length, 'screen', 'screens')} unreadable${result.failures.length > 0 ? `, ${plural(result.failures.length, 'failure', 'failures')}` : ''}.`,
  ].join('\n');
  return spacedList([
    sectionHeader('thread drafts scan', {color: style.color, emoji: '✍️'}),
    block('Drafts found', '✍️', found, style),
    block("Claude's suggestion, not your typing", '💡', suggestions, style),
    block('Cleared', '🧹', cleared, style),
    block('Unplaced panes', '🪟', unplaced, style),
    block('Screens that could not be read', '⚠️', unreadable, style),
    block('Failures', '🛑', failures, style),
    wrapHanging(paint(summary, ['bold'], style.color), {
      hang: HEADER_COLUMN,
      indent: HEADER_COLUMN,
      width: style.width,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

export interface DraftsScanOptions {
  /** Injected sources for tests; the real ones otherwise. */
  deps?: Partial<Omit<ScanDeps, 'env'>>;
  env?: EnvLike;
  json: boolean;
  style?: OutputStyle;
}

/** 0 scanned (drafts or none) · 1 scanned, but something failed · 2 cmux unreachable, nothing written. */
export async function runThreadDraftsScan(
  options: DraftsScanOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const style = options.style ?? outputStyle(process.stdout);
  const unreachable = async (reason: string): Promise<number> => {
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({kind: 'unreachable', reason}, null, 2)}\n`,
      );
    } else {
      console.error(`thread drafts scan: ${reason}`);
    }
    return 2;
  };
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return await unreachable(
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}. Nothing was written.`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const home = env.HOME;
  const deps: ScanDeps = {
    env,
    hookStorePath:
      options.deps?.hookStorePath ??
      defaultHookStorePath(home != null && home !== '' ? home : homedir()),
    nowIso: options.deps?.nowIso ?? (() => new Date().toISOString()),
    ps: options.deps?.ps ?? realProcessRunner(),
    run: options.deps?.run ?? realCmuxRunner(undefined, cmuxEnv),
  };
  // F3 (home-base-yukaf.14): every unreachable text names the socket and
  // where it came from, so a failing hourly chore says which socket the
  // launchd-started process could not reach (launchd sets no
  // CMUX_SOCKET_PATH; the scan then reads cmux's last-socket-path file).
  const from =
    (env.CMUX_SOCKET_PATH ?? '') === ''
      ? '~/.local/state/cmux/last-socket-path'
      : 'CMUX_SOCKET_PATH';
  const where = `the socket ${socket.path} (from ${from})`;
  const ping = await deps.run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    return await unreachable(
      `cmux cannot be reached at ${where}: ${ping.reason}. Nothing was written. If this session is sandboxed, the sandbox blocks the cmux socket and ps: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`,
    );
  }
  const result = await scanDrafts(deps);
  if (result.kind === 'unreachable') {
    return await unreachable(
      `${result.reason}, at ${where}. Nothing was written.`,
    );
  }
  if (options.json) {
    await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    await writeStdout(`${renderScan(result, style)}\n`);
  }
  return result.failures.length > 0 ? 1 : 0;
}

export interface DraftsDismissOptions {
  env?: EnvLike;
  json: boolean;
  /** Defaults to now. */
  nowIso?: () => string;
  sessionIds: readonly string[];
}

/** One session's outcome under `thread drafts dismiss`. */
export type DismissOutcome =
  | {kind: 'absent'; sessionId: string}
  | {kind: 'alreadyCleared'; sessionId: string}
  | {kind: 'dismissed'; sessionId: string; text: string}
  | {kind: 'failed'; reason: string; sessionId: string};

/**
 * F2 (home-base-yukaf.12, home-base-yukaf.14): `thread drafts dismiss <sid…>`
 * clears the stored text Justin no longer wants (clearedBy 'dismissed'; the
 * text stays in the file), so it leaves the ✍️ section. The TUI's `x` runs
 * this. Exit 0 every id dismissed or already clear · 1 any id failed or has
 * no stored draft · 2 no id given.
 */
export function dismissDrafts(options: DraftsDismissOptions): {
  exitCode: 0 | 1 | 2;
  outcomes: DismissOutcome[];
} {
  if (options.sessionIds.length === 0) return {exitCode: 2, outcomes: []};
  const env = options.env ?? process.env;
  const now = options.nowIso ?? (() => new Date().toISOString());
  const outcomes = options.sessionIds.map((sessionId): DismissOutcome => {
    const before = readInputDraft(sessionId, env);
    if (before.kind === 'failed') {
      return {kind: 'failed', reason: before.reason, sessionId};
    }
    if (before.kind === 'absent') return {kind: 'absent', sessionId};
    if (before.draft.clearedAt != null) {
      return {kind: 'alreadyCleared', sessionId};
    }
    const cleared = clearInputDraft(sessionId, env, now(), 'dismissed');
    if (cleared.kind === 'failed') {
      return {kind: 'failed', reason: cleared.reason, sessionId};
    }
    if (cleared.kind === 'absent') return {kind: 'absent', sessionId};
    return {kind: 'dismissed', sessionId, text: before.draft.text};
  });
  const bad = outcomes.some(
    (outcome) => outcome.kind === 'failed' || outcome.kind === 'absent',
  );
  return {exitCode: bad ? 1 : 0, outcomes};
}

export function runThreadDraftsDismiss(options: DraftsDismissOptions): number {
  const {exitCode, outcomes} = dismissDrafts(options);
  if (options.json) {
    console.log(JSON.stringify({exitCode, outcomes}, null, 2));
    return exitCode;
  }
  if (exitCode === 2) {
    console.error(
      'thread drafts dismiss: name the session ids whose stored text to clear',
    );
    return exitCode;
  }
  for (const outcome of outcomes) {
    const line =
      outcome.kind === 'dismissed'
        ? `dismissed ${outcome.sessionId}: "${firstLine(outcome.text)}" (kept in the file, no longer listed)`
        : outcome.kind === 'alreadyCleared'
          ? `${outcome.sessionId}: already cleared`
          : outcome.kind === 'absent'
            ? `${outcome.sessionId}: NOT dismissed: no stored draft for this session`
            : `${outcome.sessionId}: NOT dismissed: ${outcome.reason}`;
    (exitCode === 0 ? console.log : console.error)(line);
  }
  return exitCode;
}

export interface DraftsListOptions {
  env?: EnvLike;
  json: boolean;
  style?: OutputStyle;
}

/** `thread drafts`: the stored drafts that are still live, newest first. 1 = the store could not be read. */
export async function runThreadDraftsList(
  options: DraftsListOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const style = options.style ?? outputStyle(process.stdout);
  const listed = listInputDrafts(env);
  if (listed.kind === 'failed') {
    if (options.json) {
      await writeStdout(`${JSON.stringify(listed, null, 2)}\n`);
    } else {
      console.error(`thread drafts: ${listed.reason}`);
    }
    return 1;
  }
  const live = listed.drafts.filter((entry) => entry.draft.clearedAt == null);
  if (options.json) {
    await writeStdout(
      `${JSON.stringify({drafts: live, failures: listed.failures, kind: 'read'}, null, 2)}\n`,
    );
    return listed.failures.length > 0 ? 1 : 0;
  }
  const repoOf = repoResolver(env, null);
  const code = (text: string): string => paint(text, ['cyan'], style.color);
  const entries = live.map((entry) =>
    [
      fields(
        [
          {label: 'Session', value: entry.sessionId},
          {label: 'Repo', value: repoOf(entry.sessionId) ?? 'unknown'},
          {
            label: 'Seen',
            value: `${entry.draft.at} (by ${entry.draft.source})`,
          },
          {
            label: 'Pane',
            value:
              entry.draft.workspaceId == null
                ? 'unknown'
                : code(selectWorkspaceCommand(entry.draft.workspaceId)),
          },
          {label: 'Resume', value: code(`claude --resume ${entry.sessionId}`)},
          {label: 'Text', value: ''},
        ],
        style,
      ),
      verbatim(entry.draft.text),
    ].join('\n'),
  );
  const cleared = listed.drafts.length - live.length;
  await writeStdout(
    `${spacedList([
      sectionHeader('Unsent text in input boxes', {
        color: style.color,
        emoji: '✍️',
      }),
      ...(entries.length === 0
        ? [`${pad(BODY_COLUMN)}None stored and still unsent.`]
        : entries),
      ...listed.failures.map(
        (failure) => `${pad(BODY_COLUMN)}⚠️ ${tildeText(failure)}`,
      ),
      `${pad(HEADER_COLUMN)}${plural(live.length, 'draft', 'drafts')} unsent, ${cleared} cleared (sent, or the box was seen empty). \`thread drafts scan\` refreshes the store from every open pane.`,
    ])}\n`,
  );
  return listed.failures.length > 0 ? 1 : 0;
}
