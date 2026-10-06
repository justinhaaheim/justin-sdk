/**
 * Which `claude` binary the SDK spawns.
 *
 * This lived in justin-loop/runner.ts until home-base-jptgj.1, when the
 * `/usage` reader moved into its own module (`claude-usage.ts`) and needed the
 * same resolution. Importing it from the runner would have made the two modules
 * import each other, so it moved here; the runner re-exports both names, so its
 * callers and tests are unchanged.
 */
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** The env var that overrides which `claude` every SDK call spawns. */
export const CLAUDE_BIN_ENV = 'JUSTIN_LOOP_CLAUDE_BIN';

/**
 * Which `claude` binary to spawn, resolved fresh on every call.
 *
 * MEASURED 2026-09-12: in a cmux pane a `cmux-cli-shim` named `claude` sits
 * ahead of the real CLI on PATH, and it turns `claude stop <id>` into a PROMPT
 * TO THE MODEL — chatty output saying "Stopped" while stopping nothing. A stop
 * ladder run against that shim would report success and leave the session alive,
 * which is precisely the reassuring substitution the successor gate exists to
 * refuse. So the real binary is resolved rather than inherited from PATH.
 *
 * The same resolution is what lets a launchd job find `claude` at all: launchd
 * hands an agent an EMPTY PATH, so only an absolute path works there
 * (home-base-jptgj D4).
 *
 * Order, and why:
 *   1. `JUSTIN_LOOP_CLAUDE_BIN` — the explicit override, FIRST so tests (and a
 *      machine with claude installed elsewhere) can point every call at one
 *      binary. An empty value is not a path and is ignored.
 *   2. `~/.local/bin/claude` — where the real CLI lives on this machine, ahead
 *      of PATH exactly because PATH is what the shim wins.
 *   3. `claude` — the bare name, i.e. a PATH lookup, which is the old behaviour
 *      and the only thing available on a machine that installs it elsewhere.
 */
export function resolveClaudeBin(): string {
  const override = process.env[CLAUDE_BIN_ENV];
  if (override != null && override !== '') return override;
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  return 'claude';
}
