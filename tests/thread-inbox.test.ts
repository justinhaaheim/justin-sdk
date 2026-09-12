/**
 * `thread inbox` — the read-back path (home-base-p1uj.2).
 *
 * Driven from FIXTURES of what bd actually returns (`bd list -t ask --json`
 * shapes, `bd comments --json` shapes), because the thing worth testing here is
 * the interpretation, not the subprocess: which of three states an ask is in,
 * and whether Justin's answer survives verbatim.
 *
 * THE STATE MACHINE IS THE POINT. answered / skipped / unanswered are three
 * different instructions to the next turn — do this, take your default, still
 * waiting — and the failure that matters is a skip or an unreadable answer
 * being rendered as "he said nothing", which reads as permission.
 */

import {describe, expect, test} from 'bun:test';

import {
  askStateOf,
  noteFrom,
  renderInbox,
  renderInboxAsk,
  stripAnswerPrefix,
  type InboxAsk,
  type InboxView,
} from '../src/thread/inbox';
import {SKIP_COMMENT} from '../src/thread/answer';
import {restateAsk} from '../src/thread/render';

import type {BdComment} from '../src/thread/bd';

function comment(text: string): BdComment {
  return {author: 'jhaa', created_at: '2026-09-12T10:00:00Z', text};
}

const ASK_DESCRIPTION = `[Pick a/b] Ship the prototype behind the knob, or wait?

CONTEXT: the knob defaults off, so shipping changes nothing for other sessions.

OPTIONS:
  a. (Recommended) Ship it now — dogfooding starts today
  b. Wait for the hook — fewer moving parts at once

IF UNANSWERED: I ship it behind the knob.

Answer by commenting on this bead: cd ~/Dev/life && bun run bd comments add <this id> "your answer"
Thread: jl-e9f4`;

describe('askStateOf — three states, never two', () => {
  test('a real comment is an ANSWER', () => {
    expect(askStateOf({}, [comment('ANSWER: b')])).toBe('answered');
  });

  // F2: an answer written AFTER a skip must win. The ask bead's own description
  // tells Justin to `bd comments add`, so this is the documented way to change
  // his mind — and it used to be discarded, handing the next turn permission to
  // take a default against an explicit instruction.
  test('a real comment after a skip is an ANSWER, not a skip', () => {
    expect(
      askStateOf({skippedAt: '2026-09-12T10:00:00Z'}, [comment('ANSWER: b')]),
    ).toBe('answered');
  });

  test('a skip stamp with only the skip comment stays a skip', () => {
    expect(
      askStateOf({skippedAt: '2026-09-12T10:00:00Z'}, [comment(SKIP_COMMENT)]),
    ).toBe('skipped');
  });

  test('a skip stamp whose comment write failed is still a skip', () => {
    expect(askStateOf({skippedAt: '2026-09-12T10:00:00Z'}, [])).toBe('skipped');
  });

  test('a lone skip COMMENT is a skip even when the stamp write failed', () => {
    expect(askStateOf({}, [comment(SKIP_COMMENT)])).toBe('skipped');
  });

  test('no comments at all is UNANSWERED', () => {
    expect(askStateOf({}, [])).toBe('unanswered');
  });

  test('an empty comment body is not an answer', () => {
    expect(askStateOf({}, [comment('   ')])).toBe('unanswered');
  });
});

describe('reading the ask back', () => {
  test('restateAsk keeps the question, context and options, drops the footer', () => {
    const restated = restateAsk(ASK_DESCRIPTION);
    expect(restated).toContain('Ship the prototype behind the knob');
    expect(restated).toContain('a. (Recommended) Ship it now');
    expect(restated).toContain('IF UNANSWERED');
    // The footer is instructions to Justin; Claude reading this back does not
    // need to be told how Justin answers.
    expect(restated).not.toContain('bd comments add');
  });

  test('a description with no footer survives unchanged', () => {
    expect(restateAsk('just a question')).toBe('just a question');
  });

  test('the ANSWER prefix is stripped, a hand-written comment is not mangled', () => {
    expect(stripAnswerPrefix('ANSWER: b')).toBe('b');
    expect(stripAnswerPrefix('yes, do it')).toBe('yes, do it');
  });

  test('noteFrom picks out NOTE comments and leaves answers alone', () => {
    expect(
      noteFrom([comment('ANSWER: b'), comment('NOTE: also check the hook')]),
    ).toBe('also check the hook');
    expect(noteFrom([comment('ANSWER: b')])).toBeNull();
  });
});

// The renderer `thread prepare` now shares (home-base-p1uj.2 follow-up).
// prepare used to print every comment as `ANSWER (<time>): <text>`, so a skip
// arrived as `ANSWER (...): skipped: use default` — a deliberate skip shown as
// an answer — and a real answer as `ANSWER (...): ANSWER: a`. One renderer, so
// the two surfaces cannot drift apart again.
describe('renderInboxAsk — the three shapes prepare and inbox share', () => {
  function base(overrides: Partial<InboxAsk> = {}): InboxAsk {
    return {
      answers: [],
      askIndex: 0,
      blocking: false,
      defaultAction: 'I keep by-repo as the default.',
      id: 'jl-kigm.1',
      kind: 'pick',
      reportCount: 1,
      restated: restateAsk(ASK_DESCRIPTION),
      state: 'unanswered',
      title: 'Which default board view?',
      ...overrides,
    };
  }

  test('ANSWERED: the ask, then ">>> HIS ANSWER: <text>"', () => {
    const lines = renderInboxAsk(
      base({answers: ['a'], state: 'answered'}),
      '  jl-kigm.1 · [pick] BLOCKING · Which default board view?',
    );
    expect(lines[0]).toBe(
      '  jl-kigm.1 · [pick] BLOCKING · Which default board view?',
    );
    expect(lines.join('\n')).toContain('a. (Recommended) Ship it now');
    expect(lines[lines.length - 1]).toBe('     >>> HIS ANSWER: a');
    // The raw comment prefix never leaks through.
    expect(lines.join('\n')).not.toContain('ANSWER: ANSWER:');
  });

  test('SKIPPED: ">>> SKIPPED — use your default: <default>", never an answer', () => {
    const lines = renderInboxAsk(base({state: 'skipped'}), '  head');
    expect(lines[lines.length - 1]).toBe(
      '     >>> SKIPPED — use your default: I keep by-repo as the default.',
    );
    expect(lines.join('\n')).not.toContain('HIS ANSWER');
    // The bug this replaced: the skip comment rendered as an answer.
    expect(lines.join('\n')).not.toContain('skipped: use default"');
  });

  test('UNANSWERED: the ask plus the caller’s note, and no answer line', () => {
    const note = '     (no answer yet — disposition it as carried or decided)';
    const lines = renderInboxAsk(base(), '  head', note);
    expect(lines[lines.length - 1]).toBe(note);
    expect(lines.join('\n')).not.toContain('HIS ANSWER');
    expect(lines.join('\n')).not.toContain('SKIPPED');
    // With no note supplied (inbox's case) the ask still renders, bare.
    expect(renderInboxAsk(base(), '  head')).toHaveLength(lines.length - 1);
  });
});

// F2 end-to-end through the two functions `inbox` AND `prepare` both call —
// `collectInboxAsks` classifies with askStateOf, `renderInboxAsk` renders. There
// is exactly one implementation of each, so this covers both commands.
describe('an answer written after a skip reaches BOTH inbox and prepare', () => {
  test('skippedAt + a later real comment renders HIS ANSWER, not SKIPPED', () => {
    const metadata = {
      blocking: true,
      defaultAction: 'I keep by-repo.',
      kind: 'pick',
      skippedAt: '2026-09-12T10:00:00Z',
    };
    const comments = [comment(SKIP_COMMENT), comment('ANSWER: do b')];
    const state = askStateOf(metadata, comments);
    expect(state).toBe('answered');

    const lines = renderInboxAsk(
      {
        answers: comments
          .map((entry) => stripAnswerPrefix((entry.text ?? '').trim()))
          .filter((text) => text !== '' && text !== SKIP_COMMENT),
        askIndex: 0,
        blocking: true,
        defaultAction: 'I keep by-repo.',
        reportCount: 1,
        id: 'jl-x.1',
        kind: 'pick',
        restated: '[Pick a/b] Which view?',
        state,
        title: 'Which view?',
      },
      '  jl-x.1 · [pick] BLOCKING · Which view?',
      '     (no answer yet — disposition it as carried or decided)',
    );
    const text = lines.join('\n');
    expect(text).toContain('>>> HIS ANSWER: do b');
    expect(text).not.toContain('SKIPPED');
    expect(text).not.toContain('no answer yet');
  });
});

describe('renderInbox', () => {
  const view: InboxView = {
    asks: [
      {
        answers: ['b'],
        askIndex: 0,
        blocking: true,
        defaultAction: 'I ship it behind the knob.',
        id: 'jl-e9f4.1',
        kind: 'pick',
        reportCount: 1,
        restated: restateAsk(ASK_DESCRIPTION),
        state: 'answered',
        title: 'Ship the prototype behind the knob, or wait?',
      },
      {
        answers: [],
        askIndex: 1,
        blocking: false,
        defaultAction: 'I leave the knob on.',
        id: 'jl-e9f4.2',
        kind: 'approve',
        reportCount: 1,
        restated: '[Approve Y/n] Leave the knob on?',
        state: 'skipped',
        title: 'Leave the knob on?',
      },
      {
        answers: [],
        askIndex: 2,
        blocking: false,
        defaultAction: 'I accept it and document the behaviour.',
        id: 'jl-e9f4.3',
        kind: 'approve',
        reportCount: 1,
        restated: '[Approve Y/n] Accept the subagent behaviour?',
        state: 'unanswered',
        title: 'Accept the subagent behaviour?',
      },
    ],
    note: 'the board should default to by-repo',
    threadId: 'jl-e9f4',
    threadTitle: 'Thread reports',
  };

  test('prints the question AND the answer verbatim, in that order', () => {
    const text = renderInbox(view);
    const question = text.indexOf('Ship the prototype behind the knob');
    const answer = text.indexOf('HIS ANSWER: b');
    expect(question).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(question);
  });

  test('a SKIPPED ask states the default it licenses', () => {
    expect(renderInbox(view)).toContain(
      'SKIPPED — use your default: I leave the knob on.',
    );
  });

  test('the free-text note is printed verbatim', () => {
    expect(renderInbox(view)).toContain('the board should default to by-repo');
  });

  test('an untouched ask is listed as still waiting, not as answered', () => {
    const text = renderInbox(view);
    const waiting = text.slice(text.indexOf('STILL WAITING ON HIM'));
    expect(waiting).toContain('jl-e9f4.3');
    expect(waiting).not.toContain('jl-e9f4.1');
  });

  test('an empty inbox says CHECKED, never just blank', () => {
    const text = renderInbox({
      asks: [],
      note: null,
      threadId: 'jl-x',
      threadTitle: 't',
    });
    expect(text).toContain('he has not answered or skipped anything');
    expect(text).toContain('(none — checked, and he left none)');
  });
});
