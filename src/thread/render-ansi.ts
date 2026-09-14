/**
 * THE TERMINAL RENDERING (home-base-p1uj D14) — what Justin reads in a shell.
 *
 * Same document as the markdown, with the two things a terminal has and a
 * pasted Claude message does not: BOLD + UNDERLINE on field names, and COLOUR BY
 * ASK PRIORITY. Justin asked for both on 2026-09-14, and they are the whole
 * difference: in the markdown, a P0 and a P4 are two lines of identical-weight
 * text; here the P0 is bold red and the P4 is dim, so the eye lands on the one
 * that stopped the session.
 *
 * IT STYLES THE MARKDOWN rather than walking the model again — see
 * `report-lines.ts` for why, and for the classifier that makes it safe. The same
 * styling therefore works on a report that is only text (the thread bead's
 * stored notes), which is what `thread show` has.
 *
 * COLOUR IS A CHOICE, NOT A GUESS. `renderAnsi` takes `color` explicitly and
 * defaults it to true; callers pass `shouldStyle()`, the same NO_COLOR-aware
 * check repo-status uses, so a piped or redirected report has no escape codes in
 * it. With `color: false` the output is the markdown, unchanged — which matters,
 * because that is the form Claude would paste.
 */

import {classifyReport} from './report-lines';
import {renderMarkdown} from './render-markdown';

import type {ReportLine} from './report-lines';
import type {ReportModel} from './report-model';

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const UNDERLINE = '[4m';
const RED = '[31m';
const YELLOW = '[33m';
const CYAN = '[36m';

/**
 * How loud each priority is (D15).
 *
 * P0 bold red, P1/P2 plain, P3/P4 dim. An UNKNOWN priority is yellow rather
 * than dim: a marker this build does not recognise is a fact about the data, and
 * dimming it would hide the one line that says something is wrong.
 */
function priorityStyle(priority: number | null): string {
  if (priority == null) return YELLOW;
  if (priority === 0) return `${BOLD}${RED}`;
  if (priority >= 3) return DIM;
  return '';
}

function styleLine(line: ReportLine): string {
  switch (line.kind) {
    case 'glance':
      return `${BOLD}${line.text}${RESET}`;
    case 'where':
      return `${DIM}${line.text}${RESET}`;
    case 'heading':
      return `${BOLD}${UNDERLINE}${line.label ?? ''}:${RESET}`;
    case 'field':
      return `${BOLD}${UNDERLINE}${line.label ?? ''}:${RESET} ${line.rest}`;
    case 'ask':
    case 'askDetail': {
      const style = priorityStyle(line.priority);
      return style === '' ? line.text : `${style}${line.text}${RESET}`;
    }
    case 'rule':
      return `${CYAN}${line.text}${RESET}`;
    case 'note':
      return `${DIM}${line.text}${RESET}`;
    case 'command':
      return `${BOLD}${line.text}${RESET}`;
    case 'blank':
    case 'bullet':
    case 'continuation':
    case 'numbered':
    case 'text':
      return line.text;
  }
}

/**
 * Style an already-rendered report. Used by `renderAnsi` and by every surface
 * that has the stored text and no model (`thread show`).
 */
export function ansiFromReportText(
  markdown: string,
  options: {color?: boolean} = {},
): string {
  if (options.color === false) return markdown;
  return classifyReport(markdown).map(styleLine).join('\n');
}

/** The whole report, styled for a terminal. */
export function renderAnsi(
  model: ReportModel,
  options: {color?: boolean} = {},
): string {
  return ansiFromReportText(renderMarkdown(model), options);
}
