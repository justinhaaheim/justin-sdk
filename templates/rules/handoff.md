# Handoff: starting the next session

This file says when and how a session hands its work on to a fresh session. In Justin's words (2026-10-29): "claude code's job is to call our tool to kickoff the new session, and that that tool may opt not to open the session due to session limits, rate limits, or any other reason. So there's a clear API, claude knows what to do, and claude doesn't try to hack around it (i don't want claude "going rogue" like that opening new cc sessions)."

## Terms

These words mean the same thing in every rule, skill, notice and report.

- **Wind-down notice:** the automated notice a session gets when its context reaches its wind-down threshold. It is not a limit. After it, keep working to a natural stopping point, then hand off. Handing off well past the threshold, at 450k or 500k tokens, is expected.
- **Wind-down threshold:** the token count at which the wind-down notice is sent, set by `wrapUpAt` in the `usage-check` config.
- **FYI notice:** the notices sent at preset token counts, every 100,000 tokens by default. They are information only. When a wind-down threshold is set, they name it.
- **Hard limit:** the model's real context window. Only a hard limit is something to hand off ahead of, and only when you have been told its size. A session that has not been told the size of its context window does not know it.

## When to hand off

Hand off only for one of these reasons:

1. Justin tells you to hand off.
2. A wind-down notice tells you to hand off. Finish the work in progress, then hand off at the next good stopping point. If Justin then tells you to keep going, keep going: his word wins.
3. You are in the last 10% of a hard limit whose size you have been told.

Never hand off before a wind-down notice in anticipation of one. The token counts that `thread status` and the FYI notices show are not limits.

Never hand off as a way to stop with open work.

Hand off only with no background work running: no subagent and no background shell of yours may still be working. Justin can set the old tab to exit or close after the handoff, and that ends everything still running in it.

## How to hand off

Run this command once, from the repository root:

```
./node_modules/.bin/justin-sdk thread handoff --note "<one line the next session must know>"
```

- Spell it exactly like this, starting with `./node_modules/.bin/justin-sdk`. Do not start it with `bun`: Claude Code never lets a command that starts with `bun` out of the sandbox, and the handoff then fails.
- Run it bare. Put nothing before or after it: no `cd … &&`, no redirect, no `$(…)`. Any of them keeps the whole call inside the Claude Code sandbox, even where Justin's global sandbox exclusion matches the command, and the handoff then fails.
- Keep backticks out of the note. A note that holds a backtick keeps the call inside the sandbox, even inside single quotes, and the handoff then fails.
- Run it from the repository root, where `node_modules` is. If `./node_modules/.bin/justin-sdk` is not in the current directory, run `cd <repository root>` as its own Bash call first.
- If `./node_modules/.bin/justin-sdk` is missing at the repository root too, the repository has no `bun install` yet. Say so in your final report and stop.
- It records the handoff on this session's bead and prints a handoff block. Where `componentConfig.thread.handoff.successor` is on, it also opens the next session in a new tab, or refuses.
- `./node_modules/.bin/justin-sdk thread handoff --help` lists every step and exit code.

## What the exit code means

The command may refuse: too many sessions running, usage too high, or another reason. Refusing is its job.

- **Exit 0: handed off.** If the output names a new tab, the next session is already running there: end your turn with the handoff summary (below). If it does not, put the printed handoff block in your final report, so Justin can start the next session from it, and end your turn. Do no more work: the next session works in the same checkout.
- **Exit 1: a step failed after the handoff was recorded.** The output says what was done. Quote it in your final report and stop. Do not run `thread handoff` again.
- **Exit 2: nothing was written.** The output says why. If your call was wrong, fix it and run it again. Otherwise report the message and stop.
- **Exit 3: the gate refused.** The handoff and the refusal are recorded, and nothing was opened. The refusal is final. End your turn with the handoff summary, then the printed handoff block, and stop. Do not run `thread handoff` again.
- **Exit 4: deferred, cmux was too slow to decide or the beads database stayed locked.** Nothing was refused and nothing was opened. The command already waited, so run the same command again at once, up to 3 more times. If it still exits 4, end your turn with the handoff summary and the handoff block if the output has them, or else with the printed output, and stop.

Where the old tab is set to exit or close after a handoff, it waits until the next session has linked and your last message is recorded. Do nothing to help it: finish your report and stop.

## Your final message: the handoff summary

When the output ends with a summary headed `🤝 **Handed off**`, your final message is that summary, as printed. It replaces the status report: do not run `thread status` again, and do not paste its block. Justin asked for this on 2026-11-09: "a much more abbreviated status report".

- The summary gives this session's H number, the command that focuses the new tab (or why no tab opened), the open and total requests, and the command that prints the full report.
- On exit 0, send the summary and nothing else. The one addition: if a subagent or a background shell of yours is still running, add one line under the summary that says so.
- On exit 3, and on exit 4 at your last try, send the summary, then the printed handoff block. No tab opened, so Justin starts the next session from the block.
- On exit 1, or when the output has no summary, quote the output as the list above says.

## Never start a session another way

- `thread handoff` is the only way to start the session that continues this one.
- Never start a session for unrelated work or in another project. File the work as a bead and tell Justin in your report.
- The one exception is a repository with `componentConfig.thread.spawn.allowed` on, which is home-base, where the mayor runs. Only there does `bun run justin-sdk thread spawn` run (see its `--help`). It passes the same gate: its exit 3 is final too, and its exit 4 means the same as above. Its exit 1 that says a workspace WAS opened means claude was not seen running there: do not run it again, because that opens a second session; report the workspace it names. Everywhere else it refuses: do not retry it from another directory.
- Never open, type into or close a tab, pane or workspace with `cmux`: no `new-workspace`, `new-surface`, `new-split`, `new-pane`, `send` or `close-…`. Reading with `cmux identify`, `cmux tree` or `cmux read-screen` is fine.
- Never start Claude Code yourself: no `claude` with or without a prompt, no `--bg`, `-p`, `--resume` or `attach`.
- Where `componentConfig.thread.handoff.successor` is on, a guard refuses these commands. It does not catch every spelling: a command it lets through is still forbidden. When it refuses one, do not rewrite the command to get past it.
- Subagents never run `thread handoff` or `thread spawn`. They report to the session that dispatched them. The guard refuses a subagent's call and records it on the dispatching session's bead. It refuses a subagent's `--dry-run` too, and does not record it, because a dry run changes nothing.
