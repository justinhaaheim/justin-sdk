/**
 * Where worktree-salvage writes (epic home-base-us739, D4).
 *
 * Modelled on home-base's `scripts/cmux-capture.ts`: the destination is
 * configuration, never code, so no machine's path is baked in. In order:
 *
 *   1. `--out <dir>` for one run              source "flag"
 *   2. `outDir` in the config file            source "config"
 *   3. `$XDG_DATA_HOME/worktree-salvage`      source "fallback", NOT backed up
 *
 * A CONFIG FILE THAT EXISTS BUT CANNOT BE USED THROWS. It is never a reason to
 * fall back: writing somewhere other than the configured (backed-up) folder and
 * reporting the save as done is the failure that looks like success. The same
 * holds for a destination that cannot be written to: the save fails, it does
 * not look for somewhere else.
 *
 * The SDK never creates the config file. On Justin's machine it is written by
 * hand (dispatch 3 of the epic), pointing at a backed-up folder.
 */

import {existsSync, readFileSync} from 'fs';
import {homedir} from 'os';
import {isAbsolute, join, resolve} from 'path';
import {z} from 'zod';

export type DestinationSource = 'config' | 'fallback' | 'flag';

export interface Destination {
  /** The config file consulted (whether or not it exists), for the printout. */
  configFile: string;
  /** Absolute directory the archive lives in. */
  dir: string;
  source: DestinationSource;
}

/** The environment the paths come from. `process.env` satisfies it. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

const ConfigSchema = z.object({outDir: z.string().trim().min(1)});

function home(env: ConfigEnv): string {
  const fromEnv = env.HOME;
  return fromEnv != null && fromEnv !== '' ? fromEnv : homedir();
}

function xdgDir(
  env: ConfigEnv,
  name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME',
  fallback: string,
): string {
  const value = env[name];
  return value != null && value !== '' ? value : join(home(env), fallback);
}

/** `$XDG_CONFIG_HOME/worktree-salvage/config.json` (default `~/.config/…`). */
export function configFilePath(env: ConfigEnv = process.env): string {
  return join(
    xdgDir(env, 'XDG_CONFIG_HOME', '.config'),
    'worktree-salvage',
    'config.json',
  );
}

/** `$XDG_DATA_HOME/worktree-salvage` (default `~/.local/share/…`). */
export function fallbackDir(env: ConfigEnv = process.env): string {
  return join(xdgDir(env, 'XDG_DATA_HOME', '.local/share'), 'worktree-salvage');
}

function expandHome(path: string, env: ConfigEnv): string {
  if (path === '~') return home(env);
  return path.startsWith('~/') ? join(home(env), path.slice(2)) : path;
}

/**
 * Resolve the destination. `flag` is `--out` (null when not given), resolved
 * against `cwd` when relative. THROWS when the config file exists but cannot be
 * read, is not JSON, has no non-empty string `outDir`, or names a relative path.
 */
export function resolveDestination(
  flag: string | null,
  options: {cwd?: string; env?: ConfigEnv} = {},
): Destination {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configFile = configFilePath(env);
  if (flag != null && flag.trim() !== '') {
    return {
      configFile,
      dir: resolve(cwd, expandHome(flag.trim(), env)),
      source: 'flag',
    };
  }
  if (!existsSync(configFile)) {
    return {configFile, dir: fallbackDir(env), source: 'fallback'};
  }
  let text: string;
  try {
    text = readFileSync(configFile, 'utf-8');
  } catch (error) {
    throw new Error(
      `${configFile} exists but could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${configFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const checked = ConfigSchema.safeParse(parsed);
  if (!checked.success) {
    throw new Error(
      `${configFile} needs a non-empty string "outDir" (e.g. {"outDir": "~/Dropbox/Data/worktree-salvage"})`,
    );
  }
  const dir = expandHome(checked.data.outDir, env);
  if (!isAbsolute(dir)) {
    throw new Error(
      `${configFile} names a relative outDir "${checked.data.outDir}"; use an absolute path or one starting with ~/`,
    );
  }
  return {configFile, dir, source: 'config'};
}

/** One line saying where the destination came from, for every printout (D4). */
export function describeDestinationSource(destination: Destination): string {
  switch (destination.source) {
    case 'config': {
      return `config (${destination.configFile})`;
    }
    case 'flag': {
      return '--out, for this run only';
    }
    case 'fallback': {
      return `fallback, NOT BACKED UP: no config at ${destination.configFile}`;
    }
  }
}
