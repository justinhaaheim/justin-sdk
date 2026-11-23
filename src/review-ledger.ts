/**
 * The review-gate ledger (home-base epic home-base-g22jt D3): one JSONL file,
 * `$XDG_DATA_HOME/review-gate/reviews.jsonl` (default
 * ~/.local/share/review-gate/reviews.jsonl), with three kinds of line,
 * `review`, `waiver` and `outcome` (D15: what became of one finding; the
 * latest per finding wins). Each line carries `schema` so a later shape can
 * be told apart.
 *
 * It lives in the SDK (D16) so one schema serves home-base's `review-gate`
 * tool, which writes it, and `thread status`, which shows its findings. This
 * module imports zod: thread code must load it with `await import(...)`, never
 * statically (the CLI's import tree stays zod-free; health-notices-cli.test).
 *
 * An unparsable line is reported by every reader and never counted as a
 * review (critical rule 7): `readLedger` returns it in `unreadable`.
 */

import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {z} from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export const LEDGER_SCHEMA = 1;

function xdgDir(env: Env, variable: string, fallback: string[]): string {
  const value = env[variable];
  if (value != null && value !== '') return value;
  const home = env.HOME != null && env.HOME !== '' ? env.HOME : homedir();
  return join(home, ...fallback);
}

export function ledgerPath(env: Env = process.env): string {
  return join(
    xdgDir(env, 'XDG_DATA_HOME', ['.local', 'share']),
    'review-gate',
    'reviews.jsonl',
  );
}

/** Raw reviewer output per run: `$XDG_STATE_HOME/review-gate`. */
export function stateDir(env: Env = process.env): string {
  return join(
    xdgDir(env, 'XDG_STATE_HOME', ['.local', 'state']),
    'review-gate',
  );
}

export function configPath(env: Env = process.env): string {
  return join(
    xdgDir(env, 'XDG_CONFIG_HOME', ['.config']),
    'review-gate',
    'config.json',
  );
}

const tokensSchema = z.object({
  cacheRead: z.number(),
  cacheWrite1h: z.number(),
  cacheWrite5m: z.number(),
  input: z.number(),
  output: z.number(),
});
export type Tokens = z.infer<typeof tokensSchema>;

/** A priced span of transcripts. `usd` null means unknown, with `reason`. */
export const costSchema = z.object({
  /** How it was measured, in words (which transcripts, which span). */
  method: z.string().nullable(),
  /** Why `usd` is null; null when it is known. */
  reason: z.string().nullable(),
  /** Requests priced. */
  requests: z.number().nullable(),
  tokens: tokensSchema.nullable(),
  /** The CLI's own result.total_cost_usd, when the reviewer reports one. */
  totalCostUsd: z.number().nullable(),
  usd: z.number().nullable(),
});
export type Cost = z.infer<typeof costSchema>;

export const buildCostSchema = costSchema.extend({
  /** The session that ran `review-gate run` (CLAUDE_CODE_SESSION_ID), or null. */
  sessionId: z.string().nullable(),
  /** Records at or after this instant were priced; null means the session's start. */
  since: z.string().nullable(),
});
export type BuildCost = z.infer<typeof buildCostSchema>;

/**
 * One finder's report inside a merged recipe finding, with its verifier's
 * judgement of it (home-base-g22jt.6). Two different bugs a few lines apart
 * stay two reports, each judged on its own.
 */
export const reportSchema = z.object({
  failureScenario: z.string(),
  /** The finder that reported it, e.g. `bug-diff`. */
  finder: z.string(),
  line: z.number(),
  /**
   * Set when the finder's line was not a changed line of the file: mapped
   * from the saved diff file's line, or unchecked (home-base-g22jt.9).
   * Optional so earlier lines still parse.
   */
  lineNote: z.string().nullable().optional(),
  /** The verifier's reason; null when no verifier judged it. */
  reason: z.string().nullable(),
  /** The quoted CLAUDE.md or rule line, for a compliance report. */
  rule: z.string().nullable(),
  summary: z.string(),
  verdict: z.enum(['confirmed', 'rejected', 'unverified']),
});
export type Report = z.infer<typeof reportSchema>;

// The optional fields below were added by the recipe reviewer
// (home-base-g22jt.6). They are optional so every earlier line still parses
// (9b: fixtures/ledger-before-recipe.jsonl).
export const findingSchema = z.object({
  category: z.string().nullable(),
  failureScenario: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  /** The lead report's line note (home-base-g22jt.9). */
  lineNote: z.string().nullable().optional(),
  /** The verifier's reason for the verdict. */
  reason: z.string().nullable().optional(),
  /** Every finder that reported it. */
  reportedBy: z.array(z.string()).optional(),
  /** Each finder's report, with its own verdict. */
  reports: z.array(reportSchema).optional(),
  shortSummary: z.string().nullable(),
  summary: z.string(),
  /** CONFIRMED / PLAUSIBLE / UNVERIFIED / …, or null when the reviewer gave none. */
  verdict: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const rejectedFindingSchema = z.object({
  category: z.string().nullable().optional(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  /** The first report's line note (home-base-g22jt.9). */
  lineNote: z.string().nullable().optional(),
  reason: z.string().nullable(),
  reportedBy: z.array(z.string()).optional(),
  reports: z.array(reportSchema).optional(),
  summary: z.string(),
});
export type RejectedFinding = z.infer<typeof rejectedFindingSchema>;

/** One `claude -p` process of a multi-process reviewer (the recipe). */
export const reviewProcessSchema = z.object({
  error: z.string().nullable(),
  /** `claude-md-1`, `bug-diff`, `verifier-3`, … */
  name: z.string(),
  role: z.enum(['finder', 'verifier']),
  sessionId: z.string(),
  status: z.enum(['ok', 'failed']),
  totalCostUsd: z.number().nullable(),
  usd: z.number().nullable(),
  wallMs: z.number(),
});
export type ReviewProcess = z.infer<typeof reviewProcessSchema>;

export const reviewLineSchema = z.object({
  baseSha: z.string(),
  branch: z.string(),
  buildCost: buildCostSchema,
  /** The reviewed commits, oldest first, beside their patch ids. */
  commits: z.array(z.string()),
  effort: z.string().nullable(),
  endedAt: z.string(),
  error: z.string().nullable(),
  findings: z.array(findingSchema),
  headSha: z.string(),
  id: z.string(),
  kind: z.literal('review'),
  modelAsked: z.string().nullable(),
  /** Canonical model ids from the usage records; null when none could be read. */
  modelsSeen: z.array(z.string()).nullable(),
  /** `single`: no separate verify pass; `two`: finders then verifiers. */
  passes: z.enum(['single', 'two', 'unknown']),
  /** `git patch-id --stable` of each reviewed commit, in branch order (D4). */
  patchIds: z.array(z.string()),
  /** Each `claude -p` process, for a reviewer that starts several (the recipe). */
  processes: z.array(reviewProcessSchema).optional(),
  /** Null when the reviewer does not report what it rejected. */
  rejectedFindings: z.array(rejectedFindingSchema).nullable(),
  repo: z.string(),
  reviewCost: costSchema,
  /** The reviewer's own session id, when it ran one. */
  reviewSessionId: z.string().nullable(),
  reviewer: z.object({name: z.string(), version: z.string()}),
  schema: z.literal(LEDGER_SCHEMA),
  startedAt: z.string(),
  status: z.enum(['ok', 'failed']),
  transcripts: z.array(z.string()),
});
export type ReviewLine = z.infer<typeof reviewLineSchema>;

export const waiverLineSchema = z.object({
  at: z.string(),
  branch: z.string(),
  /** The session that wrote it (CLAUDE_CODE_SESSION_ID), or null. */
  by: z.string().nullable(),
  headSha: z.string(),
  id: z.string(),
  kind: z.literal('waiver'),
  reason: z.string().min(1),
  repo: z.string(),
  schema: z.literal(LEDGER_SCHEMA),
});
export type WaiverLine = z.infer<typeof waiverLineSchema>;

/** D15: was the finding a real problem, as the session that acted on it judged. */
export const OUTCOME_REAL = ['yes', 'no', 'unknown'] as const;
export type OutcomeReal = (typeof OUTCOME_REAL)[number];

/** D15: what was done about it. */
export const OUTCOME_ACTIONS = [
  'fixed',
  'wont-fix',
  'deferred',
  'none',
] as const;
export type OutcomeAction = (typeof OUTCOME_ACTIONS)[number];

/**
 * D15 (home-base-g22jt.7): what became of one finding of one review. The
 * latest line for a (review, finding) pair wins. `finding` is the finding's
 * number as `review-gate show` prints it: the findings first, then the
 * rejected findings, counting on (`numberedFindings`).
 */
export const outcomeLineSchema = z.object({
  action: z.enum(OUTCOME_ACTIONS),
  at: z.string(),
  bead: z.string().nullable(),
  /** The session that wrote it (CLAUDE_CODE_SESSION_ID), or null. */
  by: z.string().nullable(),
  commit: z.string().nullable(),
  finding: z.number().int().positive(),
  id: z.string(),
  kind: z.literal('outcome'),
  note: z.string().min(1),
  real: z.enum(OUTCOME_REAL),
  reviewId: z.string(),
  schema: z.literal(LEDGER_SCHEMA),
});
export type OutcomeLine = z.infer<typeof outcomeLineSchema>;

const lineSchema = z.discriminatedUnion('kind', [
  reviewLineSchema,
  waiverLineSchema,
  outcomeLineSchema,
]);
export type LedgerLine = z.infer<typeof lineSchema>;

export interface UnreadableLine {
  error: string;
  lineNo: number;
  text: string;
}

export interface Ledger {
  lines: LedgerLine[];
  path: string;
  /** Lines that are not JSON or not a known line kind: reported, never counted. */
  unreadable: UnreadableLine[];
}

/** Every line of the ledger. A missing file is an empty ledger; any other read error throws. */
export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return {lines: [], path, unreadable: []};
  const lines: LedgerLine[] = [];
  const unreadable: UnreadableLine[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (text.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        unreadable.push({error: String(error), lineNo: index + 1, text});
        return;
      }
      const result = lineSchema.safeParse(parsed);
      if (result.success) lines.push(result.data);
      else {
        unreadable.push({
          error: z.prettifyError(result.error).replace(/\n/g, ' '),
          lineNo: index + 1,
          text,
        });
      }
    });
  return {lines, path, unreadable};
}

/** Append one line, validated first so the ledger never holds a line its own reader rejects. */
export function appendLedger(path: string, line: LedgerLine): void {
  const valid = lineSchema.parse(line);
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, `${JSON.stringify(valid)}\n`);
}

export function reviewsOf(ledger: Ledger): ReviewLine[] {
  return ledger.lines.filter(
    (line): line is ReviewLine => line.kind === 'review',
  );
}

export function waiversOf(ledger: Ledger): WaiverLine[] {
  return ledger.lines.filter(
    (line): line is WaiverLine => line.kind === 'waiver',
  );
}

export function outcomesOf(ledger: Ledger): OutcomeLine[] {
  return ledger.lines.filter(
    (line): line is OutcomeLine => line.kind === 'outcome',
  );
}

/** One finding of a review under its number (D15), confirmed or rejected. */
export type NumberedFinding =
  | {finding: Finding; kind: 'finding'; number: number}
  | {finding: RejectedFinding; kind: 'rejected'; number: number};

/**
 * Every finding of a review, numbered from 1: the findings in their order,
 * then the rejected findings, counting on. The one numbering `show`,
 * `outcome` and `thread status` share.
 */
export function numberedFindings(review: ReviewLine): NumberedFinding[] {
  const findings = review.findings.map(
    (finding, index): NumberedFinding => ({
      finding,
      kind: 'finding',
      number: index + 1,
    }),
  );
  const rejected = (review.rejectedFindings ?? []).map(
    (finding, index): NumberedFinding => ({
      finding,
      kind: 'rejected',
      number: review.findings.length + index + 1,
    }),
  );
  return [...findings, ...rejected];
}

/** The key of one finding of one review, for `latestOutcomes`. */
export function outcomeKey(reviewId: string, finding: number): string {
  return `${reviewId}#${String(finding)}`;
}

/** The latest outcome line of each (review, finding) pair, by `outcomeKey`. */
export function latestOutcomes(ledger: Ledger): Map<string, OutcomeLine> {
  const latest = new Map<string, OutcomeLine>();
  for (const line of outcomesOf(ledger)) {
    latest.set(outcomeKey(line.reviewId, line.finding), line);
  }
  return latest;
}

/**
 * What became of a finding, in words (D15). A recorded outcome wins; without
 * one a rejected finding is "real: no (verifier)", and any other has none.
 */
export function outcomeWords(
  entry: NumberedFinding,
  outcome: OutcomeLine | null,
): string | null {
  if (outcome != null) {
    const refs = [
      outcome.commit == null ? null : `commit ${outcome.commit.slice(0, 12)}`,
      outcome.bead == null ? null : `bead ${outcome.bead}`,
    ].filter((ref): ref is string => ref != null);
    return `real: ${outcome.real}, action: ${outcome.action}: ${outcome.note}${refs.length === 0 ? '' : ` (${refs.join(', ')})`}`;
  }
  return entry.kind === 'rejected' ? 'real: no (verifier)' : null;
}

/** A finding the verifier confirmed (the recipe writes CONFIRMED). */
export function isConfirmed(entry: NumberedFinding): boolean {
  return (
    entry.kind === 'finding' &&
    entry.finding.verdict?.toUpperCase() === 'CONFIRMED'
  );
}

/**
 * Whether a finding still lacks an outcome. A rejected one has the
 * verifier's ("real: no (verifier)") until one is recorded.
 */
export function lacksOutcome(
  entry: NumberedFinding,
  outcome: OutcomeLine | null,
): boolean {
  return entry.kind === 'finding' && outcome == null;
}

/**
 * D16, What to mark: a CONFIRMED finding with no outcome recorded. An
 * unverified or verdict-less finding still shows "outcome: none recorded" in
 * the section, but asks for nothing here (Justin's design principle: an
 * alert must be rare enough to act on).
 */
export function needsOutcome(
  entry: NumberedFinding,
  outcome: OutcomeLine | null,
): boolean {
  return isConfirmed(entry) && outcome == null;
}

/** The exact command that records a finding's outcome (D15). */
export function outcomeCommand(reviewId: string, finding: number): string {
  return `review-gate outcome ${reviewId} ${String(finding)} --real yes|no|unknown --action fixed|wont-fix|deferred|none --note "<what became of it>"`;
}
