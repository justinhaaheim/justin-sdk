/**
 * Child process for tests/thread-question-counter.test.ts (home-base-4wfoz):
 * wait until <startAt> (epoch ms), so every child reads the counter at about
 * the same moment, then reserve one question number from the counter in
 * JUSTIN_THREADS_STATE_DIR, holding its lock <holdMs> between the read and
 * the write. Prints the outcome as one line of JSON.
 *
 *   reserve-question-number-child.ts <startAt> <holdMs>
 */

import {reserveQuestionNumbers} from '../../src/thread/question-counter';

const [startAt = 0, holdMs = 0] = process.argv.slice(2).map(Number);
const wait = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < startAt) Atomics.wait(wait, 0, 0, 1);
const outcome = reserveQuestionNumbers({count: 1, env: process.env, holdMs});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
