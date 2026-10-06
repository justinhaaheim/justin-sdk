/**
 * The ONE hook-output helper (home-base-39co9.4, M3): every Claude-bound text is
 * mirrored to Justin, and no SDK source builds hook JSON around it.
 *
 * Two halves:
 *  - the helper's own contract — verbatim mirror up to MIRROR_MAX_LINES, a
 *    pointer to the rest beyond it, the 10,000-character cap said out loud,
 *    nothing printed when there is nothing to say;
 *  - a walk over every SDK source file that FAILS when anything outside
 *    `src/hook-output.ts` spells `additionalContext`, `hookSpecificOutput` or a
 *    `decision: 'block'` as an object key. That is what makes "every hook
 *    mirrors" a property of the codebase rather than of today's five callers.
 *    It reads the TypeScript AST, not text, so prose in comments and config
 *    descriptions that MENTIONS those fields does not trip it.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-39co9.4): adding
 * `console.log(JSON.stringify({hookSpecificOutput: {additionalContext: 'x',
 * hookEventName: 'UserPromptSubmit'}}))` to src/time-check.ts fails "no SDK
 * source builds hook JSON outside the helper" naming that file; removing it
 * passes again.
 */

import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync, statSync} from 'fs';
import {join, relative, resolve} from 'path';
import ts from 'typescript';

import {
  CLAUDE_CODE_HOOK_TEXT_CAP,
  hookOutputJson,
  MIRROR_MAX_LINES,
  mirrorForJustin,
  renderHookOutput,
  stopBlockJson,
} from '../src/hook-output';

const ESC = String.fromCharCode(27);

function lines(n: number): string {
  return Array.from({length: n}, (_, i) => `line ${i + 1}`).join('\n');
}

describe('mirrorForJustin', () => {
  test('a payload of up to MIRROR_MAX_LINES lines is mirrored byte for byte', () => {
    const text = lines(MIRROR_MAX_LINES);
    expect(mirrorForJustin(text, 'bun run justin-sdk x')).toBe(text);
  });

  test('a longer payload shows its first lines and how to print the rest', () => {
    const text = lines(MIRROR_MAX_LINES + 7);
    const mirror = mirrorForJustin(text, 'bun run justin-sdk repo-state');
    expect(mirror.split('\n')).toHaveLength(MIRROR_MAX_LINES + 1);
    expect(mirror).toContain(`line ${MIRROR_MAX_LINES}`);
    expect(mirror).not.toContain(`line ${MIRROR_MAX_LINES + 1}`);
    expect(mirror.split('\n').at(-1)).toBe(
      '(7 more lines; print them with `bun run justin-sdk repo-state`)',
    );
  });

  test('with no command to name, the cut still says so', () => {
    const mirror = mirrorForJustin(lines(MIRROR_MAX_LINES + 2));
    expect(mirror.split('\n').at(-1)).toBe(
      '(2 more lines, sent to Claude and not shown here)',
    );
  });

  test('over the 10,000-character cap, Justin is told Claude got a file instead', () => {
    const text = 'x'.repeat(CLAUDE_CODE_HOOK_TEXT_CAP + 1);
    expect(mirrorForJustin(text)).toContain('2,000-character preview');
    expect(
      mirrorForJustin('x'.repeat(CLAUDE_CODE_HOOK_TEXT_CAP)),
    ).not.toContain('preview');
  });

  test('nothing to mirror is nothing', () => {
    expect(mirrorForJustin('')).toBe('');
    expect(mirrorForJustin('\n\n')).toBe('');
  });
});

describe('hookOutputJson', () => {
  test('Claude-bound text alone: systemMessage IS the mirror', () => {
    const json = hookOutputJson({
      event: 'UserPromptSubmit',
      forClaude: '[Automated Time Check] It is late.',
    });
    expect(json).toEqual({
      hookSpecificOutput: {
        additionalContext: '[Automated Time Check] It is late.',
        hookEventName: 'UserPromptSubmit',
      },
      systemMessage: '[Automated Time Check] It is late.',
    });
  });

  test('Justin-only text alone: no hookSpecificOutput at all', () => {
    const json = hookOutputJson({
      event: 'SessionStart',
      forClaude: '',
      forJustin: 'justin-sdk session-start · ok',
    });
    expect(json).toEqual({systemMessage: 'justin-sdk session-start · ok'});
  });

  test('both: Justin’s text, then a marked mirror of exactly what Claude got', () => {
    const json = hookOutputJson({
      event: 'SessionStart',
      forClaude: 'RULE ONE\nRULE TWO',
      forJustin: 'header',
    });
    expect(json?.hookSpecificOutput?.additionalContext).toBe(
      'RULE ONE\nRULE TWO',
    );
    expect(json?.systemMessage).toBe(
      'header\n\n↓ also sent to Claude (2 lines):\nRULE ONE\nRULE TWO',
    );
  });

  test('nothing to say prints nothing', () => {
    expect(hookOutputJson({event: 'SessionStart', forClaude: ''})).toBeNull();
    expect(renderHookOutput({event: 'SessionStart', forClaude: '  '})).toBe('');
  });

  test('ANSI is stripped from both halves', () => {
    const json = hookOutputJson({
      event: 'SessionStart',
      forClaude: `${ESC}[32m✓${ESC}[0m ok`,
      forJustin: `${ESC}[31m✗${ESC}[0m bad`,
    });
    expect(JSON.stringify(json)).not.toContain(ESC);
    expect(json?.hookSpecificOutput?.additionalContext).toBe('✓ ok');
  });

  test('the output is one JSON object and a newline', () => {
    const out = renderHookOutput({event: 'Stop', forClaude: 'x'});
    expect(out.endsWith('}\n')).toBe(true);
    expect(JSON.parse(out) as unknown).toEqual(
      hookOutputJson({event: 'Stop', forClaude: 'x'}),
    );
  });
});

describe('stopBlockJson', () => {
  test('is exactly the JSON stop-check printed before the helper existed', () => {
    const reason = 'Run `bun run justin-sdk thread prepare` first.';
    expect(JSON.stringify(stopBlockJson(reason))).toBe(
      JSON.stringify({decision: 'block', reason, systemMessage: reason}),
    );
  });
});

// ---------------------------------------------------------------------------
// AC4: nothing outside the helper builds hook JSON
// ---------------------------------------------------------------------------

const SDK_ROOT = resolve(import.meta.dirname, '..');
const HELPER = join(SDK_ROOT, 'src', 'hook-output.ts');
const SCANNED_DIRS = ['src', 'scripts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const HOOK_KEYS = new Set(['additionalContext', 'hookSpecificOutput']);

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Every place a file builds hook JSON by hand: an object-literal key
 * `additionalContext` / `hookSpecificOutput`, a `decision` key whose value is
 * the string 'block', or a string literal that spells either field as a JSON
 * key (a hand-written `'{"additionalContext": …}'`).
 */
function handBuiltHookJson(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const where = (node: ts.Node): string => {
    const {line} = source.getLineAndCharacterOfPosition(node.getStart());
    return `${relative(SDK_ROOT, file)}:${line + 1}`;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = propertyName(node.name);
      if (name != null && HOOK_KEYS.has(name)) {
        found.push(`${where(node)} builds \`${name}\``);
      }
      if (
        name === 'decision' &&
        ts.isPropertyAssignment(node) &&
        ts.isStringLiteralLike(node.initializer) &&
        node.initializer.text === 'block'
      ) {
        found.push(`${where(node)} builds \`decision: 'block'\``);
      }
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      /"(additionalContext|hookSpecificOutput)"\s*:/.test(node.getText(source))
    ) {
      found.push(`${where(node)} spells hook JSON in a string`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no SDK source builds hook JSON outside the helper', () => {
  test('the scanner catches each way of building it (positive controls)', () => {
    const cases = [
      "console.log(JSON.stringify({hookSpecificOutput: {additionalContext: 'x', hookEventName: 'Stop'}}));",
      "const out = {decision: 'block', reason: 'r'};",
      'const additionalContext = 1; const o = {additionalContext};',
      `process.stdout.write('{"additionalContext": "x"}');`,
    ];
    for (const code of cases) {
      expect(handBuiltHookJson('/x/case.ts', code).length).toBeGreaterThan(0);
    }
    // …and leaves alone what merely MENTIONS the fields: a comment, a type, a
    // description string, and a `decision` that is not a block.
    const benign = [
      '// emits additionalContext and hookSpecificOutput',
      'interface X { additionalContext?: string; decision: string }',
      "const d = 'the `additionalContext` field goes to the model';",
      "const o = {decision: 'pass'};",
      'const v = parsed.hookSpecificOutput?.additionalContext;',
    ];
    for (const code of benign) {
      expect(handBuiltHookJson('/x/case.ts', code)).toEqual([]);
    }
  });

  test('every file under src/ and scripts/ goes through src/hook-output.ts', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(join(SDK_ROOT, dir))) {
        if (file === HELPER) continue;
        offenders.push(...handBuiltHookJson(file, readFileSync(file, 'utf-8')));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the helper itself is where the fields are built (the scan is not vacuous)', () => {
    expect(
      handBuiltHookJson(HELPER, readFileSync(HELPER, 'utf-8')).length,
    ).toBeGreaterThan(0);
  });
});
