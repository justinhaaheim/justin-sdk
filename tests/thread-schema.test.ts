/**
 * The report payload schema (home-base-p1uj D8).
 *
 * Two things are worth a test here and the rest is zod doing its job: that the
 * documented example actually validates (a skeleton nobody can submit is worse
 * than no skeleton), and that a BARE BEAD ID is rejected — the single failure
 * mode the sampling of real reports turned up most often.
 */

import {describe, expect, test} from 'bun:test';

import {
  payloadSkeleton,
  THREAD_SCHEMA_VERSION,
  threadReportSchema,
  validateThreadReport,
} from '../src/thread/schema';

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
        blocking: true,
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
        text: 'Approve closing ask beads rather than deleting them?',
      },
      {
        blocking: false,
        context:
          'The knob defaults off, so nothing changes for other sessions.',
        default: 'I leave it off everywhere but this machine.',
        kind: 'pick',
        options: [
          {recommended: true, text: 'a — user config only'},
          {recommended: false, text: 'b — every enrolled repo'},
        ],
        text: 'Where should componentConfig.thread.enabled live?',
      },
    ],
    beadsTouched: [
      {description: 'the thread command group core', id: 'home-base-p1uj.1'},
    ],
    continuesFrom: null,
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

describe('thread report schema', () => {
  test('accepts the documented example', () => {
    const result = validateThreadReport(examplePayload());
    expect(result.status).toBe('ok');
  });

  test('the prepare skeleton itself validates against the schema', () => {
    // The skeleton is hand-written for the sake of its hints, so nothing but a
    // test stops it drifting into a shape `thread report` would refuse.
    const skeleton = JSON.parse(payloadSkeleton()) as unknown;
    const result = validateThreadReport(skeleton);
    if (result.status !== 'ok') {
      throw new Error(
        `skeleton does not validate:\n${result.issues.join('\n')}`,
      );
    }
    expect(result.status).toBe('ok');
  });

  test('the skeleton names every key the schema knows about', () => {
    const skeleton = JSON.parse(payloadSkeleton()) as Record<string, unknown>;
    const schemaKeys = Object.keys(threadReportSchema.shape).sort();
    expect(Object.keys(skeleton).sort()).toEqual(schemaKeys);
  });

  test('REJECTS a bare bead id — beadsTouched needs a description', () => {
    const payload = examplePayload();
    payload.beadsTouched = [{id: 'z36o'}];
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.issues.join('\n')).toContain('beadsTouched.0.description');
  });

  test('REJECTS an empty beadsTouched description', () => {
    const payload = examplePayload();
    payload.beadsTouched = [{description: '', id: 'z36o'}];
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
  });

  test('names the path AND the reason for every violation', () => {
    const payload = examplePayload();
    payload.title = '';
    payload.progress = {percent: 500, remaining: []};
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    const text = result.issues.join('\n');
    expect(text).toContain('title:');
    expect(text).toContain('progress.percent:');
  });

  test('rejects an unknown stopReason kind', () => {
    const payload = examplePayload();
    payload.stopReason = {detail: 'x', kind: 'ranOutOfCoffee'};
    expect(validateThreadReport(payload).status).toBe('invalid');
  });

  test('accepts unknown extra keys (loose, like sdk-config)', () => {
    const payload = examplePayload();
    payload.somethingANewerSdkAdded = 42;
    expect(validateThreadReport(payload).status).toBe('ok');
  });
});
