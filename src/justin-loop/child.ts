/**
 * One bounded child-process call, which always answers.
 *
 * WHY THIS EXISTS (home-base-a1go). The runner used `spawnSync` for every
 * `claude`, `git` and `osascript` call. On 2026-09-10 an e2e scenario-A run
 * printed its `background <id>` line and then nothing at all for 717s, until the
 * harness SIGKILLed it: no stop, no dispatch, no error — the exact failure shape
 * critical rule 6 exists to forbid, a failure presenting as silence.
 *
 * MEASURED 2026-09-12 (bun 1.4.2, macOS, `node:child_process` as Bun implements
 * it), three runs against two throwaway fake binaries:
 *
 *   1. A fake that echoes one line, backgrounds `sleep 120` WITH THE INHERITED
 *      STDOUT, and exits 0 immediately, run through `spawnSync(…, {timeout:
 *      2000})` → returned after 2002ms, `status: 0`, `error: ETIMEDOUT`.
 *   2. A fake that never exits, same call → returned after 2001ms, `signal:
 *      SIGTERM`, `error: ETIMEDOUT`.
 *   3. Fake 1 again with NO `timeout` option → returned after 120_015ms,
 *      `status: 0`, `error: null`, stdout complete. It waited for the
 *      GRANDCHILD, and nothing about the result says so.
 *
 * Three findings, and this module is the answer to all three:
 *
 *   a. `spawnSync` waits for the PIPE to reach EOF, not for the child to exit. A
 *      grandchild that inherited stdout holds it open for as long as it lives,
 *      and a Claude Code background session leaves exactly such long-lived
 *      supervisors behind. `runChild` therefore answers as soon as the process it
 *      actually spawned has exited (plus a short grace), and lets go of its read
 *      end rather than waiting for whoever else may be holding the write end.
 *   b. A `timeout` DOES fire under Bun, so a timed call cannot hang forever — it
 *      can only cost its whole timeout. The two calls that carried NO timeout
 *      (the HEAD-sha read and the preflight `claude --version`) were unbounded
 *      AND silent; every call now carries one.
 *   c. A timed-out call whose direct child exited 0 comes back as `{status: 0,
 *      error: ETIMEDOUT}` with TRUNCATED stdout — so any caller that tests
 *      `status === 0` before it tests the error reads a timeout as a success.
 *      `describeChildFailure` fixes that ordering once, for every caller.
 *
 * A synchronous call cannot be rescued by a watchdog: it blocks the event loop,
 * so no timer can fire while it is stuck. That is why this is async, and why the
 * dependency types in the runner are Promise-returning — so a `spawnSync` cannot
 * quietly come back.
 */
import {spawn} from 'node:child_process';

/**
 * What became of one child call. Every failure mode is a DISTINCT field, and
 * none of them is representable as a normal value (critical rule 6): a timeout
 * is not an exit, an exit is not a spawn error, and truncated output is not
 * short output.
 */
export interface ChildOutcome {
  durationMs: number;
  /** The child could not be spawned at all (ENOENT, EACCES …). */
  error: string | null;
  /** The signal that killed it, if any. */
  signal: string | null;
  /** Exit code, or null when the child was killed or never exited. */
  status: number | null;
  stderr: string;
  stdout: string;
  /** The timeout fired and we SIGKILLed the child. */
  timedOut: boolean;
  /** The bound this call was given, so a failure message can name it. */
  timeoutMs: number;
  /** Output exceeded `maxBufferBytes` and what is here is NOT all of it. */
  truncated: boolean;
}

/**
 * How long after the child's own exit we keep reading before answering.
 *
 * The tidy end of a child call is `close` — exit AND every stdio stream at EOF.
 * But EOF is a fact about every process holding the pipe, not about our child
 * (measurement 3 above: 120s), so `exit` starts this grace period and then we
 * answer with what we have. It exists only so output written immediately before
 * exit is not clipped; 250ms is far more than the ~1ms the pipe needs when
 * nobody else is holding it.
 */
export const EXIT_GRACE_MS = 250;

/** Matches the `maxBuffer` the old `spawnSync` calls used. */
export const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface ChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests only, so the grace period can be exercised in ms. */
  graceMs?: number;
  maxBufferBytes?: number;
  /** Required on purpose: an unbounded child call is the bug this file is about. */
  timeoutMs: number;
}

/**
 * Run `bin args` and always resolve — never throw, never hang past `timeoutMs`.
 *
 * Resolves on the FIRST of:
 *   a. `close` (the child exited and every pipe reached EOF) — the normal case;
 *   b. `exit` plus `EXIT_GRACE_MS` — the child is gone but something it left
 *      behind still holds the pipe, and waiting on that is the wedge;
 *   c. `timeoutMs`, on which the child is SIGKILLed and the outcome says so.
 *
 * SIGKILL rather than SIGTERM because this ladder only ever runs after something
 * has already failed to behave, and a TERM that is caught and ignored buys
 * another unbounded wait. (The runner's separate stop ladder still tries the
 * gentler rungs first — that is a different decision, about a session rather
 * than about a hung pipe.)
 */
export function runChild(
  bin: string,
  args: string[],
  opts: ChildOptions,
): Promise<ChildOutcome> {
  const started = Date.now();
  const maxBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const graceMs = opts.graceMs ?? EXIT_GRACE_MS;

  return new Promise<ChildOutcome>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let error: string | null = null;
    let status: number | null = null;
    let signal: string | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // stdin is /dev/null, never our own: a child that reads stdin must get
      // EOF rather than block on a terminal the runner may not even have.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function settle(): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer != null) clearTimeout(timeoutTimer);
      if (graceTimer != null) clearTimeout(graceTimer);
      // Let go of the READ end. Something else may hold the WRITE end open for
      // hours; destroying ours is what stops that from pinning the event loop
      // after we have already answered.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        durationMs: Date.now() - started,
        error,
        signal,
        status,
        stderr: Buffer.concat(err).toString('utf-8'),
        stdout: Buffer.concat(out).toString('utf-8'),
        timedOut,
        timeoutMs: opts.timeoutMs,
        truncated,
      });
    }

    function collect(into: Buffer[], chunk: Buffer, bytes: number): number {
      if (bytes >= maxBytes) {
        truncated = true;
        return bytes;
      }
      const room = maxBytes - bytes;
      if (chunk.length > room) {
        into.push(chunk.subarray(0, room));
        truncated = true;
        return maxBytes;
      }
      into.push(chunk);
      return bytes + chunk.length;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes);
    });
    // A destroyed pipe can emit EPIPE/ECONNRESET after we have answered. That is
    // not a failure of the call and must not become an unhandled error.
    // A stream error here is the child going away mid-write, which the exit
    // handling below already reports; an unhandled 'error' event would crash
    // the process instead.
    child.stdout?.on('error', () => {
      /* reported via the child's exit, not here */
    });
    child.stderr?.on('error', () => {
      /* reported via the child's exit, not here */
    });

    child.on('error', (e: Error) => {
      error = e.message;
      settle();
    });

    child.on('exit', (code, sig) => {
      status = code;
      signal = sig;
      graceTimer = setTimeout(settle, graceMs);
    });

    child.on('close', (code, sig) => {
      status = code;
      signal = sig;
      settle();
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
      // Answer NOW. Waiting for the kill to be acknowledged would be waiting on
      // the pipe again, which is the whole failure this bounds.
      settle();
    }, opts.timeoutMs);
  });
}

/**
 * The one-line reason this call failed, or null when it succeeded.
 *
 * THE ORDER IS THE POINT. `error` and `timedOut` are checked BEFORE `status`,
 * because a child that exits 0 and leaves a pipe holder behind reports a
 * TIMED-OUT call as `status: 0` with truncated output (measurement c above).
 * Testing the status first turns a timeout into a success with half the data —
 * the reassuring direction, which is the dangerous one.
 */
export function describeChildFailure(
  what: string,
  outcome: ChildOutcome,
): string | null {
  if (outcome.error != null) {
    return `${what} could not run: ${outcome.error}`;
  }
  if (outcome.timedOut) {
    return `${what} did not finish within ${outcome.timeoutMs}ms and was SIGKILLed`;
  }
  if (outcome.status !== 0) {
    return outcome.status != null
      ? `${what} exited ${outcome.status}`
      : `${what} was killed (${outcome.signal ?? 'unknown signal'})`;
  }
  if (outcome.truncated) {
    return `${what} produced more output than the buffer allows, so what came back is incomplete`;
  }
  return null;
}
