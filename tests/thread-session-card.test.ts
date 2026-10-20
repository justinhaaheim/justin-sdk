/**
 * The dashboard card's "You need to" line (epic home-base-j8q3e.1 design D3;
 * built by home-base-j8q3e.1.1): one test per rule, 1 to 10, over a fixture
 * SESSION MODEL built in memory. Each test derives the status with the real
 * `deriveStatus(statusFactsOf(model))` first and asserts it, so a fixture that
 * stopped reaching its rule fails loudly instead of testing the wrong branch.
 *
 * NEGATIVE CONTROLS: one per rule, recorded in home-base-j8q3e.1.1's notes.
 */

import type {
  GitMeasurements,
  MergeState,
  SessionModel,
} from '../src/thread/session-model';
import type {RequestNode, TreeIssue} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {THREAD_DEFAULT_STAGES} from '../src/thread/defaults';
import {
  type ActionLine,
  deriveAction,
  landingStages,
  sectionFor,
} from '../src/thread/session-card';
import {measured, unmeasured} from '../src/thread/session-model';
import {
  deriveStatus,
  type SessionStatus,
  statusCounts,
  statusFactsOf,
} from '../src/thread/session-status';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const SID = '5e550000-1111-4222-8333-000000000001';
const NEXT_SID = '5e550000-1111-4222-8333-000000000002';
const HOME_BASE_LADDER = ['code-done', 'tested', 'approved'];

function issue(id: string, over: Partial<TreeIssue> = {}): TreeIssue {
  return {
    beadsDir: '/repo/.beads',
    closeReason: null,
    closedAt: null,
    createdAt: '2030-01-01T09:00:00.000Z',
    description: null,
    id,
    issueType: 'task',
    labels: [],
    notes: null,
    parentIds: [],
    priority: 2,
    status: 'in_progress',
    title: id,
    updatedAt: '2030-01-01T09:00:00.000Z',
    ...over,
  };
}

function closed(id: string, title: string, labels: string[] = []): RequestNode {
  return {
    children: [],
    questions: [],
    request: issue(id, {
      labels: ['request', ...labels],
      status: 'closed',
      title,
    }),
  };
}

function open(id: string, title: string): RequestNode {
  return {
    children: [],
    questions: [],
    request: issue(id, {labels: ['request'], title}),
  };
}

function question(
  id: string,
  title: string,
  priority: number,
  form: 'answer' | 'do' = 'answer',
): TreeIssue {
  return issue(id, {
    description: `Form: ${form}\n\nNo default: the session stops here`,
    issueType: 'question',
    labels: ['ask'],
    priority,
    status: 'open',
    title,
  });
}

/** A quiet, landed session on main: every test changes what its rule needs. */
function fixture(over: {
  git?: Partial<GitMeasurements>;
  lastRole?: 'assistant' | 'user';
  questions?: TreeIssue[];
  requests?: RequestNode[];
  session?: Partial<TreeIssue>;
  stages?: readonly string[];
  transcript?: Partial<SessionModel['transcript']>;
}): SessionModel {
  return {
    beads: {
      problems: [],
      questions: over.questions ?? [],
      requests: over.requests ?? [],
      session: issue('t-1', {
        issueType: 'session',
        labels: ['session'],
        title: 'Fix the date parser',
        ...over.session,
      }),
      sessionMissing: null,
    },
    cmux: {surface: null, workspace: null},
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      checkout: '/repo',
      checkoutSource: 'logCwd',
      commits: measured({
        count: 0,
        shas: [],
        source: 'transcript',
        unmatchedCalls: [],
        unresolved: [],
      }),
      defaultBranch: measured('main'),
      merged: measured<MergeState>('isDefault'),
      repo: 'app',
      uncommitted: measured([]),
      unpushed: measured({kind: 'noUpstream'}),
      worktree: measured({kind: 'primary'}),
      ...over.git,
    },
    log: {
      failures: [],
      kind: 'read',
      lines: [
        {
          at: '2030-01-01T09:00:00.000Z',
          cwd: '/repo',
          event: 'UserPromptSubmit',
          role: 'user',
          text: 'Fix the date parser',
        },
        ...(over.lastRole === 'user'
          ? []
          : [
              {
                at: '2030-01-01T09:30:00.000Z',
                cwd: '/repo',
                event: 'Stop' as const,
                role: 'assistant' as const,
                text: 'Fixed.',
              },
            ]),
      ],
      path: '/state/log.jsonl',
    },
    repo: 'app',
    repoTag: 'APP',
    sessionBeadId: 't-1',
    sessionId: SID,
    sightings: [],
    stages: over.stages ?? THREAD_DEFAULT_STAGES,
    startedAt: measured('2030-01-01T09:00:00.000Z'),
    transcript: {
      contextTokens: measured(50_000),
      helpers: measured([]),
      lastRecordAt: measured('2030-01-01T09:30:00.000Z'),
      path: '/projects/x.jsonl',
      ...over.transcript,
    },
    wrapUpAt: 150_000,
  };
}

function statusOf(model: SessionModel): SessionStatus {
  return deriveStatus(statusFactsOf(model), {asIfYielded: false, now: NOW});
}

function action(
  model: SessionModel,
  successorSessionId: string | null = null,
): ActionLine & {kind: SessionStatus['kind']} {
  const status = statusOf(model);
  return {
    ...deriveAction({model, status, successorSessionId}),
    kind: status.kind,
  };
}

describe('D3 rule 1: an open P0 question', () => {
  test('"Answer: <question>" with the answer command; "Do:" for a --do ask; "(and N more)" for several', () => {
    const one = action(
      fixture({
        questions: [question('t-q1', 'Which bucket?', 0)],
        requests: [open('t-2', 'Write the export runbook')],
      }),
    );
    expect(one).toEqual({
      command: 'bun run justin-sdk thread answer t-1',
      kind: 'waiting',
      rule: 1,
      text: 'Answer: Which bucket?',
    });
    const several = action(
      fixture({
        questions: [
          question('t-q1', 'Install the build on your phone', 0, 'do'),
          question('t-q2', 'Which bucket?', 0),
          question('t-q3', 'Optional thing?', 2),
        ],
        requests: [open('t-2', 'Ship it')],
      }),
    );
    expect(several.rule).toBe(1);
    expect(several.text).toBe(
      'Do: Install the build on your phone (and 1 more)',
    );
  });
});

describe('D3 rule 2: working', () => {
  // F10 (home-base-j8q3e.1.10): Claude's own last record is an hour old (a
  // long tool call inside a helper writes nothing), but a helper is in flight
  // with a record 10 minutes old.
  test('a helper in flight: "Nothing yet. Claude\'s helper agents are still working."', () => {
    const result = action(
      fixture({
        requests: [open('t-2', 'Refactor the parser')],
        transcript: {
          helpers: measured([
            {
              agentFile: '/projects/x/subagents/agent-a1.jsonl',
              lastRecordAt: '2030-01-01T11:50:00.000Z',
            },
          ]),
          lastRecordAt: measured('2030-01-01T11:00:00.000Z'),
        },
      }),
    );
    expect(result).toEqual({
      command: null,
      kind: 'working',
      rule: 2,
      text: "Nothing yet. Claude's helper agents are still working.",
    });
  });

  test('a record under 3 minutes old: "Nothing yet. Claude is working."', () => {
    const result = action(
      fixture({
        requests: [open('t-2', 'Refactor the parser')],
        transcript: {lastRecordAt: measured('2030-01-01T11:59:00.000Z')},
      }),
    );
    expect(result).toEqual({
      command: null,
      kind: 'working',
      rule: 2,
      text: 'Nothing yet. Claude is working.',
    });
  });
});

describe('D3 rule 3: handed off', () => {
  test("the successor's resume command when known; else where the handoff is", () => {
    const handed = fixture({
      requests: [open('t-2', 'Migrate the orders table')],
      session: {labels: ['session', 'handed-off', 'continued-by:t-9']},
    });
    expect(action(handed, NEXT_SID)).toEqual({
      command: `claude --resume ${NEXT_SID}`,
      kind: 'handedOff',
      rule: 3,
      text: 'Continue in the next session:',
    });
    const unknownSuccessor = action(handed, null);
    expect(unknownSuccessor.rule).toBe(3);
    expect(unknownSuccessor.text).toBe(
      "Continue in a new session. Claude's handoff is in its last message:",
    );
    expect(unknownSuccessor.command).toBe('bun run justin-sdk thread show t-1');
  });
});

describe('D3 rule 4: out of context', () => {
  test('no handoff: "Resume it and ask Claude for a handoff."; a handoff note: start from it', () => {
    const full = {contextTokens: measured(160_000)};
    const none = action(
      fixture({requests: [open('t-2', 'Big refactor')], transcript: full}),
    );
    expect(none).toEqual({
      command: null,
      kind: 'outOfContext',
      rule: 4,
      text: 'Resume it and ask Claude for a handoff.',
    });
    const noted = action(
      fixture({
        requests: [open('t-2', 'Big refactor')],
        session: {notes: '- 2030-01-01 11:00: handed off — half done'},
        transcript: full,
      }),
    );
    expect(noted.rule).toBe(4);
    expect(noted.text).toBe(
      "Start a fresh session from its handoff. The handoff is in Claude's last message:",
    );
  });
});

describe('D3 rule 5: stopped with work open, no blocker', () => {
  test('"Claude stopped with N of M requests unfinished …"; with no request, the work it left', () => {
    const result = action(
      fixture({
        requests: [
          closed('t-2', 'Speed up the importer'),
          open('t-3', 'Add a progress bar'),
        ],
      }),
    );
    expect(result).toEqual({
      command: null,
      kind: 'openWork',
      rule: 5,
      text: 'Claude stopped with 1 of 2 requests unfinished and no question for you. Resume it and say continue.',
    });
    const noRequest = action(
      fixture({
        git: {
          commits: measured({
            count: 2,
            shas: ['a', 'b'],
            source: 'transcript',
            unmatchedCalls: [],
            unresolved: [],
          }),
        },
      }),
    );
    expect(noRequest.rule).toBe(5);
    expect(noRequest.text).toBe(
      'Claude stopped with 2 commits, no request filed, and no question for you. Resume it and say continue.',
    );
  });

  test('home-base-tg45h: never "no question for you" while optional questions are open — counted as the card\'s Optional line counts them (P1–P4)', () => {
    // 2026-10-19: rule 5 said "no question for you" beside 11 open questions.
    const optional = [
      question('t-5', 'Gzip the export?', 3),
      question('t-6', 'Rename the bucket?', 1),
      question('t-7', 'FYI: the cron moved', 4),
    ];
    const withRequests = action(
      fixture({
        questions: optional,
        requests: [
          closed('t-2', 'Speed up the importer'),
          open('t-3', 'Add a progress bar'),
        ],
      }),
    );
    expect(withRequests).toEqual({
      command: null,
      kind: 'openWork',
      rule: 5,
      text: 'Claude stopped with 1 of 2 requests unfinished and nothing that needs your answer first (3 optional questions). Resume it and say continue.',
    });

    const oneQuestion = action(
      fixture({
        git: {
          commits: measured({
            count: 2,
            shas: ['a', 'b'],
            source: 'transcript',
            unmatchedCalls: [],
            unresolved: [],
          }),
        },
        questions: [question('t-5', 'Gzip the export?', 2)],
      }),
    );
    expect(oneQuestion.kind).toBe('openWork');
    expect(oneQuestion.text).toBe(
      'Claude stopped with 2 commits, no request filed, and nothing that needs your answer first (1 optional question). Resume it and say continue.',
    );

    const nothingLeft = action(
      fixture({lastRole: 'user', questions: optional}),
    );
    expect(nothingLeft.kind).toBe('openWork');
    expect(nothingLeft.text).toBe(
      'Claude stopped before answering your last message, and has nothing that needs your answer first (3 optional questions). Resume it and say continue.',
    );

    // A closed (answered) question is not open: the line is the plain one.
    const answered = action(
      fixture({
        questions: [
          {...question('t-5', 'Gzip the export?', 3), status: 'closed'},
        ],
        requests: [open('t-3', 'Add a progress bar')],
      }),
    );
    expect(answered.text).toBe(
      'Claude stopped with 1 of 1 request unfinished and no question for you. Resume it and say continue.',
    );

    for (const result of [withRequests, oneQuestion, nothingLeft]) {
      expect(result.text).not.toContain('no question for you');
    }
  });
});

describe('D3 rule 6: done, not merged', () => {
  test('"Land it: merge <branch> into main (N commits)", or commit the uncommitted files', () => {
    const notMerged = action(
      fixture({
        git: {
          aheadOfDefault: measured(3),
          branch: measured('worktree-parser'),
          merged: measured<MergeState>('notMerged'),
        },
        requests: [closed('t-2', 'Fix the date parser')],
      }),
    );
    expect(notMerged).toEqual({
      command: null,
      kind: 'doneUnmerged',
      rule: 6,
      text: 'Land it: merge worktree-parser into main (3 commits)',
    });
    const dirty = action(
      fixture({
        git: {uncommitted: measured(['src/a.ts', 'src/b.ts'])},
        requests: [closed('t-2', 'Fix the date parser')],
      }),
    );
    expect(dirty.rule).toBe(6);
    expect(dirty.text).toBe('Land it: commit the 2 uncommitted files on main');
  });
});

describe('D3 rule 7: done and merged, a landing stage not reached (D4)', () => {
  test('app ladder, stages code-done and tested: "Land it: build the app" with the mark command; built: send the link; link-sent: try it', () => {
    const notBuilt = action(
      fixture({
        requests: [
          closed('t-2', 'Fix the date parser', [
            'stage:code-done',
            'stage:tested',
          ]),
        ],
      }),
    );
    expect(notBuilt).toEqual({
      command: `bun run justin-sdk thread stage t-2 built --session ${SID}`,
      kind: 'done',
      rule: 7,
      text: 'Land it: build the app, then mark it built:',
    });
    const built = action(
      fixture({
        requests: [closed('t-2', 'Fix the date parser', ['stage:built'])],
      }),
    );
    expect(built.text).toBe(
      'Land it: send the build link, then mark it link-sent:',
    );
    const sent = action(
      fixture({requests: [closed('t-2', 'Fix it', ['stage:link-sent'])]}),
    );
    expect(sent.text).toBe('Try it, then mark it approved:');
    expect(sent.command).toBe(
      `bun run justin-sdk thread stage t-2 approved --session ${SID}`,
    );
  });

  test('home-base ladder (code-done, tested, approved): the same request is "Try it, then mark it approved:"', () => {
    const result = action(
      fixture({
        requests: [
          closed('t-2', 'Fix the date parser', [
            'stage:code-done',
            'stage:tested',
            // Off the home-base ladder: ignored, never mistaken for a rung.
            'stage:built',
          ]),
        ],
        stages: HOME_BASE_LADDER,
      }),
    );
    expect(result).toEqual({
      command: `bun run justin-sdk thread stage t-2 approved --session ${SID}`,
      kind: 'done',
      rule: 7,
      text: 'Try it, then mark it approved:',
    });
  });
});

describe('D3 rule 8: answered', () => {
  test('a question, no request, no commit, clean: "Nothing. Read the answer if you have not:"', () => {
    expect(action(fixture({}))).toEqual({
      command: 'bun run justin-sdk thread show t-1',
      kind: 'answered',
      rule: 8,
      text: 'Nothing. Read the answer if you have not:',
    });
  });
});

describe('D3 rule 9: done', () => {
  test('a closed request with NO stage marked is never nagged, on either ladder: "Nothing. You can close its pane."', () => {
    for (const stages of [THREAD_DEFAULT_STAGES, HOME_BASE_LADDER]) {
      expect(
        action(
          fixture({
            requests: [closed('t-2', 'Find out why the export is slow')],
            stages,
          }),
        ),
      ).toEqual({
        command: null,
        kind: 'done',
        rule: 9,
        text: 'Nothing. You can close its pane.',
      });
    }
    // Every closed request at its ladder's last stage: landed.
    for (const stages of [THREAD_DEFAULT_STAGES, HOME_BASE_LADDER]) {
      expect(
        action(
          fixture({
            requests: [closed('t-2', 'Fix it', ['stage:approved'])],
            stages,
          }),
        ).rule,
      ).toBe(9);
    }
    // Justin's own `thread done` is his decision: rule 7 does not second-guess it.
    expect(
      action(
        fixture({
          requests: [closed('t-2', 'Fix it')],
          session: {closeReason: 'done: Justin', status: 'closed'},
        }),
      ).rule,
    ).toBe(9);
  });
});

describe('D3 rule 10: unknown or unreadable', () => {
  test('a fact that could not be measured: "Check it by hand: <reason>", never a reassuring line', () => {
    const result = action(
      fixture({
        git: {merged: unmeasured('git merge-base exited 128: bad object')},
        requests: [closed('t-2', 'Fix the date parser')],
      }),
    );
    expect(result).toEqual({
      command: null,
      kind: 'unknown',
      rule: 10,
      text: 'Check it by hand: git merge-base exited 128: bad object',
    });
  });
});

describe('D4 and D5: landing stages and sections', () => {
  test('landing stages are the ladder after tested', () => {
    expect(landingStages(THREAD_DEFAULT_STAGES)).toEqual([
      'built',
      'link-sent',
      'approved',
    ]);
    expect(landingStages(HOME_BASE_LADDER)).toEqual(['approved']);
    expect(landingStages(['code-done', 'shipped'])).toEqual([]);
  });

  test('rules 6 and 7 go under To land; rule 9 under Done, or Done with questions for an open P1/P2', () => {
    const landed = fixture({requests: [closed('t-2', 'Fix it')]});
    const status = statusOf(landed);
    const counts = statusCounts(landed);
    expect(sectionFor(7, status, counts)).toBe('toLand');
    expect(sectionFor(6, status, counts)).toBe('toLand');
    expect(sectionFor(9, status, counts)).toBe('done');
    const asked = fixture({
      questions: [question('t-q', 'Gzip it too?', 2)],
      requests: [closed('t-2', 'Fix it')],
    });
    expect(sectionFor(9, statusOf(asked), statusCounts(asked))).toBe(
      'doneQuestions',
    );
    expect(sectionFor(10, null, null)).toBe('checkByHand');
    expect(sectionFor(5, null, null)).toBe('stoppedOpen');
  });
});
