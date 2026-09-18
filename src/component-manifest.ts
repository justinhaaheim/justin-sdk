/**
 * component-manifest.ts — what each component OWNS, so `remove` and `install`
 * can take it back out again (epic home-base-dchjw D3, constraint F7).
 *
 * THE SAFETY MODEL, and why it is shaped this way. Until now the SDK could only
 * ADD: `add` wrote files, nothing took them away, and `update` re-applied a list
 * it could never shrink. Giving it a delete verb is the moment it becomes able
 * to destroy something a human wrote, so removal is built on identity, never on
 * names:
 *
 *   - A FILE is deleted only when its bytes are IDENTICAL to what the component
 *     would write into this repo right now. A `.prettierrc.json` someone tuned
 *     is not our file any more, whatever it is called.
 *   - An APPENDED ENTRY (a package.json script, a .gitignore line, a hook, a
 *     componentConfig block) is removed only on an exact match of the value the
 *     component writes. A script whose value was edited is left alone.
 *   - Anything we CANNOT reconstruct — a beads database, a generated rules
 *     artifact, a composed husky hook — has `pristine: null` and is NEVER
 *     deleted, only reported. "I cannot check" is not "it is safe to delete"
 *     (critical rule 6); the three outcomes are deleted / modified / unknown,
 *     and they print as three different lines.
 *
 * Drift between a manifest entry and its installer fails SAFE in every
 * direction: a stale expected value simply stops matching, so the artifact is
 * left in place and reported rather than removed. That is why the expected
 * values are IMPORTED from the installers wherever they are already constants —
 * accuracy where it is free, fail-safe where it is not.
 */

import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {type ComponentName, COMPONENT_NAMES} from './component-registry';
import {EAS_SCRIPTS} from './eas-setup';
import {
  ESLINT_CONFIG_TARGET,
  LINT_SCRIPTS,
  SIGNAL_SOURCE_LINT_KEY,
  SIGNAL_SOURCE_LINT_SCRIPT,
} from './eslint-setup';
import {WORKFLOW_RELATIVE_PATH} from './gh-actions-setup';
import {BASELINE_ENTRIES as GITIGNORE_BASELINE_ENTRIES} from './gitignore-setup';
import {DEFAULT_LINT_STAGED_CONFIG} from './husky-setup';
import {
  PRETTIER_SCRIPTS,
  PRETTIERIGNORE_BASELINE_ENTRIES,
  SIGNAL_SOURCE_PRETTIER_KEY,
  SIGNAL_SOURCE_PRETTIER_SCRIPT,
} from './prettier-setup';
import {
  THREAD_HOOK_EVENT,
  THREAD_START_HOOK_COMMAND,
  THREAD_START_HOOK_FINGERPRINT,
  THREAD_STOP_HOOK_COMMAND,
  THREAD_STOP_HOOK_EVENT,
  THREAD_STOP_HOOK_FINGERPRINT,
} from './thread-hooks-setup';
import {
  TIME_CHECK_HOOK_COMMAND,
  TIME_CHECK_HOOK_FINGERPRINT,
} from './time-check-setup';
import {TIME_CHECK_CONFIG_KEY, TIME_CHECK_DEFAULTS} from './time-check';
import {
  USAGE_CHECK_HOOK_COMMAND,
  USAGE_CHECK_HOOK_FINGERPRINT,
} from './usage-check-setup';
import {USAGE_CHECK_CONFIG_KEY, USAGE_CHECK_DEFAULTS} from './usage-check';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A file a component writes.
 *
 * `pristine` returns the exact bytes the component would write into this repo
 * today, or NULL when that content cannot be reconstructed (it is generated
 * from a network clone, composed at runtime, or is user data). Null is not
 * "empty" — it is the third outcome, and it forbids deletion.
 */
export interface OwnedFile {
  /** Repo-relative path. */
  path: string;
  pristine: () => string | null;
}

/** A package.json script the component adds, with the value it writes. */
export interface OwnedScript {
  key: string;
  value: string;
  /**
   * True when this key is NOT this component's alone — something else writes
   * it, or a repo without this component legitimately has it. A shared script
   * is neither evidence of an install nor ours to delete; it is listed here so
   * the overlap is documented rather than rediscovered.
   *
   * Two real cases, both found by running `list` against home-base:
   *   - `signal-source:TS|LINT|PRETTIER` — base-setup seeds all three into
   *     EVERY enrolled repo. Treating `signal-source:LINT` as proof of eslint
   *     made every repo look like it had eslint, and reconcile would then have
   *     "removed" a component that was never installed.
   *   - `prebuild` / `eas-build-post-install` — eas-setup writes them, but they
   *     are @justinhaaheim/version-manager scripts, and home-base (not an Expo
   *     app) has `prebuild` with the identical value. Deleting it on an `eas`
   *     reconcile would have broken a repo that never had the component.
   */
  shared?: boolean;
}

/** A `.claude/settings.json` hook entry, identified the way its installer does. */
export interface OwnedHook {
  event: string;
  /**
   * Substring of the hook command that identifies it across every generation of
   * spelling. DETECTION only: it answers "is this component's hook here?", not
   * "is this command mine to delete" (dchjw.17 F5).
   */
  fingerprint: string;
  /**
   * The exact command the installer writes TODAY. Removal deletes a hook only
   * on `command === this`; anything else that merely contains the fingerprint —
   * `bun run justin-sdk time-check && my-own-thing` — is a command a human
   * composed and is reported as modified, under the same identity rule as a
   * file's bytes.
   */
  command: string;
}

/** Lines a component appends to an ignore file it does not own outright. */
export interface OwnedIgnoreLines {
  /** Repo-relative ignore file. */
  file: string;
  lines: readonly string[];
  /** The `# …` section header its appender writes, if any. */
  sectionHeader: string | null;
}

export interface ComponentManifest {
  /** One line, for `justin-sdk list`. */
  purpose: string;
  /**
   * False for base-setup only: it is the foundation every installer applies,
   * so "removing" it would leave a repo that still has it, minus its config.
   */
  removable: boolean;
  files: readonly OwnedFile[];
  scripts: readonly OwnedScript[];
  hooks: readonly OwnedHook[];
  ignoreLines: readonly OwnedIgnoreLines[];
  /**
   * `componentConfig.<key>` blocks the component seeds, with the EXACT value it
   * seeds. Subject to the same identity rule as a file: a block someone tuned
   * (`gapHours: 4`, `enabled: false`, a wrapUpAt of their own) is theirs, and a
   * reconcile that dropped a component must not take those settings with it.
   *
   * `seeds: null` means the component claims the key but writes no default —
   * critical-rules is the case: everything under its key today was written by a
   * human or by a retired SDK, so it is reported and never deleted.
   */
  configKeys: readonly {key: string; seeds: () => unknown | null}[];
  /**
   * package.json top-level blocks the component seeds, removed only when they
   * still deep-equal the default it wrote.
   */
  jsonBlocks: readonly {key: string; value: unknown}[];
  /**
   * Paths whose EXISTENCE means "this component is installed" but which are
   * never removed (user data, generated artifacts). Detection only.
   */
  markers: readonly string[];
}

// ---------------------------------------------------------------------------
// Template bytes
// ---------------------------------------------------------------------------

/**
 * The bytes of an SDK template, or null when it cannot be read.
 *
 * Null propagates all the way to "never delete this file": a missing template
 * means we do not know what the component writes, and a comparison we could not
 * make must not resolve to "matches".
 */
function templateText(...segments: readonly string[]): string | null {
  const path = resolve(import.meta.dirname, '..', 'templates', ...segments);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function fromTemplate(path: string, ...segments: readonly string[]): OwnedFile {
  return {path, pristine: () => templateText(...segments)};
}

/** A file whose content cannot be reconstructed — reported, never deleted. */
function unreconstructible(path: string): OwnedFile {
  return {path, pristine: () => null};
}

// ---------------------------------------------------------------------------
// The manifests
// ---------------------------------------------------------------------------

const EMPTY = {
  configKeys: [] as readonly {key: string; seeds: () => unknown | null}[],
  files: [] as readonly OwnedFile[],
  hooks: [] as readonly OwnedHook[],
  ignoreLines: [] as readonly OwnedIgnoreLines[],
  jsonBlocks: [] as readonly {key: string; value: unknown}[],
  markers: [] as readonly string[],
  removable: true,
  scripts: [] as readonly OwnedScript[],
};

export const COMPONENT_MANIFESTS: Record<ComponentName, ComponentManifest> = {
  'base-setup': {
    ...EMPTY,
    // Not removable: every installer applies it, so a repo that has ANY
    // component has base-setup, and deleting justin-sdk.config.json is what
    // un-enrolling a repo means — a different, human-sized decision.
    markers: ['justin-sdk.config.json'],
    purpose:
      'The foundation: justin-sdk.config.json, the SDK devDependency, the shared package.json scripts and the SessionStart hook. Implicit — every other component applies it.',
    removable: false,
  },

  gitignore: {
    ...EMPTY,
    files: [fromTemplate('.gitignore', 'configs', '.gitignore.node-cli')],
    ignoreLines: [
      {
        file: '.gitignore',
        lines: GITIGNORE_BASELINE_ENTRIES,
        sectionHeader: '# justin-sdk baseline (appended)',
      },
    ],
    purpose: 'The baseline .gitignore entries every repo of Justin’s needs.',
  },

  prettier: {
    ...EMPTY,
    files: [
      fromTemplate('.prettierrc.json', 'configs', '.prettierrc.json'),
      fromTemplate('.prettierignore', 'configs', '.prettierignore'),
    ],
    ignoreLines: [
      {
        file: '.prettierignore',
        lines: PRETTIERIGNORE_BASELINE_ENTRIES,
        sectionHeader: null,
      },
    ],
    purpose:
      'Prettier config, ignore file and the prettier:*/signal-source:PRETTIER scripts.',
    scripts: [
      {
        key: SIGNAL_SOURCE_PRETTIER_KEY,
        shared: true,
        value: SIGNAL_SOURCE_PRETTIER_SCRIPT,
      },
      ...PRETTIER_SCRIPTS,
    ],
  },

  tsconfig: {
    ...EMPTY,
    files: [fromTemplate('tsconfig.json', 'configs', 'tsconfig.node-cli.json')],
    purpose: 'tsconfig.json and the signal-source:TS type-check entry.',
    scripts: [{key: 'signal-source:TS', shared: true, value: 'tsc --noEmit'}],
  },

  eslint: {
    ...EMPTY,
    files: [fromTemplate(ESLINT_CONFIG_TARGET, 'configs', 'eslint.config.cjs')],
    purpose:
      'eslint.config.cjs and the lint/lint:fix/signal-source:LINT scripts.',
    scripts: [
      {
        key: SIGNAL_SOURCE_LINT_KEY,
        shared: true,
        value: SIGNAL_SOURCE_LINT_SCRIPT,
      },
      ...LINT_SCRIPTS,
    ],
  },

  husky: {
    ...EMPTY,
    // .husky hooks are COMPOSED at install time from several fragments, so
    // their bytes are not a template we can diff against. Reported, not
    // removed — a pre-commit hook is exactly the kind of file people edit.
    files: [
      unreconstructible('.husky/pre-commit'),
      unreconstructible('.husky/post-checkout'),
    ],
    jsonBlocks: [{key: 'lint-staged', value: DEFAULT_LINT_STAGED_CONFIG}],
    purpose:
      'Husky git hooks (pre-commit signal, post-checkout hydration) and the lint-staged block.',
    scripts: [{key: 'prepare', value: 'husky'}],
  },

  'gh-actions': {
    ...EMPTY,
    files: [
      fromTemplate(
        WORKFLOW_RELATIVE_PATH,
        'configs',
        '.github',
        'workflows',
        'signal.yml',
      ),
    ],
    purpose: 'The GitHub Actions workflow that runs `signal` on every push.',
  },

  beads: {
    ...EMPTY,
    // .beads/ IS THE ISSUE DATABASE. It is user data, it is the thing every
    // rule in this repo calls the durable memory, and nothing here may delete
    // it — not even byte-identically. Detection only.
    hooks: [],
    markers: ['.beads'],
    // The purpose names three things and the manifest owns none of them, so
    // `remove beads` reports "0 artifact(s) removed" and looks broken. It is
    // not: .beads/ is the issue database, and the mise pin and the sandbox
    // exclusion live in files (mise.toml, .claude/settings.json) that other
    // components and humans also write, so neither is reconstructible as an
    // exact value this component owns. Say that in the purpose rather than
    // letting the number imply nothing was found (dchjw.17 F8).
    purpose:
      'The beads issue tracker: the br toolchain pin, .beads/, and the sandbox exclusion that lets br run. `remove` deletes NONE of them — .beads/ is your issue database, and the pin and the exclusion sit in files shared with other components; it un-lists the component and leaves every artifact in place.',
  },

  eas: {
    ...EMPTY,
    purpose: 'Expo/EAS build and update scripts (applies only to an Expo app).',
    scripts: EAS_SCRIPTS.map((script) => ({
      ...script,
      // `prebuild` and `eas-build-post-install` both run version-manager, which
      // plenty of non-Expo repos use on its own. They are not eas's to claim or
      // to delete — only the eas-shaped names below identify the component.
      shared:
        script.key === 'prebuild' || script.key === 'eas-build-post-install',
    })),
  },

  'time-check': {
    ...EMPTY,
    configKeys: [
      {key: TIME_CHECK_CONFIG_KEY, seeds: () => ({...TIME_CHECK_DEFAULTS})},
    ],
    hooks: [
      {
        command: TIME_CHECK_HOOK_COMMAND,
        event: 'UserPromptSubmit',
        fingerprint: TIME_CHECK_HOOK_FINGERPRINT,
      },
    ],
    purpose:
      'The UserPromptSubmit hook that tells a session how long it has been since the last message.',
  },

  'usage-check': {
    ...EMPTY,
    configKeys: [
      {
        key: USAGE_CHECK_CONFIG_KEY,
        seeds: () => ({
          enabled: USAGE_CHECK_DEFAULTS.enabled,
          wrapUpAt: USAGE_CHECK_DEFAULTS.wrapUpAt,
        }),
      },
    ],
    hooks: [
      {
        command: USAGE_CHECK_HOOK_COMMAND,
        event: 'UserPromptSubmit',
        fingerprint: USAGE_CHECK_HOOK_FINGERPRINT,
      },
      {
        command: USAGE_CHECK_HOOK_COMMAND,
        event: 'PostToolBatch',
        fingerprint: USAGE_CHECK_HOOK_FINGERPRINT,
      },
    ],
    purpose:
      'The hooks that report a session’s context usage against its wrap-up threshold.',
  },

  'thread-hooks': {
    ...EMPTY,
    hooks: [
      {
        command: THREAD_START_HOOK_COMMAND,
        event: THREAD_HOOK_EVENT,
        fingerprint: THREAD_START_HOOK_FINGERPRINT,
      },
      {
        command: THREAD_STOP_HOOK_COMMAND,
        event: THREAD_STOP_HOOK_EVENT,
        fingerprint: THREAD_STOP_HOOK_FINGERPRINT,
      },
    ],
    purpose:
      'SessionStart/Stop hooks that open a thread bead and refuse to end a session without a report.',
  },

  'critical-rules': {
    ...EMPTY,
    // The artifact is generated from the prompts registry at install time, so
    // its bytes depend on a clone this command may not have. Never deleted.
    files: [unreconstructible('.claude/rules/justin-sdk/critical-rules.md')],
    // Nothing under this key is written by the installer any more: a repo that
    // has it has a human's block, or the retired `modules` include-list the
    // fleet sweep removes. Reported, never deleted.
    configKeys: [{key: 'critical-rules', seeds: () => null}],
    purpose:
      'The committed .claude/rules/justin-sdk/critical-rules.md artifact, regenerated from the prompts registry.',
  },
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type InstalledEvidence =
  | {installed: true; because: string}
  | {installed: false};

/**
 * Is this component present on disk? Evidence-based, and it SAYS what the
 * evidence was, so `list` can print why rather than asserting a bare boolean.
 *
 * Deliberately generous (any one owned artifact counts): the consumer is
 * `install`'s reconcile, where a false "not installed" would silently skip
 * cleaning up a component the config no longer lists.
 */
export function componentInstalledEvidence(
  projectRoot: string,
  name: ComponentName,
): InstalledEvidence {
  const manifest = COMPONENT_MANIFESTS[name];

  for (const path of [
    ...manifest.markers,
    ...manifest.files.map((f) => f.path),
  ]) {
    if (existsSync(resolve(projectRoot, path))) {
      return {because: path, installed: true};
    }
  }

  const pkg = readJsonFile(resolve(projectRoot, 'package.json'));
  if (pkg != null) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const {key, shared} of manifest.scripts) {
      // A script base-setup also seeds proves nothing about this component.
      if (shared === true) continue;
      if (key in scripts)
        return {because: `package.json scripts.${key}`, installed: true};
    }
    for (const {key} of manifest.jsonBlocks) {
      if (key in pkg) return {because: `package.json ${key}`, installed: true};
    }
  }

  const settings = readJsonFile(
    resolve(projectRoot, '.claude', 'settings.json'),
  );
  if (settings != null) {
    for (const hook of manifest.hooks) {
      if (
        hookEntriesFor(settings, hook.event).some((c) =>
          c.includes(hook.fingerprint),
        )
      ) {
        return {
          because: `.claude/settings.json ${hook.event}`,
          installed: true,
        };
      }
    }
  }

  const config = readJsonFile(resolve(projectRoot, 'justin-sdk.config.json'));
  if (config != null) {
    const componentConfig = (config.componentConfig ?? {}) as Record<
      string,
      unknown
    >;
    for (const {key} of manifest.configKeys) {
      if (componentConfig[key] != null) {
        return {
          because: `justin-sdk.config.json componentConfig.${key}`,
          installed: true,
        };
      }
    }
  }

  return {installed: false};
}

/** Every hook COMMAND string registered for one event, flattened. */
export function hookEntriesFor(
  settings: Record<string, unknown>,
  event: string,
): string[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const entries = hooks[event];
  if (!Array.isArray(entries)) return [];
  const commands: string[] = [];
  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') continue;
    const inner = (entry as {hooks?: unknown}).hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const command = (hook as {command?: unknown} | null)?.command;
      if (typeof command === 'string') commands.push(command);
    }
  }
  return commands;
}

/**
 * JSON.parse a file, or null when it is missing OR unparseable.
 *
 * The two are conflated ON PURPOSE here and only here: every caller above asks
 * "does this file give me evidence of an install", and neither a missing file
 * nor an unreadable one does. No caller deletes anything on the strength of a
 * null — removal reads the file itself and refuses separately.
 */
function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every component name, for `list`. */
export function allComponentNames(): readonly ComponentName[] {
  return COMPONENT_NAMES;
}
