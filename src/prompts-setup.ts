/**
 * prompts-setup.ts — Installs Justin's shared prompt files into a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before prompts-specific steps run.
 *
 * Adds an `install-my-prompts` script to package.json that invokes the
 * external `justinhaaheim/prompts` CLI, and (unless skipped) actually
 * runs that CLI once to materialize the docs/prompts/ directory.
 *
 * Idempotent: re-running produces no spurious changes. The external CLI
 * itself handles per-file diffing, so re-fetching is safe.
 */

import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PROMPTS_PIN} from './pinned-versions';
import {
  exec,
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTALL_PROMPTS_SCRIPT_NAME = 'install-my-prompts';
// Use npx (not bunx). The prompts repo is fetched via GitHub's tarball
// API which requires auth for private repos. npm/npx route through git's
// credential helper (which works locally via macOS keychain or stored
// tokens); bunx hits the unauthenticated tarball endpoint directly and
// 404s on private repos. npx works regardless of repo visibility.
//
// Pinned to a specific commit SHA (see PROMPTS_PIN). To advance the pin,
// edit src/pinned-versions.ts and cut a new SDK release.
const INSTALL_PROMPTS_COMMAND = `npx -y git+https://github.com/${PROMPTS_PIN.repo}#${PROMPTS_PIN.sha} --target-dir docs/prompts --md`;

// Marker file (outside docs/prompts/ so the prompts CLI's wholesale
// overwrite of that directory doesn't clobber it). Records which SHA was
// most recently materialized into the project, so `j update` and doctor
// can detect drift from the SDK's current PROMPTS_PIN.
const PROMPTS_MARKER_REL_PATH = 'docs/.prompts-installed-from.json';

// Past versions of the install command. Detected on re-run and silently
// upgraded so projects pinned to old SHAs (or to the broken bunx path)
// move forward without manual intervention.
const STALE_INSTALL_PROMPTS_PATTERNS: readonly RegExp[] = [
  // Original broken bunx form (pre-2026-05-19)
  /^bunx git\+https:\/\/github\.com\/justinhaaheim\/prompts --target-dir docs\/prompts --md$/,
  // Unpinned npx form (2026-05-19 — before PROMPTS_PIN landed)
  /^npx -y git\+https:\/\/github\.com\/justinhaaheim\/prompts --target-dir docs\/prompts --md$/,
  // Pinned npx form, but to a different SHA than the current PROMPTS_PIN
  /^npx -y git\+https:\/\/github\.com\/justinhaaheim\/prompts#[0-9a-f]+ --target-dir docs\/prompts --md$/,
];

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

/**
 * Add the `install-my-prompts` script to package.json. Preserves an
 * existing custom value (warns once instead of clobbering it).
 */
function stepInstallPromptsScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail(
      'package.json not found or not valid JSON — cannot add prompts script',
    );
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;
  const existing = scripts[INSTALL_PROMPTS_SCRIPT_NAME];

  if (existing == null) {
    scripts[INSTALL_PROMPTS_SCRIPT_NAME] = INSTALL_PROMPTS_COMMAND;
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success(`Added "${INSTALL_PROMPTS_SCRIPT_NAME}" script to package.json`);
    return true;
  }

  if (existing === INSTALL_PROMPTS_COMMAND) {
    success(`"${INSTALL_PROMPTS_SCRIPT_NAME}" script already up to date`);
    return true;
  }

  if (STALE_INSTALL_PROMPTS_PATTERNS.some((re) => re.test(existing))) {
    scripts[INSTALL_PROMPTS_SCRIPT_NAME] = INSTALL_PROMPTS_COMMAND;
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success(
      `Upgraded "${INSTALL_PROMPTS_SCRIPT_NAME}" script to current PROMPTS_PIN (${PROMPTS_PIN.sha})`,
    );
    return true;
  }

  warn(
    `"${INSTALL_PROMPTS_SCRIPT_NAME}" script exists with a custom value — preserving it. ` +
      `Expected: ${INSTALL_PROMPTS_COMMAND}`,
  );
  return true;
}

/**
 * Write the drift-detection marker to docs/.prompts-installed-from.json.
 * Records which SHA we just materialized so doctor + `j update` can
 * detect when a project has drifted from the SDK's current pin.
 *
 * Lives outside docs/prompts/ because the prompts CLI may overwrite the
 * contents of docs/prompts/ wholesale on each run.
 */
function stepWriteMarker(projectRoot: string): boolean {
  const markerPath = resolve(projectRoot, PROMPTS_MARKER_REL_PATH);
  writeJson(markerPath, {
    sha: PROMPTS_PIN.sha,
    repo: PROMPTS_PIN.repo,
    installedAt: new Date().toISOString(),
  });
  success(`Wrote drift marker (${PROMPTS_MARKER_REL_PATH})`);
  return true;
}

/**
 * Invoke the external `justinhaaheim/prompts` CLI to materialize prompt
 * files under docs/prompts/. Network-dependent; failures warn rather than
 * fail so the user can re-run (e.g., once they're out of the sandbox).
 */
function stepFetchPrompts(projectRoot: string): boolean {
  const result = exec(INSTALL_PROMPTS_COMMAND, projectRoot);
  if (result.exitCode !== 0) {
    warn(
      `Failed to fetch prompts (exit ${result.exitCode}). This often means the ` +
        `sandbox blocked the network call or the github.com fetch failed. ` +
        `You can re-run later with: bun run ${INSTALL_PROMPTS_SCRIPT_NAME}`,
    );
    if (result.stderr.length > 0) {
      warn(result.stderr);
    }
    return true;
  }
  success(`Fetched prompt files into docs/prompts/ (pin: ${PROMPTS_PIN.sha})`);
  // Only write the drift marker on successful fetch. A failed fetch
  // (sandbox, network) leaves the previous marker — if any — intact so
  // doctor doesn't claim a fresh pin landed when it didn't.
  return stepWriteMarker(projectRoot);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PromptsSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests) */
  quiet?: boolean;
  /**
   * Forwarded to runBaseSetup. Currently only affects scripts/setup-env.ts.
   * No prompts-specific files are ever force-overwritten — the external
   * prompts CLI handles its own merge behavior.
   */
  force?: boolean;
  /**
   * When true, register the component and add the package.json script,
   * but do NOT actually invoke the external `bunx` command. Used by tests
   * to avoid network access.
   */
  skipFetch?: boolean;
}

/**
 * Install the prompts-setup component in a project.
 *
 * Step 0 runs base-setup as a precondition (also pre-registers
 * 'prompts-setup' in justin-sdk.config.json so we don't have to update it
 * twice).
 */
export async function runPromptsSetup(
  options: PromptsSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;
  const skipFetch = options.skipFetch ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up prompts in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: base-setup precondition. Pre-registers 'prompts-setup' in
  // the components list so we don't have to touch the config file again.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['prompts-setup'],
    force,
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with prompts-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: Add install-my-prompts script to package.json
  stepHeader('1. package.json: install-my-prompts script');
  if (!stepInstallPromptsScript(projectRoot)) return 1;

  // Step 2: Run the external CLI to fetch prompt files (unless skipped)
  if (!skipFetch) {
    stepHeader('2. Fetch prompt files');
    if (!stepFetchPrompts(projectRoot)) return 1;
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mprompts-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
