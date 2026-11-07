/**
 * The SDK's cmux client (home-base-j8q3e.5.1), only what workspace naming
 * needs. The shape copies home-base's scripts/cmux-respawn.ts (an injectable
 * runner, `CMUX_QUIET=1`), which the SDK cannot import, with two changes for
 * critical rule 7 and D5: a failed call is a distinct member of the result
 * type, and every call has a timeout so a hung socket cannot hang the capture
 * child.
 *
 * Measured 2026-10-16 (home-base-j8q3e.5 design, MEASURED):
 * - `cmux --json --id-format both tree --all` lists every window, its
 *   workspaces and their surfaces, with uuids. It carries no custom_title.
 * - `cmux --json workspace list --window <ref>` lists ONE window's workspaces
 *   with `custom_title` (string or null).
 * - Every write names `--workspace <uuid>`: without it cmux acts on the
 *   CALLER's workspace.
 */

import type {EnvLike} from './paths';

import {execFile} from 'node:child_process';
import {accessSync, constants, statSync} from 'node:fs';
import {z} from 'zod';

import {cmuxCallIsReadOnly} from './cmux-read-only';

export type CmuxCall =
  | {
      kind: 'failed';
      reason: string;
      /**
       * home-base-89c8h.1 D1: the call ran out of time, so nothing is known
       * about whether cmux acted on it. Callers read this field and never
       * match the reason's text (rule 7).
       */
      timedOut: boolean;
    }
  | {kind: 'ok'; stdout: string};

/**
 * Runs `cmux <args>`. Injected so tests never reach the real cmux. `limit`
 * replaces the runner's own time limit for this one call.
 */
export type CmuxRunner = (
  args: readonly string[],
  limit?: {timeoutMs: number},
) => Promise<CmuxCall>;

/**
 * Measured 2026-11-06 with the Mac at load average 68: `cmux tree --all` took
 * 15 s, and a 4 s limit made the handoff gate refuse a healthy session with
 * liveSessionsUnknown. A refused handoff is final, so a slow cmux must not read
 * as a failed one.
 */
export const CMUX_TIMEOUT_MS = 30_000;

/**
 * The cmux CLI's own response limit, in seconds. Measured 2026-11-06 (cmux
 * 0.64.24): against a socket that accepts and never answers, `cmux ping` exits
 * 1 at 15.04 s with CMUX_CLI_TIMEOUT_TEXT on stderr, and with this set to 2 at
 * 2.05 s.
 */
export const CMUX_CLI_TIMEOUT_ENV = 'CMUXTERM_CLI_RESPONSE_TIMEOUT_SEC';

/** What the cmux CLI prints, alone on its line, when its own limit fires. */
export const CMUX_CLI_TIMEOUT_TEXT = 'Error: Command timed out';

/** Where the binary came from: which env variable, or a PATH lookup. */
export type CmuxBinarySource =
  | 'CMUX_BUNDLED_CLI_PATH'
  | 'CMUX_CLAUDE_HOOK_CMUX_BIN'
  | 'PATH';

/** `[ -x path ]` on a regular file; anything unreadable is not usable. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * home-base-j8q3e.5.4: the binary in cmux's own hook order, because a hook's
 * environment can differ from an interactive shell. $CMUX_CLAUDE_HOOK_CMUX_BIN,
 * then $CMUX_BUNDLED_CLI_PATH, each only when it is an executable file, then
 * a bare `cmux` that execFile looks up on `env.PATH` (measured 2026-10-17:
 * bun's execFile resolves a bare name through options.env.PATH).
 */
export function resolveCmuxBinary(env: EnvLike): {
  path: string;
  source: CmuxBinarySource;
} {
  const candidates = [
    'CMUX_CLAUDE_HOOK_CMUX_BIN',
    'CMUX_BUNDLED_CLI_PATH',
  ] as const;
  for (const source of candidates) {
    const path = env[source];
    if (path != null && path !== '' && isExecutableFile(path)) {
      return {path, source};
    }
  }
  return {path: 'cmux', source: 'PATH'};
}

/**
 * The argv after the binary: `--socket $CMUX_SOCKET_PATH` when it is set, as
 * cmux's own hooks pass it. Global flags go ahead of the subcommand, so the
 * socket comes first and the caller's own (`--json`, …) follow it.
 */
export function cmuxArgv(env: EnvLike, args: readonly string[]): string[] {
  const socket = env.CMUX_SOCKET_PATH;
  return socket != null && socket !== ''
    ? ['--socket', socket, ...args]
    : [...args];
}

/**
 * The real runner: the binary from resolveCmuxBinary, `--socket` from
 * cmuxArgv, CMUX_QUIET=1, a timeout, a 16 MB buffer. `env` is both what the
 * binary and socket are read from and the child's environment; tests pass a
 * fake one so they can never reach the real cmux.
 *
 * D2, one timer: the CLI's own limit is set 5 s past the kill, so the kill
 * fires first. An env that already names CMUX_CLI_TIMEOUT_ENV keeps its value,
 * so the CLI can give up first, and its stderr counts as timed out too.
 */
export function realCmuxRunner(
  timeoutMs: number = CMUX_TIMEOUT_MS,
  env: EnvLike = process.env,
): CmuxRunner {
  return (args, limit) =>
    new Promise((resolve) => {
      const callMs = limit?.timeoutMs ?? timeoutMs;
      execFile(
        resolveCmuxBinary(env).path,
        cmuxArgv(env, args),
        {
          env: {
            [CMUX_CLI_TIMEOUT_ENV]: String(Math.ceil(callMs / 1000) + 5),
            ...env,
            CMUX_QUIET: '1',
          },
          maxBuffer: 16 * 1024 * 1024,
          timeout: callMs,
        },
        (error, stdout, stderr) => {
          if (error != null) {
            const detail = String(stderr).trim();
            const killed = error.killed === true;
            const cliGaveUp = detail
              .split('\n')
              .some((line) => line.trim() === CMUX_CLI_TIMEOUT_TEXT);
            const how = killed
              ? `timed out after ${callMs} ms`
              : cliGaveUp
                ? "timed out at the cmux CLI's own limit"
                : 'failed';
            resolve({
              kind: 'failed',
              reason: `cmux ${args.slice(0, 3).join(' ')} ${how}: ${detail !== '' ? detail : error.message}`,
              timedOut: killed || cliGaveUp,
            });
            return;
          }
          resolve({kind: 'ok', stdout: String(stdout)});
        },
      );
    });
}

/** D3: the wait before each retry of a timed-out read. */
export const GATE_CMUX_BACKOFF_MS = [5_000, 10_000, 20_000] as const;

export interface GateCmuxOptions {
  /** Waits before each retry; default GATE_CMUX_BACKOFF_MS. */
  backoffMs?: readonly number[];
  /** No call starts at or after this time, and none runs past it. */
  deadlineAtMs: number;
  now: () => number;
  /** Retry a timed-out read? False: the deadline bounds the calls, no more. */
  retry: boolean;
  sleep: (ms: number) => Promise<void>;
}

/**
 * home-base-89c8h.1 D3: a runner for the handoff gate. Each attempt's limit is
 * the smaller of CMUX_TIMEOUT_MS and the time left. Past the deadline it runs
 * nothing and answers failed, timed out. With `retry` it retries a call only
 * when the call timed out AND cmuxCallIsReadOnly says it reads. Any other
 * failure returns at once. A write is never retried: a timed-out write may
 * have happened, and a retry could open a second tab.
 */
export function gateCmuxRunner(
  run: CmuxRunner,
  options: GateCmuxOptions,
): CmuxRunner {
  const {deadlineAtMs, now, retry, sleep} = options;
  const backoffMs = options.backoffMs ?? GATE_CMUX_BACKOFF_MS;
  return async (args) => {
    for (let attempt = 0; ; attempt += 1) {
      const left = deadlineAtMs - now();
      if (left <= 0) {
        return {
          kind: 'failed',
          reason: `cmux ${args.slice(0, 3).join(' ')} did not run: the handoff gate's time for cmux is used up`,
          timedOut: true,
        };
      }
      const call = await run(args, {
        timeoutMs: Math.min(CMUX_TIMEOUT_MS, left),
      });
      if (call.kind === 'ok' || !call.timedOut) return call;
      if (!retry || !cmuxCallIsReadOnly(args)) return call;
      const wait = backoffMs[attempt];
      // A wait that ends at or past the deadline could run nothing after it.
      if (wait == null || deadlineAtMs - now() <= wait) return call;
      await sleep(wait);
    }
  };
}

const treeSchema = z.object({
  windows: z.array(
    z.object({
      id: z.string(),
      ref: z.string(),
      workspaces: z.array(
        z.object({
          id: z.string(),
          panes: z.array(
            z.object({surfaces: z.array(z.object({id: z.string()}))}),
          ),
          // home-base-yukaf.31: `thread close workspace:N` and its Title line.
          // Measured 2026-10-20: every workspace carries both.
          ref: z.string().nullish(),
          title: z.string().nullish(),
        }),
      ),
    }),
  ),
});

const workspaceListSchema = z.object({
  workspaces: z.array(
    z.object({custom_title: z.string().nullable(), id: z.string()}),
  ),
});

export interface CmuxTree {
  windows: {
    id: string;
    ref: string;
    workspaces: {
      id: string;
      /** `workspace:N`; null when the tree did not carry one. */
      ref: string | null;
      surfaceIds: string[];
      /** The title cmux shows for it; null when the tree did not carry one. */
      title: string | null;
    }[];
  }[];
}

export type CmuxTreeRead =
  | {kind: 'read'; tree: CmuxTree}
  | {kind: 'unreadable'; reason: string};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The argv after `cmux` that readCmuxTree runs. */
export const CMUX_TREE_ARGS = [
  '--json',
  '--id-format',
  'both',
  'tree',
  '--all',
] as const;

/**
 * The output of `cmux <CMUX_TREE_ARGS>` parsed; for a caller that runs it
 * itself (the threads TUI runs commands synchronously, home-base-ys9t7.9.1).
 */
export function parseCmuxTree(stdout: string): CmuxTreeRead {
  const args = CMUX_TREE_ARGS;
  const parsed = treeSchema.safeParse(parseJson(stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  return {
    kind: 'read',
    tree: {
      windows: parsed.data.windows.map((window) => ({
        id: window.id,
        ref: window.ref,
        workspaces: window.workspaces.map((workspace) => ({
          id: workspace.id,
          ref: workspace.ref ?? null,
          surfaceIds: workspace.panes.flatMap((pane) =>
            pane.surfaces.map((surface) => surface.id),
          ),
          title: workspace.title ?? null,
        })),
      })),
    },
  };
}

/** Every window, workspace and surface, by uuid. */
export async function readCmuxTree(run: CmuxRunner): Promise<CmuxTreeRead> {
  const call = await run(CMUX_TREE_ARGS);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  return parseCmuxTree(call.stdout);
}

/** The workspace that holds a surface now, or null when no workspace does. */
export function workspaceOfSurface(
  tree: CmuxTree,
  surfaceId: string,
): string | null {
  const want = surfaceId.toUpperCase();
  for (const window of tree.windows) {
    for (const workspace of window.workspaces) {
      if (workspace.surfaceIds.some((id) => id.toUpperCase() === want)) {
        return workspace.id;
      }
    }
  }
  return null;
}

/**
 * Every surface a workspace holds now; null when the tree has no such
 * workspace (not the same fact as a workspace holding no surface).
 */
export function surfacesOfWorkspace(
  tree: CmuxTree,
  workspaceId: string,
): string[] | null {
  const want = workspaceId.toUpperCase();
  for (const window of tree.windows) {
    const found = window.workspaces.find(
      (workspace) => workspace.id.toUpperCase() === want,
    );
    if (found != null) return found.surfaceIds;
  }
  return null;
}

function windowOfWorkspace(tree: CmuxTree, workspaceId: string): string | null {
  const want = workspaceId.toUpperCase();
  const window = tree.windows.find((entry) =>
    entry.workspaces.some((workspace) => workspace.id.toUpperCase() === want),
  );
  return window?.ref ?? null;
}

/** Whether a workspace uuid is open in any window. */
export function workspaceExists(tree: CmuxTree, workspaceId: string): boolean {
  return windowOfWorkspace(tree, workspaceId) != null;
}

/**
 * A workspace's custom_title now. `null` is a measured "no custom title";
 * `unreadable` and `notFound` are different facts and must never be read as
 * null (D5: that confusion would overwrite Justin's name).
 */
export type WorkspaceTitleRead =
  | {customTitle: string | null; kind: 'read'}
  | {kind: 'notFound'; reason: string}
  | {kind: 'unreadable'; reason: string};

export async function readWorkspaceTitle(
  run: CmuxRunner,
  tree: CmuxTree,
  workspaceId: string,
): Promise<WorkspaceTitleRead> {
  const windowRef = windowOfWorkspace(tree, workspaceId);
  if (windowRef == null) {
    return {
      kind: 'notFound',
      reason: `no open cmux workspace has id ${workspaceId}`,
    };
  }
  const args = ['--json', 'workspace', 'list', '--window', windowRef];
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = workspaceListSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  const want = workspaceId.toUpperCase();
  const found = parsed.data.workspaces.find(
    (entry) => entry.id.toUpperCase() === want,
  );
  if (found == null) {
    return {
      kind: 'notFound',
      reason: `workspace ${workspaceId} is not in cmux's list for ${windowRef}`,
    };
  }
  return {customTitle: found.custom_title, kind: 'read'};
}

export type WindowWorkspacesRead =
  | {kind: 'read'; workspaces: {customTitle: string | null; id: string}[]}
  | {kind: 'unreadable'; reason: string};

/** Every workspace of one window with its custom_title, in one call (the preview). */
export async function readWindowWorkspaces(
  run: CmuxRunner,
  windowRef: string,
): Promise<WindowWorkspacesRead> {
  const args = ['--json', 'workspace', 'list', '--window', windowRef];
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = workspaceListSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  return {
    kind: 'read',
    workspaces: parsed.data.workspaces.map((entry) => ({
      customTitle: entry.custom_title,
      id: entry.id,
    })),
  };
}

const workspacePanesSchema = z.object({
  windows: z.array(
    z.object({
      workspaces: z.array(
        z.object({
          id: z.string(),
          panes: z.array(
            z.object({
              id: z.string(),
              ref: z.string().nullish(),
              surfaces: z.array(
                z.object({id: z.string(), ref: z.string().nullish()}),
              ),
            }),
          ),
          ref: z.string().nullish(),
        }),
      ),
    }),
  ),
});

/** The pane that holds a surface: found, absent, or not readable (rule 7). */
export type PaneOfSurfaceRead =
  | {kind: 'found'; paneId: string; paneRef: string | null}
  | {kind: 'notFound'; reason: string}
  | {kind: 'unreadable'; reason: string; timedOut: boolean};

/**
 * home-base-mbnjv.2: the pane that holds `surfaceId` inside `workspaceId`,
 * read-only, so a successor tab opens beside its caller (epic C5).
 *
 * Measured 2026-10-29 on cmux 0.64.24, in a throwaway workspace: `cmux --json
 * --id-format both tree --workspace <id>` lists that workspace's panes, each
 * with its uuid and its surfaces' uuids. `cmux identify --surface <id>` names
 * the pane too, but for a surface that does not exist it exits 0 with
 * `caller: null` beside a `focused` block naming ANOTHER pane: a reader that
 * fell back to `focused` would open the successor beside the wrong tab. The
 * tree also proves the surface is in the caller's workspace.
 */
export async function readPaneOfSurface(
  run: CmuxRunner,
  workspaceId: string,
  surfaceId: string,
): Promise<PaneOfSurfaceRead> {
  const args = ['--json', '--id-format', 'both', 'tree'];
  args.push('--workspace', workspaceId);
  const call = await run(args);
  if (call.kind === 'failed') {
    return {kind: 'unreadable', reason: call.reason, timedOut: call.timedOut};
  }
  const parsed = workspacePanesSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
      timedOut: false,
    };
  }
  const wantWorkspace = workspaceId.toUpperCase();
  const wantSurface = surfaceId.toUpperCase();
  const workspace = parsed.data.windows
    .flatMap((window) => window.workspaces)
    .find((entry) => entry.id.toUpperCase() === wantWorkspace);
  if (workspace == null) {
    return {
      kind: 'notFound',
      reason: `no open cmux workspace has id ${workspaceId}`,
    };
  }
  const pane = workspace.panes.find((entry) =>
    entry.surfaces.some((surface) => surface.id.toUpperCase() === wantSurface),
  );
  if (pane == null) {
    return {
      kind: 'notFound',
      reason: `surface ${surfaceId} is not in workspace ${workspaceId}`,
    };
  }
  return {kind: 'found', paneId: pane.id, paneRef: pane.ref ?? null};
}

/** A surface's uuid, read from its short ref: found, absent, or not readable. */
export type SurfaceIdRead =
  | {kind: 'found'; surfaceId: string}
  | {kind: 'notFound'; reason: string}
  | {kind: 'unreadable'; reason: string};

/**
 * home-base-mbnjv.4: the uuid of the tab `new-surface` named by its ref
 * ("surface:306"), inside `workspaceId`, read-only, so the tombstone's focus
 * command names the successor's tab by uuid (refs resolve in a window
 * context; uuids do not need one). Same tree read as readPaneOfSurface.
 */
export async function readSurfaceIdOfRef(
  run: CmuxRunner,
  workspaceId: string,
  surfaceRef: string,
): Promise<SurfaceIdRead> {
  const args = ['--json', '--id-format', 'both', 'tree'];
  args.push('--workspace', workspaceId);
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = workspacePanesSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  const want = workspaceId.toUpperCase();
  const surface = parsed.data.windows
    .flatMap((window) => window.workspaces)
    .filter((entry) => entry.id.toUpperCase() === want)
    .flatMap((entry) => entry.panes)
    .flatMap((pane) => pane.surfaces)
    .find((entry) => entry.ref === surfaceRef);
  if (surface == null) {
    return {
      kind: 'notFound',
      reason: `no tab ${surfaceRef} in workspace ${workspaceId}`,
    };
  }
  return {kind: 'found', surfaceId: surface.id};
}

/**
 * The one tab of a workspace: found, no such workspace or no tab, several
 * tabs, or not readable (rule 7: four different facts).
 */
export type SoleSurfaceRead =
  | {
      kind: 'found';
      surfaceId: string;
      /** `surface:N`; null when the tree did not carry one. */
      surfaceRef: string | null;
      workspaceId: string;
    }
  | {count: number; kind: 'several'; reason: string}
  | {kind: 'notFound'; reason: string}
  | {kind: 'unreadable'; reason: string};

/**
 * home-base-edf4y D1: the tab `thread spawn` opened. `new-workspace` answers
 * only "OK workspace:N", and `read-screen` without --surface reads
 * $CMUX_SURFACE_ID, the CALLER's tab, which may itself show Claude Code's
 * input box; so the new workspace's tab is looked up here, read-only, with the
 * same tree read as readPaneOfSurface. `workspace` is its uuid or its
 * `workspace:N` ref. A new workspace opened without --layout holds one tab;
 * any other count is reported, never guessed at.
 */
export async function readSoleSurfaceOfWorkspace(
  run: CmuxRunner,
  workspace: string,
): Promise<SoleSurfaceRead> {
  const args = ['--json', '--id-format', 'both', 'tree'];
  args.push('--workspace', workspace);
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = workspacePanesSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  const wantId = workspace.toUpperCase();
  const found = parsed.data.windows
    .flatMap((window) => window.workspaces)
    .find(
      (entry) => entry.id.toUpperCase() === wantId || entry.ref === workspace,
    );
  if (found == null) {
    return {
      kind: 'notFound',
      reason: `no open cmux workspace is ${workspace}`,
    };
  }
  const surfaces = found.panes.flatMap((pane) => pane.surfaces);
  const [only] = surfaces;
  if (only == null) {
    return {
      kind: 'notFound',
      reason: `workspace ${workspace} holds no tab`,
    };
  }
  if (surfaces.length > 1) {
    return {
      count: surfaces.length,
      kind: 'several',
      reason: `workspace ${workspace} holds ${surfaces.length} tabs, not one, so which one runs claude is not known`,
    };
  }
  return {
    kind: 'found',
    surfaceId: only.id,
    surfaceRef: only.ref ?? null,
    workspaceId: found.id,
  };
}

/** Set a workspace's name, by uuid; `--` because a name may start with "-". */
export function renameWorkspace(
  run: CmuxRunner,
  workspaceId: string,
  name: string,
): Promise<CmuxCall> {
  return run(['rename-workspace', '--workspace', workspaceId, '--', name]);
}

/**
 * Set one tab's title (home-base-mbnjv.3, D8): `cmux rename-tab --workspace
 * <id> --surface <id> -- <title>`. Both ids are always passed: without
 * --surface cmux renames $CMUX_SURFACE_ID or the focused tab, and without
 * --workspace it resolves in the caller's workspace.
 */
export function renameTab(
  run: CmuxRunner,
  workspaceId: string,
  surfaceId: string,
  title: string,
): Promise<CmuxCall> {
  return run([
    'rename-tab',
    '--workspace',
    workspaceId,
    '--surface',
    surfaceId,
    '--',
    title,
  ]);
}

const workspaceStateSchema = z.object({
  windows: z.array(
    z.object({
      workspaces: z.array(
        z.object({
          // Absent is not null: an absent key is a cmux that cannot say.
          description: z.string().nullable().optional(),
          id: z.string(),
          panes: z.array(
            z.object({surfaces: z.array(z.object({id: z.string()}))}),
          ),
          title: z.string().nullish(),
        }),
      ),
    }),
  ),
});

/**
 * One workspace as the description sync needs it. `null` is a measured "no
 * description"; `notFound` and `unreadable` are different facts and must never
 * read as null (home-base-jm5kg.18: a failed read never blanks a description).
 */
export type WorkspaceStateRead =
  | {
      description: string | null;
      kind: 'read';
      surfaceIds: string[];
      title: string | null;
    }
  | {kind: 'notFound'; reason: string}
  | {kind: 'unreadable'; reason: string};

/**
 * Measured 2026-11-06 on cmux 0.64.24: `cmux --json --id-format both tree
 * --workspace <id>` gives the workspace its `description` (string or null),
 * its title and its surfaces, in one call.
 */
export async function readWorkspaceState(
  run: CmuxRunner,
  workspaceId: string,
): Promise<WorkspaceStateRead> {
  const args = ['--json', '--id-format', 'both', 'tree'];
  args.push('--workspace', workspaceId);
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = workspaceStateSchema.safeParse(parseJson(call.stdout));
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed JSON this code cannot read: ${parsed.error.issues[0]?.message ?? 'not JSON'}`,
    };
  }
  const want = workspaceId.toUpperCase();
  const found = parsed.data.windows
    .flatMap((window) => window.workspaces)
    .find((entry) => entry.id.toUpperCase() === want);
  if (found == null) {
    return {
      kind: 'notFound',
      reason: `no open cmux workspace has id ${workspaceId}`,
    };
  }
  if (found.description === undefined) {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} did not report a description for ${workspaceId}, so what it holds is not known`,
    };
  }
  return {
    description: found.description,
    kind: 'read',
    surfaceIds: found.panes.flatMap((pane) =>
      pane.surfaces.map((surface) => surface.id),
    ),
    title: found.title ?? null,
  };
}

/** Set a workspace's description, by uuid (without --workspace: the caller's). */
export function setWorkspaceDescription(
  run: CmuxRunner,
  workspaceId: string,
  description: string,
): Promise<CmuxCall> {
  return run([
    'workspace-action',
    '--action',
    'set-description',
    '--workspace',
    workspaceId,
    '--description',
    description,
  ]);
}

/** Reset a workspace's description to none, by uuid. */
export function clearWorkspaceDescription(
  run: CmuxRunner,
  workspaceId: string,
): Promise<CmuxCall> {
  return run([
    'workspace-action',
    '--action',
    'clear-description',
    '--workspace',
    workspaceId,
  ]);
}

/** Reset a workspace's name to none (custom_title null), by uuid. */
export function clearWorkspaceName(
  run: CmuxRunner,
  workspaceId: string,
): Promise<CmuxCall> {
  return run([
    'workspace-action',
    '--action',
    'clear-name',
    '--workspace',
    workspaceId,
  ]);
}
