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
Creates the thread bead BEFORE any report, status in_progress, titled
"(untitled) <repo> session <id>" and noted "no report yet", so a session that
never reaches its status report is still visible on the board.

You rarely need it by hand: \`thread capture\` creates the same bead on the
session's FIRST PROMPT. Nothing creates one at SessionStart, so a session that
is opened and never prompted leaves no thread.

It is the same upsert \`thread report\` uses: keyed on metadata.sessionId, so the
first report REWRITES this bead rather than creating a second.

Needs componentConfig.thread.enabled (default false).
componentConfig.thread.startOnSessionStart is DEPRECATED and changes nothing.

--hook is RETIRED and INERT: it exits 0 and does nothing, so the SessionStart
entry older installs carry stops creating threads with the SDK pin bump alone.
Re-running \`justin-sdk add thread-hooks\` (or \`install\`) removes that entry.`;

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
        the window — every prompt (including ones queued mid-turn) and every
        message Claude yielded at a Stop, from the transcript — keeping every
        line \`thread capture\` logged whose text the transcript does not have.
        Local only; never committed.
NEVER   touches a CLOSED thread, and never touches the title, description, notes
        or status of a thread a real session created — for those it fills in
        ONLY the verbatim messages they never had, and only when those are
        missing or the transcript has moved on since. A thread labelled
        source=backfill counts as its own only while reportCount is 0,
        reportedAt is null and the description still starts with the backfill
        marker. One that carries a report is relabelled source=report, body
        untouched; one it cannot read is left alone. Each is named under note:.

A session's last activity is the LAST RECORD'S TIMESTAMP inside the file, never
the file's mtime: resuming a session in cmux touches the file without adding a
record. \`claude -p\` runs (transcript entrypoint sdk-cli, which \`thread capture\`
skips live too) and sessions with nothing Justin actually said (hook-only runs)
are counted and reported, never imported: no bead, no message log. A transcript
with no timestamp on ANY record can be placed neither inside nor outside the
window: it is skipped, named under a \`note:\` line every run, and is NOT a run
failure.

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

THE ONE EXCEPTION — componentConfig.thread.sessionBeads (DEFAULT FALSE, status
report v4): the child ALSO files a \`session\` bead in the repo's own beads on
the session's first captured prompt (recorded in <state dir>/sessions.jsonl),
and on every UserPromptSubmit the hook prints ONE hook-JSON line whose context
is
  [thread] session <bead id> "<title>" · requests: <n> open, <m> done · new work → …
so Claude keeps the session in mind; you see the same line as a system
message. It reads files only (never br), so it costs a few ms.

KNOB: componentConfig.thread.capture, DEFAULT TRUE, and it needs
componentConfig.thread.enabled too. Set "capture": false in a repo's
justin-sdk.config.json to opt that repo out.`;

const NUDGE_NARRATIVE = `
Installed by \`justin-sdk add thread-hooks\` as PostToolUse with matcher Bash.
It speaks — one line of context, mirrored to you — only when ALL hold:

  the call is the main session's (no agent_id), the command runs git commit
      (quoted text ignored; --help, -h and --dry-run do not count)
  componentConfig.thread.sessionBeads AND .nudge are on
  the session has a session bead and NO request in progress
  it has not already spoken since your last prompt (a marker in
      <state dir>/nudge-marks/<session id>.json, keyed by that prompt's time)

The line: [thread] you committed but no request is in progress for this
session — if this is work Justin asked for, run: thread request "…"`;

const REQUEST_NARRATIVE = `
A REQUEST is a bead Justin asked for: label \`request\` + \`sid:<session id>\`,
status in_progress. Run it as soon as he asks for work — one command, no form.

  thread request "fix the login bug" [--done-when "the e2e login test passes"]
      creates a task (P2) under this session's bead, in the beads DB that holds
      the session bead — whatever the current directory is.
  thread request --bead cq8f
      adopts an existing bead ("fix cq8f"): sets it in_progress and labels it.
      Never moves or re-parents it. Looked up in the session's DB, then here.

The FIRST request also renames the session to the request's title (unless
\`thread title\` already named it). Later requests never rename.

REFUSES (exit 1) when the session's checkout is gone — it names the path — and
when this session has no session bead (the knob was off when it started, the
capture hook is not installed, or the repo has no beads workspace). --here files
in the current directory's beads instead and records that DB for the session.

When a request is finished: br close <id> --reason "…". Your open questions to
Justin never keep it open.`;

const ASK_NARRATIVE = `
A QUESTION for Justin is a bead (type question, labels \`ask\` + \`sid:<id>\`),
filed in the session's beads DB. Its parent is the session bead; --to links it
to a request (else the session's only in-progress request is linked), as a
\`to:\` label — never as its parent, so an optional question never keeps a
request open. File it the moment you need the answer, then keep working: it
does not block the turn.

  thread ask "Which database should the export use?" --priority 2 \\
      --context "The nightly export reads every table." \\
      --option "Postgres: already running" --option "SQLite: no server" \\
      --recommend a --default "I use Postgres."

PRIORITY (unchanged from the status-report rule): P0 = the session stops
without the answer, so it has NO --default; P1–P3 go on with the --default;
P4 = FYI, no default needed. Options: none, or two or more. --do marks
something Justin has to do; --approve a yes/no.

REFUSED (exit 2, one line): no --priority; a P0 with --default; a P1–P3
without one; exactly one --option; --recommend naming a missing option; a
question over 200 characters (put the detail in --context); a --header over
12 characters.

Prints the bead id and the question exactly as Justin will see it.`;

const STATUS_NARRATIVE = `
Run it BEFORE YIELDING on a work turn (status report v4). It prints, in order:

  SESSION BEADS: ENABLED | DISABLED   ← DISABLED: write the legacy text report
  Part 1, ready to paste at the top of your final message: the session, its
      status, progress, repo, branch, context, your first message, the
      requests with their stages and children, the open questions, and how
      to resume it — every line generated from the beads, git, the message log
      and the transcript, never typed
  What to mark — ONLY what cannot be derived: a request whose children are
      all closed but which is still open; commits or uncommitted edits with
      no request filed; a session still titled with the first prompt's line
      — or "Nothing to mark." When stopping would leave ⚠️ open work, one
      entry per open request: close it (work done) or file the P0 that
      blocks it / hand off (not done).
      When a request is finished: br close <id> --reason "…". Your open
      questions to Justin never keep it open.
  If you stop now the inbox will say: <status> — for ⚠️ open work also what
      that leads to (Justin is told to resume the session) and the way out

The status is derived (epic D2), most urgent first: 🛑 waiting on you (an open
P0) · 🏃 working (shown by thread show, never here) · 🤝 handed off · 🧯 out
of context · ✅ done · 💬 answered (no request, no commit, clean tree) · ❔
unknown (something could not be measured — never "answered") · ⚠️ open work,
no blocker. Optional questions are counted beside it, never part of it.

Exit 0 printed (DISABLED too) · 1 no session bead / sessions index unreadable.`;

const SHOW_V4_NARRATIVE = `
WITH componentConfig.thread.sessionBeads ON (status report v4):
  thread show [session bead | request or question id | --session <uuid>]
prints Part 1 LIVE (the same generated block thread status prints, with 🏃
when the session is running), then "From Claude:" — the last message Claude
yielded, with any pasted Part 1 removed (it was stale the moment it was
pasted) — then "Your messages:", every prompt, newest last, each cut at 400
characters (--full: uncut). A request or question id is resolved to its
session through its sid: label. --messages still prints the legacy log view.`;

const STAGE_NARRATIVE = `
Marks how far a REQUEST got, as \`stage:<name>\` labels on the request bead:

  thread stage <request id> tested built     marks both
  thread stage <request id> built --unset    removes one

Names come from componentConfig.thread.stages, in order (default: code-done,
tested, built, link-sent, approved); any other name is refused and the ladder
printed. Mark only what really happened: nothing below a stage is filled in.
Part 1 shows the highest stage reached and the next one.`;

const SESSION_ANSWER_NARRATIVE = `
WITH componentConfig.thread.sessionBeads ON (status report v4), this command
answers the session's QUESTION beads instead, in this terminal:
  thread answer [session bead id | session id | question id]
      walks the open questions, most urgent first: type an answer, press
      Enter to skip (it stays open), or d to take the default (not for a P0).
  thread answer --ask <question id> "<answer>"
      answers one question without a prompt.
Each answer is the question bead's close reason, "answer: <text>".`;

/** A repeatable string flag as a list (never greedy: see the ask options). */
function repeated(value: unknown): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** A variadic positional as words; yargs may hand back numbers. */
function positionalWords(value: unknown): string[] {
  return repeated(value);
}

/** Is componentConfig.thread.sessionBeads on for the current directory? */
async function sessionBeadsOn(): Promise<boolean> {
  const {resolveThreadConfig} = await import('./config');
  return resolveThreadConfig({cwd: process.cwd(), env: process.env})
    .sessionBeads;
}

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
        'Create this session’s thread bead by hand, before it has reported anything. `thread capture` normally does this on the first prompt. Idempotent. Needs componentConfig.thread.enabled.',
        (yy) =>
          yy
            .epilogue(START_NARRATIVE)
            .option('hook', {
              default: false,
              describe:
                'RETIRED SessionStart hook mode: INERT — exits 0 at once, reads nothing, creates nothing, prints nothing (home-base-39co9)',
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
            process.exit(runThreadStartHook());
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
              default: true,
              describe:
                'Print everything: every ask, every answer, work product, beads touched, every What I did item, and the full last message. This is the default (Justin, 2026-10-07: "by default I am showed EVERYTHING"); the flag is kept so older rule text and habits still work.',
              type: 'boolean' as const,
            })
            .option('compact', {
              default: false,
              describe:
                'Print only the must-see part (P0/P1 asks and mistakes). The default until 2026-10-07; it hid answers and lower-priority asks, which is why it is now opt-in.',
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
              full: argv.compact !== true,
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
            .option('line-ms', {
              describe:
                'INTERNAL — with --apply: what the hook spent building the session context line (componentConfig.thread.sessionBeads), recorded in capture.jsonl as contextLineMs',
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
            // F2 (home-base-vzwbj.4.9): no --cwd (a hand run) → this
            // directory, said in capture.jsonl.
            const cwdGiven =
              argv.cwd != null && argv.cwd !== '' ? argv.cwd : null;
            process.exit(
              await capture.runThreadCaptureApply({
                contextLineMs:
                  argv['line-ms'] != null && Number.isFinite(argv['line-ms'])
                    ? argv['line-ms']
                    : null,
                cwd: cwdGiven ?? process.cwd(),
                cwdDefaulted: cwdGiven == null,
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
        'nudge',
        'Hook (PostToolUse, matcher Bash): after a `git commit` in a session with no request in progress, put ONE line into Claude’s context saying so — at most once per turn. Reads the payload on stdin. Never blocks; always exits 0. Needs componentConfig.thread.sessionBeads; componentConfig.thread.nudge (default true) silences it.',
        (yy) =>
          yy.epilogue(NUDGE_NARRATIVE).option('explain', {
            default: false,
            describe: 'Print the decision (speak or silent, and why) to stderr',
            type: 'boolean' as const,
          }),
        async (argv) => {
          const {runThreadNudgeHook} = await import('./nudge');
          process.exit(
            await runThreadNudgeHook({explain: argv.explain === true}),
          );
        },
      )
      .command(
        'request [title..]',
        'File what Justin asked for as a REQUEST bead under this session’s bead, in the session’s own beads DB (or adopt an existing bead with --bead). The first request also names the session. Needs componentConfig.thread.sessionBeads. Exit 0 filed · 1 refused or failed · 2 usage.',
        (yy) =>
          yy
            .epilogue(REQUEST_NARRATIVE)
            .positional('title', {
              describe:
                'The request in plain words, e.g. "fix the login bug". Several words are joined into one title.',
              type: 'string' as const,
            })
            .option('bead', {
              describe:
                'Adopt this existing bead as the request instead of creating one (looked up in the session’s DB, then the current directory’s)',
              type: 'string' as const,
            })
            .option('continues', {
              describe:
                'This session picks up from that SESSION bead (the handoff block names it): labels this session’s bead continues:<id> and that one continued-by:<this>. Alone, it only links; with a title or --bead it also files the request.',
              type: 'string' as const,
            })
            .option('done-when', {
              describe:
                'With a title: the new request’s acceptance criteria — what "done" means',
              type: 'string' as const,
            })
            .option('here', {
              default: false,
              describe:
                'File in the CURRENT directory’s beads instead of the session’s (needed when the session’s checkout is gone); that DB is recorded for the session',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id to file under (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadRequest} = await import('./request');
          const words = (argv.title as string[] | string | undefined) ?? [];
          const title = (Array.isArray(words) ? words : [words]).join(' ');
          process.exit(
            await runThreadRequest({
              bead: argv.bead ?? null,
              continues: argv.continues ?? null,
              doneWhen: argv['done-when'] ?? null,
              here: argv.here === true,
              sessionId: argv.session ?? null,
              title: title === '' ? null : title,
            }),
          );
        },
      )
      .command(
        'handoff',
        'Hand this session on: label its bead handed-off (the inbox then says 🤝), append a dated "handed off — <note>" to its notes, and print a block to paste into the new session (title, requests with status and stage, open questions, how to resume, and the `thread request --continues` the new session runs first). Needs componentConfig.thread.sessionBeads. Exit 0 handed off · 1 failed (or handed off with a follow-up problem).',
        (yy) =>
          yy
            .option('note', {
              describe:
                'What the next session must know, one line (appended to the session bead’s notes with a timestamp, and printed in the block)',
              type: 'string' as const,
            })
            .option('to', {
              describe:
                'The successor’s Claude session id; when it already has a session bead the two are linked now (continued-by:/continues:)',
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'Session id to hand off (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadHandoff} = await import('./session-handoff');
          process.exit(
            await runThreadHandoff({
              note: argv.note ?? null,
              sessionId: argv.session ?? null,
              to: argv.to ?? null,
            }),
          );
        },
      )
      .command(
        'title <title..>',
        'Rename this session’s bead (and drop its auto-title label). Overrides the name the first request gave it. Needs componentConfig.thread.sessionBeads.',
        (yy) =>
          yy
            .positional('title', {
              describe: 'The new session title. Several words are one title.',
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'Session id to rename (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadTitle} = await import('./request');
          const words = (argv.title as string[] | string | undefined) ?? [];
          process.exit(
            await runThreadTitle({
              sessionId: argv.session ?? null,
              title: (Array.isArray(words) ? words : [words]).join(' '),
            }),
          );
        },
      )
      .command(
        'ask <question..>',
        'File a question for Justin as a bead (type question, labels ask + sid:<id>) under this session’s bead, the moment you need it — it does not block. --to links it to a request. P0 = the session stops without it (no --default); P1–P3 need --default; P4 = FYI. Needs componentConfig.thread.sessionBeads. Exit 0 filed · 1 no session/br failed · 2 the ask is invalid.',
        (yy) =>
          yy
            .epilogue(ASK_NARRATIVE)
            .positional('question', {
              describe:
                'The question, one line, at most 200 characters. Several words are one question.',
              type: 'string' as const,
            })
            .option('priority', {
              alias: 'p',
              describe:
                'REQUIRED. 0 = I cannot go on without it · 1–3 = I go on with my --default · 4 = FYI',
              type: 'string' as const,
            })
            .option('header', {
              describe: 'A short tag, at most 12 characters (e.g. "Export DB")',
              type: 'string' as const,
            })
            .option('context', {
              describe:
                'One bullet of context Justin needs to answer without remembering the session. Repeat for more.',
              type: 'string' as const,
            })
            .option('option', {
              describe:
                'A choice, "<Label>: <why>" (split on the first ": "). None, or two or more. Repeat for each.',
              type: 'string' as const,
            })
            .option('recommend', {
              describe: 'The letter of the option you recommend (a, b, …)',
              type: 'string' as const,
            })
            .option('default', {
              describe:
                'What you will do if Justin never answers. Required for P1–P3, refused for P0.',
              type: 'string' as const,
            })
            .option('to', {
              describe:
                'The request this question is for (default: the session’s only in-progress request). A to: label, not the parent — the parent is always the session bead. Looked up in the session’s DB, then the current directory’s.',
              type: 'string' as const,
            })
            .option('do', {
              default: false,
              describe:
                'Something Justin has to DO (test on a device, run a command)',
              type: 'boolean' as const,
            })
            .option('approve', {
              default: false,
              describe: 'A yes/no approval',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id to file under (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadAsk} = await import('./ask');
          process.exit(
            await runThreadAsk({
              approve: argv.approve === true,
              context: repeated(argv.context),
              default: argv.default ?? null,
              do: argv.do === true,
              header: argv.header ?? null,
              options: repeated(argv.option),
              priority: argv.priority ?? null,
              question: positionalWords(argv.question).join(' '),
              recommend: argv.recommend ?? null,
              sessionId: argv.session ?? null,
              to: argv.to ?? null,
            }),
          );
        },
      )
      .command(
        'answers',
        'What Justin answered since you (Claude) last yielded, each question restated in full with his answer verbatim. "No new answers." means checked. Needs componentConfig.thread.sessionBeads (otherwise use thread inbox). Exit 0 read · 1 could not read.',
        (yy) =>
          yy
            .option('all', {
              default: false,
              describe:
                'Every answered question of the session, not only the new ones',
              type: 'boolean' as const,
            })
            .option('session', {
              describe: 'Session id (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadAnswers} = await import('./answers');
          process.exit(
            await runThreadAnswers({
              all: argv.all === true,
              sessionId: argv.session ?? null,
            }),
          );
        },
      )
      .command(
        'status',
        'Before yielding on a work turn: print Part 1 of the status report (generated, ready to paste), what you still have to mark, and what the inbox will say if you stop now. "Nothing to mark." on a question-only turn. SESSION BEADS: DISABLED (exit 0) when componentConfig.thread.sessionBeads is off. Exit 0 printed · 1 no session bead.',
        (yy) =>
          yy.epilogue(STATUS_NARRATIVE).option('session', {
            describe: 'Session id (default: $CLAUDE_CODE_SESSION_ID)',
            type: 'string' as const,
          }),
        async (argv) => {
          const {runThreadStatus} = await import('./session-report');
          process.exit(
            await runThreadStatus({sessionId: argv.session ?? null}),
          );
        },
      )
      .command(
        'stage <request> <stages..>',
        'Mark how far a request got: label it stage:<name> for each name (from componentConfig.thread.stages; default code-done, tested, built, link-sent, approved). --unset removes. A name off the ladder is refused with the ladder printed. Needs componentConfig.thread.sessionBeads. Exit 0 marked · 1 not found/failed · 2 usage.',
        (yy) =>
          yy
            .epilogue(STAGE_NARRATIVE)
            .positional('request', {
              describe: 'The request bead id',
              type: 'string' as const,
            })
            .positional('stages', {
              describe: 'One or more stage names from the ladder',
              type: 'string' as const,
            })
            .option('unset', {
              default: false,
              describe: 'Remove these stages instead of marking them',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id whose beads DB to look in first (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadStage} = await import('./session-stage');
          process.exit(
            await runThreadStage({
              request: argv.request ?? null,
              sessionId: argv.session ?? null,
              stages: positionalWords(argv.stages),
              unset: argv.unset === true,
            }),
          );
        },
      )
      .command(
        'note <text..>',
        'Justin’s mark: append a dated line ("- YYYY-MM-DD HH:mm: <text>") to this session’s bead notes. Never a comment. Needs componentConfig.thread.sessionBeads.',
        (yy) =>
          yy
            .positional('text', {
              describe: 'The note. Several words are one note.',
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'The session: its session bead id or its claude session id (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadNote} = await import('./session-marks');
          process.exit(
            await runThreadNote({
              session: argv.session ?? null,
              text: positionalWords(argv.text).join(' '),
            }),
          );
        },
      )
      .command(
        'archive [sessionBead]',
        'Justin’s mark: close the session, its open requests and its open questions with "archived: <why>", and label the session bead archived. Your mark is final: beads with open children are closed anyway (br --force) and the children that stay open are listed. Needs componentConfig.thread.sessionBeads. Exit 0 closed · 1 something was not closed · 2 usage.',
        (yy) =>
          yy
            .positional('sessionBead', {
              describe:
                'The session bead id (or the claude session id). Omit for this session.',
              type: 'string' as const,
            })
            .option('reason', {
              describe: 'REQUIRED: why it is archived',
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'Look up by this claude session id instead of the current one (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runSessionClose} = await import('./session-marks');
          process.exit(
            await runSessionClose('archive', {
              reason: argv.reason ?? null,
              selector: argv.sessionBead ?? null,
              sessionId: argv.session ?? null,
            }),
          );
        },
      )
      .command(
        'show [threadId]',
        'Print a thread bead as its status report, plus the CURRENT open asks and Justin’s answers on them. With no id, this session’s thread. With componentConfig.thread.sessionBeads ON: Part 1 live, Claude’s last message, and your messages, for a session bead, a request or question id, or --session.',
        (yy) =>
          yy
            .epilogue(SHOW_V4_NARRATIVE)
            .positional('threadId', {
              describe:
                'Thread bead id (e.g. jl-x7q). Omit for this session. Knob on: a session bead id, a session id, or a request/question id.',
              type: 'string' as const,
            })
            // NO default: the legacy handler never read `full` (it prints in
            // full unless --compact), and with the knob on an explicit --full
            // is what uncuts your messages (home-base-vzwbj.4.3).
            .option('full', {
              describe:
                'Legacy: the stored report is printed in full by default (Justin, 2026-10-07); the flag is kept so older habits work. Knob on: print your messages uncut instead of cut at 400 characters.',
              type: 'boolean' as const,
            })
            .option('compact', {
              default: false,
              describe:
                'Print only the must-see part (P0/P1 asks and mistakes). The default until 2026-10-07; now opt-in.',
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
          if (argv.messages !== true && (await sessionBeadsOn())) {
            const report = await import('./session-report');
            // R8 (home-base-vzwbj.4.9): a legacy thread id v4 cannot resolve
            // falls through to the legacy handler below.
            if (
              !report.routesToLegacyThread({
                cwd: process.cwd(),
                env: process.env,
                selector: argv.threadId ?? null,
              })
            ) {
              process.exit(
                await report.runSessionShow({
                  full: argv.full === true,
                  selector: argv.threadId ?? null,
                  sessionId: argv.session ?? null,
                }),
              );
            }
          }
          const {runThreadShow} = await import('./show');
          process.exit(
            await runThreadShow({
              full: argv.compact !== true,
              messages: argv.messages === true,
              sessionId: argv.session ?? null,
              threadId: argv.threadId ?? null,
            }),
          );
        },
      )
      .command(
        'answer [threadId..]',
        'Answer this thread’s open asks. Opens a local page where drafts autosave to disk and no key discards text; --classic walks them in the terminal instead. With componentConfig.thread.sessionBeads ON: walks the session’s open QUESTION beads in this terminal (text answers, Enter skips, d takes the default), or --ask <id> "<text>" answers one. Exit 0 recorded · 1 a write failed · 2 nothing recorded / usage.',
        (yy) =>
          yy
            .epilogue(`${ANSWER_NARRATIVE}\n${SESSION_ANSWER_NARRATIVE}`)
            .positional('threadId', {
              describe:
                'Thread bead id. Omit for this session’s thread. Knob on: a session bead id, a session id or a question id — or, with --ask, the answer text.',
              type: 'string' as const,
            })
            .option('ask', {
              describe:
                'Knob on: answer this one question bead with the words that follow, no prompt',
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
          const target = positionalWords(argv.threadId);
          // R8 (home-base-vzwbj.4.9): a legacy thread id v4 cannot resolve
          // goes to the legacy answer flow below, knob on or off.
          const legacy =
            argv.ask == null &&
            (await import('./session-report')).routesToLegacyThread({
              cwd: process.cwd(),
              env: process.env,
              selector: target[0] ?? null,
            });
          if (!legacy && (await sessionBeadsOn())) {
            const {runSessionAnswer} = await import('./session-answer');
            process.exit(
              await runSessionAnswer({
                ask: argv.ask ?? null,
                selector: argv.ask != null ? null : (target[0] ?? null),
                sessionId: argv.session ?? null,
                text: argv.ask != null ? target.join(' ') : null,
              }),
            );
          }
          if (argv.ask != null) {
            console.error(
              'thread answer --ask: needs componentConfig.thread.sessionBeads (status report v4); with it off, run thread answer without --ask',
            );
            process.exit(2);
          }
          const {runThreadAnswerUi} = await import('./answer-ui');
          process.exit(
            await runThreadAnswerUi({
              classic: argv.classic === true,
              latest: argv.latest === true,
              sessionId: argv.session ?? null,
              threadId: target[0] ?? null,
              ui: (argv.ui as string | undefined) ?? null,
            }),
          );
        },
      )
      .command(
        'inbox [threadId]',
        'With componentConfig.thread.sessionBeads ON: your dashboard — every session you started (last 30 days) as one card each, newest activity first, after a summary that counts the sessions per section (Needs you, To land, Stopped with work open, Check by hand, Working, Handed off or out of context, Answered, Done with questions for you, Not tracked; --all adds Done and Archived). Each card says what you asked for, where it stands (status and the git facts that matter), the ONE thing you need to do, any optional questions and how to resume it. Not tracked: every other Claude Code session under ~/Dev in the window (no session bead; found the way `repo-status repos` finds them), shown from facts only — a full card when something is open (a branch not merged, uncommitted files, working now, out of context, a blocking question in its old report) or could not be read, else one line saying nothing open was found. --by-status groups the cards by section, --by-repo by repo. A session that cannot be read is a ❔ card, never dropped. Knob OFF (legacy): what Justin answered or skipped since the last report, each ask restated in full. Marks nothing.',
        (yy) =>
          yy
            .positional('threadId', {
              describe:
                'Legacy only: thread bead id. Omit for this session’s thread.',
              type: 'string' as const,
            })
            .option('json', {
              default: false,
              describe:
                'Print the inbox as JSON (knob on: one record per session, newest first — its card with every field, the action line and its rule, the section, the git facts, `tracked` and `display` (card or line), and the session model with the message log summarised, or for an untracked session the facts it was read from — plus the summary counts)',
              type: 'boolean' as const,
            })
            .option('days', {
              default: 30,
              describe:
                'Knob on: sessions with activity in the last N days (an undated tracked session is always listed; an untracked one is in the window when its transcript was last written inside it)',
              type: 'number' as const,
            })
            .option('all', {
              default: false,
              describe: 'Knob on: include the Done and Archived sections',
              type: 'boolean' as const,
            })
            // No `default: false` on these two: yargs counts a default as
            // given, and `.conflicts` would then refuse every run.
            .option('by-status', {
              describe:
                'Knob on: group the cards by section (Needs you first), newest first inside each',
              type: 'boolean' as const,
            })
            .option('by-repo', {
              describe:
                'Knob on: group the cards by repo, newest first inside each',
              type: 'boolean' as const,
            })
            .conflicts('by-status', 'by-repo')
            .option('flat', {
              default: false,
              describe:
                'Knob on: the default one newest-first list (kept so older invocations still work)',
              type: 'boolean' as const,
            })
            .option('repo', {
              describe:
                'Knob on: only this repo (its name, as git names it, or a checkout path)',
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
          if (await sessionBeadsOn()) {
            const {runSessionInbox} = await import('./session-inbox');
            process.exit(
              await runSessionInbox({
                all: argv.all === true,
                days: argv.days,
                json: argv.json === true,
                order:
                  argv['by-status'] === true
                    ? 'status'
                    : argv['by-repo'] === true
                      ? 'repo'
                      : 'recent',
                repo: argv.repo ?? null,
              }),
            );
          }
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
              describe:
                'Why it is done (default: "thread closed by Justin"; knob on: written as "done: Justin — <reason>")',
              type: 'string' as const,
            })
            .option('session', {
              describe: 'Look up by this session id instead of the current one',
              type: 'string' as const,
            }),
        async (argv) => {
          if (await sessionBeadsOn()) {
            if (argv.latest === true) {
              console.error(
                'thread done --latest: not available with componentConfig.thread.sessionBeads on; name the session bead, or run it from the session',
              );
              process.exit(2);
            }
            const {runSessionClose} = await import('./session-marks');
            process.exit(
              await runSessionClose('done', {
                reason: argv.reason ?? null,
                selector: argv.threadId ?? null,
                sessionId: argv.session ?? null,
              }),
            );
          }
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
  // home-base-vzwbj.4.16 G3: the v4 design first; the legacy store second.
  describe:
    'Status reports as beads. With componentConfig.thread.sessionBeads on (status report v4): a session bead in the repo’s own beads on the first prompt, a request bead for each thing Justin asks for, each question for Justin a bead under the session bead, and Part 1 of the report generated by `thread status`. With it off: the legacy thread beads, one per session, in the shared threads store.',
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
