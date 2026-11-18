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

// A by-value struct's register words are loaded AFTER the call's stack words are stored (agbcc
// calls.c `move_block_to_reg`, and the stack part of a struct split between r3 and the stack), so a
// read through a pointer formed below its array can run between a staged word's store and its call.
// The read clears nothing above the highest word stored on its way to such a call, and nothing at
// all where that path stores no word (`thumb.ts` `indexedReadBelow`).
describe('a read after a call’s last staged word clears nothing', () => {
  test('agbcc stages the stack words, then loads the struct’s register words through the index', () => {
    for (const [fn, staged] of [
      ['blk1', 'str\tr0, [sp]'],
      ['blk2', 'str\tr0, [sp, #0x4]'],
      ['blk3', 'str\tr0, [sp]'],
    ] as const) {
      const l = lines(fn);
      const last = l.lastIndexOf(staged);
      expect(last).toBeGreaterThan(0);
      expect(l.slice(last + 1).filter((x) => /^ldr\tr[0-3], \[r[0-3](, #0x[48])?\]$/.test(x)).length).toBeGreaterThan(
        1,
      );
      expect(l.slice(last + 1).some((x) => x.startsWith('str'))).toBe(false);
    }
  });

  // Reload's spill of an indirect call's address (`prepare_call_address`, under register pressure):
  // agbcc DOES store a frame word after the call's last staged word and after the struct's reads,
  // and loads it straight back into the register the call goes through. A word loaded back is a
  // local's, so that store raises no read's ceiling.
  test('fpspill: agbcc stores and reloads a frame word between the last staged word and the call', () => {
    const l = lines('fpspill');
    const call = l.indexOf('bl\t_call_via_r4');
    const staged = l.lastIndexOf('str\tr0, [sp]');
    const window = l.slice(staged + 1, call);
    expect(window.slice(0, 2)).toEqual(['ldr\tr2, [r1]', 'ldr\tr3, [r1, #0x4]']);
    expect(window).toContain('str\tr0, [sp, #0x48]');
    expect(window.at(-1)).toBe('ldr\tr4, [sp, #0x48]');
    expect(() => lift('fpspill')).toThrow(/stack pointer used as data|address-taken stack local/);
  });

  test('and a call nothing sizes keeps its stack arguments', () => {
    for (const fn of ['blk1', 'blk2', 'blk3']) {
      expect(() => lift(fn)).toThrow(/the store to \[sp,#0\]/);
    }
  });
});

// Both readings of an indexed read rest on agbcc's staging order, a field of its own
// (`target.ts` `stagedStackWordReachesOnlyItsCall`), not on the escape premise beside it.
describe('the staging order is a declared premise', () => {
  const NO_ORDER = {
    ...ARMV4T_AGBCC,
    compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, stagedStackWordReachesOnlyItsCall: undefined },
  };
  const USE = { use: { params: ['u32', 's32'], returnsVoid: true }, rng: { params: [], returnsVoid: true } };

  test('without it, an array read only through an index is unread by offset, and the lift declines', () => {
    expect(() => decompile('ix', source('ix'), NO_ORDER, { prototypes: USE })).toThrow(/stack pointer used as data/);
  });

  // A local's word stored after the read and loaded back is no staged word, so it raises no
  // ceiling: the read clears nothing, and [sp,#0] keeps the refusal. At any width, through a
  // capture, after the call, or on every trip of a loop, the store is a local's.
  test('blk1 with a local stored after the read and loaded back declines', () => {
    const m3 = '\tmov\tr3, #0x3\n';
    const spilled = (src: string, at: string, text: string): string => {
      expect(src).toContain(at);
      return src.replace(at, at + text);
    };
    for (const text of [
      '\tstr\tr3, [sp, #0x14]\n\tldr\tr3, [sp, #0x14]\n',
      '\tstr\tr3, [sp, #0x18]\n\tldr\tr3, [sp, #0x18]\n',
      '\tstr\tr3, [sp, #0x14]\n\tldrh\tr3, [sp, #0x16]\n',
      '\tstr\tr3, [sp, #0x14]\n\tadd\tr3, sp, #0x14\n\tldr\tr3, [r3]\n',
      '\tmov\tr12, r3\n.LX:\n\tstr\tr3, [sp, #0x14]\n\tldr\tr3, [sp, #0x14]\n\tsub\tr3, r3, #0x1\n\tcmp\tr3, #0\n\tbne\t.LX\n\tmov\tr3, r12\n',
    ]) {
      const src = spilled(source('blk1'), m3, text);
      expect(() => decompile('blk1', src, ARMV4T_AGBCC, { prototypes: {} })).toThrow(/stack pointer used as data/);
    }
    const afterRead = spilled(source('blk1'), '\tldr\tr0, [r2]\n', '\tstr\tr0, [sp, #0x14]\n\tldr\tr0, [sp, #0x14]\n');
    expect(() => decompile('blk1', afterRead, ARMV4T_AGBCC, { prototypes: {} })).toThrow(/the store to \[sp,#0\]/);
    const reloadedPastCall = spilled(
      spilled(source('blk1'), m3, '\tstr\tr3, [sp, #0x14]\n'),
      '\tbl\tkr\n',
      '\tldr\tr1, [sp, #0x14]\n\tadd\tr0, r0, r1\n',
    );
    expect(() => decompile('blk1', reloadedPastCall, ARMV4T_AGBCC, { prototypes: {} })).toThrow(
      /the store to \[sp,#0\]/,
    );
    const blk2 = spilled(source('blk2'), m3, '\tstr\tr3, [sp, #0x18]\n\tldr\tr3, [sp, #0x18]\n');
    expect(() => decompile('blk2', blk2, ARMV4T_AGBCC, { prototypes: {} })).toThrow(/the store to \[sp,#0\]/);
  });

  test('below3 with its last stack word staged before the read declines: nothing is stored after the read', () => {
    const staged = '\tldr\tr0, .L36+0xc\n\tldr\tr0, [r0]\n\tstr\tr0, [sp]\n';
    const read = '\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r2\n\tldr\tr3, [r0]\n';
    const swapped = source('below3').replace(read + staged, staged.replaceAll('r0', 'r1') + read);
    expect(swapped).not.toBe(source('below3'));
    expect(() => decompile('below3', swapped, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\]/);
  });
});
