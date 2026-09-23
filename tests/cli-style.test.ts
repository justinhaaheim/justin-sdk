/**
 * src/cli-style.ts — the shared colour / spacing / wrapping primitives
 * (home-base-k0b8n.10, K11).
 *
 * The properties pinned here are the ones Justin's feedback and critical rule
 * 14 turn into contracts: piped output is NEVER wrapped and never carries an
 * escape; a terminal gets hanging-indent wrapping at the body column; and every
 * wrapped line carries complete escapes of its own, because Bun.wrapAnsi on its
 * own drops all but the last SGR code at a wrap point (measured 2026-09-23).
 *
 * NEGATIVE CONTROLS are inline: the unwrapped case is re-run with a width, and
 * must then wrap — so "stays one line" cannot pass because wrapping is broken.
 */

import {describe, expect, test} from 'bun:test';

import {
  BODY_COLUMN,
  displayWidth,
  outputStyle,
  padEndWidth,
  paint,
  PLAIN_STYLE,
  sectionHeader,
  shouldStyle,
  spacedList,
  terminalWidth,
  wrapHanging,
} from '../src/cli-style';

const ESC = '\u001b[';
const LONG = Array.from({length: 60}, (_v, i) => `word${i}`).join(' ');

describe('shouldStyle — the one colour gate', () => {
  test('NO_COLOR wins over everything, FORCE_COLOR forces, else only a TTY', () => {
    expect(shouldStyle({isTTY: true}, {NO_COLOR: '1'})).toBe(false);
    expect(shouldStyle({isTTY: true}, {FORCE_COLOR: '1', NO_COLOR: '1'})).toBe(
      false,
    );
    expect(shouldStyle({isTTY: false}, {FORCE_COLOR: '1'})).toBe(true);
    expect(shouldStyle({isTTY: true}, {})).toBe(true);
    expect(shouldStyle({isTTY: false}, {})).toBe(false);
    // An empty value is unset, per the NO_COLOR convention.
    expect(shouldStyle({isTTY: true}, {NO_COLOR: ''})).toBe(true);
  });
});

describe('terminalWidth — the one wrap gate', () => {
  test('a TTY wraps at min(columns − 2, 120)', () => {
    expect(terminalWidth({columns: 100, isTTY: true}, {})).toBe(98);
    expect(terminalWidth({columns: 300, isTTY: true}, {})).toBe(120);
  });

  test('a pipe NEVER wraps, whatever COLUMNS says (critical rule 14)', () => {
    expect(terminalWidth({isTTY: false}, {COLUMNS: '100'})).toBeNull();
    expect(terminalWidth({}, {})).toBeNull();
  });

  test('FORCE_COLOR + a numeric COLUMNS renders the terminal view into a file', () => {
    expect(
      terminalWidth({isTTY: false}, {COLUMNS: '100', FORCE_COLOR: '1'}),
    ).toBe(98);
    // Not a width anyone set: '' is 0 to Number(), '80x' is 80 to parseInt.
    expect(
      terminalWidth({isTTY: false}, {COLUMNS: '', FORCE_COLOR: '1'}),
    ).toBeNull();
    expect(
      terminalWidth({isTTY: false}, {COLUMNS: '80x', FORCE_COLOR: '1'}),
    ).toBeNull();
    expect(
      terminalWidth({isTTY: false}, {COLUMNS: '0', FORCE_COLOR: '1'}),
    ).toBeNull();
  });
});

describe('paint, sectionHeader, spacedList', () => {
  test('NO colour emits no escape bytes at all', () => {
    expect(paint('x', ['bold', 'red'], false)).toBe('x');
    expect(sectionHeader('MESSAGES', {color: false, emoji: '📨'})).toBe(
      '  📨 MESSAGES',
    );
  });

  test('colour is one combined sequence, always reset', () => {
    expect(paint('x', ['bold', 'red'], true)).toBe(`${ESC}1;31mx${ESC}0m`);
    expect(sectionHeader('MESSAGES', {color: true})).toBe(
      `  ${ESC}1;35mMESSAGES${ESC}0m`,
    );
  });

  test('spacedList puts exactly one blank line between blocks', () => {
    expect(spacedList(['a', '', 'b'])).toBe('a\n\nb');
  });
});

describe('wrapHanging', () => {
  test('width null: a 300-char line stays ONE line at its indent', () => {
    const line = 'x'.repeat(300);
    const out = wrapHanging(line, {hang: 8, indent: 6, width: null});
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe(`      ${line}`);
    // NEGATIVE CONTROL: the same line with a width does wrap — so the assertion
    // above is about the null width, not about wrapping being broken.
    const forced = wrapHanging(line, {hang: 8, indent: 6, width: 80});
    expect(forced.split('\n').length).toBeGreaterThan(1);
  });

  test('a terminal width hangs continuation lines at the hang column', () => {
    const out = wrapHanging(LONG, {hang: 9, indent: BODY_COLUMN, width: 60});
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[0]?.startsWith('      word0')).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('         ')).toBe(true);
      expect(line.startsWith('          ')).toBe(false);
    }
    for (const line of lines)
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
    // Nothing lost, nothing added: the words are all there, in order.
    expect(lines.map((line) => line.trim()).join(' ')).toBe(LONG);
  });

  test('every wrapped line carries its OWN complete escapes', () => {
    // Bold + red stacked: Bun.wrapAnsi alone continues this as red WITHOUT
    // bold, and never closes it on the line it opened.
    const styled = `${paint(LONG, ['bold', 'red'], true)} tail`;
    const lines = wrapHanging(styled, {hang: 8, indent: 6, width: 60}).split(
      '\n',
    );
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines.slice(0, -1)) {
      const body = line.trimStart();
      expect(body.startsWith(`${ESC}1;31m`)).toBe(true);
      expect(body.endsWith(`${ESC}0m`)).toBe(true);
    }
    // The indentation itself is never styled — an underline would show on it.
    for (const line of lines.slice(1)) {
      expect(line.startsWith('        ')).toBe(true);
    }
  });

  test('a line that already fits is returned exactly as given', () => {
    expect(wrapHanging('short', {hang: 8, indent: 6, width: 80})).toBe(
      '      short',
    );
  });

  test('an explicit newline starts a physical line at the hang column', () => {
    expect(wrapHanging('one\ntwo', {hang: 8, indent: 6, width: null})).toBe(
      '      one\n        two',
    );
  });
});

describe('display width — the table-column pad (k0b8n.10 board)', () => {
  test('emoji count two columns, escapes count none', () => {
    expect(displayWidth('🛑 1/4 ask')).toBe(10);
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth(paint('abc', ['bold', 'red'], true))).toBe(3);
  });

  test('padEndWidth fills DISPLAY columns, where String.padEnd would not', () => {
    const padded = padEndWidth('✅ 100%', 12);
    expect(displayWidth(padded)).toBe(12);
    // The control: padEnd measures UTF-16 code units, and ✅ is ONE unit but
    // TWO columns, so the same call overshoots by a column — the misalignment
    // the board used to print between ✅ and 🛑 rows.
    expect(displayWidth('✅ 100%'.padEnd(12))).toBe(13);
    expect(padEndWidth('too wide for it', 3)).toBe('too wide for it');
  });

  test('outputStyle is the colour gate and the width gate together', () => {
    expect(outputStyle({isTTY: false}, {})).toEqual(PLAIN_STYLE);
    expect(outputStyle({columns: 82, isTTY: true}, {})).toEqual({
      color: true,
      width: 80,
    });
    expect(outputStyle({columns: 82, isTTY: true}, {NO_COLOR: '1'})).toEqual({
      color: false,
      width: 80,
    });
  });
});
