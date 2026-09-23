/**
 * rules-drift — the ONE staleness verdict for the committed per-repo rules
 * artifact (home-base-si46, t6a0.21 D4/D5/D9).
 *
 * Two consumers, one function, deliberately: `session-start` (a notice in the
 * systemMessage) and the `critical-rules-setup` doctor check.
 * Written twice they would drift into disagreeing about whether a repo's rules
 * are current — the session would say one thing and doctor the other, and only
 * one of them could be right. So this module answers the question and neither
 * consumer computes anything; they only choose how to say it.
 *
 * SIX STATES, NONE COLLAPSED (critical rule 5 — failure is not empty):
 *   not-enrolled      the component is not installed here. NOT a rules problem.
 *   in-sync           checked, and the artifact is the canonical one.
 *   missing           enrolled, but there is no artifact at all.
 *   locally-modified  the file's bytes disagree with its OWN stamp — a hand
 *                     edit, or a different prettier. Distinct because the
 *                     stamp still claims the canonical hash, so plain
 *                     `rules-update` would report "already up to date" and
 *                     change nothing (the Dispatch-C discovery).
 *   stale             the artifact no longer matches what this project would be
 *                     given today — because the prompts source moved, OR because
 *                     the project itself changed and now resolves a different
 *                     set of modules (it gained `expo`). Both are the same fact
 *                     to a reader: the file in your context is not the right one.
 *   cannot-check      the source could not be read/refreshed, or the config could
 *                     not be read. NEVER reported as in-sync (D5).
 *
 * ORDER IS COST AND CERTAINTY, IN THAT ORDER. Everything decidable from local
 * bytes is decided before anything that can touch the network, because this runs
 * at EVERY session start:
 *   1. enrolment      (a stat, then one small JSON read)
 *   2. file exists    (a stat) -> missing, definitively, without a refresh
 *   3. bytes vs stamp (a hash)  -> locally-modified, definitively, no network
 *   4. source         (staleness-gated refresh + assemble) -> cannot-check
 *   5. header fast path -> in-sync without running prettier
 *   6. content        (prettier + byte compare) -> stale | in-sync
 * Step 3 sits BEFORE step 5 on purpose: a stamp-preserving hand edit passes the
 * header fast path, which is exactly how it would go unnoticed.
 *
 * THE MODULE SET IS RESOLVED FRESH, EVERY TIME (epic home-base-dchjw D2). This
 * used to assemble from a list frozen in the repo's config at enrolment, which
 * made two whole classes of drift invisible: a module added to the prompts
 * registry never reached an enrolled repo, and a repo that became an Expo app
 * after enrolment never picked up the React Native rules. Both now move the
 * module fingerprint in the artifact header, and F3 makes the fast path check it.
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
 *
 * IT USED TO LIVE IN THE PLUGIN LIB, under an import-closure rule that dchjw.8
 * retired with the plugin itself (home-base-qjyj): the marketplace published
 * `src/plugin` as the whole package, so an import escaping that subtree did not
 * exist on disk at runtime and killed the hook at import time — invisibly,
 * which is what plugin 0.5.0 shipped. Nothing constrains this module's imports
 * now. What still holds is D14: ONE definition, never a forked copy, imported
 * from here by session-start, doctor and the tests alike.
 */

import {existsSync, readFileSync} from 'fs';
import {dirname} from 'path';

import {findLocalPrettier} from '../local-fs';
import {assemble, PROMPTS_SOURCE_FAILURE, type SourceRefresh} from '../prime';
import {readEnrollment} from './rules-enrollment';
import {
  artifactBody,
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  moduleFingerprint,
  prettierMarkdown,
  projectRulesFilePath,
  readDeployedStamp,
  RULES_DIFF_CMD,
  RULES_UPDATE_CMD,
  SDK_BUNX,
} from './rules-file';

export type RulesDriftStatus =
  | 'not-enrolled'
  | 'in-sync'
  | 'missing'
  | 'locally-modified'
  | 'stale'
  | 'cannot-check';

export interface RulesDriftResult {
  /** 12-char prompts sha the artifact was generated from, when stamped. */
  artifactSha: string | null;
  /** Absolute artifact path (known for every status except not-enrolled). */
  file: string | null;
  /**
   * What was found, as a statement of fact with no advice in it — the advice is
   * `rulesDriftAdvice`, so both consumers word it identically.
   */
  message: string;
  /**
   * How many rules modules this project resolves to RIGHT NOW. null whenever the
   * source was never assembled (not-enrolled, missing, locally-modified,
   * cannot-check) — "not measured" is not a count of zero.
   */
  moduleCount: number | null;
  /** How the source was obtained — null when we never got that far. */
  sourceRefresh: SourceRefresh | null;
  /** 12-char prompts-clone HEAD at check time, when the source was reached. */
  sourceSha: string | null;
  status: RulesDriftStatus;
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
 *
 * THE SPELLING IS LOCAL-FIRST, AND THAT IS LOAD-BEARING (home-base-r47v F4).
 * `RULES_DIFF_CMD`/`RULES_UPDATE_CMD` are `bun run justin-sdk …`
 * rather than `bunx github:…`, because every state below except not-enrolled is
 * reached only INSIDE a repo enrolled in critical-rules — which by construction
 * has the SDK pinned as a devDep at a version carrying these commands, resolved
 * locally in ~73ms with no network (measured, home-base-j2n7). The github: form
 * would be worse than slow: bunx keys its github cache on the SPEC STRING, not
 * the resolved commit, so an untagged spec can silently serve the commit it first
 * fetched — a staleness command answering from a stale binary.
 *
 * not-enrolled is the one exception and keeps `github:`: that repo has no pin to
 * resolve, which is exactly what `add critical-rules` is about to give it.
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
      // github:, not the local spelling — see the header: an unenrolled repo may
      // have no SDK devDep for `bunx @justinhaaheim/…` to resolve.
      return `run \`${SDK_BUNX} add critical-rules\` to enroll this repo`;
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

function check(
  projectRoot: string,
  options: RulesDriftOptions,
): RulesDriftResult {
  // 1. Enrolment — the ONE reader (uniformity: enrolment cannot mean two
  //    things). A config we cannot parse is cannot-check, never not-enrolled (F2).
  const enrollment = readEnrollment(projectRoot);
  if (!enrollment.ok) {
    return enrollment.status === 'not-enrolled'
      ? result('not-enrolled', enrollment.message)
      : result('cannot-check', enrollment.message, {
          file: projectRulesFilePath(projectRoot),
        });
  }
  const file = projectRulesFilePath(projectRoot);
  const base = {file};

  // 2. Existence, before any network work: "enrolled but there is no artifact"
  //    is already the complete, actionable fact. No module count is reported
  //    here — nothing has been assembled, so there is nothing to count.
  if (!existsSync(file)) {
    return result(
      'missing',
      `no rules artifact at ${file}, but this repo is enrolled in critical-rules — this session loaded NO justin-sdk rules from the repo`,
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
  if (
    stamp.contentHash != null &&
    contentHash(localBody) !== stamp.contentHash
  ) {
    return result(
      'locally-modified',
      `${file} does not match its own stamp (stamp claims content ${stamp.contentHash}, the file's bytes hash to ${contentHash(
        localBody,
      )}) — it was edited by hand, or formatted by a different prettier`,
      {...base, artifactSha},
    );
  }

  // 4. The source, assembled for THIS project as it is right now — registry plus
  //    predicates, never a frozen list (D2). Staleness-gated (a reader, not a
  //    writer — see the header).
  let assembled;
  try {
    assembled = assemble(
      {partition: 'full', promptsDir: options.promptsDir},
      projectRoot,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return result(
      'cannot-check',
      reason.startsWith(PROMPTS_SOURCE_FAILURE)
        ? `the prompts source could not be read at all (${reason}) — this is NOT "your rules are current"`
        : `the rules modules could not be assembled (${reason})`,
      {...base, artifactSha},
    );
  }
  const sourceSha =
    assembled.sourceCommit != null
      ? assembled.sourceCommit.sha.slice(0, 12)
      : null;
  const moduleCount = assembled.names.length;
  const fingerprint = moduleFingerprint(assembled.names);
  const withSource = {
    ...base,
    artifactSha,
    moduleCount,
    sourceRefresh: assembled.sourceRefresh,
    sourceSha,
  };
  // 4b. ZERO MODULES IS A BROKEN SOURCE, NOT A DIFFERENCE (dchjw.15).
  //     The WRITER already refuses here — "resolved to NO modules for this
  //     project — refusing to write an empty rules artifact" — and the reader
  //     has to agree with it, or the pair gives a session an instruction that
  //     cannot be carried out: an empty resolution makes the artifact differ
  //     from the source, so this reported `stale` and advised `rules-update`,
  //     which then refused. Reporting it as cannot-check says the true thing
  //     (nothing was measured) and sends the reader at the source instead.
  if (moduleCount === 0) {
    return result(
      'cannot-check',
      `the rules index at ${assembled.sourceDir} resolved to NO modules for this project, so there is nothing to compare the artifact against — ` +
        `this is a broken or misconfigured source, NOT an out-of-date artifact. \`${RULES_UPDATE_CMD}\` would refuse for the same reason`,
      withSource,
    );
  }

  if (assembled.sourceRefresh === 'failed') {
    // The clone still holds usable bytes — that is precisely the trap (D5).
    return result(
      'cannot-check',
      `the prompts clone at ${assembled.sourceDir} could not be refreshed, so its content may be stale — ` +
        `the artifact is NOT being certified as current. This is "unknown", not "clean"`,
      withSource,
    );
  }

  // 5. Fast path: same source commit AND the same resolved module set ⇒ same
  //    content, without running prettier.
  //
  //    THE MODULE FINGERPRINT IS HALF OF THIS TEST, NOT A DETAIL (F3). The sha
  //    alone answers "did the source move?", which used to be treated as the
  //    whole question because the module list was frozen in config and could not
  //    move on its own. It can now: a repo that gains `expo` resolves the React
  //    Native modules from the very same prompts commit. Certifying it on the sha
  //    alone would report in-sync to a session that is missing rules.
  //
  //    An artifact stamped before dchjw.3 has no fingerprint at all, which reads
  //    as "not stated" and takes the slow path — the honest outcome, since
  //    nothing in that header says which modules produced it.
  //
  //    A '-dirty' stamp is excluded because content generated from uncommitted
  //    changes is not reproducible from that sha, so the sha proves nothing.
  if (
    artifactSha != null &&
    sourceSha != null &&
    artifactSha === sourceSha &&
    stamp.moduleFingerprint === fingerprint &&
    !deployedIsDirty(stamp)
  ) {
    return result(
      'in-sync',
      `rules artifact matches prompts ${sourceSha} and this project's ${moduleCount} resolved module${
        moduleCount === 1 ? '' : 's'
      } (fingerprint ${fingerprint}, content ${stamp.contentHash ?? 'unstamped'})`,
      withSource,
    );
  }

  // 6. The source moved, or this project's module set did. Only a CONTENT
  //    comparison can say whether that changed any rules — a prompts commit that
  //    touched a README must not nag twelve repos, and neither must a dependency
  //    change that gates in no new module.
  //    Formatted with the repo's own prettier, exactly as the writer does,
  //    or the formatter difference would masquerade as drift.
  //    Same binary AND same config as the writer — the config only follows the
  //    binary if prettier is handed the artifact's real path (t6a0.21.1).
  //    --stdin-filepath means this reader still writes nothing.
  const formatted = prettierMarkdown(assembled.markdown, {
    binary: findLocalPrettier(dirname(file)),
    filePath: file,
  });
  if (formatted.status === 'failed') {
    return result(
      'cannot-check',
      `the canonical rules could not be formatted (${formatted.reason}), so the artifact cannot be ` +
        `compared against them — this is "unknown", not "in sync"`,
      withSource,
    );
  }
  const canonical = formatted.markdown.trimEnd();
  if (canonical === localBody) {
    return result(
      'in-sync',
      `rules artifact content matches prompts ${sourceSha ?? 'unknown'} (${moduleCount} module${
        moduleCount === 1 ? '' : 's'
      }); it was generated from ${artifactSha ?? 'an unknown commit'}, which changed no rules`,
      withSource,
    );
  }
  // Name the reason the caller can act on. A module-set change is a different
  // story from a prompts change — "your project changed, your rules did not".
  const why =
    stamp.moduleFingerprint != null && stamp.moduleFingerprint !== fingerprint
      ? `this project now resolves a DIFFERENT set of ${moduleCount} module${
          moduleCount === 1 ? '' : 's'
        } (fingerprint ${stamp.moduleFingerprint} → ${fingerprint})`
      : `canonical is prompts ${sourceSha ?? 'unknown'} (${moduleCount} module${
          moduleCount === 1 ? '' : 's'
        })`;
  return result(
    'stale',
    `rules artifact is out of date: generated from prompts ${
      artifactSha ?? 'an unknown commit'
    }, ${why} — this session loaded the OLD rules`,
    withSource,
  );
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
