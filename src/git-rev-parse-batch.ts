/**
 * Several `git rev-parse` answers for ONE directory from one git call
 * (home-base-ejsq2.3 part B). A caller lists the separate calls it used to
 * run; `revParseBatchArgs` joins their flags into one argv, and
 * `splitRevParseBatch` hands back, per call, exactly the stdout that call
 * would have printed on its own: one line and its newline.
 *
 * When the batch is not a clean success (non-zero exit, a spawn error, or not
 * exactly one non-blank line per call), the caller runs the separate calls as
 * before. Git stops at the first flag that fails, so a batch's failure cannot
 * say which piece failed or what the others would have answered; the separate
 * calls can, and their failures keep the text they always had. Nothing is
 * kept between calls.
 *
 * ORDER MATTERS. `--abbrev-ref` applies to every revision after it, so it
 * goes last. `--path-format=absolute` applies to every path flag after it.
 * Measured 2026-11-14 on git 2.54.0 in a normal repo, a detached HEAD, a
 * linked worktree and a branch whose commit object is missing: each piece of
 * `--show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir
 * HEAD --abbrev-ref HEAD` printed the line its separate call printed. In an
 * unborn branch, a bare repo, a `.git` directory and outside any repo the
 * batch exits 128 and the separate calls run (tests/git-rev-parse-batch.test.ts).
 */

/** One separate call, as its argv: `['rev-parse', ...flags]`. */
export type RevParseCall = readonly string[];

/** The flags of `calls`, in order, as one `git rev-parse` argv. */
export function revParseBatchArgs(calls: readonly RevParseCall[]): string[] {
  const flags: string[] = [];
  for (const call of calls) {
    if (call[0] !== 'rev-parse') {
      throw new Error(`not a rev-parse call: git ${call.join(' ')}`);
    }
    flags.push(...call.slice(1));
  }
  return ['rev-parse', ...flags];
}

/**
 * The batch's stdout as one stdout per call (`<line>\n`), or null when it is
 * not exactly `count` non-blank lines. A path holding a newline, or a flag that
 * printed nothing, makes the count wrong, and the caller then asks separately.
 */
export function splitRevParseBatch(
  stdout: string,
  count: number,
): string[] | null {
  if (!stdout.endsWith('\n')) return null;
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== count) return null;
  if (lines.some((line) => line.trim() === '')) return null;
  return lines.map((line) => `${line}\n`);
}
