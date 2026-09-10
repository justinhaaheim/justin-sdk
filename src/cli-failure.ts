/**
 * What the CLI does when a command fails (home-base-uxwc.5 F1).
 *
 * THE HAZARD. yargs 18 routes a THROWING SYNC HANDLER through `usage.fail` as
 * soon as ANY middleware is async — and the health-notice middleware (D7) is,
 * for every command. The default failure output writes a bare newline to
 * STDOUT: measured 2026-09-10 on this branch, an uncaught handler exception
 * produced 0 bytes of stdout before the middleware landed and 1 byte after.
 * `worktree-new` prints exactly one stdout line for the `wt` shell function to
 * `cd` into, and `justin-loop handoff` prints a bead id its runner parses — a
 * stray "\n" on stdout is not cosmetic there (invariant 1 in health-notices.ts:
 * nothing about a notice may change what a command does).
 *
 * So the CLI handles its own failures: everything a human reads goes to STDERR,
 * stdout stays byte-empty, and the exit code stays 1 — which is exactly what an
 * uncaught handler exception did before the middleware existed (same A/B).
 *
 * WHY THIS IS NOT INSIDE cli.ts: cli.ts builds and runs its yargs chain at
 * module scope, so a test that imported it would run the CLI. Behaviour this
 * load-bearing has to be importable to be tested against a real yargs instance.
 */

/** The one thing this needs from a yargs instance. */
export interface CliHelpPrinter {
  showHelp: (consoleLevel: string) => void;
}

/**
 * yargs' `.fail` handler for the whole CLI. Never returns — it exits 1.
 *
 * TWO ARRIVALS, one exit. `error` is an exception a handler (or a middleware
 * yargs did not swallow) threw: the STACK is printed, because an exception
 * nobody planned for is a bug report and the line number is the value in it.
 * `message` is a usage error — unknown command, missing positional, a `choices`
 * violation — where the help is the useful part; `showHelp('error')` is yargs'
 * own name for "print it to stderr".
 */
export function reportCliFailure(
  message: string | null,
  error: Error | null | undefined,
  instance: CliHelpPrinter,
): never {
  if (error != null) {
    process.stderr.write(`${error.stack ?? String(error)}\n`);
  } else {
    instance.showHelp('error');
    if (message != null && message.length > 0) {
      process.stderr.write(`\n${message}\n`);
    }
  }
  process.exit(1);
}
