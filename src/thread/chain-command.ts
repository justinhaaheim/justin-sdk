/**
 * `thread chain [member]` (home-base-lasun L3): one handoff chain's sessions
 * in order, oldest first, from the one chain walk (chain-walk.ts). Justin,
 * 2026-11-15: "to me the term "thread" encompasses potentially multiple
 * sessions".
 *
 * Each session prints its display name (`[Scorpio-12]`), its Claude session
 * id, its session bead, when it started and when it was last active (the
 * first and newest dated line of its message log), its session bead's status,
 * and how it ended: handed off, done, archived or open.
 *
 * Also here: `chainTargetOf`, the chain-name argument `thread show` and
 * `thread focus` accept (L5).
 *
 * EXIT 0 listed · 2 could not read: the member, the chain (an incomplete
 * chain still prints what was read, under a line that says what is missing).
 */

import type {Field} from '../cli-style';
import type {ChainMember, ChainWalk, ChainWalkReaders} from './chain-walk';
import type {MessageLogRead} from './message-log';
import type {EnvLike} from './paths';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  paint,
  shouldStyle,
  terminalWidth,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';
import {writeStdout} from '../write-stdout';
import {chainNameText} from './chain-name';
import {readChainNames} from './chain-names';
import {
  realChainWalkReaders,
  registryChainNames,
  resolveChainStart,
  sessionBeadOf,
  walkChain,
} from './chain-walk';
import {continuedByOf} from './handoff-view';
import {readMessageLog} from './message-log';
import {HANDED_OFF_LABEL} from './session-bead';

/** How a session of the chain ended. */
export type ChainEnding =
  | {at: null | string; kind: 'handedOff'}
  | {kind: 'archived'}
  | {kind: 'done'}
  | {kind: 'open'};

/** One session of the listing. */
export interface ChainListingEntry {
  ending: ChainEnding;
  /** Newest dated line of its message log; null when none is dated. */
  lastActiveAt: null | string;
  /** Why the dates are unknown (no session id, no log, an unreadable log); null when they were read. */
  logProblem: null | string;
  member: ChainMember;
  /** First dated line of its message log; null when none is dated. */
  startedAt: null | string;
}

/** A session that is not the chain's last handed off by definition; the last one by its own records. */
export function chainEnding(member: ChainMember, isLast: boolean): ChainEnding {
  const handedOff =
    member.handedOffAt != null ||
    member.labels.includes(HANDED_OFF_LABEL) ||
    continuedByOf(member.labels).length > 0;
  if (!isLast || handedOff) {
    return {at: member.handedOffAt, kind: 'handedOff'};
  }
  if (member.status === 'closed') {
    return member.labels.includes('archived')
      ? {kind: 'archived'}
      : {kind: 'done'};
  }
  return {kind: 'open'};
}

/** The listing of a walk's members, each with its log's first and newest date. */
export function chainListing(
  walk: Exclude<ChainWalk, {kind: 'failed'}>,
  readLog: (sessionId: string) => MessageLogRead,
): ChainListingEntry[] {
  return walk.members.map((member, index) => {
    const ending = chainEnding(member, index === walk.members.length - 1);
    if (member.sessionId == null) {
      return {
        ending,
        lastActiveAt: null,
        logProblem: member.sessionIdProblem ?? 'it has no session id',
        member,
        startedAt: null,
      };
    }
    const log = readLog(member.sessionId);
    if (log.kind !== 'read') {
      return {
        ending,
        lastActiveAt: null,
        logProblem:
          log.kind === 'missing'
            ? `no message log at ${log.path}`
            : `its message log could not be read: ${log.error}`,
        member,
        startedAt: null,
      };
    }
    const dated = log.lines
      .map((line) => line.at)
      .filter((at): at is string => at != null)
      .sort();
    return {
      ending,
      lastActiveAt: dated.at(-1) ?? null,
      logProblem:
        dated.length === 0 ? 'no line of its message log is dated' : null,
      member,
      startedAt: dated[0] ?? null,
    };
  });
}

function whenText(at: null | string): null | string {
  if (at == null) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${formatLocalDate(date)} ${formatLocalTime(date).slice(0, 5)}`;
}

export function endingText(ending: ChainEnding): string {
  switch (ending.kind) {
    case 'handedOff':
      return ending.at == null
        ? 'handed off'
        : `handed off ${whenText(ending.at) ?? ending.at}`;
    case 'archived':
      return 'archived';
    case 'done':
      return 'done';
    case 'open':
      return 'open';
  }
}

const LABELS = [
  'Session',
  'Bead',
  'Started',
  'Last active',
  'Status',
  'Ended',
] as const;
const LABEL_WIDTH = fieldLabelWidth(
  LABELS.map((label) => ({label, value: ''})),
);

/** The listing as the terminal shows it (man-page style, one record per session). */
export function renderChainListing(
  walk: Exclude<ChainWalk, {kind: 'failed'}>,
  entries: readonly ChainListingEntry[],
  style: {color: boolean; width: null | number},
): string {
  const {color, width} = style;
  const missing = (text: string): string => paint(text, ['dim'], color);
  const name =
    walk.chainName == null
      ? `Chain of ${walk.root ?? 'an unknown first session'}`
      : `Chain ${walk.chainName}`;
  const lines: string[] = [
    '',
    wrapHanging(
      paint(
        `⛓️ ${name}: ${entries.length} session${entries.length === 1 ? '' : 's'}, oldest first`,
        ['bold'],
        color,
      ),
      {hang: BODY_COLUMN, indent: HEADER_COLUMN, width},
    ),
  ];
  if (walk.kind === 'incomplete') {
    for (const problem of walk.problems) {
      lines.push(
        '',
        wrapHanging(`⚠️ The chain is incomplete: ${problem}`, {
          hang: BODY_COLUMN,
          indent: HEADER_COLUMN,
          width,
        }),
      );
    }
  }
  entries.forEach((entry, index) => {
    const {member} = entry;
    const here = index === walk.startIndex ? ' (the session you named)' : '';
    const unknownWhen = missing(
      `unknown${entry.logProblem == null ? '' : ` (${entry.logProblem})`}`,
    );
    const fields: Field[] = [
      {
        label: 'Session',
        value:
          member.sessionId ??
          missing(member.sessionIdProblem ?? 'no session id'),
      },
      {label: 'Bead', value: member.beadId},
      {label: 'Started', value: whenText(entry.startedAt) ?? unknownWhen},
      {
        label: 'Last active',
        value: whenText(entry.lastActiveAt) ?? unknownWhen,
      },
      {label: 'Status', value: member.status ?? missing('unknown')},
      {label: 'Ended', value: endingText(entry.ending)},
    ];
    lines.push(
      '',
      wrapHanging(
        paint(`${member.name} ${member.title}${here}`, ['bold'], color),
        {
          hang: BODY_COLUMN,
          indent: HEADER_COLUMN,
          width,
        },
      ),
      fieldLines(fields, {
        color,
        indent: BODY_COLUMN,
        labelWidth: LABEL_WIDTH,
        width,
      }),
    );
  });
  return `${lines.join('\n')}\n`;
}

export interface ThreadChainOptions {
  color?: boolean;
  cwd?: string;
  env?: EnvLike;
  json?: boolean;
  /** A chain name, a session bead, or a Claude session id; null: the current session. */
  member: null | string;
  readLog?: (sessionId: string) => MessageLogRead;
  readers?: ChainWalkReaders;
  width?: null | number;
}

/** `thread chain [member]`. */
export async function runThreadChain(
  options: ThreadChainOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const json = options.json === true;
  const color = options.color ?? (json ? false : shouldStyle());
  const width =
    options.width !== undefined
      ? options.width
      : options.color === undefined
        ? terminalWidth()
        : null;
  const readers =
    options.readers ??
    realChainWalkReaders({cwd: options.cwd ?? process.cwd(), env});
  const fail = async (reason: string): Promise<number> => {
    const text = `thread chain: ${reason}`;
    if (json) {
      await writeStdout(
        `${JSON.stringify({error: text, ok: false}, null, 2)}\n`,
      );
    } else console.error(text);
    return 2;
  };

  let startBead: string;
  const named = options.member?.trim() ?? '';
  if (named === '') {
    const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() ?? '';
    if (sessionId === '') {
      return await fail(
        'no current session (CLAUDE_CODE_SESSION_ID is not set): name a chain, a session bead or a session id',
      );
    }
    const bead = sessionBeadOf(sessionId, env);
    if (bead.kind !== 'found') {
      return await fail(`this session's chain is unknown: ${bead.reason}`);
    }
    startBead = bead.beadId;
  } else {
    const start = resolveChainStart({env, readers, value: named});
    if (start.kind === 'failed') return await fail(start.reason);
    startBead = start.beadId;
  }
  const walk = walkChain(startBead, readers, {
    chainNameOfRoot: registryChainNames(env),
  });
  if (walk.kind === 'failed') {
    return await fail(`the chain could not be read: ${walk.reason}`);
  }
  const entries = chainListing(
    walk,
    options.readLog ?? ((sessionId) => readMessageLog(sessionId, env)),
  );
  if (json) {
    await writeStdout(
      `${JSON.stringify(
        {
          complete: walk.kind === 'complete',
          name: walk.chainName,
          ok: true,
          problems: walk.kind === 'incomplete' ? walk.problems : [],
          root: walk.root,
          sessions: entries.map((entry) => ({
            beadId: entry.member.beadId,
            ended: entry.ending,
            handoffNumber: entry.member.handoffNumber,
            lastActiveAt: entry.lastActiveAt,
            logProblem: entry.logProblem,
            name: entry.member.name,
            sessionId: entry.member.sessionId,
            startedAt: entry.startedAt,
            status: entry.member.status,
            title: entry.member.title,
          })),
          startIndex: walk.startIndex,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await writeStdout(renderChainListing(walk, entries, {color, width}));
  }
  return walk.kind === 'complete' ? 0 : 2;
}

// ---------------------------------------------------------------------------
// A chain name where a session is taken (L5: thread show, thread focus)
// ---------------------------------------------------------------------------

export type ChainTarget =
  | {kind: 'chain'; name: string; root: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'notAName'};

/**
 * Whether `value` is a chain name in the registry (`Scorpio`, `scorpio_ii`,
 * any case), and its first session bead. `notAName` for anything else, so a
 * bead id or session id passes through unchanged. Only a name the registry
 * holds is a chain: never a guess.
 */
export function chainTargetOf(value: string, env: EnvLike): ChainTarget {
  const trimmed = value.trim();
  if (!/^[a-z]+(?:[ _]+[ivxlcdm]+)?$/iu.test(trimmed)) {
    return {kind: 'notAName'};
  }
  const registry = readChainNames(env);
  if (registry.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${trimmed} could be a chain name, but the chain-name registry could not be read: ${registry.reason}`,
    };
  }
  const spelled = trimmed.replace(/[ _]+/gu, ' ').toLowerCase();
  const entry = registry.entries.find(
    (candidate) => chainNameText(candidate.name).toLowerCase() === spelled,
  );
  return entry == null
    ? {kind: 'notAName'}
    : {kind: 'chain', name: chainNameText(entry.name), root: entry.root};
}

/**
 * The newest session bead of the chain `value` names, for `thread show`:
 * null when `value` is not a chain name. A chain whose newest session cannot
 * be established (the walk forward stopped short) is refused with why.
 */
export function newestOfChainName(input: {
  cwd: string;
  env: EnvLike;
  readers?: ChainWalkReaders;
  value: string;
}):
  | {beadId: string; kind: 'newest'; name: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'notAName'} {
  const target = chainTargetOf(input.value, input.env);
  if (target.kind !== 'chain') return target;
  const readers =
    input.readers ?? realChainWalkReaders({cwd: input.cwd, env: input.env});
  const walk = walkChain(target.root, readers, {
    chainNameOfRoot: registryChainNames(input.env),
  });
  if (walk.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `chain ${target.name}: ${walk.reason}`,
    };
  }
  if (walk.kind === 'incomplete') {
    return {
      kind: 'failed',
      reason: `chain ${target.name} could not be read to its newest session: ${walk.problems.join('; ')}`,
    };
  }
  const newest = walk.members.at(-1);
  return newest == null
    ? {kind: 'failed', reason: `chain ${target.name} has no sessions`}
    : {beadId: newest.beadId, kind: 'newest', name: newest.name};
}
