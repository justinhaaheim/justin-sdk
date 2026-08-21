/**
 * ralph's self-handoff lifecycle (home-base-1r6d.4).
 *
 * A session ends deliberately, says whether it wants a fresh-context successor
 * NOW, and leaves its continuation payload in a `handoff`-labelled bead. There
 * is no session-to-session channel by design (D1) — beads are the whole
 * transport — so everything the runner does here is: look for the bead, check
 * nobody else has claimed it, and tell the successor how to claim it.
 *
 * What these tests are defending, in order of how badly it fails if it breaks:
 *   1. A crash must never boot a successor that thinks it received a handoff.
 *   2. A bead another session already claimed must produce a VISIBLE report,
 *      not a second agent quietly redoing the same arc.
 *   3. `br` being unavailable must never read as "no handoff is waiting".
 *   4. An unstated respawn must never boot a successor.
 *
 * The `br` boundary is injected everywhere, so the branching is provable without
 * a beads workspace — plus one scripted simulation against the REAL `br` binary,
 * because the flags and the JSON shape are the half a fake cannot vouch for.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {
  bootContract,
  type BootContext,
  bootPreamble,
  type BrOutcome,
  composeBootPrompt,
  crashBootPlan,
  decideRespawn,
  formatRespawnLine,
  type HandoffBead,
  type HandoffPickup,
  HANDOFF_LABEL,
  normalizeVerdict,
  parseBeadList,
  planStartBoot,
  resolveHandoffPickup,
  runBr,
  scanHandoffBeads,
  type Verdict,
} from '../src/ralph';
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

/** Verbatim `br list -l handoff --json` output, br 0.1.37, 2026-08-21. */
const REAL_BR_LIST = `{
  "issues": [
    {
      "id": "hoff-q1h",
      "title": "HANDOFF: mayor arc",
      "status": "open",
      "priority": 1,
      "issue_type": "task",
      "created_at": "2026-08-21T02:53:51.439779Z",
      "created_by": "jhaa",
      "updated_at": "2026-08-21T02:53:51.439779Z",
      "source_repo": ".",
      "compaction_level": 0,
      "original_size": 0,
      "labels": [
        "handoff"
      ],
      "dependency_count": 0,
      "dependent_count": 0
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "has_more": false
}`;

const EMPTY_BR_LIST =
  '{"issues": [], "total": 0, "limit": 50, "offset": 0, "has_more": false}';

function beadListJson(
  rows: Array<Partial<HandoffBead> & {updated_at?: string | null}>,
): string {
  return JSON.stringify({
    issues: rows.map((r) => ({
      id: r.id,
      status: r.status,
      title: r.title,
      updated_at: r.updated_at,
    })),
    total: rows.length,
  });
}

/** A `br` that always succeeds with this stdout, recording the argv it saw. */
function fakeBr(stdout: string): {
  run: (cwd: string, args: string[]) => BrOutcome;
  seen: () => string[][];
} {
  const seen: string[][] = [];
  return {
    run: (_cwd, args) => {
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

function bead(over: Partial<HandoffBead> = {}): HandoffBead {
  return {
    id: 'hoff-1',
    status: 'open',
    title: 'HANDOFF: an arc',
    updatedAt: '2026-08-21T02:00:00Z',
    ...over,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    followUps: [],
    handoffBead: null,
    respawn: null,
    status: 'CONTINUE',
    summary: 'did one unit of work',
    ...over,
  };
}

describe('parseBeadList', () => {
  test('parses real `br list --json` output', () => {
    const beads = parseBeadList(REAL_BR_LIST);
    expect(beads).toEqual([
      {
        id: 'hoff-q1h',
        status: 'open',
        title: 'HANDOFF: mayor arc',
        updatedAt: '2026-08-21T02:53:51.439779Z',
      },
    ]);
  });

  test('an empty result set is an empty list, not a failure', () => {
    expect(parseBeadList(EMPTY_BR_LIST)).toEqual([]);
  });

  test('malformed JSON is unreadable (null), never an empty list', () => {
    // The whole point of the null: [] would read as "nothing is waiting".
    expect(parseBeadList('{not json')).toBeNull();
    expect(parseBeadList('')).toBeNull();
  });

  test('output without an issues array is unreadable, not empty', () => {
    expect(parseBeadList('{"total":0}')).toBeNull();
    expect(parseBeadList('[]')).toBeNull();
  });

  test('one unreadable row rejects the WHOLE list rather than dropping it', () => {
    // Skipping the bad row would silently understate how many handoffs are
    // open — the reassuring direction, which is the dangerous one here.
    const json = beadListJson([
      {id: 'hoff-1', status: 'open', title: 'HANDOFF: a', updated_at: null},
      {id: 'hoff-2', title: 'HANDOFF: b', updated_at: null}, // no status
    ]);
    expect(parseBeadList(json)).toBeNull();
  });

  test('a missing timestamp is null, not a fabricated date', () => {
    const json = beadListJson([
      {id: 'hoff-1', status: 'open', title: 'HANDOFF: a'},
    ]);
    expect(parseBeadList(json)?.[0].updatedAt).toBeNull();
  });
});

describe('scanHandoffBeads', () => {
  test('asks br for open beads carrying the handoff label, as JSON', () => {
    const br = fakeBr(REAL_BR_LIST);
    scanHandoffBeads('/repo', br.run);
    expect(br.seen()[0]).toEqual(['list', '-l', HANDOFF_LABEL, '--json']);
    // No `-a`: a closed handoff has been claimed and is not waiting for anyone.
    expect(br.seen()[0]).not.toContain('-a');
  });

  test('a br failure is UNAVAILABLE, never an empty list', () => {
    // The whole graceful-degradation contract: a repo with no beads workspace
    // and a repo with no waiting handoff must not look the same.
    const scan = scanHandoffBeads('/repo', brokenBr('br exited 1: no database'));
    expect(scan.kind).toBe('unavailable');
    expect(scan.kind === 'unavailable' ? scan.reason : '').toContain(
      'no database',
    );
  });

  test('unparseable output is UNAVAILABLE too', () => {
    const scan = scanHandoffBeads('/repo', () => ({
      ok: true,
      reason: null,
      stdout: 'not json at all',
    }));
    expect(scan.kind).toBe('unavailable');
  });

  test('a genuinely empty workspace reports ok with no beads', () => {
    const scan = scanHandoffBeads('/repo', fakeBr(EMPTY_BR_LIST).run);
    expect(scan).toEqual({beads: [], kind: 'ok'});
  });
});

describe('runBr', () => {
  /**
   * `br`'s auto-import runs a real `git merge origin/main` in the working
   * directory (home-base c2u5 — a merge that "appeared out of nowhere" in a
   * worktree). An unattended loop runner doing that mid-iteration would be far
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
      ['#!/bin/sh', `echo "$@" >> ${JSON.stringify(log)}`, ...script].join('\n'),
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
    withFakeBr(
      ['echo "no beads database found" >&2', 'exit 1'],
      () => {
        const out = runBr(process.cwd(), ['list', '--json']);
        expect(out.ok).toBe(false);
        expect(out.stdout).toBe('');
        expect(out.reason).toContain('no beads database found');
      },
    );
  });
});

describe('resolveHandoffPickup', () => {
  test('looks the bead up INCLUDING closed ones', () => {
    // Without -a a claimed bead reads as "missing", and the double-pickup
    // report — the only signal that two sessions are on one arc — never fires.
    const br = fakeBr(REAL_BR_LIST);
    resolveHandoffPickup('/repo', 'hoff-q1h', br.run);
    expect(br.seen()[0]).toEqual(['list', '--id', 'hoff-q1h', '-a', '--json']);
  });

  test('an open bead is ready to hand to the successor', () => {
    const pickup = resolveHandoffPickup(
      '/repo',
      'hoff-q1h',
      fakeBr(REAL_BR_LIST).run,
    );
    expect(pickup.kind).toBe('ready');
  });

  test('a closed bead is ALREADY CLAIMED — someone else got there first', () => {
    const json = beadListJson([
      {
        id: 'hoff-q1h',
        status: 'closed',
        title: 'HANDOFF: mayor arc',
        updated_at: '2026-08-21T03:00:00Z',
      },
    ]);
    const pickup = resolveHandoffPickup('/repo', 'hoff-q1h', fakeBr(json).run);
    expect(pickup.kind).toBe('already-claimed');
  });

  test('a bead that does not exist is MISSING, not claimed and not ready', () => {
    const pickup = resolveHandoffPickup(
      '/repo',
      'hoff-nope',
      fakeBr(EMPTY_BR_LIST).run,
    );
    expect(pickup).toEqual({id: 'hoff-nope', kind: 'missing'});
  });

  test('br failing leaves the answer UNKNOWN, never "ready"', () => {
    const pickup = resolveHandoffPickup(
      '/repo',
      'hoff-q1h',
      brokenBr('br exited 1: mise ERROR No version is set for shim: br'),
    );
    expect(pickup.kind).toBe('unavailable');
  });
});

describe('planStartBoot — the scheduled-tick pickup', () => {
  test('an unavailable scan starts fresh and SAYS it could not look', () => {
    const start = planStartBoot({kind: 'unavailable', reason: 'br exited 1'});
    expect(start.plan).toEqual({kind: 'fresh'});
    expect(start.report.join('\n')).toContain('UNAVAILABLE');
    // Silence must be a claim: the report has to admit a handoff may exist.
    expect(start.report.join('\n')).toContain('may exist and not be seen');
  });

  test('an empty workspace says it CHECKED and found none', () => {
    const start = planStartBoot({beads: [], kind: 'ok'});
    expect(start.plan).toEqual({kind: 'fresh'});
    expect(start.report.join('\n')).toContain('checked');
  });

  test('one waiting handoff becomes the boot pickup', () => {
    const only = bead({id: 'hoff-7'});
    const start = planStartBoot({beads: [only], kind: 'ok'});
    expect(start.plan).toEqual({bead: only, kind: 'handoff'});
    expect(start.report.join('\n')).toContain('hoff-7');
  });

  test('several arcs: picks the newest and NAMES the ones it is not taking', () => {
    // Never fan out — two agents in one repo cannot tell whose worktree is
    // whose. The others stay open for the next tick, and are reported.
    const start = planStartBoot({
      beads: [
        bead({id: 'hoff-old', updatedAt: '2026-08-01T00:00:00Z'}),
        bead({id: 'hoff-new', updatedAt: '2026-08-20T00:00:00Z'}),
        bead({id: 'hoff-mid', updatedAt: '2026-08-10T00:00:00Z'}),
      ],
      kind: 'ok',
    });
    expect(start.plan.kind === 'handoff' ? start.plan.bead.id : null).toBe(
      'hoff-new',
    );
    const report = start.report.join('\n');
    expect(report).toContain('NOT picked up');
    expect(report).toContain('hoff-old');
    expect(report).toContain('hoff-mid');
  });

  test('a bead with no timestamp never wins the "newest" contest', () => {
    const start = planStartBoot({
      beads: [
        bead({id: 'hoff-undated', updatedAt: null}),
        bead({id: 'hoff-dated', updatedAt: '2026-01-01T00:00:00Z'}),
      ],
      kind: 'ok',
    });
    expect(start.plan.kind === 'handoff' ? start.plan.bead.id : null).toBe(
      'hoff-dated',
    );
  });
});

describe('bootPreamble', () => {
  const label = 'ralph-3';

  test('a fresh boot says nothing extra', () => {
    expect(bootPreamble({label, plan: {kind: 'fresh'}})).toBeNull();
  });

  test('a handoff boot names the bead, the claim, and the worktree rule', () => {
    const text = bootPreamble({
      label,
      plan: {bead: bead({id: 'hoff-42'}), kind: 'handoff'},
    });
    expect(text).toContain('hoff-42');
    expect(text).toContain('br show hoff-42');
    // Claiming IS closing, and the reason names the session — that is what
    // makes a second pickup visible instead of silent.
    expect(text).toContain("br close hoff-42 --reason='picked up by ralph-3'");
    expect(text).toContain('WORKTREE PATH');
    expect(text).toContain('ALREADY CLOSED');
  });

  test('a crash boot says NO handoff exists and reconstruction is required', () => {
    const text = bootPreamble({
      label,
      plan: crashBootPlan(2, 'no-verdict'),
    });
    expect(text).toContain('NO HANDOFF EXISTS');
    expect(text).toContain('RECONSTRUCT');
    expect(text).toContain('no-verdict');
    expect(text).toContain('git');
    expect(text).toContain('beads');
    // It must not merely reconstruct quietly — the summary has to admit it.
    expect(text).toContain('SAY in your summary');
  });

  test('a crash boot never describes itself as a handoff', () => {
    const text = bootPreamble({label, plan: crashBootPlan(2, 'timeout')}) ?? '';
    expect(text).not.toContain('PICK UP THE HANDOFF');
  });
});

describe('composeBootPrompt', () => {
  const boot: BootContext = {
    label: 'ralph-2',
    plan: {bead: bead({id: 'hoff-9'}), kind: 'handoff'},
  };

  test('leaves the base prompt untouched when there is nothing to say', () => {
    expect(
      composeBootPrompt('/loop-session', {label: 'ralph-1', plan: {kind: 'fresh'}}),
    ).toBe('/loop-session');
  });

  test('keeps the slash command FIRST and appends the preamble', () => {
    // A slash command is recognised by leading the prompt; a paragraph in front
    // of it would most likely turn `/loop-session` into literal text.
    const composed = composeBootPrompt('/loop-session', boot);
    expect(composed.startsWith('/loop-session')).toBe(true);
    expect(composed).toContain('hoff-9');
  });

  test('the same preamble also rides the appended system prompt', () => {
    // Belt and braces: a skill that ignores its arguments would drop the prompt
    // copy silently, and the system prompt is the channel that always arrives.
    expect(bootContract('CONTRACT', boot)).toContain('hoff-9');
    expect(bootContract('CONTRACT', boot).startsWith('CONTRACT')).toBe(true);
  });
});

/**
 * The runner's branching, which is the part that decides whether a successor
 * exists at all. Pure and injectable so this is provable without spawning a
 * `claude` — the alternative would be running a real loop, which is expensive
 * and unrepeatable.
 */
describe('decideRespawn', () => {
  const never = (): HandoffPickup => {
    throw new Error('resolvePickup must not be called here');
  };
  const ready = (): HandoffPickup => ({bead: bead(), kind: 'ready'});

  test('COMPLETE ends the run and leaves any handoff bead open for next time', () => {
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-5', status: 'COMPLETE'}),
      never,
    );
    expect(d.plan).toBeNull();
    expect(d.stopReason).toContain('COMPLETE');
    expect(d.stopReason).toContain('hoff-5');
    expect(d.stopReason).toContain('left open');
  });

  test('BLOCKED and FAILED still stop, with their summaries intact', () => {
    expect(
      decideRespawn(
        verdict({status: 'BLOCKED', summary: 'needs an API key'}),
        never,
      ).stopReason,
    ).toBe('BLOCKED — needs an API key');
    expect(
      decideRespawn(
        verdict({status: 'FAILED', summary: 'tests red'}),
        never,
      ).stopReason,
    ).toBe('FAILED — tests red');
  });

  test('CONTINUE + respawn=immediate + an open bead boots the successor on it', () => {
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-1', respawn: 'immediate'}),
      ready,
    );
    expect(d.stopReason).toBeNull();
    expect(d.plan?.kind).toBe('handoff');
    expect(d.plan?.kind === 'handoff' ? d.plan.bead.id : null).toBe('hoff-1');
  });

  test('CONTINUE + respawn=on-schedule ends the run cleanly', () => {
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-1', respawn: 'on-schedule'}),
      never,
    );
    expect(d.plan).toBeNull();
    expect(d.stopReason).toContain('on-schedule');
    expect(d.stopReason).toContain('next scheduled run');
    expect(d.stopReason).toContain('hoff-1');
  });

  test('an UNSTATED respawn never boots a successor — and never looks up a bead', () => {
    // Silence is conservative where it matters: no pickup, no claim, no
    // successor. `never` is the assertion — a bead lookup here would mean
    // silence was being treated as intent.
    const d = decideRespawn(verdict({respawn: null}), never);
    expect(d.plan).toEqual({kind: 'fresh'});
    expect(d.stopReason).toBeNull();
  });

  test('a handoff bead WITHOUT an immediate request is left alone entirely', () => {
    // A session can write a handoff bead and still not ask to be respawned —
    // that bead belongs to the next scheduled tick. `never` is the assertion:
    // the runner must not even look it up, let alone hand it to a successor.
    const d = decideRespawn(verdict({handoffBead: 'hoff-1'}), never);
    expect(d.plan).toEqual({kind: 'fresh'});
  });

  test('an unstated respawn does NOT stop a loop the human already licensed', () => {
    // The nsd5 shape in reverse: reading silence as "stop" would turn every
    // CONTINUE from a prompt that omits the field into a one-iteration run.
    // Recorded as an interpretation on home-base-1r6d.4 for the conductor.
    expect(decideRespawn(verdict(), never).stopReason).toBeNull();
  });

  test('respawn=immediate with no bead hands nothing over, and says so', () => {
    const d = decideRespawn(verdict({respawn: 'immediate'}), never);
    expect(d.plan?.kind).toBe('reconstruct');
    expect(d.notes.join('\n')).toContain('no handoffBead');
    expect(d.stopReason).toBeNull();
  });

  test('DOUBLE PICKUP: an already-claimed bead stops the run with a visible report', () => {
    // Two sessions, one arc. The second must report rather than duplicate.
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-1', respawn: 'immediate'}),
      () => ({bead: bead({status: 'closed'}), kind: 'already-claimed'}),
    );
    expect(d.plan).toBeNull();
    expect(d.notes.join('\n')).toContain('DOUBLE PICKUP');
    expect(d.stopReason).toContain('already claimed by another session');
    expect(d.stopReason).toContain('rather than duplicating');
  });

  test('a bead that does not exist is reported, and the successor reconstructs', () => {
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-ghost', respawn: 'immediate'}),
      () => ({id: 'hoff-ghost', kind: 'missing'}),
    );
    expect(d.plan?.kind).toBe('reconstruct');
    expect(d.notes.join('\n')).toContain('hoff-ghost');
    expect(d.notes.join('\n')).toContain('does not exist');
  });

  test('br unavailable: respawn control stays with the verdict, honestly', () => {
    // Graceful degradation. The loop continues because the VERDICT asked for
    // it, but the successor is told the payload could not be verified — it is
    // never handed an unverified bead as though it were a clean handoff.
    const d = decideRespawn(
      verdict({handoffBead: 'hoff-1', respawn: 'immediate'}),
      () => ({id: 'hoff-1', kind: 'unavailable', reason: 'br exited 1'}),
    );
    expect(d.stopReason).toBeNull();
    expect(d.plan?.kind).toBe('reconstruct');
    expect(d.notes.join('\n')).toContain('could not verify');
  });
});

describe('formatRespawnLine', () => {
  test('reports a stated intent verbatim, with the bead it named', () => {
    expect(
      formatRespawnLine(
        verdict({handoffBead: 'hoff-1', respawn: 'immediate'}),
      ),
    ).toBe('respawn=immediate · handoff hoff-1');
  });

  test('spells out an unstated intent rather than leaving it blank', () => {
    // "the session chose on-schedule" and "the session said nothing" are two
    // different facts, and the dashboard has to show which one happened.
    expect(formatRespawnLine(verdict())).toContain('not stated');
  });

  test('says nothing on a terminal verdict that named no bead', () => {
    expect(formatRespawnLine(verdict({status: 'COMPLETE'}))).toBeNull();
  });
});

/**
 * The full claim protocol against the REAL `br` binary — the half a fake cannot
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

describe('scripted simulation: two sessions, one handoff bead (real br)', () => {
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
    'a handoff bead is found, picked up, and claimed exactly once',
    () => {
      const repo = beadsRepo();

      // The outgoing session writes its handoff bead — the exact command the
      // injected contract tells it to run.
      const created = realBr(repo, [
        'create',
        'HANDOFF: the mayor arc',
        '-t',
        'task',
        '-p',
        '1',
        '--labels',
        HANDOFF_LABEL,
        '--description=worktree /tmp/wt · branch arc-1 · next: finish the parser',
      ]);
      expect(created.ok).toBe(true);
      const id = /Created (\S+):/.exec(created.stdout)?.[1] ?? '';
      expect(id).not.toBe('');

      // A fresh runner scans and picks it up.
      const scan = scanHandoffBeads(repo, realBr);
      expect(scan.kind).toBe('ok');
      expect(scan.kind === 'ok' ? scan.beads.map((b) => b.id) : []).toEqual([
        id,
      ]);
      const start = planStartBoot(scan);
      expect(start.plan.kind).toBe('handoff');

      // A verdict naming it resolves as ready — one session, no conflict.
      const first = decideRespawn(
        verdict({handoffBead: id, respawn: 'immediate'}),
        (beadId) => resolveHandoffPickup(repo, beadId, realBr),
      );
      expect(first.plan?.kind).toBe('handoff');
      expect(first.stopReason).toBeNull();

      // Now the successor claims it, exactly as the boot preamble instructs.
      const claim = realBr(repo, [
        'close',
        id,
        "--reason=picked up by ralph-2",
      ]);
      expect(claim.ok).toBe(true);

      // A SECOND session arriving at the same bead must be told, loudly.
      const second = decideRespawn(
        verdict({handoffBead: id, respawn: 'immediate'}),
        (beadId) => resolveHandoffPickup(repo, beadId, realBr),
      );
      expect(second.notes.join('\n')).toContain('DOUBLE PICKUP');
      expect(second.plan).toBeNull();
      expect(second.stopReason).toContain('already claimed');

      // And a claimed bead stops being "waiting" for the next scheduled tick.
      const rescan = scanHandoffBeads(repo, realBr);
      expect(rescan.kind === 'ok' ? rescan.beads : null).toEqual([]);
    },
  );

  test.skipIf(brBinDir == null)(
    'a repo with no beads workspace degrades to UNAVAILABLE, not to empty',
    () => {
      const repo = initRepo(track(createSandbox()), 'no-beads', {
        'README.md': '# no beads here\n',
      });
      const scan = scanHandoffBeads(repo, realBr);
      expect(scan.kind).toBe('unavailable');
    },
  );
});

describe('crash boots', () => {
  test('a missing verdict file produces a reconstruct boot, not a fresh one', () => {
    // The chain AC5 asks for: no verdict → crash → the successor is told.
    const plan = crashBootPlan(4, 'no-verdict');
    expect(plan.kind).toBe('reconstruct');
    expect(
      bootPreamble({label: 'ralph-5', plan}),
    ).toContain('NO HANDOFF EXISTS');
  });

  test('an unreadable verdict is a crash, not a silent CONTINUE', () => {
    // normalizeVerdict is the gate: null here is what makes the runner take the
    // crash branch instead of treating a garbled file as more work.
    expect(normalizeVerdict({status: 'DONE'})).toBeNull();
    // A raw string is not a verdict object either — and must not be coerced
    // into one just because it happens to contain the right word.
    expect(normalizeVerdict('{"status":"CONTINUE"}')).toBeNull();
    expect(normalizeVerdict(null)).toBeNull();
    expect(normalizeVerdict({status: 'CONTINUE'})?.status).toBe('CONTINUE');
  });
});
