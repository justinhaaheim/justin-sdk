/**
 * The mayor mark and the handoff number in session names (home-base-6n7my.2.1;
 * D1 to D6, D8 and D9 in the design field of home-base-6n7my.2), and the cut that
 * stopped garbling names (home-base-pz6gc).
 */

import type {ChainReaders} from '../src/thread/handoff-chain';
import type {MessageLogRead} from '../src/thread/message-log';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';

import {brShow, brUpdate, findBeadsWorkspace, runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {runAutoPickup} from '../src/thread/handoff-auto-pickup-run';
import {
  continuationLabels,
  handoffNumberOf,
  mayorSuccessorSentence,
  successorMarks,
} from '../src/thread/handoff-number';
import {pickUpHandoff} from '../src/thread/handoff-pickup';
import {
  successorClaudeWords,
  successorCommand,
  successorName,
} from '../src/thread/handoff-successor';
import {serializeMessageLine} from '../src/thread/message-log';
import {
  KICKOFF_OPENING,
  kickoffText,
  TYPED_COMMAND_BYTE_LIMIT,
  typedCommandBytes,
} from '../src/thread/respawn';
import {ensureSessionBead, MAYOR_ROLE_LABEL} from '../src/thread/session-bead';
import {
  handOff,
  healHandoffNumber,
  linkContinuation,
} from '../src/thread/session-handoff';
import {
  NO_MARKS,
  sessionDisplayName,
  sessionMarksOf,
  sessionName,
} from '../src/thread/session-name';
import {selectSession} from '../src/thread/session-select';
import {
  spawnCommand,
  spawnMarks,
  spawnWorkspaceName,
} from '../src/thread/spawn';
import {workspaceToolPart} from '../src/thread/workspace-name';
import {initRepo} from './git-fixtures';
import {needBr, PINNED_BR} from './pinned-br';
import {createSandbox} from './sandbox';

setDefaultTimeout(120_000);

const NUMBER_LABEL = 'handoff-number:';
const TITLE = 'migrate the db';

// ---------------------------------------------------------------------------
// The names (D1, D2)
// ---------------------------------------------------------------------------

describe('D1: the exact names', () => {
  test('a mayor after one handoff', () => {
    expect(sessionDisplayName('HOME', TITLE, {handoff: 1, mayor: true})).toBe(
      '[MAYOR] [HOME] H1 migrate the db',
    );
  });

  test('an ordinary session after two handoffs', () => {
    expect(sessionDisplayName('HOME', TITLE, {handoff: 2, mayor: false})).toBe(
      '[HOME] H2 migrate the db',
    );
  });

  test('a number that cannot be established', () => {
    expect(
      sessionDisplayName('HOME', TITLE, {handoff: 'unknown', mayor: false}),
    ).toBe('[HOME] H? migrate the db');
  });

  test('a first mayor session shows no number', () => {
    expect(
      sessionDisplayName('HOME', TITLE, {handoff: null, mayor: true}),
    ).toBe('[MAYOR] [HOME] migrate the db');
  });

  test('a first ordinary session shows no marks, passed or not', () => {
    expect(sessionDisplayName('HOME', TITLE, NO_MARKS)).toBe(
      '[HOME] migrate the db',
    );
    expect(sessionDisplayName('HOME', TITLE)).toBe('[HOME] migrate the db');
  });
});

describe('D2: the marks come from labels alone', () => {
  const name = (labels: string[]) =>
    sessionDisplayName('HOME', TITLE, sessionMarksOf(labels));

  test('a number label gives its number, with or without continues:', () => {
    expect(name([`${NUMBER_LABEL}3`, 'continues:t-a'])).toBe(
      '[HOME] H3 migrate the db',
    );
    expect(name([`${NUMBER_LABEL}3`])).toBe('[HOME] H3 migrate the db');
  });

  test('continues: with no number label gives H?', () => {
    expect(name(['continues:t-a'])).toBe('[HOME] H? migrate the db');
  });

  test('neither gives no mark', () => {
    expect(name(['session', 'sid:x'])).toBe('[HOME] migrate the db');
  });

  test('the mayor label gives the mayor mark, whatever else is there', () => {
    expect(name([MAYOR_ROLE_LABEL])).toBe('[MAYOR] [HOME] migrate the db');
    expect(name([MAYOR_ROLE_LABEL, `${NUMBER_LABEL}1`, 'continues:t-a'])).toBe(
      '[MAYOR] [HOME] H1 migrate the db',
    );
    expect(name([MAYOR_ROLE_LABEL, 'continues:t-a'])).toBe(
      '[MAYOR] [HOME] H? migrate the db',
    );
  });

  test('only session-role:mayor is the mark: not mayor-intake', () => {
    expect(name(['mayor-intake'])).toBe('[HOME] migrate the db');
  });

  test.each([
    [`${NUMBER_LABEL}abc`],
    [`${NUMBER_LABEL}`],
    [`${NUMBER_LABEL}0`],
    [`${NUMBER_LABEL}-1`],
    [`${NUMBER_LABEL}1.5`],
  ])('an unreadable label %s gives H?, never no mark', (label) => {
    expect(name([label])).toBe('[HOME] H? migrate the db');
  });

  test('two number labels give H?: neither is trusted', () => {
    expect(name([`${NUMBER_LABEL}2`, `${NUMBER_LABEL}3`])).toBe(
      '[HOME] H? migrate the db',
    );
  });
});

// ---------------------------------------------------------------------------
// The cut (home-base-pz6gc)
// ---------------------------------------------------------------------------

describe('home-base-pz6gc: the cut', () => {
  const LONG = 'y'.repeat(200);

  test('a cut name is exactly 80 characters, ends in ... and holds no …', () => {
    const name = sessionName('HOME', LONG);
    expect(name).toHaveLength(80);
    expect(name.endsWith('...')).toBe(true);
    expect(name).not.toContain('…');
    expect(name).toBe(`[HOME] ${'y'.repeat(70)}...`);
  });

  test('marks are kept: they are in front, and the title is what is cut', () => {
    const name = sessionName('HOME', LONG, {handoff: 12, mayor: true});
    expect(name).toHaveLength(80);
    expect(name.startsWith('[MAYOR] [HOME] H12 yyy')).toBe(true);
    expect(name.endsWith('y...')).toBe(true);
  });

  test('a name of exactly 80 characters is not cut, and 81 is', () => {
    const fits = 'y'.repeat(80 - '[HOME] '.length);
    expect(sessionName('HOME', fits)).toBe(`[HOME] ${fits}`);
    const over = sessionName('HOME', `${fits}y`);
    expect(over).toHaveLength(80);
    expect(over.endsWith('...')).toBe(true);
  });

  test('the cut never splits a surrogate pair, wherever one falls', () => {
    // Slide an emoji across the cut. `…` and a lone surrogate would both fail.
    for (let pad = 60; pad < 80; pad += 1) {
      const name = sessionName('H', `${'y'.repeat(pad)}${'😀'.repeat(40)}`);
      const units = Array.from(name);
      expect(units).toHaveLength(80);
      expect(name.endsWith('...')).toBe(true);
      expect(name.isWellFormed()).toBe(true);
    }
  });

  test('a … already in the title goes too, cut or not', () => {
    expect(sessionName('HOME', 'wait… what')).toBe('[HOME] wait... what');
    const cut = sessionName('HOME', `wait… ${LONG}`);
    expect(cut).toHaveLength(80);
    expect(cut).not.toContain('…');
  });

  test('the spawn workspace name uses the one cutter', () => {
    const name = spawnWorkspaceName('/nowhere/repo', LONG, {});
    expect(name).toHaveLength(80);
    expect(name.endsWith('...')).toBe(true);
    expect(name).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------
// The number rule (D3)
// ---------------------------------------------------------------------------

function logOf(text: string | null): MessageLogRead {
  return {
    failures: [],
    kind: 'read',
    lines:
      text == null
        ? []
        : [
            {
              at: '2030-01-01T09:00:00.000Z',
              cwd: '/x',
              event: 'UserPromptSubmit',
              role: 'user',
              text,
            },
          ],
    path: '/logs/x.jsonl',
  };
}

/** Beads by id. A log per `sid:`; absent means the log does not exist. */
function readersOf(
  beads: Record<string, readonly string[]>,
  logs: Record<string, MessageLogRead> = {},
): ChainReaders & {shown: string[]} {
  const shown: string[] = [];
  return {
    readLog: (sessionId) =>
      logs[sessionId] ?? {kind: 'missing', path: `/logs/${sessionId}.jsonl`},
    showBead: (beadId) => {
      shown.push(beadId);
      const labels = beads[beadId];
      return labels == null
        ? {kind: 'notFound', reason: `${beadId} is not in the DB`}
        : {kind: 'found', labels};
    },
    shown,
  };
}

const TYPED_LOG = {'sid-a': logOf('Justin typed this')};

describe('D3: the number rule', () => {
  test('a number label is the number, and nothing else is read', () => {
    const readers = readersOf({});
    expect(
      handoffNumberOf(
        {id: 't-c', labels: [`${NUMBER_LABEL}7`, 'continues:t-b']},
        readers,
      ),
    ).toEqual({kind: 'known', number: 7});
    expect(readers.shown).toEqual([]);
  });

  test('no continues: is 0, a first session', () => {
    expect(
      handoffNumberOf(
        {id: 't-a', labels: ['sid:sid-a']},
        readersOf({}, TYPED_LOG),
      ),
    ).toEqual({kind: 'known', number: 0});
  });

  test('continues: with no number is the count of steps back', () => {
    const readers = readersOf(
      {'t-a': ['sid:sid-a'], 't-b': ['continues:t-a']},
      TYPED_LOG,
    );
    expect(
      handoffNumberOf({id: 't-c', labels: ['continues:t-b']}, readers),
    ).toEqual({kind: 'known', number: 2});
    expect(readers.shown).toEqual(['t-b', 't-a']);
  });

  test('the walk stops at the first number label it meets, and adds to it', () => {
    const readers = readersOf({
      't-b': ['continues:t-a', `${NUMBER_LABEL}4`],
    });
    expect(
      handoffNumberOf({id: 't-c', labels: ['continues:t-b']}, readers),
    ).toEqual({kind: 'known', number: 5});
    expect(readers.shown).toEqual(['t-b']);
  });

  test('a problem found walking FORWARD does not make it unknown', () => {
    // Two successors on either bead: readHandoffChain adds this to `problems`.
    const readers = readersOf(
      {'t-a': ['sid:sid-a', 'continued-by:t-b', 'continued-by:t-x']},
      TYPED_LOG,
    );
    expect(
      handoffNumberOf(
        {
          id: 't-b',
          labels: ['continues:t-a', 'continued-by:t-c', 'continued-by:t-d'],
        },
        readers,
      ),
    ).toEqual({kind: 'known', number: 1});
  });

  describe('unknown, each naming why', () => {
    const unknownReason = (
      start: {id: string; labels: string[]},
      readers: ChainReaders,
      options: {limit?: number} = {},
    ): string => {
      const number = handoffNumberOf(start, readers, options);
      if (number.kind !== 'unknown') {
        throw new Error(`expected unknown, got ${JSON.stringify(number)}`);
      }
      return number.reason;
    };

    test('two predecessors, on the bead itself', () => {
      expect(
        unknownReason(
          {id: 't-c', labels: ['continues:t-a', 'continues:t-b']},
          readersOf({}),
        ),
      ).toContain('names 2 predecessors');
    });

    test('two predecessors, further back', () => {
      expect(
        unknownReason(
          {id: 't-c', labels: ['continues:t-b']},
          readersOf({'t-b': ['continues:t-a', 'continues:t-z']}),
        ),
      ).toContain('t-b names 2 predecessors');
    });

    test('a loop', () => {
      expect(
        unknownReason(
          {id: 't-a', labels: ['continues:t-b']},
          readersOf({'t-b': ['continues:t-a']}),
        ),
      ).toContain('loops back to t-a');
    });

    test('an unreadable predecessor', () => {
      expect(
        unknownReason({id: 't-b', labels: ['continues:t-a']}, readersOf({})),
      ).toContain('t-a, which could not be read');
    });

    test('a predecessor whose read failed, not just missing', () => {
      const readers: ChainReaders = {
        readLog: () => ({kind: 'missing', path: '/x'}),
        showBead: () => ({kind: 'failed', reason: 'database is locked'}),
      };
      expect(
        unknownReason({id: 't-b', labels: ['continues:t-a']}, readers),
      ).toContain('database is locked');
    });

    test('a session that began on a kickoff with no link', () => {
      const kickoff = kickoffText('/s/b.md', 't-old', null);
      expect(
        unknownReason(
          {id: 't-a', labels: ['sid:sid-a']},
          readersOf({}, {'sid-a': logOf(kickoff)}),
        ),
      ).toContain('began on a handoff kickoff');
    });

    test('the same kickoff at the far end of a walk', () => {
      const kickoff = kickoffText('/s/b.md', 't-old', null);
      expect(
        unknownReason(
          {id: 't-b', labels: ['continues:t-a']},
          readersOf({'t-a': ['sid:sid-a']}, {'sid-a': logOf(kickoff)}),
        ),
      ).toContain('began on a handoff kickoff');
    });

    test('a first session whose log does not exist, or cannot be read', () => {
      expect(
        unknownReason({id: 't-a', labels: ['sid:sid-a']}, readersOf({})),
      ).toContain('does not exist');
      expect(
        unknownReason(
          {id: 't-a', labels: ['sid:sid-a']},
          readersOf(
            {},
            {'sid-a': {error: 'EIO', kind: 'failed', path: '/logs/a'}},
          ),
        ),
      ).toContain('could not be read');
    });

    test('a first session with no sid: label, or two', () => {
      expect(unknownReason({id: 't-a', labels: []}, readersOf({}))).toContain(
        'which message log',
      );
      expect(
        unknownReason({id: 't-a', labels: ['sid:a', 'sid:b']}, readersOf({})),
      ).toContain('which message log');
    });

    test('a first session whose log has unreadable lines, or no user line', () => {
      expect(
        unknownReason(
          {id: 't-a', labels: ['sid:sid-a']},
          readersOf(
            {},
            {
              'sid-a': {
                ...logOf('Justin typed this'),
                failures: ['line 1 is not JSON'],
              } as MessageLogRead,
            },
          ),
        ),
      ).toContain('unreadable lines');
      expect(
        unknownReason(
          {id: 't-a', labels: ['sid:sid-a']},
          readersOf({}, {'sid-a': logOf(null)}),
        ),
      ).toContain('no user line');
    });

    test('a walk past the limit', () => {
      const beads: Record<string, string[]> = {};
      for (let index = 0; index < 5; index += 1) {
        beads[`t-${index}`] = [`continues:t-${index + 1}`];
      }
      expect(
        unknownReason(
          {id: 't-start', labels: ['continues:t-0']},
          readersOf(beads),
          {limit: 3},
        ),
      ).toContain('longer than 3');
    });

    test('an unreadable number label on the way back', () => {
      expect(
        unknownReason(
          {id: 't-b', labels: ['continues:t-a']},
          readersOf({'t-a': [`${NUMBER_LABEL}x`]}),
        ),
      ).toContain('is not a number');
    });

    test('a reader that throws is unknown, never a throw', () => {
      const readers: ChainReaders = {
        readLog: () => {
          throw new Error('log exploded');
        },
        showBead: () => {
          throw new Error('br exploded');
        },
      };
      expect(
        unknownReason({id: 't-b', labels: ['continues:t-a']}, readers),
      ).toContain('br exploded');
    });
  });
});

// ---------------------------------------------------------------------------
// The labels a link writes (D4) and the marks of what comes next (D9)
// ---------------------------------------------------------------------------

describe('D4: continuationLabels', () => {
  test('continues:, the next number, and the mayor label', () => {
    expect(
      continuationLabels({
        oldBeadId: 't-a',
        oldLabels: [MAYOR_ROLE_LABEL],
        oldNumber: {kind: 'known', number: 1},
      }),
    ).toEqual(['continues:t-a', `${NUMBER_LABEL}2`, MAYOR_ROLE_LABEL]);
  });

  test('a first session`s successor is number 1, with no mayor label', () => {
    expect(
      continuationLabels({
        oldBeadId: 't-a',
        oldLabels: ['session'],
        oldNumber: {kind: 'known', number: 0},
      }),
    ).toEqual(['continues:t-a', `${NUMBER_LABEL}1`]);
  });

  test('unknown writes no number label, so the reader shows H?', () => {
    const labels = continuationLabels({
      oldBeadId: 't-a',
      oldLabels: [],
      oldNumber: {kind: 'unknown', reason: 'loop'},
    });
    expect(labels).toEqual(['continues:t-a']);
    expect(sessionMarksOf(labels)).toEqual({handoff: 'unknown', mayor: false});
  });
});

describe('D9: successorMarks', () => {
  test('its own number plus 1, and H? when unknown', () => {
    expect(successorMarks([], {kind: 'known', number: 0})).toEqual({
      handoff: 1,
      mayor: false,
    });
    expect(successorMarks([], {kind: 'unknown', reason: 'x'})).toEqual({
      handoff: 'unknown',
      mayor: false,
    });
  });

  test('the mayor mark passes on', () => {
    expect(
      successorMarks([MAYOR_ROLE_LABEL], {kind: 'known', number: 3}),
    ).toEqual({handoff: 4, mayor: true});
  });
});

describe('D9: thread spawn', () => {
  test('--continues: that bead`s number plus 1, and its mayor label', () => {
    const readers = readersOf(
      {
        't-m': [MAYOR_ROLE_LABEL, `${NUMBER_LABEL}2`],
        't-p': ['sid:sid-a'],
      },
      TYPED_LOG,
    );
    const marks = (continues: string) =>
      spawnMarks({continues, cwd: '/x', dir: '/x', env: {}, readers});
    expect(marks('t-m')).toEqual({handoff: 3, mayor: true});
    expect(marks('t-p')).toEqual({handoff: 1, mayor: false});
  });

  test('no --continues: no marks, and no read', () => {
    const readers = readersOf({});
    expect(
      spawnMarks({continues: null, cwd: '/x', dir: '/x', env: {}, readers}),
    ).toEqual(NO_MARKS);
    expect(readers.shown).toEqual([]);
  });

  test('--continues with a bead that cannot be read gives H?', () => {
    expect(
      spawnMarks({
        continues: 't-gone',
        cwd: '/x',
        dir: '/x',
        env: {},
        readers: readersOf({}),
      }),
    ).toEqual({handoff: 'unknown', mayor: false});
  });

  test('the name carries the marks', () => {
    expect(
      spawnWorkspaceName('/nowhere/repo', TITLE, {}, {handoff: 3, mayor: true}),
    ).toBe('[MAYOR] [REPO] H3 migrate the db');
  });

  test('--name is always typed, with or without Remote Control', () => {
    const base = {
      kickoffFile: null,
      model: null,
      name: '[HOME] H? x',
      remoteControl: false,
    };
    expect(spawnCommand(base)).toBe(`claude --name '[HOME] H? x'`);
    expect(spawnCommand({...base, remoteControl: true})).toBe(
      `claude --remote-control '[HOME] H? x' --name '[HOME] H? x'`,
    );
  });
});

// ---------------------------------------------------------------------------
// The kickoff (D8)
// ---------------------------------------------------------------------------

describe('D8: the kickoff', () => {
  const SENTENCE = mayorSuccessorSentence([MAYOR_ROLE_LABEL]) ?? '';

  test('a mayor`s successor is told to load the skill, and it is not /mayor', () => {
    expect(SENTENCE).toContain('load the mayor skill with the Skill tool');
    const kickoff = kickoffText('/s/b.md', 't-a', SENTENCE, {autoPickup: true});
    expect(kickoff.startsWith(KICKOFF_OPENING)).toBe(true);
    expect(kickoff.endsWith(SENTENCE)).toBe(true);
    expect(kickoff.startsWith('/')).toBe(false);
  });

  test('an ordinary successor`s kickoff is unchanged', () => {
    expect(mayorSuccessorSentence(['session', 'mayor-intake'])).toBeNull();
    expect(
      kickoffText('/s/b.md', 't-a', mayorSuccessorSentence([]), {
        autoPickup: true,
      }),
    ).toBe(kickoffText('/s/b.md', 't-a', null, {autoPickup: true}));
  });

  test('an 80-character name with the mayor sentence stays under 1,000 bytes', () => {
    // A long but realistic block path; this one is 94 bytes.
    const block = `/Users/jhaa/.local/state/justin-threads/handoffs/${'0'.repeat(8)}-1111-4222-8333-000000000000.md`;
    const name = sessionName('HOME', 'y'.repeat(200), {
      handoff: 12,
      mayor: true,
    });
    expect(name).toHaveLength(80);
    const command = successorCommand(
      successorClaudeWords({
        continues: 'home-base-6n7my.2.1',
        kickoff: kickoffText('/x', 'home-base-6n7my.2.1', SENTENCE, {
          autoPickup: true,
        }).replace('/x', block),
        model: 'claude-opus-5-5',
        name,
        permissionMode: 'auto',
      }),
    );
    expect(typedCommandBytes(command)).toBeLessThan(TYPED_COMMAND_BYTE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Against real beads: every link path, one write
// ---------------------------------------------------------------------------

const A = '0a000000-1111-4222-8333-0000000000a1';
const B = '0b000000-1111-4222-8333-0000000000b1';
const C = '0c000000-1111-4222-8333-0000000000c1';

interface World {
  beads: Record<string, string>;
  brLog: string;
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
}

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function writeLog(
  session: string,
  text: string,
  env: Record<string, string | undefined>,
  repo: string,
): void {
  const path = messageLogPath(session, env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    serializeMessageLine({
      at: '2030-01-01T09:00:00.000Z',
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text,
    }),
  );
}

/** The br a bare `br` runs now, which the shim hands every call to. */
function runWhich(): string {
  // The pinned binary itself: a mise shim on PATH would find this test's shim
  // again and loop until br's timeout.
  if ('dir' in PINNED_BR) return join(PINNED_BR.dir, 'br');
  const found = Bun.which('br');
  if (found == null) throw new Error('br is not on PATH');
  return found;
}

/**
 * Session beads in a real repo, each with a log. A `br` shim on PATH records
 * every call, so a test can see which labels went in which write.
 */
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
  const shimDir = join(sb.path, 'shim');
  mkdirSync(shimDir, {recursive: true});
  const brLog = join(sb.path, 'br-calls.log');
  const realBr = runWhich();
  writeFileSync(
    join(shimDir, 'br'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${brLog}'\nexec '${realBr}' "$@"\n`,
  );
  chmodSync(join(shimDir, 'br'), 0o755);
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    HOME: process.env.HOME,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    PATH: [shimDir, process.env.PATH ?? ''].join(delimiter),
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
    writeLog(session, `step ${index + 1}`, env, repo);
  }
  return {beads, brLog, db: space.db, env, repo};
}

function beadOf(w: World, session: string): string {
  const id = w.beads[session];
  if (id == null) throw new Error(`no bead for ${session}`);
  return id;
}

function labelsOf(w: World, session: string): string[] {
  const shown = brShow({db: w.db, env: w.env}, beadOf(w, session));
  if (shown.kind !== 'ok') throw new Error(`could not read ${session}`);
  return shown.issue.labels;
}

function addLabels(w: World, session: string, labels: string[]): void {
  const written = brUpdate({db: w.db, env: w.env}, beadOf(w, session), {
    addLabels: labels,
  });
  if (written.kind === 'failed') throw new Error('br update failed');
}

function link(w: World, from: string, to: string): void {
  const linked = linkContinuation({
    cwd: w.repo,
    env: w.env,
    newSession: {beadId: beadOf(w, to), db: w.db},
    oldBeadId: beadOf(w, from),
  });
  if (linked.kind !== 'linked') throw new Error(linked.reason);
}

/** Every br call that wrote `continues:<old>`, as its whole argument line. */
function linkWrites(w: World, old: string): string[] {
  return readFileSync(w.brLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`--add-label=continues:${old}`));
}

function expectOneWrite(w: World, old: string, labels: string[]): void {
  const writes = linkWrites(w, old);
  expect(writes).toHaveLength(1);
  for (const label of labels) {
    expect(writes[0]).toContain(`--add-label=${label}`);
  }
}

describe('D4: every link path stamps the number and the mayor in one write', () => {
  test('linkContinuation: a first session`s successor is H1', () => {
    const w = world([A, B]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    link(w, A, B);
    const old = beadOf(w, A);
    for (const label of [
      `continues:${old}`,
      `${NUMBER_LABEL}1`,
      MAYOR_ROLE_LABEL,
    ]) {
      expect(labelsOf(w, B)).toContain(label);
    }
    expectOneWrite(w, old, [`${NUMBER_LABEL}1`, MAYOR_ROLE_LABEL]);
    expect(labelsOf(w, A)).toContain(`continued-by:${beadOf(w, B)}`);
  });

  test('an ordinary session passes on no mayor label', () => {
    const w = world([A, B]);
    link(w, A, B);
    expect(labelsOf(w, B)).not.toContain(MAYOR_ROLE_LABEL);
  });

  test('a chain counts up, and the label is what the next link reads', () => {
    const w = world([A, B, C]);
    link(w, A, B);
    link(w, B, C);
    expect(labelsOf(w, C)).toContain(`${NUMBER_LABEL}2`);
  });

  test('a predecessor linked before the label existed is walked', () => {
    const w = world([A, B, C]);
    addLabels(w, B, [`continues:${beadOf(w, A)}`]);
    link(w, B, C);
    expect(labelsOf(w, B)).not.toContain(`${NUMBER_LABEL}1`);
    expect(labelsOf(w, C)).toContain(`${NUMBER_LABEL}2`);
  });

  test('unknown: the link still happens, with no number label', () => {
    const w = world([A, B]);
    writeLog(A, kickoffText('/s/b.md', 't-old', null), w.env, w.repo);
    link(w, A, B);
    const labels = labelsOf(w, B);
    expect(labels).toContain(`continues:${beadOf(w, A)}`);
    expect(labels.some((label) => label.startsWith(NUMBER_LABEL))).toBe(false);
    expect(sessionMarksOf(labels).handoff).toBe('unknown');
  });

  test('thread handoff --to', async () => {
    const w = world([A, B]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    const outcome = await handOff({
      cwd: w.repo,
      env: {...w.env, CLAUDE_CODE_SESSION_ID: A},
      note: null,
      now: new Date('2030-01-01T12:00:00.000Z'),
      sessionId: A,
      to: B,
    });
    expect(outcome).toMatchObject({
      kind: 'handedOff',
      successor: {kind: 'linked'},
    });
    expectOneWrite(w, beadOf(w, A), [`${NUMBER_LABEL}1`, MAYOR_ROLE_LABEL]);
    for (const label of [`${NUMBER_LABEL}1`, MAYOR_ROLE_LABEL]) {
      expect(labelsOf(w, B)).toContain(label);
    }
  });

  test('thread request --continues (the pickup)', async () => {
    const w = world([A, B]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    const outcome = await pickUpHandoff(
      {
        cwd: w.repo,
        env: w.env,
        predecessorBeadId: beadOf(w, A),
        successor: {beadId: beadOf(w, B), db: w.db, sessionId: B},
      },
      {syncNames: () => Promise.resolve(null)},
    );
    expect(outcome.kind).toBe('picked-up');
    expectOneWrite(w, beadOf(w, A), [`${NUMBER_LABEL}1`, MAYOR_ROLE_LABEL]);
  });

  test('auto pickup, from the launch variable', async () => {
    const w = world([A, B]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    const outcome = await runAutoPickup({
      cwd: w.repo,
      env: {...w.env, JUSTIN_SDK_CONTINUES: beadOf(w, A)},
      now: new Date('2030-01-01T12:00:00.000Z'),
      sessionId: B,
    });
    expect(outcome).toMatchObject({kind: 'picked-up'});
    expectOneWrite(w, beadOf(w, A), [`${NUMBER_LABEL}1`, MAYOR_ROLE_LABEL]);
  });
});

describe('D8: the handoff block`s pick-up section', () => {
  const blockOf = async (w: World): Promise<string> => {
    const outcome = await handOff({
      cwd: w.repo,
      env: {...w.env, CLAUDE_CODE_SESSION_ID: A},
      note: null,
      now: new Date('2030-01-01T12:00:00.000Z'),
      sessionId: A,
      to: null,
    });
    if (outcome.kind !== 'handedOff') throw new Error(outcome.reason);
    return outcome.block;
  };

  test('a mayor`s block tells the new session to load the skill', async () => {
    const w = world([A]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    const block = await blockOf(w);
    const pickUp = block.slice(block.indexOf('**To pick it up:**'));
    expect(pickUp).toContain(mayorSuccessorSentence([MAYOR_ROLE_LABEL]) ?? '?');
  });

  test('an ordinary block does not', async () => {
    const block = await blockOf(world([A]));
    expect(block).not.toContain('mayor');
  });
});

describe('D9: successorName, against real beads', () => {
  function found(w: World, session: string) {
    const selected = selectSession({
      env: {...w.env, CLAUDE_CODE_SESSION_ID: session},
      selector: null,
      sessionIdOption: session,
    });
    if (selected.kind !== 'found') throw new Error(selected.kind);
    return selected.session;
  }

  test('its own number plus 1, with the mayor mark', () => {
    const w = world([A, B]);
    addLabels(w, A, [MAYOR_ROLE_LABEL]);
    link(w, A, B);
    expect(successorName(found(w, A), w.env)).toMatch(
      /^\[MAYOR\] \[CHAIN-REPO\] H1 /u,
    );
    expect(successorName(found(w, B), w.env)).toMatch(
      /^\[MAYOR\] \[CHAIN-REPO\] H2 /u,
    );
  });

  test('H? when its own number is unknown', () => {
    const w = world([A]);
    writeLog(A, kickoffText('/s/b.md', 't-old', null), w.env, w.repo);
    expect(successorName(found(w, A), w.env)).toMatch(/^\[CHAIN-REPO\] H\? /u);
  });

  test('an ordinary first session`s successor is H1 with no mayor mark', () => {
    const w = world([A]);
    expect(successorName(found(w, A), w.env)).toMatch(/^\[CHAIN-REPO\] H1 /u);
  });
});

// ---------------------------------------------------------------------------
// The self-heal (D5)
// ---------------------------------------------------------------------------

describe('D5: the self-heal', () => {
  const heal = (w: World, session: string, labels?: readonly string[]) =>
    healHandoffNumber({
      beadId: beadOf(w, session),
      db: w.db,
      env: w.env,
      labels: labels ?? labelsOf(w, session),
    });

  test('a session linked before the label existed gets its number, once', () => {
    const w = world([A, B]);
    addLabels(w, B, [`continues:${beadOf(w, A)}`]);
    const first = heal(w, B);
    expect(first).toMatchObject({kind: 'stamped', number: 1});
    expect(labelsOf(w, B)).toContain(`${NUMBER_LABEL}1`);
    if (first.kind !== 'stamped') throw new Error('not stamped');
    expect(first.labels).toContain(`${NUMBER_LABEL}1`);
    expect(heal(w, B)).toEqual({kind: 'current'});
  });

  test('a first session is left alone, and writes nothing', () => {
    const w = world([A]);
    const labels = labelsOf(w, A);
    const before = readFileSync(w.brLog, 'utf8');
    expect(heal(w, A, labels)).toEqual({kind: 'current'});
    expect(readFileSync(w.brLog, 'utf8')).toBe(before);
  });

  test('unknown writes nothing and says why', () => {
    const w = world([A]);
    const labels = [...labelsOf(w, A), 'continues:t-gone'];
    const outcome = heal(w, A, labels);
    expect(outcome.kind).toBe('unknown');
    expect(labelsOf(w, A).some((l) => l.startsWith(NUMBER_LABEL))).toBe(false);
  });

  test('an unknown DB is a failure, not a clean pass', () => {
    expect(
      healHandoffNumber({
        beadId: 't-b',
        db: null,
        env: {},
        labels: ['continues:t-a'],
      }),
    ).toMatchObject({kind: 'failed'});
  });

  test('a write that fails is a failure and does not throw', () => {
    const outcome = healHandoffNumber({
      beadId: 't-b',
      db: '/nowhere/.beads/beads.db',
      env: {PATH: process.env.PATH},
      labels: ['continues:t-a', 'sid:x'],
      readers: readersOf({'t-a': ['sid:sid-a']}, TYPED_LOG),
    });
    expect(outcome).toMatchObject({kind: 'failed'});
  });

  test('a reader that throws does not throw out of the heal', () => {
    const readers: ChainReaders = {
      readLog: () => {
        throw new Error('log exploded');
      },
      showBead: () => {
        throw new Error('br exploded');
      },
    };
    expect(
      healHandoffNumber({
        beadId: 't-b',
        db: '/x',
        env: {},
        labels: ['continues:t-a'],
        readers,
      }),
    ).toEqual({
      detail: 'reading the chain threw: Error: br exploded',
      kind: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// Where the marks show, from labels (D9)
// ---------------------------------------------------------------------------

describe('D9: the workspace name and the tab title', () => {
  const session = (labels: string[], title = TITLE) => ({
    beadId: 't-b',
    labels,
    repo: 'home-base',
    repoTag: 'HOME',
    sessionId: 'x',
    title,
  });

  test('workspaceToolPart', () => {
    expect(workspaceToolPart(session([]))).toBe('[HOME] migrate the db');
    expect(
      workspaceToolPart(
        session([MAYOR_ROLE_LABEL, 'continues:t-a', `${NUMBER_LABEL}1`]),
      ),
    ).toBe('[MAYOR] [HOME] H1 migrate the db');
    expect(workspaceToolPart(session(['continues:t-a']))).toBe(
      '[HOME] H? migrate the db',
    );
    expect(workspaceToolPart(session([MAYOR_ROLE_LABEL]))).toBe(
      '[MAYOR] [HOME] migrate the db',
    );
  });

  test('workspaceToolPart keeps the marks on the short label', () => {
    expect(
      workspaceToolPart({
        ...session(['continues:t-a', `${NUMBER_LABEL}2`]),
        overarchingShort: {ok: true, value: 'db move'},
      }),
    ).toBe('[HOME] H2 db move');
  });
});
