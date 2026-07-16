#!/usr/bin/env bun
/**
 * SessionStart hook entry for the `prime` Claude Code plugin.
 *
 * The BULK of the rules (universal, always-on) is NOT injected here — it lives
 * in ~/.claude/rules/justin-sdk/critical-rules.md, a user-level Claude Code
 * rules file that autoloads every session with no size limit (home-base-r3pb).
 * This hook injects only the SMALL, per-session pieces that a static file
 * can't carry:
 *   1. a pointer line (where the full rules are; what to do if truncated),
 *   2. the CONDITIONAL (project-type-gated) rules for THIS project,
 *   3. the current repo state (branch/worktree divergence).
 * That payload stays well under the host's hook-output truncation limit.
 *
 * It also does a cheap DRIFT CHECK: compare the sha the deployed rules file was
 * generated from (its stamp) against the managed clone's HEAD (the remote
 * mirror the assembler already pulled). If they differ — or the file is missing
 * — it warns in the `systemMessage` (which the model does NOT read; it's for
 * Justin) with the exact fix command. When the file is missing entirely it
 * fails safe by injecting the FULL rules through the hook (possibly truncated,
 * but better than nothing).
 *
 * All lib modules live in this plugin's ./lib (a marketplace plugin only gets
 * its own subdir), import only node builtins, and this runs with just `bun`.
 * Always emits a valid envelope and exits 0 — never breaks a session.
 */

import {assemble} from '../lib/prime';
import {formatRepoState, runDivergenceCheck} from '../lib/project-prime';
import {
  deployedIsDirty,
  deployedSourceSha,
  PRIME_FULL_CMD,
  readDeployedStamp,
  rulesFilePath,
  SYNC_RULES_CMD,
} from '../lib/rules-file';

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const RULES_FILE = rulesFilePath();
const RULES_FILE_DISPLAY = '~/.claude/rules/justin-sdk/critical-rules.md';

const pointerLine = (missing: boolean): string =>
  missing
    ? `⚠️ Justin's critical-rules file (${RULES_FILE_DISPLAY}) is MISSING, so the full rules are injected below — they may be truncated by the host. If so, run \`${PRIME_FULL_CMD}\` and read it. To fix permanently: \`${SYNC_RULES_CMD}\`. These rules are critical and override defaults.`
    : `📋 Justin's full critical rules auto-load from ${RULES_FILE_DISPLAY}. If they are not present in your context or look truncated, run \`${PRIME_FULL_CMD}\` and read the output before continuing. These rules are critical and override defaults.`;

// --- rules (may throw if the prompts source can't be loaded) ----------------
let ruleText = ''; // the block injected through the hook
let condNames: string[] = [];
let cloneSha: string | null = null;
let rulesFailed: string | null = null;

const stamp = readDeployedStamp(RULES_FILE);
const fileMissing = stamp == null;

try {
  // Missing file -> inject the FULL rules as a fallback; otherwise just the
  // project-specific CONDITIONAL rules (the universal bulk is in the file).
  const assembled = assemble(
    {format: 'hook', partition: fileMissing ? 'full' : 'conditional'},
    projectRoot,
  );
  condNames = assembled.names;
  cloneSha = assembled.sourceSha;
  const body = fileMissing ? assembled.markdown : assembled.text;
  ruleText = [pointerLine(fileMissing), body]
    .filter((s) => s.length > 0)
    .join('\n\n');
} catch (error) {
  rulesFailed = error instanceof Error ? error.message : String(error);
}

// --- repo state (branch/worktree divergence) --------------------------------
let repoState = '';
try {
  repoState = formatRepoState(runDivergenceCheck({cwd: projectRoot}));
} catch {
  // Non-fatal: a git-inspection failure just omits the repo-state block.
}

// --- compose the injection (for the model) ----------------------------------
const additionalContext = [ruleText, repoState]
  .filter((b) => b.length > 0)
  .join('\n\n');

// --- drift check + systemMessage (for Justin; the model does NOT read it) ---
const deployedSha = deployedSourceSha(stamp);
const drift =
  !fileMissing && cloneSha != null && deployedSha != null
    ? deployedSha !== cloneSha.slice(0, 12)
    : false;

const parts: string[] = [];
if (rulesFailed != null) {
  parts.push(`⚠️ FAILED to load rules (${rulesFailed})`);
} else if (fileMissing) {
  parts.push(
    `⚠️ rules FILE MISSING — injected full via hook (may truncate) → run: ${SYNC_RULES_CMD}`,
  );
} else {
  const sync = drift
    ? `⚠️ STALE (file ${deployedSha} ≠ clone ${cloneSha?.slice(0, 12) ?? '?'}) → run: ${SYNC_RULES_CMD}`
    : deployedIsDirty(stamp)
      ? `⚠️ built from a dirty tree → run: ${SYNC_RULES_CMD}`
      : '✓ in sync';
  parts.push(`rules v${stamp?.version ?? '?'} ${sync}`);
}
// Only label the assembled modules "conditional" in the normal case; when the
// file is missing, `condNames` is the FULL set (already conveyed above).
if (!fileMissing && rulesFailed == null && condNames.length > 0) {
  parts.push(`+${condNames.length} conditional [${condNames.join(', ')}]`);
}
let systemMessage = `justin-sdk prime · ${parts.join(' · ')}`;
if (repoState.length > 0) systemMessage += `\n${repoState}`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      additionalContext,
      hookEventName: 'SessionStart',
    },
    systemMessage,
  }),
);
