/**
 * home-base-ruaep.1: reading cmux's `-previous` layout, judging each tab's
 * tty against it, and the live join placing no process on a stale tab.
 */

import type {LiveSurface, Proc} from '../src/thread/pane-join';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {readRestoredTtys} from '../src/thread/cmux-session-file';
import {joinLiveSessions} from '../src/thread/live-sessions';
import {ttyProofOf, ttyStandingOf} from '../src/thread/stale-tty';
import {restoredTtys, UNREADABLE_PREVIOUS} from './stale-tty-fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function tempFile(text: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-tty-'));
  dirs.push(dir);
  const path = join(dir, 'session-com.cmuxterm.app-previous.json');
  if (text != null) writeFileSync(path, text);
  return path;
}

const SURFACE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SURFACE_B = 'aaaaaaaa-0000-4000-8000-000000000002';

function surface(id: string, ref: string, tty: string): LiveSurface {
  return {
    id: id.toUpperCase(),
    paneRef: 'pane:1',
    ref,
    title: null,
    tty,
    type: 'terminal',
    workspaceId: 'C0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    workspaceRef: 'workspace:1',
    workspaceTitle: null,
  };
}

describe('readRestoredTtys', () => {
  test('reads each panel’s ttyName by upper-cased id, and the file’s mtime', () => {
    const path = tempFile(
      JSON.stringify({
        version: 1,
        windows: [
          {
            tabManager: {
              workspaces: [
                {
                  panels: [
                    {id: SURFACE_A, ttyName: 'ttys000'},
                    {id: SURFACE_B},
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    const read = readRestoredTtys(path);
    if (read.kind !== 'read') throw new Error(read.reason);
    expect([...read.ttyByPanel.entries()]).toEqual([
      [SURFACE_A.toUpperCase(), 'ttys000'],
      [SURFACE_B.toUpperCase(), null],
    ]);
    expect(read.writtenAtMs).toBeGreaterThan(0);
  });

  test('a missing file and a corrupt file are failures that name the file, never an empty layout (rule 7)', () => {
    const missing = tempFile(null);
    expect(readRestoredTtys(missing)).toEqual({
      file: missing,
      kind: 'failed',
      reason: `no cmux session file at ${missing}`,
    });
    const corrupt = tempFile('{"windows": [');
    const read = readRestoredTtys(corrupt);
    expect(read.kind).toBe('failed');
    if (read.kind === 'failed') expect(read.reason).toContain(corrupt);
  });
});

describe('ttyProofOf / ttyStandingOf', () => {
  const a = surface(SURFACE_A, 'surface:1', 'ttys000');
  test('the same tty as at launch is stale; another tty, or not listed, is proven', () => {
    expect(
      ttyStandingOf(
        ttyProofOf([a], restoredTtys({[SURFACE_A]: '/dev/ttys000'})),
        a,
      ),
    ).toEqual({kind: 'stale', tty: 'ttys000'});
    expect(
      ttyStandingOf(ttyProofOf([a], restoredTtys({[SURFACE_A]: 'ttys069'})), a),
    ).toEqual({kind: 'proven'});
    expect(
      ttyStandingOf(ttyProofOf([a], restoredTtys({[SURFACE_B]: 'ttys000'})), a),
    ).toEqual({kind: 'proven'});
  });
  test('an unreadable layout leaves every terminal tab with a tty unproven', () => {
    expect(ttyStandingOf(ttyProofOf([a], UNREADABLE_PREVIOUS), a).kind).toBe(
      'unproven',
    );
  });
});

describe('joinLiveSessions with a stale tab', () => {
  const claude: Proc = {
    command:
      '/Users/jhaa/.local/bin/claude --session-id 11111111-1111-4111-8111-111111111111',
    etime: '01:00',
    exePath: '/Users/jhaa/.local/bin/claude',
    name: 'claude',
    pid: 1001,
    ppid: 1,
    tty: 'ttys000',
  };
  const a = surface(SURFACE_A, 'surface:1', 'ttys000');
  const join1 = (stale: boolean) =>
    joinLiveSessions({
      agents: [],
      procs: [claude],
      screens: new Map(),
      store: {},
      surfaces: [a],
      ttyProof: ttyProofOf(
        [a],
        restoredTtys(stale ? {[SURFACE_A]: 'ttys000'} : {}),
      ),
    }).bySessionId.get('11111111-1111-4111-8111-111111111111');

  test('a process on a tty only a stale tab reports is placed on no tab', () => {
    expect(join1(true)).toEqual({
      pid: 1001,
      source: 'ps',
      surfaceId: null,
      workspaceId: null,
    });
  });
  test('the same tab not stale is placed as before', () => {
    expect(join1(false)?.surfaceId).toBe(SURFACE_A.toUpperCase());
  });
});
