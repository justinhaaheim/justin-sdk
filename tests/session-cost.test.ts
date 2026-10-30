import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  canonicalModel,
  type CostRequest,
  estimateCost,
  estimateTranscriptCost,
  type ModelPrice,
  pricePart,
  readTranscriptRequests,
  requestFromRecord,
} from '../src/session-cost';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, {force: true, recursive: true});
});

/** Round prices so each token type has its own power of ten. */
const TEST_TABLE: Record<string, ModelPrice> = {
  'model-a': {
    fastMultiplier: 2,
    highTier: null,
    rates: {
      cacheRead: 100,
      cacheWrite1h: 10_000,
      cacheWrite5m: 1000,
      input: 1,
      output: 10,
    },
  },
  'model-b': {
    fastMultiplier: null,
    highTier: {
      aboveTokens: 100,
      rates: {
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        input: 5_000_000,
        output: 0,
      },
    },
    rates: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      input: 1_000_000,
      output: 0,
    },
  },
};

interface UsageInput {
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  iterations?: Record<string, unknown>[];
  output_tokens?: number;
  speed?: string;
}

function assistant(
  usage: UsageInput,
  options: {id?: string; model?: string; requestId?: string} = {},
): Record<string, unknown> {
  return {
    message: {
      id: options.id ?? 'msg_1',
      model: options.model ?? 'model-a',
      usage,
    },
    requestId: options.requestId ?? 'req_1',
    timestamp: '2026-10-30T01:00:00.000Z',
    type: 'assistant',
  };
}

function only(request: CostRequest | null): CostRequest {
  if (request == null) throw new Error('expected a request');
  return request;
}

describe('pricing per token type', () => {
  test('each token type is priced at its own rate, per million', () => {
    const request = only(
      requestFromRecord(
        assistant({
          cache_creation: {
            ephemeral_1h_input_tokens: 4_000_000,
            ephemeral_5m_input_tokens: 3_000_000,
          },
          cache_creation_input_tokens: 7_000_000,
          cache_read_input_tokens: 2_000_000,
          input_tokens: 1_000_000,
          output_tokens: 5_000_000,
        }),
        'k',
      ),
    );
    const estimate = estimateCost([request], TEST_TABLE);
    // input 1x1 + output 5x10 + read 2x100 + 5m 3x1000 + 1h 4x10000
    expect(estimate.usd).toBe(1 + 50 + 200 + 3000 + 40_000);
  });

  test('a cache write with no 5m/1h split is priced at the 5-minute rate and counted', () => {
    const request = only(
      requestFromRecord(
        assistant({cache_creation_input_tokens: 2_000_000, input_tokens: 0}),
        'k',
      ),
    );
    const estimate = estimateCost([request], TEST_TABLE);
    expect(estimate.usd).toBe(2000);
    expect(estimate.byModel['model-a']?.unsplitCacheWrite).toBe(2_000_000);
  });

  test('fast mode multiplies, and fast on a model with no fast price is unknown', () => {
    const fast = only(
      requestFromRecord(
        assistant({input_tokens: 1_000_000, speed: 'fast'}),
        'k',
      ),
    );
    expect(estimateCost([fast], TEST_TABLE).usd).toBe(2);
    const fastB = only(
      requestFromRecord(
        assistant({input_tokens: 1, speed: 'fast'}, {model: 'model-b'}),
        'k',
      ),
    );
    expect(estimateCost([fastB], TEST_TABLE).usd).toBeNull();
  });

  test('a prompt above the high tier threshold uses the high tier', () => {
    const small = only(
      requestFromRecord(
        assistant({input_tokens: 100}, {model: 'model-b'}),
        'k',
      ),
    );
    const large = only(
      requestFromRecord(
        assistant({input_tokens: 101}, {model: 'model-b'}),
        'k',
      ),
    );
    expect(estimateCost([small], TEST_TABLE).usd).toBe(100);
    expect(estimateCost([large], TEST_TABLE).usd).toBe(505);
  });

  test('the real table reproduces a measured Claude Code cost-state exactly', () => {
    // A haiku-5-5 cost-state measured 2026-10-30 (every request under 100K
    // prompt tokens): 534 input, 1,184 output, 712,046 cache read, 57,224
    // 1-hour cache write = $0.01921066. Priced here as one sub-100K part per
    // token type, since the aggregate itself would cross the tier.
    const parts = [
      {input: 534},
      {output: 1184},
      ...Array.from({length: 7}, () => ({cacheRead: 99_999})),
      {cacheRead: 712_046 - 7 * 99_999},
      {cacheWrite1h: 57_224},
    ].map((tokens) => ({
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      input: 0,
      model: 'claude-haiku-5-5',
      output: 0,
      speed: 'standard',
      unsplitCacheWrite: 0,
      ...tokens,
    }));
    const usd = parts
      .map((part) => pricePart(part))
      .reduce(
        (sum, price) => sum + (price.kind === 'known' ? price.usd : NaN),
        0,
      );
    expect(usd).toBeCloseTo(0.01921066, 8);
  });
});

describe('message.id dedupe', () => {
  test('records of one request count once, keeping the one with the most output', () => {
    const requests = new Map<string, CostRequest>();
    const records = [
      assistant({input_tokens: 1_000_000, output_tokens: 1_000_000}),
      assistant({input_tokens: 1_000_000, output_tokens: 3_000_000}),
      assistant({input_tokens: 1_000_000, output_tokens: 2_000_000}),
    ];
    const dir = mkdtempSync(join(tmpdir(), 'session-cost-'));
    cleanup.push(dir);
    const path = join(dir, 'main.jsonl');
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'));
    return readTranscriptRequests(path, requests).then(() => {
      const estimate = estimateCost(requests.values(), TEST_TABLE);
      expect(estimate.requests).toBe(1);
      // input 1 + output 3 x 10, never the sum of the three records
      expect(estimate.usd).toBe(31);
    });
  });

  test('onAssistant sees every assistant record, and onRecord only the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-cost-'));
    cleanup.push(dir);
    const path = join(dir, 'main.jsonl');
    const lines = [
      JSON.stringify(assistant({input_tokens: 1, output_tokens: 1})),
      JSON.stringify({totalCostUSD: 1, type: 'cost-state'}),
      JSON.stringify(assistant({input_tokens: 1, output_tokens: 2})),
    ];
    writeFileSync(path, lines.join('\n'));
    const assistantLines: number[] = [];
    const otherTypes: unknown[] = [];
    const requests = new Map<string, CostRequest>();
    await readTranscriptRequests(path, requests, {
      alsoParse: ['"type":"cost-state"'],
      onAssistant: (_record, line) => assistantLines.push(line),
      onRecord: (record) => otherTypes.push(record.type),
    });
    expect(assistantLines).toEqual([1, 3]);
    expect(otherTypes).toEqual(['cost-state']);
    expect(requests.size).toBe(1);
  });

  test('records with no requestId fall back to message.id', () => {
    const record = assistant({input_tokens: 1});
    delete record.requestId;
    expect(only(requestFromRecord(record, 'fallback')).key).toBe('msg_1');
  });
});

describe('advisor iterations', () => {
  test('an advisor entry is priced at its own model, beside the main turns', () => {
    const request = only(
      requestFromRecord(
        assistant({
          input_tokens: 3_000_000,
          iterations: [
            {input_tokens: 1_000_000, output_tokens: 0, type: 'message'},
            {
              input_tokens: 7_000_000,
              model: 'model-b',
              output_tokens: 0,
              type: 'advisor_message',
            },
            {input_tokens: 2_000_000, output_tokens: 0, type: 'message'},
          ],
          output_tokens: 0,
        }),
        'k',
      ),
    );
    const estimate = estimateCost([request], TEST_TABLE);
    expect(estimate.byModel['model-a']?.usd).toBe(3);
    expect(estimate.byModel['model-a']?.parts).toBe(2);
    // 7M input on model-b is far above its 100-token high tier: 7 x 5,000,000
    expect(estimate.byModel['model-b']?.usd).toBe(35_000_000);
  });

  test('message iterations that do not add up to the top level are ignored for the top level', () => {
    const request = only(
      requestFromRecord(
        assistant({
          input_tokens: 5_000_000,
          iterations: [{input_tokens: 1_000_000, type: 'message'}],
        }),
        'k',
      ),
    );
    expect(estimateCost([request], TEST_TABLE).usd).toBe(5);
  });
});

describe('unknown models', () => {
  test('a model with no price is unknown, never $0, and the known part is a lower bound', () => {
    const known = only(
      requestFromRecord(assistant({input_tokens: 1_000_000}), 'a'),
    );
    const unknown = only(
      requestFromRecord(
        assistant(
          {input_tokens: 1_000_000},
          {model: 'claude-new-9', requestId: 'req_2'},
        ),
        'b',
      ),
    );
    const estimate = estimateCost([known, unknown], TEST_TABLE);
    expect(estimate.usd).toBeNull();
    expect(estimate.pricedUsd).toBe(1);
    expect(estimate.unpricedParts).toBe(1);
    expect(estimate.byModel['claude-new-9']?.usd).toBeNull();
    expect(estimate.byModel['claude-new-9']?.tokens.input).toBe(1_000_000);
    expect(estimate.byModel['claude-new-9']?.unknownReason).toContain(
      'no list price',
    );
  });

  test('synthetic records and records with no usage are not requests', () => {
    expect(
      requestFromRecord(
        assistant({input_tokens: 0}, {model: '<synthetic>'}),
        'k',
      ),
    ).toBeNull();
    expect(requestFromRecord({type: 'user'}, 'k')).toBeNull();
  });

  test('model names drop the 1M marker and a date snapshot suffix', () => {
    expect(canonicalModel('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(canonicalModel('claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5',
    );
  });
});

describe('subagent inclusion', () => {
  test("a session's subagent transcripts are added, and a request in both is counted once", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-cost-'));
    cleanup.push(dir);
    const main = join(dir, 'abc.jsonl');
    writeFileSync(
      main,
      `${JSON.stringify(assistant({input_tokens: 1_000_000}, {requestId: 'r1'}))}\n{"type":"assistant","message":{"usa`,
    );
    const subDir = join(dir, 'abc', 'subagents');
    mkdirSync(subDir, {recursive: true});
    writeFileSync(
      join(subDir, 'agent-x.jsonl'),
      [
        assistant({input_tokens: 2_000_000}, {requestId: 'r2'}),
        assistant({input_tokens: 1_000_000}, {requestId: 'r1'}),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    writeFileSync(join(subDir, 'agent-x.meta.json'), '{}');
    const withSubs = await estimateTranscriptCost(main);
    expect(withSubs.files).toHaveLength(2);
    expect(withSubs.estimate.requests).toBe(2);
    expect(withSubs.unparseableLines).toBe(1);
    const mainOnly = await estimateTranscriptCost(main, {
      includeSubagents: false,
    });
    expect(mainOnly.estimate.requests).toBe(1);
  });
});
