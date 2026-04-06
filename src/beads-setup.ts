/**
 * beads-setup.ts — Deterministic beads_rust setup for any project.
 *
 * Orchestrates: mise.toml, br install, migration, br init, AGENTS.md,
 * CLAUDE.md (@docs/prompts/BEADS.md pattern), .prettierignore,
 * .claude/settings.json, and justin-sdk.json.
 *
 * Bails with a clear error on unexpected state rather than guessing.
 */

import {execSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  cpSync,
  rmSync,
} from 'fs';
import {resolve, basename} from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(
  cmd: string,
  cwd: string,
): {exitCode: number; stdout: string; stderr: string} {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout, stderr: ''};
  } catch (error) {
    const err = error as {status?: number; stdout?: string; stderr?: string};
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
    };
  }
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function success(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.warn(`  \x1b[33m⚠\x1b[0m ${msg}`);
}

function fail(msg: string): void {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/** Append a line to a file if it's not already present. */
function appendIfMissing(
  filePath: string,
  searchStr: string,
  appendStr: string,
): boolean {
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf-8');
    if (content.includes(searchStr)) return false;
    appendFileSync(filePath, appendStr);
  } else {
    writeFileSync(filePath, appendStr);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

function getPinnedVersion(): string {
  // versions.json lives alongside this source file in the SDK
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) {
    throw new Error(
      `versions.json not found at ${versionsPath}. Cannot determine pinned beads_rust version.`,
    );
  }
  const versions = JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
    string,
    string
  >;
  const version = versions.beads_rust;
  if (!version) {
    throw new Error('beads_rust version not found in versions.json');
  }
  return version;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

function stepMiseToml(projectRoot: string, version: string): boolean {
  const miseToml = resolve(projectRoot, 'mise.toml');
  const entry = `"github:Dicklesworthstone/beads_rust" = { version = "${version}", exe = "br" }`;

  if (!existsSync(miseToml)) {
    writeFileSync(miseToml, `[tools]\n${entry}\n`);
    success(`Created mise.toml with beads_rust ${version}`);
    return true;
  }

  const content = readFileSync(miseToml, 'utf-8');
  if (content.includes('beads_rust')) {
    // Check if version matches
    const match = /beads_rust.*?version\s*=\s*"([^"]+)"/.exec(content);
    if (match?.[1] === version) {
      success(`mise.toml already has beads_rust ${version}`);
      return true;
    }
    // Update version
    const updated = content.replace(
      /("github:Dicklesworthstone\/beads_rust"\s*=\s*\{[^}]*version\s*=\s*")[^"]+(")/,
      `$1${version}$2`,
    );
    writeFileSync(miseToml, updated);
    success(`Updated mise.toml beads_rust version to ${version}`);
    return true;
  }

  // Add to existing [tools] section
  if (content.includes('[tools]')) {
    const updated = content.replace('[tools]', `[tools]\n${entry}`);
    writeFileSync(miseToml, updated);
  } else {
    appendFileSync(miseToml, `\n[tools]\n${entry}\n`);
  }
  success(`Added beads_rust ${version} to mise.toml`);
  return true;
}

function stepInstallBr(projectRoot: string, version: string): boolean {
  // Check if br is already installed and correct version
  const {stdout, exitCode} = exec('br --version', projectRoot);
  if (exitCode === 0) {
    const installed = stdout.replace(/^br\s*/, '').trim();
    if (installed === version) {
      success(`br ${version} already installed`);
      return true;
    }
    log(`br ${installed} installed, want ${version} — upgrading...`);
  }

  // Try mise install first
  const miseResult = exec('mise install --yes', projectRoot);
  if (miseResult.exitCode === 0) {
    const check = exec('br --version', projectRoot);
    if (check.exitCode === 0) {
      success(`br installed via mise: ${check.stdout}`);
      return true;
    }
  }

  // Fallback to direct install
  log('mise install failed or br not on PATH — trying direct install...');
  const versionTag = version.startsWith('v') ? version : `v${version}`;
  const curlResult = exec(
    `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`,
    projectRoot,
  );
  if (curlResult.exitCode !== 0) {
    fail(`Failed to install br: ${curlResult.stderr}`);
    return false;
  }

  const verify = exec('br --version', projectRoot);
  if (verify.exitCode === 0) {
    success(`br installed via direct download: ${verify.stdout}`);
    return true;
  }

  // Check ~/.local/bin directly
  const home = process.env.HOME ?? '/root';
  const directBin = resolve(home, '.local/bin/br');
  if (existsSync(directBin)) {
    success(`br installed at ${directBin} (may need PATH update)`);
    return true;
  }

  fail('br could not be installed');
  return false;
}

function stepMigrateOldBeads(projectRoot: string): {
  hadOldData: boolean;
  jsonlPath: string | null;
  ok: boolean;
} {
  const beadsDir = resolve(projectRoot, '.beads');

  if (!existsSync(beadsDir)) {
    return {hadOldData: false, jsonlPath: null, ok: true};
  }

  const beadsDb = resolve(beadsDir, 'beads.db');
  if (existsSync(beadsDb)) {
    // Check if it's already a working beads_rust db
    const check = exec('br list --json', projectRoot);
    if (check.exitCode === 0) {
      success('beads_rust already initialized and working');
      return {hadOldData: false, jsonlPath: null, ok: true};
    }
  }

  // Back up existing data
  const tmpDir = resolve(projectRoot, 'tmp');
  ensureDir(tmpDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = resolve(tmpDir, `beads-backup-${timestamp}`);
  log(`Backing up .beads/ to ${backupDir}...`);
  cpSync(beadsDir, backupDir, {recursive: true});
  success(`Backup created at tmp/beads-backup-${timestamp}/`);

  // Find exportable JSONL
  let jsonlPath: string | null = null;
  const candidates = [
    resolve(backupDir, 'issues.jsonl'),
    resolve(backupDir, 'backup', 'issues.jsonl'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, 'utf-8').trim();
      if (content.length > 0) {
        jsonlPath = candidate;
        break;
      }
    }
  }

  if (jsonlPath) {
    success(`Found exportable issues at ${jsonlPath}`);
  } else {
    warn('No issues.jsonl found in backup — issues may be lost');
  }

  // Check for Dolt backend
  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const meta = readFileSync(metadataPath, 'utf-8');
      if (meta.includes('"dolt"')) {
        log('Detected old Dolt backend — removing for fresh init');
      }
    } catch {
      // proceed
    }
  }

  // Remove old .beads/ for fresh init
  rmSync(beadsDir, {recursive: true, force: true});
  success('Removed old .beads/ directory (backup preserved)');

  return {hadOldData: true, jsonlPath, ok: true};
}

function stepInitBeads(projectRoot: string): boolean {
  const beadsDb = resolve(projectRoot, '.beads', 'beads.db');
  if (existsSync(beadsDb)) {
    success('beads_rust already initialized');
    return true;
  }

  const prefix = basename(projectRoot);
  const result = exec(`br init --prefix ${prefix}`, projectRoot);
  if (result.exitCode !== 0) {
    fail(`br init failed: ${result.stderr}`);
    return false;
  }
  success(`Initialized beads_rust with prefix "${prefix}"`);

  // Configure auto-sync
  const configPath = resolve(projectRoot, '.beads', 'config.yaml');
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf-8');
    if (!config.includes('auto_import: true')) {
      const updatedConfig = `# Beads Project Configuration
issue_prefix: ${prefix}
default_priority: 2
default_type: task

# Sync behavior
sync:
  auto_import: true
  auto_flush: true
`;
      writeFileSync(configPath, updatedConfig);
      success('Configured auto-sync in config.yaml');
    }
  }

  return true;
}

function stepImportIssues(
  projectRoot: string,
  jsonlPath: string | null,
): boolean {
  if (!jsonlPath) return true;

  const targetJsonl = resolve(projectRoot, '.beads', 'issues.jsonl');
  log('Importing issues from backup...');

  // Copy JSONL into .beads/
  cpSync(jsonlPath, targetJsonl, {force: true});
  const result = exec('br sync --import-only', projectRoot);
  if (result.exitCode !== 0) {
    fail(`br sync --import-only failed: ${result.stderr}`);
    return false;
  }

  // Verify
  const verify = exec('br list --json', projectRoot);
  if (verify.exitCode === 0) {
    try {
      const data = JSON.parse(verify.stdout) as {issues?: unknown[]};
      const count = data.issues?.length ?? 0;
      success(`Imported ${count} issues`);
    } catch {
      success('Issues imported (could not parse count)');
    }
  } else {
    warn('br list failed after import — verify manually');
  }

  return true;
}

function stepAgentsMd(projectRoot: string): boolean {
  const result = exec('br agents --add --force', projectRoot);
  if (result.exitCode !== 0) {
    fail(`br agents --add --force failed: ${result.stderr}`);
    return false;
  }
  success('Generated AGENTS.md');

  // Add dependency direction docs if not already present
  const agentsMd = resolve(projectRoot, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, 'utf-8');
    if (!content.includes('Dependency Direction')) {
      const depSection = `
## Dependency Direction (IMPORTANT)

\`br dep add <issue> <depends-on>\` means \`<issue>\` is **blocked by** \`<depends-on>\`.

- **Epic/sub-bead pattern**: The **epic depends on its sub-beads**, NOT the other way around. The epic is blocked until its sub-beads are done.
  - Correct: \`br dep add EPIC SUB_BEAD\` (epic is blocked by sub-bead)
  - WRONG: \`br dep add SUB_BEAD EPIC\` (this would mean the sub-bead can't start until the epic is done, which is backwards)
- **Sequential tasks**: If task B can't start until task A is done: \`br dep add B A\`
- Think of it as: **"Who is waiting?"** The _waiter_ is the first argument.
`;
      // Insert before the br-agent-instructions marker if present, else append
      const marker = '<!-- br-agent-instructions-v1 -->';
      if (content.includes(marker)) {
        const updated = content.replace(marker, depSection + '\n' + marker);
        writeFileSync(agentsMd, updated);
      } else {
        appendFileSync(agentsMd, depSection);
      }
      success('Added dependency direction docs to AGENTS.md');
    }
  }

  return true;
}

const BEADS_PROMPT_CONTENT = `# Beads Issue Tracking

This project uses **beads_rust** (\`br\`) for issue tracking. See \`@AGENTS.md\` for the full command reference.

**ALWAYS use beads for ALL work.** Every task — even trivial ones — should have a bead. This is non-negotiable. Beads provide accountability, trackability, visibility, and an audit trail. Specifically:

- **Before starting any work**, check \`br ready\` for existing beads, or create one.
- **For non-trivial tasks**, create an epic bead, break it into sub-beads, then implement. Close sub-beads as you go.
- **For quick tasks**, create a single bead, do the work, close it.
- **At session end**, ensure all completed work has closed beads, and any unfinished work has open beads with context for the next session.
- **Do NOT use markdown TODOs, task lists, or other tracking methods.** Beads is the single source of truth for task tracking.
`;

function stepClaudeMd(projectRoot: string): boolean {
  // Create docs/prompts/BEADS.md
  const promptsDir = resolve(projectRoot, 'docs', 'prompts');
  ensureDir(promptsDir);
  const beadsPrompt = resolve(promptsDir, 'BEADS.md');
  writeFileSync(beadsPrompt, BEADS_PROMPT_CONTENT);
  success('Created docs/prompts/BEADS.md');

  // Append reference to CLAUDE.md
  const claudeMd = resolve(projectRoot, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    warn('No CLAUDE.md found — skipping reference append');
    return true;
  }

  const added = appendIfMissing(
    claudeMd,
    'BEADS.md',
    '\n@docs/prompts/BEADS.md\n',
  );
  if (added) {
    success('Appended @docs/prompts/BEADS.md reference to CLAUDE.md');
  } else {
    success('CLAUDE.md already references BEADS.md');
  }

  return true;
}

function stepPrettierIgnore(projectRoot: string): boolean {
  const prettierIgnore = resolve(projectRoot, '.prettierignore');
  const added = appendIfMissing(
    prettierIgnore,
    '.beads',
    '\n# Beads issue tracker data\n.beads\n',
  );
  if (added) {
    success('Added .beads to .prettierignore');
  } else {
    success('.prettierignore already includes .beads');
  }
  return true;
}

function stepClaudeSettings(projectRoot: string): boolean {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  ensureDir(resolve(projectRoot, '.claude'));

  const settings = readJson(settingsPath) ?? {};
  const sandbox = (settings.sandbox ?? {}) as Record<string, unknown>;
  const excluded = (sandbox.excludedCommands ?? []) as string[];

  if (excluded.includes('br')) {
    success('.claude/settings.json already excludes br from sandbox');
    return true;
  }

  excluded.push('br');
  sandbox.excludedCommands = excluded;
  settings.sandbox = sandbox;
  writeJson(settingsPath, settings);
  success('Added br to .claude/settings.json sandbox exclusions');
  return true;
}

function stepJustinSdkJson(projectRoot: string): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.json');
  const config = readJson(configPath);

  if (!config) {
    warn('No justin-sdk.json found — skipping component registration');
    return true;
  }

  const components = (config.components ?? []) as string[];
  if (components.includes('beads-setup')) {
    success('justin-sdk.json already includes beads-setup component');
    return true;
  }

  components.push('beads-setup');
  config.components = components;
  writeJson(configPath, config);
  success('Added beads-setup to justin-sdk.json components');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeadsSetupOptions {
  /** Skip git commit at the end */
  noCommit?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
}

export async function runBeadsSetup(
  options: BeadsSetupOptions = {},
): Promise<number> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const version = getPinnedVersion();

  console.log(
    `\n\x1b[1mSetting up beads_rust ${version} in ${basename(projectRoot)}\x1b[0m\n`,
  );

  // Step 1: mise.toml
  console.log('\x1b[1m1. mise.toml\x1b[0m');
  if (!stepMiseToml(projectRoot, version)) return 1;

  // Step 2: Install br
  console.log('\x1b[1m2. Install br\x1b[0m');
  if (!stepInstallBr(projectRoot, version)) return 1;

  // Step 3: Handle existing .beads/ data
  console.log('\x1b[1m3. Migration check\x1b[0m');
  const migration = stepMigrateOldBeads(projectRoot);
  if (!migration.ok) return 1;

  // Step 4: Initialize beads_rust
  console.log('\x1b[1m4. Initialize beads_rust\x1b[0m');
  if (!stepInitBeads(projectRoot)) return 1;

  // Step 5: Import old issues
  if (migration.hadOldData) {
    console.log('\x1b[1m5. Import issues\x1b[0m');
    if (!stepImportIssues(projectRoot, migration.jsonlPath)) return 1;
  }

  // Step 6: AGENTS.md
  console.log('\x1b[1m6. AGENTS.md\x1b[0m');
  if (!stepAgentsMd(projectRoot)) return 1;

  // Step 7: CLAUDE.md
  console.log('\x1b[1m7. CLAUDE.md\x1b[0m');
  if (!stepClaudeMd(projectRoot)) return 1;

  // Step 8: .prettierignore
  console.log('\x1b[1m8. .prettierignore\x1b[0m');
  if (!stepPrettierIgnore(projectRoot)) return 1;

  // Step 9: .claude/settings.json
  console.log('\x1b[1m9. .claude/settings.json\x1b[0m');
  if (!stepClaudeSettings(projectRoot)) return 1;

  // Step 10: justin-sdk.json
  console.log('\x1b[1m10. justin-sdk.json\x1b[0m');
  if (!stepJustinSdkJson(projectRoot)) return 1;

  // Step 11: Git commit
  if (!options.noCommit) {
    console.log('\x1b[1m11. Git commit\x1b[0m');
    const status = exec('git status --porcelain', projectRoot);
    if (status.stdout.trim().length > 0) {
      exec(
        'git add mise.toml .beads/ AGENTS.md .claude/settings.json .prettierignore justin-sdk.json docs/prompts/BEADS.md',
        projectRoot,
      );
      // Also add CLAUDE.md if it was modified
      exec('git add CLAUDE.md', projectRoot);
      const commitResult = exec(
        `git commit -m 'Add beads_rust (br) issue tracking via justin-sdk'`,
        projectRoot,
      );
      if (commitResult.exitCode === 0) {
        success('Committed beads setup');
      } else {
        warn('Git commit failed — you may need to commit manually');
      }
    } else {
      success('No changes to commit');
    }
  }

  console.log(
    `\n\x1b[32m\x1b[1mDone!\x1b[0m beads_rust ${version} is ready in ${basename(projectRoot)}.\n`,
  );

  // Remind about agent-only tasks
  const agentTasks: string[] = [];
  const claudeMd = resolve(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, 'utf-8');
    if (content.includes('bd ') || content.includes('bd\n')) {
      agentTasks.push(
        'CLAUDE.md has stale `bd` references — have an agent clean them up',
      );
    }
  }
  if (agentTasks.length > 0) {
    console.log('\x1b[33mRemaining tasks for an agent:\x1b[0m');
    for (const task of agentTasks) {
      console.log(`  • ${task}`);
    }
    console.log('');
  }

  return 0;
}
