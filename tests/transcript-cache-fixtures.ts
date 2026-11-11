/**
 * The committed synthetic transcripts the transcript cache is tested on
 * (home-base-9uzxw.11), shared by tests/thread-transcript-cache.test.ts and
 * scripts/transcript-cache-golden.ts. Every file carries the session's test
 * data marker; none is a copy of a real transcript.
 *
 * Placeholders: `__CWD__` (the checkout the session ran in) and `__SHA__`
 * (the short sha of the commit the tracked session's Bash call made).
 */

import type {TranscriptFileFacts} from '../src/thread/transcript-cache';

import {readFileSync} from 'fs';
import {join} from 'path';

import {transcriptFileFactsOfBytes} from '../src/thread/transcript-cache';

export const FIXTURE_DIR = join(
  import.meta.dir,
  'fixtures',
  'transcript-cache',
);
export const GOLDEN_PATH = join(FIXTURE_DIR, 'golden.json');

export const TRACKED_SID = '9b0eb49b-0000-4000-8000-00000000c001';
export const UNTRACKED_SID = '9b0eb49b-0000-4000-8000-00000000c002';

export interface FixtureFile {
  /** The subagent file's name under `<session>/subagents/`; null for a main transcript. */
  agent: string | null;
  name: string;
  session: string;
}

export const FIXTURE_FILES: readonly FixtureFile[] = [
  {agent: null, name: 'tracked.jsonl', session: TRACKED_SID},
  {
    agent: 'agent-p1.jsonl',
    name: 'tracked.agent-p1.jsonl',
    session: TRACKED_SID,
  },
  {
    agent: 'agent-p2.jsonl',
    name: 'tracked.agent-p2.jsonl',
    session: TRACKED_SID,
  },
  {agent: null, name: 'untracked.jsonl', session: UNTRACKED_SID},
  {
    agent: 'agent-u1.jsonl',
    name: 'untracked.agent-u1.jsonl',
    session: UNTRACKED_SID,
  },
];

export function fixtureText(
  name: string,
  vars: {cwd: string; sha: string},
): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
    .replaceAll('__CWD__', vars.cwd)
    .replaceAll('__SHA__', vars.sha);
}

/** Where Claude Code would keep `file` for a session run in `cwd`. */
export function fixturePath(
  projectsRoot: string,
  cwd: string,
  file: FixtureFile,
): string {
  const dir = join(projectsRoot, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  return file.agent == null
    ? join(dir, `${file.session}.jsonl`)
    : join(dir, file.session, 'subagents', file.agent);
}

/** The golden inputs: fixed paths, so the facts do not depend on a temp dir. */
export const GOLDEN_VARS = {
  cwd: '/fixture/Dev/notes',
  projectsRoot: '/fixture/projects',
  sha: 'abc1234',
};

/** Every cached parser's output for every fixture file, keyed by file name. */
export function goldenFacts(): Record<string, TranscriptFileFacts> {
  const facts: Record<string, TranscriptFileFacts> = {};
  for (const file of FIXTURE_FILES) {
    const text = fixtureText(file.name, GOLDEN_VARS);
    facts[file.name] = transcriptFileFactsOfBytes(
      Buffer.from(text, 'utf8'),
      fixturePath(GOLDEN_VARS.projectsRoot, GOLDEN_VARS.cwd, file),
      true,
    );
  }
  // JSON round trip: the golden file holds exactly what a disk entry would.
  return JSON.parse(JSON.stringify(facts)) as Record<
    string,
    TranscriptFileFacts
  >;
}
