/**
 * husky-setup.ts — Deterministic husky + lint-staged setup for any project.
 *
 * Orchestrates: package.json devDependencies (husky + lint-staged pinned),
 * package.json `prepare` script, `.husky/pre-commit` hook (chmod +x), the
 * managed `.husky/post-checkout` auto-hydration preamble, and a default
 * `lint-staged` config in package.json.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before husky-specific steps run.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Does NOT run `bun add` or `bun run prepare` itself — it edits package.json
 * directly so the function is fast, offline, and unit-testable. The `justin-sdk init`
 * orchestrator (or the user) runs `bun install` once at the end, which will
 * automatically execute the `prepare` script and wire husky into `.git/`.
 *
 * WHY THIS COMPONENT OWNS POST-CHECKOUT (home-base-v170.12): a fresh worktree
 * or clone has none of its gitignored build state, and `git worktree add` /
 * `git clone` fire post-checkout with cwd = the NEW tree. That hook is
 * therefore the single integration point that covers every worktree-creation
 * path at once (Claude Code's `--worktree`, subagent isolation:worktree,
 * background sessions, `wt -n`, manual `git worktree add`, fresh clones) —
 * which is why the epic's D3 anti-decision rejected Claude Code's own
 * `WorktreeCreate` hook: that one REPLACES git's behavior and disables
 * `.worktreeinclude`. Since husky-setup is already the component that owns
 * `.husky/`, the preamble lives here.
 */

import {chmodSync, cpSync, existsSync, readFileSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED} from './pinned-versions';
import {
  ensureDir,
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

const DEFAULT_LINT_STAGED_CONFIG: Record<string, string[]> = {
  '*.{ts,tsx,js,jsx,cjs,mjs}': ['bun run lint-base -- --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};

interface DevDepSpec {
  name: 'husky' | 'lint-staged';
  pinned: string;
}

const HUSKY_DEV_DEPS: ReadonlyArray<DevDepSpec> = [
  {name: 'husky', pinned: PINNED.husky},
  {name: 'lint-staged', pinned: PINNED['lint-staged']},
];

/**
 * Ensure husky + lint-staged are listed in devDependencies at PINNED versions.
 *
 * Per-package behavior:
 *  - Missing → add at PINNED version.
 *  - Present at PINNED version → noop.
 *  - Present at a different version → warn and leave alone unless `force`.
 *
 * Does NOT run `bun add` (no network, no install). The orchestrator runs
 * `bun install` once at the end.
 */
function stepHuskyDeps(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add husky/lint-staged deps');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const devDeps = ((pkg.devDependencies as
    | Record<string, string>
    | undefined) ?? {}) as Record<string, string>;
  let modified = false;

  for (const {name, pinned} of HUSKY_DEV_DEPS) {
    const existing = devDeps[name];
    if (existing == null) {
      devDeps[name] = pinned;
      modified = true;
      success(`Added ${name}@${pinned} to devDependencies`);
      continue;
    }
    if (existing === pinned) {
      success(`${name}@${pinned} already in devDependencies`);
      continue;
    }
    if (force) {
      devDeps[name] = pinned;
      modified = true;
      success(`Overwrote ${name} devDependency to ${pinned} (--force)`);
      continue;
    }
    warn(
      `${name} devDependency is ${existing}, pinned is ${pinned} — leaving as-is. Re-run with --force to overwrite.`,
    );
  }

  if (modified) {
    pkg.devDependencies = devDeps;
    writeJson(pkgPath, pkg);
  }
  return true;
}

const PREPARE_SCRIPT_VALUE = 'husky';

/**
 * Ensure package.json has a `prepare` script set to `"husky"`.
 *
 * Behavior:
 *  - Missing → add as `"husky"`.
 *  - Present and equal to `"husky"` → noop.
 *  - Present at any other value → warn + skip (projects often layer multiple
 *    prepare actions). Do NOT overwrite, even with `--force` — leave the
 *    user's setup intact; they likely need their custom prepare command.
 */
function stepPrepareScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add prepare script');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;
  const existing = scripts.prepare;

  if (existing == null) {
    scripts.prepare = PREPARE_SCRIPT_VALUE;
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success(`Added "prepare" script ("${PREPARE_SCRIPT_VALUE}")`);
    return true;
  }

  if (existing === PREPARE_SCRIPT_VALUE) {
    success('"prepare" script already set to "husky"');
    return true;
  }

  warn(
    `package.json already has a "prepare" script ("${existing}") — leaving as-is. Make sure it invokes husky if you want git hooks installed.`,
  );
  return true;
}

/**
 * Write `.husky/pre-commit` from the SDK template and ensure it's executable.
 *
 * Behavior:
 *  - Ensures `.husky/` exists.
 *  - Missing file → copy from template.
 *  - Exists and matches template → noop.
 *  - Exists and differs → warn + skip (unless `force`).
 *  - `force: true` → overwrite.
 *  - In all cases where the file ends up present, chmod +x to make it
 *    executable (husky requires this).
 */
function stepPreCommitHook(projectRoot: string, force: boolean): boolean {
  const huskyDir = resolve(projectRoot, '.husky');
  const targetPath = resolve(huskyDir, 'pre-commit');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.husky',
    'pre-commit',
  );

  if (!existsSync(templatePath)) {
    fail(`.husky/pre-commit template not found at ${templatePath}`);
    return false;
  }

  ensureDir(huskyDir);

  const templateContent = readFileSync(templatePath, 'utf-8');

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    chmodSync(targetPath, 0o755);
    success('Copied .husky/pre-commit from template (chmod +x)');
    return true;
  }

  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    // Ensure executable bit is set even if file content matches.
    chmodSync(targetPath, 0o755);
    success('.husky/pre-commit matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    chmodSync(targetPath, 0o755);
    success('Overwrote .husky/pre-commit (--force, chmod +x)');
    return true;
  }

  warn(
    '.husky/pre-commit differs from SDK template (user-customized). Re-run with --force to overwrite.',
  );
  return true;
}

// ---------------------------------------------------------------------------
// .husky/post-checkout — the managed auto-hydration preamble
// ---------------------------------------------------------------------------

/**
 * Marker tokens delimiting the managed block. They make the preamble
 * re-findable, so a re-install UPDATES it in place instead of duplicating it,
 * and everything outside them is the project's own (hooks routinely carry
 * other, third-party-owned lines).
 *
 * Matched with `startsWith`, not equality: the BEGIN line carries a trailing
 * "regenerated by …" note that must be free to change without orphaning
 * already-installed blocks.
 */
export const POST_CHECKOUT_MARKER_BEGIN = '# >>> justin-sdk:worktree-hydration';
export const POST_CHECKOUT_MARKER_END = '# <<< justin-sdk:worktree-hydration';

/**
 * The hand-rolled fresh-checkout block the managed preamble SUPERSEDES.
 *
 * home-base carried exactly this shape (`[ -d node_modules ] || { git submodule
 * update --init --recursive; bun install; }`) since 2026-06-06. `worktree-setup`
 * does submodules AND install as of SDK v0.12.1, plus mise trust,
 * `.worktreeinclude` copies, and the project's own `worktree-source:` scripts —
 * so leaving the old block in place would only double the install.
 *
 * Recognized structurally (open line → first column-0 `}`) rather than by exact
 * text, since the block was hand-written and every copy differs slightly.
 */
const LEGACY_HYDRATION_OPEN = /^\[\s*-d\s+node_modules\s*\]\s*\|\|\s*\{\s*$/;
const LEGACY_HYDRATION_CLOSE = /^\}\s*$/;

/**
 * Which comment lines directly above the legacy block get removed WITH it.
 *
 * Only lines that describe the block being removed — leaving a comment that
 * explains a block that no longer exists is worse than either extreme. In
 * home-base's hook this keeps `# Dynamic version generator` (which describes the
 * version-manager line BELOW, not the block) and drops the four lines about
 * node_modules / worktrees / submodules / install.
 */
const LEGACY_HYDRATION_COMMENT =
  /node_modules|worktree|clone|submodule|install/i;

/** Path to the SDK-owned preamble template. */
function postCheckoutTemplatePath(): string {
  return resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.husky',
    'post-checkout-preamble.sh',
  );
}

/**
 * Read the managed preamble from the SDK template, normalized to exactly one
 * trailing newline. Returns null (after `fail`) when the template is missing or
 * has lost its markers — without markers the block could never be updated in
 * place, so writing it would be a one-way door.
 */
export function readPostCheckoutPreamble(): string | null {
  const templatePath = postCheckoutTemplatePath();
  if (!existsSync(templatePath)) {
    fail(`.husky/post-checkout preamble template not found at ${templatePath}`);
    return null;
  }
  const content = readFileSync(templatePath, 'utf-8');
  if (
    !content.includes(POST_CHECKOUT_MARKER_BEGIN) ||
    !content.includes(POST_CHECKOUT_MARKER_END)
  ) {
    fail(
      `.husky/post-checkout preamble template lost its markers (${POST_CHECKOUT_MARKER_BEGIN} … ${POST_CHECKOUT_MARKER_END})`,
    );
    return null;
  }
  return `${content.trimEnd()}\n`;
}

/**
 * Remove the legacy hand-rolled hydration block, plus the comment lines
 * immediately above it that describe it. Returns the content unchanged when no
 * complete block is found — an unbalanced fragment is left for a human.
 */
export function stripLegacyHydrationBlock(content: string): {
  content: string;
  stripped: boolean;
} {
  const lines = content.split('\n');
  const openIdx = lines.findIndex((line) => LEGACY_HYDRATION_OPEN.test(line));
  if (openIdx === -1) return {content, stripped: false};

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (LEGACY_HYDRATION_CLOSE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return {content, stripped: false};

  let firstIdx = openIdx;
  while (firstIdx > 0) {
    const previous = lines[firstIdx - 1] ?? '';
    if (!previous.trimStart().startsWith('#')) break;
    if (!LEGACY_HYDRATION_COMMENT.test(previous)) break;
    firstIdx--;
  }

  lines.splice(firstIdx, closeIdx - firstIdx + 1);
  return {content: lines.join('\n'), stripped: true};
}

export type PostCheckoutComposition =
  | {kind: 'created'; content: string}
  | {kind: 'replaced'; content: string; legacyStripped: boolean}
  | {kind: 'inserted'; content: string; legacyStripped: boolean}
  | {kind: 'unchanged'; content: string}
  | {kind: 'unterminated'};

/**
 * Compose the new `.husky/post-checkout` from the existing file (null when
 * absent) and the managed preamble. Pure — all file IO lives in the step.
 *
 * Three input shapes, all of them real (home-base-v170.12):
 *  - no file → the preamble IS the hook.
 *  - markers present → replace the span, preserving everything around it. This
 *    is what makes a re-install an update rather than a duplicate.
 *  - no markers → strip the legacy block if present, then insert the preamble
 *    at the top, BELOW a shebang if the file has one (prepending above it would
 *    silently disable it). Every other line survives byte-for-byte — notably
 *    `npx @justinhaaheim/version-manager --git-hook`, which is
 *    version-manager-owned and regenerated by ITS installer (home-base-vhq.5).
 */
export function composePostCheckout(
  existing: string | null,
  preamble: string,
): PostCheckoutComposition {
  if (existing == null) return {content: preamble, kind: 'created'};

  const preambleLines = preamble.trimEnd().split('\n');
  const lines = existing.split('\n');

  const beginIdx = lines.findIndex((line) =>
    line.startsWith(POST_CHECKOUT_MARKER_BEGIN),
  );
  if (beginIdx !== -1) {
    const endIdx = lines.findIndex(
      (line, index) =>
        index > beginIdx && line.startsWith(POST_CHECKOUT_MARKER_END),
    );
    // BEGIN without END means someone truncated the block by hand. Rewriting
    // would guess where their content resumes, so refuse and let them fix it.
    if (endIdx === -1) return {kind: 'unterminated'};
    const content = [
      ...lines.slice(0, beginIdx),
      ...preambleLines,
      ...lines.slice(endIdx + 1),
    ].join('\n');
    return content === existing
      ? {content, kind: 'unchanged'}
      : {content, kind: 'replaced', legacyStripped: false};
  }

  const legacy = stripLegacyHydrationBlock(existing);
  const remainderLines = legacy.content.split('\n');

  // Keep a shebang first; a preamble above it would make it a comment.
  const shebang =
    remainderLines[0]?.startsWith('#!') === true
      ? remainderLines.shift()
      : null;

  // Drop blank lines the strip (or the shebang) left at the seam, then keep one
  // blank line as a separator so the managed block reads as its own section.
  while (remainderLines.length > 0 && (remainderLines[0] ?? '').trim() === '') {
    remainderLines.shift();
  }
  const remainder = remainderLines.join('\n').trimEnd();

  const content =
    (shebang == null ? '' : `${shebang}\n`) +
    `${preambleLines.join('\n')}\n` +
    (remainder === '' ? '' : `\n${remainder}\n`);

  return {content, kind: 'inserted', legacyStripped: legacy.stripped};
}

/**
 * Write / update the managed auto-hydration preamble in `.husky/post-checkout`.
 *
 * `force` is deliberately NOT consulted: the block is marker-delimited, so an
 * update never has to overwrite anything the project owns, and refusing to
 * update the SDK's own block without `--force` would leave stale hook logic
 * installed fleet-wide.
 */
function stepPostCheckoutHook(projectRoot: string): boolean {
  const preamble = readPostCheckoutPreamble();
  if (preamble == null) return false;

  const huskyDir = resolve(projectRoot, '.husky');
  const targetPath = resolve(huskyDir, 'post-checkout');
  ensureDir(huskyDir);

  const existing = existsSync(targetPath)
    ? readFileSync(targetPath, 'utf-8')
    : null;
  const composed = composePostCheckout(existing, preamble);

  if (composed.kind === 'unterminated') {
    warn(
      `.husky/post-checkout has ${POST_CHECKOUT_MARKER_BEGIN} with no matching end marker — leaving it alone. Restore or delete the marker pair, then re-run.`,
    );
    return true;
  }

  if (composed.kind !== 'unchanged') {
    writeFileSync(targetPath, composed.content);
  }
  // Husky runs hooks via `sh -e`, but a hook copied into `.git/hooks/` (or a
  // project not using husky) is exec'd directly, so keep it executable.
  chmodSync(targetPath, 0o755);

  switch (composed.kind) {
    case 'created':
      success('Created .husky/post-checkout with the auto-hydration preamble');
      break;
    case 'replaced':
      success('Updated the .husky/post-checkout auto-hydration preamble');
      break;
    case 'inserted':
      success(
        composed.legacyStripped
          ? 'Replaced the hand-rolled fresh-checkout block in .husky/post-checkout with the managed preamble'
          : 'Inserted the auto-hydration preamble at the top of .husky/post-checkout',
      );
      break;
    case 'unchanged':
      success('.husky/post-checkout preamble is current');
      break;
  }
  return true;
}

/**
 * Ensure package.json has a `lint-staged` config block.
 *
 * Behavior:
 *  - Missing → add the default config.
 *  - Present at any value → leave alone (lint-staged is intentionally
 *    customized often; no warn).
 */
function stepLintStagedConfig(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add lint-staged config');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  if ('lint-staged' in pkg) {
    success('lint-staged config already present in package.json');
    return true;
  }

  pkg['lint-staged'] = {...DEFAULT_LINT_STAGED_CONFIG};
  writeJson(pkgPath, pkg);
  success('Added default lint-staged config to package.json');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HuskySetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and chaining) */
  quiet?: boolean;
  /**
   * Force-overwrite hand-modified .husky/pre-commit and any husky/lint-staged
   * devDependency versions that differ from PINNED. Does NOT overwrite a
   * user's existing `prepare` script — that's always preserved.
   */
  force?: boolean;
}

/**
 * Install the justin-sdk husky-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'husky-setup' in justin-sdk.config.json.
 *
 * Does NOT run `bun install` or `bun run prepare`. The `justin-sdk init` orchestrator
 * (or the user) runs `bun install` once at the end after all components are
 * added, which automatically executes the `prepare` script and wires husky
 * into `.git/hooks/`.
 */
export async function runHuskySetup(
  options: HuskySetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up husky ${PINNED.husky} + lint-staged ${PINNED['lint-staged']} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['husky-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with husky-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: husky + lint-staged in package.json devDependencies
  stepHeader('1. package.json: husky + lint-staged devDependencies');
  if (!stepHuskyDeps(projectRoot, force)) return 1;

  // Step 2: prepare script in package.json
  stepHeader('2. package.json: "prepare" script');
  if (!stepPrepareScript(projectRoot)) return 1;

  // Step 3: .husky/pre-commit hook
  stepHeader('3. .husky/pre-commit');
  if (!stepPreCommitHook(projectRoot, force)) return 1;

  // Step 4: .husky/post-checkout auto-hydration preamble
  stepHeader('4. .husky/post-checkout (worktree auto-hydration)');
  if (!stepPostCheckoutHook(projectRoot)) return 1;

  // Step 5: lint-staged config in package.json
  stepHeader('5. package.json: lint-staged config');
  if (!stepLintStagedConfig(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mhusky-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
    console.log(
      '  Run `bun install` to fetch husky + lint-staged locally and let `prepare` wire the git hooks.\n',
    );
  }

  return 0;
}
