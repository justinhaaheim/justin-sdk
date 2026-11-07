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
import {CLAUDE_CODE_HOOK_TEXT_CAP, emitHookOutput} from './hook-output';
import {assemble, type Assembled, type AssembledModule} from './prime';
import {
  artifactMatchesItsStamp,
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
  primeModulesCmd,
  projectRulesFilePath,
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
 * Does this repo already carry the rules, so the hook must not inject them?
 *
 * From the plugin hook (home-base-anhw half B, D20). The three `true` rows are
 * states `checkRulesDrift` reaches only after it has read the artifact, so each
 * is a POSITIVE finding that the repo has rules of its own, which Claude Code
 * loads in full from `.claude/rules/`.
 *
 * `cannot-check` used to be `false`, on the reasoning that a wrong suppress
 * costs a session its rules while a wrong inject only costs a duplicate. That
 * reasoning is false (home-base-t6a0.17 D1). In a React Native repo the inject
 * is the React, React Native and detailed React Native modules, 11,783
 * characters (measured 2026-11-06): over Claude Code's 10,000-character hook
 * cap, so Claude gets a file path and a 2,000-character preview, not a
 * duplicate. And a file Claude Code loads anyway cannot cost the session its
 * rules. So when the staleness check fails, one local question decides: is the
 * artifact present, stamped and whole (`artifactMatchesItsStamp`)? If it is,
 * nothing is injected; if not (absent, zero bytes, no stamp, half written), the
 * rules are injected as before. Staleness stays UNKNOWN either way, and
 * Justin's header line says so.
 */
const REPO_CARRIES_RULES: Record<
  RulesDriftStatus,
  boolean | 'if-the-artifact-is-whole'
> = {
  'cannot-check': 'if-the-artifact-is-whole',
  'in-sync': true,
  'locally-modified': true,
  missing: false,
  'not-enrolled': false,
  stale: true,
};

/** REPO_CARRIES_RULES, with its one conditional row resolved against the disk. */
export function repoCarriesRules(
  status: RulesDriftStatus,
  projectRoot: string,
): boolean {
  const rule = REPO_CARRIES_RULES[status];
  return rule === 'if-the-artifact-is-whole'
    ? artifactMatchesItsStamp(projectRulesFilePath(projectRoot))
    : rule;
}

/**
 * The most session-start puts into Claude's context, in characters
 * (home-base-t6a0.17 D2). Claude Code replaces a hook's `additionalContext`
 * longer than CLAUDE_CODE_HOOK_TEXT_CAP (10,000) with a file path and a
 * 2,000-character preview, and an agent that saw that preview did not read the
 * file (2026-07-15). 1,000 characters of margin under the cap.
 */
export const SESSION_START_INJECTION_BUDGET = CLAUDE_CODE_HOOK_TEXT_CAP - 1_000;

/** What `fitToBudget` settled on. */
export interface BudgetFit {
  /** Top-level modules left out of `text`, in index order. */
  dropped: AssembledModule[];
  /**
   * The final text. Over the budget only if it was still over with every
   * module left out (the pointer line and the repo state are never dropped).
   */
  text: string;
}

/**
 * D2: measure the FINAL string; while it is over the budget, leave out one
 * more whole module and compose again. Conditional modules go first, from the
 * end of the list; universal modules only once every conditional one is out
 * (the case where the user-level rules file is missing and the full rules are
 * injected). Leaving modules out from the end keeps the numbering of the ones
 * that stay.
 *
 * `compose` builds the final Claude-bound string (prettier'd, repo state
 * joined) for a set of kept modules, and is told which ones were left out so it
 * can name them. The measurement is of what it returns, nothing earlier.
 */
export function fitToBudget(
  modules: readonly AssembledModule[],
  compose: (
    kept: readonly AssembledModule[],
    dropped: readonly AssembledModule[],
  ) => string,
  budget: number = SESSION_START_INJECTION_BUDGET,
): BudgetFit {
  const dropOrder = [
    ...modules.filter((m) => m.conditional).reverse(),
    ...modules.filter((m) => !m.conditional).reverse(),
  ];
  const out = new Set<AssembledModule>();
  let text = compose(modules, []);
  for (const next of dropOrder) {
    if (text.length <= budget) break;
    out.add(next);
    text = compose(
      modules.filter((m) => !out.has(m)),
      modules.filter((m) => out.has(m)),
    );
  }
  return {dropped: modules.filter((m) => out.has(m)), text};
}

/**
 * The line that tells Claude which modules it did not get and how to get them
 * (D2). One line, with one command that prints every module it names, in the
 * same form the pointer line uses for `prime --full` (D3).
 */
function droppedModulesLine(dropped: readonly AssembledModule[]): string {
  const names = (ms: readonly AssembledModule[]): string =>
    ms.map((m) => m.name).join(', ');
  const conditional = dropped.filter((m) => m.conditional);
  const universal = dropped.filter((m) => !m.conditional);
  const which =
    universal.length === 0
      ? names(conditional)
      : conditional.length === 0
        ? `the always-on modules ${names(universal)}`
        : `the project-specific modules ${names(conditional)} and, because leaving those out was not enough, the always-on modules ${names(universal)}`;
  const count = `${dropped.length} rule module${dropped.length === 1 ? '' : 's'}`;
  return `⚠️ To stay under Claude Code's ${CLAUDE_CODE_HOOK_TEXT_CAP.toLocaleString('en-US')}-character hook limit, this injection leaves out ${count} that ${dropped.length === 1 ? 'applies' : 'apply'} to this repo: ${which}. Run \`${primeModulesCmd(dropped.map((m) => m.name))}\` and read the output before continuing. These rules are critical and override defaults.`;
}

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
  /** Left out to stay under the hook budget (D2): named as such, not "injected". */
  dropped: ReadonlySet<string>;
  names: string[] | null;
  rulesFailed: string | null;
  suppressed: boolean;
}): string {
  const {dropped, names, rulesFailed, suppressed} = args;
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
    names
      .map(
        (n, i) =>
          `  ${i + 1}. ${n}${dropped.has(n) ? ' (NOT injected: over the hook limit)' : ''}`,
      )
      .join('\n')
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
  // Missing file -> inject the FULL rules as a fallback; otherwise just the
  // project-specific CONDITIONAL rules (the universal bulk is in the file).
  const partition = fileMissing ? 'full' : 'conditional';
  let assembled: Assembled | null = null;
  let condNames: string[] | null = null;
  let rulesFailed: string | null = null;

  try {
    assembled = assemble({partition}, projectRoot);
    // The FULL partition's names are every module, universal ones included,
    // so the conditional subset is asked for separately — from the same clone,
    // so nothing is fetched twice.
    condNames = fileMissing
      ? assemble(
          {partition: 'conditional', promptsDir: assembled.sourceDir},
          projectRoot,
        ).names
      : assembled.names;
  } catch (error) {
    rulesFailed = error instanceof Error ? error.message : String(error);
  }
  const cloneSha = assembled?.sourceCommit?.sha ?? null;
  const sourceDir = assembled?.sourceDir ?? null;

  // --- committed per-repo artifact: is THIS repo's rules file current? ------
  // Reported, never fixed: nothing inside the repo is written here (D4/D9).
  const repoRules = checkRulesDrift(projectRoot);
  const suppressRuleText = repoCarriesRules(repoRules.status, projectRoot);

  // --- repo state: only when the first-prompt hook could not be armed -------
  const repoState = firstPrompt.ok ? '' : composeRepoState(projectRoot);

  // --- compose + Prettier the injection (for the model), within budget (D2) -
  const injected = suppressRuleText ? null : assembled;
  /**
   * About the LAST compose, which is the one whose text is used: set when its
   * narrowed re-assembly threw, so every module was left out.
   */
  const lastCompose: {narrowingFailed: string | null} = {narrowingFailed: null};
  const composeForClaude = (
    kept: readonly AssembledModule[],
    dropped: readonly AssembledModule[],
  ): string => {
    lastCompose.narrowingFailed = null;
    let rules = '';
    if (injected != null) {
      let body = fileMissing ? injected.markdown : injected.text;
      let named = dropped;
      if (dropped.length > 0) {
        try {
          // Same clone, so nothing is fetched again; `modules` only narrows.
          const narrowed = assemble(
            {
              modules: kept.map((m) => m.name),
              partition,
              promptsDir: injected.sourceDir,
            },
            projectRoot,
          );
          body =
            kept.length === 0
              ? ''
              : fileMissing
                ? narrowed.markdown
                : narrowed.text;
        } catch (error) {
          // The kept modules cannot be produced, so none are injected, and the
          // line names every one of them: never a body that silently lacks some.
          lastCompose.narrowingFailed =
            error instanceof Error ? error.message : String(error);
          body = '';
          named = injected.modules;
        }
      }
      rules = [
        pointerLine(fileMissing),
        named.length > 0 ? droppedModulesLine(named) : '',
        body,
      ]
        .filter((s) => s.length > 0)
        .join('\n\n');
      // Presentation only — this text is injected, never hashed or committed —
      // so a prettier failure legitimately degrades to the unformatted (still
      // complete) markdown. The drift hash below is a MEASUREMENT, handled
      // differently.
      const formatted = prettierMarkdown(rules);
      if (formatted.status !== 'failed') rules = formatted.markdown;
    }
    return [rules, repoState].filter((b) => b.length > 0).join('\n\n');
  };
  const fit = fitToBudget(injected?.modules ?? [], composeForClaude);
  const forClaude = fit.text;
  const {narrowingFailed} = lastCompose;
  const droppedNames =
    narrowingFailed != null
      ? (injected?.modules ?? []).map((m) => m.name)
      : fit.dropped.map((m) => m.name);

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
    parts.push(
      repoRules.status === 'cannot-check'
        ? 'rule text NOT injected (this repo carries its own; its staleness is UNKNOWN)'
        : 'rule text NOT injected (this repo carries its own)',
    );
  }
  // D2: what the budget left out is Justin's to see too, by name. Not the
  // command: it is in Claude's line, which the mirror below shows him, and
  // repeating it here pushed a 16-module systemMessage to 9,828 of the same
  // 10,000-character cap (measured 2026-11-07).
  if (droppedNames.length > 0) {
    parts.push(
      `⚠️ ${droppedNames.length} rule module${droppedNames.length === 1 ? '' : 's'} left out to stay under the ${CLAUDE_CODE_HOOK_TEXT_CAP.toLocaleString('en-US')}-character hook limit (${droppedNames.join(', ')}); Claude was told how to print ${droppedNames.length === 1 ? 'it' : 'them'}`,
    );
  }
  if (narrowingFailed != null) {
    parts.push(
      `⚠️ every rule module was left out because the shortened rules could not be assembled (${narrowingFailed})`,
    );
  }
  if (forClaude.length > SESSION_START_INJECTION_BUDGET) {
    parts.push(
      `⚠️ the injection is ${forClaude.length} characters, over the ${SESSION_START_INJECTION_BUDGET}-character budget even with every rule module left out`,
    );
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
    dropped: new Set(droppedNames),
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
    // Imported here: it reaches health-notices, which must stay off the path
    // cli-main.ts loads statically (tests/health-notices-cli.test.ts).
    const {sessionStartWarningFilter} = await import('./doctor-warn-once');
    const doctor = await renderDoctor(projectRoot, {
      quiet: true,
      warningFilter: await sessionStartWarningFilter(projectRoot),
    });
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
