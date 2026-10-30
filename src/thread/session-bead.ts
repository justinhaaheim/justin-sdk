/**
 * The SESSION bead (status report v4, epic home-base-vzwbj.4 D1; built by
 * home-base-vzwbj.4.1): one bead per Claude Code session, in the repo's OWN
 * beads workspace, filed by the capture hook's detached child on the session's
 * first captured prompt — never at session start, never by Claude.
 *
 * CONTRACT the later v4 dispatches rely on (do not rename without them):
 *  - labels `session`, `sid:<session id>`, `auto-title` (until renamed),
 *    `cmux-surface:<id>` / `cmux-workspace:<id>` when those env vars exist;
 *    requests carry `request` + `sid:<session id>`.
 *  - the description is the fixed lines of `sessionBeadDescription`, one fact
 *    per line, written once. Nothing of Justin's or Claude's messages is
 *    mirrored (D1: fetch from the message log, never duplicate).
 *  - `resolveSession()` → found | checkoutMissing | none | failed.
 */

import type {BrIssue, BrTarget} from '../beads/br';
import type {EnvLike} from './paths';
import type {SessionSighting} from './session-index';

import {
  brCreate,
  brList,
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {readGitFacts} from './facts';
import {
  appendSessionSighting,
  corruptSightingsNote,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';

export const SESSION_BEAD_TYPE = 'session';
export const SESSION_LABEL = 'session';
export const REQUEST_LABEL = 'request';
export const AUTO_TITLE_LABEL = 'auto-title';
export const CMUX_SURFACE_LABEL_PREFIX = 'cmux-surface:';
/**
 * DEVIATION from the bead's `cmux-workspace:` (home-base-vzwbj.4.1 notes):
 * br refuses a label over 50 characters (`Validation failed: label: exceeds 50
 * characters`, measured 2026-10-11, br 0.1.37), and `cmux-workspace:` plus a
 * 36-character cmux UUID is 51 — so in every cmux session the bead could not
 * be filed at all. `cmux-ws:` keeps the id verbatim at 44. `cmux-surface:` +
 * UUID is 49 and keeps its name.
 */
export const CMUX_WORKSPACE_LABEL_PREFIX = 'cmux-ws:';

/** The value of the first label with this prefix, or null when none has it. */
export function labelValue(
  labels: readonly string[],
  prefix: string,
): string | null {
  const label = labels.find((entry) => entry.startsWith(prefix));
  return label == null ? null : label.slice(prefix.length);
}
export const SID_LABEL_PREFIX = 'sid:';
/**
 * A request's stage labels are `stage:<name>`, the names from
 * `componentConfig.thread.stages` (home-base-vzwbj.4.3, `thread stage`).
 */
export const STAGE_LABEL_PREFIX = 'stage:';
/**
 * The session bead's label once `thread handoff` (dispatch 4) hands it on.
 * Defined here with the other label contracts so status derivation
 * (home-base-vzwbj.4.3, epic D2 step 3) and the writer read one spelling.
 */
export const HANDED_OFF_LABEL = 'handed-off';
/**
 * The continuation links (home-base-vzwbj.4.4): the NEW session bead carries
 * `continues:<old session bead id>`, the old one `continued-by:<new id>`.
 * Written by `thread request --continues` and `thread handoff --to`.
 */
export const CONTINUES_LABEL_PREFIX = 'continues:';
export const CONTINUED_BY_LABEL_PREFIX = 'continued-by:';
/**
 * The spawn links (request home-base-ys9t7.5, D8): a session started by
 * `thread spawn` carries `spawned-by:<parent session bead id>`, the parent
 * `spawned:<child id>`, so the child's spend counts against the parent's
 * quota group. Read by thread/quota-group.ts; written by dispatch 2.
 */
export const SPAWNED_BY_LABEL_PREFIX = 'spawned-by:';
export const SPAWNED_LABEL_PREFIX = 'spawned:';
/**
 * How the child learns its parent (home-base-ys9t7.5.4 item 3). `thread
 * spawn` types `JUSTIN_SDK_SPAWNED_BY_SESSION=<parent session id>
 * JUSTIN_SDK_SPAWN_KICKOFF=1 claude …` into the new pane, so claude and every
 * hook it runs (the capture child among them) carry both. The kickoff text
 * cannot carry a marker: a `/conductor …` kickoff must start with `/` to run
 * as a slash command. The parent is named by SESSION id, not bead id: the
 * capture child resolves it to the parent's bead and DB through the sessions
 * index when it files the child's bead, so spawn itself reads no bead.
 */
export const SPAWNED_BY_SESSION_ENV = 'JUSTIN_SDK_SPAWNED_BY_SESSION';
export const SPAWN_KICKOFF_ENV = 'JUSTIN_SDK_SPAWN_KICKOFF';
/**
 * On a session whose first prompt `thread spawn` typed (the kickoff), so the
 * quota does not read it as Justin typing (quota-group.ts drops it).
 */
export const SPAWN_KICKOFF_LABEL = 'spawn-kickoff';
/**
 * The session bead's label once the handoff gate has refused it (epic
 * home-base-mbnjv D2), beside a note line "handoff refused: <reason> — …".
 * Written by handoff-gate.ts `recordRefusal`.
 */
export const HANDOFF_REFUSED_LABEL = 'handoff-refused';

/**
 * Written by `thread handoff` before it opens the successor's tab
 * (home-base-mbnjv.8 F11); the gate refuses a second handoff while present
 * (alreadyHandedOff).
 */
export const SUCCESSOR_STARTED_LABEL = 'successor-started';

/**
 * home-base-ys9t7.9.1: when the session's title was last set, as
 * `title-set:<ISO time to the second>Z`, written in the same `br update` as
 * the title by `thread title`, the first request's auto-title and a
 * successor's inherited title, only with componentConfig.thread.titleSummary
 * on. br allows letters, digits, `-`, `_` and `:` in a label, so the time
 * carries no milliseconds; it is rounded UP to the next whole second, so a
 * request filed in the same second just before the title was set never reads
 * as filed after it. `thread status` compares each request's created_at with
 * it.
 */
export const TITLE_SET_LABEL_PREFIX = 'title-set:';

/** The `title-set:` label for a title set at `now` (rounded up to the second). */
export function titleSetLabel(now: Date): string {
  const ceiled = new Date(Math.ceil(now.getTime() / 1000) * 1000);
  return `${TITLE_SET_LABEL_PREFIX}${ceiled.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * The label edit that records a title set at `now`: the new `title-set:`
 * label, and every older one removed (one per bead, so the newest is the only
 * one). A label equal to the new one is never in both lists, so the order in
 * which br applies them cannot drop it.
 */
export function titleSetLabelEdit(
  labels: readonly string[],
  now: Date,
): {addLabels: string[]; removeLabels: string[]} {
  const label = titleSetLabel(now);
  return {
    addLabels: [label],
    removeLabels: labels.filter(
      (entry) => entry.startsWith(TITLE_SET_LABEL_PREFIX) && entry !== label,
    ),
  };
}

/**
 * When the title was last set, from the `title-set:` label: epoch ms, or
 * `none` (no label: the title was set before titleSummary was on, or never
 * by a recorded path), or `unreadable` (a label whose time does not parse).
 * The newest wins when a failed edit left more than one.
 */
export function titleSetAt(
  labels: readonly string[],
):
  | {at: number; kind: 'set'}
  | {kind: 'none'}
  | {kind: 'unreadable'; label: string} {
  const stamps = labels.filter((entry) =>
    entry.startsWith(TITLE_SET_LABEL_PREFIX),
  );
  if (stamps.length === 0) return {kind: 'none'};
  let newest: number | null = null;
  for (const label of stamps) {
    const at = Date.parse(label.slice(TITLE_SET_LABEL_PREFIX.length));
    if (Number.isNaN(at)) return {kind: 'unreadable', label};
    if (newest == null || at > newest) newest = at;
  }
  return newest == null ? {kind: 'none'} : {at: newest, kind: 'set'};
}

/** br's label length limit (measured 2026-10-11, br 0.1.37). */
export const BR_LABEL_MAX = 50;

/**
 * The characters br accepts in a label: "Validation failed: label: invalid
 * characters (only alphanumeric, hyphen, underscore, colon allowed)", exit 4
 * (measured 2026-10-12, br 0.1.37).
 */
const BR_LABEL_SHAPE = /^[A-Za-z0-9_:-]+$/;

/**
 * A question's link to the request it is for (home-base-vzwbj.4.16 G1): the
 * question's PARENT is the session bead, so an optional question never keeps
 * a request open (br refuses `br close` on a parent with open children); the
 * request is named by this label instead.
 *
 * DEVIATION from G1's literal `to:<request id>` (recorded on
 * home-base-vzwbj.4.16): br refuses a label containing `.` (the refusal
 * above), and every request `thread request` files is a child bead
 * (`<session>.N`). So each `.` of the id is written as `:` —
 * `to:home-base-knsyl:2` for `home-base-knsyl.2`. Readers never decode it:
 * they compare `toLabel(request.id)` with the question's labels, so the
 * spelling only has to be one-to-one over real ids (br ids are
 * `<prefix>-<hash>` plus `.N` levels; no real id holds a `:`).
 *
 * A label, not a br dependency, because `--to` may name a bead in another
 * checkout's DB (the conductor in main with a worktree DB), and br refuses a
 * dependency on a bead its DB does not hold.
 */
export const TO_LABEL_PREFIX = 'to:';

export function toLabel(requestId: string): string {
  return `${TO_LABEL_PREFIX}${requestId.replaceAll('.', ':')}`;
}

/**
 * The `to:` label for `requestId`, or why br would refuse it (too long, or a
 * character br does not allow). A refused link is NAMED by the caller and the
 * question is filed without it — never a failed ask.
 */
export function toLabelFor(
  requestId: string,
): {label: string; ok: true} | {ok: false; reason: string} {
  const label = toLabel(requestId);
  if (label.length > BR_LABEL_MAX) {
    return {
      ok: false,
      reason: `${label} is ${label.length} characters; br allows ${BR_LABEL_MAX}`,
    };
  }
  if (!BR_LABEL_SHAPE.test(label)) {
    return {
      ok: false,
      reason: `${label} holds a character br refuses in a label (it allows letters, digits, -, _ and :)`,
    };
  }
  return {label, ok: true};
}

/** The session bead's priority, and a request's (D1: type task, P2). */
export const SESSION_BEAD_PRIORITY = 2;

/** Titles are cut here, ellipsis included (D1: "cut at 100 chars"). */
export const SESSION_TITLE_MAX = 100;

export function sidLabel(sessionId: string): string {
  return `${SID_LABEL_PREFIX}${sessionId}`;
}

/**
 * A cmux id is only labelled when it is a plain token. A comma would split the
 * `-l a,b,c` list br parses, and anything stranger is not a cmux id.
 */
const CMUX_ID_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * The session bead's labels, in a fixed order, plus any cmux label that had to
 * be left off and why. A label br would refuse (too long, or not a plain
 * token) is DROPPED and named, never allowed to fail the whole create: one
 * unusable pane id must not cost the session its bead.
 */
export function sessionBeadLabels(
  sessionId: string,
  env: EnvLike,
  /** The parent's session bead id, when `thread spawn` started this one. */
  links: {spawnedBy?: string | null} = {},
): {dropped: string[]; labels: string[]} {
  const labels = [SESSION_LABEL, sidLabel(sessionId)];
  const dropped: string[] = [];
  const cmux: [string, string | undefined, string][] = [
    [CMUX_SURFACE_LABEL_PREFIX, env.CMUX_SURFACE_ID, 'CMUX_SURFACE_ID'],
    [CMUX_WORKSPACE_LABEL_PREFIX, env.CMUX_WORKSPACE_ID, 'CMUX_WORKSPACE_ID'],
  ];
  for (const [prefix, id, name] of cmux) {
    if (id == null || id === '') continue;
    const label = `${prefix}${id}`;
    if (!CMUX_ID_SHAPE.test(id)) {
      dropped.push(`${name} is not a plain token: ${JSON.stringify(id)}`);
    } else if (label.length > BR_LABEL_MAX) {
      dropped.push(
        `${label} is ${label.length} characters; br allows ${BR_LABEL_MAX}`,
      );
    } else {
      labels.push(label);
    }
  }
  if (links.spawnedBy != null) {
    const label = `${SPAWNED_BY_LABEL_PREFIX}${links.spawnedBy}`;
    if (!BR_LABEL_SHAPE.test(label)) {
      dropped.push(
        `${label} holds a character br refuses in a label, so this session counts as its own quota group`,
      );
    } else if (label.length > BR_LABEL_MAX) {
      dropped.push(
        `${label} is ${label.length} characters; br allows ${BR_LABEL_MAX}, so this session counts as its own quota group`,
      );
    } else {
      labels.push(label);
    }
  }
  if (env[SPAWN_KICKOFF_ENV] === '1') labels.push(SPAWN_KICKOFF_LABEL);
  labels.push(AUTO_TITLE_LABEL);
  return {dropped, labels};
}

/**
 * home-base-ys9t7.9.1 B4: the label edit that points a session bead's
 * `cmux-surface:` / `cmux-ws:` labels at the pane the session runs in NOW.
 * They were read from the environment once, when the bead was filed, so a
 * session resumed in another tab kept pointing at the old one and every
 * naming sync failed. Only a usable id in `env` replaces a label: a missing
 * or unusable one leaves the old label (a hook run without the cmux
 * variables is not evidence the session left cmux). null: nothing to change.
 */
export function cmuxLabelRefresh(
  labels: readonly string[],
  env: EnvLike,
): {addLabels: string[]; removeLabels: string[]} | null {
  const addLabels: string[] = [];
  const removeLabels: string[] = [];
  const wanted = sessionBeadLabels('', env).labels.filter(
    (label) =>
      label.startsWith(CMUX_SURFACE_LABEL_PREFIX) ||
      label.startsWith(CMUX_WORKSPACE_LABEL_PREFIX),
  );
  for (const label of wanted) {
    const prefix = label.startsWith(CMUX_SURFACE_LABEL_PREFIX)
      ? CMUX_SURFACE_LABEL_PREFIX
      : CMUX_WORKSPACE_LABEL_PREFIX;
    const current = labels.filter((entry) => entry.startsWith(prefix));
    if (current.length === 1 && current[0] === label) continue;
    if (!current.includes(label)) addLabels.push(label);
    removeLabels.push(...current.filter((entry) => entry !== label));
  }
  return addLabels.length === 0 && removeLabels.length === 0
    ? null
    : {addLabels, removeLabels};
}

/**
 * `text` cut to `max` characters on a word boundary, with an ellipsis. The
 * result is never longer than `max`; a single word longer than that is cut
 * mid-word, because a title must exist.
 */
export function cutOnWord(
  text: string,
  max: number = SESSION_TITLE_MAX,
): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const lastSpace = room.search(/\s\S*$/);
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

/**
 * The placeholder session title (D1): the first non-empty line of the first
 * prompt, cut at 100 characters on a word boundary. The prompt is already
 * noise-stripped by the message log (`capturedUserText`). null when there is
 * no line at all — the caller then names the session by its id.
 */
export function sessionTitleFrom(prompt: string): string | null {
  const line = prompt
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  if (line == null) return null;
  return cutOnWord(line.replace(/\s+/g, ' '));
}

/** The title used when no prompt text was captured: honest, not invented. */
export function untitledSessionTitle(sessionId: string): string {
  return `(no prompt captured) session ${sessionId.slice(0, 8)}`;
}

export interface SessionBeadFacts {
  branch: string | null;
  checkoutPath: string;
  repo: string | null;
  sessionId: string;
  /** ISO-8601: the first captured prompt's time. */
  startedAt: string;
}

/**
 * The session bead's description: one fact per line, in this order, nothing
 * else (D1; the line shapes are a contract for dispatches 2–4). An unknown
 * repo or branch is written `UNKNOWN`, never left blank.
 */
export function sessionBeadDescription(facts: SessionBeadFacts): string {
  return [
    `Session: ${facts.sessionId}`,
    `Resume: claude --resume ${facts.sessionId}`,
    `Repo: ${facts.repo ?? 'UNKNOWN'}`,
    `Branch: ${facts.branch ?? 'UNKNOWN'}`,
    `Checkout: ${facts.checkoutPath}`,
    `Started: ${facts.startedAt}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Resolution (thread request, thread title, and later dispatches)
// ---------------------------------------------------------------------------

export type SessionResolution =
  | {
      /** The session bead's checkout, when the index named it, is gone. */
      beadId: string;
      beadsDir: string;
      checkoutPath: string;
      kind: 'checkoutMissing';
      sessionId: string;
    }
  | {
      bead: BrIssue;
      beadsDir: string;
      checkoutPath: string;
      db: string;
      kind: 'found';
      sessionId: string;
      /** Every sighting of this session, newest first. */
      sightings: SessionSighting[];
    }
  | {kind: 'failed'; reason: string}
  | {
      /** R9: the corrupt index lines that mention this session, or null. */
      corruptNote: string | null;
      indexPath: string;
      kind: 'none';
      reason: string;
    };

/**
 * The session bead for `sessionId`, through the index (D1 "which DB a write
 * goes to"): the DB that holds the session bead, regardless of cwd.
 */
export function resolveSession(input: {
  env: EnvLike;
  sessionId: string;
}): SessionResolution {
  const {env, sessionId} = input;
  const read = readSessionSightings(sessionId, env);
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${read.path}: ${read.error}`,
    };
  }
  const known =
    read.kind === 'read' ? sessionBeadSighting(read.sightings) : null;
  if (known == null) {
    const corruptNote = corruptSightingsNote(read);
    return {
      corruptNote,
      indexPath: read.path,
      kind: 'none',
      reason: `${corruptNote != null ? `${corruptNote}. ` : ''}no session bead is recorded for session ${sessionId} in ${read.path}. Either componentConfig.thread.sessionBeads was off when this session's prompts were captured, the thread capture hook is not installed here, the repo has no beads workspace, or the capture child failed (its outcome is in capture.jsonl beside the index). Or the bead is not filed YET: a session's bead is filed in the background after its first prompt (15.7 s measured), and /clear starts a new session id that needs a bead of its own (home-base-mbnjv.8 F22, live run 20261029T184011Z). If this session started or was cleared moments ago, end this turn and run the command again in the next one.`,
    };
  }
  // The recorded dir is resolved at read time (home-base-dj5m9.1.1): an old
  // entry naming a worktree whose DB was moved aside, or whose directory is
  // gone, reaches the primary checkout's DB when the repo's br shares it.
  // Only an unresolvable DB is checkoutMissing. That is all the old
  // `existsSync(checkoutPath)` check added: every entry a br before 0.4.1
  // wrote has beadsDir === <checkoutPath>/.beads, so a DB found there proves
  // the checkout exists, and a DB in the primary outlives its worktree.
  const db = resolveRecordedBeadsDb(known.beadsDir);
  if (db.kind === 'none') {
    return {
      beadId: known.beadId,
      beadsDir: known.beadsDir,
      checkoutPath: known.checkoutPath,
      kind: 'checkoutMissing',
      sessionId,
    };
  }
  if (db.kind === 'failed') return {kind: 'failed', reason: db.reason};
  const shown = brShow({db: db.db, env}, known.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `could not read session bead ${known.beadId}: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {
      kind: 'failed',
      reason: `the sessions index names ${known.beadId} in ${db.db}, but br cannot find it there (deleted, or the index is wrong)`,
    };
  }
  return {
    bead: shown.issue,
    beadsDir: known.beadsDir,
    checkoutPath: known.checkoutPath,
    db: db.db,
    kind: 'found',
    sessionId,
    sightings: read.kind === 'read' ? read.sightings : [],
  };
}

/** Where the parent of a spawned session is, or why it is not linked. */
export type SpawnParent =
  | {beadId: string; db: string; kind: 'found'; sessionId: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'};

/**
 * The parent `thread spawn` named in SPAWNED_BY_SESSION_ENV, resolved to its
 * session bead and DB. `none`: this session was not spawned (or names
 * itself). `failed`: the link is left off and the reason recorded; the session
 * then counts as its own quota group, all of it unattended (D8).
 */
export function spawnParentOf(sessionId: string, env: EnvLike): SpawnParent {
  const parent = env[SPAWNED_BY_SESSION_ENV]?.trim() ?? '';
  if (parent === '' || parent === sessionId) return {kind: 'none'};
  const resolved = resolveSession({env, sessionId: parent});
  if (resolved.kind === 'found') {
    return {
      beadId: resolved.bead.id,
      db: resolved.db,
      kind: 'found',
      sessionId: parent,
    };
  }
  const why =
    resolved.kind === 'checkoutMissing'
      ? `its session bead ${resolved.beadId}'s checkout is gone`
      : resolved.reason;
  return {
    kind: 'failed',
    reason: `the parent session ${parent} (${SPAWNED_BY_SESSION_ENV}) has no session bead to link to: ${why}`,
  };
}

// ---------------------------------------------------------------------------
// Creation (the capture child)
// ---------------------------------------------------------------------------

/**
 * What one ensure did, recorded in capture.jsonl as `sessionBead`. `failed`
 * means "could not tell or could not write" and is never read as `noWorkspace`.
 */
export type SessionBeadOutcome =
  | {beadId: string; detail: string; kind: 'created'}
  | {beadId: string; detail: string; kind: 'exists'}
  | {detail: string; kind: 'failed'}
  | {detail: string; kind: 'noWorkspace'};

function sighting(
  event: SessionSighting['event'],
  beadId: string,
  workspace: {beadsDir: string; root: string},
  git: {branch: string | null; repo: string | null},
  sessionId: string,
  now: Date,
): SessionSighting {
  return {
    at: now.toISOString(),
    beadId,
    beadsDir: workspace.beadsDir,
    branch: git.branch,
    checkoutPath: workspace.root,
    event,
    repo: git.repo,
    sessionId,
  };
}

export interface EnsureSessionBeadInput {
  /** The session's working directory (the hook payload's cwd). */
  cwd: string | null;
  env: EnvLike;
  /** The session's first captured prompt, from the message log. */
  firstPrompt: {at: string | null; text: string} | null;
  now: Date;
  sessionId: string;
}

/**
 * File the session bead if this session has none (D1). IDEMPOTENT: the index
 * is asked first (a session that moved to another checkout mid-session still
 * has exactly one bead), then the cwd's own DB (`br list -t session -l
 * sid:<id> --all`), and only a MEASURED absence in both creates.
 *
 * Runs under the capture child's per-session lock, so two children of one
 * session never race each other into two beads.
 */
export function ensureSessionBead(
  input: EnsureSessionBeadInput,
): SessionBeadOutcome {
  const {env, sessionId} = input;

  // 1. The index. Unreadable means "could not tell", and creating on a guess
  // could file a second bead for a session that already has one elsewhere.
  const sightings = readSessionSightings(sessionId, env);
  if (sightings.kind === 'failed') {
    return {
      detail: `sessions index unreadable (${sightings.path}: ${sightings.error}); not creating, to avoid a duplicate`,
      kind: 'failed',
    };
  }
  // R9 (home-base-vzwbj.4.9): a corrupt line naming this session does not
  // stop the heal below (br list finds the bead, the index is repaired); it
  // is named in the outcome so capture.jsonl says why the heal ran.
  const corruptNote = corruptSightingsNote(sightings);
  const corruptSuffix = corruptNote != null ? `; ${corruptNote}` : '';
  const known =
    sightings.kind === 'read' ? sessionBeadSighting(sightings.sightings) : null;
  if (known != null) {
    return {
      beadId: known.beadId,
      detail: `the sessions index names ${known.beadId} in ${known.beadsDir}`,
      kind: 'exists',
    };
  }

  // 2. The workspace.
  if (input.cwd == null) {
    return {detail: 'the hook payload carried no cwd', kind: 'failed'};
  }
  const workspace = findBeadsWorkspace(input.cwd);
  if (workspace.kind === 'none') {
    return {detail: workspace.reason, kind: 'noWorkspace'};
  }
  if (workspace.kind === 'failed') {
    return {detail: workspace.reason, kind: 'failed'};
  }
  const target: BrTarget = {db: workspace.db, env};
  const git = readGitFacts(workspace.root);

  // 3. The DB itself: a bead whose index line was lost is still found here,
  // and the index is repaired rather than a second bead filed.
  const existing = brList(target, {
    all: true,
    labels: [sidLabel(sessionId)],
    types: [SESSION_BEAD_TYPE],
  });
  if (existing.kind === 'failed') {
    return {
      detail: `br list failed, so absence is unproven: ${describeBrFailed(existing)}`,
      kind: 'failed',
    };
  }
  const [first] = existing.issues;
  if (first != null) {
    const repaired = appendSessionSighting(
      sighting('created', first.id, workspace, git, sessionId, input.now),
      env,
    );
    const many =
      existing.issues.length > 1
        ? ` (${existing.issues.length} session beads carry ${sidLabel(sessionId)}: ${existing.issues.map((issue) => issue.id).join(', ')})`
        : '';
    return {
      beadId: first.id,
      detail: `found in ${workspace.db}, missing from the index${many}; index ${repaired.kind === 'appended' ? 'repaired' : `NOT repaired: ${repaired.error}`}${corruptSuffix}`,
      kind: 'exists',
    };
  }

  // 4. Create.
  const title =
    (input.firstPrompt != null
      ? sessionTitleFrom(input.firstPrompt.text)
      : null) ?? untitledSessionTitle(sessionId);
  // D8: a session `thread spawn` started links to its parent's bead.
  const parent = spawnParentOf(sessionId, env);
  const labels = sessionBeadLabels(sessionId, env, {
    spawnedBy: parent.kind === 'found' ? parent.beadId : null,
  });
  const created = brCreate(target, {
    description: sessionBeadDescription({
      branch: git.branch,
      checkoutPath: workspace.root,
      repo: git.repo,
      sessionId,
      startedAt: input.firstPrompt?.at ?? input.now.toISOString(),
    }),
    labels: labels.labels,
    priority: SESSION_BEAD_PRIORITY,
    status: 'in_progress',
    title,
    type: SESSION_BEAD_TYPE,
  });
  if (created.kind === 'failed') {
    return {
      detail: `br create failed: ${describeBrFailed(created)}`,
      kind: 'failed',
    };
  }
  const indexed = appendSessionSighting(
    sighting('created', created.id, workspace, git, sessionId, input.now),
    env,
  );
  const notes = [
    indexed.kind === 'appended'
      ? `filed in ${workspace.db}`
      : `filed in ${workspace.db}, but the index line was NOT written (${indexed.error}); the next capture repairs it`,
    ...labels.dropped.map((reason) => `label left off: ${reason}`),
  ];
  if (parent.kind === 'failed') notes.push(`not linked: ${parent.reason}`);
  if (
    parent.kind === 'found' &&
    labels.labels.includes(`${SPAWNED_BY_LABEL_PREFIX}${parent.beadId}`)
  ) {
    // The parent's half of the link, so its group walk finds this child too.
    // A failure leaves the child's spawned-by: label, which the walk from the
    // child still follows; it is named here, in capture.jsonl.
    const childLabel = `${SPAWNED_LABEL_PREFIX}${created.id}`;
    const linked = brUpdate({db: parent.db, env}, parent.beadId, {
      addLabels: [childLabel],
    });
    notes.push(
      linked.kind === 'ok'
        ? `spawned by ${parent.beadId} (${childLabel} written there)`
        : `spawned by ${parent.beadId}, but ${childLabel} was NOT written there: ${describeBrFailed(linked)}`,
    );
  }
  return {
    beadId: created.id,
    detail: notes.join('; ') + corruptSuffix,
    kind: 'created',
  };
}

/** A sighting for a bead in `workspace`, measured from its git facts now. */
export function sightingIn(
  event: SessionSighting['event'],
  beadId: string,
  workspace: {beadsDir: string; root: string},
  sessionId: string,
  now: Date,
): SessionSighting {
  return sighting(
    event,
    beadId,
    workspace,
    readGitFacts(workspace.root),
    sessionId,
    now,
  );
}
