/**
 * The machine-wide registry of chain names (home-base-l2ejg.11, D5 in
 * home-base-l2ejg.3). Every chain of handed-off sessions gets a name from the
 * pool (chain-name-pool.ts) that no other chain has ever had.
 *
 * THE FILE: `<threads state dir>/chain-names.jsonl`, one line per chain root,
 * `{"root": "<first session bead id>", "name": "Moe II", "assignedAt": "<ISO>"}`.
 * Lines are only ever appended. A root's name is the first line naming it.
 *
 * THE PICK: at random among the pool names no line holds; when every one is
 * held, among their generation-II spellings (`Moe II`), then III, and so on.
 * Generation II is the expected steady state, not an error: about 130 chains
 * were unfinished on 2026-11-14, and home-base alone starts about 18 a week.
 *
 * THE LOCK: held only around read, pick and append, never across a br call. It
 * is the O_EXCL + pid pattern of the question counter (question-counter.ts): a
 * holder that measurably died is stolen from, and so is a lock older than
 * STALE_LOCK_MS. It waits at most about a second: the capture child calls
 * this, and naming can wait for the next prompt.
 *
 * FAILURE IS NOT EMPTY (critical rule 7): a file that cannot be read, a line
 * that does not parse, a lock that cannot be taken or an append that fails
 * hands out no name, and the reason comes back in words. A line that does not
 * parse could hold a name, so it is never skipped. Nothing here throws.
 */

import type {ChainName} from './chain-name';
import type {EnvLike} from './paths';

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {dirname, join} from 'path';

import {chainNameText, parseChainName, sameChainName} from './chain-name';
import {CHAIN_NAME_POOL} from './chain-name-pool';
import {pidAlive} from './commit';
import {resolveThreadConfig} from './config';
import {probeErrorMessage, threadsStateDir} from './paths';

/** `<threads state dir>/chain-names.jsonl`. */
export function chainNamesPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'chain-names.jsonl');
}

function lockPath(env: EnvLike): string {
  return join(threadsStateDir(env), 'chain-names.lock');
}

function errorCode(error: unknown): null | string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : null;
}

// ---- the file ----------------------------------------------------------------

export interface ChainNameEntry {
  assignedAt: string;
  name: ChainName;
  root: string;
}

export type ChainNamesRead =
  | {entries: ChainNameEntry[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

/**
 * Every line of the registry. A missing file holds none (no chain was named
 * yet); any other failure, or any line that does not parse, fails the read.
 * `pool` is the set of names a line may hold (tests pass a small one).
 */
export function readChainNames(
  env: EnvLike,
  pool: readonly string[] = CHAIN_NAME_POOL,
): ChainNamesRead {
  const path = chainNamesPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {entries: [], kind: 'read'};
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${probeErrorMessage(error)}`,
    };
  }
  const known = new Set(pool);
  const entries: ChainNameEntry[] = [];
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const bad = (why: string): ChainNamesRead => ({
      kind: 'failed',
      reason: `${path} line ${index + 1} ${why}, and it could hold a name, so none is handed out`,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return bad('is not JSON');
    }
    if (parsed == null || typeof parsed !== 'object')
      return bad('is not an object');
    const {assignedAt, name, root} = parsed as Record<string, unknown>;
    if (typeof root !== 'string' || root === '') return bad('has no root');
    if (typeof name !== 'string') return bad('has no name');
    const chainName = parseChainName(name, known);
    if (chainName == null)
      return bad(`holds "${name}", which is not a chain name`);
    entries.push({
      assignedAt: typeof assignedAt === 'string' ? assignedAt : '',
      name: chainName,
      root,
    });
  }
  return {entries, kind: 'read'};
}

/** The name the registry gives `root`: its first line, or null. */
export function chainNameInRegistry(
  entries: readonly ChainNameEntry[],
  root: string,
): ChainName | null {
  return entries.find((entry) => entry.root === root)?.name ?? null;
}

/**
 * A name no entry holds: random among the free pool names of the lowest
 * generation that has one. Never null: some generation always has a free name.
 */
export function pickChainName(
  entries: readonly ChainNameEntry[],
  pool: readonly string[],
  random: () => number,
): ChainName {
  const held = entries.map((entry) => entry.name);
  for (let generation = 1; ; generation += 1) {
    const free = pool.filter(
      (base) => !held.some((name) => sameChainName(name, {base, generation})),
    );
    if (free.length > 0) {
      const index = Math.min(
        free.length - 1,
        Math.floor(random() * free.length),
      );
      return {base: free[index] ?? free[0] ?? pool[0] ?? 'Homer', generation};
    }
  }
}

// ---- the lock ----------------------------------------------------------------

const LOCK_ATTEMPTS = 40;
const LOCK_SLEEP_MS = 25;
/** A lock older than this is stale whoever holds it (pid reuse, a hung run). */
const STALE_LOCK_MS = 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return false;
  }
  if (/^[0-9]+$/.test(raw)) {
    const owner = Number(raw);
    if (owner !== process.pid && pidAlive(owner) === false) return true;
  }
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

/** Take the registry's lock, waiting up to about a second. */
function takeLock(
  env: EnvLike,
): {kind: 'failed'; reason: string} | {kind: 'held'} {
  const path = lockPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${dirname(path)} could not be created: ${probeErrorMessage(error)}`,
    };
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return {kind: 'held'};
    } catch (error) {
      lastError = error;
      if (errorCode(error) !== 'EEXIST') break;
      if (lockIsStale(path)) {
        try {
          rmSync(path, {force: true});
          continue;
        } catch {
          // Another waiter took it first; wait like everyone else.
        }
      }
      sleepSync(LOCK_SLEEP_MS);
    }
  }
  return {
    kind: 'failed',
    reason:
      errorCode(lastError) === 'EEXIST'
        ? `its lock ${path} stayed held for ${(LOCK_ATTEMPTS * LOCK_SLEEP_MS) / 1000} s`
        : `its lock ${path} could not be taken: ${probeErrorMessage(lastError)}`,
  };
}

function releaseLock(env: EnvLike): void {
  try {
    rmSync(lockPath(env), {force: true});
  } catch {
    // A stranded lock is stolen once its holder is measurably gone, or stale.
  }
}

// ---- naming a chain ----------------------------------------------------------

export type ChainNameForRoot =
  /** The registry already named this root. */
  | {kind: 'found'; name: ChainName}
  /** Named just now, and the line is in the file. */
  | {kind: 'assigned'; name: ChainName}
  | {kind: 'failed'; reason: string};

export interface ChainNameForRootInput {
  env: EnvLike;
  /** TESTS ONLY: how long to hold the lock between the read and the append. */
  holdMs?: number;
  now?: Date;
  /** TESTS ONLY: a small pool, to reach generation II. */
  pool?: readonly string[];
  /** TESTS ONLY: the pick's random source. */
  random?: () => number;
  /** The chain's first session bead (chainRootOf). */
  root: string;
}

function nameForRoot(input: ChainNameForRootInput): ChainNameForRoot {
  const {env, root} = input;
  const pool = input.pool ?? CHAIN_NAME_POOL;
  if (root.trim() === '')
    return {kind: 'failed', reason: 'the chain root is empty'};
  // A name already given needs no lock: lines are only ever appended.
  const before = readChainNames(env, pool);
  if (before.kind === 'failed') return before;
  const known = chainNameInRegistry(before.entries, root);
  if (known != null) return {kind: 'found', name: known};

  const lock = takeLock(env);
  if (lock.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the chain-name registry could not be locked: ${lock.reason}`,
    };
  }
  try {
    // Read again under the lock: another process may have named it, or taken
    // the name this one would pick.
    const read = readChainNames(env, pool);
    if (read.kind === 'failed') return read;
    const raced = chainNameInRegistry(read.entries, root);
    if (raced != null) return {kind: 'found', name: raced};
    const name = pickChainName(read.entries, pool, input.random ?? Math.random);
    if (input.holdMs != null && input.holdMs > 0) sleepSync(input.holdMs);
    const line = JSON.stringify({
      assignedAt: (input.now ?? new Date()).toISOString(),
      name: chainNameText(name),
      root,
    });
    const path = chainNamesPath(env);
    try {
      appendFileSync(path, `${line}\n`);
    } catch (error) {
      return {
        kind: 'failed',
        reason: `${path} could not be appended to: ${probeErrorMessage(error)}`,
      };
    }
    return {kind: 'assigned', name};
  } finally {
    releaseLock(env);
  }
}

/**
 * The name of the chain whose first session bead is `root`: the registry's, or
 * a new one appended to it. Writes no bead. Never throws.
 */
export function chainNameForRoot(
  input: ChainNameForRootInput,
): ChainNameForRoot {
  try {
    return nameForRoot(input);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the chain-name registry threw: ${probeErrorMessage(error)}`,
    };
  }
}

/**
 * componentConfig.thread.chainNames where `cwd` is. A config that throws reads
 * as off: off shows the titles as they were before names, the cautious side.
 */
export function chainNamesKnob(cwd: string, env: EnvLike): boolean {
  try {
    return resolveThreadConfig({cwd, env}).chainNames;
  } catch {
    return false;
  }
}

/** Names chains by their root; the read side and the capture share the shape. */
export interface ChainNamer {
  nameFor: (root: string) => ChainNameForRoot;
}

/**
 * The real namer over the registry, for one run (one inbox read, one status
 * block). The file is read once, on the first ask; a root it does not name is
 * assigned through chainNameForRoot, which reads again under the lock. A name
 * found or assigned is remembered for the run. A failure is not.
 *
 * `assign: false` only looks names up: a root the registry does not name
 * fails with that reason, and nothing is written. `thread status` and the
 * handoff block use it, so only the capture and the inbox hand names out.
 */
export function registryChainNamer(
  env: EnvLike,
  options: {assign?: boolean} = {},
): ChainNamer {
  const named = new Map<string, ChainName>();
  let loaded = false;
  return {
    nameFor: (root) => {
      if (!loaded) {
        loaded = true;
        const read = readChainNames(env);
        if (read.kind === 'read') {
          // Reversed, so the FIRST line of a root wins, as everywhere else.
          for (const entry of [...read.entries].reverse()) {
            named.set(entry.root, entry.name);
          }
        }
      }
      const known = named.get(root);
      if (known != null) return {kind: 'found', name: known};
      if (options.assign === false) {
        return {
          kind: 'failed',
          reason: `the registry names no chain whose first session is ${root}, and this reader hands out none`,
        };
      }
      const outcome = chainNameForRoot({env, root});
      if (outcome.kind !== 'failed') named.set(root, outcome.name);
      return outcome;
    },
  };
}
