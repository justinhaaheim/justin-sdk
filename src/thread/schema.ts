/**
 * The report payload Claude writes, as a zod schema (home-base-p1uj D8).
 *
 * WHAT THIS IS. A status report used to be prose that Justin had to parse. It
 * is now a data structure: `thread report` takes this JSON, validates it,
 * attaches the facts Claude should never type (see facts.ts), writes it to a
 * `thread` bead in ~/Dev/life and renders the familiar text report from it.
 * Everything in here is therefore something only Claude can know — nothing that
 * can be measured belongs in this file.
 *
 * LOOSE, like sdk-config.ts (`z.looseObject` throughout): an unknown key is
 * accepted rather than refused. That is the SDK's house style for validated
 * JSON, and it keeps a payload written against a newer schemaVersion from being
 * rejected wholesale by an older CLI.
 *
 * THE ONE THING IT IS STRICT ABOUT is `beadsTouched[].description`. A bare bead
 * id is the single most common way a report goes stale on arrival: sampling ten
 * real reports on 2026-09-12 found ids like `z36o` and `ueue` dropped with no
 * gloss, and Justin cannot look them up. A missing description is a validation
 * error, not a warning.
 *
 * zod is imported HERE and nowhere on the CLI's eager graph: the thread
 * commands `await import` this module from their handlers, so the hot-path
 * hooks (time-check, usage-check) never pay for it. See src/cli.ts.
 */

import {z} from 'zod';

/** Bumped when a field's MEANING changes, not when one is added. */
export const THREAD_SCHEMA_VERSION = 1;

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

/** How a previously-open ask was handled this time round (D4). */
export const ASK_DISPOSITIONS = [
  'carried',
  'answered',
  'decided',
  'irrelevant',
] as const;

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

export type AskKind = (typeof ASK_KINDS)[number];
export type AskDisposition = (typeof ASK_DISPOSITIONS)[number];

const nonEmpty = (what: string) =>
  z.string().min(1, `${what} must not be empty`);

const askOptionSchema = z.looseObject({
  recommended: z
    .boolean()
    .describe('Exactly one option should be marked recommended.'),
  text: nonEmpty('an option').describe(
    'The option itself, plus its upside/downside in one breath.',
  ),
});

const askSchema = z.looseObject({
  blocking: z
    .boolean()
    .describe('Blocking means the work genuinely cannot proceed without it.'),
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
  text: nonEmpty('ask.text').describe('The question or action, in one line.'),
});

const priorAskSchema = z.looseObject({
  detail: nonEmpty('priorAsks.detail').describe(
    'answered → quote the answer. decided → say which default you took. irrelevant → say why. carried → say why it is still open.',
  ),
  disposition: z.literal([...ASK_DISPOSITIONS]),
  id: nonEmpty('priorAsks.id').describe('The ask bead id, e.g. jl-x7q.2.'),
});

const beadTouchedSchema = z.looseObject({
  description: nonEmpty('beadsTouched.description').describe(
    'REQUIRED. A bare id is unreadable: say what the bead is, e.g. "the thread-state fact collector".',
  ),
  id: nonEmpty('beadsTouched.id'),
});

export const threadReportSchema = z.looseObject({
  answers: z
    .array(
      z.looseObject({
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
      z.looseObject({
        disposition: nonEmpty('learned.disposition').describe(
          'Where the learning was written, or the bead id that now carries it.',
        ),
        text: nonEmpty('learned.text'),
      }),
    )
    .describe('Each learning ends with where it now lives.'),
  priorAsks: z
    .array(priorAskSchema)
    .describe(
      'EVERY open ask from the last report, dispositioned. The report is refused without them (D4).',
    ),
  progress: z.looseObject({
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
  stopReason: z.looseObject({
    detail: nonEmpty('stopReason.detail'),
    kind: z.literal([...STOP_REASON_KINDS]),
  }),
  title: nonEmpty('title').describe(
    'SALIENT and recognizable — the hook Justin’s memory latches onto, not a category.',
  ),
  workProduct: z.looseObject({
    kind: z.literal([...WORK_PRODUCT_KINDS]),
    merged: z.literal([...MERGE_STATES]),
    pr: z.string().nullable().describe('PR URL or number, or null.'),
    summary: nonEmpty('workProduct.summary'),
  }),
});

export type ThreadReportPayload = z.infer<typeof threadReportSchema>;
export type ThreadAsk = z.infer<typeof askSchema>;
export type ThreadPriorAsk = z.infer<typeof priorAskSchema>;

/**
 * Validation outcome. `invalid` carries one line per problem, each naming the
 * PATH and the reason — a report that says only "invalid payload" costs a whole
 * round trip to find out which of forty fields was meant.
 */
export type PayloadValidation =
  | {status: 'ok'; payload: ThreadReportPayload}
  | {status: 'invalid'; issues: string[]};

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((segment) => String(segment)).join('.');
}

/** Validate a parsed payload. Never throws. */
export function validateThreadReport(parsed: unknown): PayloadValidation {
  const result = threadReportSchema.safeParse(parsed);
  if (result.success) return {payload: result.data, status: 'ok'};
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
export function payloadSkeleton(): string {
  const skeleton = {
    answers: [{answer: '<your answer>', question: '<his question, verbatim>'}],
    asks: [
      {
        blocking: false,
        context: '<the hook back into what this is about>',
        default: '<what you will do if he never answers>',
        kind: 'approve',
        options: [{recommended: true, text: '<option a — upside/downside>'}],
        text: '<the question or action, one line>',
      },
    ],
    beadsTouched: [{description: '<what this bead IS>', id: '<bead id>'}],
    continuesFrom: null,
    did: ['<completed item>'],
    discussion: [],
    goal: '<the arc goal>',
    handoff: null,
    instruction: 'You told me to <restate his last instruction>',
    learned: [
      {disposition: '<where it now lives>', text: '<what you learned>'},
    ],
    priorAsks: [
      {
        detail: '<quote the answer / name the default / say why>',
        disposition: 'answered',
        id: '<ask bead id>',
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
