/**
 * claude-md-setup.ts — Manage CLAUDE.md at the project root for justin-sdk
 * projects.
 *
 * Behavior:
 *  - If CLAUDE.md is missing → write the SDK template with {{PROJECT_NAME}}
 *    substituted to the project's directory basename.
 *  - If CLAUDE.md exists → never overwrite (even with --force; this file is
 *    too important to clobber). Instead, ensure the file contains a literal
 *    reference to `@docs/prompts/IMPORTANT_GUIDELINES_INLINED.md`; if missing,
 *    append a small block referencing it.
 *
 * Runs base-setup as a precondition so the foundation layer (and the
 * justin-sdk.config.json component registration) is always in place before
 * the claude-md-specific steps run.
 *
 * Idempotent: re-running produces no spurious changes.
 */

import {existsSync, readFileSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  appendIfMissing,
  fail,
  setQuiet,
  stepHeader,
  success,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROMPTS_REF = '@docs/prompts/IMPORTANT_GUIDELINES_INLINED.md';
const PROJECT_NAME_PLACEHOLDER = '{{PROJECT_NAME}}';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Ensure CLAUDE.md exists with the prompts reference.
 *
 *  - Missing → write the template with {{PROJECT_NAME}} substituted to the
 *    project's directory basename.
 *  - Exists → preserve verbatim, but append the prompts reference if it's
 *    not already present.
 */
function stepClaudeMd(projectRoot: string): boolean {
  const targetPath = resolve(projectRoot, 'CLAUDE.md');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    'CLAUDE.md.skeleton',
  );

  if (!existsSync(targetPath)) {
    if (!existsSync(templatePath)) {
      fail(`CLAUDE.md template not found at ${templatePath}`);
      return false;
    }

    const projectName = basename(projectRoot);
    const templateContent = readFileSync(templatePath, 'utf-8');
    const rendered = templateContent
      .split(PROJECT_NAME_PLACEHOLDER)
      .join(projectName);
    writeFileSync(targetPath, rendered);
    success(`Created CLAUDE.md from template (project: ${projectName})`);
    return true;
  }

  // File exists — never overwrite. Just ensure it references the prompts file.
  const appendBlock = `\n${PROMPTS_REF}\n`;
  const added = appendIfMissing(targetPath, PROMPTS_REF, appendBlock);
  if (added) {
    success(`Appended ${PROMPTS_REF} reference to CLAUDE.md`);
  } else {
    success(`CLAUDE.md already references ${PROMPTS_REF}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClaudeMdSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests / chained setup commands) */
  quiet?: boolean;
  /**
   * Reserved for parity with other setup commands. CLAUDE.md is never
   * overwritten by this component — even when `force` is true — because
   * the file is too important to clobber. `force` has no effect today.
   */
  force?: boolean;
}

/**
 * Install the justin-sdk claude-md-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'claude-md-setup' in justin-sdk.config.json.
 */
export async function runClaudeMdSetup(
  options: ClaudeMdSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (!quiet) {
    console.log(
      `\n\x1b[1mInstalling claude-md-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // Pre-register 'claude-md-setup' as a component so base-setup writes it
  // into justin-sdk.config.json in a single pass.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['claude-md-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with claude-md-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: CLAUDE.md at project root
  stepHeader('1. CLAUDE.md');
  if (!stepClaudeMd(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mclaude-md-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
