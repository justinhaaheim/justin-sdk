/**
 * Test sandbox helpers.
 *
 * Each test gets a fresh temp directory in $TMPDIR (e.g., /var/folders/... on
 * macOS, /tmp on Linux). Cleanup is automatic via afterEach.
 */

import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

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
  const path = mkdtempSync(join(tmpdir(), 'justin-sdk-test-'));

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
