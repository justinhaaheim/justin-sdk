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
 * SIDE EFFECT: this leaves ios/ prebuilt for the configured variant (and the
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
 *
 * JS-only changes do not need this: ship them with EAS Update. Run it when
 * native code or dependencies changed.
 */

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {paint, shouldStyle} from './cli-style';
import {
  MAC_BUILD_CONFIG_EXAMPLE,
  MAC_BUILD_CONFIG_KEY,
  type MacBuildConfig,
  readMacBuildConfig,
} from './mac-build-config';
import {installToApplications, parseBuiltProductsDir} from './mac-install';

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

/** How long to wait for Xcode to finish opening the workspace, and to build. */
const WORKSPACE_LOAD_TIMEOUT_SECONDS = 120;
const IDE_BUILD_TIMEOUT_SECONDS = 900;
/**
 * Ceiling for a SINGLE Apple Event, not for the build: the build is watched by
 * polling `status`, and each poll is its own quick event. AppleScript's default of
 * 120 s is too short — Xcode can go minutes without answering while it takes in a
 * workspace that was regenerated under it — but raising this to the build timeout
 * would turn "Xcode is never going to answer" into a 15-minute hang.
 */
const APPLE_EVENT_TIMEOUT_SECONDS = 300;
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

function elapsedSince(startMs: number): string {
  return `${Math.round((Date.now() - startMs) / 1000)}s`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MacBuildOptions {
  /** Copy the last Xcode install into ~/Applications; no prebuild, build or launch. */
  installOnly: boolean;
  launch: boolean;
  skipPrebuild: boolean;
}

/** A combination of flags that cannot mean anything, or null when they are fine. */
export function conflictingOptions(options: MacBuildOptions): string | null {
  if (options.installOnly && (options.skipPrebuild || !options.launch)) {
    return '--install-only builds nothing, so it takes no other options.';
  }
  return null;
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

interface Workspace {
  /** Absolute path, for Xcode. */
  absolutePath: string;
  /** Repo-relative path, for xcodebuild invoked with cwd = the project root. */
  relativePath: string;
  /** Also the generated project name, and the scheme to build. */
  scheme: string;
}

/**
 * Locate the CONFIGURED variant's workspace specifically.
 *
 * Deliberately not "whichever single workspace is in ios/": the simulator loop
 * keeps ios/ prebuilt for development in most repos, so a different workspace is
 * routinely sitting there, and a --skip-prebuild run would otherwise build and
 * launch the wrong variant without saying anything.
 *
 * `remedy` is the advice when it is missing, which depends on the caller.
 */
function findWorkspace(
  projectRoot: string,
  config: MacBuildConfig,
  remedy: string,
): Workspace {
  const relativePath = path.join('ios', `${config.scheme}.xcworkspace`);
  const absolutePath = path.join(projectRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    const iosDir = path.join(projectRoot, 'ios');
    const present = fs.existsSync(iosDir)
      ? fs.readdirSync(iosDir).filter((name) => name.endsWith('.xcworkspace'))
      : [];
    fail(
      `${relativePath} not found${
        present.length > 0
          ? ` (ios/ currently holds: ${present.join(', ')})`
          : ''
      }. Either ios/ is prebuilt for a different variant, or "scheme" in componentConfig.${MAC_BUILD_CONFIG_KEY} does not match the workspace Expo generates for "${config.variant}" — ${remedy}`,
    );
  }

  return {absolutePath, relativePath, scheme: config.scheme};
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
export function assertSigningTeam(projectRoot: string, scheme: string): void {
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
      `The generated project has no DEVELOPMENT_TEAM (${pbxprojPath}), so xcodebuild cannot sign it. Set \`ios.appleTeamId\` in the app config (app.config.ts or app.json) to your Apple Developer team id, then run \`bun run build:mac\` again so the prebuild writes it.`,
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
 * Make the Xcode Run action use the configuration this command builds.
 *
 * Expo generates the scheme with LaunchAction buildConfiguration = "Debug", and
 * the AppleScript launch path below goes through Xcode's Run action — so without
 * this, Xcode would build and install a DEBUG app (no embedded JS, dev launcher
 * compiled in) no matter what was asked for. A no-op for a Debug build.
 *
 * Patching a generated file is fine HERE specifically because this command owns
 * the generation step: it re-applies the patch on every run, and `--clean`
 * regenerates the scheme. Nothing else depends on it.
 *
 * Only the LaunchAction is touched — `buildConfiguration` also appears on
 * TestAction and AnalyzeAction, and a blanket replace would corrupt those.
 */
export function setLaunchConfiguration(
  projectRoot: string,
  scheme: string,
  configuration: string,
): void {
  const schemePath = path.join(
    projectRoot,
    'ios',
    `${scheme}.xcodeproj`,
    'xcshareddata',
    'xcschemes',
    `${scheme}.xcscheme`,
  );

  if (!fs.existsSync(schemePath)) {
    fail(`Scheme not found, cannot set the Run configuration: ${schemePath}`);
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
  const patchedTag = openingTag.replace(
    /buildConfiguration = "[^"]*"/,
    `buildConfiguration = "${configuration}"`,
  );
  if (
    patchedTag === openingTag &&
    !openingTag.includes(`buildConfiguration = "${configuration}"`)
  ) {
    fail(
      `Could not set buildConfiguration on <LaunchAction> in ${schemePath} — its attributes did not match the expected shape.`,
    );
  }

  fs.writeFileSync(
    schemePath,
    original.slice(0, tagStart) + patchedTag + original.slice(tagEnd),
  );
  ok(`Xcode Run action set to ${configuration}.`);
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
 * failed terminal build. Measured 2026-10-21: run from a Claude Code session,
 * xcodebuild reported "No Accounts" for both health-logger-rn and screenshot-app
 * although Xcode has an Apple ID configured, then fell back to the wildcard
 * "iOS Team Provisioning Profile: *", which lacks App Groups and push. That the
 * same command signs from Justin's own terminal is inferred (nature-sounds'
 * profile was fetched during his own build:mac on 2026-09-23), not re-measured.
 */
const SIGNING_HINT =
  'If they say "No Accounts", or that a provisioning profile lacks a capability (App Groups, Push Notifications), xcodebuild could not use your Xcode account to fetch this app’s profile: check Xcode > Settings > Accounts, and run the command from your own terminal (a process that cannot reach your login keychain, such as an agent session, gets "No Accounts").';

/**
 * Build in the terminal — the only way to see progress and read compiler errors
 * without opening Xcode's UI. Used for --no-launch, for the cold build right
 * after a prebuild, and to surface the errors when an Xcode-alone build fails.
 */
function buildWithXcodebuild(
  projectRoot: string,
  workspace: Workspace,
  config: MacBuildConfig,
  macDestId: string,
): void {
  // APP_VARIANT is belt and braces alongside .xcode.env.local: this one covers
  // the CLI build even if that file were ever missing.
  try {
    runInherit(
      projectRoot,
      'xcodebuild',
      [
        ...xcodebuildTargetArgs(workspace, config, macDestId),
        '-allowProvisioningUpdates',
        '-allowProvisioningDeviceRegistration',
        'build',
      ],
      {APP_VARIANT: config.variant},
    );
  } catch {
    fail(`xcodebuild failed; its errors are above. ${SIGNING_HINT}`);
  }
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
  let output: string;
  try {
    output = execFileSync('xcodebuild', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      // ~110 KB per target measured; generous so a big project cannot truncate it.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as {stderr?: unknown}).stderr;
    const detail =
      typeof stderr === 'string' && stderr.trim() !== ''
        ? `\n${stderr.trim()}`
        : '';
    fail(
      `Could not read Xcode's build settings: \`${command}\` failed.${detail}`,
    );
  }
  try {
    return parseBuiltProductsDir(output, workspace.scheme);
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
 * Xcode installs the app into a system-managed container, so the running binary
 * lives at …/d/Wrapper/<Scheme>.app/<Scheme>, not in DerivedData.
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

/** Quote a value for interpolation into an AppleScript string literal. */
function asString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Run an AppleScript, throwing its stderr as the message on failure. */
function osascript(script: string, what: string): void {
  try {
    execFileSync('osascript', ['-'], {
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as {stderr?: Buffer}).stderr?.toString().trim();
    fail(
      stderr != null && stderr !== ''
        ? `${what} — Xcode reported: ${stderr}`
        : `${what} — Xcode failed without reporting a reason.`,
    );
  }
}

/**
 * Close the workspace so the next open reads the project that is on disk NOW.
 *
 * Needed after `expo prebuild --clean`: an already-open document keeps pointing at
 * the project that used to be there, and Xcode then reports no schemes and no run
 * destinations at all ("could not find any valid run destinations", -10008).
 *
 * The app has to be gone BEFORE the close. Closing a workspace whose app is still
 * live under the debugger raises a modal prompt, and a modal prompt hangs that
 * Apple Event and every one after it — measured as a 300 s timeout on `close`
 * alone. Xcode's own `stop` returns before the process actually exits, so the exit
 * is waited for and then forced, rather than assumed.
 */
function closeStaleWorkspace(workspace: Workspace): void {
  const workspacePath = asString(workspace.absolutePath);
  log('Closing the stale workspace in Xcode (the project was regenerated)…');
  osascript(
    `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    if it is not running then return "not running"
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${workspacePath} then
            try
                stop theDocument
            end try
        end if
    end repeat
end tell
end timeout
`,
    'Could not stop the running app in Xcode',
  );

  if (!waitForAppToExit(workspace.scheme, APP_EXIT_WAIT_SECONDS)) {
    log(
      `App did not exit within ${APP_EXIT_WAIT_SECONDS}s of Xcode stopping it; terminating it directly.`,
    );
    try {
      execFileSync('pkill', ['-f', appProcessPattern(workspace.scheme)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // pkill exits non-zero when nothing matched, which is the outcome we want.
    }
  }

  osascript(
    `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    if it is not running then return "not running"
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${workspacePath} then
            close theDocument
        end if
    end repeat
end tell
end timeout
`,
    'Could not close the workspace in Xcode',
  );
}

/**
 * Build and run through Xcode, waiting for a TERMINAL build status first.
 *
 * `run` returns as soon as the run action starts and then reports "running" for
 * as long as the app is alive, so its status can never distinguish "build failed"
 * from "app is up". Building explicitly first is what makes a failed build
 * detectable; the second build `run` performs is a no-op because this build just
 * made everything current.
 *
 * The script is fed to osascript on stdin — no shell quoting is involved.
 *
 * `with timeout` is load-bearing. AppleScript gives up on an Apple Event after
 * 120 s by default, and Xcode does not answer while it is still taking in a
 * workspace that `expo prebuild --clean` regenerated under it — so without it the
 * launch path dies with "AppleEvent timed out (-1712)" after exactly two minutes.
 *
 * Callers close the workspace first (see closeStaleWorkspace) when the project on
 * disk was regenerated; this function only ever opens what is not already open.
 */
function buildAndLaunchWithXcode(workspace: Workspace): void {
  const workspacePath = asString(workspace.absolutePath);
  const script = `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    activate

    -- Find the document rather than reaching for "active workspace document",
    -- and open ONLY when it is not already open: Xcode never answers an \`open\`
    -- for a workspace it already has, so an unconditional open hangs until the
    -- Apple Event times out.
    set targetProject to missing value
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${workspacePath} then
            set targetProject to theDocument
        end if
    end repeat
    if targetProject is missing value then
        open ${workspacePath}
        repeat ${WORKSPACE_LOAD_TIMEOUT_SECONDS * 2} times
            repeat with theDocument in workspace documents
                if (path of theDocument as string) is equal to ${workspacePath} then
                    set targetProject to theDocument
                end if
            end repeat
            if targetProject is not missing value then exit repeat
            delay 0.5
        end repeat
    end if
    if targetProject is missing value then error "Xcode never opened the workspace."

    repeat ${WORKSPACE_LOAD_TIMEOUT_SECONDS * 2} times
        if loaded of targetProject is true then exit repeat
        delay 0.5
    end repeat
    if loaded of targetProject is false then error "Xcode workspace did not finish loading within timeout."

    set foundScheme to false
    repeat with theScheme in (schemes in targetProject)
        if ((name of theScheme as string) is equal to ${asString(workspace.scheme)}) then
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
    -- failed / cancelled / error occurred.
    set buildResult to build targetProject
    set waited to 0
    repeat
        set s to (status of buildResult as string)
        if s is not "not yet started" and s is not "running" then exit repeat
        if waited > ${IDE_BUILD_TIMEOUT_SECONDS} then error "Xcode build timed out"
        set waited to waited + 1
        delay 1
    end repeat
    if (status of buildResult as string) is not "succeeded" then error "Xcode IDE build " & (status of buildResult as string)

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
    return "launched"
end tell
end timeout
`;
  osascript(script, 'Xcode build/launch failed');
}

/** What the app does for JS once it is running, for the closing message. */
function jsNote(config: MacBuildConfig): string {
  return config.configuration === 'Release'
    ? 'It embeds its JS, so it runs with no Metro; JS-only changes reach it through EAS Update.'
    : 'It is a Debug build: it loads its JS from Metro or, through the dev launcher, from an EAS update.';
}

function loadConfig(projectRoot: string): MacBuildConfig {
  const read = readMacBuildConfig(projectRoot);
  switch (read.status) {
    case 'ok':
      return read.config;
    case 'absent':
      return fail(
        `${read.path} has no componentConfig.${MAC_BUILD_CONFIG_KEY} block, so there is no variant to build. Add one, for example:\n${MAC_BUILD_CONFIG_EXAMPLE}\n"scheme" is the ios/*.xcworkspace name \`APP_VARIANT=<variant> npx expo prebuild\` generates; "bundleId" is that variant's ios.bundleIdentifier. "configuration" is optional (Debug for development, Release otherwise).`,
      );
    case 'invalid':
      return fail(
        `componentConfig.${MAC_BUILD_CONFIG_KEY} in ${read.path} cannot be used: ${read.reason}`,
      );
    case 'unreadable':
      return fail(`Could not read ${read.path}: ${read.reason}`);
  }
}

function macBuild(projectRoot: string, options: MacBuildOptions): void {
  const config = loadConfig(projectRoot);
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
      'the build settings that locate the last Xcode install cannot be read. Run `bun run build:mac` (it installs as it goes).',
    );
    installIntoApplications(projectRoot, workspace, config, macDestId);
    return;
  }

  const didPrebuild = !options.skipPrebuild;
  if (didPrebuild) {
    prebuild(projectRoot, config);
  } else {
    log('Skipping prebuild (--skip-prebuild).');
  }

  const workspace = findWorkspace(
    projectRoot,
    config,
    'run `bun run build:mac` (without --skip-prebuild) to regenerate it.',
  );

  // Both are cheap, idempotent, and must hold for the build that is about to
  // run — so they are re-applied on the incremental path too, where a previous
  // prebuild may have reset the scheme and the env file.
  setLaunchConfiguration(projectRoot, workspace.scheme, config.configuration);
  pinVariantForXcodeBuildPhases(projectRoot, config.variant);
  assertSigningTeam(projectRoot, workspace.scheme);

  if (!options.launch) {
    log(
      `Building ${workspace.scheme} (${config.configuration}) for Mac (Designed for iPad, id=${macDestId})…`,
    );
    const started = Date.now();
    buildWithXcodebuild(projectRoot, workspace, config, macDestId);
    ok(
      `Build succeeded in ${elapsedSince(started)}. Workspace: ${workspace.absolutePath}`,
    );
    log(`${APPLICATIONS_DIR} not updated (no Xcode install in --no-launch).`);
    return;
  }

  const started = Date.now();

  // After a prebuild everything is cold, so build in the terminal first: minutes
  // of compiling with visible progress and real errors, instead of a silent wait
  // on Xcode. See the header for why this is skipped on the incremental path.
  if (didPrebuild) {
    log(
      `Building ${workspace.scheme} (${config.configuration}) for Mac (Designed for iPad, id=${macDestId})…`,
    );
    buildWithXcodebuild(projectRoot, workspace, config, macDestId);
    ok(`Build succeeded in ${elapsedSince(started)}.`);
    closeStaleWorkspace(workspace);
  }

  log(
    `${didPrebuild ? 'Installing + launching' : 'Building + launching'} ${workspace.scheme} on this Mac via Xcode (progress shows in Xcode)…`,
  );
  const pidsBefore = runningAppPids(workspace.scheme);
  try {
    buildAndLaunchWithXcode(workspace);
  } catch (error) {
    const reason = describeError(error);
    if (didPrebuild) {
      // The terminal build above already compiled everything and succeeded, so
      // there is nothing new to learn from repeating it.
      fail(
        `Xcode build/launch failed after ${elapsedSince(started)}, though the terminal build succeeded — so the code compiles and this is Xcode-side. ${reason}\n` +
          'Look at Xcode itself: a modal dialog it is waiting on (a signing prompt, "stop the running app?", a trust prompt) blocks every AppleScript command and makes it report no run destinations. Dismiss it, pick the My Mac (Designed for iPad) destination, Run once, and this path works again.',
      );
    }
    log(`Xcode build/launch failed after ${elapsedSince(started)}. ${reason}`);
    log('Rebuilding in the terminal to show the errors…');
    try {
      buildWithXcodebuild(projectRoot, workspace, config, macDestId);
    } catch {
      fail(
        'Build failed. The errors are above, from the terminal rebuild of the same workspace.',
      );
    }
    fail(
      `The terminal build SUCCEEDED but Xcode's did not, so this is almost always an IDE-side signing issue: open ${workspace.absolutePath} in Xcode, pick the My Mac (Designed for iPad) destination, and Run once to clear any one-time prompt.`,
    );
  }
  if (
    !waitForNewAppInstance(workspace.scheme, pidsBefore, LAUNCH_WAIT_SECONDS)
  ) {
    log(
      `Xcode build SUCCEEDED in ${elapsedSince(started)}, but no new ${workspace.scheme} process appeared within ${LAUNCH_WAIT_SECONDS}s — the app may still be starting, or Xcode may be waiting on a prompt. Check Xcode.`,
    );
    log(
      `${APPLICATIONS_DIR} not updated (the launch was not confirmed). Once the app is up, \`bun run mac:install\` copies it there.`,
    );
    return;
  }
  ok(
    `App built + launched on Mac in ${elapsedSince(started)}. ${jsNote(config)}`,
  );
  if (didPrebuild) {
    log(
      `Note: ios/ is now prebuilt for ${config.variant.toUpperCase()}; a Detox or simulator build of another variant has to prebuild again.`,
    );
  }
  // Only now: a confirmed new instance means Xcode's Run finished installing.
  installIntoApplications(projectRoot, workspace, config, macDestId);
}

/**
 * Run the command; returns the process exit code. Every failure is printed as
 * one message on stderr — they are all expected, named outcomes (a missing
 * workspace, a refused install, a failed build), not bugs, so no stack.
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
  try {
    macBuild(projectRoot, options);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${paint(TAG, ['red'], ERROR_COLOR)} ${describeError(error)}\n`,
    );
    return 1;
  }
}
