#!/usr/bin/env bun
/**
 * SessionStart hook entry for the `prime` Claude Code plugin.
 *
 * Runs `runPrime` (the assembler, which lives in this plugin at ../lib/prime.ts)
 * and emits the SessionStart hook JSON envelope (`--format hook`) so the
 * critical-guidelines are injected as `additionalContext` at session start.
 *
 * Self-contained: ../lib/prime imports only node builtins, so this runs with
 * just `bun` and no `node_modules`. The plugin cache only contains this
 * plugin's own subdirectory, so the import path must stay inside it (../lib).
 *
 * Project root: prefer $CLAUDE_PROJECT_DIR (the current project's root, set by
 * Claude Code) so project-type detection reads the right package.json; fall
 * back to cwd.
 */

import {runPrime} from '../lib/prime';

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
process.exit(runPrime(projectRoot, {format: 'hook'}));
