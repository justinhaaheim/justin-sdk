/**
 * The project resolver (home-base-c82t4 D2): which projects this machine knows,
 * and which of them a typed value names. One resolver for `thread sessions`
 * (home-base-c82t4.1) and `thread search --repo` (home-base-c82t4.2).
 *
 * Justin, 2026-11-13: "what are my latest sessions in the X project?" He types
 * a folder name (`shortcut-helpers`) or the tag the session names show
 * (`SHORTCUTS`, `[SHORTCUTS]`), in any case. Both resolve to the folder name,
 * which is what the inbox's repo filter compares.
 *
 * Known projects (D2): every directory directly under the dev root that holds a
 * `.git`, every repo name the sessions index records, and any extra names a
 * caller passes (search passes the repo names of its corpus). Each comes with
 * its tag from `resolveRepoTag`, the builder every session name uses.
 *
 * A value that matches nothing is an error that lists every known project,
 * never an empty listing (D2). A value that matches two projects is an error
 * that names both. When a source could not be read, the known list is
 * incomplete and the error says which source (critical rule 7: "not found"
 * must not stand in for "could not look").
 */

import type {EnvLike} from './paths';
import type {SessionIndexRead} from './session-index';

import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {resolveRepoTag} from './config';
import {matchesRepo} from './open-filters';
import {readSessionIndex} from './session-index';

/** A project: its folder name (what filters compare) and its resolved tag. */
export interface KnownProject {
  folder: string;
  tag: string;
}

export interface KnownProjects {
  /** Sources that could not be read, so the list may be missing projects. */
  problems: string[];
  /** Sorted by folder. */
  projects: KnownProject[];
}

/** What the dev root holds, or why it could not be listed. */
export type DevRootListing =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; names: string[]};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The real dev root listing: its directories that hold a `.git`. */
export function listDevRootRepos(devRoot: string): DevRootListing {
  let names: string[];
  try {
    names = readdirSync(devRoot);
  } catch (error) {
    return {kind: 'failed', reason: `${devRoot}: ${errorText(error)}`};
  }
  return {
    kind: 'read',
    names: names.filter((name) => existsSync(join(devRoot, name, '.git'))),
  };
}

export interface KnownProjectSources {
  devRoot: string;
  env: EnvLike;
  /** Further repo names (search's corpus); a known folder is not repeated. */
  extraNames?: readonly string[];
  /** Injectable for tests; default `listDevRootRepos`. */
  listDevRoot?: (devRoot: string) => DevRootListing;
  /** Injectable for tests; default `readSessionIndex`. */
  readIndex?: (env: EnvLike) => SessionIndexRead;
}

/**
 * Every project this machine knows, each with its tag. A folder found under
 * the dev root takes its tag from that checkout; a repo name only the sessions
 * index knows takes it from the newest checkout the index recorded for it.
 */
export function knownProjects(sources: KnownProjectSources): KnownProjects {
  const {devRoot, env} = sources;
  const problems: string[] = [];
  const tagCache = new Map<string, string | null>();
  const byFolder = new Map<string, KnownProject>();
  const add = (folder: string, checkout: string | null): void => {
    if (folder.trim() === '' || byFolder.has(folder)) return;
    byFolder.set(folder, {
      folder,
      tag: resolveRepoTag({cache: tagCache, checkout, env, repo: folder}),
    });
  };

  const listing = (sources.listDevRoot ?? listDevRootRepos)(devRoot);
  if (listing.kind === 'failed') {
    problems.push(`the dev root could not be listed (${listing.reason})`);
  } else {
    for (const name of listing.names) add(name, join(devRoot, name));
  }

  const index = (sources.readIndex ?? readSessionIndex)(env);
  if (index.kind === 'failed') {
    problems.push(
      `the sessions index could not be read (${index.path}: ${index.error})`,
    );
  } else if (index.kind === 'read') {
    // The newest sighting of a repo names the checkout its tag is read from.
    const newest = new Map<string, {at: string; checkout: string}>();
    for (const session of index.sessions) {
      for (const sighting of session.sightings) {
        if (sighting.repo == null) continue;
        const seen = newest.get(sighting.repo);
        if (seen == null || sighting.at > seen.at) {
          newest.set(sighting.repo, {
            at: sighting.at,
            checkout: sighting.checkoutPath,
          });
        }
      }
    }
    for (const [repo, seen] of newest) add(repo, seen.checkout);
  }

  for (const name of sources.extraNames ?? []) add(name, null);

  return {
    problems,
    projects: [...byFolder.values()].sort((a, b) =>
      a.folder.localeCompare(b.folder),
    ),
  };
}

export type ProjectResolution =
  | {kind: 'ambiguous'; matches: KnownProject[]; value: string}
  | {kind: 'ok'; projects: KnownProject[]}
  | {kind: 'unknown'; values: string[]};

/**
 * D2: each value to the one project whose folder or tag it names
 * (`matchesRepo`'s rules: any case, brackets ignored). Every value must match
 * exactly one project; the projects come back in the values' order, each once.
 */
export function resolveProjects(
  values: readonly string[],
  known: readonly KnownProject[],
): ProjectResolution {
  const resolved: KnownProject[] = [];
  const unknown: string[] = [];
  for (const value of values) {
    const matches = known.filter((project) =>
      matchesRepo({repo: project.folder, repoTag: project.tag}, [value]),
    );
    const [only] = matches;
    if (only == null) {
      unknown.push(value);
      continue;
    }
    if (matches.length > 1) return {kind: 'ambiguous', matches, value};
    if (!resolved.includes(only)) resolved.push(only);
  }
  if (unknown.length > 0) return {kind: 'unknown', values: unknown};
  return {kind: 'ok', projects: resolved};
}

/** One known project as the error lists it: `<folder>  [TAG]`. */
export function knownProjectLine(project: KnownProject): string {
  return `${project.folder}  [${project.tag}]`;
}

/**
 * The message for a value that resolved to nothing or to two projects: what
 * was typed, then every known project one per line (D2), then any source that
 * could not be read.
 */
export function resolutionErrorText(
  resolution: Exclude<ProjectResolution, {kind: 'ok'}>,
  known: KnownProjects,
): string {
  if (resolution.kind === 'ambiguous') {
    return [
      `"${resolution.value}" names more than one project; type the folder name instead:`,
      ...resolution.matches.map(knownProjectLine),
    ].join('\n');
  }
  const typed = resolution.values.map((value) => `"${value}"`).join(', ');
  const lines = [
    `No project is named ${typed}. The known projects (folder, then tag):`,
    ...known.projects.map(knownProjectLine),
  ];
  for (const problem of known.problems) {
    lines.push(`⚠️ This list may be missing projects: ${problem}.`);
  }
  return lines.join('\n');
}
