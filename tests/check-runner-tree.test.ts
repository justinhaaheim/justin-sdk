/**
 * Tests for tree-walking behavior: child checks should only be skipped
 * when their parent fails with error severity, not warn severity.
 */

import {describe, test, expect} from 'bun:test';

import type {CheckNode} from '../src/check-runner';
import {runCheckTree} from '../src/check-runner';

describe('check-runner tree walking', () => {
  test('warning parent does NOT skip children', async () => {
    let childRan = false;
    const nodes: CheckNode[] = [
      {
        check: {
          label: 'WARN_PARENT',
          severity: 'warn',
          fn: () => ({
            message: 'warning only',
            pass: false,
          }),
        },
        children: [
          {
            check: {
              label: 'CHILD',
              fn: () => {
                childRan = true;
                return {pass: true};
              },
            },
          },
        ],
      },
    ];

    const exitCode = await runCheckTree(nodes, {quiet: true});
    expect(childRan).toBe(true);
    expect(exitCode).toBe(0); // Warnings don't affect exit code
  });

  test('error parent DOES skip children', async () => {
    let childRan = false;
    const nodes: CheckNode[] = [
      {
        check: {
          label: 'ERROR_PARENT',
          fn: () => ({
            message: 'real failure',
            pass: false,
          }),
        },
        children: [
          {
            check: {
              label: 'CHILD',
              fn: () => {
                childRan = true;
                return {pass: true};
              },
            },
          },
        ],
      },
    ];

    const exitCode = await runCheckTree(nodes, {quiet: true});
    expect(childRan).toBe(false);
    expect(exitCode).toBe(1);
  });

  test('sibling warn does not affect a passing sibling', async () => {
    let siblingRan = false;
    const nodes: CheckNode[] = [
      {
        check: {
          label: 'WARN_SIBLING',
          severity: 'warn',
          fn: () => ({message: 'warn', pass: false}),
        },
      },
      {
        check: {
          label: 'OTHER',
          fn: () => {
            siblingRan = true;
            return {pass: true};
          },
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {quiet: true});
    expect(siblingRan).toBe(true);
    expect(exitCode).toBe(0);
  });
});
