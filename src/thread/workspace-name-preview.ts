/**
 * `thread workspace-name --all --dry-run` (home-base-j8q3e.5.2, design D7): for
 * every open cmux workspace, its name now, what a sync would make it, the D2
 * rule that decides, and the session that would name it. READ-ONLY: this
 * module never calls renameWorkspace or clearWorkspaceName and never appends
 * to the record. Justin reads its output before the knob goes on anywhere.
 *
 * - The namer is the session that named the workspace while its surface is
 *   still there (the sticky rule, home-base-bomy5.4.1), else the most recently
 *   active session bead whose surface is in the workspace, resolved by the
 *   same rule a sync uses (resolveWorkspace, D4). A session still carrying
 *   `auto-title` cannot name anything (D3) and is listed as skipped.
 * - D5 / critical rule 7: an unreadable cmux tree, window list or record makes
 *   the whole preview fail with the reason; it never prints an empty list. One
 *   workspace the tree has and its window's list lacks is listed under "Could
 *   not read" with the reason, never as "no name".
 */

import type {OutputStyle} from '../cli-style';
import type {CmuxRunner, CmuxTree} from './cmux';
import type {EnvLike} from './paths';
import type {WorkspaceNameRule} from './workspace-name';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  sectionHeader,
  spacedList,
} from '../cli-style';
import {readCmuxTree, readWindowWorkspaces} from './cmux';
import {AUTO_TITLE_LABEL} from './session-bead';
import {sessionDisplayName} from './session-name';
import {
  confirmedPredecessor,
  decideWorkspaceName,
  liveNamer,
  newestRecordNamed,
  readWorkspaceNames,
  recordsFor,
  resolveWorkspace,
  RULE_WORDS,
  unchangedWords,
} from './workspace-name';

/** One session bead, as the dashboard's session model knows it. */
export interface PreviewSession {
  beadId: string;
  labels: readonly string[];
  /** ISO; null when nothing dates it (sorts oldest). */
  lastActivityAt: string | null;
  repo: string | null;
  /** The session model's resolved tag (home-base-bomy5.7.1). */
  repoTag: string | null;
  sessionId: string;
  title: string;
}

export type PreviewVerdict =
  | {
      hisName: string | null;
      kind: 'rename';
      rule: WorkspaceNameRule;
      to: string;
    }
  | {kind: 'unchanged'; why: string};

export interface PreviewItem {
  /** custom_title now; null = no name. */
  current: string | null;
  /** The session that would name it; null when none can. */
  namer: PreviewSession | null;
  /** Sessions in this workspace that cannot name it, and why. */
  skipped: {beadId: string; why: string}[];
  verdict: PreviewVerdict;
  windowRef: string;
  workspaceId: string;
}

/**
 * A workspace in cmux's tree that its window's list does not carry (the list
 * can lag the tree). Its name was NOT read, so it has no `current`: it is not
 * "no name" (critical rule 7), and the preview decides nothing for it.
 */
export interface PreviewUnreadable {
  reason: string;
  windowRef: string;
  workspaceId: string;
}

export type PreviewOutcome =
  | {
      items: PreviewItem[];
      kind: 'read';
      unreadable: PreviewUnreadable[];
      windows: number;
    }
  | {kind: 'failed'; reason: string};

function activityMs(session: PreviewSession): number {
  if (session.lastActivityAt == null) return -Infinity;
  const ms = Date.parse(session.lastActivityAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Which workspace each session would name: the D4 rule, against the tree. */
function workspaceOf(tree: CmuxTree, session: PreviewSession): string | null {
  const resolved = resolveWorkspace(tree, session.labels);
  return resolved.kind === 'workspace'
    ? resolved.workspaceId.toUpperCase()
    : null;
}

function verdictFor(
  current: string | null,
  namer: PreviewSession,
  records: Parameters<typeof decideWorkspaceName>[0]['records'],
  surfaceIdsHere: readonly string[],
  handedOffFrom: string | null = null,
): PreviewVerdict {
  if (namer.repo == null) {
    return {
      kind: 'unchanged',
      why: `the repo of ${namer.beadId} is unknown, so a sync sets nothing`,
    };
  }
  const decision = decideWorkspaceName({
    current,
    records,
    self: {beadId: namer.beadId, handedOffFrom, surfaceIdsHere},
    toolPart: sessionDisplayName(namer.repoTag, namer.title),
  });
  if (decision.kind === 'rename') {
    return {
      hisName: decision.hisName,
      kind: 'rename',
      rule: decision.rule,
      to: decision.target,
    };
  }
  if (decision.kind === 'record') {
    return {
      kind: 'unchanged',
      why:
        decision.rule === 'handedOff'
          ? `${RULE_WORDS.handedOff}; a sync records it as ${namer.beadId}’s`
          : `${RULE_WORDS.matchesToolPart}; a sync records it as the tool’s`,
    };
  }
  return {kind: 'unchanged', why: unchangedWords(decision)};
}

/** The preview over every open workspace. Reads cmux and the record only. */
export async function previewWorkspaceNames(input: {
  env: EnvLike;
  run: CmuxRunner;
  sessions: readonly PreviewSession[];
}): Promise<PreviewOutcome> {
  const treeRead = await readCmuxTree(input.run);
  if (treeRead.kind === 'unreadable') {
    return {kind: 'failed', reason: treeRead.reason};
  }
  const names = readWorkspaceNames(input.env);
  if (names.kind === 'failed') return {kind: 'failed', reason: names.reason};
  const records = names.kind === 'read' ? names.records : [];
  const {tree} = treeRead;
  const byWorkspace = new Map<string, PreviewSession[]>();
  for (const session of input.sessions) {
    const id = workspaceOf(tree, session);
    if (id == null) continue;
    byWorkspace.set(id, [...(byWorkspace.get(id) ?? []), session]);
  }
  const items: PreviewItem[] = [];
  const unreadable: PreviewUnreadable[] = [];
  for (const window of tree.windows) {
    const listed = await readWindowWorkspaces(input.run, window.ref);
    if (listed.kind === 'unreadable') {
      return {kind: 'failed', reason: listed.reason};
    }
    const titles = new Map(
      listed.workspaces.map((entry) => [
        entry.id.toUpperCase(),
        entry.customTitle,
      ]),
    );
    for (const workspace of window.workspaces) {
      const id = workspace.id.toUpperCase();
      // One workspace the list lags on is listed on its own, not a failed
      // preview; a whole unreadable list above still fails it (D5).
      if (!titles.has(id)) {
        unreadable.push({
          reason: `cmux's tree lists it, but its workspace list for ${window.ref} does not, so its name was not read`,
          windowRef: window.ref,
          workspaceId: workspace.id,
        });
        continue;
      }
      const current = titles.get(id) ?? null;
      const here = byWorkspace.get(id) ?? [];
      const skipped = here
        .filter((session) => session.labels.includes(AUTO_TITLE_LABEL))
        .map((session) => ({
          beadId: session.beadId,
          why: `still carries ${AUTO_TITLE_LABEL}: its title is its first message (D3)`,
        }));
      const eligible = here.filter(
        (session) => !session.labels.includes(AUTO_TITLE_LABEL),
      );
      const spaceRecords = recordsFor(records, workspace.id);
      const newest =
        eligible.reduce<PreviewSession | null>(
          (best, session) =>
            best == null || activityMs(session) > activityMs(best)
              ? session
              : best,
          null,
        ) ?? null;
      // home-base-bomy5.4.1: the session that named it keeps it while its
      // surface is here, so it is the namer; otherwise the newest activity.
      const ownerId = liveNamer(
        newestRecordNamed(spaceRecords, current),
        workspace.surfaceIds,
      );
      const owner =
        ownerId == null
          ? null
          : (eligible.find((session) => session.beadId === ownerId) ?? null);
      // home-base-mbnjv.3 (D8, C7): an owner that handed off to a session
      // here (both halves of the link) yields the name to it, as the sync does.
      const heir =
        owner == null
          ? null
          : (eligible.find(
              (session) =>
                confirmedPredecessor({
                  ownerBeadId: owner.beadId,
                  ownerLabels: () => ({kind: 'found', labels: owner.labels}),
                  selfBeadId: session.beadId,
                  selfLabels: session.labels,
                }).kind === 'confirmed',
            ) ?? null);
      const namer = heir ?? owner ?? newest;
      const keptBy =
        heir == null && owner != null && owner !== newest ? owner.beadId : null;
      let verdict: PreviewVerdict =
        namer == null
          ? {
              kind: 'unchanged',
              why:
                skipped.length > 0
                  ? 'no session here has a real title yet'
                  : 'no session bead’s surface is in this workspace',
            }
          : verdictFor(
              current,
              namer,
              spaceRecords,
              workspace.surfaceIds,
              heir == null ? null : (owner?.beadId ?? null),
            );
      if (keptBy != null && verdict.kind === 'unchanged') {
        verdict = {
          kind: 'unchanged',
          why: `kept by ${keptBy}, still open here (sticky); ${verdict.why}`,
        };
      }
      items.push({
        current,
        namer,
        skipped,
        verdict,
        windowRef: window.ref,
        workspaceId: workspace.id,
      });
    }
  }
  return {items, kind: 'read', unreadable, windows: tree.windows.length};
}

export interface PreviewCounts {
  generated: number;
  his: number;
  noSession: number;
  rename: number;
  total: number;
  unchanged: number;
  /** In the tree, not in its window's list: nothing decided for them. */
  unreadable: number;
}

export function previewCounts(preview: {
  items: readonly PreviewItem[];
  unreadable: readonly PreviewUnreadable[];
}): PreviewCounts {
  const {items} = preview;
  const renames = items.flatMap((item) =>
    item.verdict.kind === 'rename' ? [item.verdict] : [],
  );
  return {
    generated: renames.filter((verdict) => verdict.rule === 'generated').length,
    his: renames.filter((verdict) => verdict.hisName != null).length,
    noSession: items.filter((item) => item.namer == null).length,
    rename: renames.length,
    total: items.length + preview.unreadable.length,
    unchanged: items.length - renames.length,
    unreadable: preview.unreadable.length,
  };
}

function quoted(name: string | null): string {
  return name == null ? '(no name)' : `"${name}"`;
}

function unreadableBlock(entry: PreviewUnreadable, style: OutputStyle): string {
  return fieldLines(
    [
      {label: 'workspace', value: `${entry.workspaceId} (${entry.windowRef})`},
      {label: 'now', value: 'not read'},
      {label: 'why', value: entry.reason},
    ],
    {
      color: style.color,
      indent: BODY_COLUMN,
      labelWidth: fieldLabelWidth([{label: 'cannot name it', value: ''}]),
      width: style.width,
    },
  );
}

function itemBlock(item: PreviewItem, style: OutputStyle): string {
  const fields = [
    {label: 'workspace', value: `${item.workspaceId} (${item.windowRef})`},
    {label: 'now', value: quoted(item.current)},
    {
      label: 'becomes',
      value:
        item.verdict.kind === 'rename' ? quoted(item.verdict.to) : 'unchanged',
    },
    {
      label: 'why',
      value:
        item.verdict.kind === 'rename'
          ? RULE_WORDS[item.verdict.rule]
          : item.verdict.why,
    },
  ];
  if (item.namer != null) {
    fields.push(
      {label: 'session', value: item.namer.beadId},
      {label: 'session title', value: item.namer.title},
      {label: 'last active', value: item.namer.lastActivityAt ?? 'unknown'},
    );
  }
  if (item.skipped.length > 0) {
    fields.push({
      label: 'cannot name it',
      value: item.skipped
        .map((entry) => `${entry.beadId}: ${entry.why}`)
        .join('\n'),
    });
  }
  return fieldLines(fields, {
    color: style.color,
    indent: BODY_COLUMN,
    labelWidth: fieldLabelWidth([{label: 'cannot name it', value: ''}]),
    width: style.width,
  });
}

/** The preview, man-page style (CLAUDE.md "Terminal output style"). */
export function renderWorkspaceNamePreview(
  preview: {
    items: readonly PreviewItem[];
    knobs: readonly {repo: string; state: string}[];
    notes: readonly string[];
    unreadable: readonly PreviewUnreadable[];
    windows: number;
  },
  style: OutputStyle,
): string {
  const counts = previewCounts(preview);
  const body = (fields: {label: string; value: string}[]) =>
    fieldLines(fields, {
      color: style.color,
      indent: BODY_COLUMN,
      width: style.width,
    });
  const renames = preview.items.filter(
    (item) => item.verdict.kind === 'rename',
  );
  const unchanged = preview.items.filter(
    (item) => item.verdict.kind === 'unchanged',
  );
  return spacedList([
    sectionHeader('Workspace names: preview', {
      color: style.color,
      emoji: '🪪',
    }),
    body([
      {label: 'read-only', value: 'nothing was renamed and no record written'},
    ]),
    body([
      {
        label: 'workspaces',
        value: `${counts.total} in ${preview.windows} windows`,
      },
      {label: 'would be renamed', value: String(counts.rename)},
      {label: 'his name kept', value: `${counts.his} (in parentheses)`},
      {label: 'generated replaced', value: `${counts.generated} (✳ names)`},
      {label: 'unchanged', value: String(counts.unchanged)},
      {label: 'no session', value: `${counts.noSession} (of the unchanged)`},
      {
        label: 'could not read',
        value: `${counts.unreadable} (name not read, nothing decided)`,
      },
    ]),
    ...preview.notes.map((note) => body([{label: 'note', value: note}])),
    sectionHeader('Knob per repo (componentConfig.thread.nameWorkspaces)', {
      color: style.color,
      emoji: '🎚️',
    }),
    body(
      preview.knobs.length === 0
        ? [{label: 'repos', value: 'none (no session bead names a workspace)'}]
        : preview.knobs.map((knob) => ({label: knob.repo, value: knob.state})),
    ),
    sectionHeader(`Could not read (${preview.unreadable.length})`, {
      color: style.color,
      emoji: '⚠️',
    }),
    ...preview.unreadable.map((entry) => unreadableBlock(entry, style)),
    sectionHeader(`Would be renamed (${renames.length})`, {
      color: style.color,
      emoji: '✏️',
    }),
    ...renames.map((item) => itemBlock(item, style)),
    sectionHeader(`Unchanged (${unchanged.length})`, {
      color: style.color,
      emoji: '⏸️',
    }),
    ...unchanged.map((item) => itemBlock(item, style)),
  ]);
}
