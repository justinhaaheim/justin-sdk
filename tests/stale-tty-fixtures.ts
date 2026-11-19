/**
 * home-base-ruaep.1: fake `-previous` layouts for the close and undo suites,
 * so no test reads cmux's real session files under ~/Library.
 */

import type {RestoredTtys} from '../src/thread/cmux-session-file';

export const FAKE_PREVIOUS_FILE =
  '/fake/cmux/session-com.cmuxterm.app-previous.json';

/** When the fake cmux last launched: 2026-11-17 21:36, local time. */
export const RESTART_AT_MS = new Date(2026, 10, 17, 21, 36).getTime();

/** Read, listing no tab: nothing was restored, so no tab is stale. */
export const NO_RESTORED_TTYS: RestoredTtys = {
  file: FAKE_PREVIOUS_FILE,
  kind: 'read',
  ttyByPanel: new Map(),
  writtenAtMs: RESTART_AT_MS,
};

/** Read, listing these surface ids with the tty each had at launch. */
export function restoredTtys(
  bySurfaceId: Record<string, string | null>,
): RestoredTtys {
  return {
    file: FAKE_PREVIOUS_FILE,
    kind: 'read',
    ttyByPanel: new Map(
      Object.entries(bySurfaceId).map(([id, tty]) => [id.toUpperCase(), tty]),
    ),
    writtenAtMs: RESTART_AT_MS,
  };
}

/** The file could not be parsed. */
export const UNREADABLE_PREVIOUS: RestoredTtys = {
  file: FAKE_PREVIOUS_FILE,
  kind: 'failed',
  reason: `could not read the cmux session file ${FAKE_PREVIOUS_FILE}: JSON Parse error: Unexpected EOF`,
};
