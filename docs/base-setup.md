# Base Setup — justin-sdk CLI

This is the **foundation layer** for all of Justin's projects. It installs the justin-sdk package and configures the CLI-based tooling that other setup prompts (beads, eslint, prompts, etc.) build on top of.

**Prerequisites:** A TypeScript project using Bun as the package manager.

**What this installs:**

- `@justinhaaheim/justin-sdk` — Package providing the `justin-sdk` CLI with `doctor` and `signal` subcommands
- `justin-sdk.config.json` — Config file tracking SDK version and which components are installed
- `signal-source:*` scripts in package.json — Define which code quality checks to run
- `scripts/setup-env.ts` — SessionStart hook (installs tools in remote, validates locally)

**No scripts to copy.** Doctor and signal run via the SDK CLI. Only `setup-env.ts` is copied as a template.

---

## Step 1: Install the SDK package

```bash
bun add github:justinhaaheim/justin-sdk#0.2.0
bun add -d @types/bun
```

If `@types/bun` is already in devDependencies, skip that part.

---

## Step 2: Create justin-sdk.config.json

Create `justin-sdk.config.json` at the project root:

```json
{
  "version": "0.2.0",
  "components": ["base-setup"],
  "lastSynced": "YYYY-MM-DD"
}
```

Set `lastSynced` to today's date (run `date +%Y-%m-%d` to get it). Add component names as you apply additional setup prompts (e.g., `"beads-setup"`).

---

## Step 3: Wire up package.json

Add these scripts to `package.json`. Preserve any existing scripts — merge, don't replace.

```json
{
  "scripts": {
    "setup-env": "bun scripts/setup-env.ts",
    "signal": "bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts signal --quiet",
    "signal:verbose": "bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts signal",
    "signal:serial": "bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts signal --serial",
    "doctor": "bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts doctor",
    "doctor:fix": "bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts doctor --fix",
    "signal-source:TS": "tsc --noEmit",
    "signal-source:LINT": "eslint --report-unused-disable-directives --max-warnings 0 .",
    "signal-source:PRETTIER": "prettier --check ."
  }
}
```

### Adapt signal-source scripts for the project

The `signal-source:*` scripts define which checks `justin-sdk signal` runs. The label after `signal-source:` becomes the check name in the output. Adapt these to match what the project actually uses:

- If the project doesn't use ESLint yet, remove `signal-source:LINT`
- If the project uses oxlint, add `"signal-source:OXLINT": "oxlint --deny-warnings"`
- If the lint command is different (e.g., `eslint .` without extra flags), adjust accordingly

### Prerequisite scripts

The signal-source commands may reference other scripts. Ensure these exist:

- `ts-check` — typically `tsc --noEmit` (only if the project uses TypeScript)
- `lint-base` — typically `eslint --report-unused-disable-directives --max-warnings 0` (only if `signal-source:LINT` references it)

**Existing signal scripts:** If the project has old signal scripts (e.g., `signal:serial`, `signal:parallel` using `concurrently`, or `scripts/signal.ts`), replace them. The SDK CLI handles everything.

---

## Step 4: Copy setup-env.ts

Copy the setup-env template from the SDK into the project:

```bash
cp node_modules/@justinhaaheim/justin-sdk/templates/scripts/setup-env.ts scripts/setup-env.ts
```

Create the `scripts/` directory first if it doesn't exist. This is the **only** file that gets copied — everything else runs from the SDK package.

**If setup-env.ts already exists**, review it for any project-specific customizations before overwriting. The template handles: remote tool installation (mise, beads_rust), local doctor validation, and `bun install`.

---

## Step 5: Claude Code settings

### SessionStart hook

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"$CLAUDE_PROJECT_DIR/scripts/setup-env.ts\""
          }
        ]
      }
    ]
  }
}
```

**If SessionStart hooks already exist**, add to the existing array rather than replacing.

### PostToolUse hook (optional but recommended)

Auto-lint and auto-format on file edits:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | { read file_path; if [[ \"$file_path\" != \"$CLAUDE_PROJECT_DIR\"/* ]]; then echo \"Skipping - file outside project\"; else if [[ \"$file_path\" =~ \\.(ts|tsx|js|jsx|cjs|mjs)$ ]]; then bun run lint:fix:file -- \"$file_path\"; fi; bun run prettier --write -u \"$file_path\"; fi; }"
          }
        ]
      }
    ]
  }
}
```

---

## Step 6: Verification

```bash
# Signal check passes
bun run signal

# Doctor passes (may have fewer checks if beads etc. aren't set up yet)
bun run doctor

# Setup-env runs without error locally
bun scripts/setup-env.ts
```

---

## Step 7: Commit

```bash
git add scripts/setup-env.ts package.json justin-sdk.config.json .claude/settings.json
git commit -m 'Add base tooling via justin-sdk'
```

---

## What's scripted vs what needs an agent

**Scripted (deterministic):**

- Installing the SDK package
- Creating justin-sdk.config.json
- Adding package.json script entries
- Copying setup-env.ts
- Configuring SessionStart hook

**Agent (judgment needed):**

- Choosing which signal-source checks to include based on the project's tooling
- Merging into existing .claude/settings.json (hooks, permissions) without clobbering
- Adapting setup-env.ts if the project has unusual requirements
- Resolving conflicts with existing scripts or configurations

---

## Migration from older justin-sdk versions

### From v0.1.x (copied check-runner + signal + doctor scripts)

If the project has local `scripts/check-runner.ts`, `scripts/signal.ts`, and/or `scripts/doctor.ts` from an earlier version:

1. Update the SDK package: `bun add github:justinhaaheim/justin-sdk#0.2.0`
2. Add `signal-source:*` scripts to package.json (see Step 3)
3. Update package.json `signal` and `doctor` scripts to use the CLI (see Step 3)
4. Delete local scripts that are no longer needed:
   - `scripts/check-runner.ts` — now imported from the SDK package
   - `scripts/signal.ts` — replaced by `justin-sdk signal` CLI + `signal-source:*` scripts
   - `scripts/doctor.ts` — replaced by `justin-sdk doctor` CLI + `justin-sdk.config.json` components
5. Update `justin-sdk.config.json` version to `0.2.0`
6. Run `bun run signal` and `bun run doctor` to verify

### From pre-SDK setup (no justin-sdk at all)

If the project has hand-written signal/doctor scripts or uses `concurrently` for signal:

1. Follow Steps 1–7 above (fresh install)
2. Remove any old signal scripts (`signal-perf.ts`, `signal:parallel`, etc.)
3. Remove `concurrently` dependency if it was only used for signal

---

## How components work

The `justin-sdk.config.json` `components` array determines which doctor checks run. Each component (e.g., `"base-setup"`, `"beads-setup"`) registers its own set of doctor checks in the SDK. When you apply a new setup prompt (like `beads-setup.md`), add the component name to the array — the corresponding doctor checks activate automatically.

This means doctor checks are **not maintained per-project**. They live in the SDK and are updated centrally. Upgrading the SDK version gives you improved/new checks for all your components.
