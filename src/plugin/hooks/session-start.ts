#!/usr/bin/env bun
/**
 * SessionStart hook entry for the `prime` Claude Code plugin.
 *
 * Composes TWO context blocks into a single injection:
 *   1. The critical-guidelines (assembled from the prompts repo, project-type-aware).
 *   2. The current repo state — branch/worktree divergence (project-prime).
 *
 * Both modules live in this plugin's ./lib (a marketplace plugin only gets its
 * own subdir copied to the cache, so imports must stay inside it). They import
 * only node builtins, so this runs with just `bun`, no node_modules.
 *
 * Project root: prefer $CLAUDE_PROJECT_DIR (set by Claude Code) so project-type
 * detection + git inspection target the right directory; fall back to cwd.
 *
 * Always emits a valid SessionStart envelope and exits 0 — never breaks a
 * session over context assembly. If the guidelines fail to load, the repo-state
 * block (and a failure notice in the systemMessage) are still emitted.
 */

import {assemble} from '../lib/prime';
import {formatRepoState, runDivergenceCheck} from '../lib/project-prime';

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// --- guidelines (may throw if the prompts repo can't be loaded) -------------
let guidelines = '';
let guidelineCount = 0;
let guidelinesFailed: string | null = null;
try {
  const assembled = assemble({format: 'hook'}, projectRoot);
  guidelines = assembled.markdown;
  guidelineCount = assembled.count;
} catch (error) {
  guidelinesFailed = error instanceof Error ? error.message : String(error);
}

// --- repo state (branch/worktree divergence) --------------------------------
let repoState = '';
try {
  repoState = formatRepoState(runDivergenceCheck({cwd: projectRoot}));
} catch {
  // Non-fatal: a git-inspection failure just omits the repo-state block.
}

// --- compose the single injection -------------------------------------------
const additionalContext = [guidelines, repoState]
  .filter((b) => b.length > 0)
  .join('\n\n');

const parts: string[] = [];
if (guidelinesFailed != null) {
  parts.push(`FAILED to load guidelines (${guidelinesFailed})`);
} else {
  parts.push(
    `${guidelineCount} guideline module${guidelineCount === 1 ? '' : 's'}`,
  );
}
if (repoState.length > 0) parts.push('repo state');
const systemMessage = `justin-sdk prime · ${parts.join(' + ')}`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      additionalContext,
      hookEventName: 'SessionStart',
    },
    systemMessage,
  }),
);
