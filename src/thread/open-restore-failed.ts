/**
 * `thread open --restore-failed` (home-base-kwand.3 item 2, gap G3 of epic
 * home-base-kwand): every session whose cmux restore failed after the last
 * restart (before-restart-state.ts, state `restoreFailed`: its old tab is back
 * as a plain shell showing cmux's restore error) is opened again as a NEW tab
 * of its old workspace, newest activity first. A session whose old workspace
 * is gone opens in a new workspace instead, as the dashboard's `o` does.
 *
 * - Decision D2: the failed tab is never typed into, sent to or closed. The
 *   new tab comes from restore-tab.ts, the one builder the dashboard's `o`
 *   uses too, here with `--focus false` so a bulk run does not pull every tab
 *   to the front.
 * - The live checks are thread open's (open.ts): the liveness read (a running
 *   session is never resumed twice), a live Claude pane that cannot be placed
 *   refuses unless --force-unplaced, a checkout unknown or gone is skipped,
 *   one run at a time (the open lock), and ps read again right before each
 *   open (F21).
 * - The restart record is the authority for which sessions qualify, so the
 *   --since / --days window does not apply (as `inbox --before-restart`
 *   keeps every before-restart session whatever its age). --repo and --limit
 *   do.
 * - D-RECORD: <threads state dir>/opens/<stamp>.json is written before the
 *   first cmux write and rewritten around every call; each entry of `tabs` is
 *   written BEFORE its call. `windows` is empty: this run makes no window.
 *   `thread open --undo` closes a fallback workspace like any other it opened,
 *   and refuses a tab opened in an old workspace by name (closing that
 *   workspace would close Justin's other tabs; closing one tab is
 *   home-base-kwand follow-up work).
 * - Decision D3: tests use a fake cmux runner; against the live machine only
 *   --dry-run, which writes nothing.
 */

import type {Field, OutputStyle} from '../cli-style';
import type {CmuxCall, CmuxRunner, CmuxTree, CmuxTreeRead} from './cmux';
import type {LateLiveCheck, LiveSessions, UnplacedLive} from './live-sessions';
import type {OpenCandidate, OpenOptions} from './open';
import type {EnvLike} from './paths';

import {existsSync} from 'node:fs';
import {join} from 'node:path';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {realBeforeRestartReader} from './before-restart-state';
import {readCmuxTree, realCmuxRunner} from './cmux';
import {
  readLiveSessions,
  realLateLiveCheck,
  realLiveSessionDeps,
} from './live-sessions';
import {
  activityWords,
  candidateOf,
  locateWorkspace,
  openLockPath,
  opensDir,
  parseOk,
  recordStamp,
  releaseOpenLock,
  resumeCommand,
  takeOpenLock,
  writeJsonFile,
} from './open';
import {matchesRepo, parseLimit, repoValues} from './open-filters';
import {lookupPanes, realPaneSources} from './pane-join';
import {tildeText} from './part-one';
import {liveSocketPath, socketSettingsJson, zshWord} from './respawn';
import {CMUX_UUID, restoreTabArgs} from './restore-tab';
import {
  beforeRestartGroups,
  INBOX_DEFAULT_DAYS,
  readInbox,
} from './session-inbox';
import {sessionDisplayName} from './session-name';
import {recordSdkWorkspaceName} from './workspace-name';

// ---------------------------------------------------------------------------
// The sessions (read) and the plan (pure)
// ---------------------------------------------------------------------------

/** One session whose cmux restore failed, as the restart record and the inbox know it. */
export interface FailedRestore {
  /** Its inbox row as thread open reads one; null when the inbox has no row for it. */
  candidate: OpenCandidate | null;
  sessionId: string;
  /** The failed tab (a cmux surface id). Never touched (D2); named in the output. */
  tabId: string;
  /** The workspace that tab is in. */
  workspaceId: string;
}

export type FailedRestoresRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; sessions: FailedRestore[]};

/** Where the session opens: a new tab of its old workspace, or a new workspace. */
export type TabTarget = 'newWorkspace' | 'oldWorkspace';

/** Why a session whose restore failed is not opened, as a key the JSON counts by. */
export type RestoreSkipKind =
  | 'checkoutGone'
  | 'checkoutUnknown'
  | 'doneOrArchived'
  | 'duplicate'
  | 'handedOff'
  | 'noInboxRow'
  | 'otherRepo'
  | 'overLimit'
  | 'running'
  | 'untracked'
  | 'workspaceUnknown';

export interface PlannedTab {
  /** The argv after `cmux`: new-surface (oldWorkspace) or new-workspace. */
  args: string[];
  checkout: string;
  /** The failed tab, left as it is (D2). */
  failedTabId: string;
  lastActivityAt: string | null;
  name: string;
  repo: string | null;
  sessionBeadId: string | null;
  sessionId: string;
  target: TabTarget;
  title: string;
  /** The old workspace (oldWorkspace); the one it was in, gone (newWorkspace). */
  workspaceId: string;
}

export interface SkippedTab {
  kind: RestoreSkipKind;
  lastActivityAt: string | null;
  name: string;
  reason: string;
  sessionId: string;
}

export interface RestoreFailedPlan {
  cannotTell: UnplacedLive[];
  /** What the plan holds, by target and by skip reason (AC 2 reads these). */
  counts: {
    newWorkspace: number;
    oldWorkspace: number;
    skipped: Partial<Record<RestoreSkipKind, number>>;
  };
  liveSessionsFound: number;
  /** Newest activity first. */
  planned: PlannedTab[];
  skipped: SkippedTab[];
}

function activityMs(iso: string | null): number {
  if (iso == null) return -Infinity;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** The text new-surface types into the new tab's zsh: cd to the checkout, then resume. */
export function restoreTabCommand(checkout: string, sessionId: string): string {
  return `cd ${zshWord(checkout)} && ${resumeCommand(sessionId)}`;
}

/**
 * The plan, newest activity first. In order, a session is skipped when the
 * inbox has no row for it, it is in another --repo, it is untracked, done,
 * archived or handed off, it runs now, its checkout is unknown or gone, it is
 * listed twice, or its workspace id is not a uuid; else it opens in its old
 * workspace when the tree holds it, or in a new workspace when not. Last,
 * --limit keeps the newest `limit`.
 */
export function planRestoreFailed(input: {
  checkoutExists: (path: string) => boolean;
  limit: number | null;
  live: Extract<LiveSessions, {kind: 'read'}>;
  repos: readonly string[];
  sessions: readonly FailedRestore[];
  tree: CmuxTree;
}): RestoreFailedPlan {
  const plan: RestoreFailedPlan = {
    cannotTell: input.live.unplaced,
    counts: {newWorkspace: 0, oldWorkspace: 0, skipped: {}},
    liveSessionsFound: input.live.bySessionId.size,
    planned: [],
    skipped: [],
  };
  const sorted = [...input.sessions].sort(
    (a, b) =>
      activityMs(b.candidate?.lastActivityAt ?? null) -
      activityMs(a.candidate?.lastActivityAt ?? null),
  );
  const seen = new Set<string>();
  for (const session of sorted) {
    const candidate = session.candidate;
    const name =
      candidate == null
        ? session.sessionId
        : sessionDisplayName(
            candidate.repoTag,
            candidate.title,
            candidate.marks,
          ).trimEnd();
    const skip = (kind: RestoreSkipKind, reason: string): void => {
      plan.skipped.push({
        kind,
        lastActivityAt: candidate?.lastActivityAt ?? null,
        name,
        reason,
        sessionId: session.sessionId,
      });
    };
    if (candidate == null) {
      skip(
        'noInboxRow',
        'the inbox has no row for it (no session bead, and no untracked session in the last 30 days), so where to resume it is not known',
      );
      continue;
    }
    if (!matchesRepo(candidate, input.repos)) {
      skip('otherRepo', `it is in ${candidate.repo ?? 'no known repo'}`);
      continue;
    }
    if (!candidate.tracked) {
      skip(
        'untracked',
        'it has no session bead, and thread open reopens only tracked sessions',
      );
      continue;
    }
    if (candidate.section === 'done' || candidate.section === 'archived') {
      skip('doneOrArchived', `it is marked ${candidate.section}`);
      continue;
    }
    if (candidate.section === 'handedOff') {
      skip(
        'handedOff',
        'it handed off to another session; resume that one instead',
      );
      continue;
    }
    const live = input.live.bySessionId.get(session.sessionId.toLowerCase());
    if (live != null) {
      skip(
        'running',
        `it runs again${live.pid == null ? '' : ` (pid ${live.pid})`}, and a running session is never resumed twice`,
      );
      continue;
    }
    if (candidate.checkout == null) {
      skip(
        'checkoutUnknown',
        'its checkout is unknown, and claude --resume finds nothing from the wrong directory',
      );
      continue;
    }
    if (!input.checkoutExists(candidate.checkout)) {
      skip(
        'checkoutGone',
        `its checkout ${tildeText(candidate.checkout)} no longer exists`,
      );
      continue;
    }
    const key = session.sessionId.toLowerCase();
    if (seen.has(key)) {
      skip('duplicate', 'it is listed twice; it is opened once');
      continue;
    }
    // Rule 7: an id that is not a uuid is not a gone workspace.
    if (!CMUX_UUID.test(session.workspaceId)) {
      skip(
        'workspaceUnknown',
        `its old workspace id ${JSON.stringify(session.workspaceId)} is not a cmux uuid, so whether it still exists cannot be told`,
      );
      continue;
    }
    seen.add(key);
    const present = locateWorkspace(input.tree, session.workspaceId) != null;
    const args = present
      ? restoreTabArgs({
          command: restoreTabCommand(candidate.checkout, session.sessionId),
          focus: false,
          workspaceId: session.workspaceId,
        })
      : [
          'new-workspace',
          '--name',
          name,
          '--cwd',
          candidate.checkout,
          '--command',
          resumeCommand(session.sessionId),
          '--focus',
          'false',
        ];
    if (args == null) continue; // unreachable: the uuid was checked above
    plan.planned.push({
      args,
      checkout: candidate.checkout,
      failedTabId: session.tabId,
      lastActivityAt: candidate.lastActivityAt,
      name,
      repo: candidate.repo,
      sessionBeadId: candidate.sessionBeadId,
      sessionId: session.sessionId,
      target: present ? 'oldWorkspace' : 'newWorkspace',
      title: candidate.title,
      workspaceId: session.workspaceId,
    });
  }
  if (input.limit != null && plan.planned.length > input.limit) {
    for (const cut of plan.planned.slice(input.limit)) {
      plan.skipped.push({
        kind: 'overLimit',
        lastActivityAt: cut.lastActivityAt,
        name: cut.name,
        reason: `--limit ${input.limit} kept the newest ${input.limit}`,
        sessionId: cut.sessionId,
      });
    }
    plan.planned = plan.planned.slice(0, input.limit);
  }
  for (const entry of plan.planned) plan.counts[entry.target] += 1;
  for (const entry of plan.skipped) {
    plan.counts.skipped[entry.kind] =
      (plan.counts.skipped[entry.kind] ?? 0) + 1;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The record (D-RECORD)
// ---------------------------------------------------------------------------

/** One open, written before its cmux call and stamped after it. */
export interface OpenedTab {
  /** cmux's answer, first line, as printed; null before the call or on a failure. */
  answer: string | null;
  args: string[];
  failedTabId: string;
  /** Why the call failed; null when it did not (or has not run). */
  failure: string | null;
  /** Why the new tab's or workspace's uuid is not known, when it is not. */
  idProblem: string | null;
  name: string;
  /** When cmux answered OK; null before the call or when it failed. */
  openedAt: string | null;
  sessionId: string;
  /** The new tab's surface uuid (oldWorkspace), read from the tree after the call. */
  surfaceId: string | null;
  target: TabTarget;
  /** oldWorkspace: the old workspace. newWorkspace: the one cmux made, once known. */
  workspaceId: string | null;
}

export interface RestoreFailedRecord extends RestoreFailedPlan {
  argv: string[];
  at: string;
  dryRun: boolean;
  failures: string[];
  filters: {limit: number | null; repos: string[]};
  finishedAt: string | null;
  kind: 'restoreFailed';
  /** F21: planned sessions a claude process started on before their turn. */
  lateLive: {name: string; pid: number; sessionId: string}[];
  refused: string | null;
  tabs: OpenedTab[];
  version: 1;
  /** Always empty: this run makes no window (open-undo.ts reads the key). */
  windows: [];
}

export type JsonWriter = (
  path: string,
  value: unknown,
  first: boolean,
) => string | null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABELS: readonly Field[] = [
  'Repo',
  'Last activity',
  'Checkout',
  'Opens in',
  'Failed tab',
  'Why',
].map((label) => ({label, value: ''}));

function block(title: string, fields: readonly Field[], style: OutputStyle) {
  return [
    wrapHanging(paint(title, ['bold'], style.color), {
      hang: BODY_COLUMN + 4,
      indent: BODY_COLUMN,
      width: style.width,
    }),
    fieldLines(fields, {
      color: style.color,
      indent: stepColumn(1),
      labelWidth: fieldLabelWidth(LABELS),
      width: style.width,
    }),
  ].join('\n');
}

function prose(text: string, style: OutputStyle): string {
  return wrapHanging(text, {
    hang: BODY_COLUMN,
    indent: BODY_COLUMN,
    width: style.width,
  });
}

function openedIn(entry: PlannedTab, tab: OpenedTab | null): string {
  if (entry.target === 'oldWorkspace') {
    const surface =
      tab?.surfaceId == null ? '' : `; the new tab is ${tab.surfaceId}`;
    return `a new tab of its old workspace ${entry.workspaceId}${surface}`;
  }
  const made =
    tab?.workspaceId == null ? '' : `; the new workspace is ${tab.workspaceId}`;
  return `a new workspace: its old workspace ${entry.workspaceId} is gone${made}`;
}

export function renderRestoreFailed(
  rec: RestoreFailedRecord,
  now: Date,
  style: OutputStyle,
  recordPath: string | null,
): string {
  const header = (text: string, emoji: string): string =>
    sectionHeader(text, {color: style.color, emoji});
  const blocks: string[] = [
    header(
      'thread open --restore-failed: sessions whose cmux restore failed',
      '💥',
    ),
    fieldLines(
      [
        {
          label: 'Mode',
          value: rec.dryRun
            ? 'dry run: nothing opened, no record written'
            : 'opening',
        },
        {
          label: 'Repo',
          value:
            rec.filters.repos.length === 0
              ? 'every repo (--repo <name> narrows it)'
              : rec.filters.repos.join(', '),
        },
        {
          label: 'Limit',
          value:
            rec.filters.limit == null
              ? 'none (--limit <n> opens at most n)'
              : `at most ${rec.filters.limit}, newest first`,
        },
        {
          label: 'Failed tabs',
          value:
            'left as they are: never typed into, sent to or closed (the new tab opens beside each one)',
        },
        {
          label: 'Live sessions',
          value: `${rec.liveSessionsFound} found (ps, the cmux hook store, the status line of every Claude pane)`,
        },
        ...(recordPath == null
          ? []
          : [{label: 'Record', value: tildeText(recordPath)}]),
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  ];
  const groups: {target: TabTarget; title: string}[] = [
    {
      target: 'oldWorkspace',
      title: rec.dryRun
        ? 'Would open as a new tab of its old workspace'
        : 'Opened as a new tab of its old workspace',
    },
    {
      target: 'newWorkspace',
      title: rec.dryRun
        ? 'Would open in a new workspace (its old one is gone)'
        : 'Opened in a new workspace (its old one is gone)',
    },
  ];
  for (const group of groups) {
    const entries = rec.planned.flatMap((entry) => {
      if (entry.target !== group.target) return [];
      const tab =
        rec.tabs.find((item) => item.sessionId === entry.sessionId) ?? null;
      if (!rec.dryRun && tab?.openedAt == null) return [];
      return [{entry, tab}];
    });
    blocks.push(header(`${group.title} (${entries.length})`, '🪟'));
    blocks.push(
      entries.length === 0
        ? prose('None.', style)
        : spacedList(
            entries.map(({entry, tab}) =>
              block(
                entry.name,
                [
                  {label: 'Repo', value: entry.repo ?? 'unknown'},
                  {
                    label: 'Last activity',
                    value: activityWords(entry.lastActivityAt, now),
                  },
                  {label: 'Checkout', value: tildeText(entry.checkout)},
                  {label: 'Opens in', value: openedIn(entry, tab)},
                  {label: 'Failed tab', value: entry.failedTabId},
                  ...(tab?.idProblem == null
                    ? []
                    : [{label: 'Why', value: tab.idProblem}]),
                ],
                style,
              ),
            ),
          ),
    );
  }
  if (rec.lateLive.length > 0) {
    blocks.push(
      header(`Started elsewhere while this ran (${rec.lateLive.length})`, '✅'),
    );
    blocks.push(
      spacedList(
        rec.lateLive.map((entry) =>
          block(
            entry.name,
            [
              {
                label: 'Why',
                value: `a claude process (pid ${entry.pid}) started on it after the plan, so it was not opened again`,
              },
            ],
            style,
          ),
        ),
      ),
    );
  }
  if (rec.skipped.length > 0) {
    blocks.push(header(`Skipped (${rec.skipped.length})`, '⏭️'));
    blocks.push(
      spacedList(
        rec.skipped.map((entry) =>
          block(
            entry.name,
            [
              {
                label: 'Last activity',
                value: activityWords(entry.lastActivityAt, now),
              },
              {label: 'Why', value: entry.reason},
            ],
            style,
          ),
        ),
      ),
    );
  }
  if (rec.cannotTell.length > 0) {
    blocks.push(header(`Cannot tell (${rec.cannotTell.length})`, '❓'));
    blocks.push(
      prose(
        `${rec.cannotTell.length} live Claude ${rec.cannotTell.length === 1 ? 'process' : 'processes'} could not be matched to a session, so ${rec.cannotTell.length === 1 ? 'it' : 'each'} may already hold one of the sessions above. thread open --dry-run lists them.`,
        style,
      ),
    );
  }
  if (rec.failures.length > 0) {
    blocks.push(header(`Failed (${rec.failures.length})`, '🛑'));
    blocks.push(
      spacedList(rec.failures.map((text) => prose(`- ${text}`, style))),
    );
  }
  const notes: string[] = [];
  if (rec.refused != null) notes.push(`⚠️ ${rec.refused}`);
  if (rec.dryRun && rec.planned.length > 0 && rec.refused == null) {
    notes.push('Run it again without --dry-run to open them.');
  }
  for (const note of notes) {
    blocks.push(
      wrapHanging(note, {
        hang: HEADER_COLUMN,
        indent: HEADER_COLUMN,
        width: style.width,
      }),
    );
  }
  return spacedList(blocks);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface RestoreFailedDeps {
  checkoutExists: (path: string) => boolean;
  /** F21: is a claude process holding this session NOW (ps argv)? */
  lateLive: LateLiveCheck;
  /** The process id written into the run lock. */
  pid: number;
  readFailedRestores: () => Promise<FailedRestoresRead>;
  readLive: () => Promise<LiveSessions>;
  readTree: () => Promise<CmuxTreeRead>;
  run: CmuxRunner;
  writeRecord: JsonWriter;
}

/** Exit 0 opened (or nothing to open, or a dry run) · 1 a step failed · 2 refused. */
export interface RestoreFailedResult {
  exitCode: 0 | 1 | 2;
  output: string;
  record: RestoreFailedRecord | null;
  recordPath: string | null;
}

function refuse(text: string): RestoreFailedResult {
  return {
    exitCode: 2,
    output: `thread open --restore-failed: refused: ${text}`,
    record: null,
    recordPath: null,
  };
}

/** The flags that make no sense here, by name, when set. */
function conflictingFlags(options: OpenOptions): string[] {
  return [
    options.undo ? '--undo' : null,
    options.run == null ? null : '--run',
    options.list === true ? '--list' : null,
    options.includeOpen === true ? '--include-open' : null,
    options.perProject ? '--per-project' : null,
    options.include.length > 0 ? '--include' : null,
    options.includeUntracked ? '--include-untracked' : null,
    options.since == null ? null : '--since',
    options.days == null ? null : '--days',
  ].filter((flag): flag is string => flag != null);
}

/** The real sessions: the inbox with the restart record joined, its `restoreFailed` group. */
async function realFailedRestores(
  cwd: string,
  env: EnvLike,
  now: Date,
): Promise<FailedRestoresRead> {
  const read = await readInbox({
    beforeRestart: realBeforeRestartReader(env),
    cwd,
    days: INBOX_DEFAULT_DAYS,
    env,
    keepBeforeRestart: true,
    lookupPanes: async () => await lookupPanes(realPaneSources(env)),
    now,
    repo: null,
  });
  if (read.kind === 'failed') return read;
  if (!read.read.beforeRestart.ok) {
    return {
      kind: 'failed',
      reason: `what was open before the last restart could not be read: ${read.read.beforeRestart.reason}`,
    };
  }
  const group = beforeRestartGroups(read.read).find(
    (entry) => entry.state === 'restoreFailed',
  );
  return {
    kind: 'read',
    sessions: (group?.entries ?? []).map((entry) => ({
      // A folded untracked line stands for several sessions: this one's id.
      candidate:
        entry.row == null
          ? null
          : {...candidateOf(entry.row), sessionId: entry.sessionId},
      sessionId: entry.sessionId,
      tabId: entry.fact.tab.id,
      workspaceId: entry.fact.tab.workspaceId,
    })),
  };
}

function firstLine(call: CmuxCall): string {
  return call.kind === 'failed'
    ? call.reason
    : (call.stdout.trim().split('\n')[0] ?? '');
}

function surfacesOf(tree: CmuxTree, workspaceId: string): string[] {
  const want = workspaceId.toUpperCase();
  for (const window of tree.windows) {
    for (const workspace of window.workspaces) {
      if (workspace.id.toUpperCase() === want) return workspace.surfaceIds;
    }
  }
  return [];
}

function allIds(tree: CmuxTree): {surfaces: string[]; workspaces: string[]} {
  const workspaces = tree.windows.flatMap((window) => window.workspaces);
  return {
    surfaces: workspaces.flatMap((entry) =>
      entry.surfaceIds.map((id) => id.toUpperCase()),
    ),
    workspaces: workspaces.map((entry) => entry.id.toUpperCase()),
  };
}

export async function openRestoreFailed(
  options: OpenOptions,
  deps: Partial<RestoreFailedDeps> = {},
): Promise<RestoreFailedResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const style = options.style ?? outputStyle(process.stdout);

  // ---- 1. refusals: nothing is read or written before these pass ----
  const conflicts = conflictingFlags(options);
  if (conflicts.length > 0) {
    return refuse(
      `${conflicts.join(', ')} ${conflicts.length === 1 ? 'does' : 'do'} not go with --restore-failed: the restart record decides which sessions open (every one whose cmux restore failed, whatever its age), and each opens where it was. --repo, --limit, --force-unplaced, --dry-run and --json apply.`,
    );
  }
  const limit = parseLimit(options.limit ?? null);
  if (limit.kind === 'bad') return refuse(limit.reason);
  const repos = repoValues(options.repos ?? []);
  if (options.repos != null && repos.length === 0) {
    return refuse(
      '--repo was passed but names no repo; give a repo folder name or project tag, or leave --repo off for every repo.',
    );
  }

  // ---- 2. cmux: the socket, then a ping (respawn.ts rules) ----
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return refuse(
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const run = deps.run ?? realCmuxRunner(undefined, cmuxEnv);
  const ping = await run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    return refuse(
      `cmux cannot be reached: ${ping.reason}\nIf this session is sandboxed, the sandbox blocks the cmux socket: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`,
    );
  }

  // ---- F21: one real run at a time (thread open's lock) ----
  const lockPath = openLockPath(env);
  const pid = deps.pid ?? process.pid;
  if (!options.dryRun) {
    const lock = takeOpenLock(lockPath, now, pid);
    if (lock.kind !== 'taken') {
      return refuse(
        lock.kind === 'held'
          ? lock.reason
          : `the run lock ${tildeText(lockPath)} could not be written, so nothing is opened: ${lock.reason}`,
      );
    }
  }
  try {
    // ---- 3. the sessions, which run now, and the workspaces that exist ----
    const sessions = await (
      deps.readFailedRestores ??
      (async () => await realFailedRestores(cwd, env, now))
    )();
    if (sessions.kind === 'failed') {
      return refuse(
        `the sessions whose restore failed could not be read: ${sessions.reason}`,
      );
    }
    const live = await (
      deps.readLive ??
      (async () => await readLiveSessions(realLiveSessionDeps(cmuxEnv)))
    )();
    if (live.kind === 'failed') {
      return refuse(
        `which sessions are running could not be read, so nothing is opened (a running session must never be resumed twice): ${live.reason}`,
      );
    }
    const readTree = deps.readTree ?? (async () => await readCmuxTree(run));
    const treeRead = await readTree();
    // Rule 7: an unread tree is not "every workspace is gone".
    if (treeRead.kind !== 'read') {
      return refuse(
        `the cmux tree could not be read, so whether each old workspace still exists is not known: ${treeRead.reason}`,
      );
    }
    const plan = planRestoreFailed({
      checkoutExists: deps.checkoutExists ?? existsSync,
      limit: limit.limit,
      live,
      repos,
      sessions: sessions.sessions,
      tree: treeRead.tree,
    });
    const rec: RestoreFailedRecord = {
      ...plan,
      argv: options.argv,
      at: now.toISOString(),
      dryRun: options.dryRun,
      failures: [],
      filters: {limit: limit.limit, repos},
      finishedAt: null,
      kind: 'restoreFailed',
      lateLive: [],
      refused: null,
      tabs: [],
      version: 1,
      windows: [],
    };
    if (
      plan.cannotTell.length > 0 &&
      plan.planned.length > 0 &&
      !options.forceUnplaced
    ) {
      rec.refused = `${plan.cannotTell.length} live Claude ${plan.cannotTell.length === 1 ? 'process' : 'processes'} (under Cannot tell) could not be matched to a session, so a ${options.dryRun ? 'real run would open' : 'run opens'} nothing: one of them may already hold a session above. Look at them, then pass --force-unplaced to open anyway.`;
    }
    const finish = (
      exitCode: 0 | 1 | 2,
      path: string | null,
    ): RestoreFailedResult => ({
      exitCode,
      output: options.json
        ? JSON.stringify(rec, null, 2)
        : renderRestoreFailed(rec, now, style, path),
      record: rec,
      recordPath: path,
    });
    if (options.dryRun || plan.planned.length === 0) return finish(0, null);
    if (rec.refused != null) return finish(2, null);

    // ---- 4. D-RECORD: no record, no cmux write ----
    const write = deps.writeRecord ?? writeJsonFile;
    const path = join(opensDir(env), `${recordStamp(now)}.json`);
    const firstFailure = write(path, rec, true);
    if (firstFailure != null) {
      rec.failures.push(
        `the record ${tildeText(path)} could not be written, so nothing was opened: ${firstFailure}`,
      );
      return finish(1, null);
    }
    let saveFailed = false;
    const save = (): boolean => {
      const failure = write(path, rec, false);
      if (failure != null && !saveFailed) {
        saveFailed = true;
        rec.failures.push(
          `rewriting the record ${tildeText(path)} failed, so the run stopped (what it opened so far is listed above): ${failure}`,
        );
      }
      return failure == null;
    };
    const lateLive = deps.lateLive ?? realLateLiveCheck();
    let known = allIds(treeRead.tree);

    // ---- 5. one open per session, newest first ----
    for (const entry of plan.planned) {
      // F21: ps again, right before; unreadable stops ("not live" is never assumed).
      const check = await lateLive(entry.sessionId);
      if (check.kind === 'live') {
        rec.lateLive.push({
          name: entry.name,
          pid: check.pid,
          sessionId: entry.sessionId,
        });
        if (!save()) break;
        continue;
      }
      if (check.kind === 'failed') {
        rec.failures.push(
          `ps could not be read again before opening "${entry.name}", so it and everything after it was not opened (a running session must never be resumed twice): ${check.reason}`,
        );
        break;
      }
      const tab: OpenedTab = {
        answer: null,
        args: entry.args,
        failedTabId: entry.failedTabId,
        failure: null,
        idProblem: null,
        name: entry.name,
        openedAt: null,
        sessionId: entry.sessionId,
        surfaceId: null,
        target: entry.target,
        workspaceId: entry.target === 'oldWorkspace' ? entry.workspaceId : null,
      };
      // D-RECORD: written before the call, so a run that dies right after it
      // still names the tab it may have opened.
      rec.tabs.push(tab);
      if (!save()) break;
      const call = await run(entry.args);
      const payload = call.kind === 'ok' ? parseOk(call.stdout) : null;
      if (call.kind === 'failed' || payload == null) {
        // A failed answer is no proof nothing opened (a timeout can follow
        // the work), and cmux may be overloaded: the run stops here.
        tab.failure = firstLine(call);
        rec.failures.push(
          `opening "${entry.name}" failed, and nothing after it was opened: ${tab.failure}. If cmux opened it anyway, it is ${entry.target === 'oldWorkspace' ? `a new tab in workspace ${entry.workspaceId}` : 'a new workspace'}.`,
        );
        save();
        break;
      }
      tab.answer = firstLine(call);
      tab.openedAt = new Date().toISOString();
      // The new tab's or workspace's uuid, from one read-only tree read.
      const after = await readTree();
      if (after.kind !== 'read') {
        tab.idProblem = `it opened, but the cmux tree could not be read afterwards, so its uuid is not known: ${after.reason}`;
      } else if (entry.target === 'oldWorkspace') {
        const gained = surfacesOf(after.tree, entry.workspaceId).filter(
          (id) => !known.surfaces.includes(id.toUpperCase()),
        );
        if (gained.length === 1) tab.surfaceId = gained[0] ?? null;
        else {
          tab.idProblem = `its workspace gained ${gained.length} tabs, so which one is new cannot be told`;
        }
      } else {
        const byRef = after.tree.windows
          .flatMap((window) => window.workspaces)
          .find((workspace) => workspace.ref === payload);
        const gained = after.tree.windows
          .flatMap((window) => window.workspaces)
          .filter(
            (workspace) =>
              !known.workspaces.includes(workspace.id.toUpperCase()),
          );
        tab.workspaceId = CMUX_UUID.test(payload)
          ? payload
          : (byRef?.id ??
            (gained.length === 1 ? (gained[0]?.id ?? null) : null));
        if (tab.workspaceId == null) {
          tab.idProblem = `it opened as ${payload}, but its workspace uuid could not be read, so --undo will not close it`;
        } else {
          // home-base-ys9t7.9.1 B3: the name is the tool's.
          const recorded = recordSdkWorkspaceName({
            beadId: entry.sessionBeadId,
            env,
            name: entry.name,
            repo: entry.repo,
            sessionId: entry.sessionId,
            setBy: 'open',
            workspaceId: tab.workspaceId,
          });
          if (recorded.kind === 'failed') {
            rec.failures.push(
              `"${entry.name}" opened, but its name was NOT recorded as the tool's: ${recorded.error}`,
            );
          }
        }
      }
      if (after.kind === 'read') known = allIds(after.tree);
      if (!save()) break;
    }
    rec.finishedAt = new Date().toISOString();
    save();
    return finish(rec.failures.length === 0 ? 0 : 1, path);
  } finally {
    if (!options.dryRun) releaseOpenLock(lockPath, pid);
  }
}

export async function runRestoreFailed(options: OpenOptions): Promise<number> {
  const result = await openRestoreFailed(options);
  if (result.exitCode === 2 && result.record == null) {
    console.error(result.output);
    return result.exitCode;
  }
  await writeStdout(`${result.output}\n`);
  return result.exitCode;
}
