/**
 * `justin-sdk thread answer` — Justin answers his asks (home-base-p1uj D3).
 *
 * The report told him what it needs. This walks those asks one at a time,
 * records each answer as a bd COMMENT on the ask bead, and prints the one line
 * he pastes back into the Claude session. The next turn picks the answers up
 * with `thread inbox`.
 *
 * WHY THE PROMPTS ARE HAND-ROLLED — the verdict, measured 2026-09-12, so nobody
 * re-litigates it. `@inquirer/prompts` was vetted as the brief required:
 *   - v8.7.2, published 2026-09-07. Genuinely maintained; that was never the
 *     problem.
 *   - With stdin not a TTY it RENDERS THE PROMPT AND HANGS FOREVER (measured:
 *     killed at a 10s timeout, exit 124). This command's hard requirement is
 *     the opposite — one line and a non-zero exit — so the `isTTY` guard below
 *     has to exist either way; the library does not provide the one property
 *     that mattered.
 *   - It renders correctly under bun in a pty, so bun compatibility was fine.
 *   - 25 packages / 1.6 MB onto an SDK with four direct dependencies, which
 *     every `bunx github:justinhaaheim/justin-sdk` bootstrap then installs.
 *   - The final multi-line field is not buildable from its primitives: `input`
 *     is single-line and `editor` shells out to $EDITOR. Hand-rolled regardless.
 * Peer libraries (@clack/prompts and friends) share the same raw-mode design,
 * so re-vetting them would reach the same place. What is left — a letter, a
 * y/n, a line of text — is `node:readline/promises`.
 *
 * LETTER-KEYED, NOT ARROW-KEYED, and that is an improvement rather than a
 * consolation: it matches the report's own form controls ("[Pick a/b/c]"), it
 * is what Justin already types when he answers in chat, and it survives iOS
 * remote control and a flaky pane, where a raw-mode cursor UI does not.
 *
 * Exit 0 = walked · 1 = a bd write failed · 2 = could not start (no TTY, no
 * thread, nothing open). A failed comment write is NEVER swallowed: the whole
 * point of this command is that the answer reaches the bead.
 *
 * EACH ANSWER IS WRITTEN THE MOMENT IT IS GIVEN (home-base-p1uj.9). It used to
 * collect every decision and write them all after the note prompt: two bd calls
 * per ask at ~0.9s each, so Justin's first human walk (six asks) ended in ~10s
 * of unexplained silence after he pressed Enter on "Anything else for Claude?".
 * The total bd time is unchanged — it is the same calls — but it now lands
 * between prompts, where he is reading the next ask anyway, and every write
 * prints one line. What is left after the note prompt is the note's own write,
 * announced by `recording…` rather than by nothing.
 *
 * A FAILED WRITE DOES NOT END THE WALK. It names the ask on the spot, the walk
 * carries on to the next one, and the banner at the end repeats every failure
 * with a copy-pasteable command that writes that exact answer by hand. Stopping
 * would throw away the answers Justin had not yet given, which is a worse
 * outcome than a bead that needs one command.
 */

import {createInterface} from 'readline/promises';

import {
  addComment,
  describeBdFailure,
  listOpenAsks,
  mergeMetadata,
  type BdContext,
  type BdIssue,
} from './bd';
import {contextFor, resolveThread, type ThreadRef} from './resolve';
import {
  compareAsksForNumbering,
  numberingFieldsOf,
  optionLetter,
} from './render';

/** What one ask needs in order to be asked. Everything comes from the bead. */
export interface AskView {
  /** `metadata.askIndex`: its place in the report that created it (F12). */
  askIndex: number | null;
  blocking: boolean;
  /** The ask bead's rendered description: kind tag, context, options, default. */
  description: string;
  defaultAction: string;
  id: string;
  kind: string;
  optionCount: number;
  /** `metadata.reportCount`: which report created it. Null when unrecorded. */
  reportCount: number | null;
  title: string;
}

export type AskDecision = {kind: 'answered'; text: string} | {kind: 'skipped'};

/** The comment text written for a skipped ask. Read back verbatim by `inbox`. */
export const SKIP_COMMENT = 'skipped: use default';

/**
 * The terminal, as the walk sees it. An interface rather than `console` +
 * `readline` directly so the walk can be driven by a scripted prompt in a test
 * — the TTY is exactly the part that cannot be exercised from a subagent.
 */
export interface AnswerIo {
  /** Multi-line: ends on an empty line or EOF. */
  block(prompt: string): Promise<string>;
  /** One line back, already trimmed. */
  line(prompt: string): Promise<string>;
  print(text: string): void;
}

/**
 * The outcome of ONE write, as the walk needs to see it.
 *
 * `retry` is null when there is no single honest command that would finish the
 * job — a metadata stamp goes through a JSON file, and printing a command that
 * has never been run would be worse than printing none. Null here means "no
 * command", never "it worked": the `ok: false` tag is what carries the failure.
 */
export type WriteOutcome =
  | {ok: true}
  | {detail: string; ok: false; retry: string | null};

/** One failed write, kept for the banner at the end of the walk. */
export interface WriteFailure {
  detail: string;
  /** What failed, in Justin's terms: an ask id, or the note. */
  label: string;
  retry: string | null;
}

/**
 * Where an answer goes. Injected for the same reason `AnswerIo` is: the walk's
 * ORDER — write, then prompt the next ask — is the behaviour under test, and it
 * is only observable if both halves can be watched from outside.
 */
export interface AnswerWriter {
  ask(ask: AskView, decision: AskDecision): Promise<WriteOutcome>;
  note(text: string): Promise<WriteOutcome>;
}

export interface WalkResult {
  decisions: {ask: AskView; decision: AskDecision; recorded: boolean}[];
  failures: WriteFailure[];
  note: string | null;
}

/** Read an ask bead into the shape the walk needs. Unreadable metadata degrades loudly. */
export function askViewOf(issue: BdIssue): AskView {
  const meta = (issue.metadata ?? {}) as Record<string, unknown>;
  const numbering = numberingFieldsOf(meta);
  return {
    askIndex: numbering.askIndex,
    blocking: meta.blocking === true,
    defaultAction:
      typeof meta.defaultAction === 'string' && meta.defaultAction !== ''
        ? meta.defaultAction
        : 'UNKNOWN (the ask bead records no default)',
    description: issue.description ?? '',
    id: issue.id,
    kind: typeof meta.kind === 'string' ? meta.kind : 'answer',
    optionCount:
      typeof meta.optionCount === 'number' && Number.isFinite(meta.optionCount)
        ? Math.max(0, Math.floor(meta.optionCount))
        : 0,
    reportCount: numbering.reportCount,
    title: issue.title ?? '',
  };
}

/**
 * The report's own order (F12), via the shared comparator.
 *
 * This used to be "blocking first, then `id.localeCompare`", which disagreed
 * with the report in two ways at once: `.10` sorted before `.2`, and a carried
 * ask landed wherever its id happened to fall instead of ahead of the new ones.
 * "1 yes, 2 b" typed against the pasted report then walked onto different asks.
 */
export function orderAsks(asks: readonly AskView[]): AskView[] {
  return [...asks].sort(compareAsksForNumbering);
}

/** The prompt suffix for one ask — what SHAPE of reply this wants. */
export function promptFor(ask: AskView): string {
  if (ask.kind === 'pick' && ask.optionCount > 0) {
    const letters = Array.from({length: ask.optionCount}, (_v, index) =>
      optionLetter(index),
    ).join('/');
    return `[${letters}, or Enter to skip] `;
  }
  if (ask.kind === 'approve') return '[y/n, or Enter to skip] ';
  return '[type your answer, or Enter to skip] ';
}

/**
 * Turn one raw line into a decision.
 *
 * An empty line is a SKIP, which D3 defines as "take your default" — not an
 * empty answer. The two are recorded differently and read back differently, and
 * conflating them would let a skipped ask arrive at the next turn looking like
 * Justin had answered with silence.
 */
export function decisionFor(ask: AskView, raw: string): AskDecision {
  const text = raw.trim();
  if (text === '') return {kind: 'skipped'};
  if (ask.kind === 'pick' && ask.optionCount > 0) {
    const letters = Array.from({length: ask.optionCount}, (_v, index) =>
      optionLetter(index),
    );
    const chosen = text.toLowerCase();
    if (!letters.includes(chosen)) {
      return {kind: 'answered', text};
    }
    return {kind: 'answered', text: chosen};
  }
  if (ask.kind === 'approve') {
    const lowered = text.toLowerCase();
    if (lowered === 'y' || lowered === 'yes')
      return {kind: 'answered', text: 'yes'};
    if (lowered === 'n' || lowered === 'no')
      return {kind: 'answered', text: 'no'};
  }
  return {kind: 'answered', text};
}

/**
 * The walk itself — the terminal AND bd behind interfaces.
 *
 * Everything interactive is behind `io` and every write is behind `writer`, so
 * the whole sequence Justin experiences — ask, answer, write, next ask — is
 * driveable from a test. That split is what makes this testable at all: the TTY
 * half is a dozen lines of adapter, and this is where the behaviour lives.
 */
export async function walkAsks(
  asks: readonly AskView[],
  io: AnswerIo,
  writer: AnswerWriter,
): Promise<WalkResult> {
  const decisions: {ask: AskView; decision: AskDecision; recorded: boolean}[] =
    [];
  const failures: WriteFailure[] = [];
  const ordered = orderAsks(asks);

  for (const [index, ask] of ordered.entries()) {
    io.print('');
    // `index + 1` IS the number this ask carried in the report, because both
    // sides sort with `compareAsksForNumbering` over the same set (F12). The
    // origin report is named too: it is the only thing that still identifies an
    // ask when the set HAS changed — Justin answered one yesterday, so today's
    // walk is shorter than the report he is reading from.
    const from =
      ask.reportCount == null ? '' : ` · from report #${ask.reportCount}`;
    io.print(
      `── ${index + 1}/${ordered.length} · ${ask.id} · ${ask.blocking ? 'BLOCKING' : 'non-blocking'}${from} ──`,
    );
    io.print(ask.description === '' ? ask.title : ask.description);
    io.print('');
    const raw = await io.line(promptFor(ask));
    const decision = decisionFor(ask, raw);
    io.print(
      decision.kind === 'skipped'
        ? `   → skipped; Claude will: ${ask.defaultAction}`
        : `   → answer: ${decision.text}`,
    );
    // AWAITED, here, before the next ask is printed. Firing it off unawaited
    // would hide the latency completely, and would also mean a walk that ends
    // with ctrl-C leaves writes in flight with nothing to report them.
    const outcome = await writer.ask(ask, decision);
    decisions.push({ask, decision, recorded: outcome.ok});
    if (outcome.ok) {
      io.print(`   ✓ recorded ${ask.id}`);
    } else {
      io.print(`   🚨 NOT recorded on ${ask.id} — ${outcome.detail}`);
      failures.push({
        detail: outcome.detail,
        label: ask.id,
        retry: outcome.retry,
      });
    }
  }

  io.print('');
  io.print('── Anything else for Claude? (end with an empty line) ──');
  const raw = await io.block('> ');
  const note = raw.trim() === '' ? null : raw.trim();
  if (note == null) return {decisions, failures, note};

  // The one write that CANNOT be moved earlier — it is the thing he just typed.
  // Announced first, because this is the exact keystroke after which the old
  // walk went quiet.
  io.print('');
  io.print('recording…');
  const outcome = await writer.note(note);
  if (outcome.ok) {
    io.print('   ✓ recorded your note');
  } else {
    io.print(`   🚨 your note was NOT recorded — ${outcome.detail}`);
    failures.push({
      detail: outcome.detail,
      label: 'your note',
      retry: outcome.retry,
    });
  }
  return {decisions, failures, note};
}

/**
 * The readline adapter. The ONLY place stdin is touched.
 *
 * `block` ends on an empty line OR on EOF (ctrl-D). The `close` race matters:
 * a `question()` whose stream has closed never settles, so a ctrl-D at the
 * wrong moment would hang the command — the exact failure this file refuses to
 * ship.
 */
function createTerminalIo(): {io: AnswerIo; close: () => void} {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  const ask = async (prompt: string): Promise<string | null> => {
    if (closed) return null;
    // The close listener is REMOVED on the normal path. `once` only fires once,
    // but a question that resolves normally leaves its listener attached
    // forever, so a walk with a dozen prompts (asks plus note lines) would trip
    // Node's MaxListenersExceededWarning — printed to stderr, mid-walk, on
    // exactly the threads with the most asks to answer.
    let onClose: (() => void) | null = null;
    const closedPromise = new Promise<null>((resolve) => {
      onClose = () => resolve(null);
      rl.once('close', onClose);
    });
    try {
      return await Promise.race([rl.question(prompt), closedPromise]);
    } finally {
      if (onClose != null) rl.off('close', onClose);
    }
  };

  return {
    close: () => rl.close(),
    io: {
      async block(prompt: string): Promise<string> {
        const lines: string[] = [];
        for (;;) {
          const line = await ask(prompt);
          if (line == null) break; // EOF
          if (line.trim() === '') break;
          lines.push(line);
        }
        return lines.join('\n');
      },
      async line(prompt: string): Promise<string> {
        return (await ask(prompt)) ?? '';
      },
      print(text: string): void {
        console.log(text);
      },
    },
  };
}

export interface AnswerOptions extends ThreadRef {
  /** Injected by tests; the real command uses the readline adapter. */
  io?: AnswerIo;
}

export async function runThreadAnswer(
  options: AnswerOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx: BdContext = contextFor(env);

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread answer: ${resolved.message}`);
    return 2;
  }
  const thread = resolved.issue;

  const asks = await listOpenAsks(ctx, thread.id);
  if (!asks.ok) {
    // NOT "there is nothing to answer": we could not look.
    console.error(
      `thread answer: could not read the asks on ${thread.id} — ${describeBdFailure(asks.failure)}`,
    );
    return 1;
  }

  // The report first, so Justin knows what he is answering. D10 put the whole
  // rendered report in `notes` precisely so it can be replayed here.
  console.log(
    thread.notes == null || thread.notes === ''
      ? `THREAD ${thread.id} · ${thread.title ?? '(no title)'} (no rendered report on this bead)`
      : thread.notes,
  );

  if (asks.value.length === 0) {
    console.log('');
    console.log(
      `No open asks on ${thread.id} — checked, and there are none. Nothing to answer.`,
    );
    return 0;
  }

  let io = options.io ?? null;
  let closeIo: (() => void) | null = null;
  if (io == null) {
    // The guard the vetted library did not provide. A non-TTY run must fail
    // loudly and immediately: this command blocks on a human, and a background
    // or piped invocation that waited would hang a session forever.
    if (process.stdin.isTTY !== true) {
      console.error(
        'thread answer: stdin is not a terminal, and this command has to ask you things. Run it in a terminal, or use `bd comments add <askId> "..."` directly.',
      );
      return 2;
    }
    const terminal = createTerminalIo();
    io = terminal.io;
    closeIo = terminal.close;
  }

  let result: WalkResult;
  try {
    result = await walkAsks(
      asks.value.map(askViewOf),
      io,
      bdWriter(ctx, thread.id),
    );
  } finally {
    if (closeIo != null) closeIo();
  }

  return summarizeWalk(result);
}

/**
 * One argument, safely, for a command Justin will paste into zsh.
 *
 * His answers contain apostrophes, quotes and backticks — the retry line is
 * useless if it mangles them, and actively dangerous if a backtick in an answer
 * becomes a substitution. Single quotes stop everything; the only character
 * that needs work is the single quote itself.
 */
export function shellSingleQuote(text: string): string {
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** The comment text one decision becomes. Read back verbatim by `inbox`. */
export function commentTextFor(decision: AskDecision): string {
  return decision.kind === 'skipped'
    ? SKIP_COMMENT
    : `ANSWER: ${decision.text}`;
}

/** The exact command that writes one comment by hand, for the failure banner. */
export function retryCommandFor(id: string, text: string): string {
  return `cd ~/Dev/life && bun run bd comments add ${id} ${shellSingleQuote(text)}`;
}

/**
 * The real writer: a comment plus a metadata stamp, per answer.
 *
 * The COMMENT GOES FIRST. It is the answer Justin actually gave; the stamp is
 * bookkeeping, and a write that dies between them must lose the bookkeeping
 * rather than the answer. A failed stamp is therefore reported with that said
 * out loud — telling him to re-type an answer bd already holds would be its own
 * small lie.
 */
function bdWriter(ctx: BdContext, threadId: string): AnswerWriter {
  const writeComment = async (
    id: string,
    text: string,
    stamp: Record<string, unknown>,
  ): Promise<WriteOutcome> => {
    const wrote = await addComment(ctx, id, text);
    if (!wrote.ok) {
      return {
        detail: `comment — ${describeBdFailure(wrote.failure)}`,
        ok: false,
        retry: retryCommandFor(id, text),
      };
    }
    const stamped = await mergeMetadata(ctx, id, stamp);
    if (!stamped.ok) {
      return {
        detail: `metadata stamp — ${describeBdFailure(stamped.failure)} (the answer itself IS recorded)`,
        ok: false,
        // No command: the stamp goes through a JSON file, and a hand-written
        // one is not something this has ever run. Naming the miss beats
        // inventing a fix for it.
        retry: null,
      };
    }
    return {ok: true};
  };

  return {
    async ask(ask: AskView, decision: AskDecision): Promise<WriteOutcome> {
      // Both stamps exist, and only one is ever set: `inbox` has to tell an ask
      // Justin ANSWERED from one he deliberately SKIPPED from one he never
      // reached, and three facts need three states, not a boolean.
      const now = new Date().toISOString();
      return writeComment(ask.id, commentTextFor(decision), {
        answeredAt: decision.kind === 'answered' ? now : null,
        skippedAt: decision.kind === 'skipped' ? now : null,
      });
    },
    async note(text: string): Promise<WriteOutcome> {
      return writeComment(threadId, `NOTE: ${text}`, {
        inboxAt: new Date().toISOString(),
      });
    },
  };
}

/**
 * The last thing on screen: counts, then either the failure banner or the one
 * line Justin says back to Claude.
 *
 * The counts describe what REACHED bd, not what he typed — an answer that
 * failed to write is not an answer Claude will ever see, and counting it would
 * be the reassuring kind of wrong.
 */
function summarizeWalk(result: WalkResult): number {
  const answered = result.decisions.filter(
    (entry) => entry.recorded && entry.decision.kind === 'answered',
  ).length;
  const skipped = result.decisions.filter(
    (entry) => entry.recorded && entry.decision.kind === 'skipped',
  ).length;
  const noteState =
    result.note == null
      ? 'none'
      : result.failures.some((failure) => failure.label === 'your note')
        ? 'NOT recorded'
        : 'recorded';

  console.log('');
  console.log(`${answered} answered · ${skipped} skipped · note ${noteState}`);

  if (result.failures.length > 0) {
    console.error('');
    console.error('🚨 SOME ANSWERS DID NOT REACH bd:');
    for (const failure of result.failures) {
      console.error(`  ${failure.label} — ${failure.detail}`);
    }
    const retries = result.failures
      .map((failure) => failure.retry)
      .filter((retry): retry is string => retry != null);
    if (retries.length > 0) {
      console.error('');
      console.error('Write them by hand:');
      for (const retry of retries) console.error(`  ${retry}`);
    }
    return 1;
  }

  // The last line is the whole handoff back to Claude. It is what JUSTIN says,
  // not a command for him to run: `thread inbox` needs a session id his shell
  // does not have, and it is Claude's own next step anyway (home-base-p1uj.9).
  console.log('');
  console.log('Tell Claude: answers in');
  return 0;
}
