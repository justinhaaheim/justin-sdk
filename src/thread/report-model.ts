/**
 * THE REPORT MODEL (home-base-p1uj D14) — one structure, three renderers.
 *
 * `buildReportModel` is the only place that decides WHAT a report says. The
 * renderers decide only how it looks: `renderMarkdown` (what Claude pastes into
 * its final message), `renderAnsi` (Justin's terminal), `renderHtml` (the
 * browser answer page's report panel). None of them touches the payload.
 *
 * WHY A MODEL AT ALL, when there used to be one `renderReport`. Justin read
 * reports #4-#7 on 2026-09-14 and said the format was too long, the top block a
 * wall of text, and the asks unprioritised. Fixing that meant a compact form and
 * a full form, a glance line, priority markers and three media — and doing that
 * inside one string-building function would have produced four functions that
 * disagreed with each other within a week. The decisions live here; the media
 * live next door.
 *
 * COMPACT IS THE DEFAULT (D18). `full: false` drops Work product and Beads
 * touched from the PRINTED report, caps What I did at six items, trims the
 * echoed last message and the prior-ask details. Nothing is lost by it: the
 * thread bead's `notes` field always stores the FULL markdown (D10), so `bd
 * show` alone is still a complete report, and `--full` prints it on demand. The
 * model records `full` so every renderer says which one it is looking at.
 *
 * PURE. No I/O, no clock, no environment — everything it reads is an argument.
 */

import {formatTokens} from '../usage-check';

import {askKindTag, compareAsksForNumbering, optionLetter} from './render';
import {
  ASK_PRIORITY_BLOCKING,
  type ThreadAsk,
  type ThreadDeviation,
  type ThreadReportPayload,
} from './schema';

import type {CarriedAsk, NumberedAsk} from './render';
import type {ThreadFacts} from './facts';

/**
 * How much of Justin's last message the compact report echoes back (D23).
 *
 * 300, down from v2's 600: the compact report is now the must-see report, and
 * the echo is a memory hook — enough to recognise the conversation, not enough
 * to re-read it. The full report keeps the 1500-character version.
 */
export const COMPACT_LAST_MESSAGE_CAP = 300;

/** …and the full one, which is the cap that has always applied. */
export const FULL_LAST_MESSAGE_CAP = 1500;

const STOP_REASON_LABEL: Record<string, string> = {
  blocked: '🛑 Blocked on you',
  completed: '✅ Work completed',
  error: '💥 Error',
  needsYou: '🙋 Needs you',
  other: '• Other',
  tokenLimit: '⚠️ Token limit',
};

/**
 * What each `nextStep` says in the glance line (D16).
 *
 * Spelled out rather than printed as the enum value: `answerAsks` is a key, "you
 * answer, then I go" is what Justin needs to read in half a second.
 */
const NEXT_STEP_LABEL: Record<string, string> = {
  answerAsks: '🙋 needs your answers',
  continue: '🔁 I keep going',
  done: '🏁 done',
  handoff: '⏭️ handing off',
  testOnDevice: '📱 test on device',
};

const MERGE_LABEL: Record<string, string> = {
  merged: 'merged',
  notApplicable: 'not applicable',
  unmerged: 'UNMERGED',
  unknown: 'UNKNOWN',
};

/**
 * The marker a priority wears in the markdown, and therefore in every medium:
 * ansi and html both recover the priority from it (see `classifyReportLine`).
 *
 * P0 is unmistakable, P1/P2 are plain, P3/P4 are parenthesised so the eye skips
 * them — which is the entire point of the scale (D15).
 */
export function priorityMarker(priority: number): string {
  switch (priority) {
    case 0:
      return '🛑 P0';
    case 1:
      return 'P1';
    case 2:
      return 'P2';
    case 3:
      return '(P3)';
    case 4:
      return '(P4)';
    default:
      return `(P? ${priority})`;
  }
}

/** "497k". Thousands, rounded — the glance line has no room for exact digits. */
export function compactTokens(value: number): string {
  return `${Math.round(value / 1000)}k`;
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

/** One option of a `pick`, already lettered. */
export interface ModelOption {
  letter: string;
  recommended: boolean;
  text: string;
}

/**
 * One ask, numbered.
 *
 * ONE SEQUENCE ACROSS EVERY PRIORITY (D15, D11.3): `number` is assigned here,
 * once, in `compareAsksForNumbering` order, and every renderer prints the number
 * it is given. That is what makes "1 yes, 2 b" land on the asks Justin meant —
 * the `thread answer` walk sorts the same way. Nothing in any medium may letter
 * an ask; letters belong to `options` and nowhere else.
 */
export interface ModelAsk {
  /** The hook back into what this is about. Null for a carried ask, whose
   *  restated body already carries its own context. */
  context: string | null;
  /** What Claude does if this is never answered. Null for a carried ask. */
  fallback: string | null;
  /** "carried from report #3", when this ask came from an earlier report. */
  carriedFrom: string | null;
  /** The ask bead id, or the missing-id label. */
  id: string;
  /** "[Approve Y/n]" etc. Null for a carried ask. */
  kindTag: string | null;
  number: number;
  options: ModelOption[];
  priority: number;
  /** The full restated body of a carried ask, line by line. Empty for a new one. */
  restated: string[];
  /**
   * The ask this one RESTATES, already labelled (D24), or null.
   *
   * It is a label rather than a bare id because a bare id is the failure the
   * whole epic exists to stop: `th-9kq.2` tells Justin nothing, "supersedes
   * th-9kq.2 from th-eru report #7" tells him this is the question he was asked
   * last session and is now being asked again.
   */
  supersedes: {id: string; label: string} | null;
  /** The question or action. Empty for a carried ask (it is in `restated`). */
  text: string;
}

/** Where a superseded ask came from, for its label. Null means "not recorded". */
export interface SupersedeSource {
  fromReport: number | null;
  fromThread: string | null;
}

/** A question Justin asked, restated before its answer. */
export interface ModelAnswer {
  answer: string;
  question: string;
}

export interface ModelGlance {
  /** How many P0 asks are open after this report — carried ones included. */
  p0Count: number;
  nextStep: string;
  nextStepLabel: string;
  progressPercent: number;
  stopReasonDetail: string;
  stopReasonLabel: string;
}

/** The where-am-I block: repo, branch, worktree, tree state, tokens. */
export interface ModelHeader {
  branch: string;
  /** Emoji-prefixed values with no field titles (D19), or titled fields. */
  emoji: boolean;
  repo: string;
  /** "clean · 2 ahead / 0 behind · HEAD abc123456789" */
  tree: string;
  /** "497k", "497k / 470k", or the UNKNOWN sentence. */
  tokens: string;
  worktree: string;
}

export interface ReportModel {
  answers: ModelAnswer[];
  asks: ModelAsk[];
  /** Null in the compact report, which leaves them on the bead (D18). */
  beadsTouched: {description: string; id: string}[] | null;
  /** The command Justin answers with, or the no-bead sentence. */
  answerLine: string;
  continuesFrom: string | null;
  deviations: ThreadDeviation[];
  /** Completed items. The compact report does not print them at all (D23). */
  did: string[];
  discussion: string[];
  /** Measurements that failed (D7). Never silently absent. */
  autofillFailures: string[];
  full: boolean;
  /** How many deviations are of kind `mistake` — the only kind Justin SEES. */
  mistakeCount: number;
  glance: ModelGlance;
  /** The ARC's goal, not this turn's. */
  goal: string;
  handoff: string | null;
  header: ModelHeader;
  instruction: string;
  /** Justin's last message, verbatim, capped. Null when it could not be read. */
  lastUserMessage: string | null;
  learned: {disposition: string; text: string}[];
  /** Prior asks CLOSED by this report. The carried ones are live asks, above. */
  priorClosed: ModelPriorAsk[];
  title: string;
  /** Goal, then Claude's next steps, then what remains — one list (D18). */
  whatHappensNext: string[];
  /** Null in the compact report (D18). */
  workProduct: {merged: string; pr: string | null; summary: string} | null;
}

/**
 * One prior ask this report closes (home-base-p1uj.18, F1).
 *
 * `restated` is why this is a named type rather than an inline shape. The line
 * used to print a BARE BEAD ID — `- th-9kq.2 — answered: …` — which the rule
 * driving this whole tool explicitly forbids ("every bead id gets a descriptive
 * phrase"): Justin does not know what `th-9kq.2` is and will not look it up. The
 * phrase is the ask's own first line, taken from the bead report.ts already
 * fetched, so it costs no extra read.
 *
 * NULL IS A REAL VALUE and it renders as nothing at all. It means the ask bead
 * was not among the ones we could read — closed long ago, on a thread we did not
 * fetch, or simply gone — and in that case the line prints the id alone. A
 * fabricated phrase would be worse than a bare id, because a bare id is
 * obviously incomplete and an invented description reads as a fact.
 */
export interface ModelPriorAsk {
  detail: string;
  disposition: string;
  id: string;
  /** The ask's first line, or null when the bead could not be read. */
  restated: string | null;
}

export interface BuildReportModelOptions {
  /** Ask bead ids, parallel to `payload.asks`. Null means the bead was not made. */
  askIds: (string | null)[];
  /** Still-open asks from earlier reports, numbered in the same sequence (F4). */
  carried?: readonly CarriedAsk[];
  /**
   * The asks this report closes, as the write path planned them (D24). Absent
   * falls back to `payload.priorAsks` — see `buildReportModel`.
   */
  closed?: readonly {detail: string; disposition: string; id: string}[];
  /** D19. True (the default) = emoji-prefixed values; false = titled fields. */
  emojiHeader?: boolean;
  facts: ThreadFacts;
  /** D18. False (the default) = the compact report. */
  full?: boolean;
  /** What a null `askIds` entry means — "(NOT RECORDED)" or "(ask ids pending)". */
  missingAskIdLabel?: string;
  payload: ThreadReportPayload;
  /**
   * Ask id → the ask's restated text, for the prior asks this report CLOSES
   * (F1). Built by report.ts from the ask beads it has already fetched — its own
   * and the continued thread's. An id that is absent from the map renders
   * without a phrase; nothing is ever invented for it.
   */
  priorAskRestated?: ReadonlyMap<string, string>;
  /** Which report this is (1-based); orders this report's asks after carried ones. */
  reportCount?: number;
  /**
   * Superseded ask id → where it came from (D24), for the restating ask's label.
   * An id absent from the map is labelled without lineage; nothing is invented.
   */
  supersedeSources?: ReadonlyMap<string, SupersedeSource>;
  /** The thread bead id, or null when bd never took the report. */
  threadId: string | null;
  /**
   * usage-check's resolved wrap-up threshold for this session's role, when the
   * config sets one (D19). A number renders "497k / 470k"; null renders "497k".
   * Null is the honest value for "no threshold is configured" — it is NOT the
   * same as a threshold of zero, and the renderers never invent one.
   */
  wrapUpAt?: number | null;
}

/**
 * The one line of an ask that identifies it (F1).
 *
 * An ask bead's description is the whole ask — the form tag, the context, the
 * lettered options, the default — and a closed-ask line has room for a phrase,
 * not a paragraph. The first non-empty line is what Justin wrote the ask as, so
 * it is the phrase that makes the id recognisable.
 *
 * An absent or all-whitespace source returns null, NOT an empty string: the
 * renderers branch on null to drop the parenthetical entirely, and `''` would
 * print an empty pair of brackets that looks like a bug.
 */
export function firstLineOfAsk(text: string | undefined): string | null {
  if (text == null) return null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
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

function renderTree(facts: ThreadFacts): string {
  const dirty =
    facts.dirty == null
      ? 'dirty UNKNOWN'
      : facts.dirty
        ? 'UNCOMMITTED CHANGES'
        : 'clean';
  const divergence =
    facts.aheadBehind == null
      ? 'ahead/behind UNKNOWN'
      : `${facts.aheadBehind.ahead} ahead / ${facts.aheadBehind.behind} behind`;
  const head =
    facts.headSha == null
      ? 'HEAD UNKNOWN'
      : `HEAD ${facts.headSha.slice(0, 12)}`;
  return `${dirty} · ${divergence} · ${head}`;
}

/**
 * The token reading, in the shape the header wants (D19).
 *
 * `497k / 470k` only when usage-check's resolved config for this role actually
 * carries a numeric `wrapUpAt`. Without one there is no second number to show,
 * and inventing a plausible budget would be a measurement nobody made.
 */
function renderTokens(
  facts: ThreadFacts,
  emoji: boolean,
  wrapUpAt: number | null,
): string {
  if (facts.tokensAtStop == null) {
    return 'UNKNOWN (see autofill failures)';
  }
  if (!emoji) {
    return `${formatTokens(facts.tokensAtStop)} tokens of context`;
  }
  const used = compactTokens(facts.tokensAtStop);
  return wrapUpAt == null ? used : `${used} / ${compactTokens(wrapUpAt)}`;
}

/**
 * "supersedes th-9kq.2 from th-eru report #7", and the honest shorter forms when
 * the superseded bead records no report number or came from this same thread.
 */
export function supersedeLabel(
  id: string,
  source: SupersedeSource | undefined,
): string {
  const thread =
    source?.fromThread == null || source.fromThread === ''
      ? null
      : source.fromThread;
  const report = source?.fromReport ?? null;
  const where =
    report == null
      ? thread == null
        ? ''
        : ` from ${thread}`
      : thread == null
        ? ` from report #${report}`
        : ` from ${thread} report #${report}`;
  return `Restated — supersedes ${id}${where}, now closed`;
}

function modelAskFromPayload(
  ask: ThreadAsk,
  id: string,
  number: number,
  sources: ReadonlyMap<string, SupersedeSource> | undefined,
): ModelAsk {
  const supersedes =
    ask.supersedes == null || ask.supersedes === '' ? null : ask.supersedes;
  return {
    carriedFrom: null,
    context: ask.context,
    fallback: ask.default,
    id,
    kindTag: askKindTag(ask),
    number,
    options: ask.options.map((option, index) => ({
      letter: optionLetter(index),
      recommended: option.recommended,
      text: option.text,
    })),
    priority: ask.priority,
    restated: [],
    supersedes:
      supersedes == null
        ? null
        : {
            id: supersedes,
            label: supersedeLabel(supersedes, sources?.get(supersedes)),
          },
    text: ask.text,
  };
}

/**
 * "carried from report #3", "carried from th-eru report #7", or the honest
 * vaguer forms when the bead records no report number (D21).
 *
 * The THREAD is named whenever the ask crossed a session boundary, because that
 * is the case where "#7" on its own means nothing: it is report #7 of a thread
 * this report is not.
 */
function carriedFromLabel(carried: CarriedAsk): string {
  const thread =
    carried.fromThread == null || carried.fromThread === ''
      ? null
      : carried.fromThread;
  if (carried.fromReport == null) {
    return thread == null
      ? 'carried from an earlier report'
      : `carried from ${thread}`;
  }
  return thread == null
    ? `carried from report #${carried.fromReport}`
    : `carried from ${thread} report #${carried.fromReport}`;
}

function modelAskFromCarried(carried: CarriedAsk, number: number): ModelAsk {
  return {
    carriedFrom: carriedFromLabel(carried),
    context: null,
    fallback: null,
    id: carried.id,
    kindTag: null,
    number,
    options: [],
    priority: carried.priority,
    restated: carried.restated.split('\n'),
    supersedes: null,
    text: '',
  };
}

/**
 * Goal, Claude's next steps and what remains, merged into ONE list (D18).
 *
 * Justin's words: next steps and remaining work were "the same thing" split
 * across two headings he had to reconcile himself. `nextSteps` leads because it
 * is the immediate move; `remaining` follows because it is the rest of the arc.
 * Deduped by exact string so an item written into both does not appear twice.
 */
function buildWhatHappensNext(payload: ThreadReportPayload): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...(payload.nextSteps ?? []),
    ...payload.progress.remaining,
  ]) {
    if (seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

export function buildReportModel(
  options: BuildReportModelOptions,
): ReportModel {
  const {askIds, facts, payload, threadId} = options;
  const full = options.full === true;
  const emoji = options.emojiHeader !== false;
  const missingLabel = options.missingAskIdLabel ?? '(NOT RECORDED)';
  const carried = options.carried ?? [];
  // A brand-new ask carries THIS report's number, so it sorts after every
  // carried one. Absent means "newer than anything carried" (F12).
  const thisReport = options.reportCount ?? Number.MAX_SAFE_INTEGER;

  const entries: {ask: (n: number) => ModelAsk; sort: NumberedAsk}[] = [
    ...carried.map((item) => ({
      ask: (n: number) => modelAskFromCarried(item, n),
      sort: {
        askIndex: item.askIndex,
        id: item.id,
        priority: item.priority,
        reportCount: item.fromReport,
      },
    })),
    ...payload.asks.map((ask, index) => ({
      ask: (n: number) =>
        modelAskFromPayload(
          ask,
          askIds[index] ?? missingLabel,
          n,
          options.supersedeSources,
        ),
      sort: {
        askIndex: index,
        id: askIds[index] ?? '',
        priority: ask.priority,
        reportCount: thisReport,
      },
    })),
  ].sort((a, b) => compareAsksForNumbering(a.sort, b.sort));
  const asks = entries.map((entry, index) => entry.ask(index + 1));

  const did = payload.did;
  // The asks this report CLOSES, as report.ts planned them (D24): the ones the
  // payload dispositioned, the ones the auto-close took the default on, and the
  // ones a new ask superseded. `payload.priorAsks` is the fallback for callers
  // that have no plan (tests, and the renderers' own fixtures) — it is the same
  // list minus the two kinds only the write path can know about.
  const closed = options.closed ?? payload.priorAsks ?? [];
  const priorClosed: ModelPriorAsk[] = closed.map((prior) => ({
    detail: prior.detail,
    disposition: prior.disposition,
    id: prior.id,
    restated: firstLineOfAsk(options.priorAskRestated?.get(prior.id)),
  }));

  return {
    answerLine:
      threadId == null
        ? 'Answer: (no thread bead — this report was NOT recorded)'
        : `Answer: justin-sdk thread answer ${threadId}`,
    answers: payload.answers.map((item) => ({
      answer: item.answer,
      question: item.question,
    })),
    asks,
    autofillFailures: facts.autofillFailures,
    beadsTouched: full
      ? payload.beadsTouched.map((bead) => ({
          description: bead.description,
          id: bead.id,
        }))
      : null,
    continuesFrom:
      payload.continuesFrom == null || payload.continuesFrom === ''
        ? null
        : payload.continuesFrom,
    deviations: payload.deviations,
    did,
    discussion: payload.discussion,
    full,
    mistakeCount: payload.deviations.filter((item) => item.kind === 'mistake')
      .length,
    glance: {
      nextStep: payload.nextStep,
      nextStepLabel: NEXT_STEP_LABEL[payload.nextStep] ?? payload.nextStep,
      // Every open P0 after this report, carried ones included — the same
      // whole-thread claim `metadata.blockingAskCount` makes. Counting only
      // this payload's asks would report 0 while a carried P0 sat unanswered,
      // which is rule 6 in the reassuring direction.
      p0Count: asks.filter((ask) => ask.priority === ASK_PRIORITY_BLOCKING)
        .length,
      progressPercent: payload.progress.percent,
      stopReasonDetail: payload.stopReason.detail,
      stopReasonLabel:
        STOP_REASON_LABEL[payload.stopReason.kind] ?? payload.stopReason.kind,
    },
    goal: payload.goal,
    handoff:
      payload.handoff == null || payload.handoff === ''
        ? null
        : payload.handoff,
    header: {
      branch: orUnknown(facts.branch),
      emoji,
      repo: orUnknown(facts.repo),
      tokens: renderTokens(facts, emoji, options.wrapUpAt ?? null),
      tree: renderTree(facts),
      worktree: renderWorktree(facts),
    },
    instruction: payload.instruction,
    lastUserMessage:
      facts.lastUserMessage == null
        ? null
        : truncate(
            facts.lastUserMessage,
            full ? FULL_LAST_MESSAGE_CAP : COMPACT_LAST_MESSAGE_CAP,
          ),
    learned: payload.learned.map((item) => ({
      disposition: item.disposition,
      text: item.text,
    })),
    priorClosed,
    title: payload.title,
    whatHappensNext: buildWhatHappensNext(payload),
    workProduct: full
      ? {
          merged:
            MERGE_LABEL[payload.workProduct.merged] ??
            payload.workProduct.merged,
          pr:
            payload.workProduct.pr == null || payload.workProduct.pr === ''
              ? null
              : payload.workProduct.pr,
          summary: `${payload.workProduct.kind}: ${payload.workProduct.summary}`,
        }
      : null,
  };
}
