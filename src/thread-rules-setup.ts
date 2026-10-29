/**
 * thread-rules-setup — copy the threads and status-report rules into a repo
 * (home-base-yukaf.26, D-RULES-INSTALL).
 *
 * Writes `.claude/rules/justin-sdk/status-report-format.md`, `requests.md` and
 * `handoff.md` (THREAD_RULES_FILES) from the SDK's `templates/rules/`, beside
 * the committed critical-rules.md. Claude Code autoloads them from there at CLAUDE.md priority, and because the
 * files are committed they reach web sessions, CI and fresh clones too.
 *
 * THE SDK'S COPY WINS. A re-run (`install`, `update`, a sweep) rewrites a file
 * that differs from the template, so a pin bump updates the instructions
 * together with the code they describe — that is the point of moving them
 * here. The installer says so on every file it replaces, and the old bytes are
 * in git. Removal is the opposite: `remove thread-rules` deletes a file only
 * when it is byte-identical to the template (component-manifest.ts).
 *
 * Applies only where threads are on: `COMPONENT_INCLUDE_IF['thread-rules']` is
 * `isThreadEnabled`, so `core` carries it exactly when
 * `componentConfig.thread.enabled` resolves true for the repo.
 */

import {mkdirSync, renameSync, writeFileSync} from 'fs';
import {basename, dirname, join} from 'path';

import {runBaseSetup} from './base-setup';
import {fail, setQuiet, stepHeader, success, warn} from './setup-helpers';
import {
  THREAD_RULES_FILES,
  threadRulesInstalledPath,
  threadRulesState,
  threadRulesTemplateText,
} from './thread-rules';

export interface ThreadRulesSetupOptions {
  /** Accepted for the installer contract; the SDK's copy wins regardless. */
  force?: boolean;
  projectRoot?: string;
  quiet?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic (dchjw.17
   * F7).
   */
  sdkRepoUrl?: string;
}

/** Write `content` to `path` atomically: a session can start mid-write. */
function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Bring every file to the template's bytes. Returns false when a file could not
 * be checked or written — never reports "in sync" for a file it did not read.
 */
export function writeThreadRules(projectRoot: string): boolean {
  let ok = true;
  for (const state of threadRulesState(projectRoot)) {
    const rel = threadRulesInstalledPath(state.file);
    const target = join(projectRoot, rel);
    switch (state.kind) {
      case 'matches':
        success(`${rel} matches the SDK's copy`);
        break;
      case 'template-unreadable':
        fail(
          `the SDK template for ${state.file} could not be read — NOT writing ${rel}`,
        );
        ok = false;
        break;
      case 'unreadable':
        // Could not check is not missing (critical rule 7): do not write over a
        // file whose current content we could not see.
        fail(
          `${rel} exists but could not be read (${state.reason}) — NOT overwriting it`,
        );
        ok = false;
        break;
      case 'missing':
      case 'drifted': {
        const template = threadRulesTemplateText(state.file);
        if (template == null) {
          fail(
            `the SDK template for ${state.file} could not be read — NOT writing ${rel}`,
          );
          ok = false;
          break;
        }
        writeAtomically(target, template);
        if (state.kind === 'missing') {
          success(`wrote ${rel}`);
        } else {
          warn(
            `replaced ${rel}: it differed from the SDK's copy, and the SDK's copy wins (the previous version is in git)`,
          );
        }
        break;
      }
    }
  }
  return ok;
}

export async function runThreadRulesSetup(
  options: ThreadRulesSetupOptions = {},
): Promise<number> {
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with thread-rules-setup');
    return baseExit;
  }
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader(
    `1. ${THREAD_RULES_FILES.map((file) => threadRulesInstalledPath(file)).join(', ')}`,
  );
  if (!writeThreadRules(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mthread-rules-setup ready\x1b[0m in ${basename(projectRoot)}. Commit the ${THREAD_RULES_FILES.length} files; the next pin bump plus \`install\` updates them.\n`,
    );
  }
  return 0;
}
