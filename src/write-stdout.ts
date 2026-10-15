/**
 * Write text to stdout and wait until all of it has been written.
 *
 * home-base-j8q3e.1.9 (F2): `thread inbox --json --all | wc -c` printed 65536
 * when its document was about 960 KB (measured 2026-10-15). The command's
 * `console.log` returned with most of the text still queued for the pipe, and
 * the handler's `process.exit` then dropped it: every consumer reading through
 * a pipe got cut, invalid JSON. A plain script doing the same did not cut, so
 * the queueing depends on what else the process did first (the inbox spawns
 * many git children); this helper does not rely on that. Any command that
 * prints a large document and then calls `process.exit` should print it here.
 */
export async function writeStdout(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text);
}
