/**
 * Name each session's cmux workspace after its session title, keeping any
 * name Justin set himself in parentheses (home-base-j8q3e.5; this module is
 * dispatch .1). The parent bead's design field is the contract; D-numbers
 * below refer to it.
 *
 * - D1: the tool's part is sessionDisplayName(repoTag, title), "[TAG] <title>"
 *   (the repo's projectTag, else its folder uppercased: home-base-bomy5.7.1).
 * - D2: workspace-names.jsonl records every name the tool set, written BEFORE
 *   the rename. A workspace name equal to ANY nameSet recorded for it is the
 *   tool's (F1). decideWorkspaceName is the whole ownership rule.
 * - D3: a session still carrying `auto-title` names nothing.
 * - D4: syncWorkspaceName is idempotent; the workspace is the one holding the
 *   bead's surface now, else the bead's cmux-ws label, never $CMUX_WORKSPACE_ID.
 * - D5: anything unreadable sets nothing, with a reason.
 * - D6: the caller passes the knob; off returns before any cmux call or
 *   record read.
 */

import type {CmuxRunner, CmuxTree, CmuxTreeRead} from './cmux';
import type {EnvLike} from './paths';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';

import {workspaceNamesPath} from './archive';
import {
  clearWorkspaceName,
  readCmuxTree,
  readWorkspaceTitle,
  realCmuxRunner,
  renameWorkspace,
  surfacesOfWorkspace,
  workspaceExists,
  workspaceOfSurface,
} from './cmux';
import {
  AUTO_TITLE_LABEL,
  CMUX_SURFACE_LABEL_PREFIX,
  CMUX_WORKSPACE_LABEL_PREFIX,
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  labelValue,
} from './session-bead';
import {sessionDisplayName} from './session-name';

/**
 * The leading glyphs cmux shows on a pane title while Claude Code owns the
 * terminal: ✳ when idle, the others are its spinner frames. A workspace
 * title that starts with one was copied from a pane, so no human typed it (D2
 * rule 3). home-base-ys9t7.9.1 B1: rule 3 knew only ✳, so a workspace caught
 * mid-spin ("◐ Shortcuts helper app survey") was read as Justin's name. The
 * set is the one home-base's scripts/cmux-restart.ts used to keep for itself.
 */
export const CLAUDE_PANE_GLYPHS = [
  '✳',
  '✻',
  '✽',
  '✶',
  '◐',
  '◑',
  '◒',
  '◓',
  '●',
  '○',
  '◔',
  '◕',
] as const;

const CLAUDE_PANE_TITLE = new RegExp(`^[${CLAUDE_PANE_GLYPHS.join('')}]`, 'u');

/** Whether a name starts with a Claude Code pane glyph (D2 rule 3). */
export function isGeneratedName(name: string): boolean {
  return CLAUDE_PANE_TITLE.test(name);
}

/**
 * home-base-ys9t7.9.1 B2: a recorded hisName that starts with a pane glyph was
 * misread as Justin's by the old rule 3 (B1). It is demoted to replacedName,
 * so it stops riding along in parentheses and `--restore` still puts it back
 * when nothing better was recorded.
 */
function demoteGenerated(record: {
  hisName: string | null;
  replacedName: string | null;
}): {hisName: string | null; replacedName: string | null} {
  if (record.hisName == null || !isGeneratedName(record.hisName)) {
    return {hisName: record.hisName, replacedName: record.replacedName};
  }
  return {hisName: null, replacedName: record.replacedName ?? record.hisName};
}

const READBACK_RETRIES = 10;
const READBACK_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// The record (D2)
// ---------------------------------------------------------------------------

const recordSchema = z.object({
  at: z.string(),
  /**
   * The session bead that set the name. null (written as "" so an older SDK
   * still parses the line) when the SDK named a workspace before any session
   * bead existed: `thread spawn`, or an untracked session (B3).
   */
  beadId: z.string().transform((id) => (id === '' ? null : id)),
  hisName: z.string().nullable(),
  nameSet: z.string(),
  replacedName: z.string().nullable(),
  repo: z.string().nullable(),
  sessionId: z.string().nullable(),
  /**
   * home-base-ys9t7.9.1 B3: what set the name when it was not this sync:
   * `new-workspace --name` in thread spawn / thread open / the dashboard / the
   * threads TUI, or cmux-restart's respawn. null on a sync's own line and on
   * every line written before (absent: undefined). A plain string, not an
   * enum, so a later value never makes an older SDK reject the whole file.
   */
  setBy: z.string().nullish(),
  /**
   * The surface of the session that wrote the line, at sync time; null when
   * it had no cmux-surface label. Lines written before home-base-bomy5.4.1
   * lack it, parse as null, and make no sticky claim.
   */
  surfaceId: z.string().nullable().default(null),
  toolPart: z.string(),
  workspaceId: z.string(),
});

export type WorkspaceNameRecord = z.infer<typeof recordSchema>;

/**
 * `missing` is a first run (no names set yet). `failed` covers an unreadable
 * file AND any unparseable line: a corrupt line might be the one holding his
 * name, so every caller must set nothing (D5).
 */
export type WorkspaceNamesRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'}
  | {kind: 'read'; records: WorkspaceNameRecord[]};

export function readWorkspaceNames(env: EnvLike): WorkspaceNamesRead {
  const path = workspaceNamesPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'missing'};
    }
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  const records: WorkspaceNameRecord[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      json = undefined;
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `${path} line ${index + 1} is not a workspace-name record, so no name is set until it is repaired`,
      };
    }
    records.push(parsed.data);
  }
  return {kind: 'read', records};
}

export function appendWorkspaceName(
  record: WorkspaceNameRecord,
  env: EnvLike,
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  const path = workspaceNamesPath(env);
  // B3: a null beadId goes to disk as "", which every SDK version parses.
  const line = {...record, beadId: record.beadId ?? ''};
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return {kind: 'ok'};
  } catch (error) {
    return {error: `${path}: ${String(error)}`, kind: 'failed'};
  }
}

/** Every record line for one workspace, in file order (oldest first). */
export function recordsFor(
  records: readonly WorkspaceNameRecord[],
  workspaceId: string,
): WorkspaceNameRecord[] {
  const want = workspaceId.toUpperCase();
  return records.filter((record) => record.workspaceId.toUpperCase() === want);
}

/**
 * R in D2: the NEWEST of a workspace's records whose nameSet equals `name`,
 * or null. Not simply the latest line (home-base-j8q3e.5.3 F1): two sessions
 * in one workspace can sync at once, so their record lines and their renames
 * can land in opposite orders, and the latest line may not be the name cmux
 * shows. Matching any line keeps the tool from reading its own name as his.
 */
export function newestRecordNamed(
  records: readonly WorkspaceNameRecord[],
  name: string | null,
): WorkspaceNameRecord | null {
  if (name == null) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.nameSet === name) return record;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision (D2)
// ---------------------------------------------------------------------------

/**
 * Which D2 rule decided: `empty` (1), `tools` (2), `generated` (3, "✳"),
 * `his` (4), `matchesToolPart` (the "C equals T" ownership line), `sticky`
 * (another session named it and is still open in the workspace,
 * home-base-bomy5.4.1, which replaced D3's "the last session to sync names it").
 */
export type WorkspaceNameRule =
  | 'empty'
  | 'generated'
  | 'handedOff'
  | 'his'
  | 'matchesToolPart'
  | 'sticky'
  | 'tools';

export type WorkspaceNameDecision =
  /**
   * The name equals this session's tool part and no line of its own claims
   * it: none at all, or (B3) only a line the SDK wrote when it opened the
   * workspace, which makes no sticky claim. hisName and replacedName are
   * carried from that line so `--restore` keeps working.
   */
  | {
      hisName?: string | null;
      kind: 'record';
      name: string;
      replacedName?: string | null;
      rule: 'matchesToolPart';
    }
  /**
   * home-base-mbnjv.12 (D8): the name is already right, but the session that
   * set it handed off to this one, so this one records it as its own (its
   * surface becomes the sticky claim). hisName and replacedName are carried
   * from the predecessor's line: `--restore` and every later rename read them
   * from the newest line, so dropping them would lose Justin's own name.
   */
  | {
      fromBeadId: string;
      hisName: string | null;
      kind: 'record';
      name: string;
      replacedName: string | null;
      rule: 'handedOff';
    }
  | {
      hisName: string | null;
      kind: 'rename';
      replacedName: string | null;
      rule: Exclude<WorkspaceNameRule, 'sticky'>;
      target: string;
    }
  | {
      kind: 'unchanged';
      name: string;
      rule: Exclude<WorkspaceNameRule, 'sticky'>;
    }
  /** The name is `ownerBeadId`'s, whose surface is still in this workspace. */
  | {kind: 'unchanged'; name: string; ownerBeadId: string; rule: 'sticky'};

export const RULE_WORDS: Record<WorkspaceNameRule, string> = {
  empty: 'the workspace has no name (rule 1)',
  generated:
    'the name starts with a Claude Code pane glyph (✳, ◐ and the like), so a tool generated it, not Justin (rule 3)',
  handedOff:
    'the session that set the name handed off to this one, which now owns it (D8)',
  his: 'the name is not one the tool set, so it is Justin’s and is kept in parentheses (rule 4)',
  matchesToolPart: 'the name already equals the tool’s name (rule 0)',
  sticky:
    'another session named it and is still open in this workspace (sticky)',
  tools: 'the name is one the tool set (rule 2)',
};

/** The sticky rule's words, naming the session that keeps the name. */
export function stickyWords(ownerBeadId: string): string {
  return `named by session ${ownerBeadId}, still open in this workspace (sticky)`;
}

/** The words for an unchanged decision or outcome, sticky ones with the owner. */
export function unchangedWords(
  decided:
    | {ownerBeadId: string; rule: 'sticky'}
    | {rule: Exclude<WorkspaceNameRule, 'sticky'>},
): string {
  return decided.rule === 'sticky'
    ? stickyWords(decided.ownerBeadId)
    : RULE_WORDS[decided.rule];
}

/**
 * This session, for the sticky check: its bead id, and every surface in the
 * workspace being named, from the cmux tree already read for the sync.
 */
export interface StickyContext {
  beadId: string;
  /**
   * home-base-mbnjv.3 (D8, C7): the session that handed off to this one, when
   * BOTH halves of the link are confirmed (this bead has `continues:<it>`, its
   * bead has `continued-by:<this>`). Its sticky claim yields to this session,
   * so the workspace name follows the live end of the chain. Absent or null:
   * no transfer.
   */
  handedOffFrom?: string | null;
  /**
   * This session's own surface (its cmux-surface label), null outside cmux.
   * B3: only a session with a surface claims a name the SDK set at open time,
   * so a session with none never appends a line on every sync.
   */
  surfaceId?: string | null;
  surfaceIdsHere: readonly string[];
}

/**
 * The bead id of the session that wrote `matched`, when its surface is in
 * `surfaceIdsHere`; null when there is no line, the line has no surfaceId,
 * or that surface has left. The preview uses it to find the owner.
 */
export function liveNamer(
  matched: WorkspaceNameRecord | null,
  surfaceIdsHere: readonly string[],
): string | null {
  if (matched?.surfaceId == null) return null;
  const want = matched.surfaceId.toUpperCase();
  return surfaceIdsHere.some((id) => id.toUpperCase() === want)
    ? matched.beadId
    : null;
}

/**
 * home-base-bomy5.4.1: R (the record line whose nameSet is the name now) was
 * written by a DIFFERENT session whose surface is still in this workspace, so
 * the name is that session's. A line with no surfaceId makes no claim; a
 * surface that left the workspace releases it (rule 2 takes over).
 */
export function stickyOwner(
  matched: WorkspaceNameRecord | null,
  self: StickyContext,
): string | null {
  const owner = liveNamer(matched, self.surfaceIdsHere);
  if (owner == null || owner === self.beadId) return null;
  // home-base-mbnjv.3 (C7): the owner yields the name to its own successor.
  if (self.handedOffFrom != null && owner === self.handedOffFrom) return null;
  return owner;
}

/** What syncWorkspaceName reads to confirm a handoff: one bead's labels. */
export type OwnerLabelsRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; labels: readonly string[]};

/** What confirmedPredecessor found out about one possible handoff. */
export type PredecessorCheck =
  /** Both halves of the link are there: the owner handed off to self. */
  | {beadId: string; kind: 'confirmed'}
  /** Self does not continue the owner, or the owner lacks continued-by:self. */
  | {kind: 'notLinked'}
  /**
   * home-base-mbnjv.8 F4 (critical rule 7): self continues the owner, but the
   * owner's labels could not be read, so the link is neither confirmed nor
   * ruled out. Never folded into notLinked.
   */
  | {kind: 'ownerUnread'; reason: string};

/**
 * home-base-mbnjv.3 (C7): `ownerBeadId` handed off to `self` when self's
 * labels carry `continues:<owner>` AND the owner's carry
 * `continued-by:<self>`. A half-written link never moves a name; an owner
 * bead that cannot be read does not either (the name stays where it is), and
 * says so (ownerUnread).
 */
export function confirmedPredecessor(input: {
  ownerBeadId: string;
  ownerLabels: (beadId: string) => OwnerLabelsRead;
  selfBeadId: string;
  selfLabels: readonly string[];
}): PredecessorCheck {
  const {ownerBeadId, selfBeadId} = input;
  if (!input.selfLabels.includes(`${CONTINUES_LABEL_PREFIX}${ownerBeadId}`)) {
    return {kind: 'notLinked'};
  }
  const read = input.ownerLabels(ownerBeadId);
  if (read.kind !== 'found') return {kind: 'ownerUnread', reason: read.reason};
  return read.labels.includes(`${CONTINUED_BY_LABEL_PREFIX}${selfBeadId}`)
    ? {beadId: ownerBeadId, kind: 'confirmed'}
    : {kind: 'notLinked'};
}

/** cmux trims trailing whitespace, so what is sent must already be trimmed. */
function stored(name: string): string {
  return name.trimEnd();
}

/**
 * The whole ownership rule. C = `current` (custom_title, null for none),
 * T = `toolPart`, `records` = this workspace's record lines (recordsFor), and
 * R = the newest of them whose nameSet equals C (newestRecordNamed, F1).
 * `self` turns on the sticky check (home-base-bomy5.4.1) between R and rule
 * 2; the sync and the preview always pass it, and only tests of the other
 * rules leave it out.
 */
export function decideWorkspaceName(input: {
  current: string | null;
  records: readonly WorkspaceNameRecord[];
  self?: StickyContext;
  toolPart: string;
}): WorkspaceNameDecision {
  const {current, records} = input;
  const toolPart = stored(input.toolPart);
  const latest = newestRecordNamed(records, current);
  // home-base-mbnjv.12 (D8): the confirmed predecessor set the name now
  // shown, so a name that is already right is still taken over by a record
  // line of this session's own. Without it the predecessor's line stays the
  // claim: its later rename would take the workspace back from the live end
  // of the chain, and a successor whose title equals its predecessor's (the
  // usual case: it is titled after it on --continues) would never own it.
  const takeOver = (): WorkspaceNameDecision | null =>
    latest != null &&
    current != null &&
    input.self?.handedOffFrom != null &&
    latest.beadId === input.self.handedOffFrom
      ? {
          fromBeadId: input.self.handedOffFrom,
          ...demoteGenerated(latest),
          kind: 'record',
          name: current,
          rule: 'handedOff',
        }
      : null;
  // Rule 0 (F2): C equal to T is always the tool's, whatever else the record
  // holds; otherwise rule 4 would read it as his and nest it, "T (T)".
  if (current === toolPart) {
    if (latest == null) {
      return {kind: 'record', name: current, rule: 'matchesToolPart'};
    }
    const handedOff = takeOver();
    if (handedOff != null) return handedOff;
    // B3 (home-base-ys9t7.9.1): the SDK named the workspace this session's
    // name when it opened it (thread open, the dashboard), on a line with no
    // surface. That line makes no sticky claim, so this session records its
    // own; otherwise a second session in the workspace could take the name.
    if (
      latest.setBy != null &&
      latest.surfaceId == null &&
      input.self?.surfaceId != null
    ) {
      return {
        ...demoteGenerated(latest),
        kind: 'record',
        name: current,
        rule: 'matchesToolPart',
      };
    }
    return {kind: 'unchanged', name: current, rule: 'matchesToolPart'};
  }
  // Sticky (home-base-bomy5.4.1): another session still open here named it,
  // so this one writes nothing. Its pane leaving releases it to rule 2.
  const owner = input.self != null ? stickyOwner(latest, input.self) : null;
  if (latest != null && owner != null) {
    return {
      kind: 'unchanged',
      name: latest.nameSet,
      ownerBeadId: owner,
      rule: 'sticky',
    };
  }
  let decided: Extract<WorkspaceNameDecision, {kind: 'rename'}>;
  if (current == null) {
    decided = {
      hisName: null,
      kind: 'rename',
      replacedName: null,
      rule: 'empty',
      target: toolPart,
    };
  } else if (latest != null) {
    const kept = demoteGenerated(latest);
    decided = {
      ...kept,
      kind: 'rename',
      rule: 'tools',
      target: kept.hisName != null ? `${toolPart} (${kept.hisName})` : toolPart,
    };
  } else if (isGeneratedName(current)) {
    decided = {
      hisName: null,
      kind: 'rename',
      replacedName: current,
      rule: 'generated',
      target: toolPart,
    };
  } else {
    decided = {
      hisName: current,
      kind: 'rename',
      replacedName: null,
      rule: 'his',
      target: `${toolPart} (${current})`,
    };
  }
  const target = stored(decided.target);
  if (current === target) {
    return takeOver() ?? {kind: 'unchanged', name: current, rule: decided.rule};
  }
  return {...decided, target};
}

// ---------------------------------------------------------------------------
// The sync (D3, D4, D5)
// ---------------------------------------------------------------------------

export interface WorkspaceSession {
  beadId: string;
  labels: readonly string[];
  repo: string | null;
  /** Resolved from the session's own checkout (home-base-bomy5.7.1). */
  repoTag: string | null;
  sessionId: string | null;
  title: string;
}

export type WorkspaceSyncOutcome =
  /** The knob is off: no cmux call, no record read (D6). */
  | {kind: 'off'}
  /** The session has no real title yet (D3). */
  | {kind: 'notReady'; reason: string}
  /** No surface or workspace label: a session outside cmux says nothing. */
  | {kind: 'outsideCmux'}
  /** Something could not be read or written; nothing was set (D5). */
  | {kind: 'failed'; reason: string; workspaceId: string | null}
  | {
      kind: 'unchanged';
      name: string;
      rule: Exclude<WorkspaceNameRule, 'sticky'>;
      workspaceId: string;
    }
  /** Another session still open here named it (home-base-bomy5.4.1). */
  | {
      kind: 'unchanged';
      name: string;
      ownerBeadId: string;
      rule: 'sticky';
      workspaceId: string;
    }
  | {
      /** home-base-mbnjv.12: the predecessor the name was taken over from. */
      fromBeadId: string | null;
      kind: 'recorded';
      name: string;
      workspaceId: string;
    }
  | {
      from: string | null;
      kind: 'wouldRename';
      rule: WorkspaceNameRule;
      to: string;
      workspaceId: string;
    }
  | {
      from: string | null;
      kind: 'renamed';
      /** What cmux reports after the rename; a mismatch is loud, not undone. */
      readback:
        | {kind: 'failed'; reason: string}
        | {kind: 'read'; name: string | null};
      rule: WorkspaceNameRule;
      to: string;
      workspaceId: string;
    };

export interface WorkspaceSyncInput {
  dryRun?: boolean;
  /** componentConfig.thread.nameWorkspaces; a dry run passes true. */
  enabled: boolean;
  env: EnvLike;
  now?: Date;
  /**
   * home-base-mbnjv.3 (C7): reads a sticky owner's labels to confirm it
   * handed off to this session. Absent: the name never transfers.
   */
  readLabels?: (beadId: string) => OwnerLabelsRead;
  run: CmuxRunner;
  session: WorkspaceSession;
  /** `--workspace <uuid>`: skip resolution. Never defaults to the caller. */
  workspaceId?: string | null;
}

/**
 * D4: the workspace holding the session's surface now, else its cmux-ws label
 * when that workspace is still open. Shared with the preview (j8q3e.5.2), so
 * the preview names the same workspace a sync would.
 */
export function resolveWorkspace(
  tree: CmuxTree,
  labels: readonly string[],
):
  | {kind: 'none'}
  | {kind: 'unresolved'; reason: string}
  | {kind: 'workspace'; workspaceId: string} {
  const surface = labelValue(labels, CMUX_SURFACE_LABEL_PREFIX);
  const workspace = labelValue(labels, CMUX_WORKSPACE_LABEL_PREFIX);
  if (surface == null && workspace == null) return {kind: 'none'};
  if (surface != null) {
    const holding = workspaceOfSurface(tree, surface);
    if (holding != null) return {kind: 'workspace', workspaceId: holding};
  }
  if (workspace != null && workspaceExists(tree, workspace)) {
    return {kind: 'workspace', workspaceId: workspace};
  }
  return {
    kind: 'unresolved',
    reason: `neither the session's surface (${surface ?? 'no label'}) nor its workspace (${workspace ?? 'no label'}) is open in cmux`,
  };
}

export async function syncWorkspaceName(
  input: WorkspaceSyncInput,
): Promise<WorkspaceSyncOutcome> {
  const {env, run, session} = input;
  if (!input.enabled) return {kind: 'off'};
  if (session.labels.includes(AUTO_TITLE_LABEL)) {
    return {
      kind: 'notReady',
      reason: `the session ${session.beadId} still carries ${AUTO_TITLE_LABEL}: its title is the first message until a request is filed or \`thread title\` runs`,
    };
  }
  const override = input.workspaceId ?? null;
  if (
    override == null &&
    labelValue(session.labels, CMUX_SURFACE_LABEL_PREFIX) == null &&
    labelValue(session.labels, CMUX_WORKSPACE_LABEL_PREFIX) == null
  ) {
    return {kind: 'outsideCmux'};
  }
  if (session.repo == null) {
    return {
      kind: 'failed',
      reason: `the repo of session ${session.beadId} is unknown`,
      workspaceId: override,
    };
  }
  const treeRead = await readCmuxTree(run);
  if (treeRead.kind === 'unreadable') {
    return {kind: 'failed', reason: treeRead.reason, workspaceId: override};
  }
  let workspaceId: string;
  if (override != null) {
    workspaceId = override;
  } else {
    const resolved = resolveWorkspace(treeRead.tree, session.labels);
    if (resolved.kind === 'none') return {kind: 'outsideCmux'};
    if (resolved.kind === 'unresolved') {
      return {kind: 'failed', reason: resolved.reason, workspaceId: null};
    }
    workspaceId = resolved.workspaceId;
  }
  const title = await readWorkspaceTitle(run, treeRead.tree, workspaceId);
  if (title.kind !== 'read') {
    return {kind: 'failed', reason: title.reason, workspaceId};
  }
  const names = readWorkspaceNames(env);
  if (names.kind === 'failed') {
    return {kind: 'failed', reason: names.reason, workspaceId};
  }
  const surfaceIdsHere = surfacesOfWorkspace(treeRead.tree, workspaceId);
  if (surfaceIdsHere == null) {
    // readWorkspaceTitle found it, so this is unreachable today; an absent
    // workspace must never read as "no other session here" (sticky, D5).
    return {
      kind: 'failed',
      reason: `no open cmux workspace has id ${workspaceId}`,
      workspaceId,
    };
  }
  const toolPart = stored(sessionDisplayName(session.repoTag, session.title));
  const records =
    names.kind === 'read' ? recordsFor(names.records, workspaceId) : [];
  const ownSurface = labelValue(session.labels, CMUX_SURFACE_LABEL_PREFIX);
  let decision = decideWorkspaceName({
    current: title.customTitle,
    records,
    self: {beadId: session.beadId, surfaceId: ownSurface, surfaceIdsHere},
    toolPart,
  });
  // home-base-mbnjv.3 (D8, C7): a sticky owner that handed off to this
  // session yields the name to it. home-base-mbnjv.12: also when the name is
  // already right (unchanged by any rule) but another session's line set it,
  // e.g. a closed predecessor's, so this session records it as its own.
  // confirmedPredecessor reads nothing unless this bead has continues:<it>.
  const namedBy = newestRecordNamed(records, title.customTitle)?.beadId ?? null;
  if (
    decision.kind === 'unchanged' &&
    namedBy != null &&
    namedBy !== session.beadId &&
    input.readLabels != null
  ) {
    const check = confirmedPredecessor({
      ownerBeadId: namedBy,
      ownerLabels: input.readLabels,
      selfBeadId: session.beadId,
      selfLabels: session.labels,
    });
    if (check.kind === 'ownerUnread') {
      // home-base-mbnjv.8 F4 (critical rule 7): the name stays where it is,
      // the cautious side, but the outcome says the handoff could not be
      // checked instead of reading as a plain sticky or unchanged.
      return {
        kind: 'failed',
        reason: `the name was left alone: this session continues ${namedBy}, which set it, but ${namedBy}'s labels could not be read (${check.reason}), so the handoff could not be confirmed`,
        workspaceId,
      };
    }
    if (check.kind === 'confirmed') {
      decision = decideWorkspaceName({
        current: title.customTitle,
        records,
        self: {
          beadId: session.beadId,
          handedOffFrom: check.beadId,
          surfaceId: ownSurface,
          surfaceIdsHere,
        },
        toolPart,
      });
    }
  }
  if (decision.kind === 'unchanged') return {...decision, workspaceId};
  const base = {
    at: (input.now ?? new Date()).toISOString(),
    beadId: session.beadId,
    repo: session.repo,
    sessionId: session.sessionId,
    setBy: null,
    // home-base-bomy5.4.1: the line's sticky claim is this surface.
    surfaceId: labelValue(session.labels, CMUX_SURFACE_LABEL_PREFIX),
    toolPart,
    workspaceId,
  };
  if (decision.kind === 'record') {
    if (input.dryRun === true) {
      return {
        kind: 'unchanged',
        name: decision.name,
        rule: decision.rule,
        workspaceId,
      };
    }
    const handedOff = decision.rule === 'handedOff' ? decision : null;
    const appended = appendWorkspaceName(
      {
        ...base,
        hisName: decision.hisName ?? null,
        nameSet: decision.name,
        replacedName: decision.replacedName ?? null,
      },
      env,
    );
    if (appended.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `the record could not be written: ${appended.error}`,
        workspaceId,
      };
    }
    return {
      fromBeadId: handedOff?.fromBeadId ?? null,
      kind: 'recorded',
      name: decision.name,
      workspaceId,
    };
  }
  if (input.dryRun === true) {
    return {
      from: title.customTitle,
      kind: 'wouldRename',
      rule: decision.rule,
      to: decision.target,
      workspaceId,
    };
  }
  // WRITE-AHEAD (D2): his name is on disk before the rename can touch it.
  const appended = appendWorkspaceName(
    {
      ...base,
      hisName: decision.hisName,
      nameSet: decision.target,
      replacedName: decision.replacedName,
    },
    env,
  );
  if (appended.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the record could not be written, so nothing was renamed: ${appended.error}`,
      workspaceId,
    };
  }
  const renamed = await renameWorkspace(run, workspaceId, decision.target);
  if (renamed.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the rename failed: ${renamed.reason}`,
      workspaceId,
    };
  }
  // cmux applies a rename asynchronously: measured 2026-10-16, a list read
  // straight after `rename-workspace` still showed the old name. So the
  // readback polls briefly before it calls a mismatch.
  let after = await readWorkspaceTitle(run, treeRead.tree, workspaceId);
  for (
    let attempt = 0;
    attempt < READBACK_RETRIES &&
    after.kind === 'read' &&
    after.customTitle !== decision.target;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, READBACK_DELAY_MS));
    after = await readWorkspaceTitle(run, treeRead.tree, workspaceId);
  }
  return {
    from: title.customTitle,
    kind: 'renamed',
    readback:
      after.kind === 'read'
        ? {kind: 'read', name: after.customTitle}
        : {kind: 'failed', reason: after.reason},
    rule: decision.rule,
    to: decision.target,
    workspaceId,
  };
}

/** One line for a person or a log: what the sync did, or why it did nothing. */
export function describeWorkspaceSync(outcome: WorkspaceSyncOutcome): string {
  switch (outcome.kind) {
    case 'off':
      return 'workspace name: off (componentConfig.thread.nameWorkspaces is not true)';
    case 'notReady':
      return `workspace name not set: ${outcome.reason}`;
    case 'outsideCmux':
      return 'workspace name: this session is not in cmux';
    case 'failed':
      return `workspace name not set: ${outcome.reason}`;
    case 'unchanged':
      return outcome.rule === 'sticky'
        ? `workspace name "${outcome.name}" left alone: ${stickyWords(outcome.ownerBeadId)}`
        : `workspace name already "${outcome.name}" (${RULE_WORDS[outcome.rule]})`;
    case 'recorded':
      return outcome.fromBeadId != null
        ? `workspace name "${outcome.name}" taken over from ${outcome.fromBeadId} (${RULE_WORDS.handedOff})`
        : `workspace name "${outcome.name}" recorded as the tool's (${RULE_WORDS.matchesToolPart})`;
    case 'wouldRename':
      return `would rename workspace ${outcome.workspaceId}: "${outcome.from ?? '(no name)'}" -> "${outcome.to}" (${RULE_WORDS[outcome.rule]})`;
    case 'renamed': {
      const line = `renamed workspace ${outcome.workspaceId}: "${outcome.from ?? '(no name)'}" -> "${outcome.to}" (${RULE_WORDS[outcome.rule]})`;
      if (outcome.readback.kind === 'failed') {
        return `${line}\n⚠️ could not read the name back: ${outcome.readback.reason}`;
      }
      if (outcome.readback.name !== outcome.to) {
        return `${line}\n⚠️ cmux reports "${outcome.readback.name ?? '(no name)'}", not the name sent; the record keeps the old name`;
      }
      return line;
    }
  }
}

/** The capture run record's field: kind plus the one line. */
export function workspaceSyncRecord(outcome: WorkspaceSyncOutcome): {
  detail: string;
  kind: string;
} {
  return {detail: describeWorkspaceSync(outcome), kind: outcome.kind};
}

// ---------------------------------------------------------------------------
// Names the SDK sets outside the sync (home-base-ys9t7.9.1 B3)
// ---------------------------------------------------------------------------

/**
 * B3: every `new-workspace --name` the SDK and home-base run goes through
 * recordSdkWorkspaceName (or recordNewWorkspace), so the name is on record as
 * the tool's. Before, only the sync wrote a line, and a later sync read the
 * name thread spawn or thread open had set as one Justin typed (rule 4) and
 * kept it in parentheses for good.
 */
export type SdkNameSetter = 'dashboard' | 'open' | 'respawn' | 'spawn' | 'tui';

export interface SdkNamedWorkspace {
  /** The session bead it was opened for; null when none exists (spawn, untracked). */
  beadId: string | null;
  /** What `--name` set, before cmux trims it. */
  name: string;
  repo: string | null;
  sessionId: string | null;
  setBy: SdkNameSetter;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The uuid of the workspace `new-workspace` reported: the payload of its `OK
 * <payload>` line when that is a uuid, else the tree's workspace whose ref
 * (`workspace:N`) it is. null when neither identifies one.
 */
export function newWorkspaceUuid(
  payload: string,
  tree: CmuxTree | null,
): string | null {
  if (UUID_SHAPE.test(payload)) return payload;
  if (tree == null) return null;
  for (const window of tree.windows) {
    const found = window.workspaces.find(
      (workspace) => workspace.ref === payload,
    );
    if (found != null) return found.id;
  }
  return null;
}

/** The payload of cmux's `OK <payload>` line, or null. */
export function okPayload(stdout: string): string | null {
  return /^OK\s+(\S+)/u.exec(stdout.trim())?.[1] ?? null;
}

/**
 * Append the line for a name the SDK set itself. It makes no sticky claim
 * (no surfaceId): the session it was opened for claims it on its first sync
 * (rule 0), or renames it after its own title (rule 2).
 */
export function recordSdkWorkspaceName(
  input: SdkNamedWorkspace & {
    env: EnvLike;
    /** Carried by respawn from the line it restores; null otherwise. */
    hisName?: string | null;
    now?: Date;
    replacedName?: string | null;
    workspaceId: string;
  },
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  const name = stored(input.name);
  return appendWorkspaceName(
    {
      at: (input.now ?? new Date()).toISOString(),
      beadId: input.beadId,
      hisName: input.hisName ?? null,
      nameSet: name,
      replacedName: input.replacedName ?? null,
      repo: input.repo,
      sessionId: input.sessionId,
      setBy: input.setBy,
      surfaceId: null,
      toolPart: name,
      workspaceId: input.workspaceId,
    },
    input.env,
  );
}

export type NewWorkspaceRecordOutcome =
  | {kind: 'failed'; reason: string}
  | {kind: 'recorded'; workspaceId: string};

/**
 * After a successful `new-workspace --name`: the new workspace's uuid (from
 * the payload, else from `tree`, the tree read after it, which the caller
 * reads only when the payload is not a uuid) and the record line. A failure
 * is returned to be said, never thrown: the workspace exists either way.
 */
export function recordNewWorkspaceFrom(
  input: SdkNamedWorkspace & {
    env: EnvLike;
    hisName?: string | null;
    now?: Date;
    payload: string;
    replacedName?: string | null;
    tree: CmuxTreeRead | null;
  },
): NewWorkspaceRecordOutcome {
  if (input.tree?.kind === 'unreadable') {
    return {
      kind: 'failed',
      reason: `the new workspace ${input.payload} could not be found: ${input.tree.reason}`,
    };
  }
  const workspaceId = newWorkspaceUuid(
    input.payload,
    input.tree?.kind === 'read' ? input.tree.tree : null,
  );
  if (workspaceId == null) {
    return {
      kind: 'failed',
      reason: `cmux reported the new workspace as ${input.payload}, which no open workspace has as its ref`,
    };
  }
  const appended = recordSdkWorkspaceName({...input, workspaceId});
  return appended.kind === 'ok'
    ? {kind: 'recorded', workspaceId}
    : {kind: 'failed', reason: appended.error};
}

/** Whether the payload alone names the workspace (no tree read needed). */
export function payloadIsUuid(payload: string): boolean {
  return UUID_SHAPE.test(payload);
}

/** recordNewWorkspaceFrom, reading the tree through `run` when needed. */
export async function recordNewWorkspace(
  input: SdkNamedWorkspace & {
    env: EnvLike;
    hisName?: string | null;
    now?: Date;
    payload: string;
    replacedName?: string | null;
    run: CmuxRunner;
  },
): Promise<NewWorkspaceRecordOutcome> {
  const tree = payloadIsUuid(input.payload)
    ? null
    : await readCmuxTree(input.run);
  return recordNewWorkspaceFrom({...input, tree});
}

/**
 * Records the name a `new-workspace --name` command set, from that command's
 * stdout. Built where a command is run for real (the dashboard); a caller
 * without one records nothing, so a test with a fake runner never writes the
 * real file.
 */
export type NameRecorder = (
  intent: SdkNamedWorkspace,
  stdout: string,
) => Promise<NewWorkspaceRecordOutcome>;

export function realNameRecorder(env: EnvLike): NameRecorder {
  return async (intent, stdout) => {
    const payload = okPayload(stdout);
    if (payload == null) {
      return {
        kind: 'failed',
        reason: `cmux printed no "OK <workspace>" line: ${JSON.stringify(stdout.trim().slice(0, 200))}`,
      };
    }
    return await recordNewWorkspace({
      ...intent,
      env,
      payload,
      run: realCmuxRunner(undefined, env),
    });
  };
}

/**
 * B3 for cmux-restart's respawn: a session put back in a NEW workspace after
 * a cmux restart gets the name its old workspace had. That name is the tool's
 * only when a line for the OLD workspace set exactly it, and then the new
 * workspace inherits that line's bead and hisName / replacedName. Otherwise
 * the name may be one Justin typed, so null: nothing is recorded, and the
 * next sync keeps it as his (rule 4), the cautious side.
 */
export function respawnedNameLine(
  records: readonly WorkspaceNameRecord[],
  fromWorkspaceId: string,
  name: string,
): WorkspaceNameRecord | null {
  return newestRecordNamed(recordsFor(records, fromWorkspaceId), stored(name));
}

/** One line for the output of the command that opened the workspace. */
export function describeNewWorkspaceRecord(
  outcome: NewWorkspaceRecordOutcome,
): string {
  return outcome.kind === 'recorded'
    ? `its name is recorded as the tool's in workspace-names.jsonl (${outcome.workspaceId})`
    : `⚠️ its name was NOT recorded as the tool's, so a later sync may keep it as if Justin had typed it: ${outcome.reason}`;
}

// ---------------------------------------------------------------------------
// The undo (D7 --restore)
// ---------------------------------------------------------------------------

export type RestoreItem =
  | {kind: 'leftAlone'; reason: string; workspaceId: string}
  | {
      kind: 'restore';
      /** null = clear-name (the workspace had no name before the tool). */
      name: string | null;
      result: 'dryRun' | 'done' | {failed: string};
      workspaceId: string;
    };

export type RestoreOutcome =
  | {items: RestoreItem[]; kind: 'done'}
  | {kind: 'failed'; reason: string};

/**
 * For every workspace in the record whose name still equals the tool's latest
 * name, put back hisName, else replacedName, else clear the name. A workspace
 * renamed since is left alone and listed. `onlyWorkspace` limits it to one.
 */
export async function restoreWorkspaceNames(input: {
  dryRun: boolean;
  env: EnvLike;
  onlyWorkspace?: string | null;
  run: CmuxRunner;
}): Promise<RestoreOutcome> {
  const names = readWorkspaceNames(input.env);
  if (names.kind === 'failed') return {kind: 'failed', reason: names.reason};
  if (names.kind === 'missing') return {items: [], kind: 'done'};
  const only = input.onlyWorkspace?.toUpperCase() ?? null;
  const ids = [
    ...new Set(names.records.map((record) => record.workspaceId.toUpperCase())),
  ].filter((id) => only == null || id === only);
  if (ids.length === 0) return {items: [], kind: 'done'};
  const treeRead = await readCmuxTree(input.run);
  if (treeRead.kind === 'unreadable')
    return {kind: 'failed', reason: treeRead.reason};
  const items: RestoreItem[] = [];
  for (const id of ids) {
    const lines = recordsFor(names.records, id);
    const newest = lines.at(-1);
    if (newest == null) continue;
    const workspaceId = newest.workspaceId;
    const now = await readWorkspaceTitle(input.run, treeRead.tree, workspaceId);
    if (now.kind !== 'read') {
      items.push({kind: 'leftAlone', reason: now.reason, workspaceId});
      continue;
    }
    // F1: restorable when the name equals ANY name the tool set there; the
    // newest such line says what to put back.
    const matched = newestRecordNamed(lines, now.customTitle);
    if (matched == null) {
      items.push({
        kind: 'leftAlone',
        reason: `renamed since the tool named it: now "${now.customTitle ?? '(no name)'}", the tool last set "${newest.nameSet}"`,
        workspaceId,
      });
      continue;
    }
    const name = matched.hisName ?? matched.replacedName;
    if (input.dryRun) {
      items.push({kind: 'restore', name, result: 'dryRun', workspaceId});
      continue;
    }
    const call =
      name == null
        ? await clearWorkspaceName(input.run, workspaceId)
        : await renameWorkspace(input.run, workspaceId, name);
    items.push({
      kind: 'restore',
      name,
      result: call.kind === 'ok' ? 'done' : {failed: call.reason},
      workspaceId,
    });
  }
  return {items, kind: 'done'};
}
