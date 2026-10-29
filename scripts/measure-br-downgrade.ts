#!/usr/bin/env bun
/**
 * measure-br-downgrade — what an OLD br does to a beads DB that a NEW br
 * created (home-base-dj5m9.1.5, item 6).
 *
 * WHY. After home-base moves its pin to br 0.7.6, main's DB is schema 19. An
 * old worktree still runs its own SDK, which passes `--db <main's DB>` to the
 * br its own mise.toml pins (0.1.37) for every thread command. Whether that br
 * refuses loudly, or reads and writes a DB it does not understand, decides how
 * dangerous an old worktree is after the flip. measure-br-contract's --old-br
 * measures the other direction (a new br opening an old DB).
 *
 * WHAT. In a scratch git repo under the OS temp dir:
 *   1. the NEW br inits the repo and creates two beads, one carrying fields
 *      only the new br has (`--prerequisites`, `--agent-context`); committed;
 *      a linked worktree is cut from that commit, with no DB of its own.
 *   2. the OLD br runs list, show, create, update, close and
 *      `sync --flush-only`, first with `--db <main's DB>` from the main
 *      checkout (the way the SDK calls it, `--no-auto-import` included), then
 *      from the linked worktree: with `--db <main's DB>`, and bare.
 *   3. the NEW br opens the DB again: `list`, `doctor`, `show` of the bead
 *      with new-only fields (bare, so its auto-import runs), and a fresh full
 *      export compared field by field with the JSONL the OLD br wrote.
 * Every bead title carries the test-data marker given by --marker. The scratch
 * repo is removed afterwards unless --keep. Nothing outside it is written.
 *
 *   bun run measure:br-downgrade --new-br <path> --old-br <path> --marker <uuid> [--keep]
 */

import {spawnSync} from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const HELP = `measure-br-downgrade — what an old br does to a beads DB a new br created

Usage: bun run measure:br-downgrade --new-br <path> --old-br <path> --marker <uuid> [--keep]

  --new-br <path>  the br that creates the DB (for the 0.7.6 flip: 0.7.6)
  --old-br <path>  the br that then opens it (for the 0.7.6 flip: 0.1.37)
  --marker <uuid>  the session's test-data UUID, put in every bead title
  --keep           leave the scratch repo in place and print its path

Writes only inside one scratch git repo under the OS temp dir.`;

interface Args {
  keep: boolean;
  marker: string;
  newBr: string;
  oldBr: string;
}

function parseArgs(argv: string[]): Args | null {
  let newBr: string | null = null;
  let oldBr: string | null = null;
  let marker: string | null = null;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--keep') keep = true;
    else if (arg === '--new-br' && next != null) {
      newBr = next;
      index += 1;
    } else if (arg === '--old-br' && next != null) {
      oldBr = next;
      index += 1;
    } else if (arg === '--marker' && next != null) {
      marker = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (newBr == null || oldBr == null || marker == null) {
    throw new Error('--new-br, --old-br and --marker are all required');
  }
  return {keep, marker, newBr, oldBr};
}

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function run(command: string, args: readonly string[], cwd: string): RunResult {
  const proc = spawnSync(command, args, {cwd, encoding: 'utf-8'});
  if (proc.error != null) {
    throw new Error(`${command} could not run: ${proc.error.message}`);
  }
  return {
    status: proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: (proc.stdout ?? '').trim(),
  };
}

function must(command: string, args: readonly string[], cwd: string): string {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? '?'}: ${result.stderr !== '' ? result.stderr : result.stdout}`,
    );
  }
  return result.stdout;
}

/** At most `max` characters, on one line. */
function clip(text: string, max = 200): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function outcome(result: RunResult): string {
  const said = result.stderr !== '' ? result.stderr : result.stdout;
  return `exit ${result.status ?? 'killed'}${said === '' ? '' : `: ${clip(said)}`}`;
}

/** One SQL answer from a read-only sqlite3; the error text when it fails. */
function sql(db: string, query: string): string {
  const result = run('sqlite3', ['-readonly', db, query], '/');
  return result.status === 0
    ? result.stdout
    : `sqlite3 failed: ${clip(result.stderr)}`;
}

/** JSON from the first `{` or `[` on: a warning can precede br's output. */
function parseJson(text: string): unknown {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error(`no JSON in: ${clip(text)}`);
  return JSON.parse(text.slice(Math.min(...starts))) as unknown;
}

type Row = Record<string, unknown>;

function jsonlRows(path: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as Row;
    if (typeof row.id === 'string') rows.set(row.id, row);
  }
  return rows;
}

/** Field names whose values differ between two exports of one issue. */
function fieldDiff(a: Row, b: Row): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/** The first issue of a `show --json` body (br prints an object or an array). */
function shownIssue(text: string): Row | null {
  const body = parseJson(text);
  const issue = Array.isArray(body) ? (body[0] as unknown) : body;
  return issue != null && typeof issue === 'object' ? (issue as Row) : null;
}

function measure(args: Args): string[] {
  const {newBr, oldBr} = args;
  const tag = `[TEST_DATA_DELETABLE ${args.marker} ]`;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'br-downgrade-'));
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  const db = join(main, '.beads', 'beads.db');
  const jsonl = join(main, '.beads', 'issues.jsonl');
  const lines = [
    `new br: ${must(newBr, ['--version'], root)}`,
    `old br: ${must(oldBr, ['--version'], root)}`,
    `scratch: ${root}`,
  ];
  const count = () =>
    sql(db, 'select count(*) from issues') +
    ' issues; ' +
    sql(db, "select count(*) from issues where status = 'closed'") +
    ' closed';

  try {
    // 1. The new br makes the DB.
    mkdirSync(main);
    must('git', ['init', '-q', '-b', 'main'], main);
    must('git', ['config', 'user.email', 'probe@example.invalid'], main);
    must('git', ['config', 'user.name', 'probe'], main);
    must(newBr, ['init', '--prefix', 'd', '-q'], main);
    const rich = must(
      newBr,
      [
        'create',
        `new-only fields ${tag}`,
        '--prerequisites',
        'a prerequisite only the new br stores',
        '--agent-context',
        '{"note": "agent context only the new br stores"}',
        '--silent',
      ],
      main,
    );
    const plain = must(newBr, ['create', `plain ${tag}`, '--silent'], main);
    must('git', ['add', '-A'], main);
    must('git', ['commit', '-qm', 'seed'], main);
    must('git', ['worktree', 'add', '-q', wt, '-b', 'wtb'], main);
    lines.push(
      '1. the new br created the DB',
      `  schema user_version ${sql(db, 'pragma user_version')}; ${count()}`,
      `  ${rich}: prerequisites ${JSON.stringify(sql(db, `select prerequisites from issues where id = '${rich}'`))}, agent_context ${JSON.stringify(sql(db, `select agent_context from issues where id = '${rich}'`))}`,
    );

    // 2. The old br, the way the old SDK calls it.
    const old = (label: string, brArgs: string[], cwd: string) => {
      const before = count();
      const result = run(oldBr, brArgs, cwd);
      lines.push(
        `  ${label}: ${outcome(result)}`,
        `    DB before: ${before}; after: ${count()}; user_version ${sql(db, 'pragma user_version')}`,
      );
      return result;
    };
    const viaDb = ['--db', db];
    const noImport = '--no-auto-import';
    lines.push('2a. old br with --db <main DB>, from the main checkout');
    old('list --json', [...viaDb, 'list', '--json', noImport], main);
    old('list --json (auto-import on)', [...viaDb, 'list', '--json'], main);
    old(
      `show ${rich} --json`,
      [...viaDb, 'show', rich, '--json', noImport],
      main,
    );
    const created = old(
      'create',
      [...viaDb, 'create', `old br create ${tag}`, '--silent', noImport],
      main,
    );
    // The shape of the SDK's thread writes: labels and a parent.
    const child = old(
      `create --parent ${rich} --labels`,
      [
        ...viaDb,
        'create',
        `old br child ${tag}`,
        '--parent',
        rich,
        '--labels',
        'request,sid:probe',
        '--silent',
        noImport,
      ],
      main,
    );
    if (child.status === 0) {
      const childId = child.stdout.trim();
      lines.push(
        `    its dependency row: ${JSON.stringify(sql(db, `select issue_id || ' ' || type || ' ' || depends_on_id from dependencies where issue_id = '${childId}'`))}; labels ${JSON.stringify(sql(db, `select group_concat(label, ',') from labels where issue_id = '${childId}'`))}`,
      );
    }
    old(
      `update ${rich} --title`,
      [
        ...viaDb,
        'update',
        rich,
        '--title',
        `retitled by old br ${tag}`,
        noImport,
      ],
      main,
    );
    old(
      `close ${plain}`,
      [...viaDb, 'close', plain, '--reason', 'old br', noImport],
      main,
    );
    const jsonlBeforeFlush = existsSync(jsonl)
      ? readFileSync(jsonl, 'utf-8')
      : '';
    old(
      'sync --flush-only',
      [...viaDb, 'sync', '--flush-only', noImport],
      main,
    );
    const oldJsonl = existsSync(jsonl) ? readFileSync(jsonl, 'utf-8') : '';
    lines.push(
      `    the old br's flush ${oldJsonl === jsonlBeforeFlush ? 'left the JSONL unchanged' : 'rewrote the JSONL'}`,
    );

    lines.push('2b. old br from the linked worktree (no DB of its own)');
    old(
      'create with --db <main DB>',
      [...viaDb, 'create', `old br from worktree ${tag}`, '--silent', noImport],
      wt,
    );
    old(
      'create, bare',
      ['create', `old br bare in worktree ${tag}`, '--silent', noImport],
      wt,
    );
    lines.push(
      `    worktree .beads after: ${existsSync(join(wt, '.beads')) ? JSON.stringify(run('ls', ['-A', join(wt, '.beads')], wt).stdout.split('\n')) : 'absent'}`,
    );
    const oldCreated = created.status === 0 ? created.stdout.trim() : null;

    // 3. The new br opens the DB again.
    const afterOldJsonl = existsSync(jsonl) ? readFileSync(jsonl, 'utf-8') : '';
    lines.push('3. the new br opens the DB again');
    const list = run(newBr, ['list', '--all', '--json', noImport], main);
    lines.push(
      `  list --all --json: ${list.status === 0 ? `exit 0, ${(parseJson(list.stdout) as {issues?: unknown[]}).issues?.length ?? '?'} issues` : outcome(list)}`,
    );
    const doctor = run(newBr, ['doctor'], main);
    const flagged = `${doctor.stdout}\n${doctor.stderr}`
      .split('\n')
      .filter((line) => /^(WARN|ERROR|FAIL)/.test(line.trim()));
    lines.push(
      `  doctor: exit ${doctor.status ?? 'killed'}; ${flagged.length === 0 ? 'no WARN/ERROR lines' : flagged.map((line) => clip(line.trim(), 160)).join(' | ')}`,
    );
    const shownBare = run(newBr, ['show', rich, '--json'], main);
    const richRow =
      shownBare.status === 0 ? shownIssue(shownBare.stdout) : null;
    lines.push(
      `  show ${rich} --json (bare, auto-import on): ${shownBare.status === 0 ? `prerequisites ${JSON.stringify(richRow?.prerequisites ?? null)}, agent_context ${JSON.stringify(richRow?.agent_context ?? null)}` : outcome(shownBare)}`,
      `  JSONL changed by those new-br commands: ${(existsSync(jsonl) ? readFileSync(jsonl, 'utf-8') : '') !== afterOldJsonl}`,
      `  DB row ${rich}: prerequisites ${JSON.stringify(sql(db, `select prerequisites from issues where id = '${rich}'`))}, agent_context ${JSON.stringify(sql(db, `select agent_context from issues where id = '${rich}'`))}`,
    );
    if (oldCreated != null) {
      lines.push(
        `  old-br bead ${oldCreated}: source_repo ${JSON.stringify(sql(db, `select source_repo from issues where id = '${oldCreated}'`))}, source_repo_path ${JSON.stringify(sql(db, `select source_repo_path from issues where id = '${oldCreated}'`))}`,
      );
    }

    // A fresh full export by the new br, in a copy, against the old br's JSONL.
    const copy = join(root, 'export-copy');
    cpSync(join(main, '.beads'), join(copy, '.beads'), {recursive: true});
    rmSync(join(copy, '.beads', 'issues.jsonl'), {force: true});
    const fresh = run(
      newBr,
      [
        '--db',
        join(copy, '.beads', 'beads.db'),
        'sync',
        '--flush-only',
        '--force',
        noImport,
      ],
      copy,
    );
    lines.push(`  fresh export by the new br (in a copy): ${outcome(fresh)}`);
    const oldRows = jsonlRows(join(main, '.beads', 'issues.jsonl'));
    const freshRows = jsonlRows(join(copy, '.beads', 'issues.jsonl'));
    lines.push(
      `  issues: old-br JSONL ${oldRows.size}, new-br fresh export ${freshRows.size}`,
    );
    for (const id of [
      ...new Set([...oldRows.keys(), ...freshRows.keys()]),
    ].sort()) {
      const a = oldRows.get(id);
      const b = freshRows.get(id);
      if (a == null || b == null) {
        lines.push(
          `    ${id}: only in the ${a == null ? 'fresh export' : "old br's JSONL"}`,
        );
        continue;
      }
      const diff = fieldDiff(a, b);
      lines.push(
        `    ${id}: ${diff.length === 0 ? 'identical' : `differs in ${diff.join(', ')}`}`,
      );
    }

    // Does the export heal on the new br's next write to ANOTHER issue?
    const healWrite = run(
      newBr,
      ['create', `new br after the old br ${tag}`, '--silent', noImport],
      main,
    );
    const healed = jsonlRows(jsonl).get(rich);
    const richFresh = freshRows.get(rich);
    lines.push(
      `  the new br's next write (a create): ${outcome(healWrite)}; ${rich} in the JSONL afterwards ${healed == null || richFresh == null ? 'missing' : fieldDiff(healed, richFresh).filter((key) => key !== 'updated_at').length === 0 ? 'carries the new-only fields again' : `still differs in ${fieldDiff(healed, richFresh).join(', ')}`}`,
    );

    // CONTROL: the same writes by the new br alone, then its doctor.
    const control = join(root, 'control');
    mkdirSync(control);
    must('git', ['init', '-q', '-b', 'main'], control);
    must(newBr, ['init', '--prefix', 'c', '-q'], control);
    const c1 = must(newBr, ['create', `control ${tag}`, '--silent'], control);
    const c2 = must(newBr, ['create', `control 2 ${tag}`, '--silent'], control);
    must(newBr, ['update', c1, '--title', `control retitled ${tag}`], control);
    must(newBr, ['close', c2, '--reason', 'control'], control);
    const controlDoctor = run(newBr, ['doctor'], control);
    const controlFlagged = `${controlDoctor.stdout}\n${controlDoctor.stderr}`
      .split('\n')
      .filter((line) => /^(WARN|ERROR|FAIL)/.test(line.trim()));
    lines.push(
      `CONTROL: the same create/update/close by the new br alone, then doctor: exit ${controlDoctor.status ?? 'killed'}; ${controlFlagged.length === 0 ? 'no WARN/ERROR lines' : controlFlagged.map((line) => clip(line.trim(), 160)).join(' | ')}`,
    );
    if (args.keep) lines.push(`kept: ${root}`);
  } finally {
    if (!args.keep) rmSync(root, {force: true, recursive: true});
  }
  return lines;
}

function cli(): number {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 2;
  }
  if (args == null) {
    console.log(HELP);
    return 0;
  }
  try {
    console.log(measure(args).join('\n'));
    return 0;
  } catch (error) {
    console.error(
      `measurement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(cli());
}
