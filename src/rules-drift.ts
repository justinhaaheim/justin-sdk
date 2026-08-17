/**
 * rules-drift — the ONE staleness verdict for the committed per-repo rules
 * artifact (home-base-si46, t6a0.21 D4/D5/D9).
 *
 * Two consumers, one function, deliberately: the plugin's SessionStart hook (a
 * notice in the systemMessage) and the `critical-rules-setup` doctor check.
 * Written twice they would drift into disagreeing about whether a repo's rules
 * are current — the session would say one thing and doctor the other, and only
 * one of them could be right. So this module answers the question and neither
 * consumer computes anything; they only choose how to say it.
 *
 * SIX STATES, NONE COLLAPSED (critical rule 5 — failure is not empty):
 *   not-enrolled      no module selection recorded. NOT a rules problem.
 *   in-sync           checked, and the artifact is the canonical one.
 *   missing           enrolled, but there is no artifact at all.
 *   locally-modified  the file's bytes disagree with its OWN stamp — a hand
 *                     edit, or a different prettier. Distinct because the
 *                     stamp still claims the canonical hash, so plain
 *                     `rules-update` would report "already up to date" and
 *                     change nothing (the Dispatch-C discovery).
 *   stale             the artifact is genuinely older than the prompts source.
 *   cannot-check      the source could not be read/refreshed, or the selection
 *                     is broken. NEVER reported as in-sync (D5).
 *
 * ORDER IS COST AND CERTAINTY, IN THAT ORDER. Everything decidable from local
 * bytes is decided before anything that can touch the network, because this runs
 * at EVERY session start:
 *   1. selection      (one small JSON read)
 *   2. file exists    (a stat) -> missing, definitively, without a refresh
 *   3. bytes vs stamp (a hash)  -> locally-modified, definitively, no network
 *   4. source         (staleness-gated refresh + assemble) -> cannot-check
 *   5. sha fast path  -> in-sync without running prettier
 *   6. content        (prettier + byte compare) -> stale | in-sync
 * Step 3 sits BEFORE step 5 on purpose: a stamp-preserving hand edit passes the
 * sha fast path, which is exactly how it would go unnoticed.
 *
 * READER FRESHNESS IS NOT WRITER FRESHNESS. This is a reader, so it does NOT
 * force a fetch (`refreshIsVerified` — the writer's predicate — is deliberately
 * not used here): 'skipped' means the staleness gate judged the clone fresh
 * enough, which for a reader it is (prime.ts's own contract). Only 'failed' — a
 * refresh that was ATTEMPTED and did not work — becomes cannot-check. The cost
 * of that choice is bounded and stated: a rules change pushed inside the
 * staleness window may not be noticed until the next window, and `rules-diff`
 * (which does force a refresh) is the command that always knows.
 *
 * TOTAL AND SILENT. It never throws and never prints: the hook's stdout is a
 * JSON envelope, so a stray console.log from a helper would corrupt every
 * session's hook output, and an exception would take the whole injection down.
 */

import {existsSync, readFileSync} from 'fs';
import {dirname} from 'path';

import {readSelectedModules} from './critical-rules-setup';
import {
  assembleSelected,
  PROMPTS_SOURCE_FAILURE,
  type SourceRefresh,
} from './plugin/lib/prime';
import {
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  prettierMarkdown,
  projectRulesFilePath,
  readDeployedStamp,
  RULES_DIFF_CMD,
  RULES_UPDATE_CMD,
} from './plugin/lib/rules-file';
import {artifactBody} from './rules-diff';
import {findLocalPrettier} from './setup-helpers';

export type RulesDriftStatus =
  | 'not-enrolled'
  | 'in-sync'
  | 'missing'
  | 'locally-modified'
  | 'stale'
  | 'cannot-check';

export interface RulesDriftResult {
  status: RulesDriftStatus;
  /**
   * What was found, as a statement of fact with no advice in it — the advice is
   * `rulesDriftAdvice`, so both consumers word it identically.
   */
  message: string;
  /** Absolute artifact path (known for every status except not-enrolled). */
  file: string | null;
  /** 12-char prompts sha the artifact was generated from, when stamped. */
  artifactSha: string | null;
  /** 12-char prompts-clone HEAD at check time, when the source was reached. */
  sourceSha: string | null;
  /** How the source was obtained — null when we never got that far. */
  sourceRefresh: SourceRefresh | null;
  /** Size of the recorded module selection, when it could be read. */
  moduleCount: number | null;
}

export interface RulesDriftOptions {
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
}

/** Is this a state a human should be told about? not-enrolled and in-sync are not. */
export function isRulesDriftProblem(status: RulesDriftStatus): boolean {
  return status !== 'in-sync' && status !== 'not-enrolled';
}

/**
 * The remedy for each state, naming the exact commands.
 *
 * ONE definition, shared by the session notice and the doctor check, because
 * these strings are the whole product of the feature: a notice that names the
 * wrong command (or names `rules-update` for a hand-edited file, where it
 * reports "already up to date" and changes nothing) is worse than no notice.
 */
export function rulesDriftAdvice(status: RulesDriftStatus): string | null {
  switch (status) {
    case 'stale':
      return `run \`${RULES_DIFF_CMD}\` to see what changed, then \`${RULES_UPDATE_CMD}\` to commit the update`;
    case 'missing':
      return `run \`${RULES_UPDATE_CMD}\` to generate and commit it`;
    case 'locally-modified':
      // rules-diff FIRST: it prints what the local bytes say, which is the only
      // way to know whether the edit was worth keeping before it is overwritten.
      return `run \`${RULES_DIFF_CMD}\` to see the difference, then \`${RULES_UPDATE_CMD} --force\` to overwrite the local edit`;
    case 'cannot-check':
      return `staleness UNKNOWN — fix the source (connectivity/config) and re-check with \`${RULES_DIFF_CMD}\``;
    case 'not-enrolled':
      return 'run `bunx github:justinhaaheim/justin-sdk add critical-rules` to enroll this repo';
    case 'in-sync':
      return null;
  }
}

function result(
  status: RulesDriftStatus,
  message: string,
  extra: Partial<RulesDriftResult> = {},
): RulesDriftResult {
  return {
    artifactSha: null,
    file: null,
    message,
    moduleCount: null,
    sourceRefresh: null,
    sourceSha: null,
    status,
    ...extra,
  };
}

/**
 * Decide whether this repo's committed rules artifact is the canonical one.
 *
 * Reads only. The one thing it may write is OUTSIDE the repo: resolving the
 * prompts source can refresh the managed clone under ~/.config/justin-sdk (D9 —
 * the session-start path never writes inside the project).
 */
export function checkRulesDrift(
  projectRoot: string,
  options: RulesDriftOptions = {},
): RulesDriftResult {
  try {
    return check(projectRoot, options);
  } catch (error) {
    // Total by contract: an unexpected throw here would take down a session's
    // whole prime injection, and "the check crashed" is a cannot-check — never a
    // clean bill of health.
    return result(
      'cannot-check',
      `the rules staleness check failed unexpectedly (${
        error instanceof Error ? error.message : String(error)
      })`,
      {file: projectRulesFilePath(projectRoot)},
    );
  }
}

function check(
  projectRoot: string,
  options: RulesDriftOptions,
): RulesDriftResult {
  // 1. Selection — the ONE reader (uniformity: enrolment cannot mean two things).
  const selection = readSelectedModules(projectRoot);
  if (!selection.ok) {
    return selection.status === 'not-enrolled'
      ? result('not-enrolled', selection.message)
      : result('cannot-check', selection.message, {
          file: projectRulesFilePath(projectRoot),
        });
  }
  const moduleCount = selection.modules.length;
  const file = projectRulesFilePath(projectRoot);
  const base = {file, moduleCount};

  // 2. Existence, before any network work: "enrolled but there is no artifact"
  //    is already the complete, actionable fact.
  if (!existsSync(file)) {
    return result(
      'missing',
      `no rules artifact at ${file}, but this repo is enrolled (${moduleCount} module${
        moduleCount === 1 ? '' : 's'
      } selected) — this session loaded NO justin-sdk rules from the repo`,
      base,
    );
  }

  let bytes: string;
  try {
    bytes = readFileSync(file, 'utf-8');
  } catch (error) {
    return result(
      'cannot-check',
      `${file} exists but could not be read (${
        error instanceof Error ? error.message : String(error)
      })`,
      base,
    );
  }

  const stamp = readDeployedStamp(file);
  const artifactSha = deployedSourceSha(stamp);
  const localBody = artifactBody(bytes).trimEnd();

  // 3. The file against its OWN stamp. No network, no prettier, and the only
  //    check that catches a hand edit that kept the header (Dispatch C): the sha
  //    fast path below would certify such a file as in sync.
  if (stamp == null) {
    return result(
      'locally-modified',
      `${file} has no justin-sdk stamp — it is not a file this tool generated (hand-written, or the header was removed), so its provenance is unknown`,
      {...base, artifactSha},
    );
  }
  if (stamp.contentHash != null && contentHash(localBody) !== stamp.contentHash) {
    return result(
      'locally-modified',
      `${file} does not match its own stamp (stamp claims content ${stamp.contentHash}, the file's bytes hash to ${contentHash(
        localBody,
      )}) — it was edited by hand, or formatted by a different prettier`,
      {...base, artifactSha},
    );
  }

  // 4. The source. Staleness-gated (a reader, not a writer — see the header).
  let assembled;
  try {
    assembled = assembleSelected(selection.modules, {
      promptsDir: options.promptsDir,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return result(
      'cannot-check',
      reason.startsWith(PROMPTS_SOURCE_FAILURE)
        ? `the prompts source could not be read at all (${reason}) — this is NOT "your rules are current"`
        : `the selected rules modules could not be assembled (${reason})`,
      {...base, artifactSha},
    );
  }
  const sourceSha =
    assembled.sourceSha != null ? assembled.sourceSha.slice(0, 12) : null;
  const withSource = {
    ...base,
    artifactSha,
    sourceRefresh: assembled.sourceRefresh,
    sourceSha,
  };
  if (assembled.sourceRefresh === 'failed') {
    // The clone still holds usable bytes — that is precisely the trap (D5).
    return result(
      'cannot-check',
      `the prompts clone at ${assembled.sourceDir} could not be refreshed, so its content may be stale — ` +
        `the artifact is NOT being certified as current. This is "unknown", not "clean"`,
      withSource,
    );
  }

  // 5. Fast path: same source commit ⇒ same content, without running prettier.
  //    A '-dirty' stamp is excluded because content generated from uncommitted
  //    changes is not reproducible from that sha, so the sha proves nothing.
  if (
    artifactSha != null &&
    sourceSha != null &&
    artifactSha === sourceSha &&
    !deployedIsDirty(stamp)
  ) {
    return result(
      'in-sync',
      `rules artifact matches prompts ${sourceSha} (${moduleCount} module${
        moduleCount === 1 ? '' : 's'
      }, content ${stamp.contentHash ?? 'unstamped'})`,
      withSource,
    );
  }

  // 6. The source moved. Only a CONTENT comparison can say whether that changed
  //    any rules — a prompts commit that touched a README must not nag twelve
  //    repos. Formatted with the repo's own prettier, exactly as the writer does,
  //    or the formatter difference would masquerade as drift.
  const canonical = prettierMarkdown(assembled.markdown, {
    binary: findLocalPrettier(dirname(file)),
  }).trimEnd();
  if (canonical === localBody) {
    return result(
      'in-sync',
      `rules artifact content matches prompts ${sourceSha ?? 'unknown'} (${moduleCount} module${
        moduleCount === 1 ? '' : 's'
      }); it was generated from ${artifactSha ?? 'an unknown commit'}, which changed no rules`,
      withSource,
    );
  }
  return result(
    'stale',
    `rules artifact is out of date: generated from prompts ${
      artifactSha ?? 'an unknown commit'
    }, canonical is ${sourceSha ?? 'unknown'} (${moduleCount} module${
      moduleCount === 1 ? '' : 's'
    }) — this session loaded the OLD rules`,
    withSource,
  );
}
