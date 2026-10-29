/**
 * The `worktree-retire` yargs command group (home-base-rub4v.1.1).
 *
 * Registered from cli-main.ts by reference, like worktree-salvage. Nothing
 * heavy is imported at the top: each handler `await import`s its module, so
 * the per-prompt hooks never pay for zod, git or lsof code.
 */

import type {Argv, CommandModule} from 'yargs';

import {helpHeader, helpWrapWidth} from '../sdk-identity';

/** The help-contract header (home-base CLAUDE.md): version and the running code's dir. */
const HEADER = helpHeader('justin-sdk', import.meta.dirname);
const WRAP = helpWrapWidth(HEADER, Math.min(80, process.stdout.columns ?? 80));

const TOP_NARRATIVE = `
Retires finished worktrees: their work is in main, nothing would be lost.

  worktree-retire plan <path…>       READ-ONLY: records the evidence and a
  worktree-retire plan --candidates  verdict per worktree, writes the plan file
  worktree-retire run <plan file>    YOU run this, in a terminal: re-checks
                                     each one, keeps its beads, removes it

ELIGIBLE only when all of these hold:
  a linked worktree (never the main checkout), on a branch, not locked
  git cherry <main> <HEAD> lists no + commit (patch-id: cherry-picked counts)
  git status --untracked-files=all is empty
  every ignored path is a cache (node_modules, .turbo, dist, build,
    .eslintcache, dynamic-version.local.*, .husky/_/), is under .beads/
    (kept), or holds no files
  no process has its cwd or an open file inside it (lsof)
  no stash entry names its branch
  every initialized submodule is clean, on a remote branch, with no
    local-only commits and no stash
A check that fails makes the worktree NOT eligible, never eligible.

NEVER deletes or renames a branch. Claude Code transcripts are left in place.

In a Claude Code session, run with the sandbox OFF: lsof reads every
process's open files, and the plan is written under ~/.local/state.`;

const PLAN_NARRATIVE = `
WRITES only  $XDG_STATE_HOME/worktree-retire/plans/<repo>-<stamp>.json
             (default ~/.local/state/…). Every git read uses
             --no-optional-locks; nothing in any checkout is written.

RECORDS per worktree: path, branch, HEAD, commits not in main, git status,
             ignored paths by class, processes inside, stash entries naming
             the branch, lock, submodules, the beads files (sha256 for the DB
             files), and its Claude Code project dir with its file count.

EXIT  0 the plan was written (whatever it found); 1 the repo could not be
      read or the plan not written; 2 nothing named and no --candidates.`;

const RUN_NARRATIVE = `
REFUSES (exit 2, nothing removed) without a terminal, on a plan file that
      does not parse, or when the count you type is not the count shown.

THEN, per eligible worktree, in order:
  1. reads it all again; any difference from the plan skips it, loudly
  2. copies every ignored file under .beads/ to
     $XDG_DATA_HOME/beads-backups/<repo>/<stamp>-retire/<worktree>/ and
     verifies each by sha256; a failed copy keeps the worktree
  3. prints where its Claude Code transcripts are, and leaves them there
  4. git worktree remove <path>, WITHOUT --force. The one --force: git refused
     only because of submodules this run just verified clean and pushed.
     A removal that fails part-way is reported with what is left.
  5. appends one JSON line per step to $XDG_STATE_HOME/worktree-retire/log.jsonl

RUN IT WITH THE CLAUDE CODE SANDBOX OFF. A sandboxed git worktree remove
deleted 37 tracked files and then failed on the write-protected
.claude/settings.json (JOURNAL 2026-10-29). Claude never runs this.

EXIT  0 every eligible worktree removed; 1 any skipped or failed; 2 refused.`;

export const worktreeRetireCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .wrap(WRAP)
      .usage(`${HEADER}\n\n$0 worktree-retire <command> [options]`)
      .epilogue(TOP_NARRATIVE)
      .command(
        'plan [paths..]',
        'READ-ONLY: record each worktree’s evidence and verdict, and write the plan file',
        (yy) =>
          yy
            .wrap(WRAP)
            .usage(
              `${HEADER}\n\n$0 worktree-retire plan [paths..] [--candidates] [--repo <path>]`,
            )
            .epilogue(PLAN_NARRATIVE)
            .positional('paths', {
              array: true,
              describe: 'Linked worktrees to check',
              type: 'string' as const,
            })
            .option('candidates', {
              default: false,
              describe: 'Check every linked worktree of the repo',
              type: 'boolean' as const,
            })
            .option('repo', {
              describe: 'The repo (any checkout of it); default: the cwd’s',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runPlanCommand} = await import('./plan');
          const {processIo} = await import('../worktree-salvage/save');
          process.exit(
            await runPlanCommand(
              {
                candidates: argv.candidates,
                paths: (argv.paths ?? []).map(String),
                repo: argv.repo ?? null,
              },
              processIo(),
            ),
          );
        },
      )
      .command(
        'run <planFile>',
        'Justin only, in a terminal, sandbox off: re-check, keep the beads, remove',
        (yy) =>
          yy
            .wrap(WRAP)
            .usage(`${HEADER}\n\n$0 worktree-retire run <planFile>`)
            .epilogue(RUN_NARRATIVE)
            .positional('planFile', {
              describe: 'A plan written by worktree-retire plan',
              type: 'string' as const,
            }),
        async (argv) => {
          const {runRunCommand} = await import('./run');
          process.exit(await runRunCommand({planFile: argv.planFile ?? ''}));
        },
      )
      .demandCommand(1, 'Please specify a worktree-retire subcommand'),
  command: 'worktree-retire',
  describe:
    'Retire finished worktrees: a read-only plan, then a run you confirm that keeps each one’s beads',
  handler: () => {
    // Subcommands do the work; demandCommand prints help for a bare call.
  },
};
