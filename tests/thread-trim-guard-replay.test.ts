/**
 * The replay tool (home-base-7761p.23 D10), over a synthetic state dir and
 * synthetic transcripts. Its real run reports zero send-backs, and zero means
 * nothing unless the same tool can be seen reporting one.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {classifyStatusCommand} from '../scripts/replay-trim-guard';
import {PART_ONE_RULE, PART_ONE_SEPARATOR} from '../src/thread/part-one';
import {createSandbox, type Sandbox} from './sandbox';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'replay-trim-guard.ts');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const BLOCK = [
  PART_ONE_RULE,
  '',
  '**Session:** [HOME] A made-up session',
  '',
  '---',
  '',
  '## Questions for you',
  '',
  '1. 🟡 P2 · [Do] **Try it on the phone** (t-3)',
  '',
  '   - Only a device can show it.',
  '',
  "   *If you don't answer: I ship it untested and say so.*",
  '',
  '---',
  '',
  '- **Repo:** home-base',
  '',
  PART_ONE_SEPARATOR,
].join('\n');

const TRIMMED = [
  PART_ONE_RULE,
  '',
  '**Session:** [HOME] A made-up session',
  '',
  '## Questions for you',
  '',
  '1. 🟡 P2 · [Do] **Try it on the phone** The full context is in your inbox (t-3).',
  '',
  PART_ONE_SEPARATOR,
].join('\n');

const OUTPUT = `SESSION BEADS: ENABLED\n\n${BLOCK}\n\nNothing to mark.\n`;
const STATUS = 'bun run justin-sdk thread status';
const RUN_AT = '2030-01-01T10:00:00.000Z';
const READ_AT = '2030-01-01T10:00:30.000Z';
const REPLY_AT = '2030-01-01T10:01:00.000Z';

function toolUse(id: string, name: string, input: object, at: string): object {
  return {
    message: {
      content: [{id, input, name, type: 'tool_use'}],
      role: 'assistant',
    },
    timestamp: at,
    type: 'assistant',
  };
}

function toolResult(id: string, content: string, at: string): object {
  return {
    message: {
      content: [{content, tool_use_id: id, type: 'tool_result'}],
      role: 'user',
    },
    timestamp: at,
    type: 'user',
  };
}

interface FakeSession {
  id: string;
  records: object[];
  reply: string;
}

/** One Bash run of `command` that showed `output`. */
function bashRun(id: string, command: string, output: string): object[] {
  return [
    toolUse(id, 'Bash', {command}, RUN_AT),
    toolResult(id, output, RUN_AT),
  ];
}

function replay(sessions: readonly FakeSession[]): string {
  const state = createSandbox();
  const transcripts = createSandbox();
  sandboxes.push(state, transcripts);
  mkdirSync(join(state.path, 'messages'), {recursive: true});
  const project = join(transcripts.path, '-tmp-scratch');
  mkdirSync(project, {recursive: true});
  for (const session of sessions) {
    writeFileSync(
      join(state.path, 'messages', `${session.id}.jsonl`),
      `${JSON.stringify({at: REPLY_AT, role: 'assistant', text: session.reply})}\n`,
    );
    writeFileSync(
      join(project, `${session.id}.jsonl`),
      session.records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
  }
  const run = spawnSync(process.execPath, [SCRIPT, '--since', '2030-01-01'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      JUSTIN_THREADS_STATE_DIR: state.path,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: transcripts.path,
      NO_COLOR: '1',
    },
  });
  expect(run.status).toBe(0);
  return run.stdout;
}

function counts(output: string): Record<string, number> {
  const read = (label: string): number =>
    Number(new RegExp(`^\\s*${label}:\\s+(\\d+)$`, 'mu').exec(output)?.[1]);
  return {
    comparable: read('comparable'),
    earlier: read('passing, earlier'),
    newest: read('passing, newest'),
    notComparable: read('not comparable'),
    sentBack: read('sent back'),
    withBlock: read('with a block'),
  };
}

describe('classifyStatusCommand (D10: from the command text only)', () => {
  test.each([
    [STATUS],
    [`${STATUS} 2>&1`],
    [`cd /some/where && ${STATUS}`],
    [`br close t-1 --reason done\n${STATUS} 2>&1`],
    ['./node_modules/.bin/justin-sdk thread status'],
    ['justin-sdk-latest thread status'],
  ])('unfiltered: %s', (command) => {
    expect(classifyStatusCommand(command).kind).toBe('unfiltered');
  });

  test.each([
    [`${STATUS} | head -20`],
    [`${STATUS} 2>&1 | sed -n '/^🛑/,/^────/p'`],
    // The trap: it leaves the rule and the separator in place, the middle cut.
    [
      `${STATUS} 2>&1 | sed -n '/^🛑🛑/,/^────/p' | sed -n '1,14p;/^## Questions for you/,$p'`,
    ],
    [`${STATUS} 2>&1 | tail -12`],
    [`${STATUS} | cut -c1-300`],
    [`${STATUS} --session 5e551011`],
    // The second run is unfiltered, and the one result holds both outputs.
    [`${STATUS} 2>&1 | sed -n '1,40p'; ${STATUS}`],
    [`${STATUS} 2>&1 | sed -n '1,40p'; ${STATUS} 2>&1 | rg -n '^────'`],
  ])('filtered: %s', (command) => {
    expect(classifyStatusCommand(command).kind).toBe('filtered');
  });

  test.each([
    [`${STATUS} > /tmp/x/status.txt`, '/tmp/x/status.txt'],
    [`${STATUS} > /tmp/x/status.txt 2>&1`, '/tmp/x/status.txt'],
    [`${STATUS} > "/tmp/x y/status.txt" 2>&1`, '/tmp/x y/status.txt'],
    // What follows a redirect cannot filter what the file holds.
    [
      `${STATUS} > /tmp/x/status.txt 2>&1; wc -l /tmp/x/status.txt`,
      '/tmp/x/status.txt',
    ],
  ])('redirect: %s', (command, path) => {
    expect(classifyStatusCommand(command)).toEqual({kind: 'redirect', path});
  });

  test.each([
    ['rg -n "thread status" README.md'],
    ['bun run justin-sdk thread stage t-1 tested'],
    ["git commit -m 'run thread status first'"],
  ])('not a run: %s', (command) => {
    expect(classifyStatusCommand(command).kind).toBe('notStatus');
  });
});

describe('the replay, end to end', () => {
  test('a pasted whole block is comparable and passes', () => {
    const output = replay([
      {
        id: 'aaaaaaaa-0000',
        records: bashRun('t1', `${STATUS} 2>&1`, OUTPUT),
        reply: `${BLOCK}\n\n## Deviations\n\n- none`,
      },
    ]);
    expect(counts(output)).toMatchObject({
      comparable: 1,
      newest: 1,
      notComparable: 0,
      sentBack: 0,
      withBlock: 1,
    });
  });

  test('a trim against an unfiltered run is sent back, and prints what differs', () => {
    const output = replay([
      {
        id: 'bbbbbbbb-0000',
        records: bashRun('t1', STATUS, OUTPUT),
        reply: TRIMMED,
      },
    ]);
    expect(counts(output)).toMatchObject({comparable: 1, sentBack: 1});
    expect(output).toContain('bbbbbbbb');
    expect(output).toContain('Only a device can show it.');
    expect(output).toContain('The full context is in your inbox');
  });

  test('a redirect read whole is comparable; one read in part is not', () => {
    const redirect = `${STATUS} > /tmp/x/status.txt 2>&1`;
    const numbered = OUTPUT.split('\n')
      .map((line, index) => `${index + 1}\t${line}`)
      .join('\n');
    const whole: FakeSession = {
      id: 'cccccccc-0000',
      records: [
        ...bashRun('t1', redirect, ''),
        toolUse('r1', 'Read', {file_path: '/tmp/x/status.txt'}, READ_AT),
        toolResult('r1', numbered, READ_AT),
      ],
      reply: BLOCK,
    };
    const part: FakeSession = {
      id: 'dddddddd-0000',
      records: [
        ...bashRun('t1', redirect, ''),
        toolUse(
          'r1',
          'Read',
          {file_path: '/tmp/x/status.txt', limit: 8},
          READ_AT,
        ),
        toolResult('r1', numbered, READ_AT),
      ],
      reply: BLOCK,
    };
    expect(counts(replay([whole]))).toMatchObject({comparable: 1, newest: 1});
    expect(counts(replay([part]))).toMatchObject({
      comparable: 0,
      notComparable: 1,
    });
  });

  test('the filter that looks whole is not comparable and never counts as a pass', () => {
    const output = replay([
      {
        id: 'eeeeeeee-0000',
        records: bashRun(
          't1',
          `${STATUS} 2>&1 | sed -n '/^🛑🛑/,/^────/p' | sed -n '1,14p;/^## Questions for you/,$p'`,
          // The rule and the separator are both there, as the trap leaves them.
          TRIMMED,
        ),
        reply: TRIMMED,
      },
    ]);
    expect(counts(output)).toMatchObject({
      comparable: 0,
      newest: 0,
      notComparable: 1,
    });
    expect(output).toContain('eeeeeeee');
    expect(output).toContain(
      '1 entries, 0 with a default line, 1 pointer lines',
    );
  });

  test('a not-comparable row names the lines in no status output', () => {
    const output = replay([
      {
        id: 'ffffffff-0000',
        records: bashRun(
          't1',
          `${STATUS} | head -3`,
          BLOCK.split('\n').slice(0, 3).join('\n'),
        ),
        reply: TRIMMED,
      },
    ]);
    expect(counts(output)).toMatchObject({notComparable: 1});
    expect(output).toContain('lines in no status output of this session: ');
    expect(output).toContain('The full context is in your inbox');
  });

  test('after a filtered run, only a match counts: the live guard held a block this cannot see', () => {
    const records = [
      ...bashRun('t1', STATUS, OUTPUT),
      ...bashRun('t2', `${STATUS} | tail -3`, 'Nothing to mark.'),
    ];
    expect(
      counts(replay([{id: '22222222-0000', records, reply: TRIMMED}])),
    ).toMatchObject({comparable: 0, notComparable: 1, sentBack: 0});
    expect(
      counts(replay([{id: '33333333-0000', records, reply: BLOCK}])),
    ).toMatchObject({comparable: 1, newest: 1, notComparable: 0});
  });

  test('a reply with no status run visible is not comparable', () => {
    const output = replay([{id: '11111111-0000', records: [], reply: BLOCK}]);
    expect(counts(output)).toMatchObject({comparable: 0, notComparable: 1});
    expect(output).toContain('no status run visible before this reply');
  });

  test('--help prints and does nothing else', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JUSTIN_THREADS_STATE_DIR: '/nonexistent/state',
      },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('replay-trim-guard');
    expect(run.stdout).toContain('--since');
  });
});
