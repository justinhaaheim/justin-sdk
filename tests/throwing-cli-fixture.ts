#!/usr/bin/env bun

/**
 * A CLI with the ONE shape that makes `reportCliFailure` load-bearing
 * (home-base-uxwc.5 F1): an ASYNC middleware, and a SYNC handler that throws.
 *
 * Every real justin-sdk command has that shape — the health-notice middleware
 * is async for all of them — but no real command throws on demand, because they
 * are all written to report their failures and return an exit code. This
 * fixture is the missing half: it reproduces the hazard on purpose, so the
 * handler that fixes it can be driven through a REAL yargs instance.
 *
 * `JSDK_FIXTURE_NO_FAIL=1` omits the handler, which is the control: it is what
 * `cli.ts` did before F1, and it puts a bare newline on stdout.
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {reportCliFailure} from '../src/cli-failure';

const base = yargs(hideBin(process.argv))
  .scriptName('throwing-cli-fixture')
  // ASYNC on purpose: this is what makes yargs 18 route a throwing SYNC
  // handler through usage.fail instead of letting it reach the top level.
  .middleware(async () => {
    await Promise.resolve();
  })
  .command(
    'boom',
    'Throw from a sync handler, having written nothing',
    (y) => y,
    () => {
      throw new Error('boom from a sync handler');
    },
  )
  .command(
    'fine',
    'Write one stdout line and return normally',
    (y) => y,
    () => {
      process.stdout.write('one stdout line\n');
    },
  )
  .demandCommand(1, 'Please specify a command')
  .strict();

void (
  process.env.JSDK_FIXTURE_NO_FAIL === '1' ? base : base.fail(reportCliFailure)
)
  .help()
  .parse();
