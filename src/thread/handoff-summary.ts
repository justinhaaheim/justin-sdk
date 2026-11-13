/**
 * The short handoff summary (home-base-9ihcl.6): what a session that hands
 * off ends its turn with, in place of the full Part 1 block. Justin,
 * 2026-11-09: "a much more abbreviated status report that just gives some
 * metadata about which # in the chain the current session is, the command to
 * focus the new tab, # of open requests vs total, etc. And we should print the
 * command to show the full status report if needed."
 *
 * FOUR FIELDS, one per line with a bold label (home-base terminal style):
 *   This session  its own number, `#7` (handoffNumberOf), never a guess
 *   New tab       the focus command, or the refusal or deferral and its reason
 *   Requests      open of total, as the handoff block counted them
 *   Full report   `thread show <this session's bead>`
 *
 * ONE VIEW, TWO RENDERINGS, as Part 1 does (part-one.ts): markdown when the
 * output is not coloured (a pipe, which is how Claude runs the handoff and
 * what it pastes), a TIGHT bullet list so every renderer keeps one field per
 * line; aligned bold labels through cli-style.ts on a TTY.
 *
 * The focus command names THIS session's bead: `thread focus` walks forward
 * along `continued-by:` to the newest session of the chain (focus.ts), and the
 * successor has no session bead of its own yet when this prints.
 *
 * Both commands start with `cd <this session's checkout> &&`, the way focus.ts
 * spells a resume line. `bun run justin-sdk` resolves through the current
 * directory's package.json; outside a repo it fell through to an older
 * justin-sdk on PATH, which looked the bead up with `bd` and did not find it
 * (measured 2026-11-10 from $TMPDIR). Without a known checkout the bare command
 * is printed.
 */

import type {OutputStyle} from '../cli-style';
import type {HandoffDeferralReason, HandoffRefusalReason} from './handoff-gate';
import type {HandoffNumber} from './handoff-number';
import type {HandoffRequestCount} from './session-handoff';

import {fieldLines, sectionHeader, stepColumn} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {zshWord} from './respawn';
import {handoffNumberText} from './session-name';

/** What happened to the new tab. */
export type HandoffSummaryTab =
  | {detail: string; kind: 'deferred'; reason: HandoffDeferralReason}
  | {kind: 'opened'}
  | {detail: string; kind: 'refused'; reason: HandoffRefusalReason};

export interface HandoffSummaryInput {
  /** This session's checkout, which the commands `cd` into; null when unknown. */
  checkout: null | string;
  /** This session's own number, the one its successor's name adds 1 to. */
  own: HandoffNumber;
  requests: HandoffRequestCount;
  sessionBeadId: string;
  tab: HandoffSummaryTab;
}

/** The summary's heading, in both renderings. */
export const HANDOFF_SUMMARY_TITLE = 'Handed off';

/** `cd <checkout> && <command>`, or the bare command without a checkout. */
function inCheckout(checkout: null | string, command: string): string {
  return checkout == null ? command : `cd ${zshWord(checkout)} && ${command}`;
}

/** The command that focuses the newest session of this session's chain. */
export function handoffFocusCommand(
  sessionBeadId: string,
  checkout: null | string,
): string {
  return inCheckout(checkout, sdkRun(`thread focus ${sessionBeadId}`));
}

/** The command that prints this session's full report. */
export function handoffReportCommand(
  sessionBeadId: string,
  checkout: null | string,
): string {
  return inCheckout(checkout, sdkRun(`thread show ${sessionBeadId}`));
}

/**
 * The successor's number in words: this session's plus 1, or unknown. Spelled
 * `#7` as in the session name (home-base-1rxt0.2 D4).
 */
function successorNumber(own: HandoffNumber): string {
  return handoffNumberText(own.kind === 'known' ? own.number + 1 : 'unknown');
}

function ownText(own: HandoffNumber): string {
  if (own.kind === 'unknown') {
    return `${handoffNumberText('unknown')} (unknown: ${own.reason})`;
  }
  return own.number === 0
    ? 'the first session of its chain (no number)'
    : handoffNumberText(own.number);
}

function requestsText(requests: HandoffRequestCount): string {
  switch (requests.kind) {
    case 'counted':
      return requests.total === 0
        ? 'none filed'
        : `${requests.open} open of ${requests.total}`;
    case 'partial':
      return `${requests.open} open of ${requests.total} (⚠️ not all counted: ${requests.reason})`;
    case 'unknown':
      return `unknown: ${requests.reason}`;
  }
}

interface SummaryField {
  /** Shown as code: a command Justin can run. */
  code: string | null;
  label: string;
  /** Words before the code, or the whole value when there is no code. */
  text: string;
}

function summaryFields(input: HandoffSummaryInput): SummaryField[] {
  const next = successorNumber(input.own);
  const tab: SummaryField =
    input.tab.kind === 'opened'
      ? {
          code: handoffFocusCommand(input.sessionBeadId, input.checkout),
          label: 'New tab',
          text: `${next} opened. Focus it:`,
        }
      : input.tab.kind === 'refused'
        ? {
            code: null,
            label: 'New tab',
            text: `none opened: the handoff was refused (${input.tab.reason}): ${input.tab.detail}`,
          }
        : {
            code: null,
            label: 'New tab',
            text: `none opened: the handoff was deferred (${input.tab.reason}): ${input.tab.detail}`,
          };
  return [
    {code: null, label: 'This session', text: ownText(input.own)},
    tab,
    {code: null, label: 'Requests', text: requestsText(input.requests)},
    {
      code: handoffReportCommand(input.sessionBeadId, input.checkout),
      label: 'Full report',
      text: '',
    },
  ];
}

/** The summary, rendered for `style` (see the header). */
export function handoffSummary(
  input: HandoffSummaryInput,
  style: OutputStyle,
): string {
  const fields = summaryFields(input);
  if (!style.color) {
    return [
      `🤝 **${HANDOFF_SUMMARY_TITLE}**`,
      '',
      ...fields.map((field) => {
        const code = field.code == null ? '' : `\`${field.code}\``;
        const value = [field.text, code].filter((part) => part !== '');
        return `- **${field.label}:** ${value.join(' ')}`;
      }),
    ].join('\n');
  }
  return [
    sectionHeader(HANDOFF_SUMMARY_TITLE, {color: true, emoji: '🤝'}),
    '',
    fieldLines(
      fields.map((field) => ({
        label: field.label,
        value: [field.text, field.code ?? '']
          .filter((part) => part !== '')
          .join(' '),
      })),
      {...style, indent: stepColumn(0)},
    ),
  ].join('\n');
}
