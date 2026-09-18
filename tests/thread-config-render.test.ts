/**
 * `componentConfig.thread.render.emojiHeader` (home-base-p1uj.14, D19).
 *
 * The first NESTED knob in the thread block, so it does not go through
 * `resolveFlag` and needs its own proof that it layers the same way: default,
 * then the user file, then the repo's own `justin-sdk.config.json` — with "this
 * layer says nothing" kept distinct from an explicit `false`, which is what
 * stops an absent user file from reading as a deliberate "off".
 */

import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

import {THREAD_DEFAULT_EMOJI_HEADER} from '../src/thread/defaults';
import {resolveThreadConfig} from '../src/thread/config';

const roots: string[] = [];

function repoWith(project: unknown | null, user: unknown | null) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-render-config-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'x'}));
  if (project != null) {
    // The project schema requires the three bookkeeping fields an installed
    // repo always has; a file missing them is a schema violation that
    // contributes NOTHING, which is the behaviour, not the thing under test.
    writeFileSync(
      join(dir, 'justin-sdk.config.json'),
      JSON.stringify(
        {
          components: [],
          lastSynced: '2026-09-14',
          version: '0.33.0',
          ...(project as Record<string, unknown>),
        },
        null,
        2,
      ),
    );
  }
  const home = mkdtempSync(join(tmpdir(), 'thread-render-home-'));
  roots.push(home);
  if (user != null) {
    // $XDG_CONFIG_HOME/justin-sdk/config.json is where readUserConfig looks.
    const configDir = join(home, 'justin-sdk');
    mkdirSync(configDir, {recursive: true});
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(user, null, 2),
    );
  }
  return {cwd: dir, env: {XDG_CONFIG_HOME: home}};
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, {force: true, recursive: true});
});

describe('the emojiHeader knob layers like every other thread knob', () => {
  test('nothing configured takes the default, and says the default decided', () => {
    const resolved = resolveThreadConfig(repoWith(null, null));
    expect(resolved.emojiHeader).toBe(THREAD_DEFAULT_EMOJI_HEADER);
    expect(resolved.emojiHeaderSource).toBe('default');
  });

  test('the user file turns it off everywhere', () => {
    const resolved = resolveThreadConfig(
      repoWith(null, {
        componentConfig: {thread: {render: {emojiHeader: false}}},
      }),
    );
    expect(resolved.emojiHeader).toBe(false);
    expect(resolved.emojiHeaderSource).toBe('user');
  });

  test('the repo file outranks the user file', () => {
    const resolved = resolveThreadConfig(
      repoWith(
        {componentConfig: {thread: {render: {emojiHeader: true}}}},
        {componentConfig: {thread: {render: {emojiHeader: false}}}},
      ),
    );
    expect(resolved.emojiHeader).toBe(true);
    expect(resolved.emojiHeaderSource).toBe('project');
  });

  test('a thread block with no render section leaves the default alone', () => {
    // An absent nested block must not read as an explicit false — that is the
    // conflation this layering exists to avoid.
    const resolved = resolveThreadConfig(
      repoWith({componentConfig: {thread: {enabled: true}}}, null),
    );
    expect(resolved.emojiHeader).toBe(THREAD_DEFAULT_EMOJI_HEADER);
    expect(resolved.emojiHeaderSource).toBe('default');
    expect(resolved.enabled).toBe(true);
  });
});
