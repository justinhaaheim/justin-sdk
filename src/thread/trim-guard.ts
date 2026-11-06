/**
 * The trim guard (home-base-7761p.23; decisions D1 to D12 are in that bead's
 * design field).
 *
 * WHY IT EXISTS. A status report begins with a block `thread status` generates,
 * and sessions are told to paste it verbatim. Some cut it, so Justin loses the
 * questions they are asking him. A rule already said not to, and nothing
 * enforced it. The measured cause is a filter: sessions run `thread status` through
 * sed, head or tail, then paste what they saw.
 *
 * WHAT IT DOES. `thread status` saves the whole block before printing anything,
 * so no pipe can lose it. At Stop, a block in the reply must equal one of the
 * saved blocks, line for line after normalizing. One that does not sends the
 * session back once.
 *
 * WHAT MUST NOT HAPPEN. A false positive sends a session back for nothing. So
 * every "could not tell" passes with its own `why` (critical rule 7): no saved
 * file, an unreadable one, no block in the reply. Only an actual comparison
 * against actual evidence can block.
 *
 * Everything here except `readStatusBlocks` and `saveStatusBlock` is pure, and
 * `scripts/replay-trim-guard.ts` runs these same functions over history.
 */

import type {EnvLike} from './paths';
import type {StopCheckDecision} from './stop-check';

import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {dirname} from 'path';

import {SDK_RUN} from '../sdk-invocation';
import {statusBlocksPath} from './archive';
import {
  isRuleLine,
  isSeparatorLine,
  isSessionFieldLine,
  PART_ONE_RULE,
} from './part-one';

// ---------------------------------------------------------------------------
// D3: normalize, one function for both sides
// ---------------------------------------------------------------------------

/** What replaces the value of a field that changes between two runs. */
export const VOLATILE_VALUE = '<changes between runs>';

/**
 * The fields that differ between two runs seconds apart (D3). The line stays,
 * so deleting it is still caught; only its value goes. This list stays at
 * three: Status, You need to, the question count and the Session title also
 * change when work happens between two runs, and a reply stitched from two such
 * runs is the defect this guard exists for.
 */
const VOLATILE_FIELD =
  /^((?:- )?\*\*(?:Last activity|Context|Commits this session):\*\*)(?:\s.*)?$/u;

/** One line in its compared form, or null for a line the comparison ignores. */
export function normalizeBlockLine(line: string): string | null {
  const collapsed = line.trim().replace(/\s+/gu, ' ');
  if (collapsed === '' || collapsed === '---') return null;
  if (isRuleLine(collapsed)) return PART_ONE_RULE;
  const bulleted = collapsed.startsWith('* ')
    ? `- ${collapsed.slice(2)}`
    : collapsed;
  const volatile = VOLATILE_FIELD.exec(bulleted);
  return volatile == null ? bulleted : `${volatile[1]} ${VOLATILE_VALUE}`;
}

/** Text in its compared form, and where a block starts in it. */
export interface NormalizedText {
  lines: string[];
  /** Indexes into `lines` of each block start (D4). */
  starts: number[];
}

/** The fence a line opens, or null. A backtick fence's info has no backtick. */
function fenceOpenedBy(line: string): {char: string; length: number} | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match == null) return null;
  const run = match[1] ?? '';
  const rest = match[2] ?? '';
  if (run.startsWith('`') && rest.includes('`')) return null;
  return {char: run.charAt(0), length: run.length};
}

/** Does this line close the open fence? Same character, at least as long. */
function closesFence(
  line: string,
  fence: {char: string; length: number},
): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length &&
    [...trimmed].every((char) => char === fence.char)
  );
}

/**
 * Normalize text and find its block starts (D3, D4).
 *
 * A start is a rule line whose next non-blank line is the Session field. One
 * inside a code fence does not count, so a reply that shows a block as an example
 * has no block. A legacy v3 report (🛑 then ⚡) has no Session field and no start.
 */
export function normalizeText(text: string): NormalizedText {
  const raw = text.split('\n');
  const lines: string[] = [];
  const starts: number[] = [];
  let fence: {char: string; length: number} | null = null;
  raw.forEach((line, index) => {
    if (fence != null) {
      if (closesFence(line, fence)) fence = null;
    } else {
      fence = fenceOpenedBy(line);
      if (fence == null && isRuleLine(line)) {
        let next = index + 1;
        while (next < raw.length && (raw[next] ?? '').trim() === '') next += 1;
        if (isSessionFieldLine(raw[next] ?? '')) starts.push(lines.length);
      }
    }
    const normalized = normalizeBlockLine(line);
    if (normalized != null) lines.push(normalized);
  });
  return {lines, starts};
}

// ---------------------------------------------------------------------------
// D5: compare
// ---------------------------------------------------------------------------

/**
 * D5: are these block lines a consecutive run of the reply, beginning at a block
 * start? So Part 2 after the block is ignored, a `───` line inside a question
 * cannot cut the block short, and a line added inside the block fails.
 */
export function blockIsInReply(
  block: readonly string[],
  reply: NormalizedText,
): boolean {
  if (block.length === 0) return false;
  return reply.starts.some(
    (start) =>
      start + block.length <= reply.lines.length &&
      block.every((line, offset) => reply.lines[start + offset] === line),
  );
}

export interface BlockDifference {
  /** Lines the tool did not print. */
  added: string[];
  /** Printed lines the reply does not have. */
  missing: string[];
}

/** `from` with each line of `remove` taken out once, order kept. */
function withoutLines(
  from: readonly string[],
  remove: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const line of remove) counts.set(line, (counts.get(line) ?? 0) + 1);
  return from.filter((line) => {
    const count = counts.get(line) ?? 0;
    if (count === 0) return true;
    counts.set(line, count - 1);
    return false;
  });
}

/**
 * Where the block that starts at `start` ends in the reply: at the separator
 * matching the saved block's last one, so a `───` inside a question does not end
 * it early and Part 2 stays out of the count. Short of that many, the last
 * separator it saw, else the next block start, else the end of the reply.
 */
function replyBlockEnd(
  reply: NormalizedText,
  start: number,
  separators: number,
): number {
  const next = reply.starts.find((other) => other > start);
  const limit = next ?? reply.lines.length;
  let seen = 0;
  let lastSeparator: number | null = null;
  for (let at = start; at < limit; at += 1) {
    if (!isSeparatorLine(reply.lines[at] ?? '')) continue;
    seen += 1;
    lastSeparator = at;
    if (seen === separators) return at + 1;
  }
  return lastSeparator == null ? limit : lastSeparator + 1;
}

/**
 * What differs, for the send-back's words (D8). Not what decides: `blockIsInReply`
 * does. With several starts it reports the closest. Both lists empty means the
 * same lines in another order.
 */
export function blockDifference(
  block: readonly string[],
  reply: NormalizedText,
): BlockDifference {
  const separators = block.filter(isSeparatorLine).length;
  let closest: BlockDifference = {added: [], missing: [...block]};
  let closestSize = Number.POSITIVE_INFINITY;
  for (const start of reply.starts) {
    const region = reply.lines.slice(
      start,
      replyBlockEnd(reply, start, separators),
    );
    const difference = {
      added: withoutLines(region, block),
      missing: withoutLines(block, region),
    };
    const size = difference.added.length + difference.missing.length;
    if (size < closestSize) {
      closest = difference;
      closestSize = size;
    }
  }
  return closest;
}

// ---------------------------------------------------------------------------
// D6, D7, D8: the decision
// ---------------------------------------------------------------------------

export interface SavedBlock {
  at: string;
  text: string;
}

/**
 * What the saved file said. Three states on purpose (critical rule 7): "there is
 * none" and "I could not read it" both pass, but they are different facts and
 * each gets its own `why`.
 */
export type SavedBlocks =
  | {blocks: readonly SavedBlock[]; kind: 'found'; malformed: number}
  | {error: string; kind: 'unknown'}
  | {kind: 'none'};

/** What the guard can decide from without reading anything. */
export interface TrimGuardGate {
  agentId: string | null;
  /** The spend quota's brake has this session braked. */
  braked: boolean;
  /** `last_assistant_message` from the payload, never the transcript. */
  lastAssistantMessage: string | null;
  sessionId: string | null;
  /** Claude Code's own loop guard: a Stop hook already blocked this turn. */
  stopHookActive: boolean;
}

export interface TrimGuardInputs extends TrimGuardGate {
  saved: SavedBlocks;
}

export interface TrimGuardDecision extends StopCheckDecision {
  /** D9: on a block, how many lines the tool did not print. Else null. */
  added: number | null;
  /** D9: on a block, how many printed lines are missing. Else null. */
  missing: number | null;
}

function pass(why: StopCheckDecision['why']): TrimGuardDecision {
  return {action: 'pass', added: null, missing: null, reason: null, why};
}

/**
 * D7: the guard's own passes, before any reading. Null means keep going: the
 * reply has a block and the saved file is worth reading.
 */
export function trimGuardEarlyPass(
  gate: TrimGuardGate,
): TrimGuardDecision | null {
  if (gate.agentId != null && gate.agentId !== '') return pass('subagent');
  if (gate.braked) return pass('quotaBraked');
  if (gate.stopHookActive) return pass('stopHookActive');
  if (gate.sessionId == null || gate.sessionId === '')
    return pass('noSessionId');
  // D4: no start means nothing to compare, which is how a one-line note, prose
  // and a legacy report all pass.
  if (normalizeText(gate.lastAssistantMessage ?? '').starts.length === 0)
    return pass('trimGuardNoBlock');
  return null;
}

/** How long one quoted line may be in a send-back (D8). */
export const REASON_LINE_CUT = 120;
/** How many lines of each kind a send-back quotes (D8). */
export const REASON_LINES_SHOWN = 3;

function quotedLines(lines: readonly string[]): string[] {
  return lines.slice(0, REASON_LINES_SHOWN).map((line) => {
    const chars = [...line];
    return chars.length <= REASON_LINE_CUT
      ? `- ${line}`
      : `- ${chars.slice(0, REASON_LINE_CUT).join('')}…`;
  });
}

/** D8: short and literal. What differs, then what to do. */
export function trimGuardBlockReason(difference: BlockDifference): string {
  const {added, missing} = difference;
  const sameLines = added.length === 0 && missing.length === 0;
  const sections: string[] = [
    sameLines
      ? `The status block in this reply differs from what ${SDK_RUN} thread status printed: it has the same lines as the newest saved block, in a different order.`
      : `The status block in this reply differs from what ${SDK_RUN} thread status printed. Compared with the newest saved block, ${missing.length} printed line${missing.length === 1 ? ' is' : 's are'} missing and ${added.length} line${added.length === 1 ? ' is one' : 's are ones'} the tool did not print.`,
  ];
  if (missing.length > 0) {
    sections.push(['Missing:', ...quotedLines(missing)].join('\n'));
  }
  if (added.length > 0) {
    sections.push(
      ['Not printed by the tool:', ...quotedLines(added)].join('\n'),
    );
  }
  sections.push(
    `Run ${SDK_RUN} thread status, read ALL of its output with no sed, head or tail, then paste from the 🛑 line through the ──── line verbatim. Do not shorten any question.`,
  );
  return sections.join('\n\n');
}

/**
 * The whole decision, as a pure function. No filesystem, no clock, no env.
 *
 * The caller still owes the once-per-turn marker on a block (D7): that needs the
 * filesystem and, without a `prompt_id`, the transcript, and neither is read
 * until a difference is found.
 */
export function decideTrimGuard(inputs: TrimGuardInputs): TrimGuardDecision {
  const early = trimGuardEarlyPass(inputs);
  if (early != null) return early;
  if (inputs.saved.kind === 'none') return pass('trimGuardNoSaved');
  if (inputs.saved.kind === 'unknown') return pass('trimGuardUnknown');
  const newestFirst = [...inputs.saved.blocks].reverse();
  const newest = newestFirst[0];
  if (newest == null) return pass('trimGuardNoSaved');

  const reply = normalizeText(inputs.lastAssistantMessage ?? '');
  const newestLines = normalizeText(newest.text).lines;
  if (blockIsInReply(newestLines, reply)) return pass('trimGuardMatchLatest');
  if (
    newestFirst.some((saved) =>
      blockIsInReply(normalizeText(saved.text).lines, reply),
    )
  ) {
    return pass('trimGuardMatchEarlier');
  }

  const difference = blockDifference(newestLines, reply);
  return {
    action: 'block',
    added: difference.added.length,
    missing: difference.missing.length,
    reason: trimGuardBlockReason(difference),
    why: 'trimGuardDiffers',
  };
}

// ---------------------------------------------------------------------------
// D2, D6: the saved file
// ---------------------------------------------------------------------------

/** D2: how many blocks one session's file keeps. */
export const STATUS_BLOCKS_KEPT = 20;

/** The well-formed entries of a saved file's text, and how many lines were not. */
function parseSavedText(raw: string): {
  blocks: SavedBlock[];
  lines: number;
  malformed: number;
} {
  const blocks: SavedBlock[] = [];
  let lines = 0;
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformed += 1;
      continue;
    }
    const entry = (parsed ?? {}) as {at?: unknown; text?: unknown};
    // D6: a line that does not hold a block is skipped and counted. It is never
    // read as text, because a block that can match nothing would send a session
    // back for nothing.
    if (
      typeof entry.at !== 'string' ||
      typeof entry.text !== 'string' ||
      normalizeText(entry.text).starts[0] !== 0
    ) {
      malformed += 1;
      continue;
    }
    blocks.push({at: entry.at, text: entry.text});
  }
  return {blocks, lines, malformed};
}

function errorCode(error: unknown): string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * D6: the session's saved blocks, oldest first. No file or no lines is `none`
 * (a session on an older SDK, a forked session). An unreadable file, or one with
 * no parseable line, is `unknown`.
 */
export function readStatusBlocks(
  sessionId: string,
  env: EnvLike = process.env,
): SavedBlocks {
  const path = statusBlocksPath(sessionId, env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'none'};
    return {error: `read ${path}: ${errorText(error)}`, kind: 'unknown'};
  }
  const {blocks, lines, malformed} = parseSavedText(raw);
  if (lines === 0) return {kind: 'none'};
  if (blocks.length === 0) {
    return {
      error: `${path}: none of its ${lines} line(s) could be parsed`,
      kind: 'unknown',
    };
  }
  return {blocks, kind: 'found', malformed};
}

/**
 * D2: the file's next contents, or null when the newest entry already normalizes
 * to the same text. Pure, so the replay keeps its history the way a live session
 * would.
 */
export function nextSavedBlocks(
  blocks: readonly SavedBlock[],
  entry: SavedBlock,
): SavedBlock[] | null {
  const newest = blocks.at(-1);
  if (newest != null) {
    const before = normalizeText(newest.text).lines;
    const after = normalizeText(entry.text).lines;
    if (
      before.length === after.length &&
      before.every((line, index) => line === after[index])
    ) {
      return null;
    }
  }
  return [...blocks, entry].slice(-STATUS_BLOCKS_KEPT);
}

export type SaveOutcome =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'saved'; path: string}
  | {kind: 'unchanged'; path: string};

/**
 * D2: save one block. Rewrites through a temp file and a rename, so a reader
 * never sees half a file. NEVER THROWS: a failure is an outcome, and `thread
 * status` still prints.
 */
export function saveStatusBlock(args: {
  at: Date;
  env?: EnvLike;
  sessionId: string;
  text: string;
}): SaveOutcome {
  const env = args.env ?? process.env;
  const path = statusBlocksPath(args.sessionId, env);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const next = nextSavedBlocks(parseSavedText(raw).blocks, {
      at: args.at.toISOString(),
      text: args.text,
    });
    if (next == null) return {kind: 'unchanged', path};
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      temp,
      next
        .map((entry) => JSON.stringify({at: entry.at, text: entry.text}))
        .map((line) => `${line}\n`)
        .join(''),
    );
    renameSync(temp, path);
    return {kind: 'saved', path};
  } catch (error) {
    try {
      rmSync(temp, {force: true});
    } catch {
      // The temp file is the smaller problem; the caller reports the real one.
    }
    return {error: errorText(error), kind: 'failed', path};
  }
}
