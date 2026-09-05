/**
 * Tests for usage-check — the hook that tells a session how many tokens of its
 * OWN CONTEXT it has used (not subscription quota).
 *
 * Three bug classes get the weight here, because each fails silently in
 * production:
 *
 *  1. THE ONCE-PER-SETPOINT CONTRACT. The component's entire state lives in the
 *     `setpoint=<n>` token inside its own past output, so the round trip
 *     (emit → transcript → read back → stay silent) is tested end to end
 *     against real files rather than by asserting on decide() alone. A broken
 *     round trip would re-announce on every tool batch forever.
 *  2. THE RE-ARM RULE. Auto-compaction can drop a 300k session to 60k, after
 *     which the ladder must fire again — but a rule loose enough to re-arm must
 *     not chatter when the context merely wobbles.
 *  3. FAILURE IS NOT EMPTY. An unreadable transcript, a usage block with no
 *     `input_tokens`, and a marker that simply sits beyond the read window are
 *     three different facts, and none of them is "the session has used 0
 *     tokens" or "no notice has ever been sent".
 *  4. WHOSE NUMBER IS IT. A hook firing inside a subagent must measure the
 *     SUBAGENT, and when it cannot find that subagent's transcript it must say
 *     UNKNOWN rather than quietly reporting the parent's number as the
 *     subagent's — a failure that would look exactly like a success.
 *
 * @see home-base-1r6d.1, home-base-1r6d.23
 */

import {describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {setQuiet} from '../src/setup-helpers';
import {
  addUsageCheckHook,
  stepUsageCheckConfig,
  stepUsageCheckHooks,
  USAGE_CHECK_HOOK_EVENTS,
} from '../src/usage-check-setup';
import {
  buildSetpointLadder,
  contextTokensFromUsage,
  decide,
  formatNotice,
  formatTokens,
  readTranscriptFacts,
  readUsageCheckConfig,
  resolveMeasurementTarget,
  resolveUsageCheckConfig,
  runUsageCheck,
  subagentTranscriptPath,
  USAGE_CHECK_CONFIG_KEY,
  USAGE_CHECK_DEFAULTS,
  USAGE_CHECK_MARKER,
  WRAP_UP_DIRECTIVE,
  type ResolvedUsageCheckConfig,
  type UsageCheckConfig,
  type UsageCheckRole,
} from '../src/usage-check';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'usage-check-'));
}

function writeConfig(dir: string, usageCheck: UsageCheckConfig | null): void {
  const config: Record<string, unknown> = {
    components: ['base-setup'],
    version: '0.18.3',
  };
  if (usageCheck != null) {
    config.componentConfig = {[USAGE_CHECK_CONFIG_KEY]: usageCheck};
  }
  writeFileSync(
    join(dir, 'justin-sdk.config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
}

/** An assistant entry whose usage sums to `contextTokens`. */
function assistantEntry(contextTokens: number): unknown {
  return {
    isSidechain: false,
    message: {
      role: 'assistant',
      usage: {
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: contextTokens - 1_002,
        input_tokens: 2,
        output_tokens: 500,
      },
    },
    timestamp: '2026-08-20T00:00:00.000Z',
    type: 'assistant',
  };
}

/**
 * A notice as Claude Code actually records it: the model-facing copy is
 * `hook_additional_context` with content as a STRING ARRAY (verified against a
 * real transcript, CC 2.1.238).
 */
function noticeEntry(notice: string, hookEvent = 'PostToolBatch'): unknown {
  return {
    attachment: {
      content: [notice],
      hookEvent,
      hookName: hookEvent,
      type: 'hook_additional_context',
    },
    isSidechain: false,
    timestamp: '2026-08-20T00:00:01.000Z',
    type: 'attachment',
  };
}

function writeTranscript(dir: string, entries: unknown[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return path;
}

/** Run the hook, capturing whatever it prints. Returns null when silent. */
function runCapturing(input: unknown): Record<string, unknown> | null {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  let exit: number;
  try {
    exit = runUsageCheck({stdin: JSON.stringify(input)});
  } finally {
    console.log = original;
  }
  // A hook that can block the user's prompt must never exit non-zero.
  expect(exit).toBe(0);
  if (lines.length === 0) {
    return null;
  }
  return JSON.parse(lines.join('')) as Record<string, unknown>;
}

function noticeOf(payload: Record<string, unknown> | null): string | null {
  if (payload == null) {
    return null;
  }
  const specific = payload.hookSpecificOutput as {additionalContext?: unknown};
  return typeof specific.additionalContext === 'string'
    ? specific.additionalContext
    : null;
}

/** Append the emitted notice to the transcript, as Claude Code would. */
function recordNotice(path: string, notice: string): void {
  appendFileSync(path, `${JSON.stringify(noticeEntry(notice))}\n`);
}

const TEST_CONFIG: UsageCheckConfig = {
  enabled: true,
  setpoints: [100_000, 200_000, 300_000],
  wrapUpAt: 300_000,
};

function resolved(config: UsageCheckConfig): ResolvedUsageCheckConfig {
  const value = resolveUsageCheckConfig(config);
  if (value == null) {
    throw new Error('expected a resolved config');
  }
  return value;
}

/** `resolved`, for a named role (home-base-1r6d.23). */
function resolvedFor(
  config: UsageCheckConfig,
  role: UsageCheckRole,
): ResolvedUsageCheckConfig {
  const value = resolveUsageCheckConfig(config, role);
  if (value == null) {
    throw new Error(`expected a resolved config for role ${role}`);
  }
  return value;
}

// ---------------------------------------------------------------------------

describe('config: absence means disabled', () => {
  test('no justin-sdk.config.json at all', () => {
    expect(readUsageCheckConfig(tempDir())).toBeNull();
  });

  test('config with no componentConfig section', () => {
    const dir = tempDir();
    writeConfig(dir, null);
    expect(readUsageCheckConfig(dir)).toBeNull();
  });

  test('componentConfig without a usage-check key', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'justin-sdk.config.json'),
      JSON.stringify({componentConfig: {'time-check': {enabled: true}}}),
    );
    expect(readUsageCheckConfig(dir)).toBeNull();
  });

  test('malformed JSON does not throw', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'justin-sdk.config.json'), '{not json');
    expect(readUsageCheckConfig(dir)).toBeNull();
  });

  test('resolve: null config and enabled:false both mean off', () => {
    expect(resolveUsageCheckConfig(null)).toBeNull();
    expect(resolveUsageCheckConfig({enabled: false})).toBeNull();
  });
});

describe('config: ladder normalization', () => {
  test('defaults apply when fields are absent', () => {
    const config = resolved({enabled: true});
    expect(config.setpoints).toEqual(USAGE_CHECK_DEFAULTS.setpoints);
    expect(config.wrapUpAt).toBe(USAGE_CHECK_DEFAULTS.wrapUpAt);
    expect(config.reArmDropFraction).toBe(
      USAGE_CHECK_DEFAULTS.reArmDropFraction,
    );
  });

  test('setpoints are sorted, deduped, and cleaned of junk', () => {
    const config = resolved({
      setpoints: [300_000, 100_000, 100_000, -5, Number.NaN] as number[],
      wrapUpAt: null,
    });
    expect(config.setpoints).toEqual([100_000, 300_000]);
    expect(config.wrapUpAt).toBeNull();
  });

  test('wrapUpAt is folded INTO the ladder so its directive cannot be skipped', () => {
    // Without this, a wrapUpAt between two setpoints would be crossed with no
    // notice due, and the one message that matters would never be said.
    const config = resolved({setpoints: [100_000, 300_000], wrapUpAt: 175_000});
    expect(config.setpoints).toEqual([100_000, 175_000, 300_000]);

    const decision = decide({
      config,
      contextTokens: 180_000,
      lastAnnouncedSetpoint: 100_000,
    });
    expect(decision?.setpoint).toBe(175_000);
    expect(decision?.wrapUp).toBe(true);
  });

  test('an empty ladder resolves to off rather than to a config that never fires', () => {
    expect(resolveUsageCheckConfig({setpoints: [], wrapUpAt: null})).toBeNull();
    expect(
      resolveUsageCheckConfig({setpoints: null, wrapUpAt: null}),
    ).toBeNull();
  });

  test('an out-of-range reArmDropFraction falls back to the default', () => {
    expect(resolved({reArmDropFraction: 0}).reArmDropFraction).toBe(0.25);
    expect(resolved({reArmDropFraction: 1}).reArmDropFraction).toBe(0.25);
    expect(resolved({reArmDropFraction: 0.4}).reArmDropFraction).toBe(0.4);
  });
});

describe('defaults: an every-100k ladder, wrap-up directive OFF (D7, D8)', () => {
  test('the generated ladder starts at 100,000 and steps by 100,000', () => {
    // The literals here are deliberate. Asserting against
    // SETPOINT_INTERVAL_TOKENS would make this test agree with whatever the
    // constant happens to say, which is the one thing it exists to pin down.
    // Justin's words (2026-08-24): "automatically run every hundred thousand
    // tokens".
    const ladder = USAGE_CHECK_DEFAULTS.setpoints;
    expect(ladder[0]).toBe(100_000);
    expect(ladder[1]).toBe(200_000);
    expect(ladder.at(-1)).toBe(2_000_000);
    expect(ladder).toHaveLength(20);
    for (let index = 0; index < ladder.length; index += 1) {
      expect(ladder[index]).toBe(100_000 * (index + 1));
    }
  });

  test('the ladder is ascending, deduped, and carries no null or junk rung', () => {
    const ladder = USAGE_CHECK_DEFAULTS.setpoints;
    expect([...new Set(ladder)]).toHaveLength(ladder.length);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
    expect(ladder.some((rung) => rung == null)).toBe(false);
    expect(ladder.every((rung) => Number.isFinite(rung) && rung > 0)).toBe(
      true,
    );
  });

  test('buildSetpointLadder throws rather than handing back an empty ladder', () => {
    // An empty ladder resolves to "disabled", so a bad interval would switch
    // the component off in every project at once and look like nothing had
    // gone wrong anywhere.
    expect(() => buildSetpointLadder(0, 1_000)).toThrow(RangeError);
    expect(() => buildSetpointLadder(-100, 1_000)).toThrow(RangeError);
    expect(() => buildSetpointLadder(Number.NaN, 1_000)).toThrow(RangeError);
    expect(() => buildSetpointLadder(100, 99)).toThrow(RangeError);

    expect(buildSetpointLadder(100, 100)).toEqual([100]);
    // A ceiling that is not a multiple of the interval stops below it rather
    // than overshooting.
    expect(buildSetpointLadder(100, 250)).toEqual([100, 200]);
  });

  test('the default wrapUpAt is null, and resolving folds no null into the ladder', () => {
    expect(USAGE_CHECK_DEFAULTS.wrapUpAt).toBeNull();

    const config = resolved({enabled: true});
    expect(config.wrapUpAt).toBeNull();
    // Sharpest assertion first: resolve() folds wrapUpAt INTO the ladder, so a
    // null threshold is the one value that could slip in as a rung — where it
    // would sort ahead of every real setpoint and be announced as one.
    expect(config.setpoints.some((rung) => rung == null)).toBe(false);
    expect(config.setpoints).toEqual(USAGE_CHECK_DEFAULTS.setpoints);
  });

  test('with the default config no context size, however large, nags', () => {
    const config = resolved({enabled: true});
    for (const contextTokens of [
      100_000, 300_000, 500_000, 999_999, 1_500_000, 2_000_000, 5_000_000,
    ]) {
      const decision = decide({
        config,
        contextTokens,
        lastAnnouncedSetpoint: null,
      });
      // The informational half still fires — this is not "off", it is "off
      // for the directive only".
      expect(decision).not.toBeNull();
      expect(decision?.wrapUp).toBe(false);
      if (decision != null) {
        expect(formatNotice(decision)).not.toContain(WRAP_UP_DIRECTIVE);
      }
    }
  });
});

describe('context size: the measurement', () => {
  test('sums input + cache_creation + cache_read', () => {
    // The formula, verified live 2026-08-20 against a running session.
    expect(
      contextTokensFromUsage({
        cache_creation_input_tokens: 912,
        cache_read_input_tokens: 545_291,
        input_tokens: 2,
        output_tokens: 948,
      }),
    ).toBe(546_205);
  });

  test('absent cache fields mean zero cached tokens, not an unusable entry', () => {
    expect(contextTokensFromUsage({input_tokens: 1_234})).toBe(1_234);
  });

  test('a missing or non-numeric input_tokens yields null, never 0', () => {
    // FAILURE IS NOT EMPTY: "we could not read this" must not become "this
    // session has used no tokens", which would silence every setpoint.
    expect(contextTokensFromUsage({output_tokens: 5})).toBeNull();
    expect(contextTokensFromUsage({input_tokens: '2'})).toBeNull();
    expect(contextTokensFromUsage(null)).toBeNull();
    expect(contextTokensFromUsage('nope')).toBeNull();
  });

  test('a non-numeric cache field refuses to measure rather than undercount', () => {
    expect(
      contextTokensFromUsage({cache_read_input_tokens: {}, input_tokens: 2}),
    ).toBeNull();
  });
});

describe('transcript scan', () => {
  test('missing file reports unknown, not empty', () => {
    const facts = readTranscriptFacts({
      lowestSetpoint: 100_000,
      transcriptPath: join(tempDir(), 'nope.jsonl'),
    });
    expect(facts.contextTokens).toBeNull();
    expect(facts.lastAnnouncedSetpoint).toBeNull();
    // reachedStart false is what stops a caller reading the null above as
    // "there has never been a notice".
    expect(facts.reachedStart).toBe(false);
  });

  test('reads the LAST assistant entry, ignoring trailing metadata', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      assistantEntry(120_000),
      assistantEntry(160_000),
      {type: 'last-prompt'},
      {type: 'ai-title'},
    ]);
    expect(
      readTranscriptFacts({lowestSetpoint: 100_000, transcriptPath: path})
        .contextTokens,
    ).toBe(160_000);
  });

  test('a subagent (sidechain) entry is not mistaken for this session', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      assistantEntry(160_000),
      {...(assistantEntry(9_000) as object), isSidechain: true},
    ]);
    expect(
      readTranscriptFacts({lowestSetpoint: 100_000, transcriptPath: path})
        .contextTokens,
    ).toBe(160_000);
  });

  test('malformed and truncated lines are skipped, not fatal', () => {
    const dir = tempDir();
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(assistantEntry(150_000)),
        '{"type":"assistant","message":{"usage":{"input_tokens"', // truncated
        'not json at all',
        '',
      ].join('\n'),
    );
    const facts = readTranscriptFacts({
      lowestSetpoint: 100_000,
      transcriptPath: path,
    });
    expect(facts.contextTokens).toBe(150_000);
  });

  test('finds our own notice with content as an ARRAY (the delivered shape)', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      noticeEntry(`${USAGE_CHECK_MARKER} ... (setpoint=200000).`),
      assistantEntry(210_000),
    ]);
    expect(
      readTranscriptFacts({lowestSetpoint: 100_000, transcriptPath: path})
        .lastAnnouncedSetpoint,
    ).toBe(200_000);
  });

  test('finds our own notice with content as a STRING (the systemMessage shape)', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      {
        attachment: {
          content: `${USAGE_CHECK_MARKER} ... (setpoint=200000).`,
          hookEvent: 'UserPromptSubmit',
          type: 'hook_system_message',
        },
        type: 'attachment',
      },
      assistantEntry(210_000),
    ]);
    expect(
      readTranscriptFacts({lowestSetpoint: 100_000, transcriptPath: path})
        .lastAnnouncedSetpoint,
    ).toBe(200_000);
  });

  test('takes the MOST RECENT notice when several are present', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      noticeEntry(`${USAGE_CHECK_MARKER} a (setpoint=100000).`),
      noticeEntry(`${USAGE_CHECK_MARKER} b (setpoint=200000).`),
      assistantEntry(210_000),
    ]);
    expect(
      readTranscriptFacts({lowestSetpoint: 100_000, transcriptPath: path})
        .lastAnnouncedSetpoint,
    ).toBe(200_000);
  });

  test('escalates the read window until the notice is found', () => {
    // The window starts small for speed (a real transcript measured 44MB), so
    // "not in the first window" must never be reported as "no notice exists".
    const dir = tempDir();
    const filler = Array.from({length: 40}, () => assistantEntry(150_000));
    const path = writeTranscript(dir, [
      noticeEntry(`${USAGE_CHECK_MARKER} old (setpoint=100000).`),
      ...filler,
    ]);
    const facts = readTranscriptFacts({
      initialWindowBytes: 256,
      lowestSetpoint: 100_000,
      transcriptPath: path,
    });
    expect(facts.contextTokens).toBe(150_000);
    expect(facts.lastAnnouncedSetpoint).toBe(100_000);
    expect(facts.reachedStart).toBe(true);
  });

  test('a partial first line in a mid-file window is discarded, not parsed', () => {
    const dir = tempDir();
    const path = writeTranscript(dir, [
      assistantEntry(120_000),
      assistantEntry(150_000),
    ]);
    // 80 bytes lands mid-line; the truncated head must not crash or mis-parse.
    const facts = readTranscriptFacts({
      initialWindowBytes: 80,
      lowestSetpoint: 100_000,
      transcriptPath: path,
    });
    expect(facts.contextTokens).toBe(150_000);
  });
});

describe('decide: the setpoint ladder', () => {
  const config = resolved(TEST_CONFIG);

  test('silent below the lowest setpoint', () => {
    expect(
      decide({config, contextTokens: 99_999, lastAnnouncedSetpoint: null}),
    ).toBeNull();
  });

  test('first crossing announces the highest setpoint at or below the context', () => {
    const decision = decide({
      config,
      contextTokens: 210_000,
      lastAnnouncedSetpoint: null,
    });
    expect(decision).toEqual({
      contextTokens: 210_000,
      reason: 'first',
      setpoint: 200_000,
      wrapUp: false,
    });
  });

  test('silent once a setpoint has been announced and the ladder has not moved', () => {
    expect(
      decide({config, contextTokens: 150_000, lastAnnouncedSetpoint: 100_000}),
    ).toBeNull();
    expect(
      decide({config, contextTokens: 199_999, lastAnnouncedSetpoint: 100_000}),
    ).toBeNull();
  });

  test('ascending to the next setpoint announces again', () => {
    expect(
      decide({config, contextTokens: 200_000, lastAnnouncedSetpoint: 100_000})
        ?.reason,
    ).toBe('ascend');
  });

  test('a jump past two setpoints announces the higher one, once', () => {
    const decision = decide({
      config,
      contextTokens: 305_000,
      lastAnnouncedSetpoint: 100_000,
    });
    expect(decision?.setpoint).toBe(300_000);
  });

  test('a small shrink is noise and changes nothing', () => {
    // 240k is only 20% below the announced 300k — inside the 25% band.
    expect(
      decide({config, contextTokens: 240_000, lastAnnouncedSetpoint: 300_000}),
    ).toBeNull();
  });

  test('a large shrink RE-ARMS the ladder (auto-compaction)', () => {
    const decision = decide({
      config,
      contextTokens: 210_000,
      lastAnnouncedSetpoint: 300_000,
    });
    expect(decision?.reason).toBe('re-arm');
    expect(decision?.setpoint).toBe(200_000);
  });

  test('re-arming below the lowest setpoint stays silent', () => {
    expect(
      decide({config, contextTokens: 40_000, lastAnnouncedSetpoint: 300_000}),
    ).toBeNull();
  });

  test('re-arming cannot chatter: the notice it emits settles the ladder', () => {
    // The re-armed notice names a setpoint <= the context, so the very next
    // evaluation finds neither an ascent nor a large enough shrink.
    const first = decide({
      config,
      contextTokens: 210_000,
      lastAnnouncedSetpoint: 300_000,
    });
    expect(first?.setpoint).toBe(200_000);
    expect(
      decide({
        config,
        contextTokens: 210_000,
        lastAnnouncedSetpoint: first?.setpoint ?? null,
      }),
    ).toBeNull();
  });

  test('the wrap-up directive rides on the measured context, not the setpoint', () => {
    expect(
      decide({config, contextTokens: 299_999, lastAnnouncedSetpoint: 100_000})
        ?.wrapUp,
    ).toBe(false);
    expect(
      decide({config, contextTokens: 300_000, lastAnnouncedSetpoint: 100_000})
        ?.wrapUp,
    ).toBe(true);
  });

  test('wrapUpAt null never nags', () => {
    const noNag = resolved({setpoints: [100_000, 300_000], wrapUpAt: null});
    expect(
      decide({
        config: noNag,
        contextTokens: 400_000,
        lastAnnouncedSetpoint: null,
      })?.wrapUp,
    ).toBe(false);
  });
});

describe('formatting', () => {
  test('thousands separators', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1,000');
    expect(formatTokens(312_004)).toBe('312,004');
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });

  test('the notice carries the marker and the machine-readable setpoint', () => {
    const notice = formatNotice({
      contextTokens: 152_431,
      reason: 'first',
      setpoint: 150_000,
      wrapUp: false,
    });
    expect(notice).toBe(
      `${USAGE_CHECK_MARKER} This session has now used 152,431 tokens of context (setpoint=150000).`,
    );
    expect(notice).not.toContain(WRAP_UP_DIRECTIVE);
  });

  test('the wrap-up notice adds the directive verbatim', () => {
    const notice = formatNotice({
      contextTokens: 312_004,
      reason: 'ascend',
      setpoint: 300_000,
      wrapUp: true,
    });
    expect(notice.split('\n')[1]).toBe(WRAP_UP_DIRECTIVE);
    expect(notice).toContain('Follow the handoff/ralph-handoff protocol.');
  });
});

describe('runUsageCheck: end to end over real files', () => {
  function setup(usageCheck: UsageCheckConfig | null, contextTokens: number) {
    const dir = tempDir();
    writeConfig(dir, usageCheck);
    const transcriptPath = writeTranscript(dir, [
      assistantEntry(contextTokens),
    ]);
    return {dir, transcriptPath};
  }

  test('silent when the component is not installed here', () => {
    const {dir, transcriptPath} = setup(null, 400_000);
    expect(
      runCapturing({
        cwd: dir,
        hook_event_name: 'PostToolBatch',
        transcript_path: transcriptPath,
      }),
    ).toBeNull();
  });

  test('silent when explicitly disabled', () => {
    const {dir, transcriptPath} = setup({enabled: false}, 400_000);
    expect(
      runCapturing({cwd: dir, transcript_path: transcriptPath}),
    ).toBeNull();
  });

  test('silent with no transcript_path, and on empty stdin', () => {
    const {dir} = setup(TEST_CONFIG, 400_000);
    expect(runCapturing({cwd: dir})).toBeNull();
    expect(runUsageCheck({stdin: ''})).toBe(0);
    expect(runUsageCheck({stdin: 'not json'})).toBe(0);
  });

  test('silent when the transcript cannot be read at all', () => {
    const {dir} = setup(TEST_CONFIG, 400_000);
    expect(
      runCapturing({
        cwd: dir,
        transcript_path: join(dir, 'does-not-exist.jsonl'),
      }),
    ).toBeNull();
  });

  test('emits BOTH channels, echoing the firing event', () => {
    const {dir, transcriptPath} = setup(TEST_CONFIG, 210_000);
    const payload = runCapturing({
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: transcriptPath,
    });
    const specific = payload?.hookSpecificOutput as Record<string, unknown>;
    // additionalContext reaches the model; systemMessage reaches Justin.
    expect(specific.additionalContext).toBe(payload?.systemMessage);
    // A mismatched hookEventName would make the payload inert on this event.
    expect(specific.hookEventName).toBe('PostToolBatch');
    expect(noticeOf(payload)).toContain('setpoint=200000');
  });

  test('a crossing fires ONCE and stays silent on later prompts', () => {
    const {dir, transcriptPath} = setup(TEST_CONFIG, 210_000);
    const input = {
      cwd: dir,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: transcriptPath,
    };

    const first = noticeOf(runCapturing(input));
    expect(first).toContain('210,000 tokens of context');
    expect(first).toContain('setpoint=200000');

    // Claude Code writes the notice into the transcript; that IS the state.
    recordNotice(transcriptPath, first as string);

    expect(runCapturing(input)).toBeNull();
    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(240_000))}\n`,
    );
    expect(runCapturing(input)).toBeNull();
  });

  test('the ladder walks up, once per setpoint, and nags past wrapUpAt', () => {
    const {dir, transcriptPath} = setup(TEST_CONFIG, 110_000);
    const input = {
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: transcriptPath,
    };

    const at110 = noticeOf(runCapturing(input));
    expect(at110).toContain('setpoint=100000');
    expect(at110).not.toContain(WRAP_UP_DIRECTIVE);
    recordNotice(transcriptPath, at110 as string);

    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(205_000))}\n`,
    );
    const at205 = noticeOf(runCapturing(input));
    expect(at205).toContain('setpoint=200000');
    expect(at205).not.toContain(WRAP_UP_DIRECTIVE);
    recordNotice(transcriptPath, at205 as string);

    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(312_004))}\n`,
    );
    const at312 = noticeOf(runCapturing(input));
    expect(at312).toContain('setpoint=300000');
    expect(at312).toContain(WRAP_UP_DIRECTIVE);
    recordNotice(transcriptPath, at312 as string);

    // Still above wrapUpAt, but the ladder is at its top: no repeat nagging.
    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(390_000))}\n`,
    );
    expect(runCapturing(input)).toBeNull();
  });

  test('a whole session on the DEFAULT config: a notice every 100k, never a directive', () => {
    // The end-to-end proof of D7 + D8 together. A project that installs the
    // component and tunes nothing gets the informational notice on every 100k
    // rung — including well past 500,000, where the old hand-picked ladder ran
    // out — and never once gets told to wrap up, including past the 300,000
    // that used to trigger the directive unconditionally.
    const dir = tempDir();
    writeConfig(dir, {enabled: true}); // Exactly what the installer now seeds.
    const transcriptPath = writeTranscript(dir, [assistantEntry(105_000)]);
    const input = {
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: transcriptPath,
    };

    const announced: number[] = [];
    for (
      let contextTokens = 105_000;
      contextTokens <= 905_000;
      contextTokens += 50_000
    ) {
      if (contextTokens > 105_000) {
        appendFileSync(
          transcriptPath,
          `${JSON.stringify(assistantEntry(contextTokens))}\n`,
        );
      }
      const notice = noticeOf(runCapturing(input));
      if (notice == null) {
        continue;
      }
      expect(notice).not.toContain(WRAP_UP_DIRECTIVE);
      const match = /setpoint=(\d+)/.exec(notice);
      expect(match?.[1]).toBeDefined();
      announced.push(Number(match?.[1]));
      recordNotice(transcriptPath, notice);
    }

    // Every rung, once each, in order — the half-step contexts stay silent.
    expect(announced).toEqual([
      100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000,
      900_000,
    ]);
  });

  test('opting in with wrapUpAt alone: default ladder, directive at the threshold', () => {
    // The opt-in shape a project actually hand-writes (D8): one key added to
    // the seeded block, nothing else touched. The ladder stays the SDK default
    // and the directive arrives exactly at the threshold.
    const dir = tempDir();
    writeConfig(dir, {enabled: true, wrapUpAt: 300_000});
    const transcriptPath = writeTranscript(dir, [assistantEntry(205_000)]);
    const input = {
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: transcriptPath,
    };

    const at205 = noticeOf(runCapturing(input));
    expect(at205).toContain('setpoint=200000');
    expect(at205).not.toContain(WRAP_UP_DIRECTIVE);
    recordNotice(transcriptPath, at205 as string);

    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(305_000))}\n`,
    );
    const at305 = noticeOf(runCapturing(input));
    expect(at305).toContain('setpoint=300000');
    expect(at305).toContain(WRAP_UP_DIRECTIVE);
  });

  test('auto-compaction re-arms the ladder end to end', () => {
    const {dir, transcriptPath} = setup(TEST_CONFIG, 305_000);
    const input = {
      cwd: dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: transcriptPath,
    };

    const before = noticeOf(runCapturing(input));
    expect(before).toContain('setpoint=300000');
    recordNotice(transcriptPath, before as string);

    // Compaction: the context collapses. Below the lowest setpoint, so silent.
    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(60_000))}\n`,
    );
    expect(runCapturing(input)).toBeNull();

    // …and the ladder is armed again as it climbs back.
    appendFileSync(
      transcriptPath,
      `${JSON.stringify(assistantEntry(115_000))}\n`,
    );
    const after = noticeOf(runCapturing(input));
    expect(after).toContain('setpoint=100000');
    expect(after).toContain('115,000 tokens of context');
  });
});

// ---------------------------------------------------------------------------
// home-base-1r6d.23 — whose context is being measured
// ---------------------------------------------------------------------------

/**
 * A subagent transcript's records ALL carry isSidechain:true — measured
 * 2026-09-04 against a live player's file, 170 of 170 records, every one of
 * them also carrying that agent's `agentId`. The scan therefore has to STOP
 * skipping sidechain entries when the sidechain is the subject; a fixture that
 * used isSidechain:false would test a file shape that never occurs.
 */
function sidechainEntry(entry: unknown, agentId: string): unknown {
  return {...(entry as object), agentId, isSidechain: true};
}

/**
 * A project whose parent transcript and one subagent transcript hold different
 * context sizes, laid out exactly as Claude Code lays them out:
 *   <dir>/session.jsonl
 *   <dir>/session/subagents/agent-<agentId>.jsonl
 */
function subagentFixture(args: {
  usageCheck: UsageCheckConfig;
  sessionTokens: number;
  agentTokens: number;
  agentId: string;
}) {
  const dir = tempDir();
  writeConfig(dir, args.usageCheck);

  const sessionPath = join(dir, 'session.jsonl');
  writeFileSync(
    sessionPath,
    `${JSON.stringify(assistantEntry(args.sessionTokens))}\n`,
  );

  const agentPath = join(
    dir,
    'session',
    'subagents',
    `agent-${args.agentId}.jsonl`,
  );
  mkdirSync(dirname(agentPath), {recursive: true});
  writeFileSync(
    agentPath,
    `${JSON.stringify(
      sidechainEntry(assistantEntry(args.agentTokens), args.agentId),
    )}\n`,
  );

  return {agentPath, dir, sessionPath};
}

/** runCapturing, plus whatever went to stderr. */
function runCapturingBoth(input: unknown): {
  payload: Record<string, unknown> | null;
  stderr: string;
} {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    return {payload: runCapturing(input), stderr: errors.join('\n')};
  } finally {
    console.error = originalError;
  }
}

describe('subagent transcripts: the path derivation', () => {
  test('strips .jsonl to get the session DIRECTORY, then indexes by agent id', () => {
    expect(
      subagentTranscriptPath('/p/-slug/6c2e-4a1b.jsonl', 'a405a84daeae6cd2b'),
    ).toBe('/p/-slug/6c2e-4a1b/subagents/agent-a405a84daeae6cd2b.jsonl');
  });

  test('refuses an agent id that could escape the directory', () => {
    for (const bad of ['../../etc/passwd', 'a/b', '', 'a\0b', 'a.b']) {
      expect(subagentTranscriptPath('/p/s.jsonl', bad)).toBeNull();
    }
  });

  test('refuses a parent path that is not a .jsonl file', () => {
    expect(subagentTranscriptPath('/p/s.txt', 'a1')).toBeNull();
    expect(subagentTranscriptPath('.jsonl', 'a1')).toBeNull();
  });
});

describe('measurement target: agent_id decides, and failure is not the parent', () => {
  const AGENT = 'a405a84daeae6cd2b';

  test('no agent_id measures transcript_path — unchanged behaviour', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 1,
      sessionTokens: 1,
      usageCheck: TEST_CONFIG,
    });
    expect(
      resolveMeasurementTarget({
        agentId: undefined,
        transcriptPath: fx.sessionPath,
      }),
    ).toEqual({kind: 'session', path: fx.sessionPath});
  });

  test('an agent_id whose transcript exists resolves to that file', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 1,
      sessionTokens: 1,
      usageCheck: TEST_CONFIG,
    });
    expect(
      resolveMeasurementTarget({
        agentId: AGENT,
        transcriptPath: fx.sessionPath,
      }),
    ).toEqual({agentId: AGENT, kind: 'subagent', path: fx.agentPath});
  });

  test('a bogus agent_id is UNKNOWN, never the parent (rule 6)', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 1,
      sessionTokens: 1,
      usageCheck: TEST_CONFIG,
    });
    const target = resolveMeasurementTarget({
      agentId: 'abogusdeadbeef00',
      transcriptPath: fx.sessionPath,
    });

    expect(target.kind).toBe('unknown');
    // The whole bug this guards: 'session' here would measure the CONDUCTOR
    // and report the number as the player's.
    expect(JSON.stringify(target)).not.toContain(fx.sessionPath);
    if (target.kind !== 'unknown') throw new Error('expected unknown');
    expect(target.reason).toContain('agent-abogusdeadbeef00.jsonl');
    expect(target.reason).toContain('refusing to fall back');
  });

  test('an underivable path is UNKNOWN rather than a silent session read', () => {
    const target = resolveMeasurementTarget({
      agentId: '../escape',
      transcriptPath: '/p/s.jsonl',
    });
    expect(target.kind).toBe('unknown');
  });

  test('no transcript_path at all is UNKNOWN, not an empty measurement', () => {
    expect(
      resolveMeasurementTarget({agentId: null, transcriptPath: ''}).kind,
    ).toBe('unknown');
  });
});

describe('config: per-role budgets (players vs the top-level session)', () => {
  // Justin's decided shape, 2026-09-04: a player wrap-up bound, and none for
  // the session until it can respawn itself.
  const JUSTINS_CONFIG: UsageCheckConfig = {
    enabled: true,
    roles: {player: {wrapUpAt: 350_000}},
    wrapUpAt: null,
  };

  test('the session keeps null while the player gets 350,000', () => {
    expect(resolved(JUSTINS_CONFIG).wrapUpAt).toBeNull();
    expect(resolvedFor(JUSTINS_CONFIG, 'player').wrapUpAt).toBe(350_000);
  });

  test("the player's threshold is folded into the player's ladder", () => {
    expect(resolvedFor(JUSTINS_CONFIG, 'player').setpoints).toContain(350_000);
    expect(resolved(JUSTINS_CONFIG).setpoints).not.toContain(350_000);
  });

  test('an unnamed knob is inherited, not reset to the SDK default', () => {
    const config: UsageCheckConfig = {
      enabled: true,
      reArmDropFraction: 0.5,
      roles: {player: {wrapUpAt: 350_000}},
      setpoints: [50_000],
    };
    const player = resolvedFor(config, 'player');
    expect(player.reArmDropFraction).toBe(0.5);
    expect(player.setpoints).toEqual([50_000, 350_000]);
  });

  test('a role may override the ladder itself, not just the threshold', () => {
    const config: UsageCheckConfig = {
      enabled: true,
      roles: {player: {setpoints: [25_000, 50_000]}},
      setpoints: [100_000],
    };
    expect(resolvedFor(config, 'player').setpoints).toEqual([25_000, 50_000]);
    expect(resolved(config).setpoints).toEqual([100_000]);
  });

  test('a role may set null explicitly to switch its own directive off', () => {
    const config: UsageCheckConfig = {
      enabled: true,
      roles: {player: {wrapUpAt: null}},
      wrapUpAt: 200_000,
    };
    expect(resolvedFor(config, 'player').wrapUpAt).toBeNull();
    expect(resolved(config).wrapUpAt).toBe(200_000);
  });

  test('no roles block at all means both roles resolve identically', () => {
    const config: UsageCheckConfig = {enabled: true, wrapUpAt: 200_000};
    expect(resolvedFor(config, 'player')).toEqual(resolved(config));
  });

  test('enabled:false is not role-overridable — off is off', () => {
    const config: UsageCheckConfig = {
      enabled: false,
      roles: {player: {wrapUpAt: 350_000}},
    };
    expect(resolveUsageCheckConfig(config, 'player')).toBeNull();
  });
});

describe('runUsageCheck: a player is measured on ITS OWN transcript', () => {
  const AGENT = 'a405a84daeae6cd2b';

  /** Justin's shape: no session bound, a 350k player bound. */
  const ROLE_CONFIG: UsageCheckConfig = {
    enabled: true,
    roles: {player: {wrapUpAt: 350_000}},
    setpoints: [100_000, 200_000, 300_000],
    wrapUpAt: null,
  };

  test('the two numbers are independent, from the same payload', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 360_000,
      sessionTokens: 900_000,
      usageCheck: ROLE_CONFIG,
    });
    const base = {
      cwd: fx.dir,
      hook_event_name: 'PostToolBatch',
      transcript_path: fx.sessionPath,
    };

    const asPlayer = noticeOf(
      runCapturing({...base, agent_id: AGENT, agent_type: 'player'}),
    );
    const asSession = noticeOf(runCapturing(base));

    // The player's own number, its own rung, and its own wrap-up bound.
    expect(asPlayer).toContain('360,000 tokens');
    expect(asPlayer).toContain('setpoint=350000');
    expect(asPlayer).toContain(WRAP_UP_DIRECTIVE);
    // The notice names the PLAYER, so it cannot be read as the parent's.
    expect(asPlayer).toContain('This player subagent');
    expect(asPlayer).toContain('not the parent');

    // Same payload, same instant, the session's own number — and NO directive,
    // because the session opted out while the player opted in.
    expect(asSession).toContain('900,000 tokens');
    expect(asSession).toContain('setpoint=300000');
    expect(asSession).not.toContain(WRAP_UP_DIRECTIVE);
    expect(asSession).toContain('This session');

    // The property the whole bead exists for.
    expect(asPlayer).not.toBe(asSession);
  });

  test('an unknown agent_type still says subagent rather than session', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 210_000,
      sessionTokens: 10,
      usageCheck: ROLE_CONFIG,
    });
    const notice = noticeOf(
      runCapturing({
        agent_id: AGENT,
        cwd: fx.dir,
        transcript_path: fx.sessionPath,
      }),
    );
    expect(notice).toContain('This subagent has now used 210,000 tokens');
  });

  test('the once-per-setpoint contract closes in the SUBAGENT file', () => {
    // Verified live 2026-09-04: a notice emitted during a player's turn is
    // recorded in that player's own transcript as a hook_additional_context
    // attachment with isSidechain:true and its agentId — so the state round
    // trip has to be read back from the same file the context came from.
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 210_000,
      sessionTokens: 10,
      usageCheck: ROLE_CONFIG,
    });
    const input = {
      agent_id: AGENT,
      agent_type: 'player',
      cwd: fx.dir,
      transcript_path: fx.sessionPath,
    };

    const first = noticeOf(runCapturing(input));
    expect(first).toContain('setpoint=200000');

    // Record it exactly as Claude Code does — into the subagent's file.
    appendFileSync(
      fx.agentPath,
      `${JSON.stringify(
        sidechainEntry(noticeEntry(first as string), AGENT),
      )}\n`,
    );
    expect(runCapturing(input)).toBeNull();
  });

  test('NEGATIVE CONTROL: a bogus agent_id reports UNKNOWN and measures nothing', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 210_000,
      sessionTokens: 900_000,
      usageCheck: ROLE_CONFIG,
    });

    const {payload, stderr} = runCapturingBoth({
      agent_id: 'abogusdeadbeef00',
      agent_type: 'player',
      cwd: fx.dir,
      transcript_path: fx.sessionPath,
    });

    // Nothing on stdout: no notice, and above all no notice carrying a number.
    expect(payload).toBeNull();
    // The failure is SAID, not swallowed.
    expect(stderr).toContain('UNKNOWN');
    expect(stderr).toContain('agent-abogusdeadbeef00.jsonl');
    // And it is emphatically NOT the parent's 900,000 relabelled as the
    // player's — the exact substitution rule 6 forbids.
    expect(stderr).not.toContain('900,000');
    expect(stderr).not.toContain('setpoint=');
  });

  test('a real agent_id whose file was deleted mid-session is UNKNOWN too', () => {
    const fx = subagentFixture({
      agentId: AGENT,
      agentTokens: 210_000,
      sessionTokens: 900_000,
      usageCheck: ROLE_CONFIG,
    });
    rmSync(fx.agentPath);

    const {payload, stderr} = runCapturingBoth({
      agent_id: AGENT,
      cwd: fx.dir,
      transcript_path: fx.sessionPath,
    });
    expect(payload).toBeNull();
    expect(stderr).toContain('UNKNOWN');
  });

  test('a top-level session with a broken transcript stays SILENT, as before', () => {
    // The stderr channel is for the subagent case only: a session that cannot
    // read its own transcript is the pre-existing, deliberately quiet path.
    const {dir} = (() => {
      const d = tempDir();
      writeConfig(d, ROLE_CONFIG);
      return {dir: d};
    })();
    const {payload, stderr} = runCapturingBoth({
      cwd: dir,
      transcript_path: join(dir, 'nope.jsonl'),
    });
    expect(payload).toBeNull();
    expect(stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('installer: settings and config wiring', () => {
  test('registers BOTH events, since UserPromptSubmit alone misses long turns', () => {
    expect([...USAGE_CHECK_HOOK_EVENTS]).toEqual([
      'UserPromptSubmit',
      'PostToolBatch',
    ]);
  });

  test('appends rather than replacing existing hooks for the same event', () => {
    // Claude Code runs every hook registered for an event, so clobbering a
    // project's own UserPromptSubmit hook would silently break it.
    const settings: Record<string, unknown> = {
      hooks: {
        UserPromptSubmit: [
          {hooks: [{command: 'bunx @justinhaaheim/justin-sdk time-check'}]},
        ],
      },
    };
    expect(addUsageCheckHook(settings, 'UserPromptSubmit')).toBe(true);

    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('time-check');
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain(
      'bunx @justinhaaheim/justin-sdk usage-check',
    );
  });

  test('is idempotent — a second install adds nothing', () => {
    const settings: Record<string, unknown> = {};
    expect(addUsageCheckHook(settings, 'PostToolBatch')).toBe(true);
    expect(addUsageCheckHook(settings, 'PostToolBatch')).toBe(false);
    expect((settings.hooks as Record<string, unknown[]>).PostToolBatch).toHaveLength(1);
  });

  test('writes both hooks and the config block into a real project', () => {
    setQuiet(true);
    const dir = tempDir();
    writeConfig(dir, null);

    expect(stepUsageCheckHooks(dir)).toBe(true);
    expect(stepUsageCheckConfig(dir)).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'),
    ) as {hooks: Record<string, unknown[]>};
    for (const event of USAGE_CHECK_HOOK_EVENTS) {
      expect(JSON.stringify(settings.hooks[event])).toContain(
        'bunx @justinhaaheim/justin-sdk usage-check',
      );
    }

    // The seed carries the two switches and NOTHING else. A materialized copy
    // of `setpoints` would freeze today's ladder into the project, so the next
    // change to the default would reach none of the repos it was made for.
    const installed = readUsageCheckConfig(dir);
    expect(installed).toEqual({enabled: true, wrapUpAt: null});

    // …and an absent `setpoints` must read as "use the SDK default", never as
    // "nothing to fire", which is the same shape as "disabled".
    const active = resolveUsageCheckConfig(installed);
    expect(active).not.toBeNull();
    expect(active?.setpoints).toEqual(USAGE_CHECK_DEFAULTS.setpoints);
    expect(active?.setpoints[0]).toBe(100_000);
    expect(active?.reArmDropFraction).toBe(
      USAGE_CHECK_DEFAULTS.reArmDropFraction,
    );
    expect(active?.wrapUpAt).toBeNull();
  });

  test('a tuned config survives a re-install untouched', () => {
    setQuiet(true);
    const dir = tempDir();
    writeConfig(dir, {enabled: false, setpoints: [42_000], wrapUpAt: null});
    expect(stepUsageCheckConfig(dir)).toBe(true);
    expect(readUsageCheckConfig(dir)).toEqual({
      enabled: false,
      setpoints: [42_000],
      wrapUpAt: null,
    });
  });

  test('refuses to configure a project with no justin-sdk.config.json', () => {
    setQuiet(true);
    expect(stepUsageCheckConfig(tempDir())).toBe(false);
  });
});
