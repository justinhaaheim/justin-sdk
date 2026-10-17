/**
 * `justin-sdk worktree-salvage` through the real CLI entry (D1, AC 7): it is
 * registered, `--help` does nothing else, and the exit codes are the contract.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join, resolve} from 'path';

import {createSandbox, type Sandbox} from './sandbox';
import {buildDirtyWorktree} from './worktree-salvage-fixtures';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function run(
  sb: Sandbox,
  args: string[],
): {code: number; stderr: string; stdout: string} {
  const result = Bun.spawnSync(['bun', CLI, 'worktree-salvage', ...args], {
    cwd: sb.path,
    env: {
      ...process.env,
      NO_COLOR: '1',
      XDG_CONFIG_HOME: join(sb.path, 'config'),
      XDG_DATA_HOME: join(sb.path, 'data'),
    },
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

describe('worktree-salvage CLI', () => {
  test('command.ts imports only types, so the hooks’ eager module graph does not grow (D1)', () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'src',
        'worktree-salvage',
        'command.ts',
      ),
      'utf-8',
    );
    const imports = source
      .split('\n')
      .filter((line) => /^import\s/u.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !line.startsWith('import type '))).toEqual(
      [],
    );
  });

  test('--help exits 0, prints the subcommands and writes nothing', () => {
    const sb = track();
    const help = run(sb, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('worktree-salvage save <path>');
    expect(help.stdout).toContain('worktree-salvage list');
    expect(existsSync(join(sb.path, 'data'))).toBe(false);
  });

  test('save <real worktree> --help prints help and saves nothing', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const help = run(sb, ['save', worktree, '--out', out, '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--ignored');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(sb.path, 'data'))).toBe(false);
  });

  test('save exits 0 and names the destination and its source', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const saved = run(sb, ['save', worktree, '--out', out]);
    expect(saved.stderr).toBe('');
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain(`destination:  ${out}`);
    expect(saved.stdout).toContain('from:         --out, for this run only');
    expect(existsSync(join(out, 'primary', 'feature'))).toBe(true);

    const listed = run(sb, ['list', '--out', out, '--json']);
    expect(listed.code).toBe(0);
    const parsed = JSON.parse(listed.stdout) as {saves: {state: string}[]};
    expect(parsed.saves.map((save) => save.state)).toEqual(['complete']);
  });

  test('save on a directory that is not a checkout exits 1', () => {
    const sb = track();
    sb.mkdir('plain');
    const failed = run(sb, [
      'save',
      join(sb.path, 'plain'),
      '--out',
      join(sb.path, 'out'),
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('is not inside a git checkout');
    expect(existsSync(join(sb.path, 'out'))).toBe(false);
  });

  test('a broken config file exits 1 and never falls back to the data directory', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    sb.writeFile('config/worktree-salvage/config.json', 'not json');
    const failed = run(sb, ['save', worktree]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      join(sb.path, 'config/worktree-salvage/config.json'),
    );
    expect(existsSync(join(sb.path, 'data'))).toBe(false);
  });
});
