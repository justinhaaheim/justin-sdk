/**
 * `thread quota` shows the session's newest quota-log lines (request
 * home-base-ys9t7.5 D9, home-base-ys9t7.5.4 item 7): readSessionLogLines
 * over a real file, and the section renderQuotaReport and quotaReportJson
 * build from it. Every state is said: no log yet, no line for this session,
 * an unreadable log.
 */

import type {SessionLogLines} from '../src/thread/quota-log';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  gatherQuotaReport,
  quotaReportJson,
  renderQuotaReport,
} from '../src/thread/quota-command';
import {quotaLogPath, readSessionLogLines} from '../src/thread/quota-log';
import {createSandbox} from './sandbox';

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const NOW = Date.parse('2030-01-01T12:00:00Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function world() {
  const sb = createSandbox();
  sandboxes.push(sb);
  const env = {
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg-config'),
    XDG_DATA_HOME: join(sb.path, 'xdg-data'),
    XDG_STATE_HOME: join(sb.path, 'xdg-state'),
  };
  const writeLog = (lines: string[]): void => {
    sb.writeFile('state/quota-events.jsonl', `${lines.join('\n')}\n`);
  };
  return {env, sb, writeLog};
}

const line = (fields: Record<string, unknown>): string =>
  JSON.stringify(fields);

describe('readSessionLogLines', () => {
  test('no log at all: none, with the path', () => {
    const {env} = world();
    expect(readSessionLogLines(SESSION, env)).toEqual({
      kind: 'none',
      path: quotaLogPath(env),
    });
  });

  test("the newest recheck and brake of THIS session, past other sessions' lines and a torn line", () => {
    const {env, writeLog} = world();
    writeLog([
      line({at: 't1', kind: 'recheck', sessionId: SESSION, verdict: 'old'}),
      line({action: 'wouldDeny', at: 't2', kind: 'brake', sessionId: SESSION}),
      line({at: 't3', kind: 'recheck', sessionId: SESSION, verdict: 'new'}),
      // Another session's lines, one of which names this session in its text.
      line({at: 't4', kind: 'recheck', sessionId: OTHER, verdict: 'other'}),
      line({
        action: 'deny',
        at: 't5',
        command: `echo ${SESSION}`,
        kind: 'brake',
        sessionId: OTHER,
      }),
      line({at: 't6', kind: 'gate', sessionId: SESSION}),
      `{"kind":"brake","sessionId":"${SESSION}","at":"t7`,
    ]);
    const read = readSessionLogLines(SESSION, env);
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.path).toBe(quotaLogPath(env));
    expect(read.recheck).toMatchObject({at: 't3', verdict: 'new'});
    expect(read.brake).toMatchObject({action: 'wouldDeny', at: 't2'});
  });

  test('a log with no line for this session: read, both null', () => {
    const {env, writeLog} = world();
    writeLog([line({at: 't1', kind: 'recheck', sessionId: OTHER})]);
    expect(readSessionLogLines(SESSION, env)).toMatchObject({
      brake: null,
      kind: 'read',
      recheck: null,
    });
  });

  test('a log that cannot be read is failed, never none', () => {
    const {env, sb} = world();
    mkdirSync(join(sb.path, 'state', 'quota-events.jsonl'), {recursive: true});
    const read = readSessionLogLines(SESSION, env);
    expect(read.kind).toBe('failed');
  });
});

describe('thread quota shows the quota log', () => {
  async function report(env: Record<string, string>) {
    return await gatherQuotaReport({
      cwd: env.HOME ?? '/',
      env,
      nowMs: NOW,
      sessionId: SESSION,
    });
  }

  test('the newest recheck and brake are shown, with the subagent and the limit', async () => {
    const {env, writeLog} = world();
    writeLog([
      line({
        at: '2030-01-01T11:59:00Z',
        attendance: 'unattended',
        kind: 'recheck',
        mode: 'observe',
        sessionId: SESSION,
        verdict: 'OVER: the week floor',
      }),
      line({
        action: 'wouldDeny',
        agentId: 'agent-7',
        at: '2030-01-01T11:59:01Z',
        kind: 'brake',
        limit: 'your week is at 83 %',
        sessionId: SESSION,
        toolName: 'Bash',
      }),
    ]);
    const log = readSessionLogLines(SESSION, env);
    const text = renderQuotaReport(await report(env), PLAIN_STYLE, log);
    expect(text).toContain('Quota log, this session');
    expect(text).toContain('2030-01-01T11:59:00Z');
    expect(text).toContain('OVER: the week floor');
    expect(text).toContain('wouldDeny');
    expect(text).toContain('agent-7');
    expect(text).toContain('your week is at 83 %');
    const json = quotaReportJson(await report(env), log);
    expect(json.log).toEqual(log);
  });

  test('each empty state says what it is', async () => {
    const {env} = world();
    const rep = await report(env);
    const states: [SessionLogLines, string][] = [
      [{kind: 'none', path: '/s/q.jsonl'}, 'none yet at /s/q.jsonl'],
      [
        {brake: null, kind: 'read', path: '/s/q.jsonl', recheck: null},
        'none for this session',
      ],
      [{kind: 'failed', reason: 'EISDIR'}, 'UNREADABLE: EISDIR'],
    ];
    for (const [log, said] of states) {
      expect(renderQuotaReport(rep, PLAIN_STYLE, log)).toContain(said);
    }
  });

  test('not read: no section and no key (the brake measures without it)', async () => {
    const {env} = world();
    const rep = await report(env);
    expect(renderQuotaReport(rep, PLAIN_STYLE)).not.toContain('Quota log');
    expect('log' in quotaReportJson(rep)).toBe(false);
  });
});
