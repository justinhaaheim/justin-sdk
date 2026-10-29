/**
 * `brVersionIn` notices a pin change, never keeps a failure, and asks offline
 * (home-base-dj5m9.1.6 F2 and F4).
 *
 * The dashboard server reads beads in one process for hours. A cache keyed on
 * the checkout alone kept the br version from before a pin flip, and kept one
 * transient `br --version` failure until a restart. Here a stand-in `br` first
 * on PATH reads its version from the checkout's own mise.toml, the way the
 * mise shim does, so rewriting mise.toml is a pin flip. It answers only with
 * MISE_OFFLINE=1 set: without it the real shim may download a br inside the
 * UserPromptSubmit hook (F4).
 *
 * NEGATIVE CONTROLS (run by hand, recorded on home-base-dj5m9.1.6):
 *   - key the cache on the checkout alone → "a pin flip" fails (still 0.1.37);
 *   - store failures in the cache → "a failure" fails (still failed);
 *   - spawn without MISE_OFFLINE → every test fails (the stand-in refuses).
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {delimiter, join} from 'path';

import {brVersionIn} from '../src/beads/br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** A `br` that prints the version its cwd's mise.toml pins, offline only. */
const STAND_IN_BR = `#!/bin/sh
if [ "$MISE_OFFLINE" != "1" ]; then
  echo "MISE_OFFLINE is not set: the real mise shim could download br here" >&2
  exit 3
fi
if [ -f fail-version ]; then
  echo "transient failure" >&2
  exit 1
fi
v=$(sed -n 's/.*version = "\\([^"]*\\)".*/\\1/p' mise.toml)
echo "br $v"
`;

function pinFile(version: string): string {
  return `[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "${version}", exe = "br" }\n`;
}

/** A checkout pinned to `version`, and a PATH with the stand-in br first. */
function world(version: string): {checkout: string; path: string} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const bin = join(sb.path, 'bin');
  mkdirSync(bin, {recursive: true});
  writeFileSync(join(bin, 'br'), STAND_IN_BR);
  chmodSync(join(bin, 'br'), 0o755);
  const checkout = join(sb.path, 'checkout');
  mkdirSync(checkout, {recursive: true});
  writeFileSync(join(checkout, 'mise.toml'), pinFile(version));
  return {checkout, path: `${bin}${delimiter}${process.env.PATH ?? ''}`};
}

/** Run `fn` with PATH set to `path`, then put PATH back. */
function withPath<T>(path: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

function versionText(checkout: string): string {
  const version = brVersionIn(checkout);
  return version.kind === 'read' ? version.text : `failed: ${version.reason}`;
}

describe('brVersionIn (home-base-dj5m9.1.6 F2, F4)', () => {
  test('a pin flip in the checkout is seen by the same process', () => {
    const {checkout, path} = world('0.1.37');
    withPath(path, () => {
      expect(versionText(checkout)).toBe('0.1.37');
      writeFileSync(join(checkout, 'mise.toml'), pinFile('0.7.6'));
      expect(versionText(checkout)).toBe('0.7.6');
    });
  });

  test('an unchanged pin is answered from the cache', () => {
    const {checkout, path} = world('0.1.37');
    withPath(path, () => {
      expect(versionText(checkout)).toBe('0.1.37');
      // The stand-in would now fail; the cached answer is still right, since
      // nothing that picks the br has changed.
      writeFileSync(join(checkout, 'fail-version'), '');
      expect(versionText(checkout)).toBe('0.1.37');
    });
  });

  test('a failure is not cached: the next call reads again', () => {
    const {checkout, path} = world('0.7.6');
    withPath(path, () => {
      writeFileSync(join(checkout, 'fail-version'), '');
      expect(versionText(checkout)).toStartWith(
        'failed: br --version exited 1',
      );
      rmSync(join(checkout, 'fail-version'));
      expect(versionText(checkout)).toBe('0.7.6');
    });
  });
});
