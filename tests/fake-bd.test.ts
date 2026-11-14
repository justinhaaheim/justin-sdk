/**
 * The fake bd answers the same whether bun reaches it through a package.json
 * `bd` script (how createFakeBd built it before home-base-ejsq2.3 part D) or
 * runs `bd.ts` itself (how it is built now, one bun process a call instead of
 * two). Both twins get the same commands, one of each kind the tests issue,
 * failures included; stdout, exit code and the saved state must be equal, and
 * stderr equal once bun's own wrapper lines are taken out of the script twin's.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-ejsq2.3): make the
 * file twin's bd.ts print one extra character for `show` and the stdout
 * comparison fails on that command.
 */
import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {createFakeBd, type FakeBd} from './fake-bd';

interface Answer {
  status: number | null;
  stderr: string;
  stdout: string;
}

function bd(fake: FakeBd, args: string[]): Answer {
  const ran = spawnSync('bun', ['run', 'bd', ...args], {
    cwd: fake.dir,
    encoding: 'utf8',
    env: fake.env as NodeJS.ProcessEnv,
  });
  if (ran.error != null) throw ran.error;
  return {status: ran.status, stderr: ran.stderr, stdout: ran.stdout};
}

/** The old fixture: a `bd` script that starts a second bun on bd.ts. */
function asScriptTwin(fake: FakeBd): FakeBd {
  writeFileSync(
    join(fake.dir, 'package.json'),
    JSON.stringify({
      name: 'fake-life',
      scripts: {bd: `bun ${join(fake.dir, 'bd.ts')}`},
    }),
  );
  return fake;
}

/** Script-mode stderr without the lines bun itself adds around a script. */
function withoutBunLines(stderr: string): string {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('$ bun ') &&
        !/^error: script "bd" exited with code \d+$/.test(line),
    )
    .join('\n');
}

/** Runs each command in both twins and compares what they answered. */
function compare(file: FakeBd, script: FakeBd, commands: string[][]): void {
  for (const args of commands) {
    const fromFile = bd(file, args);
    const fromScript = bd(script, args);
    const label = args.join(' ');
    expect({label, status: fromFile.status}).toEqual({
      label,
      status: fromScript.status,
    });
    expect({label, stdout: fromFile.stdout}).toEqual({
      label,
      stdout: fromScript.stdout,
    });
    expect({label, stderr: fromFile.stderr}).toEqual({
      label,
      stderr: withoutBunLines(fromScript.stderr),
    });
  }
  expect(file.read()).toEqual(script.read());
}

/**
 * Twin workspaces holding one thread (jl-t1, sessionId s-1) and three asks,
 * the third closed. The script twin fails `create -t ask` the second time and
 * `comments add` on jl-t1, and so does the file twin.
 */
function seededTwins(): {file: FakeBd; metadata: string; script: FakeBd} {
  const file = createFakeBd(2, 'jl-t1', false);
  const script = asScriptTwin(createFakeBd(2, 'jl-t1', false));
  const metadata = join(file.dir, 'meta.json');
  writeFileSync(metadata, JSON.stringify({kind: 'x', sessionId: 's-1'}));
  for (const fake of [file, script]) {
    fake.write({
      ...fake.read(),
      issues: [
        {
          id: 'jl-t1',
          metadata: {sessionId: 's-1'},
          parent: null,
          status: 'open',
          title: 'a thread',
          type: 'thread',
        },
        {
          description: 'why',
          id: 'jl-t1.1',
          parent: 'jl-t1',
          status: 'open',
          title: 'first ask',
          type: 'ask',
        },
        {
          id: 'jl-t1.2',
          parent: 'jl-t1',
          status: 'open',
          title: 'second ask',
          type: 'ask',
        },
        {
          closeReason: 'done',
          id: 'jl-t1.3',
          parent: 'jl-t1',
          status: 'closed',
          title: 'third ask',
          type: 'ask',
        },
      ],
      nextId: 2,
    });
  }
  return {file, metadata, script};
}

describe('the fake bd answers the same run as a file as it did run as a script', () => {
  test('types, and creates: a thread, asks, and the ask create that fails', () => {
    const {file, metadata, script} = seededTwins();
    compare(file, script, [
      ['types'],
      ['create', 'b thread', '-t', 'thread', '--metadata', `@${metadata}`],
      ['create', 'fourth ask', '-t', 'ask', '--parent', 'jl-t1', '-d', 'why'],
      ['create', 'fifth ask', '-t', 'ask', '--parent', 'jl-t1'],
      ['create', 'sixth ask', '-t', 'ask', '--parent', 'jl-t1', '--notes', 'n'],
    ]);
  });

  test('lists and shows', () => {
    const {file, script} = seededTwins();
    compare(file, script, [
      ['list', '-t', 'thread', '--json'],
      ['list', '-t', 'ask', '--parent', 'jl-t1', '--all'],
      ['list', '-t', 'thread', '--metadata-field', 'sessionId=s-1'],
      ['show', 'jl-t1.1'],
      ['show', 'jl-nope'],
    ]);
  });

  test('updates and closes, of beads that exist and one that does not', () => {
    const {file, metadata, script} = seededTwins();
    compare(file, script, [
      ['update', 'jl-t1.1', '--title', 't2', '-s', 'in_progress'],
      ['update', 'jl-t1', '--metadata', `@${metadata}`, '-d', 'd2'],
      ['update', 'jl-nope', '--title', 'x'],
      ['close', 'jl-t1.2', '--reason', 'done'],
      ['close', 'jl-nope'],
    ]);
  });

  test('comments, the comment add that fails, and an unknown command', () => {
    const {file, script} = seededTwins();
    compare(file, script, [
      ['comments', 'add', 'jl-t1.2', 'an answer'],
      ['comments', 'add', 'jl-t1', 'refused'],
      ['comments', 'jl-t1.2'],
      ['frobnicate', 'x'],
    ]);
  });

  test('the lookup failure and the export failure, the same both ways', () => {
    const file = createFakeBd(0, null, true);
    const script = asScriptTwin(createFakeBd(0, null, true));
    for (const fake of [file, script]) {
      const state = fake.read();
      fake.write({...state, exportJsonl: true, failThreadLookupFor: 's-9'});
    }
    const commands: string[][] = [
      ['create', 'exported', '-t', 'thread'],
      ['list', '-t', 'thread', '--metadata-field', 'sessionId=s-9'],
    ];
    for (const args of commands) {
      const fromFile = bd(file, args);
      const fromScript = bd(script, args);
      expect(fromFile.status).toBe(fromScript.status);
      expect(fromFile.stdout).toBe(fromScript.stdout);
      expect(fromFile.stderr).toBe(withoutBunLines(fromScript.stderr));
    }
    expect(file.read()).toEqual(script.read());
    expect(readFileSync(join(file.dir, '.beads', 'issues.jsonl'), 'utf8')).toBe(
      readFileSync(join(script.dir, '.beads', 'issues.jsonl'), 'utf8'),
    );
  });

  test('a workspace built by createFakeBd has no bd script, and bun runs bd.ts', () => {
    const fake = createFakeBd();
    const manifest = JSON.parse(
      readFileSync(join(fake.dir, 'package.json'), 'utf8'),
    ) as {scripts?: unknown};
    expect(manifest.scripts).toBeUndefined();
    const answer = bd(fake, ['types']);
    expect(answer).toEqual({
      status: 0,
      stderr: '',
      stdout: 'thread ask docs question',
    });
  });
});
