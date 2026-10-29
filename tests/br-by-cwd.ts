/**
 * A `br` that is a different br in each checkout, the way mise makes it
 * (home-base-dj5m9.1.6 F1): mise runs the br the nearest mise.toml above the
 * cwd pins, so a linked worktree and its primary checkout can run two brs.
 * Every other real-br test puts ONE br first on PATH, which cannot show the
 * SDK deciding with one br and running another.
 *
 * The stand-in `br` here walks up from its cwd to the nearest `.test-br` file
 * and runs the binary that file names, logging the cwd and the arguments of
 * each call. Tests pin a checkout with `pin(checkout, brPath)`.
 */

import type {Sandbox} from './sandbox';

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {delimiter, join} from 'path';

export interface BrByCwd {
  /** Every call so far: the cwd it ran in and its arguments. */
  calls: () => {args: string; cwd: string}[];
  /** PATH with the stand-in first. */
  path: string;
  /** Make `checkout` (and every directory below it without a pin of its own) run `br`. */
  pin: (checkout: string, br: string) => void;
}

export function brByCwd(sb: Sandbox): BrByCwd {
  const bin = join(sb.path, 'br-by-cwd');
  mkdirSync(bin, {recursive: true});
  const log = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'br'),
    [
      '#!/bin/sh',
      'dir=$(pwd -P)',
      'while :; do',
      '  if [ -f "$dir/.test-br" ]; then',
      `    printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${log}'`,
      '    exec "$(cat "$dir/.test-br")" "$@"',
      '  fi',
      '  [ "$dir" = "/" ] && break',
      '  dir=$(dirname "$dir")',
      'done',
      'echo "no .test-br pin above $(pwd -P)" >&2',
      'exit 127',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'br'), 0o755);
  return {
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => {
              const [cwd = '', args = ''] = line.split('\t');
              return {args, cwd};
            })
        : [],
    path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    pin: (checkout, br) => {
      writeFileSync(join(checkout, '.test-br'), br);
    },
  };
}

/** Run `fn` with PATH set to `path`, then put PATH back. */
export function withPath<T>(path: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}
