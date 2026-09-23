/**
 * remove.ts — `justin-sdk remove <component…>`, the mirror of `add`.
 *
 * THE RULE (epic home-base-dchjw D3, constraint F7): removal is by IDENTITY,
 * never by name. A file goes only when its bytes are identical to what the
 * component would write into this repo right now; an appended entry goes only
 * on an exact match of the value the component writes. Everything else is
 * REPORTED and left exactly where it is.
 *
 * Three outcomes per artifact, and they are three different lines, because
 * collapsing them is how a tool ends up deleting someone's config and calling
 * it a clean run (critical rule 6):
 *
 *   removed: <what>
 *   left in place (modified): <what>
 *   left in place (content not reconstructible): <what>
 *
 * The last one is the honest answer for a beads database, a generated rules
 * artifact or a composed husky hook: we could not compute what "pristine" means,
 * so we did not look, so we do not delete. `--force` does NOT exist here on
 * purpose — a flag that turns "I could not verify this" into "delete it anyway"
 * is the whole hazard this design is built to remove.
 */

import {existsSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {resolve} from 'path';

import {removeComponentsFromConfig} from './base-setup';
import {
  COMPONENT_MANIFESTS,
  componentInstalledEvidence,
  hookEntriesFor,
} from './component-manifest';
import {
  COMPONENT_NAMES,
  type ComponentName,
  configNameFor,
} from './component-registry';
import {
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type RemovalOutcome =
  | {kind: 'removed'; what: string}
  | {kind: 'modified'; what: string}
  | {kind: 'unreconstructible'; what: string};

export interface RemovalReport {
  /** True when the component's name was dropped from `components`. */
  deregistered: boolean;
  name: ComponentName;
  outcomes: RemovalOutcome[];
}

/**
 * One line per artifact.
 *
 * `planned` only changes the tense of the DELETE line. "left in place" is a
 * statement of fact that is equally true in a plan and in a run — the artifact
 * is staying either way — and giving it a second spelling would suggest the
 * plan and the run can disagree about it. They cannot: both come from the same
 * function (dchjw.17 F6).
 */
export function renderOutcome(
  outcome: RemovalOutcome,
  options: {planned?: boolean} = {},
): string {
  switch (outcome.kind) {
    case 'removed':
      return options.planned === true
        ? `would remove: ${outcome.what}`
        : `removed: ${outcome.what}`;
    case 'modified':
      return `left in place (modified): ${outcome.what}`;
    case 'unreconstructible':
      return `left in place (content not reconstructible): ${outcome.what}`;
  }
}

/** One line per component, for `remove`'s and `install`'s summaries. */
export function summarizeRemoval(report: RemovalReport): string {
  const removed = report.outcomes.filter((o) => o.kind === 'removed').length;
  const kept = report.outcomes.length - removed;
  const keptNote = kept > 0 ? `, ${kept} left in place` : '';
  return `${report.name}: ${removed} artifact(s) removed${keptNote}`;
}

// ---------------------------------------------------------------------------
// The removal itself
// ---------------------------------------------------------------------------

export interface RemovalOptions {
  /**
   * Compute the report and write NOTHING.
   *
   * There is one code path, not two: every verdict below is reached the same
   * way in both modes and only the write is skipped, so the plan a `--prune
   * --dry-run` prints is the run, minus the writes. A separate "planner" that
   * re-derived the verdicts could drift from the remover, and the one thing a
   * preview of a delete must never be is approximately right (dchjw.17 F6).
   */
  dryRun?: boolean;
}

function writeTextPreservingTrailingNewline(
  absolute: string,
  content: string,
): void {
  writeFileSync(absolute, content.endsWith('\n') ? content : `${content}\n`);
}

/**
 * Drop the exact lines a component appends to an ignore file it does not own
 * outright, plus its section header once the section is empty.
 *
 * Matching is on the TRIMMED line and is exact — `tmp/` is not `tmp`, and a
 * line someone reworded is a line someone wrote.
 */
function removeIgnoreLines(
  projectRoot: string,
  name: ComponentName,
  alreadyRemovedFiles: ReadonlySet<string>,
  dryRun: boolean,
): RemovalOutcome[] {
  const outcomes: RemovalOutcome[] = [];
  for (const owned of COMPONENT_MANIFESTS[name].ignoreLines) {
    // The whole file already went (it was pristine) — nothing to prune.
    if (alreadyRemovedFiles.has(owned.file)) continue;
    const absolute = resolve(projectRoot, owned.file);
    if (!existsSync(absolute)) continue;

    let content: string;
    try {
      content = readFileSync(absolute, 'utf-8');
    } catch {
      outcomes.push({kind: 'unreconstructible', what: owned.file});
      continue;
    }

    const wanted = new Set(owned.lines.map((line) => line.trim()));
    const lines = content.split('\n');
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const line of lines) {
      if (wanted.has(line.trim())) {
        dropped.push(line.trim());
        continue;
      }
      kept.push(line);
    }

    if (owned.sectionHeader != null) {
      const headerIndex = kept.findIndex(
        (line) => line.trim() === owned.sectionHeader?.trim(),
      );
      // Only when the section it introduces is now empty to the end of the
      // file — which is the shape `ensureIgnoreEntries` appends.
      if (
        headerIndex >= 0 &&
        kept.slice(headerIndex + 1).every((line) => line.trim() === '')
      ) {
        kept.splice(headerIndex);
        while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') {
          kept.pop();
        }
        kept.push('');
        dropped.push(owned.sectionHeader);
      }
    }

    if (dropped.length === 0) continue;
    if (!dryRun) writeTextPreservingTrailingNewline(absolute, kept.join('\n'));
    for (const entry of dropped) {
      outcomes.push({kind: 'removed', what: `${owned.file} line '${entry}'`});
    }
  }
  return outcomes;
}

/** Remove owned package.json scripts (exact value) and owned top-level blocks. */
function removePackageJsonEntries(
  projectRoot: string,
  name: ComponentName,
  dryRun: boolean,
): RemovalOutcome[] {
  const manifest = COMPONENT_MANIFESTS[name];
  if (manifest.scripts.length === 0 && manifest.jsonBlocks.length === 0) {
    return [];
  }
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const pkg = readJson(pkgPath);
  if (pkg == null) {
    return [{kind: 'unreconstructible', what: 'package.json (unparseable)'}];
  }

  const outcomes: RemovalOutcome[] = [];
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  let changed = false;

  for (const {key, shared, value} of manifest.scripts) {
    // Not this component's alone (see OwnedScript.shared) — not ours to delete,
    // even when the value matches exactly. base-setup owns the signal-source
    // trio, and `prebuild` belongs to version-manager in repos that have no eas.
    if (shared === true) continue;
    if (!(key in scripts)) continue;
    if (scripts[key] !== value) {
      outcomes.push({kind: 'modified', what: `package.json scripts.${key}`});
      continue;
    }
    delete scripts[key];
    changed = true;
    outcomes.push({kind: 'removed', what: `package.json scripts.${key}`});
  }

  for (const {key, value} of manifest.jsonBlocks) {
    if (!(key in pkg)) continue;
    if (JSON.stringify(pkg[key]) !== JSON.stringify(value)) {
      outcomes.push({kind: 'modified', what: `package.json ${key}`});
      continue;
    }
    delete pkg[key];
    changed = true;
    outcomes.push({kind: 'removed', what: `package.json ${key}`});
  }

  if (changed && !dryRun) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
  }
  return outcomes;
}

/**
 * Remove owned `.claude/settings.json` hook entries — by EXACT command match.
 *
 * The fingerprint (`justin-sdk time-check`) says "a hook of this component is
 * here in some generation of spelling"; it does NOT say the command is ours to
 * delete. `bun run justin-sdk time-check && my-own-thing` contains the
 * fingerprint and is a command a human composed, and deleting the whole entry
 * would take their half with it (dchjw.17 F5). So the fingerprint FINDS and the
 * exact command DECIDES: identical to what the installer writes today → removed;
 * anything else → `left in place (modified)`, the same rule as a file's bytes.
 */
function removeSettingsHooks(
  projectRoot: string,
  name: ComponentName,
  dryRun: boolean,
): RemovalOutcome[] {
  const manifest = COMPONENT_MANIFESTS[name];
  if (manifest.hooks.length === 0) return [];
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  const settings = readJson(settingsPath);
  if (settings == null) {
    return [
      {
        kind: 'unreconstructible',
        what: '.claude/settings.json (unparseable — refusing to rewrite it)',
      },
    ];
  }

  const outcomes: RemovalOutcome[] = [];
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let changed = false;

  for (const owned of manifest.hooks) {
    const entries = hooks[owned.event];
    if (!Array.isArray(entries)) continue;
    if (
      !hookEntriesFor(settings, owned.event).some((command) =>
        command.includes(owned.fingerprint),
      )
    ) {
      continue;
    }

    let removedHere = false;
    const nextEntries: unknown[] = [];
    for (const entry of entries) {
      if (entry == null || typeof entry !== 'object') {
        nextEntries.push(entry);
        continue;
      }
      const inner = (entry as {hooks?: unknown}).hooks;
      if (!Array.isArray(inner)) {
        nextEntries.push(entry);
        continue;
      }
      const keptInner = inner.filter((hook) => {
        const command = (hook as {command?: unknown} | null)?.command;
        if (typeof command !== 'string') return true;
        if (command === owned.command) {
          removedHere = true;
          outcomes.push({
            kind: 'removed',
            what: `.claude/settings.json ${owned.event} hook (${command})`,
          });
          return false;
        }
        if (command.includes(owned.fingerprint)) {
          outcomes.push({
            kind: 'modified',
            what: `.claude/settings.json ${owned.event} hook (${command})`,
          });
        }
        return true;
      });
      if (keptInner.length === 0) continue;
      nextEntries.push({...(entry as object), hooks: keptInner});
    }

    if (!removedHere) continue;
    if (nextEntries.length === 0) {
      delete hooks[owned.event];
    } else {
      hooks[owned.event] = nextEntries;
    }
    changed = true;
  }

  if (changed && !dryRun) {
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    } else {
      settings.hooks = hooks;
    }
    writeJson(settingsPath, settings);
  }
  return outcomes;
}

/** Remove owned `componentConfig.<key>` blocks from justin-sdk.config.json. */
function removeConfigKeys(
  projectRoot: string,
  name: ComponentName,
  dryRun: boolean,
): RemovalOutcome[] {
  const manifest = COMPONENT_MANIFESTS[name];
  if (manifest.configKeys.length === 0) return [];
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) return [];
  const config = readJson(configPath);
  if (config == null) {
    return [
      {
        kind: 'unreconstructible',
        what: 'justin-sdk.config.json (unparseable — refusing to rewrite it)',
      },
    ];
  }

  const componentConfig = (config.componentConfig ?? {}) as Record<
    string,
    unknown
  >;
  const outcomes: RemovalOutcome[] = [];
  let changed = false;
  for (const {key, seeds} of manifest.configKeys) {
    if (!(key in componentConfig)) continue;
    const what = `justin-sdk.config.json componentConfig.${key}`;

    // Same identity rule as a file. These blocks hold TUNED SETTINGS — a
    // gapHours someone chose, an `enabled: false`, a wrapUpAt — and a reconcile
    // that drops a component must not take them with it. Only the untouched
    // seed goes.
    const seeded = seeds();
    if (seeded == null) {
      outcomes.push({kind: 'unreconstructible', what});
      continue;
    }
    if (JSON.stringify(componentConfig[key]) !== JSON.stringify(seeded)) {
      outcomes.push({kind: 'modified', what});
      continue;
    }

    delete componentConfig[key];
    changed = true;
    outcomes.push({kind: 'removed', what});
  }
  if (changed && !dryRun) {
    if (Object.keys(componentConfig).length === 0) {
      delete config.componentConfig;
    } else {
      config.componentConfig = componentConfig;
    }
    writeJson(configPath, config);
  }
  return outcomes;
}

/**
 * Take one component back out of a repo. Returns what it did (or what it
 * WOULD do, under `dryRun`) and what it refused to do; writes nothing it
 * cannot justify byte-for-byte.
 */
export function removeComponent(
  projectRoot: string,
  name: ComponentName,
  options: RemovalOptions = {},
): RemovalReport {
  const dryRun = options.dryRun ?? false;
  const manifest = COMPONENT_MANIFESTS[name];
  const outcomes: RemovalOutcome[] = [];

  const removedFiles = new Set<string>();
  for (const owned of manifest.files) {
    const absolute = resolve(projectRoot, owned.path);
    if (!existsSync(absolute)) continue;

    const pristine = owned.pristine();
    if (pristine == null) {
      outcomes.push({kind: 'unreconstructible', what: owned.path});
      continue;
    }

    let actual: string;
    try {
      actual = readFileSync(absolute, 'utf-8');
    } catch {
      // Unreadable is not "absent" and is certainly not "matches": report it
      // the same way as anything else we could not verify.
      outcomes.push({kind: 'unreconstructible', what: owned.path});
      continue;
    }

    if (actual !== pristine) {
      outcomes.push({kind: 'modified', what: owned.path});
      continue;
    }

    if (!dryRun) rmSync(absolute);
    removedFiles.add(owned.path);
    outcomes.push({kind: 'removed', what: owned.path});
  }

  outcomes.push(...removeIgnoreLines(projectRoot, name, removedFiles, dryRun));
  outcomes.push(...removePackageJsonEntries(projectRoot, name, dryRun));
  outcomes.push(...removeSettingsHooks(projectRoot, name, dryRun));
  outcomes.push(...removeConfigKeys(projectRoot, name, dryRun));

  const dropped = removeComponentsFromConfig(
    projectRoot,
    [configNameFor(name)],
    {dryRun},
  );
  return {deregistered: dropped.length > 0, name, outcomes};
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface RemoveOptions {
  projectRoot: string;
  quiet?: boolean;
}

/** Run `remove <component…>`. Returns an exit code (0 = success). */
export function runRemove(
  targets: readonly string[],
  opts: RemoveOptions,
): number {
  setQuiet(opts.quiet ?? false);

  if (targets.length === 0) {
    fail('remove needs at least one component name.');
    return 1;
  }

  const names: ComponentName[] = [];
  for (const target of targets) {
    if (!(COMPONENT_NAMES as readonly string[]).includes(target)) {
      fail(
        `Unknown component "${target}". Run \`justin-sdk list\` to see every component.`,
      );
      return 1;
    }
    const name = target as ComponentName;
    if (!COMPONENT_MANIFESTS[name].removable) {
      fail(
        `"${name}" cannot be removed: every component applies it, so a repo that has anything has this. Un-enrolling a repo means deleting justin-sdk.config.json yourself.`,
      );
      return 1;
    }
    if (!names.includes(name)) names.push(name);
  }

  for (const name of names) {
    stepHeader(`remove ${name}`);
    const evidence = componentInstalledEvidence(opts.projectRoot, name);
    if (!evidence.installed) {
      warn(`${name} is not installed here — nothing on disk to remove.`);
    }
    const report = removeComponent(opts.projectRoot, name);
    for (const outcome of report.outcomes) {
      if (outcome.kind === 'removed') {
        success(renderOutcome(outcome));
      } else {
        warn(renderOutcome(outcome));
      }
    }
    if (report.deregistered) {
      success(`justin-sdk.config.json components -= ${configNameFor(name)}`);
    }
    success(summarizeRemoval(report));
  }

  return 0;
}
