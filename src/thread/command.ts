/**
 * The `thread` yargs command group, and the `usage-now` command beside it
 * (home-base-p1uj D6, D12).
 *
 * Registered from cli.ts BY REFERENCE, the way `repo-status` is, so the top of
 * the CLI stays a list of commands rather than a list of options.
 *
 * NOTHING HEAVY IS IMPORTED AT THE TOP OF THIS FILE. Every handler
 * `await import`s its module. That is not tidiness: `time-check` and
 * `usage-check` are hooks that run on every prompt and every tool batch, they
 * are the same binary, and they pay for whatever cli.ts's eager module graph
 * pulls in. zod costs 12-13ms and lives behind this boundary — `schema.ts` and
 * `config.ts` are only ever reached from inside a handler.
 *
 * Handlers call `process.exit` with the exit code the command contracted for
 * (see report.ts: 0 recorded, 1 NOT RECORDED, 2 refused).
 */

import type {Argv, CommandModule} from 'yargs';

const PREPARE_NARRATIVE = `
Run this BEFORE writing a report. It prints, in order:

  THREADS: ENABLED | DISABLED | SANDBOX DENIED   ← branch on this line
  this session's thread bead (or "none yet")
  every OPEN ask, with Justin's answers verbatim
  the facts the report will attach (you type none of them)
  the payload skeleton, and where to write it

DISABLED means the knob is off — fall back to the plain text status report.
SANDBOX DENIED names the two paths to allowlist and exits 0; fall back too.`;

export const threadCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .command(
        'prepare',
        'Preflight a status report: the knob, the sandbox, this session’s thread, its open asks and their answers, the autofilled facts, and the payload skeleton. Always exits 0.',
        (yy) =>
          yy.epilogue(PREPARE_NARRATIVE).option('session', {
            describe:
              'Session id to prepare for (default: $CLAUDE_CODE_SESSION_ID)',
            type: 'string' as const,
          }),
        async (argv) => {
          const {runThreadPrepare} = await import('./prepare');
          process.exit(
            await runThreadPrepare({sessionId: argv.session ?? null}),
          );
        },
      )
      .command(
        'report',
        'Validate a report payload, archive it, upsert this session’s thread bead with its child ask beads, and print the rendered status report. Exit 0 recorded · 1 NOT RECORDED · 2 refused.',
        (yy) =>
          yy
            .option('file', {
              describe: 'Path to the payload JSON',
              type: 'string' as const,
            })
            .option('stdin', {
              default: false,
              describe: 'Read the payload from stdin instead of a file',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id to report for (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            })
            .check((argv) => {
              const hasFile = argv.file != null && argv.file !== '';
              if (hasFile === (argv.stdin === true)) {
                throw new Error('pass exactly one of --file <path> or --stdin');
              }
              return true;
            }),
        async (argv) => {
          const {runThreadReport} = await import('./report');
          process.exit(
            await runThreadReport({
              file: argv.file ?? null,
              sessionId: argv.session ?? null,
              stdin: argv.stdin === true,
            }),
          );
        },
      )
      .command(
        'show [threadId]',
        'Print a thread bead as its status report, plus the CURRENT open asks and Justin’s answers on them. With no id, this session’s thread.',
        (yy) =>
          yy
            .positional('threadId', {
              describe: 'Thread bead id (e.g. jl-x7q). Omit for this session.',
              type: 'string' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadShow} = await import('./show');
          process.exit(
            await runThreadShow({
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
            }),
          );
        },
      )
      .demandCommand(1, 'Please specify a thread subcommand'),
  command: 'thread',
  describe:
    'Status reports as beads: one thread bead per Claude Code session in ~/Dev/life, with a child ask bead for everything Justin has to do.',
  handler: () => {
    // Subcommands do the work; demandCommand prints help for a bare `thread`.
  },
};

export const usageNowCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .option('json', {
        default: false,
        describe: 'Print {contextTokens, sessionId, transcriptPath, reason}',
        type: 'boolean' as const,
      })
      .option('session', {
        describe: 'Session id (default: $CLAUDE_CODE_SESSION_ID)',
        type: 'string' as const,
      })
      .option('transcript', {
        describe: 'Read this transcript directly instead of finding one',
        type: 'string' as const,
      }),
  command: 'usage-now',
  describe:
    'Print how many tokens of CONTEXT this session has used right now (not subscription quota). UNKNOWN + exit 1 when it cannot be measured — never 0.',
  handler: async (argv) => {
    const {runUsageNow} = await import('./usage-now');
    process.exit(
      runUsageNow({
        json: argv.json === true,
        sessionId: (argv.session as string | undefined) ?? null,
        transcriptPath: (argv.transcript as string | undefined) ?? null,
      }),
    );
  },
};
