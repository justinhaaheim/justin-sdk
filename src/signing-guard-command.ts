/**
 * The `signing-guard` yargs command (home-base-di8c7.1).
 *
 * Registered from cli-main.ts by reference. The handler `await import`s
 * signing-guard.ts, so nothing new lands on the eager path the per-prompt hooks
 * pay for.
 *
 * THE COMMAND AFTER `--` IS READ FROM THE RAW ARGUMENTS, NOT FROM YARGS. yargs
 * turns numeric-looking words after `--` into numbers even with
 * `populate--` (measured 2026-11-21 on yargs 18: `-- printf 0x10` reached the
 * handler as `16`), and a guard must not rewrite the command it guards.
 *
 * Tests build this command with fake effects (makeSigningGuardCommand). The
 * real CLI has no environment variable or file that swaps in a fake reader: a
 * seam like that, set by accident, would turn the guard off without saying so.
 */

import type {SigningGuardCliDeps} from './signing-guard';
import type {Argv, CommandModule} from 'yargs';

import {hideBin} from 'yargs/helpers';

import {helpHeader, helpWrapWidth} from './sdk-identity';

const HEADER = helpHeader('justin-sdk', import.meta.dirname);
const WRAP = helpWrapWidth(HEADER, Math.min(80, process.stdout.columns ?? 80));

const DEFAULT_MAX_WAIT_MINUTES = 30;

const NARRATIVE = `
Waits for an unlocked screen before a signing build. A build that updates
signing (xcodebuild -allowProvisioningUpdates, expo run:ios, Xcode's own
build) and starts while the screen is locked makes Xcode delete its Apple
account (home-base-di8c7).

  justin-sdk signing-guard -- expo run:ios --device

When the screen is unlocked it prints nothing. When it is locked it waits,
checking every 5 s for up to --max-wait minutes, then runs the command or
stops. When the lock state cannot be read it stops.

THE OFF SWITCH  JUSTIN_SDK_SIGNING_GUARD=off proceeds without checking, and
          says so in one line.

EXIT  0    the screen is unlocked (or the guard is off); after -- <command>,
           the command's own exit code
      3    the screen is locked: --no-wait, or still locked after --max-wait
      4    the lock state could not be read
      127  the command could not be started
      128+N  the command ended on signal N
      1    a usage error`;

/** Everything after the first `--`, verbatim; null when there is no `--`. */
export function commandAfterDashes(
  rawArgv: readonly string[],
): string[] | null {
  const index = rawArgv.indexOf('--');
  return index < 0 ? null : rawArgv.slice(index + 1);
}

export interface SigningGuardCommandDeps {
  /** Partial: anything missing is the real effect. */
  cli: Partial<SigningGuardCliDeps>;
  exit: (code: number) => void;
  rawArgv: () => readonly string[];
}

/** Why these arguments are not a request, or null when they are one. */
function usageProblem(
  argv: {command?: unknown; 'max-wait'?: unknown},
  rawArgv: readonly string[],
): string | null {
  const positional = Array.isArray(argv.command) ? argv.command : [];
  if (positional.length > 0) {
    return 'Put the command after --: justin-sdk signing-guard -- <command> [args...]';
  }
  const dashed = commandAfterDashes(rawArgv);
  if (dashed?.length === 0) {
    return 'Nothing to run after --. Give a command, or leave out the --.';
  }
  const maxWait = argv['max-wait'];
  if (
    typeof maxWait !== 'number' ||
    !Number.isFinite(maxWait) ||
    maxWait <= 0
  ) {
    return `--max-wait takes a number of minutes above 0, not ${String(maxWait)}.`;
  }
  return null;
}

export function makeSigningGuardCommand(
  overrides: Partial<SigningGuardCommandDeps> = {},
): CommandModule {
  const rawArgv = overrides.rawArgv ?? (() => hideBin(process.argv));
  const exit =
    overrides.exit ??
    ((code: number) => {
      process.exit(code);
    });
  return {
    builder: (y: Argv) =>
      y
        .wrap(WRAP)
        .usage(
          `${HEADER}\n\n$0 signing-guard [--no-wait] [--max-wait <minutes>] [--status] [-- <command> [args...]]`,
        )
        .epilogue(NARRATIVE)
        .positional('command', {
          array: true,
          describe: 'The command to run once the screen is unlocked, after --',
          type: 'string',
        })
        .option('wait', {
          default: true,
          describe:
            '--no-wait stops at once (exit 3) when the screen is locked, instead of waiting for the unlock.',
          type: 'boolean',
        })
        .option('max-wait', {
          default: DEFAULT_MAX_WAIT_MINUTES,
          describe:
            'How many minutes to wait for the unlock before stopping (exit 3).',
          type: 'number',
        })
        .option('status', {
          default: false,
          describe:
            'Print the lock state (unlocked, locked or unknown, with the reason) and exit 0, 3 or 4, without waiting or running anything.',
          type: 'boolean',
        })
        .check((argv) => usageProblem(argv, rawArgv()) ?? true),
    command: 'signing-guard [command..]',
    describe:
      'Wait for an unlocked screen before a signing build, then run the command after -- (home-base-di8c7). A signing build that starts while the screen is locked makes Xcode delete its Apple account. Exit 3 when locked, 4 when the lock state cannot be read; JUSTIN_SDK_SIGNING_GUARD=off turns it off.',
    handler: async (argv) => {
      const {realSigningGuardCliDeps, runSigningGuardCli} = await import(
        './signing-guard'
      );
      const code = runSigningGuardCli(
        {
          command: commandAfterDashes(rawArgv()),
          maxWaitMinutes: argv['max-wait'] as number,
          status: argv.status === true,
          wait: argv.wait !== false,
        },
        {...realSigningGuardCliDeps(), ...overrides.cli},
      );
      exit(code);
    },
  };
}

export const signingGuardCommand: CommandModule = makeSigningGuardCommand();
