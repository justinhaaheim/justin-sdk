/**
 * `justin-sdk forensics` — RETIRED into repo-status (home-base-39co9.5 R3).
 *
 * The digest this command printed now comes from repo-status, built on its
 * evidence (merge state proven by content, never a commit count by identity):
 *
 *   forensics repo <path>   →  repo-status status --repo <path> --checkouts --sessions
 *   forensics repos         →  repo-status repos
 *
 * These two stay for ONE release as aliases, so a skill or a habit that still
 * types the old name keeps working: each prints one line naming its
 * replacement, on stderr so `--json` stdout stays parseable, and then runs it.
 * Removing them is home-base-39co9.9.
 *
 * NOTHING HEAVY IS IMPORTED AT THE TOP OF THIS FILE (home-base-wxa4c D-W1).
 * cli.ts imports this module eagerly, and cli.ts is also the entry for the
 * `time-check` and `usage-check` hooks that run on every prompt. The
 * replacements are reached by `await import` only;
 * tests/health-notices-cli.test.ts fails if zod becomes statically reachable
 * from cli.ts.
 */

import type {Argv, CommandModule} from 'yargs';

const DEFAULT_DAYS = 14;
const DEFAULT_CHARS = 400;

/** The one line an alias prints before it runs its replacement. */
export function retiredNotice(old: string, replacement: string): string {
  return `\`justin-sdk forensics ${old}\` is now \`justin-sdk ${replacement}\` (this alias goes away in the next release) — running that:`;
}

export const forensicsCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .command(
        'repos',
        'RETIRED: runs `repo-status repos`',
        (yy) =>
          yy
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
              describe: 'Only list repos inside this directory',
              type: 'string' as const,
            }),
        async (argv) => {
          const replacement = [
            'repo-status repos',
            `--days ${argv.days}`,
            `--root ${argv.root}`,
            ...(argv.json ? ['--json'] : []),
          ].join(' ');
          process.stderr.write(`${retiredNotice('repos', replacement)}\n`);
          const {runRepos} = await import('../repo-status/views-run');
          process.exitCode = await runRepos({
            days: argv.days,
            json: argv.json,
            root: argv.root,
          });
        },
      )
      .command(
        'repo <path>',
        'RETIRED: runs `repo-status status --repo <path> --checkouts --sessions`',
        (yy) =>
          yy
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
              describe: 'Print everything as JSON',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const path = argv.path ?? '.';
          const replacement = [
            'repo-status status',
            `--repo ${path}`,
            '--checkouts --sessions',
            `--sessions-days ${argv.days}`,
            `--message-chars ${argv.chars}`,
            ...(argv.json ? ['--json'] : []),
          ].join(' ');
          process.stderr.write(`${retiredNotice('repo', replacement)}\n`);
          const {runStatus} = await import('../repo-status/repo-status');
          const {DEFAULT_PAIR_CAP} = await import('../repo-status/overlap');
          process.exitCode = await runStatus({
            checkouts: true,
            content: true,
            json: argv.json,
            mergePreview: true,
            messageChars: argv.chars,
            overlaps: true,
            pairCap: DEFAULT_PAIR_CAP,
            prs: true,
            repo: path,
            sessions: true,
            sessionsDays: argv.days,
            submoduleStores: false,
            submodules: true,
          });
        },
      )
      .demandCommand(1, 'Please specify a forensics subcommand'),
  command: 'forensics',
  describe:
    'RETIRED into repo-status: `forensics repo` is `repo-status status --checkouts --sessions`, `forensics repos` is `repo-status repos`',
  handler: () => {
    // Subcommands do the work; demandCommand prints help for a bare `forensics`.
  },
};
