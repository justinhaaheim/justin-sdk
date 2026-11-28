/**
 * The file-access audit log (home-base-n1qy7.15.1): what one tool call logs
 * (D1-D4), the off switch, the hook's silence (D5), and the report.
 *
 * Every test builds a scratch HOME (with ~/Dev, ~/Dropbox and ~/.claude in it)
 * and points XDG_STATE_HOME and XDG_CONFIG_HOME into the scratch directory, so
 * nothing here reads or writes the real ~/.local/state/claude-file-audit or
 * the real user config.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  type AuditLine,
  type AuditPlaces,
  auditToolCall,
  classifyPath,
  excludedPatternMatches,
  globPrefix,
  MAX_PATHS,
  MAX_TEXT,
} from '../src/file-audit/audit';
import {runFileAuditHook} from '../src/file-audit/hook';
import {
  parseSinceWindow,
  renderAuditReport,
  summarizeAuditLog,
  topFolder,
} from '../src/file-audit/report';
import {runHookDispatch} from '../src/hook-dispatch';
import {HOOK_HANDLERS} from '../src/hook-registry';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const NOW = new Date('2026-11-28T12:00:00.000Z');
const AUDIT_HANDLER = HOOK_HANDLERS.filter((h) => h.id === 'file-audit hook');

interface World {
  dev: string;
  env: Record<string, string | undefined>;
  home: string;
  logPath: string;
  outside: string;
  proj: string;
  root: string;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root != null) rmSync(root, {force: true, recursive: true});
  }
});

function world(
  sandbox: Record<string, unknown> = {
    enabled: true,
    excludedCommands: ['br *', 'gh *', 'bun *'],
  },
): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-audit-')));
  roots.push(root);
  const home = join(root, 'home');
  const dev = join(home, 'Dev');
  const proj = join(dev, 'proj');
  const outside = join(home, 'Dropbox');
  mkdirSync(proj, {recursive: true});
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({sandbox}),
  );
  writeFileSync(
    join(proj, 'justin-sdk.config.json'),
    JSON.stringify({components: []}),
  );
  return {
    dev,
    env: {
      CLAUDE_PROJECT_DIR: proj,
      HOME: home,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
    },
    home,
    logPath: join(root, 'state', 'claude-file-audit', 'access.jsonl'),
    outside,
    proj,
    root,
  };
}

function payload(
  w: World,
  tool: string,
  toolInput: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    cwd: w.proj,
    hook_event_name: 'PreToolUse',
    permission_mode: 'auto',
    session_id: 'session-1',
    tool_input: toolInput,
    tool_name: tool,
    tool_use_id: 'toolu_1',
    ...extra,
  });
}

function outcome(
  w: World,
  tool: string,
  toolInput: unknown,
  extra: Record<string, unknown> = {},
) {
  return auditToolCall({
    env: w.env,
    now: NOW,
    raw: payload(w, tool, toolInput, extra),
  });
}

function lineOf(result: ReturnType<typeof outcome>): AuditLine {
  if (result.kind !== 'log') {
    throw new Error(`expected a logged line, got ${result.kind}`);
  }
  return result.line;
}

function rawPaths(line: AuditLine): string[] {
  return line.paths.map((p) => p.raw);
}

function userConfig(w: World, config: unknown): void {
  const dir = join(w.root, 'config', 'justin-sdk');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// D2: file tools
// ---------------------------------------------------------------------------

describe('file tools (D2)', () => {
  test('a Read outside ~/Dev is logged, with the fields D4 names', () => {
    const w = world();
    const secret = join(w.outside, 'secret.txt');
    const line = lineOf(outcome(w, 'Read', {file_path: secret}));
    expect(line).toMatchObject({
      agent_id: null,
      agent_type: null,
      command: null,
      confidence: 'tool-input',
      cwd: w.proj,
      paths: [{access: 'read', raw: secret, resolved: secret}],
      paths_truncated: false,
      permission_mode: 'auto',
      reasons: ['outside-path'],
      session_id: 'session-1',
      tool: 'Read',
      tool_use_id: 'toolu_1',
      ts: NOW.toISOString(),
      unsandboxed: null,
      v: 1,
    });
  });

  test('NEGATIVE CONTROL: a Read inside ~/Dev logs nothing', () => {
    const w = world();
    writeFileSync(join(w.proj, 'a.ts'), '');
    expect(outcome(w, 'Read', {file_path: join(w.proj, 'a.ts')}).kind).toBe(
      'nothing',
    );
  });

  test('a relative path resolves against the payload cwd', () => {
    const w = world();
    expect(outcome(w, 'Read', {file_path: 'src/x.ts'}).kind).toBe('nothing');
    const line = lineOf(outcome(w, 'Read', {file_path: '../../Dropbox/x'}));
    expect(line.paths[0]?.resolved).toBe(join(w.outside, 'x'));
  });

  test('a symlink inside ~/Dev that points outside is logged', () => {
    const w = world();
    symlinkSync(w.outside, join(w.proj, 'link-out'));
    const line = lineOf(
      outcome(w, 'Read', {file_path: join(w.proj, 'link-out', 'secret.txt')}),
    );
    expect(line.paths[0]?.resolved).toBe(join(w.outside, 'secret.txt'));
  });

  test('a new file under ~/Dev is not logged; a new file outside is', () => {
    const w = world();
    expect(
      outcome(w, 'Write', {
        content: 'x',
        file_path: join(w.proj, 'new', 'deep', 'file.ts'),
      }).kind,
    ).toBe('nothing');
    const line = lineOf(
      outcome(w, 'Write', {
        content: 'x',
        file_path: join(w.outside, 'new', 'file.md'),
      }),
    );
    expect(line.paths[0]).toMatchObject({
      access: 'write',
      resolved: join(w.outside, 'new', 'file.md'),
    });
  });

  test('NEGATIVE CONTROL: Write content and Edit strings never appear in the log', () => {
    const w = world();
    const write = lineOf(
      outcome(w, 'Write', {
        content: 'WRITE-CONTENT-MARKER',
        file_path: join(w.outside, 'f.md'),
      }),
    );
    const edit = lineOf(
      outcome(w, 'Edit', {
        file_path: join(w.outside, 'f.md'),
        new_string: 'EDIT-NEW-MARKER',
        old_string: 'EDIT-OLD-MARKER',
      }),
    );
    expect(edit.paths[0]?.access).toBe('write');
    for (const line of [write, edit]) {
      const text = JSON.stringify(line);
      expect(text).not.toContain('WRITE-CONTENT-MARKER');
      expect(text).not.toContain('EDIT-NEW-MARKER');
      expect(text).not.toContain('EDIT-OLD-MARKER');
    }
    // An unreadable payload is logged with its raw text, unless it looks like
    // it holds file content.
    const broken = auditToolCall({
      env: w.env,
      now: NOW,
      raw: '{"tool_name":"Write","tool_input":{"content":"WRITE-CONTENT-MARKER"',
    });
    expect(JSON.stringify(broken)).not.toContain('WRITE-CONTENT-MARKER');
  });

  test('NotebookEdit is a write; Grep and Glob are searches', () => {
    const w = world();
    expect(
      lineOf(
        outcome(w, 'NotebookEdit', {
          new_source: 'x',
          notebook_path: join(w.outside, 'n.ipynb'),
        }),
      ).paths[0]?.access,
    ).toBe('write');
    expect(
      lineOf(outcome(w, 'Grep', {path: w.outside, pattern: 'x'})).paths[0]
        ?.access,
    ).toBe('search');
  });

  test('Grep with no path searches the cwd: outside ~/Dev it is logged', () => {
    const w = world();
    expect(outcome(w, 'Grep', {pattern: 'x'}).kind).toBe('nothing');
    const line = lineOf(outcome(w, 'Grep', {pattern: 'x'}, {cwd: w.outside}));
    expect(line.paths).toEqual([
      {access: 'search', category: 'temp', raw: w.outside, resolved: w.outside},
    ]);
  });

  test('a Glob pattern that is absolute or starts with ~ is a path (its literal prefix)', () => {
    const w = world();
    const absolute = lineOf(
      outcome(w, 'Glob', {pattern: `${w.outside}/**/*.md`}),
    );
    expect(rawPaths(absolute)).toEqual([`${w.outside}/`]);
    const home = lineOf(outcome(w, 'Glob', {pattern: '~/Dropbox/*.pdf'}));
    expect(home.paths[0]?.resolved).toBe(w.outside);
    expect(outcome(w, 'Glob', {pattern: '**/*.ts'}).kind).toBe('nothing');
    expect(globPrefix('/a/b*/c')).toBe('/a/b');
  });

  test('a path that cannot be resolved is logged, never treated as inside', () => {
    const w = world();
    const line = lineOf(
      outcome(w, 'Read', {file_path: 'x/y.ts'}, {cwd: undefined}),
    );
    expect(line.paths[0]).toMatchObject({raw: 'x/y.ts', resolved: null});
    const other = lineOf(outcome(w, 'Read', {file_path: '~nobody/x'}));
    expect(other.paths[0]?.resolved).toBeNull();
  });

  test('a file tool without its path field is logged as unparsed', () => {
    const w = world();
    const line = lineOf(outcome(w, 'Read', {}));
    expect(line.reasons).toEqual(['unparsed']);
    expect(line.why).toContain('file_path');
  });
});

describe('categories (D1)', () => {
  const places: AuditPlaces = {
    claudeState: ['/Users/u/.claude'],
    dev: '/Users/u/Dev',
    home: '/Users/u',
    temp: ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'],
  };

  test('temp, claude-state and other; device files are ignored', () => {
    expect(
      classifyPath('/private/tmp/nope-x', 'read', null, places)?.category,
    ).toBe('temp');
    expect(
      classifyPath('/Users/u/.claude/projects/x', 'read', null, places)
        ?.category,
    ).toBe('claude-state');
    expect(
      classifyPath('/Volumes/NoSuchDisk/x', 'read', null, places)?.category,
    ).toBe('other');
    for (const device of [
      '/dev/null',
      '/dev/stdout',
      '/dev/stderr',
      '/dev/tty',
    ]) {
      expect(classifyPath(device, 'unknown', null, places)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// D2 and D3: Bash
// ---------------------------------------------------------------------------

describe('Bash paths (D2)', () => {
  test('absolute, ~, $HOME and ../ arguments; redirects too; arguments-only', () => {
    const w = world();
    const line = lineOf(
      outcome(w, 'Bash', {
        command: `cat ${w.outside}/a ~/Dropbox/b "$HOME/Dropbox/c" ../../Dropbox/d > ${w.outside}/out 2>/dev/null`,
      }),
    );
    expect(line.confidence).toBe('arguments-only');
    expect(line.paths.map((p) => p.resolved)).toEqual([
      join(w.outside, 'a'),
      join(w.outside, 'b'),
      join(w.outside, 'c'),
      join(w.outside, 'd'),
      join(w.outside, 'out'),
    ]);
    expect(line.paths.every((p) => p.access === 'unknown')).toBe(true);
    expect(line.command).toContain('cat ');
  });

  test('a Bash call inside ~/Dev, sandboxed, logs nothing', () => {
    const w = world();
    expect(
      outcome(w, 'Bash', {command: 'ls src/ && cat ./README.md 2>&1'}).kind,
    ).toBe('nothing');
  });

  test('a cwd outside ~/Dev is logged for that reason', () => {
    const w = world();
    const line = lineOf(outcome(w, 'Bash', {command: 'ls'}, {cwd: w.outside}));
    expect(rawPaths(line)).toEqual([w.outside]);
  });

  test('substitutions are read too', () => {
    const w = world();
    const line = lineOf(
      outcome(w, 'Bash', {command: `echo $(cat ${w.outside}/inner)`}),
    );
    expect(line.paths[0]?.resolved).toBe(join(w.outside, 'inner'));
  });

  // F1 (live test, 2026-11-28): `D=/private/tmp/…` was resolved as a
  // relative path under the cwd and dropped.
  test('a path after = in an assignment or an option is read (F1)', () => {
    const w = world();
    const assigned = lineOf(
      outcome(w, 'Bash', {command: `D=${w.outside}/x cmd`}),
    );
    expect(assigned.paths.map((p) => [p.raw, p.resolved])).toEqual([
      [`${w.outside}/x`, join(w.outside, 'x')],
    ]);
    const option = lineOf(
      outcome(w, 'Bash', {command: `cmd --file=${w.outside}/y`}),
    );
    expect(rawPaths(option)).toEqual([`${w.outside}/y`]);
    const home = lineOf(
      outcome(w, 'Bash', {command: 'cmd --file=~/Dropbox/z'}),
    );
    expect(home.paths.map((p) => [p.raw, p.resolved])).toEqual([
      ['~/Dropbox/z', join(w.outside, 'z')],
    ]);
    expect(outcome(w, 'Bash', {command: `F=${w.dev}/x cmd`}).kind).toBe(
      'nothing',
    );
    expect(outcome(w, 'Bash', {command: 'a=b cmd'}).kind).toBe('nothing');
  });

  test('a command it cannot read is logged as unparsed, with the command', () => {
    const w = world();
    const line = lineOf(outcome(w, 'Bash', {command: 'echo "unclosed'}));
    expect(line.reasons).toEqual(['unparsed']);
    expect(line.command).toBe('echo "unclosed');
  });

  test('the command is cut at 2000 characters, the paths at 50', () => {
    const w = world();
    const many = Array.from(
      {length: MAX_PATHS + 5},
      (_, i) => `${w.outside}/f${i}`,
    ).join(' ');
    const line = lineOf(
      outcome(w, 'Bash', {command: `cat ${many} ${'x'.repeat(MAX_TEXT)}`}),
    );
    expect(line.paths).toHaveLength(MAX_PATHS);
    expect(line.paths_truncated).toBe(true);
    expect(line.command).toHaveLength(MAX_TEXT);
    expect(line.command_truncated).toBe(true);
  });
});

describe('Bash outside the sandbox (D3)', () => {
  test('the flag in the payload', () => {
    const w = world();
    const line = lineOf(
      outcome(w, 'Bash', {command: 'ls', dangerouslyDisableSandbox: true}),
    );
    expect(line.reasons).toEqual(['unsandboxed']);
    expect(line.unsandboxed).toEqual({
      inferred: false,
      pattern: null,
      position: null,
      source: 'flag',
      why: null,
    });
  });

  test('excludedCommands: the first simple command, then a later one', () => {
    const w = world();
    expect(
      lineOf(outcome(w, 'Bash', {command: 'br show x 2>&1 | head'}))
        .unsandboxed,
    ).toEqual({
      inferred: true,
      pattern: 'br *',
      position: 'first',
      source: 'excludedCommands',
      why: null,
    });
    expect(
      lineOf(outcome(w, 'Bash', {command: 'cd sub && gh pr list'})).unsandboxed,
    ).toMatchObject({pattern: 'gh *', position: 'later'});
    expect(outcome(w, 'Bash', {command: 'brew list'}).kind).toBe('nothing');
  });

  test('a command whose first word is bun is never excluded', () => {
    const w = world();
    expect(outcome(w, 'Bash', {command: 'bun run x'}).kind).toBe('nothing');
  });

  test('a sandbox that is not enabled', () => {
    const w = world({enabled: false});
    expect(
      lineOf(outcome(w, 'Bash', {command: 'ls'})).unsandboxed?.source,
    ).toBe('sandboxDisabled');
  });

  test('settings that cannot be read give source unknown, and a line', () => {
    const w = world();
    writeFileSync(join(w.home, '.claude', 'settings.json'), '{not json');
    const line = lineOf(outcome(w, 'Bash', {command: 'ls'}));
    expect(line.reasons).toEqual(['unsandboxed']);
    expect(line.unsandboxed).toMatchObject({inferred: true, source: 'unknown'});
    expect(line.unsandboxed?.why).toContain('settings.json');
  });

  test('pattern matching', () => {
    expect(excludedPatternMatches('br *', 'br')).toBe(true);
    expect(excludedPatternMatches('br *', 'br list')).toBe(true);
    expect(excludedPatternMatches('br *', 'brew list')).toBe(false);
    expect(excludedPatternMatches('br:*', 'br list')).toBe(true);
    expect(
      excludedPatternMatches(
        './node_modules/.bin/justin-sdk thread handoff *',
        './node_modules/.bin/justin-sdk thread handoff --note x',
      ),
    ).toBe(true);
    expect(excludedPatternMatches('xcrun', 'xcrun')).toBe(true);
  });
});

describe('MCP and other tools (D2)', () => {
  test('a string that is one whole path counts; prose that mentions one does not', () => {
    const w = world();
    const line = lineOf(
      outcome(w, 'mcp__files__read', {
        nested: {list: [`${w.outside}/a.txt`]},
        note: `please read ${w.outside}/b.txt for me`,
      }),
    );
    expect(rawPaths(line)).toEqual([`${w.outside}/a.txt`]);
    expect(line.confidence).toBe('arguments-only');
    expect(
      outcome(w, 'WebFetch', {prompt: 'x', url: 'https://example.com/a'}).kind,
    ).toBe('nothing');
  });

  test('agent_id and agent_type are recorded for a subagent call', () => {
    const w = world();
    const line = lineOf(
      outcome(
        w,
        'Read',
        {file_path: join(w.outside, 'x')},
        {agent_id: 'agent-7', agent_type: 'player'},
      ),
    );
    expect(line).toMatchObject({agent_id: 'agent-7', agent_type: 'player'});
  });
});

describe('unreadable payloads', () => {
  test('garbage is logged as unparsed with its raw text', () => {
    const w = world();
    const line = lineOf(auditToolCall({env: w.env, now: NOW, raw: 'garbage'}));
    expect(line).toMatchObject({
      raw: 'garbage',
      raw_truncated: false,
      reasons: ['unparsed'],
      why: 'the payload is not JSON',
    });
  });
});

// ---------------------------------------------------------------------------
// The off switch
// ---------------------------------------------------------------------------

describe('the off switch: componentConfig["file-audit"].enabled', () => {
  const read = (w: World) =>
    outcome(w, 'Read', {file_path: join(w.outside, 'secret.txt')}).kind;

  test('NEGATIVE CONTROL: false in the user file produces no line', () => {
    const w = world();
    expect(read(w)).toBe('log');
    userConfig(w, {componentConfig: {'file-audit': {enabled: false}}});
    expect(read(w)).toBe('off');
    expect(auditToolCall({env: w.env, now: NOW, raw: 'garbage'}).kind).toBe(
      'off',
    );
  });

  test('false in the repo config turns it off in that repo only', () => {
    const w = world();
    writeFileSync(
      join(w.proj, 'justin-sdk.config.json'),
      JSON.stringify({componentConfig: {'file-audit': {enabled: false}}}),
    );
    expect(read(w)).toBe('off');
    const elsewhere = {...w, env: {...w.env, CLAUDE_PROJECT_DIR: w.dev}};
    expect(read(elsewhere)).toBe('log');
  });

  test('true, absent, or a config that cannot be read leaves it on', () => {
    const w = world();
    userConfig(w, {componentConfig: {'file-audit': {enabled: true}}});
    expect(read(w)).toBe('log');
    writeFileSync(join(w.root, 'config', 'justin-sdk', 'config.json'), '{x');
    expect(read(w)).toBe('log');
  });
});

// ---------------------------------------------------------------------------
// D5: the hook never prints, never decides
// ---------------------------------------------------------------------------

function runCli(
  w: World,
  args: string[],
  stdin: string,
): {exitCode: number | null; stderr: string; stdout: string} {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: w.proj,
    env: {...w.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
    stdin: Buffer.from(stdin),
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

describe('the hook (D5, D6)', () => {
  test('NEGATIVE CONTROL: the real CLI prints nothing on stdout and appends one line', () => {
    const w = world();
    const secret = join(w.outside, 'secret.txt');
    const result = runCli(
      w,
      ['file-audit', 'hook'],
      payload(w, 'Read', {file_path: secret}),
    );
    expect(result).toMatchObject({exitCode: 0, stdout: ''});
    const lines = readFileSync(w.logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '') as AuditLine).paths[0]?.raw).toBe(
      secret,
    );
    // Inside ~/Dev: still silent, and nothing appended.
    expect(
      runCli(
        w,
        ['file-audit', 'hook'],
        payload(w, 'Read', {file_path: join(w.proj, 'x')}),
      ),
    ).toMatchObject({exitCode: 0, stdout: ''});
    expect(readFileSync(w.logPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('a log that cannot be written: exit 1, a stderr line, still no stdout', () => {
    const w = world();
    writeFileSync(join(w.root, 'state'), 'a file, not a directory');
    const errors: string[] = [];
    const code = runFileAuditHook({
      env: w.env,
      now: () => NOW,
      readStdin: () => payload(w, 'Read', {file_path: w.outside}),
      writeStderr: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join('')).toContain('could not write the audit log');
  });

  test('--help prints help, exits 0 and logs nothing', () => {
    const w = world();
    for (const args of [
      ['file-audit', '--help'],
      ['file-audit', 'hook', '--help'],
      ['file-audit', 'report', '--help'],
    ]) {
      const result = runCli(
        w,
        args,
        payload(w, 'Read', {file_path: w.outside}),
      );
      expect({args, exitCode: result.exitCode}).toEqual({args, exitCode: 0});
      expect(result.stdout).toContain('file-audit');
    }
    expect(existsSync(w.logPath)).toBe(false);
  });
});

describe('through the dispatcher (D5)', () => {
  function decisionFree(stdout: string): void {
    if (stdout === '') return;
    const json = JSON.parse(stdout) as Record<string, unknown>;
    expect(json.decision).toBeUndefined();
    expect(json.hookSpecificOutput).toBeUndefined();
    expect(stdout).not.toContain('permissionDecision');
  }

  test('NEGATIVE CONTROL: a logged call gives empty merged output, exit 0', async () => {
    const w = world();
    const merged = await runHookDispatch({
      env: w.env,
      event: 'PreToolUse',
      handlers: AUDIT_HANDLER,
      stdin: payload(w, 'Read', {file_path: w.outside}),
    });
    expect(merged).toEqual({exitCode: 0, stderr: '', stdout: ''});
    expect(existsSync(w.logPath)).toBe(true);
  });

  test('a write failure is one visible, non-blocking line', async () => {
    const w = world();
    writeFileSync(join(w.root, 'state'), 'a file, not a directory');
    const merged = await runHookDispatch({
      env: w.env,
      event: 'PreToolUse',
      handlers: AUDIT_HANDLER,
      stdin: payload(w, 'Read', {file_path: w.outside}),
    });
    expect(merged.exitCode).toBe(0);
    decisionFree(merged.stdout);
    expect(merged.stdout).toContain('file-audit hook failed (exit 1)');
  });

  test('a handler that throws, or hangs, never blocks or decides', async () => {
    const w = world();
    const thrown = await runHookDispatch({
      env: w.env,
      event: 'PreToolUse',
      handlerCommand: [process.execPath, '-e', 'throw new Error("boom")'],
      handlers: AUDIT_HANDLER,
      stdin: payload(w, 'Read', {file_path: w.outside}),
    });
    expect(thrown.exitCode).toBe(0);
    decisionFree(thrown.stdout);
    expect(thrown.stdout).toContain('file-audit hook failed (exit 1)');

    const hung = await runHookDispatch({
      env: w.env,
      event: 'PreToolUse',
      handlerCommand: [process.execPath, '-e', 'await Bun.sleep(10000)'],
      handlers: AUDIT_HANDLER,
      stdin: payload(w, 'Read', {file_path: w.outside}),
      timeoutMs: 200,
    });
    expect(hung.exitCode).toBe(0);
    decisionFree(hung.stdout);
    expect(hung.stdout).toContain('file-audit hook was stopped');
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe('file-audit report', () => {
  const home = '/Users/u';
  function logged(overrides: Partial<AuditLine>): string {
    const line: AuditLine = {
      agent_id: null,
      agent_type: null,
      command: null,
      command_truncated: false,
      confidence: 'tool-input',
      cwd: '/Users/u/Dev/p',
      paths: [],
      paths_truncated: false,
      permission_mode: 'auto',
      reasons: ['outside-path'],
      session_id: 's',
      tool: 'Read',
      tool_use_id: 't',
      ts: '2026-11-28T11:00:00.000Z',
      unsandboxed: null,
      v: 1,
      ...overrides,
    };
    return JSON.stringify(line);
  }
  const text = [
    logged({
      paths: [
        {
          access: 'read',
          category: 'other',
          raw: '/Users/u/Dropbox/a.md',
          resolved: '/Users/u/Dropbox/a.md',
        },
      ],
    }),
    logged({
      paths: [
        {
          access: 'read',
          category: 'temp',
          raw: '/tmp/x',
          resolved: '/private/tmp/x',
        },
      ],
    }),
    logged({
      command: 'br list',
      reasons: ['unsandboxed'],
      tool: 'Bash',
      unsandboxed: {
        inferred: true,
        pattern: 'br *',
        position: 'first',
        source: 'excludedCommands',
        why: null,
      },
    }),
    logged({
      paths: [
        {
          access: 'read',
          category: 'other',
          raw: '/Users/u/Dropbox/old.md',
          resolved: '/Users/u/Dropbox/old.md',
        },
      ],
      ts: '2026-10-01T00:00:00.000Z',
    }),
    'not json at all',
  ].join('\n');

  test('groups by folder, hides temp unless --all, counts unreadable lines', () => {
    const summary = summarizeAuditLog({
      all: false,
      home,
      now: NOW,
      sinceMs: parseSinceWindow('7d'),
      text,
    });
    expect(summary.logged).toBe(3);
    expect(summary.hiddenCalls).toBe(1);
    expect(summary.unreadableLines).toBe(1);
    expect([...summary.folders.keys()]).toEqual(['~/Dropbox']);
    const rendered = renderAuditReport({
      all: false,
      logPath: '/state/access.jsonl',
      since: '7d',
      style: PLAIN_STYLE,
      summary,
    });
    expect(rendered).toContain('~/Dropbox/a.md');
    expect(rendered).not.toContain('old.md');
    expect(rendered).toContain('excludedCommands (br *)');
    expect(rendered).toContain('1 line(s) of the log could not be read');
    expect(rendered).toContain('show them with --all');

    const all = summarizeAuditLog({
      all: true,
      home,
      now: NOW,
      sinceMs: null,
      text,
    });
    expect([...all.folders.keys()].sort()).toEqual([
      '/private/tmp',
      '~/Dropbox',
    ]);
    expect(all.logged).toBe(4);
  });

  test('windows and folders', () => {
    expect(parseSinceWindow('7d')).toBe(7 * 86_400_000);
    expect(parseSinceWindow('30m')).toBe(30 * 60_000);
    expect(parseSinceWindow('7')).toBeNull();
    expect(parseSinceWindow('0d')).toBeNull();
    expect(topFolder('/Users/u/Dropbox/x/y', home)).toBe('~/Dropbox');
    expect(topFolder('/Volumes/Disk/x', home)).toBe('/Volumes/Disk');
    expect(topFolder('/etc/hosts', home)).toBe('/etc');
  });

  test('the CLI says when there is no log yet, and reads one that exists', () => {
    const w = world();
    const none = runCli(w, ['file-audit', 'report'], '');
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain('No audit log yet');
    runCli(
      w,
      ['file-audit', 'hook'],
      payload(w, 'Read', {file_path: join(w.outside, 'secret.txt')}),
    );
    const some = runCli(w, ['file-audit', 'report', '--all'], '');
    expect(some.exitCode).toBe(0);
    expect(some.stdout).toContain('calls logged:');
    expect(some.stdout).toContain('secret.txt');
    expect(runCli(w, ['file-audit', 'path'], '').stdout.trim()).toBe(w.logPath);
  });
});
