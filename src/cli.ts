#!/usr/bin/env bun

/**
 * justin-sdk CLI
 *
 * Usage:
 *   justin-sdk doctor [--fix] [--quiet]
 *   justin-sdk signal [--quiet] [--serial]
 */

import {runDoctor} from './doctor';
import {runSignal} from './signal';

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.slice(1));

async function main(): Promise<void> {
  switch (command) {
    case 'doctor': {
      const exitCode = await runDoctor(process.cwd(), {
        fix: flags.has('--fix'),
        quiet: flags.has('--quiet'),
      });
      process.exit(exitCode);
    }
    // fallthrough unreachable — process.exit above

    case 'signal': {
      const exitCode = await runSignal(process.cwd(), {
        quiet: flags.has('--quiet'),
        serial: flags.has('--serial'),
      });
      process.exit(exitCode);
    }
    // fallthrough unreachable — process.exit above

    default:
      console.error(
        `Usage: justin-sdk <command>\n\nCommands:\n  doctor  Run environment checks based on justin-sdk.json components\n  signal  Run code quality checks from package.json signal-source:* scripts`,
      );
      process.exit(1);
  }
}

void main();
