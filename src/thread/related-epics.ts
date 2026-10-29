/**
 * The epics a session's work belongs to, for `thread show` (home-base-y1hg0.7).
 *
 * THE PROBLEM. On 2026-10-20 a cold agent asked the threads tooling where the
 * threads work had left off. `thread show home-base-aasbl` printed the
 * session's requests and questions but never named epic home-base-yukaf,
 * whose open children were the follow-ups it needed; it had to find them in
 * the beads by hand. Justin, 2026-10-19: understanding where his projects and
 * conversations have left off should be "proactively available and really
 * like robust and dependable and structured rather than something that you
 * just reactively constantly have to kind of recompute."
 *
 * THE RULE (the bead's acceptance criterion 2). Start from every request bead
 * of the session and every bead the session created with `br create`
 * (session-created.ts). From each, walk up its parent-child parents to the
 * NEAREST epic. A start bead that is itself an epic is its own nearest epic:
 * the session that filed home-base-yukaf created the epic itself. Each epic is
 * listed once, with its open children.
 *
 * WHERE IT READS. The `.beads/issues.jsonl` export of every beads DB the
 * session names (its sightings) plus the DB each start bead was found in, the
 * same files session-tree.ts reads and for the same reason (one file read per
 * DB, no `br` run), located the same way (`readBeadsExport`: the export br
 * writes for that DB, home-base-dj5m9.1.2). A record found in two exports (a
 * worktree and its main checkout share ids) is the one with the newer
 * `updated_at`.
 *
 * CRITICAL RULE 7. "No epic" and "could not tell" are different results.
 * `problems` names everything that could not be read or followed: an export
 * that cannot be read, a parent that no export holds, the session's beads
 * that could not be listed, a bead `br create` reported that no export holds.
 * The renderer prints `none` only when `problems` is empty.
 */

import type {OutputStyle} from '../cli-style';
import type {CreatedBeads} from './session-created';
import type {Measured} from './session-model';
import type {ExportRead, SessionTree, TreeIssue} from './session-tree';

import {
  BODY_COLUMN,
  markdownItems,
  pad,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {parseInstant} from './answer-store';
import {
  exportRecordById,
  readBeadsExport,
  recordsMatching,
} from './session-tree';

/** How many open children an epic lists before `N more` (the bead's AC 2). */
export const OPEN_CHILDREN_SHOWN = 15;

/** How far up the parents the walk goes before it gives up, named. */
export const MAX_PARENT_DEPTH = 20;

/** The bead type that makes a bead an epic. */
const EPIC_TYPE = 'epic';

export interface RelatedEpic {
  epic: TreeIssue;
  /**
   * Every child of the epic that is not closed (tombstones are never read):
   * in-progress ones first, then the rest, each group oldest first. All of
   * them; the renderer cuts at OPEN_CHILDREN_SHOWN.
   */
  openChildren: TreeIssue[];
  /** How many beads the session created led here (the epic itself counts). */
  viaCreated: number;
  /** How many of the session's requests led here (the epic itself counts). */
  viaRequests: number;
}

export interface RelatedEpics {
  /** The beads the walk started from: requests, then created beads, once each. */
  checked: {created: number; requests: number};
  /** In the order the walk first reached them: requests' epics first. */
  epics: RelatedEpic[];
  /** Everything that could not be read or followed. Empty = the list is whole. */
  problems: string[];
}

/** Newer `updated_at` wins; an undated record loses to a dated one. */
function newer(a: TreeIssue, b: TreeIssue): TreeIssue {
  const at = parseInstant(a.updatedAt);
  const bt = parseInstant(b.updatedAt);
  if (at == null) return b;
  if (bt == null) return a;
  return bt > at ? b : a;
}

function isEpic(issue: TreeIssue): boolean {
  return issue.issueType === EPIC_TYPE;
}

/** In progress first, then everything else; oldest first within each. */
function childOrder(a: TreeIssue, b: TreeIssue): number {
  const rank = (issue: TreeIssue): number =>
    issue.status === 'in_progress' ? 0 : 1;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/**
 * The related epics of one session (see the header). Pure apart from
 * `readExport`, which the tests replace.
 */
export function findRelatedEpics(input: {
  /** The beads this session created, or why they could not be listed. */
  created: Measured<CreatedBeads>;
  /** The DBs the session names (its sightings), the session bead's first. */
  readExport?: (beadsDir: string) => ExportRead;
  sessionDirs: readonly string[];
  /** The session's tree: its requests, and the exports it could not read. */
  tree: Pick<SessionTree, 'problems' | 'requests'>;
}): RelatedEpics {
  const readExport = input.readExport ?? readBeadsExport;
  const problems: string[] = [...input.tree.problems];

  // The starts: every request, then every created bead not already a request.
  const requests = input.tree.requests.map((node) => node.request);
  const requestIds = new Set(requests.map((request) => request.id));
  const created: TreeIssue[] = [];
  if (!input.created.ok) {
    problems.push(
      `the beads this session created could not be listed: ${input.created.reason}`,
    );
  } else {
    for (const bead of input.created.value.found) {
      if (!requestIds.has(bead.id)) created.push(bead);
    }
    const {missing} = input.created.value;
    if (missing.length > 0) {
      const ids = missing.map((entry) => entry.id);
      const searched = [...new Set(missing.flatMap((entry) => entry.searched))];
      problems.push(
        `${ids.length === 1 ? 'a bead' : `${ids.length} beads`} this session created with br create ${ids.length === 1 ? 'is' : 'are'} in no beads export searched, so ${ids.length === 1 ? 'its epic is' : 'their epics are'} unknown: ${ids.join(', ')} (searched ${searched.length > 0 ? searched.join(', ') : 'nothing'})`,
      );
    }
  }

  // Every DB worth looking in: the session's, then each start bead's own.
  const dirs = [
    ...new Set([
      ...input.sessionDirs,
      ...requests.map((bead) => bead.beadsDir),
      ...created.map((bead) => bead.beadsDir),
    ]),
  ];
  const exports = new Map<string, ExportRead>();
  const exportOf = (dir: string): ExportRead => {
    const known = exports.get(dir);
    if (known != null) return known;
    const read = readExport(dir);
    exports.set(dir, read);
    if (read.kind === 'failed') problems.push(read.reason);
    return read;
  };

  // One lookup per id, every DB, newest record wins.
  const lookups = new Map<string, TreeIssue | null>();
  const lookup = (id: string, childId: string): TreeIssue | null => {
    if (lookups.has(id)) return lookups.get(id) ?? null;
    let found: TreeIssue | null = null;
    let deleted = false;
    let failed = false;
    const searched: string[] = [];
    for (const dir of dirs) {
      const read = exportOf(dir);
      if (read.kind === 'failed') {
        failed = true;
        continue;
      }
      searched.push(read.path);
      const hit = exportRecordById(read.text, id, dir, read.path);
      if (hit.kind === 'failed') {
        problems.push(hit.reason);
        failed = true;
      } else if (hit.kind === 'deleted') deleted = true;
      else if (hit.kind === 'found') {
        found = found == null ? hit.issue : newer(found, hit.issue);
      }
    }
    // An unreadable export already named itself; a parent deleted everywhere
    // it is seen ends the walk on purpose. Anything else missing is said.
    if (found == null && !failed && !deleted) {
      problems.push(
        `the parent ${id} of ${childId} is in no beads export searched (${searched.join(', ')})`,
      );
    }
    lookups.set(id, found);
    return found;
  };

  const epics = new Map<string, RelatedEpic>();
  const reach = (epic: TreeIssue, from: 'created' | 'request'): void => {
    const known = epics.get(epic.id);
    const entry: RelatedEpic = known ?? {
      epic,
      openChildren: [],
      viaCreated: 0,
      viaRequests: 0,
    };
    if (from === 'request') entry.viaRequests += 1;
    else entry.viaCreated += 1;
    epics.set(epic.id, entry);
  };

  const walk = (start: TreeIssue, from: 'created' | 'request'): void => {
    let frontier: TreeIssue[] = [start];
    const seen = new Set<string>([start.id]);
    for (let depth = 0; frontier.length > 0; depth += 1) {
      const here = frontier.filter(isEpic);
      if (here.length > 0) {
        for (const epic of here) reach(epic, from);
        return;
      }
      if (depth >= MAX_PARENT_DEPTH) {
        problems.push(
          `stopped looking for the epic above ${start.id} after ${MAX_PARENT_DEPTH} levels of parents`,
        );
        return;
      }
      const next: TreeIssue[] = [];
      for (const bead of frontier) {
        for (const parentId of bead.parentIds) {
          if (seen.has(parentId)) continue;
          seen.add(parentId);
          const parent = lookup(parentId, bead.id);
          if (parent != null) next.push(parent);
        }
      }
      frontier = next;
    }
  };

  for (const request of requests) walk(request, 'request');
  for (const bead of created) walk(bead, 'created');

  // The open children of each epic: one scan per DB for the quoted id, kept
  // when a parent-child dependency names the epic.
  for (const entry of epics.values()) {
    const children = new Map<string, TreeIssue>();
    for (const dir of dirs) {
      const read = exportOf(dir);
      if (read.kind === 'failed') continue;
      const found = recordsMatching(
        read.text,
        [JSON.stringify(entry.epic.id)],
        dir,
        read.path,
      );
      if (!found.ok) {
        problems.push(found.reason);
        continue;
      }
      for (const issue of found.issues) {
        if (!issue.parentIds.includes(entry.epic.id)) continue;
        const known = children.get(issue.id);
        children.set(issue.id, known == null ? issue : newer(known, issue));
      }
    }
    entry.openChildren = [...children.values()]
      .filter((child) => child.status !== 'closed')
      .sort(childOrder);
  }

  return {
    checked: {created: created.length, requests: requests.length},
    epics: [...epics.values()],
    problems: [...new Set(problems)],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `in_progress` → `in progress`. */
function statusWords(status: string): string {
  return status.replace(/_/g, ' ');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 requests and 31 beads this session created". */
function reachedFrom(entry: RelatedEpic): string {
  const parts = [
    entry.viaRequests > 0
      ? plural(entry.viaRequests, 'request', 'requests')
      : null,
    entry.viaCreated > 0
      ? `${plural(entry.viaCreated, 'bead', 'beads')} this session created`
      : null,
  ].filter((part): part is string => part != null);
  return parts.join(' and ');
}

/** "the session's 18 requests and the 33 beads it created". */
function checkedWords(checked: RelatedEpics['checked']): string {
  return `${plural(checked.requests, 'request', 'requests')} and ${plural(checked.created, 'bead', 'beads')} this session created`;
}

/** The line a section with no epic prints: `none`, or UNKNOWN when it could not tell. */
export function noEpicLine(related: RelatedEpics): string {
  return related.problems.length === 0
    ? `none — checked ${checkedWords(related.checked)}; none of them sits under an epic.`
    : `UNKNOWN — no epic found from ${checkedWords(related.checked)}, but part of what would show one could not be read (below).`;
}

/** The heading of the problems list. */
export const RELATED_EPICS_INCOMPLETE =
  '⚠️ This list may be incomplete. Could not read:';

/** One child as a line: id, plain title, status. */
function childText(child: TreeIssue): string {
  return `${child.id} ${child.title} (${statusWords(child.status)})`;
}

/**
 * The "Related epics" section, as blocks for `spacedList`: markdown when
 * piped (Claude reads it), man-page columns on a terminal (Justin reads it).
 */
export function renderRelatedEpics(
  related: RelatedEpics,
  style: OutputStyle,
): string[] {
  const shown = (entry: RelatedEpic): TreeIssue[] =>
    entry.openChildren.slice(0, OPEN_CHILDREN_SHOWN);
  const more = (entry: RelatedEpic): number =>
    entry.openChildren.length - shown(entry).length;

  if (!style.color) {
    const blocks: string[] = ['**Related epics:**'];
    if (related.epics.length === 0) blocks.push(noEpicLine(related));
    else {
      blocks.push(
        markdownItems(
          related.epics.map((entry, index) => {
            const marker = `${index + 1}. `;
            const at = pad(marker.length);
            const children = shown(entry).map(
              (child) => `${at}- ${childText(child)}`,
            );
            const rest = more(entry);
            if (rest > 0) children.push(`${at}- ${rest} more`);
            return [
              `${marker}**${entry.epic.title}** (${entry.epic.id}, ${statusWords(entry.epic.status)})`,
              '',
              `${at}**Reached from:** ${reachedFrom(entry)}`,
              '',
              entry.openChildren.length === 0
                ? `${at}**Open children:** none (checked)`
                : `${at}**Open children:** ${entry.openChildren.length}`,
              ...(children.length === 0 ? [] : ['', children.join('\n\n\n')]),
            ].join('\n');
          }),
        ),
      );
    }
    if (related.problems.length > 0) {
      blocks.push(
        `${RELATED_EPICS_INCOMPLETE}\n\n${markdownItems(related.problems.map((problem) => `- ${problem}`))}`,
      );
    }
    return blocks;
  }

  const width = style.width;
  const fieldAt = stepColumn(1);
  const childAt = stepColumn(2);
  const line = (text: string, indent: number, hang = indent): string =>
    wrapHanging(text, {hang, indent, width});
  const blocks: string[] = [
    sectionHeader('Related epics', {color: true, emoji: '🗂️'}),
  ];
  if (related.epics.length === 0) {
    blocks.push(line(noEpicLine(related), BODY_COLUMN));
  }
  for (const entry of related.epics) {
    const children = shown(entry).map((child) =>
      line(
        `${paint(child.id, ['dim'], true)} ${child.title} ${paint(`(${statusWords(child.status)})`, ['dim'], true)}`,
        childAt,
        childAt + 4,
      ),
    );
    const rest = more(entry);
    if (rest > 0)
      children.push(line(paint(`${rest} more`, ['dim'], true), childAt));
    blocks.push(
      spacedList([
        line(
          `${paint(entry.epic.title, ['bold'], true)} ${paint(`(${entry.epic.id}, ${statusWords(entry.epic.status)})`, ['dim'], true)}`,
          BODY_COLUMN,
          fieldAt,
        ),
        line(
          `${paint('Reached from:', ['bold'], true)} ${reachedFrom(entry)}`,
          fieldAt,
        ),
        line(
          `${paint('Open children:', ['bold'], true)} ${entry.openChildren.length === 0 ? 'none (checked)' : String(entry.openChildren.length)}`,
          fieldAt,
        ),
        ...children,
      ]),
    );
  }
  if (related.problems.length > 0) {
    blocks.push(
      spacedList([
        line(RELATED_EPICS_INCOMPLETE, BODY_COLUMN),
        ...related.problems.map((problem) =>
          line(`- ${problem}`, fieldAt, fieldAt + 2),
        ),
      ]),
    );
  }
  return blocks;
}
