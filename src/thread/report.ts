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

function readPayloadText(
  options: ReportOptions,
): {text: string} | {error: string} {
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
 * One long linear pipeline on purpose: the ORDER is the design (see the file
 * header), and splitting it into helpers would hide the one property that
 * matters — that the archive happens before bd and that every bd failure lands
 * in the same NOT RECORDED path.
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

  // --- 4. read the existing thread and its open asks ----------------------
  const ctx: BdContext = bdContext(env);
  const existing = await findThreadBySession(ctx, sessionId);
  const renderWithoutBead = (): string =>
    renderReport({
      askIds: payload.asks.map(() => null),
      facts,
      payload,
      threadId: null,
    });
  if (!existing.ok) {
    return notRecorded({
      archivePath,
      env,
      failure: existing.failure,
      rendered: renderWithoutBead(),
      report,
    });
  }

  const existingThread = existing.value;
  let openAskIds: string[] = [];
  if (existingThread != null) {
    const asks = await listOpenAsks(ctx, existingThread.id);
    if (!asks.ok) {
      // A failed read is NOT "no open asks". Proceeding would skip D4 entirely
      // and silently drop everything Justin was asked last time.
      return notRecorded({
        archivePath,
        env,
        failure: asks.failure,
        rendered: renderWithoutBead(),
        report,
      });
    }
    openAskIds = asks.value.map((ask) => ask.id);
  }

  // --- 5. D4 ---------------------------------------------------------------
  const coverage = checkPriorAskCoverage(openAskIds, payload.priorAsks);
  if (!coverage.ok) {
    console.error(
      'thread report: REFUSED — these open asks are not dispositioned in priorAsks (D4). Nothing was written.',
    );
    for (const id of coverage.missing) console.error(`  ${id}`);
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

  // --- 6. write ------------------------------------------------------------
  const reportCount = readReportCount(existingThread?.metadata) + 1;
  const description = renderThreadDescription({facts, payload});
  const provisionalMetadata = buildThreadMetadata({
    askIds: [],
    facts,
    payload,
    reportCount,
  });

  // The notes field carries the RENDERED report (D10), and the rendering wants
  // the ask ids inline — which do not exist until the asks are created, which
  // needs the thread id. So the bead is written twice: once to exist, once with
  // the finished report in its notes.
  let threadId: string;
  if (existingThread == null) {
    const created = await createThread(ctx, {
      description,
      metadata: provisionalMetadata,
      notes: '(rendering — see the next write)',
      title: payload.title,
    });
    if (!created.ok) {
      return notRecorded({
        archivePath,
        env,
        failure: created.failure,
        rendered: renderWithoutBead(),
        report,
      });
    }
    threadId = created.value;
  } else {
    threadId = existingThread.id;
    const updated = await updateThread(ctx, threadId, {
      description,
      metadata: provisionalMetadata,
      notes: '(rendering — see the next write)',
      title: payload.title,
    });
    if (!updated.ok) {
      return notRecorded({
        archivePath,
        env,
        failure: updated.failure,
        rendered: renderWithoutBead(),
        report,
      });
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
      return notRecorded({
        archivePath,
        env,
        failure: created.failure,
        rendered: renderReport({askIds, facts, payload, threadId}),
        report,
      });
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
      return notRecorded({
        archivePath,
        env,
        failure: closed.failure,
        rendered: renderReport({askIds, facts, payload, threadId}),
        report,
      });
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
    buildThreadMetadata({askIds, facts, payload, reportCount}),
  );
  if (!notesWritten.ok) {
    return notRecorded({
      archivePath,
      env,
      failure: notesWritten.failure,
      rendered,
      report,
    });
  }

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
