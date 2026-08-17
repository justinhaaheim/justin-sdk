/**
 * rules-update — the PULL channel for the committed per-repo rules artifact
 * (home-base-q1hp, t6a0.21 D2b/D4/D5).
 *
 * Regenerates `.claude/rules/justin-sdk/critical-rules.md` from the managed
 * prompts clone and commits it ON THE CURRENT BRANCH of the CURRENT checkout.
 * No merge, no push, no branch switching, ever — the sweep is the push channel
 * (D2a); this is what a human or an agent runs in the repo it is already sitting
 * in, mid-session, to pick up a rules change.
 *
 * THE COMMIT IS RULES-ONLY, AND THAT IS ENFORCED TWICE. The write comes from
 * `refreshCriticalRulesArtifact`, which by construction touches only the
 * artifact path (no config rewrite, no SDK pin — that is why the refresh layer
 * exists separately from the installer), and both git calls are path-limited to
 * `.claude/rules/justin-sdk`: `git add -- <dir>` stages nothing else, and
 * `git commit -m … -- <dir>` builds the commit from those paths alone, so even
 * changes the user had already STAGED elsewhere stay staged and uncommitted
 * (measured, not assumed). The folder is tool-owned by contract (D2b), so
 * pre-existing dirt underneath it — an edited artifact, a stale sibling file, a
 * deletion — is absorbed into this commit rather than left behind for someone
 * else to explain.
 *
 * PRECONDITIONS ARE CHECKED BEFORE THE WRITE, in this order, each with its own
 * exit code:
 *   1. enrolment (a read) — first, so a repo that simply is not enrolled gets
 *      told that instead of something about git;
 *   2. git state — refusing AFTER writing would leave an uncommitted generated
 *      file behind, which is precisely the mess this command exists to avoid;
 *   3. the refresh itself, which refuses on a stale clone (D15).
 *
 * WHY MID-OPERATION IS A REFUSAL (the c2u5 lesson): a tool that writes and
 * commits during a half-finished merge/rebase/cherry-pick is how a conflict
 * resolution gets silently truncated or a rebase lands a commit on the wrong
 * base. Finishing or aborting is a human decision; this command declines to make
 * it.
 */

import {execFileSync} from 'child_process';
import {existsSync} from 'fs';
import {join} from 'path';

import {
  readSelectedModules,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
} from './critical-rules-setup';
import {PROJECT_RULES_SEGMENTS} from './plugin/lib/rules-file';
import {fail, setQuiet, success} from './setup-helpers';

/**
 * One exit code per fact. A caller (a human, `si46`'s notice, a script) must be
 * able to tell "not enrolled" from "offline" from "your tree is mid-rebase"
 * without parsing prose, and none of them may be confusable with success.
 */
export const RULES_UPDATE_EXIT = {
  ok: 0,
  notEnrolled: 1,
  /** The prompts clone could not be refreshed — nothing was written (D15). */
  cannotRefresh: 2,
  notARepo: 3,
  operationInProgress: 4,
  detachedHead: 5,
  /** Config/selection/assembly is broken — a content fault, not a source fault. */
  assemblyFailed: 6,
  /** The write succeeded but git add/commit did not. */
  commitFailed: 7,
} as const;

/** The tool-owned directory, as a git pathspec (derived, so it cannot drift). */
export const RULES_PATHSPEC = PROJECT_RULES_SEGMENTS.slice(0, -1).join('/');

// ---------------------------------------------------------------------------
// git helpers — argv form only, never a shell-interpolated string
// ---------------------------------------------------------------------------

function git(dir: string, argv: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

interface GitRun {
  ok: boolean;
  stderr: string;
}

/** Like `git`, but keeps stderr so a failure can be reported verbatim. */
function gitRun(dir: string, argv: string[]): GitRun {
  try {
    execFileSync('git', ['-C', dir, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {ok: true, stderr: ''};
  } catch (error) {
    const err = error as {stderr?: string; stdout?: string; message?: string};
    const text = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim();
    return {ok: false, stderr: text.length > 0 ? text : (err.message ?? '')};
  }
}

/**
 * In-progress-operation markers, checked inside `--git-dir`.
 *
 * `--git-dir` and NOT `--git-common-dir`: in a linked worktree the former is
 * `…/.git/worktrees/<name>`, which is where that worktree's own MERGE_HEAD
 * lives — measured. Reading the common dir would ask about a DIFFERENT
 * checkout's state.
 */
const IN_PROGRESS_MARKERS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['REBASE_HEAD', 'a rebase'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or `git am`'],
];

export type GitState =
  | {ok: true; branch: string}
  | {ok: false; code: number; message: string};

/**
 * Is this checkout in a state where committing one file is a safe, meaningful
 * act — and if so, which branch would it land on?
 *
 * The in-progress check runs BEFORE the detached-HEAD check on purpose: git
 * detaches HEAD for the duration of a rebase (measured), so the branch check
 * would report "detached HEAD" for a tree whose actual problem — and actual fix
 * — is the rebase.
 */
export function describeGitState(dir: string): GitState {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (gitDir == null || gitDir.length === 0) {
    return {
      code: RULES_UPDATE_EXIT.notARepo,
      message:
        `${dir} is not inside a git repository — rules-update regenerates AND commits the artifact, ` +
        `so there has to be one. Use \`add critical-rules\` to write the file without committing.`,
      ok: false,
    };
  }

  for (const [marker, what] of IN_PROGRESS_MARKERS) {
    if (existsSync(join(gitDir, marker))) {
      return {
        code: RULES_UPDATE_EXIT.operationInProgress,
        message:
          `${what} is in progress (${marker} present in ${gitDir}) — refusing to write or commit mid-operation. ` +
          `Finish it, or abort it (git merge --abort / git rebase --abort / git cherry-pick --abort), then re-run.`,
        ok: false,
      };
    }
  }

  const branch = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch == null || branch.length === 0) {
    return {
      code: RULES_UPDATE_EXIT.detachedHead,
      message:
        `HEAD is detached in ${dir} — rules-update commits on the CURRENT branch and will not create one. ` +
        `Check out a branch (\`git switch <branch>\`), then re-run.`,
      ok: false,
    };
  }
  return {branch, ok: true};
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface RulesUpdateOptions {
  /** Defaults to the cwd. */
  projectRoot?: string;
  /** Regenerate even when the content hash says the artifact is current. */
  force?: boolean;
  quiet?: boolean;
  /** Stamp date (YYYY-MM-DD) — injectable so tests can pin the bytes. */
  now?: string;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
}

export function runRulesUpdate(options: RulesUpdateOptions = {}): number {
  const projectRoot = options.projectRoot ?? process.cwd();
  setQuiet(options.quiet ?? false);

  // 1. Enrolment. Uses the ONE selection reader (uniformity: the refresh layer
  //    reads the same function, so "enrolled" cannot mean two things).
  const selection = readSelectedModules(projectRoot);
  if (!selection.ok) {
    fail(`rules-update: ${selection.message}`);
    return selection.status === 'not-enrolled'
      ? RULES_UPDATE_EXIT.notEnrolled
      : RULES_UPDATE_EXIT.assemblyFailed;
  }

  // 2. Git state — before anything is written.
  const state = describeGitState(projectRoot);
  if (!state.ok) {
    fail(`rules-update: ${state.message}`);
    return state.code;
  }

  // 3. The write. Touches only the artifact path; refuses on a stale clone.
  const outcome = refreshCriticalRulesArtifact(projectRoot, {
    force: options.force,
    now: options.now,
    promptsDir: options.promptsDir,
  });
  if (!refreshSucceeded(outcome)) {
    // refreshCriticalRulesArtifact already printed the reason.
    switch (outcome.status) {
      case 'not-enrolled':
        return RULES_UPDATE_EXIT.notEnrolled;
      case 'cannot-refresh':
        return RULES_UPDATE_EXIT.cannotRefresh;
      default:
        return RULES_UPDATE_EXIT.assemblyFailed;
    }
  }

  const shaShort =
    outcome.sourceSha != null ? outcome.sourceSha.slice(0, 12) : 'unknown';

  if (outcome.status === 'unchanged') {
    // The scoped contract (D2b): unchanged means NO commit. Note that dirt
    // sitting under the tool-owned folder is therefore left alone here — it is
    // absorbed only by a commit this command actually makes, and `--force`
    // is the way to make one deliberately.
    success(
      `rules-update: already up to date (prompts ${shaShort}, content ${outcome.contentHash}) — nothing committed`,
    );
    return RULES_UPDATE_EXIT.ok;
  }

  // 4. Stage + commit, path-limited on both calls.
  const add = gitRun(projectRoot, ['add', '--', RULES_PATHSPEC]);
  if (!add.ok) {
    fail(
      `rules-update: wrote ${outcome.file} but \`git add -- ${RULES_PATHSPEC}\` failed — ` +
        `nothing was committed. Is the path gitignored?\n  ${add.stderr}`,
    );
    return RULES_UPDATE_EXIT.commitFailed;
  }

  // A regeneration can be byte-identical to HEAD (a --force re-run on the same
  // day, or a reverted hand edit). `git commit` would exit non-zero on an empty
  // commit, and reporting that as a failure would be a lie — it is a distinct,
  // successful state.
  const nothingStaged =
    git(projectRoot, [
      'diff',
      '--cached',
      '--quiet',
      '--',
      RULES_PATHSPEC,
    ]) != null;
  if (nothingStaged) {
    success(
      `rules-update: regenerated ${outcome.file} — byte-identical to HEAD on ${state.branch}, nothing to commit`,
    );
    return RULES_UPDATE_EXIT.ok;
  }

  const subject = `chore(rules): update justin-sdk rules to ${shaShort}`;
  const commit = gitRun(projectRoot, [
    'commit',
    '-m',
    subject,
    '--',
    RULES_PATHSPEC,
  ]);
  if (!commit.ok) {
    fail(
      `rules-update: wrote and staged ${outcome.file} but the commit failed — the change is staged, not committed.\n  ${commit.stderr}`,
    );
    return RULES_UPDATE_EXIT.commitFailed;
  }

  success(
    `rules-update: committed on ${state.branch} — ${subject}\n  ` +
      `${outcome.modules.length} module${outcome.modules.length === 1 ? '' : 's'} · content ${outcome.contentHash}`,
  );
  return RULES_UPDATE_EXIT.ok;
}
