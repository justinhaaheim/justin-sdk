/**
 * Tests for mac-build-config.ts (home-base-0jeya.1): the four read outcomes,
 * the value checks that keep a variant out of shell and a scheme out of a
 * regular expression, the configuration default, and the component gate.
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  defaultConfiguration,
  hasMacBuildConfig,
  readMacBuildConfig,
} from '../src/mac-build-config';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, {force: true, recursive: true});
});

/** A project root whose justin-sdk.config.json holds `config` (raw text when a string). */
function project(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'jsdk-mac-build-config-'));
  roots.push(root);
  if (config !== undefined) {
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  }
  return root;
}

const VALID = {
  bundleId: 'com.jhaa.naturesounds.preview',
  scheme: 'NatureSoundsPreview',
  variant: 'preview',
};

describe('readMacBuildConfig', () => {
  test('a valid block reads, with the configuration defaulted from the variant', () => {
    const read = readMacBuildConfig(
      project({componentConfig: {'mac-build': VALID}}),
    );
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.config).toEqual({
      ...VALID,
      configuration: 'Release',
      configurationSource: 'default',
    });
  });

  test('an explicit configuration wins over the default, and says so', () => {
    const read = readMacBuildConfig(
      project({
        componentConfig: {'mac-build': {...VALID, configuration: 'Debug'}},
      }),
    );
    expect(read.status === 'ok' && read.config.configuration).toBe('Debug');
    expect(read.status === 'ok' && read.config.configurationSource).toBe(
      'config',
    );
  });

  test('no file, no componentConfig and no block are all "absent"', () => {
    expect(readMacBuildConfig(project(undefined)).status).toBe('absent');
    expect(readMacBuildConfig(project({})).status).toBe('absent');
    expect(
      readMacBuildConfig(project({componentConfig: {thread: {}}})).status,
    ).toBe('absent');
  });

  test('a file that is not JSON is "unreadable", never "absent"', () => {
    const read = readMacBuildConfig(project('{not json'));
    expect(read.status).toBe('unreadable');
  });

  test('an unreadable path (a directory where the file should be) is "unreadable"', () => {
    const root = project(undefined);
    mkdirSync(join(root, 'justin-sdk.config.json'));
    expect(readMacBuildConfig(root).status).toBe('unreadable');
  });

  test('missing required keys are each named', () => {
    const read = readMacBuildConfig(
      project({componentConfig: {'mac-build': {}}}),
    );
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toContain('"variant" is missing');
    expect(read.reason).toContain('"scheme" is missing');
    expect(read.reason).toContain('"bundleId" is missing');
  });

  test('a variant that would be shell inside ios/.xcode.env.local is refused', () => {
    const read = readMacBuildConfig(
      project({
        componentConfig: {
          'mac-build': {...VALID, variant: 'preview; rm -rf ~'},
        },
      }),
    );
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toContain('"variant" is "preview; rm -rf ~"');
  });

  test('a scheme with regex or path characters is refused', () => {
    for (const scheme of ['Nature.Sounds', '../Evil', 'Nature Sounds', '']) {
      const read = readMacBuildConfig(
        project({componentConfig: {'mac-build': {...VALID, scheme}}}),
      );
      expect([scheme, read.status]).toEqual([scheme, 'invalid']);
    }
  });

  test('a configuration other than Debug or Release is refused', () => {
    const read = readMacBuildConfig(
      project({
        componentConfig: {'mac-build': {...VALID, configuration: 'Profile'}},
      }),
    );
    expect(read.status).toBe('invalid');
  });

  test('a block that is not an object is invalid', () => {
    const read = readMacBuildConfig(
      project({componentConfig: {'mac-build': 'preview'}}),
    );
    expect(read.status).toBe('invalid');
  });
});

describe('defaultConfiguration', () => {
  test('Debug for development, Release for everything else', () => {
    expect(defaultConfiguration('development')).toBe('Debug');
    expect(defaultConfiguration('preview')).toBe('Release');
    expect(defaultConfiguration('production')).toBe('Release');
    expect(defaultConfiguration('dev-test')).toBe('Release');
  });
});

describe('hasMacBuildConfig (the component gate)', () => {
  test('true for a block, valid or not; false without one or with an unreadable file', () => {
    expect(
      hasMacBuildConfig(project({componentConfig: {'mac-build': VALID}})),
    ).toBe(true);
    // A broken block still says the repo wants a Mac build.
    expect(
      hasMacBuildConfig(project({componentConfig: {'mac-build': {}}})),
    ).toBe(true);
    expect(hasMacBuildConfig(project({}))).toBe(false);
    expect(hasMacBuildConfig(project('{not json'))).toBe(false);
  });
});
