/**
 * The transcript extractor (home-base-k0b8n K1–K4).
 *
 * THE DISCRIMINATING FIXTURE is `fixtures/conductor-session.jsonl`, a redacted
 * slice of the conductor session that scoped this work (sessionId
 * 5a3c3420-be6b-47ed-9247-723b440b79d7). Its record SHAPES are copied from the
 * real file rather than invented, because every one of them is a way the naive
 * implementation goes wrong:
 *
 *  - the session opens with a bare `/conductor` envelope, so "the first user
 *    record with text" reports a slash command instead of the brief;
 *  - the brief itself arrives wrapped in `<pasted_content id="b473">`, so a
 *    reader that treats tags as noise throws away Justin's actual words;
 *  - the skill text Claude Code expands the command into is `isMeta` and looks
 *    exactly like a long human message;
 *  - a finished subagent posts a `<task-notification>` AFTER the last real
 *    message, so "the last user record" is a notification;
 *  - Justin's real last message arrives with a `<system-reminder>` glued to its
 *    front and an image block beside it, and the old rule dropped any record
 *    that had a non-text block;
 *  - the transcript ends with a thinking-only and then a tool_use-only
 *    assistant record, so "the last assistant record" has no text at all.
 *
 * NEGATIVE CONTROLS are recorded on home-base-k0b8n.1's notes: each test names
 * the line that was broken to watch it fail.
 */

import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {
  assistantText,
  buildResumeCommand,
  extractTranscriptMessages,
  forEachTranscriptLine,
  projectDirSlug,
  stripHarnessNoise,
  substantiveUserText,
} from '../src/thread/transcript-messages';

const FIXTURE = join(
  dirname(new URL(import.meta.url).pathname),
  'fixtures',
  'conductor-session.jsonl',
);

const SESSION = '5a3c3420-be6b-47ed-9247-723b440b79d7';

describe('K2 · the first substantive user message', () => {
  test('is the pasted /conductor brief, not the command that opened the session', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.firstUserMessage).not.toBeNull();
    expect(messages.firstUserMessage).toStartWith('You are the /conductor.');
    expect(messages.firstUserMessage).toEndWith(
      "auto mode's classifier checks it.",
    );
    // The record it came from, not a neighbour's stamp.
    expect(messages.firstUserMessageAt).toBe('2026-09-19T10:51:00.297Z');
  });

  test('keeps the pasted_content TEXT and drops both of its tags', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.firstUserMessage).not.toContain('pasted_content');
    expect(messages.firstUserMessage).not.toContain('<');
    // Justin: a pasted block IS his words. Losing them would lose the brief.
    expect(messages.firstUserMessage).toContain('home-base-k0b8n');
  });

  test('a bare /command is not a message; one WITH args is', () => {
    expect(
      stripHarnessNoise(
        '<command-message>copy</command-message>\n<command-name>/copy</command-name>\n<command-args></command-args>',
      ),
    ).toBe('');
    expect(
      stripHarnessNoise(
        '<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args>tell me what is in flight</command-args>',
      ),
    ).toBe('/handoff tell me what is in flight');
  });

  test('a record that is ONLY a system-reminder is not a message', () => {
    expect(
      substantiveUserText({
        message: {content: '<system-reminder>rules</system-reminder>'},
        type: 'user',
      } as never),
    ).toBeNull();
    // …and an UNCLOSED one, whose closing tag landed in the next record.
    expect(
      substantiveUserText({
        message: {content: '<system-reminder>rules and then nothing'},
        type: 'user',
      } as never),
    ).toBeNull();
  });

  test('every harness wrapper measured across the 8-repo corpus is stripped', () => {
    const cases: [string, string][] = [
      ['<task-notification>agent done</task-notification>', ''],
      ['<local-command-caveat>Caveat: …</local-command-caveat>', ''],
      [
        '<local-command-stdout>Disabled auto-compact</local-command-stdout>',
        '',
      ],
      ['<bash-input>bun run signal-backup:doctor</bash-input>', ''],
      ['<bash-stdout>✓ tools</bash-stdout><bash-stderr>x</bash-stderr>', ''],
      [
        '<bash-notification>\n<shell-id>bc5e34d</shell-id>\n</bash-notification>',
        '',
      ],
      ['<ide_opened_file>The user opened …</ide_opened_file>', ''],
      ['[Request interrupted by user]', ''],
      ['[Request interrupted by user for tool use]', ''],
      [
        '[Image: original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]',
        '',
      ],
      ['[Image: source: /Users/jhaa/.claude/image-cache/abc/1.png]', ''],
      ['[SYSTEM NOTIFICATION - NOT USER INPUT] a background task finished', ''],
      // ATTRIBUTES on the tag — the old <tag>-anchored patterns matched none of
      // these, so the whole envelope was reported as Justin's message.
      [
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/43142.sock">\nnfv2 is green\n</cross-session-message>',
        '',
      ],
      [
        '<agent-message from="a0925c7d1ff48827e">\n[Subagent hand-back] the report\n</agent-message>',
        '',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(stripHarnessNoise(input)).toBe(expected);
    }
  });

  test('noise glued to a REAL message strips the noise and keeps the message', () => {
    expect(
      stripHarnessNoise(
        '<system-reminder>rules</system-reminder>ship it [Request interrupted by user]',
      ),
    ).toBe('ship it');
  });
});

describe('K2 · the last substantive user message', () => {
  test('is never a task notification, a sidechain prompt or an interruption', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.lastUserMessage).toBe('go ahead and dispatch 2');
    expect(messages.lastUserMessage).not.toContain('task-notification');
    expect(messages.lastUserMessage).not.toContain('SUBAGENT PROMPT');
    expect(messages.lastUserMessage).not.toContain('Request interrupted');
    expect(messages.lastUserMessageAt).toBe('2026-09-19T11:12:00.000Z');
  });

  test('a text block beside an IMAGE block is still a message', () => {
    // The old rule bailed on the whole record the moment it saw a non-text
    // block, which threw away the sentence attached to every screenshot.
    expect(
      substantiveUserText({
        message: {
          content: [
            {text: 'look at this', type: 'text'},
            {source: {data: 'x'}, type: 'image'},
          ],
        },
        type: 'user',
      } as never),
    ).toBe('look at this');
  });

  test('a tool_result block still disqualifies the record', () => {
    expect(
      substantiveUserText({
        message: {content: [{content: 'out', type: 'tool_result'}]},
        type: 'user',
      } as never),
    ).toBeNull();
  });

  test('messages are stored UNCAPPED — the renderers cap, the store does not', () => {
    const long = 'x'.repeat(4000);
    expect(stripHarnessNoise(long)).toHaveLength(4000);
  });
});

describe('K3 · the last assistant message', () => {
  test('walks back past a thinking-only and a tool_use-only tail', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.lastAssistantMessage).toBe(
      "Dispatch 1 is running in the worktree.\n\nWaiting on the player's return before the next step.",
    );
    expect(messages.lastAssistantMessageAt).toBe('2026-09-19T11:00:00.000Z');
  });

  test('thinking and tool_use blocks never reach the stored text', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.lastAssistantMessage).not.toContain('THINKING MUST NOT');
    // The tail record is thinking-only. If thinking counted as text, THIS is
    // what would be stored as "the last thing Claude said".
    expect(messages.lastAssistantMessage).not.toContain('THINKING-ONLY TAIL');
    expect(messages.lastAssistantMessage).not.toContain('git status');
  });

  test('a tool_use-only record has no text of its own', () => {
    expect(
      assistantText({
        message: {content: [{id: 'a', name: 'Bash', type: 'tool_use'}]},
        type: 'assistant',
      } as never),
    ).toBeNull();
  });
});

describe('K4 · the resume command', () => {
  test('uses the LAST cwd when its slug is the transcript’s project directory', () => {
    const resume = buildResumeCommand({
      firstCwd: '/Users/jhaa/Dev/home-base',
      lastCwd: '/Users/jhaa/Dev/home-base/.claude/worktrees/threads-capture',
      sessionId: SESSION,
      transcriptPath: `/p/-Users-jhaa-Dev-home-base--claude-worktrees-threads-capture/${SESSION}.jsonl`,
    });
    expect(resume.source).toBe('lastCwd');
    expect(resume.failure).toBeNull();
    expect(resume.command).toBe(
      `cd '/Users/jhaa/Dev/home-base/.claude/worktrees/threads-capture' && claude --resume ${SESSION}`,
    );
  });

  test('falls back to the FIRST cwd when the transcript did not follow the session', () => {
    // MEASURED 2026-09-19 over 1,896 transcripts: 72 have a last cwd that does
    // not slug to their own directory, and 56 of those are this case — the
    // session cd'd into a worktree and the file stayed put.
    const resume = buildResumeCommand({
      firstCwd: '/Users/jhaa/Dev/home-base',
      lastCwd: '/Users/jhaa/Dev/home-base/.claude/worktrees/signal-backup',
      sessionId: SESSION,
      transcriptPath: `/p/-Users-jhaa-Dev-home-base/${SESSION}.jsonl`,
    });
    expect(resume.source).toBe('firstCwd');
    expect(resume.failure).toBeNull();
    expect(resume.command).toBe(
      `cd '/Users/jhaa/Dev/home-base' && claude --resume ${SESSION}`,
    );
  });

  test('when NEITHER cwd matches it says so, rather than printing a command that quietly finds nothing', () => {
    const resume = buildResumeCommand({
      firstCwd: '/Users/jhaa/Dropbox/Claude Working Directory/life-management',
      lastCwd: '/Users/jhaa/Dropbox/Claude Working Directory/life-management',
      sessionId: SESSION,
      transcriptPath: `/p/-Users-jhaa-Dev-life/${SESSION}.jsonl`,
    });
    expect(resume.failure).toContain('-Users-jhaa-Dev-life');
    expect(resume.failure).toContain('may not find this session');
    // Still offers the best guess — a wrong-bucket cd is more useful than
    // nothing, PROVIDED the caveat travels with it.
    expect(resume.command).toContain('claude --resume');
  });

  test('no session id is a named failure, never a half-built command', () => {
    const resume = buildResumeCommand({
      firstCwd: '/x',
      lastCwd: '/x',
      sessionId: null,
      transcriptPath: `/p/-x/${SESSION}.jsonl`,
    });
    expect(resume.command).toBeNull();
    expect(resume.failure).toContain('no session id');
  });

  test('the project slug replaces every non-alphanumeric byte, so it is not invertible', () => {
    // This is WHY the directory name is only ever checked against, never used
    // as a source: `_`, `.`, `/` and space all collapse to the same character.
    expect(projectDirSlug('/Users/jhaa/Dev/beads_rust')).toBe(
      '-Users-jhaa-Dev-beads-rust',
    );
    expect(projectDirSlug('/Users/jhaa/Dropbox/Project Filing Cabinet')).toBe(
      '-Users-jhaa-Dropbox-Project-Filing-Cabinet',
    );
    expect(
      projectDirSlug('/Users/jhaa/Dev/home-base/.claude/worktrees/x'),
    ).toBe('-Users-jhaa-Dev-home-base--claude-worktrees-x');
  });

  test('a cwd with a quote in it is still safely quoted', () => {
    const cwd = "/Users/jhaa/Dev/it's";
    const resume = buildResumeCommand({
      firstCwd: null,
      lastCwd: cwd,
      sessionId: SESSION,
      transcriptPath: `/p/${projectDirSlug(cwd)}/${SESSION}.jsonl`,
    });
    expect(resume.command).toBe(
      `cd '/Users/jhaa/Dev/it'\\''s' && claude --resume ${SESSION}`,
    );
  });
});

describe('K1 · the session facts and the streaming read', () => {
  test('reads cwd, branch, model, entrypoint and the span from the right records', () => {
    const messages = extractTranscriptMessages(FIXTURE);
    expect(messages.sessionId).toBe(SESSION);
    // The LAST record with a cwd, not the first: the session moved.
    expect(messages.cwd).toBe(
      '/Users/jhaa/Dev/home-base/.claude/worktrees/threads-capture',
    );
    expect(messages.firstCwd).toBe('/Users/jhaa/Dev/home-base');
    expect(messages.gitBranch).toBe('worktree-threads-capture');
    expect(messages.model).toBe('claude-fable-5-1');
    expect(messages.entrypoint).toBe('cli');
    expect(messages.firstTimestamp).toBe('2026-09-19T10:50:59.000Z');
    // The last RECORD's stamp — a `system` record here — never the file mtime.
    expect(messages.lastTimestamp).toBe('2026-09-19T11:28:09.846Z');
    // The fixture lives in `tests/fixtures/`, which is nobody's project slug,
    // so the resume command CORRECTLY reports that it may not find the session.
    // Nothing else failed; the last group re-files it properly and gets a clean
    // run.
    expect(messages.failures).toEqual([
      "resumeCommand: neither cwd slugs to the transcript's project directory fixtures — the resume may not find this session",
    ]);
  });

  test('a line longer than one read chunk survives the chunk boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-chunk-'));
    const path = join(dir, `${SESSION}.jsonl`);
    // 3 MiB of text in one record, across three 1 MiB reads.
    const big = 'y'.repeat(3 * 1024 * 1024);
    writeFileSync(
      path,
      `${JSON.stringify({
        cwd: '/tmp',
        message: {content: big, role: 'user'},
        sessionId: SESSION,
        timestamp: '2026-09-19T10:00:00.000Z',
        type: 'user',
      })}\n`,
    );
    const messages = extractTranscriptMessages(path);
    expect(messages.lastUserMessage).toHaveLength(big.length);
  });

  test('a multi-byte character split across a chunk boundary is not corrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-utf8-'));
    const path = join(dir, `${SESSION}.jsonl`);
    // Pad so the 3-byte '…' straddles the 1 MiB mark.
    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        message: {
          content: `${'a'.repeat(1024 * 1024 - 20)}…tail`,
          role: 'user',
        },
        timestamp: '2026-09-19T10:00:00.000Z',
        type: 'user',
      }),
    );
    writeFileSync(path, `${lines.join('\n')}\n`);
    const messages = extractTranscriptMessages(path);
    expect(messages.lastUserMessage).toEndWith('…tail');
    expect(messages.lastUserMessage).not.toContain('�');
  });

  test('a file with no trailing newline still yields its last record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-nonl-'));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        message: {content: 'the very last thing', role: 'user'},
        timestamp: '2026-09-19T10:00:00.000Z',
        type: 'user',
      }),
    );
    expect(extractTranscriptMessages(path).lastUserMessage).toBe(
      'the very last thing',
    );
  });

  test('lines are handed over in file order, streaming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-lines-'));
    const path = join(dir, 'x.jsonl');
    writeFileSync(path, 'a\nb\nc\n');
    const seen: string[] = [];
    forEachTranscriptLine(path, (line) => seen.push(line));
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});

describe('rule 7 · a failure is never an empty measurement', () => {
  test('an unreadable transcript THROWS rather than returning all-nulls', () => {
    expect(() =>
      extractTranscriptMessages('/nope/does/not/exist.jsonl'),
    ).toThrow();
  });

  test('a transcript with no human message names the gap, three times over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-empty-'));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        message: {content: '<task-notification>done</task-notification>'},
        timestamp: '2026-09-19T10:00:00.000Z',
        type: 'user',
      })}\n`,
    );
    const messages = extractTranscriptMessages(path);
    expect(messages.firstUserMessage).toBeNull();
    expect(messages.lastUserMessage).toBeNull();
    expect(messages.lastAssistantMessage).toBeNull();
    const joined = messages.failures.join('\n');
    expect(joined).toContain('firstUserMessage:');
    expect(joined).toContain('lastUserMessage:');
    expect(joined).toContain('lastAssistantMessage:');
  });

  test('a corrupt line in the MIDDLE is counted; a partial LAST line is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-bad-'));
    const good = JSON.stringify({
      message: {content: 'hello', role: 'user'},
      timestamp: '2026-09-19T10:00:00.000Z',
      type: 'user',
    });
    // A live transcript's trailing line is routinely half-written; saying that
    // is a measurement failure would cry wolf on every report.
    const livePath = join(dir, 'live.jsonl');
    writeFileSync(livePath, `${good}\n{"type":"assis`);
    expect(
      extractTranscriptMessages(livePath).failures.join('\n'),
    ).not.toContain('not valid JSON');

    const corruptPath = join(dir, 'corrupt.jsonl');
    writeFileSync(corruptPath, `{"type":"assis\n${good}\n`);
    expect(
      extractTranscriptMessages(corruptPath).failures.join('\n'),
    ).toContain('1 line(s)');
  });

  test('a subagent’s sidechain records are not this session’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-side-'));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        isSidechain: true,
        message: {content: 'a prompt Claude wrote', role: 'user'},
        timestamp: '2026-09-19T10:00:00.000Z',
        type: 'user',
      })}\n`,
    );
    expect(extractTranscriptMessages(path).lastUserMessage).toBeNull();
  });
});

describe('the whole pipeline, against a fixture filed like a real transcript', () => {
  /** A transcripts root whose project directory really is `slug(cwd)`. */
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), 'tm-root-'));
    const cwd = '/Users/jhaa/Dev/home-base/.claude/worktrees/threads-capture';
    const projectDir = join(root, projectDirSlug(cwd));
    mkdirSync(projectDir, {recursive: true});
    return join(projectDir, `${SESSION}.jsonl`);
  }

  test('the resume command is built from the fixture’s own filing', async () => {
    const path = seed();
    writeFileSync(path, await Bun.file(FIXTURE).text());
    const messages = extractTranscriptMessages(path);
    expect(messages.resumeCwdSource).toBe('lastCwd');
    expect(messages.resumeCommand).toBe(
      `cd '/Users/jhaa/Dev/home-base/.claude/worktrees/threads-capture' && claude --resume ${SESSION}`,
    );
    expect(messages.failures).toEqual([]);
  });
});
