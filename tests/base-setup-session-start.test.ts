/**
 * The SessionStart hook is EDITED IN PLACE, never rebuilt (dchjw.15 F3).
 *
 * `stepClaudeSettings` used to write `[...foreign, mine]`. Two bugs fell out of
 * that one line:
 *  - REORDERING. Every entry this installer does not own was hoisted above its
 *    own — in home-base, `thread start` moved ahead of the SDK entry on every
 *    single install. Hook order is observable; a scaffolding tool must not
 *    decide it.
 *  - DUPLICATION. An entry bundling this installer's command with a foreign one
 *    failed the `.every()` ownership test, so it was classed as foreign, kept,
 *    and a second copy of the hook was appended beside it. Both then fired at
 *    every session start.
 *
 * NEGATIVE CONTROLS (run by hand, recorded on dchjw.15):
 *  - restoring `.every()` in `isOwnSessionStartHookEntry` fails "a bundled
 *    entry is rewritten in place" with 2 entries instead of 1;
 *  - restoring the `[...foreign, mine]` rebuild fails "foreign entries keep
 *    their position" — the thread hook comes back at index 0.
 */

import {describe, expect, test} from 'bun:test';

import {
  SESSION_START_HOOK_COMMAND,
  upsertSessionStartHook,
} from '../src/base-setup';

/** An older spelling of THIS installer's own entry — the `if` shell branch. */
const OLD_OWN =
  'if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then bunx github:justinhaaheim/justin-sdk setup-env; else bunx @justinhaaheim/justin-sdk doctor --quiet || true; fi';

/** The pre-j2n7 entry, which ran the committed copy this run deletes. */
const RETIRED = 'bun scripts/setup-env.ts';

const THREAD = 'bun run justin-sdk thread start --hook';

const entry = (...commands: string[]): unknown => ({
  hooks: commands.map((command) => ({command, type: 'command'})),
});

const commandsOf = (entries: readonly unknown[]): string[][] =>
  entries.map((e) =>
    ((e as {hooks?: {command?: string}[]}).hooks ?? []).map(
      (hook) => hook.command ?? '',
    ),
  );

describe('upsertSessionStartHook', () => {
  test('foreign entries keep their position', () => {
    // MINE FIRST, foreign second — the order the `[...foreign, mine]` rebuild
    // inverted. home-base's real settings.json has exactly this shape, and its
    // `thread start` entry was hoisted above the SDK entry on every install.
    const result = upsertSessionStartHook([entry(OLD_OWN), entry(THREAD)]);
    expect(commandsOf(result)).toEqual([
      [SESSION_START_HOOK_COMMAND],
      [THREAD],
    ]);
  });

  test('a bundled entry is rewritten in place, and its foreign hook survives', () => {
    const result = upsertSessionStartHook([entry(OLD_OWN, 'echo hello')]);
    expect(result).toHaveLength(1);
    expect(commandsOf(result)).toEqual([
      [SESSION_START_HOOK_COMMAND, 'echo hello'],
    ]);
  });

  test('the entry keeps its other keys (a matcher)', () => {
    const result = upsertSessionStartHook([
      {...(entry(OLD_OWN) as object), matcher: 'startup|resume'},
    ]);
    expect((result[0] as {matcher?: string}).matcher).toBe('startup|resume');
  });

  test('an entry naming the retired committed copy is dropped', () => {
    const result = upsertSessionStartHook([entry(RETIRED), entry(THREAD)]);
    expect(commandsOf(result)).toEqual([
      [THREAD],
      [SESSION_START_HOOK_COMMAND],
    ]);
  });

  test('an absent hook is appended, at the end', () => {
    const result = upsertSessionStartHook([entry(THREAD)]);
    expect(commandsOf(result)).toEqual([
      [THREAD],
      [SESSION_START_HOOK_COMMAND],
    ]);
  });

  test('a hand-written absolute-path hook is recognised, not joined by a second', () => {
    // The unenrolled-repo case: `bun run justin-sdk` does not resolve there, so
    // somebody wrote the path out. Recognised → left alone AND not duplicated,
    // which is the contract isSessionStartHookEntry documents.
    const hand = '/Users/x/Dev/home-base/pkg/justin-sdk/src/cli.ts setup-env';
    expect(commandsOf(upsertSessionStartHook([entry(hand)]))).toEqual([[hand]]);
  });

  test('a second run changes nothing', () => {
    const once = upsertSessionStartHook([entry(THREAD), entry(OLD_OWN)]);
    expect(upsertSessionStartHook(once)).toEqual(once);
  });

  test('two of this installers own entries collapse to one', () => {
    // What an older SDK left behind when it appended instead of rewriting.
    const result = upsertSessionStartHook([
      entry(OLD_OWN),
      entry(SESSION_START_HOOK_COMMAND),
    ]);
    expect(commandsOf(result)).toEqual([[SESSION_START_HOOK_COMMAND]]);
  });

  test('collapsing a duplicate keeps the foreign hook bundled with it', () => {
    const result = upsertSessionStartHook([
      entry(SESSION_START_HOOK_COMMAND),
      entry(OLD_OWN, 'echo hello'),
    ]);
    expect(commandsOf(result)).toEqual([
      [SESSION_START_HOOK_COMMAND],
      ['echo hello'],
    ]);
  });
});
