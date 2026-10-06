/**
 * May `thread backfill` rewrite this thread bead's body? Decided from EVIDENCE,
 * never from the label alone (home-base-k0b8n.19, decision D-A).
 *
 * WHY THIS EXISTS. `metadata.source: 'backfill'` records who CREATED a bead, not
 * who owns its body now. A justin-sdk older than 7e637d8 wrote real reports onto
 * backfill-created beads without flipping `source` to 'report', so the label
 * outlived the report. On 2026-09-25 one backfill run (threads commit 1b912a6)
 * took three such threads — th-fs3, th-ttp, th-mq0, each with `reportCount`
 * 1, 2 or 1 and a `reportedAt` stamp — for its own, and replaced their status
 * reports with transcript summaries. The label is a claim; ownership is proven.
 *
 * THE PROOF (D-A). Backfill owns the body only when ALL of these hold:
 *   1. `source === 'backfill'`;
 *   2. there is no report evidence: `reportCount` is the NUMBER 0 and
 *      `reportedAt` is null — both PRESENT, because backfill writes both keys
 *      explicitly on every bead it makes (measured 2026-09-25: bd 1.1.0 keeps a
 *      null metadata value through `bd list --json`, and all 114
 *      `source: backfill` beads in ~/Dev/threads carry both);
 *   3. the description still starts with the marker line backfill writes.
 *
 * FOUR VERDICTS, NOT A BOOLEAN, because callers treat "not ours" differently:
 * backfill relabels a thread that demonstrably reported (D-B) but leaves the
 * label of an unreadable one alone, and neither gets its body touched.
 *
 * RULE 7. Every field is read as absent, valid, or MALFORMED, and malformed never
 * collapses into a neutral value. `readReportCount` (metadata.ts) maps absent and
 * odd values to 0. That is right for numbering the next report and exactly wrong
 * here, because 0 is the value that grants ownership. Unknown routes to "not
 * ours", the cautious verdict.
 *
 * Dependency-free on purpose: `thread start` (D-D) imports this, and it is
 * reached from the `thread capture` child, which creates the bead on a
 * session's first prompt; backfill.ts pulls in the transcript reader.
 */

/** `metadata.source` on a bead `thread backfill` created. */
export const BACKFILL_SOURCE = 'backfill';

/**
 * The start of the first line of every description `thread backfill` writes
 * (`backfillDescription` builds its first line from this constant, so the two
 * cannot drift). A report rewrites the description, so a report-bearing bead
 * does not start with it.
 */
export const BACKFILL_DESCRIPTION_MARKER = 'BACKFILLED FROM THE TRANSCRIPT';

/** `metadata.reportCount`, read without collapsing absent or odd into 0. */
export type ReportCountEvidence =
  | {kind: 'absent'}
  | {kind: 'malformed'; raw: unknown}
  | {kind: 'positive'; value: number}
  | {kind: 'zero'};

/** `metadata.reportedAt`, read without collapsing absent or odd into null. */
export type ReportedAtEvidence =
  | {kind: 'absent'}
  | {kind: 'malformed'; raw: unknown}
  | {kind: 'null'}
  | {kind: 'set'; value: string};

/**
 * A count is a non-negative integer. `null`, a string, a fraction, a negative
 * number, NaN and Infinity are all PRESENT but not a count, so they are
 * malformed (D-A: "present but not a number counts as UNKNOWN").
 */
export function readReportCountEvidence(
  meta: Record<string, unknown>,
): ReportCountEvidence {
  const raw = meta.reportCount;
  if (raw === undefined) return {kind: 'absent'};
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return {kind: 'malformed', raw};
  }
  return raw === 0 ? {kind: 'zero'} : {kind: 'positive', value: raw};
}

/** A stamp is a non-blank string; explicit null is "never reported". */
export function readReportedAtEvidence(
  meta: Record<string, unknown>,
): ReportedAtEvidence {
  const raw = meta.reportedAt;
  if (raw === undefined) return {kind: 'absent'};
  if (raw === null) return {kind: 'null'};
  if (typeof raw === 'string' && raw.trim() !== '') {
    return {kind: 'set', value: raw};
  }
  return {kind: 'malformed', raw};
}

export type BackfillOwnership =
  /** Not labelled backfill: a real session's bead. The caller's real-session path applies. */
  | {kind: 'notBackfill'}
  /** D-A proven: backfill wrote this body and no report has been written onto it. */
  | {kind: 'owned'}
  /** D-B: labelled backfill, but a report WAS written onto it. `evidence` names the fields. */
  | {evidence: string; kind: 'reported'}
  /** Labelled backfill, but ownership cannot be proven. `why` names the failing check. */
  | {kind: 'unproven'; why: string};

/** A malformed value, printed as the JSON it was stored as. */
function shown(raw: unknown): string {
  // Metadata is parsed JSON, so every value it holds serialises; the fallback
  // covers only a value JSON cannot express, which bd could not have stored.
  const text: string | undefined = JSON.stringify(raw);
  return text ?? `(unserialisable ${typeof raw})`;
}

function describeCount(evidence: ReportCountEvidence): string {
  switch (evidence.kind) {
    case 'absent':
      return 'reportCount absent';
    case 'malformed':
      return `reportCount ${shown(evidence.raw)}`;
    case 'positive':
      return `reportCount ${evidence.value}`;
    case 'zero':
      return 'reportCount 0';
  }
}

function describeStamp(evidence: ReportedAtEvidence): string {
  switch (evidence.kind) {
    case 'absent':
      return 'reportedAt absent';
    case 'malformed':
      return `reportedAt ${shown(evidence.raw)}`;
    case 'null':
      return 'reportedAt null';
    case 'set':
      return `reportedAt ${evidence.value}`;
  }
}

/**
 * The D-A verdict for one thread bead. The checks run in this order, and the
 * order matters:
 *
 *   1. Not labelled backfill → `notBackfill`.
 *   2. Either report field MALFORMED → `unproven`. A malformed value is checked
 *      before a positive one, so a thread with a garbage `reportCount` is never
 *      relabelled on the strength of its other field.
 *   3. `reportCount` positive, or `reportedAt` set → `reported` (D-B). Either
 *      one is written only by the report path; backfill and `thread start`
 *      both write 0 and null.
 *   4. Either report field ABSENT → `unproven`. Backfill writes both keys, so a
 *      bead missing one was not written by it.
 *   5. Description without the marker → `unproven`.
 *   6. Otherwise → `owned`.
 */
export function backfillOwnership(thread: {
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}): BackfillOwnership {
  const meta = thread.metadata ?? {};
  if (meta.source !== BACKFILL_SOURCE) return {kind: 'notBackfill'};

  const count = readReportCountEvidence(meta);
  const stamp = readReportedAtEvidence(meta);

  if (count.kind === 'malformed') {
    return {
      kind: 'unproven',
      why: `${describeCount(count)} is not a report count`,
    };
  }
  if (stamp.kind === 'malformed') {
    return {
      kind: 'unproven',
      why: `${describeStamp(stamp)} is neither a timestamp nor null`,
    };
  }
  if (count.kind === 'positive' || stamp.kind === 'set') {
    return {
      evidence: `${describeCount(count)}, ${describeStamp(stamp)}`,
      kind: 'reported',
    };
  }
  if (count.kind === 'absent') {
    return {
      kind: 'unproven',
      why: 'it carries no reportCount, and every bead backfill writes carries reportCount 0',
    };
  }
  if (stamp.kind === 'absent') {
    return {
      kind: 'unproven',
      why: 'it carries no reportedAt, and every bead backfill writes carries reportedAt null',
    };
  }
  const description = thread.description ?? '';
  if (!description.startsWith(BACKFILL_DESCRIPTION_MARKER)) {
    return {
      kind: 'unproven',
      why: `its description does not start with "${BACKFILL_DESCRIPTION_MARKER}", so something other than backfill wrote it`,
    };
  }
  return {kind: 'owned'};
}
