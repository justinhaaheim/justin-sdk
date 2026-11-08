/**
 * The batched short-sha look-up (home-base-9uzxw.2, D-PERF): one
 * `git cat-file --batch-check` per session must give exactly what one
 * `git rev-parse --verify --quiet <sha>^{commit}` per sha gave, in a real
 * repo: a commit, a name that does not exist, a blob, and a prefix two
 * commits share. When the batch cannot be trusted, the per-sha path runs.
 */

import type {GitRun} from '../src/thread/session-commits';
import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';

import {
  attributeCommits,
  batchShortShaLookups,
  shortShaArgs,
} from '../src/thread/session-commits';
import {initRepo} from './git-fixtures';
import {createSandbox} from './sandbox';

function run(cwd: string, args: string[], input?: string): GitRun {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(input == null ? {} : {input}),
  });
  if (result.error != null) {
    return {kind: 'error', message: result.error.message};
  }
  return result.status === 0
    ? {kind: 'ok', stdout: result.stdout}
    : {kind: 'exit', status: result.status ?? -1, stderr: result.stderr.trim()};
}

/** What attributeCommits reads from a rev-parse: ok with a sha, or exit 1. */
function verdictOf(gitRun: GitRun): string {
  if (gitRun.kind === 'ok') return `ok ${gitRun.stdout.trim()}`;
  if (gitRun.kind === 'exit') return `exit ${gitRun.status}`;
  return 'error';
}

let sb: Sandbox;
let repo: string;
let head: string;
let blob: string;
let ambiguous: string;

beforeAll(() => {
  sb = createSandbox();
  repo = initRepo(sb, 'batch-repo', {'README.md': '# r\n'});
  // 1,500 commits in one fast-import: enough that two share a 4-hex prefix.
  let stream = '';
  for (let i = 1; i <= 1500; i += 1) {
    const message = `c${i}\n`;
    stream += `commit refs/heads/many\nmark :${i}\ncommitter T <t@t> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += '\n';
  }
  const imported = run(repo, ['fast-import', '--quiet'], stream);
  if (imported.kind !== 'ok') throw new Error(JSON.stringify(imported));
  head = verdictOf(run(repo, ['rev-parse', 'HEAD'])).slice(3);
  blob = verdictOf(run(repo, ['rev-parse', 'HEAD:README.md'])).slice(3);
  const all = verdictOf(run(repo, ['rev-list', 'many']))
    .slice(3)
    .split('\n');
  const seen = new Map<string, number>();
  for (const sha of all) {
    seen.set(sha.slice(0, 4), (seen.get(sha.slice(0, 4)) ?? 0) + 1);
  }
  const shared = [...seen.entries()].find(([, count]) => count > 1);
  if (shared == null) throw new Error('no shared 4-hex prefix in 1,500');
  ambiguous = shared[0];
});

afterAll(() => {
  sb.cleanup();
});

describe('batchShortShaLookups', () => {
  test('gives what one rev-parse per sha gives: a commit, a missing name, a blob, an ambiguous prefix', async () => {
    const shorts = [
      head.slice(0, 7),
      'deadbee',
      blob.slice(0, 9),
      ambiguous,
      head,
    ];
    const batched = await batchShortShaLookups(shorts, (args, input) =>
      run(repo, args, input),
    );
    expect(batched).not.toBeNull();
    const perSha = shorts.map((shortSha) =>
      verdictOf(run(repo, shortShaArgs(shortSha))),
    );
    expect(batched?.map((lookup) => verdictOf(lookup.run))).toEqual(perSha);
    expect(perSha).toEqual([
      `ok ${head}`,
      'exit 1',
      'exit 1',
      'exit 1',
      `ok ${head}`,
    ]);
    expect(batched?.map((lookup) => lookup.args)).toEqual(
      shorts.map(shortShaArgs),
    );
  });

  test('null, so the per-sha path runs, when git fails or prints what it should not', async () => {
    const shorts = [head.slice(0, 7), 'deadbee'];
    expect(
      await batchShortShaLookups(shorts, () => ({
        kind: 'error',
        message: 'spawn git ENOENT',
      })),
    ).toBeNull();
    expect(
      await batchShortShaLookups(shorts, () => ({
        kind: 'exit',
        status: 128,
        stderr: 'fatal: not a git repository',
      })),
    ).toBeNull();
    // One line short.
    expect(
      await batchShortShaLookups(shorts, () => ({
        kind: 'ok',
        stdout: `${head} commit\n`,
      })),
    ).toBeNull();
    // An answer git might give that rev-parse has no twin for.
    expect(
      await batchShortShaLookups(shorts, () => ({
        kind: 'ok',
        stdout: `${head} commit\ndeadbee^{commit} ambiguous\n`,
      })),
    ).toBeNull();
    // A commit line for a sha the short does not name (lines out of order).
    expect(
      await batchShortShaLookups(['deadbee', head.slice(0, 7)], () => ({
        kind: 'ok',
        stdout: `${head} commit\ndeadbee^{commit} missing\n`,
      })),
    ).toBeNull();
    expect(
      await batchShortShaLookups([], () => ({kind: 'ok', stdout: ''})),
    ).toEqual([]);
  });
});

describe('attributeCommits with a batch runner', () => {
  const evidence = () => ({
    calls: [],
    confirmations: [
      {file: 't', shortSha: head.slice(0, 7), subject: 'x'},
      {file: 't', shortSha: 'deadbee', subject: 'y'},
      {file: 't', shortSha: ambiguous, subject: 'z'},
    ],
  });

  test('one git process instead of one per sha, and the same answer', async () => {
    const perShaCalls: string[][] = [];
    const perSha = await attributeCommits(evidence(), (args) => {
      perShaCalls.push(args);
      return run(repo, args);
    });
    const batchCalls: string[][] = [];
    const batched = await attributeCommits(
      evidence(),
      (args) => {
        batchCalls.push(args);
        return run(repo, args);
      },
      (args, input) => {
        batchCalls.push(args);
        return run(repo, args, input);
      },
    );
    expect(batched).toEqual(perSha);
    expect(batched).toEqual({
      ok: true,
      value: {
        count: 1,
        shas: [head],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: ['deadbee', ambiguous],
      },
    });
    expect(perShaCalls).toHaveLength(3);
    expect(batchCalls.map((args) => args[0])).toEqual(['cat-file']);
  });

  test('a batch that cannot be trusted falls back to one rev-parse per sha', async () => {
    const calls: string[][] = [];
    const result = await attributeCommits(
      evidence(),
      (args) => {
        calls.push(args);
        return run(repo, args);
      },
      () => ({kind: 'exit', status: 128, stderr: 'fatal: boom'}),
    );
    expect(result.ok && result.value.unresolved).toEqual([
      'deadbee',
      ambiguous,
    ]);
    expect(calls.map((args) => args[0])).toEqual([
      'rev-parse',
      'rev-parse',
      'rev-parse',
    ]);
  });
});
