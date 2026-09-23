/**
 * update.ts — `justin-sdk update` orchestrator.
 *
 * Brings an existing justin-sdk project up to whatever the SDK's current
 * pinned state is. Idempotent; designed to be run periodically (e.g.
 * after the SDK ships a new pin for prettier, eslint, etc.).
 *
 * Phases:
 *   1. Preflight       — justin-sdk.config.json must exist; tree must be
 *                        clean unless --allow-dirty
 *   2. Self-update     — bump the SDK in devDependencies; re-exec the
 *                        freshly installed CLI (unless --no-self-update)
 *   3. Reconcile       — delegate to `install`: add what the config lists and
 *                        the repo lacks, re-apply the rest. It removes NOTHING
 *                        (dchjw.17 F1/F2) and update never passes `prune`
 *   4. Self-check      — runDoctor; print warnings but don't fail update
 *   5. Git commit      — single "chore: sync justin-sdk to vX.Y.Z" commit
 *                        (skipped if working tree was already dirty, or
 *                        if --no-commit is passed)
 *
 * It writes NOTHING back to justin-sdk.config.json. The two SDK-version stamps
 * it used to bump here were write-only (D3), and re-running a component is not a
 * licence to edit the list of them.
 *
 * Re-exec dance: when self-update bumps the SDK, this process is still
 * running the OLD code. We re-exec the freshly installed CLI with
 * --no-self-update so the rest of the update runs against the new pins.
 */

import {spawnSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {resolveComponents} from './component-registry';
import {runDoctor} from './doctor';
import {runInstall} from './install';
import {getSdkVersion} from './sdk-identity';
import {resolveWorktreeSdkBin, worktreeSdkArgv} from './sdk-invocation';
import {selfUpdateSdk} from './self-update';
import {
  exec,
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  /** Allow running with uncommitted changes. */
  allowDirty?: boolean;
  /** Print the plan without writing. */
  dryRun?: boolean;
  /** Pass --force through to each component. */
  force?: boolean;
  /** Skip the final git commit. */
  noCommit?: boolean;
  /** Skip the SDK self-update step (used by the re-exec dance). */
  noSelfUpdate?: boolean;
  projectRoot?: string;
  quiet?: boolean;
}

/**
 * Run the full update sequence. Returns an exit code (0 = success).
 *
 * When self-update bumps the SDK, this function does NOT return — it
 * execs the newly installed CLI and calls process.exit() with the
 * child's status.
 */
/**
 * The argv for the re-exec after a self-update, or the reason there is none.
 *
 * THE REPO'S OWN BINARY, BY PATH (dchjw.17 F4). This used to be `sdkRunArgv` —
 * `bun run justin-sdk` — which is form D1(b) and correct for a hook, but wrong
 * here: `bun run` falls through to PATH when `node_modules/.bin` is missing,
 * and this machine carries a `justin-sdk` PATH shim. Re-execing the shim runs
 * the ORCHESTRATOR's SDK against this repo and reports it as the repo's own
 * update — the same fallthrough dchjw.15 F2 closed at the sweep gates. The
 * self-update that just ran installed the new pin, so the binary is precisely
 * what we mean to run; if it is not there, that install did not land and there
 * is nothing honest to re-exec.
 *
 * Exported and pure-ish (one existence check) so the refusal is testable
 * without a network, a release, or a real self-update.
 */
export function planUpdateReExec(
  projectRoot: string,
  flags: {
    allowDirty: boolean;
    force: boolean;
    noCommit: boolean;
    quiet: boolean;
  },
): {argv: string[]; ok: true} | {detail: string; ok: false} {
  const bin = resolveWorktreeSdkBin(projectRoot);
  if (!bin.ok) return {detail: bin.detail, ok: false};
  // --no-self-update avoids infinite recursion; everything else is the flags
  // the user cared about, passed through.
  const args = ['update', '--no-self-update'];
  if (flags.noCommit) args.push('--no-commit');
  if (flags.allowDirty) args.push('--allow-dirty');
  if (flags.force) args.push('--force');
  if (flags.quiet) args.push('--quiet');
  return {argv: worktreeSdkArgv(bin.path, args), ok: true};
}

export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
  const quiet = options.quiet ?? false;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const noSelfUpdate = options.noSelfUpdate ?? false;
  const noCommit = options.noCommit ?? false;
  const dryRun = options.dryRun ?? false;
  const allowDirty = options.allowDirty ?? false;
  const force = options.force ?? false;

  setQuiet(quiet);

  if (!quiet) {
    console.log(
      `\n\x1b[1mUpdating justin-sdk project in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 1: Preflight
  // -------------------------------------------------------------------------
  stepHeader('1. Preflight');

  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) {
    fail(
      'justin-sdk.config.json not found. ' +
        'Run `bun run justin-sdk init` (greenfield) or `bun run justin-sdk add base-setup` first.',
    );
    return 1;
  }
  const config = readJson(configPath) ?? {};
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) {
    fail(`${resolved.reason} — fix it and re-run; nothing was applied.`);
    return 1;
  }
  const components = resolved.components;
  success(
    `Found justin-sdk.config.json (${components.length} components, ${resolved.source === 'core' ? 'from the core preset — no `components` key' : 'listed'})`,
  );

  const gitStatus = exec('git status --porcelain', projectRoot);
  const treeWasDirty =
    gitStatus.exitCode === 0 && gitStatus.stdout.trim().length > 0;
  if (treeWasDirty && !allowDirty) {
    fail(
      'Working tree has uncommitted changes. Re-run with --allow-dirty (no final commit) or commit/stash first.',
    );
    return 1;
  }
  if (treeWasDirty) {
    success(
      'Proceeding with dirty tree (--allow-dirty; will skip final commit)',
    );
  } else {
    success('Working tree clean');
  }

  // -------------------------------------------------------------------------
  // Phase 2: Self-update (and re-exec if we bumped)
  // -------------------------------------------------------------------------
  if (!noSelfUpdate && !dryRun) {
    stepHeader('2. Self-update SDK');
    const result = await selfUpdateSdk(projectRoot);
    if (result.shouldReExec) {
      const reExec = planUpdateReExec(projectRoot, {
        allowDirty,
        force,
        noCommit,
        quiet,
      });
      if (!reExec.ok) {
        fail(
          `Self-update installed ${result.newVersion ?? 'a new version'}, but the re-exec cannot run: ${reExec.detail} Nothing was reconciled; run \`bun install\` here and re-run \`update\`.`,
        );
        return 1;
      }
      success(`Re-executing with new SDK (${result.newVersion}) …`);
      const [command, ...rest] = reExec.argv;
      const child = spawnSync(command!, rest, {
        cwd: projectRoot,
        stdio: 'inherit',
      });
      process.exit(child.status ?? 1);
    }
  } else if (dryRun) {
    stepHeader('2. Self-update SDK (dry-run)');
    success('(dry-run) would query latest SDK tag and bump if behind');
  }

  // -------------------------------------------------------------------------
  // Phase 3: Reconcile — `update` IS `install` with a pin bump in front (D3)
  // -------------------------------------------------------------------------
  // This used to be a re-apply loop that could only ever grow a repo: it
  // re-ran every listed component and had no way to notice one the config had
  // stopped listing. Delegating to `install` means update reconciles in both
  // directions, under install/remove's identity rules, with one implementation.
  stepHeader('3. Reconcile components (install)');
  setQuiet(quiet);
  const installExit = await runInstall({
    dryRun,
    force,
    projectRoot,
    quiet,
  });
  setQuiet(quiet);
  if (installExit !== 0) {
    fail(`install failed (exit ${installExit}); aborting update.`);
    return installExit;
  }

  // -------------------------------------------------------------------------
  // Phase 4: Self-check via doctor
  // -------------------------------------------------------------------------
  stepHeader('4. doctor (self-check)');
  if (dryRun) {
    success('(dry-run) skipping doctor');
  } else {
    setQuiet(quiet);
    const doctorExit = await runDoctor(projectRoot, {quiet: true});
    setQuiet(quiet);
    if (doctorExit !== 0) {
      warn(
        'doctor reported issues — run `bun run justin-sdk doctor` for details.',
      );
    } else {
      success('All doctor checks passed');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5: Single git commit
  // -------------------------------------------------------------------------
  if (dryRun) {
    stepHeader('5. Git commit (dry-run)');
    success('(dry-run) would commit changes if any');
  } else if (noCommit) {
    stepHeader('5. Git commit');
    success('Skipping commit (--no-commit)');
  } else if (treeWasDirty) {
    stepHeader('5. Git commit');
    warn(
      'Tree was already dirty before update — skipping commit so we do not bundle unrelated work. ' +
        'Stage and commit manually.',
    );
  } else {
    stepHeader('5. Git commit');
    const after = exec('git status --porcelain', projectRoot);
    if (after.exitCode !== 0 || after.stdout.trim().length === 0) {
      success('Nothing to commit — already in sync');
    } else {
      // Prose, like init's scaffold commit: degrade visibly, do not refuse.
      const sdkVersion = getSdkVersion() ?? 'unknown';
      const addResult = exec('git add -A', projectRoot);
      if (addResult.exitCode !== 0) {
        warn(
          `git add -A failed (exit ${addResult.exitCode}); leaving changes staged for manual commit.`,
        );
      } else {
        // --no-verify because lint-staged on the just-updated tree can
        // re-touch files via the prettier hook and cause weird re-runs.
        // The post-update doctor check is the real verification.
        const commitResult = exec(
          `git commit --no-verify -m 'chore: sync justin-sdk to v${sdkVersion}'`,
          projectRoot,
        );
        if (commitResult.exitCode === 0) {
          success(`Committed sync (justin-sdk v${sdkVersion})`);
        } else {
          warn(
            'git commit did not run cleanly — verify with `git log` / `git status`.',
          );
        }
      }
    }
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mupdate complete\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}

/**
 * Verify a file (other than the SDK config) was actually opened by the
 * config. Exposed for tests; kept here for proximity to runUpdate's
 * config-reading logic.
 */
export function readConfigComponents(projectRoot: string): string[] | null {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
  const resolved = resolveComponents(parsed, projectRoot);
  return resolved.ok ? resolved.components : null;
}
