#!/usr/bin/env bun
/**
 * replay-transcript-fold (home-base-9uzxw.16): the incremental transcript
 * fold against REAL transcripts, which hold record shapes no fixture has.
 *
 * For each recent transcript under the Claude projects directory (main and
 * subagent files), the script takes one snapshot of its bytes, writes the
 * start of it (cut on a line boundary, and once in the middle of a line) to a
 * temporary copy, lets the transcript cache read that copy, appends the rest
 * in chunks, and after every chunk compares what the cache answers with a full
 * read of the same bytes. Every fact is compared, as JSON, byte for byte.
 *
 * Read-only towards real data: the transcripts are only read; the copies and
 * the cache live in a temporary directory that is removed at the end.
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {homedir, tmpdir} from 'os';
import {dirname, join, relative} from 'path';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {
  resetTranscriptCacheMemory,
  transcriptCacheStats,
  transcriptFileFacts,
  transcriptFileFactsOfBytes,
} from '../src/thread/transcript-cache';

const argv = yargs(hideBin(process.argv))
  .usage(
    'replay-transcript-fold [--days N] [--limit N] [--max-mb N] [--root <dir>]\n\nReplays real transcripts through the incremental fold and compares each fold with a full read of the same bytes. Read-only towards real data.',
  )
  .option('days', {
    default: 3,
    describe: 'Transcripts modified within',
    type: 'number',
  })
  .option('limit', {
    default: 120,
    describe: 'At most this many files, newest first',
    type: 'number',
  })
  .option('max-mb', {
    default: 40,
    describe: 'Skip files larger than this',
    type: 'number',
  })
  .option('root', {
    default: join(homedir(), '.claude', 'projects'),
    describe: 'The Claude projects directory',
    type: 'string',
  })
  .strict()
  .help()
  .parseSync();

function transcriptsUnder(root: string, since: number): string[] {
  const found: {mtime: number; path: string}[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 3) walk(path, depth + 1);
      } else if (
        name.endsWith('.jsonl') &&
        stat.mtimeMs >= since &&
        stat.size > 0 &&
        stat.size <= argv['max-mb'] * 1024 * 1024
      ) {
        found.push({mtime: stat.mtimeMs, path});
      }
    }
  };
  walk(root, 0);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, argv.limit)
    .map((entry) => entry.path);
}

/** Offsets just after a newline, near each fraction of the file. */
function lineCuts(bytes: Buffer, fractions: number[]): number[] {
  const cuts = new Set<number>();
  for (const fraction of fractions) {
    const at = Math.floor(bytes.length * fraction);
    const newline = bytes.indexOf(0x0a, at);
    if (newline !== -1 && newline + 1 < bytes.length) cuts.add(newline + 1);
  }
  return [...cuts].sort((a, b) => a - b);
}

function firstDifference(a: string, b: string): string {
  const left = JSON.parse(a) as Record<string, unknown>;
  const right = JSON.parse(b) as Record<string, unknown>;
  for (const key of Object.keys(right)) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return key;
  }
  return '(key order)';
}

const work = mkdtempSync(join(tmpdir(), 'replay-transcript-fold-'));
process.env.XDG_CACHE_HOME = join(work, 'cache');
const files = transcriptsUnder(argv.root, Date.now() - argv.days * 86_400_000);
let comparisons = 0;
const mismatches: string[] = [];
let index = 0;
/** Summed per file: resetting the memory also zeroes the cache's counters. */
const totals = {foldReads: 0, foldRefusals: 0, fullReads: 0};
function addStats(): void {
  const stats = transcriptCacheStats();
  totals.foldReads += stats.foldReads;
  totals.foldRefusals += stats.foldRefusals;
  totals.fullReads += stats.fileReads;
}
try {
  for (const source of files) {
    index += 1;
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch {
      continue;
    }
    // Only whole lines: the snapshot may end mid-write.
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end === 0) continue;
    bytes = bytes.subarray(0, end);
    const copy = join(work, 'projects', relative(argv.root, source));
    mkdirSync(dirname(copy), {recursive: true});
    const cuts = lineCuts(bytes, [0.5, 0.9, 0.99]);
    if (cuts.length === 0) continue;
    // Start at the first cut; append up to each later cut, a half line in
    // the middle of the last step (D3), then the rest.
    addStats();
    resetTranscriptCacheMemory();
    writeFileSync(copy, bytes.subarray(0, cuts[0]));
    transcriptFileFacts(copy, {withMessages: true});
    const last = cuts.at(-1) ?? 0;
    const half = last + Math.floor((bytes.length - last) / 2);
    const steps = [...cuts.slice(1), half, bytes.length];
    let from = cuts[0] ?? 0;
    for (const to of steps) {
      if (to <= from) continue;
      appendFileSync(copy, bytes.subarray(from, to));
      from = to;
      const cached = JSON.stringify(
        transcriptFileFacts(copy, {withMessages: true}),
      );
      const full = JSON.stringify(
        transcriptFileFactsOfBytes(readFileSync(copy), copy, true),
      );
      comparisons += 1;
      if (cached !== full) {
        mismatches.push(
          `${source} at ${to} of ${bytes.length}: ${firstDifference(cached, full)}`,
        );
      }
    }
    if (index % 20 === 0) {
      process.stdout.write(`${index} of ${files.length} files\n`);
    }
  }
} finally {
  rmSync(work, {force: true, recursive: true});
}

addStats();
process.stdout.write(
  `${JSON.stringify(
    {
      comparisons,
      files: files.length,
      ...totals,
      mismatches,
    },
    null,
    2,
  )}\n`,
);
process.exit(mismatches.length === 0 ? 0 : 1);
