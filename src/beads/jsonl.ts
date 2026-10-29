/**
 * Which beads JSONL export a reader reads (home-base-dj5m9.1.2, step 2b of the
 * br 0.7.6 plan in home-base-pp1vx.1.1).
 *
 * The SDK's thread readers read `.beads/issues.jsonl` instead of running br
 * (one file read is ~4 ms; one br run is ~270 ms on home-base's DB). br
 * rewrites that file after every write, so it is live, but only the file
 * BESIDE THE DB br used. From br 0.4.1 on, a linked worktree with no DB of its
 * own uses its primary checkout's DB, and br then rewrites the PRIMARY's
 * export on every write from the worktree (measured on br 0.7.6, 2026-10-26).
 * The worktree's own `.beads/issues.jsonl` is still there, because it is
 * committed, but it stays at the branch's last commit: reading it shows stale
 * beads without failing.
 *
 * So the export is located by the SAME discovery as the DB, never by a second
 * rule: the `issues.jsonl` beside the DB that `findBeadsWorkspace` (a cwd) or
 * `resolveRecordedBeadsDb` (a sessions-index `beadsDir`) picks. Under br before
 * 0.4.1 that is the checkout's own file, exactly as before.
 *
 * The file name is br's default. br can be told another one in
 * `.beads/metadata.json` (`jsonl_export`); the thread readers have never
 * honoured that, and this module does not start to.
 */
import type {BeadsWorkspace} from './br';

import {join} from 'node:path';

import {resolveRecordedBeadsDb} from './br';

/** The name of the export br writes beside its database. */
export const BEADS_JSONL = 'issues.jsonl';

/**
 * The export a found workspace's br writes: beside the DB `findBeadsWorkspace`
 * picked. For a linked worktree that uses its primary checkout's DB
 * (`via: 'primary'`), that is the PRIMARY's file, never `<root>/.beads`.
 */
export function workspaceBeadsJsonl(
  workspace: Extract<BeadsWorkspace, {kind: 'found'}>,
): string {
  return join(workspace.beadsDir, BEADS_JSONL);
}

/**
 * Which export to read for a RECORDED `.beads/` directory (a sessions-index
 * `beadsDir`, or any directory a reader was handed), located through
 * `resolveRecordedBeadsDb`:
 *   - `recorded`: the directory holds a DB of its own, which br uses, so its
 *     export is there.
 *   - `primary`: it holds none and the repo's br shares the primary checkout's
 *     DB: the primary's export, the one br rewrites.
 *   - `noDatabase`: no DB br would use was found (br before 0.4.1 with the
 *     directory's DB gone, no DB in the primary either, a gone worktree whose
 *     primary cannot be traced, a directory not named `.beads`). The
 *     directory's own file is then the only export there is, and it is read
 *     as it was before this rule existed.
 *   - `failed`: which DB br uses could not be told (its version could not be
 *     read, git failed, the directory could not be listed or holds several
 *     DBs). Never guessed (critical rule 7): a reader says it, it does not
 *     read some file instead.
 */
export type RecordedBeadsJsonl =
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; path: string; via: 'noDatabase' | 'primary' | 'recorded'};

export function recordedBeadsJsonl(
  recordedBeadsDir: string,
): RecordedBeadsJsonl {
  const db = resolveRecordedBeadsDb(recordedBeadsDir);
  switch (db.kind) {
    case 'found':
      return {
        kind: 'found',
        path: join(db.beadsDir, BEADS_JSONL),
        via: db.via,
      };
    case 'none':
      return {
        kind: 'found',
        path: join(recordedBeadsDir, BEADS_JSONL),
        via: 'noDatabase',
      };
    case 'failed':
      return {
        kind: 'failed',
        reason: `which beads export holds the beads of ${recordedBeadsDir} could not be told: ${db.reason}`,
      };
  }
}
