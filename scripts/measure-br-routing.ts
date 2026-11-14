#!/usr/bin/env bun
/**
 * measure-br-routing: does br's cross-workspace routing (`.beads/routes.jsonl`)
 * read and write another repo's beads, and what happens when the two repos pin
 * different br versions? (home-base-l2ejg.6, item 2; D8 in home-base-l2ejg.3.)
 *
 * WHY. A routed command runs the CALLER's br against the TARGET's database.
 * Repos pin different brs (0.1.37 in home-base and most repos, 0.4.1 in
 * nature-sounds). D8 enables routing in live repos only if same-version reads
 * and writes work AND a mismatched version is refused. This measures both,
 * on copies.
 *
 * WHAT. Under the OS temp dir, one scratch dir per repo given, each a fresh
 * `git init` holding a COPY of that repo's `.beads/issues.jsonl`, `config.yaml`
 * and `metadata.json` only (never a live database file: each copy's own br
 * builds its database from the export, as in a fresh clone). Then:
 *   A. the caller copy gets a routes.jsonl naming the same-pin copy and the
 *      other-pin copy, and the CALLER's br runs `show` and `update --notes` of
 *      one open bead of each, from the caller copy;
 *   B. the other-pin copy gets a routes.jsonl naming the same-pin copy, and
 *      the OTHER br runs `show` and `update --notes` of a bead there (a newer
 *      br on an older database, when the other pin is the newer);
 *   C. after each write, the target's own br reads the bead back, and every
 *      database's schema (PRAGMA user_version) is printed before and after.
 * Every note written carries the test-data marker. The scratch dir is removed
 * afterwards unless --keep. Nothing outside it is written; the live repos are
 * only read (three small files each).
 *
 *   bun run measure:br-routing --caller <repo> --caller-br <path> --same <repo> --same-br <path> --other <repo> --other-br <path> --marker <uuid> [--keep]
 */

import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';

import {readDbSchema} from '../src/beads/br';

const HELP = `measure-br-routing: br routing (.beads/routes.jsonl) on copies, same and mismatched br versions

Usage: bun run measure:br-routing --caller <repo> --caller-br <path> --same <repo> --same-br <path> --other <repo> --other-br <path> --marker <uuid> [--keep]

  --caller <repo>     the repo whose copy holds the routes (home-base)
  --caller-br <path>  the br the caller repo pins
  --same <repo>       a repo on the SAME br pin as the caller
  --same-br <path>    its br (the same version as --caller-br)
  --other <repo>      a repo on a DIFFERENT br pin
  --other-br <path>   its br
  --marker <uuid>     the session's test-data UUID, put in every note written
  --keep              leave the scratch dir in place and print its path

Reads three files from each repo's .beads/ and writes only inside one scratch
dir under the OS temp dir.`;

interface Args {
  caller: string;
  callerBr: string;
  keep: boolean;
  marker: string;
  other: string;
  otherBr: string;
  same: string;
  sameBr: string;
}

const FLAGS = {
  '--caller': 'caller',
  '--caller-br': 'callerBr',
  '--marker': 'marker',
  '--other': 'other',
  '--other-br': 'otherBr',
  '--same': 'same',
  '--same-br': 'sameBr',
} as const;

function parseArgs(argv: string[]): Args | null {
  const values: Partial<Record<(typeof FLAGS)[keyof typeof FLAGS], string>> =
    {};
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--keep') {
      keep = true;
      continue;
    }
    const key = (FLAGS as Record<string, (typeof FLAGS)[keyof typeof FLAGS]>)[
      arg
    ];
    const next = argv[index + 1];
    if (key == null || next == null) {
      throw new Error(`unknown argument or missing value: ${arg}`);
    }
    values[key] = next;
    index += 1;
  }
  const {caller, callerBr, marker, other, otherBr, same, sameBr} = values;
  if (
    caller == null ||
    callerBr == null ||
    marker == null ||
    other == null ||
    otherBr == null ||
    same == null ||
    sameBr == null
  ) {
    throw new Error(
      'all of --caller, --caller-br, --same, --same-br, --other, --other-br and --marker are required',
    );
  }
  return {caller, callerBr, keep, marker, other, otherBr, same, sameBr};
}

/** At most `max` characters, on one line. */
function clip(text: string, max = 400): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The environment br runs in: no inherited BEADS_* overrides. */
function brEnv(): NodeJS.ProcessEnv {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (key.startsWith('BEADS_')) delete env[key];
  }
  return env;
}

interface Ran {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Run one command, print it and what it gave, and return it. */
function step(label: string, br: string, args: string[], cwd: string): Ran {
  const proc = spawnSync(br, args, {cwd, encoding: 'utf-8', env: brEnv()});
  const ran: Ran = {
    status: proc.error != null ? null : proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: (proc.stdout ?? '').trim(),
  };
  console.log(`\n[${label}]`);
  console.log(`  $ (cd ${cwd}) ${br} ${args.join(' ')}`);
  console.log(`  exit ${ran.status ?? `none (${proc.error?.message ?? '?'})`}`);
  if (ran.stdout !== '') console.log(`  stdout: ${clip(ran.stdout)}`);
  if (ran.stderr !== '') console.log(`  stderr: ${clip(ran.stderr)}`);
  return ran;
}

function brVersion(br: string): string {
  const proc = spawnSync(br, ['--version'], {encoding: 'utf-8', env: brEnv()});
  const text = (proc.stdout ?? '').trim();
  return text === '' ? `unknown (exit ${proc.status ?? '?'})` : text;
}

/** A list in words, or "none" for an empty one. */
function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

/** The schema of the copy's database, in words. */
function schemaOf(copy: string): string {
  const db = join(copy, '.beads', 'beads.db');
  if (!existsSync(db)) return 'no database';
  const read = readDbSchema(db);
  return read.kind === 'read'
    ? `schema ${read.schema}`
    : `unreadable (${read.kind}: ${'reason' in read ? read.reason : ''})`;
}

const COPIED = ['issues.jsonl', 'config.yaml', 'metadata.json'];

/** A scratch copy of `repo`'s beads export at `<root>/<name>`. */
function copyRepo(root: string, repo: string): string {
  const dest = join(root, basename(repo));
  mkdirSync(join(dest, '.beads'), {recursive: true});
  for (const file of COPIED) {
    const from = join(repo, '.beads', file);
    if (existsSync(from)) copyFileSync(from, join(dest, '.beads', file));
  }
  const git = spawnSync('git', ['init', '-q'], {cwd: dest, encoding: 'utf-8'});
  if (git.status !== 0) throw new Error(`git init failed in ${dest}`);
  return dest;
}

/** The first open bead of a copy's export, with its prefix. */
function openBead(copy: string): {id: string; prefix: string} {
  const text = readFileSync(join(copy, '.beads', 'issues.jsonl'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as {id?: unknown; status?: unknown};
    if (
      typeof record.id === 'string' &&
      record.status !== 'closed' &&
      record.status !== 'tombstone'
    ) {
      return {
        id: record.id,
        prefix: record.id.slice(0, record.id.lastIndexOf('-') + 1),
      };
    }
  }
  throw new Error(`no open bead in ${copy}`);
}

/** The notes br prints for `id`, or why it printed none. */
function notesIn(ran: Ran): string {
  try {
    const parsed: unknown = JSON.parse(
      ran.stdout.slice(ran.stdout.indexOf('[')),
    );
    const issue = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    if (issue != null && typeof issue === 'object' && 'notes' in issue) {
      return String((issue as {notes: unknown}).notes);
    }
    return '(no notes field)';
  } catch {
    return `(not JSON, exit ${ran.status ?? '?'})`;
  }
}

/** The JSON keys any record of a copy's export holds. */
function exportKeys(copy: string): string[] {
  const keys = new Set<string>();
  const text = readFileSync(join(copy, '.beads', 'issues.jsonl'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    for (const key of Object.keys(JSON.parse(line) as object)) keys.add(key);
  }
  return [...keys].sort();
}

function writeRoutes(
  copy: string,
  routes: {path: string; prefix: string}[],
): void {
  const path = join(copy, '.beads', 'routes.jsonl');
  writeFileSync(path, routes.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nroutes.jsonl in ${copy}:`);
  for (const r of routes) console.log(`  ${JSON.stringify(r)}`);
}

function main(): number {
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'br-routing-')));
  console.log(`scratch dir: ${root}`);
  console.log(`caller br: ${args.callerBr} → ${brVersion(args.callerBr)}`);
  console.log(`same br:   ${args.sameBr} → ${brVersion(args.sameBr)}`);
  console.log(`other br:  ${args.otherBr} → ${brVersion(args.otherBr)}`);
  try {
    const caller = copyRepo(root, args.caller);
    const same = copyRepo(root, args.same);
    const other = copyRepo(root, args.other);

    // Each copy's own br builds its database from the export.
    step('build caller db', args.callerBr, ['list', '--limit', '1'], caller);
    step('build same db', args.sameBr, ['list', '--limit', '1'], same);
    step('build other db', args.otherBr, ['list', '--limit', '1'], other);
    console.log(
      `\nschemas: caller ${schemaOf(caller)}, same ${schemaOf(same)}, other ${schemaOf(other)}`,
    );

    const sameBead = openBead(same);
    const otherBead = openBead(other);
    writeRoutes(caller, [
      {path: `../${basename(same)}`, prefix: sameBead.prefix},
      {path: `../${basename(other)}`, prefix: otherBead.prefix},
    ]);
    const note = (what: string): string =>
      `[TEST_DATA_DELETABLE ${args.marker} ] routed write: ${what}`;

    // A. Same version, caller to same.
    step(
      'A1 same-version routed read',
      args.callerBr,
      ['show', sameBead.id, '--json'],
      caller,
    );
    step(
      'A2 same-version routed write',
      args.callerBr,
      ['update', sameBead.id, '--notes', note('same version')],
      caller,
    );
    const backSame = step(
      'A3 target br reads it back',
      args.sameBr,
      ['show', sameBead.id, '--json'],
      same,
    );
    console.log(`  notes now: ${clip(notesIn(backSame), 200)}`);
    console.log(
      `  target export holds the note: ${readFileSync(join(same, '.beads', 'issues.jsonl'), 'utf8').includes(args.marker)}`,
    );
    console.log(
      `  caller export holds the note: ${readFileSync(join(caller, '.beads', 'issues.jsonl'), 'utf8').includes(args.marker)}`,
    );

    // A'. Mismatched version, caller's br on the other repo's database.
    const otherSchemaBefore = schemaOf(other);
    const otherKeysBefore = exportKeys(other);
    step(
      'A4 mismatched routed read',
      args.callerBr,
      ['show', otherBead.id, '--json'],
      caller,
    );
    step(
      'A5 mismatched routed write',
      args.callerBr,
      ['update', otherBead.id, '--notes', note('mismatched version')],
      caller,
    );
    const backOther = step(
      'A6 target br reads it back',
      args.otherBr,
      ['show', otherBead.id, '--json'],
      other,
    );
    console.log(`  notes now: ${clip(notesIn(backOther), 200)}`);
    console.log(
      `  other schema: before ${otherSchemaBefore}, after ${schemaOf(other)}`,
    );
    const otherKeysAfter = exportKeys(other);
    console.log(
      `  export keys lost: ${listOrNone(otherKeysBefore.filter((k) => !otherKeysAfter.includes(k)))}; gained: ${listOrNone(otherKeysAfter.filter((k) => !otherKeysBefore.includes(k)))}`,
    );

    // B. The other br, routed onto the same-pin repo's database.
    writeRoutes(other, [
      {path: `../${basename(same)}`, prefix: sameBead.prefix},
    ]);
    const sameSchemaBefore = schemaOf(same);
    step(
      'B1 other br routed read',
      args.otherBr,
      ['show', sameBead.id, '--json'],
      other,
    );
    console.log(
      `  same schema: before the read ${sameSchemaBefore}, after it ${schemaOf(same)}`,
    );
    step(
      'B2 other br routed write',
      args.otherBr,
      ['update', sameBead.id, '--notes', note('other br on same-pin db')],
      other,
    );
    console.log(`  same schema after the write: ${schemaOf(same)}`);
    const backB = step(
      'B3 same-pin br reads it back',
      args.sameBr,
      ['show', sameBead.id, '--json'],
      same,
    );
    console.log(`  notes now: ${clip(notesIn(backB), 200)}`);
    step(
      'B4 same-pin br lists its db',
      args.sameBr,
      ['list', '--limit', '1'],
      same,
    );
  } finally {
    if (args.keep) console.log(`\nkept: ${root}`);
    else rmSync(root, {force: true, recursive: true});
  }
  return 0;
}

process.exit(main());
