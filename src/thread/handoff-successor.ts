/**
 * `thread handoff` with componentConfig.thread.handoff.successor on: hand the
 * session off and start its successor in a new tab of the caller's cmux
 * workspace, or refuse and say why (epic home-base-mbnjv D1, D2, D5, D7, D10
 * and C2-C5; built by home-base-mbnjv.2). It absorbs the launch half of the
 * retired `thread respawn` (C3); respawn.ts keeps the shared helpers.
 *
 * With the knob OFF, `threadHandoffCommand` runs today's handOff() and prints
 * describeHandoffOutcome(), byte for byte (D10). `--to` keeps today's
 * link-only behaviour with the knob on too: the successor already exists.
 *
 * ORDER with the knob on. Nothing is written before step 3.
 *   1. Refusals, exit 2: --session naming another session (the tab and the
 *      environment belong to the caller), no session bead, a checkout that is
 *      gone, an empty --model.
 *   2. The gate (handoff-gate.ts). Refused: handOff() as today, the refusal
 *      recorded on the session bead, the block and the final-refusal message
 *      printed, exit 3, nothing opened (C2).
 *   3. The caller's pane, read-only (readPaneOfSurface): not found is exit 2.
 *   4. handOff(), then the block file <threads state dir>/handoffs/<sid>.md.
 *   5. `cmux new-surface --workspace <caller's> --pane <caller's> ...
 *      --command <zsh-quoted claude line> --focus false` (C5). The command is
 *      TYPED into an interactive zsh (measured by the conductor 2026-10-29),
 *      so every word goes through zshWord.
 *   6. The screen check (D7): `cmux read-screen` of the new tab for up to
 *      SUCCESSOR_TIMEOUT_MS. A dialog is reported (exit 1), never answered:
 *      this module sends no key and types nothing. Claude Code's input box
 *      with no dialog is "started" (exit 0). Neither is exit 1 (rule 7: an
 *      unseen start is not a start).
 *   7. (mbnjv.3) The caller's own tab is titled "↪ handed off: …".
 *   8. (mbnjv.4) predecessor exit or close: a detached watcher is started
 *      that acts on the caller's own tab only after the handshake
 *      (handoff-predecessor.ts). keep starts nothing.
 *
 * POST-LAUNCH HOOK POINT (mbnjv.3 tab names, mbnjv.4 the predecessor
 * watcher): `launchSuccessor` returns a SuccessorLaunch with both tabs' ids;
 * a later step belongs in handoffWithSuccessor right after the screen check
 * says `started`, before the exit-0 lines are built.
 */

import type {Field, OutputStyle} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {HandoffGateResult} from './handoff-gate';
import type {ResolvedHandoffConfig} from './handoff-knob';
import type {EnvLike} from './paths';
import type {FoundSession} from './session-select';

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {fieldLines, outputStyle, sectionHeader, stepColumn} from '../cli-style';
import {SDK_BIN_BY_PATH, SDK_HANDOFF_CALL} from '../sdk-invocation';
import {
  cmuxArgv,
  readPaneOfSurface,
  readSurfaceIdOfRef,
  renameTab,
  resolveCmuxBinary,
} from './cmux';
import {resolveRepoTag} from './config';
import {
  realHandoffGateReaders,
  recordLaunch,
  recordRefusal,
  runHandoffGate,
} from './handoff-gate';
import {
  appendPredecessorLog,
  appendSessionNote,
  focusCommandOf,
  liveCmuxRunner,
  PREDECESSOR_POLL_MS,
  PREDECESSOR_SETTLE_MS,
  PREDECESSOR_TIMEOUT_MS,
  predecessorLogPath,
  type PredecessorWatch,
  startPredecessorWatch,
  tombstoneLines,
  type WatcherStart,
  watcherStartedNote,
} from './handoff-predecessor';
import {dialogOnScreen, findInputBox, screenLines} from './pane-join';
import {threadsStateDir} from './paths';
import {kickoffText, liveSocketPath, zshWord} from './respawn';
import {describeHandoffOutcome, handOff} from './session-handoff';
import {SESSION_NAME_LIMIT, sessionName} from './session-name';
import {selectSession, sessionBeadsKnob} from './session-select';
import {handedOffTabTitle} from './tab-title';
import {sessionRepoOf} from './workspace-name-session';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the new tab's screen is read while Claude Code starts. */
export const SUCCESSOR_POLL_MS = 500;

/** How long the successor gets to show its input box (D7: about 20 s). */
export const SUCCESSOR_TIMEOUT_MS = 20_000;

/** A tab or session name is cut to this many characters (as respawn did). */
export const SUCCESSOR_NAME_LIMIT = SESSION_NAME_LIMIT;

/** The most screen lines a failure quotes. */
const QUOTED_SCREEN_LINES = 40;

/** What exit 0 tells the caller (the 1r6d.31 failure: it kept working). */
export const SUCCESSOR_STARTED_NEXT =
  'Next: write your final report now and end your turn. Do not keep working: your successor is already working in the same checkout. If a subagent or a background shell of yours is still running, say so in that report: when this tab exits or closes, they end with it (hand off only with no background work running).';

/**
 * What exit 2 tells the caller when its call ran inside the Claude Code
 * sandbox (home-base-mbnjv.9 design 3 and 4, fix-round F9): fix the call and
 * run it once more; a second exit 2 is reported, never worked around.
 */
export const SANDBOXED_CALL_INSTRUCTIONS = [
  `Run it once more, bare, from the repository root: \`${SDK_HANDOFF_CALL} --note "<one line>"\`, with nothing before or after it (no \`cd … &&\`, no redirect, no \`$(…)\`) and no backtick in the note. It must start with \`${SDK_BIN_BY_PATH}\`: Claude Code never excludes a call that starts with bun from the sandbox. If \`${SDK_BIN_BY_PATH}\` is not in the current directory, run \`cd <repository root>\` as its own Bash call first.`,
  'Do not set dangerouslyDisableSandbox, and never start a session another way: no cmux command, no claude command.',
  'If exit 2 comes back again, put this output in your final report and stop: Justin’s global sandbox exclusion for thread handoff may be missing (`bun run justin-sdk doctor` names it under HANDOFF_SANDBOX).',
] as const;

/** What every exit 1 after the handoff tells the caller. */
export const HANDOFF_STEP_FAILED_INSTRUCTIONS = [
  'Finish your final report: quote this output for Justin, including the handoff block, and stop.',
  'Do not run thread handoff again: this session is already handed off.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

// ---------------------------------------------------------------------------
// Pure parts: the name, the claude line, the cmux argv, the parse
// ---------------------------------------------------------------------------

/**
 * "[TAG] <session title>", cut to SUCCESSOR_NAME_LIMIT characters
 * (home-base-mbnjv.3 item 6): the repo TAG resolved the way workspace naming
 * and the inbox resolve it (sessionRepoOf, then resolveRepoTag from the
 * session's own checkout), so the successor's --name, --remote-control name,
 * its tab title and the workspace name all start with the same tag.
 */
export function successorName(session: FoundSession, env: EnvLike): string {
  const repo = sessionRepoOf({
    beadsDir: session.beadsDir,
    checkoutPath: session.checkoutPath,
    sightings: session.sightings,
  });
  return sessionName(
    resolveRepoTag({checkout: session.checkoutPath, env, repo}),
    session.bead.title,
  );
}

/**
 * D7: `claude --permission-mode <m> --remote-control <name> --name <name>
 * [--model <m>] <kickoff>`. The kickoff is claude's positional prompt, so it
 * goes last; it is prose and never starts with "/" (kickoffText).
 */
export function successorClaudeWords(input: {
  kickoff: string;
  model: string | null;
  name: string;
  permissionMode: string;
}): string[] {
  const words = ['claude', '--permission-mode', input.permissionMode];
  words.push('--remote-control', input.name, '--name', input.name);
  if (input.model != null) words.push('--model', input.model);
  words.push(input.kickoff);
  return words;
}

/** The text new-surface types into the new tab's zsh: every word quoted. */
export function successorCommand(words: readonly string[]): string {
  return words.map(zshWord).join(' ');
}

/** C5: the new-surface arguments after the binary and --socket. */
export function newSurfaceArgs(input: {
  checkoutPath: string;
  command: string;
  paneId: string;
  workspaceId: string;
}): string[] {
  return [
    'new-surface',
    '--workspace',
    input.workspaceId,
    '--pane',
    input.paneId,
    '--working-directory',
    input.checkoutPath,
    '--command',
    input.command,
    '--focus',
    'false',
  ];
}

/** The new tab's refs, from "OK surface:306 pane:285 workspace:191". */
export interface NewSurfaceRefs {
  paneRef: string | null;
  surfaceRef: string;
  workspaceRef: string | null;
}

/**
 * Parse new-surface's answer (measured by the conductor 2026-10-29: "OK
 * surface:306 pane:285 workspace:191"). Without an OK and a surface ref the
 * tab is not proven to exist: null.
 */
export function parseNewSurface(stdout: string): NewSurfaceRefs | null {
  const line = stdout.trim().split('\n')[0] ?? '';
  if (!/^OK\s/u.test(line)) return null;
  const ref = (kind: string) =>
    new RegExp(`(?:^|\\s)(${kind}:\\S+)`, 'u').exec(line)?.[1] ?? null;
  const surfaceRef = ref('surface');
  if (surfaceRef == null) return null;
  return {paneRef: ref('pane'), surfaceRef, workspaceRef: ref('workspace')};
}

// ---------------------------------------------------------------------------
// The screen check (D7)
// ---------------------------------------------------------------------------

export type SuccessorScreenVerdict =
  | {kind: 'dialog'; label: string}
  | {kind: 'notYet'; why: string}
  | {kind: 'started'};

/**
 * One screen of the new tab. A dialog anywhere in its live region wins (a
 * trust or permission dialog replaces the input box). Claude Code's input
 * box, empty or showing its own suggestion, is "started". A box still holding
 * typed text is not: the kickoff may be sitting there unsent.
 */
export function classifySuccessorScreen(text: string): SuccessorScreenVerdict {
  const lines = screenLines(text);
  const dialog = dialogOnScreen(lines);
  if (dialog != null) return {kind: 'dialog', label: dialog};
  const box = findInputBox(lines);
  if (box == null) {
    return {kind: 'notYet', why: 'no Claude Code input box on the screen'};
  }
  if (box.draft !== '' && !box.suggested) {
    return {
      kind: 'notYet',
      why: 'the input box still holds text, so the kickoff may not have been submitted',
    };
  }
  return {kind: 'started'};
}

export type SuccessorScreen =
  | {kind: 'dialog'; label: string; text: string}
  | {kind: 'started'; text: string}
  | {
      kind: 'timedOut';
      /** The last screen read, or why the last read failed. */
      last: {kind: 'read'; text: string} | {kind: 'unreadable'; reason: string};
      waitedMs: number;
      why: string;
    };

/** Read the new tab until it shows a verdict or the time is up. Read-only. */
export async function waitForSuccessor(input: {
  clock: () => number;
  pollMs: number;
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  surfaceRef: string;
  timeoutMs: number;
  workspaceId: string;
}): Promise<SuccessorScreen> {
  const started = input.clock();
  const args = ['read-screen', '--workspace', input.workspaceId];
  args.push('--surface', input.surfaceRef);
  for (;;) {
    const call = await input.run(args);
    let why: string;
    let last: Extract<SuccessorScreen, {kind: 'timedOut'}>['last'];
    if (call.kind === 'ok') {
      const verdict = classifySuccessorScreen(call.stdout);
      if (verdict.kind === 'dialog') {
        return {kind: 'dialog', label: verdict.label, text: call.stdout};
      }
      if (verdict.kind === 'started') {
        return {kind: 'started', text: call.stdout};
      }
      why = verdict.why;
      last = {kind: 'read', text: call.stdout};
    } else {
      why = `the screen could not be read: ${call.reason}`;
      last = {kind: 'unreadable', reason: call.reason};
    }
    const waitedMs = input.clock() - started;
    if (waitedMs >= input.timeoutMs) {
      return {kind: 'timedOut', last, waitedMs, why};
    }
    await input.sleep(input.pollMs);
  }
}

/** A screen's lines, trailing blanks dropped, the last QUOTED_SCREEN_LINES, quoted. */
export function quoteScreen(text: string): string[] {
  const lines = screenLines(text);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '') === '') end -= 1;
  const shown = lines.slice(Math.max(0, end - QUOTED_SCREEN_LINES), end);
  return shown.map((line) => `  │ ${line}`);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface ThreadHandoffCommandOptions {
  cwd?: string;
  /** --dry-run: knob on only. */
  dryRun: boolean;
  env?: EnvLike;
  /** --model for the successor: knob on only. */
  model: string | null;
  note: string | null;
  now?: Date;
  /** --session, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  style?: OutputStyle;
  /** --to: the successor already exists; link only. */
  to: string | null;
}

/** The gate as handoffWithSuccessor calls it; injected in tests. */
export type HandoffGateRunner = (input: {
  cwd: string;
  env: EnvLike;
  limits: ResolvedHandoffConfig;
  now: Date;
  session: FoundSession;
}) => Promise<HandoffGateResult>;

export interface HandoffSuccessorDeps {
  /** The screen check's clock, in ms. */
  clock: () => number;
  gate: HandoffGateRunner;
  handOff: typeof handOff;
  /** F11: the launch record on the caller's bead, before new-surface. */
  recordLaunch: typeof recordLaunch;
  recordRefusal: typeof recordRefusal;
  /** Every cmux call: the pane lookup, new-surface, read-screen. */
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  /**
   * mbnjv.4: start the detached watcher that exits or closes the caller's
   * tab after the handshake. Never called when the mode is keep.
   */
  startWatcher: (watch: PredecessorWatch, env: EnvLike) => WatcherStart;
  /** The screen check's limits (tests shorten them). */
  successorPollMs: number;
  successorTimeoutMs: number;
}

/** What a started successor is: both tabs, for the post-launch steps. */
export interface SuccessorLaunch {
  blockPath: string;
  /** The tab that ran thread handoff: CMUX_SURFACE_ID and its pane. */
  caller: {paneId: string; surfaceId: string; workspaceId: string};
  name: string;
  /** The new tab, as new-surface named it. */
  successor: NewSurfaceRefs;
}

/** 0 started · 1 a step failed after the handoff · 2 nothing written · 3 refused by the gate. */
export interface ThreadHandoffResult {
  exitCode: 0 | 1 | 2 | 3;
  /** Set when a successor tab was opened (exit 0, or exit 1 after the screen check). */
  launch: SuccessorLaunch | null;
  lines: string[];
}

function refuse(text: string): ThreadHandoffResult {
  return {
    exitCode: 2,
    launch: null,
    lines: [`thread handoff: refused: ${text}`],
  };
}

/** The real gate: runHandoffGate with the knob's limits and the real readers. */
export const realHandoffGate: HandoffGateRunner = (input) =>
  runHandoffGate({
    env: input.env,
    limits: input.limits,
    now: input.now,
    readers: realHandoffGateReaders({
      // F14: the CLI's own words, the half of the guard pass it must match.
      commandWords: process.argv.slice(2),
      cwd: input.cwd,
      env: input.env,
      fallbackDbs: [input.session.db],
      sessionBeadId: input.session.bead.id,
      sessionCheckoutPath: input.session.checkoutPath,
      sessionDb: input.session.db,
    }),
  });

function realDeps(env: EnvLike): HandoffSuccessorDeps {
  return {
    clock: () => Date.now(),
    gate: realHandoffGate,
    handOff,
    recordLaunch,
    recordRefusal,
    run: liveCmuxRunner(env),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    startWatcher: startPredecessorWatch,
    successorPollMs: SUCCESSOR_POLL_MS,
    successorTimeoutMs: SUCCESSOR_TIMEOUT_MS,
  };
}

/** What happens to the caller's tab, in words (mbnjv.4: exit or close). */
function oldTabPlanWords(mode: 'close' | 'exit'): string {
  const what =
    mode === 'exit'
      ? 'Claude Code here exits and the tab shows a tombstone'
      : 'this tab closes';
  return `${what} once the successor has linked and this session has stopped with nobody typing since; a detached watcher checks, and after ${Math.round(PREDECESSOR_TIMEOUT_MS / 60_000)} min it gives up and keeps the tab`;
}

/** The cmux argv as it would run, for the dry run and the failure messages. */
function fullCmuxArgv(env: EnvLike, args: readonly string[]): string[] {
  const socket = liveSocketPath(env);
  const cmuxEnv = 'path' in socket ? {CMUX_SOCKET_PATH: socket.path} : {};
  return [resolveCmuxBinary(env).path, ...cmuxArgv(cmuxEnv, args)];
}

/**
 * The knob-on path. Exported for tests and for the post-launch steps of
 * mbnjv.3 and mbnjv.4; the CLI reaches it through threadHandoffCommand.
 */
export async function handoffWithSuccessor(
  options: ThreadHandoffCommandOptions & {limits: ResolvedHandoffConfig},
  deps: Partial<HandoffSuccessorDeps> = {},
): Promise<ThreadHandoffResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const d = {...realDeps(env), ...deps};
  const style = options.style ?? outputStyle();
  const indent = stepColumn(0);

  // ---- 1. refusals: nothing is written before these pass ----
  const own = env.CLAUDE_CODE_SESSION_ID ?? '';
  const asked = options.sessionId?.trim() ?? '';
  if (asked !== '' && asked !== own) {
    return refuse(
      `--session ${asked} is not the session this runs in (${own === '' ? 'CLAUDE_CODE_SESSION_ID is not set' : own}). With componentConfig.thread.handoff.successor on, the successor opens beside the caller's own tab, so thread handoff hands off only the session it runs in. Nothing was written.`,
    );
  }
  const model = options.model == null ? null : options.model.trim();
  if (model === '') return refuse('--model needs a model name');
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return refuse(knob.reason);
  const selected = selectSession({env, selector: null, sessionIdOption: null});
  if (selected.kind === 'checkoutMissing') {
    return refuse(`this session's checkout ${selected.checkoutPath} is gone`);
  }
  if (selected.kind !== 'found') return refuse(selected.reason);
  const {session} = selected;

  // ---- the plan: every path and word, before anything is written ----
  const blockPath = join(
    threadsStateDir(env),
    'handoffs',
    `${session.sessionId}.md`,
  );
  const name = successorName(session, env);
  const kickoff = kickoffText(blockPath, session.bead.id, null);
  const words = successorClaudeWords({
    kickoff,
    model,
    name,
    permissionMode: options.limits.permissionMode,
  });
  const command = successorCommand(words);

  // ---- 2. the gate ----
  const gate = await d.gate({
    cwd,
    env,
    limits: options.limits,
    now,
    session,
  });

  if (options.dryRun) {
    const fields: Field[] = [
      {
        label: 'Gate',
        value:
          gate.kind === 'pass'
            ? 'passed'
            : `would refuse: ${gate.reason}: ${gate.detail}`,
      },
      {label: 'Session bead', value: session.bead.id},
      {label: 'Block file', value: blockPath},
      {label: 'Successor name', value: name},
    ];
    const workspaceId = env.CMUX_WORKSPACE_ID ?? '';
    const surfaceId = env.CMUX_SURFACE_ID ?? '';
    let argvText: string;
    if (gate.kind === 'refused') {
      argvText = 'none: the gate refuses, so nothing would open';
    } else if (workspaceId === '' || surfaceId === '') {
      argvText = 'none: not in a cmux pane';
    } else {
      const pane = await readPaneOfSurface(d.run, workspaceId, surfaceId);
      argvText =
        pane.kind === 'found'
          ? JSON.stringify(
              fullCmuxArgv(
                env,
                newSurfaceArgs({
                  checkoutPath: session.checkoutPath,
                  command,
                  paneId: pane.paneId,
                  workspaceId,
                }),
              ),
            )
          : `none: this tab's pane was not found, so a real run would stop (${pane.reason})`;
    }
    fields.push({label: 'cmux argv', value: argvText});
    if (options.limits.predecessor !== 'keep') {
      fields.push({
        label: 'Old tab when done',
        value: `${oldTabPlanWords(options.limits.predecessor)} (no watcher is started by a dry run)`,
      });
    }
    fields.push({label: 'Kickoff', value: kickoff});
    return {
      exitCode: 0,
      launch: null,
      lines: [
        sectionHeader('Dry run: nothing written or opened', {
          color: style.color,
          emoji: '🔎',
        }),
        '',
        fieldLines(fields, {...style, indent}),
      ],
    };
  }

  // ---- 2a. the call ran inside the sandbox: a CALL error, not a gate
  // decision (home-base-mbnjv.9 design 3, fix-round F9). Exit 2, nothing
  // written: no handoff, no refusal recorded, so the corrected call can run.
  if (gate.kind === 'refused' && gate.ranInSandbox) {
    return {
      exitCode: 2,
      launch: null,
      lines: [
        `thread handoff: refused: ${gate.detail}. Nothing was written.`,
        '',
        ...SANDBOXED_CALL_INSTRUCTIONS,
      ],
    };
  }

  // ---- 2b. refused: the handoff is still recorded, nothing opens (C2) ----
  if (gate.kind === 'refused') {
    const lines: string[] = [];
    const handed = await d.handOff({
      cwd,
      env,
      note: options.note,
      now,
      sessionId: null,
      to: null,
    });
    if (handed.kind === 'failed') {
      lines.push(
        `⚠️ The handoff itself was NOT recorded: ${handed.reason}`,
        '',
      );
    } else {
      if (handed.block !== '') lines.push(handed.block, '');
      for (const failure of handed.followUpFailures) {
        lines.push(`⚠️ The session WAS marked handed off, but: ${failure}`);
      }
      if (handed.followUpFailures.length > 0) lines.push('');
    }
    const recorded = d.recordRefusal({
      beadId: session.bead.id,
      db: session.db,
      detail: gate.detail,
      env,
      now,
      reason: gate.reason,
    });
    lines.push(
      recorded.kind === 'recorded'
        ? `Recorded on ${session.bead.id}: ${recorded.line}`
        : `⚠️ ${recorded.reason}`,
      '',
      gate.message,
    );
    return {exitCode: 3, launch: null, lines};
  }

  // ---- 3. the caller's pane, read-only ----
  const workspaceId = gate.facts.workspaceId;
  const surfaceId = gate.facts.surfaceId;
  if (workspaceId == null || surfaceId == null) {
    return refuse(
      'the gate passed without a cmux pane (CMUX_WORKSPACE_ID or CMUX_SURFACE_ID is not set); nothing was written',
    );
  }
  const pane = await readPaneOfSurface(d.run, workspaceId, surfaceId);
  if (pane.kind !== 'found') {
    return refuse(
      `this tab's pane could not be found, so there is nowhere to open the successor: ${pane.reason}. Nothing was written.`,
    );
  }

  // ---- 4. the handoff, then the block file ----
  const handed = await d.handOff({
    cwd,
    env,
    note: options.note,
    now,
    sessionId: null,
    to: null,
  });
  if (handed.kind === 'failed') {
    return {
      exitCode: 1,
      launch: null,
      lines: [
        `thread handoff: failed: ${handed.reason}. No successor was started.`,
      ],
    };
  }
  const blockLines = handed.block === '' ? [] : ['', handed.block];
  const failed = (text: string, extra: string[] = []): ThreadHandoffResult => ({
    exitCode: 1,
    launch: null,
    lines: [
      `thread handoff: failed: ${text}`,
      ...extra,
      ...blockLines,
      '',
      ...HANDOFF_STEP_FAILED_INSTRUCTIONS,
    ],
  });
  if (handed.block === '' || handed.followUpFailures.length > 0) {
    return failed(
      `the session WAS marked handed off, but: ${handed.followUpFailures.join('; ')}. No successor was started.`,
    );
  }
  try {
    mkdirSync(join(blockPath, '..'), {recursive: true});
    writeFileSync(blockPath, `${handed.block}\n`);
  } catch (error) {
    return failed(
      `writing ${blockPath} (the session WAS handed off; no successor was started): ${String(error)}`,
    );
  }

  // ---- 4b. F11: the launch record, BEFORE new-surface, so a second
  // handoff from this session is refused (alreadyHandedOff) even when this
  // one ends in exit 1 with its tab running. Not written: nothing opens.
  const launched = d.recordLaunch({
    beadId: session.bead.id,
    db: session.db,
    env,
    now,
    text: `from tab ${surfaceId} into pane ${pane.paneId} of workspace ${workspaceId}, successor "${name}"`,
  });
  if (launched.kind === 'failed') {
    return failed(
      `the launch record could not be written (${launched.reason}), so a second handoff could not be stopped; no successor was started. The session WAS handed off; the block is in ${blockPath}.`,
    );
  }

  // ---- 5. the successor's tab ----
  const args = newSurfaceArgs({
    checkoutPath: session.checkoutPath,
    command,
    paneId: pane.paneId,
    workspaceId,
  });
  const opened = await d.run(args);
  const refs = opened.kind === 'ok' ? parseNewSurface(opened.stdout) : null;
  if (refs == null) {
    const cmux =
      opened.kind === 'failed'
        ? opened.reason
        : `cmux printed ${JSON.stringify(opened.stdout.trim())}`;
    return failed(
      `starting the successor (the session WAS handed off; the block is in ${blockPath}; no tab was confirmed): ${cmux}`,
    );
  }
  const launch: SuccessorLaunch = {
    blockPath,
    caller: {paneId: pane.paneId, surfaceId, workspaceId},
    name,
    successor: refs,
  };

  // ---- 6. the screen check: report a dialog, never answer it ----
  const screen = await waitForSuccessor({
    clock: d.clock,
    pollMs: d.successorPollMs,
    run: d.run,
    sleep: d.sleep,
    surfaceRef: refs.surfaceRef,
    timeoutMs: d.successorTimeoutMs,
    workspaceId,
  });
  if (screen.kind === 'dialog') {
    return {
      ...failed(
        `the successor tab ${refs.surfaceRef} ("${name}") is waiting on ${screen.label}. Nothing was answered and no key was sent: Justin answers it on the Mac. The session WAS handed off; the block is in ${blockPath}. The screen:`,
        ['', ...quoteScreen(screen.text)],
      ),
      launch,
    };
  }
  if (screen.kind === 'timedOut') {
    const seconds = Math.round(screen.waitedMs / 1000);
    const last =
      screen.last.kind === 'read'
        ? ['', 'The last screen:', '', ...quoteScreen(screen.last.text)]
        : [];
    return {
      ...failed(
        `could not confirm the successor started within ${seconds} s (tab ${refs.surfaceRef}, "${name}"): ${screen.why}. The session WAS handed off; the block is in ${blockPath}.`,
        last,
      ),
      launch,
    };
  }

  // ---- (post-launch steps of mbnjv.3 / mbnjv.4 go here) ----

  // 7. mbnjv.3 (D8, C7): mark the caller's own tab handed off. The surface is
  // CMUX_SURFACE_ID as the gate read it, never the successor's or a guess. A
  // failed mark is cosmetic: the successor started, so the exit stays 0.
  const mark = handedOffTabTitle(name);
  const marked = await renameTab(d.run, workspaceId, surfaceId, mark);
  const fields: Field[] = [
    {label: 'Block file', value: blockPath},
    {label: 'Successor tab', value: `${refs.surfaceRef} "${name}"`},
    {
      label: 'This tab',
      value:
        marked.kind === 'ok'
          ? `renamed "${mark}"`
          : `⚠️ not marked handed off: ${marked.reason}`,
    },
    {label: 'Workspace', value: workspaceId},
  ];

  // 8. mbnjv.4 (D6, C6): exit or close the caller's own tab, but only from a
  // detached watcher and only after the handshake. keep starts nothing. The
  // tab is CMUX_SURFACE_ID as the gate read it (surfaceId above), never the
  // successor's or a lookup. A watcher that does not start keeps the tab
  // (the cautious side) and is said here and on the bead; the exit stays 0.
  const mode = options.limits.predecessor;
  const successorTab =
    mode === 'keep'
      ? null
      : await readSurfaceIdOfRef(d.run, workspaceId, refs.surfaceRef);
  if (
    mode !== 'keep' &&
    successorTab != null &&
    successorTab.kind !== 'found'
  ) {
    // F10 + F6: without the new tab's uuid the successor's link cannot be
    // verified, and the tombstone would need an unmeasured focus command. No
    // watcher: the tab is kept, and that is said here and on the bead.
    const why = `the new tab's id could not be read (${successorTab.reason}), so the successor's link could not be verified and no focus command could be written`;
    const text = `predecessor kept: no watcher was started: ${why}`;
    const noted = appendSessionNote({
      beadId: session.bead.id,
      db: session.db,
      env,
      now,
      text,
    });
    appendPredecessorLog(predecessorLogPath(env), {
      at: now.toISOString(),
      beadId: session.bead.id,
      detail: text,
      event: 'startFailed',
      mode,
      note: noted.kind === 'recorded' ? 'recorded' : noted.reason,
      sessionId: session.sessionId,
      surfaceId,
      workspaceId,
    });
    fields.push({
      label: 'Old tab when done',
      value: `⚠️ kept: ${why}${noted.kind === 'recorded' ? '' : ` (and not noted on ${session.bead.id}: ${noted.reason})`}`,
    });
  } else if (mode !== 'keep' && successorTab?.kind === 'found') {
    const focusCommand = focusCommandOf(successorTab.surfaceId, workspaceId);
    const watch: PredecessorWatch = {
      caller: {
        beadId: session.bead.id,
        db: session.db,
        sessionId: session.sessionId,
        surfaceId,
        workspaceId,
      },
      handedOffAt: now.toISOString(),
      logPath: predecessorLogPath(env),
      mode,
      pollMs: PREDECESSOR_POLL_MS,
      settleMs: PREDECESSOR_SETTLE_MS,
      successor: {
        name,
        surfaceId: successorTab.surfaceId,
        surfaceRef: refs.surfaceRef,
      },
      timeoutMs: PREDECESSOR_TIMEOUT_MS,
      tombstone: tombstoneLines({
        focusCommand,
        handedOffAt: now,
        sessionId: session.sessionId,
        successorName: name,
      }),
    };
    const started = d.startWatcher(watch, env);
    if (started.kind === 'started') {
      // F19: the bead says a watcher runs, so one that dies before any
      // outcome still left a trace; a failed `started` log line is named.
      const noted = appendSessionNote({
        beadId: session.bead.id,
        db: session.db,
        env,
        now,
        text: watcherStartedNote({
          logError: started.logError,
          logPath: watch.logPath,
          mode,
          pid: started.pid,
          successorSurfaceId: successorTab.surfaceId,
        }),
      });
      const problems = [
        ...(started.logError == null
          ? []
          : [`the started line was NOT logged: ${started.logError}`]),
        ...(noted.kind === 'recorded'
          ? []
          : [`not noted on ${session.bead.id}: ${noted.reason}`]),
      ];
      fields.push({
        label: 'Old tab when done',
        value: `${oldTabPlanWords(mode)} (watcher pid ${started.pid ?? '?'}; log ${watch.logPath})${problems.length === 0 ? '' : ` ⚠️ ${problems.join('; ')}`}`,
      });
    } else {
      const text = `predecessor kept: the watcher did not start: ${started.reason}`;
      const noted = appendSessionNote({
        beadId: session.bead.id,
        db: session.db,
        env,
        now,
        text,
      });
      appendPredecessorLog(watch.logPath, {
        at: now.toISOString(),
        beadId: session.bead.id,
        detail: text,
        event: 'startFailed',
        mode,
        note: noted.kind === 'recorded' ? 'recorded' : noted.reason,
        sessionId: session.sessionId,
        surfaceId,
        workspaceId,
      });
      fields.push({
        label: 'Old tab when done',
        value: `⚠️ kept: the watcher that would ${mode === 'exit' ? 'exit' : 'close'} it did not start: ${started.reason}${noted.kind === 'recorded' ? '' : ` (and not noted on ${session.bead.id}: ${noted.reason})`}`,
      });
    }
  }
  return {
    exitCode: 0,
    launch,
    lines: [
      sectionHeader('Successor started', {color: style.color, emoji: '🤝'}),
      '',
      fieldLines(fields, {...style, indent}),
      '',
      SUCCESSOR_STARTED_NEXT,
    ],
  };
}

/**
 * `thread handoff`, routed by the knob (D10). OFF: today's handOff() and
 * describeHandoffOutcome(), untouched. ON: --to links only, as today; every
 * other call goes through handoffWithSuccessor.
 */
export async function threadHandoffCommand(
  options: ThreadHandoffCommandOptions,
  deps: Partial<HandoffSuccessorDeps> = {},
): Promise<ThreadHandoffResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // Behind an await import: config pulls in zod (command.ts's header).
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  const {handoff} = config;
  const to = options.to?.trim() ?? '';

  if (!handoff.successor) {
    // A problem that names the knob may be why it reads as off; nothing else
    // is printed, so a clean config prints exactly what it did before.
    const problems = config.problems
      .filter((problem) => problem.includes('thread.handoff'))
      .map((problem) => `⚠️ config: ${problem}`);
    if (options.dryRun || options.model != null) {
      const flag = options.dryRun ? '--dry-run' : '--model';
      return {
        exitCode: 2,
        launch: null,
        lines: [
          ...problems,
          `thread handoff: refused: ${flag} needs componentConfig.thread.handoff.successor on (it is off, resolved from: ${handoff.successorSource}). Nothing was written.`,
        ],
      };
    }
    const outcome = await (deps.handOff ?? handOff)({
      cwd: options.cwd,
      env: options.env,
      note: options.note,
      now: options.now,
      sessionId: options.sessionId,
      to: options.to,
    });
    const described = describeHandoffOutcome(outcome);
    return {
      exitCode: described.exitCode,
      launch: null,
      lines: [...problems, ...described.lines],
    };
  }

  const problems = config.problems.map((problem) => `⚠️ config: ${problem}`);
  if (to !== '') {
    if (options.dryRun || options.model != null) {
      return {
        exitCode: 2,
        launch: null,
        lines: [
          ...problems,
          'thread handoff: refused: --to links a successor that already exists, so --dry-run and --model do not apply. Nothing was written.',
        ],
      };
    }
    const outcome = await (deps.handOff ?? handOff)({
      cwd: options.cwd,
      env: options.env,
      note: options.note,
      now: options.now,
      sessionId: options.sessionId,
      to: options.to,
    });
    const described = describeHandoffOutcome(outcome);
    return {
      exitCode: described.exitCode,
      launch: null,
      lines: [...problems, ...described.lines],
    };
  }
  const result = await handoffWithSuccessor(
    {...options, limits: handoff},
    deps,
  );
  return {...result, lines: [...problems, ...result.lines]};
}

export async function runThreadHandoffCommand(
  options: ThreadHandoffCommandOptions,
): Promise<number> {
  const {exitCode, lines} = await threadHandoffCommand(options);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
