/**
 * home-base-9uzxw.7 (built in home-base-9ihcl.4): a session's tree read
 * through the per-run export index equals the tree the old whole-file scan
 * (recordsMatching) reads, for the same export text, including its failures.
 *
 * NEGATIVE CONTROLS (2026-11-10, home-base-9ihcl.4):
 *  - indexExport with the byParent entries left out: "the same tree" failed
 *    (the request's child and the session bead's child were missing from the
 *    indexed tree); restored, it passed.
 *  - indexedRecordsMatching with the unparsed-line check removed: "a broken
 *    line holding a needle fails the lookup" failed at its first assertion
 *    (the indexed tree had no problem and kept the records the scan drops);
 *    restored, it passed.
 *  - On real data, `bun run threads:perf --tree-equivalence` with the
 *    byParent entries left out reported 54 of 215 session trees differing;
 *    restored, all 215 identical.
 */
import type {ExportRead, SessionTree} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {indexExport, readSessionTree} from '../src/thread/session-tree';

const SID = '11111111-2222-3333-4444-555555555555';
const DIR = '/repo/.beads';

function line(record: {
  deps?: string[];
  id: string;
  labels?: string[];
  status?: string;
  updated?: string;
}): string {
  return JSON.stringify({
    created_at: '2026-11-01T00:00:00Z',
    dependencies: (record.deps ?? []).map((parent) => ({
      depends_on_id: parent,
      issue_id: record.id,
      type: 'parent-child',
    })),
    description: `about ${record.id}`,
    id: record.id,
    issue_type: 'task',
    labels: record.labels ?? [],
    priority: 2,
    status: record.status ?? 'open',
    title: `title ${record.id}`,
    updated_at: record.updated ?? '2026-11-02T00:00:00Z',
  });
}

const EXPORT = [
  line({id: 'hb-s', labels: [`sid:${SID}`]}),
  line({id: 'hb-r1', labels: ['request', `sid:${SID}`]}),
  line({deps: ['hb-r1'], id: 'hb-r1.1'}),
  line({deps: ['hb-s'], id: 'hb-c1'}),
  line({id: 'hb-q1', labels: ['ask', `sid:${SID}`, 'to:hb-r1']}),
  line({id: 'hb-t', labels: [`sid:${SID}`], status: 'tombstone'}),
  // Names the session in a label of another session only: not this tree's.
  line({id: 'hb-other', labels: ['sid:99999999-2222-3333-4444-555555555555']}),
  // Mentions hb-s, but in no dependency: the substring finds it, the
  // parent check drops it, on both paths.
  line({id: 'hb-mention', labels: ['note:hb-s']}),
  '',
].join('\n');

function both(
  texts: Record<string, ExportRead>,
  dirs: string[] = [DIR],
): {indexed: SessionTree; scanned: SessionTree} {
  const input = {beadsDirs: dirs, sessionBeadId: 'hb-s', sessionId: SID};
  const readExport = (dir: string): ExportRead =>
    texts[dir] ?? {kind: 'failed', path: dir, reason: `no export for ${dir}`};
  return {
    indexed: readSessionTree({
      ...input,
      readIndex: (dir) => indexExport(readExport(dir), dir),
    }),
    scanned: readSessionTree({...input, readExport}),
  };
}

const read = (text: string, path = `${DIR}/issues.jsonl`): ExportRead => ({
  kind: 'read',
  path,
  text,
});

describe('thread inbox: the per-run export index (home-base-9uzxw.7)', () => {
  test('the same tree as the whole-file scan', () => {
    const {indexed, scanned} = both({[DIR]: read(EXPORT)});
    expect(indexed).toEqual(scanned);
    expect(scanned.session?.id).toBe('hb-s');
    expect(scanned.requests.map((node) => node.request.id)).toEqual([
      'hb-c1',
      'hb-r1',
    ]);
    expect(
      scanned.requests
        .find((node) => node.request.id === 'hb-r1')
        ?.children.map((child) => child.id),
    ).toEqual(['hb-r1.1']);
    expect(scanned.questions.map((question) => question.id)).toEqual(['hb-q1']);
    expect(scanned.problems).toEqual([]);
  });

  test('a broken line holding a needle fails the lookup, never "no records" (rule 7)', () => {
    const broken = `${EXPORT}{"id":"hb-x","labels":["sid:${SID}"]\n`;
    const {indexed, scanned} = both({[DIR]: read(broken)});
    expect(indexed).toEqual(scanned);
    expect(indexed.problems).toHaveLength(1);
    expect(indexed.problems[0]).toContain(
      'line 9 of /repo/.beads/issues.jsonl is not a bead record',
    );
  });

  test("a broken line holding no needle is not this tree's problem", () => {
    const broken = `${EXPORT}{"id":"hb-unrelated"\n`;
    const {indexed, scanned} = both({[DIR]: read(broken)});
    expect(indexed).toEqual(scanned);
    expect(indexed.problems).toEqual([]);
  });

  test('an export that cannot be read is a named problem on both paths', () => {
    const {indexed, scanned} = both({}, [DIR]);
    expect(indexed).toEqual(scanned);
    expect(indexed.problems).toEqual([`no export for ${DIR}`]);
    expect(indexed.session).toBeNull();
    expect(indexed.sessionMissing).toBeNull();
  });

  test('one id in two exports: the newer record wins on both paths', () => {
    const other = '/wt/.beads';
    const newer = [
      line({
        id: 'hb-r1',
        labels: ['request', `sid:${SID}`, 'later'],
        updated: '2026-11-05T00:00:00Z',
      }),
      '',
    ].join('\n');
    const {indexed, scanned} = both(
      {[DIR]: read(EXPORT), [other]: read(newer, `${other}/issues.jsonl`)},
      [DIR, other],
    );
    expect(indexed).toEqual(scanned);
    expect(
      indexed.requests.find((node) => node.request.id === 'hb-r1')?.request
        .labels,
    ).toContain('later');
  });
});
