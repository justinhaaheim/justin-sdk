#!/usr/bin/env bun
/**
 * End-to-end proof that `thread answer`'s web UI behaves in a REAL browser
 * (home-base-p1uj.12 — invariants I1, I2, I3, I4, I6).
 *
 * WHY THIS IS NOT IN `bun test`, and follows `e2e-justin-loop.ts` instead: it
 * needs Google Chrome on disk, two localhost ports, and the Claude Code Bash
 * sandbox off (measured 2026-09-12: `Bun.serve` cannot bind a socket inside it).
 * The suite must stay hermetic, so the browser half lives here and is run by
 * hand — `bun run e2e:thread-answer-web`.
 *
 * WHAT IT PROVES THAT THE SUITE CANNOT. `tests/thread-answer-web.test.ts` proves
 * the KEY MAP says Tab is not a submit and Enter is a newline. Only a browser
 * can prove that a `<textarea>` then does the thing the key map is delegating
 * to. This drives Chrome over the DevTools Protocol and types the keys.
 *
 * WHAT IT STILL DOES NOT PROVE: Justin typing five paragraphs and hitting the
 * wrong key. A human walk is owed and this is not it.
 */

import {mkdtempSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {createAnswerServer} from '../src/thread/answer-web';
import {draftPath, NOTE_DRAFT_ID} from '../src/thread/drafts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const FIVE_PARAGRAPHS = Array.from(
  {length: 5},
  (_v, index) => `Paragraph ${index + 1}. ${`word${index} `.repeat(20)}`,
).join('\n\n');

const results: {detail: string; name: string; ok: boolean}[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({detail, name, ok});
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

/** One CDP session over the page target's websocket. */
async function connect(debugPort: number): Promise<{
  close: () => void;
  send: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
}> {
  let targets: {type: string; webSocketDebuggerUrl: string}[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      targets = (await (
        await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      ).json()) as typeof targets;
      if (targets.some((target) => target.type === 'page')) break;
    } catch {
      // Chrome is still coming up. Retried below.
    }
    await Bun.sleep(250);
  }
  const page = targets.find((target) => target.type === 'page');
  if (page == null) throw new Error('no page target — is Chrome running?');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('CDP socket failed'));
  });

  let nextId = 1;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
    };
    if (message.id != null) pending.get(message.id)?.(message.result ?? {});
  };

  return {
    close: () => socket.close(),
    send: (method, params = {}) => {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({id, method, params}));
      });
    },
  };
}

type Cdp = Awaited<ReturnType<typeof connect>>;

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = (await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  })) as {result?: {value?: unknown}};
  return result.result?.value;
}

/** A real keystroke, not a synthetic event the page could special-case. */
async function key(
  cdp: Cdp,
  spec: {code: string; key: string; modifiers?: number; text?: string},
): Promise<void> {
  const base = {
    code: spec.code,
    key: spec.key,
    modifiers: spec.modifiers ?? 0,
    windowsVirtualKeyCode:
      spec.key === 'Enter' ? 13 : spec.key === 'Tab' ? 9 : 0,
  };
  await cdp.send('Input.dispatchKeyEvent', {
    ...base,
    text: spec.text,
    type: spec.text == null ? 'rawKeyDown' : 'keyDown',
  });
  await cdp.send('Input.dispatchKeyEvent', {...base, type: 'keyUp'});
}

async function main(): Promise<number> {
  const stateDir = mkdtempSync(join(tmpdir(), 'e2e-answer-'));
  const wrote: string[] = [];
  const server = createAnswerServer({
    asks: [
      {
        askIndex: 0,
        priority: 0,
        defaultAction: 'I take option a.',
        description: '[Pick a/b] Which hook shape?',
        id: 'th-e2e.1',
        kind: 'pick',
        optionCount: 2,
        reportCount: 1,
        title: 'Which hook shape?',
      },
      {
        askIndex: 1,
        priority: 3,
        defaultAction: 'I leave the script in place.',
        description: '[Approve Y/n] Retire the logger?',
        id: 'th-e2e.2',
        kind: 'approve',
        optionCount: 0,
        reportCount: 1,
        title: 'Retire the logger?',
      },
    ],
    report: 'THE RENDERED REPORT',
    stateDir,
    threadId: 'th-e2e',
    threadTitle: 'e2e: the answer UI in a real browser',
    writer: {
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
    },
  });

  const debugPort = 9222 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'e2e-chrome-'));
  const chrome = Bun.spawn(
    [
      CHROME,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      server.url,
    ],
    {stderr: 'ignore', stdout: 'ignore'},
  );

  let failed = 0;
  try {
    const cdp = await connect(debugPort);
    await cdp.send('Runtime.enable');
    await Bun.sleep(700);

    // --- the page came up and wired itself -------------------------------
    check(
      'the page wired itself (focusAsk(0) ran)',
      (await evaluate(
        cdp,
        `document.querySelectorAll('.card.focus').length === 1`,
      )) === true,
    );
    check(
      'both overlays start hidden',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('review')).display === 'none' && getComputedStyle(document.getElementById('menu')).display === 'none'`,
      )) === true,
    );

    // --- I3: Enter inserts a newline, in a real textarea ------------------
    await evaluate(
      cdp,
      `document.querySelector('textarea[data-id="th-e2e.1"]').focus()`,
    );
    await cdp.send('Input.insertText', {text: 'line one'});
    await key(cdp, {code: 'Enter', key: 'Enter', text: '\r'});
    await cdp.send('Input.insertText', {text: 'line two'});
    const afterEnter = (await evaluate(
      cdp,
      `document.querySelector('textarea[data-id="th-e2e.1"]').value`,
    )) as string;
    check(
      'I3 · Enter inserted a newline rather than submitting',
      afterEnter === 'line one\nline two',
      JSON.stringify(afterEnter),
    );
    check(
      'I3 · the review panel did NOT open on Enter',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('review')).display === 'none'`,
      )) === true,
    );

    // --- I1: a paste-sized answer autosaves to disk -----------------------
    await evaluate(
      cdp,
      `const t = document.querySelector('textarea[data-id="th-e2e.1"]'); t.value = ${JSON.stringify(FIVE_PARAGRAPHS)}; t.dispatchEvent(new Event('input'));`,
    );
    await Bun.sleep(600);
    const onDisk = readFileSync(
      draftPath(stateDir, 'th-e2e', 'th-e2e.1'),
      'utf8',
    );
    check(
      'I1 · five paragraphs reached disk without a save keystroke',
      onDisk === FIVE_PARAGRAPHS,
      `${onDisk.length} bytes on disk`,
    );

    // --- I3/I2: Tab moves focus and loses nothing -------------------------
    await key(cdp, {code: 'Tab', key: 'Tab'});
    await Bun.sleep(200);
    const afterTab = (await evaluate(
      cdp,
      `document.querySelector('textarea[data-id="th-e2e.1"]').value.length`,
    )) as number;
    check(
      'I3 · Tab left every character where it was',
      afterTab === FIVE_PARAGRAPHS.length,
      `${afterTab} chars`,
    );
    check(
      'I3 · Tab did not open the review panel',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('review')).display === 'none'`,
      )) === true,
    );
    const focusAfterTab = await evaluate(
      cdp,
      `document.activeElement ? (document.activeElement.tagName + '/' + (document.activeElement.getAttribute('data-id') || document.activeElement.className)) : 'NONE'`,
    );
    check(
      'I3 · Tab moved focus off the textarea',
      focusAfterTab !== 'TEXTAREA/th-e2e.1',
      String(focusAfterTab),
    );

    // --- I4: Esc opens the menu and does not quit -------------------------
    await key(cdp, {code: 'Escape', key: 'Escape'});
    await Bun.sleep(200);
    check(
      'I4 · Esc opened the menu',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('menu')).display !== 'none'`,
      )) === true,
    );
    check(
      'I4 · the menu offers quit-keeping-drafts',
      (await evaluate(
        cdp,
        `document.getElementById('menu-quit').textContent.includes('keeping every draft')`,
      )) === true,
    );
    await key(cdp, {code: 'Escape', key: 'Escape'});
    await Bun.sleep(200);
    check(
      'I4 · Esc closed the menu again, and the answer is untouched',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('menu')).display === 'none' && document.querySelector('textarea[data-id="th-e2e.1"]').value.length === ${FIVE_PARAGRAPHS.length}`,
      )) === true,
    );

    // --- I6: one keystroke takes the stated default -----------------------
    await evaluate(
      cdp,
      `document.querySelector('textarea[data-id="th-e2e.2"]').focus()`,
    );
    // Ctrl (modifier bit 2) + K.
    await key(cdp, {code: 'KeyK', key: 'k', modifiers: 2});
    await Bun.sleep(200);
    check(
      'I6 · Ctrl-K skipped ask two and says which default it takes',
      (await evaluate(
        cdp,
        `const c = document.querySelector('.card[data-id="th-e2e.2"]'); c.classList.contains('skipped') && c.querySelector('.skipbtn').textContent.includes('use the default: I leave the script in place.')`,
      )) === true,
    );

    // --- I3: Ctrl-S opens the review, and still writes nothing ------------
    await key(cdp, {code: 'KeyS', key: 's', modifiers: 2});
    await Bun.sleep(250);
    check(
      'I3 · Ctrl-S opened the review panel',
      (await evaluate(
        cdp,
        `getComputedStyle(document.getElementById('review')).display !== 'none'`,
      )) === true,
    );
    check(
      'I3 · nothing has been written to bd yet',
      wrote.length === 0,
      JSON.stringify(wrote),
    );

    // --- the record button is the only write ------------------------------
    await evaluate(cdp, `document.getElementById('review-record').click()`);
    await Bun.sleep(700);
    check(
      'Record wrote both asks, ask two as a skip',
      // `.trim()` on purpose: the classic walk trims too (decisionFor), and I8
      // says the two must record identically. FIVE_PARAGRAPHS ends in a space.
      wrote.join(',') ===
        'th-e2e.1:' + FIVE_PARAGRAPHS.trim() + ',th-e2e.2:skip',
      JSON.stringify(wrote.map((entry) => entry.slice(0, 30))),
    );
    check(
      'the note field exists and shares the draft path shape (I7)',
      (await evaluate(
        cdp,
        `!!document.querySelector('textarea[data-id="${NOTE_DRAFT_ID}"]')`,
      )) === true,
    );

    cdp.close();
  } finally {
    chrome.kill();
    server.stop();
  }

  failed = results.filter((result) => !result.ok).length;
  console.log('');
  console.log(
    `${results.length - failed}/${results.length} checks passed. Drafts were under ${stateDir}.`,
  );
  console.log(
    'A HUMAN WALK IS STILL OWED: nothing here is Justin typing five paragraphs and hitting the wrong key.',
  );
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
