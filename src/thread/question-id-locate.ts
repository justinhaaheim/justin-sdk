/**
 * Where a question id lives (home-base-4wfoz; D2 in home-base-l2ejg.3).
 *
 * `thread answer --ask BD<n>` answers only a question of the session it runs
 * in. When that session does not hold the id, the refusal names where it does
 * live, so Justin (or the session relaying him) can tell which question he
 * meant: its repo, the session bead it was filed under, and its title. This
 * runs only on that refusal path, so it may read every known export whole.
 *
 * READ-ONLY. A failed read is listed in `problems`, never taken as "not there"
 * (critical rule 7).
 */

import type {EnvLike} from './paths';
import type {TreeIssue} from './session-tree';

import {statSync} from 'fs';
import {basename, dirname} from 'path';

import {recordedBeadsJsonl} from '../beads/jsonl';
import {parseQuestionIdLabel} from './question-ids';
import {readSessionIndex} from './session-index';
import {readExportIndex} from './session-tree';

/**
 * A recorded dir with no database br would use and no export file: a gone
 * worktree, which holds nothing (the measured absence holders.ts and the
 * question counter skip too).
 */
function goneWithoutDatabase(dir: string): boolean {
  const located = recordedBeadsJsonl(dir);
  if (located.kind !== 'found' || located.via !== 'noDatabase') return false;
  try {
    statSync(located.path);
    return false;
  } catch (error) {
    return (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as {code: unknown}).code === 'ENOENT'
    );
  }
}

export interface LocatedQuestion {
  /** `machine` for a `qid:<n>` label; `chain` for an old per-chain one. */
  form: 'chain' | 'machine';
  id: string;
  /** The bead it was filed under (its session bead), with its title. */
  parent: {id: string; title: string | null} | null;
  repo: string;
  status: string;
  title: string;
}

export interface LocatedQuestionId {
  found: LocatedQuestion[];
  /** Exports or the index that could not be read: the id may be there too. */
  problems: string[];
}

/**
 * The repo a `.beads/` dir belongs to, for a reader: `home-base`. Shared with
 * the relay (question-relay.ts).
 */
export function repoOfBeadsDir(beadsDir: string, named: string | null): string {
  if (named != null && named !== '') return named;
  const checkout = dirname(beadsDir);
  const marker = '/.claude/worktrees/';
  const at = checkout.indexOf(marker);
  return basename(at === -1 ? checkout : checkout.slice(0, at));
}

/** Every question, in every export the sessions index knows, holding `number`. */
export function locateQuestionId(input: {
  env: EnvLike;
  /** Dirs to read first (the session's own). */
  firstDirs?: readonly string[];
  number: number;
}): LocatedQuestionId {
  const problems: string[] = [];
  const repoOf = new Map<string, null | string>();
  for (const dir of input.firstDirs ?? []) repoOf.set(dir, null);
  const index = readSessionIndex(input.env);
  if (index.kind === 'failed') {
    problems.push(`the sessions index ${index.path}: ${index.error}`);
  }
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) {
        if (repoOf.get(sighting.beadsDir) == null) {
          repoOf.set(sighting.beadsDir, sighting.repo);
        }
      }
    }
  }
  const found = new Map<string, LocatedQuestion>();
  const readPaths = new Set<string>();
  for (const [dir, named] of repoOf) {
    if (goneWithoutDatabase(dir)) continue;
    const read = readExportIndex(dir);
    if (read.kind === 'failed') {
      problems.push(`${read.path}: ${read.reason}`);
      continue;
    }
    const {index: exportIndex} = read;
    if (readPaths.has(exportIndex.path)) continue;
    readPaths.add(exportIndex.path);
    const holders: {form: 'chain' | 'machine'; issue: TreeIssue}[] = [];
    for (const [label, records] of exportIndex.byLabel) {
      const parsed = parseQuestionIdLabel(label);
      if (parsed == null || parsed.form === 'unreadable') continue;
      if (parsed.number !== input.number) continue;
      for (const record of records) {
        holders.push({form: parsed.form, issue: record.issue});
      }
    }
    for (const {form, issue} of holders) {
      if (found.has(issue.id)) continue;
      const [parentId] = issue.parentIds;
      const parentTitle =
        parentId == null
          ? null
          : (exportIndex.byId.get(parentId)?.[0]?.issue.title ?? null);
      found.set(issue.id, {
        form,
        id: issue.id,
        parent: parentId == null ? null : {id: parentId, title: parentTitle},
        repo: repoOfBeadsDir(dir, named),
        status: issue.status,
        title: issue.title,
      });
    }
  }
  // Open questions first, then D2 ids before old ones, then by id.
  const rank = (entry: LocatedQuestion): number =>
    (entry.status === 'closed' ? 2 : 0) + (entry.form === 'chain' ? 1 : 0);
  return {
    found: [...found.values()].sort((a, b) => {
      const byRank = rank(a) - rank(b);
      return byRank !== 0
        ? byRank
        : a.id.localeCompare(b.id, 'en', {numeric: true});
    }),
    problems,
  };
}

/** One located question in words, for a refusal. */
export function locatedWords(entry: LocatedQuestion): string {
  const under =
    entry.parent == null
      ? ''
      : `, filed under ${entry.parent.id}${entry.parent.title == null ? '' : ` "${entry.parent.title}"`}`;
  const old = entry.form === 'chain' ? ', an old per-chain id' : '';
  return `${entry.id} in ${entry.repo}${under}: "${entry.title}" (${entry.status}${old})`;
}
