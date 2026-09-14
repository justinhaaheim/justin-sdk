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
        priority: 0,
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
        priority: 3,
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
    deviations: [
      'The knob defaults off, which is not what the bead said — the bead said on.',
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

  // STRICT, not loose (home-base-p1uj.2, reversing dispatch 2's z.looseObject).
  // The whole point is that the key is NAMED: a report is written and read by
  // the same binary seconds apart, so an unknown key is never a newer SDK's
  // field — it is a typo, and a dropped typo is a failed field reported as an
  // absent one.
  test('REFUSES an unknown top-level key, and names it', () => {
    const payload = examplePayload();
    payload.somethingIMistyped = 42;
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.issues.join('\n')).toContain('somethingIMistyped');
  });

  test('REFUSES a typo that would otherwise silently drop a whole field', () => {
    const payload = examplePayload();
    payload.progres = payload.progress;
    delete payload.progress;
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    const text = result.issues.join('\n');
    // Asserting on the UNRECOGNIZED-KEY issue specifically, not just on the
    // substring "progres" — which "progress" trivially contains, so a loose
    // schema (where only the missing-field issue is raised) would pass it. The
    // negative control caught exactly that, 2026-09-12.
    expect(text).toContain('Unrecognized key: "progres"');
    expect(text).toContain('progress');
  });

  test('REFUSES an unknown key nested inside an ask', () => {
    const payload = examplePayload();
    const asks = payload.asks as Record<string, unknown>[];
    asks[0]!.blockign = true;
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.issues.join('\n')).toContain('blockign');
  });
});

/**
 * THE v1 BRIDGE (D15).
 *
 * `home-base/bin/justin-sdk` is a symlink into this source tree, so every
 * session on the machine runs whatever is checked out here — while the rule text
 * that tells Claude what to write updates separately, and spooled reports from
 * before the change sit on disk waiting to drain. For that whole interval the
 * payloads arriving are v1. A refusal is not a safe failure either: the wrap-up
 * rule falls back to prose on `THREADS: DISABLED` and on command-not-found, and
 * a validation refusal is neither, so the session would simply lose its report.
 */
function v1Payload(): Record<string, unknown> {
  const payload = examplePayload();
  payload.schemaVersion = 1;
  delete payload.nextStep;
  delete payload.deviations;
  payload.asks = (payload.asks as Record<string, unknown>[]).map(
    (ask, index) => {
      const {priority, ...rest} = ask;
      void priority;
      return {...rest, blocking: index === 0};
    },
  );
  return payload;
}

describe('v1 payloads still validate, and say that they were migrated', () => {
  test('blocking true → P0, blocking false → P3', () => {
    const result = validateThreadReport(v1Payload());
    if (result.status !== 'ok') {
      throw new Error(`v1 payload refused:\n${result.issues.join('\n')}`);
    }
    expect(result.payload.asks.map((ask) => ask.priority)).toEqual([0, 3]);
  });

  test('the migration is REPORTED, never silent', () => {
    const migrated = validateThreadReport(v1Payload());
    const current = validateThreadReport(examplePayload());
    if (migrated.status !== 'ok' || current.status !== 'ok') {
      throw new Error('unreachable');
    }
    // A migrated payload is a different claim from the one that was written:
    // its empty `deviations` was never checked by anybody. `thread report`
    // prints this, so the empty section is not read as a clean bill of health.
    expect(migrated.migratedFrom).toBe(1);
    expect(current.migratedFrom).toBe(null);
  });

  test('nextStep defaults to the value that claims nothing', () => {
    const result = validateThreadReport(v1Payload());
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.payload.nextStep).toBe('continue');
    expect(result.payload.deviations).toEqual([]);
    expect(result.payload.schemaVersion).toBe(THREAD_SCHEMA_VERSION);
  });

  test('a payload that CLAIMS v2 but carries blocking is refused, not guessed at', () => {
    // The migration runs on a declared older version only. A v2 payload with a
    // stray `blocking` is a mistake in something Claude just wrote against the
    // printed skeleton, and naming the key is the whole point of the strict
    // schema — silently repairing it would hide a real drift between the
    // skeleton and what the model produces.
    const payload = v1Payload();
    payload.schemaVersion = THREAD_SCHEMA_VERSION;
    const result = validateThreadReport(payload);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.issues.join('\n')).toContain('blocking');
  });
});
