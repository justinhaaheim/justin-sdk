/**
 * Which UI `thread answer` opens, and the one place that decides
 * (home-base-p1uj.12 — the feature-knobs rule, second application).
 *
 * PRECEDENCE: `--classic` / `--ui <name>` → project config → user config →
 * `web`. A flag outranks a file because the flag is this run and the file is
 * every run; that is the same direction every other knob in this repo resolves.
 *
 * `ink` RESOLVES AND THEN REFUSES, which is the point of keeping it in the
 * union at all. The bead asked for three values, the spike measured Ink and
 * rejected it with numbers, and the honest way to hold a rejection is to name it
 * when someone asks for it — not to quietly hand them a different UI, and not to
 * pretend the word was a typo.
 */

import {
  isThreadAnswerUi,
  resolveThreadConfig,
  THREAD_ANSWER_UIS,
  THREAD_DEFAULT_ANSWER_UI,
  type ThreadAnswerUi,
} from './config';

import type {EnvLike} from './paths';
import type {ThreadRef} from './resolve';

export type AnswerUiSource = 'config' | 'default' | 'flag';

export interface AnswerUiResolution {
  problems: string[];
  source: AnswerUiSource;
  ui: ThreadAnswerUi;
}

export interface AnswerUiInputs {
  /** `--classic`. Outranks `--ui`, because it is the more specific request. */
  classic?: boolean;
  cwd?: string;
  env?: EnvLike;
  /** `--ui <name>`, verbatim from the command line. */
  ui?: string | null;
}

/** The line printed when Ink is asked for. Exported so the test can pin it. */
export const INK_REFUSAL =
  'thread answer: answerUi "ink" was measured and rejected (home-base-p1uj.12). Ink itself is maintained, but it has no maintained multi-line editor — ink-text-input is single-line, and the multi-line packages are pre-1.0 with three-figure weekly downloads — so the editor would have been hand-rolled with no undo. Use "web" (the default) or "classic".';

export function resolveAnswerUi(
  inputs: AnswerUiInputs = {},
): AnswerUiResolution {
  if (inputs.classic === true) {
    return {problems: [], source: 'flag', ui: 'classic'};
  }
  const flag = inputs.ui;
  if (flag != null && flag !== '') {
    if (!isThreadAnswerUi(flag)) {
      // Refused, not coerced: running the default because a flag was misspelled
      // would put Justin in a UI he did not ask for without saying so.
      return {
        problems: [
          `--ui ${JSON.stringify(flag)} is not one of ${THREAD_ANSWER_UIS.join(', ')}.`,
        ],
        source: 'flag',
        ui: THREAD_DEFAULT_ANSWER_UI,
      };
    }
    return {problems: [], source: 'flag', ui: flag};
  }

  const config = resolveThreadConfig({cwd: inputs.cwd, env: inputs.env});
  return {
    problems: config.problems,
    source: config.answerUiSource === 'default' ? 'default' : 'config',
    ui: config.answerUi,
  };
}

export interface AnswerUiOptions extends ThreadRef, AnswerUiInputs {
  autoCommit?: boolean;
  openBrowser?: boolean;
  port?: number;
}

/**
 * Route to the chosen UI.
 *
 * Both runners are `await import`ed rather than imported at the top, for the
 * reason command.ts states: this module graph is shared with hooks that run on
 * every prompt, and the classic walk drags in readline while the web UI drags in
 * the page.
 */
export async function runThreadAnswerUi(
  options: AnswerUiOptions = {},
): Promise<number> {
  const resolution = resolveAnswerUi({
    classic: options.classic,
    env: options.env,
    ui: options.ui,
  });
  for (const problem of resolution.problems) {
    console.error(`thread answer: ${problem}`);
  }
  if (resolution.problems.length > 0 && resolution.source === 'flag') {
    return 2;
  }

  if (resolution.ui === 'ink') {
    console.error(INK_REFUSAL);
    return 2;
  }

  if (resolution.ui === 'classic') {
    const {runThreadAnswer} = await import('./answer');
    return runThreadAnswer({
      autoCommit: options.autoCommit,
      env: options.env,
      latest: options.latest,
      sessionId: options.sessionId,
      threadId: options.threadId,
    });
  }

  const {runThreadAnswerWeb} = await import('./answer-web');
  return runThreadAnswerWeb({
    autoCommit: options.autoCommit,
    env: options.env,
    latest: options.latest,
    openBrowser: options.openBrowser,
    port: options.port,
    sessionId: options.sessionId,
    threadId: options.threadId,
  });
}
