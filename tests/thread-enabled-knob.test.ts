/**
 * `threadEnabledFromFiles` (the zod-free reader the `isThreadEnabled`
 * predicate uses, home-base-yukaf.26) must give the same answer as
 * `resolveThreadConfig(...).enabled` — the resolver every `thread` command
 * uses. Two readers of one knob drift unless something compares them, so this
 * file walks every pairing of what the user file and the project file can say.
 *
 * Not covered, on purpose: a file that is valid JSON with a schema error in
 * ANOTHER key. The resolver drops that whole file; the fast reader still reads
 * `enabled` from it. That is the one documented difference
 * (src/thread/enabled-knob.ts).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {resolveThreadConfig} from '../src/thread/config';
import {threadEnabledFromFiles} from '../src/thread/enabled-knob';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** What one config file says. `null` = the file does not exist. */
type FileSays =
  | null
  | {enabled: unknown}
  | 'invalid-json'
  | 'no-thread-section'
  | 'unreadable';

const VARIANTS: readonly FileSays[] = [
  null,
  {enabled: true},
  {enabled: false},
  {enabled: 'yes'},
  'invalid-json',
  'no-thread-section',
  'unreadable',
];

function describeSays(says: FileSays): string {
  return says == null
    ? 'absent'
    : typeof says === 'string'
      ? says
      : `enabled=${JSON.stringify(says.enabled)}`;
}

function writeConfig(path: string, says: FileSays): void {
  if (says == null) return;
  mkdirSync(join(path, '..'), {recursive: true});
  if (says === 'invalid-json') {
    writeFileSync(path, '{"componentConfig": {"thread": {"enabled": true}');
    return;
  }
  if (says === 'no-thread-section') {
    writeFileSync(path, JSON.stringify({componentConfig: {}}));
    return;
  }
  if (says === 'unreadable') {
    writeFileSync(
      path,
      JSON.stringify({componentConfig: {thread: {enabled: true}}}),
    );
    chmodSync(path, 0o000);
    return;
  }
  writeFileSync(path, JSON.stringify({componentConfig: {thread: says}}));
}

describe('threadEnabledFromFiles agrees with resolveThreadConfig', () => {
  for (const user of VARIANTS) {
    for (const project of VARIANTS) {
      test(`user ${describeSays(user)}, project ${describeSays(project)}`, () => {
        const sb = createSandbox();
        sandboxes.push(sb);
        const root = join(sb.path, 'repo');
        mkdirSync(join(root, '.git'), {recursive: true});
        const env = {HOME: sb.path, XDG_CONFIG_HOME: join(sb.path, 'xdg')};
        const userPath = join(env.XDG_CONFIG_HOME, 'justin-sdk', 'config.json');
        const projectPath = join(root, 'justin-sdk.config.json');
        writeConfig(userPath, user);
        writeConfig(projectPath, project);
        try {
          const fast = threadEnabledFromFiles(root, env);
          const full = resolveThreadConfig({cwd: root, env}).enabled;
          expect(fast).toBe(full);
        } finally {
          for (const [path, says] of [
            [userPath, user],
            [projectPath, project],
          ] as const) {
            if (says === 'unreadable') chmodSync(path, 0o644);
          }
        }
      });
    }
  }

  test('the matrix is not vacuous: both answers occur', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const env = {HOME: sb.path, XDG_CONFIG_HOME: join(sb.path, 'xdg')};
    const root = join(sb.path, 'repo');
    mkdirSync(join(root, '.git'), {recursive: true});
    expect(threadEnabledFromFiles(root, env)).toBe(false);
    writeConfig(join(root, 'justin-sdk.config.json'), {enabled: true});
    expect(threadEnabledFromFiles(root, env)).toBe(true);
  });
});
