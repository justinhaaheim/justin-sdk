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

import type {CmuxRunner, CmuxTree} from './cmux';
import type {EnvLike} from './paths';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';

import {workspaceNamesPath} from './archive';
import {
  clearWorkspaceName,
  readCmuxTree,
  readWorkspaceTitle,
  renameWorkspace,
  surfacesOfWorkspace,
  workspaceExists,
  workspaceOfSurface,
} from './cmux';
import {
  AUTO_TITLE_LABEL,
  CMUX_SURFACE_LABEL_PREFIX,
  CMUX_WORKSPACE_LABEL_PREFIX,
  labelValue,
} from './session-bead';
import {sessionDisplayName} from './session-name';

/** U+2733, Claude Code's idle-title glyph: a name no human typed (D2 rule 3). */
export const GENERATED_NAME_PREFIX = '✳';

const READBACK_RETRIES = 10;
const READBACK_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// The record (D2)
// ---------------------------------------------------------------------------

const recordSchema = z.object({
  at: z.string(),
  beadId: z.string(),
  hisName: z.string().nullable(),
  nameSet: z.string(),
  replacedName: z.string().nullable(),
  repo: z.string().nullable(),
  sessionId: z.string().nullable(),
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
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(record)}\n`);
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
  | 'his'
  | 'matchesToolPart'
  | 'sticky'
  | 'tools';

export type WorkspaceNameDecision =
  | {kind: 'record'; name: string; rule: 'matchesToolPart'}
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
    'the name starts with ✳, so a tool generated it, not Justin (rule 3)',
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
  return owner != null && owner !== self.beadId ? owner : null;
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
  // Rule 0 (F2): C equal to T is always the tool's, whatever else the record
  // holds; otherwise rule 4 would read it as his and nest it, "T (T)".
  if (current === toolPart) {
    return newestRecordNamed(records, toolPart) == null
      ? {kind: 'record', name: current, rule: 'matchesToolPart'}
      : {kind: 'unchanged', name: current, rule: 'matchesToolPart'};
  }
  const latest = newestRecordNamed(records, current);
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
    decided = {
      hisName: latest.hisName,
      kind: 'rename',
      replacedName: latest.replacedName,
      rule: 'tools',
      target:
        latest.hisName != null ? `${toolPart} (${latest.hisName})` : toolPart,
    };
  } else if (current.startsWith(GENERATED_NAME_PREFIX)) {
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
    return {kind: 'unchanged', name: current, rule: decided.rule};
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
  | {kind: 'recorded'; name: string; workspaceId: string}
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
  const decision = decideWorkspaceName({
    current: title.customTitle,
    records:
      names.kind === 'read' ? recordsFor(names.records, workspaceId) : [],
    self: {beadId: session.beadId, surfaceIdsHere},
    toolPart,
  });
  if (decision.kind === 'unchanged') return {...decision, workspaceId};
  const base = {
    at: (input.now ?? new Date()).toISOString(),
    beadId: session.beadId,
    repo: session.repo,
    sessionId: session.sessionId,
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
    const appended = appendWorkspaceName(
      {...base, hisName: null, nameSet: decision.name, replacedName: null},
      env,
    );
    if (appended.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `the record could not be written: ${appended.error}`,
        workspaceId,
      };
    }
    return {kind: 'recorded', name: decision.name, workspaceId};
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
      return `workspace name "${outcome.name}" recorded as the tool's (${RULE_WORDS.matchesToolPart})`;
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
