/**
 * The PROJECT arm of `session-start`: doctor's report reaches JUSTIN, and the
 * output carries no ANSI (epic home-base-dchjw.9; home-base-39co9.4 M2/M3).
 *
 * Pinned here:
 *
 *  - Doctor's output used to be captured by monkey-patching `console.log` AND
 *    `process.stdout.write` around `runDoctor` (both, because in Bun they are
 *    independent channels). `renderDoctor` returns the text instead, so stdout
 *    belongs to the JSON envelope by construction rather than by a global
 *    side effect installed in front of arbitrary check code.
 *  - Since home-base-39co9.4 (M2) the report is Justin's to act on, so it goes
 *    into `systemMessage` and NOT into Claude's context.
 *  - No ANSI anywhere in the JSON. `additionalContext` never carried it
 *    (dchjw.9: escapes in a model's context are noise); `systemMessage` now
 *    carries doctor's coloured report, and whether Claude Code renders colour
 *    codes there is untested, so the shared helper strips them too.
 *
 * Driven through the real CLI, spawned the way `sh` spawns the hook, because
 * "stdout is exactly one JSON object" is the property under test and only a real
 * process can show it.
 */

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {git} from './git-fixtures';
import {createSandbox} from './sandbox';

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
        XDG_STATE_HOME: join(home.path, 'state'),
      },
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'envelope-test',
        source: 'startup',
      }),
    });
    return {status: 0, stdout};
  } finally {
    home.cleanup();
  }
}

describe('session-start emits one clean envelope', () => {
  test('stdout is exactly one JSON object, and doctor is in Justin’s half', () => {
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
    const message = parsed.systemMessage ?? '';
    // Doctor's report really is in there — a check label only doctor emits.
    expect(message).toContain('CLAUDE_MD');
    expect(message).toContain('Ran ');
    // …and not in Claude's context (M2).
    expect(parsed.hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'CLAUDE_MD',
    );
  });

  test('the envelope carries NO ANSI escape, in either half', () => {
    const root = enrolledRepo();
    const out = runSessionStart(root).stdout;
    expect(out).not.toContain(ESC);
    // NEGATIVE CONTROL for the assertion itself: the text it is asserting over
    // is the text that WOULD have carried the escapes. A doctor report renders
    // its verdict markers in colour, so their presence proves this is the real
    // coloured report with the codes removed, not an empty string.
    const parsed = JSON.parse(out) as {systemMessage?: string};
    expect(parsed.systemMessage ?? '').toMatch(/[✓✗⚠]/);
  });
});
