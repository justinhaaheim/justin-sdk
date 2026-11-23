/**
 * scripts/symbolize-bun-sample.ts (home-base-ejsq2.6): its offsets are trusted
 * only for a profile build of the very same link, and it names only the
 * frames atos named.
 *
 * What these tests hold it to:
 *  - It refuses on a different LC_UUID, on a __TEXT section that moved or
 *    changed size, and on different bytes, and says which check failed.
 *  - It accepts only when all three match, and reports the byte range it hashed.
 *  - It collects each distinct bun frame by load address, and rewrites only
 *    those frames, keeping a frame atos could not name as it was.
 */
import {describe, expect, test} from 'bun:test';

import {
  annotate,
  bunFrames,
  compareBuilds,
  parseTextSections,
  parseUuid,
} from '../scripts/symbolize-bun-sample';

function otool(uuid: string, textSize: string): string {
  return `Load command 0
      cmd LC_SEGMENT_64
  cmdsize 712
  segname __TEXT
Section
  sectname __text
   segname __TEXT
      addr 0x0000000100000a80
      size ${textSize}
    offset 2688
Section
  sectname __const
   segname __TEXT
      addr 0x0000000100002000
      size 0x0000000000000100
    offset 8192
Section
  sectname __data
   segname __DATA
      addr 0x0000000104000000
      size 0x0000000000000010
    offset 67108864
Load command 9
     cmd LC_UUID
 cmdsize 24
    uuid ${uuid}
`;
}

const UUID = '4C4C447C-5555-3144-A138-DBD9C49417A3';

describe('the build check', () => {
  test('otool output parses: the uuid, and only the __TEXT sections', () => {
    const text = otool(UUID, '0x0000000000001000');
    expect(parseUuid(text)).toBe(UUID);
    expect(parseTextSections(text).map((section) => section.name)).toEqual([
      '__text',
      '__const',
    ]);
  });

  test('the same uuid, sections and bytes: accepted, with the range it hashed', () => {
    const hashed: string[] = [];
    const verdict = compareBuilds({
      hashRange: (which, start, end) => {
        hashed.push(`${which} ${start}..${end}`);
        return 'same';
      },
      installedOtool: otool(UUID, '0x0000000000001000'),
      profileOtool: otool(UUID, '0x0000000000001000'),
    });
    expect(verdict).toEqual({
      byteRange: {end: 8448, start: 2688},
      ok: true,
      uuid: UUID,
    });
    expect(hashed).toEqual(['installed 2688..8448', 'profile 2688..8448']);
  });

  test('a different uuid: refused, before any byte is hashed', () => {
    const verdict = compareBuilds({
      hashRange: () => {
        throw new Error('must not hash');
      },
      installedOtool: otool(UUID, '0x0000000000001000'),
      profileOtool: otool(
        '00000000-0000-0000-0000-000000000000',
        '0x0000000000001000',
      ),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.why).toContain('LC_UUID differs');
  });

  test('a __TEXT section of another size: refused, naming the section', () => {
    const verdict = compareBuilds({
      hashRange: () => 'same',
      installedOtool: otool(UUID, '0x0000000000001000'),
      profileOtool: otool(UUID, '0x0000000000001004'),
    });
    expect(verdict.ok ? '' : verdict.why).toContain('__TEXT,__text differs');
  });

  test('the same layout but different bytes: refused', () => {
    const verdict = compareBuilds({
      hashRange: (which) => which,
      installedOtool: otool(UUID, '0x0000000000001000'),
      profileOtool: otool(UUID, '0x0000000000001000'),
    });
    expect(verdict.ok ? '' : verdict.why).toContain('bytes 2688..8448 differ');
  });
});

describe('the frames', () => {
  const sample = [
    '    + 10 ???  (in bun)  load address 0x1044bc000 + 0x10bd420  [0x105579420]',
    '    +   10 ???  (in bun)  load address 0x1044bc000 + 0x1496dc0  [0x105952dc0]',
    '    +     4 ???  (in bun)  load address 0x1044bc000 + 0x10bd420  [0x105579420]',
    '    +     6 ???  (in <unknown binary>)  [0x10d2dc8a8]',
    '    +     2 ???  (in bun)  load address 0x1044bc000 + 0x9  [0x1044bc009]',
  ].join('\n');

  test('each distinct bun frame, by load address', () => {
    expect([...bunFrames(sample)]).toEqual([
      ['0x1044bc000', ['0x105579420', '0x105952dc0', '0x1044bc009']],
    ]);
  });

  test('named frames are rewritten with their offset; others are left as they were', () => {
    const names = new Map([
      ['0x105579420', 'BunObject_callback_spawnSync (in bun-profile) + 116'],
      ['0x105952dc0', 'spawn_sync (in bun-profile) + 60'],
    ]);
    expect(annotate(sample, names).split('\n')).toEqual([
      '    + 10 BunObject_callback_spawnSync (in bun-profile) + 116  [bun +0x10bd420]',
      '    +   10 spawn_sync (in bun-profile) + 60  [bun +0x1496dc0]',
      '    +     4 BunObject_callback_spawnSync (in bun-profile) + 116  [bun +0x10bd420]',
      '    +     6 ???  (in <unknown binary>)  [0x10d2dc8a8]',
      '    +     2 ???  (in bun)  load address 0x1044bc000 + 0x9  [0x1044bc009]',
    ]);
  });
});
