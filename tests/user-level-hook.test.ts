/**
 * The user-level hook pair doctor tells Justin to paste (home-base-39co9.4, M5;
 * acceptance criterion 5).
 *
 * Since the repo state moved to the first prompt, the SessionStart half alone
 * delivers nothing: it arms, and only the UserPromptSubmit half fires. So the
 * JSON doctor prints carries both, and a machine with only the older one-hook
 * snippet is told — by name — which half it is missing.
 *
 * `checkUserLevelSessionStart` reads `~/.claude/settings.json` through
 * `os.homedir()`, so every case here points HOME at a throwaway directory and
 * never reads Justin's real file.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-39co9.4): dropping the
 * `UserPromptSubmit` key from USER_LEVEL_HOOK_JSON fails "the JSON carries both
 * hooks" and "doctor prints the JSON with the UserPromptSubmit entry".
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {
  checkUserLevelSessionStart,
  USER_LEVEL_HOOK_COMMAND,
  USER_LEVEL_HOOK_JSON,
  USER_LEVEL_PROMPT_HOOK_COMMAND,
} from '../src/user-level-hook';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const SAVED_HOME = process.env.HOME;
const sandboxes: Sandbox[] = [];
afterEach(() => {
  process.env.HOME = SAVED_HOME;
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function homeWithSettings(settings: unknown): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  if (settings != null) {
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(
      join(sb.path, '.claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }
  return sb.path;
}

const hookEntry = (command: string): unknown => ({
  hooks: [{command, type: 'command'}],
});

describe('USER_LEVEL_HOOK_JSON', () => {
  test('the JSON carries both hooks, each behind the enrolment guard', () => {
    const parsed = JSON.parse(USER_LEVEL_HOOK_JSON) as {
      hooks: Record<string, {hooks: {command: string}[]}[]>;
    };
    expect(parsed.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(
      USER_LEVEL_HOOK_COMMAND,
    );
    expect(parsed.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      USER_LEVEL_PROMPT_HOOK_COMMAND,
    );
    expect(USER_LEVEL_PROMPT_HOOK_COMMAND).toBe(
      '[ -e "${CLAUDE_PROJECT_DIR:-.}/justin-sdk.config.json" ] || ! command -v justin-sdk-latest >/dev/null || justin-sdk-latest repo-state --hook --user-level',
    );
  });
});

describe('checkUserLevelSessionStart', () => {
  test('both hooks present: installed', () => {
    process.env.HOME = homeWithSettings({
      hooks: {
        SessionStart: [hookEntry(USER_LEVEL_HOOK_COMMAND)],
        UserPromptSubmit: [hookEntry(USER_LEVEL_PROMPT_HOOK_COMMAND)],
      },
    });
    expect(checkUserLevelSessionStart().status).toBe('installed');
  });

  test('only the older SessionStart snippet: absent, naming the missing half', () => {
    process.env.HOME = homeWithSettings({
      hooks: {SessionStart: [hookEntry(USER_LEVEL_HOOK_COMMAND)]},
    });
    const result = checkUserLevelSessionStart();
    expect(result.status).toBe('absent');
    expect(result.message).toContain('repo-state --hook --user-level');
    expect(result.message).not.toContain('`session-start --user-level`');
  });

  test('an unreadable file is cannot-check, never absent', () => {
    const home = homeWithSettings(null);
    mkdirSync(join(home, '.claude'), {recursive: true});
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    process.env.HOME = home;
    expect(checkUserLevelSessionStart().status).toBe('cannot-check');
  });
});

describe('doctor USER_LEVEL_SESSION_START', () => {
  test('doctor prints the JSON with the UserPromptSubmit entry', () => {
    const home = homeWithSettings({
      hooks: {SessionStart: [hookEntry(USER_LEVEL_HOOK_COMMAND)]},
    });
    const repoSb = createSandbox();
    sandboxes.push(repoSb);
    const repo = repoSb.path;
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(
      join(repo, 'justin-sdk.config.json'),
      `${JSON.stringify({components: ['base-setup']}, null, 2)}\n`,
    );
    writeFileSync(
      join(repo, 'package.json'),
      `${JSON.stringify({name: 'p'}, null, 2)}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '..', 'src', 'cli.ts'), 'doctor'],
      {
        cwd: repo,
        encoding: 'utf-8',
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          NO_COLOR: '1',
          XDG_CONFIG_HOME: join(home, 'config'),
        },
      },
    );
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('USER_LEVEL_SESSION_START');
    expect(out).toContain('"UserPromptSubmit"');
    expect(out).toContain('justin-sdk-latest repo-state --hook --user-level');
  });
});
