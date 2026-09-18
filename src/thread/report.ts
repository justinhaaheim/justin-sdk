/**
 * `justin-sdk thread report` — the write path (home-base-p1uj D1, D4, D5, D10).
 *
 * THE ORDER IS THE DESIGN:
 *
 *   1. validate the payload            invalid → exit 2, nothing written
 *   2. measure the facts               (facts.ts; failures are named, never faked)
 *   3. ARCHIVE the payload to disk     BEFORE any bd command touches anything
 *   4. read the session's thread + its open asks
 *   5. PLAN THE ASK LIFECYCLE (D24)    what closes, what supersedes what
 *   6. upsert the thread bead, create the ask beads, close what the plan says
 *   7. print the rendered report
 *
 * Step 3 before step 4 is the whole of rule 6 here: the payload is the
 * expensive artefact, bd is the fragile dependency, and the report must survive
 * a locked database, a sandbox refusal and a missing workspace alike.
 *
 * WHEN bd FAILS, NOTHING PRETENDS IT DIDN'T. The rendered report still prints
 * (Justin reads it on a phone; it is the actual deliverable), the payload is
 * SPOOLED for `thread board` to drain, a NOT RECORDED banner names the exact
 * failing command, and the exit code is 1. There is no path through this file
 * where a failed write produces a quiet zero.
 *
 * EXIT CODES: 0 recorded · 1 NOT RECORDED (bd/archive failure) · 2 refused
 * (invalid payload, a continuesFrom that names no thread, or a `supersedes`
 * that names an ask this report cannot close).
 */

import {readFileSync} from 'fs';

import {sdkRun, SDK_RUN} from '../sdk-invocation';
import {archiveReport, spoolReport, type ArchivedReport} from './archive';
import {commitThreadsRepo, describeCommit} from './commit';
import {
  bdContext,
  EXPORT_UNSTAGED_WARNING,
  closeAsk,
  createAsk,
  createThread,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
  mergeMetadata,
  setIssueDescription,
  showIssue,
  updateThread,
  finalizeThread,
  type BdContext,
  type BdFailure,
  type BdIssue,
} from './bd';
import {
  buildAskMetadata,
  buildThreadMetadata,
  readReportCount,
} from './metadata';
import {collectThreadFacts} from './facts';
import {resolveReportWrapUpAt, resolveThreadConfig} from './config';
import {ansiFromReportText} from './render-ansi';
import {shouldStyle} from '../repo-status/pretty';
import {
  numberingFieldsOf,
  renderAskDescription,
  renderThreadDescription,
  restateAsk,
  type CarriedAsk,
} from './render';
import {
  buildReportModel,
  type BuildReportModelOptions,
  type SupersedeSource,
} from './report-model';
import {renderMarkdown} from './render-markdown';
import {
  AUTO_CLOSE_DISPOSITION,
  EXPIRED_DISPOSITION,
  THREAD_SCHEMA_VERSION,
  validateThreadReport,
} from './schema';

import type {EnvLike} from './paths';
import type {ThreadFacts} from './facts';
import type {ThreadPriorAsk, ThreadReportPayload} from './schema';

/** bd title length before it stops being a title and starts being a paragraph. */
const ASK_TITLE_CAP = 110;

export type PriorAskCoverage = {ok: true} | {ok: false; missing: string[]};

/** One ask this report closes, and the reason it will carry (D24). */
export interface PlannedClose {
  detail: string;
  disposition: string;
  id: string;
}

/**
 * The default an ask bead RECORDED, or null when it recorded none.
 *
 * Null is load-bearing (rule 6): it is the difference between "Claude proceeded
 * on the default this ask stated" and "this ask never stated one", and the two
 * close the bead with different words. An empty string counts as none — a
 * default of "" is not a default anybody could have proceeded on.
 */
export function defaultActionOf(ask: BdIssue | undefined): string | null {
  const meta = (ask?.metadata ?? {}) as {defaultAction?: unknown};
  return typeof meta.defaultAction === 'string' &&
    meta.defaultAction.trim() !== ''
    ? meta.defaultAction
    : null;
}

/**
 * D4: every open ask must be dispositioned by this report.
 *
 * Pure, and separated out, because it is the one rule in this file that has to
 * be provable by a test rather than by reading. The sampling that motivated it
 * (2026-09-12) found three of five replies answering zero pending questions —
 * the asks simply evaporated. Refusing the report is what stops that.
 */
export function checkPriorAskCoverage(
  openAskIds: readonly string[],
  priorAsks: readonly ThreadPriorAsk[],
  keepOpenAskIds: readonly string[] = [],
): PriorAskCoverage {
  const dispositioned = new Set([
    ...priorAsks.map((prior) => prior.id),
    ...keepOpenAskIds,
  ]);
  const missing = openAskIds.filter((id) => !dispositioned.has(id));
  return missing.length === 0 ? {ok: true} : {missing, ok: false};
}

/**
 * The PREDECESSOR thread this payload continues, or null (D21).
 *
 * A session that names its OWN thread is not continuing anything: those asks are
 * already the session's open asks, and reading the id as a second source would
 * list, carry and re-parent every one of them twice.
 */
export function continuationOf(
  continuesFrom: string | null | undefined,
  ownThreadId: string | null,
): string | null {
  if (continuesFrom == null) return null;
  const id = continuesFrom.trim();
  if (id === '') return null;
  if (ownThreadId != null && id === ownThreadId) return null;
  return id;
}

/** The line a continued thread's description carries back to its successor. */
export function continuedByLine(threadId: string): string {
  return `Continued by ${threadId}`;
}

function firstLine(text: string, cap: number): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

export interface ReportOptions {
  /** Overrides componentConfig.thread.autoCommit. Tests pin it. */
  autoCommit?: boolean;
  cwd?: string;
  env?: EnvLike;
  /** Path to the payload JSON; mutually exclusive with `stdin`. */
  file?: string | null;
  /** Print everything (D18). The default prints the compact report. */
  full?: boolean;
  now?: Date;
  sessionId?: string | null;
  stdin?: boolean;
}

/**
 * Where the `--file` / `--stdin` combination is checked (home-base-p1uj.2).
 *
 * It is checked HERE rather than in a yargs `.check()` because a throwing
 * `.check()` reaches the CLI-wide `.fail()` handler, which prints a stack trace
 * and exits 1. A usage mistake deserves one line and the "refused, nothing
 * written" code, which is what every other refusal in this file returns.
 */
function readPayloadText(
  options: ReportOptions,
): {text: string} | {error: string} {
  const hasFile = options.file != null && options.file !== '';
  if (hasFile && options.stdin === true) {
    return {
      error:
        'pass exactly one of --file <path> or --stdin, not both — I cannot tell which payload you meant',
    };
  }
  if (options.stdin === true) {
    try {
      return {text: readFileSync(0, 'utf8')};
    } catch (error) {
      return {error: `could not read stdin: ${String(error)}`};
    }
  }
  if (options.file == null || options.file === '') {
    return {error: 'pass --file <path> or --stdin'};
  }
  try {
    return {text: readFileSync(options.file, 'utf8')};
  } catch (error) {
    return {error: `could not read ${options.file}: ${String(error)}`};
  }
}

/** Everything printed when bd did not take the report (D5). */
function notRecorded(args: {
  archivePath: string | null;
  env: EnvLike;
  failure: BdFailure | string;
  report: ArchivedReport;
  rendered: string;
}): number {
  const reason =
    typeof args.failure === 'string'
      ? args.failure
      : describeBdFailure(args.failure);
  console.log(args.rendered);
  const spool = spoolReport(args.report, reason, args.env);
  console.error('');
  console.error('🚨🚨🚨 NOT RECORDED 🚨🚨🚨');
  console.error(
    `The report above did NOT reach a bead. Failing step: ${reason}`,
  );
  console.error(
    args.archivePath == null
      ? '  archive: FAILED — the payload is not on disk either'
      : `  archive: ${args.archivePath}`,
  );
  console.error(
    spool.ok
      ? `  spooled: ${spool.path} (thread board will drain it)`
      : `  spool: FAILED — ${spool.error} (${spool.path})`,
  );
  return 1;
}

/**
 * What the bd half of a report did, as a tagged outcome.
 *
 * Four members, not three, because `refused` and `bdFailed` need opposite
 * responses: a refusal means "fix the payload, nothing was written" (exit 2,
 * nothing to spool), a bd failure means "the payload is fine, the database was
 * not" (exit 1, spool it). `superseded` is a third distinct fact — see below.
 * Every member that has a report to show carries the RENDERED text, because the
 * report prints on every path including the failing ones.
 */
export type BdWriteOutcome =
  | {
      status: 'written';
      askIds: (string | null)[];
      closedAsks: string[];
      rendered: string;
      reportCount: number;
      threadId: string;
      /**
       * Things that went differently from what the payload said, on a write that
       * otherwise succeeded: a prior-ask id that named nothing open, an ask the
       * v2 bridge left open. Empty means "nothing to say" — the caller prints
       * every entry, so a silent substitution is not reachable from here.
       */
      warnings: string[];
    }
  | {status: 'bdFailed'; failure: BdFailure; rendered: string}
  | {status: 'refused'; missing: string[]}
  /**
   * An ask's `supersedes` names something this report cannot close (D24).
   *
   * REFUSED rather than ignored, and for the same reason `refusedContinuation`
   * is: a typo'd id would leave the old ask OPEN and auto-closed as "decided"
   * while the new one printed "supersedes th-x.2, now closed" underneath it —
   * a report that says, in writing, that it handled a question it did not.
   */
  | {status: 'refusedSupersede'; problems: string[]}
  /**
   * `continuesFrom` names something that is not a thread bead (D21). REFUSED
   * rather than ignored: `listOpenAsks` on an id with no children returns an
   * empty list, so a typo'd predecessor would otherwise read as "that thread had
   * no open asks" — a fabricated all-clear over exactly the asks this feature
   * exists to carry.
   */
  | {status: 'refusedContinuation'; continuesFrom: string; detail: string}
  | {
      status: 'superseded';
      existingReportedAt: string;
      existingReportCount: number;
      threadId: string;
    };

export interface BdWriteInput {
  ctx: BdContext;
  facts: ThreadFacts;
  /**
   * Ask ids a v2 → v3 MIGRATION is keeping open (D24), from
   * `validateThreadReport`. Empty for every payload written against the current
   * schema: v3 has no way to say "leave this open", and this is the one-release
   * bridge for v2's `carried`. See `migrateV2Payload`.
   */
  keepOpenAskIds?: readonly string[];
  payload: ThreadReportPayload;
  sessionId: string;
  /**
   * How the report should LOOK (D14, D18, D19). Absent takes the defaults:
   * compact, emoji header, no wrap-up threshold.
   */
  render?: {emojiHeader?: boolean; full?: boolean; wrapUpAt?: number | null};
  /**
   * Refuse to write a payload OLDER than the thread's current state.
   *
   * Off for a live report, which is the newest thing there is by construction.
   * ON for the spool drain, where it is load-bearing: sandbox denial is
   * per-session, so report #3 can spool while report #4 from the same session
   * lands fine minutes later. D1 rewrites the bead IN PLACE, so draining #3
   * afterwards would overwrite #4's title, notes and metadata with older ones —
   * a silent regression of the bead to a state Justin already moved past, and
   * in the reassuring direction (an old report shows old open-ask counts).
   */
  supersedeGuard?: boolean;
}

/**
 * Steps 4-6 of the pipeline: read the thread, enforce D4, write everything.
 *
 * EXTRACTED SO THE SPOOL DRAIN SHARES IT (home-base-p1uj.2). `thread board`
 * drains spooled payloads by replaying exactly this sequence, and a second copy
 * of it would drift from this one the first time either was touched — the two
 * would then disagree about D4, about the two-write ordering, or about what
 * counts as a carried ask, and only one of them would be under test.
 *
 * The steps BEFORE this (validate, measure, archive) stay in `runThreadReport`:
 * a spooled payload has already been validated, measured and archived once, and
 * re-measuring facts at drain time would attach today's git state to a report
 * written yesterday.
 */
export async function writeReportToBd(
  input: BdWriteInput,
): Promise<BdWriteOutcome> {
  const {ctx, facts, payload, sessionId} = input;
  // OPTIONAL SINCE v3 (D24): a payload that dispositions nothing is the normal
  // case now, because the tool closes what Justin did not answer.
  const priorAsks = payload.priorAsks ?? [];
  const keepOpenAskIds = input.keepOpenAskIds ?? [];
  // Asks this report leaves open behind it. Since v3 the ONLY way an ask stays
  // open is the migration bridge (D24): every v3 disposition closes, so this set
  // is empty for anything written against the current schema.
  const carriedIds = new Set(keepOpenAskIds);

  // Ask id → its restated text, for the prior asks this report closes (F1,
  // home-base-p1uj.18). FILLED LATER, once the ask beads have been read, and
  // read at render time through this closure — which is the point: a render on
  // an early failure path has not read any asks yet, so it finds the map empty
  // and prints bare ids, which is the honest rendering of "we could not look".
  const priorAskRestated = new Map<string, string>();
  // The asks this report closes and why (D24), and where each superseded ask
  // came from. Both are FILLED LATER and read at render time through this
  // closure, for the same reason `priorAskRestated` is: a render on an early
  // failure path has planned nothing yet, and an empty plan is the honest
  // rendering of "nothing has been closed".
  const closePlan: PlannedClose[] = [];
  const supersedeSources = new Map<string, SupersedeSource>();

  // ONE renderer for every path through this function (D14). `full` is what
  // the caller asked to be PRINTED; the notes field always stores the full
  // rendering, which is why `notesOf` pins it rather than passing it through.
  const render = (
    extra: Omit<BuildReportModelOptions, 'facts' | 'payload'>,
  ): string =>
    renderMarkdown(
      buildReportModel({
        ...extra,
        closed: closePlan,
        emojiHeader: input.render?.emojiHeader,
        facts,
        full: extra.full ?? input.render?.full,
        payload,
        priorAskRestated,
        supersedeSources,
        wrapUpAt: input.render?.wrapUpAt,
      }),
    );
  const renderWithoutBead = (): string =>
    render({askIds: payload.asks.map(() => null), threadId: null});

  // --- 4. read the existing thread and its open asks ----------------------
  const existing = await findThreadBySession(ctx, sessionId);
  if (!existing.ok) {
    return {
      failure: existing.failure,
      rendered: renderWithoutBead(),
      status: 'bdFailed',
    };
  }
  const existingThread = existing.value;

  if (input.supersedeGuard === true && existingThread != null) {
    const meta = (existingThread.metadata ?? {}) as {reportedAt?: unknown};
    const existingReportedAt =
      typeof meta.reportedAt === 'string' ? meta.reportedAt : null;
    // A MEASURED comparison or nothing: if the bead carries no readable
    // reportedAt we cannot show this payload is newer, so we do not claim it is
    // — we apply it, which is the drain's job, rather than silently discarding
    // a report on the strength of an unknown.
    if (existingReportedAt != null && existingReportedAt > facts.reportedAt) {
      return {
        existingReportCount: readReportCount(existingThread.metadata),
        existingReportedAt,
        status: 'superseded',
        threadId: existingThread.id,
      };
    }
  }

  let openAsks: BdIssue[] = [];
  if (existingThread != null) {
    const asks = await listOpenAsks(ctx, existingThread.id);
    if (!asks.ok) {
      // A failed read is NOT "no open asks". Proceeding would skip D4 entirely
      // and silently drop everything Justin was asked last time.
      return {
        failure: asks.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
    openAsks = asks.value;
  }
  // --- 4b. ORPHANS FROM A HALF-WRITTEN PREVIOUS ATTEMPT (F1) --------------
  //
  // A bd failure AFTER the first successful createAsk leaves an ask that THIS
  // payload created. D4 then refuses every replay of that payload forever: the
  // orphan cannot appear in priorAsks, because it did not exist when the
  // payload was written. The spool file never drains — for exactly the failure
  // D5 names as the accepted risk, a Dolt lock mid-write — and the obvious
  // human workaround (disposition it "carried") makes the retry create a SECOND
  // bead for the same question.
  //
  // An orphan is identified by the two stamps together: its createdAt equals
  // the THREAD bead's last reportedAt (so it was made by the previous attempt
  // on this thread), and its id is absent from the thread's metadata.askIds.
  // askIds is written empty by the provisional write and filled by the
  // finalise, so "not in askIds" is precisely "created by an attempt whose
  // finalise never ran". The thread's own reportedAt is the key, not the
  // payload's: a live retry regenerates facts.reportedAt and would match
  // nothing. This gives metadata.askIds its first real reader.
  const threadMeta = (existingThread?.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const lastReportedAt =
    typeof threadMeta.reportedAt === 'string' ? threadMeta.reportedAt : null;
  const recordedAskIds = new Set(
    Array.isArray(threadMeta.askIds)
      ? threadMeta.askIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const orphans =
    lastReportedAt == null
      ? []
      : openAsks.filter((ask) => {
          const meta = (ask.metadata ?? {}) as Record<string, unknown>;
          return (
            meta.createdAt === lastReportedAt && !recordedAskIds.has(ask.id)
          );
        });
  const orphanIds = new Set(orphans.map((ask) => ask.id));
  for (const orphan of orphans) {
    const closed = await closeAsk(
      ctx,
      orphan.id,
      'incomplete report attempt — this ask was recreated by the retry',
    );
    if (!closed.ok) {
      return {
        failure: closed.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
  }
  // Orphans are excluded from BOTH the coverage set and the carried set: they
  // are about to be recreated, so demanding a disposition for them would be
  // demanding one for a bead the retry itself is replacing.
  openAsks = openAsks.filter((ask) => !orphanIds.has(ask.id));

  // --- 4c. THE PREDECESSOR THREAD'S OPEN ASKS (D21) -----------------------
  //
  // A new Claude Code session that continues an arc gets a NEW thread bead keyed
  // on its own session id, so the asks the PREVIOUS session left open belong to
  // a thread this session's `listOpenAsks` never looks at. Until this block they
  // were invisible to D4 and silently skipped by the closing loop below — the
  // cross-session loss the epic exists to stop, landing precisely at the moment
  // an arc changes hands.
  const continuesFrom = continuationOf(
    payload.continuesFrom,
    existingThread?.id ?? null,
  );
  let continuedThread: BdIssue | null = null;
  let continuedOpenAsks: BdIssue[] = [];
  if (continuesFrom != null) {
    const found = await showIssue(ctx, continuesFrom);
    if (!found.ok) {
      return {
        failure: found.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
    continuedThread = found.value;
    if (continuedThread == null) {
      return {
        continuesFrom,
        detail: 'no bead with that id exists in the threads repo',
        status: 'refusedContinuation',
      };
    }
    // The type is checked only when bd REPORTS one. A present-and-wrong type is
    // a fact (an ask id, a typo that hit another bead); an absent one is an
    // unknown, and refusing a valid report over a field bd chose not to print
    // would be the worse error.
    if (
      continuedThread.issue_type != null &&
      continuedThread.issue_type !== 'thread'
    ) {
      return {
        continuesFrom,
        detail: `that bead is a ${continuedThread.issue_type}, not a thread — continuesFrom takes the THREAD bead id (see ${SDK_RUN} thread board)`,
        status: 'refusedContinuation',
      };
    }
    const asks = await listOpenAsks(ctx, continuesFrom);
    if (!asks.ok) {
      // Same reasoning as the session's own asks: a failed read is NOT "none".
      return {
        failure: asks.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
    continuedOpenAsks = asks.value;
  }

  // THE D4 COVERAGE SET IS THE UNION (D21). Deduped by id, because an ask must
  // never be demanded — or closed — twice.
  const ownOpenAskIds = openAsks.map((ask) => ask.id);
  const openAskIds = [
    ...ownOpenAskIds,
    ...continuedOpenAsks
      .map((ask) => ask.id)
      .filter((id) => !ownOpenAskIds.includes(id)),
  ];

  // --- 5. THE ASK LIFECYCLE (D24, replacing D4's refusal) -------------------
  //
  // D4 REFUSED a report that left an open ask undispositioned. That was the
  // right rule when a disposition was the only thing standing between an ask and
  // oblivion, and it is the wrong one now: Justin, 2026-09-15 — "If the human did
  // not answer them and the agent went ahead with the default, the questions need
  // to be closed… questions from the previous status report will be closed
  // automatically unless they are explicitly kept open." So every open ask is
  // closed here unless this payload restates it, and the refusal is gone.
  //
  // `checkPriorAskCoverage` survives (it is exported and tested) but nothing in
  // this path calls it any more — the coverage it enforced is now unconditional.
  const askById = new Map<string, BdIssue>();
  for (const ask of openAsks) askById.set(ask.id, ask);
  for (const ask of continuedOpenAsks) {
    if (!askById.has(ask.id)) askById.set(ask.id, ask);
  }
  const ownIds = new Set(ownOpenAskIds);
  /** The predecessor thread an ask came from, or null when it is ours. */
  const fromThreadOf = (id: string): string | null =>
    ownIds.has(id) ? null : continuesFrom;

  // Which new ask restates which old one. Built before anything is written, so a
  // bad `supersedes` costs nothing.
  const supersededBy = new Map<string, number>();
  const supersedeProblems: string[] = [];
  payload.asks.forEach((ask, index) => {
    const target = ask.supersedes == null ? '' : ask.supersedes.trim();
    if (target === '') return;
    if (!openAskIds.includes(target)) {
      supersedeProblems.push(
        `asks[${index}] supersedes ${target}, which is not an open ask on this thread${
          continuesFrom == null ? '' : ` or on ${continuesFrom}`
        }`,
      );
      return;
    }
    const already = supersededBy.get(target);
    if (already != null) {
      supersedeProblems.push(
        `asks[${index}] and asks[${already}] both supersede ${target} — an ask is restated once, not twice`,
      );
      return;
    }
    supersededBy.set(target, index);
  });
  if (supersedeProblems.length > 0) {
    return {problems: supersedeProblems, status: 'refusedSupersede'};
  }

  for (const oldId of supersededBy.keys()) {
    supersedeSources.set(oldId, {
      fromReport: numberingFieldsOf(askById.get(oldId)?.metadata).reportCount,
      fromThread: fromThreadOf(oldId),
    });
  }

  const warnings: string[] = [];
  for (const id of keepOpenAskIds) {
    if (!openAskIds.includes(id)) continue;
    warnings.push(
      `${id} was marked "carried" by a v2 payload, so it stays OPEN. v3 has no "carried": restate it as a new ask with "supersedes": "${id}".`,
    );
  }

  // THE CLOSE PLAN, decided before anything is written so every rendering of
  // this report — including the ones on the failure paths — says the same thing
  // about what happened to each ask.
  const dispositioned = new Map(priorAsks.map((prior) => [prior.id, prior]));
  for (const prior of priorAsks) {
    if (openAskIds.includes(prior.id)) continue;
    warnings.push(
      `priorAsks names ${prior.id} (${prior.disposition}), which is not an open ask on this thread — nothing was closed for it.`,
    );
  }
  for (const id of openAskIds) {
    if (carriedIds.has(id)) continue;
    // Superseded asks are planned below, once their replacement has an id.
    if (supersededBy.has(id)) continue;
    const prior = dispositioned.get(id);
    if (prior != null) {
      closePlan.push({
        detail: prior.detail,
        disposition: prior.disposition,
        id,
      });
      continue;
    }
    // THE AUTO-CLOSE (D24). The default comes off the ask BEAD, not out of this
    // payload: the bead is what Justin was shown, so it is what "I took the
    // default" has to mean. A bead with no readable default is `expired`, not
    // `decided` — see EXPIRED_DISPOSITION.
    const fallback = defaultActionOf(askById.get(id));
    closePlan.push(
      fallback == null
        ? {
            detail:
              'no default was recorded on this ask, and this report did not restate it',
            disposition: EXPIRED_DISPOSITION,
            id,
          }
        : {detail: fallback, disposition: AUTO_CLOSE_DISPOSITION, id},
    );
  }

  // --- 6. write ------------------------------------------------------------
  const reportCount = readReportCount(existingThread?.metadata) + 1;
  const description = renderThreadDescription({facts, payload});

  // Every ask bead we hold, own and continued, keyed by id (F1). The asks this
  // report CLOSES are still open at read time — they are closed further down —
  // so they are all in here, and each closed line can name itself instead of
  // printing a bare `th-9kq.2` that Justin cannot place.
  for (const ask of [...openAsks, ...continuedOpenAsks]) {
    priorAskRestated.set(
      ask.id,
      restateAsk(ask.description ?? ask.title ?? ''),
    );
  }

  const carriedAskOf = (
    ask: BdIssue,
    fromThread: string | null,
  ): CarriedAsk => {
    const meta = (ask.metadata ?? {}) as Record<string, unknown>;
    // askIndex and reportCount are what put this ask in the same position in
    // the report and in the `thread answer` walk (F12).
    const numbering = numberingFieldsOf(meta);
    return {
      askIndex: numbering.askIndex,
      fromReport: numbering.reportCount,
      fromThread,
      id: ask.id,
      priority: numbering.priority,
      // The bead's own description is the full ask — form tag, context,
      // lettered options, default — so F4 reuses it rather than
      // reconstructing a question the payload no longer carries.
      restated: restateAsk(ask.description ?? ask.title ?? ''),
    };
  };
  // The predecessor's carried asks are numbered in the SAME sequence as this
  // thread's own (D21): they are what Justin still owes an answer on, and a
  // separate "inherited" list would be the second numbering that "1 yes, 2 b"
  // cannot survive.
  const carriedOpenAsks = [
    ...openAsks
      .filter((ask) => carriedIds.has(ask.id))
      .map((ask) => carriedAskOf(ask, null)),
    ...continuedOpenAsks
      .filter((ask) => carriedIds.has(ask.id))
      .map((ask) => carriedAskOf(ask, continuesFrom)),
  ];

  const provisionalMetadata = buildThreadMetadata({
    askIds: [],
    carriedOpenAsks,
    facts,
    payload,
    reportCount,
  });

  // The notes field carries the RENDERED report (D10), and the rendering wants
  // the ask ids inline — which do not exist until the asks are created, which
  // needs the thread id. So the bead is written twice: once to exist, once with
  // the finished report in its notes.
  //
  // The FIRST write already carries a complete report, with the ask ids shown
  // as "(NOT RECORDED)". A placeholder would be cheaper, but if the run then
  // died between the two writes the bead would be left saying "(rendering)" —
  // a report-shaped hole in the one field D10 promises is always readable.
  // An id-less report is degraded; a placeholder is a lie.
  // On the UPDATE path the thread id is already known, so the provisional write
  // must not claim there is no bead (F1). It used to call renderWithoutBead(),
  // which ends "Answer: (no thread bead — this report was NOT recorded)" — on a
  // bead that IS the thread. A finalise failure on report 2 or later then left
  // exactly that sentence in the one field D10 promises is always readable.
  const provisionalNotes =
    existingThread == null
      ? // `carried` belongs here even on the create path: a session's FIRST
        // report is exactly when a continued thread's asks arrive (D21), and a
        // provisional note that omitted them would leave the one field D10
        // promises is always readable silently missing what Justin still owes.
        render({
          askIds: payload.asks.map(() => null),
          carried: carriedOpenAsks,
          full: true,
          threadId: null,
        })
      : render({
          askIds: payload.asks.map(() => null),
          carried: carriedOpenAsks,
          full: true,
          missingAskIdLabel: '(ask ids pending)',
          reportCount,
          threadId: existingThread.id,
        });

  let threadId: string;
  if (existingThread == null) {
    const created = await createThread(ctx, {
      description,
      metadata: provisionalMetadata,
      notes: provisionalNotes,
      title: payload.title,
    });
    if (!created.ok) {
      return {
        failure: created.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
    threadId = created.value;
  } else {
    threadId = existingThread.id;
    const updated = await updateThread(ctx, threadId, {
      description,
      metadata: provisionalMetadata,
      notes: provisionalNotes,
      title: payload.title,
    });
    if (!updated.ok) {
      return {
        failure: updated.failure,
        rendered: renderWithoutBead(),
        status: 'bdFailed',
      };
    }
  }

  // --- 6b. THE CONTINUATION ITSELF (D21) ----------------------------------
  //
  // The carried asks MOVE to this thread rather than being copied: an ask is one
  // question, and two beads for it would be answered once and chased forever.
  // `bd update --parent` re-parents in place and keeps the id (measured — see
  // `reparentIssue`), so `th-eru.10` stays `th-eru.10` and every report, comment
  // and message that already named it still points at the live bead.
  //
  // WHY THE PREDECESSOR IS NOT CLOSED: `thread done` is Justin's (D10). The link
  // goes both ways instead — `continuedBy` in its metadata, one line in its
  // description — so the board can fold it under its successor and anyone
  // landing on the old bead is told where the arc went.
  if (continuesFrom != null) {
    // RE-PARENTING IS RETRACTED (D24, retracting D21/p1uj.16). A continued
    // thread's open asks used to MOVE onto the new thread with `bd update
    // --parent`; they no longer move, because they no longer stay open — they
    // are closed here and restated as new asks under this thread when they are
    // still live. `reparentIssue` stays in bd.ts for one release, unused by this
    // path, so that asks already re-parented by v2 keep working and so the
    // measurement behind it is not lost; it goes when the v2 bridge does.
    const linked = await mergeMetadata(ctx, continuesFrom, {
      continuedBy: threadId,
    });
    if (!linked.ok) {
      return {
        failure: linked.failure,
        rendered: render({
          askIds: [],
          carried: carriedOpenAsks,
          reportCount,
          threadId,
        }),
        status: 'bdFailed',
      };
    }
    // Idempotent by inspection, because every later report from this session
    // runs this block again: the line is appended only when it is not already
    // there, so a thread continued once carries one line, not one per report.
    const line = continuedByLine(threadId);
    const previous = continuedThread?.description ?? '';
    if (!previous.includes(line)) {
      const noted = await setIssueDescription(
        ctx,
        continuesFrom,
        previous === '' ? line : `${previous}\n${line}`,
      );
      if (!noted.ok) {
        return {
          failure: noted.failure,
          rendered: render({
            askIds: [],
            carried: carriedOpenAsks,
            reportCount,
            threadId,
          }),
          status: 'bdFailed',
        };
      }
    }
  }

  const askIds: (string | null)[] = [];
  for (const [index, ask] of payload.asks.entries()) {
    const created = await createAsk(ctx, threadId, {
      description: renderAskDescription(ask, threadId),
      metadata: buildAskMetadata({
        askIndex: index,
        defaultAction: ask.default,
        kind: ask.kind,
        optionCount: ask.options.length,
        priority: ask.priority,
        reportCount,
        reportedAt: facts.reportedAt,
        sessionId,
        supersedes:
          ask.supersedes == null || ask.supersedes.trim() === ''
            ? null
            : {
                ...(supersedeSources.get(ask.supersedes.trim()) ?? {
                  fromReport: null,
                  fromThread: null,
                }),
                id: ask.supersedes.trim(),
              },
        threadId,
      }),
      priority: ask.priority,
      title: firstLine(ask.text, ASK_TITLE_CAP),
    });
    if (!created.ok) {
      askIds.push(null);
      return {
        failure: created.failure,
        rendered: render({
          askIds,
          carried: carriedOpenAsks,
          reportCount,
          threadId,
        }),
        status: 'bdFailed',
      };
    }
    askIds.push(created.value);
  }

  // The supersede closes could only be planned once their replacements existed:
  // "superseded" is not a fact about the old ask until the new one has an id.
  for (const [oldId, index] of supersededBy) {
    const newId = askIds[index];
    closePlan.push({
      detail:
        newId == null
          ? 'restated in this report, whose ask bead was NOT RECORDED'
          : `restated as ${newId}`,
      disposition: 'superseded',
      id: oldId,
    });
  }

  const closedAsks: string[] = [];
  for (const prior of closePlan) {
    const closed = await closeAsk(
      ctx,
      prior.id,
      `${prior.disposition}: ${prior.detail}`,
    );
    if (!closed.ok) {
      return {
        failure: closed.failure,
        rendered: render({
          askIds,
          carried: carriedOpenAsks,
          reportCount,
          threadId,
        }),
        status: 'bdFailed',
      };
    }
    closedAsks.push(prior.id);
  }

  const rendered = render({
    askIds,
    carried: carriedOpenAsks,
    reportCount,
    threadId,
  });
  // THE BEAD ALWAYS CARRIES THE FULL RENDERING (D10, D14). `bd show` on the
  // thread has to be a complete status report even when the printed one was
  // compact — the compaction is a choice about a terminal, not about the record.
  const notesWritten = await finalizeThread(
    ctx,
    threadId,
    render({
      askIds,
      carried: carriedOpenAsks,
      full: true,
      reportCount,
      threadId,
    }),
    // The metadata is rebuilt, not reused: the first write could only record
    // `askIds: []`, because the asks did not exist yet.
    buildThreadMetadata({
      askIds,
      carriedOpenAsks,
      facts,
      payload,
      reportCount,
    }),
  );
  if (!notesWritten.ok) {
    return {failure: notesWritten.failure, rendered, status: 'bdFailed'};
  }

  return {
    askIds,
    closedAsks,
    rendered,
    reportCount,
    status: 'written',
    threadId,
    warnings,
  };
}

/**
 * The pipeline's ORDER is the design (see the file header): validate, measure,
 * ARCHIVE, then bd. Only the bd half is extracted (`writeReportToBd`, shared
 * with the drain) — the archive-before-bd ordering, which is the rule-6
 * property this file exists to guarantee, stays here where it is visible.
 */
export async function runThreadReport(
  options: ReportOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // --- 1. payload ---------------------------------------------------------
  const source = readPayloadText(options);
  if ('error' in source) {
    console.error(`thread report: ${source.error}`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text);
  } catch (error) {
    console.error(
      `thread report: the payload is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  const validation = validateThreadReport(parsed);
  if (validation.status === 'invalid') {
    console.error(
      'thread report: the payload does not validate. Nothing was written.',
    );
    for (const issue of validation.issues) console.error(`  ${issue}`);
    return 2;
  }
  const payload: ThreadReportPayload = validation.payload;
  if (validation.migratedFrom != null) {
    // SAID OUT LOUD, every time (D15). A migrated payload is not the payload
    // that was written: its `deviations` is empty because nobody was asked, not
    // because there were none, and its `nextStep` says `continue` because the
    // schema had to say something. Both are the reassuring direction, so the
    // one place that knows the substitution happened is the place that has to
    // name it.
    console.error(
      `thread report: ⚠️ this payload declared schemaVersion ${validation.migratedFrom} and was migrated to ${THREAD_SCHEMA_VERSION}. Write v${THREAD_SCHEMA_VERSION} next time: run ${SDK_RUN} thread prepare for the current skeleton. What was substituted:`,
    );
    if (validation.migratedFrom < 2) {
      console.error(
        '  · blocking true → P0, false → P3; nextStep → "continue"; deviations → empty (NOT "there were none" — nothing supplied them)',
      );
    }
    for (const note of validation.migrationNotes) console.error(`  · ${note}`);
  }

  // --- 2. facts -----------------------------------------------------------
  const facts: ThreadFacts = collectThreadFacts({
    cwd,
    env,
    now: options.now,
    sessionId: options.sessionId,
  });
  if (facts.sessionId == null) {
    console.error(
      'thread report: no session id (CLAUDE_CODE_SESSION_ID unset and --session not passed). A thread bead is KEYED on it, so nothing was written.',
    );
    return 2;
  }
  const sessionId = facts.sessionId;

  // --- 3. archive, before bd ---------------------------------------------
  const report: ArchivedReport = {
    facts,
    payload,
    reportedAt: facts.reportedAt,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId,
  };
  const archive = archiveReport(report, env);
  if (!archive.ok) {
    console.error(
      `thread report: ⚠️ could not archive the payload to ${archive.path} (${archive.error}). Continuing — but this report has no on-disk copy.`,
    );
  }
  const archivePath = archive.ok ? archive.path : null;

  // --- 4-6. the bd half, shared with the spool drain ----------------------
  const ctx: BdContext = bdContext(env);
  // HOW IT LOOKS, resolved once: the emoji header is a knob (D19), and the
  // wrap-up threshold beside the token count comes from usage-check's own
  // resolver rather than a second reading of the same file.
  const threadConfig = resolveThreadConfig({cwd, env});
  const renderConfig = {
    emojiHeader: threadConfig.emojiHeader,
    full: options.full === true,
    wrapUpAt: resolveReportWrapUpAt(threadConfig.projectRoot),
  };

  const outcome = await writeReportToBd({
    ctx,
    facts,
    keepOpenAskIds: validation.keepOpenAskIds,
    payload,
    render: renderConfig,
    sessionId,
  });

  if (outcome.status === 'refused') {
    console.error(
      'thread report: REFUSED — these open asks are not dispositioned in priorAsks. Nothing was written.',
    );
    for (const id of outcome.missing) console.error(`  ${id}`);
    console.error('');
    console.error('Add one entry per id to priorAsks, then re-run:');
    console.error(
      '  {"id": "<id>", "disposition": "answered|irrelevant", "detail": "<quote him / say why it stopped applying>"}',
    );
    console.error(
      archivePath == null
        ? '  (the payload could not be archived)'
        : `  the payload is archived at ${archivePath}`,
    );
    return 2;
  }

  if (outcome.status === 'refusedSupersede') {
    console.error(
      'thread report: REFUSED — an ask supersedes something this report cannot close (D24). Nothing was written.',
    );
    for (const problem of outcome.problems) console.error(`  ${problem}`);
    console.error('');
    console.error(
      '  "supersedes" takes the id of an ask that is OPEN on this session’s thread, or on the thread named by "continuesFrom".',
    );
    console.error(`  See them with: ${sdkRun('thread prepare')}`);
    console.error(
      archivePath == null
        ? '  (the payload could not be archived)'
        : `  the payload is archived at ${archivePath}`,
    );
    return 2;
  }

  if (outcome.status === 'refusedContinuation') {
    console.error(
      `thread report: REFUSED — continuesFrom names ${outcome.continuesFrom}, but ${outcome.detail}. Nothing was written.`,
    );
    console.error(
      `  Find the thread you mean with: ${sdkRun('thread board --recent')}`,
    );
    console.error(
      archivePath == null
        ? '  (the payload could not be archived)'
        : `  the payload is archived at ${archivePath}`,
    );
    return 2;
  }

  // One line, on every path that wrote something (home-base-p1uj.10).
  if (ctx.exportUnstaged) console.error(EXPORT_UNSTAGED_WARNING);

  if (outcome.status === 'bdFailed') {
    return notRecorded({
      archivePath,
      env,
      failure: outcome.failure,
      rendered: outcome.rendered,
      report,
    });
  }

  if (outcome.status === 'superseded') {
    // Unreachable from here: `supersedeGuard` is off for a live report, which
    // is the newest thing there is. Handled rather than cast away so that
    // turning the guard on later cannot silently fall through to "recorded".
    console.error(
      `thread report: the thread ${outcome.threadId} already carries a newer report (#${outcome.existingReportCount}, ${outcome.existingReportedAt}). Nothing was written.`,
    );
    return 2;
  }

  const {askIds, closedAsks, rendered, reportCount, threadId, warnings} =
    outcome;

  // --- 7. print ------------------------------------------------------------
  //
  // ANSI ON A TTY, PLAIN MARKDOWN OTHERWISE, and the discriminator does exactly
  // the right thing for both readers: Claude runs this through a captured pipe
  // and gets the markdown it has to paste verbatim (escape codes would arrive in
  // Justin's message as literal `\u001b[1m`), while Justin running it by hand
  // gets the bold, underlined, priority-coloured version. `shouldStyle` is the
  // same NO_COLOR/FORCE_COLOR-aware check repo-status uses.
  console.log(ansiFromReportText(rendered, {color: shouldStyle()}));
  console.error('');
  console.error(`THREAD RECORDED: ${threadId} (report #${reportCount})`);
  console.error(
    `  asks created: ${askIds.length === 0 ? 'none' : askIds.join(', ')}`,
  );
  console.error(
    `  prior asks closed: ${closedAsks.length === 0 ? 'none' : closedAsks.join(', ')}`,
  );
  for (const warning of warnings) console.error(`  ⚠️ ${warning}`);
  console.error(
    archivePath == null ? '  archive: FAILED' : `  archive: ${archivePath}`,
  );
  console.error(
    `  Justin answers with: ${sdkRun(`thread answer ${threadId}`)}`,
  );

  // The commit is part of finishing the write (p1uj.11, retiring D13): threads
  // have their own repo now, so nothing else is racing this index.
  const commitLine = describeCommit(
    commitThreadsRepo(`thread ${threadId}: report #${reportCount}`, {
      autoCommit: options.autoCommit,
      dir: ctx.repoDir,
      env,
      exportUnstaged: ctx.exportUnstaged,
    }),
    'the threads repo',
  );
  if (commitLine != null) console.error(commitLine);
  return 0;
}
