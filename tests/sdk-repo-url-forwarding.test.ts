/**
 * `sdkRepoUrl` reaches base-setup's pin check through the two product paths
 * that did not forward it before home-base-ejsq2.9: `applySweepPayload` in
 * component mode, and `runUpdate`'s reconcile step. Each fixture declares no
 * SDK pin, which is the case where base-setup runs `git ls-remote --tags`.
 *
 * HOW EACH PAIR WORKS. In every test, git answers the published SDK URL from a
 * local remote that does NOT carry this SDK's tag (withSdkRepoAnsweredBy), so
 * a pin check that asks the default remote refuses, naming that URL, and
 * nothing reaches GitHub.
 *
 * - The positive test passes `sdkRepoUrl` pointing at a local remote that DOES
 *   carry the tag. It passes only if the check asked that remote.
 * - Its NEGATIVE CONTROL is the same call without the option. It refuses, and
 *   the refusal names SDK_REPO_URL: an absent option asks the default remote,
 *   so the positive test cannot pass by accident.
 *
 * These tests live here, not in sweep-component.test.ts or update.test.ts: the
 * negative controls run `git ls-remote` against the published URL on purpose
 * (answered locally), and those two files must run none (home-base-ejsq2.9,
 * acceptance criterion 2).
 */

import {afterAll, afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {SDK_REPO_URL} from '../src/sdk-latest';
import {applySweepPayload} from '../src/sweep';
import {runUpdate} from '../src/update';
import {
  FIXTURE_IDENTITY,
  git,
  initFixtureRepo,
  sharedSdkRemote,
  withSdkRepoAnsweredBy,
} from './git-fixtures';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';
import {captureConsole} from './update-fixtures';

const SDK_VERSION = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ) as {version: string}
).version;

/** The refusal base-setup prints when `remote` lacks this SDK's tag. */
function noTagRefusal(remote: string): string {
  return `but ${remote} has no tag v${SDK_VERSION}`;
}

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A local remote carrying `v<this SDK's version>`. */
const taggedRemote = sharedSdkRemote();

/**
 * A local bare remote with a release tag, but not this SDK's: a pin check
 * against it is answered and refuses. Built once for the file.
 */
let taglessHost: Sandbox | null = null;
let taglessUrl: string | null = null;
function taglessRemote(): string {
  if (taglessUrl != null) return taglessUrl;
  taglessHost = createSandbox();
  const work = join(taglessHost.path, 'remote-work');
  mkdirSync(work, {recursive: true});
  initFixtureRepo(work, {identity: FIXTURE_IDENTITY});
  git(work, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(work, ['tag', 'v0.0.1']);
  const bare = join(taglessHost.path, 'remote.git');
  git(taglessHost.path, ['clone', '-q', '--bare', work, bare]);
  taglessUrl = bare;
  return bare;
}

afterAll(() => {
  taggedRemote.cleanup();
  taglessHost?.cleanup();
});

/** Run `fn` while the default remote answers without this SDK's tag. */
function withDefaultRemoteLackingTheTag<T>(fn: () => Promise<T>): Promise<T> {
  return withSdkRepoAnsweredBy(taglessRemote(), fn);
}

describe('applySweepPayload (component mode) forwards sdkRepoUrl', () => {
  test('the pin is verified against the remote it is given', async () => {
    const root = track(createProjectSandbox()).path;
    const {output, result} = await captureConsole(() =>
      withDefaultRemoteLackingTheTag(() =>
        applySweepPayload(
          root,
          {component: 'gitignore', mode: 'component'},
          {sdkRepoUrl: taggedRemote.url()},
        ),
      ),
    );
    expect({output, result}).toMatchObject({result: {ok: true}});
    expect(output).not.toContain('has no tag');
  });

  test('NEGATIVE CONTROL: without it, the default remote is asked', async () => {
    const root = track(createProjectSandbox()).path;
    const {output, result} = await captureConsole(() =>
      withDefaultRemoteLackingTheTag(() =>
        applySweepPayload(root, {component: 'gitignore', mode: 'component'}),
      ),
    );
    expect(result.ok).toBe(false);
    expect(output).toContain(noTagRefusal(SDK_REPO_URL));
  });
});

describe('runUpdate forwards sdkRepoUrl to its install step', () => {
  function projectWithNoComponents(): string {
    const root = track(createProjectSandbox()).path;
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({components: []}, null, 2),
    );
    return root;
  }

  test('the pin is verified against the remote it is given', async () => {
    const root = projectWithNoComponents();
    const {output, result} = await captureConsole(() =>
      withDefaultRemoteLackingTheTag(() =>
        runUpdate({
          noCommit: true,
          noSelfUpdate: true,
          projectRoot: root,
          quiet: true,
          sdkRepoUrl: taggedRemote.url(),
        }),
      ),
    );
    expect({output, result}).toMatchObject({result: 0});
    expect(output).not.toContain('has no tag');
  });

  test('NEGATIVE CONTROL: without it, the default remote is asked', async () => {
    const root = projectWithNoComponents();
    const {output, result} = await captureConsole(() =>
      withDefaultRemoteLackingTheTag(() =>
        runUpdate({
          noCommit: true,
          noSelfUpdate: true,
          projectRoot: root,
          quiet: true,
        }),
      ),
    );
    expect(result).toBe(1);
    expect(output).toContain(noTagRefusal(SDK_REPO_URL));
  });
});
