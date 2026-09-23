/**
 * The CONFIG_SCHEMA doctor check (home-base-uxwc.1, D9).
 *
 * Driven through the real CLI rather than by calling the check directly,
 * because the two things most likely to break are not the validation itself:
 *
 *  - the check must be REGISTERED in base-setup, or it silently never runs;
 *  - it must be WARN severity, or a stray key in a config file starts failing
 *    every doctor run, every SessionStart hook and every sweep gate in the
 *    fleet.
 *
 * XDG_CONFIG_HOME is injected into the child so the real ~/.config is never
 * read — a developer with a genuinely broken user config must not turn this red.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

// Built from a char code so the file carries no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function newSandbox(): Sandbox {
  const created = createSandbox();
  sandboxes.push(created);
  return created;
}

/**
 * A project that passes every OTHER base check, so the exit code isolates
 * CONFIG_SCHEMA's severity.
 */
function projectRoot(config: Record<string, unknown>): string {
  const box = newSandbox();
  box.writeFile('CLAUDE.md', '# test project\n');
  box.writeFile(
    'package.json',
    JSON.stringify(
      {
        name: 'test-project',
        scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
        version: '0.0.1',
      },
      null,
      2,
    ) + '\n',
  );
  box.writeFile(
    'justin-sdk.config.json',
    JSON.stringify(config, null, 2) + '\n',
  );
  return box.path;
}

function configHome(userConfig: string | null): string {
  const box = newSandbox();
  if (userConfig != null) {
    mkdirSync(join(box.path, 'justin-sdk'), {recursive: true});
    writeFileSync(join(box.path, 'justin-sdk', 'config.json'), userConfig);
  }
  return box.path;
}

const BASE_CONFIG = {
  components: ['base-setup'],
  lastSynced: '2026-09-10',
  version: '0.26.0',
};

function runDoctorCli(
  root: string,
  home: string,
): {output: string; status: number | null} {
  const run = spawnSync(process.execPath, [CLI, 'doctor'], {
    cwd: root,
    encoding: 'utf-8',
    env: {...process.env, XDG_CONFIG_HOME: home},
  });
  return {
    output: stripAnsi(`${run.stdout}${run.stderr}`),
    status: run.status,
  };
}

describe('CONFIG_SCHEMA doctor check', () => {
  test('valid project config and no user config: passes, run is green', () => {
    const {output, status} = runDoctorCli(
      projectRoot(BASE_CONFIG),
      configHome(null),
    );
    expect(output).toContain('✓ CONFIG_SCHEMA');
    expect(output).not.toContain('schema violation');
    expect(status).toBe(0);
  });

  test('unknown keys at every level still pass', () => {
    const {output, status} = runDoctorCli(
      projectRoot({
        ...BASE_CONFIG,
        futureKey: 1,
        healthNotices: {futureKey: 2, sdkVersion: {futureKey: 3}},
      }),
      configHome(JSON.stringify({futureUserKey: true})),
    );
    expect(output).toContain('✓ CONFIG_SCHEMA');
    expect(status).toBe(0);
  });

  test('a wrong-typed promptTier WARNS, names the key path, and does NOT fail the run', () => {
    const {output, status} = runDoctorCli(
      projectRoot({
        ...BASE_CONFIG,
        healthNotices: {sdkVersion: {minor: {promptTier: 'high'}}},
      }),
      configHome(null),
    );
    expect(output).toContain('⚠ CONFIG_SCHEMA');
    expect(output).toContain('healthNotices.sdkVersion.minor.promptTier');
    // The warn marker is asserted on CONFIG_SCHEMA's OWN line above, not by
    // counting warns run-wide: doctor's check set is not fixed, and
    // USER_LEVEL_SESSION_START (dchjw.8) warns on any machine — every test
    // sandbox included — that has no user-level session-start hook.
    expect(output).toMatch(/\d+ warn/);
    expect(output).toContain('config schema');
    // Warn severity: the exit code is what SessionStart and sweep gate on.
    expect(status).toBe(0);
  });

  test('a broken USER config warns and names the user file, not the project file', () => {
    const home = configHome('{"healthNotices": {"doctor": {"showOnPass": 3}}}');
    const {output, status} = runDoctorCli(projectRoot(BASE_CONFIG), home);
    expect(output).toContain('⚠ CONFIG_SCHEMA');
    expect(output).toContain(join(home, 'justin-sdk', 'config.json'));
    expect(output).toContain('healthNotices.doctor.showOnPass');
    expect(status).toBe(0);
  });

  test('an unparseable USER config is reported as bad JSON, not as absent', () => {
    const box = newSandbox();
    box.writeFile('CLAUDE.md', '# test\n');
    box.writeFile(
      'package.json',
      JSON.stringify({
        name: 'p',
        scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
      }),
    );
    // doctor itself parses the config to find components, so the file has to be
    // readable JSON for the run to happen at all; the USER file is where an
    // unparseable file can actually reach this check.
    box.writeFile(
      'justin-sdk.config.json',
      JSON.stringify(BASE_CONFIG, null, 2),
    );
    const {output} = runDoctorCli(box.path, configHome('{not json'));
    expect(output).toContain('⚠ CONFIG_SCHEMA');
    expect(output).toContain('not valid JSON');
    expect(output).not.toContain('not present');
  });
});

/**
 * F1 — an absent `components` key must resolve to the `core` preset, and doctor
 * must therefore RUN checks (epic home-base-dchjw, AC 9).
 *
 * The bug this replaces: `config.components ?? []` read an absent list as an
 * empty one, so a repo with no `components` key ran ZERO checks and printed "No
 * doctor checks registered", which reads as a clean bill of health and meant "I
 * did not look" (critical rule 6).
 */
describe('doctor resolves an absent components key to core', () => {
  /** Labels that can ONLY come from a component in core, never from base-setup. */
  const CORE_ONLY_LABELS = [
    'GITIGNORE_EXISTS',
    'PRETTIERRC',
    'TSCONFIG',
    'ESLINT_CONFIG',
  ];

  function countChecks(output: string): number {
    return output
      .split('\n')
      .filter((line) => /^\s*[✓✗⚠]\s+[A-Z][A-Z0-9_]+/.test(line)).length;
  }

  test('a config of {} runs the core checks', () => {
    const {output} = runDoctorCli(projectRoot({}), configHome(null));
    expect(output).not.toContain('No doctor checks registered');
    expect(countChecks(output)).toBeGreaterThan(0);
    for (const label of CORE_ONLY_LABELS) {
      expect(output).toContain(label);
    }
    // base-setup's own checks are there too: the resolved list always carries
    // the implicit component.
    expect(output).toContain('BUN');
  });

  test('NEGATIVE CONTROL: an EMPTY components list runs only base-setup checks', () => {
    // Same fixture, same command — the ONLY difference is that `components` is
    // present and empty, which is a deliberate statement rather than an
    // absence. If this printed the core labels too, the test above would be
    // passing for some reason other than the resolution under test.
    const {output} = runDoctorCli(
      projectRoot({components: []}),
      configHome(null),
    );
    expect(output).toContain('BUN');
    for (const label of CORE_ONLY_LABELS) {
      expect(output).not.toContain(label);
    }
  });

  test('a components key of the wrong type FAILS rather than checking nothing', () => {
    const {output, status} = runDoctorCli(
      projectRoot({components: 'beads-setup'}),
      configHome(null),
    );
    expect(output).toContain('is not an array');
    expect(output).toContain('NOT a clean bill of health');
    expect(status).toBe(1);
  });
});
