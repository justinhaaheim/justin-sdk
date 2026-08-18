/**
 * ts-inputs.ts — "does this repo have any TypeScript to check?" (home-base-gsqz)
 *
 * THE BUG THIS EXISTS FOR: the sweep payload deletes the retired
 * `scripts/setup-env.ts`. In a repo where that was the ONLY `.ts` file (a Rust
 * fork like imessage-exporter; a userscripts repo), the tsconfig's `include` is
 * left matching nothing, `tsc --noEmit` exits 1 with **TS18003 "No inputs were
 * found in config file"**, and the repo's own signal gate goes red. The repo was
 * green before the payload ran, and cannot recover on its own.
 *
 * THREE STATES, NOT TWO (critical rule 5 applied to a checker). "tsc found
 * problems", "tsc had nothing to check", and "tsc could not see the sources that
 * exist" are three different facts:
 *
 *   - exit 0                            → PASS.
 *   - TS18003 and the repo has NO .ts   → NOT APPLICABLE. Reported as its own
 *                                         outcome with its own reason. Never a
 *                                         pass (a pass would hide the third
 *                                         case forever) and never a failure.
 *   - TS18003 and the repo HAS .ts      → FAIL, loudly, unchanged: the include
 *                                         globs are broken, which is exactly the
 *                                         tripwire a blanket "TS18003 is fine"
 *                                         rule would silence.
 *
 * The discrimination CANNOT come from tsc's output — it emits the identical
 * TS18003 text in both of the last two cases. It has to come from the
 * filesystem, which is what `findTypeScriptSources` is for.
 */

import {readdirSync} from 'fs';
import {join, relative} from 'path';

/** tsc's "No inputs were found in config file" diagnostic. */
export const TS_NO_INPUTS_CODE = 'TS18003';

/**
 * Directories that never hold a repo's OWN TypeScript sources. Dot-directories
 * are skipped wholesale (`.git`, `.claude/worktrees` — which are full checkouts
 * of the same repo and would answer for the wrong tree — `.expo`, …), which
 * matches how TypeScript itself resolves `**\/*.ts` include globs.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'Pods',
  'build',
  'dist',
  'target',
  'vendor',
]);

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function isTypeScriptFile(name: string): boolean {
  return TS_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Up to `limit` TypeScript source paths (repo-relative) belonging to this repo.
 *
 * Deliberately ignores the tsconfig's own `include`/`exclude`: the question here
 * is "does TypeScript exist in this repo at all", precisely so a tsconfig that
 * matches none of it can be told apart from a repo that has none.
 */
export function findTypeScriptSources(
  projectRoot: string,
  limit = 1,
): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      // An unreadable directory is not evidence of absence — but it is also not
      // a TypeScript file. Skip it; the caller's verdict stays cautious because
      // "found nothing" only ever downgrades a FAILURE to "not applicable".
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        walk(join(dir, name));
        continue;
      }
      if (entry.isFile() && isTypeScriptFile(name)) {
        found.push(relative(projectRoot, join(dir, name)));
      }
    }
  };

  walk(projectRoot);
  return found;
}

/** A check that measured nothing — neither a pass nor a failure. */
export interface TsNotApplicable {
  reason: string;
}

/**
 * Classify a finished TS check. Returns null to keep normal exit-code handling
 * (including the deliberate FAIL for broken include globs).
 */
export function classifyTsCheckOutcome(args: {
  exitCode: number;
  output: string;
  projectRoot: string;
}): TsNotApplicable | null {
  if (args.exitCode === 0) return null;
  if (!args.output.includes(`error ${TS_NO_INPUTS_CODE}`)) return null;

  const sources = findTypeScriptSources(args.projectRoot, 1);
  if (sources.length > 0) {
    // Sources exist but the config matched none of them — a real, silent
    // misconfiguration. Stay red, with tsc's own message already printed.
    return null;
  }

  return {
    reason:
      'no TypeScript sources in this repo — tsc had nothing to check ' +
      `(${TS_NO_INPUTS_CODE}). Not a pass: nothing was type-checked.`,
  };
}
