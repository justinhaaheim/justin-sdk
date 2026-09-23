/**
 * migrate-to-prime.ts — one-time (idempotent) migration of a project from the
 * old committed-guidance world (docs/prompts/ + AGENTS.md + CLAUDE.md @-refs)
 * to the new `justin-sdk prime` world (guidance injected at session start from
 * the central prompts repo).
 *
 * End state per project: just its own CLAUDE.md. No docs/prompts/, no AGENTS.md,
 * and no @-references to either.
 *
 * It used to ALSO strip the per-project `bun run justin-sdk prime` SessionStart
 * hook, on the grounds that the `prime` Claude Code plugin injected the same
 * guidance globally (home-base-t6a0.16). That step is GONE as of dchjw.8: D6
 * retired the plugin, so a per-project SessionStart hook is now the mechanism
 * rather than a duplicate of one, and a migration that removed hooks from
 * `.claude/settings.json` would be tearing out what base-setup just installed.
 *
 * Design (home-base-t6a0.12, fable-advisor-reviewed; docs/prompts widened by
 * Justin 2026-09-18, epic home-base-dchjw D3):
 *  - SAFE DELETES ONLY. A file is deleted only if it is git-tracked AND clean,
 *    so the deletion is fully recoverable from git history. Anything untracked
 *    or dirty is FLAGGED for manual review, never deleted — the premise of the
 *    whole cleanup is "these will still be in git history if we want them
 *    back", and for those two cases that premise is false.
 *  - docs/prompts/ goes ENTIRELY, not just the names the old installer wrote.
 *    A file this SDK does not recognise is still deleted, but it is NAMED as it
 *    goes so the session report can relay it.
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

import {spawnSync} from 'child_process';
import {existsSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {basename, join, resolve} from 'path';

import {unknownComponentNames} from './component-registry';
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

const AGENTS_MARKER = '<!-- br-agent-instructions-v1 -->';

/**
 * The exact wording of the line that names a file this SDK did not recognise as
 * it deletes it. Exported because a test asserts it and the session report
 * relays it — one spelling, in one place.
 */
export const BESPOKE_DELETED_PREFIX =
  'bespoke file deleted (recoverable from git history): ';

/**
 * Known auto-generated filenames under docs/prompts/ (installed by the old
 * `install-my-prompts` script).
 *
 * This list no longer decides WHAT is deleted — the whole directory goes — only
 * what is deleted QUIETLY. A name not in here is deleted too, and named on the
 * way out (see BESPOKE_DELETED_PREFIX).
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

/**
 * Components describing artifacts that no longer exist post-migration.
 *
 * Kept as a NAMED list even though `prompts-setup` and `claude-md-setup` were
 * deleted from the registry in dchjw.5: this file is the cleanup for repos that
 * still carry their output, so it is the one place in the SDK those two names
 * legitimately still appear. Any OTHER unknown name is dropped too — by asking
 * the registry rather than by guessing — so a config written by a newer SDK, or
 * by hand, does not quietly keep a component nothing can run.
 */
const OBSOLETE_COMPONENTS = ['prompts-setup', 'claude-md-setup'];

/** `git <args>` with no shell in between. */
function gitArgv(
  cwd: string,
  args: readonly string[],
): {exitCode: number; stdout: string} {
  const child = spawnSync('git', [...args], {cwd, encoding: 'utf-8'});
  // A spawn that never ran is not an exit code of 0 (critical rule 6): report
  // it as a failure so both callers take their cautious branch.
  if (child.error != null) return {exitCode: 1, stdout: ''};
  return {exitCode: child.status ?? 1, stdout: child.stdout ?? ''};
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * Both of these decide whether a file may be DELETED, and both used to build a
 * shell string around a filename in single quotes (dchjw.17 F8). A path
 * containing a quote would either break the command — a non-zero exit, which
 * `isTracked` reads as "untracked", the safe direction — or, in `isClean`,
 * change which paths git reported and let a dirty file read as clean, which is
 * the unsafe one. argv never interpolates, so neither can happen.
 */
function isTracked(projectRoot: string, relPath: string): boolean {
  return (
    gitArgv(projectRoot, ['ls-files', '--error-unmatch', '--', relPath])
      .exitCode === 0
  );
}

/** True if `relPath` has no uncommitted changes in the working tree/index. */
function isClean(projectRoot: string, relPath: string): boolean {
  const {stdout, exitCode} = gitArgv(projectRoot, [
    'status',
    '--porcelain',
    '--',
    relPath,
  ]);
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
// Step: remove docs/prompts/ (safe files only) + install-my-prompts script
// ---------------------------------------------------------------------------

function stepDocsPrompts(projectRoot: string, report: Report): void {
  const dir = resolve(projectRoot, 'docs/prompts');
  if (existsSync(dir)) {
    const entries = readdirSync(dir, {withFileTypes: true});
    let remaining = 0;
    for (const entry of entries) {
      const rel = `docs/prompts/${entry.name}`;
      if (entry.isFile() && safeToDelete(projectRoot, rel)) {
        rmSync(join(dir, entry.name));
        // The whole directory goes now, not just the names the old installer
        // wrote (Justin, 2026-09-18) — but a file this SDK does not recognise
        // gets NAMED as it goes, so the session report can relay what was in
        // there and he can pull it back out of git if it mattered.
        report.did.push(
          KNOWN_PROMPT_FILES.has(entry.name)
            ? `Removed ${rel}`
            : `${BESPOKE_DELETED_PREFIX}${rel}`,
        );
      } else {
        remaining++;
        // NOT "delete it anyway". The line above CLAIMS the deletion is
        // recoverable from git history, and for an untracked or dirty file that
        // claim is simply false — the bytes would be gone. Justin's instruction
        // to delete the directory rests on "these will still be in git history
        // if we want them back", so where that premise fails, so does the
        // deletion (PRIME DIRECTIVE).
        const reason = !entry.isFile()
          ? 'not a regular file'
          : !isTracked(projectRoot, rel)
            ? 'untracked — deleting it would NOT be recoverable from git'
            : 'has uncommitted changes — deleting it would lose them';
        report.flagged.push(
          `${rel} — NOT deleted (${reason}); review manually`,
        );
      }
    }
    // Remove docs/prompts (and an empty docs/) only if fully cleared.
    if (remaining === 0) {
      rmSync(dir, {force: true, recursive: true});
      report.did.push('Removed docs/prompts/');
      const docsDir = resolve(projectRoot, 'docs');
      if (existsSync(docsDir) && readdirSync(docsDir).length === 0) {
        rmSync(docsDir, {force: true, recursive: true});
      }
    }
  }

  // The dotfile recording which prompts commit was installed. Useless once
  // docs/prompts is gone, and its presence is one of doctor's legacy triggers.
  const markerRel = 'docs/.prompts-installed-from.json';
  const markerPath = resolve(projectRoot, markerRel);
  if (existsSync(markerPath)) {
    if (safeToDelete(projectRoot, markerRel)) {
      rmSync(markerPath);
      report.did.push(`Removed ${markerRel}`);
      const docsDir = resolve(projectRoot, 'docs');
      if (existsSync(docsDir) && readdirSync(docsDir).length === 0) {
        rmSync(docsDir, {force: true, recursive: true});
      }
    } else {
      report.flagged.push(
        `${markerRel} — NOT deleted (${isTracked(projectRoot, markerRel) ? 'has uncommitted changes' : 'untracked — deleting it would NOT be recoverable from git'}); review manually`,
      );
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
        // writeJson, not a raw stringify: every JSON the SDK writes goes
        // through the target repo's own prettier, or a migrated repo's very
        // next commit hook reformats package.json and the migration's diff is
        // suddenly two changes (dchjw.17 F8).
        writeJson(pkgPath, pkg);
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

  const raw = config.components;
  if (raw == null) return; // No key: this repo already tracks the core preset.
  if (!Array.isArray(raw)) {
    report.flagged.push(
      'justin-sdk.config.json "components" is not an array — NOT modified; fix it by hand',
    );
    return;
  }

  const components = raw.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const retired = new Set([
    ...OBSOLETE_COMPONENTS,
    ...unknownComponentNames(components),
  ]);
  const filtered = components.filter((c) => !retired.has(c));
  if (
    filtered.length === components.length &&
    components.length === raw.length
  ) {
    return;
  }

  config.components = filtered;
  writeJson(configPath, config);
  const removed = components.filter((c) => retired.has(c));
  report.did.push(
    `Removed component(s) this SDK no longer has from justin-sdk.config.json: ${removed.join(', ')}`,
  );
  if (filtered.length === 0) {
    // An empty list is honoured as written — "this repo has no components" —
    // which is a different statement from the absent key ("give me core"). Say
    // so rather than picking one for him.
    report.flagged.push(
      'justin-sdk.config.json "components" is now an EMPTY list, which means this repo installs nothing. Delete the key entirely to track the `core` preset instead.',
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
  /** Commit the migration at the end. Default false (inspect the diff first). */
  commit?: boolean;
  projectRoot?: string;
  quiet?: boolean;
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
