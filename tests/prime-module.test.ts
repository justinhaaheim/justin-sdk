/**
 * `prime --module <name>` (home-base-t6a0.17 D3): print only the named rule
 * modules, so the line session-start writes for a module it left out names a
 * command that works.
 *
 * The CLI arms run `src/cli.ts` as a subprocess, because the parts that can
 * break are yargs' (a repeatable option, strict parsing) and the exit code.
 * The assemble arms pin the narrowing itself: it applies after the predicates,
 * so it can only drop a module, never add one.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {resolve} from 'path';

import {assemble} from '../src/prime';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** Two universal modules, two RN-gated ones; one universal module nests a child. */
function promptsFixture(): string {
  const sb = track(createSandbox());
  sb.writeFile(
    'src/rules/index.md',
    ['@./alpha.md', '@./rn-a.md', '@./omega.md', '@./rn-b.md'].join('\n\n'),
  );
  sb.writeFile(
    'src/rules/alpha.md',
    '# Alpha\n\nALPHA_RULE\n\n@./alpha-child.md',
  );
  sb.writeFile(
    'src/rules/alpha-child.md',
    '## Alpha child\n\nALPHA_CHILD_RULE',
  );
  sb.writeFile('src/rules/omega.md', '# Omega\n\nOMEGA_RULE');
  sb.writeFile(
    'src/rules/rn-a.md',
    '---\nincludeIf: [isReactNative]\n---\n\n# RN A\n\nRN_A_RULE',
  );
  sb.writeFile(
    'src/rules/rn-b.md',
    '---\nincludeIf: [isReactNative]\n---\n\n# RN B\n\nRN_B_RULE',
  );
  return sb.path;
}

function project(deps: Record<string, string>): string {
  const sb = track(createSandbox());
  sb.writeFile('package.json', JSON.stringify({dependencies: deps}));
  return sb.path;
}

const ALL_MARKERS = [
  'ALPHA_RULE',
  'ALPHA_CHILD_RULE',
  'OMEGA_RULE',
  'RN_A_RULE',
  'RN_B_RULE',
];

function prime(
  cwd: string,
  promptsDir: string,
  args: string[],
): {status: number | null; stderr: string; stdout: string} {
  const result = spawnSync(
    process.execPath,
    [CLI, 'prime', '--prompts-dir', promptsDir, ...args],
    {
      cwd,
      encoding: 'utf-8',
      env: {
        ...(process.env as Record<string, string>),
        // Health notices may print on any CLI run; this test reads stdout.
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
      },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function markersIn(text: string): string[] {
  return ALL_MARKERS.filter((m) => new RegExp(`\\b${m}\\b`).test(text));
}

describe('prime --module, through the CLI', () => {
  test('one --module prints that module and only it', () => {
    const run = prime(project({expo: '*'}), promptsFixture(), [
      '--module',
      'rn-b',
    ]);
    expect(run.status).toBe(0);
    expect(markersIn(run.stdout)).toEqual(['RN_B_RULE']);
    expect(run.stdout).toContain('# Critical Rules');
  });

  test('two --module flags print both, in index order', () => {
    const run = prime(project({expo: '*'}), promptsFixture(), [
      '--module',
      'rn-b',
      '--module',
      'alpha',
    ]);
    expect(run.status).toBe(0);
    // alpha's nested child travels with it, as it does in every partition.
    expect(markersIn(run.stdout)).toEqual([
      'ALPHA_RULE',
      'ALPHA_CHILD_RULE',
      'RN_B_RULE',
    ]);
    expect(run.stdout.indexOf('ALPHA_RULE')).toBeLessThan(
      run.stdout.indexOf('RN_B_RULE'),
    );
  });

  test('an unknown name exits non-zero, prints no rules, and lists the valid names', () => {
    const run = prime(project({expo: '*'}), promptsFixture(), [
      '--module',
      'rn-b',
      '--module',
      'no-such-module',
    ]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown module: no-such-module');
    expect(run.stderr).toContain(
      'Valid names for this project (full partition): alpha, rn-a, omega, rn-b',
    );
  });

  test('a module whose predicate fails here is unknown here, not printed', () => {
    const run = prime(project({lodash: '*'}), promptsFixture(), [
      '--module',
      'rn-a',
    ]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown module: rn-a');
    expect(run.stderr).toContain(
      'Valid names for this project (full partition): alpha, omega',
    );
  });

  test('without --module, prime still prints every module (unchanged)', () => {
    const run = prime(project({expo: '*'}), promptsFixture(), []);
    expect(run.status).toBe(0);
    expect(markersIn(run.stdout)).toEqual(ALL_MARKERS);
  });
});

describe('assemble({modules}) narrows after the predicates', () => {
  test('it keeps only the named top-level modules, and reports what it resolved', () => {
    const out = assemble(
      {modules: ['omega', 'rn-a'], promptsDir: promptsFixture()},
      project({expo: '*'}),
    );
    expect(out.modules.map((m) => m.name)).toEqual(['rn-a', 'omega']);
    expect(out.resolved).toEqual([
      {conditional: false, name: 'alpha'},
      {conditional: true, name: 'rn-a'},
      {conditional: false, name: 'omega'},
      {conditional: true, name: 'rn-b'},
    ]);
    expect(markersIn(out.text)).toEqual(['OMEGA_RULE', 'RN_A_RULE']);
  });

  test('it never adds a module the predicates excluded', () => {
    const out = assemble(
      {modules: ['rn-a', 'omega'], promptsDir: promptsFixture()},
      project({lodash: '*'}),
    );
    expect(out.modules.map((m) => m.name)).toEqual(['omega']);
    expect(out.text).not.toContain('RN_A_RULE');
  });

  test('an empty list keeps nothing; no list keeps everything', () => {
    const prompts = promptsFixture();
    const root = project({expo: '*'});
    expect(assemble({modules: [], promptsDir: prompts}, root).text).toBe('');
    expect(markersIn(assemble({promptsDir: prompts}, root).text)).toEqual(
      ALL_MARKERS,
    );
  });

  test('it respects the partition: a universal name is not in the conditional slice', () => {
    const out = assemble(
      {
        modules: ['alpha', 'rn-b'],
        partition: 'conditional',
        promptsDir: promptsFixture(),
      },
      project({expo: '*'}),
    );
    expect(out.modules.map((m) => m.name)).toEqual(['rn-b']);
    expect(out.resolved.map((m) => m.name)).toEqual(['rn-a', 'rn-b']);
  });
});
