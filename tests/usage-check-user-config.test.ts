/**
 * usage-check reads its knobs from the USER config as well as the repo's
 * (home-base-o5atv.1.1), so one `wrapUpAt` in
 * `$XDG_CONFIG_HOME/justin-sdk/config.json` reaches every repo that has the
 * component. Justin, 2026-11-08: "Maybe we just do specify the 400k there for
 * now? Will the hooks read from this?"
 *
 * The precedence these tests pin (D6): the repo's number wins. A repo's 0 turns
 * the directive off there. A repo's null, or no key, uses the user file's
 * number. No number anywhere means off. The user file supplies values only and
 * never switches the component on (D2).
 *
 * HERMETIC: every run points XDG_CONFIG_HOME at a temp directory, so Justin's
 * real ~/.config/justin-sdk/config.json is never read.
 */

import {describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {hookKnobOn} from '../src/hook-knobs';
import {userConfigPath} from '../src/sdk-config';
import {setQuiet} from '../src/setup-helpers';
import {resolveReportWrapUpAt} from '../src/thread/config';
import {
  HANDOFF_RULE_PATH,
  HANDOFF_WRAP_UP_DIRECTIVE,
  layerUsageCheckConfig,
  NOTICE_FYI,
  readUsageCheckConfig,
  readUsageCheckLayers,
  resolveHandoffSuccessor,
  resolveUsageCheckConfig,
  runUsageCheck,
  USAGE_CHECK_CONFIG_KEY,
  USAGE_CHECK_DEFAULTS,
  type UsageCheckConfig,
  usageCheckUserConfigPath,
  WRAP_UP_DIRECTIVE,
  wrapUpDirectiveFor,
} from '../src/usage-check';
import {stepUsageCheckConfig} from '../src/usage-check-setup';
import {captureWriteStdout} from './capture-stdout';

/** The directive text before this bead, verbatim: "session + successor off is the old text". */
const OLD_DIRECTIVE_TEXT =
  'Wrap up your session at the next available opportunity. Follow the handoff/ralph-handoff protocol.';

const HANDOFF_CALL = './node_modules/.bin/justin-sdk thread handoff';

const AGENT = 'a405a84daeae6cd2b';

type Env = Record<string, string | undefined>;

interface Fixture {
  env: Env;
  root: string;
  /** Where the user config goes inside this fixture's XDG_CONFIG_HOME. */
  userFile: string;
}

/** A scratch project root and an empty XDG_CONFIG_HOME beside it. */
function fixture(): Fixture {
  const box = mkdtempSync(join(tmpdir(), 'usage-check-user-config-'));
  const root = join(box, 'project');
  const xdg = join(box, 'xdg');
  mkdirSync(root, {recursive: true});
  mkdirSync(xdg, {recursive: true});
  return {
    env: {XDG_CONFIG_HOME: xdg},
    root,
    userFile: join(xdg, 'justin-sdk', 'config.json'),
  };
}

/**
 * The project's justin-sdk.config.json. `usageCheck: null` writes no
 * usage-check block at all (the component is not installed here).
 */
function writeProject(
  fx: Fixture,
  usageCheck: UsageCheckConfig | null,
  thread: Record<string, unknown> | null = null,
): void {
  const componentConfig: Record<string, unknown> = {};
  if (usageCheck != null) componentConfig[USAGE_CHECK_CONFIG_KEY] = usageCheck;
  if (thread != null) componentConfig.thread = thread;
  writeFileSync(
    join(fx.root, 'justin-sdk.config.json'),
    JSON.stringify({componentConfig, components: ['base-setup']}, null, 2),
  );
}

/**
 * A SEED repo: exactly what the installer writes, written BY the installer, so
 * "seed" here can never drift from what nature-sounds and the others carry.
 */
function writeSeedProject(
  fx: Fixture,
  thread: Record<string, unknown> | null = null,
): void {
  writeProject(fx, null, thread);
  setQuiet(true);
  expect(stepUsageCheckConfig(fx.root)).toBe(true);
  expect(readUsageCheckConfig(fx.root)).toEqual({
    enabled: true,
    wrapUpAt: null,
  });
}

/** The user file, from an object or (to test a malformed one) raw text. */
function writeUser(fx: Fixture, content: unknown): void {
  mkdirSync(dirname(fx.userFile), {recursive: true});
  writeFileSync(
    fx.userFile,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

function userUsageCheck(usageCheck: UsageCheckConfig): unknown {
  return {componentConfig: {[USAGE_CHECK_CONFIG_KEY]: usageCheck}};
}

/** An assistant entry whose usage sums to `contextTokens`. */
function assistantEntry(contextTokens: number, agentId?: string): unknown {
  return {
    ...(agentId == null ? {isSidechain: false} : {agentId, isSidechain: true}),
    message: {
      role: 'assistant',
      usage: {
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: contextTokens - 1_002,
        input_tokens: 2,
        output_tokens: 500,
      },
    },
    timestamp: '2026-11-08T00:00:00.000Z',
    type: 'assistant',
  };
}

let transcriptCounter = 0;

/**
 * A fresh session transcript at `sessionTokens`, plus a subagent transcript at
 * `agentTokens` laid out where Claude Code puts it. Fresh per call, so no
 * earlier notice is in it and the first crossing always fires.
 */
function writeTranscripts(
  fx: Fixture,
  sessionTokens: number,
  agentTokens = 10,
): string {
  transcriptCounter += 1;
  const sessionPath = join(fx.root, `session-${transcriptCounter}.jsonl`);
  writeFileSync(
    sessionPath,
    `${JSON.stringify(assistantEntry(sessionTokens))}\n`,
  );
  const agentPath = join(
    fx.root,
    `session-${transcriptCounter}`,
    'subagents',
    `agent-${AGENT}.jsonl`,
  );
  mkdirSync(dirname(agentPath), {recursive: true});
  writeFileSync(
    agentPath,
    `${JSON.stringify(assistantEntry(agentTokens, AGENT))}\n`,
  );
  return sessionPath;
}

interface HookRun {
  exit: number;
  /** additionalContext, the text the model reads; null when the hook was silent. */
  notice: string | null;
  stderr: string[];
  stdout: string;
}

function runHook(fx: Fixture, input: Record<string, unknown>): HookRun {
  const out: string[] = [];
  const stderr: string[] = [];
  const capture = captureWriteStdout((text) => {
    out.push(text);
  });
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  let exit: number;
  try {
    exit = runUsageCheck({
      env: fx.env,
      stdin: JSON.stringify({
        cwd: fx.root,
        hook_event_name: 'PostToolBatch',
        ...input,
      }),
    });
  } finally {
    capture.mockRestore();
    console.error = originalError;
  }
  const stdout = out.join('');
  let notice: string | null = null;
  if (stdout !== '') {
    const payload = JSON.parse(stdout) as {
      hookSpecificOutput?: {additionalContext?: unknown};
    };
    const context = payload.hookSpecificOutput?.additionalContext;
    notice = typeof context === 'string' ? context : null;
  }
  return {exit, notice, stderr, stdout};
}

/** The session's notice at `tokens` of context. */
function sessionAt(fx: Fixture, tokens: number): HookRun {
  return runHook(fx, {transcript_path: writeTranscripts(fx, tokens)});
}

/** A player's notice at `tokens` of its own context (its parent sits at 10). */
function playerAt(fx: Fixture, tokens: number): HookRun {
  return runHook(fx, {
    agent_id: AGENT,
    agent_type: 'player',
    transcript_path: writeTranscripts(fx, 10, tokens),
  });
}

/** The directive line of a notice, or null when it carries none. */
function directiveOf(run: HookRun): string | null {
  expect(run.exit).toBe(0);
  return run.notice?.split('\n')[1] ?? null;
}

// ---------------------------------------------------------------------------

describe('the user file path', () => {
  test('is the same join sdk-config uses, with and without XDG_CONFIG_HOME', () => {
    for (const env of [
      {XDG_CONFIG_HOME: '/x/config'},
      {HOME: '/h', XDG_CONFIG_HOME: ''},
      {HOME: '/h'},
    ]) {
      expect(usageCheckUserConfigPath(env)).toBe(userConfigPath(env));
    }
    expect(usageCheckUserConfigPath({HOME: '/h'})).toBe(
      '/h/.config/justin-sdk/config.json',
    );
  });
});

describe('the layering matrix, end to end (AC 1)', () => {
  test('no user file: a seed repo gets the FYI only, as before', () => {
    const fx = fixture();
    writeSeedProject(fx);
    const run = sessionAt(fx, 450_000);
    expect(run.notice).toContain('notice-at=400000');
    expect(run.notice).toContain(NOTICE_FYI);
    expect(directiveOf(run)).toBeNull();
    expect(run.stderr).toEqual([]);
  });

  test('user 400000 + project null (the seed): the directive arrives at 400k, not before', () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));

    const below = sessionAt(fx, 390_000);
    expect(below.notice).toContain('notice-at=300000');
    expect(directiveOf(below)).toBeNull();

    const at = sessionAt(fx, 410_000);
    expect(at.notice).toContain('notice-at=400000');
    expect(directiveOf(at)).toBe(WRAP_UP_DIRECTIVE);
  });

  test('user 400000 + project key absent: the directive at 400k', () => {
    const fx = fixture();
    writeProject(fx, {enabled: true});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(directiveOf(sessionAt(fx, 390_000))).toBeNull();
    expect(directiveOf(sessionAt(fx, 410_000))).toBe(WRAP_UP_DIRECTIVE);
  });

  test('user 400000 + project 0: the FYI only, at any size', () => {
    const fx = fixture();
    writeProject(fx, {enabled: true, wrapUpAt: 0});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    for (const tokens of [410_000, 950_000]) {
      const run = sessionAt(fx, tokens);
      expect(run.notice).toContain(NOTICE_FYI);
      expect(directiveOf(run)).toBeNull();
    }
  });

  test('user 400000 + project 350000: the repo number wins', () => {
    const fx = fixture();
    writeProject(fx, {enabled: true, wrapUpAt: 350_000});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    const run = sessionAt(fx, 360_000);
    expect(run.notice).toContain('notice-at=350000');
    expect(directiveOf(run)).toBe(WRAP_UP_DIRECTIVE);
  });

  test("home-base's shape (project roles.player 350000, no top level) + user 400000: session 400000, player 350000", () => {
    const fx = fixture();
    writeProject(fx, {enabled: true, roles: {player: {wrapUpAt: 350_000}}});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));

    expect(directiveOf(sessionAt(fx, 360_000))).toBeNull();
    expect(directiveOf(sessionAt(fx, 410_000))).toBe(WRAP_UP_DIRECTIVE);

    const player = playerAt(fx, 360_000);
    expect(player.notice).toContain('This player subagent');
    expect(player.notice).toContain('notice-at=350000');
    expect(directiveOf(player)).toBe(WRAP_UP_DIRECTIVE);
  });

  test('seed repo + user 400000: a player inherits 400000', () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(directiveOf(playerAt(fx, 360_000))).toBeNull();
    const at = playerAt(fx, 410_000);
    expect(at.notice).toContain('This player subagent');
    expect(directiveOf(at)).toBe(WRAP_UP_DIRECTIVE);
  });

  test('no project block + user 400000: silent, even with enabled:true in the user file (D2)', () => {
    const fx = fixture();
    writeProject(fx, null);
    writeUser(fx, userUsageCheck({enabled: true, wrapUpAt: 400_000}));
    const run = sessionAt(fx, 450_000);
    expect(run.stdout).toBe('');
    expect(run.stderr).toEqual([]);
    expect(run.exit).toBe(0);
    expect(readUsageCheckLayers(fx.root, fx.env)).toEqual({status: 'off'});
  });

  test('no project file at all + user 400000: silent', () => {
    const fx = fixture();
    writeUser(fx, userUsageCheck({enabled: true, wrapUpAt: 400_000}));
    const run = sessionAt(fx, 450_000);
    expect(run.stdout).toBe('');
    expect(run.exit).toBe(0);
  });

  test("the user file's enabled:false does not switch a repo off (D2)", () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, userUsageCheck({enabled: false, wrapUpAt: 400_000}));
    expect(directiveOf(sessionAt(fx, 410_000))).toBe(WRAP_UP_DIRECTIVE);
  });

  test('a malformed user file: exit 0, no stdout, one stderr line naming the path', () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, '{"componentConfig": {"usage-check": {"wrapUpAt": 4000');

    const quiet = sessionAt(fx, 50_000);
    expect(quiet.exit).toBe(0);
    expect(quiet.stdout).toBe('');
    expect(quiet.stderr).toHaveLength(1);
    expect(quiet.stderr[0]).toContain(fx.userFile);
    expect(quiet.stderr[0]).not.toContain('\n');

    // Above the ladder the repo's own block still works, with that layer
    // ignored: the seed's null means off, and the error never reaches stdout.
    const due = sessionAt(fx, 450_000);
    expect(due.notice).toContain('notice-at=400000');
    expect(directiveOf(due)).toBeNull();
    expect(due.stdout).not.toContain(fx.userFile);
    expect(due.stderr).toHaveLength(1);
  });

  test('a user file that exists but cannot be read is a problem, not absence', () => {
    const fx = fixture();
    writeSeedProject(fx);
    mkdirSync(fx.userFile, {recursive: true}); // EISDIR, not ENOENT
    const run = sessionAt(fx, 50_000);
    expect(run.stdout).toBe('');
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toContain(fx.userFile);
  });

  test("user-file setpoints and reArmDropFraction layer under the project's", () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, userUsageCheck({setpoints: [50_000]}));
    const run = sessionAt(fx, 60_000);
    expect(run.notice).toContain('notice-at=50000');
  });
});

describe('the layering matrix, field by field (AC 1)', () => {
  const resolve = (
    project: UsageCheckConfig,
    user: UsageCheckConfig | null,
    role: 'player' | 'session' = 'session',
  ) => resolveUsageCheckConfig(layerUsageCheckConfig(project, user), role);

  const SEED: UsageCheckConfig = {
    enabled: USAGE_CHECK_DEFAULTS.enabled,
    wrapUpAt: USAGE_CHECK_DEFAULTS.wrapUpAt,
  };

  test('setpoints: the user file fills an absent key; a project value wins', () => {
    expect(resolve(SEED, {setpoints: [50_000, 150_000]})?.setpoints).toEqual([
      50_000, 150_000,
    ]);
    expect(
      resolve({...SEED, setpoints: [100_000]}, {setpoints: [50_000]})
        ?.setpoints,
    ).toEqual([100_000]);
  });

  test('reArmDropFraction: the user file fills an absent key; a project value wins', () => {
    expect(resolve(SEED, {reArmDropFraction: 0.5})?.reArmDropFraction).toBe(
      0.5,
    );
    expect(
      resolve({...SEED, reArmDropFraction: 0.1}, {reArmDropFraction: 0.5})
        ?.reArmDropFraction,
    ).toBe(0.1);
  });

  test("roles.player: the user's role block layers under the project's, then the top level", () => {
    const user: UsageCheckConfig = {
      roles: {player: {setpoints: [25_000], wrapUpAt: 300_000}},
      wrapUpAt: 400_000,
    };
    const player = resolve(SEED, user, 'player');
    expect(player?.wrapUpAt).toBe(300_000);
    expect(player?.setpoints).toEqual([25_000, 300_000]);
    expect(resolve(SEED, user)?.wrapUpAt).toBe(400_000);

    // A project role number beats the user's role number.
    expect(
      resolve({...SEED, roles: {player: {wrapUpAt: 350_000}}}, user, 'player')
        ?.wrapUpAt,
    ).toBe(350_000);
  });

  test('a 0 in either file is a statement; a null or a string is not (D3, D4)', () => {
    expect(resolve(SEED, {wrapUpAt: 0})?.wrapUpAt).toBeNull();
    expect(resolve({...SEED, wrapUpAt: 350_000}, {wrapUpAt: 0})?.wrapUpAt).toBe(
      350_000,
    );
    expect(
      resolve(
        {...SEED, wrapUpAt: '400000' as unknown as number},
        {wrapUpAt: 300_000},
      )?.wrapUpAt,
    ).toBe(300_000);
    expect(
      resolve(
        {...SEED, roles: {player: {wrapUpAt: 0}}},
        {wrapUpAt: 400_000},
        'player',
      )?.wrapUpAt,
    ).toBeNull();
  });

  test('no number anywhere means off', () => {
    expect(resolve(SEED, null)?.wrapUpAt).toBeNull();
    expect(resolve(SEED, {wrapUpAt: null})?.wrapUpAt).toBeNull();
  });
});

describe('the directive text (AC 2, D7)', () => {
  test('session + successor on: names the handoff call and the rule, with no bun prefix', () => {
    const fx = fixture();
    writeSeedProject(fx, {handoff: {successor: true}});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    const directive = directiveOf(sessionAt(fx, 410_000));

    expect(directive).toBe(HANDOFF_WRAP_UP_DIRECTIVE);
    expect(directive).toContain(HANDOFF_CALL);
    expect(directive).toContain('.claude/rules/justin-sdk/handoff.md');
    expect(HANDOFF_RULE_PATH).toBe('.claude/rules/justin-sdk/handoff.md');
    expect(directive).not.toContain('bun run');
    expect(directive).not.toMatch(/\bbun\s+(?:run\s+)?\.\/node_modules/);
    // The rule's own wording for the note, so the session can copy it.
    expect(directive).toContain(
      `${HANDOFF_CALL} --note "<one line the next session must know>"`,
    );
  });

  test('session + successor on in the USER file only: the handoff wording too', () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, {
      componentConfig: {
        [USAGE_CHECK_CONFIG_KEY]: {wrapUpAt: 400_000},
        thread: {handoff: {successor: true}},
      },
    });
    expect(directiveOf(sessionAt(fx, 410_000))).toBe(HANDOFF_WRAP_UP_DIRECTIVE);
  });

  test('session + successor off: the old text, word for word', () => {
    const fx = fixture();
    writeSeedProject(fx, {handoff: {successor: false}});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    const directive = directiveOf(sessionAt(fx, 410_000));
    expect(directive).toBe(OLD_DIRECTIVE_TEXT);
    expect(directive).not.toContain('thread handoff');
  });

  test('a player never hears `thread handoff`, even with the successor on', () => {
    const fx = fixture();
    writeSeedProject(fx, {handoff: {successor: true}});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    const run = playerAt(fx, 410_000);
    expect(run.notice).toContain('This player subagent');
    expect(directiveOf(run)).toBe(OLD_DIRECTIVE_TEXT);
    expect(run.notice).not.toContain('thread handoff');
  });

  test('wrapUpDirectiveFor: only a session with the successor on gets the handoff text', () => {
    expect(wrapUpDirectiveFor({handoffSuccessor: true, scope: 'session'})).toBe(
      HANDOFF_WRAP_UP_DIRECTIVE,
    );
    expect(
      wrapUpDirectiveFor({handoffSuccessor: false, scope: 'session'}),
    ).toBe(OLD_DIRECTIVE_TEXT);
    for (const handoffSuccessor of [true, false]) {
      expect(
        wrapUpDirectiveFor({handoffSuccessor, scope: 'subagent'}),
      ).not.toContain('thread handoff');
    }
  });
});

/** A notice as Claude Code records the model-facing copy (content as an ARRAY). */
function noticeRecord(notice: string): unknown {
  return {
    attachment: {
      content: [notice],
      hookEvent: 'PostToolBatch',
      hookName: 'PostToolBatch',
      type: 'hook_additional_context',
    },
    isSidechain: false,
    type: 'attachment',
  };
}

function appendRecord(path: string, record: unknown): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** The run's notice; a silent run fails the test here rather than later. */
function noticeText(run: HookRun): string {
  if (run.notice == null) {
    throw new Error(
      `expected a notice; stdout was ${JSON.stringify(run.stdout)}`,
    );
  }
  return run.notice;
}

describe('a session past the user threshold before it was set is told once (home-base-o5atv.2.1)', () => {
  test('seed repo, successor on: an FYI at 700,000, then the user file says 400000: the handoff directive once', () => {
    const fx = fixture();
    writeSeedProject(fx, {handoff: {successor: true}});
    const transcriptPath = join(fx.root, 'past-threshold.jsonl');
    appendRecord(transcriptPath, assistantEntry(700_500));

    // Before the user file exists, 700,000 is an FYI: that is what every open
    // session past 400k holds today (E7).
    const fyi = runHook(fx, {transcript_path: transcriptPath});
    expect(fyi.notice).toContain('(notice-at=700000)');
    expect(fyi.notice).toContain(NOTICE_FYI);
    expect(directiveOf(fyi)).toBeNull();
    appendRecord(transcriptPath, noticeRecord(noticeText(fyi)));

    // The user file arrives; the session's next check tells it.
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    appendRecord(transcriptPath, assistantEntry(720_000));
    const told = runHook(fx, {transcript_path: transcriptPath});
    expect(told.notice?.split('\n')[0]).toEndWith('(notice-at=700000)');
    expect(directiveOf(told)).toBe(HANDOFF_WRAP_UP_DIRECTIVE);
    appendRecord(transcriptPath, noticeRecord(noticeText(told)));

    // Once: the next check is silent.
    appendRecord(transcriptPath, assistantEntry(730_000));
    const after = runHook(fx, {transcript_path: transcriptPath});
    expect(after.exit).toBe(0);
    expect(after.stdout).toBe('');
    expect(after.stderr).toEqual([]);
  });
});

describe('the successor walk agrees with hookKnobOn (AC 2, D7)', () => {
  const CASES: {
    expected: boolean;
    name: string;
    project: boolean | null;
    user: boolean | null;
  }[] = [
    {expected: true, name: 'on in the project file', project: true, user: null},
    {expected: false, name: 'off: set nowhere', project: null, user: null},
    {
      expected: false,
      name: 'off: false in the project file',
      project: false,
      user: null,
    },
    {expected: true, name: 'user file only', project: null, user: true},
    {
      expected: false,
      name: 'project false overrides user true',
      project: false,
      user: true,
    },
    {
      expected: true,
      name: 'project true overrides user false',
      project: true,
      user: false,
    },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      const fx = fixture();
      writeSeedProject(
        fx,
        c.project == null ? null : {handoff: {successor: c.project}},
      );
      if (c.user != null) {
        writeUser(fx, {
          componentConfig: {thread: {handoff: {successor: c.user}}},
        });
      }

      const layers = readUsageCheckLayers(fx.root, fx.env);
      if (layers.status !== 'on') throw new Error('expected the seed to be on');
      const official = hookKnobOn('thread.handoff.successor', fx.root, fx.env);

      expect(layers.handoffSuccessor).toBe(c.expected);
      expect(official).toBe(c.expected);
      expect(layers.handoffSuccessor).toBe(official);
    });
  }

  test('only a boolean counts at a layer', () => {
    const project = {componentConfig: {thread: {handoff: {successor: 'yes'}}}};
    const user = {componentConfig: {thread: {handoff: {successor: true}}}};
    expect(resolveHandoffSuccessor(project, user)).toBe(true);
    expect(resolveHandoffSuccessor(project, null)).toBe(false);
    expect(resolveHandoffSuccessor(null, null)).toBe(false);
  });
});

describe('resolveReportWrapUpAt reads the same layers (AC 3, D8)', () => {
  test('a seed repo with user 400000 reports 400000', () => {
    const fx = fixture();
    writeSeedProject(fx);
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(resolveReportWrapUpAt(fx.root, fx.env)).toBe(400_000);
  });

  test('a repo with 0 reports null, whatever the user file says', () => {
    const fx = fixture();
    writeProject(fx, {enabled: true, wrapUpAt: 0});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(resolveReportWrapUpAt(fx.root, fx.env)).toBeNull();
  });

  test('no user file and a seed repo: null', () => {
    const fx = fixture();
    writeSeedProject(fx);
    expect(resolveReportWrapUpAt(fx.root, fx.env)).toBeNull();
  });

  test('a repo without the component: null, even with a user number (D2)', () => {
    const fx = fixture();
    writeProject(fx, null);
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(resolveReportWrapUpAt(fx.root, fx.env)).toBeNull();
  });

  test('the report and the hook use the same threshold', () => {
    const fx = fixture();
    writeProject(fx, {enabled: true, roles: {player: {wrapUpAt: 350_000}}});
    writeUser(fx, userUsageCheck({wrapUpAt: 400_000}));
    expect(resolveReportWrapUpAt(fx.root, fx.env)).toBe(400_000);
    expect(directiveOf(sessionAt(fx, 399_000))).toBeNull();
    expect(directiveOf(sessionAt(fx, 400_000))).toBe(WRAP_UP_DIRECTIVE);
  });
});

describe('the installer seed is unchanged (D3)', () => {
  test('stepUsageCheckConfig still writes {"enabled": true, "wrapUpAt": null}', () => {
    const fx = fixture();
    writeSeedProject(fx);
    const written = JSON.parse(
      readFileSync(join(fx.root, 'justin-sdk.config.json'), 'utf8'),
    ) as {componentConfig: Record<string, unknown>};
    expect(written.componentConfig[USAGE_CHECK_CONFIG_KEY]).toEqual({
      enabled: true,
      wrapUpAt: null,
    });
  });
});
