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
            // NO `.check()` HERE, deliberately (home-base-p1uj.2). A `.check()`
            // that throws is routed to the CLI-wide `.fail(reportCliFailure)`,
            // which prints a STACK TRACE and exits 1 — measured 2026-09-12:
            // four frames of yargs internals for a plain usage mistake, and an
            // exit code that says "bd failed" rather than "fix your command".
            // That contract is shared with every other command and must not be
            // changed from here (tests/cli-failure.test.ts pins it).
            //
            // So the flag combination is validated INSIDE `runThreadReport`
            // instead, where it lands on the same one-line/exit-2 path as every
            // other refusal. Exit 2 is the documented "refused, nothing was
            // written" code; a usage error is exactly that.
            .option('session', {
              describe:
                'Session id to report for (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
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
      .command(
        'answer [threadId]',
        'Walk this thread’s open asks one at a time and record your answers as bd comments. Needs a terminal. Exit 0 walked · 1 a write failed · 2 could not start.',
        (yy) =>
          yy
            .positional('threadId', {
              describe: 'Thread bead id. Omit for this session’s thread.',
              type: 'string' as const,
            })
            .option('latest', {
              default: false,
              describe: 'The most recently reported thread, whatever session',
              type: 'boolean' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadAnswer} = await import('./answer');
          process.exit(
            await runThreadAnswer({
              latest: argv.latest === true,
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
            }),
          );
        },
      )
      .command(
        'inbox [threadId]',
        'What Justin answered or skipped since the last report, each ask restated in full. Read this at the start of a turn. Marks nothing.',
        (yy) =>
          yy
            .positional('threadId', {
              describe: 'Thread bead id. Omit for this session’s thread.',
              type: 'string' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print the inbox as JSON',
              type: 'boolean' as const,
            })
            .option('latest', {
              default: false,
              describe: 'The most recently reported thread, whatever session',
              type: 'boolean' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadInbox} = await import('./inbox');
          process.exit(
            await runThreadInbox({
              json: argv.json === true,
              latest: argv.latest === true,
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
            }),
          );
        },
      )
      .command(
        'board',
        'Every live thread: what it was, how far it got, why it stopped, and what it needs from you. Drains the spool first. Grouped by repo; --recent for a flat newest-first list; --open-asks for everything waiting on you.',
        (yy) =>
          yy
            .option('json', {
              default: false,
              describe: 'Print the board as JSON',
              type: 'boolean' as const,
            })
            .option('open-asks', {
              default: false,
              describe: 'Every open ask across all threads, blocking first',
              type: 'boolean' as const,
            })
            .option('recent', {
              default: false,
              describe: 'A flat list, newest report first',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadBoard} = await import('./board');
          process.exit(
            await runThreadBoard({
              json: argv.json === true,
              view:
                argv['open-asks'] === true
                  ? 'openAsks'
                  : argv.recent === true
                    ? 'recent'
                    : 'repo',
            }),
          );
        },
      )
      .command(
        'done [threadId]',
        'Mark a thread finished: closes it AND its open asks. Omit the id for this session’s thread.',
        (yy) =>
          yy
            .positional('threadId', {
              describe: 'Thread bead id. Omit for this session’s thread.',
              type: 'string' as const,
            })
            .option('latest', {
              default: false,
              describe: 'The most recently reported thread, whatever session',
              type: 'boolean' as const,
            })
            .option('reason', {
              describe: 'Why it is done (default: "thread closed by Justin")',
              type: 'string' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadDone} = await import('./done');
          process.exit(
            await runThreadDone({
              latest: argv.latest === true,
              reason: argv.reason ?? null,
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
            }),
          );
        },
      )
      .command(
        'reopen <threadId>',
        'Reopen a closed thread. Its asks stay closed — the next report can ask again.',
        (yy) =>
          yy
            .positional('threadId', {
              describe: 'Thread bead id',
              type: 'string' as const,
            })
            .option('reason', {
              describe: 'Why it is being reopened',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadReopen} = await import('./done');
          process.exit(
            await runThreadReopen({
              reason: argv.reason ?? null,
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
