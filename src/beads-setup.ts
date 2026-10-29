/**
 * beads-setup.ts — Deterministic beads_rust setup for any project.
 *
 * Orchestrates: mise.toml, br install, migration, br init, .prettierignore,
 * .claude/settings.json, and the beads-setup component registration.
 *
 * This is tooling-only. Beads *guidance* is authored in the prompts repo and
 * injected by the `prime` SessionStart hook — beads-setup writes no prompts.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before beads-specific steps run.
 *
 * Bails with a clear error on unexpected state rather than guessing.
 */

import {spawnSync} from 'child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {basename, dirname, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {type BrSemver, brSpawnEnv} from './beads/br';
import {
  ensureDir,
  ensureIgnoreEntries,
  exec,
  fail,
  getPinnedToolVersion,
  kebabCase,
  log,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

function getPinnedVersion(): string {
  const version = getPinnedToolVersion('beads_rust');
  if (version == null) {
    throw new Error(
      'beads_rust version not found in versions.json. Cannot determine pinned beads_rust version.',
    );
  }
  return version;
}

// ---------------------------------------------------------------------------
// Never pull a repo's br DOWN (home-base-dj5m9.1.3)
// ---------------------------------------------------------------------------

/**
 * Where a repo's own br pin stands against the SDK's (versions.json).
 *
 * The SDK pin moves repo by repo during an upgrade sweep, so a repo may pin a
 * br NEWER than the SDK it runs. Rewriting that pin to the SDK's would run an
 * older br on a database a newer one wrote, so neither doctor nor beads-setup
 * ever does it. `unordered` is a pin that is not a plain `X.Y.Z` (a mise
 * `latest`, a prefix like `0.7`): its place cannot be told, so it is never
 * read as "below" (critical rules §7).
 */
export type BrPinOrder =
  | {kind: 'above'}
  | {kind: 'below'}
  | {kind: 'same'}
  | {kind: 'unordered'; reason: string};

/** `0.7.6` or `v0.7.6` → its numbers; null for anything else. */
function parsePinVersion(text: string): BrSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  const [, major, minor, patch] = match ?? [];
  if (major == null || minor == null || patch == null) return null;
  return {major: Number(major), minor: Number(minor), patch: Number(patch)};
}

/** Order `repoPin` against `sdkPin`. Pure, shared by beads-setup and doctor. */
export function compareBrPin(repoPin: string, sdkPin: string): BrPinOrder {
  const repo = parsePinVersion(repoPin);
  const sdk = parsePinVersion(sdkPin);
  if (repo == null || sdk == null) {
    const which =
      repo == null ? `this repo's "${repoPin}"` : `the SDK's "${sdkPin}"`;
    return {
      kind: 'unordered',
      reason: `${which} is not a plain X.Y.Z version, so it cannot be ordered against the other`,
    };
  }
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (repo[part] > sdk[part]) return {kind: 'above'};
    if (repo[part] < sdk[part]) return {kind: 'below'};
  }
  return {kind: 'same'};
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

/**
 * The mise tool KEY this component pins — and the fingerprint that proves the
 * SDK pinned it (dchjw.19).
 *
 * Deliberately the whole quoted key, never the bare word `beads_rust`:
 * `~/Dev/life`'s mise.toml carries a PROSE COMMENT saying beads_rust was
 * removed in 2026-07, so a substring match on the word reads a repo that
 * deliberately does not have br as one that does. Measured 2026-09-18 (re-run
 * for dchjw.21, correcting an earlier "three times" here): that file contains
 * `beads_rust` on ONE line, a comment, and this key on none.
 */
export const BEADS_MISE_TOOL_KEY = '"github:Dicklesworthstone/beads_rust"';

/** The `[tools]` table HEADER — a whole line, never the substring. */
const MISE_TOOLS_HEADER = /^[ \t]*\[tools\][ \t]*$/m;

/**
 * The tool key as an ENTRY: at the start of a line (leading whitespace only),
 * followed by `=`. A `#` comment line cannot match, because `#` is neither a
 * space nor a tab.
 */
const BEADS_MISE_ENTRY_LINE = new RegExp(
  `^[ \\t]*${BEADS_MISE_TOOL_KEY}[ \\t]*=`,
  'm',
);

/** The same entry, with its `version = "…"` captured in group 2 for rewriting. */
const BEADS_MISE_ENTRY_VERSION = new RegExp(
  `^([ \\t]*${BEADS_MISE_TOOL_KEY}[ \\t]*=[ \\t]*\\{[^}]*version[ \\t]*=[ \\t]*")([^"]+)(")`,
  'm',
);

/**
 * What pinning beads_rust in a mise.toml would do to it — four distinct facts,
 * never collapsed into "fine" (home-base-dchjw.21).
 *
 * `unrewritable` is the one that did not exist before: the old code guarded on
 * `content.includes('beads_rust')`, so a file mentioning the tool only in PROSE
 * passed the guard, the version regex found nothing, `String.replace` returned
 * the input unchanged, the identical bytes were written back, and the step
 * printed "Updated mise.toml beads_rust version to X" having changed nothing.
 * `~/Dev/life`'s mise.toml is exactly that file (measured 2026-09-18: one
 * comment line naming beads_rust, zero `[tools]` entries).
 */
export type MiseTomlPinOutcome =
  | {content: string; kind: 'added'}
  | {content: string; from: string; kind: 'updated'}
  | {kind: 'already-pinned'}
  /**
   * The repo pins a br NEWER than the SDK's: kept as it is, never pulled down
   * (home-base-dj5m9.1.3). `pinned` is the version the repo keeps running.
   */
  | {kind: 'kept-higher'; pinned: string}
  /**
   * The repo's pin cannot be ordered against the SDK's (`latest`, `0.7`): kept,
   * because it may be the newer one, and rewriting it could pull it down.
   */
  | {kind: 'kept-unordered'; pinned: string; reason: string}
  | {kind: 'unrewritable'; reason: string};

/**
 * Pure: given a mise.toml's bytes, say what pinning beads_rust to `version`
 * would produce. Every decision anchors on the quoted TOOL KEY at the start of
 * a line — never on the bare word `beads_rust`, which appears in prose.
 */
export function applyBeadsMiseToolPin(
  content: string,
  version: string,
): MiseTomlPinOutcome {
  const entry = `${BEADS_MISE_TOOL_KEY} = { version = "${version}", exe = "br" }`;

  if (BEADS_MISE_ENTRY_LINE.test(content)) {
    const match = BEADS_MISE_ENTRY_VERSION.exec(content);
    if (match == null) {
      return {
        kind: 'unrewritable',
        reason: `mise.toml has a ${BEADS_MISE_TOOL_KEY} entry, but not in the \`{ version = "…" }\` form this step knows how to rewrite. Refusing to guess — nothing was written. Set the version by hand, or delete the entry and re-run.`,
      };
    }
    const from = match[2] ?? '';
    if (from === version) return {kind: 'already-pinned'};
    // Only a pin BELOW the SDK's is rewritten (home-base-dj5m9.1.3).
    const order = compareBrPin(from, version);
    if (order.kind === 'above') return {kind: 'kept-higher', pinned: from};
    if (order.kind === 'same') return {kind: 'already-pinned'};
    if (order.kind === 'unordered') {
      return {kind: 'kept-unordered', pinned: from, reason: order.reason};
    }

    const updated = content.replace(BEADS_MISE_ENTRY_VERSION, `$1${version}$3`);
    if (updated === content) {
      return {
        kind: 'unrewritable',
        reason: `mise.toml's ${BEADS_MISE_TOOL_KEY} version reads "${from}" but rewriting it to "${version}" produced identical bytes. Refusing to report a change that did not happen — nothing was written.`,
      };
    }
    return {content: updated, from, kind: 'updated'};
  }

  const header = MISE_TOOLS_HEADER.exec(content);
  if (header == null) {
    const base =
      content.length === 0 || content.endsWith('\n') ? content : `${content}\n`;
    return {content: `${base}\n[tools]\n${entry}\n`, kind: 'added'};
  }
  const withEntry = content.replace(
    MISE_TOOLS_HEADER,
    `${header[0]}\n${entry}`,
  );
  return {
    content: withEntry.endsWith('\n') ? withEntry : `${withEntry}\n`,
    kind: 'added',
  };
}

/**
 * Pin beads_rust in mise.toml. Returns the br version this repo will run — the
 * SDK's, or the repo's own when that is newer or cannot be ordered
 * (home-base-dj5m9.1.3) — or null when the step failed.
 */
function stepMiseToml(projectRoot: string, version: string): string | null {
  const miseToml = resolve(projectRoot, 'mise.toml');

  if (!existsSync(miseToml)) {
    const entry = `${BEADS_MISE_TOOL_KEY} = { version = "${version}", exe = "br" }`;
    writeFileSync(miseToml, `[tools]\n${entry}\n`);
    success(`Created mise.toml with beads_rust ${version}`);
    return version;
  }

  const content = readFileSync(miseToml, 'utf-8');
  const outcome = applyBeadsMiseToolPin(content, version);

  switch (outcome.kind) {
    case 'already-pinned':
      success(`mise.toml already pins beads_rust ${version}`);
      return version;
    case 'updated':
      writeFileSync(miseToml, outcome.content);
      success(
        `Updated mise.toml beads_rust version ${outcome.from} → ${version}`,
      );
      return version;
    case 'added':
      writeFileSync(miseToml, outcome.content);
      success(
        `Added beads_rust ${version} to mise.toml (it had no ${BEADS_MISE_TOOL_KEY} entry)`,
      );
      return version;
    case 'kept-higher':
      success(
        `mise.toml pins beads_rust ${outcome.pinned}, newer than the SDK's ${version}: kept. beads-setup never pulls a pin down.`,
      );
      return outcome.pinned;
    case 'kept-unordered':
      warn(
        `mise.toml pins beads_rust "${outcome.pinned}": kept, because ${outcome.reason}, and it may be newer than the SDK's ${version}. beads-setup never pulls a pin down.`,
      );
      return outcome.pinned;
    case 'unrewritable':
      fail(outcome.reason);
      return null;
  }
}

function stepInstallBr(projectRoot: string, version: string): boolean {
  // Check if br is already installed and correct version
  const {stdout, exitCode} = exec('br --version', projectRoot);
  if (exitCode === 0) {
    const installed = stdout.replace(/^br\s*/, '').trim();
    if (installed === version) {
      success(`br ${version} already installed`);
      return true;
    }
    log(`br ${installed} installed, want ${version} — upgrading...`);
  }

  // Try mise install first
  const miseResult = exec('mise install --yes', projectRoot);
  if (miseResult.exitCode === 0) {
    const check = exec('br --version', projectRoot);
    if (check.exitCode === 0) {
      success(`br installed via mise: ${check.stdout}`);
      return true;
    }
  }

  // Fallback to direct install — only of a version that names one release. A
  // kept `latest` or `0.7` cannot be downloaded as asked, and guessing one could
  // install a br older than the repo runs (home-base-dj5m9.1.3).
  if (parsePinVersion(version) == null) {
    fail(
      `mise install failed or br is not on PATH, and mise.toml pins beads_rust "${version}", which names no single release to download. Install it with mise by hand.`,
    );
    return false;
  }
  log('mise install failed or br not on PATH — trying direct install...');
  const versionTag = version.startsWith('v') ? version : `v${version}`;
  const curlResult = exec(
    `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`,
    projectRoot,
  );
  if (curlResult.exitCode !== 0) {
    fail(`Failed to install br: ${curlResult.stderr}`);
    return false;
  }

  const verify = exec('br --version', projectRoot);
  if (verify.exitCode === 0) {
    success(`br installed via direct download: ${verify.stdout}`);
    return true;
  }

  // Check ~/.local/bin directly
  const home = process.env.HOME ?? '/root';
  const directBin = resolve(home, '.local/bin/br');
  if (existsSync(directBin)) {
    success(`br installed at ${directBin} (may need PATH update)`);
    return true;
  }

  fail('br could not be installed');
  return false;
}

// ---------------------------------------------------------------------------
// Beads workspace state (home-base-o33r)
// ---------------------------------------------------------------------------

/**
 * Artifacts that git actually CHECKS OUT for a beads workspace. `beads.db` is
 * NOT one of them — `.beads/.gitignore` ignores `*.db`, so a database file is
 * absent from every fresh worktree and every fresh clone of a repo that has had
 * beads for years.
 *
 * This list is the whole point of home-base-o33r: "no beads.db" and "no beads
 * workspace" are two different facts, and conflating them made the sweep re-init
 * every repo it touched — renaming each one's `issue_prefix` to the sweep
 * worktree's directory name and discarding its real configuration.
 */
const TRACKED_BEADS_ARTIFACTS = ['config.yaml', 'issues.jsonl'] as const;

export type BeadsWorkspaceState =
  /** No `.beads/` at all — a genuine first-time initialization. */
  | {kind: 'none'}
  /** A working `br` database is present. */
  | {kind: 'initialized'}
  /**
   * The repo carries a COMMITTED beads workspace but no database in this tree
   * (the normal state of a linked worktree or a fresh clone). Hydration
   * concern, never an init concern — the configuration must not be touched.
   */
  | {artifact: string; kind: 'tracked-not-hydrated'}
  /**
   * `.beads/beads.db` exists and `br list` FAILED on it (home-base-dj5m9.1.3).
   *
   * NOT `legacy`, and never migrated: a failure does not say what the database
   * is. br 0.7.6 exits 6 (SYNC_CONFLICT) on a live 0.1.37 database that still
   * holds WAL frames, and says "do not delete or replace the WAL or rebuild this
   * database from JSONL" (measured 2026-10-26) — which is what moving `.beads/`
   * aside, `br init` and the JSONL import would have done. No `br list` failure
   * is positively known to mean "legacy", so every one stops the run.
   * `exitCode` is null when br did not exit on its own (not found, killed).
   */
  | {detail: string; exitCode: number | null; kind: 'unreadable'}
  /** `.beads/` exists but is not a usable beads_rust workspace. */
  | {kind: 'legacy'; reason: string};

/** br's exit code for SYNC_CONFLICT (br 0.7.6: the DB would not be opened). */
export const BR_EXIT_SYNC_CONFLICT = 6;

/** What `br list` said in a checkout: ok, or how it failed. */
export type BrListProbe =
  | {detail: string; exitCode: number | null; ok: false}
  | {ok: true};

/**
 * `br list --json` in `cwd`, keeping what a failure said. br writes a `--json`
 * call's error body to STDOUT (measured on 0.1.37 and 0.7.6), so the error code
 * is read from there first, then stderr's first line. Shared by beads-setup's
 * workspace probe and doctor's BR_DB.
 *
 * `autoImport: false` adds `--no-auto-import`, so the probe cannot import a
 * JSONL into the database it is only meant to read. beads-setup keeps br's
 * default, as it always ran.
 *
 * Spawned with the live environment (`brSpawnEnv`): Bun's spawnSync without
 * `env` uses a snapshot taken at startup.
 */
export function probeBrList(
  cwd: string,
  options: {autoImport: boolean},
): BrListProbe {
  const args = options.autoImport
    ? ['list', '--json']
    : ['list', '--json', '--no-auto-import'];
  const proc = spawnSync('br', args, {
    cwd,
    encoding: 'utf-8',
    env: brSpawnEnv(undefined),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (proc.error == null && proc.status === 0) return {ok: true};
  const how =
    proc.error != null
      ? `br could not run (${proc.error.message})`
      : proc.status != null
        ? `br list exited ${proc.status}`
        : `br list was killed (${proc.signal ?? 'unknown signal'})`;
  let code: string | null = null;
  try {
    const body = JSON.parse(proc.stdout ?? '') as {
      error?: {code?: unknown; message?: unknown};
    };
    const said = [body.error?.code, body.error?.message]
      .filter((part): part is string => typeof part === 'string')
      .join(': ');
    code = said === '' ? null : said;
  } catch {
    code = null;
  }
  const stderrLine = (proc.stderr ?? '').trim().split('\n')[0] ?? '';
  const said = code ?? (stderrLine === '' ? null : stderrLine);
  return {
    detail: said == null ? how : `${how}: ${said}`,
    exitCode: proc.error != null ? null : proc.status,
    ok: false,
  };
}

/**
 * Why beads-setup stops on an `unreadable` workspace, naming what br said.
 * Exported so the message is assertable without running the installer.
 */
export function unreadableBeadsDbReason(
  projectRoot: string,
  state: {detail: string; exitCode: number | null},
): string {
  const db = resolve(projectRoot, '.beads', 'beads.db');
  const syncConflict =
    state.exitCode === BR_EXIT_SYNC_CONFLICT
      ? " Exit 6 is SYNC_CONFLICT: this br will not open the database as it stands. One measured cause is a database last written by br 0.1.37 that still holds WAL frames, opened by br 0.7.6. br's own instruction for it: have the owning SQLite engine complete a truncating checkpoint, and do not delete or replace the WAL or rebuild the database from JSONL."
      : '';
  return (
    `${db} is present, but ${state.detail}.${syncConflict} ` +
    'beads-setup cannot tell a legacy workspace from a live one this br failed to open, so it refuses: ' +
    'nothing in .beads/ was moved, deleted or re-initialised. Find out why br fails (`br doctor`) before re-running.'
  );
}

/**
 * The `legacy` reason that means "this is a DELIBERATE Dolt (`bd`) workspace",
 * as opposed to a broken or half-migrated br one. Named so the refusal in
 * `runBeadsSetup` matches on a constant rather than on prose that could be
 * reworded out from under it (dchjw.19).
 */
export const DOLT_BACKEND_REASON = 'old Dolt (bd) backend';

/**
 * Classify what kind of beads workspace (if any) `projectRoot` has.
 *
 * Ordering is load-bearing: the `br list` probe only runs when a database file
 * actually exists, so the common worktree case is decided from the filesystem
 * alone and never spawns a process.
 */
export function detectBeadsWorkspace(projectRoot: string): BeadsWorkspaceState {
  const beadsDir = resolve(projectRoot, '.beads');
  if (!existsSync(beadsDir)) return {kind: 'none'};

  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      if (readFileSync(metadataPath, 'utf-8').includes('"dolt"')) {
        return {kind: 'legacy', reason: DOLT_BACKEND_REASON};
      }
    } catch {
      // Unreadable metadata decides nothing — fall through to the other probes.
    }
  }

  if (existsSync(resolve(beadsDir, 'beads.db'))) {
    const check = probeBrList(projectRoot, {autoImport: true});
    if (check.ok) return {kind: 'initialized'};
    return {
      detail: check.detail,
      exitCode: check.exitCode,
      kind: 'unreadable',
    };
  }

  for (const artifact of TRACKED_BEADS_ARTIFACTS) {
    if (existsSync(resolve(beadsDir, artifact))) {
      return {artifact, kind: 'tracked-not-hydrated'};
    }
  }

  return {
    kind: 'legacy',
    reason: '.beads/ exists with neither a database nor a tracked config',
  };
}

/**
 * Why beads-setup must not run here, or null when it may (dchjw.19).
 *
 * A pure function so BOTH directions can be asserted without a network, a
 * package manager or a `br` binary: a test that could only ever prove the
 * refusal fires would pass just as well if it fired on everything.
 */
export function beadsSetupRefusal(projectRoot: string): string | null {
  const workspace = detectBeadsWorkspace(projectRoot);
  // br itself refusing the database (exit 6, SYNC_CONFLICT) stops the run here,
  // before base-setup or the mise pin write anything (home-base-dj5m9.1.3).
  // Every other `br list` failure is left to step 3, which checks again after
  // step 2 has installed the pinned br: before that, "br could not run" is the
  // normal state of a machine that has not installed the pin yet (mise's shim
  // fails until `mise install`), and refusing here would stop the run that
  // installs it.
  if (
    workspace.kind === 'unreadable' &&
    workspace.exitCode === BR_EXIT_SYNC_CONFLICT
  ) {
    return unreadableBeadsDbReason(projectRoot, workspace);
  }
  if (workspace.kind !== 'legacy' || workspace.reason !== DOLT_BACKEND_REASON) {
    return null;
  }
  return (
    `${projectRoot} is a Dolt (\`bd\`) beads workspace — refusing to run beads-setup. ` +
    'This component sets up beads_rust (`br`), and its migration step MOVES `.beads/` aside to re-init. ' +
    'Nothing has been written. If this repo really should move from bd to br, do it by hand, with the database backed up first.'
  );
}

/**
 * The checkout that gives this project its IDENTITY: the MAIN worktree's root.
 *
 * `basename(projectRoot)` is the wrong answer in a linked worktree — there it is
 * the worktree's directory name (`sdk-sweep`), not the repo's. Deriving a beads
 * prefix from it is exactly how home-base-o33r renamed five repos' issue
 * prefixes to `sdk-sweep`.
 *
 * Returns null when git cannot answer (not a repo, bare repo, unusual layout).
 * The caller must treat that as "unknown", never silently substitute a value
 * that looks measured (critical rule 5).
 */
export function mainCheckoutRoot(projectRoot: string): string | null {
  const result = exec('git rev-parse --git-common-dir', projectRoot);
  if (result.exitCode !== 0) return null;
  const raw = result.stdout.trim();
  if (raw.length === 0) return null;
  // `.git` in a primary checkout, an absolute path in a linked worktree.
  const commonDir = resolve(projectRoot, raw);
  if (basename(commonDir) !== '.git') return null;
  return dirname(commonDir);
}

/**
 * The beads prefix for a genuinely uninitialized project, derived from the MAIN
 * checkout's directory name. `ok: false` when the identity could not be
 * measured — a failed derivation must not be representable as a real prefix.
 */
export function deriveBeadsPrefix(
  projectRoot: string,
): {ok: true; prefix: string; source: string} | {ok: false; reason: string} {
  // Three cases, kept distinct on purpose. Only the middle one is the o33r
  // hazard; the first genuinely cannot be a worktree, so the checkout dir IS
  // the identity there — that is a measurement, not a fallback.
  const insideRepo =
    exec('git rev-parse --is-inside-work-tree', projectRoot).exitCode === 0;
  const identityRoot = insideRepo ? mainCheckoutRoot(projectRoot) : projectRoot;
  if (identityRoot == null) {
    return {
      ok: false,
      reason:
        `${projectRoot} is inside a git repository, but its main checkout root ` +
        'could not be resolved (`git rev-parse --git-common-dir` gave no usable ' +
        'answer). Refusing to guess a beads prefix from the checkout directory — ' +
        'in a worktree that is the worktree name, not the repo (home-base-o33r). ' +
        'Run `br init --prefix <name>` by hand.',
    };
  }
  const rawPrefix = basename(identityRoot);
  const prefix = kebabCase(rawPrefix);
  if (prefix.length === 0) {
    return {
      ok: false,
      reason: `cannot derive a valid beads prefix from directory name "${rawPrefix}". Rename the directory or run br init manually.`,
    };
  }
  return {ok: true, prefix, source: identityRoot};
}

/**
 * Add the sync keys beads-setup owns to a `.beads/config.yaml`, preserving
 * every other line exactly.
 *
 * Pure, and deliberately a MERGE rather than a template render: the whole-file
 * overwrite this replaces is what silently discarded each repo's real
 * configuration (home-base-o33r fix shape 3). `issue_prefix` is never read and
 * never written here.
 */
export function mergeBeadsSyncConfig(original: string): string {
  const lines = original.split('\n');
  const syncIndex = lines.findIndex((line) => /^sync:\s*$/.test(line));

  if (syncIndex === -1) {
    const base =
      original.length === 0 || original.endsWith('\n')
        ? original
        : `${original}\n`;
    return `${base}\n# Sync behavior\nsync:\n  auto_import: true\n  auto_flush: true\n`;
  }

  // The block is the indented (or blank) run of lines after `sync:`.
  let end = syncIndex + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (line.trim() === '' || /^\s+\S/.test(line)) {
      end++;
      continue;
    }
    break;
  }
  while (end > syncIndex + 1 && (lines[end - 1] ?? '').trim() === '') end--;

  const block = lines.slice(syncIndex + 1, end);
  for (const key of ['auto_import', 'auto_flush'] as const) {
    const keyIndex = block.findIndex((line) =>
      new RegExp(`^\\s*${key}\\s*:`).test(line),
    );
    if (keyIndex === -1) {
      block.push(`  ${key}: true`);
    } else {
      block[keyIndex] = (block[keyIndex] ?? '').replace(
        new RegExp(`^(\\s*${key}\\s*:).*$`),
        '$1 true',
      );
    }
  }

  return [...lines.slice(0, syncIndex + 1), ...block, ...lines.slice(end)].join(
    '\n',
  );
}

/**
 * The `.beads/.gitignore` lines br 0.7.6 needs that a workspace an older br
 * made does not have (home-base-dj5m9.1.5, item 5).
 *
 * `.beads/.gitignore` is written once, by the `br init` that made the
 * workspace, and every enrolled repo was made by br 0.1.37 or older. MEASURED
 * 2026-10-29 (`bun run measure:br-local-files`, br 0.1.37 → 0.7.6, with
 * home-base's own ignore files): br 0.7.6's ordinary commands leave five
 * sidecars beside the DB that the old file does not ignore —
 * `beads.db-fsqlite-ns-gate`, `beads.db-fsqlite-ns-use`, `beads.db-wal-cert`,
 * `beads.db-wal-cert-head`, `beads.db.fsqlite-migration-state` — so
 * `git add -A`, or step 9's `git add .beads/`, would commit them. And its
 * first open of a 0.1.37 DB rebuilds it from the JSONL and keeps the old DB in
 * `.br_recovery/`, which 0.1.37's `br init` never listed (home-base added it
 * by hand). br 0.7.6 does not add these lines itself until a
 * `br doctor --repair`, which appends exactly the ones missing (and leaves
 * the file modified). Its own `br init` writes all of them. With them
 * present, `doctor --repair` leaves the file alone.
 */
export const BR076_BEADS_IGNORE_ENTRIES: readonly string[] = [
  '*.db-wal*',
  '*-fsqlite-ns-gate',
  '*-fsqlite-ns-use',
  '*.vacuum-wal-cert*',
  '*.fsqlite-migration-state',
  '.br-wal-index-*/',
  '.br_recovery/',
];

// ---------------------------------------------------------------------------
// Legacy `.beads/` migration — MOVE, never delete (home-base-dchjw.20)
// ---------------------------------------------------------------------------

/**
 * Entry names a beads_rust `.beads/` directory is KNOWN to contain.
 *
 * Measured 2026-09-18 across three real workspaces (home-base primary,
 * a home-base linked worktree, ~/Dev/life). This is an allowlist on purpose:
 * migration touches the directory only when it recognises everything in it, so
 * an unrecognised entry stops the run instead of being swept along by a
 * classification nobody checked (home-base-dchjw.20).
 */
const KNOWN_BEADS_ENTRIES: ReadonlySet<string> = new Set([
  '.br_history',
  '.br_recovery',
  '.gitignore',
  '.local_version',
  '.sync.lock',
  '.write.lock',
  'beads.base.jsonl',
  'beads.db',
  'beads.db-shm',
  'beads.db-wal',
  'config.yaml',
  'daemon.log',
  'issues.jsonl',
  'last-touched',
  'metadata.json',
]);

/**
 * Per-process lock files: `.br-db-openers-<hex>.lock`, `.br-db-write-<hex>.lock`,
 * and from br 0.7.6 `.br-db-openers-<hex>.transition.lock` and
 * `.br-jsonl-write-<hex>.lock` (seen in a 0.7.6 `.beads/` on 2026-10-29, with
 * `beads.base.jsonl` above; 0.1.37's own `.beads/.gitignore` already ignores
 * all of them, so they are not in `BR076_BEADS_IGNORE_ENTRIES`).
 */
const KNOWN_BEADS_ENTRY_PATTERNS: readonly RegExp[] = [
  /^\.br-(?:db|jsonl)-[a-z]+-[0-9a-f]+(?:\.transition)?\.lock$/,
];

/**
 * A `.gitignore` glob from `BR076_BEADS_IGNORE_ENTRIES` as a whole-name
 * pattern: `*` is any run of characters, and a trailing `/` (a directory) is
 * dropped, since a directory listing names it without one.
 */
function ignoreGlobPattern(glob: string): RegExp {
  const body = glob
    .replace(/\/$/, '')
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * br 0.7.6's local files, recognised from the SAME list the `.gitignore`
 * step writes (home-base-dj5m9.1.6 F8), so the two cannot drift.
 */
const BR076_ENTRY_PATTERNS: readonly RegExp[] =
  BR076_BEADS_IGNORE_ENTRIES.map(ignoreGlobPattern);

/**
 * Entries that only a Dolt (`bd`) workspace has. Checked IN ADDITION to
 * `metadata.json`'s backend field, because a Dolt workspace whose metadata is
 * missing or unreadable is still a Dolt workspace.
 */
const DOLT_LAYOUT_ENTRIES: ReadonlySet<string> = new Set(['embeddeddolt']);

function isKnownBeadsEntry(name: string): boolean {
  if (KNOWN_BEADS_ENTRIES.has(name)) return true;
  return [...KNOWN_BEADS_ENTRY_PATTERNS, ...BR076_ENTRY_PATTERNS].some(
    (pattern) => pattern.test(name),
  );
}

export type LegacyBeadsInspection =
  /** Every entry is recognised; migration may move the directory aside. */
  | {entries: string[]; jsonlPath: string | null; ok: true}
  /** Migration must not touch this directory. `reason` says exactly why. */
  | {ok: false; reason: string};

/**
 * Decide whether a legacy `.beads/` is one migration understands well enough to
 * move — the positive-proof half of home-base-dchjw.20.
 *
 * Pure and exported so BOTH directions are assertable from fixtures with no
 * `br`, no network and no package manager: a test that could only ever prove
 * the refusal fires would pass just as well if it fired on everything.
 *
 * Refuses, distinctly, on: a `.beads` that is not a real directory, a
 * directory it cannot read, a Dolt layout, and the first entry it does not
 * recognise. Unknown is never "fine" (critical rule 6).
 */
export function inspectLegacyBeadsDir(
  projectRoot: string,
): LegacyBeadsInspection {
  const beadsDir = resolve(projectRoot, '.beads');

  let stats;
  try {
    stats = lstatSync(beadsDir);
  } catch (error) {
    return {
      ok: false,
      reason: `${beadsDir} could not be inspected (${String(error)}) — refusing to migrate something this run cannot see.`,
    };
  }
  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      reason: `${beadsDir} is a SYMLINK, not a directory. Refusing to migrate — moving the link would leave the real workspace somewhere this run never looked. Resolve it by hand.`,
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: `${beadsDir} is not a directory. Refusing to migrate anything this run does not recognise.`,
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(beadsDir).sort();
  } catch (error) {
    return {
      ok: false,
      reason: `${beadsDir} could not be listed (${String(error)}) — refusing to migrate a directory whose contents are unknown.`,
    };
  }

  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      if (readFileSync(metadataPath, 'utf-8').includes('"dolt"')) {
        return {
          ok: false,
          reason: `${beadsDir} is a Dolt (\`bd\`) workspace (metadata.json names the dolt backend) — refusing to migrate it. Moving a live bd database out from under \`bd\` is a human-sized decision; nothing has been touched.`,
        };
      }
    } catch {
      // Unreadable metadata decides nothing on its own — the entry scan below
      // still has to recognise everything before anything moves.
    }
  }

  const doltEntry = entries.find((entry) => DOLT_LAYOUT_ENTRIES.has(entry));
  if (doltEntry != null) {
    return {
      ok: false,
      reason: `${beadsDir} carries a Dolt (\`bd\`) layout (\`${doltEntry}\`) — refusing to migrate it. Nothing has been touched.`,
    };
  }

  const unknown = entries.filter((entry) => !isKnownBeadsEntry(entry));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `${beadsDir} contains ${unknown.length} entr${unknown.length === 1 ? 'y' : 'ies'} this migration does not recognise: ${unknown.join(', ')}. Refusing to move a directory whose contents it cannot account for. Nothing has been touched — look at them, then migrate by hand.`,
    };
  }

  const jsonl = resolve(beadsDir, 'issues.jsonl');
  const hasIssues =
    existsSync(jsonl) && readFileSync(jsonl, 'utf-8').trim().length > 0;

  return {entries, jsonlPath: hasIssues ? jsonl : null, ok: true};
}

export type LegacyBeadsMigration =
  /** The directory was moved aside intact; nothing was deleted. */
  | {
      jsonlPath: string | null;
      kept: string[];
      kind: 'moved';
      movedTo: string;
    }
  /** Nothing was written. `reason` is the message to print. */
  | {kind: 'refused'; reason: string};

/**
 * Move a legacy `.beads/` to `.beads.legacy-<timestamp>/` beside it.
 *
 * home-base-dchjw.20: this used to `cpSync` the directory into `tmp/` and then
 * `rmSync(.beads, {recursive: true, force: true})` — an unattended deletion
 * decided by a CLASSIFICATION rather than by positive proof, with no flag, no
 * prompt and no dry-run, keeping only whatever `issues.jsonl` the copy happened
 * to contain. A rename is strictly safer than copy-then-delete: it is atomic,
 * it keeps every byte including the ones the copy never enumerated, and there
 * is no window in which the data exists only in a half-written second place.
 * `tmp/` was also the wrong home — it is gitignored and disposable by
 * convention, so the one surviving copy lived where a cleanup would take it.
 *
 * The destination sits next to `.beads/` where `git status` shows it, and is
 * never reused: an existing target refuses rather than being renamed over
 * (POSIX rename replaces an empty target directory silently).
 */
export function moveLegacyBeadsAside(
  projectRoot: string,
  options: {now?: Date} = {},
): LegacyBeadsMigration {
  const inspection = inspectLegacyBeadsDir(projectRoot);
  if (!inspection.ok) return {kind: 'refused', reason: inspection.reason};

  const beadsDir = resolve(projectRoot, '.beads');
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const movedTo = resolve(projectRoot, `.beads.legacy-${timestamp}`);

  if (existsSync(movedTo)) {
    return {
      kind: 'refused',
      reason: `${movedTo} already exists — refusing to move .beads/ onto it. Nothing has been touched; move or rename the existing directory first.`,
    };
  }

  try {
    renameSync(beadsDir, movedTo);
  } catch (error) {
    return {
      kind: 'refused',
      reason: `Could not move ${beadsDir} to ${movedTo} (${String(error)}). Nothing has been deleted.`,
    };
  }

  const jsonlPath =
    inspection.jsonlPath == null ? null : resolve(movedTo, 'issues.jsonl');

  return {jsonlPath, kept: inspection.entries, kind: 'moved', movedTo};
}

function stepMigrateOldBeads(
  projectRoot: string,
  state: BeadsWorkspaceState,
): {
  hadOldData: boolean;
  jsonlPath: string | null;
  movedTo: string | null;
  ok: boolean;
} {
  const untouched = {
    hadOldData: false,
    jsonlPath: null,
    movedTo: null,
    ok: true,
  };

  if (state.kind === 'none') {
    return untouched;
  }
  if (state.kind === 'initialized') {
    success('beads_rust already initialized and working');
    return untouched;
  }
  if (state.kind === 'tracked-not-hydrated') {
    // home-base-o33r: a committed workspace with no checked-out database. NOT a
    // migration — backing it up and deleting it is how the real config got
    // discarded. Say what was measured, and leave the directory alone.
    success(
      `beads workspace already present (.beads/${state.artifact} is committed); ` +
        'no database in this tree — hydration concern, not init. Leaving .beads/ untouched.',
    );
    return untouched;
  }
  if (state.kind === 'unreadable') {
    // home-base-dj5m9.1.3: a failing `br list` never licenses a move aside.
    fail(unreadableBeadsDbReason(projectRoot, state));
    return {hadOldData: false, jsonlPath: null, movedTo: null, ok: false};
  }

  log(`Migrating legacy .beads/ (${state.reason})`);

  const migration = moveLegacyBeadsAside(projectRoot);
  if (migration.kind === 'refused') {
    fail(migration.reason);
    return {hadOldData: false, jsonlPath: null, movedTo: null, ok: false};
  }

  success(
    `Moved .beads/ to ${basename(migration.movedTo)}/ — NOTHING was deleted. Kept ${migration.kept.length} entr${migration.kept.length === 1 ? 'y' : 'ies'}: ${migration.kept.join(', ')}`,
  );
  if (migration.jsonlPath == null) {
    warn(
      'No non-empty issues.jsonl in the moved directory — there is nothing to import from it. Every file it held is still there.',
    );
  } else {
    success(`Found exportable issues at ${migration.jsonlPath}`);
  }

  return {
    hadOldData: true,
    jsonlPath: migration.jsonlPath,
    movedTo: migration.movedTo,
    ok: true,
  };
}

/**
 * Initialize a beads workspace — ONLY when the project genuinely has none.
 *
 * home-base-o33r: this used to decide from `existsSync('.beads/beads.db')`,
 * which is false in every worktree (the db is gitignored), so it re-inited
 * repos that already had a workspace and overwrote their config.yaml wholesale.
 * The decision now comes from `detectBeadsWorkspace`, and the config write is a
 * targeted merge.
 */
function stepInitBeads(
  projectRoot: string,
  state: BeadsWorkspaceState,
): boolean {
  if (state.kind === 'initialized') {
    success('beads_rust already initialized');
    return true;
  }
  if (state.kind === 'tracked-not-hydrated') {
    success(
      `beads_rust workspace already committed (.beads/${state.artifact}) — not re-initializing`,
    );
    return true;
  }
  if (state.kind === 'unreadable') {
    // Unreachable through runBeadsSetup (step 3 stops first); kept so no path
    // ever runs `br init` over a database br failed to open.
    fail(unreadableBeadsDbReason(projectRoot, state));
    return false;
  }

  const derived = deriveBeadsPrefix(projectRoot);
  if (!derived.ok) {
    fail(derived.reason);
    return false;
  }
  const {prefix} = derived;
  const result = exec(`br init --prefix '${prefix}'`, projectRoot);
  if (result.exitCode !== 0) {
    fail(`br init failed: ${result.stderr}`);
    return false;
  }
  success(`Initialized beads_rust with prefix "${prefix}"`);

  // Configure auto-sync — merged into whatever br init wrote, never a
  // whole-file template overwrite (home-base-o33r).
  const configPath = resolve(projectRoot, '.beads', 'config.yaml');
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf-8');
    const merged = mergeBeadsSyncConfig(config);
    if (merged !== config) {
      writeFileSync(configPath, merged);
      success('Configured auto-sync in config.yaml');
    }
  }

  return true;
}

/**
 * The import that seeds a freshly-initialised workspace from the migrated JSONL. Exported so the regression test can run the EXACT shipped invocation rather than its own idea of it.
 *
 * `--force` used to be on this line, and it is a hard delete waiting for a caller. Measured on br 0.1.37 (the pinned version) and br 0.4.1: `br sync --import-only --force` DELETES — not tombstones — every issue in the database that the JSONL lacks, taking its comments, dependencies and labels with it, and exits 0 while reporting only what it "Created". Adding `--orphans allow` does not change that by one row; the two invocations produce identical destruction. For contrast, on 0.1.37 the documented destructive flag `--rebuild` TOMBSTONES those rows and says "Orphans removed: 1 issues (not in JSONL)"; on 0.4.1 `--rebuild` no longer exists at all.
 *
 * It was also unnecessary here. The comment it carried — "ensures we re-import even if br thinks the JSONL hash is unchanged" — cannot apply on this path: the step only runs after `stepMigrateOldBeads` moved `.beads/` aside and `stepInitBeads` created a new one, so the stored hash belongs to the empty JSONL `br init` wrote and never to the non-empty copy laid over it. Measured: a plain `--import-only` into a fresh init imports every issue, comment, dependency and label. That made `--force` a destructive capability shipped into every enrolled repo in exchange for nothing.
 *
 * `--orphans allow` stays: legacy `bd` exports often carry dependency references to deleted issues, and strict mode rejects the referring issues instead of importing them.
 */
export const BEADS_IMPORT_COMMAND = 'br sync --import-only --orphans allow';

/**
 * What the import step PROVED, kept as four distinct facts.
 *
 * `verified` is the only one that licenses removing the moved-aside directory
 * under `--yes`: "the import ran" and "every issue that was in the moved
 * directory is now in the new workspace" are different claims, and only the
 * second one makes deleting the old copy safe (critical rule 6).
 */
export type BeadsImportResult =
  | {count: number; kind: 'verified'}
  | {detail: string; kind: 'unverified'}
  | {kind: 'failed'}
  | {kind: 'nothing-to-import'};

function stepImportIssues(
  projectRoot: string,
  jsonlPath: string | null,
): BeadsImportResult {
  if (jsonlPath == null) return {kind: 'nothing-to-import'};

  const targetJsonl = resolve(projectRoot, '.beads', 'issues.jsonl');
  log(`Importing issues from ${jsonlPath}...`);

  // How many issues the moved-aside file holds. `null` when it could not be
  // read — NOT 0, which would make an unreadable source look like an empty one
  // and turn "nothing was lost" into a claim nobody measured.
  let sourceCount: number | null = null;
  try {
    sourceCount = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '').length;
  } catch {
    sourceCount = null;
  }

  // Copy JSONL into .beads/
  cpSync(jsonlPath, targetJsonl, {force: true});

  const result = exec(BEADS_IMPORT_COMMAND, projectRoot);
  if (result.exitCode !== 0) {
    fail(`${BEADS_IMPORT_COMMAND} failed: ${result.stderr}`);
    return {kind: 'failed'};
  }

  // Verify with --all (br list defaults to excluding closed issues)
  const verify = exec('br list --all --json', projectRoot);
  if (verify.exitCode !== 0) {
    warn('br list failed after import — verify manually');
    return {detail: 'br list failed after the import', kind: 'unverified'};
  }

  let count: number | null = null;
  try {
    const data = JSON.parse(verify.stdout) as {issues?: unknown[]};
    count = data.issues?.length ?? null;
  } catch {
    count = null;
  }
  if (count == null) {
    success('Issues imported (could not parse count)');
    return {
      detail: 'the imported issue count could not be parsed',
      kind: 'unverified',
    };
  }
  if (sourceCount == null) {
    success(`Imported ${count} issues`);
    return {
      detail: 'the source issue count could not be read',
      kind: 'unverified',
    };
  }
  if (count < sourceCount) {
    warn(
      `Imported ${count} issues, but source had ${sourceCount}. Some may have been dropped.`,
    );
    return {
      detail: `imported ${count} of ${sourceCount} source issues`,
      kind: 'unverified',
    };
  }

  success(`Imported ${count} issues (source had ${sourceCount})`);
  return {count, kind: 'verified'};
}

// NOTE: beads-setup deliberately does NOT generate AGENTS.md and does NOT run
// `br agents --add`. The beads workflow guidance is authored once in the prompts
// repo (`~/Dev/prompts/src/rules/beads-workflow.md`) and delivered to every
// session by the `prime` SessionStart hook + `~/.claude/rules/`. `br agents`
// output is upstream-owned (beads_rust src/cli/commands/agents.rs) and had
// drifted from Justin's guidance — it still referenced `bd`, `br sync
// --flush-only`, and a session protocol that no longer applies now that every
// project auto-flushes. Installing a second, staler copy per-project was worse
// than having none. See home-base-t6a0.14.

/**
 * The root `.gitignore` line for `br doctor --repair`'s per-run directory: br
 * 0.7.6 writes `.doctor/` at the REPO ROOT (from a linked worktree too, into
 * the primary checkout it acts on) and appends this line to the root
 * `.gitignore`, creating the file when there is none. Present beforehand, br
 * leaves the file alone (measured with measure-br-local-files, 2026-10-29).
 */
export const BR_DOCTOR_ROOT_IGNORE_ENTRY = '.doctor/';

/**
 * The ROOT `.gitignore` lines this step ensures: each `.beads/.gitignore`
 * pattern anchored under `.beads/`, then `.doctor/`.
 *
 * In the ROOT file, not `.beads/.gitignore`, on purpose: beads-setup never
 * changes a committed `.beads/` (home-base-o33r AC2b: a sweep leaves `.beads`
 * with no git-visible change; dj5m9.1.3: a run whose br cannot open the DB
 * leaves `.beads/` byte for byte). A pattern with a slash in it is anchored
 * to the ignore file's directory, so `.beads/*.db-wal*` ignores exactly what
 * `*.db-wal*` does inside `.beads/` (`*` never crosses a `/`). The one
 * difference: `br doctor --repair` still appends its lines to
 * `.beads/.gitignore`, since it reads only that file. home-base's own
 * `.beads/.gitignore` carries them by hand for that reason.
 */
export const BR076_ROOT_IGNORE_ENTRIES: readonly string[] = [
  ...BR076_BEADS_IGNORE_ENTRIES.map((pattern) => `.beads/${pattern}`),
  BR_DOCTOR_ROOT_IGNORE_ENTRY,
];

/**
 * Make the root `.gitignore` cover br 0.7.6's local files
 * (`BR076_ROOT_IGNORE_ENTRIES`). Returns the entries it appended.
 * Idempotent: a second run changes nothing.
 */
export function ensureBeadsGitignores(projectRoot: string): readonly string[] {
  return ensureIgnoreEntries(
    resolve(projectRoot, '.gitignore'),
    BR076_ROOT_IGNORE_ENTRIES,
    {
      sectionHeader:
        'br 0.7.6 local files: DB sidecars, recovery copies, br doctor runs',
    },
  ).added;
}

function stepBeadsGitignores(projectRoot: string): boolean {
  const added = ensureBeadsGitignores(projectRoot);
  success(
    added.length > 0
      ? `Added ${added.length} br 0.7.6 local-file pattern(s) to .gitignore`
      : '.gitignore already covers br 0.7.6 local files',
  );
  return true;
}

function stepPrettierIgnore(projectRoot: string): boolean {
  const prettierIgnore = resolve(projectRoot, '.prettierignore');
  // Normalized-line matching, so an existing `.beads/` is recognised rather
  // than joined by a second spelling (home-base-dchjw.6).
  const {changed: added} = ensureIgnoreEntries(prettierIgnore, ['.beads'], {
    sectionHeader: 'Beads issue tracker data',
  });
  if (added) {
    success('Added .beads to .prettierignore');
  } else {
    success('.prettierignore already includes .beads');
  }
  return true;
}

function stepClaudeSettings(projectRoot: string): boolean {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  ensureDir(resolve(projectRoot, '.claude'));

  const settings = readJson(settingsPath) ?? {};
  const sandbox = (settings.sandbox ?? {}) as Record<string, unknown>;
  const excluded = (sandbox.excludedCommands ?? []) as string[];

  if (excluded.includes('br')) {
    success('.claude/settings.json already excludes br from sandbox');
    return true;
  }

  excluded.push('br');
  sandbox.excludedCommands = excluded;
  settings.sandbox = sandbox;
  writeJson(settingsPath, settings);
  success('Added br to .claude/settings.json sandbox exclusions');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeadsSetupOptions {
  /** Skip git commit at the end */
  noCommit?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests) */
  quiet?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
  /**
   * `--yes`: after a legacy `.beads/` has been MOVED to `.beads.legacy-<ts>/`
   * and its issues have been imported and COUNTED back, delete the moved
   * directory. Default false, and the only path to a deletion in this whole
   * component (home-base-dchjw.20).
   *
   * Every precondition is load-bearing: no move, no delete; no verified import,
   * no delete. `--yes` says "I accept losing the moved copy", never "delete
   * whatever you could not verify".
   */
  yes?: boolean;
}

export async function runBeadsSetup(
  options: BeadsSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const version = getPinnedVersion();

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up beads_rust ${version} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step -1: REFUSE on a Dolt workspace, before anything at all is written.
  //
  // This guard is the reason dchjw.19 exists. `stepMigrateOldBeads` classifies a
  // Dolt `.beads/` as `legacy`, and until dchjw.20 it then ran `rmSync(.beads,
  // {recursive: true, force: true})` — an unattended DELETION of the issue
  // database, with no flag, no prompt and no dry-run, keeping only whatever
  // `issues.jsonl` it happened to find in the copy it made first. `~/Dev/life`
  // is a Dolt workspace ON PURPOSE (it uses `bd`, every coding repo uses `br`),
  // and the first full-fleet `sweep --component install --dry-run` said
  // `life: adopt: beads-setup` — one non-dry run away from destroying it.
  //
  // dchjw.20 made the migration step itself non-destructive (it MOVES `.beads/`
  // aside and refuses outright on a Dolt layout or an entry it does not
  // recognise). This refusal stays as the OUTER guard: two independent reasons
  // not to touch a bd workspace are the point, and this one fires before
  // base-setup writes anything at all.
  //
  // So the refusal is here, ahead of base-setup, rather than only in adoption and
  // in the `includeIf` gate: those two decide what a SWEEP does, and this decides
  // what the INSTALLER does however it is reached — `install` applies a listed
  // component even when its includeIf fails ("Applying it anyway because the
  // config asks for it"), and `justin-sdk beads` can be typed directly.
  //
  // There is deliberately NO --force. A flag here would turn "I cannot verify
  // this is safe" into "delete it anyway", which is the hazard the whole
  // remove-by-identity design exists to remove. Migrating a real bd workspace to
  // br is a human-sized decision made with a human present, not a sweep payload.
  const refusal = beadsSetupRefusal(projectRoot);
  if (refusal != null) {
    fail(refusal);
    return 1;
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // This creates justin-sdk.config.json, package.json scripts,
  // scripts/setup-env.ts, .gitignore entries, and .claude/settings.json.
  // Pre-registers 'beads-setup' as a component so we don't have to
  // update the config file twice.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with beads-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: mise.toml. It returns the br this repo runs: the SDK's pin, or the
  // repo's own when that is newer (home-base-dj5m9.1.3: never pulled down).
  stepHeader('1. mise.toml');
  const brVersion = stepMiseToml(projectRoot, version);
  if (brVersion == null) return 1;

  // Step 2: Install br
  stepHeader('2. Install br');
  if (!stepInstallBr(projectRoot, brVersion)) return 1;

  // Step 3: Handle existing .beads/ data
  stepHeader('3. Migration check');
  // Classified ONCE, before anything is moved or deleted, and reused by both
  // steps — so "already has a workspace" cannot be answered differently by the
  // migration step and the init step (home-base-o33r).
  const state = detectBeadsWorkspace(projectRoot);
  const migration = stepMigrateOldBeads(projectRoot, state);
  if (!migration.ok) {
    if (state.kind === 'unreadable') {
      // Steps 0–2 have run by now; say so, since a changed pin changes which br
      // opens this database (home-base-dj5m9.1.3).
      warn(
        'Steps 0–2 already ran, and anything they changed (mise.toml among them) is in the working tree, uncommitted. Check `git status` before re-running.',
      );
    }
    return 1;
  }

  // Step 4: Initialize beads_rust
  stepHeader('4. Initialize beads_rust');
  if (!stepInitBeads(projectRoot, state)) return 1;

  // Step 5: Import old issues from the directory step 3 moved aside.
  let importResult: BeadsImportResult = {kind: 'nothing-to-import'};
  if (migration.hadOldData) {
    stepHeader('5. Import issues');
    importResult = stepImportIssues(projectRoot, migration.jsonlPath);
    if (importResult.kind === 'failed') return 1;
  }

  // Step 5b: the ONLY deletion in this component, and it happens here rather
  // than in step 3 on purpose — `migration.jsonlPath` points INTO the moved
  // directory, so removing it any earlier would delete the file step 5 reads.
  //
  // It needs all three: an explicit `--yes`, a completed move, and an import
  // whose issue count was read back and matched. `unverified` is not a weaker
  // yes — it is "I could not prove the data made it across", and that is
  // precisely when the old copy must stay (critical rule 6).
  if (migration.movedTo != null) {
    const moved = basename(migration.movedTo);
    if (options.yes !== true) {
      success(
        `Kept ${moved}/ — the pre-migration .beads/, moved aside intact. Delete it yourself once you have checked the import, or re-run with --yes.`,
      );
    } else if (importResult.kind === 'verified') {
      rmSync(migration.movedTo, {force: true, recursive: true});
      success(
        `--yes: removed ${moved}/ after verifying all ${importResult.count} issues imported.`,
      );
    } else {
      const why =
        importResult.kind === 'nothing-to-import'
          ? 'nothing was imported from it'
          : importResult.detail;
      warn(
        `--yes given, but KEEPING ${moved}/: ${why}. Nothing in it is removed until the import is proven.`,
      );
    }
  }

  // Step 6: .prettierignore
  stepHeader('6. .prettierignore');
  if (!stepPrettierIgnore(projectRoot)) return 1;

  // Step 7: .claude/settings.json (add br to sandbox.excludedCommands)
  stepHeader('7. .claude/settings.json');
  if (!stepClaudeSettings(projectRoot)) return 1;

  // Step 8: ignore files for br 0.7.6's local files (home-base-dj5m9.1.5).
  // Before step 9, which stages `.beads/` and `.gitignore`.
  stepHeader('8. Ignore files for br 0.7.6');
  if (!stepBeadsGitignores(projectRoot)) return 1;

  // Step 9: Git commit
  if (options.noCommit !== true) {
    stepHeader('9. Git commit');
    const status = exec('git status --porcelain', projectRoot);
    if (status.stdout.trim().length > 0) {
      // Stage each file individually so one missing file doesn't cause
      // the rest to be silently dropped (home-base-beq).
      const filesToAdd = [
        'mise.toml',
        '.beads/',
        '.claude/settings.json',
        '.prettierignore',
        'justin-sdk.config.json',
        'CLAUDE.md',
        'scripts/setup-env.ts',
        'package.json',
        '.gitignore',
      ];
      for (const path of filesToAdd) {
        const fullPath = resolve(projectRoot, path);
        if (existsSync(fullPath)) {
          exec(`git add '${path}'`, projectRoot);
        }
      }
      const commitResult = exec(
        `git commit -m 'Add beads_rust (br) issue tracking via justin-sdk'`,
        projectRoot,
      );
      if (commitResult.exitCode === 0) {
        success('Committed beads setup');
      } else {
        warn('Git commit failed — you may need to commit manually');
      }
    } else {
      success('No changes to commit');
    }
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mDone!\x1b[0m beads_rust ${brVersion} is ready in ${basename(projectRoot)}.\n`,
    );

    // Remind about agent-only tasks
    const agentTasks: string[] = [];
    const claudeMd = resolve(projectRoot, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8');
      if (content.includes('bd ') || content.includes('bd\n')) {
        agentTasks.push(
          'CLAUDE.md has stale `bd` references — have an agent clean them up',
        );
      }
    }
    if (agentTasks.length > 0) {
      console.log('\x1b[33mRemaining tasks for an agent:\x1b[0m');
      for (const task of agentTasks) {
        console.log(`  • ${task}`);
      }
      console.log('');
    }
  }

  return 0;
}
