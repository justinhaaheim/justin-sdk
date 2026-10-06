/**
 * The async half of repo-status's session views: `status --sessions` and
 * `repo-status repos` (home-base-39co9.5; first built as `justin-sdk
 * forensics`, home-base-lj3x9).
 *
 * REACHED BY `await import` ONLY (home-base-wxa4c D-W1). sessions.ts pulls in
 * thread/backfill.ts and with it thread/schema.ts, which imports zod, and
 * repo-status.ts is imported eagerly by cli.ts — the entry for the hooks that
 * run on every prompt. Anything repo-status.ts imported statically from here
 * would be paid on every one of them; tests/health-notices-cli.test.ts fails
 * the moment zod becomes statically reachable from cli.ts.
 */

import type {SessionsSection} from './views';

import {homedir} from 'os';
import {join, resolve} from 'path';

import {outputStyle} from '../cli-style';
import {readRepoGlance, type RepoGlance} from './checkouts';
import {scanRepoSessions, summarizeRepos} from './sessions';
import {renderRepos} from './views';

/** `~` and `~/x` expanded, then made absolute. `--root` defaults to `~/Dev`. */
export function expandRoot(root: string): string {
  if (root === '~') return homedir();
  if (root.startsWith('~/')) return join(homedir(), root.slice(2));
  return resolve(root);
}

/** A window or a cap must be a positive number; anything else is a usage error. */
export function positiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got ${value}`);
  }
  return value;
}

/** Every session of one repo in the window, ready to render or serialise. */
export async function scanSessionsSection(options: {
  chars: number;
  days: number;
  now: Date;
  repoRoot: string;
}): Promise<SessionsSection> {
  const days = positiveNumber('days', options.days);
  const scan = await scanRepoSessions({
    days,
    now: options.now,
    repoRoot: options.repoRoot,
  });
  return {
    chars: options.chars,
    days,
    failures: scan.failures,
    sessions: scan.sessions,
    threads: scan.threads,
    windowStart: scan.windowStart,
  };
}

/**
 * The section as JSON. The thread index is a Map, which JSON.stringify would
 * turn into `{}` — an empty object reading as "no threads" — so only whether it
 * was readable is carried; each session carries its own thread.
 */
export function sessionsJson(section: SessionsSection): object {
  return {
    chars: section.chars,
    days: section.days,
    failures: section.failures,
    sessions: section.sessions,
    threads: section.threads.ok
      ? {ok: true}
      : {error: section.threads.error, ok: false},
    windowStart: section.windowStart,
  };
}

interface ReposArgs {
  days: number;
  json: boolean;
  root: string;
}

/** `repo-status repos`: every repo with a session in the window. */
export async function runRepos(args: ReposArgs): Promise<number> {
  const days = positiveNumber('days', args.days);
  const now = new Date();
  const root = expandRoot(args.root);
  const scan = await scanRepoSessions({days, now});
  const {outsideRoot, summaries, unplaced} = summarizeRepos(
    scan.sessions,
    scan.threads.ok,
    root,
  );
  // Only a repo git could place gets a glance: a `path`-resolved root is a
  // directory that is gone or not a repo, and reading it would only fail.
  const glances = new Map<string, RepoGlance>();
  for (const summary of summaries) {
    if (summary.repoResolvedBy === 'git') {
      glances.set(summary.repoRoot, readRepoGlance(summary.repoRoot));
    }
  }
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          days,
          failures: scan.failures,
          outsideRoot,
          repos: summaries.map((summary) => ({
            ...summary,
            primaryCheckout: glances.get(summary.repoRoot) ?? null,
          })),
          root,
          threads: scan.threads.ok
            ? {ok: true}
            : {error: scan.threads.error, ok: false},
          unplacedSessions: unplaced,
          windowStart: scan.windowStart,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(
    renderRepos(
      {
        days,
        failures: scan.failures,
        glances,
        now,
        outsideRoot,
        root,
        summaries,
        threads: scan.threads,
        unplaced,
      },
      outputStyle(),
    ),
  );
  return 0;
}
