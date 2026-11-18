/**
 * The message of Justin's that led to a request, written into the request
 * bead by `thread request` (home-base-6ujwi D9 to D14), behind
 * `componentConfig.thread.requestMessage` (default false; true in home-base).
 *
 * Justin, 2026-11-17: "insist that every bead that is coming from something
 * that I said contains like not even just a sort of excerpt, but like the kind
 * of full context of the thing that I said".
 *
 * WHICH MESSAGE (D9, D11). His newest message in this session's message log:
 * the newest line justin-messages.ts classifies as `justin` (not a kickoff, a
 * machine line or a harness notice). The capture hook appends a prompt to the
 * log before Claude can run `thread request` (capture.ts), so the newest is
 * the one that led to the request, unless that append failed. The guard: the
 * transcript's prompts, classified the same way, must not hold a message of
 * his newer than the log's newest. When they do, or the transcript cannot be
 * found or read, nothing is attached, and the section says the message could
 * not be established.
 *
 * WHERE IT GOES (D10). A section appended to the bead's description, after the
 * existing text, under REQUEST_MESSAGE_HEADING. Existing text is never
 * changed. The message is verbatim inside a fenced block whose fence is longer
 * than any backtick run in it. A section for the same message id (or the same
 * "no message" or "could not be established" line) is written once.
 *
 * NO MESSAGE OF HIS (D12): one line saying so and how the session began, from
 * the session bead's `spawned-by:`, `continues:` and `spawn-kickoff` labels.
 * No fallback to another session's messages.
 *
 * PRIVATE (D13): privacy.ts's verdict for this session, its working
 * directories taken from its own message log (messages-command.ts's
 * realPrivacyCheck and logCwds). Private, or unknown, writes nothing.
 *
 * NEVER STOPS THE REQUEST (D14). It runs after the request is filed, never
 * throws, and its outcome is one printed line; a failure is loud and never
 * changes the exit code. Knob off: nothing here runs, so the message log is
 * not read.
 */

import type {JustinMessage} from './justin-messages';
import type {MessageLine} from './message-log';
import type {EnvLike} from './paths';

import {brShow, brUpdate, describeBrFailed} from '../beads/br';
import {formatLocalDate, formatLocalISO, formatLocalTime} from '../date';
import {sdkRun} from '../sdk-invocation';
import {
  CONTINUES_LABEL_PREFIX,
  REQUEST_LABEL,
  sidLabel,
  SPAWN_KICKOFF_LABEL,
  SPAWNED_BY_LABEL_PREFIX,
} from './session-bead';
import {
  forEachTranscriptLine,
  queuedPromptText,
  queuedPromptTimestamp,
  substantiveUserText,
} from './transcript-messages';

/** The heading the tool owns (D10). */
export const REQUEST_MESSAGE_HEADING =
  "## Justin's message that led to this request";

const NONE_OPENING = "No message of Justin's precedes this request";
const UNESTABLISHED_OPENING = "Justin's message could not be established";

/** What attaching did; null when the knob is off. */
export type RequestMessageOutcome =
  | {at: string; kind: 'attached'; messageId: string}
  | {kind: 'already'; messageId: string}
  | {began: string; kind: 'none'; written: boolean}
  | {kind: 'unestablished'; reason: string; written: boolean}
  | {kind: 'private'; reason: string}
  | {kind: 'logUnread'; reason: string}
  | {kind: 'failed'; reason: string; retry: string};

type TranscriptRecord = Parameters<typeof substantiveUserText>[0];

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** `2026-11-18 14:05 -08:00`, local time with its offset, or `time unknown`. */
export function localWhen(at: null | string): string {
  if (at == null) return 'time unknown';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  const offset = formatLocalISO(date).slice(-6);
  return `${formatLocalDate(date)} ${formatLocalTime(date).slice(0, 5)} ${offset}`;
}

/** A backtick fence longer than any backtick run in `text`, at least 3. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The section for one message: its id, its time and its text, verbatim. */
export function messageSection(message: JustinMessage): string {
  const fence = fenceFor(message.text);
  return [
    REQUEST_MESSAGE_HEADING,
    '',
    `Message \`${message.id}\`, sent ${localWhen(message.at)}. \`${sdkRun(`thread messages --context ${message.id}`)}\` shows it with the replies around it.`,
    '',
    fence,
    message.text,
    fence,
  ].join('\n');
}

/** How the session began, from its bead's labels (D12). */
export function howSessionBegan(labels: readonly string[]): string {
  const spawnedBy = labels
    .filter((label) => label.startsWith(SPAWNED_BY_LABEL_PREFIX))
    .map((label) => label.slice(SPAWNED_BY_LABEL_PREFIX.length));
  const continues = labels
    .filter((label) => label.startsWith(CONTINUES_LABEL_PREFIX))
    .map((label) => label.slice(CONTINUES_LABEL_PREFIX.length));
  const parts = [
    ...spawnedBy.map((bead) => `it was started by session bead ${bead}`),
    ...continues.map((bead) => `it continues session bead ${bead}`),
  ];
  if (parts.length > 0) return `${parts.join(', and ')}, from a kickoff`;
  if (labels.includes(SPAWN_KICKOFF_LABEL)) return 'it began from a kickoff';
  return 'its session bead names no kickoff (no spawned-by: or continues: label)';
}

export function noneSection(began: string): string {
  return [
    REQUEST_MESSAGE_HEADING,
    '',
    `${NONE_OPENING} in this session: ${began}.`,
  ].join('\n');
}

export function unestablishedSection(reason: string): string {
  return [
    REQUEST_MESSAGE_HEADING,
    '',
    `${UNESTABLISHED_OPENING}, so nothing was attached: ${reason}.`,
  ].join('\n');
}

/**
 * The keys of the sections the description already holds: `message:<id>`,
 * `none` or `unestablished`. A heading inside a fenced block (a message that
 * quotes one) is not a section.
 */
export function sectionKeys(description: string): Set<string> {
  const keys = new Set<string>();
  const lines = description.split('\n');
  let fence: null | string = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const opening = /^ {0,3}(`{3,})/u.exec(line);
    if (fence != null) {
      if (line.trim() === opening?.[1] && opening[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (opening?.[1] != null) {
      fence = opening[1];
      continue;
    }
    if (line.trim() !== REQUEST_MESSAGE_HEADING) continue;
    let next = index + 1;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    const first = lines[next] ?? '';
    const id = /^Message `([^`]+)`/u.exec(first)?.[1];
    if (id != null) keys.add(`message:${id}`);
    else if (first.startsWith(NONE_OPENING)) keys.add('none');
    else if (first.startsWith(UNESTABLISHED_OPENING)) keys.add('unestablished');
  }
  return keys;
}

/** The description with `section` after the existing text, which is kept as it is. */
export function appendSection(
  existing: null | string,
  section: string,
): string {
  if (existing == null || existing === '') return section;
  return `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${section}`;
}

// ---------------------------------------------------------------------------
// The guard (D11)
// ---------------------------------------------------------------------------

export type TranscriptPromptsRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; prompts: MessageLine[]};

/**
 * Every prompt in the transcript at `path`, as the message log stores one
 * (transcript-messages.ts: a user record's substantive text, or a prompt
 * queued mid-turn), in order. A line that is not JSON after the newest prompt
 * could be a newer prompt, so it fails the read; a partial last line is a
 * record still being written and does not.
 */
export function readTranscriptPrompts(path: string): TranscriptPromptsRead {
  const prompts: MessageLine[] = [];
  let lastPromptIndex = -1;
  let lastIndex = -1;
  const malformed: number[] = [];
  try {
    forEachTranscriptLine(path, (line, index) => {
      lastIndex = index;
      if (line.trim() === '') return;
      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        malformed.push(index);
        return;
      }
      if (record.isSidechain === true) return;
      const typed = substantiveUserText(record);
      const queued = typed == null ? queuedPromptText(record) : null;
      const text = typed ?? queued;
      if (text == null) return;
      const at =
        queued != null
          ? queuedPromptTimestamp(record)
          : typeof record.timestamp === 'string'
            ? record.timestamp
            : null;
      prompts.push({at, cwd: null, event: 'backfill', role: 'user', text});
      lastPromptIndex = index;
    });
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the transcript ${path} could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const after = malformed.filter(
    (index) => index > lastPromptIndex && index !== lastIndex,
  );
  if (after.length > 0) {
    return {
      kind: 'failed',
      reason: `the transcript ${path} has ${after.length} line(s) after its newest prompt that are not JSON, and any of them could be a newer message`,
    };
  }
  return {kind: 'read', prompts};
}

/**
 * Why the log's newest message of his is not the transcript's, or null when
 * it is (D11). Text is compared with whitespace collapsed, as dispatch 1's
 * annotate matches them; the same text sent again is caught by counting it.
 */
export function logLagReason(input: {
  logMessages: readonly JustinMessage[];
  transcriptMessages: readonly JustinMessage[];
}): null | string {
  const newest = input.transcriptMessages.at(-1);
  if (newest == null) return null;
  const logNewest = input.logMessages.at(-1);
  const sent = `the transcript holds a message of his sent ${localWhen(newest.at)}`;
  if (logNewest == null) {
    return `${sent}, and the message log holds none of his, so the log missed it`;
  }
  const text = oneLine(newest.text);
  if (oneLine(logNewest.text) !== text) {
    return `${sent} that the message log does not end with (its newest is \`${logNewest.id}\`), so the log missed it`;
  }
  const count = (messages: readonly JustinMessage[]): number =>
    messages.filter((message) => oneLine(message.text) === text).length;
  if (count(input.transcriptMessages) > count(input.logMessages)) {
    return `${sent} whose words the transcript holds ${count(input.transcriptMessages)} times and the message log ${count(input.logMessages)}, so the log missed one`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The attach
// ---------------------------------------------------------------------------

export interface AttachRequestMessageInput {
  /** The filed or adopted request. */
  beadId: string;
  /** A `continues:` link this same command just made; null when none. */
  continued: null | {oldBeadId: string};
  cwd: string;
  /** The beads DB that holds the request. */
  db: string;
  env: EnvLike;
  /**
   * `--bead`: the bead's labels before this call adopted it; null for a
   * request this call created. Carrying `request` and this session's `sid:`
   * already makes the call a re-mark (F1).
   */
  labelsBeforeAdoption: null | readonly string[];
  sessionId: string;
  /** The session bead's labels as read; [] when its checkout is gone. */
  sessionLabels: readonly string[];
}

/**
 * F1 (home-base-6ujwi.3 fix round): a bead that was already this session's
 * request before the call (`thread request --bead <id> --short …`, or the
 * `--overarching --bead <id>` that "What to mark" asks for) is a re-mark. By
 * then his newest message is usually about something else, so a re-mark
 * attaches nothing and prints nothing.
 */
export function isReMark(
  labelsBeforeAdoption: null | readonly string[],
  sessionId: string,
): boolean {
  return (
    labelsBeforeAdoption != null &&
    labelsBeforeAdoption.includes(REQUEST_LABEL) &&
    labelsBeforeAdoption.includes(sidLabel(sessionId))
  );
}

/** The session bead's labels with the link this command made (D12). */
function labelsOf(input: AttachRequestMessageInput): string[] {
  return [
    ...input.sessionLabels,
    ...(input.continued == null
      ? []
      : [`${CONTINUES_LABEL_PREFIX}${input.continued.oldBeadId}`]),
  ];
}

async function attach(
  input: AttachRequestMessageInput,
  retry: string,
): Promise<RequestMessageOutcome> {
  const {env, sessionId} = input;
  const labels = labelsOf(input);
  const [
    {readMessageLog},
    {logCwds, realPrivacyCheck},
    {classifySessionLog},
    {findTranscript},
  ] = await Promise.all([
    import('./message-log'),
    import('./messages-command'),
    import('./justin-messages'),
    import('./facts'),
  ]);

  const log = readMessageLog(sessionId, env);
  if (log.kind !== 'read') {
    return {
      kind: 'logUnread',
      reason:
        log.kind === 'missing'
          ? `this session has no message log at ${log.path}`
          : `the message log ${log.path} could not be read (${log.error})`,
    };
  }
  // D13: before anything is written. Unknown privacy is private.
  const privacy = realPrivacyCheck(env)(sessionId, logCwds(log.lines));
  if (privacy.kind === 'private') {
    return {kind: 'private', reason: privacy.reason};
  }

  const logMessages = classifySessionLog({
    labels,
    lines: log.lines,
    sessionId,
  }).messages;

  // D11: the guard. Never falls through to attaching.
  let unestablished: null | string = null;
  const transcript = findTranscript(sessionId, env);
  if (transcript.status === 'not-found') {
    unestablished = `this session's transcript was not found under ${transcript.searched}`;
  } else if (transcript.status === 'failed') {
    unestablished = `this session's transcript could not be looked for (${transcript.error})`;
  } else {
    const prompts = readTranscriptPrompts(transcript.path);
    if (prompts.kind === 'failed') {
      unestablished = prompts.reason;
    } else {
      const transcriptMessages = classifySessionLog({
        labels,
        lines: prompts.prompts,
        sessionId,
      }).messages;
      unestablished = logLagReason({logMessages, transcriptMessages});
    }
  }
  // A malformed log line (log.failures) needs no check of its own: the guard
  // above has just shown the log ends with the transcript's newest message.

  const newest = logMessages.at(-1) ?? null;
  let key: string;
  let section: string;
  let done: RequestMessageOutcome;
  if (unestablished != null) {
    key = 'unestablished';
    section = unestablishedSection(unestablished);
    done = {kind: 'unestablished', reason: unestablished, written: true};
  } else if (newest == null) {
    const began = howSessionBegan(labels);
    key = 'none';
    section = noneSection(began);
    done = {began, kind: 'none', written: true};
  } else {
    key = `message:${newest.id}`;
    section = messageSection(newest);
    done = {at: localWhen(newest.at), kind: 'attached', messageId: newest.id};
  }

  const shown = brShow({db: input.db, env}, input.beadId);
  if (shown.kind !== 'ok') {
    return {
      kind: 'failed',
      reason:
        shown.kind === 'failed'
          ? `br show ${input.beadId} failed: ${describeBrFailed(shown)}`
          : `br show could not find ${input.beadId} in ${input.db}`,
      retry,
    };
  }
  const existing = shown.issue.description;
  if (sectionKeys(existing ?? '').has(key)) {
    if (done.kind === 'attached') {
      return {kind: 'already', messageId: done.messageId};
    }
    if (done.kind === 'none' || done.kind === 'unestablished') {
      return {...done, written: false};
    }
  }
  const written = brUpdate({db: input.db, env}, input.beadId, {
    description: appendSection(existing, section),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `br update ${input.beadId} --description failed: ${describeBrFailed(written)}`,
      retry,
    };
  }
  return done;
}

/** Write the section (D9 to D14). Null when the knob is off. Never throws. */
export async function attachRequestMessage(
  input: AttachRequestMessageInput,
): Promise<null | RequestMessageOutcome> {
  const {resolveThreadConfig} = await import('./config');
  if (!resolveThreadConfig({cwd: input.cwd, env: input.env}).requestMessage) {
    return null;
  }
  if (isReMark(input.labelsBeforeAdoption, input.sessionId)) return null;
  const retry = sdkRun(`thread request --bead ${input.beadId}`);
  try {
    return await attach(input, retry);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      retry,
    };
  }
}

/** The one line `thread request` prints (D14). */
export function requestMessageLine(outcome: RequestMessageOutcome): string {
  switch (outcome.kind) {
    case 'attached':
      return `  Justin's message ${outcome.messageId} (${outcome.at}) is attached to the description`;
    case 'already':
      return `  Justin's message ${outcome.messageId} was already in the description; nothing was written`;
    case 'none':
      return `  no message of Justin's precedes this request in this session (${outcome.began}); ${outcome.written ? 'the description says so' : 'the description already said so'}`;
    case 'unestablished':
      return `  ⚠️ Justin's message was NOT attached: it could not be established (${outcome.reason}); ${outcome.written ? 'the description says so' : 'the description already said so'}`;
    case 'private':
      return `  Justin's message was NOT attached, and nothing was written to the bead: this session is private (${outcome.reason})`;
    case 'logUnread':
      return `  ⚠️ Justin's message was NOT attached, and nothing was written to the bead: ${outcome.reason}, so neither the message nor whether this session is private could be established`;
    case 'failed':
      return `  ⚠️ Justin's message was NOT attached: ${outcome.reason}. The request IS filed. Retry with ${outcome.retry}`;
  }
}
