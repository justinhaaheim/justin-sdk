/**
 * `justin-sdk thread prepare` — everything a session needs before it writes a
 * report, and nothing it has to remember (home-base-p1uj D4, D6).
 *
 * OUTPUT ORDER IS A CONTRACT. The FIRST line is always one of:
 *
 *   THREADS: DISABLED        the knob is off; the rule falls back to prose.
 *   THREADS: SANDBOX DENIED  a write probe was refused; the line names the fix.
 *   THREADS: ENABLED         go ahead.
 *
 * The rule that drives this tool branches on that line and on
 * command-not-found, so it must be first, cheap, and unconditional.
 *
 * ORDERING NOTE (an interpretation, recorded rather than assumed): the bead's
 * design says the sandbox probe runs FIRST. It runs first among the WORK — the
 * knob is still read before it. Probing (and printing SANDBOX DENIED) in a repo
 * that never turned the feature on would be noise about a feature nobody asked
 * for, and the knob read is a file read, not a write, so it cannot itself trip
 * a prompt. Disabled therefore short-circuits before the probe.
 *
 * ALWAYS EXITS 0. A preflight that can fail a session is a preflight nobody
 * runs.
 */

import type {EnvLike} from './paths';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  type OutputStyle,
  outputStyle,
  pad,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {draftPath} from './archive';
import {
  bdContext,
  checkThreadTypes,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
  REGISTER_TYPES_COMMAND,
  showIssue,
} from './bd';
import {resolveThreadConfig} from './config';
import {collectThreadFacts} from './facts';
import {collectInboxAsks, readThreadNote, renderInboxAsk} from './inbox';
import {readReportCount} from './metadata';
import {
  probeWritable,
  SANDBOX_DENIED_LINE,
  threadsBeadsDir,
  threadsBeadsMissingLine,
  threadsStateDir,
} from './paths';
import {applyPredecessor, resolvePredecessor} from './predecessor';
import {priorityLabel} from './render';
import {priorityStyles} from './render-ansi';
import {
  PAYLOAD_MUST_SEE_GUIDANCE,
  PAYLOAD_PRIORITY_GUIDANCE,
  payloadSkeleton,
} from './schema';

export interface PrepareOptions {
  /**
   * The thread this session CONTINUES (D21). Its open asks are listed under the
   * same MUST-disposition heading as the session's own, and `continuesFrom` is
   * prefilled in the printed skeleton — the two halves of making a handed-over
   * arc's asks impossible to lose.
   */
  continuesFrom?: string | null;
  /**
   * The predecessor's CLAUDE SESSION id, which is resolved to its thread bead
   * and then used exactly as `continuesFrom` would be (D18). It is what a
   * justin-loop successor can actually know about its predecessor; the runner
   * also puts it in `JUSTIN_LOOP_PREDECESSOR_SESSION_ID`, which is read when
   * neither this nor `continuesFrom` is given.
   */
  continuesFromSession?: string | null;
  cwd?: string;
  env?: EnvLike;
  sessionId?: string | null;
  /** Colour and wrap width; from stdout when absent. */
  style?: OutputStyle;
}

/**
 * The one heading both ask listings appear under.
 *
 * It used to say "every one of these MUST appear in priorAsks (D4)", and the
 * report was refused when one did not. D24 inverted that: they are closed FOR
 * you, so what this heading has to tell a session is what will happen if it says
 * nothing — which is the thing a session left to guess gets wrong.
 */
const OPEN_ASKS_HEADING =
  'OPEN ASKS — each of these CLOSES automatically when you report (D24)';

/**
 * What happens to an open ask this payload does not mention. One line per
 * point, never hand-wrapped (critical rule 14): whatever displays it wraps it.
 */
const OPEN_ASKS_POLICY: readonly string[] = [
  'Unless you say otherwise, each is closed: "decided: <the default it recorded>".',
  '· Justin ANSWERED it → priorAsks {disposition: "answered", detail: "<quote him>"}',
  '· it stopped applying → priorAsks {disposition: "irrelevant", detail: "<why>"}',
  '· it is STILL LIVE → write it again as a NEW ask with "supersedes": "<its id>" (the old one closes as superseded; asks are never edited in place)',
];

/** The one emoji each prepare section carries (K11 rule 5). */
const SECTION_EMOJI = {
  continues: '🔗',
  facts: '📎',
  note: '📝',
  openAsks: '🙋',
  predecessor: '⏮️',
  thread: '🧵',
  write: '✍️',
} as const;

/** A line at the body column, hang-wrapped on a terminal. */
function bodyLine(text: string, style: OutputStyle): string {
  return wrapHanging(text, {
    hang: BODY_COLUMN,
    indent: BODY_COLUMN,
    width: style.width,
  });
}

/**
 * One of the schema's guidance blocks, man-page style: an unindented line is a
 * header at column 2, an indented one is body at column 6 (its own leading
 * spaces replaced), and every line is one blank line from the next (K11 rule
 * 1) — the schema's own blank lines collapse into that one.
 */
function guidanceLines(lines: readonly string[], style: OutputStyle): string[] {
  return spacedList(
    lines
      .filter((line) => line.trim() !== '')
      .map((line) =>
        /^\s/u.test(line)
          ? bodyLine(line.trim(), style)
          : sectionHeader(line, {color: style.color}),
      ),
  ).split('\n');
}

/**
 * One thread's open asks, rendered exactly as `thread inbox` renders them.
 *
 * Shared by the session's own thread and by a continued one (D21) so the two
 * cannot drift into showing Justin's answers differently depending on which
 * session is asking.
 */
async function openAsksSection(
  ctx: ReturnType<typeof bdContext>,
  threadId: string,
  style: OutputStyle,
): Promise<string[]> {
  const {color} = style;
  const out: string[] = [
    sectionHeader(OPEN_ASKS_HEADING, {color, emoji: SECTION_EMOJI.openAsks}),
    '',
  ];
  const asks = await listOpenAsks(ctx, threadId);
  if (!asks.ok) {
    // NOT "(none open)". A failed read and an empty thread are opposite facts,
    // and this is the D4 entry point: "no asks" here is read as permission to
    // write a report that disposition nothing.
    out.push(bodyLine(`UNKNOWN — ${describeBdFailure(asks.failure)}`, style));
    return out;
  }
  if (asks.value.length === 0) {
    out.push(bodyLine('(none open)', style));
    return out;
  }
  out.push(
    ...spacedList(OPEN_ASKS_POLICY.map((line) => bodyLine(line, style))).split(
      '\n',
    ),
  );
  // The SAME renderer `thread inbox` uses (home-base-p1uj.2 follow-up). This
  // used to print every comment as `ANSWER (<time>): <text>`, which showed a
  // deliberate skip as `ANSWER (...): skipped: use default` and a real answer as
  // `ANSWER (...): ANSWER: a`. A skip is permission to take a stated default,
  // not an answer, and this is the D4 entry point run before every report — the
  // worst surface on which to confuse the two.
  const collected = await collectInboxAsks(ctx, asks.value);
  for (const ask of collected.asks) {
    // A blank line before every ask (K11 rule 1).
    out.push('');
    out.push(
      ...renderInboxAsk(
        ask,
        bodyLine(
          `${paint(ask.id, ['dim'], color)} · [${ask.kind}] ${paint(priorityLabel(ask.priority), priorityStyles(ask.priority), color)} · ${ask.title}`,
          style,
        ),
        wrapHanging(
          '(no answer yet — it will close as "decided: <its default>" unless you restate it)',
          {hang: DETAIL_COLUMN, indent: DETAIL_COLUMN, width: style.width},
        ),
        style,
      ),
    );
  }
  const noteRead = await readThreadNote(ctx, threadId);
  if (noteRead.note != null) {
    out.push('');
    out.push(
      sectionHeader('NOTE FROM JUSTIN', {color, emoji: SECTION_EMOJI.note}),
    );
    out.push('');
    for (const line of noteRead.note.split('\n')) {
      out.push(line.trim() === '' ? '' : bodyLine(line, style));
    }
  }
  return out;
}

/** Runs the preflight and prints it. Always resolves 0. */
export async function runThreadPrepare(
  options: PrepareOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const out: string[] = [];

  const config = resolveThreadConfig({cwd, env});
  if (!config.enabled) {
    out.push('THREADS: DISABLED');
    out.push(
      `  componentConfig.thread.enabled is not true (resolved from: ${config.source}).`,
    );
    out.push(
      `  Turn it on for every repo: set componentConfig.thread.enabled = true in ~/.config/justin-sdk/config.json`,
    );
    for (const problem of config.problems) out.push(`  ⚠️ ${problem}`);
    console.log(out.join('\n'));
    return 0;
  }

  // The two paths the Claude Code sandbox denies from any session outside
  // the threads repo. Probed BEFORE any bd command, so a denied session never spends
  // a subprocess (or a permission prompt) on a call that cannot succeed.
  // The state dir is OURS to create; the beads dir is bd's (F9) — probing it
  // with `create` would fabricate a beads workspace on a machine that has none.
  const stateProbe = probeWritable(threadsStateDir(env), {create: true});
  const beadsProbe = probeWritable(threadsBeadsDir(env), {create: false});
  if (stateProbe.kind === 'denied' || beadsProbe.kind === 'denied') {
    console.log(SANDBOX_DENIED_LINE);
    return 0;
  }
  if (beadsProbe.kind === 'missing') {
    console.log(threadsBeadsMissingLine(beadsProbe.path));
    return 0;
  }

  // THE FIRST LINE IS A CONTRACT (see the header): byte-exact, column 0,
  // never painted. Everything after it is laid out man-page style (K11).
  const style = options.style ?? outputStyle();
  const {color} = style;
  const body = (text: string): string => bodyLine(text, style);
  const header = (title: string, emoji: string): string =>
    sectionHeader(title, {color, emoji});
  const warn = (text: string): string =>
    bodyLine(paint(`⚠️ ${text}`, ['yellow'], color), style);
  out.push('THREADS: ENABLED');
  for (const problem of config.problems) out.push(warn(`config: ${problem}`));
  if (stateProbe.kind === 'failed') {
    out.push(
      warn(`state dir not writable: ${stateProbe.path} (${stateProbe.error})`),
    );
  }
  if (beadsProbe.kind === 'failed') {
    out.push(
      warn(`beads dir not writable: ${beadsProbe.path} (${beadsProbe.error})`),
    );
  }

  const ctx = bdContext(env);
  const types = await checkThreadTypes(ctx);
  if (!types.ok) {
    out.push(warn(`bd could not be read: ${describeBdFailure(types.failure)}`));
  } else if (types.value.missing.length > 0) {
    out.push(
      warn(
        `bd is missing the custom type(s) ${types.value.missing.join(', ')}. Fix:`,
      ),
    );
    out.push(
      `${pad(DETAIL_COLUMN)}${paint(REGISTER_TYPES_COMMAND, ['cyan'], color)}`,
    );
  }

  const facts = collectThreadFacts({cwd, env, sessionId: options.sessionId});
  const sessionId = facts.sessionId;

  out.push('');
  out.push(header('THIS SESSION’S THREAD', SECTION_EMOJI.thread));
  out.push('');
  if (sessionId == null) {
    out.push(
      body('UNKNOWN — no session id, so the thread cannot be looked up.'),
    );
  } else {
    const existing = await findThreadBySession(ctx, sessionId);
    if (!existing.ok) {
      out.push(body(`UNKNOWN — ${describeBdFailure(existing.failure)}`));
    } else if (existing.value == null) {
      out.push(body('none yet — this report will create it.'));
    } else {
      const thread = existing.value;
      out.push(
        body(
          `${paint(thread.id, ['dim'], color)} · ${thread.title ?? '(no title)'} · report #${readReportCount(thread.metadata) + 1} · status ${thread.status ?? 'UNKNOWN'}`,
        ),
      );
      out.push('');
      out.push(...(await openAsksSection(ctx, thread.id, style)));
    }
  }

  // --- the thread this session CONTINUES (D21) -----------------------------
  //
  // A session that picks up someone else's arc has a brand-new thread bead and
  // therefore no open asks of its own, while the asks Justin is actually waiting
  // on sit under the PREVIOUS session's thread. Listing them here is what makes
  // them dispositionable: `thread report` refuses a payload that leaves any of
  // them out, and it can only refuse over asks the session was shown.
  //
  // D18 (home-base-k0b8n.5): a justin-loop successor never types an id. It is
  // handed its PREDECESSOR'S SESSION id — on `--continues-from-session`, or in
  // `JUSTIN_LOOP_PREDECESSOR_SESSION_ID` on its dispatch — and that is resolved
  // to a thread bead here, so everything below is the same code path an
  // explicit `--continues-from` takes. A miss is printed BY NAME and prepare
  // carries on: this command always exits 0, and a predecessor that never
  // reported is not a reason to withhold the skeleton.
  const predecessor = await resolvePredecessor({
    ctx,
    env,
    explicit: options.continuesFromSession,
  });
  const applied = applyPredecessor(options.continuesFrom, predecessor);
  const continuesFrom = applied.continuesFrom;
  if (applied.note != null) {
    out.push('');
    out.push(
      header(
        `PREDECESSOR SESSION — ${applied.note}`,
        SECTION_EMOJI.predecessor,
      ),
    );
  }
  if (continuesFrom != null) {
    out.push('');
    out.push(
      header(
        `THREAD THIS SESSION CONTINUES — ${continuesFrom}`,
        SECTION_EMOJI.continues,
      ),
    );
    out.push('');
    const continued = await showIssue(ctx, continuesFrom);
    if (!continued.ok) {
      out.push(body(`UNKNOWN — ${describeBdFailure(continued.failure)}`));
    } else if (continued.value == null) {
      out.push(
        body(
          `NOT FOUND — no bead with that id. Check it with: ${paint(sdkRun('thread board --recent'), ['cyan'], color)}`,
        ),
      );
    } else {
      const thread = continued.value;
      out.push(
        body(
          `${thread.title ?? '(no title)'} · report #${readReportCount(thread.metadata)} · status ${thread.status ?? 'UNKNOWN'}`,
        ),
      );
      out.push('');
      out.push(...(await openAsksSection(ctx, continuesFrom, style)));
      out.push('');
      // One sentence, one line (critical rule 14) — it was hand-wrapped in two.
      out.push(
        body(
          `"continuesFrom": "${continuesFrom}" in the payload below is what reaches them. They follow the same rule as your own: closed on ${continuesFrom} unless you restate one as a new ask (supersedes) or disposition it in priorAsks.`,
        ),
      );
    }
  }

  out.push('');
  out.push(
    header(
      'FACTS I WILL ATTACH (you do not type any of these)',
      SECTION_EMOJI.facts,
    ),
  );
  out.push('');
  // A key/value TABLE, so its rows stay together (K11's blank line is between
  // items of a list, and a table row is not an item) — the keys dim.
  const fact = (key: string, value: string): string =>
    body(`${paint(key.padEnd(16), ['dim'], color)}${value}`);
  out.push(fact('sessionId', facts.sessionId ?? 'UNKNOWN'));
  out.push(fact('transcriptPath', facts.transcriptPath ?? 'UNKNOWN'));
  out.push(
    fact(
      'repo / branch',
      `${facts.repo ?? 'UNKNOWN'} / ${facts.branch ?? 'UNKNOWN'}`,
    ),
  );
  out.push(
    fact(
      'worktree',
      facts.isWorktree == null
        ? 'UNKNOWN'
        : facts.isWorktree
          ? (facts.worktreePath ?? 'yes')
          : 'primary checkout',
    ),
  );
  out.push(fact('headSha', facts.headSha ?? 'UNKNOWN'));
  out.push(
    fact('dirty', facts.dirty == null ? 'UNKNOWN' : String(facts.dirty)),
  );
  out.push(
    fact(
      'aheadBehind',
      facts.aheadBehind == null
        ? 'UNKNOWN'
        : `${facts.aheadBehind.ahead} ahead / ${facts.aheadBehind.behind} behind`,
    ),
  );
  out.push(fact('tokensAtStop', String(facts.tokensAtStop ?? 'UNKNOWN')));
  out.push(fact('model', facts.model ?? 'UNKNOWN'));
  out.push(fact('startedAt', facts.startedAt ?? 'UNKNOWN'));
  out.push(
    fact(
      'lastUserMessage',
      facts.lastUserMessage == null
        ? 'UNKNOWN'
        : `${facts.lastUserMessage.slice(0, 120)}${facts.lastUserMessage.length > 120 ? '…' : ''}`,
    ),
  );
  for (const failure of facts.autofillFailures) out.push(warn(failure));

  out.push('');
  out.push(header('WRITE YOUR PAYLOAD, THEN REPORT', SECTION_EMOJI.write));
  out.push('');
  out.push(
    body(
      `1. Write this JSON (filled in) to ${sessionId == null ? '<a path>' : draftPath(sessionId, env)}`,
    ),
  );
  out.push('');
  out.push(
    body(
      `2. Run: ${paint(sdkRun('thread report --file <that path>'), ['cyan'], color)}`,
    ),
  );
  out.push('');
  // The JSON stays at column 0: it is copied into a file verbatim.
  out.push(payloadSkeleton({continuesFrom}));
  out.push('');
  out.push(...guidanceLines(PAYLOAD_PRIORITY_GUIDANCE, style));
  out.push('');
  // D25. Printed AFTER the skeleton and last of all, because it is the thing a
  // session should be holding in its head as it writes the payload — not a
  // preamble it scrolled past on the way to the JSON.
  out.push(...guidanceLines(PAYLOAD_MUST_SEE_GUIDANCE, style));

  console.log(out.join('\n'));
  return 0;
}
