/**
 * The justin-loop handoff bead contract (home-base-1r6d.33.1).
 *
 * What these tests defend, in order of how badly it fails if it breaks:
 *   1. A malformed handoff must never validate. The bead IS the control channel
 *      (epic D2), so a handoff that parses when it shouldn't is a successor
 *      booted on garbage.
 *   2. `br` being unavailable must never read as "every handoff is valid" or as
 *      "no handoff exists" (critical rule 6) — exit 2 is its own answer.
 *   3. A session must never open a second handoff bead (D5). That is the
 *      1→2→4→8 fan-out the whole design exists to prevent, and an existing bead
 *      whose notes will not parse has an UNKNOWN `from`, so it counts as a
 *      conflict rather than being skipped.
 *   4. The successor's starting prompt must survive the round trip through br
 *      byte for byte — it is several paragraphs with quotes in it.
 *
 * The `br` boundary is injected for the branching tests, and the whole flow is
 * then replayed against BOTH real `br` binaries in the fleet (0.1.37 and 0.4.1),
 * because the flags and the JSON shape are the half a fake cannot vouch for.
 */

import {describe, expect, test, afterEach} from 'bun:test';
import {existsSync} from 'fs';
import {homedir} from 'os';
import {dirname, join} from 'path';

import {
  type BrOutcome,
  type BrRunner,
  HANDOFF_LABEL,
  runBr,
} from '../src/ralph';
import {
  checkErrors,
  createHandoff,
  type Handoff,
  type HandoffInput,
  handoffJson,
  handoffTitle,
  parseCreatedId,
  parseCreateFlags,
  parseHandoff,
  parseHandoffRows,
  renderCreate,
  renderValidate,
  validateHandoffs,
} from '../src/justin-loop/handoff';
import {initRepo} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

/**
 * Several paragraphs, a tab, and embedded double quotes — the realistic shape
 * of `next`, which IS the successor's prompt.
 */
const MULTI_PARAGRAPH_NEXT = [
  'Pick up home-base-1r6d.33.2 in the worktree named above.',
  '',
  'The predecessor left the parser half-done: `parseHandoff` is complete, but the runner still reads tmp/ralph-verdict.json. Delete that path entirely.',
  '\tDo NOT "fix" the verdict file — remove it.',
  '',
  'Then run `bun test` and report the exit code.',
].join('\n');

const VALID: Handoff = {
  arc: 'home-base-1r6d.33',
  branch: 'worktree-justin-loop-handoff',
  contextTokens: 312_000,
  createdAt: '2026-09-08T04:00:00.000Z',
  disposition: 'continue',
  from: 'justin-loop-1',
  next: MULTI_PARAGRAPH_NEXT,
  openQuestions: ['Should --next be required for disposition done?'],
  schemaVersion: 1,
  state: 'The schema and the creator landed. The validator is next.',
  worktree: '/Users/jhaa/Dev/home-base/.claude/worktrees/justin-loop-handoff',
};

/** The valid JSON with `patch` applied; a key set to undefined is REMOVED. */
function notesWith(patch: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {...VALID};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  }
  return JSON.stringify(obj, null, 2);
}

function errorsOf(notes: string | null | undefined): string[] {
  const parsed = parseHandoff(notes);
  return parsed.ok ? [] : parsed.errors;
}

// ---------------------------------------------------------------------------
// AC1 — parseHandoff
// ---------------------------------------------------------------------------

describe('parseHandoff', () => {
  test('accepts the D3 schema, with every field intact', () => {
    const parsed = parseHandoff(handoffJson(VALID));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff).toEqual(VALID);
    // The half that matters most: the successor's prompt is byte-identical.
    expect(parsed.handoff.next).toBe(MULTI_PARAGRAPH_NEXT);
  });

  test('rejects notes that are not JSON, saying so', () => {
    const errors = errorsOf(
      'picking up where session 1 left off, see the epic',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('notes is not valid JSON');
  });

  test('rejects empty notes', () => {
    expect(errorsOf('')[0]).toContain('notes is empty');
    expect(errorsOf('   \n ')[0]).toContain('notes is empty');
  });

  test('rejects ABSENT notes — br omits the key when a bead has none', () => {
    // The reachable state this defends: `br create` succeeded and
    // `br update --notes` did not. Skipping it would let a half-written
    // handoff read as no handoff at all.
    expect(errorsOf(null)[0]).toContain('notes is empty');
    expect(errorsOf(undefined)[0]).toContain('notes is empty');
  });

  test('rejects JSON that is not an object', () => {
    expect(errorsOf('[]')[0]).toContain('must be a JSON object');
    expect(errorsOf('"continue"')[0]).toContain('must be a JSON object');
    expect(errorsOf('7')[0]).toContain('must be a JSON object');
  });

  test('rejects a missing disposition, naming it', () => {
    const errors = errorsOf(notesWith({disposition: undefined}));
    expect(errors.join('\n')).toContain('disposition is missing');
    expect(errors.join('\n')).toContain('continue, done, blocked');
  });

  test('rejects an unknown disposition, naming it and the legal values', () => {
    const errors = errorsOf(notesWith({disposition: 'paused'}));
    expect(errors.join('\n')).toContain('disposition must be one of');
    expect(errors.join('\n')).toContain('"paused"');
  });

  test('rejects a missing from, naming it', () => {
    expect(errorsOf(notesWith({from: undefined}))).toContain('from is missing');
  });

  test('rejects a missing next, naming it', () => {
    expect(errorsOf(notesWith({next: undefined}))).toContain('next is missing');
  });

  test('rejects a missing worktree, naming it', () => {
    expect(errorsOf(notesWith({worktree: undefined}))).toContain(
      'worktree is missing',
    );
  });

  test('rejects a relative worktree — the successor starts in another cwd', () => {
    const errors = errorsOf(notesWith({worktree: '../some/worktree'}));
    expect(errors.join('\n')).toContain('worktree must be an absolute path');
  });

  test('rejects a missing branch, naming it', () => {
    expect(errorsOf(notesWith({branch: undefined}))).toContain(
      'branch is missing',
    );
  });

  test('rejects schemaVersion != 1, naming it and what it got', () => {
    const errors = errorsOf(notesWith({schemaVersion: 2}));
    expect(errors.join('\n')).toContain('schemaVersion must be 1 (got 2)');
    expect(errorsOf(notesWith({schemaVersion: undefined}))).toContain(
      'schemaVersion is missing',
    );
  });

  test('rejects a missing arc, state, createdAt', () => {
    expect(errorsOf(notesWith({arc: undefined}))).toContain('arc is missing');
    expect(errorsOf(notesWith({state: undefined}))).toContain(
      'state is missing',
    );
    expect(errorsOf(notesWith({createdAt: undefined}))).toContain(
      'createdAt is missing',
    );
    expect(
      errorsOf(notesWith({createdAt: 'last tuesday'})).join('\n'),
    ).toContain('createdAt is not a parseable timestamp');
  });

  test('rejects an absent openQuestions — [] is a claim, absent is not', () => {
    const errors = errorsOf(notesWith({openQuestions: undefined}));
    expect(errors.join('\n')).toContain('openQuestions is missing');
    expect(errors.join('\n')).toContain('write [] when there are none');
    // The positive control: an explicit empty list IS accepted.
    expect(parseHandoff(notesWith({openQuestions: []})).ok).toBe(true);
  });

  test('rejects an absent contextTokens, but accepts an explicit null', () => {
    // `null` means "not measured". Absent means nobody recorded anything, and
    // 0 would be a fabricated measurement (critical rule 6).
    expect(
      errorsOf(notesWith({contextTokens: undefined})).join('\n'),
    ).toContain('contextTokens is missing');
    expect(parseHandoff(notesWith({contextTokens: null})).ok).toBe(true);
    expect(errorsOf(notesWith({contextTokens: '312000'})).join('\n')).toContain(
      'contextTokens must be a number or null',
    );
  });

  test('reports EVERY bad field at once, not just the first', () => {
    const errors = errorsOf(
      notesWith({branch: undefined, from: undefined, next: undefined}),
    );
    expect(errors).toContain('from is missing');
    expect(errors).toContain('next is missing');
    expect(errors).toContain('branch is missing');
  });

  test('tolerates unknown extra keys (forward compatibility)', () => {
    expect(parseHandoff(notesWith({futureField: 'whatever'})).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Row parsing and id parsing
// ---------------------------------------------------------------------------

function listJson(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    has_more: false,
    issues: rows,
    limit: 50,
    offset: 0,
    total: rows.length,
  });
}

describe('parseHandoffRows', () => {
  test('an absent notes key becomes an explicit null, not a dropped row', () => {
    const rows = parseHandoffRows(
      listJson([
        {
          id: 'fx-1',
          labels: [HANDOFF_LABEL],
          status: 'open',
          title: 'HANDOFF continue: a',
        },
      ]),
    );
    expect(rows).toEqual([
      {
        id: 'fx-1',
        labels: [HANDOFF_LABEL],
        notes: null,
        status: 'open',
        title: 'HANDOFF continue: a',
        updatedAt: null,
      },
    ]);
  });

  test('an absent labels key means no labels', () => {
    const rows = parseHandoffRows(
      listJson([{id: 'fx-1', status: 'open', title: 'plain bead'}]),
    );
    expect(rows?.[0]?.labels).toEqual([]);
  });

  test('returns null — never [] — on unparseable or unexpected output', () => {
    expect(parseHandoffRows('not json')).toBeNull();
    expect(parseHandoffRows('{"total": 0}')).toBeNull();
    // One malformed row rejects the WHOLE list: silently dropping it would
    // understate the number of open handoffs, i.e. hide a conflict.
    expect(
      parseHandoffRows(
        listJson([
          {id: 'fx-1', status: 'open', title: 'ok'},
          {id: 'fx-2', status: 'open'},
        ]),
      ),
    ).toBeNull();
    expect(
      parseHandoffRows(
        listJson([{id: 'fx-1', labels: 'handoff', status: 'open', title: 'x'}]),
      ),
    ).toBeNull();
  });
});

describe('parseCreatedId', () => {
  test('parses the id out of a title that itself contains a colon', () => {
    expect(
      parseCreatedId('✓ Created fx-5yy: HANDOFF continue: home-base-1r6d.33\n'),
    ).toBe('fx-5yy');
  });

  test('returns null when the line does not name an id', () => {
    expect(parseCreatedId('')).toBeNull();
    expect(parseCreatedId('something else entirely')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createHandoff / validateHandoffs, with an injected br
// ---------------------------------------------------------------------------

const INPUT: HandoffInput = {
  arc: VALID.arc,
  branch: VALID.branch,
  contextTokens: VALID.contextTokens,
  disposition: VALID.disposition,
  from: VALID.from,
  next: VALID.next,
  openQuestions: VALID.openQuestions,
  state: VALID.state,
  worktree: VALID.worktree,
};

/** A scripted `br`: each call is matched against `replies` in order of key. */
function scriptedBr(replies: Array<(args: string[]) => BrOutcome | null>): {
  run: BrRunner;
  seen: () => string[][];
} {
  const seen: string[][] = [];
  return {
    run: (_cwd, args) => {
      seen.push(args);
      for (const reply of replies) {
        const out = reply(args);
        if (out != null) return out;
      }
      throw new Error(`unscripted br call: ${args.join(' ')}`);
    },
    seen: () => seen,
  };
}

function ok(stdout: string): BrOutcome {
  return {ok: true, reason: null, stdout};
}

describe('createHandoff', () => {
  test('creates, then writes the notes, and returns the id', () => {
    const br = scriptedBr([
      (a) => (a[0] === 'list' ? ok(listJson([])) : null),
      (a) =>
        a[0] === 'create'
          ? ok('✓ Created fx-abc: HANDOFF continue: x\n')
          : null,
      (a) => (a[0] === 'update' ? ok('Updated fx-abc') : null),
    ]);
    const out = createHandoff(
      '/repo',
      INPUT,
      br.run,
      () => new Date(VALID.createdAt),
    );
    expect(out.kind).toBe('created');
    if (out.kind !== 'created') return;
    expect(out.id).toBe('fx-abc');
    expect(parseHandoff(out.json)).toEqual({handoff: VALID, ok: true});

    const [list, create, update] = br.seen();
    expect(list).toEqual(['list', '-l', HANDOFF_LABEL, '--json']);
    expect(create?.slice(0, 8)).toEqual([
      'create',
      handoffTitle(VALID),
      '-t',
      'task',
      '-p',
      '1',
      '--labels',
      HANDOFF_LABEL,
    ]);
    // `--flag=value` form throughout, so a value starting with '-' survives.
    expect(create?.[8]?.startsWith('--description=')).toBe(true);
    expect(update?.[0]).toBe('update');
    expect(update?.[2]?.startsWith('--notes=')).toBe(true);
  });

  test('refuses a second OPEN handoff with the same from, printing its id', () => {
    const existing = listJson([
      {
        id: 'fx-first',
        labels: [HANDOFF_LABEL],
        notes: handoffJson(VALID),
        status: 'open',
        title: handoffTitle(VALID),
      },
    ]);
    const br = scriptedBr([(a) => (a[0] === 'list' ? ok(existing) : null)]);
    const out = createHandoff('/repo', INPUT, br.run);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.conflicts.map((c) => c.id)).toEqual(['fx-first']);
    expect(out.conflicts[0]?.kind).toBe('same-from');
    // Nothing was written — the scripted br would have thrown on a `create`.
    expect(br.seen()).toHaveLength(1);

    const report = renderCreate(out);
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('fx-first');
    expect(report.stdout).toEqual([]);
  });

  test('a different from is not a conflict', () => {
    const other = listJson([
      {
        id: 'fx-other',
        labels: [HANDOFF_LABEL],
        notes: handoffJson({...VALID, from: 'justin-loop-99'}),
        status: 'open',
        title: 'HANDOFF continue: another arc',
      },
    ]);
    const br = scriptedBr([
      (a) => (a[0] === 'list' ? ok(other) : null),
      (a) =>
        a[0] === 'create' ? ok('✓ Created fx-new: HANDOFF continue: x') : null,
      (a) => (a[0] === 'update' ? ok('Updated fx-new') : null),
    ]);
    expect(createHandoff('/repo', INPUT, br.run).kind).toBe('created');
  });

  test('an open handoff with UNREADABLE notes is a conflict, never a skip', () => {
    // Its `from` is unknown, so it cannot be ruled out as this session's. The
    // reassuring guess ("not mine, carry on") is the one that fans out.
    const broken = listJson([
      {
        id: 'fx-broken',
        labels: [HANDOFF_LABEL],
        notes: 'see the epic',
        status: 'open',
        title: 'HANDOFF continue: ???',
      },
    ]);
    const br = scriptedBr([(a) => (a[0] === 'list' ? ok(broken) : null)]);
    const out = createHandoff('/repo', INPUT, br.run);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.conflicts[0]?.kind).toBe('unreadable');
    expect(renderCreate(out).stderr.join('\n')).toContain('fx-broken');
  });

  test('br failing on the scan is UNAVAILABLE (exit 2), not "no conflict"', () => {
    const br: BrRunner = () => ({
      ok: false,
      reason: 'br exited 1: no workspace',
      stdout: '',
    });
    const out = createHandoff('/repo', INPUT, br);
    expect(out.kind).toBe('unavailable');
    const report = renderCreate(out);
    expect(report.exitCode).toBe(2);
    expect(report.stderr.join('\n')).toContain('No handoff bead was created');
    expect(report.stdout).toEqual([]);
  });

  test('an unparseable scan is UNAVAILABLE, not an empty list', () => {
    const br = scriptedBr([
      (a) => (a[0] === 'list' ? ok('<html>nope</html>') : null),
    ]);
    expect(createHandoff('/repo', INPUT, br.run).kind).toBe('unavailable');
  });

  test('a failed notes write reports INCOMPLETE with the id and the JSON', () => {
    // The two-step gap: the bead exists and will fail validation. Reporting a
    // bare failure would strand it invisibly.
    const br = scriptedBr([
      (a) => (a[0] === 'list' ? ok(listJson([])) : null),
      (a) =>
        a[0] === 'create'
          ? ok('✓ Created fx-halfway: HANDOFF continue: x')
          : null,
      (a) =>
        a[0] === 'update'
          ? {ok: false, reason: 'br exited 1: db locked', stdout: ''}
          : null,
    ]);
    const out = createHandoff('/repo', INPUT, br.run);
    expect(out.kind).toBe('incomplete');
    if (out.kind !== 'incomplete') return;
    expect(out.id).toBe('fx-halfway');
    const report = renderCreate(out);
    expect(report.exitCode).toBe(2);
    expect(report.stderr.join('\n')).toContain('fx-halfway');
    expect(report.stderr.join('\n')).toContain('br update fx-halfway --notes=');
    expect(report.stdout).toEqual([]);
  });

  test('a create whose output names no id is UNAVAILABLE, not created', () => {
    const br = scriptedBr([
      (a) => (a[0] === 'list' ? ok(listJson([])) : null),
      (a) => (a[0] === 'create' ? ok('done!') : null),
    ]);
    const out = createHandoff('/repo', INPUT, br.run);
    expect(out.kind).toBe('unavailable');
    expect(renderCreate(out).exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC4 — validate's exit codes
// ---------------------------------------------------------------------------

describe('validateHandoffs / renderValidate', () => {
  function validateWith(stdout: string, id: string | null = null) {
    const br = scriptedBr([() => ok(stdout)]);
    return renderValidate(validateHandoffs('/repo', id, br.run));
  }

  test('no open handoff beads: exit 0, and it SAYS none exist', () => {
    const report = validateWith(listJson([]));
    expect(report.exitCode).toBe(0);
    expect(report.stdout.join('\n')).toContain('no open handoff beads');
  });

  test('all valid: exit 0, naming each bead', () => {
    const report = validateWith(
      listJson([
        {
          id: 'fx-good',
          labels: [HANDOFF_LABEL],
          notes: handoffJson(VALID),
          status: 'open',
          title: handoffTitle(VALID),
        },
      ]),
    );
    expect(report.exitCode).toBe(0);
    expect(report.stdout.join('\n')).toContain('✓ fx-good valid');
    expect(report.stdout.join('\n')).toContain('1 valid, 0 invalid, 1 checked');
  });

  test('one invalid among several: exit 1, naming WHICH and why', () => {
    const report = validateWith(
      listJson([
        {
          id: 'fx-good',
          labels: [HANDOFF_LABEL],
          notes: handoffJson(VALID),
          status: 'open',
          title: handoffTitle(VALID),
        },
        {
          id: 'fx-bad',
          labels: [HANDOFF_LABEL],
          notes: notesWith({disposition: 'paused'}),
          status: 'open',
          title: 'HANDOFF paused: x',
        },
      ]),
    );
    expect(report.exitCode).toBe(1);
    expect(report.stdout.join('\n')).toContain('✗ fx-bad INVALID');
    expect(report.stdout.join('\n')).toContain('disposition must be one of');
    expect(report.stdout.join('\n')).toContain('1 valid, 1 invalid, 2 checked');
  });

  test('a handoff bead that lost its label is invalid — the scan cannot see it', () => {
    const report = validateWith(
      listJson([
        {
          id: 'fx-nolabel',
          notes: handoffJson(VALID),
          status: 'open',
          title: 'HANDOFF continue: x',
        },
      ]),
      'fx-nolabel',
    );
    expect(report.exitCode).toBe(1);
    expect(report.stdout.join('\n')).toContain('is not labelled `handoff`');
  });

  test('br unavailable: exit 2, and it says nothing was checked', () => {
    const br: BrRunner = () => ({
      ok: false,
      reason: 'br could not run: spawnSync br ENOENT',
      stdout: '',
    });
    const report = renderValidate(validateHandoffs('/repo', null, br));
    expect(report.exitCode).toBe(2);
    expect(report.stderr.join('\n')).toContain('br unavailable');
    expect(report.stderr.join('\n')).toContain('Nothing was checked');
  });

  test('an unparseable list is exit 2, NOT "0 open handoffs, all valid"', () => {
    const report = validateWith('<html>nope</html>');
    expect(report.exitCode).toBe(2);
  });

  test('a named id br does not have: exit 1, distinct from unavailable', () => {
    const report = validateWith(listJson([]), 'fx-ghost');
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('no bead fx-ghost');
  });

  test('by-id passes -a so a CLOSED handoff can still be validated', () => {
    const br = scriptedBr([
      () =>
        ok(
          listJson([
            {
              id: 'fx-closed',
              labels: [HANDOFF_LABEL],
              notes: handoffJson(VALID),
              status: 'closed',
              title: handoffTitle(VALID),
            },
          ]),
        ),
    ]);
    const out = validateHandoffs('/repo', 'fx-closed', br.run);
    expect(br.seen()[0]).toEqual(['list', '--id', 'fx-closed', '-a', '--json']);
    expect(renderValidate(out).exitCode).toBe(0);
  });
});

describe('checkErrors', () => {
  test('reports the label failure ahead of the JSON failures', () => {
    expect(
      checkErrors({
        id: 'fx-1',
        labelled: false,
        parse: parseHandoff(null),
        status: 'open',
        title: 't',
      }),
    ).toEqual([
      "bead is not labelled `handoff`, so the runner's scan will never see it",
      'notes is empty — a handoff bead must carry the handoff JSON in its notes field',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The argv → input seam
// ---------------------------------------------------------------------------

describe('parseCreateFlags', () => {
  const FULL = {
    arc: VALID.arc,
    branch: VALID.branch,
    // Not `VALID.contextTokens`: argv never carries null, only a number or
    // nothing at all, and it is the "nothing at all" case that must become null.
    contextTokens: 312_000,
    disposition: VALID.disposition,
    from: VALID.from,
    next: VALID.next,
    openQuestions: VALID.openQuestions,
    state: VALID.state,
    worktree: VALID.worktree,
  };

  test('accepts a full set', () => {
    const parsed = parseCreateFlags(FULL);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input).toEqual(INPUT);
  });

  test('names every missing required flag at once', () => {
    const parsed = parseCreateFlags({
      ...FULL,
      branch: undefined,
      from: undefined,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain('--from is required');
    expect(parsed.errors).toContain('--branch is required');
  });

  test('omitted --context-tokens becomes null, never 0', () => {
    const parsed = parseCreateFlags({...FULL, contextTokens: undefined});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.contextTokens).toBeNull();
  });

  test('omitted --open-question becomes an explicit empty list', () => {
    const parsed = parseCreateFlags({...FULL, openQuestions: undefined});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.openQuestions).toEqual([]);
  });

  test('rejects a bad disposition and a relative worktree by name', () => {
    const parsed = parseCreateFlags({
      ...FULL,
      disposition: 'paused',
      worktree: 'some/worktree',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join('\n')).toContain('--disposition must be one of');
    expect(parsed.errors.join('\n')).toContain(
      '--worktree must be an absolute path',
    );
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3/AC4 against the REAL br binaries — both versions in the fleet
// ---------------------------------------------------------------------------

/**
 * Resolved at module load so a machine missing a version reports its tests as
 * SKIPPED rather than green (an `if (!bin) return` inside the body is the
 * silence-shaped lie critical rule 6 forbids).
 *
 * The mise SHIM is deliberately not used: it resolves against the cwd's
 * mise.toml, which a temp sandbox does not have, and it pins one version while
 * the point here is to prove the command shapes hold across BOTH.
 */
const BR_VERSIONS = ['0.1.37', '0.4.1'] as const;

function brDirFor(version: string): string | null {
  const dir = join(
    homedir(),
    '.local/share/mise/installs/github-dicklesworthstone-beads-rust',
    version,
  );
  return existsSync(join(dir, 'br')) ? dir : null;
}

const CLI = join(dirname(import.meta.dirname), 'src', 'cli.ts');

for (const version of BR_VERSIONS) {
  const binDir = brDirFor(version);

  describe(`real br ${version}`, () => {
    /** `runBr` resolves `br` from PATH, so PATH is how a version is selected. */
    function realBr(cwd: string, args: string[]): BrOutcome {
      const original = process.env.PATH;
      process.env.PATH = `${binDir}:${original ?? ''}`;
      try {
        return runBr(cwd, args);
      } finally {
        process.env.PATH = original;
      }
    }

    function beadsRepo(): string {
      const repo = initRepo(track(createSandbox()), 'project', {
        'README.md': '# handoff fixture\n',
      });
      const init = realBr(repo, ['init', '--prefix', 'fx', '-q']);
      expect(init.ok).toBe(true);
      return repo;
    }

    function runCli(cwd: string, args: string[]) {
      const proc = Bun.spawnSync({
        cmd: ['bun', CLI, 'justin-loop', ...args],
        cwd,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        } as Record<string, string>,
      });
      return {
        status: proc.exitCode,
        stderr: proc.stderr.toString(),
        stdout: proc.stdout.toString(),
      };
    }

    test.skipIf(binDir == null)(
      'the CLI creates a bead that validate accepts, with `next` intact',
      () => {
        const repo = beadsRepo();
        const created = runCli(repo, [
          'handoff',
          `--from=${VALID.from}`,
          `--disposition=${VALID.disposition}`,
          `--arc=${VALID.arc}`,
          `--worktree=${repo}`,
          `--branch=${VALID.branch}`,
          `--state=${VALID.state}`,
          `--next=${MULTI_PARAGRAPH_NEXT}`,
          `--open-question=${VALID.openQuestions[0]}`,
          '--context-tokens=312000',
        ]);
        expect(created.status).toBe(0);
        // stdout is EXACTLY the id — the runner captures it with no parsing —
        // and the id came out of a title that itself contains a colon.
        const id = created.stdout.trim();
        expect(id).toMatch(/^fx-\S+$/);
        expect(created.stdout).toBe(`${id}\n`);

        const validated = runCli(repo, ['handoff', 'validate']);
        expect(validated.status).toBe(0);
        expect(validated.stdout).toContain(`✓ ${id} valid`);
        expect(validated.stdout).toContain('1 valid, 0 invalid, 1 checked');

        const byId = runCli(repo, ['handoff', 'validate', id]);
        expect(byId.status).toBe(0);
        expect(byId.stdout).toContain(`✓ ${id} valid`);

        // The multi-paragraph prompt survived br byte for byte.
        const back = validateHandoffs(repo, id, realBr);
        expect(back.kind).toBe('checked');
        if (back.kind !== 'checked') return;
        const parse = back.checks[0]?.parse;
        expect(parse?.ok).toBe(true);
        if (parse?.ok !== true) return;
        expect(parse.handoff.next).toBe(MULTI_PARAGRAPH_NEXT);
        expect(parse.handoff.contextTokens).toBe(312_000);
        expect(parse.handoff.openQuestions).toEqual([VALID.openQuestions[0]]);
        expect(back.checks[0]?.title).toBe(`HANDOFF continue: ${VALID.arc}`);
      },
    );

    test.skipIf(binDir == null)(
      'a second open handoff from the same session is refused, naming the first',
      () => {
        const repo = beadsRepo();
        const first = createHandoff(repo, {...INPUT, worktree: repo}, realBr);
        expect(first.kind).toBe('created');
        if (first.kind !== 'created') return;

        const second = runCli(repo, [
          'handoff',
          `--from=${VALID.from}`,
          '--disposition=done',
          '--arc=a-different-arc',
          `--worktree=${repo}`,
          '--branch=main',
          '--state=Everything is finished.',
          '--next=Nothing remains.',
        ]);
        expect(second.status).toBe(1);
        expect(second.stderr).toContain('REFUSED');
        expect(second.stderr).toContain(first.id);
        expect(second.stdout).toBe('');

        // NEGATIVE CONTROL: close the first, and the same command succeeds.
        const closed = realBr(repo, [
          'close',
          first.id,
          '--reason=picked up by justin-loop-2',
        ]);
        expect(closed.ok).toBe(true);

        const third = runCli(repo, [
          'handoff',
          `--from=${VALID.from}`,
          '--disposition=done',
          '--arc=a-different-arc',
          `--worktree=${repo}`,
          '--branch=main',
          '--state=Everything is finished.',
          '--next=Nothing remains.',
        ]);
        expect(third.status).toBe(0);
        expect(third.stdout.trim()).toMatch(/^fx-\S+$/);
        expect(third.stdout.trim()).not.toBe(first.id);
      },
    );

    test.skipIf(binDir == null)(
      'validate: none exist → 0; a note-less bead → 1; no beads workspace → 2',
      () => {
        const repo = beadsRepo();

        const empty = runCli(repo, ['handoff', 'validate']);
        expect(empty.status).toBe(0);
        expect(empty.stdout).toContain('no open handoff beads');

        // Exactly the two-step gap: `br create` landed, `--notes` never did.
        const bare = realBr(repo, [
          'create',
          'HANDOFF continue: crashed mid-create',
          '-t',
          'task',
          '-p',
          '1',
          '--labels',
          HANDOFF_LABEL,
          '--description=no notes were ever written',
        ]);
        expect(bare.ok).toBe(true);
        const bareId = parseCreatedId(bare.stdout);
        expect(bareId).not.toBeNull();

        const invalid = runCli(repo, ['handoff', 'validate']);
        expect(invalid.status).toBe(1);
        expect(invalid.stdout).toContain(`✗ ${bareId} INVALID`);
        expect(invalid.stdout).toContain('notes is empty');

        // A repo with no beads workspace: br fails, and that is exit 2 — never
        // "checked, and everything is fine".
        const noBeads = initRepo(track(createSandbox()), 'no-beads', {
          'README.md': '# no beads here\n',
        });
        const unavailable = runCli(noBeads, ['handoff', 'validate']);
        expect(unavailable.status).toBe(2);
        expect(unavailable.stderr).toContain('br unavailable');
        expect(unavailable.stderr).toContain('Nothing was checked');
      },
    );
  });
}
