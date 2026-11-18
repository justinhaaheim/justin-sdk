/**
 * cmux's own saved session files: the ONE reader (home-base-kwand.1, epic
 * home-base-kwand D1).
 *
 * Moved here from pane-join.ts, which re-exports the old names, so the
 * status-line source of the pane join (`placeByStatusLine`, which trusts the
 * file's session id only when the screen's ⌗ agrees) and the tab record read
 * the file with the same code.
 *
 * TWO READS OF ONE FILE:
 *  - `readSessionFile` is the pane join's lenient read: any JSON with a
 *    `windows` list. Unchanged in behaviour.
 *  - `readTabSet` is the tab record's strict projection. It copies ONLY the
 *    fields named in TAB_FIELDS below, never `notifications`, `logEntries`,
 *    `statusEntries`, `resumeBinding.command`, environments or scrollback:
 *    those can hold private text. An unknown `version`, a missing required key
 *    or a key of the wrong type is a failure that names the file and the key,
 *    never an empty tab list (critical rule 7).
 *
 * THE FILES (measured 2026-11-17 on cmux 0.65.2, epic D1), all under
 * `~/Library/Application Support/cmux/`:
 *  - `session-com.cmuxterm.app.json`: rewritten by cmux while it runs.
 *  - `session-com.cmuxterm.app-previous.json`: written at launch; the layout
 *    cmux restored.
 *  - `session-history/session-com.cmuxterm.app-<epoch ms>-w<N>-p<N>.json`: one
 *    per launch.
 * `createdAt` is Unix seconds with a fraction; `version` is 1. `panel.id` is
 * the live CMUX_SURFACE_ID and is stable across a cmux relaunch;
 * `stableSurfaceId` is a different value and is not read.
 */

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** Environment as this module reads it; `process.env` is assignable. */
type EnvLike = Record<string, string | undefined>;

/** Points the reader at another cmux support dir (tests, evidence copies). */
export const CMUX_SUPPORT_DIR_ENV_VAR = 'JUSTIN_THREADS_CMUX_SUPPORT_DIR';

export const LIVE_SESSION_FILE = 'session-com.cmuxterm.app.json';
export const PREVIOUS_SESSION_FILE = 'session-com.cmuxterm.app-previous.json';
export const SESSION_HISTORY_DIR = 'session-history';

/** `session-com.cmuxterm.app-<epoch ms>-w<N>-p<N>.json`, the launch's time in ms. */
const HISTORY_FILE_PATTERN =
  /^session-com\.cmuxterm\.app-(\d+)-w\d+-p\d+\.json$/u;

/** The `version` values this reader has been checked against. */
export const KNOWN_SESSION_FILE_VERSIONS: readonly number[] = [1];

/** cmux's support dir: the env override, else `~/Library/Application Support/cmux`. */
export function cmuxSupportDir(
  env: EnvLike = process.env,
  home: string = homedir(),
): string {
  const override = env[CMUX_SUPPORT_DIR_ENV_VAR];
  if (override != null && override !== '') return override;
  return join(home, 'Library', 'Application Support', 'cmux');
}

/** The launch time a session-history file's name carries, or null. */
export function historyFileEpochMs(name: string): number | null {
  const match = HISTORY_FILE_PATTERN.exec(name);
  if (match?.[1] == null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The pane join's lenient read (moved from pane-join.ts, unchanged)
// ---------------------------------------------------------------------------

export interface SessionResumeBinding {
  checkpointId?: string | null;
  command?: unknown;
  cwd?: string | null;
  kind?: string | null;
}

export interface SessionPanel {
  directory?: string | null;
  /** The surface's uuid: the live tree's surface `id` (97 of 97, 2026-10-17). */
  id: string;
  terminal?: {
    agent?: {
      kind?: string | null;
      sessionId?: string | null;
      workingDirectory?: string | null;
    } | null;
    resumeBinding?: SessionResumeBinding | null;
    wasAgentRunning?: boolean | null;
    workingDirectory?: string | null;
  } | null;
  title?: string | null;
  ttyName?: string | null;
  type?: string | null;
}

export interface SessionWorkspace {
  currentDirectory?: string | null;
  customTitle?: string | null;
  panels?: SessionPanel[];
  processTitle?: string | null;
  stableId?: string | null;
  workspaceId?: string | null;
}

export interface SessionFile {
  windows?: {
    tabManager?: {workspaces?: SessionWorkspace[]};
  }[];
}

/** cmux's session file, under the user's home directory. */
export function defaultSessionFilePath(home: string = homedir()): string {
  return join(
    home,
    'Library',
    'Application Support',
    'cmux',
    LIVE_SESSION_FILE,
  );
}

/** Every panel of the session file, with the workspace that holds it. */
export function sessionPanels(
  session: SessionFile,
): {panel: SessionPanel; workspace: SessionWorkspace}[] {
  const out: {panel: SessionPanel; workspace: SessionWorkspace}[] = [];
  for (const window of session.windows ?? []) {
    for (const workspace of window.tabManager?.workspaces ?? []) {
      for (const panel of workspace.panels ?? []) {
        out.push({panel, workspace});
      }
    }
  }
  return out;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? text;
}

/** The file parsed as JSON, or why not. Shared by both reads. */
function readJson(
  path: string,
): {ok: false; reason: string} | {ok: true; value: unknown} {
  if (!existsSync(path)) {
    return {ok: false, reason: `no cmux session file at ${path}`};
  }
  try {
    return {ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown};
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the cmux session file ${path}: ${firstLine(error)}`,
    };
  }
}

/**
 * The session file. A missing file is a failure, as for the hook store:
 * without it no status-line id can be confirmed (critical rule 7).
 */
export function readSessionFile(
  path: string,
): {ok: false; reason: string} | {ok: true; value: SessionFile} {
  const read = readJson(path);
  if (!read.ok) return read;
  const parsed = read.value;
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as {windows?: unknown}).windows)
  ) {
    return {
      ok: false,
      reason: `the cmux session file ${path} has no windows list`,
    };
  }
  return {ok: true, value: parsed as SessionFile};
}

// ---------------------------------------------------------------------------
// The tab record's strict projection (home-base-kwand.1)
// ---------------------------------------------------------------------------

/**
 * One tab (a cmux panel), ONLY the allowed fields. Titles are `customTitle`,
 * else `title`; nothing else from the panel is copied.
 */
export interface ProjectedTab {
  /** `terminal.agent.kind` ("claude"), or null. */
  agentKind: string | null;
  /** `terminal.agent.workingDirectory`, or null. */
  agentWorkingDirectory: string | null;
  /** `terminal.resumeBinding.autoResume`, or null when cmux saved none. */
  autoResume: boolean | null;
  directory: string | null;
  /** `panel.id`: the live CMUX_SURFACE_ID, stable across a cmux relaunch. */
  id: string;
  /** `terminal.agent.sessionId`: the Claude session id cmux saved, or null. */
  sessionId: string | null;
  title: string | null;
  ttyName: string | null;
  /** "terminal", "markdown", … */
  type: string;
}

export interface ProjectedWorkspace {
  currentDirectory: string | null;
  tabs: ProjectedTab[];
  /** `customTitle`, else `processTitle`. */
  title: string | null;
  workspaceId: string;
}

export interface ProjectedWindow {
  /** The window's position in the file, from 0. */
  index: number;
  workspaces: ProjectedWorkspace[];
}

/** What one session file says was open. */
export interface TabSet {
  /** The file's `createdAt`, in ms (cmux writes seconds with a fraction). */
  fileCreatedAt: number;
  fileVersion: number;
  windows: ProjectedWindow[];
}

/** The projection, or why it failed: the file, the key (when one), the reason. */
export type TabSetRead =
  | {file: string; key: string | null; ok: false; reason: string}
  | {ok: true; tabSet: TabSet};

/** A shape the projection does not recognise: the key path and what is wrong. */
interface ShapeProblem {
  key: string;
  what: string;
}

type Shaped<T> = {ok: false; problem: ShapeProblem} | {ok: true; value: T};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** An optional string: absent or null is null; any other type is a problem. */
function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
): Shaped<string | null> {
  const value = object[key];
  if (value == null) return {ok: true, value: null};
  if (typeof value !== 'string') {
    return {
      ok: false,
      problem: {
        key: `${path}.${key}`,
        what: `is a ${typeof value}, not a string`,
      },
    };
  }
  return {ok: true, value};
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
): Shaped<string> {
  const value = object[key];
  if (typeof value !== 'string' || value === '') {
    return {
      ok: false,
      problem: {
        key: `${path}.${key}`,
        what: value == null ? 'is missing' : 'is not a non-empty string',
      },
    };
  }
  return {ok: true, value};
}

function optionalObject(
  object: Record<string, unknown>,
  key: string,
  path: string,
): Shaped<Record<string, unknown> | null> {
  const value = object[key];
  if (value == null) return {ok: true, value: null};
  if (!isRecord(value)) {
    return {
      ok: false,
      problem: {key: `${path}.${key}`, what: 'is not an object'},
    };
  }
  return {ok: true, value};
}

function projectPanel(panel: unknown, path: string): Shaped<ProjectedTab> {
  if (!isRecord(panel)) {
    return {ok: false, problem: {key: path, what: 'is not an object'}};
  }
  const id = requiredString(panel, 'id', path);
  if (!id.ok) return id;
  const type = requiredString(panel, 'type', path);
  if (!type.ok) return type;
  const customTitle = optionalString(panel, 'customTitle', path);
  if (!customTitle.ok) return customTitle;
  const title = optionalString(panel, 'title', path);
  if (!title.ok) return title;
  const ttyName = optionalString(panel, 'ttyName', path);
  if (!ttyName.ok) return ttyName;
  const directory = optionalString(panel, 'directory', path);
  if (!directory.ok) return directory;
  const terminal = optionalObject(panel, 'terminal', path);
  if (!terminal.ok) return terminal;

  let agentKind: string | null = null;
  let sessionId: string | null = null;
  let agentWorkingDirectory: string | null = null;
  let autoResume: boolean | null = null;
  if (terminal.value != null) {
    const terminalPath = `${path}.terminal`;
    const agent = optionalObject(terminal.value, 'agent', terminalPath);
    if (!agent.ok) return agent;
    if (agent.value != null) {
      const agentPath = `${terminalPath}.agent`;
      const kind = optionalString(agent.value, 'kind', agentPath);
      if (!kind.ok) return kind;
      const sid = optionalString(agent.value, 'sessionId', agentPath);
      if (!sid.ok) return sid;
      const cwd = optionalString(agent.value, 'workingDirectory', agentPath);
      if (!cwd.ok) return cwd;
      agentKind = kind.value;
      sessionId = sid.value === '' ? null : sid.value;
      agentWorkingDirectory = cwd.value;
    }
    const binding = optionalObject(
      terminal.value,
      'resumeBinding',
      terminalPath,
    );
    if (!binding.ok) return binding;
    if (binding.value != null) {
      const value = binding.value.autoResume;
      if (value != null && typeof value !== 'boolean') {
        return {
          ok: false,
          problem: {
            key: `${terminalPath}.resumeBinding.autoResume`,
            what: 'is not a boolean',
          },
        };
      }
      autoResume = value ?? null;
    }
  }
  return {
    ok: true,
    value: {
      agentKind,
      agentWorkingDirectory,
      autoResume,
      directory: directory.value,
      id: id.value,
      sessionId,
      title: customTitle.value ?? title.value,
      ttyName: ttyName.value,
      type: type.value,
    },
  };
}

function projectWorkspace(
  workspace: unknown,
  path: string,
): Shaped<ProjectedWorkspace> {
  if (!isRecord(workspace)) {
    return {ok: false, problem: {key: path, what: 'is not an object'}};
  }
  const workspaceId = requiredString(workspace, 'workspaceId', path);
  if (!workspaceId.ok) return workspaceId;
  const customTitle = optionalString(workspace, 'customTitle', path);
  if (!customTitle.ok) return customTitle;
  const processTitle = optionalString(workspace, 'processTitle', path);
  if (!processTitle.ok) return processTitle;
  const currentDirectory = optionalString(workspace, 'currentDirectory', path);
  if (!currentDirectory.ok) return currentDirectory;
  const panels = workspace.panels;
  if (!Array.isArray(panels)) {
    return {
      ok: false,
      problem: {
        key: `${path}.panels`,
        what: panels == null ? 'is missing' : 'is not a list',
      },
    };
  }
  const tabs: ProjectedTab[] = [];
  for (const [index, panel] of panels.entries()) {
    const tab = projectPanel(panel, `${path}.panels[${index}]`);
    if (!tab.ok) return tab;
    tabs.push(tab.value);
  }
  return {
    ok: true,
    value: {
      currentDirectory: currentDirectory.value,
      tabs,
      title: customTitle.value ?? processTitle.value,
      workspaceId: workspaceId.value,
    },
  };
}

/** The allow-listed projection of an already-parsed session file. */
export function projectTabSet(parsed: unknown, file: string): TabSetRead {
  const fail = (problem: ShapeProblem): TabSetRead => ({
    file,
    key: problem.key,
    ok: false,
    reason: `cmux's session file ${file} has a shape this reader does not know: ${problem.key} ${problem.what}`,
  });
  if (!isRecord(parsed))
    return fail({key: '(top level)', what: 'is not an object'});
  const version = parsed.version;
  if (typeof version !== 'number') {
    return fail({
      key: 'version',
      what: version == null ? 'is missing' : 'is not a number',
    });
  }
  if (!KNOWN_SESSION_FILE_VERSIONS.includes(version)) {
    return fail({
      key: 'version',
      what: `is ${version}; this reader knows ${KNOWN_SESSION_FILE_VERSIONS.join(', ')}`,
    });
  }
  const createdAt = parsed.createdAt;
  if (
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    return fail({
      key: 'createdAt',
      what: createdAt == null ? 'is missing' : 'is not a positive number',
    });
  }
  const windows = parsed.windows;
  if (!Array.isArray(windows)) {
    return fail({
      key: 'windows',
      what: windows == null ? 'is missing' : 'is not a list',
    });
  }
  const projected: ProjectedWindow[] = [];
  for (const [index, window] of windows.entries()) {
    const path = `windows[${index}]`;
    if (!isRecord(window)) return fail({key: path, what: 'is not an object'});
    const tabManager = window.tabManager;
    if (!isRecord(tabManager)) {
      return fail({
        key: `${path}.tabManager`,
        what: tabManager == null ? 'is missing' : 'is not an object',
      });
    }
    const workspaces = tabManager.workspaces;
    if (!Array.isArray(workspaces)) {
      return fail({
        key: `${path}.tabManager.workspaces`,
        what: workspaces == null ? 'is missing' : 'is not a list',
      });
    }
    const out: ProjectedWorkspace[] = [];
    for (const [wsIndex, workspace] of workspaces.entries()) {
      const read = projectWorkspace(
        workspace,
        `${path}.tabManager.workspaces[${wsIndex}]`,
      );
      if (!read.ok) return fail(read.problem);
      out.push(read.value);
    }
    projected.push({index, workspaces: out});
  }
  return {
    ok: true,
    tabSet: {
      fileCreatedAt: Math.round(createdAt * 1000),
      fileVersion: version,
      windows: projected,
    },
  };
}

/** Read and project one session file. A missing or unparsable file names why. */
export function readTabSet(path: string): TabSetRead {
  const read = readJson(path);
  if (!read.ok) return {file: path, key: null, ok: false, reason: read.reason};
  return projectTabSet(read.value, path);
}
