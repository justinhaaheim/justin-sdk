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
 * `componentConfig.husky.tsCheckInHook` (home-base-lzvh D3). Read by the husky
 * INSTALLER, not by the hook: true adds or updates the SDK's marked type-check
 * block in `.husky/pre-commit`, false adds nothing and updates nothing. It
 * decides what the next install or sweep of the husky component writes, never
 * what an already-installed hook does.
 *
 * The default was set by the measurement gate in the bead's acceptance
 * criteria (criterion 7): true only if a real commit in clones of all six
 * TypeScript consumer repos refused a type error, let a clean change through,
 * and spent at most 10 s more on it. Measured 2026-11-07 with
 * `bun run measure:pre-commit-ts-check`, in `--no-hardlinks` clones, load
 * average 10 to 11: true. All six refused a staged type error and let two
 * clean commits through. In imessage-exporter and userscripts-j (a tsconfig.json
 * and no .ts file) the clean commits passed with the "no TypeScript files
 * (TS18003)" line of D2 step 5, and a new .ts file with a type error was
 * refused with a real TS2322. The slowest, browser-automation-central, added
 * 3.0 s warm. (A first run without step 5 refused every clean commit in those
 * two repos, so the default was false until step 5 landed.)
 */
export const TS_CHECK_IN_HOOK_DEFAULT = true;

/**
 * Where the last green type-check is recorded, relative to the checkout's git
 * dir (`git rev-parse --git-path`). Per checkout, because a green check in one
 * worktree says nothing about another's working tree; inside the git dir,
 * because a sandboxed Claude Code commit can write there (it writes the index
 * lock beside it) while ~/.local/state is write-denied to it, and because the
 * stamp then goes away with the worktree.
 */
export const LAST_GREEN_STAMP_GIT_PATH = 'justin-sdk/ts-check-last-green.json';
