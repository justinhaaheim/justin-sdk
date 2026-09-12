/**
 * The `thread` knob (home-base-p1uj D6) — the first application of the
 * feature-knobs rule.
 *
 * `componentConfig.thread.enabled`, DEFAULT OFF, settable in the user file
 * (`~/.config/justin-sdk/config.json`, applies to every repo on this machine)
 * and overridable per repo in the committed `justin-sdk.config.json`. The point
 * of the knob is that a half-built feature can be dogfooded in one session
 * without changing anything for the other twenty: with it off, `thread prepare`
 * prints `THREADS: DISABLED` and the rule falls back to the plain text status
 * report.
 *
 * A file that fails schema validation contributes NOTHING rather than being
 * half-applied — the same rule the healthNotices layer follows — but unlike
 * that layer the problem is not swallowed here: the resolution carries a
 * `problems` list, and `prepare` prints it. A knob that reads as "off" because
 * of a typo three levels down is exactly the silent-shaped failure rule 6 is
 * about.
 */

import {
  isConfigProblem,
  describeConfigOutcome,
  readProjectConfig,
  readUserConfig,
} from '../sdk-config';
import {findProjectRoot} from '../health-notices';

import type {EnvLike} from './paths';

export const THREAD_CONFIG_KEY = 'thread';

/** Off unless something says otherwise (D6). */
export const THREAD_DEFAULT_ENABLED = false;

/**
 * Off unless something says otherwise (home-base-p1uj.3).
 *
 * A SECOND knob rather than a reuse of `enabled`, deliberately. `enabled` is
 * the preflight branch point a human-driven wrap-up reads; `startOnSessionStart`
 * arms a HOOK that fires on every session start and every resume, in every repo
 * that installed it, and turns each one into a Dolt write. Those two want
 * different blast radii: Justin can dogfood `thread prepare`/`report` by hand
 * for a week before he is willing to pay a bd round-trip at the top of every
 * session. Folding them together would make the cheap decision imply the
 * expensive one.
 */
export const THREAD_DEFAULT_START_ON_SESSION_START = false;

/** Which layer decided one knob's value. */
export type ThreadConfigSource = 'default' | 'project' | 'user';

export interface ResolvedThreadConfig {
  enabled: boolean;
  /** Human-readable config read problems. Empty means both files were fine. */
  problems: string[];
  /** Which layer decided `enabled`. */
  source: ThreadConfigSource;
  /** Whether the SessionStart hook may create this session's thread bead. */
  startOnSessionStart: boolean;
  /** Which layer decided `startOnSessionStart`. */
  startSource: ThreadConfigSource;
  projectRoot: string;
}

/**
 * Read one boolean out of `componentConfig.thread`.
 *
 * Returns null for "this layer says nothing", which is a DISTINCT answer from
 * `false` — the layering below depends on the difference, and collapsing them
 * would make an absent user file read as an explicit "off" that a project file
 * then has to argue with.
 */
function threadFlagIn(config: unknown, key: string): boolean | null {
  if (config == null || typeof config !== 'object') return null;
  const componentConfig = (config as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object')
    return null;
  const section = (componentConfig as Record<string, unknown>)[
    THREAD_CONFIG_KEY
  ];
  if (section == null || typeof section !== 'object') return null;
  const value = (section as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : null;
}

/** DEFAULT ← user file ← project file. */
export function resolveThreadConfig(
  options: {cwd?: string; env?: EnvLike} = {},
): ResolvedThreadConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);

  const user = readUserConfig(env);
  const project = readProjectConfig(projectRoot);

  const problems: string[] = [];
  if (isConfigProblem(user)) problems.push(describeConfigOutcome(user));
  if (isConfigProblem(project)) problems.push(describeConfigOutcome(project));

  const layers: {config: unknown; name: ThreadConfigSource}[] = [];
  if (user.status === 'ok') layers.push({config: user.config, name: 'user'});
  if (project.status === 'ok')
    layers.push({config: project.config, name: 'project'});

  function resolveFlag(
    key: string,
    fallback: boolean,
  ): {source: ThreadConfigSource; value: boolean} {
    let value = fallback;
    let source: ThreadConfigSource = 'default';
    for (const layer of layers) {
      const read = threadFlagIn(layer.config, key);
      if (read != null) {
        value = read;
        source = layer.name;
      }
    }
    return {source, value};
  }

  const enabled = resolveFlag('enabled', THREAD_DEFAULT_ENABLED);
  const start = resolveFlag(
    'startOnSessionStart',
    THREAD_DEFAULT_START_ON_SESSION_START,
  );

  return {
    enabled: enabled.value,
    problems,
    projectRoot,
    source: enabled.source,
    startOnSessionStart: start.value,
    startSource: start.source,
  };
}
