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
 */

import type {Check} from './check-runner';

import {runChecks} from './check-runner';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

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
