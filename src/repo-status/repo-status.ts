#!/usr/bin/env bun

/**
 * repo-status — a read-only reconcile ledger for ONE git repository.
 *
 * Inventories worktrees, local and remote branches, PR state and archive
 * mirrors, and gives every branch a DISPOSITION with a one-line why. The point
 * is to split a reconcile into a mechanical part that is correct every time and
 * a judgment part that is small enough to actually look at.
 *
 * The primary audience is Claude Code, not a human reading a terminal. That
 * drives most of the ergonomics here: YAML by default (structured but
 * low-token and readable as plain output), `--json` for the identical object,
 * inspect SUBCOMMANDS so a reader never has to jq a blob, and `--help` that
 * carries a usage NARRATIVE so no external memory is needed to drive the tool.
 *
 * Part of home-base-qyu1.
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import type {Argv} from 'yargs';

import {
  buildPlan,
  executePlan,
  executeRemotePlan,
  renderPlan,
} from './plan';
import {buildReport, type RepoStatusReport} from './report';

const TOP_NARRATIVE = `
TYPICAL USAGE

  Reconciling a repo is: get the facts, judge the residual, then act.

    repo-status status              the ledger — every branch, grouped by disposition
    repo-status branch <name>       dig into one branch, commit by commit, with proof
    repo-status plan                the proposed cleanup, as a dry run
    repo-status apply --safe-only   archive the finished branches (non-destructive)

  Remote branches are archived only by 'apply --safe-only --include-remote',
  which pushes archive/<name>, confirms it landed, and only then deletes the
  original. Nothing else in this tool can modify a remote.

  Start with 'status'. Most branches resolve to 'merged' or 'mirrored' and need
  no thought. Anything marked 'review' or 'needs-judgment' is where your
  attention actually belongs — run 'branch <name>' on those to see the evidence.

  Nothing here mutates the repo except 'apply'. 'apply' RENAMES finished branches
  to archive/<name> rather than deleting them, so nothing is destroyed even if a
  disposition is wrong, and it refuses to touch anything not PROVEN safe.
`.trim();

const STATUS_NARRATIVE = `
Computes the full ledger: every branch, how far it diverges from the baseline,
and a disposition with a one-line reason.

  merged          every unique commit is on the baseline by content — nothing to lose
  mirrored        not on the baseline, but preserved in an exact, current archive/* mirror
  review          evidence conflicts or is incomplete — look before acting
  needs-judgment  real unmerged work with no proof it is preserved anywhere

Ahead/behind counts are reported alongside the disposition, not replaced by it.
Every row also states what those counts already prove about MERGING, so nothing
has to re-derive it with 'git merge-base --is-ancestor':

  fast-forward        the baseline is an ancestor of the branch (behind 0) —
                      merging it in fast-forwards, no merge commit
  merge-needed        both sides moved — merging writes a merge commit
  already-up-to-date  the branch holds nothing the baseline lacks
  unknown             the ahead/behind counts could not be computed at all, so
                      nothing here is known — such a row reports ahead and
                      behind as null and is always 'review', never proven safe

That is a sha-reachability fact and is deliberately independent of the
content-based disposition: a squash-merged branch is 'merged' AND 'merge-needed'
at the same time, and both readings are worth having.

When git cannot LIST something, this says so rather than reporting nothing.
'branches' and 'summary' become null (never an empty ledger), 'worktrees' becomes
null, an 'enumerationFailures' entry names the exact command that failed, and the
exit code is non-zero. Worth knowing: one unreadable object behind ANY ref tip
loses the branch listing for the whole repo, so "no branches" and "could not read
the branches" are states worth telling apart.

A 'submodules' section reports each submodule's recorded gitlink separately,
because the questions there are different ones:

  severe          the recorded pointer is on no remote (every fresh clone, CI run
                  and 'git worktree add' fails on it), the checkout holds commits
                  that exist on no remote, or a BRANCH records a pointer that is
                  on no remote — merging it would publish an unresolvable gitlink
  advisory        the checkout is behind its remote (stale base, and therefore
                  probably stale dependencies), the pointer is missing from THIS
                  checkout's object store, or the parent's worktrees disagree
  ok              nothing to do

It also reads the gitlink every BRANCH records and compares it to the baseline's,
because that is what decides whether a merge is mechanical: two branches
recording different submodule commits conflict on the gitlink, and git resolves
that with neither side's content — somebody has to choose a submodule commit.
Only branches that DISAGREE are printed, so a repo where they all agree says
nothing; 'branchPointers' still reports that it looked and how many it compared,
so the silence is a claim rather than an absence.

Every submodule finding names the QUESTION its numbers answer, because the same
number means opposite things: "behind by 49" is noise for "can I delete this"
and load-bearing for "am I building on current code".

  repo-status status                 full ledger (content proofs + PR state)
  repo-status status --no-content    skip per-commit proofs — fast, but dispositions
                                     stay conservative because nothing is proven
  repo-status status --no-prs        skip the network entirely
  repo-status status --no-submodules skip the submodule section
  repo-status status --submodule-stores
                                     also open EVERY worktree's submodule object
                                     store, not just this worktree's — each linked
                                     worktree has its own store, and 'git worktree
                                     remove' deletes it along with anything unpushed
  repo-status status --json          same object as JSON
`.trim();

const BRANCH_NARRATIVE = `
The comprehensive deep-dive on ONE branch. Use it on anything 'status' marked
'review' or 'needs-judgment'.

Shows every commit the branch has that the baseline does not, whether each is
present on the baseline by patch-id (which sees through squash-merge, rebase and
cherry-pick), and for anything patch-id could not match, a per-changed-file
comparison against the baseline. This is the proof behind a 'merged' verdict.

  repo-status branch my-feature
  repo-status branch my-feature --json
`.trim();

const PLAN_NARRATIVE = `
The proposed cleanup as a DRY RUN, grouped by safety. Nothing is executed.

Read it, then run 'apply --safe-only' to execute the proven-safe group. Entries
whose 'target' is 'archive/<name>' are renames, which preserve every commit.
Branches needing judgment are listed for your attention but are never actioned
automatically, by design.

Remote branches get their own group, carrying the EXACT push and delete commands
that would run, in order — in every output format. They are executed only by
'apply --safe-only --include-remote --yes' — never by a bare --safe-only run.

There is NO plan at all when the branch listing could not be read: an empty plan
would read as "nothing to clean up", so this prints why and exits non-zero
instead. And when the WORKTREE listing could not be read, every local branch goes
to the manual group — whether one is checked out is then unknown, and git does
not refuse to rename a checked-out branch.

  repo-status plan              YAML: the plan object, same schema as 'status'
  repo-status plan --json       the identical object as JSON
  repo-status plan --markdown   prose dry run, grouped under headings, for a
                                human to read and approve

YAML is the default because the plan is a structured object and the primary
reader is a program. --markdown is the same content written for a person; it is
also what 'apply' prints as its confirmation preview when you leave off --yes.
`.trim();

const APPLY_NARRATIVE = `
Executes the cleanup. Requires --safe-only (the only supported mode today) and
an explicit --yes.

It RENAMES finished branches to archive/<name> rather than deleting them, so
every commit stays reachable even if the disposition engine is wrong. The one
exception is a branch an archive/* mirror already holds in full: renaming would
collide with that mirror, and the commits are already preserved, so the
redundant local copy is deleted instead (re-proven against live state first).

Acts ONLY on branches the tool proved safe. It will refuse 'review' and
'needs-judgment' rows even if you ask for them.

  repo-status apply --safe-only --yes                    local branches only
  repo-status apply --safe-only --include-remote --yes   also archive on the remote

--include-remote is the ONLY way anything reaches the network. Without it this
command cannot modify a remote at all, whatever else you pass. With it, each
remote branch is archived as a push FOLLOWED BY a delete: the archive ref is
pushed at the exact sha that was proven, confirmed present on the remote, and
only then is the original removed. A push or verification that fails leaves the
original branch untouched and moves on. Run 'plan' first — it prints the exact
push/delete commands.
`.trim();

function render(obj: unknown, json: boolean): string {
  if (json) return JSON.stringify(obj, null, 2);
  // YAML is the default: structured and consistently keyed, but uncluttered
  // enough to read like ordinary stdout — and cheaper in tokens than JSON.
  return Bun.YAML.stringify(obj, null, 2).trimEnd();
}

function emit(report: RepoStatusReport | null, json: boolean): number {
  if (report == null) {
    console.error(
      'not a git repository (or no baseline branch could be found)',
    );
    return 1;
  }
  console.log(render(report, json));
  if (
    !report.enrichments.prs &&
    report.enrichments.prsUnavailableReason != null
  ) {
    console.error(
      `note: PR state unavailable — ${report.enrichments.prsUnavailableReason}`,
    );
  }
  // A severe submodule row is the whole reason this section exists: it is the
  // failure that looks fine locally and breaks every clone. Surfacing it on
  // stderr as well means it cannot be scrolled past in a long ledger.
  for (const sub of report.submodules.entries) {
    if (sub.severity === 'severe') {
      console.error(`severe: submodule ${sub.path} — ${sub.why}`);
    }
  }
  // Same reasoning, for the walk that produces the ledger itself: a ledger
  // missing a whole half of its input must not be read as a short one
  // (home-base-qyu1.23). The nulls in the object are the machine-readable form;
  // this is the form that cannot be scrolled past.
  for (const failure of report.enumerationFailures ?? []) {
    console.error(
      `severe: could not enumerate ${failure.what} — \`${failure.command}\` failed. ${failure.why}. ${failure.diagnose}`,
    );
  }
  // A failed BRANCH listing leaves nothing of the ledger, so the command did not
  // do what it was asked; a failed worktree listing degrades a report that is
  // still substantially there. Those deserve different exit codes.
  return report.branches == null ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// Each subcommand is a yargs COMMAND MODULE, and the whole set is exposed two
// ways from one definition:
//
//   * `repoStatusCommand` — mounts the group under a host CLI, so
//     `justin-sdk repo-status …` works.
//   * `runCli` — the standalone `repo-status` bin.
//
// The subcommand form is the one that actually travels. A PATH symlink is
// per-machine and never reaches a Claude Code web/cloud session; `bunx
// github:justinhaaheim/justin-sdk repo-status` works anywhere the SDK resolves.
//
// Handlers set `process.exitCode` rather than calling `process.exit`, so
// hosting these inside a larger CLI can never terminate it mid-parse.

const statusCommand = {
  builder: (y: Argv) =>
    y
      .epilogue(STATUS_NARRATIVE)
      .option('content', {
        default: true,
        describe: 'Run per-commit content proofs (local, thorough)',
        type: 'boolean' as const,
      })
      .option('prs', {
        default: true,
        describe: 'Query GitHub for PR state (network)',
        type: 'boolean' as const,
      })
      .option('submodules', {
        default: true,
        describe: 'Report submodule gitlink state (local, cheap)',
        type: 'boolean' as const,
      })
      .option('submodule-stores', {
        default: false,
        describe:
          "Open every worktree's submodule object store, not just this worktree's",
        type: 'boolean' as const,
      })
      .option('since-days', {
        describe: 'Ignore branches with no commits in this many days',
        type: 'number' as const,
      }),
  command: ['status', '$0'],
  describe: 'Per-branch disposition ledger for the repo',
  handler: (args: any) => {
    process.exitCode = emit(
      buildReport({
        content: args.content,
        cwd: args.repo,
        prs: args.prs,
        sinceDays: args.sinceDays ?? null,
        submoduleStores: args.submoduleStores,
        submodules: args.submodules,
      }),
      args.json,
    );
  },
};

const branchCommand = {
  builder: (y: Argv) =>
    y
      .epilogue(BRANCH_NARRATIVE)
      .positional('name', {demandOption: true, type: 'string' as const})
      .option('prs', {default: true, type: 'boolean' as const}),
  command: 'branch <name>',
  describe: 'Comprehensive commit-by-commit deep-dive on one branch',
  handler: (args: any) => {
    const report = buildReport({
      content: true,
      cwd: args.repo,
      only: args.name,
      prs: args.prs,
      sinceDays: null,
      // A one-branch deep-dive is not the place for repo-wide submodule state;
      // `status` is. Skipping it also keeps this command's cost proportional to
      // the one branch it was asked about.
      submodules: false,
    });
    // `branches == null` is NOT "no such branch" — the listing failed, so this
    // branch's absence from it says nothing about the branch. `emit` reports
    // that case for what it is.
    if (report?.branches != null && report.branches.length === 0) {
      console.error(`no such branch: ${args.name}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = emit(report, args.json);
  },
};

const planCommand = {
  builder: (y: Argv) =>
    y.epilogue(PLAN_NARRATIVE).option('markdown', {
      default: false,
      describe: 'Render the prose dry run for a human instead of YAML',
      type: 'boolean' as const,
    }),
  command: 'plan',
  describe: 'Proposed cleanup as a dry run, grouped by safety',
  handler: (args: any) => {
    // Two explicit format flags disagreeing is a mistake, not a preference to
    // silently resolve — the same reflex as `apply` refusing an ambiguous run.
    if (args.json && args.markdown) {
      console.error(
        '--json and --markdown select different renderings; pass at most one',
      );
      process.exitCode = 2;
      return;
    }
    const report = buildReport({
      content: true,
      cwd: args.repo,
      prs: true,
      sinceDays: null,
      // The plan only ever archives BRANCHES, so submodule state would be
      // computed and then discarded. `status` is where it belongs.
      submodules: false,
    });
    if (report == null) {
      console.error('not a git repository');
      process.exitCode = 1;
      return;
    }
    const plan = buildPlan(report);
    if (plan == null) {
      reportNoPlan(report);
      process.exitCode = 1;
      return;
    }
    // YAML by default, through the SAME render() as status and apply: one typed
    // object, one schema, whatever the format (home-base-qyu1.16).
    console.log(args.markdown ? renderPlan(plan) : render(plan, args.json));
  },
};

/**
 * Why there is no plan, on stderr, and nothing on stdout.
 *
 * `buildPlan` returns null only when the branch listing failed, and the whole
 * point of that null is that an empty plan would have read as "nothing to clean
 * up" (home-base-qyu1.23). Printing an empty object here would put that reading
 * straight back, so the commands print the reason and exit non-zero instead.
 */
function reportNoPlan(report: RepoStatusReport): void {
  console.error(
    'no plan: the repo\'s branches could not be enumerated, so there is no branch set to plan over — this is NOT "nothing to clean up"',
  );
  for (const failure of report.enumerationFailures ?? []) {
    console.error(
      `  ${failure.what}: \`${failure.command}\` failed. ${failure.why}. ${failure.diagnose}`,
    );
  }
}

const applyCommand = {
  builder: (y: Argv) =>
    y
      .epilogue(APPLY_NARRATIVE)
      .option('safe-only', {
        default: false,
        describe: 'Required. Act only on branches proven safe',
        type: 'boolean' as const,
      })
      .option('include-remote', {
        default: false,
        describe:
          'Also archive proven-safe REMOTE branches (pushes archive/<name>, then deletes the original)',
        type: 'boolean' as const,
      })
      .option('yes', {
        default: false,
        describe: 'Required. Confirm the repo will be modified',
        type: 'boolean' as const,
      }),
  command: 'apply',
  describe: 'Execute the proven-safe cleanup (modifies the repo)',
  handler: (args: any) => {
    if (!args.safeOnly) {
      console.error(
        'refusing to run without --safe-only (it is the only supported mode)',
      );
      process.exitCode = 2;
      return;
    }
    const report = buildReport({
      content: true,
      cwd: args.repo,
      prs: true,
      sinceDays: null,
      // The plan only ever archives BRANCHES, so submodule state would be
      // computed and then discarded. `status` is where it belongs.
      submodules: false,
    });
    if (report == null) {
      console.error('not a git repository');
      process.exitCode = 1;
      return;
    }
    const plan = buildPlan(report);
    if (plan == null) {
      reportNoPlan(report);
      process.exitCode = 1;
      return;
    }
    if (!args.yes) {
      // Deliberately MARKDOWN even though `plan` now defaults to YAML: this
      // preview exists to be read by the person deciding whether to type --yes.
      console.error(renderPlan(plan));
      console.error(
        `\nrefusing to act without --yes (this modifies ${
          args.includeRemote
            ? `the repository AND ${plan.remote.length} branch(es) on the remote`
            : 'the repository'
        })`,
      );
      if (!args.includeRemote && plan.remote.length > 0) {
        console.error(
          `note: ${plan.remote.length} proven-safe remote branch(es) will NOT be touched — pass --include-remote to archive those too`,
        );
      }
      process.exitCode = 2;
      return;
    }

    // Local first, and via a separate call: `executePlan` cannot reach the
    // remote group, so the network is touched only on the explicit opt-in.
    const results = executePlan(plan, args.repo);
    if (args.includeRemote) {
      console.error(
        `archiving ${plan.remote.length} branch(es) on the remote (push, verify, then delete)`,
      );
      results.push(...executeRemotePlan(plan, args.repo));
    }
    console.log(render(results, args.json));
  },
};

/** The shared shape: global options plus every subcommand. */
function buildRepoStatus(y: Argv): Argv {
  return y
    .option('repo', {
      default: process.cwd(),
      describe: 'Repository to inspect (defaults to the current directory)',
      type: 'string',
    })
    .option('json', {
      default: false,
      describe: 'Emit the same typed object as JSON instead of YAML',
      type: 'boolean',
    })
    .command(statusCommand)
    .command(branchCommand)
    .command(planCommand)
    .command(applyCommand)
    .demandCommand(0);
}

/** Mount the whole group under a host CLI (`justin-sdk repo-status …`). */
export const repoStatusCommand = {
  builder: (y: Argv) =>
    buildRepoStatus(y.usage(`$0 repo-status <command> [options]\n\n${TOP_NARRATIVE}`)),
  command: 'repo-status',
  describe: 'Per-branch reconcile ledger for one git repository',
  handler: () => {
    // Subcommand handlers do the work; `$0` maps to `status`.
  },
};

export async function runCli(argv: string[]): Promise<number> {
  await buildRepoStatus(
    yargs(hideBin(argv))
      .scriptName('repo-status')
      .usage(`$0 <command> [options]\n\n${TOP_NARRATIVE}`),
  )
    .strict()
    .help()
    .wrap(Math.min(100, process.stdout.columns ?? 100))
    .parseAsync();

  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv));
}
