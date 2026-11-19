/**
 * A tab whose terminal number (tty) cmux restored from before its restart
 * (home-base-ruaep.1).
 *
 * `thread close` learns what runs in a tab from the tty `cmux tree` reports
 * for it. After a cmux restart that number can be stale: cmux restores each
 * tab's pre-restart tty from its session file as display-only metadata and
 * replaces it only when the tab's new shell sends report_tty, which the shell
 * does once and never retries. At the 2026-11-17 21:37 restart 9 shells
 * (inferred) lost that report, so 9 tabs showed numbers macOS had since given to newer
 * tabs; surface:1000000055 read as ttys000 (an idle shell) while its own
 * terminal ran `bun run threads`.
 *
 * THE SIGNAL. `session-com.cmuxterm.app-previous.json` is the layout cmux
 * restored at its last launch (cmux-session-file.ts `RestoredTtys` says so,
 * with the cmux source lines). A tab listed there with the SAME tty that
 * `cmux tree` reports now may never have been re-reported: its tty is
 * UNPROVEN, here called stale. A tab not listed there, or listed with another
 * tty, was re-reported since launch. No cmux command says whether a tab's tty
 * was re-reported (cmux v0.65.2.2), so a tab whose new shell happened to get
 * its old number back is unproven too; that is accepted.
 *
 * THE RULE, narrowing only: every close path keeps a workspace holding a
 * stale tab (kind `staleTty`) and places no process on that tab, as F22 does
 * for a tty two tabs report. When `-previous` cannot be read, or is absent,
 * which tabs cmux restored cannot be told, so every terminal tab with a tty
 * is unproven (kind `unknown`, naming the file and the error).
 */

import type {RestoredTtys} from './cmux-session-file';
import type {LiveSurface} from './pane-join';

import {holdsNoProcess, normalizeTty} from './pane-join';

/** What the `-previous` file proves about the tabs `cmux tree` lists now. */
export type TtyProof =
  | {
      kind: 'read';
      /** When cmux last launched (the file's mtime); null when unknown. */
      restartAtMs: number | null;
      /** Each stale tab: upper-cased surface id → the tty it still shows. */
      stale: ReadonlyMap<string, string>;
    }
  | {kind: 'failed'; reason: string};

/** Where one tab's tty stands. */
export type TtyStanding =
  | {kind: 'proven'}
  | {kind: 'stale'; tty: string}
  | {kind: 'unproven'; reason: string};

/** The proof for every tab of one `cmux tree` read. Pure. */
export function ttyProofOf(
  surfaces: readonly LiveSurface[],
  restored: RestoredTtys,
): TtyProof {
  if (restored.kind === 'failed') {
    return {kind: 'failed', reason: restored.reason};
  }
  const stale = new Map<string, string>();
  for (const surface of surfaces) {
    if (holdsNoProcess(surface)) continue;
    const tty = normalizeTty(surface.tty);
    if (tty == null || surface.id == null || surface.id === '') continue;
    const key = surface.id.toUpperCase();
    const before = restored.ttyByPanel.get(key);
    // Not in the file: cmux did not restore it at launch, so the tty it
    // reports came from its own shell.
    if (before === undefined) continue;
    if (normalizeTty(before) === tty) stale.set(key, tty);
  }
  return {kind: 'read', restartAtMs: restored.writtenAtMs, stale};
}

/**
 * One tab's standing. A tab with no tty, or a browser or markdown tab, is
 * `proven`: there is no number to doubt (an unknown tty keeps its pane by
 * the gates' own `ttyUnknown` check).
 */
export function ttyStandingOf(
  proof: TtyProof,
  surface: Pick<LiveSurface, 'id' | 'tty' | 'type'> | null | undefined,
): TtyStanding {
  if (surface == null || holdsNoProcess(surface)) return {kind: 'proven'};
  const tty = normalizeTty(surface.tty);
  if (tty == null) return {kind: 'proven'};
  if (proof.kind === 'failed') {
    return {
      kind: 'unproven',
      reason: `cmux's layout from its last launch could not be read (${proof.reason}), so which tabs show the terminal number cmux restored from before its restart cannot be told`,
    };
  }
  if (surface.id == null || surface.id === '') {
    return {
      kind: 'unproven',
      reason:
        "cmux gave no id for the tab, so it cannot be matched to cmux's layout from its last launch",
    };
  }
  const stale = proof.stale.get(surface.id.toUpperCase());
  return stale == null ? {kind: 'proven'} : {kind: 'stale', tty: stale};
}

/**
 * Whether the live join may place no process on this tab by its tty: a
 * stale tab, or any tab with a tty when `-previous` could not be read. A
 * tab with no id is left to the id checks (closeSurfaceArgs refuses it,
 * and the gates keep it as unknown).
 */
export function ttyUnproven(
  proof: TtyProof | null | undefined,
  surface: Pick<LiveSurface, 'id' | 'tty' | 'type'> | null | undefined,
): boolean {
  if (proof == null) return false;
  const standing = ttyStandingOf(proof, surface);
  return (
    standing.kind === 'stale' ||
    (standing.kind === 'unproven' && proof.kind === 'failed')
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** "2026-11-17 21:36", local time. */
function localMinute(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function restartWords(restartAtMs: number | null): string {
  return restartAtMs == null
    ? 'at its last launch'
    : `at ${localMinute(restartAtMs)}`;
}

/**
 * The keep reason of a stale tab. `owners` are the other tabs that report
 * the same tty and are not stale themselves: one of them owns the number.
 * `staleSharers` are other tabs reporting it that are stale too.
 */
export function staleTtyWords(input: {
  label: string;
  owners: readonly string[];
  restartAtMs: number | null;
  staleSharers: readonly string[];
  tty: string;
}): string {
  // Only what is verified (review of home-base-ruaep.1): the number is the
  // one cmux restored, and cmux keeps a restored number until the shell
  // reports one. Whether the shell's report was lost, or it reported the
  // same number again, is not known.
  const base = `${input.label} shows terminal ${input.tty}, the number it had before cmux restarted ${restartWords(input.restartAtMs)}; cmux keeps a restored number until the tab's shell reports a new one, so whether ${input.tty} is still this tab's terminal cannot be told, and what runs in it cannot be checked. Close it in cmux by hand if nothing there matters`;
  if (input.owners.length > 0) {
    const owners = input.owners.join(', ');
    return `${base}. ${owners} ${input.owners.length === 1 ? 'reports' : 'report'} ${input.tty} too, a number ${input.owners.length === 1 ? 'it' : 'they'} reported since the restart; closing ${input.label} by hand lets ${owners} be checked`;
  }
  if (input.staleSharers.length > 0) {
    return `${base}. ${input.staleSharers.join(', ')} ${input.staleSharers.length === 1 ? 'shows' : 'show'} ${input.tty} too, also the number cmux restored`;
  }
  return base;
}

/**
 * What a shared-tty reason adds when some of the other tabs reporting the
 * tty are stale: which one, and that closing it by hand frees this one.
 */
export function staleSharersWords(
  staleSharers: readonly string[],
  tty: string,
): string {
  if (staleSharers.length === 0) return '';
  const names = staleSharers.join(', ');
  return `. ${names} ${staleSharers.length === 1 ? 'shows' : 'show'} ${tty} as the number cmux restored from before its restart, so whether it is still ${staleSharers.length === 1 ? 'that tab’s' : 'their'} terminal cannot be told; close ${staleSharers.length === 1 ? 'it' : 'them'} in cmux by hand and this tab can be checked`;
}

/** The keep reason of a tab whose standing could not be proven. */
export function unprovenTtyWords(
  label: string,
  tty: string | null,
  reason: string,
): string {
  return `unknown: ${label} reports terminal ${tty ?? '?'}, but ${reason}`;
}

/**
 * Why `surface` keeps what holds it, or null when its tty is proven: kind
 * `staleTty` with the stale words (naming the tab that owns the number, when
 * one does), or `unknown` when its standing cannot be proven. The one
 * builder of these words, for the gates and for `--tab`.
 */
export function staleKeepOf(
  proof: TtyProof,
  surfaces: readonly LiveSurface[],
  surface: LiveSurface,
  label: string,
): {kind: 'staleTty' | 'unknown'; text: string; tty: string | null} | null {
  const standing = ttyStandingOf(proof, surface);
  const tty = normalizeTty(surface.tty);
  if (standing.kind === 'proven') return null;
  if (standing.kind === 'unproven') {
    return {
      kind: 'unknown',
      text: unprovenTtyWords(label, tty, standing.reason),
      tty,
    };
  }
  const others = surfaces.filter(
    (candidate) =>
      candidate.ref !== surface.ref &&
      normalizeTty(candidate.tty) === standing.tty,
  );
  const owners: string[] = [];
  const staleSharers: string[] = [];
  for (const other of others) {
    const kind = ttyStandingOf(proof, other).kind;
    if (kind === 'proven') owners.push(other.ref);
    else if (kind === 'stale') staleSharers.push(other.ref);
  }
  return {
    kind: 'staleTty',
    text: staleTtyWords({
      label,
      owners,
      restartAtMs: proof.kind === 'read' ? proof.restartAtMs : null,
      staleSharers,
      tty: standing.tty,
    }),
    tty: standing.tty,
  };
}

/** The other tabs reporting `tty` that are stale, by ref. */
export function staleRefsOnTty(
  proof: TtyProof,
  surfaces: readonly LiveSurface[],
  tty: string,
  exceptRef: string | null,
): string[] {
  return surfaces
    .filter(
      (candidate) =>
        candidate.ref !== exceptRef &&
        normalizeTty(candidate.tty) === tty &&
        ttyStandingOf(proof, candidate).kind === 'stale',
    )
    .map((candidate) => candidate.ref);
}
