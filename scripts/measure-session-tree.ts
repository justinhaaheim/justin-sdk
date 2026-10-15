#!/usr/bin/env bun
/**
 * What does reading a session's bead TREE cost — from the `issues.jsonl`
 * export, versus through `br`? (home-base-vzwbj.4.3: the conductor asked which
 * one the session model reads, and for its measured cost on home-base's DB.)
 *
 * Treats `--root` (default home-base-vzwbj.4, an epic with child beads) as if
 * it were a session bead, so its children play the requests and their
 * children the requests' children — the shape `thread status` reads.
 *
 *   export  readSessionTree: ONE read of the export, prefiltered line scans.
 *   br      what the same tree costs through br: `br list --all -l sid:…`
 *           (one per DB) + `br show <id> --json` for the root and for every
 *           child (br list --json carries no parent field, so children come
 *           from `br show`'s dependents).
 *
 * READ ONLY. br runs with --no-auto-import (runBr's rule), so nothing is
 * imported, merged or written; the export is only read. Spends no tokens.
 *
 *   bun run measure:session-tree [--runs N] [--beads-dir <dir>] [--root <id>] [--json]
 */

import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {brChildren, brList, findBeadsDb} from '../src/beads/br';
import {readSessionTree} from '../src/thread/session-tree';

const HELP = `measure-session-tree — the session tree read from the beads export vs through br

Usage: bun run measure:session-tree [--runs N] [--beads-dir <dir>] [--root <id>] [--json]

  --runs N           export runs (default 30); the br path runs max(3, N/10) times
  --beads-dir <dir>  the .beads directory to read (default: <repo>/.beads)
  --root <id>        the bead to treat as the session bead (default home-base-vzwbj.4)
  --json             print the numbers as JSON

Read only: br runs with --no-auto-import, the export is only read.`;

interface Args {
  beadsDir: string;
  json: boolean;
  root: string;
  runs: number;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    beadsDir: resolve(import.meta.dirname, '..', '..', '..', '.beads'),
    json: false,
    root: 'home-base-vzwbj.4',
    runs: 30,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--json') args.json = true;
    else if (arg === '--runs' && next != null && /^\d+$/.test(next)) {
      args.runs = Number(next);
      index += 1;
    } else if (arg === '--beads-dir' && next != null) {
      args.beadsDir = resolve(next);
      index += 1;
    } else if (arg === '--root' && next != null) {
      args.root = next;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg ?? ''}`);
    }
  }
  return args;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function main(): number {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args == null) {
    console.log(HELP);
    return 0;
  }
  if (!existsSync(join(args.beadsDir, 'issues.jsonl'))) {
    console.error(`no issues.jsonl in ${args.beadsDir}`);
    return 1;
  }
  const db = findBeadsDb(args.beadsDir);
  if (db.kind !== 'found') {
    console.error(`no beads database in ${args.beadsDir}: ${db.reason}`);
    return 1;
  }
  const sessionId = 'measure-session-tree-no-such-session';

  // ---- export ----
  const exportMs: number[] = [];
  let shape: {children: number; problems: string[]; requests: number} | null =
    null;
  for (let run = 0; run < args.runs; run += 1) {
    const started = performance.now();
    const tree = readSessionTree({
      beadsDirs: [args.beadsDir],
      sessionBeadId: args.root,
      sessionId,
    });
    exportMs.push(performance.now() - started);
    shape = {
      children: tree.requests.reduce(
        (sum, node) => sum + node.children.length + node.questions.length,
        0,
      ),
      problems: tree.problems,
      requests: tree.requests.length,
    };
  }

  // ---- br ----
  const brRuns = Math.max(3, Math.floor(args.runs / 10));
  const brMs: number[] = [];
  let brCalls = 0;
  let brFailure: string | null = null;
  for (let run = 0; run < brRuns && brFailure == null; run += 1) {
    let calls = 0;
    const started = performance.now();
    const listed = brList(
      {db: db.db},
      {all: true, labels: [`sid:${sessionId}`]},
    );
    calls += 1;
    if (listed.kind === 'failed') brFailure = listed.reason;
    const root = brChildren({db: db.db}, args.root);
    calls += 1;
    if (root.kind === 'ok') {
      for (const child of root.children) {
        const grand = brChildren({db: db.db}, child.id);
        calls += 1;
        if (grand.kind === 'failed') brFailure = grand.reason;
      }
    } else {
      brFailure =
        root.kind === 'failed' ? root.reason : `${args.root} not found`;
    }
    brMs.push(performance.now() - started);
    brCalls = calls;
  }

  const result = {
    beadsDir: args.beadsDir,
    br: {
      callsPerTree: brCalls,
      failure: brFailure,
      medianMs: Number(median(brMs).toFixed(1)),
      runs: brMs.length,
    },
    export: {
      medianMs: Number(median(exportMs).toFixed(1)),
      p90Ms: Number(
        (
          [...exportMs].sort((a, b) => a - b)[
            Math.floor(exportMs.length * 0.9)
          ] ?? 0
        ).toFixed(1),
      ),
      runs: exportMs.length,
    },
    root: args.root,
    tree: shape,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(
    [
      `beads dir:        ${result.beadsDir}`,
      `root:             ${result.root}`,
      `tree:             ${shape?.requests ?? 0} requests, ${shape?.children ?? 0} children${shape != null && shape.problems.length > 0 ? `, problems: ${shape.problems.join('; ')}` : ''}`,
      '',
      `export:           ${result.export.medianMs} ms median, ${result.export.p90Ms} ms p90 (${result.export.runs} runs)`,
      `br:               ${result.br.medianMs} ms median for ${result.br.callsPerTree} br calls (${result.br.runs} runs)${brFailure == null ? '' : ` — FAILED: ${brFailure}`}`,
    ].join('\n'),
  );
  return 0;
}

process.exit(main());
