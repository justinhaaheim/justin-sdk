/**
 * Is the session guard registered? (home-base-mbnjv.5, epic C8)
 *
 * FAIL CLOSED IN THE COMMAND. With componentConfig.thread.handoff.successor
 * on, `thread handoff` and `thread spawn` refuse (gate reason
 * guardNotRegistered, exit 3) unless the PreToolUse [Bash] guard is registered
 * in the settings Claude Code merges for the session: the user file, and the
 * project's settings.json and settings.local.json. Without the guard a
 * subagent could hand off its parent, and nothing would stop a raw `claude
 * --bg`; the command must not open a door the guard is meant to watch.
 *
 * WHICH PROJECT. A Bash call does not carry CLAUDE_PROJECT_DIR (measured
 * 2026-10-29 in a player session: unset, while CLAUDE_CODE_SESSION_ID is set),
 * so the command cannot know which checkout's settings the session loaded. It
 * checks every root it can name, the command's own (cwd) and the session's
 * checkout from the sessions index, and needs the guard in each: a guess in
 * the reassuring direction is what critical rule 7 forbids.
 *
 * WHAT COUNTS. Under PreToolUse, an entry whose matcher accepts Bash and whose
 * command is the per-handler `bun run justin-sdk thread guard` (or a
 * hand-edited spelling that still runs the SDK's `thread guard`), or, in a
 * PROJECT file only, the PreToolUse dispatcher entry while the repo's
 * components include thread-hooks-setup (the dispatcher runs only listed
 * components). The same split repoStateHookPresence (first-prompt.ts) makes.
 * A settings file that cannot be read makes the answer unknown, never absent
 * and never registered.
 */

import type {EnvLike} from './paths';

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {resolveComponents} from '../component-registry';
import {findProjectRoot} from '../health-notices';
import {isDispatchCommand, matcherAccepts} from '../hook-registry';
import {invokesSdk} from '../sdk-invocation';
import {
  THREAD_GUARD_HOOK_COMMAND,
  THREAD_GUARD_HOOK_EVENT,
} from '../thread-hooks-setup';
import {userSettingsPath} from '../user-level-hook';

export type GuardRegistration =
  | {kind: 'absent'; looked: string[]; root: string}
  | {kind: 'registered'; where: string[]}
  | {kind: 'unknown'; why: string};

type FileRead =
  | {kind: 'missing'}
  | {kind: 'ok'; settings: Record<string, unknown>}
  | {kind: 'unreadable'; why: string};

function readSettings(file: string): FileRead {
  if (!existsSync(file)) return {kind: 'missing'};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {kind: 'unreadable', why: `${file} is not a JSON object`};
    }
    return {kind: 'ok', settings: parsed as Record<string, unknown>};
  } catch (error) {
    return {
      kind: 'unreadable',
      why: `${file} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Every PreToolUse command whose entry's matcher accepts Bash. */
function bashPreToolUseCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks;
  if (hooks == null || typeof hooks !== 'object') return [];
  const entries = (hooks as Record<string, unknown>)[THREAD_GUARD_HOOK_EVENT];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return [];
    const {hooks: inner, matcher} = entry as {
      hooks?: unknown;
      matcher?: unknown;
    };
    const pattern =
      typeof matcher === 'string' && matcher !== '' ? matcher : null;
    if (!matcherAccepts(pattern, 'Bash') || !Array.isArray(inner)) return [];
    return inner
      .map((hook) => (hook as {command?: unknown} | null)?.command)
      .filter((c): c is string => typeof c === 'string');
  });
}

function runsGuardItself(command: string): boolean {
  return (
    command === THREAD_GUARD_HOOK_COMMAND ||
    (invokesSdk(command) && command.includes('thread guard'))
  );
}

type ComponentsRead =
  | {kind: 'ok'; listed: boolean}
  | {kind: 'unknown'; why: string};

function threadHooksListed(root: string): ComponentsRead {
  const path = join(root, 'justin-sdk.config.json');
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      kind: 'unknown',
      why: `${path} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const resolved = resolveComponents(config, root);
  if (!resolved.ok) return {kind: 'unknown', why: resolved.reason};
  return {
    kind: 'ok',
    listed: resolved.components.includes('thread-hooks-setup'),
  };
}

/** One root: registered in the user file or in that project's own files. */
function rootRegistration(root: string, env: EnvLike): GuardRegistration {
  const userFile = userSettingsPath(env);
  const files = [
    {file: userFile, project: false},
    {file: join(root, '.claude', 'settings.json'), project: true},
    {file: join(root, '.claude', 'settings.local.json'), project: true},
  ];
  const unknown: string[] = [];
  for (const {file, project} of files) {
    const read = readSettings(file);
    if (read.kind === 'missing') continue;
    if (read.kind === 'unreadable') {
      unknown.push(read.why);
      continue;
    }
    const commands = bashPreToolUseCommands(read.settings);
    if (commands.some(runsGuardItself)) {
      return {kind: 'registered', where: [file]};
    }
    if (
      project &&
      commands.some((c) => isDispatchCommand(THREAD_GUARD_HOOK_EVENT, c))
    ) {
      const listed = threadHooksListed(root);
      if (listed.kind === 'unknown') unknown.push(listed.why);
      else if (listed.listed) return {kind: 'registered', where: [file]};
    }
  }
  if (unknown.length > 0) {
    return {kind: 'unknown', why: `could not read ${unknown.join(', ')}`};
  }
  return {kind: 'absent', looked: files.map((f) => f.file), root};
}

/**
 * Registered only when every root has it. `roots` are directories; each is
 * resolved to its project root as the knob is (findProjectRoot).
 */
export function guardRegistration(input: {
  env: EnvLike;
  roots: readonly string[];
}): GuardRegistration {
  const roots = [...new Set(input.roots.map((r) => findProjectRoot(r)))];
  const where: string[] = [];
  for (const root of roots) {
    const one = rootRegistration(root, input.env);
    if (one.kind !== 'registered') return one;
    where.push(...one.where);
  }
  return {kind: 'registered', where: [...new Set(where)]};
}

/** The gate's detail for a registration that is not `registered`. */
export function describeGuardNotRegistered(
  registration: Exclude<GuardRegistration, {kind: 'registered'}>,
): string {
  if (registration.kind === 'unknown') {
    return `whether the session guard (PreToolUse [Bash] → thread guard) is registered could not be checked: ${registration.why}`;
  }
  return `the session guard (PreToolUse [Bash] → thread guard) is not registered for ${registration.root}: none of ${registration.looked.join(', ')} has it. \`bun run justin-sdk install\` writes it where componentConfig.thread.handoff.successor is on`;
}
