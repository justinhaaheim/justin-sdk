# Base Setup — check-runner, signal, doctor, setup-env

This is the **foundation layer** for all of Justin's projects. It installs the shared scripting infrastructure that other setup prompts (beads, eslint, prompts, etc.) build on top of.

**Prerequisites:** A TypeScript project using Bun as the package manager.

**What this installs:**

- `@justinhaaheim/justin-sdk` — Package containing the check-runner engine (imported, not copied)
- `scripts/signal.ts` — Lint/TS/Prettier checks (copied from templates, project-specific)
- `scripts/doctor.ts` — Environment validation with `--fix` mode (copied from templates, project-specific)
- `scripts/setup-env.ts` — SessionStart hook (copied from templates)

**Source of truth:** The `@justinhaaheim/justin-sdk` package on GitHub. Templates live in the package at `templates/scripts/`.

---

## Step 1: Install the SDK package and @types/bun

```bash
bun add github:justinhaaheim/justin-sdk#0.1.0
bun add -d @types/bun
```

The SDK provides `check-runner` as an importable module. The scripts use Bun APIs (`Bun.spawn`, `import.meta.dirname`, etc.).

If `@types/bun` is already in devDependencies, skip that part.

---

## Step 2: Copy template scripts

Copy these template files from the SDK package into the target project:

| Source (SDK package)                    | Destination (target project) |
| --------------------------------------- | ---------------------------- |
| `templates/scripts/signal.ts`           | `scripts/signal.ts`          |
| `templates/scripts/doctor.ts`           | `scripts/doctor.ts`          |
| `templates/scripts/setup-env.ts`        | `scripts/setup-env.ts`       |

**Note:** `check-runner.ts` is NOT copied — it's imported from the SDK package. signal.ts and doctor.ts already have the correct import path (`@justinhaaheim/justin-sdk/check-runner`).

**Important:** These templates are meant to be **copied and adapted**. Each project owns its copies and may diverge (e.g., different signal checks, project-specific doctor checks).

The template files can be found at:
```bash
ls node_modules/@justinhaaheim/justin-sdk/templates/scripts/
```

### Adapt signal.ts for the project

The default `signal.ts` runs TS, ESLint, and Prettier. Adjust the checks array to match what the project uses. For example, if the project also uses oxlint:

```typescript
const checks: Check[] = [
  {label: 'TS', command: 'bun run ts-check'},
  {label: 'OXLINT', command: 'oxlint --deny-warnings'},
  {label: 'LINT', command: 'bun run lint-base -- .'},
  {label: 'PRETTIER', command: 'bun run prettier:check'},
];
```

### Adapt doctor.ts for the project

Start with a **minimal doctor** that only checks what's actually set up. If the project doesn't use beads yet, remove the beads checks. The doctor should only fail for things the project actually requires.

A minimal base doctor might only check:

```typescript
const checks: Check[] = [{label: 'CLAUDE_MD', fn: checkClaudeMdExists}];
```

Beads, mise, and other checks get added when those tools are set up via their respective prompt docs.

---

## Step 3: Wire up package.json

Add these scripts to `package.json`. Preserve any existing scripts — merge, don't replace.

```json
{
  "scripts": {
    "setup-env": "bun scripts/setup-env.ts",
    "signal": "bun scripts/signal.ts --quiet",
    "signal:verbose": "bun scripts/signal.ts",
    "signal:serial": "bun scripts/signal.ts --serial",
    "doctor": "bun scripts/doctor.ts",
    "doctor:fix": "bun scripts/doctor.ts --fix"
  }
}
```

**Existing signal scripts:** If the project has old signal scripts (e.g., `signal:serial`, `signal:parallel` using `concurrently`), replace them. The new `signal.ts` handles parallel execution natively.

Ensure these prerequisite scripts exist (they're used by signal.ts):

- `ts-check` — typically `tsc --noEmit`
- `lint-base` — typically `eslint --report-unused-disable-directives --max-warnings 0`
- `prettier:check` — typically `prettier --check .`

---

## Step 4: Create justin-sdk.json

Create `justin-sdk.json` at the project root to track which SDK version and components are in use:

```json
{
  "version": "0.1.0",
  "components": ["base-setup"],
  "lastSynced": "YYYY-MM-DD"
}
```

Set `lastSynced` to today's date. Add component names as you apply additional setup prompts (e.g., `"beads-setup"`).

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
git add scripts/signal.ts scripts/doctor.ts scripts/setup-env.ts package.json justin-sdk.json .claude/settings.json
git commit -m 'Add base tooling via justin-sdk'
```

---

## What's scripted vs what needs an agent

**Scripted (deterministic):**

- Installing the SDK package
- Copying template scripts
- Adding package.json entries
- Creating justin-sdk.json

**Agent (judgment needed):**

- Adapting signal.ts checks for project-specific tools
- Merging into existing .claude/settings.json (hooks, permissions)
- Deciding which doctor checks to include based on what's already set up
- Adapting setup-env.ts if the project has unusual requirements

---

## Migration: from copied check-runner to SDK package

If the project already has a locally copied `scripts/check-runner.ts` from a previous version of base-setup:

1. Install the SDK package: `bun add github:justinhaaheim/justin-sdk#0.1.0`
2. Update imports in `scripts/signal.ts` and `scripts/doctor.ts`:
   ```typescript
   // Before:
   import type {Check} from './check-runner';
   import {runChecks} from './check-runner';

   // After:
   import type {Check} from '@justinhaaheim/justin-sdk/check-runner';
   import {runChecks} from '@justinhaaheim/justin-sdk/check-runner';
   ```
3. Delete `scripts/check-runner.ts` — it's now provided by the package
4. Create `justin-sdk.json` at the project root
5. Run `bun run signal` to verify everything still works

---

## Adding checks from other setup prompts

When a subsequent setup prompt (like `beads-setup.md`) is applied, it adds its own checks to `doctor.ts`. The pattern:

1. Add check functions (e.g., `checkBeadsRust`, `checkBeadsDb`)
2. Add them to the `checks` array
3. Import any new helpers needed

Doctor grows additively as tools are added. Each setup prompt documents exactly which checks it adds.
