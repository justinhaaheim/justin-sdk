/**
 * The DASHBOARD CARD of one session (epic home-base-j8q3e.1 design D2, D3, D4,
 * D5; built by home-base-j8q3e.1.1). It answers Justin's three questions
 * without him opening the session (his words, 2026-10-15, in home-base-vzwbj
 * under THE REQUEST IS THE UNIT): what was I working on (You asked), where is
 * it now (Where it is), and what do I need to do to land it (You need to).
 *
 * TWO PURE FUNCTIONS, NOTHING ELSE COMPUTES:
 *  - `deriveAction` is D3: ONE "You need to" line per session, first matching
 *    rule wins, rules 1 to 10. It reads the session model and the status
 *    `deriveStatus` already derived; it never changes that status (v4 D2,
 *    home-base-vzwbj.4) — it only adds the action and, through `sectionFor`,
 *    the section (D5).
 *  - `buildCard` is D2: the card's fields, as data. The inbox renders it as
 *    markdown (piped) or ANSI (TTY), and `thread inbox --json` emits it whole,
 *    so the TUI (child .3) reads the same model (D1).
 *
 * CRITICAL RULE 7. A fact that could not be measured never yields a
 * reassuring line: an unknown status is rule 10 ("Check it by hand: <why>"),
 * and so is a session the inbox could not load at all (`unreadableAction`).
 * A count that could not be taken is said as unknown, never as 0.
 */

import type {MergeState, SessionModel} from './session-model';
import type {SessionStatus, StatusCounts} from './session-status';
import type {TreeIssue} from './session-tree';

import {sdkRun} from '../sdk-invocation';
import {ARCHIVED_PREFIX, oneLine, parseAsk} from './ask-format';
import {sortAsks} from './ask-render';
import {FIRST_MESSAGE_CUT, firstLineOf, tildeText} from './part-one';
import {firstUserLine} from './session-model';
import {isOpen, openQuestions, stageReached} from './session-status';

// ---------------------------------------------------------------------------
// Sections (D5)
// ---------------------------------------------------------------------------

export type InboxSection =
  | 'answered'
  | 'archived'
  | 'checkByHand'
  | 'done'
  | 'doneQuestions'
  | 'handedOff'
  | 'needsYou'
  | 'notTracked'
  | 'stoppedOpen'
  | 'toLand'
  | 'working';

/**
 * D5's sections, in the `--by-status` order. `checkByHand` (D3 rule 10) is NOT
 * in D5's list: D5 names no section for an unknown status, and putting it under
 * "Stopped with work open" would claim work is open when nothing is known — a
 * deviation recorded on home-base-j8q3e.1.1. "❔ Not tracked" is D6
 * (home-base-j8q3e.1.2): every session with no session bead, whatever its
 * facts say, so it never claims a status it cannot know.
 */
export const INBOX_SECTIONS: readonly {
  emoji: string;
  key: InboxSection;
  onlyWithAll: boolean;
  title: string;
}[] = [
  {emoji: '🛑', key: 'needsYou', onlyWithAll: false, title: 'Needs you'},
  {emoji: '🛬', key: 'toLand', onlyWithAll: false, title: 'To land'},
  {
    emoji: '⚠️',
    key: 'stoppedOpen',
    onlyWithAll: false,
    title: 'Stopped with work open',
  },
  {emoji: '❔', key: 'checkByHand', onlyWithAll: false, title: 'Check by hand'},
  {emoji: '🏃', key: 'working', onlyWithAll: false, title: 'Working'},
  {
    emoji: '🤝',
    key: 'handedOff',
    onlyWithAll: false,
    title: 'Handed off or out of context',
  },
  {emoji: '💬', key: 'answered', onlyWithAll: false, title: 'Answered'},
  // home-base-vzwbj.4.16 G4: a Done session with an open P1 or P2 question
  // stays in the default view — he has something to decide, optionally.
  {
    emoji: '✅',
    key: 'doneQuestions',
    onlyWithAll: false,
    title: 'Done, with questions for you',
  },
  {emoji: '❔', key: 'notTracked', onlyWithAll: false, title: 'Not tracked'},
  {emoji: '✅', key: 'done', onlyWithAll: true, title: 'Done'},
  {emoji: '🗄️', key: 'archived', onlyWithAll: true, title: 'Archived'},
];

export function sectionInfo(
  key: InboxSection,
): (typeof INBOX_SECTIONS)[number] {
  const found = INBOX_SECTIONS.find((section) => section.key === key);
  if (found == null) throw new Error(`no inbox section ${key}`);
  return found;
}

// ---------------------------------------------------------------------------
// D3: the "You need to" line
// ---------------------------------------------------------------------------

/** D3's rule numbers; the JSON record carries the one that fired. */
export type ActionRule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface ActionLine {
  /** A command to copy, printed after the text; null when the text is all. */
  command: string | null;
  rule: ActionRule;
  /** The words, as D3 gives them (the player's small changes are reported). */
  text: string;
}

/**
 * A card's "You need to" line. A tracked session's is always a D3 rule; an
 * untracked session's (D6, home-base-j8q3e.1.2) is rule 2, 4, 6 or 10 when one
 * applies, else D6's own "Read Claude's last reply", which is no D3 rule
 * (`rule: null`).
 */
export interface CardAction {
  command: string | null;
  rule: ActionRule | null;
  text: string;
}

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

/**
 * D3 rule 7: the first landing stage that a CLOSED request has not reached,
 * taken over every closed request (the least-landed one decides), with that
 * request. D4 (amended 2026-10-15): only a request with at least one stage of
 * its ladder marked counts — a closed request with none (an investigation,
 * say) is not a build and is never nagged. Null when the ladder has no
 * landing stages, or no closed request with a stage is short of the last one.
 */
export function unlandedStage(
  model: Pick<SessionModel, 'beads' | 'stages'>,
): {request: TreeIssue; stage: string} | null {
  const ladder = model.stages;
  const landing = landingStages(ladder);
  if (landing.length === 0) return null;
  const firstLanding = ladder.length - landing.length;
  let least: {index: number; request: TreeIssue} | null = null;
  for (const node of model.beads.requests) {
    if (isOpen(node.request)) continue;
    const reached = stageReached(node.request.labels, model.stages);
    if (reached == null) continue;
    const reachedIndex = ladder.indexOf(reached.reached);
    const next = Math.max(reachedIndex + 1, firstLanding);
    if (next >= ladder.length) continue;
    if (least == null || next < least.index) {
      least = {index: next, request: node.request};
    }
  }
  if (least == null) return null;
  const stage = ladder[least.index];
  return stage == null ? null : {request: least.request, stage};
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A session bead's notes say `thread handoff` ran (session-marks appendNote). */
function hasHandoffNote(notes: string | null): boolean {
  return notes != null && /^- [^\n]*: handed off(?: —|$)/mu.test(notes);
}

/** Rule 5's words when no request was filed: what work Claude left. */
function workWithoutRequest(model: SessionModel): string[] {
  const parts: string[] = [];
  const commits = model.git.commits;
  if (commits.ok && commits.value.count > 0) {
    parts.push(plural(commits.value.count, 'commit', 'commits'));
  }
  if (
    commits.ok &&
    commits.value.source === 'transcript' &&
    commits.value.unmatchedCalls.length > 0
  ) {
    parts.push('commits made in another checkout');
  }
  const uncommitted = model.git.uncommitted;
  if (uncommitted.ok && uncommitted.value.length > 0) {
    parts.push(
      plural(uncommitted.value.length, 'uncommitted file', 'uncommitted files'),
    );
  }
  return parts;
}

/**
 * The checkout's git facts a card reads: every measurement of GitMeasurements
 * except the session's own commits, so an untracked session's checkout
 * (home-base-j8q3e.1.2) feeds the same words as a tracked one's.
 */
export type CardGitInput = Pick<
  SessionModel['git'],
  | 'aheadOfDefault'
  | 'branch'
  | 'defaultBranch'
  | 'merged'
  | 'uncommitted'
  | 'unpushed'
>;

/** D3 rule 6's words: what landing the work takes. */
export function landItText(
  git: CardGitInput,
  landing: {notMerged: boolean; uncommitted: number},
): string {
  const branch = git.branch.ok ? git.branch.value : 'its branch';
  const target = git.defaultBranch.ok
    ? git.defaultBranch.value
    : 'the default branch';
  const files = plural(
    landing.uncommitted,
    'uncommitted file',
    'uncommitted files',
  );
  const ahead = git.aheadOfDefault.ok
    ? ` (${plural(git.aheadOfDefault.value, 'commit', 'commits')})`
    : '';
  if (landing.notMerged && landing.uncommitted > 0) {
    return `Land it: commit the ${files} on ${branch}, then merge it into ${target}${ahead}`;
  }
  if (landing.notMerged)
    return `Land it: merge ${branch} into ${target}${ahead}`;
  return `Land it: commit the ${files} on ${branch}`;
}

export interface ActionInput {
  model: SessionModel;
  status: SessionStatus;
  /**
   * The successor's Claude session id (`continued-by:` resolved through the
   * sessions index); null when no successor is known or it has no index line.
   */
  successorSessionId: string | null;
}

/**
 * D3: the ONE thing Justin does, first matching rule wins. Pure: the same
 * model, status and successor give the same line.
 */
export function deriveAction(input: ActionInput): ActionLine {
  const {model, status, successorSessionId} = input;
  const showCommand = sdkRun(`thread show ${model.sessionBeadId}`);
  switch (status.kind) {
    // Rule 1: an open P0. The first (P0s keep their filing order), and how
    // many more; "Do:" for a --do ask, which is his to carry out.
    case 'waiting': {
      const blocking = sortAsks(
        openQuestions(model).filter((question) => question.priority === 0),
      );
      const [first] = blocking;
      const parsed = first == null ? null : parseAsk(first.description);
      const verb =
        parsed?.ok === true && parsed.ask.form === 'do' ? 'Do' : 'Answer';
      const more =
        blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : '';
      return {
        command: sdkRun(`thread answer ${model.sessionBeadId}`),
        rule: 1,
        text:
          first == null
            ? `Answer the ${plural(status.openP0, 'blocking question', 'blocking questions')}`
            : `${verb}: ${oneLine(first.title)}${more}`,
      };
    }
    case 'working':
      return {command: null, rule: 2, text: 'Nothing yet. Claude is working.'};
    case 'handedOff':
      return successorSessionId != null
        ? {
            command: `claude --resume ${successorSessionId}`,
            rule: 3,
            text: 'Continue in the next session:',
          }
        : {
            command: showCommand,
            rule: 3,
            text: "Continue in a new session. Claude's handoff is in its last message:",
          };
    case 'outOfContext':
      // A successor already exists only when a new session ran `thread
      // request --continues` without the old one being labelled handed off.
      if (successorSessionId != null) {
        return {
          command: `claude --resume ${successorSessionId}`,
          rule: 4,
          text: 'Continue in the next session:',
        };
      }
      return hasHandoffNote(model.beads.session?.notes ?? null)
        ? {
            command: showCommand,
            rule: 4,
            text: "Start a fresh session from its handoff. The handoff is in Claude's last message:",
          }
        : {
            command: null,
            rule: 4,
            text: 'Resume it and ask Claude for a handoff.',
          };
    case 'openWork': {
      const requests = model.beads.requests.map((node) => node.request);
      if (requests.length > 0) {
        const open = requests.filter(isOpen).length;
        return {
          command: null,
          rule: 5,
          text: `Claude stopped with ${open} of ${plural(requests.length, 'request', 'requests')} unfinished and no question for you. Resume it and say continue.`,
        };
      }
      const work = workWithoutRequest(model);
      return {
        command: null,
        rule: 5,
        text:
          work.length > 0
            ? `Claude stopped with ${work.join(' and ')}, no request filed, and no question for you. Resume it and say continue.`
            : 'Claude stopped before answering your last message, and has no question for you. Resume it and say continue.',
      };
    }
    case 'doneUnmerged':
      return {
        command: null,
        rule: 6,
        text: landItText(model.git, {
          notMerged: status.notMerged,
          uncommitted: status.uncommitted,
        }),
      };
    case 'done': {
      // Rule 7 is for the requests' own done; Justin's `thread done` /
      // `thread archive` is his decision and is not second-guessed.
      if (status.by === 'requests') {
        const unlanded = unlandedStage(model);
        if (unlanded != null) {
          return {
            command: sdkRun(
              `thread stage ${unlanded.request.id} ${unlanded.stage} --session ${model.sessionId}`,
            ),
            rule: 7,
            text:
              LANDING_ACTIONS[unlanded.stage] ??
              `Land it: reach the ${unlanded.stage} stage, then mark it ${unlanded.stage}:`,
          };
        }
      }
      return {command: null, rule: 9, text: 'Nothing. You can close its pane.'};
    }
    case 'answered':
      return {
        command: showCommand,
        rule: 8,
        text: 'Nothing. Read the answer if you have not:',
      };
    case 'unknown':
      return {
        command: null,
        rule: 10,
        text: `Check it by hand: ${tildeText(status.reasons.join('; '))}`,
      };
  }
}

/** Rule 10 for a session the inbox could not load at all. */
export function unreadableAction(detail: string): ActionLine {
  return {
    command: null,
    rule: 10,
    text: `Check it by hand: ${tildeText(detail)}`,
  };
}

/** D5: the section a card goes in, from the rule that fired. */
export function sectionFor(
  rule: ActionRule,
  status: SessionStatus | null,
  counts: Pick<StatusCounts, 'optionalByPriority'> | null,
): InboxSection {
  switch (rule) {
    case 1:
      return 'needsYou';
    case 2:
      return 'working';
    case 3:
    case 4:
      return 'handedOff';
    case 5:
      return 'stoppedOpen';
    case 6:
    case 7:
      return 'toLand';
    case 8:
      return 'answered';
    case 10:
      return 'checkByHand';
    case 9:
      if (
        status?.kind === 'done' &&
        status.by === 'justin' &&
        status.reason?.startsWith(ARCHIVED_PREFIX) === true
      ) {
        return 'archived';
      }
      return counts != null &&
        counts.optionalByPriority.p1 + counts.optionalByPriority.p2 > 0
        ? 'doneQuestions'
        : 'done';
  }
}

// ---------------------------------------------------------------------------
// D2: the card
// ---------------------------------------------------------------------------

/** D2: "At most 5, then 'and N more'". */
export const CARD_REQUESTS_SHOWN = 5;

/** D2 "Optional": the open P1–P4 questions, with the command that answers them. */
export interface OptionalLine {
  command: string;
  count: number;
  text: string;
}

/**
 * D2 "Optional", or null when no P1–P4 question is open. Shared with status
 * report Part 1 (home-base-j8q3e.1.7.2), so the card and Part 1 say the same.
 */
export function optionalLine(
  counts: Pick<StatusCounts, 'fyi' | 'optional'>,
  sessionBeadId: string,
): OptionalLine | null {
  const count = counts.optional + counts.fyi;
  if (count === 0) return null;
  return {
    command: sdkRun(`thread answer ${sessionBeadId}`),
    count,
    text: `${plural(count, 'optional question', 'optional questions')}; ${count === 1 ? 'its default applies if you skip it' : 'their defaults apply if you skip them'}. To answer:`,
  };
}

export interface CardRequest {
  /** ✅ closed · 🛑 open with an open P0 linked to it · 🔲 open. */
  icon: string;
  id: string;
  /** The rung after `stage`; null when `stage` is null or the last rung. */
  nextStage: string | null;
  /** The highest ladder stage its labels reach; null when none is marked. */
  stage: string | null;
  state: 'blocked' | 'closed' | 'open';
  title: string;
}

export type YouAsked =
  /** Every request, oldest first; the printed card shows the first five. */
  | {kind: 'requests'; requests: CardRequest[]}
  /** No request filed: his first message, one line; null = none captured. */
  | {firstMessage: string | null; kind: 'noRequest'}
  /**
   * D6 (home-base-j8q3e.1.2): a session with no session bead has no requests
   * to read, only his first message (one line; null = none captured).
   */
  | {firstMessage: string | null; kind: 'untracked'}
  /**
   * The requests could not be read, so neither a list nor "none" is claimed;
   * his first message still says what the session was for (null = none).
   */
  | {firstMessage: string | null; kind: 'unknown'; reason: string};

/** One labelled git fact under "Where it is" (D2: only those that matter). */
export interface CardFact {
  label: string;
  value: string;
}

export interface SessionCard {
  action: CardAction;
  /** "3 hours ago"; null when nothing dates the last activity. */
  age: string | null;
  /** The status emoji the card's heading starts with. */
  emoji: string;
  /** Branch / Uncommitted / Unpushed / Checkout / Could not read. */
  facts: CardFact[];
  /** The open P1–P4 questions (D2 "Optional"), or null when there are none. */
  optional: OptionalLine | null;
  /** The cmux pane, when one is recorded. */
  pane: string | null;
  repo: string | null;
  resume: string;
  section: InboxSection;
  sectionEmoji: string;
  sectionTitle: string;
  /** The derived status in words ("Where it is"). */
  status: string;
  title: string;
  youAsked: YouAsked;
}

/** The compact git facts of the JSON record; null for an unloaded session. */
export interface CardGit {
  aheadOfDefault: SessionModel['git']['aheadOfDefault'];
  branch: SessionModel['git']['branch'];
  defaultBranch: SessionModel['git']['defaultBranch'];
  merged: SessionModel['git']['merged'];
  uncommitted: {ok: false; reason: string} | {ok: true; value: number};
  unpushed: SessionModel['git']['unpushed'];
}

export function cardGit(git: CardGitInput): CardGit {
  return {
    aheadOfDefault: git.aheadOfDefault,
    branch: git.branch,
    defaultBranch: git.defaultBranch,
    merged: git.merged,
    uncommitted: git.uncommitted.ok
      ? {ok: true, value: git.uncommitted.value.length}
      : {ok: false, reason: git.uncommitted.reason},
    unpushed: git.unpushed,
  };
}

/** "Where it is": the derived status in words, short — the facts say the rest. */
export function whereWords(status: SessionStatus): string {
  switch (status.kind) {
    case 'waiting':
      return `🛑 Waiting on you (${plural(status.openP0, 'blocking question', 'blocking questions')})`;
    case 'working':
      return '🏃 Working';
    case 'handedOff':
      return '🤝 Handed off';
    case 'outOfContext':
      return '🧯 Out of context';
    case 'done':
      if (status.by === 'requests') return '✅ Done';
      if (status.reason?.startsWith(ARCHIVED_PREFIX) === true) {
        return `✅ Archived by you (${status.reason.slice(ARCHIVED_PREFIX.length)})`;
      }
      return '✅ Done (you marked it done)';
    case 'doneUnmerged':
      return '🔀 Done, not merged: every request is closed, but the work is not landed';
    case 'answered':
      return '💬 Answered';
    case 'unknown':
      return '❔ Unknown';
    case 'openWork':
      return '⚠️ Open work, no blocker';
  }
}

const CHECKOUT_UNREADABLE = 'checkout unreadable:';

function unknownBecause(reason: string): string {
  return `unknown (${tildeText(reason)})`;
}

function branchFact(git: CardGitInput): CardFact | null {
  if (!git.branch.ok)
    return {label: 'Branch', value: unknownBecause(git.branch.reason)};
  const name = git.branch.value === 'HEAD' ? 'detached HEAD' : git.branch.value;
  const target = git.defaultBranch.ok
    ? git.defaultBranch.value
    : 'the default branch';
  const merged = git.merged;
  if (!merged.ok) {
    return {
      label: 'Branch',
      value: `${name}, whether it is merged into ${target} is unknown (${tildeText(merged.reason)})`,
    };
  }
  const state: MergeState = merged.value;
  if (state === 'isDefault') return null;
  if (state === 'merged')
    return {label: 'Branch', value: `${name}, merged into ${target}`};
  const ahead = git.aheadOfDefault.ok
    ? plural(git.aheadOfDefault.value, 'commit', 'commits')
    : `commits not counted: ${tildeText(git.aheadOfDefault.reason)}`;
  return {
    label: 'Branch',
    value: `${name}, not merged into ${target} (${ahead})`,
  };
}

/**
 * D2 "Where it is": only the git facts that matter, one per line. Shared by
 * the untracked cards (D6, home-base-j8q3e.1.2).
 */
export function gitFacts(git: CardGitInput): CardFact[] {
  if (!git.branch.ok && git.branch.reason.startsWith(CHECKOUT_UNREADABLE)) {
    return [
      {
        label: 'Checkout',
        value: `⚠️ ${tildeText(git.branch.reason.slice(CHECKOUT_UNREADABLE.length).trim())}`,
      },
    ];
  }
  const facts: CardFact[] = [];
  const branch = branchFact(git);
  if (branch != null) facts.push(branch);
  if (!git.uncommitted.ok) {
    facts.push({
      label: 'Uncommitted',
      value: unknownBecause(git.uncommitted.reason),
    });
  } else if (git.uncommitted.value.length > 0) {
    facts.push({
      label: 'Uncommitted',
      value: plural(git.uncommitted.value.length, 'file', 'files'),
    });
  }
  // No Unpushed line (home-base-j8q3e.1.10 F4): unpushed commits belong to
  // the CHECKOUT, so a default branch ahead of origin put the same line on
  // every session in it, and pushing is not part of landing (v4 D2). Part 1
  // keeps it in its repo facts; the JSON keeps `git.unpushed`.
  return facts;
}

function youAskedOf(model: SessionModel): YouAsked {
  const {beads} = model;
  if (beads.requests.length === 0) {
    const first = firstUserLine(model.log);
    const firstMessage =
      first.ok && first.value != null
        ? firstLineOf(first.value.text, FIRST_MESSAGE_CUT)
        : null;
    if (beads.problems.length > 0) {
      return {
        firstMessage,
        kind: 'unknown',
        reason: tildeText(beads.problems.join('; ')),
      };
    }
    return {firstMessage, kind: 'noRequest'};
  }
  const blocked = new Set(
    openQuestions(model)
      .filter((question) => question.priority === 0)
      .flatMap((question) =>
        beads.requests
          .filter((node) =>
            node.questions.some((linked) => linked.id === question.id),
          )
          .map((node) => node.request.id),
      ),
  );
  return {
    kind: 'requests',
    requests: beads.requests.map((node) => {
      const reached = stageReached(node.request.labels, model.stages);
      const open = isOpen(node.request);
      const state = !open
        ? 'closed'
        : blocked.has(node.request.id)
          ? 'blocked'
          : 'open';
      return {
        icon: state === 'closed' ? '✅' : state === 'blocked' ? '🛑' : '🔲',
        id: node.request.id,
        nextStage: reached?.next ?? null,
        stage: reached?.reached ?? null,
        state,
        title: node.request.title,
      };
    }),
  };
}

function paneOf(model: SessionModel): string | null {
  if (model.cmux.workspace != null) {
    return `cmux select-workspace --workspace ${model.cmux.workspace}`;
  }
  return model.cmux.surface == null
    ? null
    : `cmux surface ${model.cmux.surface} (no workspace id recorded)`;
}

export interface CardInput {
  action: ActionLine;
  age: string | null;
  counts: StatusCounts;
  model: SessionModel;
  section: InboxSection;
  status: SessionStatus;
  title: string;
  /** What in the model could not be read (the inbox's `unreadable`), or null. */
  unreadable: string | null;
}

/** D2: a loaded session's card. */
export function buildCard(input: CardInput): SessionCard {
  const {action, counts, model, section, status} = input;
  const where = whereWords(status);
  const facts = gitFacts(model.git);
  // Rule 10 already says what could not be read; any other line would hide it.
  if (input.unreadable != null && action.rule !== 10) {
    facts.push({label: 'Could not read', value: tildeText(input.unreadable)});
  }
  const info = sectionInfo(section);
  return {
    action,
    age: input.age,
    emoji: where.split(' ')[0] ?? '❔',
    facts,
    optional: optionalLine(counts, model.sessionBeadId),
    pane: paneOf(model),
    repo: model.repo,
    resume: `claude --resume ${model.sessionId}`,
    section,
    sectionEmoji: info.emoji,
    sectionTitle: info.title,
    status: where,
    title: input.title,
    youAsked: youAskedOf(model),
  };
}

/** D2 for a session the inbox could not load: what it knows, and rule 10. */
export function unreadableCard(input: {
  age: string | null;
  detail: string;
  repo: string | null;
  sessionId: string;
  title: string;
}): SessionCard {
  const info = sectionInfo('checkByHand');
  return {
    action: unreadableAction(input.detail),
    age: input.age,
    emoji: '❔',
    facts: [],
    optional: null,
    pane: null,
    repo: input.repo,
    resume: `claude --resume ${input.sessionId}`,
    section: 'checkByHand',
    sectionEmoji: info.emoji,
    sectionTitle: info.title,
    status: '❔ Unknown (this session could not be loaded)',
    title: input.title,
    youAsked: {
      firstMessage: null,
      kind: 'unknown',
      reason: 'the session could not be loaded',
    },
  };
}
