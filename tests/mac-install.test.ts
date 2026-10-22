import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  type InstallOutcome,
  installToApplications,
  parseBuiltProductsDir,
  readPlistString,
} from '../src/mac-install';

// Ported from nature-sounds (bead nature-sounds-q6dw) with the module
// (home-base-0jeya.1). These drive the REAL ditto / plutil / codesign: each
// fixture is a Designed-for-iPad wrapper whose inner app is /usr/bin/true, ad-hoc
// signed, so `codesign --verify --deep --strict` genuinely passes on it (and fails
// once it is tampered with). The target AND the Trash are temp dirs in every test;
// nothing here can reach ~/Applications or ~/.Trash.

const SCHEME = 'ExampleAppPreview';
const BUNDLE_ID = 'com.example.app.preview';
const NOW = new Date(2026, 8, 23, 4, 5, 6);
const TRASHED_NAME = `${SCHEME} 2026-09-23 04.05.06.app`;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr}`,
    );
  }
}

function plistXml(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

function appInfoPlist(bundleId: string, version: string): string {
  return plistXml({
    CFBundleExecutable: SCHEME,
    CFBundleIdentifier: bundleId,
    CFBundlePackageType: 'APPL',
    CFBundleVersion: version,
  });
}

/** The layout Xcode's Run installs (and ~/Applications/AudioJournalDev.app has). */
function makeWrapper(
  wrapperPath: string,
  identity: {bundleId: string; version: string},
): void {
  const inner = join(wrapperPath, 'Wrapper', `${SCHEME}.app`);
  mkdirSync(inner, {recursive: true});
  writeFileSync(
    join(inner, 'Info.plist'),
    appInfoPlist(identity.bundleId, identity.version),
  );
  copyFileSync('/usr/bin/true', join(inner, SCHEME));
  chmodSync(join(inner, SCHEME), 0o755);
  run('codesign', ['--sign', '-', '--force', inner]);
  writeFileSync(
    join(wrapperPath, 'Wrapper', 'BundleMetadata.plist'),
    plistXml({fixture: 'true'}),
  );
  symlinkSync(
    join('Wrapper', `${SCHEME}.app`),
    join(wrapperPath, 'WrappedBundle'),
  );
}

/** A BUILT_PRODUCTS_DIR: the built product, plus Xcode's install when given. */
function makeXcodeBuild(
  root: string,
  options: {builtVersion: string; installedVersion: string | null},
): string {
  const builtProductsDir = join(root, 'Build', 'Products', 'Release-iphoneos');
  mkdirSync(join(builtProductsDir, `${SCHEME}.app`), {recursive: true});
  writeFileSync(
    join(builtProductsDir, `${SCHEME}.app`, 'Info.plist'),
    appInfoPlist(BUNDLE_ID, options.builtVersion),
  );
  if (options.installedVersion != null) {
    makeWrapper(join(builtProductsDir, '.XCInstall', `${SCHEME}.app`), {
      bundleId: BUNDLE_ID,
      version: options.installedVersion,
    });
  }
  return builtProductsDir;
}

/** Every path under `dir` with its type and content hash — "untouched" means equal. */
function snapshotTree(dir: string, prefix = ''): string[] {
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const relative = join(prefix, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      lines.push(`L ${relative} -> ${readlinkSync(path)}`);
    } else if (stats.isDirectory()) {
      lines.push(`D ${relative}`, ...snapshotTree(path, relative));
    } else {
      const hash = createHash('sha1').update(readFileSync(path)).digest('hex');
      lines.push(`F ${relative} ${hash}`);
    }
  }
  return lines;
}

function innerInfoPlist(wrapperPath: string): string {
  return join(wrapperPath, 'Wrapper', `${SCHEME}.app`, 'Info.plist');
}

let root: string;
let targetDir: string;
let trashDir: string;
let targetPath: string;
let logged: string[];

beforeEach(() => {
  logged = [];
  root = mkdtempSync(join(tmpdir(), 'jsdk-mac-install-'));
  targetDir = join(root, 'Applications');
  trashDir = join(root, 'Trash');
  mkdirSync(targetDir);
  mkdirSync(trashDir);
  targetPath = join(targetDir, `${SCHEME}.app`);
});

afterEach(() => {
  rmSync(root, {force: true, recursive: true});
});

function install(builtProductsDir: string): InstallOutcome {
  return installToApplications({
    builtProductsDir,
    bundleId: BUNDLE_ID,
    log: (message) => {
      logged.push(message);
    },
    now: NOW,
    scheme: SCHEME,
    targetDir,
    trashDir,
  });
}

describe('installToApplications', () => {
  test('installs into an empty target dir, verified and with no staging left behind', () => {
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });

    const outcome = install(built);

    expect(outcome).toEqual({
      bundleVersion: '2.0',
      installedPath: targetPath,
      previousMovedTo: null,
    });
    expect(readdirSync(targetDir)).toEqual([`${SCHEME}.app`]);
    expect(readdirSync(trashDir)).toEqual([]);
    expect(readlinkSync(join(targetPath, 'WrappedBundle'))).toBe(
      `Wrapper/${SCHEME}.app`,
    );
    expect(readPlistString(innerInfoPlist(targetPath), 'CFBundleVersion')).toBe(
      '2.0',
    );
    run('codesign', [
      '--verify',
      '--deep',
      '--strict',
      join(targetPath, 'Wrapper', `${SCHEME}.app`),
    ]);
  });

  test('replaces our own older copy by MOVING it to the Trash, intact', () => {
    makeWrapper(targetPath, {bundleId: BUNDLE_ID, version: '1.0'});
    const oldCopy = snapshotTree(targetPath);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });

    const outcome = install(built);

    const trashed = join(trashDir, TRASHED_NAME);
    expect(outcome.previousMovedTo).toBe(trashed);
    expect(logged).toContain(
      `Moving the previous copy (CFBundleVersion 1.0) to the Trash: ${trashed}`,
    );
    expect(readdirSync(trashDir)).toEqual([TRASHED_NAME]);
    expect(snapshotTree(trashed)).toEqual(oldCopy);
    expect(readdirSync(targetDir)).toEqual([`${SCHEME}.app`]);
    expect(readPlistString(innerInfoPlist(targetPath), 'CFBundleVersion')).toBe(
      '2.0',
    );
  });

  test('refuses to replace a foreign app, and leaves it untouched', () => {
    makeWrapper(targetPath, {
      bundleId: 'com.example.someone-else',
      version: '9.9',
    });
    const before = snapshotTree(targetDir);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });

    expect(() => install(built)).toThrow(
      `Refusing to replace ${targetPath}: it is a different app (CFBundleIdentifier com.example.someone-else, not ${BUNDLE_ID}). Nothing was changed.`,
    );
    expect(snapshotTree(targetDir)).toEqual(before);
    expect(readdirSync(trashDir)).toEqual([]);
  });

  test('refuses a non-wrapper bundle even when it carries our bundle id', () => {
    // A bare iOS .app (what DerivedData's product looks like) at the target name.
    mkdirSync(targetPath);
    writeFileSync(
      join(targetPath, 'Info.plist'),
      appInfoPlist(BUNDLE_ID, '1.0'),
    );
    const before = snapshotTree(targetDir);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });

    expect(() => install(built)).toThrow(
      /^Refusing to replace .*: it is not a Designed-for-iPad wrapper/,
    );
    expect(snapshotTree(targetDir)).toEqual(before);
    expect(readdirSync(trashDir)).toEqual([]);
  });

  test('refuses when the existing bundle id cannot be read', () => {
    makeWrapper(targetPath, {bundleId: BUNDLE_ID, version: '1.0'});
    writeFileSync(innerInfoPlist(targetPath), 'this is not a plist');
    const before = snapshotTree(targetDir);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });

    expect(() => install(built)).toThrow(
      /^Refusing to replace .*: its bundle id could not be read, so it cannot be confirmed as ours \(`plutil -extract CFBundleIdentifier/,
    );
    expect(snapshotTree(targetDir)).toEqual(before);
    expect(readdirSync(trashDir)).toEqual([]);
  });

  test('refuses a stale Xcode install (older than the latest built product)', () => {
    makeWrapper(targetPath, {bundleId: BUNDLE_ID, version: '0.5'});
    const before = snapshotTree(targetDir);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '1.0',
    });

    expect(() => install(built)).toThrow(
      /^Refusing to install a stale build: .* is CFBundleVersion 1\.0, but the latest built product is 2\.0/,
    );
    expect(snapshotTree(targetDir)).toEqual(before);
    expect(readdirSync(trashDir)).toEqual([]);
  });

  test('fails clearly when Xcode has not installed a build at all', () => {
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: null,
    });

    expect(() => install(built)).toThrow(
      /^Xcode has not installed a build of ExampleAppPreview from this checkout: there is nothing at .*\.XCInstall\/ExampleAppPreview\.app\./,
    );
    expect(readdirSync(targetDir)).toEqual([]);
  });

  test('a copy that fails codesign never replaces the working install', () => {
    makeWrapper(targetPath, {bundleId: BUNDLE_ID, version: '1.0'});
    const before = snapshotTree(targetDir);
    const built = makeXcodeBuild(root, {
      builtVersion: '2.0',
      installedVersion: '2.0',
    });
    // Break the seal of Xcode's install: a file the signature does not cover.
    writeFileSync(
      join(
        built,
        '.XCInstall',
        `${SCHEME}.app`,
        'Wrapper',
        `${SCHEME}.app`,
        'extra.txt',
      ),
      'not sealed',
    );

    expect(() => install(built)).toThrow(
      /^The copy failed verification, so .* was left untouched: `codesign --verify --deep --strict .*` failed \(exit 1\)/,
    );
    expect(snapshotTree(targetDir)).toEqual(before);
    // The rejected staging copy went to the Trash (never rm), not into place.
    expect(readdirSync(trashDir)).toEqual([
      `${SCHEME} 2026-09-23 04.05.06 (failed install).app`,
    ]);
  });
});

describe('parseBuiltProductsDir', () => {
  const dir =
    '/Users/x/Library/Developer/Xcode/DerivedData/ExampleAppPreview-abc/Build/Products/Release-iphoneos';

  test('reads BUILT_PRODUCTS_DIR for the scheme (shape measured 2026-09-23)', () => {
    const json = JSON.stringify([
      {
        action: 'build',
        buildSettings: {
          BUILT_PRODUCTS_DIR: dir,
          FULL_PRODUCT_NAME: `${SCHEME}.app`,
          PLATFORM_NAME: 'iphoneos',
        },
        target: SCHEME,
      },
    ]);
    expect(parseBuiltProductsDir(json, SCHEME)).toBe(dir);
  });

  test('an exit-0 result that carries an error is a failure, not an empty answer', () => {
    // Verbatim shape from xcodebuild under the agent sandbox, error text trimmed.
    const json = JSON.stringify([
      {
        action: 'build',
        buildSettings: {},
        error:
          'Error Domain=NSCocoaErrorDomain Code=513 "You don’t have permission to save the file"',
        target: SCHEME,
      },
    ]);
    expect(() => parseBuiltProductsDir(json, SCHEME)).toThrow(
      /reported an error for ExampleAppPreview: Error Domain=NSCocoaErrorDomain Code=513/,
    );
  });

  test('refuses output that is not JSON, or has no single entry for the scheme', () => {
    expect(() => parseBuiltProductsDir('Build settings for…', SCHEME)).toThrow(
      /did not print JSON/,
    );
    const other = JSON.stringify([
      {
        action: 'build',
        buildSettings: {BUILT_PRODUCTS_DIR: dir, FULL_PRODUCT_NAME: 'X.app'},
        target: 'ExampleAppDev',
      },
    ]);
    expect(() => parseBuiltProductsDir(other, SCHEME)).toThrow(
      /Expected exactly one ExampleAppPreview target .* found 0 \(targets: ExampleAppDev\)/,
    );
  });
});
