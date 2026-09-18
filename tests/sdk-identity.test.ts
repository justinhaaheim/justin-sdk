/**
 * "Which justin-sdk am I running?" — epic home-base-dchjw, decision D4.
 *
 * The bug these pin down: cli.ts never called yargs' `.version()`, and yargs'
 * own guess comes from the package.json nearest ITS hoisted install. Measured
 * 2026-09-16: `justin-sdk --version` printed `0.5.0` inside ~/Dev/prompts and
 * `0.2.0` inside home-base — in both cases the CONSUMER's version, reported as
 * the SDK's, with nothing anywhere saying so.
 *
 * WHAT THE FIXTURE CAN AND CANNOT SHOW. The consumer fixture below declares
 * `9.9.9`, and that number will never appear in the output no matter how broken
 * the SDK is: bun resolves the CLI to its real path, so the package.json yargs
 * would guess from is home-base's, not the fixture's. The fixture's job is
 * therefore to prove the version does not follow the CWD; home-base's own
 * version is what the negative control actually prints. Both preconditions are
 * asserted rather than assumed, because a control that cannot fail is not a
 * control.
 */

import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';

import {
  formatHelpHeader,
  getSdkVersion,
  helpHeader,
  helpWrapWidth,
  readSdkVersionFrom,
  UNKNOWN_VERSION,
} from '../src/sdk-identity';

const SDK_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(SDK_ROOT, 'src');
const CLI = join(SRC, 'cli.ts');

/** The SDK's version read straight off disk — the expected answer, never derived from the code under test. */
function sdkVersionFromDisk(): string {
  const raw = JSON.parse(
    readFileSync(join(SDK_ROOT, 'package.json'), 'utf-8'),
  ) as {version?: unknown};
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new Error('the SDK package.json has no version — fixture is broken');
  }
  return raw.version;
}

/**
 * The version yargs would guess if `.version()` were removed: the package.json
 * above the SDK's directory. Absent in a published snapshot, where pkg/justin-sdk
 * IS the repo root — hence `string | null`, and hence a skipped precondition
 * rather than a fabricated one.
 */
function hostVersionFromDisk(): string | null {
  return readSdkVersionFrom(resolve(SDK_ROOT, '..', '..', 'package.json'));
}

/** A consumer repo that declares a DIFFERENT version, as ~/Dev/prompts does. */
function consumerFixture(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-identity-consumer-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({name: 'some-consumer', version}, null, 2) + '\n',
  );
  return dir;
}

function runCli(args: string[], cwd: string): {out: string; status: number} {
  const done = spawnSync('bun', [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    // The health-notice middleware is off the help/version path, but a notice on
    // stderr would still muddy a first-line assertion. Silence it explicitly.
    env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
  });
  return {out: (done.stdout ?? '').trim(), status: done.status ?? -1};
}

describe('readSdkVersionFrom — every failure is null, never a number', () => {
  test('a real package.json yields its version', () => {
    expect(readSdkVersionFrom(join(SDK_ROOT, 'package.json'))).toBe(
      sdkVersionFromDisk(),
    );
  });

  test('absent, malformed, keyless and empty-string all yield null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-identity-bad-'));

    expect(readSdkVersionFrom(join(dir, 'nope.json'))).toBeNull();

    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{not json');
    expect(readSdkVersionFrom(malformed)).toBeNull();

    const keyless = join(dir, 'keyless.json');
    writeFileSync(keyless, JSON.stringify({name: 'x'}));
    expect(readSdkVersionFrom(keyless)).toBeNull();

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({version: ''}));
    expect(readSdkVersionFrom(empty)).toBeNull();

    const numeric = join(dir, 'numeric.json');
    writeFileSync(numeric, JSON.stringify({version: 38}));
    expect(readSdkVersionFrom(numeric)).toBeNull();

    // The whole point of the change: '0.0.0' is never manufactured.
    expect(readSdkVersionFrom(join(dir, 'nope.json'))).not.toBe('0.0.0');
  });
});

describe('the help header', () => {
  test('an unreadable version reads "version unknown", not a number', () => {
    expect(formatHelpHeader('justin-sdk', null, '/x/src')).toBe(
      `justin-sdk ${UNKNOWN_VERSION} · /x/src`,
    );
    expect(UNKNOWN_VERSION).toBe('version unknown');
  });

  test('a known version is v-prefixed and carries the source dir', () => {
    expect(formatHelpHeader('repo-status', '1.2.3', '/x/src')).toBe(
      'repo-status v1.2.3 · /x/src',
    );
    expect(helpHeader('justin-sdk', SRC)).toBe(
      `justin-sdk v${sdkVersionFromDisk()} · ${SRC}`,
    );
  });

  test('the wrap width never truncates the header', () => {
    // 80 is what yargs uses when stdout is piped, which is how tests read help.
    expect(helpWrapWidth('x'.repeat(105), 80)).toBe(105);
    // …and a header that already fits leaves the layout alone.
    expect(helpWrapWidth('x'.repeat(40), 80)).toBe(80);
  });
});

describe('the CLI, run from a consumer whose version differs', () => {
  test('PRECONDITION: the fixture and the host both differ from the SDK', () => {
    const sdkVersion = sdkVersionFromDisk();
    expect('9.9.9').not.toBe(sdkVersion);
    const host = hostVersionFromDisk();
    if (host == null) {
      // A published snapshot has no repo above it; say so rather than pass quietly.
      expect(existsSync(resolve(SDK_ROOT, '..', '..', 'package.json'))).toBe(
        false,
      );
    } else {
      // If these ever coincided, the negative control below could not fail.
      expect(host).not.toBe(sdkVersion);
    }
  });

  test('--version prints the SDK version, not the consumer version', () => {
    const consumer = consumerFixture('9.9.9');
    const {out, status} = runCli(['--version'], consumer);
    expect(status).toBe(0);
    // NEGATIVE CONTROL (run by hand 2026-09-18): delete `.version(...)` from
    // cli.ts and this line fails with Received "0.2.0" — home-base's version,
    // which is exactly the bug. Restored, it passes.
    expect(out).toBe(sdkVersionFromDisk());
    expect(out).not.toBe('9.9.9');
  });

  test('--help opens with the version and the directory it runs from', () => {
    const consumer = consumerFixture('9.9.9');
    const {out, status} = runCli(['--help'], consumer);
    expect(status).toBe(0);
    const [first] = out.split('\n');
    // Whole-line equality, deliberately: `toContain` would pass on a header that
    // cliui had hard-broken across two lines, which is the failure that was
    // actually measured before `.wrap()` was widened.
    expect(first).toBe(`justin-sdk v${sdkVersionFromDisk()} · ${SRC}`);
  });

  test('--help is a pure no-op: it writes nothing into the consumer', () => {
    const consumer = consumerFixture('9.9.9');
    const before = readFileSync(join(consumer, 'package.json'), 'utf-8');
    runCli(['--help'], consumer);
    expect(readFileSync(join(consumer, 'package.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(consumer, 'justin-sdk.config.json'))).toBe(false);
  });
});

describe('repo-status carries the same contract', () => {
  test('--version is the SDK version and --help names its own directory', () => {
    const consumer = consumerFixture('9.9.9');
    const bin = join(SRC, 'repo-status', 'repo-status.ts');
    const version = spawnSync('bun', [bin, '--version'], {
      cwd: consumer,
      encoding: 'utf-8',
    });
    expect((version.stdout ?? '').trim()).toBe(sdkVersionFromDisk());

    const help = spawnSync('bun', [bin, '--help'], {
      cwd: consumer,
      encoding: 'utf-8',
    });
    const [first] = (help.stdout ?? '').trim().split('\n');
    expect(first).toBe(
      `repo-status v${sdkVersionFromDisk()} · ${join(SRC, 'repo-status')}`,
    );
  });
});

describe('getSdkVersion', () => {
  test('answers the SDK package.json, and never 0.0.0 by default', () => {
    expect(getSdkVersion()).toBe(sdkVersionFromDisk());
  });
});
