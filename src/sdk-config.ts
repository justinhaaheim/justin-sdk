/**
 * The justin-sdk config layer (home-base-uxwc D2 + D9).
 *
 * TWO files, one shape for the part they share:
 *
 *  - PROJECT: `<projectRoot>/justin-sdk.config.json`, committed, per-repo.
 *    Written by base-setup and the component installers.
 *  - USER: `$XDG_CONFIG_HOME/justin-sdk/config.json` (default
 *    `~/.config/justin-sdk/config.json`), not committed, applies everywhere.
 *    Justin's reason for it (2026-09-09): health-notice knobs are being felt
 *    out, and he does not want to tweak them repo by repo.
 *
 * Validation is LOOSE ON PURPOSE (`z.looseObject` everywhere): an unknown key
 * is always allowed, so a config written by a NEWER SDK never makes an older
 * one complain. A key that IS known but carries the wrong type is a violation,
 * because that one silently changes behaviour.
 *
 * This module deliberately imports nothing but node builtins and zod. The
 * installers (`setup-helpers`) drag in real machinery, and the hot-path hooks
 * (`time-check`, `usage-check`) must never pay for this import at all — they
 * keep their own hand-rolled readers.
 */

import {readFileSync} from 'fs';
import {join, resolve} from 'path';

import {z} from 'zod';

/** Environment as this module consumes it — `process.env` is assignable. */
export type EnvLike = Record<string, string | undefined>;

/** Name of the per-repo config file, at the project root. */
export const PROJECT_CONFIG_FILENAME = 'justin-sdk.config.json';

/** Env var that switches every health notice off for one invocation (D2). */
export const HEALTH_NOTICES_ENV_VAR = 'JUSTIN_SDK_HEALTH_NOTICES';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `$XDG_CONFIG_HOME`, or `$HOME/.config`. Mirrors `xdgConfigHome()` in
 * plugin/lib/prime.ts, which is where the managed prompts clone lives — the
 * user-level SDK config sits beside it under the same `justin-sdk/` directory.
 *
 * Read from an injected env rather than `process.env` directly so tests never
 * touch the real `~/.config`.
 */
export function xdgConfigHome(env: EnvLike = process.env): string {
  const fromEnv = env.XDG_CONFIG_HOME;
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  return resolve(env.HOME ?? '', '.config');
}

/** Absolute path to the user-level config file. */
export function userConfigPath(env: EnvLike = process.env): string {
  return join(xdgConfigHome(env), 'justin-sdk', 'config.json');
}

/** Absolute path to a project's config file. */
export function projectConfigPath(projectRoot: string): string {
  return resolve(projectRoot, PROJECT_CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The four notice tiers (D1). Kept as data so callers can enumerate them. */
export const PROMPT_TIERS = [1, 2, 3, 4] as const;

export type PromptTier = (typeof PROMPT_TIERS)[number];

const promptTierSchema = z
  .literal([...PROMPT_TIERS])
  .describe(
    'How loudly this notice may speak. 1 = never; 2 = only when doctor runs; 3 = doctor plus a short list of interactive commands; 4 = every command that is allowed to print a notice at all.',
  );

const sdkVersionKindSchema = z
  .looseObject({
    promptTier: promptTierSchema.optional(),
    throttleMinutes: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Minimum minutes between two notices about this kind of bump, per repo. 0 means never throttle.',
      ),
  })
  .describe('Tier and throttle for one kind of version bump.');

/**
 * The `healthNotices` block. IDENTICAL in both files — the user file sets the
 * baseline for every repo, the project file overrides it for one (D2).
 *
 * Every field is optional HERE and present in the RESOLVED type: absence means
 * "inherit", so a repo that names one knob keeps tracking the defaults for the
 * rest instead of freezing a copy of them.
 */
export const healthNoticesSchema = z
  .looseObject({
    doctor: z
      .looseObject({
        intervalMinutes: z
          .number()
          .positive()
          .optional()
          .describe(
            'Minimum minutes between two heartbeat doctor runs for one repo.',
          ),
        promptTier: promptTierSchema.optional(),
        showOnPass: z
          .boolean()
          .optional()
          .describe(
            'Print a one-line summary when the heartbeat run is all-green. Failures are always printed.',
          ),
      })
      .optional()
      .describe('The doctor heartbeat: doctor run on a cadence, on stderr.'),
    sdkVersion: z
      .looseObject({
        checkIntervalMinutes: z
          .number()
          .positive()
          .optional()
          .describe(
            'Minimum minutes between two remote checks for a newer justin-sdk tag. Throttles the NETWORK call, not the notice.',
          ),
        major: sdkVersionKindSchema.optional(),
        minor: sdkVersionKindSchema
          .optional()
          .describe(
            'The fleet is 0.x, so minor is the de-facto breaking tier (D2).',
          ),
        patch: sdkVersionKindSchema.optional(),
      })
      .optional()
      .describe('The "a newer justin-sdk is available" notice.'),
  })
  .describe(
    'Version-upgrade and doctor-heartbeat notices. Set in the user file for every repo; override per repo in the project file. Switched off entirely by JUSTIN_SDK_HEALTH_NOTICES=off, by CI, or by CLAUDE_CODE_REMOTE=true.',
  );

/**
 * `componentConfig` sections. Described as LOOSE OBJECTS on purpose: each
 * component still owns and parses its own block (see `UsageCheckConfig` in
 * usage-check.ts and `TimeCheckConfig` in time-check.ts). What is written here
 * is a documentation and typo surface, not a second parser — migrating those
 * readers to zod is explicitly out of scope (home-base-uxwc).
 */
const componentConfigSchema = z
  .looseObject({
    'critical-rules': z
      .looseObject({
        modules: z
          .array(z.string())
          .optional()
          .describe(
            'Rules modules selected for this repo, in the order they are assembled into .claude/rules/justin-sdk/critical-rules.md.',
          ),
      })
      .optional()
      .describe('critical-rules: which rules modules this repo carries.'),
    'time-check': z
      .looseObject({
        enabled: z.boolean().optional(),
        gapHours: z
          .number()
          .nullable()
          .optional()
          .describe(
            'Hours between messages that trigger a time stamp. null disables.',
          ),
        notifyOnNewDayBoundaryHour: z
          .number()
          .nullable()
          .optional()
          .describe(
            'Hour (0-23) at which a new working day starts. null disables the once-a-day stamp.',
          ),
      })
      .optional()
      .describe('time-check: the elapsed-time notice.'),
    'usage-check': z
      .looseObject({
        enabled: z.boolean().optional(),
        reArmDropFraction: z
          .number()
          .optional()
          .describe(
            'Fractional drop below the last announced setpoint that re-arms the ladder.',
          ),
        roles: z
          .looseObject({
            player: z
              .looseObject({
                reArmDropFraction: z.number().optional(),
                setpoints: z.array(z.number()).nullable().optional(),
                wrapUpAt: z.number().nullable().optional(),
              })
              .nullable()
              .optional()
              .describe(
                'Overrides for a dispatched subagent, whose budget differs from its conductor’s. An absent field inherits the top-level value.',
              ),
          })
          .nullable()
          .optional()
          .describe('Per-role overrides of the knobs above.'),
        setpoints: z
          .array(z.number())
          .nullable()
          .optional()
          .describe(
            'Ascending token thresholds; each announces once. null disables the ladder; absent takes the generated default.',
          ),
        wrapUpAt: z
          .number()
          .nullable()
          .optional()
          .describe(
            'Context size at or above which the notice adds the wrap-up directive. null (the default) never nags.',
          ),
      })
      .optional()
      .describe('usage-check: the context-size ladder and wrap-up directive.'),
  })
  .describe('Per-component settings, keyed by component name.');

/** Schema for `<projectRoot>/justin-sdk.config.json`. */
export const projectConfigSchema = z
  .looseObject({
    componentConfig: componentConfigSchema.optional(),
    components: z
      .array(z.string())
      .describe(
        'Installed components. Doctor derives which checks to run from this list, so a component missing here has no checks.',
      ),
    healthNotices: healthNoticesSchema.optional(),
    lastSynced: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}$/,
        'must be a YYYY-MM-DD date, e.g. "2026-09-10"',
      )
      .describe('Date this repo last ran a justin-sdk component installer.'),
    version: z
      .string()
      .describe(
        'The justin-sdk version that last wrote this file. Stamped by base-setup; not a pin.',
      ),
  })
  .describe('Per-repo justin-sdk config, committed at the project root.');

/** Schema for `$XDG_CONFIG_HOME/justin-sdk/config.json`. */
export const userConfigSchema = z
  .looseObject({
    healthNotices: healthNoticesSchema.optional(),
  })
  .describe(
    'User-level justin-sdk config: settings that should apply to every repo on this machine.',
  );

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type UserConfig = z.infer<typeof userConfigSchema>;
export type HealthNoticesFileConfig = z.infer<typeof healthNoticesSchema>;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * How a config file read turned out. FIVE outcomes, deliberately distinct
 * (critical rule 6): "it parsed", "there is no file", "the bytes are not JSON",
 * "the JSON does not match the schema" and "the file is there but could not be
 * read" are five different facts, and only two of them are boring. None of them
 * is ever represented as an empty config.
 */
export type ConfigReadOutcome<T> =
  | {config: T; path: string; status: 'ok'}
  | {error: string; path: string; status: 'invalid-json'}
  | {error: string; path: string; status: 'unreadable'}
  | {issues: string[]; path: string; status: 'schema-violation'}
  | {path: string; status: 'absent'};

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((segment) => String(segment)).join('.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The errno of a thrown fs error, when it has one. */
function errorCode(error: unknown): string | null {
  if (error == null || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as {code: unknown}).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Read and validate one config file. Never throws.
 *
 * The read is attempted directly and the ERRNO decides the outcome, rather than
 * asking `existsSync` first: `existsSync` answers false for every failure it
 * meets, so an unreadable directory (a Claude sandbox, a permissions problem)
 * would masquerade as "the user has no config". Only ENOENT is absence.
 */
function readConfigFile<T>(
  path: string,
  schema: z.ZodType<T>,
): ConfigReadOutcome<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {path, status: 'absent'};
    return {error: errorMessage(error), path, status: 'unreadable'};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {error: errorMessage(error), path, status: 'invalid-json'};
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      issues: result.error.issues.map(
        (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
      ),
      path,
      status: 'schema-violation',
    };
  }
  return {config: result.data, path, status: 'ok'};
}

/** Read `<projectRoot>/justin-sdk.config.json`. Never throws. */
export function readProjectConfig(
  projectRoot: string,
): ConfigReadOutcome<ProjectConfig> {
  return readConfigFile(projectConfigPath(projectRoot), projectConfigSchema);
}

/** Read `$XDG_CONFIG_HOME/justin-sdk/config.json`. Never throws. */
export function readUserConfig(
  env: EnvLike = process.env,
): ConfigReadOutcome<UserConfig> {
  return readConfigFile(userConfigPath(env), userConfigSchema);
}

/** True when the outcome is something a human should be told about. */
export function isConfigProblem(outcome: ConfigReadOutcome<unknown>): boolean {
  return outcome.status !== 'ok' && outcome.status !== 'absent';
}

/**
 * One human-readable line for an outcome, for doctor and the CLI. Problems
 * name the file and what is wrong with it; `absent` and `ok` say so plainly.
 */
export function describeConfigOutcome(
  outcome: ConfigReadOutcome<unknown>,
  options: {maxIssues?: number} = {},
): string {
  const maxIssues = options.maxIssues ?? 3;
  switch (outcome.status) {
    case 'absent':
      return `${outcome.path}: not present`;
    case 'invalid-json':
      return `${outcome.path}: not valid JSON (${outcome.error})`;
    case 'ok':
      return `${outcome.path}: valid`;
    case 'schema-violation': {
      const shown = outcome.issues.slice(0, maxIssues);
      const rest = outcome.issues.length - shown.length;
      return (
        `${outcome.path}: ${outcome.issues.length} schema violation${outcome.issues.length === 1 ? '' : 's'} — ` +
        shown.join('; ') +
        (rest > 0 ? ` (+${rest} more)` : '')
      );
    }
    case 'unreadable':
      return `${outcome.path}: could not be read (${outcome.error})`;
  }
}

// ---------------------------------------------------------------------------
// Resolved health-notices config
// ---------------------------------------------------------------------------

export interface SdkVersionKindConfig {
  promptTier: PromptTier;
  throttleMinutes: number;
}

export interface ResolvedHealthNoticesConfig {
  /**
   * False when the env says so (see resolveHealthNoticesConfig). Not a file
   * key: the kill switch is per-invocation, and per-notice silencing is what
   * `promptTier: 1` is for.
   */
  enabled: boolean;
  doctor: {
    intervalMinutes: number;
    promptTier: PromptTier;
    showOnPass: boolean;
  };
  sdkVersion: {
    checkIntervalMinutes: number;
    major: SdkVersionKindConfig;
    minor: SdkVersionKindConfig;
    patch: SdkVersionKindConfig;
  };
}

/** Justin's numbers, in MINUTES (home-base-uxwc D2). */
export const DEFAULT_HEALTH_NOTICES: ResolvedHealthNoticesConfig = {
  doctor: {intervalMinutes: 60, promptTier: 3, showOnPass: false},
  enabled: true,
  sdkVersion: {
    checkIntervalMinutes: 60,
    major: {promptTier: 4, throttleMinutes: 1440},
    minor: {promptTier: 3, throttleMinutes: 60},
    patch: {promptTier: 2, throttleMinutes: 60},
  },
};

function mergeKind(
  base: SdkVersionKindConfig,
  layer: {promptTier?: unknown; throttleMinutes?: unknown} | undefined,
): SdkVersionKindConfig {
  return {
    promptTier:
      (layer?.promptTier as PromptTier | undefined) ?? base.promptTier,
    throttleMinutes:
      (layer?.throttleMinutes as number | undefined) ?? base.throttleMinutes,
  };
}

/**
 * Apply one file's `healthNotices` block over a resolved config, FIELD BY
 * FIELD: a block that names only `minor.promptTier` leaves every other value
 * exactly as the layer beneath it had it.
 */
function mergeHealthNotices(
  base: ResolvedHealthNoticesConfig,
  layer: HealthNoticesFileConfig | null,
): ResolvedHealthNoticesConfig {
  if (layer == null) return base;
  const sdkVersion = layer.sdkVersion;
  const doctor = layer.doctor;
  return {
    doctor: {
      intervalMinutes: doctor?.intervalMinutes ?? base.doctor.intervalMinutes,
      promptTier: doctor?.promptTier ?? base.doctor.promptTier,
      showOnPass: doctor?.showOnPass ?? base.doctor.showOnPass,
    },
    enabled: base.enabled,
    sdkVersion: {
      checkIntervalMinutes:
        sdkVersion?.checkIntervalMinutes ??
        base.sdkVersion.checkIntervalMinutes,
      major: mergeKind(base.sdkVersion.major, sdkVersion?.major),
      minor: mergeKind(base.sdkVersion.minor, sdkVersion?.minor),
      patch: mergeKind(base.sdkVersion.patch, sdkVersion?.patch),
    },
  };
}

/**
 * A file contributes its block only when the whole file validated. A broken
 * file is NOT half-applied: half a config is a config nobody wrote.
 *
 * The breakage is not swallowed — the CONFIG_SCHEMA doctor check reports it by
 * name. This function's job is to keep a typo from silently changing behaviour,
 * not to report it.
 */
function layerFrom(
  outcome: ConfigReadOutcome<{healthNotices?: HealthNoticesFileConfig}>,
): HealthNoticesFileConfig | null {
  if (outcome.status !== 'ok') return null;
  return outcome.config.healthNotices ?? null;
}

/**
 * DEFAULTS ← user file ← project file, merged per field, then the env kill
 * switch (D2).
 *
 * Off in CI and in remote Claude Code sessions because both are non-interactive
 * and neither can act on the notice: the point is to nudge Justin at a
 * keyboard, not to spend a network call on a build agent.
 */
export function resolveHealthNoticesConfig(
  projectRoot: string,
  env: EnvLike = process.env,
): ResolvedHealthNoticesConfig {
  const withUser = mergeHealthNotices(
    DEFAULT_HEALTH_NOTICES,
    layerFrom(readUserConfig(env)),
  );
  const resolved = mergeHealthNotices(
    withUser,
    layerFrom(readProjectConfig(projectRoot)),
  );

  const ci = env.CI;
  const killed =
    env[HEALTH_NOTICES_ENV_VAR] === 'off' ||
    (ci != null && ci.length > 0) ||
    env.CLAUDE_CODE_REMOTE === 'true';

  return killed ? {...resolved, enabled: false} : resolved;
}

// ---------------------------------------------------------------------------
// `justin-sdk config schema`
// ---------------------------------------------------------------------------

/** The subset of JSON Schema the renderer walks. */
interface JsonSchemaNode {
  anyOf?: JsonSchemaNode[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  type?: string | string[];
}

/** JSON Schema for both config files, as one object. */
export function configSchemaJson(): {
  project: unknown;
  user: unknown;
} {
  return {
    project: z.toJSONSchema(projectConfigSchema),
    user: z.toJSONSchema(userConfigSchema),
  };
}

export interface SchemaKeyLine {
  /** JSON rendering of the resolved default, or null where there is none. */
  defaultValue: string | null;
  description: string | null;
  /** Dotted path, e.g. `healthNotices.sdkVersion.minor.promptTier`. */
  key: string;
  type: string;
}

/**
 * `z.nullable()` renders as `anyOf: [<the real schema>, {type: 'null'}]`, which
 * hides both the type AND the nested properties of whatever was wrapped. Peel
 * that one shape off so a nullable block is still documented key by key, and
 * carry the wrapper's description onto the branch (zod puts it there).
 */
function unwrapNullable(node: JsonSchemaNode): {
  node: JsonSchemaNode;
  nullable: boolean;
} {
  const branches = node.anyOf;
  if (branches == null || branches.length !== 2) return {node, nullable: false};
  const nullIndex = branches.findIndex((branch) => branch.type === 'null');
  if (nullIndex === -1) return {node, nullable: false};
  const other = branches[1 - nullIndex];
  if (other == null) return {node, nullable: false};
  return {
    node: {...other, description: node.description ?? other.description},
    nullable: true,
  };
}

function jsonSchemaType(node: JsonSchemaNode): string {
  const {node: inner, nullable} = unwrapNullable(node);
  const suffix = nullable ? '|null' : '';
  if (inner.enum != null) {
    return inner.enum.map((value) => JSON.stringify(value)).join('|') + suffix;
  }
  if (Array.isArray(inner.type)) return inner.type.join('|') + suffix;
  if (inner.type === 'array') {
    return (
      `${inner.items != null ? jsonSchemaType(inner.items) : 'unknown'}[]` +
      suffix
    );
  }
  return (inner.type ?? 'any') + suffix;
}

/** Drill into a defaults object by one key; null once the path runs out. */
function defaultAt(defaults: unknown, key: string): unknown {
  if (defaults == null || typeof defaults !== 'object') return null;
  const value = (defaults as Record<string, unknown>)[key];
  return value === undefined ? null : value;
}

/**
 * Flatten a JSON Schema into one line per key, DERIVED from the schema — never
 * a hand-typed list, so a new field cannot be added without documenting itself.
 */
export function describeSchemaKeys(
  node: JsonSchemaNode,
  options: {defaults?: unknown; prefix?: string} = {},
): SchemaKeyLine[] {
  const prefix = options.prefix ?? '';
  const lines: SchemaKeyLine[] = [];
  for (const [key, rawChild] of Object.entries(node.properties ?? {})) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;
    const childDefault = defaultAt(options.defaults, key);
    const {node: child} = unwrapNullable(rawChild);
    const isBlock = child.properties != null;
    lines.push({
      defaultValue:
        !isBlock && childDefault != null ? JSON.stringify(childDefault) : null,
      description: child.description ?? null,
      key: dotted,
      type: jsonSchemaType(rawChild),
    });
    if (isBlock) {
      lines.push(
        ...describeSchemaKeys(child, {defaults: childDefault, prefix: dotted}),
      );
    }
  }
  return lines;
}

function renderSection(
  heading: string,
  path: string,
  purpose: string,
  schema: z.ZodType,
): string[] {
  const keys = describeSchemaKeys(z.toJSONSchema(schema) as JsonSchemaNode, {
    defaults: {healthNotices: DEFAULT_HEALTH_NOTICES},
  });
  const width = keys.reduce((max, line) => Math.max(max, line.key.length), 0);
  const out = [`${heading}  ${path}`, `  ${purpose}`, ''];
  for (const line of keys) {
    const annotations = [
      line.type,
      line.defaultValue != null ? `default ${line.defaultValue}` : null,
      line.description,
    ].filter((part): part is string => part != null);
    out.push(`  ${line.key.padEnd(width)}  ${annotations.join('  ·  ')}`);
  }
  out.push('');
  return out;
}

/** The human-readable output of `justin-sdk config schema`. */
export function renderConfigSchema(
  options: {env?: EnvLike; projectRoot?: string} = {},
): string {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const lines = [
    'justin-sdk config files. Unknown keys are ALWAYS allowed (a newer SDK’s config must not fail an older one); a known key with the wrong type is a violation, which `justin-sdk doctor` reports as CONFIG_SCHEMA.',
    '',
    ...renderSection(
      'PROJECT',
      projectConfigPath(projectRoot),
      'Committed, per-repo. Written by base-setup and the component installers.',
      projectConfigSchema,
    ),
    ...renderSection(
      'USER',
      userConfigPath(env),
      'Not committed, applies to every repo on this machine. Create it by hand.',
      userConfigSchema,
    ),
    'healthNotices resolves DEFAULTS ← user file ← project file, field by field, and is switched off entirely by JUSTIN_SDK_HEALTH_NOTICES=off, by CI, or by CLAUDE_CODE_REMOTE=true.',
  ];
  return lines.join('\n');
}
