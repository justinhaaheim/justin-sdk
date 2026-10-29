/**
 * The `pre-commit-ts-check` yargs command (home-base-pp1vx.1.2).
 *
 * Registered from cli-main.ts by reference. Only yargs types and the help
 * header are imported at the top; the handler `await import`s run.ts, so zod
 * stays off the path the per-prompt hooks pay for.
 */

import type {Argv, CommandModule} from 'yargs';

import {helpHeader, helpWrapWidth} from '../sdk-identity';
import {
  FULL_TS_CHECK_EVERY_HOURS_DEFAULT,
  HUSKY_CONFIG_KEY,
  TS_CHECK_ON_COMMIT_DEFAULT,
} from './defaults';

const HEADER = helpHeader('justin-sdk', import.meta.dirname);
const WRAP = helpWrapWidth(HEADER, Math.min(80, process.stdout.columns ?? 80));

const NARRATIVE = `
The type-check step of a .husky/pre-commit hook. Give it the hook's own
type-check command after --:

  bun run justin-sdk pre-commit-ts-check -- npm run ts-check

THE KNOB  componentConfig.${HUSKY_CONFIG_KEY}.tsCheckOnCommit in this repo's
          justin-sdk.config.json (project file only).

  "${TS_CHECK_ON_COMMIT_DEFAULT}" (the default): runs the command on every commit, prints
          nothing of its own, writes nothing. The same as the bare command.

  "onlyWhenTsStaged": runs the command when any staged path can affect
          type-checking, and skips it, in one printed line, when none can.
          Paths that cannot: .md .jsonl .txt, images and .pdf, .gitignore,
          .prettierignore, and anything under .beads/. Every other path
          can, including .json, .js, lockfiles and files with no extension.

THE REGULAR FULL CHECK  With the knob on, a commit that would skip runs the
          command anyway when this checkout has no green type-check recorded
          in the last componentConfig.${HUSKY_CONFIG_KEY}.fullTsCheckEveryHours hours
          (default ${FULL_TS_CHECK_EVERY_HOURS_DEFAULT}). A red full check blocks the commit, like any
          other red type-check. Each green run is recorded in this
          checkout's git dir, at $(git rev-parse --git-path
          justin-sdk/ts-check-last-green.json).

ANYTHING UNMEASURED RUNS THE CHECK: staged files that cannot be listed, a
          record that cannot be read or is dated in the future, a config
          file that cannot be used.

EXIT  the command's own exit code when it ran; 0 when skipped; 1 when it
      could not be started or ended on a signal; 2 when no command was given.`;

export const preCommitTsCheckCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .wrap(WRAP)
      .usage(`${HEADER}\n\n$0 pre-commit-ts-check -- <command…>`)
      .epilogue(NARRATIVE)
      .positional('command', {
        array: true,
        describe: "The hook's type-check command, after --",
        type: 'string',
      }),
  command: 'pre-commit-ts-check [command..]',
  describe:
    'The .husky/pre-commit type-check step: runs the hook\'s type-check command, or with componentConfig.husky.tsCheckOnCommit "onlyWhenTsStaged" skips it when nothing staged can affect type-checking, still running a full check at least every fullTsCheckEveryHours (home-base-pp1vx.1.2)',
  handler: async (argv) => {
    const {runPreCommitTsCheck} = await import('./run');
    const positional = (argv.command as unknown[] | undefined) ?? [];
    // yargs leaves everything after `--` in argv._, after the command's own
    // name (measured: argv['--'] is not populated without parserConfiguration).
    const afterDashes = argv._.slice(1);
    const command = [...positional, ...afterDashes].map(String);
    process.exit(runPreCommitTsCheck({command, cwd: process.cwd()}));
  },
};
