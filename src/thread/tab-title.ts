/**
 * Tab titles that follow the handoff chain (epic home-base-mbnjv D8, C7;
 * built by home-base-mbnjv.3 item 5).
 *
 * - A SUCCESSOR's tab (a session bead with a `continues:` label) is titled
 *   after its session, sessionName(repoTag, title), the same name its
 *   workspace, its --name and its --remote-control name use (item 6). The
 *   tab is the bead's own `cmux-surface:` label, never a guess: no label, no
 *   rename.
 * - The PREDECESSOR's tab is marked handed off by `thread handoff` right after
 *   the successor's tab opened, on the caller's own CMUX_SURFACE_ID
 *   (handoff-successor.ts). A session labelled handed-off is never renamed
 *   here, so the mark stays.
 *
 * IDEMPOTENT WITHOUT READING cmux. tab-titles.jsonl records every title this
 * module set, AFTER the rename succeeded. A tab whose newest record already
 * equals the title is left alone, so a sync costs no cmux call until the
 * session's name changes, and a name Justin gives the tab by hand stays until
 * then.
 *
 * KNOB. Only when componentConfig.thread.nameWorkspaces AND
 * componentConfig.thread.handoff.successor are on in the session's checkout
 * (feature-knobs rule: new behaviour, default off). The caller passes the
 * result as `enabled`.
 */

import type {CmuxRunner} from './cmux';
import type {EnvLike} from './paths';
import type {WorkspaceSession} from './workspace-name';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {z} from 'zod';

import {readCmuxTree, renameTab, workspaceOfSurface} from './cmux';
import {threadsStateDir} from './paths';
import {
  AUTO_TITLE_LABEL,
  CMUX_SURFACE_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  labelValue,
} from './session-bead';
import {sessionName} from './session-name';

/** What the predecessor's tab title starts with once it handed off. */
export const HANDED_OFF_TAB_PREFIX = '↪ handed off: ';

/** The predecessor's tab title: the mark, then its session's name. */
export function handedOffTabTitle(name: string): string {
  return `${HANDED_OFF_TAB_PREFIX}${name}`;
}

export function tabTitlesPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'tab-titles.jsonl');
}

const recordSchema = z.object({
  at: z.string(),
  beadId: z.string(),
  surfaceId: z.string(),
  title: z.string(),
});

export type TabTitleRecord = z.infer<typeof recordSchema>;

export type TabTitlesRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; records: TabTitleRecord[]};

/** Every record; a missing file is none, an unparseable line is a failure. */
export function readTabTitles(env: EnvLike): TabTitlesRead {
  const path = tabTitlesPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'read', records: []};
    }
    return {kind: 'failed', reason: `${path}: ${String(error)}`};
  }
  const records: TabTitleRecord[] = [];
  for (const [index, line] of text.split('\n').entries()) {
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
        reason: `${path} line ${index + 1} is not a tab-title record`,
      };
    }
    records.push(parsed.data);
  }
  return {kind: 'read', records};
}

function appendTabTitle(
  record: TabTitleRecord,
  env: EnvLike,
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  const path = tabTitlesPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return {kind: 'ok'};
  } catch (error) {
    return {error: `${path}: ${String(error)}`, kind: 'failed'};
  }
}

export type TabTitleOutcome =
  | {kind: 'off'}
  /** Not a successor, still auto-titled, or already handed off. */
  | {kind: 'skipped'; reason: string}
  | {kind: 'unchanged'; surfaceId: string; title: string}
  | {kind: 'failed'; reason: string}
  | {
      kind: 'renamed';
      /** Set when the record could not be written after the rename. */
      recordFailed: string | null;
      surfaceId: string;
      title: string;
    };

/** Title a successor's own tab after its session (see the header). */
export async function syncTabTitle(input: {
  enabled: boolean;
  env: EnvLike;
  now?: Date;
  run: CmuxRunner;
  session: WorkspaceSession;
}): Promise<TabTitleOutcome> {
  const {env, session} = input;
  if (!input.enabled) return {kind: 'off'};
  const {labels} = session;
  if (!labels.some((label) => label.startsWith(CONTINUES_LABEL_PREFIX))) {
    return {kind: 'skipped', reason: 'not a successor (no continues: label)'};
  }
  if (labels.includes(HANDED_OFF_LABEL)) {
    return {
      kind: 'skipped',
      reason: 'the session handed off, so its tab keeps the handed-off mark',
    };
  }
  if (labels.includes(AUTO_TITLE_LABEL)) {
    return {
      kind: 'skipped',
      reason: `the session still carries ${AUTO_TITLE_LABEL}`,
    };
  }
  const surfaceId = labelValue(labels, CMUX_SURFACE_LABEL_PREFIX);
  if (surfaceId == null) {
    return {
      kind: 'skipped',
      reason: `the session bead has no ${CMUX_SURFACE_LABEL_PREFIX} label, so its tab is not known`,
    };
  }
  const title = sessionName(session.repoTag, session.title);
  const read = readTabTitles(env);
  if (read.kind === 'failed') return {kind: 'failed', reason: read.reason};
  const want = surfaceId.toUpperCase();
  const newest = read.records
    .filter((record) => record.surfaceId.toUpperCase() === want)
    .at(-1);
  if (newest?.title === title) return {kind: 'unchanged', surfaceId, title};
  const tree = await readCmuxTree(input.run);
  if (tree.kind === 'unreadable') {
    return {kind: 'failed', reason: tree.reason};
  }
  const workspaceId = workspaceOfSurface(tree.tree, surfaceId);
  if (workspaceId == null) {
    return {
      kind: 'failed',
      reason: `the session's tab ${surfaceId} is not open in cmux`,
    };
  }
  const renamed = await renameTab(input.run, workspaceId, surfaceId, title);
  if (renamed.kind === 'failed') {
    return {kind: 'failed', reason: `the rename failed: ${renamed.reason}`};
  }
  const appended = appendTabTitle(
    {
      at: (input.now ?? new Date()).toISOString(),
      beadId: session.beadId,
      surfaceId,
      title,
    },
    env,
  );
  return {
    kind: 'renamed',
    recordFailed: appended.kind === 'failed' ? appended.error : null,
    surfaceId,
    title,
  };
}

/** One line for a person or a log. */
export function describeTabTitle(outcome: TabTitleOutcome): string {
  switch (outcome.kind) {
    case 'off':
      return 'tab title: off (componentConfig.thread.nameWorkspaces and componentConfig.thread.handoff.successor are not both true)';
    case 'skipped':
      return `tab title not set: ${outcome.reason}`;
    case 'unchanged':
      return `tab title already "${outcome.title}"`;
    case 'failed':
      return `tab title not set: ${outcome.reason}`;
    case 'renamed':
      return outcome.recordFailed == null
        ? `renamed tab ${outcome.surfaceId} to "${outcome.title}"`
        : `renamed tab ${outcome.surfaceId} to "${outcome.title}"\n⚠️ the record could not be written, so the next sync renames it again: ${outcome.recordFailed}`;
  }
}
