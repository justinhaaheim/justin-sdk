#!/usr/bin/env bun
/**
 * SessionStart hook entry for the `prime` Claude Code plugin.
 *
 * The BULK of the rules (universal, always-on) is NOT injected here — it lives
 * in ~/.claude/rules/justin-sdk/critical-rules.md, a user-level Claude Code
 * rules file that autoloads every session with no size limit (home-base-r3pb).
 * This hook injects only the SMALL, per-session pieces a static file can't
 * carry: a pointer line, the CONDITIONAL (project-type-gated) rules for THIS
 * project, and the current repo state. Headings are numbered; the injection is
 * Prettier'd (both on by default).
 *
 * DRIFT CHECK (result goes in the systemMessage, which the model does NOT read
 * — it's for Justin): fast path compares the deployed file's stamped source sha
 * against the managed clone's HEAD; equal ⇒ in sync with no further work. Only
 * when they differ does it do the expensive check — assemble the current
 * universal rules, Prettier + hash them, and compare to the deployed content
 * hash — so a commit that doesn't change rule content (or only reformats it)
 * never false-nags. Missing file ⇒ fail-safe: inject the FULL rules here.
 *
 * A SECOND drift check (home-base-si46) covers the COMMITTED per-repo artifact
 * `.claude/rules/justin-sdk/critical-rules.md` for repos enrolled in
 * critical-rules — a different file, a different channel, its own verdict, and
 * the same one the `critical-rules-setup` doctor check reports (see
 * ../../rules-drift). It only ever REPORTS: nothing inside the repo is written
 * here (t6a0.21 D4/D9).
 *
 * THAT SAME VERDICT ALSO GATES THE INJECTION (home-base-anhw, half B). A repo
 * whose committed artifact is present already carries these rules, so injecting
 * them here would deliver the content twice; in that case only the REPO STATE is
 * injected. Justin's explicit requirement is that the repo state keeps printing
 * for every repo, enrolled or not — and the shrink buys back headroom against
 * the ~10,000-char cliff for the repos still relying on the hook. The
 * user-level file's half of the same duplication is handled by a
 * `claudeMdExcludes` entry enrollment writes (half A, critical-rules-setup.ts).
 *
 * All lib modules live in this plugin's ./lib (a marketplace plugin only gets
 * its own subdir), use only bun builtins / bunx subprocesses (no node_modules),
 * and this runs with just `bun`. Always emits a valid envelope and exits 0.
 */

import {assemble} from '../lib/prime';
import {
  formatRepoState,
  runDivergenceCheck,
} from '../../repo-status/prime-view';
import {
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  PRIME_FULL_CMD,
  prettierMarkdown,
  readDeployedStamp,
  rulesFilePath,
  SYNC_RULES_CMD,
} from '../lib/rules-file';
import {
  checkRulesDrift,
  isRulesDriftProblem,
  rulesDriftAdvice,
  type RulesDriftStatus,
} from '../../rules-drift';

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const RULES_FILE = rulesFilePath();
const RULES_FILE_DISPLAY = '~/.claude/rules/justin-sdk/critical-rules.md';

const pointerLine = (missing: boolean): string =>
  missing
    ? `⚠️ Justin's critical-rules file (${RULES_FILE_DISPLAY}) is MISSING, so the full rules are injected below — they may be truncated by the host. If so, run \`${PRIME_FULL_CMD}\` and read it. To fix permanently: \`${SYNC_RULES_CMD}\`. These rules are critical and override defaults.`
    : `📋 Justin's full critical rules auto-load from ${RULES_FILE_DISPLAY}. If they are not present in your context or look truncated, run \`${PRIME_FULL_CMD}\` and read the output before continuing. These rules are critical and override defaults.`;

const stamp = readDeployedStamp(RULES_FILE);
const fileMissing = stamp == null;

// --- rules (may throw if the prompts source can't be loaded) ----------------
let ruleText = '';
let condNames: string[] = [];
let cloneSha: string | null = null;
let sourceDir: string | null = null;
let rulesFailed: string | null = null;

try {
  // Missing file -> inject the FULL rules as a fallback; otherwise just the
  // project-specific CONDITIONAL rules (the universal bulk is in the file).
  const assembled = assemble(
    {format: 'hook', partition: fileMissing ? 'full' : 'conditional'},
    projectRoot,
  );
  condNames = assembled.names;
  cloneSha = assembled.sourceSha;
  sourceDir = assembled.sourceDir;
  const body = fileMissing ? assembled.markdown : assembled.text;
  ruleText = [pointerLine(fileMissing), body]
    .filter((s) => s.length > 0)
    .join('\n\n');
} catch (error) {
  rulesFailed = error instanceof Error ? error.message : String(error);
}

// --- committed per-repo artifact: is THIS repo's rules file current? ---------
// A second, independent delivery channel (t6a0.21 D1): enrolled repos carry
// `.claude/rules/justin-sdk/critical-rules.md` in git. Its staleness verdict is
// computed by the shared checker the doctor check also calls, so the session and
// doctor can never disagree — and it is REPORTED here, never fixed: this hook
// writes nothing inside the repo (D4/D9). A repo that is not enrolled adds
// nothing to the output at all.
//
// It runs HERE, before the injection is composed, because the answer also
// decides whether ruleText is injected at all (see below). The call was already
// unconditional, so moving it up costs nothing.
const repoRules = checkRulesDrift(projectRoot);

/**
 * Does this repo already carry the rules, so injecting them would be a DUPLICATE?
 *
 * Half B of the deduplication (home-base-anhw). Half A is the `claudeMdExcludes`
 * entry enrollment writes, which drops the user-level file; this half drops the
 * hook's own copy of the conditional rules, which the repo's committed artifact
 * already contains (its module selection is universal AND conditional, D12).
 *
 * D20 — SUPPRESS ONLY ON PROOF THE ARTIFACT IS THERE. The three states below are
 * exactly the ones `checkRulesDrift` cannot reach without having stat'd the file
 * (its step 2 returns `missing` first), so each of them is a POSITIVE finding
 * that the repo has rules of its own. Everything else keeps injecting:
 *
 *   not-enrolled     no artifact by definition — the hook is the only channel.
 *   missing          enrolled, but the file is not there. The notice nags about
 *                    it separately; meanwhile the session must not be left with
 *                    no rules at all.
 *   cannot-check     we could not MEASURE. A failed measurement is not a finding
 *                    (rule 5), and the two directions are not symmetric: a wrong
 *                    suppress silently costs a session its rules, a wrong inject
 *                    costs a duplicate — which is merely the pre-anhw status quo.
 *
 * `stale` and `locally-modified` DO suppress: the file exists and Claude Code
 * loads it regardless of how current it is, so injecting on top would duplicate
 * rather than repair. The systemMessage still says so, loudly.
 */
const REPO_CARRIES_RULES: Record<RulesDriftStatus, boolean> = {
  'cannot-check': false,
  'in-sync': true,
  'locally-modified': true,
  missing: false,
  'not-enrolled': false,
  stale: true,
};
const suppressRuleText = REPO_CARRIES_RULES[repoRules.status];

// --- repo state (branch/worktree divergence) --------------------------------
let repoState = '';
try {
  // PR state is genuinely useful repo context, but it is a network call on the
  // session-start hot path: measured at ~600ms typical against ~150ms for the
  // core walk, and it pays a full timeout when gh cannot reach GitHub (sandbox
  // TLS, offline, unauthenticated). Opt in per-machine with
  // JUSTIN_SDK_PRIME_PRS=1 rather than making every session pay that tail.
  const wantPrs = process.env.JUSTIN_SDK_PRIME_PRS === '1';
  repoState = formatRepoState(
    runDivergenceCheck({cwd: projectRoot, prs: wantPrs}),
  );
} catch {
  // Non-fatal: a git-inspection failure just omits the repo-state block.
}

// --- compose + Prettier the injection (for the model) -----------------------
// repoState is injected for EVERY repo, enrolled or not (Justin's explicit
// requirement): the branch/worktree picture is per-session state no committed
// file can carry, so it is never the duplicate half.
let additionalContext = [suppressRuleText ? '' : ruleText, repoState]
  .filter((b) => b.length > 0)
  .join('\n\n');
if (additionalContext.length > 0) {
  // Presentation only — this text is injected, never hashed or committed — so a
  // prettier failure legitimately degrades to the unformatted (still complete)
  // markdown. The drift hash below is a MEASUREMENT and is handled differently.
  const formatted = prettierMarkdown(additionalContext);
  if (formatted.status !== 'failed') additionalContext = formatted.markdown;
}

// --- drift check (fast path: sha; slow path: Prettier'd content hash) --------
const deployedSha = deployedSourceSha(stamp);
let drift = false;
/** Set when the comparison could not be MADE. Not the same as "no drift". */
let driftUnknown: string | null = null;
if (!fileMissing && rulesFailed == null) {
  const shaMatch =
    deployedSha != null &&
    cloneSha != null &&
    deployedSha === cloneSha.slice(0, 12);
  if (!shaMatch && sourceDir != null) {
    try {
      const universal = assemble(
        {format: 'markdown', partition: 'universal', promptsDir: sourceDir},
        projectRoot,
      );
      // The hash is only comparable if it was computed the way sync-rules
      // computes it — i.e. Prettier'd. Unformatted content would hash to
      // something no writer ever stamps, so it cannot answer the question at
      // all: that is a cannot-check, never a clean bill of health (rule 5).
      const formatted = prettierMarkdown(universal.markdown);
      if (formatted.status === 'failed') {
        driftUnknown = formatted.reason;
      } else {
        const currentHash = contentHash(formatted.markdown);
        drift = stamp?.contentHash != null && currentHash !== stamp.contentHash;
      }
    } catch (error) {
      // Couldn't recompute -> report unknown rather than a false all-clear.
      driftUnknown = error instanceof Error ? error.message : String(error);
    }
  }
}

const REPO_RULES_MARKER: Record<RulesDriftStatus, string> = {
  'cannot-check': '⚠️ staleness UNKNOWN',
  'in-sync': '✓ in sync',
  'locally-modified': '⚠️ LOCALLY MODIFIED',
  missing: '⚠️ MISSING',
  'not-enrolled': '', // never rendered
  stale: '⚠️ STALE',
};

// --- systemMessage (for Justin; the model does NOT read it) -----------------
const parts: string[] = [];
if (rulesFailed != null) {
  parts.push(`⚠️ FAILED to load rules (${rulesFailed})`);
} else if (fileMissing) {
  parts.push(
    `⚠️ rules FILE MISSING — injected full via hook (may truncate) → run: ${SYNC_RULES_CMD}`,
  );
} else {
  const sync = drift
    ? `⚠️ STALE → run: ${SYNC_RULES_CMD}`
    : driftUnknown != null
      ? `⚠️ freshness UNKNOWN (${driftUnknown})`
      : deployedIsDirty(stamp)
        ? `⚠️ built from a dirty tree → run: ${SYNC_RULES_CMD}`
        : '✓ in sync';
  parts.push(`rules v${stamp?.version ?? '?'} ${sync}`);
}
if (repoRules.status !== 'not-enrolled') {
  parts.push(`repo rules ${REPO_RULES_MARKER[repoRules.status]}`);
}
// Say it out loud. "The rules stopped appearing in my injection" must be
// answerable from this line alone, or the next person to look debugs a feature.
if (suppressRuleText) {
  parts.push('rule text NOT injected (this repo carries its own)');
}
let systemMessage = `justin-sdk prime · ${parts.join(' · ')}`;

// The detail sits immediately under the header line — closest to the marker it
// explains, and above the module list, because it is the only part of this
// message that ever asks Justin to DO something.
if (isRulesDriftProblem(repoRules.status)) {
  systemMessage += `\n⚠️ repo rules: ${repoRules.message}\n   → ${rulesDriftAdvice(repoRules.status)}`;
}

// Numbered summary of the modules the injection WOULD carry. The label has to
// track suppression: naming these "injected" while they were dropped is the
// systemMessage telling Justin something that is not true.
if (condNames.length > 0) {
  const label = suppressRuleText
    ? 'conditional modules (NOT injected — already in this repo’s artifact)'
    : fileMissing
      ? 'modules injected (full)'
      : 'conditional modules (prime injection)';
  systemMessage +=
    `\n${label}:\n` + condNames.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
}
// The ENTIRE prime output the model receives, so Justin can see it too.
if (additionalContext.length > 0) {
  systemMessage += `\n\n─── full prime injection (what the model receives) ───\n${additionalContext}`;
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      additionalContext,
      hookEventName: 'SessionStart',
    },
    systemMessage,
  }),
);
