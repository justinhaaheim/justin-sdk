/**
 * Regression tests for home-base-fjcp: the `advisor` server tool's usage record
 * being read as the session's own context.
 *
 * THE BUG, as it actually happened (conductor session 5b9ad9b0, 2026-09-12):
 * the session was sitting at ~174k of context, called the advisor, and the hook
 * announced 341,867 tokens with a wrap-up directive attached — because the
 * assistant record produced by the advisor call carries the SUM of every model
 * turn inside it, and that sum double-counts `cache_read_input_tokens`
 * (156,346 + 169,402 = 325,748).
 *
 * EVERY NUMBER AND SHAPE BELOW IS COPIED FROM THAT TRANSCRIPT, not invented.
 * The advisor exchange is reproduced as what it really is: SEVEN consecutive
 * records sharing one `message.id`, whose content blocks run thinking,
 * thinking, server_tool_use, advisor_tool_result, thinking, thinking, and
 * finally a bare `tool_use`. That last record is the whole reason the fix keys
 * off `usage.iterations` rather than content blocks — see the "innocent-looking
 * tail" test.
 *
 * Both readers are covered because both route through `readTranscriptFacts`:
 * the usage-check HOOK, and `justin-sdk thread usage-now`.
 *
 * @see home-base-fjcp
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {measureUsageNow} from '../src/thread/usage-now';
import {
  readTranscriptFacts,
  runUsageCheck,
  USAGE_CHECK_CONFIG_KEY,
  usageSpansMultipleTurns,
  WRAP_UP_DIRECTIVE,
} from '../src/usage-check';

/** The session's real context after the advisor returned: 32 + 5,120 + 169,402. */
const REAL_CONTEXT = 174_554;

/** The phantom the bug reported: 4 + 16,115 + 325,748. */
const PHANTOM_CONTEXT = 341_867;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'usage-check-advisor-'));
}

/**
 * A single-turn usage block, verbatim from record msg_…9z1AzP4N (08:29:07).
 * Note `server_tool_use` is PRESENT and zero — it is on essentially every
 * record, which is exactly why it cannot be the discriminant.
 */
function cleanUsage(): Record<string, unknown> {
  return {
    cache_creation_input_tokens: 5_120,
    cache_read_input_tokens: 169_402,
    input_tokens: 32,
    iterations: [
      {
        cache_creation_input_tokens: 5_120,
        cache_read_input_tokens: 169_402,
        input_tokens: 32,
        model: null,
        output_tokens: 4_195,
        type: 'message',
      },
    ],
    output_tokens: 4_195,
    server_tool_use: {web_fetch_requests: 0, web_search_requests: 0},
    service_tier: 'standard',
  };
}

/**
 * The advisor exchange's usage block, verbatim from record msg_…eJtoBFVX
 * (08:27:10–08:28:52). The three iterations are the session's turn, the
 * ADVISOR's own turn (its prompt is the whole forwarded transcript, hence
 * 172,527 input tokens), and the session's turn after the result came back.
 */
function advisorUsage(): Record<string, unknown> {
  return {
    cache_creation_input_tokens: 16_115,
    cache_read_input_tokens: 325_748,
    input_tokens: 4,
    iterations: [
      {
        cache_creation_input_tokens: 13_056,
        cache_read_input_tokens: 156_346,
        input_tokens: 2,
        model: null,
        output_tokens: 1_223,
        type: 'message',
      },
      {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 172_527,
        model: 'claude-fable-5-1',
        output_tokens: 6_816,
        type: 'advisor_message',
      },
      {
        cache_creation_input_tokens: 3_059,
        cache_read_input_tokens: 169_402,
        input_tokens: 2,
        model: null,
        output_tokens: 506,
        type: 'message',
      },
    ],
    output_tokens: 1_729,
    // Zero on the real record: the advisor is not counted here.
    server_tool_use: {web_fetch_requests: 0, web_search_requests: 0},
    service_tier: 'standard',
  };
}

function assistantRecord(args: {
  contentType: string;
  id: string;
  timestamp: string;
  usage: Record<string, unknown>;
}): unknown {
  return {
    isSidechain: false,
    message: {
      content: [{type: args.contentType}],
      id: args.id,
      model: 'claude-fable-5-1',
      role: 'assistant',
      usage: args.usage,
    },
    timestamp: args.timestamp,
    type: 'assistant',
  };
}

const ADVISOR_ID = 'msg_011CeyEAYePqTT9weJtoBFVX';
const CLEAN_ID = 'msg_011CeyEKUikLckwr9z1AzP4N';

/**
 * The seven content-block types the real advisor exchange emitted, in order.
 * The tail is a plain `tool_use` — no server-tool block anywhere on it.
 */
const ADVISOR_CONTENT_SEQUENCE = [
  'thinking',
  'thinking',
  'server_tool_use',
  'advisor_tool_result',
  'thinking',
  'thinking',
  'tool_use',
];

/**
 * The fixture, in the order the real transcript has it: the session's own
 * record at 174,554, then the seven-record advisor exchange at a phantom
 * 341,867. The hook's PostToolBatch invocation then reads this file.
 */
function writeFixture(dir: string): string {
  const records: unknown[] = [
    assistantRecord({
      contentType: 'tool_use',
      id: CLEAN_ID,
      timestamp: '2026-09-12T08:29:07.192Z',
      usage: cleanUsage(),
    }),
    ...ADVISOR_CONTENT_SEQUENCE.map((contentType, index) =>
      assistantRecord({
        contentType,
        id: ADVISOR_ID,
        timestamp: `2026-09-12T08:28:5${index}.000Z`,
        usage: advisorUsage(),
      }),
    ),
  ];
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return path;
}

/** home-base's real config: the directive is armed at 300,000. */
function writeConfig(dir: string): void {
  writeFileSync(
    join(dir, 'justin-sdk.config.json'),
    JSON.stringify({
      componentConfig: {[USAGE_CHECK_CONFIG_KEY]: {wrapUpAt: 300_000}},
      components: ['base-setup'],
      version: '0.28.0',
    }),
    'utf8',
  );
}

function runCapturing(input: unknown): Record<string, unknown> | null {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  let exit: number;
  try {
    exit = runUsageCheck({stdin: JSON.stringify(input)});
  } finally {
    console.log = original;
  }
  expect(exit).toBe(0);
  return lines.length === 0
    ? null
    : (JSON.parse(lines.join('')) as Record<string, unknown>);
}

describe('usageSpansMultipleTurns: the discriminant', () => {
  test('the real advisor usage block spans turns', () => {
    expect(usageSpansMultipleTurns(advisorUsage())).toBe(true);
  });

  test('an ordinary single-turn usage block does NOT', () => {
    expect(usageSpansMultipleTurns(cleanUsage())).toBe(false);
  });

  test('a record with no iterations key at all is left alone', () => {
    // Older transcripts carry no `iterations`; they are single-turn records and
    // must keep being measured exactly as before.
    expect(
      usageSpansMultipleTurns({
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 150_000,
        input_tokens: 2,
      }),
    ).toBe(false);
  });

  test('present-and-zero server tool counters are not a signal', () => {
    // 1,938 of the 2,787 transcripts under ~/.claude/projects carry these keys
    // and every value is zero, so treating their presence as a signal would
    // skip virtually every record in existence.
    expect(
      usageSpansMultipleTurns({
        input_tokens: 2,
        iterations: [{type: 'message'}],
        server_tool_use: {web_fetch_requests: 0, web_search_requests: 0},
      }),
    ).toBe(false);
  });

  test('a non-zero web_search/web_fetch counter is treated as a server-tool turn', () => {
    // DEFENSIVE AND UNVERIFIED: no transcript anywhere under ~/.claude/projects
    // has a non-zero counter, so the premise that a web tool inflates the
    // totals the way the advisor does is conjecture, not measurement. Only the
    // FIELD shape below is real. Kept because a false positive costs one turn
    // of under-reporting while a false negative is the doubled reading this
    // whole file exists to prevent.
    expect(
      usageSpansMultipleTurns({
        input_tokens: 2,
        server_tool_use: {web_fetch_requests: 0, web_search_requests: 1},
      }),
    ).toBe(true);
    expect(
      usageSpansMultipleTurns({
        input_tokens: 2,
        server_tool_use: {web_fetch_requests: 2, web_search_requests: 0},
      }),
    ).toBe(true);
  });

  test('the innocent-looking TAIL of the advisor exchange is still caught', () => {
    // THE TRAP. The last of the seven records carries a bare `tool_use` block
    // and no server-tool block, so a content-block filter would accept it — and
    // since a backwards scan meets it FIRST, the bug would survive untouched.
    const tail = ADVISOR_CONTENT_SEQUENCE[ADVISOR_CONTENT_SEQUENCE.length - 1];
    expect(tail).toBe('tool_use');
    expect(usageSpansMultipleTurns(advisorUsage())).toBe(true);
  });
});

describe('the reading itself', () => {
  test('readTranscriptFacts reports the session, not the advisor', () => {
    const path = writeFixture(tempDir());
    const facts = readTranscriptFacts({
      lowestSetpoint: 100_000,
      transcriptPath: path,
    });
    expect(facts.contextTokens).toBe(REAL_CONTEXT);
    expect(facts.contextTokens).not.toBe(PHANTOM_CONTEXT);
  });

  test('the HOOK announces the real context and fires no wrap-up directive', () => {
    const dir = tempDir();
    writeConfig(dir);
    const path = writeFixture(dir);

    const output = runCapturing({
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: path,
    });

    expect(output).not.toBeNull();
    const notice = output?.systemMessage as string;
    expect(notice).toContain('174,554');
    expect(notice).not.toContain('341,867');
    // The bug's real damage: at the phantom 341,867 this crossed wrapUpAt and
    // told a session sitting at 174k to wind down.
    expect(notice).not.toContain(WRAP_UP_DIRECTIVE);
    expect(notice).toContain('setpoint=100000');
  });

  test('thread usage-now reports the same number as the hook', () => {
    const path = writeFixture(tempDir());
    const result = measureUsageNow({transcriptPath: path});
    expect(result.reason).toBeNull();
    expect(result.contextTokens).toBe(REAL_CONTEXT);
    expect(result.contextTokens).not.toBe(PHANTOM_CONTEXT);
  });

  test('a transcript of NOTHING BUT advisor records measures nothing, not zero', () => {
    // FAILURE IS NOT EMPTY: with no single-turn record to fall back to, the
    // answer is "unmeasured", never a fabricated number and never 0.
    const dir = tempDir();
    const records = ADVISOR_CONTENT_SEQUENCE.map((contentType, index) =>
      assistantRecord({
        contentType,
        id: ADVISOR_ID,
        timestamp: `2026-09-12T08:28:5${index}.000Z`,
        usage: advisorUsage(),
      }),
    );
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const facts = readTranscriptFacts({
      lowestSetpoint: 100_000,
      transcriptPath: path,
    });
    expect(facts.contextTokens).toBeNull();

    const result = measureUsageNow({transcriptPath: path});
    expect(result.contextTokens).toBeNull();
    expect(result.reason).toContain('no assistant record');
  });
});
