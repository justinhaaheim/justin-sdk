/**
 * `thread focus <session id | session bead id>`: bring forward the cmux tab
 * of the NEWEST session of a handoff chain, or refuse and say why (epic
 * home-base-9uzxw D-FOCUS, built by home-base-9uzxw.1 for Justin's request
 * home-base-3hkp7.2). The failure it exists for: being sent to a session that
 * has already handed off.
 *
 * FRESH READS ONLY. Every decision comes from reads taken when this runs,
 * never from a loaded inbox: the threads TUI's `f` and `o` spawn it.
 *
 * THE WALK (D-FOCUS):
 * 1. A session id is turned into its session bead through the sessions index;
 *    one with no `created` sighting is untracked (step 6).
 * 2. Forward along `continued-by:`, one fresh br read per bead. Refused: a
 *    successor that cannot be found or read (never a fall back to the old
 *    pane: that is the failure named above), two `continued-by:` labels, a
 *    loop, a chain longer than CHAIN_WALK_LIMIT.
 * 3. At the head, the other half of a link (linkContinuation writes
 *    `continues:<old>` on the new bead and `continued-by:<new>` on the old
 *    one, and either write can fail): any bead labelled `continues:<head>`,
 *    by a fresh read: the export when br confirms it holds the database's
 *    state, else `br list -l` (continuing-read.ts, home-base-9ihcl.4.1). One
 *    is followed; two are refused.
 * 4. A head whose handoff ran (its `handed-off` label or "handed off" note
 *    line, a refused or deferred handoff, or a successor's recorded pickup
 *    failure naming it) with no successor linked is refused.
 * 5. The head needs exactly one `sid:` label. Its pane comes from a fresh
 *    live lookup (pane-join.ts, as the inbox does), and only a `live` pane is
 *    focused: `cmux focus-panel --panel <surface> --workspace <workspace>`
 *    (measured 2026-10-29, handoff-predecessor.ts). `none` and `unknown`
 *    refuse and print the head's resume command. The `cmux-ws:` /
 *    `cmux-surface:` labels recorded at session start are never read: they
 *    go stale.
 * 6. An untracked session (no session bead) has no handoff records, because
 *    `thread handoff` needs a session bead: it is focused only when its pane
 *    is live, and the output says its links are not recorded.
 *
 * CRITICAL RULE 7. Every read that fails, every ambiguity and every pane that
 * is not live refuses (exit 3). Nothing but `focus-panel` is sent to cmux.
 */

import type {CmuxCall, CmuxRunner} from './cmux';
import type {TimingRecorder} from './inbox-timings';
import type {EnvLike} from './paths';
import type {PaneFact} from './session-card';

import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {BEAD_ID_SOURCE, findBeadsWorkspace} from '../beads/br';
import {writeStdout} from '../write-stdout';
import {CMUX_TIMEOUT_MS, realCmuxRunner} from './cmux';
import {continuingInDb} from './continuing-read';
import {readPickupFailure} from './handoff-auto-pickup';
import {CHAIN_WALK_LIMIT} from './handoff-chain';
import {continuedByOf, handoffStopOf} from './handoff-view';
import {inboxJsonWithTimings, startTimings} from './inbox-timings';
import {threadsStateDir} from './paths';
import {zshWord} from './respawn';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {hasHandoffNote} from './session-card';
import {locateSessionBead} from './session-handoff';
import {
  corruptSightingsNote,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';

// ---------------------------------------------------------------------------
// What the decision reads (injected, so tests need no real state)
// ---------------------------------------------------------------------------

/** One session bead, with the DB it was found in (the reverse query asks it). */
export interface FocusBead {
  db: string;
  id: string;
  labels: readonly string[];
  notes: string | null;
  title: string;
}

export type FocusBeadRead =
  | {bead: FocusBead; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; reason: string};

/** The beads labelled `continues:<head>`; `failed` is never an empty list. */
export type ContinuingRead =
  | {ids: string[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

/** What the sessions index says about one session id. */
export type SessionLookup =
  | {beadId: string; checkout: string | null; kind: 'tracked'}
  | {kind: 'failed'; reason: string}
  | {kind: 'untracked'};

/** A successor's recorded pickup failure (handoff-auto-pickup.ts). */
export interface PickupFailureEntry {
  predecessorBeadId: string;
  reason: string;
  /** The successor session whose pickup failed. */
  sessionId: string;
}

export type PickupFailuresRead =
  | {failures: PickupFailureEntry[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

export interface FocusReaders {
  /** The session's own checkout, for the resume command; null when unknown. */
  checkoutOf: (sessionId: string) => null | string;
  /**
   * The beads labelled `continues:<head>` in the head's DB (and cwd's), read
   * fresh: from the export when br confirms it is current, else by `br list
   * --all -l` (continuing-read.ts, home-base-9ihcl.4.1).
   */
  continuing: (headBeadId: string, db: string) => ContinuingRead;
  /** The sessions index: session id to session bead. */
  lookupSession: (sessionId: string) => SessionLookup;
  /** The fresh live-pane lookup for one session (pane-join.ts). */
  pane: (sessionId: string) => Promise<PaneFact>;
  /** Every recorded pickup failure under <threads state dir>/handoff-pickup/. */
  pickupFailures: () => PickupFailuresRead;
  /** Runs `cmux <args>`; called only with focus-panel. */
  run: CmuxRunner;
  /** One fresh br read of a session bead. */
  showBead: (beadId: string) => FocusBeadRead;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * home-base-9uzxw.5 F9: one machine-readable code per refusal in
 * resolveFocus, so the dashboard decides from the code and never from the
 * reason's words (rule 7). The TUI's schema reads this same list.
 */
export const FOCUS_REFUSALS = [
  'beadNotFound',
  'beadUnreadable',
  'chainTooLong',
  'handedOffUnlinked',
  'handoffStopped',
  'indexFailed',
  'loop',
  'paneLookupFailed',
  'paneNone',
  'paneUnknown',
  'pickupFailed',
  'pickupsUnreadable',
  'reverseAmbiguous',
  'reverseFailed',
  'sidAmbiguous',
  'sidMissing',
  'successorMissing',
  'successorUnreadable',
  'twoSuccessors',
] as const;

export type FocusRefusal = (typeof FOCUS_REFUSALS)[number];

/** The session the walk ended on (or stopped at), as far as it is known. */
export interface FocusHead {
  beadId: string | null;
  checkout: string | null;
  sessionId: string | null;
  title: string | null;
}

export type FocusResult =
  | {
      argv: string[];
      /** Bead ids walked, the target's first, the head's last. */
      chain: string[];
      head: FocusHead;
      kind: 'cmuxFailed';
      notes: string[];
      reason: string;
      target: string;
    }
  | {
      argv: string[];
      chain: string[];
      head: FocusHead;
      kind: 'dryRun' | 'focused';
      notes: string[];
      target: string;
    }
  | {
      chain: string[];
      /** Which refusal this is (F9). */
      code: FocusRefusal;
      head: FocusHead | null;
      kind: 'refused';
      notes: string[];
      reason: string;
      /** The head's resume command, run in its checkout; null when unknown. */
      resume: null | string;
      target: string;
    }
  | {kind: 'usage'; reason: string; target: string};

/** What `--json` prints: one object, every field present (null when not known). */
export interface FocusJson {
  argv: null | string[];
  chain: string[];
  exitCode: number;
  head: FocusHead | null;
  kind: FocusResult['kind'];
  notes: string[];
  reason: null | string;
  /** The refusal's code when `kind` is `refused`; null otherwise (F9). */
  refusal: FocusRefusal | null;
  resume: null | string;
  target: string;
}

export const FOCUS_EXIT = {
  cmuxFailed: 1,
  dryRun: 0,
  focused: 0,
  refused: 3,
  usage: 2,
} as const satisfies Record<FocusResult['kind'], number>;

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BEAD_ID = new RegExp(`^${BEAD_ID_SOURCE}$`, 'u');

/** The one cmux call this command makes (handoff-predecessor.ts, measured). */
export function focusArgv(surfaceId: string, workspaceId: string): string[] {
  return ['focus-panel', '--panel', surfaceId, '--workspace', workspaceId];
}

/**
 * home-base-9uzxw.5 F10: what on a session bead says its session handed off:
 * a `continued-by:` label, the `handed-off` label, or `thread handoff`'s note
 * line (session-card.ts's hasHandoffNote, the one definition: F2). Null when
 * it carries none. The dashboard asks this of a fresh read before it records
 * an answer.
 */
export function handedOffSignOf(bead: {
  labels: readonly string[];
  notes: string | null;
}): string | null {
  const successors = continuedByOf(bead.labels);
  if (successors.length > 0) {
    return successors
      .map((id) => `${CONTINUED_BY_LABEL_PREFIX}${id}`)
      .join(', ');
  }
  if (bead.labels.includes(HANDED_OFF_LABEL)) return HANDED_OFF_LABEL;
  if (hasHandoffNote(bead.notes)) return 'a "handed off" note';
  return null;
}

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

/** `cd '<checkout>' && claude --resume <id>`, or null without a checkout. */
export function resumeLine(
  sessionId: string,
  checkout: null | string,
): null | string {
  if (checkout == null) return null;
  return `cd ${zshWord(checkout)} && claude --resume ${sessionId}`;
}

async function focusPane(
  head: FocusHead,
  sessionId: string,
  readers: FocusReaders,
  options: {dryRun: boolean},
  walked: {
    chain: string[];
    notes: string[];
    refuse: (
      code: FocusRefusal,
      reason: string,
      head: FocusHead,
    ) => FocusResult;
    target: string;
  },
): Promise<FocusResult> {
  const {chain, notes, refuse, target} = walked;
  const who =
    head.beadId == null
      ? `session ${sessionId}`
      : `${head.beadId} (session ${sessionId})`;
  let pane: PaneFact;
  try {
    pane = await readers.pane(sessionId);
  } catch (error) {
    return refuse(
      'paneLookupFailed',
      `the live pane lookup for ${who} failed: ${error instanceof Error ? error.message : String(error)}`,
      head,
    );
  }
  if (pane.kind === 'none') {
    return refuse(
      'paneNone',
      `${who} is in no live cmux pane (none found by the pid/tty join or the status line)`,
      head,
    );
  }
  if (pane.kind === 'unknown') {
    return refuse(
      'paneUnknown',
      `${who}'s pane is unknown: ${pane.reason}. The pane recorded at its start is not used: it goes stale`,
      head,
    );
  }
  const argv = focusArgv(pane.surfaceId, pane.workspaceId);
  if (options.dryRun) {
    return {argv, chain, head, kind: 'dryRun', notes, target};
  }
  let call: CmuxCall;
  try {
    call = await readers.run(argv);
  } catch (error) {
    call = {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  if (call.kind === 'failed') {
    return {
      argv,
      chain,
      head,
      kind: 'cmuxFailed',
      notes,
      reason: call.timedOut
        ? `cmux ${argv.join(' ')} timed out, so whether the tab came forward is unknown: ${call.reason}`
        : `cmux ${argv.join(' ')} failed: ${call.reason}`,
      target,
    };
  }
  return {argv, chain, head, kind: 'focused', notes, target};
}

/** Step 6: an untracked session, focused only on a live pane. */
async function focusUntracked(
  sessionId: string,
  readers: FocusReaders,
  options: {dryRun: boolean},
  notes: string[],
): Promise<FocusResult> {
  notes.push(
    `session ${sessionId} has no session bead, so its handoff links are not recorded (thread handoff needs one): whether it handed off cannot be checked`,
  );
  const head: FocusHead = {
    beadId: null,
    checkout: readers.checkoutOf(sessionId),
    sessionId,
    title: null,
  };
  const chain: string[] = [];
  return await focusPane(head, sessionId, readers, options, {
    chain,
    notes,
    refuse: (code, reason, at) => ({
      chain,
      code,
      head: at,
      kind: 'refused',
      notes,
      reason,
      resume: resumeLine(sessionId, at.checkout),
      target: sessionId,
    }),
    target: sessionId,
  });
}

/**
 * The decision (D-FOCUS): walk, then look up the head's pane, then focus it
 * unless `dryRun`. Every refusal names the bead or session it could not
 * follow.
 */
export async function resolveFocus(
  target: string,
  readers: FocusReaders,
  options: {dryRun: boolean; limit?: number},
): Promise<FocusResult> {
  const limit = options.limit ?? CHAIN_WALK_LIMIT;
  const chain: string[] = [];
  const notes: string[] = [];
  const refuse = (
    code: FocusRefusal,
    reason: string,
    head: FocusHead | null = null,
  ): FocusResult => ({
    chain,
    code,
    head,
    kind: 'refused',
    notes,
    reason,
    resume:
      head?.sessionId == null
        ? null
        : resumeLine(head.sessionId, head.checkout),
    target,
  });

  const trimmed = target.trim();
  let startBeadId: string;
  if (SESSION_ID.test(trimmed)) {
    const found = readers.lookupSession(trimmed);
    if (found.kind === 'failed') {
      return refuse(
        'indexFailed',
        `session ${trimmed}: the sessions index could not say whether it has a session bead: ${found.reason}`,
      );
    }
    if (found.kind === 'untracked') {
      return await focusUntracked(trimmed, readers, options, notes);
    }
    startBeadId = found.beadId;
  } else if (BEAD_ID.test(trimmed)) {
    startBeadId = trimmed;
  } else {
    return {
      kind: 'usage',
      reason: `"${target}" is neither a claude session id (a uuid) nor a session bead id`,
      target,
    };
  }

  const start = readers.showBead(startBeadId);
  if (start.kind !== 'found') {
    return refuse(
      start.kind === 'notFound' ? 'beadNotFound' : 'beadUnreadable',
      `session bead ${startBeadId} ${start.kind === 'notFound' ? 'could not be found' : 'could not be read'}: ${start.reason}`,
    );
  }
  let head = start.bead;
  chain.push(head.id);
  const seen = new Set<string>([head.id]);
  for (;;) {
    const successors = continuedByOf(head.labels);
    let nextId: string;
    let via: string;
    if (successors.length > 1) {
      return refuse(
        'twoSuccessors',
        `${head.id} names ${successors.length} successors (${successors.map((id) => `${CONTINUED_BY_LABEL_PREFIX}${id}`).join(', ')}), so which session is newest is unknown`,
      );
    }
    const [forward] = successors;
    if (forward != null) {
      nextId = forward;
      via = `${head.id} names ${CONTINUED_BY_LABEL_PREFIX}${forward}`;
    } else {
      // Step 3: the half of a link that lives on the successor.
      const back = readers.continuing(head.id, head.db);
      if (back.kind === 'failed') {
        return refuse(
          'reverseFailed',
          `could not check for a session that continues ${head.id} (a half-written link): ${back.reason}`,
        );
      }
      const others = back.ids.filter((id) => id !== head.id);
      if (others.length > 1) {
        return refuse(
          'reverseAmbiguous',
          `${others.length} session beads say they continue ${head.id} (${others.map((id) => `${id} has ${CONTINUES_LABEL_PREFIX}${head.id}`).join(', ')}), so which session is newest is unknown`,
        );
      }
      const [reverse] = others;
      if (reverse == null) break;
      nextId = reverse;
      via = `${reverse} has ${CONTINUES_LABEL_PREFIX}${head.id}`;
      notes.push(
        `half-written link followed: ${reverse} has ${CONTINUES_LABEL_PREFIX}${head.id}, but ${head.id} has no ${CONTINUED_BY_LABEL_PREFIX}${reverse}`,
      );
    }
    if (seen.has(nextId)) {
      return refuse(
        'loop',
        `the handoff chain loops back to ${nextId} (${via})`,
      );
    }
    if (chain.length >= limit) {
      return refuse(
        'chainTooLong',
        `the handoff chain is longer than ${limit} sessions; the walk stopped at ${head.id}`,
      );
    }
    const next = readers.showBead(nextId);
    if (next.kind !== 'found') {
      return refuse(
        next.kind === 'notFound' ? 'successorMissing' : 'successorUnreadable',
        `${via}, but ${nextId} ${next.kind === 'notFound' ? 'could not be found' : 'could not be read'}: ${next.reason}. Its pane is not looked up, and ${head.id}'s is not used: ${head.id} handed off`,
      );
    }
    seen.add(nextId);
    chain.push(nextId);
    head = next.bead;
  }

  const sids = labelsWith(head.labels, SID_LABEL_PREFIX);
  const [onlySid] = sids;
  const sessionId = sids.length === 1 && onlySid != null ? onlySid : null;
  const headFacts: FocusHead = {
    beadId: head.id,
    checkout: sessionId == null ? null : readers.checkoutOf(sessionId),
    sessionId,
    title: head.title,
  };

  // Step 4: its handoff ran, and nothing continues it yet.
  const handedOff =
    head.labels.includes(HANDED_OFF_LABEL) || hasHandoffNote(head.notes);
  if (handedOff) {
    return refuse(
      'handedOffUnlinked',
      `${head.id} handed off, successor not linked yet: it carries no ${CONTINUED_BY_LABEL_PREFIX} label and no session bead says ${CONTINUES_LABEL_PREFIX}${head.id}`,
      headFacts,
    );
  }
  const stop = handoffStopOf(head.labels, head.notes);
  if (stop != null) {
    return refuse(
      'handoffStopped',
      `${head.id}'s handoff was ${stop.state}${stop.reason == null ? '' : ` (${stop.reason})`}: ${stop.detail}. No successor is linked`,
      headFacts,
    );
  }
  const pickups = readers.pickupFailures();
  if (pickups.kind === 'failed') {
    return refuse(
      'pickupsUnreadable',
      `could not check whether a successor tried to pick up ${head.id}'s handoff: ${pickups.reason}`,
      headFacts,
    );
  }
  const pickup = pickups.failures.find(
    (failure) => failure.predecessorBeadId === head.id,
  );
  if (pickup != null) {
    return refuse(
      'pickupFailed',
      `session ${pickup.sessionId} tried to pick up ${head.id}'s handoff and failed: ${pickup.reason}`,
      headFacts,
    );
  }

  if (sessionId == null) {
    return refuse(
      sids.length === 0 ? 'sidMissing' : 'sidAmbiguous',
      sids.length === 0
        ? `${head.id} has no ${SID_LABEL_PREFIX} label, so its session and pane are unknown`
        : `${head.id} has ${sids.length} ${SID_LABEL_PREFIX} labels (${sids.join(', ')}), so which session is its own is unknown`,
      headFacts,
    );
  }
  return await focusPane(headFacts, sessionId, readers, options, {
    chain,
    notes,
    refuse,
    target,
  });
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function focusJsonOf(result: FocusResult): FocusJson {
  const base = {
    exitCode: FOCUS_EXIT[result.kind],
    refusal: result.kind === 'refused' ? result.code : null,
    target: result.target,
  };
  switch (result.kind) {
    case 'usage':
      return {
        ...base,
        argv: null,
        chain: [],
        head: null,
        kind: result.kind,
        notes: [],
        reason: result.reason,
        resume: null,
      };
    case 'refused':
      return {
        ...base,
        argv: null,
        chain: result.chain,
        head: result.head,
        kind: result.kind,
        notes: result.notes,
        reason: result.reason,
        resume: result.resume,
      };
    case 'cmuxFailed':
      return {
        ...base,
        argv: ['cmux', ...result.argv],
        chain: result.chain,
        head: result.head,
        kind: result.kind,
        notes: result.notes,
        reason: result.reason,
        resume: null,
      };
    case 'dryRun':
    case 'focused':
      return {
        ...base,
        argv: ['cmux', ...result.argv],
        chain: result.chain,
        head: result.head,
        kind: result.kind,
        notes: result.notes,
        reason: null,
        resume: null,
      };
  }
}

function headWords(head: FocusHead): string {
  const id =
    head.beadId == null
      ? `session ${head.sessionId ?? 'unknown'}`
      : `${head.beadId} (session ${head.sessionId ?? 'unknown'})`;
  return head.title == null ? id : `${id}: "${head.title}"`;
}

/** The plain-text report, blank lines between parts (home-base terminal style). */
export function focusText(result: FocusResult): string {
  const parts: string[] = [];
  const chainLine = (chain: readonly string[]): void => {
    if (chain.length > 1) {
      parts.push(`  Handoff chain followed: ${chain.join(' → ')}`);
    }
  };
  switch (result.kind) {
    case 'usage':
      parts.push(`Usage: ${result.reason}`);
      break;
    case 'refused':
      parts.push(`Refused: ${result.reason}`);
      if (result.head != null) parts.push(`  Head: ${headWords(result.head)}`);
      chainLine(result.chain);
      if (result.resume != null) {
        parts.push(`  Resume it instead: ${result.resume}`);
      } else if (result.head?.sessionId != null) {
        parts.push(
          `  Resume: no command, because no checkout is recorded for session ${result.head.sessionId} (claude --resume finds it only from its own checkout)`,
        );
      }
      break;
    case 'cmuxFailed':
      parts.push(`Failed: ${result.reason}`);
      parts.push(`  Head: ${headWords(result.head)}`);
      chainLine(result.chain);
      break;
    case 'dryRun':
    case 'focused': {
      const command = ['cmux', ...result.argv].map(zshWord).join(' ');
      parts.push(
        result.kind === 'focused'
          ? `Focused ${headWords(result.head)}`
          : `Dry run: would focus ${headWords(result.head)}`,
      );
      chainLine(result.chain);
      parts.push(
        result.kind === 'focused'
          ? `  Ran: ${command}`
          : `  Would run: ${command}`,
      );
      break;
    }
  }
  if (result.kind !== 'usage') {
    for (const note of result.notes) parts.push(`  Note: ${note}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// The real readers
// ---------------------------------------------------------------------------

function readPickupFiles(
  names: readonly string[],
  env: EnvLike,
): PickupFailuresRead {
  const failures: PickupFailureEntry[] = [];
  for (const name of names) {
    const sessionId = name.slice(0, -'.json'.length);
    const read = readPickupFailure(sessionId, env);
    // Rule 7: an unreadable record could be the one that names this head.
    if (read != null && 'unreadable' in read) {
      return {kind: 'failed', reason: read.reason};
    }
    if (read != null) {
      failures.push({
        predecessorBeadId: read.predecessorBeadId,
        reason: read.reason,
        sessionId,
      });
    }
  }
  return {failures, kind: 'read'};
}

/** Every <threads state dir>/handoff-pickup/<session id>.json; one unreadable file fails the read. */
function readPickupFailures(env: EnvLike): PickupFailuresRead {
  const dir = join(threadsStateDir(env), 'handoff-pickup');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {failures: [], kind: 'read'};
    }
    return {
      kind: 'failed',
      reason: `${dir} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return readPickupFiles(
    names.filter((name) => name.endsWith('.json')),
    env,
  );
}

export function realFocusReaders(input: {
  cwd: string;
  env: EnvLike;
  /** Where `continuing` records whether it read the export or br list, and why. */
  timings?: TimingRecorder | null;
}): FocusReaders {
  const {cwd, env} = input;
  const space = findBeadsWorkspace(cwd);
  const cwdDb = space.kind === 'found' ? space.db : null;
  const fallbacks = cwdDb == null ? [] : [cwdDb];
  return {
    checkoutOf: (sessionId) => {
      const read = readSessionSightings(sessionId, env);
      if (read.kind !== 'read') return null;
      return sessionBeadSighting(read.sightings)?.checkoutPath ?? null;
    },
    continuing: (headBeadId, db) => {
      const dbs = [db, ...(cwdDb == null || cwdDb === db ? [] : [cwdDb])];
      const ids: string[] = [];
      for (const each of dbs) {
        // home-base-9ihcl.4.1: the export when br confirms it is current,
        // else br list (continuing-read.ts); the same ids in the same order.
        const read = continuingInDb({
          db: each,
          env,
          headBeadId,
          timings: input.timings ?? null,
        });
        if (read.kind === 'failed') {
          return {kind: 'failed', reason: read.reason};
        }
        for (const id of read.ids) {
          if (!ids.includes(id)) ids.push(id);
        }
      }
      return {ids, kind: 'read'};
    },
    lookupSession: (sessionId) => {
      const read = readSessionSightings(sessionId, env);
      if (read.kind === 'failed') {
        return {kind: 'failed', reason: `${read.path}: ${read.error}`};
      }
      if (read.kind === 'missing') return {kind: 'untracked'};
      const corrupt = corruptSightingsNote(read);
      if (corrupt != null) return {kind: 'failed', reason: corrupt};
      const created = sessionBeadSighting(read.sightings);
      if (created == null) return {kind: 'untracked'};
      return {
        beadId: created.beadId,
        checkout: created.checkoutPath,
        kind: 'tracked',
      };
    },
    pane: async (sessionId) => {
      const [{lookupPanes, realPaneSources}, {paneFactOf}] = await Promise.all([
        import('./pane-join'),
        import('./session-card'),
      ]);
      const panes = await lookupPanes(realPaneSources(env));
      // recorded: null — the cmux labels written at session start go stale.
      return paneFactOf(panes, sessionId, null);
    },
    pickupFailures: () => readPickupFailures(env),
    run: realCmuxRunner(CMUX_TIMEOUT_MS, env),
    showBead: (beadId) => {
      const located = locateSessionBead(beadId, env, fallbacks);
      if (located.kind === 'failed') {
        return {kind: 'failed', reason: located.reason};
      }
      if (located.kind === 'notFound') {
        return {
          kind: 'notFound',
          reason: `not in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
        };
      }
      // home-base-9ihcl.4: locateSessionBead found it with a fresh br show in
      // that DB; a second br show of the same bead in the same DB (as before)
      // doubled the br runs of every step of the walk and told nothing new.
      return {
        bead: {
          db: located.db,
          id: located.id,
          labels: located.labels,
          notes: located.notes,
          title: located.title,
        },
        kind: 'found',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The command (its --help text is in command.ts, beside the registration)
// ---------------------------------------------------------------------------

/**
 * home-base-9ihcl.4: each reader call timed as its own phase (named after the
 * reader and, for a bead, its id), with the processes it started, so
 * `--json`'s `timings` says where a slow `f` went. The answers are untouched.
 */
export function timedFocusReaders(
  readers: FocusReaders,
  timings: TimingRecorder | null,
): FocusReaders {
  if (timings == null) return readers;
  return {
    checkoutOf: (sessionId) =>
      timings.phase('checkout lookup', () => readers.checkoutOf(sessionId)),
    continuing: (headBeadId, db) =>
      timings.phase(`reverse links ${headBeadId}`, () =>
        readers.continuing(headBeadId, db),
      ),
    lookupSession: (sessionId) =>
      timings.phase('sessions index', () => readers.lookupSession(sessionId)),
    pane: async (sessionId) =>
      await timings.phase(
        'pane lookup',
        async () => await readers.pane(sessionId),
      ),
    pickupFailures: () =>
      timings.phase('pickup failures', () => readers.pickupFailures()),
    run: async (args) =>
      await timings.phase(
        `cmux ${args[0] ?? ''}`,
        async () => await readers.run(args),
      ),
    showBead: (beadId) =>
      timings.phase(`bead read ${beadId}`, () => readers.showBead(beadId)),
  };
}

export async function runThreadFocus(input: {
  cwd?: string;
  dryRun: boolean;
  env?: EnvLike;
  json: boolean;
  readers?: FocusReaders;
  target: string;
}): Promise<number> {
  const env = input.env ?? process.env;
  // home-base-9ihcl.4: `--json` carries a `timings` field, as `thread inbox
  // --json` does (the same record and the same splice); text output has none.
  const timings = input.json ? startTimings() : null;
  const readers = timedFocusReaders(
    input.readers ??
      realFocusReaders({cwd: input.cwd ?? process.cwd(), env, timings}),
    timings,
  );
  const result = await resolveFocus(input.target, readers, {
    dryRun: input.dryRun,
  });
  if (!input.json || timings == null) {
    await writeStdout(focusText(result));
    return FOCUS_EXIT[result.kind];
  }
  const json = `${JSON.stringify(focusJsonOf(result), null, 2)}\n`;
  const printed = inboxJsonWithTimings(json, timings.finish());
  if (printed.problem != null) console.error(printed.problem);
  await writeStdout(`${printed.text.trimEnd()}\n`);
  return FOCUS_EXIT[result.kind];
}
