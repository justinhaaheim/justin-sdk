/**
 * Each doctor warning prints once per change at session start
 * (home-base-p05kz.4 change 1).
 *
 * The first block runs the real runner with a real filter over made-up checks.
 * The second runs the real CLI in a repo with a real warning, because "`doctor`
 * by hand prints everything" and "the knob turns it off" are statements about
 * the commands as wired, not about a function.
 */

import type {CheckNode} from '../src/check-runner';

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {renderCheckTree, stripAnsi} from '../src/check-runner';
import {makeWarnOnceFilter} from '../src/doctor-warn-once';
import {git} from './git-fixtures';
import {createSandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

/** Real CLI runs do a full doctor (see session-start-envelope.test.ts). */
const CLI_TIMEOUT_MS = 60_000;

let sandbox: ReturnType<typeof createSandbox>;
let stateFile: string;

beforeEach(() => {
  sandbox = createSandbox();
  stateFile = join(sandbox.path, 'state', 'doctor-warnings-shown.json');
});

afterEach(() => {
  sandbox.cleanup();
});

function warn(label: string, message: string): CheckNode {
  return {
    check: {
      fn: () => ({message, pass: false}),
      label,
      severity: 'warn',
    },
  };
}

const PASSING: CheckNode = {check: {fn: () => ({pass: true}), label: 'FINE'}};

async function report(nodes: CheckNode[]): Promise<string> {
  const {report: text} = await renderCheckTree(nodes, {
    quiet: true,
    warningFilter: makeWarnOnceFilter({repoKey: '/repo/.git', stateFile}),
  });
  return stripAnsi(text);
}

describe('warning filter over the real runner', () => {
  test('a warning prints the first time', async () => {
    const text = await report([PASSING, warn('W', 'the warning text')]);
    expect(text).toContain('the warning text');
    expect(text).not.toContain('unchanged since last shown');
  });

  test('the second time it is hidden, with one line naming it', async () => {
    await report([PASSING, warn('W', 'the warning text')]);
    const text = await report([PASSING, warn('W', 'the warning text')]);
    expect(text).not.toContain('the warning text');
    expect(text).toContain('1 warning unchanged since last shown: W.');
    expect(text).toContain('justin-sdk doctor');
    // "All 2 checks passed" would be false.
    expect(text).toContain('1 of 2 checks passed.');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  test('it prints again as soon as its text changes', async () => {
    await report([warn('W', 'the warning text')]);
    await report([warn('W', 'the warning text')]);
    const text = await report([warn('W', 'different text')]);
    expect(text).toContain('different text');
    expect(text).not.toContain('unchanged since last shown');
  });

  test('it prints again after it resolved and came back', async () => {
    await report([warn('W', 'the warning text')]);
    await report([PASSING]);
    const text = await report([warn('W', 'the warning text')]);
    expect(text).toContain('the warning text');
    expect(text).not.toContain('unchanged since last shown');
  });

  test('an error-level check is never hidden', async () => {
    const failing: CheckNode = {
      check: {
        fn: () => ({message: 'the error text', pass: false}),
        label: 'E',
      },
    };
    await report([failing]);
    await report([failing]);
    const text = await report([failing]);
    expect(text).toContain('the error text');

    // Even a filter that names it outright cannot hide it.
    const {report: named} = await renderCheckTree([failing], {
      quiet: true,
      warningFilter: () => ({hide: ['E'], note: null}),
    });
    expect(stripAnsi(named)).toContain('the error text');
  });

  test('a warning with nothing to compare is never hidden', async () => {
    const shell: CheckNode = {
      check: {command: 'exit 1', label: 'SHELL', severity: 'warn'},
    };
    await report([shell]);
    const text = await report([shell]);
    expect(text).toContain('SHELL');
    expect(text).not.toContain('unchanged since last shown');
  });

  test('a corrupt state file shows everything and says so', async () => {
    await report([warn('W', 'the warning text')]);
    writeFileSync(stateFile, '{not json');
    const text = await report([warn('W', 'the warning text')]);
    expect(text).toContain('the warning text');
    expect(text).toContain('Showing every warning: could not read');
  });

  test('a state file with a row of the wrong shape shows everything', async () => {
    await report([warn('W', 'the warning text')]);
    writeFileSync(
      stateFile,
      JSON.stringify({
        repos: {'/repo/.git': {W: {text: 'the warning text'}}},
        schemaVersion: 1,
      }),
    );
    const text = await report([warn('W', 'the warning text')]);
    expect(text).toContain('the warning text');
    expect(text).toContain('Showing every warning: could not read');
  });

  test('a state file that cannot be written shows everything', async () => {
    await report([warn('W', 'the warning text')]);
    // Still readable, with the row that would hide it, but no longer writable.
    chmodSync(dirname(stateFile), 0o555);
    let text: string;
    try {
      text = await report([warn('W', 'the warning text')]);
    } finally {
      chmodSync(dirname(stateFile), 0o755);
    }
    expect(stripAnsi(text)).toContain('the warning text');
    expect(stripAnsi(text)).toContain('Showing every warning: could not');
  });

  test('a file from another SDK version is not overwritten', async () => {
    mkdirSync(join(sandbox.path, 'state'));
    const newer = JSON.stringify({future: true, schemaVersion: 2});
    writeFileSync(stateFile, newer);
    const text = await report([warn('W', 'the warning text')]);
    expect(text).toContain('the warning text');
    expect(text).toContain('another justin-sdk version');
    expect(readFileSync(stateFile, 'utf-8')).toBe(newer);
  });

  test('a repo it cannot identify shows everything', async () => {
    const shown = () =>
      renderCheckTree([warn('W', 'the warning text')], {
        quiet: true,
        warningFilter: makeWarnOnceFilter({repoKey: null, stateFile}),
      });
    await shown();
    const {report: text} = await shown();
    expect(stripAnsi(text)).toContain('the warning text');
    expect(stripAnsi(text)).toContain('could not tell which repository');
  });

  test('a filter that throws hides nothing and says so', async () => {
    const {report: text} = await renderCheckTree(
      [warn('W', 'the warning text')],
      {
        quiet: true,
        warningFilter: () => {
          throw new Error('boom');
        },
      },
    );
    expect(stripAnsi(text)).toContain('the warning text');
    expect(stripAnsi(text)).toContain('Showing every warning: boom');
  });
});

/**
 * A repo whose doctor has real warnings. Which ones fire is not this test's
 * subject, so it reads the labels from the first run instead of naming them.
 */
function enrolledRepo(config: unknown): string {
  const root = join(sandbox.path, 'repo');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), 'x\n');
  writeFileSync(join(root, 'package.json'), '{"name":"p","version":"0.0.1"}\n');
  writeFileSync(
    join(root, 'justin-sdk.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function cli(root: string, command: string): string {
  const home = join(sandbox.path, 'home');
  mkdirSync(home, {recursive: true});
  // spawnSync: `doctor` exits 1 here (no CLAUDE.md), and its report is the point.
  const {stdout} = spawnSync(process.execPath, [CLI, command], {
    cwd: root,
    encoding: 'utf-8',
    env: {
      ...(process.env as Record<string, string>),
      // sandbox.ts switches health notices off for every test, and with them
      // this filter. Clear it, or both tests below pass without the filter.
      CI: '',
      CLAUDE_PROJECT_DIR: root,
      HOME: home,
      JSDK_PRIME_PRETTIER: '0',
      JUSTIN_SDK_HEALTH_NOTICES: '',
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
    },
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'warn-once-test',
      source: 'startup',
    }),
  });
  return stripAnsi(stdout);
}

/** Every warning line (` ⚠ LABEL [..]`), which the note line never matches. */
function warningLabels(text: string): string[] {
  return [...text.matchAll(/ ⚠ ([A-Z][A-Z0-9_:-]+) /g)].flatMap((match) =>
    match[1] == null ? [] : [match[1]],
  );
}

describe('the commands as wired', () => {
  test(
    'session-start hides on its second run; `doctor` by hand still prints all',
    () => {
      const root = enrolledRepo({components: ['base-setup']});
      const first = warningLabels(cli(root, 'session-start'));
      expect(first.length).toBeGreaterThan(0);

      const second = cli(root, 'session-start');
      expect(warningLabels(second)).toEqual([]);
      expect(second).toContain('unchanged since last shown');

      const byHand = warningLabels(cli(root, 'doctor'));
      for (const label of first) expect(byHand).toContain(label);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'with the knob off, session-start prints every warning every time',
    () => {
      const root = enrolledRepo({
        components: ['base-setup'],
        healthNotices: {doctor: {warnOncePerChange: false}},
      });
      const first = warningLabels(cli(root, 'session-start'));
      expect(first.length).toBeGreaterThan(0);

      const second = cli(root, 'session-start');
      expect(warningLabels(second)).toEqual(first);
      expect(second).not.toContain('unchanged since last shown');
    },
    CLI_TIMEOUT_MS,
  );
});
