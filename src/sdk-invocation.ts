/**
 * sdk-invocation.ts — how the SDK is spelled when it writes itself into a
 * consumer repo (epic home-base-dchjw, decision D1).
 *
 * There are exactly THREE forms and they are not interchangeable:
 *
 *  1. `justin-sdk <cmd>` — inside a package.json SCRIPT VALUE only. `bun run`
 *     prepends `node_modules/.bin` to PATH, which is how eslint/prettier/tsc
 *     are invoked in every repo here. It resolves the repo's own pin, offline.
 *  2. `bun run justin-sdk <cmd>` — everywhere a command is EXECUTED or told to
 *     a human: hooks, advice strings, docs, fixCommands. Hooks run under `sh`,
 *     not under `bun run`, so form 1 would simply not resolve there.
 *  3. `bunx github:justinhaaheim/justin-sdk <cmd>` — BOOTSTRAP only, i.e. the
 *     handful of places where no node_modules can exist yet: the remote
 *     SessionStart hook in a fresh cloud container, and the documented
 *     "enrol a repo that has never heard of the SDK" sentence.
 *
 * What is GONE, and why each one is a bug rather than a style:
 *  - `bunx @justinhaaheim/justin-sdk …` — the scope is not demonstrably
 *    Justin's on registry.npmjs.org and the name 404s there, so whenever local
 *    resolution fails this falls through to the public registry: the standard
 *    dependency-confusion shape (home-base-2qhw).
 *  - `bunx justin-sdk` / `bunx jsdk` / `bunx j` — the same fallthrough with no
 *    scope at all. `j` and `jsdk` resolve to real, unrelated npm packages.
 *  - `bunx github:justinhaaheim/justin-sdk` outside bootstrap — bunx caches a
 *    github spec by SPEC STRING, so an unpinned ref silently keeps running
 *    whatever it fetched the first time.
 *
 * Nothing here executes anything — the one filesystem touch is
 * `resolveWorktreeSdkBin`'s existence check, which is part of spelling "this
 * repo's own binary". It is the vocabulary, in one file, so that a future
 * change of form is one edit rather than forty.
 */

import {existsSync} from 'fs';
import {join} from 'path';

/** The bin name, as it appears in a package.json script value (form 1). */
export const SDK_BIN = 'justin-sdk';

/** The executable prefix for hooks, advice and docs (form 2). */
export const SDK_RUN = `bun run ${SDK_BIN}`;

/** The zero-install bootstrap spec (form 3). Legitimate ONLY where no node_modules can exist. */
export const SDK_BOOTSTRAP = 'bunx github:justinhaaheim/justin-sdk';

/**
 * home-base's `justin-sdk-latest` bin — "run the newest PUBLISHED SDK", D1(b).
 *
 * Not a fourth form: it resolves origin/main's sha and runs form 3 pinned to
 * it. It is spelled here because it is how callers OUTSIDE an enrolled repo
 * invoke the SDK, and the user-level SessionStart hook is exactly such a
 * caller. It is a home-base bin, so anything emitting it must tolerate its
 * absence — the hook string guards with `command -v`.
 */
export const SDK_LATEST = 'justin-sdk-latest';

/** A package.json script value: `justin-sdk signal --quiet`. */
export function sdkScript(args: string): string {
  return `${SDK_BIN} ${args}`;
}

/** A command to run or to print: `bun run justin-sdk doctor`. */
export function sdkRun(args: string): string {
  return `${SDK_RUN} ${args}`;
}

/** The same thing as an argv array, for `spawnSync`/`execFileSync`. */
export function sdkRunArgv(args: string[]): string[] {
  return ['bun', 'run', SDK_BIN, ...args];
}

/**
 * Form 1′: the repo's OWN SDK binary, by absolute path.
 *
 * Not a fourth invocation form so much as form 1 with the resolution pinned
 * down. It exists because `bun run justin-sdk` falls back to PATH when
 * `node_modules/.bin` is missing, and this machine carries a `justin-sdk` PATH
 * shim: a checkout whose `bun install` half-failed then silently runs the
 * ORCHESTRATOR's SDK and exits 0 — measured, epic home-base-dchjw: "with the
 * home-base PATH shim present and no local bin it SILENTLY runs the shim (exit
 * 0)". Anything that must run THIS repo's SDK — a sweep gate, `update`'s
 * re-exec after a self-update — resolves it here and refuses when it is absent,
 * because a command that cannot say which binary it ran has not run anything
 * checkable (critical rule 6).
 *
 * `existsSync` follows symlinks, so a DANGLING `.bin` link — the exact
 * half-installed shape — reads as absent, which is the answer we want.
 */
export type SdkBinResolution =
  | {ok: true; path: string}
  | {ok: false; detail: string};

export function resolveWorktreeSdkBin(projectRoot: string): SdkBinResolution {
  const path = join(projectRoot, 'node_modules', '.bin', SDK_BIN);
  if (!existsSync(path)) {
    return {
      detail:
        `${path} does not exist, so this checkout has no SDK of its own to run. ` +
        `Refusing to fall back to \`bun run ${SDK_BIN}\`: with a ${SDK_BIN} shim on PATH that runs the ` +
        `ORCHESTRATOR's SDK and reports this repo green against a binary it does not have. ` +
        'Run `bun install` here first.',
      ok: false,
    };
  }
  return {ok: true, path};
}

/** `[<that bin>, …args]` — the argv form, so nothing re-derives the path. */
export function worktreeSdkArgv(
  binPath: string,
  args: readonly string[],
): string[] {
  return [binPath, ...args];
}

/**
 * Every retired spelling of "invoke the SDK", anchored at the start of a
 * command string.
 *
 * This is what lets an `install` REWRITE a consumer that still carries an old
 * form: base-setup compares each SDK-owned script against it and replaces the
 * value. These strings were always SDK-emitted, never hand-written, so
 * rewriting them destroys nothing a human chose.
 *
 * `bun run justin-sdk` itself is deliberately NOT matched — it is the current
 * form for hooks, and matching it would make the fingerprint logic below
 * unable to tell "already correct" from "needs rewriting".
 */
export const STALE_SDK_INVOCATION_RE =
  /^bunx\s+(?:@justinhaaheim\/justin-sdk|github:justinhaaheim\/justin-sdk(?:#\S+)?|justin-sdk|jsdk|j)(?:\s|$)/;

/**
 * Does this string invoke the SDK at all, however it is spelled?
 *
 * Used for HOOK fingerprints, where the question is "is my hook already
 * installed, under any generation of spelling?" — answering it on a substring
 * of the command name alone is what let four spellings coexist in the fleet.
 * Deliberately loose: an absolute path to cli.ts counts, because a hand-edited
 * hook that really does run the SDK must not be duplicated.
 */
export function invokesSdk(command: string): boolean {
  return /justin-sdk|\bjsdk\b/.test(command);
}

/** One `{hooks: [{command, type}], matcher?}` entry in a settings.json event array. */
interface HookEntry {
  hooks?: unknown;
  [key: string]: unknown;
}

/**
 * Is this command string one the SDK itself wrote, in any generation?
 *
 * This is the line between "mine to rewrite" and "somebody's deliberate
 * choice". Everything the SDK has ever emitted starts with one of the retired
 * `bunx` spellings or with the current `bun run justin-sdk`. Anything else that
 * still mentions the SDK — an absolute path to a checkout's bin, a wrapper
 * script — was typed by a human for a reason this code cannot see, and at least
 * one such reason is live: an UNENROLLED repo (the threads repo) has no
 * node_modules, so rewriting its absolute-path hook to `bun run justin-sdk`
 * would break the hook outright.
 */
export function isSdkEmittedCommand(command: string): boolean {
  return (
    STALE_SDK_INVOCATION_RE.test(command) || command.startsWith(`${SDK_RUN} `)
  );
}

/**
 * Install a hook command under one event, REWRITING an entry that is this same
 * hook in an older SDK-EMITTED spelling instead of leaving it or duplicating it.
 *
 * The three installers that call this used to ask only "does the serialised
 * event array contain `justin-sdk <subcommand>`?" and, if so, return "already
 * installed".
 * That is what froze four `bunx` spellings into the fleet: every one of them
 * contained the fingerprint, so every one of them looked current forever, and
 * an install could never move a repo forward. Appending instead would have been
 * worse — two entries, both firing.
 *
 * So: match by "invokes the SDK at all, and runs this subcommand" (loose, so a
 * hand-edited variant and every retired spelling are still recognised as MINE
 * and never duplicated), then rewrite the command ONLY when it is a
 * spelling the SDK itself wrote. A hand-edited command is recognised and left
 * exactly as it is, which is the pre-existing contract and still the right one.
 * Entries that do not carry a recognisable `hooks` array are likewise untouched.
 *
 * Returns a new array plus whether anything actually changed, so a re-run is a
 * no-op rather than a rewrite of settings.json.
 */
export function upsertHookCommand(
  registered: readonly unknown[],
  /**
   * The SDK SUBCOMMAND this hook runs (`time-check`, `thread stop-check`) —
   * NOT a whole invocation. Matching on the invocation as a substring
   * (`justin-sdk time-check`) is the dchjw.15 F1 bug: `bunx
   * github:justinhaaheim/justin-sdk#v0.38.0 usage-check` and `bun
   * /abs/path/src/cli.ts time-check` both run this hook and neither contains
   * that string, so both were read as "not installed" and a SECOND entry was
   * appended beside them — two hooks firing on every prompt, in exactly the
   * repos whose spelling was oldest. The question "is this mine?" is answered
   * by `invokesSdk` + the subcommand, which is spelling-independent.
   */
  subcommand: string,
  command: string,
  newEntry: () => unknown,
): {changed: boolean; entries: unknown[]} {
  let found = false;
  let changed = false;

  /** Does this command string run THIS hook, in any spelling of the SDK? */
  const isThisHook = (text: string): boolean =>
    invokesSdk(text) && text.includes(subcommand);

  const entries = registered.map((entry) => {
    if (!isThisHook(JSON.stringify(entry))) return entry;
    found = true;
    const candidate = entry as HookEntry;
    if (!Array.isArray(candidate.hooks)) return entry;

    let entryChanged = false;
    const hooks = candidate.hooks.map((hook) => {
      const spec = hook as {command?: unknown};
      if (
        typeof spec.command === 'string' &&
        isThisHook(spec.command) &&
        spec.command !== command &&
        isSdkEmittedCommand(spec.command)
      ) {
        entryChanged = true;
        return {...spec, command};
      }
      return hook;
    });
    if (!entryChanged) return entry;
    changed = true;
    return {...candidate, hooks};
  });

  if (!found) {
    entries.push(newEntry());
    changed = true;
  }
  return {changed, entries};
}
