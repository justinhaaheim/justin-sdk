/**
 * `thread show`'s MESSAGES block (home-base-k0b8n K4).
 *
 * Justin's ask was the TEXT ITSELF — "the first message I sent, the last message
 * I sent, and the most recent response from claude" — so this block prints
 * verbatim whether or not `--full` was passed. `--full` toggles the compaction
 * of the stored REPORT above it, which is a different thing entirely.
 *
 * The other half of the block's job is rule 7: a field that is missing must say
 * WHY it is missing, in the words of whoever failed to measure it, because
 * "(not captured: no transcript to read)" and a blank line look identical to a
 * reader and mean completely different things.
 */

import type {MessageLine} from '../src/thread/message-log';

import {describe, expect, test} from 'bun:test';

import {messageFieldName} from '../src/thread/search';
import {
  capturedCountLines,
  readSessionLog,
  renderMessageLog,
  renderMessagesBlock,
  type SessionLogRead,
} from '../src/thread/show';

const FULL = {
  firstUserMessage: 'build the thread messages\nand keep them searchable',
  lastAssistantMessage: 'Done — the extractor is in.',
  lastUserMessage: 'go ahead and dispatch 2',
  resumeCommand: "cd '/Users/jhaa/Dev/home-base' && claude --resume abc-123",
};

function render(metadata: Record<string, unknown>): string {
  return renderMessagesBlock(metadata, false).join('\n');
}

describe('the MESSAGES block', () => {
  test('prints all four fields, labelled and verbatim', () => {
    const out = render(FULL);
    expect(out).toContain('MESSAGES');
    // K11 (k0b8n.10): each label is a bold line at the header column, its text
    // at the body column, a blank line between them.
    expect(out).toContain(
      '\n  First user message\n\n      build the thread messages',
    );
    expect(out).toContain('\n  Last user message\n\n      go ahead');
    expect(out).toContain('\n  Last Claude response\n\n      Done');
    expect(out).toContain('\n  Resume\n\n      cd ');
    expect(out).toContain('    build the thread messages');
    // A multi-line message keeps its lines, each indented under its label.
    expect(out).toContain('    and keep them searchable');
    expect(out).toContain('    go ahead and dispatch 2');
    expect(out).toContain('    Done — the extractor is in.');
    expect(out).toContain(
      "    cd '/Users/jhaa/Dev/home-base' && claude --resume abc-123",
    );
  });

  test('a long message is NOT truncated — the block is the text, not a preview', () => {
    const long = 'q'.repeat(5000);
    expect(render({...FULL, lastAssistantMessage: long})).toContain(long);
  });

  test('a missing field prints the recorded reason, never a blank', () => {
    const out = render({
      autofillFailures: [
        'firstUserMessage: no human-authored user record found in /t.jsonl',
      ],
      lastAssistantMessage: null,
      lastUserMessage: 'go',
      resumeCommand: null,
    });
    expect(out).toContain(
      '(not captured: no human-authored user record found in /t.jsonl)',
    );
    // Two fields are missing with nothing in the failure list to explain them.
    // Saying so is the point: a null that arrived with no reason is itself a
    // finding, and a blank line would hide it (rule 7).
    expect(out).toContain('(not captured: no reason recorded)');
    expect(out).not.toContain('undefined');
  });

  test('an empty string is missing, not present', () => {
    // '' reaching a reader as "he said nothing" is exactly the conflation rule 7
    // forbids — a message he never sent is not a message he sent empty.
    expect(render({...FULL, lastUserMessage: '   '})).toContain(
      '(not captured:',
    );
  });

  test('a bead that predates these fields degrades to reasons, not to a crash', () => {
    const out = render({sessionId: 'abc-123'});
    expect(out).toContain('MESSAGES');
    expect(out.split('(not captured:').length - 1).toBe(4);
  });

  test('field names are bold when colour is on, and plain when it is off', () => {
    expect(renderMessagesBlock(FULL, true).join('\n')).toContain(
      '\u001b[1mFirst user message\u001b[0m',
    );
    expect(render(FULL)).not.toContain('\u001b[');
  });
});

// ---------------------------------------------------------------------------
// K10 f: the message log behind `thread show --messages` and the count line
//
// NEGATIVE CONTROLS (2026-09-23, home-base-k0b8n.9): renderMessageLog's
// `if (index > 0) out.push('')` → `index > 99` turned "a blank line between
// messages" red (`Expected - 2`: the two blank separators); renderMessagesBlock's
// count push gated off turned "a read log prints the count" red (`Expected to
// contain: "  3 messages captured (thread show jl-t9 --messages)"`). 15/2 → 17/0
// restored.
// ---------------------------------------------------------------------------

const LOG_LINES: MessageLine[] = [
  {
    at: '2026-09-23T14:05:00.000Z',
    cwd: '/w',
    event: 'UserPromptSubmit',
    role: 'user',
    text: 'build the capture hook',
  },
  {
    at: '2026-09-23T14:09:30.000Z',
    cwd: '/w',
    event: 'Stop',
    role: 'assistant',
    text: 'Done.\n\nThe hook is in.',
  },
  {
    at: '2026-09-23T14:10:00.000Z',
    cwd: '/w',
    event: 'UserPromptSubmit',
    role: 'user',
    text: 'ship it',
  },
];

const READ: SessionLogRead = {
  failures: [],
  kind: 'read',
  lines: LOG_LINES,
  path: '/state/messages/s.jsonl',
};

function lineAt(index: number): MessageLine {
  const line = LOG_LINES[index];
  if (line == null) throw new Error(`no fixture line ${index}`);
  return line;
}

describe('the MESSAGES block count line (K10 f)', () => {
  test('a read log prints the count and the command that prints it', () => {
    const out = renderMessagesBlock(FULL, false, {
      read: READ,
      threadId: 'jl-t9',
    }).join('\n');
    expect(out).toContain(
      '  3 messages captured (thread show jl-t9 --messages)',
    );
  });

  test('one message is singular', () => {
    expect(capturedCountLines('jl-t9', {...READ, lines: [lineAt(0)]})).toEqual([
      '      1 message captured (thread show jl-t9 --messages)',
    ]);
  });

  test('a missing log says so and names the path — it is not "0"', () => {
    expect(
      capturedCountLines('jl-t9', {
        kind: 'missing',
        path: '/state/messages/s.jsonl',
      }),
    ).toEqual([
      '      no messages captured — there is no message log at /state/messages/s.jsonl',
    ]);
  });

  test('an unreadable log is UNKNOWN with the error, never a count', () => {
    const out = capturedCountLines('jl-t9', {
      error: 'EACCES: permission denied',
      kind: 'failed',
      path: '/state/messages/s.jsonl',
    }).join('\n');
    expect(out).toContain('UNKNOWN');
    expect(out).toContain('EACCES: permission denied');
    expect(out).not.toMatch(/\d+ messages? captured/);
  });

  test('a bead with no usable session id cannot claim the log is absent', () => {
    expect(readSessionLog({})).toEqual({
      detail: 'this bead records no sessionId',
      kind: 'noSession',
    });
    expect(readSessionLog({sessionId: '../../etc/passwd'}).kind).toBe(
      'noSession',
    );
  });

  test('skipped malformed lines are named under the count', () => {
    const lines = capturedCountLines('jl-t9', {
      ...READ,
      failures: [
        '/state/messages/s.jsonl: 1 line(s) are not message lines and were skipped',
      ],
    });
    expect(lines[1]).toContain('1 line(s) are not message lines');
  });

  test('the block without a log is unchanged (the K4 callers)', () => {
    expect(render(FULL)).not.toContain('captured (thread show');
  });
});

describe('thread show --messages: the whole log (K10 f)', () => {
  test('a blank line between messages, speaker + time above each, text indented', () => {
    const you = messageFieldName(lineAt(0));
    const claude = messageFieldName(lineAt(1));
    expect(renderMessageLog(READ, false)).toEqual([
      `  ${you}`,
      '',
      '      build the capture hook',
      '',
      `  ${claude}`,
      '',
      '      Done.',
      '',
      '      The hook is in.',
      '',
      `  ${messageFieldName(lineAt(2))}`,
      '',
      '      ship it',
    ]);
    expect(you.startsWith('you · 2026-09-2')).toBe(true);
    expect(claude.startsWith('Claude · ')).toBe(true);
  });

  test('the speaker line is bold when colour is on', () => {
    expect(renderMessageLog(READ, true)[0]).toBe(
      `  \u001b[1m${messageFieldName(lineAt(0))}\u001b[0m`,
    );
  });

  test('a long message is printed whole', () => {
    const long = 'z'.repeat(20_000);
    const out = renderMessageLog(
      {...READ, lines: [{...lineAt(1), text: long}]},
      false,
    );
    expect(out).toContain(`      ${long}`);
  });

  test('missing, unreadable and session-less logs each say which', () => {
    expect(
      renderMessageLog({kind: 'missing', path: '/p.jsonl'}, false)[0],
    ).toContain('no message log at /p.jsonl');
    expect(
      renderMessageLog({error: 'EIO', kind: 'failed', path: '/p.jsonl'}, false),
    ).toEqual(['      UNKNOWN — could not read /p.jsonl (EIO)']);
    expect(
      renderMessageLog({detail: 'no sessionId', kind: 'noSession'}, false),
    ).toEqual(['      UNKNOWN — no sessionId']);
  });
});
