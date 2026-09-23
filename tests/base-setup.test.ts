/**
 * E2E tests for `justin-sdk add base-setup`.
 *
 * These tests exercise the foundation layer installer. They don't need
 * any external tools (no br, no mise) — just filesystem operations.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {addComponentsToConfig, runBaseSetup} from '../src/base-setup';
import {sdkRemoteWithOwnTag} from './git-fixtures';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  cachedRemote = null;
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

/** The local bare remote for THIS test, built once. See sdkRemoteWithOwnTag. */
let cachedRemote: string | null = null;

function sdkRemote(): string {
  cachedRemote ??= sdkRemoteWithOwnTag(track);
  return cachedRemote;
}

describe('base-setup', () => {
  test('creates an EMPTY justin-sdk.config.json — {} is a complete config', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    // No components (absent = core), and neither write-only stamp (D3).
    expect(config).toEqual({});
  });

  test('addComponentsToConfig records a component, and never base-setup', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(addComponentsToConfig(sb.path, ['beads-setup'])).toEqual([
      'beads-setup',
    ]);
    // Idempotent: a second call adds nothing and reports nothing.
    expect(addComponentsToConfig(sb.path, ['beads-setup'])).toEqual([]);

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toEqual(['beads-setup']);
  });

  test('preserves existing fields and DROPS the two retired stamps', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {
          components: ['base-setup', 'custom-thing'],
          customField: 'preserved',
          lastSynced: '2020-01-01',
          version: '0.2.0',
        },
      }),
    );

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {
      components?: string[];
      customField?: string;
      lastSynced?: string;
      version?: string;
    };
    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('custom-thing');
    expect(config.customField).toBe('preserved');
    // Both stamps are write-only and retired: base-setup deletes them rather
    // than bumping them (D3).
    expect(config.version).toBeUndefined();
    expect(config.lastSynced).toBeUndefined();
  });

  test('adds required scripts to package.json', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};

    expect(pkg.scripts?.signal).toContain('justin-sdk');
    expect(pkg.scripts?.doctor).toContain('justin-sdk');
    // j2n7: the alias invokes the SDK command, not a committed copy.
    expect(pkg.scripts?.['setup-env']).toBe('justin-sdk setup-env');
  });

  test('overwrites stale SDK scripts that point at node_modules path', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            doctor:
              'bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts doctor',
            signal:
              'bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts signal --quiet',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.signal).toBe('justin-sdk signal --quiet');
    expect(pkg.scripts?.doctor).toBe('justin-sdk doctor');
  });

  test('migrates BARE bunx aliases (bunx justin-sdk/jsdk/j) to the bare bin — the 2qhw hazard', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            doctor: 'bunx jsdk doctor',
            fix: 'bunx j fix',
            signal: 'bunx justin-sdk signal --quiet',
            // NOT SDK-emitted — a custom value must survive untouched.
            'signal:custom': 'bunx justin-sdk-lookalike thing',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.signal).toBe('justin-sdk signal --quiet');
    expect(pkg.scripts?.doctor).toBe('justin-sdk doctor');
    expect(pkg.scripts?.fix).toBe('justin-sdk fix');
    expect(pkg.scripts?.['signal:custom']).toBe(
      'bunx justin-sdk-lookalike thing',
    );
  });

  test('migrates a pre-j2n7 setup-env alias pointing at the deleted committed copy', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            'setup-env': 'bun scripts/setup-env.ts',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    // The old value points at a file stepSetupEnvScript deletes this same run.
    expect(pkg.scripts?.['setup-env']).toBe('justin-sdk setup-env');
  });

  test('preserves existing signal-source:* scripts (does not clobber)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            'signal-source:OXLINT': 'oxlint --deny-warnings',
            'signal-source:TS': 'tsc --noEmit --strict',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    // Existing signal-source entries preserved
    expect(pkg.scripts?.['signal-source:OXLINT']).toBe(
      'oxlint --deny-warnings',
    );
    expect(pkg.scripts?.['signal-source:TS']).toBe('tsc --noEmit --strict');
    // Defaults NOT added (because some signal-source entries existed)
    expect(pkg.scripts?.['signal-source:LINT']).toBeUndefined();
  });

  test('does NOT create scripts/setup-env.ts (retired j2n7 — the SDK command supersedes the copy)', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    expect(existsSync(join(sb.path, 'scripts/setup-env.ts'))).toBe(false);
  });

  test('DELETES an unmodified template copy (fleet migration path)', async () => {
    const sb = track(createProjectSandbox());
    // Simulate a pre-j2n7 project: the committed copy matches the retired
    // template byte-for-byte (the template stays on disk for recognition).
    const templatePath = join(
      import.meta.dirname,
      '..',
      'templates',
      'scripts',
      'setup-env.ts',
    );
    sb.writeFile('scripts/setup-env.ts', readFileSync(templatePath, 'utf-8'));

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    expect(existsSync(join(sb.path, 'scripts/setup-env.ts'))).toBe(false);
  });

  test('KEEPS a hand-modified setup-env.ts without --force (flag, never silently delete)', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('scripts/setup-env.ts', '// custom setup\n');

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const content = readFileSync(
      join(sb.path, 'scripts/setup-env.ts'),
      'utf-8',
    );
    expect(content).toBe('// custom setup\n');
  });

  test('--force deletes a hand-modified setup-env.ts', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('scripts/setup-env.ts', '// custom setup\n');

    await runBaseSetup({
      force: true,
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    expect(existsSync(join(sb.path, 'scripts/setup-env.ts'))).toBe(false);
  });

  test('adds @justinhaaheim/justin-sdk to devDependencies when missing', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.['@justinhaaheim/justin-sdk']).toMatch(
      /^github:justinhaaheim\/justin-sdk#/,
    );
  });

  test('does not touch SDK dep if already declared (workspace, file, github, etc.)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          dependencies: {'@justinhaaheim/justin-sdk': 'workspace:*'},
          name: 'test',
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@justinhaaheim/justin-sdk']).toBe('workspace:*');
    expect(pkg.devDependencies?.['@justinhaaheim/justin-sdk']).toBeUndefined();
  });

  test('rewrites stale local script wirings (bun scripts/doctor.ts → the bare bin)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            doctor: 'bun scripts/doctor.ts',
            'doctor:fix': 'bun scripts/doctor.ts --fix',
            signal: 'bun scripts/signal.ts --quiet',
            'signal:serial': 'bun scripts/signal.ts --serial',
            'signal:verbose': 'bun scripts/signal.ts',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.doctor).toBe('justin-sdk doctor');
    expect(pkg.scripts?.['doctor:fix']).toBe('justin-sdk doctor --fix');
    expect(pkg.scripts?.signal).toBe('justin-sdk signal --quiet');
    expect(pkg.scripts?.['signal:verbose']).toBe('justin-sdk signal');
    expect(pkg.scripts?.['signal:serial']).toBe('justin-sdk signal --serial');
  });

  test('preserves custom script values that do not match a stale shape', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            signal: 'bun run prettier-check',
          },
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.signal).toBe('bun run prettier-check');
  });

  test('DROPS the retired version/lastSynced stamps rather than bumping them', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {
          components: ['base-setup'],
          lastSynced: '2020-01-01',
          version: '0.1.0',
        },
      }),
    );
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]; lastSynced?: string; version?: string};
    expect(config.version).toBeUndefined();
    expect(config.lastSynced).toBeUndefined();
    // Everything else is left exactly as it was.
    expect(config.components).toEqual(['base-setup']);
  });

  test('adds tmp/ and dynamic-version.local.* to .gitignore', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('tmp/');
    expect(gitignore).toContain('dynamic-version.local');
  });

  test('preserves existing .gitignore entries', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '# existing\nnode_modules\ndist/\n');

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist/');
    expect(gitignore).toContain('tmp/');
  });

  test('creates .claude/settings.json with sandbox scaffolding and SessionStart hook', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {
      hooks?: {SessionStart?: unknown[]};
      sandbox?: {excludedCommands?: unknown};
    };
    expect(Array.isArray(settings.sandbox?.excludedCommands)).toBe(true);
    expect(Array.isArray(settings.hooks?.SessionStart)).toBe(true);

    // The j2n7 hook line: remote runs setup-env, local runs the read-only
    // `session-start` (dchjw.8 D6 — it replaced `doctor --quiet` and folded in
    // the repo-state block and the rules-drift notice the plugin used to add).
    const serialized = JSON.stringify(settings.hooks?.SessionStart);
    expect(serialized).toContain('justin-sdk setup-env');
    expect(serialized).toContain('bun run justin-sdk session-start');
    expect(serialized).not.toContain('scripts/setup-env.ts');
  });

  test('MIGRATES a pre-j2n7 SessionStart hook that ran the committed copy', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  command: 'bun run "$CLAUDE_PROJECT_DIR/scripts/setup-env.ts"',
                  type: 'command',
                },
              ],
            },
          ],
        },
      }),
    );

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {hooks?: {SessionStart?: unknown[]}};
    const serialized = JSON.stringify(settings.hooks?.SessionStart);
    // The old entry is REPLACED, not accumulated: the copy it invoked is being
    // deleted, and a hook pointing at a missing file errors at every session.
    expect(serialized).not.toContain('scripts/setup-env.ts');
    expect(serialized).toContain('justin-sdk setup-env');
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  });

  test('preserves existing .claude/settings.json contents', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {allow: ['Bash(ls:*)']},
        sandbox: {excludedCommands: ['gh']},
      }),
    );

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {
      hooks?: {SessionStart?: unknown};
      permissions?: {allow?: string[]};
      sandbox?: {excludedCommands?: string[]};
    };
    expect(settings.permissions?.allow).toContain('Bash(ls:*)');
    expect(settings.sandbox?.excludedCommands).toContain('gh');
    expect(settings.hooks?.SessionStart).toBeDefined();
  });

  test('fully idempotent: second run produces same result', async () => {
    const sb = track(createProjectSandbox());

    const first = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    const second = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    expect(first).toBe(0);
    expect(second).toBe(0);

    // base-setup writes no `components` key at all now (F11) — only `add` and
    // `remove` do — so there is nothing here that could grow duplicates.
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toBeUndefined();

    // .gitignore has no duplicate tmp/ entries
    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    const tmpMatches = gitignore.match(/^tmp\/$/gm) ?? [];
    expect(tmpMatches.length).toBe(1);
  });

  test('fails clearly if package.json does not exist', async () => {
    const sb = track(createSandbox());
    // No package.json in this sandbox
    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(1);
  });
});
