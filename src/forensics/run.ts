/**
 * The handler bodies of `justin-sdk forensics` (home-base-lj3x9).
 *
 * They live here, not in command.ts, so that command.ts can reach them by
 * `await import` only (home-base-wxa4c D-W1). sessions.ts pulls in
 * thread/backfill.ts and with it thread/schema.ts, which imports zod; cli.ts
 * imports command.ts eagerly, and cli.ts is the entry for the hooks that run on
 * every prompt, so anything command.ts imports statically is paid there.
 * thread/command.ts draws the same line for the same reason.
 */

import {homedir} from 'os';
import {join, resolve} from 'path';

import {outputStyle} from '../cli-style';
import {renderRepo, renderRepos} from './render';
import {scanForensicsSessions, summarizeRepos} from './sessions';
import {gitRead, readRepoWorktrees} from './worktrees';

interface ReposArgs {
  days: number;
  json: boolean;
  root: string;
}

/** `~` and `~/x` expanded, then made absolute. `--root` defaults to `~/Dev`. */
export function expandRoot(root: string): string {
  if (root === '~') return homedir();
  if (root.startsWith('~/')) return join(homedir(), root.slice(2));
  return resolve(root);
}

interface RepoArgs {
  chars: number;
  days: number;
  json: boolean;
  path: string;
}

function positiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got ${value}`);
  }
  return value;
}

export async function runForensicsRepos(args: ReposArgs): Promise<number> {
  const days = positiveNumber('days', args.days);
  const now = new Date();
  const root = expandRoot(args.root);
  const scan = await scanForensicsSessions({days, now});
  const {outsideRoot, summaries, unplaced} = summarizeRepos(
    scan.sessions,
    scan.threads.ok,
    root,
  );
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          days,
          failures: scan.failures,
          outsideRoot,
          repos: summaries,
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

export async function runForensicsRepo(args: RepoArgs): Promise<number> {
  const days = positiveNumber('days', args.days);
  const chars = args.chars;
  const target = resolve(args.path);
  const top = gitRead(target, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!top.ok) {
    process.stderr.write(
      `forensics repo: ${target} is not a git repo — ${top.error}\n`,
    );
    return 1;
  }
  const common = top.value.trim();
  const repo = common.endsWith('/.git')
    ? common.slice(0, -'/.git'.length)
    : target;

  const worktrees = readRepoWorktrees(repo);
  const now = new Date();
  const scan = await scanForensicsSessions({days, now, repoRoot: repo});
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseline: worktrees.baseline,
          days,
          failures: [...worktrees.failures, ...scan.failures],
          repo,
          sessions: scan.sessions,
          threads: scan.threads.ok
            ? {ok: true}
            : {error: scan.threads.error, ok: false},
          windowStart: scan.windowStart,
          worktrees: worktrees.worktrees,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(
    renderRepo(
      {
        chars,
        days,
        failures: scan.failures,
        now,
        sessions: scan.sessions,
        threads: scan.threads,
        worktrees,
      },
      outputStyle(),
    ),
  );
  return 0;
}
