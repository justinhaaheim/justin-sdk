/**
 * How a justin-loop session BOOTS (home-base-1r6d.33.2).
 *
 * There is no session-to-session channel by design (D1/D2) — a committed handoff
 * bead is the whole transport — so everything here is: read the beads, decide
 * which one (if any) is a starting point, and compose the prompt and system
 * prompt the next session actually receives.
 *
 * What these tests are defending, in order of how badly it fails if it breaks:
 *   1. `br` being unavailable must never read as "no handoff is waiting".
 *   2. A bead the runner cannot PARSE must never become a successor's prompt,
 *      and must never be silently dropped from the report either.
 *   3. A `done` or `blocked` bead is a finished chain, not a starting point.
 *   4. A session that left nothing behind must never boot a successor that
 *      thinks it received a handoff.
 *
 * The `br` boundary is injected everywhere, so the branching is provable without
 * a beads workspace — plus one scripted simulation against the REAL `br` binary,
 * because the flags and the JSON shape are the half a fake cannot vouch for.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {type BrOutcome, runBr} from '../src/justin-loop/br';
import {
  type Handoff,
  HANDOFF_LABEL,
  handoffJson,
  type HandoffRow,
} from '../src/justin-loop/handoff';
import {
  type BootContext,
  bootContract,
  bootPreamble,
  composeBootPrompt,
  crashBootPlan,
  EXPLICIT_SKIP_LINE,
  planStartBoot,
  scanHandoffBeads,
  sessionPrompt,
} from '../src/justin-loop/runner';
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

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    arc: 'home-base-1r6d.33',
    branch: 'worktree-justin-loop-runner',
    contextTokens: 302_000,
    createdAt: '2026-09-08T04:00:00Z',
    disposition: 'continue',
    from: 'the-arc-1',
    next: 'Finish the parser, then run bun test.',
    openQuestions: [],
    schemaVersion: 1,
    state: 'The parser is half written.',
    worktree: '/Users/jhaa/Dev/home-base',
    ...over,
  };
}

/** `br list --json` output carrying the notes and labels the runner reads. */
function listJson(
  rows: Array<{
    id: string;
    title?: string;
    status?: string;
    notes?: string | null;
    labels?: string[];
    updated_at?: string | null;
  }>,
): string {
  return JSON.stringify({
    issues: rows.map((r) => ({
      id: r.id,
      labels: r.labels ?? [HANDOFF_LABEL],
      ...(r.notes === undefined ? {} : {notes: r.notes}),
      status: r.status ?? 'open',
      title: r.title ?? 'HANDOFF continue: an arc',
      updated_at: r.updated_at,
    })),
    total: rows.length,
  });
}

const EMPTY_BR_LIST =
  '{"issues": [], "total": 0, "limit": 50, "offset": 0, "has_more": false}';

/** A `br` that always succeeds with this stdout, recording the argv it saw. */
function fakeBr(stdout: string): {
  run: (cwd: string, args: string[]) => BrOutcome;
  seen: () => string[][];
} {
  const seen: string[][] = [];
  return {
    run: (_cwd: string, args: string[]) => {
      seen.push(args);
      return {ok: true, reason: null, stdout};
    },
    seen: () => seen,
  };
}

/** A `br` that always fails, the way a repo with no beads workspace does. */
function brokenBr(reason: string): (cwd: string, args: string[]) => BrOutcome {
  return () => ({ok: false, reason, stdout: ''});
}

function row(over: Partial<HandoffRow> = {}): HandoffRow {
  return {
    id: 'hoff-1',
    labels: [HANDOFF_LABEL],
    notes: handoffJson(handoff()),
    status: 'open',
    title: 'HANDOFF continue: an arc',
    updatedAt: '2026-09-08T04:00:00Z',
    ...over,
  };
}

describe('runBr', () => {
  /**
   * `br`'s auto-import runs a real `git merge origin/main` in the working
   * directory (home-base c2u5 — a merge that "appeared out of nowhere" in a
   * worktree). An unattended loop runner doing that mid-session would be far
   * worse than a stale bead list, so every call carries --no-auto-import.
   */
  function withFakeBr<T>(script: string[], body: (log: string) => T): T {
    const sb = track(createSandbox());
    const binDir = join(sb.path, 'fakebin');
    mkdirSync(binDir, {recursive: true});
    const log = join(sb.path, 'br-calls.log');
    const fake = join(binDir, 'br');
    writeFileSync(
      fake,
      ['#!/bin/sh', `echo "$@" >> ${JSON.stringify(log)}`, ...script].join(
        '\n',
      ),
    );
    chmodSync(fake, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${binDir}:${original ?? ''}`;
    try {
      return body(log);
    } finally {
      process.env.PATH = original;
    }
  }

  test('never lets br auto-import (which would git-merge in the worktree)', () => {
    withFakeBr(["printf '%s' '{\"issues\":[]}'", 'exit 0'], (log) => {
      const out = runBr(process.cwd(), ['list', '--json']);
      expect(out.ok).toBe(true);
      // Read synchronously: an unawaited `.resolves` assertion would pass
      // whatever the file said.
      expect(readFileSync(log, 'utf8')).toContain('--no-auto-import');
    });
  });

  test('a non-zero exit is a failure carrying br own stderr, not empty output', () => {
    withFakeBr(['echo "no beads database found" >&2', 'exit 1'], () => {
      const out = runBr(process.cwd(), ['list', '--json']);
      expect(out.ok).toBe(false);
      expect(out.stdout).toBe('');
      expect(out.reason).toContain('no beads database found');
    });
  });
});

describe('scanHandoffBeads', () => {
  test('asks br for open beads carrying the handoff label, as JSON', () => {
    const br = fakeBr(EMPTY_BR_LIST);
    scanHandoffBeads('/repo', br.run);
    expect(br.seen()).toEqual([['list', '-l', HANDOFF_LABEL, '--json']]);
  });

  test('a br failure is UNAVAILABLE, never an empty list', () => {
    // The whole point: "we could not look" and "we looked and there is nothing"
    // must not collapse into the same answer (critical rule 6).
    const scan = scanHandoffBeads(
      '/repo',
      brokenBr('br exited 1: no workspace'),
    );
    expect(scan.kind).toBe('unavailable');
    expect(scan.kind === 'unavailable' ? scan.reason : '').toContain(
      'no workspace',
    );
  });

  test('unparseable output is UNAVAILABLE too', () => {
    const scan = scanHandoffBeads('/repo', fakeBr('not json at all').run);
    expect(scan.kind).toBe('unavailable');
  });

  test('a genuinely empty workspace reports ok with no rows', () => {
    const scan = scanHandoffBeads('/repo', fakeBr(EMPTY_BR_LIST).run);
    expect(scan.kind).toBe('ok');
    expect(scan.kind === 'ok' ? scan.rows : null).toEqual([]);
  });

  test('the rows carry the notes, which are the whole contract (D3)', () => {
    const scan = scanHandoffBeads(
      '/repo',
      fakeBr(listJson([{id: 'hoff-9', notes: handoffJson(handoff())}])).run,
    );
    expect(scan.kind === 'ok' ? scan.rows[0]?.notes : null).toContain(
      '"disposition": "continue"',
    );
  });
});

describe('planStartBoot — the start-of-run pickup', () => {
  test('an unavailable scan starts fresh and SAYS it could not look', () => {
    const start = planStartBoot(
      scanHandoffBeads('/repo', brokenBr('br exited 1: no workspace')),
    );
    expect(start.plan.kind).toBe('fresh');
    expect(start.report.join('\n')).toContain('UNAVAILABLE');
    expect(start.report.join('\n')).toContain('may exist and not be seen');
  });

  test('an empty workspace says it CHECKED and found none', () => {
    const start = planStartBoot({kind: 'ok', rows: []});
    expect(start.plan.kind).toBe('fresh');
    expect(start.report.join('\n')).toContain('no open handoff beads');
    expect(start.report.join('\n')).toContain('checked');
  });

  test('one waiting continue-handoff becomes the boot pickup', () => {
    const start = planStartBoot({kind: 'ok', rows: [row({id: 'hoff-7'})]});
    expect(start.plan.kind).toBe('handoff');
    expect(start.plan.kind === 'handoff' ? start.plan.match.row.id : null).toBe(
      'hoff-7',
    );
    expect(start.report.join('\n')).toContain('picking up handoff hoff-7');
  });

  test('several arcs: picks the newest and NAMES the ones it is not taking', () => {
    const start = planStartBoot({
      kind: 'ok',
      rows: [
        row({id: 'hoff-old', updatedAt: '2026-08-01T00:00:00Z'}),
        row({id: 'hoff-new', updatedAt: '2026-09-01T00:00:00Z'}),
        row({id: 'hoff-mid', updatedAt: '2026-08-15T00:00:00Z'}),
      ],
    });
    expect(start.plan.kind === 'handoff' ? start.plan.match.row.id : null).toBe(
      'hoff-new',
    );
    const report = start.report.join('\n');
    expect(report).toContain('hoff-old');
    expect(report).toContain('hoff-mid');
    expect(report).toContain('NOT picked up');
  });

  test('a bead with no timestamp never wins the "newest" contest', () => {
    // A missing timestamp is not evidence of being newest. It sorts last rather
    // than winning by accident.
    const start = planStartBoot({
      kind: 'ok',
      rows: [
        row({id: 'hoff-undated', updatedAt: null}),
        row({id: 'hoff-dated', updatedAt: '2026-08-01T00:00:00Z'}),
      ],
    });
    expect(start.plan.kind === 'handoff' ? start.plan.match.row.id : null).toBe(
      'hoff-dated',
    );
  });
});

/**
 * D10: the start scan picks up only a bead that PARSES and says `continue`.
 *
 * This is the half that changed when the bead became the control channel. A bead
 * the runner cannot read is not a prompt, and a `done`/`blocked` bead is a
 * finished chain — but "not eligible" must never be delivered as silence, so
 * every rejected bead is still named with its reason.
 */
describe('planStartBoot — only a valid `continue` bead is a starting point (D10)', () => {
  test('an UNREADABLE bead is never picked up, and is named as unreadable', () => {
    const start = planStartBoot({
      kind: 'ok',
      rows: [row({id: 'hoff-broken', notes: 'see the epic'})],
    });
    expect(start.plan.kind).toBe('fresh');
    const report = start.report.join('\n');
    expect(report).toContain('hoff-broken');
    expect(report).toContain('UNREADABLE');
    expect(report).toContain('none eligible');
  });

  test('a bead with no notes at all is unreadable, not empty', () => {
    // The reachable two-step-create gap: `br create` succeeded, `br update
    // --notes` did not. br omits the key entirely, and that must not read as
    // "an empty handoff", which is what a `?? ''` would make it.
    const start = planStartBoot({
      kind: 'ok',
      rows: [row({id: 'hoff-noteless', notes: null})],
    });
    expect(start.plan.kind).toBe('fresh');
    expect(start.report.join('\n')).toContain('hoff-noteless');
  });

  test('a `done` bead is a finished chain, not a starting point', () => {
    const start = planStartBoot({
      kind: 'ok',
      rows: [
        row({
          id: 'hoff-done',
          notes: handoffJson(handoff({disposition: 'done'})),
        }),
      ],
    });
    expect(start.plan.kind).toBe('fresh');
    expect(start.report.join('\n')).toContain('disposition=done');
  });

  test('a `blocked` bead is not a starting point either', () => {
    const start = planStartBoot({
      kind: 'ok',
      rows: [
        row({
          id: 'hoff-blocked',
          notes: handoffJson(handoff({disposition: 'blocked'})),
        }),
      ],
    });
    expect(start.plan.kind).toBe('fresh');
    expect(start.report.join('\n')).toContain('disposition=blocked');
  });

  test('the eligible one wins even when unreadable siblings are newer', () => {
    // The dangerous shape: an unreadable bead sorts newest. It must neither be
    // picked up nor block the readable one — and it must still be reported.
    const start = planStartBoot({
      kind: 'ok',
      rows: [
        row({
          id: 'hoff-broken',
          notes: '{{{',
          updatedAt: '2026-09-09T00:00:00Z',
        }),
        row({id: 'hoff-good', updatedAt: '2026-09-01T00:00:00Z'}),
      ],
    });
    expect(start.plan.kind === 'handoff' ? start.plan.match.row.id : null).toBe(
      'hoff-good',
    );
    expect(start.report.join('\n')).toContain('hoff-broken');
  });
});

describe('planStartBoot — an explicit --prompt is an ASK (D1)', () => {
  const waiting = {
    kind: 'ok' as const,
    rows: [
      row({id: 'hoff-old', updatedAt: '2026-08-01T00:00:00Z'}),
      row({id: 'hoff-new', updatedAt: '2026-09-01T00:00:00Z'}),
    ],
  };

  test('explicit ask, no --pickup: starts fresh even with beads waiting', () => {
    const start = planStartBoot(waiting, {pickup: false, promptExplicit: true});
    expect(start.plan.kind).toBe('fresh');
    expect(start.report).toContain(EXPLICIT_SKIP_LINE);
  });

  test('explicit ask, no --pickup: names EVERY waiting bead by id and title', () => {
    const start = planStartBoot(waiting, {pickup: false, promptExplicit: true});
    const report = start.report.join('\n');
    expect(report).toContain('hoff-old');
    expect(report).toContain('hoff-new');
    expect(report).toContain('HANDOFF continue: an arc');
  });

  test('explicit ask WITH --pickup: newest wins, exactly as before', () => {
    const start = planStartBoot(waiting, {pickup: true, promptExplicit: true});
    expect(start.plan.kind === 'handoff' ? start.plan.match.row.id : null).toBe(
      'hoff-new',
    );
    expect(start.report).not.toContain(EXPLICIT_SKIP_LINE);
  });

  test('the default prompt picks up as before, with and without --pickup', () => {
    for (const pickup of [true, false]) {
      const start = planStartBoot(waiting, {pickup, promptExplicit: false});
      expect(start.plan.kind).toBe('handoff');
      expect(start.report).not.toContain(EXPLICIT_SKIP_LINE);
    }
  });

  test('omitting the policy entirely keeps the old behaviour', () => {
    expect(planStartBoot(waiting).plan.kind).toBe('handoff');
  });

  test('an empty workspace still says it CHECKED, in all four combinations', () => {
    for (const promptExplicit of [true, false]) {
      for (const pickup of [true, false]) {
        const start = planStartBoot(
          {kind: 'ok', rows: []},
          {pickup, promptExplicit},
        );
        expect(start.report.join('\n')).toContain('no open handoff beads');
      }
    }
  });

  test('an UNAVAILABLE scan is reported as unavailable in all four combinations', () => {
    for (const promptExplicit of [true, false]) {
      for (const pickup of [true, false]) {
        const start = planStartBoot(
          {kind: 'unavailable', reason: 'br exited 1'},
          {pickup, promptExplicit},
        );
        expect(start.report.join('\n')).toContain('UNAVAILABLE');
      }
    }
  });
});

describe('bootPreamble', () => {
  const label = 'the-arc-2';
  const cwd = '/Users/jhaa/Dev/home-base';

  test('a fresh boot says nothing extra', () => {
    expect(bootPreamble({cwd, label, plan: {kind: 'fresh'}})).toBeNull();
  });

  test('a handoff boot names the bead, the claim, and the worktree', () => {
    const match = {handoff: handoff(), row: row({id: 'hoff-42'})};
    const preamble =
      bootPreamble({cwd, label, plan: {kind: 'handoff', match}}) ?? '';
    expect(preamble).toContain('hoff-42');
    expect(preamble).toContain('br show hoff-42');
    expect(preamble).toContain(
      `br close hoff-42 --reason='picked up by ${label}'`,
    );
    expect(preamble).toContain('/Users/jhaa/Dev/home-base');
    expect(preamble).toContain('worktree-justin-loop-runner');
    // The already-claimed branch tells it to hand off `done`, not to redo work.
    expect(preamble).toContain('ALREADY CLOSED');
    expect(preamble).toContain('--disposition=done');
  });

  test('the claim names the RUNNER’s directory to run `br close` from', () => {
    // home-base-1r6d.33.9. `br` resolves its workspace from the process cwd, so
    // a successor that claims from the worktree the handoff points at closes the
    // bead in a database the runner never scans — and the runner then sees the
    // handoff still open. The preamble has to name the runner's own directory,
    // and it must be the INTERPOLATED one, not a constant that happens to match
    // home-base.
    const match = {
      handoff: handoff({
        worktree: '/Users/jhaa/Dev/home-base/.claude/worktrees/the-arc',
      }),
      row: row({id: 'hoff-42'}),
    };
    const preamble =
      bootPreamble({
        cwd: '/Users/jhaa/Dev/nature-sounds',
        label,
        plan: {kind: 'handoff', match},
      }) ?? '';
    expect(preamble).toContain('`/Users/jhaa/Dev/nature-sounds`');
    // Attached to the claim, not merely mentioned somewhere in the preamble.
    // Whitespace-collapsed so the assertion survives a re-wrap of the prose.
    expect(preamble.replace(/\s+/g, ' ')).toContain(
      "br close hoff-42 --reason='picked up by the-arc-2'`, run FROM `/Users/jhaa/Dev/nature-sounds`",
    );
    // And the worktree is still named, as the place the WORK happens.
    expect(preamble).toContain(
      '/Users/jhaa/Dev/home-base/.claude/worktrees/the-arc',
    );
  });

  test('a reconstruct boot says NO handoff exists and never calls itself one', () => {
    const plan = crashBootPlan(2, 'stopped after 45m (--timeout-min)');
    const preamble = bootPreamble({cwd, label, plan}) ?? '';
    expect(preamble).toContain('NO HANDOFF EXISTS');
    expect(preamble).toContain('session 2 ended without handing anything over');
    expect(preamble).toContain('--timeout-min');
    expect(preamble).not.toContain('PICK UP THE HANDOFF');
    // A crash must never license destructive tidying.
    expect(preamble).toContain('do not use destructive git');
  });
});

describe('sessionPrompt and composeBootPrompt', () => {
  const label = 'the-arc-2';
  const cwd = '/Users/jhaa/Dev/home-base';

  test('a fresh boot runs the base prompt, untouched', () => {
    const boot: BootContext = {cwd, label, plan: {kind: 'fresh'}};
    expect(sessionPrompt('/loop-session', boot)).toBe('/loop-session');
    expect(composeBootPrompt('/loop-session', boot)).toBe('/loop-session');
  });

  test('a handoff boot is prompted with the bead `next`, VERBATIM (D6)', () => {
    // The whole design: the outgoing session wrote its successor's prompt. The
    // runner does not paraphrase it, and does not put the original ask in front
    // of it — session 2 of an arc is not asked the question session 1 was.
    const next = 'Rewrite parseFoo, then run bun test and report the count.';
    const match = {handoff: handoff({next}), row: row()};
    const boot: BootContext = {cwd, label, plan: {kind: 'handoff', match}};
    expect(sessionPrompt('/loop-session', boot)).toBe(next);
    const composed = composeBootPrompt('/loop-session', boot);
    expect(composed.startsWith(next)).toBe(true);
    expect(composed).not.toContain('/loop-session');
    expect(composed).toContain('PICK UP THE HANDOFF FIRST');
  });

  test('a reconstruct boot keeps the base prompt FIRST, preamble after', () => {
    // The base prompt may be a slash command, which is only recognised when it
    // leads the prompt.
    const boot: BootContext = {
      cwd,
      label,
      plan: crashBootPlan(1, 'no handoff bead'),
    };
    const composed = composeBootPrompt('/loop-session', boot);
    expect(composed.startsWith('/loop-session')).toBe(true);
    expect(composed).toContain('NO HANDOFF EXISTS');
  });

  test('the same preamble also rides the appended system prompt', () => {
    // Delivered twice on purpose: a skill that ignores its arguments would drop
    // the prompt copy silently.
    const match = {handoff: handoff(), row: row({id: 'hoff-42'})};
    const boot: BootContext = {cwd, label, plan: {kind: 'handoff', match}};
    expect(bootContract('CONTRACT', boot)).toContain('hoff-42');
    expect(bootContract('CONTRACT', boot).startsWith('CONTRACT')).toBe(true);
  });
});

/**
 * The full pickup protocol against the REAL `br` binary — the half a fake cannot
 * vouch for: that the flags are right and the JSON shape is what we parse.
 *
 * Resolved at module load so a machine without br reports these as SKIPPED
 * rather than green (an `if (!br) return` inside the body is the silence-shaped
 * lie critical rule 6 forbids). The mise SHIM is deliberately not used: it
 * resolves against the cwd's mise.toml, which a temp sandbox does not have.
 */
const brBinDir = ((): string | null => {
  try {
    const path = execFileSync('mise', ['which', 'br'], {
      cwd: dirname(import.meta.dirname),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path !== '' ? dirname(path) : null;
  } catch {
    return null;
  }
})();

describe('scripted simulation: a handoff bead round-trips through real br', () => {
  function realBr(cwd: string, args: string[]): BrOutcome {
    const original = process.env.PATH;
    process.env.PATH = `${brBinDir}:${original ?? ''}`;
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
    const init = realBr(repo, ['init', '--prefix', 'hoff']);
    expect(init.ok).toBe(true);
    return repo;
  }

  test.skipIf(brBinDir == null)(
    'a handoff bead is found, its notes survive, and it becomes the prompt',
    () => {
      const repo = beadsRepo();
      const payload = handoff({
        next: 'Line one.\n\nLine two, with "quotes" and a trailing tab\t',
      });

      const created = realBr(repo, [
        'create',
        'HANDOFF continue: the arc',
        '-t',
        'task',
        '-p',
        '1',
        '--labels',
        HANDOFF_LABEL,
        '--description=readable copy',
      ]);
      expect(created.ok).toBe(true);
      const id = /Created (\S+):/.exec(created.stdout)?.[1] ?? '';
      expect(id).not.toBe('');
      expect(
        realBr(repo, ['update', id, `--notes=${handoffJson(payload)}`]).ok,
      ).toBe(true);

      // A fresh runner scans, and gets rows carrying real notes.
      const scan = scanHandoffBeads(repo, realBr);
      expect(scan.kind).toBe('ok');
      expect(scan.kind === 'ok' ? scan.rows.map((r) => r.id) : []).toEqual([
        id,
      ]);

      // …which planStartBoot turns into a pickup whose prompt is the bead's
      // `next`, byte for byte through br's storage.
      const start = planStartBoot(scan);
      expect(start.plan.kind).toBe('handoff');
      if (start.plan.kind !== 'handoff') return;
      expect(start.plan.match.handoff.next).toBe(payload.next);
      expect(
        sessionPrompt('/loop-session', {
          cwd: repo,
          label: 'x-1',
          plan: start.plan,
        }),
      ).toBe(payload.next);

      // Claiming it (what the successor is told to do) takes it out of the scan.
      expect(
        realBr(repo, ['close', id, '--reason=picked up by the-arc-2']).ok,
      ).toBe(true);
      const rescan = scanHandoffBeads(repo, realBr);
      expect(rescan.kind === 'ok' ? rescan.rows : null).toEqual([]);
    },
  );

  test.skipIf(brBinDir == null)(
    'a bead created without notes is UNREADABLE, never an empty handoff',
    () => {
      // The two-step-create gap, reproduced against the real binary: br omits
      // the `notes` key entirely, and the runner must refuse to boot from it.
      const repo = beadsRepo();
      const created = realBr(repo, [
        'create',
        'HANDOFF ???',
        '-t',
        'task',
        '-p',
        '1',
        '--labels',
        HANDOFF_LABEL,
      ]);
      expect(created.ok).toBe(true);
      const start = planStartBoot(scanHandoffBeads(repo, realBr));
      expect(start.plan.kind).toBe('fresh');
      expect(start.report.join('\n')).toContain('UNREADABLE');
    },
  );

  test.skipIf(brBinDir == null)(
    'a repo with no beads workspace degrades to UNAVAILABLE, not to empty',
    () => {
      const repo = initRepo(track(createSandbox()), 'no-beads', {
        'README.md': '# no beads here\n',
      });
      expect(scanHandoffBeads(repo, realBr).kind).toBe('unavailable');
    },
  );
});

/**
 * The yargs seam (D6), end to end against a fake `br` and a fake `claude`.
 *
 * The unit tests above prove planStartBoot branches correctly on
 * `promptExplicit`. They cannot prove the CLI ever sets it, and that is the half
 * most likely to break silently: with a yargs `default` on `--prompt`, an
 * explicit `--prompt /loop-session` and no flag at all produce byte-identical
 * argv, so the runner would treat every run as the standing job and the fix
 * would compile, typecheck, pass every unit test, and do nothing.
 *
 * `--dry-run --no-usage-gate` throughout: the start scan runs and reports, and
 * no session is ever spawned.
 */
describe('CLI: --prompt makes the run an ASK (D1/D6)', () => {
  const CLI = join(dirname(import.meta.dirname), 'src', 'cli.ts');

  interface Run {
    out: string;
    status: number | null;
  }

  function runLoopCli(args: string[], command = 'justin-loop'): Run {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'project', {'README.md': '# ask fixture\n'});
    const binDir = join(sb.path, 'fakebin');
    mkdirSync(binDir, {recursive: true});

    writeFileSync(
      join(binDir, 'claude'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.1.999-fake"; exit 0; fi',
        // Nothing else should ever be asked of it in a gate-less dry run; if it
        // is, exit non-zero so the run cannot pass by accident.
        'exit 3',
      ].join('\n'),
    );
    chmodSync(join(binDir, 'claude'), 0o755);

    // Two open handoff beads from unrelated arcs, both VALID and both
    // `continue` — exactly the situation that hijacks an ask.
    const beads = listJson([
      {
        id: 'hoff-old',
        notes: handoffJson(handoff({arc: 'unrelated arc', from: 'other-1'})),
        title: 'HANDOFF continue: unrelated arc',
        updated_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'hoff-new',
        notes: handoffJson(handoff({arc: 'newest arc', from: 'other-2'})),
        title: 'HANDOFF continue: newest arc',
        updated_at: '2026-09-01T00:00:00Z',
      },
    ]);
    writeFileSync(
      join(binDir, 'br'),
      [
        '#!/bin/sh',
        'case "$*" in',
        `  *"-l handoff"*) printf '%s' ${JSON.stringify(beads)} ;;`,
        `  *) printf '%s' '{"issues":[]}' ;;`,
        'esac',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(binDir, 'br'), 0o755);

    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };
    delete env.ANTHROPIC_API_KEY;
    const proc = Bun.spawnSync({
      cmd: ['bun', CLI, command, '--dry-run', '--no-usage-gate', ...args],
      cwd: repo,
      env: env as Record<string, string>,
    });
    return {
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      status: proc.exitCode,
    };
  }

  test('no --prompt: promptExplicit is false, so the newest handoff is picked up', () => {
    // The negative control for every case below: the fakes ARE reachable and the
    // scan DOES find both beads.
    const run = runLoopCli([]);
    expect(run.out).toContain('picking up handoff hoff-new');
    expect(run.out).not.toContain(EXPLICIT_SKIP_LINE);
    expect(run.status).toBe(0);
  });

  test('--prompt with an ask: nothing is picked up, everything is named', () => {
    const run = runLoopCli(['--prompt', '/conductor fix the parser']);
    expect(run.out).not.toContain('picking up handoff');
    expect(run.out).toContain(EXPLICIT_SKIP_LINE);
    expect(run.out).toContain('hoff-new');
    expect(run.out).toContain('HANDOFF continue: newest arc');
    expect(run.out).toContain('hoff-old');
    expect(run.out).toContain('HANDOFF continue: unrelated arc');
    expect(run.status).toBe(0);
  });

  test('--prompt /loop-session — the SAME string as the default — still skips', () => {
    // The whole point of dropping the yargs default. If `promptExplicit` were
    // inferred by comparing the value against the default, this case would be
    // indistinguishable from the no-flag case and would wrongly pick up.
    const run = runLoopCli(['--prompt', '/loop-session']);
    expect(run.out).toContain(EXPLICIT_SKIP_LINE);
    expect(run.out).not.toContain('picking up handoff');
  });

  test('--prompt with --pickup: back to picking up the newest', () => {
    const run = runLoopCli([
      '--prompt',
      '/conductor fix the parser',
      '--pickup',
    ]);
    expect(run.out).toContain('picking up handoff hoff-new');
    expect(run.out).not.toContain(EXPLICIT_SKIP_LINE);
  });

  test('the hidden --max-iterations alias still sets the chain length', () => {
    // One release of grace for a scheduled invocation that predates the rename.
    // The run header names the bound, so a dry run is enough to prove the flag
    // reaches the runner rather than being silently swallowed by yargs.
    const run = runLoopCli(['--max-iterations', '7']);
    expect(run.out).toContain('max=7 sessions');
    expect(run.out).toContain('--max-iterations is now --max-sessions');
  });

  test('--max-sessions is the name that works without a deprecation notice', () => {
    const run = runLoopCli(['--max-sessions', '7']);
    expect(run.out).toContain('max=7 sessions');
    expect(run.out).not.toContain('--max-iterations is now');
  });

  test('the header names every label the chain may use', () => {
    const run = runLoopCli(['--label', 'my-arc', '--max-sessions', '3']);
    expect(run.out).toContain('labels=my-arc-1…my-arc-3');
  });

  test('the deprecated `ralph` name reaches the same runner (D1)', () => {
    const run = runLoopCli([], 'ralph');
    expect(run.out).toContain('ralph is now justin-loop');
    expect(run.out).toContain('picking up handoff hoff-new');
    expect(run.status).toBe(0);
  });

  test('--help still documents the default it no longer writes into argv', () => {
    // `defaultDescription` (yargs 18) documents `/loop-session` without setting
    // argv.prompt. Verified here rather than assumed: if a future yargs dropped
    // it, the flag would silently become undocumented.
    const proc = Bun.spawnSync({cmd: ['bun', CLI, 'justin-loop', '--help']});
    const help = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    // The quoting differs between the two mechanisms (`default` renders
    // `"/loop-session"`, `defaultDescription` renders it bare), so the optional
    // quote keeps this test about DOCUMENTATION rather than about yargs'
    // rendering — the behaviour is pinned by the four tests above.
    expect(help).toMatch(/--prompt[\s\S]*default: "?\/loop-session/);
    expect(help).toContain('--pickup');
  });
});
