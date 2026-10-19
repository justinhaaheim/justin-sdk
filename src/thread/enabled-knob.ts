/**
 * `componentConfig.thread.enabled` read from the two config files WITHOUT zod
 * (home-base-yukaf.26).
 *
 * WHY A SECOND READER EXISTS. The `isThreadEnabled` predicate in prime.ts gates
 * the `thread-rules` component, and prime.ts is in the static import graph of
 * cli-main.ts, which every prompt-time hook loads. `resolveThreadConfig`
 * reaches sdk-config.ts, which imports zod statically, and zod costs 12-13 ms
 * against a 40-50 ms startup; tests/health-notices-cli.test.ts fails when zod
 * becomes statically reachable from cli-main.ts. Predicates are synchronous, so
 * the real resolver cannot be `await import`ed there. This file is therefore a
 * LEAF: node builtins, `xdgConfigHome` from health-notices.ts (which loads zod
 * only through `await import`) and the thread defaults.
 *
 * IT MUST AGREE WITH `resolveThreadConfig(...).enabled`, and
 * tests/thread-enabled-knob.test.ts compares the two over a matrix of files.
 * The layering is the same: the default (off), then the user file, then the
 * project file; a missing, unreadable or non-JSON file says nothing; a
 * non-boolean `enabled` says nothing.
 *
 * ONE KNOWN DIFFERENCE. `resolveThreadConfig` drops a file that fails schema
 * validation ANYWHERE (a wrong-typed key in another component's block) as a
 * whole; this reader still reads `enabled` from it. Only a malformed config
 * file can reach that case, and doctor's CONFIG_SCHEMA check already reports
 * one.
 *
 * Also: it reads `<projectRoot>/justin-sdk.config.json` directly, where the
 * resolver walks up from a directory to find the config. The predicate is
 * always given a project root, so the two read the same file.
 */

import type {EnvLike} from './paths';

import {readFileSync} from 'fs';
import {join} from 'path';

import {xdgConfigHome} from '../health-notices';
import {THREAD_CONFIG_KEY, THREAD_DEFAULT_ENABLED} from './defaults';

/** The `enabled` boolean one config file sets, or null when it says nothing. */
function enabledIn(path: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Missing, unreadable or not JSON: this layer contributes nothing, exactly
    // as it contributes nothing to resolveThreadConfig.
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const componentConfig = (parsed as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object') {
    return null;
  }
  const section = (componentConfig as Record<string, unknown>)[
    THREAD_CONFIG_KEY
  ];
  if (section == null || typeof section !== 'object') return null;
  const value = (section as Record<string, unknown>).enabled;
  return typeof value === 'boolean' ? value : null;
}

/** DEFAULT ← user file ← project file, for `enabled` only. */
export function threadEnabledFromFiles(
  projectRoot: string,
  env: EnvLike = process.env,
): boolean {
  let value = THREAD_DEFAULT_ENABLED;
  for (const path of [
    join(xdgConfigHome(env), 'justin-sdk', 'config.json'),
    join(projectRoot, 'justin-sdk.config.json'),
  ]) {
    const read = enabledIn(path);
    if (read != null) value = read;
  }
  return value;
}
