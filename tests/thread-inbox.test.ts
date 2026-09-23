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

import type {BdComment} from '../src/thread/bd';

import {describe, expect, test} from 'bun:test';

import {SKIP_COMMENT} from '../src/thread/answer';
import {
  askStateOf,
  type InboxAsk,
  type InboxView,
  noteFrom,
  renderInbox,
  renderInboxAsk,
  stripAnswerPrefix,
} from '../src/thread/inbox';
import {restateAsk} from '../src/thread/render';

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
      defaultAction: 'I keep by-repo as the default.',
      id: 'jl-kigm.1',
      kind: 'pick',
      priority: 3,
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
    // K11 (k0b8n.10): the ask's own lines sit at the detail column.
    expect(lines[lines.length - 1]).toBe('         >>> HIS ANSWER: a');
    // The raw comment prefix never leaks through.
    expect(lines.join('\n')).not.toContain('ANSWER: ANSWER:');
  });

  test('SKIPPED: ">>> SKIPPED — use your default: <default>", never an answer', () => {
    const lines = renderInboxAsk(base({state: 'skipped'}), '  head');
    expect(lines[lines.length - 1]).toBe(
      '         >>> SKIPPED — use your default: I keep by-repo as the default.',
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
    // With no note supplied (inbox's case) the ask still renders, bare — two
    // lines shorter: the note and the blank line that sets it apart (K11).
    expect(renderInboxAsk(base(), '  head')).toHaveLength(lines.length - 2);
  });

  test('K11: a blank line between every paragraph and every option, and no trailing whitespace', () => {
    const lines = renderInboxAsk(base(), '      head');
    const at = (text: string): number =>
      lines.findIndex((line) => line.includes(text));
    const optionA = at('a. (Recommended) Ship it now');
    const optionB = at('b. Wait for the hook');
    expect(lines[optionA]).toBe(
      '         a. (Recommended) Ship it now — dogfooding starts today',
    );
    // OPTIONS:, blank, a., blank, b. — never two options stacked.
    expect(lines[optionA - 1]).toBe('');
    expect(lines[optionA - 2]).toBe('         OPTIONS:');
    expect(lines[optionB - 1]).toBe('');
    expect(optionB).toBe(optionA + 2);
    for (const line of lines) expect(line).not.toMatch(/\s$/u);
  });

  test('K11 rule 7: an ask bead that STORED the double letter reads back with one', () => {
    // Every ask bead written before k0b8n.10 carries `a. (Recommended) a. …`,
    // and inbox and prepare are where those are read back.
    const legacy = base({
      restated: restateAsk(
        ASK_DESCRIPTION.replace(
          'a. (Recommended) Ship',
          'a. (Recommended) a. Ship',
        ).replace('b. Wait', 'b. b. Wait'),
      ),
    });
    const text = renderInboxAsk(legacy, 'head').join('\n');
    expect(text).toContain('a. (Recommended) Ship it now');
    expect(text).toContain('b. Wait for the hook');
    expect(text).not.toContain('a. (Recommended) a.');
    expect(text).not.toContain('b. b.');
  });

  test('K11 colour: labels bold, the recommended option green, the answer bold green', () => {
    const style = {color: true, width: null};
    const text = renderInboxAsk(
      base({answers: ['a'], state: 'answered'}),
      'head',
      null,
      style,
    ).join('\n');
    expect(text).toContain('\u001b[1mCONTEXT:\u001b[0m');
    expect(text).toContain(
      '\u001b[32m(Recommended) Ship it now — dogfooding starts today\u001b[0m',
    );
    expect(text).toContain('\u001b[1;32m>>> HIS ANSWER:\u001b[0m a');
    expect(
      renderInboxAsk(base({answers: ['a'], state: 'answered'}), 'head').join(
        '\n',
      ),
    ).not.toContain('\u001b');
  });
});

// F2 end-to-end through the two functions `inbox` AND `prepare` both call —
// `collectInboxAsks` classifies with askStateOf, `renderInboxAsk` renders. There
// is exactly one implementation of each, so this covers both commands.
describe('an answer written after a skip reaches BOTH inbox and prepare', () => {
  test('skippedAt + a later real comment renders HIS ANSWER, not SKIPPED', () => {
    const metadata = {
      defaultAction: 'I keep by-repo.',
      kind: 'pick',
      priority: 0,
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
        defaultAction: 'I keep by-repo.',
        id: 'jl-x.1',
        kind: 'pick',
        priority: 0,
        reportCount: 1,
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
        defaultAction: 'I ship it behind the knob.',
        id: 'jl-e9f4.1',
        kind: 'pick',
        priority: 0,
        reportCount: 1,
        restated: restateAsk(ASK_DESCRIPTION),
        state: 'answered',
        title: 'Ship the prototype behind the knob, or wait?',
      },
      {
        answers: [],
        askIndex: 1,
        defaultAction: 'I leave the knob on.',
        id: 'jl-e9f4.2',
        kind: 'approve',
        priority: 3,
        reportCount: 1,
        restated: '[Approve Y/n] Leave the knob on?',
        state: 'skipped',
        title: 'Leave the knob on?',
      },
      {
        answers: [],
        askIndex: 2,
        defaultAction: 'I accept it and document the behaviour.',
        id: 'jl-e9f4.3',
        kind: 'approve',
        priority: 3,
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
