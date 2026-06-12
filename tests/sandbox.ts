/**
 * Test sandbox helpers.
 *
 * Each test gets a fresh temp directory in $TMPDIR (e.g., /var/folders/... on
 * macOS, /tmp on Linux). Cleanup is automatic via afterEach.
 */

import {mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

// `br` is installed as a mise tool and resolved via mise shims. mise refuses to
// evaluate a directory's mise.toml unless that directory is trusted, which would
// make `br --version` fail in our ephemeral sandboxes and send the setup code
// down a redundant (lock-contending) install path. Trust the whole tmp base
// once — mise's trusted_config_paths prefix-matches, so this covers every
// sandbox we create under it. We mutate process.env here; setup-helpers' exec()
// passes the live env to children, so this reaches `br` even under Bun (whose
// execSync otherwise snapshots env at startup and ignores later mutations).
const TMP_BASE = realpathSync(tmpdir());
const existingTrust = process.env.MISE_TRUSTED_CONFIG_PATHS;
process.env.MISE_TRUSTED_CONFIG_PATHS =
  existingTrust != null && existingTrust.length > 0
    ? `${existingTrust}:${TMP_BASE}`
    : TMP_BASE;

export interface Sandbox {
  /** Absolute path to the sandbox directory */
  path: string;
  /** Clean up the sandbox (called automatically via afterEach) */
  cleanup: () => void;
  /** Write a file inside the sandbox (creates parent dirs) */
  writeFile: (relativePath: string, content: string) => void;
  /** Create an empty directory inside the sandbox */
  mkdir: (relativePath: string) => void;
}

export function createSandbox(): Sandbox {
  // realpathSync so the canonical (/private/... on macOS) form is used — it must
  // sit under the trusted TMP_BASE prefix set at module load, and mise
  // canonicalizes paths when matching, so a /var symlink form wouldn't match.
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'justin-sdk-test-')));

  return {
    path,
    cleanup: () => {
      rmSync(path, {recursive: true, force: true});
    },
    writeFile: (relativePath: string, content: string) => {
      const fullPath = join(path, relativePath);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir && dir !== path) {
        mkdirSync(dir, {recursive: true});
      }
      writeFileSync(fullPath, content);
    },
    mkdir: (relativePath: string) => {
      mkdirSync(join(path, relativePath), {recursive: true});
    },
  };
}

/**
 * Create a sandbox that simulates a fresh project with a minimal
 * package.json and optional CLAUDE.md.
 */
export function createProjectSandbox(options?: {
  claudeMd?: string;
  packageJson?: Record<string, unknown>;
  justinSdkConfig?: Record<string, unknown>;
}): Sandbox {
  const sandbox = createSandbox();
  sandbox.writeFile(
    'package.json',
    JSON.stringify(
      options?.packageJson ?? {name: 'test-project', version: '0.0.1'},
      null,
      2,
    ) + '\n',
  );
  if (options?.claudeMd !== undefined) {
    sandbox.writeFile('CLAUDE.md', options.claudeMd);
  }
  if (options?.justinSdkConfig) {
    sandbox.writeFile(
      'justin-sdk.config.json',
      JSON.stringify(options.justinSdkConfig, null, 2) + '\n',
    );
  }
  return sandbox;
}
