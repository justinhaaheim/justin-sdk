/**
 * eas-update — publish an EAS update with a standardized, disambiguating
 * message, so the same behavior is available to every project via the CLI
 * (`bunx justin-sdk eas-update <channel>`) instead of a copy-pasted script.
 *
 * Message format:
 *   <dynamicVersion>-<branch> (<runtime> runtime) - <changelog>
 *   e.g.  0.1.77-feature-branch (0.1.0 runtime) - fix stop-during-load race
 *
 * The dynamicVersion + branch PAIR matters: dynamicVersion counts commits since
 * the last tag, so the same number can exist on both main and a feature branch —
 * the branch disambiguates which build a given JS bundle belongs to.
 *
 * Reads dynamic-version.local.json from the project (produced by
 * @justinhaaheim/version-manager, i.e. `bun run prebuild`). changelog defaults
 * to the project's latest commit subject.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {exec} from './setup-helpers';

export interface EasUpdateOptions {
  channel: string;
  /** Changelog text; defaults to the project's latest commit subject. */
  changelog?: string | null;
  /**
   * EAS "environment" (which env-var set to resolve) — required by recent EAS
   * CLIs in --non-interactive mode. Defaults to APP_VARIANT, then the channel.
   */
  environment?: string | null;
  /** EAS platform (default: ios). */
  platform?: string;
}

interface DynamicVersion {
  branch: string;
  dynamicVersion: string;
  versions: {runtime: string};
}

function lastCommitSubject(cwd: string): string {
  const result = exec('git log -1 --pretty=%s', cwd);
  return result.exitCode === 0 && result.stdout !== ''
    ? result.stdout
    : 'update';
}

export function runEasUpdate(cwd: string, opts: EasUpdateOptions): number {
  const {channel} = opts;
  const platform = opts.platform ?? 'ios';

  const dvPath = join(cwd, 'dynamic-version.local.json');
  if (!existsSync(dvPath)) {
    process.stderr.write(
      'dynamic-version.local.json missing — run `bun run prebuild` first\n',
    );
    return 1;
  }
  const dv = JSON.parse(readFileSync(dvPath, 'utf8')) as DynamicVersion;

  const explicit = opts.changelog?.trim() ?? '';
  const changelog = explicit !== '' ? explicit : lastCommitSubject(cwd);
  const message = `${dv.dynamicVersion}-${dv.branch} (${dv.versions.runtime} runtime) - ${changelog}`;

  // The three valid EAS environments are development / preview / production,
  // which line up with APP_VARIANT; fall back to the channel name.
  const environment = opts.environment ?? process.env.APP_VARIANT ?? channel;

  process.stdout.write(
    `[eas-update] channel=${channel} environment=${environment}\n[eas-update] ${message}\n`,
  );

  // Inherit stdio so EAS's live progress/output is visible; pass args as an
  // array (no shell) so the spaced/parenthesized message needs no escaping.
  const result = Bun.spawnSync(
    [
      'eas',
      'update',
      '--channel',
      channel,
      '--environment',
      environment,
      '--platform',
      platform,
      '--message',
      message,
      '--non-interactive',
    ],
    {cwd, stdio: ['inherit', 'inherit', 'inherit']},
  );
  return result.exitCode ?? 1;
}
