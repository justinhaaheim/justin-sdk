/**
 * prime — assemble the critical-guidelines for the current project and emit them.
 *
 * Reads markdown modules from the prompts repo (default: ~/Dev/prompts/guidelines),
 * evaluates each module's optional `include-if:` frontmatter against predicates
 * computed for the current project (v1: `isReactNative`), concatenates the
 * included modules under a single heading, and prints the result.
 *
 * Default output is human-readable markdown — run `justin-sdk prime` yourself to
 * inspect exactly what a session would receive. `--format hook` wraps the output
 * in the SessionStart `additionalContext` JSON envelope for use inside a Claude
 * Code SessionStart hook.
 *
 * Read-only. No network. Reads the LOCAL working tree of the prompts repo, so
 * editing a module there changes what the next session sees (edit -> live).
 *
 * Design: the prompts repo stays PURE markdown; the predicate registry (the
 * logic behind `include-if` names) lives here, in the SDK, versioned with the
 * assembler. See home-base epic t6a0.
 */

import {existsSync, readdirSync, readFileSync} from 'fs';
import {join, resolve} from 'path';

export interface PrimeOptions {
  format: 'markdown' | 'hook';
  promptsDir?: string;
}

interface ProjectContext {
  projectRoot: string;
  deps: Set<string>;
}

// --- predicate registry ----------------------------------------------------
// Named, is/has-prefixed booleans over the project context, referenced by name
// from a module's `include-if:` frontmatter. v1 ships exactly one; generalize
// (t6a0.5) when a second predicate actually exists.
const PREDICATES: Record<string, (ctx: ProjectContext) => boolean> = {
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
  return {projectRoot, deps};
}

// --- frontmatter -----------------------------------------------------------
interface ParsedModule {
  includeIf: string[]; // predicate names; empty = always include
  body: string;
}

function parseModule(raw: string): ParsedModule {
  // Only a leading `---\n ... \n---` block is treated as frontmatter.
  if (!raw.startsWith('---')) return {includeIf: [], body: raw.trim()};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {includeIf: [], body: raw.trim()};
  const frontmatter = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n+/, '');
  return {includeIf: parseIncludeIf(frontmatter), body: body.trim()};
}

function parseIncludeIf(frontmatter: string): string[] {
  const lines = frontmatter.split('\n');
  const idx = lines.findIndex((line) => /^include-if\s*:/.test(line));
  if (idx === -1) return [];
  const afterColon = (lines[idx] ?? '')
    .slice((lines[idx] ?? '').indexOf(':') + 1)
    .trim();
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
    const match = /^\s*-\s*(.+?)\s*$/.exec(lines[i] ?? '');
    if (match == null) break;
    if (match[1] != null) names.push(match[1]);
  }
  return names;
}

// --- module discovery ------------------------------------------------------
function findMarkdownModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, {withFileTypes: true}).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name.toLowerCase() !== 'readme.md'
      ) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

// --- inclusion decision ----------------------------------------------------
interface Decision {
  included: boolean;
  unknownPredicates: string[];
}

function decideInclusion(mod: ParsedModule, ctx: ProjectContext): Decision {
  const unknownPredicates = mod.includeIf.filter(
    (name) => PREDICATES[name] == null,
  );
  // Fail safe: a module gating on an unknown predicate is excluded (+warned),
  // never silently injected on an unevaluable condition.
  if (unknownPredicates.length > 0) {
    return {included: false, unknownPredicates};
  }
  const included = mod.includeIf.every((name) => {
    const pred = PREDICATES[name];
    return pred != null && pred(ctx);
  });
  return {included, unknownPredicates};
}

// --- assembly --------------------------------------------------------------
function resolvePromptsDir(opts: PrimeOptions): string {
  if (opts.promptsDir != null && opts.promptsDir.length > 0) {
    return resolve(opts.promptsDir);
  }
  const env = process.env.JSDK_PROMPTS_DIR;
  if (env != null && env.length > 0) return resolve(env);
  return resolve(process.env.HOME ?? '', 'Dev/prompts');
}

function composeMarkdown(parts: string[]): string {
  const header =
    '# CRITICAL GUIDELINES\n\n' +
    'The following cross-project guidance was injected by `justin-sdk prime` from ' +
    'the prompts repo — the single source of truth. To change a rule, edit the ' +
    'guidelines modules in the prompts repo, not this session.';
  if (parts.length === 0) {
    return `${header}\n\n_(No guideline modules matched this project.)_`;
  }
  return [header, ...parts].join('\n\n');
}

export function runPrime(projectRoot: string, opts: PrimeOptions): number {
  const guidelinesDir = join(resolvePromptsDir(opts), 'guidelines');

  // Graceful skip: remote/cloud sessions have no local prompts repo. Emit no
  // injectable content; note it on stderr so it never pollutes the context.
  if (!existsSync(guidelinesDir)) {
    process.stderr.write(
      `[prime] guidelines not found at ${guidelinesDir} — skipping guidance injection.\n`,
    );
    return 0;
  }

  const ctx = loadProjectContext(projectRoot);
  const parts: string[] = [];
  for (const file of findMarkdownModules(guidelinesDir)) {
    const mod = parseModule(readFileSync(file, 'utf-8'));
    const decision = decideInclusion(mod, ctx);
    if (decision.unknownPredicates.length > 0) {
      process.stderr.write(
        `[prime] ${file} references unknown predicate(s): ${decision.unknownPredicates.join(', ')} — excluded.\n`,
      );
    }
    if (decision.included && mod.body.length > 0) parts.push(mod.body);
  }

  const assembled = composeMarkdown(parts);

  if (opts.format === 'hook') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: assembled,
        },
      }),
    );
  } else {
    process.stdout.write(`${assembled}\n`);
  }
  return 0;
}
