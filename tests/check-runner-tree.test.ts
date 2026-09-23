/**
 * Tests for tree-walking behavior: child checks should only be skipped
 * when their parent fails with error severity, not warn severity.
 */

import type {CheckNode} from '../src/check-runner';

import {describe, expect, test} from 'bun:test';

import {runCheckTree} from '../src/check-runner';

describe('check-runner tree walking', () => {
  test('warning parent does NOT skip children', async () => {
    let childRan = false;
    const nodes: CheckNode[] = [
      {
        check: {
          fn: () => ({
            message: 'warning only',
            pass: false,
          }),
          label: 'WARN_PARENT',
          severity: 'warn',
        },
        children: [
          {
            check: {
              fn: () => {
                childRan = true;
                return {pass: true};
              },
              label: 'CHILD',
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
          fn: () => ({
            message: 'real failure',
            pass: false,
          }),
          label: 'ERROR_PARENT',
        },
        children: [
          {
            check: {
              fn: () => {
                childRan = true;
                return {pass: true};
              },
              label: 'CHILD',
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
          fn: () => ({message: 'warn', pass: false}),
          label: 'WARN_SIBLING',
          severity: 'warn',
        },
      },
      {
        check: {
          fn: () => {
            siblingRan = true;
            return {pass: true};
          },
          label: 'OTHER',
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {quiet: true});
    expect(siblingRan).toBe(true);
    expect(exitCode).toBe(0);
  });
});
