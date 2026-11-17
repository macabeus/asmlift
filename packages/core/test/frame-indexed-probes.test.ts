// A load through a runtime index into a frame array is read by the outgoing-argument analysis as an
// `indexed-read` event (frontend/stackargs.ts), based where the index is added: the words from that
// base up are a local's, so none is any call's argument. A base BELOW the array would name a word
// the array does not own, possibly a staged argument, and drop it from its call; so the reading
// rests on a committed agbcc probe (`scripts/regen-outgoing-area-probes.ts`, `corpus/agbcc-indexed.s`)
// showing where agbcc puts the constant of `a[i - 1]` and of an array above [sp,#0].
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-indexed.s'), 'utf8');

const source = (fn: string): string => asm.slice(asm.indexOf(`${fn}:`), asm.indexOf('.Lfe', asm.indexOf(`${fn}:`)));
const lines = (fn: string): string[] =>
  source(fn)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const words = (n: number) => Array.from({ length: n }, () => 's32');
const FIVE = { five: { params: words(5), returnsVoid: true } };
const SIX = { six: { params: words(6), returnsVoid: true } };
const lift = (fn: string, prototypes = {}) => decompile(fn, source(fn), ARMV4T_AGBCC, { prototypes }).source;

describe('agbcc bases an indexed frame read at the array, never below it', () => {
  test('im1, six3: the constant of `a[i - 1]` stays in the index, and the array’s offset follows it', () => {
    const im1 = lines('im1');
    expect(im1.slice(im1.indexOf('sub\tr0, r0, #0x1'), im1.indexOf('ldr\tr3, [r0]') + 1)).toEqual([
      'sub\tr0, r0, #0x1',
      'lsl\tr0, r0, #0x2',
      'add\tr0, r0, sp',
      'add\tr0, r0, #0x4',
      'ldr\tr3, [r0]',
    ]);
    const six3 = lines('six3');
    expect(six3).toContain('sub\tr1, r1, #0x1');
    expect(six3.filter((l) => l === 'add\tr0, r0, #0x8')).toHaveLength(2);
  });

  test('six1: [sp,#0] is staged BETWEEN two reads, each based at the array above it', () => {
    const six1 = lines('six1');
    const staged = six1.indexOf('str\tr2, [sp]');
    expect(six1.slice(staged - 3, staged)).toEqual(['add\tr0, r0, sp', 'add\tr0, r0, #0x8', 'ldr\tr0, [r0]']);
    expect(six1.slice(staged + 1, staged + 5)).toEqual([
      'lsl\tr1, r1, #0x2',
      'add\tr1, r1, sp',
      'add\tr1, r1, #0x8',
      'ldr\tr1, [r1]',
    ]);
  });

  test('bytes, members: a byte array and a struct member add their offset after the index too', () => {
    expect(lines('bytes')).toEqual(expect.arrayContaining(['mov\tr1, sp', 'add\tr1, r1, r0', 'add\tr1, r1, #0x4']));
    // `p[i].y`: based at the member, inside the array at [sp,#4]
    expect(lines('members')).toEqual(expect.arrayContaining(['add\tr1, sp, #0x8', 'add\tr1, r1, r0']));
  });
});

describe('so a word staged beneath an indexed read is still an argument, and the read is a local', () => {
  test('ix: an array read only on some trips of a loop, then a call, lifts', () => {
    const out = lift('ix', {
      use: { params: ['u32', 's32'], returnsVoid: true },
      rng: { params: [], returnsVoid: true },
    });
    expect(out).toContain('use(((s32 *)sp0)[v0], v0)');
    expect(out).toContain('rng();');
  });

  test('declared, every staged word reaches its call', () => {
    expect(lift('im1', FIVE)).toContain('five(1, 2, 3, p0[a0 - 1], gC);');
    expect(lift('six1', SIX)).toContain('six(p0[a0], 2, 3, 4, v0, p0[a1]);');
    expect(lift('six2', SIX)).toContain('six(gI, 2, 3, 4, p0[a1], v0 + p0[a0]);');
    expect(lift('six3', SIX)).toContain('six(gI, p0[a0 + 1], 3, p0[a1 - 1], v1, v0);');
    expect(lift('bytes', FIVE)).toContain('five(1, 2, 3, p0[a0], p0[a0 + 2]);');
  });

  test('undeclared, the staged word is no local the read proves, and the lift declines', () => {
    for (const fn of ['im1', 'six1', 'six2', 'six3', 'bytes']) {
      expect(() => lift(fn)).toThrow(/the store to \[sp,#0\]/);
    }
  });

  // `p[0].x` at [sp,#4] lies below the read's base (`p[i].y`, [sp,#8]) and nothing reads it by its
  // offset: a dead member and a sixth argument are the same code there
  test('members: a word below the read’s base is still asked', () => {
    expect(() => lift('members', FIVE)).toThrow(/\[sp,#4\] also reaches the call unread/);
  });
});
