/**
 * The thread bead's metadata document (home-base-p1uj D7, D9).
 *
 * `openAskCount` gets most of the attention here, and it is worth saying why.
 * It is a claim about the WHOLE THREAD — how many things are waiting for Justin
 * right now — not about the payload that happened to be submitted. The obvious
 * implementation (`payload.asks.length`) is wrong in exactly the reassuring
 * direction: a report that creates no new asks while carrying a blocking one
 * records 0, and the board then says "nothing is waiting for you" while a
 * blocking question sits open. That is critical rule 6 with a count instead of
 * a null, so it gets a test.
 */

import {describe, expect, test} from 'bun:test';

import {buildThreadMetadata, readReportCount} from '../src/thread/metadata';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

const FACTS: ThreadFacts = {
  aheadBehind: null,
  autofillFailures: ['aheadBehind: no upstream branch'],
  branch: 'thread-reports',
  cwd: '/repo',
  dirty: false,
  entrypoint: 'cli',
  headSha: 'abc123',
  isWorktree: false,
  lastUserMessage: 'go',
  model: 'claude-opus-5',
  reportedAt: '2026-09-12T09:00:00.000Z',
  repo: 'justin-sdk',
  repoPath: '/repo',
  sessionId: 'session-1',
  startedAt: '2026-09-12T07:00:00.000Z',
  tokensAtStop: 1000,
  transcriptPath: '/t.jsonl',
  worktreePath: null,
};

function payload(overrides: Partial<ThreadReportPayload> = {}) {
  const result = validateThreadReport(examplePayload());
  if (result.status !== 'ok') throw new Error('fixture payload is invalid');
  return {...result.payload, ...overrides};
}

describe('buildThreadMetadata', () => {
  test('counts the WHOLE thread’s open asks, not just this payload’s', () => {
    const metadata = buildThreadMetadata({
      askIds: ['jl-x.4'],
      carriedOpenAsks: [
        {blocking: true, id: 'jl-x.1'},
        {blocking: false, id: 'jl-x.2'},
      ],
      facts: FACTS,
      payload: payload(),
      reportCount: 3,
    });
    // 1 created + 2 carried.
    expect(metadata.openAskCount).toBe(3);
    expect(metadata.carriedAskIds).toEqual(['jl-x.1', 'jl-x.2']);
    expect(metadata.askIds).toEqual(['jl-x.4']);
  });

  test('a report that creates NOTHING while carrying a blocking ask still says so', () => {
    const metadata = buildThreadMetadata({
      askIds: [],
      carriedOpenAsks: [{blocking: true, id: 'jl-x.1'}],
      facts: FACTS,
      payload: payload({asks: []}),
      reportCount: 2,
    });
    expect(metadata.openAskCount).toBe(1);
    expect(metadata.blockingAskCount).toBe(1);
  });

  test('an ask bead that was never created is not counted as one that was', () => {
    const metadata = buildThreadMetadata({
      askIds: [null, null],
      carriedOpenAsks: [],
      facts: FACTS,
      payload: payload(),
      reportCount: 1,
    });
    expect(metadata.askIds).toEqual([]);
    expect(metadata.openAskCount).toBe(0);
  });

  test('every key is present with an explicit null, because bd MERGES metadata', () => {
    const metadata = buildThreadMetadata({
      askIds: [],
      carriedOpenAsks: [],
      facts: FACTS,
      payload: payload(),
      reportCount: 1,
    });
    // `bd update --metadata @file.json` merges rather than replaces (measured
    // 2026-09-12), so an omitted key keeps the PREVIOUS report's value. These
    // are unmeasurable here and must be written as null, not left out.
    expect(Object.keys(metadata)).toContain('aheadBehind');
    expect(metadata.aheadBehind).toBeNull();
    expect(metadata.worktreePath).toBeNull();
    expect(metadata.continuesFrom).toBeNull();
    expect(metadata.autofillFailures).toEqual([
      'aheadBehind: no upstream branch',
    ]);
  });

  test('keys are camelCase, so bd’s --metadata-field filter can read them', () => {
    const metadata = buildThreadMetadata({
      askIds: [],
      carriedOpenAsks: [],
      facts: FACTS,
      payload: payload(),
      reportCount: 1,
    });
    for (const key of Object.keys(metadata)) {
      // bd's filter regex is [a-zA-Z_][a-zA-Z0-9_.]* — a hyphen makes a key
      // unfilterable, and sessionId is what the whole D1 identity hangs on.
      expect(key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_.]*$/);
    }
    expect(metadata.sessionId).toBe('session-1');
  });
});

describe('readReportCount', () => {
  test('absent, malformed or negative metadata reads as 0', () => {
    expect(readReportCount(undefined)).toBe(0);
    expect(readReportCount({})).toBe(0);
    expect(readReportCount({reportCount: 'three'})).toBe(0);
    expect(readReportCount({reportCount: -2})).toBe(0);
    expect(readReportCount({reportCount: 7})).toBe(7);
  });
});
