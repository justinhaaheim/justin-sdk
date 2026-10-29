/**
 * `componentConfig.thread.handoff` (epic home-base-mbnjv C1): one knob object
 * that says whether `thread handoff` starts a successor (D10) and the limits
 * its gate enforces (D2, D6, D7).
 *
 * Every field resolves on its own through the thread knobs' layering, DEFAULT
 * ← user file ← project file: a project file that sets only `successor: true`
 * keeps the user file's `maxLiveSessions`. A value of the wrong shape is NAMED
 * in the config problems and ignored, so the field falls back to the layer
 * below; it never reads as a deliberate setting. The zod schema in
 * sdk-config.ts rejects most of these shapes first, which costs the whole
 * file (the sdk-config rule, and exactly what a bad `enforceMode` does); the
 * walk here is the second line, for the shapes zod lets through.
 *
 * zod-free on purpose: thread/config.ts imports it, and nothing here needs a
 * parser.
 */

import type {ThreadConfigSource} from './config';

import {
  HANDOFF_DEFAULTS,
  HANDOFF_PERMISSION_MODES,
  HANDOFF_PREDECESSOR_MODES,
  type HandoffPermissionMode,
  type HandoffPredecessorMode,
} from './defaults';

/** The handoff gate's usage ceilings (C1), each with the layer that set it. */
export interface ResolvedHandoffUsage {
  /** A sample older than this many minutes is unknown, never "fine". */
  maxSampleAgeMinutes: number;
  maxSampleAgeMinutesSource: ThreadConfigSource;
  /** The 5-hour session window's ceiling, in percent. Above it: refused. */
  maxSessionPercent: number;
  maxSessionPercentSource: ThreadConfigSource;
  /** The all-models week window's ceiling, in percent. Above it: refused. */
  maxWeekPercent: number;
  maxWeekPercentSource: ThreadConfigSource;
}

export interface ResolvedHandoffConfig {
  /** More live Claude sessions than this on the machine: refused (D2). */
  maxLiveSessions: number;
  maxLiveSessionsSource: ThreadConfigSource;
  /**
   * This many handoffs in a row since Justin last typed in the chain: the next
   * one is refused (D2). 0 refuses every handoff from a session he has not
   * typed in.
   */
  maxUnattendedHandoffs: number;
  maxUnattendedHandoffsSource: ThreadConfigSource;
  /** The successor's `claude --permission-mode` (D7). */
  permissionMode: HandoffPermissionMode;
  permissionModeSource: ThreadConfigSource;
  /** What becomes of the old tab once the successor has linked (D6). */
  predecessor: HandoffPredecessorMode;
  predecessorSource: ThreadConfigSource;
  /**
   * The feature knob (D10). False: `thread handoff` behaves exactly as it did
   * before the epic, and nothing is started.
   */
  successor: boolean;
  successorSource: ThreadConfigSource;
  usage: ResolvedHandoffUsage;
}

/** One config layer's `componentConfig.thread.handoff`, as read (any shape). */
export interface HandoffLayer {
  name: ThreadConfigSource;
  section: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPredecessorMode(value: unknown): value is HandoffPredecessorMode {
  return (
    typeof value === 'string' &&
    (HANDOFF_PREDECESSOR_MODES as readonly string[]).includes(value)
  );
}

function isPermissionMode(value: unknown): value is HandoffPermissionMode {
  return (
    typeof value === 'string' &&
    (HANDOFF_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

function isWholeNumberAtLeast(min: number) {
  return (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min;
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

/**
 * Walk the layers for one field. A layer that does not mention the field says
 * nothing; one whose value fails `accept` is named in `problems` and skipped.
 */
function resolveField<T>(input: {
  accept: (value: unknown) => value is T;
  dotted: string;
  expected: string;
  fallback: T;
  problems: string[];
  read: (section: Record<string, unknown>) => unknown;
  sections: readonly {name: ThreadConfigSource; section: unknown}[];
}): {source: ThreadConfigSource; value: T} {
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

/**
 * Resolve the handoff block from the layers, lowest first (user, then
 * project). Problems are appended to `problems`, the caller's list.
 */
export function resolveHandoffConfig(
  layers: readonly HandoffLayer[],
  problems: string[],
): ResolvedHandoffConfig {
  // A `handoff` that is present but not an object is named once; its fields
  // then read as "this layer says nothing".
  for (const layer of layers) {
    if (layer.section === undefined || isObject(layer.section)) continue;
    problems.push(
      `componentConfig.thread.handoff in the ${layer.name} config is ${JSON.stringify(layer.section)}, which is not an object — ignoring it.`,
    );
  }
  const usageLayers = layers.map((layer) => ({
    name: layer.name,
    section: isObject(layer.section) ? layer.section.usage : undefined,
  }));
  for (const layer of usageLayers) {
    if (layer.section === undefined || isObject(layer.section)) continue;
    problems.push(
      `componentConfig.thread.handoff.usage in the ${layer.name} config is ${JSON.stringify(layer.section)}, which is not an object — ignoring it.`,
    );
  }

  const field = <T>(
    key: string,
    accept: (value: unknown) => value is T,
    expected: string,
    fallback: T,
  ) =>
    resolveField({
      accept,
      dotted: `handoff.${key}`,
      expected,
      fallback,
      problems,
      read: (section) => section[key],
      sections: layers,
    });
  const usageField = (key: keyof typeof HANDOFF_DEFAULTS.usage) =>
    resolveField({
      accept: key === 'maxSampleAgeMinutes' ? isPositiveNumber : isPercent,
      dotted: `handoff.usage.${key}`,
      expected:
        key === 'maxSampleAgeMinutes'
          ? 'a positive number of minutes'
          : 'a percentage from 0 to 100',
      fallback: HANDOFF_DEFAULTS.usage[key],
      problems,
      read: (section) => section[key],
      sections: usageLayers,
    });

  const successor = field(
    'successor',
    (value): value is boolean => typeof value === 'boolean',
    'true or false',
    HANDOFF_DEFAULTS.successor as boolean,
  );
  const predecessor = field(
    'predecessor',
    isPredecessorMode,
    `one of ${HANDOFF_PREDECESSOR_MODES.join(', ')}`,
    HANDOFF_DEFAULTS.predecessor,
  );
  const maxLiveSessions = field(
    'maxLiveSessions',
    isWholeNumberAtLeast(1),
    'a whole number, 1 or more',
    HANDOFF_DEFAULTS.maxLiveSessions as number,
  );
  const maxUnattendedHandoffs = field(
    'maxUnattendedHandoffs',
    isWholeNumberAtLeast(0),
    'a whole number, 0 or more',
    HANDOFF_DEFAULTS.maxUnattendedHandoffs as number,
  );
  const permissionMode = field(
    'permissionMode',
    isPermissionMode,
    `one of ${HANDOFF_PERMISSION_MODES.join(', ')}`,
    HANDOFF_DEFAULTS.permissionMode,
  );
  const maxSessionPercent = usageField('maxSessionPercent');
  const maxWeekPercent = usageField('maxWeekPercent');
  const maxSampleAgeMinutes = usageField('maxSampleAgeMinutes');

  return {
    maxLiveSessions: maxLiveSessions.value,
    maxLiveSessionsSource: maxLiveSessions.source,
    maxUnattendedHandoffs: maxUnattendedHandoffs.value,
    maxUnattendedHandoffsSource: maxUnattendedHandoffs.source,
    permissionMode: permissionMode.value,
    permissionModeSource: permissionMode.source,
    predecessor: predecessor.value,
    predecessorSource: predecessor.source,
    successor: successor.value,
    successorSource: successor.source,
    usage: {
      maxSampleAgeMinutes: maxSampleAgeMinutes.value,
      maxSampleAgeMinutesSource: maxSampleAgeMinutes.source,
      maxSessionPercent: maxSessionPercent.value,
      maxSessionPercentSource: maxSessionPercent.source,
      maxWeekPercent: maxWeekPercent.value,
      maxWeekPercentSource: maxWeekPercent.source,
    },
  };
}
