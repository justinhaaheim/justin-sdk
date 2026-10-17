/**
 * `thread handoff` and the continuation links (status report v4; built by
 * home-base-vzwbj.4.4 design item 2).
 *
 *   thread handoff [--note "<what the next session must know>"] [--to <uuid>]
 *       labels the session bead `handed-off` (epic D2 step 3: the session then
 *       derives 🤝 handed off), appends `- <stamp>: handed off — <note>` to its
 *       notes, and prints a HANDOFF BLOCK to paste into the new session: the
 *       title, every request with its status and stage, the open questions,
 *       the resume command, and the one command the new session runs first.
 *       With --to, when the successor already has a session bead, the two are
 *       linked at once (`continued-by:` here, `continues:` there).
 *
 *   thread request --continues <old session bead id>   (request.ts)
 *       run IN the new session: labels its session bead `continues:<old>` and
 *       the old one `continued-by:<new>` — `linkContinuation` below.
 *
 * WHERE THE OLD BEAD IS: the sessions index names the DB that holds every
 * session bead (`created` sightings), so a predecessor in another checkout is
 * found without guessing; a bead the index does not know is looked up in the
 * new session's DB, then the current directory's. A lookup that FAILS stops
 * the link (a "not here" guess could label the wrong bead) — rule 7.
 */

import type {EnvLike} from './paths';
import type {FoundSession} from './session-select';

import {
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsDb,
  findBeadsWorkspace,
} from '../beads/br';
import {markdownItems} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {oneLine} from './ask-format';
import {renderAsks} from './ask-render';
import {absoluteWhen, statusWords, tildeText} from './part-one';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
} from './session-bead';
import {readSessionIndex, readSessionSightings} from './session-index';
import {appendNote} from './session-marks';
import {loadSession} from './session-model';
import {sessionDisplayName} from './session-name';
import {selectSession, sessionBeadsKnob} from './session-select';
import {
  deriveStatus,
  isOpen,
  openQuestions,
  stageReached,
  statusFactsOf,
} from './session-status';

// ---------------------------------------------------------------------------
// Finding a session bead's DB
// ---------------------------------------------------------------------------

type BeadLocation =
  | {db: string; kind: 'found'; title: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; searched: string[]};

/** The DB holding session bead `beadId`: the index first, then `fallbackDbs`. */
export function locateSessionBead(
  beadId: string,
  env: EnvLike,
  fallbackDbs: readonly string[],
): BeadLocation {
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${index.path}: ${index.error}`,
    };
  }
  const dbs: string[] = [];
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) {
        if (sighting.event !== 'created' || sighting.beadId !== beadId)
          continue;
        const found = findBeadsDb(sighting.beadsDir);
        if (found.kind === 'found') dbs.push(found.db);
      }
    }
  }
  for (const db of fallbackDbs) if (!dbs.includes(db)) dbs.push(db);
  for (const db of dbs) {
    const shown = brShow({db, env}, beadId);
    if (shown.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `could not look up ${beadId} in ${db}: ${describeBrFailed(shown)}`,
      };
    }
    if (shown.kind === 'ok') {
      return {db, kind: 'found', title: shown.issue.title};
    }
  }
  return {kind: 'notFound', searched: dbs};
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type LinkOutcome =
  | {
      kind: 'linked';
      newBeadId: string;
      oldBeadId: string;
      oldTitle: string;
    }
  | {kind: 'failed'; reason: string};

/**
 * Label the NEW session bead `continues:<old>` and the old one
 * `continued-by:<new>`. Both writes are attempted; a failure names which
 * label is missing, so nothing is half-linked silently.
 */
export function linkContinuation(input: {
  cwd: string;
  env: EnvLike;
  newSession: {beadId: string; db: string};
  oldBeadId: string;
}): LinkOutcome {
  const {cwd, env, newSession, oldBeadId} = input;
  if (oldBeadId === newSession.beadId) {
    return {kind: 'failed', reason: `${oldBeadId} is this session's own bead`};
  }
  const fallbacks = [newSession.db];
  const space = findBeadsWorkspace(cwd);
  if (space.kind === 'found') fallbacks.push(space.db);
  const old = locateSessionBead(oldBeadId, env, fallbacks);
  if (old.kind === 'failed') return old;
  if (old.kind === 'notFound') {
    return {
      kind: 'failed',
      reason: `${oldBeadId} was not found in ${old.searched.length > 0 ? old.searched.join(' or ') : 'any beads DB'}`,
    };
  }
  const failures: string[] = [];
  const mine = brUpdate({db: newSession.db, env}, newSession.beadId, {
    addLabels: [`${CONTINUES_LABEL_PREFIX}${oldBeadId}`],
  });
  if (mine.kind === 'failed') {
    failures.push(
      `${newSession.beadId} was NOT labelled ${CONTINUES_LABEL_PREFIX}${oldBeadId}: ${describeBrFailed(mine)}`,
    );
  }
  const theirs = brUpdate({db: old.db, env}, oldBeadId, {
    addLabels: [`${CONTINUED_BY_LABEL_PREFIX}${newSession.beadId}`],
  });
  if (theirs.kind === 'failed') {
    failures.push(
      `${oldBeadId} was NOT labelled ${CONTINUED_BY_LABEL_PREFIX}${newSession.beadId}: ${describeBrFailed(theirs)}`,
    );
  }
  if (failures.length > 0) return {kind: 'failed', reason: failures.join('; ')};
  return {
    kind: 'linked',
    newBeadId: newSession.beadId,
    oldBeadId,
    oldTitle: old.title,
  };
}

// ---------------------------------------------------------------------------
// thread handoff
// ---------------------------------------------------------------------------

export interface ThreadHandoffOptions {
  cwd?: string;
  env?: EnvLike;
  note: string | null;
  now?: Date;
  /** `--session`, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  timeZone?: string;
  /** `--to`: the successor's Claude session id. */
  to: string | null;
}

export type HandoffOutcome =
  | {
      block: string;
      /** Problems after the label was set; non-empty means exit 1. */
      followUpFailures: string[];
      kind: 'handedOff';
      /** What happened to --to: linked, waiting for the successor, or not asked. */
      successor:
        | {beadId: string; kind: 'linked'}
        | {kind: 'none'}
        | {kind: 'noBeadYet'; sessionId: string};
    }
  | {kind: 'failed'; reason: string};

/** The successor's session bead id from the index, or null when it has none yet. */
function successorBead(
  sessionId: string,
  env: EnvLike,
):
  | {beadId: string; db: string; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'} {
  const read = readSessionSightings(sessionId, env);
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${read.path}: ${read.error}`,
    };
  }
  const created =
    read.kind === 'read'
      ? read.sightings.find((sighting) => sighting.event === 'created')
      : undefined;
  if (created == null) return {kind: 'none'};
  const found = findBeadsDb(created.beadsDir);
  if (found.kind !== 'found') {
    return {
      kind: 'failed',
      reason: `the successor's beads at ${created.beadsDir} cannot be read: ${found.reason}`,
    };
  }
  return {beadId: created.beadId, db: found.db, kind: 'found'};
}

/** The block to paste into the new session (markdown: it is for pasting). */
export async function handoffBlock(input: {
  cwd: string;
  env: EnvLike;
  note: string | null;
  now: Date;
  sessionBeadId: string;
  sessionId: string;
  timeZone?: string;
}): Promise<{ok: false; reason: string} | {ok: true; text: string}> {
  const loaded = await loadSession({
    cwd: input.cwd,
    env: input.env,
    selector: null,
    sessionIdOption: input.sessionId,
  });
  if (loaded.kind !== 'loaded') {
    return {
      ok: false,
      reason: `the handoff block could not be built: ${loaded.kind === 'unreadable' ? loaded.detail : loaded.reason}`,
    };
  }
  const {model} = loaded;
  const status = deriveStatus(statusFactsOf(model), {
    asIfYielded: true,
    now: input.now,
  });
  const title = model.beads.session?.title ?? '(title unknown)';
  const fields = [
    `- **Session:** ${sessionDisplayName(model.repoTag, title)} (${input.sessionBeadId})`,
    `- **Status:** ${statusWords(status)}`,
    `- **Handed off:** ${absoluteWhen(input.now, input.timeZone)}`,
    ...(input.note == null ? [] : [`- **Note:** ${input.note}`]),
  ].join('\n');

  const requests = model.beads.requests.map((node, index) => {
    const marker = `${index + 1}. `;
    const stage = stageReached(node.request.labels, model.stages);
    const open = node.children.filter(isOpen).length;
    const lines = [
      `${marker}${isOpen(node.request) ? '🔲' : '✅'} ${node.request.title} (${node.request.id})`,
    ];
    lines.push(
      `${' '.repeat(marker.length)}**Stage:** ${stage == null ? 'none marked' : stage.next == null ? `${stage.reached} (the last stage)` : `${stage.reached} — next: ${stage.next}`}`,
    );
    if (node.children.length > 0) {
      lines.push(
        `${' '.repeat(marker.length)}**Children:** ${open} of ${node.children.length} still open`,
      );
    }
    return lines.join('\n\n');
  });
  const problems = model.beads.problems.map(
    (problem) => `⚠️ ${problem} — requests and questions there are not shown.`,
  );
  const questions = openQuestions(model);
  const blocks = [
    '🤝 **HANDOFF** — paste this into the new session',
    fields,
    ...problems,
    // Two empty lines between sibling requests and questions: Claude pastes
    // this, and Claude Code drops one (home-base-j8q3e.1.10 F7).
    requests.length === 0
      ? '**Requests:** none filed'
      : ['**Requests:**', markdownItems(requests)].join('\n\n'),
    questions.length === 0
      ? '**Open questions:** none'
      : [
          '**Open questions:**',
          renderAsks(questions, {
            itemGap: 2,
            style: {color: false, width: null},
          }),
        ].join('\n\n'),
    [
      '**To pick it up:**',
      `- First, in the new session: \`${sdkRun(`thread request --continues ${input.sessionBeadId}`)}\``,
      `- To read the old session: \`claude --resume ${input.sessionId}\` or \`${sdkRun(`thread show ${input.sessionBeadId}`)}\``,
    ].join('\n'),
  ];
  return {ok: true, text: tildeText(blocks.join('\n\n'))};
}

export async function handOff(
  options: ThreadHandoffOptions,
): Promise<HandoffOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'failed', reason: knob.reason};
  const selection = selectSession({
    env,
    selector: null,
    sessionIdOption: options.sessionId,
  });
  if (selection.kind === 'checkoutMissing') {
    return {
      kind: 'failed',
      reason: `this session's beads live in ${selection.checkoutPath}, which no longer exists (or no longer holds a beads database)`,
    };
  }
  if (selection.kind !== 'found') {
    return {kind: 'failed', reason: selection.reason};
  }
  const {session} = selection as {session: FoundSession};
  const note =
    options.note == null || oneLine(options.note) === ''
      ? null
      : oneLine(options.note);

  // ---- the label and the note: one write ----
  const written = brUpdate({db: session.db, env}, session.bead.id, {
    addLabels: [HANDED_OFF_LABEL],
    notes: appendNote(
      session.bead.notes,
      note == null ? 'handed off' : `handed off — ${note}`,
      now,
    ),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the session was NOT marked handed off: ${describeBrFailed(written)}`,
    };
  }

  // ---- --to: link now when the successor already has a bead ----
  const followUpFailures: string[] = [];
  let successor: Extract<HandoffOutcome, {kind: 'handedOff'}>['successor'] = {
    kind: 'none',
  };
  if (options.to != null && options.to.trim() !== '') {
    const next = successorBead(options.to.trim(), env);
    if (next.kind === 'failed') {
      followUpFailures.push(next.reason);
    } else if (next.kind === 'none') {
      successor = {kind: 'noBeadYet', sessionId: options.to.trim()};
    } else {
      const linked = linkContinuation({
        cwd,
        env,
        newSession: {beadId: next.beadId, db: next.db},
        oldBeadId: session.bead.id,
      });
      if (linked.kind === 'failed') followUpFailures.push(linked.reason);
      else successor = {beadId: next.beadId, kind: 'linked'};
    }
  }

  // ---- the block, from the session model read AFTER the label ----
  const block = await handoffBlock({
    cwd,
    env,
    note,
    now,
    sessionBeadId: session.bead.id,
    sessionId: session.sessionId,
    timeZone: options.timeZone,
  });
  if (!block.ok) followUpFailures.push(block.reason);
  return {
    block: block.ok ? block.text : '',
    followUpFailures,
    kind: 'handedOff',
    successor,
  };
}

export function describeHandoffOutcome(outcome: HandoffOutcome): {
  exitCode: 0 | 1;
  lines: string[];
} {
  if (outcome.kind === 'failed') {
    return {exitCode: 1, lines: [`thread handoff: ${outcome.reason}`]};
  }
  const lines: string[] = [];
  if (outcome.block !== '') lines.push(outcome.block, '');
  switch (outcome.successor.kind) {
    case 'linked':
      lines.push(
        `Linked: the successor's session bead is ${outcome.successor.beadId}.`,
      );
      break;
    case 'noBeadYet':
      lines.push(
        `The successor ${outcome.successor.sessionId} has no session bead yet: it links itself when it runs the first command above.`,
      );
      break;
    case 'none':
      break;
  }
  if (outcome.followUpFailures.length > 0) {
    lines.push(
      '⚠️ The session WAS marked handed off. But:',
      ...outcome.followUpFailures.map((failure) => `  - ${failure}`),
    );
    return {exitCode: 1, lines};
  }
  return {exitCode: 0, lines};
}

export async function runThreadHandoff(
  options: ThreadHandoffOptions,
): Promise<number> {
  const {exitCode, lines} = describeHandoffOutcome(await handOff(options));
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
