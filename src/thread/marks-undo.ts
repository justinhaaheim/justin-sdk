/**
 * The undo store for Justin's marks (home-base-yukaf.9, epic home-base-yukaf
 * D-GMAIL-KEYS): `<threadsStateDir>/marks-undo.jsonl`.
 *
 * `thread done` / `thread archive` (closeSession) append ONE `mark` line BEFORE
 * they change anything: every bead they are about to close with the status it
 * had, every adopted request they are about to release, and every label they
 * are about to add. A mark whose line cannot be written is refused, so nothing
 * is ever closed that `thread unmark` could not put back.
 *
 * `thread unmark` reverses the newest mark line not yet undone and then
 * appends an `undone` line naming it. Append-only on purpose (the
 * workspace-names.jsonl pattern): rewriting the file in place would race a
 * mark appended at the same moment and could drop its line, and with it the
 * only way back.
 */

import type {EnvLike} from './paths';

import {randomUUID} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {z} from 'zod';

import {threadsStateDir} from './paths';

export const MARKS_UNDO_FILE = 'marks-undo.jsonl';

export function marksUndoPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), MARKS_UNDO_FILE);
}

const located = z.object({db: z.string(), id: z.string()});

const markLine = z.object({
  at: z.string(),
  /** Each bead the mark closes, in the order it closes them, with its status before. */
  closed: z.array(located.extend({priorStatus: z.string()})),
  id: z.string(),
  kind: z.literal('mark'),
  /** Labels the mark adds to the session bead (`archived`, when it lacked it). */
  labelsAdded: z.array(z.string()),
  mode: z.enum(['archive', 'done']),
  /** Adopted requests the mark releases (their request and sid labels removed). */
  released: z.array(located),
  sessionBeadId: z.string(),
  /** The beads DB that holds the session bead (labels are restored there). */
  sessionDb: z.string(),
  sessionId: z.string(),
});

const undoneLine = z.object({
  id: z.string(),
  kind: z.literal('undone'),
  undoneAt: z.string(),
});

const line = z.discriminatedUnion('kind', [markLine, undoneLine]);

export type MarkUndoInput = Omit<z.infer<typeof markLine>, 'id' | 'kind'>;
export type MarkUndoRecord = z.infer<typeof markLine> & {
  /** When `thread unmark` reversed it; null while it can still be undone. */
  undoneAt: string | null;
};

/**
 * `missing` (no mark ever recorded) is a measured answer and reads as no
 * records. Any line that does not parse — except a partial LAST line, an
 * append in flight — fails the whole read: the broken line might be the mark
 * being undone, and guessing would reopen the wrong beads (rule 7).
 */
export type MarksUndoRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; records: MarkUndoRecord[]};

export function readMarksUndo(env: EnvLike = process.env): MarksUndoRead {
  const path = marksUndoPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'read', records: []};
    }
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  const raw = text.split('\n');
  const endsClean = text.endsWith('\n') || text === '';
  const records: MarkUndoRecord[] = [];
  const undone = new Map<string, string>();
  for (const [index, entry] of raw.entries()) {
    if (entry.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(entry) as unknown;
    } catch {
      json = undefined;
    }
    const parsed = line.safeParse(json);
    if (!parsed.success) {
      if (!endsClean && index === raw.length - 1) continue;
      return {
        kind: 'failed',
        reason: `${path} line ${index + 1} is not a marks-undo record, so nothing is undone until it is repaired`,
      };
    }
    if (parsed.data.kind === 'undone') {
      undone.set(parsed.data.id, parsed.data.undoneAt);
    } else {
      records.push({...parsed.data, undoneAt: null});
    }
  }
  return {
    kind: 'read',
    records: records.map((record) => ({
      ...record,
      undoneAt: undone.get(record.id) ?? null,
    })),
  };
}

function append(
  value: z.infer<typeof line>,
  env: EnvLike,
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  const path = marksUndoPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(value)}\n`);
    return {kind: 'ok'};
  } catch (error) {
    return {error: `${path}: ${String(error)}`, kind: 'failed'};
  }
}

/** Written BEFORE the mark changes anything; its id names it for `undone`. */
export function appendMarkUndo(
  input: MarkUndoInput,
  env: EnvLike = process.env,
): {error: string; kind: 'failed'} | {id: string; kind: 'ok'} {
  const id = randomUUID();
  const written = append({...input, id, kind: 'mark'}, env);
  return written.kind === 'ok' ? {id, kind: 'ok'} : written;
}

export function appendUndone(
  id: string,
  undoneAt: string,
  env: EnvLike = process.env,
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  return append({id, kind: 'undone', undoneAt}, env);
}

/**
 * The mark `thread unmark` reverses: the newest one not undone, for the
 * session `selector` names (its session bead id or claude session id), or the
 * newest of all when there is no selector.
 */
export function undoableById(
  records: readonly MarkUndoRecord[],
  id: string,
):
  | {kind: 'alreadyUndone'}
  | {kind: 'found'; record: MarkUndoRecord}
  | {kind: 'unknown'} {
  const wanted = id.trim();
  const record = records.find((entry) => entry.id === wanted);
  if (record == null) return {kind: 'unknown'};
  if (record.undoneAt != null) return {kind: 'alreadyUndone'};
  return {kind: 'found', record};
}

export function newestUndoable(
  records: readonly MarkUndoRecord[],
  selector: string | null,
): MarkUndoRecord | null {
  const wanted = selector?.trim() ?? '';
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record == null || record.undoneAt != null) continue;
    if (
      wanted === '' ||
      record.sessionBeadId === wanted ||
      record.sessionId === wanted
    ) {
      return record;
    }
  }
  return null;
}

/**
 * The line `thread done` / `thread archive` print when they wrote an undo
 * record (home-base-yukaf.14 F11). The threads TUI reads the id from it, so
 * `u` reverses exactly this mark and never an older one; a mark that changed
 * nothing prints no such line.
 */
export function undoLine(id: string): string {
  return `Undo: thread unmark --mark ${id}`;
}

const UNDO_LINE =
  /^Undo: thread unmark --mark ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/mu;

/** The undo record id a done/archive output names, or null when it names none. */
export function undoIdOf(output: string): string | null {
  return UNDO_LINE.exec(output)?.[1] ?? null;
}
