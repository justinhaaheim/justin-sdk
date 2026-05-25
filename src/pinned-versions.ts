/**
 * pinned-versions.ts — Single source of truth for dev-tool versions
 * installed by `j add ...` components.
 *
 * Each `add` component reads from this module and runs
 * `bun add -d <pkg>@<PINNED[pkg]>` (or `bun add <pkg>@<PINNED_GITHUB[pkg]>`)
 * so every fresh scaffold gets exactly the same versions.
 *
 * To upgrade: bump the values here, tag a new SDK release, and dependent
 * projects can opt in by re-running `j add <component>`. Doctor will be
 * extended in a later bead to warn when an installed version drifts from
 * what's pinned here.
 *
 * Versions mined from home-base/package.json + eslint-config-jha-react-node
 * (the known-good combination as of 2026-05-19).
 */

export const PINNED = {
  '@types/bun': 'latest',
  eslint: '9.31.0',
  husky: '9.1.7',
  'lint-staged': '16.2.7',
  prettier: '3.6.2',
  typescript: '5.9.2',
} as const;

export const PINNED_GITHUB = {
  'eslint-config-jha-react-node':
    'github:justinhaaheim/eslint-config-jha-react-node',
} as const;

/**
 * The justinhaaheim/prompts repo doesn't use tags or releases — pinning
 * means committing to a specific SHA. To upgrade:
 *  1. cd into the prompts repo, find the desired commit
 *  2. update `sha` below
 *  3. cut a new SDK release
 *  4. consumers receive the bump on next `j update`
 */
export const PROMPTS_PIN = {
  sha: 'bc5994b48b',
  repo: 'justinhaaheim/prompts',
} as const;

export type PinnedPackage = keyof typeof PINNED;
export type PinnedGithubPackage = keyof typeof PINNED_GITHUB;
