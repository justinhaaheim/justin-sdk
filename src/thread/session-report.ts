/**
 * `thread status` and the v4 `thread show` (status report v4, epic
 * home-base-vzwbj.4 D3/D4; built by home-base-vzwbj.4.3). Both print Part 1
 * from the session model; they differ in who reads them and what follows.
 *
 * `thread status` — Claude, before yielding on a work turn (D3):
 *   SESSION BEADS: ENABLED
 *   Part 1, ready to paste (its status is the one the session will have once
 *     Claude stops: never 🏃, and Claude's yield counted as the last message)
 *   What to mark — ONLY what cannot be derived (session-status.ts
 *     `whatToMark`), or "Nothing to mark." When the yield would be ⚠️, one
 *     entry per open request: the close command, keep working, or the P0
 *     (home-base-vzwbj.4.16 G2; home-base-tg45h).
 *   If you stop now the inbox will say: <status> — and for ⚠️ only, what that
 *     leads to, how to settle each open request, and that handing off is only
 *     for a session that cannot go on (G2; home-base-tg45h)
 * With the knob off it prints `SESSION BEADS: DISABLED` and exits 0 — the line
 * the v4 rule branches on to write the legacy report instead (D6).
 *
 * `thread show [session bead | request or question id | --session <uuid>]` —
 * Justin (or Claude), knob on: Part 1 LIVE (🏃 when the session is running),
 * then `Related epics:` — the nearest epic above each request and each bead
 * the session created, with its open children (related-epics.ts,
 * home-base-y1hg0.7) — then `From Claude:` and the last message Claude
 * yielded with any pasted Part 1 stripped (it was stale the moment it was
 * pasted), then `Your messages:` —
 * every prompt, newest last, each cut at 400 characters (`--full`: uncut).
 *
 * Exit: 0 printed · 1 no session bead, or the sessions index unreadable.
 */

import type {OutputStyle} from '../cli-style';
import type {ChainReaders} from './handoff-chain';
import type {MessageLine} from './message-log';
import type {Piece} from './part-one';
import type {EnvLike} from './paths';
import type {RelatedEpics} from './related-epics';
import type {ActionLine, OptionalLine} from './session-card';
import type {CreatedBeads} from './session-created';
import type {Measured, SessionModel} from './session-model';
import type {MarkItem, SessionStatus, StatusCounts} from './session-status';

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  BODY_COLUMN,
  outputStyle,
  pad,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {SDK_HANDOFF_CALL, sdkRun} from '../sdk-invocation';
import {parseInstant} from './answer-store';
import {realChainReaders, walkUnattendedChain} from './handoff-chain';
import {
  chainLines,
  type ChainViewReaders,
  hasHandoffRecord,
  readHandoffChain,
  realChainViewReaders,
  type UnattendedCountView,
} from './handoff-view';
import {
  partOneView,
  renderPartOne,
  statusWords,
  stripPastedPartOne,
  tildeText,
  whenWords,
} from './part-one';
import {threadsBeadsDir} from './paths';
import {findRelatedEpics, renderRelatedEpics} from './related-epics';
import {deriveAction, optionalLine} from './session-card';
import {loadCreatedBeads} from './session-created';
import {readSessionIndex} from './session-index';
import {
  lastAssistantLine,
  loadSession,
  resolveSessionId,
  userLines,
} from './session-model';
import {SESSION_NAME_LIMIT} from './session-name';
import {
  deriveStatus,
  statusCounts,
  statusFactsOf,
  whatToMark,
} from './session-status';

/** `thread show` cuts each of Justin's messages here unless `--full`. */
export const USER_MESSAGE_CUT = 400;

/**
 * Every legacy thread id (the ~/Dev/threads store) starts with this: 847 of
 * 847 in its export, measured 2026-10-11.
 */
export const LEGACY_THREAD_ID_PREFIX = 'th-';

/**
 * R8 (home-base-vzwbj.4.9): with componentConfig.thread.sessionBeads on,
 * `thread show <id>` and `thread answer <id>` take v4 selectors, which left
 * every legacy thread id unreachable (exit 1). True when the selector
 * resolves to NO v4 session AND is a legacy id: the `th-` shape, or an id the
 * legacy store's export holds. A selector v4 resolves always stays v4.
 */
export function routesToLegacyThread(input: {
  cwd: string;
  env: EnvLike;
  selector: string | null;
}): boolean {
  const selector = input.selector?.trim() ?? '';
  if (selector === '') return false;
  const resolved = resolveSessionId({
    cwd: input.cwd,
    env: input.env,
    selector,
    sessionIdOption: null,
  });
  if (resolved.kind === 'found') return false;
  if (selector.startsWith(LEGACY_THREAD_ID_PREFIX)) return true;
  try {
    return readFileSync(
      join(threadsBeadsDir(input.env), 'issues.jsonl'),
      'utf8',
    ).includes(`"id":${JSON.stringify(selector)}`);
  } catch {
    // No legacy export to look in: the id is not shown to be a legacy one,
    // and the v4 handler's refusal names what it searched.
    return false;
  }
}

export const SESSION_BEADS_ENABLED_LINE = 'SESSION BEADS: ENABLED';
export const SESSION_BEADS_DISABLED_LINE = 'SESSION BEADS: DISABLED';

interface CommonOptions {
  cwd?: string;
  env?: EnvLike;
  now?: Date;
  style?: OutputStyle;
  /** IANA zone for printed times; undefined = this machine's. */
  timeZone?: string;
}

export type ReportLoad =
  | {
      /** The dashboard's "You need to" line (deriveAction), for Part 1. */
      action: ActionLine;
      counts: StatusCounts;
      /**
       * The beads this session created with a plain `br create`, for What to
       * mark (home-base-vzwbj.4.19 D2). Read here, not in loadSession, so the
       * inbox — which never prints What to mark — does not pay for a second
       * pass over every transcript.
       */
      created: Measured<CreatedBeads>;
      kind: 'loaded';
      model: SessionModel;
      /** The dashboard's "Optional" line, null when no P1–P4 is open. */
      optional: OptionalLine | null;
      status: SessionStatus;
      /** componentConfig.thread.titleSummary (home-base-ys9t7.9.1). */
      titleSummary: boolean;
    }
  | {detail: string; kind: 'unreadable'}
  | {kind: 'disabled'; reason: string}
  | {kind: 'noSession'; reason: string};

async function knobOn(
  cwd: string,
  env: EnvLike,
): Promise<{ok: false; reason: string} | {ok: true; titleSummary: boolean}> {
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  return config.sessionBeads
    ? {ok: true, titleSummary: config.titleSummary}
    : {
        ok: false,
        reason: `componentConfig.thread.sessionBeads is not true (resolved from: ${config.sessionBeadsSource})`,
      };
}

/**
 * The successor's Claude session id, as the inbox resolves it (D3 rule 3): the
 * sessions index line that CREATED the successor's session bead. Null when
 * there is no successor, no such line, or the index could not be read — then
 * deriveAction points at the handoff in Claude's last message instead of
 * naming a session to resume, which is the cautious line, not a reassuring one.
 */
function successorSessionIdOf(
  successor: string | null,
  env: EnvLike,
): string | null {
  if (successor == null) return null;
  const index = readSessionIndex(env);
  if (index.kind !== 'read') return null;
  for (const indexed of index.sessions) {
    for (const sighting of indexed.sightings) {
      if (sighting.event === 'created' && sighting.beadId === successor) {
        return indexed.sessionId;
      }
    }
  }
  return null;
}

async function loadForReport(input: {
  asIfYielded: boolean;
  cwd: string;
  env: EnvLike;
  now: Date;
  selector: string | null;
  sessionId: string | null;
}): Promise<ReportLoad> {
  const knob = await knobOn(input.cwd, input.env);
  if (!knob.ok) return {kind: 'disabled', reason: knob.reason};
  const loaded = await loadSession({
    cwd: input.cwd,
    env: input.env,
    selector: input.selector,
    sessionIdOption: input.sessionId,
  });
  if (loaded.kind !== 'loaded') return loaded;
  const {model} = loaded;
  const facts = statusFactsOf(model);
  const status = deriveStatus(facts, {
    asIfYielded: input.asIfYielded,
    now: input.now,
  });
  const counts = statusCounts(model);
  const created = loadCreatedBeads({
    sessionDirs: [...new Set(model.sightings.map((entry) => entry.beadsDir))],
    transcriptPath: model.transcript.path,
    transcriptProblem: model.transcript.lastRecordAt.ok
      ? 'the transcript path is not known'
      : model.transcript.lastRecordAt.reason,
  });
  return {
    // home-base-j8q3e.1.7.2 item 3: Part 1's "You need to" is the dashboard's
    // line, from the same function, so the two never disagree.
    action: deriveAction({
      model,
      status,
      successorSessionId: successorSessionIdOf(facts.successor, input.env),
    }),
    counts,
    created,
    kind: 'loaded',
    model,
    optional: optionalLine(counts, model.sessionBeadId),
    status,
    titleSummary: knob.titleSummary,
  };
}

function refusalLines(
  command: string,
  load: Exclude<ReportLoad, {kind: 'loaded'}>,
): string[] {
  switch (load.kind) {
    case 'disabled':
      return [`${SESSION_BEADS_DISABLED_LINE} — ${load.reason}.`];
    case 'noSession':
      return [`${command}: ${load.reason}`];
    case 'unreadable':
      return [`${command}: could not read — ${load.detail}`];
  }
}

// ---------------------------------------------------------------------------
// thread status
// ---------------------------------------------------------------------------

export interface ThreadStatusOptions extends CommonOptions {
  sessionId: string | null;
}

/**
 * One "What to mark" entry, in plain words, with the command that fixes it,
 * and (home-base-vzwbj.4.16 G2) the lines under it — `[]` for every kind but
 * `requestOpenNoBlocker`.
 */
export interface MarkView {
  code: string | null;
  sub: Piece[][];
  text: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * G2: what to do with an open request when the yield would be ⚠️. Plain
 * words, one request per entry: the close command when its work is done; when
 * it is not, keep working, or file the P0 that it cannot move without
 * (home-base-tg45h: never a handoff, which is not a way to stop and is said
 * once, on the verdict). `--force` appears HERE ONLY, for a request
 * whose open questions are old-shape children (br refuses to close a parent
 * with open children); a request with an open real child lists the child
 * instead of a close command.
 */
function requestOpenLines(
  item: Extract<MarkItem, {kind: 'requestOpenNoBlocker'}>,
): MarkView {
  const {request} = item;
  const where =
    request.status === 'in_progress'
      ? 'is in progress'
      : `is still open (status ${request.status})`;
  const allClosed = item.childrenAllClosed
    ? ', every child bead is closed,'
    : '';
  const close = `br close ${request.id} --reason "…"`;
  let done: Piece[];
  if (item.openChildren.length > 0) {
    const n = item.openChildren.length;
    done = [
      `work done → ${plural(n, 'child bead is', 'child beads are')} still open: ${item.openChildren.map((child) => child.id).join(', ')} — close ${n === 1 ? 'it' : 'them'} first`,
    ];
  } else if (item.oldShapeQuestions.length > 0) {
    const n = item.oldShapeQuestions.length;
    done = [
      'work done → ',
      {code: `${close} --force`},
      ` (--force because ${n === 1 ? 'its open question for Justin is a child bead' : `its ${n} open questions for Justin are child beads`} of the request, the old way, and br will not close a parent with open children; --force closes the request and leaves ${n === 1 ? 'the question' : 'them'} open)`,
    ];
  } else {
    const n = item.openQuestions.length;
    done = [
      'work done → ',
      {code: close},
      n === 0
        ? ''
        : ` (${n === 1 ? 'its open question for Justin stays open' : `its ${n} open questions for Justin stay open`}; questions never keep a request open)`,
    ];
  }
  // home-base-tg45h: there is no command that raises an ask's priority, and
  // `br update --priority 0` would leave its P1–P3 default on a P0. So a
  // question already filed is filed again at P0 and the old one closed; a
  // close reason without the answer prefix never reads as Justin's answer.
  const filed = [...item.openQuestions, ...item.oldShapeQuestions];
  const raise: Piece[] =
    filed.length === 0
      ? []
      : [
          ` (already filed as ${filed.map((question) => question.id).join(', ')}? File it again at P0, then close the old one: `,
          {
            code: `br close ${filed.length === 1 && filed[0] != null ? filed[0].id : '<id>'} --reason "raised to P0 as <new id>"`,
          },
          ')',
        ];
  return {
    code: null,
    sub: [
      done,
      [
        'not done, and you can go on → keep working; act on the default of any P1–P3 question Justin has not answered',
      ],
      [
        'not done, and it cannot move without Justin → file that question as a P0: ',
        {code: sdkRun(`thread ask "…" --priority 0 --to ${request.id}`)},
        ...raise,
      ],
    ],
    text: `Request ${request.id} ("${request.title}") ${where}${allClosed} and nothing blocks it.`,
  };
}

/** How much of Justin's first message the all-closed line quotes. */
export const FIRST_MESSAGE_CUT = 300;

/** The first message as one line, cut at FIRST_MESSAGE_CUT characters. */
export function firstMessageQuote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= FIRST_MESSAGE_CUT
    ? flat
    : `${flat.slice(0, FIRST_MESSAGE_CUT).trimEnd()}…`;
}

/** home-base-yukaf.3: every request closed — check his first message first. */
function allRequestsClosedLine(
  item: Extract<MarkItem, {kind: 'allRequestsClosed'}>,
): MarkView {
  const closed =
    item.closedCount === 1
      ? 'The one request is closed'
      : `All ${item.closedCount} requests are closed`;
  const still =
    'does not exist and is not answered in your message, it is still a request:';
  const code = sdkRun('thread request "…"');
  const first = item.firstMessage;
  if (!first.ok) {
    return {
      code,
      sub: [],
      text: `⚠️ ${closed}, but Justin's first message could not be read (${first.reason}). Read it in the transcript. If anything he asked for there, or later, ${still}`,
    };
  }
  if (first.value == null) {
    return {
      code,
      sub: [],
      text: `⚠️ ${closed}, but the message log holds no message from Justin, so his first message cannot be quoted. Read it in the transcript. If anything he asked for there, or later, ${still}`,
    };
  }
  return {
    code,
    sub: [],
    text: `${closed}. Justin's first message was: "${firstMessageQuote(first.value)}". If anything he asked for there, or later, ${still}`,
  };
}

/**
 * home-base-ys9t7.9.1: Justin's own example of a good summary (home-base-
 * ys9t7.9, 2026-10-30), quoted in the item so the session sees the shape.
 */
export const TITLE_SUMMARY_EXAMPLE =
  'Build shortcut helper app; make installable via link; iterate on inspect utility';

function titleSummaryLine(
  item: Extract<MarkItem, {kind: 'titleSummary'}>,
): MarkView {
  const n = item.since.length;
  let why: string;
  switch (item.why) {
    case 'autoTitle':
      why = `The session is still titled with the first line of Justin's first prompt ("${item.title}").`;
      break;
    case 'filedSince':
      why = `The session title ("${item.title}") was set before ${n === 1 ? 'this request was' : `these ${n} requests were`} filed: ${item.since.map((request) => `"${request.title}"`).join('; ')}.`;
      break;
    case 'unrecorded':
      why = `The session title ("${item.title}") may not cover all ${item.requestCount} of this session's requests: when it was set is not recorded.`;
      break;
  }
  const chain = item.continues != null;
  const extend = chain
    ? ` This session continues ${item.continues}: extend the summary it inherited rather than replace it.`
    : '';
  return {
    code: sdkRun('thread title "…"'),
    sub: [],
    text: `${why} Rewrite it as a short summary, under ${SESSION_NAME_LIMIT} characters, of everything this session${chain ? ' and the sessions it continues' : ''} asked for and talked about, done or open, like "${TITLE_SUMMARY_EXAMPLE}".${extend} It names the inbox entry and the cmux workspace.`,
  };
}

/** One "What to mark" entry, in plain words, with the command that fixes it. */
export function markLine(item: MarkItem): MarkView {
  switch (item.kind) {
    case 'allRequestsClosed':
      return allRequestsClosedLine(item);
    case 'requestChildrenClosed':
      return {
        code: `br close ${item.request.id} --reason "…"`,
        sub: [],
        text: `Request ${item.request.id} ("${item.request.title}") has every child closed but is still open: close it, or say in your message what remains.`,
      };
    case 'requestOpenNoBlocker':
      return requestOpenLines(item);
    case 'noRequest': {
      const what = [
        item.commits > 0
          ? `${item.commits} commit${item.commits === 1 ? '' : 's'}`
          : null,
        item.uncommitted > 0
          ? `${item.uncommitted} uncommitted path${item.uncommitted === 1 ? '' : 's'}`
          : null,
        // R3: commit evidence that matched no commit in this checkout.
        item.unmatchedCommits > 0
          ? `${item.unmatchedCommits} commit command${item.unmatchedCommits === 1 ? '' : 's'} that matched no commit here`
          : null,
      ]
        .filter((part): part is string => part != null)
        .join(' and ');
      return {
        code: sdkRun('thread request "…"'),
        sub: [],
        text: `${what} in this session, and no request filed: file one for the work Justin asked for.`,
      };
    }
    case 'adoptCandidate': {
      // home-base-vzwbj.4.19 D2.
      const n = item.under.length;
      const under =
        n === 0
          ? ''
          : ` (nor ${n === 1 ? 'is the bead' : `are the ${n} beads`} this session filed under it)`;
      return {
        code: sdkRun(`thread request --bead ${item.bead.id}`),
        sub: [],
        text: `This session created ${item.bead.id} ("${item.bead.title}", ${item.bead.status.replace(/_/g, ' ')}), which is not a request${under}. If Justin asked for this, adopt it:`,
      };
    }
    case 'createdNotFound': {
      const ids = item.missing.map((entry) => entry.id);
      const searched = [
        ...new Set(item.missing.flatMap((entry) => entry.searched)),
      ];
      return {
        code: null,
        sub: [],
        text: `⚠️ Could not check whether ${ids.join(', ')}, created by this session with br create, ${ids.length === 1 ? 'is a request' : 'are requests'} Justin asked for: ${ids.length === 1 ? 'it is' : 'they are'} not in ${searched.length > 0 ? searched.join(' or ') : 'any beads export this session names'}.`,
      };
    }
    case 'createdNotThen':
      // home-base-j8q3e.13 F6.
      return {
        code: null,
        sub: [],
        text: `ℹ️ Named in the output of a br create in this session, but not created by it then, so not listed to adopt: ${item.beads.map((bead) => `${bead.id} (${bead.why})`).join('; ')}.`,
      };
    case 'undecided':
      // home-base-vzwbj.4.19 D3.
      return {
        code: sdkRun('thread request "…"'),
        sub: [],
        text: `Every request is closed, but "${item.bead.title}" (${item.bead.id}) is still undecided. If it decides work Justin wants, that work is an open request:`,
      };
    case 'titleSummary':
      return titleSummaryLine(item);
    case 'autoTitle':
      return {
        code: sdkRun('thread title "…"'),
        sub: [],
        text: `The session is still titled with the first line of Justin's first prompt ("${item.title}"): give it a plain-words name.`,
      };
    case 'unchecked':
      return {
        code: null,
        sub: [],
        text: `⚠️ Could not check ${item.what}: ${item.reason}.`,
      };
  }
}

export const VERDICT_LABEL = 'If you stop now the inbox will say:';

/**
 * home-base-vzwbj.4.16 G2: what a ⚠️ yield leads to, and the way out — said on
 * the verdict line, for ⚠️ ONLY (every other verdict is a real place to stop).
 */
export const OPEN_WORK_CONSEQUENCE =
  ' — Justin will be told to resume this session.';

function pieces(parts: readonly Piece[], color: boolean): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return tildeText(part);
      if ('strong' in part) {
        const text = tildeText(part.strong);
        return color ? paint(text, ['bold'], true) : `**${text}**`;
      }
      return color ? paint(part.code, ['cyan'], true) : `\`${part.code}\``;
    })
    .join('');
}

/**
 * home-base-tg45h decision 2: what to do with each open request before
 * stopping on ⚠️, in this order. An unanswered P1–P3 question is not a reason
 * to stop: its default is the plan.
 */
export const OPEN_WORK_SETTLE: readonly Piece[] = [
  'Before you stop, settle each open request: close it if its work is done; keep working if you can, acting on the default of any P1–P3 question Justin has not answered; or, if it cannot move without his answer, file that question as a P0.',
];

/**
 * home-base-tg45h decision 1: handing off is not a way to stop. It used to
 * sit beside "close" and "file the P0" as a peer, and on 2026-10-19 a session
 * whose only pending questions were optional handed off with its context far
 * from full.
 */
export const OPEN_WORK_HANDOFF: readonly Piece[] = [
  'Handing off is not a way to stop: run ',
  {code: SDK_HANDOFF_CALL},
  ' only when this session cannot go on (its context is nearly full, or Justin asked for a new session).',
];

/**
 * The verdict: one line, and for ⚠️ two more saying what to do (G2;
 * home-base-tg45h): settle each open request, and hand off only when the
 * session cannot go on.
 */
export function verdictLines(
  status: SessionStatus,
  style: OutputStyle,
): string[] {
  const words = tildeText(statusWords(status));
  const head = style.color
    ? `${pad(2)}${paint(VERDICT_LABEL, ['bold'], true)} ${words}`
    : `${VERDICT_LABEL} ${words}`;
  if (status.kind !== 'openWork') return [head];
  // On a TTY each paragraph wraps at the body indent and has an empty line
  // before it (home-base CLAUDE.md, Terminal output style); piped, it is one
  // plain line, as Claude reads it.
  const line = (parts: readonly Piece[]): string =>
    style.color
      ? `\n${wrapHanging(pieces(parts, true), {
          hang: 2,
          indent: 2,
          width: style.width,
        })}`
      : pieces(parts, false);
  return [
    `${head}${OPEN_WORK_CONSEQUENCE}`,
    line(OPEN_WORK_SETTLE),
    line(OPEN_WORK_HANDOFF),
  ];
}

export function renderThreadStatus(
  load: Extract<ReportLoad, {kind: 'loaded'}>,
  options: {now: Date; style: OutputStyle; timeZone?: string},
): string {
  const {style} = options;
  const partOne = renderPartOne(
    partOneView({
      action: load.action,
      counts: load.counts,
      model: load.model,
      now: options.now,
      optional: load.optional,
      status: load.status,
      timeZone: options.timeZone,
    }),
    style,
  );
  const marks = whatToMark(load.model, load.status, load.created, {
    titleSummary: load.titleSummary,
  })
    .map(markLine)
    .map((mark) => ({...mark, text: tildeText(mark.text)}));
  let markBlock: string;
  if (marks.length === 0) {
    markBlock = style.color ? `${pad(2)}Nothing to mark.` : 'Nothing to mark.';
  } else if (style.color) {
    markBlock = [
      sectionHeader('What to mark', {color: true, emoji: '✏️'}),
      ...marks.map((mark) =>
        [
          wrapHanging(
            `${paint('-', ['dim'], true)} ${mark.text}${mark.code == null ? '' : ` ${paint(mark.code, ['cyan'], true)}`}`,
            {hang: BODY_COLUMN + 2, indent: BODY_COLUMN, width: style.width},
          ),
          ...mark.sub.map((line) =>
            wrapHanging(`${paint('-', ['dim'], true)} ${pieces(line, true)}`, {
              hang: BODY_COLUMN + 4,
              indent: BODY_COLUMN + 2,
              width: style.width,
            }),
          ),
        ].join('\n'),
      ),
    ].join('\n\n');
  } else {
    markBlock = [
      '**What to mark:**',
      ...marks.map((mark) =>
        [
          `- ${mark.text}${mark.code == null ? '' : ` \`${mark.code}\``}`,
          ...mark.sub.map((line) => `  - ${pieces(line, false)}`),
        ].join('\n'),
      ),
    ].join('\n\n');
  }
  return spacedList([
    SESSION_BEADS_ENABLED_LINE,
    partOne,
    markBlock,
    verdictLines(load.status, style).join('\n'),
  ]);
}

/** `thread status`: print, return the exit code. */
export async function runThreadStatus(
  options: ThreadStatusOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const style = options.style ?? outputStyle(process.stdout);
  const load = await loadForReport({
    asIfYielded: true,
    cwd,
    env,
    now,
    selector: null,
    sessionId: options.sessionId,
  });
  if (load.kind === 'disabled') {
    // Exit 0: "off" is an answer the rule branches on, not a failure (D6).
    console.log(refusalLines('thread status', load).join('\n'));
    return 0;
  }
  if (load.kind !== 'loaded') {
    console.error(refusalLines('thread status', load).join('\n'));
    return 1;
  }
  console.log(
    renderThreadStatus(load, {now, style, timeZone: options.timeZone}),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// thread show (v4)
// ---------------------------------------------------------------------------

export interface SessionShowOptions extends CommonOptions {
  /** `--full`: Justin's messages uncut. */
  full: boolean;
  /** A session bead id, a session id, or a request/question id. */
  selector: string | null;
  sessionId: string | null;
}

/** One of Justin's messages, cut at USER_MESSAGE_CUT unless `full`. */
export function cutMessage(text: string, full: boolean): string {
  const trimmed = text.trim();
  if (full || trimmed.length <= USER_MESSAGE_CUT) return trimmed;
  const rest = trimmed.length - USER_MESSAGE_CUT;
  return `${trimmed.slice(0, USER_MESSAGE_CUT).trimEnd()}… (${rest} more character${rest === 1 ? '' : 's'}; --full shows them)`;
}

function messageStamp(
  line: MessageLine,
  now: Date,
  timeZone?: string,
): string | null {
  const ms = parseInstant(line.at);
  return ms == null ? null : whenWords(new Date(ms), now, timeZone);
}

/**
 * The epics this session's requests and created beads sit under
 * (home-base-y1hg0.7), read from the same exports as its tree. Read here and
 * not in `loadForReport`, so `thread status` and the inbox never pay for it.
 */
export function relatedEpicsOf(
  load: Extract<ReportLoad, {kind: 'loaded'}>,
): RelatedEpics {
  return findRelatedEpics({
    created: load.created,
    sessionDirs: [
      ...new Set(load.model.sightings.map((entry) => entry.beadsDir)),
    ],
    tree: load.model.beads,
  });
}

/**
 * home-base-mbnjv.3 (D9, C9): the "Handoff chain" section's lines, or null
 * when the session bead carries no handoff label (no section is printed, so a
 * session that never handed off prints exactly what it did before). The
 * chain runs both ways from this session; the unattended count is the chain
 * walk's (walkUnattendedChain) from the newest session, the one the gate
 * would count from on the next handoff.
 */
export function handoffSectionLines(
  load: Extract<ReportLoad, {kind: 'loaded'}>,
  readers: {chain: ChainReaders; view: ChainViewReaders},
): string[] | null {
  const session = load.model.beads.session;
  if (session == null) return null;
  if (!hasHandoffRecord(session.labels)) return null;
  const chain = readHandoffChain(load.model.sessionBeadId, readers.view);
  if ('kind' in chain) {
    return [`⚠️ The handoff chain could not be read: ${chain.reason}`];
  }
  const newest = chain.nodes.at(-1)?.beadId ?? null;
  // A walk that stopped before the newest end does not know the newest
  // session, so it does not claim a count for it (rule 7).
  const forwardStopped = chain.problems.length > 0;
  let unattended: UnattendedCountView;
  if (newest == null || forwardStopped) {
    unattended = {
      kind: 'unknown',
      newest: null,
      reason: 'the chain could not be read to its end (below)',
    };
  } else {
    const walked = walkUnattendedChain(newest, readers.chain);
    unattended =
      walked.kind === 'counted'
        ? {count: walked.unattendedHandoffs, kind: 'counted', newest}
        : {kind: 'unknown', newest, reason: walked.reason};
  }
  return chainLines(chain, unattended);
}

/** The real readers of the "Handoff chain" section. */
export function realHandoffSectionReaders(input: {cwd: string; env: EnvLike}): {
  chain: ChainReaders;
  view: ChainViewReaders;
} {
  return {
    chain: realChainReaders(input),
    view: realChainViewReaders(input),
  };
}

export function renderSessionShow(
  load: Extract<ReportLoad, {kind: 'loaded'}>,
  options: {
    full: boolean;
    /** The "Handoff chain" section (`handoffSectionLines`); null = none. */
    handoff?: string[] | null;
    now: Date;
    /** The "Related epics" section's content (`relatedEpicsOf`). */
    related: RelatedEpics;
    style: OutputStyle;
    timeZone?: string;
  },
): string {
  const {now, style, timeZone} = options;
  const {model} = load;
  const related = renderRelatedEpics(options.related, style);
  const handoff = options.handoff ?? null;
  const partOne = renderPartOne(
    partOneView({
      action: load.action,
      counts: load.counts,
      model,
      now,
      optional: load.optional,
      status: load.status,
      timeZone,
    }),
    style,
  );

  // ---- From Claude ----
  const last = lastAssistantLine(model.log);
  let claude: string;
  if (!last.ok) claude = `⚠️ Unknown: ${last.reason}.`;
  else if (last.value == null)
    claude = '(Claude has not yielded in this session yet.)';
  else {
    const stripped = stripPastedPartOne(last.value.text);
    claude =
      stripped === ''
        ? '(Claude’s last message was only a pasted Part 1.)'
        : stripped;
  }

  // ---- Your messages ----
  const users = userLines(model.log);
  let mine: string[];
  if (!users.ok) mine = [`⚠️ Unknown: ${users.reason}.`];
  else if (users.value.length === 0) mine = ['(None captured.)'];
  else {
    mine = users.value.map((line, index) => {
      const marker = `${index + 1}. `;
      const stamp = messageStamp(line, now, timeZone);
      const text = cutMessage(line.text, options.full);
      const body = stamp == null ? text : `(${stamp}) ${text}`;
      const [head = '', ...rest] = body.split('\n');
      return [
        `${marker}${head}`,
        ...rest.map((entry) =>
          entry === '' ? '' : `${pad(marker.length)}${entry}`,
        ),
      ].join('\n');
    });
  }

  if (!style.color) {
    return spacedList([
      partOne,
      ...related,
      ...(handoff == null ? [] : ['**Handoff chain:**', ...handoff]),
      '**From Claude:**',
      claude,
      '**Your messages:**',
      ...mine,
    ]);
  }
  const indent = (text: string): string =>
    text
      .split('\n')
      .map((entry) =>
        entry === ''
          ? ''
          : wrapHanging(entry, {
              hang: BODY_COLUMN,
              indent: BODY_COLUMN,
              width: style.width,
            }),
      )
      .join('\n');
  return spacedList([
    partOne,
    ...related,
    ...(handoff == null
      ? []
      : [
          sectionHeader('Handoff chain', {color: true, emoji: '🔗'}),
          ...handoff.map(indent),
        ]),
    sectionHeader('From Claude', {color: true, emoji: '💬'}),
    indent(claude),
    sectionHeader('Your messages', {color: true, emoji: '🗣️'}),
    ...mine.map(indent),
  ]);
}

/** `thread show` with the knob on: print, return the exit code. */
export async function runSessionShow(
  options: SessionShowOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const style = options.style ?? outputStyle(process.stdout);
  const load = await loadForReport({
    asIfYielded: false,
    cwd,
    env,
    now,
    selector: options.selector,
    sessionId: options.sessionId,
  });
  if (load.kind !== 'loaded') {
    const lines = refusalLines('thread show', load);
    console.error(lines.join('\n'));
    return 1;
  }
  console.log(
    renderSessionShow(load, {
      full: options.full,
      handoff: handoffSectionLines(load, realHandoffSectionReaders({cwd, env})),
      now,
      related: relatedEpicsOf(load),
      style,
      timeZone: options.timeZone,
    }),
  );
  return 0;
}

/** For tests and the inbox: the loaded report without printing. */
export async function loadSessionReport(input: {
  asIfYielded: boolean;
  cwd: string;
  env: EnvLike;
  now: Date;
  selector: string | null;
  sessionId: string | null;
}): Promise<ReportLoad> {
  return await loadForReport(input);
}
