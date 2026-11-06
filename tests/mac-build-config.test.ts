/**
 * Tests for mac-build-config.ts (home-base-0jeya.1): the four read outcomes,
 * the value checks that keep a variant out of shell and a scheme out of a
 * regular expression, the configuration default, the component gate, and the
 * "variants" map with the selection that reads it (home-base-0jeya.9).
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  defaultConfiguration,
  hasMacBuildConfig,
  MAC_BUILD_VARIANTS_EXAMPLE,
  type MacBuildConfigOk,
  readMacBuildConfig,
  selectMacBuildVariant,
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

  test('a block whose only problem is a broken "variants" entry still counts', () => {
    const root = project({
      componentConfig: {
        'mac-build': {
          ...VALID,
          variants: {development: {scheme: 'NoBundleId'}},
        },
      },
    });
    expect(readMacBuildConfig(root).status).toBe('invalid');
    expect(hasMacBuildConfig(root)).toBe(true);
  });
});

const DEV_ENTRY = {
  bundleId: 'com.jhaa.naturesounds.dev',
  scheme: 'NatureSoundsDev',
};

/** The read of a repo whose block is VALID plus `variants` and `extra`. */
function readWithVariants(variants: unknown, extra: object = {}) {
  return readMacBuildConfig(
    project({
      componentConfig: {'mac-build': {...VALID, ...extra, variants}},
    }),
  );
}

/** The same read, for a test that needs it to have worked. */
function okRead(variants: unknown, extra: object = {}): MacBuildConfigOk {
  const read = readWithVariants(variants, extra);
  if (read.status !== 'ok') {
    throw new Error(`expected an ok read, got ${JSON.stringify(read)}`);
  }
  return read;
}

describe('readMacBuildConfig: the "variants" map', () => {
  test('a block with no "variants" reads as before, with an empty map', () => {
    const read = readMacBuildConfig(
      project({componentConfig: {'mac-build': VALID}}),
    );
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.variants.size).toBe(0);
  });

  test('an empty map is valid', () => {
    expect(okRead({}).variants.size).toBe(0);
  });

  test('an entry reads with the configuration of ITS variant, not the top level', () => {
    // The top level is explicitly Release, and development still gets Debug.
    const read = okRead(
      {
        development: DEV_ENTRY,
        staging: {...DEV_ENTRY, scheme: 'NatureStaging'},
      },
      {configuration: 'Release'},
    );
    expect(read.variants.get('development')).toEqual({
      ...DEV_ENTRY,
      configuration: 'Debug',
      configurationSource: 'default',
      variant: 'development',
    });
    expect(read.variants.get('staging')?.configuration).toBe('Release');
  });

  test('an entry that sets its own configuration keeps it, and says so', () => {
    const read = okRead({
      development: {...DEV_ENTRY, configuration: 'Release'},
    });
    expect(read.variants.get('development')?.configuration).toBe('Release');
    expect(read.variants.get('development')?.configurationSource).toBe(
      'config',
    );
  });

  test('the top-level values are untouched by the map', () => {
    expect(okRead({development: DEV_ENTRY}).config).toEqual({
      ...VALID,
      configuration: 'Release',
      configurationSource: 'default',
    });
  });

  test('a broken entry makes the whole block invalid, naming the entry', () => {
    const cases: [unknown, string][] = [
      [
        {bundleId: DEV_ENTRY.bundleId},
        '"variants.development.scheme" is missing',
      ],
      [
        {scheme: DEV_ENTRY.scheme},
        '"variants.development.bundleId" is missing',
      ],
      [
        {...DEV_ENTRY, scheme: 'Nature.Sounds'},
        '"variants.development.scheme" is "Nature.Sounds"',
      ],
      [
        {...DEV_ENTRY, scheme: '../Evil'},
        '"variants.development.scheme" is "../Evil"',
      ],
      [{...DEV_ENTRY, scheme: 7}, '"variants.development.scheme" is 7'],
      [
        {...DEV_ENTRY, bundleId: 'com.example;rm'},
        '"variants.development.bundleId" is "com.example;rm"',
      ],
      [
        {...DEV_ENTRY, configuration: 'Profile'},
        '"variants.development.configuration" is "Profile"',
      ],
      ['NatureSoundsDev', '"variants.development" is "NatureSoundsDev"'],
      [null, '"variants.development" is null'],
    ];
    for (const [entry, expected] of cases) {
      const read = readWithVariants({development: entry});
      expect([expected, read.status]).toEqual([expected, 'invalid']);
      if (read.status === 'invalid') expect(read.reason).toContain(expected);
    }
  });

  test('every problem is named, not just the first', () => {
    const read = readWithVariants({
      development: {scheme: DEV_ENTRY.scheme},
      staging: {bundleId: DEV_ENTRY.bundleId},
    });
    if (read.status !== 'invalid') throw new Error(read.status);
    expect(read.reason).toContain('"variants.development.bundleId" is missing');
    expect(read.reason).toContain('"variants.staging.scheme" is missing');
  });

  test('a key that is not a variant name is refused, because it reaches shell', () => {
    for (const name of ['Dev', 'dev build', 'dev;rm -rf ~', '', '-dev']) {
      const read = readWithVariants({[name]: DEV_ENTRY});
      expect([name, read.status]).toEqual([name, 'invalid']);
      if (read.status === 'invalid') {
        expect(read.reason).toContain(`has the key ${JSON.stringify(name)}`);
      }
    }
  });

  test('__proto__ as a key is refused, not silently dropped', () => {
    // Raw text: a JSON.stringify of an object literal would not carry this key.
    const read = readMacBuildConfig(
      project(
        `{"componentConfig": {"mac-build": {"variant": "preview", "scheme": "NatureSoundsPreview", "bundleId": "com.jhaa.naturesounds.preview", "variants": {"__proto__": {"scheme": "Evil", "bundleId": "com.evil"}}}}}`,
      ),
    );
    expect(read.status).toBe('invalid');
    if (read.status === 'invalid') {
      expect(read.reason).toContain('has the key "__proto__"');
    }
  });

  test('a key equal to the top-level variant is invalid: two sources for one variant', () => {
    const read = readWithVariants({preview: DEV_ENTRY});
    expect(read.status).toBe('invalid');
    if (read.status === 'invalid') {
      expect(read.reason).toContain('"variants.preview" repeats the top-level');
    }
  });

  test('"variants" that is not an object is invalid', () => {
    for (const variants of [null, [], 'development', 3, true]) {
      const read = readWithVariants(variants);
      expect([variants, read.status]).toEqual([variants, 'invalid']);
      if (read.status === 'invalid') {
        expect(read.reason).toContain('"variants" is ');
      }
    }
  });

  test('the top-level problems are still reported beside the map', () => {
    const read = readMacBuildConfig(
      project({
        componentConfig: {
          'mac-build': {variants: {development: {scheme: 'NoBundleId'}}},
        },
      }),
    );
    if (read.status !== 'invalid') throw new Error(read.status);
    expect(read.reason).toContain('"variant" is missing');
    expect(read.reason).toContain('"variants.development.bundleId" is missing');
  });
});

describe('selectMacBuildVariant', () => {
  test('null gives the top-level values, exactly the object the read holds', () => {
    const read = okRead({development: DEV_ENTRY});
    const selection = selectMacBuildVariant(read, null);
    if (selection.status !== 'selected') throw new Error(selection.message);
    expect(selection.config).toBe(read.config);
    expect(selection.configKey).toBe('componentConfig.mac-build');
  });

  test('the top-level variant by name gives the top-level values', () => {
    const read = okRead({development: DEV_ENTRY});
    const selection = selectMacBuildVariant(read, 'preview');
    if (selection.status !== 'selected') throw new Error(selection.message);
    expect(selection.config).toBe(read.config);
    expect(selection.configKey).toBe('componentConfig.mac-build');
  });

  test('a key of "variants" gives that entry, with the configuration of its variant', () => {
    const read = okRead({development: DEV_ENTRY});
    const selection = selectMacBuildVariant(read, 'development');
    if (selection.status !== 'selected') throw new Error(selection.message);
    expect(selection.config).toEqual({
      ...DEV_ENTRY,
      configuration: 'Debug',
      configurationSource: 'default',
      variant: 'development',
    });
    expect(selection.configKey).toBe(
      'componentConfig.mac-build.variants.development',
    );
  });

  test('an unknown name is an error and NEVER the default', () => {
    const read = okRead({development: DEV_ENTRY});
    const selection = selectMacBuildVariant(read, 'staging');
    expect(selection.status).toBe('unknown');
    expect('config' in selection).toBe(false);
    if (selection.status !== 'unknown') return;
    expect(selection.message).toContain(
      '"staging" is not a variant this repo\'s Mac build knows, so nothing was built.',
    );
    expect(selection.message).toContain(
      'It knows: preview (the default), development.',
    );
    expect(selection.message).toContain(read.path);
    expect(selection.message).toContain('APP_VARIANT=staging');
  });

  test('a repo with no "variants" says the default is all it knows', () => {
    const read = readMacBuildConfig(
      project({componentConfig: {'mac-build': VALID}}),
    );
    if (read.status !== 'ok') throw new Error(read.status);
    const selection = selectMacBuildVariant(read, 'development');
    if (selection.status !== 'unknown') throw new Error(selection.status);
    expect(selection.message).toContain('It knows: preview (the default).');
    expect(selection.message).toContain('"development": {');
  });

  test('the known names are listed in a stable order, default first', () => {
    const read = okRead({
      alpha: {...DEV_ENTRY, scheme: 'NatureAlpha'},
      zeta: {...DEV_ENTRY, scheme: 'NatureZeta'},
    });
    const selection = selectMacBuildVariant(read, 'staging');
    if (selection.status !== 'unknown') throw new Error(selection.status);
    expect(selection.message).toContain(
      'It knows: preview (the default), alpha, zeta.',
    );
  });

  test('the JSON shown is real JSON for that name, and pasting it unedited is refused', () => {
    const selection = selectMacBuildVariant(
      okRead({development: DEV_ENTRY}),
      'staging',
    );
    if (selection.status !== 'unknown') throw new Error(selection.status);
    const start = selection.message.indexOf('"variants": {');
    const end = selection.message.indexOf('\n}', start) + 2;
    const shown = JSON.parse(`{${selection.message.slice(start, end)}}`) as {
      variants: Record<string, unknown>;
    };
    expect(Object.keys(shown.variants)).toEqual(['staging']);
    // A placeholder left in fails the read, rather than building something. Each
    // one is checked: either alone would make the block invalid.
    const pasted = readWithVariants(shown.variants);
    if (pasted.status !== 'invalid') throw new Error(pasted.status);
    expect(pasted.reason).toContain('"variants.staging.scheme" is "<scheme>"');
    expect(pasted.reason).toContain(
      '"variants.staging.bundleId" is "<bundle id>"',
    );
  });

  test('the names on Object.prototype are not variants', () => {
    // 'constructor' passes VARIANT_PATTERN, so only the lookup stands in its way.
    const read = okRead({development: DEV_ENTRY});
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect([name, selectMacBuildVariant(read, name).status]).toEqual([
        name,
        'unknown',
      ]);
    }
  });

  test('a name that could never be a key says so, and the JSON keeps a placeholder', () => {
    const read = okRead({development: DEV_ENTRY});
    for (const name of ['', 'Dev Build', 'dev;rm -rf ~']) {
      const selection = selectMacBuildVariant(read, name);
      if (selection.status !== 'unknown') throw new Error(selection.status);
      expect(selection.message).toContain(
        `${JSON.stringify(name)} is not a variant name`,
      );
      expect(selection.message).toContain(
        'It knows: preview (the default), development.',
      );
      expect(selection.message).toContain('"<variant>": {');
      if (name !== '') expect(selection.message).not.toContain(`"${name}": {`);
    }
  });
});

describe('MAC_BUILD_VARIANTS_EXAMPLE', () => {
  test('is a map the reader accepts', () => {
    const shown = JSON.parse(`{${MAC_BUILD_VARIANTS_EXAMPLE}}`) as {
      variants: unknown;
    };
    expect(readWithVariants(shown.variants).status).toBe('ok');
  });
});
