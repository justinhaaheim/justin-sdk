/**
 * Doctor — component-based environment validation.
 *
 * Reads justin-sdk.config.json to determine which components are installed,
 * then runs the corresponding doctor checks.
 *
 * Each component registers its own checks. Adding a new component
 * to justin-sdk.config.json automatically includes its doctor checks.
 */

import type {CheckNode, CheckResult} from './check-runner';

import {execSync} from 'child_process';
import {existsSync, readFileSync, statSync} from 'fs';
import {resolve} from 'path';

import {SDK_BIN_SHADOW_SCRIPT, shadowsSdkBin} from './base-setup';
import {renderCheckTree, runCheckTree} from './check-runner';
import {resolveComponents} from './component-registry';
import {
  CRITICAL_RULES_CONFIG_KEY,
  legacyModulesWarning,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
  RETIRED_MODULES_KEY,
} from './critical-rules-setup';
import {ESLINT_CONFIG_NAMES} from './eslint-setup';
import {buildComponentListing} from './list';
import {PINNED} from './pinned-versions';
import {
  checkRulesDrift,
  isRulesDriftProblem,
  rulesDriftAdvice,
} from './rules/rules-drift';
import {SDK_RUN} from './sdk-invocation';
import {
  checkUserLevelSessionStart,
  USER_SETTINGS_DISPLAY,
  userLevelHookAdvice,
} from './user-level-hook';
import {
  describeMissing,
  detectWorktreeHydration,
  hasBlockingProblem,
  isLinkedWorktree,
} from './worktree-hydration';
import {
  eslintWorktreeStatus,
  prettierWorktreeStatus,
  worktreeGitStatus,
} from './worktree-ignore';

const IS_REMOTE = process.env.CLAUDE_CODE_REMOTE === 'true';

/** Read the centrally pinned version from versions.json (if available). */
function getCentralBeadsVersion(): string | null {
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) return null;
  try {
    const versions = JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
      string,
      string
    >;
    return versions.beads_rust ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd: string): {exitCode: number; stdout: string} {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout};
  } catch {
    return {exitCode: 1, stdout: ''};
  }
}

function parseMiseToml(projectRoot: string): Record<string, string> | null {
  const miseTomlPath = resolve(projectRoot, 'mise.toml');
  if (!existsSync(miseTomlPath)) return null;

  const content = readFileSync(miseTomlPath, 'utf-8');
  const versions: Record<string, string> = {};

  const toolPattern =
    /"([^"]+)"\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/g;
  let match;
  while ((match = toolPattern.exec(content)) !== null) {
    const tool = match[1];
    const version = match[2] ?? match[3];
    if (tool != null && tool !== '' && version != null && version !== '') {
      versions[tool] = version;
    }
  }

  return versions;
}

// ---------------------------------------------------------------------------
// Worktree hydration (base-setup component)
// ---------------------------------------------------------------------------

/**
 * The ENV_HYDRATION check — in EVERY checkout (home-base-j2n7 widened the
 * v170 WORKTREE_HYDRATION check, which registered only inside linked
 * worktrees).
 *
 * WHY EVERYWHERE: setup-env's execution model never auto-installs on a local
 * session-start heartbeat (no hidden side effects), so this read-only check is
 * the ONLY thing standing between "checked out a branch that added a dep" and
 * many minutes of misdiagnosed tool failures in the primary checkout.
 *
 * SEVERITY IS SPLIT BY TOPOLOGY: a linked worktree fails at ERROR (a fresh
 * worktree is expected to be hydrated before use — v170 behavior preserved); a
 * primary checkout WARNS (Justin's ruling: alert, never block, never fix).
 *
 * THE GATE IS NOT SPLIT (F7): doctor reports state rather than deciding whether
 * work may proceed, so ANY problem is `pass: false`. The MESSAGE is split, and
 * only the message (home-base-v170.6) — see the consequence sentence below.
 */
export function makeEnvHydrationChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const linked = isLinkedWorktree(projectRoot);
          const status = detectWorktreeHydration(projectRoot);
          if (status.problems.length === 0) {
            return {
              message: linked
                ? 'linked worktree, hydrated'
                : 'deps present, versions satisfy declared ranges',
              pass: true,
            };
          }
          // The PHANTOM claim is the one sentence in this whole feature that has
          // to be BELIEVED, so it is emitted only where F7 says it is true: a
          // blocking problem (a missing node_modules). Asserting it for an
          // advisory-only gap — say a missing .env.local with node_modules
          // intact — is simply false, and a reader who catches it being false
          // once will discount it in the blocking case where it matters.
          const blocking = hasBlockingProblem(status);
          const consequence = blocking
            ? 'Any lint/type failures here are PHANTOM (they blame untouched files).'
            : 'Lint/type results here are still trustworthy — this cannot fabricate failures — but a build, or any command needing the pinned toolchain, may fail.';
          return {
            fix: `Run: ${status.fixCommand}`,
            message:
              (linked
                ? `${blocking ? '' : 'partially '}unhydrated linked worktree — `
                : 'stale environment — ') +
              `missing ${describeMissing(status)}. ${consequence} ` +
              status.problems.map((problem) => problem.detail).join('; '),
            pass: false,
            severity: linked ? 'error' : 'warn',
          };
        },
        label: 'ENV_HYDRATION',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Base checks (base-setup component)
// ---------------------------------------------------------------------------

function makeBaseChecks(projectRoot: string): CheckNode[] {
  return [
    // FIRST because it explains every other failure when it fires: in an
    // unhydrated worktree the other checks report symptoms, and this one reports
    // the cause. Contributes NOTHING in a primary checkout (empty array), so
    // doctor's output there is unchanged.
    ...makeEnvHydrationChecks(projectRoot),
    {
      check: {
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('bun --version', projectRoot);
          if (exitCode !== 0) {
            // Env-aware fix: brew on macOS, npm global elsewhere, curl as last resort
            let fixCommand: string;
            if (process.platform === 'darwin' && !IS_REMOTE) {
              fixCommand = 'brew install bun';
            } else {
              fixCommand =
                'npm i -g bun || curl -fsSL https://bun.sh/install | bash';
            }
            return {
              fix: `Run: ${fixCommand}`,
              fixCommand,
              message: 'bun is not installed',
              pass: false,
              requiresApproval: true,
            };
          }
          return {message: `bun ${stdout}`, pass: true};
        },
        label: 'BUN',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'CLAUDE.md'))) {
            return {message: 'No CLAUDE.md found', pass: false};
          }
          return {pass: true};
        },
        label: 'CLAUDE_MD',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const result = checkUserLevelSessionStart();
          if (result.status === 'installed') {
            return {message: result.message, pass: true};
          }
          return {
            fix:
              result.status === 'cannot-check'
                ? `Read ${USER_SETTINGS_DISPLAY} by hand and confirm it registers \`session-start --user-level\``
                : userLevelHookAdvice(),
            message: result.message,
            pass: false,
            severity: 'warn',
          };
        },
        /**
         * Is the USER-LEVEL SessionStart hook installed (epic home-base-dchjw D6)?
         *
         * It is not this repo's business in the narrow sense — the check passes
         * or fails identically in every enrolled repo — but it is the only
         * place the absence can be NOTICED. Nothing detected that the `prime`
         * plugin had gone stale for a month, twice; putting its replacement's
         * absence in front of a routine `doctor` run is the whole point.
         *
         * WARN, never error, and READ-ONLY WITH NO FIXER. `~/.claude/settings.json`
         * is Justin's own file, outside every project boundary the SDK has, and
         * a doctor check that edited it would be the SDK reaching into the
         * user's machine on the strength of a heartbeat. The fix is printed and
         * pasted by hand.
         *
         * `cannot-check` also warns, but says so in those words: an unreadable
         * settings file is not evidence the hook is missing (rule 6).
         */
        label: 'USER_LEVEL_SESSION_START',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) {
            return {message: 'No package.json found', pass: false};
          }

          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
            scripts?: Record<string, string>;
          };
          const scripts = pkg.scripts ?? {};
          const required = ['setup-env', 'signal', 'doctor'];
          const missing = required.filter((name) => !(name in scripts));

          if (missing.length > 0) {
            return {
              fix: `Add missing scripts to package.json: ${missing.join(', ')}`,
              message: `Missing package.json scripts: ${missing.join(', ')}`,
              pass: false,
            };
          }

          return {pass: true};
        },
        label: 'PKG_SCRIPTS',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'justin-sdk.config.json'))) {
            return {
              fix: 'Create justin-sdk.config.json at project root',
              message: 'No justin-sdk.config.json found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'JUSTIN_SDK_JSON',
      },
    },
    // SCRIPT_SHADOWS_SDK_BIN (epic home-base-dchjw.4 F8). ERROR, not a warning:
    // every SDK-owned alias and every hook in this repo is spelled
    // `bun run justin-sdk …`, and `bun run` resolves a package.json SCRIPT
    // before `node_modules/.bin`. So a script with that name silently redirects
    // all of them somewhere else — and, because bun echoes `$ <command>` for a
    // script and prints nothing for a bin, it also injects a line into the
    // stdout of hooks whose output is parsed. Nothing on the fleet has one
    // today (measured 2026-09-18); this is the tripwire.
    //
    // No fixCommand: the fix is to rename or delete a script this repo's owner
    // wrote, which is a decision, not a scaffold repair.
    {
      check: {
        fn: (): CheckResult => {
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) return {pass: true};
          let scripts: Record<string, unknown> | undefined;
          try {
            scripts = (
              JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
                scripts?: Record<string, unknown>;
              }
            ).scripts;
          } catch {
            // Unparseable package.json is JUSTIN_SDK_JSON's business, not this
            // check's. Reporting "no shadow" here would be a claim we cannot
            // make, so say so instead (critical rule 6).
            return {
              message: 'package.json could not be parsed — shadow not checked',
              pass: false,
              severity: 'warn',
            };
          }
          if (!shadowsSdkBin(scripts)) {
            return {
              message: 'no script shadows the justin-sdk bin',
              pass: true,
            };
          }
          return {
            fix: `Rename or remove the "${SDK_BIN_SHADOW_SCRIPT}" script in package.json. While it exists, \`${SDK_RUN} <cmd>\` runs that script instead of the SDK, and echoes "$ …" into hook stdout.`,
            message: `package.json has a script named "${SDK_BIN_SHADOW_SCRIPT}", which shadows the justin-sdk bin under \`bun run\``,
            pass: false,
          };
        },
        label: 'SCRIPT_SHADOWS_SDK_BIN',
      },
    },
    // CONFIG_SCHEMA (home-base-uxwc D9). A SIBLING of JUSTIN_SDK_JSON, not a
    // child: the user-level file still deserves validating in a repo that has
    // no project config yet. Warn-only — a config that parses but has one
    // wrong-typed key is a nuisance, not a broken environment — and it does not
    // enumerate what is MISSING, only what is wrong: unknown keys are always
    // allowed, so this can never fail a repo for being ahead of the SDK.
    //
    // sdk-config is `await import`ed rather than imported at the top of this
    // file: cli.ts loads doctor.ts eagerly, so a static import would put zod
    // (12-13ms against a 40-50ms CLI startup) into the time-check and
    // usage-check hook path, which runs on every prompt Justin types.
    {
      check: {
        fn: async (): Promise<CheckResult> => {
          const {
            describeConfigOutcome,
            isConfigProblem,
            readProjectConfig,
            readUserConfig,
          } = await import('./sdk-config');
          const outcomes = [readProjectConfig(projectRoot), readUserConfig()];
          const problems = outcomes
            .filter(isConfigProblem)
            .map((outcome) => describeConfigOutcome(outcome));
          if (problems.length > 0) {
            return {
              fix: 'See every accepted key, its type and its default: bun run justin-sdk config schema',
              message: problems.join(' | '),
              pass: false,
              severity: 'warn',
            };
          }
          return {
            message: outcomes
              .map((outcome) => describeConfigOutcome(outcome))
              .join('; '),
            pass: true,
          };
        },
        label: 'CONFIG_SCHEMA',
        severity: 'warn',
      },
    },
    // SDK_VERSION (home-base-uxwc D5, D6). Warn-only, and deliberately WITHOUT
    // a fixCommand or fixFn: the remote SessionStart hook runs `doctor --fix
    // --yes`, and --yes bypasses requiresApproval, so a fixCommand here would
    // rewrite package.json and bun.lock in every cloud session of every repo in
    // the fleet. The fix is TEXT; a human runs it.
    //
    // It shares the health-notices probe, so it is throttled by the same
    // checkIntervalMinutes as the stderr notice — running doctor does not
    // mean a network call.
    {
      check: {
        fn: async (): Promise<CheckResult> => {
          const {
            NOTICE_FETCH_TIMEOUT_MS,
            probeSdkVersion,
            sdkVersionVerdict,
            UPGRADE_COMMAND,
          } = await import('./health-notices');
          const {SDK_REPO_URL} = await import('./sdk-latest');
          const now = new Date();
          // The short timeout (uxwc.5 F7): doctor --quiet runs from the
          // SessionStart hook, so a dead network must not hold a session up.
          const verdict = sdkVersionVerdict(
            await probeSdkVersion({
              projectRoot,
              timeoutMs: NOTICE_FETCH_TIMEOUT_MS,
            }),
            now,
          );
          switch (verdict.status) {
            case 'newer':
              // `silenced` means promptTier 1 for this kind: Justin has said he
              // does not want to hear about these, so doctor states the fact
              // without colouring the run yellow.
              return verdict.silenced
                ? {message: verdict.message, pass: true}
                : {
                    fix: `Run: ${UPGRADE_COMMAND}`,
                    message: verdict.message,
                    pass: false,
                    severity: 'warn',
                  };
            case 'not-checked':
              // A check nobody asked for is not a failed check. The message
              // still says "not checked" out loud — what must never happen is
              // this rendering as "you are on the latest version".
              return {message: verdict.message, pass: true};
            case 'unknown':
              // Tried and could not tell. Never a pass (D5) — an unknown
              // version is exactly the state Justin has been stuck in.
              return {
                fix: `Check by hand: git ls-remote --tags ${SDK_REPO_URL} | tail`,
                message: verdict.message,
                pass: false,
                severity: 'warn',
              };
            case 'up-to-date':
              return {message: verdict.message, pass: true};
          }
        },
        label: 'SDK_VERSION',
        severity: 'warn',
      },
    },
    // Worktree hygiene. These live in base-setup (universal) ON PURPOSE: the
    // usual failure is a project NOT being enrolled in gitignore/eslint/prettier
    // -setup, so a surface-specific component check would never fire for exactly
    // the projects that need it. Reported as independent SIBLINGS so one missing
    // surface doesn't mask the others. tsconfig is intentionally NOT checked —
    // TS skips dot-dirs, so .claude/worktrees is already invisible to tsc.
    {
      check: {
        fn: (): CheckResult => {
          const status = worktreeGitStatus(projectRoot);
          if (status === 'committed' || status === 'not-git') {
            return {pass: true};
          }
          const message =
            status === 'ephemeral'
              ? '.claude/worktrees is ignored only by a non-committed layer (global git ignore or .git/info/exclude) — that does NOT travel with the repo, so EAS Build and fresh clones still archive the worktrees'
              : '.claude/worktrees is not git-ignored';
          return {
            fix: 'Run: bun run justin-sdk add gitignore (adds .claude/worktrees/ to the committed .gitignore)',
            fixCommand: 'bun run justin-sdk add gitignore',
            message,
            pass: false,
          };
        },
        label: 'WORKTREE_GITIGNORE',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const status = eslintWorktreeStatus(projectRoot);
          if (!status.applicable || status.covered) return {pass: true};
          return {
            fix: `Add '**/.claude/worktrees/' to the ignores in ${status.configFile ?? 'your eslint config'}`,
            message: `${status.configFile ?? 'eslint config'} does not ignore .claude/worktrees — eslint will lint worktree copies (turns signal red)`,
            pass: false,
            severity: 'warn',
          };
        },
        label: 'WORKTREE_ESLINT',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const status = prettierWorktreeStatus(
            projectRoot,
            worktreeGitStatus(projectRoot),
          );
          if (!status.applicable || status.covered) return {pass: true};
          return {
            fix: "Add '**/.claude/worktrees/' to .prettierignore (or ensure the committed .gitignore covers it — prettier reads .gitignore by default)",
            message:
              'prettier will format .claude/worktrees copies (neither .prettierignore nor the committed .gitignore excludes it)',
            pass: false,
            severity: 'warn',
          };
        },
        label: 'WORKTREE_PRETTIER',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Beads checks (beads-setup component)
// ---------------------------------------------------------------------------

function makeBeadsChecks(projectRoot: string): CheckNode[] {
  return [
    // MISE and MISE_TOML are nice-to-haves: they provide the preferred
    // install path for br via mise. If they're missing, the BR check
    // falls back to a direct curl install. That's why they're warn-level
    // and siblings of (not parents of) the BR check.
    {
      check: {
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('mise --version', projectRoot);
          if (exitCode !== 0) {
            const fixCommand = IS_REMOTE
              ? 'curl -fsSL https://mise.run | sh'
              : 'brew install mise';
            return {
              fix: `Run: ${fixCommand}`,
              fixCommand,
              message:
                'mise is not installed (br falls back to direct install)',
              pass: false,
              requiresApproval: true,
            };
          }
          return {message: `mise ${stdout}`, pass: true};
        },
        label: 'MISE',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'mise.toml'))) {
            return {
              fix: 'Create mise.toml to enable mise-managed br installs',
              message: 'No mise.toml found (br falls back to direct install)',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'MISE_TOML',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('br --version', projectRoot);
          if (exitCode !== 0) {
            // Build a fixCommand that tries mise first, then falls
            // back to the official install script. The version comes
            // from versions.json (central pin), with mise.toml as
            // backup. Always include the curl fallback when we know
            // the version.
            const centralVersion = getCentralBeadsVersion();
            const miseVersions = parseMiseToml(projectRoot);
            const beadsKey =
              miseVersions != null
                ? Object.keys(miseVersions).find((k) =>
                    k.includes('beads_rust'),
                  )
                : null;
            const version =
              centralVersion ??
              (beadsKey != null && beadsKey !== ''
                ? miseVersions![beadsKey]
                : null);
            const versionTag =
              version != null && !version.startsWith('v')
                ? `v${version}`
                : version;

            let fixCommand = 'mise install';
            if (versionTag != null) {
              fixCommand = `mise install || curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`;
            }

            return {
              fix: 'Run: mise install (falls back to direct GitHub download if mise is unavailable or rate-limited)',
              fixCommand,
              message: 'br (beads_rust) is not installed or not on PATH',
              pass: false,
              requiresApproval: true,
            };
          }

          // Check version against central pin (preferred) or mise.toml
          const actual = stdout.replace(/^br\s*/, '').trim();
          const centralVersion = getCentralBeadsVersion();
          const miseVersions = parseMiseToml(projectRoot);
          const beadsKey =
            miseVersions != null
              ? Object.keys(miseVersions).find((k) => k.includes('beads_rust'))
              : null;
          const expected =
            centralVersion ??
            (beadsKey != null && beadsKey !== ''
              ? miseVersions![beadsKey]
              : null);

          if (expected != null && actual !== expected) {
            const source =
              centralVersion != null ? 'versions.json' : 'mise.toml';
            return {
              fix: 'Run: mise install',
              fixCommand: 'mise install',
              message: `Version mismatch: expected ${expected} (from ${source}), got ${actual}`,
              pass: false,
              severity: 'warn',
            };
          }

          return {
            message: `br ${actual}`,
            pass: true,
          };
        },
        label: 'BR',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              if (!existsSync(resolve(projectRoot, '.beads/beads.db'))) {
                return {
                  fix: 'Run: br init',
                  fixCommand: 'br init',
                  message: '.beads/beads.db not found — beads not initialized',
                  pass: false,
                };
              }

              const {exitCode} = exec('br list --json', projectRoot);
              if (exitCode !== 0) {
                return {
                  fix: 'Run: br doctor --fix',
                  fixCommand: 'br doctor --fix',
                  message: 'br list failed — database may be corrupt',
                  pass: false,
                };
              }

              return {pass: true};
            },
            label: 'BR_DB',
          },
          // AGENTS.md is no longer generated or required: cross-project guidance
          // is delivered by `justin-sdk prime` (SessionStart hook), and the
          // essential `br` commands live in the prime beads-workflow guideline
          // (+ `br --help`). The old AGENTS_MD / CLAUDE_MD_AGENTS_REF checks were
          // removed here so they stop re-generating AGENTS.md at session start.
          // See home-base-t6a0.12 (migrate-to-prime).
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const prettierIgnore = resolve(projectRoot, '.prettierignore');
          if (!existsSync(prettierIgnore)) {
            return {
              fix: 'Create .prettierignore with .beads entry',
              message: '.prettierignore not found',
              pass: false,
            };
          }

          const content = readFileSync(prettierIgnore, 'utf-8');
          if (!content.includes('.beads')) {
            return {
              fix: 'Add .beads to .prettierignore',
              message: '.prettierignore does not include .beads',
              pass: false,
            };
          }

          return {pass: true};
        },
        label: 'PRETTIER_IGNORE_BEADS',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared package.json helpers
// ---------------------------------------------------------------------------

function readPkgDevDep(projectRoot: string, name: string): string | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? null;
  } catch {
    return null;
  }
}

function readPkgScript(projectRoot: string, name: string): string | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.[name] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prettier checks (prettier-setup component)
// ---------------------------------------------------------------------------

function makePrettierChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'prettier');
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'prettier not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.prettier) {
            return {
              fix: `Update prettier to ${PINNED.prettier} (currently ${installed})`,
              message: `prettier ${installed} installed, pinned is ${PINNED.prettier}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `prettier ${installed}`, pass: true};
        },
        label: 'PRETTIER_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, '.prettierrc.json'))) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierrc.json not found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'PRETTIERRC',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const prettierIgnore = resolve(projectRoot, '.prettierignore');
          if (!existsSync(prettierIgnore)) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierignore not found',
              pass: false,
            };
          }
          const content = readFileSync(prettierIgnore, 'utf-8');
          if (!content.includes('.beads')) {
            return {
              fix: 'Add .beads to .prettierignore (or re-run: bun run justin-sdk add prettier)',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierignore does not include .beads',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'PRETTIERIGNORE',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:PRETTIER');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'package.json missing signal-source:PRETTIER script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_PRETTIER',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'fix-source:PRETTIER');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'package.json missing fix-source:PRETTIER script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'FIX_SOURCE_PRETTIER',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tsconfig checks (tsconfig-setup component)
// ---------------------------------------------------------------------------

function makeTsconfigChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const version = readPkgDevDep(projectRoot, 'typescript');
          if (version == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'typescript is not in devDependencies',
              pass: false,
            };
          }
          if (version !== PINNED.typescript) {
            return {
              fix: `Update package.json devDependencies.typescript to ${PINNED.typescript}`,
              message: `typescript is at ${version}, SDK pins ${PINNED.typescript}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `typescript ${version}`, pass: true};
        },
        label: 'TS_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const version = readPkgDevDep(projectRoot, '@types/bun');
          if (version == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: '@types/bun is not in devDependencies',
              pass: false,
            };
          }
          return {message: `@types/bun ${version}`, pass: true};
        },
        label: 'TYPES_BUN_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'tsconfig.json'))) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'tsconfig.json not found at project root',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'TSCONFIG',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const tsconfigPath = resolve(projectRoot, 'tsconfig.json');
              const raw = readFileSync(tsconfigPath, 'utf-8');
              try {
                const parsed = JSON.parse(raw) as {
                  compilerOptions?: {strict?: boolean};
                };
                if (parsed.compilerOptions?.strict === true) {
                  return {pass: true};
                }
                return {
                  fix: 'Set compilerOptions.strict to true in tsconfig.json',
                  message: 'compilerOptions.strict is not true',
                  pass: false,
                };
              } catch {
                if (/"strict"\s*:\s*true/.test(raw)) {
                  return {pass: true};
                }
                return {
                  fix: 'Set compilerOptions.strict to true in tsconfig.json',
                  message:
                    'compilerOptions.strict is not true (JSONC fallback check)',
                  pass: false,
                };
              }
            },
            label: 'TSCONFIG_STRICT',
          },
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:TS');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'package.json missing signal-source:TS script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_TS',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GitHub Actions checks (gh-actions-setup component)
// ---------------------------------------------------------------------------

function makeGhActionsChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const workflow = resolve(projectRoot, '.github/workflows/signal.yml');
          if (!existsSync(workflow)) {
            return {
              fix: 'Run: bun run justin-sdk add gh-actions',
              fixCommand: 'bun run justin-sdk add gh-actions',
              message: '.github/workflows/signal.yml not found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'GH_ACTIONS_SIGNAL',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const workflow = resolve(
                projectRoot,
                '.github/workflows/signal.yml',
              );
              const content = readFileSync(workflow, 'utf-8');
              if (!content.includes('oven-sh/setup-bun')) {
                return {
                  fix: 'Re-install with: bun run justin-sdk add gh-actions --force',
                  message:
                    '.github/workflows/signal.yml does not use oven-sh/setup-bun — may be a custom workflow',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GH_ACTIONS_SIGNAL_BUN',
            severity: 'warn',
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Gitignore checks (gitignore-setup component)
// ---------------------------------------------------------------------------

function makeGitignoreChecks(projectRoot: string): CheckNode[] {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const FIX_CMD = 'bun run justin-sdk add gitignore';

  function readGitignore(): string | null {
    if (!existsSync(gitignorePath)) return null;
    return readFileSync(gitignorePath, 'utf-8');
  }

  return [
    {
      check: {
        fn: (): CheckResult => {
          if (readGitignore() == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: '.gitignore not found at project root',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'GITIGNORE_EXISTS',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const content = readGitignore() ?? '';
              if (!content.includes('node_modules/')) {
                return {
                  fix: `Run: ${FIX_CMD}`,
                  fixCommand: FIX_CMD,
                  message: '.gitignore missing node_modules/',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GITIGNORE_HAS_NODE_MODULES',
          },
        },
        {
          check: {
            fn: (): CheckResult => {
              const content = readGitignore() ?? '';
              if (!content.includes('tmp/')) {
                return {
                  fix: `Run: ${FIX_CMD}`,
                  fixCommand: FIX_CMD,
                  message: '.gitignore missing tmp/',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GITIGNORE_HAS_TMP',
            severity: 'warn',
          },
        },
        // There is deliberately NO `.env` check here. The gitignore baseline
        // stopped seeding `.env` / `.env.local` in dchjw.6 (Justin, 2026-09-18:
        // the local pattern is `*.local`, `*.local.json`, `*.local.*`), so this
        // check warned on every repo that was CORRECT, and its fix command —
        // `add gitignore` — could not make it green. A check whose remedy does
        // not work is worse than no check: it teaches people to ignore doctor.
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// ESLint checks (eslint-setup component)
// ---------------------------------------------------------------------------

/**
 * Every ESLint flat config actually on disk, in ESLint's own resolution order.
 *
 * The name list is IMPORTED from eslint-setup rather than retyped, so the
 * check and the installer can never disagree about what counts as a config.
 */
function eslintConfigsPresent(projectRoot: string): string[] {
  return ESLINT_CONFIG_NAMES.filter((name) =>
    existsSync(resolve(projectRoot, name)),
  );
}

function makeEslintChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'eslint');
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'eslint not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.eslint) {
            return {
              fix: `Update eslint to ${PINNED.eslint} (currently ${installed})`,
              message: `eslint ${installed} installed, pinned is ${PINNED.eslint}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `eslint ${installed}`, pass: true};
        },
        label: 'ESLINT_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(
            projectRoot,
            'eslint-config-jha-react-node',
          );
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message:
                'eslint-config-jha-react-node not in package.json devDependencies',
              pass: false,
            };
          }
          return {
            message: `eslint-config-jha-react-node ${installed}`,
            pass: true,
          };
        },
        label: 'JHA_CONFIG_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const found = eslintConfigsPresent(projectRoot);
          if (found.length === 0) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: `No eslint config found (looked for ${ESLINT_CONFIG_NAMES.join(', ')})`,
              pass: false,
            };
          }
          return {message: found[0], pass: true};
        },
        label: 'ESLINT_CONFIG',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const found = eslintConfigsPresent(projectRoot);
              if (found.length <= 1) {
                return {message: `one flat config: ${found[0]}`, pass: true};
              }
              return {
                fix: `Delete all but one of ${found.join(', ')} — keep the one you actually maintain.`,
                message: `${found.length} flat configs present (${found.join(', ')}); ESLint loads only ${found[0]} and the rest are dead code`,
                pass: false,
              };
            },
            // Two flat configs is a SILENT misconfiguration: ESLint resolves
            // the names in a fixed order and loads the FIRST one it finds, so
            // the other is dead code that still looks authoritative in the
            // editor. eslint-setup already refuses to create the second one
            // (dchjw.6) — this reports the ones that are already there, which
            // an installer that declines to write can never do.
            //
            // WARN, and no fixCommand: the remedy is deleting one of two files
            // and only the author knows which, so offering `--fix` a choice
            // here would be offering it a deletion.
            label: 'ESLINT_CONFIG_UNIQUE',
            severity: 'warn',
          },
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:LINT');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'package.json missing signal-source:LINT script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_LINT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'fix-source:LINT');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'package.json missing fix-source:LINT script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'FIX_SOURCE_LINT',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Husky checks (husky-setup component)
// ---------------------------------------------------------------------------

function makeHuskyChecks(projectRoot: string): CheckNode[] {
  const FIX_CMD = 'bun run justin-sdk add husky';
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'husky');
          if (installed == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'husky not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.husky) {
            return {
              fix: `Update husky to ${PINNED.husky} (currently ${installed})`,
              message: `husky ${installed} installed, pinned is ${PINNED.husky}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `husky ${installed}`, pass: true};
        },
        label: 'HUSKY_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'lint-staged');
          if (installed == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'lint-staged not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED['lint-staged']) {
            return {
              fix: `Update lint-staged to ${PINNED['lint-staged']} (currently ${installed})`,
              message: `lint-staged ${installed} installed, pinned is ${PINNED['lint-staged']}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `lint-staged ${installed}`, pass: true};
        },
        label: 'LINT_STAGED_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const hookPath = resolve(projectRoot, '.husky/pre-commit');
          if (!existsSync(hookPath)) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: '.husky/pre-commit not found',
              pass: false,
            };
          }
          const mode = statSync(hookPath).mode;
          // Husky v9 layout: core.hooksPath points at .husky/_, whose shim
          // SOURCES the user file — the exec bit on .husky/pre-commit is
          // irrelevant there (verified live: mode 644 + working hooks in
          // home-base). Only the legacy layout (no shim dir) executes the
          // user file directly and needs the bit. Warning on the v9 layout
          // would print at every session start, forever, about nothing.
          const hasV9Shim = existsSync(
            resolve(projectRoot, '.husky/_/pre-commit'),
          );
          if ((mode & 0o111) === 0 && !hasV9Shim) {
            return {
              fix: 'Run: chmod +x .husky/pre-commit',
              fixCommand: 'chmod +x .husky/pre-commit',
              message: '.husky/pre-commit exists but is not executable',
              pass: false,
              severity: 'warn',
            };
          }
          return {pass: true};
        },
        label: 'HUSKY_PRECOMMIT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'prepare');
          if (script == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'package.json missing "prepare" script',
              pass: false,
            };
          }
          if (!script.includes('husky')) {
            return {
              fix: 'Ensure the "prepare" script invokes husky (e.g., "husky" or "husky install")',
              message: `"prepare" script does not reference husky (current: "${script}")`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `prepare: ${script}`, pass: true};
        },
        label: 'PREPARE_SCRIPT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          // lint-staged reads config from a package.json key OR a standalone
          // config file — home-base uses lint-staged.config.mjs (it filters
          // symlinks/submodule gitlinks, which a JSON key cannot). Accept the
          // documented file names, not just the key.
          const CONFIG_FILES = [
            '.lintstagedrc',
            '.lintstagedrc.json',
            '.lintstagedrc.yaml',
            '.lintstagedrc.yml',
            '.lintstagedrc.mjs',
            '.lintstagedrc.cjs',
            '.lintstagedrc.js',
            'lint-staged.config.mjs',
            'lint-staged.config.cjs',
            'lint-staged.config.js',
          ];
          const configFile = CONFIG_FILES.find((name) =>
            existsSync(resolve(projectRoot, name)),
          );
          if (configFile != null) {
            return {message: configFile, pass: true};
          }
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'package.json not found',
              pass: false,
            };
          }
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
              string,
              unknown
            >;
            if (!('lint-staged' in pkg)) {
              return {
                fix: `Run: ${FIX_CMD}`,
                fixCommand: FIX_CMD,
                message:
                  'no lint-staged config (package.json key or config file)',
                pass: false,
              };
            }
            return {pass: true};
          } catch {
            return {
              message: 'package.json is not valid JSON',
              pass: false,
            };
          }
        },
        label: 'LINT_STAGED_CONFIG',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Critical-rules checks (critical-rules-setup component)
// ---------------------------------------------------------------------------

/**
 * Is the committed rules artifact the canonical one? (home-base-si46, D4/D5)
 *
 * The verdict comes from `checkRulesDrift` — the SAME function
 * SessionStart notice uses, so doctor and the session can never tell Justin two
 * different stories about one file. This check only decides how to say it.
 *
 * WARN, NEVER ERROR, for every unhappy state. Out-of-date rules are a nag, not a
 * broken environment: doctor runs at every session start (`doctor --quiet` via
 * the setup-env hook), and making stale rules exit non-zero would turn a routine
 * "there's an update" into a red gate on unrelated work.
 *
 * CANNOT-CHECK IS A WARN TOO, NOT A PASS (D5, critical rule 5). A failed refresh
 * leaves a usable-looking clone behind; certifying the artifact from it — or
 * silently passing because we could not tell — is the exact failure this whole
 * epic exists to prevent.
 *
 * THE FIXER IS IN-PROCESS, WRITE-ONLY, AND NEVER SHELLS OUT (home-base-r47v F1,
 * closing the si46 hole). `--fix` mode calls `refreshCriticalRulesArtifact`
 * directly, which writes exactly one path and never commits — which is the whole
 * requirement for the remote session-start path (`doctor --fix --yes` from
 * setup-env-command.ts): D4 says the write is "either committed with the session
 * work or discarded harmlessly". Neither shell command could do that
 * (`rules-update` COMMITS — it is the pull channel; `add critical-rules` re-runs
 * the whole installer, touching config and the SDK pin), and every fixCommand is
 * spawned in `process.cwd()`, which is not necessarily this `projectRoot`
 * (`runDoctor(target, …)` — home-base-6dni). A closure over projectRoot cannot
 * miss.
 *
 * ONLY `missing` AND `stale` GET A FIXER — the two states where "regenerate from
 * the recorded selection" is unambiguously right:
 *   locally-modified  a regenerate would either overwrite a human's edit (with
 *                     --force) or, without it, no-op and report success while
 *                     the file stays wrong — the advice (rules-diff first) is
 *                     the correct remedy and it needs a human.
 *   cannot-check      the source could not be verified, and the writer REFUSES
 *                     to write from an unverified checkout (D15). Offering a
 *                     fixer here would print a loud failure at every offline
 *                     session start while changing nothing.
 * A state with no fixer simply warns — no fix is attempted, so nothing can fail
 * quietly.
 */
function makeCriticalRulesChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const message = legacyModulesWarning(projectRoot);
          return message == null
            ? {pass: true}
            : {
                fix: `delete componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].${RETIRED_MODULES_KEY} from justin-sdk.config.json`,
                message,
                pass: false,
                severity: 'warn',
              };
        },
        /**
         * The retired per-repo module include-list (epic home-base-dchjw D2).
         *
         * A config carrying `componentConfig["critical-rules"].modules` is not
         * broken — the key is simply ignored — so this warns and never errors.
         * There is no fixer: deleting a key from a human's config file is the
         * fleet sweep's job (dchjw.10), not a session-start side effect.
         *
         * PURE, and it must stay pure: check-runner re-runs every check after a
         * fix, so a latched "already warned once" flag here would report a
         * still-present key as green on the second pass.
         */
        label: 'RULES_MODULES_LEGACY',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const drift = checkRulesDrift(projectRoot);
          if (!isRulesDriftProblem(drift.status)) return {pass: true};
          const advice = rulesDriftAdvice(drift.status);
          const writable =
            drift.status === 'missing' || drift.status === 'stale';
          return {
            ...(advice != null ? {fix: advice} : {}),
            ...(writable
              ? {
                  fixFn: (): void => {
                    const outcome = refreshCriticalRulesArtifact(projectRoot);
                    if (!refreshSucceeded(outcome)) {
                      // Loud, not silent: check-runner reports a thrown fixer as
                      // a fix FAILURE. Returning quietly here would leave the
                      // re-check red with no explanation of why the write
                      // did not happen (critical rule 5).
                      throw new Error(
                        `could not write the rules artifact (${outcome.status}): ${outcome.message}`,
                      );
                    }
                  },
                }
              : {}),
            message: `${drift.status}: ${drift.message}`,
            pass: false,
            severity: 'warn',
          };
        },
        label: 'RULES_ARTIFACT',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Legacy-artifact checks (NOT keyed to a component — they run everywhere)
// ---------------------------------------------------------------------------

/**
 * The leftovers of the retired `prompts` and `claude-md` components (epic
 * home-base-dchjw D3, absorbing dchjw.9's legacy check).
 *
 * These deliberately belong to no component: the components that produced them
 * are DELETED, so a check keyed to either retired name would only ever run in a
 * repo whose config still names a component this SDK no longer has. The
 * artifacts on disk are the evidence, not the config.
 *
 * `severity: 'warn'` — a repo carrying them is stale, not broken, and the remedy
 * (`migrate-to-prime`) deletes files, so it is offered as advice and never as a
 * `fixCommand` doctor could run for you.
 */
function makeLegacyArtifactChecks(projectRoot: string): CheckNode[] {
  const ADVICE = 'Run: bun run justin-sdk migrate-to-prime';
  return [
    {
      check: {
        fn: (): CheckResult => {
          const found: string[] = [];
          if (existsSync(resolve(projectRoot, 'docs/prompts'))) {
            found.push('docs/prompts/');
          }
          if (
            existsSync(
              resolve(projectRoot, 'docs/.prompts-installed-from.json'),
            )
          ) {
            found.push('docs/.prompts-installed-from.json');
          }
          if (readPkgScript(projectRoot, 'install-my-prompts') != null) {
            found.push('the install-my-prompts package.json script');
          }
          if (found.length === 0) return {pass: true};
          return {
            fix: ADVICE,
            message: `${found.join(' + ')} left over from the retired prompts component — run migrate-to-prime`,
            pass: false,
          };
        },
        label: 'NO_LEGACY_PROMPTS',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Components that APPLY here but are not installed (informational)
// ---------------------------------------------------------------------------

/**
 * The one thing `list` can see that no per-component check can: a component
 * whose `includeIf` predicates pass in this repo and which is simply not here —
 * `eas` in an Expo app that was enrolled before the component existed.
 *
 * Components are a per-repo list, so a new one reaches the fleet only through a
 * sweep (epic home-base-dchjw D3). This is the detector for the repos a sweep
 * has not reached, and the reason it lives in doctor is that doctor is the
 * thing that already runs everywhere.
 *
 * NEVER FAILS. It is an info line, not a verdict: nothing is wrong with a repo
 * that has decided it does not want a component, and a check that went red over
 * an available extra would fail SessionStart hooks and sweep gates fleet-wide.
 * Passing checks print their message but are suppressed under `--quiet`, which
 * is exactly the right audience — a human running `doctor`, not a hook.
 */
function makeComponentAvailabilityChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const listing = buildComponentListing(projectRoot);
          if (listing.problem != null) {
            // Rule 6: say that nothing was measured, never print the
            // reassuring "everything that applies is installed".
            return {
              message: `could not resolve the config (${listing.problem}) — availability NOT checked`,
              pass: true,
            };
          }
          const available = listing.rows.filter(
            (row) => row.applicable && !row.installed && !row.resolved,
          );
          if (available.length === 0) {
            return {
              message:
                'every component that applies to this repo is installed or already listed',
              pass: true,
            };
          }
          const names = available.map((row) => row.name).join(', ');
          return {
            message: `applies here but is not installed: ${names} — add with \`${SDK_RUN} add ${available[0]?.name ?? ''}\``,
            pass: true,
          };
        },
        label: 'COMPONENTS_AVAILABLE',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Making the advice runnable
// ---------------------------------------------------------------------------

/**
 * `bun run justin-sdk …` resolves through `node_modules/.bin`, so in a checkout
 * that has never been hydrated — a fresh worktree, a fresh clone, a cloud
 * container before `setup-env` — every fix doctor offers fails with
 * `error: Script not found` and the operator is left with advice that cannot
 * work. Where the bin is absent, say what has to happen first.
 *
 * Applied in ONE place (`withRunnableFixes` below) rather than at each of the
 * ~30 call sites, so a check added later gets it for free, and applied to the
 * displayed `fix` as well as the executed `fixCommand` — prefixing only the
 * latter would leave the printed advice the same dead end it was.
 */
function needsInstallFirst(projectRoot: string): boolean {
  return !existsSync(
    resolve(projectRoot, 'node_modules', '.bin', 'justin-sdk'),
  );
}

const INSTALL_PREFIX = 'bun install && ';

function prefixSdkCommands(text: string): string {
  return text.split(SDK_RUN).join(`${INSTALL_PREFIX}${SDK_RUN}`);
}

/** Wrap every check in the tree so its result's fix advice is runnable here. */
function withRunnableFixes(
  nodes: CheckNode[],
  projectRoot: string,
): CheckNode[] {
  if (!needsInstallFirst(projectRoot)) return nodes;
  return nodes.map((node) => {
    const original = node.check.fn;
    return {
      check:
        original == null
          ? node.check
          : {
              ...node.check,
              fn: async (): Promise<CheckResult> => {
                const result = await original();
                if (result.fix == null && result.fixCommand == null) {
                  return result;
                }
                return {
                  ...result,
                  ...(result.fix == null
                    ? {}
                    : {fix: prefixSdkCommands(result.fix)}),
                  ...(result.fixCommand == null
                    ? {}
                    : {fixCommand: prefixSdkCommands(result.fixCommand)}),
                };
              },
            },
      ...(node.children == null
        ? {}
        : {children: withRunnableFixes(node.children, projectRoot)}),
    };
  });
}

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

// A component with no entry here simply has no doctor checks — see the
// skip-with-no-warning loop in runDoctor.
const componentCheckFactories: Record<
  string,
  (projectRoot: string) => CheckNode[]
> = {
  'base-setup': makeBaseChecks,
  'beads-setup': makeBeadsChecks,
  'critical-rules-setup': makeCriticalRulesChecks,
  'eslint-setup': makeEslintChecks,
  'gh-actions-setup': makeGhActionsChecks,
  'gitignore-setup': makeGitignoreChecks,
  'husky-setup': makeHuskyChecks,
  'prettier-setup': makePrettierChecks,
  'tsconfig-setup': makeTsconfigChecks,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  fix?: boolean;
  quiet?: boolean;
  /** Pre-approve fixes that require approval (system-level installs). */
  yes?: boolean;
}

/**
 * Doctor's own report, as text, rather than as something already printed.
 *
 * `report` is what a CLI run would have written to STDOUT, verbatim and with
 * its ANSI colours intact — an empty string when there was nothing to say (a
 * `--quiet` run where everything passed says one line, so that case is not it).
 */
export interface DoctorReport {
  exitCode: number;
  report: string;
}

/** Everything doctor needs before it can run, or why it cannot. */
type DoctorPlan =
  | {componentCount: number; nodes: CheckNode[]; ok: true}
  | {error: string; ok: false};

/**
 * Resolve the config and assemble the check tree.
 *
 * Separated from running it so `runDoctor` and `renderDoctor` cannot drift:
 * both take their checks, and their refusals, from here.
 */
function planDoctor(projectRoot: string): DoctorPlan {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');

  if (!existsSync(configPath)) {
    return {
      error:
        'Error: justin-sdk.config.json not found. Create one — `{}` is a complete config (components defaults to the core preset) — or run `bun run justin-sdk add base-setup`.',
      ok: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return {
      error: `Error: justin-sdk.config.json is not valid JSON (${error instanceof Error ? error.message : String(error)}). Doctor did not run — this is NOT a clean bill of health.`,
      ok: false,
    };
  }

  const resolved = resolveComponents(parsed, projectRoot);
  if (!resolved.ok) {
    return {
      error: `Error: ${resolved.reason}. Doctor did not run — this is NOT a clean bill of health.`,
      ok: false,
    };
  }
  const components = resolved.components;

  const nodes: CheckNode[] = [
    ...makeLegacyArtifactChecks(projectRoot),
    ...makeComponentAvailabilityChecks(projectRoot),
  ];
  for (const component of components) {
    const factory = componentCheckFactories[component];
    if (factory != null) {
      nodes.push(...factory(projectRoot));
    }
  }

  return {
    componentCount: components.length,
    nodes: withRunnableFixes(nodes, projectRoot),
    ok: true,
  };
}

/**
 * With the legacy and availability checks always present this is unreachable,
 * but it is kept as the honest answer if it ever becomes reachable again: say
 * that nothing was checked, never imply that something was and passed.
 */
function emptyPlanMessage(componentCount: number): string {
  return `No doctor checks registered for the ${componentCount} resolved component(s).`;
}

function checkTreeOptions(
  options: DoctorOptions,
): Parameters<typeof runCheckTree>[1] {
  return {
    align: true,
    fix: options.fix,
    quiet: options.quiet,
    yes: options.yes,
  };
}

/**
 * Run doctor checks for the components this repo's config RESOLVES to, printing
 * the report as it goes.
 *
 * "Resolves to", not "lists": an absent `components` key means the core preset
 * (constraint F1). It used to mean an empty list, so a repo whose config had no
 * `components` — which after D3 is the recommended shape — ran zero checks and
 * printed a calm "No doctor checks registered", which reads as "nothing is
 * wrong" and meant "I did not look" (critical rule 6).
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Doctor options (fix, quiet, yes)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<number> {
  const plan = planDoctor(projectRoot);
  if (!plan.ok) {
    console.error(plan.error);
    return 1;
  }
  if (plan.nodes.length === 0) {
    console.log(emptyPlanMessage(plan.componentCount));
    return 0;
  }
  return await runCheckTree(plan.nodes, checkTreeOptions(options));
}

/**
 * The same run, RETURNED instead of printed — for `session-start`, where stdout
 * belongs to the SessionStart JSON envelope and anything doctor wrote there
 * would corrupt it into unparseable text.
 *
 * This replaced monkey-patching `console.log` and `process.stdout.write` around
 * `runDoctor` (needed because in Bun those are two independent channels), which
 * worked but was a global side effect in front of arbitrary check code, and
 * silently captured anything else the process happened to print meanwhile.
 *
 * A refusal is part of the REPORT here, not a stderr line: the caller is
 * building a context block, and "doctor did not run" is exactly the thing that
 * must not go missing from it (rule 6).
 */
export async function renderDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const plan = planDoctor(projectRoot);
  if (!plan.ok) {
    return {exitCode: 1, report: plan.error};
  }
  if (plan.nodes.length === 0) {
    return {exitCode: 0, report: emptyPlanMessage(plan.componentCount)};
  }
  return await renderCheckTree(plan.nodes, checkTreeOptions(options));
}
