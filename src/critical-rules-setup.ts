/**
 * critical-rules-setup — the COMMITTED per-repo critical-rules artifact.
 *
 * Writes `.claude/rules/justin-sdk/critical-rules.md` into the consuming
 * project: a generated file, committed to the repo, that Claude Code autoloads
 * at CLAUDE.md priority with no truncation cap. It supersedes the user-level
 * `~/.claude/rules/` delivery for enrolled repos (home-base-t6a0.21 D1), because
 * a committed file is the only channel that reaches Claude Code web, CI, a fresh
 * clone, and a new machine — and because when it fails, it fails VISIBLY in a
 * diff instead of silently omitting every rule.
 *
 * TWO LAYERS, deliberately separate (t6a0.21 D2 + the Dispatch-B addendum):
 *
 *   (a) refreshCriticalRulesArtifact() — assembles the rules for THIS project
 *       and writes the artifact. Touches NOTHING else: no config rewrite and no
 *       SDK pin. This is the layer `rules-update` (home-base-q1hp)
 *       calls, because it must commit only paths under .claude/rules/justin-sdk/.
 *
 *   (b) runCriticalRulesSetup() — enrollment: the base-setup chain, then (a),
 *       then the `.claude/settings.json` exclusion that drops the USER-LEVEL
 *       duplicate (home-base-anhw). This is what
 *       `add critical-rules` and `sweep --component critical-rules` run; the
 *       sweep's pin-neutrality guard absorbs base-setup's config drift.
 *       The exclusion lives HERE and not in (a) on purpose: (a) is what
 *       `rules-update` calls, and its contract is that it writes exactly one
 *       path so a rules-only commit stays rules-only.
 *
 * DEDUPLICATION, NOT RETIREMENT (home-base-anhw, revising t6a0.21 D7): the
 * user-level `~/.claude/rules/justin-sdk/critical-rules.md` is KEPT — it is the
 * only channel reaching the ~69 repos that are not enrolled. An enrolled repo
 * would otherwise load the universal rules TWICE (user-level + its own
 * artifact), so enrollment adds one `claudeMdExcludes` entry naming the
 * user-level file and nothing else. The hook's half of the same job is in
 * src/session-start.ts: it stops injecting rule text into a repo that carries
 * its own artifact.
 *
 * THE REGISTRY DECIDES, AT EVERY REFRESH (epic home-base-dchjw D2). The prompts
 * repo's rules index plus the project-type predicates, evaluated against the
 * project AS IT IS NOW, are the whole answer. There is no per-repo include-list.
 *
 * The retired design (D12, deleted here) recorded the predicates' RESULT once at
 * enrollment in `componentConfig["critical-rules"].modules` and assembled from
 * that list forever after. Justin, verbatim: *"this seems like an ENORMOUS
 * FOOTGUN, because it by definition will not include any NEW modules that are
 * added to critical-rules, AND it seems to allow repos to effectively opt-out of
 * rules … I just deleted beads-workflow and rules-update removed it from
 * critical-rules. This is a terrible design and needs to be undone immediately."*
 * It also froze the predicates: React/Native rules reached a repo only if
 * expo/react-native was a dependency ON THE DAY it was enrolled. A config that
 * still carries the key gets ONE warning and is otherwise ignored.
 *
 * What the old design was defending against — an `includeIf` naming a predicate
 * the running SDK does not know, silently deleting a module (t6a0.20) — is still
 * handled, but by being LOUD rather than by freezing: an unknown predicate
 * excludes the module AND emits a warning through `assembled.warnings`, which
 * this writer prints, and it moves the module fingerprint in the artifact header
 * so the change is visible in the committed diff rather than silent.
 *
 * FRESHNESS IS NOT OPTIONAL FOR A WRITER (D15): the managed prompts clone
 * tolerates a failed refresh by keeping the old checkout — correct for a reader,
 * unacceptable here. If the refresh failed we ABORT with a distinct
 * cannot-refresh outcome and write nothing, so a stale clone can never become a
 * committed artifact and "couldn't check" is never reported as "in sync".
 */

import {execFileSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import {basename, dirname, join, relative, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  assemble,
  isDirtyCheckout,
  PROMPTS_SOURCE_FAILURE,
  type PromptsCommit,
  type SourceRefresh,
} from './prime';
import {legacyModulesWarning} from './rules/rules-enrollment';
import {
  buildArtifactStamp,
  contentHash,
  moduleFingerprint,
  prettierEnabled,
  prettierMarkdown,
  projectRulesFilePath,
  rulesFilePath,
  RULES_UPDATE_CMD,
} from './rules/rules-file';
import {
  fail,
  findLocalPrettier,
  isQuiet,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

/**
 * The enrolment reader and the retired-key detector live in
 * src/rules/rules-enrollment.ts — see the header there for why they are split
 * out. Re-exported here so the installer-facing import sites are unchanged —
 * one definition, two names for the same module.
 */
export {
  CRITICAL_RULES_COMPONENT,
  CRITICAL_RULES_CONFIG_KEY,
  hasRetiredModulesKey,
  legacyModulesWarning,
  readEnrollment,
  RETIRED_MODULES_KEY,
  type EnrollmentRead,
} from './rules/rules-enrollment';

/**
 * Print the retired-`modules`-key warning, if the repo still carries one.
 *
 * ONE emitter, called ONCE PER COMMAND at the entry point (`add critical-rules`,
 * `rules-update`, `rules-diff`; doctor attaches the same text to a check instead
 * of printing it). The refresh layer deliberately does NOT call it: doctor's
 * fixer calls that layer, and a second emitter there would print the same
 * warning twice in one doctor run.
 */
export function warnRetiredModulesKey(projectRoot: string): void {
  const message = legacyModulesWarning(projectRoot);
  if (message != null) warn(message);
}

// ---------------------------------------------------------------------------
// Layer (a): refresh the artifact and NOTHING else
// ---------------------------------------------------------------------------

export interface RefreshSuccess {
  status: 'written' | 'unchanged';
  /** Absolute path of the artifact. */
  file: string;
  contentHash: string;
  /** Modules actually inlined, in index order — the resolved set. */
  modules: string[];
  /** `moduleFingerprint(modules)` — what the header records. */
  moduleFingerprint: string;
  /** prompts-repo HEAD commit, or null when the source isn't a git checkout. */
  sourceCommit: PromptsCommit | null;
  sourceRefresh: SourceRefresh;
  warnings: string[];
}

export interface RefreshFailure {
  status: 'cannot-refresh' | 'failed';
  message: string;
}

export type RefreshOutcome = RefreshSuccess | RefreshFailure;

export function refreshSucceeded(
  outcome: RefreshOutcome,
): outcome is RefreshSuccess {
  return outcome.status === 'written' || outcome.status === 'unchanged';
}

export interface RefreshOptions {
  /** Rewrite even when the content hash is unchanged. */
  force?: boolean;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
  /**
   * Toggle the shared QUIET flag. Omit to leave it exactly as the caller set it
   * — the installer sets it once and this layer must not clobber that.
   */
  quiet?: boolean;
}

/**
 * A refresh state a WRITER may generate from. 'skipped' (the staleness gate
 * decided no refresh was needed) is deliberately NOT here: this function always
 * forces a refresh, so anything short of a completed one means we could not
 * verify the source, and unverified is not permission to write (D15).
 *
 * Exported for `rules-diff` (home-base-q1hp), which forces a refresh for the
 * same reason and must reach the same verdict — ONE definition of "verified", so
 * the read path and the write path cannot drift into disagreeing about whether
 * the source was checked.
 */
export function refreshIsVerified(refresh: SourceRefresh): boolean {
  return refresh === 'override' || refresh === 'cloned' || refresh === 'pulled';
}

/**
 * Regenerate the committed artifact for this project, from the registry.
 *
 * Writes exactly one path — `.claude/rules/justin-sdk/critical-rules.md` — and
 * touches nothing else in the project, which is the property that lets
 * `rules-update` commit a rules-only change. Never commits: committing belongs
 * to `rules-update` and to the sweep.
 *
 * It does NOT gate on enrolment. Enrolment is the CALLER's question — it is what
 * `rules-update` checks before anything is written, and it is what `add
 * critical-rules` is in the middle of establishing when it calls this. A second
 * gate here would have refused the very run that enrolls a repo.
 */
export function refreshCriticalRulesArtifact(
  projectRoot: string,
  options: RefreshOptions = {},
): RefreshOutcome {
  if (options.quiet != null) setQuiet(options.quiet);

  let assembled;
  try {
    // forceUpdate is hardcoded, not an option: a writer must always try to
    // refresh, so that a failure to do so is detectable rather than assumed.
    // The project root is passed so the predicates run against THIS project as
    // it is right now (D2) — never a list frozen at enrolment.
    assembled = assemble(
      {
        forceUpdate: true,
        partition: 'full',
        promptsDir: options.promptsDir,
      },
      projectRoot,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // "there is no usable prompts checkout at all" is a cannot-CHECK, not a
    // wrong-content — same class as a failed refresh, and it must not be
    // reported as an assembly defect.
    if (reason.startsWith(PROMPTS_SOURCE_FAILURE)) {
      const message = `${reason} — NOT writing the artifact`;
      fail(`critical-rules: ${message}`);
      return {message, status: 'cannot-refresh'};
    }
    const message = `could not assemble the rules modules (${reason})`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'failed'};
  }

  // An index that resolves to NOTHING is a failure, not an empty document. The
  // artifact is committed and autoloaded: writing zero rules over a repo's rules
  // file is the total-omission failure this component exists to prevent, and it
  // would look exactly like success.
  if (assembled.names.length === 0) {
    const message =
      `the rules index at ${assembled.sourceDir} resolved to NO modules for this project — ` +
      `refusing to write an empty rules artifact`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'failed'};
  }

  if (!refreshIsVerified(assembled.sourceRefresh)) {
    // The clone still has usable content — that is exactly the trap. Refuse.
    const message =
      `cannot refresh the prompts clone at ${assembled.sourceDir} ` +
      `(refresh: ${assembled.sourceRefresh}) — NOT writing the artifact from a possibly-stale checkout. ` +
      `Fix connectivity and re-run, or pass an explicit prompts dir.`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'cannot-refresh'};
  }

  const file = projectRulesFilePath(projectRoot);
  // Format with the TARGET REPO'S OWN prettier when it has one, AND with that
  // repo's own config: this artifact is committed and is checked by that repo's
  // signal/lint-staged, and the sweep gates on exactly that. Passing `filePath`
  // is what makes the config the repo's — formatting the same bytes anywhere
  // else silently applies prettier's defaults (t6a0.21.1). The three read-only
  // callers pass the identical filePath, so their canonical bytes match these.
  const formatted = prettierMarkdown(assembled.markdown, {
    binary: findLocalPrettier(dirname(file)),
    filePath: file,
  });
  if (formatted.status === 'failed') {
    // Refuse to write. Unformatted bytes here are not a cosmetic loss: they get
    // COMMITTED, they fail the repo's own prettier gate three steps later with
    // no hint as to why, and their contentHash describes bytes no reader will
    // ever reproduce. "Could not format" is not "nothing to format" (rule 5).
    const message = `could not format the artifact — NOT writing it (${formatted.reason})`;
    fail(`critical-rules: ${message}`);
    return {message, status: 'failed'};
  }
  const pretty = formatted.markdown;
  const hash = contentHash(pretty);
  const fingerprint = moduleFingerprint(assembled.names);

  for (const warning of assembled.warnings) warn(warning);

  const common = {
    contentHash: hash,
    file,
    moduleFingerprint: fingerprint,
    modules: assembled.names,
    sourceCommit: assembled.sourceCommit,
    sourceRefresh: assembled.sourceRefresh,
    warnings: assembled.warnings,
  };

  const shaShort =
    assembled.sourceCommit != null
      ? assembled.sourceCommit.sha.slice(0, 12)
      : 'unknown';
  const dirtySuffix =
    assembled.sourceCommit != null && isDirtyCheckout(assembled.sourceDir)
      ? '-dirty'
      : '';
  const stamp = buildArtifactStamp({
    command: RULES_UPDATE_CMD,
    contentHash: hash,
    moduleFingerprint: fingerprint,
    // 'unknown' rather than today's date when the source is not a git checkout:
    // the header states the PROMPTS COMMIT's date, and substituting the date of
    // the run would be a measurement we did not make (critical rule 6).
    promptsDate: assembled.sourceCommit?.date ?? 'unknown',
    promptsSha: `${shaShort}${dirtySuffix}`,
  });
  const body = `${stamp}\n\n${pretty}\n`;

  // IDEMPOTENCY IS A BYTE COMPARISON, not a stamp comparison. The header carries
  // no generation timestamp (see buildArtifactStamp), so the bytes we would
  // write are a pure function of the source and the project — which makes "is
  // this file already what we would write?" answerable exactly, including for a
  // file whose header still claims the right hashes but whose BODY was edited by
  // hand. The old stamp-hash comparison certified precisely that file as
  // "already in sync" and changed nothing.
  if (options.force !== true && existsSync(file)) {
    let onDisk: string | null;
    try {
      onDisk = readFileSync(file, 'utf-8');
    } catch {
      // Unreadable is not "different" and not "same" — fall through and rewrite,
      // which is the outcome that leaves the repo correct either way.
      onDisk = null;
    }
    if (onDisk === body) {
      success(
        `rules already in sync (content ${hash}, ${assembled.names.length} module${
          assembled.names.length === 1 ? '' : 's'
        }, fingerprint ${fingerprint}) — no rewrite`,
      );
      return {...common, status: 'unchanged'};
    }
  }

  // Atomic write (a session can start mid-write).
  mkdirSync(dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);

  verifyArtifactIsPrettierClean(projectRoot, file);

  success(
    `wrote ${relative(projectRoot, file)}\n  prompts ${shaShort}${dirtySuffix} · ` +
      `${assembled.names.length} module${assembled.names.length === 1 ? '' : 's'} · ` +
      `modules ${fingerprint} · content ${hash}`,
  );
  return {...common, status: 'written'};
}

/**
 * The bytes we just committed must be a FIXPOINT of the repo's own prettier —
 * that is the literal thing `sweep --component critical-rules` gates on, via
 * `signal-source:PRETTIER`.
 *
 * The body is formatted, but the stamp is prepended AFTERWARDS (it carries the
 * hash OF the formatted body, so it cannot be present while that body is being
 * formatted). Whether prettier leaves a stamped file alone is therefore an
 * assumption — an empirically solid one (an HTML comment followed by a blank
 * line is an untouched markdown `html` node; measured against prettier 3.6 with
 * a real fleet config), but this bead exists because an assumption about
 * prettier went unchecked. So: check it, on every real write, in every repo.
 *
 * `--check` rather than a second `--write`: it answers the same question
 * without mutating a file whose stamp already claims a hash for the body on
 * disk. Run with cwd = projectRoot and WITHOUT the ignore override, so this
 * mirrors the repo's own `prettier --check .` exactly — including a repo that
 * ignores the artifact, where there is genuinely nothing to satisfy.
 *
 * Warn, don't fail: the file is already written, the sweep's own gate will go
 * red on it anyway, and this line is the explanation that gate cannot give.
 */
function verifyArtifactIsPrettierClean(
  projectRoot: string,
  file: string,
): void {
  if (!prettierEnabled()) return;
  const binary = findLocalPrettier(dirname(file));
  if (binary == null) return; // no repo prettier ⇒ no repo prettier gate
  try {
    execFileSync(binary, ['--check', file], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    warn(
      `critical-rules: ${relative(projectRoot, file)} does NOT satisfy this repo's own ` +
        `\`prettier --check\` — the repo's signal/lint-staged gate will fail on it. ` +
        `The rules BODY was formatted with ${binary}, so the difference is in the ` +
        `generated stamp line; that is a bug in this tool, not in the repo.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer (b): suppress the USER-LEVEL duplicate (home-base-anhw)
// ---------------------------------------------------------------------------

/** The Claude Code settings key that drops a file from the autoloaded set. */
export const CLAUDE_MD_EXCLUDES_KEY = 'claudeMdExcludes';

/**
 * The one string this repo excludes: the ABSOLUTE path of the USER-LEVEL rules
 * file — the same path `sync-rules` writes, from the same function, so the
 * exclusion and the file it suppresses cannot drift apart.
 *
 * *** THE FORM IS NOT A STYLE CHOICE — IT WAS MEASURED, AND EVERY PLAUSIBLE
 * ALTERNATIVE IS BROKEN (home-base-anhw, six real `claude -p` probes). ***
 *
 * The user-level file and the committed per-repo artifact have the SAME
 * basename and the SAME trailing four segments (`.claude/rules/justin-sdk/
 * critical-rules.md`) — one under $HOME, one under the repo. So:
 *
 *   `**​/justin-sdk/critical-rules.md`   excludes BOTH — including the repo's own
 *                                       artifact. That is total omission: the
 *                                       failure class this whole epic exists to
 *                                       kill. Reproduced, not theorised.
 *   `~/.claude/rules/…`                 no tilde expansion — matches nothing.
 *   `$HOME/.claude/rules/…`             no env expansion — matches nothing.
 *   `/Users/*​/.claude/rules/…`          a `*` segment does not match — nothing.
 *   `/Users/jhaa/.claude/rules/…`       the ONLY form that suppresses the
 *                                       user-level file while leaving the
 *                                       repo's own artifact loaded.
 *
 * The three no-op forms are the real hazard: they look perfectly reasonable in
 * a committed settings.json and fail SILENTLY (the repo just keeps
 * double-loading). Only a probe can tell them from the working form — reading
 * the file cannot. Do not "tidy" this into a portable-looking glob.
 *
 * Machine-specificity is therefore forced, and it is fine: on a machine with a
 * different $HOME the entry matches nothing, which is the BENIGN direction (a
 * duplicate, never an omission), and off Justin's machines — cloud, CI, a fresh
 * clone of one of the public repos — there is no user-level file to suppress at
 * all. It is also why the write below is ADDITIVE: a second machine APPENDS its
 * own path rather than replacing the first, so both converge instead of
 * un-fixing each other.
 */
export function userLevelRulesExclude(): string {
  return rulesFilePath();
}

export type ExcludeOutcome =
  | {status: 'added' | 'already-present'; value: string}
  | {status: 'failed'; message: string};

/**
 * Add the user-level exclusion to the repo's `.claude/settings.json`, ADDITIVELY.
 *
 * Never clobbers: an existing `claudeMdExcludes` list is preserved entry for
 * entry and ours is appended, because that list is Justin's to curate and this
 * component owns exactly one line of it. Re-running is a no-op (idempotent), so
 * every future `sweep --component critical-rules` leaves the file byte-identical.
 *
 * A settings.json that exists but cannot be parsed, or a `claudeMdExcludes` that
 * is not a list of strings, is a REFUSAL — never a silent overwrite. Those bytes
 * are a human's configuration; guessing what they meant and rewriting them is
 * worse than stopping and saying so.
 */
export function addUserLevelRulesExclude(projectRoot: string): ExcludeOutcome {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  const value = userLevelRulesExclude();

  // readJson returns null for BOTH "missing" and "unparseable" — a distinction
  // that decides between "create it" and "do not touch it" (rule 5).
  const existing = readJson(settingsPath);
  if (existing == null && existsSync(settingsPath)) {
    return {
      message: `${settingsPath} exists but could not be parsed — refusing to rewrite a settings file we cannot read`,
      status: 'failed',
    };
  }
  const settings = existing ?? {};

  const raw = settings[CLAUDE_MD_EXCLUDES_KEY];
  if (
    raw != null &&
    (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string'))
  ) {
    return {
      message: `${settingsPath} has a "${CLAUDE_MD_EXCLUDES_KEY}" that is not an array of strings — refusing to overwrite it`,
      status: 'failed',
    };
  }
  const excludes = raw == null ? [] : [...(raw as string[])];
  if (excludes.includes(value)) return {status: 'already-present', value};

  excludes.push(value);
  settings[CLAUDE_MD_EXCLUDES_KEY] = excludes;
  mkdirSync(dirname(settingsPath), {recursive: true});
  writeJson(settingsPath, settings);
  return {status: 'added', value};
}

/** Installer step wrapper: logs, and reports whether enrollment may continue. */
export function stepUserLevelRulesExclude(projectRoot: string): boolean {
  const outcome = addUserLevelRulesExclude(projectRoot);
  if (outcome.status === 'failed') {
    fail(`critical-rules: ${outcome.message}`);
    return false;
  }
  const where = join('.claude', 'settings.json');
  success(
    outcome.status === 'added'
      ? `${where} now excludes the user-level rules file\n  ${outcome.value}\n  (this repo's own committed artifact is unaffected — only the duplicate is dropped)`
      : `${where} already excludes the user-level rules file`,
  );
  return true;
}

export async function runCriticalRulesSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(args.sdkRepoUrl == null ? {} : {sdkRepoUrl: args.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with critical-rules-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  // The ONE place this command mentions the retired include-list (dchjw.3).
  warnRetiredModulesKey(projectRoot);

  stepHeader('1. .claude/rules/justin-sdk/critical-rules.md (the artifact)');
  const outcome = refreshCriticalRulesArtifact(projectRoot, {
    force: args.force,
    promptsDir: args.promptsDir,
  });
  if (!refreshSucceeded(outcome)) return 1;

  // DELIVERY BEFORE DEDUPLICATION — the order is load-bearing. The exclusion
  // step can refuse (a settings.json we must not rewrite), and if it ran first
  // that refusal would cost this repo its rules entirely. Written second, the
  // worst case is the artifact landing without the exclusion: a DUPLICATE, which
  // is exactly today's behaviour and harmless, reported loudly either way.
  stepHeader('2. .claude/settings.json (drop the user-level duplicate)');
  if (!stepUserLevelRulesExclude(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mcritical-rules-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        `The artifact is a GENERATED, COMMITTED file — commit it, and regenerate with \`${RULES_UPDATE_CMD}\`.\n` +
        `Which modules it carries is decided by the prompts rules registry and this project's type, every time it is regenerated — there is nothing to tune per repo.\n`,
    );
  }

  return 0;
}
