/**
 * Doctor — component-based environment validation.
 *
 * Reads justin-sdk.json to determine which components are installed,
 * then runs the corresponding doctor checks.
 *
 * Each component registers its own checks. Adding a new component
 * to justin-sdk.json automatically includes its doctor checks.
 */

import type {Check, CheckResult} from './check-runner';

import {runChecks} from './check-runner';
import {execSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(
  cmd: string,
  cwd: string,
): {exitCode: number; stdout: string} {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout};
  } catch {
    return {exitCode: 1, stdout: ''};
  }
}

function parseMiseToml(projectRoot: string): Record<string, string> | null {
  const miseTomlPath = resolve(projectRoot, 'mise.toml');
  if (!existsSync(miseTomlPath)) return null;

  const content = readFileSync(miseTomlPath, 'utf-8');
  const versions: Record<string, string> = {};

  const toolPattern =
    /"([^"]+)"\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/g;
  let match;
  while ((match = toolPattern.exec(content)) !== null) {
    const tool = match[1];
    const version = match[2] ?? match[3];
    if (tool && version) {
      versions[tool] = version;
    }
  }

  return versions;
}

// ---------------------------------------------------------------------------
// Base checks (base-setup component)
// ---------------------------------------------------------------------------

function makeBaseChecks(projectRoot: string): Check[] {
  return [
    {
      label: 'CLAUDE_MD',
      fn: (): CheckResult => {
        if (!existsSync(resolve(projectRoot, 'CLAUDE.md'))) {
          return {message: 'No CLAUDE.md found', pass: false};
        }
        return {pass: true};
      },
    },
    {
      label: 'PKG_SCRIPTS',
      fn: (): CheckResult => {
        const pkgPath = resolve(projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          return {message: 'No package.json found', pass: false};
        }

        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const required = ['setup-env', 'signal', 'doctor'];
        const missing = required.filter((name) => !(name in scripts));

        if (missing.length > 0) {
          return {
            fix: `Add missing scripts to package.json: ${missing.join(', ')}`,
            message: `Missing package.json scripts: ${missing.join(', ')}`,
            pass: false,
          };
        }

        return {pass: true};
      },
    },
    {
      label: 'JUSTIN_SDK_JSON',
      fn: (): CheckResult => {
        if (!existsSync(resolve(projectRoot, 'justin-sdk.json'))) {
          return {
            fix: 'Create justin-sdk.json at project root',
            message: 'No justin-sdk.json found',
            pass: false,
          };
        }
        return {pass: true};
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Beads checks (beads-setup component)
// ---------------------------------------------------------------------------

function makeBeadsChecks(projectRoot: string): Check[] {
  return [
    {
      label: 'MISE',
      fn: (): CheckResult => {
        const {stdout, exitCode} = exec('mise --version', projectRoot);
        if (exitCode !== 0) {
          return {
            fix: 'Run: brew install mise',
            fixCommand: 'brew install mise',
            message: 'mise is not installed',
            pass: false,
          };
        }
        return {message: `mise ${stdout}`, pass: true};
      },
    },
    {
      label: 'MISE_TOML',
      fn: (): CheckResult => {
        if (!existsSync(resolve(projectRoot, 'mise.toml'))) {
          return {
            fix: 'This project may not have mise configured yet. See beads-setup docs.',
            message: 'No mise.toml found at project root',
            pass: false,
          };
        }
        return {pass: true};
      },
    },
    {
      label: 'BR',
      fn: (): CheckResult => {
        const {stdout, exitCode} = exec('br --version', projectRoot);
        if (exitCode !== 0) {
          return {
            fix: 'Run: mise install && ensure ~/.local/share/mise/shims is on PATH',
            fixCommand: 'mise install',
            message: 'br (beads_rust) is not installed or not on PATH',
            pass: false,
          };
        }

        const miseVersions = parseMiseToml(projectRoot);
        if (miseVersions) {
          const beadsKey = Object.keys(miseVersions).find((k) =>
            k.includes('beads_rust'),
          );
          if (beadsKey) {
            const expected = miseVersions[beadsKey];
            const actual = stdout.replace(/^br\s*/, '').trim();
            if (actual !== expected) {
              return {
                fix: 'Run: mise install',
                fixCommand: 'mise install',
                message: `Version mismatch: expected ${expected} (from mise.toml), got ${actual}`,
                pass: false,
              };
            }
          }
        }

        return {
          message: `br ${stdout.replace(/^br\s*/, '').trim()}`,
          pass: true,
        };
      },
    },
    {
      label: 'BR_DB',
      fn: (): CheckResult => {
        if (!existsSync(resolve(projectRoot, '.beads/beads.db'))) {
          return {
            fix: 'Run: br init',
            fixCommand: 'br init',
            message: '.beads/beads.db not found — beads not initialized',
            pass: false,
          };
        }

        const {exitCode} = exec('br list --json', projectRoot);
        if (exitCode !== 0) {
          return {
            fix: 'Run: br doctor --fix',
            fixCommand: 'br doctor --fix',
            message: 'br list failed — database may be corrupt',
            pass: false,
          };
        }

        return {pass: true};
      },
    },
    {
      label: 'AGENTS_MD',
      fn: (): CheckResult => {
        const agentsMd = resolve(projectRoot, 'AGENTS.md');
        if (!existsSync(agentsMd)) {
          return {
            fix: 'Run: br agents --add --force',
            fixCommand: 'br agents --add --force',
            message: 'AGENTS.md not found',
            pass: false,
          };
        }

        const content = readFileSync(agentsMd, 'utf-8');
        if (!content.includes('br ') && !content.includes('beads_rust')) {
          return {
            fix: 'Run: br agents --add --force',
            fixCommand: 'br agents --add --force',
            message:
              'AGENTS.md does not reference br/beads_rust — may be outdated',
            pass: false,
          };
        }

        return {pass: true};
      },
    },
    {
      label: 'CLAUDE_MD_AGENTS_REF',
      severity: 'warn',
      fn: (): CheckResult => {
        const claudeMd = resolve(projectRoot, 'CLAUDE.md');
        if (!existsSync(claudeMd)) {
          return {message: 'No CLAUDE.md found', pass: false};
        }

        const content = readFileSync(claudeMd, 'utf-8');
        if (!content.includes('AGENTS.md')) {
          return {
            fix: 'Add an @AGENTS.md reference to CLAUDE.md',
            message: 'CLAUDE.md does not reference @AGENTS.md',
            pass: false,
          };
        }

        return {pass: true};
      },
    },
    {
      label: 'PRETTIER_IGNORE_BEADS',
      fn: (): CheckResult => {
        const prettierIgnore = resolve(projectRoot, '.prettierignore');
        if (!existsSync(prettierIgnore)) {
          return {
            fix: 'Create .prettierignore with .beads entry',
            message: '.prettierignore not found',
            pass: false,
          };
        }

        const content = readFileSync(prettierIgnore, 'utf-8');
        if (!content.includes('.beads')) {
          return {
            fix: 'Add .beads to .prettierignore',
            message: '.prettierignore does not include .beads',
            pass: false,
          };
        }

        return {pass: true};
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

const componentCheckFactories: Record<
  string,
  (projectRoot: string) => Check[]
> = {
  'base-setup': makeBaseChecks,
  'beads-setup': makeBeadsChecks,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  fix?: boolean;
  quiet?: boolean;
}

/**
 * Run doctor checks based on the components listed in justin-sdk.json.
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Doctor options (fix, quiet)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<number> {
  const configPath = resolve(projectRoot, 'justin-sdk.json');

  if (!existsSync(configPath)) {
    console.error(
      'Error: justin-sdk.json not found. Create one with at least {"version": "0.2.0", "components": ["base-setup"]}',
    );
    return 1;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    components?: string[];
  };
  const components = config.components ?? [];

  const checks: Check[] = [];
  for (const component of components) {
    const factory = componentCheckFactories[component];
    if (factory) {
      checks.push(...factory(projectRoot));
    }
  }

  if (checks.length === 0) {
    console.log('No doctor checks registered for the listed components.');
    return 0;
  }

  return runChecks(checks, {
    align: true,
    fix: options.fix,
    quiet: options.quiet,
    serial: true,
  });
}
