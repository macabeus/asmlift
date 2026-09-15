// A real row's `build()` publishes only the function `bench vendor` proved against the ROM: a target whose
// digest is not the row's `romDigest` is refused, naming the row and its unit.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { RealFunction } from '../src/cases/manifests';
import { romTarget } from '../src/cases/real';
import { targetDigest } from '../src/cases/rom-function';
import { elf32 } from './elf32';

const object = (text: number[]) =>
  elf32({ machine: 40, littleEndian: true, textAddr: 0, text, symbols: [{ name: 'f', value: 1, size: text.length }] });

describe('romTarget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rom-target-'));
  const proved = object([0x01, 0x30, 0x70, 0x47]);
  const row = { sym: 'f', unit: 'src/f.c', romDigest: targetDigest(proved, 'f') } as RealFunction;

  test('the proved target is published as built', () => {
    writeFileSync(join(dir, 'proved.o'), proved);
    const built = { obj: join(dir, 'proved.o'), asm: 'asm' };
    expect(romTarget('p:f:agbcc', row, 'agbcc', built)).toBe(built);
  });

  test('any other target is refused, naming the row and its unit', () => {
    writeFileSync(join(dir, 'other.o'), object([0x02, 0x30, 0x70, 0x47]));
    expect(() => romTarget('p:f:agbcc', row, 'agbcc', { obj: join(dir, 'other.o'), asm: 'asm' })).toThrow(
      /^p:f:agbcc: the target built in unit src\/f.c by agbcc is not the function the ROM holds/,
    );
  });
});
