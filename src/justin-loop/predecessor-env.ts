/**
 * The one channel the justin-loop runner uses to tell a successor session which
 * session it continues (epic home-base-1r6d.33 D18, home-base-k0b8n.5).
 *
 * It lives in its own module because it has TWO owners in different directories:
 * the runner writes it onto the `claude --bg` dispatch, and the thread tool
 * reads it when nobody typed `--continues-from`. A constant spelled twice is a
 * rename in one place away from a feature that silently stops working, and
 * neither side has a test that would notice.
 *
 * MEASURED 2026-09-19, claude 2.1.278 (`bun run probe:bg-env`): a variable set
 * on a `claude --bg` invocation does reach the spawned session's Bash tool, so
 * this channel actually carries.
 */

/** Set by the justin-loop runner on a successor's dispatch. Never empty. */
export const PREDECESSOR_SESSION_ENV = 'JUSTIN_LOOP_PREDECESSOR_SESSION_ID';

/**
 * The predecessor session id this process was handed, or null.
 *
 * An EMPTY value reads as null, deliberately (critical rule 7). The runner never
 * writes one — an unknown predecessor sets no variable at all — but anything
 * else on this machine might, and "" is not a session id: treating it as one
 * would send the thread tool looking up a session that does not exist and
 * reporting the miss as a fact about a real predecessor.
 */
export function predecessorSessionIdFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env[PREDECESSOR_SESSION_ENV];
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
