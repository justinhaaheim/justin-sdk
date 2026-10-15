/**
 * `thread handoff` and `thread request --continues` (home-base-vzwbj.4.4
 * design item 2). Real br in $TMPDIR workspaces; `needBr()` throws when br is
 * missing.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {fileAsk} from '../src/thread/ask';
import {serializeMessageLine} from '../src/thread/message-log';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {describeHandoffOutcome, handOff} from '../src/thread/session-handoff';
import {loadSessionReport} from '../src/thread/session-report';
import {markStage} from '../src/thread/session-stage';
import {initRepo} from './git-fixtures';
import {siblingPairs} from './markdown-siblings';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-000000000001';
const NEW = '0e400000-1111-4222-8333-000000000002';
const NOW = new Date('2030-01-01T12:00:00.000Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beads: Record<string, string>;
  env: Record<string, string | undefined>;
  repo: string;
}

function world(sessions: readonly string[] = [OLD]): World {
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
  const repo = initRepo(sb, 'handoff-repo', {'README.md': '# h\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const beads: Record<string, string> = {};
  for (const session of sessions) {
    const filed = ensureSessionBead({
      cwd: repo,
      env: {...env, CLAUDE_CODE_SESSION_ID: session},
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
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
        text: 'migrate the db',
      }),
    );
  }
  return {beads, env, repo};
}

function labelsOf(w: World, id: string): string[] {
  const shown = brShow({cwd: w.repo}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue.labels;
}

function notesOf(w: World, id: string): string {
  const shown = brShow({cwd: w.repo}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue.notes ?? '';
}

async function requestIn(w: World, session: string, title: string) {
  const filed = await fileRequest({
    bead: null,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    now: NOW,
    sessionId: session,
    title,
  });
  if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
  return filed;
}

describe('thread handoff', () => {
  test('labels the session handed-off, appends the dated note, and prints the block', async () => {
    const w = world();
    const request = await requestIn(w, OLD, 'Migrate the orders table');
    await markStage({
      cwd: w.repo,
      env: w.env,
      request: request.id,
      sessionId: OLD,
      stages: ['code-done'],
      unset: false,
    });
    const asked = await fileAsk({
      approve: false,
      context: ['Two columns are unused.'],
      cwd: w.repo,
      default: 'I keep them.',
      do: false,
      env: w.env,
      header: null,
      options: [],
      priority: '2',
      question: 'Drop the unused columns?',
      recommend: null,
      sessionId: OLD,
      to: null,
    });
    expect(asked.kind).toBe('filed');

    const outcome = await handOff({
      cwd: w.repo,
      env: w.env,
      note: 'the backfill script is half written',
      now: NOW,
      sessionId: OLD,
      timeZone: 'UTC',
      to: null,
    });
    expect(outcome.kind).toBe('handedOff');
    const old = w.beads[OLD] ?? '';
    expect(labelsOf(w, old)).toContain('handed-off');
    expect(notesOf(w, old)).toMatch(
      /- \d{4}-\d{2}-\d{2} \d{2}:\d{2}: handed off — the backfill script is half written$/,
    );

    const {exitCode, lines} = describeHandoffOutcome(outcome);
    expect(exitCode).toBe(0);
    const block = lines.join('\n');
    expect(block).toContain('🤝 **HANDOFF** — paste this into the new session');
    expect(block).toContain(
      `- **Session:** [HANDOFF-REPO] Migrate the orders table (${old})`,
    );
    expect(block).toContain('- **Status:** 🤝 Handed off');
    expect(block).toContain('- **Handed off:** Tue 2030-01-01 12:00 pm');
    expect(block).toContain('- **Note:** the backfill script is half written');
    expect(block).toContain(`1. 🔲 Migrate the orders table (${request.id})`);
    expect(block).toContain('**Stage:** code-done — next: tested');
    expect(block).toContain('**Drop the unused columns?**');
    expect(block).toContain(
      `- First, in the new session: \`bun run justin-sdk thread request --continues ${old}\``,
    );
    expect(block).toContain(`\`claude --resume ${OLD}\``);

    const report = await loadSessionReport({
      asIfYielded: false,
      cwd: w.repo,
      env: w.env,
      now: NOW,
      selector: null,
      sessionId: OLD,
    });
    expect(report.kind === 'loaded' && report.status).toEqual({
      kind: 'handedOff',
      successor: null,
    });
  });

  test('F7: two empty lines between sibling requests, questions and their context bullets (Claude Code drops one)', async () => {
    const w = world();
    await requestIn(w, OLD, 'Migrate the orders table');
    await requestIn(w, OLD, 'Backfill the totals');
    for (const question of ['Drop the unused columns?', 'Rename the table?']) {
      const asked = await fileAsk({
        approve: false,
        context: ['Two columns are unused.', 'Nothing reads them.'],
        cwd: w.repo,
        default: 'I keep them.',
        do: false,
        env: w.env,
        header: null,
        options: [],
        priority: '2',
        question,
        recommend: null,
        sessionId: OLD,
        to: null,
      });
      expect(asked.kind).toBe('filed');
    }
    const outcome = await handOff({
      cwd: w.repo,
      env: w.env,
      note: null,
      now: NOW,
      sessionId: OLD,
      timeZone: 'UTC',
      to: null,
    });
    const block = describeHandoffOutcome(outcome).lines.join('\n');
    const pairs = siblingPairs(block.split('\n'));
    const spaced = pairs.filter(
      (pair) =>
        /^\d+\. /u.test(pair.next) || pair.next === '- Nothing reads them.',
    );
    // 1 request pair, 1 question pair, 2 context pairs.
    expect(spaced).toHaveLength(4);
    expect(spaced.filter((pair) => pair.emptyLines < 2)).toEqual([]);
    // No pair anywhere sits exactly one empty line apart (that one is dropped).
    expect(pairs.filter((pair) => pair.emptyLines === 1)).toEqual([]);
  });

  test('--to a successor that already has a session bead links both now', async () => {
    const w = world([OLD, NEW]);
    const outcome = await handOff({
      cwd: w.repo,
      env: w.env,
      note: null,
      now: NOW,
      sessionId: OLD,
      to: NEW,
    });
    expect(outcome.kind === 'handedOff' && outcome.successor).toEqual({
      beadId: w.beads[NEW] ?? '',
      kind: 'linked',
    });
    expect(labelsOf(w, w.beads[OLD] ?? '')).toContain(
      `continued-by:${w.beads[NEW]}`,
    );
    expect(labelsOf(w, w.beads[NEW] ?? '')).toContain(
      `continues:${w.beads[OLD]}`,
    );
  });

  test('--to a successor with no session bead yet says it links itself later', async () => {
    const w = world();
    const outcome = await handOff({
      cwd: w.repo,
      env: w.env,
      note: null,
      now: NOW,
      sessionId: OLD,
      to: NEW,
    });
    expect(outcome.kind === 'handedOff' && outcome.successor).toEqual({
      kind: 'noBeadYet',
      sessionId: NEW,
    });
    expect(describeHandoffOutcome(outcome).lines.join('\n')).toContain(
      'has no session bead yet',
    );
  });
});

describe('thread request --continues', () => {
  test('alone, it links the new session to the old — both labels — and files nothing', async () => {
    const w = world([OLD, NEW]);
    await handOff({
      cwd: w.repo,
      env: w.env,
      note: null,
      now: NOW,
      sessionId: OLD,
      to: null,
    });
    const linked = await fileRequest({
      bead: null,
      continues: w.beads[OLD] ?? '',
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: NEW,
      title: null,
    });
    expect(linked).toEqual({
      kind: 'linked',
      newBeadId: w.beads[NEW] ?? '',
      oldBeadId: w.beads[OLD] ?? '',
      oldTitle: 'migrate the db',
    });
    expect(labelsOf(w, w.beads[NEW] ?? '')).toContain(
      `continues:${w.beads[OLD]}`,
    );
    expect(labelsOf(w, w.beads[OLD] ?? '')).toContain(
      `continued-by:${w.beads[NEW]}`,
    );
    // The old session now names its successor.
    const report = await loadSessionReport({
      asIfYielded: true,
      cwd: w.repo,
      env: w.env,
      now: NOW,
      selector: null,
      sessionId: OLD,
    });
    expect(report.kind === 'loaded' && report.status).toEqual({
      kind: 'handedOff',
      successor: w.beads[NEW] ?? '',
    });
  });

  test('with a title, it files the request AND links', async () => {
    const w = world([OLD, NEW]);
    const filed = await fileRequest({
      bead: null,
      continues: w.beads[OLD] ?? '',
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: NEW,
      title: 'Finish the orders migration',
    });
    expect(filed.kind === 'filed' && filed.continued).toEqual({
      oldBeadId: w.beads[OLD] ?? '',
      oldTitle: 'migrate the db',
    });
    expect(filed.kind === 'filed' && filed.followUpFailures).toEqual([]);
  });

  test('an unknown old bead is refused, and nothing is labelled', async () => {
    const w = world([NEW]);
    const linked = await fileRequest({
      bead: null,
      continues: 't-nope',
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: NEW,
      title: null,
    });
    expect(linked.kind).toBe('failed');
    expect(
      labelsOf(w, w.beads[NEW] ?? '').some((label) =>
        label.startsWith('continues:'),
      ),
    ).toBe(false);
  });
});
