/**
 * The repo state reaches Claude on the FIRST PROMPT, not at session start
 * (home-base-39co9.4, M1; acceptance criterion 2).
 *
 * Driven end to end through the real CLI with the payloads Claude Code sends —
 * a SessionStart payload on stdin for `session-start`, a UserPromptSubmit one
 * for `repo-state --hook` — and no real Claude session. HOME, XDG_CONFIG_HOME
 * and XDG_STATE_HOME are throwaway directories, so the markers this writes can
 * never land in Justin's real state directory, and the prompts source is a
 * local fixture so nothing is fetched.
 *
 * NEGATIVE CONTROLS (run by hand, recorded on home-base-39co9.4):
 *  - making `claimFirstPrompt` skip writing `fired` fails "the second prompt
 *    gets nothing" (the second prompt injects the block again);
 *  - making `runSessionStart` skip `armFirstPrompt` fails "a resumed session
 *    gets it again on its next prompt" (the `fired` marker is never reset);
 *  - restoring the repo state to session-start's injection fails "SessionStart
 *    injects no repo state".
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {REPO_STATE_HOOK_COMMAND} from '../src/base-setup';
import {USER_LEVEL_PROMPT_HOOK_COMMAND} from '../src/user-level-hook';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const REPO_STATE_HEADER = '# Current repo state';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function initRepoAt(root: string, files: Record<string, string>): string {
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

interface World {
  env: Record<string, string>;
  home: string;
  repo: string;
  stateHome: string;
}

/**
 * An enrolled repo with one branch of unmerged work, so the repo-state block
 * has something specific in it, plus the prompts and HOME fixtures.
 */
/** A settings.json registering exactly one UserPromptSubmit command. */
function settingsWith(command: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{hooks: [{command, type: 'command'}]}],
      },
    },
    null,
    2,
  )}\n`;
}

function world(
  options: {enrolled?: boolean; promptHook?: boolean} = {},
): World {
  const enrolled = options.enrolled !== false;
  const promptHook = options.promptHook !== false;
  const sb = track(createSandbox());
  const prompts = initRepoAt(join(sb.path, 'prompts'), {
    'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
    'src/rules/index.md': '@./alpha.md',
  });
  const repo = initRepoAt(join(sb.path, 'repo'), {
    ...(enrolled
      ? {
          'justin-sdk.config.json': `${JSON.stringify({components: ['base-setup']}, null, 2)}\n`,
          // What base-setup writes (M5) — the hook session-start checks for
          // before it promises the repo state to the first prompt.
          ...(promptHook
            ? {'.claude/settings.json': settingsWith(REPO_STATE_HOOK_COMMAND)}
            : {}),
        }
      : {}),
    'package.json': `${JSON.stringify({name: 'fixture'}, null, 2)}\n`,
  });
  git(repo, ['checkout', '-qb', 'feature-early']);
  writeFileSync(join(repo, 'early.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'early work']);
  git(repo, ['checkout', '-q', 'main']);

  const home = join(sb.path, 'home');
  mkdirSync(join(home, '.claude'), {recursive: true});
  if (!enrolled && promptHook) {
    // An unenrolled repo is covered by the USER-level hook Justin pastes in.
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      settingsWith(USER_LEVEL_PROMPT_HOOK_COMMAND),
    );
  }
  const stateHome = join(sb.path, 'state');
  return {
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: repo,
      HOME: home,
      JSDK_PRIME_PRETTIER: '0',
      JSDK_PROMPTS_DIR: prompts,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: stateHome,
    },
    home,
    repo,
    stateHome,
  };
}

interface HookRun {
  additionalContext: string;
  hookEventName: string | null;
  status: number | null;
  stderr: string;
  stdout: string;
  systemMessage: string;
}

function run(w: World, args: string[], payload: unknown): HookRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: w.repo,
    encoding: 'utf-8',
    env: w.env,
    input: JSON.stringify(payload),
  });
  const stdout = result.stdout ?? '';
  // The contract is ONE JSON object or nothing. JSON.parse IS the assertion.
  const parsed =
    stdout.trim() === ''
      ? {}
      : (JSON.parse(stdout) as {
          hookSpecificOutput?: {
            additionalContext?: string;
            hookEventName?: string;
          };
          systemMessage?: string;
        });
  return {
    additionalContext: parsed.hookSpecificOutput?.additionalContext ?? '',
    hookEventName: parsed.hookSpecificOutput?.hookEventName ?? null,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout,
    systemMessage: parsed.systemMessage ?? '',
  };
}

function sessionStart(
  w: World,
  sessionId: string,
  source: string,
  extraArgs: string[] = [],
): HookRun {
  return run(w, ['session-start', ...extraArgs], {
    cwd: w.repo,
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source,
    transcript_path: join(w.repo, 'none.jsonl'),
  });
}

function prompt(
  w: World,
  sessionId: string,
  extraArgs: string[] = [],
): HookRun {
  return run(w, ['repo-state', '--hook', ...extraArgs], {
    cwd: w.repo,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'hello',
    session_id: sessionId,
    transcript_path: join(w.repo, 'none.jsonl'),
  });
}

describe('repo state: armed at SessionStart, fired on the first prompt', () => {
  test('a fresh session: none at SessionStart, all of it on prompt 1, nothing on prompt 2', () => {
    const w = world();

    const start = sessionStart(w, 'sess-fresh', 'startup');
    expect(start.status).toBe(0);
    // SessionStart injects no repo state, to Claude or anywhere else.
    expect(start.additionalContext).not.toContain(REPO_STATE_HEADER);
    expect(start.systemMessage).not.toContain(REPO_STATE_HEADER);
    // …and says where it went.
    expect(start.systemMessage).toContain('repo state → your first prompt');

    const first = prompt(w, 'sess-fresh');
    expect(first.status).toBe(0);
    expect(first.hookEventName).toBe('UserPromptSubmit');
    expect(first.additionalContext).toContain(REPO_STATE_HEADER);
    expect(first.additionalContext).toContain('feature-early');
    // M3: Justin sees exactly what Claude got.
    expect(first.systemMessage).toBe(first.additionalContext);

    const second = prompt(w, 'sess-fresh');
    expect(second.status).toBe(0);
    expect(second.stdout).toBe('');
  });

  test('the block is measured at the prompt, not at session start', () => {
    const w = world();
    sessionStart(w, 'sess-late', 'startup');

    // Work that appears AFTER the session opened, before the first prompt.
    git(w.repo, ['checkout', '-qb', 'feature-late']);
    writeFileSync(join(w.repo, 'late.txt'), 'x\n');
    git(w.repo, ['add', '-A']);
    git(w.repo, ['commit', '-qm', 'late work']);
    git(w.repo, ['checkout', '-q', 'main']);

    expect(prompt(w, 'sess-late').additionalContext).toContain('feature-late');
  });

  test('a resumed session gets it again on its next prompt, then nothing', () => {
    const w = world();
    sessionStart(w, 'sess-resume', 'startup');
    expect(prompt(w, 'sess-resume').additionalContext).toContain(
      REPO_STATE_HEADER,
    );
    expect(prompt(w, 'sess-resume').stdout).toBe('');

    // `claude --resume` keeps the session id and fires SessionStart again.
    sessionStart(w, 'sess-resume', 'resume');
    expect(prompt(w, 'sess-resume').additionalContext).toContain(
      REPO_STATE_HEADER,
    );
    expect(prompt(w, 'sess-resume').stdout).toBe('');
  });

  test('/clear and compaction re-arm too', () => {
    const w = world();
    sessionStart(w, 'sess-clear', 'startup');
    prompt(w, 'sess-clear');
    expect(prompt(w, 'sess-clear').stdout).toBe('');

    sessionStart(w, 'sess-clear', 'clear');
    expect(prompt(w, 'sess-clear').additionalContext).toContain(
      REPO_STATE_HEADER,
    );

    sessionStart(w, 'sess-clear', 'compact');
    expect(prompt(w, 'sess-clear').additionalContext).toContain(
      REPO_STATE_HEADER,
    );
    expect(prompt(w, 'sess-clear').stdout).toBe('');
  });

  test('sessions are independent: one session firing does not consume another', () => {
    const w = world();
    sessionStart(w, 'sess-a', 'startup');
    sessionStart(w, 'sess-b', 'startup');
    expect(prompt(w, 'sess-a').additionalContext).toContain(REPO_STATE_HEADER);
    expect(prompt(w, 'sess-b').additionalContext).toContain(REPO_STATE_HEADER);
  });

  test('a prompt that beats its SessionStart (no marker yet) still gets the block', () => {
    // The reference: SessionStart hooks "run in the background. You can type
    // right away". A missing marker must not cost the session its repo state.
    const w = world();
    expect(prompt(w, 'sess-race').additionalContext).toContain(
      REPO_STATE_HEADER,
    );
    expect(prompt(w, 'sess-race').stdout).toBe('');
  });

  test('the markers live in XDG state, outside the repo', () => {
    const w = world();
    sessionStart(w, 'sess-where', 'startup');
    const marker = join(
      w.stateHome,
      'justin-sdk',
      'first-prompt',
      'sess-where.json',
    );
    const state = (): unknown =>
      (JSON.parse(readFileSync(marker, 'utf-8')) as {state?: unknown}).state;
    expect(state()).toBe('armed');
    prompt(w, 'sess-where');
    expect(state()).toBe('fired');
    expect(git(w.repo, ['status', '--porcelain', '-uall'])).toBe('');
  });

  test('a session id that could climb out of the state dir is refused, not used', () => {
    const w = world();
    const start = sessionStart(w, '../../escape', 'startup');
    // Not armed, so session-start falls back to injecting it now — and says so.
    expect(start.systemMessage).toContain('repo state injected NOW');
    expect(start.additionalContext).toContain(REPO_STATE_HEADER);
    expect(existsSync(join(w.stateHome, 'escape.json'))).toBe(false);
    expect(prompt(w, '../../escape').stdout).toBe('');
  });

  test('no `repo-state --hook` installed (settings behind the SDK): injected at SessionStart, out loud', () => {
    // home-base the moment this lands, or any repo whose pin moved without an
    // `install`: arming would promise the block to a prompt nothing fires on.
    const w = world({promptHook: false});
    const start = sessionStart(w, 'sess-nohook', 'startup');
    expect(start.systemMessage).toContain(
      'repo state injected NOW, not on the first prompt (no `repo-state --hook` UserPromptSubmit hook is installed — run `bun run justin-sdk install`)',
    );
    expect(start.additionalContext).toContain(REPO_STATE_HEADER);
    expect(start.systemMessage).toContain(REPO_STATE_HEADER); // mirrored
  });

  test('the USER-level prompt hook does not count for an enrolled repo (it is silent there)', () => {
    const w = world({promptHook: false});
    writeFileSync(
      join(w.home, '.claude', 'settings.json'),
      settingsWith(USER_LEVEL_PROMPT_HOOK_COMMAND),
    );
    expect(sessionStart(w, 'sess-ulonly', 'startup').systemMessage).toContain(
      'repo state injected NOW',
    );
  });

  test('no payload at all (a hand-typed run): injected at SessionStart, out loud', () => {
    const w = world();
    const result = spawnSync(process.execPath, [CLI, 'session-start'], {
      cwd: w.repo,
      encoding: 'utf-8',
      env: w.env,
    });
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: {additionalContext?: string};
      systemMessage?: string;
    };
    expect(parsed.systemMessage).toContain(
      'repo state injected NOW, not on the first prompt (the hook payload carried no usable session_id)',
    );
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      REPO_STATE_HEADER,
    );
    // And the mirror carries it to Justin too.
    expect(parsed.systemMessage).toContain(REPO_STATE_HEADER);
  });
});

describe('the user-level pair, for unenrolled repos', () => {
  test('an ENROLLED repo: both user-level hooks print nothing', () => {
    const w = world();
    expect(sessionStart(w, 'sess-ul', 'startup', ['--user-level']).stdout).toBe(
      '',
    );
    expect(prompt(w, 'sess-ul', ['--user-level']).stdout).toBe('');
  });

  test('an UNENROLLED repo: armed at SessionStart, fired on the first prompt', () => {
    const w = world({enrolled: false});
    const start = sessionStart(w, 'sess-un', 'startup', ['--user-level']);
    expect(start.additionalContext).not.toContain(REPO_STATE_HEADER);
    // The rules pointer is still injected here — and mirrored to Justin.
    expect(start.additionalContext).toContain(
      '~/.claude/rules/justin-sdk/critical-rules.md',
    );
    expect(start.systemMessage).toContain('↓ also sent to Claude');
    expect(start.systemMessage).toContain(
      '~/.claude/rules/justin-sdk/critical-rules.md',
    );

    const first = prompt(w, 'sess-un', ['--user-level']);
    expect(first.additionalContext).toContain(REPO_STATE_HEADER);
    expect(first.systemMessage).toBe(first.additionalContext);
    expect(prompt(w, 'sess-un', ['--user-level']).stdout).toBe('');
  });
});

describe('repo-state without --hook', () => {
  test('prints the block for a human, and writes no marker', () => {
    const w = world();
    const result = spawnSync(process.execPath, [CLI, 'repo-state'], {
      cwd: w.repo,
      encoding: 'utf-8',
      env: w.env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(REPO_STATE_HEADER);
    expect(result.stdout).toContain('feature-early');
    expect(existsSync(join(w.stateHome, 'justin-sdk', 'first-prompt'))).toBe(
      false,
    );
  });
});
