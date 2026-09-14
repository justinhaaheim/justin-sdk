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

const START_NARRATIVE = `
Creates the thread bead UP FRONT, status in_progress, titled "(untitled) <repo>
session <id>" and noted "no report yet", so a session that never reaches its
status report is still visible on the board instead of vanishing.

It is the same upsert \`thread report\` uses: keyed on metadata.sessionId, so the
first report REWRITES this bead rather than creating a second.

Both knobs must be true — componentConfig.thread.enabled AND
componentConfig.thread.startOnSessionStart — and both default false.

Install the hook that runs this with:  justin-sdk add thread-hooks`;

const ANSWER_NARRATIVE = `
DEFAULT (--ui web): starts a server on 127.0.0.1, opens your browser, and shows
one textarea per ask on one page.

  every keystroke burst is saved to <state dir>/drafts/<threadId>/<askId>.txt
  Enter inserts a newline · Tab moves focus · neither ever submits
  Ctrl/Cmd-S opens a review panel; nothing reaches bd until you press Record
  Ctrl/Cmd-K takes an ask's stated default · Esc opens a menu, never quits
  Ctrl-C here, closing the tab, and quitting from the menu all KEEP the drafts

--classic: the original readline walk in this terminal. Keep it for the iOS
remote-control flow, which cannot reach a page on localhost.

--ui ink: measured and rejected in the spike; the command says why and exits 2.`;

export const threadCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .command(
        'prepare',
        'Preflight a status report: the knob, the sandbox, this session’s thread, its open asks and their answers, the autofilled facts, and the payload skeleton. Always exits 0.',
        (yy) =>
          yy
            .epilogue(PREPARE_NARRATIVE)
            .option('continues-from', {
              describe:
                'Thread bead id this session continues: lists ITS open asks as ones this report must disposition, and prefills continuesFrom in the skeleton',
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'Session id to prepare for (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadPrepare} = await import('./prepare');
          process.exit(
            await runThreadPrepare({
              continuesFrom: argv['continues-from'] ?? null,
              sessionId: argv.session ?? null,
            }),
          );
        },
      )
      .command(
        'start',
        'Create this session’s thread bead before it has reported anything, so an abandoned session is still on the board. Idempotent. Needs componentConfig.thread.enabled AND .startOnSessionStart.',
        (yy) =>
          yy
            .epilogue(START_NARRATIVE)
            .option('hook', {
              default: false,
              describe:
                'SessionStart hook mode: read the payload from stdin, always exit 0, print at most one line',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id to start (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            })
            .option('title', {
              describe:
                'Title instead of the "(untitled) <repo> session <id>" placeholder',
              type: 'string' as const,
            })
            .option('transcript', {
              describe:
                'Transcript path, if known — skips the search under ~/.claude/projects',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadStart, runThreadStartHook} = await import('./start');
          if (argv.hook === true) {
            process.exit(await runThreadStartHook());
            return;
          }
          process.exit(
            await runThreadStart({
              sessionId: argv.session ?? null,
              title: argv.title ?? null,
              transcriptPath: argv.transcript ?? null,
            }),
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
            .option('full', {
              default: false,
              describe:
                'Print everything: work product, beads touched, every What I did item, and the full last message. The default is the compact report; the thread bead always stores the full one.',
              type: 'boolean' as const,
            })
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
              full: argv.full === true,
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
            .option('full', {
              default: false,
              describe:
                'Print everything: work product, beads touched, every What I did item, and the full last message. The default is the compact report; the thread bead always stores the full one.',
              type: 'boolean' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadShow} = await import('./show');
          process.exit(
            await runThreadShow({
              full: argv.full === true,
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
            }),
          );
        },
      )
      .command(
        'answer [threadId]',
        'Answer this thread’s open asks. Opens a local page where drafts autosave to disk and no key discards text; --classic walks them in the terminal instead. Exit 0 recorded · 1 a write failed · 2 nothing recorded.',
        (yy) =>
          yy
            .epilogue(ANSWER_NARRATIVE)
            .positional('threadId', {
              describe: 'Thread bead id. Omit for this session’s thread.',
              type: 'string' as const,
            })
            .option('classic', {
              default: false,
              describe:
                'The original readline walk in this terminal — the iOS remote-control path',
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
            })
            .option('ui', {
              choices: ['classic', 'ink', 'web'] as const,
              describe:
                'Override componentConfig.thread.answerUi for this run (default: web)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadAnswerUi} = await import('./answer-ui');
          process.exit(
            await runThreadAnswerUi({
              classic: argv.classic === true,
              latest: argv.latest === true,
              sessionId: argv.session ?? null,
              threadId: (argv.threadId as string | undefined) ?? null,
              ui: (argv.ui as string | undefined) ?? null,
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
            .option('all', {
              default: false,
              describe:
                'Show continued threads too — by default a thread another session took over is folded away (unless it still has open asks)',
              type: 'boolean' as const,
            })
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
              includeContinued: argv.all === true,
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
    'Status reports as beads: one thread bead per Claude Code session in ~/Dev/threads, with a child ask bead for everything Justin has to do.',
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
