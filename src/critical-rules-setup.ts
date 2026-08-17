/**
 * critical-rules-setup — the COMMITTED per-repo critical-rules artifact.
 *
 * Writes `.claude/rules/justin-sdk/critical-rules.md` into the consuming
 * project: a generated file, committed to the repo, that Claude Code autoloads
 * at CLAUDE.md priority with no truncation cap. It supersedes the user-level
 * `~/.claude/rules/` delivery for enrolled repos (home-base-t6a0.21 D1), because
 * a committed file is the only channel that reaches Claude Code web, CI, a fresh
 * clone, and a new machine — and because when it fails, it fails VISIBLY in a
 * diff instead of silently omitting every rule.
 *
 * TWO LAYERS, deliberately separate (t6a0.21 D2 + the Dispatch-B addendum):
 *
 *   (a) refreshCriticalRulesArtifact() — reads the module selection ALREADY
 *       recorded in justin-sdk.config.json, assembles, and writes the artifact.
 *       Touches NOTHING else: no config rewrite, no SDK pin, no lastSynced. This
 *       is the layer `rules-update` (home-base-q1hp) calls, because it must
 *       commit only paths under .claude/rules/justin-sdk/.
 *
 *   (b) runCriticalRulesSetup() — enrollment: the base-setup chain, seeding the
 *       module list, then (a). This is what `add critical-rules` and
 *       `sweep --component critical-rules` run; the sweep's pin-neutrality guard
 *       absorbs base-setup's config drift.
 *
 * OPT-IN MODULE SELECTION (D12): the selection is an EXPLICIT list of module
 * names in `componentConfig["critical-rules"].modules`, seeded ONCE at
 * enrollment by running the predicates and recording their RESULT. Assembly
 * never evaluates a predicate. That is what structurally kills the t6a0.20
 * failure class, where an includeIf naming a predicate the running SDK didn't
 * know silently deleted a module from delivery. The list is visible in config
 * and hand-editable, so "which rules does this repo get?" is answerable by
 * reading one file.
 *
 * FRESHNESS IS NOT OPTIONAL FOR A WRITER (D15): the managed prompts clone
 * tolerates a failed refresh by keeping the old checkout — correct for a reader,
 * unacceptable here. If the refresh failed we ABORT with a distinct
 * cannot-refresh outcome and write nothing, so a stale clone can never become a
 * committed artifact and "couldn't check" is never reported as "in sync".
 */

import {existsSync, mkdirSync, renameSync, writeFileSync} from 'fs';
import {basename, dirname, relative, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  assembleSelected,
  describeIndexModules,
  isDirtyCheckout,
  PROMPTS_SOURCE_FAILURE,
  type IndexModule,
  type SourceRefresh,
} from './plugin/lib/prime';
import {
  buildStamp,
  contentHash,
  prettierMarkdown,
  projectRulesFilePath,
  readDeployedStamp,
  RULES_UPDATE_CMD,
} from './plugin/lib/rules-file';
import {
  fail,
  findLocalPrettier,
  isQuiet,
  readJson,
  setQuiet,
  stepHeader,
  success,
  todayIsoDate,
  warn,
  writeJson,
} from './setup-helpers';

/** Key under `componentConfig` in justin-sdk.config.json. */
export const CRITICAL_RULES_CONFIG_KEY = 'critical-rules';

/**
 * Universal modules kept OUT of the default seed.
 *
 * s2t-guidelines describes Justin's speech-to-text workflow and the "Dakota"
 * wake word. Four enrolled repos are public on GitHub and no tool can reliably
 * detect repo publicness, so the conservative default is OUT everywhere; Justin
 * opts it in per private repo by adding the name to the config (D6 refined by
 * D12).
 */
export const DEFAULT_SEED_EXCLUDED: readonly string[] = ['s2t-guidelines'];

// ---------------------------------------------------------------------------
// Module selection
// ---------------------------------------------------------------------------

/**
 * The default seed (D12): every universal module except the explicitly excluded
 * ones, plus each project-type module whose predicates match RIGHT NOW. Index
 * order is preserved. Predicates run here, at enrollment, and nowhere else.
 */
export function computeDefaultModules(
  modules: readonly IndexModule[],
): string[] {
  return modules
    .filter((m) => (m.includeIf.length === 0 ? true : m.matches))
    .map((m) => m.name)
    .filter((name) => !DEFAULT_SEED_EXCLUDED.includes(name));
}

export type SelectionRead =
  | {ok: true; modules: string[]}
  | {ok: false; status: 'not-enrolled' | 'failed'; message: string};

/**
 * Read the recorded module selection.
 *
 * Every failure is its own state — "no config file", "corrupt config", "no
 * selection recorded", "the list is not a list of names" and "the list is
 * empty" are five different facts and none of them may read as "assemble
 * nothing" (which would write an artifact stripped of every rule and report
 * success).
 */
export function readSelectedModules(projectRoot: string): SelectionRead {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    // readJson returns null for BOTH "missing" and "unparseable", which are not
    // the same fact — re-read the existence to tell them apart.
    return existsSync(configPath)
      ? {
          message: `justin-sdk.config.json at ${configPath} could not be parsed — refusing to guess the module selection`,
          ok: false,
          status: 'failed',
        }
      : {
          message: `justin-sdk.config.json not found in ${projectRoot} — run \`add critical-rules\` to enroll`,
          ok: false,
          status: 'not-enrolled',
        };
  }

  const componentConfig = config.componentConfig as
    | Record<string, unknown>
    | undefined;
  const block = componentConfig?.[CRITICAL_RULES_CONFIG_KEY];
  if (block == null) {
    return {
      message:
        `no componentConfig["${CRITICAL_RULES_CONFIG_KEY}"] in justin-sdk.config.json — ` +
        `this repo has no recorded module selection; run \`add critical-rules\` to enroll`,
      ok: false,
      status: 'not-enrolled',
    };
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return {
      message: `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"] must be an object with a "modules" array`,
      ok: false,
      status: 'failed',
    };
  }
  const raw = (block as Record<string, unknown>).modules;
  if (
    !Array.isArray(raw) ||
    raw.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    return {
      message: `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].modules must be an array of module names`,
      ok: false,
      status: 'failed',
    };
  }
  if (raw.length === 0) {
    return {
      message:
        `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].modules is empty — ` +
        `nothing to assemble. Add module names, or remove the component from "components".`,
      ok: false,
      status: 'failed',
    };
  }
  return {modules: raw as string[], ok: true};
}

// ---------------------------------------------------------------------------
// Layer (a): refresh the artifact and NOTHING else
// ---------------------------------------------------------------------------

export interface RefreshSuccess {
  status: 'written' | 'unchanged';
  /** Absolute path of the artifact. */
  file: string;
  contentHash: string;
  /** The selection that was assembled, in config order. */
  modules: string[];
  /** Modules actually inlined (index order). */
  assembled: string[];
  /** prompts-repo HEAD sha, or null when the source isn't a git checkout. */
  sourceSha: string | null;
  sourceRefresh: SourceRefresh;
  warnings: string[];
}

export interface RefreshFailure {
  status: 'not-enrolled' | 'cannot-refresh' | 'failed';
  message: string;
}

export type RefreshOutcome = RefreshSuccess | RefreshFailure;

export function refreshSucceeded(
  outcome: RefreshOutcome,
): outcome is RefreshSuccess {
  return outcome.status === 'written' || outcome.status === 'unchanged';
}

export interface RefreshOptions {
  /** Rewrite even when the content hash is unchanged. */
  force?: boolean;
  /** Stamp date (YYYY-MM-DD). Injectable so tests can pin it. */
  now?: string;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
  /**
   * Toggle the shared QUIET flag. Omit to leave it exactly as the caller set it
   * — the installer sets it once and this layer must not clobber that.
   */
  quiet?: boolean;
}

/**
 * A refresh state a WRITER may generate from. 'skipped' (the staleness gate
 * decided no refresh was needed) is deliberately NOT here: this function always
 * forces a refresh, so anything short of a completed one means we could not
 * verify the source, and unverified is not permission to write (D15).
 */
function refreshIsVerified(refresh: SourceRefresh): boolean {
  return refresh === 'override' || refresh === 'cloned' || refresh === 'pulled';
}

/**
 * Regenerate the committed artifact from the recorded module selection.
 *
 * Writes exactly one path — `.claude/rules/justin-sdk/critical-rules.md` — and
 * touches nothing else in the project, which is the property that lets
 * `rules-update` commit a rules-only change. Never commits: committing belongs
 * to `rules-update` and to the sweep.
 */
export function refreshCriticalRulesArtifact(
  projectRoot: string,
  options: RefreshOptions = {},
): RefreshOutcome {
  if (options.quiet != null) setQuiet(options.quiet);

  const selection = readSelectedModules(projectRoot);
  if (!selection.ok) {
    fail(`critical-rules: ${selection.message}`);
    return {message: selection.message, status: selection.status};
  }

  let assembled;
  try {
    // forceUpdate is hardcoded, not an option: a writer must always try to
    // refresh, so that a failure to do so is detectable rather than assumed.
    assembled = assembleSelected(selection.modules, {
      forceUpdate: true,
      promptsDir: options.promptsDir,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // "there is no usable prompts checkout at all" is a cannot-CHECK, not a
    // wrong-content — same class as a failed refresh, and it must not be
    // reported as an assembly/selection defect.
    if (reason.startsWith(PROMPTS_SOURCE_FAILURE)) {
      const message = `${reason} — NOT writing the artifact`;
      fail(`critical-rules: ${message}`);
      return {message, status: 'cannot-refresh'};
    }
    const message = `could not assemble the selected rules modules (${reason})`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'failed'};
  }

  if (!refreshIsVerified(assembled.sourceRefresh)) {
    // The clone still has usable content — that is exactly the trap. Refuse.
    const message =
      `cannot refresh the prompts clone at ${assembled.sourceDir} ` +
      `(refresh: ${assembled.sourceRefresh}) — NOT writing the artifact from a possibly-stale checkout. ` +
      `Fix connectivity and re-run, or pass an explicit prompts dir.`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'cannot-refresh'};
  }

  const file = projectRulesFilePath(projectRoot);
  // Format with the TARGET REPO'S OWN prettier when it has one: this artifact is
  // committed and is checked by that repo's signal/lint-staged, and the sweep
  // gates on exactly that. A newer bunx prettier formatting it differently would
  // turn every swept repo red.
  const pretty = prettierMarkdown(assembled.markdown, {
    binary: findLocalPrettier(dirname(file)),
  });
  const hash = contentHash(pretty);

  for (const warning of assembled.warnings) warn(warning);

  const common = {
    assembled: assembled.names,
    contentHash: hash,
    file,
    modules: selection.modules,
    sourceRefresh: assembled.sourceRefresh,
    sourceSha: assembled.sourceSha,
    warnings: assembled.warnings,
  };

  if (options.force !== true && readDeployedStamp(file)?.contentHash === hash) {
    success(
      `rules already in sync (content ${hash}, ${selection.modules.length} module${
        selection.modules.length === 1 ? '' : 's'
      }) — no rewrite`,
    );
    return {...common, status: 'unchanged'};
  }

  const shaShort =
    assembled.sourceSha != null ? assembled.sourceSha.slice(0, 12) : 'unknown';
  const dirtySuffix =
    assembled.sourceSha != null && isDirtyCheckout(assembled.sourceDir)
      ? '-dirty'
      : '';
  // No SDK version in the stamp, on purpose (see buildStamp): an SDK release
  // must not change the bytes of a committed file in twelve repos. A DATE rather
  // than a timestamp keeps two same-day regenerations byte-identical, and the
  // hash gate above means an in-sync repo never rewrites the date at all.
  const stamp = buildStamp({
    command: RULES_UPDATE_CMD,
    commit: `${shaShort}${dirtySuffix}`,
    contentHash: hash,
    generated: options.now ?? todayIsoDate(),
  });
  const body = `${stamp}\n\n${pretty}\n`;

  // Atomic write (a session can start mid-write).
  mkdirSync(dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);

  success(
    `wrote ${relative(projectRoot, file)}\n  commit ${shaShort}${dirtySuffix} · ` +
      `${selection.modules.length} module${selection.modules.length === 1 ? '' : 's'} · content ${hash}`,
  );
  return {...common, status: 'written'};
}

// ---------------------------------------------------------------------------
// Layer (b): enrollment
// ---------------------------------------------------------------------------

/**
 * Seed `componentConfig["critical-rules"].modules` with the default selection.
 *
 * Only writes when the block is absent — a repo whose selection has been tuned
 * by hand (s2t-guidelines opted in, a module dropped) must survive a re-run and
 * every future sweep untouched. That is the whole point of recording the
 * RESULT rather than re-deriving it.
 */
export function stepCriticalRulesConfig(
  projectRoot: string,
  options: {promptsDir?: string} = {},
): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    fail('justin-sdk.config.json missing or unparseable — run base-setup first');
    return false;
  }

  const componentConfig = ((config.componentConfig as
    | Record<string, unknown>
    | undefined) ?? {}) as Record<string, unknown>;

  if (componentConfig[CRITICAL_RULES_CONFIG_KEY] != null) {
    const existing = readSelectedModules(projectRoot);
    success(
      `justin-sdk.config.json already selects modules for ${CRITICAL_RULES_CONFIG_KEY}` +
        (existing.ok ? ` (${existing.modules.length})` : ''),
    );
    return true;
  }

  let described;
  try {
    described = describeIndexModules(projectRoot, {
      forceUpdate: true,
      promptsDir: options.promptsDir,
    });
  } catch (error) {
    fail(
      `could not read the rules index (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
  if (!refreshIsVerified(described.sourceRefresh)) {
    // Seeding from a stale index could record a module list that no longer
    // matches the source — same refusal as the write path, same reason (D15).
    fail(
      `cannot refresh the prompts clone at ${described.sourceDir} ` +
        `(refresh: ${described.sourceRefresh}) — not seeding a module selection from a possibly-stale index`,
    );
    return false;
  }
  for (const warning of described.warnings) warn(warning);

  const modules = computeDefaultModules(described.modules);
  if (modules.length === 0) {
    fail(
      `the rules index at ${described.sourceDir} yielded no modules — refusing to record an empty selection`,
    );
    return false;
  }

  componentConfig[CRITICAL_RULES_CONFIG_KEY] = {modules};
  config.componentConfig = componentConfig;
  writeJson(configPath, config);

  const gated = described.modules
    .filter((m) => m.includeIf.length > 0 && modules.includes(m.name))
    .map((m) => m.name);
  const excluded = described.modules
    .filter((m) => !modules.includes(m.name))
    .map((m) => m.name);
  success(
    `Added componentConfig.${CRITICAL_RULES_CONFIG_KEY} (${modules.length} modules)` +
      (gated.length > 0 ? `\n  project-type modules detected: ${gated.join(', ')}` : '') +
      (excluded.length > 0 ? `\n  not selected: ${excluded.join(', ')}` : ''),
  );
  return true;
}

export async function runCriticalRulesSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    extraComponents: ['critical-rules-setup'],
    projectRoot,
    quiet: true,
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with critical-rules-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader('1. justin-sdk.config.json (module selection)');
  if (!stepCriticalRulesConfig(projectRoot, {promptsDir: args.promptsDir}))
    return 1;

  stepHeader('2. .claude/rules/justin-sdk/critical-rules.md (the artifact)');
  const outcome = refreshCriticalRulesArtifact(projectRoot, {
    force: args.force,
    promptsDir: args.promptsDir,
  });
  if (!refreshSucceeded(outcome)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mcritical-rules-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        `The artifact is a GENERATED, COMMITTED file — commit it, and regenerate with \`${RULES_UPDATE_CMD}\`.\n` +
        `Tune which modules it carries under componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].modules.\n`,
    );
  }

  return 0;
}
