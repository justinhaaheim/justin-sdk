/**
 * HANDOFF_SANDBOX, doctor's check for the global sandbox exclusion and allow
 * rule `thread handoff` needs (home-base-mbnjv.6 AC3; epic home-base-mbnjv D4,
 * C10).
 *
 * Every case points HOME at a throwaway directory (and XDG_CONFIG_HOME at an
 * empty one), so Justin's real ~/.claude/settings.json and user config are
 * never read. Nothing here writes user settings; neither does the code.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-mbnjv.6): making the
 * check accept a settings file with no exclusion fails "exclusion missing".
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {handoffSandboxCheckResult} from '../src/doctor';
import {SDK_HANDOFF_CALL} from '../src/sdk-invocation';
import {
  bashPatternMatches,
  bashRulePattern,
  entryCovers,
  HANDOFF_COMMAND,
  HANDOFF_SANDBOX_SETTINGS,
  sampleInvocations,
} from '../src/thread/handoff-sandbox';
import {SANDBOXED_CALL_INSTRUCTIONS} from '../src/thread/handoff-successor';
import {RESPAWN_RETIRED_LINES} from '../src/thread/respawn';
import {GUARD_DOORS, guardDenialMessage} from '../src/thread/session-guard';
import {OPEN_WORK_HANDOFF} from '../src/thread/session-report';
import {threadRulesTemplateText} from '../src/thread-rules';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/**
 * Written out, not built from the constant: these are the strings Justin
 * pastes, so the test pins them (epic home-base-mbnjv C12, mbnjv.10).
 */
const EXCLUSION = './node_modules/.bin/justin-sdk thread handoff *';
const ALLOW_RULE = 'Bash(./node_modules/.bin/justin-sdk thread handoff *)';

/** The retracted entries (C12): a `bun …` call is never excluded. */
const RETRACTED_EXCLUSION = 'bun run justin-sdk thread handoff *';
const RETRACTED_ALLOW_RULE = 'Bash(bun run justin-sdk thread handoff *)';

/** The exact JSON doctor prints, per case (AC3 "warn with the exact JSON"). */
const JSON_BOTH = `{
  "permissions": {
    "allow": [
      "Bash(./node_modules/.bin/justin-sdk thread handoff *)"
    ]
  },
  "sandbox": {
    "excludedCommands": [
      "./node_modules/.bin/justin-sdk thread handoff *"
    ]
  }
}`;
const JSON_EXCLUSION_ONLY = `{
  "sandbox": {
    "excludedCommands": [
      "./node_modules/.bin/justin-sdk thread handoff *"
    ]
  }
}`;
const JSON_ALLOW_ONLY = `{
  "permissions": {
    "allow": [
      "Bash(./node_modules/.bin/justin-sdk thread handoff *)"
    ]
  }
}`;

const ADVICE_LEAD =
  'Add this to ~/.claude/settings.json by hand (justin-sdk never writes it), merging each entry into the list already there:\n';

/** A throwaway HOME. `settings` null: no settings file; a string: raw bytes. */
function home(settings: unknown): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  mkdirSync(join(sb.path, 'config'), {recursive: true});
  if (settings != null) {
    mkdirSync(join(sb.path, '.claude'), {recursive: true});
    writeFileSync(
      join(sb.path, '.claude', 'settings.json'),
      typeof settings === 'string'
        ? settings
        : `${JSON.stringify(settings, null, 2)}\n`,
    );
  }
  return sb.path;
}

function envFor(homePath: string): Record<string, string> {
  return {HOME: homePath, XDG_CONFIG_HOME: join(homePath, 'config')};
}

function settingsWith(
  excludedCommands: string[],
  allow: string[],
): Record<string, unknown> {
  return {
    permissions: {allow, deny: []},
    sandbox: {enabled: true, excludedCommands},
  };
}

describe('the one constant', () => {
  test('is the SDK bin by path (C12), in both settings', () => {
    expect(HANDOFF_SANDBOX_SETTINGS.sandbox.excludedCommands).toEqual([
      EXCLUSION,
    ]);
    expect(HANDOFF_SANDBOX_SETTINGS.permissions.allow).toEqual([ALLOW_RULE]);
    expect(HANDOFF_COMMAND).toBe(SDK_HANDOFF_CALL);
    expect(SDK_HANDOFF_CALL).toBe(
      './node_modules/.bin/justin-sdk thread handoff',
    );
  });
});

/**
 * AC1 of home-base-mbnjv.10: every text that tells a session how to hand off
 * spells the call by path, from SDK_HANDOFF_CALL, and none says `bun run
 * justin-sdk thread handoff` (a bun call is never excluded, C12). The rule is
 * a plain-copy template, so the test is what ties it to the constant.
 */
describe('one spelling of the handoff call (mbnjv.10 AC1)', () => {
  const OLD = 'bun run justin-sdk thread handoff';

  test('the rule (templates/rules/handoff.md) runs SDK_HANDOFF_CALL from the repository root', () => {
    const rule = threadRulesTemplateText('handoff.md');
    expect(rule).not.toBeNull();
    const text = rule ?? '';
    expect(text).toContain(
      `\`\`\`\n${SDK_HANDOFF_CALL} --note "<one line the next session must know>"\n\`\`\``,
    );
    expect(text).toContain('Run this command once, from the repository root');
    expect(text).toContain('run `cd <repository root>` as its own Bash call');
    expect(text).toContain('Say so in your final report and stop.');
    // The one note character measured to keep the call sandboxed (run
    // 20261029T162150Z): a backtick, even inside single quotes.
    expect(text).toContain('Keep backticks out of the note.');
    expect(text).not.toContain(OLD);
  });

  test('the guard, the sandboxed-call and respawn messages and the status verdict name it', () => {
    const texts: Record<string, string> = {
      GUARD_DOORS: GUARD_DOORS.join('\n'),
      OPEN_WORK_HANDOFF: OPEN_WORK_HANDOFF.map((piece) =>
        typeof piece === 'string'
          ? piece
          : 'code' in piece
            ? piece.code
            : piece.strong,
      ).join(''),
      RESPAWN_RETIRED_LINES: RESPAWN_RETIRED_LINES.join('\n'),
      SANDBOXED_CALL_INSTRUCTIONS: SANDBOXED_CALL_INSTRUCTIONS.join('\n'),
      subagentDenial: guardDenialMessage({
        command: `${SDK_HANDOFF_CALL} --note x`,
        kind: 'deny',
        reason: 'subagentThread',
        why: 'a subagent may not run `thread handoff`',
      }),
    };
    for (const [name, text] of Object.entries(texts)) {
      expect({name, names: text.includes(SDK_HANDOFF_CALL)}).toEqual({
        name,
        names: true,
      });
      expect({name, old: text.includes(OLD)}).toEqual({name, old: false});
    }
  });
});

describe('Bash rule matching', () => {
  test('`*` matches any text, spaces included; no `*` matches only itself', () => {
    expect(
      bashPatternMatches(
        EXCLUSION,
        './node_modules/.bin/justin-sdk thread handoff --note "x y"',
      ),
    ).toBe(true);
    expect(
      bashPatternMatches(
        './node_modules/.bin/justin-sdk thread handoff',
        './node_modules/.bin/justin-sdk thread handoff --note "x"',
      ),
    ).toBe(false);
    expect(bashPatternMatches('br', 'br')).toBe(true);
    expect(bashPatternMatches('br', 'br list')).toBe(false);
    expect(bashPatternMatches('br *', 'br list')).toBe(true);
    // Regex characters in an entry are literal.
    expect(bashPatternMatches('a.b *', 'axb c')).toBe(false);
  });

  test('the legacy `X:*` is read narrowly: X alone or X then a space', () => {
    expect(
      bashPatternMatches(
        'bun run justin-sdk:*',
        'bun run justin-sdk thread handoff',
      ),
    ).toBe(true);
    expect(
      bashPatternMatches('bun run justin-sdk:*', 'bun run justin-sdk-latest x'),
    ).toBe(false);
  });

  test('an entry covers a pattern when it matches every sample invocation', () => {
    expect(sampleInvocations(EXCLUSION)).toEqual([
      './node_modules/.bin/justin-sdk thread handoff --note "finish the migration"',
      './node_modules/.bin/justin-sdk thread handoff --note "finish the migration" --model haiku',
    ]);
    expect(entryCovers(EXCLUSION, EXCLUSION)).toBe(true);
    expect(entryCovers('./node_modules/.bin/justin-sdk *', EXCLUSION)).toBe(
      true,
    );
    expect(
      entryCovers('./node_modules/.bin/justin-sdk thread handoff', EXCLUSION),
    ).toBe(false);
    expect(
      entryCovers('./node_modules/.bin/justin-sdk thread spawn *', EXCLUSION),
    ).toBe(false);
    expect(
      entryCovers(
        'cd * && ./node_modules/.bin/justin-sdk thread handoff *',
        EXCLUSION,
      ),
    ).toBe(false);
    // The retracted bun entries cover nothing now (C12).
    expect(entryCovers(RETRACTED_EXCLUSION, EXCLUSION)).toBe(false);
    expect(entryCovers('bun run justin-sdk *', EXCLUSION)).toBe(false);
    expect(entryCovers('bun *', EXCLUSION)).toBe(false);
  });

  test('a permissions rule gives its Bash pattern; other tools give null', () => {
    expect(bashRulePattern(ALLOW_RULE)).toBe(EXCLUSION);
    expect(bashRulePattern('Bash')).toBe('*');
    expect(bashRulePattern('Bash(*)')).toBe('*');
    expect(bashRulePattern('Read(/Users/**)')).toBeNull();
  });
});

describe('handoffSandboxCheckResult (AC3)', () => {
  test('both entries present: pass, naming them', () => {
    const result = handoffSandboxCheckResult(
      envFor(
        home(
          settingsWith(['br *', EXCLUSION], ['Bash(git status)', ALLOW_RULE]),
        ),
      ),
    );
    expect(result.pass).toBe(true);
    expect(result.message).toContain(
      `sandbox.excludedCommands \`${EXCLUSION}\``,
    );
    expect(result.message).toContain(`permissions.allow \`${ALLOW_RULE}\``);
    expect(result.fix).toBeUndefined();
  });

  test('broader entries that cover the command: pass, naming what matched', () => {
    const result = handoffSandboxCheckResult(
      envFor(
        home(
          settingsWith(
            ['./node_modules/.bin/justin-sdk *'],
            ['Bash(./node_modules/.bin/justin-sdk *)'],
          ),
        ),
      ),
    );
    expect(result.pass).toBe(true);
    expect(result.message).toContain('`./node_modules/.bin/justin-sdk *`');
    expect(result.message).toContain(
      '`Bash(./node_modules/.bin/justin-sdk *)`',
    );
  });

  test('only the retracted bun entries (C12): warn with the exact JSON for both', () => {
    const result = handoffSandboxCheckResult(
      envFor(
        home(
          settingsWith(
            [RETRACTED_EXCLUSION, 'bun *'],
            [RETRACTED_ALLOW_RULE, 'Bash(bun *)'],
          ),
        ),
      ),
    );
    expect(result.pass).toBe(false);
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_BOTH}`);
  });

  test('exclusion missing: warn with the exact JSON for the exclusion only', () => {
    const result = handoffSandboxCheckResult(
      envFor(home(settingsWith(['br *'], [ALLOW_RULE]))),
    );
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(
      'no sandbox.excludedCommands entry covers it',
    );
    expect(result.message).not.toContain('no permissions.allow rule');
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_EXCLUSION_ONLY}`);
  });

  test('allow rule missing: warn with the exact JSON for the allow rule only', () => {
    const result = handoffSandboxCheckResult(
      envFor(home(settingsWith([EXCLUSION], ['Bash(git status)']))),
    );
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('no permissions.allow rule covers it');
    expect(result.message).not.toContain('no sandbox.excludedCommands entry');
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_ALLOW_ONLY}`);
  });

  test('both missing: warn with the exact JSON for both', () => {
    const result = handoffSandboxCheckResult(
      envFor(home(settingsWith([], []))),
    );
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(
      'no sandbox.excludedCommands entry covers it',
    );
    expect(result.message).toContain('no permissions.allow rule covers it');
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_BOTH}`);
  });

  test('a bare entry (no `*`) covers nothing with arguments: warn (pp1vx.5)', () => {
    const result = handoffSandboxCheckResult(
      envFor(
        home(
          settingsWith(
            ['./node_modules/.bin/justin-sdk thread handoff'],
            ['Bash(./node_modules/.bin/justin-sdk thread handoff)'],
          ),
        ),
      ),
    );
    expect(result.pass).toBe(false);
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_BOTH}`);
  });

  test('no settings file: warn with the exact JSON for both, saying the file does not exist', () => {
    const result = handoffSandboxCheckResult(envFor(home(null)));
    expect(result.pass).toBe(false);
    expect(result.message).toContain('which does not exist');
    expect(result.fix).toBe(`${ADVICE_LEAD}${JSON_BOTH}`);
  });

  test('unparseable settings: "cannot check", never "missing" (rule 7)', () => {
    const result = handoffSandboxCheckResult(envFor(home('{ "sandbox": ')));
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('could not be read or parsed');
    expect(result.message).toContain('UNKNOWN, not "missing"');
    expect(result.message).not.toContain('does not cover');
    expect(result.fix).not.toContain('{');
    expect(result.fix).toContain('Read ~/.claude/settings.json by hand');
  });

  test('settings that parse to something other than an object: "cannot check"', () => {
    const result = handoffSandboxCheckResult(envFor(home('[]\n')));
    expect(result.pass).toBe(false);
    expect(result.message).toContain('it is not a JSON object');
    expect(result.message).toContain('UNKNOWN');
  });

  test('advice only: no state carries a fixCommand or fixFn (the SDK never writes user settings)', () => {
    for (const settings of [settingsWith([], []), '{ nope', null]) {
      const result = handoffSandboxCheckResult(envFor(home(settings)));
      expect(result.fixCommand).toBeUndefined();
      expect(result.fixFn).toBeUndefined();
    }
  });
});

/**
 * Doctor end to end: the real CLI in a fixture repo, HOME and XDG_CONFIG_HOME
 * on throwaways. The fixture has no node_modules, so this also proves the
 * printed JSON escapes doctor's `bun install && ` advice prefix.
 */
describe('doctor HANDOFF_SANDBOX (AC3)', () => {
  function repo(successor: boolean | null): string {
    const sb = createSandbox();
    sandboxes.push(sb);
    git(sb.path, ['init', '-q', '-b', 'main']);
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      `${JSON.stringify(
        {
          ...(successor == null
            ? {}
            : {componentConfig: {thread: {handoff: {successor}}}}),
          components: ['base-setup'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(sb.path, 'package.json'),
      `${JSON.stringify({name: 'p'}, null, 2)}\n`,
    );
    return sb.path;
  }

  function doctor(cwd: string, homePath: string): string {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '..', 'src', 'cli.ts'), 'doctor'],
      {
        cwd,
        encoding: 'utf-8',
        env: {
          ...(process.env as Record<string, string>),
          ...envFor(homePath),
          NO_COLOR: '1',
        },
      },
    );
    return `${result.stdout}${result.stderr}`;
  }

  test('knob off (absent, and false): the check does not run', () => {
    const noSettings = home(null);
    for (const successor of [null, false]) {
      const out = doctor(repo(successor), noSettings);
      expect(out).toContain('USER_LEVEL_SESSION_START');
      expect(out).not.toContain('HANDOFF_SANDBOX');
      expect(out).not.toContain('thread handoff *');
    }
  });

  test('knob on, both missing: warns and prints the exact JSON', () => {
    const out = doctor(repo(true), home(settingsWith([], [])));
    expect(out).toContain('HANDOFF_SANDBOX');
    expect(out).toContain(
      'componentConfig.thread.handoff.successor is on here',
    );
    for (const line of JSON_BOTH.split('\n')) expect(out).toContain(line);
    expect(out).toContain('"./node_modules/.bin/justin-sdk thread handoff *"');
    expect(out).toContain(
      '"Bash(./node_modules/.bin/justin-sdk thread handoff *)"',
    );
    expect(out).not.toContain('bun run justin-sdk thread handoff');
    expect(out).not.toContain('bun install && ./node_modules');
  });

  test('knob on, both present: passes', () => {
    const out = doctor(
      repo(true),
      home(settingsWith([EXCLUSION], [ALLOW_RULE])),
    );
    const line = out
      .split('\n')
      .find((text) => text.includes('HANDOFF_SANDBOX'));
    expect(line).toContain('✓');
    expect(out).not.toContain('"excludedCommands"');
  });

  test('knob on, unparseable settings: "cannot check", not "missing"', () => {
    const out = doctor(repo(true), home('{ broken'));
    expect(out).toContain('HANDOFF_SANDBOX');
    expect(out).toContain('UNKNOWN, not "missing"');
    expect(out).not.toContain('"excludedCommands"');
  });
});
