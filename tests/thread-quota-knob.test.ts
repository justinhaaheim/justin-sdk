/**
 * componentConfig.thread.quota (request home-base-ys9t7.5 D5, built by
 * home-base-ys9t7.5.2): the defaults, the per-field layering, a wrong-shaped
 * value named and ignored, and `config schema` printing every field.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync} from 'fs';
import {join} from 'path';

import {DEFAULT_COMPONENT_CONFIG, renderConfigSchema} from '../src/sdk-config';
import {resolveThreadConfig} from '../src/thread/config';
import {QUOTA_DEFAULTS} from '../src/thread/defaults';
import {quotaLimitsOf, resolveQuotaConfig} from '../src/thread/quota-knob';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function configWorld(options: {
  project?: Record<string, unknown>;
  user?: Record<string, unknown>;
}): {cwd: string; env: Record<string, string>} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const cwd = join(sb.path, 'repo');
  mkdirSync(cwd, {recursive: true});
  sb.writeFile(
    'repo/justin-sdk.config.json',
    JSON.stringify({components: ['base-setup'], ...options.project}),
  );
  if (options.user != null) {
    sb.writeFile('config/justin-sdk/config.json', JSON.stringify(options.user));
  }
  return {cwd, env: {XDG_CONFIG_HOME: join(sb.path, 'config')}};
}

function quotaIn(section: unknown): Record<string, unknown> {
  return {componentConfig: {thread: {quota: section}}};
}

describe('componentConfig.thread.quota', () => {
  test('absent everywhere: every default, mode OFF (feature-knobs rule)', () => {
    const {cwd, env} = configWorld({});
    const {problems, quota} = resolveThreadConfig({cwd, env});
    expect(problems).toEqual([]);
    expect(quota.mode).toEqual({source: 'default', value: 'off'});
    expect(quotaLimitsOf(quota)).toEqual({
      attendedGraceMinutes: 30,
      chainWeekPercent: 5,
      dollarsPerWeekPercent: {
        fable: 12.9,
        opus: 32.3,
        other: 12.9,
        sonnet: 16.8,
      },
      floorWeekPercent: 75,
      projectDayWeekPercent: 10,
    });
    expect(quota.recheckSeconds).toEqual({source: 'default', value: 60});
  });

  test('each field resolves per layer: the project file overrides only what it names', () => {
    const {cwd, env} = configWorld({
      project: quotaIn({dollarsPerWeekPercent: {opus: 40}, mode: 'observe'}),
      user: quotaIn({
        chainWeekPercent: 3,
        dollarsPerWeekPercent: {fable: 11},
        mode: 'enforce',
      }),
    });
    const {problems, quota} = resolveThreadConfig({cwd, env});
    expect(problems).toEqual([]);
    expect(quota.mode).toEqual({source: 'project', value: 'observe'});
    expect(quota.chainWeekPercent).toEqual({source: 'user', value: 3});
    expect(quota.projectDayWeekPercent).toEqual({source: 'default', value: 10});
    expect(quota.dollarsPerWeekPercent).toEqual({
      fable: {source: 'user', value: 11},
      opus: {source: 'project', value: 40},
      other: {source: 'default', value: 12.9},
      sonnet: {source: 'default', value: 16.8},
    });
  });

  test('a wrong-shaped mode is named in the problems and ignored', () => {
    const {cwd, env} = configWorld({
      user: quotaIn({chainWeekPercent: 4, mode: 'enforced'}),
    });
    const resolved = resolveThreadConfig({cwd, env});
    // zod rejects the user file, so it contributes nothing: mode stays off
    // and its chainWeekPercent is not used either (the sdk-config rule).
    expect(resolved.quota.mode).toEqual({source: 'default', value: 'off'});
    expect(resolved.quota.chainWeekPercent.value).toBe(5);
    expect(resolved.problems.join('\n')).toContain(
      'componentConfig.thread.quota.mode: Invalid option',
    );
  });

  test('the field walk names and skips a value zod never saw (second line)', () => {
    const problems: string[] = [];
    const quota = resolveQuotaConfig(
      [
        {name: 'user', section: {floorWeekPercent: 70, mode: 'observe'}},
        {
          name: 'project',
          section: {
            dollarsPerWeekPercent: {opus: -1, sonnet: 'cheap'},
            floorWeekPercent: 120,
            mode: 'on',
            recheckSeconds: 0,
          },
        },
        {name: 'project', section: 'enforce'},
      ],
      problems,
    );
    expect(quota.mode).toEqual({source: 'user', value: 'observe'});
    expect(quota.floorWeekPercent).toEqual({source: 'user', value: 70});
    expect(quota.recheckSeconds.value).toBe(60);
    expect(quota.dollarsPerWeekPercent.opus.value).toBe(32.3);
    expect(quota.dollarsPerWeekPercent.sonnet.value).toBe(16.8);
    expect(problems).toEqual([
      'componentConfig.thread.quota in the project config is "enforce", which is not an object — ignoring it.',
      'componentConfig.thread.quota.mode in the project config is "on", which is not one of off, observe, enforce — ignoring it and using "observe".',
      'componentConfig.thread.quota.floorWeekPercent in the project config is 120, which is not a percentage from 0 to 100 — ignoring it and using 70.',
      'componentConfig.thread.quota.recheckSeconds in the project config is 0, which is not a positive number of seconds — ignoring it and using 60.',
      'componentConfig.thread.quota.dollarsPerWeekPercent.opus in the project config is -1, which is not a positive number of dollars — ignoring it and using 32.3.',
      'componentConfig.thread.quota.dollarsPerWeekPercent.sonnet in the project config is "cheap", which is not a positive number of dollars — ignoring it and using 16.8.',
    ]);
  });

  test('`config schema` prints every quota field with its default and a description', () => {
    const {cwd, env} = configWorld({});
    const lines = renderConfigSchema({env, projectRoot: cwd})
      .split('\n')
      .filter((line) => line.includes('componentConfig.thread.quota'));
    const expected: Record<string, string | null> = {
      quota: null,
      'quota.attendedGraceMinutes': 'default 30',
      'quota.chainWeekPercent': 'default 5',
      'quota.dollarsPerWeekPercent': null,
      'quota.dollarsPerWeekPercent.fable': 'default 12.9',
      'quota.dollarsPerWeekPercent.opus': 'default 32.3',
      'quota.dollarsPerWeekPercent.other': 'default 12.9',
      'quota.dollarsPerWeekPercent.sonnet': 'default 16.8',
      'quota.floorWeekPercent': 'default 75',
      'quota.mode': 'default "off"',
      'quota.projectDayWeekPercent': 'default 10',
      'quota.recheckSeconds': 'default 60',
    };
    for (const [key, defaultText] of Object.entries(expected)) {
      const line = lines.find((entry) =>
        entry.trimStart().startsWith(`componentConfig.thread.${key} `),
      );
      expect(line).toBeDefined();
      if (defaultText != null) expect(line).toContain(defaultText);
      expect((line ?? '').split('  ·  ').length).toBeGreaterThan(1);
    }
    expect(DEFAULT_COMPONENT_CONFIG.thread.quota).toBe(QUOTA_DEFAULTS);
  });
});
