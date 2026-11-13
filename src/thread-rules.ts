/**
 * thread-rules.ts — the threads and status-report rules that ship WITH the SDK
 * (home-base-yukaf.26), and the `/full-report` command (home-base-1rxt0.14).
 *
 * D-RULES-SOURCE: the SDK is the single source of truth for these rule
 * files. They used to live in the prompts repo and reach sessions through
 * `~/.claude/rules/` symlinks, which meant a repo could get new instructions
 * before the code they describe, or the reverse. Justin, 2026-10-19: "it might
 * be better to bake the instructions for threads/status reports into the
 * justin-sdk tooling itself … Because that means that the instructions travel
 * with the CODE/TOOLING." So the files are templates here, and the
 * `thread-rules` component copies them into each repo at the SDK version the
 * repo pins.
 *
 * A LEAF on purpose: node builtins only at module load. The capture hook's
 * prompt-time `[thread]` line imports `THREAD_RULES_POINTER_PATH` from here,
 * and that path has a ~60 ms budget, so it must not pull in the installer
 * (which chains base-setup) or anything else heavy. `handoffSuccessorKnob` is
 * the one function that reaches further, through an `await import` that runs
 * only when it is called.
 *
 * The files are plain copies, so their pristine content IS the template: that is
 * what lets `remove` delete one only when it is byte-identical (the identity
 * rule), unlike critical-rules.md, which is compiled and carries
 * `pristine: null`.
 */

import {existsSync, readFileSync} from 'fs';
import {join, resolve} from 'path';

/** Where the installed rule copies live, repo-relative — beside critical-rules.md. */
export const THREAD_RULES_DIR = '.claude/rules/justin-sdk';

/**
 * Where the installed command copies live, repo-relative: Claude Code's
 * project commands directory, so each file is a known `/<name>` command.
 */
export const THREAD_COMMANDS_DIR = '.claude/commands';

/**
 * Every file the component may own, in the order the installer writes them. A
 * fixed list, not every file in templates/: the manifest's identity removal and
 * doctor's THREAD_RULES check both read it. Which of them a repo SHOULD carry
 * is `threadRulesFilesFor` below: handoff.md is gated. full-report.md is a
 * COMMAND, not a rule (`threadRulesInstalledPath` puts it in
 * THREAD_COMMANDS_DIR); it rides with the rules because it is part of the same
 * status report and needs the same threads-on repo.
 */
export const THREAD_RULES_FILES = [
  'status-report-format.md',
  'requests.md',
  'handoff.md',
  'full-report.md',
] as const;

export type ThreadRulesFile = (typeof THREAD_RULES_FILES)[number];

/**
 * The `/full-report` command (home-base-1rxt0.14). The SDK installed no
 * commands or skills before it, so it is installed the way the nearest thing,
 * these rule files, is: copied from the SDK at the pinned version, the SDK's
 * copy wins, removed only when byte-identical. Installed wherever the rules
 * are, whatever componentConfig.thread.fullReportCommand says: that knob
 * decides whether a hook answers the command, and with it off the command's
 * own text tells Claude to run `thread status --full` and paste it, which is
 * what the status report rule already asks for.
 */
export const FULL_REPORT_COMMAND_FILE =
  'full-report.md' satisfies ThreadRulesFile;

/**
 * The handoff rule (home-base-mbnjv.6, D3a). It is the ONLY installed text that
 * teaches `thread handoff` and `thread spawn`, and it is installed only where
 * componentConfig.thread.handoff.successor is on (home-base-jm5kg.8). Justin,
 * 2026-10-30: "it's probably better to not put information about this in
 * critical-rules until i'm ready for all projects to adopt it." So the shared
 * status-report-format.md names no handoff command, and a repo with the knob
 * off is told nothing about either.
 */
export const HANDOFF_RULE_FILE = 'handoff.md' satisfies ThreadRulesFile;

/** The files a repo should carry, given its successor knob. */
export function threadRulesFilesFor(
  successor: boolean,
): readonly ThreadRulesFile[] {
  return successor
    ? THREAD_RULES_FILES
    : THREAD_RULES_FILES.filter((file) => file !== HANDOFF_RULE_FILE);
}

/**
 * componentConfig.thread.handoff.successor at one repo, or why it could not be
 * read. A read that throws is UNKNOWN, never "off" (critical rule 7): the
 * installer then writes no handoff rule and says so, and doctor says it could
 * not check.
 */
export type HandoffSuccessorKnob =
  | {kind: 'off' | 'on'}
  | {kind: 'unknown'; reason: string};

/**
 * Resolve the knob as `thread handoff`, the session guard and the hooks
 * installer resolve it (hook-knobs.ts): resolveThreadConfig at the project
 * root, DEFAULT <- user file <- project file. A config that reads but is
 * invalid resolves to the defaults (off) there, for every caller alike.
 *
 * `await import`, inside the function: hook-knobs reaches zod, and this file is
 * a leaf the capture hook imports at prompt time. The import runs only when an
 * installer or doctor calls this, never when the module loads.
 */
export async function handoffSuccessorKnob(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<HandoffSuccessorKnob> {
  try {
    const {hookKnobOn} = await import('./hook-knobs');
    return {
      kind: hookKnobOn('thread.handoff.successor', projectRoot, env)
        ? 'on'
        : 'off',
    };
  } catch (error) {
    return {
      kind: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The path the `[thread]` line names (D-REMINDERS): the status-report rule,
 * which links to requests.md itself.
 */
export const THREAD_RULES_POINTER_PATH = `${THREAD_RULES_DIR}/status-report-format.md`;

/** Repo-relative path of one installed file. */
export function threadRulesInstalledPath(file: ThreadRulesFile): string {
  return file === FULL_REPORT_COMMAND_FILE
    ? `${THREAD_COMMANDS_DIR}/${file}`
    : `${THREAD_RULES_DIR}/${file}`;
}

/** Absolute path of one SDK template: templates/commands/ or templates/rules/. */
export function threadRulesTemplatePath(file: ThreadRulesFile): string {
  return resolve(
    import.meta.dirname,
    '..',
    'templates',
    file === FULL_REPORT_COMMAND_FILE ? 'commands' : 'rules',
    file,
  );
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
  /**
   * A file at a path outside the SDK's own directory (the command) that
   * differs from the template and does not carry SDK_COMMAND_MARKER: somebody's
   * own command of the same name. Never overwritten, never removed.
   */
  | {file: ThreadRulesFile; kind: 'foreign'}
  | {file: ThreadRulesFile; kind: 'unreadable'; reason: string}
  | {file: ThreadRulesFile; kind: 'template-unreadable'};

/**
 * The line the SDK's command template carries. `.claude/commands/` is not the
 * SDK's directory the way `.claude/rules/justin-sdk/` is, so a repo may already
 * have a `/full-report` of its own: a differing file WITH this marker is an
 * older SDK copy and is replaced, one WITHOUT it is `foreign` and left alone.
 */
export const SDK_COMMAND_MARKER = 'Installed by justin-sdk (thread-rules)';

/** Is this file's directory the SDK's alone? The rules' is; the commands' is not. */
export function inSdkDirectory(file: ThreadRulesFile): boolean {
  return file !== FULL_REPORT_COMMAND_FILE;
}

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
    if (actual === template) return {file, kind: 'matches'};
    return inSdkDirectory(file) || actual.includes(SDK_COMMAND_MARKER)
      ? {file, kind: 'drifted'}
      : {file, kind: 'foreign'};
  });
}
