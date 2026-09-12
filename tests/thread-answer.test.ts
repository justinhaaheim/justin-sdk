/**
 * `thread answer` — the walk (home-base-p1uj D3, dispatch home-base-p1uj.2).
 *
 * The TTY half of this command is a dozen lines of readline adapter and cannot
 * be exercised from a subagent; the BEHAVIOUR is `walkAsks`, which takes its
 * terminal as an interface. That split is the reason this file can exist at
 * all, and the reason the live cmux run recorded on the bead is the other half
 * of the evidence rather than the whole of it.
 *
 * THE DISTINCTION THAT MATTERS: an empty line is a SKIP, which D3 defines as
 * "take your stated default" — an explicit decision. It is NOT an empty answer,
 * and it is NOT silence. `inbox` renders the three differently and the next
 * report dispositions them differently.
 */

import {describe, expect, test} from 'bun:test';

import {
  askViewOf,
  decisionFor,
  orderAsks,
  promptFor,
  walkAsks,
  type AnswerIo,
  type AskView,
} from '../src/thread/answer';

import type {BdIssue} from '../src/thread/bd';

function view(overrides: Partial<AskView> = {}): AskView {
  return {
    askIndex: 0,
    blocking: false,
    defaultAction: 'I take the recommended option.',
    description: '[Pick a/b] Ship it?',
    id: 'jl-a1.1',
    kind: 'pick',
    optionCount: 2,
    reportCount: 1,
    title: 'Ship it?',
    ...overrides,
  };
}

/** A terminal that answers from a script and records what it was shown. */
function scriptedIo(lines: string[], block = ''): AnswerIo & {shown: string[]} {
  const queue = [...lines];
  const shown: string[] = [];
  return {
    async block() {
      return block;
    },
    async line() {
      return queue.shift() ?? '';
    },
    print(text: string) {
      shown.push(text);
    },
    shown,
  };
}

describe('reading an ask bead', () => {
  test('askViewOf reads kind, blocking, optionCount and the default', () => {
    const issue: BdIssue = {
      description: 'the rendered ask',
      id: 'jl-a1.1',
      metadata: {
        askIndex: 2,
        blocking: true,
        defaultAction: 'I ship it.',
        kind: 'pick',
        optionCount: 3,
        reportCount: 4,
      },
      title: 'Ship it?',
    };
    expect(askViewOf(issue)).toEqual({
      askIndex: 2,
      blocking: true,
      defaultAction: 'I ship it.',
      description: 'the rendered ask',
      id: 'jl-a1.1',
      kind: 'pick',
      optionCount: 3,
      reportCount: 4,
      title: 'Ship it?',
    });
  });

  test('a missing default degrades to a NAMED unknown, never to an empty string', () => {
    const read = askViewOf({id: 'jl-a1.1', metadata: {}});
    expect(read.defaultAction).toContain('UNKNOWN');
    expect(read.optionCount).toBe(0);
    // Not 0 (F12): a zero here would sort an ask with no recorded position
    // ahead of the report's first ask, inventing an order nobody chose.
    expect(read.askIndex).toBeNull();
    expect(read.reportCount).toBeNull();
  });
});

describe('prompt shapes', () => {
  test('a pick offers exactly its letters', () => {
    expect(promptFor(view({optionCount: 3}))).toBe(
      '[a/b/c, or Enter to skip] ',
    );
  });

  test('an approve offers y/n', () => {
    expect(promptFor(view({kind: 'approve', optionCount: 0}))).toContain(
      '[y/n',
    );
  });

  test('an act or answer offers free text', () => {
    expect(promptFor(view({kind: 'act', optionCount: 0}))).toContain(
      'type your answer',
    );
  });
});

describe('decisionFor', () => {
  test('an empty line is a SKIP, not an empty answer', () => {
    expect(decisionFor(view(), '')).toEqual({kind: 'skipped'});
    expect(decisionFor(view(), '   ')).toEqual({kind: 'skipped'});
  });

  test('a letter within range is recorded lower-cased', () => {
    expect(decisionFor(view(), 'B')).toEqual({kind: 'answered', text: 'b'});
  });

  test('a letter OUT of range is kept verbatim rather than silently coerced', () => {
    // "z" is not one of two options. Recording it as a valid pick would put a
    // choice in the ledger that Justin never had; recording it verbatim lets
    // the next turn see what he actually typed.
    expect(decisionFor(view(), 'z')).toEqual({kind: 'answered', text: 'z'});
  });

  test('approve normalises y/yes and n/no', () => {
    const approve = view({kind: 'approve', optionCount: 0});
    expect(decisionFor(approve, 'y').kind).toBe('answered');
    expect(decisionFor(approve, 'Y')).toEqual({kind: 'answered', text: 'yes'});
    expect(decisionFor(approve, 'no')).toEqual({kind: 'answered', text: 'no'});
  });

  test('free text survives verbatim', () => {
    expect(
      decisionFor(view({kind: 'answer', optionCount: 0}), 'do b, then a'),
    ).toEqual({kind: 'answered', text: 'do b, then a'});
  });
});

describe('orderAsks', () => {
  test('blocking asks come first, then payload order within one report', () => {
    const asks = [
      view({askIndex: 1, blocking: false, id: 'jl-a1.3'}),
      view({askIndex: 2, blocking: true, id: 'jl-a1.2'}),
      view({askIndex: 0, blocking: false, id: 'jl-a1.1'}),
    ];
    expect(orderAsks(asks).map((ask) => ask.id)).toEqual([
      'jl-a1.2',
      'jl-a1.1',
      'jl-a1.3',
    ]);
  });

  test('ask 10 does not jump ahead of ask 2 (F12)', () => {
    // The old comparator was `id.localeCompare`, under which "jl-a1.10" sorts
    // before "jl-a1.2" — so the walk asked them in an order the report never
    // printed, and "2. b" landed on the wrong ask.
    const asks = [
      view({askIndex: 9, blocking: true, id: 'jl-a1.10'}),
      view({askIndex: 1, blocking: true, id: 'jl-a1.2'}),
    ];
    expect(orderAsks(asks).map((ask) => ask.id)).toEqual([
      'jl-a1.2',
      'jl-a1.10',
    ]);
  });

  test('a CARRIED ask leads its group, exactly as the report prints it', () => {
    const asks = [
      view({askIndex: 0, blocking: true, id: 'jl-a1.9', reportCount: 3}),
      view({askIndex: 0, blocking: true, id: 'jl-a1.1', reportCount: 1}),
      view({askIndex: 0, blocking: false, id: 'jl-a1.8', reportCount: 2}),
    ];
    expect(orderAsks(asks).map((ask) => ask.id)).toEqual([
      'jl-a1.1',
      'jl-a1.9',
      'jl-a1.8',
    ]);
  });

  test('an ask with no recorded report sorts as the OLDEST, not the newest', () => {
    // It cannot have come from the report being rendered — that one stamps
    // every ask it creates — so it is carried by definition.
    const asks = [
      view({askIndex: 0, blocking: true, id: 'jl-a1.4', reportCount: 1}),
      view({askIndex: null, blocking: true, id: 'jl-a1.3', reportCount: null}),
    ];
    expect(orderAsks(asks).map((ask) => ask.id)).toEqual([
      'jl-a1.3',
      'jl-a1.4',
    ]);
  });
});

describe('walkAsks', () => {
  test('one pick, one skip and a free-text note — the whole gate in one walk', async () => {
    const asks = [
      view({blocking: true, id: 'jl-a1.1', kind: 'pick', optionCount: 2}),
      view({
        blocking: false,
        defaultAction: 'I leave the knob on.',
        id: 'jl-a1.2',
        kind: 'approve',
        optionCount: 0,
      }),
    ];
    const io = scriptedIo(['b', ''], 'also check the hook');
    const result = await walkAsks(asks, io);

    expect(result.decisions.map((entry) => entry.decision)).toEqual([
      {kind: 'answered', text: 'b'},
      {kind: 'skipped'},
    ]);
    expect(result.note).toBe('also check the hook');
    // The skipped ask's DEFAULT is echoed, so Justin sees what he just licensed.
    expect(io.shown.join('\n')).toContain(
      'skipped; Claude will: I leave the knob on.',
    );
  });

  test('the ask is SHOWN before it is asked', async () => {
    const io = scriptedIo(['a']);
    await walkAsks([view({description: 'THE FULL RENDERED ASK'})], io);
    expect(io.shown.join('\n')).toContain('THE FULL RENDERED ASK');
  });

  test('an empty note becomes null, not an empty string', async () => {
    const result = await walkAsks([view()], scriptedIo(['a'], '   '));
    expect(result.note).toBeNull();
  });

  test('every ask is walked, in blocking-first order', async () => {
    const asks = [
      view({blocking: false, id: 'jl-a1.2'}),
      view({blocking: true, id: 'jl-a1.1'}),
    ];
    const result = await walkAsks(asks, scriptedIo(['a', 'b']));
    expect(result.decisions.map((entry) => entry.ask.id)).toEqual([
      'jl-a1.1',
      'jl-a1.2',
    ]);
  });
});
