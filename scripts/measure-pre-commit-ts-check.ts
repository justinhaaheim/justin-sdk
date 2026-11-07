#!/usr/bin/env bun
/**
 * measure-pre-commit-ts-check — does the husky component's type-check block
 * (home-base-lzvh) refuse a type error, let a clean commit through, and stay
 * fast, in a REAL checkout with real git, husky, bun and tsc?
 *
 * WHY. The bead's measurement gate (criterion 7) sets the default of
 * `componentConfig.husky.tsCheckInHook` from exactly these three facts, in
 * clones of the six TypeScript consumer repos. Unit tests stub `bun`; only a
 * real commit shows the hook firing.
 *
 * WHAT, in a checkout under --work (a `git clone` of --source, or a --fixture
 * repo built from scratch):
 *   1. writes `componentConfig.husky.tsCheckInHook` (--knob) into its
 *      justin-sdk.config.json, then runs THIS checkout's SDK installer
 *      (`<sdk>/src/cli.ts add husky`) with the checkout as cwd. Installers
 *      chain base-setup, which stamps this SDK's version into the checkout's
 *      pin; `node_modules` still holds the checkout's own SDK, which is what
 *      the hook calls at commit time. Then runs the installer a second time and
 *      compares the hook byte for byte.
 *   2. unless --install-only: `bun install`, `bun run prepare` (bun install
 *      runs no lifecycle scripts, so without this no hook fires), and a
 *      `--no-verify` commit of the installer's changes.
 *   3. stages a type error in a tracked file tsc reads, and commits: it must
 *      be refused, HEAD must not move, and the hook's output is printed.
 *   4. two clean commits, timed; the second (warm) one counts.
 *   5. the block alone, run twice as husky runs it (`sh -e`, cwd = the repo
 *      root, node_modules/.bin first on PATH), timed: what the block ADDS to a
 *      commit. The machine's 1-minute load average is printed beside each time.
 *
 * Every probe line and commit message carries --marker, a test-data UUID.
 * Nothing outside --work is written. The checkout is left for inspection.
 *
 *   bun run measure:pre-commit-ts-check --source <repo> --work <dir> --marker <uuid> [--knob true|false|unset] [--install-only]
 *   bun run measure:pre-commit-ts-check --fixture ts|no-tsconfig|no-script|home-base-hook --work <dir> --marker <uuid>
 */

import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {loadavg} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const HELP = `measure-pre-commit-ts-check — run the husky type-check block in a real checkout (home-base-lzvh)

  bun run measure:pre-commit-ts-check --source <repo> --work <dir> --marker <uuid> [options]
  bun run measure:pre-commit-ts-check --fixture <kind> --work <dir> --marker <uuid> [options]

  --source <repo>     a git repo to clone (local path); the clone goes in <work>/<name>
  --fixture <kind>    build a throwaway repo instead:
                        ts              tsconfig.json and a signal-source:TS script
                        no-tsconfig     no tsconfig.json
                        no-script       tsconfig.json, signal-source:TS removed after install
                        home-base-hook  home-base's .husky/pre-commit copied in first (install only)
  --work <dir>        parent directory for the checkout (must not already hold <name>)
  --name <name>       checkout directory name (default: the source's basename, or fixture-<kind>)
  --marker <uuid>     test-data UUID written into every probe line and commit message
  --knob <v>          componentConfig.husky.tsCheckInHook to write: true (default), false, unset
  --install-only      run the installer twice and report the hook; no install, no commits
  --help              print this and do nothing else

Writes only under --work. Exits 1 when any expectation fails.`;

interface Run {
  ms: number;
  output: string;
  status: number | null;
}

function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Run {
  const started = performance.now();
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = performance.now() - started;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error == null ? '' : `\n${String(result.error)}`}`;
  return {ms, output, status: result.status};
}

const failures: string[] = [];

function expectThat(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

function must(result: Run, what: string): void {
  if (result.status !== 0) {
    console.log(result.output);
    throw new Error(`${what} failed with exit ${String(result.status)}`);
  }
}

function load1(): string {
  return (loadavg()[0] ?? Number.NaN).toFixed(2);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `      | ${line}`)
    .join('\n');
}

const SDK_ROOT = resolve(import.meta.dirname, '..');
const SDK_CLI = join(SDK_ROOT, 'src', 'cli.ts');
const HOME_BASE_HOOK = join(
  SDK_ROOT,
  'tests',
  'fixtures',
  'home-base-pre-commit.sh',
);
/**
 * The installer runs with health notices off: they would reach the network
 * and write a state file outside --work, and they are not under test.
 */
function quietEnv(): NodeJS.ProcessEnv {
  return {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'};
}
const BEGIN = '# >>> justin-sdk:ts-check';
const END = '# <<< justin-sdk:ts-check';

const FIXTURE_KINDS = [
  'ts',
  'no-tsconfig',
  'no-script',
  'home-base-hook',
] as const;
type FixtureKind = (typeof FIXTURE_KINDS)[number];

function buildFixture(dir: string, kind: FixtureKind, marker: string): void {
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        devDependencies: {typescript: '5.9.2'},
        // lint-staged is not under test; `true` accepts every file, fast.
        'lint-staged': {'*': 'true'},
        name: `lzvh-fixture-${kind}`,
        private: true,
        scripts: {'signal-source:TS': 'tsc --noEmit'},
      },
      null,
      2,
    )}\n`,
  );
  if (kind !== 'no-tsconfig') {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      `${JSON.stringify({compilerOptions: {noEmit: true, strict: true}, include: ['src']}, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `// [TEST_DATA_DELETABLE ${marker} ]\nexport const answer: number = 42;\n`,
  );
  if (kind === 'home-base-hook') {
    mkdirSync(join(dir, '.husky'), {recursive: true});
    writeFileSync(
      join(dir, '.husky', 'pre-commit'),
      readFileSync(HOME_BASE_HOOK),
    );
  }
  must(run('git', ['init', '-q', '-b', 'main'], dir), 'git init');
  must(run('git', ['add', '-A'], dir), 'git add');
  must(
    run(
      'git',
      [
        'commit',
        '-q',
        '--no-verify',
        '-m',
        `chore: fixture [TEST_DATA_DELETABLE ${marker} ]`,
      ],
      dir,
    ),
    'fixture commit',
  );
}

function setKnob(dir: string, knob: string): void {
  const path = join(dir, 'justin-sdk.config.json');
  const config = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)
    : {};
  const componentConfig = (config.componentConfig ?? {}) as Record<
    string,
    unknown
  >;
  const husky = (componentConfig.husky ?? {}) as Record<string, unknown>;
  if (knob === 'unset') delete husky.tsCheckInHook;
  else husky.tsCheckInHook = knob === 'true';
  componentConfig.husky = husky;
  config.componentConfig = componentConfig;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function readHook(dir: string): string | null {
  const path = join(dir, '.husky', 'pre-commit');
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** A tracked, non-declaration .ts/.tsx file that tsc reads in this checkout. */
function findProbeFile(dir: string): string | null {
  const listed = run(
    join(dir, 'node_modules', '.bin', 'tsc'),
    ['--listFilesOnly'],
    dir,
  );
  // TS18003: the tsconfig matches no file at all (imessage-exporter, a Rust
  // repo, on 2026-11-07). There is nothing to edit; the caller says so.
  if (listed.status !== 0 && listed.output.includes('TS18003')) {
    console.log(`  tsc finds no input files here:\n${indent(listed.output)}`);
    return null;
  }
  must(listed, 'tsc --listFilesOnly');
  for (const raw of listed.output.split('\n')) {
    const file = raw.trim();
    if (!file.startsWith(`${dir}/`) || file.includes('/node_modules/'))
      continue;
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    const relative = file.slice(dir.length + 1);
    if (
      run('git', ['ls-files', '--error-unmatch', relative], dir).status === 0
    ) {
      return relative;
    }
  }
  return null;
}

/** One appended probe line, in a syntax the probe file accepts. */
function probeLine(file: string, what: string, marker: string): string {
  if (/\.tsx?$/.test(file)) {
    return `${what} // [TEST_DATA_DELETABLE ${marker} ]`;
  }
  return `<!-- ${what} [TEST_DATA_DELETABLE ${marker} ] -->`;
}

function blockOf(hook: string): string | null {
  const lines = hook.split('\n');
  const begin = lines.findIndex((line) => line.startsWith(BEGIN));
  const end = lines.findIndex((line, i) => i > begin && line.startsWith(END));
  if (begin === -1 || end === -1) return null;
  return `${lines.slice(begin, end + 1).join('\n')}\n`;
}

function headSha(dir: string): string {
  const head = run('git', ['rev-parse', 'HEAD'], dir);
  must(head, 'git rev-parse HEAD');
  return head.output.trim();
}

function main(): number {
  const {values} = parseArgs({
    options: {
      fixture: {type: 'string'},
      help: {type: 'boolean'},
      'install-only': {type: 'boolean'},
      knob: {default: 'true', type: 'string'},
      marker: {type: 'string'},
      name: {type: 'string'},
      source: {type: 'string'},
      work: {type: 'string'},
    },
    strict: true,
  });
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  const {fixture, knob, marker, source, work} = values;
  if (
    work == null ||
    marker == null ||
    (source == null) === (fixture == null)
  ) {
    console.log(HELP);
    return 2;
  }
  if (!['true', 'false', 'unset'].includes(knob)) {
    console.log(`--knob must be true, false or unset, not ${knob}`);
    return 2;
  }
  if (
    fixture != null &&
    !(FIXTURE_KINDS as readonly string[]).includes(fixture)
  ) {
    console.log(`--fixture must be one of ${FIXTURE_KINDS.join(', ')}`);
    return 2;
  }
  const name =
    values.name ?? (source == null ? `fixture-${fixture}` : basename(source));
  const dir = resolve(work, name);
  if (existsSync(dir)) {
    console.log(`${dir} already exists; pick another --work or --name`);
    return 2;
  }
  mkdirSync(resolve(work), {recursive: true});
  // A clone's mise.toml is untrusted where it lands, and mise then fails every
  // command in it (`bun run prepare` first). Trust --work only, as
  // tests/sandbox.ts trusts the test temp dir; every child inherits this.
  const trusted = process.env.MISE_TRUSTED_CONFIG_PATHS;
  process.env.MISE_TRUSTED_CONFIG_PATHS =
    trusted != null && trusted !== ''
      ? `${trusted}:${resolve(work)}`
      : resolve(work);

  console.log(`\n== ${name}  (${dir})`);
  if (source != null) {
    // --no-hardlinks: a local clone otherwise HARDLINKS the source's object
    // files, and every object git "freshens" in the clone (a `git add` of
    // content already packed) then sets the mtime of the SOURCE's file too.
    // Measured 2026-11-07: 188 object files in five real repos under ~/Dev got
    // a new mtime that way, contents untouched.
    must(
      run(
        'git',
        ['clone', '-q', '--no-hardlinks', resolve(source), dir],
        resolve(work),
      ),
      'git clone',
    );
    console.log(`  cloned ${resolve(source)} at ${headSha(dir).slice(0, 12)}`);
  } else {
    mkdirSync(dir, {recursive: true});
    buildFixture(dir, fixture as FixtureKind, marker);
  }

  // 1. The installer, twice.
  const hookBefore = readHook(dir);
  setKnob(dir, knob);
  const install = run('bun', [SDK_CLI, 'add', 'husky'], dir, quietEnv());
  must(install, 'installer');
  const hookAfter = readHook(dir);
  const preCommitLines = install.output
    .split('\n')
    .filter((line) => line.includes('.husky/pre-commit'));
  console.log(
    `  installer (knob ${knob}), its .husky/pre-commit lines:\n${indent(preCommitLines.join('\n'))}`,
  );
  console.log(
    `  hook before: ${hookBefore == null ? 'absent' : JSON.stringify(hookBefore.length > 60 ? `${hookBefore.slice(0, 60)}…` : hookBefore)}`,
  );
  console.log(
    `  hook changed by the install: ${hookBefore === hookAfter ? 'no' : 'yes'}`,
  );
  console.log(
    `  hook has the block: ${hookAfter != null && blockOf(hookAfter) != null ? 'yes' : 'no'}`,
  );
  must(
    run('bun', [SDK_CLI, 'add', 'husky'], dir, quietEnv()),
    'installer, second run',
  );
  expectThat(
    readHook(dir) === hookAfter,
    'a second install leaves .husky/pre-commit byte-identical',
  );
  if (values['install-only'] === true) return failures.length === 0 ? 0 : 1;

  // 2. Install, wire the hooks, commit the installer's changes.
  must(run('bun', ['install'], dir), 'bun install');
  must(run('bun', ['run', 'prepare'], dir), 'bun run prepare');
  const hooksPath = run('git', ['config', 'core.hooksPath'], dir).output.trim();
  console.log(
    `  core.hooksPath after prepare: ${hooksPath === '' ? '(unset)' : hooksPath}`,
  );
  const sdkInNodeModules = join(
    dir,
    'node_modules',
    '@justinhaaheim',
    'justin-sdk',
    'package.json',
  );
  const sdkVersion = existsSync(sdkInNodeModules)
    ? (
        JSON.parse(readFileSync(sdkInNodeModules, 'utf-8')) as {
          version?: string;
        }
      ).version
    : null;
  console.log(
    `  justin-sdk the hook will call (node_modules): ${sdkVersion ?? 'absent'}`,
  );
  if (fixture === 'no-script') {
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    delete pkg.scripts?.['signal-source:TS'];
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  must(run('git', ['add', '-A'], dir), 'git add');
  must(
    run(
      'git',
      [
        'commit',
        '-q',
        '--no-verify',
        '-m',
        `chore: lzvh installer changes [TEST_DATA_DELETABLE ${marker} ]`,
      ],
      dir,
    ),
    'setup commit',
  );

  const hasTsconfig = existsSync(join(dir, 'tsconfig.json'));
  const tsSibling = hasTsconfig ? findProbeFile(dir) : 'src/index.ts';
  // A NEW file beside one tsc reads: code appended to an existing file can
  // land after a `process.exit()` and trip TS7027 (life's check-guidance.ts
  // did, 2026-11-07). With no TS file at all, the clean commits edit
  // README.md, the kind of commit such a repo makes, and the type error still
  // goes in a new .ts file.
  const tsProbe = join(
    tsSibling == null ? '' : dirname(tsSibling),
    'lzvh-probe.ts',
  );
  const textProbe = existsSync(join(dir, 'README.md'))
    ? 'README.md'
    : 'CLAUDE.md';
  const probe = tsSibling == null ? textProbe : tsProbe;
  const readme =
    tsSibling == null ? readFileSync(join(dir, probe), 'utf-8') : null;
  const writeCleanProbe = (n: number): void => {
    if (readme == null) {
      const line = `export const lzvhCleanProbe${n} = ${n};`;
      writeFileSync(join(dir, probe), `${probeLine(probe, line, marker)}\n`);
    } else {
      const line = probeLine(probe, `lzvh clean probe ${n}`, marker);
      writeFileSync(join(dir, probe), `${readme.trimEnd()}\n${line}\n`);
    }
  };
  console.log(
    `  probe file: ${probe}${tsSibling == null ? '' : ` (new, beside ${tsSibling})`}`,
  );

  // 3. A staged type error.
  if (hasTsconfig && fixture !== 'no-script') {
    const errorFile = tsProbe;
    const errorLine = probeLine(
      errorFile,
      "export const lzvhTypeErrorProbe: number = 'not a number';",
      marker,
    );
    writeFileSync(join(dir, errorFile), `${errorLine}\n`);
    must(run('git', ['add', errorFile], dir), 'git add probe');
    const before = headSha(dir);
    const refused = run(
      'git',
      [
        'commit',
        '-m',
        `test: lzvh type-error probe [TEST_DATA_DELETABLE ${marker} ]`,
      ],
      dir,
    );
    console.log(
      `  type-error commit: exit ${String(refused.status)} in ${seconds(refused.ms)}s, load ${load1()}\n${indent(refused.output)}`,
    );
    expectThat(
      refused.status !== 0,
      'a staged type error is refused by git commit',
    );
    expectThat(headSha(dir) === before, 'HEAD did not move');
    expectThat(
      /TS\d{4}/.test(refused.output),
      'the hook printed a TypeScript error (it fired)',
    );
    must(
      run('git', ['rm', '-q', '--cached', errorFile], dir),
      'unstage the type-error probe',
    );
    unlinkSync(join(dir, errorFile));
  }

  // 4. Two clean commits; the second is the warm one.
  const cleanTimes: number[] = [];
  for (const n of [1, 2]) {
    writeCleanProbe(n);
    must(run('git', ['add', probe], dir), 'git add probe');
    const before = headSha(dir);
    const load = load1();
    const clean = run(
      'git',
      [
        'commit',
        '-m',
        `test: lzvh clean probe ${n} [TEST_DATA_DELETABLE ${marker} ]`,
      ],
      dir,
    );
    cleanTimes.push(clean.ms);
    console.log(
      `  clean commit ${n}: exit ${String(clean.status)} in ${seconds(clean.ms)}s, load ${load}\n${indent(clean.output)}`,
    );
    expectThat(
      clean.status === 0 && headSha(dir) !== before,
      `clean commit ${n} succeeds`,
    );
    if (fixture === 'no-tsconfig') {
      expectThat(
        !/type.?check|tsc|ts-check/i.test(clean.output),
        'the hook printed nothing about type checks',
      );
    }
    if (fixture === 'no-script') {
      const skipped = clean.output
        .split('\n')
        .filter((line) => line.includes('Type check skipped'));
      expectThat(
        skipped.length === 1,
        'the hook printed one line saying the type check was skipped',
      );
    }
    if (hasTsconfig && tsSibling == null) {
      const skipped = clean.output
        .split('\n')
        .filter((line) => line.includes('no TypeScript files (TS18003)'));
      expectThat(
        skipped.length === 1,
        'the hook printed one line: no TypeScript files, nothing to check',
      );
    }
  }

  // 5. The block alone, as husky runs it.
  const hook = readHook(dir);
  const block = hook == null ? null : blockOf(hook);
  if (block != null) {
    const blockFile = join(resolve(work), `${name}.block.sh`);
    writeFileSync(blockFile, block);
    const env = {
      ...process.env,
      PATH: `node_modules/.bin:${process.env.PATH ?? ''}`,
    };
    const times: number[] = [];
    for (const n of [1, 2]) {
      const load = load1();
      const alone = run('sh', ['-e', blockFile], dir, env);
      times.push(alone.ms);
      console.log(
        `  block alone ${n}: exit ${String(alone.status)} in ${seconds(alone.ms)}s, load ${load}`,
      );
    }
    const warm = times[1] ?? Number.NaN;
    expectThat(
      warm <= 10_000,
      `the block adds at most 10 s to a warm commit (${seconds(warm)}s)`,
    );
    console.log(
      `  RESULT ${JSON.stringify({blockWarmS: Number(seconds(warm)), cleanCommitWarmS: Number(seconds(cleanTimes[1] ?? Number.NaN)), load1: Number(load1()), name})}`,
    );
  }
  return failures.length === 0 ? 0 : 1;
}

try {
  const code = main();
  if (failures.length > 0) console.log(`\nFAILED: ${failures.join('; ')}`);
  process.exit(code);
} catch (error) {
  console.log(
    `\nERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
