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

export type CmuxCall =
  | {kind: 'failed'; reason: string}
  | {kind: 'ok'; stdout: string};

/** Runs `cmux <args>`. Injected so tests never reach the real cmux. */
export type CmuxRunner = (args: readonly string[]) => Promise<CmuxCall>;

export const CMUX_TIMEOUT_MS = 4000;

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
 */
export function realCmuxRunner(
  timeoutMs: number = CMUX_TIMEOUT_MS,
  env: EnvLike = process.env,
): CmuxRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        resolveCmuxBinary(env).path,
        cmuxArgv(env, args),
        {
          env: {...env, CMUX_QUIET: '1'},
          maxBuffer: 16 * 1024 * 1024,
          timeout: timeoutMs,
        },
        (error, stdout, stderr) => {
          if (error != null) {
            const detail = String(stderr).trim();
            const timedOut = error.killed === true;
            resolve({
              kind: 'failed',
              reason: `cmux ${args.slice(0, 3).join(' ')} ${timedOut ? `timed out after ${timeoutMs} ms` : 'failed'}: ${detail !== '' ? detail : error.message}`,
            });
            return;
          }
          resolve({kind: 'ok', stdout: String(stdout)});
        },
      );
    });
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
    workspaces: {id: string; surfaceIds: string[]}[];
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

/** Every window, workspace and surface, by uuid. */
export async function readCmuxTree(run: CmuxRunner): Promise<CmuxTreeRead> {
  const args = ['--json', '--id-format', 'both', 'tree', '--all'];
  const call = await run(args);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  const parsed = treeSchema.safeParse(parseJson(call.stdout));
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
          surfaceIds: workspace.panes.flatMap((pane) =>
            pane.surfaces.map((surface) => surface.id),
          ),
        })),
      })),
    },
  };
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

/** Set a workspace's name, by uuid; `--` because a name may start with "-". */
export function renameWorkspace(
  run: CmuxRunner,
  workspaceId: string,
  name: string,
): Promise<CmuxCall> {
  return run(['rename-workspace', '--workspace', workspaceId, '--', name]);
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
