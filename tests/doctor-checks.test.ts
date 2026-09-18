/**
 * The doctor changes from epic home-base-dchjw.9.
 *
 *  - GITIGNORE_HAS_ENV is GONE. The gitignore baseline stopped seeding `.env`
 *    in dchjw.6, so the check warned on every correct repo with a fix command
 *    that could not make it green.
 *  - ESLINT_CONFIG_UNIQUE warns when two flat configs are present. ESLint loads
 *    the first name it resolves and the rest are dead code, which looks
 *    authoritative in an editor and does nothing.
 *  - COMPONENTS_AVAILABLE is an INFO line: a component whose predicates pass
 *    here and which is not installed. It never fails.
 *  - Fix advice is prefixed with `bun install && ` where the repo has no
 *    `node_modules/.bin/justin-sdk`, because `bun run justin-sdk …` cannot
 *    resolve there and the advice would be a dead end.
 *
 * Driven through `renderDoctor` rather than the CLI: these assertions are about
 * the REPORT TEXT, and renderDoctor is now the thing that produces it (the CLI
 * prints exactly what it returns).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stripAnsi} from '../src/check-runner';
import {renderDoctor} from '../src/doctor';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

interface ProjectOptions {
  config?: Record<string, unknown>;
  /** Extra files, relative path → contents. */
  files?: Record<string, string>;
  /** Create a fake node_modules/.bin/justin-sdk so fixes are runnable. */
  hydrated?: boolean;
  packageJson?: Record<string, unknown>;
}

function project(options: ProjectOptions = {}): string {
  const box = createSandbox();
  sandboxes.push(box);
  box.writeFile('CLAUDE.md', '# test project\n');
  box.writeFile(
    'package.json',
    JSON.stringify(
      options.packageJson ?? {
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
    JSON.stringify(options.config ?? {components: ['base-setup']}, null, 2) +
      '\n',
  );
  for (const [path, content] of Object.entries(options.files ?? {})) {
    box.writeFile(path, content);
  }
  if (options.hydrated === true) {
    mkdirSync(join(box.path, 'node_modules', '.bin'), {recursive: true});
    writeFileSync(
      join(box.path, 'node_modules', '.bin', 'justin-sdk'),
      '#!/bin/sh\n',
    );
  }
  return box.path;
}

async function report(root: string): Promise<string> {
  const run = await renderDoctor(root, {});
  return stripAnsi(run.report);
}

describe('GITIGNORE_HAS_ENV is retired', () => {
  test('a .gitignore with no .env line produces no ENV check at all', async () => {
    const out = await report(
      project({
        config: {components: ['gitignore-setup']},
        files: {'.gitignore': 'node_modules/\ntmp/\n*.local\n'},
      }),
    );
    expect(out).not.toContain('GITIGNORE_HAS_ENV');
    expect(out).not.toContain('.gitignore missing .env');
    // NEGATIVE CONTROL: its siblings still run, so this is the check being
    // absent rather than the whole gitignore component being skipped.
    expect(out).toContain('GITIGNORE_HAS_NODE_MODULES');
    expect(out).toContain('GITIGNORE_HAS_TMP');
  });
});

describe('ESLINT_CONFIG_UNIQUE', () => {
  const ESLINT_PKG = {
    devDependencies: {
      eslint: '0.0.0',
      'eslint-config-jha-react-node': '0.0.0',
    },
    name: 'test-project',
    scripts: {
      doctor: 'true',
      'fix-source:LINT': 'true',
      'setup-env': 'true',
      signal: 'true',
      'signal-source:LINT': 'true',
    },
    version: '0.0.1',
  };

  test('two flat configs WARN, name both, and say which one ESLint reads', async () => {
    const out = await report(
      project({
        config: {components: ['eslint-setup']},
        files: {
          'eslint.config.cjs': 'module.exports = [];\n',
          'eslint.config.js': 'export default [];\n',
        },
        packageJson: ESLINT_PKG,
      }),
    );
    expect(out).toContain('⚠ ESLINT_CONFIG_UNIQUE');
    expect(out).toContain('2 flat configs present');
    expect(out).toContain('eslint.config.js, eslint.config.cjs');
    // ESLint's own resolution order puts .js first, so that is the live one.
    expect(out).toContain('ESLint loads only eslint.config.js');
  });

  test('NEGATIVE CONTROL: one flat config passes', async () => {
    const out = await report(
      project({
        config: {components: ['eslint-setup']},
        files: {'eslint.config.cjs': 'module.exports = [];\n'},
        packageJson: ESLINT_PKG,
      }),
    );
    expect(out).toContain('✓ ESLINT_CONFIG_UNIQUE');
    expect(out).not.toContain('flat configs present');
  });

  test('it is WARN severity — two configs must not fail a sweep gate', async () => {
    const run = await renderDoctor(
      project({
        config: {components: ['eslint-setup']},
        files: {
          'eslint.config.cjs': 'module.exports = [];\n',
          'eslint.config.mjs': 'export default [];\n',
        },
        packageJson: ESLINT_PKG,
      }),
      {},
    );
    expect(stripAnsi(run.report)).toContain('⚠ ESLINT_CONFIG_UNIQUE');
    expect(run.exitCode).toBe(0);
  });

  test('it offers no fixCommand — the remedy is a deletion only the author can choose', async () => {
    const out = await report(
      project({
        config: {components: ['eslint-setup']},
        files: {
          'eslint.config.cjs': 'module.exports = [];\n',
          'eslint.config.ts': 'export default [];\n',
        },
        packageJson: ESLINT_PKG,
      }),
    );
    expect(out).toContain('Fix: Delete all but one of');
    expect(out).not.toMatch(/Fix: Run: .*add eslint/);
  });
});

describe('COMPONENTS_AVAILABLE', () => {
  test('an Expo repo that lacks eas is told it applies here', async () => {
    const out = await report(
      project({
        config: {components: ['base-setup']},
        packageJson: {
          dependencies: {expo: '54.0.0'},
          name: 'test-app',
          scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
          version: '0.0.1',
        },
      }),
    );
    expect(out).toContain('COMPONENTS_AVAILABLE');
    expect(out).toContain('applies here but is not installed');
    expect(out).toMatch(/\beas\b/);
  });

  test('NEGATIVE CONTROL: a non-Expo repo is not told about eas', async () => {
    // Same fixture minus the expo dependency. Without this, the test above
    // would pass just as well if the check simply listed every component.
    const out = await report(project({config: {components: ['base-setup']}}));
    expect(out).toContain('COMPONENTS_AVAILABLE');
    expect(out).toContain('applies here but is not installed');
    expect(out).not.toMatch(/\beas\b/);
  });

  test('it never fails, even with components available', async () => {
    const run = await renderDoctor(
      project({
        config: {components: []},
        packageJson: {
          dependencies: {expo: '54.0.0'},
          name: 'test-app',
          scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
          version: '0.0.1',
        },
      }),
      {},
    );
    expect(stripAnsi(run.report)).toContain('✓ COMPONENTS_AVAILABLE');
  });
});

describe('fix advice is runnable in the repo it is printed for', () => {
  test('an unhydrated repo gets `bun install && ` in front of the SDK command', async () => {
    const out = await report(
      project({config: {components: ['gitignore-setup']}, hydrated: false}),
    );
    // GITIGNORE_EXISTS fails here: there is no .gitignore in the fixture.
    expect(out).toContain('✗ GITIGNORE_EXISTS');
    expect(out).toContain(
      'Fix: Run: bun install && bun run justin-sdk add gitignore',
    );
  });

  test('NEGATIVE CONTROL: a hydrated repo gets the bare command', async () => {
    const out = await report(
      project({config: {components: ['gitignore-setup']}, hydrated: true}),
    );
    expect(out).toContain('✗ GITIGNORE_EXISTS');
    expect(out).toContain('Fix: Run: bun run justin-sdk add gitignore');
    expect(out).not.toContain('bun install &&');
  });

  test('advice that is not an SDK command is left alone', async () => {
    const out = await report(
      project({
        config: {components: ['eslint-setup']},
        files: {
          'eslint.config.cjs': 'module.exports = [];\n',
          'eslint.config.js': 'export default [];\n',
        },
        hydrated: false,
        packageJson: {
          devDependencies: {
            eslint: '0.0.0',
            'eslint-config-jha-react-node': '0.0.0',
          },
          name: 'test-project',
          scripts: {'fix-source:LINT': 'true', 'signal-source:LINT': 'true'},
          version: '0.0.1',
        },
      }),
    );
    expect(out).toContain('Fix: Delete all but one of');
    expect(out).not.toContain('Delete all but one of bun install');
    // The bootstrap form is a THIRD invocation shape (D1) and is legitimate
    // precisely because it needs no node_modules — it must not be prefixed.
    expect(out).toContain(
      'Fix: Run: bunx github:justinhaaheim/justin-sdk setup-env',
    );
  });
});

describe('renderDoctor returns the report instead of printing it', () => {
  test('a refusal is part of the report, not a stderr line that vanishes', async () => {
    const box = createSandbox();
    sandboxes.push(box);
    // No justin-sdk.config.json at all.
    const run = await renderDoctor(box.path, {quiet: true});
    expect(run.exitCode).toBe(1);
    expect(run.report).toContain('justin-sdk.config.json not found');
  });

  test('an unparseable config reports that doctor DID NOT RUN', async () => {
    const box = createSandbox();
    sandboxes.push(box);
    box.writeFile('justin-sdk.config.json', '{not json');
    const run = await renderDoctor(box.path, {quiet: true});
    expect(run.exitCode).toBe(1);
    expect(run.report).toContain('NOT a clean bill of health');
  });

  test('a quiet all-pass run still says so, in the report', async () => {
    const run = await renderDoctor(project({config: {components: []}}), {
      quiet: true,
    });
    // It may warn (USER_LEVEL_SESSION_START warns on any machine without the
    // user-level hook), so assert on the report being non-empty and on the
    // exit code rather than on a specific verdict.
    expect(run.report.length).toBeGreaterThan(0);
    expect(run.exitCode).toBe(0);
  });
});
