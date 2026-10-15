/**
 * Which commits THIS session made (status report v4; home-base-vzwbj.4.4 design
 * item 4, folding in home-base-vzwbj.4.7).
 *
 * THE PROBLEM. Epic D2 counted "commits on the checkout's HEAD since the first
 * prompt" (`git log --since`). In a checkout several sessions share — home-base
 * main, where Justin runs many sessions a day — that counts every session's
 * commits as this one's, so a question-only session there showed "N commits —
 * no request filed" and ⚠️ open work.
 *
 * THE FIX: attribute commits from the session's own transcript (the main file
 * plus every subagent file beside it — a player's commits are the session's
 * work too). Two kinds of evidence, unioned by full SHA:
 *
 *  1. CONFIRMATION LINES. A Bash tool result carrying git's own commit line,
 *     `[<branch> <short sha>] <subject>` or `[<branch> (root-commit) <sha>] …`
 *     (also `[detached HEAD <sha>] …`). Each short SHA is resolved in the
 *     measured checkout with `git rev-parse --verify <sha>^{commit}`; one that
 *     does not resolve is REPORTED (`unresolved`), never counted.
 *  2. COMMIT WINDOWS (a player decision of home-base-vzwbj.4.4, recorded in its
 *     notes). Measured 2026-10-11 on this repo's real transcripts: every commit
 *     the conductor and its six players made used `git commit -q`, which prints
 *     NO confirmation line, so evidence 1 alone counted 0 for a session that
 *     made a dozen commits — and "0 commits, no request, clean tree" derives 💬
 *     answered, the reassuring direction critical rule 7 forbids. So every Bash
 *     call whose command runs `git commit` also contributes a time window, from
 *     its tool_use record's timestamp to its tool_result record's, and the
 *     commits whose committer time falls inside a window (one second of slack
 *     either side, for git's whole-second times) are this session's. Another
 *     session's commit landing inside the same few seconds in the same repo
 *     would be miscounted; that is noise, not false reassurance.
 *
 * A transcript that cannot be found or read is not "0 commits": the caller
 * falls back to the `--since` count and LABELS it (session-model.ts), or
 * reports the failure when git cannot answer either.
 */

import {readdirSync, readFileSync} from 'fs';
import {basename, dirname, join} from 'path';

/** A git run, as session-model.ts's runner reports it. */
export type GitRun =
  | {kind: 'error'; message: string}
  | {kind: 'exit'; status: number; stderr: string}
  | {kind: 'ok'; stdout: string};

/**
 * A git runner bound to one checkout. Sync or async: session-model.ts runs git
 * asynchronously so the inbox can load sessions concurrently (home-base-
 * vzwbj.4.9 F7); the tests' scripted runners are plain functions.
 */
export type GitRunner = (args: string[]) => GitRun | Promise<GitRun>;

/** A commit line git printed: `[main 1a2b3c4] subject`. */
export interface CommitConfirmation {
  file: string;
  shortSha: string;
  subject: string;
}

/** A Bash call that ran `git commit`, with when it started and finished. */
export interface CommitCall {
  command: string;
  /** The tool_result record's time; null when there is no result yet. */
  endedAt: string | null;
  file: string;
  /** The tool_use record's time; null when the record carries none. */
  startedAt: string | null;
}

export interface CommitEvidence {
  calls: CommitCall[];
  confirmations: CommitConfirmation[];
  /** Every transcript file read, the main one first. */
  files: string[];
  /** Lines that were not JSON (a line being written is the usual cause). */
  unparsedLines: number;
}

/** How many commits this session made, and where the number came from. */
export type SessionCommits =
  | {
      count: number;
      /** Full SHAs attributed to the session (the order means nothing). */
      shas: string[];
      source: 'transcript';
      /**
       * R3 (home-base-vzwbj.4.9): `git commit` commands whose window caught NO
       * commit in this checkout — `git -C ../other commit`, a commit that
       * failed, or one in another repo. Each is evidence of work this count
       * does not hold, so the count is PARTIAL, never a measured total.
       */
      unmatchedCalls: string[];
      /** Short SHAs from confirmation lines that do not resolve here (also partial). */
      unresolved: string[];
    }
  | {
      count: number;
      /** Why the transcript could not be used. */
      fallbackBecause: string;
      source: 'sinceFirstPrompt';
    };

// ---------------------------------------------------------------------------
// Recognising a commit
// ---------------------------------------------------------------------------

/**
 * Quoted text replaced by empty quotes, so `echo "git commit"` is not one.
 *
 * ONE left-to-right pass, as a shell reads it (home-base-vzwbj.4.9 R3): the
 * two-regex version stripped every single-quoted span FIRST, so the apostrophe
 * inside `echo "can't" && git commit -qm "won't"` paired with the one in
 * "won't" and swallowed the commit. Here a quote opens only outside another
 * quote; `\` escapes the next character outside quotes and inside double
 * quotes (not inside single quotes, as in sh); `$'…'` takes `\` escapes too.
 * An unterminated quote runs to the end (the shell would refuse the line).
 */
export function stripQuotedText(command: string): string {
  let out = '';
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? '';
    if (char === '\\') {
      out += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    const ansi = char === '$' && command[index + 1] === "'";
    if (char === "'" || char === '"' || ansi) {
      const quote = ansi ? "'" : char;
      const escapes = quote === '"' || ansi;
      let end = index + (ansi ? 2 : 1);
      while (end < command.length && command[end] !== quote) {
        end += escapes && command[end] === '\\' ? 2 : 1;
      }
      out += `${quote}${quote}`;
      index = end + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Does `command` run `git commit`? Conservative: quoted text is ignored, `git`
 * may carry global options (`-C <dir>`, `-c k=v`, `--no-pager`), and a commit
 * segment asking for `--help`, `-h` or `--dry-run` does not count.
 */
export function isGitCommitCommand(command: string): boolean {
  const plain = stripQuotedText(command);
  const pattern =
    /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit(?=$|[\s;&|)])/g;
  for (const match of plain.matchAll(pattern)) {
    const rest = plain.slice((match.index ?? 0) + match[0].length);
    const segment = rest.split(/;|&&|\|\||\|/)[0] ?? '';
    if (!/(?:^|\s)(?:--help|-h|--dry-run)(?=$|\s)/.test(segment)) return true;
  }
  return false;
}

/** git's commit confirmation, one per line of a tool result. */
const CONFIRMATION_LINE =
  /^\[(?:detached HEAD|[^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/gm;

/** The same shape inside a raw JSONL line, before any parse (a cheap filter). */
const CONFIRMATION_IN_RAW =
  /\[(?:detached HEAD|[^\s\]"\\]+)(?: \(root-commit\))? [0-9a-f]{7,40}\] /;

export function confirmationsIn(
  text: string,
  file: string,
): CommitConfirmation[] {
  return [...text.matchAll(CONFIRMATION_LINE)].map((match) => ({
    file,
    shortSha: match[1] ?? '',
    subject: (match[2] ?? '').trim(),
  }));
}

// ---------------------------------------------------------------------------
// Reading the transcript
// ---------------------------------------------------------------------------

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      part != null &&
      typeof part === 'object' &&
      typeof (part as {text?: unknown}).text === 'string'
        ? (part as {text: string}).text
        : '',
    )
    .join('\n');
}

function stringField(value: unknown, key: string): string | null {
  if (value == null || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : null;
}

function contentBlocks(record: unknown): unknown[] {
  if (record == null || typeof record !== 'object') return [];
  const message = (record as {message?: unknown}).message;
  if (message == null || typeof message !== 'object') return [];
  const content = (message as {content?: unknown}).content;
  return Array.isArray(content) ? content : [];
}

/**
 * The commit evidence in one transcript file's text. Pure: the table tests
 * drive it with literal JSONL.
 *
 * Only Bash calls count (a Read of a file that happens to contain a commit
 * line is not a commit). Lines are filtered as raw text before any parse, so
 * a long transcript costs a scan, not a parse per line.
 */
export function commitEvidenceFromText(
  text: string,
  file: string,
): Omit<CommitEvidence, 'files'> {
  const bashCalls = new Map<
    string,
    {command: string; isCommit: boolean; startedAt: string | null}
  >();
  const confirmations: CommitConfirmation[] = [];
  const results = new Map<string, string | null>();
  let unparsedLines = 0;
  for (const line of text.split('\n')) {
    const isUse = line.includes('"tool_use"') && line.includes('"Bash"');
    const isResult = line.includes('"tool_result"');
    if (!isUse && !isResult) continue;
    let record: unknown;
    if (isResult && !isUse) {
      // Parse a result only when it answers a Bash call that commits, or its
      // raw text carries a confirmation line.
      const ids = [...line.matchAll(/"tool_use_id":"([^"]+)"/g)].map(
        (match) => match[1] ?? '',
      );
      const wanted = ids.some(
        (id) =>
          bashCalls.get(id)?.isCommit === true ||
          (bashCalls.has(id) && CONFIRMATION_IN_RAW.test(line)),
      );
      if (!wanted) continue;
    }
    try {
      record = JSON.parse(line);
    } catch {
      unparsedLines += 1;
      continue;
    }
    const at = stringField(record, 'timestamp');
    for (const block of contentBlocks(record)) {
      if (block == null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === 'tool_use' && entry.name === 'Bash') {
        const id = stringField(entry, 'id');
        const command = stringField(entry.input, 'command');
        if (id == null || command == null) continue;
        // home-base-j8q3e.1.4 (F1): Claude Code also writes an
        // `api-request-blob` record that repeats an assistant message, its
        // tool_use blocks included, with NO timestamp (measured 2026-10-15:
        // 19 of 21 undated commit calls in session f7cb268b). The same id seen
        // twice keeps the first time either record carries; a call that no
        // record dates stays undated, so the count is still refused (rule 7).
        bashCalls.set(id, {
          command,
          isCommit: isGitCommitCommand(command),
          startedAt: bashCalls.get(id)?.startedAt ?? at,
        });
      } else if (entry.type === 'tool_result') {
        const id = stringField(entry, 'tool_use_id');
        if (id == null || !bashCalls.has(id)) continue;
        results.set(id, at);
        confirmations.push(
          ...confirmationsIn(textOfResult(entry.content), file),
        );
      }
    }
  }
  const calls: CommitCall[] = [];
  for (const [id, call] of bashCalls) {
    if (!call.isCommit) continue;
    calls.push({
      command: call.command,
      endedAt: results.get(id) ?? null,
      file,
      startedAt: call.startedAt,
    });
  }
  return {calls, confirmations, unparsedLines};
}

/** The subagent transcripts beside a session transcript (`<id>/subagents/agent-*.jsonl`). */
export function subagentTranscripts(
  transcriptPath: string,
): {files: string[]; ok: true} | {ok: false; reason: string} {
  const dir = join(
    dirname(transcriptPath),
    basename(transcriptPath, '.jsonl'),
    'subagents',
  );
  try {
    return {
      files: readdirSync(dir)
        .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(dir, name)),
      ok: true,
    };
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : null;
    if (code === 'ENOENT') return {files: [], ok: true};
    return {
      ok: false,
      reason: `could not list the subagent transcripts in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Every file's evidence, or why one of them could not be read. */
export function readCommitEvidence(
  transcriptPath: string,
): {evidence: CommitEvidence; ok: true} | {ok: false; reason: string} {
  const subagents = subagentTranscripts(transcriptPath);
  if (!subagents.ok) return subagents;
  const files = [transcriptPath, ...subagents.files];
  const evidence: CommitEvidence = {
    calls: [],
    confirmations: [],
    files,
    unparsedLines: 0,
  };
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const one = commitEvidenceFromText(text, file);
    evidence.calls.push(...one.calls);
    evidence.confirmations.push(...one.confirmations);
    evidence.unparsedLines += one.unparsedLines;
  }
  return {evidence, ok: true};
}

// ---------------------------------------------------------------------------
// Resolving against the checkout
// ---------------------------------------------------------------------------

/** One second either side: git stores whole seconds. */
export const COMMIT_WINDOW_SLACK_MS = 1000;

/**
 * A commit call with no result yet (the session was killed mid-commit, or is
 * still running it) is given this long: a pre-commit hook can take minutes,
 * and an open-ended window would claim every later commit in the repo.
 */
export const OPEN_COMMIT_WINDOW_MS = 10 * 60_000;

function describeGitFailure(args: string[], run: GitRun): string {
  if (run.kind === 'error') {
    return `git ${args.join(' ')} could not run: ${run.message}`;
  }
  if (run.kind === 'exit') {
    const first = run.stderr.split('\n')[0] ?? '';
    return `git ${args.join(' ')} exited ${run.status}${first === '' ? '' : `: ${first}`}`;
  }
  return `git ${args.join(' ')} succeeded`;
}

/**
 * The session's commits from its transcript evidence, resolved with `git`
 * (a runner bound to the measured checkout). `{ok: false}` when git cannot
 * answer, or a commit call carries no timestamp to window it by — an unknown,
 * never a 0.
 */
export async function attributeCommits(
  evidence: Pick<CommitEvidence, 'calls' | 'confirmations'>,
  git: GitRunner,
): Promise<
  | {ok: false; reason: string}
  | {ok: true; value: Extract<SessionCommits, {source: 'transcript'}>}
> {
  const shas: string[] = [];
  const unresolved: string[] = [];
  const shorts = [
    ...new Set(evidence.confirmations.map((entry) => entry.shortSha)),
  ];
  // F7: every look-up runs at once; their answers are judged in order below,
  // so the first failure in transcript order still decides, as before.
  const lookups = await Promise.all(
    shorts.map(async (shortSha) => {
      const args = ['rev-parse', '--verify', '--quiet', `${shortSha}^{commit}`];
      return {args, run: await git(args), shortSha};
    }),
  );
  for (const {args, run, shortSha} of lookups) {
    if (run.kind === 'ok' && /^[0-9a-f]{40}$/.test(run.stdout.trim())) {
      shas.push(run.stdout.trim());
    } else if (run.kind === 'exit' && run.status === 1) {
      // --verify --quiet exits 1, silently, for a name that is not a commit.
      unresolved.push(shortSha);
    } else {
      return {ok: false, reason: describeGitFailure(args, run)};
    }
  }

  const undated = evidence.calls.filter((call) => call.startedAt == null);
  if (undated.length > 0) {
    return {
      ok: false,
      reason: `${undated.length} git commit call${undated.length === 1 ? '' : 's'} in the transcript carr${undated.length === 1 ? 'ies' : 'y'} no timestamp, so the commits cannot be matched to them`,
    };
  }
  const windows = evidence.calls.flatMap((call) => {
    const start = Date.parse(call.startedAt ?? '');
    const end =
      call.endedAt == null
        ? start + OPEN_COMMIT_WINDOW_MS
        : Date.parse(call.endedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return [];
    return [
      {
        command: call.command,
        end: Math.max(start, end) + COMMIT_WINDOW_SLACK_MS,
        matched: false,
        start: start - COMMIT_WINDOW_SLACK_MS,
      },
    ];
  });
  if (windows.length !== evidence.calls.length) {
    return {
      ok: false,
      reason:
        'a git commit call in the transcript has a timestamp that is not a time',
    };
  }
  if (windows.length > 0) {
    const earliest = Math.min(...windows.map((window) => window.start));
    const args = [
      'log',
      '--all',
      `--since=${new Date(earliest).toISOString()}`,
      '--format=%H %ct',
    ];
    const run = await git(args);
    if (run.kind !== 'ok') {
      return {ok: false, reason: describeGitFailure(args, run)};
    }
    for (const line of run.stdout.split('\n')) {
      const match = /^([0-9a-f]{40}) (\d+)$/.exec(line.trim());
      if (match == null) continue;
      const sha = match[1] ?? '';
      const ms = Number(match[2]) * 1000;
      let inWindow = false;
      for (const window of windows) {
        if (ms >= window.start && ms <= window.end) {
          window.matched = true;
          inWindow = true;
        }
      }
      if (inWindow && !shas.includes(sha)) shas.push(sha);
    }
  }
  return {
    ok: true,
    value: {
      count: shas.length,
      shas,
      source: 'transcript',
      unmatchedCalls: windows
        .filter((window) => !window.matched)
        .map((window) => window.command),
      unresolved,
    },
  };
}

/**
 * How much of the session's commit evidence matched no commit here (R3): the
 * commit commands whose window caught none, plus the confirmation lines that
 * do not resolve. Zero for the `--since` fallback, which has no evidence.
 */
export function unmatchedCommitEvidence(commits: SessionCommits): number {
  return commits.source === 'transcript'
    ? commits.unmatchedCalls.length + commits.unresolved.length
    : 0;
}
