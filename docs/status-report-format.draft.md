# Status report format

Applies to **the report** — the final report-back message before yielding to Justin (conductor, mayor, loop and kickoff sessions). Not to in-flight prose.

Justin's goal: **30 seconds to read, 30 seconds to answer.** Reports were taking 10+ minutes. Template supplied by Justin 2026-09-04; revised 2026-09-12; revised again 2026-09-14 after he read four reports in a row and said the format was too long, the top block a wall of text, and the asks unprioritised.

## Writing rules

- **The first line after the rule is the GLANCE LINE.** Four things, in order: stop reason, what happens next in one word, progress percent, and how many P0 asks are open. Everything below it is detail he reads only if that line makes him want to.
- **Hierarchical bullets everywhere.** Prose paragraphs are not allowed outside the optional Discussion section.
- **Parallel structure.** Sibling bullets share the same grammatical shape. Big emphasis on this.
- **Simple declarative sentences** about what you did, found, or need. No poetry, no metaphor, no "worth your eyes", no "trap".
- **Restate what you were asked.** "You asked me to …" says, in one sentence, what instruction this report answers. Justin is juggling dozens of threads; this is the hook that lets his brain latch back on.
- **Every bead id gets a descriptive phrase** in context: `jofp.6 (the thread-state fact collector)`. Never a bare id. Justin does not know what `jofp.6.2` is and will not look it up.
- **Restate the question before every answer.** Under Answers, quote his question (or a faithful paraphrase), then answer. He does not remember what he asked.
- **Asks are ONE numbered sequence; options are lettered.** Everything Justin must do — approve, pick, answer, run a command, test on a device — is an ask, numbered 1..N straight through **every priority**, so he can reply "1 yes, 2 b". Never letter an ask; letters are for options only.
- **Asks carry a priority, P0–P4** (see the calibration below). P0 first, but the numbering does not restart — the marker is the grouping.
- **Deviations are their own section, and it is never omitted.** Anything that departs from what Justin specified or from the spec, plus anything he should know. "none" is a claim that you checked and the work matched; a missing section would let a report simply not mention that it went somewhere else.
- **What happens next (mine) is ONE list.** The goal, your next steps, and what remains are the same thing split three ways; merge them. Anything **Justin** must do is an ask, not a next step.
- **Bring solutions, not problems.** Before listing anything: can you just fix it? If it is uncontroversial and in line with the rules, do it and report it as done. Only surface design decisions, deviations from his spec, and things genuinely his.
- **Do not surface beads housekeeping.** Beads are your ledger, not his. He does not need to approve closing a bead or hear where information lives.
- **Draft, then revise.** Write the full report first (in thinking or explicitly), then proofread it against this file before printing. Cut anything that fails "does he need this?" Ask "can I dispatch this now instead of reporting it?" and "did he already say I don't need to ask this?"
- **No TLDR.** Retired 2026-09-04.

## Ask priority — P0 to P4

Replaces the old blocking / non-blocking boolean (2026-09-14). The scale exists so Justin can answer the two that matter and skip the rest; a report where everything is P0 has no priorities at all and is just the boolean with more digits.

| | Means | Marker |
| --- | --- | --- |
| **P0** | I cannot proceed without this | `🛑 P0` |
| **P1** | Decide before the next session builds on it | `P1` |
| **P2** | Decide this week | `P2` |
| **P3** | Informational — my default is fine | `(P3)` |
| **P4** | FYI — no reply expected | `(P4)` |

- **Most asks are P3 or P4.** Do not inflate.
- **P0 is for a session that is genuinely STOPPED.** If you kept working, it was not P0.
- **Every ask states its default**, whatever its priority: what you will do if he never answers. Leaving a P3 unanswered IS the answer.

## What happens next — one word

The second glance badge. Pick exactly one:

| | Means |
| --- | --- |
| `handoff` | I am out of context; the next session picks this up |
| `answerAsks` | I need your answers before the next move is worth making |
| `continue` | I keep going on this arc |
| `done` | The arc is finished |
| `testOnDevice` | It needs your hands on a device or a browser |

## Template

````
🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑

⚡ ✅ Work completed · 🙋 needs your answers · 📈 85% · 🛑 1 P0 ask

📦 home-base · 🌿 thread-v2 · 🌳 primary checkout · 🔢 497k / 470k
🌲 clean · 2 ahead / 0 behind · HEAD 288f3912eed5

**Thread:** thread report format v2 — glance badges and ask priorities
**Stop reason:** The renderers are built and the gates are green.
**You asked me to:** build the notification hook and fix the subagent notifications
**Your last message, verbatim:** go build the format v2 dispatch

**What happens next (mine):**
- ⚽ Goal: Run a successful test of justin-loop session respawning
- ➡️ Build the token notification hook
- ➡️ Run the test on the nature-sounds repo

**What I did:**
- ✅ Built X
- ✅ Built Y
- ✅ Created fdlc.2 (the retry-on-lock change) for the follow-up I found

**What I learned:**
1. Always use bullets in my responses (✅ added to the conductor skill)
2. Token count from X is unreliable (✅ added to justin-sdk CLAUDE.md)

**Answers to your questions:**
1. Q: Is there conflicting information in the critical rules?
   A: Yes — rules 3.3 and 3.4 disagree about bead comments. Filed home-pqzy.

**Deviations from what you asked for:**
- ⚠️ You asked for three independent renderers; two of them share one classifier, because the stored report is text and a second walker would drift.

**Asks — everything I need from you:**
  1. 🛑 P0 · [Pick a/b] How should I build thing X, given your conflicting guidance? (th-eru.1)
     Context: Both rules are live and a session reading either one is wrong.
     a. (Recommended) Build it as Y — upside is __, downside is __.
     b. Build it as Z — upside is __, downside is __.
     If you don't answer: I stop here; I cannot pick this one for you.
  2. P2 · [Do] Install the dev build and open the Recordings tab (th-eru.2)
     Context: I cannot see whether the waveform renders; only a device can.
     If you don't answer: I ship it unverified and say so.
  3. (P3) · [Approve Y/n] Retire the claude-session-logger.sh script? (th-eru.3)
     Context: Nothing references it since the WezTerm experiment ended.
     If you don't answer: I retire it.

**Prior asks — closed by this report:**
- th-9kq.2 ([Approve Y/n] Close ask beads rather than deleting them?) — answered: you said "yes, closing is right"
- th-9kq.3 ([Pick a/b] Where should the thread knob live?) — decided: took the default, kept the knob off

**Compact report.** Work product and beads touched are on the thread bead — `justin-sdk thread show --full`.

Answer: justin-sdk thread answer th-eru
🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️
````

Two sections are optional and appear only when they have content: **Discussion:** (nuance he needs, bullets only, between Deviations and Asks) and a handoff block between `⏭️⏭️⏭️⏭️⏭️⏭️⏭️⏭️` rules, only when handing off.

Two more are in the **full** report and not the compact one: **Work product:** and **Beads touched:**. They are always stored on the thread bead; `justin-sdk thread show --full` prints them.

## Section notes

- **Glance line** — stop reason, next step, progress, P0 count. Nothing else goes on it.
- **The where block** — repo, branch, worktree, tokens, then the tree state. Facts, never typed by hand: the tool measures them. `497k / 470k` is context used against the configured wrap-up threshold; one number means no threshold is configured.
- **Thread / Stop reason / You asked me to / Your last message** — one line each, no prose. The last message is his, verbatim, so he recognises where he left off.
- **What happens next (mine)** — the goal is the arc's goal, not this turn's. Then the concrete moves, yours, in order.
- **What I did** — completed items only. Not-done items belong in What happens next. The compact report stops at six and says how many it hid.
- **What I learned** — each item ends with its disposition in parentheses: (✅ written to X) or (bead id (OPEN)). A learning with no disposition is not finished.
- **Answers to your questions** — each restating the question before the answer. Short. Point at the section with the detail.
- **Deviations** — see the writing rules. Never omitted; "none" when there were none.
- **Asks** — numbered 1..N in one sequence across every priority, each carrying its form ([Approve Y/n], [Pick a/b/c], [Answer], [Do]), its context, its lettered options with (Recommended) marked, its bead id, and its default. Do not repeat an ask anywhere else.
- **Prior asks — closed by this report** — one line each: the id, the ask restated in brackets so the id means something, how it was dispositioned, and the detail. The tool fills the bracketed phrase in from the ask bead; if the bead could not be read it prints the id alone rather than inventing a description.
- Number dispatches (dispatch 1, 2, 3), never letter them.

## Thread reports (knob-gated, 2026-09-12; format v2 2026-09-14)

When the `justin-sdk thread` tool is available, the report is also recorded as a bead so open asks survive across turns and sessions. At wrap-up:

1. Run `justin-sdk thread prepare`. If the command is not found, or it prints `THREADS: DISABLED`, write the text report above and stop here. If it prints `THREADS: SANDBOX DENIED`, write the text report and put the denial (with the paths it names) in a P2 ask.
2. If it prints `THREADS: ENABLED`, it lists the session's open asks, the payload skeleton, and the priority calibration. Write the payload JSON to `$TMPDIR`, dispositioning every open ask it listed (carried / answered / decided / irrelevant), and run `justin-sdk thread report --file <path>`.
3. Paste the rendered report it prints **verbatim** as your final message. It is the template above, with ask bead ids inline. If it printed `NOT RECORDED`, still paste the report and add the failure as an ask.

Payload notes for v2 (schemaVersion 2): every ask carries `priority` 0–4 instead of `blocking`; the payload carries `nextStep` (one of the five words above) and `deviations` (an array, `[]` when there were none). A v1 payload is still accepted for one release and migrated — `blocking: true` becomes P0, `false` becomes P3, `nextStep` becomes `continue`, `deviations` becomes empty — and the tool says out loud when it did that, because an empty `deviations` it supplied is not a claim that you checked.

`thread report` and `thread show` print the **compact** report by default and the full one with `--full`; the thread bead always stores the full one.

At the start of a turn after Justin says his answers are in, run `justin-sdk thread inbox` and continue from the answers. If he answers in chat instead, disposition those asks in your next report.

Subagents (players, explorers, any agent dispatched by another session) never run these commands — they inherit the parent's session id and would overwrite its thread. They report to the session that dispatched them; that session reports for the arc.
