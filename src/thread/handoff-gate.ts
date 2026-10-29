/**
 * The handoff gate (epic home-base-mbnjv D2; built by home-base-mbnjv.1 item
 * 6): every check that must pass before `thread handoff` starts a successor,
 * as ONE function over injected readers, so each refusal reason is a unit
 * test with no cmux, no claude and no real state dir.
 *
 * It answers `pass` or `refused` with a reason, a detail and the message the
 * caller prints. Calling it from `thread handoff` / `thread spawn`, exit code
 * 3 and the cmux launch are home-base-mbnjv.2.
 *
 * ORDER: fixed, first refusal wins, cheapest first. The kill switch (one
 * lstat), the session guard's registration (a few small JSON files,
 * home-base-mbnjv.5), the cmux pane env, the cmux ping, the usage history (one file),
 * the chain (br calls), the live sessions (ps, the cmux tree and screens,
 * `claude agents --json`).
 *
 * CRITICAL RULE 7, the reassuring direction is the dangerous one: every
 * reader that cannot answer refuses (usageUnknown, chainUnknown,
 * liveSessionsUnknown), and a reader that THROWS refuses with its own
 * reason. Nothing unknown ever passes.
 */

import type {SamplesRead} from '../claude-usage-samples';
import type {GuardPassRead} from './guard-pass';
import type {GuardRegistration} from './guard-registration';
import type {UnattendedChain} from './handoff-chain';
import type {ResolvedHandoffConfig} from './handoff-knob';
import type {LiveSessionCount, LiveSessionCountRead} from './live-count';
import type {ScreenRead} from './pane-join';
import type {EnvLike} from './paths';

import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {brShow, brUpdate, describeBrFailed} from '../beads/br';
import {readSamples, samplesPath} from '../claude-usage-samples';
import {SDK_BIN_BY_PATH} from '../sdk-invocation';
import {oneLine} from './ask-format';
import {realCmuxRunner} from './cmux';
import {consumeGuardPass, describeGuardPass} from './guard-pass';
import {
  describeGuardNotRegistered,
  guardRegistration,
} from './guard-registration';
import {realChainReaders, walkUnattendedChain} from './handoff-chain';
import {countLiveSessions, describeLiveSessionCount} from './live-count';
import {readLiveSessions, realLiveSessionDeps} from './live-sessions';
import {statusLineIdOf} from './pane-join';
import {threadsStateDir} from './paths';
import {liveSocketPath} from './respawn';
import {HANDOFF_REFUSED_LABEL, SUCCESSOR_STARTED_LABEL} from './session-bead';
import {appendNote} from './session-marks';

// ---------------------------------------------------------------------------
// Reasons and the message
// ---------------------------------------------------------------------------

/**
 * Every reason a handoff is refused, in the order the gate checks them.
 * `subagent` is the exception: the session guard (session-guard.ts,
 * home-base-mbnjv.5) refuses a subagent's thread handoff before the command
 * runs, and records it with this reason; the gate never produces it.
 */
export const HANDOFF_REFUSAL_REASONS = [
  'subagent',
  'killSwitch',
  'guardNotRegistered',
  'guardNotSeen',
  'alreadyHandedOff',
  'notInCmuxPane',
  'cmuxUnreachable',
  'usageUnknown',
  'usageHigh',
  'chainUnknown',
  'tooManyUnattendedHandoffs',
  'liveSessionsUnknown',
  'tooManyLiveSessions',
] as const;

export type HandoffRefusalReason = (typeof HANDOFF_REFUSAL_REASONS)[number];

/**
 * What every refusal tells the calling Claude, after its reason (D2, Justin
 * 2026-10-29: "claude knows what to do, and claude doesn't try to hack
 * around it").
 */
export const HANDOFF_REFUSAL_INSTRUCTIONS = [
  'No successor was started.',
  'This refusal is final: do not retry the handoff and do not work around it.',
  'Finish your final report, include the handoff block printed above for Justin, and stop.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

/** The full message one refusal prints: its reason line, then the instructions. */
export function handoffRefusalMessage(
  reason: HandoffRefusalReason,
  detail: string,
): string {
  return [
    `handoff refused: ${reason}: ${detail}`,
    '',
    ...HANDOFF_REFUSAL_INSTRUCTIONS,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

/** `<threads state dir>/handoff-off`: present refuses every handoff (C1). */
export const HANDOFF_KILL_SWITCH_FILE = 'handoff-off';

export function killSwitchPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), HANDOFF_KILL_SWITCH_FILE);
}

export type KillSwitchRead =
  | {kind: 'off'; path: string}
  | {kind: 'on'; path: string; reason: string};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Present means on, whatever it holds; its trimmed text is the reason, and an
 * empty file says "the kill switch file exists". A path that cannot be
 * checked (anything but "does not exist") reads as ON: an unknown switch is
 * never "off" (rule 7).
 */
export function readKillSwitch(env: EnvLike = process.env): KillSwitchRead {
  const path = killSwitchPath(env);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {kind: 'off', path};
    }
    return {
      kind: 'on',
      path,
      reason: `the kill switch could not be checked: ${errorText(error)}`,
    };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    return {
      kind: 'on',
      path,
      reason: `the kill switch file exists (its text could not be read: ${errorText(error)})`,
    };
  }
  return {
    kind: 'on',
    path,
    reason: text === '' ? 'the kill switch file exists' : oneLine(text),
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** The gate's usage limits: the usage block of the knob, sources not needed. */
export type HandoffUsageLimits = Pick<
  ResolvedHandoffConfig['usage'],
  'maxSampleAgeMinutes' | 'maxSessionPercent' | 'maxWeekPercent'
>;

/** What the newest sample said, when it passed. */
export interface HandoffUsageFacts {
  ageMinutes: number;
  sampledAt: string;
  sessionPercent: number;
  weekPercent: number;
}

/** A sample dated more than this far in the future is not trusted. */
const FUTURE_TOLERANCE_MINUTES = 5;

export type UsageCheck =
  | {facts: HandoffUsageFacts; ok: true}
  | {detail: string; ok: false; reason: 'usageHigh' | 'usageUnknown'};

/**
 * The newest sample of the hourly /usage history (never a live /usage read:
 * home-base-iqdmz). Missing history, an unreadable one, no samples, a failed
 * newest sample, or one older than the limit: usageUnknown.
 */
export function checkUsage(
  read: SamplesRead,
  limits: HandoffUsageLimits,
  now: Date,
): UsageCheck {
  const unknown = (detail: string): UsageCheck => ({
    detail,
    ok: false,
    reason: 'usageUnknown',
  });
  if (read.kind === 'missing') {
    return unknown(
      `there is no usage history at ${read.path} (the hourly claude-usage-sample chore writes it)`,
    );
  }
  if (read.kind === 'failed') {
    return unknown(`the usage history could not be read: ${read.reason}`);
  }
  // F20 (home-base-mbnjv.8): an unreadable LAST line may be the newest
  // sample; an older one is not used in its place.
  if (read.lastLineUnreadable) {
    const last = read.unreadable.at(-1);
    return unknown(
      `the newest line of the usage history (${read.path}${last == null ? '' : ` line ${last.line}`}) could not be read${last == null ? '' : `: ${last.reason}`}; an older sample is not used in its place`,
    );
  }
  const newest = read.samples.at(-1);
  if (newest == null) {
    return unknown(
      `the usage history at ${read.path} holds no readable sample${read.unreadable.length > 0 ? ` (${read.unreadable.length} unreadable line${read.unreadable.length === 1 ? '' : 's'})` : ''}`,
    );
  }
  if (!newest.ok) {
    return unknown(
      `the newest usage sample (${newest.sampledAt}) is a failed read: ${newest.reason}`,
    );
  }
  const ageMinutes = (now.getTime() - Date.parse(newest.sampledAt)) / 60_000;
  if (ageMinutes < -FUTURE_TOLERANCE_MINUTES) {
    return unknown(
      `the newest usage sample is dated ${newest.sampledAt}, in the future`,
    );
  }
  if (ageMinutes > limits.maxSampleAgeMinutes) {
    return unknown(
      `the newest usage sample is ${Math.round(ageMinutes)} minutes old (${newest.sampledAt}), older than the ${limits.maxSampleAgeMinutes}-minute limit`,
    );
  }
  const over: string[] = [];
  if (newest.session.pct > limits.maxSessionPercent) {
    over.push(
      `the 5-hour session window is at ${newest.session.pct} % (ceiling ${limits.maxSessionPercent} %)`,
    );
  }
  if (newest.week.pct > limits.maxWeekPercent) {
    over.push(
      `the week window is at ${newest.week.pct} % (ceiling ${limits.maxWeekPercent} %)`,
    );
  }
  // F2 (home-base-mbnjv.8): each per-model weekly window has the same ceiling.
  for (const [model, window] of Object.entries(newest.weekByModel)) {
    if (window.pct > limits.maxWeekPercent) {
      over.push(
        `the ${model} week window is at ${window.pct} % (ceiling ${limits.maxWeekPercent} %)`,
      );
    }
  }
  if (over.length > 0) {
    return {
      detail: `${over.join(' and ')}, sampled ${newest.sampledAt}`,
      ok: false,
      reason: 'usageHigh',
    };
  }
  return {
    facts: {
      ageMinutes,
      sampledAt: newest.sampledAt,
      sessionPercent: newest.session.pct,
      weekPercent: newest.week.pct,
    },
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type CmuxPing = {kind: 'failed'; reason: string} | {kind: 'ok'};

/**
 * F11: has this session already started a successor? `started` carries what
 * says so (the label and the launch note).
 */
export type LaunchRecordRead =
  | {detail: string; kind: 'started'}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'};

/** Every reader the gate calls. Sync or async; a throw refuses. */
export interface HandoffGateReaders {
  /**
   * F16: the caller's own tab's screen (`cmux read-screen` of
   * CMUX_SURFACE_ID), whose status line must show CLAUDE_CODE_SESSION_ID.
   * Read only when requireCmuxPane is not false.
   */
  callerScreen: () => Promise<ScreenRead> | ScreenRead;
  /**
   * The chain walk, or null to skip the unattended-handoff count: `thread
   * spawn` runs the gate without it (epic C4), because a spawn starts no
   * chain.
   */
  chain: (() => Promise<UnattendedChain> | UnattendedChain) | null;
  /**
   * Is the PreToolUse session guard registered for this session
   * (guard-registration.ts, home-base-mbnjv.5)? Anything but `registered`
   * refuses: fail closed.
   */
  guard: () => GuardRegistration | Promise<GuardRegistration>;
  /**
   * F14: read AND delete the guard's one-time pass for this call
   * (guard-pass.ts). Anything but `valid` refuses (guardNotSeen).
   */
  guardPass: () => GuardPassRead | Promise<GuardPassRead>;
  killSwitch: () => KillSwitchRead | Promise<KillSwitchRead>;
  /**
   * F11: the caller's launch record, or null to skip (`thread spawn` starts
   * no successor).
   */
  launchRecord: (() => LaunchRecordRead | Promise<LaunchRecordRead>) | null;
  liveSessions: () => LiveSessionCountRead | Promise<LiveSessionCountRead>;
  pingCmux: () => CmuxPing | Promise<CmuxPing>;
  usage: () => Promise<SamplesRead> | SamplesRead;
}

/** The knob values the gate enforces. A ResolvedHandoffConfig fits. */
export interface HandoffGateLimits {
  maxLiveSessions: number;
  maxUnattendedHandoffs: number;
  usage: HandoffUsageLimits;
}

export interface HandoffGateInput {
  /** The caller's environment: CMUX_WORKSPACE_ID and CMUX_SURFACE_ID. */
  env: EnvLike;
  limits: HandoffGateLimits;
  now: Date;
  readers: HandoffGateReaders;
  /**
   * false skips notInCmuxPane: `thread spawn` opens a new workspace, so its
   * caller need not be in a pane (home-base-mbnjv.2, epic C4). Default true.
   */
  requireCmuxPane?: boolean;
}

/** What every check measured, when the gate passed. */
export interface HandoffGateFacts {
  chain: {kind: 'skipped'} | Extract<UnattendedChain, {kind: 'counted'}>;
  liveSessions: LiveSessionCount;
  /** CMUX_SURFACE_ID; null only when requireCmuxPane was false and it is unset. */
  surfaceId: string | null;
  usage: HandoffUsageFacts;
  /** CMUX_WORKSPACE_ID; null only when requireCmuxPane was false and it is unset. */
  workspaceId: string | null;
}

export type HandoffGateResult =
  | {facts: HandoffGateFacts; kind: 'pass'}
  | {
      detail: string;
      kind: 'refused';
      /** The reason line, then the instructions: print it as it is. */
      message: string;
      /**
       * True only for cmuxUnreachable when cmux answered "Operation not
       * permitted": the CALL ran inside the Claude Code sandbox, which is a
       * mistake in the call, not a gate decision (home-base-mbnjv.9 design 3).
       * `thread handoff` then exits 2 and writes nothing.
       */
      ranInSandbox: boolean;
      reason: HandoffRefusalReason;
    };

function refused(
  reason: HandoffRefusalReason,
  detail: string,
  ranInSandbox = false,
): Extract<HandoffGateResult, {kind: 'refused'}> {
  return {
    detail,
    kind: 'refused',
    message: handoffRefusalMessage(reason, detail),
    ranInSandbox,
    reason,
  };
}

/**
 * Does a failed cmux call's text say the sandbox denied it? The sandbox
 * refuses the cmux socket with EPERM, which cmux prints as "Operation not
 * permitted" (measured: live run 20261029T154357Z, "Failed to connect to
 * socket at …/cmux.sock (Operation not permitted, errno 1)").
 */
export function isSandboxDenial(text: string): boolean {
  return /Operation not permitted|\bEPERM\b/u.test(text);
}

/** What the gate says when the cmux ping failed. */
function cmuxUnreachable(
  why: string,
): Extract<HandoffGateResult, {kind: 'refused'}> {
  if (isSandboxDenial(why)) {
    return refused(
      'cmuxUnreachable',
      `this call ran inside the Claude Code sandbox, so it could not reach cmux (the socket answered Operation not permitted). Likely causes: the call did not start with \`${SDK_BIN_BY_PATH}\` (Claude Code never excludes a call that starts with bun), the call was not bare (a \`cd … &&\` prefix, a redirect or a $(…)), the note holds a backtick (measured: the one note character that keeps the by-path call inside the sandbox, home-base-mbnjv.10), or Justin's global sandbox exclusion for thread handoff is missing (doctor's HANDOFF_SANDBOX check). cmux said: ${why}`,
      true,
    );
  }
  return refused('cmuxUnreachable', `cmux could not be reached: ${why}`);
}

/** Run a reader; a throw becomes `{threw}` so its check can refuse. */
async function attempt<T>(
  read: () => Promise<T> | T,
): Promise<{threw: string} | {value: T}> {
  try {
    return {value: await read()};
  } catch (error) {
    return {threw: errorText(error)};
  }
}

/**
 * Every check, in order; the first refusal is the answer. The limits come
 * from componentConfig.thread.handoff (resolveThreadConfig().handoff).
 */
export async function runHandoffGate(
  input: HandoffGateInput,
): Promise<HandoffGateResult> {
  const {env, limits, now, readers} = input;

  // 1. The kill switch: machine-wide, whatever any config says.
  const kill = await attempt(readers.killSwitch);
  if ('threw' in kill) {
    return refused(
      'killSwitch',
      `the kill switch could not be checked: ${kill.threw}`,
    );
  }
  if (kill.value.kind === 'on') return refused('killSwitch', kill.value.reason);

  // 1b. The session guard is registered (home-base-mbnjv.5, epic C8). Without
  // it a subagent could hand off its parent and nothing would stop a raw
  // `claude --bg`, so the command opens nothing. Fail closed: unknown refuses.
  const guard = await attempt(readers.guard);
  if ('threw' in guard) {
    return refused(
      'guardNotRegistered',
      `whether the session guard is registered could not be checked: ${guard.threw}`,
    );
  }
  if (guard.value.kind !== 'registered') {
    return refused(
      'guardNotRegistered',
      describeGuardNotRegistered(guard.value),
    );
  }

  // 1c. F14: the guard saw THIS call. Registration proves an entry exists;
  // the one-time pass proves the guard ran and allowed it (it fails open on
  // a timeout, so the command must fail closed here).
  const pass = await attempt(readers.guardPass);
  if ('threw' in pass) {
    return refused(
      'guardNotSeen',
      `the guard pass could not be read: ${pass.threw}`,
    );
  }
  if (pass.value.kind !== 'valid') {
    return refused('guardNotSeen', describeGuardPass(pass.value));
  }

  // 1d. F11: one successor per session. A second handoff after exit 0, or
  // after an exit 1 whose tab may be running, would start a second successor
  // in the same checkout (the 1r6d.31 failure) and a second watcher.
  if (readers.launchRecord != null) {
    const record = await attempt(readers.launchRecord);
    const why =
      'threw' in record
        ? record.threw
        : record.value.kind === 'failed'
          ? record.value.reason
          : null;
    if (why != null) {
      return refused(
        'alreadyHandedOff',
        `whether this session already started a successor could not be checked: ${why}`,
      );
    }
    if ('value' in record && record.value.kind === 'started') {
      return refused(
        'alreadyHandedOff',
        `this session already started a successor (${record.value.detail}). Only one successor per session: Justin can start another by hand from the handoff block`,
      );
    }
  }

  // 2. In a cmux pane: the successor opens as a tab beside the caller's (D5).
  // `thread spawn` skips this (C4): it opens a workspace of its own.
  const workspaceId = env.CMUX_WORKSPACE_ID ?? '';
  const surfaceId = env.CMUX_SURFACE_ID ?? '';
  const missing = [
    workspaceId === '' ? 'CMUX_WORKSPACE_ID' : null,
    surfaceId === '' ? 'CMUX_SURFACE_ID' : null,
  ].filter((name): name is string => name != null);
  if (missing.length > 0 && input.requireCmuxPane !== false) {
    return refused(
      'notInCmuxPane',
      `this session is not in a cmux pane (${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set)`,
    );
  }

  // 3. cmux answers.
  const ping = await attempt(readers.pingCmux);
  if ('threw' in ping) return cmuxUnreachable(ping.threw);
  if (ping.value.kind === 'failed') return cmuxUnreachable(ping.value.reason);

  // 3b. F16: the tab CMUX_SURFACE_ID names shows THIS session. The CMUX_*
  // ids are inherited: a session started by `claude --bg`, or reattached in
  // another tab, can carry someone else's, and the successor would open
  // beside their tab. Unreadable refuses.
  if (input.requireCmuxPane !== false) {
    const own = env.CLAUDE_CODE_SESSION_ID ?? '';
    if (own === '') {
      return refused(
        'notInCmuxPane',
        `CLAUDE_CODE_SESSION_ID is not set, so tab ${surfaceId} cannot be proven to show this session`,
      );
    }
    const screen = await attempt(readers.callerScreen);
    const text =
      'threw' in screen
        ? null
        : screen.value.kind === 'read'
          ? screen.value.text
          : null;
    if (text == null) {
      const why =
        'threw' in screen
          ? screen.threw
          : screen.value.kind === 'unreadable'
            ? screen.value.reason
            : '?';
      return refused(
        'notInCmuxPane',
        `tab ${surfaceId}'s screen could not be read (${why}), so it is not proven to show this session ${own}`,
      );
    }
    const shown = statusLineIdOf(text);
    if (shown?.toLowerCase() !== own.toLowerCase()) {
      return refused(
        'notInCmuxPane',
        shown == null
          ? `tab ${surfaceId} (CMUX_SURFACE_ID) shows no session id on its status line, so it is not proven to show this session ${own}`
          : `tab ${surfaceId} (CMUX_SURFACE_ID) shows session ${shown}, not this session ${own}: the CMUX_* ids were inherited from another tab`,
      );
    }
  }

  // 4. Usage, from the hourly samples.
  const usageRead = await attempt(readers.usage);
  if ('threw' in usageRead) {
    return refused(
      'usageUnknown',
      `the usage history could not be read: ${usageRead.threw}`,
    );
  }
  const usage = checkUsage(usageRead.value, limits.usage, now);
  if (!usage.ok) return refused(usage.reason, usage.detail);

  // 5. Handoffs in a row since Justin last typed in the chain.
  let chain: HandoffGateFacts['chain'] = {kind: 'skipped'};
  if (readers.chain != null) {
    const walked = await attempt(readers.chain);
    if ('threw' in walked) {
      return refused(
        'chainUnknown',
        `the handoff chain could not be read: ${walked.threw}`,
      );
    }
    if (walked.value.kind === 'unknown') {
      return refused(
        'chainUnknown',
        `the handoff chain could not be read: ${walked.value.reason}`,
      );
    }
    if (walked.value.unattendedHandoffs >= limits.maxUnattendedHandoffs) {
      const last = walked.value.links.at(-1);
      return refused(
        'tooManyUnattendedHandoffs',
        `${walked.value.unattendedHandoffs} handoff${walked.value.unattendedHandoffs === 1 ? '' : 's'} in a row since Justin last typed in this chain (in ${last?.beadId ?? '?'}); the limit is ${limits.maxUnattendedHandoffs}`,
      );
    }
    chain = walked.value;
  }

  // 6. Live sessions on this machine.
  const live = await attempt(readers.liveSessions);
  if ('threw' in live) {
    return refused(
      'liveSessionsUnknown',
      `the live Claude sessions could not be counted: ${live.threw}`,
    );
  }
  if (live.value.kind === 'failed') {
    return refused(
      'liveSessionsUnknown',
      `the live Claude sessions could not be counted: ${live.value.reason}`,
    );
  }
  if (live.value.total >= limits.maxLiveSessions) {
    return refused(
      'tooManyLiveSessions',
      `${describeLiveSessionCount(live.value)}; the successor would make ${live.value.total + 1}, and the limit is ${limits.maxLiveSessions}`,
    );
  }

  return {
    facts: {
      chain,
      liveSessions: live.value,
      surfaceId: surfaceId === '' ? null : surfaceId,
      usage: usage.facts,
      workspaceId: workspaceId === '' ? null : workspaceId,
    },
    kind: 'pass',
  };
}

// ---------------------------------------------------------------------------
// The launch record (F11)
// ---------------------------------------------------------------------------

/** The note line the launch record writes, before `cmux new-surface`. */
export const LAUNCH_NOTE_PREFIX = 'successor launch started';

/** F11: the caller's bead carries SUCCESSOR_STARTED_LABEL, or not. */
export function readLaunchRecord(input: {
  beadId: string;
  db: string;
  env: EnvLike;
}): LaunchRecordRead {
  const shown = brShow({db: input.db, env: input.env}, input.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${input.beadId} could not be read: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {kind: 'failed', reason: `${input.beadId} is not in ${input.db}`};
  }
  if (!shown.issue.labels.includes(SUCCESSOR_STARTED_LABEL)) {
    return {kind: 'none'};
  }
  const note = (shown.issue.notes ?? '')
    .split('\n')
    .filter((line) => line.includes(LAUNCH_NOTE_PREFIX))
    .at(-1);
  return {
    detail: `${input.beadId} carries the ${SUCCESSOR_STARTED_LABEL} label${note == null ? '' : `; ${oneLine(note)}`}`,
    kind: 'started',
  };
}

/**
 * F11: label the caller's bead SUCCESSOR_STARTED_LABEL and note the launch,
 * BEFORE `cmux new-surface`, so a second handoff is refused even when this one
 * ends in exit 1 with its tab running. One br write.
 */
export function recordLaunch(input: {
  beadId: string;
  db: string;
  env: EnvLike;
  now: Date;
  text: string;
}): RecordRefusalOutcome {
  const shown = brShow({db: input.db, env: input.env}, input.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${input.beadId} could not be read: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {kind: 'failed', reason: `${input.beadId} is not in ${input.db}`};
  }
  const line = `${LAUNCH_NOTE_PREFIX}: ${oneLine(input.text)}`;
  const written = brUpdate({db: input.db, env: input.env}, input.beadId, {
    addLabels: [SUCCESSOR_STARTED_LABEL],
    notes: appendNote(shown.issue.notes, line, input.now),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${input.beadId} could not be written: ${describeBrFailed(written)}`,
    };
  }
  return {kind: 'recorded', line};
}

// ---------------------------------------------------------------------------
// The real readers
// ---------------------------------------------------------------------------

/**
 * The readers `thread handoff` runs the gate with (home-base-mbnjv.2 wires
 * them). `sessionBeadId` null builds the spawn gate's set, with no chain.
 */
export function realHandoffGateReaders(input: {
  /** The command's own words after the program (process.argv.slice(2)): F14. */
  commandWords: readonly string[];
  cwd: string;
  env: EnvLike;
  /** DBs to look the chain's beads up in after the sessions index. */
  fallbackDbs?: readonly string[];
  sessionBeadId: string | null;
  /**
   * The session's checkout from the sessions index, when known: the guard
   * must be registered there as well as at cwd (guard-registration.ts).
   */
  sessionCheckoutPath?: string | null;
  /** The session bead's DB, for the F11 launch record (null: spawn). */
  sessionDb?: string | null;
}): HandoffGateReaders {
  const {cwd, env, sessionBeadId} = input;
  const guardRoots = [
    cwd,
    ...(input.sessionCheckoutPath == null ? [] : [input.sessionCheckoutPath]),
  ];
  const socket = liveSocketPath(env);
  const cmuxEnv =
    'path' in socket
      ? {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path}
      : null;
  const runner = cmuxEnv == null ? null : realCmuxRunner(undefined, cmuxEnv);
  const sessionDb = input.sessionDb ?? null;
  return {
    callerScreen: async () => {
      if (runner == null) {
        return {
          kind: 'unreadable',
          reason: `no cmux socket: ${'reason' in socket ? socket.reason : '?'}`,
        };
      }
      const call = await runner([
        'read-screen',
        '--workspace',
        env.CMUX_WORKSPACE_ID ?? '',
        '--surface',
        env.CMUX_SURFACE_ID ?? '',
      ]);
      return call.kind === 'ok'
        ? {kind: 'read', text: call.stdout}
        : {kind: 'unreadable', reason: call.reason};
    },
    chain:
      sessionBeadId == null
        ? null
        : () =>
            walkUnattendedChain(
              sessionBeadId,
              realChainReaders({cwd, env, fallbackDbs: input.fallbackDbs}),
            ),
    guard: () => guardRegistration({env, roots: guardRoots}),
    guardPass: () =>
      consumeGuardPass({
        env,
        now: new Date(),
        sessionId: env.CLAUDE_CODE_SESSION_ID ?? '',
        words: input.commandWords,
      }),
    killSwitch: () => readKillSwitch(env),
    launchRecord:
      sessionBeadId == null || sessionDb == null
        ? null
        : () => readLaunchRecord({beadId: sessionBeadId, db: sessionDb, env}),
    liveSessions: async () => {
      if (cmuxEnv == null) {
        return {
          kind: 'failed',
          reason: `no cmux socket: ${'reason' in socket ? socket.reason : '?'}`,
        };
      }
      return countLiveSessions(
        await readLiveSessions(realLiveSessionDeps(cmuxEnv)),
      );
    },
    pingCmux: async () => {
      if (runner == null) {
        return {
          kind: 'failed',
          reason: `no cmux socket: ${'reason' in socket ? socket.reason : '?'}`,
        };
      }
      const ping = await runner(['ping']);
      return ping.kind === 'ok' ? {kind: 'ok'} : ping;
    },
    usage: () => readSamples(samplesPath(env)),
  };
}

// ---------------------------------------------------------------------------
// Recording a refusal
// ---------------------------------------------------------------------------

export type RecordRefusalOutcome =
  | {kind: 'failed'; reason: string}
  | {kind: 'recorded'; line: string};

/**
 * Label the session bead `handoff-refused` and append "handoff refused:
 * <reason> — <detail>" to its notes, the way handOff() appends "handed off".
 * One br write; a failure says nothing was recorded.
 */
export function recordRefusal(input: {
  beadId: string;
  db: string;
  detail: string;
  env?: EnvLike;
  now?: Date;
  reason: HandoffRefusalReason;
}): RecordRefusalOutcome {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const shown = brShow({db: input.db, env}, input.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the refusal was NOT recorded: ${input.beadId} could not be read: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {
      kind: 'failed',
      reason: `the refusal was NOT recorded: ${input.beadId} is not in ${input.db}`,
    };
  }
  const text = `handoff refused: ${input.reason} — ${oneLine(input.detail)}`;
  const written = brUpdate({db: input.db, env}, input.beadId, {
    addLabels: [HANDOFF_REFUSED_LABEL],
    notes: appendNote(shown.issue.notes, text, now),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the refusal was NOT recorded on ${input.beadId}: ${describeBrFailed(written)}`,
    };
  }
  return {kind: 'recorded', line: text};
}
