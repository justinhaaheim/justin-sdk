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
  COMPONENT_NAMES,
  configNameFor,
  DEPENDENCY_ORDER,
  type ComponentName,
} from './components';
import {getSdkVersion} from './setup-helpers';

/**
 * One line per component. Typed against ComponentName so a new component
 * cannot be added without describing it here.
 */
const COMPONENT_BLURBS: Record<ComponentName, string> = {
  'base-setup':
    'Foundation every other installer self-applies: justin-sdk.config.json, scripts/setup-env.ts, .claude/settings.json scaffolding, tmp/ in .gitignore, and the SDK as a devDependency.',
  beads:
    'Issue tracking via beads. Installs the tool, seeds .beads/, and adds the workflow prompt.',
  'claude-md': 'Generates/refreshes CLAUDE.md with the standard skeleton.',
  eas: 'Expo/EAS build + update + ship scripts. App-only — wrong for a node CLI.',
  eslint: 'Shared ESLint config wired to the project.',
  'gh-actions': 'GitHub Actions workflows (signal on PR).',
  gitignore: 'The full baseline .gitignore.',
  husky: 'Git hooks (pre-commit → lint-staged).',
  prettier: 'Shared Prettier config + .prettierignore.',
  prompts: 'Fetches the shared prompts library into the project.',
  'time-check':
    'UserPromptSubmit hook stamping the wall-clock into the transcript after a long gap or on a new working day. Config: componentConfig["time-check"].',
  tsconfig: 'Shared TypeScript config.',
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

function componentTable(): string {
  const optIn = COMPONENT_NAMES.filter((n) => !DEPENDENCY_ORDER.includes(n));
  const rows: string[] = [];

  rows.push('Installed by `add all` / `init`, in dependency order:');
  for (const name of DEPENDENCY_ORDER) {
    rows.push(`  ${name.padEnd(12)} (${configNameFor(name)})`);
    rows.push(`      ${COMPONENT_BLURBS[name]}`);
  }
  rows.push('');
  rows.push('OPT-IN ONLY — never installed by `add all` or `init`:');
  for (const name of optIn) {
    rows.push(`  ${name.padEnd(12)} (${configNameFor(name)})`);
    rows.push(`      ${COMPONENT_BLURBS[name]}`);
  }
  return rows.join('\n');
}

export function buildSkill(): string {
  return `# justin-sdk — how to use it

Version of the copy you are reading: ${getSdkVersion()}

Shared tooling for Justin's projects. It exists so the same script does not get
copy-pasted into a dozen repos and then drift. When you are tempted to write a
build/lint/setup script that another project probably also needs, check whether
the SDK already has it, and prefer adding it here over forking it there.


## Two ways it runs

1. AS AN INSTALLED DEPENDENCY (the normal case). Projects declare
   \`@justinhaaheim/justin-sdk\` in devDependencies and call \`bunx justin-sdk <cmd>\`.
   \`bunx\` finds the LOCAL copy in node_modules — no network, fast enough for a
   per-prompt hook (~80ms).

2. AS A "STATIC METHOD" (bootstrapping). Before a project has the SDK — or to run
   a one-off — invoke it straight from GitHub:

       bunx github:justinhaaheim/justin-sdk#<ref> <cmd>

   Use this for \`add\`/\`init\` on a project that is not enrolled yet.


## Installing and upgrading

Enroll a project (or add one piece):

    bunx github:justinhaaheim/justin-sdk#main add all       # the standard set
    bunx github:justinhaaheim/justin-sdk#main add <name>    # one component
    bunx justin-sdk add <name>                              # once enrolled

Upgrade an enrolled project:

    bunx justin-sdk update        # re-applies every component in the config,
                                  # self-updating to the latest tag first

\`update\` runs \`self-update\` as its first step: it bumps the pin in
devDependencies to the newest tag and re-execs, so the rest of the run uses the
new code.


## !! bunx and #main: the thing that will bite you

\`bunx github:justinhaaheim/justin-sdk#main <cmd>\` does NOT reliably give you the
latest main. Verified 2026-08-06:

  - bunx caches per REF STRING, in \`$TMPDIR/bunx-501-justin-sdk@github@<hash>\`.
    The hash is derived from the string "#main", not from the commit it resolves
    to, so a stale extraction is reused indefinitely. A run against a day-old
    cache completed in 0.03s with no network — it never re-resolved.
  - That cache also goes CORRUPT (empty dependency stubs), and then every
    invocation dies with \`Cannot find package 'yargs'\` — which looks like a
    dependency bug in the SDK and is not one.

  Fix / force a fresh fetch:

      rm -rf "$TMPDIR"/bunx-*justin-sdk*

  Prefer a version tag when you want determinism:

      bunx github:justinhaaheim/justin-sdk#${getSdkVersion()} <cmd>

  TAG FORMAT: releases are tagged with BARE semver (\`0.13.0\`), not \`v0.13.0\`.
  Older releases (<= 0.12.1) are only \`v\`-prefixed. This matters because
  \`add\` writes the self-pin as \`github:justinhaaheim/justin-sdk#\${version}\`
  with a bare version — against a \`v\`-tagged release that 404s.

  Also: \`--version\` prints "unknown" when run via bunx-from-GitHub. Known bug;
  it does not mean the install failed.


## What it installs — components

Every project carries \`justin-sdk.config.json\` listing the components it has.
\`add <name>\` installs one; \`add all\` installs the standard set; \`update\`
re-applies everything already listed.

${componentTable()}

Per-component settings live under \`componentConfig\` in justin-sdk.config.json,
keyed by the SHORT component name:

    {
      "version": "${getSdkVersion()}",
      "components": ["base-setup", "time-check-setup"],
      "componentConfig": {
        "time-check": {"enabled": true, "gapHours": 8, "notifyOnNewDayBoundaryHour": 0}
      }
    }


## Commands

${captureCommandList()}

Run \`justin-sdk <cmd> --help\` for any command's flags.


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
