#!/usr/bin/env bun
/**
 * migrate-ask-parents — move OLD-SHAPE questions under their session bead
 * (home-base-vzwbj.4.16 G1, acceptance criterion 8).
 *
 * WHY. Until 2026-10-12, `thread ask` filed a question as a CHILD of its
 * request. br refuses `br close` on a parent with open children, and P1–P3
 * questions may never be answered, so a finished request could not be closed
 * with the plain `br close <id> --reason "…"` (session 4044142e, home-base-
 * knsyl). `thread ask` now files every question under the SESSION bead and
 * names the request with a `to:` label (`toLabel`). This script moves the
 * questions already filed the old way into that shape.
 *
 * WHAT IT DOES, in the beads workspace of `--cwd`:
 *
 *   1. Reads the workspace's `.beads/issues.jsonl` export once and finds every
 *      `ask`-labelled bead, OPEN OR CLOSED, whose parent is a
 *      `request`-labelled bead.
 *   2. Finds that question's session bead: the bead labelled `session` with
 *      the question's `sid:` label (else the request's). None, or more than
 *      one, refuses that question, by name.
 *   3. Checks in the DATABASE (`br show <request> --json`, its children) that
 *      the question is still the request's child — the export can lag.
 *   4. With --apply, for each question (MEASURED 2026-10-12 on the pinned br
 *      0.1.37: moving a bead straight to one of its own ancestors is refused
 *      as a cycle, so the parent is removed first):
 *        br update <q> --add-label=<to label> --parent=
 *        br update <q> --parent=<session bead>
 *      then reads it back: the session bead lists it as a child, the request
 *      no longer does, the label is there, the status is unchanged. The id
 *      and the status never change; nothing is closed, reopened or deleted.
 *
 * DRY RUN BY DEFAULT: it prints each question, where it would go and the two
 * br commands. Every write goes through the br adapter (src/beads/br.ts), so
 * it refuses while issues.jsonl is ahead of the database (P1) and passes
 * --no-auto-import. Commit `.beads/issues.jsonl` yourself afterwards.
 *
 * `--cwd` is REQUIRED and names the checkout whose beads it moves. It is a
 * one-off for the conductor (in home-base main, after the fix-round-C merge);
 * the session that wrote it never ran it against a real database — only
 * against the throwaway workspaces of tests/thread-migrate-ask-parents.test.ts.
 */

import type {Argv} from 'yargs';

import {readFileSync} from 'fs';
import {join, resolve} from 'path';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {
  brChildren,
  type BrEnv,
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
} from '../src/beads/br';
import {ASK_LABEL} from '../src/thread/ask-format';
import {
  REQUEST_LABEL,
  SESSION_LABEL,
  SID_LABEL_PREFIX,
  toLabelFor,
} from '../src/thread/session-bead';
import {parseExportLine, type TreeIssue} from '../src/thread/session-tree';

/** One old-shape question and where it goes. */
export interface Move {
  question: {id: string; status: string; title: string};
  request: {id: string; title: string};
  session: {id: string; title: string};
  toLabel: string;
}

/** A question that cannot be moved, and why. */
export interface Refusal {
  question: {id: string; title: string};
  reason: string;
}

export type MigrationPlan =
  | {kind: 'failed'; reason: string}
  | {
      db: string;
      exportPath: string;
      kind: 'planned';
      moves: Move[];
      refusals: Refusal[];
    };

function sidOf(issue: TreeIssue): string | null {
  return (
    issue.labels.find((label) => label.startsWith(SID_LABEL_PREFIX)) ?? null
  );
}

/**
 * The plan: every old-shape question in the export of `cwd`'s workspace,
 * checked against the database. Reads only.
 */
export function planMigration(input: {
  cwd: string;
  env?: BrEnv;
}): MigrationPlan {
  const space = findBeadsWorkspace(input.cwd);
  if (space.kind !== 'found') {
    return {
      kind: 'failed',
      reason: `no beads workspace at ${input.cwd}: ${space.reason}`,
    };
  }
  const exportPath = join(space.beadsDir, 'issues.jsonl');
  let text: string;
  try {
    text = readFileSync(exportPath, 'utf8');
  } catch (error) {
    return {
      kind: 'failed',
      reason: `could not read ${exportPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const issues = new Map<string, TreeIssue>();
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    const parsed = parseExportLine(raw, space.beadsDir);
    if (!parsed.ok) {
      // A line that does not parse could be a question this run would miss:
      // a failure, never a skip (critical rule 7).
      return {
        kind: 'failed',
        reason: `line ${index + 1} of ${exportPath} is not a bead record (${parsed.reason})`,
      };
    }
    if (parsed.issue.status === 'tombstone') continue;
    issues.set(parsed.issue.id, parsed.issue);
  }

  const target = {db: space.db, env: input.env};
  const moves: Move[] = [];
  const refusals: Refusal[] = [];
  for (const question of issues.values()) {
    if (!question.labels.includes(ASK_LABEL)) continue;
    const request = question.parentIds
      .map((id) => issues.get(id))
      .find((parent) => parent?.labels.includes(REQUEST_LABEL) === true);
    if (request == null) continue;
    const refuse = (reason: string): void => {
      refusals.push({
        question: {id: question.id, title: question.title},
        reason,
      });
    };

    const sid = sidOf(question) ?? sidOf(request);
    if (sid == null) {
      refuse(
        `neither it nor its request ${request.id} carries a sid: label, so its session bead cannot be found`,
      );
      continue;
    }
    const sessions = [...issues.values()].filter(
      (issue) =>
        issue.labels.includes(SESSION_LABEL) && issue.labels.includes(sid),
    );
    const [session] = sessions;
    if (sessions.length !== 1 || session == null) {
      refuse(
        sessions.length === 0
          ? `no session bead (labels ${SESSION_LABEL} + ${sid}) in ${exportPath}`
          : `${sessions.length} session beads carry ${sid}: ${sessions.map((issue) => issue.id).join(', ')}`,
      );
      continue;
    }
    const link = toLabelFor(request.id);
    if (!link.ok) {
      refuse(`its to: label cannot be written: ${link.reason}`);
      continue;
    }
    // The export can lag the database: the move is planned only when the
    // DATABASE says the question is still the request's child.
    const children = brChildren(target, request.id);
    if (children.kind === 'failed') {
      refuse(
        `could not read ${request.id}'s children from the database: ${describeBrFailed(children)}`,
      );
      continue;
    }
    if (children.kind === 'notFound') {
      refuse(`the database has no ${request.id} (the export is stale)`);
      continue;
    }
    if (!children.children.some((child) => child.id === question.id)) {
      refuse(
        `the database no longer lists it as a child of ${request.id} (the export is stale)`,
      );
      continue;
    }
    moves.push({
      question: {
        id: question.id,
        status: question.status,
        title: question.title,
      },
      request: {id: request.id, title: request.title},
      session: {id: session.id, title: session.title},
      toLabel: link.label,
    });
  }
  const byId = (a: {question: {id: string}}, b: {question: {id: string}}) =>
    a.question.id.localeCompare(b.question.id, 'en', {numeric: true});
  return {
    db: space.db,
    exportPath,
    kind: 'planned',
    moves: moves.sort(byId),
    refusals: refusals.sort(byId),
  };
}

/** The two br commands a move runs, as a reader would type them. */
export function moveCommands(move: Move): string[] {
  return [
    `br update ${move.question.id} --add-label=${move.toLabel} --parent=`,
    `br update ${move.question.id} --parent=${move.session.id}`,
  ];
}

export type MoveResult = {kind: 'moved'} | {kind: 'failed'; reason: string};

/** One move, written and read back. */
export function applyMove(
  move: Move,
  target: {db: string; env?: BrEnv},
): MoveResult {
  const detached = brUpdate(target, move.question.id, {
    addLabels: [move.toLabel],
    parent: {kind: 'remove'},
  });
  if (detached.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `step 1 (add the label, remove the parent) failed; nothing changed for it: ${describeBrFailed(detached)}`,
    };
  }
  const attached = brUpdate(target, move.question.id, {
    parent: {id: move.session.id, kind: 'set'},
  });
  if (attached.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `step 2 (set the parent to ${move.session.id}) failed AFTER step 1 removed its parent: it now has NO parent (it keeps its labels, so the session still lists it). Run: ${moveCommands(move)[1] ?? ''} — ${describeBrFailed(attached)}`,
    };
  }
  // Read back: never report a move nobody looked at.
  const shown = brShow(target, move.question.id);
  const underSession = brChildren(target, move.session.id);
  const underRequest = brChildren(target, move.request.id);
  const problems: string[] = [];
  if (shown.kind !== 'ok') {
    problems.push(`could not read it back (${shown.kind})`);
  } else {
    if (!shown.issue.labels.includes(move.toLabel)) {
      problems.push(`the label ${move.toLabel} is missing`);
    }
    if (shown.issue.status !== move.question.status) {
      problems.push(
        `its status changed from ${move.question.status} to ${shown.issue.status}`,
      );
    }
  }
  if (underSession.kind !== 'ok') {
    problems.push(`could not read ${move.session.id}'s children`);
  } else if (
    !underSession.children.some((child) => child.id === move.question.id)
  ) {
    problems.push(`${move.session.id} does not list it as a child`);
  }
  if (underRequest.kind !== 'ok') {
    problems.push(`could not read ${move.request.id}'s children`);
  } else if (
    underRequest.children.some((child) => child.id === move.question.id)
  ) {
    problems.push(`${move.request.id} still lists it as a child`);
  }
  return problems.length === 0
    ? {kind: 'moved'}
    : {
        kind: 'failed',
        reason: `written, but the read-back disagrees: ${problems.join('; ')}`,
      };
}

function moveBlock(move: Move, verdict: string): string {
  return [
    `  ${move.question.id}  "${move.question.title}" (${move.question.status})`,
    '',
    `      from:     ${move.request.id}  "${move.request.title}"`,
    `      to:       ${move.session.id}  "${move.session.title}"`,
    `      label:    ${move.toLabel}`,
    `      result:   ${verdict}`,
  ].join('\n');
}

export function runMigration(options: {
  apply: boolean;
  cwd: string;
  env?: BrEnv;
}): number {
  const plan = planMigration({cwd: options.cwd, env: options.env});
  if (plan.kind === 'failed') {
    console.error(`migrate-ask-parents: ${plan.reason}`);
    return 2;
  }
  const blocks: string[] = [
    `migrate-ask-parents — ${options.apply ? 'APPLY' : 'dry run (nothing is written; --apply writes)'}`,
    `  database:  ${plan.db}`,
  ];
  if (plan.moves.length === 0 && plan.refusals.length === 0) {
    blocks.push(
      'No old-shape questions: every question is already under its session bead.',
    );
    console.log(blocks.join('\n\n'));
    return 0;
  }
  let failed = 0;
  for (const move of plan.moves) {
    if (!options.apply) {
      blocks.push(
        moveBlock(move, 'would move, with:'),
        moveCommands(move)
          .map((command) => `        ${command}`)
          .join('\n'),
      );
      continue;
    }
    const result = applyMove(move, {db: plan.db, env: options.env});
    if (result.kind === 'failed') failed += 1;
    blocks.push(
      moveBlock(
        move,
        result.kind === 'moved' ? 'moved' : `FAILED — ${result.reason}`,
      ),
    );
  }
  for (const refusal of plan.refusals) {
    blocks.push(
      `  ${refusal.question.id}  "${refusal.question.title}"\n\n      result:   NOT MOVED — ${refusal.reason}`,
    );
  }
  blocks.push(
    `${plan.moves.length} to move${options.apply ? ` (${plan.moves.length - failed} moved, ${failed} failed)` : ''}, ${plan.refusals.length} refused.${options.apply && plan.moves.length > failed ? ' Commit .beads/issues.jsonl.' : ''}`,
  );
  console.log(blocks.join('\n\n'));
  return failed > 0 || plan.refusals.length > 0 ? 1 : 0;
}

const NARRATIVE = `
Moves every OLD-SHAPE question (an \`ask\` bead that is the child of a
\`request\` bead, open or closed) under its session bead and adds the
\`to:<request>\` label \`thread ask\` now writes (home-base-vzwbj.4.16). The id
and the status never change.

DRY RUN BY DEFAULT: prints each question, where it goes, and the two br
commands. --apply runs them through the br adapter and reads each one back.

EXIT 0 nothing to move, or every move done · 1 a question was refused or a
move failed · 2 no beads workspace, or its export could not be read.`;

export async function main(argv: string[]): Promise<number> {
  let exitCode = 0;
  await yargs(hideBin(argv))
    .scriptName('migrate-ask-parents')
    .command(
      '$0',
      'Move old-shape questions under their session bead (dry run unless --apply).',
      (y: Argv) =>
        y
          .option('cwd', {
            demandOption: true,
            describe:
              'REQUIRED: the checkout whose beads to migrate (no default, so it never migrates whatever directory it happened to run in)',
            type: 'string',
          })
          .option('dry-run', {
            default: true,
            describe: 'Print the plan and write nothing (the default)',
            type: 'boolean',
          })
          .option('apply', {
            default: false,
            describe: 'Write the moves and read each one back',
            type: 'boolean',
          }),
      (args) => {
        exitCode = runMigration({
          apply: args.apply,
          cwd: resolve(args.cwd),
          env: process.env,
        });
      },
    )
    .epilogue(NARRATIVE)
    .version(false)
    .alias('h', 'help')
    .strict()
    .help()
    .wrap(Math.min(100, process.stdout.columns ?? 100))
    .parseAsync();
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
