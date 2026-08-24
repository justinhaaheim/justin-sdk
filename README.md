# justin-sdk

Cross-project SDK for Justin Haaheim's projects. Provides a CLI for environment health checks, code quality signal, and turnkey component installation (beads issue tracking, etc.), plus importable modules for custom check trees.

## Quick start for AI coding agents

If you're an AI coding agent that just got asked to work on a Justin Haaheim project, run this command first to get your bearings:

```bash
bunx github:justinhaaheim/justin-sdk#main agent
```

It prints a self-contained playbook with everything you need — who Justin is and what he values, what justin-sdk does, the full workflows for common tasks (adding beads, migrating from bd, running doctor), known gotchas from real migrations, and commit conventions. No other context required.

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
# Then, from anywhere in the project:
bunx @justinhaaheim/justin-sdk doctor
```

**Never `bunx` a bare name — always name the package.** When `bunx` cannot resolve a bare name from a nearby `node_modules/.bin`, it does not fail: it treats the name as an npm package and fetches it. `justin-sdk` is unclaimed on npm, but **`j` and `jsdk` are both real, unrelated third-party packages** — measured, both resolve on the registry today. So handing either short name to `bunx` can download and execute a stranger's code in any tree where the SDK isn't installed: a fresh worktree, a fresh clone, anything pre-install (home-base-2qhw). Use exactly two forms: `bunx @justinhaaheim/justin-sdk <cmd>` in a project that has the SDK installed, and `bunx github:justinhaaheim/justin-sdk <cmd>` anywhere else.

The short `jsdk` / `j` bins are real and fine — but only where `node_modules/.bin` is already on `PATH`, i.e. inside a `package.json` script (`bun run` puts it there) or a shell you have set up that way. Never after `bunx`.

## Commands

| Command | What it does |
| --- | --- |
| `justin-sdk agent` | Print the agent playbook (AI coding agent onboarding) |
| `justin-sdk doctor` | Run environment health checks based on components |
| `justin-sdk doctor --fix` | Auto-run project-local fixes |
| `justin-sdk doctor --fix -y` | Also run system-level installs (mise, br, bun) |
| `justin-sdk signal` | Run `signal-source:*` scripts from package.json |
| `justin-sdk add beads` | Install beads_rust issue tracking (with migration) |
| `justin-sdk add core` | Install a preset bundle of components (see Presets) |
| `justin-sdk --help` | Command reference |

The CLI is exposed under three equivalent names: `justin-sdk`, `jsdk`, and `j`. They are equivalent as INSTALLED bins (on `PATH`, or via `bun run`) — not as `bunx` arguments; see the warning above.

## Components

Projects track which justin-sdk components they have installed in `justin-sdk.config.json` at the project root:

```json
{
  "version": "0.3.0",
  "components": ["base-setup", "beads-setup"],
  "lastSynced": "2026-04-08"
}
```

Available components:

- **base-setup** — Foundation: package.json scripts, `justin-sdk.config.json`, CLAUDE.md reference. Installed by default when you run any SDK command.
- **beads-setup** — beads_rust issue tracker via mise, AGENTS.md, CLAUDE.md integration via `@docs/prompts/BEADS.md` pattern. Add via `add beads`.
- **critical-rules-setup** — writes the committed rules artifact `.claude/rules/justin-sdk/critical-rules.md`, assembled from the prompts repo with an opt-in module list recorded in `componentConfig["critical-rules"].modules`. Opt-in only; add via `add critical-rules`, regenerate with `rules-update`, propagate with `sweep --component critical-rules`.

Adding a component installs it AND registers it for future doctor checks.

### Presets

`add` also accepts a preset name that expands to several components, run in dependency order (each one self-registers in `justin-sdk.config.json`):

- **minimal** — `base-setup` + `beads`
- **core** — code-quality + beads: `gitignore`, `prettier`, `tsconfig`, `eslint`, `husky`, `beads`
- **all** — every component (`core` + `gh-actions`, `prompts`, `claude-md`)

```bash
bunx github:justinhaaheim/justin-sdk#main add core   # the always-want baseline
bunx github:justinhaaheim/justin-sdk#main add all    # everything
```

Presets are always no-commit — files change in the working tree and you inspect the diff and commit yourself. (`init` is the greenfield equivalent that also scaffolds `package.json` and commits.)

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

Human-readable guides for manually applying each component (mostly superseded by the `add <component>` CLI commands, but useful for reference):

- `docs/base-setup.md` — base-setup component
- `docs/beads-setup.md` — beads-setup component

## Template scripts

Minimal templates that get copied into each project:

- `templates/scripts/setup-env.ts` — SessionStart hook. Bootstraps bun
  - mise + PATH in remote/sandbox environments, runs `doctor --quiet` locally.
