/**
 * Status report Part 1 shows a real empty row between list items on Justin's
 * screen (home-base-j8q3e.1.7.2, parent home-base-j8q3e.1.7).
 *
 * Justin, 2026-10-15: "I have asked a dozen times that things in the
 * "questions for you" section have at least one completely clear empty line
 * between them … I need this to be actually fixed." Measured the same day on
 * Claude Code 2.1.300 (docs/reference/claude-code-markdown-rendering.md): ONE
 * empty line between two list items is dropped on screen, TWO show as one
 * empty row. So in Part 1's markdown every pair of sibling list items in the
 * Progress and Questions sections — each request, each child of a request,
 * each question, and each context bullet and option inside a question — must
 * be at least two empty lines apart.
 *
 * The view is built by hand (no br, no git), so the test is fast and says
 * exactly which pair is too close.
 *
 * NEGATIVE CONTROL (2026-10-15): MARKDOWN_ITEM_GAP in cli-style.ts set to
 * '\n\n' (one empty line) turned "two empty lines between every pair of
 * sibling list items" red, listing all ten pairs with emptyLines 1; restored
 * to '\n\n\n', green. Recorded on home-base-j8q3e.1.7.2.
 */

import type {AskFields} from '../src/thread/ask-format';
import type {PartField, PartOneView} from '../src/thread/part-one';
import type {TreeIssue} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {PLAIN_STYLE} from '../src/cli-style';
import {renderAskDescription} from '../src/thread/ask-format';
import {
  PART_ONE_RULE,
  PART_ONE_SECTION_RULE,
  PART_ONE_SEPARATOR,
  PROGRESS_HEADING,
  QUESTIONS_HEADING,
  renderPartOne,
} from '../src/thread/part-one';
import {siblingPairs} from './markdown-siblings';

function field(label: string, value: string): PartField {
  return {label, sub: [], value: [value]};
}

function question(
  id: string,
  priority: number,
  title: string,
  ask: AskFields,
): TreeIssue {
  return {
    beadsDir: '/nowhere/.beads',
    closeReason: null,
    closedAt: null,
    createdAt: null,
    description: renderAskDescription(ask),
    id,
    issueType: 'question',
    labels: [],
    notes: null,
    parentIds: [],
    priority,
    status: 'open',
    title,
    updatedAt: null,
  };
}

/** Two requests (3 and 2 children), three questions (5, 1 and 0 sub-items). */
const VIEW: PartOneView = {
  beadProblems: [],
  git: [field('Repo', 'work-repo'), field('Branch', 'feature/export')],
  messages: [
    {label: 'Your first message', note: null, quote: '"Make it fast."'},
    {label: 'Your last message', note: null, quote: '"keep going"'},
  ],
  progress: '1 of 2 requests done',
  questions: [
    question('t-1.3', 0, 'Which bucket should the runbook name?', {
      context: ['The runbook names one bucket.', 'Both buckets exist today.'],
      default: {kind: 'none', why: 'a P0 has no default'},
      form: 'pick',
      header: null,
      options: [
        {label: 'exports-prod', why: 'the bucket the cron job uses'},
        {label: 'exports-archive', why: 'the older bucket'},
        {label: 'a new bucket', why: null},
      ],
      recommended: 0,
    }),
    question('t-1.4', 2, 'Retire the old logger script?', {
      context: ['Nothing calls it since September.'],
      default: {kind: 'text', text: 'I retire it.'},
      form: 'approve',
      header: null,
      options: [],
      recommended: null,
    }),
    question('t-1.5', 3, 'Should the export gzip its output?', {
      context: [],
      default: {kind: 'text', text: 'I leave it uncompressed.'},
      form: 'answer',
      header: null,
      options: [],
      recommended: null,
    }),
  ],
  requests: [
    {
      blockedOn: null,
      children: [
        {icon: '✅', id: 't-1.1.1', title: 'Profile the slow query'},
        {icon: '✅', id: 't-1.1.2', title: 'Add the missing index'},
        {icon: '🔲', id: 't-1.1.3', title: 'Batch the writes'},
      ],
      icon: '🔲',
      id: 't-1.1',
      stage: 'tested — next: built',
      title: 'Make the nightly export twice as fast',
    },
    {
      blockedOn: 'blocked on question 1',
      children: [
        {icon: '🔲', id: 't-1.2.1', title: 'Draft the runbook'},
        {icon: '🔲', id: 't-1.2.2', title: 'Review the runbook'},
      ],
      icon: '🛑',
      id: 't-1.2',
      stage: null,
      title: 'Write the export runbook',
    },
  ],
  resume: [field('Resume', 'claude --resume 0000')],
  session: field('Session', '[WORK-REPO] Make the nightly export faster'),
  state: [
    field('Status', '🛑 Waiting on you'),
    field('You need to', 'Answer: Which bucket should the runbook name?'),
  ],
  times: [field('Started', 'Tue 2030-01-01 9:00 am')],
};

/** The lines of a `## heading` section, up to the next section rule. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" in Part 1`);
  const end = lines.indexOf(PART_ONE_SECTION_RULE, start);
  return lines.slice(start, end < 0 ? lines.length : end);
}

describe('Part 1 markdown spacing (home-base-j8q3e.1.7.2)', () => {
  const markdown = renderPartOne(VIEW, PLAIN_STYLE);
  const pairs = [
    ...siblingPairs(section(markdown, PROGRESS_HEADING)),
    ...siblingPairs(section(markdown, QUESTIONS_HEADING)),
  ];

  test('finds every sibling pair: 1 request pair, 3 child pairs, 2 question pairs, 4 pairs inside question 1', () => {
    // Guards the check below against passing on a list it never found. In
    // the order of the FIRST item of each pair.
    expect(pairs.map((pair) => pair.next)).toEqual([
      '2. 🛑 **Write the export runbook** (t-1.2) — blocked on question 1',
      '- ✅ Add the missing index (t-1.1.2)',
      '- 🔲 Batch the writes (t-1.1.3)',
      '- 🔲 Review the runbook (t-1.2.2)',
      '2. 🟡 P2 · [Approve Y/n] **Retire the old logger script?** (t-1.4)',
      '- Both buckets exist today.',
      '- a. (Recommended) exports-prod — the bucket the cron job uses',
      '- b. exports-archive — the older bucket',
      '- c. a new bucket',
      '3. ⚪ P3 · [Answer] **Should the export gzip its output?** (t-1.5)',
    ]);
  });

  test('two empty lines between every pair of sibling list items', () => {
    expect(pairs.filter((pair) => pair.emptyLines < 2)).toEqual([]);
  });

  test('the layout: rule, Session alone, then sections behind --- rules, the separator last', () => {
    const lines = markdown.split('\n');
    expect(lines[0]).toBe(PART_ONE_RULE);
    expect(lines[2]).toBe(
      '**Session:** [WORK-REPO] Make the nightly export faster',
    );
    expect(lines.at(-1)).toBe(PART_ONE_SEPARATOR);
    const headings = lines.filter(
      (line) =>
        line.startsWith('## ') ||
        line === PART_ONE_SECTION_RULE ||
        /^\*\*Your (first|last) message:\*\*$/u.test(line),
    );
    expect(headings).toEqual([
      '---',
      '---',
      '## Progress',
      '---',
      '**Your first message:**',
      '**Your last message:**',
      '---',
      '## Questions for you',
      '---',
    ]);
    expect(markdown).toContain('> "Make it fast."');
    // A field group stays tight: Status and You need to stack directly.
    expect(markdown).toContain(
      '* **Status:** 🛑 Waiting on you\n* **You need to:** Answer:',
    );
  });
});
