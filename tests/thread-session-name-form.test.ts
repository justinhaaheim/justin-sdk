/**
 * home-base-1rxt0.2: session names read "[MAYOR][HOME][#7] <title>". One
 * builder (sessionNameParts), one parser (parseSessionName), and every name in
 * the spelling before 2026-11-12 ("[MAYOR] [HOME] H7 <title>") still reads as
 * the tool's, so a rename replaces it instead of keeping it as Justin's text.
 *
 * The old names below are real: read from `cmux tree` and from
 * workspace-names.jsonl on 2026-11-12, or the old builder's exact output as its
 * own tests asserted it before this change.
 */

import type {SessionMarks} from '../src/thread/session-name';
import type {WorkspaceNameRecord} from '../src/thread/workspace-name';

import {describe, expect, test} from 'bun:test';

import {
  carriesSessionMarks,
  handoffNumberText,
  NO_MARKS,
  parseSessionName,
  sessionDisplayName,
  sessionNameParts,
} from '../src/thread/session-name';
import {isHandedOffTabTitle} from '../src/thread/tab-title';
import {decideWorkspaceName} from '../src/thread/workspace-name';

const ALL_MARKS: SessionMarks[] = [
  NO_MARKS,
  {handoff: null, mayor: true},
  {handoff: 1, mayor: false},
  {handoff: 7, mayor: true},
  {handoff: 12, mayor: false},
  {handoff: 'unknown', mayor: false},
  {handoff: 'unknown', mayor: true},
];

describe('D1: the new form', () => {
  test('no spaces between the brackets, the number in its own bracket', () => {
    expect(sessionDisplayName('HOME', 'x', {handoff: 7, mayor: true})).toBe(
      '[MAYOR][HOME][#7] x',
    );
    expect(sessionDisplayName('HOME', 'x', {handoff: 2, mayor: false})).toBe(
      '[HOME][#2] x',
    );
    expect(
      sessionDisplayName('HOME', 'x', {handoff: 'unknown', mayor: false}),
    ).toBe('[HOME][#?] x');
    expect(sessionDisplayName('HOME', 'x', {handoff: null, mayor: true})).toBe(
      '[MAYOR][HOME] x',
    );
    expect(sessionDisplayName('HOME', 'x')).toBe('[HOME] x');
    expect(sessionDisplayName(null, 'x', {handoff: 3, mayor: false})).toBe(
      '[UNKNOWN REPO][#3] x',
    );
  });

  test('D4: the number in prose is #7, or #? when unknown', () => {
    expect(handoffNumberText(7)).toBe('#7');
    expect(handoffNumberText('unknown')).toBe('#?');
  });

  test('D2: the parts join to the display name, for every mark', () => {
    for (const marks of ALL_MARKS) {
      const parts = sessionNameParts('HOME', 'migrate the db', marks);
      expect(`${parts.before}${parts.tag}${parts.after}`).toBe(
        sessionDisplayName('HOME', 'migrate the db', marks),
      );
      expect(parts.tag).toBe('[HOME]');
    }
  });
});

describe('D2: the one parser reads back what the one builder wrote', () => {
  for (const repoTag of ['HOME', 'SCREENSHOT-APP', 'HOME-BASE', null]) {
    for (const marks of ALL_MARKS) {
      test(`${repoTag ?? 'unknown repo'} ${JSON.stringify(marks)}`, () => {
        const name = sessionDisplayName(
          repoTag,
          'Alerts privacy reports',
          marks,
        );
        expect(parseSessionName(name)).toEqual({
          marks,
          repoTag,
          spelling: 'current',
          text: 'Alerts privacy reports',
        });
      });
    }
  }
});

describe('D3: every old spelling parses as the tool’s', () => {
  test.each([
    [
      'the mayor, read from cmux',
      '[MAYOR] [HOME] H8 All sessions carried to finished',
      {handoff: 8, mayor: true},
      'HOME',
      'All sessions carried to finished',
    ],
    [
      'a numbered session with his name kept after it, read from cmux',
      '[HOME] H1 Alerts privacy reports ([HOME] Job alerts, usage reading and leaner session reports)',
      {handoff: 1, mayor: false},
      'HOME',
      'Alerts privacy reports ([HOME] Job alerts, usage reading and leaner session reports)',
    ],
    [
      'another repo’s tag, read from cmux',
      '[SCREENSHOT-APP] H3 Screenshot app: broadcast build on your phone first',
      {handoff: 3, mayor: false},
      'SCREENSHOT-APP',
      'Screenshot app: broadcast build on your phone first',
    ],
    [
      'an unknown number, the old builder’s output',
      '[HOME] H? migrate the db',
      {handoff: 'unknown', mayor: false},
      'HOME',
      'migrate the db',
    ],
    [
      'a first mayor session with no number, the old builder’s output',
      '[MAYOR] [HOME] migrate the db',
      {handoff: null, mayor: true},
      'HOME',
      'migrate the db',
    ],
  ] as const)('%s', (_why, name, marks, repoTag, text) => {
    expect(parseSessionName(name)).toEqual({
      marks,
      repoTag,
      spelling: 'old',
      text,
    });
    expect(carriesSessionMarks(name)).toBe(true);
  });

  test('a name with no mark parses, but is not marked: Justin types those (home-base-fuxmk)', () => {
    // A real name from workspace-names.jsonl, recorded as his on 2026-10-17.
    const his = '[HOME] Monday morning 9/28 Threads super-overhaul';
    expect(parseSessionName(his)).toEqual({
      marks: NO_MARKS,
      repoTag: 'HOME',
      spelling: 'current',
      text: 'Monday morning 9/28 Threads super-overhaul',
    });
    expect(carriesSessionMarks(his)).toBe(false);
    // The tag the repo had before projectTag (a real record line, 2026-10-17).
    expect(
      parseSessionName("[HOME-BASE] Name each session's cmux workspace")
        ?.repoTag,
    ).toBe('HOME-BASE');
  });

  test.each([
    ['a name Justin typed (live in cmux)', 'Group 1'],
    ['a pane title', '◐ Shortcuts helper app survey'],
    ['bracketed text with spaces', '[a note of mine ] Title'],
    ['a lowercase tag', '[home] H2 Title'],
    ['number zero', '[HOME][#0] Title'],
    ['no space after the marks', '[HOME][#2]Title'],
  ])('not a session name: %s', (_why, name) => {
    expect(parseSessionName(name)).toBeNull();
    expect(carriesSessionMarks(name)).toBe(false);
  });

  test('H2O is a word, not a number mark', () => {
    expect(parseSessionName('[HOME] H2O plans')?.marks).toEqual(NO_MARKS);
  });

  test('the old tab title still reads as handed off, beside the new one', () => {
    // The old one is exactly what handedOffTabTitle wrote before this change.
    expect(
      isHandedOffTabTitle(
        '↪ H2 handed off to H3: [MAYOR] [HOME] migrate the db',
      ),
    ).toBe(true);
    expect(isHandedOffTabTitle('↪ handed off to H1: [HOME] x')).toBe(true);
    expect(
      isHandedOffTabTitle(
        '↪ #2 handed off to #3: [MAYOR][HOME] migrate the db',
      ),
    ).toBe(true);
    expect(isHandedOffTabTitle('↪ #? handed off to #?: [HOME] x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D3: the rename (workspace-name.ts, rules 2 and 3)
// ---------------------------------------------------------------------------

const WS = 'D4BF35C7-5E4E-4FC7-BDC1-FE2A5E323606';

function line(input: {
  hisName?: string | null;
  nameSet: string;
  replacedName?: string | null;
}): WorkspaceNameRecord {
  return {
    at: '2026-11-12T00:00:00.000Z',
    beadId: 'home-base-omojj',
    hisName: input.hisName ?? null,
    nameSet: input.nameSet,
    replacedName: input.replacedName ?? null,
    repo: 'home-base',
    sessionId: null,
    setBy: null,
    surfaceId: null,
    toolPart: input.nameSet,
    workspaceId: WS,
  };
}

describe('D3: a rename replaces old marks, never keeps them as Justin’s text', () => {
  const MAYOR_OLD = '[MAYOR] [HOME] H8 All sessions carried to finished';
  const MAYOR_NEW = sessionDisplayName(
    'HOME',
    'All sessions carried to finished',
    {handoff: 8, mayor: true},
  );

  test('the live mayor name, on record: renamed to the new form, nothing in parentheses', () => {
    expect(MAYOR_NEW).toBe(
      '[MAYOR][HOME][#8] All sessions carried to finished',
    );
    expect(
      decideWorkspaceName({
        current: MAYOR_OLD,
        records: [line({nameSet: MAYOR_OLD})],
        toolPart: MAYOR_NEW,
      }),
    ).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: null,
      rule: 'tools',
      target: MAYOR_NEW,
    });
  });

  test('a recorded name with his name after it: the marks change, his name stays', () => {
    const his = '[HOME] Job alerts, usage reading and leaner session reports';
    const old = `[HOME] H1 Alerts privacy reports (${his})`;
    const toolPart = sessionDisplayName('HOME', 'Alerts privacy reports', {
      handoff: 1,
      mayor: false,
    });
    expect(
      decideWorkspaceName({
        current: old,
        records: [line({hisName: his, nameSet: old})],
        toolPart,
      }),
    ).toMatchObject({
      hisName: his,
      kind: 'rename',
      rule: 'tools',
      target: `[HOME][#1] Alerts privacy reports (${his})`,
    });
  });

  test.each([
    [MAYOR_OLD],
    ['[HOME] H1 Alerts privacy reports'],
    ['[SCREENSHOT-APP] H3 Screenshot app: broadcast build on your phone first'],
    ['[HOME] H? migrate the db'],
    ['[MAYOR] [HOME] migrate the db'],
    ['[HOME][#2] a name in the new form'],
  ])(
    'no record claims %s: still the tool’s, replaced whole (rule 3)',
    (old) => {
      const toolPart = '[HOME][#4] the title now';
      expect(
        decideWorkspaceName({current: old, records: [], toolPart}),
      ).toEqual({
        hisName: null,
        kind: 'rename',
        replacedName: old,
        rule: 'marked',
        target: toolPart,
      });
    },
  );

  test('a recorded hisName that carries old marks is demoted, not kept in parentheses', () => {
    const misread = '[HOME] H2 an older title';
    const shown = `[HOME] some title (${misread})`;
    expect(
      decideWorkspaceName({
        current: shown,
        records: [line({hisName: misread, nameSet: shown})],
        toolPart: '[HOME][#3] some title',
      }),
    ).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: misread,
      rule: 'tools',
      target: '[HOME][#3] some title',
    });
  });

  test('control: an unrecorded name with a tag and no mark is still his (home-base-fuxmk)', () => {
    const his = '[HOME] Monday morning 9/28 Threads super-overhaul';
    expect(
      decideWorkspaceName({
        current: his,
        records: [],
        toolPart: '[HOME][#1] x',
      }),
    ).toEqual({
      hisName: his,
      kind: 'rename',
      replacedName: null,
      rule: 'his',
      target: `[HOME][#1] x (${his})`,
    });
  });
});
