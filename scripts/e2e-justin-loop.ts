#!/usr/bin/env bun
/**
 * e2e-justin-loop.ts — the justin-loop end-to-end fixture run
 * (home-base-1r6d.33.10).
 *
 * Everything under `tests/` runs the loop against a scripted fake: a fake
 * `claude`, a fake `br`, a fake clock. That proves the runner's own logic and
 * proves nothing about the seams — whether a real background session can even
 * SEE the helper the contract tells it to run, whether `claude stop` really
 * clears the row before the successor is dispatched, whether the JSON survives
 * a round trip through a real `br`. This script exercises exactly those seams,
 * against real `claude --bg` sessions on haiku, in a disposable git+beads repo.
 *
 * IT IS NOT PART OF `bun test`: it spends real quota, needs a logged-in
 * `claude`, and takes minutes. Run it by hand before every justin-loop release:
 *
 *     bun run e2e:justin-loop
 *
 * TWO SCENARIOS.
 *
 *   A. THE CHAIN. Session 1 is told to do nothing but write a `continue`
 *      handoff whose `next` is the successor's instructions; the runner stops
 *      it, confirms it is gone, boots session 2 from that bead; session 2
 *      claims the bead and writes a `done` handoff; the run ends at exit 0.
 *
 *   B. THE DEMAND PATH. Session 1 is told to reply "ok" and stop — i.e. to end
 *      without a handoff. The runner must WAKE that same session, demand a
 *      handoff, get one, and end normally. `--max-sessions=1` bounds the spend.
 *
 * ASSERTIONS COME FROM ARTIFACTS, NOT FROM THE SCRIPT'S MEMORY of what it saw:
 * the fixture's committed `.beads/issues.jsonl`, the ledger `runs.jsonl`, the
 * runner's captured stdout, its exit code, and a post-cleanup `claude agents
 * --all` sweep. Every run records those four things into a directory, and
 * `--replay <dir>` re-runs the assertions over a recording without spawning
 * anything — which is how each assertion gets its negative control (doctor a
 * recorded artifact, replay, watch exactly one check go red).
 *
 * A failed measurement is never a passing check (critical rule 6): an
 * unreadable `issues.jsonl`, an unreadable ledger and an unreadable `claude
 * agents` listing each fail the check that depends on them, by name, rather
 * than degrading into "0 beads", "no rows" or "nothing left over".
 */
import {spawnSync} from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';

import {parseHandoff} from '../src/justin-loop/handoff';
import type {LedgerRow} from '../src/justin-loop/runner';
import {getPinnedToolVersion} from '../src/setup-helpers';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

const DIM = '[2m';
const RESET = '[0m';
const BOLD = '[1m';
const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Scenario = 'a' | 'b';

/** One assertion. `ok: false` is the only thing that fails the run. */
interface Check {
  name: string;
  ok: boolean;
  /** What was actually measured — printed for passes and failures alike. */
  detail: string;
}

/** A bead as `.beads/issues.jsonl` writes it (the committed artifact). */
interface BeadRow {
  id: string;
  title: string;
  status: string;
  /** Absent in the file when the bead's notes were never set. */
  notes: string | null;
  labels: string[];
  createdAt: string | null;
}

/**
 * What the end-of-run `claude agents` sweep did and found.
 *
 * `leftover: null` means the listing could not be read, which is NOT the same
 * fact as "nothing was left over" and must never be spent as one.
 */
interface AgentsSweep {
  ok: boolean;
  reason: string | null;
  stopped: string[];
  removed: string[];
  leftover: string[] | null;
}

/** Everything an assertion is allowed to look at. */
interface Artifacts {
  scenario: Scenario;
  /** The `--label` slug; session labels are `<slug>-1`, `<slug>-2`, … */
  slug: string;
  repo: string;
  /** null when the runner never exited on its own (we killed it). */
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
  /** null = `.beads/issues.jsonl` could not be read or parsed. */
  beads: BeadRow[] | null;
  beadsReason: string | null;
  /** null = `runs.jsonl` could not be read or parsed. */
  ledger: LedgerRow[] | null;
  ledgerReason: string | null;
  sweep: AgentsSweep;
}

/** The half of Artifacts that is not a raw text file (see recordArtifacts). */
type ArtifactsMeta = Omit<
  Artifacts,
  'beads' | 'beadsReason' | 'ledger' | 'ledgerReason' | 'stdout' | 'stderr'
>;

interface Options {
  scenarios: Scenario[];
  /** Wall-clock bound per scenario, ours — the runner's own is left at 0. */
  boundMin: number;
  keep: boolean;
  model: string;
  permissionMode: string;
  recordDir: string;
  replayDir: string | null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const USAGE = `bun run e2e:justin-loop [options]

  --scenario=a|b|all   Which scenario to run (default: all)
  --replay=<dir>       Re-run the assertions over a recorded run and exit.
                       Spawns nothing. Doctor a recorded artifact and replay to
                       negative-control a check.
  --record=<dir>       Where to write this run's artifacts
                       (default: tmp/e2e-justin-loop/<timestamp>)
  --bound-min=<n>      Our own wall-clock bound per scenario (default: 12)
  --model=<m>          Model for the fixture sessions (default: haiku)
  --permission-mode=<m>  (default: bypassPermissions — see the note in the
                       source; \`auto\` is unavailable on haiku)
  --keep               Keep the fixture directory even when everything passes
  --help`;

function parseArgs(argv: string[]): Options {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const opts: Options = {
    boundMin: 12,
    keep: false,
    model: 'haiku',
    permissionMode: 'bypassPermissions',
    recordDir: join(REPO_ROOT, 'tmp', 'e2e-justin-loop', stamp),
    replayDir: null,
    scenarios: ['a', 'b'],
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (flag === '--scenario') {
      if (value === 'all') opts.scenarios = ['a', 'b'];
      else if (value === 'a' || value === 'b') opts.scenarios = [value];
      else
        fatal(`--scenario must be a, b or all (got ${JSON.stringify(value)})`);
    } else if (flag === '--replay') {
      opts.replayDir = value;
    } else if (flag === '--record') {
      opts.recordDir = value;
    } else if (flag === '--bound-min') {
      const n = Number(value);
      if (!(n > 0)) fatal(`--bound-min must be greater than 0 (got ${value})`);
      opts.boundMin = n;
    } else if (flag === '--model') {
      opts.model = value;
    } else if (flag === '--permission-mode') {
      opts.permissionMode = value;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else {
      // An unknown flag is a typo, and a typo that is silently ignored is a run
      // that did not do what it was asked while reporting success.
      fatal(`unknown option ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }
  return opts;
}

function fatal(message: string): never {
  console.error(`${RED}error${RESET} ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The two binaries the fixture has to pin
// ---------------------------------------------------------------------------

/**
 * The real `claude`, not whatever shim happens to be first on PATH.
 *
 * cmux installs a shim directory ahead of `~/.local/bin` that intercepts some
 * subcommands, and a `claude stop` that goes somewhere else is a cleanup that
 * silently does nothing.
 */
function resolveClaude(): string {
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const found = spawnSync('command', ['-v', 'claude'], {
    encoding: 'utf-8',
    shell: true,
  });
  const path = (found.stdout ?? '').trim();
  if (found.status !== 0 || path === '') {
    fatal('no `claude` binary found — this script needs a logged-in claude');
  }
  return path;
}

/**
 * The pinned `br`, by absolute path.
 *
 * The mise SHIM cannot be used: it resolves its version from the cwd's
 * mise.toml, and a temp fixture has none — outside a pinned repo the shim
 * simply refuses. So the fixture gets a `br` wrapper in its own PATH shim
 * directory instead (see writeShims).
 */
function resolveBr(): string {
  const version = getPinnedToolVersion('beads_rust');
  if (version == null) fatal('versions.json has no beads_rust pin');
  const bin = join(
    homedir(),
    '.local/share/mise/installs/github-dicklesworthstone-beads-rust',
    version,
    'br',
  );
  if (!existsSync(bin)) {
    fatal(
      `pinned br ${version} is not installed at ${bin} — run \`mise install\` in a repo that pins it`,
    );
  }
  return bin;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

interface Fixture {
  /** Everything this run created. Removed wholesale on success. */
  root: string;
  /** The git + beads repo the loop runs in. */
  repo: string;
  /** Where the ledger goes — outside the repo, like the real one. */
  stateDir: string;
  /** Prepended to PATH: `justin-sdk`, `br` and `claude` under test. */
  binDir: string;
}

function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): {ok: boolean; stdout: string; stderr: string} {
  const proc = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd,
    encoding: 'utf-8',
    env: env ?? (process.env as Record<string, string>),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    ok: proc.status === 0,
    stderr: proc.stderr ?? '',
    stdout: proc.stdout ?? '',
  };
}

function mustRun(cmd: string[], cwd: string, env?: Record<string, string>) {
  const out = run(cmd, cwd, env);
  if (!out.ok) {
    fatal(
      `fixture setup failed: ${cmd.join(' ')} (in ${cwd})\n${out.stdout}${out.stderr}`,
    );
  }
  return out;
}

/**
 * The PATH shim directory the whole run inherits.
 *
 * This is the point of the fixture: the session contract tells the session to
 * run the literal command `justin-sdk justin-loop handoff …`, so `justin-sdk`
 * has to resolve to THIS CHECKOUT and not to whatever release happens to be
 * installed. MEASURED 2026-09-09 (claude 2.1.266): a `claude --bg` session
 * inherits the PATH of the process that spawned it, shim directory included,
 * so prepending this to the runner's env reaches the sessions it dispatches.
 */
function writeShims(binDir: string, claudeBin: string, brBin: string): void {
  mkdirSync(binDir, {recursive: true});
  const shims: Array<[string, string]> = [
    ['justin-sdk', `exec "${process.execPath}" "${CLI}" "$@"`],
    ['br', `exec "${brBin}" "$@"`],
    ['claude', `exec "${claudeBin}" "$@"`],
  ];
  for (const [name, body] of shims) {
    const path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, {mode: 0o755});
  }
}

function buildFixture(
  scenario: Scenario,
  claudeBin: string,
  brBin: string,
): Fixture {
  // realpath because macOS hands out /var/folders/… symlinks while a process
  // inside reports /private/var/folders/…; the handoff bead's `worktree` is
  // compared against paths the session prints, so pick one form and keep it.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `justin-loop-e2e-${scenario}-`)),
  );
  const fixture: Fixture = {
    binDir: join(root, 'bin'),
    repo: join(root, 'repo'),
    root,
    stateDir: join(root, 'state'),
  };
  mkdirSync(fixture.repo, {recursive: true});
  mkdirSync(fixture.stateDir, {recursive: true});
  writeShims(fixture.binDir, claudeBin, brBin);

  mustRun(['git', 'init', '-q', '--initial-branch=main', '.'], fixture.repo);
  mustRun(['git', 'config', 'user.email', 'e2e@example.invalid'], fixture.repo);
  mustRun(['git', 'config', 'user.name', 'justin-loop e2e'], fixture.repo);
  writeFileSync(
    join(fixture.repo, 'README.md'),
    '# justin-loop e2e fixture\n\nDisposable. Created by scripts/e2e-justin-loop.ts.\n',
  );
  if (scenario === 'a') {
    writeFileSync(
      join(fixture.repo, 'NEXT.txt'),
      successorInstructions(fixture),
    );
  }
  mustRun(['git', 'add', '-A'], fixture.repo);
  mustRun(['git', 'commit', '-qm', 'chore: e2e fixture'], fixture.repo);

  // `br init` needs br on PATH; the shim directory is the whole answer.
  mustRun(
    ['br', 'init', '--prefix', 'e2e', '-q'],
    fixture.repo,
    envFor(fixture),
  );
  return fixture;
}

function envFor(fixture: Fixture): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
  };
}

// ---------------------------------------------------------------------------
// What the fixture sessions are told
//
// Both prompts are written for a model that must do NOTHING but run the helper:
// the point is to exercise the plumbing, not to make haiku do work. The label
// is deliberately NOT hardcoded — each session is told to substitute the label
// its own system prompt gave it, which is the D5 half of the contract under
// test. If a session gets that wrong the runner's demand loop corrects it (the
// demand interpolates the real label), and the ledger's `demands` count is what
// says whether that happened.
// ---------------------------------------------------------------------------

/** The arc every fixture handoff belongs to. Constant: it is not an identity. */
const ARC = 'e2e-fixture';

/** The `next` of scenario A's first handoff — i.e. session 2's whole prompt. */
function successorInstructions(fixture: Fixture): string {
  return `AUTOMATED END-TO-END TEST OF THE JUSTIN-LOOP CHAIN, session 2 of 2. This repository is a disposable fixture and there is no real work to do in it. Do NOT write code, do NOT explore the repository, do NOT commit anything, do NOT create any bead except through the one command in step 2.

Step 1. Claim the handoff bead you were told to pick up: run the exact 'br close <id> --reason=...' command your instructions give you, from the directory they name.

Step 2. Run exactly this ONE command, replacing YOUR-LABEL with the session label your system prompt gave you:

  justin-sdk justin-loop handoff --from=YOUR-LABEL --disposition=done --arc=${ARC} --worktree=${fixture.repo} --branch=main --state='e2e chain complete: session 2 claimed the handoff bead and finished the arc' --next='Nothing remains. This was an automated end-to-end test of the justin-loop plumbing.'

Then end your turn immediately. Do not run any other command.`;
}

/** Scenario A's first prompt. */
function scenarioAPrompt(fixture: Fixture): string {
  return `AUTOMATED END-TO-END TEST OF THE JUSTIN-LOOP CHAIN, session 1 of 2. This repository is a disposable fixture and there is no real work to do in it. Do NOT write code, do NOT explore the repository, do NOT commit anything, do NOT create any bead except through the one command below.

Run exactly this ONE command, from ${fixture.repo}, replacing YOUR-LABEL with the session label your system prompt gave you:

  justin-sdk justin-loop handoff --from=YOUR-LABEL --disposition=continue --arc=${ARC} --worktree=${fixture.repo} --branch=main --state='e2e session 1: no work was done, this is a plumbing fixture' --next="$(cat ${join(fixture.repo, 'NEXT.txt')})"

The --next value is read from that file on purpose, so you never have to quote it yourself. Then end your turn immediately. Do not run any other command.`;
}

/**
 * Scenario B's prompt: a session that ends WITHOUT a handoff, which is the
 * condition the demand loop exists to fix.
 */
const SCENARIO_B_PROMPT =
  'Reply with the single word ok and end your turn. Do nothing else: no commands, no files, no beads.';

// ---------------------------------------------------------------------------
// Running the runner
// ---------------------------------------------------------------------------

interface RunnerResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  wallMs: number;
}

/**
 * Run `justin-sdk justin-loop` as a real child process against the fixture.
 *
 * A child rather than an in-process `runJustinLoop` call on purpose: the exit
 * code, the CLI flag wiring (`--no-usage-gate`, `--state-dir`) and the yargs
 * boolean-negation trap are all part of what a release ships, and none of them
 * are exercised by importing the function.
 *
 * The runner's own `--timeout-min` stays at 0 (its default, D7). The bound here
 * is the SCRIPT's, so a hung fixture cannot run forever, and its firing is
 * recorded as its own fact rather than as a runner exit code.
 */
async function runRunner(
  fixture: Fixture,
  args: string[],
  boundMin: number,
): Promise<RunnerResult> {
  const started = Date.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, 'justin-loop', ...args],
    cwd: fixture.repo,
    env: envFor(fixture),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, boundMin * 60_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode: timedOut ? null : exitCode,
    stderr,
    stdout,
    timedOut,
    wallMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Cleanup: every session this script started, on success AND on failure
// ---------------------------------------------------------------------------

interface AgentRowLite {
  id: string;
  name: string;
  cwd: string;
}

function listAgents(
  claudeBin: string,
): {ok: true; rows: AgentRowLite[]} | {ok: false; reason: string} {
  const proc = spawnSync(claudeBin, ['agents', '--all', '--json'], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (proc.error != null) {
    return {
      ok: false,
      reason: `claude agents could not run: ${proc.error.message}`,
    };
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      reason: `claude agents --all --json exited ${proc.status}`,
    };
  }
  try {
    const raw = JSON.parse(proc.stdout ?? '') as Array<Record<string, unknown>>;
    if (!Array.isArray(raw)) {
      return {
        ok: false,
        reason: 'claude agents --all --json did not return an array',
      };
    }
    return {
      ok: true,
      rows: raw.map((r) => ({
        cwd: typeof r.cwd === 'string' ? r.cwd : '',
        id: typeof r.id === 'string' ? r.id : '',
        name: typeof r.name === 'string' ? r.name : '',
      })),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `claude agents --all --json was unparseable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** A row this run is responsible for: named after our slug, or in our fixture. */
function isOurs(row: AgentRowLite, slug: string, repo: string): boolean {
  return row.name.includes(slug) || row.cwd === repo;
}

/**
 * Stop and remove every session this run started, then LOOK AGAIN.
 *
 * The second look is the point: "we issued the removals" is not the same claim
 * as "nothing is left", and only the second one is worth asserting. An
 * unreadable listing leaves `leftover: null` so the check fails rather than
 * reporting a clean sweep nobody verified.
 */
function sweepAgents(
  claudeBin: string,
  slug: string,
  repo: string,
): AgentsSweep {
  const before = listAgents(claudeBin);
  if (!before.ok) {
    return {
      leftover: null,
      ok: false,
      reason: before.reason,
      removed: [],
      stopped: [],
    };
  }
  const mine = before.rows.filter((r) => isOurs(r, slug, repo));
  const stopped: string[] = [];
  const removed: string[] = [];
  for (const row of mine) {
    const stop = spawnSync(claudeBin, ['stop', row.id], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (stop.status === 0) stopped.push(row.id);
    const rm = spawnSync(claudeBin, ['rm', row.id], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (rm.status === 0) removed.push(row.id);
  }
  const after = listAgents(claudeBin);
  if (!after.ok) {
    return {leftover: null, ok: false, reason: after.reason, removed, stopped};
  }
  return {
    leftover: after.rows
      .filter((r) => isOurs(r, slug, repo))
      .map((r) => `${r.id} ${r.name}`),
    ok: true,
    reason: null,
    removed,
    stopped,
  };
}

// ---------------------------------------------------------------------------
// Artifacts: recorded, and replayable
// ---------------------------------------------------------------------------

function parseBeadsJsonl(text: string): {rows: BeadRow[]} | {reason: string} {
  const rows: BeadRow[] = [];
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  for (const [i, line] of lines.entries()) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      return {
        reason: `issues.jsonl line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (typeof raw.id !== 'string' || typeof raw.status !== 'string') {
      // Reject the whole file rather than drop the row: a dropped row
      // understates how many handoff beads exist, and understating points the
      // reassuring way (critical rule 6).
      return {reason: `issues.jsonl line ${i + 1} has no id/status`};
    }
    rows.push({
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
      id: raw.id,
      labels: Array.isArray(raw.labels)
        ? (raw.labels as unknown[]).filter(
            (l): l is string => typeof l === 'string',
          )
        : [],
      notes: typeof raw.notes === 'string' ? raw.notes : null,
      status: raw.status,
      title: typeof raw.title === 'string' ? raw.title : '',
    });
  }
  return {rows};
}

function parseLedgerJsonl(
  text: string,
): {rows: LedgerRow[]} | {reason: string} {
  const rows: LedgerRow[] = [];
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  for (const [i, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch (err) {
      return {
        reason: `runs.jsonl line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {rows};
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Copy the four artifacts into `dir` and return what they say.
 *
 * Raw text files, deliberately: every artifact stays hand-editable, which is
 * what makes `--replay` usable as a negative-control harness.
 */
function recordArtifacts(
  dir: string,
  meta: ArtifactsMeta,
  fixture: Fixture,
  runner: RunnerResult,
): Artifacts {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'stdout.txt'), runner.stdout);
  writeFileSync(join(dir, 'stderr.txt'), runner.stderr);
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  for (const [from, to] of [
    [join(fixture.repo, '.beads', 'issues.jsonl'), join(dir, 'issues.jsonl')],
    [join(fixture.stateDir, 'runs.jsonl'), join(dir, 'runs.jsonl')],
  ] as Array<[string, string]>) {
    if (existsSync(from)) cpSync(from, to);
  }
  return loadArtifacts(dir);
}

/** Read a recording back. The only input `--replay` has. */
function loadArtifacts(dir: string): Artifacts {
  const metaText = readFileOrNull(join(dir, 'meta.json'));
  if (metaText == null) fatal(`no meta.json in ${dir} — not a recording`);
  const meta = JSON.parse(metaText) as ArtifactsMeta;

  const beadsText = readFileOrNull(join(dir, 'issues.jsonl'));
  const beadsParsed =
    beadsText == null
      ? {reason: 'issues.jsonl is missing'}
      : parseBeadsJsonl(beadsText);
  const ledgerText = readFileOrNull(join(dir, 'runs.jsonl'));
  const ledgerParsed =
    ledgerText == null
      ? {reason: 'runs.jsonl is missing'}
      : parseLedgerJsonl(ledgerText);

  return {
    ...meta,
    beads: 'rows' in beadsParsed ? beadsParsed.rows : null,
    beadsReason: 'reason' in beadsParsed ? beadsParsed.reason : null,
    ledger: 'rows' in ledgerParsed ? ledgerParsed.rows : null,
    ledgerReason: 'reason' in ledgerParsed ? ledgerParsed.reason : null,
    stderr: readFileOrNull(join(dir, 'stderr.txt')) ?? '',
    stdout: readFileOrNull(join(dir, 'stdout.txt')) ?? '',
  };
}

// ---------------------------------------------------------------------------
// The assertions — pure functions of the artifacts
// ---------------------------------------------------------------------------

function check(name: string, ok: boolean, detail: string): Check {
  return {detail, name, ok};
}

/** Handoff-labelled beads, oldest first. */
function handoffBeads(a: Artifacts): BeadRow[] {
  return (a.beads ?? [])
    .filter((b) => b.labels.includes('handoff'))
    .sort((x, y) => ((x.createdAt ?? '') < (y.createdAt ?? '') ? -1 : 1));
}

/** Lines the runner prints once per NEW session dispatched (never per demand). */
function dispatchLines(stdout: string): number[] {
  const idx: number[] = [];
  stdout.split('\n').forEach((line, i) => {
    if (/^\s*background \S+ · inspect:/.test(line)) idx.push(i);
  });
  return idx;
}

/** The line stopAndVerify prints when — and only when — the row is confirmed gone. */
function stopConfirmedLine(stdout: string): number {
  return stdout
    .split('\n')
    .findIndex(
      (line) =>
        line.includes('verified gone:') ||
        line.includes('was already absent from'),
    );
}

function exitCheck(a: Artifacts): Check[] {
  return [
    check(
      'the e2e wall-clock bound did not fire',
      !a.timedOut,
      a.timedOut
        ? `the runner was SIGKILLed after ${Math.round(a.wallMs / 1000)}s`
        : `runner finished in ${Math.round(a.wallMs / 1000)}s`,
    ),
    check(
      'the runner exited 0',
      a.exitCode === 0,
      `exit code ${a.exitCode ?? 'none (killed)'}`,
    ),
  ];
}

function sweepCheck(a: Artifacts): Check {
  return check(
    'no fixture session rows remain in `claude agents --all` after cleanup',
    a.sweep.leftover != null && a.sweep.leftover.length === 0,
    a.sweep.leftover == null
      ? `the listing could NOT be read (${a.sweep.reason ?? 'unrecorded reason'}), so "nothing left over" was never established`
      : a.sweep.leftover.length === 0
        ? `stopped ${a.sweep.stopped.length}, removed ${a.sweep.removed.length}, 0 rows match slug \`${a.slug}\` or cwd ${a.repo}`
        : `still listed: ${a.sweep.leftover.join(', ')}`,
  );
}

function checkScenarioA(a: Artifacts): Check[] {
  const checks: Check[] = [...exitCheck(a)];
  const beads = handoffBeads(a);

  checks.push(
    check(
      '`.beads/issues.jsonl` is readable and holds exactly 2 handoff beads',
      a.beads != null && beads.length === 2,
      a.beads == null
        ? `issues.jsonl could NOT be read: ${a.beadsReason ?? 'unrecorded reason'}`
        : `${beads.length} handoff-labelled bead(s): ${beads.map((b) => b.id).join(', ') || '(none)'}`,
    ),
  );

  const parsed = beads.map((b) => parseHandoff(b.notes));
  checks.push(
    check(
      'both handoff beads carry notes that parseHandoff accepts',
      parsed.length === 2 && parsed.every((p) => p.ok),
      parsed.length !== 2
        ? `only ${parsed.length} bead(s) to parse`
        : parsed
            .map((p, i) =>
              p.ok
                ? `${beads[i]?.id} ok`
                : `${beads[i]?.id} INVALID: ${p.errors.join('; ')}`,
            )
            .join(' · '),
    ),
  );

  const froms = parsed.map((p) => (p.ok ? p.handoff.from : '(unparseable)'));
  const wantFroms = [`${a.slug}-1`, `${a.slug}-2`];
  checks.push(
    check(
      'the handoffs are from <slug>-1 then <slug>-2, in creation order',
      froms.length === 2 &&
        froms[0] === wantFroms[0] &&
        froms[1] === wantFroms[1],
      `from = [${froms.join(', ')}], expected [${wantFroms.join(', ')}]`,
    ),
  );

  const dispositions = parsed.map((p) =>
    p.ok ? p.handoff.disposition : '(unparseable)',
  );
  checks.push(
    check(
      'the dispositions are continue then done',
      dispositions.length === 2 &&
        dispositions[0] === 'continue' &&
        dispositions[1] === 'done',
      `disposition = [${dispositions.join(', ')}]`,
    ),
  );

  checks.push(
    check(
      'the successor CLAIMED the first handoff bead (it is closed)',
      beads[0]?.status === 'closed',
      `${beads[0]?.id ?? '(no bead)'} status=${beads[0]?.status ?? 'n/a'}`,
    ),
  );
  checks.push(
    check(
      'the `done` handoff bead is still OPEN (nobody closes it — FINDING-1)',
      beads[1]?.status === 'open',
      `${beads[1]?.id ?? '(no bead)'} status=${beads[1]?.status ?? 'n/a'}`,
    ),
  );

  const ledger = a.ledger;
  checks.push(
    check(
      'the ledger is readable and holds exactly 2 rows',
      ledger != null && ledger.length === 2,
      ledger == null
        ? `runs.jsonl could NOT be read: ${a.ledgerReason ?? 'unrecorded reason'}`
        : `${ledger.length} row(s), labels [${ledger.map((r) => r.label).join(', ')}]`,
    ),
  );
  const outcomes = (ledger ?? []).map((r) => r.outcome);
  checks.push(
    check(
      'the ledger outcomes are continue then done',
      outcomes.length === 2 &&
        outcomes[0] === 'continue' &&
        outcomes[1] === 'done',
      `outcome = [${outcomes.join(', ')}]  demands = [${(ledger ?? []).map((r) => r.demands).join(', ')}]`,
    ),
  );
  checks.push(
    check(
      'each ledger row names the handoff bead that session wrote',
      ledger != null &&
        ledger.length === 2 &&
        ledger[0]?.handoffBead === beads[0]?.id &&
        ledger[1]?.handoffBead === beads[1]?.id,
      `ledger handoffBead = [${(ledger ?? []).map((r) => r.handoffBead ?? 'null').join(', ')}], beads = [${beads.map((b) => b.id).join(', ')}]`,
    ),
  );
  checks.push(
    check(
      'session 1 was CONFIRMED gone before the run moved on',
      ledger?.[0]?.stopOutcome === 'stopped' ||
        ledger?.[0]?.stopOutcome === 'already-gone',
      `stopOutcome = ${ledger?.[0]?.stopOutcome ?? 'null'}`,
    ),
  );

  // THE ONE THAT MATTERS MOST (D6): a successor may only be dispatched off a
  // predecessor whose row is provably gone. Read off the transcript, in order.
  const confirmed = stopConfirmedLine(a.stdout);
  const dispatches = dispatchLines(a.stdout);
  checks.push(
    check(
      'the stop was confirmed BEFORE the second session was dispatched',
      confirmed >= 0 &&
        dispatches.length >= 2 &&
        confirmed < (dispatches[1] as number),
      confirmed < 0
        ? 'no stop-confirmation line in the runner transcript at all'
        : dispatches.length < 2
          ? `only ${dispatches.length} session dispatch line(s) in the transcript`
          : `confirmation at line ${confirmed + 1}, second dispatch at line ${(dispatches[1] as number) + 1}`,
    ),
  );

  checks.push(sweepCheck(a));
  return checks;
}

function checkScenarioB(a: Artifacts): Check[] {
  const checks: Check[] = [...exitCheck(a)];
  const beads = handoffBeads(a);
  const ledger = a.ledger;

  const demandLines = a.stdout
    .split('\n')
    .filter((l) => /demand \d+\/\d+.*waking /.test(l));
  checks.push(
    check(
      'the runner WOKE the session and demanded a handoff',
      demandLines.length >= 1,
      demandLines.length === 0
        ? 'no `demand N/M waking …` line in the transcript'
        : `${demandLines.length} demand(s) sent`,
    ),
  );

  const dispatches = dispatchLines(a.stdout);
  checks.push(
    check(
      'no successor was spawned on the demand path (one dispatch only)',
      dispatches.length === 1,
      `${dispatches.length} session dispatch line(s)`,
    ),
  );

  checks.push(
    check(
      '`.beads/issues.jsonl` is readable and holds exactly 1 handoff bead',
      a.beads != null && beads.length === 1,
      a.beads == null
        ? `issues.jsonl could NOT be read: ${a.beadsReason ?? 'unrecorded reason'}`
        : `${beads.length} handoff-labelled bead(s): ${beads.map((b) => b.id).join(', ') || '(none)'}`,
    ),
  );

  const parsed =
    beads.length === 1 ? parseHandoff(beads[0]?.notes ?? null) : null;
  checks.push(
    check(
      'the demanded handoff parses and is stamped with this session’s label',
      parsed != null && parsed.ok && parsed.handoff.from === `${a.slug}-1`,
      parsed == null
        ? 'no single handoff bead to parse'
        : parsed.ok
          ? `from=${parsed.handoff.from} disposition=${parsed.handoff.disposition}`
          : `INVALID: ${parsed.errors.join('; ')}`,
    ),
  );

  checks.push(
    check(
      'the ledger is readable, holds 1 row, and records demands >= 1',
      ledger != null && ledger.length === 1 && (ledger[0]?.demands ?? 0) >= 1,
      ledger == null
        ? `runs.jsonl could NOT be read: ${a.ledgerReason ?? 'unrecorded reason'}`
        : `${ledger.length} row(s), demands = ${ledger[0]?.demands ?? 'absent'}`,
    ),
  );
  checks.push(
    check(
      'the ledger outcome is continue or done',
      ledger?.[0]?.outcome === 'continue' || ledger?.[0]?.outcome === 'done',
      `outcome = ${ledger?.[0]?.outcome ?? 'none'}`,
    ),
  );
  checks.push(
    check(
      'the session was CONFIRMED gone after its demanded turn',
      ledger?.[0]?.stopOutcome === 'stopped' ||
        ledger?.[0]?.stopOutcome === 'already-gone',
      `stopOutcome = ${ledger?.[0]?.stopOutcome ?? 'null'}`,
    ),
  );

  checks.push(sweepCheck(a));
  return checks;
}

function checksFor(a: Artifacts): Check[] {
  return a.scenario === 'a' ? checkScenarioA(a) : checkScenarioB(a);
}

function report(a: Artifacts, checks: Check[]): boolean {
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${BOLD}── scenario ${a.scenario.toUpperCase()} ──${RESET} ${DIM}slug=${a.slug} repo=${a.repo}${RESET}`,
  );
  for (const c of checks) {
    const mark = c.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${c.name}\n        ${DIM}${c.detail}${RESET}`);
  }
  console.log(
    `  ${failed.length === 0 ? GREEN : RED}${checks.length - failed.length}/${checks.length} checks passed${RESET}`,
  );
  return failed.length === 0;
}

// ---------------------------------------------------------------------------
// One scenario, end to end
// ---------------------------------------------------------------------------

function slugFor(scenario: Scenario): string {
  // Unique per run so the `claude agents` sweep can never match somebody
  // else's session, and so a leftover row from a previous run cannot make this
  // run's cleanup check pass or fail for the wrong reason.
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e${scenario}${rand}`;
}

async function runScenario(
  scenario: Scenario,
  opts: Options,
  claudeBin: string,
  brBin: string,
): Promise<{artifacts: Artifacts; ok: boolean}> {
  const fixture = buildFixture(scenario, claudeBin, brBin);
  const slug = slugFor(scenario);
  const recordDir = join(opts.recordDir, scenario);

  const shared = [
    `--label=${slug}`,
    `--model=${opts.model}`,
    `--permission-mode=${opts.permissionMode}`,
    `--state-dir=${fixture.stateDir}`,
    '--no-usage-gate',
    '--poll-sec=5',
    '--stop-poll-sec=3',
  ];
  const args =
    scenario === 'a'
      ? [
          `--prompt=${scenarioAPrompt(fixture)}`,
          '--max-sessions=3',
          '--handoff-retries=3',
          ...shared,
        ]
      : [
          `--prompt=${SCENARIO_B_PROMPT}`,
          // Bounded at one session: the demanded handoff may legitimately say
          // `continue`, and this is a plumbing test, not a chain test.
          '--max-sessions=1',
          '--handoff-retries=3',
          ...shared,
        ];

  console.log(
    `\n${BOLD}scenario ${scenario.toUpperCase()}${RESET} ${DIM}slug=${slug} model=${opts.model} perms=${opts.permissionMode}\n  fixture ${fixture.repo}\n  bound   ${opts.boundMin}m${RESET}`,
  );

  // A throw here must NOT skip the cleanup, and must not be reported as a run
  // that simply exited non-zero either: `exitCode: null` is how "we never got
  // an exit code" is spelled, and it fails the exit check by name.
  let runner: RunnerResult;
  try {
    runner = await runRunner(fixture, args, opts.boundMin);
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      `${RED}error${RESET} the runner could not be run: ${message}`,
    );
    runner = {
      exitCode: null,
      stderr: message,
      stdout: '',
      timedOut: false,
      wallMs: 0,
    };
  }

  // Cleanup BEFORE the assertions, so its result is part of the recording and
  // so a failing assertion can never leave a live session behind.
  const sweep = sweepAgents(claudeBin, slug, fixture.repo);

  const artifacts = recordArtifacts(
    recordDir,
    {
      exitCode: runner.exitCode,
      repo: fixture.repo,
      scenario,
      slug,
      sweep,
      timedOut: runner.timedOut,
      wallMs: runner.wallMs,
    },
    fixture,
    runner,
  );

  const ok = report(artifacts, checksFor(artifacts));
  console.log(`  ${DIM}artifacts ${recordDir}${RESET}`);

  if (ok && !opts.keep) {
    rmSync(fixture.root, {force: true, recursive: true});
  } else {
    console.log(
      `  ${YELLOW}fixture kept${RESET} ${DIM}${fixture.root}${RESET}`,
    );
  }
  return {artifacts, ok};
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.replayDir != null) {
    // Assertions only, over a recording. This is the negative-control harness:
    // doctor one artifact, replay, and exactly one check must go red.
    const artifacts = loadArtifacts(opts.replayDir);
    console.log(
      `${BOLD}replay${RESET} ${DIM}${opts.replayDir} (no sessions spawned)${RESET}`,
    );
    return report(artifacts, checksFor(artifacts)) ? 0 : 1;
  }

  const claudeBin = resolveClaude();
  const brBin = resolveBr();
  console.log(
    `${BOLD}justin-loop e2e${RESET}\n${DIM}  claude ${claudeBin}\n  br     ${brBin}\n  cli    ${CLI}\n  record ${opts.recordDir}${RESET}`,
  );

  let allOk = true;
  for (const scenario of opts.scenarios) {
    const result = await runScenario(scenario, opts, claudeBin, brBin);
    allOk = allOk && result.ok;
  }
  console.log(
    allOk
      ? `\n${GREEN}${BOLD}ALL SCENARIOS PASSED${RESET}\n`
      : `\n${RED}${BOLD}FAILURES — see above${RESET} ${DIM}(replay with --replay=${opts.recordDir}/<scenario>)${RESET}\n`,
  );
  return allOk ? 0 : 1;
}

process.exit(await main());
