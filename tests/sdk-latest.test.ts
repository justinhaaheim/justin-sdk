/**
 * The shared "newest SDK tag" lookup (home-base-uxwc D3).
 *
 * NOTHING HERE TOUCHES THE NETWORK. `fetchLatestSdkTag` is split into a spawn
 * and a pure `latestTagFromLsRemote`, and the failure descriptions are a pure
 * function of the error object, so every branch is reachable from a string and
 * a synthetic error — which is the only way a `bun test` run can be honest
 * about making no network call.
 *
 * The listing below is a REAL excerpt of
 * `git ls-remote --tags https://github.com/justinhaaheim/justin-sdk`
 * (captured 2026-09-10), trimmed to the interesting rows: bare tags, v-prefixed
 * tags, and the `^{}` peeled lines an annotated tag adds.
 */

import {describe, expect, test} from 'bun:test';

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  latestTagFromLsRemote,
  parseLsRemoteTags,
  parseSdkVersion,
  pickLatestTag,
  tagToVersion,
} from '../src/sdk-latest';

const REAL_LISTING = [
  '513e241e5bbe23843597ab70daff31aac41e532f\trefs/tags/0.1.0',
  '78e083e5e5f22d29f91cec795056ea837945e7f2\trefs/tags/0.13.0',
  '868fd9bbbd5abf64fe57ec86056f46f374889e28\trefs/tags/0.14.0',
  '42ff739e1fbb2b2f4a79b6e61dc82433cc95ee69\trefs/tags/0.2.0',
  '188b843cda8154c30fc68e75e59df6368a7e0d66\trefs/tags/0.3.1',
  'e78f4a26f4e90e206f787232a62a397f38d800d2\trefs/tags/0.3.1^{}',
  'cf97c9d9869faf95f71a0686a50fbd485740514e\trefs/tags/v0.26.0',
  '54b1e830038a450584be54449966a6553935ba08\trefs/tags/v0.26.0^{}',
  'b451124d76ba29b5458a4b8eb8bdb3a6d3dc90f3\trefs/tags/v0.6.0',
  'bd8d27df3e0b9233169939ba21f4c6f31b9ad482\trefs/tags/v0.6.0^{}',
  '',
].join('\n');

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
    // commits. Input order is the listing's ordering — not a contract. Both
    // orders must land on the sweep-guard spelling.
    expect(pickLatestTag(['0.14.0', 'v0.14.0'])).toBe('v0.14.0');
    expect(pickLatestTag(['v0.14.0', '0.14.0'])).toBe('v0.14.0');
    // A bare-only latest is still returned raw — nothing to prefer.
    expect(pickLatestTag(['v0.14.0', '0.15.0'])).toBe('0.15.0');
  });
});

describe('parseLsRemoteTags', () => {
  test('keeps one name per tag and drops the peeled ^{} companions', () => {
    expect(parseLsRemoteTags(REAL_LISTING)).toEqual([
      '0.1.0',
      '0.13.0',
      '0.14.0',
      '0.2.0',
      '0.3.1',
      'v0.26.0',
      'v0.6.0',
    ]);
  });

  test('an annotated tag is never counted twice', () => {
    const names = parseLsRemoteTags(REAL_LISTING);
    expect(new Set(names).size).toBe(names.length);
  });

  test('ignores refs that are not tags, and lines with no tab', () => {
    const mixed = [
      'aaa\trefs/heads/main',
      'bbb\tHEAD',
      'not a ref line at all',
      'ccc\trefs/tags/1.2.3',
      'ddd\trefs/tags/',
      '',
    ].join('\n');
    expect(parseLsRemoteTags(mixed)).toEqual(['1.2.3']);
  });

  test('empty output yields no names (and is NOT an answer on its own)', () => {
    expect(parseLsRemoteTags('')).toEqual([]);
  });
});

describe('tagToVersion', () => {
  test('strips only a leading v', () => {
    expect(tagToVersion('v0.26.0')).toBe('0.26.0');
    expect(tagToVersion('0.26.0')).toBe('0.26.0');
    expect(tagToVersion('v1.0.0-beta.1')).toBe('1.0.0-beta.1');
  });
});

describe('latestTagFromLsRemote', () => {
  test('returns the newest tag raw, plus its normalised version', () => {
    expect(latestTagFromLsRemote(REAL_LISTING)).toEqual({
      status: 'ok',
      tag: 'v0.26.0',
      version: '0.26.0',
    });
  });

  test('a listing with no semver tag FAILS — it never reads as "no newer version"', () => {
    const outcome = latestTagFromLsRemote(
      'aaa\trefs/tags/nightly\nbbb\trefs/tags/latest\n',
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.error).toContain('no semver tag');
    expect(outcome.error).toContain('2 tag ref(s)');
  });

  test('empty output FAILS rather than reporting zero tags as an answer', () => {
    expect(latestTagFromLsRemote('').status).toBe('failed');
  });
});

describe('describeFetchFailure', () => {
  test('a timeout says so, and says how long it waited', () => {
    expect(
      describeFetchFailure({code: 'ETIMEDOUT', signal: 'SIGTERM'}, 5000),
    ).toBe('git ls-remote timed out after 5000ms');
    // Some platforms report only the kill signal.
    expect(describeFetchFailure({signal: 'SIGTERM'}, 1234)).toBe(
      'git ls-remote timed out after 1234ms',
    );
  });

  test('a missing git binary is named as such, not as a network problem', () => {
    expect(describeFetchFailure({code: 'ENOENT'}, 5000)).toBe(
      'git is not on PATH',
    );
  });

  test('a non-zero exit reports the code and the first stderr line', () => {
    expect(
      describeFetchFailure(
        {status: 128, stderr: 'fatal: could not read from remote\nmore\n'},
        5000,
      ),
    ).toBe('git ls-remote exited 128: fatal: could not read from remote');
  });

  test('an exit with no stderr still reports the code', () => {
    expect(describeFetchFailure({status: 1, stderr: '  \n'}, 5000)).toBe(
      'git ls-remote exited 1',
    );
  });

  test('anything else falls back to the error message', () => {
    expect(describeFetchFailure(new Error('kaboom'), 5000)).toBe('kaboom');
    expect(describeFetchFailure('plain string', 5000)).toBe('plain string');
  });
});

describe('DEFAULT_FETCH_TIMEOUT_MS', () => {
  test('is a hard kill in the seconds range, not minutes', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(5000);
  });
});
