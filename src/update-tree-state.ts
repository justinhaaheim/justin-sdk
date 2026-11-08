/**
 * update-tree-state.ts — what `justin-sdk update`'s preflight sees in the
 * working tree, and whether the only uncommitted change is the SDK pin.
 *
 * WHY THIS EXISTS (home-base-ipx4a F1, decision D1). `update` bumps the SDK
 * pin, then re-executes the freshly installed CLI with `--no-self-update`. The
 * child ran the same preflight as the parent and refused the parent's OWN pin
 * bump as "uncommitted changes", so every update from a clean tree that bumped
 * the pin stopped there with nothing reconciled. The parent is whatever OLD SDK
 * the repo had, and old SDKs pass only `--no-self-update`, so no new flag from
 * the parent can fix it: the CHILD has to recognise, on its own, dirt that is
 * only the pin.
 *
 * "ONLY THE PIN", PRECISELY. Every uncommitted path is a modification (git
 * status ` M`, `M ` or `MM`) of the project's own `package.json` or `bun.lock`,
 * and each of those files passes its rule below:
 *
 *  - package.json: HEAD and working copy both parse as JSON objects; the working
 *    text declares `"@justinhaaheim/justin-sdk":` exactly once; its
 *    devDependencies value is a `github:justinhaaheim/justin-sdk#<version tag>`
 *    spec that differs from HEAD's; and with that one key taken out, the two
 *    objects are equal. Key order inside devDependencies is ignored, because
 *    `bun add -d` sorts that section when it writes the pin (measured, bun
 *    1.4.2: an unsorted devDependencies came back sorted, scripts untouched).
 *    Key order everywhere else counts.
 *  - bun.lock: an "SDK line" is a line whose JSON key is exactly
 *    `@justinhaaheim/justin-sdk` or starts with `@justinhaaheim/justin-sdk/`
 *    (bun's key for the SDK's own nested copy of a dependency). With every SDK
 *    line removed from both versions, the texts are identical; and the working
 *    copy has no more exact-key lines than HEAD. An extra exact-key line is the
 *    duplicate-key damage of F2, which must never be committed.
 *
 * Anything else — an untracked file, another tracked file, a second change in
 * package.json, a new top-level lockfile entry — is ordinary dirt, and update
 * refuses it exactly as before. That includes a release that ADDS a dependency
 * to the SDK: the new package gets its own top-level lockfile entry, which is
 * not an SDK line (measured: v0.50.0 → v0.51.0 added `"shell-quote": [...]`).
 *
 * Failure is not "clean" (critical rule 7): when git cannot answer, the result
 * is `unchecked`, a distinct member, and every git read that fails while
 * checking the pin makes the tree `dirty`, never `sdk-pin-only`.
 */

import {execFileSync} from 'child_process';
import {readFileSync} from 'fs';
import {join} from 'path';

const SDK_PKG = '@justinhaaheim/justin-sdk';

/** The only spec form self-update writes: a tag on the published repo. */
const SDK_TAG_PIN_RE = /^github:justinhaaheim\/justin-sdk#v?\d+\.\d+\.\d+$/;

/** A bun.lock line keyed by the SDK, or by the SDK's own nested dependency. */
const SDK_LOCK_LINE_RE = /^\s*"@justinhaaheim\/justin-sdk(?:\/[^"]*)?"\s*:/;

/** A bun.lock line keyed by the SDK itself (a declaration or its package entry). */
const SDK_LOCK_EXACT_KEY_RE = /^\s*"@justinhaaheim\/justin-sdk"\s*:/;

/** A package.json declaration of the SDK as a key, counted in the raw text. */
const SDK_PACKAGE_JSON_KEY_RE = /"@justinhaaheim\/justin-sdk"\s*:/g;

/** git status codes that mean "this tracked file is modified", nothing more. */
const MODIFIED_CODES = new Set([' M', 'M ', 'MM']);

/** Generous: a large app's bun.lock is a few MB, and a cut-off read is a lie. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export type UpdateTreeState =
  /** git answered, and nothing is uncommitted. */
  | {kind: 'clean'}
  /** The only uncommitted changes are the SDK pin, in these paths (D1). */
  | {kind: 'sdk-pin-only'; paths: string[]}
  /** Ordinary uncommitted work; `detail` says what kept it from being only the pin. */
  | {detail: string; kind: 'dirty'}
  /** `git status` itself failed, so nothing is known about the tree. */
  | {error: string; kind: 'unchecked'};

export type PinOnlyCheck = {ok: true} | {ok: false; reason: string};

export interface PorcelainEntry {
  /** The two-character XY status code. */
  code: string;
  /** Repository-root-relative path (the destination, for a rename or copy). */
  path: string;
}

/**
 * Parse `git status --porcelain=v1 -z`. Returns null when the output does not
 * have the documented shape, so a desynced parse can never read as "clean".
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] | null {
  if (stdout.length === 0) return [];
  const fields = stdout.split('\0');
  // -z terminates every record with NUL, so the last field is always empty.
  if (fields.at(-1) !== '') return null;
  fields.pop();
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record == null || record.length < 4 || record[2] !== ' ') return null;
    const code = record.slice(0, 2);
    entries.push({code, path: record.slice(3)});
    // A rename or copy carries its source path as the next NUL field.
    if (code.startsWith('R') || code.startsWith('C')) {
      if (i + 1 >= fields.length) return null;
      i++;
    }
  }
  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sdkDevDependency(pkg: Record<string, unknown>): unknown {
  const dev = pkg.devDependencies;
  return isPlainObject(dev) ? dev[SDK_PKG] : undefined;
}

/**
 * The manifest with the SDK pin taken out and devDependencies key-sorted, as a
 * string: two manifests that differ only in the pin (and in the order `bun add`
 * leaves devDependencies in) give the same string.
 */
function withoutSdkPin(pkg: Record<string, unknown>): string {
  const dev = pkg.devDependencies;
  if (!isPlainObject(dev)) return JSON.stringify(pkg);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(dev).sort()) {
    if (key !== SDK_PKG) sorted[key] = dev[key];
  }
  // Spreading keeps devDependencies at its own position in the key order.
  return JSON.stringify({...pkg, devDependencies: sorted});
}

/** Does this package.json change touch nothing but the SDK pin? See the header. */
export function sdkPinOnlyPackageJsonChange(
  headText: string,
  workText: string,
): PinOnlyCheck {
  const head = parseObject(headText);
  if (head == null) {
    return {
      ok: false,
      reason: 'the committed package.json is not a JSON object',
    };
  }
  const work = parseObject(workText);
  if (work == null) {
    return {ok: false, reason: 'package.json is not a JSON object'};
  }
  const declarations = workText.match(SDK_PACKAGE_JSON_KEY_RE)?.length ?? 0;
  if (declarations !== 1) {
    return {
      ok: false,
      reason: `package.json declares "${SDK_PKG}" ${declarations} times, not once`,
    };
  }
  const headPin = sdkDevDependency(head);
  const workPin = sdkDevDependency(work);
  if (typeof headPin !== 'string') {
    return {
      ok: false,
      reason: `the committed package.json has no devDependencies "${SDK_PKG}"`,
    };
  }
  if (typeof workPin !== 'string') {
    return {
      ok: false,
      reason: `package.json has no devDependencies "${SDK_PKG}"`,
    };
  }
  if (!SDK_TAG_PIN_RE.test(workPin)) {
    return {
      ok: false,
      reason: `the uncommitted SDK pin "${workPin}" is not a github:justinhaaheim/justin-sdk#<version tag> spec`,
    };
  }
  if (workPin === headPin) {
    return {
      ok: false,
      reason:
        'package.json has uncommitted changes, and none of them is the SDK pin',
    };
  }
  if (withoutSdkPin(head) !== withoutSdkPin(work)) {
    return {ok: false, reason: 'package.json changes more than the SDK pin'};
  }
  return {ok: true};
}

function lines(text: string): string[] {
  return text.split('\n');
}

/** Does this bun.lock change touch nothing but the SDK's lines? See the header. */
export function sdkPinOnlyLockfileChange(
  headText: string,
  workText: string,
): PinOnlyCheck {
  const rest = (text: string): string =>
    lines(text)
      .filter((line) => !SDK_LOCK_LINE_RE.test(line))
      .join('\n');
  if (rest(headText) !== rest(workText)) {
    return {
      ok: false,
      reason: `bun.lock changes lines that are not keyed by ${SDK_PKG}`,
    };
  }
  const exactKeys = (text: string): number =>
    lines(text).filter((line) => SDK_LOCK_EXACT_KEY_RE.test(line)).length;
  const before = exactKeys(headText);
  const after = exactKeys(workText);
  if (after > before) {
    return {
      ok: false,
      reason: `bun.lock gained a "${SDK_PKG}" key (${before} → ${after} lines): a duplicate key, which \`bun update ${SDK_PKG}\` repairs`,
    };
  }
  return {ok: true};
}

function runGit(
  args: string[],
  cwd: string,
): {ok: true; stdout: string} | {error: string; ok: false} {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {ok: true, stdout};
  } catch (error) {
    const stderr = (error as {stderr?: unknown}).stderr;
    const firstStderrLine =
      typeof stderr === 'string' ? stderr.trim().split('\n')[0] : undefined;
    const detail =
      firstStderrLine != null && firstStderrLine.length > 0
        ? firstStderrLine
        : error instanceof Error
          ? error.message
          : String(error);
    return {error: `git ${args.join(' ')} failed: ${detail}`, ok: false};
  }
}

/**
 * Read the tree for update's preflight. Never throws: an unreadable tree is
 * `unchecked`, and anything this cannot prove to be only the pin is `dirty`.
 */
export function readUpdateTreeState(projectRoot: string): UpdateTreeState {
  const status = runGit(['status', '--porcelain=v1', '-z'], projectRoot);
  if (!status.ok) return {error: status.error, kind: 'unchecked'};
  const entries = parsePorcelainZ(status.stdout);
  if (entries == null) {
    return {
      detail: 'git status printed output this preflight could not parse',
      kind: 'dirty',
    };
  }
  if (entries.length === 0) return {kind: 'clean'};

  // Porcelain paths are relative to the repository root, whatever the cwd.
  const prefixRead = runGit(['rev-parse', '--show-prefix'], projectRoot);
  if (!prefixRead.ok) return {detail: prefixRead.error, kind: 'dirty'};
  const prefix = prefixRead.stdout.replace(/\n$/, '');
  const checks: Record<string, typeof sdkPinOnlyPackageJsonChange> = {
    [`${prefix}bun.lock`]: sdkPinOnlyLockfileChange,
    [`${prefix}package.json`]: sdkPinOnlyPackageJsonChange,
  };

  const paths: string[] = [];
  for (const entry of entries) {
    const check = checks[entry.path];
    if (check == null || !MODIFIED_CODES.has(entry.code)) {
      return {
        detail: `${entry.path} has uncommitted changes (git status "${entry.code}")`,
        kind: 'dirty',
      };
    }
    const name = entry.path.slice(prefix.length);
    const head = runGit(['show', `HEAD:./${name}`], projectRoot);
    if (!head.ok) return {detail: head.error, kind: 'dirty'};
    let work: string;
    try {
      work = readFileSync(join(projectRoot, name), 'utf-8');
    } catch (error) {
      return {
        detail: `could not read ${name}: ${error instanceof Error ? error.message : String(error)}`,
        kind: 'dirty',
      };
    }
    const verdict = check(head.stdout, work);
    if (!verdict.ok) return {detail: verdict.reason, kind: 'dirty'};
    paths.push(name);
  }
  return {kind: 'sdk-pin-only', paths};
}
