/**
 * drafts-scan-hook — `thread drafts hook`, the UserPromptSubmit and Stop
 * handler that starts the unsent-drafts scan at most once per wall-clock hour,
 * machine-wide (home-base-fmf1n D1 to D4).
 *
 * WHY A HOOK. The scan used to run from the hourly chores agent. cmux's default
 * Socket Control Mode admits only processes it started, or that carry the
 * CMUX_SOCKET_CAPABILITY variable it gives its terminals, so the launchd agent
 * was refused on every tick from 2026-10-19 on. A Claude Code hook in a cmux
 * pane is a process cmux started, and a detached child of it keeps the
 * variable after the hook exits (measured 2026-11-15, the bead's design
 * field). So the scan starts from here.
 *
 * THE HOT PATH (D2). This runs on every prompt and every turn end of every
 * home-base session, and a Stop hook that exits 2 blocks the session from
 * stopping. So it prints nothing, never blocks, and exits 0 on every path,
 * including a throw. In order:
 *   1. componentConfig.thread.draftsScanHook off: exit. The dispatcher does not
 *      read knobs (hook-registry.ts selectHandlers), so this handler does, as
 *      the session guard does.
 *   2. CMUX_SOCKET_CAPABILITY absent or empty (not inside cmux: another
 *      terminal, the desktop app, a remote session): exit without claiming.
 *      Only its PRESENCE is read. Its value is never written anywhere.
 *   3. This wall-clock hour already claimed: exit.
 *   4. Otherwise claim the hour and start `thread drafts scan --trigger hook`
 *      detached, then exit.
 *
 * THE CLAIM (D3). An exclusive create ('wx') of
 * `<threads state dir>/drafts-scan/claims/<YYYY-MM-DDTHH>.claim`: of many
 * hooks firing in one hour, exactly one creates it. Claims older than two
 * days are pruned by the hook that takes a new one, never on the skip path.
 *
 * A SKIP WRITES NOTHING. Knob off, outside cmux, already claimed, or a claim
 * that could not be created: no claim and no run record. So a skip can never
 * read as a clean run; if hooks stop starting scans, the verdict in
 * drafts-scan-health.ts sees activity with no runs and fails. A claim whose
 * scan could not be started records a failed run (D5).
 */

import type {DraftsScanRun} from './drafts-scan-runs';

import {spawn} from 'child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';

import {silencedChildEnv} from '../health-notices';
import {
  appendDraftsScanRun,
  draftsScanClaimsDir,
  hourLabel,
  localTimeZone,
} from './drafts-scan-runs';

type Env = Record<string, string | undefined>;

/** The environment variable cmux gives its terminals; read for presence only. */
export const CMUX_CAPABILITY_ENV_VAR = 'CMUX_SOCKET_CAPABILITY';

/** Claims older than this are pruned (D3). */
export const CLAIM_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** The CLI this module ships in. The scan child runs THIS code (D4). */
const CLI_PATH = fileURLToPath(new URL('../cli.ts', import.meta.url));

/** The argv after `bun` that the scan child runs. */
export const SCAN_CHILD_ARGS: readonly string[] = [
  CLI_PATH,
  'thread',
  'drafts',
  'scan',
  '--trigger',
  'hook',
];

export type ClaimOutcome =
  | {kind: 'alreadyClaimed'; path: string}
  | {kind: 'claimed'; path: string}
  | {kind: 'failed'; path: string; reason: string};

export type ScanSpawn =
  | {error: string; kind: 'failed'}
  | {kind: 'spawned'; pid: number | null};

/** What one hook run decided. Never thrown; `threw` is a decision too. */
export type DraftsHookDecision =
  | {kind: 'alreadyClaimed'; label: string}
  | {kind: 'claimFailed'; label: string; reason: string}
  | {kind: 'knobOff'}
  | {kind: 'notInCmux'}
  | {kind: 'spawned'; label: string; pid: number | null}
  | {error: string; kind: 'spawnFailed'; label: string; recorded: string | null}
  | {error: string; kind: 'threw'};

/** Everything the handler reads or starts; tests replace each. */
export interface DraftsHookDeps {
  claim: (label: string, env: Env, now: Date) => ClaimOutcome;
  /** componentConfig.thread.draftsScanHook at the project root. May throw. */
  knobOn: (projectRoot: string, env: Env) => Promise<boolean> | boolean;
  recordRun: (run: DraftsScanRun, env: Env) => string | null;
  /** Start the scan detached. `onError` hears an asynchronous start failure. */
  spawnScan: (env: Env, onError: (error: string) => void) => ScanSpawn;
}

async function realKnobOn(projectRoot: string, env: Env): Promise<boolean> {
  // `await import`: thread/config reaches sdk-config and zod.
  const {resolveThreadConfig} = await import('./config');
  return resolveThreadConfig({cwd: projectRoot, env}).draftsScanHook;
}

/** Prune claims older than CLAIM_MAX_AGE_MS. Best effort: a failure here costs nothing. */
function pruneClaims(dir: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.claim')) continue;
    const path = join(dir, name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > CLAIM_MAX_AGE_MS) {
        unlinkSync(path);
      }
    } catch {
      // Another hook pruned it first, or it cannot be read: leave it.
    }
  }
}

/** Take this hour's claim with an exclusive create (D3). Never throws. */
export function claimHour(label: string, env: Env, now: Date): ClaimOutcome {
  const dir = draftsScanClaimsDir(env);
  const path = join(dir, `${label}.claim`);
  let fd: number;
  try {
    mkdirSync(dir, {recursive: true});
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'EEXIST') {
      return {kind: 'alreadyClaimed', path};
    }
    return {
      kind: 'failed',
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({at: now.toISOString(), pid: process.pid})}\n`,
    );
  } catch {
    // The file's existence is the claim; its text is only a note.
  } finally {
    closeSync(fd);
  }
  pruneClaims(dir, now);
  return {kind: 'claimed', path};
}

/** Start `thread drafts scan --trigger hook` detached (D4, capture.ts's pattern). */
function realSpawnScan(env: Env, onError: (error: string) => void): ScanSpawn {
  try {
    const child = spawn(process.execPath, [...SCAN_CHILD_ARGS], {
      detached: true,
      env: silencedChildEnv(env) as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      onError(error.message);
    });
    child.unref();
    return {kind: 'spawned', pid: child.pid ?? null};
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      kind: 'failed',
    };
  }
}

const DEFAULT_DEPS: DraftsHookDeps = {
  claim: claimHour,
  knobOn: realKnobOn,
  recordRun: appendDraftsScanRun,
  spawnScan: realSpawnScan,
};

function payloadCwd(stdin: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed == null || typeof parsed !== 'object') return null;
    const cwd = (parsed as {cwd?: unknown}).cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : null;
  } catch {
    return null;
  }
}

function failedStartRun(now: Date, error: string): DraftsScanRun {
  return {
    counts: null,
    endedAt: new Date().toISOString(),
    error: `the hook claimed this hour but could not start the scan: ${error}`,
    exitCode: null,
    outcome: 'failed',
    parentPidAtEnd: null,
    pid: null,
    startedAt: now.toISOString(),
    trigger: 'hook',
  };
}

/** One hook run. Never throws. */
export async function draftsScanHook(input: {
  cwd: string;
  deps?: Partial<DraftsHookDeps>;
  env: Env;
  now?: Date;
  stdin: string;
  timeZone?: string;
}): Promise<DraftsHookDecision> {
  const deps = {...DEFAULT_DEPS, ...input.deps};
  try {
    const projectDir = input.env.CLAUDE_PROJECT_DIR;
    const projectRoot =
      projectDir != null && projectDir !== ''
        ? projectDir
        : (payloadCwd(input.stdin) ?? input.cwd);
    if (!(await deps.knobOn(projectRoot, input.env))) return {kind: 'knobOff'};
    const capability = input.env[CMUX_CAPABILITY_ENV_VAR];
    if (capability == null || capability === '') return {kind: 'notInCmux'};
    const now = input.now ?? new Date();
    const label = hourLabel(now, input.timeZone ?? localTimeZone());
    const claim = deps.claim(label, input.env, now);
    if (claim.kind === 'alreadyClaimed') return {kind: 'alreadyClaimed', label};
    if (claim.kind === 'failed') {
      return {kind: 'claimFailed', label, reason: claim.reason};
    }
    const spawned = deps.spawnScan(input.env, (error) => {
      deps.recordRun(failedStartRun(now, error), input.env);
    });
    if (spawned.kind === 'failed') {
      return {
        error: spawned.error,
        kind: 'spawnFailed',
        label,
        recorded: deps.recordRun(failedStartRun(now, spawned.error), input.env),
      };
    }
    return {kind: 'spawned', label, pid: spawned.pid};
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      kind: 'threw',
    };
  }
}

/** One line for `--explain`. */
export function describeDraftsHookDecision(
  decision: DraftsHookDecision,
): string {
  switch (decision.kind) {
    case 'knobOff':
      return 'skip: componentConfig.thread.draftsScanHook is off here';
    case 'notInCmux':
      return `skip: ${CMUX_CAPABILITY_ENV_VAR} is not set, so this session is not inside cmux`;
    case 'alreadyClaimed':
      return `skip: the hour ${decision.label} is already claimed`;
    case 'claimFailed':
      return `skip: the hour ${decision.label} could not be claimed (${decision.reason})`;
    case 'spawned':
      return `claimed ${decision.label} and started the scan (pid ${decision.pid ?? '?'})`;
    case 'spawnFailed':
      return `claimed ${decision.label} but the scan did not start (${decision.error}); ${decision.recorded ?? 'recorded as a failed run'}`;
    case 'threw':
      return `skip: the hook failed (${decision.error})`;
  }
}

/**
 * The CLI entry. Exit 0 always, and nothing on stdout or stderr: whatever
 * this prints, the dispatcher would show in every session. `--explain` says
 * the decision on stderr, for a run by hand.
 */
export async function runThreadDraftsHook(
  args: {
    /** Tests replace what the handler reads and starts. */
    deps?: Partial<DraftsHookDeps>;
    env?: Env;
    explain?: boolean;
    /** Tests pass the payload; otherwise it is read from stdin. */
    stdin?: string;
  } = {},
): Promise<number> {
  try {
    let stdin = args.stdin ?? '';
    if (args.stdin == null && process.stdin.isTTY !== true) {
      try {
        stdin = readFileSync(0, 'utf8');
      } catch {
        stdin = '';
      }
    }
    const decision = await draftsScanHook({
      cwd: process.cwd(),
      ...(args.deps == null ? {} : {deps: args.deps}),
      env: args.env ?? process.env,
      stdin,
    });
    if (args.explain === true) {
      process.stderr.write(
        `thread drafts hook: ${describeDraftsHookDecision(decision)}\n`,
      );
    }
  } catch {
    // D2: exit 0 on every path, printing nothing.
  }
  return 0;
}
