/**
 * list.ts — `justin-sdk list`: every component, what it is for, and its three
 * independent states in THIS repo (epic home-base-dchjw D3).
 *
 * The three are deliberately separate columns, because collapsing them is what
 * made the old model unreadable:
 *   installed  — evidence of it on disk (component-manifest's detector)
 *   applies    — its `includeIf` predicates pass here (eas only in an Expo app)
 *   resolved   — the config asks for it (an absent `components` key = core)
 *
 * The interesting rows are the ones where they disagree: installed-but-not-
 * resolved is what `install --prune` would take out (plain `install` keeps it —
 * dchjw.17 F1), and applies-but-not-resolved is a component this repo could
 * have and does not.
 */

import {existsSync} from 'fs';
import {resolve} from 'path';

import {
  type ComponentName,
  componentApplicability,
  componentNameForConfigName,
  configNameFor,
  resolveComponents,
} from './component-registry';
import {
  COMPONENT_MANIFESTS,
  componentInstalledEvidence,
} from './component-manifest';
import {readJson} from './setup-helpers';

export interface ComponentListRow {
  name: ComponentName;
  purpose: string;
  installed: boolean;
  /** Why we say it is installed, or null when it is not. */
  installedBecause: string | null;
  applicable: boolean;
  /** Predicate names gating it; empty means it applies everywhere. */
  includeIf: readonly string[];
  resolved: boolean;
}

export interface ComponentListing {
  rows: ComponentListRow[];
  /**
   * Where the "in config" column came from: 'config' (a `components` key),
   * 'core' (an enrolled repo with no such key), 'not-enrolled' (no
   * justin-sdk.config.json at all) or 'unreadable'.
   */
  source: 'config' | 'core' | 'not-enrolled' | 'unreadable';
  /** Set when the config could not be resolved; rows still carry disk facts. */
  problem: string | null;
}

/** Gather the listing. Pure read — nothing here writes. */
export function buildComponentListing(projectRoot: string): ComponentListing {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const enrolled = existsSync(configPath);
  const config = enrolled ? readJson(configPath) : null;
  // An UNENROLLED repo is not a repo that wants core (dchjw.17 F9). Resolving
  // `{}` for it printed every core component as "in config: yes", which reads
  // as an enrolment that does not exist — and the disk columns beside it then
  // look like drift from a config the repo has never had.
  const resolvedResult = enrolled
    ? resolveComponents(config ?? {}, projectRoot)
    : ({components: [], ok: true, source: 'config'} as const);

  const resolvedNames = new Set<ComponentName>();
  if (resolvedResult.ok && enrolled) {
    for (const configName of resolvedResult.components) {
      const name = componentNameForConfigName(configName);
      if (name != null) resolvedNames.add(name);
    }
  }

  const rows = componentApplicability(projectRoot).map((entry) => {
    const evidence = componentInstalledEvidence(projectRoot, entry.name);
    return {
      applicable: entry.applicable,
      includeIf: entry.includeIf,
      installed: evidence.installed,
      installedBecause: evidence.installed ? evidence.because : null,
      name: entry.name,
      purpose: COMPONENT_MANIFESTS[entry.name].purpose,
      resolved: resolvedNames.has(entry.name),
    };
  });

  if (!enrolled) return {problem: null, rows, source: 'not-enrolled'};
  return {
    problem: resolvedResult.ok ? null : resolvedResult.reason,
    rows,
    source: resolvedResult.ok ? resolvedResult.source : 'unreadable',
  };
}

function mark(value: boolean): string {
  return value ? 'yes' : 'no ';
}

/** The human-readable table `justin-sdk list` prints. */
export function renderComponentListing(listing: ComponentListing): string {
  const lines: string[] = [];
  lines.push('component       installed  applies  in config');
  lines.push('--------------- ---------  -------  ---------');
  for (const row of listing.rows) {
    lines.push(
      `${row.name.padEnd(15)} ${mark(row.installed).padEnd(9)}  ${mark(row.applicable).padEnd(7)}  ${mark(row.resolved)}`,
    );
    lines.push(`                ${row.purpose}`);
    if (!row.applicable && row.includeIf.length > 0) {
      lines.push(
        `                (gated on ${row.includeIf.join(' + ')}, which does not pass here)`,
      );
    }
    if (row.installed && !row.resolved) {
      lines.push(
        `                installed but not listed — \`install\` KEEPS it; \`install --prune\` or \`remove ${row.name}\` takes it out (evidence: ${row.installedBecause ?? 'unknown'})`,
      );
    }
    if (!row.installed && row.resolved) {
      lines.push('                listed but not installed — run `install`');
    }
  }

  lines.push('');
  if (listing.source === 'not-enrolled') {
    lines.push(
      'This repo has no justin-sdk.config.json, so it is NOT ENROLLED and the "in config" column is all "no" — not a claim that it wants nothing. `justin-sdk init` enrols it; `add <name…>` installs components.',
    );
    return lines.join('\n');
  }
  if (listing.problem != null) {
    lines.push(
      `justin-sdk.config.json could not be resolved: ${listing.problem}. The "in config" column is therefore all "no" — that is a FAILED READ, not a claim that the repo wants nothing.`,
    );
  } else if (listing.source === 'core') {
    lines.push(
      `justin-sdk.config.json has no "components" key, so this repo tracks the core preset: ${listing.rows
        .filter((row) => row.resolved && row.name !== 'base-setup')
        .map((row) => configNameFor(row.name))
        .join(', ')}`,
    );
  } else {
    lines.push('Components come from justin-sdk.config.json#components.');
  }
  return lines.join('\n');
}

/** Run `list`. Returns an exit code (0 = success). */
export function runList(projectRoot: string): number {
  const listing = buildComponentListing(projectRoot);
  console.log(renderComponentListing(listing));
  // A config we could not read is a failure, not a quiet listing (rule 6).
  return listing.problem == null ? 0 : 1;
}
