/**
 * usage-attribution — which model family a request belongs to, and which
 * project a transcript directory belongs to (request home-base-ys9t7.5).
 *
 * ONE IMPLEMENTATION: both moved here from home-base's
 * src/claude-usage/calibrate.ts, which fitted the quota's dollars-per-percent
 * weights by family and reported spend by project. The quota must classify
 * exactly as the calibration did, or the weights it applies are not the ones
 * that were fitted; calibrate.ts now imports these.
 */
import {homedir} from 'node:os';

// ---------------------------------------------------------------------------
// Model family
// ---------------------------------------------------------------------------

export type Family = 'fable' | 'haiku' | 'opus' | 'other' | 'sonnet';

export const FAMILIES: readonly Family[] = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'other',
];

/** A model id's family: Mythos counts as Fable, as the calibration fitted it. */
export function familyOf(model: string): Family {
  if (/fable|mythos/.test(model)) return 'fable';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return 'other';
}

// ---------------------------------------------------------------------------
// Project of a transcript directory
// ---------------------------------------------------------------------------

/** What Claude Code's project-dir slug of a `.claude/worktrees/<name>` checkout ends with. */
const WORKTREE_SLUG = /--claude-worktrees-.*$/;

/**
 * A project-dir slug with any `.claude/worktrees/<name>` checkout folded into
 * its repo: `-Users-jhaa-Dev-home-base--claude-worktrees-x` →
 * `-Users-jhaa-Dev-home-base`. A slug with no worktree part is returned as is.
 *
 * A session started in a SUBDIRECTORY of the repo has its own slug
 * (`…-home-base-pkg-justin-sdk`) and is not folded: a prefix match would also
 * take `…-home-base-2`, another repo, and the slug cannot tell them apart.
 */
export function foldWorktreeSlug(slug: string): string {
  return slug.replace(WORKTREE_SLUG, '');
}

const HOME_SLUG = `-${homedir().slice(1).replaceAll('/', '-')}-`;

/**
 * A short project name for a slug, worktrees folded into their repo:
 * `-Users-jhaa-Dev-home-base--claude-worktrees-x` → `home-base`.
 */
export function projectOf(slug: string): string {
  const trimmed = slug.startsWith(HOME_SLUG)
    ? slug.slice(HOME_SLUG.length)
    : slug;
  const name = foldWorktreeSlug(trimmed).replace(/^Dev-/, '');
  return name === '' ? slug : name;
}
