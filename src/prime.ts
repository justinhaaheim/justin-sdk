/**
 * prime — assemble the critical-rules for the current project and emit them.
 *
 * Compiles `src/rules/index.md` from a MANAGED CLONE of the prompts repo
 * (default: ~/.config/justin-sdk/prompts). The index references component files
 * via `@./relative/path` lines (like CLAUDE.md imports); each reference is
 * inlined in order, recursively, and a component whose `includeIf:` frontmatter
 * does not match the current project is skipped.
 *
 * Why a managed clone (not the live ~/Dev/prompts working tree): reading the
 * working tree would race with in-progress edits — a session firing the hook
 * mid-edit could compile a half-written state and fail opaquely. Instead we clone
 * once and pull (best-effort, staleness-gated) — oh-my-zsh style. This also works
 * in Claude Code web / remote (public repo, no local checkout needed) and offline
 * (a prior clone keeps working without network).
 *
 * Output: `--format markdown` (default) prints human-readable markdown + a status
 * line on stderr. `--format hook` emits the SessionStart JSON envelope with
 * `additionalContext` (the guidance) and a `systemMessage` (a visible one-liner
 * with the compiled count, or a visible failure notice). Part of home-base t6a0.
 */

import {execSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {basename, dirname, join, resolve} from 'path';

const DEFAULT_REPO_URL = 'https://github.com/justinhaaheim/prompts.git';
const DEFAULT_MAX_AGE_SECONDS = 300;
const GIT_TIMEOUT_MS = 8000;
const MAX_INLINE_DEPTH = 10;

/**
 * Which slice of the rules to assemble:
 *  - 'universal'   — only always-on modules (no includeIf). Written to the
 *    natively-loaded rules file (~/.claude/rules/justin-sdk/critical-rules.md).
 *  - 'conditional' — only project-type-gated modules (includeIf) that match.
 *    This is the small subset injected through the SessionStart hook.
 *  - 'full'        — everything (universal + matching conditional). The default,
 *    and what `prime --full` prints on demand.
 */
export type Partition = 'universal' | 'conditional' | 'full';

/** How to obtain the prompts source. Shared by every assembly entry point. */
export interface SourceOptions {
  // override: read this dir as-is (skip clone/pull)
  forceUpdate?: boolean;
  promptsDir?: string; // force a fetch/pull of the managed clone, bypassing the staleness gate
}

/** What `assemble` needs: where the source comes from, and which slice to take. */
export interface AssembleOptions extends SourceOptions {
  partition?: Partition; // default 'full'
}

export interface PrimeOptions extends AssembleOptions {
  format: 'markdown' | 'hook';
}

export interface ProjectContext {
  deps: Set<string>;
  projectRoot: string;
}

// --- predicate registry ----------------------------------------------------
// Named booleans over the project context, referenced by name from a rules
// module's `includeIf:` frontmatter AND from a component's `includeIf` in
// components.ts (epic home-base-dchjw D3) — ONE registry, so "does this repo
// want the React rules" and "does this repo want the eas component" can never
// answer the same question two different ways. Lives in the SDK (versioned with
// the assembler); the prompts repo stays pure markdown. Generalizing this into a
// named is/has predicate framework (t6a0.5) is still deferred — this stays a
// small hand-written registry until that's worth building.
export const PREDICATES: Record<string, (ctx: ProjectContext) => boolean> = {
  /**
   * True for beads_rust (`br`) projects — NOT Yegge's Dolt-backed `bd`.
   *
   * The two are distinguished by `.beads/metadata.json`, which is git-tracked
   * (so this works on a fresh clone; `beads.db` would not — `.beads/.gitignore`
   * ignores `*.db`):
   *   br: {"database":"beads.db","jsonl_export":"issues.jsonl"}
   *   bd: {"database":"dolt","backend":"dolt","dolt_mode":"embedded",...}
   *
   * Dolt is excluded explicitly rather than requiring `database === 'beads.db'`
   * so that an upstream br schema tweak degrades to "still shows the beads
   * rules" instead of silently unguiding every project. Mirrors the existing
   * Dolt sniff in beads-setup's migration step.
   */
  isBeadsRust: (ctx) => {
    const metadataPath = join(ctx.projectRoot, '.beads', 'metadata.json');
    if (!existsSync(metadataPath)) return false;
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      return meta.backend !== 'dolt' && meta.database !== 'dolt';
    } catch {
      // Unparseable metadata.json -> don't claim it's beads_rust.
      return false;
    }
  },
  /**
   * An Expo app. NARROWER than isReactNative on purpose: the `eas` component
   * scaffolds EAS Build/Update config, which a bare react-native (non-Expo)
   * project has no use for.
   */
  isExpo: (ctx) => ctx.deps.has('expo'),
  isReact: (ctx) =>
    ctx.deps.has('react') ||
    ctx.deps.has('expo') ||
    ctx.deps.has('react-native'),
  isReactNative: (ctx) => ctx.deps.has('expo') || ctx.deps.has('react-native'),
};

export function loadProjectContext(projectRoot: string): ProjectContext {
  const deps = new Set<string>();
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
      ]) {
        const section = pkg[key];
        if (section != null && typeof section === 'object') {
          for (const name of Object.keys(section)) deps.add(name);
        }
      }
    } catch {
      // Unparseable package.json -> no deps detected; predicates fall to false.
    }
  }
  return {deps, projectRoot};
}

// --- managed prompts clone -------------------------------------------------

/**
 * A second copy of `xdgConfigHome`, originally forced by the plugin's import
 * closure (retired in dchjw.8) and now simply unmerged — see the note on
 * health-notices.ts's own copy.
 *
 * It also DIVERGES from that one, which falls back to `homedir()` when HOME is
 * unset or empty (uxwc.5 F4). Here `resolve('', '.config')` resolves relative
 * to the CWD — wrong, but only ever READ through: the worst case is a managed
 * clone this fails to find and reports as missing. Nothing on this path writes.
 */
function xdgConfigHome(): string {
  const fromEnv = process.env.XDG_CONFIG_HOME;
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  return resolve(process.env.HOME ?? '', '.config');
}

function managedCloneDir(): string {
  return join(xdgConfigHome(), 'justin-sdk', 'prompts');
}

function lastPullMarker(): string {
  return join(xdgConfigHome(), 'justin-sdk', '.prompts-last-pull');
}

function git(args: string[], cwd?: string): void {
  execSync(`git ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * Identity of the prompts checkout an assembly was read from.
 *
 * ONE nullable value, not two (critical rule 6): the sha and the commit date
 * come from a SINGLE `git show` and are stamped into the artifact header
 * together, so "half known" must be unrepresentable. A non-git fixture, or a git
 * that cannot be run at all, yields null for the pair — never a sha with an
 * invented date, and never a date that outlives its sha.
 */
export interface PromptsCommit {
  /** Committer date, YYYY-MM-DD (git's `%cs`). */
  date: string;
  /** Full HEAD sha. */
  sha: string;
}

/**
 * HEAD sha + commit date of a git checkout, or null if unavailable (e.g. a
 * non-git test fixture). Used to stamp/compare the deployed rules against the
 * source.
 */
export function headCommit(dir: string): PromptsCommit | null {
  let out: string;
  try {
    out = execSync('git show -s --format=%H%n%cs HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const [sha, date] = out.trim().split('\n');
  // A truncated or reshaped git output is a FAILED measurement, not a commit
  // with empty fields — refuse it rather than stamping ''.
  if (sha == null || sha.length === 0 || date == null || date.length === 0) {
    return null;
  }
  return {date, sha};
}

/**
 * True if a checkout has uncommitted changes. The managed clone never does; an
 * overridden --prompts-dir (e.g. ~/Dev/prompts) can, and both the user-level
 * rules file and the committed per-repo artifact stamp that fact so a
 * generated-from-a-dirty-tree file is identifiable.
 *
 * Returns false when git cannot be run at all (non-git fixture). Both callers
 * only reach this with a sha in hand, so "no git" cannot be observed here; the
 * stamp says 'unknown' in that case and never claims cleanliness.
 */
export function isDirtyCheckout(dir: string): boolean {
  try {
    const out = execSync('git status --porcelain', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
    // dynamic-version.local.json is gitignored; anything else = dirty.
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function isStale(maxAgeSeconds: number): boolean {
  const marker = lastPullMarker();
  if (!existsSync(marker)) return true;
  return Date.now() - statSync(marker).mtimeMs > maxAgeSeconds * 1000;
}

function touchMarker(): void {
  writeFileSync(lastPullMarker(), new Date().toISOString());
}

/**
 * What actually happened when the prompts source was obtained. Threaded out of
 * `ensurePromptsSource` (t6a0.21 D15) because offline TOLERANCE IS NOT LICENSE
 * TO WRITE: a reader (the prime hook) may happily use a stale checkout, but a
 * writer that commits an artifact into a repo must never generate it from
 * content it could not verify. 'failed' therefore has to be a distinct,
 * inspectable state rather than being silently indistinguishable from success.
 *
 *  - 'override' — an explicit promptsDir/JSDK_PROMPTS_DIR: read as-is, no
 *    refresh attempted (the deliberate escape hatch, also what tests use).
 *  - 'cloned'   — no usable checkout existed and the clone succeeded.
 *  - 'pulled'   — fetch + reset succeeded; the checkout matches the remote.
 *  - 'skipped'  — the staleness gate said no refresh was needed. Fresh ENOUGH
 *    for a reader; NOT proof of freshness for a writer.
 *  - 'failed'   — a refresh was attempted and failed. The checkout still works
 *    (that's the point of the tolerance) but it may be stale.
 */
export type SourceRefresh =
  | 'override'
  | 'cloned'
  | 'pulled'
  | 'skipped'
  | 'failed';

export interface PromptsSource {
  dir: string;
  refresh: SourceRefresh;
}

/**
 * Marker prefix on the error thrown when there is NO usable prompts checkout at
 * all (first run, offline). Callers that write files match on it to report
 * "cannot check the source" distinctly from "assembled, but the content is
 * wrong" — a string sentinel rather than an Error subclass because the codebase
 * avoids classes and this module must stay dependency-free.
 */
export const PROMPTS_SOURCE_FAILURE = 'prompts-source-unavailable';

/**
 * Ensure a usable checkout of the prompts repo exists; return its root and
 * whether it was actually refreshed. Clones on first use; refreshes
 * (best-effort, staleness-gated) otherwise. Throws only when there is no usable
 * checkout at all (first run, offline) — with a PROMPTS_SOURCE_FAILURE-prefixed
 * message.
 */
function ensurePromptsSource(opts: SourceOptions): PromptsSource {
  // Explicit override (skips clone/pull): the --prompts-dir flag or the
  // JSDK_PROMPTS_DIR env var. Used by tests and advanced/offline setups.
  const override = opts.promptsDir ?? process.env.JSDK_PROMPTS_DIR;
  if (override != null && override.length > 0) {
    return {dir: resolve(override), refresh: 'override'};
  }
  const dir = managedCloneDir();
  const url = process.env.JSDK_PROMPTS_REPO_URL ?? DEFAULT_REPO_URL;
  const maxAge = Number(
    process.env.JSDK_PROMPTS_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS,
  );

  const clone = (): PromptsSource => {
    try {
      // FULL clone (not --depth 1): version-manager computes the dynamic
      // version from commit COUNT, which a shallow clone can't provide
      // (home-base-r3pb).
      git(['clone', url, `"${dir}"`]);
    } catch (error) {
      throw new Error(
        `${PROMPTS_SOURCE_FAILURE}: could not clone ${url} into ${dir} ` +
          `(${error instanceof Error ? error.message.trim() : String(error)})`,
      );
    }
    touchMarker();
    return {dir, refresh: 'cloned'};
  };

  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), {recursive: true});
    return clone();
  }
  if (existsSync(join(dir, '.git', 'shallow'))) {
    // Migrate a pre-r3pb shallow clone to a full one, self-healing.
    rmSync(dir, {force: true, recursive: true});
    return clone();
  }
  if (opts.forceUpdate === true || isStale(maxAge)) {
    try {
      git(['fetch', 'origin', 'HEAD'], dir);
      git(['reset', '--hard', 'FETCH_HEAD'], dir);
      touchMarker();
      return {dir, refresh: 'pulled'};
    } catch {
      // Offline / transient: keep the existing checkout (offline resilience).
      // Reported as 'failed' so a WRITER can refuse; readers ignore it.
      return {dir, refresh: 'failed'};
    }
  }
  return {dir, refresh: 'skipped'};
}

// --- frontmatter + inlining ------------------------------------------------

interface Frontmatter {
  body: string;
  includeIf: string[];
}

function parseIncludeIf(frontmatter: string): string[] {
  const lines = frontmatter.split('\n');
  const idx = lines.findIndex((line) => /^includeIf\s*:/.test(line));
  if (idx === -1) return [];
  const line = lines[idx] ?? '';
  const afterColon = line.slice(line.indexOf(':') + 1).trim();
  if (afterColon.startsWith('[')) {
    return afterColon
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // YAML block-list form (`- name` on following lines)
  const names: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const name = /^\s*-\s*(.+?)\s*$/.exec(lines[i] ?? '')?.[1];
    if (name == null) break;
    names.push(name);
  }
  return names;
}

function stripFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return {body: raw, includeIf: []};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {body: raw, includeIf: []};
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n+/, '');
  return {body, includeIf: parseIncludeIf(fm)};
}

/**
 * Evaluate a list of predicate names against a project.
 *
 * FAIL-CLOSED on an unknown name: `included` is false and the unknown names are
 * returned so the caller can say so out loud. A predicate this SDK has never
 * heard of is a FAILED measurement, not a passing one (critical rule 6) — the
 * reassuring direction here would be to include the thing anyway.
 */
export function evaluateInclude(
  includeIf: string[],
  ctx: ProjectContext,
): {included: boolean; unknown: string[]} {
  const unknown = includeIf.filter((name) => PREDICATES[name] == null);
  if (unknown.length > 0) return {included: false, unknown};
  const included = includeIf.every((name) => {
    const pred = PREDICATES[name];
    return pred?.(ctx) === true;
  });
  return {included, unknown};
}

const AT_REFERENCE = /^\s*@(\S+)\s*$/;

interface InlineResult {
  count: number;
  /** Basenames (no .md) of the modules that were included, in order. */
  names: string[];
  text: string;
  warnings: string[];
}

/**
 * How the inliner decides which `@`-references to keep: the registry and the
 * predicates, every time, for every caller (epic home-base-dchjw D2).
 *
 * There is exactly ONE mode. A second one — SELECTION, which filtered top-level
 * refs against an explicit per-repo list recorded at enrolment — was deleted in
 * dchjw.3 and must not come back. It was an ENORMOUS FOOTGUN in Justin's words:
 * a module added to the registry never reached an already-enrolled repo, a
 * module deleted from a repo's list silently vanished from its rules, and
 * rules-drift certified all of it as in-sync. Whatever the index says, plus the
 * predicates evaluated against the project AS IT IS RIGHT NOW, is the answer.
 */
interface InlineGate {
  partition: Partition;
}

/**
 * Inline a file: keep its lines, replacing each `@path` reference line with the
 * recursively-inlined, gate-filtered content of the referenced file.
 */
function inlineFile(
  filePath: string,
  ctx: ProjectContext,
  depth: number,
  gate: InlineGate,
): InlineResult {
  if (depth > MAX_INLINE_DEPTH) {
    return {
      count: 0,
      names: [],
      text: '',
      warnings: [`max inline depth at ${filePath}`],
    };
  }
  const {body} = stripFrontmatter(readFileSync(filePath, 'utf-8'));
  const out: string[] = [];
  let count = 0;
  const names: string[] = [];
  const warnings: string[] = [];

  for (const line of body.split('\n')) {
    const ref = AT_REFERENCE.exec(line)?.[1];
    if (ref == null) {
      out.push(line);
      continue;
    }
    const refPath = resolve(dirname(filePath), ref);
    if (!existsSync(refPath)) {
      warnings.push(`missing @-reference "${ref}" in ${filePath}`);
      continue;
    }
    const {includeIf} = stripFrontmatter(readFileSync(refPath, 'utf-8'));
    const name = basename(refPath, '.md');
    // Partition gate — applied ONLY to the top-level (index) refs (depth 0). A
    // top-level module with any includeIf is "conditional"; one with none is
    // "universal". 'universal' drops conditionals; 'conditional' drops
    // universals; 'full' keeps both. A module's entire nested subtree travels
    // WITH it (nested refs are inlined wholesale, predicate-gated but not
    // partition-gated) so that `universal ∪ conditional === full` holds even
    // when a nested ref's conditionality differs from its parent's — otherwise
    // such a nested ref would silently land in neither deployed half.
    if (depth === 0) {
      const isConditional = includeIf.length > 0;
      if (gate.partition === 'universal' && isConditional) continue;
      if (gate.partition === 'conditional' && !isConditional) continue;
    }
    const {included, unknown} = evaluateInclude(includeIf, ctx);
    if (unknown.length > 0) {
      warnings.push(
        `unknown predicate(s) ${unknown.join(', ')} in ${refPath} — excluded`,
      );
      continue;
    }
    if (!included) continue;
    // Nested subtree is inlined in full (partition gating is top-level only).
    const nested = inlineFile(refPath, ctx, depth + 1, {partition: 'full'});
    out.push(nested.text);
    count += 1 + nested.count;
    names.push(name, ...nested.names);
    warnings.push(...nested.warnings);
  }

  return {count, names, text: out.join('\n').trim(), warnings};
}

// --- header ----------------------------------------------------------------

function buildHeader(): string {
  return '# Critical Rules';
}

/**
 * Number every ATX heading with its full dotted outline path, so a rule can be
 * cited unambiguously ("see 2.1.1"):
 *   # 1. A / # 2. B / ## 2.1 B.a / ## 2.2 B.b / ### 2.2.1 B.b.i / # 3. C
 * Top-level headings render as `1.` (trailing period); deeper ones as the bare
 * dotted path. Headings inside fenced code blocks are left alone.
 *
 * `prefix` namespaces the numbers (e.g. 'P-' → `P-1`, `P-2.1`). The conditional
 * hook injection uses 'P-' so its numbers don't collide with the plain 1/2/3 of
 * the autoloaded universal rules file — the two documents coexist in one session
 * and "see P-3.1" must be unambiguous from "see 2.1". A prefixed top-level
 * heading has NO trailing period (`P-1`, not `P-1.`).
 *
 * Hand-rolled on purpose: this runs inside assemble(), on the session-start
 * path, and ATX heading detection plus a counter stack is a poor use of a
 * markdown-AST lib (remark/mdast). It was once a hard requirement — the plugin
 * ran from a marketplace cache with NO node_modules — and is now a preference.
 *
 * Callers pass the BODY only: the '# Critical Rules' title is prepended after
 * numbering so it stays unnumbered.
 */
export function numberHeaders(markdown: string, prefix = ''): string {
  const counters: number[] = [];
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (m == null) return line;
      // The hash run is a mandatory group, so this cannot be absent — but a
      // regex whose shape changed should leave the line alone rather than
      // number it from an assumed level.
      const hashes = m[1];
      if (hashes == null) return line;
      const level = hashes.length;
      // Pad any skipped intermediate levels (e.g. an H1 followed by an H3) so
      // the dotted path stays well-formed.
      while (counters.length < level - 1) counters.push(1);
      const next = (counters[level - 1] ?? 0) + 1;
      counters.length = level; // reset all deeper-level counters
      counters[level - 1] = next;
      const path = counters.join('.');
      // Prefixed: `P-1` / `P-2.1` (no trailing period). Plain: `1.` at the top
      // level, bare dotted path below.
      const label =
        prefix !== '' ? `${prefix}${path}` : level === 1 ? `${path}.` : path;
      return `${m[1]} ${label} ${m[2]}`;
    })
    .join('\n');
}

// --- entry point -----------------------------------------------------------

export interface Assembled {
  count: number;
  /** buildHeader() + text — the standalone rules document. */
  markdown: string;
  /** Basenames (no .md) of the included modules, in order. */
  names: string[];
  /** HEAD sha + date of sourceDir, or null (non-git fixture / unavailable). */
  sourceCommit: PromptsCommit | null;
  /** The prompts dir actually read (the managed clone, unless overridden). */
  sourceDir: string;
  /** Whether the source was actually refreshed — writers MUST check this (D15). */
  sourceRefresh: SourceRefresh;
  /** Raw inlined content, no header — for callers that compose their own framing. */
  text: string;
  warnings: string[];
}

/**
 * Locate the rules index inside a prompts checkout.
 *
 * The prompts repo's rules dir was renamed src/guidelines -> src/rules
 * (home-base-r3pb.1). Prefer the new path; fall back to the old one so the SDK
 * and the prompts repo can be deployed in either order without a broken
 * window.
 */
function rulesIndexPath(source: string): string {
  const rulesIndex = join(source, 'src', 'rules', 'index.md');
  const legacyIndex = join(source, 'src', 'guidelines', 'index.md');
  const indexPath = existsSync(rulesIndex) ? rulesIndex : legacyIndex;
  if (!existsSync(indexPath)) {
    throw new Error(`rules index not found at ${rulesIndex}`);
  }
  return indexPath;
}

/**
 * Assemble the rules markdown for a project (no I/O to stdout). Exported so
 * `session-start` can compose the rules with other context (e.g. repo-state)
 * into a single injection. Throws if the rules can't be loaded — callers decide
 * how to degrade.
 */
export function assemble(
  opts: AssembleOptions,
  projectRoot: string,
): Assembled {
  const {dir: source, refresh} = ensurePromptsSource(opts);
  const indexPath = rulesIndexPath(source);
  const ctx = loadProjectContext(projectRoot);
  const partition = opts.partition ?? 'full';
  const {text, count, names, warnings} = inlineFile(indexPath, ctx, 0, {
    partition,
  });
  // Number the body only, then prepend the title (the title carries no number).
  // The conditional partition is the hook injection, which coexists in-session
  // with the plain-numbered universal rules FILE — give it the 'P-' namespace so
  // "see P-3.1" is unambiguous from the file's "2.1". Every other partition
  // stands alone (the file, or the missing-file/`--full` fallbacks), so it uses
  // plain numbering.
  const prefix = partition === 'conditional' ? 'P-' : '';
  const numbered = numberHeaders(text, prefix);
  return {
    count,
    markdown: `${buildHeader()}\n\n${numbered}`.trim(),
    names,
    sourceCommit: headCommit(source),
    sourceDir: source,
    sourceRefresh: refresh,
    text: numbered,
    warnings,
  };
}

export function runPrime(projectRoot: string, opts: PrimeOptions): number {
  let assembled: Assembled;
  try {
    assembled = assemble(opts, projectRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failMsg = `justin-sdk prime · FAILED to load rules (${reason}). No rules injected — provide them manually or troubleshoot.`;
    if (opts.format === 'hook') {
      process.stdout.write(JSON.stringify({systemMessage: failMsg}));
    } else {
      process.stderr.write(`${failMsg}\n`);
    }
    return 0; // never break the session over guidance
  }

  const {markdown, count, warnings} = assembled;
  const status =
    `justin-sdk prime · ${count} rule module${count === 1 ? '' : 's'} compiled` +
    (warnings.length > 0 ? ` · ${warnings.length} warning(s)` : '');

  if (opts.format === 'hook') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: markdown,
          hookEventName: 'SessionStart',
        },
        systemMessage: status,
      }),
    );
  } else {
    process.stdout.write(`${markdown}\n`);
    process.stderr.write(`\n${status}\n`);
    for (const warning of warnings) process.stderr.write(`  ⚠ ${warning}\n`);
  }
  return 0;
}
