/**
 * sync-rules — regenerate the deployed critical-rules file that Claude Code
 * autoloads every session.
 *
 * Writes the UNIVERSAL (always-on) rules to
 *   ~/.claude/rules/justin-sdk/critical-rules.md
 * a user-level Claude Code rules file (autoloaded every session at CLAUDE.md
 * priority, no truncation). The project-type-gated (conditional) rules + repo
 * state stay in the thin SessionStart hook (home-base-r3pb).
 *
 * Source of truth: the MANAGED CLONE under ~/.config/justin-sdk/prompts
 * (a normal full checkout, pulled from the remote). This command NEVER reads
 * ~/Dev/prompts — the managed clone is the single source, so `sync-rules` works
 * identically from any project and on any machine.
 *
 * Stamp: an HTML comment (not read by Claude) records the version-manager
 * dynamic version, the source commit sha, and a content hash. The content hash
 * makes the write idempotent (unchanged rules => no rewrite); the sha drives the
 * hook's drift check. Run this AFTER pushing a change to the prompts repo (so
 * the managed clone can pull it): `bunx justin-sdk sync-rules`.
 */

import {execSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import {dirname, join} from 'path';

import prettier from 'prettier';

import {assemble} from './plugin/lib/prime';
import {
  buildStamp,
  contentHash,
  readDeployedStamp,
  rulesFilePath,
} from './plugin/lib/rules-file';
import {fail, setQuiet, success, warn} from './setup-helpers';

const VM_DEFAULT_SPEC = 'github:justinhaaheim/version-manager';

/**
 * Format the generated rules markdown with Prettier so the deployed file is
 * consistently formatted (deterministic output). NOTE: the drift/idempotency
 * hash is taken over the RAW assembled markdown, not this — because the
 * SessionStart hook that recomputes it runs in the plugin cache with no
 * node_modules and can't run Prettier. If Prettier ever fails, we fall back to
 * the raw markdown rather than block the deploy.
 */
async function prettierMarkdown(markdown: string): Promise<string> {
  try {
    return (await prettier.format(markdown, {parser: 'markdown'})).trimEnd();
  } catch {
    return markdown.trimEnd();
  }
}

/** The version-manager dep spec the prompts repo pins, so sync-rules stays in
 * lockstep with it (falls back to the repo's default branch). */
function versionManagerSpec(sourceDir: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(sourceDir, 'package.json'), 'utf-8'),
    ) as Record<string, Record<string, string> | undefined>;
    for (const section of [pkg.dependencies, pkg.devDependencies]) {
      const spec = section?.['@justinhaaheim/version-manager'];
      if (spec != null && spec.length > 0) {
        return spec.startsWith('github:') || spec.startsWith('http')
          ? spec
          : `@justinhaaheim/version-manager@${spec}`;
      }
    }
  } catch {
    // fall through to default
  }
  return VM_DEFAULT_SPEC;
}

/** Run version-manager against the managed clone (which has no node_modules, so
 * bunx fetches the pinned tool). Returns the dynamic version, or null if it
 * couldn't run. mise refuses untrusted config in the clone, so we trust it for
 * this invocation (same workaround the test sandbox uses). */
function computeVersion(sourceDir: string): string | null {
  // version-manager derives the version from git history; skip it (and the
  // bunx fetch) when the source isn't a git checkout (e.g. a test fixture).
  if (!existsSync(join(sourceDir, '.git'))) return null;
  const spec = versionManagerSpec(sourceDir);
  try {
    execSync(`bunx ${spec}`, {
      cwd: sourceDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
      env: {
        ...process.env,
        MISE_TRUSTED_CONFIG_PATHS: [
          sourceDir,
          process.env.MISE_TRUSTED_CONFIG_PATHS,
        ]
          .filter(Boolean)
          .join(':'),
      },
    });
    const jsonPath = join(sourceDir, 'dynamic-version.local.json');
    if (existsSync(jsonPath)) {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
        dynamicVersion?: string;
      };
      return data.dynamicVersion ?? null;
    }
  } catch {
    // version-manager unavailable/offline — caller stamps 'unknown'.
  }
  return null;
}

/** True if the source checkout has uncommitted changes (managed clone never
 * does; an overridden --prompts-dir might). */
function isDirty(sourceDir: string): boolean {
  try {
    const out = execSync('git status --porcelain', {
      cwd: sourceDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 8000,
    });
    // dynamic-version.local.json is gitignored; anything else = dirty.
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface SyncRulesOptions {
  quiet?: boolean;
  /** Rewrite even when the content hash is unchanged. */
  force?: boolean;
  /** ISO timestamp for the stamp (injectable for deterministic tests). */
  now?: string;
  /** Override the output path (defaults to ~/.claude/rules/justin-sdk/…). */
  outFile?: string;
}

export async function runSyncRules(
  options: SyncRulesOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);

  let assembled;
  try {
    // Universal partition is project-independent, so cwd doesn't matter.
    // forceUpdate pulls the managed clone to the latest remote first.
    assembled = assemble(
      {format: 'markdown', partition: 'universal', forceUpdate: true},
      process.cwd(),
    );
  } catch (error) {
    fail(
      `sync-rules: could not assemble universal rules (${error instanceof Error ? error.message : String(error)})`,
    );
    return 1;
  }

  const {markdown, count, sourceDir, sourceSha} = assembled;
  const hash = contentHash(markdown);
  const file = options.outFile ?? rulesFilePath();

  if (!options.force && readDeployedStamp(file)?.contentHash === hash) {
    success(
      `rules already in sync (content ${hash}, ${count} module${count === 1 ? '' : 's'}) — no rewrite`,
    );
    return 0;
  }

  const version = computeVersion(sourceDir) ?? 'unknown';
  if (version === 'unknown') {
    warn('version-manager unavailable — stamping version as "unknown"');
  }
  const shaShort = sourceSha != null ? sourceSha.slice(0, 12) : 'unknown';
  const commit = `${shaShort}${sourceSha != null && isDirty(sourceDir) ? '-dirty' : ''}`;
  const stamp = buildStamp({
    version,
    commit,
    contentHash: hash,
    generated: options.now ?? new Date().toISOString(),
  });
  // Prettier the BODY for consistent formatting; the stamp's content hash is
  // over the RAW markdown (above) so the hook can recompute it without Prettier.
  const body = `${stamp}\n\n${await prettierMarkdown(markdown)}\n`;

  // Atomic write (a session can start mid-write).
  mkdirSync(dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);

  success(
    `wrote ${file}\n  v${version} · commit ${commit} · ${count} module${count === 1 ? '' : 's'} · content ${hash}`,
  );
  return 0;
}
