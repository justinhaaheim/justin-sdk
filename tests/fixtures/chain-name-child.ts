/**
 * Child process for tests/thread-chain-names.test.ts (home-base-l2ejg.11):
 * wait until <startAt> (epoch ms), so every child reads the registry at about
 * the same moment, then name the chain <root> from the registry in
 * JUSTIN_THREADS_STATE_DIR, holding its lock <holdMs> between the read and the
 * append. The pool is <pool> (comma-separated) and the pick always takes the
 * first free name, so without the lock every child would pick the same one.
 * Prints the outcome as one line of JSON.
 *
 *   chain-name-child.ts <startAt> <holdMs> <root> <pool>
 */

import {chainNameForRoot} from '../../src/thread/chain-names';

const [startAt = '0', holdMs = '0', root = '', pool = ''] =
  process.argv.slice(2);
const wait = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < Number(startAt)) Atomics.wait(wait, 0, 0, 1);
const outcome = chainNameForRoot({
  env: process.env,
  holdMs: Number(holdMs),
  pool: pool.split(','),
  random: () => 0,
  root,
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
