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

import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {helpHeader} from '../sdk-identity';
import {SDK_BIN_BY_PATH, SDK_HANDOFF_CALL} from '../sdk-invocation';

const HANDOFF_SUMMARY =
  'Hand this session on: label its bead handed-off (the inbox then says 🤝), append a dated "handed off — <note>" to its notes, and print a block for the next session (title, requests with status and stage, open questions, how to resume, and the `thread request --continues` the new session runs first). With componentConfig.thread.handoff.successor on, it also starts that next session in a new tab of this cmux workspace, or refuses and says why. Needs componentConfig.thread.sessionBeads. Exit 0 handed off (and the successor started) · 1 a step failed · 2 nothing written · 3 refused by the handoff gate.';

const HANDOFF_NARRATIVE = `
THE KNOB. componentConfig.thread.handoff.successor, default false (epic home-base-mbnjv D10). OFF: thread handoff labels, notes and prints the block, exactly as before, and starts nothing; --dry-run and --model are refused (exit 2). ON, it also starts the successor, in this order:

  1. Refuses (exit 2, nothing written) without a session bead, when this session's checkout is gone, or when --session names a session other than the one it runs in.

  2. The handoff gate: the kill switch, a cmux pane, cmux reachable, usage from the hourly samples, handoffs in a row since Justin last typed, live Claude sessions on this Mac. A refusal still hands the session off (label, note, block printed), records "handoff refused: <reason>" on the session bead, opens nothing, and exits 3.

  3. Finds this tab's pane (cmux tree, read only), hands off, and writes the block to <threads state dir>/handoffs/<session id>.md.

  4. Opens a new tab beside this one, in this workspace and this session's checkout, running claude --permission-mode <componentConfig.thread.handoff.permissionMode> --remote-control <name> --name <name> [--model <m>] '<kickoff>'. The kickoff tells the successor to read the block file and to run \`thread request --continues <this session's bead>\` first, which links the two sessions. This tab stays open.

  5. Reads the new tab's screen for up to 20 s. Claude Code's input box with no dialog means it started. A trust or permission dialog is reported with the screen, never answered.

  6. THE OLD TAB (componentConfig.thread.handoff.predecessor, default keep). keep leaves this tab running. exit (Claude Code here ends and the tab shows a tombstone) and close (the tab closes) are done later by a detached watcher, only after every check holds twice: the successor's bead links back to this one from the new tab (continues: and that tab's cmux-surface:), this session's turn has ended with nothing typed or run in it since, the tab still exists, and its screen shows Claude Code idle at an empty input box with THIS session's id in the status line as "⌗ <session id>". A status line that does not show "⌗ <session id>" means exit and close never act: after 20 minutes the tab is kept and its bead says "predecessor kept: handshake failed: screen". exit and close end everything still running in the tab, so hand off only with no background work running (no subagent, no background shell).

EXIT CODES, and what you do after each.

  0  Handed off, and the successor started. Write your final report now and end your turn. Do not keep working: the successor works in the same checkout.

  1  A step failed. The output says what WAS done: whether the session was handed off, where the block is, whether a tab opened. Finish your report, quote that output for Justin, and stop. Do not run thread handoff again.

  2  Nothing was written: the message says why. Fix the call if a flag was wrong, or if it says the call ran inside the Claude Code sandbox (cmux answered Operation not permitted), and run it once more; if exit 2 comes back again, put the output in your final report and stop. Never set dangerouslyDisableSandbox for it.

  3  The gate refused. The session WAS handed off and the refusal is recorded; nothing was opened. This is final: finish your report, include the printed handoff block for Justin, and stop. Never start a session another way: no cmux command, no claude command.

RUN IT BARE, from the repository root, where node_modules is: ${SDK_HANDOFF_CALL} --note "<what the successor must know>". The sandbox blocks the cmux socket, so the call must run outside it, through Justin's global sandbox exclusion (doctor's HANDOFF_SANDBOX). Three things keep the whole call inside the sandbox even where that exclusion exists: starting it with bun (Claude Code never excludes a \`bun run justin-sdk …\` call, home-base-mbnjv.9), a \`cd X && …\` prefix, and a redirect or a $(…) (home-base-pp1vx.5). A backtick in the note does the same, even inside single quotes (measured, home-base-mbnjv.10); every other character tested is fine. If ${SDK_BIN_BY_PATH} is not in the current directory, run \`cd <repository root>\` as its own Bash call first. If it is missing at the root too (no bun install yet), say so in your final report and stop.

--to <session id> means the successor already exists: the two sessions are linked, as before, with no gate and no new tab, whatever the knob says.

--dry-run (knob on) runs the gate and the pane lookup, both read only, and prints the gate's answer, the block path, the full cmux argument array and the kickoff. It writes nothing and opens nothing.`;

const QUOTA_SUMMARY =
  'Show the spend quota’s numbers for one session, read-only (request home-base-ys9t7.5, D9): the mode and each limit with the config layer that set it, the session’s group (its handoff and spawn chain) with each member’s bead, title and session, the group’s latest typed line, its unattended spend per model family in $ and percent of the week, the project’s last-24-hours spend, the week percent with its source and age, the verdict for a running session and for a handoff, and the time to each spend limit at the group’s average rate. Writes nothing, enforces nothing. Exit 0 printed (an unmeasurable piece is shown as UNKNOWN with why) · 2 no usable session id.';

const QUOTA_NARRATIVE = `
WHAT EACH PART MEANS.

  Group: the sessions linked to this one by handoff labels (continues:, continued-by:) and spawn labels (spawned-by:, spawned:). Its unattended spend is every request of every member, subagents included, dated after the latest line Justin typed in any member. With no typed line, every request counts.

  Project, last 24 hours: every transcript of this repo and its worktrees, requests in the last 24 hours and after Justin's latest typed line anywhere in the project.

  Week percent: the all-models week from the newer of the statusline store's live.json (~/.local/state/claude-usage/live.json) and the hourly /usage samples (~/.local/share/claude-usage/samples.jsonl); each per-model week from the samples only. Older than componentConfig.thread.handoff.usage.maxSampleAgeMinutes is unknown.

  Verdict: fine, OVER (with each limit crossed) or UNKNOWN (with why). The week floor applies to a handoff always, and to a running session only when Justin last typed in the group more than attendedGraceMinutes ago. The mode decides what a verdict does; this command only shows it.

  Time to each spend limit: how long the group has been unattended (since its latest typed line) and when it would reach the chain limit and the project limit at its average rate since then. None when nothing was spent or the limit is already reached. The project projection ignores spend leaving the rolling 24 hours, so it is the early side.

OUTPUT. A terminal gets colour and wrapping; a pipe gets neither, and NO_COLOR turns colour off. --json prints the same report as one object.

COST. It runs br show once per group member and reads every member's transcripts and the project's transcripts from the last 24 hours: about a second or two.`;

const RESPAWN_RETIRED_SUMMARY =
  'RETIRED (epic home-base-mbnjv C3): starting a successor is now `thread handoff` with componentConfig.thread.handoff.successor on. This command prints that and exits 2, doing nothing.';

const SPAWN_SUMMARY =
  'Start a new Claude Code session in a directory you name: open a new cmux workspace there running `claude`, with Remote Control when you pass --remote-control, so you can reach it from the Claude app on your phone (home-base-yukaf.7). Try --dry-run first. With componentConfig.thread.handoff.successor on in the repo it runs in, the handoff gate runs first (kill switch, cmux, usage, live sessions). Exit 0 opened, or a dry run · 1 cmux did not open it · 2 refused, nothing opened · 3 refused by the handoff gate, nothing opened.';

const SPAWN_NARRATIVE = `
WHAT IT DOES, in order.

  1. Refuses (exit 2, nothing opened) when the directory does not exist or is not a directory. A leading ~ means your home directory; a relative path is read from the current directory.
  2. Names the workspace "[TAG] new session <directory name>", or "[TAG] <name>" with --name. TAG is the projectTag in that repo's justin-sdk.config.json, else the repo folder name in capitals, the same tag the inbox shows.
  3. Refuses (exit 2) when cmux cannot be reached, and prints the sandbox setting that allows it (see SANDBOX HINT).
  4. Opens a new cmux workspace in the directory, without switching to it, running \`claude [--model <m>] [--remote-control '<workspace name>'] ['<kickoff>']\`. With --kickoff or --kickoff-file the session starts on that prompt with no keystroke; without them it opens on an empty prompt.
  5. Prints the workspace, its cmux id, the directory and the command. With --remote-control it also says how to open the session from your phone.

REMOTE CONTROL. The session runs on this Mac; the Claude app on your phone, or claude.ai/code, is a window onto it. Open the Claude app, tap Code, and pick the session by the name this command prints. The claude process in the workspace must keep running: closing the workspace or quitting claude takes the session offline. A Mac that sleeps reconnects when it wakes.

DRY RUN. --dry-run prints the same plan, the cmux socket it would use and the full cmux command, and does not touch cmux.

IT WRITES NOTHING. Opening the workspace is its only effect: no file, no bead, no record.

WINDOW. With CMUX_WINDOW_ID set, the workspace goes to that window (--window). Otherwise cmux picks: its default is the window of the pane the command runs in. The output's Window line says which.

FOLDER TRUST. It reads (never edits) ~/.claude.json and warns when Claude Code has not recorded the trust dialog as accepted for that exact folder: the new session may then show a trust prompt that only the Mac can answer.

SANDBOX HINT. The Claude Code sandbox blocks the cmux socket. When cmux cannot be reached, the refusal prints the setting that allows it, {"sandbox":{"network":{"allowUnixSockets":["<socket path>"]}}}, for your Claude Code user settings. Otherwise retry the command with the sandbox disabled.`;

const STOP_OPTION_TEXT =
  'After the mark is written and printed, stop this session’s Claude process: SIGTERM from a detached child, re-checked right before the signal. The target is a process whose command line names the session (claude --resume <id>), 3 s later; or, when the session is the one this command runs in (CLAUDE_CODE_SESSION_ID), the Claude process above this command, 15 s later, so the reply lands first. A process the cmux hook store or claude agents --json maps to another session is never signalled; when either cannot be read, nothing is stopped (exit 1). The cmux pane stays open; resume with claude --resume <id>. Needs ps and claude agents (run with the sandbox off). Logged to ~/.local/state/justin-threads/session-stops.jsonl. Unverified: whether the detached child survives the Bash tool that started it; the first real /thread-archive measures it.';

const OPEN_SUMMARY =
  'Reopen every unfinished session from the last 7 days (--since, --repo and --limit narrow it) in cmux: one new window with one workspace per session, newest at the top, each running `claude --resume` in its own checkout. Sessions that are finished, already open, or untracked are not opened. Try --dry-run first. --undo closes what the latest run opened, but keeps any workspace with unsent text, Claude working, or use since the run. It exits 0 when it opened the sessions, found nothing to open, or ran dry; 1 when a step failed; 2 when it refused and opened nothing.';

const OPEN_NARRATIVE = `
WHAT REOPENS. A session reopens when all three are true:

  1. The inbox puts it in Unsent text in the input box, Needs you, To land, Stopped with work open, or Check by hand. --include answered,handedOff,doneQuestions adds those sections too.

  2. It has a session bead (it is tracked) and had activity in the window: the last 7 days unless --since or componentConfig.thread.openSince says otherwise.

  3. Nothing shows it running. thread open looks three ways: the claude processes and their command lines, cmux's hook store, and the session id on the status line of every live Claude pane.

WHAT NEVER REOPENS.

  - A session that is running now: it is listed under Already open, with the command that selects its pane.

  - Working, Done and Archived sessions, and sessions with no session bead (only counted).

  - A session whose checkout no longer exists, because claude --resume finds nothing from the wrong directory.

FILTERS. Think of thread open as a filter over your sessions, and the new cmux window as the view it shows. The plan's header names every filter, set or not.

  --since 24h|3d|2w: the window (hours, days, weeks). Default componentConfig.thread.openSince ("7d"). --days N is the same as --since Nd. Any other shape is refused (exit 2).

  --repo <name>: only sessions in that repo, by its folder name or its project tag, any case. Repeat it for several. A name that matches nothing is said.

  --limit N: at most N sessions, newest first (opened and moved together). The rest are listed under "Not opened: over the limit".

  --include-open: a session already open in another cmux window is still never resumed a second time. Its existing workspace is MOVED into the new window instead (it keeps running), so all the matching sessions sit in one place. Without the flag those sessions are listed under "Already open elsewhere", with the command that selects each pane. The whole workspace moves, its other panes (shell splits and the like) with it, and the plan says "moved with its N other panes". A session with no cmux workspace (a background worker, a terminal cmux does not own), whose workspace holds another Claude session too, or whose workspace is the one this command runs in (CMUX_WORKSPACE_ID), is never moved and says why. A move that empties a window leaves a blank workspace there, which the plan says and --undo closes again while it holds only an idle shell.

CANNOT TELL. When a live Claude pane does not show which session it holds, thread open opens nothing: that pane could be one of the sessions it would open. It lists those panes; look at them, then pass --force-unplaced to open anyway.

LAYOUT. Default: one new cmux window. --per-project: one new window per project, the project with the newest session first. Inside a window the newest session is at the top. Each workspace is named "[TAG] <session title>".

COLOURS. After a window is built, each workspace this run OPENED gets its project's colour the way cmux-arrange chooses it: from ~/.config/cmux-arrange/colors.json ($XDG_CONFIG_HOME/cmux-arrange/colors.json) "overrides" first, then "assigned", then cmux-arrange's built-in project colours unless the file's "exclude" lists that colour; with no file, the built-in project colours alone. thread open makes no new picks. A workspace moved in with --include-open keeps the colour it had: --undo moves it back but cannot restore a colour. An unreadable or invalid file colours nothing. Each of these, and a project with no colour, is said in one line and the run goes on; a colour that cannot be set is reported and never stops the run. --no-color skips colouring.

RESTORED DRAFTS. When a session it opens has unsent text stored (thread drafts lists it; <threads state dir>/input-drafts/<session id>.json), that text is typed back into the new workspace's input box, and NEVER sent: press Enter there yourself. It waits up to 30 s for Claude to show an empty input box with that session's id under it, types the text in one cmux send (no Enter), and reads the screen again to see it there. Line breaks become spaces, because a line break typed into the box would press Enter, so the text goes in on one line. It is never typed when the box already holds text or shows Claude Code's suggested next prompt, the pane shows another session, vim is in NORMAL mode, the text holds a backslash (cmux send reads \\n and \\r as Enter), a control character or a "[Pasted text #N]" stand-in, or the text's original pane is still open (then the output gives the command that selects it). Each draft not restored is printed in full under "⚠️ Draft not restored", with why: the screen could not be read, the box never appeared, the text was typed but the box does not show it, and so on. Only workspaces this run opened are typed into, never moved ones. --no-restore skips it; --dry-run says which drafts it would restore and types nothing. A restored draft keeps its text in the store, with restoredAt, restoredSurfaceId and restoredText added. It is unsent text in the box, so thread open --undo keeps that workspace open.

DRY RUN. --dry-run prints the same plan ("Would open") and opens nothing, writes nothing.

THE RECORD. Before it opens anything, a real run writes <threads state dir>/opens/<time>.json with the plan, and rewrites it after every cmux step with the ids of the windows and workspaces it made. If that file cannot be written, nothing is opened. --json prints the record. thread open --undo reads it.

UNDO. thread open --undo closes the workspaces the latest run opened (--run <time> picks another run by its record's file name). It never closes anything that run did not open. A workspace that is already closed is listed as Already gone. Every other one is checked first, and it is kept open, with the reason printed, unless all three checks pass:

  1. Nothing is typed in the input box. Unsent text keeps the workspace open, is printed in full under "✍️ Unsent text, kept open", and is saved in <threads state dir>/input-drafts/<session id>.json. A box showing only Claude Code's suggested next prompt passes, and its "Input box" line names the suggestion (thread close --help, LIMITS, says how it is told apart).

  2. Claude is not working (no spinner, no "Running…" on the screen).

  3. The session has not been used since the run opened it: its last message is not newer than the run.

  A screen that cannot be read, or a last message that cannot be read, keeps the workspace too. So does a pane that shows a different session or no session id at all, Claude with no process that can be found, and a pane whose terminal cannot be matched to its processes (even a blank one: cmux shows a blank screen for a pane that has not drawn yet). A pane where Claude never started (an idle shell prompt or a blank screen, with only the shell running on its terminal) passes.

  A workspace that passes has its Claude process stopped first (SIGTERM, up to 15 seconds to exit; the session stays resumable with claude --resume), and only then is the workspace closed. A window closes with its last workspace. The record is rewritten before the first process is stopped; if that fails, nothing is stopped or closed. --undo --dry-run runs the same checks and prints what would close and what would be kept; it closes nothing and writes nothing. It exits 1 when there is no run to undo or a step failed.

RUNS AS A VIEW. A filtered thread open makes a window appear (for example thread open --repo audio-journal-1 --include-open: all of that repo's unfinished work in one new window), and thread open --undo --run <stamp> makes it disappear again: what it opened closes, what it moved goes back. thread open --list prints every recorded run with its stamp, filters, counts, whether it was undone, and the command that undoes it. --list reads the records only: no cmux, no ps.

SANDBOX. The Claude Code sandbox blocks the cmux socket and ps. Run it from a terminal, or with the sandbox disabled.`;

const CLOSE_SUMMARY =
  'Close the cmux workspaces you name, by uuid (from cmux tree --id-format both) or workspace:N, or by the session they hold (--session <id>). Each one is checked first and kept open, with the reason printed, unless nothing could be lost; its Claude process is stopped before the workspace closes, and a resume command for it is written down first. Try --dry-run first. It exits 0 when done (kept workspaces included), 1 when a step failed, 2 when it refused and touched nothing.';

const CLOSE_NARRATIVE = `
THE CHECKS. Every pane of the workspace is read, and the workspace is kept open unless every pane passes all of these:

  1. Nothing is typed in the input box. Unsent text keeps the workspace open, is printed in full under "✍️ Unsent text, kept open", and is saved in <threads state dir>/input-drafts/<session id>.json. A box showing only Claude Code's suggested next prompt passes, and its "Input box" line names the suggestion (see LIMITS).

  2. Claude is not working (no spinner, no "Running…" on the screen).

  3. The screen can be read, and the pane's terminal is known and no other pane reports it.

  4. The status line under the input box shows which session the pane holds (⌗ <session id>), and the Claude process on that terminal names the same session, on its command line or in the cmux hook store.

  A workspace holding more than one Claude session or more than one Claude process is kept, and so is a session whose resume command cannot be built from its transcript. A pane where Claude is not running passes only when it shows an idle shell prompt (or a blank screen) with nothing else running on its terminal. These are the checks thread open --undo uses, minus its "used since the run" check: a named close has no run to compare with.

THE RECORD. Before the first Claude process is stopped, one line per workspace that passed is appended to <threads state dir>/closes.jsonl: when, the workspace and window, the session, its title, repo and checkout, its Claude pid, and its resume command (cd '<checkout>' && claude --resume <id>), with outcome "closing". If those lines cannot be written, nothing is stopped or closed. After each workspace, one more line gives its outcome: closed, kept (with why), or failed. The resume command is printed for every closed workspace too, so every close can be undone by hand.

CLOSING. Right before its turn, each workspace is checked again; if anything changed, it is kept. Then its Claude process is stopped (SIGTERM, up to 15 seconds to exit, never SIGKILL; the session stays resumable), and only then is the workspace closed. A window closes with its last workspace, and the output says so.

NEVER CLOSED. The workspace this command runs in (CMUX_WORKSPACE_ID): naming it refuses the whole run, and nothing is touched. A --session that no live Claude process holds, that runs outside cmux, or that shows in more than one workspace refuses the run too. A workspace that is not open is listed under "Not found"; the others still go ahead.

LIMITS (measured 2026-10-22 on Claude Code 2.1.308, and read in its code back to 2.1.289):
  - The screen is read as plain text, without colours. Claude Code can draw a suggested next prompt, dimmed, in an EMPTY input box after a turn ("❯ push main"); pressing Enter on it sends nothing. On screen it looks exactly like typed text. Check 1 tells them apart only by the line under the box: while nothing is typed, Claude Code ends it with "← N agents", and drops it as soon as anything is typed. A box whose text has that line under it passes check 1, and nothing is stored for it.
  - Without that "← N agents" line (no agents running, or a Claude Code version without the hint) a suggestion cannot be told from typed text: it keeps the workspace open and is stored as unsent text.

--dry-run runs every check and prints what would close and what would be kept and why. It signals nothing, closes nothing, writes no record and stores no draft.

SANDBOX. The Claude Code sandbox blocks the cmux socket and ps. Run it from a terminal, or with the sandbox disabled.`;

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
const DRAFTS_NARRATIVE = `
WHAT IS STORED: one file per session, <threads state dir>/input-drafts/<session id>.json, holding the latest unsent text seen in that session's input box, when it was seen, which pane, and what saw it (scan, thread open --undo, or cmux-arrange --older-than refusing a close). When newer, different text replaces unsent text that was still live, the earlier text is kept in the same file under "previous" (the last 20). Sent messages are never stored here.

SCAN, read-only on cmux (it writes only that store):
  1. Reads every pane's screen and keeps the Claude input boxes.
  2. Places each one in a session by the "⌗ <session id>" your status line shows under the box, else by the claude process on the pane's tty. A pane it cannot place is listed under "Unplaced panes" with why, and nothing is stored for it.
  3. Text in the box is stored, unless the store already holds exactly that text. An empty box clears the stored draft only in the pane the draft was seen in, or once that pane is gone. A stored draft whose pane is gone (no pane shows its session, and the pane it was seen in is no longer in cmux) is cleared by the second scan in a row that finds it so; "thread drafts dismiss <session id…>" (x in the threads dashboard) clears one at once. Cleared text stays in its file. Text equal to the newest message you sent in that session (spacing ignored) is still in the box, so it is stored too, marked sentMatch, and its card says "(the same as your last sent message)". A stored draft whose pane is gone is cleared as sent when that session's newest sent message equals it (a sentMatch draft: only a message sent after it was seen).
  An hourly chore (thread-drafts-scan) runs it, and the threads dashboard runs it before loading.

CLAUDE'S SUGGESTION (measured 2026-10-22 on Claude Code 2.1.308, and read in its code back to 2.1.289): after a turn, Claude Code can draw a suggested next prompt, dimmed, in the EMPTY input box ("❯ push main"). It is not your typing: pressing Enter on it sends nothing (Tab would insert it as real text), and it stays until a prompt is sent. The scan reads the screen as plain text, without colours, so on screen it looks exactly like typed text. What tells them apart is the line under the box: while nothing is typed, Claude Code ends it with "← N agents" ("-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← 19 agents"), and drops it as soon as anything is typed. A box whose text has that line under it counts as empty: nothing is stored, a stored draft is cleared as for an empty box (the text stays in its file), and the pane is listed under "Claude's suggestion, not your typing" with the text.

LIMITS, measured on Claude Code 2.1.302 unless dated:
  - Without that "← N agents" line (no agents running, or a Claude Code version without the hint) a suggestion cannot be told from typed text, and is stored as if typed. An autocomplete Claude Code draws after your cursor is stored as typed too.
  - An empty box with no suggestion shows nothing after ❯ (1,029 input boxes in 24 cmux captures, 2026-10-17), so it reads as empty.
  - Only the visible screen is read. A draft taller than the screen pushes the top of the box off it, so that pane is not seen as a Claude pane and its text is not stored.
  - Text recalled into the box with the up arrow equals your last message, so it is stored as a sentMatch draft although you never typed it.

Run it with the Claude Code sandbox off: the sandbox blocks the cmux socket and ps.
`;

const SEARCH_NARRATIVE = `
SEARCHES, per session, in this order — the order decides which hit prints first
under \`Match:\`. The next two hits print under \`Match (<field>):\`, a dimmed
line counts the rest, and --all-matches prints every one (home-base-7761p.2);
the \`Also in\` line still names the other fields that matched:

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
unknown date is not proof that it is old.

TITLES  a v4 session is titled by its session bead (found through the
        sessions index and that repo's .beads/issues.jsonl), and its Bead line
        names it; \`thread show <bead>\` takes it. A Bead line reading UNKNOWN
        says why the bead could not be read. No Bead line: the sessions index
        records no session bead for that session.

SECTION the markdown heading the match sits under in the matched field, e.g.
        Progress in a Part 1. No Section line: no heading precedes the match.`;

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
session — if this is work Justin asked for, run: thread request "…"

It also warns — once per turn, its own marker in
<state dir>/nudge-marks/<session id>.last-request.json — when the command runs
br close <id…> (quoted text ignored) and that closes the LAST open request of
this session (a request of another session, or a bead that is no request,
stays silent):

  [thread] you closed the last open request in this session ("<title>").
  Before you stop: re-read Justin's first message — does everything he asked
  for exist, or is it answered in your message? If anything is missing, even a
  conditional or uncertain ask, file it: thread request "…"

When the session's beads cannot be read it says it could not check, never
that the request was the last one.

IT IS A REMINDER, NOT A CHECK. It reads br as the command word only (not in a
comment or an echo), and skips an id br's output says it skipped or could not
find. It misses: a br close with no id, an id held in a shell variable, and a
close that exits non-zero (Claude Code fires no PostToolUse hook for a failed
call, so a partial close that also closed the last request says nothing).`;

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

THE OVERARCHING REQUEST (home-base-jm5kg.5) is the one request whose title
describes the whole of the work, done and open, in this session and the
sessions it continues. Its title IS the session title, so it names the inbox
entry and the cmux workspace. There is at most one per handoff chain; a
successor shares its predecessor's.

  thread request --overarching "make the handoff command trustworthy"
      files a new request and marks it overarching (the work changed
      direction: the old overarching request stays a request).
  thread request --overarching --bead <request id>
      marks an existing request, or confirms the current one still fits.
  thread title "…"
      retitles the overarching request and the session together.

Marking one unmarks every other request of the chain, and titles the session.
Requests are not nested: a bead filed with \`br create --parent <request id>\`
shows as a sub-item of that request.

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
      no request filed; a session still titled with the first prompt's line;
      a bead this session filed with br create or br q that is not a request
      (adopt it with thread request --bead <id> if Justin asked for it; an
      id the call printed but did not create then is named, never offered);
      when every request is closed, each open question or filed bead that
      is still undecided — or "Nothing to mark." When stopping would leave
      ⚠️ open work, one entry per open request: close it (work done) or
      file the P0 that blocks it / hand off (not done).
      When a request is finished: br close <id> --reason "…". Your open
      questions to Justin never keep it open. A change is finished when it
      exists or Justin declines it; a question when the answer is in your
      message.
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
when the session is running), then "Related epics:" — the nearest epic above
each request and each bead the session created with br create, with that
epic's open children (at most 15, then "N more"); "none" means it checked and
found none, "UNKNOWN" that something it needed could not be read, listed under
it — then "From Claude:" — the last message Claude
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
        'guard',
        'Hook (PreToolUse, matcher Bash): the session guard (home-base-mbnjv.5). Refuses, with exit 2 and the reason on stderr, a raw cmux call that is not read-only, a claude call that is not read-only, and thread handoff / spawn / respawn from a subagent (recorded on the parent’s session bead). Points at thread handoff and thread spawn. Reads the payload on stdin. Inert unless componentConfig.thread.handoff.successor is on; install writes its entry only there.',
        (yy) =>
          yy.option('explain', {
            default: false,
            describe: 'Also say "allowed" on stderr when the call is allowed',
            type: 'boolean' as const,
          }),
        async (argv) => {
          const {runThreadGuardHook} = await import('./session-guard');
          process.exit(
            await runThreadGuardHook({explain: argv.explain === true}),
          );
        },
      )
      .command(
        'brake',
        'Hook (PreToolUse, every tool): the spend quota brake on a running session (home-base-ys9t7.5 D6). Reads the payload on stdin and the session’s cached quota decision (recomputed every componentConfig.thread.quota.recheckSeconds). Mode observe logs what it would deny to the quota log and allows; mode enforce denies, with exit 2 and the reason on stderr, every call but a short allow-list once the session’s group is over a limit while Justin is away. Inert where componentConfig.thread.quota.mode is off; install writes its entry only where it is not.',
        (yy) => yy,
        async () => {
          const {runThreadBrakeHook} = await import('./quota-brake');
          process.exit(await runThreadBrakeHook());
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
            .option('overarching', {
              default: false,
              describe:
                'Mark this request as the OVERARCHING one: the request whose title describes the whole of the work in this session and the sessions it continues. The session title becomes its title, and every other request of the chain is unmarked. With --bead, marks an existing request (or confirms the current one).',
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
              overarching: argv.overarching === true,
              sessionId: argv.session ?? null,
              title: title === '' ? null : title,
            }),
          );
        },
      )
      .command(
        'handoff',
        HANDOFF_SUMMARY,
        (yy) =>
          yy
            // The same first line as `justin-sdk --help` (D4), built only
            // when this command is chosen: sdk-identity reads package.json.
            .usage(
              `${helpHeader('justin-sdk', dirname(import.meta.dirname))}\n\n$0 thread handoff\n\n${HANDOFF_SUMMARY}`,
            )
            .epilogue(HANDOFF_NARRATIVE)
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
                'Session id to hand off (default: $CLAUDE_CODE_SESSION_ID). With the successor knob on, only the session this runs in: another id is refused (exit 2).',
              type: 'string' as const,
            })
            .option('model', {
              describe:
                'Knob on only: the successor’s model (`claude --model`); default: claude’s own default',
              type: 'string' as const,
            })
            .option('dry-run', {
              default: false,
              describe:
                'Knob on only: print the gate’s answer, the block path, the cmux argument array and the kickoff; write nothing, open nothing',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadHandoffCommand} = await import('./handoff-successor');
          process.exit(
            await runThreadHandoffCommand({
              dryRun: argv['dry-run'] === true,
              model: argv.model ?? null,
              note: argv.note ?? null,
              sessionId: argv.session ?? null,
              to: argv.to ?? null,
            }),
          );
        },
      )
      .command(
        'respawn',
        RESPAWN_RETIRED_SUMMARY,
        (yy) =>
          yy
            // Its old flags (--note, --close-after, …) must reach the
            // handler, which refuses with exit 2, not fail as unknown (1).
            .strict(false)
            .usage(
              `${helpHeader('justin-sdk', dirname(import.meta.dirname))}\n\n$0 thread respawn\n\n${RESPAWN_RETIRED_SUMMARY}`,
            ),
        async () => {
          const {RESPAWN_RETIRED_LINES} = await import('./respawn');
          for (const line of RESPAWN_RETIRED_LINES) console.error(line);
          process.exit(2);
        },
      )
      .command(
        'spawn <dir>',
        SPAWN_SUMMARY,
        (yy) =>
          yy
            .usage(
              `${helpHeader('justin-sdk', dirname(import.meta.dirname))}\n\n$0 thread spawn <dir>\n\n${SPAWN_SUMMARY}`,
            )
            .epilogue(SPAWN_NARRATIVE)
            .positional('dir', {
              describe:
                'The directory the new session starts in (~ is allowed)',
              type: 'string' as const,
            })
            .option('name', {
              describe:
                'The workspace title after "[TAG] " (default: "new session <directory name>")',
              type: 'string' as const,
            })
            .option('remote-control', {
              default: false,
              describe:
                'Start claude with Remote Control, named after the workspace, so the Claude app can open it',
              type: 'boolean' as const,
            })
            .option('model', {
              describe:
                'The new session’s model (`claude --model`); default: claude’s own default',
              type: 'string' as const,
            })
            .option('kickoff', {
              describe:
                'The first prompt, typed for you: the new session starts on it with no keystroke. Mutually exclusive with --kickoff-file.',
              type: 'string' as const,
            })
            .option('kickoff-file', {
              describe:
                'Read the first prompt from this file (for a long or multi-line kickoff). Mutually exclusive with --kickoff.',
              type: 'string' as const,
            })
            .conflicts('kickoff', 'kickoff-file')
            .option('dry-run', {
              default: false,
              describe:
                'Print the workspace name, directory and command; do not touch cmux',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadSpawn} = await import('./spawn');
          let kickoff: string | null = argv.kickoff ?? null;
          const kickoffFile = argv['kickoff-file'] ?? null;
          if (kickoffFile != null) {
            try {
              kickoff = readFileSync(kickoffFile, 'utf8');
            } catch (error) {
              console.error(
                `thread spawn: refused: --kickoff-file ${kickoffFile} cannot be read: ${String(error)}`,
              );
              process.exit(2);
            }
          }
          process.exit(
            await runThreadSpawn({
              dir: argv.dir ?? null,
              dryRun: argv['dry-run'] === true,
              kickoff,
              model: argv.model ?? null,
              name: argv.name ?? null,
              remoteControl: argv['remote-control'] === true,
            }),
          );
        },
      )
      .command(
        'open',
        OPEN_SUMMARY,
        (yy) =>
          yy
            .usage(
              `${helpHeader('justin-sdk', dirname(import.meta.dirname))}\n\n$0 thread open\n\n${OPEN_SUMMARY}`,
            )
            .epilogue(OPEN_NARRATIVE)
            .option('since', {
              describe:
                'Only sessions with activity in this window: a number and h, d or w (24h, 3d, 2w). Default: componentConfig.thread.openSince, else 7d',
              type: 'string' as const,
            })
            .option('days', {
              describe: 'The same as --since <N>d (kept as an alias)',
              type: 'number' as const,
            })
            .option('limit', {
              describe:
                'Open at most N sessions, newest first; the rest are listed under "Not opened: over the limit"',
              type: 'number' as const,
            })
            .option('repo', {
              describe:
                'Only sessions in this repo: its folder name or its project tag, any case (repeat the flag, or comma-separate, for several)',
              string: true,
              type: 'array' as const,
            })
            .option('per-project', {
              default: false,
              describe:
                'One new cmux window per project instead of one window for all',
              type: 'boolean' as const,
            })
            .option('include', {
              describe:
                'Also reopen these sections: answered, handedOff, doneQuestions (comma-separated, or repeat the flag)',
              string: true,
              type: 'array' as const,
            })
            .option('color', {
              default: true,
              describe:
                'Colour each workspace this run opens with its project colour (~/.config/cmux-arrange/colors.json overrides, then assigned, then the built-in project colours); moved workspaces keep theirs; --no-color skips it',
              type: 'boolean' as const,
            })
            .option('include-open', {
              default: false,
              describe:
                'Also show sessions already open in another cmux window: their workspaces are MOVED into the new window (never resumed a second time); --undo moves them back',
              type: 'boolean' as const,
            })
            .option('restore', {
              default: true,
              describe:
                'Type the unsent text stored for each session it opens back into the new input box, on one line, never sent (see RESTORED DRAFTS); --no-restore skips it',
              type: 'boolean' as const,
            })
            .option('include-untracked', {
              default: false,
              describe:
                'Also reopen sessions with no session bead. Not built yet: refuses.',
              type: 'boolean' as const,
            })
            .option('force-unplaced', {
              default: false,
              describe:
                'Open even when a live Claude pane does not show which session it holds (see CANNOT TELL)',
              type: 'boolean' as const,
            })
            .option('dry-run', {
              default: false,
              describe: 'Print what would open; open nothing, write nothing',
              type: 'boolean' as const,
            })
            .option('json', {
              default: false,
              describe:
                'Print the record (the plan and what was opened) as JSON',
              type: 'boolean' as const,
            })
            .option('undo', {
              default: false,
              describe:
                'Close what the latest run opened, keeping any workspace with unsent text, Claude working, or use since the run (see UNDO)',
              type: 'boolean' as const,
            })
            .option('list', {
              default: false,
              describe:
                'List the recorded runs, newest first: when, the filters, how many opened and moved, whether undone, and the --undo --run command for each (reads the records only)',
              type: 'boolean' as const,
            })
            .option('run', {
              describe:
                'With --undo: the run to undo, by its record file name under opens/ (e.g. 2026-10-18T12-34-56.789Z)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadOpen} = await import('./open');
          const at = process.argv.indexOf('open');
          process.exit(
            await runThreadOpen({
              argv: at === -1 ? [] : process.argv.slice(at + 1),
              color: argv.color !== false,
              days: argv.days ?? null,
              dryRun: argv['dry-run'] === true,
              forceUnplaced: argv['force-unplaced'] === true,
              include: (argv.include ?? []).map(String),
              includeOpen: argv['include-open'] === true,
              includeUntracked: argv['include-untracked'] === true,
              json: argv.json === true,
              limit: argv.limit ?? null,
              list: argv.list === true,
              perProject: argv['per-project'] === true,
              // G6: absent stays absent, so a bare or blank --repo can refuse.
              repos: argv.repo?.map(String),
              restore: argv.restore !== false,
              run: argv.run ?? null,
              since: argv.since ?? null,
              undo: argv.undo === true,
            }),
          );
        },
      )
      .command(
        'close [workspaces..]',
        CLOSE_SUMMARY,
        (yy) =>
          yy
            .usage(
              `${helpHeader('justin-sdk', dirname(import.meta.dirname))}\n\n$0 thread close <workspace…> [--session <id>…] [--dry-run] [--json]\n\n${CLOSE_SUMMARY}`,
            )
            .epilogue(CLOSE_NARRATIVE)
            .positional('workspaces', {
              describe:
                'Workspaces to close: uuids (cmux tree --id-format both) or workspace:N refs',
              string: true,
              type: 'string' as const,
            })
            .option('session', {
              describe:
                'Close the workspace that holds this Claude session (repeat for several); refused when no live process holds it or it shows in more than one workspace',
              string: true,
              type: 'array' as const,
            })
            .option('dry-run', {
              default: false,
              describe:
                'Run every check and print what would close and what would be kept; signal, close and write nothing',
              type: 'boolean' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print what was found and done as JSON',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadClose} = await import('./close');
          const given = argv.workspaces as string[] | string | undefined;
          process.exit(
            await runThreadClose({
              dryRun: argv['dry-run'] === true,
              json: argv.json === true,
              sessions: (argv.session ?? []).map(String),
              workspaces: (Array.isArray(given)
                ? given
                : given == null
                  ? []
                  : [given]
              ).map(String),
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
        'workspace-name',
        'Name this session’s cmux workspace "[REPO] <session title>", keeping a name Justin set in parentheses (home-base-j8q3e.5). Every name it sets is written first to workspace-names.jsonl under the threads state dir. Needs componentConfig.thread.nameWorkspaces, except --dry-run. Exit 0 done or nothing to do · 1 not set (the reason is printed) · 2 usage.',
        (yy) =>
          yy
            .option('all', {
              default: false,
              describe:
                'With --dry-run: the preview over EVERY open cmux workspace (its name now, what it would become, the rule, the session that would name it). Read-only. Refused without --dry-run.',
              type: 'boolean' as const,
            })
            .option('dry-run', {
              default: false,
              describe:
                'Print the name it would set and which rule decided; read cmux, write nothing. Works with the knob off.',
              type: 'boolean' as const,
            })
            .option('restore', {
              default: false,
              describe:
                'Put back every name the tool replaced, for each recorded workspace whose name is still the tool’s; one renamed since is left alone and listed. With --dry-run it lists what it would do.',
              type: 'boolean' as const,
            })
            .option('session', {
              describe:
                'Session id or session bead id (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            })
            .option('workspace', {
              describe:
                'Workspace uuid to name (or, with --restore, the only one to restore) instead of the one holding the session’s surface. Never defaults to the caller’s.',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadWorkspaceName} = await import(
            './workspace-name-session'
          );
          process.exit(
            await runThreadWorkspaceName({
              all: argv.all,
              dryRun: argv['dry-run'],
              restore: argv.restore,
              session: argv.session ?? null,
              workspace: argv.workspace ?? null,
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
        'quota',
        QUOTA_SUMMARY,
        (yy) =>
          yy
            .epilogue(QUOTA_NARRATIVE)
            .option('json', {
              default: false,
              describe:
                'Print the report as one JSON object (epoch ms and ISO times), for scripts',
              type: 'boolean' as const,
            })
            .option('session', {
              describe: 'Session id (default: $CLAUDE_CODE_SESSION_ID)',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runThreadQuota} = await import('./quota-command');
          process.exit(
            await runThreadQuota({
              json: argv.json === true,
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
            })
            .option('stop', {
              default: false,
              describe: STOP_OPTION_TEXT,
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runSessionClose} = await import('./session-marks');
          process.exit(
            await runSessionClose('archive', {
              reason: argv.reason ?? null,
              selector: argv.sessionBead ?? null,
              sessionId: argv.session ?? null,
              stop: argv.stop === true,
            }),
          );
        },
      )
      .command(
        'unmark',
        'Undo Justin’s newest `thread done` or `thread archive` (for --session, or the newest of all; --mark <id> names exactly one): reopen every bead it closed and give each the status it had (in_progress comes back as in_progress), remove the archived label it added, and give adopted requests it released their request labels back. Read from ~/.local/state/justin-threads/marks-undo.jsonl, which done and archive write before they close anything. Exit 0 restored · 1 a br call failed (each id named; the record is kept, so running it again retries) · 2 nothing to undo.',
        (yy) =>
          yy
            .option('session', {
              describe:
                'The session whose mark to undo: its session bead id or its claude session id (default: the newest mark of all)',
              type: 'string' as const,
            })
            .option('mark', {
              describe:
                'The id of one mark to undo, as `thread done` / `thread archive` print it ("Undo: thread unmark --mark <id>"); that mark and no other',
              type: 'string' as const,
            })
            .conflicts('mark', 'session'),
        async (argv) => {
          const {runThreadUnmark} = await import('./session-marks');
          process.exit(
            await runThreadUnmark({
              mark: argv.mark ?? null,
              session: argv.session ?? null,
            }),
          );
        },
      )
      .command(
        'read [sessionId]',
        'Justin’s own read mark on a session, kept in ~/.local/state/justin-threads/read-marks.jsonl and separate from Claude Code’s and cmux’s. A session is unread in `thread inbox` (● before its title) when Claude has written since your newest read mark, when you never marked it, or when your newest mark is unread (`thread unread`). --all marks every unread session of the inbox (the last 30 days) read, one record each (R in the threads dashboard). Exit 0 marked · 1 not written · 2 usage.',
        (yy) =>
          yy
            .positional('sessionId', {
              describe: 'The claude session id',
              type: 'string' as const,
            })
            .option('seen', {
              describe:
                'The last assistant activity you saw (ISO); default: the message log’s last assistant line now',
              type: 'string' as const,
            })
            .option('all', {
              default: false,
              describe:
                'Mark every unread session in the inbox read, as of now (home-base-yukaf.14 F7)',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runReadAll, runReadMark} = await import('./read-marks');
          if (argv.all) {
            if (argv.sessionId != null || argv.seen != null) {
              console.error(
                'thread read: --all takes no session id and no --seen',
              );
              process.exit(2);
            }
            process.exit(await runReadAll({cwd: process.cwd()}));
          }
          process.exit(
            runReadMark({
              mark: 'read',
              seen: argv.seen ?? null,
              sessionId: argv.sessionId ?? null,
            }),
          );
        },
      )
      .command(
        'unread <sessionId>',
        'Justin’s own unread mark on a session (see `thread read`): `thread inbox` shows it with ● until you mark it read again. Exit 0 marked · 1 not written · 2 usage.',
        (yy) =>
          yy.positional('sessionId', {
            describe: 'The claude session id',
            type: 'string' as const,
          }),
        async (argv) => {
          const {runReadMark} = await import('./read-marks');
          process.exit(
            runReadMark({
              mark: 'unread',
              seen: null,
              sessionId: argv.sessionId ?? null,
            }),
          );
        },
      )
      .command(
        'dashboard',
        'Open the threads dashboard. --tui: the full-screen terminal dashboard (`bun run threads`; spawned when this is a home-base checkout, otherwise it prints how to run it). --web (EXPERIMENT, home-base-yukaf.11): serve the inbox as a page on 127.0.0.1 and print its URL; each card has Open in cmux, Mark read/unread, Done and Archive buttons and a See more toggle, and every button names the session by id, session bead id and card version, which the server checks against a fresh inbox read before it runs the one command the TUI key runs (a mismatch is refused, 409, with the reason on the page). Actions are logged to ~/.local/state/justin-threads/dashboard-web.jsonl. Without either flag: componentConfig.thread.dashboardUi (default tui). Exit 0 · 1 the TUI could not start · 2 the TUI is not here.',
        (yy) =>
          yy
            .option('web', {
              describe: 'Serve the web page (the experiment)',
              type: 'boolean' as const,
            })
            .option('tui', {
              describe: 'Run the terminal dashboard',
              type: 'boolean' as const,
            })
            .conflicts('web', 'tui')
            .option('days', {
              describe:
                'Web: sessions with activity in the last N days (default 30, like thread inbox)',
              type: 'number' as const,
            })
            .option('port', {
              describe: 'Web: listen on this port (default: any free port)',
              type: 'number' as const,
            })
            .option('open', {
              default: true,
              describe:
                'Web: ask the OS to open the URL in a browser (--no-open only prints it)',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadDashboard} = await import('./dashboard-web');
          process.exit(
            await runThreadDashboard({
              days: argv.days,
              openBrowser: argv.open,
              port: argv.port,
              ui: argv.web === true ? 'web' : argv.tui === true ? 'tui' : null,
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
        'With componentConfig.thread.sessionBeads ON: your dashboard — every session you started (last 30 days) as one card each, newest activity first, after a summary that counts the sessions per section (Unsent text in the input box — text typed and never sent, recorded by `thread drafts scan` —, Needs you, To land, Stopped with work open, Check by hand, Working, Handed off or out of context, Answered, Done with questions for you, Not tracked; --all adds Done and Archived). Each card says what you asked for, where it stands (status and the git facts that matter), the ONE thing you need to do, any optional questions and how to resume it. Not tracked: every other Claude Code session under ~/Dev in the window (no session bead; found the way `repo-status repos` finds them), shown from facts only — a full card when something is open (a branch not merged, uncommitted files, working now, out of context, a blocking question in its old report) or could not be read, else one line saying nothing open was found. Working means its last record is under 3 minutes old, or one of its helper agents (subagents) is still in flight with a record under 15 minutes old, so a helper inside one long tool call keeps it Working; a helper that was killed keeps it Working for up to 15 minutes. --by-status groups the cards by section, --by-repo by repo. A session that cannot be read is a ❔ card, never dropped. Knob OFF (legacy): what Justin answered or skipped since the last report, each ask restated in full. Marks nothing.',
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
                'Knob on: group the cards by section (Unsent text in the input box first, then Needs you), newest first inside each',
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
        'Drains the report spool, prints the threads repo’s uncommitted and unpushed backlog, and points to the session dashboard: `threads` (full screen) or `thread inbox` (text). The old per-thread list of September reports is still here under a flag: --recent for newest first, --all for every thread grouped by repo, --open-asks for everything waiting on you, --json for the data.',
        (yy) =>
          yy
            .option('all', {
              default: false,
              describe:
                'The old per-thread list grouped by repo, with the folded-away threads too — otherwise a thread another session took over, and a session `thread backfill` recorded, are both hidden (unless they still have open asks). With --recent, the flat list with them included.',
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
        'drafts [action] [sessionIds..]',
        'Unsent text in Claude Code input boxes. `thread drafts` lists what is stored and still unsent; `thread drafts scan` reads every open cmux pane and updates the store; `thread drafts dismiss <session id…>` marks stored text you no longer want as cleared (the text stays in the file). Exit 0 read · 1 something failed (named) · 2 cmux unreachable or no session id given, nothing written.',
        (yy) =>
          yy
            .epilogue(DRAFTS_NARRATIVE)
            .positional('action', {
              choices: ['scan', 'dismiss'] as const,
              describe:
                'scan: read every cmux pane and record the unsent text in each Claude input box. dismiss: clear the stored text of the sessions named after it. Omit to list what is stored.',
              type: 'string' as const,
            })
            .positional('sessionIds', {
              array: true,
              describe:
                'dismiss only: the claude session ids whose text to clear',
              type: 'string' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print the result as JSON',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {
            runThreadDraftsDismiss,
            runThreadDraftsList,
            runThreadDraftsScan,
          } = await import('./drafts-scan');
          const json = argv.json === true;
          const ids = (argv.sessionIds ?? []).map(String);
          if (argv.action !== 'dismiss' && ids.length > 0) {
            console.error(
              `thread drafts: session ids are taken by dismiss only (got: ${ids.join(' ')})`,
            );
            process.exit(2);
          }
          process.exit(
            argv.action === 'scan'
              ? await runThreadDraftsScan({json})
              : argv.action === 'dismiss'
                ? runThreadDraftsDismiss({json, sessionIds: ids})
                : await runThreadDraftsList({json}),
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
            })
            .option('all-matches', {
              default: false,
              describe:
                'Print a snippet for every place the phrase matched in a session, instead of the first three plus a count',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runThreadSearch} = await import('./search');
          const words = (argv.query as string[] | string | undefined) ?? [];
          process.exit(
            await runThreadSearch({
              allMatches: argv['all-matches'] === true,
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
            })
            .option('stop', {
              default: false,
              describe: STOP_OPTION_TEXT,
              type: 'boolean' as const,
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
                stop: argv.stop === true,
              }),
            );
          }
          if (argv.stop === true) {
            console.error(
              'thread done --stop: only with componentConfig.thread.sessionBeads on; nothing was marked',
            );
            process.exit(2);
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
