/**
 * `thread quota` shows, for each group member, Claude Code's latest cost
 * figure beside the quota's estimate of the same session (home-base-ys9t7.8.1,
 * item 4), from a fake session-cost history and fake transcripts. Every path
 * is a sandbox; no claude runs.
 */

import type {GroupSpend} from '../src/thread/quota-group';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  gatherQuotaReport,
  quotaReportJson,
  renderQuotaReport,
} from '../src/thread/quota-command';
import {gatherMemberCosts} from '../src/thread/quota-member-cost';
import {createSandbox} from './sandbox';

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const NOW = Date.parse('2030-01-01T12:00:00Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** One request of claude-opus-5-5: $4 per M input, $20 per M output → $6. */
const ASSISTANT = JSON.stringify({
  message: {
    content: [{text: 'hi', type: 'text'}],
    id: 'msg_1',
    model: 'claude-opus-5-5',
    role: 'assistant',
    type: 'message',
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    },
  },
  requestId: 'req_1',
  timestamp: '2030-01-01T11:00:00.000Z',
  type: 'assistant',
});

function costLine(sessionId: string, usd: number, decreased = false): string {
  return JSON.stringify({
    at: '2030-01-01T11:50:00.000Z',
    ccVersion: '2.1.312',
    cwd: '/r',
    decreased,
    linesAdded: null,
    linesRemoved: null,
    modelId: 'claude-opus-5-5',
    previousCostUsd: null,
    project: 'r',
    projectDir: '/r',
    schema: 1,
    sessionId,
    totalApiDurationMs: null,
    totalCostUsd: usd,
    totalDurationMs: null,
    transcriptPath: null,
  });
}

function world() {
  const sb = createSandbox();
  sandboxes.push(sb);
  const env = {
    CLAUDE_USAGE_DATA_DIR: join(sb.path, 'usage-data'),
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg-config'),
    XDG_DATA_HOME: join(sb.path, 'xdg-data'),
    XDG_STATE_HOME: join(sb.path, 'xdg-state'),
  };
  sb.writeFile(`projects/-r/${SESSION}.jsonl`, `${ASSISTANT}\n`);
  sb.writeFile(`projects/-r/${OTHER}.jsonl`, '');
  const main = join(sb.path, 'projects', '-r', `${SESSION}.jsonl`);
  const other = join(sb.path, 'projects', '-r', `${OTHER}.jsonl`);
  return {env, main, other, sb};
}

function knownGroup(main: string, other: string): GroupSpend {
  return {
    firstUnattendedAtMs: null,
    kind: 'known',
    latestTypedAtMs: null,
    members: [
      {
        beadId: 'b-1',
        files: [main],
        sessionId: SESSION,
        spawnKickoff: false,
        typedLines: 0,
      },
      {
        beadId: 'b-2',
        files: [other],
        sessionId: OTHER,
        spawnKickoff: false,
        typedLines: 0,
      },
    ],
    requests: 0,
    root: 'b-1',
    spend: {
      byFamily: {
        fable: {usd: 0, weekPercent: 0},
        opus: {usd: 0, weekPercent: 0},
        other: {usd: 0, weekPercent: 0},
        sonnet: {usd: 0, weekPercent: 0},
      },
      usd: 0,
      weekPercent: 0,
    },
    typed: {kind: 'complete', latestTypedAtMs: null},
    unparseableLines: 0,
  };
}

describe('thread quota: Claude Code’s figure per member', () => {
  test('each member shows its latest figure, the estimate and the gap; one with no line says so', async () => {
    const {env, main, other, sb} = world();
    sb.writeFile(
      'usage-data/session-cost.jsonl',
      `${costLine(SESSION, 5)}\n${costLine(SESSION, 6.3)}\n${costLine('someone-else', 9)}\n`,
    );
    const base = await gatherQuotaReport({
      cwd: env.HOME,
      env,
      nowMs: NOW,
      sessionId: SESSION,
    });
    const report = {...base, group: knownGroup(main, other)};
    const costs = await gatherMemberCosts({env, group: report.group});
    expect(costs.history.kind).toBe('ok');
    expect(costs.members.map((m) => m.claudeCode.kind)).toEqual([
      'known',
      'none',
    ]);
    expect(costs.members[0]?.estimate).toEqual({
      files: 1,
      kind: 'known',
      usd: 6,
    });
    expect(costs.members[0]?.gapUsd).toBeCloseTo(-0.3, 9);

    const text = renderQuotaReport(report, PLAIN_STYLE, null, costs);
    expect(text).toContain(
      'Claude Code:     $6.30 at 2030-01-01T11:50:00Z (10 min ago)',
    );
    expect(text).toContain(
      'quota estimate:  $6.00 (whole session, subagents included); gap -$0.30 (4.8 % below)',
    );
    expect(text).toContain('none recorded for this session');
    const json = quotaReportJson(report, null, costs);
    expect(json.memberCosts).toEqual(costs);
  });

  test('an unresolved group still shows each member, its transcript found by id', async () => {
    const {env, sb} = world();
    sb.writeFile('usage-data/session-cost.jsonl', `${costLine(SESSION, 6)}\n`);
    const base = await gatherQuotaReport({
      cwd: env.HOME,
      env,
      nowMs: NOW,
      sessionId: SESSION,
    });
    const group: GroupSpend = {
      kind: 'unknown',
      lowerBound: null,
      members: [{beadId: 'b-1', sessionId: SESSION, spawnKickoff: false}],
      reason: 'a bead could not be read',
      typed: {kind: 'unknown', reason: 'a bead could not be read'},
    };
    const costs = await gatherMemberCosts({env, group});
    const text = renderQuotaReport({...base, group}, PLAIN_STYLE, null, costs);
    expect(text).toContain('Claude Code:     $6.00');
    expect(text).toContain('gap +$0.00');
  });

  test('no history yet: said, with its path; not read: no fields, no key', async () => {
    const {env, main, other} = world();
    const base = await gatherQuotaReport({
      cwd: env.HOME,
      env,
      nowMs: NOW,
      sessionId: SESSION,
    });
    const report = {...base, group: knownGroup(main, other)};
    const costs = await gatherMemberCosts({env, group: report.group});
    expect(costs.history.kind).toBe('missing');
    expect(renderQuotaReport(report, PLAIN_STYLE, null, costs)).toContain(
      'none recorded: ',
    );
    expect(renderQuotaReport(report, PLAIN_STYLE)).not.toContain(
      'Claude Code:',
    );
    expect('memberCosts' in quotaReportJson(report)).toBe(false);
  });
});
