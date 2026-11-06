/**
 * `thread inbox --json`'s `handoff` field and the card's status text
 * (home-base-89c8h.3), from a real session bead in a $TMPDIR world. Real br,
 * real recordRefusal and recordDeferral. The watcher that reads this field is
 * tested in scripts/mayor-watch.test.ts.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, brUpdate, runBr} from '../src/beads/br';
import {recordDeferral, recordRefusal} from '../src/thread/handoff-gate';
import {ensureSessionBead} from '../src/thread/session-bead';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {selectSession} from '../src/thread/session-select';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SID = 'aa693548-b000-4b39-8cf4-90a380854827';
const NOW = new Date('2030-01-01T10:00:00.000Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function world() {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SID,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'field-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: SID,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  const selected = selectSession({env, selector: null, sessionIdOption: null});
  if (selected.kind !== 'found') throw new Error(selected.kind);
  return {beadId: filed.beadId, db: selected.session.db, env, repo};
}
type World = ReturnType<typeof world>;

async function entryOf(w: World) {
  const inbox = await readInbox({
    cwd: w.repo,
    days: 30,
    env: w.env,
    now: NOW,
    repo: null,
  });
  if (inbox.kind !== 'read') throw new Error(inbox.reason);
  const entry = inboxJson(inbox.read).sessions.find(
    (session) => session.sessionId === SID,
  );
  if (entry == null) throw new Error('the session is not in the inbox');
  return JSON.parse(JSON.stringify(entry)) as {
    card: {facts: unknown; status: string};
    handoff: {
      at: string | null;
      detail: string;
      reason: string | null;
      state: string;
    } | null;
  };
}

function refuse(w: World): void {
  const written = recordRefusal({
    beadId: w.beadId,
    db: w.db,
    detail: 'the week window is at 91 %',
    env: w.env,
    now: NOW,
    reason: 'usageHigh',
  });
  if (written.kind !== 'recorded') throw new Error(written.reason);
}

function defer(w: World): void {
  const written = recordDeferral({
    beadId: w.beadId,
    db: w.db,
    detail: 'cmux did not answer a ping',
    env: w.env,
    now: NOW,
    reason: 'cmuxSlow',
  });
  if (written.kind !== 'recorded') throw new Error(written.reason);
}

describe('thread inbox --json: handoff', () => {
  test('a session with no handoff records: null', async () => {
    expect((await entryOf(world())).handoff).toBeNull();
  });

  test('labelled handoff-refused, no successor: state refused, and the text is in the status, not the facts', async () => {
    const w = world();
    refuse(w);
    const entry = await entryOf(w);
    expect(entry.handoff?.state).toBe('refused');
    expect(entry.handoff?.reason).toBe('usageHigh');
    expect(entry.handoff?.detail).toBe('the week window is at 91 %');
    expect(entry.handoff?.at).not.toBeNull();
    // Why the watcher's old search never matched.
    expect(entry.card.status).toContain('handoff refused');
    expect(JSON.stringify(entry.card.facts)).not.toContain('handoff refused');
  });

  test('labelled handoff-deferred: state deferred, and the card names it', async () => {
    const w = world();
    defer(w);
    const entry = await entryOf(w);
    expect(entry.handoff?.state).toBe('deferred');
    expect(entry.handoff?.reason).toBe('cmuxSlow');
    expect(entry.card.status).toContain(
      'handoff deferred: cmuxSlow — cmux did not answer a ping',
    );
  });

  test('with continued-by present: null, and the card says nothing of it', async () => {
    const w = world();
    refuse(w);
    const linked = brUpdate({db: w.db, env: w.env}, w.beadId, {
      addLabels: ['continued-by:t-next'],
    });
    if (linked.kind === 'failed') throw new Error('br update failed');
    const entry = await entryOf(w);
    expect(entry.handoff).toBeNull();
    expect(entry.card.status).not.toContain('handoff refused');
  });

  test('labelled with no readable line: reason null, a detail saying so, not a null field', async () => {
    const w = world();
    const labelled = brUpdate({db: w.db, env: w.env}, w.beadId, {
      addLabels: ['handoff-deferred'],
    });
    if (labelled.kind === 'failed') throw new Error('br update failed');
    const entry = await entryOf(w);
    expect(entry.handoff?.state).toBe('deferred');
    expect(entry.handoff?.reason).toBeNull();
    expect(entry.handoff?.detail).toContain('handoff-deferred');
    expect(entry.card.status).toContain('handoff deferred');
  });

  test('both labels: the newest line decides', async () => {
    const w = world();
    refuse(w);
    defer(w);
    expect((await entryOf(w)).handoff?.state).toBe('deferred');
    refuse(w);
    expect((await entryOf(w)).handoff?.state).toBe('refused');
  });

  test('recordDeferral writes the label and the note the view reads', () => {
    const w = world();
    defer(w);
    const shown = brShow({db: w.db, env: w.env}, w.beadId);
    if (shown.kind !== 'ok') throw new Error(shown.kind);
    expect(shown.issue.labels).toContain('handoff-deferred');
    expect(shown.issue.notes ?? '').toContain(
      'handoff deferred: cmuxSlow — cmux did not answer a ping',
    );
  });
});
