/**
 * The already-held check for `thread spawn` (home-base-5uu56.2.4), behind
 * `componentConfig.thread.spawn.holdersGate`, default false.
 *
 * On 2026-11-08 a session asked Justin to start a browser-automation-central
 * session for bac-fn0a, which a bac session had built and merged on 11-03. With
 * this on, `thread spawn` finds the target repo's bead ids in the kickoff and
 * refuses when an unfinished session other than the caller already holds one.
 *
 * Only ids with the target repo's own prefix are looked for, read from its
 * beads export, so ordinary hyphenated words are never taken for beads. An id
 * that is not in that DB is not a bead and is skipped. Anything that cannot be
 * checked refuses (critical rule 7): `--anyway` is the way past it.
 */

import type {Holder} from './holders';
import type {EnvLike} from './paths';
import type {SessionStatus} from './session-status';

import {readFileSync} from 'fs';

import {findBeadsWorkspace} from '../beads/br';
import {workspaceBeadsJsonl} from '../beads/jsonl';
import {describeHolders, findHolders} from './holders';

/** A holder whose session is finished, or has passed the work on, is no reason to refuse. */
const FINISHED: ReadonlySet<SessionStatus['kind']> = new Set([
  'answered',
  'done',
  'handedOff',
]);

export function blocksSpawn(holder: Holder): boolean {
  if (holder.thisSession) return false;
  return holder.status == null || !FINISHED.has(holder.status.kind);
}

/** "bac" from "bac-fn0a", "home-base" from "home-base-5uu56.2". */
export function prefixOfBeadId(id: string): string | null {
  const base = id.replace(/(\.\d+)+$/u, '');
  const cut = base.lastIndexOf('-');
  return cut > 0 ? base.slice(0, cut) : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Every distinct id with `prefix` in `text`, in order of first mention. */
export function beadIdsIn(text: string, prefix: string): string[] {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9-])${escapeRegExp(prefix)}-[a-z0-9]+(?:\\.\\d+)*(?![A-Za-z0-9-])`,
    'gu',
  );
  return [...new Set(text.match(pattern) ?? [])];
}

export type KickoffHolders =
  | {kind: 'clear'}
  | {kind: 'held'; lines: string[]}
  | {kind: 'unchecked'; reason: string};

/** The repo's prefix, from the first id in its beads export. */
function repoPrefix(
  dir: string,
):
  | {db: string; kind: 'found'; prefix: string}
  | {kind: 'none'}
  | {kind: 'failed'; reason: string} {
  const space = findBeadsWorkspace(dir);
  if (space.kind === 'none') return {kind: 'none'};
  if (space.kind === 'failed') return {kind: 'failed', reason: space.reason};
  // The export beside the DB br uses, from the one shared helper
  // (src/beads/jsonl.ts), never spelled here.
  const exportPath = workspaceBeadsJsonl(space);
  let first: string | undefined;
  try {
    first = readFileSync(exportPath, 'utf8').split('\n', 1)[0];
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${exportPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (first == null || first.trim() === '') return {kind: 'none'};
  let id: unknown;
  try {
    id = (JSON.parse(first) as {id?: unknown}).id;
  } catch {
    return {
      kind: 'failed',
      reason: `${exportPath}: its first line is not JSON`,
    };
  }
  const prefix = typeof id === 'string' ? prefixOfBeadId(id) : null;
  if (prefix == null) {
    return {
      kind: 'failed',
      reason: `${exportPath}: its first line has no bead id`,
    };
  }
  return {db: space.db, kind: 'found', prefix};
}

export async function checkKickoffHolders(input: {
  cwd: string;
  dir: string;
  env: EnvLike;
  kickoff: string;
}): Promise<KickoffHolders> {
  const repo = repoPrefix(input.dir);
  // A repo with no beads has no bead to be held.
  if (repo.kind === 'none') return {kind: 'clear'};
  if (repo.kind === 'failed') return {kind: 'unchecked', reason: repo.reason};
  const held: string[] = [];
  for (const beadId of beadIdsIn(input.kickoff, repo.prefix)) {
    const outcome = await findHolders({
      beadId,
      cwd: input.cwd,
      db: repo.db,
      env: input.env,
    });
    if (outcome.kind === 'notFound') continue;
    if (outcome.kind === 'failed') {
      return {kind: 'unchecked', reason: outcome.reason};
    }
    const blocking = outcome.holders.filter(blocksSpawn);
    if (blocking.length === 0) continue;
    held.push(
      ...describeHolders({...outcome, holders: blocking}).lines.map((line) =>
        line === '' ? '' : `  ${line}`,
      ),
      '',
    );
  }
  return held.length === 0 ? {kind: 'clear'} : {kind: 'held', lines: held};
}

/** What `thread spawn` prints when the check refuses (exit 3). */
export function holdersRefusalLines(result: KickoffHolders): string[] | null {
  if (result.kind === 'clear') return null;
  const head =
    result.kind === 'held'
      ? 'thread spawn: refused: the kickoff names work that an unfinished session already holds. Nothing was opened.'
      : `thread spawn: refused: whether another session already holds the kickoff's beads could not be checked (${result.reason}). Nothing was opened.`;
  return [
    head,
    '',
    ...(result.kind === 'held' ? result.lines : []),
    'Tell Justin which session holds it, and continue there. Start a new session anyway only on his go, with --anyway. (componentConfig.thread.spawn.holdersGate, home-base-5uu56.2.4.)',
  ];
}
