/**
 * Running `br` — the one place the justin-loop shells out to beads.
 *
 * Extracted from the old `src/ralph.ts` (home-base-1r6d.33.2, D1) so that
 * `handoff.ts` (the bead contract) and `runner.ts` (the loop) can both use it
 * without importing each other. Before this split `handoff.ts` imported `runBr`
 * from `ralph.ts`, and the runner now needs `parseHandoff` from `handoff.ts` —
 * which would have been a cycle.
 */
import {spawnSync} from 'node:child_process';

export interface BrOutcome {
  ok: boolean;
  /** Why it failed, in ONE line. null when ok — never an empty string. */
  reason: string | null;
  /**
   * Everything `br` wrote to stderr, trimmed (home-base-685h F4).
   *
   * `reason` is the first line only, which is the right size for a summary and
   * the wrong size for a diagnosis: br's real failures run to several lines (a
   * clap usage block, a Dolt error with its context, the auto-export warnings
   * followed by the actual error), and the D14 close-failure print showed the
   * first of them and threw the rest away.
   *
   * null when br printed NOTHING to stderr — never `''`. An empty string would
   * say br produced an empty diagnostic, which is a different fact from having
   * produced none at all (critical rule 7, and the null rule).
   */
  stderr: string | null;
  stdout: string;
}

/** How many lines of a failed call's stderr are worth printing. */
export const BR_STDERR_LINES = 5;

/** Trimmed stderr, or null when there was none. Never `''`. */
function capturedStderr(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The lines of a failed call's stderr that `reason` does NOT already carry.
 *
 * Callers print `reason` first, so line 1 would be a duplicate; this returns
 * lines 2..`max`, plus a count of anything past the bound rather than trailing
 * off silently. Empty when br said one line or nothing — so a caller can print
 * it unconditionally and a single-line failure looks exactly as it did before.
 */
export function brFailureDetail(
  out: BrOutcome,
  max: number = BR_STDERR_LINES,
): string[] {
  if (out.stderr == null) return [];
  const rest = out.stderr.split('\n').slice(1);
  if (rest.length === 0) return [];
  const shown = rest.slice(0, Math.max(0, max - 1));
  const hidden = rest.length - shown.length;
  return hidden > 0
    ? [...shown, `… and ${hidden} more line${hidden === 1 ? '' : 's'} from br`]
    : shown;
}

export type BrRunner = (cwd: string, args: string[]) => BrOutcome;

/**
 * Run `br`, injectable so every caller is testable without a beads workspace.
 *
 * `--no-auto-import` on EVERY call, reads included: br's auto-import runs a real
 * `git merge origin/main` in the working directory (home-base c2u5 — a merge
 * that "appeared out of nowhere" in a worktree). A loop runner that quietly
 * merged into someone's branch mid-session would be far worse than a stale bead
 * list. MEASURED: accepted by br 0.1.37 and br 0.4.1 alike.
 */
export function runBr(cwd: string, args: string[]): BrOutcome {
  const proc = spawnSync('br', [...args, '--no-auto-import'], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  const stderr = capturedStderr(proc.stderr);
  if (proc.error != null) {
    return {
      ok: false,
      reason: `br could not run: ${proc.error.message}`,
      stderr,
      stdout: '',
    };
  }
  if (proc.status !== 0) {
    const firstStderrLine = stderr?.split('\n')[0] ?? '';
    const how =
      proc.status != null
        ? `exited ${proc.status}`
        : `was killed (${proc.signal ?? 'unknown signal'})`;
    return {
      ok: false,
      reason: `br ${how}${firstStderrLine !== '' ? `: ${firstStderrLine}` : ''}`,
      stderr,
      stdout: '',
    };
  }
  // A SUCCESSFUL call's stderr is kept too: br writes its auto-export warnings
  // there and exits 0, and a caller that wants to show them should not have to
  // run the command again to see them.
  return {ok: true, reason: null, stderr, stdout: proc.stdout ?? ''};
}
