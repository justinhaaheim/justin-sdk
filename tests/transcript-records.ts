/**
 * Transcript records for tests (home-base-vzwbj.4.4): a Bash tool call as
 * Claude Code writes it — an assistant record with a `tool_use` block, then a
 * user record with the matching `tool_result` — in the shape measured on this
 * machine's real transcripts on 2026-10-11 (content a string, `toolUseResult`
 * beside it with stdout/stderr).
 */

export interface BashCallInput {
  /** The tool_use record's time (ISO). */
  at: string;
  command: string;
  cwd: string;
  /** The tool_result record's time (ISO); null writes no result record. */
  endAt: string | null;
  id: string;
  isSidechain?: boolean;
  output: string;
  sessionId: string;
}

export function bashCallRecords(input: BashCallInput): object[] {
  const sidechain = input.isSidechain === true;
  const use = {
    cwd: input.cwd,
    isSidechain: sidechain,
    message: {
      content: [
        {
          id: input.id,
          input: {command: input.command, description: 'run it'},
          name: 'Bash',
          type: 'tool_use',
        },
      ],
      model: 'claude-opus-5',
      role: 'assistant',
    },
    sessionId: input.sessionId,
    timestamp: input.at,
    type: 'assistant',
  };
  if (input.endAt == null) return [use];
  const result = {
    cwd: input.cwd,
    isSidechain: sidechain,
    message: {
      content: [
        {
          content: input.output,
          is_error: false,
          tool_use_id: input.id,
          type: 'tool_result',
        },
      ],
      role: 'user',
    },
    sessionId: input.sessionId,
    timestamp: input.endAt,
    toolUseResult: {
      interrupted: false,
      isImage: false,
      stderr: '',
      stdout: input.output,
    },
    type: 'user',
  };
  return [use, result];
}

/** A Read tool call whose result happens to contain text (never a commit). */
export function readCallRecords(input: {
  at: string;
  cwd: string;
  id: string;
  output: string;
  sessionId: string;
}): object[] {
  return [
    {
      cwd: input.cwd,
      message: {
        content: [
          {
            id: input.id,
            input: {file_path: '/x'},
            name: 'Read',
            type: 'tool_use',
          },
        ],
        role: 'assistant',
      },
      sessionId: input.sessionId,
      timestamp: input.at,
      type: 'assistant',
    },
    {
      cwd: input.cwd,
      message: {
        content: [
          {content: input.output, tool_use_id: input.id, type: 'tool_result'},
        ],
        role: 'user',
      },
      sessionId: input.sessionId,
      timestamp: input.at,
      type: 'user',
    },
  ];
}
