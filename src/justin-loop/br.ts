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
  stdout: string;
  /** Why it failed. null when ok — never an empty string. */
  reason: string | null;
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
  if (proc.error != null) {
    return {
      ok: false,
      reason: `br could not run: ${proc.error.message}`,
      stdout: '',
    };
  }
  if (proc.status !== 0) {
    const firstStderrLine = (proc.stderr ?? '').trim().split('\n')[0] ?? '';
    const how =
      proc.status != null
        ? `exited ${proc.status}`
        : `was killed (${proc.signal ?? 'unknown signal'})`;
    return {
      ok: false,
      reason: `br ${how}${firstStderrLine !== '' ? `: ${firstStderrLine}` : ''}`,
      stdout: '',
    };
  }
  return {ok: true, reason: null, stdout: proc.stdout ?? ''};
}
