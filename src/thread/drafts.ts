/**
 * The draft store behind `thread answer` (home-base-p1uj.12, invariant I1).
 *
 * ONE FILE PER ASK, under `<stateDir>/drafts/<threadId>/<askId>.txt`. That shape
 * is the invariant: "no keystroke ever discards text" is only true if the text
 * is somewhere a keystroke cannot reach, and the only such place is the disk.
 * Quitting, closing the browser, killing the server and Ctrl-C all leave every
 * file exactly where it was, and the next run reads them back.
 *
 * A FILE PER ASK RATHER THAN ONE JSON BLOB, deliberately. A blob has to be
 * re-serialised on every keystroke burst, so a write that dies halfway can
 * corrupt drafts for asks the human was not even editing. Separate files make a
 * partial write lose at most the ask being typed into, and make the store
 * inspectable with `ls` when something has gone wrong.
 *
 * RULE 6 THROUGHOUT: "there is no draft" and "I could not look" are different
 * facts and are different members of `DraftRead`/`DraftList`. A read that failed
 * must never arrive at the UI as an empty textarea — that is precisely the
 * five-paragraphs-gone outcome this whole bead exists to prevent.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {threadsStateDir, type EnvLike} from './paths';

/** The reserved ask id for the final free-text note (invariant I7). */
export const NOTE_DRAFT_ID = '__note__';

/**
 * Ask ids come from bd (`th-x7q.2`) and the note uses the reserved id above.
 * Anything else is refused rather than sanitised: a silently rewritten id would
 * save a draft to a path the next run does not look in, which reads to the human
 * as text that vanished.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isSafeDraftId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..');
}

/** Where one ask's draft lives. Throws on an id that is not storable. */
export function draftPath(
  stateDir: string,
  threadId: string,
  askId: string,
): string {
  if (!isSafeDraftId(threadId)) {
    throw new Error(`unstorable thread id: ${JSON.stringify(threadId)}`);
  }
  if (!isSafeDraftId(askId)) {
    throw new Error(`unstorable ask id: ${JSON.stringify(askId)}`);
  }
  return join(stateDir, 'drafts', threadId, `${askId}.txt`);
}

/** The directory holding one thread's drafts. */
export function draftsDir(stateDir: string, threadId: string): string {
  if (!isSafeDraftId(threadId)) {
    throw new Error(`unstorable thread id: ${JSON.stringify(threadId)}`);
  }
  return join(stateDir, 'drafts', threadId);
}

export type DraftWrite = {kind: 'ok'; savedAt: string} | DraftFailure;

export type DraftRead =
  | {kind: 'present'; savedAt: string; text: string}
  | {kind: 'absent'}
  | DraftFailure;

export interface DraftFailure {
  error: string;
  kind: 'failed';
}

export interface StoredDraft {
  askId: string;
  savedAt: string;
  text: string;
}

/**
 * Everything on disk for one thread.
 *
 * `kind: 'ok'` with an empty array is a CLAIM — checked, and there are none. A
 * directory that could not be read is `failed`, never an empty list, so the page
 * can never present "no drafts" when the truth is "I did not look".
 */
export type DraftList = {drafts: StoredDraft[]; kind: 'ok'} | DraftFailure;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : '';
}

/**
 * Save one draft. The whole of I1 lands here.
 *
 * Writes are whole-file and unconditional: the caller sends the textarea's
 * current value, so the newest write always describes the newest keystroke and
 * there is no merge to get wrong.
 */
export function writeDraft(
  stateDir: string,
  threadId: string,
  askId: string,
  text: string,
): DraftWrite {
  let path: string;
  try {
    path = draftPath(stateDir, threadId, askId);
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
  try {
    mkdirSync(draftsDir(stateDir, threadId), {recursive: true});
    writeFileSync(path, text, 'utf8');
    return {kind: 'ok', savedAt: statSync(path).mtime.toISOString()};
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
}

export function readDraft(
  stateDir: string,
  threadId: string,
  askId: string,
): DraftRead {
  let path: string;
  try {
    path = draftPath(stateDir, threadId, askId);
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
  try {
    const text = readFileSync(path, 'utf8');
    return {kind: 'present', savedAt: statSync(path).mtime.toISOString(), text};
  } catch (error) {
    // ENOENT is the ONLY error that means "there is no draft". Everything else
    // — a denied read, a directory in the way — is a failure to look.
    return codeOf(error) === 'ENOENT'
      ? {kind: 'absent'}
      : {error: messageOf(error), kind: 'failed'};
  }
}

/** Every draft stored for one thread, newest-first by ask id order on disk. */
export function listDrafts(stateDir: string, threadId: string): DraftList {
  let dir: string;
  try {
    dir = draftsDir(stateDir, threadId);
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    // No directory = this thread has never been answered. That IS "none".
    if (codeOf(error) === 'ENOENT') return {drafts: [], kind: 'ok'};
    return {error: messageOf(error), kind: 'failed'};
  }
  const drafts: StoredDraft[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.txt')) continue;
    const askId = name.slice(0, -'.txt'.length);
    const read = readDraft(stateDir, threadId, askId);
    // A single unreadable draft fails the whole list rather than quietly
    // shrinking it: "you have 5 drafts" when there are 6 is the reassuring
    // shape of wrong.
    if (read.kind === 'failed') return read;
    if (read.kind === 'absent') continue;
    drafts.push({askId, savedAt: read.savedAt, text: read.text});
  }
  return {drafts, kind: 'ok'};
}

/**
 * Delete one draft. Used ONLY by an explicit human action ("discard this
 * draft") and by a successful submit — never by navigation, never by a
 * keystroke, and never on the way out.
 */
export function clearDraft(
  stateDir: string,
  threadId: string,
  askId: string,
): DraftWrite {
  try {
    rmSync(draftPath(stateDir, threadId, askId), {force: true});
    return {kind: 'ok', savedAt: new Date().toISOString()};
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
}

/** Drop every draft for a thread. Called after a submit in which nothing failed. */
export function clearDrafts(stateDir: string, threadId: string): DraftWrite {
  try {
    rmSync(draftsDir(stateDir, threadId), {force: true, recursive: true});
    return {kind: 'ok', savedAt: new Date().toISOString()};
  } catch (error) {
    return {error: messageOf(error), kind: 'failed'};
  }
}

/** The state dir this run will use, with the env override applied. */
export function draftStateDir(env: EnvLike = process.env): string {
  return threadsStateDir(env);
}
