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

import {selfUpdateSdk} from '../src/self-update';
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
