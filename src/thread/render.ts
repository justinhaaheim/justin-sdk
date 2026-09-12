/**
 * The rendered text report (home-base-p1uj D11).
 *
 * This is `~/Dev/prompts/src/rules/status-report-format.md`'s template, with
 * the four changes the sampling of ten real reports on 2026-09-12 asked for:
 *
 *  1. THE LAST INSTRUCTION IS RESTATED AT THE TOP. Justin has been away for
 *     hours and reads this on a phone; "You told me to…" is the hook his memory
 *     latches onto before anything else can mean anything.
 *  2. EVERY QUESTION IS RESTATED BEFORE ITS ANSWER. Answers used to arrive as
 *     "1. yes" against questions he could no longer see.
 *  3. ONE NUMBERED SEQUENCE FOR ASKS, options LETTERED. The old format numbered
 *     questions and also lettered options, which collided; and it split the
 *     things Justin has to do across "questions" and "next steps", which he
 *     said plainly are the same thing.
 *  4. EVERY ASK CARRIES ITS BEAD ID INLINE, so he can answer one by id days
 *     later.
 *
 * WHY IT IS PASTED RATHER THAN LINKED. Claude pastes this verbatim into its
 * final message. Justin reads reports through iOS remote control, where tool
 * output is unreliable and "see above" is not a thing that exists. The same
 * text is also the bead's `notes` field (D10), so `bd show` alone is a complete
 * status report if this tool ever breaks.
 *
 * PURE. No I/O, no clock, no environment — everything it prints is an argument.
 * That is what makes the snapshot test meaningful.
 */

import {formatTokens} from '../usage-check';

import {CLOSING_DISPOSITIONS} from './schema';

import type {ThreadFacts} from './facts';
import type {ThreadAsk, ThreadReportPayload} from './schema';

const RULE_STOP = '🛑'.repeat(28);
const RULE_OM = '🕉️'.repeat(29);
const RULE_HANDOFF = '⏭️'.repeat(8);

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

function renderDivergence(facts: ThreadFacts): string {
  if (facts.aheadBehind == null) return 'ahead/behind UNKNOWN';
  const {ahead, behind} = facts.aheadBehind;
  return `${ahead} ahead / ${behind} behind`;
}

function renderDirty(facts: ThreadFacts): string {
  if (facts.dirty == null) return 'dirty UNKNOWN';
  return facts.dirty ? 'UNCOMMITTED CHANGES' : 'clean';
}

function renderTokens(facts: ThreadFacts): string {
  return facts.tokensAtStop == null
    ? 'UNKNOWN (see autofill failures)'
    : `${formatTokens(facts.tokensAtStop)} tokens of context`;
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
  blocking: boolean;
  /** The report number that first asked it, when the bead records one. */
  fromReport: number | null;
  id: string;
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
 *   1. BLOCKING FIRST. The report prints two labelled groups in that order.
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
  blocking: boolean;
  id: string;
  reportCount: number | null;
}

export function compareAsksForNumbering(
  a: NumberedAsk,
  b: NumberedAsk,
): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  const reportA = a.reportCount ?? -1;
  const reportB = b.reportCount ?? -1;
  if (reportA !== reportB) return reportA - reportB;
  const indexA = a.askIndex ?? -1;
  const indexB = b.askIndex ?? -1;
  if (indexA !== indexB) return indexA - indexB;
  return a.id.localeCompare(b.id);
}

/** Read the numbering fields off an ask bead's metadata. Absent stays null. */
export function numberingFieldsOf(metadata: unknown): {
  askIndex: number | null;
  reportCount: number | null;
} {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const asNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    askIndex: asNumber(meta.askIndex),
    reportCount: asNumber(meta.reportCount),
  };
}

export interface RenderOptions {
  /**
   * Ask bead ids, parallel to `payload.asks`. A null entry means the bead was
   * not created — the report still prints, and says so rather than implying an
   * id that does not exist.
   */
  askIds: (string | null)[];
  /** Still-open asks from earlier reports, rendered in the same sequence (F4). */
  carried?: readonly CarriedAsk[];
  facts: ThreadFacts;
  /**
   * What a null entry in `askIds` means. "(NOT RECORDED)" when bd never took
   * the report; "(ask ids pending)" for the provisional write that happens
   * BEFORE the asks exist, on a bead that is already the thread (F1).
   */
  missingAskIdLabel?: string;
  payload: ThreadReportPayload;
  /**
   * Which report this is (1-based). Used ONLY to order this report's own asks
   * after the carried ones (F12); absent means "newer than anything carried",
   * which is the same thing every caller means by it.
   */
  reportCount?: number;
  /** The thread bead id, or null when bd never took the report. */
  threadId: string | null;
}

function renderAsk(
  lines: string[],
  ask: ThreadAsk,
  id: string | null,
  number: number,
  missingLabel: string,
): void {
  const idTag = id == null ? missingLabel : `(${id})`;
  lines.push(`  ${number}. ${askKindTag(ask)} ${ask.text} ${idTag}`);
  lines.push(`     Context: ${ask.context}`);
  ask.options.forEach((option, index) => {
    const prefix = option.recommended ? '(Recommended) ' : '';
    lines.push(`     ${optionLetter(index)}. ${prefix}${option.text}`);
  });
  lines.push(`     If you don't answer: ${ask.default}`);
}

function renderCarried(
  lines: string[],
  carried: CarriedAsk,
  number: number,
): void {
  const from =
    carried.fromReport == null
      ? '(carried from an earlier report)'
      : `(carried from report #${carried.fromReport})`;
  lines.push(`  ${number}. ${from} (${carried.id})`);
  for (const line of carried.restated.split('\n')) lines.push(`     ${line}`);
}

/** The whole report, as one string. Ends without a trailing newline. */
export function renderReport(options: RenderOptions): string {
  const {askIds, facts, payload, threadId} = options;
  const lines: string[] = [];

  lines.push(RULE_STOP);
  lines.push('');
  lines.push(`**Thread:** ${payload.title}`);
  lines.push(
    `**Repo:** ${orUnknown(facts.repo)} · **Branch:** ${orUnknown(facts.branch)} · **Worktree:** ${renderWorktree(facts)}`,
  );
  lines.push(
    `**Tree:** ${renderDirty(facts)} · ${renderDivergence(facts)} · HEAD ${facts.headSha == null ? 'UNKNOWN' : facts.headSha.slice(0, 12)}`,
  );
  lines.push(
    `**Stop reason:** ${STOP_REASON_LABEL[payload.stopReason.kind] ?? payload.stopReason.kind} — ${payload.stopReason.detail}`,
  );
  lines.push(`**Tokens at stop:** ${renderTokens(facts)}`);
  lines.push(`**You asked me to:** ${payload.instruction}`);
  if (facts.lastUserMessage != null) {
    lines.push(`**Your last message, verbatim:** ${facts.lastUserMessage}`);
  }
  if (payload.continuesFrom != null && payload.continuesFrom !== '') {
    lines.push(`**Continues from:** ${payload.continuesFrom}`);
  }
  lines.push('');

  lines.push('**What I did:**');
  if (payload.did.length === 0) lines.push('- (nothing completed this turn)');
  for (const item of payload.did) lines.push(`- ✅ ${item}`);
  lines.push('');

  lines.push('**Progress toward goal:**');
  lines.push(`- ⚽ Goal: ${payload.goal}`);
  lines.push(`- 📈 Progress estimate: ${payload.progress.percent}%`);
  lines.push('- 📋 Remaining:');
  if (payload.progress.remaining.length === 0) {
    lines.push('  - (nothing — this arc is done)');
  }
  for (const item of payload.progress.remaining) lines.push(`  - ${item}`);
  lines.push('');

  lines.push('**What I learned:**');
  if (payload.learned.length === 0) lines.push('- (nothing worth recording)');
  payload.learned.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.text} (${item.disposition})`);
  });
  lines.push('');

  lines.push('**Answers to your questions:**');
  if (payload.answers.length === 0)
    lines.push('- (you asked nothing this turn)');
  payload.answers.forEach((item, index) => {
    lines.push(`${index + 1}. Q: ${item.question}`);
    lines.push(`   A: ${item.answer}`);
  });
  lines.push('');

  if (payload.discussion.length > 0) {
    lines.push('**Discussion:**');
    for (const item of payload.discussion) lines.push(`- ${item}`);
    lines.push('');
  }

  // ONE numbered sequence across both groups, blocking first, so an answer can
  // be "1. yes 2. b" and land unambiguously (D11). The order is
  // `compareAsksForNumbering`'s, and `thread answer` walks the same order (F12)
  // — that is the whole point of sorting here rather than concatenating groups
  // by hand, which is what let the two drift apart.
  lines.push('**Asks — everything I need from you:**');
  const carriedAsks = options.carried ?? [];
  const missingLabel = options.missingAskIdLabel ?? '(NOT RECORDED)';
  const thisReport = options.reportCount ?? Number.MAX_SAFE_INTEGER;
  const entries: {sort: NumberedAsk; render: (n: number) => void}[] = [
    ...carriedAsks.map((carried) => ({
      render: (n: number) => renderCarried(lines, carried, n),
      sort: {
        askIndex: carried.askIndex,
        blocking: carried.blocking,
        id: carried.id,
        reportCount: carried.fromReport,
      },
    })),
    ...payload.asks.map((ask, index) => ({
      render: (n: number) =>
        renderAsk(lines, ask, askIds[index] ?? null, n, missingLabel),
      // A brand-new ask carries THIS report's number, so it sorts after every
      // carried one. The id is only a tiebreak, and it may not exist yet.
      sort: {
        askIndex: index,
        blocking: ask.blocking,
        id: askIds[index] ?? '',
        reportCount: thisReport,
      },
    })),
  ].sort((a, b) => compareAsksForNumbering(a.sort, b.sort));
  if (entries.length === 0) {
    lines.push('- (nothing — you are not blocking anything)');
  }
  let number = 1;
  const blockingEntries = entries.filter((entry) => entry.sort.blocking);
  const otherEntries = entries.filter((entry) => !entry.sort.blocking);
  if (blockingEntries.length > 0) {
    lines.push('- Blocking:');
    for (const entry of blockingEntries) {
      entry.render(number);
      number += 1;
    }
  }
  if (otherEntries.length > 0) {
    lines.push('- Non-blocking (I proceeded; you can override):');
    for (const entry of otherEntries) {
      entry.render(number);
      number += 1;
    }
  }
  lines.push('');

  if (payload.nextSteps != null && payload.nextSteps.length > 0) {
    // What CLAUDE does next. Anything Justin must do is an ask, above.
    lines.push('**Next steps (mine, not yours):**');
    for (const step of payload.nextSteps) lines.push(`- ➡️ ${step}`);
    lines.push('');
  }

  // Only the ones CLOSED this time. The carried ones are live asks and are
  // rendered above; repeating them here as bare ids is what F4 removed.
  const closedPriors = payload.priorAsks.filter((prior) =>
    CLOSING_DISPOSITIONS.has(prior.disposition),
  );
  lines.push('**Prior asks — closed by this report:**');
  if (closedPriors.length === 0) {
    lines.push('- (none closed this time)');
  }
  for (const prior of closedPriors) {
    lines.push(`- ${prior.id} — ${prior.disposition}: ${prior.detail}`);
  }
  lines.push('');

  lines.push('**Work product:**');
  lines.push(`- ${payload.workProduct.kind}: ${payload.workProduct.summary}`);
  lines.push(
    `- Merge state: ${MERGE_LABEL[payload.workProduct.merged] ?? payload.workProduct.merged}${payload.workProduct.pr == null || payload.workProduct.pr === '' ? '' : ` · PR ${payload.workProduct.pr}`}`,
  );
  lines.push('');

  lines.push('**Beads touched:**');
  if (payload.beadsTouched.length === 0) lines.push('- (none)');
  for (const bead of payload.beadsTouched) {
    lines.push(`- ${bead.id} — ${bead.description}`);
  }

  if (facts.autofillFailures.length > 0) {
    lines.push('');
    lines.push('**Facts I could not measure:**');
    for (const failure of facts.autofillFailures) lines.push(`- ⚠️ ${failure}`);
  }

  if (payload.handoff != null && payload.handoff !== '') {
    lines.push('');
    lines.push(RULE_HANDOFF);
    lines.push(payload.handoff);
    lines.push(RULE_HANDOFF);
  }

  lines.push('');
  lines.push(
    threadId == null
      ? 'Answer: (no thread bead — this report was NOT recorded)'
      : `Answer: justin-sdk thread answer ${threadId}`,
  );
  lines.push(RULE_OM);

  return lines.join('\n');
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
    `Answer by commenting on this bead: cd ~/Dev/life && bun run bd comments add <this id> "your answer"`,
    `Thread: ${threadId}`,
  );
  return lines.join('\n');
}
