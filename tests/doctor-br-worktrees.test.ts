/**
 * doctor lists the linked worktrees pinned to a br older than the main
 * checkout's, and the ones whose br cannot be read (home-base-dj5m9.1.6 F10;
 * layer 3 of the decision in home-base-dj5m9.1.7).
 *
 * A throwaway repo under $TMPDIR whose main checkout pins br 0.7.6 in
 * mise.toml, with three linked worktrees: one pinned to 0.1.37 (older), one to
 * 0.7.6 (same), and one pinned to `latest`, whose br is then asked with
 * `br --version` and fails (tests/br-by-cwd.ts points it at a missing
 * binary). No real br runs; no beads database exists.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.6): skip the
 * `unknown.push(...)` for a failed version → "older and unknown" fails (the
 * `latest` worktree is not listed).
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {brWorktreesCheckResult} from '../src/doctor';
import {brByCwd, withPath} from './br-by-cwd';
import {addLinkedWorktree, initRepo} from './git-fixtures';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function pin(version: string): string {
  return `[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "${version}", exe = "br" }\n`;
}

describe('BR_WORKTREES (F10)', () => {
  test('older and unknown worktrees are listed; a same-pin worktree is not', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const shim = brByCwd(sb);
    const primary = initRepo(sb, 'repo', {'mise.toml': pin('0.7.6')});
    const worktree = (name: string, version: string): string => {
      const path = addLinkedWorktree(
        primary,
        join(primary, '.claude', 'worktrees', name),
        `${name}-branch`,
      );
      writeFileSync(join(path, 'mise.toml'), pin(version));
      return path;
    };
    const old = worktree('old', '0.1.37');
    const same = worktree('same', '0.7.6');
    const latest = worktree('latest', 'latest');
    shim.pin(latest, join(sb.path, 'no-such-br'));

    const result = withPath(shim.path, () => brWorktreesCheckResult(same));
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(`${old}: br 0.1.37`);
    expect(result.message).toContain(`${latest}: br unknown`);
    expect(result.message).not.toContain(`${same}:`);
    expect(result.fix).toContain('Merge main into each worktree listed');
  });

  test('control: every worktree on the main pin passes', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const primary = initRepo(sb, 'repo', {'mise.toml': pin('0.7.6')});
    addLinkedWorktree(primary, join(primary, '.claude', 'worktrees', 'a'), 'a');
    const result = brWorktreesCheckResult(primary);
    expect(result.pass).toBe(true);
    expect(result.message).toContain('1 linked worktree, none');
  });
});
