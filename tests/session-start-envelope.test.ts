/**
 * The PROJECT arm of `session-start`: doctor's report reaches the envelope, and
 * the envelope carries no ANSI (epic home-base-dchjw.9).
 *
 * Two changes are pinned here, and they are two halves of one thing:
 *
 *  - Doctor's output used to be captured by monkey-patching `console.log` AND
 *    `process.stdout.write` around `runDoctor` (both, because in Bun they are
 *    independent channels). `renderDoctor` returns the text instead, so stdout
 *    belongs to the JSON envelope by construction rather than by a global
 *    side effect installed in front of arbitrary check code.
 *  - `additionalContext` is stripped of ANSI. It goes into the MODEL's context,
 *    not a terminal, where the escapes render as literal `[32m` noise and cost
 *    tokens for nothing. `systemMessage` — the half Justin actually reads in a
 *    terminal — keeps its colours.
 *
 * Driven through the real CLI, spawned the way `sh` spawns the hook, because
 * "stdout is exactly one JSON object" is the property under test and only a real
 * process can show it.
 */

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {createSandbox} from './sandbox';
import {git} from './git-fixtures';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const ESC = String.fromCharCode(27);

function initRepoAt(root: string): void {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
}

/** An ENROLLED repo — the project hook's own case. */
function enrolledRepo(): string {
  const sb = createSandbox();
  initRepoAt(sb.path);
  writeFileSync(
    join(sb.path, 'package.json'),
    `${JSON.stringify({name: 'p', version: '0.0.1'}, null, 2)}\n`,
  );
  writeFileSync(
    join(sb.path, 'justin-sdk.config.json'),
    `${JSON.stringify({components: ['base-setup']}, null, 2)}\n`,
  );
  return sb.path;
}

function runSessionStart(projectRoot: string): {
  status: number;
  stdout: string;
} {
  const home = createSandbox();
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'session-start'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: projectRoot,
        HOME: home.path,
        JSDK_PRIME_PRETTIER: '0',
        XDG_CONFIG_HOME: join(home.path, 'config'),
      },
    });
    return {status: 0, stdout};
  } finally {
    home.cleanup();
  }
}

describe('session-start emits one clean envelope', () => {
  test('stdout is exactly one JSON object and doctor is inside it', () => {
    const root = enrolledRepo();
    const run = runSessionStart(root);
    expect(run.status).toBe(0);
    // JSON.parse IS the assertion: anything doctor leaked onto stdout would
    // make this throw, which is precisely the failure the capture prevented
    // and `renderDoctor` now prevents structurally.
    const parsed = JSON.parse(run.stdout) as {
      hookSpecificOutput?: {additionalContext?: string};
      systemMessage?: string;
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? '';
    // Doctor's report really is in there — a check label only doctor emits.
    expect(context).toContain('CLAUDE_MD');
    expect(context).toContain('Ran ');
  });

  test('additionalContext carries NO ANSI escape', () => {
    const root = enrolledRepo();
    const parsed = JSON.parse(runSessionStart(root).stdout) as {
      hookSpecificOutput?: {additionalContext?: string};
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(context).not.toContain(ESC);
    // NEGATIVE CONTROL for the assertion itself: the text it is asserting over
    // is the text that WOULD have carried the escapes. A doctor report renders
    // its verdict markers in colour, so their presence proves this is the real
    // coloured report with the codes removed, not an empty string.
    expect(context).toMatch(/[✓✗⚠]/);
  });
});
