/**
 * Loaded before every test file (bunfig.toml, `[test] preload`).
 *
 * The threads transcript cache (src/thread/transcript-cache.ts,
 * home-base-9uzxw.11) is on by default and writes under `$XDG_CACHE_HOME`. A
 * test that reads an inbox must never write entries into the real
 * `~/.cache`, so the whole run gets a temporary cache home. A test that needs
 * its own (tests/thread-transcript-cache.test.ts) sets it again.
 */

import {mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {installGitPin} from './pinned-git';
import {installSpawnRecorderFromEnv} from './spawn-recorder';

process.env.XDG_CACHE_HOME = mkdtempSync(
  join(tmpdir(), 'justin-sdk-test-cache-'),
);

/**
 * The status report's Jobs line reads the chores health file
 * (src/job-health.ts, home-base-1rxt0.10). An EMPTY chores state dir for the
 * whole run: no health file and no run log, so no Jobs line, and no test's
 * Part 1 depends on what is broken on this Mac today.
 */
process.env.CHORES_STATE_DIR = mkdtempSync(
  join(tmpdir(), 'justin-sdk-test-chores-'),
);

/**
 * The same for the Vitals line (src/vitals.ts, home-base-sg9q9.7): an EMPTY
 * vitals state dir, so no Part 1 shows what home-base `vitals` found on this
 * Mac today.
 */
process.env.VITALS_STATE_DIR = mkdtempSync(
  join(tmpdir(), 'justin-sdk-test-vitals-'),
);

/**
 * Git without the /usr/bin/git xcrun shim (tests/pinned-git.ts,
 * home-base-ejsq2.2): the same binary the shim runs, about 4 ms sooner per
 * call. Where it cannot be pinned (no xcrun, as on Linux) it changes nothing
 * and prints one line saying why.
 */
installGitPin();

/**
 * The subprocess recorder (tests/spawn-recorder.ts, home-base-ejsq2.1), OFF
 * unless JUSTIN_SDK_TEST_SPAWN_LOG names a jsonl file:
 * `bun run test:timing --help` runs the suite with it on. Unset, this call
 * returns at once and the run is what it was without it.
 */
installSpawnRecorderFromEnv();
