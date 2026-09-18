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

import {BEADS_MISE_TOOL_KEY} from './beads-setup';
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
import {
  DEFAULT_LINT_STAGED_CONFIG,
  POST_CHECKOUT_MARKER_BEGIN,
} from './husky-setup';
import {
  PRETTIER_SCRIPTS,
  PRETTIERIGNORE_BASELINE_ENTRIES,
  SIGNAL_SOURCE_PRETTIER_KEY,
  SIGNAL_SOURCE_PRETTIER_SCRIPT,
} from './prettier-setup';
import {isSdkEmittedCommand} from './sdk-invocation';
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
  /**
   * Paths whose NAME ALONE is SDK provenance — nothing but this SDK creates a
   * file at this path, so its existence proves the SDK was here even though its
   * bytes cannot be reconstructed. `justin-sdk.config.json` and
   * `.claude/rules/justin-sdk/` are the two; both carry the SDK's name in the
   * path, which is exactly what makes them unambiguous.
   */
  sdkOwnedPaths: readonly string[];
  /**
   * A string only this SDK writes, inside a file it SHARES with humans and
   * other tools. This is how a component whose artifact is composed or generated
   * (so `pristine` is null, and a byte comparison is impossible) can still prove
   * provenance.
   *
   * The `contains` string must be one nothing else would produce — see
   * `BEADS_MISE_TOOL_KEY`, which is the whole quoted mise key rather than the
   * word `beads_rust`, because a repo that says in a COMMENT that it removed
   * beads_rust contains that word too.
   */
  provenanceMarkers: readonly {file: string; contains: string}[];
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
  provenanceMarkers: [] as readonly {file: string; contains: string}[],
  removable: true,
  scripts: [] as readonly OwnedScript[],
  sdkOwnedPaths: [] as readonly string[],
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
    sdkOwnedPaths: ['justin-sdk.config.json'],
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
    // The composed hook has no reconstructible bytes, but the managed block
    // inside it is delimited by a marker only this SDK writes — so husky can
    // still prove provenance without a template to diff (dchjw.19).
    provenanceMarkers: [
      {contains: POST_CHECKOUT_MARKER_BEGIN, file: '.husky/post-checkout'},
    ],
    purpose:
      'Husky git hooks (pre-commit signal, post-checkout hydration) and the lint-staged block.',
    scripts: [
      {
        key: 'prepare',
        // NOT this component's alone, and the third case found by running the
        // real fleet dry-run (dchjw.19, after the first two in OwnedScript's
        // note). `prepare: "husky"` is the line husky's OWN `husky init`
        // writes and its docs tell every user to add — so it is not evidence
        // this SDK was here, and it is not ours to delete from a repo that
        // uses husky on its own. Measured: apple-reminders-mcp (Swift) has it
        // with no `.husky/post-checkout` and no SDK managed block at all, and
        // was being adopted into husky-setup on the strength of it.
        shared: true,
        value: 'husky',
      },
    ],
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
    // `.beads/` above is a MARKER, not provenance: `bd` (Dolt) writes exactly
    // the same directory name, which is how the first fleet dry-run proposed
    // adopting beads into ~/Dev/life. The mise tool key is the provenance —
    // beads-setup is the only thing that writes it (dchjw.19).
    provenanceMarkers: [{contains: BEADS_MISE_TOOL_KEY, file: 'mise.toml'}],
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
    // Its bytes come from a prompts clone this command may not have, so they
    // cannot be diffed — but the path is namespaced to the SDK and nothing else
    // writes there, which is provenance enough to adopt on.
    sdkOwnedPaths: ['.claude/rules/justin-sdk/critical-rules.md'],
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

/**
 * Three outcomes, because "the SDK put this here", "something that looks like it
 * is here" and "there is nothing here" are three different facts (critical rule
 * 6) — and only the first may be acted on automatically.
 */
export type ProvenanceEvidence =
  /** Something only this SDK writes. Safe to adopt. */
  | {kind: 'sdk'; because: string}
  /** A generic filename, directory or key. A human decides. */
  | {kind: 'weak'; because: string}
  /** Nothing at all — checked, and found none. */
  | {kind: 'absent'};

/**
 * Did THIS SDK install this component here, or does the repo merely have
 * something shaped like it? (dchjw.19)
 *
 * The distinction did not exist until the first full-fleet
 * `sweep --component install --dry-run`, where `componentInstalledEvidence` —
 * correctly generous, because its consumer is `install`, where a false "not
 * installed" would silently skip a component — was reused to decide ADOPTION,
 * which writes into a repo's committed config and thereby enrols it for every
 * future install. On that reading `~/Dev/life` had beads (it has a `.beads/`
 * directory; it is a Dolt workspace) and a Swift repo had prettier and husky
 * (it has a `.prettierrc.json` and a `.husky/`). Generous detection plus a
 * write is not the same tool as generous detection plus a report.
 *
 * `componentInstalledEvidence` is therefore UNCHANGED and still what `install`
 * and `list` ask. This is the stricter question, and it has exactly four kinds
 * of yes:
 *
 *   1. A path only the SDK ever creates (`justin-sdk.config.json`,
 *      `.claude/rules/justin-sdk/…`).
 *   2. A file whose bytes are IDENTICAL to what the component would write into
 *      this repo right now — the dchjw.17 standard, reused verbatim.
 *   3. A marker string only the SDK writes, inside a file it shares (the husky
 *      managed-block delimiter, the beads mise tool key, the `# justin-sdk
 *      baseline (appended)` section header).
 *   4. An EXACT-VALUE entry: a non-shared package.json script whose value still
 *      matches, a `lint-staged` block that still deep-equals the default, an
 *      SDK-EMITTED hook command (`isSdkEmittedCommand`, so a hand-composed
 *      `bun run justin-sdk time-check && my-own-thing` does NOT count), or a
 *      `componentConfig.<key>` block — which can only be inside
 *      `justin-sdk.config.json`, a file case 1 already establishes as ours.
 *
 * Anything else that `componentInstalledEvidence` would have accepted comes back
 * `weak`, WITH the evidence it found, so the caller can print it and let a human
 * decide rather than silently doing nothing.
 */
export function componentProvenanceEvidence(
  projectRoot: string,
  name: ComponentName,
): ProvenanceEvidence {
  const manifest = COMPONENT_MANIFESTS[name];
  const read = (rel: string): string | null => {
    const path = resolve(projectRoot, rel);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      // Unreadable is not "matches" — fall through to the weaker answers.
      return null;
    }
  };

  // 1. Paths only the SDK creates.
  for (const path of manifest.sdkOwnedPaths) {
    if (existsSync(resolve(projectRoot, path))) {
      return {because: `${path} (a path only justin-sdk writes)`, kind: 'sdk'};
    }
  }

  // 2. Files byte-identical to the template this component would write today.
  for (const file of manifest.files) {
    const pristine = file.pristine();
    if (pristine == null) continue;
    const actual = read(file.path);
    if (actual != null && actual === pristine) {
      return {
        because: `${file.path} (byte-identical to the template)`,
        kind: 'sdk',
      };
    }
  }

  // 3. Marker strings only the SDK writes, in files it shares.
  for (const marker of manifest.provenanceMarkers) {
    if (read(marker.file)?.includes(marker.contains) === true) {
      return {
        because: `${marker.file} contains ${marker.contains}`,
        kind: 'sdk',
      };
    }
  }
  for (const entry of manifest.ignoreLines) {
    if (entry.sectionHeader == null) continue;
    if (read(entry.file)?.includes(entry.sectionHeader) === true) {
      return {
        because: `${entry.file} contains "${entry.sectionHeader}"`,
        kind: 'sdk',
      };
    }
  }

  // 4a. Exact-value package.json entries.
  const pkg = readJsonFile(resolve(projectRoot, 'package.json'));
  if (pkg != null) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const {key, shared, value} of manifest.scripts) {
      if (shared === true) continue;
      if (scripts[key] === value) {
        return {
          because: `package.json scripts.${key} (exact value)`,
          kind: 'sdk',
        };
      }
    }
    for (const {key, value} of manifest.jsonBlocks) {
      if (key in pkg && JSON.stringify(pkg[key]) === JSON.stringify(value)) {
        return {because: `package.json ${key} (exact value)`, kind: 'sdk'};
      }
    }
  }

  // 4b. Hook commands the SDK itself emitted.
  const settings = readJsonFile(
    resolve(projectRoot, '.claude', 'settings.json'),
  );
  if (settings != null) {
    for (const hook of manifest.hooks) {
      const emitted = hookEntriesFor(settings, hook.event).find(
        (command) =>
          command.includes(hook.fingerprint) && isSdkEmittedCommand(command),
      );
      if (emitted != null) {
        return {
          because: `.claude/settings.json ${hook.event} runs an SDK-emitted command`,
          kind: 'sdk',
        };
      }
    }
  }

  // 4c. A componentConfig block — only ever inside justin-sdk.config.json.
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
          kind: 'sdk',
        };
      }
    }
  }

  // No provenance. Say whether there was anything here at all.
  const generic = componentInstalledEvidence(projectRoot, name);
  if (generic.installed) return {because: generic.because, kind: 'weak'};
  return {kind: 'absent'};
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
