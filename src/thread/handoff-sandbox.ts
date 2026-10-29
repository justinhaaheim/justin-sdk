/**
 * handoff-sandbox — can `thread handoff` run outside the Claude Code sandbox,
 * without waiting for the auto-mode classifier? (home-base-mbnjv.6; epic
 * home-base-mbnjv D4, C10)
 *
 * `thread handoff` opens the successor through the cmux socket, which the
 * sandbox blocks. So the command needs a GLOBAL `sandbox.excludedCommands`
 * entry in `~/.claude/settings.json`, and, because an excluded command still
 * goes through permissions, a `permissions.allow` rule: without one, auto mode
 * sends every handoff to the classifier (home-base-pp1vx.5). Justin pastes
 * both himself. THE SDK NEVER WRITES USER SETTINGS (see user-level-hook.ts);
 * doctor's HANDOFF_SANDBOX check reads them and prints the JSON to paste.
 *
 * READ-ONLY and zod-free: doctor imports this statically, and doctor sits on
 * cli-main's static import tree, which every hook loads
 * (tests/health-notices-cli.test.ts).
 *
 * THE MATCH. Both settings use Claude Code's Bash rule syntax (measured in
 * home-base-pp1vx.5, JOURNAL 2026-10-20): `*` matches any text, spaces
 * included; an entry with no `*` matches only that exact command. An entry
 * "covers" a required pattern when it matches every sample invocation of it
 * (SAMPLE_ARGUMENTS put in place of the `*`), so a broader entry such as
 * `./node_modules/.bin/justin-sdk *` counts. The legacy `X:*` suffix is read narrowly, as
 * `X` alone or `X` then a space: a narrow reading can only make the check warn
 * more, never pass falsely (critical rule 7).
 */

import {existsSync, readFileSync} from 'fs';

import {SDK_HANDOFF_CALL} from '../sdk-invocation';
import {USER_SETTINGS_DISPLAY, userSettingsPath} from '../user-level-hook';

type Env = Record<string, string | undefined>;

/**
 * The command the rule (templates/rules/handoff.md) tells sessions to run:
 * the SDK bin by path, never `bun run justin-sdk …` (sdk-invocation.ts
 * SDK_HANDOFF_CALL; epic home-base-mbnjv C12).
 */
export const HANDOFF_COMMAND = SDK_HANDOFF_CALL;

/** How messages name the command: with any arguments. */
export const HANDOFF_COMMAND_DISPLAY = `${HANDOFF_COMMAND} …`;

/**
 * THE ONE CONSTANT: what `~/.claude/settings.json` must hold, and the JSON
 * doctor prints (epic home-base-mbnjv C12). PROVISIONAL (2026-10-29) until S1
 * passes live (home-base-mbnjv.10). `X *` matches X with arguments AND with
 * none (measured in home-base-mbnjv.9: "cmux ping *" matched a bare `cmux
 * ping`), so one entry covers the bare call too. The retracted entry "bun run
 * justin-sdk thread handoff *" never applied: Claude Code 2.1.312 does not
 * exclude a command whose first word is `bun`.
 */
export const HANDOFF_SANDBOX_SETTINGS = {
  permissions: {allow: [`Bash(${HANDOFF_COMMAND} *)`]},
  sandbox: {excludedCommands: [`${HANDOFF_COMMAND} *`]},
} as const;

/**
 * What a session puts in place of a pattern's `*`: the form the rule teaches,
 * and the same with --model. An entry must match each one to cover a pattern.
 */
export const SAMPLE_ARGUMENTS = [
  '--note "finish the migration"',
  '--note "finish the migration" --model haiku',
] as const;

/** Does one Bash rule pattern match one command? (Syntax: see the header.) */
export function bashPatternMatches(pattern: string, command: string): boolean {
  if (pattern.endsWith(':*')) {
    const base = pattern.slice(0, -2);
    return command === base || command.startsWith(`${base} `);
  }
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 's').test(command);
}

/** The sample commands a required pattern stands for. */
export function sampleInvocations(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  return SAMPLE_ARGUMENTS.map((args) => pattern.split('*').join(args));
}

/** Does `entry` match every sample invocation of `required`? */
export function entryCovers(entry: string, required: string): boolean {
  return sampleInvocations(required).every((command) =>
    bashPatternMatches(entry, command),
  );
}

/**
 * The command pattern inside a permissions rule: `Bash` and `Bash(*)` allow
 * every command; `Bash(x)` gives `x`; a rule for another tool gives null.
 */
export function bashRulePattern(rule: string): string | null {
  if (rule === 'Bash') return '*';
  const match = /^Bash\((.*)\)$/s.exec(rule);
  return match?.[1] ?? null;
}

/** Strings in an array; anything else is no entries at all. */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectAt(value: unknown, key: string): unknown {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** One required entry and the user's entry that covers it, or null. */
export interface Covered {
  by: string | null;
  required: string;
}

export type HandoffSandboxStatus =
  /** Settings read: each required entry is covered, or it is not. */
  | {
      allowRules: Covered[];
      exclusions: Covered[];
      fileExists: boolean;
      kind: 'read';
    }
  /** The file exists but could not be read or parsed: NOT the same as missing. */
  | {kind: 'cannot-check'; reason: string};

/**
 * Read `~/.claude/settings.json` and match it against HANDOFF_SANDBOX_SETTINGS.
 * A missing file is a measured answer (nothing is covered); a file that
 * cannot be read, is not JSON or is not a JSON object is `cannot-check`, never
 * "missing" (critical rule 7), as checkUserLevelSessionStart does.
 */
export function checkHandoffSandbox(
  env: Env = process.env,
): HandoffSandboxStatus {
  const required = HANDOFF_SANDBOX_SETTINGS;
  const path = userSettingsPath(env);
  if (!existsSync(path)) {
    return {
      allowRules: required.permissions.allow.map((rule) => ({
        by: null,
        required: rule,
      })),
      exclusions: required.sandbox.excludedCommands.map((entry) => ({
        by: null,
        required: entry,
      })),
      fileExists: false,
      kind: 'read',
    };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return {
      kind: 'cannot-check',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    settings == null ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  ) {
    return {kind: 'cannot-check', reason: 'it is not a JSON object'};
  }

  const excluded = stringsIn(
    objectAt(objectAt(settings, 'sandbox'), 'excludedCommands'),
  );
  const allowed = stringsIn(
    objectAt(objectAt(settings, 'permissions'), 'allow'),
  );

  return {
    allowRules: required.permissions.allow.map((rule) => {
      const want = bashRulePattern(rule) ?? rule;
      const by = allowed.find((candidate) => {
        const pattern = bashRulePattern(candidate);
        return pattern != null && entryCovers(pattern, want);
      });
      return {by: by ?? null, required: rule};
    }),
    exclusions: required.sandbox.excludedCommands.map((entry) => ({
      by: excluded.find((candidate) => entryCovers(candidate, entry)) ?? null,
      required: entry,
    })),
    fileExists: true,
    kind: 'read',
  };
}

/**
 * The JSON to paste: HANDOFF_SANDBOX_SETTINGS cut down to the entries that are
 * missing, so it never repeats what the file already has.
 */
export function missingSettingsJson(
  status: Extract<HandoffSandboxStatus, {kind: 'read'}>,
): string {
  const allow = status.allowRules
    .filter((item) => item.by == null)
    .map((item) => item.required);
  const excludedCommands = status.exclusions
    .filter((item) => item.by == null)
    .map((item) => item.required);
  return JSON.stringify(
    {
      ...(allow.length === 0 ? {} : {permissions: {allow}}),
      ...(excludedCommands.length === 0 ? {} : {sandbox: {excludedCommands}}),
    },
    null,
    2,
  );
}

/** What doctor tells Justin to do when an entry is missing. */
export function handoffSandboxAdvice(
  status: Extract<HandoffSandboxStatus, {kind: 'read'}>,
): string {
  return `Add this to ${USER_SETTINGS_DISPLAY} by hand (justin-sdk never writes it), merging each entry into the list already there:\n${missingSettingsJson(status)}`;
}

/** What doctor tells Justin when the file could not be read. */
export function handoffSandboxCannotCheckAdvice(): string {
  return `Read ${USER_SETTINGS_DISPLAY} by hand and confirm sandbox.excludedCommands holds ${HANDOFF_SANDBOX_SETTINGS.sandbox.excludedCommands.map((entry) => `\`${entry}\``).join(', ')} and permissions.allow holds ${HANDOFF_SANDBOX_SETTINGS.permissions.allow.map((rule) => `\`${rule}\``).join(', ')}`;
}
