/**
 * `thread inbox --unfinished` (home-base-kwand.9, gap G5 of epic
 * home-base-kwand). Justin, 2026-11-17: "How can I see all the threads that
 * are incomplete in any way? ie that have incomplete requests?"
 *
 * One row per handoff chain with an unfinished request, from the SDK's one
 * fold (chain-fold.ts), which the threads dashboard's "unfinished" grouping
 * uses too, so both give the same chains and counts. Each row: the chain's
 * newest session (its name carries the chain name), why it sits where it is,
 * its last activity, and the chain's unfinished requests, open questions and
 * sessions. `--sort importance` (the default) is the reopen order of
 * home-base-kwand.6; `--sort activity` is newest first.
 *
 * Read-only, like every `thread inbox`.
 */

import type {Field, OutputStyle} from '../cli-style';
import type {
  ChainSessionFacts,
  UnfinishedChain,
  UnfinishedChains,
  UnfinishedSort,
} from './chain-fold';
import type {InboxRead, InboxRow} from './session-inbox';

import {
  BODY_COLUMN,
  fieldLines,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {parseInstant} from './answer-store';
import {unfinishedChains} from './chain-fold';
import {ageWords, tildeText} from './part-one';
import {
  NO_REOPEN_SIGNALS,
  REOPEN_ORDER_WORDS,
  type ReopenReason,
  reopenReason,
  reopenSignalsOfRow,
} from './reopen-order';
import {flagsLead, hiddenByAgeLine} from './session-inbox';
import {sessionDisplayName} from './session-name';

/**
 * What the fold reads of an inbox row. An untracked session has no requests
 * and no questions ([]); requests or questions that could not be read are
 * null (critical rule 7).
 */
export function rowChainFacts(row: InboxRow): ChainSessionFacts {
  const asked = row.card.youAsked;
  return {
    beadId: row.sessionBeadId,
    labels: row.loaded?.model.beads.session?.labels ?? null,
    lastActivityAt: row.lastActivityAt,
    questions:
      row.loaded != null
        ? row.loaded.model.beads.questions.map((q) => ({
            id: q.id,
            status: q.status,
          }))
        : row.tracked
          ? null
          : [],
    reopen: reopenSignalsOfRow(row),
    requests:
      asked.kind === 'requests'
        ? asked.requests.map((r) => ({id: r.id, state: r.state}))
        : asked.kind === 'unknown'
          ? null
          : [],
    section: row.section,
  };
}

/** The read's chains with an unfinished request, in `sort`'s order. */
export function unfinishedOfRead(
  read: InboxRead,
  sort: UnfinishedSort,
): UnfinishedChains<InboxRow> {
  return unfinishedChains(read.rows, rowChainFacts, sort);
}

/** Why a chain sits where it is: the reopen reason, or its activity alone. */
export function unfinishedReason(
  chain: UnfinishedChain<InboxRow>,
  sort: UnfinishedSort,
  now: Date,
): ReopenReason {
  const facts = {
    ...(sort === 'importance' ? chain.headFacts.reopen : NO_REOPEN_SIGNALS),
    lastActivityAt: chain.headFacts.lastActivityAt,
  };
  return reopenReason(facts, now);
}

/** The order in words, for the header and `--help`. */
export function unfinishedSortWords(sort: UnfinishedSort): string {
  return sort === 'importance'
    ? `the reopen order: ${REOPEN_ORDER_WORDS}`
    : 'newest activity first; a chain whose activity is unknown comes last';
}

export interface UnfinishedInboxOptions {
  days: number;
  now: Date;
  sort: UnfinishedSort;
}

/** `thread inbox --unfinished --json`: counts and one record per chain. */
export function unfinishedInboxJson(
  read: InboxRead,
  result: UnfinishedChains<InboxRow>,
  options: UnfinishedInboxOptions,
) {
  const {days, now, sort} = options;
  return {
    chains: result.chains.map((chain) => {
      const head = chain.head;
      return {
        beadId: head.sessionBeadId,
        chainName: head.card.marks.chain ?? null,
        counts: chain.counts,
        flags: head.flags?.emoji ?? null,
        lastActivityAt: head.lastActivityAt,
        outside: chain.outside,
        reason: unfinishedReason(chain, sort, now),
        repo: head.repo,
        requestsUnknown: chain.requestsUnknown,
        resume: head.card.resume,
        section: head.section,
        sessionId: head.sessionId,
        // Every session of the chain, its newest first.
        sessionIds: chain.members.map((row) => row.sessionId),
        title: sessionDisplayName(
          head.card.repoTag,
          head.card.title,
          head.card.marks,
        ),
      };
    }),
    days,
    generatedAt: now.toISOString(),
    // R5: what the --days window hid, by status (never dropped silently).
    hiddenByAge: read.hiddenByAge,
    order: unfinishedSortWords(sort),
    sort,
    totals: result.totals,
    // Folded sessions in no chain (a handoff loop): named, not dropped.
    unplaced: result.unplaced.map((row) => row.sessionId),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The chain's counts as fields, the same words in both outputs. */
function chainFields(
  chain: UnfinishedChain<InboxRow>,
  sort: UnfinishedSort,
  now: Date,
): Field[] {
  const head = chain.head;
  const reason = unfinishedReason(chain, sort, now);
  const ms =
    head.lastActivityAt == null ? null : parseInstant(head.lastActivityAt);
  const age = ms == null ? 'unknown' : ageWords(new Date(ms), now);
  const {counts} = chain;
  return [
    {label: 'why here', value: reason.text},
    {label: 'last activity', value: age},
    {
      label: 'unfinished',
      value: `${plural(counts.unfinishedRequests, 'request', 'requests')}${chain.requestsUnknown === 0 ? '' : ` (the requests of ${plural(chain.requestsUnknown, 'session', 'sessions')} could not be read)`}`,
    },
    {
      label: 'questions',
      value:
        counts.openQuestions == null
          ? 'unknown (a session of the chain did not load)'
          : `${counts.openQuestions} open for you`,
    },
    {
      label: 'chain',
      value: `${plural(counts.sessions, 'session', 'sessions')}${chain.outside.length === 0 ? '' : ` (and ${chain.outside.length} it links to that this inbox does not list)`}`,
    },
    {label: 'resume', value: head.card.resume},
  ];
}

/** The printed list: a summary, then one block per chain. */
export function renderUnfinishedInbox(
  read: InboxRead,
  result: UnfinishedChains<InboxRow>,
  options: UnfinishedInboxOptions & {style: OutputStyle},
): string {
  const {days, now, sort, style} = options;
  const {totals} = result;
  const title = `Unfinished — handoff chains with an unfinished request, sessions with activity in the last ${plural(days, 'day', 'days')}`;
  const blocks: string[] = [
    style.color
      ? sectionHeader(title, {color: true, emoji: '🧵'})
      : `# 🧵 ${title}`,
  ];
  const summary: Field[] = [
    {label: 'chains', value: String(totals.chains)},
    {label: 'unfinished requests', value: String(totals.unfinishedRequests)},
    {
      label: 'open questions',
      value:
        totals.openQuestions == null
          ? 'unknown for some chains'
          : String(totals.openQuestions),
    },
    {label: 'sessions in them', value: String(totals.sessions)},
    {label: 'order', value: unfinishedSortWords(sort)},
  ];
  if (totals.requestsUnknownChains > 0) {
    summary.push({
      label: 'requests unreadable',
      value: `${plural(totals.requestsUnknownChains, 'chain is', 'chains are')} listed because a session's requests could not be read`,
    });
  }
  if (result.unplaced.length > 0) {
    summary.push({
      label: 'in no chain',
      value: `${plural(result.unplaced.length, 'session', 'sessions')} that handed off in a loop: ${result.unplaced.map((row) => row.sessionId).join(', ')}`,
    });
  }
  const hidden = hiddenByAgeLine(read.hiddenByAge, days);
  if (hidden != null) summary.push({label: 'older', value: hidden});
  const fieldsText = (fields: Field[], indent: number): string =>
    style.color
      ? fieldLines(fields, {color: true, indent, width: style.width})
      : fields
          .map((entry) => `- **${entry.label}:** ${entry.value}`)
          .join('\n');
  blocks.push(fieldsText(summary, BODY_COLUMN));
  if (result.chains.length === 0) {
    blocks.push(
      style.color
        ? wrapHanging('No chain has an unfinished request in this window.', {
            hang: BODY_COLUMN,
            indent: BODY_COLUMN,
            width: style.width,
          })
        : 'No chain has an unfinished request in this window.',
    );
    return spacedList(blocks);
  }
  result.chains.forEach((chain, index) => {
    const head = chain.head;
    const name = `${index + 1}. ${head.card.emoji} ${flagsLead(head.flags)}${tildeText(sessionDisplayName(head.card.repoTag, head.card.title, head.card.marks))}`;
    const fields = chainFields(chain, sort, now);
    blocks.push(
      style.color
        ? `${wrapHanging(name, {hang: BODY_COLUMN + 3, indent: BODY_COLUMN, width: style.width})}\n${fieldsText(fields, BODY_COLUMN + 3)}`
        : `## ${name}\n${fieldsText(fields, 0)}`,
    );
  });
  return spacedList(blocks);
}
