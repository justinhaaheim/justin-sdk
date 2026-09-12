/**
 * ONE ORDER FOR ASKS — the report and the `thread answer` walk (F12, p1uj.7).
 *
 * The failure this file exists to prevent is small to describe and expensive to
 * hit: Justin reads the pasted report, types "1 yes, 2 b" into the walk, and the
 * walk is asking different questions in a different order. The report numbered
 * blocking-then-non-blocking with carried asks leading each group, in payload
 * order; the walk sorted by `id.localeCompare`, which puts `.10` before `.2` and
 * scatters carried asks through the new ones.
 *
 * THE PROOF IS ONE FIXTURE RENDERED BOTH WAYS. The same set of asks — two
 * carried beads and two new ones — goes through `renderReport` and through
 * `orderAsks(askViewOf(...))`, and the numbered ids from the report are compared
 * against the walk's sequence position by position. Anything that changes one
 * side's ordering without the other fails here.
 */

import {describe, expect, test} from 'bun:test';

import {askViewOf, orderAsks} from '../src/thread/answer';
import {renderReport} from '../src/thread/render';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

import type {BdIssue} from '../src/thread/bd';
import type {CarriedAsk} from '../src/thread/render';
import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

const THIS_REPORT = 3;

/** A directory with no `bd` script: every read fails, loudly and by design. */
const NO_BD_WORKSPACE = '/nonexistent-life-workspace';

function facts(): ThreadFacts {
  return {
    aheadBehind: null,
    autofillFailures: [],
    branch: 'thread-followups',
    cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    dirty: false,
    entrypoint: 'cli',
    headSha: 'ed7bdf2abcdef0123456',
    isWorktree: false,
    lastUserMessage: 'fix the numbering',
    model: 'claude-opus-5',
    reportedAt: '2026-09-12T15:00:00.000Z',
    repo: 'justin-sdk',
    repoPath: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    sessionId: 'sess-numbering',
    startedAt: '2026-09-12T13:00:00.000Z',
    tokensAtStop: 100,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

/**
 * The payload's two asks, in the order Claude wrote them: the NON-blocking one
 * first. That inversion is deliberate — it is what proves the grouping is doing
 * the work rather than the array order.
 */
function payload(): ThreadReportPayload {
  const raw = examplePayload();
  const [blocking, nonBlocking] = raw.asks as Record<string, unknown>[];
  raw.asks = [nonBlocking, blocking];
  raw.priorAsks = [];
  const result = validateThreadReport(raw);
  if (result.status !== 'ok') throw new Error('fixture payload is invalid');
  return result.payload;
}

/** askIndex 0 → jl-t.11 (non-blocking), askIndex 1 → jl-t.12 (blocking). */
const NEW_ASK_IDS = ['jl-t.11', 'jl-t.12'];

/**
 * Two asks left open by earlier reports. `jl-t.10` versus `jl-t.2` is the
 * `localeCompare` trap: as strings, ".10" sorts before ".2".
 */
const CARRIED: CarriedAsk[] = [
  {
    askIndex: 1,
    blocking: true,
    fromReport: 1,
    id: 'jl-t.2',
    restated: '[Approve Y/n] Ship the lock?',
  },
  {
    askIndex: 0,
    blocking: false,
    fromReport: 2,
    id: 'jl-t.10',
    restated: '[Pick a/b] Which board view?',
  },
];

/** The same four asks as bd beads — what `thread answer` actually reads. */
function beads(): BdIssue[] {
  const carriedBeads: BdIssue[] = CARRIED.map((carried) => ({
    description: carried.restated,
    id: carried.id,
    metadata: {
      askIndex: carried.askIndex,
      blocking: carried.blocking,
      defaultAction: 'the default',
      kind: carried.blocking ? 'approve' : 'pick',
      optionCount: 2,
      reportCount: carried.fromReport,
    },
    title: carried.restated,
  }));
  const newBeads: BdIssue[] = payload().asks.map((ask, index) => ({
    description: ask.text,
    id: NEW_ASK_IDS[index]!,
    metadata: {
      askIndex: index,
      blocking: ask.blocking,
      defaultAction: ask.default,
      kind: ask.kind,
      optionCount: ask.options.length,
      reportCount: THIS_REPORT,
    },
    title: ask.text,
  }));
  // Deliberately shuffled: bd's listing order is not something to rely on.
  return [newBeads[0]!, carriedBeads[1]!, newBeads[1]!, carriedBeads[0]!];
}

/** `[number, askId]` for every numbered line in the report's Asks section. */
function numberedAsks(report: string): [number, string][] {
  const start = report.indexOf('**Asks — everything I need from you:**');
  const endMarkers = ['**Next steps', '**Prior asks', '**Work product'];
  const end = endMarkers
    .map((marker) => report.indexOf(marker, start))
    .filter((at) => at > start)
    .sort((a, b) => a - b)[0];
  const section = report.slice(start, end ?? report.length);
  const found: [number, string][] = [];
  for (const line of section.split('\n')) {
    const numbered = /^ {2}(\d+)\. /.exec(line);
    if (numbered == null) continue;
    const ids = [...line.matchAll(/\(([^()]+)\)/g)];
    const id = ids[ids.length - 1]?.[1];
    if (id == null) continue;
    found.push([Number(numbered[1]), id]);
  }
  return found;
}

describe('the report and the walk number the same asks the same way', () => {
  const report = renderReport({
    askIds: NEW_ASK_IDS,
    carried: CARRIED,
    facts: facts(),
    payload: payload(),
    reportCount: THIS_REPORT,
    threadId: 'jl-t',
  });
  const printed = numberedAsks(report);
  const walked = orderAsks(beads().map(askViewOf));

  test('the report numbers all four asks in ONE sequence', () => {
    expect(printed.map(([number]) => number)).toEqual([1, 2, 3, 4]);
    expect(printed.map(([, id]) => id)).toEqual([
      'jl-t.2', // carried, blocking — waited longest
      'jl-t.12', // new, blocking
      'jl-t.10', // carried, non-blocking
      'jl-t.11', // new, non-blocking
    ]);
  });

  test('answer number N walks onto the ask the report numbered N', () => {
    expect(walked.map((ask) => ask.id)).toEqual(printed.map(([, id]) => id));
    for (const [number, id] of printed) {
      expect(walked[number - 1]?.id).toBe(id);
    }
  });

  test('ask .10 does not jump ahead of ask .2 in either place', () => {
    // The exact `localeCompare` defect: as strings ".10" < ".2".
    const printedIds = printed.map(([, id]) => id);
    expect(printedIds.indexOf('jl-t.2')).toBeLessThan(
      printedIds.indexOf('jl-t.10'),
    );
    const walkedIds = walked.map((ask) => ask.id);
    expect(walkedIds.indexOf('jl-t.2')).toBeLessThan(
      walkedIds.indexOf('jl-t.10'),
    );
  });

  test('thread inbox lists them in the same order — three surfaces, one order', async () => {
    // `inbox` numbers its lines too (inbox.ts), and it used to print in bd's
    // listing order, which is not an order at all. Its bd reads are stubbed
    // here — what is under test is the arrangement, not the comment fetch.
    const {collectInboxAsks} = await import('../src/thread/inbox');
    const ctx = {env: {}, lifeDir: NO_BD_WORKSPACE};
    const collected = await collectInboxAsks(ctx, beads());
    // Every read failed (there is no bd there), which is itself the honest
    // path: the asks are still listed, each saying its answers are UNKNOWN.
    expect(collected.readFailed).toBe(true);
    expect(collected.asks.map((ask) => ask.id)).toEqual(
      printed.map(([, id]) => id),
    );
  });

  test('the walk names the report each ask came from', () => {
    // When the set HAS changed since the report was pasted — Justin answered one
    // yesterday — the position is no longer the report's number, and this is
    // what still identifies the ask.
    expect(walked.map((ask) => ask.reportCount)).toEqual([1, 3, 2, 3]);
  });
});
