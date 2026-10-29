/**
 * The guard's one-time pass (home-base-mbnjv.8 F14). `thread handoff` and
 * `thread spawn` (knob on) fail CLOSED on it: they start nothing unless the
 * PreToolUse session guard (session-guard.ts) saw this very call and allowed
 * it.
 *
 * WHY. The guard fails open by design in one place it cannot control: the
 * dispatcher stops a handler at 25 s and the Bash call then goes ahead
 * (hook-dispatch.ts). And guard-registration.ts proves only that an entry
 * exists, not that the guard ran (a stale entry where the knob is now off
 * reads as registered). A subagent's thread handoff that slipped past a hung
 * guard would hand off its parent. The pass closes that: no pass, no launch.
 *
 * THE PASS. When the guard ALLOWS a Bash call that runs `thread handoff` or
 * `thread spawn` through the SDK, from a main session (no agent_id), it writes
 * `<threads state dir>/guard-pass/<session id>.json` = {at, sub, hash}. The
 * command reads it once and deletes it (single use, whatever the verdict), and
 * passes only when it is at most GUARD_PASS_MAX_AGE_MS old and its hash equals
 * the hash of the command's own words.
 *
 * THE HASH covers `thread`, the subcommand and the FLAG NAMES that follow
 * (`--note`, `--dry-run`, `--model`; `--x=y` counts as `--x`), not the values.
 * The guard reads values as the Bash text spells them ($VAR unexpanded, a
 * substitution as a placeholder) while the command gets them expanded, so a
 * hash over values would refuse a legitimate `--note "costs $5"`. The flag
 * names are enough to tell a dry run from a real run and a spawn from a
 * handoff.
 */

import type {EnvLike} from './paths';

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {threadsStateDir} from './paths';

/** A pass older than this is stale: the guard runs right before the call. */
export const GUARD_PASS_MAX_AGE_MS = 60_000;

/** The subcommands that need a pass. */
export const GUARD_PASS_SUBCOMMANDS = ['handoff', 'spawn'] as const;
export type GuardPassSubcommand = (typeof GUARD_PASS_SUBCOMMANDS)[number];

export function guardPassPath(sessionId: string, env: EnvLike): string {
  return join(threadsStateDir(env), 'guard-pass', `${sessionId}.json`);
}

/**
 * The key of a thread call: `words` must hold `thread <sub>`; everything
 * before `thread` is ignored (the program spelling). null when there is no
 * `thread handoff|spawn` in them.
 */
export function guardPassKey(
  words: readonly string[],
): {hash: string; sub: GuardPassSubcommand} | null {
  const at = words.findIndex(
    (word, index) =>
      word === 'thread' &&
      (GUARD_PASS_SUBCOMMANDS as readonly string[]).includes(
        words[index + 1] ?? '',
      ),
  );
  if (at < 0) return null;
  const sub = words[at + 1] as GuardPassSubcommand;
  const flags = words
    .slice(at + 2)
    .filter((word) => word.startsWith('-'))
    .map((word) => word.split('=')[0] ?? word);
  const hash = createHash('sha256')
    .update(JSON.stringify(['thread', sub, ...flags]))
    .digest('hex');
  return {hash, sub};
}

export type GuardPassWrite =
  | {kind: 'failed'; reason: string}
  | {kind: 'written'; path: string};

/** The guard's half: record that it allowed this call. Never throws. */
export function writeGuardPass(input: {
  env: EnvLike;
  now: Date;
  sessionId: string;
  words: readonly string[];
}): GuardPassWrite {
  const key = guardPassKey(input.words);
  const path = guardPassPath(input.sessionId, input.env);
  if (key == null) {
    return {
      kind: 'failed',
      reason: 'the words hold no thread handoff or spawn',
    };
  }
  try {
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(
      path,
      `${JSON.stringify({at: input.now.toISOString(), hash: key.hash, sub: key.sub})}\n`,
    );
    return {kind: 'written', path};
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type GuardPassRead =
  | {kind: 'invalid'; path: string; reason: string}
  | {kind: 'mismatch'; path: string; sub: string}
  | {kind: 'missing'; path: string}
  | {ageMs: number; kind: 'stale'; path: string}
  | {kind: 'valid'; path: string};

/**
 * The command's half: read the pass once and delete it, then judge it. A pass
 * that could not be deleted is not trusted (it could be used twice).
 */
export function consumeGuardPass(input: {
  env: EnvLike;
  now: Date;
  sessionId: string;
  words: readonly string[];
}): GuardPassRead {
  const path = guardPassPath(input.sessionId, input.env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {kind: 'missing', path};
    }
    return {
      kind: 'invalid',
      path,
      reason: `it could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    rmSync(path);
  } catch (error) {
    return {
      kind: 'invalid',
      path,
      reason: `it could not be deleted after reading, so it could be used twice: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {kind: 'invalid', path, reason: 'it is not JSON'};
  }
  const record = (parsed ?? {}) as {
    at?: unknown;
    hash?: unknown;
    sub?: unknown;
  };
  const atMs =
    typeof record.at === 'string' ? Date.parse(record.at) : Number.NaN;
  if (Number.isNaN(atMs) || typeof record.hash !== 'string') {
    return {kind: 'invalid', path, reason: 'it has no valid at and hash'};
  }
  const ageMs = input.now.getTime() - atMs;
  if (ageMs > GUARD_PASS_MAX_AGE_MS || ageMs < -5_000) {
    return {ageMs, kind: 'stale', path};
  }
  const key = guardPassKey(input.words);
  if (key?.hash !== record.hash) {
    return {
      kind: 'mismatch',
      path,
      sub: typeof record.sub === 'string' ? record.sub : '?',
    };
  }
  return {kind: 'valid', path};
}

/** Why a read refuses, in one clause. */
export function describeGuardPass(read: GuardPassRead): string {
  const tail =
    'so the session guard is not proven to have checked this call (it may have timed out, failed, or not run); nothing is started without it';
  switch (read.kind) {
    case 'missing': {
      return `no guard pass at ${read.path}, ${tail}`;
    }
    case 'invalid': {
      return `the guard pass at ${read.path} is not usable (${read.reason}), ${tail}`;
    }
    case 'stale': {
      return `the guard pass at ${read.path} is ${Math.round(read.ageMs / 1000)} s old (limit ${GUARD_PASS_MAX_AGE_MS / 1000} s), ${tail}`;
    }
    case 'mismatch': {
      return `the guard pass at ${read.path} was written for a different call (thread ${read.sub} with other flags), ${tail}`;
    }
    case 'valid': {
      return 'the guard checked this call';
    }
  }
}
