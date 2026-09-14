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
import {readUsageCheckConfig, resolveUsageCheckConfig} from '../usage-check';

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
 * Off unless something says otherwise (home-base-p1uj.15).
 *
 * This is the knob with the largest blast radius in the group, and the only one
 * that can take a turn away from Claude: with it on, the `Stop` hook installed
 * by `justin-sdk add thread-hooks` refuses to let a session finish on a report
 * it did not record. Everything else here changes what gets printed or written;
 * this changes whether a session may stop. It stays off until the hook has been
 * watched behave on real sessions, and it is resolved through the same
 * DEFAULT ← user ← project layering as the others so one line in the user file
 * arms it everywhere and one line in a repo's config disarms it there.
 */
export const THREAD_DEFAULT_ENFORCE = false;

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
 * ON unless something says otherwise (home-base-p1uj.14, D19).
 *
 * Also not a feature gate: it picks between two spellings of the same header.
 * True is the shorter one Justin asked for on 2026-09-14 — emoji-prefixed values
 * with no field titles — and false restores the titled fields for anywhere the
 * emoji do not render (a log file, a pipe into something that strips them).
 */
export const THREAD_DEFAULT_EMOJI_HEADER = true;

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
  /** Whether the report header is emoji-prefixed values or titled fields (D19). */
  emojiHeader: boolean;
  /** Which layer decided `emojiHeader`. */
  emojiHeaderSource: ThreadConfigSource;
  /** Which layer decided `answerUi`. */
  answerUiSource: ThreadConfigSource;
  /** Whether the tool commits `.beads/issues.jsonl` after each write batch. */
  autoCommit: boolean;
  /** Which layer decided `autoCommit`. */
  autoCommitSource: ThreadConfigSource;
  enabled: boolean;
  /** Whether the Stop hook may block a report it cannot prove was recorded. */
  enforce: boolean;
  /** Which layer decided `enforce`. */
  enforceSource: ThreadConfigSource;
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
  const enforce = resolveFlag('enforce', THREAD_DEFAULT_ENFORCE);

  // `render` is the one NESTED block in the thread section, so it needs its own
  // walk rather than `resolveFlag`'s. Same layering: default, then user, then
  // project, with "this layer says nothing" kept distinct from an explicit
  // false — collapsing them would make an absent user file read as a deliberate
  // "off" that the project file then has to argue with.
  let emojiHeader = THREAD_DEFAULT_EMOJI_HEADER;
  let emojiHeaderSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const section = threadSectionIn(layer.config);
    const render = section?.render;
    if (render == null || typeof render !== 'object') continue;
    const value = (render as Record<string, unknown>).emojiHeader;
    if (typeof value !== 'boolean') continue;
    emojiHeader = value;
    emojiHeaderSource = layer.name;
  }

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
    emojiHeader,
    emojiHeaderSource,
    enabled: enabled.value,
    enforce: enforce.value,
    enforceSource: enforce.source,
    problems,
    projectRoot,
    repoDir,
    repoDirSource,
    source: enabled.source,
    startOnSessionStart: start.value,
    startSource: start.source,
  };
}

/**
 * The wrap-up threshold the report header shows beside the token count (D19).
 *
 * REUSES usage-check's own resolver rather than re-reading the file: the
 * threshold is folded into a ladder, can be nulled per role, and has a
 * documented "absent means inherit" rule — three places for a second
 * implementation to disagree, and the number is about to be printed next to a
 * measurement as though it were one.
 *
 * NULL IS A REAL ANSWER, and it is the common one: usage-check is disabled in
 * most repos, and `wrapUpAt` defaults to null even where it is on. Null means
 * "no threshold is configured", so the header prints `497k` with no second
 * number — never `497k / 0`, which would read as a budget that has been blown.
 *
 * The role is `session`, not `player`: a thread report is written by the main
 * session at its wrap-up. A dispatched subagent inherits its parent's session id
 * and never writes a thread of its own (the status-report rule says so
 * explicitly), so there is no case here where the player budget is the right
 * one.
 */
export function resolveReportWrapUpAt(projectRoot: string): number | null {
  const resolved = resolveUsageCheckConfig(
    readUsageCheckConfig(projectRoot),
    'session',
  );
  return resolved?.wrapUpAt ?? null;
}
