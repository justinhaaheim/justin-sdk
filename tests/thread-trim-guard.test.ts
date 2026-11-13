/**
 * The trim guard (home-base-7761p.23). The fixtures are synthetic: no real
 * session text belongs in this repo. The two trim shapes are the ones two real
 * sessions produced, cut down to their form.
 *
 * Each pass has a control that blocks once its one reason is taken away, so a row
 * that passes for the wrong reason fails here. False positives are the main risk,
 * so "could not tell" gets as much coverage as the case that blocks.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {
  statusBlocksPath,
  stopCheckLogPath,
  stopMarkPath,
} from '../src/thread/archive';
import {resolveThreadConfig} from '../src/thread/config';
import {
  isRuleLine,
  PART_ONE_RULE,
  PART_ONE_SEPARATOR,
} from '../src/thread/part-one';
import {writeBrakeState} from '../src/thread/quota-brake-state';
import {ensureSessionBead} from '../src/thread/session-bead';
import {runThreadStatus} from '../src/thread/session-report';
import {
  describeStopCheck,
  renderStopCheckStats,
  runThreadStopCheck,
} from '../src/thread/stop-check';
import {
  blockIsInReply,
  decideTrimGuard,
  nextSavedBlocks,
  normalizeBlockLine,
  normalizeText,
  readStatusBlocks,
  saveStatusBlock,
  STATUS_BLOCKS_KEPT,
  trimGuardBlockReason,
  type TrimGuardInputs,
  VOLATILE_VALUE,
} from '../src/thread/trim-guard';
import {captureWriteStdout} from './capture-stdout';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const SESSION = '5e551011-cccc-4ddd-8eee-0123456789ab';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A whole block, in the shape the tool prints it. */
function wholeBlock(
  overrides: {
    commits?: string;
    context?: string;
    lastActivity?: string;
    status?: string;
  } = {},
): string {
  return [
    PART_ONE_RULE,
    '',
    '**Session:** [HOME] A made-up session',
    '',
    '---',
    '',
    '- **Started:** Tue 2030-01-01 9:00 am',
    `- **Last activity:** ${overrides.lastActivity ?? 'Tue 2030-01-01 12:00 pm'}`,
    '',
    `* **Status:** ${overrides.status ?? '❓ Needs an answer'}`,
    '* **You need to:** **Answer question 1**',
    '',
    '---',
    '',
    '## Progress',
    '',
    '**0 of 1 request done**',
    '',
    '1. 🔲 **Make the thing** (t-1)',
    '',
    '---',
    '',
    '## Questions for you',
    '',
    '1. 🛑 P0 · [Pick a/b] **Which way should the thing go?** (t-2)',
    '',
    '',
    '   - The two ways differ in cost.',
    '',
    '',
    '   - a. (Recommended) Left — cheaper',
    '',
    '',
    '   - b. Right — faster',
    '',
    "   *If you don't answer: I stop here.*",
    '',
    '',
    '2. 🟡 P2 · [Do] **Try it on the phone** (t-3)',
    '',
    '',
    '   - Only a device can show it.',
    '',
    "   *If you don't answer: I ship it untested and say so.*",
    '',
    '---',
    '',
    '- **Repo:** home-base',
    `- **Context:** ${overrides.context ?? '100k tokens'}`,
    `- **Commits this session:** ${overrides.commits ?? '2'}`,
    '',
    '* **Resume:** `claude --resume x`',
    '* **Pane:** `cmux select-workspace --workspace y`',
    '',
    PART_ONE_SEPARATOR,
  ].join('\n');
}

const PART_TWO = '\n\n## Things you should know\n\n- A made-up note.';

/** Trim shape (a): each question cut to one line, plus a pointer to the inbox. */
const TRIM_POINTER = [
  PART_ONE_RULE,
  '',
  '**Session:** [HOME] A made-up session',
  '',
  '---',
  '',
  '- **Started:** Tue 2030-01-01 9:00 am',
  '- **Last activity:** Tue 2030-01-01 12:00 pm',
  '',
  '* **Status:** ❓ Needs an answer',
  '* **You need to:** **Answer question 1**',
  '',
  '---',
  '',
  '## Progress',
  '',
  '**0 of 1 request done**',
  '',
  '1. 🔲 **Make the thing** (t-1)',
  '',
  '---',
  '',
  '## Questions for you',
  '',
  '1. 🛑 P0 · [Pick a/b] **Which way should the thing go?** I recommend a. The full context is in your inbox (t-2).',
  '',
  '2. 🟡 P2 · [Do] **Try it on the phone** (t-3).',
  '',
  '---',
  '',
  '- **Repo:** home-base',
  '- **Context:** 100k tokens',
  '- **Commits this session:** 2',
  '',
  '* **Resume:** `claude --resume x`',
  '* **Pane:** `cmux select-workspace --workspace y`',
  '',
  PART_ONE_SEPARATOR,
].join('\n');

/**
 * Trim shape (b): every question's context, options and default cut, the repo,
 * resume and pane lines cut, and a line of its own added.
 */
const TRIM_OWN_LINE = [
  PART_ONE_RULE,
  '',
  '**Session:** [HOME] A made-up session',
  '',
  '---',
  '',
  '- **Started:** Tue 2030-01-01 9:00 am',
  '- **Last activity:** Tue 2030-01-01 12:00 pm',
  '',
  '* **Status:** ❓ Needs an answer',
  '* **You need to:** **Answer question 1**',
  '',
  '---',
  '',
  '## Questions for you',
  '',
  '1. 🛑 P0 · [Pick a/b] **Which way should the thing go?** (t-2)',
  '',
  '2. 🟡 P2 · [Do] **Try it on the phone** (t-3)',
  '',
  '(Full context and options for all three: `thread answer t-2`)',
  '',
  PART_ONE_SEPARATOR,
].join('\n');

const LEGACY_V3 = [
  '🛑'.repeat(28),
  '',
  '⚡ ✅ Work completed',
  '',
  '**You asked me to:** build a thing',
  '',
  '🕉️'.repeat(29),
].join('\n');

function saved(...texts: string[]): TrimGuardInputs['saved'] {
  return {
    blocks: texts.map((text, index) => ({
      at: `2030-01-01T10:0${index}:00.000Z`,
      text,
    })),
    kind: 'found',
    malformed: 0,
  };
}

/** The one set of inputs that blocks. Every row below is this, patched once. */
const BLOCKING: TrimGuardInputs = {
  agentId: null,
  braked: false,
  lastAssistantMessage: `${TRIM_POINTER}${PART_TWO}`,
  saved: saved(wholeBlock()),
  sessionId: SESSION,
  stopHookActive: false,
};

describe('normalizeText (D3)', () => {
  test('blank lines, indentation, the --- lines and the marker do not matter', () => {
    const noisy = wholeBlock()
      .replace(/^---$/gmu, '')
      .replace(/\n\n/gu, '\n\n\n')
      .replace(/^\* /gmu, '- ')
      .replace('**0 of 1 request done**', '  **0  of 1   request done**  ');
    expect(normalizeText(noisy).lines).toEqual(
      normalizeText(wholeBlock()).lines,
    );
    // Control: a changed word is not noise.
    expect(
      normalizeText(noisy.replace('cheaper', 'pricier')).lines,
    ).not.toEqual(normalizeText(wholeBlock()).lines);
  });

  test('any run of three or more 🛑 is the one rule line', () => {
    expect(normalizeBlockLine('🛑'.repeat(28))).toBe(PART_ONE_RULE);
    expect(normalizeBlockLine('🛑🛑🛑')).toBe(PART_ONE_RULE);
    // Control: a badge in a sentence is not a rule.
    expect(normalizeBlockLine('🛑 Blocked on you')).toBe('🛑 Blocked on you');
  });

  test('only the three volatile values go, and their lines stay', () => {
    for (const [line, label] of [
      ['- **Last activity:** Tue 2030-01-01 12:00 pm', '**Last activity:**'],
      ['- **Context:** 100k tokens', '**Context:**'],
      ['- **Commits this session:** 2', '**Commits this session:**'],
    ] as const) {
      expect(normalizeBlockLine(line)).toBe(`- ${label} ${VOLATILE_VALUE}`);
    }
    // Control: Status changes between runs too, and it is deliberately compared.
    expect(normalizeBlockLine('* **Status:** ❓ Needs an answer')).toBe(
      '- **Status:** ❓ Needs an answer',
    );
    // Deleting a volatile line is still seen.
    const deleted = wholeBlock().replace(/^- \*\*Context:.*\n/mu, '');
    expect(normalizeText(deleted).lines).not.toEqual(
      normalizeText(wholeBlock()).lines,
    );
  });
});

describe('finding the block (D4)', () => {
  test('a rule line followed by the Session field is a start, blank lines or not', () => {
    expect(normalizeText(wholeBlock()).starts).toEqual([0]);
    expect(
      normalizeText(`${PART_ONE_RULE}\n**Session:** x\n${PART_ONE_SEPARATOR}`)
        .starts,
    ).toEqual([0]);
    expect(normalizeText(`Hello.\n\n${wholeBlock()}`).starts).toEqual([1]);
  });

  test('a start inside a code fence does not count, and its control does', () => {
    const inside = `Here is one:\n\n\`\`\`\n${wholeBlock()}\n\`\`\`\n\nDone.`;
    expect(normalizeText(inside).starts).toEqual([]);
    const tildes = `~~~text\n${wholeBlock()}\n~~~`;
    expect(normalizeText(tildes).starts).toEqual([]);
    // Control: after the fence closes a start counts again.
    const after = `\`\`\`\nexample\n\`\`\`\n\n${wholeBlock()}`;
    expect(normalizeText(after).starts).toEqual([3]);
    // Inline triple backticks open nothing.
    const inline = `Use \`\`\`x\`\`\` here.\n\n${wholeBlock()}`;
    expect(normalizeText(inline).starts).toHaveLength(1);
  });

  test('a rule with no Session field after it is not a start', () => {
    expect(normalizeText(LEGACY_V3).starts).toEqual([]);
    expect(normalizeText('🛑🛑🛑\nThis is important.').starts).toEqual([]);
    expect(isRuleLine('🛑🛑🛑')).toBe(true);
  });
});

describe('blockIsInReply (D5)', () => {
  const block = normalizeText(wholeBlock()).lines;

  test('Part 2 after the block is ignored', () => {
    expect(
      blockIsInReply(block, normalizeText(`${wholeBlock()}${PART_TWO}`)),
    ).toBe(true);
  });

  test('a ─── line inside a question cannot cut the block short', () => {
    const withRule = wholeBlock().replace(
      '   - The two ways differ in cost.',
      `   - The two ways differ in cost.\n\n${PART_ONE_SEPARATOR}\n\n   - More.`,
    );
    const lines = normalizeText(withRule).lines;
    expect(blockIsInReply(lines, normalizeText(withRule))).toBe(true);
    // Control: cut the reply at that inner line, as a first-separator reader
    // would have. It no longer matches.
    const cutShort = withRule.slice(
      0,
      withRule.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length,
    );
    expect(blockIsInReply(lines, normalizeText(cutShort))).toBe(false);
  });

  test('a line added inside the block fails', () => {
    const added = wholeBlock().replace(
      '## Progress',
      '## Progress\n\nA line of my own.',
    );
    expect(blockIsInReply(block, normalizeText(added))).toBe(false);
  });

  test('a start with no separator after it fails', () => {
    const open = wholeBlock().replace(PART_ONE_SEPARATOR, '');
    expect(normalizeText(open).starts).toEqual([0]);
    expect(blockIsInReply(block, normalizeText(open))).toBe(false);
  });

  test('a run that does not begin at a start fails', () => {
    // The same lines in a fence: the run is there, the start is not.
    const fenced = `\`\`\`\n${wholeBlock()}\n\`\`\``;
    expect(blockIsInReply(block, normalizeText(fenced))).toBe(false);
  });
});

describe('decideTrimGuard', () => {
  test('the blocking inputs block, with the counts and the reason', () => {
    const decision = decideTrimGuard(BLOCKING);
    expect(decision.action).toBe('block');
    expect(decision.why).toBe('trimGuardDiffers');
    expect(decision.missing).toBeGreaterThan(0);
    expect(decision.added).toBe(2);
    expect(decision.reason).toContain('thread status');
    expect(describeStopCheck(decision)).toContain('BLOCK');
  });

  // AC3. Each row names one reason to pass. BLOCKING is its control.
  const PASSES: {
    name: string;
    patch: Partial<TrimGuardInputs>;
    why: string;
  }[] = [
    {name: 'a subagent', patch: {agentId: 'agent-7f3a'}, why: 'subagent'},
    {name: 'quota braked', patch: {braked: true}, why: 'quotaBraked'},
    {
      name: 'stop_hook_active',
      patch: {stopHookActive: true},
      why: 'stopHookActive',
    },
    {name: 'no session id', patch: {sessionId: null}, why: 'noSessionId'},
    {
      name: 'no saved file',
      patch: {saved: {kind: 'none'}},
      why: 'trimGuardNoSaved',
    },
    {
      name: 'an empty found list',
      patch: {saved: {blocks: [], kind: 'found', malformed: 0}},
      why: 'trimGuardNoSaved',
    },
    {
      name: 'an unreadable file',
      patch: {saved: {error: 'EACCES', kind: 'unknown'}},
      why: 'trimGuardUnknown',
    },
    {
      name: 'a one-line note',
      patch: {lastAssistantMessage: 'Done: the tests pass.'},
      why: 'trimGuardNoBlock',
    },
    {
      name: 'prose that mentions the block in words',
      patch: {lastAssistantMessage: 'The 🛑 line and the ──── line are fine.'},
      why: 'trimGuardNoBlock',
    },
    {
      name: 'a legacy v3 report',
      patch: {lastAssistantMessage: LEGACY_V3},
      why: 'trimGuardNoBlock',
    },
    {
      name: 'no message at all',
      patch: {lastAssistantMessage: null},
      why: 'trimGuardNoBlock',
    },
    {
      name: 'a block shown as an example in a fence',
      patch: {lastAssistantMessage: `\`\`\`\n${TRIM_POINTER}\n\`\`\``},
      why: 'trimGuardNoBlock',
    },
    {
      name: 'a whole block with Part 2',
      patch: {lastAssistantMessage: `${wholeBlock()}${PART_TWO}`},
      why: 'trimGuardMatchLatest',
    },
    {
      name: 'a whole block after other text',
      patch: {lastAssistantMessage: `Prime check.\n\n${wholeBlock()}`},
      why: 'trimGuardMatchLatest',
    },
    {
      name: 'a whole block with other blank lines',
      patch: {
        lastAssistantMessage: wholeBlock()
          .replace(/\n\n\n/gu, '\n')
          .replace(/\n\n/gu, '\n'),
      },
      why: 'trimGuardMatchLatest',
    },
    {
      name: 'the three volatile values from another run',
      patch: {
        lastAssistantMessage: wholeBlock({
          commits: '7',
          context: '300k tokens',
          lastActivity: 'Wed 2030-01-02 1:00 am',
        }),
      },
      why: 'trimGuardMatchLatest',
    },
    {
      name: 'a whole earlier block',
      patch: {
        lastAssistantMessage: wholeBlock({status: '🏃 Working'}),
        saved: saved(wholeBlock({status: '🏃 Working'}), wholeBlock()),
      },
      why: 'trimGuardMatchEarlier',
    },
    {
      name: 'a trimmed block and a whole one in one reply',
      patch: {lastAssistantMessage: `${TRIM_POINTER}\n\n${wholeBlock()}`},
      why: 'trimGuardMatchLatest',
    },
  ];
  for (const row of PASSES) {
    test(`passes: ${row.name}`, () => {
      const decision = decideTrimGuard({...BLOCKING, ...row.patch});
      expect(decision.action).toBe('pass');
      expect(decision.why).toBe(row.why as typeof decision.why);
      expect(decision.reason).toBeNull();
      expect(describeStopCheck(decision)).toStartWith('pass');
    });
  }

  test('AC6: both trim shapes are caught, whichever Part 2 follows', () => {
    for (const trim of [TRIM_POINTER, TRIM_OWN_LINE]) {
      for (const tail of ['', PART_TWO]) {
        const decision = decideTrimGuard({
          ...BLOCKING,
          lastAssistantMessage: `${trim}${tail}`,
        });
        expect(decision.action).toBe('block');
      }
    }
    const own = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: TRIM_OWN_LINE,
    });
    expect(own.added).toBe(1);
    expect(own.reason).toContain('(Full context and options');
  });

  test('a filter that keeps the rule and the separator is still caught', () => {
    // The shape a session gets from `sed -n '1,14p;/^## Questions for you/,$p'`.
    const whole = wholeBlock();
    const lines = whole.split('\n');
    const questions = lines.indexOf('## Questions for you');
    const stitched = [...lines.slice(0, 14), ...lines.slice(questions)].join(
      '\n',
    );
    const decision = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: stitched,
    });
    expect(decision.action).toBe('block');
    expect(decision.added).toBe(0);
  });

  test('a block stitched from two runs fails: Status is not volatile', () => {
    const decision = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: wholeBlock({status: '🏃 Working'}),
    });
    expect(decision.action).toBe('block');
    expect(decision.missing).toBe(1);
    expect(decision.added).toBe(1);
  });

  test('Part 2 is not counted against the block', () => {
    const decision = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: `${wholeBlock({status: '🏃 Working'})}${PART_TWO}`,
    });
    expect(decision.added).toBe(1);
    expect(decision.reason).not.toContain('A made-up note');
  });

  test('a ─── line in Part 2 does not pull Part 2 into the count', () => {
    const decision = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: `${wholeBlock({status: '🏃 Working'})}${PART_TWO}\n\n${PART_ONE_SEPARATOR}\n\nMore of my own.`,
    });
    expect(decision.action).toBe('block');
    expect(decision.added).toBe(1);
    expect(decision.reason).not.toContain('More of my own');
  });
});

describe('trimGuardBlockReason (D8)', () => {
  test('quotes up to 3 of each, cut to 120 characters, then the instruction', () => {
    const reason = trimGuardBlockReason({
      added: ['added 1', 'added 2', 'added 3', 'added 4'],
      missing: [`${'m'.repeat(200)}`, 'gone 2', 'gone 3', 'gone 4', 'gone 5'],
    });
    expect(reason).toContain('5 printed lines are missing');
    expect(reason).toContain('4 lines are ones the tool did not print');
    expect(reason).toContain(`- ${'m'.repeat(120)}…`);
    expect(reason).not.toContain('m'.repeat(121));
    expect(reason).toContain('gone 3');
    expect(reason).not.toContain('gone 4');
    expect(reason).toContain('added 3');
    expect(reason).not.toContain('added 4');
    expect(reason).toContain('bun run justin-sdk thread status');
    expect(reason).toContain('no sed, head or tail');
    expect(reason).toContain('through the line of ♒ verbatim');
    expect(reason).toContain('Do not shorten any question');
  });

  test('says so when the lines are all there and the order is not', () => {
    const lines = wholeBlock().split('\n');
    const repo = lines.indexOf('- **Repo:** home-base');
    const resume = lines.indexOf('* **Resume:** `claude --resume x`');
    const swapped = lines.map((line, index) =>
      index === repo
        ? (lines[resume] ?? '')
        : index === resume
          ? (lines[repo] ?? '')
          : line,
    );
    const decision = decideTrimGuard({
      ...BLOCKING,
      lastAssistantMessage: swapped.join('\n'),
    });
    expect(decision.action).toBe('block');
    expect(decision.missing).toBe(0);
    expect(decision.added).toBe(0);
    expect(decision.reason).toContain('in a different order');
    expect(decision.reason).not.toContain('printed line');
  });
});

// ---------------------------------------------------------------------------
// The saved file
// ---------------------------------------------------------------------------

function stateEnv(): Record<string, string | undefined> {
  const state = track(createSandbox());
  return {JUSTIN_THREADS_STATE_DIR: state.path};
}

describe('saved blocks (D2, D6)', () => {
  test('a save writes {at, text} and leaves no temp file', () => {
    const env = stateEnv();
    expect(
      saveStatusBlock({at: NOW, env, sessionId: SESSION, text: wholeBlock()})
        .kind,
    ).toBe('saved');
    const path = statusBlocksPath(SESSION, env);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      at: NOW.toISOString(),
      text: wholeBlock(),
    });
    expect(readdirSync(dirname(path))).toEqual([`${SESSION}.jsonl`]);
  });

  test('the same text after normalizing is not written twice', () => {
    const env = stateEnv();
    saveStatusBlock({at: NOW, env, sessionId: SESSION, text: wholeBlock()});
    const again = saveStatusBlock({
      at: new Date(NOW.getTime() + 5000),
      env,
      sessionId: SESSION,
      text: wholeBlock({context: '101k tokens'}),
    });
    expect(again.kind).toBe('unchanged');
    // Control: a change that counts is written.
    const changed = saveStatusBlock({
      at: NOW,
      env,
      sessionId: SESSION,
      text: wholeBlock({status: '🏃 Working'}),
    });
    expect(changed.kind).toBe('saved');
    const read = readStatusBlocks(SESSION, env);
    expect(read.kind === 'found' ? read.blocks.length : -1).toBe(2);
  });

  test('keeps the newest 20', () => {
    let blocks = nextSavedBlocks([], {at: 'a', text: wholeBlock()}) ?? [];
    for (let run = 0; run < STATUS_BLOCKS_KEPT + 5; run += 1) {
      blocks =
        nextSavedBlocks(blocks, {
          at: `run ${run}`,
          text: wholeBlock({status: `run ${run}`}),
        }) ?? blocks;
    }
    expect(blocks).toHaveLength(STATUS_BLOCKS_KEPT);
    expect(blocks.at(-1)?.at).toBe(`run ${STATUS_BLOCKS_KEPT + 4}`);
    expect(blocks[0]?.at).toBe('run 5');
  });

  test('a failed save is an outcome, not a throw', () => {
    const env = stateEnv();
    const dir = dirname(statusBlocksPath(SESSION, env));
    mkdirSync(dirname(dir), {recursive: true});
    writeFileSync(dir, 'a file where the directory goes');
    const outcome = saveStatusBlock({
      at: NOW,
      env,
      sessionId: SESSION,
      text: wholeBlock(),
    });
    expect(outcome.kind).toBe('failed');
  });

  test('no file and an empty file are none; each has its own answer', () => {
    const env = stateEnv();
    expect(readStatusBlocks(SESSION, env)).toEqual({kind: 'none'});
    const path = statusBlocksPath(SESSION, env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, '\n\n');
    expect(readStatusBlocks(SESSION, env)).toEqual({kind: 'none'});
  });

  test('an unreadable file, or no parseable line, is unknown', () => {
    const env = stateEnv();
    const path = statusBlocksPath(SESSION, env);
    mkdirSync(path, {recursive: true});
    expect(readStatusBlocks(SESSION, env).kind).toBe('unknown');

    const other = stateEnv();
    const second = statusBlocksPath(SESSION, other);
    mkdirSync(dirname(second), {recursive: true});
    writeFileSync(
      second,
      `not json\n${JSON.stringify({at: 'x', text: 'no block in this'})}\n`,
    );
    expect(readStatusBlocks(SESSION, other).kind).toBe('unknown');
  });

  test('malformed lines are skipped and counted, never read as text', () => {
    const env = stateEnv();
    const path = statusBlocksPath(SESSION, env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      [
        'not json',
        JSON.stringify({at: 'a', text: TRIM_POINTER}),
        JSON.stringify({text: wholeBlock()}),
        JSON.stringify({at: 'b', text: 42}),
        '',
      ].join('\n'),
    );
    const read = readStatusBlocks(SESSION, env);
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') return;
    expect(read.malformed).toBe(3);
    expect(read.blocks.map((block) => block.at)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// The Stop hook, in process
// ---------------------------------------------------------------------------

interface HookFixture {
  env: Record<string, string | undefined>;
  project: Sandbox;
  transcriptPath: string;
}

function hookFixture(thread: Record<string, unknown>): HookFixture {
  const project = track(
    createProjectSandbox({
      justinSdkConfig: {componentConfig: {thread}},
    }),
  );
  const state = track(createSandbox());
  const xdg = track(createSandbox());
  const transcripts = track(createSandbox());
  const projectDir = join(transcripts.path, '-tmp-scratch');
  mkdirSync(projectDir, {recursive: true});
  const transcriptPath = join(projectDir, `${SESSION}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      message: {content: 'wrap up please', role: 'user'},
      timestamp: '2029-12-31T10:00:00.000Z',
      type: 'user',
    })}\n`,
  );
  return {
    env: {
      HOME: project.path,
      JUSTIN_THREADS_STATE_DIR: state.path,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: transcripts.path,
      XDG_CONFIG_HOME: xdg.path,
    },
    project,
    transcriptPath,
  };
}

function runStop(
  fixture: HookFixture,
  overrides: Record<string, unknown> = {},
): {err: string; out: string; result: ReturnType<typeof runThreadStopCheck>} {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    const result = runThreadStopCheck({
      env: fixture.env,
      now: NOW,
      stdin: JSON.stringify({
        cwd: fixture.project.path,
        hook_event_name: 'Stop',
        last_assistant_message: `${TRIM_POINTER}${PART_TWO}`,
        prompt_id: 'c0ffee00-1111-2222-3333-444444444444',
        session_id: SESSION,
        transcript_path: fixture.transcriptPath,
        ...overrides,
      }),
    });
    return {err: err.join('\n'), out: out.join('\n'), result};
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function saveWhole(fixture: HookFixture): void {
  saveStatusBlock({
    at: NOW,
    env: fixture.env,
    sessionId: SESSION,
    text: wholeBlock(),
  });
}

function logLines(fixture: HookFixture): Record<string, unknown>[] {
  return readFileSync(stopCheckLogPath(fixture.env), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runThreadStopCheck with trimGuard on', () => {
  test('sends a trim back once, with enforce off, and the second Stop passes', () => {
    const fixture = hookFixture({enforce: false, trimGuard: true});
    saveWhole(fixture);

    const first = runStop(fixture);
    expect(first.result.exitCode).toBe(2);
    expect(first.result.decision.why).toBe('trimGuardDiffers');
    expect(first.err).toContain('differs from what');
    const json = JSON.parse(first.out) as {
      decision: string;
      reason: string;
      systemMessage: string;
    };
    expect(json.decision).toBe('block');
    expect(json.reason).toBe(first.err);

    // The next Stop of the turn, as Claude Code sends it.
    const second = runStop(fixture, {stop_hook_active: true});
    expect(second.result.exitCode).toBe(0);
    expect(second.result.decision.why).toBe('stopHookActive');

    // And without Claude Code's flag: the marker alone holds.
    const third = runStop(fixture);
    expect(third.result.exitCode).toBe(0);
    expect(third.result.decision.why).toBe('markerPresent');

    // Control: another turn is a new turn.
    const nextTurn = runStop(fixture, {prompt_id: 'another-prompt'});
    expect(nextTurn.result.exitCode).toBe(2);
  });

  test('a block logs its counts; other lines carry no new keys', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    runStop(fixture);
    runStop(fixture, {last_assistant_message: wholeBlock()});
    const [block, pass] = logLines(fixture);
    expect(block?.why).toBe('trimGuardDiffers');
    expect(block?.action).toBe('block');
    expect(block?.missing).toBeGreaterThan(0);
    expect(block?.added).toBe(2);
    expect(pass?.why).toBe('trimGuardMatchLatest');
    expect(pass).not.toContainKey('missing');
    expect(pass).not.toContainKey('added');
  });

  test('--stats shows the guard’s why values', () => {
    const fixture = hookFixture({trimGuard: true});
    runStop(fixture);
    saveWhole(fixture);
    runStop(fixture);
    runStop(fixture, {
      last_assistant_message: wholeBlock(),
      prompt_id: 'turn-2',
    });
    runStop(fixture, {last_assistant_message: 'Done.', prompt_id: 'turn-3'});
    const path = stopCheckLogPath(fixture.env);
    const stats = renderStopCheckStats(readFileSync(path, 'utf8'), path, false);
    for (const why of [
      'trimGuardNoSaved',
      'trimGuardDiffers',
      'trimGuardMatchLatest',
      'trimGuardNoBlock',
    ]) {
      expect(stats).toContain(why);
    }
  });

  test('AC3: no saved file passes with its own why', () => {
    const fixture = hookFixture({trimGuard: true});
    const run = runStop(fixture);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('trimGuardNoSaved');
  });

  test('AC3: an unreadable file passes with its own why', () => {
    const fixture = hookFixture({trimGuard: true});
    mkdirSync(statusBlocksPath(SESSION, fixture.env), {recursive: true});
    const run = runStop(fixture);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('trimGuardUnknown');
  });

  test('AC3: a subagent passes with its own why, and writes no marker', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    const run = runStop(fixture, {agent_id: 'agent-7f3a'});
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('subagent');
    expect(
      existsSync(
        stopMarkPath(
          SESSION,
          'c0ffee00-1111-2222-3333-444444444444',
          fixture.env,
        ),
      ),
    ).toBe(false);
  });

  test('AC3: a braked session passes, read for the guard with enforce off', () => {
    const fixture = hookFixture({enforce: false, trimGuard: true});
    saveWhole(fixture);
    writeBrakeState(
      {
        attendance: 'attended',
        attendedUntilMs: null,
        computedAtMs: NOW.getTime(),
        latestTypedAt: null,
        limitText: 'week',
        mode: 'enforce',
        sessionId: SESSION,
        state: 'braked',
        transcriptPath: null,
        transcriptSize: null,
        unattendedWeekPercent: null,
        verdict: 'a made-up verdict',
        version: 1,
      },
      fixture.env,
    );
    const run = runStop(fixture);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('quotaBraked');
  });

  test('AC3: stop_hook_active passes with its own why', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    const run = runStop(fixture, {stop_hook_active: true});
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('stopHookActive');
  });

  test('AC3: a marker that cannot be written passes, never a repeatable block', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    const marks = dirname(stopMarkPath(SESSION, 'x', fixture.env));
    writeFileSync(marks, 'a file where the directory goes');
    const run = runStop(fixture);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('markerWriteFailed');
    expect(run.out).toBe('');
    expect(run.err).toContain('not blocking');
  });

  test('no prompt_id: the key is his last message, read only after a difference', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    const blocked = runStop(fixture, {prompt_id: null});
    expect(blocked.result.exitCode).toBe(2);
    const again = runStop(fixture, {prompt_id: null});
    expect(again.result.decision.why).toBe('markerPresent');

    // A match never needs the transcript, so a missing one cannot matter.
    const match = runStop(fixture, {
      last_assistant_message: wholeBlock(),
      prompt_id: null,
      transcript_path: join(fixture.project.path, 'no-such.jsonl'),
    });
    expect(match.result.decision.why).toBe('trimGuardMatchLatest');
  });

  test('no prompt_id and no readable message: no key, so it passes', () => {
    const fixture = hookFixture({trimGuard: true});
    saveWhole(fixture);
    const run = runStop(fixture, {
      prompt_id: null,
      transcript_path: join(fixture.project.path, 'no-such.jsonl'),
    });
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('lastUserMessageUnknown');
  });

  test('D7: with enforce on, the old block stands and shares the one marker', () => {
    const fixture = hookFixture({
      enforce: true,
      enforceMode: 'reportShaped',
      trimGuard: true,
    });
    saveWhole(fixture);
    const report = `${TRIM_POINTER}\n\n${'🕉️'.repeat(29)}`;
    const first = runStop(fixture, {last_assistant_message: report});
    expect(first.result.exitCode).toBe(2);
    expect(first.result.decision.why).toBe('notRecorded');
    // The old check's marker also ends the guard's turn: one block per turn.
    const second = runStop(fixture, {last_assistant_message: report});
    expect(second.result.exitCode).toBe(0);
    expect(second.result.decision.why).toBe('markerPresent');
  });
});

describe('with the knob off (the default)', () => {
  test('config: the schema lists it and the resolved default is false', () => {
    const fixture = hookFixture({});
    const config = resolveThreadConfig({
      cwd: fixture.project.path,
      env: fixture.env,
    });
    expect(config.trimGuard).toBe(false);
    expect(config.trimGuardSource).toBe('default');
    const on = hookFixture({trimGuard: true});
    const resolved = resolveThreadConfig({
      cwd: on.project.path,
      env: on.env,
    });
    expect(resolved.trimGuard).toBe(true);
    expect(resolved.trimGuardSource).toBe('project');
    const schema = spawnSync(process.execPath, [CLI, 'config', 'schema'], {
      encoding: 'utf8',
      env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
    });
    expect(schema.status).toBe(0);
    expect(schema.stdout).toMatch(
      /componentConfig\.thread\.trimGuard\s+boolean\s+·\s+default false/u,
    );
  });

  test('a trim passes as knobOff, and the log line has the old keys only', () => {
    const fixture = hookFixture({});
    saveWhole(fixture);
    const run = runStop(fixture);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.decision.why).toBe('knobOff');
    expect(run.out).toBe('');
    expect(run.err).toBe('');
    expect(Object.keys(logLines(fixture)[0] ?? {})).toEqual([
      'action',
      'at',
      'cwd',
      'mode',
      'sessionId',
      'turnCommits',
      'turnMinutes',
      'why',
    ]);
  });
});

// ---------------------------------------------------------------------------
// `thread status` and the save, through the real CLI
// ---------------------------------------------------------------------------

interface StatusWorld {
  env: Record<string, string | undefined>;
  repo: string;
}

function statusWorld(knobs: Record<string, unknown>): StatusWorld {
  needBr();
  const sb = track(createSandbox());
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {enabled: true, sessionBeads: true, ...knobs},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    // An empty chores dir (home-base-1rxt0.10): no Jobs line from this Mac's
    // real health file in the status block.
    CHORES_STATE_DIR: join(sb.path, 'chores-state'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    VITALS_STATE_DIR: join(sb.path, 'vitals-state'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'status-repo', {'README.md': '# status\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: NOW.toISOString(), text: 'Look at the export'},
    now: NOW,
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') {
    throw new Error(`session bead not filed: ${filed.detail}`);
  }
  // A transcript, as every real session has (home-base-1rxt0.4): without one,
  // a second `thread status` cannot tell this turn's reports from earlier
  // ones and says so in its block, so two runs of the same state differ.
  const transcriptDir = join(sb.path, 'projects', 'status-repo');
  mkdirSync(transcriptDir, {recursive: true});
  writeFileSync(
    join(transcriptDir, `${SESSION}.jsonl`),
    `${JSON.stringify({
      cwd: repo,
      message: {content: 'Look at the export', role: 'user'},
      sessionId: SESSION,
      timestamp: NOW.toISOString(),
      type: 'user',
    })}\n`,
  );
  return {env, repo};
}

function cliEnv(
  w: StatusWorld,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      ...w.env,
      ...extra,
      FORCE_COLOR: undefined,
      NO_COLOR: '1',
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );
}

function status(
  w: StatusWorld,
  extraArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): {code: number | null; err: string; out: string} {
  const run = spawnSync(
    process.execPath,
    [CLI, 'thread', 'status', ...extraArgs],
    {
      cwd: w.repo,
      encoding: 'utf8',
      env: cliEnv(w, extraEnv),
    },
  );
  return {code: run.status, err: run.stderr, out: run.stdout};
}

/** The Part 1 block of a run's output, as printed. */
function printedBlock(out: string): string {
  const start = out.indexOf(PART_ONE_RULE);
  const end = out.indexOf(PART_ONE_SEPARATOR) + PART_ONE_SEPARATOR.length;
  return out.slice(start, end);
}

function savedTexts(w: StatusWorld): string[] {
  const read = readStatusBlocks(SESSION, w.env);
  return read.kind === 'found' ? read.blocks.map((block) => block.text) : [];
}

describe('thread status and the save (D2)', () => {
  test('knob on: the saved text is exactly the block it printed', () => {
    const w = statusWorld({trimGuard: true});
    const run = status(w);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(savedTexts(w)).toEqual([printedBlock(run.out)]);
    // The whole loop: a paste of what was printed passes the real comparison.
    const decision = decideTrimGuard({
      agentId: null,
      braked: false,
      lastAssistantMessage: `${printedBlock(run.out)}${PART_TWO}`,
      saved: readStatusBlocks(SESSION, w.env),
      sessionId: SESSION,
      stopHookActive: false,
    });
    expect(decision.why).toBe('trimGuardMatchLatest');
  });

  test('AC4: knob off: no file, and the same output', () => {
    const off = statusWorld({});
    const run = status(off);
    expect(run.code).toBe(0);
    expect(run.out).toContain(PART_ONE_RULE);
    expect(existsSync(statusBlocksPath(SESSION, off.env))).toBe(false);
    expect(existsSync(dirname(statusBlocksPath(SESSION, off.env)))).toBe(false);
  });

  test('AC5: a closed pipe does not lose the save', () => {
    const w = statusWorld({trimGuard: true});
    const piped = spawnSync(
      'sh',
      ['-c', `"${process.execPath}" "${CLI}" thread status | head -1`],
      {cwd: w.repo, encoding: 'utf8', env: cliEnv(w)},
    );
    expect(piped.stdout.trim()).toBe('SESSION BEADS: ENABLED');
    const whole = status(w);
    const texts = savedTexts(w);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(PART_ONE_RULE);
    expect(texts[0]).toContain(PART_ONE_SEPARATOR);
    expect(normalizeText(texts[0] ?? '').lines).toEqual(
      normalizeText(printedBlock(whole.out)).lines,
    );
  });

  test('D2: the file is on disk before the first byte is printed', async () => {
    const w = statusWorld({trimGuard: true});
    const path = statusBlocksPath(SESSION, w.env);
    const onDiskAtEachWrite: boolean[] = [];
    const spy = captureWriteStdout(() => {
      onDiskAtEachWrite.push(existsSync(path));
    });
    try {
      await runThreadStatus({
        cwd: w.repo,
        env: w.env,
        sessionId: null,
        style: {color: false, width: null},
      });
    } finally {
      spy.mockRestore();
    }
    expect(onDiskAtEachWrite.length).toBeGreaterThan(0);
    expect(onDiskAtEachWrite[0]).toBe(true);
  });

  test('AC5: a pipe already closed when it prints does not lose the save', () => {
    const w = statusWorld({trimGuard: true});
    // `head -1` often closes after the one write has landed, so a save placed
    // after the print could survive it. `true` has gone before the print.
    spawnSync(
      'sh',
      ['-c', `"${process.execPath}" "${CLI}" thread status | true`],
      {cwd: w.repo, encoding: 'utf8', env: cliEnv(w)},
    );
    const texts = savedTexts(w);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(PART_ONE_SEPARATOR);
  });

  test('AC5: a failed save changes neither the output nor the exit code', () => {
    const w = statusWorld({trimGuard: true});
    const clean = statusWorld({});
    const dir = dirname(statusBlocksPath(SESSION, w.env));
    mkdirSync(dirname(dir), {recursive: true});
    writeFileSync(dir, 'a file where the directory goes');
    const run = status(w);
    const control = status(clean);
    expect(run.code).toBe(0);
    expect(run.err.trim().split('\n')).toHaveLength(1);
    expect(run.err).toContain('could not save this block');
    expect(run.out).toContain(PART_ONE_SEPARATOR);
    expect(printedBlock(run.out).split('\n').length).toBe(
      printedBlock(control.out).split('\n').length,
    );
  });

  test('a run for another session saves nothing; its own session id does', () => {
    const w = statusWorld({trimGuard: true});
    const other = status(w, ['--session', SESSION], {
      CLAUDE_CODE_SESSION_ID: '11111111-1111-4111-8111-111111111111',
    });
    expect(other.code).toBe(0);
    expect(other.out).toContain(PART_ONE_RULE);
    expect(existsSync(statusBlocksPath(SESSION, w.env))).toBe(false);
    expect(
      existsSync(
        statusBlocksPath('11111111-1111-4111-8111-111111111111', w.env),
      ),
    ).toBe(false);
    // Control: the same run from the session itself saves.
    expect(status(w, ['--session', SESSION]).code).toBe(0);
    expect(savedTexts(w)).toHaveLength(1);
  });

  test('`thread show` saves nothing', () => {
    const w = statusWorld({trimGuard: true});
    const run = spawnSync(process.execPath, [CLI, 'thread', 'show'], {
      cwd: w.repo,
      encoding: 'utf8',
      env: cliEnv(w),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(PART_ONE_RULE);
    expect(existsSync(statusBlocksPath(SESSION, w.env))).toBe(false);
  });

  test('on a TTY it prints ANSI and saves markdown', async () => {
    const w = statusWorld({trimGuard: true});
    const printed: string[] = [];
    const spy = captureWriteStdout((text) => printed.push(text));
    let code: number;
    try {
      code = await runThreadStatus({
        cwd: w.repo,
        env: w.env,
        sessionId: null,
        style: {color: true, width: 100},
        timeZone: 'UTC',
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(printed.join('')).toContain('\u001b[');
    const texts = savedTexts(w);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain('\u001b[');
    // It is the form a session pastes, so a piped run of the same state matches.
    expect(normalizeText(texts[0] ?? '').lines).toEqual(
      normalizeText(printedBlock(status(w, [], {TZ: 'UTC'}).out)).lines,
    );
  });
});

// ---------------------------------------------------------------------------
// The real dispatcher (AC1, D12)
// ---------------------------------------------------------------------------

describe('hook Stop through the real dispatcher', () => {
  test('a trim exits 2 with the reason on stderr, and the second Stop passes', () => {
    needBr();
    const project = track(
      createProjectSandbox({
        justinSdkConfig: {
          componentConfig: {
            thread: {capture: false, enforce: false, trimGuard: true},
          },
          components: ['thread-hooks-setup'],
          hooks: {dispatch: true},
        },
      }),
    );
    const state = track(createSandbox());
    const xdg = track(createSandbox());
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        CLAUDE_PROJECT_DIR: project.path,
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        JUSTIN_THREADS_STATE_DIR: state.path,
        XDG_CONFIG_HOME: xdg.path,
      }).filter((entry): entry is [string, string] => entry[1] != null),
    );
    saveStatusBlock({at: NOW, env, sessionId: SESSION, text: wholeBlock()});
    const fire = (overrides: Record<string, unknown>) =>
      spawnSync(process.execPath, [CLI, 'hook', 'Stop'], {
        cwd: project.path,
        encoding: 'utf8',
        env,
        input: JSON.stringify({
          cwd: project.path,
          hook_event_name: 'Stop',
          last_assistant_message: `${TRIM_POINTER}${PART_TWO}`,
          prompt_id: 'c0ffee00-1111-2222-3333-444444444444',
          session_id: SESSION,
          stop_hook_active: false,
          ...overrides,
        }),
      });

    const first = fire({});
    expect(first.status).toBe(2);
    expect(first.stderr).toContain('differs from what');
    expect(first.stderr).toContain('no sed, head or tail');

    const second = fire({stop_hook_active: true});
    expect(second.status).toBe(0);

    // Control: a whole block in another turn is not sent back either.
    const whole = fire({
      last_assistant_message: wholeBlock(),
      prompt_id: 'another-turn',
    });
    expect(whole.status).toBe(0);

    const whys = readFileSync(stopCheckLogPath(env), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as {why: string}).why);
    expect(whys).toEqual([
      'trimGuardDiffers',
      'stopHookActive',
      'trimGuardMatchLatest',
    ]);
  });
});
