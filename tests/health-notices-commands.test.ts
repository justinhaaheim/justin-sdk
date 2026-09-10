/**
 * ANTI-DRIFT for the health-notice command classification (home-base-uxwc D1).
 *
 * The failure this exists to prevent is silent and one-directional: someone
 * adds a command to cli.ts, nobody thinks about notices, and it quietly lands
 * at tier 4 — every invocation. If that command is a hook, or prints machine-
 * read stdout, the notice corrupts a contract nobody was looking at.
 *
 * So the list of commands is not written down twice. It is DERIVED from the
 * CLI's own `--help` (the technique src/skill.ts uses for the same reason) and
 * compared with `ALL_COMMANDS`. A new command fails this test until someone
 * puts it in SELECT, in NEVER, or explicitly in ALL_COMMANDS as a tier-4
 * default. A REMOVED command fails it too, so the lists never rot.
 */

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {resolve} from 'path';

import {
  ALL_COMMANDS,
  callsiteTier,
  COMMAND_ALIASES,
  NEVER_COMMANDS,
  SELECT_COMMANDS,
} from '../src/health-notices';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

/**
 * Every top-level command name yargs advertises.
 *
 * Anchored on the `  justin-sdk <name>` prefix rather than on line shape: a
 * long usage string wraps onto a continuation line (`justin-sdk eas-update
 * <channel>` / `[changelog..]`) which this correctly ignores, and description
 * text is never indented that way.
 */
function commandNamesFromHelp(): string[] {
  const help = execFileSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const names = new Set<string>();
  for (const line of help.split('\n')) {
    const match = /^ {2}justin-sdk (\S+)/.exec(line);
    if (match?.[1] != null) names.add(match[1]);
  }
  return [...names].sort();
}

describe('command classification covers the real CLI', () => {
  test('--help yields commands at all (the parse itself is not silently empty)', () => {
    // Critical rule 6: an empty derived list would make every assertion below
    // vacuously true, which is exactly how an anti-drift test stops working.
    expect(commandNamesFromHelp().length).toBeGreaterThan(15);
  });

  test('every command the CLI registers is classified — and nothing stale is listed', () => {
    expect(commandNamesFromHelp()).toEqual([...ALL_COMMANDS].sort());
  });

  test('every classified command resolves to a tier, and only NEVER ones to null', () => {
    const silent: string[] = ALL_COMMANDS.filter(
      (name) => callsiteTier(name) == null,
    );
    // `justin-loop handoff` is a subcommand key, not a top-level command, so it
    // is not among the names ALL_COMMANDS can classify.
    const expected: string[] = NEVER_COMMANDS.filter(
      (name) => !name.includes(' '),
    );
    expect(silent.sort()).toEqual(expected.sort());
  });

  test('SELECT and NEVER name real commands, and never the same one twice', () => {
    const all = new Set<string>(ALL_COMMANDS);
    for (const name of SELECT_COMMANDS)
      expect([name, all.has(name)]).toEqual([name, true]);
    for (const name of NEVER_COMMANDS) {
      // `justin-loop handoff` is a subcommand key, not a top-level command.
      const top = name.split(' ')[0] ?? name;
      expect([name, all.has(top)]).toEqual([name, true]);
    }
    const overlap = SELECT_COMMANDS.filter((name) =>
      (NEVER_COMMANDS as readonly string[]).includes(name),
    );
    expect(overlap).toEqual([]);
  });

  test('every alias points at a command that exists', () => {
    const all = new Set<string>(ALL_COMMANDS);
    for (const [alias, primary] of Object.entries(COMMAND_ALIASES)) {
      expect([alias, all.has(primary)]).toEqual([alias, true]);
      expect([alias, all.has(alias)]).toEqual([alias, false]);
    }
  });

  test('the hooks and the upgrade commands are the ones that stay silent', () => {
    // Named explicitly, because this is the list whose breakage is dangerous
    // rather than merely noisy.
    for (const name of [
      'time-check',
      'usage-check',
      'prime',
      'update',
      'sweep',
    ]) {
      expect([name, callsiteTier(name)]).toEqual([name, null]);
    }
  });
});
