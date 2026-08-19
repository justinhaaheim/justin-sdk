/**
 * rules-diff — "what am I missing?" (home-base-q1hp, t6a0.21 D2b/D9)
 *
 * Justin's ask, verbatim: *"a command to ask, essentially, what am I missing?
 * What is new in the prompts relative to what I have loaded from session
 * start?"* Claude Code loads the committed artifact once, at launch; a rules
 * change pushed an hour later is invisible until the next session. This prints
 * the delta so a human or an agent can read the new guidance in-terminal and act
 * on it mid-session, without a restart.
 *
 * READ-ONLY, ALWAYS. Nothing is written inside the repo — the two sides of the
 * diff are staged in a temp directory under the OS tmpdir and removed
 * afterwards. (The managed prompts clone under ~/.config/justin-sdk is refreshed,
 * because a stale source cannot answer the question; that is outside the repo.)
 *
 * THREE OUTCOMES, NEVER CONFLATED (critical rule 5 — failure is not empty):
 *   IN-SYNC      exit 0 — stated explicitly, naming the prompts sha. Silence is
 *                a claim, so the claim is made in words.
 *   DIFF         exit 1 — the unified diff, then one line naming `rules-update`.
 *   CANNOT-CHECK exit 2 — the refresh failed, the repo is not enrolled, or the
 *                selection is broken. Says which, and never says "in sync".
 * Exit 2 covers every could-not-check reason on purpose: the consumer contract
 * (home-base-si46's session-start notice) needs a stable ternary, and the reasons
 * are distinguished in the message rather than by fanning out the exit space.
 *
 * WHAT IS COMPARED IS THE BODY, NOT THE FILE. The artifact's first line is a
 * stamp carrying the source sha and the generation date; the content hash
 * deliberately excludes the date (D3), so the diff must too, or every run after
 * midnight would report drift that isn't. Comparing real BYTES rather than
 * trusting the stamp's hash also means a hand edit to a generated file shows up
 * as what it is instead of being certified in sync by its own header.
 */

import {execFileSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {readSelectedModules, refreshIsVerified} from './critical-rules-setup';
import {assembleSelected, PROMPTS_SOURCE_FAILURE} from './plugin/lib/prime';
import {
  artifactBody,
  contentHash,
  normalizeArtifactText,
  prettierMarkdown,
  projectRulesFilePath,
  readDeployedStamp,
  RULES_UPDATE_CMD,
} from './plugin/lib/rules-file';
import {fail, findLocalPrettier} from './setup-helpers';

export const RULES_DIFF_EXIT = {
  inSync: 0,
  diff: 1,
  cannotCheck: 2,
} as const;

export type RulesDiffOutcome = 'in-sync' | 'diff' | 'cannot-check';

export interface RulesDiffResult {
  outcome: RulesDiffOutcome;
  exitCode: number;
  /** Everything the command has to say, already assembled in print order. */
  report: string;
}

export interface RulesDiffOptions {
  /** Defaults to the cwd. */
  projectRoot?: string;
  /** Read this prompts dir as-is instead of the managed clone (tests). */
  promptsDir?: string;
}

/**
 * `artifactBody` (and the `normalizeArtifactText` shape it enforces) moved to
 * src/plugin/lib/rules-file.ts: the staleness checker the SessionStart hook
 * calls needs it, and the hook can only import from the plugin subtree
 * (home-base-qjyj). Re-exported so this module's public surface is unchanged.
 */
export {artifactBody} from './plugin/lib/rules-file';

function cannotCheck(message: string): RulesDiffResult {
  return {
    exitCode: RULES_DIFF_EXIT.cannotCheck,
    outcome: 'cannot-check',
    report: message,
  };
}

/**
 * Compute the answer without printing it — so tests can assert on the exact
 * report, and so the printing layer stays trivial.
 */
export function rulesDiff(options: RulesDiffOptions = {}): RulesDiffResult {
  const projectRoot = options.projectRoot ?? process.cwd();

  // Same reader as the write path (uniformity: one selection reader).
  const selection = readSelectedModules(projectRoot);
  if (!selection.ok) {
    return cannotCheck(
      `cannot check what is missing: ${selection.message}. Nothing about the rules is claimed here.`,
    );
  }

  let assembled;
  try {
    // forceUpdate: the question is "what is new in the prompts", which is only
    // answerable against a source we just refreshed.
    assembled = assembleSelected(selection.modules, {
      forceUpdate: true,
      promptsDir: options.promptsDir,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return cannotCheck(
      reason.startsWith(PROMPTS_SOURCE_FAILURE)
        ? `cannot check what is missing: ${reason}. This is NOT "your rules are current" — the source could not be read at all.`
        : `cannot check what is missing: could not assemble the selected rules modules (${reason}).`,
    );
  }
  if (!refreshIsVerified(assembled.sourceRefresh)) {
    return cannotCheck(
      `cannot check what is missing: the prompts clone at ${assembled.sourceDir} could not be refreshed ` +
        `(refresh: ${assembled.sourceRefresh}), so its content may be stale. The artifact is NOT being ` +
        `certified as current — this is "unknown", not "clean". Fix connectivity and re-run.`,
    );
  }

  const file = projectRulesFilePath(projectRoot);
  // The SAME prettier the writer uses — same binary AND same config, the latter
  // resolved by handing prettier the artifact's real path (t6a0.21.1). A
  // different formatter or a different config here would manufacture a phantom
  // diff. Nothing is written: the path is passed via --stdin-filepath.
  const formatted = prettierMarkdown(assembled.markdown, {
    binary: findLocalPrettier(dirname(file)),
    filePath: file,
  });
  if (formatted.status === 'failed') {
    // No canonical bytes ⇒ no comparison. Reporting "in sync" (or a diff) off
    // unformatted content would be an answer we did not measure.
    return cannotCheck(
      `cannot check what is missing: the rules could not be formatted, so there are no canonical ` +
        `bytes to compare against (${formatted.reason}). This is "unknown", not "clean".`,
    );
  }
  const canonical = normalizeArtifactText(formatted.markdown);
  const shaShort =
    assembled.sourceSha != null ? assembled.sourceSha.slice(0, 12) : 'unknown';
  const moduleCount = `${selection.modules.length} module${selection.modules.length === 1 ? '' : 's'}`;
  // The same hash the writer stamps: it hashes the Prettier'd body, and
  // `normalize` only re-adds the single trailing newline it strips.
  const canonicalHash = contentHash(canonical.trimEnd());

  const exists = existsSync(file);
  const current = exists ? artifactBody(readFileSync(file, 'utf-8')) : '';

  if (exists && current === canonical) {
    return {
      exitCode: RULES_DIFF_EXIT.inSync,
      outcome: 'in-sync',
      report:
        `rules-diff: in sync with prompts ${shaShort} (${moduleCount}, content ${canonicalHash}).\n` +
        `Nothing new to load — the artifact this session read is the canonical one.`,
    };
  }

  const lines: string[] = [];
  lines.push(
    exists
      ? `rules-diff: OUT OF SYNC — ${file} differs from prompts ${shaShort} (${moduleCount}).`
      : `rules-diff: NO ARTIFACT at ${file} while this repo is enrolled — every rule below is missing from this session (prompts ${shaShort}, ${moduleCount}).`,
  );
  lines.push('');
  lines.push(unifiedDiff(current, canonical));
  lines.push('');
  lines.push(`Run \`${RULES_UPDATE_CMD}\` to regenerate and commit it.`);

  // The stamp already claiming the canonical hash means `rules-update` will
  // report "already up to date" and change nothing — stated as the fact it is,
  // not diagnosed: a hand edit and a prettier upgrade produce the same signature.
  if (exists && readDeployedStamp(file)?.contentHash === canonicalHash) {
    lines.push(
      `NOTE: the stamp already records this content hash, so plain \`rules-update\` will report "already up to date" — ` +
        `the difference is in the file's bytes (edited by hand, or formatted by a different prettier). ` +
        `Use \`${RULES_UPDATE_CMD} --force\`.`,
    );
  }

  return {
    exitCode: RULES_DIFF_EXIT.diff,
    outcome: 'diff',
    report: lines.join('\n'),
  };
}

/**
 * `git diff --no-index` between two temp files.
 *
 * Both sides are written OUTSIDE the repo, into a temp dir whose subdirectory
 * names become the diff's `a/`…`b/` labels, so the header reads
 * `current/critical-rules.md` → `canonical/critical-rules.md` instead of two
 * unreadable temp paths. Exit status 1 means "they differ" and is the expected
 * result, not an error. Falls back to a plain marker-line dump if git is
 * unavailable, so the command still answers the question.
 */
function unifiedDiff(current: string, canonical: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsdk-rules-diff-'));
  try {
    const currentDir = join(dir, 'current');
    const canonicalDir = join(dir, 'canonical');
    mkdirSync(currentDir, {recursive: true});
    mkdirSync(canonicalDir, {recursive: true});
    const name = 'critical-rules.md';
    writeFileSync(join(currentDir, name), current);
    writeFileSync(join(canonicalDir, name), canonical);
    try {
      const out = execFileSync(
        'git',
        [
          '--no-pager',
          'diff',
          '--no-index',
          // Colour only when a terminal will render it: the output is captured
          // and returned, so escape codes in a pipe would be noise.
          `--color=${process.stdout.isTTY === true ? 'always' : 'never'}`,
          '--',
          `current/${name}`,
          `canonical/${name}`,
        ],
        {cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
      );
      return out.trimEnd();
    } catch (error) {
      // status 1 = "files differ", with the diff on stdout. Anything else is a
      // real git failure, and must not be reported as an empty diff.
      const err = error as {status?: number; stdout?: string; stderr?: string};
      const out = (err.stdout ?? '').toString();
      if (err.status === 1 && out.trim().length > 0) return out.trimEnd();
      return (
        `(could not render a unified diff: git exited ${err.status ?? 'abnormally'}` +
        `${(err.stderr ?? '').toString().trim().length > 0 ? ` — ${(err.stderr ?? '').toString().trim()}` : ''})\n` +
        `The files DO differ; the canonical content is ${canonical.split('\n').length} lines.`
      );
    }
  } finally {
    rmSync(dir, {force: true, recursive: true});
  }
}

export function runRulesDiff(options: RulesDiffOptions = {}): number {
  const result = rulesDiff(options);
  if (result.outcome === 'cannot-check') {
    fail(`rules-diff: ${result.report}`);
    return result.exitCode;
  }
  // Deliberately NOT routed through the quiet-gated helpers: the report IS the
  // product of this command, and a quiet flag left set by another in-process
  // caller must never be able to swallow the answer.
  process.stdout.write(`${result.report}\n`);
  return result.exitCode;
}
