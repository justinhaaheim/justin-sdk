/**
 * INTERNAL: the detached child `thread archive --stop` and `thread done
 * --stop` start (home-base-yukaf.22 item 8, home-base-yukaf.25). It waits,
 * re-checks that each pid still runs exactly the command line the parent saw
 * (which names the session, or is this session's own process found up the
 * parent chain: payload.selfPid), logs `about-to-signal`, sends SIGTERM,
 * waits up to 15 s for the exit, and appends what happened to <threads state
 * dir>/session-stops.jsonl. It never closes a workspace. Run by
 * session-stop.ts as `bun stop-later.ts '<payload json>'`; nothing else
 * should run it.
 *
 * UNVERIFIED: that this child survives the Bash tool that started it and
 * reaches the Claude process; the first real /thread-archive measures it.
 */

import type {StopLaterPayload} from './session-stop';

import {z} from 'zod';

import {realStopLaterDeps, runStopLater} from './session-stop';

const USAGE = `stop-later.ts '<payload json>'

INTERNAL: started detached by \`thread archive --stop\` / \`thread done --stop\`.
It waits payload.delayMs, re-checks each pid's command line, logs
about-to-signal, sends SIGTERM (never SIGKILL), and logs the outcome to
payload.logPath. It never closes a workspace. Whether it survives the Bash
tool that started it is unverified: the first real /thread-archive measures it.
--help prints this and does nothing else.`;

/**
 * The payload the parent (scheduleSessionStop) builds. G10: tested against
 * what the parent really sends, because a mismatch would make the child exit
 * 2 with its stdio ignored, so nothing would ever be stopped or logged.
 */
export const stopLaterPayloadSchema = z.object({
  delayMs: z.number().int().min(0).max(60_000),
  logPath: z.string().min(1),
  procs: z
    .array(
      z.object({command: z.string().min(1), pid: z.number().int().positive()}),
    )
    .min(1),
  selfPid: z.number().int().positive().nullable(),
  sessionId: z.string().min(1),
}) satisfies z.ZodType<StopLaterPayload>;

/** The child's entry: 0 stopped, 1 refused or failed, 2 no usable payload. */
export async function main(argv: readonly string[]): Promise<number> {
  const [first] = argv;
  if (first == null || first === '--help' || first === '-h') {
    console.log(USAGE);
    return first == null ? 2 : 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first) as unknown;
  } catch {
    return 2;
  }
  const payload = stopLaterPayloadSchema.safeParse(parsed);
  if (!payload.success) return 2;
  const outcome = await runStopLater(
    payload.data,
    realStopLaterDeps(payload.data.logPath),
  );
  return outcome === 'stopped' ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
