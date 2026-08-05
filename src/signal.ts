/**
 * Signal — runs project checks discovered from package.json scripts.
 *
 * Scans package.json for scripts matching the `signal-source:LABEL` pattern
 * and runs them via check-runner. The label after the colon becomes the
 * check label in the output.
 *
 * Example package.json:
 *   "signal-source:TS": "tsc --noEmit",
 *   "signal-source:LINT": "eslint .",
 *   "signal-source:PRETTIER": "prettier --check ."
 *
 * Before any of that, an UNHYDRATED-WORKTREE PREFLIGHT runs (D3). A fresh git
 * worktree has no node_modules, so the checks would fail loudly in files the
 * change never touched — signal must name that cause instead of relaying the
 * phantom failures. Problems that CANNOT corrupt check results only warn and let
 * the checks run (F7). See src/worktree-hydration.ts.
 */

import type {Check} from './check-runner';

import {runChecks} from './check-runner';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {
  detectWorktreeHydration,
  formatAdvisoryWorktreeWarning,
  formatUnhydratedWorktreeBanner,
  hasBlockingProblem,
} from './worktree-hydration';

const SIGNAL_SOURCE_PREFIX = 'signal-source:';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignalOptions {
  quiet?: boolean;
  serial?: boolean;
}

/**
 * Discover and run signal checks from package.json signal-source:* scripts.
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Signal options (quiet, serial)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runSignal(
  projectRoot: string = process.cwd(),
  options: SignalOptions = {},
): Promise<number> {
  // PREFLIGHT, before any check is discovered or run. An unhydrated worktree
  // produces ~10 type/lint errors in files the change never touched, blaming the
  // wrong code — so relaying them is WORSE than printing nothing. Naming the
  // real cause is the entire value here. Costs one `stat` in a primary
  // checkout, where the node is inert.
  //
  // TWO OUTCOMES, split by whether the problem can corrupt CHECK RESULTS (F7):
  //   BLOCKING (node_modules) — the checks would lie, so they must not run.
  //   ADVISORY (.worktreeinclude, mise) — real gaps that may break a BUILD but
  //     cannot make `signal` lie, so warn and run. Blocking on these would make
  //     `signal` unrunnable, with no override, in a tree where it works fine.
  const hydration = detectWorktreeHydration(projectRoot);
  if (hydration.isLinkedWorktree && hydration.problems.length > 0) {
    if (hasBlockingProblem(hydration)) {
      process.stderr.write(formatUnhydratedWorktreeBanner(hydration));
      return 1;
    }
    process.stderr.write(formatAdvisoryWorktreeWarning(hydration));
  }

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
    if (name.startsWith(SIGNAL_SOURCE_PREFIX)) {
      const label = name.slice(SIGNAL_SOURCE_PREFIX.length);
      if (label) {
        checks.push({label, command});
      }
    }
  }

  if (checks.length === 0) {
    console.error(
      `Error: No signal-source:* scripts found in package.json.\n` +
        `Add scripts like "signal-source:TS": "tsc --noEmit" to define checks.`,
    );
    return 1;
  }

  return runChecks(checks, {
    quiet: options.quiet,
    serial: options.serial,
  });
}
