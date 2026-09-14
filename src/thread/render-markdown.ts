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

import {COMPACT_DID_CAP, priorityMarker} from './report-model';

import type {ModelAsk, ReportModel} from './report-model';

const RULE_STOP = '🛑'.repeat(28);
const RULE_OM = '🕉️'.repeat(29);
const RULE_HANDOFF = '⏭️'.repeat(8);

/** The heading every renderer and the stored-text classifier agree on. */
export const ASKS_HEADING = '**Asks — everything I need from you:**';
export const DID_HEADING = '**What I did:**';
export const WORK_PRODUCT_HEADING = '**Work product:**';
export const BEADS_TOUCHED_HEADING = '**Beads touched:**';

/** The two sections the compact report leaves on the bead (D18). */
const COMPACT_DROPPED_HEADINGS: readonly string[] = [
  WORK_PRODUCT_HEADING,
  BEADS_TOUCHED_HEADING,
];

/** Says which report you are looking at, so "missing" is never a guess. */
export const COMPACT_FOOTER =
  '**Compact report.** Work product and beads touched are on the thread bead — `justin-sdk thread show --full`.';

/** The line that ends every report, and the anchor the compactor inserts before. */
const ANSWER_LINE_PREFIX = 'Answer: ';

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
  if (ask.context != null) lines.push(`     Context: ${ask.context}`);
  for (const option of ask.options) {
    const prefix = option.recommended ? '(Recommended) ' : '';
    lines.push(`     ${option.letter}. ${prefix}${option.text}`);
  }
  if (ask.fallback != null) {
    lines.push(`     If you don't answer: ${ask.fallback}`);
  }
}

/** The whole report, as one markdown string. Ends without a trailing newline. */
export function renderMarkdown(model: ReportModel): string {
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
  if (model.didOverflow > 0) {
    lines.push(`- (+${model.didOverflow} more on the bead)`);
  }
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
  lines.push('**Deviations from what you asked for:**');
  if (model.deviations.length === 0) lines.push('- none');
  for (const item of model.deviations) lines.push(`- ⚠️ ${item}`);
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
    lines.push(`- ${prior.id} — ${prior.disposition}: ${prior.detail}`);
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

  if (!model.full) {
    lines.push('');
    lines.push(COMPACT_FOOTER);
  }

  lines.push('');
  lines.push(model.answerLine);
  lines.push(RULE_OM);

  return lines.join('\n');
}

/**
 * COMPACT A REPORT THAT IS ALREADY TEXT (D18).
 *
 * `thread show` prints the thread bead's stored `notes`, which D10 requires to
 * be the FULL rendering — the bead has to be a complete status report on its
 * own, and re-deriving one from metadata would give a second, subtly different
 * report for the same bead with no way to tell which one Justin had read. So
 * `--full`/compact at show time is a transformation of the stored text rather
 * than a second rendering pass: this drops the same two sections, applies the
 * same cap, and appends the same footer.
 *
 * IT IS PINNED TO THE RENDERER BY A TEST, not by hope:
 * `compactStoredReport(renderMarkdown(full))` must equal
 * `renderMarkdown(compact)` for the fixture. If the markdown ever moves a
 * heading this function looks for, that test fails rather than `thread show`
 * silently printing a full report with a "Compact report." footer on it.
 */
export function compactStoredReport(markdown: string): string {
  const source = markdown.split('\n');
  const out: string[] = [];
  let dropping = false;
  let didItems = 0;
  let didHidden = 0;
  let inDid = false;

  /** Close the What-I-did list, saying how many items the cap hid. */
  const flushDid = (): void => {
    if (inDid && didHidden > 0) out.push(`- (+${didHidden} more on the bead)`);
    inDid = false;
    didItems = 0;
    didHidden = 0;
  };

  for (const line of source) {
    const isHeading = line.startsWith('**') && line.endsWith(':**');
    if (isHeading || line === '') flushDid();
    if (isHeading) {
      inDid = line === DID_HEADING;
      if (COMPACT_DROPPED_HEADINGS.includes(line)) {
        dropping = true;
        // The blank line that separated this section from the one above goes
        // with it; otherwise every dropped section leaves a gap behind.
        if (out[out.length - 1] === '') out.pop();
        continue;
      }
      dropping = false;
    } else if (dropping) {
      // A dropped section ends at the next heading, at the handoff rule, or at
      // the answer line — the three things that can follow it.
      if (line.startsWith(ANSWER_LINE_PREFIX) || line.startsWith(RULE_HANDOFF)) {
        dropping = false;
      } else {
        continue;
      }
    }

    if (inDid && line.startsWith('- ✅ ')) {
      didItems += 1;
      if (didItems > COMPACT_DID_CAP) {
        didHidden += 1;
        continue;
      }
    }
    out.push(line);
  }
  flushDid();

  // The footer goes exactly where `renderMarkdown` puts it: last, one blank
  // line above the answer line. Whatever blank lines dropping a trailing
  // section left behind are normalised away first, so the two agree byte for
  // byte however many sections were removed.
  const answerIndex = out.findIndex((line) =>
    line.startsWith(ANSWER_LINE_PREFIX),
  );
  if (answerIndex > 0 && !out.includes(COMPACT_FOOTER)) {
    let at = answerIndex;
    while (at > 0 && out[at - 1] === '') {
      out.splice(at - 1, 1);
      at -= 1;
    }
    out.splice(at, 0, '', COMPACT_FOOTER, '');
  }
  return out.join('\n');
}
