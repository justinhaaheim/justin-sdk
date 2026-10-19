/**
 * thread-rules.ts — the threads and status-report rules that ship WITH the SDK
 * (home-base-yukaf.26).
 *
 * D-RULES-SOURCE: the SDK is the single source of truth for these two rule
 * files. They used to live in the prompts repo and reach sessions through
 * `~/.claude/rules/` symlinks, which meant a repo could get new instructions
 * before the code they describe, or the reverse. Justin, 2026-10-19: "it might
 * be better to bake the instructions for threads/status reports into the
 * justin-sdk tooling itself … Because that means that the instructions travel
 * with the CODE/TOOLING." So the files are templates here, and the
 * `thread-rules` component copies them into each repo at the SDK version the
 * repo pins.
 *
 * A LEAF on purpose: node builtins only. The capture hook's prompt-time
 * `[thread]` line imports `THREAD_RULES_POINTER_PATH` from here, and that path
 * has a ~60 ms budget, so it must not pull in the installer (which chains
 * base-setup) or anything else heavy.
 *
 * The files are plain copies, so their pristine content IS the template: that is
 * what lets `remove` delete one only when it is byte-identical (the identity
 * rule), unlike critical-rules.md, which is compiled and carries
 * `pristine: null`.
 */

import {existsSync, readFileSync} from 'fs';
import {join, resolve} from 'path';

/** Where the installed copies live, repo-relative — beside critical-rules.md. */
export const THREAD_RULES_DIR = '.claude/rules/justin-sdk';

/** The rule files, in the order the installer writes them. */
export const THREAD_RULES_FILES = [
  'status-report-format.md',
  'requests.md',
] as const;

export type ThreadRulesFile = (typeof THREAD_RULES_FILES)[number];

/**
 * The path the `[thread]` line names (D-REMINDERS): the status-report rule,
 * which links to requests.md itself.
 */
export const THREAD_RULES_POINTER_PATH = `${THREAD_RULES_DIR}/status-report-format.md`;

/** Repo-relative path of one installed file. */
export function threadRulesInstalledPath(file: ThreadRulesFile): string {
  return `${THREAD_RULES_DIR}/${file}`;
}

/** Absolute path of one SDK template. */
export function threadRulesTemplatePath(file: ThreadRulesFile): string {
  return resolve(import.meta.dirname, '..', 'templates', 'rules', file);
}

/**
 * The bytes of one template, or null when it cannot be read. Null means "we do
 * not know what the component writes", so no caller may treat it as a match.
 */
export function threadRulesTemplateText(file: ThreadRulesFile): string | null {
  const path = threadRulesTemplatePath(file);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * How one installed file compares with the SDK's template. FIVE states, because
 * "missing", "different" and "could not check" are different facts (critical
 * rule 7): an unreadable file is never "missing", and an unreadable template is
 * never "matches".
 */
export type ThreadRulesFileState =
  | {file: ThreadRulesFile; kind: 'matches'}
  | {file: ThreadRulesFile; kind: 'missing'}
  | {file: ThreadRulesFile; kind: 'drifted'}
  | {file: ThreadRulesFile; kind: 'unreadable'; reason: string}
  | {file: ThreadRulesFile; kind: 'template-unreadable'};

/** Compare every installed rule file in `projectRoot` with its template. */
export function threadRulesState(projectRoot: string): ThreadRulesFileState[] {
  return THREAD_RULES_FILES.map((file): ThreadRulesFileState => {
    const template = threadRulesTemplateText(file);
    if (template == null) return {file, kind: 'template-unreadable'};
    const installed = join(projectRoot, threadRulesInstalledPath(file));
    if (!existsSync(installed)) return {file, kind: 'missing'};
    let actual: string;
    try {
      actual = readFileSync(installed, 'utf-8');
    } catch (error) {
      return {
        file,
        kind: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return actual === template
      ? {file, kind: 'matches'}
      : {file, kind: 'drifted'};
  });
}
