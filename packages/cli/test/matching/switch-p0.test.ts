// P0 soundness for the switch/jump-table work. Each
// case locks a place where a computed/indirect jump could be SILENTLY MISCOMPILED instead of
// loud-failing — the loud-fail invariant.
// Native/offline only (hand-written asm + the compiler helpers; no Docker).
import { type Block, type Fn, mkOp, mkValue } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { decompile } from '@asmlift/core/pipeline';
import { StructureError, structure } from '@asmlift/core/structure/structure';
import { ARMV4T_AGBCC, MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

describe('P0-a — Thumb computed-PC writes loud-fail; return-form PC writes still work', () => {
  // A dense switch on agbcc dispatches via `mov pc, rN` (an indirect jump; the target array is in
  // the .word table). Treating `mov pc` as a write to a phantom `pc` register silently drops the
  // whole switch — the function returns case 0's value for EVERY in-range input. It must recover
  // to a correct `switch` (switch-p2.test.ts pins the byte-match); here we assert the miscompile
  // shape is gone.
  test('agbcc dense switch recovers to a switch (never a silent return 3)', () => {
    const asm = compileTargetAsm(
      'int sw_big(int x){ switch(x){case 0:return 3;case 1:return 5;case 2:return 7;case 3:return 9;' +
        'case 4:return 11;case 5:return 13;case 6:return 15;case 7:return 17;default:return -1;} }',
    );
    const src = decompile('sw_big', asm, ARMV4T_AGBCC).source;
    expect(src).toContain('switch (');
    expect(src).toContain('case 7:');
  });

  // A hand-written `mov pc, rN` with NO recoverable jump table (no bounds check / no .word table) still
  // loud-fails — the P0 guard for an unrecognised computed jump (P2 recovers only the exact agbcc idiom).
  test('mov pc, rN with no recoverable table loud-fails', () => {
    const asm = ['f:', '\tlsl r0, r0, #2', '\tldr r0, [r1]', '\tmov pc, r0'].join('\n');
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/indirect\/computed jump/);
  });

  // `ldr pc, [..]` (loaded PC write) also loud-fails.
  test('ldr pc, [..] loud-fails', () => {
    const asm = ['f:', '\tldr pc, [r0]'].join('\n');
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/indirect\/computed jump/);
  });

  // `pop {…, pc}` is agbcc's RETURN idiom (restores the saved LR into PC), NOT a computed jump.
  // It must be a clean return — here `return a0 + 1`, never a loud-fail and never a dropped return.
  test('pop {r4, pc} is a return, not a computed jump', () => {
    const asm = ['f:', '\tpush {r4, lr}', '\tmov r4, r0', '\tadd r0, r4, #1', '\tpop {r4, pc}'].join('\n');
    const src = decompile('f', asm, ARMV4T_AGBCC).source;
    expect(src).toContain('return a0 + 1');
  });

  // `mov pc, lr` is also a return (restore link register) — must not loud-fail as an indirect jump.
  test('mov pc, lr is a return', () => {
    const asm = ['f:', '\tadd r0, r0, #7', '\tmov pc, lr'].join('\n');
    const src = decompile('f', asm, ARMV4T_AGBCC).source;
    expect(src).toContain('return a0 + 7');
  });
});

describe('P0-b — the structurer fails loud on an unknown (many-way) terminator', () => {
  // Guards the structuring seam: a terminator that is not one of the handled kinds (ret/br/cond_br/
  // switch_br) must throw, not be silently read as a 2-way cond_br (which would drop every successor
  // past the second — a silent control-flow miscompile). Build a minimal Fn with a fictional
  // many-way terminator (`computed_br`, a hypothetical future op) and assert structure() declines loud.
  test('an unknown many-way terminator throws StructureError, not a silent 2-way read', () => {
    const entry: Block = { params: [], ops: [] };
    const c0: Block = { params: [], ops: [mkOp('ret', { operands: [] })] };
    const c1: Block = { params: [], ops: [mkOp('ret', { operands: [] })] };
    const c2: Block = { params: [], ops: [mkOp('ret', { operands: [] })] };
    const scrut = mkValue(T.unk(32));
    entry.ops.push(mkOp('const', { results: [scrut], attrs: { value: 0 } }));
    entry.ops.push(
      mkOp('computed_br' as Parameters<typeof mkOp>[0], {
        // deliberately unregistered (hostile probe)
        operands: [scrut],
        successors: [c0, c1, c2].map((block) => ({ block, args: [] })),
      }),
    );
    const fn: Fn = { name: 'sw', blocks: [entry, c0, c1, c2] };
    expect(() => structure(fn)).toThrow(StructureError);
    expect(() => structure(fn)).toThrow(/unsupported terminator 'computed_br'/);
  });
});

describe('P0-c — a dangling branch target loud-fails cleanly, not as an internal verify crash', () => {
  // A MIPS jump table / indirect jump already loud-fails at the `jr <non-ra>` guard — keep that pinned
  // (the MIPS counterpart of the Thumb `mov pc` fix; the asymmetry the whole plan is built on).
  test('MIPS dense switch (jr $reg) still loud-fails', () => {
    const { asm } = compileMipsTarget(
      'int sw_big(int x){ switch(x){case 0:return 3;case 1:return 5;case 2:return 7;case 3:return 9;' +
        'case 4:return 11;case 5:return 13;case 6:return 15;case 7:return 17;default:return -1;} }',
      'sw_big',
    );
    expect(() => decompile('sw_big', asm, MIPS_IDO)).toThrow(/indirect jump|jump tables/);
  });
});
