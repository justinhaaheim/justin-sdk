/**
 * The scripted world the justin-loop runner is tested against.
 *
 * `claude --bg`, `claude agents --json`, `claude stop`, `br`, the clock, the
 * ledger and both output streams are all fakes here: nothing spawns a process
 * and nothing writes to the real state directory. Extracted from
 * tests/justin-loop-session.test.ts (home-base-1r6d.33.2) when
 * home-base-1r6d.33.3 needed the same world for the yield-enforcement tests.
 *
 * The world knows two kinds of `claude --bg` call, and the difference is the
 * whole point of several tests:
 *   - a SPAWN (`--bg --name …`) mints a new session `sess-N`;
 *   - a RESUME (`--bg --resume <full sessionId> <prompt>`) wakes the session
 *     that id belongs to — same id, same conversation, MEASURED 2026-09-08.
 */
import {type BrRunner} from '../src/justin-loop/br';
import {
  type Handoff,
  HANDOFF_LABEL,
  handoffJson,
} from '../src/justin-loop/handoff';
import {
  type AgentRow,
  type BootContext,
  DEFAULT_OPTIONS,
  type JustinLoopOptions,
  type LedgerRow,
  type LedgerSessionIdRead,
  runJustinLoop,
  type RunnerDeps,
  runSession,
  type SessionRun,
} from '../src/justin-loop/runner';

/**
 * A ledger reader that must never be called (33.12).
 *
 * Only `runJustinLoop`, and only when the run BOOTS from a picked-up handoff
 * bead, looks a predecessor up. Every world that drives `runSession` directly —
 * and every loop world whose run starts fresh — gets this, so a future change
 * that started reading the ledger from somewhere else fails loudly here instead
 * of quietly reading the REAL `~/.local/state/justin-sdk/justin-loop/runs.jsonl`
 * from inside a unit test.
 */
export function ledgerReaderNeverCalled(
  path: string,
  label: string,
): LedgerSessionIdRead {
  throw new Error(
    `readLedgerSessionId(${path}, ${label}) was called in a world that has no ledger`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    arc: 'home-base-1r6d.33',
    branch: 'worktree-justin-loop-runner',
    contextTokens: 302_000,
    createdAt: '2026-09-08T04:00:00Z',
    disposition: 'continue',
    from: 'the-arc-1',
    next: 'Finish the parser, then run bun test and report the exact count.',
    openQuestions: [],
    schemaVersion: 1,
    state: 'The parser is half written and nothing is committed yet.',
    worktree: '/Users/jhaa/Dev/home-base',
    ...over,
  };
}

export interface BeadSpec {
  id: string;
  labels?: string[];
  notes?: string | null;
  title?: string;
}

export function listJson(beads: BeadSpec[]): string {
  return JSON.stringify({
    issues: beads.map((b) => ({
      id: b.id,
      labels: b.labels ?? [HANDOFF_LABEL],
      ...(b.notes === undefined ? {} : {notes: b.notes}),
      status: 'open',
      title: b.title ?? 'HANDOFF continue: an arc',
      updated_at: '2026-09-08T04:00:00Z',
    })),
    total: beads.length,
  });
}

/** A handoff bead written by session `from`. */
export function beadFrom(id: string, over: Partial<Handoff> = {}): BeadSpec {
  return {id, notes: handoffJson(handoff(over)), title: `HANDOFF: ${id}`};
}

// ---------------------------------------------------------------------------
// The scripted world
// ---------------------------------------------------------------------------

/** What `claude stop` does to this session's row. */
export type StopBehaviour =
  /** The measured normal case: the row leaves `claude agents` within a poll. */
  | 'clears'
  /** Nothing we do removes it. The kill-failed path. */
  | 'lingers'
  /** Survives everything and has no pid to signal. The no-pid path. */
  | 'lingers-pidless'
  /** Survives `claude stop` twice, then dies on a signal. */
  | 'clears-on-signal';

export interface SessionScript {
  /**
   * What each RESUMED turn does, in order. A demand beyond this list behaves
   * like `{}`: the woken session ends on its first poll and its stop clears the
   * row, which is the measured normal case.
   */
  demandTurns?: SessionScript[];
  /**
   * Publish no `sessionId` on the row. The runner then has nothing `--resume`
   * would continue rather than copy, so no demand can be delivered
   * (home-base-1r6d.33.3).
   */
  noSessionId?: boolean;
  /** The row's `state` while the runner polls it. Default: ends immediately. */
  state?: string;
  stop?: StopBehaviour;
  /** Never register a row at all — the session vanished before the first poll. */
  vanishes?: boolean;
  /** Poll count before the state above flips to `done`. Default 0. */
  worksForPolls?: number;
}

/**
 * One `claude --bg` invocation, argv and environment TOGETHER (D18).
 *
 * One record rather than two index-aligned arrays: "which env went with which
 * argv" must not be answerable only by counting, or a test that asserts an env
 * var on the wrong dispatch reads as green (critical rule 7 — half a measurement
 * must be unrepresentable).
 */
export interface DispatchCall {
  args: string[];
  env: Record<string, string>;
}

export interface LoopResult {
  /** br argv, in order. */
  brCalls: string[][];
  /** Every `claude --bg` invocation, argv AND env, in order. */
  dispatchCalls: DispatchCall[];
  /** Every `claude --bg` argv, in order. Derived from `dispatchCalls`. */
  dispatches: string[][];
  /**
   * Every dispatch, stop and `br` call INTERLEAVED, in the order they happened:
   * `dispatch:spawn`, `dispatch:resume`, `stop:<id>`, `br:<subcommand>`.
   *
   * The separate arrays above cannot answer an ORDERING question, and two of the
   * runner's invariants are purely about order: a session is stopped and
   * confirmed gone BEFORE its beads are read (D6), and no successor is dispatched
   * until then. Asserting those from `stopCalls` and `brCalls` separately proves
   * only that both happened.
   */
  events: string[];
  exitCode: number;
  ledger: LedgerRow[];
  signals: {pid: number; sig: string}[];
  stderr: string;
  stdout: string;
  stopCalls: string[];
}

export const MAX_POLLS = 500;

/**
 * Run the whole loop against a scripted world.
 *
 * `scans` are the answers to `br list -l handoff --json`, IN CALL ORDER: the
 * first is the start-of-run scan, then one per session that ends normally. A
 * scan beyond the end of the list answers "no open handoff beads", which is the
 * honest default for a repo where nothing is waiting.
 */
export async function runLoop(spec: {
  /** false on a given global poll = `claude agents --json` failed that time. */
  agentsReadable?: (poll: number) => boolean;
  /**
   * Make `br close` fail, so the `done` bead cannot be closed (D14). The run
   * still finished, so this must be loud on stderr and must NOT change the exit
   * code — which is exactly what this knob exists to prove.
   */
  brCloseFails?: boolean;
  /** Make `br create` fail, so the failure bead cannot be filed. */
  brCreateFails?: boolean;
  /**
   * Make every HEAD read fail, so `progressed` is null — NOT false
   * (home-base-a1go). The normal world hands back a different sha per dispatch,
   * i.e. every session commits, so this is the only way to reach the paths that
   * treat "we could not measure" differently from "nothing happened".
   */
  gitHeadFails?: boolean;
  /** Hand back one fixed sha, so every session is MEASURED to have committed nothing. */
  gitHeadStuck?: boolean;
  /**
   * Rows already in `runs.jsonl` when this run starts, oldest first (33.12).
   * What a `--pickup` run finds when it looks up the session that wrote the
   * bead it is booting from. `fullSessionId: null` is a session whose `claude
   * agents` row was never read — a failed measurement, not an absent one.
   */
  ledgerSeed?: {fullSessionId: string | null; label: string}[];
  /** The ledger file itself could not be read, and this is why. */
  ledgerUnreadable?: string;
  /**
   * Rows the listing SKIPPED on a given global poll (F7, 33.13). The listing is
   * still READABLE — `claude agents --json` answered — but it did not answer in
   * full, so an id missing from it is not proof of absence.
   */
  malformedAt?: (poll: number) => number;
  opts?: Partial<JustinLoopOptions>;
  scans?: (BeadSpec[] | 'unavailable')[];
  sessions?: SessionScript[];
}): Promise<LoopResult> {
  const rows = new Map<string, AgentRow>();
  const scriptOf = new Map<string, SessionScript>();
  /** The session each FULL session id belongs to — what `--resume` looks up. */
  const idBySessionId = new Map<string, string>();
  /** The original script of each session, so its demand turns can be replayed. */
  const bornAs = new Map<string, SessionScript>();
  const demandsFor = new Map<string, number>();
  const dispatchCalls: DispatchCall[] = [];
  const stopCalls: string[] = [];
  const signals: {pid: number; sig: string}[] = [];
  const ledger: LedgerRow[] = [];
  const brCalls: string[][] = [];
  const events: string[] = [];
  let stdout = '';
  let stderr = '';
  let clock = Date.UTC(2026, 8, 8, 11, 30, 0);
  let scanIndex = 0;
  let dispatched = 0;
  let polls = 0;
  const pollsFor = new Map<string, number>();

  let created = 0;
  const br: BrRunner = (_cwd, args) => {
    brCalls.push(args);
    events.push(`br:${args[0] ?? ''}`);
    if (args[0] === 'create') {
      if (spec.brCreateFails === true) {
        return {
          ok: false,
          reason: 'br exited 1: no beads workspace',
          stderr: null,
          stdout: '',
        };
      }
      created++;
      // The real `br create` line shape (see parseCreatedId).
      return {
        ok: true,
        reason: null,
        stderr: null,
        stdout: `✓ Created fx-bug${created}: ${args[1] ?? ''}\n`,
      };
    }
    if (args[0] === 'close') {
      if (spec.brCloseFails === true) {
        // Three stderr lines, the shape a real `br close` failure has (F4):
        // the summary line `reason` keeps, and the two that say WHY.
        return {
          ok: false,
          reason: 'br exited 1: no issue with id hoff-9',
          stderr: [
            'no issue with id hoff-9',
            'did you mean hoff-8?',
            'run `br list` to see what is open',
          ].join('\n'),
          stdout: '',
        };
      }
      return {
        ok: true,
        reason: null,
        stderr: null,
        stdout: `✓ Closed ${args[1] ?? ''}\n`,
      };
    }
    if (args[0] !== 'list')
      return {ok: true, reason: null, stderr: null, stdout: '{"issues":[]}'};
    const answer = (spec.scans ?? [])[scanIndex++];
    if (answer === 'unavailable') {
      return {
        ok: false,
        reason: 'br exited 1: no beads workspace',
        stderr: null,
        stdout: '',
      };
    }
    return {
      ok: true,
      reason: null,
      stderr: null,
      stdout: listJson(answer ?? []),
    };
  };

  /**
   * Put a session's row into `claude agents` and arm its script for this turn.
   * Shared by the first dispatch and by every resume, because a woken session
   * is listed exactly like a fresh one.
   */
  function register(id: string, script: SessionScript, name: string): void {
    scriptOf.set(id, script);
    pollsFor.set(id, 0);
    if (script.vanishes === true) return;
    // MEASURED: `id` is the first 8 characters of `sessionId`. The near-miss is
    // the whole hazard — `--resume <short id>` starts a COPY.
    const sessionId = script.noSessionId === true ? null : `${id}-full-uuid`;
    if (sessionId != null) idBySessionId.set(sessionId, id);
    rows.set(id, {
      id,
      name,
      // MEASURED: a live row carries a pid; an ended one keeps it.
      pid: 4000 + dispatched,
      sessionId,
      // A session with a working period starts `working`; otherwise it is
      // already `done` on the first poll, which is the common case here.
      state:
        script.state ?? (script.worksForPolls != null ? 'working' : 'done'),
      status: 'idle',
      waitingFor: null,
    });
  }

  const deps: RunnerDeps = {
    appendLedgerRow: (_path, row) => {
      ledger.push(row);
      return {ok: true, reason: null};
    },
    br,
    // Every child-call fake is `async` because the DEPENDENCY TYPES are
    // Promise-returning (home-base-a1go): the runner may not make a synchronous
    // spawn again, and a world whose fakes were sync would let one back in
    // without a single test going red.
    dispatch: (_cwd, args, env) => {
      dispatchCalls.push({args, env});
      events.push(
        args.includes('--resume') ? 'dispatch:resume' : 'dispatch:spawn',
      );

      // A `--resume` WAKES an existing session (MEASURED 2026-09-08): same id,
      // same sessionId, same conversation. It must never mint a new one here,
      // or the "no successor is spawned on a demand path" tests would be
      // measuring the wrong thing.
      const resumeAt = args.indexOf('--resume');
      if (resumeAt >= 0) {
        const full = args[resumeAt + 1] ?? '';
        const id = idBySessionId.get(full);
        if (id == null) {
          // The real CLI prints an error and no banner for an unknown id.
          return Promise.resolve(`No session matching '${full}'.\n`);
        }
        const turn = demandsFor.get(id) ?? 0;
        demandsFor.set(id, turn + 1);
        const script = (bornAs.get(id)?.demandTurns ?? [])[turn] ?? {};
        register(id, script, 'resumed');
        return Promise.resolve(`backgrounded · ${id} · resumed\n`);
      }

      dispatched++;
      const id = `sess-${dispatched}`;
      const script = (spec.sessions ?? [])[dispatched - 1] ?? {};
      bornAs.set(id, script);
      register(id, script, args[args.indexOf('--name') + 1] ?? '');
      return Promise.resolve(
        `backgrounded · ${id} · ${args[args.indexOf('--name') + 1] ?? ''}\n`,
      );
    },
    findAgent: (_cwd, id) => {
      polls++;
      if (polls > MAX_POLLS) {
        throw new Error(
          `runJustinLoop did not terminate within ${MAX_POLLS} polls`,
        );
      }
      if (spec.agentsReadable?.(polls) === false) {
        return Promise.resolve({
          ok: false,
          reason: 'claude agents --json exited 1',
        });
      }
      const malformed = spec.malformedAt?.(polls) ?? 0;
      const row = rows.get(id);
      if (row == null) return Promise.resolve({malformed, ok: true, row: null});
      const script = scriptOf.get(id) ?? {};
      const seen = (pollsFor.get(id) ?? 0) + 1;
      pollsFor.set(id, seen);
      // A session that "works for N polls" flips to done afterwards, so a
      // timeout test can hold it working forever with a large N.
      if (script.worksForPolls != null && seen > script.worksForPolls) {
        return Promise.resolve({
          malformed,
          ok: true,
          row: {...row, state: 'done'},
        });
      }
      return Promise.resolve({malformed, ok: true, row});
    },
    gitHead: () =>
      Promise.resolve(
        spec.gitHeadFails === true
          ? {
              ok: false,
              reason:
                'git rev-parse HEAD did not finish within 10000ms and was SIGKILLed',
            }
          : {
              ok: true,
              sha:
                spec.gitHeadStuck === true
                  ? 'head-fixed'
                  : `head-${dispatched}`,
            },
      ),
    notifyBlocked: () => {
      /* nothing is notified in the fake world */
    },
    now: () => clock,
    preflight: () => Promise.resolve([]),
    readLedgerSessionId: (_path, label) => {
      if (spec.ledgerUnreadable != null) {
        return {kind: 'unreadable', reason: spec.ledgerUnreadable};
      }
      // Newest first, and the search STOPS at the newest match — the same rule
      // the real reader follows, so a null id here can never fall through to an
      // older row belonging to a different run's session of the same name.
      const row = [...(spec.ledgerSeed ?? [])]
        .reverse()
        .find((r) => r.label === label);
      if (row == null) {
        return {detail: `no ledger row for \`${label}\``, kind: 'no-row'};
      }
      return row.fullSessionId == null
        ? {
            detail: `the newest ledger row for \`${label}\` carries no fullSessionId`,
            kind: 'no-session-id',
          }
        : {kind: 'found', sessionId: row.fullSessionId};
    },
    readUsage: () =>
      Promise.resolve({kind: 'failed', reason: 'no /usage in this fixture'}),
    signalPid: (pid, sig) => {
      signals.push({pid, sig: String(sig)});
      for (const [id, row] of rows) {
        if (row.pid === pid && scriptOf.get(id)?.stop === 'clears-on-signal') {
          rows.delete(id);
        }
      }
      return true;
    },
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    stopSession: (_cwd, id) => {
      stopCalls.push(id);
      events.push(`stop:${id}`);
      const behaviour = scriptOf.get(id)?.stop ?? 'clears';
      if (behaviour === 'clears') rows.delete(id);
      if (behaviour === 'lingers-pidless') {
        const row = rows.get(id);
        if (row != null) rows.set(id, {...row, pid: null});
      }
      return Promise.resolve({detail: `stopped ${id}`, ok: true});
    },
    write: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
  };

  const exitCode = await runJustinLoop(
    '/repo',
    {maxSessions: 2, usageGate: false, ...spec.opts},
    deps,
  );
  return {
    brCalls,
    dispatchCalls,
    dispatches: dispatchCalls.map((call) => call.args),
    events,
    exitCode,
    ledger,
    signals,
    stderr,
    stdout,
    stopCalls,
  };
}

// ---------------------------------------------------------------------------
// One session, watched
// ---------------------------------------------------------------------------

export interface SessionSim {
  /** Every `br` argv the watch made, in order. */
  brCalls: string[][];
  /** Simulated minutes from dispatch to return. */
  elapsedMin: number;
  polls: number;
  run: SessionRun;
  stdout: string;
}

/**
 * Run ONE session against a scripted `claude agents` row sequence and a scripted
 * `br`, on a fake clock that only moves when the loop sleeps.
 *
 * Why this exists next to `runLoop`: the handoff-settle scan (D15) is a property
 * of the WATCH — which polls it fires on, which rows it fires for, what it does
 * with a scan it could not make — and driving it through the whole loop would
 * mean asserting on it through two bead reads and a stop ladder. This drives
 * `runSession` directly and hands back the raw ending.
 *
 * tests/justin-loop-blocked.test.ts has an older local `simulate` of the same
 * shape, from before a `br` script or the watch's stdout mattered. The two have
 * not been merged: that file's 40-odd passing tests are the D3/D7/D8 contract and
 * are not worth re-baselining for a helper move.
 */
export async function simulateSession(spec: {
  /**
   * Answer to the Nth (1-based) `br list -l handoff --json` the watch makes.
   * Omitted = every scan finds no beads at all, which is what a repo with
   * nothing waiting looks like.
   */
  beadsAt?: (call: number) => BeadSpec[] | 'unavailable';
  /** The session's label — the `from` its handoff bead must carry. */
  label?: string;
  maxPolls?: number;
  opts?: Partial<JustinLoopOptions>;
  /** 1-based on the poll number. `'unreadable'` = `claude agents` failed. */
  rowAt: (poll: number) => AgentRow | null | 'unreadable';
}): Promise<SessionSim> {
  const opts: JustinLoopOptions = {
    ...DEFAULT_OPTIONS,
    // One poll = one simulated minute, so every liveness tick is one poll and
    // every duration below reads in minutes without arithmetic.
    pollSec: 60,
    ...spec.opts,
  };
  const label = spec.label ?? 'the-arc-1';
  const boot: BootContext = {
    cwd: '/repo',
    label,
    plan: {kind: 'fresh'},
    predecessorSessionId: null,
  };
  const maxPolls = spec.maxPolls ?? 400;

  let clock = 1_000_000;
  const started = clock;
  let polls = 0;
  let listCalls = 0;
  let stdout = '';
  const brCalls: string[][] = [];

  const deps: RunnerDeps = {
    appendLedgerRow: () => ({ok: true, reason: null}),
    br: (_cwd, args) => {
      brCalls.push(args);
      if (args[0] !== 'list')
        return {ok: true, reason: null, stderr: null, stdout: '{"issues":[]}'};
      const answer = spec.beadsAt?.(++listCalls) ?? [];
      return answer === 'unavailable'
        ? {
            ok: false,
            reason: 'br exited 1: no beads workspace',
            stderr: null,
            stdout: '',
          }
        : {ok: true, reason: null, stderr: null, stdout: listJson(answer)};
    },
    dispatch: () =>
      Promise.resolve(`backgrounded · sim-1 · 2026-09-08 04:30 ${label}\n`),
    findAgent: () => {
      polls++;
      if (polls > maxPolls) {
        throw new Error(
          `runSession did not terminate within ${maxPolls} polls`,
        );
      }
      const row = spec.rowAt(polls);
      return Promise.resolve(
        row === 'unreadable'
          ? {ok: false, reason: 'claude agents --json exited 1'}
          : {malformed: 0, ok: true, row},
      );
    },
    gitHead: () => Promise.resolve({ok: true, sha: 'abc123'}),
    notifyBlocked: () => {
      /* nothing is notified in the fake world */
    },
    now: () => clock,
    preflight: () => Promise.resolve([]),
    readLedgerSessionId: ledgerReaderNeverCalled,
    readUsage: () =>
      Promise.resolve({kind: 'failed', reason: 'no /usage in this fixture'}),
    signalPid: () => true,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    stopSession: () => Promise.resolve({detail: 'stopped sim-1', ok: true}),
    write: (text) => {
      stdout += text;
    },
    writeErr: () => {
      /* stderr is not asserted in this test */
    },
  };

  const run = await runSession(
    '/repo',
    opts,
    1,
    boot,
    '2026-09-08 04:30 the-arc-1',
    deps,
  );
  return {
    brCalls,
    elapsedMin: Math.round((clock - started) / 60_000),
    polls,
    run,
    stdout,
  };
}

/**
 * The n-th element, or a thrown failure.
 *
 * An indexed read is `T | undefined`, and defaulting that away would let "there
 * was no such dispatch" pass as "the dispatch was empty" — the assertion would
 * then be about the wrong thing, and would report the wrong thing when it went
 * red (critical rule 6). Throwing names the index and the length instead.
 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(
      `expected an element at index ${index}, but there were ${items.length}`,
    );
  }
  return value;
}

export function argOf(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? '') : '';
}

/** `claude --bg … <prompt>` — the prompt is the last positional. */
export function promptOf(args: string[]): string {
  return args[args.length - 1] ?? '';
}

/**
 * Dispatches that START a session — i.e. successors.
 *
 * A `--resume` demand (home-base-1r6d.33.3) is also a `claude --bg` call, so
 * counting raw dispatches would make "no successor was spawned" pass or fail for
 * the wrong reason. This is the assertion the "never spawns" tests actually mean.
 */
export function spawns(dispatches: string[][]): string[][] {
  return dispatches.filter((d) => !d.includes('--resume'));
}

/** Dispatches that WAKE the session that is already there. */
export function resumes(dispatches: string[][]): string[][] {
  return dispatches.filter((d) => d.includes('--resume'));
}

/** `spawns`, but keeping each call's environment attached to its argv (D18). */
export function spawnCalls(calls: DispatchCall[]): DispatchCall[] {
  return calls.filter((call) => !call.args.includes('--resume'));
}
