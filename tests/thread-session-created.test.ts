/**
 * Which beads a session created with a plain `br create`, from its transcript
 * (home-base-vzwbj.4.19 D2): the pure scan, the reader over main plus
 * subagent transcripts, and the export lookup. The whatToMark integration
 * (real br, the 7a59f2e5 shape) is in thread-session-status.test.ts.
 *
 * The br output formats were measured with a real `br create` on 2026-10-17
 * (see session-created.ts's header).
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.19's notes.
 */

import type {CreatedBead} from '../src/thread/session-created';
import type {ExportRead} from '../src/thread/session-tree';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  createdBeadsFromText,
  createdIdsInOutput,
  isBrCreateCommand,
  notCreatedByCall,
  readCreatedBeads,
  resolveCreatedBeads,
} from '../src/thread/session-created';
import {createSandbox, type Sandbox} from './sandbox';
import {bashCallRecords, readCallRecords} from './transcript-records';

const SESSION = '5e551011-cccc-4ddd-8eee-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function jsonl(records: object[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function call(
  id: string,
  command: string,
  output: string,
  cwd = '/repo',
): object[] {
  return bashCallRecords({
    at: '2030-01-01T09:00:00.000Z',
    command,
    cwd,
    endAt: '2030-01-01T09:00:01.000Z',
    id,
    output,
    sessionId: SESSION,
  });
}

describe('isBrCreateCommand', () => {
  test.each([
    ['br create "Fix it" -t task', true],
    ['cd /repo && br create "Fix it" -t bug -p 1', true],
    ['br create --title "Fix it" --silent', true],
    ['br create "Fix it" --dry-run', false],
    ['br create --help', false],
    ['echo "br create is how you file one"', false],
    ['br show home-base-abc', false],
    ['bun run justin-sdk thread request "br create a bead"', false],
  ])('%s → %p', (command, expected) => {
    expect(isBrCreateCommand(command)).toBe(expected);
  });
});

describe('createdIdsInOutput: the formats br prints', () => {
  test('default: the ✓ Created line (and without the check mark)', () => {
    expect(
      createdIdsInOutput(
        'br create "Probe" -t task -p 4',
        '✓ Created home-base-jcngn: tmp probe: br create output format',
      ),
    ).toEqual(['home-base-jcngn']);
    expect(
      createdIdsInOutput('br create "x" --no-color', 'Created t-1a2b.3: x'),
    ).toEqual(['t-1a2b.3']);
  });

  test('--silent: the id alone on a line, only when the flag was given', () => {
    expect(
      createdIdsInOutput('br create "x" --silent', 'home-base-jcngn.1\n'),
    ).toEqual(['home-base-jcngn.1']);
    expect(createdIdsInOutput('br create "x"', 'home-base-jcngn.1\n')).toEqual(
      [],
    );
  });

  test('--json: the top-level id, not the dependency ids', () => {
    const output = JSON.stringify(
      {
        dependencies: [
          {
            depends_on_id: 'home-base-jcngn',
            issue_id: 'home-base-jcngn.2',
            type: 'parent-child',
          },
        ],
        id: 'home-base-jcngn.2',
        title: 'tmp probe 3',
      },
      null,
      2,
    );
    expect(
      createdIdsInOutput(
        'br create "x" --parent home-base-jcngn --json',
        output,
      ),
    ).toEqual(['home-base-jcngn.2']);
  });

  test('--dry-run creates nothing', () => {
    expect(
      createdIdsInOutput(
        'br create "x" --dry-run',
        'Dry run: would create issue home-base-4vjm1\nTitle: x',
      ),
    ).toEqual([]);
  });
});

describe('createdBeadsFromText', () => {
  test('a br create call and its result, with the cwd and time of the call', () => {
    const text = jsonl(
      call(
        'toolu_1',
        'br create "Decide the hooks" -t task',
        '✓ Created home-base-s4r5v: Decide the hooks',
        '/repo/.claude/worktrees/hooks',
      ),
    );
    expect(createdBeadsFromText(text, 'main.jsonl')).toEqual({
      created: [
        {
          createdAt: '2030-01-01T09:00:00.000Z',
          cwd: '/repo/.claude/worktrees/hooks',
          file: 'main.jsonl',
          id: 'home-base-s4r5v',
          resultAt: '2030-01-01T09:00:01.000Z',
        },
      ],
      unparsedLines: 0,
    });
  });

  test('a confirmation line in some other call’s result is not a creation', () => {
    const text = jsonl([
      ...call('toolu_cat', 'cat notes.txt', '✓ Created home-base-zzzzz: x'),
      ...readCallRecords({
        at: '2030-01-01T09:01:00.000Z',
        cwd: '/repo',
        id: 'toolu_read',
        output: '✓ Created home-base-yyyyy: y',
        sessionId: SESSION,
      }),
    ]);
    expect(createdBeadsFromText(text, 'main.jsonl').created).toEqual([]);
  });

  test('a repeated tool_use with no timestamp (api-request-blob) is one call, dated by the record that has a time', () => {
    const [use, result] = call(
      'toolu_1',
      'br create "x" -t task',
      '✓ Created t-abc: x',
    );
    if (use == null || result == null) throw new Error('no records');
    const blob = {...use, timestamp: undefined};
    const text = jsonl([blob, use, result, result]);
    const {created} = createdBeadsFromText(text, 'main.jsonl');
    expect(created.map((bead) => [bead.id, bead.createdAt])).toEqual([
      ['t-abc', '2030-01-01T09:00:00.000Z'],
    ]);
  });

  test('a call with no result yet created nothing that can be named', () => {
    const [use] = call('toolu_1', 'br create "x" -t task', 'unused');
    if (use == null) throw new Error('no record');
    expect(createdBeadsFromText(jsonl([use]), 'main.jsonl').created).toEqual(
      [],
    );
  });
});

describe('readCreatedBeads: main and subagent transcripts', () => {
  function transcript(sb: Sandbox): string {
    const path = join(sb.path, `${SESSION}.jsonl`);
    writeFileSync(
      path,
      jsonl(call('toolu_main', 'br create "a" -t task', '✓ Created t-main: a')),
    );
    return path;
  }

  test('a player’s br create counts as the session’s', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const path = transcript(sb);
    const dir = join(sb.path, SESSION, 'subagents');
    mkdirSync(dir, {recursive: true});
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      jsonl(
        call('toolu_sub', 'br create "b" -t bug --silent', 't-sub\n').map(
          (record) => ({...record, isSidechain: true}),
        ),
      ),
    );
    const read = readCreatedBeads(path);
    if (!read.ok) throw new Error(read.reason);
    expect(read.evidence.created.map((bead) => bead.id)).toEqual([
      't-main',
      't-sub',
    ]);
    expect(read.evidence.files).toHaveLength(2);
  });

  test('an unreadable transcript is a failure, never "created none"', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const path = transcript(sb);
    rmSync(path);
    const read = readCreatedBeads(path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('could not read');
  });
});

describe('resolveCreatedBeads: finding them in the exports', () => {
  /** A call at the time record() stamps on its beads (F6 compares them). */
  function made(id: string, cwd: string | null): CreatedBead {
    return {
      createdAt: '2030-01-01T09:00:00.000Z',
      cwd,
      file: 'm',
      id,
      resultAt: '2030-01-01T09:00:01.000Z',
    };
  }

  function record(
    id: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      created_at: '2030-01-01T09:00:00Z',
      id,
      issue_type: 'task',
      priority: 2,
      status: 'open',
      title: `title of ${id}`,
      updated_at: '2030-01-01T09:00:00Z',
      ...over,
    };
  }

  function exports(
    files: Record<string, Record<string, unknown>[] | null>,
  ): (dir: string) => ExportRead {
    return (dir) => {
      const records = files[dir];
      const path = `${dir}/issues.jsonl`;
      if (records === undefined) {
        return {kind: 'failed', path, reason: `${path} does not exist`};
      }
      if (records === null) {
        return {kind: 'failed', path, reason: `could not read ${path}: EACCES`};
      }
      return {kind: 'read', path, text: jsonl(records)};
    };
  }

  test('a bead in the worktree the br create ran in, not in the session’s own DB (session 7a59f2e5)', () => {
    const resolved = resolveCreatedBeads({
      created: [made('hb-s4r5v', '/hb/.claude/worktrees/hooks')],
      readExport: exports({
        '/hb/.beads': [record('hb-dnde4')],
        '/hb/.claude/worktrees/hooks/.beads': [
          record('hb-s4r5v', {status: 'closed'}),
        ],
      }),
      sessionDirs: ['/hb/.beads'],
      workspaceOf: (cwd) => `${cwd}/.beads`,
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.value.found.map((bead) => [bead.id, bead.status])).toEqual([
      ['hb-s4r5v', 'closed'],
    ]);
    expect(resolved.value.missing).toEqual([]);
  });

  test('an id no export holds is missing, with what was searched; a deleted one is neither', () => {
    const resolved = resolveCreatedBeads({
      created: [made('hb-gone', null), made('hb-deleted', null)],
      readExport: exports({
        '/hb/.beads': [record('hb-deleted', {status: 'tombstone'})],
      }),
      sessionDirs: ['/hb/.beads'],
      workspaceOf: () => null,
    });
    expect(resolved).toEqual({
      ok: true,
      value: {
        found: [],
        missing: [{id: 'hb-gone', searched: ['/hb/.beads/issues.jsonl']}],
        notCreatedThen: [],
      },
    });
  });

  test('an export that cannot be read is unmeasured, never "not found"', () => {
    const resolved = resolveCreatedBeads({
      created: [made('hb-x', null)],
      readExport: exports({'/hb/.beads': null}),
      sessionDirs: ['/hb/.beads'],
      workspaceOf: () => null,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain('EACCES');
  });

  test('one id in two exports: the newer record wins', () => {
    const resolved = resolveCreatedBeads({
      created: [made('hb-x', '/wt')],
      readExport: exports({
        '/hb/.beads': [
          record('hb-x', {status: 'open', updated_at: '2030-01-01T09:00:00Z'}),
        ],
        '/wt/.beads': [
          record('hb-x', {
            status: 'closed',
            updated_at: '2030-01-01T10:00:00Z',
          }),
        ],
      }),
      sessionDirs: ['/hb/.beads'],
      workspaceOf: (cwd) => `${cwd}/.beads`,
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.value.found.map((bead) => bead.status)).toEqual(['closed']);
  });

  test('j8q3e.13 F6: br create --json … && br show Y --json, Y made a day earlier: Y is named "not created then", never found', () => {
    const text = jsonl(
      call(
        'toolu_json',
        'br create "New" -t task --json && br show hb-older --json',
        '{"id":"hb-new","title":"New"}\n[{"id":"hb-older","title":"Older"}]',
      ),
    );
    const {created} = createdBeadsFromText(text, 'm');
    expect(created.map((bead) => bead.id)).toEqual(['hb-new', 'hb-older']);
    const resolved = resolveCreatedBeads({
      created,
      readExport: exports({
        '/hb/.beads': [
          record('hb-new', {created_at: '2030-01-01T09:00:00.400Z'}),
          record('hb-older', {created_at: '2029-12-31T09:00:00Z'}),
        ],
      }),
      sessionDirs: ['/hb/.beads'],
      workspaceOf: () => null,
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.value.found.map((bead) => bead.id)).toEqual(['hb-new']);
    expect(resolved.value.notCreatedThen).toEqual([
      {
        id: 'hb-older',
        why: 'created 2029-12-31T09:00:00Z, the call was at 2030-01-01T09:00:00.000Z',
      },
    ]);
  });
});

describe('j8q3e.13 F5: br q is a create, read like --silent', () => {
  test('br q and its bare-id result: the id is created by this session', () => {
    expect(isBrCreateCommand('br q "Decide X"')).toBe(true);
    expect(isBrCreateCommand('br q --help')).toBe(false);
    expect(isBrCreateCommand('echo "br q x"')).toBe(false);
    const text = jsonl(call('toolu_q', 'br q "Decide X"', 'probe-sgj\n'));
    expect(
      createdBeadsFromText(text, 'm').created.map((bead) => bead.id),
    ).toEqual(['probe-sgj']);
    expect(
      createdIdsInOutput(
        'br q --json Decide Y',
        '{"id":"probe-16p","title":"Decide Y"}\n',
      ),
    ).toEqual(['probe-16p']);
  });
});

describe('j8q3e.13 F6: the window (notCreatedByCall)', () => {
  const callAt = {
    createdAt: '2030-01-01T09:00:00.000Z',
    resultAt: '2030-01-01T09:00:02.000Z',
  };
  test('made at the call, or within 5 minutes after it: created by it', () => {
    expect(
      notCreatedByCall(callAt, {createdAt: '2030-01-01T09:00:00.900Z'}),
    ).toBeNull();
    expect(
      notCreatedByCall(callAt, {createdAt: '2030-01-01T09:04:59.000Z'}),
    ).toBeNull();
    // A permission prompt held the call: its result came back 20 min later.
    expect(
      notCreatedByCall(
        {...callAt, resultAt: '2030-01-01T09:20:00.000Z'},
        {createdAt: '2030-01-01T09:19:30.000Z'},
      ),
    ).toBeNull();
  });

  test('made before the call, or long after it, or with no time to compare: not created by it', () => {
    expect(
      notCreatedByCall(callAt, {createdAt: '2029-12-31T09:00:00Z'}),
    ).toContain('created 2029-12-31');
    expect(
      notCreatedByCall(callAt, {createdAt: '2030-01-01T09:10:00.000Z'}),
    ).not.toBeNull();
    expect(
      notCreatedByCall(
        {createdAt: null, resultAt: null},
        {createdAt: '2030-01-01T09:00:00Z'},
      ),
    ).toBe('the call has no time to compare');
    expect(notCreatedByCall(callAt, {createdAt: null})).toBe(
      'its export has no created_at to compare',
    );
  });
});
