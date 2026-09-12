/**
 * `readComments` — the one read that used to swallow unparseable output (F3).
 *
 * An unreadable answer list and "he has not answered" are opposite facts, and
 * the old `[`-prefix fallback collapsed them in the reassuring direction: any
 * banner printed ahead of the JSON became an empty list, so `thread inbox` said
 * "checked, and he has not answered" and exited 0.
 */

import {describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  checkBdReachable,
  describeBdFailure,
  isLockedText,
  readComments,
  type BdContext,
} from '../src/thread/bd';

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

/**
 * THE LOCK CLASSIFIER (F10).
 *
 * It was a bare `/lock/i`, which matched the substring inside "blocked" and
 * "unlock" — both of which are real bd output. `strings` over the shipped bd
 * 1.1.0 binary (measured 2026-09-12) has `Blocked by %d open dependencies: %v`
 * and `depends on (is blocked by) the specified issue.` right alongside the
 * genuine lock messages asserted below. Misclassifying one of those cost three
 * retries with backoff and a NOT RECORDED banner naming the wrong cause.
 *
 * The live messages could not be provoked: six concurrent `bd create`s against
 * an isolated $TMPDIR workspace all exited 0 (the embedded backend serialises
 * writers). So the catalogue comes from the binary, and the matcher stays
 * generous within lock-shaped text — under-matching only loses the retries.
 */
describe('isLockedText (F10)', () => {
  const REAL_LOCK_MESSAGES = [
    'embeddeddolt: another process holds the exclusive lock on /Users/jhaa/Dev/life/.beads/embeddeddolt; the embedded backend supports only one writer at a time',
    'The Dolt database is locked.',
    'Stale lock files detected: .beads/.write.lock. Lock files from crashed or killed bd processes prevent new operations.',
    'timed out after 30s opening beads storage. Another bd process or stale storage lock may be blocking memory injection',
    'error: database is locked',
    'fatal: Unable to create /Users/jhaa/Dev/life/.git/index.lock: File exists.',
    'flock: resource temporarily unavailable',
  ];

  const NOT_LOCKS = [
    'Blocked by 3 open dependencies: jl-a1.2',
    'error: jl-a1 is blocked by jl-a2: waiting [open]',
    '[blocked]  - Step is blocked by dependencies',
    'depends on (is blocked by) the specified issue.',
    'unlock the issue first with bd unblock',
    'error: unknown shorthand flag: "s" in -s',
  ];

  test('every measured lock message classifies as a lock', () => {
    for (const text of REAL_LOCK_MESSAGES) {
      expect([text, isLockedText(text)]).toEqual([text, true]);
    }
  });

  test('"blocked" and "unlock" are NOT locks', () => {
    for (const text of NOT_LOCKS) {
      expect([text, isLockedText(text)]).toEqual([text, false]);
    }
  });
});

/** A workspace whose `bd` records each call and fails with a chosen stderr. */
function workspaceFailing(stderr: string): {
  calls: () => number;
  cleanup: () => void;
  ctx: BdContext;
} {
  const dir = mkdtempSync(join(tmpdir(), 'thread-bd-fail-'));
  const log = join(dir, 'calls.log');
  const script = join(dir, 'fake-bd.ts');
  writeFileSync(
    script,
    [
      `import {appendFileSync} from 'fs';`,
      `appendFileSync(${JSON.stringify(log)}, 'call\\n');`,
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(1);`,
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({name: 'fake-life', scripts: {bd: `bun ${script}`}}),
  );
  return {
    calls: () =>
      existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0,
    cleanup: () => rmSync(dir, {force: true, recursive: true}),
    ctx: {env: process.env, lifeDir: dir},
  };
}

describe('classify, end to end through a real subprocess', () => {
  test('a dependency message fails ONCE — no lock retries, no lock banner', async () => {
    const {calls, cleanup, ctx} = workspaceFailing(
      'error: Blocked by 3 open dependencies: jl-a1.2\n',
    );
    try {
      const result = await checkBdReachable(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('failed');
      expect(describeBdFailure(result.failure)).not.toContain('stayed locked');
      expect(calls()).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('a REAL lock message is retried, then reported as locked', async () => {
    const {calls, cleanup, ctx} = workspaceFailing(
      'error: The Dolt database is locked.\n',
    );
    try {
      const result = await checkBdReachable(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('locked');
      expect(calls()).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('the sandbox wins over the lock test, as it always did', async () => {
    // The sandbox's own refusal is `openat LOCK: operation not permitted`,
    // which matches both patterns; retrying it would be pure latency.
    const {calls, cleanup, ctx} = workspaceFailing(
      'openat LOCK: operation not permitted\n',
    );
    try {
      const result = await checkBdReachable(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('sandbox-denied');
      expect(calls()).toBe(1);
    } finally {
      cleanup();
    }
  });
});
