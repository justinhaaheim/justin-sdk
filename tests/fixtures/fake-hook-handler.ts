/**
 * A stand-in for one SDK hook handler, for tests/hook-dispatch.test.ts. The
 * dispatcher runs `<bun> <this file> <handler args…>`; the first arg picks the
 * behaviour, so a test registry can name any mix of them.
 *
 *   context <text>   additionalContext and systemMessage both <text>, exit 0
 *   message <text>   systemMessage <text>, exit 0
 *   block <reason>   a Stop block as thread stop-check does it: JSON on stdout,
 *                    the reason on stderr, exit 2
 *   fail             "boom" on stderr, exit 1
 *   hang             never exits
 *   garbage          prints text that is not JSON, exit 0
 *   silent           prints nothing, exit 0
 *   echo-stdin       systemMessage = the exact stdin it received
 *   chatty <text>    systemMessage <text>, plus a stderr line, exit 0
 */

import {readFileSync} from 'fs';

const [mode, text = ''] = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

switch (mode) {
  case 'context':
    print({
      hookSpecificOutput: {additionalContext: text, hookEventName: 'Test'},
      systemMessage: text,
    });
    break;
  case 'message':
    print({systemMessage: text});
    break;
  case 'block':
    print({decision: 'block', reason: text, systemMessage: text});
    console.error(text);
    process.exit(2);
  // falls through: process.exit never returns
  case 'fail':
    console.error('boom');
    process.exit(1);
  // falls through: process.exit never returns
  case 'hang':
    setInterval(() => {
      // Keeps the event loop alive, so this process never exits on its own.
    }, 1000);
    break;
  case 'garbage':
    console.log('this is not json');
    break;
  case 'silent':
    break;
  case 'echo-stdin':
    print({systemMessage: stdin});
    break;
  case 'chatty':
    print({systemMessage: text});
    console.error('a diagnostic line');
    break;
  default:
    console.error(`fake-hook-handler: unknown mode ${String(mode)}`);
    process.exit(64);
}
