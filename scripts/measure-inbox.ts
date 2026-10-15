#!/usr/bin/env bun
/**
 * What does `thread inbox` cost on this machine? (home-base-vzwbj.4.4: the
 * bead asks for the wall time on the real index, and for a note when it runs
 * past about 3 s — Justin starts dozens of sessions a day.)
 *
 * Two measurements:
 *   real   readInbox over this machine's own sessions index, as it is.
 *   scaled the real sessions cloned to --sessions N (default 40) under fake
 *          session ids in a TEMP state dir: each clone gets a copy of its
 *          source's message log, an index line pointing at the same beads DB,
 *          and SYMLINKS to the source's transcript and subagent directory in
 *          a temp transcripts root — so every clone costs what the real
 *          session costs (export read, git, the transcript commit scan).
 *
 * READ ONLY for everything real: it reads the index, message logs,
 * transcripts, beads exports and git, and writes only inside its own temp
 * directory, which it removes. Spends no tokens.
 *
 *   bun run measure:inbox [--sessions N] [--runs N] [--json]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';

import {messageLogPath, sessionIndexPath} from '../src/thread/archive';
import {findTranscript} from '../src/thread/facts';
import {readInbox} from '../src/thread/session-inbox';
import {readSessionIndex, serializeSighting} from '../src/thread/session-index';

const HELP = `measure-inbox — the wall time of thread inbox, on the real index and scaled up

  bun run measure:inbox [--sessions N] [--runs N] [--json]

  --sessions N   clones for the scaled run (default 40)
  --runs N       runs of each measurement; the median is reported (default 3)
  --json         print the numbers as JSON

Reads only; writes only inside a temp directory it removes.`;

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? null : process.argv[index + 1];
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function timeInbox(
  env: Record<string, string | undefined>,
  runs: number,
): Promise<{ms: number[]; sessions: number}> {
  const ms: number[] = [];
  let sessions = 0;
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    const result = await readInbox({
      cwd: process.cwd(),
      days: 30,
      env,
      now: new Date(),
      repo: null,
    });
    ms.push(performance.now() - start);
    if (result.kind === 'failed') throw new Error(result.reason);
    sessions = result.read.rows.length;
  }
  return {ms, sessions};
}

async function main(): Promise<number> {
  if (process.argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const clones = flag('--sessions', 40);
  const runs = flag('--runs', 3);
  const real = await timeInbox(process.env, runs);

  const index = readSessionIndex(process.env);
  if (index.kind !== 'read' || index.sessions.length === 0) {
    console.log(
      `real: ${real.sessions} sessions, median ${median(real.ms).toFixed(0)} ms; no sessions to clone for the scaled run (${sessionIndexPath(process.env)}: ${index.kind})`,
    );
    return 0;
  }

  const temp = mkdtempSync(join(tmpdir(), 'measure-inbox-'));
  try {
    const env = {
      ...process.env,
      JUSTIN_THREADS_STATE_DIR: join(temp, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(temp, 'projects'),
    };
    const lines: string[] = [];
    for (let i = 0; i < clones; i += 1) {
      const source = index.sessions[i % index.sessions.length];
      if (source == null) continue;
      const fake = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      for (const sighting of source.sightings) {
        lines.push(serializeSighting({...sighting, sessionId: fake}));
      }
      const log = messageLogPath(source.sessionId, process.env);
      if (existsSync(log)) {
        const target = messageLogPath(fake, env);
        mkdirSync(dirname(target), {recursive: true});
        copyFileSync(log, target);
      }
      const transcript = findTranscript(source.sessionId, process.env);
      if (transcript.status === 'found') {
        const dir = join(temp, 'projects', basename(dirname(transcript.path)));
        mkdirSync(dir, {recursive: true});
        symlinkSync(transcript.path, join(dir, `${fake}.jsonl`));
        const subagents = join(
          dirname(transcript.path),
          basename(transcript.path, '.jsonl'),
        );
        if (existsSync(subagents)) symlinkSync(subagents, join(dir, fake));
      }
    }
    const indexPath = sessionIndexPath(env);
    mkdirSync(dirname(indexPath), {recursive: true});
    writeFileSync(indexPath, lines.join(''));
    const scaled = await timeInbox(env, runs);
    const numbers = {
      real: {medianMs: Math.round(median(real.ms)), sessions: real.sessions},
      scaled: {
        medianMs: Math.round(median(scaled.ms)),
        perSessionMs: Math.round(
          median(scaled.ms) / Math.max(1, scaled.sessions),
        ),
        sessions: scaled.sessions,
      },
    };
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(numbers, null, 2));
    } else {
      console.log(
        `real:   ${numbers.real.sessions} session(s), median ${numbers.real.medianMs} ms over ${runs} runs`,
      );
      console.log(
        `scaled: ${numbers.scaled.sessions} sessions (clones of the real ones), median ${numbers.scaled.medianMs} ms, ${numbers.scaled.perSessionMs} ms per session`,
      );
    }
  } finally {
    rmSync(temp, {force: true, recursive: true});
  }
  return 0;
}

process.exit(await main());
