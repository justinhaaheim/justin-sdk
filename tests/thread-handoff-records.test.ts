/**
 * home-base-mbnjv.3 AC1 and AC2, against real br in $TMPDIR workspaces:
 * `thread show` prints the whole handoff chain from any session in it, the
 * card names the predecessor and the successor, a half-written link reads as
 * half-written, and a refused handoff shows "handoff refused: <reason>" in
 * thread show and on the inbox card's status line. `needBr()` throws when br
 * is missing.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brUpdate, findBeadsWorkspace, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {recordRefusal} from '../src/thread/handoff-gate';
import {serializeMessageLine} from '../src/thread/message-log';
import {kickoffText} from '../src/thread/respawn';
import {ensureSessionBead} from '../src/thread/session-bead';
import {handOff, linkContinuation} from '../src/thread/session-handoff';
import {readInbox} from '../src/thread/session-inbox';
import {
  handoffSectionLines,
  loadSessionReport,
  realHandoffSectionReaders,
  relatedEpicsOf,
  renderSessionShow,
} from '../src/thread/session-report';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const A = '0a000000-1111-4222-8333-0000000000a1';
const B = '0b000000-1111-4222-8333-0000000000b1';
const C = '0c000000-1111-4222-8333-0000000000c1';
const D = '0d000000-1111-4222-8333-0000000000d1';
const E = '0e000000-1111-4222-8333-0000000000e1';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const PLAIN = {color: false, width: null} as const;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: Record<string, string>;
  db: string;
  devRoot: string;
  env: Record<string, string | undefined>;
  repo: string;
}

function world(sessions: readonly string[]): World {
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
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'chain-repo', {'README.md': '# c\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const space = findBeadsWorkspace(repo);
  if (space.kind !== 'found') throw new Error(space.reason);
  const beads: Record<string, string> = {};
  for (const [index, session] of sessions.entries()) {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: `step ${index + 1}`},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: session,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    beads[session] = filed.beadId;
    const path = messageLogPath(session, env);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      serializeMessageLine({
        at: '2030-01-01T09:00:00.000Z',
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        // F1/F12 (home-base-mbnjv.8): a successor's first line is a real
        // kickoff; only the first session began on Justin's own words.
        text:
          index === 0
            ? `step ${index + 1}`
            : kickoffText('/state/handoffs/x.md', 't-prev', null),
      }),
    );
  }
  return {beads, db: space.db, devRoot: join(sb.path, 'dev'), env, repo};
}

function bead(w: World, session: string): string {
  const id = w.beads[session];
  if (id == null) throw new Error(`no bead for ${session}`);
  return id;
}

function link(w: World, from: string, to: string): void {
  const linked = linkContinuation({
    cwd: w.repo,
    env: w.env,
    newSession: {beadId: bead(w, to), db: w.db},
    oldBeadId: bead(w, from),
  });
  if (linked.kind !== 'linked') throw new Error(linked.reason);
}

async function handOffAs(w: World, session: string): Promise<void> {
  const outcome = await handOff({
    cwd: w.repo,
    env: {...w.env, CLAUDE_CODE_SESSION_ID: session},
    note: null,
    now: NOW,
    sessionId: session,
    to: null,
  });
  if (outcome.kind !== 'handedOff') throw new Error(outcome.reason);
}

async function loaded(w: World, session: string) {
  const load = await loadSessionReport({
    asIfYielded: false,
    cwd: w.repo,
    env: w.env,
    now: NOW,
    selector: null,
    sessionId: session,
  });
  if (load.kind !== 'loaded') throw new Error(JSON.stringify(load));
  return load;
}

async function showText(w: World, session: string): Promise<string> {
  const load = await loaded(w, session);
  return renderSessionShow(load, {
    full: false,
    handoff: handoffSectionLines(
      load,
      realHandoffSectionReaders({cwd: w.repo, env: w.env}),
    ),
    now: NOW,
    related: relatedEpicsOf(load),
    style: PLAIN,
  });
}

/** A → B → C, A and B handed off; D has only continues:C (half-written). */
async function chainWorld(): Promise<World> {
  const w = world([A, B, C, D]);
  link(w, A, B);
  link(w, B, C);
  await handOffAs(w, A);
  await handOffAs(w, B);
  const half = brUpdate({db: w.db, env: w.env}, bead(w, D), {
    addLabels: [`continues:${bead(w, C)}`],
  });
  if (half.kind === 'failed') throw new Error('half link not written');
  return w;
}

describe('thread show prints the whole chain (AC1)', () => {
  test('from any of the three, all three in order, each with its title and when it handed off', async () => {
    const w = await chainWorld();
    const ids = [A, B, C].map((session) => bead(w, session));
    for (const session of [A, B, C]) {
      const text = await showText(w, session);
      expect(text).toContain('**Handoff chain:**');
      const at = ids.map((id) => text.indexOf(`. ${id}`));
      expect(at.every((index) => index >= 0)).toBe(true);
      expect([...at].sort((x, y) => x - y)).toEqual(at);
      expect(text).toContain(`${bead(w, session)} (this session)`);
      expect(text).toContain('"step 1"');
      expect(text).toContain('"step 3"');
      expect(text).toContain('handed off: 20');
      expect(text).toContain(
        `link to 2: linked (continued-by:${ids[1]} on ${ids[0]}, continues:${ids[0]} on ${ids[1]})`,
      );
      expect(text).toContain(
        `Handoffs in a row since Justin last typed: 2, counted back from ${ids[2]}, the newest session`,
      );
    }
  });

  test('a half-written link is printed as half-written', async () => {
    const w = await chainWorld();
    const text = await showText(w, D);
    expect(text).toContain(
      `⚠️ half-written link: ${bead(w, D)} has continues:${bead(w, C)}, but ${bead(w, C)} has no continued-by:${bead(w, D)}`,
    );
  });

  test('a session with no handoff label prints no chain section', async () => {
    const w = world([A]);
    expect(await showText(w, A)).not.toContain('Handoff chain');
  });
});

describe('the card names its neighbours (AC1)', () => {
  test('the middle card names its predecessor and its successor; a half link says so', async () => {
    const w = await chainWorld();
    const inbox = await readInbox({
      cwd: w.repo,
      days: 3650,
      devRoot: w.devRoot,
      env: w.env,
      now: NOW,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(JSON.stringify(inbox));
    const cardOf = (session: string) => {
      const row = inbox.read.rows.find((entry) => entry.sessionId === session);
      if (row == null) throw new Error(`no row for ${session}`);
      return row.card;
    };
    expect(cardOf(B).facts.slice(0, 2)).toEqual([
      {label: 'Continues', value: `"step 1" (${bead(w, A)})`},
      {label: 'Continued by', value: `"step 3" (${bead(w, C)})`},
    ]);
    expect(cardOf(D).facts[0]).toEqual({
      label: 'Continues',
      value: `"step 3" (${bead(w, C)}) ⚠️ half-written link: ${bead(w, C)} has no continued-by:${bead(w, D)}`,
    });
  });
});

describe('a refused handoff is shown (AC2)', () => {
  test('thread show, the card and the inbox status line say "handoff refused: <reason>"', async () => {
    const w = world([E]);
    await handOffAs(w, E);
    const recorded = recordRefusal({
      beadId: bead(w, E),
      db: w.db,
      detail: '25 live Claude sessions; the limit is 25',
      env: w.env,
      now: NOW,
      reason: 'tooManyLiveSessions',
    });
    if (recorded.kind !== 'recorded') throw new Error(recorded.reason);
    const words =
      'handoff refused: tooManyLiveSessions — 25 live Claude sessions; the limit is 25';
    expect(await showText(w, E)).toContain(words);

    const inbox = await readInbox({
      cwd: w.repo,
      days: 3650,
      devRoot: w.devRoot,
      env: w.env,
      now: NOW,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(JSON.stringify(inbox));
    const row = inbox.read.rows.find((entry) => entry.sessionId === E);
    if (row == null) throw new Error('no row for E');
    expect(row.card.status).toBe(`🤝 Handed off; ${words}`);
  });
});
