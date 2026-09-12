/**
 * `justin-sdk thread report` — the write path (home-base-p1uj D1, D4, D5, D10).
 *
 * THE ORDER IS THE DESIGN:
 *
 *   1. validate the payload            invalid → exit 2, nothing written
 *   2. measure the facts               (facts.ts; failures are named, never faked)
 *   3. ARCHIVE the payload to disk     BEFORE any bd command touches anything
 *   4. read the session's thread + its open asks
 *   5. ENFORCE D4                      an undispositioned open ask → exit 2
 *   6. upsert the thread bead, create the ask beads, close the dispositioned ones
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
 * (invalid payload, or an open ask left undispositioned).
 */

import {readFileSync} from 'fs';

import {archiveReport, spoolReport, type ArchivedReport} from './archive';
import {
  bdContext,
  closeAsk,
  createAsk,
  createThread,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
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
import {
  renderAskDescription,
  renderReport,
  renderThreadDescription,
} from './render';
import {THREAD_SCHEMA_VERSION, validateThreadReport} from './schema';

import type {EnvLike} from './paths';
import type {ThreadFacts} from './facts';
import type {ThreadPriorAsk, ThreadReportPayload} from './schema';

/** Dispositions that close the ask. `carried` leaves it open by definition. */
const CLOSING_DISPOSITIONS = new Set(['answered', 'decided', 'irrelevant']);

/** bd title length before it stops being a title and starts being a paragraph. */
const ASK_TITLE_CAP = 110;

export type PriorAskCoverage = {ok: true} | {ok: false; missing: string[]};

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
): PriorAskCoverage {
  const dispositioned = new Set(priorAsks.map((prior) => prior.id));
  const missing = openAskIds.filter((id) => !dispositioned.has(id));
  return missing.length === 0 ? {ok: true} : {missing, ok: false};
}

function firstLine(text: string, cap: number): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

export interface ReportOptions {
  cwd?: string;
  env?: EnvLike;
  /** Path to the payload JSON; mutually exclusive with `stdin`. */
  file?: string | null;
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
    }
  | {status: 'bdFailed'; failure: BdFailure; rendered: string}
  | {status: 'refused'; missing: string[]}
  | {
      status: 'superseded';
      existingReportedAt: string;
      existingReportCount: number;
      threadId: string;
    };

export interface BdWriteInput {
  ctx: BdContext;
  facts: ThreadFacts;
  payload: ThreadReportPayload;
  sessionId: string;
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

  const renderWithoutBead = (): string =>
    renderReport({
      askIds: payload.asks.map(() => null),
      facts,
      payload,
      threadId: null,
    });

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
  const openAskIds = openAsks.map((ask) => ask.id);

  // --- 5. D4 ---------------------------------------------------------------
  const coverage = checkPriorAskCoverage(openAskIds, payload.priorAsks);
  if (!coverage.ok) return {missing: coverage.missing, status: 'refused'};

  // --- 6. write ------------------------------------------------------------
  const reportCount = readReportCount(existingThread?.metadata) + 1;
  const description = renderThreadDescription({facts, payload});

  // Asks this report leaves open behind it: the `carried` ones. Everything else
  // in priorAsks is about to be closed, so it is not part of what still waits
  // for Justin. `blocking` is read from the ask bead's OWN metadata rather than
  // assumed — an unreadable block is false, which under-reports urgency rather
  // than inventing it.
  const carriedIds = new Set(
    payload.priorAsks
      .filter((prior) => !CLOSING_DISPOSITIONS.has(prior.disposition))
      .map((prior) => prior.id),
  );
  const carriedOpenAsks = openAsks
    .filter((ask) => carriedIds.has(ask.id))
    .map((ask) => ({
      blocking:
        (ask.metadata as {blocking?: unknown} | undefined)?.blocking === true,
      id: ask.id,
    }));

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
  const provisionalNotes = renderWithoutBead();

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

  const askIds: (string | null)[] = [];
  for (const [index, ask] of payload.asks.entries()) {
    const created = await createAsk(ctx, threadId, {
      blocking: ask.blocking,
      description: renderAskDescription(ask, threadId),
      metadata: buildAskMetadata({
        askIndex: index,
        blocking: ask.blocking,
        defaultAction: ask.default,
        kind: ask.kind,
        optionCount: ask.options.length,
        reportedAt: facts.reportedAt,
        sessionId,
        threadId,
      }),
      title: firstLine(ask.text, ASK_TITLE_CAP),
    });
    if (!created.ok) {
      askIds.push(null);
      return {
        failure: created.failure,
        rendered: renderReport({askIds, facts, payload, threadId}),
        status: 'bdFailed',
      };
    }
    askIds.push(created.value);
  }

  const closedAsks: string[] = [];
  for (const prior of payload.priorAsks) {
    if (!CLOSING_DISPOSITIONS.has(prior.disposition)) continue;
    if (!openAskIds.includes(prior.id)) continue;
    const closed = await closeAsk(
      ctx,
      prior.id,
      `${prior.disposition}: ${prior.detail}`,
    );
    if (!closed.ok) {
      return {
        failure: closed.failure,
        rendered: renderReport({askIds, facts, payload, threadId}),
        status: 'bdFailed',
      };
    }
    closedAsks.push(prior.id);
  }

  const rendered = renderReport({askIds, facts, payload, threadId});
  const notesWritten = await finalizeThread(
    ctx,
    threadId,
    rendered,
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
  const outcome = await writeReportToBd({ctx, facts, payload, sessionId});

  if (outcome.status === 'refused') {
    console.error(
      'thread report: REFUSED — these open asks are not dispositioned in priorAsks (D4). Nothing was written.',
    );
    for (const id of outcome.missing) console.error(`  ${id}`);
    console.error('');
    console.error('Add one entry per id to priorAsks, then re-run:');
    console.error(
      '  {"id": "<id>", "disposition": "carried|answered|decided|irrelevant", "detail": "<quote the answer / name the default / say why>"}',
    );
    console.error(
      archivePath == null
        ? '  (the payload could not be archived)'
        : `  the payload is archived at ${archivePath}`,
    );
    return 2;
  }

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

  const {askIds, closedAsks, rendered, reportCount, threadId} = outcome;

  // --- 7. print ------------------------------------------------------------
  console.log(rendered);
  console.error('');
  console.error(`THREAD RECORDED: ${threadId} (report #${reportCount})`);
  console.error(
    `  asks created: ${askIds.length === 0 ? 'none' : askIds.join(', ')}`,
  );
  console.error(
    `  prior asks closed: ${closedAsks.length === 0 ? 'none' : closedAsks.join(', ')}`,
  );
  console.error(
    archivePath == null ? '  archive: FAILED' : `  archive: ${archivePath}`,
  );
  console.error(`  Justin answers with: justin-sdk thread answer ${threadId}`);
  return 0;
}
