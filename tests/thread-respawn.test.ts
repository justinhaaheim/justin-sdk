/**
 * respawn.ts after `thread respawn` was retired (epic home-base-mbnjv C3,
 * home-base-mbnjv.2): the command prints a pointer to `thread handoff` and
 * exits 2 doing nothing; the helpers it leaves behind (zshWord, kickoffText)
 * still quote and word exactly as before. The launch itself is tested in
 * thread-handoff-successor.test.ts.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, readdirSync} from 'fs';
import {join} from 'path';

import {
  kickoffText,
  RESPAWN_RETIRED_LINES,
  zshWord,
} from '../src/thread/respawn';
import {createSandbox} from './sandbox';

const TRICKY = `say "hi" to $HOME and \`date\`, it's fine`;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

describe('thread respawn: retired (C3)', () => {
  test('the CLI prints the pointer to thread handoff, exits 2, and writes nothing', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const stateDir = join(sb.path, 'state');
    mkdirSync(stateDir);
    const cliEntry = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        CLAUDE_CODE_SESSION_ID: '01d00000-1111-4222-8333-0000000000a1',
        CMUX_SOCKET_PATH: join(sb.path, 'no-cmux.sock'),
        CMUX_SURFACE_ID: 'CCCC0000-1111-4222-8333-0000000000c3',
        CMUX_WORKSPACE_ID: 'AAAA0000-1111-4222-8333-0000000000b2',
        FORCE_COLOR: undefined,
        HOME: join(sb.path, 'home'),
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        JUSTIN_THREADS_STATE_DIR: stateDir,
        NO_COLOR: '1',
        XDG_CONFIG_HOME: join(sb.path, 'xdg'),
      }).filter((entry): entry is [string, string] => entry[1] != null),
    );
    const run = Bun.spawnSync(
      [
        process.execPath,
        cliEntry,
        'thread',
        'respawn',
        '--note',
        'x',
        '--close-after',
        '5',
        '--kickoff',
        'go',
      ],
      {cwd: sb.path, env, stdin: 'ignore'},
    );
    expect({
      code: run.exitCode,
      err: run.stderr.toString(),
      out: run.stdout.toString(),
    }).toEqual({
      code: 2,
      err: `${RESPAWN_RETIRED_LINES.join('\n')}\n`,
      out: '',
    });
    expect(readdirSync(stateDir)).toEqual([]);
    // bun's own transpiler cache (Library/Caches/bun) is the only thing
    // written under HOME.
    const home = join(sb.path, 'home');
    const written = existsSync(home)
      ? readdirSync(home, {recursive: true})
          .map(String)
          .filter((path) => !path.startsWith('Library'))
      : [];
    expect(written).toEqual([]);
  });

  test('the pointer names thread handoff and the knob', () => {
    const text = RESPAWN_RETIRED_LINES.join('\n');
    // The bin by path: a bun call is never excluded from the sandbox
    // (home-base-mbnjv.10, epic C12).
    expect(text).toContain('`./node_modules/.bin/justin-sdk thread handoff`');
    expect(text).not.toContain('bun run justin-sdk thread handoff');
    expect(text).toContain('componentConfig.thread.handoff.successor');
    expect(text).toContain('Nothing was written and nothing was started.');
  });
});

describe('the helpers respawn.ts keeps', () => {
  test('kickoffText is prose that names the block file and the continues command', () => {
    const kickoff = kickoffText('/tmp/h/abc.md', 't-abc', TRICKY);
    expect(kickoff.startsWith('/')).toBe(false);
    expect(kickoff).toContain('Read /tmp/h/abc.md.');
    expect(kickoff).toContain(
      'bun run justin-sdk thread request --continues t-abc',
    );
    expect(kickoff.endsWith(TRICKY)).toBe(true);
    expect(kickoffText('/tmp/h/abc.md', 't-abc', null)).toBe(
      'You are the successor of a handed-off Claude Code session. Read /tmp/h/abc.md. First run the command under its pick-up section: bun run justin-sdk thread request --continues t-abc. Then continue the work the block describes, starting from its note.',
    );
  });

  test('zsh receives the kickoff literally (quote, dollar, backtick, space, apostrophe)', () => {
    const kickoff = kickoffText('/tmp/x y/block.md', 't-abc', TRICKY);
    const command = ['claude', '--model', 'haiku', kickoff]
      .map(zshWord)
      .join(' ');
    // Swap the program for printf: zsh then prints every word it parsed.
    const probe = command.replace(/^claude /u, `printf '%s\\n' `);
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
    });
    expect(printed).toBe(`--model\nhaiku\n${kickoff}\n`);
  });

  test('zsh receives a word starting with "=" literally (no EQUALS expansion)', () => {
    // Bare, `=date` would become the path of the date binary; `a=b` is safe bare.
    const command = ['claude', '=date', 'a=b'].map(zshWord).join(' ');
    const probe = command.replace(/^claude /u, `printf '%s\\n' `);
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
    });
    expect(printed).toBe('=date\na=b\n');
  });
});
