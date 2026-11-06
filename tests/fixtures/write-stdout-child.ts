/**
 * Child process for tests/write-stdout.test.ts (home-base-p05kz.2): print one
 * document the way a command does, then exit at once.
 *
 *   write-stdout-child.ts <call> <prior> <bytes> <exit> [tail]
 *
 * - call: `async` (writeStdout) or `sync` (writeStdoutSync).
 * - prior: `read-stdout` reads `process.stdout.isTTY` first, which is what the
 *   SDK's CLI and `outputStyle` do and what turns on O_NONBLOCK. `none` does not.
 * - bytes: the document's size in UTF-8 bytes, near enough.
 * - exit: the exit code to finish with.
 * - tail: `console` or `stream` prints one small line after the document, the
 *   way a command prints a footnote. `helper` prints it through the helper.
 */

import {writeStdout, writeStdoutSync} from '../../src/write-stdout';

/**
 * Numbered lines holding an emoji, so a repeat shows as a second `line 000000`,
 * and so UTF-8 bytes and UTF-16 units differ, as they do in a real inbox.
 */
export function buildDocument(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `line ${String(i).padStart(6, '0')} 📥 ${'x'.repeat(36)}`;
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return `${lines.join('\n')}\n`;
}

export const TAIL_LINE = 'the small closing line\n';

async function main(): Promise<void> {
  const [call, prior, bytes, exit, tail] = process.argv.slice(2);
  if (prior === 'read-stdout') void process.stdout.isTTY;
  const document = buildDocument(Number(bytes));
  if (call === 'sync') writeStdoutSync(document);
  else await writeStdout(document);
  if (tail === 'console') console.log(TAIL_LINE.trimEnd());
  if (tail === 'stream') {
    process.stdout.write(TAIL_LINE);
    // A stream error is reported on a later tick, so give it one to report on.
    await Bun.sleep(50);
  }
  if (tail === 'helper') await writeStdout(TAIL_LINE);
  process.exit(Number(exit));
}

if (import.meta.main) await main();
