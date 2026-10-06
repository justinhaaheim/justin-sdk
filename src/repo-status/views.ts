/**
 * TEXT RENDERING of repo-status's opt-in views: the per-checkout facts
 * (`status --checkouts`), a repo's sessions (`status --sessions`) and the
 * cross-repo session listing (`repo-status repos`). home-base-39co9.5; first
 * built as `justin-sdk forensics`, home-base-lj3x9.
 *
 * Pure functions over typed objects, styled through cli-style.ts. They follow
 * the home-base terminal-output rules as Justin restated them on 2026-10-05,
 * after reading the forensics digest these replace:
 *
 *  - ONE UNIFORM INDENT STEP (`INDENT_STEP`): header at HEADER_COLUMN, each
 *    record at `stepColumn(0)`, its fields at `stepColumn(1)`, anything listed
 *    under a sub-heading at `stepColumn(2)`. The digest used 6 then 9.
 *  - PARALLEL FIELDS STACKED VERTICALLY, one per line with a bold label, every
 *    value in one column shared by all sibling records (`fieldLines`). The
 *    digest joined them with ` · ` into one line that wrapped mid-field.
 *  - A BLANK LINE between sibling records, between groups of fields, and
 *    before every sub-heading. "The INDENTATION is the thing that signals that
 *    the text is part of one parent object, NOT THE ABSENCE OF A NEWLINE."
 *  - Colour and wrapping only on a TTY (`OutputStyle`); piped output is plain.
 *
 * MERGE STATE COMES FROM THE LEDGER ROW. A checkout's "merge state" is its
 * branch row's content-proven `disposition` and `why`; this module never counts
 * commits by identity and never presents such a count as merge state (39co9.5
 * R1, AC1).
 *
 * Messages are PREVIEWS here: whitespace collapsed to one line and cut at
 * `chars`. `--json` carries them verbatim and uncapped.
 */

import type {CheckoutFacts, CheckoutsReport, RepoGlance} from './checkouts';
import type {BranchRow, RepoStatusReport} from './report';
import type {
  OutsideRoot,
  RepoSummary,
  SessionFacts,
  ThreadIndex,
} from './sessions';

import {homedir} from 'os';
import {relative} from 'path';

import {
  type Field,
  fieldLabelWidth,
  fieldLines,
  type OutputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';
import {whyLine} from './pretty';

/** Each record's title. */
const RECORD = stepColumn(0);
/** A record's fields and sub-headings. */
const FIELD = stepColumn(1);
/** What a sub-heading lists. */
const NESTED = stepColumn(2);

/** "3h ago" from an ISO timestamp; the timestamp itself when unparseable. */
export function ageFrom(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Local `YYYY-MM-DD HH:MM`, or the input when unparseable. */
export function localStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${formatLocalDate(at)} ${formatLocalTime(at).slice(0, 5)}`;
}

/** One line of `text`, cut at `chars` with a count of what was cut. */
export function preview(text: string, chars: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (chars <= 0 || flat.length <= chars) return flat;
  return `${flat.slice(0, chars).trimEnd()}… (+${flat.length - chars} chars)`;
}

/** `/Users/x/Dev` → `~/Dev`, for display only. */
export function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A record's title line: bold, at the record column. */
function recordTitle(text: string, style: OutputStyle): string {
  return wrapHanging(paint(text, ['bold'], style.color), {
    hang: FIELD,
    indent: RECORD,
    width: style.width,
  });
}

/** A sub-heading inside a record: bold, at the field column. */
function subHeading(text: string, style: OutputStyle): string {
  return wrapHanging(paint(text, ['bold'], style.color), {
    hang: FIELD,
    indent: FIELD,
    width: style.width,
  });
}

/** One item under a sub-heading. */
function nested(text: string, style: OutputStyle): string {
  return wrapHanging(text, {hang: NESTED, indent: NESTED, width: style.width});
}

/** A line of prose that belongs to a section rather than to one record. */
function sectionNote(text: string, style: OutputStyle): string {
  return wrapHanging(text, {hang: RECORD, indent: RECORD, width: style.width});
}

/**
 * Field groups, a blank line between each, every value in the column
 * `labelWidth` puts it in. Empty groups are dropped.
 */
function fieldGroups(
  groups: readonly Field[][],
  labelWidth: number,
  style: OutputStyle,
): string {
  return spacedList(
    groups
      .filter((group) => group.length > 0)
      .map((group) =>
        fieldLines(group, {
          color: style.color,
          indent: FIELD,
          labelWidth,
          width: style.width,
        }),
      ),
  );
}

function failuresSection(
  failures: readonly string[],
  style: OutputStyle,
): string {
  if (failures.length === 0) return '';
  return [
    sectionHeader('Could not check', {color: style.color, emoji: '⚠️'}),
    '',
    spacedList(
      failures.map((failure) =>
        sectionNote(paint(failure, ['yellow'], style.color), style),
      ),
    ),
  ].join('\n');
}

function threadsFailure(threads: ThreadIndex): string[] {
  return threads.ok
    ? []
    : [
        `threads: ${threads.error} — every thread fact below is UNKNOWN, not zero and not "none"`,
      ];
}

/** An upstream, as the fields that describe it. */
function upstreamFields(
  upstream: CheckoutFacts['upstream'],
  onlyHere: boolean,
  style: OutputStyle,
): Field[] {
  if (upstream == null) {
    return [
      {
        label: 'upstream',
        value: paint('UNKNOWN (could not be read)', ['yellow'], style.color),
      },
    ];
  }
  if (upstream === 'none') {
    return [
      {
        label: 'upstream',
        value: onlyHere
          ? paint(
              'none — its unmerged commits exist on this machine only',
              ['yellow'],
              style.color,
            )
          : 'none',
      },
    ];
  }
  const unpushed = plural(upstream.ahead, 'commit');
  return [
    {
      label: 'upstream',
      value:
        upstream.kind === 'same-name'
          ? `${upstream.ref} (same name, not tracked)`
          : upstream.ref,
    },
    {
      label: 'unpushed',
      value:
        upstream.ahead > 0
          ? paint(unpushed, ['yellow'], style.color)
          : unpushed,
    },
    {label: 'not pulled', value: plural(upstream.behind, 'commit')},
  ];
}

/** The uncommitted field: a count, then one path per line under it. */
function uncommittedField(
  state: CheckoutFacts['state'],
  style: OutputStyle,
): Field {
  if (state == null) {
    return {label: 'uncommitted', value: 'not checked (directory missing)'};
  }
  if (state.dirty == null) {
    return {
      label: 'uncommitted',
      value: paint(
        `UNKNOWN — ${state.unreadableReason ?? 'git status failed'}`,
        ['yellow'],
        style.color,
      ),
    };
  }
  if (!state.dirty) return {label: 'uncommitted', value: 'none'};
  const total = state.changedPaths ?? 0;
  const shown = state.samplePaths ?? [];
  const more = total - shown.length;
  return {
    label: 'uncommitted',
    value: [
      paint(
        `${plural(total, 'path')} — on no branch and in no commit`,
        ['yellow'],
        style.color,
      ),
      ...shown,
      ...(more > 0 ? [`+${more} more (git status in the checkout)`] : []),
    ].join('\n'),
  };
}

/** A row's PR, as one value: never blank, and "not checked" kept apart from "none". */
export function prText(row: BranchRow, report: RepoStatusReport): string {
  if (row.pr != null) {
    const draft = row.pr.isDraft ? ' (draft)' : '';
    return `#${row.pr.number} ${row.pr.state.toLowerCase()}${draft} into ${row.pr.baseRefName}`;
  }
  return report.enrichments.prs ? 'none' : 'not checked';
}

const DISPOSITION_LABEL: Record<BranchRow['disposition'], string> = {
  merged: 'merged — every commit is on the baseline by content',
  mirrored: 'not merged, but kept on an archive/ backup branch',
  'needs-judgment': 'NOT merged — unmerged work',
  review: 'needs a look — the evidence is incomplete or conflicting',
};

/**
 * The merge-state fields for one checkout, read from its ledger row: the
 * row's content-proven disposition and its one-line why. Never an identity
 * count (39co9.5 R1).
 */
function mergeFields(
  checkout: CheckoutFacts,
  report: RepoStatusReport,
  style: OutputStyle,
): Field[] {
  if (checkout.branch == null) {
    return [
      {
        label: 'merge state',
        value: `detached HEAD at ${(checkout.head ?? '?').slice(0, 12)} — no branch, so no ledger row`,
      },
    ];
  }
  if (checkout.branch === report.repo.baselineRef) {
    return [{label: 'merge state', value: 'this is the baseline'}];
  }
  if (report.branches == null) {
    return [
      {
        label: 'merge state',
        value: paint(
          'UNKNOWN — the branch listing failed (see the ledger above)',
          ['yellow'],
          style.color,
        ),
      },
    ];
  }
  const row = report.branches.find((r) => r.name === checkout.branch);
  if (row == null) {
    return [
      {
        label: 'merge state',
        value: paint(
          'UNKNOWN — this branch has no row in the ledger above',
          ['yellow'],
          style.color,
        ),
      },
    ];
  }
  const label = DISPOSITION_LABEL[row.disposition];
  const fields: Field[] = [
    {
      label: 'merge state',
      value:
        row.disposition === 'merged'
          ? paint(label, ['green'], style.color)
          : paint(label, ['yellow'], style.color),
    },
    {label: 'evidence', value: whyLine(row.why, report.enrichments.prs)},
  ];
  fields.push({label: 'pull request', value: prText(row, report)});
  return fields;
}

function checkoutFields(
  checkout: CheckoutFacts,
  report: RepoStatusReport,
  style: OutputStyle,
): Field[][] {
  const rel = relative(report.repo.root, checkout.path);
  const where = checkout.isPrimary
    ? 'primary'
    : rel.startsWith('..')
      ? checkout.path
      : rel;
  const flags = [
    checkout.locked ? 'locked' : null,
    checkout.exists ? null : 'directory missing',
    checkout.prunable ? 'git marks it prunable' : null,
  ].filter((flag): flag is string => flag != null);
  const identity: Field[] = [{label: 'checkout', value: where}];
  if (flags.length > 0) {
    identity.push({
      label: 'condition',
      value: paint(flags.join(', '), ['yellow'], style.color),
    });
  }

  const row =
    checkout.branch == null
      ? null
      : (report.branches?.find((r) => r.name === checkout.branch) ?? null);
  const onlyHere = row != null && row.disposition !== 'merged';
  const remote: Field[] = upstreamFields(checkout.upstream, onlyHere, style);
  remote.push({
    label: 'last commit',
    value:
      checkout.lastCommitAt == null
        ? paint('UNKNOWN', ['yellow'], style.color)
        : localStamp(checkout.lastCommitAt),
  });

  return [
    identity,
    mergeFields(checkout, report, style),
    remote,
    [uncommittedField(checkout.state, style)],
  ];
}

function checkoutBlock(
  checkout: CheckoutFacts,
  report: RepoStatusReport,
  labelWidth: number,
  style: OutputStyle,
): string {
  const title =
    checkout.branch ?? `detached at ${(checkout.head ?? '?').slice(0, 12)}`;
  const parts = [
    recordTitle(title, style),
    fieldGroups(checkoutFields(checkout, report, style), labelWidth, style),
  ];
  const beads = checkout.branchOnlyBeads;
  if (beads?.kind === 'measured' && beads.beads.length > 0) {
    parts.push(
      spacedList([
        subHeading(
          `Open beads only on this branch (${beads.beads.length})`,
          style,
        ),
        ...beads.beads.map((bead) =>
          nested(
            `${paint(bead.id, ['cyan'], style.color)}  ${bead.title ?? '(no title)'}`,
            style,
          ),
        ),
      ]),
    );
  }
  if (checkout.failures.length > 0) {
    parts.push(
      spacedList([
        subHeading('Could not check', style),
        ...checkout.failures.map((failure) =>
          nested(paint(failure, ['yellow'], style.color), style),
        ),
      ]),
    );
  }
  return spacedList(parts);
}

/**
 * The CHECKOUTS section of `status --checkouts`: one record per checkout,
 * primary first. Empty when the report carries no checkouts (not requested).
 */
export function renderCheckouts(
  report: RepoStatusReport,
  style: OutputStyle,
): string {
  const section: CheckoutsReport | undefined = report.checkouts;
  if (section == null) return '';
  const header = sectionHeader(
    section.checkouts == null
      ? 'Checkouts'
      : `Checkouts (${section.checkouts.length})`,
    {color: style.color, emoji: '🌿'},
  );
  if (section.checkouts == null) {
    return spacedList([
      header,
      sectionNote(
        paint(
          'The checkouts could not be listed — this is NOT "no checkouts".',
          ['yellow'],
          style.color,
        ),
        style,
      ),
      failuresSection(section.failures, style),
    ]);
  }
  const all = section.checkouts.map((checkout) =>
    checkoutFields(checkout, report, style).flat(),
  );
  const labelWidth = fieldLabelWidth(all.flat());
  return spacedList([
    header,
    sectionNote(
      paint(
        "Merge state is the ledger's verdict above, proven by content (patch-id, then file by file).",
        ['dim'],
        style.color,
      ),
      style,
    ),
    ...section.checkouts.map((checkout) =>
      checkoutBlock(checkout, report, labelWidth, style),
    ),
    failuresSection(section.failures, style),
  ]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** What `status --sessions` adds to the report. */
export interface SessionsSection {
  chars: number;
  days: number;
  failures: string[];
  sessions: SessionFacts[];
  threads: ThreadIndex;
  windowStart: string;
}

const SOURCE_LABEL: Record<string, string> = {
  backfill: 'backfill only (the session never reported)',
  report: 'thread report',
  start: 'thread start (no report followed)',
};

function sessionFields(
  session: SessionFacts,
  threads: ThreadIndex,
  now: Date,
  style: OutputStyle,
): Field[][] {
  const when: Field[] = [
    {label: 'session', value: paint(session.sessionId, ['cyan'], style.color)},
    {
      label: 'last active',
      value: `${ageFrom(session.lastTimestamp, now)} (${localStamp(session.lastTimestamp)})`,
    },
  ];
  if (session.firstTimestamp != null) {
    when.push({label: 'started', value: localStamp(session.firstTimestamp)});
  }
  if (session.branch != null) {
    when.push({label: 'branch', value: session.branch});
  }

  const thread: Field[] = [];
  if (!threads.ok) {
    thread.push({
      label: 'thread',
      value: paint(
        'UNKNOWN (thread beads unreadable)',
        ['yellow'],
        style.color,
      ),
    });
  } else if (session.thread == null) {
    thread.push({
      label: 'thread',
      value: paint('none', ['yellow'], style.color),
    });
  } else {
    const t = session.thread;
    thread.push({
      label: 'thread',
      value: `${t.id}${t.status === 'closed' ? ' (closed)' : ''}`,
    });
    thread.push({
      label: 'recorded by',
      value:
        t.source == null ? 'unknown' : (SOURCE_LABEL[t.source] ?? t.source),
    });
    if (t.mergeState != null) {
      thread.push({label: 'merge badge', value: t.mergeState});
    }
    if (t.openAsks > 0) {
      thread.push({label: 'open asks', value: String(t.openAsks)});
    }
  }

  const resume: Field[] =
    session.resumeCommand == null
      ? []
      : [
          {
            label: 'resume',
            value: paint(session.resumeCommand, ['cyan'], style.color),
          },
        ];
  return [when, thread, resume];
}

function sessionBlock(
  session: SessionFacts,
  section: SessionsSection,
  labelWidth: number,
  now: Date,
  style: OutputStyle,
): string {
  // A reported thread's title was written to be recognisable; a backfilled
  // one is only the first line of the first message, so the preview beats it.
  const reportedTitle =
    session.thread?.source === 'report' ? session.thread.title : null;
  const heading =
    reportedTitle ??
    (session.firstUserMessage == null
      ? '(no user message)'
      : preview(session.firstUserMessage, 90));

  const message = (label: string, text: string | null): string =>
    spacedList([
      subHeading(label, style),
      nested(
        text == null
          ? paint('(none)', ['dim'], style.color)
          : preview(text, section.chars),
        style,
      ),
    ]);

  return spacedList([
    recordTitle(heading, style),
    fieldGroups(
      sessionFields(session, section.threads, now, style),
      labelWidth,
      style,
    ),
    message('Your first message', session.firstUserMessage),
    message('Your last message', session.lastUserMessage),
    message("Claude's last response", session.lastAssistantMessage),
    session.failures.length === 0
      ? ''
      : spacedList([
          subHeading('Could not check', style),
          ...session.failures.map((failure) =>
            nested(paint(failure, ['dim'], style.color), style),
          ),
        ]),
  ]);
}

/** The SESSIONS section of `status --sessions`. */
export function renderSessions(
  section: SessionsSection,
  now: Date,
  style: OutputStyle,
): string {
  const header = sectionHeader(
    `Sessions in the last ${section.days} days (${section.sessions.length})`,
    {color: style.color, emoji: '💬'},
  );
  const labelWidth = fieldLabelWidth(
    section.sessions.flatMap((session) =>
      sessionFields(session, section.threads, now, style).flat(),
    ),
  );
  return spacedList([
    header,
    section.sessions.length === 0
      ? sectionNote('No session in the window.', style)
      : spacedList(
          section.sessions.map((session) =>
            sessionBlock(session, section, labelWidth, now, style),
          ),
        ),
    sectionNote(
      `Full message log of one session: ${paint('bun run justin-sdk thread show --session <id> --messages', ['cyan'], style.color)}`,
      style,
    ),
    failuresSection(
      [...threadsFailure(section.threads), ...section.failures],
      style,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// repo-status repos
// ---------------------------------------------------------------------------

export interface ReposView {
  days: number;
  failures: string[];
  /** Each listed repo's primary checkout, keyed by repo root. */
  glances: ReadonlyMap<string, RepoGlance>;
  now: Date;
  /** Sessions whose repo is outside `root`, hidden and counted. */
  outsideRoot: OutsideRoot;
  /** Only repos under this directory are listed; `/` lists everything. */
  root: string;
  summaries: RepoSummary[];
  threads: ThreadIndex;
  unplaced: number;
}

function coverageFields(summary: RepoSummary, style: OutputStyle): Field[] {
  const {coverage} = summary;
  if (coverage == null) {
    return [
      {
        label: 'thread coverage',
        value: paint(
          'UNKNOWN (thread beads unreadable)',
          ['yellow'],
          style.color,
        ),
      },
    ];
  }
  const never = coverage.backfilled + coverage.started;
  return [
    {label: 'reported', value: String(coverage.reported)},
    {
      label: 'never reported',
      value: never > 0 ? paint(String(never), ['yellow'], style.color) : '0',
    },
    {
      label: 'no thread',
      value:
        coverage.none > 0
          ? paint(String(coverage.none), ['yellow'], style.color)
          : '0',
    },
  ];
}

/** The primary checkout's own state (the retired cross-project scanner's per-repo facts). */
function glanceFields(
  glance: RepoGlance | undefined,
  style: OutputStyle,
): Field[] {
  if (glance == null) {
    return [
      {
        label: 'checkout',
        value: paint(
          'not read (the directory is gone or not a repo)',
          ['dim'],
          style.color,
        ),
      },
    ];
  }
  const fields: Field[] = [
    {label: 'branch', value: glance.branch ?? 'detached HEAD'},
    {
      label: 'checkouts',
      value:
        glance.checkouts == null
          ? paint('UNKNOWN', ['yellow'], style.color)
          : String(glance.checkouts),
    },
    uncommittedField(glance.state, style),
  ];
  if (glance.branch != null) {
    fields.push(...upstreamFields(glance.upstream, false, style));
  }
  fields.push({
    label: 'last commit',
    value:
      glance.lastCommitAt == null
        ? paint('UNKNOWN', ['yellow'], style.color)
        : localStamp(glance.lastCommitAt),
  });
  return fields;
}

function repoFields(
  summary: RepoSummary,
  view: ReposView,
  style: OutputStyle,
): Field[][] {
  return [
    [
      {label: 'sessions', value: String(summary.sessions)},
      {
        label: 'last active',
        value: `${ageFrom(summary.lastActivity, view.now)} (${localStamp(summary.lastActivity)})`,
      },
    ],
    coverageFields(summary, style),
    glanceFields(view.glances.get(summary.repoRoot), style),
  ];
}

function repoBlock(
  summary: RepoSummary,
  view: ReposView,
  labelWidth: number,
  style: OutputStyle,
): string {
  const title =
    summary.repoResolvedBy === 'path'
      ? `${tildePath(summary.repoRoot)} (from the path; directory gone or not a repo)`
      : tildePath(summary.repoRoot);
  const glance = view.glances.get(summary.repoRoot);
  const failures =
    glance == null || glance.failures.length === 0
      ? ''
      : spacedList([
          subHeading('Could not check', style),
          ...glance.failures.map((failure) =>
            nested(paint(failure, ['yellow'], style.color), style),
          ),
        ]);
  return spacedList([
    recordTitle(title, style),
    fieldGroups(repoFields(summary, view, style), labelWidth, style),
    failures,
  ]);
}

export function renderRepos(view: ReposView, style: OutputStyle): string {
  const header = sectionHeader(
    `Repos under ${tildePath(view.root)} with Claude Code sessions in the last ${view.days} days`,
    {color: style.color, emoji: '📂'},
  );
  const labelWidth = fieldLabelWidth(
    view.summaries.flatMap((summary) =>
      repoFields(summary, view, style).flat(),
    ),
  );
  const notes: string[] = [];
  if (view.unplaced > 0) {
    notes.push(
      `${view.unplaced} session(s) had no cwd in their transcript and are not placed in any repo.`,
    );
  }
  if (view.outsideRoot.sessions > 0) {
    notes.push(
      `${view.outsideRoot.sessions} session(s) in ${view.outsideRoot.directories} director${view.outsideRoot.directories === 1 ? 'y' : 'ies'} outside ${tildePath(view.root)} are not listed (usually test probes in temp directories). ${paint('--root /', ['cyan'], style.color)} lists them.`,
    );
  }
  return `${spacedList([
    header,
    view.summaries.length === 0
      ? sectionNote('No session in the window.', style)
      : spacedList(
          view.summaries.map((summary) =>
            repoBlock(summary, view, labelWidth, style),
          ),
        ),
    spacedList(notes.map((note) => sectionNote(note, style))),
    sectionNote(
      `Next: ${paint('bun run justin-sdk repo-status status --repo <path> --checkouts --sessions', ['cyan'], style.color)} for one repo's ledger, checkouts and sessions.`,
      style,
    ),
    failuresSection([...threadsFailure(view.threads), ...view.failures], style),
  ])}\n`;
}
