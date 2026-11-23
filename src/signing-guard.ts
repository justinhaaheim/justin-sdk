/**
 * signing-guard.ts — no signing build starts while the screen is locked
 * (home-base-di8c7.1).
 *
 * WHY. Shown on this Mac on 2026-11-20 (home-base-di8c7): a build that updates
 * signing (`xcodebuild … -allowProvisioningUpdates`) and STARTS while the screen
 * is locked cannot read Xcode's credentials from the data-protection keychain,
 * and Xcode then deletes its Apple account. Locking during a build that has
 * already started does not. So each signing step asks this module first and
 * waits for an unlocked screen (D3), or stops with a message that says why.
 *
 * READING THE LOCK (D1, D2). `ioreg -n Root -d1`, in its text form: the plist
 * form (`-a`) fails inside the Claude Code sandbox with "can't open file", and
 * the text form works in and out of it (measured 2026-11-21). The rules are on
 * parseScreenLockState. The direction that matters is never to read "unlocked"
 * while the screen is locked, so a reading that cannot be made is `unknown`,
 * and unknown stops (D4). It is never "unlocked" (critical rules section 7).
 *
 * THE OFF SWITCH (D5). JUSTIN_SDK_SIGNING_GUARD=off, exactly "off", makes every
 * call proceed and print one line saying the screen lock was not checked. It
 * exists for a future macOS whose ioreg output this no longer reads.
 *
 * CALLERS. `justin-sdk signing-guard` (signing-guard-command.ts) for package.json
 * scripts, and mac-build.ts, which calls assertUnlockedForSigning immediately
 * before each signing step (D7). Remaining window: the screen locking in the
 * first seconds of a step that has already started (the account is read about
 * 1 to 10 s into a build).
 */

import {execFileSync, spawnSync} from 'child_process';
import {constants as osConstants} from 'os';

/** What the lock reading says. `unknown` is never treated as `unlocked`. */
export type ScreenLockState =
  | {reason: string; state: 'locked'}
  | {reason: string; state: 'unknown'}
  | {state: 'unlocked'};

/** `ioreg -n Root -d1`: the registry root, one level deep (D1). */
export const IOREG_ARGS: readonly string[] = ['-n', 'Root', '-d1'];
const IOREG_DISPLAY = `ioreg ${IOREG_ARGS.join(' ')}`;
/** The ioreg reading takes well under a second; 5 s means it is stuck. */
export const IOREG_TIMEOUT_MS = 5000;

/** The off switch (D5): exactly "off" turns the guard off. */
export const SIGNING_GUARD_ENV = 'JUSTIN_SDK_SIGNING_GUARD';
export const DEFAULT_MAX_WAIT_SECONDS = 1800;
export const DEFAULT_POLL_SECONDS = 5;

/** Exit codes when the guard stops (the CLI's contract). */
export const SIGNING_GUARD_EXIT_LOCKED = 3;
export const SIGNING_GUARD_EXIT_UNKNOWN = 4;

const TAG = '[signing-guard]';
const WHY =
  'A signing build that starts while the screen is locked makes Xcode lose its Apple account sign-in (home-base-di8c7).';

// ---------------------------------------------------------------------------
// Running ioreg
// ---------------------------------------------------------------------------

/** One command's result: its stdout, or why there is none. */
export type CommandRun =
  | {detail: string; status: 'failed'}
  | {status: 'ok'; stdout: string};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => CommandRun;

function describeRunError(error: unknown, timeoutMs: number): string {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  if (failure.code === 'ETIMEDOUT') {
    return `it did not finish within ${timeoutMs / 1000} s`;
  }
  if (failure.code === 'ENOENT') return 'the command was not found';
  if (typeof failure.signal === 'string' && failure.signal !== '') {
    return `it was stopped by ${failure.signal} (it is stopped after ${timeoutMs / 1000} s)`;
  }
  const stderr =
    typeof failure.stderr === 'string'
      ? failure.stderr.trim()
      : Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString('utf8').trim()
        : '';
  if (typeof failure.status === 'number') {
    return `it exited ${failure.status}${stderr === '' ? '' : `: ${stderr.split('\n')[0]}`}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The real runner: execFileSync with a timeout, every failure named. */
export function runCommandSync(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): CommandRun {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      // About 95 KB measured on 2026-11-21. Generous, and a truncation is an
      // error (ENOBUFS), so it reads as unknown, never as a short answer.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return {status: 'ok', stdout};
  } catch (error) {
    return {detail: describeRunError(error, timeoutMs), status: 'failed'};
  }
}

// ---------------------------------------------------------------------------
// Parsing ioreg's text form
// ---------------------------------------------------------------------------

/** One value in ioreg's text form, as far as this parser needs to know it. */
type IoregValue =
  | {entries: Map<string, IoregValue>; kind: 'dict'}
  | {items: IoregValue[]; kind: 'array'}
  | {kind: 'scalar'; text: string};

interface Parsed {
  end: number;
  value: IoregValue;
}

function skipSpace(text: string, index: number): number {
  let at = index;
  while (at < text.length && /\s/.test(text.charAt(at))) at += 1;
  return at;
}

/** A "quoted" string from `index` (at the opening quote); null when it never ends. */
function parseQuoted(
  text: string,
  index: number,
): {end: number; text: string} | null {
  let at = index + 1;
  let out = '';
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === '\\' && at + 1 < text.length) {
      out += text.charAt(at + 1);
      at += 2;
      continue;
    }
    if (char === '"') return {end: at + 1, text: out};
    out += char;
    at += 1;
  }
  return null;
}

/**
 * A recursive-descent reader for the values ioreg prints: `(…)` arrays, `{…}`
 * dicts of `"key"=value`, `"strings"`, `<data>`, and bare words (Yes, No,
 * numbers). It returns null on anything it cannot read, so a changed format is
 * `unknown`, never a partial answer.
 */
function parseValue(text: string, index: number): Parsed | null {
  const at = skipSpace(text, index);
  const char = text[at];
  if (char === undefined) return null;
  if (char === '(') {
    const items: IoregValue[] = [];
    let next = skipSpace(text, at + 1);
    if (text[next] === ')')
      return {end: next + 1, value: {items, kind: 'array'}};
    for (;;) {
      const item = parseValue(text, next);
      if (item == null) return null;
      items.push(item.value);
      next = skipSpace(text, item.end);
      if (text[next] === ',') {
        next += 1;
        continue;
      }
      if (text[next] === ')') {
        return {end: next + 1, value: {items, kind: 'array'}};
      }
      return null;
    }
  }
  if (char === '{') {
    const entries = new Map<string, IoregValue>();
    let next = skipSpace(text, at + 1);
    if (text[next] === '}') {
      return {end: next + 1, value: {entries, kind: 'dict'}};
    }
    for (;;) {
      if (text[next] !== '"') return null;
      const key = parseQuoted(text, next);
      if (key == null) return null;
      next = skipSpace(text, key.end);
      if (text[next] !== '=') return null;
      const value = parseValue(text, next + 1);
      if (value == null) return null;
      entries.set(key.text, value.value);
      next = skipSpace(text, value.end);
      if (text[next] === ',') {
        next = skipSpace(text, next + 1);
        continue;
      }
      if (text[next] === '}') {
        return {end: next + 1, value: {entries, kind: 'dict'}};
      }
      return null;
    }
  }
  if (char === '"') {
    const quoted = parseQuoted(text, at);
    return quoted == null
      ? null
      : {end: quoted.end, value: {kind: 'scalar', text: quoted.text}};
  }
  if (char === '<') {
    const close = text.indexOf('>', at);
    return close < 0
      ? null
      : {
          end: close + 1,
          value: {kind: 'scalar', text: text.slice(at, close + 1)},
        };
  }
  let end = at;
  while (end < text.length && !/[,})\s]/.test(text.charAt(end))) end += 1;
  if (end === at) return null;
  return {end, value: {kind: 'scalar', text: text.slice(at, end)}};
}

function scalarText(value: IoregValue | undefined): string | null {
  return value?.kind === 'scalar' ? value.text : null;
}

/** Every `"CGSSessionScreenIsLocked"=<value>`, in either spacing ioreg uses. */
const LOCK_KEY_RE = /"CGSSessionScreenIsLocked"\s*=\s*([^,})\s]*)/g;
const CONSOLE_USERS_RE = /"IOConsoleUsers"\s*=/g;

function unknown(reason: string): ScreenLockState {
  return {reason, state: 'unknown'};
}

/**
 * The lock state from the text of `ioreg -n Root -d1`, for the user `uid` (D2).
 * The rules, in this order:
 *
 *  1. `"CGSSessionScreenIsLocked"=Yes` ANYWHERE in the text: locked. Not scoped
 *     to one dict, because where the key sits when locked has not been seen.
 *     The key with a value other than Yes or No: unknown (an addition to D2,
 *     in the cautious direction).
 *  2. No `"IOConsoleUsers" =` (or more than one, or a value this cannot read as
 *     a list of dicts): unknown.
 *  3. The session dict whose `"kCGSSessionUserIDKey"` is `uid`. None: unknown.
 *     More than one: unknown (ambiguous).
 *  4. That dict's `"kCGSSessionOnConsoleKey"` is No: locked (another user is
 *     switched in). Missing, or anything but Yes or No: unknown.
 *  5. Otherwise (on the console, no lock key): unlocked.
 *
 * Empty output is unknown. Unknown never becomes unlocked.
 */
export function parseScreenLockState(
  ioregText: string,
  uid: number | null,
): ScreenLockState {
  if (ioregText.trim() === '') {
    return unknown(`\`${IOREG_DISPLAY}\` printed nothing`);
  }

  // Rule 1.
  const lockValues = [...ioregText.matchAll(LOCK_KEY_RE)].map(
    (match) => match[1] ?? '',
  );
  if (lockValues.includes('Yes')) {
    return {
      reason: `\`${IOREG_DISPLAY}\` reports "CGSSessionScreenIsLocked"=Yes`,
      state: 'locked',
    };
  }
  const oddLockValue = lockValues.find((value) => value !== 'No');
  if (oddLockValue !== undefined) {
    return unknown(
      `\`${IOREG_DISPLAY}\` printed "CGSSessionScreenIsLocked"=${oddLockValue}, which is neither Yes nor No`,
    );
  }

  // Rule 2.
  const usersKeys = [...ioregText.matchAll(CONSOLE_USERS_RE)];
  const usersKey = usersKeys[0];
  if (usersKey === undefined) {
    return unknown(`\`${IOREG_DISPLAY}\` printed no IOConsoleUsers`);
  }
  if (usersKeys.length > 1) {
    return unknown(
      `\`${IOREG_DISPLAY}\` printed IOConsoleUsers ${usersKeys.length} times`,
    );
  }
  const users = parseValue(ioregText, usersKey.index + usersKey[0].length);
  if (users?.value.kind !== 'array') {
    return unknown(
      `\`${IOREG_DISPLAY}\` printed an IOConsoleUsers this could not read as a list`,
    );
  }
  const sessions: Map<string, IoregValue>[] = [];
  for (const item of users.value.items) {
    if (item.kind !== 'dict') {
      return unknown(
        `\`${IOREG_DISPLAY}\` printed an IOConsoleUsers entry that is not a dictionary`,
      );
    }
    sessions.push(item.entries);
  }

  // Rule 3.
  if (uid == null) return unknown("could not read this process's user id");
  const mine = sessions.filter(
    (session) =>
      scalarText(session.get('kCGSSessionUserIDKey')) === String(uid),
  );
  const session = mine[0];
  if (session === undefined) {
    return unknown(
      `\`${IOREG_DISPLAY}\` lists no console session for user id ${uid}`,
    );
  }
  if (mine.length > 1) {
    return unknown(
      `\`${IOREG_DISPLAY}\` lists ${mine.length} console sessions for user id ${uid}`,
    );
  }

  // Rule 4.
  const onConsole = scalarText(session.get('kCGSSessionOnConsoleKey'));
  if (onConsole === 'No') {
    return {
      reason:
        "this user's session is not on the console (another user is switched in)",
      state: 'locked',
    };
  }
  if (onConsole !== 'Yes') {
    return unknown(
      onConsole == null
        ? `\`${IOREG_DISPLAY}\` printed no kCGSSessionOnConsoleKey for user id ${uid}`
        : `\`${IOREG_DISPLAY}\` printed kCGSSessionOnConsoleKey=${onConsole} for user id ${uid}, which is neither Yes nor No`,
    );
  }

  // Rule 5.
  return {state: 'unlocked'};
}

function currentUid(): number | null {
  return process.getuid?.() ?? null;
}

/**
 * Read the lock state from `ioreg -n Root -d1`. A failed or timed-out ioreg is
 * `unknown`, naming the command and its error (D2).
 */
export function readScreenLockState(
  run: CommandRunner = runCommandSync,
  uid: number | null = currentUid(),
): ScreenLockState {
  const result = run('ioreg', IOREG_ARGS, IOREG_TIMEOUT_MS);
  if (result.status === 'failed') {
    return {
      reason: `\`${IOREG_DISPLAY}\` failed: ${result.detail}`,
      state: 'unknown',
    };
  }
  return parseScreenLockState(result.stdout, uid);
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export interface SigningGuardOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** One line to stderr by default. */
  log?: (line: string) => void;
  maxWaitSeconds?: number;
  /** Milliseconds, like Date.now. */
  now?: () => number;
  pollSeconds?: number;
  readState?: () => ScreenLockState;
  sleep?: (seconds: number) => void;
  /** Default true: when locked, wait for the unlock rather than stop at once. */
  wait?: boolean;
  /** What is about to run, for the messages, e.g. "the xcodebuild build of MyApp". */
  what: string;
}

export type SigningGuardOutcome =
  | {action: 'proceed'; checked: false}
  | {action: 'proceed'; checked: true; waitedSeconds: number}
  | {
      action: 'stop';
      cause: 'locked' | 'timed-out' | 'unknown';
      message: string;
    };

export type SigningGuardProceed = Extract<
  SigningGuardOutcome,
  {action: 'proceed'}
>;

export function signingGuardIsOff(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[SIGNING_GUARD_ENV] === 'off';
}

/** "45 s", "2 min 15 s", "30 min". */
export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function logToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function sleepSeconds(seconds: number): void {
  Bun.sleepSync(seconds * 1000);
}

function stopUnknown(what: string, reason: string): SigningGuardOutcome {
  return {
    action: 'stop',
    cause: 'unknown',
    message: `Could not tell whether the screen is locked, so ${what} did not start: ${reason}. ${WHY} So the guard does not guess. If the guard itself is wrong (a macOS whose ioreg output it no longer reads), ${SIGNING_GUARD_ENV}=off turns it off for one run.`,
  };
}

/**
 * The guard (D3 to D6). Unlocked: proceed, printing nothing. Off: proceed,
 * printing one line. Unknown: stop. Locked: stop at once when `wait` is false;
 * otherwise print one line, poll every `pollSeconds` for up to
 * `maxWaitSeconds`, and proceed (printing how long it waited) or stop. A
 * reading that turns unknown during the wait stops too. Synchronous, because
 * mac-build is.
 */
export function waitForUnlockedScreen(
  options: SigningGuardOptions,
): SigningGuardOutcome {
  const {what} = options;
  const wait = options.wait ?? true;
  const maxWaitSeconds = options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const pollSeconds = options.pollSeconds ?? DEFAULT_POLL_SECONDS;
  const readState = options.readState ?? (() => readScreenLockState());
  const sleep = options.sleep ?? sleepSeconds;
  const now = options.now ?? Date.now;
  const log = options.log ?? logToStderr;
  const env = options.env ?? process.env;

  // A NaN here would make the deadline NaN and the wait endless.
  if (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds < 0) {
    throw new Error(
      `signing guard: maxWaitSeconds must be 0 or more, not ${maxWaitSeconds}`,
    );
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error(
      `signing guard: pollSeconds must be more than 0, not ${pollSeconds}`,
    );
  }

  if (signingGuardIsOff(env)) {
    log(
      `${TAG} ${SIGNING_GUARD_ENV}=off, so the screen lock was NOT checked before ${what}.`,
    );
    return {action: 'proceed', checked: false};
  }

  const first = readState();
  if (first.state === 'unlocked') {
    return {action: 'proceed', checked: true, waitedSeconds: 0};
  }
  if (first.state === 'unknown') return stopUnknown(what, first.reason);
  if (!wait) {
    return {
      action: 'stop',
      cause: 'locked',
      message: `The screen is locked (${first.reason}), so ${what} did not start. ${WHY} Unlock the screen and run it again.`,
    };
  }

  const startedMs = now();
  const deadlineMs = startedMs + maxWaitSeconds * 1000;
  log(
    `${TAG} The screen is locked (${first.reason}), so ${what} is waiting to start. ${WHY} It starts by itself once the screen is unlocked (checked every ${formatWait(pollSeconds)}, for up to ${formatWait(maxWaitSeconds)}). Press Ctrl-C to stop it.`,
  );
  let lockedReason = first.reason;
  for (;;) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return {
        action: 'stop',
        cause: 'timed-out',
        message: `The screen was still locked after ${formatWait(maxWaitSeconds)} (${lockedReason}), so ${what} did not start. ${WHY} Unlock the screen and run it again.`,
      };
    }
    sleep(Math.min(pollSeconds, remainingMs / 1000));
    const state = readState();
    if (state.state === 'unlocked') {
      const waitedSeconds = (now() - startedMs) / 1000;
      log(
        `${TAG} The screen is unlocked; starting ${what} after waiting ${formatWait(waitedSeconds)}.`,
      );
      return {action: 'proceed', checked: true, waitedSeconds};
    }
    if (state.state === 'unknown') return stopUnknown(what, state.reason);
    lockedReason = state.reason;
  }
}

/**
 * What scripts call: waitForUnlockedScreen, throwing an Error that carries the
 * message when the guard stops.
 */
export function assertUnlockedForSigning(
  options: SigningGuardOptions,
): SigningGuardProceed {
  const outcome = waitForUnlockedScreen(options);
  if (outcome.action === 'stop') throw new Error(outcome.message);
  return outcome;
}

// ---------------------------------------------------------------------------
// The CLI: `justin-sdk signing-guard` (registered in signing-guard-command.ts)
// ---------------------------------------------------------------------------

/** How the command after `--` ended. */
export type CommandExit =
  | {code: number; status: 'exited'}
  | {detail: string; status: 'not-started'}
  | {signal: string; status: 'signalled'};

export interface SigningGuardRequest {
  /** The command after `--`, verbatim; null for a bare check. */
  command: readonly string[] | null;
  maxWaitMinutes: number;
  status: boolean;
  wait: boolean;
}

export interface SigningGuardCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  readState: () => ScreenLockState;
  sleep: (seconds: number) => void;
  spawn: (command: string, args: readonly string[]) => CommandExit;
  /** One line each; the newline is added. */
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}

/** Run a command with inherited stdio and report how it ended. */
export function spawnInherit(
  command: string,
  args: readonly string[],
): CommandExit {
  const result = spawnSync(command, [...args], {stdio: 'inherit'});
  if (result.error != null) {
    return {detail: result.error.message, status: 'not-started'};
  }
  if (typeof result.status === 'number') {
    return {code: result.status, status: 'exited'};
  }
  if (result.signal != null)
    return {signal: result.signal, status: 'signalled'};
  return {
    detail: 'it ended with neither an exit code nor a signal',
    status: 'not-started',
  };
}

export function realSigningGuardCliDeps(): SigningGuardCliDeps {
  return {
    env: process.env,
    now: Date.now,
    readState: () => readScreenLockState(),
    sleep: sleepSeconds,
    spawn: spawnInherit,
    stderr: logToStderr,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

/**
 * The command's behaviour, with every effect injected: exit 0 when clear (or
 * the command's own exit code after `--`), 3 when locked, 4 when the state
 * could not be read, 127 when the command could not be started, 128 + N when
 * it ended on signal N. `--status` prints the state and exits 0, 3 or 4
 * without waiting or running anything.
 */
export function runSigningGuardCli(
  request: SigningGuardRequest,
  deps: SigningGuardCliDeps,
): number {
  if (request.status) {
    if (signingGuardIsOff(deps.env)) {
      deps.stderr(
        `${TAG} ${SIGNING_GUARD_ENV}=off: signing steps do not check the screen lock. The state below is read anyway.`,
      );
    }
    const state = deps.readState();
    switch (state.state) {
      case 'unlocked':
        deps.stdout('unlocked');
        return 0;
      case 'locked':
        deps.stdout(`locked: ${state.reason}`);
        return SIGNING_GUARD_EXIT_LOCKED;
      case 'unknown':
        deps.stdout(`unknown: ${state.reason}`);
        return SIGNING_GUARD_EXIT_UNKNOWN;
    }
  }

  const command = request.command;
  const what =
    command == null
      ? 'the signing step after this check'
      : `\`${command.join(' ')}\``;
  const outcome = waitForUnlockedScreen({
    env: deps.env,
    log: deps.stderr,
    maxWaitSeconds: request.maxWaitMinutes * 60,
    now: deps.now,
    readState: deps.readState,
    sleep: deps.sleep,
    wait: request.wait,
    what,
  });
  if (outcome.action === 'stop') {
    deps.stderr(`${TAG} ${outcome.message}`);
    return outcome.cause === 'unknown'
      ? SIGNING_GUARD_EXIT_UNKNOWN
      : SIGNING_GUARD_EXIT_LOCKED;
  }
  if (command == null) return 0;

  const [program, ...args] = command;
  if (program === undefined) return 0;
  const ended = deps.spawn(program, args);
  switch (ended.status) {
    case 'exited':
      return ended.code;
    case 'not-started':
      deps.stderr(`${TAG} Could not start ${what}: ${ended.detail}`);
      return 127;
    case 'signalled': {
      const number = (
        osConstants.signals as Record<string, number | undefined>
      )[ended.signal];
      deps.stderr(`${TAG} ${what} ended on ${ended.signal}.`);
      return number === undefined ? 1 : 128 + number;
    }
  }
}
