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

export interface PrimeOptions {
  format: 'markdown' | 'hook';
  partition?: Partition; // default 'full'
  promptsDir?: string; // override: read this dir as-is (skip clone/pull)
  forceUpdate?: boolean; // force a fetch/pull of the managed clone, bypassing the staleness gate
}

interface ProjectContext {
  deps: Set<string>;
}

// --- predicate registry ----------------------------------------------------
// Named booleans over the project context, referenced by name from a
// component's `includeIf:` frontmatter. Lives in the SDK (versioned with the
// assembler); the prompts repo stays pure markdown. Generalizing this into a
// named is/has predicate framework (t6a0.5) is still deferred — this stays a
// small hand-written registry until that's worth building.
const PREDICATES: Record<string, (ctx: ProjectContext) => boolean> = {
  isReact: (ctx) =>
    ctx.deps.has('react') ||
    ctx.deps.has('expo') ||
    ctx.deps.has('react-native'),
  isReactNative: (ctx) => ctx.deps.has('expo') || ctx.deps.has('react-native'),
};

function loadProjectContext(projectRoot: string): ProjectContext {
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
  return {deps};
}

// --- managed prompts clone -------------------------------------------------

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

/** HEAD commit sha of a git checkout, or null if unavailable (e.g. a non-git
 * test fixture). Used to stamp/compare the deployed rules against the source. */
export function headSha(dir: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
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
 * Ensure a usable checkout of the prompts repo exists; return its root.
 * Clones on first use; refreshes (best-effort, staleness-gated) otherwise.
 * Throws only when there is no usable checkout at all (first run, offline).
 */
function ensurePromptsSource(opts: PrimeOptions): string {
  // Explicit override (skips clone/pull): the --prompts-dir flag or the
  // JSDK_PROMPTS_DIR env var. Used by tests and advanced/offline setups.
  const override = opts.promptsDir ?? process.env.JSDK_PROMPTS_DIR;
  if (override != null && override.length > 0) {
    return resolve(override);
  }
  const dir = managedCloneDir();
  const url = process.env.JSDK_PROMPTS_REPO_URL ?? DEFAULT_REPO_URL;
  const maxAge = Number(
    process.env.JSDK_PROMPTS_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS,
  );

  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), {recursive: true});
    // FULL clone (not --depth 1): version-manager computes the dynamic version
    // from commit COUNT, which a shallow clone can't provide (home-base-r3pb).
    git(['clone', url, `"${dir}"`]);
    touchMarker();
  } else if (existsSync(join(dir, '.git', 'shallow'))) {
    // Migrate a pre-r3pb shallow clone to a full one, self-healing.
    rmSync(dir, {recursive: true, force: true});
    git(['clone', url, `"${dir}"`]);
    touchMarker();
  } else if (opts.forceUpdate === true || isStale(maxAge)) {
    try {
      git(['fetch', 'origin', 'HEAD'], dir);
      git(['reset', '--hard', 'FETCH_HEAD'], dir);
      touchMarker();
    } catch {
      // Offline / transient: keep the existing checkout (offline resilience).
    }
  }
  return dir;
}

// --- frontmatter + inlining ------------------------------------------------

interface Frontmatter {
  includeIf: string[];
  body: string;
}

function stripFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return {includeIf: [], body: raw};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {includeIf: [], body: raw};
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n+/, '');
  return {includeIf: parseIncludeIf(fm), body};
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

function evaluateInclude(
  includeIf: string[],
  ctx: ProjectContext,
): {included: boolean; unknown: string[]} {
  const unknown = includeIf.filter((name) => PREDICATES[name] == null);
  if (unknown.length > 0) return {included: false, unknown};
  const included = includeIf.every((name) => {
    const pred = PREDICATES[name];
    return pred != null && pred(ctx);
  });
  return {included, unknown};
}

const AT_REFERENCE = /^\s*@(\S+)\s*$/;

interface InlineResult {
  text: string;
  count: number;
  /** Basenames (no .md) of the modules that were included, in order. */
  names: string[];
  warnings: string[];
}

/**
 * Inline a file: keep its lines, replacing each `@path` reference line with the
 * recursively-inlined, predicate-filtered content of the referenced file.
 */
function inlineFile(
  filePath: string,
  ctx: ProjectContext,
  depth: number,
  partition: Partition,
): InlineResult {
  if (depth > MAX_INLINE_DEPTH) {
    return {
      count: 0,
      text: '',
      names: [],
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
      if (partition === 'universal' && isConditional) continue;
      if (partition === 'conditional' && !isConditional) continue;
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
    const nested = inlineFile(refPath, ctx, depth + 1, 'full');
    out.push(nested.text);
    count += 1 + nested.count;
    names.push(basename(refPath, '.md'), ...nested.names);
    warnings.push(...nested.warnings);
  }

  return {count, text: out.join('\n').trim(), names, warnings};
}

// --- header ----------------------------------------------------------------

function buildHeader(): string {
  return '# Critical Rules';
}

// --- entry point -----------------------------------------------------------

export interface Assembled {
  count: number;
  /** Basenames (no .md) of the included modules, in order. */
  names: string[];
  /** Raw inlined content, no header — for callers that compose their own framing. */
  text: string;
  /** buildHeader() + text — the standalone rules document. */
  markdown: string;
  warnings: string[];
  /** The prompts dir actually read (the managed clone, unless overridden). */
  sourceDir: string;
  /** HEAD sha of sourceDir, or null (non-git fixture / unavailable). */
  sourceSha: string | null;
}

/**
 * Assemble the rules markdown for a project (no I/O to stdout). Exported so
 * the plugin SessionStart hook can compose the rules with other context
 * (e.g. repo-state) into a single injection. Throws if the rules can't be
 * loaded — callers decide how to degrade.
 */
export function assemble(opts: PrimeOptions, projectRoot: string): Assembled {
  const source = ensurePromptsSource(opts);
  // The prompts repo's rules dir was renamed src/guidelines -> src/rules
  // (home-base-r3pb.1). Prefer the new path; fall back to the old one so the
  // plugin and the prompts repo can be deployed in either order without a
  // broken window.
  const rulesIndex = join(source, 'src', 'rules', 'index.md');
  const legacyIndex = join(source, 'src', 'guidelines', 'index.md');
  const indexPath = existsSync(rulesIndex) ? rulesIndex : legacyIndex;
  if (!existsSync(indexPath)) {
    throw new Error(`rules index not found at ${rulesIndex}`);
  }
  const ctx = loadProjectContext(projectRoot);
  const partition = opts.partition ?? 'full';
  const {text, count, names, warnings} = inlineFile(
    indexPath,
    ctx,
    0,
    partition,
  );
  return {
    count,
    names,
    text,
    markdown: `${buildHeader()}\n\n${text}`.trim(),
    warnings,
    sourceDir: source,
    sourceSha: headSha(source),
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
