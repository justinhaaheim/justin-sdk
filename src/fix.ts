/**
 * Fix — runs project code-fixers discovered from package.json scripts.
 *
 * The code-fixing counterpart to `signal`. Where `signal` *checks* code quality
 * (read-only: tsc --noEmit, eslint, prettier --check), `fix` *mutates* code to
 * resolve whatever is auto-fixable (eslint --fix, prettier --write).
 *
 * Deliberately separate from `doctor`: doctor fixes *scaffolding* (configs,
 * deps, instructions in the right places); fix touches *code*.
 *
 * Scans package.json for scripts matching the `fix-source:LABEL` pattern and
 * runs them via check-runner, always in SERIAL (two tools rewriting the same
 * files in parallel would race) and in a deterministic, label-sorted order so
 * formatters run after linters — prettier should have the final say on
 * formatting, and `LINT` sorts before `PRETTIER`.
 *
 * Example package.json:
 *   "fix-source:LINT": "eslint --fix .",
 *   "fix-source:PRETTIER": "prettier --write ."
 */

import type {Check} from './check-runner';

import {runChecks} from './check-runner';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

const FIX_SOURCE_PREFIX = 'fix-source:';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FixOptions {
  quiet?: boolean;
}

/**
 * Discover and run code-fixers from package.json fix-source:* scripts.
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Fix options (quiet)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runFix(
  projectRoot: string = process.cwd(),
  options: FixOptions = {},
): Promise<number> {
  const pkgPath = resolve(projectRoot, 'package.json');

  if (!existsSync(pkgPath)) {
    console.error('Error: package.json not found.');
    return 1;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  const checks: Check[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith(FIX_SOURCE_PREFIX)) {
      const label = name.slice(FIX_SOURCE_PREFIX.length);
      if (label) {
        checks.push({label, command});
      }
    }
  }

  if (checks.length === 0) {
    console.error(
      `Error: No fix-source:* scripts found in package.json.\n` +
        `Add scripts like "fix-source:PRETTIER": "prettier --write ." to define fixers.`,
    );
    return 1;
  }

  // Sort by label for a deterministic order in which formatters run last
  // (e.g. LINT before PRETTIER). Fixers mutate files, so they must run
  // serially regardless of how `signal` is configured.
  checks.sort((a, b) => a.label.localeCompare(b.label));

  return runChecks(checks, {
    quiet: options.quiet,
    serial: true,
  });
}
