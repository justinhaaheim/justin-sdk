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

import type {EnvLike} from './paths';

import {existsSync, readFileSync, statSync} from 'fs';
import {basename, dirname, join, resolve} from 'path';

import {primaryOfClaudeWorktreePath} from '../claude-worktree-path';
import {findProjectRoot} from '../health-notices';
import {
  describeConfigOutcome,
  isConfigProblem,
  readProjectConfig,
  readUserConfig,
} from '../sdk-config';
import {readUsageCheckConfig, resolveUsageCheckConfig} from '../usage-check';
import {
  THREAD_ANSWER_UIS,
  THREAD_CONFIG_KEY,
  THREAD_DASHBOARD_UIS,
  THREAD_DEFAULT_ANSWER_UI,
  THREAD_DEFAULT_AUTO_COMMIT,
  THREAD_DEFAULT_AUTO_PUSH,
  THREAD_DEFAULT_CAPTURE,
  THREAD_DEFAULT_DASHBOARD_UI,
  THREAD_DEFAULT_EMOJI_HEADER,
  THREAD_DEFAULT_ENABLED,
  THREAD_DEFAULT_ENFORCE,
  THREAD_DEFAULT_ENFORCE_MIN_TURN_MINUTES,
  THREAD_DEFAULT_ENFORCE_MODE,
  THREAD_DEFAULT_NAME_WORKSPACES,
  THREAD_DEFAULT_NUDGE,
  THREAD_DEFAULT_OPEN_SINCE,
  THREAD_DEFAULT_PINNED_PROJECTS,
  THREAD_DEFAULT_SESSION_BEADS,
  THREAD_DEFAULT_STAGES,
  THREAD_ENFORCE_MODES,
  type ThreadAnswerUi,
  type ThreadDashboardUi,
  type ThreadEnforceMode,
} from './defaults';
import {type ResolvedHandoffConfig, resolveHandoffConfig} from './handoff-knob';
import {parseSince} from './open-filters';

export function isThreadDashboardUi(
  value: unknown,
): value is ThreadDashboardUi {
  return (
    typeof value === 'string' &&
    (THREAD_DASHBOARD_UIS as readonly string[]).includes(value)
  );
}

function isThreadEnforceMode(value: unknown): value is ThreadEnforceMode {
  return (
    typeof value === 'string' &&
    (THREAD_ENFORCE_MODES as readonly string[]).includes(value)
  );
}

export function isThreadAnswerUi(value: unknown): value is ThreadAnswerUi {
  return (
    typeof value === 'string' &&
    (THREAD_ANSWER_UIS as readonly string[]).includes(value)
  );
}

/** A declared `projectTag`: 1–12 of A-Z, 0-9 and "-" (home-base-bomy5.7.1). */
export const PROJECT_TAG_FORMAT = /^[A-Z0-9-]{1,12}$/;

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
  /** Whether a successful commit is followed by `git push origin HEAD` (D22). */
  autoPush: boolean;
  /** Which layer decided `autoPush`. */
  autoPushSource: ThreadConfigSource;
  /**
   * Whether the `thread capture` hooks record every prompt and yield (K10).
   * The RAW knob — capture runs only when this AND `enabled` are true; use
   * `captureActive` for that answer.
   */
  capture: boolean;
  /** `enabled && capture`: what the hook actually branches on (K10). */
  captureActive: boolean;
  /** Which layer decided `capture`. */
  captureSource: ThreadConfigSource;
  /**
   * Which dashboard `thread dashboard` opens without --web / --tui
   * (home-base-yukaf.11, D-WEB). Default `tui`; a misspelled value is NAMED
   * in `problems` and ignored.
   */
  dashboardUi: ThreadDashboardUi;
  /** Which layer decided `dashboardUi`. */
  dashboardUiSource: ThreadConfigSource;
  /** Whether the report header is emoji-prefixed values or titled fields (D19). */
  emojiHeader: boolean;
  /** Which layer decided `emojiHeader`. */
  emojiHeaderSource: ThreadConfigSource;
  enabled: boolean;
  /** Whether the Stop hook may block a report it cannot prove was recorded. */
  enforce: boolean;
  /** `workTurns` turns of at least this many minutes count as work (K12). */
  enforceMinTurnMinutes: number;
  enforceMinTurnMinutesSource: ThreadConfigSource;
  /** What the armed Stop hook refuses (K12). Default `reportShaped`. */
  enforceMode: ThreadEnforceMode;
  enforceModeSource: ThreadConfigSource;
  /** Which layer decided `enforce`. */
  enforceSource: ThreadConfigSource;
  /**
   * `componentConfig.thread.handoff` (epic home-base-mbnjv C1): whether
   * `thread handoff` starts a successor, and the limits its gate enforces.
   * Each field is resolved per layer on its own; see handoff-knob.ts.
   */
  handoff: ResolvedHandoffConfig;
  /**
   * Whether a session names its cmux workspace after its title
   * (home-base-j8q3e.5 D6). Off by default.
   */
  nameWorkspaces: boolean;
  /** Which layer decided `nameWorkspaces`. */
  nameWorkspacesSource: ThreadConfigSource;
  /**
   * Whether the PostToolUse `thread nudge` may speak (home-base-vzwbj.4.4).
   * It also needs `sessionBeads`.
   */
  nudge: boolean;
  /** Which layer decided `nudge`. */
  nudgeSource: ThreadConfigSource;
  /**
   * The window `thread open` uses when neither --since nor --days is given
   * (home-base-yukaf.22): `24h`, `3d`, `2w`. A value parseSince refuses is
   * NAMED in `problems` and ignored.
   */
  openSince: string;
  /** Which layer decided `openSince`. */
  openSinceSource: ThreadConfigSource;
  /**
   * D-PINS (home-base-yukaf.9): repo folder names listed first in every
   * by-repo view, in order. A value that is not a list of non-empty strings
   * is NAMED in `problems` and ignored.
   */
  pinnedProjects: readonly string[];
  /** Which layer decided `pinnedProjects`. */
  pinnedProjectsSource: ThreadConfigSource;
  /** Human-readable config read problems. Empty means both files were fine. */
  problems: string[];
  projectRoot: string;
  /**
   * The repo's declared short tag (top-level `projectTag` of the PROJECT file
   * only, home-base-bomy5.7.1), or null when it declares none or declares one
   * that breaks the format — the latter is ALSO named in `problems`, so a bad
   * tag never reads as an absent one (critical rule 7). Display code wants
   * `resolveRepoTag`, which adds the folder-name fallback.
   */
  projectTag: string | null;
  /**
   * The configured threads repo, or null for "no layer said" — which is a
   * DISTINCT answer from a path, and is what lets `paths.ts` fall through to
   * its own default instead of treating a missing key as an empty directory.
   */
  repoDir: string | null;
  /** Which layer decided `repoDir`. */
  repoDirSource: ThreadConfigSource;
  /**
   * Whether capture files a session bead in the repo and injects the
   * prompt-time line, and `thread request` / `thread title` work (status report
   * v4, home-base-vzwbj.4.1). The RAW knob: the hook only runs when
   * `captureActive` is true as well.
   */
  sessionBeads: boolean;
  /** Which layer decided `sessionBeads`. */
  sessionBeadsSource: ThreadConfigSource;
  /** Which layer decided `enabled`. */
  source: ThreadConfigSource;
  /**
   * The request stage ladder, in order (home-base-vzwbj.4.3): what `thread
   * stage` accepts and Part 1 ranks. A layer whose value is not a non-empty
   * list of distinct non-empty strings is NAMED in `problems` and ignored.
   */
  stages: readonly string[];
  /** Which layer decided `stages`. */
  stagesSource: ThreadConfigSource;
  // NO `startOnSessionStart`. It is DEPRECATED (home-base-39co9 D2) and gates
  // nothing, so it is not resolved at all: a resolved field nobody reads would
  // look like a live switch. Configs carrying it still parse — sdk-config.ts
  // keeps the key in the schema and `config schema` names it deprecated.
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
  const autoCommit = resolveFlag('autoCommit', THREAD_DEFAULT_AUTO_COMMIT);
  const autoPush = resolveFlag('autoPush', THREAD_DEFAULT_AUTO_PUSH);
  const enforce = resolveFlag('enforce', THREAD_DEFAULT_ENFORCE);
  const capture = resolveFlag('capture', THREAD_DEFAULT_CAPTURE);
  const sessionBeads = resolveFlag(
    'sessionBeads',
    THREAD_DEFAULT_SESSION_BEADS,
  );
  const nudge = resolveFlag('nudge', THREAD_DEFAULT_NUDGE);
  const nameWorkspaces = resolveFlag(
    'nameWorkspaces',
    THREAD_DEFAULT_NAME_WORKSPACES,
  );

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

  // D-WEB (home-base-yukaf.11): named and ignored when misspelled, like
  // answerUi, so a typo never silently picks the other dashboard.
  let dashboardUi: ThreadDashboardUi = THREAD_DEFAULT_DASHBOARD_UI;
  let dashboardUiSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const value = threadSectionIn(layer.config)?.dashboardUi;
    if (value === undefined) continue;
    if (!isThreadDashboardUi(value)) {
      problems.push(
        `componentConfig.thread.dashboardUi in the ${layer.name} config is ${JSON.stringify(value)}, which is not one of ${THREAD_DASHBOARD_UIS.join(', ')} — ignoring it and using ${dashboardUi}.`,
      );
      continue;
    }
    dashboardUi = value;
    dashboardUiSource = layer.name;
  }

  // The stage ladder (home-base-vzwbj.4.3). A malformed list is NAMED and
  // ignored like answerUi: a ladder that silently fell back would refuse every
  // stage Justin configured, with nothing saying why.
  let stages: readonly string[] = THREAD_DEFAULT_STAGES;
  let stagesSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const value = threadSectionIn(layer.config)?.stages;
    if (value === undefined) continue;
    const ok =
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (entry) =>
          typeof entry === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry),
      ) &&
      new Set(value).size === value.length;
    if (!ok) {
      problems.push(
        `componentConfig.thread.stages in the ${layer.name} config is ${JSON.stringify(value)}, which is not a non-empty list of distinct plain names (letters, digits, . _ -) — ignoring it and using ${stages.join(', ')}.`,
      );
      continue;
    }
    stages = value as string[];
    stagesSource = layer.name;
  }

  // D-PINS (home-base-yukaf.9): a later layer REPLACES the list (no merge),
  // like `stages`; a malformed one is named and ignored.
  let pinnedProjects: readonly string[] = THREAD_DEFAULT_PINNED_PROJECTS;
  let pinnedProjectsSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const value = threadSectionIn(layer.config)?.pinnedProjects;
    if (value === undefined) continue;
    const ok =
      Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (!ok) {
      problems.push(
        `componentConfig.thread.pinnedProjects in the ${layer.name} config is ${JSON.stringify(value)}, which is not a list of repo folder names — ignoring it and using ${JSON.stringify(pinnedProjects)}.`,
      );
      continue;
    }
    pinnedProjects = value as string[];
    pinnedProjectsSource = layer.name;
  }

  // home-base-yukaf.22: a later layer replaces it; a value --since would
  // refuse is named and ignored, so a typo never silently changes the window.
  let openSince = THREAD_DEFAULT_OPEN_SINCE;
  let openSinceSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const value = threadSectionIn(layer.config)?.openSince;
    if (value === undefined) continue;
    const parsed =
      typeof value === 'string' ? parseSince(value) : {kind: 'bad' as const};
    if (parsed.kind !== 'ok') {
      problems.push(
        `componentConfig.thread.openSince in the ${layer.name} config is ${JSON.stringify(value)}, which is not a number and h, d or w (like 24h, 3d, 2w) — ignoring it and using ${openSince}.`,
      );
      continue;
    }
    openSince = parsed.text;
    openSinceSource = layer.name;
  }

  // K12: a misspelled mode is NAMED and ignored, exactly like answerUi — a
  // refusal experiment that silently reads as off would be invisible.
  let enforceMode: ThreadEnforceMode = THREAD_DEFAULT_ENFORCE_MODE;
  let enforceModeSource: ThreadConfigSource = 'default';
  let enforceMinTurnMinutes = THREAD_DEFAULT_ENFORCE_MIN_TURN_MINUTES;
  let enforceMinTurnMinutesSource: ThreadConfigSource = 'default';
  for (const layer of layers) {
    const section = threadSectionIn(layer.config);
    const mode = section?.enforceMode;
    if (mode !== undefined) {
      if (isThreadEnforceMode(mode)) {
        enforceMode = mode;
        enforceModeSource = layer.name;
      } else {
        problems.push(
          `componentConfig.thread.enforceMode in the ${layer.name} config is ${JSON.stringify(mode)}, which is not one of ${THREAD_ENFORCE_MODES.join(', ')} — ignoring it and using ${enforceMode}.`,
        );
      }
    }
    const minutes = section?.enforceMinTurnMinutes;
    if (minutes !== undefined) {
      if (
        typeof minutes === 'number' &&
        Number.isFinite(minutes) &&
        minutes > 0
      ) {
        enforceMinTurnMinutes = minutes;
        enforceMinTurnMinutesSource = layer.name;
      } else {
        problems.push(
          `componentConfig.thread.enforceMinTurnMinutes in the ${layer.name} config is ${JSON.stringify(minutes)}, which is not a positive number — ignoring it and using ${enforceMinTurnMinutes}.`,
        );
      }
    }
  }

  // epic home-base-mbnjv C1: the handoff block, field by field, with its own
  // problems (a bad value is named and ignored, like enforceMode above).
  const handoff = resolveHandoffConfig(
    layers.map((layer) => ({
      name: layer.name,
      section: threadSectionIn(layer.config)?.handoff,
    })),
    problems,
  );

  // home-base-bomy5.7.1: the project file only — a user-level tag would put
  // one tag on every repo. A bad value is NAMED and ignored, like `stages`.
  let projectTag: string | null = null;
  if (project.status === 'ok') {
    const declared = (project.config as {projectTag?: unknown}).projectTag;
    if (declared !== undefined) {
      if (typeof declared === 'string' && PROJECT_TAG_FORMAT.test(declared)) {
        projectTag = declared;
      } else {
        problems.push(
          `projectTag in ${project.path} is ${JSON.stringify(declared)}, which is not 1 to 12 characters from A-Z, 0-9 and "-" — ignoring it and naming sessions after the repo folder.`,
        );
      }
    }
  }

  return {
    answerUi,
    answerUiSource,
    autoCommit: autoCommit.value,
    autoCommitSource: autoCommit.source,
    autoPush: autoPush.value,
    autoPushSource: autoPush.source,
    capture: capture.value,
    captureActive: enabled.value && capture.value,
    captureSource: capture.source,
    dashboardUi,
    dashboardUiSource,
    emojiHeader,
    emojiHeaderSource,
    enabled: enabled.value,
    enforce: enforce.value,
    enforceMinTurnMinutes,
    enforceMinTurnMinutesSource,
    enforceMode,
    enforceModeSource,
    enforceSource: enforce.source,
    handoff,
    nameWorkspaces: nameWorkspaces.value,
    nameWorkspacesSource: nameWorkspaces.source,
    nudge: nudge.value,
    nudgeSource: nudge.source,
    openSince,
    openSinceSource,
    pinnedProjects,
    pinnedProjectsSource,
    problems,
    projectRoot,
    projectTag,
    repoDir,
    repoDirSource,
    sessionBeads: sessionBeads.value,
    sessionBeadsSource: sessionBeads.source,
    source: enabled.source,
    stages,
    stagesSource,
  };
}

/**
 * The repo's PRIMARY checkout for a session checkout (home-base-bomy5.7.2),
 * found without spawning git:
 *   1. a path containing "/.claude/worktrees/" → the prefix before it (a pure
 *      string rule, so it also works for a worktree that is gone; shared with
 *      the beads DB resolver in src/claude-worktree-path.ts);
 *   2. a checkout whose `.git` is a FILE reading
 *      `gitdir: <primary>/.git/worktrees/<name>` → `<primary>`;
 *   3. otherwise the checkout itself.
 *
 * Rule 3 also covers "could not tell" (no `.git`, an unreadable one, a gitdir
 * that is a submodule's or a bare repo's): the tag then comes from the
 * checkout's own config, which is what it did before this rule existed. The
 * answer only picks which config file names the tag; nothing decides safety
 * from it.
 */
export function primaryCheckoutOf(checkout: string): string {
  const fromPath = primaryOfClaudeWorktreePath(checkout);
  if (fromPath != null) return fromPath;
  const dotGit = join(checkout, '.git');
  let text: string;
  try {
    if (!statSync(dotGit).isFile()) return checkout;
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return checkout;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match?.[1] == null) return checkout;
  const gitdir = resolve(checkout, match[1]);
  const worktrees = dirname(gitdir);
  const common = dirname(worktrees);
  if (basename(worktrees) !== 'worktrees' || basename(common) !== '.git') {
    return checkout;
  }
  return dirname(common);
}

/**
 * One directory's declared `projectTag` (null: none, invalid, or no such
 * directory), read once per directory when `cache` is given.
 */
function declaredTagAt(
  dir: string,
  env: EnvLike | undefined,
  cache: Map<string, string | null> | undefined,
): string | null {
  if (cache?.has(dir) === true) return cache.get(dir) ?? null;
  const declared = existsSync(dir)
    ? resolveThreadConfig({cwd: dir, env}).projectTag
    : null;
  cache?.set(dir, declared);
  return declared;
}

/**
 * The tag a session's name starts with (home-base-bomy5.7.1), read from THAT
 * session's repo — never the caller's, so a cross-repo inbox shows each repo's
 * own tag. In order:
 *   1. the `projectTag` of the repo's PRIMARY checkout (`primaryCheckoutOf`,
 *      home-base-bomy5.7.2): one tag per project, so a worktree that branched
 *      before the tag was committed still shows it;
 *   2. the `projectTag` of the session's own checkout, when the primary
 *      declares none (or is gone, or declares an invalid one);
 *   3. the repo folder name uppercased.
 * An invalid tag is skipped at its step and is also a config problem, which
 * `resolveThreadConfig` names. Null only when the repo itself is unknown.
 *
 * `cache` (one inbox build's, keyed by directory) reads each primary's config
 * once however many sessions share it.
 */
export function resolveRepoTag(input: {
  cache?: Map<string, string | null>;
  checkout: string | null;
  env?: EnvLike;
  repo: string;
}): string;
export function resolveRepoTag(input: {
  cache?: Map<string, string | null>;
  checkout: string | null;
  env?: EnvLike;
  repo: string | null;
}): string | null;
export function resolveRepoTag(input: {
  cache?: Map<string, string | null>;
  checkout: string | null;
  env?: EnvLike;
  repo: string | null;
}): string | null {
  if (input.repo == null) return null;
  if (input.checkout != null) {
    const primary = primaryCheckoutOf(input.checkout);
    const dirs =
      primary === input.checkout ? [primary] : [primary, input.checkout];
    for (const dir of dirs) {
      const declared = declaredTagAt(dir, input.env, input.cache);
      if (declared != null) return declared;
    }
  }
  return input.repo.toUpperCase();
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
