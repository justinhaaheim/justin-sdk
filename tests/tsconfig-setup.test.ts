/**
 * E2E tests for `justin-sdk add tsconfig` (tsconfig-setup component).
 *
 * These tests exercise the TypeScript-layer installer. They don't need
 * any external tools — no real `bun add` is run; the step edits
 * package.json directly so tests stay fast and offline.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {PINNED} from '../src/pinned-versions';
import {runTsconfigSetup} from '../src/tsconfig-setup';
import {createProjectSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

describe('tsconfig-setup', () => {
  test('fresh project: installs tsconfig + devDeps + script + registers component', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runTsconfigSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // tsconfig.json exists and has strict: true.
    // Note: the template is JSONC (has comments), so we use a regex check
    // rather than JSON.parse here.
    expect(existsSync(join(sb.path, 'tsconfig.json'))).toBe(true);
    const tsconfigRaw = readFileSync(join(sb.path, 'tsconfig.json'), 'utf-8');
    expect(tsconfigRaw).toMatch(/"strict"\s*:\s*true/);

    // package.json devDeps contain typescript and @types/bun at pinned versions
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.devDependencies?.typescript).toBe(PINNED.typescript);
    expect(pkg.devDependencies?.['@types/bun']).toBe(PINNED['@types/bun']);

    // signal-source:TS script registered
    expect(pkg.scripts?.['signal-source:TS']).toBe('tsc --noEmit');

    // justin-sdk.config.json registers tsconfig-setup as a component
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('tsconfig-setup');
  });

  test('does NOT install @types/node (Bun-targeted projects)', async () => {
    const sb = track(createProjectSandbox());
    await runTsconfigSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.['@types/node']).toBeUndefined();
    expect(pkg.dependencies?.['@types/node']).toBeUndefined();
  });

  test('idempotent: second run returns 0 with no spurious writes', async () => {
    const sb = track(createProjectSandbox());

    const first = await runTsconfigSetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);

    const tsconfigAfterFirst = readFileSync(
      join(sb.path, 'tsconfig.json'),
      'utf-8',
    );
    const pkgAfterFirst = readFileSync(join(sb.path, 'package.json'), 'utf-8');

    const second = await runTsconfigSetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);

    // Files unchanged after second run
    expect(readFileSync(join(sb.path, 'tsconfig.json'), 'utf-8')).toBe(
      tsconfigAfterFirst,
    );
    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toBe(
      pkgAfterFirst,
    );

    // No duplicate tsconfig-setup entry in components
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    const count = (config.components ?? []).filter(
      (c) => c === 'tsconfig-setup',
    ).length;
    expect(count).toBe(1);
  });

  test('preserves existing tsconfig.json (warns + skips, still returns 0)', async () => {
    const sb = track(createProjectSandbox());
    const customTsconfig = JSON.stringify(
      {
        compilerOptions: {
          strict: false,
          target: 'ES2020',
          customFlag: 'preserved',
        },
      },
      null,
      2,
    );
    sb.writeFile('tsconfig.json', customTsconfig);

    const exitCode = await runTsconfigSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const after = readFileSync(join(sb.path, 'tsconfig.json'), 'utf-8');
    expect(after).toBe(customTsconfig);
  });

  test('--force overwrites existing tsconfig.json from template', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      'tsconfig.json',
      JSON.stringify({compilerOptions: {strict: false}}, null, 2),
    );

    const exitCode = await runTsconfigSetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    // Template is JSONC; regex-check instead of JSON.parse.
    const tsconfigRaw = readFileSync(join(sb.path, 'tsconfig.json'), 'utf-8');
    expect(tsconfigRaw).toMatch(/"strict"\s*:\s*true/);
  });

  test('preserves existing devDeps (other packages stay, ts/@types/bun added)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {someOther: '1.0.0'},
        },
      }),
    );
    await runTsconfigSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.someOther).toBe('1.0.0');
    expect(pkg.devDependencies?.typescript).toBe(PINNED.typescript);
    expect(pkg.devDependencies?.['@types/bun']).toBe(PINNED['@types/bun']);
  });

  test('preserves existing scripts (build stays, signal-source:TS added)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {build: 'tsc --build'},
        },
      }),
    );
    await runTsconfigSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.build).toBe('tsc --build');
    expect(pkg.scripts?.['signal-source:TS']).toBe('tsc --noEmit');
  });

  test('preserves a custom existing signal-source:TS script (no overwrite)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {'signal-source:TS': 'tsc --noEmit --strict'},
        },
      }),
    );
    await runTsconfigSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.['signal-source:TS']).toBe('tsc --noEmit --strict');
  });

  test('preserves existing devDep version mismatch without --force (warns + skips)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {typescript: '5.0.0'},
        },
      }),
    );
    const exitCode = await runTsconfigSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    // typescript is preserved at the existing version (not overwritten)
    expect(pkg.devDependencies?.typescript).toBe('5.0.0');
    // @types/bun is added (was missing)
    expect(pkg.devDependencies?.['@types/bun']).toBe(PINNED['@types/bun']);
  });

  test('--force overwrites mismatched devDep versions', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {typescript: '5.0.0'},
        },
      }),
    );
    await runTsconfigSetup({projectRoot: sb.path, quiet: true, force: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.typescript).toBe(PINNED.typescript);
  });
});
