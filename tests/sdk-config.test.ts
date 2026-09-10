/**
 * The config layer (home-base-uxwc.1 — D2 layering, D9 schema).
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these tests protect:
 *
 *  1. LOOSENESS IN THE RIGHT DIRECTION. An unknown key must always pass (an
 *     older SDK reading a newer SDK's config), and a known key with the wrong
 *     type must always fail. Get that backwards and either every repo warns
 *     forever, or a typo silently changes behaviour.
 *  2. FAILURE IS NOT EMPTY (critical rule 6). "No file", "not JSON", "does not
 *     match the schema" and "could not be read" are four different facts, and
 *     none of them may arrive as an empty config.
 *  3. PER-FIELD LAYERING. A project file that names ONE knob must not reset the
 *     other eleven to their defaults — that is the whole point of the user file.
 *  4. A BROKEN FILE CONTRIBUTES NOTHING. Half a config is a config nobody
 *     wrote; the breakage is reported by doctor instead.
 *
 * Every test injects XDG_CONFIG_HOME, so the real ~/.config is never read.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';
import {z} from 'zod';

import {
  configSchemaJson,
  DEFAULT_HEALTH_NOTICES,
  describeConfigOutcome,
  isConfigProblem,
  projectConfigSchema,
  readProjectConfig,
  readUserConfig,
  renderConfigSchema,
  resolveHealthNoticesConfig,
  userConfigPath,
  userConfigSchema,
  xdgConfigHome,
} from '../src/sdk-config';
import {xdgStateHome} from '../src/health-notices';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox();
  sandboxes.push(created);
  return created;
}

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A project root with the given config file contents (raw text). */
function projectWith(raw: string | null): string {
  const box = sandbox();
  if (raw != null) box.writeFile('justin-sdk.config.json', raw);
  return box.path;
}

/** An XDG_CONFIG_HOME with the given user config (raw text). */
function configHomeWith(raw: string | null): string {
  const box = sandbox();
  if (raw != null) {
    mkdirSync(join(box.path, 'justin-sdk'), {recursive: true});
    writeFileSync(join(box.path, 'justin-sdk', 'config.json'), raw);
  }
  return box.path;
}

const VALID_PROJECT = {
  components: ['base-setup'],
  lastSynced: '2026-09-10',
  version: '0.26.0',
};

function projectJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({...VALID_PROJECT, ...extra}, null, 2);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('userConfigPath', () => {
  test('honours XDG_CONFIG_HOME', () => {
    expect(userConfigPath({XDG_CONFIG_HOME: '/xdg'})).toBe(
      '/xdg/justin-sdk/config.json',
    );
  });

  test('falls back to $HOME/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(userConfigPath({HOME: '/home/j'})).toBe(
      '/home/j/.config/justin-sdk/config.json',
    );
    expect(userConfigPath({HOME: '/home/j', XDG_CONFIG_HOME: ''})).toBe(
      '/home/j/.config/justin-sdk/config.json',
    );
  });

  test('an EMPTY HOME resolves to the real home, not into the current repo (uxwc.5 F4)', () => {
    // `resolve('', '.config')` is CWD-relative, so an unset HOME would make
    // "the user-level config" mean a different file in every checkout — and
    // silently, since an absent config is the ordinary case. The state file's
    // xdgStateHome has always used homedir() here; this is the same fallback,
    // now shared with it.
    const resolved = userConfigPath({HOME: ''});
    expect(resolved.startsWith(process.cwd())).toBe(false);
    expect(resolved.endsWith('/.config/justin-sdk/config.json')).toBe(true);
    expect(xdgConfigHome({HOME: ''})).toBe(
      xdgStateHome({HOME: ''}).replace('/.local/state', '/.config'),
    );
  });
});

// ---------------------------------------------------------------------------
// Reader outcomes — one test per status
// ---------------------------------------------------------------------------

describe('readProjectConfig outcomes', () => {
  test('ok: a well-formed config parses', () => {
    const outcome = readProjectConfig(projectWith(projectJson()));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.config.version).toBe('0.26.0');
    expect(outcome.path).toEndWith('/justin-sdk.config.json');
    expect(isConfigProblem(outcome)).toBe(false);
  });

  test('absent: no file at all', () => {
    const outcome = readProjectConfig(projectWith(null));
    expect(outcome.status).toBe('absent');
    expect(isConfigProblem(outcome)).toBe(false);
    expect(describeConfigOutcome(outcome)).toContain('not present');
  });

  test('invalid-json: unparseable bytes are NOT reported as absent', () => {
    const outcome = readProjectConfig(projectWith('{"version": '));
    expect(outcome.status).toBe('invalid-json');
    if (outcome.status !== 'invalid-json') throw new Error('unreachable');
    expect(outcome.error.length).toBeGreaterThan(0);
    expect(isConfigProblem(outcome)).toBe(true);
  });

  test('unreadable: a file that exists but cannot be read is NOT absent', () => {
    // A directory where the config file should be: readFileSync throws EISDIR,
    // which must not be swallowed into "the repo has no config".
    const box = sandbox();
    box.mkdir('justin-sdk.config.json');
    const outcome = readProjectConfig(box.path);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('unreachable');
    expect(outcome.error.length).toBeGreaterThan(0);
    expect(isConfigProblem(outcome)).toBe(true);
    expect(describeConfigOutcome(outcome)).toContain('could not be read');
  });

  test('schema-violation: a wrong TYPE names the exact key path', () => {
    const outcome = readProjectConfig(
      projectWith(
        projectJson({
          healthNotices: {sdkVersion: {minor: {promptTier: 'high'}}},
        }),
      ),
    );
    expect(outcome.status).toBe('schema-violation');
    if (outcome.status !== 'schema-violation') throw new Error('unreachable');
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]).toStartWith(
      'healthNotices.sdkVersion.minor.promptTier:',
    );
    expect(describeConfigOutcome(outcome)).toContain(
      'healthNotices.sdkVersion.minor.promptTier',
    );
  });

  test('schema-violation: an out-of-range tier is a violation too', () => {
    const outcome = readProjectConfig(
      projectWith(projectJson({healthNotices: {doctor: {promptTier: 7}}})),
    );
    expect(outcome.status).toBe('schema-violation');
    if (outcome.status !== 'schema-violation') throw new Error('unreachable');
    expect(outcome.issues[0]).toStartWith('healthNotices.doctor.promptTier:');
    expect(outcome.issues[0]).toContain('1|2|3|4');
  });

  test('schema-violation: a malformed lastSynced is caught', () => {
    const outcome = readProjectConfig(
      projectWith(projectJson({lastSynced: 'yesterday'})),
    );
    expect(outcome.status).toBe('schema-violation');
    if (outcome.status !== 'schema-violation') throw new Error('unreachable');
    expect(outcome.issues[0]).toContain('lastSynced');
  });

  test('unknown keys pass at EVERY level — an older SDK never fails a newer config', () => {
    const outcome = readProjectConfig(
      projectWith(
        projectJson({
          componentConfig: {'future-component': {anything: true}},
          futureKey: 1,
          healthNotices: {
            futureKey: 2,
            sdkVersion: {futureKey: 3, minor: {futureKey: 4, promptTier: 1}},
          },
        }),
      ),
    );
    expect(outcome.status).toBe('ok');
  });

  test('the real componentConfig sections validate as written in the fleet', () => {
    const outcome = readProjectConfig(
      projectWith(
        projectJson({
          componentConfig: {
            'critical-rules': {modules: ['communication', 'stay-focused']},
            'time-check': {
              enabled: true,
              gapHours: 4,
              notifyOnNewDayBoundaryHour: 4,
            },
            'usage-check': {
              enabled: true,
              roles: {player: {wrapUpAt: 350000}},
              setpoints: null,
              wrapUpAt: 300000,
            },
          },
        }),
      ),
    );
    expect(outcome.status).toBe('ok');
  });
});

describe('readUserConfig outcomes', () => {
  test('absent when the XDG dir has no justin-sdk/config.json', () => {
    const outcome = readUserConfig({XDG_CONFIG_HOME: configHomeWith(null)});
    expect(outcome.status).toBe('absent');
    expect(outcome.path).toEndWith('/justin-sdk/config.json');
  });

  test('ok, and reads only the injected home', () => {
    const home = configHomeWith(
      JSON.stringify({healthNotices: {doctor: {showOnPass: true}}}),
    );
    const outcome = readUserConfig({XDG_CONFIG_HOME: home});
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.config.healthNotices?.doctor?.showOnPass).toBe(true);
    expect(outcome.path).toStartWith(home);
  });

  test('invalid-json in the user file is its own outcome', () => {
    const outcome = readUserConfig({
      XDG_CONFIG_HOME: configHomeWith('not json at all'),
    });
    expect(outcome.status).toBe('invalid-json');
  });
});

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

describe('resolveHealthNoticesConfig layering', () => {
  test('neither file has the block -> exactly the defaults', () => {
    expect(
      resolveHealthNoticesConfig(projectWith(projectJson()), {
        XDG_CONFIG_HOME: configHomeWith(null),
      }),
    ).toEqual(DEFAULT_HEALTH_NOTICES);
  });

  test('no files at all -> exactly the defaults', () => {
    expect(
      resolveHealthNoticesConfig(projectWith(null), {
        XDG_CONFIG_HOME: configHomeWith(null),
      }),
    ).toEqual(DEFAULT_HEALTH_NOTICES);
  });

  test('user and project each set ONE field; both apply, nothing else moves', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(
        projectJson({
          healthNotices: {sdkVersion: {patch: {throttleMinutes: 5}}},
        }),
      ),
      {
        XDG_CONFIG_HOME: configHomeWith(
          JSON.stringify({
            healthNotices: {sdkVersion: {minor: {promptTier: 1}}},
          }),
        ),
      },
    );
    expect(resolved).toEqual({
      ...DEFAULT_HEALTH_NOTICES,
      sdkVersion: {
        ...DEFAULT_HEALTH_NOTICES.sdkVersion,
        minor: {...DEFAULT_HEALTH_NOTICES.sdkVersion.minor, promptTier: 1},
        patch: {...DEFAULT_HEALTH_NOTICES.sdkVersion.patch, throttleMinutes: 5},
      },
    });
  });

  test('the project file wins over the user file for the SAME field', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(projectJson({healthNotices: {doctor: {promptTier: 4}}})),
      {
        XDG_CONFIG_HOME: configHomeWith(
          JSON.stringify({healthNotices: {doctor: {promptTier: 1}}}),
        ),
      },
    );
    expect(resolved.doctor.promptTier).toBe(4);
  });

  test('a zero throttle is honoured, not swallowed as "unset"', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(
        projectJson({
          healthNotices: {sdkVersion: {major: {throttleMinutes: 0}}},
        }),
      ),
      {XDG_CONFIG_HOME: configHomeWith(null)},
    );
    expect(resolved.sdkVersion.major.throttleMinutes).toBe(0);
  });

  test('showOnPass: false in a file is honoured over a true beneath it', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(projectJson({healthNotices: {doctor: {showOnPass: false}}})),
      {
        XDG_CONFIG_HOME: configHomeWith(
          JSON.stringify({healthNotices: {doctor: {showOnPass: true}}}),
        ),
      },
    );
    expect(resolved.doctor.showOnPass).toBe(false);
  });

  test('a BROKEN project file contributes nothing — the user layer stands', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(
        projectJson({
          healthNotices: {
            doctor: {intervalMinutes: 5},
            sdkVersion: {minor: {promptTier: 'high'}},
          },
        }),
      ),
      {
        XDG_CONFIG_HOME: configHomeWith(
          JSON.stringify({healthNotices: {doctor: {promptTier: 1}}}),
        ),
      },
    );
    // The valid-looking half of the broken file (intervalMinutes: 5) is NOT
    // half-applied, and the user layer below it is untouched.
    expect(resolved.doctor.intervalMinutes).toBe(
      DEFAULT_HEALTH_NOTICES.doctor.intervalMinutes,
    );
    expect(resolved.doctor.promptTier).toBe(1);
  });

  test('a broken USER file contributes nothing — the project layer still applies', () => {
    const resolved = resolveHealthNoticesConfig(
      projectWith(projectJson({healthNotices: {doctor: {promptTier: 2}}})),
      {XDG_CONFIG_HOME: configHomeWith('{oops')},
    );
    expect(resolved.doctor.promptTier).toBe(2);
    expect(resolved.doctor.intervalMinutes).toBe(
      DEFAULT_HEALTH_NOTICES.doctor.intervalMinutes,
    );
  });
});

describe('resolveHealthNoticesConfig kill switches', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['JUSTIN_SDK_HEALTH_NOTICES=off', {JUSTIN_SDK_HEALTH_NOTICES: 'off'}],
    ['CI=1', {CI: '1'}],
    ['CI=true', {CI: 'true'}],
    ['CLAUDE_CODE_REMOTE=true', {CLAUDE_CODE_REMOTE: 'true'}],
  ];

  for (const [label, env] of cases) {
    test(`${label} -> enabled false, everything else still resolved`, () => {
      const resolved = resolveHealthNoticesConfig(projectWith(projectJson()), {
        ...env,
        XDG_CONFIG_HOME: configHomeWith(null),
      });
      expect(resolved.enabled).toBe(false);
      expect({...resolved, enabled: true}).toEqual(DEFAULT_HEALTH_NOTICES);
    });
  }

  test('an EMPTY CI is not a kill switch, and enabled defaults to true', () => {
    const resolved = resolveHealthNoticesConfig(projectWith(projectJson()), {
      CI: '',
      XDG_CONFIG_HOME: configHomeWith(null),
    });
    expect(resolved.enabled).toBe(true);
  });

  test('JUSTIN_SDK_HEALTH_NOTICES with any other value does not kill', () => {
    const resolved = resolveHealthNoticesConfig(projectWith(projectJson()), {
      JUSTIN_SDK_HEALTH_NOTICES: 'on',
      XDG_CONFIG_HOME: configHomeWith(null),
    });
    expect(resolved.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `config schema`
// ---------------------------------------------------------------------------

function topLevelKeys(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema) as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(json.properties ?? {});
}

describe('config schema', () => {
  test('the human tree names both files and EVERY top-level key of each', () => {
    const rendered = renderConfigSchema({
      env: {XDG_CONFIG_HOME: '/xdg'},
      projectRoot: '/repo',
    });
    expect(rendered).toContain('/repo/justin-sdk.config.json');
    expect(rendered).toContain('/xdg/justin-sdk/config.json');
    for (const key of [
      ...topLevelKeys(projectConfigSchema),
      ...topLevelKeys(userConfigSchema),
    ]) {
      expect(rendered).toContain(key);
    }
  });

  test('every key carries a type, and the healthNotices leaves carry defaults', () => {
    const rendered = renderConfigSchema({
      env: {XDG_CONFIG_HOME: '/xdg'},
      projectRoot: '/repo',
    });
    // Column padding is derived from the longest key in each section, so match
    // the SHAPE of a line (key, type, default) rather than a fixed width.
    expect(rendered).toMatch(
      new RegExp(
        `healthNotices\\.sdkVersion\\.minor\\.promptTier +1\\|2\\|3\\|4 +· +default ${DEFAULT_HEALTH_NOTICES.sdkVersion.minor.promptTier} `,
      ),
    );
    expect(rendered).toMatch(/\n {2}components +string\[\] +·/);
    // A nullable BLOCK is still walked key by key (usage-check roles.player).
    expect(rendered).toMatch(
      /componentConfig\.usage-check\.roles\.player\.wrapUpAt +number\|null/,
    );
  });

  test('--json is parseable JSON Schema, one object per file, with descriptions', () => {
    const json = configSchemaJson() as {
      project: {description?: string; properties: Record<string, unknown>};
      user: {description?: string; properties: Record<string, unknown>};
    };
    expect(Object.keys(json.project.properties).sort()).toEqual(
      topLevelKeys(projectConfigSchema).sort(),
    );
    expect(Object.keys(json.user.properties)).toEqual(['healthNotices']);
    expect(json.project.description).toBeString();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('the config CLI command', () => {
  test('`config schema` prints the tree', () => {
    const run = spawnSync(process.execPath, [CLI, 'config', 'schema'], {
      cwd: projectWith(projectJson()),
      encoding: 'utf-8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('healthNotices.sdkVersion.minor.promptTier');
    expect(run.stdout).toContain('justin-sdk.config.json');
  });

  test('`config schema --json` prints JSON that parses', () => {
    const run = spawnSync(
      process.execPath,
      [CLI, 'config', 'schema', '--json'],
      {cwd: projectWith(projectJson()), encoding: 'utf-8'},
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['project', 'user']);
  });

  test('bare `config` asks for a subcommand instead of guessing', () => {
    const run = spawnSync(process.execPath, [CLI, 'config'], {
      cwd: projectWith(projectJson()),
      encoding: 'utf-8',
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('schema');
  });
});
