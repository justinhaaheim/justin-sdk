/**
 * skill.ts — the on-demand guide to justin-sdk: what it is, how to install and
 * upgrade it, how it runs, and what it touches.
 *
 * ANTI-STALENESS IS THE POINT. `agent.ts` is a hand-maintained playbook whose
 * own header asks the reader to "keep this in sync", which is precisely the
 * promise that never holds. So the two sections that actually churn are
 * DERIVED, not written:
 *
 *   - the component table comes from the real registry in components.ts, and
 *     COMPONENT_BLURBS is typed `Record<ComponentName, string>` so adding a
 *     component without describing it is a COMPILE ERROR;
 *   - the command list is captured from the CLI's own `--help` at runtime, so
 *     it cannot drift from the commands that actually exist.
 *
 * Only the narrative — what the SDK is for, and the gotchas that cost real
 * time — is prose, because that part genuinely needs a human voice.
 */

import {execFileSync} from 'child_process';
import {resolve} from 'path';

import {
  COMPONENT_INCLUDE_IF,
  COMPONENT_NAMES,
  configNameFor,
  IMPLICIT_COMPONENT,
  type ComponentName,
} from './component-registry';
import {getSdkVersion, UNKNOWN_VERSION} from './sdk-identity';

/**
 * One line per component. Typed against ComponentName so a new component
 * cannot be added without describing it here.
 */
const COMPONENT_BLURBS: Record<ComponentName, string> = {
  'base-setup':
    'Foundation every other installer self-applies: justin-sdk.config.json, the shared package.json scripts, the .claude/settings.json SessionStart hook, tmp/ in .gitignore, and the SDK as a devDependency. It DELETES a committed scripts/setup-env.ts whose bytes match a known SDK template — the `setup-env` command superseded it.',
  beads:
    'Issue tracking via beads. Installs the tool, seeds .beads/, and adds the workflow prompt.',
  'critical-rules':
    'Writes the COMMITTED rules artifact .claude/rules/justin-sdk/critical-rules.md (autoloaded at CLAUDE.md priority, no truncation cap, travels to web/CI/fresh clones). Which modules it carries is decided by the prompts rules registry plus the project-type predicates, re-evaluated at EVERY refresh — there is no per-repo module list. Regenerate with `rules-update`; propagate with `sweep --component critical-rules`.',
  eas: 'Expo/EAS build + update + ship scripts. Applies only to an Expo app (includeIf isExpo).',
  eslint: 'Shared ESLint config wired to the project.',
  'gh-actions': 'GitHub Actions workflows (signal on PR).',
  gitignore: 'The full baseline .gitignore.',
  husky: 'Git hooks (pre-commit → lint-staged).',
  prettier: 'Shared Prettier config + .prettierignore.',
  'time-check':
    'UserPromptSubmit hook stamping the wall-clock into the transcript after a long gap or on a new working day. Config: componentConfig["time-check"].',
  'thread-hooks':
    'SessionStart hook (startup|resume) running `thread start`, which creates this session’s thread bead in ~/Dev/threads up front so a session that never reaches a status report is still on the board. INERT until BOTH componentConfig.thread.enabled and .startOnSessionStart are true — set them in the USER file; this installer writes no componentConfig block, because a project-level value would outrank it.',
  tsconfig: 'Shared TypeScript config.',
  'usage-check':
    'UserPromptSubmit + PostToolBatch hook telling the session how many tokens of its OWN context it has used — NOT subscription quota — once per setpoint, every 100k tokens by default. PostToolBatch is what reaches an autonomous session mid-turn. The wrap-up directive is experimental and OFF unless the project sets a numeric wrapUpAt. Config: componentConfig["usage-check"].',
};

/** Capture the CLI's own help so the command list can never drift. */
function captureCommandList(): string {
  try {
    const cliPath = resolve(import.meta.dirname, 'cli.ts');
    const help = execFileSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Keep just the Commands block. Anchor on yargs' section headers rather
    // than on the shape of a command line, which wraps unpredictably when
    // stdout is a pipe rather than a TTY.
    const lines = help.split('\n');
    const start = lines.findIndex((l) => /^Commands:/.test(l));
    if (start === -1) return help.trim();
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (/^[A-Z][A-Za-z ]*:$/.test(line)) break; // next section (Options:, Examples:)
      out.push(line);
    }
    // trimEnd only — leading indentation is part of yargs' alignment.
    return out.join('\n').replace(/^\n+/, '').trimEnd();
  } catch {
    return '  (could not capture — run `justin-sdk --help` directly)';
  }
}

/**
 * Every component and its gate. There is no preset split to print any more: the
 * `core` preset is every component whose `includeIf` passes IN THE REPO YOU ARE
 * IN, so the only honest static table is the registry plus each entry's gate
 * (epic home-base-dchjw D3). `justin-sdk config schema` prints the expansion for
 * the current repo.
 */
function componentTable(): string {
  const rows: string[] = [];
  rows.push(
    '`core` = every component below whose includeIf passes for the repo, except the implicit ' +
      `${IMPLICIT_COMPONENT} (every installer applies it itself). A config with no \`components\` key means core.`,
  );
  rows.push('');
  for (const name of COMPONENT_NAMES) {
    const gate = COMPONENT_INCLUDE_IF[name];
    const suffix =
      name === IMPLICIT_COMPONENT
        ? '  [implicit]'
        : gate != null && gate.length > 0
          ? `  [includeIf ${gate.join(', ')}]`
          : '';
    rows.push(`  ${name.padEnd(14)} (${configNameFor(name)})${suffix}`);
    rows.push(`      ${COMPONENT_BLURBS[name]}`);
  }
  return rows.join('\n');
}

export function buildSkill(): string {
  // Read ONCE: three places in this document quote it, and a document that
  // disagreed with itself about which SDK wrote it would be worse than useless.
  const sdkVersion = getSdkVersion();
  return `# justin-sdk — how to use it

Version of the copy you are reading: ${sdkVersion ?? UNKNOWN_VERSION}

Shared tooling for Justin's projects. It exists so the same script does not get
copy-pasted into a dozen repos and then drift. When you are tempted to write a
build/lint/setup script that another project probably also needs, check whether
the SDK already has it, and prefer adding it here over forking it there.


## How to invoke it — exactly two forms (epic home-base-dchjw, D1)

1. IN AN ENROLLED REPO (the normal case), for you, for agents, and for hooks:

       bun run justin-sdk <cmd>

   \`bun run\` prepends node_modules/.bin to PATH, so this resolves the repo's own
   pinned tag — no network, offline, fast enough for a per-prompt hook (~80ms).
   Hooks run under \`sh\`, not under \`bun run\`, so a hook string must spell the
   \`bun run\` prefix out in full.

   Inside a package.json SCRIPT VALUE, write the BARE bin instead —
   \`"doctor": "justin-sdk doctor"\` — exactly as eslint/prettier/tsc are written.

2. BOOTSTRAP ONLY, in a repo that has never installed the SDK:

       bunx github:justinhaaheim/justin-sdk <cmd>

   Use this for \`init\`/\`add\` on a project that is not enrolled yet, and nowhere
   else. To run the newest published SDK from anywhere, use home-base's
   \`justin-sdk-latest <cmd>\`.

RETIRED, and rewritten by \`install\` wherever they are found: \`bunx
@justinhaaheim/justin-sdk\` (falls through to the npm registry, where the scope is
not demonstrably Justin's — home-base-2qhw), and the bare \`bunx justin-sdk\` /
\`bunx jsdk\` / \`bunx j\` (same fallthrough; \`j\` and \`jsdk\` are REAL unrelated npm
packages). The \`j\` and \`jsdk\` bins no longer exist.


## Installing and upgrading — the npm shape

The component commands mirror npm's, and the split is the point: \`add\` and
\`remove\` edit the MANIFEST (\`justin-sdk.config.json#components\`), \`install\`
makes the DISK match it, and \`update\` is \`install\` with a pin bump in front.

    bunx github:justinhaaheim/justin-sdk init   # enrol: config + devDep + scripts, NO components
    bun run justin-sdk list                     # every component: purpose, installed?, applies?, in config?
    bun run justin-sdk add core                 # install everything that applies to THIS repo
    bun run justin-sdk add beads prettier       # variadic: install specific ones
    bun run justin-sdk remove prettier          # take one back out
    bun run justin-sdk install                  # install what is listed + re-apply; NEVER removes
    bun run justin-sdk install --prune --dry-run # what removing the unlisted ones would take out
    bun run justin-sdk update                   # bump the SDK pin, then install

\`init\` writes the manifest and nothing else — no component files. It leaves
\`components\` OUT of the config, which means "track \`core\`"; \`add core\` is what
installs it. \`add --help\` prints what \`core\` expands to in the repo you run it
in, with the predicates actually evaluated.

\`install\` installs what the config lists and the repo lacks, re-applies the
rest, and NEVER REMOVES. Anything on disk that the config does not list is named
and KEPT: "installed" is evidence like a filename or a matching line, which is
not proof the SDK put it there — a \`.gitignore\` line someone wrote years before
the repo was enrolled is byte-identical to the one the SDK appends.

Removal takes an explicit act: \`remove <name…>\` (you name the component) or
\`install --prune\` (you name the flag). Both remove by identity, never by name —
a file goes only when its bytes are identical to what the component would write
right now, an appended entry (script, ignore line, hook, config block) only on
an exact match, and anything else prints \`left in place (modified): <path>\` and
stays. Content the SDK cannot reconstruct (a beads database, the generated rules
artifact, a composed husky hook) prints \`left in place (content not
reconstructible)\` and is never deleted. There is no \`--force\`.
\`install --prune --dry-run\` prints the whole plan first: every file, every line,
every script, every hook entry and every config key, with its verdict.

\`update\` runs \`self-update\` as its first step: it bumps the pin in
devDependencies to the newest tag and re-execs, so the rest of the run uses the
new code. \`--no-self-update\` skips that and reconciles against the current pin.


## !! bunx and #main: the thing that will bite you (bootstrap only)

\`bunx github:justinhaaheim/justin-sdk#main <cmd>\` does NOT reliably give you the
latest main. Verified 2026-08-06:

  - bunx caches per REF STRING, in \`$TMPDIR/bunx-501-justin-sdk@github@<hash>\`.
    The hash is derived from the string "#main", not from the commit it resolves
    to, so a stale extraction is reused indefinitely. A run against a day-old
    cache completed in 0.03s with no network — it never re-resolved.
  - That cache also goes CORRUPT (empty dependency stubs), and then every
    invocation dies with \`Cannot find package 'yargs'\` — which looks like a
    dependency bug in the SDK and is not one.

  Neither \`--force\` nor \`--no-cache\` busts it — both were measured at 0.04s
  with no network, i.e. still the cached copy. Two things that DO work:

      # 1. isolate the cache (cleanest — touches no shared state)
      TMPDIR=$(mktemp -d) bunx github:justinhaaheim/justin-sdk#main <cmd>

      # 2. evict it
      rm -rf "$TMPDIR"/bunx-*justin-sdk*

  Prefer a version tag when you want determinism:

      bunx github:justinhaaheim/justin-sdk#v${sdkVersion ?? 'X.Y.Z'} <cmd>

  TAG FORMAT: \`v\`-PREFIXED semver (\`v0.16.0\`), always (home-base-v170.15 /
  j2n7.4). The repo carried duplicate bare tags for a while (\`0.14.0\` even
  points at a DIFFERENT commit than \`v0.14.0\`) — never hand-type a bare
  \`#X.Y.Z\` pin; it can silently resolve the wrong tree.

  \`--version\` prints the SDK's OWN version, and \`--help\`'s first line names
  that version and the directory the running copy lives in — which is how you
  tell a pinned tarball in node_modules from a bunx cache dir from
  home-base/pkg/justin-sdk. "${UNKNOWN_VERSION}" there means the SDK could not
  read its own package.json, and nothing else.


## What it installs — components

Every project carries \`justin-sdk.config.json\`. Its \`components\` key is
OPTIONAL: absent means \`core\`, computed for that repo (D3). Only \`add\` and
\`remove\` write it; \`install\` reads it and makes the disk match. \`base-setup\` is
never listed — every installer applies it, so it is implicit.

${componentTable()}

Per-component settings live under \`componentConfig\` in justin-sdk.config.json,
keyed by the SHORT component name:

    {
      "componentConfig": {
        "time-check": {"enabled": true, "gapHours": 8, "notifyOnNewDayBoundaryHour": 0}
      }
    }

That is a COMPLETE config: no \`components\` (so: core), and neither of the two
SDK-version stamps it used to carry — both were write-only and are gone (D3).
\`{}\` works too.

\`config schema\` prints every key of that file, the resolved default of each,
and what \`core\` expands to in the repo you run it in — and of the user-level
\`~/.config/justin-sdk/config.json\`, which holds settings that should apply to
every repo — with its type, default and description. Unknown keys are always
accepted (a config written by a newer SDK must not fail an older one); a known
key with the wrong type is what doctor's CONFIG_SCHEMA check reports.


## Commands

${captureCommandList()}

Run \`justin-sdk <cmd> --help\` for any command's flags.


## Gotchas that have cost real time

- **beads is SPLIT across the fleet, on purpose.** Coding repos use beads_rust
  (\`br\`, SQLite). \`life-management\` deliberately migrated to beads (\`bd\`, Dolt)
  for metadata support, and \`br\` errors there BY DESIGN. Do not "fix" either one
  to match the other, and do not follow any instruction to migrate one to the
  other without checking which repo you are in. A cross-workspace reference
  between the two is string-only.
- **Shell cwd drift.** Sandboxed shells reset the working directory between
  commands. Pass \`-C <repo>\` to git, or use absolute paths, rather than relying
  on a \`cd\` from an earlier call.
- **\`br list\` hides closed issues by default.** An issue that "disappeared" is
  usually closed, not lost.
- **Husky/lint-staged fails on a submodule-only commit.** A gitlink \`lstat\`s as a
  directory and gets handed to prettier. home-base fixes this with \`--no-stash\`
  in \`.husky/pre-commit\`.
- **Never run \`br agents --add\`.**
- **mise can be rate-limited by GitHub**, which surfaces as a confusing install
  failure rather than a rate-limit message.


## Working on the SDK itself

The repo has no ESLint of its own. The bar is:

    bun run tsc --noEmit && bun test

Release: bump \`version\` in package.json (there is no version-manager here),
commit, tag with BARE semver, push both.
`;
}

export function runSkill(): number {
  console.log(buildSkill());
  return 0;
}
