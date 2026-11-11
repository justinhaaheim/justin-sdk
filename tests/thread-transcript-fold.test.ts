/**
 * Incremental transcript reads (home-base-9uzxw.16, src/thread/transcript-fold.ts):
 * a transcript that only grew is folded from its new lines, and after every
 * growth the cached facts equal a full read of the file, byte for byte.
 *
 * The step tests append to a main and a subagent transcript in several steps
 * that cover every fact the cache keeps: commit calls and their results (a
 * repeated tool_use with no timestamp, a result in a later step), writes, a
 * bad line in the middle, a partial line written in two steps (D3), sidechain
 * records, context sizes, a background shell opened and closed, a thinking
 * record, a handback and its result in separate steps, a record with no
 * timestamp, and a fold from a disk entry after the memory is cleared.
 *
 * The rewrite tests change a file in place (same size, smaller, larger with a
 * changed start, larger with a changed seam): each is read whole (D2).
 *
 * NEGATIVE CONTROLS: recorded in home-base-9uzxw.16's notes.
 */

import {afterAll, beforeEach, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {
  resetTranscriptCacheMemory,
  transcriptCacheStats,
  transcriptFileFacts,
  transcriptFileFactsOfBytes,
} from '../src/thread/transcript-cache';
import {INCREMENTAL_READS_KNOB} from '../src/thread/transcript-fold';
import {fixtureText} from './transcript-cache-fixtures';

const MARKER = '[TEST_DATA_DELETABLE 9b0eb49b-f4dd-43f5-93e5-f6e6f3de4ef9 ]';
const SID = '9b0eb49b-0000-4000-8000-00000000f001';
const CWD = '/fixture/Dev/fold';
const SHA = 'abc1234';

const root = mkdtempSync(join(tmpdir(), 'transcript-fold-test-'));
const cacheHome = join(root, 'cache');
const savedCache = process.env.XDG_CACHE_HOME;
const savedKnob = process.env[INCREMENTAL_READS_KNOB];
let fileCount = 0;

afterAll(() => {
  rmSync(root, {force: true, recursive: true});
  if (savedCache == null) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
  if (savedKnob == null) delete process.env[INCREMENTAL_READS_KNOB];
  else process.env[INCREMENTAL_READS_KNOB] = savedKnob;
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = cacheHome;
  delete process.env[INCREMENTAL_READS_KNOB];
  resetTranscriptCacheMemory();
});

function line(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

/** A fresh main transcript path, or a subagent one beside it. */
function newPath(kind: 'main' | 'subagent'): string {
  fileCount += 1;
  const dir = join(root, 'projects', `-fixture-${fileCount}`);
  const path =
    kind === 'main'
      ? join(dir, `${SID}.jsonl`)
      : join(dir, SID, 'subagents', `agent-f${fileCount}.jsonl`);
  mkdirSync(dirname(path), {recursive: true});
  return path;
}

/** What a full read of the file says, as JSON. */
function fullRead(path: string): string {
  return JSON.stringify(
    transcriptFileFactsOfBytes(readFileSync(path), path, true),
  );
}

/** What the cache says now, as JSON. */
function cached(path: string): string {
  return JSON.stringify(transcriptFileFacts(path, {withMessages: true}));
}

function fixtureLines(name: string): string[] {
  return fixtureText(name, {cwd: CWD, sha: SHA})
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => `${entry}\n`);
}

function assistantTool(
  id: string,
  name: string,
  input: object,
  timestamp: string | null,
  sidechain = false,
): string {
  return line({
    cwd: CWD,
    ...(sidechain ? {isSidechain: true} : {}),
    message: {
      content: [{id, input, name, type: 'tool_use'}],
      role: 'assistant',
    },
    sessionId: SID,
    ...(timestamp == null ? {} : {timestamp}),
    type: 'assistant',
  });
}

function toolResult(
  id: string,
  content: string,
  timestamp: string,
  sidechain = false,
): string {
  return line({
    cwd: CWD,
    ...(sidechain ? {isSidechain: true} : {}),
    message: {
      content: [{content, tool_use_id: id, type: 'tool_result'}],
      role: 'user',
    },
    sessionId: SID,
    timestamp,
    type: 'user',
  });
}

function assistantText(
  text: string,
  timestamp: string | null,
  options: {sidechain?: boolean; tokens?: number} = {},
): string {
  return line({
    cwd: CWD,
    ...(options.sidechain === true ? {isSidechain: true} : {}),
    message: {
      content: [{text, type: 'text'}],
      model: 'claude-test',
      role: 'assistant',
      ...(options.tokens == null
        ? {}
        : {
            usage: {
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: options.tokens,
              input_tokens: 10,
            },
          }),
    },
    sessionId: SID,
    ...(timestamp == null ? {} : {timestamp}),
    type: 'assistant',
  });
}

interface Step {
  /** What the step appends. */
  append: string;
  /** How the cache must answer: folded from the new bytes, or read whole. */
  expect: 'fold' | 'full';
  /** Clear the in-memory entries first (a new process: the fold starts from the disk entry). */
  newProcess?: boolean;
}

/**
 * Write `initial`, read it once, then apply each step and check that the
 * cache's facts equal a full read, and that the cache folded (or read whole)
 * as the step says.
 */
function runSteps(path: string, initial: string, steps: Step[]): string[] {
  writeFileSync(path, initial);
  const first = transcriptCacheStats();
  expect(cached(path)).toBe(fullRead(path));
  expect(transcriptCacheStats().fileReads).toBe(first.fileReads + 1);

  const answers: string[] = [];
  steps.forEach((step, index) => {
    if (step.newProcess === true) resetTranscriptCacheMemory();
    appendFileSync(path, step.append);
    const before = transcriptCacheStats();
    const answer = cached(path);
    const after = transcriptCacheStats();
    const label = `step ${index + 1}`;
    expect({label, value: answer}).toEqual({label, value: fullRead(path)});
    if (step.expect === 'fold') {
      expect({folds: after.foldReads - before.foldReads, label}).toEqual({
        folds: 1,
        label,
      });
      expect({label, reads: after.fileReads - before.fileReads}).toEqual({
        label,
        reads: 0,
      });
    } else {
      expect({label, reads: after.fileReads - before.fileReads}).toEqual({
        label,
        reads: 1,
      });
    }
    answers.push(answer);
  });
  return answers;
}

describe('a transcript that grows is folded, and equals a full read after every step', () => {
  test('main transcript: commits, writes, a bad line, a partial line, sidechains, context sizes, a disk fold', () => {
    const path = newPath('main');
    const tracked = fixtureLines('tracked.jsonl');
    const commitThree = assistantTool(
      'toolu_c3',
      'Bash',
      {command: `git commit -qm 'more ${MARKER}'`},
      '2030-01-01T09:30:00.000Z',
    );
    const half = Math.floor(commitThree.length / 2);
    const answers = runSteps(path, tracked.slice(0, 3).join(''), [
      {append: tracked[3] ?? '', expect: 'fold'},
      {append: tracked.slice(4).join(''), expect: 'fold'},
      {
        // A repeat of the commit call with no timestamp (Claude Code's
        // api-request-blob), and a line that is not JSON.
        append:
          assistantTool(
            'toolu_c1',
            'Bash',
            {command: `git commit -qm 'notes ${MARKER}'`},
            null,
          ) + '{this is not json\n',
        expect: 'fold',
      },
      {
        // A queued prompt, and a subagent's record with a bigger context
        // (the main file's facts skip it).
        append:
          line({
            attachment: {
              prompt: `Also check the tests ${MARKER}`,
              type: 'queued_command',
            },
            timestamp: '2030-01-01T09:25:00.000Z',
            type: 'attachment',
          }) +
          assistantText('From a helper.', '2030-01-01T09:26:00.000Z', {
            sidechain: true,
            tokens: 90_000,
          }),
        expect: 'fold',
      },
      // D3: half a line (a write in flight) folds with the half line read as
      // a full read reads it, and keeps no fold record ...
      {append: commitThree.slice(0, half), expect: 'fold'},
      // ... so the next growth reads the file whole, partial line included.
      {
        append:
          commitThree.slice(half) +
          toolResult(
            'toolu_c3',
            `[main ${SHA}] more`,
            '2030-01-01T09:30:02.000Z',
          ),
        expect: 'full',
      },
      {
        // A Bash call that does not commit, whose output carries a line
        // shaped like a commit confirmation.
        append:
          assistantTool(
            'toolu_n1',
            'Bash',
            {command: 'cat log.txt'},
            '2030-01-01T09:31:00.000Z',
          ) +
          toolResult(
            'toolu_n1',
            '[main def5678] from the log',
            '2030-01-01T09:31:01.000Z',
          ),
        expect: 'fold',
      },
      {
        append:
          assistantTool(
            'toolu_e1',
            'Edit',
            {file_path: `${CWD}/notes.md`, new_string: 'b', old_string: 'a'},
            '2030-01-01T09:32:00.000Z',
          ) +
          assistantText('Edited the notes.', '2030-01-01T09:33:00.000Z', {
            tokens: 9000,
          }),
        expect: 'fold',
      },
      // A new process: the fold starts from the disk entry.
      {
        append: line({
          subtype: 'turn_duration',
          timestamp: '2030-01-01T09:33:01.000Z',
          type: 'system',
        }),
        expect: 'fold',
        newProcess: true,
      },
      {
        append: line({
          cwd: `${CWD}/sub`,
          gitBranch: 'feature',
          message: {content: `Next step ${MARKER}`, role: 'user'},
          sessionId: SID,
          timestamp: '2030-01-01T09:40:00.000Z',
          type: 'user',
        }),
        expect: 'fold',
      },
    ]);
    // The steps really changed the facts the fold must carry.
    const last = answers.at(-1) ?? '';
    expect(last).toContain("git commit -qm 'more");
    expect(last).toContain('def5678');
    expect(last).toContain('"contextTokens":9010');
    expect(last).toContain('2030-01-01T09:40:00.000Z');
    expect(last).toContain(`${CWD}/notes.md`);
    expect(last).toContain('Next step');
    expect(last).toContain('were not valid JSON');
  });

  test('subagent transcript: a shell opened and closed, thinking, a handback and its result in separate steps', () => {
    const path = newPath('subagent');
    const helper = fixtureLines('tracked.agent-p1.jsonl');
    const answers = runSteps(path, helper.slice(0, 2).join(''), [
      // The background shell's launch.
      {append: helper[2] ?? '', expect: 'fold'},
      // Text with no tool_use while the shell is open: text-ended.
      {append: helper[3] ?? '', expect: 'fold'},
      // A record that is not a conversation record: the tail is unchanged.
      {
        append: line({
          isSidechain: true,
          subtype: 'turn_duration',
          timestamp: '2030-01-01T09:14:01.000Z',
          type: 'system',
        }),
        expect: 'fold',
      },
      // The shell's notification closes it.
      {
        append: line({
          cwd: CWD,
          isSidechain: true,
          message: {
            content:
              '<task-notification><task-id>bash_1</task-id><status>completed</status></task-notification>',
            role: 'user',
          },
          sessionId: SID,
          timestamp: '2030-01-01T09:20:00.000Z',
          type: 'user',
        }),
        expect: 'fold',
      },
      {
        append: line({
          isSidechain: true,
          message: {
            content: [{thinking: 'Checking.', type: 'thinking'}],
            role: 'assistant',
          },
          sessionId: SID,
          timestamp: '2030-01-01T09:21:00.000Z',
          type: 'assistant',
        }),
        expect: 'fold',
      },
      {
        append: assistantTool(
          'toolu_h9',
          'SubagentHandback',
          {message: `Done ${MARKER}`},
          '2030-01-01T09:22:00.000Z',
          true,
        ),
        expect: 'fold',
      },
      // The handback's result, in a later step than its tool_use.
      {
        append: toolResult(
          'toolu_h9',
          'Delivered.',
          '2030-01-01T09:22:01.000Z',
          true,
        ),
        expect: 'fold',
      },
      {
        append: assistantText('One more note.', '2030-01-01T09:23:00.000Z', {
          sidechain: true,
        }),
        expect: 'fold',
      },
      // A result for an old call that is not a handback.
      {
        append: toolResult(
          'toolu_b1',
          'late output',
          '2030-01-01T09:24:00.000Z',
          true,
        ),
        expect: 'fold',
      },
      // A record with no timestamp: the tail's time stays the last one.
      {
        append: assistantText('Untimed.', null, {sidechain: true}),
        expect: 'fold',
        newProcess: true,
      },
    ]);
    // Every tail shape the steps meant to reach was reached.
    const joined = answers.join('\n');
    for (const tail of ['"textEnded"', '"inFlight"', '"finished"']) {
      expect(joined).toContain(tail);
    }
    expect(joined).toContain('"openShells":["bash_1"]');
    expect(joined).toContain('"openShells":[]');
  });

  test(`${INCREMENTAL_READS_KNOB}=off reads a grown file whole, with the same facts`, () => {
    const path = newPath('main');
    const tracked = fixtureLines('tracked.jsonl');
    writeFileSync(path, tracked.slice(0, 3).join(''));
    expect(cached(path)).toBe(fullRead(path));
    process.env[INCREMENTAL_READS_KNOB] = 'off';
    appendFileSync(path, tracked.slice(3).join(''));
    const before = transcriptCacheStats();
    expect(cached(path)).toBe(fullRead(path));
    const after = transcriptCacheStats();
    expect(after.foldReads).toBe(before.foldReads);
    expect(after.fileReads).toBe(before.fileReads + 1);
  });
});

describe('a transcript rewritten in place is read whole (D2)', () => {
  /** A first line long enough that the start and the seam are different bytes. */
  function padding(): string {
    return line({
      content: `padding ${'x'.repeat(9000)}`,
      timestamp: '2030-01-01T08:59:00.000Z',
      type: 'system',
    });
  }

  function rewrite(path: string, text: string, size: 'larger' | 'same'): void {
    const old = readFileSync(path);
    if (size === 'same') expect(Buffer.byteLength(text)).toBe(old.length);
    else expect(Buffer.byteLength(text)).toBeGreaterThan(old.length);
    writeFileSync(path, text);
  }

  function readWhole(path: string): {refusals: number} {
    const before = transcriptCacheStats();
    expect(cached(path)).toBe(fullRead(path));
    const after = transcriptCacheStats();
    expect(after.foldReads).toBe(before.foldReads);
    expect(after.fileReads).toBe(before.fileReads + 1);
    return {refusals: after.foldRefusals - before.foldRefusals};
  }

  test('same size, changed middle (outside both hashed windows: only the size says it did not grow)', () => {
    const path = newPath('main');
    const text = padding() + fixtureLines('tracked.jsonl').join('') + padding();
    writeFileSync(path, text);
    expect(cached(path)).toBe(fullRead(path));
    rewrite(path, text.replace('Build the', 'Bxild the'), 'same');
    readWhole(path);
    expect(cached(path)).toContain('Bxild the');
  });

  test('smaller', () => {
    const path = newPath('main');
    const lines = fixtureLines('tracked.jsonl');
    writeFileSync(path, lines.join(''));
    expect(cached(path)).toBe(fullRead(path));
    writeFileSync(path, lines.slice(0, 2).join('').replace('Build', 'Bxild'));
    readWhole(path);
    expect(cached(path)).toContain('Bxild the');
  });

  test('larger, with a changed start: the prefix hash refuses the fold', () => {
    const path = newPath('main');
    const lines = fixtureLines('tracked.jsonl');
    const text = lines[0] + padding() + lines.slice(1).join('');
    writeFileSync(path, text);
    expect(cached(path)).toBe(fullRead(path));
    rewrite(
      path,
      text.replace('Build the', 'Bxild the') +
        assistantText('Later.', '2030-01-01T09:45:00.000Z'),
      'larger',
    );
    expect(readWhole(path).refusals).toBe(1);
    expect(cached(path)).toContain('Bxild the');
  });

  test('larger, with a changed end before the growth: the seam hash refuses the fold', () => {
    const path = newPath('main');
    const lines = fixtureLines('tracked.jsonl');
    const text = padding() + lines.join('');
    writeFileSync(path, text);
    expect(cached(path)).toBe(fullRead(path));
    rewrite(
      path,
      text.replace(`[main ${SHA}] notes`, `[main ${SHA}] nxtes`) +
        assistantText('Later.', '2030-01-01T09:45:00.000Z'),
      'larger',
    );
    expect(readWhole(path).refusals).toBe(1);
    expect(cached(path)).toContain('"subject":"nxtes"');
  });
});
