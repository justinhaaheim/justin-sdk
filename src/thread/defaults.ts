/**
 * thread/defaults.ts — the thread component's default values, and nothing else.
 *
 * A LEAF on purpose (epic home-base-dchjw D3): `sdk-config.ts` renders these as
 * the printed defaults of `justin-sdk config schema`, and `thread/config.ts`
 * resolves against them. Left in `thread/config.ts`, which imports sdk-config,
 * that would be an import CYCLE — and a cycle whose consts are read at module
 * scope is a temporal-dead-zone crash waiting for a load-order change.
 *
 * They are NOT zod `.default()`s. A default filled in by the parser would
 * destroy the DEFAULT ← user file ← project file layering these knobs resolve
 * through: the project file would then always carry a value, and a knob set once
 * in the user file could never reach a repo whose config parsed at all.
 */

export const THREAD_CONFIG_KEY = 'thread';

/** Off unless something says otherwise (D6). */
export const THREAD_DEFAULT_ENABLED = false;

// NO DEFAULT FOR `startOnSessionStart`. It armed a SessionStart hook that
// created the thread bead before the session had done anything; since
// 2026-10-05 the bead is created on the first captured prompt instead, and the
// key is DEPRECATED and gates nothing (home-base-39co9 D1, D2). It stays in the
// schema (sdk-config.ts) only so configs that carry it keep parsing; a printed
// default would document a switch that no longer exists.

/**
 * Off unless something says otherwise (home-base-p1uj.15).
 *
 * This is the knob with the largest blast radius in the group, and the only one
 * that can take a turn away from Claude: with it on, the `Stop` hook installed
 * by `justin-sdk add thread-hooks` refuses to let a session finish on a report
 * it did not record. Everything else here changes what gets printed or written;
 * this changes whether a session may stop. It stays off until the hook has been
 * watched behave on real sessions, and it is resolved through the same
 * DEFAULT ← user ← project layering as the others so one line in the user file
 * arms it everywhere and one line in a repo's config disarms it there.
 */
export const THREAD_DEFAULT_ENFORCE = false;

/**
 * WHAT the armed Stop hook refuses (home-base-k0b8n.11, epic decision K12).
 *
 * `reportShaped` (the default, and the only behaviour before K12): a final
 * message carrying the report delimiters that was not recorded. `workTurns`
 * ALSO refuses a turn that did real work — a `git commit`, or a turn of at
 * least `enforceMinTurnMinutes` since Justin's last message — and yields
 * without a report archived since that message. It is the refusal EXPERIMENT:
 * stop-check had never blocked a session (measured 2026-09-23), because the
 * sessions that skip the tool end in plain prose. Only meaningful with
 * `enforce` on.
 */
export type ThreadEnforceMode = 'reportShaped' | 'workTurns';

export const THREAD_ENFORCE_MODES: readonly ThreadEnforceMode[] = [
  'reportShaped',
  'workTurns',
];

export const THREAD_DEFAULT_ENFORCE_MODE: ThreadEnforceMode = 'reportShaped';

/** A `workTurns` turn this long (minutes since Justin's last message) is work. */
export const THREAD_DEFAULT_ENFORCE_MIN_TURN_MINUTES = 20;

/**
 * ON unless something says otherwise (home-base-k0b8n.9, K10) — and gated by
 * `enabled`: capture runs only where BOTH are true, so a machine that never
 * turned threads on captures nothing. Capture is also what CREATES a session's
 * thread bead, on its first prompt (home-base-39co9 D1).
 *
 * Default TRUE because Justin asked for it by default (2026-09-23: "by default
 * all user messages and all claude yield messages are captured"). The `thread
 * capture` hook appends every prompt and every final Claude message of a
 * session to a local message log and keeps the thread bead's last messages
 * current without any `thread report`. The knob exists so ONE repo can opt out
 * with one line in its `justin-sdk.config.json`, not to arm something risky:
 * the log never leaves this machine, and the bead write happens in a detached
 * child that never delays a turn.
 */
export const THREAD_DEFAULT_CAPTURE = true;

/**
 * OFF unless something says otherwise (status report v4, epic
 * home-base-vzwbj.4 D6; built by home-base-vzwbj.4.1, 2026-10-11).
 *
 * With it on, the capture hook ALSO files a `session` bead in the repo's own
 * beads workspace on a session's first captured prompt, records it in the
 * sessions index, and injects one context line on every prompt; `thread
 * request` and `thread title` work. With it off nothing of that happens
 * anywhere — the ~/Dev/threads thread bead is written either way. It rides on
 * capture, so it does nothing unless `enabled` and `capture` are on too.
 */
export const THREAD_DEFAULT_SESSION_BEADS = false;

/**
 * Whether `thread nudge` (a PostToolUse hook on Bash, home-base-vzwbj.4.4,
 * epic D3) tells Claude — once per turn — that it committed while no request
 * is in progress for its session. DEFAULT TRUE, but it acts only when
 * `sessionBeads` is on as well, so it costs nothing until v4 is switched on.
 * Never blocks.
 */
export const THREAD_DEFAULT_NUDGE = true;

/**
 * Whether a session names its cmux workspace "[REPO] <session title>"
 * (home-base-j8q3e.5 D6). Off until Justin has read the preview and turns it
 * on (feature-knobs rule).
 */
export const THREAD_DEFAULT_NAME_WORKSPACES = false;

/**
 * Whether a session keeps its title a short summary of the whole conversation
 * (home-base-ys9t7.9.1): `thread status` asks for a refresh when requests were
 * filed after the title was last set, the title-set time is recorded on the
 * session bead, and a successor is asked to extend its predecessor's summary.
 * Off until Justin turns it on (feature-knobs rule).
 */
export const THREAD_DEFAULT_TITLE_SUMMARY = false;

/**
 * Repo folder names that `thread inbox --by-repo` and the threads TUI's "by
 * repo" grouping list first, in this order (home-base-yukaf.9, D-PINS). Not a
 * feature gate: it only reorders groups. Default none.
 */
export const THREAD_DEFAULT_PINNED_PROJECTS: readonly string[] = [];

/**
 * How far back `thread open` looks when neither --since nor --days is given
 * (home-base-yukaf.22; D-CUTOFF's 7 days). A number and h, d or w: `24h`,
 * `3d`, `2w`. Not a feature gate: it only sets the default window.
 */
export const THREAD_DEFAULT_OPEN_SINCE = '7d';

/**
 * How far a request can get, in order (status report v4, epic
 * home-base-vzwbj.4 D1 "STAGES"; built by home-base-vzwbj.4.3). `thread stage
 * <request> <name>` labels the request `stage:<name>`, and Part 1 shows the
 * highest one reached and the next. A name outside this ladder is refused.
 * Not a feature gate: it only names the rungs.
 */
export const THREAD_DEFAULT_STAGES: readonly string[] = [
  'code-done',
  'tested',
  'built',
  'link-sent',
  'approved',
];

/**
 * ON unless something says otherwise (home-base-p1uj.11) — the one knob here
 * whose default is true.
 *
 * It can be, because it is not a feature gate: threads now live in their own
 * repo whose only writer is this tool, so committing after a write is simply
 * finishing the write. The knob exists to turn the commit OFF for someone who
 * wants to batch them (or whose threads repo is not a git repo at all), not to
 * arm something risky. D13 — "the tool does not commit" — was retracted with
 * the move, because the hazard it named was racing ~/Dev/life's index, and
 * there is no longer another writer to race.
 */
export const THREAD_DEFAULT_AUTO_COMMIT = true;

/**
 * ON unless something says otherwise (home-base-p1uj.20, D22) — the second knob
 * here whose default is true, and for the same reason as `autoCommit`.
 *
 * The threads repo got a private remote on 2026-09-15, and pushing is how the
 * commit stops being a backup that only exists on one laptop. It is not a
 * feature gate: nothing new becomes possible when it is on, and the failure it
 * can produce is a warning about a push, never a lost report. It is a knob at
 * all so a machine that should stay local — a clone with no remote, a laptop on
 * a metered connection, a debugging run that should not touch the network — can
 * say so in one line, and so the whole behaviour can be turned off without
 * turning off the commit it follows.
 */
export const THREAD_DEFAULT_AUTO_PUSH = true;

/**
 * ON unless something says otherwise (home-base-p1uj.14, D19).
 *
 * Also not a feature gate: it picks between two spellings of the same header.
 * True is the shorter one Justin asked for on 2026-09-14 — emoji-prefixed values
 * with no field titles — and false restores the titled fields for anywhere the
 * emoji do not render (a log file, a pipe into something that strips them).
 */
export const THREAD_DEFAULT_EMOJI_HEADER = true;

/**
 * Which UI `thread answer` puts in front of Justin (home-base-p1uj.12).
 *
 * `ink` is a REAL member of this union even though no Ink UI ships, and that is
 * deliberate. The bead named three values; the spike measured Ink and rejected
 * it (no maintained multi-line editor exists for it — the verdict with its
 * numbers is in the bead's notes). Accepting `ink` and silently running
 * something else would be the reassuring kind of wrong, and dropping it from the
 * union would turn a considered rejection into a typo. So it parses, and
 * `thread answer` refuses it in one line that names the verdict.
 */
export type ThreadAnswerUi = 'classic' | 'ink' | 'web';

/** The spike winner (home-base-p1uj.12). */
export const THREAD_DEFAULT_ANSWER_UI: ThreadAnswerUi = 'web';

export const THREAD_ANSWER_UIS: readonly ThreadAnswerUi[] = [
  'classic',
  'ink',
  'web',
];

/**
 * Which dashboard `thread dashboard` opens (home-base-yukaf.11, D-WEB).
 *
 * `tui` is the full-screen terminal dashboard (`bun run threads` in
 * home-base). `web` is the EXPERIMENT: a page on 127.0.0.1 whose buttons run
 * the same commands the TUI's keys run. Default `tui` until Justin has tried
 * the page (feature-knobs rule); `--web` / `--tui` override it per run.
 */
export type ThreadDashboardUi = 'tui' | 'web';

export const THREAD_DEFAULT_DASHBOARD_UI: ThreadDashboardUi = 'tui';

export const THREAD_DASHBOARD_UIS: readonly ThreadDashboardUi[] = [
  'tui',
  'web',
];

// ---------------------------------------------------------------------------
// componentConfig.thread.handoff (epic home-base-mbnjv C1)
// ---------------------------------------------------------------------------

/**
 * What happens to the handed-off session's tab once its successor has linked
 * (epic home-base-mbnjv D6): `keep` leaves it running, `exit` ends Claude Code
 * there and leaves a tombstone, `close` closes the tab.
 */
export const HANDOFF_PREDECESSOR_MODES = ['keep', 'exit', 'close'] as const;

export type HandoffPredecessorMode = (typeof HANDOFF_PREDECESSOR_MODES)[number];

/**
 * The `--permission-mode` choices of the installed claude (2.1.312, measured
 * 2026-10-29 by the epic's conductor). The successor gets one explicitly (D7).
 */
export const HANDOFF_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;

export type HandoffPermissionMode = (typeof HANDOFF_PERMISSION_MODES)[number];

/**
 * The handoff knob's defaults (C1). `successor: false` is the feature knob
 * (D10): off, `thread handoff` behaves exactly as it did before the epic.
 *
 * `maxLiveSessions` was set from a measurement on Justin's machine
 * (home-base-mbnjv.1 notes, 2026-10-29): the number and the reasoning live
 * there, not here, because they go stale.
 */
export const HANDOFF_DEFAULTS = {
  maxLiveSessions: 25,
  maxUnattendedHandoffs: 3,
  permissionMode: 'auto' as HandoffPermissionMode,
  predecessor: 'keep' as HandoffPredecessorMode,
  successor: false,
  usage: {
    maxSampleAgeMinutes: 150,
    maxSessionPercent: 85,
    maxWeekPercent: 90,
  },
} as const;

// ---------------------------------------------------------------------------
// componentConfig.thread.quota (request home-base-ys9t7.5, D5)
// ---------------------------------------------------------------------------

/**
 * What the spend quota does (D5): `off` computes nothing, `observe` computes
 * every verdict and logs what it would have refused, `enforce` refuses and
 * denies. The verdict itself never reads the mode; its callers do.
 */
export const QUOTA_MODES = ['off', 'observe', 'enforce'] as const;

export type QuotaMode = (typeof QUOTA_MODES)[number];

/** The model families a quota rate is set for (D1). */
export const QUOTA_RATE_FAMILIES = [
  'fable',
  'opus',
  'sonnet',
  'other',
] as const;

export type QuotaRateFamily = (typeof QUOTA_RATE_FAMILIES)[number];

/**
 * The quota's defaults (D5). `mode: 'off'` is the feature knob
 * (feature-knobs rule). The dollar rates were fitted against the session-cost
 * estimator by `claude-usage calibrate` on 2026-10-30 (home-base-ys9t7.5.1):
 * list-price dollars per 1 % of Justin's week, per model family. `other`
 * (haiku and any other priced family) takes the most expensive per percent,
 * fable's, so an unfitted family is never undercounted.
 */
export const QUOTA_DEFAULTS = {
  attendedGraceMinutes: 30,
  chainWeekPercent: 5,
  dollarsPerWeekPercent: {
    fable: 12.9,
    opus: 32.3,
    other: 12.9,
    sonnet: 16.8,
  },
  floorWeekPercent: 75,
  mode: 'off' as QuotaMode,
  projectDayWeekPercent: 10,
  recheckSeconds: 60,
} as const;
