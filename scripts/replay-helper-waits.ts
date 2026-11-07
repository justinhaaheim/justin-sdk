#!/usr/bin/env bun
/**
 * Replay the helper waits of home-base-yd1co.2 against the real transcripts.
 *
 * On 2026-11-06 and 2026-11-07 the mayor's watcher printed `working →
 * stoppedOpen` for three sessions (home-base-ds1z4, bac-197h,
 * screenshot-app-fps) while a helper agent was waiting on its own background
 * shell. The bead's description lists each line, the helper, and the gap. This
 * script asks the new code what it says at each of those times, plus two more
 * probes per gap: 5 minutes into it, and 30 seconds before it ends.
 *
 * READ-ONLY. A transcript cannot be read "as of" a past time, so each probe
 * copies the session's main transcript and every helper transcript, cut at the
 * probe time (every line up to the first record dated after it), into a
 * temporary directory, and reads the copy with the real `readActivity` and
 * `readHelperTail` at that clock. The real transcripts are only opened for
 * reading; the copies are deleted at the end.
 *
 * WHAT IT CANNOT REPLAY. The beads and git state of those sessions at those
 * times are gone. Each status is derived from a fixed baseline of open work
 * (an open request, a commit, not merged), the state that made the watcher say
 * "stopped with open work" then, with the helpers and the last record taken
 * from the cut transcripts. So the table shows what the helper evidence alone
 * changes. "Old" is the verdict before home-base-yd1co.2: a helper whose tail
 * ends in text counts as finished, and a helper older than 15 minutes counts
 * for nothing.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {parseArgs} from 'node:util';
import {homedir, tmpdir} from 'os';
import {join} from 'path';

import {measured, readActivity} from '../src/thread/session-model';
import {
  deriveStatus,
  recentHelpers,
  type StatusFacts,
  WORKING_WINDOW_MS,
} from '../src/thread/session-status';
import {
  forEachTranscriptLine,
  readHelperTail,
  readOpenBackgroundShells,
} from '../src/thread/transcript-messages';

const HELP = `replay-helper-waits: what the inbox says at the helper waits of home-base-yd1co.2.

Usage: bun run replay:helper-waits [--projects <dir>]

  --projects <dir>   Where Claude Code keeps transcripts. Default:
                     ~/.claude/projects.

  --help             Print this and do nothing else.

Read-only: it copies each transcript cut at each probe time into a temporary
directory, reads the copy, and deletes it. Prints a markdown table. Exit 0 when
every probe reads Working or Check by hand, 1 when any reads anything else, 2
when a transcript could not be found or read.
`;

interface Gap {
  /** The helper's file name prefix, `agent-<id>`. */
  helper: string;
  project: string;
  quietFrom: string;
  quietTo: string;
  session: string;
  /** The watcher's `working → stoppedOpen` line. */
  watcherAt: string;
}

const HOME_BASE = '-Users-jhaa-Dev-home-base';
const BAC =
  '-Users-jhaa-Dev-browser-automation-central--claude-worktrees-loop-ready-push';
const SCREENSHOT = '-Users-jhaa-Dev-screenshot-app';
const DS1Z4 = 'a4286b3b-e243-47d0-9cab-75fdf4ae985d';
const BAC_197H = '379377be-631a-4985-b911-67f812399f2c';
const FPS = '7e996997-bee6-4fa2-9ee8-b8c286ef99ba';

/** The bead's table, plus the 00:07:28 line it names below the table. */
const GAPS: Gap[] = [
  {
    helper: 'agent-a3909f4b',
    project: HOME_BASE,
    quietFrom: '2026-11-06T23:51:19Z',
    quietTo: '2026-11-07T00:13:15Z',
    session: DS1Z4,
    watcherAt: '2026-11-07T00:07:28Z',
  },
  {
    helper: 'agent-a3909f4b',
    project: HOME_BASE,
    quietFrom: '2026-11-07T00:14:06Z',
    quietTo: '2026-11-07T00:38:43Z',
    session: DS1Z4,
    watcherAt: '2026-11-07T00:32:21Z',
  },
  {
    helper: 'agent-a3909f4b',
    project: HOME_BASE,
    quietFrom: '2026-11-07T01:22:55Z',
    quietTo: '2026-11-07T01:46:55Z',
    session: DS1Z4,
    watcherAt: '2026-11-07T01:42:01Z',
  },
  {
    helper: 'agent-a643a9a2',
    project: BAC,
    quietFrom: '2026-11-07T00:47:07Z',
    quietTo: '2026-11-07T01:27:11Z',
    session: BAC_197H,
    watcherAt: '2026-11-07T01:02:34Z',
  },
  {
    helper: 'agent-a33fd036',
    project: SCREENSHOT,
    quietFrom: '2026-11-07T03:34:26Z',
    quietTo: '2026-11-07T03:54:49Z',
    session: FPS,
    watcherAt: '2026-11-07T03:52:38Z',
  },
  {
    helper: 'agent-aef62780',
    project: SCREENSHOT,
    quietFrom: '2026-11-07T05:07:36Z',
    quietTo: '2026-11-07T05:24:51Z',
    session: FPS,
    watcherAt: '2026-11-07T05:22:57Z',
  },
  {
    helper: 'agent-a7a67905',
    project: SCREENSHOT,
    quietFrom: '2026-11-07T06:23:48Z',
    quietTo: '2026-11-07T06:43:38Z',
    session: FPS,
    watcherAt: '2026-11-07T06:42:52Z',
  },
];

/** The state the watcher saw as "stopped with open work"; helpers and activity come from the cut. */
const OPEN_WORK: StatusFacts = {
  activityUnmeasured: [],
  beadProblems: [],
  commits: {count: 1, kind: 'counted'},
  contextTokens: null,
  handedOff: false,
  helpersInFlight: [],
  lastMessageRole: 'assistant',
  lastRecordAt: null,
  merged: measured('notMerged'),
  openP0: 0,
  requests: {closed: 0, total: 1},
  sessionCloseReason: null,
  successor: null,
  uncommitted: measured(0),
  wrapUpAt: null,
};

/** Copy `from` to `to`, every line up to the first record dated after `cut`. */
function cutCopy(from: string, to: string, cut: number): void {
  const kept: string[] = [];
  let past = false;
  forEachTranscriptLine(from, (line) => {
    if (past) return;
    try {
      const record = JSON.parse(line) as {timestamp?: unknown};
      if (typeof record.timestamp === 'string') {
        const ms = Date.parse(record.timestamp);
        if (!Number.isNaN(ms) && ms > cut) {
          past = true;
          return;
        }
      }
    } catch {
      // A line that does not parse is kept as it is, as the reader would see it.
    }
    kept.push(line);
  });
  writeFileSync(to, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
}

/** The last user or assistant record of a file, in words. */
function tailWords(path: string): string {
  let words = 'no conversation record';
  forEachTranscriptLine(path, (line) => {
    let record: {message?: {content?: unknown}; type?: unknown};
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return;
    }
    if (record.type !== 'user' && record.type !== 'assistant') return;
    const content = record.message?.content;
    const blocks = Array.isArray(content)
      ? (content as {type?: unknown}[]).map((block) => String(block.type))
      : ['string'];
    if (record.type === 'assistant') {
      words = blocks.includes('tool_use')
        ? 'assistant tool_use'
        : blocks.every((type) => type === 'thinking')
          ? 'assistant thinking'
          : 'assistant text';
    } else {
      words = blocks.includes('tool_result') ? 'user tool_result' : 'user';
    }
  });
  return words;
}

function verdictWords(kind: string): string {
  if (kind === 'working') return 'Working';
  if (kind === 'unknown') return 'Check by hand';
  if (kind === 'openWork') return 'Stopped with open work';
  return kind;
}

function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

interface Probe {
  at: number;
  gap: Gap;
  label: string;
}

function main(): number {
  const {values} = parseArgs({
    options: {
      help: {type: 'boolean'},
      projects: {type: 'string'},
    },
  });
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  const projects = values.projects ?? join(homedir(), '.claude', 'projects');
  const probes: Probe[] = GAPS.flatMap((gap) => [
    {at: Date.parse(gap.quietFrom) + 5 * 60_000, gap, label: 'gap + 5 min'},
    {at: Date.parse(gap.watcherAt), gap, label: 'watcher line'},
    {at: Date.parse(gap.quietTo) - 30_000, gap, label: 'gap end - 30 s'},
  ]);

  const work = mkdtempSync(join(tmpdir(), 'replay-helper-waits-'));
  const rows: string[] = [];
  let bad = 0;
  let unreadable = 0;
  try {
    for (const [index, probe] of probes.entries()) {
      const {gap} = probe;
      const mainPath = join(projects, gap.project, `${gap.session}.jsonl`);
      const subagents = join(projects, gap.project, gap.session, 'subagents');
      let helperFiles: string[];
      try {
        statSync(mainPath);
        helperFiles = readdirSync(subagents).filter(
          (name) => name.startsWith('agent-') && name.endsWith('.jsonl'),
        );
      } catch (error) {
        unreadable += 1;
        rows.push(
          `| ${probe.label} | ${gap.session.slice(0, 8)} | ${gap.helper.slice(6)} | ${hhmmss(probe.at)} | could not read: ${error instanceof Error ? error.message : String(error)} |`,
        );
        continue;
      }
      const dir = join(work, String(index));
      const cutSubagents = join(dir, gap.session, 'subagents');
      mkdirSync(cutSubagents, {recursive: true});
      const cutMain = join(dir, `${gap.session}.jsonl`);
      cutCopy(mainPath, cutMain, probe.at);
      for (const name of helperFiles) {
        cutCopy(join(subagents, name), join(cutSubagents, name), probe.at);
      }
      const now = new Date(probe.at);
      const activity = readActivity(cutMain, {now});
      const facts: StatusFacts = {
        ...OPEN_WORK,
        activityUnmeasured: [
          ...(activity.helpers.ok ? [] : [activity.helpers.reason]),
          ...(activity.lastRecordAt.ok ? [] : [activity.lastRecordAt.reason]),
        ],
        helpersInFlight: activity.helpers.ok
          ? activity.helpers.value.map((helper) => helper.lastRecordAt)
          : null,
        lastRecordAt: activity.lastRecordAt.ok
          ? activity.lastRecordAt.value
          : null,
      };
      const status = deriveStatus(facts, {asIfYielded: false, now});

      // Before home-base-yd1co.2: a far clock skips the open-shell scan, so a
      // text-ended tail reads finished, exactly as the old reader read it.
      const far = new Date(probe.at + 10 * 365 * 24 * 60 * 60_000);
      const oldHelpers = helperFiles
        .map((name) => readHelperTail(join(cutSubagents, name), {now: far}))
        .filter((read) => read.kind === 'found' && read.inFlight)
        .map((read) => (read.kind === 'found' ? read.at : null));
      const ownMs =
        facts.lastRecordAt == null ? null : Date.parse(facts.lastRecordAt);
      const ownRecent =
        ownMs != null &&
        probe.at - ownMs >= 0 &&
        probe.at - ownMs < WORKING_WINDOW_MS;
      const old =
        recentHelpers(oldHelpers, now).length > 0 || ownRecent
          ? 'Working'
          : 'Stopped with open work';

      const helperName = helperFiles.find((name) =>
        name.startsWith(gap.helper),
      );
      let helperWords = 'helper file not found';
      let shells = '?';
      let lastWrote = '?';
      if (helperName != null) {
        const path = join(cutSubagents, helperName);
        const tail = readHelperTail(path, {now});
        const open = readOpenBackgroundShells(path);
        helperWords = tailWords(path);
        shells = open.kind === 'read' ? String(open.open.length) : open.reason;
        if (tail.kind === 'found' && tail.at != null) {
          const ms = Date.parse(tail.at);
          lastWrote = `${hhmmss(ms)} (${Math.round((probe.at - ms) / 60_000)} min)`;
          helperWords += tail.inFlight ? ', in flight' : ', finished';
        }
      }
      const verdict = verdictWords(status.kind);
      if (status.kind !== 'working' && status.kind !== 'unknown') bad += 1;
      rows.push(
        `| ${probe.label} | ${gap.session.slice(0, 8)} | ${gap.helper.slice(6)} | ${hhmmss(probe.at)} | ${lastWrote} | ${helperWords} | ${shells} | ${old} | **${verdict}** |`,
      );
    }
  } finally {
    rmSync(work, {force: true, recursive: true});
  }

  process.stdout.write(
    [
      '| Probe | Session | Helper | Time (UTC) | Helper last wrote (age) | Helper tail | Open shells | Old verdict | New verdict |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
      `${probes.length} probes: ${bad} read something other than Working or Check by hand; ${unreadable} could not be read.`,
      '',
    ].join('\n'),
  );
  if (unreadable > 0) return 2;
  return bad > 0 ? 1 : 0;
}

process.exitCode = main();
