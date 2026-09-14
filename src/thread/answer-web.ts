/**
 * `justin-sdk thread answer` on the web UI (home-base-p1uj.12) — the spike
 * winner, and the default.
 *
 * WHY THIS AND NOT A TUI. The verdict is on the bead with its measurements; the
 * short version is that Ink is a mature framework whose multi-line editor does
 * not exist (ink-text-input is single-line; the only multi-line packages are
 * pre-1.0 with three-figure weekly downloads), so the editor Justin lost five
 * paragraphs in would have been hand-rolled either way. In a browser that editor
 * is `<textarea>` — cursor, wrap, scroll, selection and UNDO already hardened,
 * for zero code and zero dependencies on an SDK that has four.
 *
 * ITS ONE REAL LIMITATION, stated rather than discovered later: this binds
 * 127.0.0.1 and Justin's iOS remote-control flow cannot reach it. That is
 * exactly why `answerUi: classic` still runs the readline walk.
 *
 * NOTHING IS WRITTEN TO bd UNTIL "Record". Everything before that is a file
 * under the state dir, so quitting, closing the tab, killing this process and
 * Ctrl-C are all non-events (I1). The writes themselves go through the SAME
 * `AnswerWriter` the classic walk uses — imported, not re-implemented — which is
 * how I8 ("recorded identically") is true by construction rather than by
 * inspection.
 *
 * EXIT CODES, deliberately the same shape as the classic walk, with quit given
 * its own meaning rather than folded into success (rule 6):
 *   0 recorded · 1 a bd write failed · 2 nothing was recorded (quit, or could
 *   not start). A deliberate quit is NOT 0: "answers in" would be a lie, and the
 *   drafts are still sitting there waiting.
 */

import {
  bdWriter,
  askViewOf,
  orderAsks,
  type AnswerIo,
  type AnswerWriter,
  type AskDecision,
  type AskView,
  type WriteFailure,
} from './answer';
import {
  describeBdFailure,
  EXPORT_UNSTAGED_WARNING,
  listOpenAsks,
  type BdContext,
} from './bd';
import {commitThreadsRepo, describeCommit} from './commit';
import {contextFor, resolveThread, type ThreadRef} from './resolve';
import {
  clearDrafts,
  listDrafts,
  NOTE_DRAFT_ID,
  writeDraft,
  type StoredDraft,
} from './drafts';
import {threadsStateDir} from './paths';
import {renderAnswerPage, type PageAsk} from './answer-page';

export interface SubmitDecision {
  askId: string;
  kind: 'answered' | 'skipped';
  text: string;
}

export type WebOutcome =
  | {
      answered: number;
      draftsKept: boolean;
      failures: WriteFailure[];
      kind: 'submitted';
      note: string | null;
      skipped: number;
    }
  /** The human chose "quit, keeping every draft". Nothing reached bd. */
  | {kind: 'quit'}
  | {kind: 'aborted'; reason: string};

export interface AnswerServer {
  /** Settles when the human records, quits, or the server is stopped. */
  done: Promise<WebOutcome>;
  port: number;
  stop: () => void;
  token: string;
  url: string;
}

export interface AnswerServerOptions {
  asks: readonly AskView[];
  /** 0 asks for an ephemeral port. Tests rely on it. */
  port?: number;
  /** The rendered report from the thread bead (D10), shown collapsed. */
  report: string;
  stateDir: string;
  threadId: string;
  threadTitle: string;
  token?: string;
  writer: AnswerWriter;
}

/** Drafts on disk, as a lookup, plus anything that went wrong reading them. */
function loadDrafts(
  stateDir: string,
  threadId: string,
): {problems: string[]; stored: Map<string, StoredDraft>} {
  const list = listDrafts(stateDir, threadId);
  if (list.kind === 'failed') {
    // NOT an empty map silently: the page prints this, because "I could not read
    // your drafts" and "you have no drafts" differ by five paragraphs.
    return {
      problems: [`could not read drafts under ${stateDir}: ${list.error}`],
      stored: new Map(),
    };
  }
  return {
    problems: [],
    stored: new Map(list.drafts.map((draft) => [draft.askId, draft])),
  };
}

function pageAsksFor(
  asks: readonly AskView[],
  stored: Map<string, StoredDraft>,
): PageAsk[] {
  return orderAsks(asks).map((ask, index) => ({
    defaultAction: ask.defaultAction,
    description: ask.description,
    draft: stored.get(ask.id)?.text ?? null,
    id: ask.id,
    kind: ask.kind,
    number: index + 1,
    optionCount: ask.optionCount,
    priority: ask.priority,
    reportCount: ask.reportCount,
    title: ask.title,
  }));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: {'cache-control': 'no-store', 'content-type': 'application/json'},
    status,
  });
}

/**
 * The server.
 *
 * Exported and injectable because this is where every invariant actually lives:
 * a test drives the whole UI with `fetch`, with no browser, no pty and no
 * test-only dependency — which was itself one of the reasons this option won the
 * spike.
 */
export function createAnswerServer(options: AnswerServerOptions): AnswerServer {
  const token = options.token ?? crypto.randomUUID();
  const ordered = orderAsks(options.asks);
  const byId = new Map(ordered.map((ask) => [ask.id, ask]));

  let settle: (outcome: WebOutcome) => void = () => {};
  let settled = false;
  const done = new Promise<WebOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });

  const authorised = (url: URL): boolean => url.searchParams.get('t') === token;

  const server = Bun.serve({
    // 127.0.0.1, never 0.0.0.0: this page can write to Justin's bead ledger and
    // has no business being reachable from the network.
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (!authorised(url)) {
        return new Response(
          'thread answer: wrong or missing token. Open the URL the command printed.',
          {status: 403},
        );
      }

      if (url.pathname === '/' && request.method === 'GET') {
        const {problems, stored} = loadDrafts(
          options.stateDir,
          options.threadId,
        );
        return new Response(
          renderAnswerPage({
            asks: pageAsksFor(ordered, stored),
            noteDraft: stored.get(NOTE_DRAFT_ID)?.text ?? null,
            noteId: NOTE_DRAFT_ID,
            problems,
            report: options.report,
            threadId: options.threadId,
            threadTitle: options.threadTitle,
            token,
          }),
          {
            headers: {
              'cache-control': 'no-store',
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        const {problems, stored} = loadDrafts(
          options.stateDir,
          options.threadId,
        );
        return json({
          asks: pageAsksFor(ordered, stored),
          noteId: NOTE_DRAFT_ID,
          problems,
          threadId: options.threadId,
        });
      }

      // PUT is what the page uses; POST exists because `navigator.sendBeacon`,
      // the only save that survives the tab closing, can only POST.
      const draftMatch = /^\/api\/draft\/(.+)$/.exec(url.pathname);
      if (
        draftMatch != null &&
        (request.method === 'PUT' || request.method === 'POST')
      ) {
        const askId = decodeURIComponent(draftMatch[1] ?? '');
        if (askId !== NOTE_DRAFT_ID && !byId.has(askId)) {
          return json({error: `unknown ask ${askId}`}, 404);
        }
        const text = await request.text();
        const wrote = writeDraft(
          options.stateDir,
          options.threadId,
          askId,
          text,
        );
        // A failed save is a 500 the page paints red. Answering 200 here would
        // make the indicator say "saved" about text that is nowhere.
        return wrote.kind === 'ok'
          ? json({savedAt: wrote.savedAt})
          : json({error: wrote.error}, 500);
      }

      const discardMatch = /^\/api\/discard\/(.+)$/.exec(url.pathname);
      if (discardMatch != null && request.method === 'POST') {
        const askId = decodeURIComponent(discardMatch[1] ?? '');
        const wrote = writeDraft(options.stateDir, options.threadId, askId, '');
        return wrote.kind === 'ok'
          ? json({ok: true})
          : json({error: wrote.error}, 500);
      }

      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const outcome = await submit(
          await request.json(),
          ordered,
          byId,
          options,
        );
        settle(outcome);
        return json({
          draftsKept: outcome.kind === 'submitted' ? outcome.draftsKept : true,
          failures: outcome.kind === 'submitted' ? outcome.failures : [],
          summary:
            outcome.kind === 'submitted'
              ? `${outcome.answered} answered · ${outcome.skipped} skipped · note ${outcome.note == null ? 'none' : 'recorded'}`
              : 'nothing was recorded',
        });
      }

      if (url.pathname === '/api/quit' && request.method === 'POST') {
        settle({kind: 'quit'});
        return json({ok: true});
      }

      return new Response('not found', {status: 404});
    },
  });

  // `Bun.serve().port` is optional in the types because a unix-socket server has
  // none. We asked for a TCP port, so `undefined` here means the listen did not
  // do what we asked — and a URL built from it would read `http://127.0.0.1:0/`
  // and go nowhere. Fail instead of printing a plausible-looking dead link.
  const port = server.port;
  if (port == null) {
    server.stop(true);
    throw new Error(
      'thread answer: Bun.serve bound no TCP port, so there is no URL to open.',
    );
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return {
    done,
    port,
    stop: () => {
      settle({kind: 'aborted', reason: 'the server was stopped'});
      server.stop(true);
    },
    token,
    url,
  };
}

/**
 * Write every decision, in the report's own order, through the classic walk's
 * writer.
 *
 * A failed write does NOT stop the rest, for the same reason the classic walk
 * carries on: the answers already given are worth more than a tidy abort. Every
 * failure is named, and the drafts are kept in that case so nothing has to be
 * retyped.
 */
async function submit(
  body: unknown,
  ordered: readonly AskView[],
  byId: Map<string, AskView>,
  options: AnswerServerOptions,
): Promise<WebOutcome> {
  const parsed = body as {decisions?: SubmitDecision[]; note?: string};
  const submitted = new Map(
    (parsed.decisions ?? []).map((entry) => [entry.askId, entry]),
  );
  const failures: WriteFailure[] = [];
  let answered = 0;
  let skipped = 0;

  for (const ask of ordered) {
    const entry = submitted.get(ask.id);
    if (entry == null) continue;
    const decision: AskDecision =
      entry.kind === 'answered' && entry.text.trim() !== ''
        ? {kind: 'answered', text: entry.text.trim()}
        : {kind: 'skipped'};
    const outcome = await options.writer.ask(byId.get(ask.id) ?? ask, decision);
    if (outcome.ok) {
      if (decision.kind === 'answered') answered += 1;
      else skipped += 1;
    } else {
      failures.push({
        detail: outcome.detail,
        label: ask.id,
        retry: outcome.retry,
      });
    }
  }

  const noteText = (parsed.note ?? '').trim();
  const note = noteText === '' ? null : noteText;
  if (note != null) {
    const outcome = await options.writer.note(note);
    if (!outcome.ok) {
      failures.push({
        detail: outcome.detail,
        label: 'your note',
        retry: outcome.retry,
      });
    }
  }

  // Drafts are cleared ONLY when every write landed. Anything less and they stay
  // exactly where they are — the answer is in the file even when bd refused it.
  const draftsKept = failures.length > 0;
  if (!draftsKept) clearDrafts(options.stateDir, options.threadId);

  return {answered, draftsKept, failures, kind: 'submitted', note, skipped};
}

/** Ask the OS to open the page. Failure is a printed URL, never a dead end. */
export function openInBrowser(url: string): {opened: boolean; reason: string} {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'linux'
        ? ['xdg-open', url]
        : null;
  if (command == null) {
    return {opened: false, reason: `no opener known for ${process.platform}`};
  }
  try {
    Bun.spawn(command, {stderr: 'ignore', stdout: 'ignore'});
    return {opened: true, reason: ''};
  } catch (error) {
    return {
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface WebAnswerOptions extends ThreadRef {
  autoCommit?: boolean;
  /**
   * Called once the server is listening, with the live handle.
   *
   * This is the browser's seam. The whole command — thread resolution, the real
   * bd writer, the commit, the exit code — runs unmodified, and the test plays
   * the part of the human by fetching the same URLs the page fetches. Without it
   * a test could only reach `createAnswerServer`, and the half that actually
   * ships (`runThreadAnswerWeb`) would go unexercised.
   */
  onReady?: (server: AnswerServer) => void;
  /** Tests pin this false; the real command opens the browser. */
  openBrowser?: boolean;
  port?: number;
  /** Unused here — accepted so the two UIs share one options shape. */
  io?: AnswerIo;
}

export async function runThreadAnswerWeb(
  options: WebAnswerOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx: BdContext = contextFor(env);
  const stateDir = threadsStateDir(env);

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread answer: ${resolved.message}`);
    return 2;
  }
  const thread = resolved.issue;

  const asks = await listOpenAsks(ctx, thread.id);
  if (!asks.ok) {
    console.error(
      `thread answer: could not read the asks on ${thread.id} — ${describeBdFailure(asks.failure)}`,
    );
    return 1;
  }
  if (asks.value.length === 0) {
    console.log(
      `No open asks on ${thread.id} — checked, and there are none. Nothing to answer.`,
    );
    return 0;
  }

  const server = createAnswerServer({
    asks: asks.value.map(askViewOf),
    port: options.port,
    report: thread.notes ?? '(no rendered report on this bead)',
    stateDir,
    threadId: thread.id,
    threadTitle: thread.title ?? '(no title)',
    writer: bdWriter(ctx, thread.id),
  });

  console.log(`thread answer · ${thread.id} · ${asks.value.length} open asks`);
  console.log(server.url);
  options.onReady?.(server);
  if (options.openBrowser !== false) {
    const opened = openInBrowser(server.url);
    if (!opened.opened) {
      console.error(
        `thread answer: could not open a browser (${opened.reason}) — open the URL above yourself.`,
      );
    }
  }
  console.log(
    `Drafts autosave to ${stateDir}/drafts/${thread.id}/ — Ctrl-C here is safe, nothing is lost.`,
  );

  // Ctrl-C must be a non-event, and must SAY so. The default SIGINT death would
  // leave Justin guessing whether the paragraphs he just typed still exist.
  const onSigint = () => {
    console.log('');
    console.log(
      `Stopped. Every draft is still on disk under ${stateDir}/drafts/${thread.id}/ — run the same command again to pick up where you left off.`,
    );
    server.stop();
  };
  process.on('SIGINT', onSigint);

  let outcome: WebOutcome;
  try {
    outcome = await server.done;
  } finally {
    process.off('SIGINT', onSigint);
    // A short grace period so the page's own response is flushed before the
    // socket goes away; `stop(false)` lets in-flight requests finish.
    setTimeout(() => server.stop(), 250).unref?.();
  }

  if (outcome.kind !== 'submitted') {
    console.log('');
    console.log(
      outcome.kind === 'quit'
        ? 'Nothing was recorded. Every draft is still on disk.'
        : `Nothing was recorded — ${outcome.reason}. Every draft is still on disk.`,
    );
    return 2;
  }

  if (ctx.exportUnstaged) console.error(EXPORT_UNSTAGED_WARNING);
  const commitLine = describeCommit(
    commitThreadsRepo(`thread ${thread.id}: answers`, {
      autoCommit: options.autoCommit,
      dir: ctx.repoDir,
      env,
      exportUnstaged: ctx.exportUnstaged,
    }),
    'the threads repo',
  );
  if (commitLine != null) console.error(commitLine);

  console.log('');
  console.log(
    `${outcome.answered} answered · ${outcome.skipped} skipped · note ${outcome.note == null ? 'none' : 'recorded'}`,
  );
  if (outcome.failures.length > 0) {
    console.error('');
    console.error('🚨 SOME ANSWERS DID NOT REACH bd:');
    for (const failure of outcome.failures) {
      console.error(`  ${failure.label} — ${failure.detail}`);
    }
    console.error('');
    console.error('Your drafts were KEPT, so nothing has to be retyped.');
    for (const failure of outcome.failures) {
      if (failure.retry != null) console.error(`  ${failure.retry}`);
    }
    return 1;
  }

  console.log('');
  console.log('Tell Claude: answers in');
  return 0;
}
