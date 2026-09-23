/**
 * ONE definition of "what did this session say" (home-base-k0b8n K1).
 *
 * Every consumer that wants a session's messages — `thread report`, `thread
 * start`, and the backfill (k0b8n.3) — reads them through
 * `extractTranscriptMessages`. Before this module there were two half-copies of
 * "substantive user message" drifting apart; the whole point of putting it here
 * is that the noise list, the definition of substantive, and the assistant-tail
 * walk-back exist exactly once.
 *
 * RULE 7 THROUGHOUT. Every field is `T | null`, and a null always arrives with a
 * named entry in `failures`. "This transcript has no assistant message" and "I
 * could not read the transcript" are different facts and are never the same
 * value. In particular an unreadable file is a THROWN error, not an all-null
 * result — a result that looks measured but is not would be the reassuring
 * direction (rule 7.1).
 *
 * ONE FORWARD STREAMING PASS. The file is read in 1 MiB chunks and split on
 * newlines; it is never read whole into a string and never `JSON.parse`d as a
 * document. Real transcripts reach 44 MB (measured 2026-09-19 on this machine),
 * which is a 44 MB string plus a 44 MB parse tree if you do it the easy way. The
 * reader is SYNCHRONOUS on purpose: `collectThreadFacts`, `runStopCheck` and the
 * report path are all synchronous, and making this async would ripple an `await`
 * through every one of them for no measured gain.
 */

import {closeSync, openSync, readSync, statSync} from 'fs';
import {basename, dirname} from 'path';

/** Read this many bytes per `readSync`. */
const CHUNK_BYTES = 1024 * 1024;

export interface TranscriptMessages {
  /**
   * The working directory of the LAST record that carries one.
   *
   * The last, not the first: a session that moves into a worktree keeps
   * reporting the new directory, and where the work ENDED is what a human wants
   * to `cd` to. `firstCwd` is kept alongside because the two disagree often
   * enough to matter for `resumeCommand` — see `buildResumeCommand`.
   */
  cwd: string | null;
  /** `cli`, `remote`, … as the first record that carries one records it. */
  entrypoint: string | null;
  /** One line per field that could not be measured. Never silently empty. */
  failures: string[];
  /** The working directory of the FIRST record that carries one. */
  firstCwd: string | null;
  /** The first record's timestamp — when the session began. */
  firstTimestamp: string | null;
  /** Justin's first real message, verbatim and UNCAPPED. */
  firstUserMessage: string | null;
  firstUserMessageAt: string | null;
  /** The branch of the last record that carries one. */
  gitBranch: string | null;
  /** The last assistant text, verbatim and UNCAPPED (K3). */
  lastAssistantMessage: string | null;
  lastAssistantMessageAt: string | null;
  /**
   * The LAST record's timestamp — when the session was last active.
   *
   * NEVER the file's mtime: resuming a session in cmux touches the file without
   * adding a record, so mtime reports activity that did not happen.
   */
  lastTimestamp: string | null;
  /** Justin's last real message, verbatim and UNCAPPED. */
  lastUserMessage: string | null;
  lastUserMessageAt: string | null;
  /** The model on the last assistant record that names one. */
  model: string | null;
  /** `cd '<dir>' && claude --resume <id>`, or null when it cannot be built. */
  resumeCommand: string | null;
  /** Which directory `resumeCommand` cds to, and why. */
  resumeCwd: string | null;
  resumeCwdSource: 'firstCwd' | 'lastCwd' | null;
  /** The session id the transcript records, not the one in its filename. */
  sessionId: string | null;
  transcriptPath: string;
}

interface TranscriptRecord {
  cwd?: unknown;
  entrypoint?: unknown;
  gitBranch?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: {content?: unknown; model?: unknown; role?: unknown};
  sessionId?: unknown;
  timestamp?: unknown;
  toolUseResult?: unknown;
  type?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// Harness noise (K2)
// ---------------------------------------------------------------------------

/**
 * Blocks Claude Code injects INTO a user turn, removed WHOLE — tags and
 * contents. None of it is something Justin typed.
 *
 * MEASURED 2026-09-19 across 43 transcripts from 8 repos (home-base,
 * audio-journal-1, health-logger-rn, browser-automation-central, nature-sounds,
 * life, prompts, version-manager; 70,717 records). Every entry below was seen in
 * that corpus except `user-prompt-submit-hook`, which predates this list and is
 * kept.
 *
 * `[^>]*` after each tag name is load-bearing: `cross-session-message` and
 * `agent-message` carry attributes (`from="uds:/tmp/cc-socks/43142.sock"`), and
 * a pattern anchored on `<tag>` matches neither.
 *
 * `bash-input` is here deliberately even though Justin's fingers typed it. The
 * harness files those records behind a `<local-command-caveat>` that reads "DO
 * NOT respond to these messages or otherwise consider them in your response" —
 * the harness's own declaration that they are not messages to Claude. Reporting
 * `bun run signal-backup:doctor` back as "what you asked me to do" would be a
 * quote of something he never said to Claude.
 */
const NOISE_BLOCKS: RegExp[] = [
  /<system-reminder[^>]*>[\s\S]*?<\/system-reminder\s*>/g,
  /<task-notification[^>]*>[\s\S]*?<\/task-notification\s*>/g,
  /<bash-notification[^>]*>[\s\S]*?<\/bash-notification\s*>/g,
  /<local-command-stdout[^>]*>[\s\S]*?<\/local-command-stdout\s*>/g,
  /<local-command-caveat[^>]*>[\s\S]*?<\/local-command-caveat\s*>/g,
  /<bash-input[^>]*>[\s\S]*?<\/bash-input\s*>/g,
  /<bash-stdout[^>]*>[\s\S]*?<\/bash-stdout\s*>/g,
  /<bash-stderr[^>]*>[\s\S]*?<\/bash-stderr\s*>/g,
  /<cross-session-message[^>]*>[\s\S]*?<\/cross-session-message\s*>/g,
  /<agent-message[^>]*>[\s\S]*?<\/agent-message\s*>/g,
  /<ide_opened_file[^>]*>[\s\S]*?<\/ide_opened_file\s*>/g,
  /<ide_selection[^>]*>[\s\S]*?<\/ide_selection\s*>/g,
  /<user-prompt-submit-hook[^>]*>[\s\S]*?<\/user-prompt-submit-hook\s*>/g,
  /<command-message[^>]*>[\s\S]*?<\/command-message\s*>/g,
  /<command-name[^>]*>[\s\S]*?<\/command-name\s*>/g,
  /<command-args[^>]*>[\s\S]*?<\/command-args\s*>/g,
];

/**
 * An UNCLOSED injected block running to the end of the text. A system-reminder
 * is sometimes the last thing in a record with its closing tag in the next one;
 * without this the whole reminder reads as Justin's message.
 */
const TRAILING_OPEN_BLOCK =
  /<(system-reminder|task-notification|bash-notification|local-command-caveat)[^>]*>[\s\S]*$/;

/**
 * Harness text that sits OUTSIDE any tag (K2).
 *
 * Each one is a fixed string the harness writes, not a shape Justin's prose
 * could wander into — that is the bar for adding one, because over-stripping
 * silently eats his words and nothing downstream can tell. Measured counts from
 * the same 8-repo corpus are in the comments.
 *
 * `[Image #1]` is deliberately NOT here: it marks where in his own sentence he
 * attached something, so it is part of the message's structure. The two
 * `[Image: …]` forms below are pure harness annotation and often the ENTIRE
 * record.
 */
const NOISE_PREAMBLES: RegExp[] = [
  /\[Request interrupted by user[^\]\n]*\]/g, // 64 + 36
  /\[Image: (?:original|source:)[^\]\n]*\]/g, // ~100
  /\[SYSTEM NOTIFICATION - NOT USER INPUT\][^\n]*/g, // attachment records
  /\[Cross-session [^\]\n]*\]/g,
  /\[Subagent hand-back\]/g,
  /^Another Claude session sent a message:[ \t]*$/gm,
];

/** `<pasted_content id="b473">` … `</pasted_content id="b473">` (note the attr). */
const PASTED_CONTENT_TAGS = /<\/?pasted_content\b[^>]*>/g;

/** `<command-name>/x</command-name>` … `<command-args>y</command-args>`. */
const COMMAND_NAME = /<command-name[^>]*>([\s\S]*?)<\/command-name\s*>/;
const COMMAND_ARGS = /<command-args[^>]*>([\s\S]*?)<\/command-args\s*>/;

/**
 * Render a slash-command envelope as Justin would have typed it, or '' (K2).
 *
 * `/conductor <a whole dispatch brief>` is the most important first message
 * there is, and the envelope is the only place it exists — so the ARGS are his
 * words and the wrapper is not. A command with EMPTY args renders as nothing,
 * which is what makes K2's other sentence true: "a session whose first record is
 * a bare /command shows the next real message". `/copy` on its own tells a
 * reader nothing about the session.
 */
function renderSlashCommand(text: string): string {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim() ?? '';
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  if (name === '' || args === '') return '';
  return `${name} ${args}`;
}

/**
 * Strip everything Claude Code injected, leaving only what Justin wrote.
 *
 * Returns '' when nothing of his remains — which is how the callers tell a
 * message from a notification, so '' is a MEANINGFUL value here, not a failure.
 */
export function stripHarnessNoise(text: string): string {
  // Before the wrapper tags are removed, because it reads them.
  const command = renderSlashCommand(text);
  let out = text;
  for (const pattern of NOISE_BLOCKS) out = out.replace(pattern, '');
  out = out.replace(TRAILING_OPEN_BLOCK, '');
  // Tags out, inner text KEPT: a pasted block is Justin's words (Justin, via
  // the k0b8n brief). This is the one tag pair that is unwrapped rather than
  // deleted.
  out = out.replace(PASTED_CONTENT_TAGS, '');
  for (const pattern of NOISE_PREAMBLES) out = out.replace(pattern, '');
  out = out.trim();
  if (command === '') return out;
  return out === '' ? command : `${command}\n${out}`;
}

// ---------------------------------------------------------------------------
// What counts as a message
// ---------------------------------------------------------------------------

/**
 * The human-authored text of one user record, or null when it has none (K2).
 *
 * `tool_result` blocks are tool output wearing a user record's clothes and are
 * the bulk of the `type: "user"` records in any real transcript. A record
 * carrying `toolUseResult`, or any `tool_result` block, is skipped outright.
 * Other non-text blocks (images, most often) are IGNORED rather than
 * disqualifying: Justin routinely pastes a screenshot with a sentence attached,
 * and the old rule threw that sentence away.
 *
 * `isMeta` marks Claude Code's own injections — the session preamble, the skill
 * text a slash command expands to, cross-session envelopes.
 */
export function substantiveUserText(record: TranscriptRecord): string | null {
  if (record.type !== 'user') return null;
  if (record.isMeta === true) return null;
  if (record.isSidechain === true) return null;
  if (record.toolUseResult != null) return null;
  const content = record.message?.content;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      const typed = block as {text?: unknown; type?: unknown};
      if (typed.type === 'tool_result') return null;
      if (typed.type !== 'text') continue;
      if (typeof typed.text === 'string') parts.push(typed.text);
    }
    if (parts.length === 0) return null;
    raw = parts.join('\n');
  } else {
    return null;
  }
  const stripped = stripHarnessNoise(raw);
  return stripped === '' ? null : stripped;
}

/**
 * The text of one assistant record, or null when it carries none (K3).
 *
 * `thinking` and `tool_use` blocks are dropped; the surviving text blocks are
 * joined with a blank line. A record whose only block is a `tool_use` — the tail
 * of a session that died mid-tool, and of every `advisor` exchange — returns
 * null, which is what makes the caller walk back to the previous record instead
 * of storing an empty "last response".
 */
export function assistantText(record: TranscriptRecord): string | null {
  if (record.type !== 'assistant') return null;
  if (record.isSidechain === true) return null;
  const content = record.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue;
    const typed = block as {text?: unknown; type?: unknown};
    if (typed.type !== 'text') continue;
    if (typeof typed.text !== 'string') continue;
    const trimmed = typed.text.trim();
    if (trimmed !== '') parts.push(trimmed);
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// The resume command (K4)
// ---------------------------------------------------------------------------

/**
 * Claude Code's project-directory slug: every non-alphanumeric byte becomes `-`.
 *
 * MEASURED 2026-09-19 over all 1,896 transcripts on this machine that carry a
 * cwd. `/`, `.`, `_` and space all collapse to `-`, which makes the slug
 * LOSSY AND NOT INVERTIBLE: `/Users/jhaa/Dev/beads_rust` and a hypothetical
 * `beads-rust` produce the same directory name. That is why the project
 * directory is never used as a SOURCE for the cwd — only as the target a
 * candidate cwd is checked against.
 */
export function projectDirSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** POSIX single-quoting, so a directory with a quote or a space still works. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ResumeCommand {
  command: string | null;
  cwd: string | null;
  /** Null when no candidate directory could be confirmed. */
  failure: string | null;
  source: 'firstCwd' | 'lastCwd' | null;
}

/**
 * `cd '<dir>' && claude --resume <id>` (K4).
 *
 * WHICH directory, and why it is not simply the last cwd. Claude Code files a
 * transcript under a slug of a working directory, and `claude --continue` is
 * documented as "the most recent conversation IN THE CURRENT DIRECTORY" — the
 * session store is keyed by directory. So the command has to land in the
 * directory whose slug IS the one holding this transcript, or the picker looks
 * in the wrong bucket.
 *
 * MEASURED 2026-09-19, 1,896 transcripts: the last record's cwd slugs to the
 * transcript's own directory 1,824 times (96.2%). Of the 72 that do not, the
 * FIRST record's cwd rescues 56 — those are sessions that started in a repo and
 * later `cd`'d into a worktree or a subpackage WITHOUT the transcript following.
 * (The file does sometimes follow; this session's own did. Both happen.) The
 * remaining 16 match neither and get a named failure rather than a command that
 * would quietly fail to find anything.
 *
 * ⚠️ NOT VERIFIED: that `claude --resume <id>` (as opposed to `--continue`)
 * restricts itself to the current directory's sessions. Running it would start a
 * real session, so this is reasoned from the on-disk layout and `--continue`'s
 * documented wording. The rule above is the SAFE side of that uncertainty — a
 * command that cds to the transcript's own bucket is right either way.
 */
export function buildResumeCommand(input: {
  firstCwd: string | null;
  lastCwd: string | null;
  sessionId: string | null;
  transcriptPath: string;
}): ResumeCommand {
  const {firstCwd, lastCwd, sessionId, transcriptPath} = input;
  if (sessionId == null) {
    return {
      command: null,
      cwd: null,
      failure: 'resumeCommand: no session id in the transcript',
      source: null,
    };
  }
  const projectDir = basename(dirname(transcriptPath));
  let cwd: string | null = null;
  let source: 'firstCwd' | 'lastCwd' | null = null;
  if (lastCwd != null && projectDirSlug(lastCwd) === projectDir) {
    cwd = lastCwd;
    source = 'lastCwd';
  } else if (firstCwd != null && projectDirSlug(firstCwd) === projectDir) {
    cwd = firstCwd;
    source = 'firstCwd';
  }
  if (cwd == null) {
    const fallback = lastCwd ?? firstCwd;
    if (fallback == null) {
      return {
        command: null,
        cwd: null,
        failure: `resumeCommand: no record in ${transcriptPath} carries a cwd`,
        source: null,
      };
    }
    return {
      command: `cd ${shellQuote(fallback)} && claude --resume ${sessionId}`,
      cwd: fallback,
      failure: `resumeCommand: neither cwd slugs to the transcript's project directory ${projectDir} — the resume may not find this session`,
      source: lastCwd != null ? 'lastCwd' : 'firstCwd',
    };
  }
  return {
    command: `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`,
    cwd,
    failure: null,
    source,
  };
}

// ---------------------------------------------------------------------------
// The streaming read
// ---------------------------------------------------------------------------

/**
 * Call `onLine` once per newline-terminated line, streaming.
 *
 * Leftover BYTES are carried across chunk boundaries rather than characters:
 * 0x0A never appears inside a UTF-8 multi-byte sequence, but decoding a chunk
 * that ends mid-sequence would corrupt it. Throws on an unreadable file — a
 * caller must not be able to mistake "could not open" for "no records".
 */
export function forEachTranscriptLine(
  path: string,
  onLine: (line: string, index: number) => void,
): void {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let remainder = Buffer.alloc(0);
    let index = 0;
    for (;;) {
      const bytes = readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (bytes === 0) break;
      const data =
        remainder.length === 0
          ? chunk.subarray(0, bytes)
          : Buffer.concat([remainder, chunk.subarray(0, bytes)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline === -1) break;
        onLine(data.toString('utf8', start, newline), index);
        index += 1;
        start = newline + 1;
      }
      // A COPY: `chunk` is reused by the next read, so a subarray of it would
      // be overwritten under us.
      remainder = Buffer.from(data.subarray(start));
    }
    if (remainder.length > 0) onLine(remainder.toString('utf8'), index);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

/**
 * Everything a thread needs to know about one session's transcript (K1).
 *
 * THROWS when the file cannot be opened or stat'd. Everything else it cannot
 * measure is null-plus-a-named-failure.
 */
export function extractTranscriptMessages(
  transcriptPath: string,
): TranscriptMessages {
  // Fails loudly here rather than producing an all-null "measurement".
  statSync(transcriptPath);

  const failures: string[] = [];
  const result: TranscriptMessages = {
    cwd: null,
    entrypoint: null,
    failures,
    firstCwd: null,
    firstTimestamp: null,
    firstUserMessage: null,
    firstUserMessageAt: null,
    gitBranch: null,
    lastAssistantMessage: null,
    lastAssistantMessageAt: null,
    lastTimestamp: null,
    lastUserMessage: null,
    lastUserMessageAt: null,
    model: null,
    resumeCommand: null,
    resumeCwd: null,
    resumeCwdSource: null,
    sessionId: null,
    transcriptPath,
  };

  let malformed = 0;
  let lastMalformedIndex = -1;
  let lastIndex = -1;

  forEachTranscriptLine(transcriptPath, (line, index) => {
    lastIndex = index;
    if (line.trim() === '') return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      malformed += 1;
      lastMalformedIndex = index;
      return;
    }

    // Session-level facts come from ANY record type, sidechains excluded: a
    // subagent's records carry the parent's session id but its own nothing else.
    if (record.isSidechain === true) return;

    const timestamp = asString(record.timestamp);
    if (timestamp != null) {
      result.firstTimestamp ??= timestamp;
      result.lastTimestamp = timestamp;
    }
    const cwd = asString(record.cwd);
    if (cwd != null) {
      result.firstCwd ??= cwd;
      result.cwd = cwd;
    }
    const branch = asString(record.gitBranch);
    if (branch != null) result.gitBranch = branch;
    result.sessionId ??= asString(record.sessionId);
    result.entrypoint ??= asString(record.entrypoint);

    if (record.type === 'assistant') {
      const model = asString(record.message?.model);
      if (model != null) result.model = model;
      const text = assistantText(record);
      if (text != null) {
        result.lastAssistantMessage = text;
        // Read from the SAME record in the same pass, so the text and its
        // timestamp can never describe different records.
        result.lastAssistantMessageAt = timestamp;
      }
      return;
    }

    if (record.type === 'user') {
      const text = substantiveUserText(record);
      if (text == null) return;
      if (result.firstUserMessage == null) {
        result.firstUserMessage = text;
        result.firstUserMessageAt = timestamp;
      }
      result.lastUserMessage = text;
      result.lastUserMessageAt = timestamp;
    }
  });

  // A partially-written LAST line is normal on a live transcript and is not a
  // measurement failure; a bad line anywhere else is one.
  const trailingPartial = lastMalformedIndex === lastIndex && malformed > 0;
  const realMalformed = trailingPartial ? malformed - 1 : malformed;
  if (realMalformed > 0) {
    failures.push(
      `transcript: ${realMalformed} line(s) in ${transcriptPath} were not valid JSON and were skipped`,
    );
  }

  if (result.firstUserMessage == null) {
    failures.push(
      `firstUserMessage: no human-authored user record found in ${transcriptPath}`,
    );
  }
  if (result.lastUserMessage == null) {
    failures.push(
      `lastUserMessage: no human-authored user record found in ${transcriptPath}`,
    );
  }
  if (result.lastAssistantMessage == null) {
    failures.push(
      `lastAssistantMessage: no assistant record with text found in ${transcriptPath}`,
    );
  }

  const resume = buildResumeCommand({
    firstCwd: result.firstCwd,
    lastCwd: result.cwd,
    sessionId: result.sessionId,
    transcriptPath,
  });
  result.resumeCommand = resume.command;
  result.resumeCwd = resume.cwd;
  result.resumeCwdSource = resume.source;
  if (resume.failure != null) failures.push(resume.failure);

  return result;
}

// ---------------------------------------------------------------------------
// Every turn (K10 e)
// ---------------------------------------------------------------------------

/** One message of a turn: its text (same rules as K2/K3), when, and where. */
export interface TurnMessage {
  at: string | null;
  cwd: string | null;
  text: string;
}

/**
 * One turn: a substantive user message and that turn's yield (K10 e).
 *
 * `user` is null for exactly one case — Claude text that comes BEFORE the first
 * substantive user message (a session opened by a bare `/command`, whose
 * envelope K2 renders as nothing). Dropping that text would make the most
 * important reply of such a session unsearchable, so it becomes a leading turn
 * with no user half rather than vanishing.
 *
 * `assistant` is null when the turn has no text-bearing assistant record at
 * all: a turn that died mid-tool, or the live tail of a session still thinking.
 */
export interface TranscriptTurn {
  assistant: TurnMessage | null;
  user: TurnMessage | null;
}

export interface TranscriptTurns {
  entrypoint: string | null;
  /** One line per thing that could not be read. Never silently empty. */
  failures: string[];
  /**
   * The first and last record's cwd, by exactly `extractTranscriptMessages`'s
   * rule (any non-sidechain record that carries one), so `buildResumeCommand`
   * fed these gives the command the backfill computes (home-base-k0b8n.15).
   */
  firstCwd: string | null;
  lastCwd: string | null;
  /** The LAST record's timestamp — never the file mtime (see K1). */
  lastTimestamp: string | null;
  sessionId: string | null;
  transcriptPath: string;
  turns: TranscriptTurn[];
}

/**
 * Every turn of a session, in file order: each substantive user message and
 * its YIELD (K10 e).
 *
 * THE YIELD is the LAST text-bearing assistant record before the next
 * substantive user message, or the end of the file. Everything Claude said in
 * between — "let me check X", the narration between tool calls — is not the
 * message Justin reads when the turn ends, and is not what the Stop hook's
 * `last_assistant_message` carries either, so a backfilled log and a live one
 * converge on the same text. A tool_use-only tail is skipped by construction:
 * `assistantText` returns null for it, so the previous text-bearing record
 * stays the yield (K3).
 *
 * SAME DEFINITIONS AS `extractTranscriptMessages` — `substantiveUserText` and
 * `assistantText`, one streaming pass, sidechains excluded — so "substantive"
 * and "noise" exist exactly once (K1). THROWS on an unreadable file, like the
 * extractor: "could not open" must not look like "no turns".
 */
export function extractTranscriptTurns(
  transcriptPath: string,
): TranscriptTurns {
  statSync(transcriptPath);

  const result: TranscriptTurns = {
    entrypoint: null,
    failures: [],
    firstCwd: null,
    lastCwd: null,
    lastTimestamp: null,
    sessionId: null,
    transcriptPath,
    turns: [],
  };
  let current: TranscriptTurn | null = null;
  let malformed = 0;
  let lastMalformedIndex = -1;
  let lastIndex = -1;

  forEachTranscriptLine(transcriptPath, (line, index) => {
    lastIndex = index;
    if (line.trim() === '') return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      malformed += 1;
      lastMalformedIndex = index;
      return;
    }
    if (record.isSidechain === true) return;
    const timestamp = asString(record.timestamp);
    if (timestamp != null) result.lastTimestamp = timestamp;
    result.sessionId ??= asString(record.sessionId);
    result.entrypoint ??= asString(record.entrypoint);
    const cwd = asString(record.cwd);
    if (cwd != null) {
      result.firstCwd ??= cwd;
      result.lastCwd = cwd;
    }

    if (record.type === 'user') {
      const text = substantiveUserText(record);
      if (text == null) return;
      current = {assistant: null, user: {at: timestamp, cwd, text}};
      result.turns.push(current);
      return;
    }
    if (record.type === 'assistant') {
      const text = assistantText(record);
      if (text == null) return;
      if (current == null) {
        current = {assistant: null, user: null};
        result.turns.push(current);
      }
      current.assistant = {at: timestamp, cwd, text};
    }
  });

  const trailingPartial = lastMalformedIndex === lastIndex && malformed > 0;
  const realMalformed = trailingPartial ? malformed - 1 : malformed;
  if (realMalformed > 0) {
    result.failures.push(
      `transcript: ${realMalformed} line(s) in ${transcriptPath} were not valid JSON and were skipped`,
    );
  }
  return result;
}
