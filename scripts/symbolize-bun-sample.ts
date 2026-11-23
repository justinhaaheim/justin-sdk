#!/usr/bin/env bun
/**
 * Names the native frames in a macOS `sample` of a bun process
 * (home-base-ejsq2.6). `bun run test:parallel` writes such a sample of every
 * stuck test worker; the release bun is stripped, so its frames read
 * `???  (in bun)  load address 0x… + 0x…`.
 *
 * Bun publishes a build with symbols for every release
 * (`bun-darwin-aarch64-profile.zip` on the GitHub release; unzip it anywhere
 * outside the repo). Its offsets mean something for the installed bun ONLY if
 * both were built from the same link, so this script checks that first and
 * refuses when any check fails:
 *  1. the LC_UUID of the two binaries is the same;
 *  2. every __TEXT section of the installed bun has the same address, size and
 *     file offset in the profile build;
 *  3. the bytes of those sections are identical (SHA-256 of the whole range).
 * Then it runs `atos` once per load address and prints the sample with each
 * `???  (in bun)` frame replaced by its function name and offset. It installs
 * and changes nothing.
 *
 *   bun run test:parallel:symbolize <sample.txt> --profile <dir>/bun-profile [--bun <installed bun>]
 */
import {createHash} from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

export interface TextSection {
  addr: bigint;
  name: string;
  offset: number;
  size: bigint;
}

/** The LC_UUID from `otool -l` output; null when there is none. */
export function parseUuid(otool: string): null | string {
  const match = /cmd LC_UUID\s+cmdsize \d+\s+uuid ([0-9A-F-]+)/u.exec(otool);
  return match?.[1] ?? null;
}

/** Every section of the __TEXT segment, from `otool -l` output. */
export function parseTextSections(otool: string): TextSection[] {
  const sections: TextSection[] = [];
  for (const block of otool.split(/^Section$/mu).slice(1)) {
    const field = (key: string): null | string =>
      new RegExp(`^\\s*${key} (\\S+)`, 'mu').exec(block)?.[1] ?? null;
    if (field('segname') !== '__TEXT') continue;
    const name = field('sectname');
    const addr = field('addr');
    const size = field('size');
    const offset = field('offset');
    if (name == null || addr == null || size == null || offset == null) {
      continue;
    }
    sections.push({
      addr: BigInt(addr),
      name,
      offset: Number(offset),
      size: BigInt(size),
    });
  }
  return sections;
}

export type MatchVerdict =
  | {byteRange: {end: number; start: number}; ok: true; uuid: string}
  | {ok: false; why: string};

/**
 * Whether the profile build's offsets can be trusted for the installed one,
 * from their `otool -l` outputs and a hash of a byte range of each file.
 */
export function compareBuilds(input: {
  hashRange: (
    which: 'installed' | 'profile',
    start: number,
    end: number,
  ) => string;
  installedOtool: string;
  profileOtool: string;
}): MatchVerdict {
  const installedUuid = parseUuid(input.installedOtool);
  const profileUuid = parseUuid(input.profileOtool);
  if (installedUuid == null || profileUuid == null) {
    return {
      ok: false,
      why: `no LC_UUID in ${installedUuid == null ? 'the installed bun' : 'the profile build'}`,
    };
  }
  if (installedUuid !== profileUuid) {
    return {
      ok: false,
      why: `LC_UUID differs: installed ${installedUuid}, profile ${profileUuid}`,
    };
  }
  const installed = parseTextSections(input.installedOtool);
  const profile = parseTextSections(input.profileOtool);
  if (installed.length === 0) {
    return {ok: false, why: 'no __TEXT sections found in the installed bun'};
  }
  for (const section of installed) {
    const twin = profile.find((entry) => entry.name === section.name);
    if (twin == null) {
      return {
        ok: false,
        why: `the profile build has no __TEXT,${section.name}`,
      };
    }
    if (
      twin.addr !== section.addr ||
      twin.size !== section.size ||
      twin.offset !== section.offset
    ) {
      return {
        ok: false,
        why: `__TEXT,${section.name} differs: installed addr 0x${section.addr.toString(16)} size 0x${section.size.toString(16)} offset ${section.offset}, profile addr 0x${twin.addr.toString(16)} size 0x${twin.size.toString(16)} offset ${twin.offset}`,
      };
    }
  }
  const start = Math.min(...installed.map((section) => section.offset));
  const end = Math.max(
    ...installed.map((section) => section.offset + Number(section.size)),
  );
  const a = input.hashRange('installed', start, end);
  const b = input.hashRange('profile', start, end);
  if (a !== b) {
    return {
      ok: false,
      why: `the __TEXT bytes ${start}..${end} differ (SHA-256 ${a} vs ${b})`,
    };
  }
  return {byteRange: {end, start}, ok: true, uuid: installedUuid};
}

/** A `???  (in bun)  load address 0xL + 0xO  [0xA]` frame. */
const FRAME =
  /\?\?\?\s+\(in bun\)\s+load address (0x[0-9a-f]+) \+ (0x[0-9a-f]+)\s+\[(0x[0-9a-f]+)\]/u;

/** Every distinct bun frame address in a sample, grouped by load address. */
export function bunFrames(sample: string): Map<string, string[]> {
  const byLoad = new Map<string, Set<string>>();
  for (const line of sample.split('\n')) {
    const match = FRAME.exec(line);
    if (match == null) continue;
    const [, load, , address] = match;
    if (load == null || address == null) continue;
    const set = byLoad.get(load) ?? new Set<string>();
    set.add(address);
    byLoad.set(load, set);
  }
  return new Map([...byLoad].map(([load, set]) => [load, [...set]]));
}

/** The sample with each bun frame named; a frame with no name keeps its text. */
export function annotate(
  sample: string,
  names: ReadonlyMap<string, string>,
): string {
  return sample
    .split('\n')
    .map((line) => {
      const match = FRAME.exec(line);
      if (match == null) return line;
      const [whole, , offset, address] = match;
      const name = address == null ? undefined : names.get(address);
      if (whole == null || name == null) return line;
      return line.replace(whole, `${name}  [bun +${offset}]`);
    })
    .join('\n');
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

function hashFileRange(path: string, start: number, end: number): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let position = start;
    while (position < end) {
      const want = Math.min(buffer.length, end - position);
      const got = readSync(fd, buffer, 0, want, position);
      if (got === 0)
        throw new Error(`${path} ends at ${position}, before ${end}`);
      hash.update(buffer.subarray(0, got));
      position += got;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** `atos` names, one per address, in order; a name atos could not find is null. */
function atos(
  profile: string,
  load: string,
  addresses: string[],
): Map<string, string> {
  const out = run([
    'atos',
    '-o',
    profile,
    '-arch',
    'arm64',
    '-l',
    load,
    ...addresses,
  ]);
  const lines = out.trimEnd().split('\n');
  if (lines.length !== addresses.length) {
    throw new Error(
      `atos returned ${lines.length} lines for ${addresses.length} addresses`,
    );
  }
  const names = new Map<string, string>();
  addresses.forEach((address, index) => {
    const line = lines[index] ?? '';
    // atos echoes an address it cannot name: leave that frame as it was.
    if (line !== '' && line !== address) names.set(address, line);
  });
  return names;
}

const USAGE = `symbolize-bun-sample — names the native frames in a macOS sample of bun (home-base-ejsq2.6)

  bun run test:parallel:symbolize <sample.txt>... --profile <path to bun-profile> [--bun <installed bun>]

Get the build with symbols from the bun release that is installed (bun --revision), for example bun-darwin-aarch64-profile.zip on github.com/oven-sh/bun/releases/tag/bun-v1.4.2, and unzip it outside the repo. The script refuses unless the profile build has the installed bun's LC_UUID and byte-identical __TEXT sections, then prints each sample with its bun frames named. It installs and changes nothing.`;

async function main(): Promise<number> {
  const args = await yargs(hideBin(process.argv))
    .scriptName('symbolize-bun-sample')
    .usage(USAGE)
    .wrap(null)
    .option('profile', {
      demandOption: true,
      describe: 'The bun-profile binary from the matching release',
      type: 'string',
    })
    .option('bun', {
      describe:
        'The installed bun the sample was taken of (default: the bun running this script)',
      type: 'string',
    })
    .demandCommand(1, 'Name at least one sample file')
    .strict()
    .help()
    .parseAsync();
  const installed = realpathSync(args.bun ?? process.execPath);
  const profile = realpathSync(args.profile);
  const verdict = compareBuilds({
    hashRange: (which, start, end) =>
      hashFileRange(which === 'installed' ? installed : profile, start, end),
    installedOtool: run(['otool', '-l', installed]),
    profileOtool: run(['otool', '-l', profile]),
  });
  if (!verdict.ok) {
    process.stderr.write(
      `symbolize-bun-sample: REFUSED, the profile build does not match ${installed}: ${verdict.why}\n`,
    );
    return 2;
  }
  process.stdout.write(
    `build match: LC_UUID ${verdict.uuid} in both; __TEXT sections identical in address, size and offset; bytes ${verdict.byteRange.start}..${verdict.byteRange.end} identical (SHA-256)\n  installed: ${installed}\n  profile:   ${profile}\n\n`,
  );
  for (const file of args._.map(String)) {
    const sample = readFileSync(file, 'utf8');
    const names = new Map<string, string>();
    for (const [load, addresses] of bunFrames(sample)) {
      for (const [address, name] of atos(profile, load, addresses)) {
        names.set(address, name);
      }
    }
    process.stdout.write(`== ${file}\n${annotate(sample, names)}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
