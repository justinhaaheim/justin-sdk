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

export interface ResolvedThreadConfig {
  enabled: boolean;
  /** Human-readable config read problems. Empty means both files were fine. */
  problems: string[];
  /** Which layer decided `enabled`. */
  source: 'default' | 'project' | 'user';
  projectRoot: string;
}

function enabledIn(config: unknown): boolean | null {
  if (config == null || typeof config !== 'object') return null;
  const componentConfig = (config as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object')
    return null;
  const section = (componentConfig as Record<string, unknown>)[
    THREAD_CONFIG_KEY
  ];
  if (section == null || typeof section !== 'object') return null;
  const enabled = (section as {enabled?: unknown}).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
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

  let enabled = THREAD_DEFAULT_ENABLED;
  let source: ResolvedThreadConfig['source'] = 'default';

  if (user.status === 'ok') {
    const value = enabledIn(user.config);
    if (value != null) {
      enabled = value;
      source = 'user';
    }
  }
  if (project.status === 'ok') {
    const value = enabledIn(project.config);
    if (value != null) {
      enabled = value;
      source = 'project';
    }
  }

  return {enabled, problems, projectRoot, source};
}
