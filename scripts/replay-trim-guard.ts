#!/usr/bin/env bun
/**
 * Replay the trim guard over history (home-base-7761p.23 D10).
 *
 * Read-only. It reads the message logs in the threads state dir and the session
 * transcripts, runs the guard's own functions, and prints to stdout. There is no
 * second copy of the comparison here.
 *
 * WHAT HISTORY CAN AND CANNOT SAY. The live tool saves the whole block whatever
 * the pipe does, but a transcript shows only what passed through the pipe. So
 * each reply with a block lands in one of two classes:
 *
 *  COMPARABLE: an unfiltered run is visible, decided from the COMMAND TEXT and
 *  never from the output. A filter can leave the rule and the separator in place
 *  with the middle cut, so a run that looks whole may not be. Nothing may follow
 *  `thread status` except `2>&1`, or a `>` redirect to a file that a later Read
 *  shows whole (what follows a redirect cannot filter it). The newest run before the reply must be such a run, because
 *  otherwise the live guard would hold a newer block this replay cannot see. The
 *  one exception is a match: a reply equal to any visible whole block passes
 *  whatever came later. This count is the only pass rate history can give.
 *
 *  NOT COMPARABLE: only filtered views. Never counted as a pass. Each row prints
 *  the reply's lines that appear in no status output of that session, and
 *  whether its questions look complete, for reading by eye.
 *
 * This is not a ground-truth replay of a filtered session: its state has moved
 * on, so its blocks cannot be regenerated. The live run is the real test.
 *
 * The output holds real session text. Never paste it into the repo or a bead.
 */

import {existsSync, readdirSync, readFileSync} from 'fs';
import {parseArgs} from 'node:util';
import {basename} from 'path';

import {outputStyle, paint, sectionHeader, spacedList} from '../src/cli-style';
import {messageLogPath, messagesDir} from '../src/thread/archive';
import {findTranscript} from '../src/thread/facts';
import {
  isRuleLine,
  isSeparatorLine,
  isSessionFieldLine,
  QUESTIONS_HEADING,
} from '../src/thread/part-one';
import {forEachTranscriptLine} from '../src/thread/transcript-messages';
import {
  blockDifference,
  decideTrimGuard,
  nextSavedBlocks,
  normalizeText,
  type SavedBlock,
} from '../src/thread/trim-guard';

const HELP = `replay-trim-guard: replay the trim guard over past status reports.

Usage: bun run replay:trim-guard [--since <date>] [--session <id prefix>]...

  --since <date>     Replies at or after this date. Default: 2026-11-01.

  --session <prefix> Also every reply of the session whose id starts with this,
                     whatever its date. Repeatable.

  --help             Print this and do nothing else.

It is read-only and prints real session text: keep the output out of the repo.
See the file header for what "comparable" means.
`;

/** How far a tool result's clock may run past the reply's (measured skew). */
const CLOCK_SLACK_MS = 2000;
const LINE_CUT = 160;
const LINES_SHOWN = 40;

// ---------------------------------------------------------------------------
// D10: is a status run unfiltered? From the command text only.
// ---------------------------------------------------------------------------

const STATUS_CALL = /justin-sdk(?:-latest)?\s+thread\s+status\b/gu;

export type CommandClass =
  | {kind: 'filtered'}
  | {kind: 'notStatus'}
  | {kind: 'redirect'; path: string}
  | {kind: 'unfiltered'};

/** D10: what follows the last `thread status` in this command decides. */
export function classifyStatusCommand(command: string): CommandClass {
  const calls = [...command.matchAll(STATUS_CALL)];
  const last = calls.at(-1);
  if (last == null) return {kind: 'notStatus'};
  // A second run in one command is two outputs in one result.
  if (calls.length > 1) return {kind: 'filtered'};
  const rest = command.slice(last.index + last[0].length).trim();
  if (rest === '' || rest === '2>&1') return {kind: 'unfiltered'};
  // What follows a redirect cannot filter it: the file has the whole output.
  const redirect =
    /^(?:2>&1\s+)?>\s*("[^"]+"|'[^']+'|[^\s;&|]+)(?:\s+2>&1)?(?:\s*(?:;|&&)[\s\S]*)?$/u.exec(
      rest,
    );
  return redirect == null
    ? {kind: 'filtered'}
    : {
        kind: 'redirect',
        path: (redirect[1] ?? '').replace(/^["']|["']$/gu, ''),
      };
}

/** Does this Read show the file the redirect wrote, in whole? */
function readShowsRedirect(
  read: {filePath: string; limit: unknown; offset: unknown},
  redirectPath: string,
): boolean {
  return (
    read.limit == null &&
    read.offset == null &&
    basename(read.filePath) === basename(redirectPath)
  );
}

// ---------------------------------------------------------------------------
// One session's status runs
// ---------------------------------------------------------------------------

interface StatusRun {
  at: number;
  /** The whole block, from an unfiltered run. Null: only a filtered view. */
  block: string | null;
  command: string;
  /** Everything of this run the session could see. */
  output: string;
}

/** A tool result's text, whichever shape it has. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part != null && typeof part === 'object' && 'text' in part
        ? String((part as {text: unknown}).text)
        : '',
    )
    .join('\n');
}

/** The block in a run's output: first start through its last separator. */
function blockInOutput(output: string): string | null {
  const lines = output.split('\n');
  let start: number | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    if (!isRuleLine(lines[at] ?? '')) continue;
    let next = at + 1;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    if (isSessionFieldLine(lines[next] ?? '')) {
      start = at;
      break;
    }
  }
  if (start == null) return null;
  for (let at = lines.length - 1; at > start; at -= 1) {
    if (isSeparatorLine(lines[at] ?? '')) {
      return lines.slice(start, at + 1).join('\n');
    }
  }
  return null;
}

interface TranscriptRecord {
  isSidechain?: unknown;
  message?: {content?: unknown};
  timestamp?: unknown;
  type?: unknown;
}

interface ContentBlock {
  content?: unknown;
  id?: unknown;
  input?: {
    command?: unknown;
    file_path?: unknown;
    limit?: unknown;
    offset?: unknown;
  };
  name?: unknown;
  tool_use_id?: unknown;
  type?: unknown;
}

function statusRunsIn(path: string): StatusRun[] {
  const runs: StatusRun[] = [];
  const bashCalls = new Map<string, {command: string; kind: CommandClass}>();
  const readCalls = new Map<
    string,
    {filePath: string; limit: unknown; offset: unknown}
  >();
  const awaitingRead: {path: string; run: StatusRun}[] = [];
  forEachTranscriptLine(path, (line) => {
    if (line.trim() === '') return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    if (record.isSidechain === true) return;
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block == null || typeof block !== 'object') continue;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        block.input != null
      ) {
        if (block.name === 'Bash' && typeof block.input.command === 'string') {
          const kind = classifyStatusCommand(block.input.command);
          if (kind.kind !== 'notStatus') {
            bashCalls.set(block.id, {command: block.input.command, kind});
          }
        }
        if (
          block.name === 'Read' &&
          typeof block.input.file_path === 'string'
        ) {
          readCalls.set(block.id, {
            filePath: block.input.file_path,
            limit: block.input.limit,
            offset: block.input.offset,
          });
        }
        continue;
      }
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string')
        continue;
      const at =
        typeof record.timestamp === 'string'
          ? Date.parse(record.timestamp)
          : Number.NaN;
      if (!Number.isFinite(at)) continue;
      const bash = bashCalls.get(block.tool_use_id);
      if (bash != null) {
        const output = resultText(block.content);
        const run: StatusRun = {
          at,
          block: bash.kind.kind === 'unfiltered' ? blockInOutput(output) : null,
          command: bash.command,
          output,
        };
        runs.push(run);
        if (bash.kind.kind === 'redirect') {
          awaitingRead.push({path: bash.kind.path, run});
        }
        continue;
      }
      const read = readCalls.get(block.tool_use_id);
      if (read == null) continue;
      // The newest run to that path: an older one nobody read is not what this shows.
      const index = awaitingRead.findLastIndex((pending) =>
        readShowsRedirect(read, pending.path),
      );
      const pending = awaitingRead[index];
      if (pending == null) continue;
      awaitingRead.splice(index, 1);
      // The Read tool numbers its lines; the block has no such numbers.
      const readText = resultText(block.content)
        .split('\n')
        .map((text) => text.replace(/^\s*\d+[\t→]/u, ''))
        .join('\n');
      pending.run.block = blockInOutput(readText);
      pending.run.output = readText;
      // The block became visible now, not when the command ran. A reply before
      // this Read could not have pasted from it.
      pending.run.at = at;
    }
  });
  return runs.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// One reply
// ---------------------------------------------------------------------------

interface Row {
  at: string;
  class: 'matchEarlier' | 'matchLatest' | 'notComparable' | 'sentBack';
  lines: string[];
  sessionId: string;
}

function cut(line: string): string {
  const chars = [...line];
  return chars.length <= LINE_CUT
    ? line
    : `${chars.slice(0, LINE_CUT).join('')}…`;
}

function shown(label: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [`${label}: none`];
  const list = lines.slice(0, LINES_SHOWN).map((line) => `    ${cut(line)}`);
  const rest =
    lines.length > LINES_SHOWN
      ? [`    (${lines.length - LINES_SHOWN} more)`]
      : [];
  return [`${label}: ${lines.length}`, ...list, ...rest];
}

/** Do this reply's questions look complete? By eye, from these counts. */
function questionWords(blockLines: readonly string[]): string {
  const heading = blockLines.findIndex((line) =>
    line.includes(QUESTIONS_HEADING),
  );
  if (heading === -1) return 'no questions section';
  const section = blockLines.slice(heading + 1);
  const entries = section.filter((line) => /^\d+\.\s/u.test(line)).length;
  const defaults = section.filter((line) =>
    line.includes(`If you don't answer:`),
  ).length;
  const pointers = section.filter((line) =>
    /full context|in your inbox/iu.test(line),
  ).length;
  return `${entries} entries, ${defaults} with a default line, ${pointers} pointer lines`;
}

/** Everything of the reply's first block, for the not-comparable row. */
function replyBlockLines(text: string): string[] {
  const reply = normalizeText(text);
  const start = reply.starts[0] ?? 0;
  const end = reply.lines.findIndex(
    (line, index) => index > start && isSeparatorLine(line),
  );
  return reply.lines.slice(start, end === -1 ? undefined : end + 1);
}

function replayReply(args: {
  at: string;
  runs: readonly StatusRun[];
  sessionId: string;
  text: string;
  transcriptNote: string | null;
}): Row {
  const atMs = Date.parse(args.at);
  const before = args.runs.filter((run) => run.at <= atMs + CLOCK_SLACK_MS);
  let saved: SavedBlock[] = [];
  for (const run of before) {
    if (run.block == null) continue;
    const entry = {at: new Date(run.at).toISOString(), text: run.block};
    saved = nextSavedBlocks(saved, entry) ?? saved;
  }
  const decision = decideTrimGuard({
    agentId: null,
    braked: false,
    lastAssistantMessage: args.text,
    saved:
      saved.length === 0
        ? {kind: 'none'}
        : {blocks: saved, kind: 'found', malformed: 0},
    sessionId: args.sessionId,
    stopHookActive: false,
  });
  const base = {at: args.at, sessionId: args.sessionId};
  if (decision.why === 'trimGuardMatchLatest') {
    return {...base, class: 'matchLatest', lines: []};
  }
  if (decision.why === 'trimGuardMatchEarlier') {
    return {...base, class: 'matchEarlier', lines: []};
  }
  const newest = before.at(-1) ?? null;
  const newestSaved = saved.at(-1) ?? null;
  if (
    decision.why === 'trimGuardDiffers' &&
    newest?.block != null &&
    newestSaved != null
  ) {
    const difference = blockDifference(
      normalizeText(newestSaved.text).lines,
      normalizeText(args.text),
    );
    const filteredEarlier = before.filter((run) => run.block == null).length;
    return {
      ...base,
      class: 'sentBack',
      lines: [
        `newest run: ${cut(newest.command.replace(/\s+/gu, ' '))}`,
        `newest run was ${Math.round((atMs - newest.at) / 1000)} s before the reply`,
        `filtered runs earlier in this session: ${filteredEarlier}`,
        ...shown('printed lines missing', difference.missing),
        ...shown('lines the tool did not print', difference.added),
      ],
    };
  }
  // D10 class 2. Never a pass: nothing visible can say what the live guard held.
  const blockLines = replyBlockLines(args.text);
  const visible = new Set(
    before.flatMap((run) => normalizeText(run.output).lines),
  );
  const unseen = blockLines.filter((line) => !visible.has(line));
  return {
    ...base,
    class: 'notComparable',
    lines: [
      args.transcriptNote ??
        (newest == null
          ? 'no status run visible before this reply'
          : `newest run: ${cut(newest.command.replace(/\s+/gu, ' '))}`),
      `reply block: ${blockLines.length} lines`,
      `questions: ${questionWords(blockLines)}`,
      ...shown('lines in no status output of this session', unseen),
    ],
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface MessageLogLine {
  at?: unknown;
  role?: unknown;
  text?: unknown;
}

function assistantReplies(path: string): {at: string; text: string}[] {
  const seen = new Set<string>();
  const replies: {at: string; text: string}[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    let line: MessageLogLine;
    try {
      line = JSON.parse(raw) as MessageLogLine;
    } catch {
      continue;
    }
    if (
      line.role !== 'assistant' ||
      typeof line.text !== 'string' ||
      typeof line.at !== 'string'
    )
      continue;
    const key = `${line.at}\n${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    replies.push({at: line.at, text: line.text});
  }
  return replies;
}

function main(): number {
  const {values} = parseArgs({
    options: {
      help: {type: 'boolean'},
      session: {multiple: true, type: 'string'},
      since: {type: 'string'},
    },
  });
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  const since = Date.parse(values.since ?? '2026-11-01');
  if (!Number.isFinite(since)) {
    console.error(`replay-trim-guard: not a date: ${values.since}`);
    return 2;
  }
  const prefixes = values.session ?? [];
  const env = process.env;
  const dir = messagesDir(env);
  if (!existsSync(dir)) {
    console.error(`replay-trim-guard: no message logs at ${dir}`);
    return 1;
  }
  const rows: Row[] = [];
  let repliesRead = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = file.replace(/\.jsonl$/u, '');
    const named = prefixes.some((prefix) => sessionId.startsWith(prefix));
    const replies = assistantReplies(messageLogPath(sessionId, env)).filter(
      (reply) =>
        named || (Date.parse(reply.at) >= since && !Number.isNaN(since)),
    );
    repliesRead += replies.length;
    const withBlock = replies.filter(
      (reply) => normalizeText(reply.text).starts.length > 0,
    );
    if (withBlock.length === 0) continue;
    const lookup = findTranscript(sessionId, env);
    let runs: StatusRun[] = [];
    let transcriptNote: string | null = null;
    if (lookup.status === 'found') {
      try {
        runs = statusRunsIn(lookup.path);
      } catch (error) {
        transcriptNote = `could not read the transcript: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      transcriptNote =
        lookup.status === 'failed'
          ? `could not look for the transcript: ${lookup.error}`
          : 'no transcript found for this session';
    }
    for (const reply of withBlock) {
      rows.push(
        replayReply({
          at: reply.at,
          runs,
          sessionId,
          text: reply.text,
          transcriptNote,
        }),
      );
    }
  }

  const {color} = outputStyle(process.stdout, env);
  const count = (kind: Row['class']): number =>
    rows.filter((row) => row.class === kind).length;
  const latest = count('matchLatest');
  const earlier = count('matchEarlier');
  const sentBack = count('sentBack');
  const render = (row: Row): string =>
    [
      `  ${paint(`${row.sessionId.slice(0, 8)} ${row.at}`, ['bold'], color)}`,
      ...row.lines.map((line) => `    ${line}`),
    ].join('\n');
  const section = (
    title: string,
    emoji: string,
    kind: Row['class'],
  ): string[] => [
    sectionHeader(title, {color, emoji}),
    ...rows.filter((row) => row.class === kind).map(render),
  ];
  process.stdout.write(
    `${spacedList([
      ...section('Comparable: sent back', '🛑', 'sentBack'),
      ...section('Not comparable: only filtered views', '🔍', 'notComparable'),
      sectionHeader('Counts', {color, emoji: '📊'}),
      [
        `  replies read:          ${repliesRead}`,
        `  with a block:          ${rows.length}`,
        '',
        `  comparable:            ${latest + earlier + sentBack}`,
        `    passing, newest:     ${latest}`,
        `    passing, earlier:    ${earlier}`,
        `    sent back:           ${sentBack}`,
        '',
        `  not comparable:        ${count('notComparable')}`,
      ].join('\n'),
    ])}\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
