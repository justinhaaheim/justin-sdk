/**
 * local-fs.ts — the two filesystem helpers the plugin's SessionStart hook needs.
 *
 * WHY THESE LIVE HERE AND NOT IN `setup-helpers` (home-base-qjyj). The
 * marketplace publishes `./src/plugin` as the WHOLE plugin package: at runtime
 * the hook is `<cache>/prime/<version>/hooks/session-start.ts` and nothing
 * outside that subtree exists on disk. Any import that escapes `src/plugin/`
 * therefore resolves to a path that is not there, and the hook dies at import
 * time — silently, because Claude Code classifies the failure as
 * `hook_non_blocking_error` and starts the session anyway. That is exactly how
 * plugin 0.5.0 shipped a hook that injected nothing at all for a week.
 *
 * So these two functions MOVED here (t6a0.21 D14: single source, never a forked
 * copy) and `setup-helpers` re-exports them for its own callers. The direction
 * is deliberate — SDK-side code imports FROM the plugin lib, never the reverse.
 *
 * Everything in this directory must run with plain `bun` and NO node_modules:
 * bun builtins and `bunx` subprocesses only.
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
