/**
 * `componentConfig.thread.spawn` (home-base-11ya7.9): whether `thread spawn`
 * may run in this repo at all. One field, `allowed`, default false.
 *
 * Built like handoff-knob.ts: the field resolves through the thread knobs'
 * layering, DEFAULT ← user file ← project file, so a project file that says
 * `allowed: false` wins over a user file that says true. A value of the wrong
 * shape is NAMED in the config problems and ignored, so it never reads as a
 * deliberate setting. The zod schema in sdk-config.ts rejects most bad shapes
 * first (which costs the whole file); this walk is the second line.
 *
 * zod-free on purpose: thread/config.ts imports it.
 */

import type {ThreadConfigSource} from './config';

import {SPAWN_DEFAULTS} from './defaults';

export interface ResolvedSpawnConfig {
  /**
   * False: `thread spawn` refuses with exit 2 and opens nothing, dry run
   * included. Only the repo the mayor runs in (home-base) turns it on.
   */
  allowed: boolean;
  allowedSource: ThreadConfigSource;
}

/** One config layer's `componentConfig.thread.spawn`, as read (any shape). */
export interface SpawnLayer {
  name: ThreadConfigSource;
  section: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the spawn block from the layers, lowest first (user, then project).
 * Problems are appended to `problems`, the caller's list.
 */
export function resolveSpawnConfig(
  layers: readonly SpawnLayer[],
  problems: string[],
): ResolvedSpawnConfig {
  let allowed: boolean = SPAWN_DEFAULTS.allowed;
  let allowedSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    if (layer.section === undefined) continue;
    if (!isObject(layer.section)) {
      problems.push(
        `componentConfig.thread.spawn in the ${layer.name} config is ${JSON.stringify(layer.section)}, which is not an object — ignoring it.`,
      );
      continue;
    }
    const raw = layer.section.allowed;
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      problems.push(
        `componentConfig.thread.spawn.allowed in the ${layer.name} config is ${JSON.stringify(raw)}, which is not true or false — ignoring it and using ${JSON.stringify(allowed)}.`,
      );
      continue;
    }
    allowed = raw;
    allowedSource = layer.name;
  }
  return {allowed, allowedSource};
}
