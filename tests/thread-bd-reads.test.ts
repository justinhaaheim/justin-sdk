/**
 * `readComments` — the one read that used to swallow unparseable output (F3).
 *
 * An unreadable answer list and "he has not answered" are opposite facts, and
 * the old `[`-prefix fallback collapsed them in the reassuring direction: any
 * banner printed ahead of the JSON became an empty list, so `thread inbox` said
 * "checked, and he has not answered" and exited 0.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {readComments, type BdContext} from '../src/thread/bd';

/** A fake life workspace whose `bd` script prints whatever we want. */
function workspacePrinting(stdout: string): {
  ctx: BdContext;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'thread-bd-'));
  mkdirSync(join(dir, 'bin'), {recursive: true});
  const script = join(dir, 'fake-bd.ts');
  writeFileSync(script, `process.stdout.write(${JSON.stringify(stdout)});\n`);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({name: 'fake-life', scripts: {bd: `bun ${script}`}}),
  );
  return {
    cleanup: () => rmSync(dir, {force: true, recursive: true}),
    ctx: {env: process.env, lifeDir: dir},
  };
}

describe('readComments', () => {
  test('a real JSON array is parsed', async () => {
    const {cleanup, ctx} = workspacePrinting('[{"text":"ANSWER: b"}]');
    try {
      const result = await readComments(ctx, 'jl-a1.1');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value[0]?.text).toBe('ANSWER: b');
    } finally {
      cleanup();
    }
  });

  test('an EMPTY array is a measured "no comments"', async () => {
    const {cleanup, ctx} = workspacePrinting('[]\n');
    try {
      const result = await readComments(ctx, 'jl-a1.1');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // THE FINDING. A banner ahead of the JSON must NOT read as "no answers".
  test('a notice printed before the JSON is BAD-JSON, never an empty list', async () => {
    const {cleanup, ctx} = workspacePrinting(
      'A new version of bd is available!\n[{"text":"ANSWER: b"}]',
    );
    try {
      const result = await readComments(ctx, 'jl-a1.1');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('bad-json');
    } finally {
      cleanup();
    }
  });

  test('bd printing nothing at all is BAD-JSON, never an empty list', async () => {
    const {cleanup, ctx} = workspacePrinting('');
    try {
      const result = await readComments(ctx, 'jl-a1.1');
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('the literal "No comments" sentence is still honoured as empty', async () => {
    const {cleanup, ctx} = workspacePrinting('No comments on jl-a1.1\n');
    try {
      const result = await readComments(ctx, 'jl-a1.1');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
