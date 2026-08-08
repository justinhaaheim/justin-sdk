/**
 * setup-env-command.ts — the `setup-env` CLI entry: environment-aware wrapper
 * around the hydration engine (src/setup-env.ts).
 *
 * Supersedes the copied scripts/setup-env.ts template (home-base-j2n7). The
 * per-project surface is now just a SessionStart hook line + a package.json
 * alias; everything the 209-line copy did lives here or in the engine.
 *
 * EXECUTION MODEL (Justin, 2026-08-08):
 *   - REMOTE (CLAUDE_CODE_REMOTE=true): the SessionStart hook runs this. It
 *     bootstraps the environment (mise install, PATH wiring via
 *     CLAUDE_ENV_FILE), runs the hydration engine, then delegates to
 *     `doctor --fix --yes`. Failures WARN and exit 0 — a SessionStart hook
 *     that hard-fails on a flaky network is worse than a degraded session.
 *   - LOCAL: runs at worktree creation (post-checkout preamble) and manual
 *     invocation ONLY — never on a session-start heartbeat (no hidden side
 *     effects; write actions need a trigger). Local session start instead gets
 *     the read-only ENV_HYDRATION doctor check. Exit code is the engine's —
 *     a manual caller wants the truth.
 *
 * A separate module from the engine ON PURPOSE: this imports runDoctor, and
 * doctor.ts (via worktree-hydration.ts) imports the engine — putting this in
 * setup-env.ts would create an import cycle.
 */

import {execSync} from 'node:child_process';
import {appendFileSync, existsSync} from 'node:fs';
import {delimiter, resolve} from 'node:path';

import {runDoctor} from './doctor';
import {report, setupEnv, YELLOW, RESET, DIM} from './setup-env';

const HOME = process.env.HOME ?? '/root';
const MISE_BIN = resolve(HOME, '.local/bin/mise');
const MISE_SHIMS_DIR = resolve(HOME, '.local/share/mise/shims');
const LOCAL_BIN_DIR = resolve(HOME, '.local/bin');

export interface RunSetupEnvOptions {
  dryRun?: boolean;
  /** Directory to hydrate. Defaults to cwd. */
  target?: string;
}

function warn(message: string): void {
  report(`${YELLOW}⚠${RESET} [setup-env] ${message}`);
}

function log(message: string): void {
  report(`${DIM}[setup-env] ${message}${RESET}`);
}

/**
 * Make `mise` (and anything else in ~/.local/bin + the mise shims) resolvable:
 *   - for THIS process's children (the engine's `mise trust`, the install),
 *     by prepending to process.env.PATH;
 *   - for the SESSION's subsequent commands, by appending to CLAUDE_ENV_FILE
 *     when Claude Code provides one.
 * Idempotent on both surfaces.
 */
function wirePath(): void {
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter);
  for (const dir of [MISE_SHIMS_DIR, LOCAL_BIN_DIR]) {
    if (!parts.includes(dir)) {
      process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
    }
  }

  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile != null && envFile.length > 0) {
    appendFileSync(
      envFile,
      `export PATH="${MISE_SHIMS_DIR}:${LOCAL_BIN_DIR}:$PATH"\n`,
    );
  } else {
    warn(
      'CLAUDE_ENV_FILE not set. Tool binaries may not be on PATH for subsequent commands.',
    );
  }
}

/** Install mise via the official script if it is not already present. */
function ensureMiseInstalled(): void {
  if (existsSync(MISE_BIN)) return;
  log('Installing mise...');
  try {
    execSync('curl -fsSL https://mise.run | sh', {
      encoding: 'utf-8',
      stdio: ['ignore', 2, 2],
    });
  } catch {
    warn('mise install failed — continuing without it.');
  }
}

/**
 * Run setup-env: hydrate `target`, with remote environment bootstrap when
 * CLAUDE_CODE_REMOTE=true. Returns the process exit code.
 */
export async function runSetupEnv(
  options: RunSetupEnvOptions = {},
): Promise<number> {
  // Escape hatch carried over from the template era: lets a session disable
  // the hook without editing committed settings.
  if (process.env.JSDK_SKIP_SETUP_ENV === '1') return 0;

  const target = resolve(options.target ?? process.cwd());
  const isRemote = process.env.CLAUDE_CODE_REMOTE === 'true';

  if (!isRemote) {
    return setupEnv({dryRun: options.dryRun, target}).exitCode;
  }

  // --- Remote bootstrap ----------------------------------------------------
  log('Remote environment detected.');
  ensureMiseInstalled();
  wirePath();

  const engine = setupEnv({dryRun: options.dryRun, target});
  if (engine.exitCode !== 0) {
    warn('hydration reported failures — continuing to doctor.');
  }

  // Delegate tool installation/validation to doctor. --yes pre-approves
  // system-level installs (mise, br) — safe in remote/sandbox environments.
  log('Running doctor --fix --yes...');
  try {
    const doctorExit = await runDoctor(target, {
      fix: true,
      quiet: false,
      yes: true,
    });
    if (doctorExit !== 0) {
      warn('doctor --fix --yes reported failures. Check output above.');
    }
  } catch (error) {
    warn(
      `doctor threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Remote always exits 0: a SessionStart hook that fails the session over a
  // degraded bootstrap is worse than a session with a warning banner.
  return 0;
}
