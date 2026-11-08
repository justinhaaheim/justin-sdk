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
 *   thread request --continues <old session bead id>
 *       picks up a handoff (handoff-pickup.ts, home-base-npbse.1.1) under the
 *       per-session lock the capture child uses. With a title or --bead it
 *       files that request first.
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
 * Exit: 0 filed, or the pickup is done or had nothing to do · 1 refused or
 * failed (a request that WAS filed but whose follow-up write failed says so, by
 * id; a pickup step that failed is named, and running the same command again
 * finishes it) · 2 usage, or the pickup found that another session already
 * continues that one (not-a-successor), or that this session already continues
 * another one (already-continues).
 */

import type {BeadsWorkspace, BrTarget} from '../beads/br';
import type {CmuxRunner} from './cmux';
import type {PickUpDeps, PickUpOutcome} from './handoff-pickup';
import type {ChainRequestReaders} from './overarching';
import type {EnvLike} from './paths';
import type {AdoptedStatus} from './request-writes';
import type {SessionResolution} from './session-bead';
import type {SessionBeadRepair} from './session-repair';

import {
  brCreate,
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {sdkRun} from '../sdk-invocation';
import {carriedLines, describePickUp, pickUpHandoff} from './handoff-pickup';
import {
  chainRequestList,
  isOverarching,
  overarchingMarkEdit,
  overarchingUnmarkEdit,
  pickOverarching,
  readChainRequests,
  realChainRequestReaders,
} from './overarching';
import {adoptBead, titleSetEdit} from './request-writes';
import {
  AUTO_TITLE_LABEL,
  CONTINUES_LABEL_PREFIX,
  REQUEST_LABEL,
  resolveSession,
  SESSION_BEAD_PRIORITY,
  sidLabel,
  sightingIn,
} from './session-bead';
import {appendSessionSighting, readSessionSightings} from './session-index';
import {
  raceStillOpen,
  repairMissingSessionBead,
  repairRefusalNote,
} from './session-repair';
import {sessionBeadsKnob, sessionIdFrom} from './session-select';
import {
  checkShortText,
  shortLabelEdit,
  shortLabelOf,
  staleShortLabels,
} from './short-label';
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
  /**
   * How the chain's requests are read for `--overarching` (home-base-jm5kg.5
   * D1); tests inject fixtures. Default: the sessions index, br and exports.
   */
  chainReaders?: ChainRequestReaders;
  /** The cmux runner for the workspace-name follow-up; tests inject a fake. */
  cmux?: CmuxRunner;
  /**
   * `--continues <old session bead id>`: pick up the handoff from that session
   * (handoff-pickup.ts, home-base-npbse.1.1). Alone (no title, no --bead) it
   * files nothing of its own.
   */
  continues?: string | null;
  cwd?: string;
  /** `--done-when`: the new request's acceptance criteria. */
  doneWhen: string | null;
  env?: EnvLike;
  /** `--here`: file in the cwd's beads DB instead of the session's. */
  here: boolean;
  now?: Date;
  /**
   * `--overarching` (home-base-jm5kg.5 D1): mark the filed or adopted request
   * as the overarching request of this session and the sessions it
   * continues, unmark every other one there, and give the session its title
   * (D2).
   */
  overarching?: boolean;
  /** What the pickup calls outside itself; tests inject failures. */
  pickupDeps?: Partial<PickUpDeps>;
  /**
   * How long `--continues` waits for the per-session lock before it fails,
   * naming the step. Default 30000 ms, polled every `pickupLockPollMs` (default
   * 250). A capture child holds the lock for seconds, and the capture lock
   * itself never waits (capture.ts).
   */
  pickupLockPollMs?: number;
  pickupLockWaitMs?: number;
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
  /**
   * `--short` (home-base-jm5kg.18): the request's short label, 2 to 5 words,
   * like a compact commit message. On a new request or with --bead, with or
   * without --overarching.
   */
  short?: string | null;
  /** The plain-words title of a new request. */
  title: string | null;
}

/** What `--overarching` did (home-base-jm5kg.5 D1). */
export interface OverarchingMarked {
  /** The request now marked overarching. */
  id: string;
  /** Requests of the chain that were marked before, and are not now. */
  unmarked: string[];
}

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
      /** `--overarching`: what was marked and unmarked; null = not asked. */
      overarching: OverarchingMarked | null;
      /** What `--continues` did; null = not asked. */
      pickup: PickUpOutcome | null;
      /** Set when the title rule renamed the session bead. */
      renamedSession: {beadId: string; title: string} | null;
      /**
       * home-base-4ay2j: this command filed or re-indexed the session bead the
       * capture hook had failed to file; null when it was already there.
       */
      repair: Extract<SessionBeadRepair, {kind: 'repaired'}> | null;
      /** `--short`: the short label it now carries; null = not asked or failed. */
      short: string | null;
      title: string;
      /**
       * The workspace-name follow-up (home-base-j8q3e.5 D4 b): one soft line,
       * or null. Never a followUpFailure and never an exit-code change.
       */
      workspaceNote: string | null;
    }
  | {agentId: string; kind: 'subagent'}
  | {id: string; kind: 'notFound'; searched: string[]}
  /** `--continues` alone: the pickup's outcome, and the command that re-runs it. */
  | {kind: 'handoffPickup'; pickup: PickUpOutcome; retryCommand: string}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'noSession'; reason: string}
  | {kind: 'usage'; message: string};

/** Collapse whitespace: a bead title is one line. */
export function oneLineTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * pickUpHandoff under the capture child's per-session lock, so the two callers
 * serialize rather than interleave: linkContinuation alone is two separate br
 * writes, and repeatability does not cover two writers between them. The lock
 * itself never waits, so this polls it, and a lock it cannot get is a failed
 * step that wrote nothing. A capture child that finds the lock held here defers
 * to the next one, whose pass applies the log's tail (capture.ts's convergence
 * argument).
 *
 * capture.ts is imported here, not at the top: home-base-npbse.1.2 has it import
 * handoff-pickup.ts, and a `thread request` that only files needs none of it.
 */
async function pickUpUnderLock(input: {
  continues: string;
  cwd: string;
  deps: Partial<PickUpDeps>;
  env: EnvLike;
  now: Date | undefined;
  pollMs: number;
  session: Extract<SessionResolution, {kind: 'found'}>;
  sessionId: string;
  waitMs: number;
}): Promise<PickUpOutcome> {
  const {env, sessionId} = input;
  const {releaseCaptureLock, tryCaptureLock} = await import('./capture');
  const deadline = Date.now() + input.waitMs;
  while (!tryCaptureLock(sessionId, env)) {
    if (Date.now() >= deadline) {
      return {
        done: {
          alreadyHeld: {questions: [], requests: []},
          carried: {questions: [], requests: []},
          link: null,
          pickedUpLabelled: false,
          renamedSession: null,
          workspaceNote: null,
        },
        kind: 'failed',
        reason: `another process held this session's lock for ${Math.round(input.waitMs / 1000)} s, or the lock could not be taken, so nothing was written`,
        step: 'lock',
      };
    }
    await sleep(Math.max(1, Math.min(input.pollMs, deadline - Date.now())));
  }
  try {
    return await pickUpHandoff(
      {
        cwd: input.cwd,
        env,
        ...(input.now != null ? {now: input.now} : {}),
        predecessorBeadId: input.continues,
        successor: {
          beadId: input.session.bead.id,
          db: input.session.db,
          sessionId,
        },
      },
      input.deps,
    );
  } finally {
    releaseCaptureLock(sessionId, env);
  }
}

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

/**
 * home-base-jm5kg.5 D1/D2: mark `filed` overarching, give the session its
 * title, and unmark every other request of the chain. Marked FIRST, so a
 * failure later leaves two marks (the newest wins, and thread status names
 * the other) rather than none. Every failure is said, with its retry.
 */
async function markOverarching(input: {
  chainReaders: ChainRequestReaders | undefined;
  continued: {oldBeadId: string; oldTitle: string} | null;
  cwd: string;
  env: EnvLike;
  filed: {db: string; id: string; labels: readonly string[]; title: string};
  now: Date | undefined;
  renamedSession: {beadId: string; title: string} | null;
  session: Usable;
}): Promise<{
  failures: string[];
  overarching: OverarchingMarked | null;
  renamedSession: {beadId: string; title: string} | null;
}> {
  const {env, filed} = input;
  const failures: string[] = [];
  const retry = sdkRun(`thread request --overarching --bead ${filed.id}`);
  const mark = brUpdate(
    {db: filed.db, env},
    filed.id,
    overarchingMarkEdit(filed.labels, input.now ?? new Date()),
  );
  if (mark.kind === 'failed') {
    failures.push(
      `${filed.id} was NOT marked overarching: ${describeBrFailed(mark)}. Retry with ${retry}`,
    );
    return {failures, overarching: null, renamedSession: input.renamedSession};
  }
  let renamedSession = input.renamedSession;
  const {session} = input;
  if (session.kind !== 'found') {
    failures.push(
      `the session title was NOT set to "${filed.title}": the session bead's checkout is gone`,
    );
    return {
      failures,
      overarching: {id: filed.id, unmarked: []},
      renamedSession,
    };
  }
  // D2: the session title IS the overarching request's title.
  const currentTitle = renamedSession?.title ?? session.bead.title;
  const autoTitled =
    renamedSession == null && session.bead.labels.includes(AUTO_TITLE_LABEL);
  if (currentTitle !== filed.title || autoTitled) {
    const stamp = await titleSetEdit({
      cwd: input.cwd,
      env,
      labels: session.bead.labels,
      now: input.now,
    });
    const renamed = brUpdate({db: session.db, env}, session.bead.id, {
      addLabels: stamp.addLabels,
      removeLabels: [AUTO_TITLE_LABEL, ...stamp.removeLabels],
      title: filed.title,
    });
    if (renamed.kind === 'failed') {
      failures.push(
        `the session bead ${session.bead.id} was NOT titled "${filed.title}": ${describeBrFailed(renamed)}. Retry with ${retry}`,
      );
    } else {
      renamedSession = {beadId: session.bead.id, title: filed.title};
    }
  }
  // D1: at most one per chain. The chain is read from the session bead's
  // labels as they are now (a link made just above is not in `bead` yet).
  const labels = [
    ...session.bead.labels,
    ...(input.continued != null
      ? [`${CONTINUES_LABEL_PREFIX}${input.continued.oldBeadId}`]
      : []),
  ];
  const chain = readChainRequests(
    {id: session.bead.id, labels, title: currentTitle},
    input.chainReaders ?? realChainRequestReaders({cwd: input.cwd, env}),
  );
  const unmarked: string[] = [];
  if (chain.kind === 'failed') {
    failures.push(
      `no earlier overarching request was unmarked, because the requests of this session and the sessions it continues could not be read (${chain.reason}). Run ${retry} again once they can be`,
    );
    return {failures, overarching: {id: filed.id, unmarked}, renamedSession};
  }
  for (const request of chainRequestList(chain)) {
    if (request.id === filed.id || !isOverarching(request)) continue;
    const db = resolveRecordedBeadsDb(request.beadsDir);
    if (db.kind !== 'found') {
      failures.push(
        `${request.id} is still marked overarching: its beads DB (${request.beadsDir}) could not be found${db.kind === 'failed' ? ` (${db.reason})` : ''}`,
      );
      continue;
    }
    const cleared = brUpdate(
      {db: db.db, env},
      request.id,
      overarchingUnmarkEdit(request.labels),
    );
    if (cleared.kind === 'failed') {
      failures.push(
        `${request.id} is still marked overarching: ${describeBrFailed(cleared)}. Retry with ${retry}`,
      );
    } else {
      unmarked.push(request.id);
    }
  }
  return {failures, overarching: {id: filed.id, unmarked}, renamedSession};
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
        'give exactly one of: a request title (thread request "fix the login bug") or --bead <id> (or only --continues <old session bead id> to pick up the handoff from that session)',
    };
  }
  if (linkOnly && options.overarching === true) {
    return {
      kind: 'usage',
      message:
        '--overarching marks a request: give its title (thread request --overarching "…") or --bead <request id>',
    };
  }
  if (linkOnly && options.doneWhen != null) {
    return {
      kind: 'usage',
      message: '--done-when applies only when creating a request',
    };
  }
  if (linkOnly && options.short != null) {
    return {
      kind: 'usage',
      message:
        '--short labels a request: give its title (thread request --short "…" "…") or --bead <request id>',
    };
  }
  let short: string | null = null;
  if (options.short != null) {
    const checked = checkShortText(options.short);
    if (!checked.ok) return {kind: 'usage', message: checked.reason};
    short = checked.text;
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
  let resolution = await resolveSessionWaiting({
    env,
    pollMs: options.sessionPollMs ?? 250,
    sessionId,
    waitMs,
  });
  // home-base-4ay2j D1: past the race, a bead the capture hook failed to file
  // is filed (or re-indexed) here, once, under the capture lock (D3).
  let repair: Extract<SessionBeadRepair, {kind: 'repaired'}> | null = null;
  let repairNote: string | null = null;
  if (resolution.kind === 'none') {
    const attempted = await repairMissingSessionBead({
      by: 'thread request',
      cwd,
      env,
      now,
      sessionId,
    });
    if (attempted.kind === 'repaired') {
      repair = attempted;
      resolution = resolveSession({env, sessionId});
      repairNote = attempted.line;
    } else {
      repairNote = repairRefusalNote(attempted);
    }
  }
  if (resolution.kind === 'none') {
    // P7: the likeliest cause in a live session is the race, so it is named
    // first; the knob is the second thing to check, not the verdict.
    const waited = race.open
      ? `waited ${(waitMs / 1000).toFixed(1)} s`
      : `not waited for: ${race.why}`;
    // Retrying never helps a session that has only been sent `!` commands.
    const next =
      !race.open && race.noLog
        ? 'send this session a message first (a `!` command is not one), then run this again; if it has had one, check componentConfig.thread.sessionBeads.'
        : 'retry, or check componentConfig.thread.sessionBeads.';
    return {
      kind: 'noSession',
      reason: [
        `no session bead yet — the capture hook files it a moment after the first prompt (${waited}); ${next}`,
        ...(repairNote != null ? [repairNote] : []),
        ...(resolution.corruptNote != null ? [resolution.corruptNote] : []),
        `(sessions index: ${resolution.indexPath}; the capture outcome is in capture.jsonl beside it)`,
      ].join(' '),
    };
  }
  const refusal = refuseResolution(resolution, options.here);
  if (refusal != null) {
    // A bead this command just filed is said even when the next step refused.
    return repair != null && refusal.kind !== 'checkoutMissing'
      ? {...refusal, reason: `${refusal.reason} (${repair.line})`}
      : refusal;
  }
  const usable = resolution as Usable;
  const sessionDb = usable.kind === 'found' ? usable.db : null;

  // ---- the pickup: `--continues` alone runs only this; with a title or --bead
  // it runs after the request is filed ----
  const pickUp = async (
    found: Extract<SessionResolution, {kind: 'found'}>,
    syncNames: PickUpDeps['syncNames'],
  ): Promise<PickUpOutcome> =>
    await pickUpUnderLock({
      continues: continues ?? '',
      cwd,
      deps: {syncNames, ...options.pickupDeps},
      env,
      now: options.now,
      pollMs: options.pickupLockPollMs ?? 250,
      session: found,
      sessionId,
      waitMs: options.pickupLockWaitMs ?? 30_000,
    });
  const retryCommand = sdkRun(`thread request --continues ${continues ?? ''}`);

  if (linkOnly) {
    if (usable.kind !== 'found') {
      return {checkoutPath: usable.checkoutPath, kind: 'checkoutMissing'};
    }
    return {
      kind: 'handoffPickup',
      pickup: await pickUp(usable, (names) =>
        workspaceNameFollowUp({...names, run: options.cmux}),
      ),
      retryCommand,
    };
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
  let filedLabels: string[];
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
    const newLabels = [
      REQUEST_LABEL,
      sidLabel(sessionId),
      ...(short == null ? [] : [shortLabelOf(short)]),
    ];
    const created = brCreate(
      {db: target.db, env},
      {
        labels: newLabels,
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
    filedLabels = newLabels;
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
      labels: readonly string[];
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
        found = {
          labels: shown.issue.labels,
          place,
          status: shown.issue.status,
          title: shown.issue.title,
        };
        break;
      }
    }
    if (found == null) {
      return {id, kind: 'notFound', searched: places.map((p) => p.db)};
    }
    const adopted = adoptBead({
      db: found.place.db,
      env,
      id,
      // Marking a finished request overarching only sets the title; it must
      // not reopen the request (home-base-b4t8w, seen three times).
      keepStatus: options.overarching === true && found.status === 'closed',
      sessionId,
      status: found.status,
    });
    if (adopted.kind === 'failed') {
      return {kind: 'failed', reason: adopted.reason};
    }
    adoptedStatus = adopted.adoptedStatus;
    target = found.place;
    filedId = id;
    filedTitle = found.title;
    filedLabels = [
      ...new Set([...found.labels, REQUEST_LABEL, sidLabel(sessionId)]),
    ];
    mode = 'adopted';
    if (short != null) {
      const edit = shortLabelEdit(filedLabels, short);
      const labelled = brUpdate({db: target.db, env}, id, edit);
      if (labelled.kind === 'failed') {
        short = null;
        followUpFailures.push(
          `the short label was NOT set: ${describeBrFailed(labelled)}. Retry with ${sdkRun(`thread request --bead ${id} --short "…"`)}`,
        );
      } else {
        filedLabels = [
          ...filedLabels.filter((label) => !edit.removeLabels.includes(label)),
          ...edit.addLabels,
        ];
      }
    }
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
    const stamp = await titleSetEdit({
      cwd,
      env,
      labels: usable.bead.labels,
      now: options.now,
    });
    const renamed = brUpdate({db: usable.db, env}, usable.bead.id, {
      addLabels: stamp.addLabels,
      removeLabels: [AUTO_TITLE_LABEL, ...stamp.removeLabels],
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
  // ---- --continues with a request: the pickup, after filing. The names are
  // synced once below, after --overarching has settled the title. ----
  let continued: {oldBeadId: string; oldTitle: string} | null = null;
  let pickup: PickUpOutcome | null = null;
  if (continues != null) {
    if (usable.kind !== 'found') {
      followUpFailures.push(
        `this session was NOT linked to ${continues}: its session bead's checkout is gone`,
      );
    } else {
      pickup = await pickUp(usable, () => Promise.resolve(null));
      if (pickup.kind === 'picked-up') {
        continued = {oldBeadId: pickup.oldBeadId, oldTitle: pickup.oldTitle};
      } else if (pickup.kind === 'failed') {
        continued = pickup.done.link;
        followUpFailures.push(
          `the handoff pickup of ${continues} stopped at step "${pickup.step}": ${pickup.reason}. Running ${retryCommand} again finishes it`,
        );
      } else if (pickup.kind === 'already-continues') {
        followUpFailures.push(
          `this session was NOT linked to ${continues}: ${pickup.reason}. Nothing was carried over, and the pickup wrote nothing`,
        );
      } else {
        followUpFailures.push(
          `this session is not the successor of ${continues}: ${pickup.reason}. No link was made and nothing was carried over`,
        );
      }
    }
  }

  // ---- --overarching (home-base-jm5kg.5 D1, D2): after the link, so the
  // chain it reads already holds the predecessor ----
  let overarching: OverarchingMarked | null = null;
  if (options.overarching === true) {
    const marked = await markOverarching({
      chainReaders: options.chainReaders,
      continued,
      cwd,
      env,
      filed: {
        db: target.db,
        id: filedId,
        labels: filedLabels,
        title: filedTitle,
      },
      now: options.now,
      renamedSession,
      session: usable,
    });
    followUpFailures.push(...marked.failures);
    overarching = marked.overarching;
    renamedSession = marked.renamedSession;
  }

  // After the --continues link (home-base-mbnjv.3, C7): a successor's first
  // naming sync then sees both halves of the link and takes the workspace
  // name from its predecessor at once, instead of on its next prompt.
  // home-base-mbnjv.12: a session that was already titled and just linked
  // runs it too, so it takes its predecessor's workspace name now.
  // home-base-jm5kg.18: a short label can change the name, when it is on the
  // overarching request.
  const workspaceNote =
    renamedSession != null ||
    continued != null ||
    overarching != null ||
    short != null
      ? await workspaceNameFollowUp({cwd, env, run: options.cmux, sessionId})
      : null;

  return {
    adoptedStatus,
    continued,
    followUpFailures,
    id: filedId,
    inCheckout: target.root,
    kind: 'filed',
    mode,
    overarching,
    pickup,
    renamedSession,
    repair,
    short,
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
      } else if (outcome.adoptedStatus?.kind === 'kept') {
        lines.push(
          `  adopted; status left ${outcome.adoptedStatus.status}: --overarching only marks the title, so a finished request is not reopened`,
        );
      } else if (outcome.adoptedStatus?.kind === 'left') {
        lines.push(
          `  adopted; status left ${outcome.adoptedStatus.status}: br refuses to claim a blocked issue (blocked by: ${outcome.adoptedStatus.blockers}; br 0.1.37 counts open children as blockers). The request and sid labels are on it.`,
        );
      }
      if (outcome.short != null) {
        lines.push(`  short label: ${outcome.short}`);
      }
      if (outcome.overarching != null) {
        lines.push(
          `  marked overarching: it describes the whole of this session's work (and of the sessions it continues), and the session title follows it`,
        );
        if (outcome.overarching.unmarked.length > 0) {
          lines.push(
            `  no longer overarching: ${outcome.overarching.unmarked.join(', ')}`,
          );
        }
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
      if (outcome.pickup != null) {
        lines.push(...carriedLines(outcome.pickup));
      }
      if (outcome.followUpFailures.length > 0) {
        lines.push(
          `⚠️ ${outcome.id} WAS filed — do not file it again. But:`,
          ...outcome.followUpFailures.map((failure) => `  - ${failure}`),
        );
        return {
          exitCode:
            outcome.pickup?.kind === 'not-a-successor' ||
            outcome.pickup?.kind === 'already-continues'
              ? 2
              : 1,
          lines,
        };
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
    case 'handoffPickup':
      return describePickUp(outcome.pickup, outcome.retryCommand);
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
  const outcome = await fileRequest(options);
  // home-base-4ay2j D1: the one loud line, on stderr so stdout keeps its shape.
  if (outcome.kind === 'filed' && outcome.repair != null) {
    console.error(outcome.repair.line);
  }
  const {exitCode, lines} = describeRequestOutcome(outcome);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}

// ---------------------------------------------------------------------------
// thread title
// ---------------------------------------------------------------------------

export interface ThreadTitleOptions {
  agentId?: string | null;
  /** How the chain's requests are read (home-base-jm5kg.5 D2); tests inject. */
  chainReaders?: ChainRequestReaders;
  /** The cmux runner for the workspace-name follow-up; tests inject a fake. */
  cmux?: CmuxRunner;
  cwd?: string;
  env?: EnvLike;
  /** The title-set time (home-base-ys9t7.9.1); tests inject it. */
  now?: Date;
  sessionId: string | null;
  title: string | null;
}

export type ThreadTitleOutcome =
  | {agentId: string; kind: 'subagent'}
  | {
      beadId: string;
      kind: 'renamed';
      /**
       * home-base-jm5kg.5 D2: the overarching request retitled with the
       * session (`retitled`), none in the chain (`none`), or the chain could
       * not be read, so one may exist with its old title (`unchecked`, exit 1).
       */
      overarching:
        | {id: string; kind: 'retitled'}
        | {kind: 'none'}
        | {kind: 'unchecked'; reason: string};
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
  // home-base-jm5kg.5 D2: the session title IS the overarching request's
  // title, so with one in the chain it is retitled first (and its set time
  // refreshed: retitling it is checking it). A failure there changes nothing.
  const chain = readChainRequests(
    {id: found.bead.id, labels: found.bead.labels, title: found.bead.title},
    options.chainReaders ?? realChainRequestReaders({cwd, env}),
  );
  let overarching: Extract<
    ThreadTitleOutcome,
    {kind: 'renamed'}
  >['overarching'] = {kind: 'none'};
  if (chain.kind === 'failed') {
    overarching = {kind: 'unchecked', reason: chain.reason};
  } else {
    const picked = pickOverarching(chainRequestList(chain)).overarching;
    if (picked != null) {
      const db = resolveRecordedBeadsDb(picked.beadsDir);
      if (db.kind !== 'found') {
        return {
          kind: 'failed',
          reason: `the title is unchanged: the beads DB of the overarching request ${picked.id} (${picked.beadsDir}) could not be found${db.kind === 'failed' ? ` (${db.reason})` : ''}`,
        };
      }
      // home-base-jm5kg.18: the short label described the old title, and the
      // workspace name shows it, so it goes; What to mark asks for a new one.
      const mark = overarchingMarkEdit(
        picked.labels,
        options.now ?? new Date(),
      );
      const retitled = brUpdate({db: db.db, env}, picked.id, {
        ...mark,
        removeLabels: [
          ...mark.removeLabels,
          ...staleShortLabels(picked.labels),
        ],
        title,
      });
      if (retitled.kind === 'failed') {
        return {
          kind: 'failed',
          reason: `br update failed on the overarching request ${picked.id}, so neither it nor the session was retitled: ${describeBrFailed(retitled)}`,
        };
      }
      overarching = {id: picked.id, kind: 'retitled'};
    }
  }
  const stamp = await titleSetEdit({
    cwd,
    env,
    labels: found.bead.labels,
    now: options.now,
  });
  const renamed = brUpdate(target, found.bead.id, {
    addLabels: stamp.addLabels,
    removeLabels: [AUTO_TITLE_LABEL, ...stamp.removeLabels],
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
  return {
    beadId: found.bead.id,
    kind: 'renamed',
    overarching,
    title,
    workspaceNote,
  };
}

export function describeTitleOutcome(outcome: ThreadTitleOutcome): {
  exitCode: 0 | 1 | 2;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'renamed': {
      const over = outcome.overarching;
      const lines = [
        `session ${outcome.beadId} · ${outcome.title}`,
        ...(over.kind === 'retitled'
          ? [
              `  the overarching request ${over.id} is retitled with it (the session title is its title)`,
            ]
          : []),
        ...(outcome.workspaceNote != null
          ? [`  ${outcome.workspaceNote}`]
          : []),
      ];
      if (over.kind === 'unchecked') {
        lines.push(
          `⚠️ the session WAS renamed, but its overarching request, if it has one, was NOT: the requests of this session and the sessions it continues could not be read (${over.reason}).`,
        );
        return {exitCode: 1, lines};
      }
      return {exitCode: 0, lines};
    }
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
