/**
 * The reading line in a mayor's handoff block (home-base-6ujwi D2, D6, D7, D8).
 *
 * Justin, Q172 (2026-11-18): "Let's have this be something that is invoked
 * manually, ie via an instruction to the next mayor/conductor, rather than via
 * hooks. I just want to test this out first." So the block tells the successor
 * to run one command; nothing injects the messages.
 *
 * WHEN (D6, D7; home-base-eq5oy C2). Only when
 * componentConfig.thread.handoff.readMessages is true AND the session bead
 * carries `session-role:mayor` (the label mayorSuccessorSentence reads) or
 * `session-role:conductor` (set by `thread mark --conductor`). Every other
 * block is byte-for-byte as before.
 *
 * WHICH SESSIONS (D2). The command names the HANDING-OFF session's bead: a
 * successor at pickup holds no message of his yet (its first line is a
 * kickoff), so "the current session and the 2 before it" would give only 2
 * sessions of his words. Naming the handing-off session gives it and the 2
 * before it: his last 3 sessions. It also works before the successor's bead
 * is linked to the chain.
 *
 * READ ALL OF IT (D8). Measured 2026-11-18: the whole mayor chain with
 * `--annotate` printed 307,563 bytes, so 3 sessions are about 95 KB, which
 * Claude Code saves to a file and previews. The general rule says to search
 * such a file, so the line says to read the whole file, in parts.
 */

import {sdkRun} from '../sdk-invocation';
import {CONDUCTOR_ROLE_LABEL, MAYOR_ROLE_LABEL} from './session-bead';

/** His last this-many sessions (Option A of Q172). */
export const READ_MESSAGES_SESSIONS = 3;

/** The command the line names, for the session handing off. */
export function readMessagesCommand(sessionBeadId: string): string {
  return sdkRun(
    `thread messages --chain ${sessionBeadId} --sessions ${READ_MESSAGES_SESSIONS} --annotate`,
  );
}

/** The line, without its list marker. */
export function readMessagesLine(sessionBeadId: string): string {
  return `Before anything else, run \`${readMessagesCommand(sessionBeadId)}\` and read all of its output: it is Justin's own words from his last ${READ_MESSAGES_SESSIONS} sessions, each followed by what Claude did after it. Treat them as high-signal guidance. If Claude Code saves the output to a file, read the whole file with the Read tool, in parts.`;
}

/**
 * Whether a block gets the line (D6, D7, home-base-eq5oy C2): the knob on, and
 * a mayor or a conductor session.
 */
export function blockGetsReadMessagesLine(
  knob: boolean,
  labels: readonly string[],
): boolean {
  return (
    knob &&
    (labels.includes(MAYOR_ROLE_LABEL) || labels.includes(CONDUCTOR_ROLE_LABEL))
  );
}
