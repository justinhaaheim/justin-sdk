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

import {runMigrateToPrime} from '../src/migrate-to-prime';
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
  test('removes the prime hook, preserves setup-env, and is idempotent', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(
      join(sb.path, '.claude/settings.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {type: 'command', command: 'bun run scripts/setup-env.ts'},
                  {
                    type: 'command',
                    command: 'bunx justin-sdk prime --format hook',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    commitAll(sb);

    expect(migrate(sb)).toBe(0);
    const cmds = sessionStartCommands(sb);
    // prime hook gone
    expect(cmds.some((c) => c.includes('justin-sdk prime'))).toBe(false);
    // setup-env preserved
    expect(cmds.some((c) => c.includes('setup-env'))).toBe(true);

    // Idempotent: a second run is a no-op (still no prime, setup-env intact).
    migrate(sb);
    const cmds2 = sessionStartCommands(sb);
    expect(cmds2.filter((c) => c.includes('justin-sdk prime'))).toHaveLength(0);
    expect(cmds2.some((c) => c.includes('setup-env'))).toBe(true);
  });

  test('drops the SessionStart key when the prime hook was its only entry', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(
      join(sb.path, '.claude/settings.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'bunx justin-sdk prime --format hook',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    commitAll(sb);

    migrate(sb);
    const s = readSettings(sb);
    // emptied group dropped -> SessionStart removed entirely
    expect(s.hooks?.SessionStart ?? []).toHaveLength(0);
    expect(
      sessionStartCommands(sb).some((c) => c.includes('justin-sdk prime')),
    ).toBe(false);
  });

  test('is a no-op when settings.json has no prime hook', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(join(sb.path, '.claude/settings.json'), '{}');
    commitAll(sb);

    migrate(sb);
    // no prime hook was present; file untouched, working tree stays clean
    expect(git(sb.path, 'status --porcelain -- .claude/settings.json')).toBe(
      '',
    );
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

  test('flags (does not delete) an unknown-named file in docs/prompts', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    mkdirSync(join(sb.path, 'docs/prompts'), {recursive: true});
    writeFileSync(join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES.md'), 'x\n');
    writeFileSync(
      join(sb.path, 'docs/prompts/PROJECT_SPECIFIC.md'),
      'unique\n',
    );
    commitAll(sb);

    migrate(sb);
    // dir stays because a flagged file remains; the unknown file is preserved,
    // the known file may be removed but the dir is not.
    expect(existsSync(join(sb.path, 'docs/prompts/PROJECT_SPECIFIC.md'))).toBe(
      true,
    );
    expect(existsSync(join(sb.path, 'docs/prompts'))).toBe(true);
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
