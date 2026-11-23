/**
 * mac-build.ts may start a signing step only behind the signing guard
 * (home-base-di8c7.1, D7).
 *
 * This reads the SOURCE of mac-build.ts, because the steps it guards (xcodebuild
 * and Xcode's AppleScript build) cannot run in a test. It fails when:
 *
 *  A. the literal 'xcodebuild' appears outside runXcodebuild (an execFileSync,
 *     an `xcrun xcodebuild`, a constant someone spawns later);
 *  B. a spawning call (execFileSync, spawnSync, runInherit, Bun.spawn, …)
 *     outside runXcodebuild mentions xcodebuild in its arguments, as a shell
 *     string or a template;
 *  C. runXcodebuild's FIRST statement is not the guard call, or it no longer
 *     spawns xcodebuild itself;
 *  D. buildAndLaunchWithXcode's FIRST statement is not the guard call;
 *  E. buildWithXcodebuild or readBuiltProductsDir stops calling runXcodebuild;
 *  F. assertUnlockedForSigning is not the one imported from ./signing-guard
 *     (a local function of that name would pass C and D and guard nothing);
 *  G. Xcode's build-and-run step (home-base-0jeya.13 split it from the open):
 *     xcodeBuildAndRun's FIRST statement is not the guard call, or
 *     buildAndLaunchWithXcode stops calling it, or an AppleScript that builds
 *     or runs (a line `build <doc>`, `set <x> to build <doc>` or `run <doc>`)
 *     appears outside it, or the app's running pids are read outside it (they
 *     must be read after its guard has returned, not before a wait).
 *
 * "The guard call" is an expression statement calling the guard, or a `const`
 * whose initializer is that call: both run it first and unconditionally.
 *
 * The negative controls below edit the real file's text one way each and expect
 * the matching rule to fire, so a check that stops checking fails here.
 */

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import ts from 'typescript';

const MAC_BUILD = resolve(import.meta.dir, '..', 'src', 'mac-build.ts');
const SOURCE = readFileSync(MAC_BUILD, 'utf8');

const GUARD = 'assertUnlockedForSigning';
const HELPER = 'runXcodebuild';
const XCODE_RUN = 'buildAndLaunchWithXcode';
const XCODE_BUILD = 'xcodeBuildAndRun';
const PIDS = 'runningAppPids';
/**
 * Functions that may read the app's pids: the build step, the launch wait it
 * feeds, and the exit wait before a close (which no launch check depends on).
 */
const PID_READERS = new Set([
  XCODE_BUILD,
  'waitForAppToExit',
  'waitForNewAppInstance',
]);
const HELPER_CALLERS = ['buildWithXcodebuild', 'readBuiltProductsDir'];
/** An AppleScript line that builds or runs a document. */
const XCODE_BUILD_LINE = /^\s*(?:set \w+ to )?build \w+\s*$|^\s*run \w+\s*$/m;
const SPAWNERS = new Set([
  'Bun.spawn',
  'Bun.spawnSync',
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'runInherit',
  'spawn',
  'spawnSync',
]);
const SHELL_TAGS = new Set(['$', 'Bun.$']);

function literalTexts(node: ts.Node): string[] {
  const texts: string[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isStringLiteral(child) ||
      ts.isNoSubstitutionTemplateLiteral(child) ||
      ts.isTemplateHead(child) ||
      ts.isTemplateMiddle(child) ||
      ts.isTemplateTail(child)
    ) {
      texts.push(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return texts;
}

function mentionsXcodebuild(node: ts.Node): boolean {
  return literalTexts(node).some((text) => /\bxcodebuild\b/.test(text));
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let at = node.parent; at != null; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name != null) return at.name.text;
  }
  return null;
}

function isGuardCallExpression(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): boolean {
  return (
    expression != null &&
    ts.isCallExpression(expression) &&
    expression.expression.getText(source) === GUARD
  );
}

function isGuardCall(
  statement: ts.Statement | undefined,
  source: ts.SourceFile,
): boolean {
  if (statement == null) return false;
  if (ts.isExpressionStatement(statement)) {
    return isGuardCallExpression(statement.expression, source);
  }
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    return (
      declarations.length === 1 &&
      isGuardCallExpression(declarations[0]?.initializer, source)
    );
  }
  return false;
}

function callsFunction(
  fn: ts.Node | undefined,
  name: string,
  source: ts.SourceFile,
): boolean {
  let calls = false;
  const find = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === name) {
      calls = true;
    }
    ts.forEachChild(node, find);
  };
  if (fn != null) find(fn);
  return calls;
}

/** Every rule this source breaks, one line each; empty when it breaks none. */
function signingGuardViolations(text: string): string[] {
  const source = ts.createSourceFile(
    'mac-build.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const functions = new Map<string, ts.FunctionDeclaration>();
  let guardImported = false;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      functions.set(statement.name.text, statement);
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === './signing-guard'
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings != null && ts.isNamedImports(bindings)) {
        guardImported = bindings.elements.some(
          (element) =>
            element.name.text === GUARD &&
            (element.propertyName?.text ?? GUARD) === GUARD,
        );
      }
    }
  }

  let helperSpawnsXcodebuild = false;
  const visit = (node: ts.Node): void => {
    const inside = enclosingFunctionName(node);
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'xcodebuild' &&
      inside !== HELPER
    ) {
      violations.push(
        `A: line ${lineOf(node)} has the literal 'xcodebuild' outside ${HELPER}`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (SPAWNERS.has(callee) && node.arguments.some(mentionsXcodebuild)) {
        if (inside === HELPER) helperSpawnsXcodebuild = true;
        else {
          violations.push(
            `B: line ${lineOf(node)} spawns xcodebuild with ${callee} outside ${HELPER}`,
          );
        }
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      SHELL_TAGS.has(node.tag.getText(source)) &&
      mentionsXcodebuild(node.template) &&
      inside !== HELPER
    ) {
      violations.push(
        `B: line ${lineOf(node)} spawns xcodebuild through a shell template outside ${HELPER}`,
      );
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      XCODE_BUILD_LINE.test(node.text) &&
      inside !== XCODE_BUILD
    ) {
      violations.push(
        `G: line ${lineOf(node)} has an AppleScript build or run outside ${XCODE_BUILD}`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === PIDS &&
      (inside == null || !PID_READERS.has(inside))
    ) {
      violations.push(
        `G: line ${lineOf(node)} reads the app's pids outside ${XCODE_BUILD}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const helper = functions.get(HELPER);
  if (helper?.body == null) {
    violations.push(`C: there is no function ${HELPER}`);
  } else {
    if (!isGuardCall(helper.body.statements[0], source)) {
      violations.push(`C: the first statement of ${HELPER} is not ${GUARD}(…)`);
    }
    if (!helperSpawnsXcodebuild) {
      violations.push(`C: ${HELPER} does not spawn xcodebuild itself`);
    }
  }

  const xcodeRun = functions.get(XCODE_RUN);
  if (xcodeRun?.body == null) {
    violations.push(`D: there is no function ${XCODE_RUN}`);
  } else if (!isGuardCall(xcodeRun.body.statements[0], source)) {
    violations.push(
      `D: the first statement of ${XCODE_RUN} is not ${GUARD}(…)`,
    );
  }

  for (const name of HELPER_CALLERS) {
    if (!callsFunction(functions.get(name), HELPER, source)) {
      violations.push(`E: ${name} does not call ${HELPER}`);
    }
  }

  const xcodeBuild = functions.get(XCODE_BUILD);
  if (xcodeBuild?.body == null) {
    violations.push(`G: there is no function ${XCODE_BUILD}`);
  } else {
    if (!isGuardCall(xcodeBuild.body.statements[0], source)) {
      violations.push(
        `G: the first statement of ${XCODE_BUILD} is not ${GUARD}(…)`,
      );
    }
    if (!callsFunction(xcodeBuild, PIDS, source)) {
      violations.push(`G: ${XCODE_BUILD} does not read the app's pids`);
    }
  }
  if (!callsFunction(xcodeRun, XCODE_BUILD, source)) {
    violations.push(`G: ${XCODE_RUN} does not call ${XCODE_BUILD}`);
  }

  if (!guardImported) {
    violations.push(`F: ${GUARD} is not imported from './signing-guard'`);
  }
  if (functions.has(GUARD)) {
    violations.push(`F: mac-build.ts declares its own ${GUARD}`);
  }

  return violations;
}

/** expect.stringMatching, typed for a string[] comparison. */
function matching(pattern: RegExp): string {
  return expect.stringMatching(pattern) as unknown as string;
}

/** SOURCE with one edit; fails if the text to edit is gone (a stale control). */
function edited(search: string | RegExp, replacement: string): string {
  if (typeof search === 'string') expect(SOURCE).toContain(search);
  else expect(SOURCE).toMatch(search);
  const out = SOURCE.replace(search, replacement);
  expect(out).not.toBe(SOURCE);
  return out;
}

describe('mac-build.ts starts every signing step behind the guard', () => {
  test('the real file breaks no rule', () => {
    expect(signingGuardViolations(SOURCE)).toEqual([]);
  });
});

describe('negative controls: each edit of the real file breaks its rule', () => {
  const HELPER_GUARD_LINE =
    '  const signing = assertUnlockedForSigning({what});\n';
  const XCODE_GUARD =
    /\n {2}const openSigning = assertUnlockedForSigning\(\{\n {4}what: `Xcode's opening of the \$\{workspace\.scheme\} workspace`,\n {2}\}\);/;
  const BUILD_GUARD =
    /\n {2}const signing = assertUnlockedForSigning\(\{\n {4}what: `Xcode's build and run of \$\{workspace\.scheme\}`,\n {2}\}\);/;
  const BUILD_PIDS = '  const pidsBefore = runningAppPids(workspace.scheme);\n';

  test('A and B: a direct execFileSync of xcodebuild elsewhere', () => {
    const violations = signingGuardViolations(
      `${SOURCE}\nfunction sneaky(): void {\n  execFileSync('xcodebuild', ['-version']);\n}\n`,
    );
    expect(violations.some((line) => line.startsWith('A: '))).toBe(true);
    expect(violations.some((line) => line.startsWith('B: '))).toBe(true);
  });

  test('B: xcodebuild in a shell string or a Bun.$ template', () => {
    expect(
      signingGuardViolations(
        `${SOURCE}\nfunction sneaky(): void {\n  execSync(\`xcodebuild -version\`);\n}\n`,
      ),
    ).toEqual([matching(/^B: .* with execSync outside/)]);
    expect(
      signingGuardViolations(
        `${SOURCE}\nasync function sneaky(): Promise<void> {\n  await Bun.$\`xcodebuild -version\`;\n}\n`,
      ),
    ).toEqual([matching(/^B: .*shell template/)]);
  });

  test('A: xcodebuild through xcrun', () => {
    expect(
      signingGuardViolations(
        `${SOURCE}\nfunction sneaky(): void {\n  spawnSync('xcrun', ['xcodebuild', '-version']);\n}\n`,
      ),
    ).toEqual([
      // The call is visited before the literal inside it.
      matching(/^B: .* with spawnSync outside/),
      matching(/^A: /),
    ]);
  });

  test('C: the guard call removed from the helper', () => {
    expect(signingGuardViolations(edited(HELPER_GUARD_LINE, ''))).toEqual([
      `C: the first statement of ${HELPER} is not ${GUARD}(…)`,
    ]);
  });

  test('C: the guard call moved after the spawn', () => {
    const removed = edited(HELPER_GUARD_LINE, '');
    const spawnReturn =
      "    return {signingWaitSeconds, status: 'ok', stdout: ''};\n";
    expect(removed).toContain(spawnReturn);
    const moved = removed.replace(
      spawnReturn,
      `    assertUnlockedForSigning({what});\n${spawnReturn}`,
    );
    expect(signingGuardViolations(moved)).toEqual([
      `C: the first statement of ${HELPER} is not ${GUARD}(…)`,
    ]);
  });

  test('C: a const guard that is only conditionally the guard', () => {
    expect(
      signingGuardViolations(
        edited(
          HELPER_GUARD_LINE,
          "  const signing = what !== '' ? assertUnlockedForSigning({what}) : {checked: false};\n",
        ),
      ),
    ).toEqual([`C: the first statement of ${HELPER} is not ${GUARD}(…)`]);
  });

  test('C: the guard call made conditional', () => {
    expect(
      signingGuardViolations(
        edited(
          HELPER_GUARD_LINE,
          "  if (what !== '') assertUnlockedForSigning({what});\n",
        ),
      ),
    ).toEqual([`C: the first statement of ${HELPER} is not ${GUARD}(…)`]);
  });

  test('D: the guard call removed from the Xcode open-and-build entry', () => {
    expect(signingGuardViolations(edited(XCODE_GUARD, ''))).toEqual([
      `D: the first statement of ${XCODE_RUN} is not ${GUARD}(…)`,
    ]);
  });

  test('G: the guard call removed from the Xcode build-and-run step', () => {
    expect(signingGuardViolations(edited(BUILD_GUARD, ''))).toEqual([
      `G: the first statement of ${XCODE_BUILD} is not ${GUARD}(…)`,
    ]);
  });

  test('G: the build step no longer called from the entry', () => {
    expect(
      signingGuardViolations(
        edited(
          '  const run = xcodeBuildAndRun(workspace);\n',
          '  const run = otherBuild(workspace);\n',
        ),
      ),
    ).toEqual([`G: ${XCODE_RUN} does not call ${XCODE_BUILD}`]);
  });

  test("G: the app's pids read before the guard, in macBuild", () => {
    const anchor = '  const xcodeRun = buildAndLaunchWithXcode(\n';
    expect(SOURCE).toContain(anchor);
    const moved = edited(BUILD_PIDS, '').replace(
      anchor,
      `${BUILD_PIDS}${anchor}`,
    );
    expect(signingGuardViolations(moved)).toEqual([
      matching(/^G: line \d+ reads the app's pids outside xcodeBuildAndRun$/),
      `G: ${XCODE_BUILD} does not read the app's pids`,
    ]);
  });

  test('G: an AppleScript build outside the guarded step', () => {
    expect(
      signingGuardViolations(
        `${SOURCE}\nfunction sneaky(): string {\n  return osascript(\`\ntell application "Xcode"\n    set r to build theDoc\nend tell\n\`, 'x');\n}\n`,
      ),
    ).toEqual([
      matching(/^G: line \d+ has an AppleScript build or run outside/),
    ]);
    expect(
      signingGuardViolations(
        `${SOURCE}\nfunction sneaky(): string {\n  return osascript('tell application "Xcode"\\n    run theDoc\\nend tell', 'x');\n}\n`,
      ),
    ).toEqual([
      matching(/^G: line \d+ has an AppleScript build or run outside/),
    ]);
  });

  test('E: the build-settings query stops going through the helper', () => {
    const bypassed = edited(
      'const run = runXcodebuild(\n    projectRoot,\n    `the xcodebuild build-settings query',
      'const run = otherRunner(\n    projectRoot,\n    `the xcodebuild build-settings query',
    );
    expect(signingGuardViolations(bypassed)).toEqual([
      `E: readBuiltProductsDir does not call ${HELPER}`,
    ]);
  });

  test('F: a local function shadows the guard', () => {
    const shadowed = edited(
      'import {\n  assertUnlockedForSigning,\n  formatWait,',
      'import {\n  formatWait,',
    );
    expect(
      signingGuardViolations(
        `${shadowed}\nfunction assertUnlockedForSigning(_options: {what: string}): void {}\n`,
      ),
    ).toEqual([
      `F: ${GUARD} is not imported from './signing-guard'`,
      `F: mac-build.ts declares its own ${GUARD}`,
    ]);
  });
});
