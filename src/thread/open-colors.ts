/**
 * Project colours for the workspaces `thread open` makes or moves
 * (home-base-yukaf.22 item 5). Justin, 2026-10-19: "It'd be really nice if we
 * could color code my cmux workspaces".
 *
 * The colours are cmux-arrange's: `$XDG_CONFIG_HOME/cmux-arrange/colors.json`
 * (default ~/.config/cmux-arrange/colors.json), keyed by project folder name,
 * `overrides` first, then `assigned` (the picks an earlier cmux-arrange
 * --apply saved), then the built-in DEFAULT_PROJECT_COLORS below unless the
 * file's `exclude` lists that colour (home-base-yukaf.25 G1). This module
 * only READS that file and makes no new picks; the SDK cannot import
 * scripts/cmux-arrange-colors.ts, so the small reader is ported here (same
 * path rule, same accepted values).
 *
 * ONE TABLE (G1): DEFAULT_PROJECT_COLORS and CMUX_NAMED_COLORS live HERE;
 * scripts/cmux-arrange-colors.ts imports them back through the package
 * export `@justinhaaheim/justin-sdk/open-colors`. Justin's machine had no
 * colors.json on 2026-10-19, so without the defaults nothing was coloured.
 *
 * Rule 7: "the file does not exist" (the built-in colours are used), "the
 * file could not be read or is invalid" (nothing is coloured: a typo in
 * `exclude` must not bring back a colour Justin rejected), and "this project
 * has no colour" are three different outcomes, each said in the output, and
 * none of them fails the run.
 */

import type {EnvLike} from './paths';

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';

/** cmux's 16 colour names (scripts/cmux-arrange-colors.ts, measured 2026-10-05). */
export const CMUX_COLOR_NAMES: readonly string[] = [
  'Red',
  'Crimson',
  'Orange',
  'Amber',
  'Olive',
  'Green',
  'Teal',
  'Aqua',
  'Blue',
  'Navy',
  'Indigo',
  'Purple',
  'Magenta',
  'Rose',
  'Brown',
  'Charcoal',
];

/**
 * cmux's 16 named colours and the hex each one stores (measured 2026-10-05
 * on cmux 0.64.24; scripts/cmux-arrange-colors.ts has the measurement).
 */
export const CMUX_NAMED_COLORS: Readonly<Record<string, string>> = {
  Amber: '#7D6608',
  Aqua: '#0E6B8C',
  Blue: '#1565C0',
  Brown: '#7B3F00',
  Charcoal: '#3E4B5E',
  Crimson: '#922B21',
  Green: '#196F3D',
  Indigo: '#283593',
  Magenta: '#AD1457',
  Navy: '#1A5276',
  Olive: '#4A5C18',
  Orange: '#A04000',
  Purple: '#6A1B9A',
  Red: '#C0392B',
  Rose: '#880E4F',
  Teal: '#006B6B',
};

/**
 * cmux-arrange K1 (home-base-39co9.2): a colour that means something for each
 * project Justin had on 2026-10-05 (the live dry run found these ten). Each
 * reason is from the repo's own README or CLAUDE.md. Override any of them in
 * colors.json. Moved here from scripts/cmux-arrange-colors.ts by
 * home-base-yukaf.25 G1, so cmux-arrange and `thread open` read one table.
 */
export const DEFAULT_PROJECT_COLORS: Readonly<Record<string, string>> = {
  // Justin had already colored an [AJ] workspace #6A1B9A, which is Purple.
  'audio-journal-1': 'Purple',
  // Amazon's orange: an Amazon order history reporter.
  azad: 'Orange',
  // Archiving web services before the data is lost: old paper, archives.
  'browser-automation-central': 'Brown',
  // Medications, migraines, chronic pain: medical red.
  'health-logger-rn': 'Red',
  // Headquarters for every other project.
  'home-base': 'Navy',
  // The life manager; its north star is peace of mind. Calm, growing green.
  life: 'Green',
  // Water and forest sounds.
  'nature-sounds': 'Teal',
  // Fleet-wide rules that open with STOP: the caution color.
  prompts: 'Amber',
  // An iOS app working on phone screenshots: screen-glass aqua.
  'screenshot-app': 'Aqua',
  // Plain build tooling: neutral charcoal.
  'version-manager': 'Charcoal',
};

/** The same path cmux-arrange reads, from the given environment. */
export function colorFilePath(env: EnvLike): string {
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome != null && configHome !== '') {
    return join(configHome, 'cmux-arrange', 'colors.json');
  }
  const home = env.HOME != null && env.HOME !== '' ? env.HOME : homedir();
  return join(home, '.config', 'cmux-arrange', 'colors.json');
}

export type ColorFile =
  | {kind: 'absent'; path: string}
  | {kind: 'failed'; path: string; reason: string}
  | {
      assigned: Record<string, string>;
      /** Uppercase hexes the built-in defaults must not use (G1). */
      exclude: string[];
      kind: 'read';
      overrides: Record<string, string>;
      path: string;
    };

// palette is cmux-arrange's own knob (new picks): allowed, not used here.
const colorFileSchema = z.looseObject({
  assigned: z.record(z.string(), z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
});

/** A cmux colour name (any case, returned as cmux spells it) or #RRGGBB; null if neither. */
export function cmuxColor(value: string): string | null {
  const text = value.trim();
  if (/^#[0-9a-f]{6}$/iu.test(text)) return text.toUpperCase();
  return (
    CMUX_COLOR_NAMES.find(
      (name) => name.toLowerCase() === text.toLowerCase(),
    ) ?? null
  );
}

/** Uppercase #RRGGBB for a cmux colour name (any case) or a hex; null if neither. */
function hexOf(value: string): string | null {
  const color = cmuxColor(value);
  if (color == null) return null;
  return color.startsWith('#') ? color : (CMUX_NAMED_COLORS[color] ?? null);
}

/** Read the colour file. Absent and unreadable are distinct; a bad value fails it, naming every one. */
export function readColorFile(path: string): ColorFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {kind: 'absent', path};
    }
    return {kind: 'failed', path, reason: String(error)};
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    return {kind: 'failed', path, reason: `not valid JSON: ${String(error)}`};
  }
  const parsed = colorFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: 'failed',
      path,
      reason: `overrides and assigned must map project folder names to colour names: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const bad: string[] = [];
  const clean = (
    key: 'assigned' | 'overrides',
    record: Record<string, string> | undefined,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(record ?? {}).flatMap(([project, value]) => {
        const color = cmuxColor(value);
        if (color == null) {
          bad.push(`${key}.${project}: ${JSON.stringify(value)}`);
          return [];
        }
        return [[project, color]];
      }),
    );
  const overrides = clean('overrides', parsed.data.overrides);
  const assigned = clean('assigned', parsed.data.assigned);
  const exclude = (parsed.data.exclude ?? []).flatMap((value) => {
    const hex = hexOf(value);
    if (hex == null) bad.push(`exclude: ${JSON.stringify(value)}`);
    return hex == null ? [] : [hex];
  });
  if (bad.length > 0) {
    return {
      kind: 'failed',
      path,
      reason: `not a cmux colour name or #RRGGBB: ${bad.join(', ')}`,
    };
  }
  return {assigned, exclude, kind: 'read', overrides, path};
}

/**
 * A project's colour by its folder name: `overrides`, then `assigned`, then
 * the built-in DEFAULT_PROJECT_COLORS unless `exclude` lists it (G1); with no
 * file, the built-in colour alone. Null when none applies.
 */
export function projectColor(
  file: Extract<ColorFile, {kind: 'absent'} | {kind: 'read'}>,
  repo: string | null,
  defaults: Readonly<Record<string, string>> = DEFAULT_PROJECT_COLORS,
): string | null {
  if (repo == null || repo === '') return null;
  const builtIn = defaults[repo] ?? null;
  if (file.kind === 'absent') return builtIn;
  const chosen = file.overrides[repo] ?? file.assigned[repo] ?? null;
  if (chosen != null) return chosen;
  if (builtIn == null) return null;
  const hex = hexOf(builtIn);
  return hex != null && file.exclude.includes(hex) ? null : builtIn;
}

/** `workspace-action --action set-color`: always with --workspace (without it cmux colours the CALLER's workspace). */
export function setColorArgs(workspaceId: string, color: string): string[] {
  return [
    'workspace-action',
    '--action',
    'set-color',
    '--workspace',
    workspaceId,
    '--color',
    color,
  ];
}
