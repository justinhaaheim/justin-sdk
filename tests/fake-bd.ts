/**
 * A stateful fake `bd`, for the write-path tests that need bd to FAIL PARTWAY
 * (home-base-p1uj.6 F1).
 *
 * The real adapter shells out to `bun run bd` in a workspace directory, so the
 * cheapest honest fake is a real workspace whose `bd` script is this file.
 * Nothing is mocked at the module boundary: `writeReportToBd` runs unmodified,
 * spawns a real subprocess, and parses real stdout. That matters here, because
 * the bug under test is about what bd LEAVES BEHIND when it dies mid-sequence —
 * a thing a stubbed adapter cannot reproduce.
 *
 * It implements only the commands this SDK issues, and it is deliberately
 * strict: an unrecognised command exits non-zero rather than returning
 * something plausible.
 */

import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

export interface FakeIssue {
  closeReason?: string;
  description?: string;
  id: string;
  metadata?: Record<string, unknown>;
  notes?: string;
  parent?: string | null;
  status: string;
  title: string;
  type: string;
}

export interface FakeComment {
  id: string;
  text: string;
}

export interface FakeState {
  /** How many `create -t ask` calls have been made. Reset to retry a run. */
  askCreates?: number;
  /** Every comment written, in order. */
  comments?: FakeComment[];
  /** Fail the Nth `create -t ask` of each run (1-based). 0 = never fail. */
  failAskCreateAt: number;
  /** Fail `comments add` for this bead id. Null = never fail. */
  failCommentAddFor?: string | null;
  issues: FakeIssue[];
  /** Every command line the SDK issued, in order. */
  log: string[];
  nextId: number;
}

/** The script body written into the fake workspace. Kept as source, not a build artefact. */
const SCRIPT = `
import {readFileSync, writeFileSync} from 'fs';

const statePath = process.env.FAKE_BD_STATE;
if (statePath == null) { console.error('FAKE_BD_STATE unset'); process.exit(1); }
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);
state.log.push(argv.join(' '));

function save() { writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}
function metadataFrom() {
  const raw = flag('--metadata');
  if (raw == null || !raw.startsWith('@')) return {};
  return JSON.parse(readFileSync(raw.slice(1), 'utf8'));
}
function out(value) { process.stdout.write(JSON.stringify(value)); }

const command = argv[0];

if (command === 'types') { process.stdout.write('thread ask docs question'); save(); process.exit(0); }

if (command === 'list') {
  const type = flag('-t');
  const parent = flag('--parent');
  const field = flag('--metadata-field');
  let rows = state.issues.filter((i) => type == null || i.type === type);
  if (parent != null) rows = rows.filter((i) => i.parent === parent);
  if (field != null) {
    const [key, value] = field.split('=');
    rows = rows.filter((i) => String((i.metadata ?? {})[key]) === value);
  }
  if (!argv.includes('--all')) rows = rows.filter((i) => i.status !== 'closed');
  out(rows.map(shape));
  save(); process.exit(0);
}

if (command === 'show') {
  const found = state.issues.find((i) => i.id === argv[1]);
  out(found == null ? [] : [shape(found)]);
  save(); process.exit(0);
}

if (command === 'create') {
  const type = flag('-t');
  if (type === 'ask') {
    state.askCreates = (state.askCreates ?? 0) + 1;
    if (state.failAskCreateAt > 0 && state.askCreates === state.failAskCreateAt) {
      save();
      console.error('error: database is locked');
      process.exit(1);
    }
  }
  const parent = flag('--parent');
  const id = parent == null
    ? 'jl-t' + state.nextId++
    : parent + '.' + (state.issues.filter((i) => i.parent === parent).length + 1);
  state.issues.push({
    description: flag('-d') ?? '',
    id,
    metadata: metadataFrom(),
    notes: flag('--notes') ?? '',
    parent: parent ?? null,
    status: 'open',
    title: argv[1],
    type,
  });
  process.stdout.write(id);
  save(); process.exit(0);
}

if (command === 'update') {
  const found = state.issues.find((i) => i.id === argv[1]);
  if (found == null) { console.error('no such issue'); process.exit(1); }
  if (flag('--title') != null) found.title = flag('--title');
  if (flag('-d') != null) found.description = flag('-d');
  if (flag('--notes') != null) found.notes = flag('--notes');
  if (flag('-s') != null) found.status = flag('-s');
  if (argv.includes('--metadata')) {
    found.metadata = {...(found.metadata ?? {}), ...metadataFrom()};
  }
  save(); process.exit(0);
}

if (command === 'comments') {
  if (argv[1] === 'add') {
    const id = argv[2];
    if (state.failCommentAddFor === id) {
      save();
      console.error('error: database is locked');
      process.exit(1);
    }
    state.comments = state.comments ?? [];
    state.comments.push({id, text: argv[3] ?? ''});
    save(); process.exit(0);
  }
  const id = argv[1];
  out((state.comments ?? []).filter((c) => c.id === id).map((c) => ({author: 'jhaa', created_at: '2026-09-12T12:00:00Z', text: c.text})));
  save(); process.exit(0);
}

if (command === 'close') {
  const found = state.issues.find((i) => i.id === argv[1]);
  if (found == null) { console.error('no such issue'); process.exit(1); }
  found.status = 'closed';
  found.closeReason = flag('--reason') ?? '';
  save(); process.exit(0);
}

function shape(i) {
  return {
    close_reason: i.closeReason ?? null,
    description: i.description ?? '',
    id: i.id,
    issue_type: i.type,
    metadata: i.metadata ?? {},
    notes: i.notes ?? '',
    parent: i.parent ?? null,
    status: i.status,
    title: i.title,
  };
}

console.error('fake bd: unsupported command ' + argv.join(' '));
process.exit(1);
`;

export interface FakeBd {
  cleanup: () => void;
  dir: string;
  env: Record<string, string | undefined>;
  read: () => FakeState;
  write: (state: FakeState) => void;
}

/**
 * Build a throwaway workspace whose `bun run bd` is the fake.
 *
 * `failCommentAddFor` fails `comments add` for ONE bead id, which is how the
 * answer walk's "a write failed, keep going" path is exercised: the failure has
 * to land on a specific ask, mid-walk, with asks after it still to come.
 */
export function createFakeBd(
  failAskCreateAt = 0,
  failCommentAddFor: string | null = null,
): FakeBd {
  const dir = mkdtempSync(join(tmpdir(), 'fake-bd-'));
  const script = join(dir, 'bd.ts');
  const statePath = join(dir, 'state.json');
  // A REAL beads workspace has a `.beads` directory, and since F9 the commands
  // probe for it instead of creating it — a fake workspace without one now
  // (correctly) reports "life beads dir missing" and never reaches bd at all.
  mkdirSync(join(dir, '.beads'), {recursive: true});
  writeFileSync(script, SCRIPT);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({name: 'fake-life', scripts: {bd: `bun ${script}`}}),
  );
  const initial: FakeState = {
    comments: [],
    failAskCreateAt,
    failCommentAddFor,
    issues: [],
    log: [],
    nextId: 1,
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2));
  return {
    cleanup: () => {
      // The OS reclaims $TMPDIR; leaving it costs nothing and keeps a failing
      // run's state inspectable.
    },
    dir,
    env: {...process.env, FAKE_BD_STATE: statePath},
    read: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState,
    write: (state: FakeState) =>
      writeFileSync(statePath, JSON.stringify(state, null, 2)),
  };
}
