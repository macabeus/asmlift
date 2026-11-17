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
// store hands the temp's address out of the frame (thumb.ts `storesThroughAPoolConstant`).
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
