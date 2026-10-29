/**
 * A bead that no searched DB holds, while some DB could not be resolved, is a
 * `failed` lookup, never "not found" (home-base-dj5m9.1.6 F3).
 *
 * `thread answer --ask` (session-answer.ts `locateBead`) and `thread handoff`
 * (session-handoff.ts `locateSessionBead`) kept only the DBs that resolved, so
 * a DB that failed to resolve was dropped and the result read "X was not
 * found in …". Here the sessions index records a `.beads/` that holds two
 * `*.db` files and no beads.db, which `findBeadsDb` cannot choose between: a
 * `failed` with no br involved. No br runs in these tests.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.6): drop the
 * `unresolved.push(...)` lines in both functions → both "failed" tests fail
 * (`notFound`).
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {locateBead} from '../src/thread/session-answer';
import {locateSessionBead} from '../src/thread/session-handoff';
import {appendSessionSighting} from '../src/thread/session-index';
import {createSandbox} from './sandbox';

const SESSION = '0dbd0d0d-5e55-4a11-8b0b-1234567890f3';
const BEAD = 't-f3f3';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** An index that records `BEAD` as filed in `<sandbox>/recorded/.beads`. */
function world(dbFiles: string[]): {
  beadsDir: string;
  env: Record<string, string | undefined>;
  sb: Sandbox;
} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const beadsDir = join(sb.path, 'recorded', '.beads');
  mkdirSync(beadsDir, {recursive: true});
  for (const name of dbFiles) writeFileSync(join(beadsDir, name), '');
  const env = {
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
  };
  const appended = appendSessionSighting(
    {
      at: '2026-10-29T09:00:00.000Z',
      beadId: BEAD,
      beadsDir,
      branch: 'main',
      checkoutPath: join(sb.path, 'recorded'),
      event: 'created',
      repo: 'recorded',
      sessionId: SESSION,
    },
    env,
  );
  if (appended.kind !== 'appended') throw new Error(appended.error);
  return {beadsDir, env, sb};
}

describe('a DB that could not be resolved is not "not found" (F3)', () => {
  test('thread handoff: locateSessionBead is failed, naming the DB', () => {
    const {beadsDir, env} = world(['a.db', 'b.db']);
    const located = locateSessionBead(BEAD, env, []);
    expect(located.kind).toBe('failed');
    if (located.kind !== 'failed') return;
    expect(located.reason).toContain(beadsDir);
    expect(located.reason).toContain('could not be resolved');
  });

  test('thread answer: locateBead is failed, naming the DB', () => {
    const {beadsDir, env, sb} = world(['a.db', 'b.db']);
    const located = locateBead(BEAD, sb.path, env);
    expect(located.kind).toBe('failed');
    if (located.kind !== 'failed') return;
    expect(located.reason).toContain(beadsDir);
  });

  test('control: with nothing unresolved, both say not found', () => {
    const {env, sb} = world([]);
    expect(locateSessionBead(BEAD, env, []).kind).toBe('notFound');
    expect(locateBead(BEAD, sb.path, env).kind).toBe('notFound');
  });
});
