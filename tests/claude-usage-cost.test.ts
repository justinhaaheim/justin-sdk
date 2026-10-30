/**
 * The session-cost readers (home-base-ys9t7.8.1, item 2): the history read
 * back, each session's latest figure and its rise over a window, and spend per
 * project. The write rule is tested through observeRender in home-base's
 * src/claude-usage/live.test.ts, where the store's tests live.
 */

import type {SessionCostLine} from '../src/claude-usage-cost';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync} from 'fs';
import {join} from 'path';

import {
  costIncrements,
  latestCostBySession,
  parseCostPayload,
  projectCosts,
  readSessionCostHistory,
  sessionCostLines,
  summarizeSessionCosts,
} from '../src/claude-usage-cost';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const T0 = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

function line(
  sessionId: string,
  atMs: number,
  usd: number,
  fields: Partial<SessionCostLine> = {},
): SessionCostLine {
  return {
    at: new Date(atMs).toISOString(),
    ccVersion: '2.1.312',
    cwd: '/r',
    decreased: false,
    linesAdded: null,
    linesRemoved: null,
    modelId: 'claude-opus-5-5',
    previousCostUsd: null,
    project: 'home-base',
    projectDir: '/r',
    schema: 1,
    sessionId,
    totalApiDurationMs: null,
    totalCostUsd: usd,
    totalDurationMs: null,
    transcriptPath: null,
    ...fields,
  };
}

describe('parseCostPayload', () => {
  test('absent, invalid and ok are three different answers', () => {
    expect(parseCostPayload('')).toEqual({kind: 'absent'});
    expect(parseCostPayload('{"cost":null}')).toEqual({kind: 'absent'});
    expect(parseCostPayload('{"cost":{}}')).toEqual({kind: 'absent'});
    expect(parseCostPayload('{"cost":{"total_cost_usd":"1"}}').kind).toBe(
      'invalid',
    );
    expect(parseCostPayload('[1]').kind).toBe('invalid');
    expect(
      parseCostPayload(
        JSON.stringify({
          cost: {total_cost_usd: 0.5, total_duration_ms: 'x'},
          cwd: '/r',
          modelId: 'm',
          projectDir: null,
        }),
      ),
    ).toEqual({
      kind: 'ok',
      payload: {
        cwd: '/r',
        linesAdded: null,
        linesRemoved: null,
        modelId: 'm',
        projectDir: null,
        totalApiDurationMs: null,
        totalCostUsd: 0.5,
        totalDurationMs: null,
      },
    });
  });
});

describe('readSessionCostHistory', () => {
  test('missing is missing; a bad line is skipped AND reported; an unreadable file is failed', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const path = join(sb.path, 'session-cost.jsonl');
    expect(readSessionCostHistory(path)).toEqual({kind: 'missing', path});
    sb.writeFile(
      'session-cost.jsonl',
      [
        JSON.stringify(line(A, T0, 1)),
        '{torn',
        JSON.stringify({...line(A, T0, 2), totalCostUsd: null}),
        JSON.stringify(line(A, T0 + MIN, 2)),
        '',
      ].join('\n'),
    );
    const read = readSessionCostHistory(path);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.lines.map((l) => l.totalCostUsd)).toEqual([1, 2]);
    expect(read.unreadable.map((u) => u.line)).toEqual([2, 3]);
    expect(read.unreadable[1]?.reason).toBe('no finite totalCostUsd');

    const dir = join(sb.path, 'a-dir.jsonl');
    mkdirSync(dir);
    expect(readSessionCostHistory(dir).kind).toBe('failed');
  });
});

describe('per session and per project', () => {
  const lines = [
    line(A, T0 - 60 * MIN, 1),
    line(B, T0 - 50 * MIN, 4, {project: 'other'}),
    line(A, T0 + MIN, 3),
    // A restarted its counter (a resume): flagged, counted from $0.
    line(A, T0 + 2 * MIN, 0.5, {decreased: true, previousCostUsd: 3}),
    line(A, T0 + 3 * MIN, 1.5),
  ];

  test('the latest figure and the history of each session', () => {
    expect(latestCostBySession(lines).get(A)?.totalCostUsd).toBe(1.5);
    expect(latestCostBySession(lines).get(B)?.totalCostUsd).toBe(4);
    expect(sessionCostLines(lines, A)).toHaveLength(4);
  });

  test('increments: the rise from the previous line, the whole figure after a decrease', () => {
    expect(
      costIncrements(sessionCostLines(lines, A)).map((s) => s.usd),
    ).toEqual([1, 2, 0.5, 1]);
  });

  test('a window counts only the rise dated in it, and drops sessions last seen before it', () => {
    const summaries = summarizeSessionCosts(lines, {sinceMs: T0});
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      inWindowUsd: 3.5,
      lines: 4,
      project: 'home-base',
      restarts: 1,
      sessionId: A,
    });
    const all = summarizeSessionCosts(lines, {sinceMs: 0});
    expect(all.map((s) => s.sessionId)).toEqual([B, A]);
    expect(projectCosts(all)).toEqual([
      {project: 'home-base', sessions: 1, usd: 4.5},
      {project: 'other', sessions: 1, usd: 4},
    ]);
  });
});
