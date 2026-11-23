/**
 * The documented example of a thread report payload (home-base-p1uj D8),
 * shared by tests/thread-schema.test.ts and every thread test that starts
 * from a valid payload.
 *
 * A plain module, not a test file (home-base-ejsq2.6). While it lived in
 * thread-schema.test.ts, every importer evaluated that file again under
 * `bun test --parallel` (which isolates each file) and registered its 22
 * tests once more: a parallel run counted 286 tests that a serial run counts
 * once.
 */

import {THREAD_SCHEMA_VERSION} from '../src/thread/schema';

/** A complete, valid payload. Every test below starts from a copy of this. */
export function examplePayload(): Record<string, unknown> {
  return {
    answers: [
      {
        answer: 'Yes — measured 2026-09-12, it is the parent session id.',
        question: 'Is CLAUDE_CODE_SESSION_ID exported inside a subagent?',
      },
    ],
    asks: [
      {
        context:
          'The adapter closes asks instead of deleting them, because bd delete wedges auto-export.',
        default: 'I keep closing rather than deleting.',
        kind: 'approve',
        options: [
          {
            recommended: true,
            text: 'Keep closing — reversible, export stays healthy',
          },
          {
            recommended: false,
            text: 'Delete — tidier list, wedges the JSONL export',
          },
        ],
        priority: 0,
        text: 'Approve closing ask beads rather than deleting them?',
      },
      {
        context:
          'The knob defaults off, so nothing changes for other sessions.',
        default: 'I leave it off everywhere but this machine.',
        kind: 'pick',
        options: [
          {recommended: true, text: 'a — user config only'},
          {recommended: false, text: 'b — every enrolled repo'},
        ],
        priority: 3,
        text: 'Where should componentConfig.thread.enabled live?',
      },
    ],
    beadsTouched: [
      {description: 'the thread command group core', id: 'home-base-p1uj.1'},
    ],
    continuesFrom: null,
    deviations: [
      {
        kind: 'judgmentCall',
        text: 'The knob defaults off, which is not what the bead said — the bead said on.',
      },
    ],
    did: ['Built the thread command group', 'Wired the bin symlink'],
    discussion: ['bd update --metadata MERGES; it does not replace.'],
    goal: 'Status reports as beads, one thread bead per session',
    handoff: null,
    instruction: 'You told me to build dispatch 2 of the thread-reports epic.',
    learned: [
      {
        disposition: '✅ written into src/thread/bd.ts',
        text: 'bd update --metadata merges rather than replaces',
      },
    ],
    nextStep: 'answerAsks',
    priorAsks: [
      {
        detail: 'You said "yes, closing is right".',
        disposition: 'answered',
        id: 'jl-x7q.1',
      },
    ],
    progress: {percent: 70, remaining: ['the read path', 'the rules edit']},
    schemaVersion: THREAD_SCHEMA_VERSION,
    stopReason: {
      detail: 'Dispatch 2 is built and verified.',
      kind: 'completed',
    },
    title: 'thread-reports dispatch 2: the write path',
    workProduct: {
      kind: 'code',
      merged: 'unmerged',
      pr: null,
      summary: 'src/thread/ plus the bin symlink, on branch thread-reports',
    },
  };
}
