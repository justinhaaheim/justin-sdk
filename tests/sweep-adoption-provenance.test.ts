/**
 * ADOPTION REQUIRES PROVENANCE, and beads can never reach a Dolt workspace
 * (dchjw.19).
 *
 * WHAT WENT WRONG, measured rather than imagined. The first full-fleet
 * `sweep --component install --dry-run` printed `life: adopt: beads-setup`.
 * `~/Dev/life` is a Dolt (`bd`) workspace on purpose; beads-setup installs
 * beads_rust, and its migration step classifies a Dolt `.beads/` as `legacy`
 * and then `rmSync(.beads, {recursive: true, force: true})` — unattended, with
 * no flag, no prompt and no dry-run. The adoption came from
 * `componentInstalledEvidence`, which is CORRECTLY generous for `install` (a
 * false "not installed" there would silently skip a component) and wrong for a
 * decision that WRITES a component name into a repo's committed config.
 *
 * Three independent guards are asserted here, each with the negative control
 * that proves it is the thing doing the work:
 *
 *   1. `isBeadsRust` — a Dolt repo WITH full SDK provenance for beads is still
 *      not adopted. Drop the predicate and it is: the predicate is load-bearing.
 *   2. Provenance — a Dolt repo WITHOUT the mise pin is not adopted even with
 *      the predicate dropped, so the two guards are genuinely independent.
 *   3. The installer — `beadsSetupRefusal` refuses a Dolt workspace and does
 *      NOT refuse an ordinary br one. Needed because `install` applies a listed
 *      component even when its includeIf fails, so guards 1 and 2 (which only
 *      decide what a SWEEP writes) cannot be the last line.
 *
 * And the general rule, on prettier: a hand-written `.prettierrc.json` is
 * reported, never adopted; one byte-identical to the template is adopted.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join, resolve} from 'path';

import {beadsSetupRefusal, DOLT_BACKEND_REASON} from '../src/beads-setup';
import {
  componentInstalledEvidence,
  componentProvenanceEvidence,
} from '../src/component-manifest';
import {COMPONENT_INCLUDE_IF} from '../src/component-registry';
import {THREAD_START_HOOK_COMMAND} from '../src/thread-hooks-setup';
import {
  adoptInstalledComponents,
  noProvenanceLine,
  planInstallPayload,
  renderInstallPayloadPlan,
} from '../src/sweep-install';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), {recursive: true});
  writeFileSync(full, content);
}

/** The bytes the prettier component would write into any repo right now. */
function prettierTemplate(): string {
  return readFileSync(
    resolve(
      import.meta.dirname,
      '..',
      'templates',
      'configs',
      '.prettierrc.json',
    ),
    'utf-8',
  );
}

/**
 * An enrolled repo listing NOTHING, so every component is a candidate for
 * adoption and the detector is what decides.
 */
function enrolled(sb: Sandbox, name: string): string {
  const root = join(sb.path, name);
  mkdirSync(root, {recursive: true});
  write(root, 'package.json', '{"name":"fixture"}\n');
  write(root, 'justin-sdk.config.json', '{"components": []}\n');
  return root;
}

/** `.beads/` with a Dolt `metadata.json` — exactly what `~/Dev/life` carries. */
function doltWorkspace(root: string): void {
  write(
    root,
    '.beads/metadata.json',
    `${JSON.stringify({
      backend: 'dolt',
      database: 'dolt',
      dolt_database: 'jl',
      dolt_mode: 'embedded',
    })}\n`,
  );
  write(root, '.beads/issues.jsonl', '{"id":"jl-1","title":"a real issue"}\n');
}

/** The mise pin beads-setup writes — the ONLY provenance this component has. */
function beadsMisePin(root: string): void {
  write(
    root,
    'mise.toml',
    '[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "0.4.1", exe = "br" }\n',
  );
}

const adoptedNames = (root: string): string[] =>
  adoptInstalledComponents(root, {components: []}).adopted;

// ---------------------------------------------------------------------------
// 1 + 2. A Dolt workspace is never adopted, and both guards are load-bearing
// ---------------------------------------------------------------------------

describe('a Dolt workspace never adopts beads', () => {
  test('not adopted, even with the mise pin that IS beads provenance', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'life-like');
    doltWorkspace(root);
    beadsMisePin(root);

    // The provenance half genuinely passes — this repo has the SDK's own pin.
    expect(componentProvenanceEvidence(root, 'beads').kind).toBe('sdk');
    // And it is STILL not adopted.
    expect(adoptedNames(root)).not.toContain('beads-setup');

    const result = adoptInstalledComponents(root, {components: []});
    const beads = result.notAdopted.find((e) => e.configName === 'beads-setup');
    expect(beads?.reason).toContain('does not apply to this repo');
    expect(beads?.reason).toContain('isBeadsRust');
  });

  test('NEGATIVE CONTROL: drop the isBeadsRust predicate and it IS adopted', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'life-like');
    doltWorkspace(root);
    beadsMisePin(root);

    const saved = COMPONENT_INCLUDE_IF.beads;
    try {
      delete COMPONENT_INCLUDE_IF.beads;
      expect(adoptedNames(root)).toContain('beads-setup');
    } finally {
      COMPONENT_INCLUDE_IF.beads = saved;
    }
    // Restored — the guard is back for every later test in this file.
    expect(adoptedNames(root)).not.toContain('beads-setup');
  });

  test('the two guards are INDEPENDENT: no mise pin means no adoption either', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'life-no-pin');
    doltWorkspace(root);

    // `.beads/` alone is what the old detector adopted on. It is now weak.
    expect(componentInstalledEvidence(root, 'beads')).toEqual({
      because: '.beads',
      installed: true,
    });
    expect(componentProvenanceEvidence(root, 'beads').kind).toBe('weak');

    const saved = COMPONENT_INCLUDE_IF.beads;
    try {
      delete COMPONENT_INCLUDE_IF.beads;
      expect(adoptedNames(root)).not.toContain('beads-setup');
    } finally {
      COMPONENT_INCLUDE_IF.beads = saved;
    }
  });

  test('a real beads_rust repo with the pin IS adopted', () => {
    // Without this, every assertion above would pass on a detector that had
    // simply stopped adopting beads anywhere.
    const sb = track(createSandbox());
    const root = enrolled(sb, 'br-repo');
    write(
      root,
      '.beads/metadata.json',
      `${JSON.stringify({database: 'beads.db', jsonl_export: 'issues.jsonl'})}\n`,
    );
    beadsMisePin(root);
    expect(adoptedNames(root)).toContain('beads-setup');
  });
});

// ---------------------------------------------------------------------------
// 3. The installer itself refuses — the guard install cannot route around
// ---------------------------------------------------------------------------

describe('beadsSetupRefusal', () => {
  test('refuses a Dolt workspace, naming what it would have deleted', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'life-like');
    doltWorkspace(root);

    const refusal = beadsSetupRefusal(root);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('Dolt');
    expect(refusal).toContain('DELETES');
    expect(refusal).toContain('Nothing has been written');
  });

  test('NEGATIVE CONTROL: an ordinary beads_rust workspace is NOT refused', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'br-repo');
    write(
      root,
      '.beads/metadata.json',
      `${JSON.stringify({database: 'beads.db', jsonl_export: 'issues.jsonl'})}\n`,
    );
    write(root, '.beads/issues.jsonl', '{"id":"x-1"}\n');
    expect(beadsSetupRefusal(root)).toBeNull();
  });

  test('NEGATIVE CONTROL: a repo with no .beads/ at all is NOT refused', () => {
    const sb = track(createSandbox());
    expect(beadsSetupRefusal(enrolled(sb, 'fresh'))).toBeNull();
  });

  test('the refusal keys on the classifier, not on prose', () => {
    // DOLT_BACKEND_REASON is the contract between detectBeadsWorkspace and the
    // refusal. If someone rewords it in one place only, this fails rather than
    // the guard silently never firing again.
    expect(DOLT_BACKEND_REASON).toBe('old Dolt (bd) backend');
  });
});

// ---------------------------------------------------------------------------
// The general rule: template-identical is provenance, hand-written is not
// ---------------------------------------------------------------------------

describe('a generic config file is evidence, not provenance', () => {
  test('a HAND-WRITTEN .prettierrc.json is reported and not adopted', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'swift-like');
    write(root, '.prettierrc.json', '{"semi": false, "tabWidth": 4}\n');

    // The old detector said "installed" on the filename alone.
    expect(componentInstalledEvidence(root, 'prettier').installed).toBe(true);
    expect(componentProvenanceEvidence(root, 'prettier').kind).toBe('weak');

    const result = adoptInstalledComponents(root, {components: []});
    expect(result.adopted).not.toContain('prettier-setup');

    const entry = result.notAdopted.find(
      (e) => e.configName === 'prettier-setup',
    );
    expect(entry).toBeDefined();
    if (entry == null) throw new Error('unreachable');
    expect(noProvenanceLine(entry)).toContain(
      'looks installed but not adopted (no SDK provenance): prettier-setup',
    );
    expect(noProvenanceLine(entry)).toContain('.prettierrc.json');
  });

  test('a TEMPLATE-IDENTICAL .prettierrc.json IS adopted', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'ours');
    write(root, '.prettierrc.json', prettierTemplate());

    const evidence = componentProvenanceEvidence(root, 'prettier');
    expect(evidence.kind).toBe('sdk');
    if (evidence.kind !== 'sdk') throw new Error('unreachable');
    expect(evidence.because).toContain('byte-identical to the template');
    expect(adoptedNames(root)).toContain('prettier-setup');
  });

  test('ONE BYTE of drift is enough to stop adopting it', () => {
    // The sharpest control there is: same file, same name, one character.
    const sb = track(createSandbox());
    const root = enrolled(sb, 'nearly');
    write(root, '.prettierrc.json', `${prettierTemplate()} `);
    expect(componentProvenanceEvidence(root, 'prettier').kind).toBe('weak');
    expect(adoptedNames(root)).not.toContain('prettier-setup');
  });

  test('a hand-composed .husky/post-checkout is not husky provenance', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'swift-like');
    write(root, '.husky/post-checkout', '#!/bin/sh\necho mine\n');
    expect(componentInstalledEvidence(root, 'husky').installed).toBe(true);
    expect(componentProvenanceEvidence(root, 'husky').kind).toBe('weak');
    expect(adoptedNames(root)).not.toContain('husky-setup');
  });

  test('`prepare: husky` alone is NOT husky provenance', () => {
    // Found by running the real fleet dry-run: apple-reminders-mcp (Swift) has
    // `prepare: "husky"` and a `.husky/pre-commit`, and no SDK managed block
    // anywhere — and was being adopted into husky-setup on that script alone.
    // `husky init` writes that exact line; husky's own docs tell every user to.
    const sb = track(createSandbox());
    const root = enrolled(sb, 'husky-of-its-own');
    write(root, 'package.json', '{"name":"f","scripts":{"prepare":"husky"}}\n');
    write(root, '.husky/pre-commit', '#!/bin/sh\nmy own thing\n');
    expect(componentProvenanceEvidence(root, 'husky').kind).toBe('weak');
    expect(adoptedNames(root)).not.toContain('husky-setup');
  });

  test('the SDK managed-block marker IS husky provenance', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'ours');
    write(
      root,
      '.husky/post-checkout',
      '#!/bin/sh\n# >>> justin-sdk:worktree-hydration\n# <<< justin-sdk:worktree-hydration\n',
    );
    expect(componentProvenanceEvidence(root, 'husky').kind).toBe('sdk');
    expect(adoptedNames(root)).toContain('husky-setup');
  });

  function withSessionStartHook(root: string, command: string): void {
    write(
      root,
      '.claude/settings.json',
      `${JSON.stringify({
        hooks: {SessionStart: [{hooks: [{command, type: 'command'}]}]},
      })}\n`,
    );
  }

  test('a hand-composed hook command is not thread-hooks provenance', () => {
    // isSdkEmittedCommand is the line. This command carries the fingerprint —
    // so the generous detector says "installed" and `upsertHookCommand` will
    // not duplicate it — but a human wrote the wrapper, and a command the SDK
    // did not emit is not grounds to enrol a repo in the component.
    const sb = track(createSandbox());
    const root = enrolled(sb, 'handmade');
    withSessionStartHook(root, 'cd /repo && justin-sdk thread start --hook');

    expect(componentInstalledEvidence(root, 'thread-hooks').installed).toBe(
      true,
    );
    expect(componentProvenanceEvidence(root, 'thread-hooks').kind).toBe('weak');
    expect(adoptedNames(root)).not.toContain('thread-hooks-setup');
  });

  test('NEGATIVE CONTROL: the command the SDK emits IS provenance', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'ours');
    withSessionStartHook(root, THREAD_START_HOOK_COMMAND);
    expect(componentProvenanceEvidence(root, 'thread-hooks').kind).toBe('sdk');
    expect(adoptedNames(root)).toContain('thread-hooks-setup');
  });

  test('nothing there at all is ABSENT, not weak — and prints no line', () => {
    // Silence has to be a claim: "I checked and found none" must not look the
    // same as "I found something I could not verify" (critical rule 6).
    const sb = track(createSandbox());
    const root = enrolled(sb, 'bare');
    expect(componentProvenanceEvidence(root, 'eslint')).toEqual({
      kind: 'absent',
    });
    const result = adoptInstalledComponents(root, {components: []});
    expect(result.notAdopted.map((e) => e.configName)).not.toContain(
      'eslint-setup',
    );
  });
});

// ---------------------------------------------------------------------------
// The rendered plan a human actually reads
// ---------------------------------------------------------------------------

describe('renderInstallPayloadPlan', () => {
  test('prints the no-provenance line for everything it declined', () => {
    const sb = track(createSandbox());
    const root = enrolled(sb, 'mixed');
    doltWorkspace(root);
    write(root, '.prettierrc.json', '{"semi": false}\n');

    const plan = planInstallPayload(root);
    if ('error' in plan) throw new Error(plan.error);
    const rendered = renderInstallPayloadPlan(plan).join('\n');

    expect(rendered).toContain(
      'looks installed but not adopted (no SDK provenance): beads-setup',
    );
    expect(rendered).toContain(
      'looks installed but not adopted (no SDK provenance): prettier-setup',
    );
    expect(plan.adopted).not.toContain('beads-setup');
    expect(plan.adopted).not.toContain('prettier-setup');
  });
});

// ---------------------------------------------------------------------------
// D1: every EMITTED `justin-sdk thread …` carries the `bun run` prefix
// ---------------------------------------------------------------------------

describe('D1 invocation form in thread output', () => {
  /** Every `.ts` under src/, recursively. */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  test('no CODE line spells `justin-sdk thread` without `bun run`', () => {
    // Comment lines (` * …`, `// …`, `/** … */`) are skipped: they are prose
    // naming a subcommand, not a string anyone is told to run. A code line is
    // the thing that reaches a terminal.
    const srcDir = resolve(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('*') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('/*')
        ) {
          return;
        }
        if (!line.includes('justin-sdk thread')) return;
        // The one deliberate exception: the Answer-line parser accepts the
        // legacy spelling so reports written before dchjw.19 still resolve.
        if (line.includes('(?:bun run )?justin-sdk thread')) return;
        if (line.includes('bun run justin-sdk thread')) return;
        offenders.push(
          `${file.slice(srcDir.length + 1)}:${index + 1}: ${trimmed}`,
        );
      });
    }
    expect(offenders).toEqual([]);
  });

  test('NEGATIVE CONTROL: the scanner does find a bare spelling', () => {
    // Proves the assertion above is measuring something. Without it, a scanner
    // that silently matched nothing (a bad path, a wrong extension) would read
    // as a clean suite.
    const sb = track(createSandbox());
    const dir = join(sb.path, 'src');
    mkdirSync(dir, {recursive: true});
    writeFileSync(
      join(dir, 'bad.ts'),
      "const s = 'run justin-sdk thread prepare';\n",
    );
    writeFileSync(
      join(dir, 'good.ts'),
      "const s = 'run bun run justin-sdk thread prepare';\n",
    );
    const found = sourceFiles(dir).filter((file) => {
      const text = readFileSync(file, 'utf-8');
      return (
        text.includes('justin-sdk thread') &&
        !text.includes('bun run justin-sdk thread')
      );
    });
    expect(found.map((f) => f.slice(dir.length + 1))).toEqual(['bad.ts']);
    expect(existsSync(join(dir, 'good.ts'))).toBe(true);
  });
});
