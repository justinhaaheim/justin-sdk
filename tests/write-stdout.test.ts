/**
 * F2 (home-base-j8q3e.1.9): a document larger than a pipe's 64 KiB buffer,
 * printed just before process.exit, reaches a piped reader whole.
 *
 * The live negative control is the inbox itself (2026-10-15): with
 * console.log, `thread inbox --json --all | wc -c` printed 65536; with
 * writeStdout, 961435, the same as the file. This fixture does NOT reproduce
 * the cut with console.log (its child spawn alone is not enough), so it guards
 * the helper's contract, not the original trigger.
 */

import {describe, expect, test} from 'bun:test';
import {join} from 'path';

const CHILD = join(import.meta.dir, 'fixtures', 'write-stdout-child.ts');

describe('writeStdout', () => {
  test('a 1 MB JSON document printed before process.exit arrives whole through a pipe', async () => {
    const child = Bun.spawn(['bun', CHILD, 'helper'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(text.length).toBeGreaterThan(65_536);
    const parsed = JSON.parse(text) as {padding: string};
    expect(parsed.padding.length).toBe(1_000_000);
  });
});
