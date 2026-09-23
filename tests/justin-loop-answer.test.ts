/**
 * `justin-loop handoff answer` — how a BLOCKED chain resumes
 * (home-base-1r6d.33.7, epic decision D16).
 *
 * A blocked handoff bead stops the loop and stays open on purpose (D14): it IS
 * the question waiting for Justin. Nothing restarted the arc from it, because
 * `planStartBoot` only boots from a `continue` bead (D10). This helper is the
 * defined way across that gap.
 *
 * WHAT THESE TESTS EXIST TO PREVENT, in order of how badly it fails:
 *   1. A rewrite of a bead the helper did not fully understand. This is an
 *      in-place edit of the only control channel the loop has, so every one of
 *      the refusals below must fire BY NAME and leave the bead untouched — a
 *      "best effort" rewrite of an unparseable or already-continue bead would
 *      corrupt the chain silently.
 *   2. A rewrite that loses the answers or the original instructions. `next` IS
 *      the successor's prompt: the original text must survive byte for byte and
 *      the answers must be appended to it, never replace it.
 *   3. An answered bead the runner still will not pick up — which would leave
 *      Justin with a helper that reports success and a chain that stays dead.
 *      The last test drives the helper's own output through the real runner.
 *   4. A `br` failure reported as success. Exit 2 stays its own answer.
 */

import {describe, expect, test} from 'bun:test';

import {type BrOutcome, type BrRunner} from '../src/justin-loop/br';
import {
  answerCommand,
  answerHandoff,
  answersBlock,
  type Handoff,
  HANDOFF_LABEL,
  handoffJson,
  parseHandoff,
  renderAnswer,
  rerunCommand,
  resolveAnswers,
  slugFromLabel,
} from '../src/justin-loop/handoff';
import {SDK_RUN} from '../src/sdk-invocation';
import {promptOf, runLoop} from './justin-loop-world';

const WHEN = new Date('2026-09-19T17:00:00.000Z');
const now = (): Date => WHEN;

/** Several paragraphs with quotes in them — the real shape of `next`. */
const BLOCKED_NEXT = [
  '/conductor Finish the pilot-2 arc in the worktree named above.',
  '',
  'The runner is wired and the contract is written. What is left is the "answer"',
  'path, which nobody has run end to end yet.',
].join('\n');

const BLOCKED: Handoff = {
  arc: 'home-base-1r6d.33',
  branch: 'worktree-justin-loop-pilot2',
  contextTokens: 412_000,
  createdAt: '2026-09-18T04:00:00.000Z',
  disposition: 'blocked',
  from: 'pilot2-2',
  next: BLOCKED_NEXT,
  openQuestions: [
    'Should the runner delete remote branches automatically?',
    'Is 0.24.0 a breaking release?',
  ],
  schemaVersion: 1,
  state: 'The runner is wired; the resume path is unbuilt.',
  worktree: '/Users/jhaa/Dev/home-base/.claude/worktrees/justin-loop-pilot2',
};

/** Everything the answer must NOT touch. */
function stable(h: Handoff): Record<string, unknown> {
  return {
    arc: h.arc,
    branch: h.branch,
    contextTokens: h.contextTokens,
    createdAt: h.createdAt,
    from: h.from,
    schemaVersion: h.schemaVersion,
    state: h.state,
    worktree: h.worktree,
  };
}

interface FakeBead {
  description?: string;
  id: string;
  labels?: string[];
  notes?: string | null;
  status?: string;
  title?: string;
}

interface FakeBr {
  /** Every argv, in order — so "the bead was NOT changed" is checkable. */
  calls: string[][];
  run: BrRunner;
  /** The bead as it stands after whatever the helper did to it. */
  state: () => FakeBead | null;
}

/**
 * A `br` holding ONE bead, which `update` really rewrites.
 *
 * The bead is mutated rather than recorded so a refusal can be proved by
 * reading the bead back, not just by counting calls.
 */
function fakeBr(
  bead: FakeBead | null,
  opts: {
    listFails?: boolean;
    listGarbage?: boolean;
    updateFails?: boolean;
  } = {},
): FakeBr {
  const calls: string[][] = [];
  const state: FakeBead | null = bead == null ? null : {...bead};
  const run: BrRunner = (_cwd, args): BrOutcome => {
    calls.push(args);
    if (args[0] === 'list') {
      if (opts.listFails === true) {
        return {
          ok: false,
          reason: 'br exited 1: no beads workspace',
          stderr: null,
          stdout: '',
        };
      }
      if (opts.listGarbage === true) {
        return {
          ok: true,
          reason: null,
          stderr: null,
          stdout: 'not json at all',
        };
      }
      const issues =
        state == null
          ? []
          : [
              {
                description: state.description ?? '',
                id: state.id,
                labels: state.labels ?? [HANDOFF_LABEL],
                ...(state.notes === undefined ? {} : {notes: state.notes}),
                status: state.status ?? 'open',
                title: state.title ?? 'HANDOFF blocked: home-base-1r6d.33',
                updated_at: '2026-09-18T04:00:00Z',
              },
            ];
      return {
        ok: true,
        reason: null,
        stderr: null,
        stdout: JSON.stringify({issues, total: issues.length}),
      };
    }
    if (args[0] === 'update') {
      if (opts.updateFails === true) {
        // Three stderr lines (F4): `reason` is the first, and the other two are
        // the ones that say what to do — exactly what the old one-line shape
        // threw away.
        return {
          ok: false,
          reason: 'br exited 1: database is locked',
          stderr: [
            'database is locked',
            'another process is holding .beads/beads.db',
            'retry once it releases, or close the other br',
          ].join('\n'),
          stdout: '',
        };
      }
      if (state != null) {
        for (const arg of args.slice(2)) {
          if (arg.startsWith('--notes=')) state.notes = arg.slice(8);
          if (arg.startsWith('--title=')) state.title = arg.slice(8);
          if (arg.startsWith('--description='))
            state.description = arg.slice(14);
        }
      }
      return {ok: true, reason: null, stderr: null, stdout: '✓ Updated\n'};
    }
    return {ok: true, reason: null, stderr: null, stdout: ''};
  };
  return {calls, run, state: () => state};
}

function blockedBead(over: Partial<Handoff> = {}): FakeBead {
  return {id: 'hb-42', notes: handoffJson({...BLOCKED, ...over})};
}

/** The handoff as it stands on the fake bead now. */
function readBack(br: FakeBr): Handoff {
  const parsed = parseHandoff(br.state()?.notes ?? null);
  if (!parsed.ok) {
    throw new Error(`the bead no longer parses: ${parsed.errors.join('; ')}`);
  }
  return parsed.handoff;
}

// ---------------------------------------------------------------------------
// AC1 — the happy path
// ---------------------------------------------------------------------------

describe('AC1: a blocked bead becomes a valid continue bead carrying the answers', () => {
  const ANSWERS = [
    'No — never delete a remote branch automatically.',
    'Yes, 0.24.0 is breaking: the verdict file is gone.',
  ];

  test('disposition flips, the questions are cleared, and it still parses', () => {
    const br = fakeBr(blockedBead());
    const outcome = answerHandoff('/repo', 'hb-42', ANSWERS, br.run, now);
    expect(outcome.kind).toBe('answered');
    const after = readBack(br);
    expect(after.disposition).toBe('continue');
    // `[]` here is a claim — "asked and answered" — not an absence.
    expect(after.openQuestions).toEqual([]);
  });

  test('every field that is not the answer is byte-identical', () => {
    const br = fakeBr(blockedBead());
    answerHandoff('/repo', 'hb-42', ANSWERS, br.run, now);
    const after = readBack(br);
    expect(stable(after)).toEqual(stable(BLOCKED));
    // The original instructions are a PREFIX of the new ones: the answers are
    // appended, never a replacement. A successor that lost its instructions
    // would boot from the answers alone.
    expect(after.next.startsWith(BLOCKED_NEXT)).toBe(true);
  });

  test('`next` ends with a dated block quoting each question and its answer', () => {
    const br = fakeBr(blockedBead());
    answerHandoff('/repo', 'hb-42', ANSWERS, br.run, now);
    const after = readBack(br);
    expect(after.next).toContain('ANSWERS FROM JUSTIN (2026-09-19):');
    expect(after.next).toContain(
      'Q: Should the runner delete remote branches automatically?\nA: No — never delete a remote branch automatically.',
    );
    expect(after.next).toContain(
      'Q: Is 0.24.0 a breaking release?\nA: Yes, 0.24.0 is breaking: the verdict file is gone.',
    );
    expect(
      after.next.endsWith(
        'A: Yes, 0.24.0 is breaking: the verdict file is gone.',
      ),
    ).toBe(true);
  });

  test('ONE answer answers every question, and says that it does', () => {
    const br = fakeBr(blockedBead());
    const outcome = answerHandoff(
      '/repo',
      'hb-42',
      ['Do neither — park both until after the release.'],
      br.run,
      now,
    );
    expect(outcome.kind).toBe('answered');
    const after = readBack(br);
    expect(after.next).toContain('(one answer for all of the questions below)');
    expect(after.next).toContain(
      'Q: Should the runner delete remote branches automatically?\nQ: Is 0.24.0 a breaking release?\nA: Do neither — park both until after the release.',
    );
  });

  test('a blocked bead that listed NO questions is still answerable', () => {
    // Reachable: the runner prints "listed no open questions" for exactly this
    // bead. Refusing it would strand the one chain with no way back at all.
    const br = fakeBr(blockedBead({openQuestions: []}));
    const outcome = answerHandoff('/repo', 'hb-42', ['Carry on.'], br.run, now);
    expect(outcome.kind).toBe('answered');
    const after = readBack(br);
    expect(after.next).toContain('(this handoff recorded no open questions)');
    expect(after.next).toContain('A: Carry on.');
  });

  test('the TITLE is rewritten too, so it cannot disagree with the notes', () => {
    const br = fakeBr(blockedBead());
    answerHandoff('/repo', 'hb-42', ANSWERS, br.run, now);
    expect(br.state()?.title).toBe('HANDOFF continue: home-base-1r6d.33');
    // …and the human-readable half with it (see the bead's notes: a stale
    // description would still be listing the questions as open).
    expect(br.state()?.description).toContain('disposition: continue');
    expect(br.state()?.description).toContain('OPEN QUESTIONS\n(none)');
  });

  test('the rewrite is ONE `br update` — title, description and notes together', () => {
    // Two calls could leave a bead whose title says continue while its notes
    // still say blocked, which is the disagreement the title rewrite exists to
    // prevent.
    const br = fakeBr(blockedBead());
    answerHandoff('/repo', 'hb-42', ANSWERS, br.run, now);
    expect(br.calls.filter((c) => c[0] === 'update')).toHaveLength(1);
  });

  test('--answer-file and stdin resolve to the same answer as --answer', () => {
    const text = 'No — never delete a remote branch automatically.\n';
    const viaFlag = resolveAnswers(
      {answer: [text.trimEnd()], answerFile: undefined, stdinIsTty: false},
      () => '',
      () => '',
    );
    const viaFile = resolveAnswers(
      {answer: undefined, answerFile: '/tmp/answer.txt', stdinIsTty: false},
      () => text,
      () => '',
    );
    const viaStdin = resolveAnswers(
      {answer: undefined, answerFile: undefined, stdinIsTty: false},
      () => '',
      () => text,
    );
    expect(viaFile).toEqual(viaFlag);
    expect(viaStdin).toEqual(viaFlag);

    // And the bead they produce is the same bead.
    const first = fakeBr(blockedBead());
    const second = fakeBr(blockedBead());
    if (!viaFlag.ok || !viaFile.ok) throw new Error('resolveAnswers refused');
    answerHandoff('/repo', 'hb-42', viaFlag.answers, first.run, now);
    answerHandoff('/repo', 'hb-42', viaFile.answers, second.run, now);
    expect(second.state()?.notes).toBe(first.state()?.notes ?? '');
  });
});

describe('resolveAnswers: where the answer comes from', () => {
  test('a multi-paragraph file survives whole — that is why the flag exists', () => {
    const essay = 'First, do not delete.\n\nSecond, "quote this" verbatim.\n';
    const got = resolveAnswers(
      {answer: undefined, answerFile: '/tmp/a.txt', stdinIsTty: false},
      () => essay,
      () => '',
    );
    expect(got).toEqual({answers: [essay.trimEnd()], ok: true});
  });

  test('both sources at once is refused rather than guessed between', () => {
    const got = resolveAnswers(
      {answer: ['inline'], answerFile: '/tmp/a.txt', stdinIsTty: false},
      () => 'from the file',
      () => '',
    );
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.errors[0]).toContain(
      '--answer OR --answer-file',
    );
  });

  test('an unreadable file is a named failure, never an empty answer', () => {
    const got = resolveAnswers(
      {answer: undefined, answerFile: '/nope.txt', stdinIsTty: false},
      () => {
        throw new Error('ENOENT: no such file or directory');
      },
      () => '',
    );
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.errors[0]).toContain('/nope.txt');
    expect(got.ok === false && got.errors[0]).toContain('ENOENT');
  });

  test('an empty file, empty stdin and a tty each refuse by name', () => {
    const emptyFile = resolveAnswers(
      {answer: undefined, answerFile: '/tmp/a.txt', stdinIsTty: false},
      () => '   \n',
      () => '',
    );
    expect(emptyFile.ok === false && emptyFile.errors[0]).toContain('is empty');
    const emptyStdin = resolveAnswers(
      {answer: undefined, answerFile: undefined, stdinIsTty: false},
      () => '',
      () => '\n',
    );
    expect(emptyStdin.ok === false && emptyStdin.errors[0]).toContain(
      'stdin was empty',
    );
    // A tty would BLOCK on a read nobody is going to type into.
    const tty = resolveAnswers(
      {answer: undefined, answerFile: undefined, stdinIsTty: true},
      () => '',
      () => {
        throw new Error('stdin must not be read when it is a tty');
      },
    );
    expect(tty.ok === false && tty.errors[0]).toContain('no answer given');
  });
});

// ---------------------------------------------------------------------------
// AC2 — every refusal, by name, with the bead untouched
// ---------------------------------------------------------------------------

describe('AC2: the helper refuses anything that is not an open blocked handoff', () => {
  function refusal(bead: FakeBead | null): {
    br: FakeBr;
    report: ReturnType<typeof renderAnswer>;
  } {
    const br = fakeBr(bead);
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['an answer'], br.run, now),
    );
    // Nothing is ever written on a refusal.
    expect(br.calls.filter((c) => c[0] === 'update')).toHaveLength(0);
    return {br, report};
  }

  test('a bead that does not exist', () => {
    const {report} = refusal(null);
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('no bead hb-42');
  });

  test('a CLOSED bead — already claimed is not a waiting question', () => {
    const {br, report} = refusal({...blockedBead(), status: 'closed'});
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('is CLOSED');
    expect(readBack(br).disposition).toBe('blocked');
  });

  test('a status this helper has never seen refuses rather than assuming', () => {
    const {report} = refusal({...blockedBead(), status: 'archived'});
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('status `archived`');
  });

  test('a bead that is not labelled handoff', () => {
    const {report} = refusal({...blockedBead(), labels: ['chore']});
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('not labelled `handoff`');
  });

  test('notes that do not parse — and it says WHY', () => {
    const {br, report} = refusal({id: 'hb-42', notes: '{"schemaVersion": 1'});
    expect(report.exitCode).toBe(1);
    const said = report.stderr.join('\n');
    expect(said).toContain('does not carry readable handoff JSON');
    expect(said).toContain('notes is not valid JSON');
    // Untouched: the bytes are still the ones that did not parse.
    expect(br.state()?.notes).toBe('{"schemaVersion": 1');
  });

  test('a bead with no notes at all', () => {
    const {report} = refusal({id: 'hb-42', notes: null});
    expect(report.exitCode).toBe(1);
    expect(report.stderr.join('\n')).toContain('notes is empty');
  });

  test('a handoff that is not BLOCKED — continue and done both refuse', () => {
    for (const disposition of ['continue', 'done'] as const) {
      const {report} = refusal(blockedBead({disposition}));
      expect(report.exitCode).toBe(1);
      expect(report.stderr.join('\n')).toContain(
        `disposition \`${disposition}\`, not \`blocked\``,
      );
    }
  });

  test('more answers than questions, and fewer: both refuse by count', () => {
    const br = fakeBr(blockedBead());
    const three = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a', 'b', 'c'], br.run, now),
    );
    expect(three.exitCode).toBe(1);
    expect(three.stderr.join('\n')).toContain('3 answers for 2 open question');
    expect(br.calls.filter((c) => c[0] === 'update')).toHaveLength(0);

    const oneQuestion = fakeBr(blockedBead({openQuestions: ['Just the one?']}));
    const two = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a', 'b'], oneQuestion.run, now),
    );
    expect(two.exitCode).toBe(1);
    expect(two.stderr.join('\n')).toContain('2 answers for 1 open question');
  });

  test('every refusal says the bead was not changed', () => {
    const {report} = refusal(blockedBead({disposition: 'done'}));
    expect(report.stderr).toContain('The bead was NOT changed.');
    expect(report.stdout).toEqual([]);
  });
});

describe('a br failure is never spendable as success (critical rule 7)', () => {
  test('an unreadable `br list` is exit 2, not "no such bead"', () => {
    const br = fakeBr(blockedBead(), {listFails: true});
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a'], br.run, now),
    );
    expect(report.exitCode).toBe(2);
    expect(report.stderr.join('\n')).toContain('br unavailable');
    expect(report.stderr.join('\n')).toContain('nothing was rewritten');
  });

  test('output `br list` cannot parse is exit 2, not an empty list', () => {
    const br = fakeBr(blockedBead(), {listGarbage: true});
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a'], br.run, now),
    );
    expect(report.exitCode).toBe(2);
    expect(report.stderr.join('\n')).toContain('could not parse');
  });

  test('a failed `br update` is exit 2 and prints the JSON to apply by hand', () => {
    const br = fakeBr(blockedBead(), {updateFails: true});
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a'], br.run, now),
    );
    expect(report.exitCode).toBe(2);
    const said = report.stderr.join('\n');
    expect(said).toContain('could NOT be rewritten');
    expect(said).toContain('database is locked');
    expect(said).toContain('still a BLOCKED handoff');
    // The whole JSON, so the rewrite is recoverable without re-deriving it.
    expect(said).toContain('"disposition": "continue"');
  });

  test('a br refusal shows ALL of br’s stderr, not just its first line (F4)', () => {
    // home-base-685h F4. Every refusal in handoff.ts goes through `brFailure`,
    // which used to be `reason` alone — one line. A `br update` that fails on a
    // clap usage block or a locked database says WHICH argument or WHICH lock
    // on its second and third lines, and those are the ones worth reading.
    const br = fakeBr(blockedBead(), {updateFails: true});
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['a'], br.run, now),
    );
    const said = report.stderr.join('\n');
    expect(said).toContain('another process is holding .beads/beads.db');
    expect(said).toContain('retry once it releases, or close the other br');
  });
});

// ---------------------------------------------------------------------------
// AC3 — what it prints
// ---------------------------------------------------------------------------

describe('AC3: stdout is the id, then the command that restarts the arc', () => {
  test('the id first, the rerun command second, and nothing else', () => {
    const br = fakeBr(blockedBead());
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['an answer'], br.run, now),
    );
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toEqual([
      'hb-42',
      'bun run justin-sdk justin-loop --pickup --label pilot2',
    ]);
  });

  test('both printed commands are the TERMINAL invocation form (F8)', () => {
    // home-base-685h F8, epic home-base-dchjw D1: these two strings are pasted
    // into a terminal, so they take form 2 (`bun run justin-sdk …`). The bare
    // `justin-sdk …` is form 1 — legal only inside a package.json script value,
    // and outside an enrolled repo `bunx justin-sdk` resolves to an unrelated
    // package on the public npm registry. The session CONTRACT keeps the bare
    // form on purpose: a loop session has it on PATH via home-base/bin.
    expect(answerCommand('hb-42').startsWith(SDK_RUN)).toBe(true);
    expect(rerunCommand('pilot2-2').startsWith(SDK_RUN)).toBe(true);
    expect(SDK_RUN).toBe('bun run justin-sdk');
  });

  test('the label is the SLUG — `pilot2-2` is session 2 of run `pilot2`', () => {
    expect(slugFromLabel('pilot2-2')).toBe('pilot2');
    expect(rerunCommand('fix-worktree-hydration-11')).toBe(
      'bun run justin-sdk justin-loop --pickup --label fix-worktree-hydration',
    );
    // A label with no trailing -<n> is its own slug, and one that would strip
    // to nothing keeps itself — an empty --label is what the runner refuses.
    expect(slugFromLabel('pilot2')).toBe('pilot2');
    expect(slugFromLabel('-1')).toBe('-1');
  });

  test('it never prints a --model it did not read', () => {
    // VERIFIED 2026-09-19: LedgerRow carries no `model` field, so the ledger
    // cannot tell what the chain ran with. Printing one would be inventing it.
    const br = fakeBr(blockedBead());
    const report = renderAnswer(
      answerHandoff('/repo', 'hb-42', ['an answer'], br.run, now),
    );
    expect(report.stdout.join('\n')).not.toContain('--model');
    expect(report.stderr.join('\n')).toContain(
      'the ledger does not record the --model',
    );
  });
});

describe('answersBlock renders the three shapes', () => {
  test('paired, single-for-many, and none', () => {
    expect(answersBlock(['Q1?'], ['A1'], WHEN)).toBe(
      'ANSWERS FROM JUSTIN (2026-09-19):\n\nQ: Q1?\nA: A1',
    );
    expect(answersBlock(['Q1?', 'Q2?'], ['A1', 'A2'], WHEN)).toBe(
      'ANSWERS FROM JUSTIN (2026-09-19):\n\nQ: Q1?\nA: A1\n\nQ: Q2?\nA: A2',
    );
    expect(answersBlock([], ['A1'], WHEN)).toBe(
      'ANSWERS FROM JUSTIN (2026-09-19):\n(this handoff recorded no open questions)\n\nA: A1',
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — the answered bead is one the RUNNER picks up
// ---------------------------------------------------------------------------

describe('AC4: a run started after the answer boots from the answered bead', () => {
  test("the successor's prompt is the answered `next`, answers included", async () => {
    // End to end through the real helper: whatever it wrote is exactly what the
    // start-of-run scan is handed. A helper that reported success while writing
    // something `planStartBoot` skips would leave the chain dead with nothing
    // saying so — and no unit test of either half alone would notice.
    const br = fakeBr(blockedBead());
    const outcome = answerHandoff(
      '/repo',
      'hb-42',
      [
        'No — never delete a remote branch automatically.',
        'Yes, 0.24.0 is breaking: the verdict file is gone.',
      ],
      br.run,
      now,
    );
    expect(outcome.kind).toBe('answered');
    const answeredNotes = br.state()?.notes ?? null;
    expect(answeredNotes).not.toBeNull();

    const r = await runLoop({
      opts: {handoffRetries: 0, label: 'pilot2', maxSessions: 1},
      scans: [
        // The start-of-run scan finds the bead the helper just rewrote.
        [{id: 'hb-42', notes: answeredNotes, title: 'HANDOFF continue: 33'}],
        [],
      ],
    });
    const prompt = promptOf(r.dispatches[0] ?? []);
    expect(prompt).toContain('ANSWERS FROM JUSTIN (2026-09-19):');
    expect(prompt).toContain(
      'No — never delete a remote branch automatically.',
    );
    // The original instructions travel with the answers, still leading.
    expect(prompt.startsWith(BLOCKED_NEXT)).toBe(true);
    expect(r.stdout).toContain('picking up handoff hb-42');
  });

  test('the same bead BEFORE it is answered is not picked up at all', () => {
    // The negative half of the pair: it is the ANSWER that makes it eligible,
    // not the run's flags. Without this, the test above would pass even if
    // planStartBoot had quietly started booting from blocked beads.
    return runLoop({
      opts: {handoffRetries: 0, label: 'pilot2', maxSessions: 1},
      scans: [[{id: 'hb-42', notes: handoffJson(BLOCKED)}], []],
    }).then((r) => {
      expect(r.stdout).not.toContain('picking up handoff hb-42');
      expect(r.stdout).toContain('disposition=blocked, not a starting point');
    });
  });
});
