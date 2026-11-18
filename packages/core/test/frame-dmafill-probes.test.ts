// A DMA fill's source temp is published: its address is stored to the device's source register
// (`*(vu32 *)REG_DMA3SAD = (u32)&tmp`), and the device reads it. These rest on a committed agbcc
// probe (`scripts/regen-outgoing-area-probes.ts`, `corpus/agbcc-dmafill.s`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmafill.s'), 'utf8');

const source = (fn: string): string => asm.slice(asm.indexOf(`${fn}:`), asm.indexOf('.Lfe', asm.indexOf(`${fn}:`)));
const lines = (fn: string): string[] =>
  source(fn)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const DECLARED = {
  g: { params: [], returnsVoid: true },
  k: { params: [], returnsVoid: true },
  use: { params: ['u32 *'], returnsVoid: true },
  h: { params: ['s32'], returns: 'u16' },
};
const lift = (fn: string, prototypes = {}) => decompile(fn, source(fn), ARMV4T_AGBCC, { prototypes }).source;

// The device register's address is a pool constant, loaded into a register that holds a frame
// address elsewhere in the same function. That register is no frame address AT THE STORE, so the
// store hands the temp's address out of the frame (thumb.ts `frameAddressReceivers`, over
// `frameAddressesAt`'s per-store `may`).
describe('a publish through a register that holds a frame address elsewhere', () => {
  test('dcall: r0 is the device register at the publish and `&w` at the call', () => {
    const dcall = lines('dcall');
    expect(dcall.slice(dcall.indexOf('ldr\tr0, .L3'), dcall.indexOf('ldr\tr0, .L3') + 3)).toEqual([
      'ldr\tr0, .L3',
      'mov\tr1, sp',
      'str\tr1, [r0]',
    ]);
    expect(dcall).toContain('add\tr0, sp, #0x4');
    const out = lift('dcall', DECLARED);
    expect(out).toContain('*(volatile s32 *)67109076 = sp0;');
    expect(out).toContain('use((u32)sp0 + 4);');
  });

  test('dpaths: two fills on two paths, each publishing through a pool-loaded base', () => {
    const out = lift('dpaths', DECLARED);
    expect(out).toContain('*(volatile s32 *)67109076 = sp0;');
    expect(out).toContain('*(volatile s32 *)67109076 = (u32)sp0 + 4;');
    expect(out).toContain('    k();\n');
  });

  // not only a pool constant: a pointer loaded from a global, or a call's result, in the register
  // that holds `&w` at the later call, is no frame address at the publish either. The store is read
  // as the publish it is, so the temp's word is no argument staged for `g`; what then declines is
  // the audit's question of who reads a published address nothing declares — a device's source
  // register is declared (`dcall`), `*gDst` is not.
  test('dglob, dret: a loaded pointer and a returned one are bases outside the frame', () => {
    expect(lines('dglob').slice(5, 9)).toEqual(['ldr\tr0, .L20', 'ldr\tr0, [r0]', 'mov\tr1, sp', 'str\tr1, [r0]']);
    expect(lines('dret').slice(5, 8)).toEqual(['bl\tdst', 'mov\tr1, sp', 'str\tr1, [r0]']);
    const dst = { dst: { params: [], returns: 'u32' } };
    for (const fn of ['dglob', 'dret']) {
      expect(() => lift(fn, { ...DECLARED, ...dst })).toThrow(
        /the address is published rather than passed as an argument, and nothing declares what reads it/,
      );
    }
  });

  // the control: the same register holding a frame address AT the store writes the address into
  // this frame, which publishes nothing, and the unread word still declines
  test('a base that is a frame address at the store publishes nothing', () => {
    const intoFrame = [
      'push {lr}',
      'add sp, sp, #-0x8',
      'mov r0, #0x0',
      'str r0, [sp]',
      'ldr r0, .L3',
      'add r0, sp, #0x4',
      'mov r1, sp',
      'str r1, [r0]',
      'bl g',
      'add sp, sp, #0x8',
      'pop {r0}',
      'bx r0',
      '.L3:',
      '.word 0x40000d4',
    ].join('\n');
    expect(() => decompile('f', intoFrame, ARMV4T_AGBCC, { prototypes: DECLARED })).toThrow(
      /the store to \[sp,#0\] is never reloaded/,
    );
  });
});

// The frame base published (`mov r0, sp / str r0, [r3]`) in a frame wider than one word, with a
// call after it: [sp,#0] is the temp, so it is the object's and no SSA slot (thumb.ts
// `frameBasePublished`). agbcc puts such a temp at [sp,#0] only where no call takes a stack word.
describe('a published frame base is a local, at any frame size', () => {
  test('dtwo: two fills, the first at [sp,#0], then a call nothing declares, lifts', () => {
    expect(lines('dtwo').slice(0, 7)).toEqual([
      'dtwo:',
      'push\t{r4, lr}',
      'add\tsp, sp, #-0x8',
      'mov\tr2, #0x0',
      'str\tr2, [sp]',
      'ldr\tr3, .L14',
      'mov\tr0, sp',
    ]);
    const out = lift('dtwo');
    expect(out).toContain('    volatile u32 sp0;\n    volatile u32 sp4;\n    sp0 = 0;\n');
    expect(out).toContain('= &sp0;');
    expect(out).toContain('= &sp4;');
  });

  test('dfive: beside a fifth argument agbcc moves the temp above it, and stages [sp,#0] after', () => {
    const dfive = lines('dfive');
    expect(dfive).toContain('add\tr2, sp, #0x4');
    expect(dfive).not.toContain('mov\tr0, sp');
    expect(dfive.indexOf('str\tr0, [sp]')).toBeGreaterThan(dfive.indexOf('add\tr2, sp, #0x4'));
    const five = { five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true } };
    expect(lift('dfive', five)).toContain('    five(1, 2, 3, 4, a0);\n');
    expect(() => lift('dfive')).toThrow(/the store to \[sp,#0\] is never reloaded/);
  });

  // the controls: a word staged at [sp,#0] after the frame base is published reaches its call
  // pending
  const restaged = [
    'push {r4, lr}',
    'add sp, sp, #-0x8',
    'mov r2, #0x0',
    'str r2, [sp]',
    'ldr r3, .L3',
    'mov r0, sp',
    'str r0, [r3]',
    'str r1, [sp]',
    'mov r0, #0x1',
    'mov r1, #0x2',
    'mov r2, #0x3',
    'mov r3, #0x4',
    'bl five',
    'add sp, sp, #0x8',
    'pop {r4}',
    'pop {r0}',
    'bx r0',
    '.L3:',
    '.word 0x40000d4',
  ].join('\n');
  test('a word staged at the published base after the publish declines, undeclared', () => {
    expect(() => decompile('f', restaged, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] reaches `bl five` unread/);
  });

  test('…and declared, its argument word and the published object are the same word', () => {
    const five = { five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true } };
    expect(() => decompile('f', restaged, ARMV4T_AGBCC, { prototypes: five })).toThrow(
      /the frame address \[sp,#0\] escapes this function/,
    );
  });
});
