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

/**
 * Off unless something says otherwise (home-base-p1uj.3).
 *
 * A SECOND knob rather than a reuse of `enabled`, deliberately. `enabled` is
 * the preflight branch point a human-driven wrap-up reads; `startOnSessionStart`
 * arms a HOOK that fires on every session start and every resume, in every repo
 * that installed it, and turns each one into a Dolt write. Those two want
 * different blast radii: Justin can dogfood `thread prepare`/`report` by hand
 * for a week before he is willing to pay a bd round-trip at the top of every
 * session. Folding them together would make the cheap decision imply the
 * expensive one.
 */
export const THREAD_DEFAULT_START_ON_SESSION_START = false;

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
 * `enabled` like `startOnSessionStart` is: capture runs only where BOTH are
 * true, so a machine that never turned threads on captures nothing.
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
