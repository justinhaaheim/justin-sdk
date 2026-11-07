# Bead export gate (home-base-jm5kg.11.3): refuses a commit that stages
# .beads/issues.jsonl with conflict markers or a line that is not JSON. The
# probe is needed for the reason given under the type-check gate below. A
# checkout whose SDK predates the command has no check to run, so it commits.
if bun run justin-sdk --help 2>/dev/null | grep -q 'pre-commit-beads-export'; then
  bun run justin-sdk pre-commit-beads-export || exit 1
fi
# Type-check gate (home-base-pp1vx.1.2): runs `npm run ts-check`, unless
# componentConfig.husky.tsCheckOnCommit in justin-sdk.config.json is
# "onlyWhenTsStaged" and nothing staged can affect type-checking. A full check
# still runs when this checkout has no green one in the last 24h. Details:
# bun run justin-sdk pre-commit-ts-check --help
#
# The else branch is the old line. It is needed: core.hooksPath is shared, so
# every worktree runs THIS file with its OWN node_modules SDK, and an SDK from
# before the gate exits 1 on the unknown command, blocking every commit there.
# (`--help` is no probe: yargs exits 0 for an unknown command's --help.)
if bun run justin-sdk --help 2>/dev/null | grep -q 'pre-commit-ts-check'; then
  bun run justin-sdk pre-commit-ts-check -- npm run ts-check
else
  npm run ts-check
fi
echo ""
# --no-stash: lint-staged's default stash-based backup/restore of partial
# changes chokes on staged submodule gitlinks (projects/justin-sdk pointer
# bumps), failing with an opaque "git error" even when the actual lint tasks
# succeed. This repo always stages+commits whole files, never partial hunks,
# so the backup safety net isn't needed.
#
# --quiet when not on a terminal (home-base-p05kz.5): piped, lint-staged prints
# every task, and each task's title holds its staged paths, which came to about
# 35,000 characters on one merge commit (2026-11-06). Measured in a scratch repo
# on the same day: with --quiet a success prints nothing, and a failure still
# exits 1 and prints the tool's stdout and stderr.
if [ -t 1 ]; then
  npx lint-staged --no-stash
else
  npx lint-staged --no-stash --quiet
fi