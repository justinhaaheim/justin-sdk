<!-- GENERATED: this repository is a published snapshot of home-base/pkg/justin-sdk. Do not edit it here; edit it in home-base and run `bun run sdk:publish`. -->

# justin-sdk

Cross-project SDK for Justin Haaheim's projects. Provides a CLI for environment health checks, code quality signal, and turnkey component installation (beads issue tracking, etc.), plus importable modules for custom check trees.

## Quick start for AI coding agents

If you're an AI coding agent that just got asked to work on a Justin Haaheim project, run this command first to get your bearings:

```bash
bun run justin-sdk agent
```

It prints a self-contained playbook with everything you need — who Justin is and what he values, what justin-sdk does, the full workflows for common tasks (adding beads, migrating from bd, running doctor), known gotchas from real migrations, and commit conventions. No other context required.

In a repo that is not enrolled yet, bootstrap it instead: `bunx github:justinhaaheim/justin-sdk agent`.

## How to invoke the SDK

There are exactly two forms, and one bootstrap exception (epic `home-base-dchjw`, decision D1).

| Where you are | What to type |
| --- | --- |
| In an enrolled repo — you, an agent, or a hook | `bun run justin-sdk <cmd>` |
| Inside a `package.json` script VALUE | `justin-sdk <cmd>` (bare) |
| In a repo that has never installed the SDK (bootstrap only) | `bunx github:justinhaaheim/justin-sdk <cmd>` |

`bun run` prepends `node_modules/.bin` to `PATH`, so both of the first two resolve the repo's own pinned tag — offline, and with no network lookup. It is the same way `eslint`, `prettier` and `tsc` are invoked everywhere on the fleet.

**Every `bunx` spelling of the SDK other than the pinned/bootstrap `github:` one is retired**, and an `install` rewrites any it finds:

- `bunx @justinhaaheim/justin-sdk` — the scope is not demonstrably Justin's on npm and the name 404s there, so whenever local resolution fails this falls through to the public registry: the dependency-confusion shape (`home-base-2qhw`).
- `bunx justin-sdk`, `bunx jsdk`, `bunx j` — the same fallthrough with no scope at all, and **`j` and `jsdk` are real, unrelated third-party packages** (measured; both resolve on the registry today). The `j` and `jsdk` bins have been removed from `package.json` entirely.
- An UNPINNED `bunx github:…` outside bootstrap — bunx caches a github spec by spec STRING, not by resolved commit, so it silently keeps serving whatever it fetched first.

To run the newest published SDK from anywhere (including outside any repo), use home-base's `justin-sdk-latest <cmd>`.

## Quick start for humans

```bash
# Add beads issue tracking to this project (also handles migration
# from bd to beads_rust)
bun run justin-sdk add beads

# Check the project's environment health
bun run justin-sdk doctor

# Run code quality checks (reads signal-source:* from package.json)
bun run justin-sdk signal
```

Enrolling a repo that does not have the SDK yet:

```bash
bunx github:justinhaaheim/justin-sdk init
# init adds the devDependency (pinned to a tag it verifies exists on the
# remote) and the package.json scripts; after `bun install`, use `bun run`.
```

## Commands

| Command | What it does |
| --- | --- |
| `justin-sdk agent` | Print the agent playbook (AI coding agent onboarding) |
| `justin-sdk doctor` | Run environment health checks based on components |
| `justin-sdk doctor --fix` | Auto-run project-local fixes |
| `justin-sdk doctor --fix -y` | Also run system-level installs (mise, br, bun) |
| `justin-sdk signal` | Run `signal-source:*` scripts from package.json |
| `justin-sdk init` | Enrol a repo: config + SDK devDependency + shared scripts. No components. |
| `justin-sdk list` | Every component: purpose, installed here?, applies here?, in the config? |
| `justin-sdk add <c…>` | Install one or more components (or `core`) and record them |
| `justin-sdk remove <c…>` | Take components back out — byte-identical artifacts only |
| `justin-sdk install` | Reconcile the disk to `justin-sdk.config.json`, both directions |
| `justin-sdk update` | Bump the SDK pin to the newest tag, then `install` |
| `justin-sdk session-start` | The SessionStart hook (see below) |
| `justin-sdk justin-loop` | Chain Claude Code sessions on one arc through handoff beads (see below) |
| `justin-sdk thread` | Status reports as beads, one per session (see below) |
| `justin-sdk --help` | Command reference |

The CLI is exposed under ONE name, `justin-sdk`. The short `jsdk` and `j` bins were removed in v0.39 (epic home-base-dchjw D1): they existed only for typing ease, and both names resolve to real, unrelated packages on the npm registry, so every place one of them was typed after `bunx` was a live hazard.

## Session start: one command, two hooks

`justin-sdk session-start` is the whole of what runs when a Claude Code session opens. It replaced the `prime` Claude Code plugin in v0.39 (epic home-base-dchjw D6) — the plugin was a second, independently-versioned copy of this logic installed from a marketplace with no `autoUpdate`, and it sat 178 commits stale for a month, twice, with nothing detecting it. There is now one implementation, versioned by the repo's own pin.

It is read-only and always exits 0. Locally it emits `doctor --quiet`, the repo-state block (unmerged work on other branches and worktrees) and the rules-drift notice, as a SessionStart JSON envelope: the repo state and doctor's report go to the model, the rules freshness verdicts go to you. Remotely (`CLAUDE_CODE_REMOTE=true`) it hands off to `setup-env`, because a fresh container needs hydrating rather than advising.

**Two hooks call it, and they never both act.**

1. **The project hook**, written into an enrolled repo's `.claude/settings.json` by `base-setup`. Nothing to do by hand — `add base-setup` or `install` writes it, and rewrites an older spelling in place.
2. **The user-level hook**, in `~/.claude/settings.json`. This is what keeps the repo-state block reaching repos that are _not_ enrolled. **It is the one manual step**, because justin-sdk never writes your user-level settings — `doctor` warns when it is missing (`USER_LEVEL_SESSION_START`) and prints this, which you paste in:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -e \"${CLAUDE_PROJECT_DIR:-.}/justin-sdk.config.json\" ] || ! command -v justin-sdk-latest >/dev/null || justin-sdk-latest session-start --user-level"
          }
        ]
      }
    ]
  }
}
```

The guard is in the hook string on purpose: an enrolled repo (the project hook owns it) and a machine without home-base's `justin-sdk-latest` on PATH both short-circuit before anything is spawned, so neither ever touches the network. `--user-level` re-checks enrolment itself, because `CLAUDE_PROJECT_DIR` is not guaranteed to be set. The project root is `$CLAUDE_PROJECT_DIR`, else the git toplevel of the cwd, else the cwd — never a walk up the parent chain, so a session in `~/Downloads` or inside a subdirectory is not silenced by an unrelated ancestor.

## Chaining sessions: `justin-loop`

```bash
bun run justin-sdk justin-loop --help          # the runner's knobs
bun run justin-sdk justin-loop handoff --help  # the fields a session writes
```

`justin-loop` runs a chain of Claude Code sessions on one arc. Each session ends by writing a **handoff bead** — what happened, and the successor's full starting instructions — and that bead is also what tells the runner whether to spawn a successor at all. There is no verdict file: the control channel is a committed bead, so the state of the chain survives in git rather than in the runner's memory.

A handoff carries one of three dispositions, and the runner acts on it:

| `--disposition` | What the runner does |
| --- | --- |
| `continue` | Boots a successor whose prompt is the handoff's `--next`, verbatim |
| `done` | The arc is finished — the run stops and the bead is closed |
| `blocked` | Only Justin can answer `--open-question` — the run stops with exit 2 |

**Answering a blocked chain** (added 2026-09-19): `justin-sdk justin-loop handoff answer <id>` folds your answers into that bead's `next`, flips it to `continue`, and prints the command that restarts the arc from it. The answers come from `--answer` (repeat it to answer several questions IN ORDER, or give one to answer them all), `--answer-file` for anything multi-paragraph, or stdin when you pass neither. It refuses anything that is not an open, readable, blocked handoff. `handoff validate [id]` re-checks a bead against the schema — with no id, every open handoff.

**The knobs that bound a run** are the ones to choose deliberately. `--help` prints each one's current default, and every other flag besides.

| Flag | What it bounds |
| --- | --- |
| `--max-sessions` | How many sessions the chain may spawn in total |
| `--timeout-min` | Per-session wall clock. Off by default — a session is then bounded by the ~300k wrap-up notice rather than by the clock |
| `--handoff-settle-min` | Opt-in belt for the measured D15 stall: a session whose handoff bead is written while its `claude agents` row never reaches `done`. No scan is made until you set it, because settling can stop a session mid-commit |
| `--blocked-wait-min` | How long a blocked session waits for Justin. Omitted, it waits indefinitely — blocked means waiting for him, and the runner does not decide he took too long |
| `--session-stop-pct` / `--weekly-stop-pct` | The 5-hour and weekly quota windows. `--usage-gate` is ON and refuses to run when /usage cannot be read — an unreadable quota is reported as UNKNOWN, never as 0% |
| `--model` / `--permission-mode` | What every session in the chain is spawned with |

`--dry-run` prints the quota and what is waiting, then exits without spawning. Run state is appended to `runs.jsonl` under `--state-dir` (`~/.local/state/justin-sdk/justin-loop`), outside git on purpose — the facts you read live in the committed handoff beads.

**Run it from a real terminal, never from inside a Claude session** — the runner warns, and a nested `claude` may EPERM. The pilot invocation, kept current on `home-base-1r6d.33.5`:

```bash
cd ~/Dev/home-base && bun run justin-sdk justin-loop --max-sessions 3 --model fable --label pilot2 --timeout-min 45 --handoff-settle-min 3 --prompt '/conductor <ask>'
```

Design and decisions live on epic **`home-base-1r6d.33`** — read it before changing runner behaviour, and run `bun run e2e:justin-loop` before a release (it is the only thing that drives a real `claude --bg` and a real `br`, and it cannot run in CI; the reasons are in `CLAUDE.md`). One `--help` quirk worth knowing: yargs repeats the runner's own options under every subcommand, so the fields that actually belong to `handoff` — `--from`, `--disposition`, `--arc`, `--worktree`, `--branch`, `--state`, `--next`, `--open-question`, `--context-tokens` — are at the END of that listing.

## Status reports as beads: `thread`

```bash
bun run justin-sdk thread --help    # every subcommand
bun run justin-sdk thread prepare   # ALWAYS run this before writing a report
```

`thread` turns the end-of-session status report from prose Justin has to parse into data: one **thread bead** per Claude Code session in `~/Dev/threads`, with a child **ask bead** for every single thing he has to do, so open asks survive across turns and sessions instead of evaporating with the conversation.

The write path is `prepare` → payload JSON → `report`. `prepare` prints `THREADS: ENABLED | DISABLED | SANDBOX DENIED` (the line the wrap-up rule branches on), this session's thread bead, every open ask with Justin's answers verbatim, the facts the report will attach (you type none of them), and the payload skeleton with where to write it. Then `thread report --file <path>` validates, archives, upserts the bead with its child asks, and prints the rendered report — **exit 0 recorded · 1 NOT RECORDED · 2 refused**, so a report that was not recorded can never be mistaken for one that was.

The read path is `thread board` (every live thread, grouped by repo, `--open-asks` for everything waiting on him), `thread show [threadId]`, `thread search <query…>` (which session was that phrase written in, plus the command that resumes it) and `thread inbox` — what a session reads at the START of a turn to pick up what Justin answered or skipped. `thread answer` is his side of it; `thread backfill` writes a bead for every session of the last 30 days that never reported.

**Linking a successor to its predecessor** (added 2026-09-19, `home-base-k0b8n.5`): `prepare` and `report` both take `--continues-from-session <claude session id>`, which resolves that session to its thread bead and uses it as `continuesFrom` — for `prepare`, listing ITS open asks as ones this report must disposition. Both fall back to **`$JUSTIN_LOOP_PREDECESSOR_SESSION_ID`**, which the `justin-loop` runner sets on a successor's dispatch, so a chained session links itself with no flag typed anywhere. A payload's own `continuesFrom` always wins, and a predecessor with no thread bead is named out loud while the report is still written, unlinked. `--continues-from <threadId>` names the thread bead directly instead.

It is knob-gated and off by default: `componentConfig.thread.enabled` is the preflight branch point rather than a master switch (the commands still work by hand when it is false), `.startOnSessionStart` creates the bead at session start, and `.enforce` arms the Stop hook that can block a session ending on a report it cannot prove was recorded. Run `bun run justin-sdk config schema` for every key, its default and the reasoning behind it; the hooks themselves come from `add thread-hooks`.

Design lives on epics **`home-base-p1uj`** (the write and read paths) and **`home-base-k0b8n`** (searchable session memory, the verbatim messages, `continuesFrom`). The report FORMAT — the glance line, the ask priorities, the section order — is specified by a rule in the prompts repo (`src/rules/status-report-format.md`); this command renders it.

## Components

Projects track which justin-sdk components they have installed in `justin-sdk.config.json` at the project root:

```json
{
  "components": ["beads-setup"]
}
```

`components` is **optional**, and `{}` is a complete config: an absent list means the `core` preset, computed for that repo every time it is read, so a repo tracks `core` as the registry grows instead of freezing today's list. An EMPTY list is a different statement — "this repo installs nothing" — and is honoured as written. Only `add` and `remove` write the key, and `base-setup` is never listed: every installer applies it, so it is implicit. (The old `version` and `lastSynced` stamps are gone — they were written by the SDK and read by nothing. The package.json pin is the version.)

Available components:

- **base-setup** — Foundation: package.json scripts, `justin-sdk.config.json`, CLAUDE.md reference. Installed by default when you run any SDK command.
- **beads-setup** — beads_rust issue tracker via mise, plus AGENTS.md. Add via `add beads`.
- **critical-rules-setup** — writes the committed rules artifact `.claude/rules/justin-sdk/critical-rules.md`, assembled from the prompts repo's rules registry. Which modules a repo gets is decided by that registry plus the project-type predicates (`isReact`, `isReactNative`, `isBeadsRust`), re-evaluated every time the artifact is regenerated — there is no per-repo module list, and a config still carrying the retired `componentConfig["critical-rules"].modules` gets one warning and is otherwise ignored. In `core`; add via `add critical-rules`, regenerate with `rules-update`, propagate with `sweep --component critical-rules`.

Adding a component installs it AND registers it for future doctor checks.

### The `core` preset

There is exactly one preset, and it is **computed, not listed**: `core` is every component whose `includeIf` predicates pass for the repo you run it in, minus the implicit `base-setup`. `eas` carries `includeIf: [isExpo]`, so it is in `core` for an Expo app and absent everywhere else; everything else applies to every repo.

```bash
bun run justin-sdk add core            # everything that applies here
bun run justin-sdk add --help          # prints what core expands to in THIS repo
bun run justin-sdk config schema       # the same expansion, with every config default
```

The old `minimal` and `all` presets are gone. `all` was "core plus the opt-in extras", computed from a hand-written exclusion list that withheld six components — including `critical-rules`, which is the point of the SDK — while including the now-retired `prompts`. A repo that wants less than `core` lists what it wants.

`add` is always no-commit for more than one component — files change in the working tree and you inspect the diff and commit yourself.

### The lifecycle: init → add/remove → install

The commands mirror npm's, and the split matters: **`add` and `remove` edit the manifest, `install` makes the disk match it, `update` is `install` with a pin bump in front.**

- **`init`** writes `justin-sdk.config.json`, the SDK devDependency (pinned to a tag verified on the remote) and the shared package.json scripts — and stops. It installs no components, and writes no `components` key unless you pass `--components a,b`, so the repo tracks `core` as the registry grows.
- **`add <c…>`** / **`remove <c…>`** are variadic and write the `components` key. Nothing else does.
- **`install`** installs what the config lists and the repo lacks and re-applies the rest. It **never removes**: anything on disk the config does not list is named and kept, because "installed" is evidence like a filename or a matching line, not proof the SDK wrote it. `--dry-run` previews. `--prune` also removes those, under the identity rules below; **`--prune --dry-run` prints the whole plan first** — every file, line, script, hook entry and config key, with its verdict.
- **`update`** = `self-update` (bump the pin to the newest tag, re-exec) + `install`. `--no-self-update` reconciles against the current pin.

**How removal decides what it may delete.** By identity, never by name:

| On disk | What happens |
| --- | --- |
| Byte-identical to what the component would write now | deleted — `removed: <path>` |
| Differs at all (hand-edited, older template) | kept — `left in place (modified): <path>` |
| Content the SDK cannot reconstruct (`.beads/`, the generated rules artifact, a composed husky hook) | kept — `left in place (content not reconstructible): <path>` |

Appended entries — package.json scripts, `.gitignore` / `.prettierignore` lines, `.claude/settings.json` hooks, `componentConfig` blocks, the `lint-staged` block — go only on an exact match of the value the component writes. A `componentConfig` block you have **tuned** (a `gapHours` you chose, an `enabled: false`, a `wrapUpAt`) is yours: dropping the component leaves your settings and says `left in place (modified)`. Some keys belong to more than one thing and are never touched at all: `signal-source:TS|LINT|PRETTIER` are base-setup's (every enrolled repo gets them), and `prebuild` / `eas-build-post-install` run version-manager, which plenty of non-Expo repos use on its own.

There is deliberately **no `--force`**: a flag that turns "I could not verify this" into "delete it anyway" is the whole hazard the design exists to remove. What each component owns is declared in `src/component-manifest.ts`.

## Central version pins

Tool versions live in `versions.json` in this repo:

```json
{
  "beads_rust": "0.1.35"
}
```

All of Justin's projects read from this (via the doctor check and the `add beads` command). Bumping the version here propagates to every project on its next doctor run.

## Doctor: approval gating for system-level fixes

Checks are split into two categories:

- **Project-local fixes** (file edits, `br init`, etc.) run automatically under `--fix`.
- **System-level installs** (brew, npm global, curl pipe-to-bash) require explicit approval via `--yes` / `-y`. Without `--yes`, they're reported but skipped.

This lets `doctor --fix` be safe to run on a dev machine (won't silently install anything globally) while `doctor --fix --yes` works for sandboxes, CI, and Docker containers.

## Health notices

When a newer `justin-sdk` tag exists, most commands print a two-line notice on **stderr** before their own output:

```
justin-sdk 0.24.0 → 0.26.0 available (minor)
  upgrade: bun run justin-sdk update
```

The remote tag list is fetched at most once an hour (a failed fetch counts, so being offline costs one attempt per hour, not one per command) and is given **2 seconds** to answer — `justin-sdk update`, where that listing is the job rather than an errand, still waits the full 5. Only plain `X.Y.Z` tags count: prereleases are out of scope for the fleet, so `v0.27.0-rc.1` is ignored on purpose. `doctor` reports the same thing as its `SDK_VERSION` check — with fix TEXT only, never a `fixCommand`, so `doctor --fix --yes` never upgrades anything by itself.

Each kind of bump is throttled **per repo**, and "repo" means the directory holding `justin-sdk.config.json`, found by walking up from wherever the command was run (stopping at the enclosing repository, so a submodule never resolves to its parent). Running from `src/` and from `scripts/` is therefore the same repo, and says it once. Rows for repos nothing has run in for 30 days are dropped.

Which commands may print it is set per bump kind by `promptTier`: **1** never, **2** only `doctor`, **3** `doctor` plus interactive commands (`signal`, `fix`, `add`, `worktree-new`, …), **4** every command. Hooks (`time-check`, `usage-check`, `session-start`), the upgrade commands themselves (`update`, `sweep`), and anything whose stdout is read by something other than a person (`justin-loop handoff`, `skill`) never print it at any tier.

### The doctor heartbeat

The same layer also keeps `doctor` running on its own. In an enrolled repo (one with a `justin-sdk.config.json`), an eligible command runs `justin-sdk doctor --quiet` as a child process at most once an hour per repo — enough to notice a problem that started hours into a session, which the SessionStart hook's single run cannot. It runs against the repo root, so it works from any subdirectory. It never touches stdout and never changes the command's exit code.

Two commands never trigger one: `doctor` itself, and `setup-env` — the post-checkout hook runs `setup-env` on a worktree that is not hydrated yet, where doctor would report the failures hydration is about to fix.

On a clean run it says **nothing**. Set `doctor.showOnPass: true` and it prints one line instead:

```
✅ justin-sdk doctor: 18 pass, 1 warn
```

Any error-severity failure is always printed, whatever `showOnPass` says — the failing checks reach stderr verbatim, under a header naming the repo, followed by `full run: bun run justin-sdk doctor`. Warnings do not: doctor exits 0 for them, and they show up in the `showOnPass` counts.

```json
{
  "healthNotices": {
    "doctor": {"intervalMinutes": 60, "promptTier": 3, "showOnPass": false}
  }
}
```

`promptTier` works exactly as it does above. `intervalMinutes` is measured from the last run **in that repo**, and a run that could not be made — the child failed to spawn, or hit its 60-second timeout — is recorded as a failure with its reason, so it is not retried on the next command.

### Configuring both

Configure them under `healthNotices` in `~/.config/justin-sdk/config.json` (everywhere) or a repo's `justin-sdk.config.json` (that repo only) — run `justin-sdk config schema` for every key, its type, its default and whether it is required. Unknown keys are always allowed; a known key with the wrong type, or a missing required one, makes the whole file fail validation, and a file that fails contributes **nothing** (`doctor`'s `CONFIG_SCHEMA` check names it).

To switch it all off: `healthNotices.enabled: false` in either file, or `JUSTIN_SDK_HEALTH_NOTICES=off` for one invocation. It is off automatically in CI and in remote Claude Code sessions.

## Importable modules

In addition to the CLI, the SDK exports modules you can import:

```typescript
import type {
  Check,
  CheckNode,
  CheckResult,
} from '@justinhaaheim/justin-sdk/check-runner';
import {runChecks, runCheckTree} from '@justinhaaheim/justin-sdk/check-runner';
```

The `check-runner` module powers doctor and signal. You can use it to build your own check trees with parallel/serial execution, tree-based dependencies, severity levels (error vs warn), and `--fix` support.

## Setup prompt docs

- `docs/base-setup.md`, `docs/beads-setup.md` — hand-application guides from before the component CLI existed. **Both are STALE** (they pin SDK 0.2.0, tell you to copy `scripts/setup-env.ts`, and describe the retired `prompts` component); `justin-sdk add <component>` and `justin-sdk skill` are the current answer. Rewriting or retiring them is tracked under epic `home-base-dchjw`.

## Templates

`templates/` holds the files components write verbatim: the `.gitignore`, `.prettierrc.json`, `.prettierignore`, `tsconfig.node-cli.json` and `eslint.config.cjs` baselines, the `.husky/` hooks, and the `signal.yml` workflow. Each is read straight off disk by its installer, and by `component-manifest.ts` to decide whether a file on disk is still pristine enough to remove.

One entry is NOT written any more: `templates/scripts/setup-env.ts` is the retired per-project hook script, kept only so `base-setup` can recognise a committed copy by its hash and delete it. The `setup-env` command replaced it (`home-base-j2n7`).
