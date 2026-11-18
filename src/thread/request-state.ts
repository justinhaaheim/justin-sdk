/**
 * The STATE LINE of one request (home-base-l2ejg.5; D7 in the design field of
 * home-base-l2ejg.3). Justin, 2026-11-13: each request should say "what's the
 * status? Like, if it stopped, why did it stop? If it's working, say that it's
 * working. And like what's needed next."
 *
 * The tool computes it from what it already knows; Claude types nothing. One
 * pure function, `requestStateLine`, reads the request bead, the questions
 * linked to it (`to:`), its stage on the ladder and the status of the session
 * that holds it. `chainRequestState` follows the handoff chain, so a request a
 * successor carries shows the successor's state, never "handed off". Part 1,
 * the inbox text, the dashboard's details and `threads --json` all print what
 * these two return, through `requestStateText` in part-one.ts.
 *
 * Unknown stays unknown (critical rules section 7): an unreadable session
 * status is "Unknown: <why>", a successor that could not be read is said, and
 * a request whose last change has no readable time says so. None of them is
 * ever "Working" or "Done".
 *
 * Nothing here throws on odd data: every field read is null-checked, and
 * `thread status` runs this in every home-base session.
 */

import type {SessionModel} from './session-model';
import type {SessionStatus} from './session-status';
import type {RequestNode, TreeIssue} from './session-tree';

import {parseInstant} from './answer-store';
import {ARCHIVED_PREFIX, oneLine, parseAsk} from './ask-format';
import {exportBehindWords} from './export-behind';
import {questionIdOf, shortIdText} from './question-ids';
import {CONTINUED_BY_LABEL_PREFIX, cutOnWord} from './session-bead';
import {sessionDisplayName, sessionMarksOf} from './session-name';
import {isOpen, stageReached} from './session-status';

// ---------------------------------------------------------------------------
// Landing stages (moved here from session-card.ts so this module needs no
// import of the card; session-card's D3 rule 7 imports them from here)
// ---------------------------------------------------------------------------

/** D4: stages after this one are LANDING stages; rule 7 looks only at them. */
export const LANDED_AFTER_STAGE = 'tested';

/**
 * D4: the landing stages of a ladder — the ones after `tested`. A ladder with
 * no `tested` has none, so rule 7 never fires there (a reading of D4, which
 * defines landing stages only relative to `tested`).
 */
export function landingStages(ladder: readonly string[]): string[] {
  const at = ladder.indexOf(LANDED_AFTER_STAGE);
  return at < 0 ? [] : ladder.slice(at + 1);
}

/**
 * D3 rule 7: the words for each landing stage (D4, amended 2026-10-15: the
 * `approved` line is exactly "Try it, then mark it approved:"). Each ends in
 * the command that marks the stage, so the card can be cleared by whoever
 * did the step.
 */
const LANDING_ACTIONS: Readonly<Record<string, string>> = {
  approved: 'Try it, then mark it approved:',
  built: 'Land it: build the app, then mark it built:',
  'link-sent': 'Land it: send the build link, then mark it link-sent:',
};

/** D3 rule 7's words for a landing stage, ending in a colon. */
export function landingActionText(stage: string): string {
  return (
    LANDING_ACTIONS[stage] ??
    `Land it: reach the ${stage} stage, then mark it ${stage}:`
  );
}

// ---------------------------------------------------------------------------
// The state line
// ---------------------------------------------------------------------------

/**
 * Where the request is now. `working`, `stopped` and `unknown` are the
 * holding session's; `waiting` is an open P0 linked to the request; `done` is
 * a closed request.
 */
export type RequestStateKind =
  | 'done'
  | 'stopped'
  | 'unknown'
  | 'waiting'
  | 'working';

export interface RequestStateLine {
  /**
   * The session that holds the request now, when that is a successor of the
   * session it is shown in (`[TAG][Moe-3] <title>`); null when it is held
   * where it is shown. The state, next and kind are then the successor's.
   */
  carriedBy: string | null;
  kind: RequestStateKind;
  /**
   * What comes next: the next stage on the ladder; "your answer to Q112"
   * when it waits on Justin; "going ahead with: <default>" when an open P1 to
   * P3 question is linked to it; rule 7's landing words for a closed request
   * short of the last stage. Null when nothing is next.
   */
  next: string | null;
  /** The request's last change (its `updated_at`), ISO; null when unreadable. */
  since: string | null;
  /** "Working", "Stopped: <why>", "Waiting on you: Q112 <question>", "Done", "Unknown: <why>". */
  state: string;
}

/** What the holding session says about itself, for its requests' lines. */
export interface RequestHolder {
  /** The session's open questions: the one it waits on is named. */
  openQuestions: readonly TreeIssue[];
  status: SessionStatus;
}

/**
 * The session a request was handed to, as seen from the session it is shown
 * in: it holds the request (its own line for it), it does not, or it could
 * not be read. Null when the session has no successor.
 */
export type RequestCarrier =
  | {kind: 'carries'; line: RequestStateLine; name: string}
  | {kind: 'notCarried'; name: string}
  | {kind: 'unknown'; name: string; reason: string};

/** A question's title in a state line is cut here. */
export const STATE_QUESTION_CUT = 80;

/** `Q<n>` for a new-form id, else the bead id (D2 of home-base-l2ejg.3). */
export function questionShownId(question: {
  id: string;
  labels: readonly string[];
}): string {
  const read = questionIdOf(question.labels);
  return read.kind === 'one' ? shortIdText(read.number) : question.id;
}

/** Oldest first by created_at, then by id; an unreadable time sorts last. */
function byFiling(a: TreeIssue, b: TreeIssue): number {
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  if (at == null && bt != null) return 1;
  if (at != null && bt == null) return -1;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

function blockingQuestions(questions: readonly TreeIssue[]): TreeIssue[] {
  return questions
    .filter((question) => isOpen(question) && question.priority === 0)
    .sort(byFiling);
}

/** "Q112 <title>", the title on one line and cut. */
function questionWords(question: TreeIssue): string {
  return `${questionShownId(question)} ${cutOnWord(oneLine(question.title), STATE_QUESTION_CUT)}`;
}

/**
 * The default of the first open P1 to P3 question linked to the request
 * (highest priority, then oldest), or null. A question whose body does not
 * parse, or that records no default, is skipped: no default is invented.
 */
function goingAheadWith(questions: readonly TreeIssue[]): string | null {
  const optional = questions
    .filter(
      (question) =>
        isOpen(question) &&
        question.priority != null &&
        question.priority >= 1 &&
        question.priority <= 3,
    )
    .sort((a, b) => {
      const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
      return byPriority !== 0 ? byPriority : byFiling(a, b);
    });
  for (const question of optional) {
    const parsed = parseAsk(question.description);
    if (parsed.ok && parsed.ask.default.kind === 'text') {
      const text = oneLine(parsed.ask.default.text);
      if (text !== '') return cutOnWord(text, STATE_QUESTION_CUT);
    }
  }
  return null;
}

/** The request's last change, when br recorded a readable one. */
function sinceOf(request: TreeIssue): string | null {
  const at = request.updatedAt;
  return at != null && parseInstant(at) != null ? at : null;
}

/** Why the holding session stopped, in a few words, from its own status. */
function stoppedWords(
  holder: RequestHolder,
  carrier: RequestCarrier | null,
): {kind: RequestStateKind; state: string} {
  const {status} = holder;
  switch (status.kind) {
    case 'working':
      return {kind: 'working', state: 'Working'};
    case 'waiting': {
      const [first, ...rest] = blockingQuestions(holder.openQuestions);
      const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
      return {
        kind: 'stopped',
        state:
          first == null
            ? `Stopped: the session waits on your answer to ${status.openP0} blocking ${status.openP0 === 1 ? 'question' : 'questions'}`
            : `Stopped: the session waits on your answer to ${questionShownId(first)}${more}`,
      };
    }
    case 'openWork':
      return {kind: 'stopped', state: 'Stopped: open work, no blocker'};
    case 'outOfContext':
      return {kind: 'stopped', state: 'Stopped: past wind-down notice'};
    case 'handedOff': {
      if (carrier?.kind === 'notCarried') {
        return {
          kind: 'stopped',
          state: `Stopped: handed off to ${carrier.name}, which does not hold this request`,
        };
      }
      return {
        kind: 'stopped',
        state:
          status.notPickedUp === true
            ? 'Stopped: handed off, not picked up'
            : 'Stopped: handed off',
      };
    }
    case 'done':
      if (status.by === 'justin') {
        return {
          kind: 'stopped',
          state:
            status.reason?.startsWith(ARCHIVED_PREFIX) === true
              ? 'Stopped: you archived the session'
              : 'Stopped: you marked the session done',
        };
      }
      return {kind: 'stopped', state: 'Stopped: the session is done'};
    case 'doneUnmerged':
      return {kind: 'stopped', state: 'Stopped: done, not merged'};
    case 'answered':
      return {kind: 'stopped', state: 'Stopped: answered'};
    case 'exportBehind':
      return {
        kind: 'unknown',
        state: `Unknown: ${exportBehindWords(status.behind)}`,
      };
    case 'unknown':
      return {
        kind: 'unknown',
        state:
          status.reasons.length === 0
            ? 'Unknown: the session status could not be read'
            : `Unknown: ${status.reasons.join('; ')}`,
      };
  }
}

/**
 * D7: one request's state line, first matching rule wins.
 *
 *  1. Closed → "Done"; next is rule 7's landing step when it is short of the
 *     ladder's last landing stage (a request with no stage is not nagged, D4).
 *  2. Handed to a successor that holds it → the successor's own line, named.
 *  3. An open P0 linked to it → "Waiting on you: <id> <question>".
 *  4. A successor that could not be read → "Unknown: …", never "handed off".
 *  5. Otherwise the holding session's status: Working, Stopped: <why>, or
 *     Unknown: <why>.
 *
 * Next, for 3 to 5: "your answer to <id>" when waiting; else the default of
 * an open P1 to P3 question linked to it; else the next stage on the ladder
 * (the first one when none is marked); else null.
 */
export function requestStateLine(input: {
  carrier: RequestCarrier | null;
  holder: RequestHolder;
  ladder: readonly string[];
  node: RequestNode;
}): RequestStateLine {
  const {carrier, holder, ladder, node} = input;
  const {request} = node;
  const since = sinceOf(request);
  const reached = stageReached(request.labels, ladder);

  if (!isOpen(request)) {
    let next: string | null = null;
    const landing = landingStages(ladder);
    if (reached != null && landing.length > 0) {
      const firstLanding = ladder.length - landing.length;
      const index = Math.max(ladder.indexOf(reached.reached) + 1, firstLanding);
      const stage = ladder[index];
      if (stage != null) next = landingActionText(stage).replace(/:$/u, '');
    }
    return {carriedBy: null, kind: 'done', next, since, state: 'Done'};
  }

  if (carrier?.kind === 'carries') {
    return {
      ...carrier.line,
      carriedBy: carrier.line.carriedBy ?? carrier.name,
      since,
    };
  }

  const blocking = blockingQuestions(node.questions);
  const [first, ...rest] = blocking;
  if (first != null) {
    const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
    return {
      carriedBy: null,
      kind: 'waiting',
      next: `your answer to ${questionShownId(first)}`,
      since,
      state: `Waiting on you: ${questionWords(first)}${more}`,
    };
  }

  const ahead = goingAheadWith(node.questions);
  const next =
    ahead != null
      ? `going ahead with: ${ahead}`
      : reached == null
        ? (ladder[0] ?? null)
        : reached.next;

  if (carrier?.kind === 'unknown') {
    return {
      carriedBy: null,
      kind: 'unknown',
      next,
      since,
      state: `Unknown: handed off to ${carrier.name}, which could not be read (${carrier.reason})`,
    };
  }

  const words = stoppedWords(holder, carrier);
  return {carriedBy: null, kind: words.kind, next, since, state: words.state};
}

// ---------------------------------------------------------------------------
// The handoff chain
// ---------------------------------------------------------------------------

/** One session of a handoff chain, as the state lines read it. */
export interface ChainSession {
  /** The session bead's labels (`continued-by:` names the successor). */
  labels: readonly string[];
  /** The repo's stage ladder. */
  ladder: readonly string[];
  /** `[TAG][Moe-3] <title>`, as lists name it. */
  name: string;
  openQuestions: readonly TreeIssue[];
  requests: readonly RequestNode[];
  status: SessionStatus;
}

/**
 * A loaded session as a chain link: its own requests, questions and status.
 * `chainNames` is componentConfig.thread.chainNames as the caller resolved it
 * (home-base-l2ejg.11): on, the name reads `[TAG][Moe-2] <title>` as every
 * other surface names it; off, `[TAG][#2] <title>`. Never read from config
 * here: this module stays pure.
 */
export function chainSessionOf(
  model: Pick<
    SessionModel,
    'beads' | 'exportBehind' | 'repoTag' | 'sessionId' | 'stages'
  >,
  status: SessionStatus,
  options: {chainNames: boolean},
): ChainSession {
  // `thread status` runs this in every session: an odd or partial model (no
  // ladder, no question list) gives empty lists, never a throw.
  const bead = model.beads.session;
  const labels = Array.isArray(bead?.labels) ? bead.labels : [];
  const title = bead?.title ?? model.exportBehind?.title ?? model.sessionId;
  return {
    labels,
    ladder: Array.isArray(model.stages) ? model.stages : [],
    name: sessionDisplayName(
      model.repoTag,
      title,
      sessionMarksOf(labels, {chainNames: options.chainNames}),
    ),
    openQuestions: Array.isArray(model.beads.questions)
      ? model.beads.questions.filter(isOpen)
      : [],
    requests: Array.isArray(model.beads.requests) ? model.beads.requests : [],
    status,
  };
}

/** A successor looked up by its session bead id. */
export type ChainLookup = (
  beadId: string,
) => {kind: 'found'; session: ChainSession} | {kind: 'unknown'; reason: string};

/** How many successors a state line follows before it says unknown. */
export const CHAIN_STATE_LIMIT = 20;

/** The first `continued-by:` label's bead id, or null. */
export function successorBeadOf(labels: readonly string[]): string | null {
  const label = labels.find((entry) =>
    entry.startsWith(CONTINUED_BY_LABEL_PREFIX),
  );
  const id = label?.slice(CONTINUED_BY_LABEL_PREFIX.length).trim() ?? '';
  return id === '' ? null : id;
}

/**
 * The state line of a request held by `session`, following `continued-by:`
 * through `lookup`: when the successor holds the request too (the pickup
 * gave it the successor's `sid:` label), the line is the successor's, and so
 * on down the chain. A loop, or a chain longer than `limit`, is unknown.
 */
export function chainRequestState(input: {
  limit?: number;
  lookup: ChainLookup;
  node: RequestNode;
  session: ChainSession;
}): RequestStateLine {
  const limit = input.limit ?? CHAIN_STATE_LIMIT;
  const seen = new Set<string>();
  const walk = (
    session: ChainSession,
    node: RequestNode,
    depth: number,
  ): RequestStateLine => {
    const successor = successorBeadOf(session.labels);
    let carrier: RequestCarrier | null = null;
    if (successor != null && isOpen(node.request)) {
      if (seen.has(successor) || depth >= limit) {
        carrier = {
          kind: 'unknown',
          name: successor,
          reason:
            depth >= limit
              ? `the handoff chain is longer than ${limit} sessions`
              : 'the handoff chain loops',
        };
      } else {
        seen.add(successor);
        const found = input.lookup(successor);
        if (found.kind === 'unknown') {
          carrier = {kind: 'unknown', name: successor, reason: found.reason};
        } else {
          const held = found.session.requests.find(
            (entry) => entry.request.id === node.request.id,
          );
          carrier =
            held == null
              ? {kind: 'notCarried', name: found.session.name}
              : {
                  kind: 'carries',
                  line: walk(found.session, held, depth + 1),
                  name: found.session.name,
                };
        }
      }
    }
    return requestStateLine({
      carrier,
      holder: {openQuestions: session.openQuestions, status: session.status},
      ladder: session.ladder,
      node,
    });
  };
  return walk(input.session, input.node, 0);
}

/**
 * The state line of every request a session holds, by request id. Never
 * throws: a request whose line cannot be computed gets an Unknown line that
 * says so.
 */
export function requestStatesOf(input: {
  lookup: ChainLookup;
  session: ChainSession;
}): Map<string, RequestStateLine> {
  const states = new Map<string, RequestStateLine>();
  for (const node of input.session.requests) {
    let line: RequestStateLine;
    try {
      line = chainRequestState({
        lookup: input.lookup,
        node,
        session: input.session,
      });
    } catch (error) {
      line = {
        carriedBy: null,
        kind: 'unknown',
        next: null,
        since: null,
        state: `Unknown: the state line could not be computed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    states.set(node.request.id, line);
  }
  return states;
}

/** A lookup that reads nothing: every successor is said as not looked up. */
export const NO_CHAIN_LOOKUP: ChainLookup = () => ({
  kind: 'unknown',
  reason: 'the next session was not looked up',
});
