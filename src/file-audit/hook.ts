/**
 * `justin-sdk file-audit hook` — the PreToolUse handler of the file-access
 * audit log (home-base-n1qy7.15.1). audit.ts decides what one call logs; this
 * reads the payload and appends the line.
 *
 * NEVER A DECISION (D5). Nothing is printed to stdout on any path, and the exit
 * code is 0 or 1, never 2. Through the dispatcher a 1 becomes one visible,
 * non-blocking line in systemMessage ("file-audit hook failed (exit 1): …",
 * mergeHandlerOutputs) and the tool call goes ahead; in a per-handler entry
 * Claude Code treats 1 as a non-blocking error. So a log that cannot be
 * written says so, on stderr, and blocks nothing.
 *
 * ONE APPEND PER LINE (D6): `appendFileSync` opens with O_APPEND and writes
 * the line and its newline in one call, so parallel sessions do not
 * interleave.
 */

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {type AuditLine, auditLogPath, auditToolCall, MAX_TEXT} from './audit';

type Env = Record<string, string | undefined>;

export interface FileAuditHookDeps {
  env: Env;
  now: () => Date;
  /** The payload; the real hook reads stdin once. */
  readStdin: () => string;
  writeStderr: (text: string) => void;
}

function realDeps(): FileAuditHookDeps {
  return {
    env: process.env,
    now: () => new Date(),
    readStdin: () => {
      if (process.stdin.isTTY === true) return '';
      try {
        return readFileSync(0, 'utf8');
      } catch {
        return '';
      }
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append one line to the log, creating its directory on demand. */
export function appendAuditLine(path: string, line: AuditLine): void {
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** The hook. Returns the exit code: 0, or 1 when the log could not be written. */
export function runFileAuditHook(
  overrides: Partial<FileAuditHookDeps> = {},
): number {
  const deps = {...realDeps(), ...overrides};
  const raw = deps.readStdin();
  const now = deps.now();
  const path = auditLogPath(deps.env);

  let line: AuditLine | null;
  try {
    const outcome = auditToolCall({env: deps.env, now, raw});
    line = outcome.kind === 'log' ? outcome.line : null;
  } catch (error) {
    // A bug here must not look like "nothing to log": the call is logged as
    // unparsed, with why, and without its raw text (it may hold file content).
    line = {
      agent_id: null,
      agent_type: null,
      command: null,
      command_truncated: false,
      confidence: null,
      cwd: null,
      paths: [],
      paths_truncated: false,
      permission_mode: null,
      raw: null,
      raw_truncated: raw.length > MAX_TEXT,
      reasons: ['unparsed'],
      session_id: null,
      tool: null,
      tool_use_id: null,
      ts: now.toISOString(),
      unsandboxed: null,
      v: 1,
      why: `the audit hook failed while reading this call: ${message(error)}`,
    };
  }
  if (line == null) return 0;

  try {
    appendAuditLine(path, line);
    return 0;
  } catch (error) {
    deps.writeStderr(
      `justin-sdk file-audit: could not write the audit log ${path} (${message(error)}); this ${line.tool ?? 'tool'} call was not recorded\n`,
    );
    return 1;
  }
}
