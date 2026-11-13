/**
 * The cmux workspace DESCRIPTION lists the requests (home-base-jm5kg.18,
 * componentConfig.thread.workspaceDescription). Justin, 2026-11-03: "putting
 * the request items in the description and leaving the title for the
 * overarching description." His example, one line per item:
 *
 *   ✅ Spend quota blocks runaway usage
 *   🔳 Improve cmux workspace naming
 *   💬💬💬 [Session] Fix zshrc issue
 *   ✅ XYZ
 *   🔳 ABC
 *
 * Since 2026-11-12 a count line comes first and unfinished requests before
 * finished ones, because cmux shows only about 12 lines of a description.
 * Justin's example: "📈 3/5 Completed", then "🔳 Item 4", "🔳 Item 5", then
 * "✅ Item 1" to "✅ Item 3". The count covers the namer's own requests; each
 * other session's block lists its open requests first too.
 *
 * WHOSE ITEMS COME FIRST: those of the chain that names the workspace. The
 * sticky owner keeps the name while its surface is open (workspace-name.ts), so
 * a second, unlinked session writing its own items first would put them under
 * the other chain's name, and the two would rewrite each other's text on every
 * prompt. With the namer first, any session in the workspace writes the same
 * text.
 *
 * NEVER BLANKS WHAT IT COULD NOT READ (critical rule 7): anything unreadable,
 * this workspace's description, the names record, a chain, the hook store, ps,
 * is `failed`, written nowhere, and the next capture tries again. A partial
 * list would claim the missing requests or sessions are not there.
 *
 * NEVER OVERWRITES HIS TEXT: a description holding any line the tool does not
 * write is his, and is left alone (`leftAlone`). The tool does not keep a copy,
 * so an overwritten one would be gone.
 */

import type {CmuxRunner} from './cmux';
import type {ChainRequestReaders, DescriptionItem} from './overarching';
import type {HookStore, Proc, SourceRead} from './pane-join';
import type {EnvLike} from './paths';
import type {WorkspaceSession} from './workspace-name';

import {homedir} from 'node:os';

import {
  clearWorkspaceDescription,
  readWorkspaceState,
  setWorkspaceDescription,
} from './cmux';
import {realChainViewReaders} from './handoff-view';
import {isSessionProc} from './live-sessions';
import {
  chainRequestList,
  descriptionItemsOf,
  pickOverarching,
  readChainRequests,
  realChainRequestReaders,
} from './overarching';
import {
  defaultHookStorePath,
  readHookStore,
  readProcesses,
  realProcessRunner,
} from './pane-join';
import {
  CMUX_SURFACE_LABEL_PREFIX,
  labelValue,
  resolveSession,
} from './session-bead';
import {cutTitle, readShortLabel} from './short-label';
import {
  newestRecordNamed,
  readWorkspaceNames,
  recordsFor,
  stickyOwner,
} from './workspace-name';

export const DONE_MARK = '✅';
export const OPEN_MARK = '🔳';
export const COUNT_MARK = '📈';
export const OTHER_SESSION_MARK = '💬💬💬 [Session]';

/** Shown for a live session with no session bead to take a title from. */
export const NO_TITLE_YET = '(no title yet)';

const READBACK_RETRIES = 10;
const READBACK_DELAY_MS = 100;

export interface OtherSessionBlock {
  items: readonly DescriptionItem[];
  title: string;
}

function itemLine(item: DescriptionItem): string {
  return `${item.done ? DONE_MARK : OPEN_MARK} ${item.label}`;
}

/** "📈 3/5 Completed": how many of the namer's own requests are done. */
export function countLine(own: readonly DescriptionItem[]): string {
  const done = own.filter((item) => item.done).length;
  return `${COUNT_MARK} ${done}/${own.length} Completed`;
}

/** Only the exact count line the tool writes, so his own 📈 text stays his. */
const COUNT_LINE = /^📈 \d+\/\d+ Completed$/u;

/**
 * The whole text, as Justin's examples have it: the count line when the namer
 * has requests, then each item in the order given (open first). Empty when
 * there is nothing.
 */
export function renderDescription(
  own: readonly DescriptionItem[],
  others: readonly OtherSessionBlock[],
): string {
  return [
    ...(own.length === 0 ? [] : [countLine(own)]),
    ...own.map(itemLine),
    ...others.flatMap((block) => [
      `${OTHER_SESSION_MARK} ${block.title}`,
      ...block.items.map(itemLine),
    ]),
  ].join('\n');
}

/**
 * Whether every line is one the tool writes. A description with any other line
 * is Justin's (measured 2026-11-06: workspace DDFA13DD holds such text; that
 * he typed it is inferred from its wording, "This is workspace description.").
 */
export function isToolDescription(text: string): boolean {
  return text
    .split('\n')
    .every(
      (line) =>
        line.trim() === '' ||
        COUNT_LINE.test(line) ||
        line.startsWith(`${DONE_MARK} `) ||
        line.startsWith(`${OPEN_MARK} `) ||
        line.startsWith(`${OTHER_SESSION_MARK} `),
    );
}

export interface SessionHere {
  sessionId: string;
  /** Epoch seconds, for a stable order; null when the store has none. */
  startedAt: number | null;
}

/**
 * The Claude sessions running on these surfaces now, oldest first. The hook
 * store is accumulative, so an entry counts only while its pid is a live claude
 * session process (pane-join's F7). After a /clear one process has two entries
 * on one surface, and the one updated last is the session it shows. The surface
 * decides, not the stored workspaceId: a tab that moved keeps its surface.
 */
export function sessionsOnSurfaces(
  store: HookStore,
  procs: readonly Proc[],
  surfaceIdsHere: readonly string[],
): SessionHere[] {
  const livePids = new Set(procs.filter(isSessionProc).map((proc) => proc.pid));
  const here = new Set(surfaceIdsHere.map((id) => id.toUpperCase()));
  const bySurface = new Map<string, SessionHere & {updatedAt: number | null}>();
  for (const [key, entry] of Object.entries(store.sessions ?? {})) {
    const surface = entry.surfaceId?.toUpperCase() ?? null;
    if (surface == null || !here.has(surface)) continue;
    if (entry.pid == null || !livePids.has(entry.pid)) continue;
    const prior = bySurface.get(surface);
    const updatedAt = entry.updatedAt ?? null;
    if (prior != null && (prior.updatedAt ?? 0) >= (updatedAt ?? 0)) continue;
    bySurface.set(surface, {
      sessionId: entry.sessionId ?? key,
      startedAt: entry.startedAt ?? null,
      updatedAt,
    });
  }
  return [...bySurface.values()]
    .map(({sessionId, startedAt}) => ({sessionId, startedAt}))
    .sort((a, b) => {
      const at = a.startedAt ?? Number.POSITIVE_INFINITY;
      const bt = b.startedAt ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at < bt ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId);
    });
}

export type WorkspaceDescriptionOutcome =
  /** The knob is off: no cmux call and no read. */
  | {kind: 'off'}
  /** The session has no real title yet, so nothing names this workspace. */
  | {kind: 'notReady'; reason: string}
  | {kind: 'outsideCmux'}
  /** Something could not be read or written; the description is as it was. */
  | {kind: 'failed'; reason: string; workspaceId: string | null}
  | {kind: 'unchanged'; workspaceId: string}
  /** It holds a line the tool does not write, so it is his. */
  | {current: string; kind: 'leftAlone'; workspaceId: string}
  | {from: string | null; kind: 'wouldWrite'; to: string; workspaceId: string}
  | {
      from: string | null;
      kind: 'written';
      /** What cmux reports after the write; a mismatch is loud, not undone. */
      readback:
        | {description: string | null; kind: 'read'}
        | {kind: 'failed'; reason: string};
      to: string;
      workspaceId: string;
    };

/** What the sync reads besides cmux; tests inject fixtures. */
export interface DescriptionReaders {
  chain: ChainRequestReaders;
  hookStore: () => SourceRead<HookStore>;
  processes: () => Promise<SourceRead<Proc[]>>;
  /** One session by its Claude session id. */
  session: (sessionId: string) =>
    | {
        bead: {id: string; labels: readonly string[]; title: string};
        kind: 'found';
      }
    | {kind: 'failed'; reason: string}
    | {kind: 'none'};
  /** One session bead by id: the sticky owner of the workspace name. */
  showBead: (beadId: string) =>
    | {
        bead: {id: string; labels: readonly string[]; title: string};
        kind: 'found';
      }
    | {kind: 'failed'; reason: string}
    | {kind: 'notFound'; reason: string};
}

export function realDescriptionReaders(input: {
  cwd: string;
  env: EnvLike;
}): DescriptionReaders {
  const {env} = input;
  const view = realChainViewReaders(input);
  return {
    chain: realChainRequestReaders(input),
    hookStore: () => readHookStore(defaultHookStorePath(env.HOME ?? homedir())),
    processes: () => readProcesses(realProcessRunner()),
    session: (sessionId) => {
      const resolved = resolveSession({env, sessionId});
      if (resolved.kind === 'found') {
        return {bead: resolved.bead, kind: 'found'};
      }
      return resolved.kind === 'failed'
        ? {kind: 'failed', reason: resolved.reason}
        : {kind: 'none'};
    },
    showBead: (beadId) => view.showBead(beadId),
  };
}

/** The overarching request's short label, else the session title, cut. */
function shortTitleOf(
  requests: Parameters<typeof pickOverarching>[0],
  sessionTitle: string,
): string {
  const {overarching} = pickOverarching(requests);
  const short = overarching == null ? null : readShortLabel(overarching.labels);
  return short ?? cutTitle(sessionTitle);
}

async function writeDescription(input: {
  from: string | null;
  run: CmuxRunner;
  to: string;
  workspaceId: string;
}): Promise<WorkspaceDescriptionOutcome> {
  const {from, run, to, workspaceId} = input;
  const call =
    to === ''
      ? await clearWorkspaceDescription(run, workspaceId)
      : await setWorkspaceDescription(run, workspaceId, to);
  if (call.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the description was not written: ${call.reason}`,
      workspaceId,
    };
  }
  // cmux applies a rename asynchronously (workspace-name.ts), so the readback
  // polls briefly before it calls a mismatch.
  const wanted = to === '' ? null : to;
  let after = await readWorkspaceState(run, workspaceId);
  for (
    let attempt = 0;
    attempt < READBACK_RETRIES &&
    after.kind === 'read' &&
    after.description !== wanted;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, READBACK_DELAY_MS));
    after = await readWorkspaceState(run, workspaceId);
  }
  return {
    from,
    kind: 'written',
    readback:
      after.kind === 'read'
        ? {description: after.description, kind: 'read'}
        : {kind: 'failed', reason: after.reason},
    to,
    workspaceId,
  };
}

export interface WorkspaceDescriptionInput {
  dryRun?: boolean;
  /** workspaceDescription and nameWorkspaces; a dry run passes true. */
  enabled: boolean;
  env: EnvLike;
  readers: DescriptionReaders;
  run: CmuxRunner;
  session: WorkspaceSession;
  workspaceId: string;
}

export async function syncWorkspaceDescription(
  input: WorkspaceDescriptionInput,
): Promise<WorkspaceDescriptionOutcome> {
  const {env, readers, run, session, workspaceId} = input;
  if (!input.enabled) return {kind: 'off'};
  const failed = (reason: string): WorkspaceDescriptionOutcome => ({
    kind: 'failed',
    reason,
    workspaceId,
  });

  const state = await readWorkspaceState(run, workspaceId);
  if (state.kind !== 'read') return failed(state.reason);

  // The namer first (this module's header).
  const names = readWorkspaceNames(env);
  if (names.kind === 'failed') return failed(names.reason);
  const owner = stickyOwner(
    newestRecordNamed(
      names.kind === 'read' ? recordsFor(names.records, workspaceId) : [],
      state.title,
    ),
    {
      beadId: session.beadId,
      surfaceId: labelValue(session.labels, CMUX_SURFACE_LABEL_PREFIX),
      surfaceIdsHere: state.surfaceIds,
    },
  );
  let head = {
    id: session.beadId,
    labels: session.labels,
    title: session.title,
  };
  if (owner != null) {
    const shown = readers.showBead(owner);
    if (shown.kind !== 'found') {
      return failed(
        `session ${owner} names this workspace, and it could not be read: ${shown.reason}`,
      );
    }
    head = shown.bead;
  }
  const headChain = readChainRequests(head, readers.chain);
  if (headChain.kind === 'failed') return failed(headChain.reason);
  const own = descriptionItemsOf({
    headTitle: head.title,
    requests: chainRequestList(headChain),
  });
  const seen = new Set(headChain.sessions.map((entry) => entry.bead.id));

  // Then every other live session here, once per chain.
  const store = readers.hookStore();
  if (!store.ok) return failed(store.reason);
  const procs = await readers.processes();
  if (!procs.ok) return failed(procs.reason);
  const others: OtherSessionBlock[] = [];
  const listed = sessionsOnSurfaces(store.value, procs.value, state.surfaceIds);
  // The writer is here even when the hook store has not seen it yet.
  const here = [...listed.map((entry) => entry.sessionId)];
  if (session.sessionId != null && !here.includes(session.sessionId)) {
    here.push(session.sessionId);
  }
  for (const sessionId of here) {
    // The writer's own bead is in hand; it never reads as a stranger to itself.
    const found: ReturnType<DescriptionReaders['session']> =
      sessionId === session.sessionId
        ? {
            bead: {
              id: session.beadId,
              labels: session.labels,
              title: session.title,
            },
            kind: 'found',
          }
        : readers.session(sessionId);
    if (found.kind === 'failed') {
      return failed(
        `session ${sessionId} is in this workspace, and it could not be read: ${found.reason}`,
      );
    }
    if (found.kind === 'none') {
      others.push({items: [], title: NO_TITLE_YET});
      continue;
    }
    if (seen.has(found.bead.id)) continue;
    const chain = readChainRequests(found.bead, readers.chain);
    if (chain.kind === 'failed') return failed(chain.reason);
    for (const entry of chain.sessions) seen.add(entry.bead.id);
    const requests = chainRequestList(chain);
    others.push({
      items: descriptionItemsOf({headTitle: found.bead.title, requests}),
      title: shortTitleOf(requests, found.bead.title),
    });
  }

  const to = renderDescription(own, others);
  const from = state.description;
  if ((from ?? '') === to) return {kind: 'unchanged', workspaceId};
  if (from != null && !isToolDescription(from)) {
    return {current: from, kind: 'leftAlone', workspaceId};
  }
  if (input.dryRun === true) {
    return {from, kind: 'wouldWrite', to, workspaceId};
  }
  return await writeDescription({from, run, to, workspaceId});
}

/** One line for a person or a log: what the sync did, or why it did nothing. */
export function describeWorkspaceDescription(
  outcome: WorkspaceDescriptionOutcome,
): string {
  const lines = (text: string): string =>
    text === '' ? 'nothing' : `${text.split('\n').length} line(s)`;
  switch (outcome.kind) {
    case 'off':
      return 'workspace description: off (componentConfig.thread.workspaceDescription is not true)';
    case 'notReady':
      return `workspace description not set: ${outcome.reason}`;
    case 'outsideCmux':
      return 'workspace description: this session is not in cmux';
    case 'failed':
      return `workspace description left as it was: ${outcome.reason}`;
    case 'unchanged':
      return `workspace description unchanged in ${outcome.workspaceId}`;
    case 'leftAlone':
      return `workspace description left alone in ${outcome.workspaceId}: it holds text the tool did not write, so it is Justin's`;
    case 'wouldWrite':
      return `would write ${lines(outcome.to)} to the description of ${outcome.workspaceId}`;
    case 'written': {
      const said =
        outcome.readback.kind === 'failed'
          ? `, and the read back failed: ${outcome.readback.reason}`
          : (outcome.readback.description ?? '') === outcome.to
            ? ''
            : ', but cmux reports different text';
      return `wrote ${lines(outcome.to)} to the description of ${outcome.workspaceId}${said}`;
    }
  }
}
