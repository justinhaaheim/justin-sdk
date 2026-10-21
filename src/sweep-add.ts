/**
 * sweep-add.ts — the decisions behind `justin-sdk sweep --add <component>`
 * (home-base-yukaf.33).
 *
 * WHY THIS PAYLOAD EXISTS. `sweep --component X` re-applies X only where the
 * config already lists it, and `sweep --component install` adopts only what is
 * already on disk. Every enrolled repo lists its components explicitly, so
 * neither can put a NEW component into the fleet: on 2026-10-20 `sweep
 * --component thread-rules` printed "14 not enrolled in this payload" and did
 * nothing. Only `add <name>` edits the list (add/remove edit the manifest,
 * install makes the disk match it), so this payload runs `add` in each repo
 * that lacks the component, then `install`.
 *
 * WHOSE `add` RUNS. The repo's OWN pinned SDK, by path — never this
 * orchestrator in-process. `add` writes the component's files, and those bytes
 * must be the ones the repo's pin describes; the orchestrator's newer bytes
 * would be a repo whose files and pin disagree. The cost is that a repo pinned
 * below the release that introduced the component cannot take it, and that is
 * reported as "pin too old" and skipped: the install sweep is what moves pins.
 *
 * Everything here is a leaf (no import of sweep.ts), so sweep.ts can call it
 * and the tests can drive each decision without standing up a worktree.
 */

import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  componentApplicability,
  type ComponentName,
  configNameFor,
} from './component-registry';
import {resolveWorktreeSdkBin, worktreeSdkArgv} from './sdk-invocation';

/** The repo's own `add`, exactly as the sweep runs it. No `--commit`, `--force` or `--yes`. */
export function sweepAddArgs(component: ComponentName): readonly string[] {
  return ['add', component];
}

/**
 * What runs after `add`: the reconciler, WITHOUT `--prune`. A named constant so
 * a test can assert that nothing in the add payload removes anything.
 */
export const SWEEP_ADD_INSTALL_ARGS = ['install'] as const;

/**
 * The enrollment half of the plan, from the config as committed on the default
 * branch. `components` is the RESOLVED list; `source` says whether the config
 * listed it or the key was absent (core).
 */
export type AddEnrollment =
  | {components: readonly string[]; kind: 'enrolled'; source: 'config' | 'core'}
  | {kind: 'unreadable'; reason: string};

export type AddEnrollmentVerdict =
  | {kind: 'proceed'}
  | {detail: string; kind: 'skip'}
  | {detail: string; kind: 'blocked'};

/**
 * Should this repo get `add <component>`? Pure.
 *
 *   unreadable config        → blocked: "could not check", never "already
 *                              enrolled" (critical rule 7, ckc4 F4)
 *   lists the component      → skip: already enrolled
 *   no `components` key      → skip, whatever core holds. `add` on a
 *                              core-tracking config writes `components: [X]`
 *                              (base-setup's addComponentsToConfig starts from
 *                              the explicit list, which is empty), so the
 *                              repo would stop tracking core and list ONE
 *                              component. A sweep must never make that switch.
 *   otherwise                → proceed
 */
export function addEnrollmentVerdict(
  enrollment: AddEnrollment,
  component: ComponentName,
): AddEnrollmentVerdict {
  if (enrollment.kind === 'unreadable') {
    return {
      detail: `cannot read enrollment: ${enrollment.reason}`,
      kind: 'blocked',
    };
  }
  const listed = enrollment.components.includes(configNameFor(component));
  if (enrollment.source === 'core') {
    return {
      detail: listed
        ? `skipped — already enrolled in ${component} (the config lists no components, so it tracks core, which includes it)`
        : `skipped — the config lists no components, so it tracks core, which does not include ${component} here; \`add\` would turn it into an explicit one-item list, so the sweep never runs it on a core-tracking repo`,
      kind: 'skip',
    };
  }
  if (listed) {
    return {
      detail: `skipped — already enrolled in ${component}`,
      kind: 'skip',
    };
  }
  return {kind: 'proceed'};
}

/**
 * Does `component` apply to the repo at `root`? `null` = it applies; a string
 * = the skip line.
 *
 * The same gate the install payload's adoption uses (dchjw.19): a component
 * whose includeIf does not pass is not a thing this repo lacks, it is a thing
 * this repo must not get. For thread-rules that is `isThreadEnabled` — a rule
 * file telling Claude to run `thread` commands is not inert in a repo where
 * threads are off. `add` itself ignores includeIf on purpose (a person typing
 * `add eas` means it); an unattended fleet run does not get that latitude.
 */
export function addApplicabilitySkip(
  root: string,
  component: ComponentName,
): string | null {
  const gate = componentApplicability(root).find(
    (entry) => entry.name === component,
  );
  if (gate == null || gate.applicable) return null;
  const predicates =
    gate.unknownPredicates.length > 0
      ? `unknown predicate(s) ${gate.unknownPredicates.join(', ')}`
      : gate.includeIf.join(', ');
  return `skipped — ${component} does not apply here (includeIf: ${predicates})`;
}

/**
 * The `[choices: "a", "b", …]` list yargs prints under `add --help`, or `null`
 * when the help carries no choices list at all. Pure.
 *
 * Quoted tokens only, so a component named in the positional's DESCRIPTION
 * ("In THIS repo, core = gitignore, …") is never mistaken for a choice, and a
 * token yargs wrapped onto the next line is still whole (it wraps on spaces).
 */
export function parseAddChoices(help: string): string[] | null {
  const start = help.indexOf('[choices:');
  if (start === -1) return null;
  const end = help.indexOf(']', start);
  if (end === -1) return null;
  const block = help.slice(start, end);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

/** The installed SDK's own version, read from its package.json. `null` = unreadable. */
export function readInstalledSdkVersion(root: string): string | null {
  const path = join(
    root,
    'node_modules',
    '@justinhaaheim',
    'justin-sdk',
    'package.json',
  );
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const version =
      parsed != null && typeof parsed === 'object'
        ? (parsed as {version?: unknown}).version
        : undefined;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/** The shape of sweep.ts's command runner, so this module stays a leaf. */
export type CommandRunner = (
  argv: string[],
  cwd: string,
) => {error: string | null; exitCode: number; output: string};

export type SdkOffer =
  | {kind: 'offers'; version: string | null}
  | {detail: string; kind: 'too-old'}
  | {detail: string; kind: 'unknown'};

/** The label a version gets in a line, unreadable included. Pure. */
function versionLabel(version: string | null): string {
  return version ?? 'version unreadable';
}

/**
 * Does the repo's OWN SDK offer `component`? Asked of the exact code that will
 * run: `<root>/node_modules/.bin/justin-sdk add --help`, whose yargs choices
 * list is what `add` validates its argument against. `--help` is read-only by
 * contract (home-base CLAUDE.md: a script given --help does nothing else).
 *
 * THREE answers, never two (critical rule 7): it offers it, it does not (the
 * pin predates the component — skipped, never failed), or this could not be
 * determined (no bin, the help failed, the help lists no choices). The third is
 * never read as either of the first two.
 */
export function probeSdkOffers(
  root: string,
  component: ComponentName,
  runCommand: CommandRunner,
): SdkOffer {
  const bin = resolveWorktreeSdkBin(root);
  if (!bin.ok) {
    return {
      detail: `${join(root, 'node_modules', '.bin', 'justin-sdk')} does not exist, so whether this repo's SDK offers ${component} is unknown`,
      kind: 'unknown',
    };
  }
  const version = readInstalledSdkVersion(root);
  const help = runCommand(worktreeSdkArgv(bin.path, ['add', '--help']), root);
  if (help.error != null || help.exitCode !== 0) {
    return {
      detail: `\`justin-sdk add --help\` failed (${help.error ?? `exit ${help.exitCode}`}), so whether this repo's SDK (${versionLabel(version)}) offers ${component} is unknown`,
      kind: 'unknown',
    };
  }
  const choices = parseAddChoices(help.output);
  if (choices == null) {
    return {
      detail: `\`justin-sdk add --help\` lists no choices, so whether this repo's SDK (${versionLabel(version)}) offers ${component} is unknown`,
      kind: 'unknown',
    };
  }
  if (!choices.includes(component)) {
    return {
      detail: `pin too old: ${versionLabel(version)}; run the install sweep first (this repo's own SDK does not offer ${component})`,
      kind: 'too-old',
    };
  }
  return {kind: 'offers', version};
}
