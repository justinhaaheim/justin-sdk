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

process.env.XDG_CACHE_HOME = mkdtempSync(
  join(tmpdir(), 'justin-sdk-test-cache-'),
);
