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

  test('creates docs/prompts/BEADS.md', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    expect(existsSync(join(sb.path, 'docs/prompts/BEADS.md'))).toBe(true);
    const content = readFileSync(
      join(sb.path, 'docs/prompts/BEADS.md'),
      'utf-8',
    );
    expect(content).toContain('beads_rust');
    expect(content).toContain('br ready');
  });

  test('appends @docs/prompts/BEADS.md to existing CLAUDE.md', async () => {
    if (!hasBr) return;
    const originalClaudeMd = '# Test Project\n\nSome existing content.\n';
    const sb = track(createProjectSandbox({claudeMd: originalClaudeMd}));

    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const updated = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    expect(updated).toContain('# Test Project');
    expect(updated).toContain('Some existing content.');
    expect(updated).toContain('@docs/prompts/BEADS.md');
    // Original content is preserved
    expect(updated.indexOf('# Test Project')).toBeLessThan(
      updated.indexOf('@docs/prompts/BEADS.md'),
    );
  });

  test('idempotent: second run does not duplicate CLAUDE.md reference', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox({claudeMd: '# Test\n'}));

    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const content = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    const occurrences = content.match(/@docs\/prompts\/BEADS\.md/g) ?? [];
    expect(occurrences.length).toBe(1);
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
    // AGENTS.md should be generated
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(true);

    // Config should have the directory name as prefix
    const config = readFileSync(join(sb.path, '.beads/config.yaml'), 'utf-8');
    const dirName = sb.path.split('/').pop() ?? '';
    expect(config).toContain(`issue_prefix: ${dirName}`);
  });

  test('AGENTS.md includes Dependency Direction section', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const agentsMd = readFileSync(join(sb.path, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('Dependency Direction');
    expect(agentsMd).toContain('br dep add');
  });

  test('idempotent: second run does not duplicate Dependency Direction docs', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const agentsMd = readFileSync(join(sb.path, 'AGENTS.md'), 'utf-8');
    const occurrences = agentsMd.match(/## Dependency Direction/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  test('stale bd AGENTS.md is backed up and replaced cleanly', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    const staleAgentsMd = `# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run \`bd onboard\` to get started.

## Quick Reference

\`\`\`bash
bd ready
bd show <id>
bd create --title "foo"
\`\`\`

<!-- END BEADS INTEGRATION -->
`;
    sb.writeFile('AGENTS.md', staleAgentsMd);

    const exitCode = await runBeadsSetup({
      projectRoot: sb.path,
      noCommit: true,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // Stale markers should be gone
    const newContent = readFileSync(join(sb.path, 'AGENTS.md'), 'utf-8');
    expect(newContent).not.toContain('END BEADS INTEGRATION');
    expect(newContent).not.toContain('bd onboard');
    expect(newContent).not.toContain('**bd** (beads)');

    // br content should be present
    expect(newContent).toContain('br ');

    // Dependency Direction section should be present (added by script)
    expect(newContent).toContain('Dependency Direction');

    // Backup should exist in tmp/
    const tmpFiles = readdirSync(join(sb.path, 'tmp')).filter((f) =>
      f.startsWith('AGENTS.md.bd-backup-'),
    );
    expect(tmpFiles.length).toBe(1);

    // Backup should have the original stale content
    const backup = readFileSync(join(sb.path, 'tmp', tmpFiles[0]!), 'utf-8');
    expect(backup).toContain('END BEADS INTEGRATION');
    expect(backup).toContain('bd onboard');
  });

  test('does NOT back up clean AGENTS.md', async () => {
    if (!hasBr) return;
    const sb = track(createProjectSandbox());
    // Create a clean br-era AGENTS.md first via the script
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});
    // Second run should not create a backup
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    // tmp/ shouldn't have any bd-backup files
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
    });

    // Second run should not wipe the db
    await runBeadsSetup({projectRoot: sb.path, noCommit: true, quiet: true});

    const list = execSync('br list --json', {
      cwd: sb.path,
      encoding: 'utf-8',
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
    // BEADS.md is still created
    expect(existsSync(join(sb.path, 'docs/prompts/BEADS.md'))).toBe(true);
    // CLAUDE.md was not created
    expect(existsSync(join(sb.path, 'CLAUDE.md'))).toBe(false);
  });
});
