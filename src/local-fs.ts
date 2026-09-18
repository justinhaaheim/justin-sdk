/**
 * local-fs.ts — two filesystem helpers with no dependencies but node builtins.
 *
 * WHY THESE ARE NOT SIMPLY IN `setup-helpers`. They were split out for the
 * `prime` plugin (home-base-qjyj), whose published package was `src/plugin`
 * alone: any import escaping that subtree resolved to a path that did not exist
 * in the marketplace cache, and the hook died at import time — silently,
 * because Claude Code classifies that as `hook_non_blocking_error` and starts
 * the session anyway. Plugin 0.5.0 shipped exactly that and injected nothing
 * for a week.
 *
 * THAT CONSTRAINT IS GONE (dchjw.8, D6): the plugin is retired and there is no
 * separate package to escape from. What survives is the ordinary reason to keep
 * them here — `setup-helpers` pulls in a good deal more, and these two are
 * imported by `rules-drift`, which sits on the session-start path. They stay a
 * SINGLE source (t6a0.21 D14, never a forked copy) and `setup-helpers`
 * re-exports them for its own callers. Folding them back is now merely possible
 * rather than forbidden, and nothing depends on it happening.
 */

import {existsSync, readFileSync} from 'fs';
import {dirname, resolve} from 'path';

/**
 * Parse a JSON file, or null.
 *
 * Callers that need to tell "missing" from "unparseable" apart must re-check
 * existence themselves — both are null here, and they are NOT the same fact
 * (see `readSelectedModules`, which does exactly that).
 */
export function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Find the target repo's OWN prettier binary by walking node_modules/.bin
 * upward from `startDir`. Local-only on purpose: a bunx fallback would fetch
 * prettier from the registry on every write in a repo that has none —
 * slow, network-dependent, and formatted with a version the repo never chose.
 */
export function findLocalPrettier(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = resolve(dir, 'node_modules', '.bin', 'prettier');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
