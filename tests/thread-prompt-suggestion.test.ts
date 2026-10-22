/**
 * home-base-yukaf.36 D1: findInputBox tells Claude Code's prompt suggestion
 * apart from typed text, ONLY on positive evidence: a line under the box
 * ending with "← N agents", which Claude Code draws only while the input is
 * empty (pane-join.ts EMPTY_INPUT_FOOTER cites the binary).
 *
 * The fixtures are real `cmux read-screen` captures of Justin's live panes on
 * 2026-10-22, cut to the input box and the lines under it (no conversation):
 *   prompt-suggestion/s13-suggestion-push-main.txt   surface:13, Claude Code
 *     2.1.289: the suggestion "push main", footer "… · ← 19 agents"
 *   prompt-suggestion/s253-suggestion-v2.1.306.txt   surface:253, 2.1.306:
 *     the suggestion "yes, wrap it as one command", the status line wrapped
 *     over three lines above the footer
 *   prompt-suggestion/s147-typed-plea.txt            surface:147, 2.1.296:
 *     "Plea", typed by Justin; the footer has no "← N agents"
 *   prompt-suggestion/s59-typed-q2.txt               surface:59, 2.1.289:
 *     "Q2 Fix A is the right one. Q3", typed by Justin; no suffix
 * and two older ones: fixtures/pane-screen-s24-0655.txt (an empty box, footer
 * "· ← 19 agents") and scripts/__fixtures__/pane-backfill/vim-normal.txt (an
 * empty box in vim NORMAL mode, footer "⏵⏵ auto mode on … · ← 19 agents").
 *
 * NEGATIVE CONTROLS: recorded in home-base-yukaf.36's notes.
 */

import type {UndoState} from '../src/thread/open-undo';

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {gatePane, renderUndo} from '../src/thread/open-undo';
import {findInputBox, screenLines} from '../src/thread/pane-join';

const FIXTURES = join(import.meta.dir, 'fixtures');

function fixture(...path: string[]): string {
  return readFileSync(join(FIXTURES, ...path), 'utf8');
}

const S13 = fixture('prompt-suggestion', 's13-suggestion-push-main.txt');
const S253 = fixture('prompt-suggestion', 's253-suggestion-v2.1.306.txt');
const S147 = fixture('prompt-suggestion', 's147-typed-plea.txt');
const S59 = fixture('prompt-suggestion', 's59-typed-q2.txt');
const S24_EMPTY = fixture('pane-screen-s24-0655.txt');
const VIM_NORMAL_EMPTY = readFileSync(
  join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'scripts',
    '__fixtures__',
    'pane-backfill',
    'vim-normal.txt',
  ),
  'utf8',
);

/** The footer line of the s13 capture, verbatim. */
const S13_FOOTER =
  '  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← 19 agents';

function boxOf(text: string) {
  return findInputBox(screenLines(text));
}

describe('findInputBox: a suggestion only on the empty-input footer (yukaf.36 D1)', () => {
  test('a suggestion with the "← 19 agents" footer is a suggestion (surface:13, 2.1.289)', () => {
    expect(boxOf(S13)).toMatchObject({draft: 'push main', suggested: true});
  });

  test('a suggestion under a wrapped status line is a suggestion too (surface:253, 2.1.306)', () => {
    expect(boxOf(S253)).toMatchObject({
      draft: 'yes, wrap it as one command',
      suggested: true,
    });
  });

  test('a typed fragment, whose footer has no "← N agents", is typed (surface:147)', () => {
    expect(boxOf(S147)).toMatchObject({draft: 'Plea', suggested: false});
  });

  test('a typed sentence without the suffix is typed (surface:59)', () => {
    expect(boxOf(S59)).toMatchObject({
      draft: 'Q2 Fix A is the right one. Q3',
      suggested: false,
    });
  });

  test('a box with no footer at all is typed: absence proves nothing', () => {
    // The real surface:13 box with nothing under it, then with Justin's
    // status lines but no Claude Code footer: the shape of a pane with no
    // agents, where the hint is never drawn.
    const lines = screenLines(S13);
    expect(findInputBox(lines.slice(0, 3))).toMatchObject({
      draft: 'push main',
      suggested: false,
    });
    expect(
      findInputBox(lines.filter((line) => line !== S13_FOOTER)),
    ).toMatchObject({draft: 'push main', suggested: false});
  });

  test('the hint in the conversation ABOVE the box does not count', () => {
    const screen = ['⏺ It printed:', S13_FOOTER, '', S59].join('\n');
    expect(boxOf(screen)).toMatchObject({
      draft: 'Q2 Fix A is the right one. Q3',
      suggested: false,
    });
  });

  test('an empty box with the hint is empty, not a suggestion', () => {
    expect(boxOf(S24_EMPTY)).toMatchObject({draft: '', suggested: false});
    expect(boxOf(VIM_NORMAL_EMPTY)).toMatchObject({
      draft: '',
      suggested: false,
    });
  });

  test('the mode text before the hint does not matter (vim NORMAL)', () => {
    // The real vim-NORMAL footer ("⏵⏵ auto mode on (shift+tab to cycle) · ←
    // 19 agents", no "-- INSERT --") under a box showing text.
    const screen = VIM_NORMAL_EMPTY.replace(/^❯\s*$/mu, '❯ push main');
    expect(boxOf(screen)).toMatchObject({
      draft: 'push main',
      suggested: true,
    });
  });

  test('"← 1 agent" and "← 99+ agents" count; "← for agents" and a hint mid-line do not', () => {
    const footer = (end: string) =>
      S13.replace('· ← 19 agents', end).replace(/\n$/u, '');
    expect(boxOf(footer('· ← 1 agent'))?.suggested).toBe(true);
    expect(boxOf(footer('· ← 99+ agents'))?.suggested).toBe(true);
    // Also drawn only on an empty input, but not matched: not the counted
    // form this rule was measured on (see EMPTY_INPUT_FOOTER).
    expect(boxOf(footer('· ← for agents'))?.suggested).toBe(false);
    expect(boxOf(footer('· ← 19 agents · more'))?.suggested).toBe(false);
  });
});

describe('check 1 of thread close and thread open --undo (yukaf.36 D3)', () => {
  const S13_SESSION = '9ba5e2fa-8bc5-4e90-b6ef-a986c897e5d1';
  const S59_SESSION = '3b961d66-d405-4b14-be5f-356f8fe201e8';
  const claudeOn = (session: string) => [
    {
      command: `/Users/j/.local/bin/claude --resume ${session}`,
      etime: '01:00',
      exePath: '/Users/j/.local/bin/claude',
      name: 'claude',
      pid: 101,
      ppid: 1,
      tty: 'ttys001',
    },
  ];

  test('a suggestion passes: no draft, no reason, the suggestion named (the --undo form, its session expected)', () => {
    const gate = gatePane({
      label: 'pane surface:13',
      procsOnTty: claudeOn(S13_SESSION),
      screen: {kind: 'read', text: S13},
      sessionId: S13_SESSION,
      tty: 'ttys001',
    });
    expect(gate).toMatchObject({
      draft: null,
      reasons: [],
      shown: S13_SESSION,
      suggestion: 'push main',
    });
  });

  test('typed text keeps the pane, exactly as before', () => {
    const gate = gatePane({
      label: 'pane surface:59',
      procsOnTty: claudeOn(S59_SESSION),
      screen: {kind: 'read', text: S59},
      sessionId: null,
      tty: 'ttys001',
    });
    expect(gate).toMatchObject({
      draft: {
        sessionId: S59_SESSION,
        text: 'Q2 Fix A is the right one. Q3',
      },
      reasons: ['unsent text in the input box of pane surface:59'],
      suggestion: null,
    });
  });

  test('--undo names the suggestion on the workspace it would close', () => {
    const state: UndoState = {
      blank: [],
      closed: [],
      dryRun: true,
      failed: [],
      failures: [],
      finishedAt: null,
      gone: [],
      kept: [],
      movedBack: [],
      notMovedBack: [],
      planned: [
        {
          name: '[HB] a session',
          pids: [101],
          sessionId: S13_SESSION,
          suggestions: [
            {surfaceId: 'SURF-13', surfaceRef: 'surface:13', text: 'push main'},
          ],
          workspaceId: 'WS-13',
        },
      ],
      startedAt: '2026-10-22T12:00:00.000Z',
      windowsClosed: [],
      windowsLeft: [],
    };
    const output = renderUndo(state, {
      now: new Date('2026-10-22T12:00:00.000Z'),
      recordAt: '2026-10-22T11:00:00.000Z',
      recordPath: '/tmp/x.json',
      style: PLAIN_STYLE,
    });
    expect(output).toContain('Would close (1)');
    expect(output).toContain(
      `Input box:  surface:13 shows Claude Code's suggestion "push main", not unsent text, so it counts as empty`,
    );
  });
});
