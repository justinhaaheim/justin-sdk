#!/usr/bin/env bun

/**
 * justin-sdk CLI
 *
 * Cross-project tooling for Justin's projects.
 * Provides doctor checks, signal (code quality) checks, and more.
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {ADD_TARGETS, PRESET_NAMES, runAdd} from './add';
import {runAgent} from './agent';
import {runDoctor} from './doctor';
import {runEasUpdate} from './eas-update';
import {runFix} from './fix';
import {runInit} from './init';
import {runMigrateToPrime} from './migrate-to-prime';
import {runPrime} from './plugin/lib/prime';
import {DEFAULT_OPTIONS as RALPH_DEFAULTS, runRalph} from './ralph';
import {runSyncRules} from './sync-rules';
import {runSignal} from './signal';
import {runUpdate} from './update';
import {
  type Tier,
  resolveTier,
  worktreeNew,
  worktreeSetup,
} from './worktree-setup';

const TIER_FLAG_HELP: Record<Tier, string> = {
  lint: 'Seconds: mise trust + .worktreeinclude copy + lint-tier project scripts',
  js: 'The lint tier plus dependency install and js-tier scripts (default — the floor at which `signal` means anything)',
  native:
    'Everything, including native-tier project scripts (prebuild/pod install — minutes)',
};

void yargs(hideBin(process.argv))
  .scriptName('justin-sdk')
  .command(
    'doctor',
    'Run environment checks based on justin-sdk.config.json components',
    (y) =>
      y
        .option('fix', {
          type: 'boolean',
          describe: 'Attempt to auto-fix failures',
          default: false,
        })
        .option('quiet', {
          type: 'boolean',
          describe: 'Summary only (one-liner on all-pass)',
          default: false,
        })
        .option('yes', {
          alias: 'y',
          type: 'boolean',
          describe:
            'Pre-approve fixes that modify system state (installs, global packages). Without this, those fixes are reported but skipped.',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runDoctor(process.cwd(), {
        fix: argv.fix,
        quiet: argv.quiet,
        yes: argv.yes,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'signal',
    'Run code quality checks from package.json signal-source:* scripts',
    (y) =>
      y
        .option('quiet', {
          type: 'boolean',
          describe: 'Summary only (one-liner on all-pass)',
          default: false,
        })
        .option('serial', {
          type: 'boolean',
          describe: 'Run checks sequentially instead of in parallel',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runSignal(process.cwd(), {
        quiet: argv.quiet,
        serial: argv.serial,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'fix',
    'Auto-fix code from package.json fix-source:* scripts (eslint --fix, prettier --write). Runs serially and mutates files. Distinct from doctor, which fixes scaffolding (configs/deps), not code.',
    (y) =>
      y.option('quiet', {
        type: 'boolean',
        describe: 'Summary only (one-liner on all-pass)',
        default: false,
      }),
    async (argv) => {
      const exitCode = await runFix(process.cwd(), {
        quiet: argv.quiet,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'add <target>',
    `Add a justin-sdk component or preset (${PRESET_NAMES.join(', ')}) to the current project`,
    (y) =>
      y
        .positional('target', {
          type: 'string',
          describe:
            'Component to add, or a preset that expands to several (minimal = base-setup + beads; core = code-quality + beads; all = everything)',
          choices: ADD_TARGETS,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a git commit at the end (single-component beads only). Default is off — pass --commit to opt in. Without it, files change in the working tree but nothing is committed, so you can run it like a dry run and inspect the diff first. Presets are always no-commit and ignore this flag.',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe:
            "Overwrite hand-modified files (currently: scripts/setup-env.ts) that differ from the SDK template and don't match a known-old hash",
          default: false,
        }),
    async (argv) => {
      const exitCode = await runAdd(argv.target as string, {
        commit: argv.commit,
        force: argv.force,
        projectRoot: process.cwd(),
      });
      process.exit(exitCode);
    },
  )
  .command(
    'init',
    'Scaffold a greenfield project (package.json + all add components; pass --commit to also commit)',
    (y) =>
      y
        .option('preset', {
          type: 'string',
          describe: 'Preset to use',
          default: 'node-cli',
          choices: ['node-cli'],
        })
        .option('allow-dirty', {
          type: 'boolean',
          describe: 'Allow running with uncommitted changes',
          default: false,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a single git commit at the end. Default is off — pass --commit to opt in. Without it, files change in the working tree but nothing is committed, so you can inspect the diff first.',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe: 'Pass --force to underlying add commands',
          default: false,
        }),
    async (argv) => {
      if (argv.preset !== 'node-cli') {
        console.error(
          `Error: preset '${argv.preset}' not yet supported (planned for future release)`,
        );
        process.exit(1);
      }
      const exitCode = await runInit({
        allowDirty: argv['allow-dirty'],
        force: argv.force,
        noCommit: !argv.commit,
        projectRoot: process.cwd(),
      });
      process.exit(exitCode);
    },
  )
  .command(
    'update',
    "Sync this project to the SDK's current pinned state (re-applies all components)",
    (y) =>
      y
        .option('self-update', {
          type: 'boolean',
          describe:
            'Bump the SDK in devDependencies first, then re-exec the new CLI (use --no-self-update to skip)',
          default: true,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a single git commit at the end. Default is off — pass --commit to opt in.',
          default: false,
        })
        .option('allow-dirty', {
          type: 'boolean',
          describe:
            'Allow running with uncommitted changes (commit step still respects --commit)',
          default: false,
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Print the plan without writing',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe: 'Pass --force to underlying add commands',
          default: false,
        })
        .option('skip-prompts-fetch', {
          type: 'boolean',
          describe: 'Skip fetching the prompts library (used by tests)',
          default: false,
        })
        .option('quiet', {
          type: 'boolean',
          describe: 'Suppress non-error output',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runUpdate({
        allowDirty: argv['allow-dirty'],
        dryRun: argv['dry-run'],
        force: argv.force,
        noCommit: !argv.commit,
        noSelfUpdate: !argv['self-update'],
        projectRoot: process.cwd(),
        quiet: argv.quiet,
        skipPromptsFetch: argv['skip-prompts-fetch'],
      });
      process.exit(exitCode);
    },
  )
  .command(
    'eas-update <channel> [changelog..]',
    'Publish an EAS update with a standardized, disambiguating message (<dynamicVersion>-<branch> (<runtime> runtime) - <changelog>). Reads dynamic-version.local.json in the cwd (run `bun run prebuild` first); environment resolves from APP_VARIANT.',
    (y) =>
      y
        .positional('channel', {
          type: 'string',
          describe: 'EAS channel (development / preview / production)',
        })
        .positional('changelog', {
          type: 'string',
          array: true,
          describe: 'Changelog text; defaults to the latest commit subject',
        })
        .option('platform', {
          type: 'string',
          describe: 'EAS platform',
          default: 'ios',
        }),
    (argv) => {
      const changelog = ((argv.changelog as string[] | undefined) ?? [])
        .join(' ')
        .trim();
      const exitCode = runEasUpdate(process.cwd(), {
        channel: argv.channel as string,
        changelog: changelog !== '' ? changelog : null,
        platform: argv.platform,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'ralph',
    'Run an external autonomous loop: a fresh `claude -p` per iteration, gated on your real /usage quota. Run from a real terminal, not inside a Claude session.',
    (y) =>
      y
        .option('mode', {
          type: 'string',
          choices: ['attachable', 'print'] as const,
          describe:
            'attachable: `claude --bg` — inspect with `claude logs <id>`, step in with `claude attach <id>`, answer questions from `claude agents`. print: headless `claude -p`, not attachable, a question becomes a BLOCKED verdict.',
          default: RALPH_DEFAULTS.mode,
        })
        .option('blocked-wait-min', {
          type: 'number',
          describe:
            'attachable only: how long a blocked iteration waits for your answer before being stopped and filed as a bead',
          default: RALPH_DEFAULTS.blockedWaitMin,
        })
        .option('poll-sec', {
          type: 'number',
          describe: 'attachable only: seconds between agent-state polls',
          default: RALPH_DEFAULTS.pollSec,
        })
        .option('verdict-path', {
          type: 'string',
          describe: 'attachable only: where each iteration writes its verdict',
          default: RALPH_DEFAULTS.verdictPath,
        })
        .option('prompt', {
          type: 'string',
          describe: 'Prompt for each iteration (a slash command works)',
          default: RALPH_DEFAULTS.prompt,
        })
        .option('max-iterations', {
          type: 'number',
          describe: 'Maximum iterations before stopping',
          default: RALPH_DEFAULTS.maxIterations,
        })
        .option('session-stop-pct', {
          type: 'number',
          describe:
            'Pause/exit when the 5-hour session window reaches this percent',
          default: RALPH_DEFAULTS.sessionStopPct,
        })
        .option('weekly-stop-pct', {
          type: 'number',
          describe: 'Pause/exit when the weekly window reaches this percent',
          default: RALPH_DEFAULTS.weeklyStopPct,
        })
        .option('on-gate-hit', {
          type: 'string',
          choices: ['pause', 'exit'] as const,
          describe: 'Wait for quota to reset, or stop the run',
          default: RALPH_DEFAULTS.onGateHit,
        })
        .option('gate-poll-min', {
          type: 'number',
          describe: 'Minutes between (free) quota re-checks while paused',
          default: RALPH_DEFAULTS.gatePollMin,
        })
        .option('max-budget-usd', {
          type: 'number',
          describe: 'Hard per-iteration cost cap (omit to disable)',
        })
        .option('model', {
          type: 'string',
          describe: 'Model for each iteration',
          default: RALPH_DEFAULTS.model,
        })
        .option('permission-mode', {
          type: 'string',
          describe: 'Permission mode for each iteration',
          default: RALPH_DEFAULTS.permissionMode,
        })
        .option('timeout-min', {
          type: 'number',
          describe: 'Per-iteration wall-clock timeout in minutes',
          default: RALPH_DEFAULTS.timeoutMin,
        })
        .option('no-progress-abort', {
          type: 'number',
          describe:
            'Abort after this many consecutive iterations with no new commit',
          default: RALPH_DEFAULTS.noProgressAbort,
        })
        .option('ledger', {
          type: 'string',
          describe: 'Path for the per-iteration JSONL ledger',
          default: RALPH_DEFAULTS.ledgerPath,
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Show quota + config and exit without spawning iterations',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runRalph(process.cwd(), {
        blockedWaitMin: argv['blocked-wait-min'],
        dryRun: argv['dry-run'],
        gatePollMin: argv['gate-poll-min'],
        ledgerPath: argv.ledger,
        maxBudgetUsd: argv['max-budget-usd'] ?? null,
        maxIterations: argv['max-iterations'],
        mode: argv.mode as 'print' | 'attachable',
        model: argv.model,
        pollSec: argv['poll-sec'],
        verdictPath: argv['verdict-path'],
        noProgressAbort: argv['no-progress-abort'],
        onGateHit: argv['on-gate-hit'] as 'pause' | 'exit',
        permissionMode: argv['permission-mode'],
        prompt: argv.prompt,
        sessionStopPct: argv['session-stop-pct'],
        timeoutMin: argv['timeout-min'],
        weeklyStopPct: argv['weekly-stop-pct'],
      });
      process.exit(exitCode);
    },
  )
  .command(
    'agent',
    'Print the agent playbook (self-contained instructions for AI coding agents)',
    (y) => y,
    () => {
      runAgent();
      process.exit(0);
    },
  )
  .command(
    'prime',
    'Assemble + emit the critical-rules for the current project from the prompts repo (read-only, no network)',
    (y) =>
      y
        .option('format', {
          type: 'string',
          choices: ['markdown', 'hook'] as const,
          default: 'markdown',
          describe:
            'markdown = human-readable (default); hook = SessionStart additionalContext JSON envelope',
        })
        .option('full', {
          type: 'boolean',
          default: false,
          describe:
            'Print the complete rules (universal + all matching conditional). This is already the default; the flag is a stable, memorable command to hand to Claude ("run prime --full") when the hook injection was truncated.',
        })
        .option('partition', {
          type: 'string',
          choices: ['universal', 'conditional', 'full'] as const,
          default: 'full',
          describe:
            'Which slice of the rules to emit: universal (always-on) | conditional (project-type-gated) | full (both). Default full. --full forces full.',
        })
        .option('prompts-dir', {
          type: 'string',
          describe:
            'Override the prompts repo location (default: $JSDK_PROMPTS_DIR or ~/Dev/prompts)',
        })
        .option('force-update', {
          type: 'boolean',
          describe:
            'Force a fetch/pull of the managed prompts clone, bypassing the staleness gate',
          default: false,
        }),
    (argv) => {
      const exitCode = runPrime(process.cwd(), {
        format: argv.format as 'markdown' | 'hook',
        partition: argv.full
          ? 'full'
          : (argv.partition as 'universal' | 'conditional' | 'full'),
        promptsDir: argv['prompts-dir'],
        forceUpdate: argv['force-update'],
      });
      process.exit(exitCode);
    },
  )
  .command(
    'sync-rules',
    'Regenerate ~/.claude/rules/justin-sdk/critical-rules.md (the universal always-on rules Claude autoloads) from the managed prompts clone. Run AFTER pushing a prompts change. Idempotent; never reads ~/Dev/prompts. Works from any project.',
    (y) =>
      y
        .option('force', {
          type: 'boolean',
          default: false,
          describe: 'Rewrite even when the content hash is unchanged',
        })
        .option('quiet', {
          type: 'boolean',
          default: false,
          describe: 'Suppress non-error output',
        }),
    (argv) => {
      process.exit(runSyncRules({force: argv.force, quiet: argv.quiet}));
    },
  )
  .command(
    'migrate-to-prime',
    'One-time migration to justin-sdk prime: remove docs/prompts + AGENTS.md (safe/recoverable only) + standalone CLAUDE.md @-refs + the now-redundant per-project prime SessionStart hook (the prime plugin injects globally), and flag anything needing manual review. Idempotent; default no-commit.',
    (y) =>
      y
        .option('commit', {
          type: 'boolean',
          describe:
            'Commit the migration at the end. Default off — inspect the diff and resolve flagged items first.',
          default: false,
        })
        .option('quiet', {
          type: 'boolean',
          describe: 'Suppress non-error output',
          default: false,
        }),
    (argv) => {
      const exitCode = runMigrateToPrime({
        commit: argv.commit,
        projectRoot: process.cwd(),
        quiet: argv.quiet,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'worktree-setup',
    'Hydrate a git worktree: mise trust, install deps, copy the .worktreeinclude files from the primary checkout, run worktree-source:<tier>:* scripts. A fresh worktree has only tracked files, so it is neither buildable nor lintable until this runs. Report goes to stderr; stdout stays empty.',
    (y) =>
      y
        .option('lint', {type: 'boolean', describe: TIER_FLAG_HELP.lint})
        .option('js', {type: 'boolean', describe: TIER_FLAG_HELP.js})
        .option('native', {type: 'boolean', describe: TIER_FLAG_HELP.native})
        .option('target', {
          type: 'string',
          describe:
            'Worktree to hydrate (default: cwd). Lets you run this from the primary checkout, where the SDK is already installed.',
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Print what would happen and change nothing',
          default: false,
        }),
    (argv) => {
      const tier = resolveTier({
        js: argv.js,
        lint: argv.lint,
        native: argv.native,
      });
      if ('error' in tier) {
        console.error(`Error: ${tier.error}`);
        process.exit(1);
      }
      const result = worktreeSetup({
        dryRun: argv['dry-run'],
        target: argv.target,
        tier: tier.tier,
      });
      process.exit(result.exitCode);
    },
  )
  .command(
    'worktree-new <slug>',
    'Create a worktree the way Claude Code does — .claude/worktrees/<slug> on branch worktree-<slug> — then hydrate it. Prints exactly one stdout line, the absolute worktree path, for the `wt` shell function to cd into.',
    (y) =>
      y
        .positional('slug', {
          type: 'string',
          describe:
            'Names both the directory and the branch. [A-Za-z0-9._-] only — no slashes.',
        })
        .option('lint', {type: 'boolean', describe: TIER_FLAG_HELP.lint})
        .option('js', {type: 'boolean', describe: TIER_FLAG_HELP.js})
        .option('native', {type: 'boolean', describe: TIER_FLAG_HELP.native})
        .option('setup', {
          type: 'boolean',
          describe:
            'Hydrate after creating (default). Pass --no-setup to create only.',
          default: true,
        }),
    (argv) => {
      const tier = resolveTier({
        js: argv.js,
        lint: argv.lint,
        native: argv.native,
      });
      if ('error' in tier) {
        console.error(`Error: ${tier.error}`);
        process.exit(1);
      }
      const result = worktreeNew({
        noSetup: !argv.setup,
        slug: argv.slug as string,
        tier: tier.tier,
      });
      process.exit(result.exitCode);
    },
  )
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
