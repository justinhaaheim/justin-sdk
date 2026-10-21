/**
 * `thread show`'s "Related epics" section (home-base-y1hg0.7): the nearest
 * epic above every request and every bead the session created, each epic once
 * with its open children, and `none` kept apart from "could not read"
 * (critical rule 7).
 *
 * PURE: the exports are strings handed to `findRelatedEpics` through its
 * `readExport` seam, in the exact line shape br writes to
 * `.beads/issues.jsonl` (parent-child as a `dependencies` entry). The wiring
 * through a real br workspace is tested in thread-session-status.test.ts.
 *
 * NEGATIVE CONTROLS: recorded in home-base-y1hg0.7's notes (each names the
 * line broken, the assertion that went red, and the restore).
 */

import type {CreatedBeads} from '../src/thread/session-created';
import type {Measured} from '../src/thread/session-model';
import type {ExportRead, TreeIssue} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {stripAnsi} from '../src/check-runner';
import {PLAIN_STYLE} from '../src/cli-style';
import {
  findRelatedEpics,
  MAX_PARENT_DEPTH,
  noEpicLine,
  OPEN_CHILDREN_SHOWN,
  RELATED_EPICS_INCOMPLETE,
  renderRelatedEpics,
} from '../src/thread/related-epics';
import {measured, unmeasured} from '../src/thread/session-model';
import {parseExportLine} from '../src/thread/session-tree';

const DIR = '/repo/.beads';
const OTHER_DIR = '/repo/.claude/worktrees/w/.beads';

interface RecordSpec {
  created?: string;
  parent?: string | null;
  status?: string;
  title?: string;
  type?: string;
  updated?: string;
}

/** One export line, as br writes it. */
function line(id: string, spec: RecordSpec = {}): string {
  return JSON.stringify({
    created_at: spec.created ?? '2030-01-01T09:00:00Z',
    ...(spec.parent == null
      ? {}
      : {
          dependencies: [
            {
              depends_on_id: spec.parent,
              issue_id: id,
              type: 'parent-child',
            },
          ],
        }),
    id,
    issue_type: spec.type ?? 'task',
    status: spec.status ?? 'open',
    title: spec.title ?? `${id} title`,
    updated_at: spec.updated ?? spec.created ?? '2030-01-01T09:00:00Z',
  });
}

function exportText(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A TreeIssue exactly as the session tree would hand it over. */
function bead(id: string, spec: RecordSpec = {}, dir = DIR): TreeIssue {
  const parsed = parseExportLine(line(id, spec), dir);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.issue;
}

function exports(
  byDir: Record<string, ExportRead | string>,
): (dir: string) => ExportRead {
  return (dir) => {
    const value = byDir[dir];
    if (value == null) {
      return {
        kind: 'failed',
        path: `${dir}/issues.jsonl`,
        reason: `${dir}/issues.jsonl does not exist`,
      };
    }
    return typeof value === 'string'
      ? {kind: 'read', path: `${dir}/issues.jsonl`, text: value}
      : value;
  };
}

function created(found: TreeIssue[]): Measured<CreatedBeads> {
  return measured({found, missing: [], notCreatedThen: []});
}

const NONE_CREATED = created([]);

function tree(requests: TreeIssue[], problems: string[] = []) {
  return {
    problems,
    requests: requests.map((request) => ({
      children: [],
      questions: [],
      request,
    })),
  };
}

const SESSION = line('t-sess', {title: 'the session', type: 'session'});

describe('one epic', () => {
  // An adopted request (`thread request --bead`) keeps its epic parent; a
  // bead the session created sits under the same epic.
  const epic = line('t-epic', {title: 'Rework the export', type: 'epic'});
  const text = exportText([
    SESSION,
    epic,
    line('t-epic.1', {
      created: '2030-01-01T09:01:00Z',
      parent: 't-epic',
      title: 'Split the export job',
    }),
    line('t-epic.2', {
      created: '2030-01-01T09:02:00Z',
      parent: 't-epic',
      status: 'closed',
      title: 'Already done',
    }),
    line('t-epic.3', {
      created: '2030-01-01T09:03:00Z',
      parent: 't-epic',
      status: 'in_progress',
      title: 'Being built now',
    }),
    line('t-epic.4', {
      created: '2030-01-01T09:04:00Z',
      parent: 't-epic',
      title: 'Profile the query',
    }),
    line('t-sess.1', {parent: 't-sess', title: 'A plain request'}),
  ]);
  const request = bead('t-epic.1', {
    created: '2030-01-01T09:01:00Z',
    parent: 't-epic',
    title: 'Split the export job',
  });
  const plain = bead('t-sess.1', {parent: 't-sess', title: 'A plain request'});
  const made = bead('t-epic.4', {
    created: '2030-01-01T09:04:00Z',
    parent: 't-epic',
    title: 'Profile the query',
  });

  function related() {
    return findRelatedEpics({
      created: created([made]),
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([request, plain]),
    });
  }

  test('the epic is listed ONCE, reached from a request and a created bead', () => {
    const result = related();
    expect(result.problems).toEqual([]);
    expect(result.checked).toEqual({created: 1, requests: 2});
    expect(
      result.epics.map((entry) => ({
        id: entry.epic.id,
        title: entry.epic.title,
        viaCreated: entry.viaCreated,
        viaRequests: entry.viaRequests,
      })),
    ).toEqual([
      {
        id: 't-epic',
        title: 'Rework the export',
        viaCreated: 1,
        viaRequests: 1,
      },
    ]);
  });

  test('its open children: closed left out, in progress first, then oldest first', () => {
    const [entry] = related().epics;
    expect(
      entry?.openChildren.map((child) => [child.id, child.status]),
    ).toEqual([
      ['t-epic.3', 'in_progress'],
      ['t-epic.1', 'open'],
      ['t-epic.4', 'open'],
    ]);
  });

  test('markdown: the epic, why it is here, and each open child with its status', () => {
    const out = renderRelatedEpics(related(), PLAIN_STYLE).join('\n\n');
    expect(out).toBe(
      [
        '**Related epics:**',
        '',
        '1. **Rework the export** (t-epic, open)',
        '',
        '   **Reached from:** 1 request and 1 bead this session created',
        '',
        '   **Open children:** 3',
        '',
        '   - t-epic.3 Being built now (in progress)',
        '',
        '',
        '   - t-epic.1 Split the export job (open)',
        '',
        '',
        '   - t-epic.4 Profile the query (open)',
      ].join('\n'),
    );
  });

  test('a bead the session created that IS an epic is its own nearest epic', () => {
    const result = findRelatedEpics({
      created: created([bead('t-epic', {title: 'Rework', type: 'epic'})]),
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([]),
    });
    expect(result.epics.map((entry) => entry.epic.id)).toEqual(['t-epic']);
    expect(result.problems).toEqual([]);
  });
});

describe('two epics', () => {
  // A request two levels under E1 (request → task → epic) and a created bead
  // under E2: the walk goes up past the task, and both epics are listed.
  const text = exportText([
    SESSION,
    line('t-e1', {title: 'First epic', type: 'epic'}),
    line('t-e1.1', {parent: 't-e1', title: 'A task under the first'}),
    line('t-e1.1.1', {parent: 't-e1.1', title: 'The request, two down'}),
    line('t-e2', {title: 'Second epic', type: 'epic'}),
    line('t-e2.1', {parent: 't-e2', title: 'Made here', type: 'bug'}),
  ]);

  test('both epics, in the order the walk reached them', () => {
    const result = findRelatedEpics({
      created: created([
        bead('t-e2.1', {parent: 't-e2', title: 'Made here', type: 'bug'}),
      ]),
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([
        bead('t-e1.1.1', {parent: 't-e1.1', title: 'The request, two down'}),
      ]),
    });
    expect(result.problems).toEqual([]);
    expect(
      result.epics.map((entry) => [
        entry.epic.id,
        entry.openChildren.map((child) => child.id),
      ]),
    ).toEqual([
      ['t-e1', ['t-e1.1']],
      ['t-e2', ['t-e2.1']],
    ]);
    const out = renderRelatedEpics(result, PLAIN_STYLE).join('\n\n');
    expect(out).toContain('1. **First epic** (t-e1, open)');
    expect(out).toContain('2. **Second epic** (t-e2, open)');
    // Two sibling list items: two empty lines between them (Claude Code).
    expect(out).toMatch(/A task under the first \(open\)\n\n\n2\. /u);
  });

  test('the NEAREST epic only: an epic above an epic is not listed', () => {
    const nested = exportText([
      line('t-top', {title: 'Top epic', type: 'epic'}),
      line('t-mid', {parent: 't-top', title: 'Middle epic', type: 'epic'}),
      line('t-mid.1', {parent: 't-mid', title: 'Leaf'}),
    ]);
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: nested}),
      sessionDirs: [DIR],
      tree: tree([bead('t-mid.1', {parent: 't-mid', title: 'Leaf'})]),
    });
    expect(result.epics.map((entry) => entry.epic.id)).toEqual(['t-mid']);
  });

  test('one id in two exports: the newer record wins, for the epic and its children', () => {
    const older = exportText([
      line('t-e1', {title: 'Old title', type: 'epic'}),
      line('t-e1.1', {parent: 't-e1', title: 'Child'}),
    ]);
    const newer = exportText([
      line('t-e1', {
        title: 'New title',
        type: 'epic',
        updated: '2030-01-02T00:00:00Z',
      }),
      line('t-e1.1', {
        parent: 't-e1',
        status: 'closed',
        title: 'Child',
        updated: '2030-01-02T00:00:00Z',
      }),
    ]);
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: older, [OTHER_DIR]: newer}),
      sessionDirs: [DIR, OTHER_DIR],
      tree: tree([bead('t-x', {parent: 't-e1'})]),
    });
    expect(result.epics.map((entry) => entry.epic.title)).toEqual([
      'New title',
    ]);
    expect(result.epics[0]?.openChildren).toEqual([]);
  });
});

describe('no epic', () => {
  test('requests under the session bead and a parentless created bead: none, checked', () => {
    const text = exportText([
      SESSION,
      line('t-sess.1', {parent: 't-sess'}),
      line('t-loose'),
    ]);
    const result = findRelatedEpics({
      created: created([bead('t-loose')]),
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-sess.1', {parent: 't-sess'})]),
    });
    expect(result).toEqual({
      checked: {created: 1, requests: 1},
      epics: [],
      problems: [],
    });
    expect(renderRelatedEpics(result, PLAIN_STYLE)).toEqual([
      '**Related epics:**',
      'none — checked 1 request and 1 bead this session created; none of them sits under an epic.',
    ]);
  });

  test('an epic with no open child says "none (checked)", not an empty list', () => {
    const text = exportText([
      line('t-e', {title: 'Finished epic', type: 'epic'}),
      line('t-e.1', {parent: 't-e', status: 'closed'}),
    ]);
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-e.1', {parent: 't-e', status: 'closed'})]),
    });
    expect(renderRelatedEpics(result, PLAIN_STYLE).join('\n\n')).toContain(
      '   **Open children:** none (checked)',
    );
  });
});

describe('could not read — never "none" (rule 7)', () => {
  test('the created beads could not be listed: UNKNOWN, and why', () => {
    const result = findRelatedEpics({
      created: unmeasured('no transcript abc.jsonl under /projects'),
      readExport: exports({[DIR]: exportText([SESSION])}),
      sessionDirs: [DIR],
      tree: tree([]),
    });
    expect(result.epics).toEqual([]);
    expect(result.problems).toEqual([
      'the beads this session created could not be listed: no transcript abc.jsonl under /projects',
    ]);
    const out = renderRelatedEpics(result, PLAIN_STYLE);
    expect(out[1]).toStartWith('UNKNOWN — no epic found from ');
    expect(out.join('\n')).not.toContain('none —');
    expect(out[2]).toBe(
      `${RELATED_EPICS_INCOMPLETE}\n\n- the beads this session created could not be listed: no transcript abc.jsonl under /projects`,
    );
  });

  test('an export that cannot be read is named, and the line is UNKNOWN', () => {
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({}),
      sessionDirs: [DIR],
      tree: tree([bead('t-r', {parent: 't-e'})]),
    });
    expect(result.problems).toEqual([`${DIR}/issues.jsonl does not exist`]);
    expect(noEpicLine(result)).toStartWith('UNKNOWN');
  });

  test('a parent no export holds is named with the exports searched', () => {
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: exportText([SESSION])}),
      sessionDirs: [DIR],
      tree: tree([bead('t-r', {parent: 't-gone'})]),
    });
    expect(result.problems).toEqual([
      `the parent t-gone of t-r is in no beads export searched (${DIR}/issues.jsonl)`,
    ]);
    expect(noEpicLine(result)).toStartWith('UNKNOWN');
  });

  test('a created bead br reported but no export holds is named', () => {
    const result = findRelatedEpics({
      created: measured({
        found: [],
        missing: [{id: 'probe-1', searched: [`${DIR}/issues.jsonl`]}],
        notCreatedThen: [],
      }),
      readExport: exports({[DIR]: exportText([SESSION])}),
      sessionDirs: [DIR],
      tree: tree([]),
    });
    expect(result.problems).toEqual([
      `a bead this session created with br create is in no beads export searched, so its epic is unknown: probe-1 (searched ${DIR}/issues.jsonl)`,
    ]);
  });

  test('the session tree’s own unreadable exports make the answer UNKNOWN too', () => {
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: exportText([SESSION])}),
      sessionDirs: [DIR],
      tree: tree([], ['could not read /w/.beads/issues.jsonl: EACCES']),
    });
    expect(result.problems).toEqual([
      'could not read /w/.beads/issues.jsonl: EACCES',
    ]);
    expect(noEpicLine(result)).toStartWith('UNKNOWN');
  });

  test('a line naming the parent that is not a bead record is a failure, not "absent"', () => {
    const text = `${line('t-sess')}\n{"id":"t-e", not json\n`;
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-r', {parent: 't-e'})]),
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toStartWith(
      `a line of ${DIR}/issues.jsonl naming t-e is not a bead record`,
    );
  });

  test('epics found AND a problem: the epics print, then the incomplete note', () => {
    const text = exportText([
      line('t-e', {title: 'Known epic', type: 'epic'}),
      line('t-e.1', {parent: 't-e'}),
    ]);
    const result = findRelatedEpics({
      created: unmeasured('transcript unreadable'),
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-e.1', {parent: 't-e'})]),
    });
    const out = renderRelatedEpics(result, PLAIN_STYLE);
    expect(out[1]).toStartWith('1. **Known epic** (t-e, open)');
    expect(out[2]).toStartWith(RELATED_EPICS_INCOMPLETE);
  });

  test('a parent loop ends the walk: each bead is visited once, no epic, no hang', () => {
    const text = exportText([
      line('t-a', {parent: 't-b'}),
      line('t-b', {parent: 't-a'}),
    ]);
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-a', {parent: 't-b'})]),
    });
    expect(result).toEqual({
      checked: {created: 0, requests: 1},
      epics: [],
      problems: [],
    });
  });

  test('a chain of parents deeper than the limit stops there and says so', () => {
    const depth = MAX_PARENT_DEPTH + 2;
    const chain = Array.from({length: depth}, (_, i) =>
      line(`t-c${i}`, {parent: `t-c${i + 1}`}),
    );
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({
        [DIR]: exportText([
          ...chain,
          line(`t-c${depth}`, {title: 'Too far up', type: 'epic'}),
        ]),
      }),
      sessionDirs: [DIR],
      tree: tree([bead('t-c0', {parent: 't-c1'})]),
    });
    expect(result.epics).toEqual([]);
    expect(result.problems).toEqual([
      `stopped looking for the epic above t-c0 after ${MAX_PARENT_DEPTH} levels of parents`,
    ]);
  });
});

describe('the cap', () => {
  test(`at most ${OPEN_CHILDREN_SHOWN} open children, then "N more"; the count is the true one`, () => {
    const children = Array.from({length: OPEN_CHILDREN_SHOWN + 2}, (_, i) =>
      line(`t-e.${i + 1}`, {
        created: `2030-01-01T10:${String(i).padStart(2, '0')}:00Z`,
        parent: 't-e',
      }),
    );
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({
        [DIR]: exportText([
          line('t-e', {title: 'Big', type: 'epic'}),
          ...children,
        ]),
      }),
      sessionDirs: [DIR],
      tree: tree([
        bead('t-e.1', {created: '2030-01-01T10:00:00Z', parent: 't-e'}),
      ]),
    });
    expect(result.epics[0]?.openChildren).toHaveLength(OPEN_CHILDREN_SHOWN + 2);
    const out = renderRelatedEpics(result, PLAIN_STYLE).join('\n\n');
    expect(out).toContain(`   **Open children:** ${OPEN_CHILDREN_SHOWN + 2}`);
    expect(out).toContain(`   - t-e.${OPEN_CHILDREN_SHOWN} `);
    expect(out).not.toContain(`   - t-e.${OPEN_CHILDREN_SHOWN + 1} `);
    expect(out.trimEnd().endsWith('   - 2 more')).toBe(true);
    const ansi = renderRelatedEpics(result, {color: true, width: null}).join(
      '\n\n',
    );
    expect(ansi).toContain('2 more');
  });
});

describe('on a terminal', () => {
  test('a section header, the epic at the body column, its fields and children stepped in', () => {
    const text = exportText([
      line('t-e', {title: 'Rework the export', type: 'epic'}),
      line('t-e.1', {parent: 't-e', title: 'Split the job'}),
    ]);
    const result = findRelatedEpics({
      created: NONE_CREATED,
      readExport: exports({[DIR]: text}),
      sessionDirs: [DIR],
      tree: tree([bead('t-e.1', {parent: 't-e', title: 'Split the job'})]),
    });
    const out = renderRelatedEpics(result, {color: true, width: 100}).map(
      stripAnsi,
    );
    expect(out).toEqual([
      '  🗂️ Related epics',
      [
        '      Rework the export (t-e, open)',
        '',
        '          Reached from: 1 request',
        '',
        '          Open children: 1',
        '',
        '              t-e.1 Split the job (open)',
      ].join('\n'),
    ]);
  });
});
