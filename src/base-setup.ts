/**
 * base-setup.ts — Deterministic installer for the justin-sdk foundation
 * layer. Every justin-sdk project needs this before anything else.
 *
 * Installs:
 *  - justin-sdk.config.json at project root (tracks SDK version + components)
 *  - package.json scripts (signal/doctor/setup-env calling the bare `justin-sdk` bin)
 *  - .gitignore entries (tmp/, dynamic-version.local.*, .beads/.br_recovery/)
 *  - .claude/settings.json with sandbox.excludedCommands scaffolding
 *    and the j2n7 SessionStart hook line (remote: setup-env bootstrap;
 *    local: read-only doctor --quiet)
 *
 * Removes (home-base-j2n7): the committed scripts/setup-env.ts copy, which
 * the SDK `setup-env` command supersedes — deleted when hash-recognized as an
 * unmodified template, flagged when hand-modified.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Bails on unexpected state rather than guessing.
 */

import {createHash} from 'crypto';
import {existsSync, readFileSync, rmSync} from 'fs';
import {basename, resolve} from 'path';

import {coreConfigNames} from './component-registry';
import {getSdkVersion} from './sdk-identity';
import {
  invokesSdk,
  isSdkEmittedCommand,
  SDK_BIN,
  SDK_BOOTSTRAP,
  sdkRun,
  sdkScript,
  STALE_SDK_INVOCATION_RE,
} from './sdk-invocation';
import {SDK_REPO_URL, sdkTagExistsOnRemote} from './sdk-latest';
import {
  appendIfMissing,
  ensureDir,
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';
import {findTypeScriptSources} from './ts-inputs';

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL_SOURCE_SCRIPTS: Record<string, string> = {
  'signal-source:LINT':
    'eslint --report-unused-disable-directives --max-warnings 0 .',
  'signal-source:PRETTIER': 'prettier --check .',
  'signal-source:TS': 'tsc --noEmit',
};

/**
 * The SDK-owned package.json scripts, in form D1(a): the BARE bin name.
 *
 * `bun run <script>` prepends `node_modules/.bin` to PATH, so `justin-sdk` here
 * resolves the repo's own pinned tarball — offline, and without bunx's
 * registry fallthrough. This is how eslint/prettier/tsc are already invoked in
 * every repo on the fleet; the SDK was the odd one out.
 */
const SDK_SCRIPTS: Record<string, string> = {
  doctor: sdkScript('doctor'),
  'doctor:fix': sdkScript('doctor --fix'),
  fix: sdkScript('fix'),
  'setup-env': sdkScript('setup-env'),
  signal: sdkScript('signal --quiet'),
  'signal:serial': sdkScript('signal --serial'),
  'signal:verbose': sdkScript('signal'),
};

/**
 * A package.json script literally NAMED `justin-sdk` shadows the bin under
 * `bun run` (epic home-base-dchjw.4, F8).
 *
 * Measured: `bun run <name>` prefers a package.json SCRIPT over
 * `node_modules/.bin`, and it ECHOES `$ <command>` to stdout for a script while
 * printing nothing for a bin. So such a script both redirects every hook and
 * every SDK-owned alias to something else, and corrupts the stdout of hooks
 * whose output is parsed. No repo on the fleet has one today (measured
 * 2026-09-18) — this exists so that none ever silently acquires one.
 */
export const SDK_BIN_SHADOW_SCRIPT = SDK_BIN;

/** Does this package.json shadow the `justin-sdk` bin with a script of the same name? */
export function shadowsSdkBin(
  scripts: Record<string, unknown> | undefined,
): boolean {
  return (
    scripts != null &&
    Object.prototype.hasOwnProperty.call(scripts, SDK_BIN_SHADOW_SCRIPT)
  );
}

/**
 * The one committed SessionStart hook line (home-base-j2n7 decision). Two
 * worlds, irreconcilable in a single bare invocation, hence the shell branch:
 *
 *  - REMOTE (fresh container, no node_modules): the BOOTSTRAP form, D1(c). No
 *    local resolution of any kind can work before the tree is installed, and
 *    `bun install --frozen-lockfile` first would short-circuit on a missing or
 *    stale lockfile and on the npm/yarn repos — setup-env detects the package
 *    manager and installs, which is the whole point of calling it. A cloud
 *    container's bunx cache is cold, so this always fetches the latest
 *    published SDK, which is what a bootstrap wants.
 *  - LOCAL session start: READ-ONLY by ruling (write actions need a trigger,
 *    not a heartbeat) — so it runs `session-start`, which wraps `doctor
 *    --quiet` (and its ENV_HYDRATION staleness warning) together with the
 *    repo-state block and the rules-drift notice. `bun run` (D1(b)) resolves
 *    the project's own devDep pin: fast, offline, pinned, and no registry
 *    fallthrough. `|| true` keeps a fresh clone (nothing resolvable yet) from
 *    greeting every session with a hard hook error.
 *
 * Hooks run under `sh`, NOT under `bun run`, so the local branch has to spell
 * `bun run justin-sdk` in full — a bare `justin-sdk` here would depend on a
 * PATH shim, which is exactly the ambiguity D1 removes.
 *
 * The local branch became `session-start` in dchjw.8 (D6): the `prime` plugin
 * that used to contribute the repo-state block and the drift notice from a
 * second, separately-versioned copy is retired, so this hook is now the whole
 * local story for an enrolled repo. Repos already carrying the `doctor
 * --quiet` spelling are REWRITTEN by `upsertHookCommand` via
 * `isSessionStartHookEntry` below, rather than sitting behind an entry that
 * merely "looks installed".
 */
export const SESSION_START_HOOK_COMMAND = `if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then ${SDK_BOOTSTRAP} setup-env; else ${sdkRun('session-start')} || true; fi`;

/**
 * Recognises THIS hook, in any generation of spelling, so that installing over
 * an older repo REPLACES the command rather than appending a second entry.
 *
 * Matching on the literal substring `justin-sdk setup-env` is what the previous
 * version did, and it could only ever answer "is some form of this hook here?"
 * — never "is it the CURRENT form?". A fleet that had drifted to four spellings
 * therefore kept all four forever, because every one of them looked installed.
 * So: recognise by SHAPE (it mentions the SDK and it mentions setup-env), and
 * let the caller compare the command string to decide whether to rewrite it.
 */
export function isSessionStartHookEntry(entry: unknown): boolean {
  const text = JSON.stringify(entry);
  return invokesSdk(text) && text.includes('setup-env');
}

/**
 * The SDK's OWN SessionStart entry — the subset of the above that this
 * installer wrote and may therefore replace.
 *
 * A hand-edited entry (an absolute path to a checkout's bin, a wrapper script)
 * is recognised by `isSessionStartHookEntry` so it is never DUPLICATED, but it
 * is not rewritten: somebody chose that spelling, and at least one live reason
 * exists — an unenrolled repo has no node_modules, so `bun run justin-sdk`
 * would not resolve there at all.
 */
function isOwnSessionStartHookEntry(entry: unknown): boolean {
  if (!isSessionStartHookEntry(entry)) return false;
  const hooks = (entry as {hooks?: unknown}).hooks;
  if (!Array.isArray(hooks)) return false;
  // SOME, not EVERY (dchjw.15 F3). An entry that bundles this installer's
  // command with a foreign one failed `.every`, so it was classed as foreign,
  // KEPT, and a second copy of the hook appended beside it — both firing at
  // every session start. One SDK-emitted command in an entry makes the entry
  // mine to rewrite; the foreign commands inside it are preserved by the
  // rewrite itself, which edits hooks one at a time.
  return hooks.some((hook) => {
    const command = (hook as {command?: unknown}).command;
    if (typeof command !== 'string') return false;
    // Every generation of THIS hook has been the same shell branch on
    // $CLAUDE_CODE_REMOTE — only the two command spellings inside it moved. That
    // shape, not the leading token, is what identifies the installer's own
    // output: the whole line starts with `if [`, so the plain
    // `isSdkEmittedCommand` prefix test cannot recognise it.
    return (
      OWN_SESSION_START_SHAPE.test(command) || isSdkEmittedCommand(command)
    );
  });
}

/** The shell branch this installer has always written. See above. */
const OWN_SESSION_START_SHAPE =
  /^if \[ "\$CLAUDE_CODE_REMOTE" = "true" \]; then\b/;

/** The committed copy of setup-env that `stepSetupEnvScript` deletes. */
const RETIRED_SETUP_ENV_PATH = 'scripts/setup-env.ts';

/**
 * Replace this installer's own command(s) inside one entry, keeping the entry's
 * other keys (its `matcher`) and its foreign hooks exactly where they are. A
 * second hook that would rewrite to the same command is dropped rather than
 * duplicated — one entry running the hook twice is the same bug at a smaller
 * scale.
 */
function rewriteOwnSessionStartEntry(
  entry: unknown,
  /** True when an earlier entry already carries the command. */
  alreadyPlaced: boolean,
): unknown | null {
  const candidate = entry as {[key: string]: unknown; hooks?: unknown};
  if (!Array.isArray(candidate.hooks)) return entry;

  let alreadyWrote = alreadyPlaced;
  const hooks: unknown[] = [];
  for (const hook of candidate.hooks) {
    const command = (hook as {command?: unknown}).command;
    const mine =
      typeof command === 'string' &&
      (OWN_SESSION_START_SHAPE.test(command) ||
        isSdkEmittedCommand(command) ||
        command.includes(RETIRED_SETUP_ENV_PATH));
    if (!mine) {
      hooks.push(hook);
      continue;
    }
    if (alreadyWrote) continue;
    alreadyWrote = true;
    hooks.push({
      ...(hook as Record<string, unknown>),
      command: SESSION_START_HOOK_COMMAND,
    });
  }
  // A later duplicate whose only content WAS the command has nothing left to
  // say; dropping it is how two entries become one.
  if (hooks.length === 0) return null;
  return {...candidate, hooks};
}

/**
 * The SessionStart array this installer wants, built by EDITING the one it was
 * given — never by rebuilding it as `[...foreign, mine]` (dchjw.15 F3).
 *
 * Rebuilding reordered every repo's hooks: home-base's `thread start` entry is
 * foreign to this installer, so it was hoisted above the SDK entry on every
 * single install. Hook order is observable — the entries run in it — so a
 * scaffolding tool must not decide it.
 *
 * Three cases, in this order, and the first that matches wins per entry:
 *  1. MINE (`isOwnSessionStartHookEntry`) — rewritten AT ITS INDEX. Only the
 *     commands this installer emitted are replaced; a foreign command bundled
 *     into the same entry is carried through untouched, which is what makes
 *     `.some()` ownership safe.
 *  2. RETIRED — an entry naming the committed setup-env copy that is NOT
 *     otherwise mine. It points at a file this same run deletes, so it goes.
 *  3. Anything else — untouched, in place.
 *
 * If case 1 never matched but the array already carries a RECOGNISED
 * session-start hook (a hand-written absolute path — the unenrolled-repo
 * case), nothing is appended: that is the contract `isSessionStartHookEntry`
 * documents, and appending beside it is how a repo ends up running the hook
 * twice. Only a genuinely absent hook is appended, at the end.
 */
export function upsertSessionStartHook(
  registered: readonly unknown[],
): unknown[] {
  let rewroteMine = false;
  let recognised = false;

  const entries: unknown[] = [];
  for (const entry of registered) {
    if (isSessionStartHookEntry(entry)) recognised = true;

    if (isOwnSessionStartHookEntry(entry)) {
      // Only the FIRST one keeps the command. A repo that already carries two
      // of this installer's entries (an older SDK appended instead of
      // rewriting) runs the hook twice; collapsing them is the repair. Any
      // foreign hook bundled into the later entry still survives, in place.
      const rewritten = rewriteOwnSessionStartEntry(entry, rewroteMine);
      rewroteMine = true;
      if (rewritten != null) entries.push(rewritten);
      continue;
    }
    if (JSON.stringify(entry).includes(RETIRED_SETUP_ENV_PATH)) continue;
    entries.push(entry);
  }

  if (!rewroteMine && !recognised) {
    entries.push({
      hooks: [{command: SESSION_START_HOOK_COMMAND, type: 'command'}],
    });
  }
  return entries;
}

/**
 * The two write-only stamps `justin-sdk.config.json` used to carry (D3).
 *
 * `version` recorded which SDK last wrote the file and `lastSynced` the date it
 * did — neither was ever read back by anything but sweep's pin-neutrality
 * restore list, which existed only because these two keys made every no-op run
 * look like a change. The package.json pin is the version. When a config still
 * has them, base-setup deletes them, once, and says so.
 */
const RETIRED_CONFIG_KEYS = ['version', 'lastSynced'] as const;

/**
 * Create justin-sdk.config.json if it is missing, and drop the retired stamps
 * if it has them. Does NOT overwrite anything else, and does NOT register
 * components: only `add` and `remove` write `components` (constraint F11).
 *
 * A config created here is `{}` — the empty config is a COMPLETE one, because
 * an absent `components` means the `core` preset (see component-registry.ts).
 */
export function stepJustinSdkConfig(projectRoot: string): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');

  if (!existsSync(configPath)) {
    writeJson(configPath, {});
    success(
      'Created justin-sdk.config.json (no components key — resolves to the core preset)',
    );
    return true;
  }

  const config = readJson(configPath) ?? {};
  const dropped = RETIRED_CONFIG_KEYS.filter((key) => key in config);
  if (dropped.length === 0) {
    success('justin-sdk.config.json already up to date');
    return true;
  }
  for (const key of dropped) delete config[key];
  writeJson(configPath, config);
  success(
    `Updated justin-sdk.config.json (dropped retired key(s): ${dropped.join(', ')})`,
  );
  return true;
}

/**
 * Add `-setup` component names to `justin-sdk.config.json#components`, creating
 * the key if it is absent. Returns the names it actually added (already-listed
 * names are not re-added), so the caller can report honestly.
 *
 * CALLED BY `add` ONLY (and by `remove`'s mirror in Part B). Writing the key at
 * all is a decision — an absent `components` tracks the core preset as the
 * registry grows, while a present one freezes this repo's list — so the first
 * `add` of a single component is what turns a core-tracking repo into an
 * explicit-list repo. That is the same trade npm makes when you install one
 * package into a project with no dependencies block.
 */
export function addComponentsToConfig(
  projectRoot: string,
  configNames: readonly string[],
): string[] {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath) ?? {};
  const existing = Array.isArray(config.components)
    ? (config.components as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
  // base-setup is implicit, and every installer applies it — listing it would
  // be noise in every config in the fleet.
  const wanted = configNames.filter((name) => name !== 'base-setup');
  const added = wanted.filter((name) => !existing.includes(name));
  if (added.length === 0) return [];
  config.components = [...existing, ...added];
  writeJson(configPath, config);
  return added;
}

/**
 * Drop `-setup` component names from `justin-sdk.config.json#components`.
 * Returns the names it actually removed. The mirror of
 * `addComponentsToConfig`, and the only other writer of that key (F11).
 *
 * A config with NO `components` key is MATERIALISED to the current core
 * expansion minus the removed names. Absent means "track core", so leaving it
 * absent would make the next `install` put back exactly what was just removed —
 * the removal would not stick, silently. This is the same trade `add` makes in
 * the other direction: the first explicit choice is what turns a core-tracking
 * repo into an explicit-list repo.
 */
export function removeComponentsFromConfig(
  projectRoot: string,
  configNames: readonly string[],
  options: {dryRun?: boolean} = {},
): string[] {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) return [];
  const config = readJson(configPath);
  if (config == null) return [];
  const existing = Array.isArray(config.components)
    ? (config.components as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : coreConfigNames(projectRoot);
  const removed = existing.filter((name) => configNames.includes(name));
  if (removed.length === 0) return [];
  // dryRun answers "what WOULD be dropped" for `install --prune --dry-run`
  // without touching the file (dchjw.17 F6).
  if (options.dryRun === true) return removed;
  config.components = existing.filter((name) => !configNames.includes(name));
  writeJson(configPath, config);
  return removed;
}

/**
 * Merge required scripts into package.json. Preserves existing scripts.
 * Only overwrites if the existing value looks like an old/stale version.
 */
export function stepPackageScripts(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add scripts');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  let modified = false;

  // REFUSE rather than write scripts that would be routed somewhere else
  // (dchjw.4 F8). Every alias below is invoked as `bun run <name>`, and a
  // script named `justin-sdk` wins that lookup over the bin — so writing them
  // on top of one produces aliases that silently do the wrong thing AND echo
  // `$ …` into hook stdout. Removing someone's script is not ours to do.
  if (shadowsSdkBin(scripts)) {
    fail(
      `package.json has a script named "${SDK_BIN_SHADOW_SCRIPT}", which shadows the justin-sdk bin: \`bun run ${SDK_BIN}\` would run that script instead of the SDK, and would echo "$ …" into the stdout of every hook that calls it. Rename or remove that script, then re-run. (See \`doctor\` check SCRIPT_SHADOWS_SDK_BIN.)`,
    );
    return false;
  }

  // Add required SDK scripts. Overwrite if the existing value is a
  // known-stale shape:
  //   - Points at the old node_modules path
  //   - Points at a local scripts/{doctor,signal,check-runner,setup-env}.ts
  //     (pre-SDK / pre-j2n7 patterns; setup-env.ts is DELETED by
  //     stepSetupEnvScript this same run, so an un-migrated alias would point
  //     at a missing file)
  //   - Uses ANY retired `bunx` spelling (STALE_SDK_INVOCATION_RE, D1): the
  //     scoped `bunx @justinhaaheim/justin-sdk`, the unpinned
  //     `bunx github:…`, or the bare `bunx justin-sdk|jsdk|j`. All three fall
  //     through to the public npm registry when local resolution fails — the
  //     standard dependency-confusion shape (home-base-2qhw) — and the bare
  //     ones resolve to real, unrelated packages. The bare form was found
  //     surviving the first live sweep (ratchet finding #7). Every one of
  //     these values was written BY the SDK, never by hand, so rewriting them
  //     is how the fleet gets the new spelling on its next install or sweep.
  // Custom values that don't match a stale shape are preserved (e.g.,
  // apple-reminders-mcp's `signal: "bun run prettier-check"`).
  const STALE_LOCAL_SCRIPT_RE =
    /^bun(?:x)?\s+(?:run\s+)?(?:"\$CLAUDE_PROJECT_DIR\/)?scripts\/(?:doctor|signal|check-runner|setup-env)\.ts"?(?:\s.*)?$/;
  for (const [name, cmd] of Object.entries(SDK_SCRIPTS)) {
    const existing = scripts[name];
    const isStaleSdkScript =
      existing != null &&
      (existing.includes('node_modules/@justinhaaheim/justin-sdk') ||
        STALE_LOCAL_SCRIPT_RE.test(existing) ||
        STALE_SDK_INVOCATION_RE.test(existing));
    if (existing == null || isStaleSdkScript) {
      scripts[name] = cmd;
      modified = true;
    }
  }

  // Add default signal-source scripts only if NO signal-source:* scripts exist
  // (don't clobber a project that has adapted these).
  const hasSignalSource = Object.keys(scripts).some((k) =>
    k.startsWith('signal-source:'),
  );
  if (!hasSignalSource) {
    for (const [name, cmd] of Object.entries(DEFAULT_SIGNAL_SOURCE_SCRIPTS)) {
      scripts[name] = cmd;
      modified = true;
    }
  }

  if (modified) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success('Added/updated justin-sdk scripts in package.json');
  } else {
    success('package.json scripts already up to date');
  }
  return true;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Known hashes of retired versions of the setup-env.ts template. A committed
 * scripts/setup-env.ts matching one of these (or the final template still on
 * disk under templates/) is a known SDK artifact with no hand modifications —
 * safe to DELETE during migration to the SDK `setup-env` command.
 */
const KNOWN_OLD_SETUP_ENV_HASHES: ReadonlySet<string> = new Set<string>([
  // Fleet variants hashed 2026-08-08 (home-base-j2n7.3 audit). Every one is a
  // stale template generation or a pure prettier reformat — no unique logic.
  // audio-journal-1's fork is DELIBERATELY absent: it carried a real
  // symlinked-node_modules guard (now an ENV_HYDRATION detection), and its
  // deletion should be a reviewed step, not a silent one.
  'ed18903d547e32f2dff50e71c15a3f8c54ac2ad9213feaf8c9c88e780089e832', // home-base (pre-template generation, hardcoded initSubmodules)
  '1d0fae9d92c29ec8e295752d0d098f73dac3a9ce04b81d14258d309c25e1a958', // imessage-exporter (missing JSDK_SKIP_SETUP_ENV)
  '397b54e4f9eb45d0895215df06417563394b6c35f291ded03d2320adf08bcbd1', // browser-automation-central (pre-miseTrust)
  '68e0bd4e027d9b71c4dff6f9da17a9fec40394ab5770f107255a53228a9d5324', // apple-reminders-mcp (pre-miseTrust variant)
  '57849540e200828a512e1f98e704fe6de6700b7f8c0659d45585ba5ed41b2135', // raycast-j-recent (pure prettier reformat of current template)
]);

/**
 * REMOVE the committed scripts/setup-env.ts (home-base-j2n7): the copied
 * template is superseded by the SDK `setup-env` command — the per-project
 * surface is now the SessionStart hook line + the `setup-env` package.json
 * alias, both emitted by this component.
 *
 * Behavior:
 *  - File absent → nothing to do (the desired end state).
 *  - File matches the final template (kept on disk under templates/ exactly
 *    for this recognition) or a known-old hash → delete it.
 *  - Hand-modified (no hash match) → warn and keep, unless `force: true`.
 *    Project-specific logic belongs in setup-env:<LABEL> package.json
 *    scripts, which the SDK command runs in declaration order.
 */
/**
 * home-base-gsqz fix shape 3: say it out loud when the retirement just removed
 * the repo's LAST TypeScript file. The repo's tsconfig now matches nothing —
 * `tsc --noEmit` reports TS18003 there, and while the SDK's own signal reports
 * that as "not applicable" rather than red, an operator should still SEE that
 * this payload changed the repo's TypeScript surface to empty.
 */
function warnIfLastTypeScriptFile(projectRoot: string): void {
  if (findTypeScriptSources(projectRoot, 1).length > 0) return;
  warn(
    'That removed the LAST TypeScript file in this repo. Its tsconfig.json now ' +
      'matches no inputs (tsc reports TS18003); the TS check will report ' +
      '"not applicable" rather than pass. Consider retiring tsconfig.json and ' +
      'the signal-source:TS script here (home-base-gsqz).',
  );
}

export function stepSetupEnvScript(
  projectRoot: string,
  force = false,
): boolean {
  const targetPath = resolve(projectRoot, 'scripts', 'setup-env.ts');
  if (!existsSync(targetPath)) {
    success(
      'No committed scripts/setup-env.ts (superseded by the SDK setup-env command)',
    );
    return true;
  }

  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'scripts',
    'setup-env.ts',
  );
  const existingHash = sha256(readFileSync(targetPath, 'utf-8'));
  const matchesTemplate =
    existsSync(templatePath) &&
    existingHash === sha256(readFileSync(templatePath, 'utf-8'));

  if (matchesTemplate || KNOWN_OLD_SETUP_ENV_HASHES.has(existingHash)) {
    rmSync(targetPath);
    success(
      'Deleted scripts/setup-env.ts (unmodified SDK template — superseded by the SDK setup-env command)',
    );
    warnIfLastTypeScriptFile(projectRoot);
    return true;
  }

  if (force) {
    rmSync(targetPath);
    success('Deleted scripts/setup-env.ts (--force)');
    warnIfLastTypeScriptFile(projectRoot);
    return true;
  }

  warn(
    'scripts/setup-env.ts differs from every known SDK template (hand-modified). ' +
      'Move project-specific logic into setup-env:<LABEL> package.json scripts ' +
      '(run by `bun run justin-sdk setup-env` in declaration order), ' +
      'then delete the file or re-run with --force.',
  );
  return true;
}

/**
 * Ensure standard .gitignore entries are present.
 */
export function stepGitignore(projectRoot: string): boolean {
  const gitignore = resolve(projectRoot, '.gitignore');
  const entries: {append: string; label: string; search: string}[] = [
    {
      append: '\n# Temporary / scratch files\ntmp/\n',
      label: 'tmp/',
      search: 'tmp/',
    },
    {
      append:
        '\n# Dynamic version artifacts (local-only)\ndynamic-version.local.json\ndynamic-version.local.d.ts\n',
      label: 'dynamic-version.local.*',
      search: 'dynamic-version.local',
    },
  ];

  let anyAdded = false;
  for (const {search, append, label} of entries) {
    const added = appendIfMissing(gitignore, search, append);
    if (added) {
      success(`Added ${label} to .gitignore`);
      anyAdded = true;
    }
  }
  if (!anyAdded) {
    success('.gitignore already has standard entries');
  }
  return true;
}

/**
 * Ensure .claude/settings.json exists with the SessionStart hook and
 * a sandbox.excludedCommands array. Does not add any specific commands
 * (each component adds its own).
 */
export function stepClaudeSettings(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = readJson(settingsPath) ?? {};
  let modified = false;

  // Ensure sandbox.excludedCommands exists (empty is fine)
  const sandbox =
    (settings.sandbox as Record<string, unknown> | undefined) ?? {};
  if (!Array.isArray(sandbox.excludedCommands)) {
    sandbox.excludedCommands = [];
    modified = true;
  }
  settings.sandbox = sandbox;

  // Ensure the SessionStart hook is the j2n7 command line — and MIGRATE any
  // pre-j2n7 entry that ran the committed scripts/setup-env.ts copy, which is
  // being deleted by stepSetupEnvScript (an un-migrated hook would error at
  // every session start pointing at a file that no longer exists).
  const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
  const sessionStart = (hooks.SessionStart as unknown[] | undefined) ?? [];
  const desired = upsertSessionStartHook(sessionStart);
  // Compare the whole desired array, not "is a hook of this shape present":
  // that is what makes the rewrite both idempotent (already correct → no
  // write) and effective (correct shape, old command string → rewritten).
  if (JSON.stringify(sessionStart) !== JSON.stringify(desired)) {
    hooks.SessionStart = desired;
    modified = true;
  }
  settings.hooks = hooks;

  if (modified) {
    writeJson(settingsPath, settings);
    success('Updated .claude/settings.json (sandbox + SessionStart hook)');
  } else {
    success('.claude/settings.json already has base-setup scaffolding');
  }
  return true;
}

/**
 * Ensure `@justinhaaheim/justin-sdk` is declared as a dependency in
 * package.json so that fresh installs (especially Claude web session VMs)
 * actually link the SDK locally. Without it the script aliases have nothing
 * to resolve against: `bun run justin-sdk …` then fails `Script not found`
 * (measured), which is loud but is still a broken project. Pins to the
 * currently-running SDK version, after verifying that tag exists on the remote.
 *
 * Skips the project if the SDK is already declared as a dep or devDep
 * regardless of source (workspace, github, file, registry, etc.), since
 * we don't want to flip an intentional workspace dep to a github URL.
 */
export function stepDepsHasSdk(
  projectRoot: string,
  options: {sdkRepoUrl?: string} = {},
): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot declare SDK dep');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const SDK_PKG = '@justinhaaheim/justin-sdk';
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  const devDeps =
    (pkg.devDependencies as Record<string, string> | undefined) ?? {};

  if (SDK_PKG in deps || SDK_PKG in devDeps) {
    success(`${SDK_PKG} already declared as a dependency`);
    return true;
  }

  // v-PREFIXED, always (home-base-l9tz / v170.15): the bare spelling has
  // 404'd (no such tag) and, worse, silently resolved a POISONED duplicate
  // tag pointing at the wrong tree. The release convention is vX.Y.Z.
  const sdkVersion = getSdkVersion();
  if (sdkVersion == null) {
    fail(
      'Cannot declare the justin-sdk dependency: the running SDK could not read its own package.json, so there is no version to pin to. Refusing to write an unresolvable ref (D4, critical rule 6).',
    );
    return false;
  }
  // VERIFY THE TAG EXISTS BEFORE PINNING TO IT (home-base-l9tz). The version
  // read above is this checkout's package.json, which on a dev machine is
  // routinely ahead of anything published — pinning a consumer to
  // `#v0.39.0` when no such tag exists gives that repo a `bun install` that
  // 404s, and it 404s for everyone who clones it afterwards.
  const tag = `v${sdkVersion}`;
  // Name the remote that was ACTUALLY consulted. Reporting the constant here
  // would tell a reader the public repo lacks a tag when the run never asked it.
  const remoteUrl = options.sdkRepoUrl ?? SDK_REPO_URL;
  const published = sdkTagExistsOnRemote(tag, {repoUrl: remoteUrl});
  // CONFIRMED ABSENT is a refusal. This is the l9tz bug itself: a dev checkout
  // whose version was bumped but never released, writing a 404 into a consumer.
  if (published.status === 'ok' && !published.exists) {
    fail(
      `Cannot declare the justin-sdk dependency: this SDK reports version ${sdkVersion}, but ${remoteUrl} has no tag ${tag} (home-base-l9tz). That is what a DEV CHECKOUT with an un-released version bump looks like, and pinning to it would give this repo an install that 404s. Publish the release first (\`bun run sdk:publish\` from home-base), then re-run.`,
    );
    return false;
  }

  // COULD-NOT-ASK is a THIRD state and is never folded into either of the other
  // two (critical rule 6). It is reported as unverified, loudly, naming the
  // failed command — the pin is still written, because refusing here would make
  // every offline enrolment impossible and would make this SDK's own suite
  // depend on reaching GitHub (measured 2026-09-18: 110 of 1998 tests reach
  // this line). Read that warning as "this pin has not been checked", never as
  // "this pin is fine".
  const ref = `github:justinhaaheim/justin-sdk#${tag}`;
  devDeps[SDK_PKG] = ref;
  pkg.devDependencies = devDeps;
  writeJson(pkgPath, pkg);
  if (published.status === 'failed') {
    warn(
      `Added ${SDK_PKG} to devDependencies (${ref}) but COULD NOT VERIFY that tag against ${remoteUrl} (${published.error}). If ${tag} was never published, \`bun install\` here will 404 — confirm with \`git ls-remote --tags ${remoteUrl} ${tag}\` once you are online.`,
    );
  } else {
    success(
      `Added ${SDK_PKG} to devDependencies (${ref}, tag verified on the remote)`,
    );
  }
  warn(
    'Run `bun install` to fetch the SDK locally. Without it, the ' +
      `\`${SDK_BIN}\` script aliases and the \`${sdkRun('…')}\` hook commands ` +
      'have nothing to resolve against and will fail.',
  );
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BaseSetupOptions {
  /**
   * Force-DELETE a hand-modified scripts/setup-env.ts (one whose hash matches
   * no known SDK template). Hash-recognized copies are deleted without it.
   */
  force?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and for use from other setup commands) */
  quiet?: boolean;
  /**
   * The remote to verify the SDK tag against before writing a pin. Defaults to
   * the real published repo; tests point it at a local bare repo so the real
   * `git ls-remote` path runs without the suite ever reaching GitHub.
   */
  sdkRepoUrl?: string;
}

/**
 * Install the justin-sdk foundation layer in a project.
 *
 * Callable both as the top-level `add base-setup` command and as a
 * precondition from other setup commands (e.g., beads-setup calls this
 * to ensure the foundation is in place before it adds its own content).
 */
export function runBaseSetup(options: BaseSetupOptions = {}): Promise<number> {
  setQuiet(options.quiet ?? false);
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (options.quiet !== true) {
    console.log(
      `\n\x1b[1mInstalling justin-sdk base-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  stepHeader('1. justin-sdk.config.json');
  if (!stepJustinSdkConfig(projectRoot)) return Promise.resolve(1);

  stepHeader('2. package.json: @justinhaaheim/justin-sdk dep');
  if (!stepDepsHasSdk(projectRoot, {sdkRepoUrl: options.sdkRepoUrl}))
    return Promise.resolve(1);

  stepHeader('3. package.json scripts');
  if (!stepPackageScripts(projectRoot)) return Promise.resolve(1);

  stepHeader('4. scripts/setup-env.ts (retired — remove committed copy)');
  if (!stepSetupEnvScript(projectRoot, force)) return Promise.resolve(1);

  stepHeader('5. .gitignore');
  if (!stepGitignore(projectRoot)) return Promise.resolve(1);

  stepHeader('6. .claude/settings.json');
  if (!stepClaudeSettings(projectRoot)) return Promise.resolve(1);

  if (options.quiet !== true) {
    console.log(
      `\n\x1b[32m\x1b[1mbase-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return Promise.resolve(0);
}
