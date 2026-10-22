/**
 * mac-install.ts — copy the Mac ("Designed for iPad") build that Xcode installed
 * into ~/Applications, so it survives a DerivedData wipe. Written in nature-sounds
 * (bead nature-sounds-q6dw) and moved here unchanged in behaviour so every app
 * shares it (home-base-0jeya.1). Justin, 2026-09-23: "let's update our mac build
 * script to copy the app bundle into ~/Applications/ … these app builds will get
 * blown away if we delete DerivedData".
 *
 * WHAT GETS COPIED, AND WHY NOT THE BUILT PRODUCT
 * `<BUILT_PRODUCTS_DIR>/<Scheme>.app` is a bare iOS binary and cannot be opened
 * on the Mac (see the header of mac-build.ts). Xcode's Run action INSTALLS a
 * wrapped bundle next to it, at `<BUILT_PRODUCTS_DIR>/.XCInstall/<Scheme>.app`:
 *
 *   Wrapper/<Scheme>.app          the signed app
 *   Wrapper/BundleMetadata.plist  an MIBundleMetadata archive
 *   WrappedBundle -> Wrapper/<Scheme>.app
 *
 * That wrapper is what macOS can launch, and it is the layout of an app placed in
 * ~/Applications by hand (~/Applications/AudioJournalDev.app). Only Xcode's Run
 * creates it — `xcodebuild … build` does not — so this module copies what Xcode
 * installed, and refuses when that install is older than the latest build.
 *
 * SAFETY — this writes into Justin's ~/Applications:
 * - An existing bundle is replaced only when it is OURS: a wrapper whose
 *   `Wrapper/<Scheme>.app/Info.plist` names the variant's bundle id. A foreign
 *   app, an unreadable plist, a non-wrapper layout or a symlink is refused and
 *   left exactly as it was.
 * - Nothing is ever deleted. The previous copy is MOVED to the Trash under a
 *   timestamped name, and so is a half-made staging copy after a failure.
 * - The new copy is made and verified BESIDE the target first (a hidden sibling),
 *   so a failed copy never costs the working install. The swap is two renames;
 *   if the second fails the first is undone, and a failure says which copy is
 *   where.
 * - Every failure to measure is a failure (critical rule 7): an unreadable plist,
 *   a failed ditto/codesign/plutil, an unexpected path type — each names the path
 *   or command and stops. None of them reads as "nothing to install".
 *
 * `targetDir` and `trashDir` are REQUIRED here, with no default: the defaults
 * (~/Applications, ~/.Trash) are supplied only by mac-build.ts, so a test that
 * forgot to pass a temp dir cannot reach the real ones.
 *
 * Mac-side tooling only. Subprocesses are called directly (no injected runner);
 * the unit tests drive the real ditto / plutil / codesign against a fixture that
 * is ad-hoc signed. plutil writes its value to a file (`-o <file>`) rather than
 * stdout, so the value never depends on subprocess output capture.
 */

import {spawnSync} from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {z} from 'zod';

export interface InstallRequest {
  /** Xcode's BUILT_PRODUCTS_DIR for this checkout, scheme, configuration and destination. */
  readonly builtProductsDir: string;
  /** The variant's CFBundleIdentifier — the only app this installs or replaces. */
  readonly bundleId: string;
  readonly log: (message: string) => void;
  /** Stamps the Trash and staging names. */
  readonly now: Date;
  /** The scheme; also the product name, so the bundle is `<scheme>.app`. */
  readonly scheme: string;
  /** Where the app goes (mac-build.ts passes ~/Applications). */
  readonly targetDir: string;
  /** Where a replaced copy goes (mac-build.ts passes ~/.Trash). */
  readonly trashDir: string;
}

export interface InstallOutcome {
  /** CFBundleVersion read back from the installed copy. */
  readonly bundleVersion: string;
  readonly installedPath: string;
  /** Where the previous copy was moved; null when there was none (a fresh install). */
  readonly previousMovedTo: string | null;
}

type PathKind = 'absent' | 'directory' | 'file' | 'other' | 'symlink';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What is at `p`, without following a final symlink. Only "no such path" is
 * `absent`; any other failure to look (EPERM, EIO, …) throws with the path named,
 * so an unreadable location can never pass for an empty one.
 */
function pathKind(p: string): PathKind {
  try {
    const stats = lstatSync(p);
    if (stats.isSymbolicLink()) {
      return 'symlink';
    }
    if (stats.isDirectory()) {
      return 'directory';
    }
    return stats.isFile() ? 'file' : 'other';
  } catch (error) {
    const code = (error as {code?: unknown}).code;
    // ENOTDIR: a parent component is a file, so this path cannot exist.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'absent';
    }
    throw new Error(`Could not inspect ${p}: ${describeError(error)}`);
  }
}

function shellWords(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word}'`))
    .join(' ');
}

interface ToolResult {
  /** null when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
  readonly stderr: string;
}

function runTool(command: string, args: readonly string[]): ToolResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error != null) {
    throw new Error(
      `Could not run \`${shellWords(command, args)}\`: ${result.error.message}`,
    );
  }
  return {exitCode: result.status, stderr: result.stderr.trim()};
}

function toolFailure(
  command: string,
  args: readonly string[],
  result: ToolResult,
): string {
  const exit =
    result.exitCode == null ? 'killed by a signal' : `exit ${result.exitCode}`;
  return `\`${shellWords(command, args)}\` failed (${exit})${
    result.stderr === '' ? '' : `: ${result.stderr}`
  }`;
}

/**
 * One string value from a plist. The value travels through a file
 * (`plutil -o <file>`), not stdout, so it never depends on output capture; a
 * failed read or an empty value throws — neither is a value.
 */
export function readPlistString(plistPath: string, key: string): string {
  const captureDir = mkdtempSync(join(tmpdir(), 'justin-sdk-plist-'));
  const outPath = join(captureDir, 'value.txt');
  const args = ['-extract', key, 'raw', '-o', outPath, plistPath];
  try {
    const result = runTool('plutil', args);
    if (result.exitCode !== 0) {
      throw new Error(toolFailure('plutil', args, result));
    }
    const value = readFileSync(outPath, 'utf8');
    if (value === '') {
      throw new Error(`${key} in ${plistPath} is empty.`);
    }
    return value;
  } finally {
    rmSync(captureDir, {force: true, recursive: true});
  }
}

/** `<wrapper>/Wrapper/<scheme>.app` — the signed app inside the wrapper. */
function innerAppPath(wrapperPath: string, scheme: string): string {
  return join(wrapperPath, 'Wrapper', `${scheme}.app`);
}

function xcodeInstallPath(builtProductsDir: string, scheme: string): string {
  return join(builtProductsDir, '.XCInstall', `${scheme}.app`);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time, e.g. `2026-09-23 04.05.06` — Finder-safe (no colons). */
function trashStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

/** Local time, e.g. `20260923-040506` — for the hidden staging name. */
function compactStamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** `<trashDir>/<base>.app`, or `<base> 2.app`, … — never an existing name. */
function freeTrashPath(trashDir: string, base: string): string {
  for (let n = 1; n <= 100; n++) {
    const candidate = join(trashDir, `${n === 1 ? base : `${base} ${n}`}.app`);
    if (pathKind(candidate) === 'absent') {
      return candidate;
    }
  }
  throw new Error(`No free name for "${base}.app" in ${trashDir}.`);
}

/** The wrapper's `WrappedBundle` symlink must point at `Wrapper/<scheme>.app`. */
function assertWrappedBundleLink(wrapperPath: string, scheme: string): void {
  const link = join(wrapperPath, 'WrappedBundle');
  const kind = pathKind(link);
  if (kind !== 'symlink') {
    throw new Error(
      `${link} is ${kind === 'absent' ? 'missing' : `a ${kind}, not a symlink`}.`,
    );
  }
  const expected = join('Wrapper', `${scheme}.app`);
  const actual = readlinkSync(link);
  if (actual !== expected) {
    throw new Error(`${link} points at "${actual}", not "${expected}".`);
  }
}

interface BundleIdentity {
  readonly bundleId: string;
  readonly version: string;
}

function readIdentity(wrapperPath: string, scheme: string): BundleIdentity {
  const plist = join(innerAppPath(wrapperPath, scheme), 'Info.plist');
  return {
    bundleId: readPlistString(plist, 'CFBundleIdentifier'),
    version: readPlistString(plist, 'CFBundleVersion'),
  };
}

/**
 * Check a copied wrapper the way it will be used: the link, the signature, and
 * the identity read back from the copy itself. Returns that read-back identity.
 */
function verifyWrapper(
  wrapperPath: string,
  scheme: string,
  bundleId: string,
  expectedVersion: string,
): BundleIdentity {
  assertWrappedBundleLink(wrapperPath, scheme);

  const args = [
    '--verify',
    '--deep',
    '--strict',
    innerAppPath(wrapperPath, scheme),
  ];
  const signature = runTool('codesign', args);
  if (signature.exitCode !== 0) {
    throw new Error(toolFailure('codesign', args, signature));
  }

  const identity = readIdentity(wrapperPath, scheme);
  if (identity.bundleId !== bundleId) {
    throw new Error(
      `${wrapperPath} has CFBundleIdentifier ${identity.bundleId}, expected ${bundleId}.`,
    );
  }
  if (identity.version !== expectedVersion) {
    throw new Error(
      `${wrapperPath} has CFBundleVersion ${identity.version}, expected ${expectedVersion}.`,
    );
  }
  return identity;
}

function refuseReplace(targetPath: string, why: string): never {
  throw new Error(
    `Refusing to replace ${targetPath}: ${why} Nothing was changed.`,
  );
}

/**
 * Refuse unless the existing target is our own wrapper. Returns its
 * CFBundleVersion for the log, or null when that one key could not be read —
 * ownership is settled by the bundle id alone, and the log says "unreadable".
 */
function assertOurs(
  targetPath: string,
  kind: PathKind,
  scheme: string,
  bundleId: string,
): string | null {
  if (kind !== 'directory') {
    refuseReplace(targetPath, `it is a ${kind}, not an app bundle directory.`);
  }

  const plist = join(innerAppPath(targetPath, scheme), 'Info.plist');
  if (pathKind(plist) !== 'file') {
    refuseReplace(
      targetPath,
      `it is not a Designed-for-iPad wrapper (there is no ${plist}), so it is not a copy this script installed.`,
    );
  }

  let existingId: string;
  try {
    existingId = readPlistString(plist, 'CFBundleIdentifier');
  } catch (error) {
    refuseReplace(
      targetPath,
      `its bundle id could not be read, so it cannot be confirmed as ours (${describeError(error)}).`,
    );
  }
  if (existingId !== bundleId) {
    refuseReplace(
      targetPath,
      `it is a different app (CFBundleIdentifier ${existingId}, not ${bundleId}).`,
    );
  }

  try {
    return readPlistString(plist, 'CFBundleVersion');
  } catch {
    return null;
  }
}

/**
 * Move a staging copy that will not be used to the Trash (never rm), and say
 * where it ended up — for the error message the caller is about to throw.
 */
function discardStaging(
  stagingPath: string,
  trashDir: string,
  base: string,
): string {
  let kind: PathKind;
  try {
    kind = pathKind(stagingPath);
  } catch (error) {
    return ` The partial copy may be at ${stagingPath} (${describeError(error)}).`;
  }
  if (kind === 'absent') {
    return '';
  }
  try {
    const discarded = freeTrashPath(trashDir, `${base} (failed install)`);
    renameSync(stagingPath, discarded);
    return ` The partial copy was moved to the Trash: ${discarded}.`;
  } catch (error) {
    return ` The partial copy is still at ${stagingPath} (moving it to the Trash failed: ${describeError(error)}).`;
  }
}

/**
 * Copy Xcode's installed wrapper into `targetDir`, replacing our own previous
 * copy (moved to `trashDir`), and verify the result. Throws — naming the path or
 * command — on every refusal and failure; see the file header for the rules.
 */
export function installToApplications(request: InstallRequest): InstallOutcome {
  const {builtProductsDir, bundleId, log, now, scheme, targetDir, trashDir} =
    request;

  // 1. The source: what Xcode's Run installed.
  const sourcePath = xcodeInstallPath(builtProductsDir, scheme);
  const sourceKind = pathKind(sourcePath);
  if (sourceKind === 'absent') {
    throw new Error(
      `Xcode has not installed a build of ${scheme} from this checkout: there is nothing at ${sourcePath}. Only Xcode's Run action creates it (\`xcodebuild … build\` and --no-launch do not) — run \`bun run build:mac\` (or \`bun run mac\`) first.`,
    );
  }
  if (sourceKind !== 'directory') {
    throw new Error(
      `${sourcePath} is a ${sourceKind}, not the app bundle Xcode installs.`,
    );
  }
  assertWrappedBundleLink(sourcePath, scheme);
  const source = readIdentity(sourcePath, scheme);
  if (source.bundleId !== bundleId) {
    throw new Error(
      `Refusing to install ${sourcePath}: it is CFBundleIdentifier ${source.bundleId}, not ${bundleId}. Nothing was changed.`,
    );
  }

  // 2. Freshness: Xcode's install must be the latest build, not an older Run.
  const builtPlist = join(builtProductsDir, `${scheme}.app`, 'Info.plist');
  if (pathKind(builtPlist) !== 'file') {
    throw new Error(
      `Cannot confirm Xcode's install is current: the built product's Info.plist is missing at ${builtPlist}. Nothing was changed.`,
    );
  }
  const builtVersion = readPlistString(builtPlist, 'CFBundleVersion');
  if (builtVersion !== source.version) {
    throw new Error(
      `Refusing to install a stale build: Xcode's install at ${sourcePath} is CFBundleVersion ${source.version}, but the latest built product is ${builtVersion} — that build was never installed by Xcode's Run (e.g. it came from --no-launch). Run \`bun run mac\` to install it, then retry. Nothing was changed.`,
    );
  }

  // 3. Where it goes, and what is there now.
  const targetDirKind = pathKind(targetDir);
  if (targetDirKind === 'absent') {
    mkdirSync(targetDir, {recursive: true});
  } else if (targetDirKind !== 'directory') {
    throw new Error(`${targetDir} is a ${targetDirKind}, not a directory.`);
  }
  const trashDirKind = pathKind(trashDir);
  if (trashDirKind !== 'directory') {
    throw new Error(
      `The Trash at ${trashDir} is ${trashDirKind === 'absent' ? 'missing' : `a ${trashDirKind}`}, so a previous copy would have nowhere safe to go. Nothing was changed.`,
    );
  }

  const targetPath = join(targetDir, `${scheme}.app`);
  const targetKind = pathKind(targetPath);
  const replacing = targetKind !== 'absent';
  const previousVersion = replacing
    ? assertOurs(targetPath, targetKind, scheme, bundleId)
    : null;

  const stamp = trashStamp(now);
  const trashBase = `${scheme} ${stamp}`;
  const trashPath = replacing ? freeTrashPath(trashDir, trashBase) : null;
  const stagingPath = join(
    targetDir,
    `.${scheme}.app.installing-${compactStamp(now)}`,
  );
  if (pathKind(stagingPath) !== 'absent') {
    throw new Error(
      `${stagingPath} already exists (a previous install still running, or one that crashed). Nothing was changed.`,
    );
  }

  // 4. Stage the copy beside the target, and verify it before touching anything.
  log(`Copying ${sourcePath} → ${stagingPath}…`);
  const dittoArgs = [sourcePath, stagingPath];
  const copy = runTool('ditto', dittoArgs);
  if (copy.exitCode !== 0) {
    const leftover = discardStaging(stagingPath, trashDir, trashBase);
    throw new Error(
      `${toolFailure('ditto', dittoArgs, copy)}. ${targetPath} was left untouched.${leftover}`,
    );
  }
  try {
    verifyWrapper(stagingPath, scheme, bundleId, source.version);
  } catch (error) {
    const leftover = discardStaging(stagingPath, trashDir, trashBase);
    throw new Error(
      `The copy failed verification, so ${targetPath} was left untouched: ${describeError(error)}${leftover}`,
    );
  }

  // 5. Swap: the old copy to the Trash, then the new one into place.
  if (trashPath != null) {
    log(
      `Moving the previous copy (CFBundleVersion ${previousVersion ?? 'unreadable'}) to the Trash: ${trashPath}`,
    );
    try {
      renameSync(targetPath, trashPath);
    } catch (error) {
      const leftover = discardStaging(stagingPath, trashDir, trashBase);
      throw new Error(
        `Could not move ${targetPath} to the Trash (${trashPath}): ${describeError(error)}. The previous copy is still in place.${leftover}`,
      );
    }
  }
  try {
    renameSync(stagingPath, targetPath);
  } catch (error) {
    const reason = describeError(error);
    if (trashPath == null) {
      const leftover = discardStaging(stagingPath, trashDir, trashBase);
      throw new Error(
        `Could not move the new copy into place (${stagingPath} → ${targetPath}): ${reason}. Nothing is installed at ${targetPath}, as before.${leftover}`,
      );
    }
    try {
      renameSync(trashPath, targetPath);
    } catch (restoreError) {
      throw new Error(
        `Could not move the new copy into place (${stagingPath} → ${targetPath}): ${reason}. Restoring the previous copy ALSO failed (${describeError(restoreError)}), so NEITHER is at ${targetPath}: the previous copy is at ${trashPath} and the new one at ${stagingPath}. Move one of them back by hand.`,
      );
    }
    const leftover = discardStaging(stagingPath, trashDir, trashBase);
    throw new Error(
      `Could not move the new copy into place (${stagingPath} → ${targetPath}): ${reason}. The previous copy was restored to ${targetPath}.${leftover}`,
    );
  }

  // 6. Verify what is now installed, read back from the installed copy itself.
  let installed: BundleIdentity;
  try {
    installed = verifyWrapper(targetPath, scheme, bundleId, source.version);
  } catch (error) {
    throw new Error(
      `${targetPath} is the NEW copy, but it failed verification: ${describeError(error)}${
        trashPath == null
          ? ''
          : ` The previous copy is in the Trash: ${trashPath}.`
      }`,
    );
  }

  return {
    bundleVersion: installed.version,
    installedPath: targetPath,
    previousMovedTo: trashPath,
  };
}

// Only the keys read below; the other ~600 settings are stripped, not validated.
const showBuildSettingsSchema = z.array(
  z.object({
    buildSettings: z.object({
      BUILT_PRODUCTS_DIR: z.string().optional(),
      FULL_PRODUCT_NAME: z.string().optional(),
    }),
    error: z.string().optional(),
    target: z.string(),
  }),
);

/**
 * BUILT_PRODUCTS_DIR for `scheme`, from `xcodebuild -showBuildSettings -json`.
 *
 * MEASURED 2026-09-23: xcodebuild can exit 0 and still report failure INSIDE the
 * JSON — under the agent sandbox it printed `"buildSettings": {}` plus an
 * `"error"` (a PIFCache write denied). So an `error`, a missing or relative
 * BUILT_PRODUCTS_DIR, or a product name other than `<scheme>.app` all throw.
 */
export function parseBuiltProductsDir(json: string, scheme: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `xcodebuild -showBuildSettings did not print JSON: ${describeError(error)}`,
    );
  }
  const result = showBuildSettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `xcodebuild -showBuildSettings printed an unexpected shape: ${result.error.message}`,
    );
  }

  const entries = result.data.filter((entry) => entry.target === scheme);
  const [entry] = entries;
  if (entry == null || entries.length !== 1) {
    const targets = result.data.map((each) => each.target);
    throw new Error(
      `Expected exactly one ${scheme} target in xcodebuild -showBuildSettings, found ${entries.length} (targets: ${
        targets.length === 0 ? 'none' : targets.join(', ')
      }).`,
    );
  }

  if (entry.error != null) {
    throw new Error(
      `xcodebuild -showBuildSettings reported an error for ${scheme}: ${entry.error}`,
    );
  }
  const productName = entry.buildSettings.FULL_PRODUCT_NAME;
  if (productName !== `${scheme}.app`) {
    throw new Error(
      `${scheme} builds ${productName ?? 'no FULL_PRODUCT_NAME'}, not ${scheme}.app.`,
    );
  }
  const dir = entry.buildSettings.BUILT_PRODUCTS_DIR;
  if (dir == null || !isAbsolute(dir)) {
    throw new Error(
      `xcodebuild -showBuildSettings gave ${scheme} ${dir == null ? 'no' : `a relative ("${dir}")`} BUILT_PRODUCTS_DIR.`,
    );
  }
  return dir;
}
