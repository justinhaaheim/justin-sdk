#!/usr/bin/env bun
/**
 * measure-quota — time the spend quota's measurement on this machine
 * (home-base-ys9t7.5.2, AC 7b). Read-only: it reads beads, transcripts and
 * the usage files.
 *
 *   bun run measure:quota --bead <session bead id> [--checkout <path>]
 *
 * Prints, for the group of <bead>: its members, the time to resolve the group
 * and to read and price every member transcript, and the result; for the
 * project holding --checkout (default: the current directory): the time and
 * result of its 24-hour spend; and the week reading. `thread quota` shows the
 * same numbers for a session; this script adds the timings.
 */
import {resolveThreadConfig} from '../src/thread/config';
import {transcriptsRoot} from '../src/thread/facts';
import {
  measureGroupSpend,
  realGroupSpendReaders,
  resolveQuotaGroup,
} from '../src/thread/quota-group';
import {quotaLimitsOf} from '../src/thread/quota-knob';
import {measureProjectSpend} from '../src/thread/quota-project';
import {readWeekReading} from '../src/thread/quota-week';

const HELP = `measure-quota — time the spend quota's measurement on this machine

  bun run measure:quota --bead <session bead id> [--checkout <path>]

Read-only over beads, transcripts and the usage files.`;

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const bead = arg('bead');
  if (bead == null) {
    console.error('measure-quota: --bead <session bead id> is required');
    return 2;
  }
  const checkout = arg('checkout') ?? process.cwd();
  const env = process.env;
  const config = resolveThreadConfig({cwd: checkout, env});
  const limits = quotaLimitsOf(config.quota);
  const readers = realGroupSpendReaders({cwd: checkout, env});

  let t = performance.now();
  const group = resolveQuotaGroup(bead, readers.showBead);
  const resolveMs = performance.now() - t;
  console.log(
    `group of ${bead}: ${group.kind}, ${group.members.length} member(s), resolved in ${resolveMs.toFixed(0)} ms`,
  );
  for (const member of group.members)
    console.log(`  ${member.beadId}  ${member.sessionId}`);
  if (group.kind === 'unknown') console.log(`  reason: ${group.reason}`);

  t = performance.now();
  const spend = await measureGroupSpend(bead, readers, {
    dollarsPerWeekPercent: limits.dollarsPerWeekPercent,
  });
  const spendMs = performance.now() - t;
  console.log(`group spend (resolve + read + price): ${spendMs.toFixed(0)} ms`);
  console.log(JSON.stringify(spend, null, 2));

  t = performance.now();
  const project = await measureProjectSpend({
    checkoutPath: checkout,
    dollarsPerWeekPercent: limits.dollarsPerWeekPercent,
    nowMs: Date.now(),
    projectsRoot: transcriptsRoot(env),
  });
  const projectMs = performance.now() - t;
  console.log(`project spend (24 h): ${projectMs.toFixed(0)} ms`);
  console.log(
    JSON.stringify(
      {
        ...project,
        dirs: project.kind === 'known' ? project.dirs.length : undefined,
      },
      null,
      2,
    ),
  );

  const week = readWeekReading({
    env,
    maxAgeMinutes: config.handoff.usage.maxSampleAgeMinutes,
    nowMs: Date.now(),
  });
  console.log('week reading:');
  console.log(JSON.stringify(week, null, 2));

  return 0;
}

process.exit(await main());
