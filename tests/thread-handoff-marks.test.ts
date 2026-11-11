/**
 * home-base-idnon: a session's marks with the handoff number walked at read
 * time when its bead has no `handoff-number:` label (handoff-marks.ts).
 *
 * NEGATIVE CONTROL (run 2026-11-10, restored after): with walkedSessionMarks
 * returning sessionMarksOf(labels) unchanged, the walk test received
 * handoff "unknown" instead of 3 and the export test "unknown" instead of 2.
 */
import type {MessageLogRead} from '../src/thread/message-log';
import type {ExportIndexRead} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {
  inboxChainReaders,
  walkedSessionMarks,
} from '../src/thread/handoff-marks';
import {indexExport} from '../src/thread/session-tree';

const MARKER = '[TEST_DATA_DELETABLE 9b0eb49b-f4dd-43f5-93e5-f6e6f3de4ef9 ]';

const noLogs = new Map<string, MessageLogRead>();
const noExports = new Map<string, ExportIndexRead>();

function readers(
  beads: Record<string, string[]>,
  exportIndexes: ReadonlyMap<string, ExportIndexRead> = noExports,
) {
  return inboxChainReaders({
    beads: new Map(
      Object.entries(beads).map(([id, labels]) => [
        id,
        {labels, title: `${MARKER} ${id}`},
      ]),
    ),
    env: {},
    exportIndexes,
    logs: noLogs,
  });
}

describe('walkedSessionMarks', () => {
  test('a stamped number is the answer, and nothing is read', () => {
    const marks = walkedSessionMarks(
      {
        id: 'm-4',
        labels: ['continues:m-3', 'handoff-number:4', 'session-role:mayor'],
      },
      readers({}),
    );
    expect(marks).toEqual({handoff: 4, mayor: true});
  });

  test('a dormant bead (continues, no number) gets the number by walking back', () => {
    // m-3 → m-2 (no number) → m-1 (number 1): m-3 is H3.
    const marks = walkedSessionMarks(
      {id: 'm-3', labels: ['continues:m-2', 'session-role:mayor']},
      readers({
        'm-1': ['continues:m-0', 'handoff-number:1'],
        'm-2': ['continues:m-1'],
      }),
    );
    expect(marks).toEqual({handoff: 3, mayor: true});
  });

  test('a predecessor outside the loaded beads is found in an export this run indexed', () => {
    const index: ExportIndexRead = {
      index: {
        beadsDir: '/demo/.beads',
        byId: new Map([
          [
            'm-1',
            [
              {
                issue: {
                  labels: ['continues:m-0', 'handoff-number:1'],
                  title: `${MARKER} m-1`,
                } as never,
                lineNumber: 1,
                raw: '',
              },
            ],
          ],
        ]),
        byLabel: new Map(),
        byParent: new Map(),
        path: '/demo/.beads/issues.jsonl',
        unparsed: [],
      },
      kind: 'read',
    };
    const marks = walkedSessionMarks(
      {id: 'm-2', labels: ['continues:m-1']},
      readers({}, new Map([['/demo/.beads', index]])),
    );
    expect(marks).toEqual({handoff: 2, mayor: false});
  });

  test('a chain that cannot be walked stays H?, never a guess and never no mark', () => {
    const marks = walkedSessionMarks(
      {id: 'm-2', labels: ['continues:m-1']},
      readers({}),
    );
    expect(marks).toEqual({handoff: 'unknown', mayor: false});
  });

  test('an export that could not be read makes a miss a failure, not "not found"', () => {
    const failed: ExportIndexRead = {
      kind: 'failed',
      path: '/demo/.beads/issues.jsonl',
      reason: 'EACCES',
    };
    const read = readers({}, new Map([['/demo/.beads', failed]])).showBead(
      'm-1',
    );
    expect(read.kind).toBe('failed');
  });

  test('a first session (no continues) has no mark, as the tab title says', () => {
    expect(walkedSessionMarks({id: 'm-0', labels: []}, readers({}))).toEqual({
      handoff: null,
      mayor: false,
    });
  });
});

/**
 * home-base-hg6lz.4 R2: one predecessor on two lines of one export (a git
 * merge of issues.jsonl, before br writes it again). Built through the real
 * indexExport, so byId holds both lines, in file order.
 *
 * NEGATIVE CONTROLS (run 2026-11-11, restored after): with showBead taking
 * the first record again, the first test received "unknown" instead of 5 for
 * the older-line-first order; with the `decided` check dropped, the second
 * test received 5 instead of "unknown" in both variants.
 */
describe('walkedSessionMarks: a predecessor on two lines of one export', () => {
  const DIR = '/demo/.beads';

  function exportLine(labels: string[], updated: string | null): string {
    return JSON.stringify({
      created_at: '2026-11-01T00:00:00Z',
      id: 'm-4',
      issue_type: 'task',
      labels,
      priority: 2,
      status: 'closed',
      title: `${MARKER} m-4`,
      ...(updated == null ? {} : {updated_at: updated}),
    });
  }

  function withExport(lines: string[]) {
    const index = indexExport(
      {
        kind: 'read',
        path: `${DIR}/issues.jsonl`,
        text: `${lines.join('\n')}\n`,
      },
      DIR,
    );
    expect(index.kind).toBe('read');
    if (index.kind === 'read') {
      expect(index.index.byId.get('m-4')).toHaveLength(lines.length);
    }
    return readers({}, new Map([[DIR, index]]));
  }

  const numbered = ['continues:m-3', 'handoff-number:4', 'sid:s-4'];
  const successor = {id: 'm-5', labels: ['continues:m-4']};

  test('the newer line counts, wherever it sits in the file', () => {
    const older = exportLine([], '2026-11-01T10:00:00Z');
    const newer = exportLine(numbered, '2026-11-02T10:00:00Z');
    for (const lines of [
      [older, newer],
      [newer, older],
    ]) {
      expect(walkedSessionMarks(successor, withExport(lines))).toEqual({
        handoff: 5,
        mayor: false,
      });
    }
  });

  test('lines that updated_at cannot order and that disagree read H?, never a number', () => {
    // A shared instant: newer() keeps the first line. No instant: the last.
    const variants = [
      [
        exportLine(numbered, '2026-11-02T10:00:00Z'),
        exportLine([], '2026-11-02T10:00:00Z'),
      ],
      [exportLine([], null), exportLine(numbered, null)],
    ];
    for (const lines of variants) {
      expect(walkedSessionMarks(successor, withExport(lines))).toEqual({
        handoff: 'unknown',
        mayor: false,
      });
    }
  });

  test('lines that cannot be ordered but agree on the chain labels still give the number', () => {
    const lines = [
      exportLine(numbered, '2026-11-02T10:00:00Z'),
      exportLine([...numbered, 'note:retitled'], '2026-11-02T10:00:00Z'),
    ];
    expect(walkedSessionMarks(successor, withExport(lines))).toEqual({
      handoff: 5,
      mayor: false,
    });
  });
});
