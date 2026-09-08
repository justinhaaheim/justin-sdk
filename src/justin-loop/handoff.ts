/**
 * The justin-loop HANDOFF BEAD — schema, creator, validator (home-base-1r6d.33.1).
 *
 * A justin-loop session ends by writing exactly one handoff bead. That bead is
 * BOTH the control signal and the payload (epic decision D2): the runner learns
 * what to do next ONLY from it, and there is no verdict file anywhere. Because
 * `br` has no native metadata, the bead's `notes` field holds ONLY a JSON object
 * with the schema below (D3), so plain tools can validate it and git preserves
 * the whole chain.
 *
 * Two entry points, both wired under `justin-sdk justin-loop handoff`:
 *   create    write the bead, refusing a second OPEN handoff from the same
 *             session (D5) — malformed JSON therefore never enters the DB from a
 *             compliant session (D4).
 *   validate  re-check one bead, or every open handoff bead, for the
 *             non-compliant case.
 *
 * MEASURED against br 0.1.37 AND br 0.4.1 (2026-09-08), identical on both:
 *   - `br create` has NO `--notes` flag, so creation is two commands:
 *       br create "<title>" -t task -p 1 --labels handoff --description=<text>
 *         → stdout `✓ Created <id>: <title>`
 *       br update <id> --notes=<json>
 *     The title itself contains a colon, so the id is parsed by anchoring on
 *     `Created <id>:`, never on the first colon in the line.
 *   - `br list -l handoff --json` and `br list --id <id> -a --json` both return
 *     `{issues:[…],total,…}` and each row carries `description` and `notes`.
 *   - A bead whose notes were never set has NO `notes` key at all (undefined),
 *     not `""` and not `null`.
 *   - `--description=` and `--notes=` round-trip multi-paragraph text byte for
 *     byte: embedded newlines, tabs, trailing spaces and double quotes all
 *     survive, and so does pretty-printed (multi-line) JSON.
 *   - `--no-auto-import` (appended by `runBr`) is accepted by both versions.
 *
 * The two-step create means a crash between the steps leaves a handoff bead with
 * no notes. That is why `validate` reports a note-less handoff bead as INVALID
 * rather than skipping it (D5 of this bead's design) and why a create whose
 * second step fails is reported loudly with the id, never as a plain failure.
 */

import {type BrOutcome, type BrRunner, runBr} from './br';

/**
 * The label that makes a bead a handoff bead (D3). The runner's whole scan is
 * `br list -l handoff --json`, so a handoff bead that loses this label is
 * invisible to the loop however good its JSON is.
 */
export const HANDOFF_LABEL = 'handoff';

/** Bumped only for a breaking change to the object below. */
export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * `continue` the loop boots a successor from `next`; `done` it stops because
 * the arc is finished; `blocked` it stops because only Justin can answer what
 * is in `openQuestions`.
 */
export type Disposition = 'continue' | 'done' | 'blocked';

export const DISPOSITIONS: readonly Disposition[] = [
  'continue',
  'done',
  'blocked',
];

export interface Handoff {
  schemaVersion: number;
  /** The session label the runner gave this session. Identity, per D5. */
  from: string;
  /** ISO-8601. */
  createdAt: string;
  disposition: Disposition;
  /** Epic/bead id or short name for the arc of work. */
  arc: string;
  /** ABSOLUTE path — a relative one means nothing to the successor's process. */
  worktree: string;
  branch: string;
  /** 2–4 sentences: where things stand. */
  state: string;
  /** The successor's full starting instructions. This text IS its prompt. */
  next: string;
  /** Always present. `[]` means "asked and there are none", never "unknown". */
  openQuestions: string[];
  /** From the latest usage notice. `null` = not measured, never 0. */
  contextTokens: number | null;
}

export type HandoffParse =
  {ok: true; handoff: Handoff} | {ok: false; errors: string[]};

/**
 * A single row of `br list --json`, carrying the fields the runner decides from:
 * `notes` (the whole contract, per D3) and `labels`.
 *
 * This is the ONLY row parser in src/justin-loop — the runner's old
 * `parseBeadList`, which dropped both fields, was deleted with the verdict file
 * (home-base-1r6d.33.2, note 12).
 *
 * `notes: null` is load-bearing — it means br reported no notes for this bead,
 * which is a real, reachable state (a create that died between its two steps)
 * and one `parseHandoff` must reject rather than ignore.
 */
export interface HandoffRow {
  id: string;
  title: string;
  status: string;
  notes: string | null;
  /** MEASURED: br omits the key entirely when a bead has no labels. */
  labels: string[];
  updatedAt: string | null;
}

/**
 * Parse `br list --json` into rows.
 *
 * Returns null — not [] — on anything unexpected, and rejects the WHOLE list if
 * one row is missing a field we need. Silently dropping a row would understate
 * how many open handoffs exist, and that error points the reassuring way: it
 * reads as "no conflict, go ahead and create another" (critical rule 6).
 */
export function parseHandoffRows(stdout: string): HandoffRow[] | null {
  let parsed: {issues?: unknown};
  try {
    parsed = JSON.parse(stdout) as {issues?: unknown};
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.issues)) return null;
  const rows: HandoffRow[] = [];
  for (const raw of parsed.issues as Array<Record<string, unknown>>) {
    if (
      typeof raw.id !== 'string' ||
      raw.id === '' ||
      typeof raw.title !== 'string' ||
      typeof raw.status !== 'string'
    ) {
      return null;
    }
    // An absent `labels` key means the bead has none (measured on both br
    // versions). A `labels` that is present but not an array of strings is a
    // shape we do not understand, and guessing there would be the reassuring
    // guess — reject the whole list instead.
    let labels: string[] = [];
    if (raw.labels !== undefined) {
      if (
        !Array.isArray(raw.labels) ||
        raw.labels.some((l) => typeof l !== 'string')
      ) {
        return null;
      }
      labels = raw.labels as string[];
    }
    // An absent `notes` key is NOT a malformed row (measured: that is exactly
    // what br returns for a bead whose notes were never set). It becomes an
    // explicit null, which parseHandoff then rejects by name.
    rows.push({
      id: raw.id,
      labels,
      notes: typeof raw.notes === 'string' ? raw.notes : null,
      status: raw.status,
      title: raw.title,
      updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    });
  }
  return rows;
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
): string | null {
  const value = obj[field];
  if (value === undefined || value === null) {
    errors.push(`${field} is missing`);
    return null;
  }
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string (got ${typeof value})`);
    return null;
  }
  if (value.trim() === '') {
    errors.push(`${field} is empty`);
    return null;
  }
  return value;
}

/**
 * Parse the JSON in a handoff bead's `notes` field.
 *
 * The argument is the bead's notes, because per D3 the notes ARE the contract —
 * everything else on the bead is a human-readable rendering of what is in here.
 * `null`/`undefined` (br reported no notes) and `''` are both rejected by name
 * rather than being treated as "nothing to check".
 *
 * Every error names the field it is about, so `validate`'s output tells the
 * session what to fix without anyone opening this file.
 */
export function parseHandoff(notes: string | null | undefined): HandoffParse {
  if (notes == null || notes.trim() === '') {
    return {
      errors: [
        'notes is empty — a handoff bead must carry the handoff JSON in its notes field',
      ],
      ok: false,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(notes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {errors: [`notes is not valid JSON: ${detail}`], ok: false};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      errors: [
        `notes must be a JSON object, not ${Array.isArray(raw) ? 'an array' : `a ${typeof raw}`}`,
      ],
      ok: false,
    };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion === undefined) {
    errors.push('schemaVersion is missing');
  } else if (schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${HANDOFF_SCHEMA_VERSION} (got ${JSON.stringify(schemaVersion)})`,
    );
  }

  const from = requireString(obj, 'from', errors);
  const createdAt = requireString(obj, 'createdAt', errors);
  if (createdAt != null && Number.isNaN(Date.parse(createdAt))) {
    errors.push(`createdAt is not a parseable timestamp: ${createdAt}`);
  }

  const dispositionRaw = obj.disposition;
  let disposition: Disposition | null = null;
  if (dispositionRaw === undefined || dispositionRaw === null) {
    errors.push(`disposition is missing (one of ${DISPOSITIONS.join(', ')})`);
  } else if (
    typeof dispositionRaw !== 'string' ||
    !(DISPOSITIONS as readonly string[]).includes(dispositionRaw)
  ) {
    errors.push(
      `disposition must be one of ${DISPOSITIONS.join(', ')} (got ${JSON.stringify(dispositionRaw)})`,
    );
  } else {
    disposition = dispositionRaw as Disposition;
  }

  const arc = requireString(obj, 'arc', errors);
  const worktree = requireString(obj, 'worktree', errors);
  // A relative worktree is unusable by the successor, which starts in an
  // unrelated cwd. Reject it here rather than letting the runner resolve it
  // against whatever directory it happens to be in.
  if (worktree != null && !worktree.startsWith('/')) {
    errors.push(`worktree must be an absolute path (got ${worktree})`);
  }
  const branch = requireString(obj, 'branch', errors);
  const state = requireString(obj, 'state', errors);
  const next = requireString(obj, 'next', errors);

  const openQuestionsRaw = obj.openQuestions;
  let openQuestions: string[] | null = null;
  if (openQuestionsRaw === undefined || openQuestionsRaw === null) {
    // Absent is not the same claim as `[]`. `[]` says the session looked and
    // had none; absent says nobody recorded anything (critical rule 6).
    errors.push('openQuestions is missing (write [] when there are none)');
  } else if (
    !Array.isArray(openQuestionsRaw) ||
    openQuestionsRaw.some((q) => typeof q !== 'string')
  ) {
    errors.push('openQuestions must be an array of strings');
  } else {
    openQuestions = openQuestionsRaw as string[];
  }

  const contextTokensRaw = obj.contextTokens;
  let contextTokens: number | null = null;
  if (contextTokensRaw === undefined) {
    errors.push('contextTokens is missing (write null when it is not known)');
  } else if (contextTokensRaw !== null) {
    if (
      typeof contextTokensRaw !== 'number' ||
      !Number.isFinite(contextTokensRaw)
    ) {
      errors.push(
        `contextTokens must be a number or null (got ${JSON.stringify(contextTokensRaw)})`,
      );
    } else {
      contextTokens = contextTokensRaw;
    }
  }

  if (errors.length > 0) return {errors, ok: false};

  return {
    handoff: {
      arc: arc as string,
      branch: branch as string,
      contextTokens,
      createdAt: createdAt as string,
      disposition: disposition as Disposition,
      from: from as string,
      next: next as string,
      openQuestions: openQuestions as string[],
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      state: state as string,
      worktree: worktree as string,
    },
    ok: true,
  };
}

/** Serialize for the `notes` field. Pretty-printed so `br show` is readable. */
export function handoffJson(handoff: Handoff): string {
  return JSON.stringify(
    {
      schemaVersion: handoff.schemaVersion,
      from: handoff.from,
      createdAt: handoff.createdAt,
      disposition: handoff.disposition,
      arc: handoff.arc,
      worktree: handoff.worktree,
      branch: handoff.branch,
      state: handoff.state,
      next: handoff.next,
      openQuestions: handoff.openQuestions,
      contextTokens: handoff.contextTokens,
    },
    null,
    2,
  );
}

/** `HANDOFF <disposition>: <arc>` (D4). */
export function handoffTitle(handoff: Handoff): string {
  return `HANDOFF ${handoff.disposition}: ${handoff.arc}`;
}

/**
 * The human-readable half (D4): the same facts as the JSON, for anyone reading
 * `br show` or the git diff. The JSON in `notes` stays the machine contract —
 * nothing parses this.
 */
export function handoffDescription(handoff: Handoff): string {
  const lines = [
    `from: ${handoff.from}`,
    `disposition: ${handoff.disposition}`,
    `arc: ${handoff.arc}`,
    `worktree: ${handoff.worktree}`,
    `branch: ${handoff.branch}`,
    `createdAt: ${handoff.createdAt}`,
    `contextTokens: ${handoff.contextTokens ?? 'not measured'}`,
    '',
    'STATE',
    handoff.state,
    '',
    'NEXT (this text is the successor session’s starting prompt)',
    handoff.next,
    '',
    'OPEN QUESTIONS',
    ...(handoff.openQuestions.length > 0
      ? handoff.openQuestions.map((q) => `- ${q}`)
      : ['(none)']),
    '',
    'The machine-readable copy of all of this is the JSON in this bead’s notes field.',
  ];
  return lines.join('\n');
}

/** Everything `justin-loop handoff` needs, already validated by the CLI layer. */
export interface HandoffInput {
  from: string;
  disposition: Disposition;
  arc: string;
  worktree: string;
  branch: string;
  state: string;
  next: string;
  openQuestions: string[];
  contextTokens: number | null;
}

/**
 * Something the create path found in the open handoff beads.
 *
 * `same-from` REFUSES the create: a second open handoff from the same session
 * would fork the chain into two successors (D5).
 *
 * `unreadable` only WARNS (home-base-1r6d.33.2, note 11). A bead whose notes do
 * not parse has an unknown `from`, so it cannot be positively ruled out as this
 * session's — but the runner never spawns from a bead it cannot parse, so an
 * unreadable bead cannot cause the fan-out the refusal exists to prevent.
 * Blocking on it bought nothing and cost everything: ONE corrupt or half-written
 * bead anywhere in the repo stranded every subsequent session's handoff, which
 * is a far worse failure than the one being guarded against. So it is surfaced
 * loudly on stderr, with the command to clean it up, and creation proceeds.
 */
export interface HandoffConflict {
  id: string;
  kind: 'same-from' | 'unreadable';
  detail: string;
}

/**
 * What the pre-create scan of the open handoff beads turned up.
 *
 * The two lists are kept apart because they mean different things and get
 * different treatment: `conflicts` stop the create, `unreadable` do not. Folding
 * them into one list is exactly what note 11 undid.
 */
export interface FromScanFindings {
  conflicts: HandoffConflict[];
  unreadable: HandoffConflict[];
}

export type CreateHandoffOutcome =
  | {kind: 'created'; id: string; json: string; warnings: HandoffConflict[]}
  | {kind: 'refused'; conflicts: HandoffConflict[]; warnings: HandoffConflict[]}
  /** The bead exists but its notes were never written — the two-step gap. */
  | {
      kind: 'incomplete';
      id: string;
      json: string;
      reason: string;
      warnings: HandoffConflict[];
    }
  | {kind: 'unavailable'; reason: string};

function brFailure(out: BrOutcome): string {
  return out.reason ?? 'br failed for an unrecorded reason';
}

/**
 * Parse `✓ Created fx-5yy: HANDOFF continue: some arc` → `fx-5yy`.
 *
 * Anchored on `Created <id>:` because the TITLE contains a colon too — splitting
 * on the first colon would work today and break the moment br reorders the line.
 */
export function parseCreatedId(stdout: string): string | null {
  const match = /Created\s+(\S+):/.exec(stdout);
  const id = match?.[1];
  return id != null && id !== '' ? id : null;
}

/**
 * Sort the OPEN handoff beads into the ones that refuse this create and the ones
 * that merely need saying out loud (note 11).
 *
 * An unreadable bead is NEVER silently dropped — it lands in `unreadable` and is
 * printed. "Checked, and there is no conflict" and "could not check one of them"
 * stay different facts (critical rule 6); what changed is only which of them
 * stops the create.
 */
export function findFromConflicts(
  rows: HandoffRow[],
  from: string,
): FromScanFindings {
  const conflicts: HandoffConflict[] = [];
  const unreadable: HandoffConflict[] = [];
  for (const row of rows) {
    const parsed = parseHandoff(row.notes);
    if (!parsed.ok) {
      unreadable.push({
        detail: `its notes do not parse, so its \`from\` is unknown (${parsed.errors[0] ?? 'unreadable'})`,
        id: row.id,
        kind: 'unreadable',
      });
      continue;
    }
    if (parsed.handoff.from === from) {
      conflicts.push({
        detail: `already open for from=${from} (${parsed.handoff.disposition})`,
        id: row.id,
        kind: 'same-from',
      });
    }
  }
  return {conflicts, unreadable};
}

/**
 * Write the handoff bead, refusing a second open one from the same session (D5).
 *
 * `now` is injected so the fixture tests can pin `createdAt`.
 */
export function createHandoff(
  cwd: string,
  input: HandoffInput,
  run: BrRunner = runBr,
  now: () => Date = () => new Date(),
): CreateHandoffOutcome {
  const listed = run(cwd, ['list', '-l', HANDOFF_LABEL, '--json']);
  if (!listed.ok) {
    return {kind: 'unavailable', reason: brFailure(listed)};
  }
  const rows = parseHandoffRows(listed.stdout);
  if (rows == null) {
    return {
      kind: 'unavailable',
      reason: 'could not parse `br list -l handoff --json`',
    };
  }
  const {conflicts, unreadable} = findFromConflicts(rows, input.from);
  // Only a POSITIVELY identified same-from bead refuses (note 11). Unreadable
  // ones ride along as warnings so they are still impossible to miss.
  if (conflicts.length > 0) {
    return {conflicts, kind: 'refused', warnings: unreadable};
  }

  const handoff: Handoff = {
    arc: input.arc,
    branch: input.branch,
    contextTokens: input.contextTokens,
    createdAt: now().toISOString(),
    disposition: input.disposition,
    from: input.from,
    next: input.next,
    openQuestions: input.openQuestions,
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    state: input.state,
    worktree: input.worktree,
  };
  const json = handoffJson(handoff);

  const created = run(cwd, [
    'create',
    handoffTitle(handoff),
    '-t',
    'task',
    '-p',
    '1',
    '--labels',
    HANDOFF_LABEL,
    `--description=${handoffDescription(handoff)}`,
  ]);
  if (!created.ok) return {kind: 'unavailable', reason: brFailure(created)};

  const id = parseCreatedId(created.stdout);
  if (id == null) {
    // br said it succeeded but we cannot name what it made. The bead may well
    // exist; reporting "created" would hand the runner an id we do not have.
    return {
      kind: 'unavailable',
      reason: `\`br create\` succeeded but its output did not name an id: ${JSON.stringify(created.stdout.trim())}`,
    };
  }

  const noted = run(cwd, ['update', id, `--notes=${json}`]);
  if (!noted.ok) {
    return {
      id,
      json,
      kind: 'incomplete',
      reason: brFailure(noted),
      warnings: unreadable,
    };
  }
  return {id, json, kind: 'created', warnings: unreadable};
}

export interface HandoffCheck {
  id: string;
  title: string;
  status: string;
  /**
   * A handoff bead that lost its `handoff` label is invisible to the runner's
   * scan, so it is invalid however good its JSON is — that failure is exactly
   * the silent-shaped kind (the loop reports "nothing waiting").
   */
  labelled: boolean;
  parse: HandoffParse;
}

function checkRow(row: HandoffRow): HandoffCheck {
  return {
    id: row.id,
    labelled: row.labels.includes(HANDOFF_LABEL),
    parse: parseHandoff(row.notes),
    status: row.status,
    title: row.title,
  };
}

/** A check fails on either half: the label or the JSON. */
export function checkErrors(check: HandoffCheck): string[] {
  const errors = check.parse.ok ? [] : [...check.parse.errors];
  if (!check.labelled) {
    errors.unshift(
      `bead is not labelled \`${HANDOFF_LABEL}\`, so the runner's scan will never see it`,
    );
  }
  return errors;
}

export type ValidateHandoffOutcome =
  | {kind: 'checked'; checks: HandoffCheck[]}
  /** A named id that br does not have — distinct from "checked and invalid". */
  | {kind: 'missing'; id: string}
  | {kind: 'unavailable'; reason: string};

/**
 * Check one handoff bead by id, or every OPEN handoff bead when `id` is null.
 *
 * The by-id lookup passes `-a` so a CLOSED handoff can still be validated —
 * "already claimed" and "does not exist" must not collapse into one answer.
 */
export function validateHandoffs(
  cwd: string,
  id: string | null,
  run: BrRunner = runBr,
): ValidateHandoffOutcome {
  const args =
    id != null
      ? ['list', '--id', id, '-a', '--json']
      : ['list', '-l', HANDOFF_LABEL, '--json'];
  const listed = run(cwd, args);
  if (!listed.ok) return {kind: 'unavailable', reason: brFailure(listed)};

  const rows = parseHandoffRows(listed.stdout);
  if (rows == null) {
    return {
      kind: 'unavailable',
      reason: `could not parse \`br ${args.join(' ')}\``,
    };
  }
  if (id != null) {
    const row = rows.find((r) => r.id === id);
    if (row == null) return {id, kind: 'missing'};
    return {checks: [checkRow(row)], kind: 'checked'};
  }
  return {checks: rows.map(checkRow), kind: 'checked'};
}

/**
 * What a command prints and exits with.
 *
 * Exit codes (D7): 0 created/valid · 1 refused/invalid · 2 br unavailable. The
 * third is separate on purpose — "br could not tell us" must never be spendable
 * as "there is nothing there".
 */
export interface CommandReport {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/**
 * On success stdout is EXACTLY the bead id and nothing else, so the runner can
 * capture it with no parsing; the human-readable confirmation goes to stderr.
 * Same contract as `justin-sdk worktree-new`.
 */
/**
 * How an unreadable open handoff bead is reported (note 11).
 *
 * It does not stop anything, so it has to be loud, and it has to carry the fix —
 * otherwise it is a line nobody acts on and the corrupt bead stays forever.
 */
export function renderWarnings(warnings: HandoffConflict[]): string[] {
  return warnings.flatMap((w) => [
    `WARNING: open handoff bead ${w.id} is unreadable — ${w.detail}`,
    `  It is invisible to the runner's scan. If it is an orphan, close it: br close ${w.id} --reason='orphaned handoff, unreadable notes'`,
  ]);
}

export function renderCreate(outcome: CreateHandoffOutcome): CommandReport {
  switch (outcome.kind) {
    case 'created':
      return {
        exitCode: 0,
        stderr: [
          ...renderWarnings(outcome.warnings),
          `✓ handoff bead ${outcome.id} created`,
        ],
        stdout: [outcome.id],
      };
    case 'refused': {
      const lines = [
        ...renderWarnings(outcome.warnings),
        'REFUSED: this session already has an open handoff bead (one per session, D5).',
        ...outcome.conflicts.map((c) => `  ${c.id} — ${c.detail}`),
        'Close or fix the bead above before writing another handoff.',
      ];
      return {exitCode: 1, stderr: lines, stdout: []};
    }
    case 'incomplete':
      return {
        exitCode: 2,
        stderr: [
          ...renderWarnings(outcome.warnings),
          `INCOMPLETE: bead ${outcome.id} was created but its notes could not be written: ${outcome.reason}`,
          'It will FAIL validation until the JSON is written. Fix it with:',
          `  br update ${outcome.id} --notes='<the JSON below>'`,
          outcome.json,
        ],
        stdout: [],
      };
    case 'unavailable':
      return {
        exitCode: 2,
        stderr: [
          `br unavailable: ${outcome.reason}`,
          'No handoff bead was created.',
        ],
        stdout: [],
      };
  }
}

export function renderValidate(outcome: ValidateHandoffOutcome): CommandReport {
  switch (outcome.kind) {
    case 'unavailable':
      return {
        exitCode: 2,
        stderr: [
          `br unavailable: ${outcome.reason}`,
          'Nothing was checked — this is NOT the same as "every handoff is valid".',
        ],
        stdout: [],
      };
    case 'missing':
      return {
        exitCode: 1,
        stderr: [`no bead ${outcome.id} — nothing to validate`],
        stdout: [],
      };
    case 'checked': {
      const invalid = outcome.checks.filter((c) => checkErrors(c).length > 0);
      const valid = outcome.checks.filter((c) => checkErrors(c).length === 0);
      if (outcome.checks.length === 0) {
        return {
          exitCode: 0,
          stderr: [],
          stdout: [
            `checked: no open handoff beads (label \`${HANDOFF_LABEL}\`), so there is nothing invalid`,
          ],
        };
      }
      const lines: string[] = [];
      for (const check of outcome.checks) {
        const errors = checkErrors(check);
        if (errors.length === 0 && check.parse.ok) {
          lines.push(
            `✓ ${check.id} valid — ${check.parse.handoff.disposition} · from=${check.parse.handoff.from} · arc=${check.parse.handoff.arc}`,
          );
        } else {
          lines.push(`✗ ${check.id} INVALID — ${check.title}`);
          for (const err of errors) lines.push(`    ${err}`);
        }
      }
      lines.push(
        `${valid.length} valid, ${invalid.length} invalid, ${outcome.checks.length} checked`,
      );
      return {exitCode: invalid.length > 0 ? 1 : 0, stderr: [], stdout: lines};
    }
  }
}

/** Print a report and return its exit code. */
export function emit(report: CommandReport): number {
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  return report.exitCode;
}

/**
 * Flags the creator cannot do without.
 *
 * Checked here rather than with yargs `demandOption` because options declared on
 * the `handoff` command apply to its `validate` subcommand too, so a
 * `demandOption` would make `handoff validate` demand `--from`.
 */
export const REQUIRED_CREATE_FLAGS = [
  'from',
  'disposition',
  'arc',
  'worktree',
  'branch',
  'state',
  'next',
] as const;

export type RawCreateFlags = Partial<
  Record<(typeof REQUIRED_CREATE_FLAGS)[number], string | undefined>
> & {
  openQuestions?: string[];
  contextTokens?: number;
};

export type CreateFlagsParse =
  {ok: true; input: HandoffInput} | {ok: false; errors: string[]};

/** Turn argv into a `HandoffInput`, naming every flag that is wrong or absent. */
export function parseCreateFlags(flags: RawCreateFlags): CreateFlagsParse {
  const errors: string[] = [];
  for (const flag of REQUIRED_CREATE_FLAGS) {
    const value = flags[flag];
    if (value === undefined || value.trim() === '') {
      errors.push(`--${flag} is required`);
    }
  }
  const disposition = flags.disposition;
  if (
    disposition !== undefined &&
    !(DISPOSITIONS as readonly string[]).includes(disposition)
  ) {
    errors.push(
      `--disposition must be one of ${DISPOSITIONS.join(', ')} (got ${JSON.stringify(disposition)})`,
    );
  }
  const worktree = flags.worktree;
  if (worktree !== undefined && worktree !== '' && !worktree.startsWith('/')) {
    errors.push(`--worktree must be an absolute path (got ${worktree})`);
  }
  const contextTokens = flags.contextTokens;
  if (contextTokens !== undefined && !Number.isFinite(contextTokens)) {
    errors.push('--context-tokens must be a number (omit it when unknown)');
  }
  if (errors.length > 0) return {errors, ok: false};

  return {
    input: {
      arc: flags.arc as string,
      branch: flags.branch as string,
      contextTokens: contextTokens ?? null,
      disposition: disposition as Disposition,
      from: flags.from as string,
      next: flags.next as string,
      openQuestions: flags.openQuestions ?? [],
      state: flags.state as string,
      worktree: worktree as string,
    },
    ok: true,
  };
}
