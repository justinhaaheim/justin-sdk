#!/usr/bin/env bun
/**
 * The transcript cache's golden file (home-base-9uzxw.11):
 * tests/fixtures/transcript-cache/golden.json holds every cached parser's
 * output for the committed fixture transcripts, under the parser version that
 * produced it. tests/thread-transcript-cache.test.ts fails when the output
 * changes; this script records a new output, and REFUSES to record one under
 * a version that already has a different output, so a parser change cannot
 * reach the cache without a bump of TRANSCRIPT_CACHE_VERSION.
 */

import {existsSync, readFileSync, writeFileSync} from 'fs';
import {isDeepStrictEqual} from 'util';

import {TRANSCRIPT_CACHE_VERSION} from '../src/thread/transcript-cache';
import {GOLDEN_PATH, goldenFacts} from '../tests/transcript-cache-fixtures';

const HELP = `transcript-cache-golden: check or record the transcript cache's golden file

Usage:
  bun scripts/transcript-cache-golden.ts            check (exit 0 same, 1 different)
  bun scripts/transcript-cache-golden.ts --update   record the current output

--update refuses (exit 1) when the golden file already holds a DIFFERENT output
under the current TRANSCRIPT_CACHE_VERSION: bump the version in
src/thread/transcript-cache.ts first, so every cached entry of the old parser
is ignored.

File: ${GOLDEN_PATH}
`;

interface Golden {
  facts: unknown;
  version: number;
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const update = argv.includes('--update');
  const facts = goldenFacts();
  const current: Golden | null = existsSync(GOLDEN_PATH)
    ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden)
    : null;
  const same =
    current?.version === TRANSCRIPT_CACHE_VERSION &&
    isDeepStrictEqual(current.facts, facts);
  if (!update) {
    process.stdout.write(
      same
        ? `golden matches (version ${TRANSCRIPT_CACHE_VERSION})\n`
        : `golden DIFFERS from the parsers' output (golden version ${String(current?.version)}, code version ${TRANSCRIPT_CACHE_VERSION})\n`,
    );
    return same ? 0 : 1;
  }
  if (same) {
    process.stdout.write('golden already matches; nothing written\n');
    return 0;
  }
  if (current?.version === TRANSCRIPT_CACHE_VERSION) {
    process.stderr.write(
      `refused: the parsers' output changed but TRANSCRIPT_CACHE_VERSION is still ${TRANSCRIPT_CACHE_VERSION}. Bump it in src/thread/transcript-cache.ts, then run --update again.\n`,
    );
    return 1;
  }
  writeFileSync(
    GOLDEN_PATH,
    `${JSON.stringify({facts, version: TRANSCRIPT_CACHE_VERSION}, null, 2)}\n`,
  );
  process.stdout.write(
    `wrote ${GOLDEN_PATH} (version ${TRANSCRIPT_CACHE_VERSION})\n`,
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
