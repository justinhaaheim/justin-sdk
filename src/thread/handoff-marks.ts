/**
 * A session's marks ("[MAYOR] [TAG] H3 <title>") where its bead may predate
 * the `handoff-number:` label (home-base-idnon, conductor decision in
 * home-base-9ihcl.2's design field).
 *
 * The cmux tab title and the launch name read the marks from the bead's
 * labels alone (sessionMarksOf, home-base-6n7my.2 D2). A dormant bead that
 * continues another but has no number label then reads `H?`: the self-heal
 * stamps the number only on a session's next prompt, and no backfill was
 * built. The inbox, the dashboard, the status block and the handoff block show
 * old sessions too, so here a bead with `continues:` and no number label gets
 * its number by walking the chain at read time (handoffNumberOf, D3). Nothing
 * is written. A chain that cannot be walked (a bead not found, two
 * predecessors, a loop) stays `H?`: never a guess, and never no mark.
 *
 * A bead with no `continues:` keeps the labels' answer (no mark), as the tab
 * title does: a first session that began on a kickoff and never linked (F12)
 * is not looked for here.
 */

import type {ChainBeadRead, ChainReaders} from './handoff-chain';
import type {MessageLogRead} from './message-log';
import type {EnvLike} from './paths';
import type {SessionMarks} from './session-name';
import type {ExportIndexRead} from './session-tree';

import {handoffNumberOf} from './handoff-number';
import {readMessageLog} from './message-log';
import {
  CONTINUES_LABEL_PREFIX,
  HANDOFF_NUMBER_LABEL_PREFIX,
  SID_LABEL_PREFIX,
} from './session-bead';
import {sessionMarksOf, stampedHandoffNumber} from './session-name';
import {newestRecord} from './session-tree';

/** The labels handoffNumberOf reads from each bead of a chain. */
const CHAIN_LABEL_PREFIXES = [
  HANDOFF_NUMBER_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  SID_LABEL_PREFIX,
] as const;

/** Whether two or more records of one bead differ in a label the walk reads. */
function chainLabelsDisagree(
  records: readonly {labels: readonly string[]}[],
): boolean {
  const keys = records.map((record) =>
    record.labels
      .filter((label) =>
        CHAIN_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)),
      )
      .sort()
      .join('\n'),
  );
  return new Set(keys).size > 1;
}

/** The marks of one session bead, its number walked when no label holds it. */
export function walkedSessionMarks(
  bead: {id: string; labels: readonly string[]},
  readers: ChainReaders,
): SessionMarks {
  const fromLabels = sessionMarksOf(bead.labels);
  // Only "continues another, number not stamped" is walked: a stamped number
  // is the answer, an unreadable one stays unknown, and no `continues:` is a
  // first session.
  if (
    fromLabels.handoff !== 'unknown' ||
    stampedHandoffNumber(bead.labels).kind !== 'none'
  ) {
    return fromLabels;
  }
  const number = handoffNumberOf(bead, readers);
  return {
    ...fromLabels,
    handoff:
      number.kind === 'known' && number.number > 0 ? number.number : 'unknown',
  };
}

/**
 * Chain readers over what one inbox run already holds, so the walk spawns no
 * br: the session beads it loaded, then the export indexes it built (by
 * `.beads/` directory), then not found. Of an id's lines in one export, the
 * newest by updated_at counts (newestRecord). Logs: the ones it loaded, else
 * read.
 */
export function inboxChainReaders(input: {
  beads: ReadonlyMap<string, {labels: readonly string[]; title: string}>;
  env: EnvLike;
  exportIndexes: ReadonlyMap<string, ExportIndexRead>;
  logs: ReadonlyMap<string, MessageLogRead>;
}): ChainReaders {
  return {
    readLog: (sessionId) =>
      input.logs.get(sessionId) ?? readMessageLog(sessionId, input.env),
    showBead: (beadId): ChainBeadRead => {
      const loaded = input.beads.get(beadId);
      if (loaded != null) {
        return {kind: 'found', labels: loaded.labels, title: loaded.title};
      }
      const failed: string[] = [];
      for (const read of input.exportIndexes.values()) {
        if (read.kind !== 'read') {
          failed.push(`${read.path}: ${read.reason}`);
          continue;
        }
        // home-base-hg6lz.4 R2: an export can hold one id on several lines
        // (a git merge of issues.jsonl, before br writes it again). Take the
        // record readSessionTree keeps; when updated_at cannot order them and
        // they disagree on a label the walk reads, the number is unknown.
        const records = (read.index.byId.get(beadId) ?? []).map(
          (record) => record.issue,
        );
        const picked = newestRecord(records);
        if (picked == null) continue;
        if (!picked.decided && chainLabelsDisagree(records)) {
          return {
            kind: 'failed',
            reason: `${beadId} is on ${records.length} lines of ${read.index.path} that updated_at does not order, and they disagree on its ${CHAIN_LABEL_PREFIXES.join(', ')} labels`,
          };
        }
        return {
          kind: 'found',
          labels: picked.issue.labels,
          title: picked.issue.title,
        };
      }
      // An export that could not be read could hold it (rule 7).
      return failed.length > 0
        ? {
            kind: 'failed',
            reason: `${beadId} is not in the exports read, and ${failed.length} could not be read (${failed.join('; ')})`,
          }
        : {
            kind: 'notFound',
            reason: `${beadId} is not among the session beads and exports this inbox read`,
          };
    },
  };
}
