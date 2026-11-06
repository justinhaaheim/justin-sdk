/**
 * The `pre-commit-beads-export` yargs command (home-base-jm5kg.11.3). Registered
 * from cli-main.ts by reference; the handler `await import`s check.ts.
 */

import type {Argv, CommandModule} from 'yargs';

import {helpHeader, helpWrapWidth} from '../sdk-identity';

const HEADER = helpHeader('justin-sdk', import.meta.dirname);
const WRAP = helpWrapWidth(HEADER, Math.min(80, process.stdout.columns ?? 80));

const NARRATIVE = `
A step of a .husky/pre-commit hook. It refuses a commit that stages
.beads/issues.jsonl with a conflict marker line or a line that is not JSON.

It reads the staged blob, not the working file. A commit that does not stage the
export passes, and so does one that stages its deletion.

EXIT  0 passed; 1 refused, or the staged file could not be checked.`;

export const preCommitBeadsExportCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .wrap(WRAP)
      .usage(`${HEADER}\n\n$0 pre-commit-beads-export`)
      .epilogue(NARRATIVE),
  command: 'pre-commit-beads-export',
  describe:
    'The .husky/pre-commit bead export step: refuses a commit that stages .beads/issues.jsonl with conflict markers or a line that is not JSON (home-base-jm5kg.11.3)',
  handler: async () => {
    const {runPreCommitBeadsExport} = await import('./check');
    process.exit(
      runPreCommitBeadsExport({
        cwd: process.cwd(),
        print: (line) => {
          console.error(line);
        },
      }),
    );
  },
};
