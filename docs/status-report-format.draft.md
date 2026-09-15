# Status report format

Applies to **the report** — the final report-back message before yielding to Justin (conductor, mayor, loop and kickoff sessions). Not to in-flight prose.

## The frame: he reads the bare minimum

Justin's words, 2026-09-15: _"shift the mental framework wholesale from 'the human is going to read all this lovely text' to 'the human will read the minimum bare essential text', so I need to focus on making that clear, actionable, and triple checking that it is as important and relevant as I think it is… and the human MAY read some of the rest. This is a shift from 'the human will answer all of these questions' to 'give the human the opportunity to answer these questions'."_

Everything below follows from that:

- **The report has two forms.** The **compact** report is what you paste: the glance line, where you are, what he asked, your **P0 and P1 asks in full**, your **mistakes in full**, and a pointer. The **full** report has everything else and lives on the thread bead.
- **Write the full report; publish the compact one.** Nothing is cut from the record — what you did, what you learned, your answers, your P2–P4 asks, your judgment calls are all written down. They are simply not in his face.
- **Asks are an opportunity, not a demand.** Every ask carries the default you will take if he never answers. Silence is a valid answer and means "take your default" — so an ask he ignores costs him nothing and costs you nothing.
- **Goal: 30 seconds to read, 30 seconds to answer.** Reports were taking 10+ minutes. Template supplied by Justin 2026-09-04; revised 2026-09-12 and 2026-09-15.

## The triple-check, before you report

Re-read every P0, every P1 and every mistake, and ask of each one:

> **"Is this as important as I think, and would Justin want to see it above everything else?"**

Most things are not must-see. Demote what is not. **A compact report that is long is a compact report he stops reading** — every P2 you inflate to P1 costs you the attention of the P0 next to it.

- **P0** — I cannot proceed without this. A session that is genuinely STOPPED. If you kept working, it was not P0.
- **P1** — decide before the next session builds on it.
- **P2** — decide this week.
- **P3** — informational; my default is fine.
- **P4** — FYI; no reply expected.

Most asks are P3 or P4.

## Asks are written once

An ask is never edited, and never quietly re-asked.

- **Last report's asks close themselves.** Anything he did not answer is closed as _"decided: &lt;the default that ask stated&gt;"_. You went ahead on the default; the question is done.
- **If a question is still live, ask it AGAIN** — a new ask, in this report's words, marked as superseding the old one. The old one closes as superseded. Two beads, one question, one live.
- **Only two things need saying about a previous ask:** that he **answered** it (quote him) or that it became **irrelevant** (say why).

## Deviations have kinds

- **mistake** — careless, wrong, against the spec, or against the rules. **Justin sees these in the compact report.** Own them plainly; do not soften them into judgment calls.
- **judgmentCall** — a call you made that he might have made differently.
- **fyi** — he should know, and nothing went wrong.

An empty deviations list is a **claim that you checked**, not a default.

## Writing rules

- **Hierarchical bullets everywhere.** Prose paragraphs are not allowed outside the optional Discussion section.
- **Parallel structure.** Sibling bullets share the same grammatical shape. Big emphasis on this.
- **Simple declarative sentences** about what you did, found, or need. No poetry, no metaphor, no "worth your eyes", no "trap".
- **Restate what you were asked, first.** One sentence: "You asked me to …". Justin is juggling dozens of threads; this is the hook that lets his brain latch back on.
- **Every bead id gets a descriptive phrase** in context: `jofp.6 (the thread-state fact collector)`. Never a bare id. Justin does not know what `jofp.6.2` is and will not look it up.
- **Restate the question before every answer.** Quote his question (or a faithful paraphrase), then answer. He does not remember what he asked.
- **Asks are ONE numbered sequence; options are lettered.** Everything Justin must do — approve, pick, answer, run a command, test on a device — is an Ask, numbered 1..N in priority order so he can reply "1 yes, 2 b". Never letter the asks; letters are for options only. The compact report's numbers are the first few of the full report's — never a second numbering.
- **Next steps holds only what Claude or the next session will do.** Anything Justin must do is an Ask.
- **Bring solutions, not problems.** Before listing anything: can you just fix it? If it is uncontroversial and in line with the rules, do it and report it as done. Only surface design decisions, deviations from his spec, and things genuinely his.
- **Do not surface beads housekeeping.** Beads are your ledger, not his. He does not need to approve closing a bead or hear where information lives.
- **Draft, then revise.** Write the full report first, then run the triple-check over the must-see half before printing. Cut anything that fails "does he need this?" Ask "can I dispatch this now instead of reporting it?" and "did he already say I don't need to ask this?"
- **Section headers bolded.** Keep the section names, order, and emoji stable — they are meant to become learnable.
- **No TLDR.** Retired 2026-09-04.

## The compact report — what you paste

```
🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑

⚡ ✅ Work completed · 🔁 I keep going · 📈 85% · 🛑 1 P0 ask

📦 home-base · 🌿 main · 🌳 primary checkout · 🔢 291k / 300k
🌲 clean · 2 ahead / 0 behind · HEAD 3fe7e2c8fad0

**Thread:** <salient, recognizable — the memory hook>
**You asked me to:** <his last instruction, restated in the second person>
**Your last message, verbatim:** <the first 300 characters, as he wrote them>

**MUST-SEE — the only part you have to read:**
  1. 🛑 P0 · [Pick a/b] <the question, one line> (th-x7q.2)
     Restated — supersedes th-eru.4 from th-eru report #7, now closed
     Context: <the hook back into what this is about>
     a. (Recommended) <option — upside/downside in one breath>
     b. <option — upside/downside>
     If you don't answer: <what I will do>
  2. P1 · [Approve Y/n] <the question> (th-x7q.3)
     Context: <…>
     If you don't answer: <…>

- ⚠️ MISTAKE — <what I got wrong, plainly>

📎 3 more asks (P2-P4) · 2 more deviations · everything: justin-sdk thread show th-x7q --full

Answer: justin-sdk thread answer th-x7q
🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️
```

When nothing is must-see, the block says so — `- (nothing needs you — nothing went wrong, nothing is blocking)` — and that is a good report, not an empty one.

## The full report — what gets written down

Everything above, plus, in this order:

- **What happens next (mine)** — ⚽ the arc's goal, then ➡️ what you or the next session will do, then what remains to the next milestone. One list.
- **What I did** — completed items only, each with ✅. Not-done items belong in what remains.
- **What I learned** — each item ends with its disposition in parentheses: `(✅ written to X)` or `(bead id (OPEN))`. A learning with no disposition is not finished.
- **Answers to your questions** — numbered, each restating his question before the answer. Short. Point at the section with the detail.
- **Deviations from what you asked for** — every kind, or `- none`.
- **Discussion** — OPTIONAL, only for nuance he needs. Bullets, never prose.
- **Asks** — the whole numbered sequence, every priority, with options lettered and `(Recommended)` marked.
- **Prior asks — closed by this report** — each with the phrase that says what it was, and how it closed.
- **Work product** and **Beads touched** — what exists now that did not before, and every bead id with its descriptive phrase.
- **Facts I could not measure** — anything the tool tried to autofill and could not. Never silently absent.
- **Handoff** — only when handing off.

## Thread reports (the tool)

When the `justin-sdk thread` tool is available, the report is recorded as a bead so open asks survive across turns and sessions. At wrap-up:

1. Run `justin-sdk thread prepare`. If the command is not found, or it prints `THREADS: DISABLED`, write the text report above and stop here. If it prints `THREADS: SANDBOX DENIED`, write the text report and file a P2 ask carrying the denial and the paths it names.
2. If it prints `THREADS: ENABLED`, it lists the session's open asks — each with what it will be closed as if you say nothing — and a payload skeleton. Write the payload JSON to `$TMPDIR` and run `justin-sdk thread report --file <path>`.
3. Paste the rendered report it prints **verbatim** as your final message. It is the compact report; the full one is on the bead.

In the payload: list a previous ask under `priorAsks` only if he answered it or it became irrelevant; restate a still-live question as a new ask with `"supersedes": "<old ask id>"`; give every deviation its `kind`. If it printed `NOT RECORDED`, still paste the report and add the failure as an ask.

At the start of a turn after Justin says his answers are in, run `justin-sdk thread inbox` and continue from the answers. If he answers in chat instead, disposition those asks in your next report.

Subagents (players, explorers, any agent dispatched by another session) never run these commands — they inherit the parent's session id and would overwrite its thread. They report to the session that dispatched them; that session reports for the arc.
