/**
 * gitignore-setup.ts — Install a richer baseline .gitignore for justin-sdk
 * projects.
 *
 * Composes on top of base-setup. base-setup.stepGitignore handles the
 * narrow set of must-haves (tmp/, dynamic-version.local.*). This component
 * installs the fuller baseline used across all of Justin's node-CLI
 * projects: node_modules, dist, build, coverage, logs, OS junk,
 * local-env patterns, beads recovery dirs, eslint cache, etc.
 *
 * Behavior:
 *  - If .gitignore is missing → copy the template verbatim.
 *  - If .gitignore exists → append only the baseline entries that are
 *    not already present, in a single grouped section.
 *
 * Idempotent: re-running produces no spurious changes. Preserves any
 * user-added entries.
 */

import {copyFileSync, existsSync, readFileSync, appendFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Baseline entries
// ---------------------------------------------------------------------------

/**
 * The fuller baseline of .gitignore entries every justin-sdk node-CLI
 * project should have. Order matters when appending into an existing
 * .gitignore (we keep the order stable so re-runs produce the same diff).
 */
const BASELINE_ENTRIES: ReadonlyArray<string> = [
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '*.log',
  '*.tsbuildinfo',
  '.DS_Store',
  '.env',
  '.env.local',
  '*.local',
  '*.local.json',
  'tmp/',
  '.bv/',
  '.beads/.br_recovery/',
  '.beads/.local_version',
  'dynamic-version.local.json',
  'dynamic-version.local.d.ts',
  '.eslintcache',
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Parse a .gitignore into the set of meaningful (non-comment, non-blank)
 * lines, normalized for comparison. We compare on the trimmed line so
 * trailing whitespace differences don't cause spurious appends.
 */
function existingEntries(content: string): Set<string> {
  const entries = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    entries.add(line);
  }
  return entries;
}

function stepGitignoreFile(projectRoot: string): boolean {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.gitignore.node-cli',
  );

  if (!existsSync(templatePath)) {
    fail(`gitignore template not found at ${templatePath}`);
    return false;
  }

  if (!existsSync(gitignorePath)) {
    copyFileSync(templatePath, gitignorePath);
    success('Created .gitignore from template');
    return true;
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  const present = existingEntries(content);
  const missing = BASELINE_ENTRIES.filter((entry) => !present.has(entry));

  if (missing.length === 0) {
    success('.gitignore already has baseline entries');
    return true;
  }

  // Append a single grouped section. Ensure there's a blank-line separator
  // before our section so we don't accidentally fuse onto the last line.
  const needsLeadingNewline = !content.endsWith('\n');
  let block = '';
  if (needsLeadingNewline) block += '\n';
  block += '\n# justin-sdk baseline (appended)\n';
  for (const entry of missing) {
    block += `${entry}\n`;
  }

  appendFileSync(gitignorePath, block);
  success(`Added ${missing.length} baseline entries to .gitignore`);
  return true;
}

function stepJustinSdkJson(projectRoot: string): boolean {
  // base-setup ensures the config file exists. We just need to add the
  // gitignore-setup component if it's not already there.
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);

  if (config == null) {
    fail(
      'justin-sdk.config.json not found after base-setup — this should not happen',
    );
    return false;
  }

  const components = (
    (config.components as string[] | undefined) ?? []
  ).slice();
  if (components.includes('gitignore-setup')) {
    success(
      'justin-sdk.config.json already includes gitignore-setup component',
    );
    return true;
  }

  components.push('gitignore-setup');
  config.components = components;
  writeJson(configPath, config);
  success('Added gitignore-setup to justin-sdk.config.json components');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GitignoreSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests / chained setup commands) */
  quiet?: boolean;
  /**
   * Reserved for future use. The gitignore component has no
   * destructive-overwrite path today, so this currently has no effect.
   */
  force?: boolean;
}

/**
 * Install the richer .gitignore baseline in a project. Runs base-setup
 * as a precondition so the foundation layer is in place.
 */
export async function runGitignoreSetup(
  options: GitignoreSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (!quiet) {
    console.log(
      `\n\x1b[1mInstalling gitignore-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // Pre-register 'gitignore-setup' as a component so we don't have to
  // update the config file twice. base-setup.stepGitignore will run too,
  // but its narrow appends are subsumed by our fuller baseline — both
  // remain idempotent.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['gitignore-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with gitignore-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: .gitignore (fuller baseline)
  stepHeader('1. .gitignore (full baseline)');
  if (!stepGitignoreFile(projectRoot)) return 1;

  // Step 2: justin-sdk.config.json (ensure gitignore-setup is in components)
  stepHeader('2. justin-sdk.config.json');
  if (!stepJustinSdkJson(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mgitignore-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
