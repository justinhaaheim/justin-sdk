/**
 * Runs ONE sweep in its own process, so a test can kill it mid-run
 * (home-base-39co9.6 AC1/AC5: "a run interrupted after committing").
 *
 * Not a test file — `bun test` collects only `*.test.ts`. Its one argument is a
 * JSON `SweepOptions`; its exit code is the sweep's.
 *
 *   bun tests/sweep-child-runner.ts '{"component":"gitignore","repos":["/x"]}'
 */

import {runSweep, type SweepOptions} from '../src/sweep';

const raw = process.argv[2];
if (raw == null || raw === '--help') {
  console.log(
    'usage: bun tests/sweep-child-runner.ts <SweepOptions as JSON> — runs one sweep in this process',
  );
  process.exit(raw == null ? 2 : 0);
}
const options = JSON.parse(raw) as SweepOptions;
process.exit(await runSweep(options));
