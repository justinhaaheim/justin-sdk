/**
 * The session side of workspace naming (home-base-j8q3e.5.1): find the
 * session, read the knob, call syncWorkspaceName, and say what happened. Used
 * by `thread workspace-name`, by `thread request` / `thread title` (one soft
 * line, never an exit-code change, D4 b) and by the capture child (D4 a).
 */

import type {CmuxRunner} from './cmux';
import type {ChainRequestReaders} from './overarching';
import type {EnvLike} from './paths';
import type {TabTitleOutcome} from './tab-title';
import type {
  DescriptionReaders,
  WorkspaceDescriptionOutcome,
} from './workspace-description';
import type {
  OwnerLabelsRead,
  WorkspaceSession,
  WorkspaceSyncOutcome,
} from './workspace-name';
import type {PreviewSession} from './workspace-name-preview';

import {execFileSync} from 'node:child_process';
import {basename, dirname} from 'node:path';

import {brShow, describeBrFailed, findBeadsWorkspace} from '../beads/br';
import {outputStyle} from '../cli-style';
import {readCmuxTree, realCmuxRunner} from './cmux';
import {resolveRepoTag} from './config';
import {realChainViewReaders} from './handoff-view';
import {
  chainRequestList,
  pickOverarching,
  readChainRequests,
  realChainRequestReaders,
} from './overarching';
import {
  labelValue,
  resolveSession,
  SESSION_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {readSessionSightings} from './session-index';
import {readShortLabel} from './short-label';
import {describeTabTitle, syncTabTitle} from './tab-title';
import {
  describeWorkspaceDescription,
  realDescriptionReaders,
  syncWorkspaceDescription,
} from './workspace-description';
import {
  describeWorkspaceSync,
  resolveWorkspace,
  restoreWorkspaceNames,
  syncWorkspaceName,
} from './workspace-name';
import {
  previewWorkspaceNames,
  renderWorkspaceNamePreview,
} from './workspace-name-preview';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionLookup =
  | {kind: 'failed'; reason: string}
  | {
      /**
       * The beads DB holding the session bead (home-base-ys9t7.9.1 B4: the
       * capture child refreshes its cmux labels there). Absent from a lookup
       * a test builds by hand.
       */
      db?: string;
      kind: 'found';
      session: WorkspaceSession;
    };

/** The repo name the session model uses: the git common dir's checkout. */
function repoOfCheckout(root: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']},
    ).trim();
    if (commonDir === '') return null;
    return basename(
      basename(commonDir) === '.git' ? dirname(commonDir) : commonDir,
    );
  } catch {
    return null;
  }
}

/**
 * The repo name of a session, as workspace naming has always taken it: the
 * newest sighting from its own beads dir that names one, else the checkout's
 * git common dir. Shared with thread handoff's successor name
 * (home-base-mbnjv.3 item 6), so both resolve the same repo tag.
 */
export function sessionRepoOf(input: {
  beadsDir: string;
  checkoutPath: string;
  sightings: readonly {beadsDir: string; repo: string | null}[];
}): string | null {
  return (
    [...input.sightings]
      .reverse()
      .find((entry) => entry.beadsDir === input.beadsDir && entry.repo != null)
      ?.repo ?? repoOfCheckout(input.checkoutPath)
  );
}

/**
 * home-base-mbnjv.3 (C7): a sticky owner's labels, for the name transfer.
 * The sessions index first, then the cwd's beads DB.
 */
export function realOwnerLabels(input: {
  cwd: string;
  env: EnvLike;
}): (beadId: string) => OwnerLabelsRead {
  const readers = realChainViewReaders(input);
  return (beadId) => {
    const read = readers.showBead(beadId);
    return read.kind === 'found'
      ? {kind: 'found', labels: read.bead.labels}
      : {kind: 'failed', reason: read.reason};
  };
}

/**
 * home-base-mbnjv.3 item 5: tab titles need nameWorkspaces AND
 * handoff.successor on in the session's checkout (tab-title.ts header).
 */
async function namingKnobs(
  cwd: string,
  env: EnvLike,
): Promise<{nameWorkspaces: boolean; tabTitles: boolean}> {
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  return {
    nameWorkspaces: config.nameWorkspaces,
    tabTitles: config.nameWorkspaces && config.handoff.successor,
  };
}

/**
 * A session by its session id (through the sessions index), or by its session
 * bead's id (looked up in the cwd's beads DB).
 */
export function lookupWorkspaceSession(input: {
  cwd: string;
  env: EnvLike;
  session: string;
}): SessionLookup {
  const {cwd, env} = input;
  const wanted = input.session.trim();
  if (UUID.test(wanted)) {
    const resolution = resolveSession({env, sessionId: wanted});
    if (resolution.kind !== 'found') {
      return {
        kind: 'failed',
        reason:
          resolution.kind === 'checkoutMissing'
            ? `the session's checkout ${resolution.checkoutPath} is gone`
            : resolution.reason,
      };
    }
    const sightings = readSessionSightings(wanted, env);
    const repo = sessionRepoOf({
      beadsDir: resolution.beadsDir,
      checkoutPath: resolution.checkoutPath,
      sightings: sightings.kind === 'read' ? sightings.sightings : [],
    });
    return {
      db: resolution.db,
      kind: 'found',
      session: {
        beadId: resolution.bead.id,
        labels: resolution.bead.labels,
        repo,
        repoTag: resolveRepoTag({
          checkout: resolution.checkoutPath,
          env,
          repo,
        }),
        sessionId: wanted,
        title: resolution.bead.title,
      },
    };
  }
  const space = findBeadsWorkspace(cwd);
  if (space.kind !== 'found') {
    return {
      kind: 'failed',
      reason: `${wanted} is not a session id, and the current directory has no beads DB to look it up in (${space.reason})`,
    };
  }
  const shown = brShow({db: space.db, env}, wanted);
  if (shown.kind === 'notFound') {
    return {kind: 'failed', reason: `${wanted} is not in ${space.db}`};
  }
  if (shown.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: `could not look up ${wanted}: ${describeBrFailed(shown)}`,
    };
  }
  if (!shown.issue.labels.includes(SESSION_LABEL)) {
    return {
      kind: 'failed',
      reason: `${wanted} is not a session bead (no ${SESSION_LABEL} label)`,
    };
  }
  const repo = repoOfCheckout(space.root);
  return {
    db: space.db,
    kind: 'found',
    session: {
      beadId: shown.issue.id,
      labels: shown.issue.labels,
      repo,
      repoTag: resolveRepoTag({checkout: space.root, env, repo}),
      sessionId: labelValue(shown.issue.labels, SID_LABEL_PREFIX),
      title: shown.issue.title,
    },
  };
}

/**
 * home-base-jm5kg.18: with componentConfig.thread.workspaceDescription on in
 * `cwd`, the lookup's session gets its overarching request's short label for
 * the name (measured, or the reason it could not be read, which then names
 * nothing). Off, or a failed lookup: returned as it was. `readers` is for tests.
 */
export async function withOverarchingShort(
  lookup: SessionLookup,
  input: {
    cwd: string;
    env: EnvLike;
    readers?: ChainRequestReaders;
  },
): Promise<SessionLookup> {
  if (lookup.kind !== 'found') return lookup;
  const {resolveThreadConfig} = await import('./config');
  const {workspaceDescription} = resolveThreadConfig({
    cwd: input.cwd,
    env: input.env,
  });
  if (!workspaceDescription) return lookup;
  const {session} = lookup;
  const read = readChainRequests(
    {id: session.beadId, labels: session.labels, title: session.title},
    input.readers ?? realChainRequestReaders({cwd: input.cwd, env: input.env}),
  );
  if (read.kind === 'failed') {
    return {
      ...lookup,
      session: {
        ...session,
        overarchingShort: {ok: false, reason: read.reason},
      },
    };
  }
  const {overarching} = pickOverarching(chainRequestList(read));
  return {
    ...lookup,
    session: {
      ...session,
      overarchingShort: {
        ok: true,
        value: overarching == null ? null : readShortLabel(overarching.labels),
      },
    },
  };
}

async function nameWorkspacesKnob(cwd: string, env: EnvLike): Promise<boolean> {
  const {resolveThreadConfig} = await import('./config');
  return resolveThreadConfig({cwd, env}).nameWorkspaces;
}

const SANDBOX_REFUSAL = /Operation not permitted|\bEPERM\b|\berrno 1\b/u;

/**
 * home-base-jm5kg.20: what follows a name that was not set. On 2026-11-03 a
 * session read a bare "the next prompt will set it" as self-healing and did not
 * re-run a command the sandbox had refused, so a refused socket says so first.
 */
export function withRetryAdvice(line: string): string {
  return SANDBOX_REFUSAL.test(line)
    ? `${line}; the Claude Code sandbox is the likely cause: re-run this same command with the sandbox off. Otherwise the next prompt will set it`
    : `${line}; the next prompt will set it`;
}

/**
 * home-base-p05kz.3 item 6: the one failure that prints nothing. cmux's own
 * text when the Claude Code sandbox refuses its socket, on the first cmux call
 * of a sync, before any record is written. The capture hook runs outside the
 * sandbox and repeats both syncs on every prompt and every Stop, so the name
 * is set then; capture.jsonl held no such failure in 1,079 sync records
 * (2026-11-06). This overrides the retry advice of home-base-jm5kg.20 for this
 * exact text only. A rename that failed is never this case: its record is
 * already written, so a later sync does not simply start again.
 */
const REFUSED_SOCKET =
  /Failed to connect to socket at .+ \(Operation not permitted, errno 1\)/u;

export function isRefusedSocket(reason: string): boolean {
  return !reason.startsWith('the rename failed') && REFUSED_SOCKET.test(reason);
}

/**
 * The soft follow-up of `thread request` and `thread title` (D4 b): one line
 * for a person when something was done or could not be, or null when there is
 * nothing to say (knob off, not in cmux, already right). Never throws.
 */
export async function workspaceNameFollowUp(input: {
  cwd: string;
  env: EnvLike;
  run?: CmuxRunner;
  sessionId: string;
}): Promise<string | null> {
  try {
    const knobs = await namingKnobs(input.cwd, input.env);
    if (!knobs.nameWorkspaces) return null;
    const lookup = lookupWorkspaceSession({
      cwd: input.cwd,
      env: input.env,
      session: input.sessionId,
    });
    if (lookup.kind === 'failed') {
      return withRetryAdvice(`workspace name not set: ${lookup.reason}`);
    }
    const named = await withOverarchingShort(lookup, input);
    const run = input.run ?? realCmuxRunner();
    const outcome = await syncWorkspaceName({
      enabled: true,
      env: input.env,
      readLabels: realOwnerLabels({cwd: input.cwd, env: input.env}),
      run,
      session: named.kind === 'found' ? named.session : lookup.session,
    });
    let line: string | null;
    switch (outcome.kind) {
      case 'off':
      case 'outsideCmux':
      case 'unchanged':
        line = null;
        break;
      case 'failed':
        line = isRefusedSocket(outcome.reason)
          ? null
          : withRetryAdvice(describeWorkspaceSync(outcome));
        break;
      case 'notReady':
        line = withRetryAdvice(describeWorkspaceSync(outcome));
        break;
      default:
        line = describeWorkspaceSync(outcome);
    }
    const tab = await syncTabTitle({
      enabled: knobs.tabTitles,
      env: input.env,
      run,
      session: lookup.session,
    });
    const tabLine =
      tab.kind === 'renamed'
        ? describeTabTitle(tab)
        : tab.kind === 'failed' && !isRefusedSocket(tab.reason)
          ? withRetryAdvice(describeTabTitle(tab))
          : null;
    const lines = [line, tabLine].filter(
      (entry): entry is string => entry != null,
    );
    return lines.length === 0 ? null : lines.join('\n');
  } catch (error) {
    return withRetryAdvice(`workspace name not set: ${String(error)}`);
  }
}

/** The signature of lookupWorkspaceSession, so a test can count the calls. */
export type SessionLookupFn = (input: {
  cwd: string;
  env: EnvLike;
  session: string;
}) => SessionLookup;

/**
 * The capture child's call (D4 a), after the session bead is ensured. The
 * outcome goes into capture.jsonl; nothing is printed (stdio is ignored).
 * `lookup` is the capture run's ONE lookupWorkspaceSession result, shared
 * with syncTabForCapture (home-base-mbnjv.8 F3).
 */
export async function syncWorkspaceForCapture(input: {
  cwd: string;
  enabled: boolean;
  env: EnvLike;
  lookup: SessionLookup;
  run?: CmuxRunner;
}): Promise<WorkspaceSyncOutcome> {
  if (!input.enabled) return {kind: 'off'};
  if (input.lookup.kind === 'failed') {
    return {kind: 'failed', reason: input.lookup.reason, workspaceId: null};
  }
  // home-base-jm5kg.18: the short label is the workspace sync's alone; the tab
  // title (syncTabForCapture) keeps the plain session name.
  const lookup = await withOverarchingShort(input.lookup, input);
  if (lookup.kind === 'failed') {
    return {kind: 'failed', reason: lookup.reason, workspaceId: null};
  }
  return await syncWorkspaceName({
    enabled: true,
    env: input.env,
    readLabels: realOwnerLabels({cwd: input.cwd, env: input.env}),
    run: input.run ?? realCmuxRunner(),
    session: lookup.session,
  });
}

/**
 * The capture child's description call (home-base-jm5kg.18), after the name
 * sync, which already resolved the workspace. Null with the knob off, so a
 * knob-off run records nothing new and makes no call. Its outcome goes into
 * capture.jsonl as `workspaceDescription`.
 */
export async function syncDescriptionForCapture(input: {
  cwd: string;
  env: EnvLike;
  lookup: SessionLookup;
  nameOutcome: WorkspaceSyncOutcome | null;
  readers?: DescriptionReaders;
  run?: CmuxRunner;
}): Promise<null | WorkspaceDescriptionOutcome> {
  const {cwd, env, lookup, nameOutcome} = input;
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  if (!config.nameWorkspaces || !config.workspaceDescription) return null;
  if (lookup.kind === 'failed') {
    return {kind: 'failed', reason: lookup.reason, workspaceId: null};
  }
  if (nameOutcome == null) {
    return {
      kind: 'failed',
      reason: 'the workspace name sync did not run',
      workspaceId: null,
    };
  }
  if (nameOutcome.kind === 'outsideCmux') return {kind: 'outsideCmux'};
  if (nameOutcome.kind === 'notReady') {
    return {kind: 'notReady', reason: nameOutcome.reason};
  }
  if (nameOutcome.kind === 'off') {
    return {
      kind: 'failed',
      reason: 'the workspace name sync was off, so the workspace is not known',
      workspaceId: null,
    };
  }
  if (nameOutcome.workspaceId == null) {
    return {
      kind: 'failed',
      reason: `the workspace is not known: ${describeWorkspaceSync(nameOutcome)}`,
      workspaceId: null,
    };
  }
  return await syncWorkspaceDescription({
    enabled: true,
    env,
    readers: input.readers ?? realDescriptionReaders({cwd, env}),
    run: input.run ?? realCmuxRunner(),
    session: lookup.session,
    workspaceId: nameOutcome.workspaceId,
  });
}

/**
 * `thread workspace-name --description`: the description alone, the name left
 * as it is. A dry run prints the text it would write and works with the knob
 * off.
 */
async function runWorkspaceDescription(input: {
  cwd: string;
  dryRun: boolean;
  env: EnvLike;
  run: CmuxRunner;
  sessionRef: string;
  workspace: string | null;
}): Promise<number> {
  const {cwd, dryRun, env, run} = input;
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  if (!dryRun && (!config.nameWorkspaces || !config.workspaceDescription)) {
    console.error(
      'thread workspace-name --description: componentConfig.thread.nameWorkspaces and workspaceDescription are not both true here, so nothing is written. --dry-run shows what it would do.',
    );
    return 1;
  }
  const lookup = lookupWorkspaceSession({cwd, env, session: input.sessionRef});
  if (lookup.kind === 'failed') {
    console.error(`thread workspace-name --description: ${lookup.reason}`);
    return 1;
  }
  let workspaceId = input.workspace;
  if (workspaceId == null) {
    const tree = await readCmuxTree(run);
    if (tree.kind === 'unreadable') {
      console.error(`thread workspace-name --description: ${tree.reason}`);
      return 1;
    }
    const resolved = resolveWorkspace(tree.tree, lookup.session.labels);
    if (resolved.kind !== 'workspace') {
      console.error(
        `thread workspace-name --description: ${resolved.kind === 'none' ? 'this session is not in cmux' : resolved.reason}`,
      );
      return 1;
    }
    workspaceId = resolved.workspaceId;
  }
  const outcome = await syncWorkspaceDescription({
    dryRun,
    enabled: true,
    env,
    readers: realDescriptionReaders({cwd, env}),
    run,
    session: lookup.session,
    workspaceId,
  });
  const line = describeWorkspaceDescription(outcome);
  if (outcome.kind === 'failed') {
    console.error(line);
    return 1;
  }
  console.log(line);
  if (outcome.kind === 'wouldWrite' || outcome.kind === 'written') {
    console.log(outcome.to);
  }
  if (
    outcome.kind === 'written' &&
    (outcome.readback.kind === 'failed' ||
      (outcome.readback.description ?? '') !== outcome.to)
  ) {
    return 1;
  }
  return 0;
}

/**
 * The capture child's tab-title call (home-base-mbnjv.3 item 5), after the
 * workspace sync; its outcome goes into capture.jsonl as `tabTitle`.
 * home-base-mbnjv.8 F3: it takes the workspace sync's lookup instead of
 * repeating it (a br read and a git rev-parse on every prompt). The sync
 * writes only the workspace-names record and cmux, never the session bead,
 * so the labels and title it read are still the bead's.
 */
export async function syncTabForCapture(input: {
  cwd: string;
  env: EnvLike;
  lookup: SessionLookup;
  run?: CmuxRunner;
}): Promise<TabTitleOutcome> {
  const knobs = await namingKnobs(input.cwd, input.env);
  if (!knobs.tabTitles) return {kind: 'off'};
  const {lookup} = input;
  if (lookup.kind === 'failed') return {kind: 'failed', reason: lookup.reason};
  return await syncTabTitle({
    enabled: true,
    env: input.env,
    run: input.run ?? realCmuxRunner(),
    session: lookup.session,
  });
}

/**
 * The preview reads every session the index holds, not the inbox's window: a
 * workspace whose only session is old is still named by it on its next sync.
 */
const PREVIEW_DAYS = 3650;

/** `--all --dry-run` (D7, j8q3e.5.2): read-only, works with the knob off. */
async function runWorkspaceNamePreview(input: {
  cwd: string;
  env: EnvLike;
  run: CmuxRunner;
}): Promise<number> {
  const {env} = input;
  const {readInbox} = await import('./session-inbox');
  const inbox = await readInbox({
    cwd: input.cwd,
    days: PREVIEW_DAYS,
    env,
    now: new Date(),
    repo: null,
  });
  if (inbox.kind === 'failed') {
    console.error(
      `thread workspace-name --all --dry-run: nothing previewed: ${inbox.reason}`,
    );
    return 1;
  }
  const sessions: PreviewSession[] = [];
  const checkouts = new Map<string, string>();
  let unloaded = 0;
  for (const row of inbox.read.rows) {
    if (!row.tracked) continue;
    const bead = row.loaded?.model.beads.session ?? null;
    if (row.loaded == null || bead == null) {
      unloaded += 1;
      continue;
    }
    const {repo, repoTag} = row.loaded.model;
    sessions.push({
      beadId: bead.id,
      labels: bead.labels,
      lastActivityAt: row.lastActivityAt,
      repo,
      repoTag,
      sessionId: row.sessionId,
      title: bead.title,
    });
    if (repo != null && !checkouts.has(repo)) {
      checkouts.set(repo, row.loaded.model.git.checkout);
    }
  }
  const preview = await previewWorkspaceNames({env, run: input.run, sessions});
  if (preview.kind === 'failed') {
    console.error(
      `thread workspace-name --all --dry-run: nothing previewed: ${preview.reason}`,
    );
    return 1;
  }
  const namerRepos = [
    ...new Set(
      preview.items.flatMap((item) =>
        item.namer?.repo == null ? [] : [item.namer.repo],
      ),
    ),
  ].sort();
  const {resolveThreadConfig} = await import('./config');
  const knobs = namerRepos.map((repo) => {
    const checkout = checkouts.get(repo);
    if (checkout == null) return {repo, state: 'unknown (no checkout known)'};
    try {
      return {
        repo,
        state: resolveThreadConfig({cwd: checkout, env}).nameWorkspaces
          ? 'on'
          : 'off',
      };
    } catch (error) {
      return {repo, state: `unknown (${String(error)})`};
    }
  });
  const notes =
    unloaded === 0
      ? []
      : [
          `${unloaded} tracked session(s) could not be loaded, so they name nothing here`,
        ];
  console.log(
    renderWorkspaceNamePreview(
      {
        items: preview.items,
        knobs,
        notes,
        unreadable: preview.unreadable,
        windows: preview.windows,
      },
      outputStyle(),
    ),
  );
  return 0;
}

export interface ThreadWorkspaceNameOptions {
  /** `--all`: the preview over every open workspace; only with --dry-run. */
  all?: boolean;
  cwd?: string;
  /** `--description`: the description alone (home-base-jm5kg.18). */
  description?: boolean;
  dryRun: boolean;
  env?: EnvLike;
  restore: boolean;
  run?: CmuxRunner;
  /** `--session`: a session id or a session bead id; else $CLAUDE_CODE_SESSION_ID. */
  session: string | null;
  /** The wait between readbacks; a test passes one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  workspace: string | null;
}

/** `thread workspace-name`: print what it did or why not; return the exit code. */
export async function runThreadWorkspaceName(
  options: ThreadWorkspaceNameOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? realCmuxRunner();
  if (
    options.description === true &&
    (options.all === true || options.restore)
  ) {
    console.error(
      'thread workspace-name --description: refused with --all or --restore; it writes one workspace',
    );
    return 2;
  }
  if (options.all === true) {
    if (!options.dryRun) {
      console.error(
        'thread workspace-name --all: refused without --dry-run; workspaces are never renamed in bulk (home-base-j8q3e.5 D7)',
      );
      return 2;
    }
    return await runWorkspaceNamePreview({cwd, env, run});
  }
  if (options.restore) {
    const restored = await restoreWorkspaceNames({
      dryRun: options.dryRun,
      env,
      onlyWorkspace: options.workspace,
      run,
    });
    if (restored.kind === 'failed') {
      console.error(
        `thread workspace-name --restore: nothing restored: ${restored.reason}`,
      );
      return 1;
    }
    if (restored.items.length === 0) {
      console.log('no workspace names to restore: the record names none');
      return 0;
    }
    let failed = false;
    for (const item of restored.items) {
      if (item.kind === 'leftAlone') {
        console.log(`left alone ${item.workspaceId}: ${item.reason}`);
        continue;
      }
      const what = item.name == null ? 'clear its name' : `"${item.name}"`;
      if (item.result === 'dryRun') {
        console.log(`would restore ${item.workspaceId}: ${what}`);
      } else if (item.result === 'done') {
        console.log(`restored ${item.workspaceId}: ${what}`);
      } else {
        failed = true;
        console.error(
          `NOT restored ${item.workspaceId}: ${item.result.failed}`,
        );
      }
    }
    return failed ? 1 : 0;
  }
  const sessionRef = options.session ?? env.CLAUDE_CODE_SESSION_ID ?? null;
  if (sessionRef == null || sessionRef.trim() === '') {
    console.error(
      'thread workspace-name: no session: pass --session <id> or run it inside a Claude Code session',
    );
    return 2;
  }
  if (options.description === true) {
    return await runWorkspaceDescription({
      cwd,
      dryRun: options.dryRun,
      env,
      run,
      sessionRef,
      workspace: options.workspace,
    });
  }
  const enabled = options.dryRun || (await nameWorkspacesKnob(cwd, env));
  if (!enabled) {
    console.error(
      'thread workspace-name: componentConfig.thread.nameWorkspaces is not true here, so nothing is renamed. --dry-run shows what it would do.',
    );
    return 1;
  }
  const found = lookupWorkspaceSession({cwd, env, session: sessionRef});
  const lookup = await withOverarchingShort(found, {cwd, env});
  if (lookup.kind === 'failed') {
    console.error(`thread workspace-name: ${lookup.reason}`);
    return 1;
  }
  const outcome = await syncWorkspaceName({
    dryRun: options.dryRun,
    enabled: true,
    env,
    readLabels: realOwnerLabels({cwd, env}),
    run,
    session: lookup.session,
    sleep: options.sleep,
    workspaceId: options.workspace,
  });
  const line = describeWorkspaceSync(outcome);
  if (outcome.kind === 'failed' || outcome.kind === 'notReady') {
    console.error(line);
    return 1;
  }
  console.log(line);
  if (
    outcome.kind === 'renamed' &&
    (outcome.readback.kind === 'failed' || outcome.readback.name !== outcome.to)
  ) {
    return 1;
  }
  return 0;
}
