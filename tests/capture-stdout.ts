/**
 * Collect what `writeStdout` and `writeStdoutSync` print, in-process.
 *
 * They write to fd 1 with `fs.writeSync`, so a spy on `console.log` sees nothing
 * and the text would land on the test runner's own stdout. Each call hands over
 * the text without one trailing newline, the same shape a `console.log` spy
 * collected, so a test that joins the pieces with '\n' reads the same.
 *
 * Real pipe behaviour is tested in tests/write-stdout.test.ts, not through this.
 */

import {spyOn} from 'bun:test';
import fs from 'node:fs';

type WriteSync = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

/** Start collecting. Call `mockRestore()` on the result to stop. */
export function captureWriteStdout(onText: (text: string) => void): {
  mockRestore: () => void;
} {
  const target = fs as unknown as {writeSync: WriteSync};
  const real = target.writeSync.bind(fs);
  return spyOn(target, 'writeSync').mockImplementation(
    (fd, buffer, offset, length) => {
      if (fd !== 1) return real(fd, buffer, offset, length);
      const text = Buffer.from(
        buffer.subarray(offset, offset + length),
      ).toString('utf8');
      onText(text.endsWith('\n') ? text.slice(0, -1) : text);
      return length;
    },
  );
}
