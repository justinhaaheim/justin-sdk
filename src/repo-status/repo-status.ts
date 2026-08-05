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

import {buildPlan, executePlan, renderPlan} from './plan';
import {buildReport, type RepoStatusReport} from './report';

const TOP_NARRATIVE = `
TYPICAL USAGE

  Reconciling a repo is: get the facts, judge the residual, then act.

    repo-status status              the ledger — every branch, grouped by disposition
    repo-status branch <name>       dig into one branch, commit by commit, with proof
    repo-status plan                the proposed cleanup, as a dry run
    repo-status apply --safe-only   archive the finished branches (non-destructive)

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

  repo-status status                 full ledger (content proofs + PR state)
  repo-status status --no-content    skip per-commit proofs — fast, but dispositions
                                     stay conservative because nothing is proven
  repo-status status --no-prs        skip the network entirely
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
shown as 'name -> archive/name' are renames, which preserve every commit.
Branches needing judgment are listed for your attention but are never actioned
automatically, by design.
`.trim();

const APPLY_NARRATIVE = `
Executes the cleanup. Requires --safe-only (the only supported mode today) and
an explicit --yes.

It RENAMES finished branches to archive/<name> rather than deleting them, so
every commit stays reachable even if the disposition engine is wrong. The one
exception is a branch an archive/* mirror already holds in full: renaming would
collide with that mirror, and the commits are already preserved, so the
redundant local copy is deleted instead (re-proven against live state first).

Acts ONLY on branches the tool proved safe, and only on local ones. It will
refuse 'review' and 'needs-judgment' rows even if you ask for them.
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
  return 0;
}

export async function runCli(argv: string[], cwd: string): Promise<number> {
  let exitCode = 0;

  await yargs(hideBin(argv))
    .scriptName('repo-status')
    .usage(`$0 <command> [options]\n\n${TOP_NARRATIVE}`)
    .option('repo', {
      default: cwd,
      describe: 'Repository to inspect (defaults to the current directory)',
      type: 'string',
    })
    .option('json', {
      default: false,
      describe: 'Emit the same typed object as JSON instead of YAML',
      type: 'boolean',
    })
    .command(
      ['status', '$0'],
      'Per-branch disposition ledger for the repo',
      (y) =>
        y
          .epilogue(STATUS_NARRATIVE)
          .option('content', {
            default: true,
            describe: 'Run per-commit content proofs (local, thorough)',
            type: 'boolean',
          })
          .option('prs', {
            default: true,
            describe: 'Query GitHub for PR state (network)',
            type: 'boolean',
          })
          .option('since-days', {
            describe: 'Ignore branches with no commits in this many days',
            type: 'number',
          }),
      (args) => {
        exitCode = emit(
          buildReport({
            content: args.content,
            cwd: args.repo,
            prs: args.prs,
            sinceDays: args.sinceDays ?? null,
          }),
          args.json,
        );
      },
    )
    .command(
      'branch <name>',
      'Comprehensive commit-by-commit deep-dive on one branch',
      (y) =>
        y
          .epilogue(BRANCH_NARRATIVE)
          .positional('name', {demandOption: true, type: 'string'})
          .option('prs', {default: true, type: 'boolean'}),
      (args) => {
        const report = buildReport({
          content: true,
          cwd: args.repo,
          only: args.name,
          prs: args.prs,
          sinceDays: null,
        });
        if (report != null && report.branches.length === 0) {
          console.error(`no such branch: ${args.name}`);
          exitCode = 1;
          return;
        }
        exitCode = emit(report, args.json);
      },
    )
    .command(
      'plan',
      'Proposed cleanup as a dry run, grouped by safety',
      (y) => y.epilogue(PLAN_NARRATIVE),
      (args) => {
        const report = buildReport({
          content: true,
          cwd: args.repo,
          prs: true,
          sinceDays: null,
        });
        if (report == null) {
          console.error('not a git repository');
          exitCode = 1;
          return;
        }
        const plan = buildPlan(report);
        console.log(args.json ? render(plan, true) : renderPlan(plan));
      },
    )
    .command(
      'apply',
      'Execute the proven-safe cleanup (irreversible)',
      (y) =>
        y
          .epilogue(APPLY_NARRATIVE)
          .option('safe-only', {
            default: false,
            describe: 'Required. Act only on branches proven safe',
            type: 'boolean',
          })
          .option('yes', {
            default: false,
            describe: 'Required. Confirm the repo will be modified',
            type: 'boolean',
          }),
      (args) => {
        if (!args.safeOnly) {
          console.error(
            'refusing to run without --safe-only (it is the only supported mode)',
          );
          exitCode = 2;
          return;
        }
        const report = buildReport({
          content: true,
          cwd: args.repo,
          prs: true,
          sinceDays: null,
        });
        if (report == null) {
          console.error('not a git repository');
          exitCode = 1;
          return;
        }
        const plan = buildPlan(report);
        if (!args.yes) {
          console.error(renderPlan(plan));
          console.error(
            '\nrefusing to act without --yes (this modifies the repository)',
          );
          exitCode = 2;
          return;
        }
        const results = executePlan(plan, args.repo);
        console.log(render(results, args.json));
      },
    )
    .demandCommand(0)
    .strict()
    .help()
    .wrap(Math.min(100, process.stdout.columns ?? 100))
    .parseAsync();

  return exitCode;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv, process.cwd()));
}
