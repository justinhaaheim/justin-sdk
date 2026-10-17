/**
 * The `worktree-salvage` yargs command group (epic home-base-us739, D1).
 *
 * Registered from cli-main.ts BY REFERENCE, the way `repo-status` and `thread`
 * are. NOTHING HEAVY IS IMPORTED AT THE TOP OF THIS FILE: only yargs types.
 * Each handler `await import`s its module, so zod, git and the filesystem code
 * stay off the eager module graph that the per-prompt hooks (time-check,
 * usage-check) pay for on every run of this binary.
 *
 * `restore`, `hook` and `hook-json` are dispatch 2 (home-base-us739.2).
 */

import type {Argv, CommandModule} from 'yargs';

const TOP_NARRATIVE = `
Saves a checkout's uncommitted work before anything removes the worktree.

  worktree-salvage save <path>     copy every modified, staged, renamed and
                                   untracked file, with a verified manifest
  worktree-salvage list            every save, per repo root and worktree
  worktree-salvage restore <stamp dir> --into <checkout>
                                   copy a save back, verified by sha256
  worktree-salvage hook            the PreToolUse hook for ExitWorktree remove:
                                   saves the worktree first, blocks on failure
  worktree-salvage hook-json       the settings entries for that hook

WHERE SAVES GO, in order:

  --out <dir>                      for one run
  outDir in $XDG_CONFIG_HOME/worktree-salvage/config.json
                                   e.g. {"outDir": "~/Dropbox/Data/worktree-salvage"}
  $XDG_DATA_HOME/worktree-salvage  the fallback, which is NOT backed up

A config file that exists but cannot be used is an error, never a fallback.
Every printout names the destination and where it came from.`;

const SAVE_NARRATIVE = `
WRITES  <outDir>/<repo name>/<worktree dir name>/<stamp>/
          files/<path>     every modified, added, renamed, type-changed,
                           conflicted and untracked file (symlinks as symlinks)
          changes.patch    the tracked changes against HEAD, for reading (what
                           git diff HEAD shows, made without touching the index)
          manifest.json    written LAST: path, status, bytes, sha256, mode per
                           file; deletions with their base blob; branch, base
                           commit, upstream, commits not on the default branch

NOT SAVED, and always listed with file counts and bytes:
          ignored paths    unless --ignored is passed
          node_modules/    and .git/, at any depth, even with --ignored
          nested checkouts submodules and directories holding their own .git:
                           recorded, not entered; save each on its own

NEVER   writes to the checkout. Every git call is a read with
        --no-optional-locks, so even the index is left as it was.

FAILS   (exit 1, nothing reported as saved) when free space is short, a copy's
        sha256 does not match its source, or the checkout changes while it is
        being saved. A save that fails part-way is renamed <stamp>.failed and
        kept for inspection, with FAILED.txt saying why.

A checkout with nothing to save prints so and exits 0 without writing.`;

const RESTORE_NARRATIVE = `
CHECKS FIRST, and writes nothing when any check fails:
          the save has a manifest (a .failed or incomplete save is refused)
          the target is a git checkout whose status can be read
          every file in the save still matches its sha256 in the manifest
          no file would be written through a symlinked directory

OVERWRITES nothing git could not bring back. An existing file is replaced
          only when it is an unmodified tracked file of the target (git has
          it at the target's HEAD); any other existing file is refused
          unless --overwrite. A directory is never replaced or removed.

VERIFIES  each written file's sha256 after the write.

DELETIONS the save recorded (and a rename's old path) are removed only with
          --apply-deletions, under the same rule.

NEVER     writes git's index: staged versions saved under index/ stay there.
          Warns when the target's HEAD is not the save's base commit.`;

const HOOK_NARRATIVE = `
Reads one Claude Code PreToolUse payload on stdin. Acts only when tool_name is
ExitWorktree, tool_input.action is "remove" and tool_input.discard_changes is
true; the checkout is the payload's cwd.

  clean checkout, or any other payload   exit 0, prints nothing
  dirty checkout, saved                  exit 0, a systemMessage naming the save
  save failed, or payload unreadable     exit 2, reason on stderr: Claude Code
                                         blocks ExitWorktree, nothing is removed

worktree-salvage hook-json prints the settings entries; registering one is a
human step. The user-level entry runs justin-sdk-latest in every repo,
enrolled or not, and when justin-sdk-latest is not on PATH it exits 2 with
one line on stderr, so ExitWorktree is blocked rather than removing the
worktree unsaved.`;

export const worktreeSalvageCommand: CommandModule = {
  builder: (y: Argv) =>
    y
      .usage('$0 worktree-salvage <command> [options]')
      .epilogue(TOP_NARRATIVE)
      .command(
        'save <path>',
        "Copy a checkout's modified and untracked files, with a verified manifest, to the configured archive",
        (yy) =>
          yy
            .epilogue(SAVE_NARRATIVE)
            .positional('path', {
              describe: 'The checkout (any path inside it)',
              type: 'string' as const,
            })
            .option('out', {
              describe: 'Save under this directory for this run only',
              type: 'string' as const,
            })
            .option('ignored', {
              default: false,
              describe: 'Copy ignored files too (never node_modules/ or .git/)',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runSaveCommand} = await import('./save');
          process.exit(
            await runSaveCommand({
              checkout: argv.path ?? '.',
              includeIgnored: argv.ignored,
              out: argv.out ?? null,
            }),
          );
        },
      )
      .command(
        'list',
        'Every save, per repo root and worktree: stamp, files, bytes, branch, base commit, and whether the worktree still exists',
        (yy) =>
          yy
            .option('out', {
              describe: 'List the saves under this directory instead',
              type: 'string' as const,
            })
            .option('repo', {
              describe: 'Only this repo (its folder name, or its root path)',
              type: 'string' as const,
            })
            .option('json', {
              default: false,
              describe: 'Print the same listing as JSON',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runListCommand} = await import('./list');
          process.exit(
            await runListCommand({
              json: argv.json,
              out: argv.out ?? null,
              repo: argv.repo ?? null,
            }),
          );
        },
      )
      .command(
        'restore <stampDir>',
        'Copy a save back into a checkout, verified by sha256; refuses to overwrite what git could not bring back',
        (yy) =>
          yy
            .epilogue(RESTORE_NARRATIVE)
            .positional('stampDir', {
              describe: 'The save: <outDir>/<repo>/<worktree>/<stamp>',
              type: 'string' as const,
            })
            .option('into', {
              demandOption: true,
              describe: 'The checkout to restore into (any path inside it)',
              type: 'string' as const,
            })
            .option('overwrite', {
              default: false,
              describe: 'Replace existing files git could not bring back',
              type: 'boolean' as const,
            })
            .option('apply-deletions', {
              default: false,
              describe: 'Remove the files the save recorded as deleted',
              type: 'boolean' as const,
            }),
        async (argv) => {
          const {runRestoreCommand} = await import('./restore');
          process.exit(
            await runRestoreCommand({
              applyDeletions: argv['apply-deletions'],
              into: argv.into,
              overwrite: argv.overwrite,
              stampDir: argv.stampDir ?? '',
            }),
          );
        },
      )
      .command(
        'hook',
        'PreToolUse hook: before ExitWorktree removes a dirty worktree, save it; block the removal when the save fails',
        (yy) => yy.epilogue(HOOK_NARRATIVE),
        async () => {
          const {runHookCommand} = await import('./hook');
          process.exit(await runHookCommand(await Bun.stdin.text()));
        },
      )
      .command(
        'hook-json',
        'Print the settings entries (project and user level) for the hook; writes nothing',
        (yy) => yy,
        async () => {
          const {runHookJsonCommand} = await import('./hook');
          process.exit(await runHookJsonCommand());
        },
      )
      .demandCommand(1, 'Please specify a worktree-salvage subcommand'),
  command: 'worktree-salvage',
  describe:
    "Save a worktree's uncommitted and untracked files, with a verified manifest, before anything removes it",
  handler: () => {
    // Subcommands do the work; demandCommand prints help for a bare call.
  },
};
