/**
 * session-cost — what a Claude Code transcript would cost at API list prices
 * (home-base-ys9t7.5.1). This is the piece a spend quota calls live: it reads
 * token counts from transcripts and prices them; it never calls a model.
 *
 * Facts it relies on (measured; full notes in home-base
 * `src/claude-usage/CLAUDE.md` and the bead):
 *
 *   - One API response is several `assistant` records (one per content block)
 *     sharing `requestId` and `message.id`, each repeating `message.usage`. Their
 *     `output_tokens` can differ, so a request is the record with the MOST
 *     output: never the sum, and not simply the last.
 *   - `message.usage` is the sum of the `type: "message"` entries of
 *     `usage.iterations`. An advisor call adds an entry of another type (e.g.
 *     `advisor_message`) that names its OWN model and is NOT in the top-level
 *     numbers, so it is priced as a separate part at its own model's rates.
 *   - A subagent's transcript is `<main minus .jsonl>/subagents/agent-<id>.jsonl`;
 *     its spend belongs to the parent session.
 *   - Claude Code's `cost-state` record (written at exit) uses these same list
 *     prices: the table below reproduces it to 0.00% at the median for Fable 5.1
 *     sessions (validation in the bead).
 *
 * A model with no price is reported as unknown, never priced at 0 (critical
 * rule 7): its tokens are counted, its dollars are null, and a total that
 * includes it is null with the known part kept as an explicit lower bound.
 */
import {createReadStream, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** Dollars per million tokens of each kind. */
export interface Rates {
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  input: number;
  output: number;
}

export interface ModelPrice {
  /** Every rate times this when `usage.speed` is `fast`; null = no fast mode. */
  fastMultiplier: number | null;
  /** A higher tier for requests whose prompt exceeds `aboveTokens`. */
  highTier: {aboveTokens: number; rates: Rates} | null;
  rates: Rates;
}

/** The date the table was taken, and from where. */
export const PRICE_TABLE_AS_OF = '2026-10-30';
export const PRICE_TABLE_SOURCE =
  'claude-api skill (Claude Code 2.1.312; model table cached 2026-10-06; https://platform.claude.com/docs/en/about-claude/pricing.md): input/output per model, cache read per model, cache write 1.25x input (5 min) and 2x input (1 hour); cross-checked against Claude Code cost-state records';

/** Cache writes are 1.25x input (5 minutes) and 2x input (1 hour) on every model. */
function rates(input: number, output: number, cacheRead: number): Rates {
  return {
    cacheRead,
    cacheWrite1h: input * 2,
    cacheWrite5m: input * 1.25,
    input,
    output,
  };
}

function flat(
  input: number,
  output: number,
  cacheRead: number,
  fastMultiplier: number | null = null,
): ModelPrice {
  return {
    fastMultiplier,
    highTier: null,
    rates: rates(input, output, cacheRead),
  };
}

/**
 * List prices by canonical model id. No current model has a long-context
 * premium: pricing requests over 200K prompt tokens at 2x made the estimate
 * 51-79% wrong against cost-state (bead notes), so there is none here.
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': flat(10, 50, 1),
  'claude-fable-5-1': flat(10, 50, 0.25),
  'claude-haiku-4-5': flat(1, 5, 0.1),
  // $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above. The upper
  // tier's cache rates assume the same multiples of input (not verified).
  'claude-haiku-5-5': {
    fastMultiplier: null,
    highTier: {aboveTokens: 100_000, rates: rates(0.5, 2.5, 0.05)},
    rates: rates(0.1, 0.5, 0.01),
  },
  'claude-mythos-5-1': flat(10, 50, 0.25),
  'claude-opus-4-6': flat(5, 25, 0.5),
  'claude-opus-4-7': flat(5, 25, 0.5),
  'claude-opus-4-8': flat(5, 25, 0.5, 2),
  'claude-opus-5': flat(5, 25, 0.5, 2),
  'claude-opus-5-5': flat(4, 20, 0.2, 2),
  'claude-sonnet-4-6': flat(3, 15, 0.3),
  'claude-sonnet-5': flat(2, 10, 0.2),
  'claude-sonnet-5-5': flat(2, 10, 0.2),
};

/**
 * `claude-opus-5[1m]` (cost-state's 1M-context marker) and
 * `claude-haiku-4-5-20251001` (a dated snapshot) are the table's
 * `claude-opus-5` and `claude-haiku-4-5`.
 */
export function canonicalModel(name: string): string {
  return name.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

export interface TokenBreakdown {
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  input: number;
  output: number;
}

/** One model's share of one request: the main turn(s), or one advisor call. */
export interface CostPart extends TokenBreakdown {
  model: string;
  /** `usage.speed` (`standard`, `fast`), or null when the record has none. */
  speed: string | null;
  /**
   * Cache-creation tokens the record did not split into 5m/1h. Priced at the
   * 5-minute rate, the API's default TTL, and counted so a report can say so.
   */
  unsplitCacheWrite: number;
}

export interface CostRequest {
  /** Epoch ms of the kept record, or null when it carries no timestamp. */
  atMs: number | null;
  key: string;
  /** `output_tokens` of the top-level usage: picks the final record. */
  outputRank: number;
  parts: CostPart[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const COUNT_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/** The tokens of a usage-shaped object, or null when it holds no counts at all. */
function partOf(
  usage: Record<string, unknown>,
  model: string,
  speed: string | null,
): CostPart | null {
  if (COUNT_FIELDS.every((field) => num(usage[field]) == null)) return null;
  const write = num(usage.cache_creation_input_tokens) ?? 0;
  const split = isObject(usage.cache_creation) ? usage.cache_creation : null;
  const w5 = split == null ? null : num(split.ephemeral_5m_input_tokens);
  const w1 = split == null ? null : num(split.ephemeral_1h_input_tokens);
  const splitSum = (w5 ?? 0) + (w1 ?? 0);
  const unsplit = Math.max(0, write - splitSum);
  return {
    cacheRead: num(usage.cache_read_input_tokens) ?? 0,
    cacheWrite1h: w1 ?? 0,
    cacheWrite5m: (w5 ?? 0) + unsplit,
    input: num(usage.input_tokens) ?? 0,
    model: canonicalModel(model),
    output: num(usage.output_tokens) ?? 0,
    speed,
    unsplitCacheWrite: unsplit,
  };
}

function samePart(a: TokenBreakdown, b: TokenBreakdown): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite5m + a.cacheWrite1h === b.cacheWrite5m + b.cacheWrite1h
  );
}

function addInto(into: TokenBreakdown, from: TokenBreakdown): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
}

export function emptyTokens(): TokenBreakdown {
  return {cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, input: 0, output: 0};
}

/**
 * The request one `assistant` record belongs to, or null when the record is
 * not a priced request (another record type, a `<synthetic>` client record, a
 * usage block with no numbers).
 *
 * The main turn is split into its `message` iterations when they add up to the
 * top-level usage, so each turn's prompt size picks its own price tier; when
 * they do not, the top-level usage is used whole.
 */
export function requestFromRecord(
  record: unknown,
  fallbackKey: string,
): CostRequest | null {
  if (!isObject(record) || record.type !== 'assistant') return null;
  const message = isObject(record.message) ? record.message : null;
  const usage =
    message != null && isObject(message.usage) ? message.usage : null;
  if (message == null || usage == null) return null;
  const model = str(message.model);
  if (model === '<synthetic>') return null;
  const modelName = model ?? 'unknown';
  const speed = str(usage.speed);
  const top = partOf(usage, modelName, speed);
  if (top == null) return null;

  const turns: CostPart[] = [];
  const extras: CostPart[] = [];
  if (Array.isArray(usage.iterations)) {
    for (const iteration of usage.iterations) {
      if (!isObject(iteration)) continue;
      if (iteration.type === 'message') {
        const part = partOf(iteration, modelName, speed);
        if (part != null) turns.push(part);
      } else {
        const part = partOf(
          iteration,
          str(iteration.model) ?? modelName,
          str(iteration.speed),
        );
        if (part != null) extras.push(part);
      }
    }
  }
  const turnSum = emptyTokens();
  for (const turn of turns) addInto(turnSum, turn);
  const main = turns.length > 0 && samePart(turnSum, top) ? turns : [top];

  const timestamp = str(record.timestamp);
  const atMs = timestamp == null ? null : Date.parse(timestamp);
  return {
    atMs: atMs == null || Number.isNaN(atMs) ? null : atMs,
    key: str(record.requestId) ?? str(message.id) ?? fallbackKey,
    outputRank: top.output,
    parts: [...main, ...extras],
  };
}

/**
 * Add `request` to `into`, counting each request once: a key already present
 * keeps whichever copy has the most output. Returns true when it was new.
 */
export function addRequest(
  into: Map<string, CostRequest>,
  request: CostRequest,
): boolean {
  const seen = into.get(request.key);
  if (seen == null) {
    into.set(request.key, request);
    return true;
  }
  if (request.outputRank > seen.outputRank) into.set(request.key, request);
  return false;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PartPrice =
  | {kind: 'known'; usd: number}
  | {kind: 'unknown'; reason: string};

function promptTokens(part: TokenBreakdown): number {
  return part.input + part.cacheRead + part.cacheWrite5m + part.cacheWrite1h;
}

/** The list price of one part, or why it has none. */
export function pricePart(
  part: CostPart,
  table: Readonly<Record<string, ModelPrice>> = PRICE_TABLE,
): PartPrice {
  const price = table[part.model];
  if (price == null) {
    return {kind: 'unknown', reason: `no list price for ${part.model}`};
  }
  let multiplier = 1;
  if (part.speed === 'fast') {
    if (price.fastMultiplier == null) {
      return {
        kind: 'unknown',
        reason: `${part.model} ran in fast mode, which has no list price here`,
      };
    }
    multiplier = price.fastMultiplier;
  }
  const r =
    price.highTier != null && promptTokens(part) > price.highTier.aboveTokens
      ? price.highTier.rates
      : price.rates;
  const usd =
    (part.input * r.input +
      part.output * r.output +
      part.cacheRead * r.cacheRead +
      part.cacheWrite5m * r.cacheWrite5m +
      part.cacheWrite1h * r.cacheWrite1h) /
    1_000_000;
  return {kind: 'known', usd: usd * multiplier};
}

export interface ModelCost {
  /** Parts priced: the main turns of a request count once per turn. */
  parts: number;
  tokens: TokenBreakdown;
  unknownReason: string | null;
  unsplitCacheWrite: number;
  /** Null when any part of this model has no price; `unknownReason` says why. */
  usd: number | null;
}

export interface CostEstimate {
  byModel: Record<string, ModelCost>;
  /** The dollars of every part that has a price: a lower bound when `usd` is null. */
  pricedUsd: number;
  requests: number;
  /** Parts with no price (their tokens are in `byModel`, their dollars nowhere). */
  unpricedParts: number;
  /** The whole estimate, or null when any part has no price. */
  usd: number | null;
}

/** Price every request once and roll the dollars up by model. */
export function estimateCost(
  requests: Iterable<CostRequest>,
  table: Readonly<Record<string, ModelPrice>> = PRICE_TABLE,
): CostEstimate {
  const byModel: Record<string, ModelCost> = {};
  let pricedUsd = 0;
  let unpricedParts = 0;
  let count = 0;
  for (const request of requests) {
    count += 1;
    for (const part of request.parts) {
      const entry = (byModel[part.model] ??= {
        parts: 0,
        tokens: emptyTokens(),
        unknownReason: null,
        unsplitCacheWrite: 0,
        usd: 0,
      });
      entry.parts += 1;
      addInto(entry.tokens, part);
      entry.unsplitCacheWrite += part.unsplitCacheWrite;
      const price = pricePart(part, table);
      if (price.kind === 'known') {
        pricedUsd += price.usd;
        if (entry.usd != null) entry.usd += price.usd;
      } else {
        unpricedParts += 1;
        entry.usd = null;
        entry.unknownReason = price.reason;
      }
    }
  }
  return {
    byModel,
    pricedUsd,
    requests: count,
    unpricedParts,
    usd: unpricedParts === 0 ? pricedUsd : null,
  };
}

// ---------------------------------------------------------------------------
// Reading transcripts (streamed: a transcript can be hundreds of MB)
// ---------------------------------------------------------------------------

export interface ReadStats {
  /** Lines that looked like an assistant record but were not JSON (a live session's torn last line). */
  unparseableLines: number;
}

/**
 * Stream one transcript and add each of its requests to `into`. `onRecord`
 * sees every other parsed record whose line contains one of `alsoParse` (e.g.
 * `"type":"cost-state"`), so a caller can collect them in the same pass.
 * `onAssistant` sees every parsed `assistant` record, after it was added, so a
 * caller can read more from it (its context size) without a second pass.
 * Throws when the file cannot be opened or read.
 */
export async function readTranscriptRequests(
  path: string,
  into: Map<string, CostRequest>,
  options: {
    alsoParse?: readonly string[];
    onAssistant?: (record: Record<string, unknown>, lineNo: number) => void;
    onRecord?: (record: Record<string, unknown>, lineNo: number) => void;
  } = {},
): Promise<ReadStats> {
  const stats: ReadStats = {unparseableLines: 0};
  const also = options.alsoParse ?? [];
  const lines = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(path, {encoding: 'utf-8'}),
  });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    // The quoted type cannot match an escaped copy of a record inside a tool result.
    const assistant = line.includes('"type":"assistant"');
    if (!assistant && !also.some((marker) => line.includes(marker))) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      stats.unparseableLines += 1;
      continue;
    }
    if (!isObject(record)) continue;
    if (record.type === 'assistant') {
      const request = requestFromRecord(record, `${path}:${lineNo}`);
      if (request != null) addRequest(into, request);
      options.onAssistant?.(record, lineNo);
    } else {
      options.onRecord?.(record, lineNo);
    }
  }
  return stats;
}

/**
 * The subagent transcripts of a main transcript, sorted. A missing
 * `subagents` folder is normal and gives []; any other failure throws.
 */
export function subagentTranscriptPaths(mainPath: string): string[] {
  const dir = join(mainPath.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as {code?: string}).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(dir, name));
}

export interface TranscriptCost {
  estimate: CostEstimate;
  files: string[];
  unparseableLines: number;
}

/**
 * The list-price cost of one session: its main transcript and every subagent
 * transcript beside it, each request counted once across all of them.
 */
export async function estimateTranscriptCost(
  mainPath: string,
  options: {includeSubagents: boolean} = {includeSubagents: true},
): Promise<TranscriptCost> {
  const files = [
    mainPath,
    ...(options.includeSubagents ? subagentTranscriptPaths(mainPath) : []),
  ];
  const requests = new Map<string, CostRequest>();
  let unparseableLines = 0;
  for (const file of files) {
    const stats = await readTranscriptRequests(file, requests);
    unparseableLines += stats.unparseableLines;
  }
  return {estimate: estimateCost(requests.values()), files, unparseableLines};
}
