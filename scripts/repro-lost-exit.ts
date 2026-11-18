#!/usr/bin/env bun
/**
 * Does a plain bun process ever lose a child's exit? (home-base-iprgd)
 *
 * home-base-5frxo saw `execFile('true')` never call back inside `bun test` on
 * Bun 1.4.2, at load averages of 150 to 270: 2 in 7000 alone, 18 in 7000 right
 * after a spawnSync. Bun issue #45483 (open, macOS, Bun 1.3.14 to 1.4.4)
 * measured the same thing inside `bun test`: the child's 'exit' and 'close'
 * are emitted while spawn() is still on the stack, before any listener is
 * attached. Its two reporters saw none in a plain bun process.
 *
 * This script is the plain-bun half of that question, with no test runner: it
 * runs one call at a time, in a loop, for at most --minutes, and a watchdog
 * per call counts a callback that never came. For each call it records
 * whether the child was already reported exited when execFile() returned
 * (the #45483 signature), and for each lost call the load average.
 *
 * IT ADDS NO LOAD BEYOND ITSELF: one child at a time, about one core. Running
 * it under heavy load is a separate step that needs Justin's yes (the bead's
 * notes); this script never starts a CPU burner.
 *
 *   bun run repro:lost-exit [--minutes N] [--mode M] [--watchdog-ms N] [--max-lost N] [--json]
 */
import {execFile, spawnSync} from 'node:child_process';
import {cpus, loadavg} from 'node:os';

const HELP = `repro-lost-exit — does a plain bun process ever lose a child's exit? (home-base-iprgd)

  bun run repro:lost-exit [--minutes N] [--mode M] [--watchdog-ms N] [--max-lost N] [--json]

  --minutes N       stop starting calls after N minutes (default 2, at most 30)
  --mode M          execfile: execFile('true') alone
                    spawnsync-then-execfile: spawnSync('true'), then execFile('true') at once
                    both: the two, alternating (default)
  --watchdog-ms N   a call with no callback after N ms counts as lost (default 10000)
  --max-lost N      stop after N lost calls (default 20)
  --json            print the summary as one JSON object

One call at a time, so it adds about one core of load and no more. It starts
no CPU burner: run it under load only with Justin's yes.

Exit 0 = no call lost · 1 = at least one lost · 2 = bad arguments.`;

type Mode = 'execfile' | 'spawnsync-then-execfile';

interface LostCall {
  /** The exit already reported when execFile() returned, or null. */
  exitedAtReturn: string | null;
  iteration: number;
  loadAverage1m: number;
  mode: Mode;
}

interface Options {
  json: boolean;
  maxLost: number;
  minutes: number;
  modes: Mode[];
  watchdogMs: number;
}

function numberFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
): number | null {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(argv[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseOptions(
  argv: readonly string[],
): {ok: false; reason: string} | {ok: true; options: Options} {
  const minutes = numberFlag(argv, '--minutes', 2);
  const watchdogMs = numberFlag(argv, '--watchdog-ms', 10_000);
  const maxLost = numberFlag(argv, '--max-lost', 20);
  if (minutes == null || minutes > 30) {
    return {ok: false, reason: '--minutes takes a number above 0, at most 30'};
  }
  if (watchdogMs == null) {
    return {ok: false, reason: '--watchdog-ms takes a number above 0'};
  }
  if (maxLost == null) {
    return {ok: false, reason: '--max-lost takes a number above 0'};
  }
  const modeAt = argv.indexOf('--mode');
  const mode = modeAt === -1 ? 'both' : (argv[modeAt + 1] ?? '');
  const modes: Mode[] | null =
    mode === 'both'
      ? ['execfile', 'spawnsync-then-execfile']
      : mode === 'execfile' || mode === 'spawnsync-then-execfile'
        ? [mode]
        : null;
  if (modes == null) {
    return {
      ok: false,
      reason: `--mode takes execfile, spawnsync-then-execfile or both, not ${JSON.stringify(mode)}`,
    };
  }
  return {
    ok: true,
    options: {
      json: argv.includes('--json'),
      maxLost,
      minutes,
      modes,
      watchdogMs,
    },
  };
}

/**
 * One call, and the #45483 diagnostic: whether the child was already reported
 * exited when execFile() returned (exitCode or signalCode set). Node never
 * reports an exit there; in #45483 every lost callback had it, with 'exit'
 * and 'close' emitted before any listener was attached.
 */
async function oneCall(
  mode: Mode,
  watchdogMs: number,
): Promise<{exitedAtReturn: string | null; ok: boolean}> {
  if (mode === 'spawnsync-then-execfile') {
    spawnSync('true', [], {stdio: 'ignore'});
  }
  let exitedAtReturn: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callback = new Promise<'answered'>((resolve) => {
    const child = execFile('true', [], () => resolve('answered'));
    if (child.exitCode != null || child.signalCode != null) {
      exitedAtReturn = `exitCode ${String(child.exitCode)}, signalCode ${String(child.signalCode)}`;
    }
  });
  const watchdog = new Promise<'lost'>((resolve) => {
    timer = setTimeout(() => resolve('lost'), watchdogMs);
  });
  const outcome = await Promise.race([callback, watchdog]);
  clearTimeout(timer);
  return {exitedAtReturn, ok: outcome === 'answered'};
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseOptions(argv);
  if (!parsed.ok) {
    console.error(`repro-lost-exit: ${parsed.reason}`);
    return 2;
  }
  const {json, maxLost, minutes, modes, watchdogMs} = parsed.options;
  const startedAt = new Date();
  const loadAtStart = loadavg();
  const stopAt = Date.now() + minutes * 60_000;
  const runs: Record<Mode, number> = {
    execfile: 0,
    'spawnsync-then-execfile': 0,
  };
  const lost: LostCall[] = [];
  let exitedAtReturn = 0;
  let iteration = 0;
  let nextProgress = Date.now() + 30_000;
  if (!json) {
    console.log(
      `repro-lost-exit: Bun ${Bun.version}, ${process.platform} ${process.arch}, ${cpus().length} cores; load ${loadAtStart.map((n) => n.toFixed(1)).join(' ')}; ${minutes} min, modes ${modes.join(' + ')}, watchdog ${watchdogMs} ms`,
    );
  }
  while (Date.now() < stopAt && lost.length < maxLost) {
    const mode = modes[iteration % modes.length] ?? 'execfile';
    iteration += 1;
    runs[mode] += 1;
    const call = await oneCall(mode, watchdogMs);
    if (call.exitedAtReturn != null) exitedAtReturn += 1;
    if (!call.ok) {
      const entry: LostCall = {
        exitedAtReturn: call.exitedAtReturn,
        iteration,
        loadAverage1m: loadavg()[0] ?? Number.NaN,
        mode,
      };
      lost.push(entry);
      if (!json) console.log(`LOST ${JSON.stringify(entry)}`);
    }
    if (!json && Date.now() >= nextProgress) {
      nextProgress = Date.now() + 30_000;
      console.log(
        `  ${iteration} calls, ${lost.length} lost, load ${(loadavg()[0] ?? Number.NaN).toFixed(1)}`,
      );
    }
  }
  const summary = {
    bun: Bun.version,
    cores: cpus().length,
    endedAt: new Date().toISOString(),
    /** Calls whose child was already reported exited when execFile() returned. */
    exitedAtReturn,
    loadAtEnd: loadavg(),
    loadAtStart,
    lost,
    lostCount: lost.length,
    minutes,
    platform: `${process.platform} ${process.arch}`,
    runs,
    startedAt: startedAt.toISOString(),
    stoppedEarly: lost.length >= maxLost,
    watchdogMs,
  };
  console.log(
    json
      ? JSON.stringify(summary, null, 2)
      : `\nsummary: ${JSON.stringify(summary)}`,
  );
  return lost.length === 0 ? 0 : 1;
}

process.exit(await main());
