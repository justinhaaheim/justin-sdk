/**
 * Tests for selfUpdateSdk. Network and `gh` calls are not mocked; the
 * test exercises the failure-mode paths that don't require either:
 *
 *  - missing node_modules/@justinhaaheim/justin-sdk → returns the
 *    "not installed" shape
 *  - malformed installed package.json → returns null previousVersion
 *
 * The happy path (bumping a real github tag) is covered by RIK-4
 * dogfood test.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {
  parseSdkVersion,
  pickLatestTag,
  selfUpdateSdk,
} from '../src/self-update';
import {createProjectSandbox, type Sandbox} from './sandbox';

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

describe('parseSdkVersion', () => {
  test('parses unprefixed and v-prefixed versions identically', () => {
    expect(parseSdkVersion('0.6.1')).toEqual([0, 6, 1]);
    expect(parseSdkVersion('v0.6.0')).toEqual([0, 6, 0]);
    expect(parseSdkVersion('  v1.2.3  ')).toEqual([1, 2, 3]);
  });

  test('reads the leading X.Y.Z triple, ignoring any suffix', () => {
    expect(parseSdkVersion('0.6.1-beta.2')).toEqual([0, 6, 1]);
  });

  test('returns null for non-version strings', () => {
    expect(parseSdkVersion('main')).toBeNull();
    expect(parseSdkVersion('latest')).toBeNull();
    expect(parseSdkVersion('1.2')).toBeNull();
  });
});

describe('pickLatestTag', () => {
  test('picks the highest semver regardless of input order', () => {
    expect(pickLatestTag(['0.5.1', '0.6.1', '0.4.0', '0.5.0'])).toBe('0.6.1');
    expect(pickLatestTag(['0.6.1', '0.5.1'])).toBe('0.6.1');
  });

  test('is not fooled by a v-prefixed tag lexically outsorting numbers', () => {
    // The bug this guards: a naive `.[0]`/lexical pick could surface v0.6.0
    // over the newer 0.6.1. Semver wins here.
    expect(pickLatestTag(['0.4.0', 'v0.6.0', '0.6.1', '0.5.1'])).toBe('0.6.1');
  });

  test('returns the RAW name (keeps the v) when a v-tag is genuinely newest', () => {
    expect(pickLatestTag(['0.4.0', 'v0.6.0', '0.5.1'])).toBe('v0.6.0');
  });

  test('ignores unparseable tags; returns null when none parse', () => {
    expect(pickLatestTag(['main', '0.5.0', 'nightly'])).toBe('0.5.0');
    expect(pickLatestTag(['main', 'latest'])).toBeNull();
    expect(pickLatestTag([])).toBeNull();
  });

  test('a DUPLICATE version (bare + v-prefixed) resolves to the v-prefixed spelling, in EITHER input order (j2n7.4)', () => {
    // The repo really carried 0.14.0 and v0.14.0 pointing at DIFFERENT
    // commits. Input order is gh's API ordering — not a contract. Both orders
    // must land on the sweep-guard spelling.
    expect(pickLatestTag(['0.14.0', 'v0.14.0'])).toBe('v0.14.0');
    expect(pickLatestTag(['v0.14.0', '0.14.0'])).toBe('v0.14.0');
    // A bare-only latest is still returned raw — nothing to prefer.
    expect(pickLatestTag(['v0.14.0', '0.15.0'])).toBe('0.15.0');
  });
});

describe('selfUpdateSdk', () => {
  test('returns "not installed" shape when SDK is missing from node_modules', async () => {
    const sb = track(createProjectSandbox());

    const result = await selfUpdateSdk(sb.path);

    expect(result).toEqual({
      updated: false,
      previousVersion: null,
      newVersion: null,
      shouldReExec: false,
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
