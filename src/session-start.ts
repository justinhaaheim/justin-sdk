/**
 * `justin-sdk session-start` — the ONE thing that runs at session start.
 *
 * Epic home-base-dchjw, decision D6: the `prime` Claude Code plugin is retired.
 * It was a second, independently-versioned copy of this logic installed from a
 * marketplace with no `autoUpdate`, and it sat 178 commits stale for a month
 * without anything detecting it — twice. Everything it did now lives here, in
 * the SDK itself, where the repo's own pin (or `justin-sdk-latest`) decides the
 * version and there is nothing separate left to go stale.
 *
 * TWO CALLERS, AND THEY NEVER BOTH ACT:
 *
 *  - PROJECT mode (default), from the hook base-setup writes into an enrolled
 *    repo's `.claude/settings.json`: `bun run justin-sdk session-start`. Remote
 *    (CLAUDE_CODE_REMOTE=true) hands straight off to `setup-env` — a cloud
 *    container needs hydrating, not advising. Locally it emits doctor's
 *    scaffolding verdict, the repo-state block and the rules-drift notice.
 *  - USER-LEVEL mode (`--user-level`), from the hook in ~/.claude/settings.json:
 *    `justin-sdk-latest session-start --user-level`. It exits 0 printing
 *    NOTHING when the project root is enrolled, because the project hook owns
 *    that repo and both firing would deliver everything twice.
 *
 * So the repo-state block still reaches EVERY repo, enrolled or not — Justin's
 * standing requirement, preserved rather than reversed — through one mechanism
 * instead of two.
 *
 * WHAT GOES WHERE ON STDOUT. The output is the SessionStart JSON envelope, and
 * its two halves have different audiences; conflating them is how a warning
 * stops being seen:
 *   - `additionalContext` is injected into the MODEL's context and is not shown
 *     to Justin. Doctor's output and the repo state go here, which is where
 *     each of them already went before this command existed.
 *   - `systemMessage` is shown to JUSTIN and the model never reads it. The
 *     rules freshness and drift verdicts go here, as they did in the plugin.
 *
 * That split is also why only ONE half is stripped of ANSI: see emitEnvelope.
 */

import {execFileSync} from 'child_process';
import {existsSync} from 'fs';
import {resolve} from 'path';

import {stripAnsi} from './check-runner';
import {renderDoctor} from './doctor';
import {assemble} from './prime';
import {formatRepoState, runDivergenceCheck} from './repo-status/prime-view';
import {
  checkRulesDrift,
  isRulesDriftProblem,
  rulesDriftAdvice,
  type RulesDriftStatus,
} from './rules/rules-drift';
import {
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  prettierMarkdown,
  PRIME_FULL_CMD,
  readDeployedStamp,
  rulesFilePath,
  SYNC_RULES_CMD,
} from './rules/rules-file';
import {runSetupEnv} from './setup-env-command';

const RULES_FILE_DISPLAY = '~/.claude/rules/justin-sdk/critical-rules.md';

export interface SessionStartOptions {
  /** Override the starting directory (tests). Default `process.cwd()`. */
  cwd?: string;
  /** User-level hook mode: stay completely silent in an enrolled repo. */
  userLevel?: boolean;
}

/**
 * Where "this project" starts, for the enrolment question and the git walk.
 *
 * BOUNDED ON PURPOSE (D6). `$CLAUDE_PROJECT_DIR` is what Claude Code says the
 * project is; failing that, the git toplevel of the cwd; failing that, the cwd
 * itself. What it deliberately is NOT is a walk up the parent chain looking for
 * a `justin-sdk.config.json`: that would let an ancestor silence an unrelated
 * session — one started in `~/Downloads`, or inside `pkg/justin-sdk` of an
 * enrolled repo — and silence is indistinguishable from the hook not running.
 */
export function sessionProjectRoot(cwd: string = process.cwd()): string {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (declared != null && declared.length > 0) return declared;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top.length > 0) return top;
  } catch {
    // Not a git repo, or no git. Neither is an error here: the cwd is still a
    // perfectly good answer, and it is the conservative one — it can only ever
    // make this command say LESS about enrolment, never wrongly claim it.
  }
  return cwd;
}

/**
 * Does the project hook own this repo?
 *
 * Deliberately the presence of `justin-sdk.config.json` and nothing cleverer.
 * The question is not "is this repo enrolled in critical-rules" (that is
 * `readEnrollment`, and it is a different question with a different answer) —
 * it is "did base-setup write a project SessionStart hook here", and the config
 * file is what base-setup keys on.
 */
export function projectHookOwnsRepo(projectRoot: string): boolean {
  return existsSync(resolve(projectRoot, 'justin-sdk.config.json'));
}

interface Injection {
  additionalContext: string;
  systemMessage: string;
}

/**
 * Does this repo already carry the rules, so injecting them would be a DUPLICATE?
 *
 * Ported unchanged from the plugin hook (home-base-anhw half B, D20). The three
 * `false` rows are exactly the states `checkRulesDrift` cannot reach without
 * having stat'd the artifact, so each `true` is a POSITIVE finding that the
 * repo has rules of its own. `cannot-check` keeps injecting because a failed
 * measurement is not a finding, and the two directions are not symmetric: a
 * wrong suppress silently costs a session its rules, a wrong inject costs a
 * duplicate.
 */
const REPO_CARRIES_RULES: Record<RulesDriftStatus, boolean> = {
  'cannot-check': false,
  'in-sync': true,
  'locally-modified': true,
  missing: false,
  'not-enrolled': false,
  stale: true,
};

const REPO_RULES_MARKER: Record<RulesDriftStatus, string> = {
  'cannot-check': '⚠️ staleness UNKNOWN',
  'in-sync': '✓ in sync',
  'locally-modified': '⚠️ LOCALLY MODIFIED',
  missing: '⚠️ MISSING',
  'not-enrolled': '', // never rendered
  stale: '⚠️ STALE',
};

function pointerLine(missing: boolean): string {
  return missing
    ? `⚠️ Justin's critical-rules file (${RULES_FILE_DISPLAY}) is MISSING, so the full rules are injected below — they may be truncated by the host. If so, run \`${PRIME_FULL_CMD}\` and read it. To fix permanently: \`${SYNC_RULES_CMD}\`. These rules are critical and override defaults.`
    : `📋 Justin's full critical rules auto-load from ${RULES_FILE_DISPLAY}. If they are not present in your context or look truncated, run \`${PRIME_FULL_CMD}\` and read the output before continuing. These rules are critical and override defaults.`;
}

/**
 * Assemble the rules pointer, the conditional rules, the repo state and the
 * freshness verdicts — the whole of what the plugin's SessionStart hook did.
 *
 * Every step is individually fail-soft, and each failure is REPORTED rather
 * than smoothed into a clean bill of health (rule 6): a rules load that throws
 * says so, a drift comparison that could not be made says `UNKNOWN`, and a git
 * walk that throws omits the repo-state block instead of printing an empty one.
 */
export function composeSessionStart(projectRoot: string): Injection {
  const RULES_FILE = rulesFilePath();
  const stamp = readDeployedStamp(RULES_FILE);
  const fileMissing = stamp == null;

  // --- rules (may throw if the prompts source can't be loaded) --------------
  let ruleText = '';
  let condNames: string[] = [];
  let cloneSha: string | null = null;
  let sourceDir: string | null = null;
  let rulesFailed: string | null = null;

  try {
    // Missing file -> inject the FULL rules as a fallback; otherwise just the
    // project-specific CONDITIONAL rules (the universal bulk is in the file).
    const assembled = assemble(
      {partition: fileMissing ? 'full' : 'conditional'},
      projectRoot,
    );
    condNames = assembled.names;
    cloneSha = assembled.sourceCommit?.sha ?? null;
    sourceDir = assembled.sourceDir;
    const body = fileMissing ? assembled.markdown : assembled.text;
    ruleText = [pointerLine(fileMissing), body]
      .filter((s) => s.length > 0)
      .join('\n\n');
  } catch (error) {
    rulesFailed = error instanceof Error ? error.message : String(error);
  }

  // --- committed per-repo artifact: is THIS repo's rules file current? ------
  // Reported, never fixed: nothing inside the repo is written here (D4/D9).
  const repoRules = checkRulesDrift(projectRoot);
  const suppressRuleText = REPO_CARRIES_RULES[repoRules.status];

  // --- repo state (branch/worktree divergence) -----------------------------
  let repoState = '';
  try {
    // PR state is a network call on the session-start hot path (~600ms against
    // ~150ms for the core walk) and pays a full timeout when `gh` cannot reach
    // GitHub. Opt in per-machine rather than making every session pay the tail.
    const wantPrs = process.env.JUSTIN_SDK_PRIME_PRS === '1';
    repoState = formatRepoState(
      runDivergenceCheck({cwd: projectRoot, prs: wantPrs}),
    );
  } catch {
    // Non-fatal: a git-inspection failure just omits the repo-state block.
  }

  // --- compose + Prettier the injection (for the model) --------------------
  // repoState is injected for EVERY repo, enrolled or not (Justin's explicit
  // requirement): the branch/worktree picture is per-session state no committed
  // file can carry, so it is never the duplicate half.
  let additionalContext = [suppressRuleText ? '' : ruleText, repoState]
    .filter((b) => b.length > 0)
    .join('\n\n');
  if (additionalContext.length > 0) {
    // Presentation only — this text is injected, never hashed or committed — so
    // a prettier failure legitimately degrades to the unformatted (still
    // complete) markdown. The drift hash below is a MEASUREMENT, handled
    // differently.
    const formatted = prettierMarkdown(additionalContext);
    if (formatted.status !== 'failed') additionalContext = formatted.markdown;
  }

  // --- drift check (fast path: sha; slow path: Prettier'd content hash) -----
  const deployedSha = deployedSourceSha(stamp);
  let drift = false;
  /** Set when the comparison could not be MADE. Not the same as "no drift". */
  let driftUnknown: string | null = null;
  if (!fileMissing && rulesFailed == null) {
    const shaMatch =
      deployedSha != null && deployedSha === cloneSha?.slice(0, 12);
    if (!shaMatch && sourceDir != null) {
      try {
        const universal = assemble(
          {partition: 'universal', promptsDir: sourceDir},
          projectRoot,
        );
        // The hash is only comparable if it was computed the way sync-rules
        // computes it — i.e. Prettier'd. Unformatted content hashes to
        // something no writer ever stamps, so it cannot answer the question at
        // all: that is a cannot-check, never a clean bill of health (rule 6).
        const formatted = prettierMarkdown(universal.markdown);
        if (formatted.status === 'failed') {
          driftUnknown = formatted.reason;
        } else {
          const currentHash = contentHash(formatted.markdown);
          drift =
            stamp?.contentHash != null && currentHash !== stamp.contentHash;
        }
      } catch (error) {
        // Couldn't recompute -> report unknown rather than a false all-clear.
        driftUnknown = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // --- systemMessage (for Justin; the model does NOT read it) --------------
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
  let systemMessage = `justin-sdk session-start · ${parts.join(' · ')}`;

  // The detail sits immediately under the header line — closest to the marker
  // it explains, and above the module list, because it is the only part of this
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
        : 'conditional modules (session-start injection)';
    systemMessage +=
      `\n${label}:\n` + condNames.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
  }

  return {additionalContext, systemMessage};
}

/**
 * Serialise the SessionStart hook envelope. Empty halves are omitted.
 *
 * ANSI IS STRIPPED FROM `additionalContext` (home-base-dchjw.9). Doctor's
 * report is coloured for a terminal, and nothing downstream of here is one: the
 * escapes go into the MODEL's context window, where they render as literal
 * `[32m` noise, cost tokens, and are a small but real prompt-injection surface.
 * Measured in home-base 2026-09-18: 2216 → 2014 bytes, 202 saved (9.1%), all of
 * it from doctor's half (1694 → 1492). `systemMessage` keeps its colours — that
 * half IS shown in a terminal, to Justin.
 */
function emitEnvelope(injection: Injection): void {
  const {additionalContext, systemMessage} = injection;
  if (additionalContext.length === 0 && systemMessage.length === 0) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: stripAnsi(additionalContext),
        hookEventName: 'SessionStart',
      },
      systemMessage,
    }),
  );
}

/**
 * The command. Always exits 0 in hook modes — a SessionStart hook that fails is
 * classified `hook_non_blocking_error`, the session starts anyway and NOTHING
 * is printed, which is the exact silent-omission failure that let plugin 0.5.0
 * ship broken for a week (home-base-qjyj).
 */
export async function runSessionStart(
  options: SessionStartOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  // REMOTE: a cloud container has no node_modules and no hydrated tree. It
  // needs `setup-env`, not advice, and setup-env keeps stdout empty by contract.
  // User-level mode never takes this branch: it is reached only through the
  // local ~/.claude/settings.json hook.
  if (options.userLevel !== true && process.env.CLAUDE_CODE_REMOTE === 'true') {
    return await runSetupEnv({});
  }

  const projectRoot = sessionProjectRoot(cwd);

  if (options.userLevel === true) {
    // The project hook owns enrolled repos. Silence here is the whole point:
    // both hooks firing would deliver the repo state twice.
    if (projectHookOwnsRepo(projectRoot)) return 0;
    emitEnvelope(composeSessionStart(projectRoot));
    return 0;
  }

  const injection = composeSessionStart(projectRoot);
  // RETURNED, not captured: doctor hands its report back as text, so stdout
  // stays the envelope's alone. `exitCode` is deliberately unused — this hook
  // always exits 0, and the verdict is in the report it just produced.
  const doctor = await renderDoctor(projectRoot, {quiet: true});
  emitEnvelope({
    additionalContext: [doctor.report.trimEnd(), injection.additionalContext]
      .filter((block) => block.length > 0)
      .join('\n\n'),
    systemMessage: injection.systemMessage,
  });
  return 0;
}
