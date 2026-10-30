/**
 * Transcript records for the spend quota's tests (home-base-ys9t7.5.2):
 * priced assistant requests, typed user lines, a handoff kickoff, and a
 * subagent's sidechain request, in the shapes the real transcripts use.
 */

import {kickoffText} from '../src/thread/respawn';

/** Round rates so the expected percents are easy to read. */
export const TEST_RATES = {fable: 10, opus: 20, other: 1, sonnet: 5} as const;

/**
 * `claude-opus-5-5` lists output at $20 per million tokens, so 1M output
 * tokens is $20: exactly 1 % of the week at TEST_RATES.opus.
 */
export const OPUS = 'claude-opus-5-5';
export const ONE_PERCENT_OPUS_OUTPUT = 1_000_000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function assistant(input: {
  atMs: number;
  model?: string;
  output?: number;
  requestId: string;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    ...(input.sidechain === true && {isSidechain: true}),
    message: {
      content: [{text: 'ok', type: 'text'}],
      id: `msg-${input.requestId}`,
      model: input.model ?? OPUS,
      role: 'assistant',
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: input.output ?? ONE_PERCENT_OPUS_OUTPUT,
      },
    },
    requestId: input.requestId,
    timestamp: iso(input.atMs),
    type: 'assistant',
  });
}

/** A prompt Justin typed (or, with `sidechain`, a subagent's brief). */
export function typed(
  atMs: number,
  text = 'Justin asks for something',
): string {
  return JSON.stringify({
    message: {content: text, role: 'user'},
    timestamp: iso(atMs),
    type: 'user',
  });
}

/** A successor's first prompt: the handoff kickoff, which is not typed. */
export function kickoff(atMs: number): string {
  return typed(atMs, kickoffText('/state/handoffs/x.md', 't-prev', null));
}

/** A tool result: a user record that is not a prompt at all. */
export function toolResult(atMs: number): string {
  return JSON.stringify({
    message: {
      content: [{content: 'done', tool_use_id: 'toolu_1', type: 'tool_result'}],
      role: 'user',
    },
    timestamp: iso(atMs),
    toolUseResult: {stdout: 'done'},
    type: 'user',
  });
}

export function jsonl(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}
