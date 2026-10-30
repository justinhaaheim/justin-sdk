/**
 * A session's STATUS, derived — never typed (status report v4, epic
 * home-base-vzwbj.4 D2; built by home-base-vzwbj.4.3). Typed status was the
 * thing that lied ("unmerged work shown as done"), so the status is computed
 * from the session model by one pure function, in the epic's precedence:
 *
 *   1. 🛑 Waiting on you   an open P0 question
 *   2. 🏃 Working          a helper agent is in flight with its last record
 *                          under 15 minutes old (F10, home-base-j8q3e.1.10;
 *                          counted "if you stop now" too); or the transcript's
 *                          last record is under 3 minutes old
 *   3. 🤝 Handed off       the session bead carries `handed-off`
 *   4. 🧯 Out of context   context tokens at or above usage-check's wrapUpAt
 *   5. ✅ Done             Justin closed the session (`done: Justin…`, and —
 *                          a decision of dispatch 3 — `archived: …`), whatever
 *                          git says; or every request closed (at least one)
 *                          AND git measured the branch merged into the default
 *                          branch (or on it) AND a clean tree (home-base-
 *                          vzwbj.4.9 R2)
 *      🔀 Done, not merged every request closed, but not merged or not clean;
 *                          git unmeasured there is ❔, never ✅ (R2)
 *   6. 💬 Answered         no request, the last message is Claude's, commits
 *                          since the first prompt COUNTED zero (a partial
 *                          count — commit evidence that matched no commit —
 *                          is not zero, R3), and the tree MEASURED clean
 *                          ignoring `.beads/`
 *   7. ❔ Unknown          commits or the tree could not be measured (or a
 *                          beads export could not be read): named, never 6
 *   8. ⚠️ Open work, no blocker — otherwise
 *
 * Optional questions (P1–P3) and FYIs (P4) never change the status; they are
 * counted beside it. `asIfYielded` is the "if you stop now" verdict `thread
 * status` prints while the session is plainly running: it skips 🏃 and treats
 * the message Claude is about to yield as the last one.
 */

import type {SessionCommits} from './session-commits';
import type {CreatedBeads} from './session-created';
import type {Measured, MergeState, SessionModel} from './session-model';
import type {RequestNode, SessionTree, TreeIssue} from './session-tree';

import {parseInstant} from './answer-store';
import {ARCHIVED_PREFIX, ASK_LABEL, DONE_PREFIX} from './ask-format';
import {
  AUTO_TITLE_LABEL,
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  labelValue,
  REQUEST_LABEL,
  STAGE_LABEL_PREFIX,
  titleSetAt,
} from './session-bead';
import {unmatchedCommitEvidence} from './session-commits';
import {
  firstUserLine,
  lastLogLine,
  measured,
  unmeasured,
} from './session-model';

/** Epic D2 step 2: a session whose last record is younger than this is working. */
export const WORKING_WINDOW_MS = 3 * 60_000;

/**
 * F10 (home-base-j8q3e.1.10): a helper agent in flight keeps its session
 * working while its newest record is younger than this. Longer than Bash's
 * 10-minute cap, so one long tool call does not drop it; the cost is that a
 * KILLED helper keeps the session working for up to this long.
 */
export const HELPER_WINDOW_MS = 15 * 60_000;

/** F10: the in-flight helpers whose newest record is inside the helper window. */
export function recentHelpers(
  helpersInFlight: readonly (string | null)[] | null,
  now: Date,
): string[] {
  if (helpersInFlight == null) return [];
  return helpersInFlight.filter((at): at is string => {
    const ms = at == null ? null : parseInstant(at);
    if (ms == null) return false;
    const age = now.getTime() - ms;
    return age >= 0 && age < HELPER_WINDOW_MS;
  });
}

/**
 * The session's commits as `deriveStatus` reads them (home-base-vzwbj.4.9 R3):
 * counted; PARTIAL — some commit evidence matched no commit in the checkout
 * (`git -C ../other commit`, a script's commit elsewhere), so `matched` is a
 * floor, not a total; or not measured at all.
 */
export type CommitsFact =
  | {count: number; kind: 'counted'}
  | {kind: 'partial'; matched: number; unmatched: number}
  | {kind: 'unmeasured'; reason: string};

/** Everything `deriveStatus` reads — small on purpose, so a table can drive it. */
export interface StatusFacts {
  /** Beads exports that could not be read: requests there are unknown. */
  beadProblems: string[];
  commits: CommitsFact;
  /** Context tokens at the last record; null when not measured. */
  contextTokens: number | null;
  handedOff: boolean;
  /**
   * F10 (home-base-j8q3e.1.10): the newest record of each helper agent still
   * in flight (null = that helper's records carry no time); null when the
   * helpers could not be measured, which never claims working (rule 7).
   */
  helpersInFlight: (string | null)[] | null;
  /** Whose line ends the message log; null when the log is empty or unread. */
  lastMessageRole: 'assistant' | 'user' | null;
  /** The transcript's last record, ISO; null when not measured. */
  lastRecordAt: string | null;
  /**
   * R2: the checkout's branch against the default branch. ✅ Done by requests
   * needs it measured and `merged` or `isDefault`.
   */
  merged: Measured<MergeState>;
  openP0: number;
  requests: {closed: number; total: number};
  /** The session bead's close reason when it is closed, else null. */
  sessionCloseReason: string | null;
  /**
   * The successor's session bead (`continued-by:<id>`, written by `thread
   * handoff --to` or `thread request --continues`); null when none is known.
   */
  successor: string | null;
  uncommitted: Measured<number>;
  /** null = no threshold configured (a real answer, not a failure). */
  wrapUpAt: number | null;
}

export type SessionStatus =
  | {by: 'justin' | 'requests'; kind: 'done'; reason: string | null}
  | {contextTokens: number; kind: 'outOfContext'; wrapUpAt: number}
  | {kind: 'answered'}
  /**
   * R2 (home-base-vzwbj.4.9): every request is closed, but the work is not
   * landed — the branch is not merged into the default branch, or the tree
   * has uncommitted paths (`.beads/` ignored), or both.
   */
  | {kind: 'doneUnmerged'; notMerged: boolean; uncommitted: number}
  | {kind: 'handedOff'; successor: string | null}
  | {kind: 'openWork'}
  | {kind: 'unknown'; reasons: string[]}
  | {kind: 'waiting'; openP0: number}
  /** `helpers`: helper agents in flight (F10); 0 = Claude's own records are recent. */
  | {helpers: number; kind: 'working'; lastRecordAt: string};

export interface DeriveOptions {
  /** The verdict "if you stop now": no 🏃, and Claude's yield is the last line. */
  asIfYielded: boolean;
  now: Date;
}

function closedByJustin(reason: string | null): boolean {
  return (
    reason != null &&
    (reason.startsWith(DONE_PREFIX) || reason.startsWith(ARCHIVED_PREFIX))
  );
}

/** Epic D2's precedence, exactly. Pure: same facts and clock, same answer. */
export function deriveStatus(
  facts: StatusFacts,
  options: DeriveOptions,
): SessionStatus {
  if (facts.openP0 > 0) return {kind: 'waiting', openP0: facts.openP0};

  // F10: helpers in flight count even "if you stop now" (asIfYielded): a
  // session waiting on its own helpers is not a reflexive yield, and Part 1
  // and the inbox must not disagree (conductor decision, 2026-10-15).
  const helpers = recentHelpers(facts.helpersInFlight, options.now);
  if (helpers.length > 0) {
    return {
      helpers: helpers.length,
      kind: 'working',
      lastRecordAt:
        facts.lastRecordAt ?? helpers.reduce((a, b) => (a > b ? a : b)),
    };
  }

  if (!options.asIfYielded && facts.lastRecordAt != null) {
    const at = parseInstant(facts.lastRecordAt);
    if (at != null) {
      const age = options.now.getTime() - at;
      if (age >= 0 && age < WORKING_WINDOW_MS) {
        return {helpers: 0, kind: 'working', lastRecordAt: facts.lastRecordAt};
      }
    }
  }

  if (facts.handedOff) return {kind: 'handedOff', successor: facts.successor};

  if (
    facts.contextTokens != null &&
    facts.wrapUpAt != null &&
    facts.contextTokens >= facts.wrapUpAt
  ) {
    return {
      contextTokens: facts.contextTokens,
      kind: 'outOfContext',
      wrapUpAt: facts.wrapUpAt,
    };
  }

  // Justin's mark is final whatever else could be read.
  if (closedByJustin(facts.sessionCloseReason)) {
    return {by: 'justin', kind: 'done', reason: facts.sessionCloseReason};
  }

  // Requests from an export that could not be read are unknown, so neither
  // "all closed" nor "none filed" is a claim this function can make.
  const beadsKnown = facts.beadProblems.length === 0;
  if (
    beadsKnown &&
    facts.requests.total > 0 &&
    facts.requests.closed === facts.requests.total
  ) {
    // R2: closed requests are done only when the work landed — the branch
    // merged (or the session is on the default branch) and a clean tree.
    // Unmeasured git is ❔, never ✅.
    const gitReasons: string[] = [];
    if (!facts.merged.ok) gitReasons.push(facts.merged.reason);
    if (!facts.uncommitted.ok) gitReasons.push(facts.uncommitted.reason);
    if (!facts.merged.ok || !facts.uncommitted.ok) {
      return {kind: 'unknown', reasons: [...new Set(gitReasons)]};
    }
    const notMerged = facts.merged.value === 'notMerged';
    const uncommitted = facts.uncommitted.value;
    if (!notMerged && uncommitted === 0) {
      return {by: 'requests', kind: 'done', reason: null};
    }
    return {kind: 'doneUnmerged', notMerged, uncommitted};
  }

  const lastIsClaude =
    options.asIfYielded || facts.lastMessageRole === 'assistant';
  if (
    beadsKnown &&
    facts.requests.total === 0 &&
    lastIsClaude &&
    // R3: a PARTIAL count (commit evidence that matched no commit) is never
    // "zero commits".
    facts.commits.kind === 'counted' &&
    facts.commits.count === 0 &&
    facts.uncommitted.ok &&
    facts.uncommitted.value === 0
  ) {
    return {kind: 'answered'};
  }

  const reasons: string[] = [];
  if (facts.commits.kind === 'unmeasured') reasons.push(facts.commits.reason);
  if (!facts.uncommitted.ok) reasons.push(facts.uncommitted.reason);
  reasons.push(...facts.beadProblems);
  const unique = [...new Set(reasons)];
  if (unique.length > 0) return {kind: 'unknown', reasons: unique};

  return {kind: 'openWork'};
}

// ---------------------------------------------------------------------------
// From the model
// ---------------------------------------------------------------------------

export function isOpen(issue: {status: string}): boolean {
  return issue.status !== 'closed' && issue.status !== 'tombstone';
}

export function openQuestions(model: SessionModel): TreeIssue[] {
  return model.beads.questions.filter(isOpen);
}

/** R3: the commits measurement as a fact — counted, partial or unmeasured. */
export function commitsFactOf(commits: Measured<SessionCommits>): CommitsFact {
  if (!commits.ok) return {kind: 'unmeasured', reason: commits.reason};
  const unmatched = unmatchedCommitEvidence(commits.value);
  return unmatched > 0
    ? {kind: 'partial', matched: commits.value.count, unmatched}
    : {count: commits.value.count, kind: 'counted'};
}

/** The facts `deriveStatus` reads, taken from a loaded model. */
export function statusFactsOf(model: SessionModel): StatusFacts {
  const {beads, git, transcript} = model;
  const requests = beads.requests.map((node) => node.request);
  const last = lastLogLine(model.log);
  const session = beads.session;
  const problems = [...beads.problems];
  if (session == null && beads.sessionMissing != null) {
    problems.push(beads.sessionMissing);
  }
  return {
    beadProblems: problems,
    commits: commitsFactOf(git.commits),
    contextTokens: transcript.contextTokens.ok
      ? transcript.contextTokens.value
      : null,
    handedOff: session?.labels.includes(HANDED_OFF_LABEL) === true,
    helpersInFlight: transcript.helpers.ok
      ? transcript.helpers.value.map((helper) => helper.lastRecordAt)
      : null,
    lastMessageRole: last.ok && last.value != null ? last.value.role : null,
    lastRecordAt: transcript.lastRecordAt.ok
      ? transcript.lastRecordAt.value
      : null,
    merged: git.merged,
    openP0: openQuestions(model).filter((issue) => issue.priority === 0).length,
    requests: {
      closed: requests.filter((issue) => !isOpen(issue)).length,
      total: requests.length,
    },
    sessionCloseReason:
      session != null && !isOpen(session) ? session.closeReason : null,
    successor:
      session?.labels
        .find((label) => label.startsWith(CONTINUED_BY_LABEL_PREFIX))
        ?.slice(CONTINUED_BY_LABEL_PREFIX.length) ?? null,
    uncommitted: git.uncommitted.ok
      ? measured(git.uncommitted.value.length)
      : unmeasured(git.uncommitted.reason),
    wrapUpAt: model.wrapUpAt,
  };
}

/** What sits beside the status: never part of it (D2). */
export interface StatusCounts {
  /** Open P0 questions. */
  blocking: number;
  /**
   * Commits since the first prompt when NO request was filed; null when a
   * request was filed — not applicable, never a measured 0 (R10).
   */
  commitsWithNoRequest: Measured<number> | null;
  /** Open P4 questions: FYI, not waiting on anyone. */
  fyi: number;
  /** Open P1–P3 questions (a question with no priority counts here too). */
  optional: number;
  /** The same, by priority. */
  optionalByPriority: {p1: number; p2: number; p3: number; unknown: number};
  requestsDone: number;
  requestsTotal: number;
}

export function statusCounts(model: SessionModel): StatusCounts {
  const open = openQuestions(model);
  const byPriority = {p1: 0, p2: 0, p3: 0, unknown: 0};
  for (const issue of open) {
    if (issue.priority === 1) byPriority.p1 += 1;
    else if (issue.priority === 2) byPriority.p2 += 1;
    else if (issue.priority === 3) byPriority.p3 += 1;
    else if (issue.priority !== 0 && issue.priority !== 4) {
      byPriority.unknown += 1;
    }
  }
  const requests = model.beads.requests.map((node) => node.request);
  const commits = model.git.commits;
  return {
    blocking: open.filter((issue) => issue.priority === 0).length,
    commitsWithNoRequest:
      requests.length > 0
        ? null
        : commits.ok
          ? measured(commits.value.count)
          : unmeasured(commits.reason),
    fyi: open.filter((issue) => issue.priority === 4).length,
    optional:
      byPriority.p1 + byPriority.p2 + byPriority.p3 + byPriority.unknown,
    optionalByPriority: byPriority,
    requestsDone: requests.filter((issue) => !isOpen(issue)).length,
    requestsTotal: requests.length,
  };
}

// ---------------------------------------------------------------------------
// Stages (D1 "STAGES")
// ---------------------------------------------------------------------------

export interface StageReached {
  /** The rung after `reached`; null when `reached` is the last. */
  next: string | null;
  /** The highest ladder rung among the bead's `stage:` labels. */
  reached: string;
}

/**
 * The highest stage a bead's labels reach on `ladder`, or null when it carries
 * none of the ladder's names (a `stage:` label off the ladder is ignored — it
 * cannot be placed, which is not the same as "reached nothing", so it is
 * never mistaken for a rung).
 */
export function stageReached(
  labels: readonly string[],
  ladder: readonly string[],
): StageReached | null {
  let best = -1;
  for (const label of labels) {
    if (!label.startsWith(STAGE_LABEL_PREFIX)) continue;
    const index = ladder.indexOf(label.slice(STAGE_LABEL_PREFIX.length));
    if (index > best) best = index;
  }
  const reached = ladder[best];
  if (best < 0 || reached == null) return null;
  return {next: ladder[best + 1] ?? null, reached};
}

// ---------------------------------------------------------------------------
// What to mark (thread status): only what cannot be derived
// ---------------------------------------------------------------------------

export type MarkItem =
  /**
   * home-base-yukaf.3 (D-LAST-REQUEST-WARNING): every request is closed (at
   * least one, every export read). Quotes Justin's first message so the
   * session checks it against what exists before it stops. `firstMessage`:
   * the first user line's text; measured null = the log holds no user line;
   * not measured = the log could not be read (rule 7: said, never dropped).
   */
  | {
      closedCount: number;
      firstMessage: Measured<string | null>;
      kind: 'allRequestsClosed';
    }
  | {kind: 'autoTitle'; sessionBeadId: string; title: string}
  /**
   * home-base-ys9t7.9.1 (componentConfig.thread.titleSummary on; it replaces
   * autoTitle then): the session title no longer covers the conversation.
   * `why`: still the first prompt's line (`autoTitle`); requests filed after
   * the title was last set (`filedSince`, listed in `since`); or two or more
   * requests and no record of when the title was set (`unrecorded`).
   * `continues`: the predecessor this session continues (its `continues:`
   * label), whose summary it extends rather than replaces.
   */
  | {
      continues: string | null;
      kind: 'titleSummary';
      requestCount: number;
      sessionBeadId: string;
      since: TreeIssue[];
      title: string;
      why: 'autoTitle' | 'filedSince' | 'unrecorded';
    }
  | {
      commits: number;
      kind: 'noRequest';
      uncommitted: number;
      /** R3: commit commands / confirmation lines that matched no commit. */
      unmatchedCommits: number;
    }
  | {kind: 'requestChildrenClosed'; request: TreeIssue}
  /**
   * home-base-vzwbj.4.16 G2: the yield would be ⚠️ Open work, and this open
   * request is why — nothing blocks it. Says what to do with it: close it
   * (work done); keep working, or file the P0 it cannot move without (not
   * done; home-base-tg45h).
   */
  | {
      /** Every real child is closed (at least one): what requestChildrenClosed says. */
      childrenAllClosed: boolean;
      kind: 'requestOpenNoBlocker';
      /** Its open OLD-SHAPE question children: closing it needs --force. */
      oldShapeQuestions: TreeIssue[];
      /** Its open children that are not questions: they must close first. */
      openChildren: TreeIssue[];
      /** Its open questions for Justin linked by label (they stay open). */
      openQuestions: TreeIssue[];
      request: TreeIssue;
    }
  /**
   * home-base-vzwbj.4.19 D2: a bead this session created with a plain `br
   * create` that is not a request or a question and hangs under no request —
   * the shape of session 7a59f2e5's decision bead, which Part 1 never saw.
   * `under`: other such beads it created below this one (adopting this one
   * makes them its children), so a filed epic is one line, not one per task.
   */
  | {bead: TreeIssue; kind: 'adoptCandidate'; under: TreeIssue[]}
  /** D2: ids a `br create` in the transcript reported that no export holds. */
  | {kind: 'createdNotFound'; missing: {id: string; searched: string[]}[]}
  /**
   * home-base-j8q3e.13 F6: ids a `br create` call's output named that the call
   * did not create (their created_at is outside its window). One line, so
   * they are said, not silently dropped from the adopt list.
   */
  | {beads: {id: string; why: string}[]; kind: 'createdNotThen'}
  /**
   * D3: every request is closed, but this open question for Justin, or this
   * open bead the session created, is still undecided.
   */
  | {bead: TreeIssue; kind: 'undecided'}
  | {kind: 'unchecked'; reason: string; what: string};

/** Oldest first by created_at, then by id, so the order is stable. */
function byCreatedAt(a: TreeIssue, b: TreeIssue): number {
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/**
 * D2: the beads this session created that nothing in the session tree holds:
 * not the session bead, a request, a request's child or a question; not
 * labelled `request` or `ask` (adopted by any session); and not the child of
 * a request or of a request's child (it already hangs under a request). One
 * entry per topmost bead: a candidate whose parent is another candidate is
 * listed under it. Oldest first.
 */
export function adoptCandidates(
  beads: SessionTree,
  found: readonly TreeIssue[],
): {bead: TreeIssue; under: TreeIssue[]}[] {
  const requestish = new Set<string>();
  for (const node of beads.requests) {
    requestish.add(node.request.id);
    for (const child of node.children) requestish.add(child.id);
  }
  const held = new Set(requestish);
  for (const question of beads.questions) held.add(question.id);
  if (beads.session != null) held.add(beads.session.id);
  const candidates = found.filter(
    (bead) =>
      !held.has(bead.id) &&
      !bead.labels.includes(REQUEST_LABEL) &&
      !bead.labels.includes(ASK_LABEL) &&
      !bead.parentIds.some((parent) => requestish.has(parent)),
  );
  const ids = new Map(candidates.map((bead) => [bead.id, bead]));
  const topOf = (bead: TreeIssue): TreeIssue => {
    let top = bead;
    const seen = new Set<string>([bead.id]);
    for (;;) {
      const parent = top.parentIds
        .map((id) => ids.get(id))
        .find((entry) => entry != null && !seen.has(entry.id));
      if (parent == null) return top;
      seen.add(parent.id);
      top = parent;
    }
  };
  const groups = new Map<string, {bead: TreeIssue; under: TreeIssue[]}>();
  for (const bead of [...candidates].sort(byCreatedAt)) {
    const top = topOf(bead);
    const group = groups.get(top.id) ?? {bead: top, under: []};
    if (top.id !== bead.id) group.under.push(bead);
    groups.set(top.id, group);
  }
  return [...groups.values()].sort((a, b) => byCreatedAt(a.bead, b.bead));
}

/**
 * Every REAL child of the request is closed (at least one). Questions never
 * count (home-base-vzwbj.4.16 G1): an optional question never keeps a request
 * open, and an open P0 blocks through the status, not through closability.
 */
function childrenAllClosed(node: RequestNode): boolean {
  return (
    node.children.length > 0 && node.children.every((child) => !isOpen(child))
  );
}

/** A question that is the request's parent-child child (the old shape). */
function isOldShapeQuestion(node: RequestNode, question: TreeIssue): boolean {
  return question.parentIds.includes(node.request.id);
}

/**
 * home-base-ys9t7.9.1: whether the session title still covers everything this
 * session asked for. Exact when the bead carries `title-set:` (every request
 * filed after it is listed); without one, two or more requests cannot be
 * shown to be covered, so it asks (the cautious side, critical rule 7, and one
 * `thread title` records the time and settles it). A request whose created_at
 * cannot be read is said as unchecked, never counted as covered.
 */
function titleSummaryItems(
  session: TreeIssue,
  beads: SessionModel['beads'],
  hasWork: boolean | null,
): MarkItem[] {
  const base = {
    continues: labelValue(session.labels, CONTINUES_LABEL_PREFIX),
    kind: 'titleSummary' as const,
    requestCount: beads.requests.length,
    sessionBeadId: session.id,
    title: session.title,
  };
  if (session.labels.includes(AUTO_TITLE_LABEL)) {
    return hasWork === false ? [] : [{...base, since: [], why: 'autoTitle'}];
  }
  const requests = beads.requests.map((node) => node.request);
  const set = titleSetAt(session.labels);
  if (set.kind !== 'set') {
    if (requests.length < 2) return [];
    return [{...base, since: [], why: 'unrecorded'}];
  }
  const since: TreeIssue[] = [];
  const unreadable: TreeIssue[] = [];
  for (const request of requests) {
    const at = parseInstant(request.createdAt);
    if (at == null) unreadable.push(request);
    else if (at > set.at) since.push(request);
  }
  const items: MarkItem[] = [];
  if (since.length > 0) {
    items.push({...base, since: since.sort(byCreatedAt), why: 'filedSince'});
  }
  if (unreadable.length > 0) {
    items.push({
      kind: 'unchecked',
      reason: `the created_at of ${unreadable.map((request) => request.id).join(', ')} cannot be read`,
      what: 'whether the session title covers every request',
    });
  }
  return items;
}

/**
 * The conditions `thread status` cannot derive (design item 4): a request
 * whose children are all closed while it is open; commits or uncommitted edits
 * with no request filed; a title still carrying `auto-title`. Plus, under rule
 * 7, a line for each of those that could NOT be checked — "Nothing to mark."
 * must mean checked, never "could not look".
 *
 * home-base-vzwbj.4.16 G2: when the yield would be ⚠️ Open work (`status` is
 * the "if you stop now" verdict), one `requestOpenNoBlocker` per open request
 * says how to get out of it. That verdict means no P0 is open at all, so every
 * open request is unblocked. It SUPERSEDES `requestChildrenClosed` for the
 * same request (carrying `childrenAllClosed`): "say in your message what
 * remains" does not change a ⚠️ verdict, which is how session 4044142e yielded
 * three times on it. Under every other verdict `requestChildrenClosed` fires
 * as before.
 *
 * The auto-title nag is for work sessions only: a question-only session (no
 * request, no commit, no edit) keeps its first line as its name, and prints
 * "Nothing to mark." (epic D3, AC 1).
 *
 * home-base-vzwbj.4.19: `created` is the beads this session made with a plain
 * `br create` (session-created.ts). D2: one `adoptCandidate` per such bead the
 * tree does not hold, a `createdNotFound` for ids no export holds, and an
 * `unchecked` when the transcript could not be read. D3: when every request
 * is closed (at least one), one `undecided` per open question and per open
 * candidate (or open bead under one). home-base-yukaf.3: in that same case,
 * one `allRequestsClosed` first, quoting Justin's first message.
 */
export function whatToMark(
  model: SessionModel,
  status: SessionStatus,
  created: Measured<CreatedBeads>,
  options: {titleSummary?: boolean} = {},
): MarkItem[] {
  const items: MarkItem[] = [];
  const {beads, git} = model;

  for (const problem of beads.problems) {
    items.push({
      kind: 'unchecked',
      reason: problem,
      what: 'the requests and questions in that beads DB',
    });
  }

  const openWork = status.kind === 'openWork';
  for (const node of beads.requests) {
    if (!isOpen(node.request)) continue;
    if (openWork) {
      const open = node.questions.filter(isOpen);
      items.push({
        childrenAllClosed: childrenAllClosed(node),
        kind: 'requestOpenNoBlocker',
        oldShapeQuestions: open.filter((question) =>
          isOldShapeQuestion(node, question),
        ),
        openChildren: node.children.filter(isOpen),
        openQuestions: open.filter(
          (question) => !isOldShapeQuestion(node, question),
        ),
        request: node.request,
      });
    } else if (childrenAllClosed(node)) {
      items.push({kind: 'requestChildrenClosed', request: node.request});
    }
  }

  // D2 (home-base-vzwbj.4.19): beads this session created that are not
  // requests. Rule 7: an unreadable transcript is said, never "none".
  const candidates = created.ok
    ? adoptCandidates(beads, created.value.found)
    : [];
  if (!created.ok) {
    items.push({
      kind: 'unchecked',
      reason: created.reason,
      what: 'which beads this session created',
    });
  } else {
    for (const candidate of candidates) {
      items.push({kind: 'adoptCandidate', ...candidate});
    }
    if (created.value.missing.length > 0) {
      items.push({kind: 'createdNotFound', missing: created.value.missing});
    }
    if (created.value.notCreatedThen.length > 0) {
      items.push({beads: created.value.notCreatedThen, kind: 'createdNotThen'});
    }
  }

  // D3: every request closed, but something the session raised is still
  // undecided. Only P0 blocks; this is a prompt to keep the work visible.
  const allRequestsClosed =
    beads.problems.length === 0 &&
    beads.requests.length > 0 &&
    beads.requests.every((node) => !isOpen(node.request));
  if (allRequestsClosed) {
    // home-base-yukaf.3: first, Justin's first message to check against.
    const first = firstUserLine(model.log);
    items.push({
      closedCount: beads.requests.length,
      firstMessage: first.ok
        ? measured(first.value == null ? null : first.value.text)
        : unmeasured(first.reason),
      kind: 'allRequestsClosed',
    });
    for (const question of openQuestions(model)) {
      items.push({bead: question, kind: 'undecided'});
    }
    for (const candidate of candidates) {
      if (isOpen(candidate.bead) || candidate.under.some(isOpen)) {
        items.push({bead: candidate.bead, kind: 'undecided'});
      }
    }
  }

  const noRequest = beads.requests.length === 0;
  const commits = git.commits.ok
    ? measured(git.commits.value.count)
    : unmeasured<number>(git.commits.reason);
  const uncommitted = git.uncommitted;
  let hasWork: boolean | null = !noRequest ? true : null;
  if (noRequest) {
    if (!commits.ok) {
      items.push({
        kind: 'unchecked',
        reason: commits.reason,
        what: 'commits with no request filed',
      });
    } else if (!uncommitted.ok) {
      items.push({
        kind: 'unchecked',
        reason: uncommitted.reason,
        what: 'uncommitted edits with no request filed',
      });
    } else {
      const unmatchedCommits = git.commits.ok
        ? unmatchedCommitEvidence(git.commits.value)
        : 0;
      const work =
        commits.value > 0 ||
        unmatchedCommits > 0 ||
        uncommitted.value.length > 0;
      hasWork = work;
      if (work) {
        items.push({
          commits: commits.value,
          kind: 'noRequest',
          uncommitted: uncommitted.value.length,
          unmatchedCommits,
        });
      }
    }
  }

  const session = beads.session;
  if (session == null) {
    items.push({
      kind: 'unchecked',
      reason:
        beads.sessionMissing ??
        beads.problems[0] ??
        'the session bead was not found',
      what: "the session's title",
    });
  } else if (options.titleSummary === true) {
    items.push(...titleSummaryItems(session, beads, hasWork));
  } else if (session.labels.includes(AUTO_TITLE_LABEL) && hasWork !== false) {
    items.push({
      kind: 'autoTitle',
      sessionBeadId: session.id,
      title: session.title,
    });
  }
  return items;
}
