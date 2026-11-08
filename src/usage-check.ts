/**
 * usage-check — a hook that tells a session how much CONTEXT it has used.
 *
 * "Usage" here means THIS SESSION'S OWN TOKEN CONSUMPTION — the size of the
 * conversation currently in the model's context window. It is NOT the quota
 * percentage that `/usage` and `ralph`'s usage gate report; those measure how
 * much of Justin's subscription allowance is left, which is a completely
 * different number. Nothing in this file talks to the server.
 *
 * WHY: a session cannot see its own context size. The model has no reliable
 * sense of how full the window is, yet the wind-down contract (conductor,
 * mayor, ralph) depends on knowing — a handoff written at 90% is a good
 * handoff, one written at 100% never gets written at all. The statusline shows
 * Justin a percentage, but the model never sees the statusline.
 *
 * TWO HALVES, ONE ON BY DEFAULT (D8): the INFORMATIONAL notice — "this session
 * has used N tokens of context" — fires every SETPOINT_INTERVAL_TOKENS and is
 * what Justin wants in every session. The wrap-up DIRECTIVE that can ride along
 * with it stays off until a config file names a token count for it.
 *
 * TWO CONFIG FILES, ONE ANSWER (home-base-o5atv.1.1). The knobs are read from
 * the repo's `justin-sdk.config.json` AND from the user file,
 * `$XDG_CONFIG_HOME/justin-sdk/config.json`, so one `wrapUpAt` there reaches
 * every repo that has this component. In Justin's words (2026-11-08): "Maybe we
 * just do specify the 400k there for now? Will the hooks read from this?" The
 * precedence, as the docs say it (D6): the repo's number wins. A repo's 0 turns
 * the directive off there. A repo's null, or no key, uses the user file's
 * number. No number anywhere means off. The user file supplies knob VALUES only
 * (D2): it never switches the component on in a repo whose own file has no
 * `usage-check` block, and its `enabled` is not read. See readUsageCheckLayers
 * and layerUsageCheckConfig.
 *
 * WHAT THE DIRECTIVE SAYS depends on who hears it (D7): a top-level session in
 * a repo where `thread handoff` starts a successor
 * (componentConfig.thread.handoff.successor) is told to run that call; any
 * other session, and every subagent, gets WRAP_UP_DIRECTIVE. See
 * wrapUpDirectiveFor.
 *
 * WHERE THE NUMBER COMES FROM: every assistant entry in the transcript carries
 * `message.usage`, and the context size of that API call is
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * (verified live 2026-08-20 against a running session and cross-checked with
 * the statusline). The hook input carries no context figure of its own —
 * exposing one is still an open request upstream (anthropics/claude-code
 * #25689, #27969, #44790) — so the transcript is the only source.
 *
 * THE TOP-LEVEL TOTALS ARE NOT ALWAYS THE CONTEXT (home-base-fjcp). A record
 * containing a server-side tool call — the `advisor` — carries the SUM of every
 * model turn inside it, which double-counts the cache reads and reports roughly
 * twice the real context. Such a record is read through its per-turn
 * `usage.iterations` breakdown instead, taking the LAST turn; see
 * `contextTokensFromRecordUsage` for the measurement and for why the obvious
 * content-block filter does not work.
 *
 * TWO EVENTS, one script (both verified injecting in CC 2.1.238):
 *   - UserPromptSubmit — fires when Justin sends a message.
 *   - PostToolBatch — fires ONCE after each batch of tool calls resolves,
 *     "before the next model request" (Claude Code's own words). This is the
 *     event that matters for autonomous work, where a single turn can run for
 *     hours and UserPromptSubmit never fires at all.
 * PostToolUse was rejected deliberately: it fires per-tool AND runs
 * CONCURRENTLY for parallel tool calls, so two copies would each read the
 * transcript before either had written its marker and both would announce the
 * same setpoint. PostToolBatch has neither problem.
 *
 * STATE IS DERIVED FROM THE TRANSCRIPT, never from a state file — time-check's
 * rationale applies unchanged: a state file desyncs on resume, on another
 * machine, or when the state dir is cleared, and it fails silently when it
 * does. Our own notices carry a machine-readable `notice-at=<n>` token (older
 * ones `setpoint=<n>`, still read — see NOTICE_TOKEN_NAME), so the most recent
 * one tells us exactly where the ladder stands.
 *
 * THE RE-ARM RULE (context can SHRINK — auto-compaction can drop a 300k
 * session to 60k, and after that the setpoints must fire again):
 *   Only the MOST RECENT notice matters. Let C be the current context and S the
 *   setpoint that notice named. We announce the highest setpoint <= C when:
 *     - there is no previous notice (first crossing), or
 *     - C has reached the next setpoint ABOVE S (ordinary ascent), or
 *     - C has fallen more than `reArmDropFraction` (default 25%) below S,
 *       which is read as a compaction and re-arms the whole ladder, or
 *     - C is at or past `wrapUpAt` and that notice did NOT carry the wrap-up
 *       directive (home-base-o5atv.2.1). This is a session that crossed the
 *       threshold before one was set, or whose notice fired as an FYI: it is
 *       told at its next check. The notice this writes carries the directive,
 *       so the next evaluation sees "already told" and stays silent until the
 *       ladder ascends or re-arms. That is the whole "once"; no extra state.
 *   A drop that small enough to stay within the fraction is treated as noise
 *   and changes nothing. Re-arming cannot chatter: the notice it emits names a
 *   setpoint <= C, so the very next evaluation sees S <= C and neither branch
 *   fires again.
 *
 * WHOSE CONTEXT (1r6d.23): a hook firing during a SUBAGENT's turn still carries
 * the PARENT's `transcript_path`, so for a year this could only ever report the
 * conductor's number to a player — the exact inversion the wrap-up bound must
 * not have. The payload also carries `agent_id`, and the subagent's own
 * transcript sits at <session dir>/subagents/agent-<agent_id>.jsonl. So the
 * hook branches on that id: absent, measure transcript_path as before; present,
 * measure the subagent's file, apply the `roles.player` budget, and say in the
 * notice that the number is the subagent's own. When the derived file is not
 * there, it reports UNKNOWN on stderr and measures NOTHING — see runUsageCheck.
 *
 * @see home-base-1r6d.1, home-base-1r6d.23
 */

// Type-only, so erased: sdk-config imports zod, and this module must not (D5).
import type {EnvLike} from './sdk-config';

import {closeSync, openSync, readFileSync, readSync, statSync} from 'fs';
import {join, resolve} from 'path';

// health-notices and thread-rules import only node builtins, and thread/defaults
// imports nothing: all three keep this hook's import graph free of zod
// (tests/health-notices-cli.test.ts asserts it).
import {PROJECT_CONFIG_FILENAME, xdgConfigHome} from './health-notices';
import {emitHookOutput} from './hook-output';
import {SDK_HANDOFF_CALL} from './sdk-invocation';
import {HANDOFF_DEFAULTS, THREAD_CONFIG_KEY} from './thread/defaults';
import {HANDOFF_RULE_FILE, THREAD_RULES_DIR} from './thread-rules';

/** Marks our own output so a later run can find it in the transcript. */
export const USAGE_CHECK_MARKER = '[Automated Usage Check]';

/**
 * The name of the machine-readable half of a notice, `notice-at=<n>`, where n
 * is the rung the notice fired for. That token is the component's entire
 * persistence layer — reword the prose around it freely, but never emit a
 * notice without it and never change its shape without changing the parser.
 *
 * The name is neutral on purpose (home-base-y1hg0.22). Until 2026-10-20 the
 * token was `setpoint=<n>`, and a session read "(setpoint=200000)" as "you are
 * past your limit" and handed itself off with nothing wrong.
 */
const NOTICE_TOKEN_NAME = 'notice-at';

/**
 * The token's name before home-base-y1hg0.22. PARSED, never written: live
 * transcripts already hold notices in this form, and a reader that forgot it
 * would find "no notice yet" and re-announce a rung the session was already
 * told about.
 */
const LEGACY_NOTICE_TOKEN_NAME = 'setpoint';

/** Reads either name. Built from the two constants so writer and reader agree. */
const SETPOINT_TOKEN = new RegExp(
  `\\b(?:${NOTICE_TOKEN_NAME}|${LEGACY_NOTICE_TOKEN_NAME})=(\\d+)`,
);

/** The key under `componentConfig` in justin-sdk.config.json. */
export const USAGE_CHECK_CONFIG_KEY = 'usage-check';

/**
 * The opening every wrap-up directive starts with, and the only thing the
 * transcript scan looks for to learn whether a notice carried one
 * (home-base-o5atv.2.1 E2). Both directives below are BUILT from it, so the
 * writer and the reader cannot drift apart. It also reads every notice written
 * before E2, which carry WRAP_UP_DIRECTIVE verbatim and no token for it.
 *
 * Reword the rest of a directive freely; change this opening only together
 * with a reader that still accepts the old one, or every session past its
 * threshold is told again.
 */
export const WRAP_UP_OPENING =
  'Wrap up your session at the next available opportunity';

/**
 * The wrap-up directive, in Justin's words (home-base-1r6d.1, D5 REVISED).
 * Said only when a `wrapUpAt` resolves to a threshold, from either config file
 * (D6), and the context has reached it.
 *
 * This is the text a SUBAGENT gets, and a top-level session in a repo where
 * `thread handoff` cannot start a successor (componentConfig.thread.handoff.
 * successor off). It names no command on purpose: `thread handoff` is named
 * only where that knob is on (home-base-jm5kg.8), and a subagent never runs it
 * (handoff.md; the session guard refuses it). See wrapUpDirectiveFor.
 */
export const WRAP_UP_DIRECTIVE = `${WRAP_UP_OPENING}. Follow the handoff/ralph-handoff protocol.`;

/** The installed rule that teaches a session how to hand off. */
export const HANDOFF_RULE_PATH = `${THREAD_RULES_DIR}/${HANDOFF_RULE_FILE}`;

/**
 * The wrap-up directive for a top-level session in a repo where
 * componentConfig.thread.handoff.successor is on (home-base-o5atv.1.1 D7).
 * There the handoff rule is installed and `thread handoff` starts the next
 * session itself, so the directive names the rule and the exact call.
 *
 * The call is spelled from SDK_HANDOFF_CALL, by path and never with a `bun`
 * prefix: Claude Code never lets a command whose first word is `bun` out of its
 * sandbox, and inside it the handoff cannot reach cmux (sdk-invocation.ts).
 */
export const HANDOFF_WRAP_UP_DIRECTIVE = `${WRAP_UP_OPENING}, then hand off as ${HANDOFF_RULE_PATH} describes: run \`${SDK_HANDOFF_CALL} --note "<one line the next session must know>"\` bare, from the repository root, with nothing before or after it.`;

/**
 * The knobs, minus `enabled`. Written out as its own interface because a ROLE
 * (see UsageCheckConfig.roles) can override any of them without being able to
 * switch the component off for one role and not the other.
 */
export interface UsageCheckRoleConfig {
  /** Fractional drop below the last announced setpoint that re-arms the ladder. */
  reArmDropFraction?: number;
  /**
   * Ascending token thresholds; each announces once. Explicit null disables the
   * ladder; ABSENT takes the generated default (see USAGE_CHECK_DEFAULTS), so
   * an installed project tracks changes to that default instead of freezing a
   * copy of it.
   */
  setpoints?: number[] | null;
  /**
   * At or above this context size the notice adds the wrap-up directive. Keyed
   * off the measured context rather than the announced setpoint, so it still
   * fires when it sits between two setpoints.
   *
   * What each value says (home-base-o5atv.1.1 D3, D4):
   *  - A number above 0 is the threshold. It wins over every layer below it.
   *  - 0 turns the directive OFF here, deliberately, and also wins over the
   *    layers below. So does any other number that is not positive and finite.
   *  - null, or no key, says nothing. The value comes from the next layer down:
   *    for a role, its top level; for a file, the user file; last, the SDK
   *    default, which is off.
   *
   * null cannot mean "off", because `{"enabled": true, "wrapUpAt": null}` is
   * the installer's seed, written into repos without anyone deciding anything.
   * A string or `false` also says nothing here; the typed schema rejects both.
   *
   * Off by default because, in Justin's words (2026-08-24), "there are going to
   * be sessions where I want to continue past 300k, and sessions where Claude
   * Code is going to be confused where the message is coming from."
   */
  wrapUpAt?: number | null;
}

/**
 * A project's `componentConfig["usage-check"]` block.
 *
 * The top-level knobs describe the TOP-LEVEL SESSION. `roles.player` overrides
 * them for a dispatched subagent, whose budget is a different number from its
 * conductor's — Justin, 2026-09-04: players get a wrap-up bound (~350,000, "a
 * balance between keeping token counts low while allowing actual work to
 * happen") while the top-level session gets none until it can respawn itself.
 * Expressed as a nested block rather than parallel `playerWrapUpAt` keys so
 * every knob is overridable by role without the key list being written twice.
 *
 * A role field left ABSENT inherits the top-level value. For `wrapUpAt`, null
 * inherits too (home-base-o5atv.1.1 D3), and `roles.player.wrapUpAt: 0` is how
 * to switch the directive off for players while the session keeps its own
 * (D4). For `setpoints`, null still means null FOR THAT ROLE: no ladder.
 *
 * With both config files, a player's `wrapUpAt` comes from the first of these
 * that holds a number: project roles.player, user roles.player, project top
 * level, user top level, SDK default (off). A session's: project top level,
 * user top level, SDK default (D1).
 *
 * @see home-base-1r6d.23
 */
export interface UsageCheckConfig extends UsageCheckRoleConfig {
  enabled?: boolean;
  roles?: {player?: UsageCheckRoleConfig | null} | null;
}

/**
 * Which budget applies. Selected by the PRESENCE of `agent_id` in the hook
 * payload — measured 2026-09-03: PostToolUse/PostToolBatch payloads carry
 * `agent_id`/`agent_type` when and only when the tool call originated inside a
 * subagent, so this needs no heuristic.
 */
export type UsageCheckRole = 'player' | 'session';

/*
 * THE DEFAULT LADDER IS GENERATED, not hand-picked (D7).
 *
 * Justin's words (2026-08-24): "automatically run every hundred thousand
 * tokens". The rungs this shipped with (150k/200k/250k/300k/400k/500k) were
 * uneven below 500k and silent above it.
 *
 * D7 kept `setpoints` an ARRAY rather than adding a `setpointIntervalTokens`
 * config key: the resolve, dedupe and re-arm machinery all operate on arrays, a
 * second config concept would mean two ways to say the same thing, and a
 * project that wants irregular rungs can still write them out longhand.
 */

/** Spacing between the setpoints of the generated default ladder. */
export const SETPOINT_INTERVAL_TOKENS = 100_000;

/**
 * The highest setpoint the generated default ladder reaches. It exists only
 * because the ladder has to be a finite array, and sits past any context window
 * in service — so the series never runs out in practice, and raising it costs
 * one more number in an array.
 */
export const SETPOINT_CEILING_TOKENS = 2_000_000;

/**
 * Ascending, evenly spaced setpoints from `interval` up to and including the
 * largest multiple of `interval` that is <= `ceiling`.
 *
 * Multiplies rather than accumulating, so a fractional interval cannot drift
 * the upper rungs off their exact values.
 *
 * THROWS on a non-positive interval or a ceiling below it. Both are programmer
 * errors — the only production caller passes the constants above — and the
 * tempting alternative, returning [], is precisely the failure-shaped-as-
 * emptiness this codebase forbids: an empty ladder resolves to "usage-check
 * disabled", so a bad constant would silently switch the component off for
 * every project at once and nothing would ever look wrong.
 */
export function buildSetpointLadder(
  interval: number,
  ceiling: number,
): number[] {
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError(
      `setpoint interval must be a positive finite number, got ${interval}`,
    );
  }
  if (!Number.isFinite(ceiling) || ceiling < interval) {
    throw new RangeError(
      `setpoint ceiling ${ceiling} is below the interval ${interval}`,
    );
  }

  const rungs = Math.floor(ceiling / interval);
  const ladder: number[] = [];
  for (let rung = 1; rung <= rungs; rung += 1) {
    ladder.push(interval * rung);
  }
  return ladder;
}

/**
 * Written into a project's config when the component is installed. A project
 * with NO config is treated as disabled (see resolveUsageCheckConfig), so these
 * only ever apply where the component was deliberately added.
 *
 * Typed explicitly rather than as `Required<UsageCheckConfig>`: `Required` only
 * strips optionality, so the null half of `setpoints`' union would survive into
 * the defaults and make it un-iterable at every call site. `wrapUpAt` keeps its
 * null (D8) because null is not "missing" here: this is the bottom layer, and
 * null means the directive is off until a config file names a number for it.
 * The installer seeds the same null, which in a FILE says nothing (D3).
 */
export const USAGE_CHECK_DEFAULTS: {
  enabled: boolean;
  reArmDropFraction: number;
  setpoints: number[];
  wrapUpAt: number | null;
} = {
  enabled: true,
  reArmDropFraction: 0.25,
  setpoints: buildSetpointLadder(
    SETPOINT_INTERVAL_TOKENS,
    SETPOINT_CEILING_TOKENS,
  ),
  wrapUpAt: null,
};

export interface ResolvedUsageCheckConfig {
  reArmDropFraction: number;
  /**
   * Ascending and deduped. When `wrapUpAt` is a number the ladder is also
   * guaranteed to contain it (see resolveUsageCheckConfig); when `wrapUpAt` is
   * null that guarantee has nothing to guarantee and lapses — the ladder is
   * purely informational, and null is never folded in as a rung.
   */
  setpoints: number[];
  /** null means the wrap-up directive is off entirely — the default (D8). */
  wrapUpAt: number | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/*
 * Both files are read here, by hand, rather than through sdk-config's typed
 * readers or setup-helpers' readJson: this is the hot path of a hook that runs
 * after every tool batch, sdk-config brings zod (12-13ms against a 40-50ms
 * CLI start, health-notices.ts), and setup-helpers drags in the installer
 * machinery. Same reason time-check imports nothing but `fs` and `path`. The
 * cost of reading by hand is that a file the schema would reject still
 * contributes here; the doc comment on UsageCheckRoleConfig.wrapUpAt says what
 * each shape means to this reader (D4).
 */

/**
 * The user config file: `$XDG_CONFIG_HOME/justin-sdk/config.json`, or
 * `~/.config/justin-sdk/config.json`. The same join as sdk-config's
 * `userConfigPath`, which this module cannot import because it brings zod; a
 * test proves the two agree.
 */
export function usageCheckUserConfigPath(env: EnvLike = process.env): string {
  return join(xdgConfigHome(env), 'justin-sdk', 'config.json');
}

/** One config file as this hook reads it. Only ENOENT is absence. */
type ConfigFileRead =
  | {error: string; status: 'unreadable'}
  | {json: unknown; status: 'ok'}
  | {status: 'absent'};

/** The errno of a thrown fs error, when it has one. */
function errorCodeOf(error: unknown): string | null {
  if (error == null || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as {code: unknown}).code;
  return typeof code === 'string' ? code : null;
}

/** An error's message on one line, so a stderr report stays one line. */
function oneLineMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Read and parse one config file. Never throws. The read is attempted directly
 * and the errno decides: an `existsSync` first would answer false for every
 * failure, so an unreadable file would pass for "there is no file".
 */
function readConfigFile(path: string): ConfigFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return errorCodeOf(error) === 'ENOENT'
      ? {status: 'absent'}
      : {error: oneLineMessageOf(error), status: 'unreadable'};
  }
  try {
    return {json: JSON.parse(raw) as unknown, status: 'ok'};
  } catch (error) {
    return {error: oneLineMessageOf(error), status: 'unreadable'};
  }
}

/** `componentConfig[key]` of a parsed config file, or null when it is not an object. */
function componentSectionOf(
  json: unknown,
  key: string,
): Record<string, unknown> | null {
  if (json == null || typeof json !== 'object') return null;
  const componentConfig: unknown = (json as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object') {
    return null;
  }
  const section: unknown = (componentConfig as Record<string, unknown>)[key];
  if (section == null || typeof section !== 'object') return null;
  return section as Record<string, unknown>;
}

function usageCheckSectionOf(json: unknown): UsageCheckConfig | null {
  return componentSectionOf(json, USAGE_CHECK_CONFIG_KEY);
}

/**
 * Read the PROJECT file's `componentConfig["usage-check"]` block, and only
 * that. The hook and the thread report read readUsageCheckLayers instead,
 * which adds the user file; this stays for callers that ask what the repo's
 * own file says.
 *
 * Returns null when the file, the section, or the key is absent, or when the
 * file cannot be read or parsed: a malformed config must not break the user's
 * prompt.
 */
export function readUsageCheckConfig(
  projectRoot: string,
): UsageCheckConfig | null {
  const read = readConfigFile(resolve(projectRoot, PROJECT_CONFIG_FILENAME));
  return read.status === 'ok' ? usageCheckSectionOf(read.json) : null;
}

/**
 * Does this `wrapUpAt` say anything? Only a number does (D3, D4): null is the
 * installer's seed and means "no opinion here", and a string or `false` is
 * junk this reader treats the same way. 0 is a number, so a deliberate 0 wins
 * over the layers below and then normalizes to "off".
 */
function statesWrapUpAt(value: unknown): value is number {
  return typeof value === 'number';
}

/**
 * One block's knobs over another's, field by field (D1). `upper` wins wherever
 * it states a value: for `wrapUpAt` that means a number (statesWrapUpAt); for
 * `setpoints` and `reArmDropFraction` it means any value but `undefined`, the
 * rule applyRoleOverrides has always used for them, so a `setpoints: null`
 * still switches the ladder off.
 */
function layerKnobs(
  upper: UsageCheckRoleConfig,
  lower: UsageCheckRoleConfig,
): UsageCheckRoleConfig {
  return {
    reArmDropFraction:
      upper.reArmDropFraction !== undefined
        ? upper.reArmDropFraction
        : lower.reArmDropFraction,
    setpoints:
      upper.setpoints !== undefined ? upper.setpoints : lower.setpoints,
    wrapUpAt: statesWrapUpAt(upper.wrapUpAt) ? upper.wrapUpAt : lower.wrapUpAt,
  };
}

/** `roles.player` of a block, when it is an object. */
function playerBlockOf(config: UsageCheckConfig): UsageCheckRoleConfig | null {
  const roles: unknown = config.roles;
  if (roles == null || typeof roles !== 'object') return null;
  const player: unknown = (roles as {player?: unknown}).player;
  if (player == null || typeof player !== 'object') return null;
  return player as UsageCheckRoleConfig;
}

/**
 * The project's block over the user file's, field by field, at the top level
 * and under `roles.player` (D1). The result is an ordinary UsageCheckConfig,
 * so resolveUsageCheckConfig then layers the role over the top level exactly
 * as it does for one file. That yields D1's order for a player's `wrapUpAt`:
 * project roles.player, user roles.player, project top level, user top level,
 * SDK default.
 *
 * `enabled` comes from the project block alone (D2): the user file supplies
 * knob values, and which repos run the hook is decided by their own files.
 * The caller only gets here with a project block in hand, which the type says.
 */
export function layerUsageCheckConfig(
  project: UsageCheckConfig,
  user: UsageCheckConfig | null,
): UsageCheckConfig {
  if (user == null) return project;
  const layered: UsageCheckConfig = layerKnobs(project, user);
  if (project.enabled !== undefined) layered.enabled = project.enabled;
  const projectPlayer = playerBlockOf(project);
  const userPlayer = playerBlockOf(user);
  if (projectPlayer != null || userPlayer != null) {
    layered.roles = {
      player: layerKnobs(projectPlayer ?? {}, userPlayer ?? {}),
    };
  }
  return layered;
}

/** `componentConfig.thread.handoff.successor` of one parsed file, when it is a boolean. */
function handoffSuccessorIn(json: unknown): boolean | null {
  const handoff = componentSectionOf(json, THREAD_CONFIG_KEY)?.handoff;
  if (handoff == null || typeof handoff !== 'object') return null;
  const successor: unknown = (handoff as {successor?: unknown}).successor;
  return typeof successor === 'boolean' ? successor : null;
}

/**
 * Whether `thread handoff` starts a successor in this repo (D7), from the two
 * files this hook has already parsed: DEFAULT (false) <- user file <- project
 * file, and only a boolean counts at each layer, as in thread/handoff-knob.ts.
 * hookKnobOn answers the same question through resolveThreadConfig, which
 * reaches zod; tests/usage-check-user-config.test.ts proves the two agree.
 *
 * Accepted difference: resolveThreadConfig drops a whole file that fails the
 * schema, and this walk still reads that file's boolean.
 */
export function resolveHandoffSuccessor(
  projectJson: unknown,
  userJson: unknown,
): boolean {
  return (
    handoffSuccessorIn(projectJson) ??
    handoffSuccessorIn(userJson) ??
    HANDOFF_DEFAULTS.successor
  );
}

/**
 * Everything the hook needs from the two config files.
 *
 * 'off' means the PROJECT file has no `usage-check` block or says
 * `enabled: false`. The user file is not even read then: a repo without the
 * component pays nothing and says nothing, and the user file cannot switch it
 * on (D2).
 */
export type UsageCheckLayers =
  | {
      /** The project block over the user block (layerUsageCheckConfig). */
      config: UsageCheckConfig;
      /** See resolveHandoffSuccessor. */
      handoffSuccessor: boolean;
      status: 'on';
      /**
       * The user file exists but could not be read or parsed: its path and
       * the error, on one line. That layer is ignored (D5). null otherwise,
       * including when there is no user file.
       */
      userConfigProblem: string | null;
    }
  | {status: 'off'};

/**
 * Read the project file and, when it has the component, the user file (D5:
 * one file more than before, and only then). Each is parsed once; the project
 * JSON also answers the successor knob.
 *
 * The one resolver behind the hook AND the thread report (D8): both call this
 * and then resolveUsageCheckConfig, so `thread status` cannot show a threshold
 * the hook does not use.
 */
export function readUsageCheckLayers(
  projectRoot: string,
  env: EnvLike = process.env,
): UsageCheckLayers {
  const projectRead = readConfigFile(
    resolve(projectRoot, PROJECT_CONFIG_FILENAME),
  );
  const projectJson = projectRead.status === 'ok' ? projectRead.json : null;
  const project = usageCheckSectionOf(projectJson);
  if (project == null || project.enabled === false) {
    return {status: 'off'};
  }

  const userPath = usageCheckUserConfigPath(env);
  const userRead = readConfigFile(userPath);
  const userJson = userRead.status === 'ok' ? userRead.json : null;
  return {
    config: layerUsageCheckConfig(project, usageCheckSectionOf(userJson)),
    handoffSuccessor: resolveHandoffSuccessor(projectJson, userJson),
    status: 'on',
    userConfigProblem:
      userRead.status === 'unreadable'
        ? `${userPath}: ${userRead.error}`
        : null,
  };
}

/**
 * The wrap-up threshold as a usable number, or null when the directive is off.
 *
 * One function so that "is this a real threshold?" is answered in exactly one
 * place: the ladder-folding below and the returned config must never disagree
 * about it, or a null could be folded in as a rung, or a threshold could be
 * honoured without the rung that guarantees it gets said.
 */
function normalizeWrapUpAt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Layer `roles[role]` over the top-level knobs.
 *
 * Only keys the role states EXPLICITLY win, which is what makes a role block
 * that names one knob (Justin's case: a player wrapUpAt and nothing else) leave
 * the ladder and re-arm fraction alone. For `setpoints` and
 * `reArmDropFraction`, `undefined` means "inherit" and null is a value, so the
 * test is `!== undefined`. For `wrapUpAt`, only a number states and null
 * inherits too (home-base-o5atv.1.1 D3); 0 is the role's deliberate "off" (D4).
 *
 * The 'session' role has no block by construction: the top-level knobs ARE the
 * session's, so there is only ever one place to write them.
 */
function applyRoleOverrides(
  config: UsageCheckConfig,
  role: UsageCheckRole,
): UsageCheckRoleConfig {
  const override = role === 'player' ? config.roles?.player : null;
  if (override == null) {
    return config;
  }
  return {
    reArmDropFraction:
      override.reArmDropFraction !== undefined
        ? override.reArmDropFraction
        : config.reArmDropFraction,
    setpoints:
      override.setpoints !== undefined ? override.setpoints : config.setpoints,
    wrapUpAt: statesWrapUpAt(override.wrapUpAt)
      ? override.wrapUpAt
      : config.wrapUpAt,
  };
}

/**
 * Merge a config block over the defaults and normalize the ladder. The block
 * is one file's, or the two files layered by layerUsageCheckConfig: the hook
 * and the thread report pass the layered one (readUsageCheckLayers).
 *
 * A NUMERIC `wrapUpAt` is folded INTO the setpoints. Without that, a config
 * whose wrapUpAt sits between two setpoints would cross the wrap-up threshold
 * without any notice being due, and the directive would never be said — a
 * silent, config-shaped way to lose the one message that matters most. A null
 * wrapUpAt (the default, D8) folds in nothing: there is no threshold to reach,
 * so the ladder stays exactly what the setpoints said.
 *
 * `role` selects whose budget applies (1r6d.23). It defaults to 'session', so
 * every pre-existing caller keeps the behaviour it had; 'player' layers
 * `roles.player` over the top-level knobs first. The fold-in above then runs on
 * the ROLE's wrapUpAt, which is what makes a player's threshold reachable on a
 * ladder that was only ever tuned for the session.
 *
 * Returns null when the component is absent, disabled, or left with an empty
 * ladder (nothing could ever fire, so say so by returning the same "off" value
 * rather than a config that silently does nothing).
 */
export function resolveUsageCheckConfig(
  config: UsageCheckConfig | null,
  role: UsageCheckRole = 'session',
): ResolvedUsageCheckConfig | null {
  if (config == null || config.enabled === false) {
    return null;
  }

  const effective = applyRoleOverrides(config, role);

  const rawSetpoints =
    effective.setpoints === undefined
      ? USAGE_CHECK_DEFAULTS.setpoints
      : effective.setpoints;
  const wrapUpAt = normalizeWrapUpAt(
    effective.wrapUpAt === undefined
      ? USAGE_CHECK_DEFAULTS.wrapUpAt
      : effective.wrapUpAt,
  );
  const reArmDropFraction =
    typeof effective.reArmDropFraction === 'number' &&
    Number.isFinite(effective.reArmDropFraction) &&
    effective.reArmDropFraction > 0 &&
    effective.reArmDropFraction < 1
      ? effective.reArmDropFraction
      : USAGE_CHECK_DEFAULTS.reArmDropFraction;

  const ladder = new Set<number>();
  for (const value of Array.isArray(rawSetpoints) ? rawSetpoints : []) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      ladder.add(Math.floor(value));
    }
  }
  if (wrapUpAt != null) {
    ladder.add(wrapUpAt);
  }
  if (ladder.size === 0) {
    return null;
  }

  return {
    reArmDropFraction,
    setpoints: [...ladder].sort((a, b) => a - b),
    wrapUpAt,
  };
}

// ---------------------------------------------------------------------------
// Whose context are we measuring?
// ---------------------------------------------------------------------------

/** Which kind of transcript file a path points at. */
export type MeasurementScope = 'session' | 'subagent';

/**
 * What the hook decided to measure, or why it could not decide.
 *
 * 'unknown' is a DISTINCT member on purpose (rule 6): the one thing this must
 * never do is answer "I could not find the player's transcript" by measuring
 * the parent's instead. That substitution would look like a success, would
 * report a number that is real but belongs to somebody else, and would
 * reintroduce exactly the inverted bound this feature exists to remove — a
 * player told to wrap up when its CONDUCTOR crosses the threshold.
 */
export type MeasurementTarget =
  | {kind: 'session'; path: string}
  | {agentId: string; kind: 'subagent'; path: string}
  | {kind: 'unknown'; reason: string};

/**
 * Subagent ids as Claude Code writes them. Narrow on purpose: this string is
 * concatenated into a filesystem path, so anything carrying a separator, a
 * `..`, or a NUL is refused rather than resolved.
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The subagent transcript for `agentId`, derived from the parent's path.
 *
 * DERIVATION, measured 2026-09-03 and re-confirmed 2026-09-04:
 *   transcript_path -> strip the trailing ".jsonl" -> the session DIRECTORY
 *   + "/subagents/agent-<agent_id>.jsonl"
 * i.e. ~/.claude/projects/<slug>/<parent-session-id>/subagents/agent-<id>.jsonl
 *
 * Identity lives in the FILE PATH and nowhere else: the `sessionId` field
 * INSIDE a subagent transcript is the PARENT's id. That is almost certainly why
 * an earlier investigation (home-base-1r6d.20) concluded no subagent-scoped
 * transcript existed — it read transcript_path and record contents, both of
 * which say "parent", and never looked at the directory.
 *
 * Returns null when the parent path is not a `.jsonl` file or the id is not a
 * plain token. Both mean "we cannot derive it", never "use the parent".
 */
export function subagentTranscriptPath(
  transcriptPath: string,
  agentId: string,
): string | null {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return null;
  }
  if (!transcriptPath.endsWith('.jsonl')) {
    return null;
  }
  const sessionDir = transcriptPath.slice(0, -'.jsonl'.length);
  if (sessionDir === '') {
    return null;
  }
  return join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
}

/**
 * Pick the transcript whose context this hook is reporting.
 *
 * No `agent_id` in the payload means the tool batch was the top-level session's
 * own, so `transcript_path` is the right file — unchanged behaviour, and the
 * only path that existed before 1r6d.23.
 *
 * An `agent_id` means the batch came from inside a subagent, and the subagent's
 * own transcript is the only file that describes ITS context. When that file
 * cannot be derived or is not on disk we return 'unknown' and the caller says
 * so; we never hand back the parent's path as a consolation prize.
 *
 * The existence check lives HERE rather than being left to the reader so the
 * failure can name the path it looked for. `readTranscriptFacts` returning a
 * null context would be indistinguishable from a transcript that simply holds
 * no usage yet, and the two need different messages.
 */
export function resolveMeasurementTarget(args: {
  agentId: string | null | undefined;
  transcriptPath: string | null | undefined;
}): MeasurementTarget {
  const {agentId, transcriptPath} = args;
  if (transcriptPath == null || transcriptPath === '') {
    return {kind: 'unknown', reason: 'the payload carried no transcript_path'};
  }
  if (agentId == null || agentId === '') {
    return {kind: 'session', path: transcriptPath};
  }

  const path = subagentTranscriptPath(transcriptPath, agentId);
  if (path == null) {
    return {
      kind: 'unknown',
      reason: `could not derive a subagent transcript from transcript_path ${transcriptPath} and agent_id ${agentId}`,
    };
  }
  try {
    if (!statSync(path).isFile()) {
      return {kind: 'unknown', reason: `${path} is not a file`};
    }
  } catch {
    return {
      kind: 'unknown',
      reason: `no subagent transcript at ${path} (agent_id ${agentId}) — refusing to fall back to the parent session's transcript`,
    };
  }
  return {agentId, kind: 'subagent', path};
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptFacts {
  /**
   * Current context size in tokens, or null when it could NOT be measured.
   * Null never means zero — a session with no measurable usage and a session
   * whose transcript we failed to read are different facts, and only one of
   * them is safe to reason about.
   */
  contextTokens: number | null;
  /** The setpoint named by our most recent notice, or null. */
  lastAnnouncedSetpoint: number | null;
  /**
   * Whether that same notice carried the wrap-up directive
   * (home-base-o5atv.2.1 E1). Null exactly when lastAnnouncedSetpoint is null:
   * both are read from one record, in one step, so a notice is never half
   * known. See noticeCarriesWrapUp.
   */
  lastNoticeHadWrapUp: boolean | null;
  /**
   * Whether the scan reached the START of the transcript. This is what makes
   * `lastAnnouncedSetpoint: null` interpretable: with reachedStart true it
   * means "there is no prior notice"; with it false it means "we stopped
   * looking", which is not the same claim at all.
   */
  reachedStart: boolean;
}

interface TailWindow {
  reachedStart: boolean;
  text: string;
}

/**
 * Read the last `windowBytes` of a file.
 *
 * Transcripts get large — a real 44MB one measured here holds only 1,584 lines
 * (28KB per line), and reading it whole costs 39ms against 1.0ms for a 1MB
 * tail. Since a hook on PostToolBatch runs once per model request, the tail is
 * the difference between free and noticeable.
 *
 * When the window does not reach the start of the file its first line is
 * dropped: it is a partial line, and it is also the only place a multi-byte
 * character could have been sliced in half.
 *
 * Returns null on any I/O failure — the caller must not confuse that with an
 * empty transcript.
 */
function readTailWindow(path: string, windowBytes: number): TailWindow | null {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - windowBytes);
    const reachedStart = start === 0;
    const length = size - start;
    if (length === 0) {
      return {reachedStart: true, text: ''};
    }

    const fd = openSync(path, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }

    if (!reachedStart) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    }
    return {reachedStart, text};
  } catch {
    return null;
  }
}

/**
 * The context size an assistant entry's usage block describes, or null.
 *
 * A missing cache field genuinely means zero cached tokens (an uncached first
 * call reports neither), so those default to 0. A missing or non-numeric
 * `input_tokens` is different in kind — that is a shape we do not understand,
 * and guessing would fabricate a context reading — so it yields null.
 */
export function contextTokensFromUsage(usage: unknown): number | null {
  if (usage == null || typeof usage !== 'object') {
    return null;
  }
  const fields = usage as Record<string, unknown>;
  const input = fields.input_tokens;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return null;
  }

  let total = input;
  for (const key of [
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ]) {
    const value = fields[key];
    if (value == null) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    total += value;
  }
  return total;
}

/**
 * The `iterations[].type` of an ordinary model turn. Anything else in that slot
 * is a foreign turn spliced into the same record — today, `advisor_message`.
 */
const ITERATION_TYPE_MODEL_TURN = 'message';

/** The `server_tool_use` counters that mark a record as a server-tool exchange. */
const SERVER_TOOL_COUNTERS = ['web_search_requests', 'web_fetch_requests'];

/**
 * Is this record a server-tool exchange by the `server_tool_use` counters?
 *
 * DEFENSIVE, AND ITS PREMISE IS UNVERIFIED. WebSearch and WebFetch are server
 * tools too and would plausibly disturb a record's totals the way the advisor
 * does, but no transcript proves it: across all 2,787 files under
 * ~/.claude/projects, 1,938 carry `web_search_requests` and every one of them is
 * zero, so no real web-tool record exists to measure. Only the FIELD shape is
 * real; the linkage to inflated totals is conjecture.
 *
 * These counters are NOT the advisor's discriminant — the advisor record reports
 * both as zero — which is why `contextTokensFromRecordUsage` leans on
 * `iterations` for the case we can actually measure. A hit here is treated as
 * unmeasurable rather than decomposed, because with no real record we do not
 * know that such a record even HAS a per-turn breakdown to read.
 */
function usageHasServerToolCalls(fields: Record<string, unknown>): boolean {
  const serverToolUse = fields.server_tool_use;
  if (serverToolUse == null || typeof serverToolUse !== 'object') {
    return false;
  }
  const counters = serverToolUse as Record<string, unknown>;
  for (const key of SERVER_TOOL_COUNTERS) {
    const value = counters[key];
    if (typeof value === 'number' && value > 0) {
      return true;
    }
  }
  return false;
}

/** An iteration's `type`, when it states one. */
function iterationType(iteration: unknown): string | null {
  if (iteration == null || typeof iteration !== 'object') {
    return null;
  }
  const type = (iteration as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

/**
 * The context size a transcript RECORD describes, or null when the record is
 * not a usable context reading.
 *
 * This is the selector every reader goes through; `contextTokensFromUsage` is
 * only the raw arithmetic underneath it.
 *
 * WHY IT IS NOT JUST THE ARITHMETIC (home-base-fjcp): a server-side tool — the
 * `advisor` — runs inside a single assistant record, and Claude Code records
 * that record's top-level usage as the SUM over every model turn the record
 * contains. The sum double-counts `cache_read_input_tokens`, so the totals read
 * roughly twice the real context. Measured on conductor session 5b9ad9b0
 * (2026-09-12): the advisor record totalled 4 / 16,115 / 325,748 = 341,867 while
 * the session's real context was ~172k, and the hook duly fired a wrap-up
 * directive at a threshold the session had not remotely reached.
 *
 * THE OBVIOUS FIX DOES NOT WORK, so do not "simplify" this into it: an advisor
 * exchange is not one record but SEVEN consecutive ones sharing a `message.id`,
 * and while the middle ones carry `server_tool_use` and `advisor_tool_result`
 * content blocks, the LAST one carries a plain `tool_use` block and nothing
 * else. Filtering on content blocks leaves that final record — the one nearest
 * the tail, and therefore the one a backwards scan finds first — still reporting
 * 341,867.
 *
 * WHAT WORKS is `usage.iterations`, the per-turn breakdown the sum is built
 * from. Verified across the whole of that transcript: 314 assistant records
 * carry `[message]` and 14 carry `[message, advisor_message, message]`, with no
 * other combination present. When the breakdown shows several turns we read the
 * LAST one, which is the session's context as that record ended — 2 + 3,059 +
 * 169,402 = 172,463 on the evidence record, against 174,554 on the next clean
 * record, so the two agree to within one turn's growth. Reading the last turn
 * rather than discarding the record keeps the measurement current instead of
 * stale, and needs no knowledge of what the foreign turn in the middle was.
 *
 * NULL IS RETURNED, NEVER A GUESS, when the last turn carries no usable
 * `input_tokens`, when the only turn present is a foreign one (there is then no
 * turn of ours to read), and when the server-tool counters fire. The caller
 * keeps scanning backwards; if nothing clean is ever found the context stays
 * unmeasured, which is a different fact from zero and is reported as such.
 */
export function contextTokensFromRecordUsage(usage: unknown): number | null {
  if (usage == null || typeof usage !== 'object') {
    return null;
  }
  const fields = usage as Record<string, unknown>;

  if (usageHasServerToolCalls(fields)) {
    return null;
  }

  const iterations = fields.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    const last = iterations[iterations.length - 1];
    const lastType = iterationType(last);
    if (lastType != null && lastType !== ITERATION_TYPE_MODEL_TURN) {
      // The record ends on somebody else's turn, so it holds no reading of
      // ours — including the single-iteration case, where the top-level totals
      // would BE that foreign turn.
      return null;
    }
    if (iterations.length > 1) {
      // Several turns: the top-level sum double-counts, the last turn does not.
      return contextTokensFromUsage(last);
    }
  }

  return contextTokensFromUsage(fields);
}

/** Every string an attachment's `content` field might be carrying. */
function attachmentStrings(entry: Record<string, unknown>): string[] {
  const attachment = entry.attachment as {content?: unknown} | undefined;
  const content = attachment?.content;
  if (typeof content === 'string') {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.filter((part): part is string => typeof part === 'string');
  }
  return [];
}

interface ScanState {
  contextTokens: number | null;
  lastAnnouncedSetpoint: number | null;
  lastNoticeHadWrapUp: boolean | null;
}

/**
 * Whether the notice whose `notice-at=` token ends at `tokenEnd` in `content`
 * carried the wrap-up directive (home-base-o5atv.2.1 E1, E2).
 *
 * formatNotice writes the directive as the line right after the token's line,
 * and every notice ever written puts it there (verified 2026-11-08 against a
 * real player transcript, where both `hook_additional_context` and
 * `hook_system_message` hold `(notice-at=350000)\nWrap up your session …`). So
 * this reads THAT line and asks whether it starts with WRAP_UP_OPENING. It does
 * not search the whole string: the hook dispatcher joins every handler's text
 * on one event with a blank line (hook-output.ts), so another handler's words
 * could follow an FYI notice in the same string.
 *
 * No new I/O (E6): `content` is the text the scan already holds.
 */
function noticeCarriesWrapUp(content: string, tokenEnd: number): boolean {
  const lineBreak = content.indexOf('\n', tokenEnd);
  return lineBreak !== -1 && content.startsWith(WRAP_UP_OPENING, lineBreak + 1);
}

/**
 * Scan one window of transcript text backwards, filling in whatever is still
 * unknown. Mutates `state` so successive (larger) windows can extend a scan.
 *
 * Two entry shapes matter, both verified against real transcripts:
 *   - assistant entries carry `message.usage`.
 *   - our own notices land as `type: "attachment"`, where the model-facing copy
 *     is `attachment.type "hook_additional_context"` with content as a STRING
 *     ARRAY and the Justin-facing copy is `"hook_system_message"` with content
 *     as a STRING. Either dates the notice equally, so both are accepted and
 *     `hookEvent` is deliberately NOT filtered on — we now fire from two
 *     different events, and a filter would have to be updated for a third.
 *
 * `scope` says WHICH conversation this file is: 'session' for a top-level
 * transcript, where sidechain records belong to somebody else, and 'subagent'
 * for a subagents/agent-<id>.jsonl file, where they are the whole point.
 */
function scanWindow(
  text: string,
  state: ScanState,
  scope: MeasurementScope,
): void {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (state.contextTokens != null && state.lastAnnouncedSetpoint != null) {
      return;
    }
    const line = lines[i];
    if (line == null || line.length === 0) {
      continue;
    }

    // Cheap pre-filter: skip JSON.parse for lines that can't be either target.
    const maybeAssistant =
      state.contextTokens == null && line.includes('"assistant"');
    const maybeNotice =
      state.lastAnnouncedSetpoint == null && line.includes(USAGE_CHECK_MARKER);
    if (!maybeAssistant && !maybeNotice) {
      continue;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A partially-written trailing line is normal on a live file.
    }

    // A subagent's context is not this session's — UNLESS the subagent IS the
    // subject. Measured 2026-09-04: every record in a subagent transcript
    // carries isSidechain:true (170/170 in the sample), so keeping this filter
    // on that file would skip the entire file and report UNKNOWN forever.
    if (scope === 'session' && entry.isSidechain === true) {
      continue;
    }

    if (maybeAssistant && entry.type === 'assistant') {
      const message = entry.message as {usage?: unknown} | undefined;
      // NOT `contextTokensFromUsage` — a record containing a server-tool turn
      // needs its per-turn breakdown read instead of its double-counted totals
      // (home-base-fjcp). Null means "this record is not a reading", and the
      // scan simply keeps walking back.
      const tokens = contextTokensFromRecordUsage(message?.usage);
      if (tokens != null) {
        state.contextTokens = tokens;
      }
    }

    if (maybeNotice && entry.type === 'attachment') {
      for (const content of attachmentStrings(entry)) {
        if (!content.includes(USAGE_CHECK_MARKER)) {
          continue;
        }
        const match = SETPOINT_TOKEN.exec(content);
        if (match?.[1] != null) {
          // Both from this one string, together (E1): readTranscriptFacts stops
          // once it has a setpoint, so the flag must come from the same record.
          state.lastAnnouncedSetpoint = Number(match[1]);
          state.lastNoticeHadWrapUp = noticeCarriesWrapUp(
            content,
            match.index + match[0].length,
          );
          break;
        }
      }
    }
  }
}

/** The window the escalating scan starts from, and its growth cap per step. */
const INITIAL_WINDOW_BYTES = 1024 * 1024;

/**
 * Read the transcript tail, growing the window until the facts are known or
 * the file is exhausted.
 *
 * The hunt for a prior notice is skipped entirely when the measured context is
 * below the lowest setpoint, because no notice could be due either way. That
 * matters: the one case that can force a full-file read is a session that has
 * never announced, and it terminates immediately — with the context above the
 * lowest setpoint and no prior notice, a notice is ALWAYS due, so the marker
 * lands near the tail and every later call is a 1MB read again.
 */
export function readTranscriptFacts(args: {
  initialWindowBytes?: number;
  lowestSetpoint: number;
  /** Defaults to 'session' — the shape every caller had before 1r6d.23. */
  scope?: MeasurementScope;
  transcriptPath: string;
}): TranscriptFacts {
  const state: ScanState = {
    contextTokens: null,
    lastAnnouncedSetpoint: null,
    lastNoticeHadWrapUp: null,
  };
  let windowBytes = args.initialWindowBytes ?? INITIAL_WINDOW_BYTES;
  let reachedStart = false;

  for (;;) {
    const window = readTailWindow(args.transcriptPath, windowBytes);
    if (window == null) {
      // I/O failure: report what we have, and that we did NOT reach the start.
      return {...state, reachedStart: false};
    }
    reachedStart = window.reachedStart;
    scanWindow(window.text, state, args.scope ?? 'session');

    const needContext = state.contextTokens == null;
    const needSetpoint =
      state.lastAnnouncedSetpoint == null &&
      state.contextTokens != null &&
      state.contextTokens >= args.lowestSetpoint;
    if (reachedStart || (!needContext && !needSetpoint)) {
      return {...state, reachedStart};
    }
    windowBytes *= 2;
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Why a notice fires. 'wrap-up' is a notice that fires for no other reason
 * than that the context is at or past `wrapUpAt` and the last notice did not
 * say so (home-base-o5atv.2.1 E3).
 */
export type FireReason = 'first' | 'ascend' | 're-arm' | 'wrap-up';

export interface UsageDecision {
  contextTokens: number;
  reason: FireReason;
  /** The setpoint being announced: the highest one at or below the context. */
  setpoint: number;
  /** Whether to append the wrap-up directive (see wrapUpDirectiveFor). */
  wrapUp: boolean;
}

function highestAtOrBelow(setpoints: number[], value: number): number | null {
  let best: number | null = null;
  for (const setpoint of setpoints) {
    if (setpoint <= value) {
      best = setpoint;
    }
  }
  return best;
}

function lowestAbove(setpoints: number[], value: number): number | null {
  for (const setpoint of setpoints) {
    if (setpoint > value) {
      return setpoint;
    }
  }
  return null;
}

/**
 * Decide whether a notice is due. See the file header for the re-arm rule.
 *
 * Returns null (silent) whenever the context has not reached the lowest
 * setpoint, when the ladder has not advanced, and when a shrink is too small
 * to read as a compaction — unless the context is at or past `wrapUpAt` and the
 * last notice did not carry the directive, which fires 'wrap-up' once
 * (home-base-o5atv.2.1 E3). The same rule holds for both roles (E5): `config`
 * is already the role's.
 */
export function decide(args: {
  config: ResolvedUsageCheckConfig;
  contextTokens: number;
  lastAnnouncedSetpoint: number | null;
  /**
   * Whether the notice that named `lastAnnouncedSetpoint` carried the wrap-up
   * directive (TranscriptFacts.lastNoticeHadWrapUp). Required, not optional,
   * so no caller can drop it and silently lose E3. Only `false` can fire
   * 'wrap-up': null (no notice, or not known) stays silent, as unknown state
   * always does here (E4).
   */
  lastNoticeHadWrapUp: boolean | null;
}): UsageDecision | null {
  const {config, contextTokens, lastAnnouncedSetpoint, lastNoticeHadWrapUp} =
    args;
  const setpoint = highestAtOrBelow(config.setpoints, contextTokens);
  if (setpoint == null) {
    return null;
  }

  const wrapUp = config.wrapUpAt != null && contextTokens >= config.wrapUpAt;
  const fire = (reason: FireReason): UsageDecision => ({
    contextTokens,
    reason,
    setpoint,
    wrapUp,
  });

  if (lastAnnouncedSetpoint == null) {
    return fire('first');
  }

  const nextUp = lowestAbove(config.setpoints, lastAnnouncedSetpoint);
  if (nextUp != null && contextTokens >= nextUp) {
    return fire('ascend');
  }

  if (contextTokens < lastAnnouncedSetpoint * (1 - config.reArmDropFraction)) {
    return fire('re-arm');
  }

  // E3: past the threshold, and the session has not been told. `wrapUp` is
  // true only when wrapUpAt is a number and the context has reached it, and
  // wrapUpAt is a rung of the ladder, so `setpoint` is at or above it. The
  // notice this fires carries the directive; the next evaluation reads it back
  // as told and stays silent.
  if (wrapUp && lastNoticeHadWrapUp === false) {
    return fire('wrap-up');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Thousands separators, hand-rolled. `toLocaleString` would drag in ICU
 * behaviour that varies by runtime and locale, and this needs to be identical
 * everywhere so the tests mean something.
 */
export function formatTokens(value: number): string {
  const digits = Math.round(value).toString();
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    parts.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return parts.join(',');
}

/** Who the notice is about — see formatNotice. */
export interface NoticeSubject {
  /** `agent_type` from the hook payload ("player", "Explore", …), when given. */
  agentType?: string | null;
  scope: MeasurementScope;
}

/** The default subject: the top-level session, as it was before 1r6d.23. */
const SESSION_SUBJECT: NoticeSubject = {scope: 'session'};

/**
 * What the notice IS, said in the notice (home-base-y1hg0.22). Justin,
 * 2026-10-20: what the alert means is "this is the alert that was designed to
 * go off at/after 200k tokens", but "what the model interprets is 'you're past
 * your setpoint', which is wrong." A session did exactly that on 2026-10-19 and
 * handed itself off at 201,607 tokens.
 *
 * Left OUT when the wrap-up directive rides along: that directive is a real
 * instruction a config file asked for (D8, D6), and a notice saying "not a reason to
 * stop or hand off" one line above "Wrap up your session" would contradict it.
 */
export const NOTICE_FYI =
  'This is just an FYI: not a limit, and not a reason to stop or hand off.';

/**
 * The spacing of a ladder whose rungs are exactly 1x, 2x, 3x … of its first
 * rung (the generated default: 100k, 200k, 300k, …), or null for any other
 * shape.
 *
 * The notice names an interval only when this returns one, so it never says
 * "every 100,000 tokens" of a ladder that is not: a `wrapUpAt` of 350,000 folds
 * an extra rung in, and a project may hand-write irregular rungs. A one-rung
 * ladder fires once, so it has no interval either.
 */
export function regularLadderInterval(
  setpoints: readonly number[],
): number | null {
  const interval = setpoints[0];
  if (interval == null || setpoints.length < 2) {
    return null;
  }
  for (let rung = 0; rung < setpoints.length; rung += 1) {
    if (setpoints[rung] !== interval * (rung + 1)) {
      return null;
    }
  }
  return interval;
}

/**
 * The notice. One line carries the marker, whose number it is, when it fires,
 * that it is only an FYI (see NOTICE_FYI), and LAST the machine-readable
 * `notice-at=` token that a later run reads back as state — see
 * SETPOINT_TOKEN. The wrap-up directive, when due, is a second line.
 *
 * The word "setpoint" appears nowhere in it (home-base-y1hg0.22): a model read
 * it as a limit it had passed. The notice says instead that it fires at preset
 * token counts, which is all a rung is.
 *
 * "of context" is load-bearing wording: elsewhere in this SDK "usage" means
 * subscription QUOTA (`/usage`, ralph's usage gate), and the two numbers must
 * never be mistaken for each other.
 *
 * A SUBAGENT's notice says so explicitly and names its type (1r6d.23). The
 * disclaimer is not decoration: for a year this hook could only report the
 * parent's number, so a subagent reading "this session has used 400,000" had
 * every reason to think it was its own. Saying whose number it is, in the same
 * sentence as the number, is the whole point of the feature.
 *
 * `setpoints` is the ladder the decision was made on. It only decides whether
 * the notice can truthfully say "every N tokens" (see regularLadderInterval);
 * null leaves the interval out.
 *
 * `directive` is the second line when the wrap-up is due; runUsageCheck picks
 * it with wrapUpDirectiveFor.
 */
export function formatNotice(
  decision: UsageDecision,
  subject: NoticeSubject = SESSION_SUBJECT,
  setpoints: readonly number[] | null = null,
  directive: string = WRAP_UP_DIRECTIVE,
): string {
  const tokens = formatTokens(decision.contextTokens);

  let count: string;
  if (subject.scope === 'session') {
    count = `This session has now used ${tokens} tokens of context.`;
  } else {
    // agent_type is what Claude Code called the subagent ("player", "Explore").
    // Absent, "This subagent" still says the one thing that matters: not you.
    const who =
      subject.agentType == null || subject.agentType === ''
        ? 'This subagent'
        : `This ${subject.agentType} subagent`;
    count = `${who} has now used ${tokens} tokens of its OWN context, measured from its own transcript — this is your number, not the parent session's.`;
  }

  const interval = setpoints == null ? null : regularLadderInterval(setpoints);
  const every =
    interval == null ? '' : `, every ${formatTokens(interval)} tokens`;
  const cadence = `This notice fires at preset token counts${every} (this one at ${formatTokens(decision.setpoint)}).`;

  const parts = [USAGE_CHECK_MARKER, count, cadence];
  if (!decision.wrapUp) {
    parts.push(NOTICE_FYI);
  }
  parts.push(`(${NOTICE_TOKEN_NAME}=${decision.setpoint})`);

  const line = parts.join(' ');
  return decision.wrapUp ? `${line}\n${directive}` : line;
}

/**
 * Which wrap-up directive this reader gets (home-base-o5atv.1.1 D7):
 *  - A top-level session where `thread handoff` starts a successor
 *    (`handoffSuccessor`, resolveHandoffSuccessor): HANDOFF_WRAP_UP_DIRECTIVE,
 *    which names the rule and the call.
 *  - Any other session: WRAP_UP_DIRECTIVE, unchanged. `thread handoff` is
 *    named only where that knob is on (home-base-jm5kg.8).
 *  - A subagent, whatever the knob says: WRAP_UP_DIRECTIVE. A subagent never
 *    runs `thread handoff`; it reports to the session that dispatched it.
 */
export function wrapUpDirectiveFor(args: {
  handoffSuccessor: boolean;
  scope: MeasurementScope;
}): string {
  return args.scope === 'session' && args.handoffSuccessor
    ? HANDOFF_WRAP_UP_DIRECTIVE
    : WRAP_UP_DIRECTIVE;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface HookInput {
  /**
   * Present when and only when the tool call originated inside a subagent
   * (measured 2026-09-03: 61 of 102 PostToolUse rows on a conductor session
   * carried them, the other 41 being the conductor's own). Their PRESENCE is
   * the role discriminant; no heuristic is involved.
   */
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

/** The events this hook is wired to; anything else still echoes its own name. */
const DEFAULT_HOOK_EVENT = 'UserPromptSubmit';

/**
 * Run the hook. Always resolves 0 — a failing UserPromptSubmit hook can block
 * the prompt entirely, so every path here degrades to silence rather than
 * costing Justin a turn.
 *
 * On unmeasurable state (unreadable transcript, or a prior notice we could not
 * find because reads failed mid-scan) this stays SILENT rather than announcing.
 * That is the opposite of the usual "route missing evidence to the cautious
 * verdict" instinct, and it is deliberate: announcing on unknown state would
 * repeat on every tool batch for the rest of the session — unbounded spam that
 * would train Justin to ignore the one message that matters. A missed nudge
 * self-corrects at the next setpoint or the next successful read. The unknown
 * state is also near-unreachable, since the same failed read would already have
 * left the context unmeasured.
 *
 * THE ONE THING IT DOES SAY OUT LOUD is a subagent whose own transcript it
 * cannot find (1r6d.23). Silence there would be indistinguishable from "no
 * notice was due", and the tempting repair — measure the parent instead — is
 * the rule-6 violation this feature was built to remove. So that case writes a
 * diagnostic to STDERR, naming the path it looked for, and emits nothing on
 * stdout. stderr is the right channel: the hook still exits 0 and cannot block
 * a turn, the model's context is never touched (so a persistent misconfig
 * cannot become per-batch spam in the conversation), and the line is visible in
 * `claude --debug` and when the hook is run by hand with a crafted payload.
 */
export function runUsageCheck(args?: {
  /** Where the user config is looked up (XDG_CONFIG_HOME, HOME). Tests inject it. */
  env?: EnvLike;
  stdin?: string;
}): number {
  let input: HookInput = {};
  try {
    const raw = args?.stdin ?? readFileSync(0, 'utf8');
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as HookInput);
  } catch {
    return 0;
  }

  const projectRoot = input.cwd ?? process.cwd();
  const layers = readUsageCheckLayers(projectRoot, args?.env ?? process.env);
  if (layers.status === 'off') {
    return 0; // Not installed here, or explicitly disabled.
  }
  if (layers.userConfigProblem != null) {
    // D5: that layer is ignored and the repo's own block still applies. Said on
    // stderr only, like the UNKNOWN below: never stdout, so never the model's
    // context, and the hook still exits 0.
    console.error(
      `${USAGE_CHECK_MARKER} ignoring the user config, which could not be read: ${layers.userConfigProblem}`,
    );
  }

  // Presence of agent_id is the whole discriminant (see HookInput.agent_id).
  const role: UsageCheckRole =
    input.agent_id != null && input.agent_id !== '' ? 'player' : 'session';
  const config = resolveUsageCheckConfig(layers.config, role);
  if (config == null) {
    return 0; // Resolved to an empty ladder — nothing could ever fire.
  }

  const target = resolveMeasurementTarget({
    agentId: input.agent_id,
    transcriptPath: input.transcript_path,
  });
  if (target.kind === 'unknown') {
    if (input.agent_id != null && input.agent_id !== '') {
      // UNKNOWN, said out loud. Never a fallback to input.transcript_path.
      console.error(`${USAGE_CHECK_MARKER} UNKNOWN: ${target.reason}`);
    }
    return 0;
  }

  const facts = readTranscriptFacts({
    lowestSetpoint: config.setpoints[0]!,
    scope: target.kind,
    transcriptPath: target.path,
  });
  if (facts.contextTokens == null) {
    return 0;
  }
  if (facts.lastAnnouncedSetpoint == null && !facts.reachedStart) {
    return 0; // State unknown — see the doc comment.
  }

  const decision = decide({
    config,
    contextTokens: facts.contextTokens,
    lastAnnouncedSetpoint: facts.lastAnnouncedSetpoint,
    lastNoticeHadWrapUp: facts.lastNoticeHadWrapUp,
  });
  if (decision == null) {
    return 0;
  }

  const notice = formatNotice(
    decision,
    {agentType: input.agent_type, scope: target.kind},
    config.setpoints,
    wrapUpDirectiveFor({
      handoffSuccessor: layers.handoffSuccessor,
      scope: target.kind,
    }),
  );

  // Emit BOTH channels, exactly as time-check does and for the same reason:
  // `systemMessage` renders in Justin's terminal but never enters the model's
  // context, while `additionalContext` goes to the model and is invisible to
  // Justin. The model is the one that has to act on this; Justin is the one who
  // needs to know why it suddenly started wrapping up. The mirror is the shared
  // helper's job (home-base-39co9.4 M3).
  emitHookOutput({
    event: input.hook_event_name ?? DEFAULT_HOOK_EVENT,
    forClaude: notice,
  });
  return 0;
}
