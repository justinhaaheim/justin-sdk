/**
 * thread-rules-setup — copy the threads and status-report rules into a repo
 * (home-base-yukaf.26, D-RULES-INSTALL).
 *
 * Writes `.claude/rules/justin-sdk/status-report-format.md` and `requests.md`,
 * and `handoff.md` only where componentConfig.thread.handoff.successor is on
 * (threadRulesFilesFor; home-base-jm5kg.8), from the SDK's `templates/rules/`,
 * beside the committed critical-rules.md. Claude Code autoloads them from there at CLAUDE.md priority, and because the
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
  HANDOFF_RULE_FILE,
  type HandoffSuccessorKnob,
  handoffSuccessorKnob,
  threadRulesFilesFor,
  type ThreadRulesFileState,
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
 * A warning that prints even under `quiet`. `install` and `update` run every
 * component with quiet on, so a plain `warn` would be silent in exactly the
 * runs that leave a stray handoff rule behind; this line asks a human to act,
 * so it must be seen (home-base-jm5kg.8 item 3). Same shape as `warn`.
 */
function warnAlways(msg: string): void {
  console.warn(`  \x1b[33m⚠\x1b[0m ${msg}`);
}

/**
 * What install says about a handoff rule it does not install (knob off). It
 * NEVER removes the file (the SDK's rule: install never removes), so it names
 * it, says whether deleting it would lose anything, and keeps it.
 */
function strayHandoffRuleLine(state: ThreadRulesFileState): string | null {
  const rel = threadRulesInstalledPath(state.file);
  const why = `componentConfig.thread.handoff.successor is off here, so the SDK does not install it, and it teaches thread handoff and spawn to sessions in a repo where they are not on`;
  switch (state.kind) {
    case 'missing':
      return null;
    case 'matches':
      return `left in place: ${rel} — ${why}. install never removes; it is byte-identical to the SDK's copy, so deleting it loses nothing: git rm ${rel}`;
    case 'drifted':
      return `left in place: ${rel} — ${why}. install never removes; it differs from the SDK's copy, so read it before you delete it`;
    case 'unreadable':
      return `left in place: ${rel} — ${why}. It could not be read (${state.reason}), so whether it is the SDK's copy is NOT known`;
    case 'template-unreadable':
      return `left in place: ${rel} — ${why}. The SDK template could not be read, so whether it is the SDK's copy is NOT known`;
  }
}

/**
 * Bring every file this repo should carry (threadRulesFilesFor) to the
 * template's bytes. Returns false when a file could not be checked or written,
 * or when the successor knob could not be read — never reports "in sync" for a
 * file it did not read.
 *
 * `handoff` is componentConfig.thread.handoff.successor (home-base-jm5kg.8):
 * on, handoff.md is written like the others; off, it is not written or
 * rewritten, and one already here is named and left in place; unknown, it is
 * not written either, and the run fails loudly (critical rule 7: an unreadable
 * knob is not "off", but teaching handoff where it may be off is the change
 * Justin did not want, so the cautious act is to write nothing and say so).
 */
export function writeThreadRules(
  projectRoot: string,
  handoff: HandoffSuccessorKnob,
): boolean {
  let ok = true;
  const wanted = threadRulesFilesFor(handoff.kind === 'on');
  for (const state of threadRulesState(projectRoot)) {
    const rel = threadRulesInstalledPath(state.file);
    const target = join(projectRoot, rel);
    if (!wanted.includes(state.file)) {
      if (handoff.kind === 'unknown') {
        fail(
          `could not read componentConfig.thread.handoff.successor (${handoff.reason}) — NOT writing ${rel}, since it teaches thread handoff and spawn`,
        );
        ok = false;
        continue;
      }
      const line = strayHandoffRuleLine(state);
      if (line != null) warnAlways(line);
      continue;
    }
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

  const handoff = await handoffSuccessorKnob(projectRoot);
  const wanted = threadRulesFilesFor(handoff.kind === 'on');
  stepHeader(
    `1. ${wanted.map((file) => threadRulesInstalledPath(file)).join(', ')}`,
  );
  if (!writeThreadRules(projectRoot, handoff)) return 1;

  if (!quiet) {
    const gated =
      handoff.kind === 'on'
        ? ''
        : ` ${HANDOFF_RULE_FILE} is not installed here: componentConfig.thread.handoff.successor is off.`;
    console.log(
      `\n\x1b[32m\x1b[1mthread-rules-setup ready\x1b[0m in ${basename(projectRoot)}. Commit the ${wanted.length} files; the next pin bump plus \`install\` updates them.${gated}\n`,
    );
  }
  return 0;
}
