/**
 * Printing reaches a pipe whole and only once (home-base-p05kz.2).
 *
 * Every case here runs a REAL bun process through a REAL pipe, because the
 * failures only exist there: a mocked stream has no O_NONBLOCK and no 64 KiB
 * buffer. The reader sleeps first, so the pipe is full while the child prints.
 *
 * 130 KB is the size that repeated with Bun.write and was cut by console.log.
 * 1 MB is over Bun.write's 262,144-unit limit, so it was only cut by console.log.
 * The measurements are in src/write-stdout.ts.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {buildDocument, TAIL_LINE} from './fixtures/write-stdout-child';

const CHILD = join(import.meta.dir, 'fixtures', 'write-stdout-child.ts');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const KB_130 = 130 * 1024;
const MB_1 = 1024 * 1024;

const SLOW_READER = '(sleep 0.5; cat)';

interface ShellRun {
  shellStatus: number;
  stderr: string;
  stdout: Uint8Array;
}

/** bash, because `PIPESTATUS` is how a shell reports the writer's own status. */
async function shell(script: string): Promise<ShellRun> {
  const proc = Bun.spawn(['/bin/bash', '-c', script], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  return {
    shellStatus: await proc.exited,
    stderr,
    stdout: new Uint8Array(stdout),
  };
}

/** What `command` prints with its stdout redirected to a file. */
async function writtenToFile(command: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'write-stdout-'));
  try {
    const path = join(dir, 'output');
    await shell(`${command} > ${path}`);
    return readFileSync(path);
  } finally {
    rmSync(dir, {force: true, recursive: true});
  }
}

function text(run: ShellRun): string {
  return Buffer.from(run.stdout).toString('utf8');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The writer's exit status, which `head` would otherwise hide. */
function writerStatusScript(pipeline: string): string {
  return `${pipeline}; echo "writer-status=\${PIPESTATUS[0]}"`;
}

function writerStatus(run: ShellRun): number | null {
  const match = /writer-status=(\d+)/u.exec(text(run));
  return match == null ? null : Number(match[1]);
}

const CALLS = ['async', 'sync'] as const;

describe('writeStdout through a real pipe with a slow reader', () => {
  for (const call of CALLS) {
    test(`${call}: 130 KB after a read of process.stdout arrives once and whole (the inbox repeat, and the console.log cut)`, async () => {
      const run = await shell(
        `bun ${CHILD} ${call} read-stdout ${KB_130} 0 | ${SLOW_READER}`,
      );
      const document = buildDocument(KB_130);
      expect(run.stderr).toBe('');
      expect(occurrences(text(run), 'line 000000')).toBe(1);
      expect(run.stdout.length).toBe(Buffer.byteLength(document));
      expect(text(run)).toBe(document);
    });

    test(`${call}: 1 MB after a read of process.stdout arrives whole (the console.log cut, above Bun.write's limit)`, async () => {
      const run = await shell(
        `bun ${CHILD} ${call} read-stdout ${MB_1} 0 | ${SLOW_READER}`,
      );
      expect(run.stderr).toBe('');
      expect(text(run)).toBe(buildDocument(MB_1));
    });

    test(`${call}: 130 KB with no read of process.stdout arrives whole`, async () => {
      const run = await shell(
        `bun ${CHILD} ${call} none ${KB_130} 0 | ${SLOW_READER}`,
      );
      expect(run.stderr).toBe('');
      expect(text(run)).toBe(buildDocument(KB_130));
    });
  }

  test('a small line printed through the helper after the document arrives after it', async () => {
    const run = await shell(
      `bun ${CHILD} async read-stdout ${KB_130} 0 helper | ${SLOW_READER}`,
    );
    expect(text(run)).toBe(`${buildDocument(KB_130)}${TAIL_LINE}`);
  });

  test('the same bytes reach a pipe and a file', async () => {
    const piped = await shell(
      `bun ${CHILD} async read-stdout ${KB_130} 0 | ${SLOW_READER}`,
    );
    const toFile = await writtenToFile(
      `bun ${CHILD} async read-stdout ${KB_130} 0`,
    );
    expect(toFile.length).toBe(Buffer.byteLength(buildDocument(KB_130)));
    expect(Buffer.compare(piped.stdout, toFile)).toBe(0);
  });
});

describe('a real SDK command, on fixed data over 64 KB', () => {
  // `config schema --json` depends on no live data, and reads process.stdout
  // the way every SDK command does, so a file and a pipe must match exactly.
  test('`config schema --json` is byte-identical through a pipe and to a file, and parses', async () => {
    const command = `bun ${CLI} config schema --json`;
    const toFile = await writtenToFile(command);
    expect(toFile.length).toBeGreaterThan(65_536);
    const piped = await shell(`${command} | ${SLOW_READER}`);
    expect(piped.stderr).toBe('');
    expect(Buffer.compare(piped.stdout, toFile)).toBe(0);
    expect(() => {
      JSON.parse(text(piped));
    }).not.toThrow();
  });

  test('`config schema --json | head -1` leaves stderr empty and exits 0', async () => {
    const run = await shell(
      writerStatusScript(`bun ${CLI} config schema --json | head -1`),
    );
    expect(run.stderr).toBe('');
    expect(writerStatus(run)).toBe(0);
  });
});

describe('writeStdout when the reader goes away', () => {
  for (const call of CALLS) {
    for (const prior of ['read-stdout', 'none']) {
      test(`${call}, ${prior}: \`| head -1\` leaves stderr empty and the exit status unchanged`, async () => {
        const run = await shell(
          writerStatusScript(
            `bun ${CHILD} ${call} ${prior} ${MB_1} 7 | head -1`,
          ),
        );
        expect(run.stderr).toBe('');
        expect(writerStatus(run)).toBe(7);
        expect(text(run).startsWith('line 000000')).toBe(true);
      });
    }
  }

  for (const tail of ['console', 'stream', 'helper']) {
    test(`a small ${tail} line after the reader left stays quiet too`, async () => {
      const run = await shell(
        writerStatusScript(
          `bun ${CHILD} async read-stdout ${MB_1} 7 ${tail} | head -1`,
        ),
      );
      expect(run.stderr).toBe('');
      expect(writerStatus(run)).toBe(7);
    });
  }
});

describe('writeStdout when the write fails for any other reason', () => {
  // fd 1 opened read-only: a real write error (EBADF) that is not a closed pipe.
  for (const call of CALLS) {
    test(`${call}: stdout that cannot be written reports the error and exits non-zero`, async () => {
      const run = await shell(
        `bun ${CHILD} ${call} read-stdout ${KB_130} 0 1</dev/null; echo "writer-status=$?"`,
      );
      expect(run.stderr).toContain('EBADF');
      const status = /writer-status=(\d+)/u.exec(run.stderr + text(run));
      // The echo's own stdout is the shell's, which is still the test's pipe.
      expect(status?.[1]).toBeDefined();
      expect(Number(status?.[1])).not.toBe(0);
    });
  }

  test('a real SDK command that cannot write its document exits non-zero and says why', async () => {
    const run = await shell(
      `bun ${CLI} config schema 1</dev/null; echo "writer-status=$?"`,
    );
    expect(run.stderr).toContain('EBADF');
    expect(writerStatus(run)).not.toBeNull();
    expect(writerStatus(run)).not.toBe(0);
  });
});
