/**
 * pre-commit-ts-check/defaults.ts — the knob's names and default values, and
 * nothing else (home-base-pp1vx.1.2).
 *
 * A LEAF on purpose, like thread/defaults.ts: `sdk-config.ts` prints these as
 * the defaults of `justin-sdk config schema`, and gate.ts resolves against
 * them. Kept in a module that imports sdk-config, they would form an import
 * cycle whose consts are read at module scope.
 */

/** The `componentConfig` block these knobs live in: the husky-setup component's. */
export const HUSKY_CONFIG_KEY = 'husky';

/**
 * `componentConfig.husky.tsCheckOnCommit`. "always" is today's behaviour: the
 * hook's type-check command runs on every commit. "onlyWhenTsStaged" skips it
 * when no staged path can affect type-checking, subject to the regular full
 * check below.
 */
export const TS_CHECK_ON_COMMIT_MODES = ['always', 'onlyWhenTsStaged'] as const;
export type TsCheckOnCommitMode = (typeof TS_CHECK_ON_COMMIT_MODES)[number];

/** OFF by default (feature-knobs rule): every commit type-checks, as before. */
export const TS_CHECK_ON_COMMIT_DEFAULT: TsCheckOnCommitMode = 'always';

/**
 * `componentConfig.husky.fullTsCheckEveryHours`. With the knob on, a commit
 * that would skip the type-check runs it anyway when this checkout has no
 * green type-check recorded within this many hours. That is the guaranteed
 * regular full check Justin asked for (2026-10-26).
 */
export const FULL_TS_CHECK_EVERY_HOURS_DEFAULT = 24;

/**
 * Where the last green type-check is recorded, relative to the checkout's git
 * dir (`git rev-parse --git-path`). Per checkout, because a green check in one
 * worktree says nothing about another's working tree; inside the git dir,
 * because a sandboxed Claude Code commit can write there (it writes the index
 * lock beside it) while ~/.local/state is write-denied to it, and because the
 * stamp then goes away with the worktree.
 */
export const LAST_GREEN_STAMP_GIT_PATH = 'justin-sdk/ts-check-last-green.json';
