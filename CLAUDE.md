# justin-sdk

Cross-project SDK: one implementation of the tooling that would otherwise be copy-pasted into ~12 repos and drift. See `README.md` for usage, and run `justin-sdk agent` for the full agent playbook.

Validation bar here is `tsc --noEmit` + `bun test` — this repo has no ESLint config of its own (home-base's root eslint/prettier configs exclude `projects/`).

## Shape

- **Components** are installed per-repo with `justin-sdk add <component>` and recorded in the consumer's `justin-sdk.config.json`: `base-setup`, `gitignore`, `prettier`, `tsconfig`, `eslint`, `husky`, `gh-actions`, `prompts`, `claude-md`, `beads`, `eas`, `time-check`, `usage-check`, `critical-rules`. Presets: `minimal`, `core`, `all`. Default is **no commit** — files change in the working tree so the diff can be inspected first.
- **`check-runner`** is an importable module (`@justinhaaheim/justin-sdk/check-runner`), not a copied file. Checks support `severity: 'warn'` (non-blocking) vs `'error'`, and accept shell commands or TypeScript functions.
- **`signal` and `doctor` discover their work from the consumer's package.json** — `signal-source:LABEL` and `fix-source:LABEL` scripts. That keeps per-project variation in the project, not in a forked script.
- **`doctor` fixes scaffolding** (configs, deps); **`fix` fixes code** (eslint --fix, prettier --write). Keep them distinct — formatting is never auto-run at session start.
- **`sweep`** propagates a component across all enrolled repos, each in its own temp worktree with gates and a push. Its doctor/signal gates are a **ratchet**: each is measured before AND after the payload, and only green→red fails (home-base-ckc4). A red step removes its worktree and writes the evidence to `~/Dev/home-base/tmp/sdk-sweep/<run>.log`.

## Design principles

- **No hidden side effects.** Doctor checks warn, they never auto-fix. Auto-`bun install` at session start was rejected even at 70–250ms.
- **Write actions need a trigger, not a heartbeat.** Local `setup-env` runs at worktree creation and manual invocation only; remote runs at session start.
- **Every module must be independently complete.** Per-repo module selection means no module may lean on a sibling being present.
- **`--quiet` shows a one-liner on all-pass**, and only errors/warnings on failure.
- **Every JSON the SDK writes is prettier-formatted immediately, with the target repo's own prettier** — resolved from the repo's local `node_modules/.bin/prettier`, silently skipped when absent. Tool output must be idempotent, and most repos run prettier on commit. Local-binary-only on purpose: a `bunx prettier` fallback hit the registry on every write and blew the test suite past 120s.
- **Emit `justin-sdk` in all text, docs, aliases, and error messages** — never the bare `j`/`jsdk` bins, which exist only for Justin's own typing ease.
- **`bunx` bare package names are banned.** Use `bunx @justinhaaheim/justin-sdk <cmd>` in package.json aliases (local-first, keeps per-project pins) and `bunx github:justinhaaheim/justin-sdk <cmd>` for bootstrap. Measured hazard: `bunx j` and `bunx jsdk` resolve to real third-party npm packages.

## Gotchas

- **A release is four things: version + tag + push + consumer pin bump.** Bumping a git-dep's version without pushing a tag changes nothing for consumers pinned to tags.
- **Prefer `v`-prefixed tags.** With both `0.14.0` and `v0.14.0` present, `pickLatestTag` breaks the tie by gh API ordering — which tree you get is nondeterministic.
- **`bun test <path>` is a cwd-relative filter, not a path.** Run from the wrong directory it silently matches a different checkout's copy of the tests. Verify cwd before trusting a green run.
- **`bun install` runs NONE of the root package.json lifecycle scripts** — `preinstall`, `install`, `postinstall` and `prepare` are all skipped (measured, bun 1.4.0; npm DOES run them). So a repo that generates files from `postinstall` gets nothing from `setup-env`'s INSTALL step, and its fresh worktrees are missing those files. Hydration has to go through a `setup-env-source:<LABEL>` script or `.worktreeinclude`.
- **`bunx <pkg>` only resolves a local `node_modules/.bin` entry whose target is EXECUTABLE.** Without the exec bit it silently falls through to the registry — in a test fixture that turns a hermetic run into a network fetch whose 404 becomes the "measured" exit code.
- **Installers chain `base-setup`, which stamps the running SDK's version** — any in-process component run needs a pin-neutrality snapshot/restore guard so it doesn't bump pins as a side effect.
