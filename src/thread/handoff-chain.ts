/**
 * The handoff chain behind a session, and how many handoffs in a row have
 * happened since Justin last typed in it (epic home-base-mbnjv D2, C1; built
 * by home-base-mbnjv.1 item 5). The handoff gate refuses once that count
 * reaches componentConfig.thread.handoff.maxUnattendedHandoffs, and thread
 * show (home-base-mbnjv.3) prints the chain from the same walk.
 *
 * THE CHAIN. A successor's session bead carries `continues:<predecessor
 * bead>` (session-bead.ts; written by linkContinuation). This is the first
 * reader of that label. The walk starts at the caller's bead and follows it
 * back, one chain-step.ts back step at a time (home-base-lasun.1 F1).
 *
 * ATTENDED. A session counts as attended when its message log
 * (<threads state dir>/messages/<session id>.jsonl, read only through
 * message-log.ts) holds a user line Justin typed: classifyUserLine says
 * `typed`, so neither the kickoff nor a line a machine sent (F1,
 * home-base-mbnjv.8). The first session of a chain (a bead with no
 * `continues:` label) counts as attended, unless its first user line is a
 * handoff kickoff: then it is a successor that never linked, and the walk is
 * unknown (F12). Its log is read for that, so a missing one is unknown too.
 *
 * THE COUNT is the number of handoffs since the newest attended session: 0
 * when the caller itself is attended, 2 when its predecessor's predecessor is
 * the newest attended one, and so on.
 *
 * CRITICAL RULE 7. Anything the walk needs and cannot read makes it
 * `unknown`, never 0: a bead that cannot be found or read, a bead with no
 * `sid:` label or more than one, a log that is missing or unreadable, a log
 * with malformed lines and no proof of attendance (a malformed line could have
 * been Justin's prompt), more than one `continues:` label, a loop, or a chain
 * longer than the walk's limit. The gate refuses on unknown (chainUnknown).
 */

import type {StepBead} from './chain-step';
import type {EnvLike} from './paths';

import {brShow, describeBrFailed, findBeadsWorkspace} from '../beads/br';
import {backLinkOf, stepBack} from './chain-step';
import {type MessageLogRead, readMessageLog} from './message-log';
import {KICKOFF_OPENING} from './respawn';
import {
  CONTINUES_LABEL_PREFIX,
  NOT_A_SUCCESSOR_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {locateSessionBead} from './session-handoff';

/** One session bead as the walk needs it. */
export type ChainBeadRead =
  | {kind: 'failed'; reason: string}
  | {
      kind: 'found';
      labels: readonly string[];
      /** The bead's title, when the reader has it (`thread quota` shows it). */
      title?: string;
    }
  | {kind: 'notFound'; reason: string};

/** The two readers the walk uses; injected so tests need no real state. */
export interface ChainReaders {
  readLog: (sessionId: string) => MessageLogRead;
  showBead: (beadId: string) => ChainBeadRead;
}

/** Why a link counts as attended, or that it does not. */
export type ChainAttendance =
  /** It is the first session of the chain (no `continues:` label). */
  | 'first'
  /** Its log holds a user line after its kickoff: Justin typed. */
  | 'typed'
  /** Its log holds only its kickoff. */
  | 'unattended';

export interface ChainLink {
  attendance: ChainAttendance;
  beadId: string;
  /** The `continues:` target, or null for the first session. */
  continues: string | null;
  /** From the `sid:` label; null for a first session whose label was not needed. */
  sessionId: string | null;
}

export type UnattendedChain =
  | {
      kind: 'counted';
      /** Caller first, back to (and including) the newest attended session. */
      links: ChainLink[];
      /** Handoffs in a row since the newest attended session. */
      unattendedHandoffs: number;
    }
  | {
      kind: 'unknown';
      /** The links read before the walk stopped, caller first. */
      links: ChainLink[];
      reason: string;
    };

/** A chain longer than this is reported unknown rather than walked forever. */
export const CHAIN_WALK_LIMIT = 50;

/**
 * Text that a machine sent into a session (home-base-mbnjv.8 F1). MEASURED
 * 2026-10-29 over 406 transcripts of the last 60 days and 309 message logs:
 * - Claude Code's own envelopes (origin kinds task-notification and peer:
 *   `<task-notification>`, `Another Claude session sent a message:` +
 *   `<agent-message …>` / `<cross-session-message …>`) and the /loop tick
 *   (`# Autonomous loop tick …`, isMeta) never reach the message log today:
 *   the capture strips them (stripHarnessNoise, isMeta). They are listed here
 *   so a line that slips through still does not count as typed.
 * - A message another session TYPES into the pane with cmux send arrives as
 *   origin human, promptSource typed, the same as Justin's fingers. 13 such
 *   lines are in the message logs, all `[home-base backfill, sent by
 *   home-base session <id>; Justin approved this message] …`; only their
 *   `[… sent by … session …]` opening tells them apart.
 * Any other leading `<tag` is an envelope this list does not know: not typed.
 */
const MACHINE_TEXT: readonly RegExp[] = [
  /^<[A-Za-z][\w-]*/u,
  /^Another Claude session sent a message/u,
  /^\[SYSTEM NOTIFICATION/u,
  /^\[Subagent hand-back\]/u,
  /^\[Cross-session /u,
  /^# Autonomous loop/u,
  /^\[[^\]\n]*\bsent by\b[^\]\n]*\bsession\b[^\]\n]*\]/u,
];

export type UserLineKind = 'kickoff' | 'machine' | 'typed';

/**
 * Who wrote one message-log user line: the handoff kickoff (KICKOFF_OPENING),
 * a machine (MACHINE_TEXT, or empty text: unclassifiable is not typed), or
 * Justin.
 */
export function classifyUserLine(text: string): UserLineKind {
  const trimmed = text.trim();
  if (trimmed.startsWith(KICKOFF_OPENING)) return 'kickoff';
  if (trimmed === '') return 'machine';
  if (MACHINE_TEXT.some((pattern) => pattern.test(trimmed))) return 'machine';
  return 'typed';
}

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

/**
 * Walk back from `startBeadId` to the newest attended session. Reads only as
 * far as it must: a chain whose caller is attended reads one bead and one log.
 */
export function walkUnattendedChain(
  startBeadId: string,
  readers: ChainReaders,
  options: {limit?: number} = {},
): UnattendedChain {
  const limit = options.limit ?? CHAIN_WALK_LIMIT;
  const links: ChainLink[] = [];
  const unknown = (reason: string): UnattendedChain => ({
    kind: 'unknown',
    links,
    reason,
  });
  // The start is read here; every predecessor through chain-step.ts's back
  // step (home-base-lasun.1 F1). This walk counts the start in its limit, so
  // the step is given limit - 1.
  if (limit <= 0) {
    return unknown(
      `the chain is longer than ${limit} sessions; the walk stopped at ${startBeadId}`,
    );
  }
  const first = readers.showBead(startBeadId);
  if (first.kind !== 'found') {
    return unknown(`session bead ${startBeadId}: ${first.reason}`);
  }
  const seen = new Set<string>([startBeadId]);
  let current = startBeadId;
  let bead: {labels: readonly string[]} = first;
  for (;;) {
    // The fork is checked from the labels before the log is read: a bead with
    // two predecessors is unknown whether or not Justin typed in it.
    const back = backLinkOf(bead.labels);
    const sids = labelsWith(bead.labels, SID_LABEL_PREFIX);
    if (back.kind === 'twoPredecessors') {
      return unknown(
        `${current} names ${back.ids.length} predecessors (${back.ids.map((id) => `${CONTINUES_LABEL_PREFIX}${id}`).join(', ')})`,
      );
    }
    const continues = back.kind === 'one' ? back.id : null;
    const [sessionId] = sids;
    if (sessionId == null || sids.length !== 1) {
      return unknown(
        sessionId == null
          ? `${current} has no ${SID_LABEL_PREFIX} label, so its message log cannot be found`
          : `${current} has ${sids.length} ${SID_LABEL_PREFIX} labels, so which message log is its own is unknown`,
      );
    }
    const log = readers.readLog(sessionId);
    if (log.kind === 'missing') {
      return unknown(
        `the message log of ${current} (session ${sessionId}) does not exist: ${log.path}`,
      );
    }
    if (log.kind === 'failed') {
      return unknown(
        `the message log of ${current} (session ${sessionId}) could not be read: ${log.path}: ${log.error}`,
      );
    }
    const userTexts = log.lines
      .filter((line) => line.role === 'user')
      .map((line) => line.text);
    if (continues == null) {
      // F12: no continues: label, yet the session began on a handoff
      // kickoff: a successor that never linked. Counting it as the first of
      // a chain would restart the count (the reassuring direction).
      // home-base-1vcgs D5: a session the pickup refused and labelled
      // not-a-successor (final) is known never to link, so it is the first
      // of a new chain and can hand off.
      if (
        userTexts[0] != null &&
        classifyUserLine(userTexts[0]) === 'kickoff' &&
        !bead.labels.includes(NOT_A_SUCCESSOR_LABEL)
      ) {
        return unknown(
          `${current} has no ${CONTINUES_LABEL_PREFIX} label but began on a handoff kickoff: a successor that never linked to its predecessor, so where its chain starts is unknown`,
        );
      }
      links.push({attendance: 'first', beadId: current, continues, sessionId});
      return {kind: 'counted', links, unattendedHandoffs: links.length - 1};
    }
    // F1: only a line Justin typed counts: not the kickoff, not a line some
    // machine sent (classifyUserLine).
    if (userTexts.some((text) => classifyUserLine(text) === 'typed')) {
      links.push({attendance: 'typed', beadId: current, continues, sessionId});
      return {kind: 'counted', links, unattendedHandoffs: links.length - 1};
    }
    if (log.failures.length > 0) {
      return unknown(
        `the message log of ${current} (session ${sessionId}) has unreadable lines, any of which could be a prompt Justin typed: ${log.failures[0] ?? ''}`,
      );
    }
    links.push({
      attendance: 'unattended',
      beadId: current,
      continues,
      sessionId,
    });
    const step = stepBack<StepBead>(
      {id: current, labels: bead.labels},
      {limit: limit - 1, seen, taken: links.length - 1},
      (beadId) => {
        const read = readers.showBead(beadId);
        return read.kind === 'found'
          ? {bead: {id: beadId, labels: read.labels}, kind: 'found'}
          : read;
      },
    );
    switch (step.kind) {
      case 'loop':
        return unknown(`the chain loops back to ${step.id}`);
      case 'next':
        current = step.id;
        bead = step.bead;
        break;
      case 'root':
      case 'twoPredecessors':
        // backLinkOf said one predecessor above, from the same labels.
        return unknown(
          `${current}'s ${CONTINUES_LABEL_PREFIX} label read differently twice`,
        );
      case 'tooLong':
        return unknown(
          `the chain is longer than ${limit} sessions; the walk stopped at ${step.id}`,
        );
      case 'unreadable':
        return unknown(`session bead ${step.id}: ${step.read.reason}`);
    }
  }
}

/**
 * The real readers: each bead is found through the sessions index first (a
 * predecessor may live in another checkout's DB, locateSessionBead), then the
 * DB of `cwd`'s beads workspace; the log through readMessageLog.
 */
export function realChainReaders(input: {
  cwd: string;
  env: EnvLike;
  /** DBs to try after the index, before `cwd`'s: the caller's own, usually. */
  fallbackDbs?: readonly string[];
}): ChainReaders {
  const {cwd, env} = input;
  const fallbacks = [...(input.fallbackDbs ?? [])];
  const space = findBeadsWorkspace(cwd);
  if (space.kind === 'found' && !fallbacks.includes(space.db)) {
    fallbacks.push(space.db);
  }
  return {
    readLog: (sessionId) => readMessageLog(sessionId, env),
    showBead: (beadId) => {
      const located = locateSessionBead(beadId, env, fallbacks);
      if (located.kind === 'failed') {
        return {kind: 'failed', reason: located.reason};
      }
      if (located.kind === 'notFound') {
        return {
          kind: 'notFound',
          reason: `not found in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
        };
      }
      const shown = brShow({db: located.db, env}, beadId);
      if (shown.kind === 'failed') {
        return {kind: 'failed', reason: describeBrFailed(shown)};
      }
      if (shown.kind === 'notFound') {
        return {kind: 'notFound', reason: `not found in ${located.db}`};
      }
      return {
        kind: 'found',
        labels: shown.issue.labels,
        title: shown.issue.title,
      };
    },
  };
}
