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
  CLOSING_DISPOSITIONS,
  type ThreadAsk,
  type ThreadReportPayload,
} from './schema';

import type {CarriedAsk, NumberedAsk} from './render';
import type {ThreadFacts} from './facts';

/** How many `did` items the compact report prints before it says "+N more". */
export const COMPACT_DID_CAP = 6;

/** How much of Justin's last message the compact report echoes back (D18). */
export const COMPACT_LAST_MESSAGE_CAP = 600;

/** …and the full one, which is the cap that has always applied. */
export const FULL_LAST_MESSAGE_CAP = 1500;

/** How much of a closed prior ask's detail the compact report keeps. */
export const COMPACT_PRIOR_DETAIL_CAP = 120;

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
  /** The question or action. Empty for a carried ask (it is in `restated`). */
  text: string;
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
  deviations: string[];
  /** Completed items, already capped for the compact report. */
  did: string[];
  /** How many `did` items the cap hid. 0 when none were. */
  didOverflow: number;
  discussion: string[];
  /** Measurements that failed (D7). Never silently absent. */
  autofillFailures: string[];
  full: boolean;
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
  priorClosed: {detail: string; disposition: string; id: string}[];
  title: string;
  /** Goal, then Claude's next steps, then what remains — one list (D18). */
  whatHappensNext: string[];
  /** Null in the compact report (D18). */
  workProduct: {merged: string; pr: string | null; summary: string} | null;
}

export interface BuildReportModelOptions {
  /** Ask bead ids, parallel to `payload.asks`. Null means the bead was not made. */
  askIds: (string | null)[];
  /** Still-open asks from earlier reports, numbered in the same sequence (F4). */
  carried?: readonly CarriedAsk[];
  /** D19. True (the default) = emoji-prefixed values; false = titled fields. */
  emojiHeader?: boolean;
  facts: ThreadFacts;
  /** D18. False (the default) = the compact report. */
  full?: boolean;
  /** What a null `askIds` entry means — "(NOT RECORDED)" or "(ask ids pending)". */
  missingAskIdLabel?: string;
  payload: ThreadReportPayload;
  /** Which report this is (1-based); orders this report's asks after carried ones. */
  reportCount?: number;
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
    facts.headSha == null ? 'HEAD UNKNOWN' : `HEAD ${facts.headSha.slice(0, 12)}`;
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

function modelAskFromPayload(
  ask: ThreadAsk,
  id: string,
  number: number,
): ModelAsk {
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
        modelAskFromPayload(ask, askIds[index] ?? missingLabel, n),
      sort: {
        askIndex: index,
        id: askIds[index] ?? '',
        priority: ask.priority,
        reportCount: thisReport,
      },
    })),
  ].sort((a, b) => compareAsksForNumbering(a.sort, b.sort));
  const asks = entries.map((entry, index) => entry.ask(index + 1));

  const did = full ? payload.did : payload.did.slice(0, COMPACT_DID_CAP);
  const priorClosed = payload.priorAsks
    .filter((prior) => CLOSING_DISPOSITIONS.has(prior.disposition))
    .map((prior) => ({
      detail: full
        ? prior.detail
        : truncate(prior.detail, COMPACT_PRIOR_DETAIL_CAP),
      disposition: prior.disposition,
      id: prior.id,
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
    didOverflow: payload.did.length - did.length,
    discussion: payload.discussion,
    full,
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
      payload.handoff == null || payload.handoff === '' ? null : payload.handoff,
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
            MERGE_LABEL[payload.workProduct.merged] ?? payload.workProduct.merged,
          pr:
            payload.workProduct.pr == null || payload.workProduct.pr === ''
              ? null
              : payload.workProduct.pr,
          summary: `${payload.workProduct.kind}: ${payload.workProduct.summary}`,
        }
      : null,
  };
}
