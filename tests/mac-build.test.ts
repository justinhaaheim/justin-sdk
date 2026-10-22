/**
 * Tests for the parts of mac-build.ts that run without Xcode
 * (home-base-0jeya.1): the scheme patch, the APP_VARIANT pin, the guard against
 * `expo prebuild --clean` in a repo that commits ios/, the flag check, and the
 * config failure path. The Xcode-driving half is exercised only by a real
 * `bun run build:mac` in an app repo.
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  assertIosNotTracked,
  assertSigningTeam,
  conflictingOptions,
  pinVariantForXcodeBuildPhases,
  runMacBuild,
  setLaunchConfiguration,
} from '../src/mac-build';

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

/** The shape Expo generates: Debug on Test, Launch and Analyze; Release on Archive. */
const SCHEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1130" version = "1.3">
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      launchStyle = "0">
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

describe('setLaunchConfiguration', () => {
  test('changes the LaunchAction only, leaving Test and Analyze on Debug', () => {
    const root = tempRoot();
    const path = writeScheme(root);

    setLaunchConfiguration(root, SCHEME, 'Release');

    const patched = readFileSync(path, 'utf8');
    expect(patched).toBe(
      SCHEME_XML.replace(
        '<LaunchAction\n      buildConfiguration = "Debug"',
        '<LaunchAction\n      buildConfiguration = "Release"',
      ),
    );
    // Negative control: the replace above really changed something.
    expect(patched).not.toBe(SCHEME_XML);
  });

  test('is a no-op for Debug, and idempotent', () => {
    const root = tempRoot();
    const path = writeScheme(root);
    setLaunchConfiguration(root, SCHEME, 'Debug');
    expect(readFileSync(path, 'utf8')).toBe(SCHEME_XML);
    setLaunchConfiguration(root, SCHEME, 'Release');
    const once = readFileSync(path, 'utf8');
    setLaunchConfiguration(root, SCHEME, 'Release');
    expect(readFileSync(path, 'utf8')).toBe(once);
  });

  test('fails, naming the path, when the scheme file is missing', () => {
    expect(() => setLaunchConfiguration(tempRoot(), SCHEME, 'Release')).toThrow(
      /Scheme not found, cannot set the Run configuration: .*ExampleAppPreview\.xcscheme/,
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
  test('--install-only takes no other options', () => {
    expect(
      conflictingOptions({installOnly: true, launch: true, skipPrebuild: true}),
    ).toContain('--install-only');
    expect(
      conflictingOptions({
        installOnly: true,
        launch: false,
        skipPrebuild: false,
      }),
    ).toContain('--install-only');
    expect(
      conflictingOptions({
        installOnly: true,
        launch: true,
        skipPrebuild: false,
      }),
    ).toBeNull();
    expect(
      conflictingOptions({
        installOnly: false,
        launch: false,
        skipPrebuild: true,
      }),
    ).toBeNull();
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
        installOnly: false,
        launch: false,
        skipPrebuild: true,
      });
    } finally {
      process.stderr.write = original;
    }
    expect(exit).toBe(1);
    const message = writes.join('');
    expect(message).toContain('has no componentConfig.mac-build block');
    expect(message).toContain('"variant": "preview"');
  });
});
