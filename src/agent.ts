/**
 * agent.ts — prints a self-contained playbook for AI coding agents.
 *
 * Usage: bunx justin-sdk agent
 *
 * This is the "cold-start prompt" for any agent entering a project. It
 * explains what justin-sdk is, what it can do, how to figure out what
 * the user wants, and the exact commands to run for common tasks.
 *
 * Designed to be self-contained: an agent with zero other context
 * should be able to read this and complete the task successfully.
 *
 * Keep this in sync with the rest of the SDK. When you add a new
 * command, gotcha, or best practice, update this file.
 */

import {readFileSync, existsSync} from 'fs';
import {resolve} from 'path';

function getPinnedVersions(): Record<string, string> {
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) return {};
  try {
    return JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function getSdkVersion(): string {
  const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
  if (!existsSync(pkgPath)) return 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function runAgent(): void {
  const sdkVersion = getSdkVersion();
  const versions = getPinnedVersions();
  const versionsTable = Object.entries(versions)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const playbook = `
# justin-sdk Agent Playbook

**justin-sdk version:** ${sdkVersion}

You are an AI coding agent running in a Justin Haaheim project. The user
invoked you and asked you to do something related to justin-sdk — probably
set up beads issue tracking, migrate from an older tool, or run health
checks on the project.

This document is your complete context. Read the whole thing before acting.
Everything you need to know is here.

---

## Who is Justin?

Justin is a senior software engineer with deep expertise in React and
TypeScript. He has ~15 concurrent side projects and uses a cross-project
SDK (this tool) to keep them consistent. He has ADHD, which means:

- **Context-switching is expensive** — don't ask questions that the tools
  can answer. Just run doctor/signal/etc and report what you find.
- **He wants commits proactively** — every unit of work should be committed
  before you yield back to him. Never leave uncommitted changes in the
  working directory unless he explicitly tells you to.
- **He prefers terse responses** — lead with the action or result, not
  the reasoning. If something worked, say so in one sentence.
- **He values automation** — if you're about to do something manually
  that could be scripted, flag it so the script can improve next time.

---

## What is justin-sdk?

A CLI tool and module library that provides:

- **\`doctor\`** — environment health checks with auto-fix mode
- **\`signal\`** — run project code quality checks (lint/ts/prettier)
- **\`add <component>\`** — install a component (\`base-setup\` or \`beads\`)
- **\`agent\`** — print this playbook (the command you probably just ran)

It also exports an importable \`check-runner\` module that projects can
use to define their own check trees.

justin-sdk is a **source of truth for versions and workflows across
projects**. Central pins live in \`versions.json\` in the SDK repo — this
is how all of Justin's projects stay on the same beads_rust version, etc.

**Repo:** https://github.com/justinhaaheim/justin-sdk
**Run from GitHub (no install needed):**
\`\`\`bash
bunx github:justinhaaheim/justin-sdk#main <command>
\`\`\`

### Currently pinned versions

${versionsTable === '' ? '(versions.json not readable)' : versionsTable}

---

## Prerequisites

- **git** — project must be a git repo
- **bun** — required to run the SDK itself. If missing, install with:
  - macOS: \`brew install bun\`
  - Other: \`npm i -g bun\` or \`curl -fsSL https://bun.sh/install | bash\`
- **macOS or Linux**

If bun is missing, you can't run \`bunx justin-sdk\` at all — install bun
first, then retry.

---

## Available components

Currently, \`add\` supports two components:

- **\`base-setup\`** — the foundation layer every justin-sdk project
  needs. Creates \`justin-sdk.config.json\`, adds package.json scripts
  (signal/doctor/setup-env), copies \`scripts/setup-env.ts\`, adds
  \`tmp/\` to .gitignore, and scaffolds \`.claude/settings.json\` with
  a SessionStart hook. Idempotent and safe to re-run.
- **\`beads\`** — installs beads_rust (\`br\`) issue tracking. Runs
  base-setup automatically as a precondition if not already installed.

Future components (not yet implemented): eslint, prettier, tsconfig,
version-manager, prompts.

## Figure out what the user wants

The user probably said something like:
- "Set up this project with justin-sdk" → run \`add base-setup\`
  first, then \`add beads\` (or just \`add beads\` — it runs base-setup
  automatically as a precondition)
- "Add beads to this project" → \`add beads\` (see next section)
- "Migrate from bd to beads_rust" → also \`add beads\` (handles migration)
- "Check the environment" → \`bunx justin-sdk doctor\`
- "Run signal" → \`bunx justin-sdk signal\`
- "Update the beads version" → update \`versions.json\` in the SDK,
  bump the project's local mise.toml to match, run \`mise install\`

**If their request is unclear, run \`bunx justin-sdk doctor\` first** to
see the current state, then decide based on what's missing.

---

## Secondary workflow: \`add base-setup\`

Installs the foundation layer. You usually don't need to run this
directly — \`add beads\` runs it automatically as a precondition. But
if you want just the foundation (scripts, config, gitignore, hooks)
without beads, run:

\`\`\`bash
bunx github:justinhaaheim/justin-sdk#main add base-setup
\`\`\`

This is also the right command if a user says "set up this project
with justin-sdk but I don't want beads yet".

---

## Primary workflow: \`add beads\`

This is the most common task. It sets up **beads_rust** (\`br\`) for issue
tracking in a project, handling migration from older tools automatically.

### What it does (12 steps, fully automated)

0. **base-setup** — runs \`add base-setup\` first to ensure the foundation
   layer is present (justin-sdk.config.json, package.json scripts,
   scripts/setup-env.ts, .gitignore, .claude/settings.json). Idempotent.
1. **mise.toml** — creates or updates with the pinned beads_rust version
2. **install br** — via mise first, falls back to direct GitHub download
   if mise fails or is rate-limited
3. **migration check** — if \`.beads/\` already exists:
   - Backs it up to \`tmp/beads-backup-TIMESTAMP/\`
   - Detects old backends (Dolt / old bd)
   - Removes the old \`.beads/\` dir (backup preserved)
4. **\`br init --prefix <dirname>\`** — initializes beads_rust workspace
5. **import issues** — if the backup had a JSONL, imports via
   \`br sync --import-only --orphans allow --force\`. This is important:
   the default \`--orphans strict\` mode silently drops issues with
   unresolvable dependency references. \`allow\` mode imports everything.
6. **AGENTS.md** — auto-detects stale bd content (END BEADS INTEGRATION
   marker, \`**bd** (beads)\` phrase, \`bd onboard\` command) and backs it
   up to \`tmp/AGENTS.md.bd-backup-TIMESTAMP\` before regenerating with
   \`br agents --add --force\`. Also adds a "Dependency Direction" section
   below the marker.
7. **CLAUDE.md** — creates \`docs/prompts/BEADS.md\` (standard workflow
   doc) and appends \`@docs/prompts/BEADS.md\` reference to CLAUDE.md.
   This is the @docs/prompts pattern — setup commands don't edit CLAUDE.md
   directly, they create a standalone prompt file and append a one-line
   reference. Idempotent.
8. **.prettierignore** — appends \`.beads\` if not already present
9. **.claude/settings.json** — adds \`br\` to \`sandbox.excludedCommands\`
10. **justin-sdk.config.json** — adds \`beads-setup\` to \`components\`
11. **git commit** — stages all beads-related files and commits

### Running it

From the target project directory:

\`\`\`bash
bunx github:justinhaaheim/justin-sdk#main add beads
\`\`\`

Or if the SDK is already installed as a dep:

\`\`\`bash
bun x justin-sdk add beads
# or
bunx justin-sdk add beads
\`\`\`

**Flags:**
- \`--no-commit\` — skip the final git commit (you commit manually)

### What to check after

1. Read the script output carefully. It reports each step as ✓ (done),
   ⚠ (warning), or ✗ (error). Warnings are OK; errors mean something
   needs your attention.
2. Run \`git status\` to see what was committed and what wasn't.
3. Run \`bunx justin-sdk doctor\` to verify the installation.
4. Run \`br list --all\` to see issues. If migrating, confirm the count
   matches the original (the script warns if there's a mismatch).

---

## Migration from bd (legacy beads) → beads_rust

If the project has an existing \`.beads/\` directory with old bd state,
\`add beads\` handles it automatically. The key things that happen:

1. **Backend detection** — reads \`.beads/metadata.json\` to identify
   if it's Dolt or SQLite backend
2. **Full backup** — \`.beads/\` is copied to \`tmp/beads-backup-TIMESTAMP/\`
   before anything is touched
3. **JSONL export discovery** — looks for \`issues.jsonl\` in the backup
   (at the root or under \`backup/\`) — this is the import source
4. **Re-init** — removes old \`.beads/\` and runs \`br init\`
5. **Import** — copies the JSONL and runs \`br sync --import-only
   --orphans allow --force\`. The \`--orphans allow\` flag is crucial:
   bd's JSONL often has dangling dependency references that br's default
   \`strict\` mode rejects, silently dropping those issues.
6. **Verification** — script counts source vs imported, warns on
   discrepancy. You should double-check with \`br list --all --json | jq
   '.issues | length'\` — note the \`--all\`; \`br list\` without \`--all\`
   excludes closed issues.

### After migration, check for stale bd references in other files

The script auto-cleans AGENTS.md. It does NOT clean other files. Search
the project for stale references:

\`\`\`bash
grep -rn 'bd ' --include='*.md' --include='*.json' .
\`\`\`

Common places to find them:
- CLAUDE.md (hopefully no references beyond what the script added)
- docs/ (manual prompts, READMEs)
- .claude/settings.json (if bd was in sandbox.excludedCommands — script
  adds br but doesn't remove bd; safe to leave or clean up)
- scripts/ (any script that calls bd directly — needs to be updated)
- package.json scripts (rare, but possible)

Replace bd references with br equivalents where it makes sense. Most
\`bd\` commands have a matching \`br\` command with the same name.

### If the import count doesn't match

If the script reports "Imported N issues, but source had M", something
went wrong. Options:

1. **Re-run the import with verbose logging:**
   \`\`\`bash
   cp tmp/beads-backup-*/issues.jsonl .beads/issues.jsonl
   br sync --import-only --orphans allow --force -v
   \`\`\`
2. **Check the JSONL itself** — \`wc -l tmp/beads-backup-*/issues.jsonl\`
   and inspect for malformed entries
3. **Try \`--orphans skip\`** as a fallback — drops the bad ones but
   keeps everything else
4. **Manual re-import** — the backup is always preserved in \`tmp/\`

If you can't resolve it after 2-3 tries, **report the issue back to
the user with a clear summary** of what you tried and what the counts
were. Don't silently accept data loss.

---

## Doctor: environment health checks

\`\`\`bash
bunx justin-sdk doctor              # Just report status
bunx justin-sdk doctor --fix        # Auto-run project-local fixes
bunx justin-sdk doctor --fix --yes  # Also run system-level installs (mise, br, bun)
bunx justin-sdk doctor --quiet      # Summary only, one line on all-pass
\`\`\`

**Approval gating:** Checks whose fix modifies system state (installing
mise, bun, br via brew/npm/curl) are marked \`requiresApproval: true\`.
\`--fix\` alone will skip them and report what was skipped. \`--fix --yes\`
runs them automatically.

**Use \`--yes\` in automated/sandbox environments** (Docker, Claude Code
remote, CI). Don't use \`--yes\` on Justin's local Mac — he prefers
explicit approvals for installs.

**Exit codes:**
- 0 = all pass (or only warnings)
- 1 = at least one error

**Warning vs error:**
- **Error** — blocks children in the check tree; fails the run
- **Warning** — children still run; exit code stays 0

Example: BR version mismatch is a warning, not an error. mise missing
is a warning too (BR check has a curl fallback).

---

## Signal: project code quality checks

\`\`\`bash
bunx justin-sdk signal              # Parallel, verbose
bunx justin-sdk signal --quiet      # One-liner on all-pass
bunx justin-sdk signal --serial     # Run sequentially (easier debugging)
\`\`\`

Signal runs \`signal-source:*\` scripts from package.json. Typically:
- \`signal-source:TS\` — \`tsc --noEmit\`
- \`signal-source:LINT\` — \`eslint\`
- \`signal-source:PRETTIER\` — \`prettier --check\`

Projects can add more. Signal runs them all in parallel (or serial
with \`--serial\`) and reports a combined pass/fail summary.

---

## Common gotchas

### 1. beads DB out of sync with issues.jsonl

After \`br close\`, \`br update\`, or any mutation, the SQLite DB and the
JSONL file are supposed to stay in sync. They sometimes drift. Symptoms:
- \`br list\` shows fewer issues than \`issues.jsonl\` has lines
- Issues you created earlier in the session aren't showing up

**Fix:**
\`\`\`bash
br sync --import-only --force
\`\`\`

### 2. Shell cwd drift

If you \`cd\` in a shell command (especially in a background task), later
commands in the same session may run from unexpected directories. **Use
absolute paths** in bash tool calls, or run from a known cwd and verify
with \`pwd\` if unsure.

### 3. \`br list\` excludes closed issues by default

\`br list\` shows only open issues. Use \`br list --all\` to see everything.
This trips up migration verification — you run \`br list | wc -l\`, see
6 issues, assume the import dropped 14, when actually 14 are just closed.

### 4. \`br agents --add\` APPENDS, doesn't replace

When you run \`br agents --add --force\` on an existing AGENTS.md, it
appends its content instead of replacing. The \`add beads\` script
auto-detects stale bd content and replaces the file first, but if you
call \`br agents\` directly, be aware.

### 5. mise rate-limited by GitHub

mise's \`github:\` backend hits GitHub API rate limits in CI/remote
environments. The BR doctor check has a built-in curl fallback. No
action needed — the script handles it.

### 6. \`br sync --import-only --orphans strict\` silently drops issues

The default. During migration from bd, issues with dangling dependency
references get rejected without a clear warning. Always use
\`--orphans allow\` for migrations. The \`add beads\` script does this
automatically.

### 7. Husky/lint-staged pre-commit hook fails on submodule-only commits

If a commit touches only a submodule pointer (no staged files in the
parent repo), lint-staged can't stash and fails. Use \`--no-verify\`
for those specific commits.

### 8. Bun workspaces vs \`file:\` dependencies

If justin-sdk is installed as \`file:./path/to/sdk\`, bun copies the files
into node_modules and your edits don't propagate. Use a bun workspace
(\`"workspaces": ["projects/justin-sdk"]\`) to get a real symlink.

---

## Committing

Justin wants **everything committed proactively**. Never leave uncommitted
changes in the working directory when you yield back to him.

### Commit rules

- \`git add\` and \`git commit\` as separate commands (not \`git commit -a\`)
- **Single quotes** for commit messages: \`git commit -m '...'\`
- Commit message should start with \`[<model name>]\`, e.g. \`[Claude Opus 4.6]\`
- One logical change per commit. Refactors, feature additions, and
  bug fixes get their own commits.
- If the pre-commit hook fails for unrelated reasons (e.g. a lint
  regression in a sibling package), use \`--no-verify\` and create a
  follow-up bead to track the real issue.

### What to commit after \`add beads\`

The script commits automatically. But if you passed \`--no-commit\` or
had to fix something manually:

\`\`\`bash
git add mise.toml .beads/ AGENTS.md CLAUDE.md docs/prompts/BEADS.md \\
        .prettierignore .claude/settings.json justin-sdk.config.json
git commit -m '[Claude Opus 4.6] Add beads_rust via justin-sdk add beads'
\`\`\`

Pay attention to \`tmp/\` — it should be in \`.gitignore\`. The migration
backups live there and should NOT be committed.

---

## Error handling / when things go wrong

### Principles

1. **Never silently accept data loss.** If the script warns about a
   discrepancy (fewer issues imported than source), investigate before
   committing.
2. **Don't delete backups.** The \`tmp/\` directory contains pre-migration
   snapshots. Leave them there — Justin can clean them up when he's
   confident.
3. **Diagnose before retrying.** If a command fails, read the error
   message. Don't just retry the same thing hoping it works this time.
4. **Ask the user when stuck.** If you've tried 2-3 reasonable
   approaches and can't resolve an issue, summarize what you tried
   and what you observed, and ask.

### Common failures and fixes

- **\`br: command not found\`** → mise shims not on PATH. Either restart
  the shell or use the full path at \`~/.local/share/mise/shims/br\`.
- **\`mise install\` fails** → the BR check falls back to a direct curl
  install automatically. If running manually:
  \`\`\`bash
  curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version v<VERSION> --quiet --skip-skills
  \`\`\`
- **\`br sync\` says "JSONL is current"** → add \`--force\` to bypass the
  hash check and re-import
- **Old Dolt backend in \`.beads/\`** → \`add beads\` detects this and
  migrates. If running \`br\` commands directly fails, back up \`.beads/\`
  manually and re-run \`add beads\`.

---

## Links

- **SDK source:** https://github.com/justinhaaheim/justin-sdk
- **beads_rust:** https://github.com/Dicklesworthstone/beads_rust
- **home-base (meta project):** https://github.com/justinhaaheim/home-base
- **Command reference:** \`bunx justin-sdk --help\`
- **Current project state:** \`bunx justin-sdk doctor\`

---

## Final checklist before yielding back to the user

1. ✅ Ran the requested command(s)
2. ✅ Verified with \`doctor\` and/or \`git status\`
3. ✅ Committed all changes (unless explicitly told not to)
4. ✅ Pushed if the user said to push
5. ✅ Reported any warnings, skipped steps, or manual follow-ups clearly
6. ✅ No uncommitted work in the working directory

If all six are green, you're done. Report back with a brief summary
(1-3 sentences) of what you did. Justin values terseness.
`;

  console.log(playbook);
}
