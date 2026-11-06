/**
 * home-base-j8q3e.16 and home-base-p05kz.3 item 4: a tracked session's
 * uncommitted files are the ones its own transcript shows it writing. The rest
 * of the checkout's dirt is the per-checkout note, once, and never disappears.
 */

import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  type SessionDirt,
  unattributedOfListed,
} from '../src/thread/session-inbox';
import {
  createLoadCache,
  dirtOfGit,
  type GitMeasurements,
  measured,
  measureGit,
} from '../src/thread/session-model';
import {initRepo, write} from './git-fixtures';
import {createSandbox} from './sandbox';

let sb: Sandbox;
let repo: string;
let gitA: GitMeasurements;
let gitB: GitMeasurements;
let gitGone: GitMeasurements;

function transcriptWriting(name: string, file: string | null): string {
  const dir = join(sb.path, 'projects');
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `${name}.jsonl`);
  const content =
    file == null
      ? []
      : [
          {
            id: `toolu_${name}`,
            input: {content: 'x\n', file_path: file},
            name: 'Write',
            type: 'tool_use',
          },
        ];
  writeFileSync(
    path,
    `${JSON.stringify({
      message: {content, role: 'assistant'},
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      type: 'assistant',
    })}\n`,
  );
  return path;
}

async function gitOf(
  location: Parameters<typeof measureGit>[0]['transcript'],
): Promise<GitMeasurements> {
  return await measureGit({
    cache: createLoadCache(),
    checkout: repo,
    checkoutSource: 'logCwd',
    firstPromptAt: measured('2020-01-01T00:00:00.000Z'),
    transcript: location,
  });
}

function sourceOf(git: GitMeasurements, sessionId: string): SessionDirt {
  const dirt = dirtOfGit(git);
  if (dirt == null) throw new Error('the checkout was not measured');
  return {dirt, sessionId};
}

beforeAll(async () => {
  sb = createSandbox();
  repo = initRepo(sb, 'shared', {
    '.beads/issues.jsonl': '{}\n',
    'a.ts': '1\n',
    'b.ts': '1\n',
  });
  write(repo, '.beads/issues.jsonl', '{"edited":true}\n');
  write(repo, 'a.ts', '2\n');
  write(repo, 'b.ts', '2\n');
  gitA = await gitOf({
    ok: true,
    path: transcriptWriting('session-a', join(repo, 'a.ts')),
  });
  gitB = await gitOf({ok: true, path: transcriptWriting('session-b', null)});
  gitGone = await gitOf({ok: false, reason: 'its transcript is gone'});
});

afterAll(() => sb.cleanup());

describe('two tracked sessions in one checkout', () => {
  test("each session owns only what its transcript wrote; the beads file is nobody's", () => {
    expect(gitA.checkoutDirty).toEqual(measured(['a.ts', 'b.ts']));
    expect(gitB.checkoutDirty).toEqual(measured(['a.ts', 'b.ts']));
    expect(gitA.uncommitted).toEqual(measured(['a.ts']));
    expect(gitB.uncommitted).toEqual(measured([]));
  });

  test('a transcript that cannot be read is unmeasured, never "0 uncommitted"', async () => {
    expect(gitGone.uncommitted).toEqual({
      ok: false,
      reason: `the uncommitted files in ${gitGone.checkout} could not be attributed to this session: its transcript is gone`,
    });
    const missing = await gitOf({
      ok: true,
      path: join(sb.path, 'projects', 'never-written.jsonl'),
    });
    expect(missing.uncommitted.ok).toBe(false);
  });

  test('the note names the dirt no listed session claims, and b.ts still shows', () => {
    const sources: SessionDirt[] = [sourceOf(gitA, 'a'), sourceOf(gitB, 'b')];
    expect(unattributedOfListed(sources, new Set(['a', 'b']))).toEqual([
      {checkout: gitA.checkout, paths: ['b.ts'], unchecked: 0},
    ]);
  });

  test('a file claimed only by a hidden session stays in the note', () => {
    const sources: SessionDirt[] = [sourceOf(gitA, 'a'), sourceOf(gitB, 'b')];
    expect(unattributedOfListed(sources, new Set(['b']))).toEqual([
      {checkout: gitA.checkout, paths: ['a.ts', 'b.ts'], unchecked: 0},
    ]);
  });

  test('an unattributable session is counted as unchecked in the note', () => {
    const sources: SessionDirt[] = [sourceOf(gitGone, 'gone')];
    expect(unattributedOfListed(sources, new Set(['gone']))).toEqual([
      {checkout: gitGone.checkout, paths: ['a.ts', 'b.ts'], unchecked: 1},
    ]);
  });
});
