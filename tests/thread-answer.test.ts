/**
 * `thread answer` — the walk (home-base-p1uj D3, dispatch home-base-p1uj.2).
 *
 * The TTY half of this command is a dozen lines of readline adapter and cannot
 * be exercised from a subagent; the BEHAVIOUR is `walkAsks`, which takes both
 * its terminal and its bd writer as interfaces. That split is the reason this
 * file can exist at all, and the reason the live pty run recorded on the bead
 * is the other half of the evidence rather than the whole of it.
 *
 * THE ORDER IS THE POINT (home-base-p1uj.9). An answer must be IN bd before the
 * next ask is printed, and the end-to-end tests at the bottom of this file
 * assert exactly that, against a real bd subprocess, by sampling bd's own
 * command log at the moment each prompt is shown.
 *
 * THE DISTINCTION THAT MATTERS: an empty line is a SKIP, which D3 defines as
 * "take your stated default" — an explicit decision. It is NOT an empty answer,
 * and it is NOT silence. `inbox` renders the three differently and the next
 * report dispositions them differently.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';

import {
  askViewOf,
  decisionFor,
  orderAsks,
  promptFor,
  retryCommandFor,
  runThreadAnswer,
  shellSingleQuote,
  walkAsks,
  type AnswerIo,
  type AnswerWriter,
  type AskView,
} from '../src/thread/answer';
import {createFakeBd, type FakeBd, type FakeState} from './fake-bd';

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

/** A writer that always succeeds and remembers what it was handed. */
function recordingWriter(): AnswerWriter & {wrote: string[]} {
  const wrote: string[] = [];
  return {
    async ask(ask, decision) {
      wrote.push(
        `${ask.id}:${decision.kind === 'skipped' ? 'skip' : decision.text}`,
      );
      return {ok: true};
    },
    async note(text) {
      wrote.push(`note:${text}`);
      return {ok: true};
    },
    wrote,
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
    const result = await walkAsks(asks, io, recordingWriter());

    expect(result.decisions.map((entry) => entry.decision)).toEqual([
      {kind: 'answered', text: 'b'},
      {kind: 'skipped'},
    ]);
    expect(result.note).toBe('also check the hook');
    // The skipped ask's DEFAULT is echoed, so Justin sees what he just licensed.
    expect(io.shown.join('\n')).toContain(
      'skipped; Claude will: I leave the knob on.',
    );
    // And each write says so, by id — the line that replaces the old silence.
    expect(io.shown).toContain('   ✓ recorded jl-a1.1');
    expect(io.shown).toContain('   ✓ recorded jl-a1.2');
  });

  test('the ask is SHOWN before it is asked', async () => {
    const io = scriptedIo(['a']);
    await walkAsks(
      [view({description: 'THE FULL RENDERED ASK'})],
      io,
      recordingWriter(),
    );
    expect(io.shown.join('\n')).toContain('THE FULL RENDERED ASK');
  });

  test('an empty note becomes null, not an empty string', async () => {
    const result = await walkAsks(
      [view()],
      scriptedIo(['a'], '   '),
      recordingWriter(),
    );
    expect(result.note).toBeNull();
  });

  test('every ask is walked, in blocking-first order', async () => {
    const asks = [
      view({blocking: false, id: 'jl-a1.2'}),
      view({blocking: true, id: 'jl-a1.1'}),
    ];
    const result = await walkAsks(
      asks,
      scriptedIo(['a', 'b']),
      recordingWriter(),
    );
    expect(result.decisions.map((entry) => entry.ask.id)).toEqual([
      'jl-a1.1',
      'jl-a1.2',
    ]);
  });

  test('a failed write is reported on the spot and the walk carries on', async () => {
    const io = scriptedIo(['a', 'b']);
    const writer: AnswerWriter = {
      async ask(ask) {
        if (ask.id === 'jl-a1.1')
          return {detail: 'comment — bd said no', ok: false, retry: 'fix me'};
        return {ok: true};
      },
      async note() {
        return {ok: true};
      },
    };
    const result = await walkAsks(
      [
        view({blocking: true, id: 'jl-a1.1'}),
        view({blocking: true, id: 'jl-a1.2'}),
      ],
      io,
      writer,
    );
    // BOTH asks were walked — the failure did not end the walk.
    expect(result.decisions.map((entry) => entry.ask.id)).toEqual([
      'jl-a1.1',
      'jl-a1.2',
    ]);
    expect(result.decisions.map((entry) => entry.recorded)).toEqual([
      false,
      true,
    ]);
    expect(result.failures).toEqual([
      {detail: 'comment — bd said no', label: 'jl-a1.1', retry: 'fix me'},
    ]);
    expect(io.shown.join('\n')).toContain('NOT recorded on jl-a1.1');
  });

  test('no note means no note write, and no "recording…" that explains nothing', async () => {
    const io = scriptedIo(['a'], '');
    const writer = recordingWriter();
    await walkAsks([view()], io, writer);
    expect(writer.wrote).toEqual(['jl-a1.1:a']);
    expect(io.shown.join('\n')).not.toContain('recording…');
  });

  test('the note write is announced BEFORE it is made (home-base-p1uj.9)', async () => {
    // The keystroke this is about: Enter on the empty line after the note. The
    // old walk did every bd write here, silently, for ~10s.
    const shownWhenWriting: string[] = [];
    const io = scriptedIo(['a'], 'also check the hook');
    const writer: AnswerWriter = {
      async ask() {
        return {ok: true};
      },
      async note() {
        shownWhenWriting.push(...io.shown);
        return {ok: true};
      },
    };
    await walkAsks([view()], io, writer);
    expect(shownWhenWriting).toContain('recording…');
  });
});

// ---------------------------------------------------------------------------
// End to end, against a real bd subprocess (tests/fake-bd.ts).
//
// The unit tests above prove the walk CALLS its writer between prompts. These
// prove the whole command does, through the real adapter: what is observed is
// the fake bd's own command log, sampled at the moment each prompt is shown.
// ---------------------------------------------------------------------------

const SESSION = 'sess-answer';

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureConsole(): {errors: string[]; logs: string[]} {
  const errors: string[] = [];
  const logs: string[] = [];
  spies.push(
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    }),
  );
  spies.push(
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    }),
  );
  return {errors, logs};
}

/** A thread with two open asks, already in bd. */
function seededFake(failCommentAddFor: string | null = null): FakeBd {
  const fake = createFakeBd(0, failCommentAddFor);
  const state: FakeState = fake.read();
  state.issues = [
    {
      id: 'jl-t1',
      metadata: {reportedAt: '2026-09-12T10:00:00.000Z', sessionId: SESSION},
      notes: 'THE RENDERED REPORT',
      parent: null,
      status: 'in_progress',
      title: 'A session',
      type: 'thread',
    },
    {
      description: '[Pick a/b] Ask one?',
      id: 'jl-t1.1',
      metadata: {
        askIndex: 0,
        blocking: true,
        defaultAction: 'I take a.',
        kind: 'pick',
        optionCount: 2,
        reportCount: 1,
      },
      parent: 'jl-t1',
      status: 'open',
      title: 'Ask one?',
      type: 'ask',
    },
    {
      description: '[Approve Y/n] Ask two?',
      id: 'jl-t1.2',
      metadata: {
        askIndex: 1,
        blocking: false,
        defaultAction: 'I leave it.',
        kind: 'approve',
        optionCount: 0,
        reportCount: 1,
      },
      parent: 'jl-t1',
      status: 'open',
      title: 'Ask two?',
      type: 'ask',
    },
  ];
  fake.write(state);
  return fake;
}

function envFor(fake: FakeBd): Record<string, string | undefined> {
  return {...fake.env, JUSTIN_THREADS_LIFE_DIR: fake.dir};
}

/** Every `comments add` the SDK has issued so far, from bd's own log. */
function commentsAdded(fake: FakeBd): string[] {
  return fake.read().log.filter((line) => line.startsWith('comments add'));
}

describe('runThreadAnswer against bd', () => {
  test('each answer is in bd BEFORE the next ask is prompted (home-base-p1uj.9)', async () => {
    const fake = seededFake();
    captureConsole();
    const atPrompt: string[][] = [];
    const io: AnswerIo = {
      async block() {
        atPrompt.push(commentsAdded(fake));
        return '';
      },
      async line() {
        atPrompt.push(commentsAdded(fake));
        return 'b';
      },
      print() {},
    };

    const code = await runThreadAnswer({
      env: envFor(fake),
      io,
      threadId: 'jl-t1',
    });

    expect(code).toBe(0);
    // Prompt 1: nothing written yet — there is nothing to write.
    expect(atPrompt[0]).toEqual([]);
    // Prompt 2: ask one's answer IS ALREADY IN bd. This is the whole fix; when
    // the walk batched its writes, this array was empty and stayed empty until
    // after the note prompt.
    expect(atPrompt[1]).toHaveLength(1);
    expect(atPrompt[1]![0]).toContain('jl-t1.1');
    // The note prompt: both answers are in, so the only write left is the note.
    expect(atPrompt[2]).toHaveLength(2);
    expect(atPrompt[2]![1]).toContain('jl-t1.2');
  });

  test('the last line is what Justin says, not a command he cannot run', async () => {
    const fake = seededFake();
    const {logs} = captureConsole();
    const code = await runThreadAnswer({
      env: envFor(fake),
      io: scriptedIo(['b', 'y'], ''),
      threadId: 'jl-t1',
    });
    expect(code).toBe(0);
    // `thread inbox` needs a session id his shell does not have, and it is
    // Claude's own next step — so the walk ends by telling him what to SAY.
    expect(logs.at(-1)).toBe('Tell Claude: answers in');
    expect(logs.join('\n')).not.toContain('justin-sdk thread inbox');
  });

  test('a failed write names the ask, keeps walking, and prints the retry command', async () => {
    const fake = seededFake('jl-t1.1');
    const {errors, logs} = captureConsole();
    const io = scriptedIo(['b', 'y'], '');

    const code = await runThreadAnswer({
      env: envFor(fake),
      io,
      threadId: 'jl-t1',
    });

    expect(code).toBe(1);
    // The walk CONTINUED: the second ask was asked, and its answer landed.
    expect((fake.read().comments ?? []).map((comment) => comment.id)).toEqual([
      'jl-t1.2',
    ]);
    expect(io.shown.join('\n')).toContain('NOT recorded on jl-t1.1');
    // The counts describe what REACHED bd — the lost answer is not counted.
    expect(logs.join('\n')).toContain('1 answered · 0 skipped');
    expect(errors.join('\n')).toContain('jl-t1.1');
    expect(errors.join('\n')).toContain(
      "cd ~/Dev/life && bun run bd comments add jl-t1.1 'ANSWER: b'",
    );
  });
});

describe('the retry command', () => {
  test('an apostrophe in an answer cannot break out of the quoting', () => {
    expect(shellSingleQuote("don't ship")).toBe(`'don'\\''t ship'`);
    expect(retryCommandFor('jl-t1.1', 'ANSWER: `whoami`')).toBe(
      "cd ~/Dev/life && bun run bd comments add jl-t1.1 'ANSWER: `whoami`'",
    );
  });
});
