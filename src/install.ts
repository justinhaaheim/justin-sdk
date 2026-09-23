/**
 * install.ts — `justin-sdk install`, the reconciler (epic home-base-dchjw D3).
 *
 * npm's shape: `add`/`remove` edit the manifest, `install` makes the disk match
 * it. Before this, `update` could only ever re-apply a list that nothing could
 * shrink — components enrolled themselves as a side effect of running, so the
 * config grew and never shed, and a repo's disk state was the union of every
 * component that had ever run there.
 *
 *   - listed and missing  → install it
 *   - listed and present  → re-apply it (installers are idempotent)
 *   - present and NOT listed → SAID OUT LOUD, and left exactly where it is.
 *
 * INSTALL NEVER REMOVES (dchjw.17 F1, decided 2026-09-18). It used to: the
 * reconcile ran removals by default, and "this component is installed" was
 * decided by `componentInstalledEvidence`, which reads GENERIC FILENAMES
 * (.gitignore, tsconfig.json, .prettierrc.json) and VALUE-matched lines and
 * scripts. None of that is provenance — a `.gitignore` line a human wrote years
 * before the repo was enrolled is byte-identical to the one the SDK appends, so
 * it matched, so it was ours to delete. Measured on home-base's own committed
 * config (2026-09-18, `install --prune --dry-run` in the sdk-course-correction
 * worktree), a plain `install` would have deleted 14 .gitignore lines —
 * `.claude/worktrees/` among them, which this repo's CLAUDE.md requires on three
 * surfaces — plus .prettierrc.json entirely, .prettierignore lines and
 * package.json scripts, in a command whose name promises to ADD things.
 *
 * So removal now takes an explicit act: `remove <name…>` (you name the
 * component) or `install --prune` (you name the flag), both under remove.ts's
 * identity rules, and `--prune --dry-run` prints the whole plan — every path,
 * line, script, hook entry and config key with its verdict — before any of it
 * happens. The npm analogy stops at "install adds and re-applies": npm knows
 * what it installed because node_modules is its own, and we do not.
 *
 * The fleet is 13 repos still carrying configs written by older SDKs, so
 * install also does the one-time migrations they need: the retired `version`
 * and `lastSynced` stamps are dropped by base-setup (one line each), and a
 * `componentConfig.critical-rules.modules` include-list gets ONE loud warning
 * (D2 deleted it from the schema; it is ignored, not honoured).
 */

import {existsSync} from 'fs';
import {resolve} from 'path';

import {componentInstalledEvidence} from './component-manifest';
import {
  COMPONENT_NAMES,
  componentApplicability,
  type ComponentName,
  componentNameForConfigName,
  configNameFor,
  resolveComponents,
  unknownComponentNames,
} from './component-registry';
import {runComponentByName} from './components';
import {removeComponent, renderOutcome, summarizeRemoval} from './remove';
import {
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
} from './setup-helpers';

export interface InstallOptions {
  /** Print the plan and change nothing. */
  dryRun?: boolean;
  force?: boolean;
  projectRoot: string;
  /**
   * Also REMOVE components that are on disk but absent from `components`.
   *
   * OFF by default and off for every caller inside the SDK — the sweep, update,
   * doctor's advice. It exists so that a human who has read `--prune --dry-run`
   * and agrees with it can act on it in one command; it is never reached by
   * habit or by a code path that did not type the word.
   */
  prune?: boolean;
  quiet?: boolean;
  /**
   * The remote `stepDepsHasSdk` verifies the pin tag against. Tests point this
   * at a local bare repo so an install is hermetic; production omits it and gets
   * the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

export interface InstallPlan {
  /** Config names to apply, in dependency order. */
  apply: ComponentName[];
  /** Listed components whose `includeIf` does not pass in this repo. */
  listedButNotApplicable: ComponentName[];
  /** Names in `components` that no longer name a component. */
  unknown: string[];
  /**
   * Components with evidence on disk that the config does not list.
   *
   * NOT "to remove": nothing here is removed without `--prune`, and the
   * evidence behind it (a generic filename, a value-matched line) is not
   * provenance. Named for what it is — unlisted — so no caller can read a
   * deletion into it (dchjw.17 F1).
   */
  unlisted: ComponentName[];
}

/**
 * Work out what reconciling would do, without doing any of it. Exposed so
 * tests (and a future `--dry-run` caller) can assert the plan directly rather
 * than inferring it from side effects.
 */
export function planInstall(
  projectRoot: string,
  config: unknown,
): InstallPlan | {error: string} {
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) return {error: resolved.reason};

  const unknown = unknownComponentNames(resolved.components);
  const wanted = new Set<ComponentName>();
  for (const configName of resolved.components) {
    const name = componentNameForConfigName(configName);
    if (name != null) wanted.add(name);
  }

  const applicability = new Map(
    componentApplicability(projectRoot).map((entry) => [entry.name, entry]),
  );

  const apply: ComponentName[] = [];
  const unlisted: ComponentName[] = [];
  const listedButNotApplicable: ComponentName[] = [];
  for (const name of COMPONENT_NAMES) {
    if (wanted.has(name)) {
      apply.push(name);
      if (applicability.get(name)?.applicable === false) {
        listedButNotApplicable.push(name);
      }
      continue;
    }
    if (componentInstalledEvidence(projectRoot, name).installed) {
      unlisted.push(name);
    }
  }

  return {apply, listedButNotApplicable, unknown, unlisted};
}

/**
 * ONE loud line for a config that still carries the retired per-repo rules
 * include-list (D2). It is not deleted here: it is a human's list, and the
 * fleet sweep is what takes it out. Saying nothing would let a repo go on
 * believing its module selection was being honoured.
 */
function warnOnRetiredModules(config: Record<string, unknown>): void {
  const componentConfig = config.componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object') return;
  const rules = (componentConfig as Record<string, unknown>)['critical-rules'];
  if (rules == null || typeof rules !== 'object') return;
  if (!('modules' in (rules as Record<string, unknown>))) return;
  warn(
    'componentConfig.critical-rules.modules is no longer honoured — delete it. The rules a repo gets are decided by the prompts registry and its predicates at every refresh, never by a list frozen at enrollment (D2).',
  );
}

/** Run `install`. Returns an exit code (0 = success). */
export async function runInstall(options: InstallOptions): Promise<number> {
  const projectRoot = resolve(options.projectRoot);
  const quiet = options.quiet ?? false;
  const dryRun = options.dryRun ?? false;
  const prune = options.prune ?? false;
  setQuiet(quiet);

  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) {
    fail(
      'justin-sdk.config.json not found. Run `bun run justin-sdk init` first.',
    );
    return 1;
  }
  const config = readJson(configPath) ?? {};

  stepHeader('1. Read justin-sdk.config.json');
  // base-setup deletes these, but it runs QUIET inside the apply loop below, so
  // its own line never reaches the operator. Say it here, once per key, while
  // the config still has them: a key vanishing from a committed file with no
  // output is exactly the kind of silent edit a fleet sweep must not make.
  for (const key of ['version', 'lastSynced']) {
    if (key in config) {
      warn(
        `justin-sdk.config.json has the retired "${key}" key — it was written by the SDK and read by nothing (D3). Dropping it; the package.json pin is the version.`,
      );
    }
  }
  warnOnRetiredModules(config);

  const plan = planInstall(projectRoot, config);
  if ('error' in plan) {
    fail(`${plan.error} — fix it and re-run; nothing was applied.`);
    return 1;
  }

  for (const name of plan.unknown) {
    warn(
      `"${name}" in justin-sdk.config.json#components is not a component this SDK knows. It is being IGNORED, not removed — delete it from the config yourself, or upgrade the SDK.`,
    );
  }
  for (const name of plan.listedButNotApplicable) {
    warn(
      `${configNameFor(name)} is listed explicitly but does not apply to this repo (its includeIf predicate does not pass). Applying it anyway because the config asks for it.`,
    );
  }
  success(
    `${plan.apply.length} component(s) to apply, ${plan.unlisted.length} on disk but not listed`,
  );

  // ---------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------
  stepHeader('2. Apply listed components');
  for (const name of plan.apply) {
    if (dryRun) {
      success(`(dry-run) would apply ${name}`);
      continue;
    }
    setQuiet(quiet);
    const exitCode = await runComponentByName(name, {
      force: options.force ?? false,
      noCommit: true,
      projectRoot,
      quiet: true,
      ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
    });
    setQuiet(quiet);
    if (exitCode !== 0) {
      fail(`${name} failed (exit ${exitCode}); aborting install.`);
      return exitCode;
    }
    success(`${name}: applied`);
  }

  // ---------------------------------------------------------------------
  // Components on disk that the config does not list
  // ---------------------------------------------------------------------
  stepHeader('3. Components on disk that the config does not list');
  if (plan.unlisted.length === 0) {
    success('Nothing on disk that the config does not list');
    return 0;
  }

  if (prune !== true) {
    warn(
      `${plan.unlisted.length} component(s) are on disk but absent from justin-sdk.config.json#components, and are being KEPT: ${plan.unlisted.join(', ')}. install NEVER removes (dchjw.17 F1) — "installed" here is evidence like a filename or a matching line, which is not proof the SDK put it there. To take any of them out, read the plan first with \`bun run justin-sdk install --prune --dry-run\`, then run \`bun run justin-sdk remove <name…>\` or \`install --prune\`.`,
    );
    return 0;
  }

  // --prune. Print the WHOLE plan first — every path, line, script, hook entry
  // and config key, each with its verdict — because "would remove gitignore" is
  // not something a human can consent to, and this list is (dchjw.17 F6).
  warn(
    `--prune: these components are on disk but absent from justin-sdk.config.json#components: ${plan.unlisted.join(', ')}. Only files byte-identical to what the SDK would write now, and entries matching exactly, are touched; everything else is reported and left. The full plan follows.`,
  );
  for (const name of plan.unlisted) {
    stepHeader(`${dryRun ? '(dry-run) ' : ''}prune ${name}`);
    const planned = removeComponent(projectRoot, name, {dryRun: true});
    if (planned.outcomes.length === 0) {
      warn(
        `${name}: nothing this component owns is present — its installed-evidence came from something it does not own outright, and --prune would delete NOTHING for it.`,
      );
      continue;
    }
    for (const outcome of planned.outcomes) {
      const line = renderOutcome(outcome, {planned: true});
      if (outcome.kind === 'removed') warn(line);
      else success(line);
    }
    if (planned.deregistered) {
      warn(`would drop ${configNameFor(name)} from justin-sdk.config.json`);
    }
  }
  if (dryRun) {
    success('(dry-run) nothing was changed');
    return 0;
  }

  for (const name of plan.unlisted) {
    stepHeader(`removing ${name}`);
    const report = removeComponent(projectRoot, name);
    for (const outcome of report.outcomes) {
      if (outcome.kind === 'removed') {
        success(renderOutcome(outcome));
      } else {
        warn(renderOutcome(outcome));
      }
    }
    success(summarizeRemoval(report));
  }

  return 0;
}
