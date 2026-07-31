/**
 * E2E tests for `justin-sdk add beads`.
 *
 * Tests run in isolated tmp directories. Each test gets a fresh sandbox.
 *
 * Tests that require a real `br` binary are marked with [needs-br] and
 * skipped if br is not on PATH. For full coverage, ensure br is installed
 * before running.
 */

import {describe, test, expect, afterEach, beforeAll} from 'bun:test';
import {execSync} from 'child_process';
import {existsSync, readdirSync, readFileSync} from 'fs';
import {join} from 'path';

import {runBeadsSetup} from '../src/beads-setup';
import {kebabCase} from '../src/setup-helpers';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

let hasBr = false;

beforeAll(() => {
  try {
    execSync('br --version', {stdio: ['pipe', 'pipe', 'pipe']});
    hasBr = true;
  } catch {
    hasBr = false;
  }
});

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

// ---------------------------------------------------------------------------
// File-only tests (no br required)
// ---------------------------------------------------------------------------

describe('beads-setup (file operations)', () => {
  test('creates mise.toml in fresh project', async () => {
    if (!hasBr) return; // full run requires br for install step
    const sb = track(createProjectSandbox());
    const exitCode = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const miseToml = readFileSync(join(sb.path, 'mise.toml'), 'utf-8');
    expect(miseToml).toContain('beads_rust');
    expect(miseToml).toContain('exe = "br"');
  });

  // beads-setup is tooling-only: guidance lives in the prompts repo and is
  // injected by the `prime` SessionStart hook. It must not write any prompt
  // files into the project. See home-base-t6a0.14.
  test('writes no prompt files (no AGENTS.md, no docs/prompts/BEADS.md)', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    expect(existsSync(join(sb.path, 'docs/prompts/BEADS.md'))).toBe(false);
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(false);
  });

  test('leaves an existing CLAUDE.md byte-for-byte untouched', async () => {
    if (!hasBr) return;
    const originalClaudeMd = '# Test Project\n\nSome existing content.\n';
    const sb = track(createProjectSandbox({claudeMd: originalClaudeMd}));

    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const updated = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    expect(updated).toBe(originalClaudeMd);
    expect(updated).not.toContain('@AGENTS.md');
  });

  test('idempotent: repeated runs still add no @AGENTS.md reference', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox({claudeMd: '# Test\n'}));

    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const content = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('# Test\n');
  });

  test('adds .beads to .prettierignore (creates if missing)', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const content = readFileSync(join(sb.path, '.prettierignore'), 'utf-8');
    expect(content).toContain('.beads');
  });

  test('idempotent: second run does not duplicate .prettierignore entry', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const content = readFileSync(join(sb.path, '.prettierignore'), 'utf-8');
    const occurrences = content.match(/^\.beads$/gm) ?? [];
    expect(occurrences.length).toBe(1);
  });

  test('adds br to .claude/settings.json sandbox exclusions', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {sandbox?: {excludedCommands?: string[]}};
    expect(settings.sandbox?.excludedCommands).toContain('br');
  });

  test('preserves existing .claude/settings.json contents', async () => {
    if (!hasBr) return;
    const sb = track(
      createProjectSandbox({
        packageJson: {name: 'test-project', version: '0.0.1'},
      }),
    );
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {allow: ['Bash(ls:*)']},
        sandbox: {excludedCommands: ['gh']},
      }),
    );
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {
      permissions?: {allow?: string[]};
      sandbox?: {excludedCommands?: string[]};
    };
    expect(settings.permissions?.allow).toContain('Bash(ls:*)');
    expect(settings.sandbox?.excludedCommands).toContain('gh');
    expect(settings.sandbox?.excludedCommands).toContain('br');
  });

  test('adds beads-setup to justin-sdk.config.json components', async () => {
    if (!hasBr) return;
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {version: '0.2.0', components: ['base-setup']},
      }),
    );
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('beads-setup');
  });
});

// ---------------------------------------------------------------------------
// Full install tests (require br)
// ---------------------------------------------------------------------------

describe('beads-setup (full install)', () => {
  test('initializes beads_rust workspace with correct prefix', async () => {
    if (!hasBr) {
      console.log('  (skipped — br not installed)');
      return;
    }
    const sb = track(createProjectSandbox());
    const exitCode = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // .beads/beads.db should exist
    expect(existsSync(join(sb.path, '.beads/beads.db'))).toBe(true);
    // AGENTS.md is deliberately NOT generated (tooling-only setup)
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(false);

    // Config should have the (kebab-cased) directory name as prefix. br init
    // derives the prefix via kebabCase(basename), which lowercases — so compare
    // against the transformed name, not the raw mixed-case mkdtemp suffix.
    const config = readFileSync(join(sb.path, '.beads/config.yaml'), 'utf-8');
    const dirName = sb.path.split('/').pop() ?? '';
    expect(config).toContain(`issue_prefix: ${kebabCase(dirName)}`);
  });

  test('no stray AGENTS.md.bak in project root after run (home-base-s9p)', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    expect(existsSync(join(sb.path, 'AGENTS.md.bak'))).toBe(false);
  });

  // We used to detect stale `bd`-era AGENTS.md, back it up to tmp/, and
  // regenerate it via `br agents --add --force`. That whole path is gone: an
  // existing AGENTS.md is now none of beads-setup's business. Removing an
  // AGENTS.md a project no longer wants is `migrate-to-prime`'s job.
  test('leaves a pre-existing AGENTS.md untouched and makes no backup', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    const staleAgentsMd = `# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run \`bd onboard\` to get started.

<!-- END BEADS INTEGRATION -->
`;
    sb.writeFile('AGENTS.md', staleAgentsMd);

    const exitCode = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // Untouched, byte for byte — we neither rewrite nor delete it.
    expect(readFileSync(join(sb.path, 'AGENTS.md'), 'utf-8')).toBe(
      staleAgentsMd,
    );

    // And no backup was written to tmp/.
    const tmpDir = join(sb.path, 'tmp');
    if (existsSync(tmpDir)) {
      const tmpFiles = readdirSync(tmpDir).filter((f) =>
        f.startsWith('AGENTS.md.bd-backup-'),
      );
      expect(tmpFiles.length).toBe(0);
    }
  });

  test('fully idempotent: two runs produce same end state (exit 0)', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox({claudeMd: '# Test\n'}));

    const first = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    const second = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });

    expect(first).toBe(0);
    expect(second).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Safety tests
// ---------------------------------------------------------------------------

describe('beads-setup (safety)', () => {
  test('does not overwrite working beads_rust db on rerun', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    // Create a bead so we can verify the db is preserved
    execSync(`br create --title "Test bead" --type task --priority 2`, {
      cwd: sb.path,
      // env: process.env so the mise trust prefix set in sandbox.ts reaches br
      // (Bun's execSync ignores later process.env mutations unless env is given).
      env: process.env,
    });

    // Second run should not wipe the db
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const list = execSync('br list --json', {
      cwd: sb.path,
      encoding: 'utf-8',
      env: process.env,
    });
    const parsed = JSON.parse(list) as {issues?: Array<{title?: string}>};
    expect(parsed.issues?.some((i) => i.title === 'Test bead')).toBe(true);
  });

  test('runs successfully with no CLAUDE.md (warns, does not crash)', async () => {
    if (!hasBr) return;
    const sb = track(createSandbox());
    sb.writeFile('package.json', JSON.stringify({name: 'no-claude-md'}));

    const exitCode = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    expect(exitCode).toBe(0);
    // No prompt files are written at all — guidance comes from the prime hook.
    expect(existsSync(join(sb.path, 'docs/prompts/BEADS.md'))).toBe(false);
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(false);
    // CLAUDE.md was not created
    expect(existsSync(join(sb.path, 'CLAUDE.md'))).toBe(false);
  });
});
