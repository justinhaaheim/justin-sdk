/**
 * husky-setup.ts — Deterministic husky + lint-staged setup for any project.
 *
 * Orchestrates: package.json devDependencies (husky + lint-staged pinned),
 * package.json `prepare` script, `.husky/pre-commit` hook (chmod +x) with its
 * managed type-check block when `componentConfig.husky.tsCheckInHook` is on
 * (home-base-lzvh), the managed `.husky/post-checkout` auto-hydration preamble,
 * and a default `lint-staged` config in package.json.
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

import {chmodSync, existsSync, readFileSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED} from './pinned-versions';
import {
  HUSKY_CONFIG_KEY,
  TS_CHECK_IN_HOOK_DEFAULT,
} from './pre-commit-ts-check/defaults';
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

export const DEFAULT_LINT_STAGED_CONFIG: Record<string, string[]> = {
  '*.{json,md,yml,yaml}': ['prettier --write'],
  '*.{ts,tsx,js,jsx,cjs,mjs}': [
    'bun run lint-base -- --fix',
    'prettier --write',
  ],
};

interface DevDepSpec {
  name: 'husky' | 'lint-staged';
  pinned: string;
}

const HUSKY_DEV_DEPS: readonly DevDepSpec[] = [
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

  const devDeps =
    (pkg.devDependencies as Record<string, string> | undefined) ?? {};
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

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
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

// ---------------------------------------------------------------------------
// .husky/pre-commit — the managed type-check block (home-base-lzvh)
// ---------------------------------------------------------------------------

/**
 * Marker tokens delimiting the SDK's type-check block in `.husky/pre-commit`
 * (home-base-lzvh D1). Matched with `startsWith`, like the post-checkout
 * markers, so the BEGIN line's trailing note can change without orphaning
 * blocks already installed.
 */
export const PRE_COMMIT_TS_CHECK_MARKER_BEGIN = '# >>> justin-sdk:ts-check';
export const PRE_COMMIT_TS_CHECK_MARKER_END = '# <<< justin-sdk:ts-check';

/**
 * A hook line that already runs a type check (D1): `npm run ts-check`
 * (audio-journal-1, health-logger-rn), `tsc`, `signal-source:TS`, or home-base's
 * `pre-commit-ts-check`. Adding the block to such a hook would type-check every
 * commit twice. `\btsc\b` does not match `tsconfig`.
 */
const OWN_TYPE_CHECK = /\bts-check\b|\btsc\b|signal-source:TS/;

/** Path to the SDK-owned type-check block template. */
function preCommitTsCheckTemplatePath(): string {
  return resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.husky',
    'pre-commit-ts-check.sh',
  );
}

/**
 * Read the type-check block from the SDK template, normalized to exactly one
 * trailing newline. Returns null (after `fail`) when the template is missing or
 * has lost its markers, for the reason readPostCheckoutPreamble gives.
 */
export function readPreCommitTsCheckBlock(): string | null {
  const templatePath = preCommitTsCheckTemplatePath();
  if (!existsSync(templatePath)) {
    fail(`.husky/pre-commit type-check template not found at ${templatePath}`);
    return null;
  }
  const content = readFileSync(templatePath, 'utf-8');
  if (
    !content.includes(PRE_COMMIT_TS_CHECK_MARKER_BEGIN) ||
    !content.includes(PRE_COMMIT_TS_CHECK_MARKER_END)
  ) {
    fail(
      `.husky/pre-commit type-check template lost its markers (${PRE_COMMIT_TS_CHECK_MARKER_BEGIN} … ${PRE_COMMIT_TS_CHECK_MARKER_END})`,
    );
    return null;
  }
  return `${content.trimEnd()}\n`;
}

/** Where the marked block sits in a hook's lines. */
type MarkedSpan =
  | {beginIdx: number; endIdx: number; kind: 'found'}
  | {kind: 'absent'}
  | {kind: 'unterminated'};

function findTsCheckSpan(lines: readonly string[]): MarkedSpan {
  const beginIdx = lines.findIndex((line) =>
    line.startsWith(PRE_COMMIT_TS_CHECK_MARKER_BEGIN),
  );
  if (beginIdx === -1) return {kind: 'absent'};
  const endIdx = lines.findIndex(
    (line, index) =>
      index > beginIdx && line.startsWith(PRE_COMMIT_TS_CHECK_MARKER_END),
  );
  if (endIdx === -1) return {kind: 'unterminated'};
  return {beginIdx, endIdx, kind: 'found'};
}

/** The block as it stands in a hook, or null when there is no complete one. */
export function extractPreCommitTsCheckBlock(hook: string): string | null {
  const lines = hook.split('\n');
  const span = findTsCheckSpan(lines);
  if (span.kind !== 'found') return null;
  return `${lines.slice(span.beginIdx, span.endIdx + 1).join('\n')}\n`;
}

/**
 * The hook with the SDK's block and the blank line the insert puts after it
 * taken out: what the template-body check compares against the template, so a
 * hook the SDK composed still counts as "matches the template". Returns the
 * hook unchanged when it has no complete block.
 */
export function withoutPreCommitTsCheckBlock(hook: string): string {
  const lines = hook.split('\n');
  const span = findTsCheckSpan(lines);
  if (span.kind !== 'found') return hook;
  const after = lines.slice(span.endIdx + 1);
  while (after.length > 0 && (after[0] ?? '').trim() === '') after.shift();
  return [...lines.slice(0, span.beginIdx), ...after].join('\n');
}

/** The first non-comment line that already type-checks, trimmed, or null. */
export function findOwnTypeCheckLine(hook: string): string | null {
  for (const line of hook.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (OWN_TYPE_CHECK.test(trimmed)) return trimmed;
  }
  return null;
}

export type PreCommitTsCheckComposition =
  | {content: string; kind: 'inserted'}
  | {content: string; kind: 'replaced'}
  | {content: string; kind: 'unchanged'}
  | {kind: 'own-type-check'; line: string}
  | {kind: 'unterminated'};

/**
 * Compose `.husky/pre-commit` from a hook and the type-check block (D1). Pure;
 * the step does the IO. A missing hook is composed from the template body, so a
 * fresh install and an insert into the old one-line hook write the same bytes.
 *
 *  - markers present → replace the span in place; every other line survives
 *    byte for byte. BEGIN without END → refuse, as post-checkout does.
 *  - no markers, and a non-comment line already type-checks → insert nothing.
 *  - no markers → insert the block at the top, below a shebang if there is
 *    one, followed by one blank line.
 */
export function composePreCommitTsCheck(
  existing: string,
  block: string,
): PreCommitTsCheckComposition {
  const blockLines = block.trimEnd().split('\n');
  const lines = existing.split('\n');

  const span = findTsCheckSpan(lines);
  if (span.kind === 'unterminated') return {kind: 'unterminated'};
  if (span.kind === 'found') {
    const content = [
      ...lines.slice(0, span.beginIdx),
      ...blockLines,
      ...lines.slice(span.endIdx + 1),
    ].join('\n');
    return content === existing
      ? {content, kind: 'unchanged'}
      : {content, kind: 'replaced'};
  }

  const ownLine = findOwnTypeCheckLine(existing);
  if (ownLine != null) return {kind: 'own-type-check', line: ownLine};

  const remainderLines = [...lines];
  // Keep a shebang first; a block above it would make it a comment.
  const shebang =
    remainderLines[0]?.startsWith('#!') === true
      ? remainderLines.shift()
      : null;
  while (remainderLines.length > 0 && (remainderLines[0] ?? '').trim() === '') {
    remainderLines.shift();
  }
  const remainder = remainderLines.join('\n').trimEnd();

  const content =
    (shebang == null ? '' : `${shebang}\n`) +
    `${blockLines.join('\n')}\n` +
    (remainder === '' ? '' : `\n${remainder}\n`);
  return {content, kind: 'inserted'};
}

/** `componentConfig.husky.tsCheckInHook`, resolved; unreadable is its own state. */
export type TsCheckInHookKnob =
  | {kind: 'off'}
  | {kind: 'on'}
  | {kind: 'unknown'; reason: string};

/**
 * Resolve the knob (D3) from the project's `justin-sdk.config.json`. Absent
 * file or key → the default. A file that cannot be used is `unknown`, which the
 * step treats as neither adding nor updating the block and says so: an
 * unreadable config must not decide a change to every commit in the repo.
 *
 * `sdk-config` is `await import`ed here, never imported at the top of this
 * file (home-base-lzvh.1): it pulls in zod, and this module is statically
 * reachable from cli-main.ts through components.ts, so a static import would
 * put zod's 12-13 ms on every hook's startup. tests/health-notices-cli.test.ts
 * ("zod is NOT statically reachable …") fails if it comes back.
 */
export async function readTsCheckInHookKnob(
  projectRoot: string,
): Promise<TsCheckInHookKnob> {
  const fallback: TsCheckInHookKnob = TS_CHECK_IN_HOOK_DEFAULT
    ? {kind: 'on'}
    : {kind: 'off'};
  const {describeConfigOutcome, readProjectConfig} = await import(
    './sdk-config'
  );
  const outcome = readProjectConfig(projectRoot);
  if (outcome.status === 'absent') return fallback;
  if (outcome.status !== 'ok') {
    return {kind: 'unknown', reason: describeConfigOutcome(outcome)};
  }
  const value = outcome.config.componentConfig?.husky?.tsCheckInHook;
  if (value === undefined) return fallback;
  return value ? {kind: 'on'} : {kind: 'off'};
}

/**
 * Write `.husky/pre-commit` and ensure it's executable. Two independent parts:
 *
 * 1. The template body (behavior unchanged since before home-base-lzvh, except
 *    that the comparison ignores the SDK's own type-check block):
 *    - Missing file → the template.
 *    - Matches template → noop.
 *    - Differs → warn + skip (unless `force`).
 *    - `force: true` → overwrite with the template.
 * 2. The type-check block (D1), by `componentConfig.husky.tsCheckInHook` (D3).
 *    On: add or update it; `force` is not consulted, because the block never
 *    overwrites anything the project owns. Off or unreadable: add nothing,
 *    update nothing, and keep a block that is already there, through `--force`
 *    too.
 *
 * In all cases the file ends up chmod +x (husky requires this).
 *
 * `knob` is resolved by the caller with `readTsCheckInHookKnob`, which is
 * async because it loads sdk-config lazily (home-base-lzvh.1).
 */
function stepPreCommitHook(
  projectRoot: string,
  force: boolean,
  knob: TsCheckInHookKnob,
): boolean {
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

  const block = knob.kind === 'on' ? readPreCommitTsCheckBlock() : null;
  if (knob.kind === 'on' && block == null) return false;

  ensureDir(huskyDir);

  const templateContent = readFileSync(templatePath, 'utf-8');
  const existing = existsSync(targetPath)
    ? readFileSync(targetPath, 'utf-8')
    : null;

  // Part 1: the template body.
  let content: string;
  if (existing == null) {
    content = templateContent;
    success('Copied .husky/pre-commit from template (chmod +x)');
  } else if (withoutPreCommitTsCheckBlock(existing) === templateContent) {
    content = existing;
    success('.husky/pre-commit matches current template');
  } else if (force) {
    content = templateContent;
    success('Overwrote .husky/pre-commit (--force, chmod +x)');
  } else {
    content = existing;
    warn(
      '.husky/pre-commit differs from SDK template (user-customized). Re-run with --force to overwrite.',
    );
  }

  // Part 2: the type-check block.
  const knobName = `componentConfig.${HUSKY_CONFIG_KEY}.tsCheckInHook`;
  if (block != null) {
    const composed = composePreCommitTsCheck(content, block);
    switch (composed.kind) {
      case 'unterminated':
        warn(
          `.husky/pre-commit has ${PRE_COMMIT_TS_CHECK_MARKER_BEGIN} with no matching end marker — leaving the type-check block alone. Restore or delete the marker pair, then re-run.`,
        );
        break;
      case 'own-type-check':
        success(
          `.husky/pre-commit already type-checks (\`${composed.line}\`) — not adding the SDK's type-check block`,
        );
        break;
      case 'inserted':
        content = composed.content;
        success('Added the type-check block to .husky/pre-commit');
        break;
      case 'replaced':
        content = composed.content;
        success('Updated the .husky/pre-commit type-check block');
        break;
      case 'unchanged':
        success('.husky/pre-commit type-check block is current');
        break;
    }
  } else {
    // Off or unknown: keep whatever block the hook already had, where it was.
    // Only `--force` can have taken it out of `content`, and it goes back on.
    const kept =
      existing == null ? null : extractPreCommitTsCheckBlock(existing);
    if (kept != null) {
      const composed = composePreCommitTsCheck(content, kept);
      if ('content' in composed) content = composed.content;
    }
    if (knob.kind === 'unknown') {
      warn(
        `Could not read ${knobName} (${knob.reason}) — the .husky/pre-commit type-check block was neither added nor updated`,
      );
    } else if (kept != null) {
      success(
        `.husky/pre-commit has the SDK's type-check block and ${knobName} is false — leaving it as it is`,
      );
    }
  }

  if (content !== existing) writeFileSync(targetPath, content);
  chmodSync(targetPath, 0o755);
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
 * update --init --recursive; bun install; }`) since 2026-06-06. `setup-env`
 * does submodules AND install as of SDK v0.12.1, plus mise trust,
 * `.worktreeinclude` copies, and the project's own `setup-env:<LABEL>` scripts —
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
  | {content: string; kind: 'created'}
  | {content: string; kind: 'replaced'; legacyStripped: boolean}
  | {content: string; kind: 'inserted'; legacyStripped: boolean}
  | {content: string; kind: 'unchanged'}
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
  /**
   * Force-overwrite hand-modified .husky/pre-commit and any husky/lint-staged
   * devDependency versions that differ from PINNED. Does NOT overwrite a
   * user's existing `prepare` script — that's always preserved.
   */
  force?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and chaining) */
  quiet?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
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
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
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
  // Resolved here, after base-setup may have written the config, exactly when
  // the step used to read it itself.
  const tsCheckKnob = await readTsCheckInHookKnob(projectRoot);
  if (!stepPreCommitHook(projectRoot, force, tsCheckKnob)) return 1;

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
