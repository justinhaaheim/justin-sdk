#!/usr/bin/env bun
/**
 * restore-thread-records — put thread beads back to what they said at an
 * earlier threads-repo commit (home-base-k0b8n.19, design D-E).
 *
 * WHY IT EXISTS. `thread backfill` at threads commit 1b912a6 replaced the
 * title, description, notes and metadata of three threads that held real
 * status reports (th-fs3, th-ttp, th-mq0). The reports survive in git. D-E makes
 * the restore a committed, reviewed script rather than hand-typed bd commands,
 * because a restore that goes wrong is a second erasure.
 *
 * WHAT IT DOES, per id:
 *
 *   1. Reads the record at `--from` and at `--damaged-at` out of git
 *      (`git show <rev>:.beads/issues.jsonl`), and the record NOW through the
 *      bd adapter — the live Dolt row, which is what a write would overwrite.
 *   2. Builds the write: title, description, notes, and every metadata key the
 *      `--from` record had, at their `--from` values. ONE DELIBERATE DEVIATION
 *      (D-E): when `--from`'s reportCount is > 0, `source` is written as
 *      'report', not the snapshot's 'backfill' — that label is what got these
 *      records erased. The deviation is printed wherever it applies.
 *   3. REFUSES the id when any field it would write differs between
 *      `--damaged-at` and now. Such a difference is a later edit, and restoring
 *      over it would be a second erasure. Fields it does not write (status,
 *      metadata keys only the live record has) are printed, never compared.
 *   4. Prints, field by field, what `--from` says, what now says and what the
 *      write changes, plus the inputs `thread show --full` decides on
 *      (`isRenderedReport(notes)` and backfill ownership — `showsNotesAsReport`
 *      — then `metadata.reportCount`).
 *
 * DRY RUN BY DEFAULT. `--apply` writes through `updateThreadBody` — the adapter
 * call that rewrites title, description, notes and metadata and leaves status
 * alone — re-reads each record to verify it, and commits the threads repo with
 * `commitThreadsRepo`, which is how every thread command commits (and pushes).
 * ALL OR NOTHING: if any id is refused or unreadable, nothing is written.
 *
 * Never `bd delete`, never raw Dolt: src/thread/bd.ts is the only way in.
 */

import type {Argv} from 'yargs';

import {spawnSync} from 'child_process';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  HEADER_COLUMN,
  type OutputStyle,
  outputStyle,
  paint,
  PLAIN_STYLE,
  sectionHeader,
  wrapHanging,
} from '../src/cli-style';
import {readReportCountEvidence} from '../src/thread/backfill-ownership';
import {
  bdContext,
  type BdIssue,
  type BdResult,
  describeBdFailure,
  EXPORT_UNSTAGED_WARNING,
  showIssue,
  type ThreadBeadFields,
  updateThreadBody,
} from '../src/thread/bd';
import {
  BEADS_JSONL,
  commitThreadsRepo,
  describeCommit,
} from '../src/thread/commit';
import {type EnvLike, threadsRepoDirResolution} from '../src/thread/paths';
import {isRenderedReport} from '../src/thread/report-lines';
import {
  NO_REPORT_GLANCE,
  recordedReportCount,
  renderShowHeader,
  renderStoredNotes,
  showsNotesAsReport,
} from '../src/thread/show';

/** What the report path writes as `source` (buildThreadMetadata, metadata.ts). */
export const REPORT_SOURCE = 'report';

/** The body fields a restore writes, in the order it prints them. */
const BODY_FIELDS = ['title', 'description', 'notes'] as const;

/** Where a value column starts, under a field heading at DETAIL_COLUMN. */
const VALUE_COLUMN = DETAIL_COLUMN + 3;

/** How much of one value the report shows. The write always sends all of it. */
const VALUE_CAP = 110;

/** How many lines of a description or notes the report shows. */
const PREVIEW_LINES = 3;

// ---------------------------------------------------------------------------
// Git reads
// ---------------------------------------------------------------------------

type Outcome<T> = {message: string; ok: false} | {ok: true; value: T};

type GitRun =
  | {detail: string; ok: false; status: number | null}
  | {ok: true; stdout: string};

function git(dir: string, args: string[], env: EnvLike): GitRun {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    // The threads JSONL is ~3.4 MB and grows; spawnSync's default is 1 MB,
    // and a truncated read would parse as a store MISSING the later records.
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error != null) {
    return {detail: result.error.message, ok: false, status: null};
  }
  if (result.status !== 0) {
    const detail =
      `${(result.stderr ?? '').trim()} ${(result.stdout ?? '').trim()}`.trim();
    return {
      detail: detail === '' ? `git exited ${String(result.status)}` : detail,
      ok: false,
      status: result.status,
    };
  }
  return {ok: true, stdout: result.stdout ?? ''};
}

/** A resolved commit, with what the report prints about it. */
export interface CommitRef {
  sha: string;
  short: string;
  subject: string;
}

function resolveCommit(
  dir: string,
  rev: string,
  env: EnvLike,
): Outcome<CommitRef> {
  const parsed = git(
    dir,
    ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
    env,
  );
  const sha = parsed.ok ? parsed.stdout.trim() : '';
  if (!parsed.ok || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return {
      message: `${JSON.stringify(rev)} is not a commit in ${dir} (${parsed.ok ? `git printed ${JSON.stringify(sha)}` : parsed.detail})`,
      ok: false,
    };
  }
  const described = git(dir, ['log', '-1', '--format=%h%x09%s', sha], env);
  if (!described.ok) {
    return {
      message: `could not read commit ${sha} (${described.detail})`,
      ok: false,
    };
  }
  const line = described.stdout.trim();
  const tab = line.indexOf('\t');
  return {
    ok: true,
    value: {
      sha,
      short: tab === -1 ? line : line.slice(0, tab),
      subject: tab === -1 ? '' : line.slice(tab + 1),
    },
  };
}

/**
 * The damaging commit when `--damaged-at` is not given: the ONE child of
 * `--from` on the ancestry path to HEAD. Zero or several children is a refusal
 * that asks for `--damaged-at`, never a guess.
 */
function deriveDamagedAt(
  dir: string,
  from: CommitRef,
  env: EnvLike,
): Outcome<CommitRef> {
  const listed = git(
    dir,
    ['rev-list', '--ancestry-path', '--parents', `${from.sha}..HEAD`],
    env,
  );
  if (!listed.ok) {
    return {
      message: `could not list the commits after --from ${from.short} (${listed.detail})`,
      ok: false,
    };
  }
  const children: string[] = [];
  for (const line of listed.stdout.split('\n')) {
    const [commit, ...parents] = line.trim().split(' ');
    if (commit != null && commit !== '' && parents.includes(from.sha)) {
      children.push(commit);
    }
  }
  const only = children[0];
  if (children.length !== 1 || only == null) {
    return {
      message: `--from ${from.short} has ${children.length} children on the path to HEAD${children.length > 0 ? ` (${children.map((sha) => sha.slice(0, 7)).join(', ')})` : ''}, so the damaging commit cannot be derived; pass --damaged-at`,
      ok: false,
    };
  }
  return resolveCommit(dir, only, env);
}

/** `git merge-base --is-ancestor`: exit 0 yes, exit 1 no, anything else unknown. */
function isAncestor(
  dir: string,
  ancestor: CommitRef,
  descendant: CommitRef,
  env: EnvLike,
): Outcome<boolean> {
  const result = git(
    dir,
    ['merge-base', '--is-ancestor', ancestor.sha, descendant.sha],
    env,
  );
  if (result.ok) return {ok: true, value: true};
  if (result.status === 1) return {ok: true, value: false};
  return {
    message: `could not tell whether ${ancestor.short} is an ancestor of ${descendant.short} (${result.detail})`,
    ok: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Every record in the JSONL at one commit, by id. A list, so a duplicate shows. */
export type RecordsAt = Map<string, Record<string, unknown>[]>;

/**
 * The beads JSONL at `commit`, parsed. ANY unparseable line fails the whole
 * read: a line this script cannot read could be the very record it was asked
 * to restore, and "not found" would then be a claim nobody measured (rule 7).
 */
function readRecordsAt(
  dir: string,
  commit: CommitRef,
  env: EnvLike,
): Outcome<RecordsAt> {
  const shown = git(dir, ['show', `${commit.sha}:${BEADS_JSONL}`], env);
  if (!shown.ok) {
    return {
      message: `could not read ${BEADS_JSONL} at ${commit.short} (${shown.detail})`,
      ok: false,
    };
  }
  const records: RecordsAt = new Map();
  const bad: number[] = [];
  shown.stdout.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad.push(index + 1);
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') {
      bad.push(index + 1);
      return;
    }
    records.set(parsed.id, [...(records.get(parsed.id) ?? []), parsed]);
  });
  if (bad.length > 0) {
    return {
      message: `${BEADS_JSONL} at ${commit.short} has ${bad.length} line(s) that are not a bead record (line ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}); one of them could be a record this run needs, so it reads none`,
      ok: false,
    };
  }
  return {ok: true, value: records};
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * One field's value in one record. ABSENT is not null: bd merges metadata, so
 * a key the record lacks and a key holding null are different records.
 */
export type Slot = {kind: 'absent'} | {kind: 'value'; value: unknown};

const ABSENT: Slot = {kind: 'absent'};

function slot(record: Record<string, unknown>, key: string): Slot {
  return Object.hasOwn(record, key)
    ? {kind: 'value', value: record[key]}
    : ABSENT;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  }
  return value;
}

/** Deep equality by canonical JSON: key order is not a difference. */
export function sameSlot(a: Slot, b: Slot): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return (
    JSON.stringify(sortedKeys(a.value)) === JSON.stringify(sortedKeys(b.value))
  );
}

function showSlot(value: Slot): string {
  if (value.kind === 'absent') return '(absent)';
  const json = JSON.stringify(value.value) ?? String(value.value);
  const oneLine = json.replace(/\s+/g, ' ');
  return oneLine.length > VALUE_CAP
    ? `${oneLine.slice(0, VALUE_CAP)}… (${json.length} chars)`
    : oneLine;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One field the write sends, at every point this script compares. */
export interface FieldRow {
  damaged: Slot;
  from: Slot;
  name: string;
  now: Slot;
  target: Slot;
}

/** What `thread show --full` would decide for one record, and on what. */
export interface ShowDecision {
  /**
   * `showsNotesAsReport` — whether `show` prints the notes as a stored report.
   * Differs from `rendered` for a backfill-owned body that quotes a report
   * (home-base-k0b8n.20): the quote looks rendered, and is not a report.
   */
  asReport: boolean;
  /** The first line `show --full` prints for the notes. */
  firstLine: string;
  /** The `session … · report #N · reported …` line of the header. */
  header: string;
  /** `isRenderedReport(notes)`; null when the notes are empty (no report). */
  rendered: boolean | null;
  /** `metadata.reportCount` as `show` reads it (null = absent or not a number). */
  reportCount: number | null;
}

export type Verdict =
  | {kind: 'already-restored'}
  | {kind: 'refused'; reasons: string[]}
  | {kind: 'restore'};

export interface PlanDetail {
  bodyRows: FieldRow[];
  /** The sentence printed for the `source` deviation, or null when none applies. */
  deviation: string | null;
  /** Metadata keys the live record has and `--from` lacks: sent nowhere. */
  leftAlone: string[];
  metaRows: FieldRow[];
  showAfter: ShowDecision;
  showNow: ShowDecision;
  status: {from: Slot; now: Slot};
  target: ThreadBeadFields;
}

export interface IdPlan {
  /** Null when the id was refused before a write could be built. */
  detail: PlanDetail | null;
  id: string;
  verdict: Verdict;
}

function showDecision(
  id: string,
  record: Record<string, unknown>,
  metadata: Record<string, unknown>,
): ShowDecision {
  const notes = typeof record.notes === 'string' ? record.notes : null;
  const reportCount = recordedReportCount(metadata);
  const issue: BdIssue = {
    description:
      typeof record.description === 'string' ? record.description : null,
    id,
    metadata,
    notes,
    status: typeof record.status === 'string' ? record.status : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
  };
  const printed = renderStoredNotes(issue, {...PLAIN_STYLE, full: true});
  return {
    asReport: showsNotesAsReport(issue),
    firstLine:
      printed
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '') ?? '',
    header: renderShowHeader(issue, PLAIN_STYLE)[2]?.trim() ?? '',
    rendered:
      notes == null || notes.trim() === '' ? null : isRenderedReport(notes),
    reportCount,
  };
}

/** The one record for `id` in `records`, or why there is not exactly one. */
function onlyRecord(
  records: RecordsAt,
  id: string,
  where: string,
): Outcome<Record<string, unknown>> {
  const found = records.get(id) ?? [];
  const first = found[0];
  if (found.length === 1 && first != null) return {ok: true, value: first};
  return {
    message:
      found.length === 0
        ? `${id} is not in ${BEADS_JSONL} at ${where}`
        : `${id} appears ${found.length} times in ${BEADS_JSONL} at ${where}, so which one to restore is not knowable`,
    ok: false,
  };
}

/**
 * A metadata object, or null when the record carries none. bd omits the key
 * entirely for an issue with no metadata (bd.ts header), so absent is a
 * measured "none"; present-but-not-an-object is a failure.
 */
function metadataOf(
  record: Record<string, unknown>,
): Outcome<Record<string, unknown>> {
  const raw = record.metadata;
  if (raw === undefined) return {ok: true, value: {}};
  if (isRecord(raw)) return {ok: true, value: raw};
  return {
    message: `its metadata is ${JSON.stringify(raw)}, not an object`,
    ok: false,
  };
}

export interface PlanInputs {
  damaged: CommitRef;
  damagedRecords: RecordsAt;
  from: CommitRef;
  fromRecords: RecordsAt;
  id: string;
  now: BdResult<BdIssue | null>;
}

/** Build one id's plan. Pure: every read has already happened. */
export function planRestore(inputs: PlanInputs): IdPlan {
  const {damaged, from, id} = inputs;
  const refuse = (reason: string): IdPlan => ({
    detail: null,
    id,
    verdict: {kind: 'refused', reasons: [reason]},
  });

  const fromFound = onlyRecord(inputs.fromRecords, id, `--from ${from.short}`);
  if (!fromFound.ok) return refuse(fromFound.message);
  const fromRecord = fromFound.value;
  if (fromRecord.issue_type !== 'thread') {
    return refuse(
      `${id} is ${JSON.stringify(fromRecord.issue_type ?? null)} at --from, not a thread; this script restores thread records only`,
    );
  }
  for (const field of BODY_FIELDS) {
    if (typeof fromRecord[field] !== 'string') {
      return refuse(
        `${id}'s ${field} at --from is ${showSlot(slot(fromRecord, field))}, not text`,
      );
    }
  }
  const fromMeta = metadataOf(fromRecord);
  if (!fromMeta.ok) return refuse(`${id} at --from: ${fromMeta.message}`);

  const damagedFound = onlyRecord(
    inputs.damagedRecords,
    id,
    `--damaged-at ${damaged.short}`,
  );
  if (!damagedFound.ok) return refuse(damagedFound.message);
  const damagedRecord = damagedFound.value;
  const damagedMeta = metadataOf(damagedRecord);
  if (!damagedMeta.ok) {
    return refuse(`${id} at --damaged-at: ${damagedMeta.message}`);
  }

  if (!inputs.now.ok) {
    return refuse(
      `could not read ${id}'s live record — ${describeBdFailure(inputs.now.failure)}`,
    );
  }
  if (inputs.now.value == null) {
    return refuse(`bd has no bead ${id} now`);
  }
  const nowRecord: Record<string, unknown> = {...inputs.now.value};
  const nowMeta = metadataOf(nowRecord);
  if (!nowMeta.ok) return refuse(`${id} now: ${nowMeta.message}`);

  // THE WRITE. Every key --from had, at its --from value — except `source`,
  // when --from records a report (D-E's one deliberate deviation).
  const targetMeta: Record<string, unknown> = {...fromMeta.value};
  let deviation: string | null = null;
  const count = readReportCountEvidence(fromMeta.value);
  if (count.kind === 'positive' && fromMeta.value.source !== REPORT_SOURCE) {
    targetMeta.source = REPORT_SOURCE;
    deviation = `writes ${JSON.stringify(REPORT_SOURCE)}, NOT the snapshot's ${showSlot(slot(fromMeta.value, 'source'))} — the deliberate deviation D-E prescribes: reportCount is ${count.value} at --from, and a report under the 'backfill' label is what backfill erased`;
  }
  const target: ThreadBeadFields = {
    description: fromRecord.description as string,
    metadata: targetMeta,
    notes: fromRecord.notes as string,
    title: fromRecord.title as string,
  };

  const bodyRows: FieldRow[] = BODY_FIELDS.map((name) => ({
    damaged: slot(damagedRecord, name),
    from: slot(fromRecord, name),
    name,
    now: slot(nowRecord, name),
    target: slot(fromRecord, name),
  }));
  const metaRows: FieldRow[] = Object.keys(targetMeta)
    .sort()
    .map((key) => ({
      damaged: slot(damagedMeta.value, key),
      from: slot(fromMeta.value, key),
      name: `metadata.${key}`,
      now: slot(nowMeta.value, key),
      target: slot(targetMeta, key),
    }));
  const rows = [...bodyRows, ...metaRows];

  let verdict: Verdict;
  if (rows.every((row) => sameSlot(row.now, row.target))) {
    verdict = {kind: 'already-restored'};
  } else {
    const reasons: string[] = [];
    const changed = rows.filter((row) => !sameSlot(row.damaged, row.now));
    if (changed.length > 0) {
      reasons.push(
        `changed after the damaging commit ${damaged.short}, in ${changed.length} field(s) this restore would write: ${changed.map((row) => row.name).join(', ')} — restoring would overwrite that later edit`,
      );
    }
    if (rows.every((row) => sameSlot(row.from, row.damaged))) {
      reasons.push(
        `the damaging commit ${damaged.short} did not change any field this restore writes, so it erased nothing here (wrong id, or wrong --from / --damaged-at?)`,
      );
    }
    verdict =
      reasons.length > 0 ? {kind: 'refused', reasons} : {kind: 'restore'};
  }

  return {
    detail: {
      bodyRows,
      deviation,
      leftAlone: Object.keys(nowMeta.value)
        .filter((key) => !Object.hasOwn(targetMeta, key))
        .sort(),
      metaRows,
      // bd MERGES metadata, so after the write the record holds the live keys
      // with the target's laid over them.
      showAfter: showDecision(
        id,
        {...nowRecord, ...target},
        {
          ...nowMeta.value,
          ...targetMeta,
        },
      ),
      showNow: showDecision(id, nowRecord, nowMeta.value),
      status: {
        from: slot(fromRecord, 'status'),
        now: slot(nowRecord, 'status'),
      },
      target,
    },
    id,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

interface Printer {
  style: OutputStyle;
  write: (text: string) => void;
}

function emit(
  printer: Printer,
  text: string,
  indent: number,
  hang = indent + 2,
): void {
  printer.write(wrapHanging(text, {hang, indent, width: printer.style.width}));
}

function blank(printer: Printer): void {
  printer.write('');
}

function verdictLabel(verdict: Verdict, apply: boolean): string {
  switch (verdict.kind) {
    case 'restore':
      return apply ? 'WILL RESTORE' : 'WOULD RESTORE';
    case 'already-restored':
      return 'ALREADY RESTORED — nothing to write';
    case 'refused':
      return 'REFUSED';
  }
}

function previewLines(value: Slot): string[] {
  if (value.kind === 'absent' || typeof value.value !== 'string') {
    return [showSlot(value)];
  }
  const lines = value.value.split('\n');
  const shown = lines
    .slice(0, PREVIEW_LINES)
    .map((text) =>
      text.length > VALUE_CAP ? `${text.slice(0, VALUE_CAP)}…` : text,
    );
  if (lines.length > PREVIEW_LINES) {
    shown.push(`… (${lines.length - PREVIEW_LINES} more lines)`);
  }
  return shown;
}

/**
 * Length in CODE POINTS, not UTF-16 units: an emoji is one character here, as
 * it is in `jq length` and in the bead that recorded the damage (13,457).
 */
function lengthOf(value: Slot): string {
  return value.kind === 'value' && typeof value.value === 'string'
    ? `${[...value.value].length} chars`
    : showSlot(value);
}

function printBodyRow(printer: Printer, row: FieldRow): void {
  const {color} = printer.style;
  const changes = !sameSlot(row.now, row.target);
  const verb = changes
    ? paint('the write CHANGES it', ['yellow'], color)
    : 'unchanged — the write sends the value it already has';
  if (row.name === 'title') {
    emit(
      printer,
      `${paint(row.name, ['bold'], color)} — ${verb}`,
      DETAIL_COLUMN,
    );
    emit(
      printer,
      `--from  ${showSlot(row.from)}`,
      VALUE_COLUMN,
      VALUE_COLUMN + 8,
    );
    if (changes) {
      emit(
        printer,
        `now     ${showSlot(row.now)}`,
        VALUE_COLUMN,
        VALUE_COLUMN + 8,
      );
    }
    return;
  }
  emit(
    printer,
    `${paint(row.name, ['bold'], color)} — ${verb} · ${lengthOf(row.from)} at --from · ${lengthOf(row.now)} now`,
    DETAIL_COLUMN,
  );
  emit(printer, '--from starts:', VALUE_COLUMN);
  for (const text of previewLines(row.from))
    emit(printer, text, VALUE_COLUMN + 3);
  if (changes) {
    emit(printer, 'now starts:', VALUE_COLUMN);
    for (const text of previewLines(row.now))
      emit(printer, text, VALUE_COLUMN + 3);
  }
}

function printShowDecision(
  printer: Printer,
  label: string,
  decision: ShowDecision,
): void {
  const verdict = decision.asReport
    ? `prints the stored report, opening ${JSON.stringify(decision.firstLine)}`
    : `prints ${JSON.stringify(decision.firstLine)}${decision.firstLine === NO_REPORT_GLANCE ? ' (the "no report yet" view)' : ''}`;
  emit(
    printer,
    `${label}  isRenderedReport(notes) ${String(decision.rendered)} · reportCount ${String(decision.reportCount)} → ${verdict}`,
    VALUE_COLUMN,
    VALUE_COLUMN + label.length + 2,
  );
  emit(
    printer,
    `header: ${decision.header}`,
    VALUE_COLUMN + label.length + 2,
    VALUE_COLUMN + label.length + 4,
  );
}

function printPlan(
  printer: Printer,
  plan: IdPlan,
  commits: {damaged: CommitRef; from: CommitRef},
  apply: boolean,
): void {
  const {color} = printer.style;
  const label = verdictLabel(plan.verdict, apply);
  printer.write(
    sectionHeader(
      `${plan.id} — ${plan.verdict.kind === 'refused' ? paint(label, ['red'], color) : label}`,
      {color, emoji: '🧵'},
    ),
  );
  if (plan.verdict.kind === 'refused') {
    for (const reason of plan.verdict.reasons) {
      blank(printer);
      emit(
        printer,
        `${paint('refused:', ['red', 'bold'], color)} ${reason}`,
        BODY_COLUMN,
        DETAIL_COLUMN,
      );
    }
  }
  const detail = plan.detail;
  if (detail == null) return;

  blank(printer);
  emit(printer, paint('BODY', ['bold'], color), BODY_COLUMN);
  for (const row of detail.bodyRows) {
    blank(printer);
    printBodyRow(printer, row);
  }
  blank(printer);
  emit(
    printer,
    `${paint('status', ['bold'], color)} — NOT written: ${showSlot(detail.status.from)} at --from, ${showSlot(detail.status.now)} now`,
    DETAIL_COLUMN,
  );

  blank(printer);
  emit(
    printer,
    `${paint('METADATA', ['bold'], color)} — ${detail.metaRows.length} keys at --from; the write sends all ${detail.metaRows.length}, and bd MERGES them into the live record`,
    BODY_COLUMN,
    DETAIL_COLUMN,
  );
  const changing = detail.metaRows.filter(
    (row) => !sameSlot(row.now, row.target),
  );
  const same = detail.metaRows.filter((row) => sameSlot(row.now, row.target));
  blank(printer);
  emit(printer, `the write CHANGES ${changing.length}:`, DETAIL_COLUMN);
  for (const row of changing) {
    const key = row.name.slice('metadata.'.length);
    const deviates = key === 'source' && detail.deviation != null;
    blank(printer);
    emit(
      printer,
      deviates
        ? `${paint(key, ['bold'], color)} — ${paint(detail.deviation ?? '', ['yellow'], color)}`
        : paint(key, ['bold'], color),
      VALUE_COLUMN,
      VALUE_COLUMN + 3,
    );
    emit(
      printer,
      `--from  ${showSlot(row.from)}`,
      VALUE_COLUMN + 3,
      VALUE_COLUMN + 11,
    );
    emit(
      printer,
      `now     ${showSlot(row.now)}`,
      VALUE_COLUMN + 3,
      VALUE_COLUMN + 11,
    );
    if (deviates) {
      emit(
        printer,
        `write   ${showSlot(row.target)}`,
        VALUE_COLUMN + 3,
        VALUE_COLUMN + 11,
      );
    }
  }
  blank(printer);
  emit(
    printer,
    `the SAME at --from and now ${same.length} (rewritten with the value they already hold):`,
    DETAIL_COLUMN,
  );
  blank(printer);
  for (const row of same) {
    const key = row.name.slice('metadata.'.length);
    const note =
      key === 'source' && detail.deviation != null
        ? ` — ${detail.deviation}`
        : '';
    emit(
      printer,
      `${key} = ${showSlot(row.now)}${note}`,
      VALUE_COLUMN,
      VALUE_COLUMN + 3,
    );
  }
  blank(printer);
  emit(
    printer,
    `left alone — keys the live record has that --from lacks, which the write does not send (${detail.leftAlone.length}): ${detail.leftAlone.length === 0 ? 'none' : detail.leftAlone.join(', ')}`,
    DETAIL_COLUMN,
    VALUE_COLUMN,
  );

  blank(printer);
  const rows = [...detail.bodyRows, ...detail.metaRows];
  const changedAfter = rows.filter((row) => !sameSlot(row.damaged, row.now));
  emit(
    printer,
    `${paint('REFUSAL CHECK', ['bold'], color)} — each written field at --damaged-at ${commits.damaged.short} against now: ${
      changedAfter.length === 0
        ? `all ${rows.length} identical`
        : paint(
            `${changedAfter.length} of ${rows.length} CHANGED after ${commits.damaged.short}`,
            ['red'],
            color,
          )
    }`,
    BODY_COLUMN,
    DETAIL_COLUMN,
  );
  for (const row of changedAfter) {
    blank(printer);
    emit(printer, paint(row.name, ['bold'], color), DETAIL_COLUMN);
    emit(
      printer,
      `at ${commits.damaged.short}  ${showSlot(row.damaged)}`,
      VALUE_COLUMN,
      VALUE_COLUMN + 11,
    );
    emit(
      printer,
      `now      ${showSlot(row.now)}`,
      VALUE_COLUMN,
      VALUE_COLUMN + 11,
    );
  }

  blank(printer);
  emit(
    printer,
    `${paint('THREAD SHOW --FULL', ['bold'], color)} — decides on isRenderedReport(notes), except that a backfill-owned body is never a report (k0b8n.20); when the notes are not a report, metadata.reportCount picks the glance line`,
    BODY_COLUMN,
    DETAIL_COLUMN,
  );
  blank(printer);
  printShowDecision(printer, 'now  ', detail.showNow);
  blank(printer);
  printShowDecision(printer, 'after', detail.showAfter);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  apply: boolean;
  /** Test pins. The CLI leaves both to the thread config, as every thread command does. */
  autoCommit?: boolean;
  autoPush?: boolean;
  /** Null derives it: the one child of --from on the path to HEAD. */
  damagedAt: string | null;
  env: EnvLike;
  from: string;
  ids: string[];
  style?: OutputStyle;
  write?: (text: string) => void;
}

/** The ids' records read back after the write, compared with what was sent. */
function mismatches(target: ThreadBeadFields, issue: BdIssue): string[] {
  const record: Record<string, unknown> = {...issue};
  const meta = isRecord(record.metadata) ? record.metadata : {};
  const out: string[] = [];
  for (const field of BODY_FIELDS) {
    if (!sameSlot(slot(record, field), {kind: 'value', value: target[field]})) {
      out.push(field);
    }
  }
  for (const key of Object.keys(target.metadata).sort()) {
    if (!sameSlot(slot(meta, key), slot(target.metadata, key))) {
      out.push(`metadata.${key}`);
    }
  }
  return out;
}

/**
 * Plan every id, print the plan, and — only with `apply` and only when every
 * id passed — write, verify and commit.
 *
 * EXIT 0 when every id would restore / was restored / was already restored.
 * EXIT 1 when any id was refused, or a write or its read-back failed.
 * EXIT 2 when the inputs themselves could not be resolved (a bad commit, a
 * --damaged-at that does not descend from --from, an unreadable JSONL).
 */
export async function runRestore(options: RestoreOptions): Promise<number> {
  const printer: Printer = {
    style: options.style ?? outputStyle(),
    write: options.write ?? ((text) => console.log(text)),
  };
  const {color} = printer.style;
  const env = options.env;
  const ids = [...new Set(options.ids)];
  const repo = threadsRepoDirResolution(env);
  const dir = repo.dir;

  const stop = (message: string): number => {
    blank(printer);
    emit(
      printer,
      `${paint('cannot run:', ['red', 'bold'], color)} ${message}`,
      HEADER_COLUMN,
      BODY_COLUMN,
    );
    blank(printer);
    emit(
      printer,
      'Nothing was read from bd and nothing was written.',
      HEADER_COLUMN,
    );
    return 2;
  };

  blank(printer);
  printer.write(
    sectionHeader(
      `RESTORE THREAD RECORDS — ${options.apply ? 'APPLY (this run writes)' : 'DRY RUN (nothing is written)'}`,
      {color, emoji: '🧰'},
    ),
  );
  blank(printer);
  emit(
    printer,
    `threads repo  ${dir} (resolved from: ${repo.source === 'env' ? 'JUSTIN_THREADS_REPO_DIR' : repo.source === 'config' ? 'the thread config' : 'the default'})`,
    BODY_COLUMN,
    BODY_COLUMN + 14,
  );

  const from = resolveCommit(dir, options.from, env);
  if (!from.ok) return stop(`--from: ${from.message}`);
  const damaged =
    options.damagedAt == null
      ? deriveDamagedAt(dir, from.value, env)
      : resolveCommit(dir, options.damagedAt, env);
  if (!damaged.ok) return stop(`--damaged-at: ${damaged.message}`);
  if (damaged.value.sha === from.value.sha) {
    return stop('--from and --damaged-at are the same commit');
  }
  const ordered = isAncestor(dir, from.value, damaged.value, env);
  if (!ordered.ok) return stop(ordered.message);
  if (!ordered.value) {
    return stop(
      `--from ${from.value.short} is not an ancestor of --damaged-at ${damaged.value.short}, so the damage cannot have been done to it`,
    );
  }

  emit(
    printer,
    `--from        ${from.value.short} ${from.value.subject}`,
    BODY_COLUMN,
    BODY_COLUMN + 14,
  );
  emit(
    printer,
    `--damaged-at  ${damaged.value.short} ${damaged.value.subject}${options.damagedAt == null ? ' (derived: the only child of --from on the path to HEAD)' : ''}`,
    BODY_COLUMN,
    BODY_COLUMN + 14,
  );
  emit(
    printer,
    'now           the live record, read through the bd adapter (bd show)',
    BODY_COLUMN,
    BODY_COLUMN + 14,
  );

  const fromRecords = readRecordsAt(dir, from.value, env);
  if (!fromRecords.ok) return stop(fromRecords.message);
  const damagedRecords = readRecordsAt(dir, damaged.value, env);
  if (!damagedRecords.ok) return stop(damagedRecords.message);

  const ctx = bdContext(env);
  const commits = {damaged: damaged.value, from: from.value};
  const plans: IdPlan[] = [];
  for (const id of ids) {
    plans.push(
      planRestore({
        damaged: damaged.value,
        damagedRecords: damagedRecords.value,
        from: from.value,
        fromRecords: fromRecords.value,
        id,
        now: await showIssue(ctx, id),
      }),
    );
  }

  for (const plan of plans) {
    blank(printer);
    blank(printer);
    printPlan(printer, plan, commits, options.apply);
  }

  blank(printer);
  blank(printer);
  printer.write(sectionHeader('SUMMARY', {color, emoji: '📋'}));
  for (const plan of plans) {
    blank(printer);
    const label = verdictLabel(plan.verdict, options.apply);
    emit(
      printer,
      `${plan.id}  ${plan.verdict.kind === 'refused' ? `${paint(label, ['red'], color)} — ${plan.verdict.reasons.join(' · ')}` : label}`,
      BODY_COLUMN,
      DETAIL_COLUMN,
    );
  }
  const refused = plans.filter((plan) => plan.verdict.kind === 'refused');
  const toWrite = plans.filter((plan) => plan.verdict.kind === 'restore');
  blank(printer);
  if (refused.length > 0) {
    emit(
      printer,
      paint(
        `NOTHING WAS WRITTEN: ${refused.length} id(s) refused, and this script writes all of them or none.`,
        ['red', 'bold'],
        color,
      ),
      BODY_COLUMN,
    );
    return 1;
  }
  if (!options.apply) {
    emit(
      printer,
      `DRY RUN — nothing was written. Re-run with --apply to write ${toWrite.length} record(s) and commit the threads repo.`,
      BODY_COLUMN,
    );
    return 0;
  }
  if (toWrite.length === 0) {
    emit(
      printer,
      'Nothing to write: every id already holds its restored values.',
      BODY_COLUMN,
    );
    return 0;
  }

  blank(printer);
  printer.write(sectionHeader('WRITING', {color, emoji: '✍️'}));
  let failed = false;
  const written: string[] = [];
  for (const plan of toWrite) {
    const target = plan.detail?.target;
    if (target == null) continue;
    blank(printer);
    const result = await updateThreadBody(ctx, plan.id, target);
    if (!result.ok) {
      failed = true;
      emit(
        printer,
        `${plan.id}  ${paint('WRITE FAILED', ['red', 'bold'], color)} — ${describeBdFailure(result.failure)}`,
        BODY_COLUMN,
        DETAIL_COLUMN,
      );
      continue;
    }
    written.push(plan.id);
    const readBack = await showIssue(ctx, plan.id);
    if (!readBack.ok || readBack.value == null) {
      failed = true;
      emit(
        printer,
        `${plan.id}  written, but the read-back FAILED — ${readBack.ok ? 'bd returned no bead' : describeBdFailure(readBack.failure)}`,
        BODY_COLUMN,
        DETAIL_COLUMN,
      );
      continue;
    }
    const wrong = mismatches(target, readBack.value);
    if (wrong.length > 0) {
      failed = true;
      emit(
        printer,
        `${plan.id}  written, but the read-back DIFFERS in: ${wrong.join(', ')}`,
        BODY_COLUMN,
        DETAIL_COLUMN,
      );
      continue;
    }
    emit(
      printer,
      `${plan.id}  written and verified: all ${3 + Object.keys(target.metadata).length} written fields read back equal`,
      BODY_COLUMN,
      DETAIL_COLUMN,
    );
  }

  if (written.length > 0) {
    blank(printer);
    if (ctx.exportUnstaged) printer.write(EXPORT_UNSTAGED_WARNING);
    const commitLine = describeCommit(
      commitThreadsRepo(
        `thread restore: ${written.join(', ')} to their records at ${from.value.short} (undoing ${damaged.value.short})`,
        {
          autoCommit: options.autoCommit,
          autoPush: options.autoPush,
          dir,
          env,
          exportUnstaged: ctx.exportUnstaged,
        },
      ),
      'the threads repo',
    );
    printer.write(
      commitLine ?? '  (the threads repo: no commit was needed or made)',
    );
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const NARRATIVE = `Restores thread beads to what they said at a threads-repo commit (home-base-k0b8n.19, D-E).

DRY RUN BY DEFAULT: prints, per id and field by field, what --from says, what the
live record says, what the write would change, and what \`thread show --full\` would
print before and after. --apply writes.

WHAT IS WRITTEN: title, description, notes, and every metadata key the --from
record had, at its --from value. bd MERGES metadata, so keys only the live record
has are left alone (and listed). Status is never written. ONE DELIBERATE
DEVIATION: when --from's reportCount is > 0, source is written as 'report', not
the snapshot's 'backfill'.

REFUSES an id when any field it would write differs between --damaged-at and
now: that is a later edit, and writing over it would be a second erasure.
Also refuses an id that is missing, duplicated, not a thread, or that the
damaging commit did not change. ALL OR NOTHING: one refusal writes nothing.

--damaged-at is the LAST commit whose change to these records you mean to undo.
Omitted, it is derived as the one child of --from on the path to HEAD; zero or
several children is a refusal that asks for it.

--apply writes through the bd adapter (never bd delete, never raw Dolt), reads
each record back to verify it, then commits .beads/issues.jsonl and pushes, the
way every thread command does. The threads repo is JUSTIN_THREADS_REPO_DIR, else
the thread config, else ~/Dev/threads.

EXIT 0 every id would restore / was restored / already was · 1 an id was
refused, or a write or read-back failed · 2 the inputs could not be resolved.`;

export async function main(argv: string[]): Promise<number> {
  let exitCode = 0;
  await yargs(hideBin(argv))
    .scriptName('restore-thread-records')
    .command(
      '$0 <ids..>',
      'Restore thread records from a threads-repo commit (dry run unless --apply).',
      (y: Argv) =>
        y
          .positional('ids', {
            array: true,
            describe: 'Thread bead ids, e.g. th-fs3 th-ttp th-mq0',
            type: 'string',
          })
          .option('from', {
            demandOption: true,
            describe: 'Commit whose records to restore, e.g. 1b912a6~1',
            type: 'string',
          })
          .option('damaged-at', {
            describe:
              'The commit that damaged them (default: the one child of --from on the path to HEAD)',
            type: 'string',
          })
          .option('apply', {
            default: false,
            describe:
              'Write, verify and commit. Without it, nothing is written.',
            type: 'boolean',
          }),
      async (args) => {
        exitCode = await runRestore({
          apply: args.apply,
          damagedAt: args.damagedAt ?? null,
          env: process.env,
          from: args.from,
          ids: (args.ids ?? []).map(String),
        });
      },
    )
    .epilogue(NARRATIVE)
    .version(false)
    .alias('h', 'help')
    .strict()
    .help()
    .wrap(Math.min(100, process.stdout.columns ?? 100))
    .parseAsync();
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
