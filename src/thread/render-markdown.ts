/**
 * THE MARKDOWN RENDERING (home-base-p1uj D14) — what Claude pastes.
 *
 * This is the canonical text of a report. It is what the thread bead's `notes`
 * field stores (D10, always in its FULL form), what Claude pastes verbatim into
 * its final message (D11 — Justin reads through iOS remote control, where "see
 * above" is not a thing that exists), and the text the other two media are
 * derived from: `renderAnsi` and `renderHtml` both style THIS output rather than
 * walking the model a second time, so three renderers can never disagree about
 * what a report says. See `classifyReportLine`.
 *
 * NO COLOUR AND NO UNDERLINE, deliberately. Claude Code renders neither, so an
 * escape code here would be pasted into Justin's message as literal `[1m`.
 * Bold field names and a blank line between header groups are the whole of the
 * typography, and they survive the paste.
 *
 * WHAT CHANGED ON 2026-09-14 (Justin, after reading reports #4-#7): a glance
 * line on top; the goal, Claude's next steps and the remaining work merged into
 * one list; asks carrying P0-P4 markers in one numbered sequence; a Deviations
 * section; and Work product / Beads touched dropped from the compact form.
 *
 * PURE. Everything it prints is in the model.
 */

import {classifyReport, MISTAKE_BULLET, POINTER_PREFIX} from './report-lines';
import {COMPACT_LAST_MESSAGE_CAP, priorityMarker} from './report-model';

import type {ModelAsk, ReportModel} from './report-model';

/**
 * The compact report's cap on the echoed last message, applied to text that has
 * already been through the model's own cap.
 *
 * Identical to `report-model`'s `truncate` on purpose: truncating the 1500-char
 * full rendering to 300 has to give the same bytes as truncating the original to
 * 300, or the compact-from-model and compact-from-stored-text paths disagree by
 * one ellipsis.
 */
function truncateForCompact(text: string): string {
  return text.length <= COMPACT_LAST_MESSAGE_CAP
    ? text
    : `${text.slice(0, COMPACT_LAST_MESSAGE_CAP - 1)}…`;
}

const RULE_STOP = '🛑'.repeat(28);
const RULE_OM = '🕉️'.repeat(29);
const RULE_HANDOFF = '⏭️'.repeat(8);

/** The heading every renderer and the stored-text classifier agree on. */
export const ASKS_HEADING = '**Asks — everything I need from you:**';
export const DID_HEADING = '**What I did:**';
export const WORK_PRODUCT_HEADING = '**Work product:**';
export const BEADS_TOUCHED_HEADING = '**Beads touched:**';
export const DEVIATIONS_HEADING = '**Deviations from what you asked for:**';

/**
 * THE ONE SPELLING OF A MISTAKE (D23).
 *
 * The compactor finds must-see deviations by this exact prefix, so it is a
 * constant rather than a literal: a mistake that lost its marker would silently
 * stop reaching the compact report, and the only symptom would be a report that
 * looked reassuringly short.
 */
export const MISTAKE_PREFIX = MISTAKE_BULLET.slice('- '.length);

const DEVIATION_PREFIX: Record<string, string> = {
  fyi: 'ℹ️ FYI — ',
  judgmentCall: '⚖️ Judgment call — ',
  mistake: MISTAKE_PREFIX,
};

function renderAsk(lines: string[], ask: ModelAsk): void {
  const marker = priorityMarker(ask.priority);
  if (ask.kindTag == null) {
    // A carried ask: its bead description already holds the form tag, the
    // context, the lettered options and the default, so it is reproduced rather
    // than reconstructed from a payload that no longer carries the question.
    lines.push(`  ${ask.number}. ${marker} · (${ask.carriedFrom}) (${ask.id})`);
    for (const line of ask.restated) lines.push(`     ${line}`);
    return;
  }
  lines.push(
    `  ${ask.number}. ${marker} · ${ask.kindTag} ${ask.text} (${ask.id})`,
  );
  // The lineage line comes FIRST among the details (D24): "you have seen this
  // question before" is the thing that changes how Justin reads the rest of it.
  if (ask.supersedes != null) lines.push(`     ${ask.supersedes.label}`);
  if (ask.context != null) lines.push(`     Context: ${ask.context}`);
  for (const option of ask.options) {
    const prefix = option.recommended ? '(Recommended) ' : '';
    lines.push(`     ${option.letter}. ${prefix}${option.text}`);
  }
  if (ask.fallback != null) {
    lines.push(`     If you don't answer: ${ask.fallback}`);
  }
}

/**
 * The whole report, as one markdown string. Ends without a trailing newline.
 *
 * COMPACT IS THE FULL REPORT, COMPACTED (D23). `renderMarkdown` renders the full
 * document and then runs `compactStoredReport` over it, rather than rendering a
 * second, shorter document from the same model. That is deliberate and it is the
 * only way the two can be guaranteed identical: `thread show` has the bead's
 * stored text and no model, so it MUST compact text — and if the printed compact
 * report came from a separate rendering pass, the report Justin read in his
 * terminal and the report he read in the paste could differ in ways no test
 * would notice.
 */
export function renderMarkdown(model: ReportModel): string {
  const full = renderFullMarkdown(model);
  return model.full ? full : compactStoredReport(full);
}

/** The complete report — every section. What the thread bead's notes store. */
function renderFullMarkdown(model: ReportModel): string {
  const lines: string[] = [];

  lines.push(RULE_STOP);
  lines.push('');

  // --- THE GLANCE BLOCK (D18) ---------------------------------------------
  //
  // Four facts on one line, in the order Justin asked for them: why it stopped,
  // what happens next, how far along, and how much of it is on him. Everything
  // below this line is detail he reads only if this line makes him want to.
  lines.push(
    `⚡ ${model.glance.stopReasonLabel} · ${model.glance.nextStepLabel} · 📈 ${model.glance.progressPercent}% · ${
      model.glance.p0Count === 0
        ? 'no P0 asks'
        : `🛑 ${model.glance.p0Count} P0 ask${model.glance.p0Count === 1 ? '' : 's'}`
    }`,
  );
  lines.push('');

  if (model.header.emoji) {
    lines.push(
      `📦 ${model.header.repo} · 🌿 ${model.header.branch} · 🌳 ${model.header.worktree} · 🔢 ${model.header.tokens}`,
    );
    lines.push(`🌲 ${model.header.tree}`);
  } else {
    lines.push(
      `**Repo:** ${model.header.repo} · **Branch:** ${model.header.branch} · **Worktree:** ${model.header.worktree}`,
    );
    lines.push(`**Tree:** ${model.header.tree}`);
    lines.push(`**Tokens at stop:** ${model.header.tokens}`);
  }
  lines.push('');

  lines.push(`**Thread:** ${model.title}`);
  lines.push(`**Stop reason:** ${model.glance.stopReasonDetail}`);
  lines.push(`**You asked me to:** ${model.instruction}`);
  if (model.lastUserMessage != null) {
    lines.push(`**Your last message, verbatim:** ${model.lastUserMessage}`);
  }
  if (model.continuesFrom != null) {
    lines.push(`**Continues from:** ${model.continuesFrom}`);
  }
  lines.push('');

  // --- ONE LIST FOR EVERYTHING THAT IS MINE (D18) -------------------------
  lines.push('**What happens next (mine):**');
  lines.push(`- ⚽ Goal: ${model.goal}`);
  if (model.whatHappensNext.length === 0) {
    lines.push('- (nothing — this arc is done)');
  }
  for (const item of model.whatHappensNext) lines.push(`- ➡️ ${item}`);
  lines.push('');

  lines.push(DID_HEADING);
  if (model.did.length === 0) lines.push('- (nothing completed this turn)');
  for (const item of model.did) lines.push(`- ✅ ${item}`);
  lines.push('');

  lines.push('**What I learned:**');
  if (model.learned.length === 0) lines.push('- (nothing worth recording)');
  model.learned.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.text} (${item.disposition})`);
  });
  lines.push('');

  lines.push('**Answers to your questions:**');
  if (model.answers.length === 0) lines.push('- (you asked nothing this turn)');
  model.answers.forEach((item, index) => {
    lines.push(`${index + 1}. Q: ${item.question}`);
    lines.push(`   A: ${item.answer}`);
  });
  lines.push('');

  // --- DEVIATIONS (D17) ---------------------------------------------------
  //
  // Between Answers and Asks, and ALWAYS printed. "none" is a claim that the
  // work matched what Justin asked for — an omitted section would let a report
  // simply not mention that it went somewhere else.
  lines.push(DEVIATIONS_HEADING);
  if (model.deviations.length === 0) lines.push('- none');
  for (const item of model.deviations) {
    lines.push(
      `- ${DEVIATION_PREFIX[item.kind] ?? `${item.kind} — `}${item.text}`,
    );
  }
  lines.push('');

  if (model.discussion.length > 0) {
    lines.push('**Discussion:**');
    for (const item of model.discussion) lines.push(`- ${item}`);
    lines.push('');
  }

  // --- ASKS: ONE NUMBERED SEQUENCE, P0 FIRST (D15) ------------------------
  //
  // No group headings any more. The priority marker IS the grouping, the
  // numbers run straight through every priority, and only options are lettered.
  lines.push(ASKS_HEADING);
  if (model.asks.length === 0) {
    lines.push('- (nothing — you are not blocking anything)');
  }
  for (const ask of model.asks) renderAsk(lines, ask);
  lines.push('');

  lines.push('**Prior asks — closed by this report:**');
  if (model.priorClosed.length === 0) lines.push('- (none closed this time)');
  for (const prior of model.priorClosed) {
    // The phrase in brackets is the rule's "every bead id gets a descriptive
    // phrase" (F1, home-base-p1uj.18). It is dropped entirely — never faked, and
    // never printed as empty brackets — when the ask bead could not be read.
    const phrase = prior.restated == null ? '' : ` (${prior.restated})`;
    lines.push(
      `- ${prior.id}${phrase} — ${prior.disposition}: ${prior.detail}`,
    );
  }

  if (model.workProduct != null) {
    lines.push('');
    lines.push(WORK_PRODUCT_HEADING);
    lines.push(`- ${model.workProduct.summary}`);
    lines.push(
      `- Merge state: ${model.workProduct.merged}${model.workProduct.pr == null ? '' : ` · PR ${model.workProduct.pr}`}`,
    );
  }

  if (model.beadsTouched != null) {
    lines.push('');
    lines.push(BEADS_TOUCHED_HEADING);
    if (model.beadsTouched.length === 0) lines.push('- (none)');
    for (const bead of model.beadsTouched) {
      lines.push(`- ${bead.id} — ${bead.description}`);
    }
  }

  if (model.autofillFailures.length > 0) {
    lines.push('');
    lines.push('**Facts I could not measure:**');
    for (const failure of model.autofillFailures) lines.push(`- ⚠️ ${failure}`);
  }

  if (model.handoff != null) {
    lines.push('');
    lines.push(RULE_HANDOFF);
    lines.push(model.handoff);
    lines.push(RULE_HANDOFF);
  }

  lines.push('');
  lines.push(model.answerLine);
  lines.push(RULE_OM);

  return lines.join('\n');
}

/** The heading the must-see block wears, and the marker that it IS one. */
export const MUST_SEE_HEADING =
  '**MUST-SEE — the only part you have to read:**';

/**
 * The fields the compact report keeps, by their `**Label:**`.
 *
 * The first three are the where-block as it renders with `emojiHeader: false`
 * (D19) — with the knob ON those are emoji lines the classifier calls `where`,
 * and with it off they are ordinary fields. Both spellings have to survive the
 * cut, or turning the knob off silently deletes "which repo is this".
 */
const COMPACT_FIELDS: readonly string[] = [
  'Repo',
  'Tree',
  'Tokens at stop',
  'Thread',
  'You asked me to',
  'Your last message, verbatim',
];

/** The priorities that reach the compact report (D23). */
const MUST_SEE_PRIORITIES: ReadonlySet<number> = new Set([0, 1]);

/** The pointer line's marker — how every surface recognises it. */
export const MORE_LINE_PREFIX = POINTER_PREFIX;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** `Answer: justin-sdk thread answer th-x` → `th-x`, or null when there is none. */
function threadIdOfAnswerLine(line: string | null): string | null {
  if (line == null) return null;
  const match = /^Answer: justin-sdk thread answer (\S+)$/u.exec(line);
  return match?.[1] ?? null;
}

/**
 * COMPACT A REPORT THAT IS ALREADY TEXT (D23) — and the only definition of what
 * "compact" means, since `renderMarkdown` runs its own output through this.
 *
 * WHAT COMPACT IS NOW. v2's compact report was the full report minus two
 * sections; Justin read one on 2026-09-15 and said the frame itself was wrong:
 * "shift the mental framework wholesale from the human is going to read all this
 * lovely text to the human will read the minimum bare essential text… and the
 * human MAY read some of the rest." So compact is no longer a shorter report. It
 * is the MUST-SEE report: where you are, what you were asked, the P0 and P1 asks
 * in full, the mistakes in full, and a pointer to everything else. Nothing is
 * lost — the thread bead's `notes` always store the FULL rendering (D10) and
 * `--full` prints it.
 *
 * WHY THE PIECES ARE FOUND BY TEXT rather than by re-rendering a model: `thread
 * show` has the bead's stored notes and no payload. A second rendering path for
 * the same report is how the terminal and the paste drift apart, so there is
 * one, and it reads the document.
 *
 * AN UNKNOWN PRIORITY IS KEPT, not hidden. A marker this build does not
 * recognise is a fact about the data; dropping it into the "N more asks" count
 * would be exactly the reassuring substitution rule 6 bans.
 */
export function compactStoredReport(markdown: string): string {
  // Already compact — recompacting would recount the hidden asks as zero, which
  // is the one wrong answer this function can give.
  if (markdown.includes(MUST_SEE_HEADING)) return markdown;

  const head: string[] = [];
  const where: string[] = [];
  const mustSeeAsks: string[] = [];
  const mustSeeMistakes: string[] = [];
  let glance: string | null = null;
  let answerLine: string | null = null;
  let hiddenAsks = 0;
  let hiddenDeviations = 0;
  let keepingAsk = false;
  let inDeviations = false;

  for (const line of classifyReport(markdown)) {
    switch (line.kind) {
      case 'glance':
        glance = line.text;
        break;
      case 'where':
        where.push(line.text);
        break;
      case 'heading':
        inDeviations = line.text === DEVIATIONS_HEADING;
        keepingAsk = false;
        break;
      case 'field':
        if (line.label != null && COMPACT_FIELDS.includes(line.label)) {
          head.push(
            line.label === 'Your last message, verbatim'
              ? `**${line.label}:** ${truncateForCompact(line.rest)}`
              : line.text,
          );
        }
        break;
      case 'ask':
        keepingAsk =
          line.priority == null || MUST_SEE_PRIORITIES.has(line.priority);
        if (keepingAsk) mustSeeAsks.push(line.text);
        else hiddenAsks += 1;
        break;
      case 'askDetail':
        if (keepingAsk) mustSeeAsks.push(line.text);
        break;
      case 'mistake':
        mustSeeMistakes.push(line.text);
        break;
      case 'bullet':
        // Only deviations are counted here: every other bulleted section is
        // dropped wholesale and pointed at, not tallied.
        if (inDeviations && line.text !== '- none') hiddenDeviations += 1;
        break;
      case 'command':
        answerLine = line.text;
        break;
      default:
        break;
    }
  }

  const threadId = threadIdOfAnswerLine(answerLine);
  const out: string[] = [RULE_STOP, ''];
  if (glance != null) out.push(glance, '');
  if (where.length > 0) out.push(...where, '');
  if (head.length > 0) out.push(...head, '');

  out.push(MUST_SEE_HEADING);
  if (mustSeeAsks.length === 0 && mustSeeMistakes.length === 0) {
    out.push('- (nothing needs you — nothing went wrong, nothing is blocking)');
  }
  out.push(...mustSeeAsks);
  // A blank line between the two halves: an ask and a mistake want different
  // things from Justin (an answer, and knowing), and run together they read as
  // one list of complaints.
  if (mustSeeAsks.length > 0 && mustSeeMistakes.length > 0) out.push('');
  out.push(...mustSeeMistakes);
  out.push('');

  out.push(
    `${MORE_LINE_PREFIX}${
      hiddenAsks === 0
        ? 'no other asks'
        : `${hiddenAsks} more ${plural(hiddenAsks, 'ask', 'asks')} (P2-P4)`
    } · ${
      hiddenDeviations === 0
        ? 'nothing else to flag'
        : `${hiddenDeviations} more ${plural(hiddenDeviations, 'deviation', 'deviations')}`
    } · everything: ${
      threadId == null
        ? 'NOT RECORDED — no thread bead'
        : `justin-sdk thread show ${threadId} --full`
    }`,
  );
  out.push('');
  out.push(
    answerLine ?? 'Answer: (no thread bead — this report was NOT RECORDED)',
  );
  out.push(RULE_OM);
  return out.join('\n');
}
