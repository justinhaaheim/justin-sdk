/**
 * INTERNAL: the detached child `thread handoff` starts when
 * componentConfig.thread.handoff.predecessor is exit or close
 * (home-base-mbnjv.4, epic C6). It reads the plan thread handoff wrote,
 * waits for the handshake (the successor linked AND this session stopped,
 * re-checked immediately before acting) and then ends Claude Code in the
 * caller's own tab with a tombstone (exit) or closes that tab (close). It
 * never acts on a timer: after the timeout it gives up and keeps the tab.
 * Every outcome is noted on the caller's session bead and logged to
 * <threads state dir>/handoff-predecessor.jsonl. Run by
 * handoff-predecessor.ts as `bun predecessor-watch.ts <plan file>`; nothing
 * else should run it.
 */

import type {PredecessorWatch} from './handoff-predecessor';

import {readFileSync} from 'node:fs';
import {z} from 'zod';

import {
  realPredecessorWatchDeps,
  runPredecessorWatch,
} from './handoff-predecessor';

const USAGE = `predecessor-watch.ts <plan file>

INTERNAL: started detached by \`thread handoff\` when
componentConfig.thread.handoff.predecessor is exit or close. It waits until
the successor in the tab this handoff opened has linked back (continued-by:
on this session's bead, continues: and that tab's cmux-surface: on the
successor's) AND this session's turn has ended (its transcript's
turn_duration) with nobody typing or running a command since, checks that
its own tab still shows this session idle, checks all of it again, and only
then ends Claude
Code in that tab with a tombstone (exit) or closes the tab (close). After 20
minutes it gives up and keeps the tab. Outcomes go on the session bead and in
<threads state dir>/handoff-predecessor.jsonl.
--help prints this and does nothing else.`;

/**
 * The plan thread handoff writes. Tested against what the parent really
 * writes (as stop-later.ts's schema is): a mismatch would make the child
 * exit 2 with its stdio ignored, so nothing would ever be acted on or noted.
 */
export const predecessorWatchSchema = z.object({
  caller: z.object({
    beadId: z.string().min(1),
    db: z.string().min(1),
    sessionId: z.string().min(1),
    surfaceId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
  handedOffAt: z.string().refine((at) => !Number.isNaN(Date.parse(at))),
  logPath: z.string().min(1),
  mode: z.enum(['close', 'exit']),
  pollMs: z.number().int().positive(),
  settleMs: z.number().int().min(0),
  successor: z.object({
    name: z.string(),
    surfaceId: z.string().min(1),
    surfaceRef: z.string(),
  }),
  timeoutMs: z.number().int().positive(),
  tombstone: z.array(z.string()),
}) satisfies z.ZodType<PredecessorWatch>;

/** The child's entry: 0 acted, 1 kept or failed, 2 no usable plan. */
export async function main(argv: readonly string[]): Promise<number> {
  const [first] = argv;
  if (first == null || first === '--help' || first === '-h') {
    console.log(USAGE);
    return first == null ? 2 : 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(first, 'utf8')) as unknown;
  } catch {
    return 2;
  }
  const watch = predecessorWatchSchema.safeParse(parsed);
  if (!watch.success) return 2;
  const outcome = await runPredecessorWatch(
    watch.data,
    realPredecessorWatchDeps(watch.data, process.env),
  );
  return outcome.kind === 'acted' ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
