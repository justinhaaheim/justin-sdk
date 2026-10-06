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
 *    container needs hydrating, not advising. Locally it reports doctor's
 *    scaffolding verdict, the rules-drift notice and the conditional rule
 *    modules, and arms the first-prompt repo-state hook.
 *  - USER-LEVEL mode (`--user-level`), from the hook in ~/.claude/settings.json:
 *    `justin-sdk-latest session-start --user-level`. It exits 0 printing
 *    NOTHING when the project root is enrolled, because the project hook owns
 *    that repo and both firing would deliver everything twice.
 *
 * So the repo-state block still reaches EVERY repo, enrolled or not — Justin's
 * standing requirement, preserved rather than reversed — through one mechanism
 * instead of two.
 *
 * THE REPO STATE ARRIVES ON THE FIRST PROMPT, NOT HERE (home-base-39co9.4, M1).
 * This command ARMS a per-session marker (src/first-prompt.ts) before it does
 * anything slow, and `repo-state --hook` — a UserPromptSubmit hook installed
 * beside this one — injects the block on the session's first prompt, measured
 * then. Only when the marker cannot be written does this command inject the
 * block itself, and it says so in the header.
 *
 * WHAT GOES WHERE (M2, M3). `systemMessage` is for JUSTIN: the one-line
 * status header, the repo-rules drift advice, the conditional rule modules that
 * apply to this repo (or "none"), and doctor's report. `additionalContext` is
 * for CLAUDE and now carries only rule text, and only in a repo that does not
 * carry its own rules artifact. Everything Claude gets is mirrored into
 * `systemMessage` by `src/hook-output.ts`, the one place hook JSON is built.
 */

import {execFileSync} from 'child_process';
import {existsSync} from 'fs';
import {resolve} from 'path';

import {renderDoctor} from './doctor';
import {
  armFirstPrompt,
  type ArmResult,
  claimFirstPrompt,
  composeRepoState,
  type HookPayload,
  readHookPayload,
  repoStateHookPresence,
  safeSessionId,
} from './first-prompt';
import {emitHookOutput} from './hook-output';
import {assemble} from './prime';
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
import {SDK_LATEST, sdkRun} from './sdk-invocation';
import {runSetupEnv} from './setup-env-command';

const RULES_FILE_DISPLAY = '~/.claude/rules/justin-sdk/critical-rules.md';

export interface SessionStartOptions {
  /** Override the starting directory (tests). Default `process.cwd()`. */
  cwd?: string;
  /**
   * The hook payload. Default: read from stdin (never from a TTY). `null`
   * means "there is none", which is what a hand-typed run has.
   */
  payload?: HookPayload | null;
  /** User-level hook mode: stay completely silent in an enrolled repo. */
  userLevel?: boolean;
}

/**
 * How to invoke the SDK in text this command prints for a reader: the repo's
 * own pin under the project hook, `justin-sdk-latest` under the user-level one
 * (an unenrolled repo has no `bun run justin-sdk` to resolve).
 */
function sdkCommand(args: string, userLevel: boolean): string {
  return userLevel ? `${SDK_LATEST} ${args}` : sdkRun(args);
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

/** What one SessionStart run says, before doctor's report is added. */
export interface SessionStartMessage {
  /** Text injected into Claude's context. '' when there is none. */
  forClaude: string;
  /** For Justin only: the status header, drift advice and rule modules. */
  forJustin: string;
  /** Prints the full Claude-bound text, for a mirror that had to be cut. */
  fullTextCommand: string | null;
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
 * The conditional rule modules that apply to this repo, as Justin reads them
 * (M2). Always says something — "none" is a finding, "UNKNOWN" is a failure,
 * and the two must never look alike (critical rule 7).
 */
function conditionalModulesSection(args: {
  names: string[] | null;
  rulesFailed: string | null;
  suppressed: boolean;
}): string {
  const {names, rulesFailed, suppressed} = args;
  if (names == null) {
    return `conditional rule modules: UNKNOWN (${rulesFailed ?? 'the rules could not be assembled'})`;
  }
  if (names.length === 0) {
    return 'conditional rule modules that apply here: none';
  }
  // The label has to track suppression: naming these "injected" while they
  // were dropped is the systemMessage telling Justin something untrue.
  const label = suppressed
    ? 'already in this repo’s rules artifact, not injected'
    : 'injected into this session';
  return (
    `conditional rule modules that apply here (${label}):\n` +
    names.map((n, i) => `  ${i + 1}. ${n}`).join('\n')
  );
}

/**
 * Assemble the rules pointer, the conditional rules and the freshness verdicts
 * — what the plugin's SessionStart hook did, minus the repo state, which now
 * waits for the first prompt (M1) unless `firstPrompt` says it could not.
 *
 * Every step is individually fail-soft, and each failure is REPORTED rather
 * than smoothed into a clean bill of health (rule 7): a rules load that throws
 * says so, a drift comparison that could not be made says `UNKNOWN`, and the
 * module list says UNKNOWN rather than "none" when it was never computed.
 */
export function composeSessionStart(
  projectRoot: string,
  options: {firstPrompt: ArmResult; userLevel: boolean},
): SessionStartMessage {
  const {firstPrompt, userLevel} = options;
  const RULES_FILE = rulesFilePath();
  const stamp = readDeployedStamp(RULES_FILE);
  const fileMissing = stamp == null;

  // --- rules (may throw if the prompts source can't be loaded) --------------
  let ruleText = '';
  let condNames: string[] | null = null;
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
    cloneSha = assembled.sourceCommit?.sha ?? null;
    sourceDir = assembled.sourceDir;
    // The FULL partition's names are every module, universal ones included,
    // so the conditional subset is asked for separately — from the same clone,
    // so nothing is fetched twice.
    condNames = fileMissing
      ? assemble(
          {partition: 'conditional', promptsDir: assembled.sourceDir},
          projectRoot,
        ).names
      : assembled.names;
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

  // --- repo state: only when the first-prompt hook could not be armed -------
  const repoState = firstPrompt.ok ? '' : composeRepoState(projectRoot);

  // --- compose + Prettier the injection (for the model) --------------------
  let forClaude = suppressRuleText ? '' : ruleText;
  if (forClaude.length > 0) {
    // Presentation only — this text is injected, never hashed or committed — so
    // a prettier failure legitimately degrades to the unformatted (still
    // complete) markdown. The drift hash below is a MEASUREMENT, handled
    // differently.
    const formatted = prettierMarkdown(forClaude);
    if (formatted.status !== 'failed') forClaude = formatted.markdown;
  }
  forClaude = [forClaude, repoState].filter((b) => b.length > 0).join('\n\n');

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

  // --- for Justin (Claude reads none of this) -------------------------------
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
  // Same for the repo state: where it went, or why it did not go there.
  parts.push(
    firstPrompt.ok
      ? 'repo state → your first prompt'
      : `⚠️ repo state injected NOW, not on the first prompt (${firstPrompt.error})`,
  );
  let forJustin = `justin-sdk session-start · ${parts.join(' · ')}`;

  // The detail sits immediately under the header line — closest to the marker
  // it explains, and above the module list, because it is the only part of this
  // message that ever asks Justin to DO something.
  if (isRulesDriftProblem(repoRules.status)) {
    forJustin += `\n⚠️ repo rules: ${repoRules.message}\n   → ${rulesDriftAdvice(repoRules.status)}`;
  }

  forJustin += `\n${conditionalModulesSection({
    names: condNames,
    rulesFailed,
    suppressed: suppressRuleText,
  })}`;

  return {
    forClaude,
    forJustin,
    fullTextCommand:
      forClaude === ''
        ? null
        : sdkCommand(
            fileMissing ? 'prime --full' : 'prime --partition conditional',
            userLevel,
          ),
  };
}

/**
 * Arm the first-prompt hook for this session, or say why it could not be —
 * including when no `repo-state --hook` is installed to fire, which would
 * otherwise turn "repo state → your first prompt" into a promise nothing keeps.
 */
function armForSession(
  projectRoot: string,
  payload: HookPayload | null,
  userLevel: boolean,
): ArmResult {
  const presence = repoStateHookPresence(projectRoot, userLevel);
  if (presence.kind !== 'installed') {
    const fix = userLevel
      ? 'add the user-level UserPromptSubmit hook to ~/.claude/settings.json (doctor prints the JSON in any enrolled repo)'
      : `run \`${sdkRun('install')}\``;
    return {
      error:
        presence.kind === 'absent'
          ? `no \`repo-state --hook\` UserPromptSubmit hook is installed — ${fix}`
          : `whether a \`repo-state --hook\` UserPromptSubmit hook is installed is UNKNOWN: ${presence.why}`,
      ok: false,
    };
  }
  const sessionId = safeSessionId(payload);
  if (sessionId == null) {
    return {
      error: 'the hook payload carried no usable session_id',
      ok: false,
    };
  }
  return armFirstPrompt(sessionId, payload?.source ?? null);
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
  const userLevel = options.userLevel === true;

  // REMOTE: a cloud container has no node_modules and no hydrated tree. It
  // needs `setup-env`, not advice, and setup-env keeps stdout empty by contract.
  // User-level mode never takes this branch: it is reached only through the
  // local ~/.claude/settings.json hook.
  if (!userLevel && process.env.CLAUDE_CODE_REMOTE === 'true') {
    return await runSetupEnv({});
  }

  const projectRoot = sessionProjectRoot(cwd);

  // The project hook owns enrolled repos. Silence here is the whole point:
  // both hooks firing would deliver everything twice.
  if (userLevel && projectHookOwnsRepo(projectRoot)) return 0;

  // ARM FIRST, before the rules and doctor (which take a second or more): the
  // reference says SessionStart hooks "run in the background. You can type
  // right away", so a prompt can race this hook. Arming early narrows that
  // window; first-prompt.ts covers the rest by firing on a missing marker.
  const payload =
    options.payload !== undefined ? options.payload : readHookPayload();
  const firstPrompt = armForSession(projectRoot, payload, userLevel);

  const message = composeSessionStart(projectRoot, {firstPrompt, userLevel});

  let forJustin = message.forJustin;
  if (!userLevel) {
    // RETURNED, not captured: doctor hands its report back as text, so stdout
    // stays the envelope's alone. `exitCode` is deliberately unused — this hook
    // always exits 0, and the verdict is in the report it just produced. It is
    // Justin's to act on (M2), so it goes to him and not into Claude's context.
    const doctor = await renderDoctor(projectRoot, {quiet: true});
    forJustin = [forJustin, doctor.report.trim()]
      .filter((block) => block.length > 0)
      .join('\n\n');
  }

  emitHookOutput({
    event: 'SessionStart',
    forClaude: message.forClaude,
    forJustin,
    fullTextCommand: message.fullTextCommand,
  });
  return 0;
}

export interface RepoStateOptions {
  cwd?: string;
  /** Run as the UserPromptSubmit hook: read the payload, fire at most once. */
  hook?: boolean;
  /** The hook payload (tests). Default: read from stdin, never from a TTY. */
  payload?: HookPayload | null;
  /** User-level hook mode: silent in an enrolled repo, like session-start. */
  userLevel?: boolean;
}

/**
 * `justin-sdk repo-state` — print the repo-state block; with `--hook`, the
 * UserPromptSubmit hook that injects it on a session's first prompt (M1).
 *
 * Always exits 0 as a hook: a UserPromptSubmit hook that exits 2 BLOCKS the
 * prompt, and nothing here is worth costing Justin a turn.
 */
export function runRepoState(options: RepoStateOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const userLevel = options.userLevel === true;

  if (options.hook !== true) {
    const block = composeRepoState(sessionProjectRoot(cwd));
    if (block === '') {
      console.error(
        'repo-state: nothing to report here (not a git repository, or a detached HEAD)',
      );
      return 0;
    }
    console.log(block);
    return 0;
  }

  // Remote sessions never had a repo-state block (session-start hands remote
  // straight to setup-env), and this hook does not start giving them one.
  if (!userLevel && process.env.CLAUDE_CODE_REMOTE === 'true') return 0;

  const projectRoot = sessionProjectRoot(cwd);
  if (userLevel && projectHookOwnsRepo(projectRoot)) return 0;

  const payload =
    options.payload !== undefined ? options.payload : readHookPayload();
  const sessionId = safeSessionId(payload);
  if (sessionId == null) {
    // stderr, not the envelope: without a session id there is no "first"
    // prompt to speak of, and printing on every prompt would be worse.
    console.error(
      'repo-state --hook: the hook payload carried no usable session_id, so nothing was injected',
    );
    return 0;
  }

  const claim = claimFirstPrompt(sessionId);
  if (!claim.fire) {
    if (claim.why === 'cannot-record') {
      console.error(`repo-state --hook: nothing injected — ${claim.error}`);
    }
    return 0;
  }

  emitHookOutput({
    event: 'UserPromptSubmit',
    forClaude: composeRepoState(projectRoot),
    forJustin:
      claim.recordError == null
        ? ''
        : `⚠️ repo-state: ${claim.recordError} — the next prompt may get this block again`,
    fullTextCommand: sdkCommand('repo-state', userLevel),
  });
  return 0;
}
