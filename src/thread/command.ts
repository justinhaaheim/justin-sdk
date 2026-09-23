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

/**
 * Kept HERE rather than imported from backfill.ts on purpose: nothing heavy is
 * imported at the top of this file (see the header), and backfill.ts pulls in
 * bd, git, the schema and the transcript reader.
 */
const BACKFILL_NARRATIVE = `
READS   every ~/.claude/projects/<project>/<uuid>.jsonl, one level deep.
        Subagent transcripts (agent-*.jsonl, and <uuid>/subagents/) are skipped
        — a subagent is not a session. READ ONLY: nothing under
        ~/.claude/projects is ever written, moved or deleted.
WRITES  a thread bead for every session that has none, status OPEN with
        metadata.source=backfill, plus ONE git commit of ~/Dev/threads per run.
        AND rewrites <state dir>/messages/<sessionId>.jsonl for every session in
        the window — every prompt and every turn's final Claude message, from
        the transcript — keeping any line \`thread capture\` logged after the
        transcript's last record. Local only; never committed.
NEVER   touches a CLOSED thread, and never touches the title, description, notes
        or status of a thread a real session created — for those it fills in
        ONLY the verbatim messages they never had, and only when those are
        missing or the transcript has moved on since.

A session's last activity is the LAST RECORD'S TIMESTAMP inside the file, never
the file's mtime: resuming a session in cmux touches the file without adding a
record. Sessions with nothing Justin actually said (\`claude -p\` probes,
hook-only runs) are counted and reported, never imported. A transcript with no
timestamp on ANY record can be placed neither inside nor outside the window: it
is skipped, named under a \`note:\` line every run, and is NOT a run failure.

Idempotent: run it as often as you like. A second run with no new transcript
activity writes nothing. \`thread board\` hides what this creates; \`--all\`
shows it.`;

/**
 * Kept HERE for the same reason BACKFILL_NARRATIVE is: search.ts pulls in bd,
 * the board and the archive reader, and nothing heavy loads at the top of this
 * file.
 */
const SEARCH_NARRATIVE = `
SEARCHES, per session, in this order — the order decides which field the one
snippet comes from when several match, and the snippet line says how many other
fields matched and names them:

  title · firstUserMessage · lastUserMessage · lastAssistantMessage
  notes (the stored report) · description
  then EVERY line of the session's message log, <state dir>/messages/
  <sessionId>.jsonl — every prompt and every final Claude message, named
  \`you · <local time>\` or \`Claude · <local time>\`
  then EVERY string in every archived report JSON under
  <state dir>/reports/<sessionId>/, which is what covers reports written before
  the verbatim messages were stored on the bead at all.

CORPUS  one \`bd list -t thread --all\` — closed threads included — plus the
        report archive. Sessions \`thread backfill\` recorded are in it, which is
        what makes a session that never reported findable.

MATCHES the words you type joined into ONE phrase, case-insensitively, as a
        plain substring — except that a space matches ANY run of whitespace, so
        a phrase still matches where a dictated message put a newline in the
        middle of it. Everything else is literal: \`what?\` finds a question
        mark. --regex switches to a JS regular expression instead (the \`i\`
        flag is always on); an invalid one exits 2 with the engine's message.

EXIT    0 something matched · 1 NOTHING matched, and the line says how many
        sessions that was measured over · 2 could not search — a failed bd read,
        an unreadable archive, or a bad regex. 2 is never silently a 1: anything
        found is still printed, with a line saying the corpus was incomplete.

--days filters on last activity (lastActivityAt, else reportedAt, else
startedAt). A session that dates itself NOWHERE is never filtered out — an
unknown date is not proof that it is old.`;

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

const STOP_CHECK_NARRATIVE = `
Installed by \`justin-sdk add thread-hooks\` as a Stop hook. In the default mode
(enforceMode "reportShaped") it blocks exactly one case: the turn's final message
carries the report delimiters (a run of 🛑 above it and 🕉️ below it) AND this
session has archived no report since Justin's last message. The block is exit 2,
the reason on stderr, and the same reason as JSON on stdout.

With enforceMode "workTurns" (the K12 refusal experiment) it ALSO blocks a
plain-prose yield when the turn since Justin's last message ran a \`git commit\`
or lasted at least enforceMinTurnMinutes (default 20), and no report was
archived since that message. The reason names which.

It passes, silently and with exit 0, on everything else — the knob being off, a
subagent's Stop, a turn it has already blocked, a final message that is not a
report (in reportShaped), and every case where it could not measure: no
transcript, no session id, an unreadable archive, a payload that is not JSON.

Every run appends one line to ~/.local/state/justin-threads/stop-check.jsonl,
passes included; --stats counts them by action and why.

Needs componentConfig.thread.enforce, which defaults FALSE.`;

const CAPTURE_NARRATIVE = `
Installed by \`justin-sdk add thread-hooks\` on TWO events. It reads the hook
payload (JSON) on stdin:

  UserPromptSubmit   records the prompt as a "user" line
  Stop               records last_assistant_message (the message Claude just
                     yielded) as an "assistant" line
  anything else      does nothing

WRITES, synchronously, one JSON line
  {role, at, text, event, cwd}
to <state dir>/messages/<sessionId>.jsonl (default state dir:
~/.local/state/justin-threads). Text is verbatim and uncapped; harness noise is
stripped from prompts exactly as \`thread backfill\` strips it. The log is local:
never committed, never pushed. A repeat of the last line (a hook firing twice)
is not appended again.

THEN starts a DETACHED child (\`thread capture --apply <sessionId>\`) and returns
at once. The child finds this session's thread bead in ~/Dev/threads — or
creates it exactly as \`thread start\` would — and sets its last user message,
last Claude response, lastActivityAt and messageCount from the log's newest
lines. It never touches the title, description, notes or status of a bead a
report wrote; a bead \`thread backfill\` made moves from open to in_progress.
It commits the threads repo and never pushes. Each child run appends one line
to <state dir>/capture.jsonl — that is where a bd failure shows up.

SKIPS subagents (agent_id in the payload), \`claude -p\` runs
(CLAUDE_CODE_ENTRYPOINT=sdk-cli), messages that are empty after stripping, and
repos where the knob is off.

ALWAYS EXITS 0 and prints nothing on stdout — a prompt hook's stdout would be
fed to the model. --explain prints the decision and the synchronous wall time
to stderr.

KNOB: componentConfig.thread.capture, DEFAULT TRUE, and it needs
componentConfig.thread.enabled too. Set "capture": false in a repo's
justin-sdk.config.json to opt that repo out.`;

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
            .option('continues-from-session', {
              describe:
                'The PREDECESSOR\u2019s claude session id, resolved to its thread bead and then used exactly like --continues-from. Falls back to $JUSTIN_LOOP_PREDECESSOR_SESSION_ID, which the justin-loop runner sets on a successor\u2019s dispatch. A predecessor with no thread bead is named and prepare carries on unlinked.',
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
              continuesFromSession: argv['continues-from-session'] ?? null,
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
            .option('continues-from-session', {
              describe:
                'The PREDECESSOR\u2019s claude session id, resolved to its thread bead and used as continuesFrom when the payload names none. Falls back to $JUSTIN_LOOP_PREDECESSOR_SESSION_ID (set by the justin-loop runner). A payload continuesFrom always wins; a predecessor with no thread bead is named and the report is written unlinked.',
              type: 'string' as const,
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
              continuesFromSession: argv['continues-from-session'] ?? null,
              file: argv.file ?? null,
              full: argv.full === true,
              sessionId: argv.session ?? null,
              stdin: argv.stdin === true,
            }),
          );
        },
      )
      .command(
        'stop-check',
        'Stop hook: refuse to let a session finish on a status report it cannot prove was recorded. Reads the hook payload on stdin. Exit 0 pass (silent) · 2 blocked. Needs componentConfig.thread.enforce.',
        (yy) =>
          yy
            .epilogue(STOP_CHECK_NARRATIVE)
            .option('explain', {
              default: false,
              describe:
                'Print the branch that decided and the elapsed ms to stderr. Off in hook mode, where every pass is silent.',
              type: 'boolean' as const,
            })
            .option('stats', {
              default: false,
              describe:
                'Read no payload: print how many times stop-check passed and blocked, and why, from its decision log (~/.local/state/justin-threads/stop-check.jsonl). "Has it ever kicked in?" in one command (K12).',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const stopCheck = await import('./stop-check');
          if (argv.stats === true) {
            process.exit(stopCheck.runStopCheckStats());
          }
          process.exit(
            stopCheck.runThreadStopCheck({explain: argv.explain === true})
              .exitCode,
          );
        },
      )
      .command(
        'capture',
        'Hook: record this prompt (UserPromptSubmit) or Claude’s yield (Stop) in the session’s message log, and keep its thread bead’s last messages current in the background. Reads the payload on stdin. Always exits 0. Needs componentConfig.thread.enabled; .capture defaults true.',
        (yy) =>
          yy
            .epilogue(CAPTURE_NARRATIVE)
            .option('apply', {
              describe:
                'INTERNAL — the detached child: apply <sessionId>’s message log to its thread bead. The hook starts this itself.',
              type: 'string' as const,
            })
            .option('cwd', {
              describe:
                'With --apply: the session’s working directory (for the knobs and, when the bead is created, its repo facts)',
              type: 'string' as const,
            })
            .option('explain', {
              default: false,
              describe:
                'Print the decision and the synchronous wall time (ms) to stderr',
              type: 'boolean' as const,
            })
            .option('hook-ms', {
              describe:
                'INTERNAL — with --apply: the hook’s synchronous wall time up to the spawn, recorded in capture.jsonl as hookElapsedMs',
              type: 'number' as const,
            })
            .option('transcript', {
              describe:
                'With --apply: the transcript path from the payload, which saves a search when the bead is created',
              type: 'string' as const,
            }),
        async (argv) => {
          const capture = await import('./capture');
          if (argv.apply != null && argv.apply !== '') {
            process.exit(
              await capture.runThreadCaptureApply({
                cwd: argv.cwd ?? null,
                hookElapsedMs:
                  argv['hook-ms'] != null && Number.isFinite(argv['hook-ms'])
                    ? argv['hook-ms']
                    : null,
                sessionId: argv.apply,
                transcriptPath: argv.transcript ?? null,
              }),
            );
          }
          process.exit(
            capture.runThreadCaptureHook({explain: argv.explain === true})
              .exitCode,
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
            .option('messages', {
              default: false,
              describe:
                'Print the session’s whole message log (every prompt and every Claude yield that capture or the backfill recorded) instead of the report.',
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
              messages: argv.messages === true,
              sessionId: argv.session ?? null,
              threadId: argv.threadId ?? null,
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
              threadId: argv.threadId ?? null,
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
              threadId: argv.threadId ?? null,
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
                'Show the folded-away threads too — by default a thread another session took over, and a session `thread backfill` recorded, are both hidden (unless they still have open asks)',
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
              includeBackfilled: argv.all === true,
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
        'backfill',
        'A thread bead for every Claude Code session of the last 30 days that never reported, read from the transcripts Claude Code already wrote. Idempotent; run it as often as you like.',
        (yy) =>
          yy
            .epilogue(BACKFILL_NARRATIVE)
            .option('days', {
              default: 30,
              describe:
                'How far back to look. A session is in the window when its LAST RECORD (never the file mtime) is inside it.',
              type: 'number' as const,
            })
            .option('dry-run', {
              default: false,
              describe:
                'Say what would be created and refreshed; write nothing, to bd or to git',
              type: 'boolean' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print the summary as JSON, including every skip count',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadBackfill} = await import('./backfill');
          process.exit(
            await runThreadBackfill({
              days: argv.days,
              dryRun: argv['dry-run'] === true,
              json: argv.json === true,
            }),
          );
        },
      )
      .command(
        'search <query..>',
        'Find the session in which a phrase was written. Searches every thread bead (the three verbatim messages, the title, the stored report) and every archived report JSON; prints repo · age · title · session id, the matching snippet, and the command that resumes it.',
        (yy) =>
          yy
            .epilogue(SEARCH_NARRATIVE)
            .positional('query', {
              describe:
                'The phrase to look for. Several words are ONE phrase, not separate terms.',
              type: 'string' as const,
            })
            .option('days', {
              describe:
                'Only sessions whose last activity is within this many days (default: all of them)',
              type: 'number' as const,
            })
            .option('json', {
              default: false,
              describe:
                'Print the rows, the counts and any read failure as JSON. Snippets are unstyled.',
              type: 'boolean' as const,
            })
            .option('limit', {
              default: 20,
              describe: 'How many rows to print. 0 prints every match.',
              type: 'number' as const,
            })
            .option('regex', {
              default: false,
              describe:
                'Treat the query as a JS regular expression instead of a literal phrase',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadSearch} = await import('./search');
          const words = (argv.query as string[] | string | undefined) ?? [];
          process.exit(
            await runThreadSearch({
              days: argv.days ?? null,
              json: argv.json === true,
              limit: argv.limit,
              query: (Array.isArray(words) ? words : [words]).join(' '),
              regex: argv.regex === true,
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
              threadId: argv.threadId ?? null,
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
              threadId: argv.threadId ?? null,
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
