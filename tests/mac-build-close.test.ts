/**
 * Tests for mac-build closing the workspace in Xcode BEFORE anything rewrites
 * ios/ (home-base-0jeya.13, D5). prepareIos runs against a temp app root with a
 * fake osascript runner, a fake prebuild and a fake process list, so no test
 * talks to Xcode and none runs `expo prebuild`. Every call the fakes see is
 * recorded in one list, which is how the order is checked.
 */

import type {MacBuildConfig} from '../src/mac-build-config';
import type {OsascriptRun} from '../src/mac-build-xcode';
import type {
  XcodeDialogDeps,
  XcodeDialogReading,
} from '../src/mac-build-xcode-dialog';

import {afterAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';
import ts from 'typescript';

import {
  CLOSE_EVENT_TIMEOUT_SECONDS,
  closeWorkspaceScript,
  type MacBuildOptions,
  prepareIos,
  type PrepareIosDeps,
  stopWorkspaceAppScript,
} from '../src/mac-build';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, {force: true, recursive: true});
});

const SCHEME = 'ExampleAppPreview';
const CONFIG_KEY = 'componentConfig.mac-build';
const CONFIG: MacBuildConfig = {
  bundleId: 'com.example.app.preview',
  configuration: 'Release',
  configurationSource: 'config',
  scheme: SCHEME,
  variant: 'preview',
};

/** The LaunchAction Expo generates: Debug, with the debugger. */
const SCHEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1130" version = "1.3">
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0">
   </LaunchAction>
</Scheme>
`;

/** What osascript printed at the 2026-11-21 2:07am close that got no answer. */
const TIMEOUT_STDERR =
  '291:326: execution error: Xcode got an error: AppleEvent timed out. (-1712)';
const OTHER_ERROR_STDERR =
  '120:160: execution error: Xcode got an error: Can’t get workspace document 1. (-1728)';

const FULL: MacBuildOptions = {
  dialogCheck: true,
  installOnly: false,
  launch: true,
  problems: false,
  skipPrebuild: false,
  variant: null,
};
const INCREMENTAL: MacBuildOptions = {...FULL, skipPrebuild: true};

/** A temp app root that is a git repo with nothing under ios/ tracked. */
function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsdk-mac-build-close-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], {cwd: root, stdio: 'ignore'});
  return root;
}

function workspacePath(root: string): string {
  return join(root, 'ios', `${SCHEME}.xcworkspace`);
}

function schemePath(root: string): string {
  return join(
    root,
    'ios',
    `${SCHEME}.xcodeproj`,
    'xcshareddata',
    'xcschemes',
    `${SCHEME}.xcscheme`,
  );
}

/** What `expo prebuild` leaves that prepareIos reads: workspace, scheme, team. */
function writeGeneratedIos(root: string): void {
  mkdirSync(workspacePath(root), {recursive: true});
  mkdirSync(join(schemePath(root), '..'), {recursive: true});
  writeFileSync(schemePath(root), SCHEME_XML);
  writeFileSync(
    join(root, 'ios', `${SCHEME}.xcodeproj`, 'project.pbxproj'),
    '\t\t\t\tDEVELOPMENT_TEAM = UFL7WNR5T5;\n',
  );
}

type Answer = OsascriptRun | string;

/** The 2026-11-21 dialog, as the window server listed it (D6). */
const DIALOG: XcodeDialogReading = {
  dialogs: [{height: 432, title: null, width: 410, windowNumber: 2392}],
  status: 'dialog',
};
const NO_DIALOG: XcodeDialogReading = {status: 'none'};
const UNKNOWN_REASON =
  'the window list could not be read: osascript reported: boom';
const UNKNOWN: XcodeDialogReading = {
  reason: UNKNOWN_REASON,
  status: 'unknown',
};
const PICTURE = '/state/justin-sdk/mac-build/xcode-dialog-fake.png';
const DIALOG_NAME =
  'a dialog (a window with no readable title, 410x432, window number 2392)';

interface FakeOptions {
  /** Whether the app exits within the wait after the stop. */
  appExits?: boolean;
  close?: Answer;
  /**
   * What each reading of the window server's list shows, in order; once
   * empty, every reading shows none.
   */
  dialogs?: XcodeDialogReading[];
  stop?: Answer;
}

/** What the fake saw when the stop script arrived. */
interface AtStop {
  schemeText: string | null;
  workspaceFolderExisted: boolean;
}

/**
 * A fake Xcode, process list, window server and prebuild. Every call lands in
 * `calls`, in order: a reading of the window server's list is `dialog check`,
 * a picture `capture <n>`, the sleep between two readings `sleep <n>s`. The
 * stop and close scripts must be exactly the ones for this root's workspace;
 * any other script fails the test. What the dialog checks log goes to
 * `dialogLogs`; what the close step logs, to `logs`.
 */
function fakeWorld(root: string, options: FakeOptions = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const dialogLogs: string[] = [];
  const atStop: AtStop[] = [];
  const stopScript = stopWorkspaceAppScript(workspacePath(root));
  const closeScript = closeWorkspaceScript(workspacePath(root));
  const run = (answer: Answer): OsascriptRun =>
    typeof answer === 'string' ? {status: 'ok', stdout: answer} : answer;
  const readings = [...(options.dialogs ?? [])];
  const dialog: XcodeDialogDeps = {
    capture: (windowNumber) => {
      calls.push(`capture ${windowNumber}`);
      return {path: PICTURE, status: 'saved'};
    },
    detect: () => {
      calls.push('dialog check');
      return readings.shift() ?? NO_DIALOG;
    },
  };
  const deps: PrepareIosDeps = {
    close: {
      dialog,
      killApp: (scheme) => {
        calls.push(`kill ${scheme}`);
      },
      log: (message) => {
        logs.push(message);
      },
      osascript: (script) => {
        if (script === stopScript) {
          calls.push('stop');
          atStop.push({
            schemeText: existsSync(schemePath(root))
              ? readFileSync(schemePath(root), 'utf8')
              : null,
            workspaceFolderExisted: existsSync(workspacePath(root)),
          });
          return run(options.stop ?? 'stopped');
        }
        if (script === closeScript) {
          calls.push('close');
          return run(options.close ?? 'closed');
        }
        throw new Error(`unexpected script: ${script}`);
      },
      waitForAppToExit: (scheme, seconds) => {
        calls.push(`wait ${seconds}s for ${scheme} to exit`);
        return options.appExits ?? true;
      },
    },
    dialog: {
      ...dialog,
      log: (message) => {
        dialogLogs.push(message);
      },
      sleep: (seconds) => {
        calls.push(`sleep ${seconds}s`);
      },
    },
    prebuild: (projectRoot, config) => {
      calls.push(`prebuild ${config.variant}`);
      writeGeneratedIos(projectRoot);
    },
  };
  return {atStop, calls, deps, dialogLogs, logs};
}

function prepare(
  root: string,
  options: MacBuildOptions,
  deps: PrepareIosDeps,
): ReturnType<typeof prepareIos> {
  return prepareIos(
    root,
    {config: CONFIG, configKey: CONFIG_KEY},
    options,
    deps,
  );
}

/** The thrown message, or a failure when nothing was thrown. */
function thrownBy(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a throw, and nothing was thrown');
}

const WAIT = `wait 20s for ${SCHEME} to exit`;
/** One reading of the window server's list (D6). */
const CHECK = 'dialog check';

describe('with a prebuild, the workspace is closed in Xcode before the prebuild (D5)', () => {
  test('stop, wait for the exit, close, then prebuild: from the computed path, before ios/ exists', () => {
    const root = appRoot();
    const world = fakeWorld(root);

    const workspace = prepare(root, FULL, world.deps);

    // A dialog check before the close (check 1) and after the prebuild (check 2).
    expect(world.calls).toEqual([
      CHECK,
      'stop',
      WAIT,
      'close',
      'prebuild preview',
      CHECK,
    ]);
    expect(world.dialogLogs).toEqual([
      'Dialog check before anything in ios/ changes: Xcode shows none.',
      'Dialog check after the prebuild: Xcode shows none.',
    ]);
    // The folder did not exist when the stop was sent: the path was computed.
    expect(world.atStop).toEqual([
      {schemeText: null, workspaceFolderExisted: false},
    ]);
    expect(workspace.absolutePath).toBe(workspacePath(root));
    expect(world.logs).toEqual([
      `Closing ${workspacePath(root)} in Xcode, if Xcode has it open, before the prebuild regenerates it…`,
      'Closed it in Xcode.',
    ]);
    // The rest of the preparation ran after it, on the regenerated project.
    expect(readFileSync(schemePath(root), 'utf8')).toContain(
      'buildConfiguration = "Release"',
    );
  });

  test('Xcode not running: one check, no close, then the prebuild', () => {
    const root = appRoot();
    const world = fakeWorld(root, {stop: 'not running'});
    prepare(root, FULL, world.deps);
    expect(world.calls).toEqual([CHECK, 'stop', 'prebuild preview', CHECK]);
    expect(world.logs.at(-1)).toBe(
      'Xcode is not running, so there is nothing to close.',
    );
  });

  test('Xcode running without this workspace: no wait, no close', () => {
    const root = appRoot();
    const world = fakeWorld(root, {stop: 'absent'});
    prepare(root, FULL, world.deps);
    expect(world.calls).toEqual([CHECK, 'stop', 'prebuild preview', CHECK]);
    expect(world.logs.at(-1)).toBe(
      'Xcode does not have it open, so there is nothing to close.',
    );
  });

  test('an app that does not exit after the stop is terminated before the close', () => {
    const root = appRoot();
    const world = fakeWorld(root, {appExits: false});
    prepare(root, FULL, world.deps);
    expect(world.calls).toEqual([
      CHECK,
      'stop',
      WAIT,
      `kill ${SCHEME}`,
      'close',
      'prebuild preview',
      CHECK,
    ]);
  });

  test('a prebuild the git check refuses closes nothing', () => {
    // Not a git repo, so assertIosNotTracked cannot check, and refuses.
    const root = mkdtempSync(join(tmpdir(), 'jsdk-mac-build-close-'));
    roots.push(root);
    const world = fakeWorld(root);
    expect(thrownBy(() => prepare(root, FULL, world.deps))).toContain(
      'Could not check whether git tracks anything under ios/',
    );
    expect(world.calls).toEqual([]);
  });
});

describe('without a prebuild, it closes only when the Run action will change (D5)', () => {
  test('the scheme would change: it closes first, and writes the scheme after', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    const world = fakeWorld(root);

    prepare(root, INCREMENTAL, world.deps);

    // Check 1 before the close, check 2 after the Run action write.
    expect(world.calls).toEqual([CHECK, 'stop', WAIT, 'close', CHECK]);
    expect(world.dialogLogs).toEqual([
      'Dialog check before anything in ios/ changes: Xcode shows none.',
      'Dialog check after the Run action change: Xcode shows none.',
    ]);
    // When the stop went out, the scheme on disk was still the old one.
    expect(world.atStop).toEqual([
      {schemeText: SCHEME_XML, workspaceFolderExisted: true},
    ]);
    expect(world.logs[0]).toBe(
      `Closing ${workspacePath(root)} in Xcode, if Xcode has it open, before the Run action in its scheme changes…`,
    );
    expect(readFileSync(schemePath(root), 'utf8')).toContain(
      'buildConfiguration = "Release"',
    );
  });

  test('the scheme already holds the Run action: Xcode is not touched', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    // The first run patches the scheme (and closes); the second has nothing to change.
    prepare(root, INCREMENTAL, fakeWorld(root).deps);
    const world = fakeWorld(root);
    prepare(root, INCREMENTAL, world.deps);
    // Only check 1, which reads the window server and sends Xcode nothing; no
    // check 2, since this run wrote nothing that Xcode reads.
    expect(world.calls).toEqual([CHECK]);
    expect(world.logs).toEqual([]);
  });
});

describe('--no-launch touches no Xcode (its --help says so)', () => {
  test('with a prebuild: the prebuild runs and nothing is sent to Xcode', () => {
    const root = appRoot();
    const world = fakeWorld(root);
    prepare(root, {...FULL, launch: false}, world.deps);
    expect(world.calls).toEqual(['prebuild preview']);
  });

  test('with a scheme change: the scheme is written and nothing is sent to Xcode', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    const world = fakeWorld(root);
    prepare(root, {...INCREMENTAL, launch: false}, world.deps);
    expect(world.calls).toEqual([]);
    expect(readFileSync(schemePath(root), 'utf8')).toContain(
      'buildConfiguration = "Release"',
    );
  });
});

describe('a stop or close that gets no answer fails at once (D5)', () => {
  test('-1712 on the close: no retry, no prebuild, and the message names the dialog and problem 8', () => {
    const root = appRoot();
    const world = fakeWorld(root, {
      close: {status: 'failed', stderr: TIMEOUT_STDERR},
    });

    const message = thrownBy(() => prepare(root, FULL, world.deps));

    // Check 1, then the stop and close, then one reading after the -1712 (check 4).
    expect(world.calls).toEqual([CHECK, 'stop', WAIT, 'close', CHECK]);
    expect(existsSync(join(root, 'ios'))).toBe(false);
    expect(message).toBe(
      `Xcode did not answer within 60s when asked to close ${workspacePath(root)}, so it is probably showing a dialog (problem 8 in \`bun run justin-sdk mac-build --problems\`). Nothing in ios/ has been changed. Look at Xcode, answer or dismiss the dialog it shows, then run \`bun run build:mac\` again. Xcode reported: ${TIMEOUT_STDERR}`,
    );
    // The reading was none, and the log says so rather than folding it into the message.
    expect(world.logs.at(-1)).toBe(
      "Dialog check after Xcode did not answer: the window server's list shows no dialog in Xcode.",
    );
  });

  test('-1712 on the stop: no wait, no close, and the scheme is left as it was', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    const world = fakeWorld(root, {
      stop: {status: 'failed', stderr: TIMEOUT_STDERR},
    });

    const message = thrownBy(() =>
      prepare(root, {...INCREMENTAL, variant: 'preview'}, world.deps),
    );

    expect(world.calls).toEqual([CHECK, 'stop', CHECK]);
    expect(readFileSync(schemePath(root), 'utf8')).toBe(SCHEME_XML);
    expect(message).toStartWith(
      `Xcode did not answer within 60s when asked to stop the app running from ${workspacePath(root)}, so it is probably showing a dialog`,
    );
    // The command to run again keeps the path and the variant that was asked for.
    expect(message).toContain(
      'then run `bun run mac -- --variant preview` again.',
    );
  });

  test('any other failure says what Xcode said, and not that a dialog is likely', () => {
    const root = appRoot();
    const world = fakeWorld(root, {
      close: {status: 'failed', stderr: OTHER_ERROR_STDERR},
    });
    const message = thrownBy(() => prepare(root, FULL, world.deps));
    expect(message).toBe(
      `Could not close ${workspacePath(root)} in Xcode, so nothing in ios/ has been changed. Xcode reported: ${OTHER_ERROR_STDERR}`,
    );
    // Not a -1712, so no reading after it.
    expect(world.calls).toEqual([CHECK, 'stop', WAIT, 'close']);
  });

  test('an answer it does not understand is a failure, never "nothing to close"', () => {
    const root = appRoot();
    const world = fakeWorld(root, {stop: 'maybe'});
    expect(thrownBy(() => prepare(root, FULL, world.deps))).toBe(
      `Xcode gave an answer this does not understand when asked to stop the app running from ${workspacePath(root)}: "maybe". Nothing in ios/ has been changed.`,
    );
    expect(world.calls).toEqual([CHECK, 'stop']);
  });
});

describe('a dialog in Xcode stops the run before it changes anything (D6, check 1)', () => {
  test('with a prebuild: seen twice 3 s apart, it fails before any close or prebuild', () => {
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [DIALOG, DIALOG]});

    const message = thrownBy(() => prepare(root, FULL, world.deps));

    expect(world.calls).toEqual([CHECK, 'sleep 3s', CHECK, 'capture 2392']);
    expect(existsSync(join(root, 'ios'))).toBe(false);
    expect(message).toBe(
      `Xcode is showing ${DIALOG_NAME}, seen twice 3s apart, and while Xcode shows a dialog it may not answer mac-build, and a workspace it is opening may not load (problem 8 in \`bun run justin-sdk mac-build --problems\`). So this run stopped before it used Xcode. Nothing in ios/ has been changed. A picture of it: ${PICTURE}. Look at Xcode, answer the dialog, then run \`bun run build:mac\` again. If that window is not a dialog, \`bun run build:mac -- --no-dialog-check\` skips this check.`,
    );
  });

  test('without a prebuild: it fails before the close and before the scheme is written', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    const world = fakeWorld(root, {dialogs: [DIALOG, DIALOG]});

    const message = thrownBy(() =>
      prepare(root, {...INCREMENTAL, variant: 'preview'}, world.deps),
    );

    expect(world.calls).toEqual([CHECK, 'sleep 3s', CHECK, 'capture 2392']);
    expect(readFileSync(schemePath(root), 'utf8')).toBe(SCHEME_XML);
    expect(existsSync(join(root, 'ios', '.xcode.env.local'))).toBe(false);
    // The variant is kept, in the command to run again and in the off switch.
    expect(message).toContain(
      'then run `bun run mac -- --variant preview` again. If that window is not a dialog, `bun run mac -- --variant preview --no-dialog-check` skips this check.',
    );
  });

  test('none, could not check, or a dialog gone 3 s later: the run goes on', () => {
    for (const dialogs of [[NO_DIALOG], [UNKNOWN], [DIALOG, NO_DIALOG]]) {
      const root = appRoot();
      const world = fakeWorld(root, {dialogs});
      prepare(root, FULL, world.deps);
      expect([dialogs, world.calls.includes('prebuild preview')]).toEqual([
        dialogs,
        true,
      ]);
      expect(world.calls).not.toContain('capture 2392');
    }
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [UNKNOWN]});
    prepare(root, FULL, world.deps);
    expect(world.dialogLogs[0]).toBe(
      `Dialog check before anything in ios/ changes: could not check (${UNKNOWN_REASON}), so the run goes on.`,
    );
  });

  test('a picture that cannot be saved is one clause, and the run still stops', () => {
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [DIALOG, DIALOG]});
    world.deps.dialog.capture = () => ({
      reason: 'screencapture wrote no file',
      status: 'failed',
    });
    expect(thrownBy(() => prepare(root, FULL, world.deps))).toContain(
      'So this run stopped before it used Xcode. Nothing in ios/ has been changed. A picture of it could not be saved (screencapture wrote no file). Look at Xcode,',
    );
  });
});

describe('a dialog raised by the write stops the run before the build (D6, check 2)', () => {
  test('after the prebuild', () => {
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [NO_DIALOG, DIALOG, DIALOG]});

    const message = thrownBy(() => prepare(root, FULL, world.deps));

    expect(world.calls).toEqual([
      CHECK,
      'stop',
      WAIT,
      'close',
      'prebuild preview',
      CHECK,
      'sleep 3s',
      CHECK,
      'capture 2392',
    ]);
    expect(message).toContain(
      'So this run stopped before the build. The prebuild had already regenerated ios/; nothing has been built.',
    );
  });

  test('after the Run action change, on the incremental path', () => {
    const root = appRoot();
    writeGeneratedIos(root);
    const world = fakeWorld(root, {dialogs: [NO_DIALOG, DIALOG, DIALOG]});

    const message = thrownBy(() => prepare(root, INCREMENTAL, world.deps));

    expect(world.calls).toEqual([
      CHECK,
      'stop',
      WAIT,
      'close',
      CHECK,
      'sleep 3s',
      CHECK,
      'capture 2392',
    ]);
    expect(message).toContain(
      'So this run stopped before the build. The Run action in the scheme had already been set; nothing has been built.',
    );
    expect(message).toContain('then run `bun run mac` again.');
  });
});

describe('--no-dialog-check skips checks 1 and 2 here (check 3 is the load wait, tested there), and check 4 stays (D6)', () => {
  const OFF: MacBuildOptions = {...FULL, dialogCheck: false};

  test('a dialog that checks 1 and 2 would stop is not looked for', () => {
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [DIALOG, DIALOG, DIALOG, DIALOG]});
    prepare(root, OFF, world.deps);
    expect(world.calls).toEqual(['stop', WAIT, 'close', 'prebuild preview']);
    // The log says the checks are off, so a run's output shows the switch.
    expect(world.dialogLogs).toEqual([
      'Dialog checks off (--no-dialog-check): a dialog in Xcode will not stop this run.',
    ]);

    const incremental = appRoot();
    writeGeneratedIos(incremental);
    const second = fakeWorld(incremental, {dialogs: [DIALOG, DIALOG]});
    prepare(incremental, {...OFF, skipPrebuild: true}, second.deps);
    expect(second.calls).toEqual(['stop', WAIT, 'close']);
  });

  test('check 4 still reads the list after a -1712', () => {
    const root = appRoot();
    const world = fakeWorld(root, {
      close: {status: 'failed', stderr: TIMEOUT_STDERR},
      dialogs: [DIALOG],
    });
    const message = thrownBy(() => prepare(root, OFF, world.deps));
    expect(world.calls).toEqual(['stop', WAIT, 'close', CHECK, 'capture 2392']);
    expect(message).toContain(`and Xcode is showing ${DIALOG_NAME}`);
  });

  test('--no-launch runs no dialog check, with the check on', () => {
    const root = appRoot();
    const world = fakeWorld(root, {dialogs: [DIALOG, DIALOG]});
    prepare(root, {...FULL, launch: false}, world.deps);
    expect(world.calls).toEqual(['prebuild preview']);
  });
});

describe('a stop or close that gets no answer says whether a dialog is seen (D6, check 4)', () => {
  test('a dialog seen: "Xcode is showing a dialog", named, with its picture', () => {
    const root = appRoot();
    const world = fakeWorld(root, {
      close: {status: 'failed', stderr: TIMEOUT_STDERR},
      dialogs: [NO_DIALOG, DIALOG],
    });

    const message = thrownBy(() => prepare(root, FULL, world.deps));

    expect(world.calls).toEqual([
      CHECK,
      'stop',
      WAIT,
      'close',
      CHECK,
      'capture 2392',
    ]);
    expect(message).toBe(
      `Xcode did not answer within 60s when asked to close ${workspacePath(root)}, and Xcode is showing ${DIALOG_NAME} (problem 8 in \`bun run justin-sdk mac-build --problems\`). Nothing in ios/ has been changed. A picture of it: ${PICTURE}. Look at Xcode, answer the dialog, then run \`bun run build:mac\` again. Xcode reported: ${TIMEOUT_STDERR}`,
    );
    expect(message).not.toContain('probably');
  });

  test('could not check: "probably", and the log says it could not check', () => {
    const root = appRoot();
    const world = fakeWorld(root, {
      dialogs: [NO_DIALOG, UNKNOWN],
      stop: {status: 'failed', stderr: TIMEOUT_STDERR},
    });
    const message = thrownBy(() => prepare(root, FULL, world.deps));
    expect(message).toContain('so it is probably showing a dialog');
    expect(world.calls).toEqual([CHECK, 'stop', CHECK]);
    expect(world.logs.at(-1)).toBe(
      `Dialog check after Xcode did not answer: could not check (${UNKNOWN_REASON}).`,
    );
  });
});

describe('the stop and close scripts', () => {
  const PATH =
    '/Users/someone/Dev/example-app/ios/ExampleAppPreview.xcworkspace';

  test('each waits at most 60 s for Xcode, not 300', () => {
    expect(CLOSE_EVENT_TIMEOUT_SECONDS).toBe(60);
    for (const script of [
      stopWorkspaceAppScript(PATH),
      closeWorkspaceScript(PATH),
    ]) {
      expect(script).toContain('with timeout of 60 seconds');
      expect(script).not.toContain('with timeout of 300 seconds');
    }
  });

  test('each says whether it found the workspace', () => {
    const stop = stopWorkspaceAppScript(PATH);
    expect(stop).toContain('return "stopped"');
    expect(stop).toContain('return "absent"');
    const close = closeWorkspaceScript(PATH);
    expect(close).toContain('return "closed"');
    expect(close).toContain('return "absent"');
  });

  test('a stop that gets no answer is raised again, not swallowed by its try', () => {
    expect(stopWorkspaceAppScript(PATH)).toContain(
      '            on error errorMessage number errorNumber\n                if errorNumber is -1712 then error errorMessage number errorNumber\n',
    );
  });
});

/**
 * The order holds only if nothing else closes the workspace. This reads the
 * source: closeWorkspaceInXcode may be called from prepareIos alone, and
 * macBuild must call prepareIos.
 */
describe('mac-build.ts closes the workspace only in prepareIos', () => {
  const SOURCE_PATH = resolve(import.meta.dir, '..', 'src', 'mac-build.ts');
  const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

  function enclosingFunctionName(node: ts.Node): string | null {
    for (let at = node.parent; at != null; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name != null) return at.name.text;
    }
    return null;
  }

  /** Every function that calls `callee`, by name, in order of appearance. */
  function callersOf(text: string, callee: string): string[] {
    const source = ts.createSourceFile(
      'mac-build.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const callers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === callee
      ) {
        callers.push(enclosingFunctionName(node) ?? '(top level)');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return callers;
  }

  test('the real file', () => {
    expect(callersOf(SOURCE, 'closeWorkspaceInXcode')).toEqual([
      'prepareIos',
      'prepareIos',
    ]);
    expect(callersOf(SOURCE, 'prepareIos')).toEqual(['macBuild']);
  });

  test('negative control: a close put back after the terminal build is caught', () => {
    const anchor =
      '    ok(`Build succeeded in ${timer.elapsed()}${timer.waitNote()}.`);\n';
    expect(SOURCE).toContain(anchor);
    const reverted = SOURCE.replace(
      anchor,
      `${anchor}    closeWorkspaceInXcode(workspace, 'x', 'y', realCloseWorkspaceDeps());\n`,
    );
    expect(callersOf(reverted, 'closeWorkspaceInXcode')).toEqual([
      'prepareIos',
      'prepareIos',
      'macBuild',
    ]);
  });
});
