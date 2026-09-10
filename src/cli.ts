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
import {runBeadsRebuildDryRun} from './beads-rebuild-dryrun';
import {COMPONENT_NAMES} from './components';
import {runDoctor} from './doctor';
import {runEasUpdate} from './eas-update';
import {runFix} from './fix';
import {runInit} from './init';
import {
  createHandoff,
  DISPOSITIONS,
  emit,
  parseCreateFlags,
  renderCreate,
  renderValidate,
  validateHandoffs,
} from './justin-loop/handoff';
import {runMigrateToPrime} from './migrate-to-prime';
import {runPrime} from './plugin/lib/prime';
import {repoStatusCommand} from './repo-status/repo-status';
import {
  DEFAULT_OPTIONS as LOOP_DEFAULTS,
  runJustinLoop,
} from './justin-loop/runner';
import {runRulesDiff} from './rules-diff';
import {configSchemaJson, renderConfigSchema} from './sdk-config';
import {runRulesUpdate} from './rules-update';
import {runSkill} from './skill';
import {runSyncRules} from './sync-rules';
import {runTimeCheck} from './time-check';
import {runUsageCheck} from './usage-check';
import {runSetupEnv} from './setup-env-command';
import {runSignal} from './signal';
import {runSweep} from './sweep';
import {runUpdate} from './update';
import {worktreeNew} from './worktree-new';

/**
 * The v170 tier flags (--lint/--js/--native) were removed with the tier system
 * (home-base-j2n7) but are still ACCEPTED as hidden no-ops for one release:
 * `.strict()` would otherwise hard-fail any caller that predates the removal
 * (an old post-checkout preamble, a stale alias) instead of just hydrating.
 */
const DEPRECATED_TIER_FLAGS = ['lint', 'js', 'native'] as const;

function applyDeprecatedTierFlags<T>(y: import('yargs').Argv<T>) {
  let out = y;
  for (const flag of DEPRECATED_TIER_FLAGS) {
    out = out.option(flag, {type: 'boolean', hidden: true});
  }
  return out;
}

function warnDeprecatedTierFlags(argv: Record<string, unknown>): void {
  const passed = DEPRECATED_TIER_FLAGS.filter((f) => argv[f] === true);
  if (passed.length > 0) {
    console.error(
      `Warning: ${passed.map((f) => `--${f}`).join(' ')} ignored — the tier system was removed (home-base-j2n7); setup-env runs all setup-env:<LABEL> scripts.`,
    );
  }
}

// Handled before yargs: `--skill` is a bare flag, and `demandCommand(1)` would
// reject it. Mirrors the `tt --skill` convention.
if (hideBin(process.argv).includes('--skill')) {
  process.exit(runSkill());
}

const ARGV = hideBin(process.argv);

/**
 * `ralph` is the old name for `justin-loop` (home-base-1r6d.33, D1). Kept for
 * ONE release as a hidden alias.
 *
 * Rewritten into `justin-loop` here, before yargs ever sees it, rather than
 * registered as a second command: an alias that shares no code cannot drift from
 * the real command, and `justin-sdk --help` never learns the dead name. Every
 * flag, including `--help`, is then handled by `justin-loop` itself.
 */
if (ARGV[0] === 'ralph') {
  console.error(
    'ralph is now justin-loop; the ralph name goes away in the next release',
  );
  ARGV[0] = 'justin-loop';
}

void yargs(ARGV)
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
  // A command GROUP, not a bare command: `config get`/`config set` are the
  // obvious next members (home-base-uxwc D9). Bare `config` prints its own help
  // via demandCommand rather than guessing which subcommand was meant.
  .command(
    'config',
    'Inspect the justin-sdk config files — the committed per-repo justin-sdk.config.json and the user-level ~/.config/justin-sdk/config.json.',
    (y) =>
      y
        .command(
          'schema',
          'Print every key of both config files with its type, resolved default and description. Derived from the schemas themselves, so it cannot drift from what is actually accepted.',
          (yy) =>
            yy.option('json', {
              type: 'boolean',
              describe:
                'Print JSON Schema for both files as {project, user} instead of the human-readable tree.',
              default: false,
            }),
          (argv) => {
            if (argv.json) {
              console.log(JSON.stringify(configSchemaJson(), null, 2));
            } else {
              console.log(renderConfigSchema({projectRoot: process.cwd()}));
            }
            process.exit(0);
          },
        )
        .demandCommand(1, 'Please specify a config subcommand'),
    () => {},
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
  // justin-loop (home-base-1r6d.33): a session chain whose control channel IS a
  // committed handoff bead. Running the command with no subcommand RUNS the
  // loop; `handoff` and `handoff validate` are what a session inside the loop
  // calls. Print mode is gone: there is no `--mode`, no `--verdict-path` and no
  // `--json-schema` verdict any more, because the bead is the only channel (D2).
  .command(
    'justin-loop',
    'Run a chain of Claude Code sessions on one arc: each session hands its work to the next through a committed handoff bead, which is also what tells the runner whether to spawn a successor at all.',
    (y) =>
      y
        .command(
          'handoff',
          'Write this session’s handoff bead: what happened, and the successor’s starting instructions. Refuses a second open handoff from the same session. Prints the new bead id — and nothing else — on stdout.',
          (yy) =>
            yy
              // Subcommand FIRST so `handoff validate …` never falls through to
              // the creator. The creator's own options are deliberately declared
              // WITHOUT `demandOption`: options on a parent command apply to its
              // subcommands too, so a demanded --from would make `handoff
              // validate` unusable. parseCreateFlags does the demanding instead.
              .command(
                'validate [id]',
                'Re-check a handoff bead against the schema. With no id, checks every OPEN handoff bead. Exit 0 all valid (or none exist), 1 any invalid, 2 br unavailable.',
                (y3) =>
                  y3.positional('id', {
                    type: 'string',
                    describe:
                      'One bead to check, closed ones included. Omit to check every open handoff bead.',
                  }),
                (argv) => {
                  process.exit(
                    emit(
                      renderValidate(
                        validateHandoffs(process.cwd(), argv.id ?? null),
                      ),
                    ),
                  );
                },
              )
              .option('from', {
                type: 'string',
                describe:
                  'The session label the runner gave this session. Identity: only one OPEN handoff may exist per label.',
              })
              .option('disposition', {
                type: 'string',
                choices: DISPOSITIONS,
                describe:
                  'continue = boot a successor from --next; done = the arc is finished, stop; blocked = only Justin can answer --open-question, stop.',
              })
              .option('arc', {
                type: 'string',
                describe: 'Epic/bead id or short name for this arc of work.',
              })
              .option('worktree', {
                type: 'string',
                describe:
                  'ABSOLUTE path to the worktree the successor must work in.',
              })
              .option('branch', {
                type: 'string',
                describe: 'Branch to work on.',
              })
              .option('state', {
                type: 'string',
                describe: '2–4 sentences: where things stand right now.',
              })
              .option('next', {
                type: 'string',
                describe:
                  'The successor’s FULL starting instructions — this text becomes its prompt verbatim. Required for every disposition; for done/blocked it is what a future session would need to know.',
              })
              .option('open-question', {
                type: 'string',
                array: true,
                describe:
                  'A question only Justin can answer. Repeatable. Use --open-question=… so a value starting with "-" survives.',
              })
              .option('context-tokens', {
                type: 'number',
                describe:
                  'Context tokens from the latest usage notice. Omit when unknown — it is recorded as null, never as 0.',
              }),
          (argv) => {
            const flags = parseCreateFlags({
              arc: argv.arc,
              branch: argv.branch,
              contextTokens: argv['context-tokens'],
              disposition: argv.disposition,
              from: argv.from,
              next: argv.next,
              openQuestions: argv['open-question'],
              state: argv.state,
              worktree: argv.worktree,
            });
            if (!flags.ok) {
              for (const err of flags.errors) console.error(err);
              console.error(
                'No handoff bead was created. See `justin-sdk justin-loop handoff --help`.',
              );
              process.exit(1);
            }
            process.exit(
              emit(renderCreate(createHandoff(process.cwd(), flags.input))),
            );
          },
        )
        .option('prompt', {
          type: 'string',
          describe:
            'Prompt for the FIRST session (a slash command works). Giving one explicitly makes this run an ASK: the start-of-run handoff scan still reports what is waiting, but does not put it in front of your prompt. Pass --pickup to start from the newest handoff anyway. Every LATER session is prompted with its predecessor’s handoff bead instead, never with this.',
          defaultDescription: LOOP_DEFAULTS.prompt,
        })
        .option('pickup', {
          type: 'boolean',
          describe:
            'Start from the newest waiting handoff bead even though --prompt was given explicitly. Without --prompt this is already the behaviour.',
          default: LOOP_DEFAULTS.pickup,
        })
        .option('label', {
          type: 'string',
          describe:
            'Slug for this run’s session labels: <label>-1, <label>-2, … Normalised to [a-z0-9-] so it is safe unquoted in the --from the session contract writes. Omit to derive one from the prompt.',
          defaultDescription: 'derived from the prompt',
        })
        .option('max-sessions', {
          type: 'number',
          describe:
            'Chain length: how many sessions this run may spawn in total',
          default: LOOP_DEFAULTS.maxSessions,
        })
        .option('max-iterations', {
          type: 'number',
          hidden: true,
          describe:
            'Deprecated alias for --max-sessions. Goes away in the next release.',
        })
        .option('timeout-min', {
          type: 'number',
          describe:
            'Per-session wall-clock timeout in minutes. 0 (the default) is NONE: a session is bounded by the ~300k wrap-up notice, not by the clock. When set, an expired session is stopped and CONFIRMED gone, and its handoff beads are then read exactly like any other ending — a valid handoff written before it hung is honoured rather than thrown away.',
          default: LOOP_DEFAULTS.timeoutMin,
        })
        .option('handoff-retries', {
          type: 'number',
          describe:
            'How many times a session that ended without a valid handoff bead is RESUMED and told to write one before the run gives up, files a bug bead and exits 2. 0 disables the demand and just stops the run.',
          default: LOOP_DEFAULTS.handoffRetries,
        })
        .check((argv) => {
          const retries = argv['handoff-retries'];
          // Negative is not "unlimited" and not "none" — it is a number nobody
          // meant. Refuse rather than silently rounding it to one of them.
          if (!(retries >= 0)) {
            throw new Error('--handoff-retries must be 0 or greater');
          }
          return true;
        })
        // No default, and none wanted (home-base-1r6d.26, D3): omitted means a
        // blocked session waits for you indefinitely. Passing a number is how
        // you opt into a bound for an UNATTENDED run.
        .option('blocked-wait-min', {
          type: 'number',
          describe:
            'Bound how long a blocked session waits for your answer before it is stopped. Omitted (the default) waits indefinitely — blocked means waiting for you, and the runner does not decide you took too long.',
          defaultDescription: 'wait indefinitely',
        })
        .check((argv) => {
          const wait = argv['blocked-wait-min'];
          // 0 or a negative bound is not "no bound" — it is a value that would
          // silently stop every blocked session on the first poll. Refuse it
          // rather than guessing which the user meant.
          if (wait !== undefined && !(wait > 0)) {
            throw new Error(
              '--blocked-wait-min must be greater than 0 (omit it to wait indefinitely)',
            );
          }
          return true;
        })
        .option('poll-sec', {
          type: 'number',
          describe: 'Seconds between `claude agents --json` polls',
          default: LOOP_DEFAULTS.pollSec,
        })
        .option('stop-poll-sec', {
          type: 'number',
          describe:
            'Seconds between polls while CONFIRMING a stopped session has left `claude agents`',
          default: LOOP_DEFAULTS.stopPollSec,
        })
        .option('usage-gate', {
          type: 'boolean',
          describe:
            'Read your real /usage quota before every session and refuse to run when it cannot be read. Pass --no-usage-gate to skip the gate entirely — no /usage call is made and quota is reported as UNKNOWN, never 0%. Use it only when the spend is bounded up front (e.g. --max-sessions 1), not for long chains.',
          default: LOOP_DEFAULTS.usageGate,
        })
        .option('session-stop-pct', {
          type: 'number',
          describe:
            'Pause/exit when the 5-hour session window reaches this percent',
          default: LOOP_DEFAULTS.sessionStopPct,
        })
        .option('weekly-stop-pct', {
          type: 'number',
          describe: 'Pause/exit when the weekly window reaches this percent',
          default: LOOP_DEFAULTS.weeklyStopPct,
        })
        .option('on-gate-hit', {
          type: 'string',
          choices: ['pause', 'exit'] as const,
          describe: 'Wait for quota to reset, or stop the run',
          default: LOOP_DEFAULTS.onGateHit,
        })
        .option('gate-poll-min', {
          type: 'number',
          describe: 'Minutes between (free) quota re-checks while paused',
          default: LOOP_DEFAULTS.gatePollMin,
        })
        .option('model', {
          type: 'string',
          describe: 'Model for each session',
          default: LOOP_DEFAULTS.model,
        })
        .option('permission-mode', {
          type: 'string',
          describe: 'Permission mode for each session',
          default: LOOP_DEFAULTS.permissionMode,
        })
        .option('no-progress-abort', {
          type: 'number',
          describe:
            'Abort after this many consecutive sessions with no new commit',
          default: LOOP_DEFAULTS.noProgressAbort,
        })
        .option('state-dir', {
          type: 'string',
          describe:
            'Where runs.jsonl is appended. Outside git on purpose — the facts you read live in the committed handoff beads.',
          default: LOOP_DEFAULTS.stateDir,
          defaultDescription: '~/.local/state/justin-sdk/justin-loop',
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Show quota + what is waiting, and exit without spawning',
          default: false,
        }),
    async (argv) => {
      if (argv['max-iterations'] !== undefined) {
        console.error(
          '--max-iterations is now --max-sessions; the old name goes away in the next release',
        );
      }
      const exitCode = await runJustinLoop(process.cwd(), {
        blockedWaitMin: argv['blocked-wait-min'] ?? null,
        dryRun: argv['dry-run'],
        gatePollMin: argv['gate-poll-min'],
        handoffRetries: argv['handoff-retries'],
        label: argv.label ?? null,
        maxSessions: argv['max-iterations'] ?? argv['max-sessions'],
        model: argv.model,
        noProgressAbort: argv['no-progress-abort'],
        onGateHit: argv['on-gate-hit'] as 'pause' | 'exit',
        permissionMode: argv['permission-mode'],
        pickup: argv.pickup,
        pollSec: argv['poll-sec'],
        // The command line is the ONLY place this is knowable: with a yargs
        // `default` on --prompt, an explicit `--prompt /loop-session` and no
        // flag at all produce identical argv (home-base-1r6d.26, D6).
        prompt: argv.prompt ?? LOOP_DEFAULTS.prompt,
        promptExplicit: argv.prompt !== undefined,
        sessionStopPct: argv['session-stop-pct'],
        stateDir: argv['state-dir'],
        stopPollSec: argv['stop-poll-sec'],
        timeoutMin: argv['timeout-min'],
        // yargs boolean-negation: `--no-usage-gate` sets `usage-gate` false.
        // Declaring the option positively is load-bearing — an option literally
        // NAMED `no-usage-gate` would be negated into `usage-gate: false` while
        // `no-usage-gate` kept its own default, so passing the flag would
        // silently do nothing (measured on yargs 18).
        usageGate: argv['usage-gate'],
        weeklyStopPct: argv['weekly-stop-pct'],
      });
      process.exit(exitCode);
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
    ['skill', 'agent'],
    'Print the guide to justin-sdk: install/upgrade, how it runs, the component table and command list (both derived, so they cannot go stale)',
    (y) => y,
    () => {
      process.exit(runSkill());
    },
  )
  .command(
    'time-check',
    'UserPromptSubmit hook: stamp the wall-clock into the transcript after a long gap or on a new working day (reads stdin, prints nothing when not due)',
    (y) => y,
    () => {
      // Always exits 0: a failing UserPromptSubmit hook can block the prompt.
      process.exit(runTimeCheck({}));
    },
  )
  .command(
    'usage-check',
    'UserPromptSubmit + PostToolBatch hook: tell the session how many tokens of its OWN CONTEXT it has used (NOT subscription quota), once per setpoint — by default every 100k tokens. When the payload carries an agent_id the number measured is the SUBAGENT\'s own, read from its own transcript, and componentConfig["usage-check"].roles.player overrides the budget for it. The wrap-up directive is opt-in and OFF unless a wrapUpAt names a token count (reads stdin, prints nothing when not due; a subagent whose transcript cannot be found prints UNKNOWN to stderr and measures nothing)',
    (y) => y,
    () => {
      // Always exits 0: a failing UserPromptSubmit hook can block the prompt.
      process.exit(runUsageCheck());
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
    'rules-update',
    'Regenerate this repo’s COMMITTED rules artifact (.claude/rules/justin-sdk/critical-rules.md) from the managed prompts clone and commit it on the CURRENT branch. Commits nothing but that folder — dirt elsewhere is never staged. Refuses (without writing) on a detached HEAD, a merge/rebase/cherry-pick in progress, a repo not enrolled in critical-rules, or a prompts clone it could not refresh. No merge, no push, no branch switching.',
    (y) =>
      y
        .option('force', {
          type: 'boolean',
          default: false,
          describe:
            'Regenerate even when the content hash says the artifact is current (use when the file was edited by hand)',
        })
        .option('quiet', {
          type: 'boolean',
          default: false,
          describe: 'Suppress non-error output',
        }),
    (argv) => {
      process.exit(runRulesUpdate({force: argv.force, quiet: argv.quiet}));
    },
  )
  .command(
    'rules-diff',
    'What am I missing? Print a unified diff between this repo’s committed rules artifact (what this session loaded at launch) and the freshly assembled canonical content, so new guidance can be read and acted on without restarting. Read-only. Exit 0 = in sync (said explicitly), 1 = a diff was printed, 2 = could not check (never reported as in sync).',
    (y) => y,
    () => {
      process.exit(runRulesDiff());
    },
  )
  .command(
    'beads-rebuild-dryrun',
    'Pre-flight for migrating a beads workspace by deleting .beads/beads.db and rebuilding it from .beads/issues.jsonl: performs that destructive rebuild on a throwaway COPY of .beads/ and reports exactly what it would lose. The live workspace is only ever read. Exit 0 = compared, nothing would be lost (safe), 1 = content would be DESTROYED (not safe), 2 = the check could not run (never an all-clear).',
    (y) =>
      y
        .option('beads', {
          type: 'string',
          describe: 'The beads workspace to check (default: .beads)',
        })
        .option('br', {
          type: 'string',
          describe:
            'The `br` binary to rebuild WITH — i.e. the one that will perform the real migration (default: br from PATH). Pass a full path when `br` is a version-manager shim: the rebuild runs in a temp directory, where a shim may resolve to nothing.',
        })
        .option('keep', {
          type: 'boolean',
          default: false,
          describe:
            'Leave the temp working copy behind for inspection instead of removing it',
        }),
    (argv) => {
      process.exit(
        runBeadsRebuildDryRun({
          beadsDir: argv.beads,
          brBin: argv.br,
          keep: argv.keep,
        }),
      );
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
    ['setup-env', 'worktree-setup'],
    'Hydrate this checkout (worktree, clone, or primary): mise trust, init submodules, install deps, copy the .worktreeinclude files from the primary checkout, run setup-env:<LABEL> scripts. Remote (CLAUDE_CODE_REMOTE=true) additionally bootstraps mise + PATH and runs doctor --fix --yes. Report goes to stderr; stdout stays empty. (`worktree-setup` is the deprecated pre-j2n7 name.)',
    (y) =>
      applyDeprecatedTierFlags(
        y
          .option('target', {
            type: 'string',
            describe:
              'Directory to hydrate (default: cwd). Lets you run this from the primary checkout, where the SDK is already installed.',
          })
          .option('dry-run', {
            type: 'boolean',
            describe: 'Print what would happen and change nothing',
            default: false,
          }),
      ),
    async (argv) => {
      warnDeprecatedTierFlags(argv);
      const exitCode = await runSetupEnv({
        dryRun: argv['dry-run'],
        target: argv.target,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'sweep',
    'Fleet propagation: for every repo under --root with a justin-sdk.config.json, update the SDK in a fresh worktree (j update), gate on the repo’s own signal + doctor AS A RATCHET (each measured before and after the payload — only green→red fails, a repo that was already red proceeds with a loud note), then merge --ff-only into the default branch and push. Green = fully automatic; red = worktree AND branch removed, the failing step + output tail written to ~/Dev/home-base/tmp/sdk-sweep/<run>.log, non-zero exit. Repos that could not be swept at all are counted and named last, and also exit non-zero. Deterministic by contract (home-base-j2n7): failures get fixed in the SDK, never papered over here.',
    (y) =>
      y
        .option('dry-run', {
          type: 'boolean',
          describe: 'List discovered repos and planned actions; change nothing',
          default: false,
        })
        .option('repo', {
          type: 'string',
          array: true,
          describe:
            'Explicit repo path(s) — overrides discovery entirely (use for a single-repo run or for repos outside --root, e.g. a Dropbox-remote repo)',
        })
        .option('root', {
          type: 'string',
          describe: 'Discovery root (default ~/Dev)',
        })
        .option('component', {
          type: 'string',
          choices: [...COMPONENT_NAMES],
          describe:
            'Scope the payload to ONE component and leave the SDK pin alone: no pin bump, no `update`, no other component re-applied — so a rules/config edit does not ship an SDK upgrade to the whole fleet. Repos not enrolled in the component are skipped. Same gates either way. Unknown name refuses the whole run.',
        }),
    async (argv) => {
      process.exit(
        await runSweep({
          component: argv.component,
          dryRun: argv['dry-run'],
          repos: argv.repo,
          root: argv.root,
        }),
      );
    },
  )
  .command(
    'worktree-new <slug>',
    'Create a worktree the way Claude Code does — .claude/worktrees/<slug> on branch worktree-<slug> — then hydrate it. Prints exactly one stdout line, the absolute worktree path, for the `wt` shell function to cd into.',
    (y) =>
      applyDeprecatedTierFlags(
        y
          .positional('slug', {
            type: 'string',
            describe:
              'Names both the directory and the branch. [A-Za-z0-9._-] only — no slashes.',
          })
          .option('setup', {
            type: 'boolean',
            describe:
              'Hydrate after creating (default). Pass --no-setup to create only.',
            default: true,
          }),
      ),
    (argv) => {
      warnDeprecatedTierFlags(argv);
      const result = worktreeNew({
        noSetup: !argv.setup,
        slug: argv.slug as string,
      });
      process.exit(result.exitCode);
    },
  )
  .command(repoStatusCommand)
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
