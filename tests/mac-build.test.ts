/**
 * Tests for the parts of mac-build.ts that run without Xcode
 * (home-base-0jeya.1): the scheme patch, the APP_VARIANT pin, the guard against
 * `expo prebuild --clean` in a repo that commits ios/, the flag check, the
 * config failure path, and `--variant` (home-base-0jeya.9) through the real CLI
 * as far as each path goes before it would need Xcode. The Xcode-driving half is
 * exercised only by a real `bun run build:mac` in an app repo.
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';
import ts from 'typescript';

import {
  assertIosNotTracked,
  assertSigningTeam,
  closeWorkspaceScript,
  configureLaunchAction,
  conflictingOptions,
  loadWaitDialogCheck,
  MAC_BUILD_PROBLEMS_PATH,
  pinVariantForXcodeBuildPhases,
  runMacBuild,
  startBuildTimer,
  stopWorkspaceAppScript,
} from '../src/mac-build';
import {workspacePollScript} from '../src/mac-build-xcode';
import {MAC_BUILD_PROBLEMS_COMMAND} from '../src/mac-build-xcode-dialog';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, {force: true, recursive: true});
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsdk-mac-build-'));
  roots.push(root);
  return root;
}

const SCHEME = 'ExampleAppPreview';

/**
 * The shape Expo generates: Debug on Test, Launch and Analyze; Release on
 * Archive. The LaunchAction attributes are copied from health-logger-rn's
 * generated scheme (2026-10-24).
 */
const SCHEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1130" version = "1.3">
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      allowLocationSimulation = "YES">
   </LaunchAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

function writeScheme(root: string): string {
  const dir = join(
    root,
    'ios',
    `${SCHEME}.xcodeproj`,
    'xcshareddata',
    'xcschemes',
  );
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `${SCHEME}.xcscheme`);
  writeFileSync(path, SCHEME_XML);
  return path;
}

/** SCHEME_XML with the LaunchAction set to `configuration` and no debugger. */
function expectedLaunchAction(configuration: string): string {
  return SCHEME_XML.replace(
    `<LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"`,
    `<LaunchAction
      buildConfiguration = "${configuration}"
      selectedDebuggerIdentifier = ""
      selectedLauncherIdentifier = "Xcode.IDEFoundation.Launcher.PosixSpawn"`,
  );
}

describe('configureLaunchAction', () => {
  test('sets the configuration and drops the debugger on the LaunchAction only', () => {
    const root = tempRoot();
    const path = writeScheme(root);

    expect(configureLaunchAction(root, SCHEME, 'Release')).toBe(true);

    const patched = readFileSync(path, 'utf8');
    expect(patched).toBe(expectedLaunchAction('Release'));
    // Negative control: the expected text really differs from the input, and
    // TestAction keeps its debugger.
    expect(patched).not.toBe(SCHEME_XML);
    expect(patched).toContain(
      '<TestAction\n      buildConfiguration = "Debug"\n      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"',
    );
  });

  test('drops the debugger for a Debug build too, and reports no change the second time', () => {
    const root = tempRoot();
    const path = writeScheme(root);
    expect(configureLaunchAction(root, SCHEME, 'Debug')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(expectedLaunchAction('Debug'));
    expect(configureLaunchAction(root, SCHEME, 'Debug')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(expectedLaunchAction('Debug'));
  });

  test('refuses a LaunchAction without the attributes Expo generates', () => {
    const root = tempRoot();
    const path = writeScheme(root);
    writeFileSync(
      path,
      SCHEME_XML.replace(
        '      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"\n      launchStyle',
        '      launchStyle',
      ),
    );
    expect(() => configureLaunchAction(root, SCHEME, 'Release')).toThrow(
      /Could not set selectedLauncherIdentifier on <LaunchAction>/,
    );
  });

  test('fails, naming the path, when the scheme file is missing', () => {
    expect(() => configureLaunchAction(tempRoot(), SCHEME, 'Release')).toThrow(
      /Scheme not found, cannot set the Run action: .*ExampleAppPreview\.xcscheme/,
    );
  });
});

describe('pinVariantForXcodeBuildPhases', () => {
  test('appends the variant after what prebuild wrote, replacing an older pin', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'ios'));
    const envPath = join(root, 'ios', '.xcode.env.local');
    writeFileSync(
      envPath,
      'export NODE_BINARY=/opt/bun/node\nexport APP_VARIANT=development\n\n',
    );

    pinVariantForXcodeBuildPhases(root, 'preview');

    expect(readFileSync(envPath, 'utf8')).toBe(
      'export NODE_BINARY=/opt/bun/node\nexport APP_VARIANT=preview\n',
    );
  });

  test('creates the file when prebuild left none', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'ios'));
    pinVariantForXcodeBuildPhases(root, 'development');
    expect(readFileSync(join(root, 'ios', '.xcode.env.local'), 'utf8')).toBe(
      'export APP_VARIANT=development\n',
    );
  });
});

function git(root: string, args: string[]): void {
  execFileSync('git', args, {cwd: root, stdio: 'ignore'});
}

describe('assertIosNotTracked', () => {
  test('passes in a CNG repo, where ios/ exists but is ignored', () => {
    const root = tempRoot();
    git(root, ['init', '-q']);
    writeFileSync(join(root, '.gitignore'), 'ios/\n');
    mkdirSync(join(root, 'ios'));
    writeFileSync(join(root, 'ios', 'Podfile'), 'generated');
    git(root, ['add', '.gitignore']);
    expect(() => assertIosNotTracked(root)).not.toThrow();
  });

  test('refuses when git tracks a file under ios/', () => {
    const root = tempRoot();
    git(root, ['init', '-q']);
    mkdirSync(join(root, 'ios'));
    writeFileSync(join(root, 'ios', 'Podfile'), 'committed');
    git(root, ['add', 'ios/Podfile']);
    expect(() => assertIosNotTracked(root)).toThrow(
      /git tracks 1 file\(s\) under ios\/ \(first: ios\/Podfile\).*Refusing/,
    );
  });

  test('refuses when it cannot check (not a git repo)', () => {
    expect(() => assertIosNotTracked(tempRoot())).toThrow(
      /Could not check whether git tracks anything under ios\/ \(`git ls-files -- ios` failed: fatal: not a git repository.*\)\. Refusing/,
    );
  });
});

describe('assertSigningTeam', () => {
  function writePbxproj(root: string, body: string): void {
    const dir = join(root, 'ios', `${SCHEME}.xcodeproj`);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'project.pbxproj'), body);
  }

  test('passes when prebuild wrote a team (quoted or not)', () => {
    const root = tempRoot();
    writePbxproj(root, '\t\t\t\tDEVELOPMENT_TEAM = UFL7WNR5T5;\n');
    expect(() => assertSigningTeam(root, SCHEME)).not.toThrow();
    writePbxproj(root, '\t\t\t\tDEVELOPMENT_TEAM = "UFL7WNR5T5";\n');
    expect(() => assertSigningTeam(root, SCHEME)).not.toThrow();
  });

  test('fails before any compiling when no team is set, naming ios.appleTeamId', () => {
    const root = tempRoot();
    // The shape a prebuild without ios.appleTeamId leaves: the key is absent,
    // or present and empty.
    writePbxproj(root, '\t\t\t\tCODE_SIGN_STYLE = Automatic;\n');
    expect(() => assertSigningTeam(root, SCHEME)).toThrow(
      /no DEVELOPMENT_TEAM .*Set `ios\.appleTeamId`/,
    );
    writePbxproj(root, '\t\t\t\tDEVELOPMENT_TEAM = "";\n');
    expect(() => assertSigningTeam(root, SCHEME)).toThrow(
      /no DEVELOPMENT_TEAM/,
    );
  });

  test('an unreadable project file is a failure, not a pass', () => {
    expect(() => assertSigningTeam(tempRoot(), SCHEME)).toThrow(
      /Could not read .*project\.pbxproj to check its signing team/,
    );
  });
});

describe('conflictingOptions', () => {
  test('--install-only takes no other build options', () => {
    expect(
      conflictingOptions({
        dialogCheck: true,
        installOnly: true,
        launch: true,
        problems: false,
        skipPrebuild: true,
        variant: null,
      }),
    ).toContain('--install-only');
    expect(
      conflictingOptions({
        dialogCheck: true,
        installOnly: true,
        launch: false,
        problems: false,
        skipPrebuild: false,
        variant: null,
      }),
    ).toContain('--install-only');
    expect(
      conflictingOptions({
        dialogCheck: true,
        installOnly: true,
        launch: true,
        problems: false,
        skipPrebuild: false,
        variant: null,
      }),
    ).toBeNull();
    expect(
      conflictingOptions({
        dialogCheck: true,
        installOnly: false,
        launch: false,
        problems: false,
        skipPrebuild: true,
        variant: null,
      }),
    ).toBeNull();
  });

  test('--problems takes no other option', () => {
    const base = {
      dialogCheck: true,
      installOnly: false,
      launch: true,
      problems: true,
      skipPrebuild: false,
      variant: null,
    };
    expect(conflictingOptions(base)).toBeNull();
    const others = [
      {installOnly: true},
      {launch: false},
      {skipPrebuild: true},
      {variant: 'development'},
      {dialogCheck: false},
    ];
    for (const other of others) {
      expect([other, conflictingOptions({...base, ...other})]).toEqual([
        other,
        '--problems prints the list of known Mac build problems and does nothing else, so it takes no other option.',
      ]);
    }
  });

  test('--variant goes with --install-only, which installs that variant', () => {
    expect(
      conflictingOptions({
        dialogCheck: true,
        installOnly: true,
        launch: true,
        problems: false,
        skipPrebuild: false,
        variant: 'development',
      }),
    ).toBeNull();
  });

  test('--no-dialog-check goes with the builds that use Xcode, and refuses the others (D6)', () => {
    const base = {
      dialogCheck: false,
      installOnly: false,
      launch: true,
      problems: false,
      skipPrebuild: false,
      variant: null,
    };
    // The full and the incremental build both use Xcode.
    expect(conflictingOptions(base)).toBeNull();
    expect(conflictingOptions({...base, skipPrebuild: true})).toBeNull();
    expect(conflictingOptions({...base, variant: 'development'})).toBeNull();
    const refusal =
      '--no-dialog-check skips the checks for a dialog in the Xcode app, which --install-only and --no-launch never use, so it means nothing with them.';
    expect(conflictingOptions({...base, launch: false})).toBe(refusal);
    expect(
      conflictingOptions({...base, launch: false, skipPrebuild: true}),
    ).toBe(refusal);
    expect(conflictingOptions({...base, installOnly: true})).toBe(refusal);
    // Negative control: the same runs with the check on are fine.
    expect(
      conflictingOptions({...base, dialogCheck: true, launch: false}),
    ).toBeNull();
    expect(
      conflictingOptions({...base, dialogCheck: true, installOnly: true}),
    ).toBeNull();
  });
});

describe('--no-dialog-check turns off check 3 too (D6)', () => {
  const OPTIONS = {
    dialogCheck: true,
    installOnly: false,
    launch: true,
    problems: false,
    skipPrebuild: false,
    variant: null,
  };
  const FAKE = {
    capture: () => ({path: '/x.png', status: 'saved'}) as const,
    detect: () => ({status: 'none'}) as const,
  };

  test('off: the load wait gets no dialog check', () => {
    expect(loadWaitDialogCheck({...OPTIONS, dialogCheck: false}, FAKE)).toBe(
      null,
    );
  });

  test('on: it gets one, whose failure names the incremental run with the flag, keeping the variant', () => {
    expect(loadWaitDialogCheck(OPTIONS, FAKE)?.withoutCheckCommand).toBe(
      'bun run mac -- --no-dialog-check',
    );
    expect(
      loadWaitDialogCheck({...OPTIONS, variant: 'development'}, FAKE)
        ?.withoutCheckCommand,
    ).toBe('bun run mac -- --variant development --no-dialog-check');
  });
});

describe('runMacBuild without a config block', () => {
  test('exits 1 before touching anything, and names what to add', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'justin-sdk.config.json'), '{}');
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let exit: number;
    try {
      exit = runMacBuild(root, {
        dialogCheck: true,
        installOnly: false,
        launch: false,
        problems: false,
        skipPrebuild: true,
        variant: null,
      });
    } finally {
      process.stderr.write = original;
    }
    expect(exit).toBe(1);
    const message = writes.join('');
    expect(message).toContain('has no componentConfig.mac-build block');
    expect(message).toContain('"variant": "preview"');
    // The same message teaches the optional map and the flag that reads it.
    expect(message).toContain('--variant <name>');
    expect(message).toContain('"variants": {');
    // Every failure ends with one line naming the known-problems list (D2).
    const lines = message.trimEnd().split('\n');
    expect(lines.at(-1)).toEndWith(
      'Known Mac build problems and their fixes: `bun run justin-sdk mac-build --problems`',
    );
    expect(message.split(MAC_BUILD_PROBLEMS_COMMAND).length - 1).toBe(1);
  });
});

describe('startBuildTimer', () => {
  test('the elapsed time leaves out the signing waits, and names them separately', () => {
    let nowMs = 5_000_000;
    const timer = startBuildTimer(() => nowMs);
    nowMs += 100_000;
    expect(timer.elapsed()).toBe('100s');
    expect(timer.waitNote()).toBe('');
    timer.addSigningWait(30);
    timer.addSigningWait(5.2);
    nowMs += 70_000;
    expect(timer.elapsed()).toBe('135s');
    expect(timer.waitNote()).toBe(
      ' (not counting 35 s spent waiting for an unlocked screen)',
    );
  });

  test('a wait under half a second is not mentioned', () => {
    const timer = startBuildTimer(() => 0);
    timer.addSigningWait(0.4);
    expect(timer.waitNote()).toBe('');
  });
});

/**
 * Inside `tell application "Xcode"`, `it is not running` is always true,
 * whether Xcode runs or not (measured 2026-11-21, home-base-0jeya.13). From
 * 2026-10-21 that made the stale-workspace stop and close return at once, and
 * made the open poll answer "not running" while Xcode ran. Each script that
 * asks whether Xcode runs must ask `application "Xcode" is not running` as its
 * first line, before `with timeout` and `tell`.
 */
describe('the AppleScripts ask whether Xcode runs outside their tell block', () => {
  const RUNNING_CHECK =
    'if application "Xcode" is not running then return "not running"';
  const BROKEN = /\bit is not running\b/;
  const WORKSPACE = '/Users/someone/Dev/example-app/ios/ExampleApp.xcworkspace';
  const SOURCES = ['mac-build.ts', 'mac-build-xcode.ts'].map((name) =>
    resolve(import.meta.dir, '..', 'src', name),
  );

  /** What is wrong with one generated script; empty when nothing is. */
  function runningCheckProblems(script: string): string[] {
    const problems: string[] = [];
    if (BROKEN.test(script)) {
      problems.push('it tests `it is not running`, which is always true');
    }
    if (script.trimStart().split('\n')[0] !== RUNNING_CHECK) {
      problems.push(`its first line is not: ${RUNNING_CHECK}`);
    }
    return problems;
  }

  /** Each string or template literal in `text` that tests `it is not running`. */
  function brokenLiterals(file: string, text: string): string[] {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        BROKEN.test(node.text)
      ) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${file}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  test('the open poll, the stop and the close each ask it first', () => {
    for (const [name, script] of [
      ['workspacePollScript', workspacePollScript(WORKSPACE)],
      ['stopWorkspaceAppScript', stopWorkspaceAppScript(WORKSPACE)],
      ['closeWorkspaceScript', closeWorkspaceScript(WORKSPACE)],
    ] as const) {
      expect([name, runningCheckProblems(script)]).toEqual([name, []]);
      expect(script).toContain('tell application "Xcode"');
    }
  });

  test('the stop and the close still stop and close only that workspace', () => {
    const tricky = '/Users/someone/Dev/a "b"/ios/X.xcworkspace';
    const quoted = '"/Users/someone/Dev/a \\"b\\"/ios/X.xcworkspace"';
    const stop = stopWorkspaceAppScript(tricky);
    expect(stop).toContain(`is equal to ${quoted} then`);
    expect(stop).toContain('stop theDocument');
    expect(stop).not.toContain('close theDocument');
    const close = closeWorkspaceScript(tricky);
    expect(close).toContain(`is equal to ${quoted} then`);
    expect(close).toContain('close theDocument');
    expect(close).not.toContain('stop theDocument');
  });

  test('no literal in mac-build.ts or mac-build-xcode.ts tests `it is not running`', () => {
    for (const file of SOURCES) {
      expect(brokenLiterals(file, readFileSync(file, 'utf8'))).toEqual([]);
    }
  });

  test('negative control: the old line put back is caught by both checks', () => {
    const old = `
with timeout of 20 seconds
tell application "Xcode"
    if it is not running then return "not running"
    return "absent"
end tell
end timeout
`;
    expect(runningCheckProblems(old)).toEqual([
      'it tests `it is not running`, which is always true',
      `its first line is not: ${RUNNING_CHECK}`,
    ]);
    // Moved below the tell, the right test is still wrong.
    expect(
      runningCheckProblems(
        `\ntell application "Xcode"\n    ${RUNNING_CHECK}\nend tell\n`,
      ),
    ).toEqual([`its first line is not: ${RUNNING_CHECK}`]);
    const file = SOURCES[1] ?? '';
    const real = readFileSync(file, 'utf8');
    const reverted = real.replace(
      `tell application "Xcode"\n    repeat with theDocument`,
      `tell application "Xcode"\n    if it is not running then return "not running"\n    repeat with theDocument`,
    );
    expect(reverted).not.toBe(real);
    expect(brokenLiterals(file, reverted)).toHaveLength(1);
  });
});

describe('the known-problems list', () => {
  const text = readFileSync(MAC_BUILD_PROBLEMS_PATH, 'utf8');

  test('it is in docs/, which ships with the package', () => {
    expect(MAC_BUILD_PROBLEMS_PATH).toBe(
      resolve(import.meta.dir, '..', 'docs', 'mac-build-problems.md'),
    );
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as {files?: string[]};
    expect(pkg.files).toContain('docs');
  });

  test('it lists every problem the design names, each with its four parts', () => {
    // One phrase per required entry (home-base-0jeya.13, D2).
    const required = [
      'AppleEvent timed out. (-1712)',
      'starts while the screen is locked',
      '"No Accounts"',
      'App Groups',
      'PREVIEW_BROADCAST_OVERRIDE=off',
      'DEVELOPMENT_TEAM',
      'RCT_USE_PREBUILT_RNCORE=0',
      'Configuring Debugger Actions',
      '(-10008)',
      'modal dialog',
      // D5: the message a stop or close with no answer fails with.
      'Xcode did not answer within 60s when asked to close <path>, so it is probably showing a dialog (problem 8',
      // D6: the dialog seen on 2026-11-21, its answer, and the new messages.
      'has disappeared. Do you want to re-save the container, or close it?',
      'click **Close**, not Re-save',
      'seen twice 3s apart, and while Xcode shows a dialog it may not answer mac-build, and a workspace it is opening may not load (problem 8',
      'Xcode has shown a dialog (…) for 30s while <path> had not loaded',
      'and Xcode is showing a dialog (…)',
      '`bun run build:mac -- --no-dialog-check`',
      'turns off all three checks that can stop a run',
      'whether the terminal has screen recording permission',
      'recompile',
      'Closing the stale workspace never ran',
    ];
    for (const phrase of required) {
      expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
    }
    // Only what was measured: no claim that a dialog blocks every command.
    expect(text).not.toContain('blocks every AppleScript command');
    // The stop and close failures name "problem 8" (D5), so 8 must stay the dialog.
    expect(text).toContain('\n## 8. A dialog in Xcode stops the build\n');
    const entries = text.split('\n## ').slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    for (const entry of entries) {
      const title = entry.split('\n')[0];
      for (const part of [
        '**What you see:**',
        '**Cause:**',
        '**Fix:**',
        '**Seen:**',
      ]) {
        expect([title, part, entry.includes(part)]).toEqual([
          title,
          part,
          true,
        ]);
      }
    }
  });
});

describe('--variant through the real CLI', () => {
  const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
  const PREVIEW_SCHEME = 'ScreenshotAppPreview';
  const DEV_SCHEME = 'ScreenshotAppDev';

  /** A repo with a Preview default and a Dev entry, and no ios/ yet. */
  function appRepo(): string {
    const root = tempRoot();
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        componentConfig: {
          'mac-build': {
            bundleId: 'com.jhaa.screenshotapp.preview',
            scheme: PREVIEW_SCHEME,
            variant: 'preview',
            variants: {
              development: {
                bundleId: 'com.jhaa.screenshotapp.dev',
                scheme: DEV_SCHEME,
              },
            },
          },
        },
      }),
    );
    return root;
  }

  function macBuildCli(
    root: string,
    args: string[],
  ): {status: number | null; stderr: string; stdout: string} {
    const run = spawnSync(process.execPath, [CLI, 'mac-build', ...args], {
      cwd: root,
      encoding: 'utf-8',
      env: {
        ...process.env,
        // git must not find a repo above the temp root: the prebuild path relies
        // on "not a git repository" to stop before it would run `expo prebuild`.
        GIT_CEILING_DIRECTORIES: tmpdir(),
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
        // Skips system_profiler, which has nothing to do with these checks.
        MAC_DEST_ID: 'TEST-MAC-DESTINATION',
      },
    });
    return {status: run.status, stderr: run.stderr, stdout: run.stdout};
  }

  const DEV_LINE =
    'development variant, scheme ScreenshotAppDev, Debug (the default for this variant), bundle id com.jhaa.screenshotapp.dev.';
  const PREVIEW_LINE =
    'preview variant, scheme ScreenshotAppPreview, Release (the default for this variant), bundle id com.jhaa.screenshotapp.preview.';

  test('with no flag it uses the default, and the messages name no flag', () => {
    const run = macBuildCli(appRepo(), ['--skip-prebuild', '--no-launch']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(PREVIEW_LINE);
    expect(run.stderr).toContain(`ios/${PREVIEW_SCHEME}.xcworkspace not found`);
    expect(run.stderr).toContain(
      '"scheme" in componentConfig.mac-build does not match the workspace Expo generates for "preview"',
    );
    expect(run.stderr).toContain(
      'run `bun run build:mac` (without --skip-prebuild) to regenerate it.',
    );
    expect(run.stderr).not.toContain('--variant');
  });

  test('--variant with the default name uses the same top-level values', () => {
    const run = macBuildCli(appRepo(), [
      '--variant',
      'preview',
      '--skip-prebuild',
      '--no-launch',
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(PREVIEW_LINE);
    expect(run.stderr).toContain(`ios/${PREVIEW_SCHEME}.xcworkspace not found`);
  });

  test('--skip-prebuild honours the variant, and the message stays accurate', () => {
    const root = appRepo();
    // The routine state: ios/ holds the OTHER variant's workspace.
    mkdirSync(join(root, 'ios', `${PREVIEW_SCHEME}.xcworkspace`), {
      recursive: true,
    });
    const run = macBuildCli(root, [
      '--variant',
      'development',
      '--skip-prebuild',
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(DEV_LINE);
    expect(run.stderr).toContain(`ios/${DEV_SCHEME}.xcworkspace not found`);
    expect(run.stderr).toContain(
      `ios/ currently holds: ${PREVIEW_SCHEME}.xcworkspace`,
    );
    expect(run.stderr).toContain(
      '"scheme" in componentConfig.mac-build.variants.development does not match the workspace Expo generates for "development"',
    );
    // The bare command would rebuild the default and fail the same way again.
    expect(run.stderr).toContain(
      'run `bun run build:mac -- --variant development` (without --skip-prebuild) to regenerate it.',
    );
  });

  test('--install-only honours the variant, and so does its remedy', () => {
    const run = macBuildCli(appRepo(), [
      '--variant',
      'development',
      '--install-only',
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(DEV_LINE);
    expect(run.stderr).toContain(`ios/${DEV_SCHEME}.xcworkspace not found`);
    expect(run.stderr).toContain(
      'Run `bun run build:mac -- --variant development` (it installs as it goes).',
    );
  });

  test('--no-launch reaches the prebuild path with the variant selected', () => {
    // The temp root is not a git repo, so the guard in prebuild() refuses before
    // anything runs. Nothing here can reach `expo prebuild`.
    const run = macBuildCli(appRepo(), [
      '--variant',
      'development',
      '--no-launch',
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(DEV_LINE);
    expect(run.stdout).not.toContain('Regenerating');
    expect(run.stderr).toContain('Could not check whether git tracks anything');
  });

  test('the variant reaches the Run action, the APP_VARIANT pin and the signing remedy', () => {
    const root = appRepo();
    mkdirSync(join(root, 'ios', `${DEV_SCHEME}.xcworkspace`), {
      recursive: true,
    });
    const schemeDir = join(
      root,
      'ios',
      `${DEV_SCHEME}.xcodeproj`,
      'xcshareddata',
      'xcschemes',
    );
    mkdirSync(schemeDir, {recursive: true});
    const schemePath = join(schemeDir, `${DEV_SCHEME}.xcscheme`);
    writeFileSync(schemePath, SCHEME_XML);
    // No DEVELOPMENT_TEAM: assertSigningTeam stops the run before xcodebuild.
    writeFileSync(
      join(root, 'ios', `${DEV_SCHEME}.xcodeproj`, 'project.pbxproj'),
      '\t\t\t\tCODE_SIGN_STYLE = Automatic;\n',
    );

    const run = macBuildCli(root, [
      '--variant',
      'development',
      '--skip-prebuild',
      '--no-launch',
    ]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(DEV_LINE);
    expect(run.stdout).not.toContain('Building ');
    expect(readFileSync(schemePath, 'utf8')).toBe(
      expectedLaunchAction('Debug'),
    );
    expect(
      readFileSync(join(root, 'ios', '.xcode.env.local'), 'utf8'),
    ).toContain('export APP_VARIANT=development\n');
    expect(run.stderr).toContain(
      'then run `bun run build:mac -- --variant development` again so the prebuild writes it.',
    );
  });

  test('an unknown variant exits non-zero before doing anything, and never builds the default', () => {
    const run = macBuildCli(appRepo(), [
      '--variant',
      'staging',
      '--skip-prebuild',
      '--no-launch',
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      '"staging" is not a variant this repo\'s Mac build knows, so nothing was built. It knows: preview (the default), development.',
    );
    expect(run.stderr).toContain('"variants": {');
    expect(run.stderr).toContain('"staging": {');
    // Not one line of a build started, of either variant.
    expect(run.stdout).toBe('');
  });

  test('a broken entry stops a build of the default, not just of that entry', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        componentConfig: {
          'mac-build': {
            bundleId: 'com.jhaa.screenshotapp.preview',
            scheme: PREVIEW_SCHEME,
            variant: 'preview',
            variants: {development: {scheme: DEV_SCHEME}},
          },
        },
      }),
    );
    const run = macBuildCli(root, ['--skip-prebuild', '--no-launch']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot be used');
    expect(run.stderr).toContain('"variants.development.bundleId" is missing');
    expect(run.stdout).toBe('');
  });

  test('the odd spellings of the flag all refuse, and none builds the default', () => {
    const spellings: [string[], string][] = [
      [['--variant'], 'Not enough arguments following: variant'],
      [
        ['--variant', '--skip-prebuild'],
        'Not enough arguments following: variant',
      ],
      [['--variant='], '"" is not a variant name'],
      [
        ['--variant', 'a', '--variant', 'b'],
        '--variant takes one variant name.',
      ],
      [['--no-variant'], '--variant takes one variant name.'],
    ];
    for (const [args, expected] of spellings) {
      const run = macBuildCli(appRepo(), [...args, '--no-launch']);
      expect([args, run.status]).toEqual([args, 1]);
      expect(run.stderr).toContain(expected);
      expect(run.stdout).not.toContain(PREVIEW_LINE);
    }
  });

  test('--help documents the flag and does nothing else', () => {
    const run = macBuildCli(appRepo(), ['--help']);
    expect(run.status).toBe(0);
    // yargs wraps descriptions at a width that depends on the terminal and on
    // the help header (which holds this checkout's path), so whitespace is
    // collapsed before any phrase is matched.
    const help = run.stdout.replace(/\s+/g, ' ');
    expect(help).toContain('--variant');
    expect(help).toContain('--problems');
    expect(help).toContain('--dialog-check');
    expect(help).toContain(
      '--no-dialog-check turns all three off, for a window that is not a dialog: `bun run build:mac -- --no-dialog-check`.',
    );
    expect(help).not.toContain('blocks every AppleScript command');
    expect(run.stdout).not.toContain(PREVIEW_LINE);
  });

  test('--no-dialog-check with --no-launch or --problems refuses, and builds nothing (D6)', () => {
    for (const args of [
      ['--no-dialog-check', '--no-launch'],
      ['--no-dialog-check', '--install-only'],
      ['--problems', '--no-dialog-check'],
    ]) {
      const run = macBuildCli(appRepo(), args);
      expect([args, run.status, run.stdout]).toEqual([args, 2, '']);
      expect(run.stderr).toContain(
        args.includes('--problems')
          ? '--problems prints'
          : '--no-dialog-check skips',
      );
    }
  });

  test('--problems prints the list from any directory, and does nothing else', () => {
    // A directory with no config at all: --problems needs none.
    const run = macBuildCli(tempRoot(), ['--problems']);
    expect([run.status, run.stderr]).toEqual([0, '']);
    expect(run.stdout).toBe(readFileSync(MAC_BUILD_PROBLEMS_PATH, 'utf8'));
    expect(run.stdout).toStartWith('# Known Mac build problems\n');
  });

  test('--problems with another option refuses, and builds nothing', () => {
    const run = macBuildCli(appRepo(), ['--problems', '--skip-prebuild']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      '--problems prints the list of known Mac build problems and does nothing else',
    );
    expect(run.stdout).toBe('');
  });

  test('a failure through the CLI ends with the line naming --problems', () => {
    const run = macBuildCli(appRepo(), ['--skip-prebuild', '--no-launch']);
    expect(run.status).toBe(1);
    expect(run.stderr.trimEnd().split('\n').at(-1)).toEndWith(
      `Known Mac build problems and their fixes: \`${MAC_BUILD_PROBLEMS_COMMAND}\``,
    );
  });
});
