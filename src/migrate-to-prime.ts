/**
 * migrate-to-prime.ts — one-time (idempotent) migration of a project from the
 * old committed-guidance world (docs/prompts/ + AGENTS.md + CLAUDE.md @-refs)
 * to the new `justin-sdk prime` world (guidance injected at session start from
 * the central prompts repo).
 *
 * End state per project: just its own CLAUDE.md. No docs/prompts/, no AGENTS.md,
 * no @-references to either, and no per-project prime SessionStart hook — the
 * `prime` Claude Code plugin injects the guidance globally (installed once per
 * machine), so a per-project `bunx @jhaa/justin-sdk prime` hook would only
 * double-inject. This migration REMOVES any such hook it finds (home-base-t6a0.16).
 *
 * Design (home-base-t6a0.12, fable-advisor-reviewed):
 *  - SAFE DELETES ONLY. A file is deleted only if it is git-tracked AND clean
 *    (so the deletion is fully recoverable via git) AND — for docs/prompts —
 *    has a known auto-generated name. Anything untracked, dirty, unknown-named,
 *    or containing non-generated content is FLAGGED for manual review, never
 *    deleted.
 *  - CLAUDE.md: mechanically remove standalone @-ref lines only. @-refs embedded
 *    in prose are FLAGGED (file:line) for manual cleanup — no NLP-grade prose
 *    surgery.
 *  - Default no-commit: mutate the working tree, print a summary, and let the
 *    human spot-check the diff before committing (matches the SDK's other
 *    commands + Justin's spot-check-before-commit requirement).
 *
 * This release also removes the AGENTS.md / @AGENTS.md doctor checks (see
 * doctor.ts) so `doctor` at session start no longer re-generates AGENTS.md.
 * The beads-setup INSTALLER still regenerates AGENTS.md on a manual
 * `add beads`/`update` — do not run those on a migrated project until
 * home-base-t6a0.14 lands.
 */

import {existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'fs';
import {basename, join, resolve} from 'path';

import {
  exec,
  fail,
  readJson,
  setQuiet,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIME_HOOK_NEEDLE = 'justin-sdk prime';
const AGENTS_MARKER = '<!-- br-agent-instructions-v1 -->';

/**
 * Known auto-generated filenames under docs/prompts/ (installed by the old
 * `install-my-prompts` script). A file with one of these names that is also
 * git-tracked + clean is safe to delete; anything else is flagged.
 */
const KNOWN_PROMPT_FILES = new Set([
  'BEADS.md',
  'CHECK_YOUR_WORK.md',
  'COMMIT_REGULARLY.md',
  'IMPORTANT_GUIDELINES.md',
  'IMPORTANT_GUIDELINES_INLINED.md',
  'MAKE_A_PLAN.md',
  'PARTNER_WITH_ME.md',
  'S2T_GUIDELINES.md',
  'SHREWD_SENIOR_ENGINEER_PERSONA.md',
  'STAY_FOCUSED.md',
  'USE_GOOD_STYLE.md',
  'USE_SCRATCHPAD.md',
]);

/** Components describing artifacts that no longer exist post-migration. */
const OBSOLETE_COMPONENTS = ['prompts-setup', 'claude-md-setup'];

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/** True if `relPath` is tracked by git in this repo. */
function isTracked(projectRoot: string, relPath: string): boolean {
  return (
    exec(`git ls-files --error-unmatch -- '${relPath}'`, projectRoot)
      .exitCode === 0
  );
}

/** True if `relPath` has no uncommitted changes in the working tree/index. */
function isClean(projectRoot: string, relPath: string): boolean {
  const {stdout, exitCode} = exec(
    `git status --porcelain -- '${relPath}'`,
    projectRoot,
  );
  return exitCode === 0 && stdout.trim().length === 0;
}

/** Safe to delete = git-tracked AND clean (deletion recoverable from git). */
function safeToDelete(projectRoot: string, relPath: string): boolean {
  return isTracked(projectRoot, relPath) && isClean(projectRoot, relPath);
}

// ---------------------------------------------------------------------------
// Report accumulation
// ---------------------------------------------------------------------------

interface Report {
  did: string[];
  flagged: string[];
}

// ---------------------------------------------------------------------------
// Step: remove the per-project prime SessionStart hook (structure-aware,
// idempotent). The `prime` plugin injects guidance globally, so a per-project
// `bunx @jhaa/justin-sdk prime` hook only double-injects — strip any we find, drop
// the emptied groups, and preserve every other hook (setup-env etc.).
// ---------------------------------------------------------------------------

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

function stepRemovePrimeHook(projectRoot: string, report: Report): void {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  const settings = readJson(settingsPath);
  if (settings == null) return; // no settings.json — nothing to remove

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const sessionStart = hooks?.SessionStart as HookGroup[] | undefined;
  if (hooks == null || !Array.isArray(sessionStart)) return;

  let removed = 0;
  const nextGroups: HookGroup[] = [];
  for (const group of sessionStart) {
    const kept = (group.hooks ?? []).filter((h) => {
      const isPrime =
        typeof h.command === 'string' && h.command.includes(PRIME_HOOK_NEEDLE);
      if (isPrime) removed++;
      return !isPrime;
    });
    // Drop a now-empty group entirely; otherwise keep it with the survivors.
    if (kept.length > 0) {
      group.hooks = kept;
      nextGroups.push(group);
    }
  }

  if (removed === 0) {
    report.did.push(
      'No per-project prime hook in .claude/settings.json (nothing to remove)',
    );
    return;
  }

  if (nextGroups.length > 0) {
    hooks.SessionStart = nextGroups;
  } else {
    delete hooks.SessionStart; // empty SessionStart array — drop the key
    if (Object.keys(hooks).length === 0) {
      delete (settings as Record<string, unknown>).hooks;
    }
  }
  writeJson(settingsPath, settings);
  report.did.push(
    `Removed ${removed} per-project prime hook(s) from .claude/settings.json SessionStart`,
  );
}

// ---------------------------------------------------------------------------
// Step: remove docs/prompts/ (safe files only) + install-my-prompts script
// ---------------------------------------------------------------------------

function stepDocsPrompts(projectRoot: string, report: Report): void {
  const dir = resolve(projectRoot, 'docs/prompts');
  if (existsSync(dir)) {
    const entries = readdirSync(dir, {withFileTypes: true});
    let remaining = 0;
    for (const entry of entries) {
      const rel = `docs/prompts/${entry.name}`;
      if (
        entry.isFile() &&
        KNOWN_PROMPT_FILES.has(entry.name) &&
        safeToDelete(projectRoot, rel)
      ) {
        rmSync(join(dir, entry.name));
        report.did.push(`Removed ${rel}`);
      } else {
        remaining++;
        const reason = !entry.isFile()
          ? 'not a regular file'
          : !KNOWN_PROMPT_FILES.has(entry.name)
            ? 'unknown filename (may be project-specific)'
            : !isTracked(projectRoot, rel)
              ? 'untracked'
              : 'has uncommitted changes';
        report.flagged.push(
          `${rel} — NOT deleted (${reason}); review manually`,
        );
      }
    }
    // Remove docs/prompts (and an empty docs/) only if fully cleared.
    if (remaining === 0) {
      rmSync(dir, {recursive: true, force: true});
      const docsDir = resolve(projectRoot, 'docs');
      if (existsSync(docsDir) && readdirSync(docsDir).length === 0) {
        rmSync(docsDir, {recursive: true, force: true});
      }
    }
  }

  // Remove the install-my-prompts package.json script (a revert vector that
  // would re-populate docs/prompts).
  const pkgPath = resolve(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts != null && 'install-my-prompts' in scripts) {
        delete scripts['install-my-prompts'];
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        report.did.push('Removed install-my-prompts script from package.json');
      }
    } catch {
      report.flagged.push(
        'package.json — could not parse to remove install-my-prompts script; review manually',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step: remove AGENTS.md (only if it is purely the generated beads block)
// ---------------------------------------------------------------------------

function stepAgentsMd(projectRoot: string, report: Report): void {
  const agentsPath = resolve(projectRoot, 'AGENTS.md');
  if (!existsSync(agentsPath)) return;

  const content = readFileSync(agentsPath, 'utf-8');
  const markerIdx = content.indexOf(AGENTS_MARKER);

  if (markerIdx === -1) {
    report.flagged.push(
      'AGENTS.md — no beads marker; looks hand-written. NOT deleted; review/move to CLAUDE.md manually',
    );
    return;
  }

  // Everything before the marker must be trivial (blank or a bare title).
  const preMarker = content.slice(0, markerIdx).trim();
  const preIsTrivial = preMarker.length === 0 || /^#[^\n]*$/.test(preMarker); // empty or a single heading line
  if (!preIsTrivial) {
    report.flagged.push(
      'AGENTS.md — contains hand-written content before the beads marker. NOT deleted; move that content to CLAUDE.md then delete manually',
    );
    return;
  }

  if (!safeToDelete(projectRoot, 'AGENTS.md')) {
    const reason = !isTracked(projectRoot, 'AGENTS.md')
      ? 'untracked'
      : 'has uncommitted changes';
    report.flagged.push(
      `AGENTS.md — ${reason}; NOT deleted (deletion must be git-recoverable). Commit/stash then re-run`,
    );
    return;
  }

  rmSync(agentsPath);
  report.did.push('Removed AGENTS.md (generated beads block only)');
}

// ---------------------------------------------------------------------------
// Step: strip standalone @-ref lines from CLAUDE.md; flag the rest
// ---------------------------------------------------------------------------

const STANDALONE_REF = /^\s*@(AGENTS\.md|docs\/prompts\/[^\s]+)\s*$/;
const HEADING = /^#{1,6}\s/;

function stepClaudeMd(projectRoot: string, report: Report): void {
  const claudePath = resolve(projectRoot, 'CLAUDE.md');
  if (!existsSync(claudePath)) return;

  const original = readFileSync(claudePath, 'utf-8');
  const lines = original.split('\n');
  const kept: string[] = [];
  let removedCount = 0;

  for (const line of lines) {
    if (STANDALONE_REF.test(line)) {
      removedCount++;
      // Flag an orphaned heading immediately preceding the removed ref.
      const prevNonBlank = [...kept].reverse().find((l) => l.trim().length > 0);
      if (prevNonBlank != null && HEADING.test(prevNonBlank)) {
        report.flagged.push(
          `CLAUDE.md — heading "${prevNonBlank.trim()}" may now be orphaned (its @-ref was removed); review`,
        );
      }
      continue;
    }
    kept.push(line);
  }

  // Only rewrite CLAUDE.md if we actually removed a ref — never touch it for
  // pure-whitespace reasons (that would produce a noisy no-op diff + a
  // misleading "Removed 0" report).
  let next = original;
  if (removedCount > 0) {
    // Collapse the runs of 2+ blank lines a removed ref may have left behind.
    const collapsed: string[] = [];
    let blankRun = 0;
    for (const line of kept) {
      if (line.trim().length === 0) {
        blankRun++;
        if (blankRun >= 2) continue;
      } else {
        blankRun = 0;
      }
      collapsed.push(line);
    }
    next = collapsed.join('\n');
    if (!next.endsWith('\n')) next += '\n';
    writeFileSync(claudePath, next);
    report.did.push(
      `Removed ${removedCount} standalone @-ref line(s) from CLAUDE.md`,
    );
  }

  // Flag any remaining references (prose-embedded @-refs, inventory mentions).
  const finalLines = next.split('\n');
  finalLines.forEach((line, i) => {
    if (line.includes('docs/prompts') || line.includes('AGENTS.md')) {
      report.flagged.push(
        `CLAUDE.md:${i + 1} — still references docs/prompts or AGENTS.md: "${line.trim()}" — remove manually`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Step: drop obsolete components from justin-sdk.config.json
// ---------------------------------------------------------------------------

function stepConfig(projectRoot: string, report: Report): void {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) return;

  const components = (config.components as string[] | undefined) ?? [];
  const filtered = components.filter((c) => !OBSOLETE_COMPONENTS.includes(c));
  if (filtered.length !== components.length) {
    config.components = filtered;
    writeJson(configPath, config);
    const removed = components.filter((c) => OBSOLETE_COMPONENTS.includes(c));
    report.did.push(
      `Removed obsolete component(s) from justin-sdk.config.json: ${removed.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step: repo-wide flag pass (flag-only, never delete)
// ---------------------------------------------------------------------------

function stepRepoGrep(projectRoot: string, report: Report): void {
  // Flag other tracked files that still mention docs/prompts or AGENTS.md so
  // the spot-check can catch READMEs / memory files / inventory docs.
  // Exclude CLAUDE.md/AGENTS.md (handled above) and .beads data (the JSONL
  // export mentions AGENTS.md in bead text — noise in every project).
  const {stdout} = exec(
    "git grep -l -e 'docs/prompts' -e 'AGENTS.md' -- ':!CLAUDE.md' ':!AGENTS.md' ':!.beads'",
    projectRoot,
  );
  for (const file of stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)) {
    report.flagged.push(
      `${file} — still mentions docs/prompts or AGENTS.md (flag only, not modified); review`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MigrateToPrimeOptions {
  projectRoot?: string;
  quiet?: boolean;
  /** Commit the migration at the end. Default false (inspect the diff first). */
  commit?: boolean;
}

export function runMigrateToPrime(options: MigrateToPrimeOptions = {}): number {
  const quiet = options.quiet ?? false;
  setQuiet(quiet);
  const projectRoot = options.projectRoot ?? process.cwd();

  // Must be a git repo (deletion safety relies on git-tracked + clean).
  if (exec('git rev-parse --is-inside-work-tree', projectRoot).exitCode !== 0) {
    fail('migrate-to-prime must be run inside a git repository');
    return 1;
  }

  if (!quiet) {
    console.log(
      `\n\x1b[1mMigrating ${basename(projectRoot)} to justin-sdk prime\x1b[0m\n`,
    );
  }

  const report: Report = {did: [], flagged: []};

  stepRemovePrimeHook(projectRoot, report);
  stepDocsPrompts(projectRoot, report);
  stepAgentsMd(projectRoot, report);
  stepClaudeMd(projectRoot, report);
  stepConfig(projectRoot, report);
  stepRepoGrep(projectRoot, report);

  if (!quiet) {
    console.log('\x1b[1mDID:\x1b[0m');
    if (report.did.length === 0) console.log('  (nothing — already migrated)');
    for (const item of report.did) success(item);

    console.log('\n\x1b[1;33mFLAGGED for manual spot-check:\x1b[0m');
    if (report.flagged.length === 0) {
      console.log('  (none)');
    } else {
      for (const item of report.flagged) warn(item);
    }
  }

  if (options.commit === true) {
    const status = exec('git status --porcelain', projectRoot);
    if (status.stdout.trim().length > 0) {
      exec('git add -A', projectRoot);
      const result = exec(
        "git commit -m 'Migrate to justin-sdk prime (remove docs/prompts + AGENTS.md + CLAUDE.md @-refs + per-project prime hook)'",
        projectRoot,
      );
      if (result.exitCode === 0) success('Committed migration');
      else warn('git commit failed — commit manually');
    }
  } else if (!quiet) {
    console.log(
      '\n\x1b[2mNo commit (default). Inspect the diff, resolve FLAGGED items, then commit.\x1b[0m',
    );
  }

  // Never non-zero on flags alone — flags are informational for the human.
  return 0;
}
