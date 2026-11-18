/**
 * home-base-kwand.3: `thread focus --workspace <uuid>` says whether that cmux
 * workspace exists now, from one read-only tree read. The threads dashboard's
 * `o` on a session whose cmux restore failed opens a new tab there when it
 * is present and falls back to a new workspace when it is gone; unknown must
 * never read as gone (critical rule 7). No cmux is run: the trees are fakes.
 */
import type {CmuxTreeRead} from '../src/thread/cmux';

import {describe, expect, test} from 'bun:test';

import {focusJsonOf, workspaceNowOf} from '../src/thread/focus';

const WS = 'cccc3333-0000-4000-8000-000000000002';
const OTHER = 'cccc3333-0000-4000-8000-000000000009';

function tree(...ids: string[]): CmuxTreeRead {
  return {
    kind: 'read',
    tree: {
      windows: [
        {
          id: 'dddd4444-0000-4000-8000-000000000001',
          ref: 'window:1',
          workspaces: ids.map((id, index) => ({
            id,
            ref: `workspace:${index + 1}`,
            surfaceIds: [],
            title: null,
          })),
        },
      ],
    },
  };
}

describe('workspaceNowOf', () => {
  test('present when the tree holds it, whatever the case', () => {
    expect(workspaceNowOf(tree(OTHER, WS.toUpperCase()), WS)).toEqual({
      id: WS,
      state: 'present',
    });
  });

  test('gone when the tree was read and does not hold it', () => {
    expect(workspaceNowOf(tree(OTHER), WS)).toEqual({id: WS, state: 'gone'});
    expect(workspaceNowOf(tree(), WS)).toEqual({id: WS, state: 'gone'});
  });

  // NEGATIVE CONTROL run: an unreadable tree answered as gone -> this test
  // failed with state "gone".
  test('unknown when the tree could not be read, never gone', () => {
    const answer = workspaceNowOf(
      {kind: 'unreadable', reason: 'cmux timed out'},
      WS,
    );
    expect(answer).toEqual({
      id: WS,
      reason: 'the cmux tree could not be read: cmux timed out',
      state: 'unknown',
    });
  });

  test('unknown for anything but a uuid', () => {
    expect(workspaceNowOf(tree('workspace:3'), 'workspace:3').state).toBe(
      'unknown',
    );
  });
});

describe('focusJsonOf carries the answer', () => {
  const refused = {
    chain: ['demo-s2'],
    code: 'paneNone' as const,
    head: null,
    kind: 'refused' as const,
    notes: [],
    reason: 'no live pane',
    resume: null,
    target: 'demo-s2',
  };

  test('null when --workspace was not passed, the answer when it was', () => {
    expect(focusJsonOf(refused).workspace).toBeNull();
    expect(focusJsonOf(refused, {id: WS, state: 'gone'}).workspace).toEqual({
      id: WS,
      state: 'gone',
    });
  });
});
