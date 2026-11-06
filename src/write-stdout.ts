/**
 * Print a document to stdout, whole and once, whatever is reading it.
 *
 * Measured 2026-11-06 on Bun 1.4.2, through real pipes with a slow reader
 * (home-base-p05kz.2; each line below has a test or a probe behind it):
 *
 * - Reading ANY property of `process.stdout` turns on O_NONBLOCK for fd 1. The
 *   SDK's CLI does it at load (the help width), and so does
 *   `outputStyle(process.stdout)`, so assume every command has done it.
 * - After that read, `console.log` keeps only what the pipe takes at once:
 *   65,536 bytes, at every document size. A run of small `console.log` calls
 *   loses lines the same way once the pipe is full, so a small line printed
 *   after a large document can be lost too.
 * - After that read, `Bun.write(Bun.stdout, text)` with text under 262,144
 *   UTF-16 units prints the first 65,536 bytes and then the WHOLE document
 *   again. At 262,144 or more it arrives once. This is why `thread inbox`
 *   repeated at about 107 KB, while its 1 MB JSON form and earlier probes with
 *   larger documents looked fine. A Buffer repeats the same way.
 * - `process.stdout.write(text)` followed by `process.exit` drops what is still
 *   queued. Awaiting its callback works, but it needs a stream error listener
 *   and it reads `process.stdout`.
 * - The `writeSync` loop below is whole at every size, reads nothing from
 *   `process.stdout`, and reports each outcome as a plain errno. EAGAIN means
 *   the pipe is full, so wait and retry from the byte it stopped at.
 *
 * A reader that goes away (`| head`) is normal: printing stops and the command
 * exits with the code it would have had. Any other failure throws, because a
 * document nobody received must not look printed (critical rules section 7).
 */
import fs from 'node:fs';

const STDOUT_FD = 1;

/** Short enough not to slow a reader, long enough to idle under `| less`. */
const FULL_PIPE_WAIT_MS = 5;

function ignoreError(): void {
  // The reader is gone. Nothing printed from here on can reach anyone.
}

/**
 * Later `process.stdout.write` calls would otherwise print an EPIPE stack trace
 * (measured), such as a command's small closing line.
 */
function quietStreamAfterReaderLeft(): void {
  process.stdout.off('error', ignoreError);
  process.stdout.on('error', ignoreError);
}

function errnoCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

type WriteAttempt = 'closed' | 'full' | number;

/** One `write`: the bytes it took, or why it took none. Other failures throw. */
function attemptWrite(bytes: Buffer, from: number): WriteAttempt {
  try {
    return fs.writeSync(STDOUT_FD, bytes, from, bytes.length - from);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EAGAIN') return 'full';
    if (code === 'EPIPE') {
      quietStreamAfterReaderLeft();
      return 'closed';
    }
    throw error;
  }
}

/** Print `text`. Resolves once a reader or file has all of it, or has gone. */
export async function writeStdout(text: string): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const attempt = attemptWrite(bytes, written);
    if (attempt === 'closed') return;
    if (attempt === 'full') await Bun.sleep(FULL_PIPE_WAIT_MS);
    else written += attempt;
  }
}

/**
 * The same print for code whose interface cannot wait, such as the check
 * runner's output sink. Blocks the event loop while the pipe is full, so prefer
 * `writeStdout` wherever the caller can await.
 */
export function writeStdoutSync(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const attempt = attemptWrite(bytes, written);
    if (attempt === 'closed') return;
    if (attempt === 'full') Bun.sleepSync(FULL_PIPE_WAIT_MS);
    else written += attempt;
  }
}
