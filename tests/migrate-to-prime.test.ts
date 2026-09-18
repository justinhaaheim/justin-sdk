/**
 * Tests for migrate-to-prime — the one-time migration from committed guidance
 * (docs/prompts/ + AGENTS.md + CLAUDE.md @-refs) to the prime SessionStart hook.
 *
 * Uses real git repos in a sandbox because the deletion-safety predicate is
 * "git-tracked AND clean".
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {execSync} from 'child_process';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';

import {
  BESPOKE_DELETED_PREFIX,
  runMigrateToPrime,
} from '../src/migrate-to-prime';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const AGENTS_MARKER = '<!-- br-agent-instructions-v1 -->';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {cwd, encoding: 'utf-8'}).trim();
}

function initRepo(sb: Sandbox): void {
  git(sb.path, 'init -q -b main');
  git(sb.path, 'config user.email test@example.com');
  git(sb.path, 'config user.name Test');
}

function commitAll(sb: Sandbox): void {
  git(sb.path, 'add -A');
  git(sb.path, 'commit -q -m snapshot');
}

function migrate(sb: Sandbox): number {
  return runMigrateToPrime({projectRoot: sb.path, quiet: true});
}

/**
 * Run the migration VERBOSE and capture stdout, so a test can assert the lines
 * it prints rather than only the files it leaves behind.
 */
function migrateCapturingOutput(sb: Sandbox): string {
  const lines: string[] = [];
  const originals = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const capture =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
  console.log = capture();
  console.warn = capture();
  console.error = capture();
  try {
    runMigrateToPrime({projectRoot: sb.path, quiet: false});
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return lines.join('\n');
}

function readSettings(sb: Sandbox): {
  hooks?: {SessionStart?: {hooks?: {command?: string}[]}[]};
} {
  return JSON.parse(
    readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
  ) as {hooks?: {SessionStart?: {hooks?: {command?: string}[]}[]}};
}

function sessionStartCommands(sb: Sandbox): string[] {
  const s = readSettings(sb);
  return (s.hooks?.SessionStart ?? []).flatMap((g) =>
    (g.hooks ?? []).map((h) => h.command ?? ''),
  );
}

describe('migrate-to-prime', () => {
  /**
   * The INVERSE of what three tests here used to assert (dchjw.8, D6).
   *
   * Until the `prime` plugin was retired this migration stripped per-project
   * `justin-sdk prime` SessionStart hooks, because the plugin injected the same
   * guidance globally. The plugin is gone and the per-project hook IS the
   * mechanism now, so a migration that still edited `.claude/settings.json`
   * would tear out what base-setup installs. It must leave the file alone —
   * including a legacy `prime` hook, whose replacement is base-setup's job.
   */
  test('never touches .claude/settings.json, even one carrying a legacy prime hook', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    const settings = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {command: 'bun run scripts/setup-env.ts', type: 'command'},
                {
                  command: 'bunx justin-sdk prime --format hook',
                  type: 'command',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    writeFileSync(join(sb.path, '.claude/settings.json'), settings);
    commitAll(sb);

    expect(migrate(sb)).toBe(0);
    // Byte-identical, and git agrees nothing changed.
    expect(readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8')).toBe(
      settings,
    );
    expect(git(sb.path, 'status --porcelain -- .claude/settings.json')).toBe(
      '',
    );
    expect(sessionStartCommands(sb)).toHaveLength(2);
  });

  test('removes docs/prompts when all files are known + tracked + clean', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, 'docs/prompts'), {recursive: true});
    writeFileSync(join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES.md'), 'x\n');
    writeFileSync(join(sb.path, 'docs/prompts/S2T_GUIDELINES.md'), 'y\n');
    commitAll(sb);

    migrate(sb);
    expect(existsSync(join(sb.path, 'docs/prompts'))).toBe(false);
  });

  test('deletes an unknown-named file too, and NAMES it as it goes (AC 11)', () => {
    // Justin, 2026-09-18: "Delete the docs/prompts directory … If you encounter
    // any other files that seem bespoke or whatever let me know in your report
    // back, but you can still delete them." The line is the "let me know".
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, 'docs/prompts'), {recursive: true});
    writeFileSync(join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES.md'), 'x\n');
    writeFileSync(
      join(sb.path, 'docs/prompts/PROJECT_SPECIFIC.md'),
      'unique\n',
    );
    writeFileSync(
      join(sb.path, 'docs/.prompts-installed-from.json'),
      '{"sha":"deadbeef"}\n',
    );
    commitAll(sb);

    const output = migrateCapturingOutput(sb);

    expect(output).toContain(
      `${BESPOKE_DELETED_PREFIX}docs/prompts/PROJECT_SPECIFIC.md`,
    );
    // A recognised name is deleted QUIETLY — the line is reserved for the ones
    // he has to look at.
    expect(output).not.toContain(
      `${BESPOKE_DELETED_PREFIX}docs/prompts/IMPORTANT_GUIDELINES.md`,
    );
    expect(existsSync(join(sb.path, 'docs/prompts'))).toBe(false);
    expect(existsSync(join(sb.path, 'docs/.prompts-installed-from.json'))).toBe(
      false,
    );
    // The claim in the line is TRUE: the deletion is recoverable from git.
    expect(git(sb.path, 'show HEAD:docs/prompts/PROJECT_SPECIFIC.md')).toBe(
      'unique',
    );
  });

  test('NEGATIVE CONTROL: an UNTRACKED bespoke file is kept, not deleted-and-named', () => {
    // The printed line claims the bytes are recoverable from git history. For an
    // untracked file that claim would be false, so the file survives and is
    // flagged instead — and the directory survives with it.
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, 'docs/prompts'), {recursive: true});
    writeFileSync(join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES.md'), 'x\n');
    commitAll(sb);
    writeFileSync(join(sb.path, 'docs/prompts/NEVER_COMMITTED.md'), 'mine\n');

    const output = migrateCapturingOutput(sb);

    expect(output).not.toContain(
      `${BESPOKE_DELETED_PREFIX}docs/prompts/NEVER_COMMITTED.md`,
    );
    expect(existsSync(join(sb.path, 'docs/prompts/NEVER_COMMITTED.md'))).toBe(
      true,
    );
    expect(existsSync(join(sb.path, 'docs/prompts'))).toBe(true);
    expect(output).toContain('untracked');
  });

  test('flags (does not delete) an untracked docs/prompts file', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, 'docs/prompts'), {recursive: true});
    writeFileSync(join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES.md'), 'x\n');
    commitAll(sb);
    // Now add an untracked known-named file.
    writeFileSync(
      join(sb.path, 'docs/prompts/S2T_GUIDELINES.md'),
      'untracked\n',
    );

    migrate(sb);
    expect(existsSync(join(sb.path, 'docs/prompts/S2T_GUIDELINES.md'))).toBe(
      true,
    );
  });

  test('deletes AGENTS.md when it is only the generated beads block', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    writeFileSync(
      join(sb.path, 'AGENTS.md'),
      `# Agent Instructions\n\n${AGENTS_MARKER}\n\n## Beads workflow (br)\nbr ready\n`,
    );
    commitAll(sb);

    migrate(sb);
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(false);
  });

  test('flags (does not delete) AGENTS.md with hand-written content before the marker', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    writeFileSync(
      join(sb.path, 'AGENTS.md'),
      `# Expo HAS CHANGED\n\nRead the versioned docs before writing code.\n\n${AGENTS_MARKER}\n\n## Beads workflow (br)\nbr ready\n`,
    );
    commitAll(sb);

    migrate(sb);
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(true);
  });

  test('flags (does not delete) an AGENTS.md with no beads marker', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    writeFileSync(
      join(sb.path, 'AGENTS.md'),
      '# Hand-written agent notes\nstuff\n',
    );
    commitAll(sb);

    migrate(sb);
    expect(existsSync(join(sb.path, 'AGENTS.md'))).toBe(true);
  });

  test('removes standalone @-ref lines from CLAUDE.md, keeps prose (flagged)', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    writeFileSync(
      join(sb.path, 'CLAUDE.md'),
      [
        '# My Project',
        '',
        'Some real content.',
        '',
        'Always follow the important guidelines in @docs/prompts/IMPORTANT_GUIDELINES_INLINED.md',
        '@docs/prompts/BEADS.md',
        '@AGENTS.md',
        '',
      ].join('\n'),
    );
    commitAll(sb);

    migrate(sb);
    const claude = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    // standalone lines gone
    expect(claude).not.toContain('@docs/prompts/BEADS.md');
    expect(claude).not.toContain('\n@AGENTS.md');
    // real content preserved
    expect(claude).toContain('Some real content.');
    // prose-embedded ref preserved (flagged, not stripped)
    expect(claude).toContain(
      'Always follow the important guidelines in @docs/prompts/IMPORTANT_GUIDELINES_INLINED.md',
    );
  });

  test('removes obsolete components from justin-sdk.config.json', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify(
        {
          version: '0.6.1',
          components: ['base-setup', 'beads-setup', 'claude-md-setup'],
          lastSynced: '2026-06-24',
        },
        null,
        2,
      ),
    );
    commitAll(sb);

    migrate(sb);
    const cfg = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components: string[]};
    expect(cfg.components).toContain('base-setup');
    expect(cfg.components).toContain('beads-setup');
    expect(cfg.components).not.toContain('claude-md-setup');
  });

  test('is a no-op second time (idempotent end-to-end)', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(join(sb.path, '.claude/settings.json'), '{}');
    writeFileSync(join(sb.path, 'CLAUDE.md'), '# P\n\n@AGENTS.md\n');
    writeFileSync(
      join(sb.path, 'AGENTS.md'),
      `${AGENTS_MARKER}\n## Beads workflow (br)\n`,
    );
    commitAll(sb);

    migrate(sb);
    commitAll(sb);
    // second run: nothing to do
    migrate(sb);
    const status = git(sb.path, 'status --porcelain');
    expect(status).toBe('');
  });
});
