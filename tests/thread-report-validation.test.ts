/**
 * `thread report` accepts `do` for `act`, and a refusal teaches
 * (home-base-pp1vx.12 part 1, Justin's approval 2026-10-20).
 *
 * The friction research found 111 refused payloads across 65 sessions, and 66
 * of the bad asks in the ones whose text could be recovered said `do` where the
 * schema says `act`. Two things are proven here, each with a negative control
 * recorded on the bead:
 *
 *  - `do` is corrected quietly and NOTHING ELSE is: every other near miss that
 *    sessions have written (`fyi`, `doc`, `decided`) is still refused, and a
 *    prototype key like `toString` cannot sneak through the alias table.
 *  - a refusal names the field, the value given and the allowed values, and
 *    `runThreadReport` prints a payload that validates under it.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {runThreadReport} from '../src/thread/report';
import {
  minimalPayloadExample,
  normalizeNearMisses,
  THREAD_SCHEMA_VERSION,
  validateThreadReport,
} from '../src/thread/schema';

/**
 * A payload the tests may break on purpose: the keys they touch are typed, so
 * writing a bad value into one is a plain assignment.
 */
interface LoosePayload {
  asks: Record<string, unknown>[];
  beadsTouched: unknown;
  deviations: unknown;
  nextStep?: unknown;
  priorAsks?: unknown;
  schemaVersion: unknown;
  workProduct: Record<string, unknown>;
}

/** The smallest valid payload, as a mutable object. */
function basePayload(): LoosePayload {
  return JSON.parse(minimalPayloadExample()) as LoosePayload;
}

function ask0(payload: LoosePayload): Record<string, unknown> {
  const ask = payload.asks[0];
  if (ask === undefined) throw new Error('the base payload has no ask');
  return ask;
}

function issuesOf(payload: unknown): string {
  const result = validateThreadReport(payload);
  if (result.status !== 'invalid') {
    throw new Error('expected the payload to be refused');
  }
  return result.issues.join('\n');
}

describe('`do` is accepted as `act`', () => {
  test('an ask of kind "do" validates and is stored as "act"', () => {
    const payload = basePayload();
    ask0(payload).kind = 'do';
    const result = validateThreadReport(payload);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.payload.asks[0]?.kind).toBe('act');
  });

  test('the correction is SILENT: no migration is recorded and no note is printed', () => {
    const payload = basePayload();
    ask0(payload).kind = 'do';
    const result = validateThreadReport(payload);
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.migratedFrom).toBeNull();
    expect(result.migrationNotes).toEqual([]);
    expect(result.keepOpenAskIds).toEqual([]);
  });

  test('the input payload is not mutated', () => {
    const payload = basePayload();
    ask0(payload).kind = 'do';
    normalizeNearMisses(payload);
    validateThreadReport(payload);
    expect(ask0(payload).kind).toBe('do');
  });

  test('every ask in the list is corrected, and the others are left alone', () => {
    const payload = basePayload();
    payload.asks = [
      {...payload.asks[0], kind: 'do'},
      {...payload.asks[0], kind: 'approve'},
      {...payload.asks[0], kind: 'do'},
    ];
    const result = validateThreadReport(payload);
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.payload.asks.map((ask) => ask.kind)).toEqual([
      'act',
      'approve',
      'act',
    ]);
  });

  test('an older payload that also says "do" is migrated and corrected', () => {
    const payload = basePayload();
    payload.schemaVersion = 2;
    ask0(payload).kind = 'do';
    const result = validateThreadReport(payload);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.migratedFrom).toBe(2);
    expect(result.payload.asks[0]?.kind).toBe('act');
  });
});

describe('`doc` is accepted as `docs` and `judgment` as `judgmentCall` (pp1vx.16 item 5)', () => {
  test('workProduct.kind "doc" validates and is stored as "docs"', () => {
    const payload = basePayload();
    payload.workProduct.kind = 'doc';
    const result = validateThreadReport(payload);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.payload.workProduct.kind).toBe('docs');
    expect(result.migrationNotes).toEqual([]);
  });

  test('every deviation of kind "judgment" becomes "judgmentCall", the others are left alone', () => {
    const payload = basePayload();
    payload.deviations = [
      {kind: 'judgment', text: 'I chose X'},
      {kind: 'fyi', text: 'tabs'},
      {kind: 'judgment', text: 'I chose Y'},
    ];
    const result = validateThreadReport(payload);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.payload.deviations.map((d) => d.kind)).toEqual([
      'judgmentCall',
      'fyi',
      'judgmentCall',
    ]);
  });

  test('the input payload is not mutated', () => {
    const payload = basePayload();
    payload.workProduct.kind = 'doc';
    const deviations = [{kind: 'judgment', text: 'I chose X'}];
    payload.deviations = deviations;
    normalizeNearMisses(payload);
    expect(payload.workProduct.kind).toBe('doc');
    expect(deviations[0]?.kind).toBe('judgment');
  });

  test('a payload with nothing to correct comes back as the same object', () => {
    const payload = basePayload();
    expect(normalizeNearMisses(payload)).toBe(payload);
  });
});

describe('nothing else is loosened', () => {
  // Each of these is a value sessions really wrote (counted over every
  // transcript on this machine, 2026-10-20) and each is ambiguous, so each
  // stays an error that names it.
  test('an ask of kind "fyi" is still refused', () => {
    const payload = basePayload();
    ask0(payload).kind = 'fyi';
    expect(issuesOf(payload)).toContain('asks.0.kind');
  });

  test('"Do" and "DO" are still refused: the alias is one exact spelling', () => {
    for (const kind of ['Do', 'DO', 'do ']) {
      const payload = basePayload();
      ask0(payload).kind = kind;
      expect(issuesOf(payload)).toContain('asks.0.kind');
    }
  });

  test('a prototype key cannot ride through the alias table', () => {
    for (const kind of ['toString', 'constructor', '__proto__']) {
      const payload = basePayload();
      ask0(payload).kind = kind;
      expect(issuesOf(payload)).toContain('asks.0.kind');
    }
  });

  test('workProduct.kind "plan", deviations kind "Judgment" and priorAsks "decided" are still refused', () => {
    const plan = basePayload();
    plan.workProduct.kind = 'plan';
    expect(issuesOf(plan)).toContain('workProduct.kind');

    const judgment = basePayload();
    judgment.deviations = [{kind: 'Judgment', text: 'I chose X'}];
    expect(issuesOf(judgment)).toContain('deviations.0.kind');

    const decided = basePayload();
    decided.priorAsks = [
      {detail: 'took the default', disposition: 'decided', id: 'x.1'},
    ];
    expect(issuesOf(decided)).toContain('priorAsks.0.disposition');
  });

  test('a missing options[].recommended is still refused', () => {
    const payload = basePayload();
    ask0(payload).kind = 'pick';
    ask0(payload).options = [{text: 'Option one'}];
    expect(issuesOf(payload)).toContain('asks.0.options.0.recommended');
  });
});

describe('a refusal names the field, the value given and the allowed values', () => {
  test('a bad ask kind shows what was written and all four kinds', () => {
    const payload = basePayload();
    ask0(payload).kind = 'fyi';
    const text = issuesOf(payload);
    expect(text).toContain('asks.0.kind: got "fyi"');
    for (const allowed of ['"approve"', '"pick"', '"answer"', '"act"']) {
      expect(text).toContain(allowed);
    }
  });

  test('a bad work-product kind shows what was written and what is allowed', () => {
    const payload = basePayload();
    payload.workProduct.kind = 'plan';
    const text = issuesOf(payload);
    expect(text).toContain('workProduct.kind: got "plan"');
    expect(text).toContain('"docs"');
  });

  test('a bad priority shows the number and the five allowed ones', () => {
    const payload = basePayload();
    ask0(payload).priority = 7;
    const text = issuesOf(payload);
    expect(text).toContain('asks.0.priority: got 7');
    expect(text).toContain('0 | 1 | 2 | 3 | 4');
  });

  test('a MISSING enum field says it is missing rather than "got undefined"', () => {
    const payload = basePayload();
    delete payload.nextStep;
    const text = issuesOf(payload);
    expect(text).toContain('nextStep: got nothing (the field is missing)');
    expect(text).not.toContain('undefined');
  });

  test('a wrong-typed value shows the value it was given', () => {
    const payload = basePayload();
    payload.beadsTouched = ['z36o'];
    expect(issuesOf(payload)).toContain('(value given: "z36o")');
  });

  test('a long value is cut short', () => {
    const payload = basePayload();
    payload.workProduct.kind = 'x'.repeat(500);
    const text = issuesOf(payload);
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(600);
  });
});

describe('the minimal example', () => {
  test('validates, so a refusal never prints a payload the tool would also refuse', () => {
    const result = validateThreadReport(JSON.parse(minimalPayloadExample()));
    if (result.status !== 'ok') {
      throw new Error(
        `the example does not validate:\n${result.issues.join('\n')}`,
      );
    }
    expect(result.status).toBe('ok');
  });

  test('shows an ask of kind "act", the spelling sessions most often got wrong', () => {
    const example = JSON.parse(minimalPayloadExample()) as LoosePayload;
    expect(ask0(example).kind).toBe('act');
  });
});

/** Run `thread report` against a payload file and capture what it printed. */
async function runReport(
  payload: unknown,
): Promise<{exitCode: number; stderr: string}> {
  const dir = mkdtempSync(join(tmpdir(), 'thread-report-validation-'));
  const file = join(dir, 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  let stderr = '';
  const realError = console.error;
  const realLog = console.log;
  console.error = (...parts: unknown[]) => {
    stderr += `${parts.map(String).join(' ')}\n`;
  };
  console.log = () => undefined;
  try {
    const exitCode = await runThreadReport({
      autoCommit: false,
      cwd: dir,
      env: {},
      file,
      sessionId: null,
    });
    return {exitCode, stderr};
  } finally {
    console.error = realError;
    console.log = realLog;
  }
}

describe('thread report, end to end up to the first write', () => {
  test('a refused payload prints the issue, then a minimal payload that validates, then the prepare pointer', async () => {
    const payload = basePayload();
    ask0(payload).kind = 'fyi';
    const {exitCode, stderr} = await runReport(payload);
    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      'the payload does not validate. Nothing was written.',
    );
    expect(stderr).toContain('asks.0.kind: got "fyi"');
    expect(stderr).toContain('A minimal payload that validates:');
    expect(stderr).toContain('thread prepare');

    // The printed example is real: pull it back out and validate it.
    expect(stderr).toContain(`"schemaVersion": ${THREAD_SCHEMA_VERSION}`);
    const start = stderr.indexOf('{\n');
    const end = stderr.lastIndexOf('\n}') + 2;
    const printed = JSON.parse(stderr.slice(start, end)) as unknown;
    expect(validateThreadReport(printed).status).toBe('ok');
  });

  test('a payload that says "do" gets past validation (it stops later, at the missing session id)', async () => {
    const payload = basePayload();
    ask0(payload).kind = 'do';
    const {exitCode, stderr} = await runReport(payload);
    expect(stderr).not.toContain('does not validate');
    expect(stderr).toContain('no session id');
    expect(exitCode).toBe(2);
  });
});
