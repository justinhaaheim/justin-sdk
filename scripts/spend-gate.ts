/**
 * SPEND GATE for the scripts that start REAL Claude Code sessions.
 *
 * `probe-bg-env`, `probe-capture-entrypoint`, `probe-capture-live` and
 * `e2e-justin-loop` each spawn real `claude -p` / `claude --bg` sessions on
 * Justin's account. None of them is run by `bun test`, a hook, a chore or CI;
 * they are measurement tools a session runs by hand. Until 2026-09-25 the only
 * thing between an agent typing `bun run probe:bg-env` to "see what it does"
 * and a real session was `--help` — so an exploratory run spent tokens.
 *
 * Justin, 2026-09-25: "Those two scripts need to be VERY carefully gated if
 * they are using actual claude code tokens." Every such script now refuses to
 * run without the explicit `--spend-real-tokens` flag, the same shape as
 * repo-status's `--experimental-acknowledge-data-loss-risk`: typing the flag
 * out IS the acknowledgment, and there is no config or env var that sets it.
 *
 * `--help` never needs the flag, and neither does any mode a script declares
 * spends nothing (e2e's `--replay`).
 */

export const SPEND_FLAG = '--spend-real-tokens';

export type SpendConsent =
  | {argv: string[]; ok: true}
  | {message: string; ok: false};

export interface SpendGateOptions {
  /** A mode that spawns no session (e.g. a replay) and so needs no consent. */
  exempt?: (argv: readonly string[]) => boolean;
  /** Script name, as the user would run it. */
  script: string;
  /** What one run spends, in plain words: "two short haiku turns". */
  spends: string;
}

/**
 * Decide whether this invocation may run. On success the flag is removed from
 * `argv`, so the script's own parser (which rejects unknown flags) never sees
 * it.
 */
export function checkSpendConsent(
  argv: readonly string[],
  options: SpendGateOptions,
): SpendConsent {
  const rest = argv.filter((arg) => arg !== SPEND_FLAG);
  if (argv.includes('--help') || argv.includes('-h')) {
    return {argv: rest, ok: true};
  }
  if (options.exempt?.(rest) === true) return {argv: rest, ok: true};
  if (argv.includes(SPEND_FLAG)) return {argv: rest, ok: true};
  return {
    message:
      `${options.script} starts REAL Claude Code sessions on your account and spends tokens: ${options.spends}.\n` +
      `Nothing was run. To run it, add ${SPEND_FLAG}. ${options.script} --help describes it without running anything.\n`,
    ok: false,
  };
}

/** `checkSpendConsent`, exiting 2 with the message when consent is missing. */
export function gateSpend(
  argv: readonly string[],
  options: SpendGateOptions,
): string[] {
  const consent = checkSpendConsent(argv, options);
  if (!consent.ok) {
    process.stderr.write(consent.message);
    process.exit(2);
  }
  return consent.argv;
}
