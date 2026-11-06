/**
 * The handoff gate (epic home-base-mbnjv D2; built by home-base-mbnjv.1 item
 * 6): every check that must pass before `thread handoff` starts a successor,
 * as ONE function over injected readers, so each refusal reason is a unit
 * test with no cmux, no claude and no real state dir.
 *
 * It answers `pass`, `refused` with a reason, a detail and the message the
 * caller prints, or `deferred` when cmux still had not answered at the
 * deadline (home-base-89c8h.1: a slow cmux decides nothing, so it is never a
 * final refusal). Calling it from `thread handoff` / `thread spawn`, exit code
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
import type {CmuxRunner} from './cmux';
import type {GuardPassRead} from './guard-pass';
import type {GuardRegistration} from './guard-registration';
import type {UnattendedChain} from './handoff-chain';
import type {ResolvedHandoffConfig} from './handoff-knob';
import type {LiveSessionCount, LiveSessionCountRead} from './live-count';
import type {LiveSessionDeps} from './live-sessions';
import type {EnvLike} from './paths';
import type {QuotaGateDecision, QuotaGateRead} from './quota-gate';

import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {brShow, brUpdate, describeBrFailed, saysBeadsLocked} from '../beads/br';
import {readSamples, samplesPath} from '../claude-usage-samples';
import {SDK_BIN_BY_PATH, SDK_HANDOFF_CALL} from '../sdk-invocation';
import {oneLine} from './ask-format';
import {gateCmuxRunner, realCmuxRunner} from './cmux';
import {consumeGuardPass, describeGuardPass} from './guard-pass';
import {
  describeGuardNotRegistered,
  guardRegistration,
} from './guard-registration';
import {realChainReaders, walkUnattendedChain} from './handoff-chain';
import {countLiveSessions, describeLiveSessionCount} from './live-count';
import {readLiveSessions, realLiveSessionDeps} from './live-sessions';
import {describePace, newestUsableSample, paceFromSamples} from './pacing';
import {statusLineIdOf} from './pane-join';
import {threadsStateDir} from './paths';
import {gateLine, quotaGateDecision, readQuotaForGate} from './quota-gate';
import {appendQuotaLog} from './quota-log';
import {liveSocketPath} from './respawn';
import {
  HANDOFF_DEFERRED_LABEL,
  HANDOFF_REFUSED_LABEL,
  SUCCESSOR_STARTED_LABEL,
} from './session-bead';
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
  // The pacing hold (home-base-jm5kg.17): only with usage.paceHold on.
  'paceUnknown',
  'paceHold',
  'chainUnknown',
  'tooManyUnattendedHandoffs',
  // The spend quota (home-base-ys9t7.5 D7, quota-gate.ts): enforce mode only.
  'quotaUnknown',
  'quotaChainSpent',
  'quotaProjectSpent',
  'quotaWeekFloor',
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

/**
 * home-base-89c8h.1 D5: why nothing was decided. cmux still had not answered at
 * the deadline, or another process held the beads database for the whole wait
 * (home-base-p05kz.5.1).
 */
export type HandoffDeferralReason = 'beadsLocked' | 'cmuxSlow';

/** What a deferred handoff tells the calling Claude, after its reason (D6). */
export const HANDOFF_DEFERRAL_INSTRUCTIONS = [
  'Nothing was refused, and no successor was started.',
  'This command already waited for cmux. Run the same command again at once, up to 3 more times.',
  'If it still exits 4, include the handoff block printed above in your final report for Justin, and stop.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

/** The same, when the beads database was locked: there may be no block to quote. */
export const HANDOFF_BEADS_LOCKED_INSTRUCTIONS = [
  'Nothing was refused, and no successor was started.',
  'This command already waited for the beads database. Run the same command again at once, up to 3 more times.',
  'If it still exits 4, quote this output in your final report for Justin, and stop.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

/** The full message one deferral prints: its reason line, then the instructions. */
export function handoffDeferralMessage(
  reason: HandoffDeferralReason,
  detail: string,
): string {
  return [
    `handoff deferred: ${reason}: ${detail}`,
    '',
    ...(reason === 'beadsLocked'
      ? HANDOFF_BEADS_LOCKED_INSTRUCTIONS
      : HANDOFF_DEFERRAL_INSTRUCTIONS),
  ].join('\n');
}

/**
 * D4: the most time the gate and the pane lookup spend waiting on cmux. The
 * Bash tool kills a call at 120 s by default, and handoff.md runs the command
 * with no timeout override.
 */
export const HANDOFF_GATE_DEADLINE_MS = 60_000;

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
  /**
   * The 5-hour window, or null when the newest sample shows none (the panel
   * printed no `Current session` line; home-base-jm5kg.19 D4). Read null as
   * "no 5-hour window shown", never as 0 %.
   */
  sessionPercent: number | null;
  weekPercent: number;
}

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
  const usable = newestUsableSample(read, limits.maxSampleAgeMinutes, now);
  if (!usable.ok) {
    return {detail: usable.detail, ok: false, reason: 'usageUnknown'};
  }
  const {ageMinutes, sample: newest} = usable;
  const over: string[] = [];
  // jm5kg.19 D4: the 5-hour ceiling applies only when the sample has a 5-hour
  // window. null is "the panel showed none", so there is nothing to compare.
  if (newest.session != null && newest.session.pct > limits.maxSessionPercent) {
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
      sessionPercent: newest.session?.pct ?? null,
      weekPercent: newest.week.pct,
    },
    ok: true,
  };
}

/**
 * The pacing hold (home-base-jm5kg.17): at hold level, or with the pace unknown,
 * this refuses; null passes. The gate calls it only with usage.paceHold on, and
 * only after checkUsage passed, so the ceilings come first and stay as they are.
 */
export function checkPaceHold(
  read: SamplesRead,
  limits: Pick<HandoffUsageLimits, 'maxSampleAgeMinutes'>,
  now: Date,
): {detail: string; reason: 'paceHold' | 'paceUnknown'} | null {
  const pace = paceFromSamples(read, {
    maxSampleAgeMinutes: limits.maxSampleAgeMinutes,
    now,
  });
  if (pace.kind === 'unknown') {
    return {
      detail: `the week's pace could not be worked out: ${pace.reason}`,
      reason: 'paceUnknown',
    };
  }
  if (pace.verdict !== 'hold') return null;
  return {
    detail: `${describePace(pace)}, read ${pace.readAt}, week resets ${pace.resetsAt}`,
    reason: 'paceHold',
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type CmuxPing =
  | {kind: 'failed'; reason: string; timedOut: boolean}
  | {kind: 'ok'};

/** The caller's own screen: ScreenRead, plus whether a failed read timed out. */
export type CallerScreenRead =
  | {kind: 'read'; text: string}
  | {kind: 'unreadable'; reason: string; timedOut: boolean};

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
  callerScreen: () => CallerScreenRead | Promise<CallerScreenRead>;
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
  /**
   * The spend quota's verdict for this handoff or spawn (quota-gate.ts,
   * home-base-ys9t7.5 D7). Absent or null skips the check. A throw refuses
   * with quotaUnknown.
   */
  quota?: (() => Promise<QuotaGateRead> | QuotaGateRead) | null;
  /** Append a quota-log line; returns why it failed, or null. */
  quotaLog?: (line: Record<string, unknown>) => string | null;
  usage: () => Promise<SamplesRead> | SamplesRead;
}

/** The knob values the gate enforces. A ResolvedHandoffConfig fits. */
export interface HandoffGateLimits {
  maxLiveSessions: number;
  maxUnattendedHandoffs: number;
  /**
   * `check: false` skips the usage check; absent checks. `paceHold: true` adds
   * the pacing hold; absent or false leaves the gate exactly as it was.
   */
  usage: HandoffUsageLimits & {check?: boolean; paceHold?: boolean};
}

export interface HandoffGateInput {
  /**
   * home-base-p05kz.3 item 8: true only for `thread handoff --dry-run`, which
   * opens nothing. A guard pass that is not valid is then reported in
   * facts.guardPassNote instead of refusing. Absent or false refuses: a real
   * run always needs the pass (F14).
   */
  dryRun?: boolean;
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
  /**
   * Why a real run would refuse with guardNotSeen, on a dry run that had no
   * valid pass. Always null on a real run, which refuses instead.
   */
  guardPassNote: string | null;
  liveSessions: LiveSessionCount;
  /** CMUX_SURFACE_ID; null only when requireCmuxPane was false and it is unset. */
  surfaceId: string | null;
  /** What the newest sample said, or why the usage check was skipped. */
  usage: HandoffUsageFacts | {skipped: string};
  /** CMUX_WORKSPACE_ID; null only when requireCmuxPane was false and it is unset. */
  workspaceId: string | null;
}

export type HandoffGateResult =
  | {
      /**
       * home-base-89c8h.1 D5: cmux still had not answered at the deadline, so
       * nothing was decided. A kind of its own, so every caller must handle it.
       */
      detail: string;
      kind: 'deferred';
      /** The reason line, then the instructions: print it as it is. */
      message: string;
      reason: HandoffDeferralReason;
    }
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

/** D5: the gate's answer when cmux is too slow to give a real one. */
function deferredCmuxSlow(
  detail: string,
): Extract<HandoffGateResult, {kind: 'deferred'}> {
  return {
    detail,
    kind: 'deferred',
    message: handoffDeferralMessage('cmuxSlow', detail),
    reason: 'cmuxSlow',
  };
}

/** home-base-p05kz.5.1: the gate's answer when a bead read met a locked database. */
function deferredBeadsLocked(
  detail: string,
): Extract<HandoffGateResult, {kind: 'deferred'}> {
  return {
    detail,
    kind: 'deferred',
    message: handoffDeferralMessage('beadsLocked', detail),
    reason: 'beadsLocked',
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
 * Step 5b on its own, so `thread spawn` can run it where the successor knob
 * is off (spawn-gate.ts): null passes, otherwise the refusal.
 */
export async function runQuotaCheck(
  readers: Pick<HandoffGateReaders, 'quota' | 'quotaLog'>,
  now: Date,
): Promise<Extract<HandoffGateResult, {kind: 'refused'}> | null> {
  if (readers.quota == null) return null;
  const read = await attempt(readers.quota);
  const measured =
    'value' in read && read.value.kind === 'measured' ? read.value : null;
  const decision: QuotaGateDecision =
    'threw' in read
      ? {
          detail: `the spend quota could not be measured: ${read.threw}`,
          kind: 'refuse',
          reason: 'quotaUnknown',
        }
      : quotaGateDecision(read.value);
  if (decision.kind === 'pass') return null;
  readers.quotaLog?.(
    gateLine({
      decision,
      nowMs: now.getTime(),
      purpose: measured?.purpose ?? 'handoff',
      read: measured,
    }),
  );
  return decision.kind === 'refuse'
    ? refused(decision.reason, decision.detail)
    : null;
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
  let guardPassNote: string | null = null;
  if ('threw' in pass) {
    guardPassNote = `the guard pass could not be read: ${pass.threw}`;
  } else if (pass.value.kind !== 'valid') {
    // `thread spawn` also comes through here and has other flags.
    guardPassNote = describeGuardPass(
      pass.value,
      input.requireCmuxPane === false
        ? null
        : `${SDK_HANDOFF_CALL} --note "<one line>"`,
    );
  }
  if (guardPassNote != null && input.dryRun !== true) {
    return refused('guardNotSeen', guardPassNote);
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
    if (why != null && saysBeadsLocked(why)) {
      return deferredBeadsLocked(
        `whether this session already started a successor could not be checked: ${why}`,
      );
    }
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
  if (ping.value.kind === 'failed') {
    return ping.value.timedOut
      ? deferredCmuxSlow(`cmux did not answer a ping: ${ping.value.reason}`)
      : cmuxUnreachable(ping.value.reason);
  }

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
    if (
      'value' in screen &&
      screen.value.kind === 'unreadable' &&
      screen.value.timedOut
    ) {
      return deferredCmuxSlow(
        `cmux did not return tab ${surfaceId}'s screen: ${screen.value.reason}`,
      );
    }
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

  // 4. Usage, from the hourly samples. componentConfig.thread.handoff.usage
  // .check false skips it: an off switch for when the hourly /usage sampler
  // cannot read the panel, so that every handoff would otherwise refuse with
  // usageUnknown. Absent means check: only an explicit false skips.
  let usageFacts: HandoffGateFacts['usage'];
  if (limits.usage.check === false) {
    usageFacts = {
      skipped:
        'componentConfig.thread.handoff.usage.check is false: the usage check was not run',
    };
  } else {
    const usageRead = await attempt(readers.usage);
    if ('threw' in usageRead) {
      return refused(
        'usageUnknown',
        `the usage history could not be read: ${usageRead.threw}`,
      );
    }
    const usage = checkUsage(usageRead.value, limits.usage, now);
    if (!usage.ok) return refused(usage.reason, usage.detail);
    usageFacts = usage.facts;
    // 4b. The pacing hold (home-base-jm5kg.17). Behind its own knob, default
    // off, and after the ceilings: it adds a refusal and replaces nothing.
    if (limits.usage.paceHold === true) {
      const hold = checkPaceHold(usageRead.value, limits.usage, now);
      if (hold != null) return refused(hold.reason, hold.detail);
    }
  }

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
    if (
      walked.value.kind === 'unknown' &&
      saysBeadsLocked(walked.value.reason)
    ) {
      return deferredBeadsLocked(
        `the handoff chain could not be read: ${walked.value.reason}`,
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

  // 5b. The spend quota (home-base-ys9t7.5 D7). Off: skipped inside the
  // reader. Observe: logged, then on. Enforce: refused.
  if (readers.quota != null) {
    const quota = await runQuotaCheck(readers, now);
    if (quota != null) return quota;
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
    if (live.value.timedOut) {
      return deferredCmuxSlow(
        `cmux did not return its tree, so the live Claude sessions could not be counted: ${live.value.reason}`,
      );
    }
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
      guardPassNote,
      liveSessions: live.value,
      surfaceId: surfaceId === '' ? null : surfaceId,
      usage: usageFacts,
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
    // home-base-89c8h.1 D6: this run passed, so an earlier deferral is over.
    ...(shown.issue.labels.includes(HANDOFF_DEFERRED_LABEL)
      ? {removeLabels: [HANDOFF_DEFERRED_LABEL]}
      : {}),
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
 * home-base-89c8h.1 D4: the gate's three cmux readers over one deadline. The
 * ping and the caller's screen retry a timeout. The live-session count does
 * not, because it reads about 65 panes: it only stops at the deadline, and
 * `liveSources` builds its other sources around that runner. `run` as a string
 * is why there is no runner (no cmux socket).
 */
export function gateCmuxReaders(input: {
  backoffMs?: readonly number[];
  deadlineAtMs: number;
  env: EnvLike;
  liveSources: (cmux: CmuxRunner) => LiveSessionDeps;
  now: () => number;
  run: CmuxRunner | string;
  sleep: (ms: number) => Promise<void>;
}): Pick<HandoffGateReaders, 'callerScreen' | 'liveSessions' | 'pingCmux'> {
  const {env, run} = input;
  if (typeof run === 'string') {
    const reason = `no cmux socket: ${run}`;
    return {
      callerScreen: () => ({kind: 'unreadable', reason, timedOut: false}),
      liveSessions: () => ({kind: 'failed', reason, timedOut: false}),
      pingCmux: () => ({kind: 'failed', reason, timedOut: false}),
    };
  }
  const options = {
    ...(input.backoffMs == null ? {} : {backoffMs: input.backoffMs}),
    deadlineAtMs: input.deadlineAtMs,
    now: input.now,
    sleep: input.sleep,
  };
  const retrying = gateCmuxRunner(run, {...options, retry: true});
  const bounded = gateCmuxRunner(run, {...options, retry: false});
  return {
    callerScreen: async () => {
      const call = await retrying([
        'read-screen',
        '--workspace',
        env.CMUX_WORKSPACE_ID ?? '',
        '--surface',
        env.CMUX_SURFACE_ID ?? '',
      ]);
      return call.kind === 'ok'
        ? {kind: 'read', text: call.stdout}
        : {
            kind: 'unreadable',
            reason: call.reason,
            timedOut: call.timedOut,
          };
    },
    liveSessions: async () =>
      countLiveSessions(await readLiveSessions(input.liveSources(bounded))),
    pingCmux: async () => {
      const ping = await retrying(['ping']);
      return ping.kind === 'ok' ? {kind: 'ok'} : ping;
    },
  };
}

/**
 * The readers `thread handoff` runs the gate with (home-base-mbnjv.2 wires
 * them). `sessionBeadId` null builds the spawn gate's set, with no chain.
 */
export function realHandoffGateReaders(input: {
  /**
   * D4: when the gate's cmux calls must stop; `thread handoff` passes its own
   * so the pane lookup after the gate shares it. Default: 60 s from now.
   */
  cmuxDeadlineAtMs?: number;
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
  const sessionDb = input.sessionDb ?? null;
  return {
    ...gateCmuxReaders({
      deadlineAtMs:
        input.cmuxDeadlineAtMs ?? Date.now() + HANDOFF_GATE_DEADLINE_MS,
      env,
      liveSources: (cmux) => ({...realLiveSessionDeps(cmuxEnv ?? env), cmux}),
      now: () => Date.now(),
      run:
        cmuxEnv == null
          ? 'reason' in socket
            ? socket.reason
            : '?'
          : realCmuxRunner(undefined, cmuxEnv),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    }),
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
    quota: () =>
      readQuotaForGate({
        cwd,
        env,
        nowMs: Date.now(),
        purpose: sessionBeadId == null ? 'spawn' : 'handoff',
      }),
    quotaLog: (line) => {
      const written = appendQuotaLog(line, env);
      return written.kind === 'failed' ? written.reason : null;
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
 * home-base-89c8h.1 D6: label the session bead `handoff-deferred` and append
 * "handoff deferred: <reason> — <detail>", as recordRefusal does for a refusal.
 * One br write; a failure says nothing was recorded.
 */
export function recordDeferral(input: {
  beadId: string;
  db: string;
  detail: string;
  env: EnvLike;
  now: Date;
  reason: HandoffDeferralReason;
}): RecordRefusalOutcome {
  const {env, now} = input;
  const shown = brShow({db: input.db, env}, input.beadId);
  if (shown.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the deferral was NOT recorded: ${input.beadId} could not be read: ${describeBrFailed(shown)}`,
    };
  }
  if (shown.kind === 'notFound') {
    return {
      kind: 'failed',
      reason: `the deferral was NOT recorded: ${input.beadId} is not in ${input.db}`,
    };
  }
  const text = `handoff deferred: ${input.reason} — ${oneLine(input.detail)}`;
  const written = brUpdate({db: input.db, env}, input.beadId, {
    addLabels: [HANDOFF_DEFERRED_LABEL],
    notes: appendNote(shown.issue.notes, text, now),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the deferral was NOT recorded on ${input.beadId}: ${describeBrFailed(written)}`,
    };
  }
  return {kind: 'recorded', line: text};
}

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
