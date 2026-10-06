/**
 * `justin-sdk forensics` — the repeatable half of the project-forensics skill
 * (home-base-lj3x9).
 *
 * On 2026-09-18 ten investigators each ran about twenty commands per repo to
 * learn the same facts: which sessions ran where, what Justin asked first and
 * last, what Claude said last, which checkouts hold unpushed or uncommitted
 * work, and which beads exist only on a branch. This command gathers them in
 * one read-only pass, so an investigator's budget goes on judgment instead.
 *
 * NOTHING HEAVY IS IMPORTED AT THE TOP OF THIS FILE (home-base-wxa4c D-W1).
 * cli.ts imports this module eagerly, and cli.ts is also the entry for the
 * `time-check` and `usage-check` hooks that run on every prompt. The handler
 * bodies live in run.ts and are reached by `await import` only, because
 * sessions.ts pulls in thread/backfill.ts → thread/schema.ts → zod (12-13ms).
 * tests/health-notices-cli.test.ts fails if zod becomes statically reachable
 * from cli.ts again. thread/command.ts draws the same line.
 */

import type {Argv, CommandModule} from 'yargs';

const DEFAULT_DAYS = 14;
const DEFAULT_CHARS = 400;

const FORENSICS_NARRATIVE = `READ ONLY. Nothing here checks out, fetches, commits or writes a bead. It reads
git, the Claude Code transcripts under ~/.claude/projects, and the thread beads.

LAST ACTIVITY is the transcript's last record, never the file's mtime (cmux's
resume touches old transcripts). A repo is its main checkout: sessions in its
worktrees and subdirectories count toward it.

EXIT 0 when the report printed, even with a "Could not check" section; every
unmeasured fact is named there and never shown as a zero. EXIT 1 when there was
nothing to report on (the path is not a git repo).`;

const REPO_NARRATIVE = `For every checkout: branch, uncommitted files, commits not on the baseline and
baseline commits missing (by commit identity — repo-status proves merges by
content), upstream ("no upstream" means the commits exist on this machine only),
last commit, and open beads that exist only on that branch.

For every session in the window: its thread bead (or "none"), your first and
last message, Claude's last response, and the command that resumes it. Messages
are cut at --chars in this view; --json carries them whole.

Only sessions LAUNCHED in the repo (or its worktrees) are found here. A session
started elsewhere that cd'd in shows up under \`forensics repos\`.`;

export const forensicsCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .epilogue(FORENSICS_NARRATIVE)
      .command(
        'repos',
        'Every repo with a Claude Code session in the window: session count, last activity, and how many sessions recorded a thread report.',
        (yy) =>
          yy
            .epilogue(FORENSICS_NARRATIVE)
            .option('days', {
              default: DEFAULT_DAYS,
              describe: 'Window, by each transcript’s last record',
              type: 'number' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print the summaries as JSON',
              type: 'boolean' as const,
            })
            .option('root', {
              default: '~/Dev',
              describe:
                'Only list repos inside this directory; the rest are counted, not listed. `/` lists everything, including test probes in temp directories',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runForensicsRepos} = await import('./run');
          process.exit(
            await runForensicsRepos({
              days: argv.days,
              json: argv.json,
              root: argv.root,
            }),
          );
        },
      )
      .command(
        'repo <path>',
        'One repo: every checkout’s git state, and every session in the window with its thread, your first and last message, Claude’s last response and its resume command.',
        (yy) =>
          yy
            .epilogue(REPO_NARRATIVE)
            .positional('path', {
              describe: 'Any directory inside the repo (a worktree counts)',
              type: 'string' as const,
            })
            .option('chars', {
              default: DEFAULT_CHARS,
              describe:
                'Cut each message preview at this many characters; 0 prints them whole',
              type: 'number' as const,
            })
            .option('days', {
              default: DEFAULT_DAYS,
              describe: 'Window, by each transcript’s last record',
              type: 'number' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print everything as JSON, messages whole and uncapped',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runForensicsRepo} = await import('./run');
          process.exit(
            await runForensicsRepo({
              chars: argv.chars,
              days: argv.days,
              json: argv.json,
              path: argv.path ?? '.',
            }),
          );
        },
      )
      .demandCommand(1, 'Please specify a forensics subcommand'),
  command: 'forensics',
  describe:
    'Read-only digest for status forensics: which repos had sessions, and per repo every checkout’s git state and every session’s first/last messages, thread and resume command',
  handler: () => {
    // Subcommands do the work; demandCommand prints help for a bare `forensics`.
  },
};
