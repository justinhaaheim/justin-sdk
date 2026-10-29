#!/usr/bin/env bun
/**
 * live-handoff: the spend-gated LIVE test of `thread handoff`
 * (home-base-mbnjv.7; epic home-base-mbnjv AC1, AC3, AC4, AC5, AC6, AC7).
 *
 * `bun test` drives thread handoff against a fake cmux and fake readers. This
 * script is the one thing that drives it for real. It starts throwaway haiku
 * Claude Code sessions in throwaway cmux workspaces, has each one run the
 * command, and checks what the product did from the outside: the cmux tree
 * and screens, the session beads, the message logs, the transcripts and the
 * predecessor watcher's log. Every check prints PASS or FAIL with its evidence.
 *
 * NOT part of `bun test`, a hook, a chore or CI: it needs a logged-in claude,
 * cmux, and the Claude Code sandbox OFF (cmux's socket, ~/.local/state).
 *
 * SAFETY (prime directive; the dispatch brief's non-negotiables):
 * - Every cmux call goes through `fenced()`, which refuses any verb outside a
 *   short list, any call that names a workspace this run did not create, and
 *   any surface not seen inside one. The cmux children run WITHOUT the caller's
 *   CMUX_SURFACE_ID / CMUX_WORKSPACE_ID / CMUX_PANEL_ID / CMUX_TAB_ID, so a
 *   flag left off can never fall back to the tab this script runs in.
 * - This script never runs `thread handoff` itself; only the throwaways do.
 * - The kill switch file is machine-wide. S5 creates it only when it is
 *   absent, and removes it in a finally block only when this run created it
 *   and its text is still the text this run wrote.
 * - No key is ever sent into a dialog. A trust or permission dialog stops the
 *   scenario and is quoted.
 * - `--cleanup <stamp>` closes only the workspaces in that run's log, by id,
 *   and refuses one that holds a tab the log never saw. Nothing is selected
 *   by marker or by name.
 * - ~/.claude is never written. The candidate global entries reach the
 *   throwaways only through `claude --settings <file>` (--settings).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {MessageLine} from '../src/thread/message-log';

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';

import {brShow} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {realCmuxRunner} from '../src/thread/cmux';
import {killSwitchPath} from '../src/thread/handoff-gate';
import {
  focusCommandOf,
  PREDECESSOR_SETTLE_MS,
  predecessorLogPath,
  TOMBSTONE_HEADLINE,
  transcriptReaderOf,
} from '../src/thread/handoff-predecessor';
import {
  checkHandoffSandbox,
  HANDOFF_COMMAND,
  HANDOFF_SANDBOX_SETTINGS,
} from '../src/thread/handoff-sandbox';
import {classifySuccessorScreen} from '../src/thread/handoff-successor';
import {readMessageLogAt} from '../src/thread/message-log';
import {
  dialogOnScreen,
  findInputBox,
  screenLines,
  statusLineIdOf,
  vimMode,
  workingIndicator,
} from '../src/thread/pane-join';
import {zshWord} from '../src/thread/respawn';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDOFF_REFUSED_LABEL,
  resolveSession,
} from '../src/thread/session-bead';
import {HANDED_OFF_TAB_PREFIX} from '../src/thread/tab-title';
import {readWorkspaceNames} from '../src/thread/workspace-name';
import {gateSpend} from './spend-gate';

// ---------------------------------------------------------------------------
// Help, arguments
// ---------------------------------------------------------------------------

/** The scenarios a run without --scenario runs, in order. */
const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
/** Scenarios run only when named: M, the note-character measurement (home-base-mbnjv.9). */
const NAMED_ONLY = ['M', 'B', 'C'] as const;
type ScenarioId = (typeof NAMED_ONLY)[number] | (typeof SCENARIOS)[number];

const HELP = `live-handoff: drive throwaway Claude Code sessions through real thread handoffs

Usage: bun run live:handoff [options] --spend-real-tokens
       bun run live:handoff --dry-run [options]
       bun run live:handoff --cleanup <stamp>

Run it from pkg/justin-sdk (or \`bun run --cwd pkg/justin-sdk live:handoff …\`
from the repo root), with the Claude Code sandbox OFF.

Before any scenario it measures whether a Claude Code session started in this
checkout meets the folder-trust dialog (T). A dialog there stops the run: it is
quoted and never answered.

Scenarios (each in its own throwaway cmux workspace, cwd = this checkout):
  S1  keep    The session runs \`thread handoff --note …\`; a new tab in the
              same workspace runs Claude Code on a prose kickoff with nobody
              pressing a key; the successor links in its first turn; the
              workspace name and the old tab's title follow; thread show and
              the inbox card show the chain; the call ran unsandboxed.
  S2  exit    After the handshake the old tab shows the tombstone, never
              before (the times are printed).
  S3  close   The call is BARE (no arguments); after the handshake the old tab
              is gone and the successor's tab stays.
  S4  failed  A user line is typed into the old session after its Stop; the
              watcher gives up, the old session keeps running, and its bead
              says why.
  S5  refused The kill switch is created (only if absent) and removed in a
              finally block; the session is asked to hand off the way its
              rules say, gets exit 3, and stops without another attempt.
  S6  guard   The session runs \`cmux new-surface\`, \`claude --bg\` and
              \`cmux identify\`; the guard denies the first two naming thread
              handoff and lets the third through.

Run only when named (--scenario B, C or M):
  B   wait    exit mode; the session starts a background shell (sleep 100)
              and a background subagent (sleep 60), then hands off while
              both run. The watcher must not act until both have finished
              and the turn after them ended (home-base-mbnjv.13). Saves the
              old tab's idle screen while the work runs.
  C   ids     The session id after /clear and after claude --resume
              (home-base-mbnjv.8 F22): each round runs printenv
              CLAUDE_CODE_SESSION_ID and a thread handoff --dry-run, and the
              harness reads the status-line id and which message log got the
              typed line (the hooks' session_id). Writes C-session-ids.json.
  M   notes   The note-character measurement (home-base-mbnjv.9). One session
              runs \`thread handoff --dry-run --note "<variant>"\` once per
              variant (a plain note as the control, then one character class
              each) and the harness reads each dry run's Gate line from the
              transcript: cmuxUnreachable with "Operation not permitted"
              means that call ran INSIDE the sandbox (the exclusion did not
              apply); any later answer means it reached cmux. A dry run
              writes nothing. Prints the table and writes it to
              note-table.txt in the run dir.

Options:
  --scenario <list>   Comma-separated subset, e.g. S1,S3 (default: S1-S6).
  --settings          Start the throwaways with \`claude --settings <file>\`
                      holding HANDOFF_SANDBOX_SETTINGS (the candidate global
                      entries). Without it they get only ~/.claude/settings.json:
                      AC1 of the epic is met only by a run WITHOUT --settings
                      after Justin has pasted the entries there.
  --marker <uuid>     The TEST_DATA_DELETABLE uuid for every name, title and
                      prompt (default: a fresh uuid; it is printed and logged).
  --model <m>         Model of the throwaway sessions (default: haiku).
  --settings-file <f> Like --settings, with this JSON file's content instead of
                      HANDOFF_SANDBOX_SETTINGS (to measure other entries).
  --variants-file <f> M runs these commands, one per line, instead of the note
                      variants. Each must write nothing (read-only or a dry
                      run). EPERM in its result = it ran inside the sandbox.
  --dry-run           Print every scenario's claude line and prompts, then exit.
                      Creates nothing and spends nothing.
  --cleanup <stamp>   Close the workspaces that run's log names, by id, after
                      printing them; refuse any that holds a tab the log never
                      saw. Removes a kill switch the run left behind only when
                      its text is the run's own. Spends nothing.
  --spend-real-tokens REQUIRED to run scenarios: they start real Claude Code
                      sessions on your account.
  --help              Print this and do nothing else.

Every run writes tmp/live-handoff/<stamp>/ at the repo root: run.jsonl (every
workspace, surface, session, bead, cmux write and check, append-only) and
output.txt (what was printed). Workspaces are left open for inspection; close
them with --cleanup <stamp>. Session beads, message logs, transcripts and the
successors' Remote Control sessions are NOT deleted: their ids are in the log.

Exit: 0 every check passed; 1 a check failed or the run stopped; 2 usage, or
no --spend-real-tokens.
`;

interface Options {
  cleanup: string | null;
  dryRun: boolean;
  marker: string;
  model: string;
  scenarios: ScenarioId[];
  settings: boolean;
  /** --settings-file: this JSON instead of HANDOFF_SANDBOX_SETTINGS (implies --settings). */
  settingsFile: string | null;
  /** --variants-file: M runs these commands (one per line) instead of the note variants. */
  variantsFile: string | null;
}

/** `items` joined, or `none` when there are no items. */
function listOr(
  items: readonly string[],
  separator: string,
  none: string,
): string {
  return items.length === 0 ? none : items.join(separator);
}

function isScenarioId(value: string): value is ScenarioId {
  return [...SCENARIOS, ...NAMED_ONLY].some((id) => id === value);
}

function usageExit(message: string): never {
  process.stderr.write(`${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options | null {
  const opts: Options = {
    cleanup: null,
    dryRun: false,
    marker: randomUUID(),
    model: 'haiku',
    scenarios: [...SCENARIOS],
    settings: false,
    settingsFile: null,
    variantsFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--settings') opts.settings = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--marker') opts.marker = argv[++i] ?? '';
    else if (arg === '--model') opts.model = argv[++i] ?? '';
    else if (arg === '--cleanup') opts.cleanup = argv[++i] ?? '';
    else if (arg === '--settings-file') {
      opts.settingsFile = argv[++i] ?? '';
      opts.settings = true;
    } else if (arg === '--variants-file') opts.variantsFile = argv[++i] ?? '';
    else if (arg === '--scenario') {
      const list = (argv[++i] ?? '').split(',').map((s) => s.trim());
      const bad = list.filter((s) => !isScenarioId(s));
      if (bad.length > 0 || list.length === 0) {
        usageExit(`unknown scenario: ${listOr(bad, ', ', '(none)')}`);
      }
      opts.scenarios = list.filter(isScenarioId);
    } else usageExit(`unknown argument: ${arg}`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      opts.marker,
    )
  ) {
    usageExit(`--marker must be a lowercase uuid, got "${opts.marker}"`);
  }
  if (opts.model === '') usageExit('--model needs a value');
  if (opts.cleanup === '') usageExit('--cleanup needs a run stamp');
  return opts;
}

// ---------------------------------------------------------------------------
// Paths, the run log, output
// ---------------------------------------------------------------------------

/** pkg/justin-sdk/scripts -> the checkout this script lives in. */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const RUNS_DIR = join(REPO_ROOT, 'tmp', 'live-handoff');

/** Claude Code's project folder name: every non-alphanumeric becomes "-". */
function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/gu, '-');
}

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const TRANSCRIPT_DIR = join(CLAUDE_DIR, 'projects', projectSlug(REPO_ROOT));

function transcriptPath(sessionId: string): string {
  return join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
}

function stampNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
}

interface RunLog {
  dir: string;
  logPath: string;
  outputPath: string;
}

let currentRun: RunLog | null = null;

function logEvent(event: string, data: Record<string, unknown> = {}): void {
  if (currentRun == null) return;
  const line = JSON.stringify({at: new Date().toISOString(), event, ...data});
  appendFileSync(currentRun.logPath, `${line}\n`);
}

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
  if (currentRun != null) appendFileSync(currentRun.outputPath, `${line}\n`);
}

/** Indent every line of a quoted block. */
function quote(text: string, indent = '        │ '): string {
  return text
    .split('\n')
    .map((line) => `${indent}${line.replace(/\s+$/u, '')}`)
    .join('\n');
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.slice(-count).join('\n');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Check {
  evidence: string;
  name: string;
  pass: boolean;
  scenario: string;
}

const allChecks: Check[] = [];

function check(
  scenario: string,
  name: string,
  pass: boolean,
  evidence: string,
): boolean {
  const entry = {evidence, name, pass, scenario};
  allChecks.push(entry);
  logEvent('check', entry);
  say(`  ${pass ? 'PASS' : 'FAIL'}  ${scenario}  ${name}`);
  if (evidence.trim() !== '') say(quote(evidence));
  return pass;
}

function info(scenario: string, text: string): void {
  logEvent('info', {scenario, text});
  say(`  info  ${scenario}  ${text.split('\n')[0] ?? ''}`);
  const rest = text.split('\n').slice(1).join('\n');
  if (rest.trim() !== '') say(quote(rest));
}

// ---------------------------------------------------------------------------
// Waiting on observable state (never a bare fixed sleep)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

type Waited<T> =
  | {at: Date; kind: 'ok'; value: T; waitedMs: number}
  | {kind: 'timeout'; waitedMs: number};

async function waitFor<T>(
  timeoutMs: number,
  pollMs: number,
  probe: () => Promise<T | null> | T | null,
): Promise<Waited<T>> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value != null) {
      return {at: new Date(), kind: 'ok', value, waitedMs: Date.now() - start};
    }
    if (Date.now() - start >= timeoutMs) {
      return {kind: 'timeout', waitedMs: Date.now() - start};
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// cmux, fenced
// ---------------------------------------------------------------------------

/** The caller's own tab and workspace: never handed to a cmux child. */
const CALLER_CMUX_IDS = [
  'CMUX_PANEL_ID',
  'CMUX_SURFACE_ID',
  'CMUX_TAB_ID',
  'CMUX_TERMINAL_LIFECYCLE_ID',
  'CMUX_WORKSPACE_ID',
] as const;

function strippedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {...process.env};
  for (const key of CALLER_CMUX_IDS) delete env[key];
  return env;
}

const cmuxRun = realCmuxRunner(8000, strippedEnv());

/** Upper-cased ids (and refs) of what this run created or saw. */
const fence = {
  /** workspace id (upper) -> surface ids (upper) seen inside it. */
  surfaces: new Map<string, Set<string>>(),
  /** workspace ids and refs (upper) this run created. */
  workspaces: new Set<string>(),
};

const READ_VERBS = new Set(['read-screen', 'tree']);
const WRITE_VERBS = new Set([
  'close-workspace',
  'new-workspace',
  'send',
  'send-key',
]);

function verbOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--json') continue;
    if (arg === '--id-format') {
      i += 1;
      continue;
    }
    return arg;
  }
  return '';
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

class FenceRefusal extends Error {}

/** Every cmux call this script makes. Refuses anything outside the fence. */
async function fenced(args: string[], marker: string): Promise<CmuxCall> {
  const verb = verbOf(args);
  if (!READ_VERBS.has(verb) && !WRITE_VERBS.has(verb)) {
    throw new FenceRefusal(`cmux ${verb}: not a verb this script may run`);
  }
  if (verb === 'new-workspace') {
    const name = flagValue(args, '--name') ?? '';
    if (!name.includes(marker) || flagValue(args, '--focus') !== 'false') {
      throw new FenceRefusal(
        'new-workspace must carry the marker in --name and --focus false',
      );
    }
  } else {
    const workspace = (flagValue(args, '--workspace') ?? '').toUpperCase();
    if (workspace === '' || !fence.workspaces.has(workspace)) {
      throw new FenceRefusal(
        `cmux ${verb} names workspace "${workspace}", which this run did not create`,
      );
    }
    if (verb === 'read-screen' || verb === 'send' || verb === 'send-key') {
      const surface = (flagValue(args, '--surface') ?? '').toUpperCase();
      if (
        surface === '' ||
        !(fence.surfaces.get(workspace)?.has(surface) ?? false)
      ) {
        throw new FenceRefusal(
          `cmux ${verb} names surface "${surface}", not seen inside ${workspace}`,
        );
      }
    }
  }
  const call = await cmuxRun(args);
  if (WRITE_VERBS.has(verb)) {
    logEvent('cmux-write', {
      args,
      result: call.kind === 'ok' ? call.stdout.trim() : call.reason,
    });
  }
  return call;
}

// ---- the tree of one workspace ----

const surfaceSchema = z
  .object({
    id: z.string(),
    ref: z.string().nullish(),
    title: z.string().nullish(),
  })
  .passthrough();
const treeSchema = z
  .object({
    windows: z.array(
      z
        .object({
          workspaces: z.array(
            z
              .object({
                id: z.string(),
                panes: z.array(
                  z.object({surfaces: z.array(surfaceSchema)}).passthrough(),
                ),
                ref: z.string().nullish(),
                title: z.string().nullish(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface SurfaceView {
  id: string;
  ref: string | null;
  title: string | null;
}

interface WorkspaceView {
  id: string;
  ref: string | null;
  surfaces: SurfaceView[];
  title: string | null;
}

type WorkspaceRead =
  | {kind: 'gone'; reason: string}
  | {kind: 'read'; view: WorkspaceView}
  | {kind: 'unreadable'; reason: string};

async function readWorkspace(
  workspace: string,
  marker: string,
): Promise<WorkspaceRead> {
  const args = [
    '--json',
    '--id-format',
    'both',
    'tree',
    '--workspace',
    workspace,
  ];
  const call = await fenced(args, marker);
  if (call.kind === 'failed') {
    return call.reason.includes('not_found')
      ? {kind: 'gone', reason: call.reason}
      : {kind: 'unreadable', reason: call.reason};
  }
  let json: unknown;
  try {
    json = JSON.parse(call.stdout);
  } catch {
    return {
      kind: 'unreadable',
      reason: 'cmux tree printed something that is not JSON',
    };
  }
  const parsed = treeSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      reason: `cmux tree JSON: ${parsed.error.issues[0]?.message ?? '?'}`,
    };
  }
  const want = workspace.toUpperCase();
  const found = parsed.data.windows
    .flatMap((window) => window.workspaces)
    .find(
      (entry) =>
        entry.id.toUpperCase() === want ||
        (entry.ref ?? '').toUpperCase() === want,
    );
  if (found == null) return {kind: 'gone', reason: `tree has no ${workspace}`};
  const view: WorkspaceView = {
    id: found.id,
    ref: found.ref ?? null,
    surfaces: found.panes.flatMap((pane) =>
      pane.surfaces.map((surface) => ({
        id: surface.id,
        ref: surface.ref ?? null,
        title: surface.title ?? null,
      })),
    ),
    title: found.title ?? null,
  };
  // Every surface seen in a workspace this run created joins the fence and
  // the log, so --cleanup can tell a tab it knows from one it never saw.
  const key = view.id.toUpperCase();
  const known = fence.surfaces.get(key) ?? new Set<string>();
  fence.surfaces.set(key, known);
  for (const surface of view.surfaces) {
    if (!known.has(surface.id.toUpperCase())) {
      known.add(surface.id.toUpperCase());
      logEvent('surface-seen', {
        ref: surface.ref,
        surfaceId: surface.id,
        title: surface.title,
        workspaceId: view.id,
      });
    }
  }
  return {kind: 'read', view};
}

async function readScreen(
  workspace: string,
  surface: string,
  marker: string,
): Promise<
  {kind: 'read'; text: string} | {kind: 'unreadable'; reason: string}
> {
  const call = await fenced(
    ['read-screen', '--workspace', workspace, '--surface', surface],
    marker,
  );
  return call.kind === 'ok'
    ? {kind: 'read', text: call.stdout}
    : {kind: 'unreadable', reason: call.reason};
}

interface CreatedWorkspace {
  ref: string;
  surfaceId: string;
  workspaceId: string;
}

async function createWorkspace(
  name: string,
  command: string,
  marker: string,
  scenario: string,
): Promise<CreatedWorkspace | {reason: string}> {
  const call = await fenced(
    [
      'new-workspace',
      '--name',
      name,
      '--cwd',
      REPO_ROOT,
      '--command',
      command,
      '--focus',
      'false',
    ],
    marker,
  );
  if (call.kind === 'failed') return {reason: call.reason};
  const ref = /workspace:\d+/u.exec(call.stdout)?.[0] ?? null;
  if (ref == null)
    return {
      reason: `new-workspace printed ${JSON.stringify(call.stdout.trim())}`,
    };
  fence.workspaces.add(ref.toUpperCase());
  logEvent('workspace-created', {name, ref, scenario, workspaceId: null});
  const read = await waitFor(10_000, 300, async () => {
    const tree = await readWorkspace(ref, marker);
    return tree.kind === 'read' && tree.view.surfaces.length > 0
      ? tree.view
      : null;
  });
  if (read.kind !== 'ok') {
    return {
      reason: `the tree never showed ${ref} with a tab (its id is NOT known; close it by hand: ref ${ref})`,
    };
  }
  const view = read.value;
  fence.workspaces.add(view.id.toUpperCase());
  const surface = view.surfaces[0];
  if (surface == null || view.surfaces.length !== 1) {
    return {reason: `${ref} holds ${view.surfaces.length} tabs, expected 1`};
  }
  logEvent('workspace-created', {
    name,
    ref,
    scenario,
    surfaceId: surface.id,
    workspaceId: view.id,
  });
  return {ref, surfaceId: surface.id, workspaceId: view.id};
}

// ---------------------------------------------------------------------------
// Transcripts, message logs, beads, the watcher's log
// ---------------------------------------------------------------------------

interface ToolCall {
  at: string | null;
  command: string;
  disableSandbox: boolean;
  id: string;
  name: string;
  result: {at: string | null; isError: boolean; text: string} | null;
}

const recordSchema = z
  .object({
    message: z
      .object({content: z.union([z.string(), z.array(z.unknown())])})
      .passthrough()
      .nullish(),
    timestamp: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

type TranscriptRecord = z.infer<typeof recordSchema>;

function readTranscript(path: string): TranscriptRecord[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const records: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A partial last line while Claude Code is writing: read it next poll.
    }
  }
  return records;
}

const blockSchema = z
  .object({
    content: z.unknown().optional(),
    id: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    is_error: z.boolean().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    tool_use_id: z.string().optional(),
    type: z.string(),
  })
  .passthrough();

function blocksOf(record: TranscriptRecord): z.infer<typeof blockSchema>[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const parsed = blockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const parsed = blockSchema.safeParse(part);
        return parsed.success ? (parsed.data.text ?? '') : '';
      })
      .join('\n');
  }
  return '';
}

/** Every tool call in order, with its result when one has arrived. */
function toolCalls(records: readonly TranscriptRecord[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const record of records) {
    for (const block of blocksOf(record)) {
      if (block.type === 'tool_use' && block.id != null) {
        const input = block.input ?? {};
        const command = typeof input.command === 'string' ? input.command : '';
        const call: ToolCall = {
          at: record.timestamp ?? null,
          command,
          disableSandbox: input.dangerouslyDisableSandbox === true,
          id: block.id,
          name: block.name ?? '',
          result: null,
        };
        calls.push(call);
        byId.set(block.id, call);
      }
      if (block.type === 'tool_result' && block.tool_use_id != null) {
        const call = byId.get(block.tool_use_id);
        if (call != null) {
          call.result = {
            at: record.timestamp ?? null,
            isError: block.is_error === true,
            text: textOf(block.content),
          };
        }
      }
    }
  }
  return calls;
}

/** The text of the session's first prompt (a user record that is no tool result). */
function firstPrompt(records: readonly TranscriptRecord[]): string | null {
  for (const record of records) {
    if (record.type !== 'user') continue;
    const content = record.message?.content;
    if (typeof content === 'string') return content;
    const blocks = blocksOf(record);
    if (blocks.some((block) => block.type === 'tool_result')) continue;
    const text = blocks.map((block) => block.text ?? '').join('\n');
    if (text.trim() !== '') return text;
  }
  return null;
}

/** Transcript records that mention a hook, as short evidence lines. */
function hookRecordsAfter(
  records: readonly TranscriptRecord[],
  afterIso: string,
): string[] {
  return records
    .filter((record) => (record.timestamp ?? '') >= afterIso)
    .map((record) => JSON.stringify(record))
    .filter((text) => /PreToolUse|hook_blocking|hook_non_blocking/u.test(text))
    .map((text) => text.slice(0, 600));
}

function messageLines(sessionId: string): MessageLine[] {
  const read = readMessageLogAt(messageLogPath(sessionId));
  return read.kind === 'read' ? read.lines : [];
}

/**
 * A turn of `sessionId` that ended at or after `iso`, read from the signals
 * the predecessor watcher reads (home-base-mbnjv.11 AC3): the transcript's
 * turn_duration at or after it, and an assistant line at or after it in the
 * message log in ANY writer's spelling (the capture rewrite turns a live Stop
 * line into a backfill line, so `event === 'Stop'` never matched in run
 * 20261029T162445Z). Returns that assistant line, or null.
 */
function stopAtOrAfter(sessionId: string, iso: string): MessageLine | null {
  const said = messageLines(sessionId).filter(
    (line) => line.role === 'assistant' && (line.at ?? '') >= iso,
  );
  const line = said.at(-1);
  if (line == null) return null;
  const transcript = transcriptReaderOf(sessionId, process.env)();
  if (transcript.kind !== 'read') return null;
  const ended = transcript.marks.some(
    (mark) => mark.kind === 'turnEnd' && (mark.at ?? '') >= iso,
  );
  return ended ? line : null;
}

interface BeadView {
  db: string;
  id: string;
  labels: string[];
  notes: string;
  title: string;
}

function sessionBead(sessionId: string): BeadView | null {
  const found = resolveSession({env: process.env, sessionId});
  if (found.kind !== 'found') return null;
  return {
    db: found.db,
    id: found.bead.id,
    labels: found.bead.labels,
    notes: found.bead.notes ?? '',
    title: found.bead.title,
  };
}

function beadById(db: string, id: string): BeadView | null {
  const shown = brShow({db, env: process.env}, id);
  if (shown.kind !== 'ok') return null;
  return {
    db,
    id,
    labels: shown.issue.labels,
    notes: shown.issue.notes ?? '',
    title: shown.issue.title,
  };
}

function labelTarget(labels: readonly string[], prefix: string): string | null {
  const label = labels.find((entry) => entry.startsWith(prefix));
  return label == null ? null : label.slice(prefix.length);
}

const predecessorLineSchema = z
  .object({
    at: z.string(),
    detail: z.string().nullish(),
    event: z.string(),
    sessionId: z.string(),
  })
  .passthrough();

function predecessorEvents(
  sessionId: string,
): {at: string; detail: string; event: string}[] {
  let text: string;
  try {
    text = readFileSync(predecessorLogPath(process.env), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.trim() === '') return [];
      try {
        const parsed = predecessorLineSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => ({
      at: entry.at,
      detail: entry.detail ?? '',
      event: entry.event,
    }));
}

/** `bun run justin-sdk …` in this checkout, with nothing of the caller's session. */
function sdk(
  args: string[],
  timeoutMs: number,
): {status: number | null; stderr: string; stdout: string} {
  const env = strippedEnv();
  delete env.CLAUDE_CODE_SESSION_ID;
  env.JUSTIN_SDK_HEALTH_NOTICES = 'off';
  env.NO_COLOR = '1';
  const run = spawnSync('bun', ['run', 'justin-sdk', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: run.status,
    stderr: run.stderr ?? '',
    stdout: run.stdout ?? '',
  };
}

/**
 * home-base-mbnjv.14: hand the guard one Bash call the way Claude Code does,
 * through this checkout's dispatcher entry (`bun run --cwd <root> justin-sdk
 * hook PreToolUse`, the spelling in .claude/settings.json) with a PreToolUse
 * payload carrying the throwaway session's real id. The hook only classifies:
 * the command itself is never run, whatever the verdict.
 */
function driveGuard(
  sessionId: string,
  command: string,
): {status: number | null; stderr: string} {
  const env = strippedEnv();
  delete env.CLAUDE_CODE_SESSION_ID;
  env.CLAUDE_PROJECT_DIR = REPO_ROOT;
  env.JUSTIN_SDK_HEALTH_NOTICES = 'off';
  env.NO_COLOR = '1';
  const payload = {
    cwd: REPO_ROOT,
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    session_id: sessionId,
    tool_input: {command, description: 'live-handoff S6 guard probe'},
    tool_name: 'Bash',
    transcript_path: transcriptPath(sessionId),
  };
  const run = spawnSync(
    'bun',
    ['run', '--cwd', REPO_ROOT, 'justin-sdk', 'hook', 'PreToolUse'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      input: JSON.stringify(payload),
      timeout: 60_000,
    },
  );
  return {status: run.status, stderr: run.stderr ?? ''};
}

// ---------------------------------------------------------------------------
// The throwaway sessions
// ---------------------------------------------------------------------------

type Predecessor = 'close' | 'exit' | 'keep';

interface Ctx {
  marker: string;
  markerTag: string;
  model: string;
  runDir: string;
  settingsPath: string | null;
  stamp: string;
  variantsFile: string | null;
}

interface Throwaway {
  name: string;
  ref: string;
  scenario: ScenarioId;
  sessionId: string;
  surfaceId: string;
  workspaceId: string;
}

function claudeLine(input: {
  model: string;
  name: string;
  prompt: string | null;
  sessionId: string;
  settingsPath: string | null;
  xdg: string | null;
}): string {
  const words = [
    'claude',
    '--model',
    input.model,
    '--permission-mode',
    'auto',
    '--session-id',
    input.sessionId,
    '--name',
    input.name,
    ...(input.settingsPath == null ? [] : ['--settings', input.settingsPath]),
    ...(input.prompt == null ? [] : [input.prompt]),
  ];
  const prefix =
    input.xdg == null ? '' : `XDG_CONFIG_HOME=${zshWord(input.xdg)} `;
  return prefix + words.map(zshWord).join(' ');
}

function deepMerge(base: unknown, over: unknown): unknown {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value != null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = {...base};
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * A user layer that selects the predecessor mode WITHOUT editing committed
 * config: a copy of $XDG_CONFIG_HOME made of symlinks (git, mise and every
 * other tool still read their real config), whose justin-sdk/config.json is
 * the real one plus `thread.handoff.predecessor`. Only the throwaway's claude
 * gets it (an env prefix on its command line); the successor, which cmux
 * starts in a fresh shell, reads the real user config.
 */
function writeUserLayer(
  ctx: Ctx,
  scenario: ScenarioId,
  mode: Predecessor,
): string {
  const real = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const dir = join(ctx.runDir, `xdg-${scenario}`);
  mkdirSync(dir, {recursive: true});
  for (const entry of readdirSync(real)) {
    if (entry !== 'justin-sdk')
      symlinkSync(join(real, entry), join(dir, entry));
  }
  const sdkDir = join(dir, 'justin-sdk');
  mkdirSync(sdkDir, {recursive: true});
  const realSdk = join(real, 'justin-sdk');
  let base: unknown = {};
  if (existsSync(realSdk)) {
    for (const entry of readdirSync(realSdk)) {
      if (entry !== 'config.json')
        symlinkSync(join(realSdk, entry), join(sdkDir, entry));
    }
    const configPath = join(realSdk, 'config.json');
    if (existsSync(configPath)) {
      // A config that cannot be parsed stops the run rather than being
      // replaced by an empty one (critical rule 7).
      base = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    }
  }
  const merged = deepMerge(base, {
    componentConfig: {thread: {handoff: {predecessor: mode}}},
  });
  writeFileSync(
    join(sdkDir, 'config.json'),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
  logEvent('user-layer', {dir, mode, scenario});
  return dir;
}

function readyPrompt(ctx: Ctx, scenario: string): string {
  return `${ctx.markerTag} This Claude Code session is a throwaway started by the live test of thread handoff (run ${ctx.stamp}, scenario ${scenario}). Reply with the single word ready. Run no tools.`;
}

function sessionTitle(ctx: Ctx, scenario: string, mode: string): string {
  return `${ctx.markerTag} lh ${scenario} ${mode}`;
}

/**
 * The note a throwaway passes to thread handoff. The marker goes WITHOUT its
 * brackets and the note has no `:` or `;` (home-base-mbnjv.9 design 5, kept by
 * home-base-mbnjv.10). M measures each character on the by-path call; names,
 * titles and prompts keep the full bracketed marker.
 */
function successorNote(ctx: Ctx, scenario: string): string {
  return `TEST_DATA_DELETABLE ${ctx.marker} live test ${scenario}, the successor replies with the single word linked and ends its turn, it runs no other command and changes no file`;
}

const HANDS_OFF =
  'Do not run git, do not commit, do not edit or create any file, and run no command other than the ones named here.';

function explicitHandoffPrompt(
  ctx: Ctx,
  scenario: string,
  title: string,
): string {
  return `${ctx.markerTag} Live test ${scenario}. Step 1: run this Bash command exactly as written, as its own call: \`bun run justin-sdk thread title "${title}"\`. Step 2: run this Bash command exactly as written, as its own call, bare, with nothing before or after it: \`${HANDOFF_COMMAND} --note "${successorNote(ctx, scenario)}"\`. Step 3: write a one-line final report and end your turn. ${HANDS_OFF}`;
}

function bareHandoffPrompt(ctx: Ctx): string {
  const request = `${ctx.markerTag} lh S3 close: the successor replies with the single word linked and ends its turn; it runs no other command and changes no file`;
  return `${ctx.markerTag} Live test S3. Step 1: run this Bash command exactly as written, as its own call: \`bun run justin-sdk thread request "${request}"\`. Step 2: run this Bash command exactly as written, as its own call, with NO arguments at all and nothing before or after it: \`${HANDOFF_COMMAND}\`. Step 3: write a one-line final report and end your turn. ${HANDS_OFF}`;
}

function ruleHandoffPrompt(ctx: Ctx): string {
  return `${ctx.markerTag} Live test S5 of the handoff rules. Treat your context as nearly full: hand this session off to a fresh session now, exactly the way your rules say to, with this one-line note for the successor: ${successorNote(ctx, 'S5')}. Then do what the command's output tells you. Do not run git and do not edit or create any file.`;
}

/** S6's three commands, the same in the prompt and when driven directly. */
function guardProbeCommands(ctx: Ctx): {
  bg: string;
  identify: string;
  surface: string;
} {
  return {
    bg: `claude --bg --model haiku 'guard probe ${ctx.markerTag}: reply ready'`,
    identify: 'cmux identify',
    surface: `cmux new-surface --command 'echo ${ctx.markerTag} guard probe'`,
  };
}

function guardPrompt(ctx: Ctx): string {
  const probes = guardProbeCommands(ctx);
  return `${ctx.markerTag} Live test S6 of a PreToolUse guard that must refuse commands which start or drive other sessions. Your rules forbid these commands; this test needs each one attempted exactly once so that the guard's answer is recorded. Run each of these three Bash commands exactly as written, each as its own call, in this order: 1) \`${probes.surface}\` 2) \`${probes.bg}\` 3) \`${probes.identify}\`. Do not retry, rephrase or work around any refusal or error, and never set dangerouslyDisableSandbox. Then reply with one line per command saying whether it was refused and what the refusal said, and end your turn. ${HANDS_OFF}`;
}

function userLine(ctx: Ctx): string {
  return `${ctx.markerTag} Live test S4: this line was typed by the test harness to make the handshake fail. Reply with the single word noted and run no tools.`;
}

/** Start one throwaway: its workspace, Claude Code up, its first turn done, its bead filed. */
async function startThrowaway(
  ctx: Ctx,
  scenario: ScenarioId,
  mode: Predecessor | 'guard' | 'measure' | 'refused',
): Promise<Throwaway | null> {
  const sessionId = randomUUID();
  const name = sessionTitle(ctx, scenario, mode);
  const xdg =
    mode === 'exit' || mode === 'close'
      ? writeUserLayer(ctx, scenario, mode)
      : null;
  const line = claudeLine({
    model: ctx.model,
    name,
    prompt: readyPrompt(ctx, scenario),
    sessionId,
    settingsPath: ctx.settingsPath,
    xdg,
  });
  const created = await createWorkspace(
    `${ctx.markerTag} live-handoff ${ctx.stamp} ${scenario}`,
    line,
    ctx.marker,
    scenario,
  );
  if ('reason' in created) {
    check(scenario, 'the throwaway workspace opens', false, created.reason);
    return null;
  }
  const throwaway: Throwaway = {name, scenario, sessionId, ...created};
  logEvent('session-started', {
    command: line,
    role: 'caller',
    scenario,
    sessionId,
    surfaceId: created.surfaceId,
    transcript: transcriptPath(sessionId),
    workspaceId: created.workspaceId,
  });
  info(
    scenario,
    `workspace ${created.workspaceId} (${created.ref}), tab ${created.surfaceId}, session ${sessionId}\ntranscript ${transcriptPath(sessionId)}`,
  );
  const up = await waitFor(60_000, 500, async () => {
    const screen = await readScreen(
      created.workspaceId,
      created.surfaceId,
      ctx.marker,
    );
    if (screen.kind !== 'read') return null;
    const verdict = classifySuccessorScreen(screen.text);
    if (verdict.kind === 'dialog')
      return {dialog: verdict.label, text: screen.text};
    if (statusLineIdOf(screen.text) === sessionId)
      return {dialog: null, text: screen.text};
    return null;
  });
  if (up.kind !== 'ok') {
    check(
      scenario,
      'Claude Code starts in the throwaway tab',
      false,
      `no Claude Code input box with ⌗ ${sessionId} within 60 s`,
    );
    return null;
  }
  if (up.value.dialog != null) {
    check(
      scenario,
      'Claude Code starts with no dialog (never answered)',
      false,
      `${up.value.dialog}:\n${lastLines(up.value.text, 30)}`,
    );
    return null;
  }
  const turn = await waitFor(240_000, 1000, () => {
    const stopped = stopAtOrAfter(sessionId, '') != null;
    const bead = stopped ? sessionBead(sessionId) : null;
    return bead;
  });
  if (turn.kind !== 'ok') {
    check(
      scenario,
      'the first turn ends and the session bead is filed',
      false,
      `after ${Math.round(turn.waitedMs / 1000)} s: an ended turn (an assistant line in ${messageLogPath(sessionId)} and a transcript turn_duration) is ${stopAtOrAfter(sessionId, '') == null ? 'absent' : 'present'}; session bead ${sessionBead(sessionId)?.id ?? 'not found'}`,
    );
    return null;
  }
  logEvent('bead', {
    beadId: turn.value.id,
    role: 'caller',
    scenario,
    sessionId,
  });
  info(
    scenario,
    `session bead ${turn.value.id} filed; first turn done after ${Math.round(turn.waitedMs / 1000)} s`,
  );
  return throwaway;
}

/**
 * Type one line into a throwaway's input box and submit it, only when its
 * screen shows that session's own empty input box: no dialog, not working.
 */
async function typeLine(
  ctx: Ctx,
  t: Throwaway,
  text: string,
): Promise<string | null> {
  const ready = await waitFor(60_000, 500, async () => {
    const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
    if (screen.kind !== 'read') return null;
    const lines = screenLines(screen.text);
    const dialog = dialogOnScreen(lines);
    if (dialog != null)
      return {problem: `a dialog is on screen (${dialog}); nothing was typed`};
    const box = findInputBox(lines);
    if (box == null || workingIndicator(lines) != null) return null;
    if (statusLineIdOf(screen.text) !== t.sessionId) return null;
    if (box.draft !== '' && !box.suggested) {
      return {problem: `the input box already holds text: ${box.draft}`};
    }
    return {mode: vimMode(lines, box), problem: null};
  });
  if (ready.kind !== 'ok')
    return 'the tab never showed its own idle, empty input box within 60 s';
  if (ready.value.problem != null) return ready.value.problem;
  if (ready.value.mode === 'normal') {
    await fenced(
      [
        'send-key',
        '--workspace',
        t.workspaceId,
        '--surface',
        t.surfaceId,
        '--',
        'i',
      ],
      ctx.marker,
    );
  }
  const sent = await fenced(
    [
      'send',
      '--workspace',
      t.workspaceId,
      '--surface',
      t.surfaceId,
      '--',
      text,
    ],
    ctx.marker,
  );
  if (sent.kind === 'failed') return sent.reason;
  const typed = await waitFor(10_000, 300, async () => {
    const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
    if (screen.kind !== 'read') return null;
    const box = findInputBox(screenLines(screen.text));
    return box != null && box.draft !== '' ? true : null;
  });
  if (typed.kind !== 'ok')
    return 'the typed text never showed in the input box';
  const entered = await fenced(
    [
      'send-key',
      '--workspace',
      t.workspaceId,
      '--surface',
      t.surfaceId,
      '--',
      'enter',
    ],
    ctx.marker,
  );
  if (entered.kind === 'failed') return entered.reason;
  logEvent('typed', {
    scenario: t.scenario,
    sessionId: t.sessionId,
    surfaceId: t.surfaceId,
    text,
  });
  return null;
}

/** The first Bash call running `thread handoff` after `sinceIso`, once it has a result. */
async function waitForHandoffCall(
  t: Throwaway,
  sinceIso: string,
  timeoutMs: number,
): Promise<ToolCall | null> {
  const found = await waitFor(timeoutMs, 1000, () => {
    const records = readTranscript(transcriptPath(t.sessionId));
    if (records == null) return null;
    const call = toolCalls(records).find(
      (entry) =>
        entry.name === 'Bash' &&
        entry.command.includes('thread handoff') &&
        (entry.at ?? '') >= sinceIso,
    );
    return call?.result != null ? call : null;
  });
  return found.kind === 'ok' ? found.value : null;
}

/** Every tool call in a transcript after a given call's result. */
function callsAfter(sessionId: string, call: ToolCall): ToolCall[] {
  const records = readTranscript(transcriptPath(sessionId)) ?? [];
  const all = toolCalls(records);
  const index = all.findIndex((entry) => entry.id === call.id);
  return index < 0 ? [] : all.slice(index + 1);
}

function describeCall(call: ToolCall): string {
  const result = call.result;
  return [
    `command: ${call.command}`,
    `dangerouslyDisableSandbox: ${call.disableSandbox}`,
    `called at ${call.at ?? '?'}, result at ${result?.at ?? '?'}, is_error ${result?.isError ?? '?'}`,
    'result (last lines):',
    lastLines(result?.text ?? '(none)', 14),
  ].join('\n');
}

/** The call as the rule spells it (SDK_HANDOFF_CALL), with or without arguments. */
function isBareHandoff(command: string): boolean {
  return (
    command === HANDOFF_COMMAND || command.startsWith(`${HANDOFF_COMMAND} `)
  );
}

/** The successor tab: a second tab in the workspace whose status line shows another session. */
async function waitForSuccessorTab(
  ctx: Ctx,
  t: Throwaway,
  timeoutMs: number,
): Promise<{
  dialog: string | null;
  screen: string;
  sessionId: string | null;
  surfaceId: string;
} | null> {
  const found = await waitFor(timeoutMs, 1000, async () => {
    const tree = await readWorkspace(t.workspaceId, ctx.marker);
    if (tree.kind !== 'read') return null;
    const other = tree.view.surfaces.find(
      (surface) => surface.id.toUpperCase() !== t.surfaceId.toUpperCase(),
    );
    if (other == null) return null;
    const screen = await readScreen(t.workspaceId, other.id, ctx.marker);
    if (screen.kind !== 'read') return null;
    const dialog = dialogOnScreen(screenLines(screen.text));
    if (dialog != null) {
      return {
        dialog,
        screen: screen.text,
        sessionId: null,
        surfaceId: other.id,
      };
    }
    const id = statusLineIdOf(screen.text);
    return id != null && id !== t.sessionId
      ? {dialog: null, screen: screen.text, sessionId: id, surfaceId: other.id}
      : null;
  });
  if (found.kind !== 'ok') return null;
  logEvent('session-started', {
    role: 'successor',
    scenario: t.scenario,
    sessionId: found.value.sessionId,
    surfaceId: found.value.surfaceId,
    transcript:
      found.value.sessionId == null
        ? null
        : transcriptPath(found.value.sessionId),
    workspaceId: t.workspaceId,
  });
  return found.value;
}

interface Link {
  caller: BeadView;
  successor: BeadView;
}

async function waitForLink(
  t: Throwaway,
  timeoutMs: number,
): Promise<Link | null> {
  const found = await waitFor(timeoutMs, 2000, () => {
    const caller = sessionBead(t.sessionId);
    if (caller == null) return null;
    const next = labelTarget(caller.labels, CONTINUED_BY_LABEL_PREFIX);
    if (next == null) return null;
    const successor = beadById(caller.db, next);
    return successor == null ? null : {caller, successor};
  });
  if (found.kind !== 'ok') return null;
  logEvent('bead', {
    beadId: found.value.successor.id,
    role: 'successor',
    scenario: t.scenario,
  });
  return found.value;
}

/** The successor's `thread request --continues` call, from its transcript. */
function linkCall(successorSessionId: string): ToolCall | null {
  const records = readTranscript(transcriptPath(successorSessionId)) ?? [];
  return (
    toolCalls(records).find(
      (entry) =>
        entry.name === 'Bash' &&
        entry.command.includes('thread request --continues'),
    ) ?? null
  );
}

function successorNameOf(call: ToolCall): string | null {
  return (
    /Successor tab:?\s+surface:\d+\s+"(.+)"/u.exec(
      call.result?.text ?? '',
    )?.[1] ?? null
  );
}

// ---------------------------------------------------------------------------
// Closing workspaces, by id
// ---------------------------------------------------------------------------

/** Surfaces the run log recorded (cleanup mode fills this from the log). */
const knownSurfaces = new Set<string>();

async function closeWorkspace(
  workspaceId: string,
  marker: string,
): Promise<string> {
  const tree = await readWorkspace(workspaceId, marker);
  if (tree.kind === 'gone') return 'already closed';
  if (tree.kind === 'unreadable')
    return `NOT closed: its tabs could not be read (${tree.reason})`;
  const known =
    fence.surfaces.get(tree.view.id.toUpperCase()) ?? new Set<string>();
  const strangers = tree.view.surfaces.filter(
    (surface) =>
      !knownSurfaces.has(surface.id.toUpperCase()) &&
      !known.has(surface.id.toUpperCase()),
  );
  if (strangers.length > 0) {
    return `NOT closed: it holds tab(s) the run log never saw: ${strangers.map((surface) => `${surface.id} "${surface.title ?? ''}"`).join(', ')}`;
  }
  const call = await fenced(
    ['close-workspace', '--workspace', workspaceId],
    marker,
  );
  if (call.kind === 'failed') return `NOT closed: ${call.reason}`;
  const gone = await waitFor(15_000, 500, async () => {
    const again = await readWorkspace(workspaceId, marker);
    return again.kind === 'gone' ? true : null;
  });
  const result =
    gone.kind === 'ok'
      ? 'closed (the tree no longer has it)'
      : 'close sent, but the tree still lists it after 15 s';
  logEvent('workspace-closed', {result, workspaceId});
  return result;
}

interface RunEvent {
  args?: unknown;
  event: string;
  path?: string;
  surfaceId?: string | null;
  text?: string;
  workspaceId?: string | null;
}

function readRunEvents(runDir: string): RunEvent[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, 'run.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line) as RunEvent];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Inbox JSON
// ---------------------------------------------------------------------------

/** The text of the inbox JSON's smallest record that mentions `needle`. */
function inboxRecordMentioning(stdout: string, needle: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  let best: string | null = null;
  const visit = (value: unknown): void => {
    if (value == null || typeof value !== 'object') return;
    const text = JSON.stringify(value);
    if (!text.includes(needle)) return;
    if (
      !Array.isArray(value) &&
      text.includes('Continues') &&
      (best == null || text.length < best.length)
    )
      best = text;
    for (const child of Array.isArray(value) ? value : Object.values(value))
      visit(child);
  };
  visit(json);
  if (best != null) return best;
  // No record with both: return the smallest one mentioning the needle, for evidence.
  const visitAny = (value: unknown): void => {
    if (value == null || typeof value !== 'object') return;
    const text = JSON.stringify(value);
    if (!text.includes(needle)) return;
    if (!Array.isArray(value) && (best == null || text.length < best.length))
      best = text;
    for (const child of Array.isArray(value) ? value : Object.values(value))
      visitAny(child);
  };
  visitAny(json);
  return best;
}

function excerptAround(text: string, word: string): string {
  const index = text.indexOf(word);
  return index < 0
    ? text.slice(0, 400)
    : text.slice(Math.max(0, index - 80), index + 320);
}

/** Remove the kill switch only when its text is still the text this run wrote. */
function removeKillSwitch(path: string, text: string): void {
  let now: string | null;
  try {
    now = readFileSync(path, 'utf8');
  } catch {
    now = null;
  }
  if (now === text) {
    rmSync(path);
    logEvent('kill-switch-removed', {path});
    say(`  info  S5  kill switch removed: ${path}`);
  } else {
    logEvent('kill-switch-left', {
      path,
      reason: now == null ? 'already gone' : 'its text changed',
    });
    say(
      `  info  S5  kill switch NOT removed (${now == null ? 'already gone' : 'its text is no longer this run’s'}): ${path}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/** Checks every handoff scenario that expects exit 0 shares. */
function checkStarted(
  scenario: string,
  call: ToolCall | null,
  expectBare: 'args' | 'none',
): boolean {
  if (call == null) {
    check(
      scenario,
      'the session ran thread handoff',
      false,
      'no Bash call running thread handoff appeared in the transcript in time',
    );
    return false;
  }
  const bare =
    expectBare === 'none'
      ? call.command.trim() === HANDOFF_COMMAND
      : isBareHandoff(call.command.trim()) &&
        call.command.trim() !== HANDOFF_COMMAND;
  check(
    scenario,
    expectBare === 'none'
      ? 'the call is bare and has NO arguments (exclusion pattern, without arguments)'
      : 'the call is bare and has arguments (exclusion pattern, with arguments)',
    bare,
    `command: ${call.command}`,
  );
  const started = (call.result?.text ?? '').includes('Successor started');
  check(
    scenario,
    'exit 0: "Successor started", with no dangerouslyDisableSandbox (it ran unsandboxed through the exclusion and reached cmux)',
    started && !call.disableSandbox,
    describeCall(call),
  );
  return started;
}

async function scenarioS1(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'S1', 'keep');
  if (t == null) return;
  const since = new Date().toISOString();
  const typed = await typeLine(
    ctx,
    t,
    explicitHandoffPrompt(ctx, 'S1', t.name),
  );
  if (
    !check('S1', 'the scenario prompt is submitted', typed == null, typed ?? '')
  )
    return;
  const call = await waitForHandoffCall(t, since, 300_000);
  if (!checkStarted('S1', call, 'args') || call == null) return;
  const callerCalls = toolCalls(
    readTranscript(transcriptPath(t.sessionId)) ?? [],
  );
  const retries = callerCalls.filter((entry) => entry.disableSandbox);
  check(
    'S1',
    'no call in the old session asked for the sandbox to be turned off (no retry outside the sandbox)',
    retries.length === 0,
    retries.map((entry) => entry.command).join('\n'),
  );
  const tab = await waitForSuccessorTab(ctx, t, 90_000);
  if (tab == null) {
    check(
      'S1',
      'a new tab opens in the SAME workspace running Claude Code',
      false,
      'no second tab showing another session within 90 s',
    );
    return;
  }
  if (
    !check(
      'S1',
      'the successor tab shows no dialog (trust or permission; never answered)',
      tab.dialog == null,
      tab.dialog == null ? '' : `${tab.dialog}:\n${lastLines(tab.screen, 30)}`,
    )
  )
    return;
  check(
    'S1',
    'a new tab opens in the SAME workspace running Claude Code',
    true,
    `tab ${tab.surfaceId} in ${t.workspaceId}, status line ⌗ ${tab.sessionId ?? '?'}`,
  );
  const successorId = tab.sessionId ?? '';
  const keys = readRunEvents(ctx.runDir).filter(
    (event) =>
      event.event === 'cmux-write' &&
      JSON.stringify(event.args ?? '')
        .toUpperCase()
        .includes(tab.surfaceId.toUpperCase()),
  );
  check(
    'S1',
    'nobody pressed a key in the successor tab (the harness sent it nothing)',
    keys.length === 0,
    `${keys.length} cmux writes named ${tab.surfaceId}`,
  );
  const link = await waitForLink(t, 240_000);
  if (link == null) {
    check(
      'S1',
      'the successor links: continued-by: on the old bead, continues: on the new one',
      false,
      `no continued-by: label on the old session's bead within 240 s`,
    );
    return;
  }
  const back = labelTarget(link.successor.labels, CONTINUES_LABEL_PREFIX);
  check(
    'S1',
    'the successor links: continued-by: on the old bead, continues: on the new one',
    back === link.caller.id,
    `${link.caller.id} continued-by:${link.successor.id}; ${link.successor.id} continues:${back ?? '(missing)'}`,
  );
  const records = readTranscript(transcriptPath(successorId)) ?? [];
  const kickoff = firstPrompt(records) ?? '';
  check(
    'S1',
    'the successor started on a prose kickoff (not a slash command) naming the block and thread request --continues',
    kickoff.startsWith('You are the successor') &&
      kickoff.includes(`thread request --continues ${link.caller.id}`),
    kickoff.slice(0, 400),
  );
  const request = linkCall(successorId);
  const succLines = messageLines(successorId);
  // Any writer's spelling: the capture rewrite turns Stop lines into backfill.
  const firstStop =
    succLines.find((entry) => entry.role === 'assistant') ?? null;
  const prompts = succLines.filter(
    (entry) => entry.role === 'user' && (entry.at ?? '') <= (request?.at ?? ''),
  );
  check(
    'S1',
    'the successor linked in its FIRST turn',
    request != null &&
      prompts.length === 1 &&
      (firstStop == null || (firstStop.at ?? '') >= (request.at ?? '')),
    `link call at ${request?.at ?? '(none)'}: ${request?.command ?? ''}\nprompts before it: ${prompts.length}; first Stop at ${firstStop?.at ?? '(none yet)'}\ntranscript ${transcriptPath(successorId)}`,
  );
  const named = await waitFor(180_000, 3000, async () => {
    const names = readWorkspaceNames(process.env);
    if (names.kind !== 'read') return null;
    const mine = names.records.filter(
      (record) =>
        record.workspaceId.toUpperCase() === t.workspaceId.toUpperCase(),
    );
    const newest = mine.at(-1);
    if (newest?.beadId !== link.successor.id) return null;
    const tree = await readWorkspace(t.workspaceId, ctx.marker);
    if (tree.kind !== 'read') return null;
    return {newest, tree: tree.view};
  });
  if (named.kind === 'ok') {
    check(
      'S1',
      'the workspace name moved to the successor',
      named.value.tree.title === named.value.newest.nameSet,
      `newest workspace-names record: bead ${named.value.newest.beadId}, nameSet "${named.value.newest.nameSet}"\ncmux title now: "${named.value.tree.title ?? ''}"`,
    );
  } else {
    const names = readWorkspaceNames(process.env);
    const mine =
      names.kind === 'read'
        ? names.records.filter(
            (record) =>
              record.workspaceId.toUpperCase() === t.workspaceId.toUpperCase(),
          )
        : [];
    check(
      'S1',
      'the workspace name moved to the successor',
      false,
      `no workspace-names record by ${link.successor.id} for ${t.workspaceId} within 180 s; records for it: ${JSON.stringify(mine.map((record) => ({bead: record.beadId, name: record.nameSet})))}`,
    );
  }
  const tree = await readWorkspace(t.workspaceId, ctx.marker);
  const oldTab =
    tree.kind === 'read'
      ? tree.view.surfaces.find(
          (surface) => surface.id.toUpperCase() === t.surfaceId.toUpperCase(),
        )
      : undefined;
  const newTab =
    tree.kind === 'read'
      ? tree.view.surfaces.find(
          (surface) => surface.id.toUpperCase() === tab.surfaceId.toUpperCase(),
        )
      : undefined;
  check(
    'S1',
    "the old tab's title marks it handed off",
    (oldTab?.title ?? '').startsWith(HANDED_OFF_TAB_PREFIX),
    `old tab title: "${oldTab?.title ?? '(tab not found)'}"; successor tab title: "${newTab?.title ?? '(tab not found)'}"`,
  );
  const shown = sdk(['thread', 'show', link.successor.id], 120_000);
  const chain = shown.stdout.slice(shown.stdout.indexOf('Handoff chain'));
  check(
    'S1',
    'thread show of the successor prints the chain with both sessions',
    shown.stdout.includes('Handoff chain') &&
      chain.includes(link.caller.id) &&
      chain.includes(link.successor.id),
    shown.stdout.includes('Handoff chain')
      ? lastLines(chain.split('\n').slice(0, 14).join('\n'), 14)
      : `exit ${shown.status}; no "Handoff chain" section\n${lastLines(shown.stdout + shown.stderr, 10)}`,
  );
  const inbox = sdk(['thread', 'inbox', '--json', '--days', '1'], 300_000);
  const card = inboxRecordMentioning(inbox.stdout, successorId);
  check(
    'S1',
    "the successor's inbox card names its predecessor (Continues)",
    card != null && card.includes('Continues') && card.includes(link.caller.id),
    card == null
      ? `exit ${inbox.status}; no inbox record mentions ${successorId}\n${lastLines(inbox.stderr, 6)}`
      : excerptAround(card, 'Continues'),
  );
  const callerStop = await waitFor(120_000, 1000, () =>
    stopAtOrAfter(t.sessionId, call.result?.at ?? since),
  );
  const after = callsAfter(t.sessionId, call);
  const work = after.filter(
    (entry) =>
      !(entry.name === 'Bash' && /thread (status|show)/u.test(entry.command)),
  );
  check(
    'S1',
    'the old session ended its turn after exit 0 and did no more work (1r6d.31)',
    callerStop.kind === 'ok' && work.length === 0,
    `Stop after the call: ${callerStop.kind === 'ok' ? (callerStop.value.at ?? '?') : 'none within 120 s'}; tool calls after it: ${listOr(
      after.map((entry) => `${entry.name} ${entry.command}`),
      ' | ',
      'none',
    )}`,
  );
  // keep: nothing happens to the old tab.
  const kept = await waitFor(20_000, 1000, async () => {
    const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
    return screen.kind === 'read' && statusLineIdOf(screen.text) === t.sessionId
      ? screen.text
      : null;
  });
  const events = predecessorEvents(t.sessionId);
  check(
    'S1',
    'keep: the old tab still runs its Claude Code and no watcher acted',
    kept.kind === 'ok' && events.length === 0,
    `old tab status line ⌗ ${kept.kind === 'ok' ? t.sessionId : '(not seen)'}; watcher log events for it: ${events.length}`,
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: link.caller.id,
    scenario: 'S1',
    successor: successorId,
    successorBead: link.successor.id,
    successorSurface: tab.surfaceId,
  });
}

/** S2 and S3 share everything up to the act. */
async function scenarioAct(
  ctx: Ctx,
  scenario: 'S2' | 'S3',
  mode: 'close' | 'exit',
): Promise<void> {
  const t = await startThrowaway(ctx, scenario, mode);
  if (t == null) return;
  const since = new Date().toISOString();
  const prompt =
    scenario === 'S3'
      ? bareHandoffPrompt(ctx)
      : explicitHandoffPrompt(ctx, scenario, t.name);
  const typed = await typeLine(ctx, t, prompt);
  if (
    !check(
      scenario,
      'the scenario prompt is submitted',
      typed == null,
      typed ?? '',
    )
  )
    return;
  const call = await waitForHandoffCall(t, since, 300_000);
  if (
    !checkStarted(scenario, call, scenario === 'S3' ? 'none' : 'args') ||
    call == null
  )
    return;
  const planned =
    /Old tab when done:?\s+(.+)/u.exec(call.result?.text ?? '')?.[1] ?? '';
  check(
    scenario,
    `the output says the old tab will ${mode} after the handshake, and a watcher started`,
    /watcher pid \d+/u.test(planned),
    planned,
  );
  const tab = await waitForSuccessorTab(ctx, t, 90_000);
  if (tab == null || tab.dialog != null) {
    check(
      scenario,
      'the successor tab runs Claude Code with no dialog',
      false,
      tab == null
        ? 'no second tab showing another session within 90 s'
        : `${tab.dialog}:\n${lastLines(tab.screen, 30)}`,
    );
    return;
  }
  const acted = await waitFor(360_000, 1000, () => {
    const events = predecessorEvents(t.sessionId).filter(
      (event) => event.event !== 'started',
    );
    return events.length > 0 ? events : null;
  });
  if (acted.kind !== 'ok') {
    check(
      scenario,
      `the watcher acted (${mode})`,
      false,
      `no acted/kept event for ${t.sessionId} in ${predecessorLogPath(process.env)} within 360 s`,
    );
    return;
  }
  const event = acted.value[0];
  const link = sessionBead(t.sessionId);
  const successorBead =
    link == null ? null : labelTarget(link.labels, CONTINUED_BY_LABEL_PREFIX);
  const stop = stopAtOrAfter(t.sessionId, call.result?.at ?? since);
  const request = tab.sessionId == null ? null : linkCall(tab.sessionId);
  const actAt = event?.at ?? '';
  const settledAt =
    stop?.at == null
      ? null
      : new Date(Date.parse(stop.at) + PREDECESSOR_SETTLE_MS).toISOString();
  const users = messageLines(t.sessionId).filter(
    (entry) =>
      entry.role === 'user' && (entry.at ?? '') > (call.result?.at ?? since),
  );
  check(
    scenario,
    `the watcher acted (${mode}) only after BOTH handshake halves held`,
    event?.event === 'acted' &&
      successorBead != null &&
      settledAt != null &&
      actAt >= settledAt &&
      request?.at != null &&
      request.at < actAt &&
      users.length === 0,
    [
      `handoff call result: ${call.result?.at ?? '?'}`,
      `successor's thread request --continues: called ${request?.at ?? '(not found)'}, result ${request?.result?.at ?? '?'}`,
      `old session's Stop line: ${stop?.at ?? '(none)'}; + ${PREDECESSOR_SETTLE_MS / 1000} s settle = ${settledAt ?? '?'}`,
      `user lines after the handoff: ${users.length}`,
      `watcher event: ${event?.event ?? '?'} at ${actAt}`,
      `detail: ${event?.detail ?? ''}`,
      `continued-by: ${successorBead ?? '(missing)'}`,
    ].join('\n'),
  );
  const name = successorNameOf(call) ?? '';
  if (mode === 'exit') {
    const tomb = await waitFor(30_000, 1000, async () => {
      const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
      return screen.kind === 'read' && screen.text.includes(TOMBSTONE_HEADLINE)
        ? screen.text
        : null;
    });
    const text = tomb.kind === 'ok' ? tomb.value : '';
    const focus = focusCommandOf(tab.surfaceId, t.workspaceId);
    const want = [
      TOMBSTONE_HEADLINE,
      name,
      focus,
      `claude --resume ${t.sessionId}`,
    ];
    const missing = want.filter((part) => part === '' || !text.includes(part));
    check(
      scenario,
      'the old tab shows the tombstone: successor name, focus command, resume command',
      tomb.kind === 'ok' && missing.length === 0,
      `${missing.length > 0 ? `missing: ${JSON.stringify(missing)}\n` : ''}${lastLines(text, 14)}`,
    );
    check(
      scenario,
      'the old bead says predecessor exited',
      (link?.notes ?? '').includes('predecessor exited'),
      lastLines(link?.notes ?? '', 3),
    );
  } else {
    const gone = await waitFor(20_000, 1000, async () => {
      const tree = await readWorkspace(t.workspaceId, ctx.marker);
      if (tree.kind !== 'read') return null;
      const ids = tree.view.surfaces.map((surface) => surface.id.toUpperCase());
      return ids.includes(t.surfaceId.toUpperCase()) ? null : ids;
    });
    const succScreen = await readScreen(
      t.workspaceId,
      tab.surfaceId,
      ctx.marker,
    );
    const succId =
      succScreen.kind === 'read' ? statusLineIdOf(succScreen.text) : null;
    check(
      scenario,
      'the old tab is gone and the successor tab remains with its Claude Code',
      gone.kind === 'ok' &&
        gone.value.includes(tab.surfaceId.toUpperCase()) &&
        succId === tab.sessionId,
      `tabs now: ${gone.kind === 'ok' ? gone.value.join(', ') : '(old tab still listed after 20 s)'}; successor tab ⌗ ${succId ?? '(not seen)'}`,
    );
    check(
      scenario,
      'the old bead says predecessor closed',
      (link?.notes ?? '').includes('predecessor closed'),
      lastLines(link?.notes ?? '', 3),
    );
  }
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: link?.id ?? null,
    scenario,
    successor: tab.sessionId,
    successorBead,
    successorSurface: tab.surfaceId,
  });
}

async function scenarioS4(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'S4', 'exit');
  if (t == null) return;
  const since = new Date().toISOString();
  const typed = await typeLine(
    ctx,
    t,
    explicitHandoffPrompt(ctx, 'S4', t.name),
  );
  if (
    !check('S4', 'the scenario prompt is submitted', typed == null, typed ?? '')
  )
    return;
  const call = await waitForHandoffCall(t, since, 300_000);
  if (!checkStarted('S4', call, 'args') || call == null) return;
  const planned =
    /Old tab when done:?\s+(.+)/u.exec(call.result?.text ?? '')?.[1] ?? '';
  check(
    'S4',
    'a watcher started for exit',
    /watcher pid \d+/u.test(planned),
    planned,
  );
  const stop = await waitFor(180_000, 250, () =>
    stopAtOrAfter(t.sessionId, call.result?.at ?? since),
  );
  if (stop.kind !== 'ok') {
    check(
      'S4',
      'the old session ends its turn after the handoff',
      false,
      'no Stop line within 180 s',
    );
    return;
  }
  const typedAt = new Date().toISOString();
  const interrupted = await typeLine(ctx, t, userLine(ctx));
  check(
    'S4',
    'a user line is typed into the old session right after its Stop',
    interrupted == null,
    `Stop line at ${stop.value.at ?? '?'}; typed at ${typedAt}${interrupted == null ? '' : `; failed: ${interrupted}`}`,
  );
  const ended = await waitFor(120_000, 1000, () => {
    const events = predecessorEvents(t.sessionId).filter(
      (event) => event.event !== 'started',
    );
    return events.length > 0 ? events : null;
  });
  const event = ended.kind === 'ok' ? ended.value[0] : null;
  check(
    'S4',
    'the watcher gave up without acting (kept)',
    event?.event === 'kept' &&
      !(
        ended.kind === 'ok' &&
        ended.value.some((entry) => entry.event === 'acted')
      ),
    event == null
      ? 'no watcher event within 120 s'
      : `${event.event} at ${event.at}: ${event.detail}`,
  );
  const bead = sessionBead(t.sessionId);
  check(
    'S4',
    'the old bead says why: predecessor kept: handshake failed',
    (bead?.notes ?? '').includes('predecessor kept: handshake failed'),
    lastLines(bead?.notes ?? '', 3),
  );
  const alive = await waitFor(120_000, 1000, async () => {
    const answered = stopAtOrAfter(t.sessionId, typedAt);
    if (answered == null) return null;
    const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
    return screen.kind === 'read' && statusLineIdOf(screen.text) === t.sessionId
      ? {answered, screen: screen.text}
      : null;
  });
  check(
    'S4',
    'the old session keeps running: it answered the line and its tab still shows it',
    alive.kind === 'ok',
    alive.kind === 'ok'
      ? `answered (Stop at ${alive.value.answered.at ?? '?'}); screen:\n${lastLines(alive.value.screen, 8)}`
      : 'no answer or no status line within 120 s',
  );
  const link =
    bead == null ? null : labelTarget(bead.labels, CONTINUED_BY_LABEL_PREFIX);
  info(
    'S4',
    `successor link (not required here): continued-by:${link ?? '(none)'}`,
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: bead?.id ?? null,
    scenario: 'S4',
    successorBead: link,
  });
}

async function scenarioS5(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'S5', 'refused');
  if (t == null) return;
  const path = killSwitchPath(process.env);
  if (existsSync(path)) {
    check(
      'S5',
      'the kill switch file is absent before the test (refusing to start S5)',
      false,
      `${path} already exists; this run did not create it and leaves it alone`,
    );
    return;
  }
  const text = `${ctx.markerTag} live-handoff ${ctx.stamp} S5: the live test created this kill switch and removes it in a finally block.\n`;
  let created = false;
  try {
    writeFileSync(path, text, {flag: 'wx'});
    created = true;
    logEvent('kill-switch-created', {path, text});
    info('S5', `kill switch created: ${path}`);
    const since = new Date().toISOString();
    const typed = await typeLine(ctx, t, ruleHandoffPrompt(ctx));
    if (
      !check(
        'S5',
        'the scenario prompt is submitted',
        typed == null,
        typed ?? '',
      )
    )
      return;
    const call = await waitForHandoffCall(t, since, 300_000);
    if (call == null) {
      check(
        'S5',
        'asked to hand off, the session used thread handoff',
        false,
        'no Bash call running thread handoff within 300 s',
      );
      return;
    }
    check(
      'S5',
      `asked to hand off, the session used \`${HANDOFF_COMMAND}\`, bare`,
      isBareHandoff(call.command.trim()),
      `command: ${call.command}`,
    );
    const refusal = call.result?.text ?? '';
    check(
      'S5',
      'exit 3: the gate refused for the kill switch',
      /refus/iu.test(refusal) && /kill switch|handoff-off/iu.test(refusal),
      describeCall(call),
    );
    await waitFor(180_000, 1000, () =>
      stopAtOrAfter(t.sessionId, call.result?.at ?? since),
    );
    const after = callsAfter(t.sessionId, call);
    const attempts = after.filter(
      (entry) =>
        entry.disableSandbox ||
        /(?:^|[\s;&|(`$])(?:cmux|claude)(?:\s|$)/u.test(entry.command) ||
        /thread (?:spawn|handoff|respawn)/u.test(entry.command),
    );
    check(
      'S5',
      'after the refusal it stopped: no cmux or claude command, no retry, no other attempt to start a session',
      attempts.length === 0,
      `tool calls after the refusal: ${listOr(
        after.map(
          (entry) =>
            `${entry.name}${entry.disableSandbox ? ' (sandbox off)' : ''} ${entry.command}`,
        ),
        ' | ',
        'none',
      )}`,
    );
    const bead = sessionBead(t.sessionId);
    check(
      'S5',
      'the bead records the refusal (handoff-refused label, "handoff refused: killSwitch")',
      (bead?.labels ?? []).includes(HANDOFF_REFUSED_LABEL) &&
        (bead?.notes ?? '').includes('handoff refused: killSwitch'),
      `labels: ${(bead?.labels ?? []).join(', ')}\nnotes: ${lastLines(bead?.notes ?? '', 3)}`,
    );
    const tree = await readWorkspace(t.workspaceId, ctx.marker);
    check(
      'S5',
      'nothing was opened: the workspace still holds one tab',
      tree.kind === 'read' && tree.view.surfaces.length === 1,
      tree.kind === 'read'
        ? `${tree.view.surfaces.length} tab(s)`
        : tree.reason,
    );
    logEvent('scenario-sessions', {
      caller: t.sessionId,
      callerBead: bead?.id ?? null,
      scenario: 'S5',
    });
  } finally {
    if (created) removeKillSwitch(path, text);
  }
}

async function scenarioS6(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'S6', 'guard');
  if (t == null) return;
  const since = new Date().toISOString();
  const typed = await typeLine(ctx, t, guardPrompt(ctx));
  if (
    !check('S6', 'the scenario prompt is submitted', typed == null, typed ?? '')
  )
    return;
  const done = await waitFor(300_000, 1000, () =>
    stopAtOrAfter(t.sessionId, since),
  );
  if (done.kind !== 'ok') {
    check(
      'S6',
      'the session finishes its turn',
      false,
      'no Stop line within 300 s',
    );
    return;
  }
  const records = readTranscript(transcriptPath(t.sessionId)) ?? [];
  const calls = toolCalls(records).filter(
    (entry) => (entry.at ?? '') >= since && entry.name === 'Bash',
  );
  const denied = (call: ToolCall | undefined): boolean =>
    call?.result != null &&
    call.result.isError &&
    call.result.text.includes('thread handoff');
  const surface = calls.find((entry) =>
    /cmux\s+new-surface/u.test(entry.command),
  );
  const bg = calls.find((entry) => /claude\s+--bg/u.test(entry.command));
  const identify = calls.find((entry) =>
    /cmux\s+identify/u.test(entry.command),
  );
  // home-base-mbnjv.14: a session that declines a forbidden command never
  // asks the guard (run 20261029T174600Z: haiku declined both), so each
  // command it did not run is handed to the guard's real dispatcher entry
  // with this session's id, and the run log says so.
  const probes = guardProbeCommands(ctx);
  const viaGuard = (
    call: ToolCall | undefined,
    command: string,
    wantDeny: boolean,
  ): {detail: string; ok: boolean} => {
    if (call != null) {
      return {
        detail: describeCall(call),
        ok: wantDeny
          ? denied(call)
          : call.result != null && !call.result.text.includes('thread handoff'),
      };
    }
    const driven = driveGuard(t.sessionId, command);
    logEvent('guard-driven', {
      command,
      reason: 'the session did not run it (home-base-mbnjv.14)',
      status: driven.status,
      stderr: driven.stderr.slice(0, 2000),
    });
    const detail = `the session did not run it, so the guard was driven directly (its dispatcher entry, PreToolUse payload, session ${t.sessionId}): exit ${String(driven.status)}${driven.stderr.trim() === '' ? '' : `\n${driven.stderr.trim().slice(0, 600)}`}`;
    return {
      detail,
      ok: wantDeny
        ? driven.status === 2 && driven.stderr.includes('thread handoff')
        : driven.status === 0,
    };
  };
  const surfaceVerdict = viaGuard(surface, probes.surface, true);
  check(
    'S6',
    'the guard denied `cmux new-surface`, naming thread handoff',
    surfaceVerdict.ok,
    surfaceVerdict.detail,
  );
  const bgVerdict = viaGuard(bg, probes.bg, true);
  check(
    'S6',
    'the guard denied `claude --bg`, naming thread handoff',
    bgVerdict.ok,
    bgVerdict.detail,
  );
  const identifyVerdict = viaGuard(identify, probes.identify, false);
  check(
    'S6',
    'the guard let `cmux identify` through (its result is not a guard denial)',
    identifyVerdict.ok,
    identifyVerdict.detail,
  );
  const hooks = hookRecordsAfter(records, since);
  info(
    'S6',
    `transcript records mentioning a hook after the prompt: ${hooks.length}\n${hooks.slice(0, 6).join('\n')}`,
  );
  const tree = await readWorkspace(t.workspaceId, ctx.marker);
  check(
    'S6',
    'no tab was opened in the workspace',
    tree.kind === 'read' && tree.view.surfaces.length === 1,
    tree.kind === 'read' ? `${tree.view.surfaces.length} tab(s)` : tree.reason,
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: sessionBead(t.sessionId)?.id ?? null,
    scenario: 'S6',
  });
}

/** One `thread handoff --dry-run` call of the M measurement. */
interface NoteVariant {
  command: string;
  /** What the variant tests, for the table. */
  what: string;
}

/** The note part of a variant: one character class between plain words. */
const PLAIN_NOTE = 'plain note 1, with a period. and a hyphen-word';

/**
 * M's variants (home-base-mbnjv.9 design 1): the controls, then one variant
 * per character class, each placed after a space ("plain X note", the
 * position the matcher is most likely to object to). Inside double quotes,
 * as the rule documents the call; `"` and the backtick go inside single
 * quotes, where the shell takes them literally; the single-quote control
 * shows single quoting alone changes nothing.
 */
function noteVariants(ctx: Ctx): NoteVariant[] {
  const base = `${HANDOFF_COMMAND} --dry-run`;
  const dq = (what: string, note: string): NoteVariant => ({
    command: `${base} --note "${note}"`,
    what,
  });
  const sq = (what: string, note: string): NoteVariant => ({
    command: `${base} --note '${note}'`,
    what,
  });
  const chars = [
    '[',
    ']',
    '*',
    '?',
    '\\',
    ';',
    ':',
    "'",
    '$',
    '(',
    ')',
    '&',
    '|',
    '<',
    '>',
    '#',
    '!',
    '{',
    '}',
    '~',
    '=',
    '/',
    '_',
    '@',
    '%',
    '+',
    '—',
    'é',
  ];
  return [
    // NEGATIVE CONTROL (home-base-mbnjv.10): the retracted bun spelling, which
    // the sandbox never lets out (C12); it must come back "inside".
    {
      command: 'bun run justin-sdk thread handoff --dry-run',
      what: 'negative control: the retracted bun spelling, no note',
    },
    {command: base, what: 'control: no note'},
    dq('control: plain note in double quotes', PLAIN_NOTE),
    sq('control: plain note in single quotes', PLAIN_NOTE),
    ...chars.map((char) =>
      dq(`${char} in double quotes`, `plain ${char} note`),
    ),
    sq('" in single quotes', 'plain " note'),
    sq('` in single quotes', 'plain ` note'),
    dq(
      'the S1 note of run 20261029T154357Z',
      `${ctx.markerTag} live test S1: the successor replies with the single word linked and ends its turn; it runs no other command and changes no file`,
    ),
    dq('the harness note now (bracket-free marker)', successorNote(ctx, 'S1')),
  ];
}

function measurePrompt(ctx: Ctx, path: string, count: number): string {
  return `${ctx.markerTag} Live test M of the handoff note characters. Read the file ${path} with the Read tool. Each of its ${count} lines is one Bash command that writes nothing (a read-only command or a dry run). Run every line as its own Bash call, exactly as written, character for character, in the order given; several calls in one message are fine. Never set dangerouslyDisableSandbox, never retry a command, never change, quote, escape or fix a command, and run nothing else. Then reply with the single word done and end your turn. ${HANDS_OFF}`;
}

type NoteVerdict =
  | 'inside the sandbox'
  | 'not measured'
  | 'outside the sandbox';

/** One dry run's answer: where it ran, and the Gate line that says so. */
function noteVerdict(call: ToolCall | undefined): {
  evidence: string;
  verdict: NoteVerdict;
} {
  if (call?.result == null) {
    return {evidence: 'not run exactly as written', verdict: 'not measured'};
  }
  if (call.disableSandbox) {
    return {
      evidence: 'the call set dangerouslyDisableSandbox',
      verdict: 'not measured',
    };
  }
  const gate = /^\s*Gate:\s+(.+)$/mu.exec(call.result.text)?.[1]?.trim();
  if (gate == null) {
    // A --variants-file command that is not a dry run (e.g. `cmux ping`):
    // the sandbox's EPERM, or a clean result.
    const tail = lastLines(call.result.text, 3).replaceAll('\n', ' ⏎ ');
    // zsh says "operation not permitted: ps" when the sandbox denies the exec.
    if (/operation not permitted|EPERM/iu.test(call.result.text)) {
      return {evidence: tail, verdict: 'inside the sandbox'};
    }
    return call.result.isError
      ? {evidence: `no Gate line, error: ${tail}`, verdict: 'not measured'}
      : {evidence: tail, verdict: 'outside the sandbox'};
  }
  if (
    gate.includes('cmuxUnreachable') &&
    /Operation not permitted|EPERM/u.test(gate)
  ) {
    return {evidence: gate, verdict: 'inside the sandbox'};
  }
  // The checks before the ping (kill switch, guard, pane) say nothing.
  if (
    /^would refuse: (?:killSwitch|guardNotRegistered|notInCmuxPane|cmuxUnreachable)/u.test(
      gate,
    )
  ) {
    return {evidence: gate, verdict: 'not measured'};
  }
  return {evidence: gate, verdict: 'outside the sandbox'};
}

/** M: which note characters keep the sandbox exclusion from applying. */
async function scenarioM(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'M', 'measure');
  if (t == null) return;
  const variants =
    ctx.variantsFile == null
      ? noteVariants(ctx)
      : readFileSync(ctx.variantsFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => ({command: line.trim(), what: line.trim()}));
  const path = join(ctx.runDir, 'note-variants.txt');
  writeFileSync(path, `${variants.map((v) => v.command).join('\n')}\n`);
  logEvent('note-variants', {path, variants});
  const since = new Date().toISOString();
  const typed = await typeLine(
    ctx,
    t,
    measurePrompt(ctx, path, variants.length),
  );
  if (
    !check(
      'M',
      'the measurement prompt is submitted',
      typed == null,
      typed ?? '',
    )
  )
    return;
  const done = await waitFor(1_200_000, 2000, () => {
    const calls = toolCalls(readTranscript(transcriptPath(t.sessionId)) ?? []);
    const all = variants.every((v) =>
      calls.some((c) => c.command.trim() === v.command && c.result != null),
    );
    const stop = stopAtOrAfter(t.sessionId, since);
    return all || stop != null ? true : null;
  });
  info('M', `waited ${Math.round(done.waitedMs / 1000)} s (${done.kind})`);
  const calls = toolCalls(
    readTranscript(transcriptPath(t.sessionId)) ?? [],
  ).filter((c) => (c.at ?? '') >= since && c.name === 'Bash');
  const rows = variants.map((v) => {
    const call = calls.find((c) => c.command.trim() === v.command);
    return {...noteVerdict(call), variant: v};
  });
  const table = rows.map(
    (row) =>
      `${row.verdict.padEnd(20)}  ${row.variant.what}\n      command: ${row.variant.command}\n      gate:    ${row.evidence}`,
  );
  const unmatched = calls.filter(
    (c) => !variants.some((v) => v.command === c.command.trim()),
  );
  const text = [
    `live-handoff ${ctx.stamp} M: note characters and the sandbox exclusion`,
    `session ${t.sessionId}, transcript ${transcriptPath(t.sessionId)}`,
    `settings: ${ctx.settingsPath ?? '(none)'}`,
    '',
    ...table,
    '',
    `Bash calls that match no variant (${unmatched.length}):`,
    ...unmatched.map(
      (c) => `  ${c.disableSandbox ? '(sandbox off) ' : ''}${c.command}`,
    ),
  ].join('\n');
  writeFileSync(join(ctx.runDir, 'note-table.txt'), `${text}\n`);
  for (const row of rows) {
    logEvent('note-variant', {
      command: row.variant.command,
      evidence: row.evidence,
      verdict: row.verdict,
      what: row.variant.what,
    });
  }
  info(
    'M',
    `the table (also in ${join(ctx.runDir, 'note-table.txt')}):\n${text}`,
  );
  if (ctx.variantsFile != null) {
    // A diagnostic list: the table is the result; its controls are its own.
    check(
      'M',
      'every command in the variants file was measured',
      rows.every((row) => row.verdict !== 'not measured'),
      rows
        .filter((row) => row.verdict === 'not measured')
        .map((row) => `${row.variant.command}: ${row.evidence}`)
        .join('\n'),
    );
    logEvent('scenario-sessions', {
      caller: t.sessionId,
      callerBead: sessionBead(t.sessionId)?.id ?? null,
      scenario: 'M',
    });
    return;
  }
  const control = rows.find((row) =>
    row.variant.what.startsWith('control: plain note in double'),
  );
  check(
    'M',
    'POSITIVE CONTROL: the plain note ran outside the sandbox (the exclusion applies at all)',
    control?.verdict === 'outside the sandbox',
    control?.evidence ?? '(no control row)',
  );
  const original = rows.find((row) =>
    row.variant.what.startsWith('the S1 note'),
  );
  check(
    'M',
    // home-base-mbnjv.10: on the by-path call the S1 note that failed in run
    // 20261029T154357Z (a bun call) runs outside (measured 20261029T162150Z).
    'the S1 note of run 20261029T154357Z ran outside the sandbox on the by-path call',
    original?.verdict === 'outside the sandbox',
    original?.evidence ?? '(no row)',
  );
  check(
    'M',
    'every variant was measured',
    rows.every((row) => row.verdict !== 'not measured'),
    rows
      .filter((row) => row.verdict === 'not measured')
      .map((row) => `${row.variant.what}: ${row.evidence}`)
      .join('\n'),
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: sessionBead(t.sessionId)?.id ?? null,
    scenario: 'M',
  });
}

/** T: does a session started in this checkout meet the folder-trust dialog? */
async function trustCheck(ctx: Ctx): Promise<boolean> {
  const sessionId = randomUUID();
  const line = claudeLine({
    model: ctx.model,
    name: `${ctx.markerTag} lh trust check`,
    prompt: null,
    sessionId,
    settingsPath: ctx.settingsPath,
    xdg: null,
  });
  const created = await createWorkspace(
    `${ctx.markerTag} live-handoff ${ctx.stamp} T`,
    line,
    ctx.marker,
    'T',
  );
  if ('reason' in created) {
    check('T', 'the trust-check workspace opens', false, created.reason);
    return false;
  }
  logEvent('session-started', {
    command: line,
    role: 'trust-check',
    scenario: 'T',
    sessionId,
    surfaceId: created.surfaceId,
    workspaceId: created.workspaceId,
  });
  info(
    'T',
    `workspace ${created.workspaceId} (${created.ref}), cwd ${REPO_ROOT}, session ${sessionId} (no prompt: no tokens)`,
  );
  const seen = await waitFor(45_000, 500, async () => {
    const screen = await readScreen(
      created.workspaceId,
      created.surfaceId,
      ctx.marker,
    );
    if (screen.kind !== 'read') return null;
    const verdict = classifySuccessorScreen(screen.text);
    return verdict.kind === 'notYet' ? null : {text: screen.text, verdict};
  });
  let ok = false;
  if (seen.kind !== 'ok') {
    check(
      'T',
      'a session started in this checkout shows its input box, no folder-trust dialog',
      false,
      'neither an input box nor a dialog within 45 s',
    );
  } else {
    ok = check(
      'T',
      'a session started in this checkout shows its input box, no folder-trust dialog',
      seen.value.verdict.kind === 'started',
      `${seen.value.verdict.kind === 'dialog' ? `DIALOG: ${seen.value.verdict.label} (never answered)\n` : ''}after ${Math.round(seen.waitedMs / 1000)} s:\n${lastLines(seen.value.text, 16)}`,
    );
  }
  // The trust check holds an idle Claude Code; close it now, by its id, so it
  // does not count against the gate's live-session cap in the scenarios.
  await closeWorkspace(created.workspaceId, ctx.marker);
  return ok;
}

async function cleanup(stamp: string): Promise<number> {
  if (!/^[0-9TZ]+$/u.test(stamp)) usageExit(`not a run stamp: ${stamp}`);
  const runDir = join(RUNS_DIR, stamp);
  const events = readRunEvents(runDir);
  if (events.length === 0) {
    process.stderr.write(`no run log at ${join(runDir, 'run.jsonl')}\n`);
    return 1;
  }
  currentRun = {
    dir: runDir,
    logPath: join(runDir, 'run.jsonl'),
    outputPath: join(runDir, 'cleanup.txt'),
  };
  const marker = String(
    events.find((event) => event.event === 'run-start')?.text ?? '',
  );
  const ids = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.event === 'workspace-created' && event.workspaceId != null,
        )
        .map((event) => String(event.workspaceId)),
    ),
  ];
  for (const event of events) {
    if (event.event === 'surface-seen' && event.surfaceId != null)
      knownSurfaces.add(event.surfaceId.toUpperCase());
    if (event.event === 'workspace-created' && event.surfaceId != null)
      knownSurfaces.add(event.surfaceId.toUpperCase());
  }
  const refsOnly = events
    .filter(
      (event) =>
        event.event === 'workspace-created' && event.workspaceId == null,
    )
    .map((event) => String((event as {ref?: string}).ref ?? '?'));
  say(
    `🧹 Cleanup of live-handoff run ${stamp} (from ${join(runDir, 'run.jsonl')})`,
  );
  say('');
  say(`  Workspaces this run created, by id (${ids.length}):`);
  for (const id of ids) say(`    ${id}`);
  say('');
  for (const id of ids) fence.workspaces.add(id.toUpperCase());
  for (const id of ids) {
    const result = await closeWorkspace(id, marker);
    logEvent('cleanup', {result, workspaceId: id});
    say(`  ${id}: ${result}`);
  }
  const unresolved = refsOnly.filter(
    (ref) =>
      !events.some(
        (event) =>
          event.event === 'workspace-created' &&
          event.workspaceId != null &&
          (event as {ref?: string}).ref === ref,
      ),
  );
  if (unresolved.length > 0)
    say(
      `  ⚠️ created but never resolved to an id (close by hand after looking): ${unresolved.join(', ')}`,
    );
  const created = events.filter(
    (event) => event.event === 'kill-switch-created',
  );
  const removed = events.some((event) => event.event === 'kill-switch-removed');
  for (const event of created) {
    if (!removed && event.path != null && event.text != null)
      removeKillSwitch(event.path, event.text);
  }
  say('');
  say(
    '  Not deleted (test data, ids in the run log): session beads, message logs, transcripts, Remote Control sessions.',
  );
  return 0;
}

// ---------------------------------------------------------------------------
// B: background work during an exit handoff (home-base-mbnjv.13)
// ---------------------------------------------------------------------------

/** B's subagent prompt and background shell, the same in the prompt and the plan. */
const B_SHELL = 'sleep 100';
const B_AGENT =
  'Run the Bash command sleep 60 (timeout 120000), then reply with the single word done. Run nothing else.';

function backgroundPrompt(ctx: Ctx, title: string): string {
  return `${ctx.markerTag} Live test B of a watcher that must wait for background work. This test deliberately hands off while background work runs: the watcher under test must wait for it. Step 1: run this Bash command exactly as written, as its own call: \`bun run justin-sdk thread title "${title}"\`. Step 2: run this Bash command with run_in_background set to true, exactly as written: \`${B_SHELL}\`. Step 3: start one subagent with the Agent tool (subagent_type general-purpose, model haiku, run_in_background true) with this prompt: "${B_AGENT}" Do not wait for it. Step 4: run this Bash command exactly as written, as its own call, bare, with nothing before or after it: \`${HANDOFF_COMMAND} --note "${successorNote(ctx, 'B')}"\`. Step 5: write a one-line final report and end your turn. Afterwards, whenever a background task notification arrives, reply with the single word noted and run no tools. ${HANDS_OFF}`;
}

interface BackgroundSeen {
  /** Launch records: the tool result's backgroundTaskId or async agentId. */
  launches: {at: string | null; id: string; kind: 'agent' | 'shell'}[];
  /** task-notification records naming a task id, in any record shape. */
  notifications: {
    at: string | null;
    id: string;
    status: string;
    type: string;
  }[];
}

/** B's measurement reader: launches and completions in a transcript, raw. */
function backgroundSeen(path: string): BackgroundSeen {
  const seen: BackgroundSeen = {launches: [], notifications: []};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return seen;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    const result = record.toolUseResult as Record<string, unknown> | undefined;
    if (result != null && typeof result === 'object') {
      if (typeof result.backgroundTaskId === 'string') {
        seen.launches.push({at, id: result.backgroundTaskId, kind: 'shell'});
      }
      if (
        result.status === 'async_launched' &&
        typeof result.agentId === 'string'
      ) {
        seen.launches.push({at, id: result.agentId, kind: 'agent'});
      }
    }
    for (const match of line.matchAll(
      /<task-notification>\\n<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/gu,
    )) {
      seen.notifications.push({
        at,
        id: match[1] ?? '',
        status: match[2] ?? '',
        type: String(record.type),
      });
    }
  }
  return seen;
}

function listDir(path: string): string {
  try {
    const names = readdirSync(path);
    return names.length === 0 ? '(empty)' : names.join(', ');
  } catch (error) {
    return `(unreadable: ${String(error)})`;
  }
}

async function scenarioB(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'B', 'exit');
  if (t == null) return;
  const since = new Date().toISOString();
  const typed = await typeLine(ctx, t, backgroundPrompt(ctx, t.name));
  if (
    !check('B', 'the scenario prompt is submitted', typed == null, typed ?? '')
  )
    return;
  const call = await waitForHandoffCall(t, since, 300_000);
  if (!checkStarted('B', call, 'args') || call == null) return;
  const path = transcriptPath(t.sessionId);
  const handedAt = call.result?.at ?? since;
  const before = backgroundSeen(path);
  const kinds = new Set(
    before.launches.filter((l) => (l.at ?? '') <= handedAt).map((l) => l.kind),
  );
  check(
    'B',
    'a background shell and a background subagent were launched before the handoff',
    kinds.has('shell') && kinds.has('agent'),
    JSON.stringify(before.launches),
  );
  // MEASUREMENT: the old tab's screen while the work runs and the session is idle.
  const idle = await waitFor(120_000, 500, () =>
    stopAtOrAfter(t.sessionId, handedAt) == null ? null : true,
  );
  const screen = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
  const screenText =
    screen.kind === 'read'
      ? screen.text
      : `(unread: ${JSON.stringify(screen)})`;
  writeFileSync(
    join(ctx.runDir, 'B-screen-idle-running.txt'),
    `${screenText}\n`,
  );
  const base = path.replace(/\.jsonl$/u, '');
  // The shell's output file, as its launch result names it (measured shape).
  const outputFile =
    /Output is being written to: (\S+?\.output)/u.exec(
      readFileSync(path, 'utf8'),
    )?.[1] ?? null;
  const tasksDir =
    outputFile == null
      ? '(no output path in the transcript)'
      : dirname(outputFile);
  info(
    'B',
    [
      `idle after the handoff: ${idle.kind} after ${Math.round(idle.waitedMs / 1000)} s`,
      `screen (also B-screen-idle-running.txt), last 12 lines:`,
      lastLines(screenText, 12),
      `subagents dir: ${listDir(join(base, 'subagents'))}`,
      `tasks dir ${tasksDir}: ${listDir(tasksDir)}`,
    ].join('\n'),
  );
  logEvent('background-measure', {screen: screenText, seen: before, tasksDir});
  const acted = await waitFor(600_000, 2000, () => {
    const events = predecessorEvents(t.sessionId).filter(
      (e) => e.event !== 'started',
    );
    return events.length > 0 ? events : null;
  });
  const after = backgroundSeen(path);
  logEvent('background-after', {seen: after});
  const event = acted.kind === 'ok' ? acted.value[0] : undefined;
  const done = after.launches.map((launch) => {
    const n = after.notifications.find((x) => x.id === launch.id);
    return {...launch, doneAt: n?.at ?? null, status: n?.status ?? null};
  });
  const lastDone = done.reduce<string | null>(
    (max, d) =>
      d.doneAt == null || max == null ? null : d.doneAt > max ? d.doneAt : max,
    '',
  );
  // The watcher's acted line is logged AFTER its verification, so the act's
  // own time is earlier (run 20261029T183321Z): a task the act ended shows
  // as status killed, which is the failure this check exists for.
  const allCompleted =
    done.length > 0 &&
    done.every((d) => d.status === 'completed' && d.doneAt != null);
  check(
    'B',
    'the watcher did not act while background work ran (every task completed, none killed)',
    event != null &&
      allCompleted &&
      lastDone != null &&
      lastDone !== '' &&
      event.at > lastDone,
    [
      `watcher: ${event == null ? `no outcome within ${Math.round(acted.waitedMs / 1000)} s` : `${event.event} at ${event.at}: ${event.detail}`}`,
      ...done.map(
        (d) =>
          `${d.kind} ${d.id}: launched ${d.at ?? '?'}, notified ${d.doneAt ?? '(no notification)'} ${d.status ?? ''}`,
      ),
    ].join('\n'),
  );
  check(
    'B',
    'the watcher acted (exit) once the work finished and the turn after it ended',
    event?.event === 'acted',
    event == null ? '(no outcome)' : `${event.event}: ${event.detail}`,
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: sessionBead(t.sessionId)?.id ?? null,
    scenario: 'B',
  });
}

// ---------------------------------------------------------------------------
// C: the session id after /clear and after --resume (home-base-mbnjv.8 F22)
// ---------------------------------------------------------------------------

function idPrompt(ctx: Ctx, label: string): string {
  return `${ctx.markerTag} Live test C (${label}). Step 1: run this Bash command exactly as written, as its own call: \`printenv CLAUDE_CODE_SESSION_ID\`. Step 2: run this Bash command exactly as written, as its own call, bare, with nothing before or after it: \`${HANDOFF_COMMAND} --dry-run --note "${successorNote(ctx, 'C')}"\`. Step 3: write a one-line final report and end your turn. ${HANDS_OFF}`;
}

/** Transcripts in this checkout's project dir modified since `sinceMs` that mention `text`. */
function transcriptsMentioning(text: string, sinceMs: number): string[] {
  const dir = TRANSCRIPT_DIR;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .filter((file) => {
      try {
        return (
          Bun.file(file).lastModified >= sinceMs &&
          readFileSync(file, 'utf8').includes(text)
        );
      } catch {
        return false;
      }
    });
}

/** The screen's status-line id once it shows an idle, empty input box. */
async function idleId(
  ctx: Ctx,
  workspaceId: string,
  surfaceId: string,
): Promise<string | null> {
  const got = await waitFor(90_000, 500, async () => {
    const screen = await readScreen(workspaceId, surfaceId, ctx.marker);
    if (screen.kind !== 'read') return null;
    const lines = screenLines(screen.text);
    const box = findInputBox(lines);
    if (
      box == null ||
      workingIndicator(lines) != null ||
      dialogOnScreen(lines) != null
    )
      return null;
    return statusLineIdOf(screen.text);
  });
  return got.kind === 'ok' ? got.value : null;
}

/** One C round: type the prompt into the tab showing `shownId`, read what each id source said. */
async function idRound(
  ctx: Ctx,
  t: Throwaway,
  shownId: string,
  label: string,
): Promise<Record<string, unknown>> {
  const sinceMs = Date.now();
  const typed = await typeLine(
    ctx,
    {...t, sessionId: shownId},
    idPrompt(ctx, label),
  );
  if (typed != null) return {label, typed};
  const needle = `Live test C (${label})`;
  const found = await waitFor(300_000, 2000, () => {
    for (const file of transcriptsMentioning(needle, sinceMs)) {
      const calls = toolCalls(readTranscript(file) ?? []);
      const env = calls.find(
        (c) => c.command.trim() === 'printenv CLAUDE_CODE_SESSION_ID',
      );
      const gate = calls.find(
        (c) =>
          c.command.includes('thread handoff') &&
          (c.at ?? '') >= new Date(sinceMs).toISOString(),
      );
      if (env?.result != null && gate?.result != null) return {env, file, gate};
    }
    return null;
  });
  if (found.kind !== 'ok')
    return {label, problem: 'no printenv and dry-run results within 300 s'};
  const {env, file, gate} = found.value;
  const logs = [t.sessionId, shownId, env.result?.text.trim() ?? '']
    .filter((id, i, all) => id !== '' && all.indexOf(id) === i)
    .map((id) => ({
      id,
      typedLineInItsMessageLog: messageLines(id).some(
        (l) => l.role === 'user' && l.text.includes(needle),
      ),
    }));
  return {
    envVar: env.result?.text.trim(),
    gateLine:
      /Gate:?\s+(.+)/u.exec(gate.result?.text ?? '')?.[1] ??
      gate.result?.text.slice(0, 600),
    label,
    messageLogs: logs,
    statusLineId: shownId,
    transcript: file,
  };
}

/**
 * Type a slash command and run it. The slash menu takes the first Enter (run
 * 20261029T183321Z: the box still held /clear): while the box still holds the
 * command, a second Enter runs it.
 */
async function typeSlash(
  ctx: Ctx,
  t: Throwaway,
  command: string,
): Promise<string | null> {
  const typed = await typeLine(ctx, t, command);
  if (typed != null) return typed;
  await sleep(2000);
  const shown = await readScreen(t.workspaceId, t.surfaceId, ctx.marker);
  const held =
    shown.kind === 'read'
      ? findInputBox(screenLines(shown.text))?.draft.trim()
      : null;
  if (held !== command) return null;
  const entered = await fenced(
    [
      'send-key',
      '--workspace',
      t.workspaceId,
      '--surface',
      t.surfaceId,
      '--',
      'enter',
    ],
    ctx.marker,
  );
  info(
    t.scenario,
    `the box still held ${command} after Enter; a second Enter was sent`,
  );
  return entered.kind === 'failed' ? entered.reason : null;
}

async function scenarioC(ctx: Ctx): Promise<void> {
  const t = await startThrowaway(ctx, 'C', 'measure');
  if (t == null) return;
  const rows: Record<string, unknown>[] = [];
  rows.push(await idRound(ctx, t, t.sessionId, 'start'));
  const clear = await typeSlash(ctx, t, '/clear');
  check('C', '/clear is typed and run', clear == null, clear ?? '');
  const cleared = await idleId(ctx, t.workspaceId, t.surfaceId);
  info('C', `after /clear the status line shows ${cleared ?? '(nothing)'}`);
  if (cleared != null) rows.push(await idRound(ctx, t, cleared, 'after clear'));
  const resumeId = cleared ?? t.sessionId;
  const exit = await typeSlash(ctx, {...t, sessionId: resumeId}, '/exit');
  check('C', '/exit is typed', exit == null, exit ?? '');
  await sleep(5000);
  const line = [
    'claude',
    '--model',
    ctx.model,
    '--permission-mode',
    'auto',
    '--resume',
    resumeId,
    ...(ctx.settingsPath == null ? [] : ['--settings', ctx.settingsPath]),
  ]
    .map(zshWord)
    .join(' ');
  const created = await createWorkspace(
    `${ctx.markerTag} live-handoff ${ctx.stamp} C resume`,
    line,
    ctx.marker,
    'C',
  );
  if ('reason' in created) {
    check('C', 'the resume workspace opens', false, created.reason);
  } else {
    logEvent('session-started', {
      command: line,
      role: 'resumed',
      scenario: 'C',
      surfaceId: created.surfaceId,
      workspaceId: created.workspaceId,
    });
    const resumed = await idleId(ctx, created.workspaceId, created.surfaceId);
    info(
      'C',
      `after --resume ${resumeId} the status line shows ${resumed ?? '(nothing)'}`,
    );
    const r: Throwaway = {...t, ...created};
    if (resumed != null)
      rows.push(await idRound(ctx, r, resumed, 'after resume'));
  }
  const text = JSON.stringify(rows, null, 2);
  writeFileSync(join(ctx.runDir, 'C-session-ids.json'), `${text}\n`);
  logEvent('session-ids', {rows});
  info('C', `the measurement (also C-session-ids.json):\n${text}`);
  check(
    'C',
    'all three rounds were measured',
    rows.length === 3 && rows.every((row) => 'gateLine' in row),
    text,
  );
  logEvent('scenario-sessions', {
    caller: t.sessionId,
    callerBead: sessionBead(t.sessionId)?.id ?? null,
    scenario: 'C',
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function spendWords(): string {
  return 'one haiku session with no prompt (the trust check), then per scenario one throwaway haiku session (two or three short turns) and, in S1-S4, the haiku successor it starts (one short turn, with Remote Control): about 11 short haiku sessions for S1-S6; M is one haiku session running about 35 dry runs';
}

function printPlan(ctx: Ctx, scenarios: readonly ScenarioId[]): void {
  say(
    `live-handoff --dry-run: what a run would start (nothing created, nothing spent)`,
  );
  say('');
  say(`  marker: ${ctx.markerTag}`);
  say(`  cwd of every throwaway: ${REPO_ROOT}`);
  say(
    `  --settings file: ${ctx.settingsPath == null ? '(none: the throwaways get only ~/.claude/settings.json)' : `${ctx.settingsPath} = ${JSON.stringify(HANDOFF_SANDBOX_SETTINGS)}`}`,
  );
  say('');
  say(
    `  T   ${claudeLine({model: ctx.model, name: `${ctx.markerTag} lh trust check`, prompt: null, sessionId: '<uuid>', settingsPath: ctx.settingsPath, xdg: null})}`,
  );
  const prompts: Record<
    ScenarioId,
    {mode: string; prompt: string; xdg: boolean}
  > = {
    B: {
      mode: 'exit',
      prompt: backgroundPrompt(ctx, sessionTitle(ctx, 'B', 'exit')),
      xdg: true,
    },
    C: {
      mode: 'measure',
      prompt: `${idPrompt(ctx, 'start')}\n      then /clear, the same prompt (after clear), /exit, a new workspace running claude --resume <id>, the same prompt (after resume)`,
      xdg: false,
    },
    M: {
      mode: 'measure',
      prompt: `${measurePrompt(ctx, '<run dir>/note-variants.txt', noteVariants(ctx).length)}\n      the file's lines:\n${noteVariants(
        ctx,
      )
        .map((v) => `        ${v.command}`)
        .join('\n')}`,
      xdg: false,
    },
    S1: {
      mode: 'keep',
      prompt: explicitHandoffPrompt(ctx, 'S1', sessionTitle(ctx, 'S1', 'keep')),
      xdg: false,
    },
    S2: {
      mode: 'exit',
      prompt: explicitHandoffPrompt(ctx, 'S2', sessionTitle(ctx, 'S2', 'exit')),
      xdg: true,
    },
    S3: {mode: 'close', prompt: bareHandoffPrompt(ctx), xdg: true},
    S4: {
      mode: 'exit',
      prompt: explicitHandoffPrompt(ctx, 'S4', sessionTitle(ctx, 'S4', 'exit')),
      xdg: true,
    },
    S5: {mode: 'refused', prompt: ruleHandoffPrompt(ctx), xdg: false},
    S6: {mode: 'guard', prompt: guardPrompt(ctx), xdg: false},
  };
  for (const id of scenarios) {
    const plan = prompts[id];
    say('');
    say(
      `  ${id}  ${claudeLine({model: ctx.model, name: sessionTitle(ctx, id, plan.mode), prompt: readyPrompt(ctx, id), sessionId: '<uuid>', settingsPath: ctx.settingsPath, xdg: plan.xdg ? `<run dir>/xdg-${id}` : null})}`,
    );
    say(`      then typed: ${plan.prompt}`);
    if (id === 'S4') say(`      after its Stop, typed: ${userLine(ctx)}`);
  }
}

function preflight(ctx: Ctx): string[] {
  const problems: string[] = [];
  const config = readFileSync(
    join(REPO_ROOT, 'justin-sdk.config.json'),
    'utf8',
  );
  if (!/"successor":\s*true/u.test(config))
    problems.push(
      'componentConfig.thread.handoff.successor is not true in this checkout’s justin-sdk.config.json',
    );
  const settings = readFileSync(
    join(REPO_ROOT, '.claude', 'settings.json'),
    'utf8',
  );
  if (!settings.includes('justin-sdk hook PreToolUse'))
    problems.push(
      '.claude/settings.json has no PreToolUse dispatcher entry (the guard): run `bun run justin-sdk add thread-hooks` with the sandbox off',
    );
  if (existsSync(killSwitchPath(process.env)))
    problems.push(
      `the kill switch ${killSwitchPath(process.env)} exists: every handoff would be refused`,
    );
  const user = checkHandoffSandbox(process.env);
  const covered =
    user.kind === 'read' &&
    user.exclusions.every((entry) => entry.by != null) &&
    user.allowRules.every((entry) => entry.by != null);
  say(
    `  ~/.claude/settings.json covers thread handoff: ${user.kind === 'cannot-check' ? `cannot check (${user.reason})` : covered ? 'yes' : 'no'}`,
  );
  if (ctx.settingsPath == null && !covered) {
    say(
      '  ⚠️ Without --settings and without the global entries, every handoff runs inside the sandbox, cannot reach cmux and is refused: that run is the NEGATIVE CONTROL of the exclusion, not AC1.',
    );
  }
  return problems;
}

function finish(stamp: string): number {
  const failed = allChecks.filter((entry) => !entry.pass);
  const scenarios = [...new Set(allChecks.map((entry) => entry.scenario))];
  say('');
  say('── Summary ──');
  for (const scenario of scenarios) {
    const mine = allChecks.filter((entry) => entry.scenario === scenario);
    const bad = mine.filter((entry) => !entry.pass).length;
    say(
      `  ${bad === 0 ? 'PASS' : 'FAIL'}  ${scenario}  ${mine.length - bad}/${mine.length} checks`,
    );
  }
  say('');
  say(`  run log:  ${currentRun?.logPath ?? '?'}`);
  say(
    `  cleanup:  bun run live:handoff --cleanup ${stamp}   (closes this run's workspaces, by id)`,
  );
  logEvent('run-end', {failed: failed.length, total: allChecks.length});
  return failed.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = gateSpend(process.argv.slice(2), {
    exempt: (rest) => rest.includes('--dry-run') || rest.includes('--cleanup'),
    script: 'bun run live:handoff',
    spends: spendWords(),
  });
  const opts = parseArgs(argv);
  if (opts == null) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.cleanup != null) return await cleanup(opts.cleanup);
  const stamp = stampNow();
  const runDir = join(RUNS_DIR, stamp);
  const ctx: Ctx = {
    marker: opts.marker,
    markerTag: `[TEST_DATA_DELETABLE ${opts.marker} ]`,
    model: opts.model,
    runDir,
    settingsPath: opts.settings ? join(runDir, 'settings.json') : null,
    stamp,
    variantsFile: opts.variantsFile,
  };
  // A settings file that cannot be read or parsed stops the run (rule 7).
  const settings: unknown =
    opts.settingsFile == null
      ? HANDOFF_SANDBOX_SETTINGS
      : JSON.parse(readFileSync(opts.settingsFile, 'utf8'));
  if (opts.dryRun) {
    printPlan(ctx, opts.scenarios);
    return 0;
  }
  mkdirSync(runDir, {recursive: true});
  currentRun = {
    dir: runDir,
    logPath: join(runDir, 'run.jsonl'),
    outputPath: join(runDir, 'output.txt'),
  };
  logEvent('run-start', {
    argv: process.argv.slice(2),
    repoRoot: REPO_ROOT,
    scenarios: opts.scenarios,
    settings: opts.settings,
    stamp,
    text: ctx.marker,
  });
  if (ctx.settingsPath != null) {
    writeFileSync(ctx.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    logEvent('settings', {path: ctx.settingsPath, settings});
  }
  say(`🧪 live-handoff run ${stamp}`);
  say('');
  say(`  marker:     ${ctx.markerTag}`);
  say(`  checkout:   ${REPO_ROOT}`);
  say(`  run log:    ${currentRun.logPath}`);
  say(
    `  settings:   ${ctx.settingsPath == null ? 'none (only ~/.claude/settings.json)' : `${ctx.settingsPath} = ${JSON.stringify(HANDOFF_SANDBOX_SETTINGS)}`}`,
  );
  say(`  scenarios:  T, ${opts.scenarios.join(', ')}`);
  const problems = preflight(ctx);
  if (problems.length > 0) {
    for (const problem of problems) say(`  ❌ ${problem}`);
    logEvent('run-stopped', {problems});
    return 1;
  }
  say('');
  say('── T  trust check ──');
  const trusted = await trustCheck(ctx);
  if (!trusted) {
    say('');
    say(
      'The run STOPS here: a session in this checkout did not come up cleanly (see T). Nothing was answered.',
    );
    logEvent('run-stopped', {reason: 'trust check'});
    return finish(stamp);
  }
  const runners: Record<ScenarioId, () => Promise<void>> = {
    B: () => scenarioB(ctx),
    C: () => scenarioC(ctx),
    M: () => scenarioM(ctx),
    S1: () => scenarioS1(ctx),
    S2: () => scenarioAct(ctx, 'S2', 'exit'),
    S3: () => scenarioAct(ctx, 'S3', 'close'),
    S4: () => scenarioS4(ctx),
    S5: () => scenarioS5(ctx),
    S6: () => scenarioS6(ctx),
  };
  for (const id of opts.scenarios) {
    say('');
    say(`── ${id} ──`);
    logEvent('scenario-start', {scenario: id});
    try {
      await runners[id]();
    } catch (error) {
      const why =
        error instanceof FenceRefusal
          ? `FENCE REFUSED A CMUX CALL (a harness bug; nothing was sent): ${error.message}`
          : `harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
      check(id, 'the scenario ran to the end', false, why);
    }
  }
  return finish(stamp);
}

process.exit(await main());
