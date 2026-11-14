/**
 * Chain names (home-base-l2ejg.11, D5 in home-base-l2ejg.3): the pool, the
 * spellings, the machine-wide registry and the name in a session's title. The
 * fixtures are synthetic; every registry lives in the test's own $TMPDIR
 * sandbox. The capture's self-heal over a real br is tested in
 * thread-workspace-name.test.ts, and a real handed-off chain in
 * thread-handoff-number.test.ts.
 *
 * Controls: the race test fails without the lock (every child gets the first
 * pool name), and the registry failure tests fail when a line that does not
 * parse is skipped instead of failing the read.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  chainNameLabel,
  chainNameOfLabels,
  chainNameText,
  parseChainName,
  romanNumeral,
} from '../src/thread/chain-name';
import {CHAIN_NAME_POOL} from '../src/thread/chain-name-pool';
import {
  chainNameForRoot,
  chainNamesPath,
  readChainNames,
  registryChainNamer,
} from '../src/thread/chain-names';
import {continuationLabels, successorMarks} from '../src/thread/handoff-number';
import {handoffSummary} from '../src/thread/handoff-summary';
import {
  carriesSessionMarks,
  parseSessionName,
  sessionDisplayName,
  sessionMarksOf,
  sessionNameParts,
} from '../src/thread/session-name';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function stateEnv(): Record<string, string | undefined> {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
}

const SMALL_POOL = ['Ann', 'Bob', 'Cat'];
const first = () => 0;

describe('the pool', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'thread', 'chain-name-pool.ts'),
    'utf8',
  );

  test('at least 80 names, each one word of letters, a capital first, at most 8 characters', () => {
    expect(CHAIN_NAME_POOL.length).toBeGreaterThanOrEqual(80);
    for (const name of CHAIN_NAME_POOL) {
      expect(name).toMatch(/^[A-Z][a-z]{1,7}$/u);
    }
  });

  test('no two names share their first three letters', () => {
    const starts = new Map<string, string>();
    for (const name of CHAIN_NAME_POOL) {
      const start = name.slice(0, 3).toLowerCase();
      expect(
        `${name} shares "${start}" with ${starts.get(start) ?? 'none'}`,
      ).toBe(`${name} shares "${start}" with none`);
      starts.set(start, name);
    }
  });

  test('every entry names a season from 1 to 9 and an episode, in a comment', () => {
    const entries = source
      .split('\n')
      .filter((line) => /^\s*'[A-Za-z]+',/u.test(line));
    expect(entries).toHaveLength(CHAIN_NAME_POOL.length);
    for (const line of entries) {
      expect(line).toMatch(/\/\/ .*season [1-9], ".+"$/u);
    }
  });

  test('every name reads back as itself, and as the tool`s', () => {
    for (const name of CHAIN_NAME_POOL) {
      expect(parseChainName(name)).toEqual({base: name, generation: 1});
    }
  });
});

describe('the spellings', () => {
  test('text, label and generation', () => {
    expect(chainNameText({base: 'Moe', generation: 1})).toBe('Moe');
    expect(chainNameText({base: 'Moe', generation: 2})).toBe('Moe II');
    expect(chainNameLabel({base: 'Moe', generation: 1})).toBe('chain:Moe');
    expect(chainNameLabel({base: 'Moe', generation: 14})).toBe('chain:Moe_XIV');
    expect(romanNumeral(1999)).toBe('MCMXCIX');
  });

  test('both spellings parse; anything else does not', () => {
    expect(parseChainName('Moe II')).toEqual({base: 'Moe', generation: 2});
    expect(parseChainName('Moe_XIV')).toEqual({base: 'Moe', generation: 14});
    for (const text of [
      'Moe I',
      'Moe IIII',
      'Notes',
      'moe',
      'Moe 2',
      'Moe-2',
    ]) {
      expect(parseChainName(text)).toBeNull();
    }
  });

  test('a label stays inside br`s limit: 50 characters of [A-Za-z0-9_:-]', () => {
    for (const base of CHAIN_NAME_POOL) {
      const label = chainNameLabel({base, generation: 388});
      expect(label).toMatch(/^[A-Za-z0-9_:-]{1,50}$/u);
    }
  });

  test('the labels: none, one (the same label twice is one), two different, or not a name', () => {
    expect(chainNameOfLabels(['session'])).toEqual({kind: 'none'});
    expect(chainNameOfLabels(['chain:Moe_II', 'chain:Moe_II'])).toEqual({
      kind: 'one',
      name: {base: 'Moe', generation: 2},
    });
    expect(chainNameOfLabels(['chain:Moe', 'chain:Apu'])).toMatchObject({
      kind: 'unreadable',
    });
    expect(chainNameOfLabels(['chain:Notes'])).toMatchObject({
      kind: 'unreadable',
    });
  });
});

describe('the registry', () => {
  test('every chain gets a name no other chain has had, then generation II, then III', () => {
    const env = stateEnv();
    const names = Array.from({length: 7}, (_, index) => {
      const outcome = chainNameForRoot({
        env,
        pool: SMALL_POOL,
        random: first,
        root: `t-root${index}`,
      });
      if (outcome.kind !== 'assigned') throw new Error(JSON.stringify(outcome));
      return chainNameText(outcome.name);
    });
    expect(names).toEqual([
      'Ann',
      'Bob',
      'Cat',
      'Ann II',
      'Bob II',
      'Cat II',
      'Ann III',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test('a chain asked again gets the name it has, and nothing is appended', () => {
    const env = stateEnv();
    const given = chainNameForRoot({env, pool: SMALL_POOL, root: 't-a'});
    const before = readFileSync(chainNamesPath(env), 'utf8');
    const again = chainNameForRoot({env, pool: SMALL_POOL, root: 't-a'});
    expect(again.kind).toBe('found');
    expect(again.kind !== 'failed' && given.kind !== 'failed').toBe(true);
    if (again.kind === 'failed' || given.kind === 'failed') return;
    expect(again.name).toEqual(given.name);
    expect(readFileSync(chainNamesPath(env), 'utf8')).toBe(before);
  });

  test('the pick is random among the free names', () => {
    const env = stateEnv();
    const outcome = chainNameForRoot({
      env,
      pool: SMALL_POOL,
      random: () => 0.99,
      root: 't-x',
    });
    expect(outcome).toMatchObject({name: {base: 'Cat', generation: 1}});
  });

  test('a registry namer remembers for the run, and the look-up-only one hands out nothing', () => {
    const env = stateEnv();
    const lookOnly = registryChainNamer(env, {assign: false});
    expect(lookOnly.nameFor('t-a')).toMatchObject({kind: 'failed'});
    expect(existsSync(chainNamesPath(env))).toBe(false);
    const namer = registryChainNamer(env);
    const given = namer.nameFor('t-a');
    expect(given.kind).toBe('assigned');
    expect(namer.nameFor('t-a')).toMatchObject({kind: 'found'});
    if (given.kind === 'failed') throw new Error(given.reason);
    expect(registryChainNamer(env, {assign: false}).nameFor('t-a')).toEqual({
      kind: 'found',
      name: given.name,
    });
  });
});

describe('failure is not empty: no name is handed out, and the file is left as it was', () => {
  test('a line that does not parse could hold a name, so it fails the read', () => {
    const env = stateEnv();
    chainNameForRoot({env, pool: SMALL_POOL, root: 't-a'});
    appendFileSync(chainNamesPath(env), '{"root": "t-b", "na\n');
    const before = readFileSync(chainNamesPath(env), 'utf8');
    const outcome = chainNameForRoot({env, pool: SMALL_POOL, root: 't-c'});
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'line 2 is not JSON',
    );
    expect(readFileSync(chainNamesPath(env), 'utf8')).toBe(before);
    expect(readChainNames(env, SMALL_POOL)).toMatchObject({kind: 'failed'});
  });

  test('a line holding a name outside the pool fails the read', () => {
    const env = stateEnv();
    mkdirSync(join(env.JUSTIN_THREADS_STATE_DIR ?? '', ''), {recursive: true});
    writeFileSync(
      chainNamesPath(env),
      `${JSON.stringify({assignedAt: '', name: 'Zed', root: 't-a'})}\n`,
    );
    expect(
      chainNameForRoot({env, pool: SMALL_POOL, root: 't-b'}),
    ).toMatchObject({kind: 'failed'});
  });

  test('a registry that cannot be read', () => {
    const env = stateEnv();
    mkdirSync(chainNamesPath(env), {recursive: true});
    expect(chainNameForRoot({env, root: 't-a'})).toMatchObject({
      kind: 'failed',
    });
  });

  test('a lock that stays held', () => {
    const env = stateEnv();
    const dir = env.JUSTIN_THREADS_STATE_DIR ?? '';
    mkdirSync(dir, {recursive: true});
    // Held by this very process, which is alive, so it is never stolen.
    writeFileSync(join(dir, 'chain-names.lock'), String(process.pid));
    const outcome = chainNameForRoot({env, pool: SMALL_POOL, root: 't-a'});
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'stayed held',
    );
    expect(existsSync(chainNamesPath(env))).toBe(false);
  });
});

describe('the lock: racing chains never share a name', () => {
  test('four processes naming four chains at the same moment get four different names', async () => {
    const env = stateEnv();
    const child = join(import.meta.dirname, 'fixtures', 'chain-name-child.ts');
    // Each child holds the lock 150 ms between its read and its append, and
    // always picks the first free name, so without the lock all four read an
    // empty registry and pick "Ann".
    const startAt = Date.now() + 1500;
    const childEnv = Object.fromEntries(
      Object.entries({...process.env, ...env}).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    const runs = ['t-a', 't-b', 't-c', 't-d'].map((root) =>
      Bun.spawn(
        [
          process.execPath,
          child,
          String(startAt),
          '150',
          root,
          SMALL_POOL.slice(0, 2).join(','),
        ],
        {env: childEnv, stderr: 'pipe', stdout: 'pipe'},
      ),
    );
    const outcomes = await Promise.all(
      runs.map(async (run) => {
        const text = await new Response(run.stdout).text();
        expect(await run.exited).toBe(0);
        return JSON.parse(text) as {
          kind: string;
          name?: {base: string; generation: number};
        };
      }),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'assigned',
      'assigned',
      'assigned',
      'assigned',
    ]);
    const names = outcomes.map((outcome) =>
      outcome.name == null ? '' : chainNameText(outcome.name),
    );
    expect([...names].sort()).toEqual(['Ann', 'Ann II', 'Bob', 'Bob II']);
  }, 15_000);
});

describe('the name in a title: [TAG][Name-N]', () => {
  test('the builder: name and number share one bracket', () => {
    const shown = (marks: Parameters<typeof sessionDisplayName>[2]) =>
      sessionDisplayName('HOME', 'fix it', marks);
    expect(shown({chain: 'Moe', handoff: 10, mayor: true})).toBe(
      '[MAYOR][HOME][Moe-10] fix it',
    );
    expect(shown({chain: 'Moe II', handoff: 3, mayor: false})).toBe(
      '[HOME][Moe II-3] fix it',
    );
    expect(shown({chain: 'Moe', handoff: 'unknown', mayor: false})).toBe(
      '[HOME][Moe-?] fix it',
    );
    expect(shown({chain: 'Moe', handoff: null, mayor: false})).toBe(
      '[HOME][Moe] fix it',
    );
    // No name: exactly as before chain names.
    expect(shown({chain: null, handoff: 7, mayor: true})).toBe(
      '[MAYOR][HOME][#7] fix it',
    );
    expect(shown({handoff: null, mayor: false})).toBe('[HOME] fix it');
    // The dashboard colours the tag alone: the name is in `after`.
    expect(
      sessionNameParts('HOME', 'fix it', {
        chain: 'Moe',
        handoff: 2,
        mayor: false,
      }),
    ).toEqual({after: '[Moe-2] fix it', before: '', tag: '[HOME]'});
  });

  test('the parser reads back every name the builder writes', () => {
    for (const marks of [
      {chain: 'Moe', handoff: 10, mayor: true},
      {chain: 'Moe II', handoff: 3, mayor: false},
      {chain: 'Moe', handoff: 'unknown' as const, mayor: false},
      {chain: 'Moe', handoff: null, mayor: false},
    ]) {
      const name = sessionDisplayName('HOME', 'fix it', marks);
      expect(parseSessionName(name)).toEqual({
        marks,
        repoTag: 'HOME',
        spelling: 'current',
        text: 'fix it',
      });
      expect(carriesSessionMarks(name)).toBe(true);
    }
  });

  test('every older spelling still parses, with no name', () => {
    expect(parseSessionName('[MAYOR][HOME][#7] fix it')).toEqual({
      marks: {handoff: 7, mayor: true},
      repoTag: 'HOME',
      spelling: 'current',
      text: 'fix it',
    });
    expect(parseSessionName('[MAYOR] [HOME] H7 fix it')).toEqual({
      marks: {handoff: 7, mayor: true},
      repoTag: 'HOME',
      spelling: 'old',
      text: 'fix it',
    });
    expect(parseSessionName('[HOME] fix it')).toMatchObject({
      marks: {handoff: null, mayor: false},
    });
  });

  test('a bracket that only looks like a name is not the tool`s', () => {
    expect(parseSessionName('[HOME][Notes] fix it')).toBeNull();
    expect(parseSessionName('[HOME][Moe I-2] fix it')).toBeNull();
    expect(carriesSessionMarks('[HOME][Notes] fix it')).toBe(false);
  });
});

describe('the knob: componentConfig.thread.chainNames', () => {
  const labels = [
    'session',
    'chain:Moe_II',
    'continues:t-1',
    'handoff-number:4',
  ];

  test('on, the label shows; off or not said, the marks are as before', () => {
    expect(sessionMarksOf(labels, {chainNames: true})).toEqual({
      chain: 'Moe II',
      handoff: 4,
      mayor: false,
    });
    expect(sessionMarksOf(labels, {chainNames: false})).toEqual({
      handoff: 4,
      mayor: false,
    });
    expect(sessionMarksOf(labels)).toEqual({handoff: 4, mayor: false});
    expect(sessionDisplayName('HOME', 't', sessionMarksOf(labels))).toBe(
      '[HOME][#4] t',
    );
  });

  test('a successor keeps the name: the link copies the label, and its marks carry it', () => {
    expect(
      continuationLabels({
        oldBeadId: 't-1',
        oldLabels: labels,
        oldNumber: {kind: 'known', number: 4},
      }),
    ).toEqual(['continues:t-1', 'handoff-number:5', 'chain:Moe_II']);
    expect(
      successorMarks(labels, {kind: 'known', number: 4}, {chainNames: true}),
    ).toEqual({chain: 'Moe II', handoff: 5, mayor: false});
    expect(successorMarks(labels, {kind: 'known', number: 4})).toEqual({
      handoff: 5,
      mayor: false,
    });
  });
});

describe('the handoff summary', () => {
  const base = {
    checkout: null,
    own: {kind: 'known', number: 4} as const,
    requests: {kind: 'counted', open: 1, total: 2} as const,
    sessionBeadId: 't-1',
    tab: {kind: 'opened'} as const,
  };
  const plain = PLAIN_STYLE;

  test('one added line names the chain', () => {
    const text = handoffSummary({...base, chain: 'Moe II'}, plain);
    expect(text).toContain(
      '- **Chain:** Moe II (the next session keeps the name)',
    );
  });

  test('no name, no line: the summary is as before', () => {
    expect(handoffSummary({...base, chain: null}, plain)).not.toContain(
      'Chain',
    );
    expect(handoffSummary(base, plain)).toBe(
      handoffSummary({...base, chain: null}, plain),
    );
  });
});
