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
import {
  type Handoff,
  HANDOFF_LABEL,
  handoffJson,
} from '../src/justin-loop/handoff';
import {type BrRunner} from '../src/justin-loop/br';
import {
  type AgentRow,
  type JustinLoopOptions,
  type LedgerRow,
  runJustinLoop,
  type RunnerDeps,
} from '../src/justin-loop/runner';

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
  notes?: string | null;
  title?: string;
  labels?: string[];
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
  /** The row's `state` while the runner polls it. Default: ends immediately. */
  state?: string;
  /** Poll count before the state above flips to `done`. Default 0. */
  worksForPolls?: number;
  stop?: StopBehaviour;
  /** Never register a row at all — the session vanished before the first poll. */
  vanishes?: boolean;
  /**
   * Publish no `sessionId` on the row. The runner then has nothing `--resume`
   * would continue rather than copy, so no demand can be delivered
   * (home-base-1r6d.33.3).
   */
  noSessionId?: boolean;
  /**
   * What each RESUMED turn does, in order. A demand beyond this list behaves
   * like `{}`: the woken session ends on its first poll and its stop clears the
   * row, which is the measured normal case.
   */
  demandTurns?: SessionScript[];
}

export interface LoopResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every `claude --bg` argv, in order. */
  dispatches: string[][];
  stopCalls: string[];
  signals: Array<{pid: number; sig: string}>;
  ledger: LedgerRow[];
  /** br argv, in order. */
  brCalls: string[][];
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
  opts?: Partial<JustinLoopOptions>;
  scans?: Array<BeadSpec[] | 'unavailable'>;
  sessions?: SessionScript[];
  /** false on a given global poll = `claude agents --json` failed that time. */
  agentsReadable?: (poll: number) => boolean;
  /** Make `br create` fail, so the failure bead cannot be filed. */
  brCreateFails?: boolean;
}): Promise<LoopResult> {
  const rows = new Map<string, AgentRow>();
  const scriptOf = new Map<string, SessionScript>();
  /** The session each FULL session id belongs to — what `--resume` looks up. */
  const idBySessionId = new Map<string, string>();
  /** The original script of each session, so its demand turns can be replayed. */
  const bornAs = new Map<string, SessionScript>();
  const demandsFor = new Map<string, number>();
  const dispatches: string[][] = [];
  const stopCalls: string[] = [];
  const signals: Array<{pid: number; sig: string}> = [];
  const ledger: LedgerRow[] = [];
  const brCalls: string[][] = [];
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
    if (args[0] === 'create') {
      if (spec.brCreateFails === true) {
        return {
          ok: false,
          reason: 'br exited 1: no beads workspace',
          stdout: '',
        };
      }
      created++;
      // The real `br create` line shape (see parseCreatedId).
      return {
        ok: true,
        reason: null,
        stdout: `✓ Created fx-bug${created}: ${args[1] ?? ''}\n`,
      };
    }
    if (args[0] !== 'list')
      return {ok: true, reason: null, stdout: '{"issues":[]}'};
    const answer = (spec.scans ?? [])[scanIndex++];
    if (answer === 'unavailable') {
      return {ok: false, reason: 'br exited 1: no beads workspace', stdout: ''};
    }
    return {ok: true, reason: null, stdout: listJson(answer ?? [])};
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
    dispatch: (_cwd, args) => {
      dispatches.push(args);

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
          return `No session matching '${full}'.\n`;
        }
        const turn = demandsFor.get(id) ?? 0;
        demandsFor.set(id, turn + 1);
        const script = (bornAs.get(id)?.demandTurns ?? [])[turn] ?? {};
        register(id, script, 'resumed');
        return `backgrounded · ${id} · resumed\n`;
      }

      dispatched++;
      const id = `sess-${dispatched}`;
      const script = (spec.sessions ?? [])[dispatched - 1] ?? {};
      bornAs.set(id, script);
      register(id, script, args[args.indexOf('--name') + 1] ?? '');
      return `backgrounded · ${id} · ${args[args.indexOf('--name') + 1] ?? ''}\n`;
    },
    findAgent: (_cwd, id) => {
      polls++;
      if (polls > MAX_POLLS) {
        throw new Error(
          `runJustinLoop did not terminate within ${MAX_POLLS} polls`,
        );
      }
      if (spec.agentsReadable?.(polls) === false) {
        return {ok: false, reason: 'claude agents --json exited 1'};
      }
      const row = rows.get(id);
      if (row == null) return {ok: true, row: null};
      const script = scriptOf.get(id) ?? {};
      const seen = (pollsFor.get(id) ?? 0) + 1;
      pollsFor.set(id, seen);
      // A session that "works for N polls" flips to done afterwards, so a
      // timeout test can hold it working forever with a large N.
      if (script.worksForPolls != null && seen > script.worksForPolls) {
        return {ok: true, row: {...row, state: 'done'}};
      }
      return {ok: true, row};
    },
    gitHead: () => `head-${dispatched}`,
    notifyBlocked: () => {},
    now: () => clock,
    preflight: () => [],
    readUsage: () => null,
    signalPid: (pid, sig) => {
      signals.push({pid, sig: String(sig)});
      for (const [id, row] of rows) {
        if (row.pid === pid && scriptOf.get(id)?.stop === 'clears-on-signal') {
          rows.delete(id);
        }
      }
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    stopSession: (_cwd, id) => {
      stopCalls.push(id);
      const behaviour = scriptOf.get(id)?.stop ?? 'clears';
      if (behaviour === 'clears') rows.delete(id);
      if (behaviour === 'lingers-pidless') {
        const row = rows.get(id);
        if (row != null) rows.set(id, {...row, pid: null});
      }
      return {detail: `stopped ${id}`, ok: true};
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
    dispatches,
    exitCode,
    ledger,
    signals,
    stderr,
    stdout,
    stopCalls,
  };
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
