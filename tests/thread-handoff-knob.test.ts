/**
 * componentConfig.thread.handoff (epic home-base-mbnjv C1, built by
 * home-base-mbnjv.1): the defaults, the per-field layering, a bad value named
 * and ignored, and `config schema` printing every field.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync} from 'fs';
import {join} from 'path';

import {DEFAULT_COMPONENT_CONFIG, renderConfigSchema} from '../src/sdk-config';
import {resolveThreadConfig} from '../src/thread/config';
import {HANDOFF_DEFAULTS} from '../src/thread/defaults';
import {resolveHandoffConfig} from '../src/thread/handoff-knob';
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

function handoffIn(section: Record<string, unknown>): Record<string, unknown> {
  return {componentConfig: {thread: {handoff: section}}};
}

describe('componentConfig.thread.handoff', () => {
  test('absent everywhere: every default, successor OFF (D10)', () => {
    const {cwd, env} = configWorld({});
    const {handoff, problems} = resolveThreadConfig({cwd, env});
    expect(problems).toEqual([]);
    expect(handoff).toEqual({
      maxLiveSessions: HANDOFF_DEFAULTS.maxLiveSessions,
      maxLiveSessionsSource: 'default',
      maxUnattendedHandoffs: 3,
      maxUnattendedHandoffsSource: 'default',
      permissionMode: 'auto',
      permissionModeSource: 'default',
      predecessor: 'keep',
      predecessorSource: 'default',
      successor: false,
      successorSource: 'default',
      usage: {
        maxSampleAgeMinutes: 150,
        maxSampleAgeMinutesSource: 'default',
        maxSessionPercent: 85,
        maxSessionPercentSource: 'default',
        maxWeekPercent: 90,
        maxWeekPercentSource: 'default',
      },
    });
  });

  test('each field resolves per layer: the project file overrides only what it names', () => {
    const {cwd, env} = configWorld({
      project: handoffIn({predecessor: 'exit', successor: true}),
      user: handoffIn({
        maxLiveSessions: 12,
        predecessor: 'close',
        usage: {maxWeekPercent: 70},
      }),
    });
    const {handoff, problems} = resolveThreadConfig({cwd, env});
    expect(problems).toEqual([]);
    expect(handoff).toMatchObject({
      maxLiveSessions: 12,
      maxLiveSessionsSource: 'user',
      predecessor: 'exit',
      predecessorSource: 'project',
      successor: true,
      successorSource: 'project',
    });
    expect(handoff.usage).toMatchObject({
      maxSessionPercent: 85,
      maxSessionPercentSource: 'default',
      maxWeekPercent: 70,
      maxWeekPercentSource: 'user',
    });
  });

  test('a bad predecessor is named in the problems and ignored', () => {
    const {cwd, env} = configWorld({
      project: handoffIn({predecessor: 'exits', successor: true}),
    });
    const resolved = resolveThreadConfig({cwd, env});
    expect(resolved.handoff.predecessor).toBe('keep');
    expect(resolved.problems.join('\n')).toContain(
      'componentConfig.thread.handoff.predecessor: Invalid option',
    );
    // The schema rejects the file, so it contributes NOTHING (the sdk-config
    // rule, the same as a bad enforceMode): successor stays off too.
    expect(resolved.handoff.successor).toBe(false);
  });

  test('a bad permissionMode in the user file is named and ignored', () => {
    const {cwd, env} = configWorld({
      user: handoffIn({permissionMode: 'yolo'}),
    });
    const resolved = resolveThreadConfig({cwd, env});
    expect(resolved.handoff.permissionMode).toBe('auto');
    expect(resolved.handoff.permissionModeSource).toBe('default');
    expect(resolved.problems.join('\n')).toContain(
      'componentConfig.thread.handoff.permissionMode: Invalid option',
    );
  });

  test('the field walk names and skips a value zod never saw (second line)', () => {
    const problems: string[] = [];
    const handoff = resolveHandoffConfig(
      [
        {name: 'user', section: {maxLiveSessions: 30, predecessor: 'exit'}},
        {
          name: 'project',
          section: {
            maxLiveSessions: 0,
            permissionMode: 'yolo',
            predecessor: 'nope',
            usage: {maxSessionPercent: 140},
          },
        },
      ],
      problems,
    );
    expect(handoff.predecessor).toBe('exit');
    expect(handoff.predecessorSource).toBe('user');
    expect(handoff.maxLiveSessions).toBe(30);
    expect(handoff.permissionMode).toBe('auto');
    expect(handoff.usage.maxSessionPercent).toBe(85);
    expect(problems).toEqual([
      'componentConfig.thread.handoff.predecessor in the project config is "nope", which is not one of keep, exit, close — ignoring it and using "exit".',
      'componentConfig.thread.handoff.maxLiveSessions in the project config is 0, which is not a whole number, 1 or more — ignoring it and using 30.',
      'componentConfig.thread.handoff.permissionMode in the project config is "yolo", which is not one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan — ignoring it and using "auto".',
      'componentConfig.thread.handoff.usage.maxSessionPercent in the project config is 140, which is not a percentage from 0 to 100 — ignoring it and using 85.',
    ]);
  });

  test('`config schema` prints every handoff field with its default and a description', () => {
    const {cwd, env} = configWorld({});
    const lines = renderConfigSchema({env, projectRoot: cwd})
      .split('\n')
      .filter((line) => line.includes('componentConfig.thread.handoff'));
    const expected: Record<string, string | null> = {
      handoff: null,
      'handoff.maxLiveSessions': `default ${HANDOFF_DEFAULTS.maxLiveSessions}`,
      'handoff.maxUnattendedHandoffs': 'default 3',
      'handoff.permissionMode': 'default "auto"',
      'handoff.predecessor': 'default "keep"',
      'handoff.successor': 'default false',
      'handoff.usage': null,
      'handoff.usage.maxSampleAgeMinutes': 'default 150',
      'handoff.usage.maxSessionPercent': 'default 85',
      'handoff.usage.maxWeekPercent': 'default 90',
    };
    for (const [key, defaultText] of Object.entries(expected)) {
      const line = lines.find((entry) =>
        entry.trimStart().startsWith(`componentConfig.thread.${key} `),
      );
      expect(line).toBeDefined();
      if (defaultText != null) expect(line).toContain(defaultText);
      // A description follows the last ` · `.
      expect((line ?? '').split('  ·  ').length).toBeGreaterThan(1);
    }
    expect(DEFAULT_COMPONENT_CONFIG.thread.handoff).toBe(HANDOFF_DEFAULTS);
  });
});
