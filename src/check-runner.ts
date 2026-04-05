#!/usr/bin/env bun

/**
 * Generic check runner — runs a list of checks (shell commands or async
 * functions) in parallel or serial, with colored output and a summary.
 *
 * Can be used as a CLI or imported as a TypeScript module.
 *
 * CLI usage:
 *   bun scripts/check-runner.ts [options] [LABEL:command ...]
 *
 * Options:
 *   --serial    Run checks sequentially (default: parallel)
 *   --quiet     Suppress stdout, only show stderr + summary
 *   --align     Pad label prefixes to equal width
 *   --fix       Re-run failed checks that provide a fixCommand
 *
 * TypeScript API:
 *   import { runChecks } from './check-runner';
 *   const exitCode = await runChecks([
 *     { label: 'TS', command: 'tsc --noEmit' },
 *     { label: 'BR', fn: async () => ({ pass: true }) },
 *   ]);
 */

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';

const COLOR_PALETTE = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[35m', // magenta
  '\x1b[34m', // blue
  '\x1b[31m', // red
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by a check function. */
export interface CheckResult {
  /** Actionable human-readable fix instruction */
  fix?: string;
  /** Shell command that --fix mode can auto-run to attempt a fix */
  fixCommand?: string;
  /** Shown on failure (e.g., "expected 0.1.34, got 0.1.30") */
  message?: string;
  pass: boolean;
}

/** A single check to run. Provide either `command` (shell) or `fn` (async). */
export interface Check {
  /** Shell command — exit 0 = pass, non-zero = fail */
  command?: string;
  /** Function returning a CheckResult (sync or async) */
  fn?: () => CheckResult | Promise<CheckResult>;
  label: string;
  /** 'error' (default) fails the run; 'warn' prints but doesn't affect exit code */
  severity?: 'error' | 'warn';
}

export interface RunChecksOptions {
  align?: boolean;
  fix?: boolean;
  quiet?: boolean;
  serial?: boolean;
}

/** A check with optional children that only run if the parent passes. */
export interface CheckNode {
  check: Check;
  /** Child checks — only run if this check passes. */
  children?: CheckNode[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InternalEntry {
  check: Check;
  color: string;
}

interface InternalResult {
  checkResult?: CheckResult;
  durationMs: number;
  exitCode: number;
  label: string;
  severity: 'error' | 'warn';
  /** Set when a check was skipped because its parent failed. */
  skipped?: boolean;
  /** Label of the parent check that caused this to be skipped. */
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(2)}s`;
}

function buildPrefix(
  label: string,
  color: string,
  align: boolean,
  maxLabelLen: number,
): string {
  const paddedLabel = align ? label.padEnd(maxLabelLen) : label;
  return `${color}[${paddedLabel}]${RESET}`;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

function prefixLines(
  chunk: Uint8Array,
  prefix: string,
  trailing: string,
): {output: string; trailing: string} {
  const text = trailing + new TextDecoder().decode(chunk);
  const lines = text.split('\n');
  const newTrailing = lines.pop() ?? '';
  const output = lines.map((line) => `${prefix} ${line}\n`).join('');
  return {output, trailing: newTrailing};
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null | undefined,
  prefix: string,
  writer: (text: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  let trailing = '';

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    const result = prefixLines(value, prefix, trailing);
    writer(result.output);
    trailing = result.trailing;
  }

  if (trailing) {
    writer(`${prefix} ${trailing}\n`);
  }
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  while (true) {
    const {done} = await reader.read();
    if (done) break;
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface ExecOptions {
  align: boolean;
  maxLabelLen: number;
  piped: boolean;
  quiet: boolean;
}

async function runShellCommand(
  entry: InternalEntry,
  opts: ExecOptions,
): Promise<InternalResult> {
  const {check, color} = entry;
  const {align, maxLabelLen, piped, quiet} = opts;
  const prefix = buildPrefix(check.label, color, align, maxLabelLen);
  const start = performance.now();

  const shouldPipe = piped || quiet;
  const command = check.command ?? '';
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: process.cwd(),
    env: shouldPipe ? {...process.env, FORCE_COLOR: '1'} : process.env,
    stderr: shouldPipe ? 'pipe' : 'inherit',
    stdout: shouldPipe ? 'pipe' : 'inherit',
  });

  if (shouldPipe) {
    const writeStderr = (text: string) => process.stderr.write(text);
    const stdoutPipe = quiet
      ? drainStream(proc.stdout)
      : pipeWithPrefix(proc.stdout, prefix, (text) =>
          process.stdout.write(text),
        );

    await Promise.all([
      stdoutPipe,
      pipeWithPrefix(proc.stderr, prefix, writeStderr),
    ]);
  }

  const exitCode = await proc.exited;
  const durationMs = Math.round(performance.now() - start);

  return {
    durationMs,
    exitCode,
    label: check.label,
    severity: check.severity ?? 'error',
  };
}

async function runFnCheck(entry: InternalEntry): Promise<InternalResult> {
  const {check} = entry;
  const start = performance.now();

  try {
    const fn =
      check.fn ??
      (() => ({message: 'No check function provided', pass: false}));
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    return {
      checkResult: result,
      durationMs,
      exitCode: result.pass ? 0 : 1,
      label: check.label,
      severity: check.severity ?? 'error',
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    return {
      checkResult: {
        message: error instanceof Error ? error.message : String(error),
        pass: false,
      },
      durationMs,
      exitCode: 1,
      label: check.label,
      severity: check.severity ?? 'error',
    };
  }
}

async function runOne(
  entry: InternalEntry,
  opts: ExecOptions,
): Promise<InternalResult> {
  if (entry.check.fn) {
    return await runFnCheck(entry);
  }
  return await runShellCommand(entry, opts);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(
  results: InternalResult[],
  totalMs: number,
  quiet: boolean,
): void {
  const errors = results.filter(
    (r) => !r.skipped && r.exitCode !== 0 && r.severity === 'error',
  );
  const warnings = results.filter(
    (r) => !r.skipped && r.exitCode !== 0 && r.severity === 'warn',
  );
  const passed = results.filter((r) => !r.skipped && r.exitCode === 0);
  const skipped = results.filter((r) => r.skipped);

  // In quiet mode, only print if there are errors, warnings, or skipped
  if (quiet && errors.length === 0 && warnings.length === 0 && skipped.length === 0) {
    console.log(
      `${GREEN}✓${RESET} All ${results.length} checks passed. ${DIM}[${formatDuration(totalMs)}]${RESET}`,
    );
    return;
  }

  console.log('');

  for (const r of results) {
    if (r.skipped) {
      // In quiet mode, skip the skipped checks too
      if (quiet) continue;

      const label = `${DIM}${r.label}${RESET}`;
      console.log(` ${DIM}↳${RESET} ${label} ${DIM}skipped (depends on ${r.skippedReason})${RESET}`);
      continue;
    }

    const ok = r.exitCode === 0;
    const isWarn = !ok && r.severity === 'warn';

    // In quiet mode, skip passing checks
    if (quiet && ok) continue;

    const icon = ok
      ? `${GREEN}✓${RESET}`
      : isWarn
        ? `${YELLOW}⚠${RESET}`
        : `${RED}✗${RESET}`;
    const labelColor = ok ? '' : isWarn ? YELLOW : RED;
    const label = ok ? r.label : `${labelColor}${r.label}${RESET}`;
    const duration = `${DIM}[${formatDuration(r.durationMs)}]${RESET}`;
    let line = ` ${icon} ${label} ${duration}`;

    if (!ok && r.checkResult?.message) {
      line += `\n     ${DIM}${r.checkResult.message}${RESET}`;
    }
    if (!ok && r.checkResult?.fix) {
      line += `\n     ${YELLOW}Fix: ${r.checkResult.fix}${RESET}`;
    }

    console.log(line);
  }

  console.log('');
  if (passed.length > 0) console.log(` ${GREEN}${passed.length} pass${RESET}`);
  if (warnings.length > 0)
    console.log(` ${YELLOW}${warnings.length} warn${RESET}`);
  if (errors.length > 0) console.log(` ${RED}${errors.length} fail${RESET}`);
  if (skipped.length > 0)
    console.log(` ${DIM}${skipped.length} skipped${RESET}`);
  console.log(
    `${BOLD}Ran ${results.length - skipped.length} checks. ${DIM}[${formatDuration(totalMs)}]${RESET}`,
  );
}

// ---------------------------------------------------------------------------
// Fix mode
// ---------------------------------------------------------------------------

async function attemptFixes(
  results: InternalResult[],
  entries: InternalEntry[],
  opts: ExecOptions,
): Promise<InternalResult[]> {
  const fixable = results.filter(
    (r) => r.exitCode !== 0 && r.checkResult?.fixCommand,
  );

  if (fixable.length === 0) return results;

  console.log(
    `\n${YELLOW}Attempting fixes for ${fixable.length} check(s)...${RESET}\n`,
  );

  for (const r of fixable) {
    const fixCmd = r.checkResult?.fixCommand ?? '';
    console.log(`  ${YELLOW}→${RESET} ${r.label}: ${DIM}${fixCmd}${RESET}`);
    try {
      const proc = Bun.spawn(['sh', '-c', fixCmd], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await proc.exited;
    } catch {
      // fix attempt failed — will show in re-check
    }
  }

  // Re-run only the checks that had fixes
  console.log(`\n${YELLOW}Re-running fixed checks...${RESET}\n`);
  const fixedLabels = new Set(fixable.map((r) => r.label));
  const updatedResults = [...results];

  for (let i = 0; i < updatedResults.length; i++) {
    const result = updatedResults[i];
    if (result && fixedLabels.has(result.label)) {
      const entry = entries.find((e) => e.check.label === result.label);
      if (entry) {
        updatedResults[i] = await runOne(entry, opts);
      }
    }
  }

  return updatedResults;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an array of checks and print a summary.
 * Returns the process exit code (0 = all pass, 1 = any fail).
 */
export async function runChecks(
  checks: Check[],
  options: RunChecksOptions = {},
): Promise<number> {
  const {serial = false, quiet = false, align = false, fix = false} = options;

  const entries: InternalEntry[] = checks.map((check, i) => ({
    check,
    color: COLOR_PALETTE[i % COLOR_PALETTE.length] ?? '\x1b[36m',
  }));

  const maxLabelLen = Math.max(...entries.map((e) => e.check.label.length));
  const piped = !serial;
  const opts: ExecOptions = {align, maxLabelLen, piped, quiet};

  if (!quiet) {
    console.log(
      `Running ${entries.length} checks ${serial ? 'serially' : 'in parallel'}...\n`,
    );
  }

  const totalStart = performance.now();

  let results: InternalResult[];
  if (serial) {
    results = [];
    for (const entry of entries) {
      results.push(await runOne(entry, opts));
    }
  } else {
    results = await Promise.all(entries.map((entry) => runOne(entry, opts)));
  }

  if (fix) {
    results = await attemptFixes(results, entries, opts);
  }

  const totalMs = Math.round(performance.now() - totalStart);
  printSummary(results, totalMs, quiet);

  // Only errors affect exit code, not warnings
  const hasErrors = results.some(
    (r) => r.exitCode !== 0 && r.severity === 'error',
  );
  return hasErrors ? 1 : 0;
}

/**
 * Run a tree of checks where children only run if their parent passes.
 * Always runs serially (tree dependencies require sequential execution).
 * Returns the process exit code (0 = all pass, 1 = any fail).
 */
export async function runCheckTree(
  nodes: CheckNode[],
  options: RunChecksOptions = {},
): Promise<number> {
  const {quiet = false, align = false, fix = false} = options;

  // Flatten the tree to collect all labels for alignment
  function collectLabels(nodeList: CheckNode[]): string[] {
    const labels: string[] = [];
    for (const node of nodeList) {
      labels.push(node.check.label);
      if (node.children) {
        labels.push(...collectLabels(node.children));
      }
    }
    return labels;
  }

  const allLabels = collectLabels(nodes);
  const maxLabelLen = Math.max(...allLabels.map((l) => l.length));
  const opts: ExecOptions = {align, maxLabelLen, piped: true, quiet};

  // Assign stable colors to each node (by position in the tree)
  function buildEntryMap(
    nodeList: CheckNode[],
    startIndex: number,
  ): {entries: Map<string, InternalEntry>; nextIndex: number} {
    const entries = new Map<string, InternalEntry>();
    let idx = startIndex;
    for (const node of nodeList) {
      entries.set(node.check.label, {
        check: node.check,
        color: COLOR_PALETTE[idx % COLOR_PALETTE.length] ?? '\x1b[36m',
      });
      idx++;
      if (node.children) {
        const child = buildEntryMap(node.children, idx);
        for (const [k, v] of child.entries) entries.set(k, v);
        idx = child.nextIndex;
      }
    }
    return {entries, nextIndex: idx};
  }

  const {entries: entryMap} = buildEntryMap(nodes, 0);

  async function walkTree(
    nodeList: CheckNode[],
    skipReason?: string,
  ): Promise<InternalResult[]> {
    const results: InternalResult[] = [];
    for (const node of nodeList) {
      const entry = entryMap.get(node.check.label)!;

      if (skipReason) {
        results.push({
          durationMs: 0,
          exitCode: 1,
          label: node.check.label,
          severity: node.check.severity ?? 'error',
          skipped: true,
          skippedReason: skipReason,
        });
        if (node.children) {
          results.push(...(await walkTree(node.children, skipReason)));
        }
        continue;
      }

      const result = await runOne(entry, opts);
      results.push(result);

      if (result.exitCode !== 0 && node.children) {
        results.push(...(await walkTree(node.children, node.check.label)));
      } else if (node.children) {
        results.push(...(await walkTree(node.children)));
      }
    }
    return results;
  }

  if (!quiet) {
    console.log(`Running ${allLabels.length} checks...\n`);
  }

  const totalStart = performance.now();
  let results = await walkTree(nodes);

  if (fix) {
    // Attempt fixes on non-skipped failures, then re-walk the entire tree
    // so that children of newly-fixed parents get a chance to run.
    const fixable = results.filter(
      (r) => !r.skipped && r.exitCode !== 0 && r.checkResult?.fixCommand,
    );

    if (fixable.length > 0) {
      console.log(
        `\n${YELLOW}Attempting fixes for ${fixable.length} check(s)...${RESET}\n`,
      );

      for (const r of fixable) {
        const fixCmd = r.checkResult?.fixCommand ?? '';
        console.log(
          `  ${YELLOW}→${RESET} ${r.label}: ${DIM}${fixCmd}${RESET}`,
        );
        try {
          const proc = Bun.spawn(['sh', '-c', fixCmd], {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          await proc.exited;
        } catch {
          // fix attempt failed — will show in re-walk
        }
      }

      console.log(`\n${YELLOW}Re-running all checks...${RESET}\n`);
      results = await walkTree(nodes);
    }
  }

  const totalMs = Math.round(performance.now() - totalStart);
  printSummary(results, totalMs, quiet);

  const hasErrors = results.some(
    (r) => !r.skipped && r.exitCode !== 0 && r.severity === 'error',
  );
  return hasErrors ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseCommandArg(
  arg: string,
  index: number,
): {command: string; label: string} {
  const colonIndex = arg.indexOf(':');
  if (colonIndex > 0) {
    const potentialLabel = arg.slice(0, colonIndex);
    if (
      /^[A-Z][A-Z0-9_-]*$/.test(potentialLabel) &&
      potentialLabel.length <= 20
    ) {
      return {command: arg.slice(colonIndex + 1), label: potentialLabel};
    }
  }
  const firstWord =
    (arg.split(/\s+/)[0] ?? '').split('/').pop() ?? `cmd${index + 1}`;
  return {command: arg, label: firstWord.toUpperCase()};
}

async function cliMain(): Promise<void> {
  const flags = new Set<string>();
  const positionalArgs: string[] = [];

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      flags.add(arg);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (positionalArgs.length === 0) {
    console.error(
      'Usage: bun scripts/check-runner.ts [--serial] [--quiet] [--align] [--fix] LABEL:command ...',
    );
    process.exit(1);
  }

  const checks: Check[] = positionalArgs.map((arg, i) => {
    const {label, command} = parseCommandArg(arg, i);
    return {command, label};
  });

  const exitCode = await runChecks(checks, {
    align: flags.has('--align'),
    fix: flags.has('--fix'),
    quiet: flags.has('--quiet'),
    serial: flags.has('--serial'),
  });

  process.exit(exitCode);
}

// Run CLI if executed directly
const isDirectExecution =
  import.meta.path === Bun.main || process.argv[1]?.endsWith('check-runner.ts');
if (isDirectExecution) {
  void cliMain();
}
