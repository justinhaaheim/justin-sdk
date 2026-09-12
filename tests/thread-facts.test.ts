/**
 * Autofilled facts (home-base-p1uj D7), against a fixture transcript.
 *
 * The one that matters is `lastUserMessage`. A real transcript's `type: "user"`
 * records are mostly NOT Justin: tool results wear the same type, Claude Code
 * injects `<system-reminder>` blocks into the front of real messages, and
 * `<task-notification>` records arrive from finished subagents. Reporting any of
 * those back as "what you asked me to do" is worse than reporting nothing,
 * because it reads as a quote.
 *
 * The fixture below contains one of each kind of noise, in the order a real
 * transcript produces them, with the genuine message EARLIER than all of them —
 * so a naive "last user record" implementation picks up noise and fails.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  collectThreadFacts,
  findTranscript,
  stripInjectedNoise,
  scanTranscriptForThread,
  userMessageText,
} from '../src/thread/facts';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const RECORDS: unknown[] = [
  {
    cwd: '/Users/jhaa/Dev/home-base',
    entrypoint: 'cli',
    timestamp: '2026-09-12T07:00:00.000Z',
    type: 'user',
    isMeta: true,
    message: {content: '<command-name>/kickoff</command-name>', role: 'user'},
  },
  {
    timestamp: '2026-09-12T07:00:05.000Z',
    type: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: '<system-reminder>\nCodebase instructions here.\n</system-reminder>Build the thread command group, and keep zod off the hot path.',
        },
      ],
      role: 'user',
    },
  },
  {
    timestamp: '2026-09-12T07:01:00.000Z',
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      usage: {
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 120000,
        input_tokens: 34,
      },
    },
  },
  {
    timestamp: '2026-09-12T07:02:00.000Z',
    type: 'user',
    toolUseResult: {stdout: 'ok'},
    message: {
      content: [
        {type: 'tool_result', content: 'file written', tool_use_id: 'x'},
      ],
      role: 'user',
    },
  },
  {
    timestamp: '2026-09-12T07:03:00.000Z',
    type: 'user',
    message: {
      content: '<task-notification>Agent player finished.</task-notification>',
      role: 'user',
    },
  },
  {
    timestamp: '2026-09-12T07:04:00.000Z',
    type: 'user',
    isSidechain: true,
    message: {
      content: 'Subagent prompt written by Claude, not Justin.',
      role: 'user',
    },
  },
  {
    timestamp: '2026-09-12T07:05:00.000Z',
    type: 'user',
    message: {
      content:
        '<system-reminder>\nA reminder with no closing tag in this record',
      role: 'user',
    },
  },
];

function seedTranscript(): {env: Record<string, string>; path: string} {
  const sb = track(createSandbox());
  const projectDir = join(sb.path, 'projects', '-Users-jhaa-Dev-home-base');
  mkdirSync(projectDir, {recursive: true});
  const path = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, `${RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return {
    env: {
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    },
    path,
  };
}

describe('stripInjectedNoise', () => {
  test('removes a closed system-reminder and keeps the real text', () => {
    expect(
      stripInjectedNoise('<system-reminder>rules</system-reminder>hello'),
    ).toBe('hello');
  });

  test('removes a system-reminder left UNCLOSED at the end of the record', () => {
    expect(stripInjectedNoise('hello<system-reminder>rules and more')).toBe(
      'hello',
    );
  });

  test('removes task notifications and slash-command envelopes', () => {
    expect(
      stripInjectedNoise('<task-notification>agent done</task-notification>'),
    ).toBe('');
    expect(stripInjectedNoise('<command-name>/loop</command-name>')).toBe('');
  });
});

describe('userMessageText', () => {
  test('skips tool_result records', () => {
    expect(
      userMessageText({
        message: {content: [{type: 'tool_result'} as never]},
        type: 'user',
      } as never),
    ).toBeNull();
  });

  test('skips records Claude Code marked as its own (isMeta)', () => {
    expect(
      userMessageText({
        isMeta: true,
        message: {content: 'anything'},
        type: 'user',
      } as never),
    ).toBeNull();
  });

  test('skips a record whose only content was injected noise', () => {
    expect(
      userMessageText({
        message: {content: '<task-notification>x</task-notification>'},
        type: 'user',
      } as never),
    ).toBeNull();
  });
});

describe('scanTranscriptForThread', () => {
  test('finds JUSTIN’s message, not the noise that came after it', () => {
    const {path} = seedTranscript();
    const scan = scanTranscriptForThread(path);
    expect(scan.lastUserMessage).toBe(
      'Build the thread command group, and keep zod off the hot path.',
    );
    expect(scan.lastUserMessage).not.toContain('system-reminder');
    expect(scan.lastUserMessage).not.toContain('task-notification');
    expect(scan.lastUserMessage).not.toContain('Subagent prompt');
  });

  test('reads the model and the first timestamp', () => {
    const {path} = seedTranscript();
    const scan = scanTranscriptForThread(path);
    expect(scan.model).toBe('claude-opus-5');
    expect(scan.startedAt).toBe('2026-09-12T07:00:00.000Z');
    expect(scan.entrypoint).toBe('cli');
  });
});

describe('findTranscript', () => {
  test('finds a transcript in ANY project directory, not one derived from cwd', () => {
    const {env} = seedTranscript();
    const found = findTranscript(SESSION_ID, env);
    expect(found.status).toBe('found');
  });

  test('a missing transcript is not-found, and an unreadable root is failed', () => {
    const {env} = seedTranscript();
    expect(findTranscript('no-such-session', env).status).toBe('not-found');
    expect(
      findTranscript(SESSION_ID, {
        JUSTIN_THREADS_TRANSCRIPTS_ROOT: '/nope/does/not/exist',
      }).status,
    ).toBe('failed');
  });
});

describe('collectThreadFacts', () => {
  test('measures tokens through usage-check’s reader', () => {
    const {env} = seedTranscript();
    const collected = collectThreadFacts({
      env,
      now: new Date('2026-09-12T09:00:00Z'),
    });
    // 34 + 1000 + 120000 — the same sum usage-check reports.
    expect(collected.tokensAtStop).toBe(121034);
    expect(collected.sessionId).toBe(SESSION_ID);
    expect(collected.reportedAt).toBe('2026-09-12T09:00:00.000Z');
  });

  test('a missing session id is null AND a named failure, never a blank', () => {
    const collected = collectThreadFacts({env: {}});
    expect(collected.sessionId).toBeNull();
    expect(collected.autofillFailures.join('\n')).toContain('sessionId:');
  });

  test('a cwd outside any repo leaves the git facts null with a named failure', () => {
    const sb = track(createSandbox());
    const collected = collectThreadFacts({cwd: sb.path, env: {}});
    expect(collected.repoPath).toBeNull();
    expect(collected.branch).toBeNull();
    expect(collected.aheadBehind).toBeNull();
    expect(collected.autofillFailures.join('\n')).toContain('repoPath:');
  });
});
