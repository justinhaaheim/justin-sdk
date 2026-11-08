#!/usr/bin/env bun

/**
 * The PARENT half of `justin-sdk update`'s self-update, run as its own process
 * (home-base-ipx4a acceptance 1).
 *
 * After a bump, runUpdate re-executes node_modules/.bin/justin-sdk and then
 * calls process.exit with the child's status, so it cannot run inside the test
 * process. This runs the real runUpdate with only the network seams replaced:
 * the tag lookup answers NEW_TAG, and the bump writes what bun 1.4.2's named
 * `bun add -d` writes. Everything after that is real: the version check, the
 * re-exec of the fixture's node_modules/.bin/justin-sdk (which runs this
 * checkout's CLI), and that child's preflight, install, doctor and commit.
 *
 * Usage: bun update-reexec-parent.ts <projectRoot> [--no-commit]
 */

import {runUpdate} from '../../src/update';
import {fakeGoodBump, fakeLatestTag} from '../update-fixtures';

const USAGE = 'usage: update-reexec-parent.ts <projectRoot> [--no-commit]\n';
if (process.argv.includes('--help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const projectRoot = process.argv[2];
if (projectRoot == null) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const exitCode = await runUpdate({
  noCommit: process.argv.includes('--no-commit'),
  projectRoot,
  selfUpdateDeps: {fetchLatestTag: fakeLatestTag(), runBump: fakeGoodBump()},
});
process.exit(exitCode);
