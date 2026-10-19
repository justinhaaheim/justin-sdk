/**
 * Which beads THIS session created with a plain `br create`, from its own
 * transcript (home-base-vzwbj.4.19 D2).
 *
 * THE PROBLEM. Session 7a59f2e5 (2026-10-17) filed its request as an activity
 * ("Think through how hooks are managed"), answered it, closed it, and filed
 * the decision itself as an ordinary bead, home-base-s4r5v, with `br create`.
 * That bead carried no `sid:` label and hung under no request, so the session
 * tree never saw it and Part 1 said every request was done while the change
 * Justin wanted was unbuilt. Nothing else records "this session created it":
 * BrIssue has no created_by, and only `thread request`, `thread ask` and the
 * session bead itself carry the `sid:` label.
 *
 * THE EVIDENCE. A Bash tool_use whose command runs `br create`, and the ids in
 * its matching tool_result (matched by tool_use id). br prints, measured on
 * br 0.1.x on 2026-10-17 with a real `br create` in this worktree:
 *
 *   default      `✓ Created home-base-jcngn: <title>`
 *   --silent     `home-base-jcngn.1` (the id alone on its line)
 *   --json       a JSON object whose top-level `"id"` is the new id
 *   --dry-run    `Dry run: would create issue home-base-4vjm1` (NOT created)
 *
 * `br q` ("Quick capture", home-base-j8q3e.13 F5) creates too, and prints like
 * --silent: measured 2026-10-17 in a scratch workspace, `br q Decide X` printed
 * `probe-sgj` alone on its line and `br q --json …` printed
 * `{"id":"probe-16p","title":"Decide Y"}`.
 *
 * F6: with --silent, --json or `br q`, every bead-shaped id in the WHOLE Bash
 * output is read, so `br create --json … && br show Y --json` would list Y as
 * created here. resolveCreatedBeads therefore keeps only ids whose export
 * created_at falls in the call's window, and names the rest in one line.
 *
 * The shape copies session-commits.ts and session-writes.ts: a pure scan of
 * one file's text (raw-line prefilter, tool_use-id dedupe), and a reader over
 * the main transcript plus every subagent transcript beside it (a player's
 * `br create` is the session's work too). A transcript that cannot be read is
 * `{ok: false}`, never "it created nothing" (critical rule 7).
 */

import type {Measured} from './session-model';
import type {ExportRead, TreeIssue} from './session-tree';

import {readFileSync} from 'fs';

import {BEAD_ID_SOURCE, findBeadsWorkspace} from '../beads/br';
import {stripQuotedText, subagentTranscripts} from './session-commits';
import {measured, unmeasured} from './session-model';
import {parseExportLine, readBeadsExport} from './session-tree';

/** One bead a `br create` in the transcript reported creating. */
export interface CreatedBead {
  /** The tool_use record's time; null when no record of it carries one. */
  createdAt: string | null;
  /**
   * The working directory of the Bash call (the record's `cwd`): where br
   * looked for its database. null when the record carries none.
   */
  cwd: string | null;
  file: string;
  id: string;
  /**
   * The time of the tool_result record that named it (F6: the bead was made
   * before its result came back, however long a permission prompt held the
   * call); null when that record carries none.
   */
  resultAt: string | null;
}

export interface CreatedEvidence {
  created: CreatedBead[];
  /** Every transcript file read, the main one first. */
  files: string[];
  /** Lines that were not JSON (a line being written is the usual cause). */
  unparsedLines: number;
}

/** A bead id as br prints it (br.ts BEAD_ID_SOURCE). */
const BEAD_ID = BEAD_ID_SOURCE;

/** br's default confirmation line (the check mark is optional: `--no-color`). */
const CREATED_LINE = new RegExp(
  String.raw`^(?:✓ )?Created (${BEAD_ID}): `,
  'gm',
);

/** `--silent`: the id alone on a line. */
const SILENT_LINE = new RegExp(String.raw`^(${BEAD_ID})$`, 'gm');

/** `--json`: the record's `"id"` key (dependencies use `issue_id`, never `"id"`). */
const JSON_ID = new RegExp(String.raw`"id":\s*"(${BEAD_ID})"`, 'g');

/** A raw-line filter before any parse: `br create` or `br q` (F5). */
const BR_CREATE_IN_RAW = /\bbr\s+(?:create|q)\b/;

/** One `br create` or `br q` call in a command: its arguments after the verb. */
interface CreateCall {
  /** `br q`: prints the id alone, like --silent (F5). */
  quick: boolean;
  rest: string;
}

function brCreateCalls(command: string): CreateCall[] {
  const plain = stripQuotedText(command);
  const pattern = /(?:^|[\s;&|(])br\s+(create|q)(?=$|[\s;&|)])/g;
  const calls: CreateCall[] = [];
  for (const match of plain.matchAll(pattern)) {
    const rest = plain.slice((match.index ?? 0) + match[0].length);
    const segment = rest.split(/;|&&|\|\||\|/)[0] ?? '';
    if (/(?:^|\s)(?:--dry-run|--help|-h)(?=$|\s)/.test(segment)) continue;
    calls.push({quick: match[1] === 'q', rest: segment});
  }
  return calls;
}

/**
 * The `br create` and `br q` (F5) segments of `command`, quoted text ignored,
 * so `echo "br create"` and a title that says "br create" are not one. A
 * segment asking for `--dry-run`, `--help` or `-h` creates nothing and is
 * dropped.
 */
export function brCreateSegments(command: string): string[] {
  return brCreateCalls(command).map((call) => call.rest);
}

/** Does `command` run a `br create` that creates something? */
export function isBrCreateCommand(command: string): boolean {
  return brCreateSegments(command).length > 0;
}

/**
 * The ids a `br create` command's output names, in the format its flags ask
 * for (see the header). Pure.
 */
export function createdIdsInOutput(command: string, output: string): string[] {
  const calls = brCreateCalls(command);
  if (calls.length === 0) return [];
  const ids = new Set<string>();
  for (const match of output.matchAll(CREATED_LINE)) ids.add(match[1] ?? '');
  const flag = (name: string): boolean =>
    calls.some((call) =>
      new RegExp(String.raw`(?:^|\s)${name}(?=$|\s)`).test(call.rest),
    );
  // F5: `br q` prints the id alone on its line, as --silent does.
  if (flag('--silent') || calls.some((call) => call.quick)) {
    for (const match of output.matchAll(SILENT_LINE)) ids.add(match[1] ?? '');
  }
  if (flag('--json')) {
    for (const match of output.matchAll(JSON_ID)) ids.add(match[1] ?? '');
  }
  ids.delete('');
  return [...ids];
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

/**
 * D2's evidence in one transcript file's text. Pure: the tests drive it with
 * literal JSONL. A tool_use id seen twice (Claude Code's `api-request-blob`
 * record repeats an assistant message with no timestamp, home-base-j8q3e.1.4)
 * is one call, dated by the first record that carries a time; an id created
 * twice (a repeated result) is one bead.
 */
export function createdBeadsFromText(
  text: string,
  file: string,
): Omit<CreatedEvidence, 'files'> {
  const calls = new Map<
    string,
    {command: string; createdAt: string | null; cwd: string | null}
  >();
  const created = new Map<string, CreatedBead>();
  let unparsedLines = 0;
  for (const line of text.split('\n')) {
    const isUse =
      line.includes('"tool_use"') &&
      line.includes('"Bash"') &&
      BR_CREATE_IN_RAW.test(line);
    let isResult = false;
    if (!isUse && line.includes('"tool_result"')) {
      // Parse a result only when it answers a `br create` call seen above.
      isResult = [...line.matchAll(/"tool_use_id":"([^"]+)"/g)].some((match) =>
        calls.has(match[1] ?? ''),
      );
    }
    if (!isUse && !isResult) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      unparsedLines += 1;
      continue;
    }
    const at = stringField(record, 'timestamp');
    const cwd = stringField(record, 'cwd');
    for (const block of contentBlocks(record)) {
      if (block == null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === 'tool_use' && entry.name === 'Bash') {
        const id = stringField(entry, 'id');
        const command = stringField(entry.input, 'command');
        if (id == null || command == null || !isBrCreateCommand(command)) {
          continue;
        }
        const known = calls.get(id);
        calls.set(id, {
          command,
          createdAt: known?.createdAt ?? at,
          cwd: known?.cwd ?? cwd,
        });
      } else if (entry.type === 'tool_result') {
        const call = calls.get(stringField(entry, 'tool_use_id') ?? '');
        if (call == null) continue;
        for (const id of createdIdsInOutput(
          call.command,
          textOfResult(entry.content),
        )) {
          if (created.has(id)) continue;
          created.set(id, {
            createdAt: call.createdAt,
            cwd: call.cwd,
            file,
            id,
            resultAt: at,
          });
        }
      }
    }
  }
  return {created: [...created.values()], unparsedLines};
}

/** Is `a`'s call earlier than `b`'s? A dated call beats an undated one. */
function earlierCall(a: CreatedBead, b: CreatedBead): boolean {
  const at = a.createdAt == null ? Number.NaN : Date.parse(a.createdAt);
  const bt = b.createdAt == null ? Number.NaN : Date.parse(b.createdAt);
  if (Number.isNaN(at)) return false;
  return Number.isNaN(bt) || at < bt;
}

/**
 * D2 over the main transcript and every subagent transcript beside it, or why
 * one of them could not be read (rule 7: never an empty list for that).
 */
export function readCreatedBeads(
  transcriptPath: string,
): {evidence: CreatedEvidence; ok: true} | {ok: false; reason: string} {
  const subagents = subagentTranscripts(transcriptPath);
  if (!subagents.ok) return subagents;
  const files = [transcriptPath, ...subagents.files];
  const evidence: CreatedEvidence = {created: [], files, unparsedLines: 0};
  // One entry per id: the EARLIEST dated call that named it, since a bead's
  // id can only be printed after it exists (F6 compares that call's time).
  const byId = new Map<string, CreatedBead>();
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
    const one = createdBeadsFromText(text, file);
    for (const bead of one.created) {
      const known = byId.get(bead.id);
      if (known == null || earlierCall(bead, known)) byId.set(bead.id, bead);
    }
    evidence.unparsedLines += one.unparsedLines;
  }
  evidence.created.push(...byId.values());
  return {evidence, ok: true};
}

// ---------------------------------------------------------------------------
// Finding the created beads in the exports
// ---------------------------------------------------------------------------

/** The beads this session created, as the exports hold them now. */
export interface CreatedBeads {
  /** Newest record per id, from any export searched; deleted ones dropped. */
  found: TreeIssue[];
  /**
   * Ids a `br create` reported that no export searched holds (another repo's
   * DB, `--db`, `--ephemeral`, or a worktree since removed), each with the
   * exports searched for it.
   */
  missing: {id: string; searched: string[]}[];
  /**
   * j8q3e.13 F6: ids named in a `br create` call's output whose export
   * created_at is not in that call's window (CREATED_WINDOW), so that call
   * did not create them: `br create --json … && br show Y --json` names Y.
   * Never adopt candidates; each says why.
   */
  notCreatedThen: {id: string; why: string}[];
}

/** F6: a bead counts as made by a call when created this long after it. */
export const CREATED_WINDOW_MS = 5 * 60_000;
/** br's created_at and the transcript's time may round apart by this much. */
const CREATED_SLACK_MS = 1000;

/**
 * F6: why `issue` was not created by the call that named it, or null when its
 * created_at is in the window: from the call's time (less the slack) to 5
 * minutes after it, or to the call's result if that came back later (a
 * permission prompt can hold a call).
 */
export function notCreatedByCall(
  call: Pick<CreatedBead, 'createdAt' | 'resultAt'>,
  issue: Pick<TreeIssue, 'createdAt'>,
): string | null {
  const callMs =
    call.createdAt == null ? Number.NaN : Date.parse(call.createdAt);
  const beadMs =
    issue.createdAt == null ? Number.NaN : Date.parse(issue.createdAt);
  if (Number.isNaN(callMs)) return 'the call has no time to compare';
  if (Number.isNaN(beadMs)) return 'its export has no created_at to compare';
  const resultMs =
    call.resultAt == null ? Number.NaN : Date.parse(call.resultAt);
  const end = Math.max(
    callMs + CREATED_WINDOW_MS,
    Number.isNaN(resultMs) ? callMs : resultMs + CREATED_SLACK_MS,
  );
  if (beadMs >= callMs - CREATED_SLACK_MS && beadMs <= end) return null;
  return `created ${issue.createdAt ?? '?'}, the call was at ${call.createdAt ?? '?'}`;
}

function newerOf(a: TreeIssue, b: TreeIssue): TreeIssue {
  const at = a.updatedAt == null ? Number.NaN : Date.parse(a.updatedAt);
  const bt = b.updatedAt == null ? Number.NaN : Date.parse(b.updatedAt);
  if (Number.isNaN(at)) return b;
  if (Number.isNaN(bt)) return a;
  return bt > at ? b : a;
}

/**
 * Look the created ids up in the session's own beads dirs, plus the beads
 * workspace of the directory each `br create` ran in (where br looked for its
 * database: session 7a59f2e5's session bead is in home-base main, but it ran
 * `br create` in its worktree, whose export is the only one holding those
 * beads). An export that cannot be read makes the whole answer unmeasured,
 * never "not created" (rule 7).
 */
export function resolveCreatedBeads(input: {
  created: readonly CreatedBead[];
  /** How an export is read; default `readBeadsExport`. */
  readExport?: (beadsDir: string) => ExportRead;
  /** The session's own beads dirs (the sessions index's sightings). */
  sessionDirs: readonly string[];
  /** A directory's beads dir, or null when it has none; default findBeadsWorkspace. */
  workspaceOf?: (cwd: string) => string | null;
}): Measured<CreatedBeads> {
  const readExport = input.readExport ?? readBeadsExport;
  const workspaceOf =
    input.workspaceOf ??
    ((cwd: string): string | null => {
      const found = findBeadsWorkspace(cwd);
      return found.kind === 'found' ? found.beadsDir : null;
    });
  const exports = new Map<string, ExportRead>();
  const exportOf = (dir: string): ExportRead => {
    const known = exports.get(dir);
    if (known != null) return known;
    const read = readExport(dir);
    exports.set(dir, read);
    return read;
  };
  const workspaces = new Map<string, string | null>();
  const found = new Map<string, TreeIssue>();
  const deleted = new Set<string>();
  const missing: CreatedBeads['missing'] = [];
  const notCreatedThen: CreatedBeads['notCreatedThen'] = [];
  for (const bead of input.created) {
    const dirs = [...input.sessionDirs];
    if (bead.cwd != null) {
      if (!workspaces.has(bead.cwd)) {
        workspaces.set(bead.cwd, workspaceOf(bead.cwd));
      }
      const dir = workspaces.get(bead.cwd) ?? null;
      if (dir != null) dirs.push(dir);
    }
    const needle = `"id":${JSON.stringify(bead.id)}`;
    const searched: string[] = [];
    for (const dir of [...new Set(dirs)]) {
      const read = exportOf(dir);
      if (read.kind === 'failed') {
        return unmeasured(
          `the beads export that would hold ${bead.id} could not be read: ${read.reason}`,
        );
      }
      searched.push(read.path);
      if (!read.text.includes(needle)) continue;
      for (const line of read.text.split('\n')) {
        if (!line.includes(needle)) continue;
        const parsed = parseExportLine(line, dir);
        if (!parsed.ok) {
          return unmeasured(
            `a line of ${read.path} naming ${bead.id} is not a bead record (${parsed.reason})`,
          );
        }
        if (parsed.issue.id !== bead.id) continue;
        if (parsed.issue.status === 'tombstone') {
          deleted.add(bead.id);
          continue;
        }
        const known = found.get(bead.id);
        found.set(
          bead.id,
          known == null ? parsed.issue : newerOf(known, parsed.issue),
        );
      }
    }
    // Deleted everywhere it was seen: nothing to adopt, and not missing. A
    // bead deleted in one export and alive in another is alive.
    const issue = found.get(bead.id);
    if (issue == null) {
      if (!deleted.has(bead.id)) missing.push({id: bead.id, searched});
      continue;
    }
    // F6: named in the call's output, but not made by that call.
    const why = notCreatedByCall(bead, issue);
    if (why != null) {
      found.delete(bead.id);
      notCreatedThen.push({id: bead.id, why});
    }
  }
  return measured({found: [...found.values()], missing, notCreatedThen});
}

/**
 * The beads this session created, for `thread status` (D2): the transcript
 * scan, then the export lookup. `{ok: false}` when the transcript is unknown
 * or unreadable — "could not check", never "created none".
 */
export function loadCreatedBeads(input: {
  readExport?: (beadsDir: string) => ExportRead;
  sessionDirs: readonly string[];
  transcriptPath: string | null;
  /** Why there is no transcript path, when there is none. */
  transcriptProblem: string;
}): Measured<CreatedBeads> {
  if (input.transcriptPath == null) {
    return unmeasured(input.transcriptProblem);
  }
  const read = readCreatedBeads(input.transcriptPath);
  if (!read.ok) return unmeasured(read.reason);
  return resolveCreatedBeads({
    created: read.evidence.created,
    ...(input.readExport != null ? {readExport: input.readExport} : {}),
    sessionDirs: input.sessionDirs,
  });
}
