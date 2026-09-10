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
        scripts: {doctor: 'true', signal: 'true', 'setup-env': 'true'},
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
    expect(output).toContain('1 warn');
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
        scripts: {doctor: 'true', signal: 'true', 'setup-env': 'true'},
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
