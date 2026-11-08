/**
 * Tests for selfUpdateSdk. No network call is made; the test exercises the
 * failure-mode paths that return BEFORE the tag lookup:
 *
 *  - missing node_modules/@justinhaaheim/justin-sdk → returns the
 *    "not installed" shape
 *  - malformed installed package.json → returns null previousVersion
 *
 * The bump itself is exercised through the `fetchLatestTag` / `runBump` seams
 * (home-base-ipx4a): the command it runs, and what it does when node_modules
 * does not hold the tag afterwards. No real github tag is ever fetched. The tag
 * lookup itself lives in sdk-latest.ts and is tested there (home-base-uxwc.2).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {rmSync} from 'fs';
import {join} from 'path';

import {sdkBumpArgv, selfUpdateSdk} from '../src/self-update';
import {setQuiet} from '../src/setup-helpers';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';
import {
  captureConsole,
  fakeGoodBump,
  fakeLatestTag,
  fakeStaleBump,
  initConsumerRepo,
  NEW_TAG,
} from './update-fixtures';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

describe('selfUpdateSdk', () => {
  test('returns "not installed" shape when SDK is missing from node_modules', async () => {
    const sb = track(createProjectSandbox());

    const result = await selfUpdateSdk(sb.path);

    expect(result).toEqual({
      failure: null,
      newVersion: null,
      previousVersion: null,
      shouldReExec: false,
      updated: false,
    });
  });

  test('returns null previousVersion when SDK package.json is malformed', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      'node_modules/@justinhaaheim/justin-sdk/package.json',
      'not json',
    );

    const result = await selfUpdateSdk(sb.path);

    // Falls into the same "not installed" message path because the
    // version read returned null.
    expect(result.previousVersion).toBeNull();
    expect(result.updated).toBe(false);
    expect(result.shouldReExec).toBe(false);
  });
});

describe('the bump command (home-base-ipx4a F2/F3)', () => {
  test('spells the package name, so bun replaces the pin in place', () => {
    // The unnamed `github:…#tag` form duplicated the pin line in bun.lock and
    // left the old SDK installed (measured, bun 1.4.2).
    expect(sdkBumpArgv('v0.56.0')).toEqual([
      'bun',
      'add',
      '-d',
      '@justinhaaheim/justin-sdk@github:justinhaaheim/justin-sdk#v0.56.0',
    ]);
  });

  test('selfUpdateSdk runs exactly that command, in the project', async () => {
    const sb = track(createSandbox());
    initConsumerRepo(sb.path);
    const calls: (readonly string[])[] = [];
    setQuiet(true);
    await selfUpdateSdk(sb.path, {
      fetchLatestTag: fakeLatestTag(),
      runBump: fakeGoodBump(calls),
    });
    expect(calls).toEqual([sdkBumpArgv(NEW_TAG)]);
  });
});

describe('the installed version after the bump (home-base-ipx4a D2)', () => {
  test('a bump that installed the target says Bumped and asks for the re-exec', async () => {
    const sb = track(createSandbox());
    initConsumerRepo(sb.path);
    setQuiet(false);
    const {output, result} = await captureConsole(() =>
      selfUpdateSdk(sb.path, {
        fetchLatestTag: fakeLatestTag(),
        runBump: fakeGoodBump(),
      }),
    );
    expect(result).toEqual({
      failure: null,
      newVersion: NEW_TAG,
      previousVersion: '0.1.0',
      shouldReExec: true,
      updated: true,
    });
    expect(output).toContain(
      `Bumped @justinhaaheim/justin-sdk: 0.1.0 → ${NEW_TAG}`,
    );
  });

  test('a bump that left the OLD SDK installed fails loudly and never says Bumped', async () => {
    const sb = track(createSandbox());
    initConsumerRepo(sb.path);
    setQuiet(false);
    const {output, result} = await captureConsole(() =>
      selfUpdateSdk(sb.path, {
        fetchLatestTag: fakeLatestTag(),
        runBump: fakeStaleBump(),
      }),
    );
    expect(result.shouldReExec).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.newVersion).toBe('0.1.0');
    expect(result.failure).not.toBeNull();
    // Both versions and the fix, named.
    expect(result.failure).toContain('holds version 0.1.0, not v0.2.0');
    expect(result.failure).toContain('bun update @justinhaaheim/justin-sdk');
    expect(output).toContain('holds version 0.1.0, not v0.2.0');
    expect(output).not.toContain('Bumped');
  });

  test('a bump after which no version can be read is a failure, not a match', async () => {
    const sb = track(createSandbox());
    initConsumerRepo(sb.path);
    setQuiet(true);
    const result = await selfUpdateSdk(sb.path, {
      fetchLatestTag: fakeLatestTag(),
      runBump: (_argv, cwd) => {
        rmSync(join(cwd, 'node_modules'), {force: true, recursive: true});
        return {exitCode: 0, stderr: '', stdout: ''};
      },
    });
    expect(result.shouldReExec).toBe(false);
    expect(result.failure).toContain('holds no readable version');
  });
});
