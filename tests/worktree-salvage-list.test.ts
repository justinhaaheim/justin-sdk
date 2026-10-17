/**
 * worktree-salvage list (D8, AC 6): every save per repo root and worktree,
 * and no stamp directory mistaken for a save it is not.
 */

import type {Destination} from '../src/worktree-salvage/config';
import type {SaveListing} from '../src/worktree-salvage/list';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  listSaves,
  renderList,
  runListCommand,
} from '../src/worktree-salvage/list';
import {saveCheckout} from '../src/worktree-salvage/save';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {buildDirtyWorktree, captureIo} from './worktree-salvage-fixtures';

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function flagDestination(dir: string): Destination {
  return {configFile: '/nonexistent/config.json', dir, source: 'flag'};
}

function saveInto(worktree: string, out: string): string {
  const result = saveCheckout({
    checkout: worktree,
    destination: flagDestination(out),
    includeIgnored: false,
  });
  if (result.kind !== 'saved') {
    throw new Error(`expected a save: ${result.kind}`);
  }
  return result.stampDir;
}

function listOrThrow(out: string, repo: string | null = null): SaveListing[] {
  const result = listSaves(out, repo);
  if (!result.ok) throw new Error(result.error);
  return result.saves;
}

describe('listSaves', () => {
  test('a complete save carries its stamp, files, bytes, branch, base commit and whether the worktree still exists', () => {
    const sb = track();
    const {primary, worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const stampDir = saveInto(worktree, out);
    const [listing] = listOrThrow(out);
    expect(listing).toMatchObject({
      baseCommit: git(worktree, ['rev-parse', 'HEAD']).trim(),
      branch: 'feature',
      dir: stampDir,
      files: 10,
      repoFolder: 'primary',
      repoRoot: primary,
      sourceExists: true,
      state: 'complete',
      worktreeFolder: 'feature',
      worktreePath: worktree,
    });
    expect(listing?.bytes).toBeGreaterThan(0);

    rmSync(worktree, {force: true, recursive: true});
    expect(listOrThrow(out)[0]?.sourceExists).toBe(false);
  });

  test('a stamp directory with no manifest is INCOMPLETE, a .failed one is FAILED, a broken manifest is UNREADABLE', () => {
    const sb = track();
    const out = join(sb.path, 'out');
    const parent = join(out, 'repo', 'wt');
    mkdirSync(join(parent, '2026-10-17-100000', 'files'), {recursive: true});
    mkdirSync(join(parent, '2026-10-17-110000.failed'), {recursive: true});
    mkdirSync(join(parent, '2026-10-17-120000'), {recursive: true});
    writeFileSync(
      join(parent, '2026-10-17-120000', 'manifest.json'),
      '{"tool":',
    );
    const states = listOrThrow(out).map((save) => [save.stamp, save.state]);
    expect(states).toEqual([
      ['2026-10-17-100000', 'incomplete'],
      ['2026-10-17-110000', 'failed'],
      ['2026-10-17-120000', 'unreadable'],
    ]);
    const printed = renderList(
      {ok: true, outDirExists: true, saves: listOrThrow(out)},
      flagDestination(out),
      PLAIN_STYLE,
    );
    expect(printed).toContain(
      'INCOMPLETE: no manifest.json, so this is not a save and restore refuses it',
    );
    expect(printed).toContain('FAILED: not a save; kept for inspection');
    expect(printed).toContain('UNREADABLE: manifest.json is not valid JSON');
    expect(printed).toContain(
      'saves:        0 complete saves, plus 3 stamp directories that are not a save (marked below)',
    );
  });

  test('two repos with one basename share a folder but are listed under their own roots', () => {
    const first = track();
    const second = track();
    const out = join(first.path, 'out');
    const a = buildDirtyWorktree(first);
    const b = buildDirtyWorktree(second);
    saveInto(a.worktree, out);
    saveInto(b.worktree, out);
    const saves = listOrThrow(out);
    expect(saves).toHaveLength(2);
    // Same <repo>/<worktree> folder, distinct stamp directories...
    expect(
      new Set(saves.map((save) => `${save.repoFolder}/${save.worktreeFolder}`)),
    ).toEqual(new Set(['primary/feature']));
    expect(new Set(saves.map((save) => save.dir)).size).toBe(2);
    // ...and two repo roots in the printout.
    const printed = renderList(
      {ok: true, outDirExists: true, saves},
      flagDestination(out),
      PLAIN_STYLE,
    );
    expect(printed).toContain(`📁 ${a.primary}`);
    expect(printed).toContain(`📁 ${b.primary}`);
    expect(listOrThrow(out, a.primary).map((save) => save.repoRoot)).toEqual([
      a.primary,
    ]);
  });

  test('a destination that does not exist yet is "none", not an error', () => {
    const sb = track();
    const result = listSaves(join(sb.path, 'nothing-here'), null);
    expect(result).toEqual({ok: true, outDirExists: false, saves: []});
  });
});

describe('runListCommand', () => {
  test('--json prints the same listing as JSON', async () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    saveInto(worktree, out);
    mkdirSync(join(out, 'primary', 'feature', '2099-01-01-000000'));
    const capture = captureIo(sb.path);
    const code = await runListCommand(
      {json: true, out, repo: null},
      capture.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(capture.out.join('')) as {
      destination: Destination;
      saves: SaveListing[];
    };
    expect(parsed.destination.dir).toBe(out);
    expect(parsed.saves.map((save) => save.state)).toEqual([
      'complete',
      'incomplete',
    ]);
    expect(parsed.saves[0]).toMatchObject({branch: 'feature', files: 10});
  });

  test('the text listing groups by repo root and worktree, with every field', async () => {
    const sb = track();
    const {primary, worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const stampDir = saveInto(worktree, out);
    const capture = captureIo(sb.path);
    expect(
      await runListCommand({json: false, out, repo: null}, capture.io),
    ).toBe(0);
    const printed = capture.out.join('');
    expect(printed).toContain(`📁 ${primary}`);
    expect(printed).toContain(`worktree:       ${worktree}`);
    expect(printed).toContain('still on disk:  yes');
    expect(printed).toContain('files:        10 files');
    expect(printed).toContain('branch:       feature');
    expect(printed).toContain(`saved in:     ${stampDir}`);
  });
});
