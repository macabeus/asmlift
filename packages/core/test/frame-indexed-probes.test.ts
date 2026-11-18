// A load through a runtime index into a frame array is read by the outgoing-argument analysis as an
// `indexed-read` event (frontend/stackargs.ts), based where the index is added. Where the source
// indexes the array it names, that base is the array's start or inside it; a pointer formed below
// the array (`a - 1`) bases it beneath, where a staged argument may sit, so the area's bound is
// lowered only where every store it would clear reaches the read first (`loadedWordBound`). Both
// rest on a committed agbcc probe (`scripts/regen-outgoing-area-probes.ts`, `corpus/agbcc-indexed.s`)
// showing where agbcc puts the constant of `a[i - 1]`, of an array above [sp,#0], and of `a - 1`.
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

describe('agbcc bases a read that indexes its own array at the array', () => {
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

// A pointer the source forms BELOW its array — `u32 *p = a - 1` or `&a[-1]`, the 1-based table
// idiom — bases its read beneath the array, at [sp,#0], where a K&R call's stack argument is
// staged. The read then proves nothing about [sp,#0], and a call nothing sizes keeps the decline.
describe('a read based below its array is no proof of a local', () => {
  test('agbcc bases `(a - 1)[i]` at sp, with the array at [sp,#4]', () => {
    const below1 = lines('below1');
    expect(below1).toEqual(expect.arrayContaining(['mov\tr2, sp', 'str\tr1, [sp, #0x4]', 'add\tr0, r0, r2']));
  });

  test('and computes every argument before it stages the last stack word', () => {
    // below3: `p[i]` is argument 4, loaded before argument 5 is staged; below4 the same under `?:`
    for (const fn of ['below3', 'below4']) {
      const l = lines(fn);
      expect(l.indexOf('str\tr0, [sp]')).toBeGreaterThan(l.indexOf('ldr\tr3, [r0]'));
    }
    // below5: argument 5 is staged, then argument 6 is read and staged after it
    const below5 = lines('below5');
    expect(below5.indexOf('str\tr0, [sp, #0x4]')).toBeGreaterThan(below5.indexOf('str\tr1, [sp]'));
  });

  test('a call nothing sizes keeps its stack arguments', () => {
    for (const fn of ['below1', 'below2', 'below3', 'below4', 'below5', 'below6']) {
      expect(() => lift(fn)).toThrow(/the store to \[sp,#[04]\]/);
    }
  });
});
