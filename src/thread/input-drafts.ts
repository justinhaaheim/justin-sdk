/**
 * Unsent input-box text as a first-class fact in threads (decision D-DRAFTS of
 * epic home-base-yukaf, the store only; home-base-yukaf.2).
 *
 * Justin, 2026-10-17: "critically important that the whatever tooling we have
 * to close these windows checks first to make sure that there's not …
 * unsubmitted text in the … text input box. And if there is that we either
 * block the closing of these tabs or we capture it in a way that's very
 * robust".
 *
 * ONE FILE PER SESSION: `<threadsStateDir>/input-drafts/<sessionId>.json` =
 * {at, text, surfaceId, workspaceId, source, clearedAt}, holding the LATEST
 * observation. Kept apart from the message log, which keeps sent messages
 * only (D-DRAFTS: a 'user-draft' role there was RETRACTED).
 *
 * - `writeInputDraft` replaces the file with a new observation (clearedAt
 *   null), through a temporary file and a rename, so a crash leaves the last
 *   good file, never half of one.
 * - `clearInputDraft` sets clearedAt and KEEPS the text: once the box is seen
 *   empty, or the text appears as a sent user line, the draft is no longer
 *   live, but what was typed stays readable.
 * - The session id becomes a file name, so it must be one (isSafeSessionId,
 *   the message log's rule): anything else is refused, never joined in.
 *
 * Writers in this push: `thread open --undo` (source 'undo'). Dispatch 4 adds
 * `thread drafts scan` ('scan') and scripts/cmux-arrange-close.ts ('close').
 *
 * Critical rule 7: a file that exists but cannot be read or parsed is
 * `failed`, never `absent`; a store directory that cannot be listed is
 * `failed`, never an empty list.
 */

import type {EnvLike} from './paths';

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

import {isSafeSessionId} from './message-log';
import {threadsStateDir} from './paths';

export type InputDraftSource = 'close' | 'scan' | 'undo';

export type InputDraftClearedBy = 'dismissed' | 'emptyBox' | 'missing' | 'sent';

/** A live draft a newer, different text replaced (F18), newest last. */
export interface EarlierDraft {
  at: string;
  surfaceId: string | null;
  text: string;
}

/** How many replaced texts one file keeps. */
export const EARLIER_DRAFTS_KEPT = 20;

export interface InputDraft {
  /** When the text was seen in the input box (ISO). */
  at: string;
  /** When the box was seen empty or the text was sent; null while it is live. */
  clearedAt: string | null;
  /**
   * Why it was cleared (F2): the box was seen empty, the text was sent,
   * Justin dismissed it (`thread drafts dismiss`), or its pane was gone in
   * two scans in a row. null while live, and in files from before F2.
   */
  clearedBy: InputDraftClearedBy | null;
  /**
   * F2's two-scan rule: when a scan first found the draft's pane gone (no
   * pane shows the session and its surface is not in the cmux tree); the
   * next scan that still finds it gone clears it. null otherwise.
   */
  missingSince: string | null;
  /**
   * F18 (home-base-yukaf.14): live texts this one replaced, so a second pane
   * of the session (a reopened session typing something new) never erases
   * the first one's unsent text. Files written before F18 read as [].
   */
  previous: EarlierDraft[];
  /**
   * F23 (home-base-yukaf.14): the text equalled the session's newest SENT
   * message when it was seen ("continue", "yes" typed again and not sent).
   * Stored and shown, with a note, rather than dropped. false in files from
   * before F23.
   */
  sentMatch: boolean;
  source: InputDraftSource;
  surfaceId: string | null;
  /** What was typed, verbatim (as findInputBox read it). */
  text: string;
  workspaceId: string | null;
}

const draftSchema = z.object({
  at: z.string(),
  clearedAt: z.string().nullable(),
  clearedBy: z
    .enum(['dismissed', 'emptyBox', 'missing', 'sent'])
    .nullable()
    .default(null),
  missingSince: z.string().nullable().default(null),
  previous: z
    .array(
      z.object({
        at: z.string(),
        surfaceId: z.string().nullable(),
        text: z.string(),
      }),
    )
    .default([]),
  sentMatch: z.boolean().default(false),
  source: z.enum(['close', 'scan', 'undo']),
  surfaceId: z.string().nullable(),
  text: z.string(),
  workspaceId: z.string().nullable(),
});

export function inputDraftsDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'input-drafts');
}

function refusedId(sessionId: string): string {
  return `refused: ${JSON.stringify(sessionId)} is not a session id (letters, digits, - and _ only, not starting with - or _), so it is never made into a file name`;
}

/** Where one session's draft lives. Throws on an id that is not a file name. */
export function inputDraftPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  if (!isSafeSessionId(sessionId)) throw new Error(refusedId(sessionId));
  return join(inputDraftsDir(env), `${sessionId}.json`);
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? text;
}

export type InputDraftRead =
  | {draft: InputDraft; kind: 'present'; path: string}
  | {kind: 'absent'; path: string}
  | {kind: 'failed'; reason: string};

function readDraftAt(path: string): InputDraftRead {
  if (!existsSync(path)) return {kind: 'absent', path};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the draft file ${path} could not be read: ${errorText(error)}`,
    };
  }
  const result = draftSchema.safeParse(parsed);
  return result.success
    ? {draft: result.data, kind: 'present', path}
    : {
        kind: 'failed',
        reason: `the draft file ${path} is not a draft: ${result.error.issues[0]?.message ?? 'unknown shape'}`,
      };
}

function writeAtomically(path: string, value: InputDraft): string | null {
  try {
    mkdirSync(join(path, '..'), {recursive: true});
    // F22: a per-process name, so two writers never share a temporary file.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export type InputDraftWrite =
  | {draft: InputDraft; kind: 'written'; path: string}
  | {kind: 'failed'; reason: string};

export interface WriteInputDraftInput {
  /** Defaults to now. */
  at?: string;
  /** F23: the text equals the session's newest sent message. Default false. */
  sentMatch?: boolean;
  sessionId: string;
  source: InputDraftSource;
  surfaceId: string | null;
  text: string;
  workspaceId: string | null;
}

/**
 * Record the latest unsent text for a session (clearedAt null). A LIVE draft
 * already stored with different text moves into `previous` (F18), never
 * lost; a stored file that cannot be read is not overwritten (the write
 * fails, naming it), since overwriting it could destroy the only copy.
 */
export function writeInputDraft(
  input: WriteInputDraftInput,
  env: EnvLike = process.env,
): InputDraftWrite {
  if (!isSafeSessionId(input.sessionId)) {
    return {kind: 'failed', reason: refusedId(input.sessionId)};
  }
  const path = inputDraftPath(input.sessionId, env);
  const existing = readDraftAt(path);
  if (existing.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the stored draft could not be read, so it is not overwritten: ${existing.reason}`,
    };
  }
  const prior = existing.kind === 'present' ? existing.draft : null;
  const previous = [...(prior?.previous ?? [])];
  if (prior != null && prior.clearedAt == null && prior.text !== input.text) {
    previous.push({at: prior.at, surfaceId: prior.surfaceId, text: prior.text});
  }
  const draft: InputDraft = {
    at: input.at ?? new Date().toISOString(),
    clearedAt: null,
    clearedBy: null,
    missingSince: null,
    previous: previous.slice(-EARLIER_DRAFTS_KEPT),
    sentMatch: input.sentMatch ?? false,
    source: input.source,
    surfaceId: input.surfaceId,
    text: input.text,
    workspaceId: input.workspaceId,
  };
  const failure = writeAtomically(path, draft);
  return failure == null
    ? {draft, kind: 'written', path}
    : {
        kind: 'failed',
        reason: `the draft file ${path} could not be written: ${failure}`,
      };
}

/** One session's draft: present (live or cleared), absent, or failed. */
export function readInputDraft(
  sessionId: string,
  env: EnvLike = process.env,
): InputDraftRead {
  if (!isSafeSessionId(sessionId)) {
    return {kind: 'failed', reason: refusedId(sessionId)};
  }
  return readDraftAt(inputDraftPath(sessionId, env));
}

export type InputDraftClear =
  | {draft: InputDraft; kind: 'cleared'; path: string}
  | {kind: 'absent'; path: string}
  | {kind: 'failed'; reason: string};

/**
 * Mark a session's draft as no longer live: sets clearedAt, keeps the text. A
 * draft already cleared keeps its first clearedAt.
 */
export function clearInputDraft(
  sessionId: string,
  env: EnvLike = process.env,
  at: string = new Date().toISOString(),
  by: InputDraftClearedBy | null = null,
): InputDraftClear {
  const read = readInputDraft(sessionId, env);
  if (read.kind !== 'present') return read;
  if (read.draft.clearedAt != null) {
    return {draft: read.draft, kind: 'cleared', path: read.path};
  }
  const draft: InputDraft = {
    ...read.draft,
    clearedAt: at,
    clearedBy: by,
    missingSince: null,
  };
  const failure = writeAtomically(read.path, draft);
  return failure == null
    ? {draft, kind: 'cleared', path: read.path}
    : {
        kind: 'failed',
        reason: `the draft file ${read.path} could not be rewritten: ${failure}`,
      };
}

/**
 * F2's two-scan rule, the first half: record (or reset, with null) when a
 * scan found this live draft's pane gone. Writes nothing when unchanged.
 */
export function setInputDraftMissing(
  sessionId: string,
  missingSince: string | null,
  env: EnvLike = process.env,
): {kind: 'failed'; reason: string} | {kind: 'ok'} {
  const read = readInputDraft(sessionId, env);
  if (read.kind === 'failed') return read;
  if (read.kind === 'absent') {
    return {kind: 'failed', reason: `no stored draft at ${read.path}`};
  }
  if (read.draft.missingSince === missingSince) return {kind: 'ok'};
  const failure = writeAtomically(read.path, {...read.draft, missingSince});
  return failure == null
    ? {kind: 'ok'}
    : {
        kind: 'failed',
        reason: `the draft file ${read.path} could not be rewritten: ${failure}`,
      };
}

export interface ListedInputDraft {
  draft: InputDraft;
  path: string;
  sessionId: string;
}

export type InputDraftList =
  | {
      drafts: ListedInputDraft[];
      /** Files in the store that could not be read, each with why. */
      failures: string[];
      kind: 'read';
    }
  | {kind: 'failed'; reason: string};

/**
 * Every draft in the store, newest observation first. A store directory that
 * does not exist is read and empty (nothing was ever written); one that
 * cannot be listed is failed.
 */
export function listInputDrafts(env: EnvLike = process.env): InputDraftList {
  const dir = inputDraftsDir(env);
  if (!existsSync(dir)) return {drafts: [], failures: [], kind: 'read'};
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the draft store ${dir} could not be listed: ${errorText(error)}`,
    };
  }
  const drafts: ListedInputDraft[] = [];
  const failures: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    if (!isSafeSessionId(sessionId)) {
      failures.push(`${join(dir, name)}: not named after a session id`);
      continue;
    }
    const read = readDraftAt(join(dir, name));
    if (read.kind === 'present') {
      drafts.push({draft: read.draft, path: read.path, sessionId});
    } else if (read.kind === 'failed') {
      failures.push(read.reason);
    }
  }
  drafts.sort((a, b) => b.draft.at.localeCompare(a.draft.at));
  return {drafts, failures, kind: 'read'};
}
