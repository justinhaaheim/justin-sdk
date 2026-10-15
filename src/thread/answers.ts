/**
 * `thread answers` — what Justin answered that Claude has not been shown yet
 * (home-base-vzwbj.4.9 R1: delivery, not yield time; status
 * report v4, epic home-base-vzwbj.4 D3; built by home-base-vzwbj.4.2). The
 * Claude-facing half of the old `thread inbox`, under the sessionBeads knob;
 * with the knob off the old `thread inbox` is unchanged and this refuses.
 *
 * Each answered question is restated IN FULL (question, priority, context,
 * options, default) with his answer verbatim, so Claude can act on "b" without
 * remembering what b was. `--all` lists every answered question of the session.
 *
 * "No new answers." means CHECKED: every beads DB the index names for this
 * session was read. A DB that could not be read is said by name and the exit
 * is 1 — never folded into "none" (critical rule 7).
 *
 * Exit: 0 read (answers or none) · 1 could not read, or no session/knob off.
 */

import type {OutputStyle} from '../cli-style';
import type {DeliveredAnswers} from './answer-store';
import type {EnvLike} from './paths';
import type {LocatedIssue} from './session-select';

import {DETAIL_COLUMN, outputStyle, pad, paint} from '../cli-style';
import {
  answerFrom,
  isAnswered,
  isUndelivered,
  markAnswersDelivered,
  readDeliveredAnswers,
} from './answer-store';
import {ASK_LABEL, QUESTION_BEAD_TYPE} from './ask-format';
import {renderAsk, sortAsks} from './ask-render';
import {resolveSession} from './session-bead';
import {
  sessionBeadsKnob,
  sessionBeadsLabelled,
  sessionIdFrom,
} from './session-select';

export interface ThreadAnswersOptions {
  /** `--all`: every answered question, not only the new ones. */
  all: boolean;
  cwd?: string;
  env?: EnvLike;
  sessionId: string | null;
  style?: OutputStyle;
}

export type ThreadAnswersOutcome =
  | {
      answered: LocatedIssue[];
      /** The delivered marker read (R1); null under `--all`, which ignores it. */
      delivered: DeliveredAnswers | null;
      kind: 'read';
      /** Beads DBs that could not be read: non-empty means exit 1. */
      problems: string[];
      sessionId: string;
    }
  | {checkoutPath: string; kind: 'checkoutMissing'}
  | {kind: 'disabled'; reason: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'noSession'; reason: string};

/** The decision half: reads, prints nothing. */
export async function readAnswers(
  options: ThreadAnswersOptions,
): Promise<ThreadAnswersOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const session = sessionIdFrom(options.sessionId, env);
  if (!session.ok) return {kind: 'noSession', reason: session.reason};
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) {
    return {
      kind: 'disabled',
      reason: `${knob.reason} With the knob off, run thread inbox instead.`,
    };
  }
  const resolution = resolveSession({env, sessionId: session.id});
  if (resolution.kind === 'failed') {
    return {kind: 'failed', reason: resolution.reason};
  }
  if (resolution.kind === 'none') {
    return {kind: 'noSession', reason: resolution.reason};
  }
  if (resolution.kind === 'checkoutMissing') {
    return {checkoutPath: resolution.checkoutPath, kind: 'checkoutMissing'};
  }
  // R1 (home-base-vzwbj.4.9): "new" = answered and not yet DELIVERED to
  // Claude; `--all` ignores the marker.
  const delivered: DeliveredAnswers | null = options.all
    ? null
    : readDeliveredAnswers(session.id, env);
  const questions = sessionBeadsLabelled(
    resolution,
    {
      all: true,
      label: ASK_LABEL,
      types: [QUESTION_BEAD_TYPE],
    },
    env,
  );
  return {
    answered: questions.issues.filter((entry) =>
      delivered == null
        ? isAnswered(entry.issue)
        : isUndelivered(entry.issue, delivered),
    ),
    delivered,
    kind: 'read',
    problems: questions.problems,
    sessionId: session.id,
  };
}

/** Justin's answer under a restated question, at the question's detail indent. */
function answerLine(
  answer: string,
  style: OutputStyle,
  indent: number,
): string {
  return `${pad(indent)}${paint("Justin's answer:", ['bold', 'green'], style.color)} ${answer}`;
}

export function describeAnswersOutcome(
  outcome: ThreadAnswersOutcome,
  style: OutputStyle,
): {exitCode: 0 | 1; lines: string[]} {
  switch (outcome.kind) {
    case 'read': {
      const lines: string[] = [];
      const failures = outcome.problems.map(
        (problem) => `⚠️ ${problem} — answers recorded there are NOT shown.`,
      );
      const newOnly = outcome.delivered != null;
      if (outcome.delivered?.kind === 'failed') {
        lines.push(
          `⚠️ Could not tell which answers you have already been shown (${outcome.delivered.reason}), so EVERY answered question is listed.`,
          '',
        );
      }
      if (outcome.answered.length === 0) {
        if (failures.length > 0)
          return {exitCode: 1, lines: [...lines, ...failures]};
        lines.push(
          newOnly
            ? 'No new answers.'
            : 'No answered questions in this session.',
        );
        return {exitCode: 0, lines};
      }
      const heading = newOnly
        ? `New answers (not shown to you before): ${outcome.answered.length}`
        : `Every answered question in this session (${outcome.answered.length}):`;
      lines.push(heading, '');
      const sorted = sortAsks(outcome.answered.map((entry) => entry.issue));
      sorted.forEach((issue, index) => {
        const number = index + 1;
        // The question's own detail indent (ask-render.ts), so the answer
        // reads as part of the item it answers.
        const indent = style.color ? DETAIL_COLUMN : `${number}. `.length;
        // In markdown, two empty lines before the next question: Claude
        // pastes this, and Claude Code drops one (home-base-j8q3e.1.10 F7).
        lines.push(
          renderAsk(issue, number, style, 2),
          '',
          answerLine(answerFrom(issue.closeReason) ?? '', style, indent),
          '',
          ...(style.color ? [] : ['']),
        );
      });
      if (failures.length > 0)
        return {exitCode: 1, lines: [...lines, ...failures]};
      return {exitCode: 0, lines};
    }
    case 'checkoutMissing':
      return {
        exitCode: 1,
        lines: [
          `thread answers: could not read — this session's beads live in ${outcome.checkoutPath}, which no longer exists.`,
        ],
      };
    case 'disabled':
    case 'failed':
    case 'noSession':
      return {exitCode: 1, lines: [`thread answers: ${outcome.reason}`]};
  }
}

/** `thread answers`: read, print, return the exit code. */
export async function runThreadAnswers(
  options: ThreadAnswersOptions,
): Promise<number> {
  const style = options.style ?? outputStyle(process.stdout);
  const outcome = await readAnswers(options);
  const {exitCode, lines} = describeAnswersOutcome(outcome, style);
  // What was READ goes to stdout even beside a failure, so answers from the
  // DBs that could be read are never hidden in stderr; refusals go to stderr.
  const write =
    exitCode === 0 || outcome.kind === 'read' ? console.log : console.error;
  for (const line of lines) write(line);
  // R1: what was printed is delivered. `--all` ignores the marker entirely.
  if (outcome.kind === 'read' && outcome.delivered != null) {
    const marked = markAnswersDelivered(
      outcome.sessionId,
      outcome.answered.map((entry) => entry.issue.id),
      options.env ?? process.env,
    );
    if (marked.kind === 'failed') {
      console.error(
        `⚠️ ${marked.reason} — these answers will be listed again next time.`,
      );
    }
  }
  return exitCode;
}
