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

import {sdkRun} from '../sdk-invocation';
import {type BrOutcome, brFailureDetail, type BrRunner, runBr} from './br';

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
  /** Epic/bead id or short name for the arc of work. */
  arc: string;
  branch: string;
  /** From the latest usage notice. `null` = not measured, never 0. */
  contextTokens: number | null;
  /** ISO-8601. */
  createdAt: string;
  disposition: Disposition;
  /** The session label the runner gave this session. Identity, per D5. */
  from: string;
  /** The successor's full starting instructions. This text IS its prompt. */
  next: string;
  /** Always present. `[]` means "asked and there are none", never "unknown". */
  openQuestions: string[];
  schemaVersion: number;
  /** 2–4 sentences: where things stand. */
  state: string;
  /** ABSOLUTE path — a relative one means nothing to the successor's process. */
  worktree: string;
}

export type HandoffParse =
  | {handoff: Handoff; ok: true}
  | {errors: string[]; ok: false};

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
  /** MEASURED: br omits the key entirely when a bead has no labels. */
  labels: string[];
  notes: string | null;
  status: string;
  title: string;
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
  for (const raw of parsed.issues as Record<string, unknown>[]) {
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
      arc: arc!,
      branch: branch!,
      contextTokens,
      createdAt: createdAt!,
      disposition: disposition!,
      from: from!,
      next: next!,
      openQuestions: openQuestions!,
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      state: state!,
      worktree: worktree!,
    },
    ok: true,
  };
}

/** Serialize for the `notes` field. Pretty-printed so `br show` is readable. */
export function handoffJson(handoff: Handoff): string {
  return JSON.stringify(
    {
      arc: handoff.arc,
      branch: handoff.branch,
      contextTokens: handoff.contextTokens,
      createdAt: handoff.createdAt,
      disposition: handoff.disposition,
      from: handoff.from,
      next: handoff.next,
      openQuestions: handoff.openQuestions,
      schemaVersion: handoff.schemaVersion,
      state: handoff.state,
      worktree: handoff.worktree,
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
  arc: string;
  branch: string;
  contextTokens: number | null;
  disposition: Disposition;
  from: string;
  next: string;
  openQuestions: string[];
  state: string;
  worktree: string;
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
  detail: string;
  id: string;
  kind: 'same-from' | 'unreadable';
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
  | {id: string; json: string; kind: 'created'; warnings: HandoffConflict[]}
  | {conflicts: HandoffConflict[]; kind: 'refused'; warnings: HandoffConflict[]}
  /** The bead exists but its notes were never written — the two-step gap. */
  | {
      id: string;
      json: string;
      kind: 'incomplete';
      reason: string;
      warnings: HandoffConflict[];
    }
  | {kind: 'unavailable'; reason: string};

/**
 * A failed `br` call, rendered for whoever has to fix it.
 *
 * The one-line `reason` first, then the rest of br's stderr up to the bound
 * (home-base-685h F4). Every refusal this file prints goes through here, so a
 * `handoff answer` that dies on a clap usage block or a Dolt error shows the
 * lines that say WHICH argument or WHICH constraint — the one-line shape showed
 * the heading and dropped the diagnosis.
 */
function brFailure(out: BrOutcome): string {
  return [
    out.reason ?? 'br failed for an unrecorded reason',
    ...brFailureDetail(out),
  ].join('\n');
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
  /**
   * A handoff bead that lost its `handoff` label is invisible to the runner's
   * scan, so it is invalid however good its JSON is — that failure is exactly
   * the silent-shaped kind (the loop reports "nothing waiting").
   */
  labelled: boolean;
  parse: HandoffParse;
  status: string;
  title: string;
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
  | {checks: HandoffCheck[]; kind: 'checked'}
  /** A named id that br does not have — distinct from "checked and invalid". */
  | {id: string; kind: 'missing'}
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
  exitCode: number;
  stderr: string[];
  stdout: string[];
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

// ---------------------------------------------------------------------------
// ANSWERING A BLOCKED HANDOFF (home-base-1r6d.33.7, epic decision D16)
//
// A `blocked` handoff bead stops the loop and stays OPEN on purpose (D14): it IS
// the question waiting for Justin. Nothing then restarted the arc, because
// `planStartBoot` only ever boots from a `continue` bead (D10).
//
// D16 closes that gap with a helper rather than a second gate in the runner:
// `handoff answer <id>` folds Justin's answers into `next` and flips the
// disposition to `continue`, so the bead the runner already knows how to pick up
// becomes eligible. Hand-editing the notes JSON stays a valid (undocumented)
// path for exactly the same reason — no "was it answered?" flag exists to lie.
//
// Everything here REFUSES loudly rather than patching a bead it does not fully
// understand: this is an in-place rewrite of the only control channel the loop
// has, and a half-understood rewrite is worse than no helper.
// ---------------------------------------------------------------------------

/**
 * `<slug>-<n>` → `<slug>`.
 *
 * The runner's `sessionLabel` builds every label as `${slug}-${n}`, so the slug
 * to re-run with is the label minus that suffix. Kept HERE rather than imported
 * from the runner because the runner imports this file; the other direction
 * would be a cycle.
 *
 * A label that does not end in `-<n>` is its own slug — and so is a label that
 * would strip to nothing (`-1`), because an empty `--label` is exactly the
 * value the runner refuses.
 */
export function slugFromLabel(from: string): string {
  const stripped = from.replace(/-\d+$/, '');
  return stripped === '' ? from : stripped;
}

/**
 * The command that restarts the arc from an answered bead.
 *
 * Built with `sdkRun` (F8, epic home-base-dchjw D1): this string is printed for
 * Justin to paste into a TERMINAL, and the bare `justin-sdk` form is form 1 —
 * legal only inside a package.json script value. The contract text a SESSION
 * reads is deliberately NOT changed: a loop session runs the bare form on PATH
 * via home-base/bin, and the e2e shims it there.
 */
export function rerunCommand(from: string): string {
  return sdkRun(`justin-loop --pickup --label ${slugFromLabel(from)}`);
}

/**
 * Why the rerun command carries no `--model`.
 *
 * VERIFIED 2026-09-19: `LedgerRow` (src/justin-loop/runner.ts) has no `model`
 * field — not a null one, none at all — so the ledger cannot tell what the
 * chain was run with. Printing `--model opus` would be inventing the fact, and
 * a rerun that silently switched model is exactly the kind of substitution
 * critical rule 7 is about. So the flag is omitted and the omission is said out
 * loud.
 */
export const RERUN_MODEL_NOTE =
  'the ledger does not record the --model a run was started with, so this command carries none and the runner default applies — add --model yourself if this chain was run with another one';

/**
 * The command Justin runs to answer a blocked handoff. One line, per D13, and
 * `bun run justin-sdk …` per F8 — he pastes it into a terminal.
 */
export function answerCommand(id: string): string {
  return sdkRun(`justin-loop handoff answer ${id} --answer '<your answer>'`);
}

/**
 * Statuses a bead may carry and still be answerable.
 *
 * VERIFIED 2026-09-19 against home-base's own `.beads/issues.jsonl`: br emits
 * exactly four — `open`, `in_progress`, `closed` and `tombstone`. The first two
 * are a live question waiting for an answer; `closed` is refused as claimed or
 * finished, and `tombstone` falls through to the unexpected-status refusal,
 * which is the right end for it — rewriting a deleted bead in place is not
 * something this helper should decide to do on its own.
 */
const ANSWERABLE_STATUSES = ['open', 'in_progress'] as const;

/**
 * Why a bead could not be answered. Every case is named, because "it did not
 * work" is not something Justin can act on at 1am with a stalled chain.
 */
export type AnswerRefusal =
  | {answers: number; id: string; kind: 'answer-count'; questions: number}
  | {disposition: Disposition; id: string; kind: 'not-blocked'}
  | {errors: string[]; id: string; kind: 'unparseable'}
  | {id: string; kind: 'closed'}
  | {id: string; kind: 'missing'}
  | {id: string; kind: 'not-labelled'}
  | {id: string; kind: 'unexpected-status'; status: string};

export type AnswerHandoffOutcome =
  | {
      handoff: Handoff;
      id: string;
      json: string;
      kind: 'answered';
      rerun: string;
    }
  /** The rewrite was refused; the bead is untouched. */
  | {kind: 'refused'; refusal: AnswerRefusal}
  /** br failed on the write, so the bead may be half-rewritten. */
  | {id: string; json: string; kind: 'incomplete'; reason: string}
  | {kind: 'unavailable'; reason: string};

/** `YYYY-MM-DD`, UTC — the date stamped onto the answers block. */
function isoDate(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/**
 * The block appended to `next`, which IS the successor's prompt — so it is
 * written to be read by a session that has never seen this conversation.
 *
 * Three shapes, because the counts genuinely differ in meaning:
 *   - one answer per question: paired, in order;
 *   - one answer, several questions: every question quoted, then the single
 *     answer, said out loud to be one answer for all of them (guessing which
 *     sentence answered which question would be fabricating the pairing);
 *   - no questions at all (a blocked bead that listed none — reachable, and the
 *     runner prints "listed no open questions" for it): the answer alone, with
 *     the absence stated rather than rendered as an empty list.
 */
export function answersBlock(
  questions: string[],
  answers: string[],
  when: Date,
): string {
  const head = `ANSWERS FROM JUSTIN (${isoDate(when)}):`;
  if (questions.length === 0) {
    return [
      head,
      '(this handoff recorded no open questions)',
      '',
      ...answers.map((a) => `A: ${a}`),
    ].join('\n');
  }
  if (answers.length === 1) {
    const only = answers[0]!;
    const preface =
      questions.length === 1
        ? ''
        : '(one answer for all of the questions below)\n';
    return `${head}\n${preface}\n${questions
      .map((q) => `Q: ${q}`)
      .join('\n')}\nA: ${only}`;
  }
  const pairs = questions.map((q, i) => `Q: ${q}\nA: ${answers[i]!}`);
  return `${head}\n\n${pairs.join('\n\n')}`;
}

/**
 * Turn a blocked handoff bead into a `continue` one carrying Justin's answers.
 *
 * `now` is injected so the fixture tests can pin the date the block is stamped
 * with. The rewrite is ONE `br update`: title, description and notes move
 * together or not at all, so a failed write cannot leave a bead whose title
 * says `continue` while its notes still say `blocked`.
 */
export function answerHandoff(
  cwd: string,
  id: string,
  answers: string[],
  run: BrRunner = runBr,
  now: () => Date = () => new Date(),
): AnswerHandoffOutcome {
  // `-a` so a CLOSED bead is still FOUND: "already claimed" and "no such bead"
  // are different answers and must not collapse into one (critical rule 7).
  const args = ['list', '--id', id, '-a', '--json'];
  const listed = run(cwd, args);
  if (!listed.ok) return {kind: 'unavailable', reason: brFailure(listed)};
  const rows = parseHandoffRows(listed.stdout);
  if (rows == null) {
    return {
      kind: 'unavailable',
      reason: `could not parse \`br ${args.join(' ')}\``,
    };
  }
  const row = rows.find((r) => r.id === id);
  if (row == null) return {kind: 'refused', refusal: {id, kind: 'missing'}};

  if (row.status === 'closed') {
    return {kind: 'refused', refusal: {id, kind: 'closed'}};
  }
  if (!(ANSWERABLE_STATUSES as readonly string[]).includes(row.status)) {
    // A status this code has never seen is not evidence that answering is safe.
    return {
      kind: 'refused',
      refusal: {id, kind: 'unexpected-status', status: row.status},
    };
  }
  if (!row.labels.includes(HANDOFF_LABEL)) {
    return {kind: 'refused', refusal: {id, kind: 'not-labelled'}};
  }
  const parsed = parseHandoff(row.notes);
  if (!parsed.ok) {
    return {
      kind: 'refused',
      refusal: {errors: parsed.errors, id, kind: 'unparseable'},
    };
  }
  const before = parsed.handoff;
  if (before.disposition !== 'blocked') {
    return {
      kind: 'refused',
      refusal: {disposition: before.disposition, id, kind: 'not-blocked'},
    };
  }
  // One answer may stand for every question; several must line up one to one,
  // because the order is the only thing saying which answer belongs to which
  // question.
  if (answers.length > 1 && answers.length !== before.openQuestions.length) {
    return {
      kind: 'refused',
      refusal: {
        answers: answers.length,
        id,
        kind: 'answer-count',
        questions: before.openQuestions.length,
      },
    };
  }

  const after: Handoff = {
    ...before,
    disposition: 'continue',
    next: `${before.next}\n\n${answersBlock(before.openQuestions, answers, now())}`,
    // The questions are answered; they are IN `next` now. Leaving them here
    // would make the bead read as still-blocked to anything that looks.
    openQuestions: [],
  };
  const json = handoffJson(after);
  const updated = run(cwd, [
    'update',
    id,
    `--title=${handoffTitle(after)}`,
    `--description=${handoffDescription(after)}`,
    `--notes=${json}`,
  ]);
  if (!updated.ok) {
    return {id, json, kind: 'incomplete', reason: brFailure(updated)};
  }
  return {
    handoff: after,
    id,
    json,
    kind: 'answered',
    rerun: rerunCommand(before.from),
  };
}

export function renderAnswer(outcome: AnswerHandoffOutcome): CommandReport {
  switch (outcome.kind) {
    case 'answered':
      return {
        exitCode: 0,
        stderr: [
          `✓ handoff bead ${outcome.id} answered — disposition is now continue and the answers are in \`next\``,
          `  ${RERUN_MODEL_NOTE}`,
        ],
        // The id first, then the command that restarts the arc: both are meant
        // to be copied, and nothing else is on stdout.
        stdout: [outcome.id, outcome.rerun],
      };
    case 'incomplete':
      return {
        exitCode: 2,
        stderr: [
          `INCOMPLETE: bead ${outcome.id} could NOT be rewritten: ${outcome.reason}`,
          'It is still a BLOCKED handoff and the loop will not pick it up. Apply this by hand, or re-run this command:',
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
          'Nothing was read and nothing was rewritten.',
        ],
        stdout: [],
      };
    case 'refused':
      return {
        exitCode: 1,
        stderr: [...refusalLines(outcome.refusal), 'The bead was NOT changed.'],
        stdout: [],
      };
  }
}

/** Every refusal says what was found AND what to do about it. */
function refusalLines(refusal: AnswerRefusal): string[] {
  switch (refusal.kind) {
    case 'missing':
      return [`REFUSED: no bead ${refusal.id} — nothing to answer.`];
    case 'closed':
      return [
        `REFUSED: bead ${refusal.id} is CLOSED — a claimed or finished handoff is not a question waiting for an answer.`,
      ];
    case 'unexpected-status':
      return [
        `REFUSED: bead ${refusal.id} has status \`${refusal.status}\`, which this helper does not know how to treat (it answers ${ANSWERABLE_STATUSES.join(' or ')} beads).`,
      ];
    case 'not-labelled':
      return [
        `REFUSED: bead ${refusal.id} is not labelled \`${HANDOFF_LABEL}\`, so it is not a handoff bead and the runner would never see it.`,
      ];
    case 'unparseable':
      return [
        `REFUSED: bead ${refusal.id} does not carry readable handoff JSON, so there is nothing to rewrite safely:`,
        ...refusal.errors.map((e) => `    ${e}`),
      ];
    case 'not-blocked':
      return [
        `REFUSED: bead ${refusal.id} has disposition \`${refusal.disposition}\`, not \`blocked\` — only a blocked handoff is a question waiting for you.`,
      ];
    case 'answer-count':
      return [
        `REFUSED: ${refusal.answers} answers for ${refusal.questions} open question(s) on bead ${refusal.id}.`,
        '  Pass ONE --answer to answer them all at once, or exactly one per question, in order.',
      ];
  }
}

export interface AnswerSources {
  /** Repeatable `--answer`. */
  answer: string[] | undefined;
  /** `--answer-file <path>`. */
  answerFile: string | undefined;
  /** Reading stdin would hang with nobody to type into it. */
  stdinIsTty: boolean;
}

export type AnswerResolve =
  | {answers: string[]; ok: true}
  | {errors: string[]; ok: false};

/**
 * Where the answer text comes from: `--answer` (repeatable), `--answer-file`,
 * or stdin.
 *
 * The file and stdin paths exist because the e2e showed the CLI-quoted form
 * fails for the answers that actually matter: a multi-paragraph answer with
 * quotes in it is miserable to type as a shell argument and easy to mangle.
 * Both readers are injected so this is testable without touching the real fs.
 */
export function resolveAnswers(
  sources: AnswerSources,
  readFile: (path: string) => string,
  readStdin: () => string,
): AnswerResolve {
  const flagged = (sources.answer ?? []).filter((a) => a.trim() !== '');
  if (sources.answerFile !== undefined && flagged.length > 0) {
    return {
      errors: [
        'pass --answer OR --answer-file, not both — two sources of the answer is one too many to guess between',
      ],
      ok: false,
    };
  }
  if (flagged.length > 0) return {answers: flagged, ok: true};

  if (sources.answerFile !== undefined) {
    let text: string;
    try {
      text = readFile(sources.answerFile);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        errors: [
          `could not read --answer-file ${sources.answerFile}: ${detail}`,
        ],
        ok: false,
      };
    }
    if (text.trim() === '') {
      return {
        errors: [`--answer-file ${sources.answerFile} is empty`],
        ok: false,
      };
    }
    return {answers: [text.trimEnd()], ok: true};
  }

  if (sources.stdinIsTty) {
    return {
      errors: [
        'no answer given: pass --answer=<text>, --answer-file=<path>, or pipe the answer in on stdin',
      ],
      ok: false,
    };
  }
  const piped = readStdin();
  if (piped.trim() === '') {
    return {errors: ['the answer read from stdin was empty'], ok: false};
  }
  return {answers: [piped.trimEnd()], ok: true};
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
  contextTokens?: number;
  openQuestions?: string[];
};

export type CreateFlagsParse =
  | {input: HandoffInput; ok: true}
  | {errors: string[]; ok: false};

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
      arc: flags.arc!,
      branch: flags.branch!,
      contextTokens: contextTokens ?? null,
      disposition: disposition as Disposition,
      from: flags.from!,
      next: flags.next!,
      openQuestions: flags.openQuestions ?? [],
      state: flags.state!,
      worktree: worktree!,
    },
    ok: true,
  };
}
