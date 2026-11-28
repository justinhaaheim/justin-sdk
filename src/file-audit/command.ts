/**
 * The `file-audit` yargs command group (home-base-n1qy7.15.1): `hook`,
 * `report` and `path`.
 *
 * Registered from cli-main.ts by reference. Each handler `await import`s its
 * module, so nothing new lands on the eager path every hook pays for. The hook
 * itself normally never reaches this file: cli.ts answers exactly
 * `file-audit hook` before the command tree loads. `file-audit hook --help`
 * comes here and prints help, nothing else.
 */

import type {Argv, CommandModule} from 'yargs';

import {helpHeader, helpWrapWidth} from '../sdk-identity';

const HEADER = helpHeader('justin-sdk', import.meta.dirname);
const WRAP = helpWrapWidth(HEADER, Math.min(80, process.stdout.columns ?? 80));

const NARRATIVE = `
An audit log of Claude Code's file access outside ~/Dev. A PreToolUse hook on
every tool appends one JSON line for each call that names a path outside
~/Dev, each Bash call that runs outside the sandbox, and each payload it
cannot read. It LOGS ONLY: it never blocks, asks or changes a tool call.

WHERE  $XDG_STATE_HOME/claude-file-audit/access.jsonl
       (~/.local/state/claude-file-audit/access.jsonl by default);
       \`justin-sdk file-audit path\` prints it.

WHAT IT SEES  Tool arguments, not what a process opens. A Bash line says
       confidence "arguments-only": \`cat ~/x\` is seen, a script that reads
       ~/x is not.

OFF SWITCH  componentConfig["file-audit"].enabled, default true.
       false in ~/.config/justin-sdk/config.json turns it off on this Mac;
       false in a repo's justin-sdk.config.json turns it off in that repo.
       The hook entry stays installed and does nothing while it is off.`;

const hookCommand: CommandModule = {
  builder: (y: Argv) =>
    y.wrap(WRAP).usage(`${HEADER}\n\n$0 file-audit hook`).epilogue(NARRATIVE),
  command: 'hook',
  describe:
    'PreToolUse hook (every tool): reads the hook payload on stdin and appends one line to the audit log when the call names a path outside ~/Dev, runs Bash outside the sandbox, or cannot be read. Prints nothing and returns no decision; exits 1 (non-blocking) only when the log cannot be written.',
  handler: async () => {
    const {runFileAuditHook} = await import('./hook');
    process.exit(runFileAuditHook());
  },
};

const reportCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .wrap(WRAP)
      .usage(`${HEADER}\n\n$0 file-audit report [--since <window>] [--all]`)
      .epilogue(NARRATIVE)
      .option('since', {
        default: '7d',
        describe:
          'How far back to read: 30m, 12h, 7d, 2w, or "all" for the whole log.',
        type: 'string',
      })
      .option('all', {
        default: false,
        describe:
          'Also show calls that touched only temp files (/tmp, /var/folders, $TMPDIR) or ~/.claude. Hidden by default; the log keeps them.',
        type: 'boolean',
      }),
  command: 'report',
  describe:
    'A readable summary of the audit log: calls outside ~/Dev grouped by top-level folder, Bash calls outside the sandbox by source, and how many lines could not be read.',
  handler: async (argv) => {
    const {runFileAuditReport} = await import('./report');
    process.exit(
      await runFileAuditReport({
        all: argv.all === true,
        since: String(argv.since),
      }),
    );
  },
};

const pathCommand: CommandModule = {
  builder: (y: Argv) =>
    y.wrap(WRAP).usage(`${HEADER}\n\n$0 file-audit path`).epilogue(NARRATIVE),
  command: 'path',
  describe: 'Print the path of the audit log, whether or not it exists yet.',
  handler: async () => {
    const {auditLogPath} = await import('./audit');
    process.stdout.write(`${auditLogPath()}\n`);
    process.exit(0);
  },
};

export const fileAuditCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .wrap(WRAP)
      .usage(`${HEADER}\n\n$0 file-audit <command>`)
      .epilogue(NARRATIVE)
      .command(hookCommand)
      .command(reportCommand)
      .command(pathCommand)
      .demandCommand(1, 'Name a file-audit command: hook, report or path.'),
  command: 'file-audit',
  describe:
    "The audit log of Claude Code's file access outside ~/Dev (home-base-n1qy7.15.1): hook, report, path. Logging only; nothing is blocked.",
  handler: () => {
    // demandCommand prints the help when no subcommand is given.
  },
};
