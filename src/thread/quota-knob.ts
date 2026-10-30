/**
 * `componentConfig.thread.quota` (request home-base-ys9t7.5, D5): the spend
 * quota's mode and limits, all in percent of Justin's week.
 *
 * Built exactly like handoff-knob.ts: every field resolves on its own through
 * the thread knobs' layering, DEFAULT ← user file ← project file, so a project
 * file that sets only `mode` keeps the user file's limits. A value of the
 * wrong shape is NAMED in the config problems and ignored, so the field falls
 * back to the layer below; it never reads as a deliberate setting. The zod
 * schema in sdk-config.ts rejects most bad shapes first (which costs the whole
 * file); this walk is the second line, for the shapes zod lets through.
 *
 * zod-free on purpose: thread/config.ts imports it.
 */

import type {ThreadConfigSource} from './config';

import {
  QUOTA_DEFAULTS,
  QUOTA_MODES,
  QUOTA_RATE_FAMILIES,
  type QuotaMode,
  type QuotaRateFamily,
} from './defaults';

/** One resolved value and the layer that set it. */
export interface Sourced<T> {
  source: ThreadConfigSource;
  value: T;
}

export interface ResolvedQuotaConfig {
  /**
   * A group whose latest typed line is younger than this is attended: the
   * week floor does not brake its running sessions (D4). Handoff and spawn
   * ignore it.
   */
  attendedGraceMinutes: Sourced<number>;
  /** A group's unattended spend above this percent of the week: over (D2). */
  chainWeekPercent: Sourced<number>;
  /** List-price dollars per 1 % of the week, per model family (D1). */
  dollarsPerWeekPercent: Record<QuotaRateFamily, Sourced<number>>;
  /** The week at or above this percent: over, for unattended work (D4). */
  floorWeekPercent: Sourced<number>;
  /** off | observe | enforce (D5). The verdict never reads it. */
  mode: Sourced<QuotaMode>;
  /** A project's unattended spend in the last 24 h above this: over (D3). */
  projectDayWeekPercent: Sourced<number>;
  /** How often a running session's cached verdict is recomputed (D6). */
  recheckSeconds: Sourced<number>;
}

/** One config layer's `componentConfig.thread.quota`, as read (any shape). */
export interface QuotaLayer {
  name: ThreadConfigSource;
  section: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isMode(value: unknown): value is QuotaMode {
  return (
    typeof value === 'string' &&
    (QUOTA_MODES as readonly string[]).includes(value)
  );
}

function isPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resolveField<T>(input: {
  accept: (value: unknown) => value is T;
  dotted: string;
  expected: string;
  fallback: T;
  problems: string[];
  read: (section: Record<string, unknown>) => unknown;
  sections: readonly QuotaLayer[];
}): Sourced<T> {
  let value = input.fallback;
  let source: ThreadConfigSource = 'default';
  for (const layer of input.sections) {
    if (!isObject(layer.section)) continue;
    const raw = input.read(layer.section);
    if (raw === undefined) continue;
    if (!input.accept(raw)) {
      input.problems.push(
        `componentConfig.thread.${input.dotted} in the ${layer.name} config is ${JSON.stringify(raw)}, which is not ${input.expected} — ignoring it and using ${JSON.stringify(value)}.`,
      );
      continue;
    }
    value = raw;
    source = layer.name;
  }
  return {source, value};
}

function nameNonObjects(
  layers: readonly QuotaLayer[],
  dotted: string,
  problems: string[],
): void {
  for (const layer of layers) {
    if (layer.section === undefined || isObject(layer.section)) continue;
    problems.push(
      `componentConfig.thread.${dotted} in the ${layer.name} config is ${JSON.stringify(layer.section)}, which is not an object — ignoring it.`,
    );
  }
}

/**
 * Resolve the quota block from the layers, lowest first (user, then project).
 * Problems are appended to `problems`, the caller's list.
 */
export function resolveQuotaConfig(
  layers: readonly QuotaLayer[],
  problems: string[],
): ResolvedQuotaConfig {
  nameNonObjects(layers, 'quota', problems);
  const rateLayers = layers.map((layer) => ({
    name: layer.name,
    section: isObject(layer.section)
      ? layer.section.dollarsPerWeekPercent
      : undefined,
  }));
  nameNonObjects(rateLayers, 'quota.dollarsPerWeekPercent', problems);

  const field = <T>(
    key: string,
    accept: (value: unknown) => value is T,
    expected: string,
    fallback: T,
  ): Sourced<T> =>
    resolveField({
      accept,
      dotted: `quota.${key}`,
      expected,
      fallback,
      problems,
      read: (section) => section[key],
      sections: layers,
    });
  const percent = (
    key: 'chainWeekPercent' | 'floorWeekPercent' | 'projectDayWeekPercent',
  ) => field(key, isPercent, 'a percentage from 0 to 100', QUOTA_DEFAULTS[key]);

  const mode = field(
    'mode',
    isMode,
    `one of ${QUOTA_MODES.join(', ')}`,
    QUOTA_DEFAULTS.mode,
  );
  const chainWeekPercent = percent('chainWeekPercent');
  const projectDayWeekPercent = percent('projectDayWeekPercent');
  const floorWeekPercent = percent('floorWeekPercent');
  const attendedGraceMinutes = field(
    'attendedGraceMinutes',
    isNonNegativeNumber,
    'a number of minutes, 0 or more',
    QUOTA_DEFAULTS.attendedGraceMinutes as number,
  );
  const recheckSeconds = field(
    'recheckSeconds',
    isPositiveNumber,
    'a positive number of seconds',
    QUOTA_DEFAULTS.recheckSeconds as number,
  );
  const rate = (family: QuotaRateFamily): Sourced<number> =>
    resolveField({
      accept: isPositiveNumber,
      dotted: `quota.dollarsPerWeekPercent.${family}`,
      expected: 'a positive number of dollars',
      fallback: QUOTA_DEFAULTS.dollarsPerWeekPercent[family] as number,
      problems,
      read: (section) => section[family],
      sections: rateLayers,
    });
  const dollarsPerWeekPercent = Object.fromEntries(
    QUOTA_RATE_FAMILIES.map((family) => [family, rate(family)]),
  ) as Record<QuotaRateFamily, Sourced<number>>;

  return {
    attendedGraceMinutes,
    chainWeekPercent,
    dollarsPerWeekPercent,
    floorWeekPercent,
    mode,
    projectDayWeekPercent,
    recheckSeconds,
  };
}

/** The resolved knob without its sources: what the measurement and verdict use. */
export interface QuotaLimits {
  attendedGraceMinutes: number;
  chainWeekPercent: number;
  dollarsPerWeekPercent: Record<QuotaRateFamily, number>;
  floorWeekPercent: number;
  projectDayWeekPercent: number;
}

export function quotaLimitsOf(config: ResolvedQuotaConfig): QuotaLimits {
  return {
    attendedGraceMinutes: config.attendedGraceMinutes.value,
    chainWeekPercent: config.chainWeekPercent.value,
    dollarsPerWeekPercent: Object.fromEntries(
      QUOTA_RATE_FAMILIES.map((family) => [
        family,
        config.dollarsPerWeekPercent[family].value,
      ]),
    ) as Record<QuotaRateFamily, number>,
    floorWeekPercent: config.floorWeekPercent.value,
    projectDayWeekPercent: config.projectDayWeekPercent.value,
  };
}
