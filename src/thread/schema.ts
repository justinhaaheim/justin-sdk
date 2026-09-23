/**
 * The report payload Claude writes, as a zod schema (home-base-p1uj D8).
 *
 * WHAT THIS IS. A status report used to be prose that Justin had to parse. It
 * is now a data structure: `thread report` takes this JSON, validates it,
 * attaches the facts Claude should never type (see facts.ts), writes it to a
 * `thread` bead in the threads repo and renders the familiar text report from it.
 * Everything in here is therefore something only Claude can know — nothing that
 * can be measured belongs in this file.
 *
 * STRICT (`z.strictObject` throughout): an unknown key is a validation error
 * that NAMES the key. This deliberately departs from sdk-config.ts, which is
 * loose, and the difference is lifetime. A config FILE is long-lived and is read
 * by many SDK versions, so looseness there buys real forward compatibility: an
 * older CLI must not reject a file a newer one wrote. A report payload has no
 * such lifetime — it is written and read by the SAME binary, seconds apart, by a
 * Claude that just had the skeleton printed at it. The only thing looseness
 * could buy here is a silently dropped typo: `progres: {...}` would vanish, the
 * report would render without it, and nothing would ever say so. That is rule 6
 * arriving through the validation layer — a mis-keyed field is a FAILED field,
 * not an absent one. Changed 2026-09-12 (home-base-p1uj.2) after dispatch 2
 * raised it as ask jl-e9f4.3; `schemaVersion` is the forward-compatibility
 * mechanism that looseness was standing in for.
 *
 * ANOTHER THING IT IS STRICT ABOUT is `beadsTouched[].description`. A bare bead
 * id is the single most common way a report goes stale on arrival: sampling ten
 * real reports on 2026-09-12 found ids like `z36o` and `ueue` dropped with no
 * gloss, and Justin cannot look them up. A missing description is a validation
 * error, not a warning.
 *
 * zod is imported HERE and nowhere on the CLI's eager graph: the thread
 * commands `await import` this module from their handlers, so the hot-path
 * hooks (time-check, usage-check) never pay for it. See src/cli.ts.
 */

import type {ThreadFacts} from './facts';

import {z} from 'zod';

/** Bumped when a field's MEANING changes, not when one is added. */
export const THREAD_SCHEMA_VERSION = 3;

/**
 * The version this schema still ACCEPTS and migrates (D15, D24).
 *
 * Not politeness — necessity. `home-base/bin/justin-sdk` is a symlink into this
 * source tree, so every Claude Code session on the machine runs whatever is
 * checked out here, while the rule text that tells Claude what to write updates
 * separately. For the whole interval between the two, live sessions and spooled
 * reports carry older payloads. Rejecting them would not fall back to the plain
 * text report either: the rule branches on `THREADS: DISABLED` and on
 * command-not-found, and a validation refusal is neither.
 *
 * v1 is still accepted alongside v2 rather than retired with the v3 bump: the
 * migrations chain (v1 → v2 → v3), so keeping it costs one function call, and
 * dropping it would strand any v1 report still sitting in the spool — a report
 * that cannot drain is a report that silently never reaches a bead.
 */
export const THREAD_SCHEMA_MIN_ACCEPTED_VERSION = 1;

export const STOP_REASON_KINDS = [
  'completed',
  'blocked',
  'tokenLimit',
  'needsYou',
  'error',
  'other',
] as const;

/** Every ask is one of four things Justin has to do (D3). */
export const ASK_KINDS = ['approve', 'pick', 'answer', 'act'] as const;

/**
 * What should happen next, in one word (D16). The second glance badge.
 *
 * Claude-supplied, because it is the one thing a measurement cannot know: the
 * stop reason says why this turn ended, and this says what the next one is for.
 */
export const NEXT_STEPS = [
  'handoff',
  'answerAsks',
  'continue',
  'done',
  'testOnDevice',
] as const;

export const ASK_PRIORITIES = [0, 1, 2, 3, 4] as const;

/**
 * The priority an ask gets when its bead records none (D15).
 *
 * P3, not P0: a v1 ask with `blocking: false` is exactly "informational, the
 * default is fine", and an unreadable priority must not invent urgency.
 */
export const ASK_PRIORITY_DEFAULT = 3;

/** The priority the old `blocking: true` meant. */
export const ASK_PRIORITY_BLOCKING = 0;

/**
 * What each priority CLAIMS, in Justin's terms. Printed in the skeleton and in
 * the rule text, because the calibration is the whole value of the scale: a
 * report where everything is P0 is a report with no priorities at all.
 */
export const ASK_PRIORITY_MEANING: Record<number, string> = {
  0: 'I cannot proceed without this',
  1: 'decide before the next session builds on it',
  2: 'decide this week',
  3: 'informational — my default is fine',
  4: 'FYI — no reply expected',
};

/**
 * How a previously-open ask was handled this time round (D4, rewritten by D24).
 *
 * TWO MEMBERS NOW, NOT FOUR. v2 had `carried` (still open) and `decided` (I took
 * the default), and both are gone because the tool no longer needs to be told
 * either one: EVERY open ask from the previous report is closed automatically as
 * `decided: <the default the ask itself recorded>` unless this payload restates
 * it (a new ask carrying `supersedes`) or dispositions it here. Justin, verbatim
 * (2026-09-15): "If the human did not answer them and the agent went ahead with
 * the default, the questions need to be closed."
 *
 * So what is left is only what the tool CANNOT work out for itself: that Justin
 * answered (quote him) or that the question stopped applying (say why).
 */
export const ASK_DISPOSITIONS = ['answered', 'irrelevant'] as const;

/**
 * The v2 dispositions this build still MIGRATES, for one release.
 *
 * `decided` maps onto the auto-close, which says the same thing in the ask's own
 * recorded words. `carried` cannot map onto anything — restating an ask is now a
 * new ask with its own text, and a migration has no text to write — so it keeps
 * the ask OPEN and `thread report` prints a warning naming it. See
 * `migrateV2Payload`.
 */
export const V2_ONLY_ASK_DISPOSITIONS = ['carried', 'decided'] as const;

/**
 * What a deviation IS (D23). Justin's definition, 2026-09-15: a MISTAKE is
 * "something careless, wrong, against the spec or the rules" — and it is the one
 * kind that reaches the compact report, beside the P0/P1 asks.
 *
 * The other two exist so that `mistake` stays expensive: without somewhere to
 * put "I chose X over Y" and "you should know Z", every departure would be filed
 * as a mistake and the compact report would fill up with things Justin does not
 * need to see above everything else.
 */
export const DEVIATION_KINDS = ['mistake', 'judgmentCall', 'fyi'] as const;

export const DEVIATION_KIND_MEANING: Record<string, string> = {
  fyi: 'you should know this, but nothing went wrong',
  judgmentCall: 'a call I made that you might have made differently',
  mistake: 'careless, wrong, against the spec or against the rules — MUST-SEE',
};

export const WORK_PRODUCT_KINDS = [
  'code',
  'docs',
  'answer',
  'config',
  'research',
  'none',
] as const;

export const MERGE_STATES = [
  'merged',
  'unmerged',
  'notApplicable',
  'unknown',
] as const;

/**
 * EVERY v3 disposition closes the ask (D24). The set is kept as a named constant
 * because the invariant is worth stating: after this release there is no way for
 * a payload to say "leave this one open" — an ask that should stay live is
 * restated as a NEW ask that supersedes it, which is the whole of D24.
 */
export const CLOSING_DISPOSITIONS: ReadonlySet<string> = new Set(
  ASK_DISPOSITIONS,
);

/** What `thread report` closes an unlisted, unrestated ask as (D24). */
export const AUTO_CLOSE_DISPOSITION = 'decided';

/**
 * …and what it closes one as when the ask bead records no default.
 *
 * NOT `decided`: "decided" is a claim that Claude proceeded on a stated default,
 * and an ask with no recorded default has none to have proceeded on. Saying
 * `decided` there would put words in the report's mouth — the reassuring
 * direction, since it reads as "handled".
 */
export const EXPIRED_DISPOSITION = 'expired';

export type AskKind = (typeof ASK_KINDS)[number];
export type AskDisposition = (typeof ASK_DISPOSITIONS)[number];
export type DeviationKind = (typeof DEVIATION_KINDS)[number];
export type NextStep = (typeof NEXT_STEPS)[number];
export type AskPriority = (typeof ASK_PRIORITIES)[number];

const nonEmpty = (what: string) =>
  z.string().min(1, `${what} must not be empty`);

const askOptionSchema = z.strictObject({
  recommended: z
    .boolean()
    .describe('Exactly one option should be marked recommended.'),
  text: nonEmpty('an option').describe(
    'The option itself, plus its upside/downside in one breath.',
  ),
});

const askSchema = z.strictObject({
  context: nonEmpty('ask.context').describe(
    'The hook back into what this is about — Justin has not been here for hours.',
  ),
  default: nonEmpty('ask.default').describe(
    'What Claude will do if this is never answered. Skipping a non-blocking ask means "take this".',
  ),
  kind: z.literal([...ASK_KINDS]),
  options: z
    .array(askOptionSchema)
    .describe(
      'Lettered choices, rendered a/b/c. Empty for kinds that are not a choice.',
    ),
  priority: z
    .literal([...ASK_PRIORITIES])
    .describe(
      'P0 you cannot proceed without · P1 decide before the next session · P2 this week · P3 informational, default is fine · P4 FYI. MOST ASKS ARE P3/P4. Do not inflate. P0 and P1 are the ONLY asks that reach the compact report.',
    ),
  supersedes: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The ask bead id this one RESTATES (D24). The old ask is closed "superseded by <this ask>" and this one carries its lineage. Use it whenever a previous report’s question is still live — asks are never edited in place.',
    ),
  text: nonEmpty('ask.text').describe('The question or action, in one line.'),
});

/**
 * One deviation, now typed by kind (D23).
 *
 * v2 made this a bare string, and the cost was that a careless mistake and a
 * "you should know I used tabs here" were the same object — so the compact
 * report could not show one and hide the other, which is the entire point of the
 * must-see frame.
 */
const deviationSchema = z.strictObject({
  kind: z
    .literal([...DEVIATION_KINDS])
    .describe(
      'mistake = careless / wrong / against the spec or rules (Justin SEES this) · judgmentCall = a call he might have made differently · fyi = he should know, nothing went wrong.',
    ),
  text: nonEmpty('deviations.text'),
});

const priorAskSchema = z.strictObject({
  detail: nonEmpty('priorAsks.detail').describe(
    'answered → quote what Justin said. irrelevant → say why the question stopped applying.',
  ),
  disposition: z.literal([...ASK_DISPOSITIONS]),
  id: nonEmpty('priorAsks.id').describe('The ask bead id, e.g. jl-x7q.2.'),
});

const beadTouchedSchema = z.strictObject({
  description: nonEmpty('beadsTouched.description').describe(
    'REQUIRED. A bare id is unreadable: say what the bead is, e.g. "the thread-state fact collector".',
  ),
  id: nonEmpty('beadsTouched.id'),
});

export const threadReportSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        answer: nonEmpty('answers.answer'),
        question: nonEmpty('answers.question').describe(
          'RESTATED VERBATIM. Justin cannot remember what he asked.',
        ),
      }),
    )
    .describe('Questions Justin asked, each restated before its answer.'),
  asks: z
    .array(askSchema)
    .describe('Everything Justin must do — questions AND next steps for him.'),
  beadsTouched: z
    .array(beadTouchedSchema)
    .describe('Every bead id with a descriptive phrase. Never a bare id.'),
  continuesFrom: z
    .string()
    .nullable()
    .optional()
    .describe('Thread bead id this session continues, when it continues one.'),
  continuesFromSession: z
    .string()
    .nullable()
    .optional()
    .describe(
      'NOT WRITTEN BY HAND. The predecessor CLAUDE SESSION id in force when the report was archived (home-base-685h F9), so a spool drain can still resolve the link after the environment that supplied it is gone.',
    ),
  deviations: z
    .array(deviationSchema)
    .describe(
      'REQUIRED (D17, D23). Anything that departs from what Justin specified or from the spec, plus anything he should know, each with its kind. Empty array when there were none — and an empty array is a CLAIM that you checked.',
    ),
  did: z.array(z.string()).describe('Completed items only.'),
  discussion: z
    .array(z.string())
    .describe('Nuance Justin needs. Usually empty.'),
  goal: nonEmpty('goal').describe("The ARC's goal, not this turn's."),
  handoff: z
    .string()
    .nullable()
    .optional()
    .describe('The handoff message, only when handing off.'),
  instruction: nonEmpty('instruction').describe(
    'What Justin last asked, restated in the second person: "You told me to…".',
  ),
  learned: z
    .array(
      z.strictObject({
        disposition: nonEmpty('learned.disposition').describe(
          'Where the learning was written, or the bead id that now carries it.',
        ),
        text: nonEmpty('learned.text'),
      }),
    )
    .describe('Each learning ends with where it now lives.'),
  nextStep: z
    .literal([...NEXT_STEPS])
    .describe(
      'ONE WORD for what happens next (D16): handoff | answerAsks | continue | done | testOnDevice. The second glance badge.',
    ),
  nextSteps: z
    .array(z.string())
    .optional()
    .describe(
      'What CLAUDE or the next session does next. Anything JUSTIN must do is an ask, not a next step.',
    ),
  priorAsks: z
    .array(priorAskSchema)
    .optional()
    .describe(
      'OPTIONAL (D24). Only the open asks Justin ANSWERED (quote him) or that became IRRELEVANT (say why). Everything else from the last report is closed for you: "decided: <the default that ask recorded>". To keep a question alive, write it again as a new ask with supersedes: <old id>.',
    ),
  progress: z.strictObject({
    percent: z
      .number()
      .min(0)
      .max(100)
      .describe('Progress toward the arc goal, 0-100.'),
    remaining: z
      .array(z.string())
      .describe('The concrete list to the next milestone.'),
  }),
  schemaVersion: z
    .literal(THREAD_SCHEMA_VERSION)
    .describe(`Always ${THREAD_SCHEMA_VERSION}.`),
  stopReason: z.strictObject({
    detail: nonEmpty('stopReason.detail'),
    kind: z.literal([...STOP_REASON_KINDS]),
  }),
  title: nonEmpty('title').describe(
    'SALIENT and recognizable — the hook Justin’s memory latches onto, not a category.',
  ),
  workProduct: z.strictObject({
    kind: z.literal([...WORK_PRODUCT_KINDS]),
    merged: z.literal([...MERGE_STATES]),
    pr: z.string().nullable().describe('PR URL or number, or null.'),
    summary: nonEmpty('workProduct.summary'),
  }),
});

export type ThreadReportPayload = z.infer<typeof threadReportSchema>;
export type ThreadAsk = z.infer<typeof askSchema>;
export type ThreadPriorAsk = z.infer<typeof priorAskSchema>;
export type ThreadDeviation = z.infer<typeof deviationSchema>;

/**
 * Validation outcome. `invalid` carries one line per problem, each naming the
 * PATH and the reason — a report that says only "invalid payload" costs a whole
 * round trip to find out which of forty fields was meant.
 */
export type PayloadValidation =
  | {
      /**
       * Ask ids a MIGRATION is keeping open (D24) — the v2 `carried` bridge, and
       * nothing else ever sets it.
       *
       * It lives on the validation result rather than in the payload because it
       * is not part of the contract: a v3 payload has no way to say "leave this
       * ask open", by design. Putting it in the schema would have published a
       * second, easier spelling of the thing D24 exists to remove.
       */
      keepOpenAskIds: string[];
      /**
       * The version the payload ARRIVED as when it had to be migrated, and null
       * when it was already current. Never absent: a migration is a real event
       * that changed what the report says (a v1 `blocking: false` becomes a P3,
       * a v2 deviation string becomes an `fyi`), and `thread report` prints a
       * line naming it. Silently upgrading would be rule 6 through the
       * validation layer — the report would look like it meant what it now says.
       */
      migratedFrom: number | null;
      /**
       * One line per substitution a migration actually made, for `thread report`
       * to print. Empty when the payload was already current — an empty list
       * here means "nothing was substituted", never "we did not look".
       */
      migrationNotes: string[];
      payload: ThreadReportPayload;
      status: 'ok';
    }
  | {issues: string[]; status: 'invalid'};

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((segment) => String(segment)).join('.');
}

/**
 * The AUTOFILLED half of an archived report (D7), as a schema (F11).
 *
 * The payload was always validated; `facts` was cast. That cast is what let a
 * spooled file with no `reportedAt` reach the drain's supersede guard, where
 * `"2026-…" > undefined` is false — so the guard concluded "not superseded" and
 * APPLIED the payload, the one direction that overwrites newer state with
 * older, and then rendered `undefined` into the bead.
 *
 * LOOSE, NOT STRICT, and the asymmetry with the payload is deliberate: a
 * payload is written by Claude against a published contract, while these facts
 * are written by an OLDER BUILD of this same tool and replayed by a newer one.
 * An added key must not make yesterday's spooled report unreplayable. Every
 * declared field keeps its `null`-means-unmeasured shape from `ThreadFacts` —
 * only `reportedAt` and `cwd` are required, because those two are the ones the
 * replay path reads before anything else can check them.
 */
export const threadFactsSchema = z.looseObject({
  aheadBehind: z
    .looseObject({ahead: z.number(), behind: z.number()})
    .nullable(),
  autofillFailures: z.array(z.string()),
  branch: z.string().nullable(),
  cwd: z.string(),
  dirty: z.boolean().nullable(),
  entrypoint: z.string().nullable(),
  // The k0b8n K4 message fields, all `.default(null)`. That default is the
  // "yesterday's spooled report must still replay" rule above, applied: a facts
  // document archived before these existed carries no such key, and a bare
  // `.nullable()` would reject it outright. `null` here therefore means EITHER
  // "the build that wrote this could not read it" OR "the build that wrote this
  // did not know about it" — which is why `autofillFailures` is the thing that
  // says why, and why a reader prints "(not captured: …)" from that list rather
  // than inferring a reason from the null.
  firstUserMessage: z.string().nullable().default(null),
  firstUserMessageAt: z.string().nullable().default(null),
  headSha: z.string().nullable(),
  isWorktree: z.boolean().nullable(),
  lastAssistantMessage: z.string().nullable().default(null),
  lastAssistantMessageAt: z.string().nullable().default(null),
  lastUserMessage: z.string().nullable(),
  lastUserMessageAt: z.string().nullable().default(null),
  model: z.string().nullable(),
  repo: z.string().nullable(),
  repoPath: z.string().nullable(),
  reportedAt: nonEmpty('facts.reportedAt').describe(
    'The stamp the supersede guard compares. NEVER absent.',
  ),
  resumeCommand: z.string().nullable().default(null),
  sessionId: z.string().nullable(),
  startedAt: z.string().nullable(),
  tokensAtStop: z.number().nullable(),
  transcriptPath: z.string().nullable(),
  worktreePath: z.string().nullable(),
});

export type FactsValidation =
  | {facts: ThreadFacts; status: 'ok'}
  | {issues: string[]; status: 'invalid'};

/** Validate an archived facts document. Never throws. */
export function validateThreadFacts(parsed: unknown): FactsValidation {
  const result = threadFactsSchema.safeParse(parsed);
  if (result.success) return {facts: result.data as ThreadFacts, status: 'ok'};
  return {
    issues: result.error.issues.map(
      (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
    ),
    status: 'invalid',
  };
}

/**
 * Rewrite a v1 payload as a v2 one (D15). Pure; the input is not mutated.
 *
 * THE THREE MAPPINGS, each chosen so the migrated report says no more than the
 * original did:
 *
 *  - `blocking: true → priority 0`, `false → priority 3`. True really did mean
 *    "cannot proceed", and false really did mean "I proceeded with my default",
 *    which is P3's definition. Nothing in between is invented.
 *  - `nextStep: 'continue'`. The only value that claims nothing — a v1 payload
 *    never said what should happen next, and 'done' or 'handoff' would be a
 *    claim it did not make.
 *  - `deviations: []`. An empty list here is the ONE place in this file where
 *    empty does not mean "checked, and there were none"; `thread report` says
 *    out loud that the payload was migrated, precisely so the empty section is
 *    not read as a clean bill of health.
 */
export function migrateV1Payload(parsed: unknown): unknown {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const source = parsed as Record<string, unknown>;
  const asks = Array.isArray(source.asks)
    ? source.asks.map((ask) => {
        if (ask == null || typeof ask !== 'object' || Array.isArray(ask)) {
          return ask;
        }
        const {blocking, ...rest} = ask as Record<string, unknown>;
        return {
          ...rest,
          priority:
            blocking === true ? ASK_PRIORITY_BLOCKING : ASK_PRIORITY_DEFAULT,
        };
      })
    : source.asks;
  return {
    ...source,
    asks,
    deviations: Array.isArray(source.deviations) ? source.deviations : [],
    nextStep:
      typeof source.nextStep === 'string' ? source.nextStep : 'continue',
    // TWO, not THREAD_SCHEMA_VERSION: this function produces a v2 payload, and
    // `migrateV2Payload` takes it the rest of the way. Stamping it "current"
    // here would skip the second migration entirely the next time the version
    // moves — the shape would be v2 wearing a v3 label.
    schemaVersion: 2,
  };
}

/** What a v2 → v3 migration CHANGED, in words `thread report` can print. */
export interface V2MigrationResult {
  /** Ask ids the v2 payload marked `carried`; they stay OPEN (D24). */
  keepOpenAskIds: string[];
  /** One line per substitution that was actually made. Empty when none were. */
  notes: string[];
  payload: unknown;
}

/**
 * Rewrite a v2 payload as a v3 one (D24). Pure; the input is not mutated.
 *
 * THE THREE MAPPINGS, each chosen so the migrated report says no more than the
 * original did — and each one REPORTED, because every one of them is in the
 * reassuring direction if it goes unmentioned:
 *
 *  - `deviations: string[]` → `{kind: 'fyi', text}`. `fyi` is the kind that
 *    claims nothing went wrong, and a v2 payload never said whether one had. A
 *    v2 mistake therefore arrives looking like an FYI and will NOT appear in the
 *    compact report; the printed migration line says so out loud.
 *  - `priorAsks` with `disposition: 'decided'` → DROPPED, because the auto-close
 *    does exactly that job and does it from the ask bead's own recorded default
 *    rather than from the payload's retelling of it.
 *  - `priorAsks` with `disposition: 'carried'` → dropped from priorAsks and
 *    returned in `keepOpenAskIds`, so the ask stays open. This is the one thing
 *    a v3 payload cannot express (restating is a new ask with text, and a
 *    migration has no text to invent), so it is a bridge, not a feature: it
 *    lives for one release and `thread report` warns on every use.
 */
export function migrateV2Payload(parsed: unknown): V2MigrationResult {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {keepOpenAskIds: [], notes: [], payload: parsed};
  }
  const source = parsed as Record<string, unknown>;
  const notes: string[] = [];

  let deviations = source.deviations;
  if (Array.isArray(deviations)) {
    const strings = deviations.filter(
      (item): item is string => typeof item === 'string',
    );
    if (strings.length > 0) {
      deviations = deviations.map((item) =>
        typeof item === 'string' ? {kind: 'fyi', text: item} : item,
      );
      notes.push(
        `${strings.length} deviation${strings.length === 1 ? '' : 's'} arrived as plain text and were filed as "fyi" — NOT as "no mistakes"; nobody was asked which kind they were`,
      );
    }
  }

  const keepOpenAskIds: string[] = [];
  let priorAsks = source.priorAsks;
  if (Array.isArray(priorAsks)) {
    const kept: unknown[] = [];
    let decided = 0;
    for (const prior of priorAsks) {
      if (prior == null || typeof prior !== 'object' || Array.isArray(prior)) {
        kept.push(prior);
        continue;
      }
      const entry = prior as Record<string, unknown>;
      if (entry.disposition === 'carried') {
        if (typeof entry.id === 'string' && entry.id !== '') {
          keepOpenAskIds.push(entry.id);
        }
        continue;
      }
      if (entry.disposition === 'decided') {
        decided += 1;
        continue;
      }
      kept.push(entry);
    }
    if (decided > 0) {
      notes.push(
        `${decided} prior ask${decided === 1 ? '' : 's'} marked "decided" are now closed by the automatic rule instead, using the default each ask bead itself recorded`,
      );
    }
    if (keepOpenAskIds.length > 0) {
      notes.push(
        `${keepOpenAskIds.length} prior ask${keepOpenAskIds.length === 1 ? '' : 's'} marked "carried" are being LEFT OPEN (${keepOpenAskIds.join(', ')}). v3 has no "carried": restate the question as a new ask with "supersedes": "<old id>" so it carries this report's framing`,
      );
    }
    priorAsks = kept;
  }

  return {
    keepOpenAskIds,
    notes,
    payload: {
      ...source,
      deviations,
      priorAsks,
      schemaVersion: THREAD_SCHEMA_VERSION,
    },
  };
}

function schemaVersionOf(parsed: unknown): number | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const value = (parsed as {schemaVersion?: unknown}).schemaVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validate a parsed payload, migrating an accepted older version first. Never
 * throws.
 *
 * The migration runs ONLY on a payload that declares an older version. A
 * payload with no `schemaVersion`, or one that declares 2 but still carries
 * `blocking`, fails with the key named — guessing at an undeclared shape is how
 * a typo becomes a silently dropped field.
 */
export function validateThreadReport(parsed: unknown): PayloadValidation {
  const declared = schemaVersionOf(parsed);
  const needsMigration =
    declared != null &&
    declared >= THREAD_SCHEMA_MIN_ACCEPTED_VERSION &&
    declared < THREAD_SCHEMA_VERSION;

  // THE MIGRATIONS CHAIN. A v1 payload goes v1 → v2 → v3, so each step only ever
  // has to know about the one version in front of it; a v1 payload that skipped
  // the v2 step would arrive with string deviations and a `carried` prior ask,
  // and be refused by the version it declared support for.
  let candidate = parsed;
  let keepOpenAskIds: string[] = [];
  let migrationNotes: string[] = [];
  if (needsMigration) {
    if (declared < 2) candidate = migrateV1Payload(candidate);
    const v3 = migrateV2Payload(candidate);
    candidate = v3.payload;
    keepOpenAskIds = v3.keepOpenAskIds;
    migrationNotes = v3.notes;
  }

  const result = threadReportSchema.safeParse(candidate);
  if (result.success) {
    return {
      keepOpenAskIds,
      migratedFrom: needsMigration ? declared : null,
      migrationNotes,
      payload: result.data,
      status: 'ok',
    };
  }
  return {
    issues: result.error.issues.map(
      (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
    ),
    status: 'invalid',
  };
}

/**
 * The skeleton `thread prepare` prints: every field, with a short hint where the
 * value goes.
 *
 * Hand-written rather than derived from the schema on purpose — the hints are
 * the whole value here, and `z.toJSONSchema` would give a shape without them.
 * The drift risk is real and is covered by a test that parses this skeleton's
 * key set against the schema's.
 */
/**
 * The calibration Claude needs to fill `priority` honestly (D15), printed
 * beside the skeleton rather than inside it so the JSON stays copy-pasteable.
 *
 * It exists because a scale with no calibration collapses upward: every ask
 * feels urgent to the session that just wrote it, and a report where everything
 * is P0 has no priorities at all — it is the old boolean with more digits.
 */
export const PAYLOAD_PRIORITY_GUIDANCE: readonly string[] = [
  'ASK PRIORITY (0-4) — most asks are P3 or P4. Do not inflate.',
  ...ASK_PRIORITIES.map(
    (priority) => `  P${priority} — ${ASK_PRIORITY_MEANING[priority]}`,
  ),
  '  P0 is for a session that is genuinely STOPPED. If you kept working, it was not P0.',
  '  Asks are always NUMBERED (one sequence, every priority); only options get letters.',
  // k0b8n.10 (K11 rule 7): an option written as "a. Merge" printed as
  // "a. (Recommended) a. Merge". The renderer strips a matching label now, but
  // the payload should not carry one in the first place.
  '  Write option text WITHOUT a letter — no "a.", "(a)" or "a —": the renderer prints the letters.',
];

/**
 * THE TRIPLE-CHECK (D25) — printed beside the skeleton, and the reason the
 * compact report can be trusted to be short.
 *
 * Justin, 2026-09-15, on why this is the important half of the change: "shift
 * the mental framework wholesale from the human is going to read all this lovely
 * text to the human will read the minimum bare essential text, so I need to
 * focus on making that clear, actionable, and triple checking that it is as
 * important and relevant as I think it is… and the human MAY read some of the
 * rest. This is a shift from the human will answer all of these questions to
 * give the human the opportunity to answer these questions."
 *
 * Nothing in the tool can enforce it — a P0 is whatever the payload says it is —
 * so the prompt is the mechanism. It is deliberately a question rather than a
 * rule: the failure mode is not ignorance of the scale, it is a session that has
 * just spent hours on something and cannot tell any more what matters.
 */
export const PAYLOAD_MUST_SEE_GUIDANCE: readonly string[] = [
  'MUST-SEE — what Justin actually reads. The compact report is ONLY:',
  '  · your P0 and P1 asks, in full',
  '  · your deviations of kind "mistake", in full',
  // One sentence, one line (critical rule 14, k0b8n.10): these were wrapped by
  // hand at ~80 columns, which is wrong in every terminal but an 80-column one.
  '  Everything else (what you did, what you learned, your answers, P2-P4 asks, judgment calls, FYIs, next steps) is on the bead and behind --full. He MAY read it.',
  '',
  'BEFORE YOU REPORT, re-read every P0, every P1 and every mistake and ask:',
  '  "is this as important as I think, and would Justin want to see it above everything else?"',
  '  Most things are not must-see. Demote what is not. A compact report that is long is a compact report he stops reading.',
  '',
  'ASKS ARE WRITTEN ONCE (D24).',
  '  Every open ask from your last report is closed for you: "decided: <the default that ask recorded>". To keep a question alive, write it AGAIN as a new ask with "supersedes": "<old ask id>" — never edit the old one.',
  '  List an ask in priorAsks only if Justin ANSWERED it (quote him) or it became IRRELEVANT.',
];

/**
 * The payload skeleton `thread prepare` prints.
 *
 * `continuesFrom` is PREFILLED when the session was told which thread it
 * continues (D21), so the one field that carries another session's open asks
 * cannot be left at `null` by a copy-paste — nothing else in the payload has the
 * property that omitting it silently discards work Justin is waiting on.
 */
export function payloadSkeleton(
  options: {continuesFrom?: string | null} = {},
): string {
  const skeleton = {
    answers: [{answer: '<your answer>', question: '<his question, verbatim>'}],
    asks: [
      {
        context: '<the hook back into what this is about>',
        default: '<what you will do if he never answers>',
        kind: 'approve',
        options: [
          {
            recommended: true,
            text: '<the option itself, NO letter — upside/downside>',
          },
        ],
        priority: 3,
        supersedes: null,
        text: '<the question or action, one line>',
      },
    ],
    beadsTouched: [{description: '<what this bead IS>', id: '<bead id>'}],
    continuesFrom: options.continuesFrom ?? null,
    deviations: [
      {
        kind: 'fyi',
        text: '<mistake = careless/wrong/against the spec · judgmentCall = a call he might have made differently · fyi = he should know. [] when there were none>',
      },
    ],
    did: ['<completed item>'],
    discussion: [],
    goal: '<the arc goal>',
    handoff: null,
    instruction: 'You told me to <restate his last instruction>',
    learned: [
      {disposition: '<where it now lives>', text: '<what you learned>'},
    ],
    nextStep: 'continue',
    nextSteps: [
      '<what I or the next session do next — NOT things you must do>',
    ],
    priorAsks: [
      {
        detail:
          '<answered → quote him · irrelevant → say why it stopped applying>',
        disposition: 'answered',
        id: '<ask bead id — ONLY if he answered it or it became irrelevant>',
      },
    ],
    progress: {percent: 0, remaining: ['<next concrete step>']},
    schemaVersion: THREAD_SCHEMA_VERSION,
    stopReason: {detail: '<one line>', kind: 'completed'},
    title: '<salient, recognizable — the memory hook>',
    workProduct: {
      kind: 'code',
      merged: 'unmerged',
      pr: null,
      summary: '<what exists now that did not before>',
    },
  };
  return JSON.stringify(skeleton, null, 2);
}
