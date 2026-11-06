/**
 * TS_INSTALLED never advises a downgrade (home-base-p05kz.4 change 2).
 *
 * Measured in the 2026-11-06 audit: nature-sounds and screenshot-app, both on
 * typescript 6.0.3, were told in every session to "update to 5.9.2".
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {stripAnsi} from '../src/check-runner';
import {renderDoctor} from '../src/doctor';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

async function quietReport(typescript: string): Promise<string> {
  const box = createSandbox();
  sandboxes.push(box);
  box.writeFile(
    'package.json',
    JSON.stringify({
      devDependencies: {typescript},
      name: 'x',
      version: '0.0.1',
    }),
  );
  box.writeFile(
    'justin-sdk.config.json',
    JSON.stringify({components: ['tsconfig-setup']}),
  );
  const run = await renderDoctor(box.path, {quiet: true});
  return stripAnsi(run.report);
}

describe('TS_INSTALLED', () => {
  test('a version newer than the pin prints nothing under --quiet', async () => {
    expect(await quietReport('99.0.3')).not.toContain('TS_INSTALLED');
  });

  test('a caret range newer than the pin prints nothing either', async () => {
    expect(await quietReport('^99.0.3')).not.toContain('TS_INSTALLED');
  });

  test('a version older than the pin still warns', async () => {
    const out = await quietReport('1.0.0');
    expect(out).toContain('TS_INSTALLED');
    expect(out).toContain('typescript is at 1.0.0');
  });

  test('a spec semver cannot read still warns: unknown is not newer', async () => {
    expect(await quietReport('latest')).toContain('TS_INSTALLED');
  });
});
