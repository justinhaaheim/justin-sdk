/**
 * `thread ask` — Claude files a question for Justin as a bead, at the moment
 * it needs the answer (status report v4, epic home-base-vzwbj.4 D1/D3; built
 * by home-base-vzwbj.4.2).
 *
 *   thread ask "<one-line question>" --priority <0-4> [--header "<≤12>"]
 *       [--context "<text>"]… [--option "<Label>: <why>"]… [--recommend <a|b|…>]
 *       [--default "<what I do if he never answers>"] [--to <bead id>]
 *       [--do | --approve]
 *
 * Creates ONE `question` bead (priority = the ask's, labels `ask` +
 * `sid:<session id>`) in the beads DB that holds the session bead, as a CHILD
 * OF THE SESSION BEAD (home-base-vzwbj.4.16 G1). The request it is for —
 * `--to`, else the session's only in-progress request — is a `to:` label
 * (`toLabel`), never a parent: br will not close a parent with open children,
 * and an optional question must never keep a request open. RETRACTED: the
 * question as a child of its request (epic D1 before 2026-10-12).
 * The structured fields go into the description in the grammar of
 * ask-format.ts. It does NOT block: the turn goes on (AskUserQuestion holds the
 * turn, which is the pane-sits-waiting pattern this replaces — D3).
 *
 * The P0–P4 calibration is the status-report rule's, unchanged (Justin,
 * 2026-10-11): P0 = the session stops without it, so it has NO default; P1–P3
 * need `--default`; P4 is FYI and may have none.
 *
 * Exit: 0 filed · 1 refused for a reason outside the ask (no session, knob
 * off, br failed) · 2 the ask itself is invalid (one-line reason).
 */

import type {OutputStyle} from '../cli-style';
import type {AskDefault, AskFields, AskForm, AskOption} from './ask-format';
import type {EnvLike} from './paths';
import type {IdQuestion} from './question-ids';
import type {SessionBeadRepair} from './session-repair';
import type {FoundSession} from './session-select';

import {
  brCreate,
  brList,
  brShow,
  describeBrFailed,
  findBeadsWorkspace,
} from '../beads/br';
import {outputStyle} from '../cli-style';
import {
  ASK_LABEL,
  HEADER_MAX,
  oneLine,
  optionIndex,
  optionLetter,
  P0_NO_DEFAULT,
  P4_NO_DEFAULT,
  parseOptionFlag,
  QUESTION_BEAD_TYPE,
  QUESTION_MAX,
  renderAskDescription,
} from './ask-format';
import {priorityBadge, renderAsk} from './ask-render';
import {nextQuestionIdLabel} from './question-id-assign';
import {shortIdText} from './question-ids';
import {readShownQuestionIds} from './question-ids-read';
import {
  REQUEST_LABEL,
  resolveSession,
  sidLabel,
  toLabelFor,
} from './session-bead';
import {repairMissingSessionBead, repairRefusalNote} from './session-repair';
import {sessionBeadsKnob, sessionIdFrom} from './session-select';

export interface AskInput {
  approve: boolean;
  context: readonly string[];
  default: string | null;
  do: boolean;
  header: string | null;
  options: readonly string[];
  /** As typed: `0`–`4`, or `P0`–`P4`. */
  priority: string | null;
  question: string | null;
  recommend: string | null;
}

export type AskValidation =
  | {fields: AskFields; ok: true; priority: number; question: string}
  | {ok: false; reason: string};

/**
 * The ask, checked. Every refusal is ONE line saying what to change (design
 * item 1): no priority; P0 with a default; P1–P3 without one; exactly one
 * option; `--recommend` naming a missing option; a question over 200
 * characters. Pure: no I/O.
 */
export function validateAsk(input: AskInput): AskValidation {
  const refuse = (reason: string): AskValidation => ({ok: false, reason});
  const question = input.question == null ? '' : oneLine(input.question);
  if (question === '') {
    return refuse(
      'give the question: thread ask "<one-line question>" --priority <0-4> …',
    );
  }
  if (question.length > QUESTION_MAX) {
    return refuse(
      `the question is ${question.length} characters; the limit is ${QUESTION_MAX}. Keep it to one line and put the detail in --context`,
    );
  }
  const rawPriority = input.priority?.trim() ?? '';
  if (rawPriority === '') {
    return refuse(
      '--priority is required: 0 = I cannot go on without the answer, 1–3 = I go on with my --default, 4 = FYI',
    );
  }
  const priorityMatch = /^[Pp]?([0-4])$/.exec(rawPriority);
  if (priorityMatch == null) {
    return refuse(
      `--priority must be 0–4 (got ${JSON.stringify(rawPriority)})`,
    );
  }
  const priority = Number(priorityMatch[1]);

  const headerText = input.header == null ? '' : oneLine(input.header);
  if (headerText.length > HEADER_MAX) {
    return refuse(
      `--header is ${headerText.length} characters; the limit is ${HEADER_MAX} (a short tag like "Export DB")`,
    );
  }

  const options: AskOption[] = input.options.map(parseOptionFlag);
  for (const [index, option] of options.entries()) {
    if (option.label === '') {
      return refuse(
        `option ${optionLetter(index)} has no label: --option "<Label>: <why>"`,
      );
    }
    if (/^\(recommended\)/i.test(option.label)) {
      return refuse(
        `option ${optionLetter(index)} starts with "(Recommended)"; mark the recommended option with --recommend <letter> instead`,
      );
    }
  }
  if (options.length === 1) {
    return refuse(
      'exactly one --option: a choice needs two or more. For a yes/no question use --approve; for an open question give no options',
    );
  }
  if (options.length > 26) {
    return refuse(`${options.length} options; the letters stop at z (26)`);
  }

  let recommended: number | null = null;
  if (input.recommend != null && input.recommend.trim() !== '') {
    const index = optionIndex(input.recommend);
    if (index == null || index >= options.length) {
      return refuse(
        `--recommend ${input.recommend.trim()} names an option that does not exist (${options.length === 0 ? 'there are no --option values' : `the options are ${options.map((_, i) => optionLetter(i)).join(', ')}`})`,
      );
    }
    recommended = index;
  }

  if (input.do && input.approve) {
    return refuse('--do and --approve are two different forms; give one');
  }

  const defaultText = input.default == null ? '' : oneLine(input.default);
  let askDefault: AskDefault;
  if (priority === 0) {
    if (defaultText !== '') {
      return refuse(
        'a P0 has no --default: P0 means the session stops without the answer. Drop --default, or use P1–P3 if you would go on without it',
      );
    }
    askDefault = {kind: 'none', why: P0_NO_DEFAULT};
  } else if (defaultText !== '') {
    askDefault = {kind: 'text', text: defaultText};
  } else if (priority === 4) {
    askDefault = {kind: 'none', why: P4_NO_DEFAULT};
  } else {
    return refuse(
      `a P${priority} needs --default: what you will do if Justin never answers (only a P0 stops the session)`,
    );
  }

  let form: AskForm;
  if (input.do) form = 'do';
  else if (input.approve) form = 'approve';
  else if (options.length > 0) form = 'pick';
  else form = 'answer';

  return {
    fields: {
      context: input.context.map(oneLine).filter((line) => line !== ''),
      default: askDefault,
      form,
      header: headerText === '' ? null : headerText,
      options,
      recommended,
    },
    ok: true,
    priority,
    question,
  };
}

export interface ThreadAskOptions extends AskInput {
  /** A hook payload's agent_id (subagent): refused, as `thread request` does. */
  agentId?: string | null;
  cwd?: string;
  env?: EnvLike;
  /** When the race window is measured from (home-base-4ay2j); tests pin it. */
  now?: Date;
  /** How the report's ids are read after filing; tests inject a failing one. */
  readShownIds?: typeof readShownQuestionIds;
  sessionId: string | null;
  style?: OutputStyle;
  /**
   * `--to <bead id>`: the request this question is for (its `to:` label).
   * Looked up in the session's DB, then the current directory's.
   */
  to: string | null;
}

/**
 * home-base-sg9q9.11 F4: what the report shows for a question just filed, so
 * `thread ask` prints exactly that and nothing a reader could relay wrongly.
 * - `short`: its id, `BD7`.
 * - `beadId`: its bead id, because its number is also an older question's
 *   (questionIdsShown); `BD7` there would answer the older one.
 * - `unchecked`: a label was written but the report's questions could not be
 *   read, so which id it shows is unknown; never a guess.
 * - `none`: no label was written; the next `thread status` gives it one.
 */
export type AskShownAs =
  | {kind: 'beadId'; why: string}
  | {kind: 'none'; why: string}
  | {kind: 'short'; text: string}
  | {kind: 'unchecked'; why: string};

export type ThreadAskOutcome =
  | {
      description: string;
      fields: AskFields;
      id: string;
      kind: 'filed';
      /** Always the session bead (home-base-vzwbj.4.16 G1). */
      parent: string;
      priority: number;
      question: string;
      /**
       * home-base-4ay2j: this command filed or re-indexed the session bead the
       * capture hook had failed to file; null when it was already there.
       */
      repair: Extract<SessionBeadRepair, {kind: 'repaired'}> | null;
      /** The request it is for (its `to:` label), or null when not linked. */
      request: {id: string; title: string} | null;
      /**
       * home-base-1rxt0.4 D4: the id its label was given (`BD7`), or null when
       * no label was written. Not always what the report shows: print
       * `shownAs`.
       */
      shortId: null | string;
      /** What the report shows in its brackets (home-base-sg9q9.11 F4). */
      shownAs: AskShownAs;
      /** Why it is not linked to a request, in words; null when it is. */
      unlinkedWhy: string | null;
    }
  | {agentId: string; kind: 'subagent'}
  | {checkoutPath: string; kind: 'checkoutMissing'}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'invalid'; reason: string}
  | {kind: 'noSession'; reason: string};

/**
 * home-base-sg9q9.11 F4: the id the report will show for the question just
 * filed, by the report's own rule (questionIdsShown over the session's open
 * questions). A read that fails or throws is `unchecked`: the question is
 * already filed, so this never fails the command.
 */
function shownAfterFiling(input: {
  filed: IdQuestion;
  read: typeof readShownQuestionIds;
  session: FoundSession;
}): AskShownAs {
  const unchecked = (why: string): AskShownAs => ({kind: 'unchecked', why});
  let read: ReturnType<typeof readShownQuestionIds>;
  try {
    read = input.read({include: input.filed, session: input.session});
  } catch (error) {
    return unchecked(
      `reading this session's questions threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (read.kind === 'unreadable') {
    return unchecked(
      `some of this session's questions could not be read: ${read.problems.join('; ')}`,
    );
  }
  const shown = read.shown.byId.get(input.filed.id);
  if (shown == null) {
    return unchecked('the report gives it no id, though it carries one');
  }
  return shown.why == null
    ? {kind: 'short', text: shown.text}
    : {kind: 'beadId', why: shown.why};
}

/** The decision half of `thread ask`: validates, writes one bead, prints nothing. */
export async function fileAsk(
  options: ThreadAskOptions,
): Promise<ThreadAskOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.agentId != null && options.agentId !== '') {
    return {agentId: options.agentId, kind: 'subagent'};
  }
  const valid = validateAsk(options);
  if (!valid.ok) return {kind: 'invalid', reason: valid.reason};

  const session = sessionIdFrom(options.sessionId, env);
  if (!session.ok) return {kind: 'noSession', reason: session.reason};
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};
  let resolution = resolveSession({env, sessionId: session.id});
  // home-base-4ay2j D1: past the race, a bead the capture hook failed to file
  // is filed (or re-indexed) here, once, under the capture lock (D3).
  let repair: Extract<SessionBeadRepair, {kind: 'repaired'}> | null = null;
  if (resolution.kind === 'none') {
    const attempted = await repairMissingSessionBead({
      by: 'thread ask',
      cwd,
      env,
      now: options.now ?? new Date(),
      sessionId: session.id,
    });
    if (attempted.kind === 'repaired') {
      repair = attempted;
      resolution = resolveSession({env, sessionId: session.id});
    }
    const note =
      attempted.kind === 'repaired'
        ? attempted.line
        : repairRefusalNote(attempted);
    if (resolution.kind === 'none') {
      return {
        kind: 'noSession',
        reason:
          note == null ? resolution.reason : `${resolution.reason} ${note}`,
      };
    }
  }
  if (resolution.kind === 'failed') {
    return {
      kind: 'failed',
      reason:
        repair == null
          ? resolution.reason
          : `${resolution.reason} (${repair.line})`,
    };
  }
  if (resolution.kind === 'checkoutMissing') {
    return {checkoutPath: resolution.checkoutPath, kind: 'checkoutMissing'};
  }
  const target = {db: resolution.db, env};

  // home-base-vzwbj.4.16 G1: the PARENT is always the session bead. A question
  // under a request kept it open — br refuses `br close` on a parent with open
  // children, and P1–P3 questions may never be answered (Justin, 2026-10-11:
  // only P0 blocks). The request it is for is the `to:` LABEL instead:
  // --to, else the session's only in-progress request, else none.
  const parent = resolution.bead.id;
  let request: {id: string; title: string} | null = null;
  let unlinkedWhy: string | null = null;
  const to = options.to?.trim() ?? '';
  if (to !== '') {
    // Looked up in the session's DB, then the current directory's (the
    // conductor in main files for a request in its worktree's DB). A lookup
    // that FAILED stops here: "not there" is a claim it could not make.
    const places = [resolution.db];
    const space = findBeadsWorkspace(cwd);
    if (space.kind === 'found' && space.db !== resolution.db) {
      places.push(space.db);
    }
    for (const db of places) {
      const shown = brShow({db, env}, to);
      if (shown.kind === 'failed') {
        return {
          kind: 'failed',
          reason: `could not look up --to ${to} in ${db}: ${describeBrFailed(shown)}`,
        };
      }
      if (shown.kind === 'ok') {
        request = {id: to, title: shown.issue.title};
        break;
      }
    }
    if (request == null) {
      return {
        kind: 'failed',
        reason: `--to ${to} is in neither this session's beads DB nor the current directory's (searched: ${places.join(', ')}${space.kind === 'found' ? '' : `; the current directory has no beads workspace: ${space.reason}`})`,
      };
    }
  } else {
    const listed = brList(target, {
      all: false,
      labels: [REQUEST_LABEL, sidLabel(session.id)],
    });
    if (listed.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `could not list this session's requests to choose the one this question is for (pass --to <id> to skip the lookup): ${describeBrFailed(listed)}`,
      };
    }
    const inProgress = listed.issues.filter(
      (issue) => issue.status === 'in_progress',
    );
    const [only] = inProgress;
    if (inProgress.length === 1 && only != null) {
      request = {id: only.id, title: only.title};
    } else {
      unlinkedWhy =
        inProgress.length === 0
          ? 'no request is in progress'
          : `${inProgress.length} requests are in progress: ${inProgress.map((issue) => issue.id).join(', ')} — pass --to to link one`;
    }
  }

  const labels = [ASK_LABEL, sidLabel(session.id)];
  if (request != null) {
    const link = toLabelFor(request.id);
    if (link.ok) {
      labels.push(link.label);
    } else {
      unlinkedWhy = `the link to ${request.id} could not be written: ${link.reason}`;
      request = null;
    }
  }

  // home-base-1rxt0.4 D4: the next id of this session's chain, written in the
  // same br write that files the question. No id is never fatal: the question
  // is filed without one, the reason is printed, and the next `thread status`
  // gives it one.
  const nextId = nextQuestionIdLabel({
    beadsDir: resolution.beadsDir,
    env,
    session: resolution.bead,
  });
  if (nextId.kind === 'label') labels.push(nextId.label);

  const description = renderAskDescription(valid.fields);
  const created = brCreate(target, {
    description,
    labels,
    parent,
    priority: valid.priority,
    title: valid.question,
    type: QUESTION_BEAD_TYPE,
  });
  if (created.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `br create failed, nothing was filed: ${describeBrFailed(created)}`,
    };
  }
  return {
    description,
    fields: valid.fields,
    id: created.id,
    kind: 'filed',
    parent,
    priority: valid.priority,
    question: valid.question,
    repair,
    request,
    shortId: nextId.kind === 'label' ? shortIdText(nextId.number) : null,
    shownAs:
      nextId.kind === 'none'
        ? {kind: 'none', why: nextId.reason}
        : shownAfterFiling({
            filed: {
              // Only used when the export does not hold it yet: it was filed
              // just now, so it is the newest of its number.
              createdAt: new Date().toISOString(),
              id: created.id,
              labels,
              priority: valid.priority,
            },
            read: options.readShownIds ?? readShownQuestionIds,
            session: resolution,
          }),
    unlinkedWhy,
  };
}

/** The text in the brackets of the question's line, as the report shows it. */
function askBracket(
  outcome: Extract<ThreadAskOutcome, {kind: 'filed'}>,
): null | string {
  switch (outcome.shownAs.kind) {
    case 'short':
      return outcome.shownAs.text;
    case 'beadId':
      return outcome.id;
    case 'none':
    case 'unchecked':
      return null;
  }
}

/** The warning under the first line, when the question has no usable short id. */
function askIdWarning(
  outcome: Extract<ThreadAskOutcome, {kind: 'filed'}>,
): string[] {
  const {shownAs} = outcome;
  switch (shownAs.kind) {
    case 'short':
      return [];
    case 'none':
      return [
        `⚠️ No id like BD7 yet; the next thread status gives it one. Why: ${shownAs.why}`,
      ];
    case 'beadId':
      return [
        `⚠️ The report shows this question by its bead id, because ${shownAs.why}. Answer it by its bead id: ${outcome.id}.`,
      ];
    case 'unchecked':
      return [
        `⚠️ Could not check which id the report shows for this question, so refer to it by its bead id: ${outcome.id}. Why: ${shownAs.why}`,
      ];
  }
}

/** Where a filed question went, in words: `for <id>: <title>` or why not linked. */
export function askLinkWords(
  outcome: Extract<ThreadAskOutcome, {kind: 'filed'}>,
): string {
  return outcome.request != null
    ? `for ${outcome.request.id}: ${outcome.request.title}`
    : `not linked to a request: ${outcome.unlinkedWhy ?? 'none named'}`;
}

/** The lines an ask outcome prints, and its exit code. */
export function describeAskOutcome(
  outcome: ThreadAskOutcome,
  style: OutputStyle,
): {exitCode: 0 | 1 | 2; lines: string[]} {
  switch (outcome.kind) {
    case 'filed':
      // home-base-sg9q9.11 F4: only what the report shows. The first line
      // keeps the shape `ask <bead id> · …`, which a caller parses (1cecf024).
      return {
        exitCode: 0,
        lines: [
          `ask ${outcome.id} · ${outcome.shownAs.kind === 'short' ? `${outcome.shownAs.text} · ` : ''}${priorityBadge(outcome.priority)} · filed under ${outcome.parent} (${askLinkWords(outcome)})`,
          ...askIdWarning(outcome),
          '',
          'Justin will see:',
          '',
          renderAsk(
            {
              description: outcome.description,
              id: outcome.id,
              priority: outcome.priority,
              title: outcome.question,
            },
            1,
            style,
            // Markdown when piped: Claude may paste it, and Claude Code drops
            // one empty line between list items (home-base-j8q3e.1.10 F7).
            2,
            null,
            askBracket(outcome),
          ),
        ],
      };
    case 'invalid':
      return {exitCode: 2, lines: [`thread ask: refused — ${outcome.reason}`]};
    case 'checkoutMissing':
      return {
        exitCode: 1,
        lines: [
          `thread ask: refused — this session's beads live in ${outcome.checkoutPath}, which no longer exists (or no longer holds a beads database).`,
        ],
      };
    case 'subagent':
      return {
        exitCode: 1,
        lines: [
          `thread ask: refused — this is a subagent (agent_id=${outcome.agentId}); questions for Justin belong to the session that dispatched it. Report the question to it instead.`,
        ],
      };
    case 'disabled':
    case 'failed':
    case 'noSession':
      return {exitCode: 1, lines: [`thread ask: ${outcome.reason}`]};
  }
}

/** `thread ask`: validate, file, print, return the exit code. */
export async function runThreadAsk(options: ThreadAskOptions): Promise<number> {
  const style = options.style ?? outputStyle(process.stdout);
  const outcome = await fileAsk(options);
  // home-base-4ay2j D1: the one loud line, on stderr so stdout keeps its shape.
  if (outcome.kind === 'filed' && outcome.repair != null) {
    console.error(outcome.repair.line);
  }
  const {exitCode, lines} = describeAskOutcome(outcome, style);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
