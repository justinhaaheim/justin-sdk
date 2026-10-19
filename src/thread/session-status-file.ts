/**
 * Builds and writes the status-line file (status-file.ts) from what the
 * threads tooling knows about a session (decision D-STATUSLINE, epic
 * home-base-yukaf; home-base-yukaf.6).
 *
 * Two writers, one shape:
 *
 *   - the detached `thread capture --apply` child, after every prompt and every
 *     stop, loads the session model and writes `statusFromModel` of it;
 *   - `thread done` / `thread archive` write `statusAfterClose` from what they
 *     just closed, so the mark shows on the next render without waiting for a
 *     capture or for br's export to be re-read.
 *
 * AS IF YIELDED. The model's status is derived with `asIfYielded: true`, the
 * verdict `thread status` prints under "If you stop now the inbox will say".
 * The capture child runs at UserPromptSubmit and at Stop, when the transcript's
 * last record is seconds old; the inbox's own derivation would call that
 * "working" for three minutes, and the file is not rewritten until the next
 * prompt, so "working" would be what every idle window showed. Helpers still in
 * flight still count as working (deriveStatus F10).
 */

import type {EnvLike} from './paths';
import type {SessionModel} from './session-model';
import type {LocatedIssue} from './session-select';
import type {StatusFileWrite, ThreadStatusFile} from './status-file';

import {ARCHIVED_PREFIX, DONE_PREFIX} from './ask-format';
import {probeErrorMessage, threadsStateDir} from './paths';
import {deriveAction, sectionFor} from './session-card';
import {loadSession} from './session-model';
import {deriveStatus, statusCounts, statusFactsOf} from './session-status';
import {readStatusFile, writeStatusFile} from './status-file';

/** The status file's content for a loaded session. Pure. */
export function statusFromModel(
  model: SessionModel,
  now: Date,
): ThreadStatusFile {
  const facts = statusFactsOf(model);
  const status = deriveStatus(facts, {asIfYielded: true, now});
  const counts = statusCounts(model);
  // The successor's session id changes only the command an action prints,
  // never the rule, so the section does not need it.
  const action = deriveAction({model, status, successorSessionId: null});
  const closeReason = facts.sessionCloseReason;
  const archived = closeReason?.startsWith(ARCHIVED_PREFIX) === true;
  const markedDone = closeReason?.startsWith(DONE_PREFIX) === true;
  return {
    archived,
    at: now.toISOString(),
    closedRequests: facts.requests.closed,
    done: !archived && (markedDone || status.kind === 'done'),
    openP0: facts.openP0,
    openRequests: facts.requests.total - facts.requests.closed,
    section: sectionFor(action.rule, status, counts),
    statusWord: status.kind,
  };
}

/** What the capture child did about the status file, for its run record. */
export type StatusFileOutcome =
  | {error: string; kind: 'failed'; path: string | null}
  | {kind: 'skipped'; reason: string}
  | {kind: 'written'; path: string};

function fromWrite(write: StatusFileWrite): StatusFileOutcome {
  return write.kind === 'written'
    ? {kind: 'written', path: write.path}
    : {error: write.error, kind: 'failed', path: write.path};
}

/**
 * Load the session and write its status file. Never throws.
 *
 * A session with no session bead gets no file (the status line shows nothing
 * for an untracked session). A model that cannot be loaded leaves the last file
 * in place rather than overwriting it with a guess (rule 7); its `at` then ages
 * into the status line's "?".
 */
export async function writeStatusForSession(input: {
  cwd: string;
  env: EnvLike;
  /**
   * F13 (home-base-yukaf.14): the capture child passes true. Its write is
   * skipped when the file on disk carries an `at` newer than the moment this
   * call started (a `thread done` / `archive` wrote it while the slow load
   * ran), so a stale capture never undoes a mark. `thread unmark` passes
   * false: it is a deliberate reversal and always writes.
   */
  keepNewer: boolean;
  now: Date;
  sessionId: string;
}): Promise<StatusFileOutcome> {
  const startedAtMs = Date.now();
  try {
    const loaded = await loadSession({
      cwd: input.cwd,
      env: input.env,
      selector: null,
      sessionIdOption: input.sessionId,
    });
    if (loaded.kind === 'noSession') {
      return {kind: 'skipped', reason: loaded.reason};
    }
    if (loaded.kind === 'unreadable') {
      return {
        error: `the session could not be loaded, so the last status file was kept: ${loaded.detail}`,
        kind: 'failed',
        path: null,
      };
    }
    const stateDir = threadsStateDir(input.env);
    if (input.keepNewer) {
      // An unreadable or absent file is simply replaced: it is derived data.
      const existing = readStatusFile(stateDir, input.sessionId);
      const existingMs =
        existing.kind === 'read' ? Date.parse(existing.status.at) : Number.NaN;
      if (Number.isFinite(existingMs) && existingMs > startedAtMs) {
        return {
          kind: 'skipped',
          reason: `the status file was rewritten at ${existing.kind === 'read' ? existing.status.at : '?'}, after this capture started (${new Date(startedAtMs).toISOString()}), so it is kept (a thread done or archive wrote it)`,
        };
      }
    }
    return fromWrite(
      writeStatusFile(
        stateDir,
        input.sessionId,
        statusFromModel(loaded.model, input.now),
      ),
    );
  } catch (error) {
    return {
      error: `threw: ${probeErrorMessage(error)}`,
      kind: 'failed',
      path: null,
    };
  }
}

function isClosedStatus(status: string): boolean {
  return status === 'closed' || status === 'tombstone';
}

/**
 * The status file right after `thread done` / `thread archive` closed the
 * session bead. Counts come from the beads the mark read before closing plus
 * what it closed; released requests (adopted with `--bead`) are no longer this
 * session's and are not counted. Pure.
 */
export function statusAfterClose(input: {
  closedIds: ReadonlySet<string>;
  mode: 'archive' | 'done';
  now: Date;
  questions: readonly LocatedIssue[];
  releasedIds: ReadonlySet<string>;
  requests: readonly LocatedIssue[];
  sessionBeadId: string;
}): ThreadStatusFile {
  const closedNow = (entry: LocatedIssue): boolean =>
    isClosedStatus(entry.issue.status) || input.closedIds.has(entry.issue.id);
  const requests = input.requests.filter(
    (entry) =>
      entry.issue.id !== input.sessionBeadId &&
      !input.releasedIds.has(entry.issue.id),
  );
  const closedRequests = requests.filter(closedNow).length;
  return {
    archived: input.mode === 'archive',
    at: input.now.toISOString(),
    closedRequests,
    done: input.mode === 'done',
    openP0: input.questions.filter(
      (entry) =>
        entry.issue.id !== input.sessionBeadId &&
        !closedNow(entry) &&
        entry.issue.priority === 0,
    ).length,
    openRequests: requests.length - closedRequests,
    section: input.mode === 'archive' ? 'archived' : 'done',
    statusWord: 'done',
  };
}

/** Write `statusAfterClose` for a session. Never throws (writeStatusFile does not). */
export function writeStatusAfterClose(
  env: EnvLike,
  sessionId: string,
  status: ThreadStatusFile,
): StatusFileWrite {
  return writeStatusFile(threadsStateDir(env), sessionId, status);
}
