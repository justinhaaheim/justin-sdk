/**
 * The two glyphs that mark a session's times, defined once (home-base-1rxt0.8
 * D2): the Claude Code statusline's timing segment
 * (home-base `src/starship/session-timing.ts`) and the cmux workspace
 * description's times line (`src/thread/workspace-times.ts`) both import them
 * from here, as `@justinhaaheim/justin-sdk/session-glyphs`.
 *
 * Nerd Font glyphs, chosen over the words "Started:" / "Last:" to keep the text
 * narrow. Both are in the Font Awesome block that every Nerd Font patches in;
 * verified present in Hack Nerd Font Mono (the WezTerm font) via fc-query,
 * 2026-09-05. They are Private Use Area codepoints, so they are built by
 * codepoint rather than pasted: a PUA glyph in source is invisible to
 * eyeballing (home-base `src/starship/CLAUDE.md`).
 */

/** nf-fa-clock_o: when the session started. */
export const ICON_STARTED = String.fromCodePoint(0xf017);

/** nf-fa-comment: when the session last had a message (statusline: Claude). */
export const ICON_LAST = String.fromCodePoint(0xf075);
