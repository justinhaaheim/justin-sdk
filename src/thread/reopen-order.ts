/**
 * The reopen order (home-base-kwand.6, decision D6 of epic home-base-kwand,
 * gap G7). Justin, 2026-11-17: "Where do you suggest we start with
 * reopening/restarting things? I'm honestly inclined to close down all the
 * cmux windows and only reopen what we need."
 *
 * ONE order, used by `thread open`, the dashboard's Dropped view and its
 * restart grouping: starred first, then waiting on Justin, then cut off
 * mid-turn, then the rest. Inside each tier the newest activity comes first,
 * and a session whose last activity is unknown comes last in its tier. Each
 * session says which tier put it there, in words (`reopenReason`).
 *
 * Every fact here is one the inbox already derives; nothing is measured again:
 * - starred: the chain's flags hold ⭐ (`STAR_LABEL`, home-base-kwand.5);
 * - waiting on you: an open P0 question, which is D3 rule 1 and the
 *   "🛑 Needs you" section (session-status.ts `waiting`), also when unsent
 *   text moved the card to "✍️ Unsent text" from beneath "Needs you";
 * - cut off mid-turn: the transcript's ending (home-base-kwand.4, D5).
 */
import type {InboxSection} from './session-card';
import type {InboxRow} from './session-inbox';
import type {StatusCounts} from './session-status';

import {parseInstant} from './answer-store';
import {ageWords} from './part-one';
import {STAR_LABEL} from './session-flags';
import {CUT_OFF_MARK, endingWhen} from './transcript-ending';

/** The tiers, first to last (D6). */
export const REOPEN_TIERS = ['starred', 'waiting', 'cutOff', 'recent'] as const;
export type ReopenTier = (typeof REOPEN_TIERS)[number];

/** The order in words, for `--help`, plan headers and the dashboard. */
export const REOPEN_ORDER_WORDS =
  'starred first, then waiting on you (an open blocking question), then cut off mid-turn, then the rest; newest activity first inside each';

/** What the order reads of one session. */
export interface ReopenFacts {
  /** The cut-off time when its last turn was cut off mid-turn (null: time unknown), else absent. */
  cutOff: {at: string | null} | null;
  lastActivityAt: string | null;
  /** Its chain carries ⭐. */
  starred: boolean;
  /**
   * Waiting on Justin: his open blocking questions on it (null when the
   * section says so and the count was not read), or null when it is not.
   */
  waiting: {questions: number | null} | null;
}

/** The facts besides the activity, as a candidate carries them beside its own `lastActivityAt`. */
export type ReopenSignals = Omit<ReopenFacts, 'lastActivityAt'>;

/** No star, no question waiting, not cut off: the last tier, by activity alone. */
export const NO_REOPEN_SIGNALS: ReopenSignals = {
  cutOff: null,
  starred: false,
  waiting: null,
};

/** Where a session sits in the order, and why, in words. */
export interface ReopenReason {
  /** "⭐ starred", "🙋 waiting on you: 2 questions", "✂️ cut off mid-turn at 6:39pm", "🕒 last active 3 days ago". */
  text: string;
  tier: ReopenTier;
}

/** What the comparator reads: the tier, then the activity. */
export interface ReopenKey {
  lastActivityAt: string | null;
  tier: ReopenTier;
}

/** The first tier whose fact holds (D6). */
export function reopenTier(facts: ReopenFacts): ReopenTier {
  if (facts.starred) return 'starred';
  if (facts.waiting != null) return 'waiting';
  if (facts.cutOff != null) return 'cutOff';
  return 'recent';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The tier and the words that say why the session is there. `ageText` says
 * how long ago, "3 days ago" by default; the dashboard passes its own "1d 3h
 * ago", so a row reads the same as the rest of its screen.
 */
export function reopenReason(
  facts: ReopenFacts,
  now: Date,
  ageText: (at: Date, now: Date) => string = ageWords,
): ReopenReason {
  const tier = reopenTier(facts);
  switch (tier) {
    case 'starred':
      return {text: '⭐ starred', tier};
    case 'waiting': {
      const count = facts.waiting?.questions ?? null;
      return {
        text:
          count == null || count === 0
            ? '🙋 waiting on you'
            : `🙋 waiting on you: ${plural(count, 'question', 'questions')}`,
        tier,
      };
    }
    case 'cutOff': {
      const at = facts.cutOff?.at ?? null;
      return {
        text: `${CUT_OFF_MARK} cut off mid-turn${at == null ? '' : ` at ${endingWhen(at, now)}`}`,
        tier,
      };
    }
    case 'recent': {
      const ms =
        facts.lastActivityAt == null
          ? null
          : parseInstant(facts.lastActivityAt);
      return {
        text:
          ms == null
            ? '🕒 last activity unknown'
            : `🕒 last active ${ageText(new Date(ms), now)}`,
        tier,
      };
    }
  }
}

/** The tier's place in the order, 0 first. */
export function reopenRank(tier: ReopenTier): number {
  return REOPEN_TIERS.indexOf(tier);
}

/**
 * D6: the tier first, then the newest activity; an unknown activity sorts
 * last inside its tier (it is not known to be recent).
 */
export function compareReopen(a: ReopenKey, b: ReopenKey): number {
  const byTier = reopenRank(a.tier) - reopenRank(b.tier);
  if (byTier !== 0) return byTier;
  const ms = (key: ReopenKey): number =>
    (key.lastActivityAt == null ? null : parseInstant(key.lastActivityAt)) ??
    -Infinity;
  const bMs = ms(b);
  const aMs = ms(a);
  if (aMs === bMs) return 0;
  return bMs > aMs ? 1 : -1;
}

/** `items` in the reopen order (a copy; equal keys keep their order). */
export function sortForReopen<T>(
  items: readonly T[],
  keyOf: (item: T) => ReopenKey,
): T[] {
  return [...items].sort((a, b) => compareReopen(keyOf(a), keyOf(b)));
}

/** The fields of an inbox row the signals come from. */
export type ReopenRowInput = Pick<InboxRow, 'ending' | 'flags' | 'section'> & {
  card: {unsent: {beneath: InboxSection} | null};
  loaded: {counts: Pick<StatusCounts, 'blocking'>} | null;
};

/**
 * The signals from the facts the inbox derived, in the plain shape both the
 * SDK's rows and the dashboard's zod rows can give, so the rule is written
 * once: ⭐ in the chain's flag labels; an open blocking question, or the
 * Needs you section (where unsent text sits beneath it too); a cut-off ending.
 */
export function reopenSignals(input: {
  /** Open P0 questions; null when the session's model did not load. */
  blocking: number | null;
  /** The cut-off ending's time, or null when its last turn was not cut off. */
  cutOff: {at: string | null} | null;
  /** The chain's flag labels; null when none were read. */
  flagLabels: readonly string[] | null;
  section: string;
  /** The section a ✍️ card sits beneath; null without unsent text. */
  unsentBeneath: string | null;
}): ReopenSignals {
  const {blocking} = input;
  const needsYou =
    input.section === 'needsYou' || input.unsentBeneath === 'needsYou';
  return {
    cutOff: input.cutOff,
    starred: input.flagLabels?.includes(STAR_LABEL) === true,
    waiting:
      (blocking ?? 0) > 0 || needsYou
        ? {questions: blocking != null && blocking > 0 ? blocking : null}
        : null,
  };
}

/** An inbox row's signals: what `thread open` reads. */
export function reopenSignalsOfRow(row: ReopenRowInput): ReopenSignals {
  return reopenSignals({
    blocking: row.loaded?.counts.blocking ?? null,
    cutOff: row.ending.kind === 'cutOff' ? {at: row.ending.at} : null,
    flagLabels: row.flags?.labels ?? null,
    section: row.section,
    unsentBeneath: row.card.unsent?.beneath ?? null,
  });
}
