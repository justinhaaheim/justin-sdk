#!/usr/bin/env bun
/**
 * Does an environment variable set on a `claude --bg` invocation reach that
 * session's Bash tool? (home-base-k0b8n.5, epic home-base-1r6d.33 D18.)
 *
 * The justin-loop runner hands the successor its predecessor's session id on
 * the dispatch's environment (`JUSTIN_LOOP_PREDECESSOR_SESSION_ID`). That
 * channel is only worth anything if the variable survives the trip through
 * `claude --bg` and the agent daemon into the session's own process — and the
 * only thing measured before this script was PATH inheritance (e2e, 2026-09-09).
 * Inheriting PATH is not evidence: a launcher can rebuild PATH deliberately
 * while dropping everything else.
 *
 * So this spawns ONE real background session on the cheapest model, sets one
 * variable on it, and asks it to write that variable's value to a file. The
 * verdict is read off the file, not off the session's prose.
 *
 * It is NOT part of `bun test`: it spends real quota and needs a logged-in
 * `claude`, exactly like `scripts/e2e-justin-loop.ts`. Re-run it when the
 * `claude` version moves and the answer starts mattering again.
 *
 * SAFETY: it stops and removes ONLY the agent id its own dispatch printed. It
 * never passes `--all` to `stop` or `rm`, and it never touches a row it did not
 * create — the agent list on this machine routinely holds a hundred rows
 * belonging to other sessions.
 */

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';

const BOLD = '\u001B[1m';
const DIM = '\u001B[2m';
const RED = '\u001B[31m';
const GREEN = '\u001B[32m';
const RESET = '\u001B[0m';

const PROBE_ENV_VAR = 'JUSTIN_LOOP_PROBE_VALUE';

const HELP = `probe-bg-env — does an env var set on \`claude --bg\` reach the session's Bash tool?

Usage: bun run probe:bg-env [options]

  --model <m>        Model for the probe session (default: haiku).
  --timeout-min <n>  How long to wait for the session to write the file (default: 5).
  --keep             Leave the fixture directory and the agent row in place.
  --help             Print this and do nothing else.

Spawns ONE background session, sets ${PROBE_ENV_VAR} on its invocation, and asks
it to echo that value into a file. Prints PROPAGATED or NOT PROPAGATED, with the
\`claude\` version, and stops and removes only the row it created.

Everything it writes is named with a [TEST_DATA_DELETABLE <uuid> ] marker.
`;

interface Options {
  keep: boolean;
  model: string;
  timeoutMin: number;
}

function parseArgs(argv: string[]): Options | null {
  const opts: Options = {keep: false, model: 'haiku', timeoutMin: 5};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--model') {
      opts.model = argv[++i] ?? opts.model;
    } else if (arg === '--timeout-min') {
      opts.timeoutMin = Number(argv[++i] ?? opts.timeoutMin);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * The real `claude`, not whatever shim is first on PATH — cmux installs one that
 * intercepts subcommands, and an intercepted `claude stop` is a cleanup that
 * silently does nothing (same reasoning as the e2e script).
 */
function resolveClaude(): string {
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const found = spawnSync('command', ['-v', 'claude'], {
    encoding: 'utf-8',
    shell: true,
  });
  const path = (found.stdout ?? '').trim();
  if (found.status !== 0 || path === '') {
    process.stderr.write(
      'no `claude` binary found — this probe needs a logged-in claude\n',
    );
    process.exit(2);
  }
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The short agent id `claude --bg` prints, or null when it printed none. */
function parseBackgroundedId(banner: string): string | null {
  const match = /\b([0-9a-f]{8})\b/.exec(banner);
  return match?.[1] ?? null;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts == null) {
    process.stdout.write(HELP);
    return 0;
  }

  const claudeBin = resolveClaude();
  const version = spawnSync(claudeBin, ['--version'], {encoding: 'utf-8'});
  const claudeVersion = (version.stdout ?? '').trim();

  const marker = randomUUID().toUpperCase();
  const tag = `[TEST_DATA_DELETABLE ${marker} ]`;
  const probeValue = `PROPAGATED-${marker}`;

  const fixture = mkdtempSync(
    join(tmpdir(), `justin-loop-env-probe-${marker}-`),
  );
  mkdirSync(join(fixture, '.claude'), {recursive: true});
  // The probe's one Bash command must not stop for a permission prompt. A
  // settings file passed with `--settings` is the fixture's own allowance and
  // touches nothing on this machine — `--permission-mode auto` is unavailable
  // on haiku and falls back to asking, and `bypassPermissions` is refused by
  // `claude --bg` until the disclaimer has been accepted interactively.
  const settingsPath = join(fixture, '.claude', 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({permissions: {allow: ['Bash']}}, null, 2),
  );
  writeFileSync(
    join(fixture, 'README-TEST-DATA.txt'),
    `${tag}\n\nDisposable fixture for the justin-loop env-propagation probe. Safe to delete.\n`,
  );
  const outPath = join(fixture, `TEST_DATA_DELETABLE-${marker}.txt`);

  const prompt = `Run exactly this one Bash command, then reply DONE and stop. Use no other tool. Read no files. Change nothing else.

echo "${tag} PROBE_RESULT=[$${PROBE_ENV_VAR}]" > ${outPath}`;

  process.stdout.write(
    `${BOLD}justin-loop env-propagation probe${RESET}\n` +
      `${DIM}  claude    ${claudeBin} (${claudeVersion})\n` +
      `  model     ${opts.model}\n` +
      `  marker    ${marker}\n` +
      `  fixture   ${fixture}\n` +
      `  env       ${PROBE_ENV_VAR}=${probeValue}${RESET}\n\n`,
  );

  const dispatched = spawnSync(
    claudeBin,
    [
      '--bg',
      '--name',
      `TEST_DATA_DELETABLE ${marker} env probe`,
      '--model',
      opts.model,
      '--permission-mode',
      'acceptEdits',
      '--settings',
      settingsPath,
      // NO `--add-dir` HERE. Measured 2026-09-19 (claude 2.1.278): its argument
      // is VARIADIC (`--add-dir <directories...>`), so it swallows the prompt
      // positional that follows it and the session is created idle — "send a
      // prompt to start" — having spent nothing and measured nothing. The
      // fixture is already the cwd, so it is a working directory anyway.
      prompt,
    ],
    {
      cwd: fixture,
      encoding: 'utf-8',
      env: {...process.env, [PROBE_ENV_VAR]: probeValue},
      timeout: 120_000,
    },
  );
  const banner = `${dispatched.stdout ?? ''}${dispatched.stderr ?? ''}`;
  process.stdout.write(`${DIM}${banner.trim()}${RESET}\n`);
  const agentId = parseBackgroundedId(banner);
  if (agentId == null) {
    process.stderr.write(
      `${RED}dispatch failed${RESET} — \`claude --bg\` printed no agent id. Nothing to clean up.\n`,
    );
    return 2;
  }

  const deadline = Date.now() + opts.timeoutMin * 60_000;
  let raw: string | null = null;
  while (Date.now() < deadline) {
    if (existsSync(outPath)) {
      raw = readFileSync(outPath, 'utf-8').trim();
      if (raw !== '') break;
    }
    await sleep(3_000);
    process.stdout.write(`${DIM}.${RESET}`);
  }
  process.stdout.write('\n');

  // Cleanup FIRST, so a surprising result never leaves a live session behind.
  // Only this probe's own id, never `--all`.
  if (!opts.keep) {
    const stop = spawnSync(claudeBin, ['stop', agentId], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const rm = spawnSync(claudeBin, ['rm', agentId], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    process.stdout.write(
      `${DIM}cleanup: stop ${agentId} exit ${stop.status ?? 'null'} · rm ${agentId} exit ${rm.status ?? 'null'}${RESET}\n`,
    );
  } else {
    process.stdout.write(
      `${DIM}--keep: agent ${agentId} and ${fixture} left in place${RESET}\n`,
    );
  }

  // THE THREE OUTCOMES ARE THREE FACTS, never folded into two (critical rule 7).
  // "the session never wrote the file" is not evidence about the environment at
  // all, and reporting it as NOT PROPAGATED would manufacture a measurement.
  if (raw == null) {
    process.stderr.write(
      `${RED}INCONCLUSIVE${RESET} — the session wrote nothing to ${outPath} within ${opts.timeoutMin} minute(s).\n` +
        `  Nothing was measured about the environment. Inspect with: claude logs ${agentId}\n`,
    );
    return 1;
  }
  const found = raw.includes(`PROBE_RESULT=[${probeValue}]`);
  const empty = raw.includes('PROBE_RESULT=[]');
  process.stdout.write(`${DIM}file: ${raw}${RESET}\n`);
  if (found) {
    process.stdout.write(
      `${GREEN}PROPAGATED${RESET} — ${PROBE_ENV_VAR} set on the \`claude --bg\` invocation reached the session's Bash tool (claude ${claudeVersion}).\n`,
    );
    return 0;
  }
  if (empty) {
    process.stdout.write(
      `${RED}NOT PROPAGATED${RESET} — the variable was unset inside the session (claude ${claudeVersion}).\n`,
    );
    return 0;
  }
  process.stderr.write(
    `${RED}INCONCLUSIVE${RESET} — the file matched neither shape; the session did something else. Read it above.\n`,
  );
  return 1;
}

process.exit(await main());
