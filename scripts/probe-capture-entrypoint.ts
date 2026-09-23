#!/usr/bin/env bun
/**
 * How does a hook tell a `claude -p` session from a `claude --bg` one?
 * (home-base-k0b8n.9, K10(a).)
 *
 * `thread capture` must SKIP non-interactive `claude -p` runs — scripts that
 * probe the model a hundred times a day are not conversations — and must KEEP
 * justin-loop's `claude --bg` sessions, which are the most important unattended
 * work there is. Transcripts record an `entrypoint` field ('cli', 'sdk-cli',
 * 'claude-desktop'), but a hook runs at UserPromptSubmit, possibly before the
 * transcript has a record, so what the hook can actually SEE is its own
 * environment and its stdin payload.
 *
 * This spawns one real session in each mode, in a throwaway fixture project
 * whose UserPromptSubmit and Stop hooks write `$CLAUDE_CODE_ENTRYPOINT` and the
 * payload's key list to files. It then reads each session's transcript
 * `entrypoint` too, so hook-time and transcript evidence can be compared.
 *
 * It is NOT part of `bun test`: it spends real quota (two haiku turns) and
 * needs a logged-in `claude`, like `scripts/probe-bg-env.ts`. Re-run it when the
 * `claude` version moves.
 *
 * SAFETY: it stops and removes ONLY the agent id its own `--bg` dispatch
 * printed. Everything it writes carries a [TEST_DATA_DELETABLE <uuid> ] marker.
 */

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';

const HELP = `probe-capture-entrypoint — what a hook sees in a \`claude -p\` vs a \`claude --bg\` session

Usage: bun run probe:capture-entrypoint [options]

  --model <m>        Model for both sessions (default: haiku).
  --timeout-min <n>  How long to wait for the --bg session's Stop hook (default: 5).
  --skip-bg          Measure only \`claude -p\`.
  --help             Print this and do nothing else.

For each mode it prints: the hook's CLAUDE_CODE_ENTRYPOINT at UserPromptSubmit
and at Stop, the payload keys each hook received, and the transcript's own
\`entrypoint\` field. Spends two short haiku turns. Stops and removes only the
background agent row it created.
`;

interface Options {
  model: string;
  skipBg: boolean;
  timeoutMin: number;
}

function parseArgs(argv: string[]): Options | null {
  const opts: Options = {model: 'haiku', skipBg: false, timeoutMin: 5};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--skip-bg') opts.skipBg = true;
    else if (arg === '--model') opts.model = argv[++i] ?? opts.model;
    else if (arg === '--timeout-min')
      opts.timeoutMin = Number(argv[++i] ?? opts.timeoutMin);
    else {
      process.stderr.write(`unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return opts;
}

/** The real `claude`, not a cmux shim (same reasoning as probe-bg-env.ts). */
function resolveClaude(): string {
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const found = spawnSync('command', ['-v', 'claude'], {
    encoding: 'utf-8',
    shell: true,
  });
  const path = (found.stdout ?? '').trim();
  if (found.status !== 0 || path === '') {
    process.stderr.write('no `claude` binary found\n');
    process.exit(2);
  }
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A hook command that records what the hook process can see. `jq` is not
 * assumed; the payload is saved whole and its keys are read back in TypeScript.
 */
function hookCommand(fixture: string, event: string): string {
  const payload = join(fixture, `${event}-payload.json`);
  const entry = join(fixture, `${event}-entrypoint.txt`);
  return `cat > '${payload}'; printf '%s' "\${CLAUDE_CODE_ENTRYPOINT-<unset>}" > '${entry}'`;
}

function makeFixture(marker: string, mode: string): string {
  const fixture = mkdtempSync(
    join(tmpdir(), `capture-entrypoint-probe-${mode}-${marker}-`),
  );
  mkdirSync(join(fixture, '.claude'), {recursive: true});
  writeFileSync(
    join(fixture, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {hooks: [{command: hookCommand(fixture, 'Stop'), type: 'command'}]},
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command: hookCommand(fixture, 'UserPromptSubmit'),
                  type: 'command',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixture, 'README-TEST-DATA.txt'),
    `[TEST_DATA_DELETABLE ${marker} ]\n\nDisposable fixture for probe-capture-entrypoint. Safe to delete.\n`,
  );
  return fixture;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

interface ModeResult {
  mode: string;
  stopEntrypoint: string | null;
  stopKeys: string[] | null;
  transcriptEntrypoints: string[] | null;
  upsEntrypoint: string | null;
  upsKeys: string[] | null;
}

function payloadKeys(path: string): string[] | null {
  const raw = readOrNull(path);
  if (raw == null) return null;
  try {
    return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
  } catch {
    return [`<unparseable: ${raw.slice(0, 60)}>`];
  }
}

/** Every distinct `entrypoint` value in the transcript the payload names. */
function transcriptEntrypoints(fixture: string): string[] | null {
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const raw = readOrNull(join(fixture, `${event}-payload.json`));
    if (raw == null) continue;
    const path = (JSON.parse(raw) as {transcript_path?: string})
      .transcript_path;
    if (path == null) continue;
    const text = readOrNull(path);
    if (text == null) continue;
    return [...new Set(text.match(/"entrypoint":"[^"]*"/g) ?? [])].sort();
  }
  return null;
}

function collect(mode: string, fixture: string): ModeResult {
  return {
    mode,
    stopEntrypoint: readOrNull(join(fixture, 'Stop-entrypoint.txt')),
    stopKeys: payloadKeys(join(fixture, 'Stop-payload.json')),
    transcriptEntrypoints: transcriptEntrypoints(fixture),
    upsEntrypoint: readOrNull(join(fixture, 'UserPromptSubmit-entrypoint.txt')),
    upsKeys: payloadKeys(join(fixture, 'UserPromptSubmit-payload.json')),
  };
}

/**
 * The environment a session launched from a plain terminal would have: the
 * CLAUDE_* variables of THIS process are removed, because a nested claude that
 * inherits `CLAUDE_CODE_ENTRYPOINT=cli` from its parent would measure the parent.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE') || key.startsWith('JUSTIN_')) continue;
    env[key] = value;
  }
  return env;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts == null) {
    process.stdout.write(HELP);
    return 0;
  }
  const claudeBin = resolveClaude();
  const version = (
    spawnSync(claudeBin, ['--version'], {encoding: 'utf-8'}).stdout ?? ''
  ).trim();
  const marker = randomUUID().toUpperCase();
  const prompt = `[TEST_DATA_DELETABLE ${marker} ] entrypoint probe. Reply with the single word ok and nothing else. Use no tools.`;
  process.stdout.write(`claude ${version} · marker ${marker}\n`);

  const results: ModeResult[] = [];

  const pFixture = makeFixture(marker, 'p');
  const p = spawnSync(claudeBin, ['-p', '--model', opts.model, prompt], {
    cwd: pFixture,
    encoding: 'utf-8',
    env: cleanEnv(),
    timeout: 180_000,
  });
  process.stdout.write(
    `-p exit ${p.status ?? 'null'} · stdout ${JSON.stringify((p.stdout ?? '').trim().slice(0, 40))}\n`,
  );
  results.push(collect('claude -p', pFixture));

  if (!opts.skipBg) {
    const bgFixture = makeFixture(marker, 'bg');
    const dispatched = spawnSync(
      claudeBin,
      [
        '--bg',
        '--name',
        `TEST_DATA_DELETABLE ${marker} entrypoint probe`,
        '--model',
        opts.model,
        prompt,
      ],
      {cwd: bgFixture, encoding: 'utf-8', env: cleanEnv(), timeout: 120_000},
    );
    const banner = `${dispatched.stdout ?? ''}${dispatched.stderr ?? ''}`;
    const agentId = /\b([0-9a-f]{8})\b/.exec(banner)?.[1] ?? null;
    process.stdout.write(`--bg banner: ${banner.trim().slice(0, 200)}\n`);
    if (agentId != null) {
      const deadline = Date.now() + opts.timeoutMin * 60_000;
      while (
        Date.now() < deadline &&
        !existsSync(join(bgFixture, 'Stop-entrypoint.txt'))
      ) {
        await sleep(3_000);
      }
      const stop = spawnSync(claudeBin, ['stop', agentId], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
      const rm = spawnSync(claudeBin, ['rm', agentId], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
      process.stdout.write(
        `cleanup: stop ${agentId} exit ${stop.status ?? 'null'} · rm ${agentId} exit ${rm.status ?? 'null'}\n`,
      );
    }
    results.push(collect('claude --bg', bgFixture));
  }

  for (const r of results) {
    process.stdout.write(
      [
        '',
        r.mode,
        `  hook env CLAUDE_CODE_ENTRYPOINT  UserPromptSubmit=${r.upsEntrypoint ?? '(hook did not run)'}  Stop=${r.stopEntrypoint ?? '(hook did not run)'}`,
        `  transcript entrypoint           ${r.transcriptEntrypoints?.join(' ') ?? '(transcript not read)'}`,
        `  UserPromptSubmit payload keys   ${r.upsKeys?.join(', ') ?? '(none)'}`,
        `  Stop payload keys               ${r.stopKeys?.join(', ') ?? '(none)'}`,
      ].join('\n') + '\n',
    );
  }
  const probeDirs = readdirSync(tmpdir()).filter((name) =>
    name.includes(marker),
  );
  process.stdout.write(
    `\nfixtures (safe to delete): ${probeDirs.join(', ')}\n`,
  );
  return 0;
}

process.exit(await main());
