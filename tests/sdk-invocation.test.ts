/**
 * The invocation-form contract (epic home-base-dchjw, decision D1).
 *
 * There are exactly three legal spellings of "run the SDK", and this file pins
 * each one to the place it belongs: the BARE bin in a package.json script value,
 * `bun run justin-sdk` in a hook or an advice string, and the pinned `github:`
 * bootstrap in the two places where no node_modules can exist yet.
 *
 * Why the emphasis on REWRITING rather than detecting: before this, every
 * installer asked "is some form of my hook already here?" and stopped there. The
 * fleet had drifted to four `bunx` spellings, every one of which answered yes,
 * so no install could ever move a repo forward — it just confirmed the old form.
 * The tests below therefore assert the post-install VALUE, not merely that a
 * value is present.
 *
 * Nothing here reaches the network. The pin test uses a real `git ls-remote`
 * against a local BARE REPO, which is what makes it a test of the shipping code
 * path rather than of a mock.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  runBaseSetup,
  SESSION_START_HOOK_COMMAND,
  shadowsSdkBin,
} from '../src/base-setup';
import {runDoctor} from '../src/doctor';
import {
  invokesSdk,
  sdkRun,
  sdkRunArgv,
  sdkScript,
  STALE_SDK_INVOCATION_RE,
  upsertHookCommand,
} from '../src/sdk-invocation';
import {sdkTagExistsOnRemote} from '../src/sdk-latest';
import {addUsageCheckHook} from '../src/usage-check-setup';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * A BARE repo that `git ls-remote` can be pointed at, carrying exactly the tags
 * asked for. A bare repo is a real remote as far as git is concerned, so the
 * shipping `listSdkTags` spawn runs unchanged and hermetically.
 */
function bareRemote(sb: Sandbox, tags: string[]): string {
  const work = join(sb.path, 'remote-work');
  mkdirSync(work, {recursive: true});
  git(work, ['init', '-q', '-b', 'main', '.']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['commit', '-q', '--allow-empty', '-m', 'init']);
  for (const tag of tags) git(work, ['tag', tag]);

  const bare = join(sb.path, 'remote.git');
  git(sb.path, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

function readPackageJson(root: string): {scripts?: Record<string, string>} {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, '.claude', 'settings.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

/** Every `command` string under one settings.json hook event, in order. */
function hookCommands(
  settings: Record<string, unknown>,
  event: string,
): string[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const entries = (hooks[event] ?? []) as {
    hooks?: {command?: string}[];
  }[];
  return entries.flatMap((entry) =>
    (entry.hooks ?? []).map((hook) => hook.command ?? ''),
  );
}

/**
 * A remote that already carries this SDK's own tag, so `stepDepsHasSdk` writes
 * its pin instead of refusing. Every base-setup run below goes through it, which
 * also keeps the suite off the network.
 */
function remoteWithOwnTag(sb: Sandbox): string {
  const version = (
    JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
    ) as {version: string}
  ).version;
  return bareRemote(sb, [`v${version}`]);
}

describe('D1 invocation forms', () => {
  test('the three spellings are what the helpers produce', () => {
    expect(sdkScript('signal --quiet')).toBe('justin-sdk signal --quiet');
    expect(sdkRun('doctor')).toBe('bun run justin-sdk doctor');
    expect(sdkRunArgv(['doctor', '--fix'])).toEqual([
      'bun',
      'run',
      'justin-sdk',
      'doctor',
      '--fix',
    ]);
  });

  test('every retired spelling is recognised, and the current ones are not', () => {
    for (const stale of [
      'bunx @justinhaaheim/justin-sdk doctor',
      'bunx github:justinhaaheim/justin-sdk doctor',
      'bunx github:justinhaaheim/justin-sdk#v0.38.0 doctor',
      'bunx justin-sdk doctor',
      'bunx jsdk doctor',
      'bunx j fix',
    ]) {
      expect(STALE_SDK_INVOCATION_RE.test(stale)).toBe(true);
    }
    // The CURRENT forms must not match, or an install would rewrite its own
    // output on every run and never converge.
    for (const current of [
      'justin-sdk doctor',
      'bun run justin-sdk doctor',
      // A project's own script that merely starts with a similar word.
      'bunx justin-sdk-lookalike thing',
      'bunx prettier --check .',
    ]) {
      expect(STALE_SDK_INVOCATION_RE.test(current)).toBe(false);
    }
  });

  test('invokesSdk recognises the SDK under any prefix, including a raw path', () => {
    expect(invokesSdk('bun run justin-sdk setup-env')).toBe(true);
    expect(invokesSdk('bunx @justinhaaheim/justin-sdk setup-env')).toBe(true);
    expect(invokesSdk('bunx jsdk setup-env')).toBe(true);
    expect(invokesSdk('/Users/x/node_modules/.bin/justin-sdk setup-env')).toBe(
      true,
    );
    expect(invokesSdk('bun run some-other-tool')).toBe(false);
  });

  test('the SessionStart hook bootstraps remotely and resolves locally', () => {
    // The remote branch is the ONE place an unpinned github: spec is correct:
    // a fresh container has no node_modules for anything else to resolve.
    expect(SESSION_START_HOOK_COMMAND).toContain(
      'bunx github:justinhaaheim/justin-sdk setup-env',
    );
    // The local branch must spell `bun run` out in full — hooks run under sh.
    // It runs `session-start`, not `doctor --quiet`: dchjw.8 (D6) retired the
    // `prime` plugin and folded the repo-state block and the rules-drift notice
    // in beside doctor's verdict, so this one command is the whole local job.
    expect(SESSION_START_HOOK_COMMAND).toContain(
      'bun run justin-sdk session-start',
    );
    expect(SESSION_START_HOOK_COMMAND).not.toContain(
      'bunx @justinhaaheim/justin-sdk',
    );
  });
});

describe('install rewrites every old spelling (dchjw.4 AC2)', () => {
  test.each([
    ['scoped', 'bunx @justinhaaheim/justin-sdk'],
    ['unpinned github', 'bunx github:justinhaaheim/justin-sdk'],
    ['bare justin-sdk', 'bunx justin-sdk'],
    ['bare jsdk', 'bunx jsdk'],
  ])(
    'a package.json written with the %s spelling comes back as the bare bin',
    async (_label, prefix) => {
      const sb = track(
        createProjectSandbox({
          packageJson: {
            name: 'legacy',
            scripts: {
              doctor: `${prefix} doctor`,
              fix: `${prefix} fix`,
              signal: `${prefix} signal --quiet`,
              // A script the SDK does NOT own must survive untouched, whatever
              // it looks like.
              'signal-source:CUSTOM': 'echo custom',
            },
            version: '0.0.1',
          },
        }),
      );

      const exitCode = await runBaseSetup({
        projectRoot: sb.path,
        quiet: true,
        sdkRepoUrl: remoteWithOwnTag(sb),
      });
      expect(exitCode).toBe(0);

      const pkg = readPackageJson(sb.path);
      expect(pkg.scripts?.doctor).toBe('justin-sdk doctor');
      expect(pkg.scripts?.fix).toBe('justin-sdk fix');
      expect(pkg.scripts?.signal).toBe('justin-sdk signal --quiet');
      expect(pkg.scripts?.['signal-source:CUSTOM']).toBe('echo custom');
      expect(JSON.stringify(pkg.scripts)).not.toContain('bunx');
    },
  );

  test('a SessionStart hook in an old spelling is REWRITTEN, not duplicated', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    command:
                      'if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then bunx github:justinhaaheim/justin-sdk setup-env; else bunx @justinhaaheim/justin-sdk doctor --quiet || true; fi',
                    type: 'command',
                  },
                ],
              },
              // A foreign hook the SDK does not own — must survive.
              {hooks: [{command: 'echo hello', type: 'command'}]},
            ],
          },
        },
        null,
        2,
      ),
    );

    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: remoteWithOwnTag(sb),
    });

    const commands = hookCommands(readSettings(sb.path), 'SessionStart');
    expect(commands).toHaveLength(2);
    expect(commands).toContain('echo hello');
    expect(commands).toContain(SESSION_START_HOOK_COMMAND);
    // The old local branch is gone, not merely joined by a newer sibling.
    expect(JSON.stringify(commands)).not.toContain(
      'bunx @justinhaaheim/justin-sdk doctor',
    );
  });

  test('a second install changes nothing (the rewrite converges)', async () => {
    const sb = track(createProjectSandbox());
    const sdkRepoUrl = remoteWithOwnTag(sb);
    await runBaseSetup({projectRoot: sb.path, quiet: true, sdkRepoUrl});
    const afterFirst = readFileSync(
      join(sb.path, '.claude', 'settings.json'),
      'utf-8',
    );

    await runBaseSetup({projectRoot: sb.path, quiet: true, sdkRepoUrl});
    expect(
      readFileSync(join(sb.path, '.claude', 'settings.json'), 'utf-8'),
    ).toBe(afterFirst);
  });
});

/**
 * dchjw.15 F1+F6 — the hook matcher, against the two spellings the OLD one
 * could not see.
 *
 * The retired matcher asked "does this entry contain the literal `justin-sdk
 * <subcommand>`?". Both spellings below run the hook and neither contains that
 * string, so both were read as "not installed" and a SECOND entry was appended
 * beside them: two hooks firing on every prompt, forever, in exactly the repos
 * whose spelling was oldest. These are unit tests on `upsertHookCommand`
 * because that is the repaired unit; the end-to-end sibling below drives the
 * real installer through settings.json.
 *
 * NEGATIVE CONTROL (run by hand, recorded in dchjw.15): replacing `isThisHook`
 * in src/sdk-invocation.ts with the old
 * `JSON.stringify(entry).includes(fingerprint)` test fails
 * "…is recognised, not duplicated" for BOTH spellings on `toHaveLength(1)`,
 * having appended a second entry — the exact bug.
 */
describe('upsertHookCommand recognises every spelling (dchjw.15 F1/F6)', () => {
  const CURRENT = sdkRun('usage-check');
  const NEW_ENTRY = (): unknown => ({
    hooks: [{command: CURRENT, type: 'command'}],
  });
  const entryFor = (command: string): unknown => ({
    hooks: [{command, type: 'command'}],
  });
  const commandsOf = (entries: readonly unknown[]): string[] =>
    entries.flatMap((entry) =>
      ((entry as {hooks?: {command?: string}[]}).hooks ?? []).map(
        (hook) => hook.command ?? '',
      ),
    );

  test('a PINNED bunx spelling is rewritten in place, not duplicated', () => {
    const existing =
      'bunx github:justinhaaheim/justin-sdk#v0.38.0 usage-check --quiet';
    const {changed, entries} = upsertHookCommand(
      [entryFor(existing)],
      'usage-check',
      CURRENT,
      NEW_ENTRY,
    );
    expect(changed).toBe(true);
    expect(entries).toHaveLength(1);
    expect(commandsOf(entries)).toEqual([CURRENT]);
  });

  test('an absolute cli.ts path is recognised, not duplicated, and LEFT ALONE', () => {
    // Deliberately not rewritten: `isSdkEmittedCommand` is still the rewrite
    // gate (F1). A human wrote this path for a reason this code cannot see —
    // the live one being an UNENROLLED repo, where `bun run justin-sdk` does
    // not resolve at all, so rewriting it would break the hook outright.
    const existing = '/abs/path/pkg/justin-sdk/src/cli.ts time-check';
    const {changed, entries} = upsertHookCommand(
      [entryFor(existing)],
      'time-check',
      sdkRun('time-check'),
      () => entryFor(sdkRun('time-check')),
    );
    expect(changed).toBe(false);
    expect(entries).toHaveLength(1);
    expect(commandsOf(entries)).toEqual([existing]);
  });

  test('a bun-invoked absolute cli.ts path is recognised too', () => {
    const existing =
      'bun /Users/x/Dev/home-base/pkg/justin-sdk/src/cli.ts time-check';
    const {entries} = upsertHookCommand(
      [entryFor(existing)],
      'time-check',
      sdkRun('time-check'),
      () => entryFor(sdkRun('time-check')),
    );
    expect(entries).toHaveLength(1);
  });

  test('a FOREIGN hook mentioning neither the SDK nor the subcommand is joined, not matched', () => {
    const {changed, entries} = upsertHookCommand(
      [entryFor('echo hello')],
      'usage-check',
      CURRENT,
      NEW_ENTRY,
    );
    expect(changed).toBe(true);
    expect(commandsOf(entries)).toEqual(['echo hello', CURRENT]);
  });

  test('a DIFFERENT SDK hook is not mistaken for this one', () => {
    const other = sdkRun('time-check');
    const {entries} = upsertHookCommand(
      [entryFor(other)],
      'usage-check',
      CURRENT,
      NEW_ENTRY,
    );
    expect(commandsOf(entries)).toEqual([other, CURRENT]);
  });

  test('end to end: a pinned-bunx hook in settings.json is rewritten, and a re-run is a no-op', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        UserPromptSubmit: [
          entryFor('bunx github:justinhaaheim/justin-sdk#v0.30.0 usage-check'),
        ],
      },
    };
    expect(addUsageCheckHook(settings, 'UserPromptSubmit')).toBe(true);
    expect(hookCommands(settings, 'UserPromptSubmit')).toEqual([
      sdkRun('usage-check'),
    ]);
    expect(addUsageCheckHook(settings, 'UserPromptSubmit')).toBe(false);
  });
});

describe('the pin must exist on the remote (dchjw.4 AC3 / home-base-l9tz)', () => {
  test('a remote WITHOUT the tag refuses, and writes no dependency', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      // Carries a tag, just not THIS SDK's — the dev-checkout-ahead-of-release
      // shape, rather than "the remote has nothing at all".
      sdkRepoUrl: bareRemote(sb, ['v0.0.1']),
    });

    expect(exitCode).toBe(1);
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.['@justinhaaheim/justin-sdk']).toBeUndefined();
  });

  test('NEGATIVE CONTROL: the same run succeeds once the tag exists', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: remoteWithOwnTag(sb),
    });

    expect(exitCode).toBe(0);
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.['@justinhaaheim/justin-sdk']).toMatch(
      /^github:justinhaaheim\/justin-sdk#v\d+\.\d+\.\d+$/,
    );
  });

  test('an UNREACHABLE remote is a third state: not "absent", not "present"', () => {
    const sb = track(createSandbox());
    const outcome = sdkTagExistsOnRemote('v1.2.3', {
      repoUrl: join(sb.path, 'no-such-repo.git'),
      timeoutMs: 10_000,
    });
    // Critical rule 6: a failed measurement must not be representable as a
    // normal value. `{exists: false}` here would read as "that tag does not
    // exist", which is a claim this run cannot make.
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('git ls-remote');
    }
  });
});

describe('a script named justin-sdk shadows the bin (dchjw.4 AC6 / F8)', () => {
  test('shadowsSdkBin is true only for that exact name', () => {
    expect(shadowsSdkBin({'justin-sdk': 'echo hi'})).toBe(true);
    expect(shadowsSdkBin({'justin-sdk:foo': 'echo hi'})).toBe(false);
    expect(shadowsSdkBin({doctor: 'justin-sdk doctor'})).toBe(false);
    expect(shadowsSdkBin(undefined)).toBe(false);
  });

  test('base-setup REFUSES rather than writing aliases that would be shadowed', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'shadowed',
          scripts: {'justin-sdk': 'echo something-else'},
          version: '0.0.1',
        },
      }),
    );

    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: remoteWithOwnTag(sb),
    });

    expect(exitCode).toBe(1);
    // The refusal must not have half-written the aliases it was about to add.
    const pkg = readPackageJson(sb.path);
    expect(pkg.scripts?.doctor).toBeUndefined();
    expect(pkg.scripts?.['justin-sdk']).toBe('echo something-else');
  });

  test('doctor reports SCRIPT_SHADOWS_SDK_BIN as an error', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {components: ['base-setup'], version: '0.0.1'},
        packageJson: {
          name: 'shadowed',
          scripts: {'justin-sdk': 'echo something-else'},
          version: '0.0.1',
        },
      }),
    );

    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    let exitCode: number;
    try {
      exitCode = await runDoctor(sb.path);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const output = lines.join('\n');
    // Assert the FAILURE's own wording. The passing message is "no script
    // shadows the justin-sdk bin", so a looser substring would be satisfied by
    // a broken check — verified by breaking `shadowsSdkBin` and watching this
    // test stay green before it was tightened.
    expect(output).toContain('SCRIPT_SHADOWS_SDK_BIN');
    expect(output).toContain('has a script named "justin-sdk"');
    // An ERROR, not a warning, so it lands in the failure tally rather than the
    // warning one. This fixture fails other checks too, so the exit code alone
    // proves nothing — count the reported failures instead.
    expect(output).toMatch(/\d+ fail/);
    expect(exitCode).not.toBe(0);
  });

  test('NEGATIVE CONTROL: without the script, the check passes and doctor does not report it', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {components: ['base-setup'], version: '0.0.1'},
        packageJson: {
          name: 'clean',
          scripts: {doctor: 'justin-sdk doctor'},
          version: '0.0.1',
        },
      }),
    );

    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runDoctor(sb.path);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const output = lines.join('\n');
    // The PASS message also contains the phrase "shadows the justin-sdk bin"
    // ("no script shadows …"), so assert on the FAILURE's wording instead.
    expect(output).toContain('SCRIPT_SHADOWS_SDK_BIN');
    expect(output).not.toContain('has a script named');
  });
});
