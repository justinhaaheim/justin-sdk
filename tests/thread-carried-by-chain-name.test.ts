/**
 * home-base-l2ejg.11.1: the Carried by line names the successor's chain as its
 * heading does. A chain whose beads carry no `chain:` label (dropped before
 * names existed, or on an older SDK pin) is named from the registry by its
 * first session, and no bead is written.
 *
 * A real $TMPDIR world: session A files a request and hands off to session B,
 * the pickup carries the request to B, and neither bead has a `chain:` label.
 * The registry names A's chain. Every test passes its own env with its own
 * session ids, so nothing reaches a real session.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import {brShow, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {chainNameText} from '../src/thread/chain-name';
import {chainNameForRoot, registryChainNamer} from '../src/thread/chain-names';
import {pickUpHandoff} from '../src/thread/handoff-pickup';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {selectSession} from '../src/thread/session-select';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

setDefaultTimeout(120_000);

const A = '0c000000-1111-4222-8333-0000000000a1';
const B = '0c000000-1111-4222-8333-0000000000b2';
const NOW = new Date('2030-01-01T12:00:00.000Z');
const CLI = resolve(import.meta.dirname, '../src/cli.ts');
const TITLE = 'Bring the archive home';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: {a: string; b: string};
  db: string;
  env: Record<string, string | undefined>;
  name: string;
  repo: string;
  requestId: string;
}

async function world(): Promise<World> {
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
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'carry-repo', {
    'README.md': '# c\n',
    'justin-sdk.config.json': `${JSON.stringify({projectTag: 'CARRY'})}\n`,
  });
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const beadOf = (session: string, text: string): string => {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: session,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    // A log, so A reads as a first session and B's number is known (#1).
    const log = messageLogPath(session, env);
    mkdirSync(dirname(log), {recursive: true});
    writeFileSync(
      log,
      serializeMessageLine({
        at: '2030-01-01T09:00:00.000Z',
        cwd: repo,
        event: 'UserPromptSubmit',
        role: 'user',
        text,
      }),
    );
    return filed.beadId;
  };
  const a = beadOf(A, TITLE);
  const b = beadOf(B, 'the next session');
  const request = await fileRequest({
    bead: null,
    cwd: repo,
    doneWhen: null,
    env: {...env, CLAUDE_CODE_SESSION_ID: A},
    here: false,
    now: NOW,
    sessionId: A,
    title: 'Move the archive onto the new disk',
  });
  if (request.kind !== 'filed') throw new Error(JSON.stringify(request));
  const selected = selectSession({
    env: {...env, CLAUDE_CODE_SESSION_ID: B},
    selector: null,
    sessionIdOption: B,
  });
  if (selected.kind !== 'found') throw new Error(selected.kind);
  const picked = await pickUpHandoff(
    {
      cwd: repo,
      env,
      predecessorBeadId: a,
      successor: {beadId: b, db: selected.session.db, sessionId: B},
    },
    {syncNames: () => Promise.resolve(null)},
  );
  if (picked.kind !== 'picked-up') throw new Error(JSON.stringify(picked));
  // The registry names the chain by its first session, A. No bead is touched.
  const named = chainNameForRoot({env, root: a});
  if (named.kind === 'failed') throw new Error(named.reason);
  return {
    beads: {a, b},
    db: selected.session.db,
    env,
    name: chainNameText(named.name),
    repo,
    requestId: request.id,
  };
}

function labelsOf(w: World, beadId: string): string[] {
  const shown = brShow({db: w.db, env: w.env}, beadId);
  if (shown.kind !== 'ok') throw new Error(`could not read ${beadId}`);
  return shown.issue.labels;
}

describe('the Carried by line names an unlabelled chain from the registry', () => {
  test('the fixture: neither bead has a chain: label, and B carries the request as #1', async () => {
    const w = await world();
    for (const bead of [w.beads.a, w.beads.b]) {
      expect(labelsOf(w, bead).filter((l) => l.startsWith('chain:'))).toEqual(
        [],
      );
    }
    expect(labelsOf(w, w.beads.b)).toContain('handoff-number:1');
  });

  test('the inbox (and the dashboard that reads it): Carried by [CARRY][<name>-1], as the heading names B', async () => {
    const w = await world();
    const inbox = await readInbox({
      chainNamer: registryChainNamer(w.env),
      cwd: w.repo,
      days: 30,
      env: w.env,
      now: NOW,
      repo: null,
    });
    if (inbox.kind !== 'read') throw new Error(inbox.reason);
    const text = JSON.stringify(inboxJson(inbox.read));
    const carriedBy = [...text.matchAll(/"carriedBy":"([^"]*)"/gu)].map(
      (match) => match[1],
    );
    expect(carriedBy.length).toBeGreaterThan(0);
    for (const line of carriedBy) {
      expect(line).toStartWith(`[CARRY][${w.name}-1] `);
    }
    // B's heading names the chain the same way.
    expect(text).toContain(`[CARRY][${w.name}-1] `);
    // Read only: no bead was written to name the chain.
    for (const bead of [w.beads.a, w.beads.b]) {
      expect(labelsOf(w, bead).filter((l) => l.startsWith('chain:'))).toEqual(
        [],
      );
    }
  });

  test('thread status (Part 1) of session A: Carried by [CARRY][<name>-1]', async () => {
    const w = await world();
    const status = spawnSync('bun', [CLI, 'thread', 'status'], {
      cwd: w.repo,
      encoding: 'utf8',
      env: {...w.env, CLAUDE_CODE_SESSION_ID: A} as NodeJS.ProcessEnv,
    });
    expect(status.stdout).toContain(`Carried by [CARRY][${w.name}-1] `);
    expect(status.stdout).not.toContain('Carried by [CARRY][#');
  });
});
