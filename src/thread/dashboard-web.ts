/**
 * `thread dashboard` (home-base-yukaf.11, epic decision D-WEB): the threads
 * dashboard as a local web page whose buttons act on the Mac. An EXPERIMENT
 * behind `componentConfig.thread.dashboardUi` (default `tui`).
 *
 * THE SHAPE IS answer-web.ts's: Bun.serve on 127.0.0.1, an ephemeral port,
 * and a random per-process token every request must carry (`?t=` on a GET,
 * a `token` field in a POST body). A missing or wrong token is a 401.
 *
 * WHAT MAKES AN ACTION SAFE (Justin, 2026-10-17: "if I'm archiving one session
 * but the message gets mangled and it ends up deleting a different session …
 * That would be very bad"). `POST /api/action` names the session by its id
 * AND its session bead id AND the version of the card it was pressed on. The
 * server re-reads the inbox, never a cache, and refuses with 409 and a reason
 * the page prints verbatim when the session is not in it, when its bead id
 * differs, or when its card changed since (dashboard-plan.ts `cardVersion`).
 * Only then does it run ONE command, the one the TUI's key runs, through an
 * injected runner (tests pass a fake: no test ever runs archive or done).
 * Actions run one at a time. Every request is logged to
 * `<threadsStateDir>/dashboard-web.jsonl`: a `running` line before the
 * command (a log that cannot be written refuses the action; nothing runs
 * unrecorded) and an `outcome` line after.
 *
 * Rule 7: an inbox that cannot be read is a 500 with its reason (and a page
 * that says so), never an empty dashboard.
 */

import type {EnvLike} from './paths';

import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {findProjectRoot, silencedChildEnv} from '../health-notices';
import {openInBrowser} from './answer-web';
import {resolveThreadConfig} from './config';
import {renderDashboardPage, renderInboxHtml} from './dashboard-page';
import {
  type DashboardCommand,
  dashboardCommandText,
  type DashboardInbox,
  dashboardInboxOf,
  isDashboardAction,
  planAction,
} from './dashboard-plan';
import {type ThreadDashboardUi} from './defaults';
import {lookupPanes, realPaneSources} from './pane-join';
import {threadsStateDir} from './paths';
import {INBOX_DEFAULT_DAYS, inboxJson, readInbox} from './session-inbox';
import {sessionDisplayName} from './session-name';

export type InboxLoad =
  | {inbox: DashboardInbox; kind: 'read'}
  | {kind: 'failed'; reason: string};

/** What one command did. `error`: it could not be started (or timed out). */
export interface CommandRun {
  error: string | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Runs ONE command. The real one spawns; tests pass a recording fake. */
export type DashboardRunner = (
  command: DashboardCommand,
) => Promise<CommandRun>;

/** A command that has not exited after this long is killed and reported. */
export const DASHBOARD_COMMAND_TIMEOUT_MS = 60_000;

/** The real runner: argv spawned directly, a pane line through `sh -c`. */
export function realDashboardRunner(input: {
  cwd: string;
  env: EnvLike;
}): DashboardRunner {
  return async (command) =>
    await new Promise<CommandRun>((resolve) => {
      const [file, ...args] =
        command.kind === 'shell' ? ['sh', '-c', command.line] : command.argv;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (run: CommandRun): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        resolve(run);
      };
      const child = spawn(file ?? '', args, {
        cwd: input.cwd,
        // A child justin-sdk must not print health notices into the result.
        env: silencedChildEnv(input.env) as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({
          error: `still running after ${DASHBOARD_COMMAND_TIMEOUT_MS / 1000} s, so it was stopped`,
          status: null,
          stderr,
          stdout,
        });
      }, DASHBOARD_COMMAND_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) =>
        finish({error: error.message, status: null, stderr, stdout}),
      );
      child.on('close', (code) =>
        finish({error: null, status: code, stderr, stdout}),
      );
    });
}

/** The live inbox, read in-process the way `thread inbox --json` reads it. */
export function liveInboxLoader(input: {
  cwd: string;
  days: number;
  env: EnvLike;
}): () => Promise<InboxLoad> {
  return async () => {
    const result = await readInbox({
      cwd: input.cwd,
      days: input.days,
      env: input.env,
      lookupPanes: async () => await lookupPanes(realPaneSources(input.env)),
      now: new Date(),
      repo: null,
    });
    if (result.kind === 'failed') return result;
    const config = resolveThreadConfig({cwd: input.cwd, env: input.env});
    return {
      inbox: dashboardInboxOf(
        inboxJson(result.read, {pinnedProjects: config.pinnedProjects}),
      ),
      kind: 'read',
    };
  };
}

// ── The action log ──────────────────────────────────────────────────────────

export const DASHBOARD_LOG_FILE = 'dashboard-web.jsonl';

export function dashboardLogPath(stateDir: string): string {
  return join(stateDir, DASHBOARD_LOG_FILE);
}

/** One line of the log: the request as received, and what came of it. */
export interface DashboardLogEntry {
  at: string;
  /** The command, as `dashboardCommandText` prints it; null when none was chosen. */
  command: string | null;
  /** The command's exit code; null when it did not run or did not exit. */
  exit: number | null;
  httpStatus: number | null;
  outcome: 'failed' | 'ran' | 'refused' | 'shown' | null;
  /** First 2,000 characters of the command's stdout + stderr. */
  output: string | null;
  phase: 'outcome' | 'running';
  reason: string | null;
  /** The body as received, with the token replaced by whether it matched. */
  request: {
    action: unknown;
    sessionBeadId: unknown;
    sessionId: unknown;
    stateVersion: unknown;
    tokenOk: boolean;
  };
  requestId: string;
}

function appendLog(
  stateDir: string,
  entry: DashboardLogEntry,
): {ok: true} | {ok: false; reason: string} {
  try {
    mkdirSync(stateDir, {recursive: true});
    appendFileSync(dashboardLogPath(stateDir), `${JSON.stringify(entry)}\n`);
    return {ok: true};
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── The server ──────────────────────────────────────────────────────────────

export interface DashboardServer {
  /** Settles when the page stops the server, or `stop` is called. */
  done: Promise<'quit' | 'stopped'>;
  port: number;
  stop: () => void;
  token: string;
  url: string;
}

export interface DashboardServerOptions {
  /** Read fresh on every page load, every /api/state and every action. */
  loadInbox: () => Promise<InboxLoad>;
  /** 0 (the default) asks for an ephemeral port. */
  port?: number;
  runner: DashboardRunner;
  stateDir: string;
  token?: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: {'cache-control': 'no-store', 'content-type': 'application/json'},
    status,
  });
}

async function safeLoad(load: () => Promise<InboxLoad>): Promise<InboxLoad> {
  try {
    return await load();
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The command's output, cut for the log and the page. */
function outputOf(run: CommandRun): string {
  return `${run.stdout}${run.stderr}`.trim().slice(0, 2000);
}

export function createDashboardServer(
  options: DashboardServerOptions,
): DashboardServer {
  const token = options.token ?? crypto.randomUUID();

  let settle: (how: 'quit' | 'stopped') => void = () => {
    /* replaced below before anything can call it */
  };
  let settled = false;
  const done = new Promise<'quit' | 'stopped'>((resolve) => {
    settle = (how) => {
      if (settled) return;
      settled = true;
      resolve(how);
    };
  });

  // A state read already in flight is shared by the /api/state calls that
  // arrive meanwhile. Actions never share it: each re-reads after it starts.
  let inflight: Promise<InboxLoad> | null = null;
  const stateLoad = (): Promise<InboxLoad> => {
    inflight ??= safeLoad(options.loadInbox).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  // One action at a time, in the order they arrived.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function handleAction(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    const request = {
      action: body.action,
      sessionBeadId: body.sessionBeadId,
      sessionId: body.sessionId,
      stateVersion: body.stateVersion,
      tokenOk: body.token === token,
    };
    const finish = (
      status: number,
      fields: Pick<
        DashboardLogEntry,
        'command' | 'exit' | 'outcome' | 'output' | 'reason'
      >,
      reply: Record<string, unknown>,
    ): Response => {
      const logged = appendLog(options.stateDir, {
        at: new Date().toISOString(),
        httpStatus: status,
        phase: 'outcome',
        request,
        requestId,
        ...fields,
      });
      return json(
        logged.ok
          ? reply
          : {
              ...reply,
              logError: `this outcome was NOT logged to ${dashboardLogPath(options.stateDir)}: ${logged.reason}`,
            },
        status,
      );
    };
    const refuse = (
      status: number,
      reason: string,
      command: string | null = null,
    ) =>
      finish(
        status,
        {command, exit: null, outcome: 'refused', output: null, reason},
        {error: reason, refused: true},
      );

    if (!request.tokenOk) {
      return refuse(
        401,
        'Wrong or missing token. Open the URL `thread dashboard --web` printed. Nothing was run.',
      );
    }
    const {action, sessionId, sessionBeadId, stateVersion} = body;
    if (!isDashboardAction(action)) {
      return refuse(
        400,
        `Unknown action ${JSON.stringify(action)}. Nothing was run.`,
      );
    }
    if (typeof sessionId !== 'string' || sessionId === '') {
      return refuse(400, 'The request names no session id. Nothing was run.');
    }
    if (sessionBeadId !== null && typeof sessionBeadId !== 'string') {
      return refuse(
        400,
        'The request carries no session bead id (a string, or null for an untracked session). Nothing was run.',
      );
    }
    if (typeof stateVersion !== 'string' || stateVersion === '') {
      return refuse(
        400,
        'The request carries no card version. Nothing was run.',
      );
    }

    // Fresh, never the cache: the check is against the inbox as it is now.
    const load = await safeLoad(options.loadInbox);
    if (load.kind === 'failed') {
      return finish(
        500,
        {
          command: null,
          exit: null,
          outcome: 'failed',
          output: null,
          reason: load.reason,
        },
        {
          error: `The inbox could not be read, so nothing was run: ${load.reason}`,
        },
      );
    }
    const session = load.inbox.sessions.find((s) => s.sessionId === sessionId);
    if (session == null) {
      return refuse(
        409,
        `Session ${sessionId} is not in the inbox any more (it may have moved out of the window). Nothing was run.`,
      );
    }
    const name = sessionDisplayName(session.card.repoTag, session.card.title);
    if (session.sessionBeadId !== sessionBeadId) {
      return refuse(
        409,
        `The page says session ${sessionId} has session bead ${String(sessionBeadId)}, but the inbox now says ${String(session.sessionBeadId)}. Nothing was run; the page has been refreshed.`,
      );
    }
    if (session.stateVersion !== stateVersion) {
      return refuse(
        409,
        `${name} changed since the page showed it (new activity, or it moved section; it is now under "${session.section}"). Nothing was run; the page has been refreshed, so look at the card again and press again.`,
      );
    }

    const plan = planAction(action, session, load.inbox.readMarksFailure);
    if (plan.kind === 'refused') return refuse(409, plan.reason);
    if (plan.kind === 'show') {
      return finish(
        200,
        {
          command: null,
          exit: null,
          outcome: 'shown',
          output: null,
          reason: null,
        },
        {
          message: `Resume command for ${name}: ${plan.text}`,
          ok: true,
          text: plan.text,
        },
      );
    }

    const commandText = dashboardCommandText(plan.command);
    // Recorded BEFORE it runs: a command never runs without a log line.
    const before = appendLog(options.stateDir, {
      at: new Date().toISOString(),
      command: commandText,
      exit: null,
      httpStatus: null,
      outcome: null,
      output: null,
      phase: 'running',
      reason: null,
      request,
      requestId,
    });
    if (!before.ok) {
      return json(
        {
          error: `The action log ${dashboardLogPath(options.stateDir)} could not be written (${before.reason}), so nothing was run.`,
          refused: true,
        },
        500,
      );
    }
    const run = await options.runner(plan.command);
    const output = outputOf(run);
    if (run.error != null || run.status !== 0) {
      const why =
        run.error ??
        `exit ${String(run.status)}${output === '' ? '' : `: ${output}`}`;
      return finish(
        502,
        {
          command: commandText,
          exit: run.status,
          outcome: 'failed',
          output,
          reason: why,
        },
        {error: `${name}: ran ${commandText} and it failed (${why}).`},
      );
    }
    return finish(
      200,
      {command: commandText, exit: 0, outcome: 'ran', output, reason: null},
      {
        message: `${name}: ran ${commandText} (exit 0)${output === '' ? '' : `: ${output.split('\n')[0] ?? ''}`}`,
        ok: true,
      },
    );
  }

  async function readBody(
    request: Request,
  ): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = await request.json();
      return parsed != null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  const server = Bun.serve({
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === 'GET') {
        if (url.searchParams.get('t') !== token) {
          return new Response(
            'thread dashboard: wrong or missing token. Open the URL `thread dashboard --web` printed.',
            {status: 401},
          );
        }
        if (url.pathname === '/') {
          const load = await stateLoad();
          const nonce = crypto.randomUUID();
          return new Response(
            renderDashboardPage({
              inbox:
                load.kind === 'read'
                  ? {inbox: load.inbox}
                  : {failed: load.reason},
              nonce,
              token,
            }),
            {
              headers: {
                'cache-control': 'no-store',
                'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
                'content-type': 'text/html; charset=utf-8',
              },
              status: load.kind === 'read' ? 200 : 500,
            },
          );
        }
        if (url.pathname === '/api/state') {
          const load = await stateLoad();
          if (load.kind === 'failed') {
            return json(
              {error: `The inbox could not be read: ${load.reason}`},
              500,
            );
          }
          return json({
            html: renderInboxHtml(load.inbox),
            problems: load.inbox.problems,
            sessions: load.inbox.sessions,
            stateVersion: load.inbox.stateVersion,
            summary: load.inbox.summary,
          });
        }
        return new Response('not found', {status: 404});
      }

      if (request.method === 'POST') {
        const body = await readBody(request);
        if (body == null) {
          return json(
            {error: 'The request body is not a JSON object. Nothing was run.'},
            400,
          );
        }
        if (url.pathname === '/api/action') {
          return await serial(async () => await handleAction(body));
        }
        if (url.pathname === '/api/quit') {
          if (body.token !== token) {
            return json({error: 'Wrong or missing token.'}, 401);
          }
          settle('quit');
          return json({ok: true});
        }
        if (body.token !== token) {
          return json({error: 'Wrong or missing token.'}, 401);
        }
        return json({error: 'not found'}, 404);
      }

      return new Response('method not allowed', {status: 405});
    },
    // 127.0.0.1, never 0.0.0.0: these buttons archive sessions.
    hostname: '127.0.0.1',
    port: options.port ?? 0,
  });

  const port = server.port;
  if (port == null) {
    void server.stop(true);
    throw new Error(
      'thread dashboard: Bun.serve bound no TCP port, so there is no URL to open.',
    );
  }

  void done.then(() => {
    // A short grace period so the quit reply reaches the page first.
    setTimeout(() => void server.stop(true), 250).unref?.();
  });

  return {
    done,
    port,
    stop: () => {
      settle('stopped');
      void server.stop(true);
    },
    token,
    url: `http://127.0.0.1:${port}/?t=${token}`,
  };
}

// ── The commands ────────────────────────────────────────────────────────────

export interface DashboardWebOptions {
  cwd?: string;
  days?: number;
  env?: EnvLike;
  /** Tests replace the live inbox read. */
  loadInbox?: () => Promise<InboxLoad>;
  /** Called once the server is listening (tests drive it from here). */
  onReady?: (server: DashboardServer) => void;
  /** False: only print the URL. */
  openBrowser?: boolean;
  port?: number;
  /** Tests pass a fake: no test runs archive or done for real. */
  runner?: DashboardRunner;
}

/** `thread dashboard --web`: serve the page until it is stopped. Exit 0. */
export async function runThreadDashboardWeb(
  options: DashboardWebOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const days =
    options.days != null && Number.isFinite(options.days) && options.days > 0
      ? options.days
      : INBOX_DEFAULT_DAYS;
  const stateDir = threadsStateDir(env);
  const server = createDashboardServer({
    loadInbox: options.loadInbox ?? liveInboxLoader({cwd, days, env}),
    port: options.port,
    runner: options.runner ?? realDashboardRunner({cwd, env}),
    stateDir,
  });
  console.log(
    `thread dashboard (web, experiment) · sessions active in the last ${days} days`,
  );
  console.log(server.url);
  options.onReady?.(server);
  if (options.openBrowser !== false) {
    const opened = openInBrowser(server.url);
    if (!opened.opened) {
      console.error(
        `thread dashboard: could not open a browser (${opened.reason}); open the URL above yourself.`,
      );
    }
  }
  console.log(
    `Every action is logged to ${dashboardLogPath(stateDir)}. Ctrl-C or "Stop server" on the page stops it.`,
  );
  const onSigint = (): void => {
    console.log('');
    console.log('Stopped.');
    server.stop();
  };
  process.on('SIGINT', onSigint);
  try {
    await server.done;
  } finally {
    process.off('SIGINT', onSigint);
  }
  return 0;
}

/** Where the threads TUI lives: a home-base checkout at or above `cwd`, or null. */
export function threadsTuiRoot(cwd: string): string | null {
  const root = findProjectRoot(cwd);
  return existsSync(join(root, 'src', 'threads-dash', 'threads.ts'))
    ? root
    : null;
}

export const TUI_ELSEWHERE =
  'The threads TUI is part of home-base (src/threads-dash). Run it there: cd ~/Dev/home-base && bun run threads. Or open the web experiment here: bun run justin-sdk thread dashboard --web';

/**
 * `thread dashboard [--web | --tui]`: --web or --tui wins, else the
 * dashboardUi knob (default tui). The TUI is spawned in home-base when this
 * checkout is one; elsewhere it prints how to run it and exits 2.
 */
export async function runThreadDashboard(options: {
  cwd?: string;
  days?: number;
  env?: EnvLike;
  openBrowser?: boolean;
  port?: number;
  ui: ThreadDashboardUi | null;
}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let ui = options.ui;
  if (ui == null) {
    const config = resolveThreadConfig({cwd, env});
    for (const problem of config.problems) {
      if (problem.includes('dashboardUi'))
        console.error(`thread dashboard: ${problem}`);
    }
    ui = config.dashboardUi;
  }
  if (ui === 'web') {
    return await runThreadDashboardWeb({
      cwd,
      days: options.days,
      env,
      openBrowser: options.openBrowser,
      port: options.port,
    });
  }
  const root = threadsTuiRoot(cwd);
  if (root == null) {
    console.error(TUI_ELSEWHERE);
    return 2;
  }
  return await new Promise<number>((resolve) => {
    const child = spawn('bun', ['run', 'threads'], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(
        `thread dashboard: could not start the TUI: ${error.message}`,
      );
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
