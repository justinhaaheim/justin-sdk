/**
 * A transcript's first and last CONVERSATION record times, read from its head
 * and tail only (home-base-yukaf.2).
 *
 * ONE IMPLEMENTATION: moved here from home-base's scripts/cmux-arrange.ts,
 * which imports it back through `@justinhaaheim/justin-sdk/transcript-activity`.
 * `cmux-arrange --older-than` sorts and closes by it, and `thread open --undo`
 * keeps a workspace whose session had activity after the run opened it
 * (D-UNDO-SAFETY gate 3).
 *
 * Only `user` and `assistant` records count, and not `isMeta` ones:
 * `claude --resume` appends `attachment` records stamped with the resume time
 * (measured 2026-10-04: a session idle for 8 days read as "19m ago" after cmux
 * relaunched it), so any record would sort every respawned session as newest.
 * A resume can also append a `user` record carrying a `<task-notification>`
 * about background tasks the previous process left behind (eb9e2c72, same
 * day); that is the harness talking, not activity, so it is skipped too.
 *
 * Critical rule 7: a missing file, an unreadable one and one with no
 * timestamped record are all `unknown` with the reason, never a time.
 */

/** One transcript's first and last record times, read together or not at all. */
export type ActivityTimes =
  | {kind: 'known'; lastMs: number; startedMs: number}
  | {kind: 'unknown'; reason: string};

/** The `timestamp` of the first conversation record found, scanning lines in `order`. */
function firstTimestamp(
  text: string,
  order: 'backward' | 'forward',
): number | null {
  const lines = text.split('\n');
  if (order === 'backward') lines.reverse();
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as {
        isMeta?: unknown;
        message?: {content?: unknown};
        timestamp?: unknown;
        type?: unknown;
      };
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      if (record.isMeta === true) continue;
      const content = record.message?.content;
      if (
        typeof content === 'string' &&
        content.startsWith('<task-notification>')
      ) {
        continue;
      }
      if (typeof record.timestamp !== 'string') continue;
      const ms = Date.parse(record.timestamp);
      if (!Number.isNaN(ms)) return ms;
    } catch {
      // A chunk boundary cuts one line in half; the next line is whole.
    }
  }
  return null;
}

/**
 * First and last record times. The tail is scanned in 256 KB, then 4 MB; the
 * head in 64 KB, then 4 MB.
 */
export async function readActivity(path: string): Promise<ActivityTimes> {
  try {
    const file = Bun.file(path);
    // A missing file reads as size 0, which would otherwise surface as "no
    // timestamped record" — a different fact (rule 7).
    if (!(await file.exists())) {
      return {kind: 'unknown', reason: `transcript file not found: ${path}`};
    }
    const size = file.size;
    let lastMs: number | null = null;
    for (const chunk of [256 * 1024, 4 * 1024 * 1024]) {
      lastMs = firstTimestamp(
        await file.slice(Math.max(0, size - chunk), size).text(),
        'backward',
      );
      if (lastMs != null || chunk >= size) break;
    }
    let startedMs: number | null = null;
    for (const chunk of [64 * 1024, 4 * 1024 * 1024]) {
      startedMs = firstTimestamp(
        await file.slice(0, Math.min(size, chunk)).text(),
        'forward',
      );
      if (startedMs != null || chunk >= size) break;
    }
    if (lastMs == null || startedMs == null) {
      return {
        kind: 'unknown',
        reason: 'no timestamped record in the transcript',
      };
    }
    return {kind: 'known', lastMs, startedMs};
  } catch (err) {
    return {
      kind: 'unknown',
      reason: `transcript unreadable: ${String(err).split('\n')[0]}`,
    };
  }
}
