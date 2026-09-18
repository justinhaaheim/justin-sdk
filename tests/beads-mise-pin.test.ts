/**
 * `beads_rust` IN PROSE IS NOT A PIN (home-base-dchjw.21).
 *
 * `stepMiseToml` guarded on `content.includes('beads_rust')`. A mise.toml that
 * names the tool only in a COMMENT passed that guard, the version regex
 * (`/beads_rust.*?version\s*=\s*"…"/`) found nothing, the replace matched
 * nothing, `String.replace` handed back the input unchanged, the identical
 * bytes were written, and the step printed "Updated mise.toml beads_rust
 * version to X" — a success line for a change that did not happen (critical
 * rule 6).
 *
 * `~/Dev/life`'s mise.toml is that file, verbatim below. Every decision now
 * anchors on the quoted TOOL KEY at the start of a line.
 */

import {describe, test, expect} from 'bun:test';

import {applyBeadsMiseToolPin, BEADS_MISE_TOOL_KEY} from '../src/beads-setup';

/** ~/Dev/life/mise.toml as measured 2026-09-18. */
const LIFE_MISE_TOML = `# Beads (bd) is NOT managed here — it's an npm devDependency (@beads/bd) in
# package.json, run via the global \`alias bd='bun run bd'\` in ~/.zshrc.
# beads_rust (\`br\`) was removed 2026-07-14 when this project migrated br -> bd (jl-h2w).
# \`br\` now errors here with "No version is set for shim: br" — that's intentional. Use \`bd\`.
# Other projects (playground-rn etc.) still pin br in their own mise.toml; untouched.
[tools]
`;

const PINNED = `[tools]
${BEADS_MISE_TOOL_KEY} = { version = "0.1.37", exe = "br" }
`;

describe('a prose mention of beads_rust is not an entry', () => {
  test("life's mise.toml is reported as ADDED, not as an update that changed nothing", () => {
    const outcome = applyBeadsMiseToolPin(LIFE_MISE_TOML, '0.1.37');

    expect(outcome.kind).toBe('added');
    if (outcome.kind !== 'added') throw new Error('unreachable');
    // The bytes REALLY change — the old code's failure was writing the input
    // back and calling it an update.
    expect(outcome.content).not.toBe(LIFE_MISE_TOML);
    expect(outcome.content).toContain(
      `${BEADS_MISE_TOOL_KEY} = { version = "0.1.37", exe = "br" }`,
    );
    // Exactly one line added, under [tools], and every comment preserved.
    expect(outcome.content.split('\n')).toHaveLength(
      LIFE_MISE_TOML.split('\n').length + 1,
    );
    for (const line of LIFE_MISE_TOML.split('\n')) {
      if (line !== '') expect(outcome.content).toContain(line);
    }
  });

  test('a commented-OUT entry is prose too: the real entry is added, the comment left alone', () => {
    const commentedOut = `[tools]
# ${BEADS_MISE_TOOL_KEY} = { version = "0.0.1", exe = "br" }
"npm:prettier" = "3.9.6"
`;

    const outcome = applyBeadsMiseToolPin(commentedOut, '0.1.37');

    expect(outcome.kind).toBe('added');
    if (outcome.kind !== 'added') throw new Error('unreachable');
    // The commented line still says 0.0.1 — nothing rewrote it in place.
    expect(outcome.content).toContain(
      `# ${BEADS_MISE_TOOL_KEY} = { version = "0.0.1", exe = "br" }`,
    );
    expect(outcome.content).toContain(
      `${BEADS_MISE_TOOL_KEY} = { version = "0.1.37", exe = "br" }`,
    );
  });

  test('NEGATIVE CONTROL: a real entry IS recognised, and is not added a second time', () => {
    const outcome = applyBeadsMiseToolPin(PINNED, '0.1.37');

    expect(outcome.kind).toBe('already-pinned');
  });

  test('a prose mention with no [tools] table gets one, and keeps the prose', () => {
    const prose = '# beads_rust was removed here on purpose\n';

    const outcome = applyBeadsMiseToolPin(prose, '0.1.37');

    expect(outcome.kind).toBe('added');
    if (outcome.kind !== 'added') throw new Error('unreachable');
    expect(outcome.content).toContain(
      '# beads_rust was removed here on purpose',
    );
    expect(outcome.content).toContain('[tools]');
    expect(outcome.content.endsWith('\n')).toBe(true);
  });

  test('a commented-out [tools] header is not a table: the entry does not land in the comment', () => {
    const outcome = applyBeadsMiseToolPin(
      '# [tools] used to live here\n',
      '0.1.37',
    );

    expect(outcome.kind).toBe('added');
    if (outcome.kind !== 'added') throw new Error('unreachable');
    expect(outcome.content).toContain('# [tools] used to live here');
    expect(outcome.content).toMatch(/^\[tools\]$/m);
  });
});

describe('a real entry is rewritten, and a rewrite that changed nothing is a failure', () => {
  test('a differing version is updated, and the old one is reported', () => {
    const outcome = applyBeadsMiseToolPin(PINNED, '0.4.1');

    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') throw new Error('unreachable');
    expect(outcome.from).toBe('0.1.37');
    expect(outcome.content).toContain('version = "0.4.1"');
    expect(outcome.content).not.toContain('0.1.37');
  });

  test('an entry not in the { version = "…" } form REFUSES rather than reporting success', () => {
    const shortForm = `[tools]
${BEADS_MISE_TOOL_KEY} = "0.1.37"
`;

    const outcome = applyBeadsMiseToolPin(shortForm, '0.4.1');

    expect(outcome.kind).toBe('unrewritable');
    if (outcome.kind !== 'unrewritable') throw new Error('unreachable');
    expect(outcome.reason).toContain('Refusing to guess');
  });

  test('indentation and key order do not hide a real entry', () => {
    const indented = `[tools]
  ${BEADS_MISE_TOOL_KEY} = { exe = "br", version = "0.1.37" }
`;

    const outcome = applyBeadsMiseToolPin(indented, '0.4.1');

    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') throw new Error('unreachable');
    expect(outcome.content).toContain('{ exe = "br", version = "0.4.1" }');
  });
});
