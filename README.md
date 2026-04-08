# justin-sdk

Cross-project SDK for Justin Haaheim's projects. Provides a CLI for
environment health checks, code quality signal, and turnkey component
installation (beads issue tracking, etc.), plus importable modules for
custom check trees.

## Quick start for AI coding agents

If you're an AI coding agent that just got asked to work on a Justin
Haaheim project, run this command first to get your bearings:

```bash
bunx github:justinhaaheim/justin-sdk#main agent
```

It prints a self-contained playbook with everything you need — who
Justin is and what he values, what justin-sdk does, the full workflows
for common tasks (adding beads, migrating from bd, running doctor),
known gotchas from real migrations, and commit conventions. No other
context required.

## Quick start for humans

```bash
# Add beads issue tracking to this project (also handles migration
# from bd to beads_rust)
bunx github:justinhaaheim/justin-sdk#main add beads

# Check the project's environment health
bunx github:justinhaaheim/justin-sdk#main doctor

# Run code quality checks (reads signal-source:* from package.json)
bunx github:justinhaaheim/justin-sdk#main signal
```

If you'd rather install the SDK locally:

```bash
bun add github:justinhaaheim/justin-sdk#main
# Then use any of:
bunx justin-sdk doctor
bunx jsdk doctor
bunx j doctor
```

## Commands

| Command                       | What it does                                          |
| ----------------------------- | ----------------------------------------------------- |
| `justin-sdk agent`            | Print the agent playbook (AI coding agent onboarding) |
| `justin-sdk doctor`           | Run environment health checks based on components    |
| `justin-sdk doctor --fix`     | Auto-run project-local fixes                          |
| `justin-sdk doctor --fix -y`  | Also run system-level installs (mise, br, bun)        |
| `justin-sdk signal`           | Run `signal-source:*` scripts from package.json       |
| `justin-sdk add beads`        | Install beads_rust issue tracking (with migration)   |
| `justin-sdk --help`           | Command reference                                     |

The CLI is exposed under three equivalent names: `justin-sdk`, `jsdk`,
and `j`.

## Components

Projects track which justin-sdk components they have installed in
`justin-sdk.config.json` at the project root:

```json
{
  "version": "0.3.0",
  "components": ["base-setup", "beads-setup"],
  "lastSynced": "2026-04-08"
}
```

Available components:

- **base-setup** — Foundation: package.json scripts, `justin-sdk.config.json`,
  CLAUDE.md reference. Installed by default when you run any SDK command.
- **beads-setup** — beads_rust issue tracker via mise, AGENTS.md, CLAUDE.md
  integration via `@docs/prompts/BEADS.md` pattern. Add via `add beads`.

Adding a component installs it AND registers it for future doctor checks.

## Central version pins

Tool versions live in `versions.json` in this repo:

```json
{
  "beads_rust": "0.1.35"
}
```

All of Justin's projects read from this (via the doctor check and the
`add beads` command). Bumping the version here propagates to every
project on its next doctor run.

## Doctor: approval gating for system-level fixes

Checks are split into two categories:

- **Project-local fixes** (file edits, `br init`, etc.) run automatically
  under `--fix`.
- **System-level installs** (brew, npm global, curl pipe-to-bash) require
  explicit approval via `--yes` / `-y`. Without `--yes`, they're reported
  but skipped.

This lets `doctor --fix` be safe to run on a dev machine (won't silently
install anything globally) while `doctor --fix --yes` works for
sandboxes, CI, and Docker containers.

## Importable modules

In addition to the CLI, the SDK exports modules you can import:

```typescript
import type {Check, CheckNode, CheckResult} from '@justinhaaheim/justin-sdk/check-runner';
import {runChecks, runCheckTree} from '@justinhaaheim/justin-sdk/check-runner';
```

The `check-runner` module powers doctor and signal. You can use it to
build your own check trees with parallel/serial execution, tree-based
dependencies, severity levels (error vs warn), and `--fix` support.

## Setup prompt docs

Human-readable guides for manually applying each component (mostly
superseded by the `add <component>` CLI commands, but useful for
reference):

- `docs/base-setup.md` — base-setup component
- `docs/beads-setup.md` — beads-setup component

## Template scripts

Minimal templates that get copied into each project:

- `templates/scripts/setup-env.ts` — SessionStart hook. Bootstraps bun
  + mise + PATH in remote/sandbox environments, runs `doctor --quiet`
  locally.
