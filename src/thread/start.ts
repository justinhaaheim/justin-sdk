/**
 * `justin-sdk thread start` — create this session's thread bead BEFORE it has
 * anything to report (home-base-p1uj.3, D1/D5/D6/D7/D30).
 *
 * WHY IT EXISTS. Until now a session only became visible on the board when it
 * wrote a status report, which means the sessions most worth seeing — the ones
 * that ran out of context, crashed, or were abandoned half way — were exactly
 * the ones that appeared nowhere (Justin, 2026-09-12: "that session isn't in
 * danger of sort of being ignored because it didn't get to the status report
 * kind of final step"). Creating the bead at session start makes the board's
 * silence mean "no session", instead of "no session that finished politely".
 * That is rule 6 applied to the board itself.
 *
 * IT IS AN UPSERT'S FIRST HALF, NOT A SECOND WRITER. The bead is keyed on
 * `metadata.sessionId` exactly as `thread report` keys its upsert (D1), so the
 * first report for the session FINDS this bead and rewrites it in place rather
 * than creating a second. `buildStartMetadata` writes the same key set with
 * explicit nulls precisely so that rewrite is a clean overwrite.
 *
 * TWO KNOBS, BOTH REQUIRED: `componentConfig.thread.enabled` AND
 * `componentConfig.thread.startOnSessionStart`, both default false (D6, and see
 * config.ts for why they are separate). With either off this command creates
 * nothing and says so in one line — and in hook mode says nothing at all.
 *
 * THE HOOK MAY NEVER BLOCK A SESSION. `runThreadStartHook` always resolves 0,
 * never throws, and writes nothing to stdout except — on the one path where a
 * bead was actually created — a single short line. Its stdout becomes model
 * context, so every diagnostic goes to stderr, where `claude --debug` and a
 * hand-run payload can still see it.
 */

import {basename} from 'path';

import {
  bdContext,
  EXPORT_UNSTAGED_WARNING,
  createThread,
  describeBdFailure,
  findThreadBySession,
  setThreadInProgress,
} from './bd';
import {collectThreadFacts} from './facts';
import {
  lifeBeadsDir,
  lifeBeadsMissingLine,
  probeWritable,
  SANDBOX_DENIED_LINE,
  threadsStateDir,
} from './paths';
import {buildStartMetadata} from './metadata';
import {recordStartFailure} from './archive';

import type {BdFailure} from './bd';
import type {EnvLike} from './paths';
import type {ThreadFacts} from './facts';
import type {WriteResult} from './archive';

/**
 * What one `thread start` did. A tagged union rather than a boolean-and-a-string
 * because six of these outcomes are "nothing was created" and they are NOT
 * interchangeable: "the knob is off" is a configuration fact, "the sandbox
 * refused" is an allowlist fix, "bd is locked" is a retry, and "the thread
 * already exists" is a success. Collapsing any pair would make the hook's
 * silence ambiguous, which is the failure mode this whole feature is about.
 */
export type ThreadStartOutcome =
  | {kind: 'disabled'; reason: string}
  | {kind: 'skippedSubagent'; agentId: string}
  | {kind: 'sandboxDenied'; path: string; error: string}
  | {kind: 'lifeBeadsMissing'; path: string}
  | {kind: 'noSessionId'; reason: string}
  | {kind: 'existing'; threadId: string; status: string | null; title: string}
  | {
      kind: 'created';
      /** A write landed but its JSONL export was not git-staged (p1uj.10). */
      exportUnstaged: boolean;
      threadId: string;
      title: string;
      /** null means the bead really is `in_progress`; a failure means it is still `open`. */
      statusFailure: BdFailure | null;
    }
  | {kind: 'bdFailed'; failure: BdFailure; record: WriteResult | null};

export interface ThreadStartOptions {
  /** Present only for a subagent's tool call — see runThreadStartHook. */
  agentId?: string | null;
  cwd?: string;
  env?: EnvLike;
  now?: Date;
  sessionId?: string | null;
  /** Override the generated "(untitled) …" placeholder. */
  title?: string | null;
  /** The hook payload's `transcript_path`, which saves a directory scan. */
  transcriptPath?: string | null;
}

/** First 8 characters of the session uuid — enough to recognise, short enough to read. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * The placeholder title (bead body, verbatim): `(untitled) <repo> session <id>`.
 *
 * `repo` falls back to the working directory's basename when this is not a git
 * checkout. That is a LABEL, not a measurement: `metadata.repo` stays null in
 * that case, so nothing downstream can read the fallback back as a repo name.
 */
export function startTitle(facts: ThreadFacts, sessionId: string): string {
  const label = facts.repo ?? basename(facts.cwd);
  return `(untitled) ${label} session ${shortSessionId(sessionId)}`;
}

function startDescription(facts: ThreadFacts, startedAt: string): string {
  return [
    'NO REPORT YET — this session has started but has not written a status report.',
    '',
    `started    ${startedAt}`,
    `repo       ${facts.repo ?? 'UNKNOWN'}`,
    `branch     ${facts.branch ?? 'UNKNOWN'}`,
    `cwd        ${facts.cwd}`,
    '',
    'Created at session start by the justin-sdk SessionStart hook so that a',
    'session which never reaches its status report is still on the board. The',
    'first `justin-sdk thread report` for this session rewrites this bead in',
    'place — it does not create a second one.',
  ].join('\n');
}

function startNotes(facts: ThreadFacts, startedAt: string): string {
  return [
    'NO REPORT YET.',
    '',
    `This thread bead was created at session start (${startedAt}). Everything a`,
    'status report would say — goal, what was done, stop reason, progress, asks —',
    'is still unknown, and is recorded as null rather than as a zero or an empty',
    'list.',
    '',
    'To fill it in, from that session:',
    '  justin-sdk thread prepare',
    '  justin-sdk thread report --file <payload>',
    '',
    `session   ${facts.sessionId ?? 'UNKNOWN'}`,
    `transcript ${facts.transcriptPath ?? 'UNKNOWN'}`,
  ].join('\n');
}

/**
 * The decision half: everything except printing. Returns what happened; writes
 * to bd and to the start-failure record, and nothing to any stream.
 */
export async function startThread(
  options: ThreadStartOptions = {},
): Promise<ThreadStartOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();

  // 1. SUBAGENT. The hook payload's `agent_id` is the ONLY discriminant that
  // exists — measured 2026-09-12 on claude 2.1.269: inside a subagent's Bash,
  // CLAUDE_CODE_SESSION_ID is the PARENT's id and CLAUDE_CODE_CHILD_SESSION is
  // set unconditionally by the binary, so an env-based guard would either miss
  // every subagent or skip every session. Without this check a dispatched
  // player would create (and later overwrite) its conductor's thread bead.
  if (options.agentId != null && options.agentId !== '') {
    return {agentId: options.agentId, kind: 'skippedSubagent'};
  }

  // NO HEADLESS / UNATTENDED GUARD. There used to be one here, skipping any
  // session whose CLAUDE_CODE_SESSION_ATTENDED was set to something other than
  // "1". It was labelled conjecture in its own comment — what a `claude -p` run
  // sets was never measured — and it contradicted D30, which wants a row for
  // EVERY session: an unattended run is if anything MORE likely to be the one
  // nobody notices stopped. Deleted on the conductor's decision (p1uj.7, item
  // B). The subagent skip above stays: that one is measured, and it prevents a
  // player from creating its conductor's bead.

  // 2. KNOBS. Read before anything that costs a subprocess or a write probe.
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  if (!config.enabled || !config.startOnSessionStart) {
    const off = !config.enabled
      ? `componentConfig.thread.enabled is not true (resolved from: ${config.source})`
      : `componentConfig.thread.startOnSessionStart is not true (resolved from: ${config.startSource})`;
    return {kind: 'disabled', reason: off};
  }

  // 3. FACTS. `transcriptPath` comes from the hook payload when there is one,
  // which skips scanning every directory under ~/.claude/projects for a file
  // that, at `source: startup`, does not exist yet anyway.
  const facts = collectThreadFacts({
    cwd,
    env,
    now,
    sessionId: options.sessionId,
    transcriptPath: options.transcriptPath,
  });
  if (facts.sessionId == null) {
    return {
      kind: 'noSessionId',
      reason:
        'no session id (the hook payload carried no session_id, CLAUDE_CODE_SESSION_ID is unset, and --session was not passed). A thread bead is KEYED on it.',
    };
  }
  const sessionId = facts.sessionId;

  // 4. SANDBOX. Probed before any bd call, so a session that cannot possibly
  // write never spends a subprocess — or a permission prompt — finding out.
  // The state dir is ours to create; the beads dir is bd's, and creating it
  // would fabricate a workspace rather than find one (F9).
  const stateProbe = probeWritable(threadsStateDir(env), {create: true});
  if (stateProbe.kind === 'denied') {
    return {
      error: stateProbe.error,
      kind: 'sandboxDenied',
      path: stateProbe.path,
    };
  }
  const beadsProbe = probeWritable(lifeBeadsDir(env), {create: false});
  if (beadsProbe.kind === 'denied') {
    return {
      error: beadsProbe.error,
      kind: 'sandboxDenied',
      path: beadsProbe.path,
    };
  }
  if (beadsProbe.kind === 'missing') {
    return {kind: 'lifeBeadsMissing', path: beadsProbe.path};
  }

  const ctx = bdContext(env);

  // 5. IDEMPOTENCY. A resume fires SessionStart again with the same session id,
  // and `thread report` may already have created the bead, so the lookup is the
  // load-bearing half of "run me as often as you like". A FAILED lookup is not
  // "there is none": returning bdFailed here is what stops a locked database
  // from producing a second thread bead for a session that already has one.
  const existing = await findThreadBySession(ctx, sessionId);
  if (!existing.ok) {
    return {
      failure: existing.failure,
      kind: 'bdFailed',
      record: recordStartFailure(
        {facts, sessionId, startedAt},
        describeBdFailure(existing.failure),
        env,
      ),
    };
  }
  if (existing.value != null) {
    return {
      kind: 'existing',
      status: existing.value.status ?? null,
      threadId: existing.value.id,
      title: existing.value.title ?? '(no title)',
    };
  }

  // 6. CREATE.
  const title =
    options.title != null && options.title !== ''
      ? options.title
      : startTitle(facts, sessionId);
  const created = await createThread(ctx, {
    description: startDescription(facts, startedAt),
    metadata: buildStartMetadata({facts, startedAt}),
    notes: startNotes(facts, startedAt),
    title,
  });
  if (!created.ok) {
    return {
      failure: created.failure,
      kind: 'bdFailed',
      record: recordStartFailure(
        {facts, sessionId, startedAt},
        describeBdFailure(created.failure),
        env,
      ),
    };
  }

  // 7. STATUS. `bd create` has no status flag, so `in_progress` (D10) costs a
  // second write. If it fails the bead still EXISTS — reporting that as a plain
  // failure would be its own rule-6 violation in the other direction, so the
  // outcome carries both the id and the named failure.
  const status = await setThreadInProgress(ctx, created.value);
  return {
    exportUnstaged: ctx.exportUnstaged,
    kind: 'created',
    statusFailure: status.ok ? null : status.failure,
    threadId: created.value,
    title,
  };
}

/** The one line a human (or a hook, on success) sees. */
export function describeStartOutcome(outcome: ThreadStartOutcome): string {
  switch (outcome.kind) {
    case 'disabled':
      return `thread start: disabled — ${outcome.reason}. Nothing was created.`;
    case 'skippedSubagent':
      return `thread start: skipped — this is a subagent (agent_id=${outcome.agentId}); its conductor owns the thread.`;
    case 'sandboxDenied':
      return SANDBOX_DENIED_LINE;
    case 'lifeBeadsMissing':
      return lifeBeadsMissingLine(outcome.path);
    case 'noSessionId':
      return `thread start: ${outcome.reason} Nothing was created.`;
    case 'existing':
      return `thread already started: ${outcome.threadId} (${outcome.status ?? 'UNKNOWN'}) ${outcome.title}`;
    case 'created':
      return outcome.statusFailure == null
        ? `thread started: ${outcome.threadId}`
        : `thread started: ${outcome.threadId} ⚠️ but it is still 'open' — ${describeBdFailure(outcome.statusFailure)}`;
    case 'bdFailed':
      return `thread start: NOT RECORDED — ${describeBdFailure(outcome.failure)}`;
  }
}

/** Exit code for the hand-run command. The hook path never uses this. */
export function startExitCode(outcome: ThreadStartOutcome): number {
  return outcome.kind === 'bdFailed' ? 1 : 0;
}

/**
 * `justin-sdk thread start` run by a human. Prints one line for every outcome,
 * including the ones where nothing happened — a hand-run command that prints
 * nothing is indistinguishable from one that is not installed.
 */
export async function runThreadStart(
  options: ThreadStartOptions = {},
): Promise<number> {
  const outcome = await startThread(options);
  const line = describeStartOutcome(outcome);
  if (outcome.kind === 'bdFailed') {
    console.error(line);
    if (outcome.record != null && !outcome.record.ok) {
      console.error(
        `  ⚠️ and the failure record could not be written to ${outcome.record.path} (${outcome.record.error})`,
      );
    }
  } else {
    console.log(line);
  }
  return startExitCode(outcome);
}

/**
 * The SessionStart hook payload, as Claude Code writes it on stdin.
 *
 * `source` is SessionStart-only (startup | resume | clear | compact) and is not
 * branched on here: the installed matcher already restricts the hook to startup
 * and resume, and for the other two the session id is unchanged, so this command
 * is a no-op anyway. It is read purely so the stderr diagnostics can name it.
 */
interface SessionStartHookInput {
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  transcript_path?: string;
}

/**
 * `justin-sdk thread start --hook`: the SessionStart entry point.
 *
 * ALWAYS RESOLVES 0, from every path including a thrown one. A SessionStart hook
 * that fails can take the session with it, and no status-reporting convenience
 * is worth that.
 *
 * STDOUT IS MODEL CONTEXT. Exactly one path writes to it — a bead was created,
 * one short line naming its id, because the session genuinely needs to know the
 * id it will report to. Everything else (disabled, skipped, denied, failed, and
 * even "the thread already existed") goes to stderr or nowhere: a line printed
 * at the top of every session in every repo is a line Justin stops reading.
 *
 * The payload's `session_id`, `transcript_path` and `cwd` are PREFERRED over the
 * environment. Inside the hook process the env may describe a different session
 * than the one starting, and the payload is authoritative by construction.
 */
export async function runThreadStartHook(args?: {
  stdin?: string;
  now?: Date;
}): Promise<number> {
  let input: SessionStartHookInput = {};
  try {
    const {readFileSync} = await import('fs');
    const raw = args?.stdin ?? readFileSync(0, 'utf8');
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as SessionStartHookInput);
  } catch {
    // An unreadable or malformed payload is not worth a word: there is nothing
    // actionable to say and nowhere useful to say it at session start.
    return 0;
  }

  try {
    const outcome = await startThread({
      agentId: input.agent_id ?? null,
      cwd: input.cwd,
      now: args?.now,
      sessionId: input.session_id ?? null,
      transcriptPath: input.transcript_path ?? null,
    });

    if (outcome.kind === 'created') {
      console.log(describeStartOutcome(outcome));
      if (outcome.exportUnstaged) console.error(EXPORT_UNSTAGED_WARNING);
      return 0;
    }
    // Everything below is stderr-only. `disabled` and `skippedSubagent` are the
    // overwhelmingly common cases and say nothing at all — they are normal.
    if (outcome.kind === 'disabled' || outcome.kind === 'skippedSubagent') {
      return 0;
    }
    console.error(
      `[thread start] ${describeStartOutcome(outcome)}${input.source == null ? '' : ` (source=${input.source})`}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `[thread start] unexpected failure, session not started: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}
