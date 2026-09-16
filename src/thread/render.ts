/**
 * SHARED REPORT PIECES (home-base-p1uj D11, D14) — the bits more than one
 * surface needs.
 *
 * The report RENDERING moved out on 2026-09-14 (D14): `report-model.ts` decides
 * what a report says, and `render-markdown` / `render-ansi` / `render-html`
 * decide how it looks. `renderReport` is retired, and callers now import the
 * medium they mean — the single function had grown four different audiences
 * (Claude's paste, Justin's terminal, the browser panel, the bead's notes) and
 * was about to grow a compact form as well.
 *
 * What stayed here is what is NOT a report: the ask-bead and thread-bead body
 * text (which bd stores and every other surface reads back), the ask numbering
 * contract shared by the report and the `thread answer` walk, and the small
 * spellings — `P0`, `[Pick a/b]`, option letters — that every surface must agree
 * on or Justin's "1 yes, 2 b" lands on the wrong ask.
 *
 * PURE. No I/O, no clock, no environment.
 */

import {readAskPriority} from './metadata';

import type {ThreadFacts} from './facts';
import type {ThreadAsk, ThreadReportPayload} from './schema';

const STOP_REASON_LABEL: Record<string, string> = {
  blocked: '🛑 Blocked on you',
  completed: '✅ Work completed',
  error: '💥 Error',
  needsYou: '🙋 Needs you',
  other: '• Other',
  tokenLimit: '⚠️ Token limit',
};

const MERGE_LABEL: Record<string, string> = {
  merged: 'merged',
  notApplicable: 'not applicable',
  unmerged: 'UNMERGED',
  unknown: 'UNKNOWN',
};

/** The footer `renderAskDescription` appends, and the marker for removing it. */
const ANSWER_FOOTER_MARKER = 'Answer by commenting on this bead:';

/**
 * An ask bead's description minus the "answer by commenting" footer.
 *
 * Lives here because this file WRITES that footer — the code that adds a thing
 * should own removing it. `inbox`, `prepare` and the carried-ask rendering
 * below all read it back through this one function.
 */
export function restateAsk(description: string): string {
  const cut = description.indexOf(ANSWER_FOOTER_MARKER);
  return (cut === -1 ? description : description.slice(0, cut)).trimEnd();
}

/**
 * `P0`…`P4` — the one spelling of a priority across every text surface (D15).
 *
 * Out of range says so rather than clamping: a priority this code did not put
 * there is a fact about the data, and rounding it to P4 would hide it.
 */
export function priorityLabel(priority: number): string {
  return Number.isInteger(priority) && priority >= 0 && priority <= 4
    ? `P${priority}`
    : `P? (${priority})`;
}

/** a, b, c, … for an option index. */
export function optionLetter(index: number): string {
  return String.fromCharCode(97 + index);
}

/**
 * The form control Justin answers with. Its whole job is to tell him, at a
 * glance, what SHAPE of reply this ask wants — a yes, a letter, a sentence, or
 * his hands on a keyboard.
 */
export function askKindTag(ask: ThreadAsk): string {
  switch (ask.kind) {
    case 'approve':
      return '[Approve Y/n]';
    case 'pick': {
      const letters = ask.options.map((_option, index) => optionLetter(index));
      return letters.length === 0 ? '[Pick]' : `[Pick ${letters.join('/')}]`;
    }
    case 'answer':
      return '[Answer]';
    case 'act':
      return '[Do]';
  }
}

/** "unknown" is said out loud; it is never rendered as a reassuring value. */
function orUnknown(value: string | null): string {
  return value == null || value === '' ? 'UNKNOWN' : value;
}

function renderWorktree(facts: ThreadFacts): string {
  if (facts.isWorktree == null) return 'UNKNOWN';
  if (!facts.isWorktree) return 'primary checkout';
  return facts.worktreePath ?? 'yes (path UNKNOWN)';
}

function renderDirty(facts: ThreadFacts): string {
  if (facts.dirty == null) return 'dirty UNKNOWN';
  return facts.dirty ? 'UNCOMMITTED CHANGES' : 'clean';
}

/**
 * An ask from an EARLIER report that is still open (F4).
 *
 * It used to render as `- jl-x7q.1 — carried: <detail>` under "Prior asks": a
 * bare bead id with no question, no options, no form control and no default —
 * for the one thing Justin still owes an answer on. That broke two rules in
 * status-report-format.md at once ("asks are ONE numbered sequence" and "never
 * a bare id") and was precisely the loss this epic exists to stop. It now
 * appears in the numbered sequence, in full, marked as carried.
 */
export interface CarriedAsk {
  /** `metadata.askIndex` — its position within the report that created it. */
  askIndex: number | null;
  /** The report number that first asked it, when the bead records one. */
  fromReport: number | null;
  /**
   * The PREDECESSOR thread it came from (D21), when this session continues
   * another one — null for the ordinary case where the ask is this thread's own
   * from an earlier report. It exists so the carried label can say "carried from
   * th-eru report #7": a report number alone is ambiguous once the ask has
   * crossed session boundaries, and "#7" of a thread Justin cannot name is
   * exactly the bare-id failure the epic exists to stop.
   */
  fromThread?: string | null;
  id: string;
  /** 0-4, read through `readAskPriority` so a v1 ask bead still sorts (D15). */
  priority: number;
  /** The ask bead's description, footer stripped. */
  restated: string;
}

/**
 * THE ASK NUMBERING CONTRACT (F12) — one order, used by the report and by the
 * `thread answer` walk.
 *
 * They used to disagree. The report numbered blocking-then-non-blocking with
 * carried asks first inside each group, in payload order; the walk sorted by
 * `id.localeCompare`, which puts `.10` before `.2` and interleaves carried asks
 * with new ones. So "1 yes, 2 b", typed against the pasted report, walked onto
 * different asks. Both sides now sort with this comparator, which is the
 * report's own rule written down:
 *
 *   1. PRIORITY ASCENDING — P0 first (D15, replacing "blocking first"). The
 *      report prints one numbered sequence with the P0s at the top.
 *   2. OLDEST REPORT FIRST. A carried ask has waited longest and is the one
 *      most likely to have fallen out of Justin's head, so it leads its group.
 *      An ask whose bead records no `reportCount` sorts as OLDER than any that
 *      does: it cannot have been created by the report being rendered (that
 *      report stamps every ask it creates), so it is carried by definition.
 *   3. THEN PAYLOAD ORDER, via `askIndex` — the order Claude wrote them in.
 *   4. THEN id, so the order is total and two runs never differ.
 *
 * Numeric fields are compared as NUMBERS, never as strings: `localeCompare` is
 * what put ask 10 ahead of ask 2 in the first place.
 */
export interface NumberedAsk {
  askIndex: number | null;
  id: string;
  priority: number;
  reportCount: number | null;
}

export function compareAsksForNumbering(
  a: NumberedAsk,
  b: NumberedAsk,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const reportA = a.reportCount ?? -1;
  const reportB = b.reportCount ?? -1;
  if (reportA !== reportB) return reportA - reportB;
  const indexA = a.askIndex ?? -1;
  const indexB = b.askIndex ?? -1;
  if (indexA !== indexB) return indexA - indexB;
  return a.id.localeCompare(b.id);
}

/**
 * Read the numbering fields off an ask bead's metadata. Absent stays null —
 * except `priority`, which has a defined fallback (see `readAskPriority`) and so
 * is a number here rather than a nullable one.
 */
export function numberingFieldsOf(metadata: unknown): {
  askIndex: number | null;
  priority: number;
  reportCount: number | null;
} {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const asNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    askIndex: asNumber(meta.askIndex),
    priority: readAskPriority(metadata),
    reportCount: asNumber(meta.reportCount),
  };
}

/**
 * The bead's `description` field (D10): the ten-second read. Goal, the
 * instruction, why the session stopped, and how far along it is — and nothing
 * else, because this is what a board row and a phone notification show.
 */
export function renderThreadDescription(options: {
  facts: ThreadFacts;
  payload: ThreadReportPayload;
}): string {
  const {facts, payload} = options;
  const lines = [
    `GOAL: ${payload.goal}`,
    `YOU ASKED ME TO: ${payload.instruction}`,
    `STOPPED: ${STOP_REASON_LABEL[payload.stopReason.kind] ?? payload.stopReason.kind} — ${payload.stopReason.detail}`,
    `PROGRESS: ${payload.progress.percent}%`,
  ];
  if (payload.progress.remaining.length > 0) {
    lines.push(`REMAINING: ${payload.progress.remaining.join('; ')}`);
  }
  lines.push(
    `WHERE: ${orUnknown(facts.repo)} @ ${orUnknown(facts.branch)} (${renderWorktree(facts)}), ${renderDirty(facts)}`,
  );
  lines.push(
    `WORK PRODUCT: ${payload.workProduct.kind} — ${MERGE_LABEL[payload.workProduct.merged] ?? payload.workProduct.merged}`,
  );
  return lines.join('\n');
}

/** The `ask` bead's description: everything Justin needs to answer it cold. */
export function renderAskDescription(ask: ThreadAsk, threadId: string): string {
  const lines = [
    `${askKindTag(ask)} ${ask.text}`,
    '',
    `CONTEXT: ${ask.context}`,
  ];
  if (ask.options.length > 0) {
    lines.push('', 'OPTIONS:');
    ask.options.forEach((option, index) => {
      const prefix = option.recommended ? '(Recommended) ' : '';
      lines.push(`  ${optionLetter(index)}. ${prefix}${option.text}`);
    });
  }
  lines.push('', `IF UNANSWERED: ${ask.default}`);
  lines.push(
    '',
    `Answer by commenting on this bead: cd ~/Dev/threads && bun run bd comments add <this id> "your answer"`,
    `Thread: ${threadId}`,
  );
  return lines.join('\n');
}
