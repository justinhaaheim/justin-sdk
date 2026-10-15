/**
 * Every markdown output Claude pastes puts TWO empty lines between sibling
 * list items (home-base-j8q3e.1.10 F7). Part 1 has its own test
 * (thread-part-one-spacing.test.ts) and `thread handoff` is covered in
 * thread-handoff.test.ts; this file covers `thread ask`, `thread answers`, and
 * the legacy report renderer (`normalizeReportText`, which every legacy
 * report's markdown runs through).
 *
 * Measured on Claude Code 2.1.300 (docs/reference/claude-code-markdown-
 * rendering.md): one empty line between list items is dropped on screen, two
 * show as one empty row. So each test asserts both: the pairs that must show a
 * gap have two, and no pair anywhere has exactly one.
 *
 * Built by hand (no br, no git), so it is fast and names the pair that is too
 * close.
 */

import type {BrIssue} from '../src/beads/br';
import type {AskFields} from '../src/thread/ask-format';

import {describe, expect, test} from 'bun:test';

import {PLAIN_STYLE} from '../src/cli-style';
import {describeAnswersOutcome} from '../src/thread/answers';
import {describeAskOutcome} from '../src/thread/ask';
import {renderAskDescription} from '../src/thread/ask-format';
import {normalizeReportText} from '../src/thread/render-markdown';
import {siblingPairs} from './markdown-siblings';

const ASK: AskFields = {
  context: ['The runbook names one bucket.', 'Both buckets exist today.'],
  default: {kind: 'text', text: 'I keep the old bucket.'},
  form: 'pick',
  header: null,
  options: [
    {label: 'exports-prod', why: 'the bucket the cron job uses'},
    {label: 'exports-archive', why: 'the older bucket'},
  ],
  recommended: 0,
};

function answered(id: string, title: string): BrIssue {
  return {
    closeReason: 'answer: a',
    closedAt: '2030-01-01T10:00:00.000Z',
    createdAt: '2030-01-01T09:00:00.000Z',
    description: renderAskDescription(ASK),
    id,
    issueType: 'question',
    labels: [],
    notes: null,
    priority: 2,
    status: 'closed',
    title,
    updatedAt: '2030-01-01T10:00:00.000Z',
  };
}

function tooClose(text: string): {
  oneEmptyLine: ReturnType<typeof siblingPairs>;
  pairs: ReturnType<typeof siblingPairs>;
} {
  const pairs = siblingPairs(text.split('\n'));
  return {
    oneEmptyLine: pairs.filter((pair) => pair.emptyLines === 1),
    pairs,
  };
}

describe('F7: two empty lines between sibling list items in pasted markdown', () => {
  test('thread ask: the context bullets and the options', () => {
    const {lines} = describeAskOutcome(
      {
        description: renderAskDescription(ASK),
        fields: ASK,
        id: 't-1.3',
        kind: 'filed',
        parent: 't-1',
        priority: 2,
        question: 'Which bucket?',
        request: null,
        unlinkedWhy: 'no request named',
      },
      PLAIN_STYLE,
    );
    const {oneEmptyLine, pairs} = tooClose(lines.join('\n'));
    // The context bullets and the options are one list at one indent: 3 pairs.
    expect(pairs).toHaveLength(3);
    expect(pairs.filter((pair) => pair.emptyLines < 2)).toEqual([]);
    expect(oneEmptyLine).toEqual([]);
  });

  test('thread answers: the questions, and the bullets inside each', () => {
    const {lines} = describeAnswersOutcome(
      {
        answered: [
          {db: '/x/.beads/beads.db', issue: answered('t-1.3', 'Which?')},
          {db: '/x/.beads/beads.db', issue: answered('t-1.4', 'Where?')},
        ],
        delivered: null,
        kind: 'read',
        problems: [],
        sessionId: 's',
      },
      PLAIN_STYLE,
    );
    const {oneEmptyLine, pairs} = tooClose(lines.join('\n'));
    const questions = pairs.filter((pair) => /^\d+\. /u.test(pair.next));
    expect(questions).toHaveLength(1);
    // 1 question pair, and 3 bullet pairs inside each question.
    expect(pairs).toHaveLength(7);
    expect(pairs.filter((pair) => pair.emptyLines < 2)).toEqual([]);
    expect(oneEmptyLine).toEqual([]);
  });

  test('the legacy report: next steps, asks and their options', () => {
    const report = [
      '🛑🛑🛑',
      '',
      '**▶️ What happens next (mine):**',
      '- ⚽ Goal: ship it',
      '- ➡️ the read path',
      '',
      '**🙋 Asks — everything I need from you:**',
      '  1. P1 · [Pick a/b] Discard or commit? (th-1.1)',
      '     Context: the dirty file',
      '     a. (Recommended) Discard it',
      '     b. Commit it',
      "     If you don't answer: I leave it",
      '  2. (P3) · [Approve Y/n] Hourly? (th-1.2)',
      "     If you don't answer: hourly",
    ].join('\n');
    const normalized = normalizeReportText(report);
    const {oneEmptyLine, pairs} = tooClose(normalized);
    expect(pairs.map((pair) => pair.next)).toEqual([
      '- ➡️ the read path',
      '2. (P3) · [Approve Y/n] Hourly? (th-1.2)',
      '- b. Commit it',
    ]);
    expect(pairs.filter((pair) => pair.emptyLines < 2)).toEqual([]);
    expect(oneEmptyLine).toEqual([]);
    // Idempotent: a stored report normalized twice is unchanged.
    expect(normalizeReportText(normalized)).toBe(normalized);
  });
});
