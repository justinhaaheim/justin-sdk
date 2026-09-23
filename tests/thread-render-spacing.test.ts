/**
 * K11 readable output (home-base-k0b8n.10) and honest placeholders
 * (home-base-k0b8n.14).
 *
 * Justin, 2026-09-23: "I 100% need an empty line between every single
 * list/bullet/ask item. And each item itself needs empty lines between the
 * options you provide me." These tests pin that on the markdown Claude pastes,
 * pin the de-duplicated option letter (`a. (Recommended) a. Merge` was in his
 * screenshot), pin that a report STORED before this change is upgraded on the
 * way out, and pin that a thread with no report is never printed as one.
 *
 * NEGATIVE CONTROLS (2026-09-23): `stripOptionLabel` returning its input
 * unchanged turned "the letter is printed once" red; `compactStoredReport`
 * without its `isRenderedReport` guard turned the k0b8n.14 test red on
 * "nothing needs you". Both restored green — recorded on home-base-k0b8n.10.
 */

import type {ThreadFacts} from '../src/thread/facts';

import {describe, expect, test} from 'bun:test';

import {stripOptionLabel} from '../src/thread/render';
import {ansiFromReportText} from '../src/thread/render-ansi';
import {
  compactStoredReport,
  DEVIATIONS_HEADING,
  normalizeReportText,
} from '../src/thread/render-markdown';
import {renderStoredNotes} from '../src/thread/show';
import {startThreadFields} from '../src/thread/start';

/** A report as the renderer stored it BEFORE 2026-09-23: dense, old headings. */
const LEGACY = [
  '🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑🛑',
  '',
  '⚡ ✅ Work completed · 🙋 needs your answers · 📈 90% · no P0 asks',
  '',
  '📦 home-base · 🌿 main · 🌳 primary checkout · 🔢 316k',
  '🌲 clean · 0 ahead / 0 behind · HEAD 062a8ad1b789',
  '',
  '**Thread:** a legacy thread',
  '**You asked me to:** tidy it',
  '',
  '**What I did:**',
  '- ✅ one',
  '- ✅ two',
  '',
  '**Deviations from what you asked for:**',
  '- ⚖️ Judgment call — did it my way',
  '- ℹ️ FYI — also this',
  '',
  '**Asks — everything I need from you:**',
  '  1. P1 · [Pick a/b] Discard or commit? (th-old.1)',
  '     Context: the dirty file',
  '     a. (Recommended) a. Discard it',
  '     b. b. Commit it',
  "     If you don't answer: I leave it",
  '  2. (P3) · [Approve Y/n] Hourly? (th-old.2)',
  '     Context: daily now',
  "     If you don't answer: daily",
  '',
  '**Prior asks — closed by this report:**',
  '- (none closed this time)',
  '',
  'Answer: bun run justin-sdk thread answer th-old',
  '🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️🕉️',
].join('\n');

/** No two non-blank lines in a row, between `from` and the next heading. */
function adjacentPairs(markdown: string, from: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.includes(from));
  const pairs: string[][] = [];
  for (let i = start + 1; i < lines.length - 1; i += 1) {
    const here = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (next.startsWith('**')) break;
    if (here !== '' && next !== '') pairs.push([here, next]);
  }
  return pairs;
}

describe('the option letter is printed ONCE (K11 rule 7)', () => {
  test('a leading label matching the letter is stripped, in every spelling', () => {
    expect(stripOptionLabel('a', 'a. Merge')).toBe('Merge');
    expect(stripOptionLabel('a', 'A) Merge')).toBe('Merge');
    expect(stripOptionLabel('a', '(a) Merge')).toBe('Merge');
    expect(stripOptionLabel('a', 'a: Merge')).toBe('Merge');
    expect(stripOptionLabel('a', 'a — Merge')).toBe('Merge');
    expect(stripOptionLabel('a', 'a. a. Merge')).toBe('Merge');
  });

  test('NEGATIVE CONTROL: a different letter, a word, or nothing left is kept', () => {
    // Option b may begin "a. …" and mean it.
    expect(stripOptionLabel('b', 'a. Merge')).toBe('a. Merge');
    expect(stripOptionLabel('a', 'A new approach')).toBe('A new approach');
    expect(stripOptionLabel('a', 'a.')).toBe('a.');
  });

  test('a stored report with the double letter comes out with one', () => {
    const upgraded = normalizeReportText(LEGACY);
    expect(upgraded).toContain('     - a. (Recommended) Discard it');
    expect(upgraded).toContain('     - b. Commit it');
    expect(upgraded).not.toContain('a. (Recommended) a.');
  });
});

describe('a blank line between everything (K11 rules 1 and 6)', () => {
  test('no two non-blank lines touch anywhere in the Asks section', () => {
    const upgraded = normalizeReportText(LEGACY);
    expect(adjacentPairs(upgraded, 'Asks — everything')).toEqual([]);
    // NEGATIVE CONTROL: the legacy input itself has them — so the helper finds
    // what it is looking for, and the empty result above is a real one.
    expect(adjacentPairs(LEGACY, 'Asks — everything').length).toBeGreaterThan(
      4,
    );
  });

  test('nor in any list, nor between the header fields', () => {
    const upgraded = normalizeReportText(LEGACY);
    expect(adjacentPairs(upgraded, 'What I did')).toEqual([]);
    expect(upgraded).toContain(
      '**Thread:** a legacy thread\n\n**You asked me to:**',
    );
    expect(upgraded).toContain(
      '📦 home-base · 🌿 main · 🌳 primary checkout · 🔢 316k\n\n🌲',
    );
  });

  test('normalizing is idempotent, and a multi-line value keeps its lines together', () => {
    const once = normalizeReportText(LEGACY);
    expect(normalizeReportText(once)).toBe(once);
    const verbatim = normalizeReportText(
      '⚡ x\n\n**Your last message, verbatim:** line one\nline two\n    indented three',
    );
    expect(verbatim).toContain('line one\nline two\n    indented three');
  });

  test('old headings get their emoji, so the compactor still counts deviations', () => {
    const compact = compactStoredReport(LEGACY);
    expect(normalizeReportText(LEGACY)).toContain(DEVIATIONS_HEADING);
    // Two deviations were hidden; "nothing else to flag" would be a claim about
    // a section the compactor failed to find (rule 7).
    expect(compact).toContain('2 more deviations');
    expect(compact).not.toContain('nothing else to flag');
    // The P1 ask is must-see and arrives spaced and de-duplicated.
    expect(compact).toContain('     - a. (Recommended) Discard it');
  });
});

describe('a thread with no report is shown as one (home-base-k0b8n.14)', () => {
  const facts = {
    branch: 'main',
    cwd: '/Users/jhaa/Dev/home-base',
    repo: 'home-base',
    sessionId: '561cc0e4-8d41-4d59-86fa-e3f281f64343',
    transcriptPath: '/t.jsonl',
  } as unknown as ThreadFacts;
  const placeholder = startThreadFields({
    facts,
    sessionId: '561cc0e4-8d41-4d59-86fa-e3f281f64343',
    startedAt: '2026-09-23T12:00:00.000Z',
  }).notes;

  test('the compactor and the terminal renderer pass placeholder notes through untouched', () => {
    expect(compactStoredReport(placeholder)).toBe(placeholder);
    expect(ansiFromReportText(placeholder, {color: true})).toBe(placeholder);
  });

  test('show says "no report yet", prints the notes, and claims nothing it did not measure', () => {
    for (const full of [false, true]) {
      const out = renderStoredNotes(placeholder, {
        color: false,
        full,
        reportCount: 0,
        width: null,
      });
      expect(out.split('\n')[0]).toBe('⚡ ⏳ no report yet');
      expect(out).toContain('NO REPORT YET.');
      expect(out).not.toContain('nothing needs you');
      expect(out).not.toContain('nothing went wrong');
      expect(out).not.toContain('NOT RECORDED');
      expect(out).not.toContain('MUST-SEE');
      // Every line of the notes is there, as written.
      for (const line of placeholder.split('\n')) {
        if (line !== '') expect(out).toContain(line);
      }
    }
    // --full and the compact default print the same thing for a placeholder.
    const args = {color: false, reportCount: 0, width: null};
    expect(renderStoredNotes(placeholder, {...args, full: false})).toBe(
      renderStoredNotes(placeholder, {...args, full: true}),
    );
  });

  test('"no report yet" is said only when the bead records zero reports', () => {
    const base = {color: false, full: false, width: null};
    expect(
      renderStoredNotes(placeholder, {...base, reportCount: null}).split(
        '\n',
      )[0],
    ).toContain('report count UNKNOWN');
    expect(
      renderStoredNotes(placeholder, {...base, reportCount: 2}).split('\n')[0],
    ).toContain('records 2 reports, but its notes are not a rendered report');
  });

  test('a real report is still compacted exactly as before', () => {
    const out = renderStoredNotes(LEGACY, {
      color: false,
      full: false,
      reportCount: 1,
      width: null,
    });
    expect(out).toContain('MUST-SEE');
    expect(out).not.toContain('no report yet');
  });
});
