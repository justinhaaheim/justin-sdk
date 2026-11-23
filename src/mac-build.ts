/**
 * mac-build.ts — `justin-sdk mac-build`: build an Expo app on this Apple Silicon
 * Mac as a "Designed for iPad" app, launch it through Xcode, and copy it out of
 * DerivedData into ~/Applications so it survives a DerivedData wipe
 * (home-base-0jeya.1).
 *
 * Moved here from nature-sounds' scripts/build-mac.ts (itself a port of
 * audio-journal-1's) so every app shares one implementation. What used to be
 * constants — the variant, the scheme, the bundle id, the configuration — now
 * come from `componentConfig["mac-build"]` (mac-build-config.ts). The
 * measurements quoted below were taken in audio-journal-1 and nature-sounds; they
 * are the reason for the structure here, not claims about any one app's timings.
 *
 * WHY THIS EXISTS
 * A Mac build needs ios/<Scheme>.xcworkspace to exist and be current. After ANY
 * native change — or when ios/ was last prebuilt for a DIFFERENT variant, which
 * is the normal state wherever Detox and the simulator loop keep ios/ on
 * development — the workspace is missing or stale and the build fails or, worse,
 * builds the wrong app. So this regenerates the native project for the
 * configured variant first, then builds, then launches, then installs.
 *
 * SIDE EFFECT: this leaves ios/ prebuilt for the selected variant (and the
 * clean prebuild wipes ios/build). A repo's Detox build has to prebuild its own
 * variant again before it builds.
 *
 * WHO BUILDS, AND WHY IT DEPENDS ON THE PATH
 * Only Xcode can install and launch a Designed-for-iPad app on the Mac. The
 * product is an iOS binary (`LC_BUILD_VERSION platform IOS`); `open`ing it
 * directly fails with "incorrect executable format", and `xcrun devicectl` does
 * not list this Mac as a device at all, so there is no CLI install path. Xcode
 * installs it into a system-managed container (…/d/Wrapper/<Scheme>.app).
 * AppleScript `run` builds before it launches, so Xcode ALWAYS builds — which
 * makes any `xcodebuild` run beforehand duplicated work rather than a head start.
 *
 * Measured in audio-journal-1 on 2026-08-17: a CLI build immediately followed by
 * Xcode's build recompiled 856 of ~2,600 objects a second time (83 s), because
 * the two build requests differ (visible in XCBuildData/<hash>.xcbuilddata/
 * build-request.json) so task signatures differ and each side invalidates the
 * other's work. xcodebuild always adds ACTION / COLOR_DIAGNOSTICS /
 * diagnostic_message_length to its request, so a residual thrash cannot be fully
 * removed.
 *
 * So the builder is chosen per path rather than fixed:
 * - INCREMENTAL (--skip-prebuild) — Xcode alone. Nothing native changed and Xcode
 *   is already warm; adding xcodebuild here would cost pure thrash.
 * - AFTER A PREBUILD — xcodebuild first, then Xcode. `expo prebuild --clean` has
 *   just regenerated every pod, so this build is minutes long either way; running
 *   it in the terminal gets progress and real compiler errors instead of a silent
 *   wait on an Xcode window, and gates the Xcode step behind a build that
 *   compiled.
 * `xcodebuild` also serves --no-launch, and surfaces the errors when an
 * Xcode-alone build fails.
 *
 * INSTALLING INTO ~/Applications (nature-sounds-q6dw)
 * After a launch is CONFIRMED (full and fast paths), the bundle Xcode's Run just
 * installed (`<BUILT_PRODUCTS_DIR>/.XCInstall/<Scheme>.app`) is copied to
 * `~/Applications/<Scheme>.app`. Our own previous copy goes to ~/.Trash (never
 * deleted); anything else at that path is refused. The rules live in
 * mac-install.ts. `--no-launch` has no Xcode install to copy, so it leaves
 * ~/Applications alone and says so; `--install-only` copies the last Xcode
 * install without building.
 *
 * The package.json scripts the `mac-build` component writes:
 *   bun run build:mac            full: prebuild -> build -> launch -> install
 *   bun run mac                  fast incremental: build -> launch -> install
 *   bun run build:mac:no-launch  build only, in the terminal (no Xcode, no install)
 *   bun run mac:install          install the last Xcode-installed build
 * Each takes `-- --variant <name>` to build a variant named under "variants" in
 * the config instead of the default (home-base-0jeya.9). Its scheme is different,
 * so it installs as a different app and the two sit side by side in ~/Applications.
 *
 * JS-only changes do not need this: ship them with EAS Update. Run it when
 * native code or dependencies changed.
 *
 * SIGNING WAITS FOR AN UNLOCKED SCREEN (home-base-di8c7.1). Every xcodebuild
 * run and Xcode's own build first wait for an unlocked screen (signing-guard.ts),
 * because a signing build that starts while the screen is locked makes Xcode
 * delete its Apple account. JUSTIN_SDK_SIGNING_GUARD=off turns the wait off.
 * The timings this prints leave that wait out and name it separately.
 *
 * XCODE NEVER HOLDS A WORKSPACE THAT IS REWRITTEN (home-base-0jeya.13, D5).
 * Before a prebuild, or a Run action change on the incremental path, the
 * workspace is closed in Xcode (the app stopped first), if Xcode has it open:
 * prepareIos. The stop and the close each get 60 s, and one that gets no
 * answer fails at once, naming the dialog Xcode is probably showing.
 *
 * A DIALOG IN XCODE STOPS THE RUN WITH ITS NAME (home-base-0jeya.13, D6).
 * While Xcode shows a dialog it may not answer mac-build, and the workspace may
 * not load; only the window server's list shows one
 * (mac-build-xcode-dialog.ts). Check 1: before the run uses Xcode or writes
 * ios/, and check 2: right after the prebuild or the Run action write, a
 * dialog seen twice 3 s apart stops the run at once (prepareIos). Check 3:
 * during the load wait, 30 s of the same dialog stops it (mac-build-xcode.ts).
 * `--no-dialog-check` turns off those three. Check 4: a stop or close that
 * gets no answer says "Xcode is showing a dialog" when one is seen
 * (failCloseStep).
 *
 * KNOWN PROBLEMS (home-base-0jeya.13, D2). docs/mac-build-problems.md lists the
 * Designed-for-iPad build problems found so far, each with its message, cause
 * and fix; `justin-sdk mac-build --problems` prints it, and every failure ends
 * with a line naming that command. A problem found in one app goes there.
 */

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {paint, shouldStyle} from './cli-style';
import {
  MAC_BUILD_CONFIG_EXAMPLE,
  MAC_BUILD_CONFIG_KEY,
  MAC_BUILD_VARIANTS_EXAMPLE,
  type MacBuildConfig,
  readMacBuildConfig,
  selectMacBuildVariant,
} from './mac-build-config';
import {
  appleScriptString,
  isAppleEventTimeout,
  type LoadWaitDialogCheck,
  openWorkspaceAndWaitForLoad,
  type OsascriptRun,
  realWorkspaceOpenDeps,
  runOsascript,
} from './mac-build-xcode';
import {
  checkForSteadyDialog,
  describeXcodeDialogs,
  DIALOG_PROBLEM,
  DIALOG_RECHECK_SECONDS,
  DIALOG_WHY,
  MAC_BUILD_PROBLEMS_COMMAND,
  NO_DIALOG_CHECK_FLAG,
  pictureClause,
  realXcodeDialogCheckDeps,
  realXcodeDialogDeps,
  type XcodeDialogCheckDeps,
  type XcodeDialogDeps,
} from './mac-build-xcode-dialog';
import {installToApplications, parseBuiltProductsDir} from './mac-install';
import {
  assertUnlockedForSigning,
  formatWait,
  type SigningGuardProceed,
} from './signing-guard';
import {writeStdoutSync} from './write-stdout';

/** Where the install step puts the app, and where our previous copy goes. */
const APPLICATIONS_DIR = path.join(os.homedir(), 'Applications');
const TRASH_DIR = path.join(os.homedir(), '.Trash');

/**
 * RCT_USE_PREBUILT_RNCORE=0 — build React Native from source for the Mac build.
 *
 * RN 0.81+ ships a prebuilt ReactNativeDependencies.xcframework with no
 * "Designed for iPad"/Mac slice, so the Mac build links
 * @rpath/ReactNativeDependencies.framework but never embeds it — the app then
 * crashes at launch with dyld "Library not loaded" and no window ever appears.
 * Building from source avoids the prebuilt framework entirely. (Device/EAS builds
 * don't run this command, so they keep the faster prebuilt.)
 *
 * POD INSTALL is what consumes this, so it is scoped to the prebuild step alone
 * rather than exported process-wide: xcodebuild folds environment variables into
 * the build settings it hands every target, and a setting that means nothing at
 * compile time has no business being one. With --skip-prebuild there is no pod
 * install, so the build simply inherits whatever the last one chose.
 */
const PREBUILD_ENV = {RCT_USE_PREBUILT_RNCORE: '0'};

/** How long to wait for Xcode's build to reach a terminal status. */
const IDE_BUILD_TIMEOUT_SECONDS = 900;
/**
 * Ceiling for a SINGLE Apple Event in the build-and-run script, not for the
 * build: the build is watched by polling `status`, and each poll is its own
 * quick event. AppleScript's default of 120 s is too short — Xcode can go
 * minutes without answering while it takes in a workspace — but raising this to
 * the build timeout would turn "Xcode is never going to answer" into a
 * 15-minute hang. The open is not under it: it is sent without waiting for a
 * reply, and the load is polled (mac-build-xcode.ts, D1). The stop and the
 * close have their own, shorter limit (CLOSE_EVENT_TIMEOUT_SECONDS).
 */
const APPLE_EVENT_TIMEOUT_SECONDS = 300;
/**
 * Ceiling for each Apple Event in the stop and close scripts (home-base-0jeya.13,
 * D5). They run before anything rewrites ios/, so Xcode has nothing new to take
 * in and answers at once; one that has not answered in 60 s is almost certainly
 * blocked on a dialog, and waiting longer clears nothing. Measured 2026-11-21 at
 * 2:07am in health-logger-rn: the close, sent after the prebuild had
 * regenerated the open workspace, got no answer for its whole 300 s.
 */
export const CLOSE_EVENT_TIMEOUT_SECONDS = 60;
/**
 * How long to wait for the relaunched app to show up in the process list. It
 * normally appears within seconds; the ceiling is high because waiting longer
 * than necessary costs nothing on a path that just spent minutes compiling,
 * while reporting "not launched" too early would be a false alarm.
 */
const LAUNCH_WAIT_SECONDS = 240;
/** How long to give the app to exit after Xcode is told to stop it. */
const APP_EXIT_WAIT_SECONDS = 20;
/**
 * How long to wait for Xcode to work out that it can run this scheme on this Mac.
 * A warm Xcode answers immediately; one that has just taken in a regenerated
 * project can answer "could not find any valid run destinations" (-10008) for
 * minutes first, so this polls rather than asking once. It is a ceiling, not a
 * cost. Note that exhausting it is a genuine dead end rather than slowness —
 * Xcode blocked on a modal dialog reports exactly the same thing forever, and no
 * amount of waiting clears that.
 */
const DESTINATION_WAIT_SECONDS = 600;
/**
 * How many unreadable build-status answers in a row (one a second) before the
 * Xcode step stops waiting for a status and requests the launch anyway — see
 * the status loop in buildAndLaunchWithXcode.
 */
const STATUS_UNREADABLE_LIMIT = 10;

const COLOR = shouldStyle(process.stdout);
const ERROR_COLOR = shouldStyle(process.stderr);
const TAG = '[mac-build]';

function log(message: string): void {
  console.log(`${paint(TAG, ['yellow'], COLOR)} ${message}`);
}

function ok(message: string): void {
  console.log(`${paint(TAG, ['green'], COLOR)} ${message}`);
}

/** Stop the run with a message for a person (no stack: this is not a bug). */
function fail(message: string): never {
  throw new Error(message);
}

/** How long a signing guard that let a step through spent waiting. */
function signingWaitOf(proceed: SigningGuardProceed): number {
  return proceed.checked ? proceed.waitedSeconds : 0;
}

export interface BuildTimer {
  /** Count time a signing guard spent waiting for an unlocked screen. */
  addSigningWait: (seconds: number) => void;
  /** Seconds since the start, minus the signing waits: "170s". */
  elapsed: () => string;
  /** "" with no wait; otherwise " (not counting 3 min 5 s spent waiting …)". */
  waitNote: () => string;
}

/**
 * The clock behind "Build succeeded in N s" and "built + launched in N s". It
 * leaves out the time a signing guard spent waiting for an unlocked screen, and
 * waitNote names that wait separately (home-base-0jeya.13, a di8c7.1 review
 * residual): a build that waited 20 minutes for the unlock did not take 20
 * minutes.
 */
export function startBuildTimer(now: () => number = Date.now): BuildTimer {
  const startedMs = now();
  let waitedSeconds = 0;
  return {
    addSigningWait: (seconds) => {
      waitedSeconds += seconds;
    },
    elapsed: () =>
      `${Math.max(0, Math.round((now() - startedMs) / 1000 - waitedSeconds))}s`,
    waitNote: () =>
      Math.round(waitedSeconds) > 0
        ? ` (not counting ${formatWait(waitedSeconds)} spent waiting for an unlocked screen)`
        : '',
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The line every mac-build failure ends with (D2). */
export const MAC_BUILD_PROBLEMS_POINTER = `Known Mac build problems and their fixes: \`${MAC_BUILD_PROBLEMS_COMMAND}\``;

/**
 * The known-problems list. Read relative to this module, so it is found from
 * any directory; it ships because package.json "files" includes docs.
 */
export const MAC_BUILD_PROBLEMS_PATH = path.join(
  import.meta.dirname,
  '..',
  'docs',
  'mac-build-problems.md',
);

export interface MacBuildOptions {
  /**
   * Whether to look for a dialog in Xcode before using it and after writing
   * ios/ (D6, checks 1 and 2); `--no-dialog-check` makes it false. Checks 3
   * and 4 do not depend on it.
   */
  dialogCheck: boolean;
  /** Copy the last Xcode install into ~/Applications; no prebuild, build or launch. */
  installOnly: boolean;
  launch: boolean;
  /** Print the known-problems list and do nothing else. */
  problems: boolean;
  skipPrebuild: boolean;
  /** What `--variant` asked for; null builds the configured default. */
  variant: string | null;
}

/** A combination of flags that cannot mean anything, or null when they are fine. */
export function conflictingOptions(options: MacBuildOptions): string | null {
  if (
    options.problems &&
    (options.installOnly ||
      options.skipPrebuild ||
      !options.launch ||
      !options.dialogCheck ||
      options.variant != null)
  ) {
    return '--problems prints the list of known Mac build problems and does nothing else, so it takes no other option.';
  }
  if (options.installOnly && (options.skipPrebuild || !options.launch)) {
    return '--install-only builds nothing, so --skip-prebuild and --no-launch mean nothing with it.';
  }
  if (!options.dialogCheck && (options.installOnly || !options.launch)) {
    return '--no-dialog-check skips the checks for a dialog in the Xcode app, which --install-only and --no-launch never use, so it means nothing with them.';
  }
  return null;
}

/**
 * The full build a message tells someone to run. It keeps the variant that was
 * asked for: the bare command would build the default, and the same failure would
 * come straight back.
 */
function fullBuildCommand(variant: string | null): string {
  return variant == null
    ? 'bun run build:mac'
    : `bun run build:mac -- --variant ${variant}`;
}

/** The incremental build (no prebuild), keeping the variant the same way. */
function incrementalBuildCommand(variant: string | null): string {
  return variant == null
    ? 'bun run mac'
    : `bun run mac -- --variant ${variant}`;
}

/**
 * This Mac's provisioning UDID — the xcodebuild destination for "My Mac
 * (Designed for iPad)". Auto-detected so the command isn't pinned to one
 * machine; override with MAC_DEST_ID. Returns null when it cannot be read, never
 * a plausible-looking blank that xcodebuild would resolve to some other device.
 */
function detectMacDestinationId(): string | null {
  const fromEnv = process.env.MAC_DEST_ID;
  if (fromEnv != null && fromEnv !== '') {
    return fromEnv;
  }
  try {
    const output = execFileSync('system_profiler', ['SPHardwareDataType'], {
      encoding: 'utf8',
      // system_profiler logs unrelated os_log noise to stderr; drop it.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /Provisioning UDID:\s*(\S+)/.exec(output);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface Workspace {
  /** Absolute path, for Xcode. */
  absolutePath: string;
  /** Repo-relative path, for xcodebuild invoked with cwd = the project root. */
  relativePath: string;
  /** Also the generated project name, and the scheme to build. */
  scheme: string;
}

/**
 * Where the selected variant's workspace is, or will be once a prebuild has
 * written it. Computed, not found: the close before a prebuild needs the path
 * whether or not the folder exists yet (home-base-0jeya.13, D5).
 */
function workspaceAt(projectRoot: string, scheme: string): Workspace {
  const relativePath = path.join('ios', `${scheme}.xcworkspace`);
  return {
    absolutePath: path.join(projectRoot, relativePath),
    relativePath,
    scheme,
  };
}

/**
 * Locate the SELECTED variant's workspace specifically.
 *
 * Deliberately not "whichever single workspace is in ios/": the simulator loop
 * keeps ios/ prebuilt for development in most repos, so a different workspace is
 * routinely sitting there, and a --skip-prebuild run would otherwise build and
 * launch the wrong variant without saying anything.
 *
 * `configKey` is where the scheme is written (mac-build-config.ts). `remedy` is
 * the advice when it is missing, which depends on the caller.
 */
function findWorkspace(
  projectRoot: string,
  config: MacBuildConfig,
  configKey: string,
  remedy: string,
): Workspace {
  const workspace = workspaceAt(projectRoot, config.scheme);
  const {relativePath} = workspace;

  if (!fs.existsSync(workspace.absolutePath)) {
    const iosDir = path.join(projectRoot, 'ios');
    const present = fs.existsSync(iosDir)
      ? fs.readdirSync(iosDir).filter((name) => name.endsWith('.xcworkspace'))
      : [];
    fail(
      `${relativePath} not found${
        present.length > 0
          ? ` (ios/ currently holds: ${present.join(', ')})`
          : ''
      }. Either ios/ is prebuilt for a different variant, or "scheme" in ${configKey} does not match the workspace Expo generates for "${config.variant}" — ${remedy}`,
    );
  }

  return workspace;
}

/**
 * Fail fast when the generated project names no signing team.
 *
 * `xcodebuild` never picks a team itself (`expo run:ios` does, which is why an
 * app can build for a device for months without one), so a project with no
 * DEVELOPMENT_TEAM compiles for minutes and then stops on "Signing for <target>
 * requires a development team" — measured on health-logger-rn, 2026-10-21. Expo
 * writes the team from `ios.appleTeamId` at prebuild; checking for it here turns
 * that into a one-line failure before anything compiles. An unreadable project
 * file is a failure too, never a pass.
 */
export function assertSigningTeam(
  projectRoot: string,
  scheme: string,
  buildCommand: string = fullBuildCommand(null),
): void {
  const pbxprojPath = path.join(
    projectRoot,
    'ios',
    `${scheme}.xcodeproj`,
    'project.pbxproj',
  );
  let text: string;
  try {
    text = fs.readFileSync(pbxprojPath, 'utf8');
  } catch (error) {
    fail(
      `Could not read ${pbxprojPath} to check its signing team: ${describeError(error)}`,
    );
  }
  if (!/\bDEVELOPMENT_TEAM = "?[A-Z0-9]+"?;/.test(text)) {
    fail(
      `The generated project has no DEVELOPMENT_TEAM (${pbxprojPath}), so xcodebuild cannot sign it. Set \`ios.appleTeamId\` in the app config (app.config.ts or app.json) to your Apple Developer team id, then run \`${buildCommand}\` again so the prebuild writes it.`,
    );
  }
}

/**
 * Refuse `expo prebuild --clean` when git tracks anything under ios/.
 *
 * `--clean` deletes ios/ and regenerates it. That is only safe for a CNG project,
 * where ios/ is gitignored and wholly generated; in a bare-workflow repo the same
 * step would destroy committed native code. Every repo this was written for is
 * CNG (checked 2026-10-21: no tracked ios/ files in any of them), so this costs
 * nothing there. A git failure is "could not check", and it refuses too.
 */
export function assertIosNotTracked(projectRoot: string): void {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '--', 'ios'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as {stderr?: unknown}).stderr;
    const reason =
      typeof stderr === 'string' && stderr.trim() !== ''
        ? stderr.trim()
        : describeError(error);
    fail(
      `Could not check whether git tracks anything under ios/ (\`git ls-files -- ios\` failed: ${reason}). Refusing to run \`expo prebuild --clean\`, which deletes ios/.`,
    );
  }
  const tracked = output.split('\n').filter((line) => line !== '');
  if (tracked.length > 0) {
    fail(
      `git tracks ${tracked.length} file(s) under ios/ (first: ${tracked[0]}), so this is not a CNG project and \`expo prebuild --clean\` would delete committed native code. Refusing. mac-build supports only projects whose ios/ is generated and gitignored.`,
    );
  }
}

/**
 * The Run action's settings this command needs, as `<LaunchAction>` attributes.
 *
 * - `buildConfiguration`: Expo generates "Debug", and the AppleScript launch path
 *   below goes through Xcode's Run action — so without this, Xcode would build
 *   and install a DEBUG app (no embedded JS, dev launcher compiled in) no matter
 *   what was asked for.
 * - No debugger ("Debug executable" unchecked in the scheme editor). Measured
 *   2026-10-22 on Xcode 27.1 with both health-logger-rn and screenshot-app: with
 *   LLDB attached, Xcode launched the app suspended ("the debugger is
 *   responsible for resuming"), spent 151 s in "Configuring Debugger Actions",
 *   and the app never ran — no window, no console output, and no process the
 *   launch check could see. A daily-driver build has no use for the debugger,
 *   and without it Xcode launches the app as an ordinary process. (On Xcode 27.0
 *   the debugger-attached launch worked: nature-sounds, 2026-10-12.)
 */
function launchActionAttributes(configuration: string): Record<string, string> {
  return {
    buildConfiguration: configuration,
    selectedDebuggerIdentifier: '',
    selectedLauncherIdentifier: 'Xcode.IDEFoundation.Launcher.PosixSpawn',
  };
}

/**
 * What pointing the Run action at this command's settings would write: the
 * scheme file, and its new text, or null when it already holds them. Reads
 * only; applyLaunchAction writes. Split so the incremental path can close the
 * workspace in Xcode BEFORE the scheme changes under it, and only when it will
 * (home-base-0jeya.13, D5).
 */
export interface LaunchActionPlan {
  configuration: string;
  /** The patched scheme text, or null when the file already holds it. */
  patched: string | null;
  schemePath: string;
}

/**
 * Work out the Run action patch (launchActionAttributes) without writing it.
 *
 * Patching a generated file is fine HERE specifically because this command owns
 * the generation step: it re-applies the patch on every run, and `--clean`
 * regenerates the scheme. Nothing else depends on it.
 *
 * Only the LaunchAction is touched — `buildConfiguration` also appears on
 * TestAction and AnalyzeAction, and a blanket replace would corrupt those. Each
 * attribute must already be present: a scheme of another shape fails loudly
 * rather than being half-patched.
 */
export function planLaunchAction(
  projectRoot: string,
  scheme: string,
  configuration: string,
): LaunchActionPlan {
  const schemePath = path.join(
    projectRoot,
    'ios',
    `${scheme}.xcodeproj`,
    'xcshareddata',
    'xcschemes',
    `${scheme}.xcscheme`,
  );

  if (!fs.existsSync(schemePath)) {
    fail(`Scheme not found, cannot set the Run action: ${schemePath}`);
  }

  const original = fs.readFileSync(schemePath, 'utf8');

  const tagStart = original.indexOf('<LaunchAction');
  if (tagStart === -1) {
    fail(`No <LaunchAction> in ${schemePath}.`);
  }
  const tagEnd = original.indexOf('>', tagStart);
  if (tagEnd === -1) {
    fail(`Malformed <LaunchAction> in ${schemePath}.`);
  }

  const openingTag = original.slice(tagStart, tagEnd);
  let patchedTag = openingTag;
  for (const [name, value] of Object.entries(
    launchActionAttributes(configuration),
  )) {
    const attribute = new RegExp(`\\b${name} = "[^"]*"`);
    if (!attribute.test(patchedTag)) {
      fail(
        `Could not set ${name} on <LaunchAction> in ${schemePath} — the attribute is not there, so its shape is not the one Expo generates.`,
      );
    }
    patchedTag = patchedTag.replace(attribute, `${name} = "${value}"`);
  }

  return {
    configuration,
    patched:
      patchedTag === openingTag
        ? null
        : original.slice(0, tagStart) + patchedTag + original.slice(tagEnd),
    schemePath,
  };
}

/** Write a planned Run action patch. Returns whether the scheme file changed. */
export function applyLaunchAction(plan: LaunchActionPlan): boolean {
  if (plan.patched == null) {
    ok(`Xcode Run action already ${plan.configuration}, without the debugger.`);
    return false;
  }
  fs.writeFileSync(plan.schemePath, plan.patched);
  ok(`Xcode Run action set to ${plan.configuration}, without the debugger.`);
  return true;
}

/**
 * Point the Xcode Run action at what this command needs (planLaunchAction, then
 * applyLaunchAction). Returns whether the scheme file changed.
 */
export function configureLaunchAction(
  projectRoot: string,
  scheme: string,
  configuration: string,
): boolean {
  return applyLaunchAction(
    planLaunchAction(projectRoot, scheme, configuration),
  );
}

/**
 * Pin APP_VARIANT for the Xcode script phases.
 *
 * An app.config.ts typically defaults APP_VARIANT to 'development' when the env
 * var is absent, and the Release bundle phase shells out to `expo export:embed`,
 * which re-reads that config to build the embedded manifest (channel,
 * runtimeVersion). An Xcode IDE build gets no environment from this command, so
 * without this the embedded bundle would be configured for the WRONG variant
 * while the Info.plist around it named the right one.
 *
 * `ios/.xcode.env.local` is the supported hook — the generated bundle phase
 * sources it, last, as the override file. It is regenerated content inside
 * gitignored ios/, and prebuild rewrites it with only NODE_BINARY, so this
 * appends on every run rather than assuming it persists.
 */
export function pinVariantForXcodeBuildPhases(
  projectRoot: string,
  variant: string,
): void {
  const envPath = path.join(projectRoot, 'ios', '.xcode.env.local');
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : '';

  const withoutStaleVariant = existing
    .split('\n')
    .filter((line) => !line.trim().startsWith('export APP_VARIANT='))
    .join('\n')
    .replace(/\n+$/, '');

  const contents =
    (withoutStaleVariant === '' ? '' : `${withoutStaleVariant}\n`) +
    `export APP_VARIANT=${variant}\n`;

  fs.writeFileSync(envPath, contents);
  ok(`Pinned APP_VARIANT=${variant} for the Xcode build phases.`);
}

function runInherit(
  projectRoot: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): void {
  execFileSync(command, args, {
    cwd: projectRoot,
    env: {...process.env, ...env},
    stdio: 'inherit',
  });
}

function prebuild(projectRoot: string, config: MacBuildConfig): void {
  assertIosNotTracked(projectRoot);
  log(
    `Regenerating the native iOS project for the ${config.variant.toUpperCase()} variant (clean; RN from source)…`,
  );
  try {
    // Best effort: refreshes dynamic-version.local.json. A failure here must not
    // block the build, but it is not silently treated as success either.
    runInherit(
      projectRoot,
      'npx',
      ['@justinhaaheim/version-manager', '--no-fail'],
      {APP_VARIANT: config.variant},
    );
  } catch {
    log('version-manager failed; continuing without a version refresh.');
  }
  runInherit(
    projectRoot,
    'npx',
    ['expo', 'prebuild', '--clean', '--platform', 'ios'],
    {APP_VARIANT: config.variant, ...PREBUILD_ENV},
  );
  ok('Prebuild complete.');
}

/**
 * Which build xcodebuild is talking about: this checkout's workspace, the
 * scheme, the configuration and the Mac destination. Shared by the build and by
 * the build-settings query, so the install step asks about exactly the build
 * that was made. Relative workspace path: xcodebuild runs with cwd = the root.
 */
function xcodebuildTargetArgs(
  workspace: Workspace,
  config: MacBuildConfig,
  macDestId: string,
): string[] {
  return [
    '-workspace',
    workspace.relativePath,
    '-scheme',
    workspace.scheme,
    '-destination',
    `id=${macDestId}`,
    '-configuration',
    config.configuration,
  ];
}

/**
 * The one failure every app hits the same way, so it is named after every
 * failed terminal build. Measured 2026-10-21: xcodebuild reported "No Accounts"
 * for health-logger-rn and screenshot-app from a Claude Code session AND from
 * Justin's own terminal, although Xcode lists an Apple ID, then fell back to the
 * wildcard "iOS Team Provisioning Profile: *", which lacks App Groups and push.
 * Apps whose cached profile already covers their capabilities kept building,
 * which is why it looked app-specific. The newest profile Xcode had fetched was
 * 2026-10-07; Xcode 27.1 was installed 2026-10-19 (that the update dropped the
 * sign-in is inferred). The cause shown on 2026-11-20 (home-base-di8c7): a
 * signing build that STARTS while the screen is locked makes Xcode delete the
 * account, which is why every signing step here now waits for an unlocked
 * screen first (runXcodebuild, buildAndLaunchWithXcode).
 */
const SIGNING_HINT =
  'If they say "No Accounts", or that a provisioning profile lacks a capability (App Groups, Push Notifications), xcodebuild could not use an Xcode account to create this app’s profile. If the Apple account has vanished from Xcode, the likely reason is a signing build that started while the screen was locked (home-base-di8c7); this command now waits for an unlocked screen before each signing step. Apps whose cached profile already covers them still build, so this can hit one app and not another. Sign in again in Xcode > Settings > Accounts (or add your Apple ID), then run this again. The full error list of the last build is in its Logs/Build folder under ~/Library/Developer/Xcode/DerivedData.';

const XCODEBUILD_FAILED = `xcodebuild failed; its errors are above. ${SIGNING_HINT}`;

/**
 * An xcodebuild run that started: its stdout (when captured), or its error, and
 * how long its signing guard waited for an unlocked screen first.
 */
type XcodebuildRun = {signingWaitSeconds: number} & (
  | {error: unknown; status: 'failed'}
  | {status: 'ok'; stdout: string}
);

/**
 * THE ONE PLACE this file spawns xcodebuild (home-base-di8c7.1). It asks the
 * signing guard first, immediately before the spawn (D7): every xcodebuild call
 * may read the Apple account, the build with -allowProvisioningUpdates
 * certainly and the -showBuildSettings query possibly, and unknown is not safe.
 *
 * A guard stop THROWS, so its message reaches runMacBuild whole. A failed
 * xcodebuild is RETURNED, so no caller's catch can turn a guard stop into
 * "xcodebuild failed". tests/mac-build-signing-guard.test.ts fails when
 * xcodebuild is spawned anywhere else in this file, or this guard call moves or
 * goes.
 */
function runXcodebuild(
  projectRoot: string,
  what: string,
  args: string[],
  output: {capture: false; env: Record<string, string>} | {capture: true},
): XcodebuildRun {
  const signing = assertUnlockedForSigning({what});
  const signingWaitSeconds = signingWaitOf(signing);
  try {
    if (output.capture) {
      const stdout = execFileSync('xcodebuild', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        // ~110 KB per target measured; generous so a big project cannot truncate it.
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {signingWaitSeconds, status: 'ok', stdout};
    }
    execFileSync('xcodebuild', args, {
      cwd: projectRoot,
      env: {...process.env, ...output.env},
      stdio: 'inherit',
    });
    return {signingWaitSeconds, status: 'ok', stdout: ''};
  } catch (error) {
    return {error, signingWaitSeconds, status: 'failed'};
  }
}

/**
 * Build in the terminal — the only way to see progress and read compiler errors
 * without opening Xcode's UI. Used for --no-launch, for the cold build right
 * after a prebuild, and to surface the errors when an Xcode-alone build fails.
 * `ok` is false when xcodebuild failed (its errors are on the terminal); a
 * signing-guard stop throws.
 */
function buildWithXcodebuild(
  projectRoot: string,
  workspace: Workspace,
  config: MacBuildConfig,
  macDestId: string,
): {ok: boolean; signingWaitSeconds: number} {
  // APP_VARIANT is belt and braces alongside .xcode.env.local: this one covers
  // the CLI build even if that file were ever missing.
  const run = runXcodebuild(
    projectRoot,
    `the xcodebuild build of ${workspace.scheme}`,
    [
      ...xcodebuildTargetArgs(workspace, config, macDestId),
      '-allowProvisioningUpdates',
      '-allowProvisioningDeviceRegistration',
      'build',
    ],
    {capture: false, env: {APP_VARIANT: config.variant}},
  );
  return {
    ok: run.status === 'ok',
    signingWaitSeconds: run.signingWaitSeconds,
  };
}

/**
 * Xcode's BUILT_PRODUCTS_DIR for this checkout's build — the only way to find
 * its DerivedData folder. Never a glob: a Mac with a worktree of the same app has
 * more than one <Scheme>-* folder there.
 */
function readBuiltProductsDir(
  projectRoot: string,
  workspace: Workspace,
  config: MacBuildConfig,
  macDestId: string,
): string {
  const args = [
    ...xcodebuildTargetArgs(workspace, config, macDestId),
    '-showBuildSettings',
    '-json',
  ];
  const command = `xcodebuild ${args.join(' ')}`;
  const run = runXcodebuild(
    projectRoot,
    `the xcodebuild build-settings query for ${workspace.scheme}`,
    args,
    {capture: true},
  );
  if (run.status === 'failed') {
    const stderr = (run.error as {stderr?: unknown}).stderr;
    const detail =
      typeof stderr === 'string' && stderr.trim() !== ''
        ? `\n${stderr.trim()}`
        : '';
    fail(
      `Could not read Xcode's build settings: \`${command}\` failed.${detail}`,
    );
  }
  try {
    return parseBuiltProductsDir(run.stdout, workspace.scheme);
  } catch (error) {
    fail(
      `Could not find the build products from \`${command}\`: ${describeError(error)}`,
    );
  }
}

/**
 * Copy the app Xcode's Run just installed into ~/Applications (mac-install.ts
 * holds the rules). Throws, with the reason, whenever ~/Applications was not
 * updated — a failed install is never reported as done.
 */
function installIntoApplications(
  projectRoot: string,
  workspace: Workspace,
  config: MacBuildConfig,
  macDestId: string,
): void {
  log(`Installing ${workspace.scheme} into ${APPLICATIONS_DIR}…`);
  let outcome: ReturnType<typeof installToApplications>;
  try {
    outcome = installToApplications({
      builtProductsDir: readBuiltProductsDir(
        projectRoot,
        workspace,
        config,
        macDestId,
      ),
      bundleId: config.bundleId,
      log,
      now: new Date(),
      scheme: workspace.scheme,
      targetDir: APPLICATIONS_DIR,
      trashDir: TRASH_DIR,
    });
  } catch (error) {
    fail(`${APPLICATIONS_DIR} NOT updated: ${describeError(error)}`);
  }
  ok(
    `Installed ${outcome.installedPath} (CFBundleVersion ${outcome.bundleVersion}, verified).${
      outcome.previousMovedTo == null
        ? ''
        : ` The previous copy is in the Trash: ${outcome.previousMovedTo}`
    }`,
  );
}

/**
 * No end anchor: Xcode appends its own launch arguments
 * (-NSDocumentRevisionsDebugMode YES) after the executable path. The scheme is
 * letters and digits only (mac-build-config.ts), so it needs no regex escaping.
 */
function appProcessPattern(scheme: string): string {
  return `Wrapper/${scheme}\\.app/${scheme}`;
}

/**
 * PIDs of the Designed-for-iPad app currently running on this Mac, or null when
 * the process list could not be read — null is "don't know", never "none
 * running", so an unreadable list can't be mistaken for a confirmed launch.
 *
 * The running binary is always inside a wrapper's Wrapper/<Scheme>.app: Xcode
 * 27.0 launched it from a system-managed container (…/d/Wrapper/<Scheme>.app),
 * Xcode 27.1 from the install itself
 * (<BUILT_PRODUCTS_DIR>/.XCInstall/<Scheme>.app, per its 2026-10-22 run logs),
 * and a copy in ~/Applications has the same layout.
 */
function runningAppPids(scheme: string): Set<string> | null {
  try {
    const output = execFileSync('pgrep', ['-f', appProcessPattern(scheme)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(output.split('\n').filter((line) => line !== ''));
  } catch (error) {
    // pgrep exits 1 for "no matches" — that is a real, empty answer. Anything
    // else means the question went unanswered.
    const status = (error as {status?: unknown}).status;
    return status === 1 ? new Set<string>() : null;
  }
}

/**
 * Wait for an app instance that wasn't running before, so "launched" is an
 * observation. Xcode terminates the previous instance and starts a new one, so a
 * NEW pid — not merely a pid — is what distinguishes a relaunch from the app that
 * was already up.
 */
function waitForNewAppInstance(
  scheme: string,
  before: Set<string> | null,
  timeoutSeconds: number,
): boolean {
  if (before == null) {
    return false;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const now = runningAppPids(scheme);
    if (now != null && [...now].some((pid) => !before.has(pid))) {
      return true;
    }
    execFileSync('sleep', ['1']);
  }
  return false;
}

/** Whether the app is gone. An unreadable process list counts as "not gone". */
function waitForAppToExit(scheme: string, timeoutSeconds: number): boolean {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const pids = runningAppPids(scheme);
    if (pids?.size === 0) {
      return true;
    }
    execFileSync('sleep', ['1']);
  }
  return false;
}

/** Run an AppleScript, throwing its stderr as the message on failure. */
function osascript(script: string, what: string): string {
  const run = runOsascript(script);
  if (run.status === 'ok') {
    return run.stdout;
  }
  fail(
    run.stderr != null
      ? `${what} — Xcode reported: ${run.stderr}`
      : `${what} — Xcode failed without reporting a reason.`,
  );
}

/**
 * Asks Xcode to stop the app running from the workspace at `workspacePath`
 * (closeWorkspaceInXcode's first step). Prints `not running` when Xcode is not
 * running, and sends Xcode nothing then; `absent` when Xcode does not list the
 * workspace; `stopped` once it has asked Xcode to stop it.
 *
 * The running test sits BEFORE the `tell` block, as `application "Xcode" is
 * not running`. Inside `tell application "Xcode"`, the form that tests `it`
 * is always true (measured 2026-11-21), so from 2026-10-21 until this fix
 * the stop and the close never ran (docs/mac-build-problems.md, problem 12).
 *
 * A stop that fails is ignored (there may be no app to stop), except a stop
 * that got no answer: that is raised again as -1712, so a blocked Xcode fails
 * here at once rather than again at the close (D5).
 */
export function stopWorkspaceAppScript(workspacePath: string): string {
  return `
if application "Xcode" is not running then return "not running"
with timeout of ${CLOSE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${appleScriptString(workspacePath)} then
            try
                stop theDocument
            on error errorMessage number errorNumber
                if errorNumber is -1712 then error errorMessage number errorNumber
            end try
            return "stopped"
        end if
    end repeat
    return "absent"
end tell
end timeout
`;
}

/**
 * Asks Xcode to close the workspace at `workspacePath` (closeWorkspaceInXcode's
 * last step). Prints `not running` when Xcode is not running, and sends Xcode
 * nothing then; `absent` when Xcode does not list the workspace; `closed` once
 * Xcode has closed it. Its running test is placed as in stopWorkspaceAppScript.
 */
export function closeWorkspaceScript(workspacePath: string): string {
  return `
if application "Xcode" is not running then return "not running"
with timeout of ${CLOSE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${appleScriptString(workspacePath)} then
            close theDocument
            return "closed"
        end if
    end repeat
    return "absent"
end tell
end timeout
`;
}

/** What closing the workspace in Xcode needs from the world; tests pass fakes. */
export interface CloseWorkspaceDeps {
  /** The window server's list, read when a stop or close gets no answer (D6, check 4). */
  dialog: XcodeDialogDeps;
  /** Terminate the app directly, after Xcode's stop did not end it. */
  killApp: (scheme: string) => void;
  log: (message: string) => void;
  osascript: (script: string) => OsascriptRun;
  /** Whether the app exited within `seconds`. */
  waitForAppToExit: (scheme: string, seconds: number) => boolean;
}

/**
 * The real dependencies: osascript, the process list, and pkill. pkill exits
 * non-zero when nothing matched, which is the outcome wanted, so that is not
 * an error.
 */
function realCloseWorkspaceDeps(): CloseWorkspaceDeps {
  return {
    dialog: realXcodeDialogDeps(),
    killApp: (scheme) => {
      try {
        execFileSync('pkill', ['-f', appProcessPattern(scheme)], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Nothing matched: the app is gone, which is what was wanted.
      }
    },
    log,
    osascript: runOsascript,
    waitForAppToExit,
  };
}

/**
 * Stop a failed stop or close: at once on a -1712, saying Xcode is probably
 * showing a dialog (D5); otherwise with what Xcode said. It is only reached
 * before anything has written to ios/ (prepareIos), which the message says.
 *
 * On a -1712 it reads the window server's list once (D6, check 4): with a
 * dialog seen, the message says Xcode IS showing one, names it, and names a
 * picture of it; otherwise it keeps "probably", and logs what the reading was
 * (none, or could not check), never folding the two together.
 */
function failCloseStep(
  stderr: string | null,
  action: string,
  workspace: Workspace,
  rerunCommand: string,
  deps: CloseWorkspaceDeps,
): never {
  if (isAppleEventTimeout(stderr)) {
    const reading = deps.dialog.detect();
    if (reading.status === 'dialog') {
      const [shown] = reading.dialogs;
      const picture =
        shown == null
          ? ''
          : ` ${pictureClause(deps.dialog.capture(shown.windowNumber))}`;
      fail(
        `Xcode did not answer within ${CLOSE_EVENT_TIMEOUT_SECONDS}s when asked to ${action} ${workspace.absolutePath}, and Xcode is showing ${describeXcodeDialogs(reading.dialogs)} (${DIALOG_PROBLEM}). Nothing in ios/ has been changed.${picture} Look at Xcode, answer the dialog, then run \`${rerunCommand}\` again. Xcode reported: ${stderr ?? ''}`,
      );
    }
    deps.log(
      reading.status === 'none'
        ? `Dialog check after Xcode did not answer: the window server's list shows no dialog in Xcode.`
        : `Dialog check after Xcode did not answer: could not check (${reading.reason}).`,
    );
    fail(
      `Xcode did not answer within ${CLOSE_EVENT_TIMEOUT_SECONDS}s when asked to ${action} ${workspace.absolutePath}, so it is probably showing a dialog (problem 8 in \`${MAC_BUILD_PROBLEMS_COMMAND}\`). Nothing in ios/ has been changed. Look at Xcode, answer or dismiss the dialog it shows, then run \`${rerunCommand}\` again. Xcode reported: ${stderr ?? ''}`,
    );
  }
  fail(
    `Could not ${action} ${workspace.absolutePath} in Xcode, so nothing in ios/ has been changed. ${
      stderr == null
        ? 'Xcode failed without reporting a reason.'
        : `Xcode reported: ${stderr}`
    }`,
  );
}

/**
 * Close the workspace in Xcode BEFORE anything rewrites ios/ (home-base-0jeya.13,
 * D5): a project regenerated under an open workspace leaves the document
 * pointing at the project that used to be there (no schemes, no run
 * destinations, -10008), and, inferred from the 2026-11-21 2:07am run, can make
 * Xcode show a dialog, after which that close got no answer. Closed first,
 * nothing changes under Xcode, and the open step later sends `open` once.
 *
 * Only when Xcode is running and lists the workspace: otherwise this sends one
 * read-only check and nothing else. The app has to be gone BEFORE the close:
 * closing a workspace whose app is still live under the debugger raises a
 * modal prompt. Xcode's own `stop` returns before the process actually exits,
 * so the exit is waited for and then forced, rather than assumed. Each Apple
 * Event has CLOSE_EVENT_TIMEOUT_SECONDS; a -1712 fails at once (failCloseStep).
 */
function closeWorkspaceInXcode(
  workspace: Workspace,
  before: string,
  rerunCommand: string,
  deps: CloseWorkspaceDeps,
): void {
  deps.log(
    `Closing ${workspace.absolutePath} in Xcode, if Xcode has it open, before ${before}…`,
  );
  const stopAction = 'stop the app running from';
  const stop = deps.osascript(stopWorkspaceAppScript(workspace.absolutePath));
  if (stop.status === 'failed') {
    failCloseStep(stop.stderr, stopAction, workspace, rerunCommand, deps);
  }
  switch (stop.stdout) {
    case 'not running':
      deps.log('Xcode is not running, so there is nothing to close.');
      return;
    case 'absent':
      deps.log('Xcode does not have it open, so there is nothing to close.');
      return;
    case 'stopped':
      break;
    default:
      fail(
        `Xcode gave an answer this does not understand when asked to ${stopAction} ${workspace.absolutePath}: "${stop.stdout}". Nothing in ios/ has been changed.`,
      );
  }

  if (!deps.waitForAppToExit(workspace.scheme, APP_EXIT_WAIT_SECONDS)) {
    deps.log(
      `App did not exit within ${APP_EXIT_WAIT_SECONDS}s of Xcode stopping it; terminating it directly.`,
    );
    deps.killApp(workspace.scheme);
  }

  const closeAction = 'close';
  const close = deps.osascript(closeWorkspaceScript(workspace.absolutePath));
  if (close.status === 'failed') {
    failCloseStep(close.stderr, closeAction, workspace, rerunCommand, deps);
  }
  switch (close.stdout) {
    case 'closed':
      deps.log('Closed it in Xcode.');
      return;
    case 'absent':
    case 'not running':
      deps.log('It was no longer open in Xcode by the time of the close.');
      return;
    default:
      fail(
        `Xcode gave an answer this does not understand when asked to ${closeAction} ${workspace.absolutePath}: "${close.stdout}". Nothing in ios/ has been changed.`,
      );
  }
}

/**
 * What Xcode's build-and-run came to. `stage` says where a failure happened:
 * `open` is Xcode opening or loading the workspace (nothing was built), `build`
 * is everything after. `pidsBefore` is the app's pids read just before Xcode's
 * build, after its signing guard returned. `signingWaitSeconds` is the time the
 * guards spent waiting for an unlocked screen.
 */
type XcodeRunOutcome =
  | {
      reason: string;
      signingWaitSeconds: number;
      stage: 'build' | 'open';
      status: 'failed';
    }
  | {
      pidsBefore: Set<string> | null;
      signingWaitSeconds: number;
      status: 'requested';
    };

/**
 * Build and run through Xcode, in a workspace Xcode has loaded, waiting for a
 * TERMINAL build status first.
 *
 * `run` returns as soon as the run action starts and then reports "running" for
 * as long as the app is alive, so its status can never distinguish "build failed"
 * from "app is up". Building explicitly first is what makes a failed build
 * detectable; the second build `run` performs is a no-op because this build just
 * made everything current.
 *
 * The script is fed to osascript on stdin — no shell quoting is involved. Its
 * `with timeout` raises AppleScript's 120 s per-event default, which Xcode can
 * outlast right after taking in a regenerated project.
 *
 * Xcode's build signs, so this waits for an unlocked screen first, and reads the
 * app's running pids only after that wait (home-base-0jeya.13): pids read before
 * a long wait could include an instance started during it, which would then not
 * count as the new launch.
 */
function xcodeBuildAndRun(workspace: Workspace): XcodeRunOutcome {
  const signing = assertUnlockedForSigning({
    what: `Xcode's build and run of ${workspace.scheme}`,
  });
  const signingWaitSeconds = signingWaitOf(signing);
  const pidsBefore = runningAppPids(workspace.scheme);
  const workspacePath = appleScriptString(workspace.absolutePath);
  const script = `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    activate

    -- Find the document rather than reaching for "active workspace document".
    -- The open-and-load step has just seen it listed and loaded.
    set targetProject to missing value
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${workspacePath} then
            set targetProject to theDocument
        end if
    end repeat
    if targetProject is missing value then error "Xcode no longer lists the workspace it had just loaded."

    set foundScheme to false
    repeat with theScheme in (schemes in targetProject)
        if ((name of theScheme as string) is equal to ${appleScriptString(workspace.scheme)}) then
            set active scheme of targetProject to theScheme
            set foundScheme to true
            exit repeat
        end if
    end repeat
    if foundScheme is false then error "No scheme named ${workspace.scheme} in this workspace."

    -- Destinations lag the workspace: right after Xcode takes in a regenerated
    -- project it answers "could not find any valid run destinations" (-10008) for
    -- minutes while it works through the pod targets, so this polls instead of
    -- asking once. The try is what makes -10008 a retry rather than a failure.
    set foundDestination to false
    repeat ${Math.round(DESTINATION_WAIT_SECONDS / 2)} times
        try
            repeat with theDest in (run destinations of targetProject)
                if ((name of theDest as string) contains "My Mac") then
                    set active run destination of targetProject to theDest
                    set foundDestination to true
                    exit repeat
                end if
            end repeat
        end try
        if foundDestination is true then exit repeat
        delay 2
    end repeat
    if foundDestination is false then error "Xcode still had no \\"My Mac\\" run destination for this scheme after ${DESTINATION_WAIT_SECONDS}s."

    -- Wait for a TERMINAL status: "not yet started" -> "running" -> succeeded /
    -- failed / cancelled / error occurred. Xcode 27.1 can answer the status
    -- request with a reference it cannot resolve instead of a value (-1700,
    -- health-logger-rn 2026-10-22). After ${STATUS_UNREADABLE_LIMIT} such answers in a row the
    -- build is left to "run", which builds again, and the launch is judged from
    -- the process list rather than from a status nobody could read.
    set buildResult to build targetProject
    set waited to 0
    set unreadable to 0
    set s to "unreadable"
    repeat
        try
            set s to (status of buildResult as string)
            set unreadable to 0
        on error
            set s to "unreadable"
            set unreadable to unreadable + 1
        end try
        if s is "unreadable" then
            if unreadable > ${STATUS_UNREADABLE_LIMIT} then exit repeat
        else if s is not "not yet started" and s is not "running" then
            exit repeat
        end if
        if waited > ${IDE_BUILD_TIMEOUT_SECONDS} then error "Xcode build timed out"
        set waited to waited + 1
        delay 1
    end repeat
    if s is not "succeeded" and s is not "unreadable" then error "Xcode IDE build " & s

    -- End any live run session first. Xcode treats "run" as a no-op while one is
    -- already active, so without this the freshly built app never replaces the
    -- one that is running and the terminal is left waiting for a launch that will
    -- not happen.
    try
        stop targetProject
    end try

    -- Fire and forget: Xcode does not reliably reply to "run" until the run
    -- SESSION ends, so waiting for its reply can hang for as long as the app is
    -- open. Whether the app actually came up is confirmed from the process list
    -- instead, which is evidence rather than an assumption.
    ignoring application responses
        run targetProject
    end ignoring
    return s
end tell
end timeout
`;
  let buildStatus: string;
  try {
    buildStatus = osascript(script, 'Xcode build/launch failed');
  } catch (error) {
    return {
      reason: describeError(error),
      signingWaitSeconds,
      stage: 'build',
      status: 'failed',
    };
  }
  if (buildStatus === 'unreadable') {
    log(
      `Xcode never reported the build's status (it answered ${STATUS_UNREADABLE_LIMIT + 1} times with a reference it could not resolve), so the launch was requested anyway; whether the app came up is judged from the process list.`,
    );
  }
  return {pidsBefore, signingWaitSeconds, status: 'requested'};
}

/**
 * Open the workspace in Xcode, wait for it to load, then build and run.
 *
 * The open never waits on Xcode's reply (home-base-0jeya.13, D1): it is sent
 * once, fire and forget, and the load is polled for up to 15 minutes
 * (mac-build-xcode.ts), because Xcode can take more than the 300 s Apple Event
 * limit to answer `open` for a freshly regenerated workspace (2026-11-19).
 *
 * prepareIos closed the workspace in Xcode before anything rewrote ios/ (D5), so
 * Xcode never holds a stale copy here; the open step only ever opens what is not
 * already open.
 *
 * Two signing guards (home-base-di8c7.1, D7): this function's first statement
 * covers Xcode opening the workspace, which with automatic signing may read the
 * Apple account (not known either way, and unknown is not safe); and
 * xcodeBuildAndRun starts with its own, immediately before Xcode's build, because
 * the load can take minutes and the screen can lock meanwhile. A guard stop
 * THROWS and reaches runMacBuild whole; a failed open or build is RETURNED, so
 * the caller's fallback (a terminal rebuild) never runs on a guard stop.
 * tests/mac-build-signing-guard.test.ts fails if either guard call moves or goes.
 *
 * `dialog` is check 3 for the load wait (D6), or null with `--no-dialog-check`
 * (loadWaitDialogCheck).
 */
function buildAndLaunchWithXcode(
  workspace: Workspace,
  dialog: LoadWaitDialogCheck | null,
): XcodeRunOutcome {
  const openSigning = assertUnlockedForSigning({
    what: `Xcode's opening of the ${workspace.scheme} workspace`,
  });
  const opened = openWorkspaceAndWaitForLoad(
    workspace.absolutePath,
    realWorkspaceOpenDeps(log, dialog),
  );
  if (opened.status === 'failed') {
    return {
      reason: opened.reason,
      signingWaitSeconds: signingWaitOf(openSigning),
      stage: 'open',
      status: 'failed',
    };
  }
  const run = xcodeBuildAndRun(workspace);
  return {
    ...run,
    signingWaitSeconds: signingWaitOf(openSigning) + run.signingWaitSeconds,
  };
}

/** What the app does for JS once it is running, for the closing message. */
function jsNote(config: MacBuildConfig): string {
  return config.configuration === 'Release'
    ? 'It embeds its JS, so it runs with no Metro; JS-only changes reach it through EAS Update.'
    : 'It is a Debug build: it loads its JS from Metro or, through the dev launcher, from an EAS update.';
}

/** The values this run builds, and where they are written, or a named failure. */
function loadConfig(
  projectRoot: string,
  requestedVariant: string | null,
): {config: MacBuildConfig; configKey: string} {
  const read = readMacBuildConfig(projectRoot);
  switch (read.status) {
    case 'ok': {
      const selection = selectMacBuildVariant(read, requestedVariant);
      return selection.status === 'selected'
        ? selection
        : fail(selection.message);
    }
    case 'absent':
      return fail(
        `${read.path} has no componentConfig.${MAC_BUILD_CONFIG_KEY} block, so there is no variant to build. Add one, for example:\n${MAC_BUILD_CONFIG_EXAMPLE}\n"scheme" is the ios/*.xcworkspace name \`APP_VARIANT=<variant> npx expo prebuild\` generates; "bundleId" is that variant's ios.bundleIdentifier. "configuration" is optional (Debug for development, Release otherwise).\n\nTo build another variant with --variant <name> as well, add a "variants" map beside those keys, for example:\n${MAC_BUILD_VARIANTS_EXAMPLE}`,
      );
    case 'invalid':
      return fail(
        `componentConfig.${MAC_BUILD_CONFIG_KEY} in ${read.path} cannot be used: ${read.reason}`,
      );
    case 'unreadable':
      return fail(`Could not read ${read.path}: ${read.reason}`);
  }
}

/** What preparing ios/ needs from the world; tests pass fakes. */
export interface PrepareIosDeps {
  close: CloseWorkspaceDeps;
  /** The window server's list, a log and a sleep, for checks 1 and 2 (D6). */
  dialog: XcodeDialogCheckDeps;
  /** `expo prebuild --clean` and what goes with it (the prebuild function). */
  prebuild: (projectRoot: string, config: MacBuildConfig) => void;
}

function realPrepareIosDeps(): PrepareIosDeps {
  return {
    close: realCloseWorkspaceDeps(),
    dialog: realXcodeDialogCheckDeps(log),
    prebuild,
  };
}

/** `bun run build:mac -- --no-dialog-check`, or the flag added after `-- --variant x`. */
function withRunFlag(command: string, flag: string): string {
  return command.includes(' -- ')
    ? `${command} ${flag}`
    : `${command} -- ${flag}`;
}

/**
 * Check 3 for the load wait (D6), or null when `--no-dialog-check` turned the
 * checks that can stop a run off. Its failure names the incremental command
 * with the flag, since the message it ends up in suggests the incremental run.
 */
export function loadWaitDialogCheck(
  options: MacBuildOptions,
  deps: XcodeDialogDeps = realXcodeDialogDeps(),
): LoadWaitDialogCheck | null {
  if (!options.dialogCheck) return null;
  return {
    ...deps,
    withoutCheckCommand: withRunFlag(
      incrementalBuildCommand(options.variant),
      NO_DIALOG_CHECK_FLAG,
    ),
  };
}

/**
 * Checks 1 and 2 (D6): stop the run when Xcode shows the same dialog in two
 * readings DIALOG_RECHECK_SECONDS apart (checkForSteadyDialog, which logs what
 * it saw). A reading that could not be made, or a dialog gone by the second
 * reading, lets the run go on. `when` goes into the log line; `stopped` says
 * where the run stopped and what it had already changed.
 */
function stopIfXcodeShowsDialog(
  deps: XcodeDialogCheckDeps,
  when: string,
  stopped: string,
  rerunCommand: string,
): void {
  const seen = checkForSteadyDialog(deps, when);
  if (seen.status !== 'dialog') return;
  const [shown] = seen.dialogs;
  const picture =
    shown == null ? '' : ` ${pictureClause(deps.capture(shown.windowNumber))}`;
  fail(
    `Xcode is showing ${describeXcodeDialogs(seen.dialogs)}, seen twice ${DIALOG_RECHECK_SECONDS}s apart, and ${DIALOG_WHY}. ${stopped}${picture} Look at Xcode, answer the dialog, then run \`${rerunCommand}\` again. If that window is not a dialog, \`${withRunFlag(rerunCommand, NO_DIALOG_CHECK_FLAG)}\` skips this check.`,
  );
}

/**
 * Bring ios/ to what this run builds: the prebuild (unless --skip-prebuild),
 * the Run action, the APP_VARIANT pin and the signing-team check. Returns the
 * workspace to build.
 *
 * The workspace is closed in Xcode BEFORE anything here writes to ios/, never
 * after (home-base-0jeya.13, D5):
 * - With a prebuild, before `expo prebuild --clean`, from the computed path,
 *   since the folder may not exist yet. The git check runs first, so a refused
 *   prebuild closes nothing.
 * - Without one, only when the Run action is about to change: the patch is
 *   worked out without writing it, the workspace closed if it will change, and
 *   then written. The APP_VARIANT pin (ios/.xcode.env.local) is written on
 *   every run without a close: the generated project names it only as an
 *   input path of its script phases (health-logger-rn's project.pbxproj,
 *   2026-11-21), which read it when they run. That Xcode does not react to
 *   that write while the workspace is open is inferred, not measured.
 *
 * --no-launch closes nothing, keeping its promise of no Xcode (its --help):
 * a prebuild there still regenerates a workspace that Xcode has open
 * (docs/mac-build-problems.md, problem 8).
 *
 * A dialog in Xcode stops the run here (D6), unless `--no-dialog-check`:
 * - Check 1, before the close and before anything here writes to ios/. With
 *   a prebuild that is right after the git check; without one, after the
 *   workspace has been found and the Run action worked out (both only read).
 * - Check 2, after the prebuild or the Run action write, before the build, so
 *   a dialog that the write raised costs seconds rather than the build. Not
 *   when this run wrote neither.
 * Neither runs with --no-launch, which never uses the Xcode app.
 */
export function prepareIos(
  projectRoot: string,
  {config, configKey}: {config: MacBuildConfig; configKey: string},
  options: MacBuildOptions,
  deps: PrepareIosDeps,
): Workspace {
  const buildCommand = fullBuildCommand(options.variant);
  const willPrebuild = !options.skipPrebuild;
  const rerunCommand = willPrebuild
    ? buildCommand
    : incrementalBuildCommand(options.variant);
  const target = workspaceAt(projectRoot, config.scheme);
  const checkDialogs = options.launch && options.dialogCheck;
  if (options.launch && !options.dialogCheck) {
    deps.dialog.log(
      'Dialog checks off (--no-dialog-check): a dialog in Xcode will not stop this run.',
    );
  }
  const checkBeforeXcode = (): void => {
    stopIfXcodeShowsDialog(
      deps.dialog,
      'before anything in ios/ changes',
      'So this run stopped before it used Xcode. Nothing in ios/ has been changed.',
      rerunCommand,
    );
  };

  if (willPrebuild) {
    assertIosNotTracked(projectRoot);
    if (checkDialogs) checkBeforeXcode();
    if (options.launch) {
      closeWorkspaceInXcode(
        target,
        'the prebuild regenerates it',
        rerunCommand,
        deps.close,
      );
    }
    deps.prebuild(projectRoot, config);
  } else {
    log('Skipping prebuild (--skip-prebuild).');
  }

  const workspace = findWorkspace(
    projectRoot,
    config,
    configKey,
    `run \`${buildCommand}\` (without --skip-prebuild) to regenerate it.`,
  );

  // Both are cheap, idempotent, and must hold for the build that is about to
  // run — so they are re-applied on the incremental path too, where a previous
  // prebuild may have reset the scheme and the env file.
  const launchAction = planLaunchAction(
    projectRoot,
    workspace.scheme,
    config.configuration,
  );
  if (!willPrebuild && checkDialogs) checkBeforeXcode();
  if (!willPrebuild && options.launch && launchAction.patched != null) {
    // An open workspace keeps the scheme it loaded; closing it first makes
    // Xcode read the Run action about to be written when it opens it again.
    closeWorkspaceInXcode(
      workspace,
      'the Run action in its scheme changes',
      rerunCommand,
      deps.close,
    );
  }
  const wroteRunAction = applyLaunchAction(launchAction);
  pinVariantForXcodeBuildPhases(projectRoot, config.variant);
  assertSigningTeam(projectRoot, workspace.scheme, buildCommand);
  if (checkDialogs && (willPrebuild || wroteRunAction)) {
    stopIfXcodeShowsDialog(
      deps.dialog,
      willPrebuild ? 'after the prebuild' : 'after the Run action change',
      willPrebuild
        ? 'So this run stopped before the build. The prebuild had already regenerated ios/; nothing has been built.'
        : 'So this run stopped before the build. The Run action in the scheme had already been set; nothing has been built.',
      rerunCommand,
    );
  }
  return workspace;
}

function macBuild(projectRoot: string, options: MacBuildOptions): void {
  const {config, configKey} = loadConfig(projectRoot, options.variant);
  const buildCommand = fullBuildCommand(options.variant);
  log(
    `${config.variant} variant, scheme ${config.scheme}, ${config.configuration}${
      config.configurationSource === 'default'
        ? ' (the default for this variant)'
        : ''
    }, bundle id ${config.bundleId}.`,
  );

  const macDestId = detectMacDestinationId();
  if (macDestId == null) {
    fail("Could not determine this Mac's Provisioning UDID; set MAC_DEST_ID.");
  }

  if (options.installOnly) {
    // Read-only toward ios/: no prebuild, and none of the scheme/env patching
    // below — this only asks Xcode where the last build went.
    const workspace = findWorkspace(
      projectRoot,
      config,
      configKey,
      `the build settings that locate the last Xcode install cannot be read. Run \`${buildCommand}\` (it installs as it goes).`,
    );
    installIntoApplications(projectRoot, workspace, config, macDestId);
    return;
  }

  const didPrebuild = !options.skipPrebuild;
  // Closes the workspace in Xcode before anything rewrites ios/ (D5).
  const workspace = prepareIos(
    projectRoot,
    {config, configKey},
    options,
    realPrepareIosDeps(),
  );

  if (!options.launch) {
    log(
      `Building ${workspace.scheme} (${config.configuration}) for Mac (Designed for iPad, id=${macDestId})…`,
    );
    const timer = startBuildTimer();
    const built = buildWithXcodebuild(
      projectRoot,
      workspace,
      config,
      macDestId,
    );
    timer.addSigningWait(built.signingWaitSeconds);
    if (!built.ok) {
      fail(XCODEBUILD_FAILED);
    }
    ok(
      `Build succeeded in ${timer.elapsed()}${timer.waitNote()}. Workspace: ${workspace.absolutePath}`,
    );
    log(`${APPLICATIONS_DIR} not updated (no Xcode install in --no-launch).`);
    return;
  }

  const timer = startBuildTimer();

  // After a prebuild everything is cold, so build in the terminal first: minutes
  // of compiling with visible progress and real errors, instead of a silent wait
  // on Xcode. See the header for why this is skipped on the incremental path.
  if (didPrebuild) {
    log(
      `Building ${workspace.scheme} (${config.configuration}) for Mac (Designed for iPad, id=${macDestId})…`,
    );
    const built = buildWithXcodebuild(
      projectRoot,
      workspace,
      config,
      macDestId,
    );
    timer.addSigningWait(built.signingWaitSeconds);
    if (!built.ok) {
      fail(XCODEBUILD_FAILED);
    }
    ok(`Build succeeded in ${timer.elapsed()}${timer.waitNote()}.`);
  }

  log(
    `${didPrebuild ? 'Installing + launching' : 'Building + launching'} ${workspace.scheme} on this Mac via Xcode (progress shows in Xcode)…`,
  );
  // Not in a try: a signing-guard stop thrown here must reach runMacBuild as it
  // is, not start the terminal rebuild below (home-base-di8c7.1). The app's
  // pids are read inside, after the guard (home-base-0jeya.13).
  const xcodeRun = buildAndLaunchWithXcode(
    workspace,
    loadWaitDialogCheck(options),
  );
  timer.addSigningWait(xcodeRun.signingWaitSeconds);
  if (xcodeRun.status === 'failed') {
    const {reason} = xcodeRun;
    if (xcodeRun.stage === 'open') {
      // Nothing was built, so a terminal rebuild would show nothing new.
      fail(
        `Xcode did not finish opening the workspace, ${timer.elapsed()} into this run${timer.waitNote()}. ${reason}\n` +
          `Look at Xcode itself: a modal dialog it is waiting on (a signing prompt, a trust prompt) can keep the workspace from loading and leave mac-build's requests unanswered; answer it. If Xcode is still busy loading (indexing, resolving packages), let it finish. Then \`${incrementalBuildCommand(options.variant)}\` builds and launches without regenerating the project.`,
      );
    }
    if (didPrebuild) {
      // The terminal build above already compiled everything and succeeded, so
      // there is nothing new to learn from repeating it.
      fail(
        `Xcode build/launch failed after ${timer.elapsed()}${timer.waitNote()}, though the terminal build succeeded — so the code compiles and this is Xcode-side. ${reason}\n` +
          'Look at Xcode itself: a modal dialog it is waiting on (a signing prompt, "stop the running app?", a trust prompt) can leave the requests mac-build sends unanswered and make Xcode report no run destinations. Answer it, pick the My Mac (Designed for iPad) destination, Run once, and this path works again.',
      );
    }
    log(
      `Xcode build/launch failed after ${timer.elapsed()}${timer.waitNote()}. ${reason}`,
    );
    log('Rebuilding in the terminal to show the errors…');
    if (!buildWithXcodebuild(projectRoot, workspace, config, macDestId).ok) {
      fail(
        'Build failed. The errors are above, from the terminal rebuild of the same workspace.',
      );
    }
    fail(
      `The terminal build SUCCEEDED but Xcode's did not, so this is almost always an IDE-side signing issue: open ${workspace.absolutePath} in Xcode, pick the My Mac (Designed for iPad) destination, and Run once to clear any one-time prompt.`,
    );
  }
  if (
    !waitForNewAppInstance(
      workspace.scheme,
      xcodeRun.pidsBefore,
      LAUNCH_WAIT_SECONDS,
    )
  ) {
    log(
      `Xcode build SUCCEEDED in ${timer.elapsed()}${timer.waitNote()}, but no new ${workspace.scheme} process appeared within ${LAUNCH_WAIT_SECONDS}s — the app may still be starting, or Xcode may be waiting on a prompt. Check Xcode.`,
    );
    // The copy does not depend on the launch: it takes Xcode's install only when
    // it matches the latest build and verifies the copy, so an unconfirmed
    // launch is no reason to leave the app in DerivedData.
    log(
      'Copying it out of DerivedData anyway, if Xcode installed the latest build.',
    );
    installIntoApplications(projectRoot, workspace, config, macDestId);
    return;
  }
  ok(
    `App built + launched on Mac in ${timer.elapsed()}${timer.waitNote()}. ${jsNote(config)}`,
  );
  if (didPrebuild) {
    log(
      `Note: ios/ is now prebuilt for ${config.variant.toUpperCase()}; a Detox or simulator build of another variant has to prebuild again.`,
    );
  }
  // A confirmed new instance means Xcode's Run finished installing.
  installIntoApplications(projectRoot, workspace, config, macDestId);
}

/**
 * `--problems`: print docs/mac-build-problems.md and nothing else (D2). Exit 0
 * when printed; 1, saying why, when the file cannot be read.
 */
function printMacBuildProblems(): number {
  let text: string;
  try {
    text = fs.readFileSync(MAC_BUILD_PROBLEMS_PATH, 'utf8');
  } catch (error) {
    process.stderr.write(
      `${paint(TAG, ['red'], ERROR_COLOR)} Could not read the known-problems list at ${MAC_BUILD_PROBLEMS_PATH}: ${describeError(error)}\n`,
    );
    return 1;
  }
  writeStdoutSync(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

/**
 * Run the command; returns the process exit code. Every failure is printed as
 * one message on stderr — they are all expected, named outcomes (a missing
 * workspace, a refused install, a failed build), not bugs, so no stack — and
 * ends with one line naming `mac-build --problems` (D2).
 */
export function runMacBuild(
  projectRoot: string,
  options: MacBuildOptions,
): number {
  const conflict = conflictingOptions(options);
  if (conflict != null) {
    process.stderr.write(`${conflict}\n`);
    return 2;
  }
  if (options.problems) {
    return printMacBuildProblems();
  }
  try {
    macBuild(projectRoot, options);
    return 0;
  } catch (error) {
    const tag = paint(TAG, ['red'], ERROR_COLOR);
    process.stderr.write(
      `${tag} ${describeError(error)}\n${tag} ${MAC_BUILD_PROBLEMS_POINTER}\n`,
    );
    return 1;
  }
}
