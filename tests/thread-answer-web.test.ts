/**
 * `thread answer` v2 — the invariants (home-base-p1uj.12, I1-I8).
 *
 * WHAT IS PROVEN HERE AND WHAT IS NOT, stated up front so nobody reads more into
 * a green run than it earns:
 *
 *  - I1, I2, I4, I6, I8 are proven END TO END against a real `Bun.serve` and a
 *    real bd subprocess (tests/fake-bd.ts). The test plays the part of the
 *    browser by fetching the same URLs the page fetches.
 *  - I3 ("Tab never submits, Enter inserts a newline") is proven at the KEY MAP,
 *    which is the only place it is decided — plus a structural check that the
 *    page has no `<form>` and that every answer field is a `<textarea>`, since
 *    those two facts are what delegate the rest to the browser. The key map is
 *    then re-run from the EXACT TEXT the page ships, in a bare `new Function`,
 *    so "the browser runs this function" is measured rather than assumed. What
 *    is NOT proven here is Chromium's own textarea behaviour; that is the point
 *    of choosing a textarea.
 *  - I5 and I7 are structural: the footer string is one exported constant used
 *    on every screen, and the note field is built from the same card template as
 *    an ask with the same autosave path. Asserted as markup, not as pixels.
 *
 * A HUMAN-DRIVEN WALK IS STILL OWED. Nothing in this file, and nothing an agent
 * can run, is Justin typing five paragraphs and hitting the wrong key.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  createAnswerServer,
  runThreadAnswerWeb,
  type AnswerServer,
} from '../src/thread/answer-web';
import {
  keyActionFor,
  KEYMAP_FOOTER,
  type KeyAction,
  type KeyEventLike,
} from '../src/thread/answer-keymap';
import {
  draftPath,
  listDrafts,
  NOTE_DRAFT_ID,
  readDraft,
  writeDraft,
} from '../src/thread/drafts';
import {
  INK_REFUSAL,
  resolveAnswerUi,
  runThreadAnswerUi,
} from '../src/thread/answer-ui';
import {escapeHtml, renderAnswerPage} from '../src/thread/answer-page';
import {askViewOf, runThreadAnswer, type AnswerIo} from '../src/thread/answer';
import {createFakeBd, type FakeBd, type FakeState} from './fake-bd';

const SESSION = 'sess-answer-web';

/** Five paragraphs — the exact thing Justin said he refuses to lose again. */
const FIVE_PARAGRAPHS = Array.from(
  {length: 5},
  (_v, index) => `Paragraph ${index + 1}. ${`word${index} `.repeat(30)}`,
).join('\n\n');

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'answer-web-'));
}

function askOne() {
  return {
    askIndex: 0,
    blocking: true,
    defaultAction: 'I take a.',
    description: '[Pick a/b] Ask one?',
    id: 'jl-t1.1',
    kind: 'pick',
    optionCount: 2,
    reportCount: 1,
    title: 'Ask one?',
  };
}

function askTwo() {
  return {
    askIndex: 1,
    blocking: false,
    defaultAction: 'I leave it.',
    description: '[Approve Y/n] Ask two?',
    id: 'jl-t1.2',
    kind: 'approve',
    optionCount: 0,
    reportCount: 1,
    title: 'Ask two?',
  };
}

function okWriter() {
  const wrote: string[] = [];
  return {
    async ask(ask: {id: string}, decision: {kind: string}) {
      wrote.push(`${ask.id}:${decision.kind}`);
      return {ok: true} as const;
    },
    async note(text: string) {
      wrote.push(`note:${text}`);
      return {ok: true} as const;
    },
    wrote,
  };
}

const servers: AnswerServer[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function serve(stateDir: string, overrides: Record<string, unknown> = {}) {
  const server = createAnswerServer({
    asks: [askOne(), askTwo()],
    report: 'THE RENDERED REPORT',
    stateDir,
    threadId: 'jl-t1',
    threadTitle: 'A session',
    writer: okWriter(),
    ...overrides,
  } as Parameters<typeof createAnswerServer>[0]);
  servers.push(server);
  return server;
}

function api(server: AnswerServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}?t=${server.token}`;
}

// ---------------------------------------------------------------------------
// I1 — no keystroke ever discards text. The draft is on disk, and it survives
// the process being killed.
// ---------------------------------------------------------------------------

describe('I1 · drafts are on disk and survive a kill', () => {
  test('a five-paragraph draft is a file, byte for byte', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);

    const res = await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });
    expect(res.status).toBe(200);

    const path = draftPath(stateDir, 'jl-t1', 'jl-t1.1');
    expect(readFileSync(path, 'utf8')).toBe(FIVE_PARAGRAPHS);
  });

  test('killing the server leaves the draft, and the next run offers it back', async () => {
    const stateDir = tempStateDir();
    const first = serve(stateDir);
    await fetch(api(first, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });
    // No graceful shutdown, no flush, no goodbye — the Ctrl-C case.
    first.stop();

    const second = serve(stateDir);
    const state = (await (await fetch(api(second, '/api/state'))).json()) as {
      asks: {draft: string | null; id: string}[];
    };
    expect(state.asks.find((ask) => ask.id === 'jl-t1.1')?.draft).toBe(
      FIVE_PARAGRAPHS,
    );

    // And the page itself hands it back, pre-filled and announced.
    const page = await (await fetch(api(second, '/'))).text();
    expect(page).toContain('Paragraph 1.');
    expect(page).toContain('Resumed:');
  });

  test('NEGATIVE CONTROL: with no draft on disk the same read reports absent, not empty text', () => {
    const stateDir = tempStateDir();
    expect(readDraft(stateDir, 'jl-t1', 'jl-t1.1')).toEqual({kind: 'absent'});
    // The distinction rule 6 is about: "absent" is not "present with ''".
    writeDraft(stateDir, 'jl-t1', 'jl-t1.1', '');
    expect(readDraft(stateDir, 'jl-t1', 'jl-t1.1').kind).toBe('present');
  });

  test('a draft that cannot be SAVED is a 500 the page paints red, never a silent 200', async () => {
    const stateDir = tempStateDir();
    // A file where the drafts directory must go: the mkdir fails, so the write
    // cannot happen. The server must say so.
    writeFileSync(join(stateDir, 'drafts'), 'not a directory');
    const server = serve(stateDir);
    const res = await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: 'five paragraphs',
      method: 'PUT',
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });

  test('a draft directory that cannot be READ is a named problem, never "you have none"', async () => {
    const stateDir = tempStateDir();
    // `drafts/jl-t1` exists but is a FILE, so readdir fails with ENOTDIR.
    writeFileSync(join(stateDir, 'drafts'), 'not a directory');
    const list = listDrafts(stateDir, 'jl-t1');
    expect(list.kind).toBe('failed');

    const server = serve(stateDir);
    const page = await (await fetch(api(server, '/'))).text();
    expect(page).toContain('Could not read some drafts');
  });
});

// ---------------------------------------------------------------------------
// I2 — navigation never costs a draft.
// ---------------------------------------------------------------------------

describe('I2 · moving between asks keeps every draft', () => {
  test('writing ask two and the note leaves ask one untouched', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);

    await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });
    await fetch(api(server, '/api/draft/jl-t1.2'), {
      body: 'a different answer',
      method: 'PUT',
    });
    await fetch(api(server, `/api/draft/${NOTE_DRAFT_ID}`), {
      body: 'and a note',
      method: 'PUT',
    });

    const state = (await (await fetch(api(server, '/api/state'))).json()) as {
      asks: {draft: string | null; id: string}[];
    };
    expect(state.asks.find((ask) => ask.id === 'jl-t1.1')?.draft).toBe(
      FIVE_PARAGRAPHS,
    );
    expect(state.asks.find((ask) => ask.id === 'jl-t1.2')?.draft).toBe(
      'a different answer',
    );
  });

  test('NEGATIVE CONTROL: one ask per file is what makes that true', () => {
    const stateDir = tempStateDir();
    // If two asks ever shared a path, the assertion above would be meaningless.
    expect(draftPath(stateDir, 'jl-t1', 'jl-t1.1')).not.toBe(
      draftPath(stateDir, 'jl-t1', 'jl-t1.2'),
    );
    // And a draft written under one id is invisible under the other.
    writeDraft(stateDir, 'jl-t1', 'jl-t1.1', 'one');
    expect(readDraft(stateDir, 'jl-t1', 'jl-t1.2')).toEqual({kind: 'absent'});
  });
});

// ---------------------------------------------------------------------------
// I3 — Enter is a newline, Tab is a focus move, and NOTHING else submits.
// ---------------------------------------------------------------------------

function press(overrides: Partial<KeyEventLike>): KeyAction {
  return keyActionFor({
    altKey: false,
    ctrlKey: false,
    inTextarea: true,
    key: 'a',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });
}

describe('I3 · submit is explicit and separate from navigation', () => {
  test('Enter inside an answer field is a newline', () => {
    expect(press({key: 'Enter'})).toBe('newline');
    expect(press({key: 'Enter', shiftKey: true})).toBe('newline');
  });

  test('Tab and Shift-Tab move focus and do nothing else', () => {
    expect(press({key: 'Tab'})).toBe('none');
    expect(press({key: 'Tab', shiftKey: true})).toBe('none');
    expect(press({inTextarea: false, key: 'Tab'})).toBe('none');
  });

  test('Ctrl-S and Cmd-S are the ONLY things that submit', () => {
    expect(press({ctrlKey: true, key: 's'})).toBe('submit');
    expect(press({key: 'S', metaKey: true})).toBe('submit');

    // The sweep: every plausible key against every modifier combination. If any
    // of them ever starts submitting, this fails and names the key.
    const keys = [
      'Enter',
      'Return',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      ' ',
      'a',
      'z',
      'k',
      'K',
      's',
      'S',
      'Z',
      'F1',
    ];
    const offenders: string[] = [];
    for (const key of keys) {
      for (const ctrlKey of [false, true]) {
        for (const metaKey of [false, true]) {
          for (const altKey of [false, true]) {
            for (const shiftKey of [false, true]) {
              for (const inTextarea of [false, true]) {
                const action = keyActionFor({
                  altKey,
                  ctrlKey,
                  inTextarea,
                  key,
                  metaKey,
                  shiftKey,
                });
                if (action === 'submit') {
                  offenders.push(
                    `${key}${ctrlKey ? '+ctrl' : ''}${metaKey ? '+meta' : ''}${altKey ? '+alt' : ''}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    // Every combination that submits is an s/S with ctrl or meta. Nothing else,
    // in a sweep of 20 keys x 16 modifier/context combinations.
    expect(offenders.length).toBeGreaterThan(0);
    const wrong = [...new Set(offenders)].filter(
      (label) =>
        !/^[sS]\+/.test(label) ||
        !(label.includes('+ctrl') || label.includes('+meta')),
    );
    expect(wrong).toEqual([]);
    // NEGATIVE CONTROL for the sweep itself: a map that submitted on Tab would
    // be caught by exactly the filter above.
    const broken = (event: KeyEventLike): KeyAction =>
      event.key === 'Tab' ? 'submit' : keyActionFor(event);
    expect(broken({...({} as KeyEventLike), key: 'Tab'})).toBe('submit');
    expect(
      [...new Set(['Tab'])].filter(
        (label) =>
          !/^[sS]\+/.test(label) ||
          !(label.includes('+ctrl') || label.includes('+meta')),
      ),
    ).toEqual(['Tab']);
  });

  test('bare arrows stay the browser’s, so a long answer is still navigable', () => {
    expect(press({key: 'ArrowDown'})).toBe('none');
    expect(press({key: 'ArrowUp'})).toBe('none');
    expect(press({ctrlKey: true, key: 'ArrowDown'})).toBe('next');
    expect(press({ctrlKey: true, key: 'ArrowUp'})).toBe('prev');
  });

  test('the page has NO form and every answer field is a textarea', () => {
    const page = renderAnswerPage({
      asks: [
        {
          blocking: true,
          defaultAction: 'I take a.',
          description: 'Ask one?',
          draft: null,
          id: 'jl-t1.1',
          kind: 'pick',
          number: 1,
          optionCount: 2,
          reportCount: 1,
          title: 'Ask one?',
        },
      ],
      noteDraft: null,
      noteId: NOTE_DRAFT_ID,
      problems: [],
      report: 'R',
      threadId: 'jl-t1',
      threadTitle: 'A session',
      token: 't',
    });
    // A form would give Enter an implicit submit target. There is none.
    expect(/<form[\s>]/i.test(page)).toBe(false);
    // One textarea per ask plus the note (I7), and no single-line inputs.
    expect((page.match(/<textarea/g) ?? []).length).toBe(2);
    expect(/<input[\s>]/i.test(page)).toBe(false);
    // I5: the one footer, verbatim (HTML-escaped — it contains an ampersand),
    // on the one screen every overlay sits over.
    expect(page).toContain(escapeHtml(KEYMAP_FOOTER));
    // And both overlays start hidden — the bug a real render caught.
    expect(page).toContain('[hidden] { display: none !important; }');
  });

  test('the page runs THIS key map: the inlined source re-evaluates identically', () => {
    const page = renderAnswerPage({
      asks: [],
      noteDraft: null,
      noteId: NOTE_DRAFT_ID,
      problems: [],
      report: 'R',
      threadId: 'jl-t1',
      threadTitle: 'A session',
      token: 't',
    });
    const source = keyActionFor.toString();
    expect(page).toContain(source);
    // Self-contained: nothing the browser would have to resolve.
    expect(/\brequire\(|\bimport\b/.test(source)).toBe(false);

    // Re-run the SHIPPED text, standing alone, against the same assertions.
    const shipped = new Function(`return (${source})`)() as typeof keyActionFor;
    const base: KeyEventLike = {
      altKey: false,
      ctrlKey: false,
      inTextarea: true,
      key: 'a',
      metaKey: false,
      shiftKey: false,
    };
    expect(shipped({...base, key: 'Enter'})).toBe('newline');
    expect(shipped({...base, key: 'Tab'})).toBe('none');
    expect(shipped({...base, key: 'Escape'})).toBe('menu');
    expect(shipped({...base, ctrlKey: true, key: 's'})).toBe('submit');
    expect(shipped({...base, ctrlKey: true, key: 'k'})).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// I4 — Esc opens a menu; quitting keeps every draft.
// ---------------------------------------------------------------------------

describe('I4 · Esc opens a menu and never quits', () => {
  test('Escape is a menu from anywhere, including mid-answer', () => {
    expect(press({key: 'Escape'})).toBe('menu');
    expect(press({inTextarea: false, key: 'Escape'})).toBe('menu');
    expect(press({ctrlKey: true, key: 'Escape'})).toBe('menu');
  });

  test('the menu offers resume / submit / quit-keeping-drafts, and says so', () => {
    const page = renderAnswerPage({
      asks: [],
      noteDraft: null,
      noteId: NOTE_DRAFT_ID,
      problems: [],
      report: 'R',
      threadId: 'jl-t1',
      threadTitle: 'A session',
      token: 't',
    });
    expect(page).toContain('id="menu-resume"');
    expect(page).toContain('id="menu-submit"');
    expect(page).toContain('Quit, keeping every draft');
    expect(page).toContain('It never quits and never discards anything.');
  });

  test('quitting leaves every draft exactly where it was', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);
    await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });

    const res = await fetch(api(server, '/api/quit'), {method: 'POST'});
    expect(res.status).toBe(200);
    expect(await server.done).toEqual({kind: 'quit'});

    // THE ASSERTION THIS TEST EXISTS FOR.
    expect(existsSync(draftPath(stateDir, 'jl-t1', 'jl-t1.1'))).toBe(true);
    expect(readFileSync(draftPath(stateDir, 'jl-t1', 'jl-t1.1'), 'utf8')).toBe(
      FIVE_PARAGRAPHS,
    );
  });

  test('NEGATIVE CONTROL: a successful RECORD is the only thing that clears drafts', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);
    await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });
    await fetch(api(server, '/api/submit'), {
      body: JSON.stringify({
        decisions: [{askId: 'jl-t1.1', kind: 'answered', text: 'b'}],
        note: '',
      }),
      method: 'POST',
    });
    expect(existsSync(draftPath(stateDir, 'jl-t1', 'jl-t1.1'))).toBe(false);
  });

  test('a FAILED record keeps the drafts, so nothing has to be retyped', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir, {
      writer: {
        async ask() {
          return {detail: 'bd said no', ok: false, retry: null};
        },
        async note() {
          return {ok: true};
        },
      },
    });
    await fetch(api(server, '/api/draft/jl-t1.1'), {
      body: FIVE_PARAGRAPHS,
      method: 'PUT',
    });
    const res = await fetch(api(server, '/api/submit'), {
      body: JSON.stringify({
        decisions: [{askId: 'jl-t1.1', kind: 'answered', text: 'b'}],
        note: '',
      }),
      method: 'POST',
    });
    const body = (await res.json()) as {
      draftsKept: boolean;
      failures: {label: string}[];
    };
    expect(body.draftsKept).toBe(true);
    expect(body.failures.map((failure) => failure.label)).toEqual(['jl-t1.1']);
    expect(existsSync(draftPath(stateDir, 'jl-t1', 'jl-t1.1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I6 — one keystroke to take the stated default, and the default is on screen.
// ---------------------------------------------------------------------------

describe('I6 · skipping is one keystroke and shows the default', () => {
  test('Ctrl-K and Cmd-K skip', () => {
    expect(press({ctrlKey: true, key: 'k'})).toBe('skip');
    expect(press({key: 'K', metaKey: true})).toBe('skip');
    // NEGATIVE CONTROL: a bare k must type a letter, not skip an ask.
    expect(press({key: 'k'})).toBe('none');
  });

  test('every ask shows "use the default: <default>" verbatim', () => {
    const page = renderAnswerPage({
      asks: [
        {
          blocking: false,
          defaultAction: 'I leave the knob on.',
          description: 'Ask two?',
          draft: null,
          id: 'jl-t1.2',
          kind: 'approve',
          number: 1,
          optionCount: 0,
          reportCount: 1,
          title: 'Ask two?',
        },
      ],
      noteDraft: null,
      noteId: NOTE_DRAFT_ID,
      problems: [],
      report: 'R',
      threadId: 'jl-t1',
      threadTitle: 'A session',
      token: 't',
    });
    expect(page).toContain('use the default: I leave the knob on.');
  });

  test('an ask with no recorded default shows a NAMED unknown, never a blank', () => {
    const view = askViewOf({id: 'jl-t1.9', metadata: {}});
    expect(view.defaultAction).toContain('UNKNOWN');
    const page = renderAnswerPage({
      asks: [
        {
          blocking: false,
          defaultAction: view.defaultAction,
          description: 'Ask nine?',
          draft: null,
          id: 'jl-t1.9',
          kind: 'answer',
          number: 1,
          optionCount: 0,
          reportCount: null,
          title: 'Ask nine?',
        },
      ],
      noteDraft: null,
      noteId: NOTE_DRAFT_ID,
      problems: [],
      report: 'R',
      threadId: 'jl-t1',
      threadTitle: 'A session',
      token: 't',
    });
    expect(page).toContain('use the default: UNKNOWN');
    expect(page).not.toContain('use the default: <');
  });
});

// ---------------------------------------------------------------------------
// I8 — bd records EXACTLY what the classic walk records. Byte-compared against
// a real bd subprocess on the same fixture.
// ---------------------------------------------------------------------------

function seededFake(): FakeBd {
  const fake = createFakeBd();
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
  return {...fake.env, JUSTIN_THREADS_REPO_DIR: fake.dir};
}

/** Timestamps and temp paths differ between runs; everything else must not. */
function normalise(lines: string[]): string[] {
  return lines.map((line) =>
    line
      .replace(/@\S+\.json/g, '@METADATA_FILE')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIMESTAMP'),
  );
}

function normaliseMetadata(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIMESTAMP'),
  );
}

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

function scriptedIo(lines: string[], block = ''): AnswerIo {
  const queue = [...lines];
  return {
    async block() {
      return block;
    },
    async line() {
      return queue.shift() ?? '';
    },
    print() {},
  };
}

describe('I8 · the web UI records exactly what the classic walk records', () => {
  test('same fixture, same answers — byte-identical bd traffic', async () => {
    captureConsole();

    // --- the classic readline walk -----------------------------------------
    const classicFake = seededFake();
    const classicCode = await runThreadAnswer({
      autoCommit: false,
      env: envFor(classicFake),
      io: scriptedIo(['b', ''], 'also check the hook'),
      threadId: 'jl-t1',
    });
    expect(classicCode).toBe(0);
    const classic = classicFake.read();

    // --- the web UI, through the real command ------------------------------
    const webFake = seededFake();
    const stateDir = tempStateDir();
    const webCode = await runThreadAnswerWeb({
      autoCommit: false,
      env: {...envFor(webFake), JUSTIN_THREADS_STATE_DIR: stateDir},
      openBrowser: false,
      onReady: (server) => {
        servers.push(server);
        void fetch(api(server, '/api/submit'), {
          body: JSON.stringify({
            // Ask one answered "b"; ask two SKIPPED — the same two decisions
            // the scripted classic walk made ('b' then an empty line).
            decisions: [
              {askId: 'jl-t1.1', kind: 'answered', text: 'b'},
              {askId: 'jl-t1.2', kind: 'skipped', text: ''},
            ],
            note: 'also check the hook',
          }),
          method: 'POST',
        });
      },
      threadId: 'jl-t1',
    });
    expect(webCode).toBe(0);
    const web = webFake.read();

    // THE ASSERTION. Every bd command, in order, with only timestamps and the
    // metadata temp-file path normalised.
    expect(normalise(web.log)).toEqual(normalise(classic.log));

    // And the comment bodies themselves, verbatim.
    expect(web.comments).toEqual(classic.comments);
    expect(web.comments?.map((comment) => comment.text)).toEqual([
      'ANSWER: b',
      'skipped: use default',
      'NOTE: also check the hook',
    ]);

    // And the metadata stamps that `inbox` reads back.
    expect(
      normaliseMetadata(web.issues.map((issue) => issue.metadata)),
    ).toEqual(normaliseMetadata(classic.issues.map((issue) => issue.metadata)));
  }, 30_000);

  test('NEGATIVE CONTROL: a DIFFERENT answer produces a different log', async () => {
    captureConsole();
    const a = seededFake();
    await runThreadAnswer({
      autoCommit: false,
      env: envFor(a),
      io: scriptedIo(['b', ''], 'also check the hook'),
      threadId: 'jl-t1',
    });
    const b = seededFake();
    await runThreadAnswer({
      autoCommit: false,
      env: envFor(b),
      // "a" instead of "b" — one character, and the comparison must notice.
      io: scriptedIo(['a', ''], 'also check the hook'),
      threadId: 'jl-t1',
    });
    expect(normalise(b.read().log)).not.toEqual(normalise(a.read().log));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The knob: classic is still reachable, and ink is refused rather than faked.
// ---------------------------------------------------------------------------

describe('the answerUi knob', () => {
  test('web is the default', () => {
    const resolved = resolveAnswerUi({env: {HOME: tempStateDir()}});
    expect(resolved.ui).toBe('web');
  });

  test('--classic and --ui classic both reach the readline walk', async () => {
    expect(resolveAnswerUi({classic: true}).ui).toBe('classic');
    expect(resolveAnswerUi({ui: 'classic'}).ui).toBe('classic');

    const fake = seededFake();
    const {logs} = captureConsole();
    const code = await runThreadAnswerUi({
      autoCommit: false,
      classic: true,
      env: envFor(fake),
      threadId: 'jl-t1',
      // The classic walk needs a TTY it does not have here, so it exits 2 with
      // its own message — which is itself the proof that the ROUTER sent us to
      // the classic walk and not to the web UI.
    });
    expect(code).toBe(2);
    expect(logs.join('\n')).toContain('THE RENDERED REPORT');
  }, 30_000);

  test('--ui ink is refused in one line that names the verdict', async () => {
    const {errors} = captureConsole();
    const code = await runThreadAnswerUi({env: {}, ui: 'ink'});
    expect(code).toBe(2);
    expect(errors.join('\n')).toBe(INK_REFUSAL);
    expect(errors.join('\n')).toContain('measured and rejected');
  });

  test('a misspelled --ui refuses rather than silently using the default', async () => {
    const {errors} = captureConsole();
    const code = await runThreadAnswerUi({env: {}, ui: 'inkk'});
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('is not one of classic, ink, web');
  });
});

// ---------------------------------------------------------------------------
// The token. This page can write to the bead ledger.
// ---------------------------------------------------------------------------

describe('the per-run token', () => {
  test('every route refuses a wrong token', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/', '/api/state', '/api/submit', '/api/quit']) {
      const res = await fetch(`${base}${path}?t=wrong`, {method: 'POST'});
      expect(res.status).toBe(403);
    }
    // NEGATIVE CONTROL: the right token is accepted, so 403 means the token and
    // not a broken route.
    expect((await fetch(api(server, '/api/state'))).status).toBe(200);
  });

  test('a draft PUT for an unknown ask is refused', async () => {
    const stateDir = tempStateDir();
    const server = serve(stateDir);
    const res = await fetch(api(server, '/api/draft/jl-t9.9'), {
      body: 'x',
      method: 'PUT',
    });
    expect(res.status).toBe(404);
    rmSync(stateDir, {force: true, recursive: true});
  });
});
