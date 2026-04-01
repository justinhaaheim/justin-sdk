# Beads Setup — beads_rust (br)

This document describes how to install and configure **beads_rust** (`br`) in a project. It is written for Claude Code as the primary executor, but is human-readable too.

**What is beads_rust?** A Rust-based, SQLite-backed issue tracker that lives in your git repo. It uses a hybrid SQLite + JSONL architecture: SQLite for fast local queries, JSONL for git-friendly diffs. The CLI command is `br`.

**Repository:** https://github.com/Dicklesworthstone/beads_rust

**Depends on:** `base-setup.md` — the base tooling (check-runner, signal, doctor, setup-env) must be in place first. If `scripts/check-runner.ts` doesn't exist in the project, apply `base-setup.md` before continuing.

---

## Prerequisites

### mise (tool version manager)

beads_rust is installed via [mise](https://mise.jdx.dev/), a polyglot tool version manager.

**Check if mise is installed:**

```bash
mise --version
```

**If not installed (local development):**

```bash
brew install mise
```

> **Preference:** Justin prefers Homebrew for local CLI tool installation (portable via `brew bundle` to new machines). The curl script is reserved for CI/remote environments where Homebrew isn't available.

Then add shims to PATH permanently (add to `~/.zshrc` or `~/.bashrc`):

```bash
# Add this line to your shell profile:
export PATH="$HOME/.local/share/mise/shims:$PATH"
```

**If not installed (CI / Claude Code remote):**

The `setup-env.ts` script handles this automatically via `curl -fsSL https://mise.run | sh`.

---

## Step 1: Install beads_rust via mise

### 1a. Create or update `mise.toml`

If `mise.toml` does not exist at the project root, create it. If it already exists, add the beads_rust entry to the `[tools]` section.

```toml
[tools]
"github:Dicklesworthstone/beads_rust" = { version = "0.1.34", exe = "br" }
```

> **Note:** Use the `github:` backend, which installs from GitHub releases. The `exe = "br"` tells mise which binary in the archive to expose. The `ubi:` backend is deprecated.

> **Version pinning:** The version above is current as of 2026-03-28. To check for newer releases: `gh api repos/Dicklesworthstone/beads_rust/releases/latest --jq '.tag_name'`

### 1b. Install the tool

```bash
mise install
```

### 1c. Verify installation

```bash
br --version
```

Expected output should show the installed version (e.g., `br 0.1.34` or similar).

**If `br` is not found:** You may need to ensure mise shims are on your PATH. Either:

- Restart your shell (if you just added the shims PATH line)
- Run `mise x -- br --version` to verify it works through mise exec
- In Claude Code, the `setup-env.ts` script handles PATH via `CLAUDE_ENV_FILE`

---

## Step 2: Handle Existing Beads Data (Migration)

**Check if there is an existing `.beads/` directory in the project.**

### If `.beads/` does NOT exist → Skip to Step 3.

### If `.beads/` exists → Determine the backend and migrate.

#### 2a. Back up existing data

**This step is mandatory.** Always back up before touching existing beads data. Put the backup in `./tmp/` (gitignored).

```bash
mkdir -p tmp
cp -rf .beads "tmp/beads-backup-$(date +%Y%m%d-%H%M%S)"
```

Verify the backup exists and contains the same files as `.beads/`.

#### 2b. Determine the current backend

Read `.beads/metadata.json`:

- If it contains `"database": "dolt"` or `"backend": "dolt"` → **Dolt backend** (old `bd`)
- If it contains `"database": "beads.db"` → **SQLite backend** (may already be beads_rust compatible)
- If the file doesn't exist → treat as uninitialized

#### 2c. Export existing issues

**For Dolt backend (`bd`):**

```bash
# List all issues in JSON format for preservation
bd list --json > tmp/beads-export-issues.json 2>/dev/null || true
```

If `bd` is not available or the Dolt server won't start, check if `.beads/issues.jsonl` or `.beads/backup/issues.jsonl` exists — it may have been previously exported.

**For SQLite backend:**

Check if `.beads/issues.jsonl` exists. If so, it contains the exported issues and can be imported into the new beads_rust installation.

#### 2d. Remove old beads data (keep backup)

**Confirm with the user before proceeding.** The backup from step 2a preserves all data.

```bash
rm -rf .beads
```

---

## Step 3: Initialize beads_rust

### 3a. Initialize the workspace

**Important:** `br init` does not support a `--dir` flag. You must run it from the project directory:

```bash
cd /path/to/project && br init --prefix <project-name>
```

This creates:

- `.beads/beads.db` — SQLite database
- `.beads/issues.jsonl` — JSONL export file
- `.beads/config.yaml` — Configuration

### 3b. Configure auto-sync

Update `.beads/config.yaml` to enable automatic JSONL sync:

```yaml
# Beads Project Configuration
issue_prefix: <project-name>
default_priority: 2
default_type: task

# Sync behavior
sync:
  auto_import: true
  auto_flush: true
```

### 3c. Import existing issues (if migrating)

If you exported issues in Step 2:

**From JSONL (most common):**

If you have a `tmp/beads-backup-*/issues.jsonl` or `tmp/beads-backup-*/backup/issues.jsonl` file with content:

```bash
cp -f tmp/beads-backup-*/backup/issues.jsonl .beads/issues.jsonl
br sync --import-only
```

Verify the import:

```bash
br list
```

All previously tracked issues should appear. If some are missing, flag this to the user — the JSONL format may have changed between beads versions.

> **Tested (2026-03-29):** Old `bd` SQLite-backend JSONL imports cleanly into `br` without any format conversion needed. The `br sync --import-only` command handles the field differences automatically. This was verified during the playground-rn migration (8 issues, with dependencies, all imported successfully).

**From JSON export (`bd list --json`):**

This format is different from JSONL and may require manual conversion. Flag to the user if this is the only data source available — manual review may be needed.

### 3d. Generate AGENTS.md

```bash
br agents --add --force
```

This creates or updates `AGENTS.md` at the project root with beads_rust agent instructions. Use whatever `br` generates — it's the canonical reference for the current version of beads_rust.

**Important:** If the project had an old `bd`-based AGENTS.md, `br agents --add` may append rather than replace. Review the result and remove any duplicate or stale `bd` sections.

**After generating AGENTS.md**, add this dependency direction section **above** the `<!-- br-agent-instructions-v1 -->` marker (so it won't be overwritten by future `br agents --update`):

```markdown
## Dependency Direction (IMPORTANT)

`br dep add <issue> <depends-on>` means `<issue>` is **blocked by** `<depends-on>`.

- **Epic/sub-bead pattern**: The **epic depends on its sub-beads**, NOT the other way around. The epic is blocked until its sub-beads are done.
  - Correct: `br dep add EPIC SUB_BEAD` (epic is blocked by sub-bead)
  - WRONG: `br dep add SUB_BEAD EPIC` (this would mean the sub-bead can't start until the epic is done, which is backwards)
- **Sequential tasks**: If task B can't start until task A is done: `br dep add B A`
- Think of it as: **"Who is waiting?"** The _waiter_ is the first argument.
```

This is critical because LLMs frequently get the dependency direction backwards, especially for epic/sub-bead relationships.

---

## Step 4: CLAUDE.md Integration

The project's `CLAUDE.md` **must** reference `AGENTS.md` so Claude Code follows the beads workflow.

### 4a. Ensure `@AGENTS.md` reference

Check if `CLAUDE.md` already contains a reference to `AGENTS.md`. Look for any of:

- `@AGENTS.md`
- A section mentioning beads/issue tracking that links to AGENTS.md

**If no reference exists**, add a section like this to the appropriate location in `CLAUDE.md`:

```markdown
## Issue Tracking

This project uses **beads_rust** (`br`) for issue tracking. See `@AGENTS.md` for the full command reference.

**ALWAYS use beads for ALL work.** Every task — even trivial ones — should have a bead. This is non-negotiable. Beads provide accountability, trackability, visibility, and an audit trail. Specifically:

- **Before starting any work**, check `br ready` for existing beads, or create one.
- **For non-trivial tasks**, create an epic bead, break it into sub-beads, then implement. Close sub-beads as you go.
- **For quick tasks**, create a single bead, do the work, close it.
- **At session end**, ensure all completed work has closed beads, and any unfinished work has open beads with context for the next session.
- **Do NOT use markdown TODOs, task lists, or other tracking methods.** Beads is the single source of truth for task tracking.
```

### 4b. Remove stale `bd` references

If `CLAUDE.md` references `bd` (the old Dolt-based beads), update those references to `br`. Be careful to preserve any project-specific context or workflow notes — just change the tool name and remove Dolt-specific instructions (like `bd dolt push`).

---

## Step 5: Claude Code Settings

Update `.claude/settings.json` to support beads_rust.

### 5a. Sandbox exclusion

Add `br` to the sandbox excluded commands so it can access the SQLite database:

```json
{
  "sandbox": {
    "excludedCommands": ["br"]
  }
}
```

If `bd` is currently listed, you can remove it (unless the project still uses `bd` for other purposes).

### 5b. SessionStart hook

The SessionStart hook should already exist from `base-setup.md`. If not, add one that runs `setup-env.ts`. See `base-setup.md` Step 4 for details.

---

## Step 6: Add doctor checks for beads

Add these check functions to the project's `scripts/doctor.ts`:

```typescript
function checkMise(): CheckResult {
  const {stdout, exitCode} = exec('mise --version');
  if (exitCode !== 0) {
    return {
      pass: false,
      message: 'mise is not installed',
      fix: 'Run: brew install mise',
      fixCommand: 'brew install mise',
    };
  }
  return {pass: true, message: `mise ${stdout}`};
}

function checkMiseToml(): CheckResult {
  if (!existsSync(resolve(PROJECT_ROOT, 'mise.toml'))) {
    return {
      pass: false,
      message: 'No mise.toml found at project root',
      fix: 'See src/justin-sdk/beads-setup.md',
    };
  }
  return {pass: true};
}

function checkBeadsRust(): CheckResult {
  const {stdout, exitCode} = exec('br --version');
  if (exitCode !== 0) {
    return {
      pass: false,
      message: 'br (beads_rust) is not installed or not on PATH',
      fix: 'Run: mise install',
      fixCommand: 'mise install',
    };
  }
  // Optionally compare version against mise.toml here
  return {pass: true, message: stdout};
}

function checkBeadsDb(): CheckResult {
  if (!existsSync(resolve(PROJECT_ROOT, '.beads/beads.db'))) {
    return {
      pass: false,
      message: '.beads/beads.db not found',
      fix: 'Run: br init',
      fixCommand: 'br init',
    };
  }
  const {exitCode} = exec('br list --json');
  if (exitCode !== 0) {
    return {
      pass: false,
      message: 'br list failed — database may be corrupt',
      fix: 'Run: br doctor --fix',
      fixCommand: 'br doctor --fix',
    };
  }
  return {pass: true};
}

function checkAgentsMd(): CheckResult {
  const agentsMd = resolve(PROJECT_ROOT, 'AGENTS.md');
  if (!existsSync(agentsMd)) {
    return {
      pass: false,
      message: 'AGENTS.md not found',
      fix: 'Run: br agents --add --force',
      fixCommand: 'br agents --add --force',
    };
  }
  // Verify it references br, not just old bd
  const content = readFileSync(agentsMd, 'utf-8');
  if (!content.includes('br ') && !content.includes('beads_rust')) {
    return {
      pass: false,
      message:
        'AGENTS.md exists but does not reference br/beads_rust — may be outdated',
      fix: 'Run: br agents --add --force',
      fixCommand: 'br agents --add --force',
    };
  }
  return {pass: true};
}

function checkClaudeMdRef(): CheckResult {
  const claudeMd = resolve(PROJECT_ROOT, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    return {pass: false, message: 'No CLAUDE.md found'};
  }
  const content = readFileSync(claudeMd, 'utf-8');
  if (!content.includes('AGENTS.md')) {
    return {
      pass: false,
      message: 'CLAUDE.md does not reference @AGENTS.md',
      fix: 'Add an @AGENTS.md reference to CLAUDE.md',
    };
  }
  return {pass: true};
}

function checkPrettierIgnoreBeads(): CheckResult {
  const prettierIgnore = resolve(PROJECT_ROOT, '.prettierignore');
  if (!existsSync(prettierIgnore)) {
    return {pass: false, message: '.prettierignore not found'};
  }
  const content = readFileSync(prettierIgnore, 'utf-8');
  if (!content.includes('.beads')) {
    return {
      pass: false,
      message: '.prettierignore does not include .beads',
      fix: 'Add .beads to .prettierignore',
    };
  }
  return {pass: true};
}
```

Add them to the checks array:

```typescript
const checks: Check[] = [
  // ... existing base checks ...
  {label: 'MISE', fn: checkMise},
  {label: 'MISE_TOML', fn: checkMiseToml},
  {label: 'BR', fn: checkBeadsRust},
  {label: 'BR_DB', fn: checkBeadsDb},
  {label: 'AGENTS_MD', fn: checkAgentsMd},
  {label: 'CLAUDE_MD', fn: checkClaudeMdRef, severity: 'warn'},
  {label: 'PRETTIER_IGNORE_BEADS', fn: checkPrettierIgnoreBeads},
];
```

---

## Step 7: Prettier Ignore

Add `.beads` to the project's `.prettierignore` so Prettier doesn't warn about beads data files:

```
# Beads issue tracker data
.beads
```

If `.prettierignore` doesn't exist, create it with this entry. If it does exist, append it.

---

## Step 8: Git Housekeeping

### 8a. Update `.gitignore`

Ensure `.beads/` runtime files are not tracked. beads_rust's `br init` should handle this, but verify that `.beads/.gitignore` exists and covers:

```
*.db-wal
*.db-shm
*.pid
*.port
*.lock
*.log
```

**Note:** `br init` creates a `.beads/.gitignore` that gitignores `*.db`, `*.db-wal`, `*.db-shm`, and other runtime files. Only `config.yaml`, `issues.jsonl`, `metadata.json`, and `.gitignore` are committed. The JSONL is the git-friendly source of truth; the db is rebuilt from it via `br sync --import-only`.

### 8b. Commit the setup

Stage and commit all beads-related files:

```bash
git add mise.toml .beads/ AGENTS.md .claude/settings.json scripts/doctor.ts .prettierignore
git commit -m 'Add beads_rust (br) issue tracking via mise'
```

---

## Step 9: Verification

Run doctor to verify everything is in place:

```bash
bun run doctor
```

All beads-related checks (MISE, MISE_TOML, BR, BR_DB, AGENTS_MD) should pass. If any fail, the doctor output includes fix instructions.

---

## Appendix: Troubleshooting

**`br: command not found`**

- Check `mise install` was run
- Check mise shims are on PATH: `echo $PATH | tr ':' '\n' | grep mise`
- Try `mise x -- br --version` to bypass PATH issues

**`mise: command not found`**

- Local: `brew install mise`
- Remote/CI: `curl -fsSL https://mise.run | sh`

**SQLite errors / corrupt database**

- If `.beads/beads.db` is corrupt, check if `.beads/issues.jsonl` has data
- Re-initialize: `rm -f .beads/beads.db && br init && br sync --import-only`
- Check `tmp/` for the backup from Step 2

**Old `bd` commands in AGENTS.md or CLAUDE.md**

- Run `br agents --add --force` to regenerate AGENTS.md
- Manually update CLAUDE.md references from `bd` to `br`

**JSONL format mismatch during migration**

- Old `bd` JSONL has ~50 fields with integer booleans (0/1)
- `br` JSONL has ~12 fields with proper booleans
- As of 2026-03-29, `br sync --import-only` handles old `bd` JSONL automatically without conversion
- If issues still don't import, a Python/TS conversion script may be needed

---

## Appendix: Git Worktree Handling

If the project has git worktrees, each worktree needs its own beads_rust setup because `br` stores data in `.beads/` relative to the working directory.

### Steps for each worktree

1. The `mise.toml` lives on each branch, so each worktree will have its own copy. Copy or create `mise.toml` in the worktree.
2. Trust and install: `mise trust /path/to/worktree/mise.toml && mise install -C /path/to/worktree`
3. Remove old `.beads/` (back up first): `rm -rf /path/to/worktree/.beads`
4. Init from the worktree directory: `cd /path/to/worktree && br init --prefix <project-name>`
5. Import issues: copy the exported `issues.jsonl` to `.beads/issues.jsonl`, then `br sync --import-only`
6. Generate AGENTS.md: `br agents --add --force`
7. Apply the same CLAUDE.md, `.prettierignore`, `.claude/settings.json`, and `scripts/` changes as the main worktree

### Cleanup: Old `bd` sync branch/worktree

Old `bd` used a `beads-sync` git branch + internal worktree (at `.git/beads-worktrees/beads-sync`) to sync issues across worktrees. Since `br` doesn't use this mechanism, clean it up:

```bash
# Remove the beads-sync worktree
git worktree remove --force .git/beads-worktrees/beads-sync

# Delete the beads-sync branch
git branch -D beads-sync
```
