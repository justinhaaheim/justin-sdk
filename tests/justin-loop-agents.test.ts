/**
 * `claude agents --json` rows the runner cannot read (home-base-685h F7).
 *
 * A row without a usable `id` used to become `{id: ''}`: a rule-7 sentinel that
 * is also a legal string, so a malformed row entered the runner looking like a
 * session whose id happened to be empty. It matched nothing, so it was silent —
 * and an all-malformed listing became a listing with rows in it that behaved
 * exactly like no listing at all.
 *
 * PROCESS-LEVEL, like tests/justin-loop-hang.test.ts and for the same reason:
 * what is under test is how real CLI output lands in `AgentListing`. A stub of
 * the parse would assert the branch structure against JSON the test itself
 * shaped, which is not evidence about the boundary.
 *
 * THE CONSEQUENCE that makes the all-malformed case its own member: an EMPTY
 * listing is what proves a predecessor is gone (D6), and a verified-gone
 * predecessor is what licenses spawning a successor into its worktree. "Every
 * row was unreadable" must never reach that decision wearing an empty list's
 * clothes.
 */

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  type AgentListing,
  CLAUDE_BIN_ENV,
  listAgents,
} from '../src/justin-loop/runner';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'justin-loop-agents-'));
});

afterAll(() => {
  rmSync(dir, {force: true, recursive: true});
});

/** A `claude` whose `agents --json` prints exactly `body`, then exits 0. */
function claudePrinting(body: string, name: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\ncat <<'AGENTS_EOF'\n${body}\nAGENTS_EOF\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function list(body: string, name: string): Promise<AgentListing> {
  const original = process.env[CLAUDE_BIN_ENV];
  process.env[CLAUDE_BIN_ENV] = claudePrinting(body, name);
  try {
    return await listAgents(import.meta.dirname, 10_000);
  } finally {
    if (original == null) delete process.env[CLAUDE_BIN_ENV];
    else process.env[CLAUDE_BIN_ENV] = original;
  }
}

describe('listAgents and malformed rows (F7)', () => {
  test('a row with no id is neither returned nor reported as a session', async () => {
    const listing = await list(
      JSON.stringify([
        {id: 'sess-1', name: 'a', state: 'working'},
        {name: 'no id at all', state: 'working'},
        {id: '', name: 'empty id', state: 'working'},
      ]),
      'claude-some-malformed',
    );
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.rows.map((r) => r.id)).toEqual(['sess-1']);
    expect(listing.rows.some((r) => r.id === '')).toBe(false);
    // Counted, not silently dropped: "one session" and "one session plus two
    // rows I could not read" are different facts.
    expect(listing.malformed).toBe(2);
  });

  test('a non-string id is malformed too, not stringified into one', async () => {
    const listing = await list(
      JSON.stringify([{id: 42, name: 'numeric id', state: 'working'}]),
      'claude-numeric-id',
    );
    // Every row unreadable, so this is a FAILURE — see the next test.
    expect(listing.ok).toBe(false);
  });

  test('an ALL-malformed listing is a failure, never an empty listing', async () => {
    const listing = await list(
      JSON.stringify([{name: 'one'}, {name: 'two'}]),
      'claude-all-malformed',
    );
    expect(listing.ok).toBe(false);
    expect(listing.ok ? '' : listing.reason).toContain('2 rows');
    expect(listing.ok ? '' : listing.reason).toContain('not an empty listing');
  });

  test('a genuinely empty listing stays ok, with zero malformed', async () => {
    // The boundary. `[]` must keep meaning "checked, and there are none", or the
    // fix above would turn every quiet moment into a failed poll.
    const listing = await list('[]', 'claude-empty');
    expect(listing.ok).toBe(true);
    expect(listing.ok ? listing.rows : null).toEqual([]);
    expect(listing.ok ? listing.malformed : null).toBe(0);
  });

  test('a listing where every row is fine reports zero malformed', async () => {
    const listing = await list(
      JSON.stringify([
        {id: 'sess-1', state: 'working'},
        {id: 'sess-2', state: 'done'},
      ]),
      'claude-clean',
    );
    expect(listing.ok ? listing.rows.length : null).toBe(2);
    expect(listing.ok ? listing.malformed : null).toBe(0);
  });
});
