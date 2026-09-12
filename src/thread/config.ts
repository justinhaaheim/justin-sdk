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

/**
 * ON unless something says otherwise (home-base-p1uj.11) — the one knob here
 * whose default is true.
 *
 * It can be, because it is not a feature gate: threads now live in their own
 * repo whose only writer is this tool, so committing after a write is simply
 * finishing the write. The knob exists to turn the commit OFF for someone who
 * wants to batch them (or whose threads repo is not a git repo at all), not to
 * arm something risky. D13 — "the tool does not commit" — was retracted with
 * the move, because the hazard it named was racing ~/Dev/life's index, and
 * there is no longer another writer to race.
 */
export const THREAD_DEFAULT_AUTO_COMMIT = true;

/**
 * Which UI `thread answer` puts in front of Justin (home-base-p1uj.12).
 *
 * `ink` is a REAL member of this union even though no Ink UI ships, and that is
 * deliberate. The bead named three values; the spike measured Ink and rejected
 * it (no maintained multi-line editor exists for it — the verdict with its
 * numbers is in the bead's notes). Accepting `ink` and silently running
 * something else would be the reassuring kind of wrong, and dropping it from the
 * union would turn a considered rejection into a typo. So it parses, and
 * `thread answer` refuses it in one line that names the verdict.
 */
export type ThreadAnswerUi = 'classic' | 'ink' | 'web';

/** The spike winner (home-base-p1uj.12). */
export const THREAD_DEFAULT_ANSWER_UI: ThreadAnswerUi = 'web';

export const THREAD_ANSWER_UIS: readonly ThreadAnswerUi[] = [
  'classic',
  'ink',
  'web',
];

export function isThreadAnswerUi(value: unknown): value is ThreadAnswerUi {
  return (
    typeof value === 'string' &&
    (THREAD_ANSWER_UIS as readonly string[]).includes(value)
  );
}

/** Which layer decided one knob's value. */
export type ThreadConfigSource = 'default' | 'project' | 'user';

export interface ResolvedThreadConfig {
  /** Which UI `thread answer` opens. */
  answerUi: ThreadAnswerUi;
  /** Which layer decided `answerUi`. */
  answerUiSource: ThreadConfigSource;
  /** Whether the tool commits `.beads/issues.jsonl` after each write batch. */
  autoCommit: boolean;
  /** Which layer decided `autoCommit`. */
  autoCommitSource: ThreadConfigSource;
  enabled: boolean;
  /** Human-readable config read problems. Empty means both files were fine. */
  problems: string[];
  /**
   * The configured threads repo, or null for "no layer said" — which is a
   * DISTINCT answer from a path, and is what lets `paths.ts` fall through to
   * its own default instead of treating a missing key as an empty directory.
   */
  repoDir: string | null;
  /** Which layer decided `repoDir`. */
  repoDirSource: ThreadConfigSource;
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
function threadSectionIn(config: unknown): Record<string, unknown> | null {
  if (config == null || typeof config !== 'object') return null;
  const componentConfig = (config as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object')
    return null;
  const section = (componentConfig as Record<string, unknown>)[
    THREAD_CONFIG_KEY
  ];
  if (section == null || typeof section !== 'object') return null;
  return section as Record<string, unknown>;
}

function threadFlagIn(config: unknown, key: string): boolean | null {
  const section = threadSectionIn(config);
  if (section == null) return null;
  const value = section[key];
  return typeof value === 'boolean' ? value : null;
}

/** One string out of `componentConfig.thread`. Empty string counts as absent. */
function threadStringIn(config: unknown, key: string): string | null {
  const section = threadSectionIn(config);
  if (section == null) return null;
  const value = section[key];
  return typeof value === 'string' && value !== '' ? value : null;
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
  const autoCommit = resolveFlag('autoCommit', THREAD_DEFAULT_AUTO_COMMIT);

  let repoDir: string | null = null;
  let repoDirSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const read = threadStringIn(layer.config, 'repoDir');
    if (read != null) {
      repoDir = read;
      repoDirSource = layer.name;
    }
  }

  let answerUi: ThreadAnswerUi = THREAD_DEFAULT_ANSWER_UI;
  let answerUiSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const read = threadStringIn(layer.config, 'answerUi');
    if (read == null) continue;
    if (!isThreadAnswerUi(read)) {
      // A misspelled UI is NAMED, not shrugged off: a knob that reads as the
      // default because of a typo is exactly the silent-shaped failure rule 6 is
      // about, and this one decides which editor Justin types five paragraphs
      // into.
      problems.push(
        `componentConfig.thread.answerUi in the ${layer.name} config is ${JSON.stringify(read)}, which is not one of ${THREAD_ANSWER_UIS.join(', ')} — ignoring it and using ${THREAD_DEFAULT_ANSWER_UI}.`,
      );
      continue;
    }
    answerUi = read;
    answerUiSource = layer.name;
  }

  return {
    answerUi,
    answerUiSource,
    autoCommit: autoCommit.value,
    autoCommitSource: autoCommit.source,
    enabled: enabled.value,
    problems,
    projectRoot,
    repoDir,
    repoDirSource,
    source: enabled.source,
    startOnSessionStart: start.value,
    startSource: start.source,
  };
}
