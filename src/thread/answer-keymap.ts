/**
 * The key map for `thread answer` (home-base-p1uj.12, invariants I3, I4, I5, I6).
 *
 * THIS FUNCTION IS SERIALISED INTO THE PAGE. `answer-page.ts` inlines
 * `keyActionFor.toString()` into the page's one inline script, so the browser
 * runs the exact function the test suite imports and asserts against. That is
 * the whole reason it lives in its own module: a key map described in a test and
 * re-typed in a string literal is a key map with two versions, and the one that
 * matters is the one that ate five paragraphs.
 *
 * Because it is serialised, it must be SELF-CONTAINED: no imports, no reference
 * to anything outside its own body, no TypeScript that survives erasure.
 * `tests/thread-answer-web.test.ts` pins that by evaluating the serialised text
 * in a bare `new Function` and re-running the same assertions against it.
 *
 * THE DESIGN RULE BEHIND EVERY ENTRY (Justin, verbatim): "aggressively design
 * against patterns where typing the wrong key or accidentally hitting enter
 * causes a situation you can't back out of, or erases everything." So:
 *   - the default is `none`, which means "let the browser do its ordinary thing";
 *   - Enter and Tab are ordinary — a newline and a focus move (I3);
 *   - bare arrows are ordinary, because in a textarea they move the caret;
 *   - nothing in this map deletes anything, and the only entry that writes to bd
 *     (`submit`) opens a review panel rather than writing.
 */

/** A DOM KeyboardEvent, reduced to what the map reads. */
export interface KeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  /** True when the event came from one of the answer textareas. */
  inTextarea: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export type KeyAction =
  /** Let the browser insert a newline. We never intercept it (I3). */
  | 'newline'
  /** Open the review panel. Still not a write — the panel confirms (I3). */
  | 'submit'
  /** Open the menu: resume / submit all / quit keeping drafts (I4). */
  | 'menu'
  /** Take this ask's stated default (I6). */
  | 'skip'
  | 'next'
  | 'prev'
  /** The browser's ordinary behaviour. The default, and never destructive. */
  | 'none';

/**
 * What one keystroke means. Pure, total, and serialisable — see the header.
 *
 * Written without imports or outer references on purpose; do not "tidy" it by
 * hoisting a shared constant out of the body.
 */
export function keyActionFor(event: KeyEventLike): KeyAction {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;

  // I4: Esc NEVER quits, and never discards. It opens the menu, from anywhere.
  if (key === 'Escape') return 'menu';

  // I3: Tab and Shift-Tab move focus. They are listed explicitly, and return
  // the do-nothing action, so that "Tab must never submit" is a fact this
  // function states rather than an omission someone could later fill in.
  if (key === 'Tab') return 'none';

  if (key === 'Enter' || key === 'Return') {
    // I3: a plain Enter inside an answer field is a newline, full stop.
    if (!mod && !event.altKey && event.inTextarea) return 'newline';
    // Anywhere else (a focused button in the menu or the review panel) the
    // browser's own activation is correct, and a modifier + Enter is left alone
    // deliberately: Cmd-Enter is muscle memory for "send" in other apps, and
    // borrowing it here would be a mode change nobody asked for.
    return 'none';
  }

  // I3: the one discoverable submit gesture. It opens the review panel.
  if (mod && (key === 's' || key === 'S')) return 'submit';

  // I6: one keystroke to take the stated default on the focused ask.
  if (mod && (key === 'k' || key === 'K')) return 'skip';

  // I2: move between asks. MODIFIED arrows only — a bare ArrowDown moves the
  // caret inside a textarea, and stealing it would make a five-paragraph answer
  // unnavigable, which is the same complaint in a different coat.
  if (mod || event.altKey) {
    if (key === 'ArrowDown' || key === 'PageDown') return 'next';
    if (key === 'ArrowUp' || key === 'PageUp') return 'prev';
  }

  return 'none';
}

/** The footer line, shown on every screen and never changing (I5). */
export const KEYMAP_FOOTER =
  'Enter newline · Tab next field · Ctrl/Cmd-S review & submit · Ctrl/Cmd-K skip (take the default) · Ctrl/Cmd-↑↓ prev/next ask · Esc menu · nothing here deletes your text';
