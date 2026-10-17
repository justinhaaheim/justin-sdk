/**
 * `thread request` and `thread title` (status report v4, epic
 * home-base-vzwbj.4 D1/D3; built by home-base-vzwbj.4.1).
 *
 * A REQUEST is a bead Justin asked for, marked `request` + `sid:<session id>`,
 * in_progress. Two forms:
 *
 *   thread request "<plain-words title>" [--done-when "<criteria>"]
 *       creates a task (P2) under the session bead, in the SESSION's beads DB
 *       (found through the sessions index), whatever the cwd.
 *   thread request --bead <id>
 *       adopts an existing bead: looked up in the session's DB, then in the
 *       cwd's; set in_progress and labelled where it is found. Never moved and
 *       never re-parented.
 *
 * TITLE RULE: while the session bead still carries `auto-title`, the FIRST
 * request renames the session to the request's title and drops the label.
 * Later requests never rename; `thread title` overrides at any time.
 *
 * WHICH DB (D1): writes go to the DB holding the session bead. When that
 * checkout is gone the command REFUSES, naming the path it expected; `--here`
 * files in the cwd's DB instead and records that DB in the index. It never
 * silently falls back.
 *
 * Exit: 0 filed · 1 refused or failed (a request that WAS filed but whose
 * follow-up write failed says so, by id) · 2 usage.
 */

import type {BeadsWorkspace, BrTarget} from '../beads/br';
import type {CmuxRunner} from './cmux';
import type {EnvLike} from './paths';
import type {SessionResolution} from './session-bead';

import {
  brCreate,
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
} from '../beads/br';
import {sdkRun} from '../sdk-invocation';
import {readMessageLog} from './message-log';
import {
  AUTO_TITLE_LABEL,
  REQUEST_LABEL,
  resolveSession,
  SESSION_BEAD_PRIORITY,
  sidLabel,
  sightingIn,
} from './session-bead';
import {linkContinuation} from './session-handoff';
import {appendSessionSighting, readSessionSightings} from './session-index';
import {sessionBeadsKnob, sessionIdFrom} from './session-select';
import {workspaceNameFollowUp} from './workspace-name-session';

export interface ThreadRequestOptions {
  /**
   * A hook payload's `agent_id`, present only for a subagent. The guard
   * `thread start` has: inside a subagent CLAUDE_CODE_SESSION_ID is the
   * PARENT's id (measured 2026-09-12), so a subagent's request would land under
   * its conductor's session. No env variable is a measured discriminant, so
   * this is only as strong as its caller.
   */
  agentId?: string | null;
  /** `--bead <id>`: adopt this bead instead of creating one. */
  bead: string | null;
  /** The cmux runner for the workspace-name follow-up; tests inject a fake. */
  cmux?: CmuxRunner;
  /**
   * `--continues <old session bead id>` (home-base-vzwbj.4.4): link this
   * session to the one it picks up from — `continues:<old>` on this session's
   * bead, `continued-by:<this>` on the old one. Alone (no title, no --bead) it
   * only links.
   */
  continues?: string | null;
  cwd?: string;
  /** `--done-when`: the new request's acceptance criteria. */
  doneWhen: string | null;
  env?: EnvLike;
  /** `--here`: file in the cwd's beads DB instead of the session's. */
  here: boolean;
  now?: Date;
  /** `--session`, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  /**
   * How long to wait for the session bead's index line before refusing
   * (home-base-vzwbj.4.9 P7): the capture hook's detached child files the bead
   * about half a second AFTER the first prompt, so a first-turn request can
   * race it. Default 3000 ms, polled every `sessionPollMs` (default 250).
   */
  sessionPollMs?: number;
  sessionWaitMs?: number;
  /** The plain-words title of a new request. */
  title: string | null;
}

/**
 * What adopting did to the bead's status (home-base-vzwbj.4.9 F1). `already`:
 * it was in_progress, so no status change was sent. `left`: br refused the
 * claim (`cannot claim blocked issue`), so only the labels were added.
 */
export type AdoptedStatus =
  | {from: string; kind: 'set'}
  | {kind: 'already'}
  | {blockers: string; kind: 'left'; status: string};

export type ThreadRequestOutcome =
  | {
      /** The session's checkout is gone and `--here` was not passed. */
      checkoutPath: string;
      kind: 'checkoutMissing';
    }
  | {
      /** Adopted beads only; null for a created request. */
      adoptedStatus: AdoptedStatus | null;
      /** `--continues`: the session this one now continues; null = not asked. */
      continued: {oldBeadId: string; oldTitle: string} | null;
      /** Problems AFTER the request was filed; non-empty means exit 1. */
      followUpFailures: string[];
      id: string;
      /** Where it lives: the checkout whose beads DB holds it. */
      inCheckout: string;
      kind: 'filed';
      mode: 'adopted' | 'created';
      /** Set when the title rule renamed the session bead. */
      renamedSession: {beadId: string; title: string} | null;
      title: string;
      /**
       * The workspace-name follow-up (home-base-j8q3e.5 D4 b): one soft line,
       * or null. Never a followUpFailure and never an exit-code change.
       */
      workspaceNote: string | null;
    }
  | {agentId: string; kind: 'subagent'}
  | {id: string; kind: 'notFound'; searched: string[]}
  | {kind: 'linked'; newBeadId: string; oldBeadId: string; oldTitle: string}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'noSession'; reason: string}
  | {kind: 'usage'; message: string};

/** Collapse whitespace: a bead title is one line. */
export function oneLineTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const CLAIM_REFUSAL = /cannot claim blocked issue:?\s*([^\n]*)/;

/**
 * The blockers br names when it refuses `--status=in_progress`, or null when
 * the failure is something else. Measured 2026-10-11: br 0.1.37 refuses a bead
 * with OPEN CHILDREN ("Validation failed: claim: cannot claim blocked issue:
 * u-86g.1", exit 4) and br 0.5.12 one with an open `blocks` dependency, with
 * the same words; both refusals are atomic (the labels in the same call are
 * not written either).
 */
export function claimRefusalBlockers(failureText: string): string | null {
  const match = CLAIM_REFUSAL.exec(failureText);
  if (match == null) return null;
  const blockers = (match[1] ?? '').trim();
  return blockers === '' ? 'unnamed' : blockers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * F13 (home-base-vzwbj.4.9): P7's wait is for ONE race — the capture child
 * filing the session bead ~0.5 s after the first prompt. Only a first prompt
 * logged this recently can still be in that race.
 */
export const SESSION_BEAD_RACE_WINDOW_MS = 30_000;

/**
 * Whether a missing session bead may still be on its way: the session's first
 * user line in the message log is younger than SESSION_BEAD_RACE_WINDOW_MS.
 * Anything else — no log (capture never ran: the knob was off, say), an
 * unreadable log, an old first prompt — refuses at once, and says why.
 */
function raceStillOpen(
  sessionId: string,
  env: EnvLike,
  now: Date,
): {open: false; why: string} | {open: true} {
  const log = readMessageLog(sessionId, env);
  if (log.kind === 'missing') {
    return {
      open: false,
      why: 'this session has no message log, so the capture hook has not run for it',
    };
  }
  if (log.kind === 'failed') {
    return {
      open: false,
      why: `its message log could not be read (${log.error})`,
    };
  }
  const first = log.lines.find((line) => line.role === 'user');
  const at = first?.at == null ? Number.NaN : Date.parse(first.at);
  if (Number.isNaN(at)) {
    return {open: false, why: 'its message log has no dated first prompt'};
  }
  const age = now.getTime() - at;
  if (age >= 0 && age < SESSION_BEAD_RACE_WINDOW_MS) return {open: true};
  return {
    open: false,
    why: `the first prompt was logged ${Math.round(age / 1000)} s ago, so the capture hook has had its chance`,
  };
}

/**
 * resolveSession, waiting up to `waitMs` for a session bead the index does not
 * name yet (P7: the capture child files it ~0.5 s after the first prompt).
 * Only `none` is retried: `failed` and `checkoutMissing` are answers.
 */
async function resolveSessionWaiting(input: {
  env: EnvLike;
  pollMs: number;
  sessionId: string;
  waitMs: number;
}): Promise<SessionResolution> {
  const deadline = Date.now() + input.waitMs;
  let resolution = resolveSession(input);
  while (resolution.kind === 'none' && Date.now() < deadline) {
    await sleep(Math.max(1, Math.min(input.pollMs, deadline - Date.now())));
    resolution = resolveSession(input);
  }
  return resolution;
}

type Usable =
  | Extract<SessionResolution, {kind: 'checkoutMissing'}>
  | Extract<SessionResolution, {kind: 'found'}>;

/** Refusals shared by `thread request` and `thread title`. */
function refuseResolution(
  resolution: SessionResolution,
  here: boolean,
):
  | {checkoutPath: string; kind: 'checkoutMissing'}
  | {kind: 'failed'; reason: string}
  | {kind: 'noSession'; reason: string}
  | null {
  if (resolution.kind === 'failed') {
    return {kind: 'failed', reason: resolution.reason};
  }
  if (resolution.kind === 'none') {
    return {kind: 'noSession', reason: resolution.reason};
  }
  if (resolution.kind === 'checkoutMissing' && !here) {
    return {checkoutPath: resolution.checkoutPath, kind: 'checkoutMissing'};
  }
  return null;
}

/** The decision half of `thread request`: writes beads, prints nothing. */
export async function fileRequest(
  options: ThreadRequestOptions,
): Promise<ThreadRequestOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();

  if (options.agentId != null && options.agentId !== '') {
    return {agentId: options.agentId, kind: 'subagent'};
  }
  const title = options.title != null ? oneLineTitle(options.title) : null;
  const beadId = options.bead != null ? options.bead.trim() : null;
  const continues =
    options.continues != null && options.continues.trim() !== ''
      ? options.continues.trim()
      : null;
  const noTitle = title == null || title === '';
  const noBead = beadId == null || beadId === '';
  const linkOnly = continues != null && noTitle && noBead;
  if (!linkOnly && noTitle === noBead) {
    return {
      kind: 'usage',
      message:
        'give exactly one of: a request title (thread request "fix the login bug") or --bead <id> (or only --continues <old session bead id> to link this session to the one it picks up from)',
    };
  }
  if (linkOnly && options.doneWhen != null) {
    return {
      kind: 'usage',
      message: '--done-when applies only when creating a request',
    };
  }
  if (beadId != null && options.doneWhen != null) {
    return {
      kind: 'usage',
      message:
        '--done-when applies only when creating a request; an adopted bead keeps its own acceptance criteria',
    };
  }

  const session = sessionIdFrom(options.sessionId, env);
  if (!session.ok) return {kind: 'noSession', reason: session.reason};
  const sessionId = session.id;

  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};

  // F13: the wait is only for a first prompt young enough to still be racing
  // the capture child; otherwise a missing bead is refused at once.
  const race = raceStillOpen(sessionId, env, now);
  const waitMs = race.open ? (options.sessionWaitMs ?? 3000) : 0;
  const resolution = await resolveSessionWaiting({
    env,
    pollMs: options.sessionPollMs ?? 250,
    sessionId,
    waitMs,
  });
  if (resolution.kind === 'none') {
    // P7: the likeliest cause in a live session is the race, so it is named
    // first; the knob is the second thing to check, not the verdict.
    const waited = race.open
      ? `waited ${(waitMs / 1000).toFixed(1)} s`
      : `not waited for: ${race.why}`;
    return {
      kind: 'noSession',
      reason: [
        `no session bead yet — the capture hook files it a moment after the first prompt (${waited}); retry, or check componentConfig.thread.sessionBeads.`,
        ...(resolution.corruptNote != null ? [resolution.corruptNote] : []),
        `(sessions index: ${resolution.indexPath}; the capture outcome is in capture.jsonl beside it)`,
      ].join(' '),
    };
  }
  const refusal = refuseResolution(resolution, options.here);
  if (refusal != null) return refusal;
  const usable = resolution as Usable;
  const sessionDb = usable.kind === 'found' ? usable.db : null;

  // ---- --continues alone: link, file nothing ----
  if (linkOnly) {
    if (usable.kind !== 'found') {
      return {checkoutPath: usable.checkoutPath, kind: 'checkoutMissing'};
    }
    const linked = linkContinuation({
      cwd,
      env,
      newSession: {beadId: usable.bead.id, db: usable.db},
      oldBeadId: continues,
    });
    return linked;
  }

  // The cwd's workspace, needed for --here and as the second place --bead
  // looks. Measured lazily: a plain request from the session's own checkout
  // never needs it.
  let cwdWorkspace: BeadsWorkspace | null = null;
  const cwdSpace = (): BeadsWorkspace =>
    (cwdWorkspace ??= findBeadsWorkspace(cwd));

  // Which DBs the index already names for this session, so a new one is
  // recorded exactly once.
  const known = readSessionSightings(sessionId, env);
  const knownDirs = new Set(
    known.kind === 'read' ? known.sightings.map((entry) => entry.beadsDir) : [],
  );

  let target: {beadsDir: string; db: string; root: string};
  let mode: 'adopted' | 'created';
  let filedId: string;
  let filedTitle: string;
  let adoptedStatus: AdoptedStatus | null = null;
  const followUpFailures: string[] = [];

  if (title != null && title !== '') {
    // ---- create ----
    if (options.here || usable.kind === 'checkoutMissing') {
      const space = cwdSpace();
      if (space.kind !== 'found') {
        return {
          kind: 'failed',
          reason: `--here: the current directory has no beads workspace (${space.reason})`,
        };
      }
      target = space;
    } else {
      target = {
        beadsDir: usable.beadsDir,
        db: usable.db,
        root: usable.checkoutPath,
      };
    }
    // The parent can only be the session bead when the request lands in the
    // session bead's own DB: `br create --parent` refuses an id it cannot find
    // there (verified 2026-10-11).
    const parent =
      usable.kind === 'found' && target.db === sessionDb
        ? usable.bead.id
        : null;
    const created = brCreate(
      {db: target.db, env},
      {
        labels: [REQUEST_LABEL, sidLabel(sessionId)],
        parent,
        priority: SESSION_BEAD_PRIORITY,
        status: 'in_progress',
        title,
        type: 'task',
      },
    );
    if (created.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `br create failed, nothing was filed: ${describeBrFailed(created)}`,
      };
    }
    filedId = created.id;
    filedTitle = title;
    mode = 'created';
    if (options.doneWhen != null && options.doneWhen.trim() !== '') {
      const criteria = brUpdate({db: target.db, env}, filedId, {
        acceptanceCriteria: options.doneWhen.trim(),
      });
      if (criteria.kind === 'failed') {
        followUpFailures.push(
          `the acceptance criteria (--done-when) were NOT set: ${describeBrFailed(criteria)}`,
        );
      }
    }
  } else {
    // ---- adopt ----
    const id = beadId ?? '';
    const places: {beadsDir: string; db: string; root: string}[] = [];
    if (!options.here && usable.kind === 'found') {
      places.push({
        beadsDir: usable.beadsDir,
        db: usable.db,
        root: usable.checkoutPath,
      });
    }
    const space = cwdSpace();
    if (space.kind === 'found' && !places.some((p) => p.db === space.db)) {
      places.push(space);
    }
    if (places.length === 0) {
      return {
        kind: 'failed',
        reason:
          space.kind === 'found'
            ? 'no beads DB to look in'
            : `--here: the current directory has no beads workspace (${space.reason})`,
      };
    }
    let found: {
      place: {beadsDir: string; db: string; root: string};
      status: string;
      title: string;
    } | null = null;
    for (const place of places) {
      const shown = brShow({db: place.db, env}, id);
      if (shown.kind === 'failed') {
        // Could not look: a "not here" guess could adopt the wrong bead from
        // the next DB, so this stops (rule 7).
        return {
          kind: 'failed',
          reason: `could not look up ${id} in ${place.db}: ${describeBrFailed(shown)}`,
        };
      }
      if (shown.kind === 'ok') {
        found = {place, status: shown.issue.status, title: shown.issue.title};
        break;
      }
    }
    if (found == null) {
      return {id, kind: 'notFound', searched: places.map((p) => p.db)};
    }
    // F1 (home-base-vzwbj.4.9): the status change is sent only when the bead
    // is not already in_progress, and a claim br refuses (a bead it counts as
    // blocked: br 0.1.37 counts open children) still adopts — labels only.
    const labels = [REQUEST_LABEL, sidLabel(sessionId)];
    const foundDb = found.place.db;
    const labelOnly = (): ReturnType<typeof brUpdate> =>
      brUpdate({db: foundDb, env}, id, {addLabels: labels});
    let adopted: ReturnType<typeof brUpdate>;
    if (found.status === 'in_progress') {
      adopted = labelOnly();
      adoptedStatus = {kind: 'already'};
    } else {
      adopted = brUpdate({db: foundDb, env}, id, {
        addLabels: labels,
        status: 'in_progress',
      });
      adoptedStatus = {from: found.status, kind: 'set'};
      const blockers =
        adopted.kind === 'failed'
          ? claimRefusalBlockers(describeBrFailed(adopted))
          : null;
      if (blockers != null) {
        adopted = labelOnly();
        adoptedStatus = {blockers, kind: 'left', status: found.status};
      }
    }
    if (adopted.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `br update failed, ${id} was NOT adopted: ${describeBrFailed(adopted)}`,
      };
    }
    target = found.place;
    filedId = id;
    filedTitle = found.title;
    mode = 'adopted';
  }

  // ---- the index: a DB new to this session gets one sighting ----
  if (!knownDirs.has(target.beadsDir)) {
    const recorded = appendSessionSighting(
      sightingIn('adopted-in', filedId, target, sessionId, now),
      env,
    );
    if (recorded.kind === 'failed') {
      followUpFailures.push(
        `the sessions index was NOT told about ${target.beadsDir} (${recorded.error}); thread readers will not see ${filedId}`,
      );
    }
  }

  // ---- the title rule ----
  let renamedSession: {beadId: string; title: string} | null = null;
  if (
    usable.kind === 'found' &&
    usable.bead.labels.includes(AUTO_TITLE_LABEL)
  ) {
    const renamed = brUpdate({db: usable.db, env}, usable.bead.id, {
      removeLabels: [AUTO_TITLE_LABEL],
      title: filedTitle,
    });
    if (renamed.kind === 'failed') {
      followUpFailures.push(
        `the session bead ${usable.bead.id} was NOT renamed: ${describeBrFailed(renamed)}. Retry with ${sdkRun('thread title "…"')}`,
      );
    } else {
      renamedSession = {beadId: usable.bead.id, title: filedTitle};
    }
  }
  const workspaceNote =
    renamedSession != null
      ? await workspaceNameFollowUp({cwd, env, run: options.cmux, sessionId})
      : null;

  // ---- --continues with a request: link after filing ----
  let continued: {oldBeadId: string; oldTitle: string} | null = null;
  if (continues != null) {
    if (usable.kind !== 'found') {
      followUpFailures.push(
        `this session was NOT linked to ${continues}: its session bead's checkout is gone`,
      );
    } else {
      const linked = linkContinuation({
        cwd,
        env,
        newSession: {beadId: usable.bead.id, db: usable.db},
        oldBeadId: continues,
      });
      if (linked.kind === 'failed') {
        followUpFailures.push(
          `this session was NOT linked to ${continues}: ${linked.reason}`,
        );
      } else {
        continued = {oldBeadId: linked.oldBeadId, oldTitle: linked.oldTitle};
      }
    }
  }

  return {
    adoptedStatus,
    continued,
    followUpFailures,
    id: filedId,
    inCheckout: target.root,
    kind: 'filed',
    mode,
    renamedSession,
    title: filedTitle,
    workspaceNote,
  };
}

/** The lines a request outcome prints, and its exit code. */
export function describeRequestOutcome(outcome: ThreadRequestOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'filed': {
      const lines = [
        `request ${outcome.id} · ${outcome.title}${outcome.mode === 'adopted' ? ' (adopted)' : ''}`,
        `  in ${outcome.inCheckout}`,
      ];
      if (outcome.adoptedStatus?.kind === 'already') {
        lines.push(`  adopted; status already in_progress, left as it was`);
      } else if (outcome.adoptedStatus?.kind === 'left') {
        lines.push(
          `  adopted; status left ${outcome.adoptedStatus.status}: br refuses to claim a blocked issue (blocked by: ${outcome.adoptedStatus.blockers}; br 0.1.37 counts open children as blockers). The request and sid labels are on it.`,
        );
      }
      if (outcome.renamedSession != null) {
        lines.push(
          `session ${outcome.renamedSession.beadId} renamed: "${outcome.renamedSession.title}"`,
        );
      }
      if (outcome.workspaceNote != null) {
        lines.push(`  ${outcome.workspaceNote}`);
      }
      if (outcome.continued != null) {
        lines.push(
          `this session continues ${outcome.continued.oldBeadId} ("${outcome.continued.oldTitle}")`,
        );
      }
      if (outcome.followUpFailures.length > 0) {
        lines.push(
          `⚠️ ${outcome.id} WAS filed — do not file it again. But:`,
          ...outcome.followUpFailures.map((failure) => `  - ${failure}`),
        );
        return {exitCode: 1, lines};
      }
      return {exitCode: 0, lines};
    }
    case 'checkoutMissing':
      return {
        exitCode: 1,
        lines: [
          `thread request: refused — this session's beads live in ${outcome.checkoutPath}, which no longer exists (or no longer holds a beads database).`,
          `  Run it again with --here to file in the current directory's beads instead (that DB is then recorded for this session).`,
        ],
      };
    case 'notFound':
      return {
        exitCode: 1,
        lines: [
          `thread request: ${outcome.id} was not found in ${outcome.searched.join(' or ')}.`,
        ],
      };
    case 'linked':
      return {
        exitCode: 0,
        lines: [
          `session ${outcome.newBeadId} continues ${outcome.oldBeadId} ("${outcome.oldTitle}")`,
          `  labels: continues:${outcome.oldBeadId} here, continued-by:${outcome.newBeadId} there`,
        ],
      };
    case 'subagent':
      return {
        exitCode: 1,
        lines: [
          `thread request: refused — this is a subagent (agent_id=${outcome.agentId}); requests belong to the session that dispatched it.`,
        ],
      };
    case 'disabled':
    case 'failed':
    case 'noSession':
      return {exitCode: 1, lines: [`thread request: ${outcome.reason}`]};
    case 'usage':
      return {exitCode: 2, lines: [`thread request: ${outcome.message}`]};
  }
}

/** `thread request`: file or adopt, print, return the exit code. */
export async function runThreadRequest(
  options: ThreadRequestOptions,
): Promise<number> {
  const {exitCode, lines} = describeRequestOutcome(await fileRequest(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}

// ---------------------------------------------------------------------------
// thread title
// ---------------------------------------------------------------------------

export interface ThreadTitleOptions {
  agentId?: string | null;
  /** The cmux runner for the workspace-name follow-up; tests inject a fake. */
  cmux?: CmuxRunner;
  cwd?: string;
  env?: EnvLike;
  sessionId: string | null;
  title: string | null;
}

export type ThreadTitleOutcome =
  | {agentId: string; kind: 'subagent'}
  | {
      beadId: string;
      kind: 'renamed';
      title: string;
      /** The workspace-name follow-up (D4 b); never changes the exit code. */
      workspaceNote: string | null;
    }
  | {checkoutPath: string; kind: 'checkoutMissing'}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'noSession'; reason: string}
  | {kind: 'usage'; message: string};

/** Rename the session bead and drop `auto-title`. Prints nothing. */
export async function renameSession(
  options: ThreadTitleOptions,
): Promise<ThreadTitleOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.agentId != null && options.agentId !== '') {
    return {agentId: options.agentId, kind: 'subagent'};
  }
  const title = options.title != null ? oneLineTitle(options.title) : '';
  if (title === '') {
    return {kind: 'usage', message: 'give the new title: thread title "…"'};
  }
  const session = sessionIdFrom(options.sessionId, env);
  if (!session.ok) return {kind: 'noSession', reason: session.reason};
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};
  const resolution = resolveSession({env, sessionId: session.id});
  const refusal = refuseResolution(resolution, false);
  if (refusal != null) return refusal;
  const found = resolution as Extract<SessionResolution, {kind: 'found'}>;
  const target: BrTarget = {db: found.db, env};
  const renamed = brUpdate(target, found.bead.id, {
    removeLabels: [AUTO_TITLE_LABEL],
    title,
  });
  if (renamed.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `br update failed, the title is unchanged: ${describeBrFailed(renamed)}`,
    };
  }
  const workspaceNote = await workspaceNameFollowUp({
    cwd,
    env,
    run: options.cmux,
    sessionId: session.id,
  });
  return {beadId: found.bead.id, kind: 'renamed', title, workspaceNote};
}

export function describeTitleOutcome(outcome: ThreadTitleOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'renamed':
      return {
        exitCode: 0,
        lines: [
          `session ${outcome.beadId} · ${outcome.title}`,
          ...(outcome.workspaceNote != null
            ? [`  ${outcome.workspaceNote}`]
            : []),
        ],
      };
    case 'checkoutMissing':
      return {
        exitCode: 1,
        lines: [
          `thread title: refused — this session's beads live in ${outcome.checkoutPath}, which no longer exists (or no longer holds a beads database).`,
        ],
      };
    case 'subagent':
      return {
        exitCode: 1,
        lines: [
          `thread title: refused — this is a subagent (agent_id=${outcome.agentId}).`,
        ],
      };
    case 'disabled':
    case 'failed':
    case 'noSession':
      return {exitCode: 1, lines: [`thread title: ${outcome.reason}`]};
    case 'usage':
      return {exitCode: 2, lines: [`thread title: ${outcome.message}`]};
  }
}

/** `thread title`: rename, print, return the exit code. */
export async function runThreadTitle(
  options: ThreadTitleOptions,
): Promise<number> {
  const {exitCode, lines} = describeTitleOutcome(await renameSession(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
