/**
 * Doctor — component-based environment validation.
 *
 * Reads justin-sdk.config.json to determine which components are installed,
 * then runs the corresponding doctor checks.
 *
 * Each component registers its own checks. Adding a new component
 * to justin-sdk.config.json automatically includes its doctor checks.
 */

import type {CheckNode, CheckResult} from './check-runner';

import {runCheckTree} from './check-runner';
import {execSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

const IS_REMOTE = process.env.CLAUDE_CODE_REMOTE === 'true';

/** Read the centrally pinned version from versions.json (if available). */
function getCentralBeadsVersion(): string | null {
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) return null;
  try {
    const versions = JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
      string,
      string
    >;
    return versions.beads_rust ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd: string): {exitCode: number; stdout: string} {
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

function makeBaseChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        label: 'CLAUDE_MD',
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'CLAUDE.md'))) {
            return {message: 'No CLAUDE.md found', pass: false};
          }
          return {pass: true};
        },
      },
    },
    {
      check: {
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
    },
    {
      check: {
        label: 'JUSTIN_SDK_JSON',
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'justin-sdk.config.json'))) {
            return {
              fix: 'Create justin-sdk.config.json at project root',
              message: 'No justin-sdk.config.json found',
              pass: false,
            };
          }
          return {pass: true};
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Beads checks (beads-setup component)
// ---------------------------------------------------------------------------

function makeBeadsChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        label: 'MISE',
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('mise --version', projectRoot);
          if (exitCode !== 0) {
            const fixCommand = IS_REMOTE
              ? 'curl -fsSL https://mise.run | sh'
              : 'brew install mise';
            return {
              fix: `Run: ${fixCommand}`,
              fixCommand,
              message: 'mise is not installed',
              pass: false,
            };
          }
          return {message: `mise ${stdout}`, pass: true};
        },
      },
      children: [
        {
          check: {
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
          children: [
            {
              check: {
                label: 'BR',
                fn: (): CheckResult => {
                  const {stdout, exitCode} = exec('br --version', projectRoot);
                  if (exitCode !== 0) {
                    // Build a fixCommand that tries mise first, then falls
                    // back to the official install script if mise is
                    // rate-limited by GitHub.
                    const miseVersions = parseMiseToml(projectRoot);
                    const beadsKey = miseVersions
                      ? Object.keys(miseVersions).find((k) =>
                          k.includes('beads_rust'),
                        )
                      : null;
                    const version = beadsKey ? miseVersions![beadsKey] : null;
                    const versionTag =
                      version && !version.startsWith('v')
                        ? `v${version}`
                        : version;

                    let fixCommand = 'mise install';
                    if (versionTag) {
                      fixCommand = `mise install || curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`;
                    }

                    return {
                      fix: 'Run: mise install (falls back to direct GitHub download if rate-limited)',
                      fixCommand,
                      message:
                        'br (beads_rust) is not installed or not on PATH',
                      pass: false,
                    };
                  }

                  // Check version against central pin (preferred) or mise.toml
                  const actual = stdout.replace(/^br\s*/, '').trim();
                  const centralVersion = getCentralBeadsVersion();
                  const miseVersions = parseMiseToml(projectRoot);
                  const beadsKey = miseVersions
                    ? Object.keys(miseVersions).find((k) =>
                        k.includes('beads_rust'),
                      )
                    : null;
                  const expected =
                    centralVersion ??
                    (beadsKey ? miseVersions![beadsKey] : null);

                  if (expected && actual !== expected) {
                    const source = centralVersion
                      ? 'versions.json'
                      : 'mise.toml';
                    return {
                      fix: 'Run: mise install',
                      fixCommand: 'mise install',
                      message: `Version mismatch: expected ${expected} (from ${source}), got ${actual}`,
                      pass: false,
                    };
                  }

                  return {
                    message: `br ${actual}`,
                    pass: true,
                  };
                },
              },
              children: [
                {
                  check: {
                    label: 'BR_DB',
                    fn: (): CheckResult => {
                      if (
                        !existsSync(resolve(projectRoot, '.beads/beads.db'))
                      ) {
                        return {
                          fix: 'Run: br init',
                          fixCommand: 'br init',
                          message:
                            '.beads/beads.db not found — beads not initialized',
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
                  children: [
                    {
                      check: {
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
                          if (
                            !content.includes('br ') &&
                            !content.includes('beads_rust')
                          ) {
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
                    },
                    {
                      check: {
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
                              message:
                                'CLAUDE.md does not reference @AGENTS.md',
                              pass: false,
                            };
                          }

                          return {pass: true};
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      check: {
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
    },
  ];
}

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

const componentCheckFactories: Record<
  string,
  (projectRoot: string) => CheckNode[]
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
 * Run doctor checks based on the components listed in justin-sdk.config.json.
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Doctor options (fix, quiet)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<number> {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');

  if (!existsSync(configPath)) {
    console.error(
      'Error: justin-sdk.config.json not found. Create one with at least {"version": "0.2.0", "components": ["base-setup"]}',
    );
    return 1;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    components?: string[];
  };
  const components = config.components ?? [];

  const nodes: CheckNode[] = [];
  for (const component of components) {
    const factory = componentCheckFactories[component];
    if (factory) {
      nodes.push(...factory(projectRoot));
    }
  }

  if (nodes.length === 0) {
    console.log('No doctor checks registered for the listed components.');
    return 0;
  }

  return runCheckTree(nodes, {
    align: true,
    fix: options.fix,
    quiet: options.quiet,
  });
}
