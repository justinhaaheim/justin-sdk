/**
 * Child process for tests/write-stdout.test.ts (home-base-j8q3e.1.9, F2): run
 * a child process the way session-model.ts runs git, print a large document,
 * then exit at once, as a CLI handler does. argv[2] picks the writer:
 * `helper` (writeStdout) or `console` (the old console.log, the negative
 * control).
 */

import {spawn} from 'child_process';

import {writeStdout} from '../../src/write-stdout';

const SIZE = 1_000_000;

await new Promise<void>((resolve) => {
  const child = spawn('git', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('close', () => resolve());
  child.on('error', () => resolve());
});

const document = JSON.stringify({padding: 'x'.repeat(SIZE)});
if (process.argv[2] === 'console') {
  console.log(document);
} else {
  await writeStdout(`${document}\n`);
}
process.exit(0);
