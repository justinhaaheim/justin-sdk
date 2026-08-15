/**
 * repo-status — the proposed cleanup, and the guarded execution of it.
 *
 * `plan` is a pure function of the report: it proposes, it never touches the
 * repo. `apply` is the only mutating path in the whole tool.
 *
 * ── Why apply RENAMES instead of deleting ────────────────────────────────────
 *
 * The obvious design is "prove the branch is redundant, then delete it". That
 * makes the whole tool rest on a judgement call — is patch-id proof enough? is
 * a mirror fresh enough? — where being wrong destroys work permanently.
 *
 * Renaming a branch to `archive/<name>` sidesteps the question entirely. The
 * commits stay reachable under a namespaced ref, the branch list gets clean,
 * and nothing is destroyed even if the disposition engine is wrong. Justin's
 * own reconcile notes reached the same conclusion by hand: "git branch
 * archive/<name> first, then delete the remote."
 *
 * So the disposition no longer decides "is deleting safe" — it decides "is this
 * finished work worth tidying away", which is a far less dangerous thing to be
 * wrong about.
 *
 * Deletion survives in exactly one case: the branch is ALREADY fully preserved
 * in an `archive/*` mirror. Renaming would collide with that mirror, and the
 * commits are already held by it, so removing the redundant copy loses nothing.
 *
 * ── Remaining guards ─────────────────────────────────────────────────────────
 *
 *  1. Only rows the report marked `provenSafe` are candidates. 'review' and
 *     'needs-judgment' are never actioned, and there is no flag to override it.
 *  2. Deletions (the mirrored case only) are RE-PROVEN against live state
 *     immediately before running. A plan is a proposal, not a licence.
 *  3. Worktree-checked-out branches are left alone.
 *
 * ── Remote archiving (home-base-qyu1.13) ─────────────────────────────────────
 *
 * The branches that actually need tidying on a real repo mostly live on the
 * REMOTE, so refusing to touch them made `apply` a near no-op. The remote
 * equivalent of a rename is two operations — push the archive ref, delete the
 * original — and the ORDER is the whole safety argument: push, VERIFY the ref
 * landed, and only then delete. Never delete first.
 *
 * These live in their own `plan.remote` group, executed by their own
 * `executeRemotePlan`, behind their own opt-in flag. That separation is
 * STRUCTURAL rather than conditional: `executePlan` walks `plan.safe`, which by
 * construction never holds a remote action, so no bare `apply --safe-only` can
 * reach the network however the flags are combined.
 *
 * THE ONE WAY A REMOTE ARCHIVE COULD DESTROY WORK, and how it is closed. A local
 * rename carries drifted commits along automatically — that is the DRIFT test in
 * the plan suite, and it is why renaming is the safe default. A remote archive
 * cannot inherit that property, because it pins the exact sha the tool PROVED
 * safe. If `origin/foo` gained commits since the plan was built, pushing the old
 * sha to `archive/foo` and then deleting `foo` would silently destroy the new
 * ones. So the pinned sha is checked against the live remote with `ls-remote`
 * before anything runs, and the delete additionally carries
 * `--force-with-lease=refs/heads/<name>:<sha>` so the SERVER rejects it if the
 * branch moved in the gap between the check and the delete. Verified: git does
 * honour a lease on a delete and rejects it with "(stale info)".
 *
 * Deliberately NOT done: fetching first. A fetch would refresh the local view
 * out from under a proof computed against the old view — quietly re-basing the
 * evidence. A stale view is reported and skipped instead, so the proof and the
 * action always describe the same data.
 *
 * Part of home-base-qyu1.7 / qyu1.13.
 */

import {execFileSync} from 'child_process';

import {mirrorFullyPreserves, proveContentOnBaseline} from './content';

import type {BranchRow, RepoStatusReport} from './report';

const ARCHIVE_PREFIX = 'archive/';

/**
 * Branch names that must NEVER be archived away on a remote, whatever the
 * disposition engine concluded.
 *
 * A default branch legitimately reports `ahead === 0` against itself and so
 * looks trivially "merged" — and archiving one renames the branch every clone
 * and every CI job tracks. Being over-broad here costs a branch falling to the
 * manual list, which is nothing; being under-broad costs a shared remote's main
 * line. The live remote's own HEAD is consulted too, at execution time.
 */
const PROTECTED_BRANCH_NAMES = new Set([
  'HEAD',
  'main',
  'master',
  'develop',
  'trunk',
]);

export type PlanActionKind =
  /** Rename to `archive/<name>`. Non-destructive: every commit stays reachable. */
  | 'archive-local-branch'
  /** Delete. ONLY when an archive/* mirror already holds every commit. */
  | 'delete-local-branch'
  /** Push `archive/<name>` to the remote, verify it landed, then delete the original. */
  | 'archive-remote-branch'
  /** Surfaced for a human; never executed. */
  | 'manual';

/**
 * Everything a remote archive needs, resolved once at plan time so nothing has
 * to re-parse a ref name while mutating a shared remote — and so the dry run
 * can print the exact commands rather than a description of them.
 */
export interface RemoteArchiveSpec {
  /** The remote to act on, e.g. `origin`. */
  remote: string;
  /** The branch name AS IT EXISTS ON THE REMOTE (no `origin/` prefix). */
  sourceBranch: string;
  /** Where it lands on the remote, e.g. `archive/foo`. */
  archiveBranch: string;
  /**
   * The exact tip that was proven safe. Pinned, never re-resolved: if the remote
   * has moved off this sha the archive is refused rather than retargeted.
   */
  sha: string;
}

export interface PlanAction {
  branch: string;
  action: PlanActionKind;
  /** Where the branch ends up, for either archive kind. Remote-qualified for remote refs. */
  target: string | null;
  reason: string;
  /** Set only for `archive-remote-branch`; null for every local action. */
  remoteArchive: RemoteArchiveSpec | null;
  /**
   * The literal git commands this action would run, in execution order.
   *
   * Carried ON THE OBJECT rather than synthesised inside a renderer, so every
   * output format shows the same thing. `plan` defaults to YAML (home-base-
   * qyu1.16) and its primary reader is Claude Code: making that reader
   * reconstruct a `--force-with-lease` from a spec would be handing it the
   * chance to get a destructive command subtly wrong.
   *
   * Populated for `archive-remote-branch` only. Those are the actions that
   * mutate a SHARED remote, and the ones whose ORDER is the whole safety
   * argument, so they are the ones worth quoting verbatim. Local actions leave
   * this null: `target` already says exactly where the branch lands, and
   * nothing about a local rename is dangerous enough to need the literal.
   */
  commands: string[] | null;
}

export interface CleanupPlan {
  repoRoot: string;
  baselineRef: string;
  /** The repo's default branch, so remote execution can refuse to archive it. */
  defaultBranch: string | null;
  /** What `apply --safe-only` will execute. LOCAL ONLY, by construction. */
  safe: PlanAction[];
  /** What `apply --safe-only --include-remote` additionally executes. */
  remote: PlanAction[];
  /** Proven safe but deliberately left manual (worktrees, already-archived). */
  manual: PlanAction[];
  /** Never automated. Listed so they are visible, not so they are actioned. */
  needsJudgment: PlanAction[];
}

/** `origin/claude/foo` -> `{remote: 'origin', bare: 'claude/foo'}`. */
function splitRemoteRef(name: string): {remote: string; bare: string} | null {
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return {bare: name.slice(idx + 1), remote: name.slice(0, idx)};
}

function isProtectedBranchName(
  bare: string,
  plan: {baselineRef: string; defaultBranch: string | null},
): boolean {
  if (PROTECTED_BRANCH_NAMES.has(bare)) return true;
  // The baseline and default branch can be remote-qualified (`origin/main`)
  // when no local copy exists, so compare on the bare form of each.
  for (const ref of [plan.baselineRef, plan.defaultBranch]) {
    if (ref == null) continue;
    if (ref === bare) return true;
    if (splitRemoteRef(ref)?.bare === bare) return true;
  }
  return false;
}

function manualAction(branch: string, reason: string): PlanAction {
  return {
    action: 'manual',
    branch,
    commands: null,
    reason,
    remoteArchive: null,
    target: null,
  };
}

/**
 * The literal commands a remote archive runs, in order.
 *
 * Printed verbatim — including the lease — rather than described, so what the
 * reader approves is exactly what executes. Resolved at PLAN time and stored on
 * the action, which is what lets the YAML/JSON renderings carry the same
 * commands the markdown dry run prints instead of a spec to reassemble.
 */
export function remoteArchiveCommands(spec: RemoteArchiveSpec): string[] {
  return [
    `git push ${spec.remote} ${spec.sha}:refs/heads/${spec.archiveBranch}`,
    `git push ${spec.remote} --delete ${spec.sourceBranch} --force-with-lease=refs/heads/${spec.sourceBranch}:${spec.sha}`,
  ];
}

export function buildPlan(report: RepoStatusReport): CleanupPlan {
  const safe: PlanAction[] = [];
  const remote: PlanAction[] = [];
  const manual: PlanAction[] = [];
  const needsJudgment: PlanAction[] = [];
  const refs = {
    baselineRef: report.repo.baselineRef,
    defaultBranch: report.repo.defaultBranch,
  };

  for (const row of report.branches) {
    if (!row.provenSafe) {
      needsJudgment.push(manualAction(row.name, row.why));
      continue;
    }

    if (row.isRemoteOnly) {
      const split = splitRemoteRef(row.name);
      if (split == null) {
        manual.push(
          manualAction(
            row.name,
            `${row.why} — could not tell which remote this ref belongs to`,
          ),
        );
        continue;
      }
      // NOTE the archive check is on the BARE name: `origin/archive/foo` is
      // already archived, but its full name does not start with `archive/`, so
      // checking `row.name` would propose `archive/archive/foo`.
      if (split.bare.startsWith(ARCHIVE_PREFIX)) {
        manual.push(
          manualAction(row.name, `${row.why} — already under ${ARCHIVE_PREFIX}`),
        );
        continue;
      }
      if (isProtectedBranchName(split.bare, refs)) {
        manual.push(
          manualAction(
            row.name,
            `${row.why} — ${split.bare} is a protected branch name; never archived automatically`,
          ),
        );
        continue;
      }
      if (row.tipSha.length === 0) {
        manual.push(
          manualAction(row.name, `${row.why} — could not resolve its tip sha`),
        );
        continue;
      }
      const archiveBranch = `${ARCHIVE_PREFIX}${split.bare}`;
      const spec: RemoteArchiveSpec = {
        archiveBranch,
        remote: split.remote,
        sha: row.tipSha,
        sourceBranch: split.bare,
      };
      remote.push({
        action: 'archive-remote-branch',
        branch: row.name,
        commands: remoteArchiveCommands(spec),
        reason: row.why,
        remoteArchive: spec,
        target: `${split.remote}/${archiveBranch}`,
      });
      continue;
    }

    if (row.worktree != null) {
      manual.push(
        manualAction(
          row.name,
          `${row.why} — checked out at ${row.worktree}; remove the worktree first`,
        ),
      );
      continue;
    }

    if (row.name.startsWith(ARCHIVE_PREFIX)) {
      manual.push(
        manualAction(row.name, `${row.why} — already under ${ARCHIVE_PREFIX}`),
      );
      continue;
    }

    // Already mirrored -> the archive holds these commits, so this local branch
    // is a redundant copy and renaming would collide with the mirror.
    if (mirrorFullyPreserves(row.archiveMirror)) {
      safe.push({
        action: 'delete-local-branch',
        branch: row.name,
        commands: null,
        reason: `every commit is already preserved in ${row.archiveMirror?.ref}; this local copy is redundant`,
        remoteArchive: null,
        target: null,
      });
      continue;
    }

    safe.push({
      action: 'archive-local-branch',
      branch: row.name,
      commands: null,
      reason: row.why,
      remoteArchive: null,
      target: `${ARCHIVE_PREFIX}${row.name}`,
    });
  }

  return {
    baselineRef: report.repo.baselineRef,
    defaultBranch: report.repo.defaultBranch,
    manual,
    needsJudgment,
    remote,
    repoRoot: report.repo.root,
    safe,
  };
}

/**
 * The MARKDOWN dry run — `plan --markdown`, and the confirmation preview `apply`
 * shows a human before it mutates anything.
 *
 * `plan` itself defaults to YAML now (home-base-qyu1.16): the same object, on
 * the same schema as `status` and `apply`, for the reader that is actually
 * primary here. This rendering is what you reach for when a PERSON has to read
 * and approve the thing.
 */
export function renderPlan(plan: CleanupPlan): string {
  const lines: string[] = [
    `# Cleanup plan (dry run) — baseline ${plan.baselineRef}`,
    '',
  ];

  // Valid markdown, not markdown-flavoured plain text: a blank line after every
  // heading, the note as its own paragraph rather than an indented orphan, and
  // list items at column 0. The reason each item's detail sits on a continuation
  // line is length — `<branch> -> <target>` plus a full sentence of reasoning on
  // one line wraps badly in a terminal and reads worse in a renderer.
  const section = (
    title: string,
    actions: PlanAction[],
    note: string,
  ): void => {
    lines.push(`## ${title} (${actions.length})`, '');
    if (actions.length === 0) {
      lines.push('None.', '');
      return;
    }
    lines.push(`${note}`, '');
    for (const a of actions) {
      const arrow = a.target != null ? ` → \`${a.target}\`` : '';
      lines.push(`- \`${a.branch}\`${arrow}`, `  ${a.reason}`);
      // The exact push/delete pair, indented under its branch as a fenced-free
      // inline-code run. A reader approving a mutation of a shared remote should
      // see the commands themselves, not a paraphrase of them. Read off the
      // action rather than recomputed, so this rendering and the YAML/JSON one
      // cannot drift into quoting different commands.
      if (a.commands != null) {
        for (const cmd of a.commands) {
          lines.push(`    \`${cmd}\``);
        }
      }
    }
    lines.push('');
  };

  section(
    'Will run under `apply --safe-only --yes`',
    plan.safe,
    'Renames preserve every commit. The only deletions are branches an archive mirror already holds in full.',
  );
  section(
    'Will run ONLY with `apply --safe-only --include-remote --yes`',
    plan.remote,
    'These mutate the shared remote. Each is a push THEN a delete, in that order: the original is removed only after the archive ref is confirmed present on the remote at the exact sha below. Never included in a bare `--safe-only` run.',
  );
  section(
    'Proven safe, left manual',
    plan.manual,
    'Checked-out worktrees, already-archived refs and protected branch names are never automated.',
  );
  section(
    'Needs judgment — NEVER automated',
    plan.needsJudgment,
    'These are the ones actually worth your attention.',
  );

  return lines.join('\n').trimEnd();
}

export interface ApplyResult {
  branch: string;
  outcome:
    | 'archived'
    | 'deleted'
    | 'skipped'
    | 'failed'
    /**
     * Remote only: the archive ref landed and was VERIFIED, but removing the
     * original did not succeed. Nothing was lost — the branch simply exists
     * twice — and re-running finishes the job. Reported distinctly rather than
     * as a plain failure, because "half of a destructive pair ran" is exactly
     * the state a reader must not have to infer.
     */
    | 'archived-original-remains';
  target: string | null;
  reason: string;
}

function gitArgv(argv: string[], cwd: string): {ok: boolean; out: string} {
  try {
    return {
      ok: true,
      out: execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'}),
    };
  } catch (error) {
    return {
      ok: false,
      out: error instanceof Error ? error.message : String(error),
    };
  }
}

function refExists(ref: string, cwd: string): boolean {
  const result = gitArgv(['rev-parse', '--verify', '--quiet', ref], cwd);
  return result.ok && result.out.trim().length > 0;
}

/**
 * Execute the safe group.
 *
 * Renames are non-destructive and need no re-proof — the commits survive under
 * the new name whatever the disposition engine concluded. They are still
 * guarded against clobbering an existing ref.
 *
 * Deletions DO get re-proven against live state, because that is the one path
 * where being stale could destroy something: between building the plan and
 * running it, a mirror can fall behind or a branch can gain commits.
 */
export function executePlan(plan: CleanupPlan, cwd: string): ApplyResult[] {
  return plan.safe.map((action): ApplyResult => {
    const {branch, target} = action;

    if (action.action === 'archive-local-branch') {
      if (target == null) {
        return {branch, outcome: 'failed', reason: 'no archive target', target};
      }
      if (refExists(target, cwd)) {
        return {
          branch,
          outcome: 'skipped',
          reason: `${target} already exists — refusing to clobber it`,
          target,
        };
      }
      const result = gitArgv(['branch', '-m', branch, target], cwd);
      return result.ok
        ? {branch, outcome: 'archived', reason: action.reason, target}
        : {
            branch,
            outcome: 'failed',
            reason: result.out.split('\n')[0] ?? 'git branch -m failed',
            target,
          };
    }

    // Deletion: only ever the already-mirrored case, and only after re-proving.
    const proof = proveContentOnBaseline(branch, plan.baselineRef, cwd);
    if (!mirrorFullyPreserves(proof.archiveMirror)) {
      return {
        branch,
        outcome: 'skipped',
        reason:
          'the archive mirror no longer holds every commit — the repo changed since the plan was built',
        target: null,
      };
    }

    // -D rather than -d: the mirror provably holds these commits, which is a
    // stronger guarantee than git's ancestry test and covers squash-merged
    // branches -d would refuse. The re-proof above earns the right to use it.
    const result = gitArgv(['branch', '-D', branch], cwd);
    return result.ok
      ? {
          branch,
          outcome: 'deleted',
          reason: `redundant copy; ${proof.archiveMirror?.ref} holds every commit`,
          target: null,
        }
      : {
          branch,
          outcome: 'failed',
          reason: result.out.split('\n')[0] ?? 'git branch -D failed',
          target: null,
        };
  });
}

// ---------------------------------------------------------------------------
// Remote archiving
// ---------------------------------------------------------------------------

/**
 * Ask the REMOTE what a ref points at. Null sha means the ref is absent there;
 * `ok: false` means the remote could not be reached at all, which is a very
 * different thing and must never be read as "absent".
 */
function lsRemoteSha(
  remote: string,
  ref: string,
  cwd: string,
): {ok: boolean; sha: string | null; error: string} {
  const result = gitArgv(['ls-remote', remote, ref], cwd);
  if (!result.ok) {
    return {error: firstLine(result.out), ok: false, sha: null};
  }
  const line = result.out
    .split('\n')
    .find((l) => l.trim().length > 0 && l.includes('\t'));
  return {error: '', ok: true, sha: line?.split('\t')[0]?.trim() ?? null};
}

function firstLine(out: string): string {
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'git failed with no output'
  );
}

/** The branch the remote itself calls HEAD, straight from the remote. */
function remoteHeadBranch(remote: string, cwd: string): string | null {
  const result = gitArgv(['ls-remote', '--symref', remote, 'HEAD'], cwd);
  if (!result.ok) return null;
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(result.out)?.[1] ?? null;
}

function skip(action: PlanAction, reason: string): ApplyResult {
  return {branch: action.branch, outcome: 'skipped', reason, target: null};
}

/**
 * Archive ONE branch on a remote: push, verify, then delete.
 *
 * Every early return before the push leaves the remote untouched, and every
 * early return after it leaves the archive ref in place with the original still
 * there — so no exit from this function can lose a commit.
 */
function archiveRemoteBranch(
  action: PlanAction,
  cwd: string,
  headCache: Map<string, string | null>,
): ApplyResult {
  const spec = action.remoteArchive;
  if (spec == null) {
    return skip(action, 'not a remote-archive action');
  }
  const {archiveBranch, remote, sha, sourceBranch} = spec;
  const archiveRef = `refs/heads/${archiveBranch}`;
  const sourceRef = `refs/heads/${sourceBranch}`;

  // GUARD 1: the remote's own default branch, asked of the remote itself. The
  // static name list in buildPlan already covers the usual suspects; this
  // catches a repo whose default is something unguessable.
  if (!headCache.has(remote)) headCache.set(remote, remoteHeadBranch(remote, cwd));
  const head = headCache.get(remote) ?? null;
  if (head != null && head === sourceBranch) {
    return skip(
      action,
      `${sourceBranch} is ${remote}'s default branch (HEAD) — never archived`,
    );
  }

  // GUARD 2: the local remote-tracking ref must still be exactly what was
  // proven. If someone fetched between plan and apply, the proof described a
  // different commit than the one we would now archive.
  const localTip = gitArgv(['rev-parse', '--verify', '--quiet', action.branch], cwd);
  if (!localTip.ok || localTip.out.trim() !== sha) {
    return skip(
      action,
      `${action.branch} no longer points at the proven ${sha.slice(0, 12)} — the local view changed after the plan was built; re-run plan`,
    );
  }

  // GUARD 3: the LIVE remote must still be at that same sha. This is the check
  // that matters most — a pinned sha plus a moved remote is the only way this
  // operation could destroy work.
  const live = lsRemoteSha(remote, sourceRef, cwd);
  if (!live.ok) {
    return {
      branch: action.branch,
      outcome: 'failed',
      reason: `could not reach ${remote}: ${live.error}`,
      target: null,
    };
  }
  if (live.sha == null) {
    return skip(action, `${sourceBranch} no longer exists on ${remote}`);
  }
  if (live.sha !== sha) {
    return skip(
      action,
      `${remote}/${sourceBranch} has moved to ${live.sha.slice(0, 12)} since the plan proved ${sha.slice(0, 12)} — fetch and re-run rather than archiving a stale tip`,
    );
  }

  // GUARD 4: never write over somebody else's archive ref. A non-fast-forward
  // push would be refused by git anyway, but a FAST-FORWARDABLE different sha
  // would be accepted — silently moving an existing archive. Verified.
  const existingArchive = lsRemoteSha(remote, archiveRef, cwd);
  if (!existingArchive.ok) {
    return {
      branch: action.branch,
      outcome: 'failed',
      reason: `could not reach ${remote}: ${existingArchive.error}`,
      target: null,
    };
  }
  const alreadyPushed = existingArchive.sha === sha;
  if (existingArchive.sha != null && !alreadyPushed) {
    return skip(
      action,
      `${remote}/${archiveBranch} already exists at ${existingArchive.sha.slice(0, 12)} — refusing to clobber it`,
    );
  }

  // PUSH. Skipped when a previous run already landed this exact sha, which makes
  // an interrupted run safe to simply re-run.
  if (!alreadyPushed) {
    const pushed = gitArgv(
      ['push', remote, `${sha}:${archiveRef}`],
      cwd,
    );
    if (!pushed.ok) {
      return {
        branch: action.branch,
        outcome: 'failed',
        reason: `push to ${remote}/${archiveBranch} failed, so ${sourceBranch} was left alone: ${firstLine(pushed.out)}`,
        target: null,
      };
    }
  }

  // VERIFY. The push reporting success is not the same claim as the ref being
  // on the remote at the right sha, and only the latter earns the delete.
  const verified = lsRemoteSha(remote, archiveRef, cwd);
  if (!verified.ok || verified.sha !== sha) {
    return {
      branch: action.branch,
      outcome: 'failed',
      reason: `could not verify ${remote}/${archiveBranch} at ${sha.slice(0, 12)} after pushing (${verified.ok ? `found ${verified.sha ?? 'nothing'}` : verified.error}) — ${sourceBranch} was NOT deleted`,
      target: null,
    };
  }

  // DELETE. The lease makes the server itself refuse if the branch moved in the
  // window since GUARD 3, which is the only gap the checks above cannot cover.
  const deleted = gitArgv(
    [
      'push',
      remote,
      '--delete',
      sourceBranch,
      `--force-with-lease=${sourceRef}:${sha}`,
    ],
    cwd,
  );
  if (!deleted.ok) {
    return {
      branch: action.branch,
      outcome: 'archived-original-remains',
      reason: `${remote}/${archiveBranch} is confirmed at ${sha.slice(0, 12)} so nothing was lost, but deleting ${sourceBranch} failed: ${firstLine(deleted.out)}`,
      target: action.target,
    };
  }

  return {
    branch: action.branch,
    outcome: 'archived',
    reason: `${alreadyPushed ? 'archive ref was already present at' : 'pushed and verified at'} ${sha.slice(0, 12)}, then removed ${sourceBranch} from ${remote}`,
    target: action.target,
  };
}

/**
 * Execute the REMOTE group. Reached only via an explicit opt-in flag.
 *
 * Deliberately a separate entry point from `executePlan` rather than a mode of
 * it: `executePlan` walks `plan.safe`, this walks `plan.remote`, and no flag
 * combination can make the former reach the latter.
 */
export function executeRemotePlan(
  plan: CleanupPlan,
  cwd: string,
): ApplyResult[] {
  const headCache = new Map<string, string | null>();
  return plan.remote.map((action) =>
    archiveRemoteBranch(action, cwd, headCache),
  );
}
