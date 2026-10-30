/**
 * `thread quota` (request home-base-ys9t7.5, D9; built by home-base-ys9t7.5.3):
 * every number the spend quota decides on, for one session, read-only.
 *
 * It resolves the session's bead (--session, else CLAUDE_CODE_SESSION_ID),
 * then shows: the quota knob (mode and each limit, with the config layer that
 * set it); the session's GROUP (D2: its handoff and spawn chain) with each
 * member's bead, title and session; the group's latest typed line; the
 * group's unattended spend per model family in dollars and percent of the
 * week; the project's last-24-hours spend (D3); the week percent with its
 * source and age (D4); the verdict for a running session and for a handoff;
 * and, for each spend limit, how long the group has been unattended and when
 * it would reach the limit at its average rate (quota-projection.ts).
 *
 * Beside each member it shows Claude Code's own cost figure for that session
 * (the statusline store's session-cost history) next to the quota's estimate
 * of the same session, and the gap (home-base-ys9t7.8.1). Shown only: the
 * quota decides on its estimate (D1).
 *
 * It WRITES NOTHING and enforces nothing, whatever the mode. A piece it
 * cannot measure is shown as unknown with the reason (critical rule 7), and
 * the report still prints: exit 0 means the report printed, 2 a bad call.
 */

import type {QuotaRateFamily} from './defaults';
import type {GroupSpend, GroupSpendReaders} from './quota-group';
import type {ResolvedQuotaConfig, Sourced} from './quota-knob';
import type {MemberCost, MemberCosts} from './quota-member-cost';
import type {ProjectSpend} from './quota-project';
import type {LimitProjection, UnattendedRate} from './quota-projection';
import type {SpendTotals} from './quota-spend';
import type {QuotaOver, QuotaVerdict} from './quota-verdict';
import type {WeekReading, WeekWindowReading} from './quota-week';

import {
  type Field,
  fieldLines,
  type OutputStyle,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {resolveThreadConfig} from './config';
import {QUOTA_RATE_FAMILIES} from './defaults';
import {transcriptsRoot} from './facts';
import {measureGroupSpend, realGroupSpendReaders} from './quota-group';
import {quotaLimitsOf} from './quota-knob';
import {readSessionLogLines, type SessionLogLines} from './quota-log';
import {gatherMemberCosts} from './quota-member-cost';
import {measureProjectSpend} from './quota-project';
import {projectTimeToLimit, unattendedRate} from './quota-projection';
import {quotaVerdict} from './quota-verdict';
import {readWeekReading} from './quota-week';
import {selectSession, sessionIdFrom} from './session-select';

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type QuotaSessionFind =
  | {beadId: string; checkoutPath: string; kind: 'found'; title: string}
  | {kind: 'unknown'; reason: string};

/** One spend limit's elapsed time and projection, or why there is none. */
export type LimitTiming =
  | {
      kind: 'known';
      limitPercent: number;
      projection: LimitProjection;
      spentPercent: number;
    }
  | {kind: 'unknown'; limitPercent: number; reason: string};

export interface QuotaReport {
  /** The checkout the knob and the project were read for. */
  checkout: string;
  config: ResolvedQuotaConfig;
  group: GroupSpend;
  /** The week reading's age limit (handoff.usage.maxSampleAgeMinutes). */
  maxWeekAgeMinutes: number;
  nowMs: number;
  /** Config read problems, as resolveThreadConfig names them. */
  problems: string[];
  project: ProjectSpend;
  session: QuotaSessionFind;
  sessionId: string;
  timing: {chain: LimitTiming; project: LimitTiming};
  /** Member bead id → title, from the same `br show` the group walk made. */
  titles: Record<string, string>;
  /** Since when the group is unattended, and its average rate since then. */
  unattended: {
    rate: UnattendedRate | null;
    sinceKind: 'firstRequest' | 'typed' | null;
    sinceMs: number | null;
  };
  verdicts: {handoff: QuotaVerdict; running: QuotaVerdict};
  week: WeekReading;
}

/** Wrap a reader's showBead so every title it reads is kept. */
function rememberTitles(
  readers: GroupSpendReaders,
  titles: Record<string, string>,
): GroupSpendReaders {
  return {
    ...readers,
    showBead: (beadId) => {
      const read = readers.showBead(beadId);
      if (read.kind === 'found' && read.title != null) {
        titles[beadId] = read.title;
      }
      return read;
    },
  };
}

function spentOf(spend: GroupSpend | ProjectSpend): number | null {
  return spend.kind === 'known' ? spend.spend.weekPercent : null;
}

/** The elapsed time and projection for one limit (pure). */
export function limitTiming(input: {
  limitPercent: number;
  nowMs: number;
  rate: UnattendedRate | null;
  rateProblem: string | null;
  spend: GroupSpend | ProjectSpend;
}): LimitTiming {
  const {limitPercent, nowMs, rate, rateProblem, spend} = input;
  const spentPercent = spentOf(spend);
  if (spentPercent == null) {
    return {
      kind: 'unknown',
      limitPercent,
      reason:
        spend.kind === 'unknown'
          ? `the spend is unknown: ${spend.reason}`
          : 'the spend is unknown',
    };
  }
  if (rateProblem != null) {
    return {kind: 'unknown', limitPercent, reason: rateProblem};
  }
  return {
    kind: 'known',
    limitPercent,
    projection: projectTimeToLimit({
      limitPercent,
      nowMs,
      percentPerHour: rate?.percentPerHour ?? null,
      spentPercent,
    }),
    spentPercent,
  };
}

/** Measure everything `thread quota` shows. Reads only. */
export async function gatherQuotaReport(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  sessionId: string;
}): Promise<QuotaReport> {
  const {cwd, env, nowMs, sessionId} = input;
  const selection = selectSession({
    env,
    selector: null,
    sessionIdOption: sessionId,
  });
  let session: QuotaSessionFind;
  let fallbackDbs: string[] = [];
  if (selection.kind === 'found') {
    session = {
      beadId: selection.session.bead.id,
      checkoutPath: selection.session.checkoutPath,
      kind: 'found',
      title: selection.session.bead.title,
    };
    fallbackDbs = [selection.session.db];
  } else if (selection.kind === 'checkoutMissing') {
    session = {
      kind: 'unknown',
      reason: `the session's checkout ${selection.checkoutPath} no longer exists`,
    };
  } else {
    session = {kind: 'unknown', reason: selection.reason};
  }
  const checkout = session.kind === 'found' ? session.checkoutPath : cwd;
  const config = resolveThreadConfig({cwd: checkout, env});
  const limits = quotaLimitsOf(config.quota);
  const rates = {dollarsPerWeekPercent: limits.dollarsPerWeekPercent};

  const titles: Record<string, string> = {};
  const group: GroupSpend =
    session.kind === 'found'
      ? await measureGroupSpend(
          session.beadId,
          rememberTitles(
            realGroupSpendReaders({cwd: checkout, env, fallbackDbs}),
            titles,
          ),
          rates,
        )
      : {
          kind: 'unknown',
          lowerBound: null,
          members: [],
          reason: `no session bead: ${session.reason}`,
          typed: {
            kind: 'unknown',
            reason: `no session bead: ${session.reason}`,
          },
        };
  if (session.kind === 'found') titles[session.beadId] = session.title;

  const project = await measureProjectSpend({
    checkoutPath: checkout,
    ...rates,
    nowMs,
    projectsRoot: transcriptsRoot(env),
  });
  const maxWeekAgeMinutes = config.handoff.usage.maxSampleAgeMinutes;
  const week = readWeekReading({env, maxAgeMinutes: maxWeekAgeMinutes, nowMs});
  const verdictOf = (purpose: 'handoff' | 'running'): QuotaVerdict =>
    quotaVerdict({group, limits, nowMs, project, purpose, week});

  // The group became unattended at its latest typed line; with none, at its
  // first unattended request (every request counts then).
  let sinceKind: 'firstRequest' | 'typed' | null = null;
  let sinceMs: number | null = null;
  if (group.kind === 'known') {
    if (group.latestTypedAtMs != null) {
      sinceKind = 'typed';
      sinceMs = group.latestTypedAtMs;
    } else if (group.firstUnattendedAtMs != null) {
      sinceKind = 'firstRequest';
      sinceMs = group.firstUnattendedAtMs;
    }
  }
  const rate =
    group.kind === 'known'
      ? unattendedRate({nowMs, sinceMs, spentPercent: group.spend.weekPercent})
      : null;
  const rateProblem =
    group.kind === 'unknown'
      ? `the group's rate is unknown: ${group.reason}`
      : null;

  return {
    checkout,
    config: config.quota,
    group,
    maxWeekAgeMinutes,
    nowMs,
    problems: config.problems,
    project,
    session,
    sessionId,
    timing: {
      chain: limitTiming({
        limitPercent: limits.chainWeekPercent,
        nowMs,
        rate,
        rateProblem,
        spend: group,
      }),
      project: limitTiming({
        limitPercent: limits.projectDayWeekPercent,
        nowMs,
        rate,
        rateProblem,
        spend: project,
      }),
    },
    titles,
    unattended: {rate, sinceKind, sinceMs},
    verdicts: {handoff: verdictOf('handoff'), running: verdictOf('running')},
    week,
  };
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** `2 d 3 h`, `3 h 5 min`, `12 min`, `under a minute`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}

function ago(atMs: number, nowMs: number): string {
  return atMs > nowMs
    ? `${formatDuration(atMs - nowMs)} in the future`
    : `${formatDuration(nowMs - atMs)} ago`;
}

function pct(value: number): string {
  return `${value.toFixed(2)} %`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function sourced<T>(field: Sourced<T>, unit: string): string {
  return `${String(field.value)}${unit} (${field.source})`;
}

function overText(over: QuotaOver): string {
  if (over.limit === 'floor') {
    const window =
      over.window === 'week' ? 'the week' : `the ${over.window} week`;
    return `floor: ${window} is at ${over.weekPercent} % (limit ${over.limitPercent} %)`;
  }
  const who = over.limit === 'chain' ? 'the group' : 'the project (24 h)';
  return `${over.limit}: ${who} spent ${over.atLeast ? 'at least ' : ''}${pct(over.spentPercent)} of the week (limit ${over.limitPercent} %)`;
}

/** One verdict as one line of text: fine, over (each limit) or unknown. */
export function verdictText(verdict: QuotaVerdict): string {
  if (verdict.kind === 'fine') {
    return verdict.attended
      ? 'fine (attended: the week floor was not checked)'
      : 'fine';
  }
  if (verdict.kind === 'unknown') {
    const who =
      verdict.attendance.kind === 'attended'
        ? 'attended'
        : verdict.attendance.kind === 'unattended'
          ? 'unattended'
          : 'attendance unknown';
    return `UNKNOWN (${who}): ${verdict.reasons.join('; ')}`;
  }
  const unknown =
    verdict.unknown.length > 0
      ? `; also unknown: ${verdict.unknown.join('; ')}`
      : '';
  return `OVER: ${verdict.over.map(overText).join('; ')}${unknown}`;
}

function weekText(reading: WeekWindowReading): string {
  const by =
    reading.measuredBy === 'statusline'
      ? `a statusline render of session ${reading.sessionId ?? '(unknown)'}`
      : 'a /usage sample';
  return `${reading.percent} %, from ${reading.path} (measured by ${by}), ${Math.round(reading.ageMinutes)} min old`;
}

/** Each family's dollars and percent, then the total, in aligned columns. */
function spendFields(totals: SpendTotals): Field[] {
  const rows: [string, number, number][] = [
    ...QUOTA_RATE_FAMILIES.map(
      (family: QuotaRateFamily): [string, number, number] => [
        family,
        totals.byFamily[family].usd,
        totals.byFamily[family].weekPercent,
      ],
    ),
    ['total', totals.usd, totals.weekPercent],
  ];
  const width = Math.max(...rows.map(([, dollars]) => usd(dollars).length));
  return rows.map(([label, dollars, percent]) => ({
    label,
    value: `${usd(dollars).padStart(width)}   ${pct(percent).padStart(8)} of the week`,
  }));
}

function projectionText(timing: LimitTiming): string {
  if (timing.kind === 'unknown') return `unknown: ${timing.reason}`;
  const {projection} = timing;
  if (projection.kind === 'at') {
    return `in ${formatDuration(projection.inMs)} (${iso(projection.atMs)}), at the group's average rate`;
  }
  return projection.reason === 'reached'
    ? `none: already at or over it (${pct(timing.spentPercent)})`
    : 'none: the group has spent nothing unattended, so there is no rate';
}

/** A logged value as text: strings as they are, the rest as JSON. */
function logValue(value: unknown): string {
  if (value == null) return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The quota log's newest `recheck` and `brake` lines for the session (D9,
 * item 7): what the brake last measured and last did. Every state is said:
 * no log yet, no line for this session, or a log that could not be read.
 */
function logBlocks(
  log: SessionLogLines,
  fields: (list: readonly Field[]) => string,
): string[] {
  if (log.kind === 'failed') {
    return [fields([{label: 'log', value: `UNREADABLE: ${log.reason}`}])];
  }
  if (log.kind === 'none') {
    return [
      fields([
        {
          label: 'log',
          value: `none yet at ${log.path}: the brake has not run in observe or enforce on this machine`,
        },
      ]),
    ];
  }
  const recheck = log.recheck;
  const brake = log.brake;
  return [
    fields([{label: 'log', value: log.path}]),
    fields(
      recheck == null
        ? [{label: 'last recheck', value: 'none for this session'}]
        : [
            {label: 'last recheck', value: logValue(recheck.at)},
            {label: 'verdict', value: logValue(recheck.verdict)},
            {label: 'attendance', value: logValue(recheck.attendance)},
            {label: 'mode', value: logValue(recheck.mode)},
          ],
    ),
    fields(
      brake == null
        ? [{label: 'last brake', value: 'none for this session'}]
        : [
            {label: 'last brake', value: logValue(brake.at)},
            {label: 'action', value: logValue(brake.action)},
            {label: 'tool', value: logValue(brake.toolName)},
            {label: 'subagent', value: logValue(brake.agentId)},
            {label: 'limit', value: logValue(brake.limit)},
          ],
    ),
  ];
}

/** Claude Code's figure and the quota's estimate for one member (item 4 of ys9t7.8.1). */
function memberCostFields(
  cost: MemberCost | undefined,
  costs: MemberCosts,
  nowMs: number,
): Field[] {
  if (cost == null) {
    return [{label: 'Claude Code', value: 'not read for this member'}];
  }
  const {claudeCode, estimate} = cost;
  const figure =
    claudeCode.kind === 'known'
      ? `${usd(claudeCode.line.totalCostUsd)} at ${iso(Date.parse(claudeCode.line.at))} (${ago(Date.parse(claudeCode.line.at), nowMs)})${claudeCode.line.decreased ? '; lower than its previous figure (a restarted counter)' : ''}`
      : claudeCode.kind === 'unreadable'
        ? `UNREADABLE: ${claudeCode.reason}`
        : costs.history.kind === 'missing'
          ? `none recorded: ${costs.history.path} does not exist yet`
          : 'none recorded for this session';
  let quota: string;
  if (estimate.kind === 'unknown') {
    quota = `unknown: ${estimate.reason}${estimate.lowerBoundUsd == null ? '' : `; at least ${usd(estimate.lowerBoundUsd)}`}`;
  } else if (cost.gapUsd == null || claudeCode.kind !== 'known') {
    quota = `${usd(estimate.usd)} (whole session, subagents included)`;
  } else {
    const base = claudeCode.line.totalCostUsd;
    const percent =
      base === 0
        ? ''
        : ` (${Math.abs((cost.gapUsd / base) * 100).toFixed(1)} % ${cost.gapUsd < 0 ? 'below' : 'above'})`;
    quota = `${usd(estimate.usd)} (whole session, subagents included); gap ${cost.gapUsd < 0 ? '-' : '+'}${usd(Math.abs(cost.gapUsd))}${percent}`;
  }
  return [
    {label: 'Claude Code', value: figure},
    {label: 'quota estimate', value: quota},
  ];
}

/** The report as terminal text: man-page indent, stacked fields, blank lines. */
export function renderQuotaReport(
  report: QuotaReport,
  style: OutputStyle,
  /** The session's latest quota-log lines; null: not read, no section. */
  log: SessionLogLines | null = null,
  /** Each member's Claude Code figure and estimate; null: not read, no fields. */
  costs: MemberCosts | null = null,
): string {
  const {color, width} = style;
  const body = stepColumn(0);
  const nested = stepColumn(1);
  const header = (title: string, emoji: string): string =>
    sectionHeader(title, {color, emoji});
  const fields = (list: readonly Field[], indent = body): string =>
    fieldLines(list, {color, indent, width});
  const line = (text: string, indent = body): string =>
    wrapHanging(text, {hang: indent, indent, width});
  const warn = (text: string): string => line(paint(text, ['yellow'], color));
  const {config, group, nowMs, project, week} = report;

  const sessionFields: Field[] = [
    {label: 'session', value: report.sessionId},
    ...(report.session.kind === 'found'
      ? [
          {label: 'session bead', value: report.session.beadId},
          {label: 'title', value: report.session.title},
        ]
      : [{label: 'session bead', value: `unknown: ${report.session.reason}`}]),
    {label: 'checkout', value: report.checkout},
    {label: 'now', value: iso(nowMs)},
  ];

  const knob: Field[] = [
    {label: 'mode', value: sourced(config.mode, '')},
    {
      label: 'chain limit',
      value: sourced(config.chainWeekPercent, ' % of the week'),
    },
    {
      label: 'project limit (24 h)',
      value: sourced(config.projectDayWeekPercent, ' % of the week'),
    },
    {label: 'week floor', value: sourced(config.floorWeekPercent, ' %')},
    {
      label: 'attended grace',
      value: sourced(config.attendedGraceMinutes, ' min'),
    },
    {label: 'recheck', value: sourced(config.recheckSeconds, ' s')},
    ...QUOTA_RATE_FAMILIES.map((family) => ({
      label: `$ per 1 % (${family})`,
      value: sourced(config.dollarsPerWeekPercent[family], ''),
    })),
  ];
  const knobBlock = [fields(knob)];
  if (report.problems.length > 0) {
    knobBlock.push('', ...report.problems.map((problem) => warn(problem)));
  }

  // The group: each member a record, title on its first line.
  const costFieldsOf = (sessionId: string): Field[] =>
    costs == null
      ? []
      : memberCostFields(
          costs.members.find((m) => m.sessionId === sessionId),
          costs,
          nowMs,
        );
  const groupBlocks: string[] = [];
  if (group.kind === 'known') {
    groupBlocks.push(line(`root: ${group.root}`));
    for (const member of group.members) {
      groupBlocks.push(
        [
          line(
            `${paint(member.beadId, ['bold'], color)}   ${report.titles[member.beadId] ?? '(title not read)'}`,
          ),
          fields(
            [
              {label: 'session', value: member.sessionId},
              {
                label: 'transcripts',
                value: `${member.files.length} (main and subagents)`,
              },
              {label: 'typed lines', value: String(member.typedLines)},
              ...costFieldsOf(member.sessionId),
            ],
            nested,
          ),
        ].join('\n'),
      );
    }
  } else {
    groupBlocks.push(warn(`UNKNOWN: ${group.reason}`));
    for (const member of group.members) {
      const memberLine = line(
        `${member.beadId}   ${report.titles[member.beadId] ?? '(title not read)'}   session ${member.sessionId}`,
      );
      const extra = costFieldsOf(member.sessionId);
      groupBlocks.push(
        extra.length === 0
          ? memberLine
          : [memberLine, fields(extra, nested)].join('\n'),
      );
    }
  }

  const typedBlock =
    group.kind === 'known'
      ? group.latestTypedAtMs != null
        ? fields([
            {
              label: 'at',
              value: `${iso(group.latestTypedAtMs)} (${ago(group.latestTypedAtMs, nowMs)})`,
            },
          ])
        : line('none in the group: every request counts as unattended')
      : warn(`unknown: ${group.reason}`);

  const spendBlock: string[] = [];
  if (group.kind === 'known') {
    spendBlock.push(fields(spendFields(group.spend)));
    spendBlock.push(
      fields([
        {label: 'requests', value: String(group.requests)},
        {
          label: 'first counted',
          value:
            group.firstUnattendedAtMs == null
              ? 'none'
              : `${iso(group.firstUnattendedAtMs)} (${ago(group.firstUnattendedAtMs, nowMs)})`,
        },
        ...(group.unparseableLines > 0
          ? [
              {
                label: 'torn lines',
                value: `${group.unparseableLines} (a live session's last line, read whole next time)`,
              },
            ]
          : []),
      ]),
    );
  } else {
    spendBlock.push(warn(`UNKNOWN: ${group.reason}`));
    if (group.lowerBound != null) {
      spendBlock.push(line('at least (the priced models alone):'));
      spendBlock.push(fields(spendFields(group.lowerBound), nested));
    }
  }

  const projectBlock: string[] = [];
  if (project.kind === 'known') {
    projectBlock.push(fields(spendFields(project.spend)));
    projectBlock.push(
      fields([
        {label: 'project', value: project.projectSlug},
        {
          label: 'counted after',
          value: `${iso(project.cutoffMs)} (${project.latestTypedAtMs != null && project.latestTypedAtMs >= project.windowStartMs ? 'Justin’s latest typed line in the project' : 'the start of the 24 hours'})`,
        },
        {
          label: 'read',
          value: `${project.files} transcript(s) in ${project.dirs.length} project dir(s)`,
        },
        {label: 'requests', value: String(project.requests)},
      ]),
    );
  } else {
    projectBlock.push(warn(`UNKNOWN: ${project.reason}`));
    if (project.lowerBound != null) {
      projectBlock.push(line('at least (the priced models alone):'));
      projectBlock.push(fields(spendFields(project.lowerBound), nested));
    }
  }

  const weekBlock: string[] = [];
  if (week.kind === 'known') {
    weekBlock.push(
      fields([
        {label: 'all models', value: weekText(week.allModels)},
        ...Object.entries(week.byModel).map(([model, reading]) => ({
          label: model,
          value: weekText(reading),
        })),
      ]),
    );
  } else {
    weekBlock.push(warn(`UNKNOWN: ${week.reason}`));
  }
  weekBlock.push(
    line(
      `older than ${report.maxWeekAgeMinutes} min is unknown (componentConfig.thread.handoff.usage.maxSampleAgeMinutes)`,
    ),
  );
  if (week.notes.length > 0) {
    weekBlock.push(
      [line('not used:'), ...week.notes.map((note) => line(note, nested))].join(
        '\n',
      ),
    );
  }

  const verdictBlock = fields([
    {label: 'running session', value: verdictText(report.verdicts.running)},
    {label: 'handoff', value: verdictText(report.verdicts.handoff)},
  ]);

  const {unattended} = report;
  const elapsed =
    unattended.sinceMs == null
      ? group.kind === 'known'
        ? 'not unattended: no request after the latest typed line'
        : 'unknown'
      : `${formatDuration(nowMs - unattended.sinceMs)} (since ${unattended.sinceKind === 'typed' ? 'the latest typed line' : 'the first request; nothing was typed'})`;
  const rate =
    unattended.rate == null
      ? 'none'
      : `${unattended.rate.percentPerHour.toFixed(3)} % of the week per hour`;
  const timingBlocks = [
    fields([
      {label: 'unattended for', value: elapsed},
      {label: 'average rate', value: rate},
    ]),
    ...(
      [
        ['chain', report.timing.chain],
        ['project (24 h)', report.timing.project],
      ] as const
    ).map(([name, timing]) =>
      [
        line(paint(`${name}: limit ${timing.limitPercent} %`, ['bold'], color)),
        fields(
          [
            ...(timing.kind === 'known'
              ? [{label: 'spent', value: pct(timing.spentPercent)}]
              : []),
            {label: 'reaches it', value: projectionText(timing)},
          ],
          nested,
        ),
      ].join('\n'),
    ),
  ];

  const sections: [string, string, string[]][] = [
    ['Spend quota', '🧮', [fields(sessionFields)]],
    ['Mode and limits', '⚙️', knobBlock],
    ['Group (handoffs and spawns)', '👥', groupBlocks],
    ['Latest typed line in the group', '⌨️', [typedBlock]],
    ['Unattended spend of the group', '💸', spendBlock],
    ['Project spend, last 24 hours', '🏗️', projectBlock],
    ['Week percent', '📅', weekBlock],
    ['Verdict', '⚖️', [verdictBlock]],
    ['Time to each spend limit', '⏱️', timingBlocks],
  ];
  if (log != null) {
    sections.push(['Quota log, this session', '📒', logBlocks(log, fields)]);
  }
  return spacedList(
    sections.map(([title, emoji, blocks]) =>
      [header(title, emoji), '', spacedList(blocks)].join('\n'),
    ),
  );
}

/** The report as JSON-ready data: ISO times beside the epoch ms. */
export function quotaReportJson(
  report: QuotaReport,
  /** The session's latest quota-log lines; null: not read, key left out. */
  log: SessionLogLines | null = null,
  /** Each member's Claude Code figure and estimate; null: key left out. */
  costs: MemberCosts | null = null,
): Record<string, unknown> {
  const {group} = report;
  return {
    ...(log != null && {log}),
    ...(costs != null && {memberCosts: costs}),
    checkout: report.checkout,
    config: report.config,
    group:
      group.kind === 'known'
        ? {
            ...group,
            firstUnattendedAt:
              group.firstUnattendedAtMs == null
                ? null
                : iso(group.firstUnattendedAtMs),
            latestTypedAt:
              group.latestTypedAtMs == null ? null : iso(group.latestTypedAtMs),
            members: group.members.map((member) => ({
              ...member,
              title: report.titles[member.beadId] ?? null,
            })),
          }
        : {
            ...group,
            members: group.members.map((member) => ({
              ...member,
              title: report.titles[member.beadId] ?? null,
            })),
          },
    maxWeekAgeMinutes: report.maxWeekAgeMinutes,
    now: iso(report.nowMs),
    problems: report.problems,
    project: report.project,
    schema: 1,
    session: report.session,
    sessionId: report.sessionId,
    timing: report.timing,
    unattended: {
      ...report.unattended,
      since:
        report.unattended.sinceMs == null
          ? null
          : iso(report.unattended.sinceMs),
    },
    verdicts: report.verdicts,
    week: report.week,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function runThreadQuota(input: {
  json: boolean;
  sessionId: string | null;
}): Promise<number> {
  const env = process.env;
  const session = sessionIdFrom(input.sessionId, env);
  if (!session.ok) {
    process.stderr.write(`thread quota: ${session.reason}\n`);
    return 2;
  }
  const report = await gatherQuotaReport({
    cwd: process.cwd(),
    env,
    nowMs: Date.now(),
    sessionId: session.id,
  });
  // Read here, not in gatherQuotaReport: the brake measures through that, and
  // must not read the whole log on every recompute.
  const log = readSessionLogLines(session.id, env);
  // Also here, not in gatherQuotaReport: it prices every member's whole
  // transcript again, which the brake must not pay (ys9t7.8.1 item 4).
  const costs = await gatherMemberCosts({env, group: report.group});
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(quotaReportJson(report, log, costs), null, 2)}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${renderQuotaReport(report, outputStyle(), log, costs)}\n`,
  );
  return 0;
}
