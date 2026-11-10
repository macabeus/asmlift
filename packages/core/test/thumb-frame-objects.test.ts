// `incoming stack arguments (AAPCS args 5+)` is one describe spread over three files, each
// re-opening it under the same name so every test keeps its describe chain:
// thumb-stack-args.test.ts (the incoming words and the register arguments beside them),
// thumb-frontend.test.ts (the frame-slot model), thumb-frame-objects.test.ts (frame objects and
// device accesses). This file holds frame objects: an address-taken local, device accesses, minted names and the audit.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';
import { dc } from './helpers';

describe('incoming stack arguments (AAPCS args 5+)', () => {
  test('an address-taken frame local becomes a declared object whose address is a value', () => {
    // The DMA-fill idiom: `DmaFill16` expands to `vu16 tmp = v; DmaSet(…, &tmp, …)`, so agbcc
    // stores a halfword through a captured sp and hands the ADDRESS to the DMA source register.
    // `mov rD, sp` lifts to `laddr` — gaddr's local twin — the frame-object audit proves every use,
    // the structurer declares the object with exactly the access type the machine used, and the
    // escaped address is an ordinary value. L3 DCE must NOT reap the store: an address-taken
    // local's stores are observable through the escaped pointer (the hardware reads them).
    const dmaFill =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tmov\tr0, #0\n\tstrh\tr0, [r4]\n' +
      '\tldr\tr2, .L1\n\tmov\tr1, sp\n\tstr\tr1, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\t0x40000D4\n';
    // `volatile` because the address ESCAPES and the source spells it that way — every GBA
    // project's `DMA_FILL` declares the scratch `vu##bit`. gcc keeps the store either way (`&tmp`
    // makes it addressable), so the qualifier is about reproducing the declaration, not about
    // surviving DCE; it still changes register allocation, so it still has to be right.
    expect(decompile('f', dmaFill, ARMV4T_AGBCC).source).toBe(
      's32 f(void) {\n    volatile u16 sp0;\n    sp0 = 0;\n    *(s32 *)67109076 = &sp0;\n    return 0;\n}\n',
    );
    // …and the object co-exists with SSA slots at higher offsets, each model owning its own bytes
    // (the channel's control word says `DMA_SRC_FIXED`, so the device reads the object alone)
    const mixed =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tmov\tr4, sp\n\tstrh\tr1, [r4]\n' +
      '\tldr\tr2, .L1\n\tstr\tr4, [r2]\n\tldr\tr3, .L1+4\n\tstr\tr3, [r2, #0x8]\n\tldr\tr0, [sp, #0x4]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\t0x40000D4\n\t.word\t0x81000001\n';
    const src = decompile('f', mixed, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src).toContain('&sp0');
    expect(src).toContain('return a0;'); // the [sp,#4] slot is still a transparent SSA value
  });

  test('publish-the-address-then-fill: the store after the last &sp0 still survives DCE', () => {
    // The addr-as-read pin only protected stores UPSTREAM of an `&sp0` occurrence in the backward
    // liveness walk, so this legal DMA ordering — publish the address, then fill the object — had
    // its store deleted by asmlift's OWN L3 DCE, defeating the volatile the frontend added
    // precisely so the RECOMPILER would not delete it. A volatile local is never store-eligible.
    const publishThenFill =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tldr\tr2, .L1\n\tmov\tr1, sp\n\tstr\tr1, [r2]\n' +
      '\tmov\tr0, #0\n\tstrh\tr0, [r4]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';
    expect(decompile('f', publishThenFill, ARMV4T_AGBCC).source).toBe(
      's32 f(void) {\n    volatile u16 sp0;\n    *(s32 *)67109076 = &sp0;\n    sp0 = 0;\n    return 0;\n}\n',
    );
  });

  // EVERY DEVICE STORE of a function kept as one object is `volatile`. Verbatim agbcc:
  // `DmaFill16(3, 0, a, n); DmaFill32(3, 0, b, 0x40); DmaFill16(3, 0, c, 0x40);` — the runtime
  // count leaves the first read unbounded over the second fill's temporary. Spelled plain, agbcc
  // deletes the 32-bit fill's three channel stores, overwritten by the third fill's with only a
  // `u16` member store between (compiled: 12 stores in this target, 9 in the plain lift's
  // recompile, 12 in this one's). Each fill's `dmaRegs[2];` read of the control is kept too.
  test('a function kept as one object keeps every device store volatile', () => {
    const threeFills =
      'p3:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr5, sp\n\tmov\tr4, #0x0\n' +
      '\tstrh\tr4, [r5]\n\tldr\tr4, .L3\n\tstr\tr5, [r4]\n\tstr\tr0, [r4, #0x4]\n\tlsr\tr3, r3, #0x1\n' +
      '\tmov\tr0, #0x81\n\tlsl\tr0, r0, #0x18\n\torr\tr3, r3, r0\n\tstr\tr3, [r4, #0x8]\n' +
      '\tldr\tr0, [r4, #0x8]\n\tmov\tr3, #0x0\n\tstr\tr3, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n' +
      '\tstr\tr0, [r4]\n\tstr\tr1, [r4, #0x4]\n\tldr\tr0, .L3+0x4\n\tstr\tr0, [r4, #0x8]\n' +
      '\tldr\tr0, [r4, #0x8]\n\tmov\tr0, sp\n\tstrh\tr3, [r0]\n\tstr\tr0, [r4]\n' +
      '\tstr\tr2, [r4, #0x4]\n\tldr\tr0, .L3+0x8\n\tstr\tr0, [r4, #0x8]\n\tldr\tr0, [r4, #0x8]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
      '\t.word\t0x40000d4\n\t.word\t-0x7afffff0\n\t.word\t-0x7effffe0\n';
    const src = decompile('p3', threeFills, ARMV4T_AGBCC).source;
    expect(src).toContain('    u8 sp0[8];');
    expect(src).not.toMatch(/\(s32 \*\)67109/);
    expect(src.match(/\(volatile s32 \*\)67109076\S* = /g)).toHaveLength(9);
    expect(src.match(/^ +\(\(volatile s32 \*\)67109076\)\[2\];$/gm)).toHaveLength(3);
  });

  // …and every device access, however the lift names the register. Verbatim agbcc, `vu32 *d =
  // (vu32 *)(0x40000B0 + ch * 12)` armed twice with only a `u16` store to the fill's temporary
  // between: spelled plain, the first arm's three stores are deleted (compiled: 15 stores in this
  // target, 12 in the plain lift's recompile, 15 in this one's).
  test('a device register plus a runtime index is a device store too', () => {
    const runtimeChannel =
      'q4:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr3, r2, #0x1\n\tadd\tr3, r3, r2\n' +
      '\tlsl\tr3, r3, #0x2\n\tldr\tr2, .L3\n\tadd\tr3, r3, r2\n\tmov\tr4, sp\n\tmov\tr2, #0x0\n' +
      '\tstrh\tr2, [r4]\n\tmov\tr2, #0x0\n\tstr\tr2, [sp, #0x4]\n\tldr\tr6, .L3+0x4\n' +
      '\tadd\tr2, sp, #0x4\n\tstr\tr2, [r6]\n\tldr\tr5, .L3+0x8\n\tstr\tr1, [r5]\n\tldr\tr4, .L3+0xc\n' +
      '\tldr\tr2, .L3+0x10\n\tstr\tr2, [r4]\n\tldr\tr2, [r4]\n\tmov\tr2, sp\n\tstr\tr2, [r6]\n' +
      '\tstr\tr0, [r5]\n\tldr\tr2, .L3+0x14\n\tstr\tr2, [r4]\n\tstr\tr0, [r3]\n\tstr\tr1, [r3, #0x4]\n' +
      '\tldr\tr5, .L3+0x18\n\tstr\tr5, [r3, #0x8]\n\tmov\tr4, sp\n\tmov\tr2, #0x1\n\tstrh\tr2, [r4]\n' +
      '\tstr\tr1, [r3]\n\tstr\tr0, [r3, #0x4]\n\tstr\tr5, [r3, #0x8]\n\tadd\tsp, sp, #0x8\n' +
      '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000b0\n' +
      '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\t0x40000dc\n\t.word\t-0x7afffff0\n' +
      '\t.word\t-0x7effffe0\n\t.word\t-0x7fffffe0\n';
    const src = decompile('q4', runtimeChannel, ARMV4T_AGBCC).source;
    expect(src).toContain('    u8 sp0[8];');
    expect(src).not.toMatch(/\(struct Elem0 \*\)67109040/);
    expect(src.match(/\(volatile struct Elem0 \*\)67109040\)\[a2\]/g)).toHaveLength(6);
  });

  // …and a frame address handed to a channel chosen at run time reaches that channel's SOURCE
  // register, so the device only reads it and the function is pinned. Verbatim agbcc, `vu32 *d =
  // (vu32 *)(0x40000B0 + ch * 12); tmp = 0; d[0] = &tmp; d[1] = dst; d[2] = 0x81000000 | n; d[2];`:
  // the index is a multiple of the channels' 12-byte stride, so every register it names is a
  // source. Plain, the closing read is used by nothing and not lifted at all.
  test('a frame address handed to a runtime channel is read by the device, and pinned', () => {
    const runtimeFill =
      'fillChN:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tlsl\tr3, r0, #0x1\n' +
      '\tadd\tr3, r3, r0\n\tlsl\tr3, r3, #0x2\n\tldr\tr0, .L6\n\tadd\tr3, r3, r0\n' +
      '\tmov\tr4, sp\n\tmov\tr0, #0x0\n\tstrh\tr0, [r4]\n\tstr\tr4, [r3]\n' +
      '\tstr\tr1, [r3, #0x4]\n\tmov\tr0, #0x81\n\tlsl\tr0, r0, #0x18\n\torr\tr0, r0, r2\n' +
      '\tstr\tr0, [r3, #0x8]\n\tldr\tr0, [r3, #0x8]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n' +
      '\tpop\t{r0}\n\tbx\tr0\n.L7:\n\t.align\t2, 0\n.L6:\n\t.word\t0x40000b0\n';
    const src = decompile('fillChN', runtimeFill, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src).toContain('    ((volatile struct Elem0 *)67109040)[a0].field_8;\n}');
  });

  // …but an index of another stride may name a DESTINATION register, which writes the frame: `((vu32
  // *)0x40000B0)[i] = &tmp` is DMA0SAD at i = 0 and DMA0DAD at i = 1. Verbatim agbcc; the address
  // stays an escape that may write, so nothing is pinned.
  test('a frame address handed through an index of another stride may be written', () => {
    const wordIndexed =
      'fillWord:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tmov\tr3, #0x0\n' +
      '\tstrh\tr3, [r4]\n\tlsl\tr0, r0, #0x2\n\tldr\tr4, .L3\n\tadd\tr3, r0, r4\n' +
      '\tmov\tr4, sp\n\tstr\tr4, [r3]\n\tldr\tr4, .L3+0x4\n\tadd\tr3, r0, r4\n\tstr\tr1, [r3]\n' +
      '\tldr\tr1, .L3+0x8\n\tadd\tr0, r0, r1\n\tmov\tr1, #0x81\n\tlsl\tr1, r1, #0x18\n' +
      '\torr\tr1, r1, r2\n\tstr\tr1, [r0]\n\tldr\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n' +
      '\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000b0\n' +
      '\t.word\t0x40000b4\n\t.word\t0x40000b8\n';
    const src = decompile('fillWord', wordIndexed, ARMV4T_AGBCC).source;
    // no store is pinned; the control read-back nothing uses is kept as a read (frontend/dead-reads.ts)
    expect(src.match(/\(volatile s32 \*\)/g)).toHaveLength(1);
    expect(src).toContain('    ((volatile s32 *)67109048)[a0];\n}');
  });

  // …and a channel chosen by a branch, a phi of two device registers: `d = c ? (vu32 *)0x40000C8 :
  // (vu32 *)0x40000BC` armed twice (compiled: 14 stores in this target, 11 plain, 14 here). DMA1
  // or DMA2, and never DMA3's control halfword, which `addressRangeOf` proves (`[0x40000BC,
  // 0x40000C8]` plus 12 bytes misses 0x40000DE): the two DMA3 transfers each read one object, and
  // the function is accepted object by object, the first three phi stores pinned because the
  // next three overwrite them. With the phi able to pick DMA3 itself (`#0x18`, hand-edited), the stores may
  // re-arm it, the frame is one object, and every phi store is pinned.
  test('a phi of device registers is a device store too', () => {
    const eitherChannel = (step: string) =>
      'q7:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr6, r0, #0\n\tadd\tr5, r1, #0\n' +
      '\tmov\tr1, sp\n\tmov\tr0, #0x0\n\tstrh\tr0, [r1]\n\tldr\tr4, .L5\n\tstr\tr1, [r4]\n' +
      '\tldr\tr3, .L5+0x4\n\tstr\tr6, [r3]\n\tldr\tr1, .L5+0x8\n\tldr\tr0, .L5+0xc\n\tstr\tr0, [r1]\n' +
      '\tldr\tr0, [r1]\n\tmov\tr0, #0x0\n\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r4]\n' +
      '\tstr\tr5, [r3]\n\tldr\tr0, .L5+0x10\n\tstr\tr0, [r1]\n\tldr\tr0, [r1]\n\tsub\tr1, r1, #0x20\n' +
      '\tcmp\tr2, #0\n\tbeq\t.L3\n\tadd\tr1, r1, #' +
      step +
      '\n.L3:\n\tstr\tr6, [r1]\n\tstr\tr5, [r1, #0x4]\n' +
      '\tldr\tr0, .L5+0x14\n\tstr\tr0, [r1, #0x8]\n\tstr\tr5, [r1]\n\tstr\tr6, [r1, #0x4]\n' +
      '\tstr\tr0, [r1, #0x8]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L6:\n' +
      '\t.align\t2, 0\n.L5:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\t0x40000dc\n' +
      '\t.word\t-0x7effffe0\n\t.word\t-0x7afffff0\n\t.word\t-0x7fffffe0\n';
    const split = decompile('q7', eitherChannel('0xc'), ARMV4T_AGBCC).source;
    expect(split).toContain('    volatile u32 sp4;\n    volatile u16 sp0;\n');
    expect(split).toContain('    *(volatile s32 *)v0 = a0;\n    ((volatile s32 *)v0)[1] = a1;\n');
    expect(split).toContain('    *v0 = a1;\n    v0[1] = a0;\n');
    const one = decompile('q7', eitherChannel('0x18'), ARMV4T_AGBCC).source;
    expect(one).toContain('    u8 sp0[8];');
    expect(one.match(/\(volatile s32 \*\)v0/g)).toHaveLength(6);
  });

  // …and a pointer stepped through the channels by a constant is placed by the register it starts
  // at, not by its step. Verbatim agbcc, a fill from a frame temporary and then `vu32 *d = (vu32
  // *)0x40000B0; for (i = 0; i < 4; i++) { d[2] = 0; d[2]; d += 3; }`: the loop's pointer is a phi
  // of 0x40000B0 and itself plus 12, and plain, agbcc forwards the stored 0 to the read.
  test('a device pointer stepped around a loop is placed by where it starts', () => {
    const stepped =
      'stopAll:\n\tadd\tsp, sp, #-0x4\n\tmov\tr2, sp\n\tmov\tr1, #0x0\n\tstrh\tr1, [r2]\n' +
      '\tldr\tr1, .L8\n\tstr\tr2, [r1]\n\tadd\tr1, r1, #0x4\n\tstr\tr0, [r1]\n' +
      '\tadd\tr1, r1, #0x4\n\tldr\tr0, .L8+0x4\n\tstr\tr0, [r1]\n\tldr\tr0, [r1]\n' +
      '\tsub\tr1, r1, #0x2c\n\tmov\tr3, #0x0\n\tmov\tr2, #0x3\n.L6:\n\tstr\tr3, [r1, #0x8]\n' +
      '\tldr\tr0, [r1, #0x8]\n\tadd\tr1, r1, #0xc\n\tsub\tr2, r2, #0x1\n\tcmp\tr2, #0\n' +
      '\tbge\t.L6\t@cond_branch\n\tadd\tsp, sp, #0x4\n\tbx\tlr\n.L9:\n\t.align\t2, 0\n.L8:\n' +
      '\t.word\t0x40000d4\n\t.word\t-0x7efffff0\n';
    const src = decompile('stopAll', stepped, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src).toContain('        v0 = ((volatile s32 *)v1)[2];\n');
  });

  // A device LOAD too: plain, `while (REG_VCOUNT != 160);` is loop-invariant to agbcc, which hoists
  // the `ldrh` and spins on a register copy forever (compiled).
  test('a function kept as one object keeps a device poll volatile', () => {
    const poll =
      'q5:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr5, r2, #0\n\tmov\tr3, sp\n' +
      '\tmov\tr2, #0x0\n\tstrh\tr2, [r3]\n\tldr\tr4, .L7\n\tstr\tr3, [r4]\n\tldr\tr3, .L7+0x4\n' +
      '\tstr\tr0, [r3]\n\tldr\tr2, .L7+0x8\n\tldr\tr0, .L7+0xc\n\tstr\tr0, [r2]\n\tldr\tr0, [r2]\n' +
      '\tmov\tr0, #0x0\n\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r4]\n\tstr\tr1, [r3]\n' +
      '\tldr\tr0, .L7+0x10\n\tstr\tr0, [r2]\n\tldr\tr0, [r2]\n\tmov\tr0, #0x1\n\tstr\tr0, [r5]\n' +
      '\tldr\tr1, .L7+0x14\n.L3:\n\tldrh\tr0, [r1]\n\tcmp\tr0, #0xa0\n\tbne\t.L3\n\tmov\tr0, #0x2\n' +
      '\tstr\tr0, [r5]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L8:\n' +
      '\t.align\t2, 0\n.L7:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\t0x40000dc\n' +
      '\t.word\t-0x7effffe0\n\t.word\t-0x7afffff0\n\t.word\t0x4000006\n';
    const src = decompile('q5', poll, ARMV4T_AGBCC).source;
    expect(src).toContain('    u8 sp0[8];');
    expect(src).toContain('while (*(volatile u16 *)67108870 != 160);');
  });

  // …and through a variable the struct recovery typed as the device's struct pointer: a channel
  // chosen by a branch, `d = c ? (struct Snd *)0x4000060 : (struct Snd *)0x4000068`, spelled
  // `v1->field_0`, carries the qualifier on a cast of that variable (compiled: plain, agbcc hoists
  // the `ldrh` out of `while (d->lo != 0);` and the recompile never exits the loop).
  test('a device access through a struct-typed pointer variable is volatile', () => {
    const phiPoll =
      'f3:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr3, sp\n\tmov\tr2, #0x1\n' +
      '\tstrh\tr2, [r3]\n\tldr\tr6, .L9\n\tstr\tr3, [r6]\n\tldr\tr5, .L9+0x4\n\tstr\tr0, [r5]\n' +
      '\tldr\tr4, .L9+0x8\n\tldr\tr2, .L9+0xc\n\tldr\tr3, [r2]\n\tstr\tr3, [r4]\n' +
      '\tmov\tr2, #0x2\n\tstr\tr2, [sp, #0x4]\n\tadd\tr2, sp, #0x4\n\tstr\tr2, [r6]\n' +
      '\tstr\tr0, [r5]\n\tstr\tr3, [r4]\n\tldr\tr2, .L9+0x10\n\tcmp\tr1, #0\n\tbeq\t.L3\n' +
      '\tsub\tr2, r2, #0x8\n.L3:\n\tmov\tr0, #0x5\n\tstr\tr0, [r2, #0x4]\n.L5:\n' +
      '\tldrh\tr0, [r2]\n\tcmp\tr0, #0\n\tbne\t.L5\n\tldr\tr0, [r2, #0x4]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n.L10:\n\t.align\t2, 0\n' +
      '.L9:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\t0x40000dc\n\t.word\tgCnt\n' +
      '\t.word\t0x4000068\n';
    const src = decompile('f3', phiPoll, ARMV4T_AGBCC).source;
    expect(src).toContain('    u8 sp0[8];');
    expect(src).toContain('((volatile struct Struct0 *)v1)->field_4 = 5;');
    expect(src).toContain('} while (((volatile struct Struct0 *)v1)->field_0 != 0);');
    expect(src).toContain('return ((volatile struct Struct0 *)v1)->field_4;');
  });

  // A marked read executes once, as a call does: `v = REG_VCOUNT; return v * v;` is one `ldrh`,
  // and inlined at both operands the qualifier makes it two (compiled: 2 `ldrh`, x*y for x*x).
  test('a volatile device read with two uses is read once', () => {
    const square =
      'sv1:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr3, sp\n\tmov\tr2, #0x0\n' +
      '\tstrh\tr2, [r3]\n\tldr\tr5, .L3\n\tstr\tr3, [r5]\n\tldr\tr4, .L3+0x4\n' +
      '\tldr\tr3, .L3+0x8\n\tstr\tr3, [r4]\n\tldr\tr2, .L3+0xc\n\tstr\tr0, [r2]\n' +
      '\tmov\tr0, #0x5\n\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r5]\n' +
      '\tstr\tr3, [r4]\n\tstr\tr1, [r2]\n\tldr\tr0, .L3+0x10\n\tldrh\tr0, [r0]\n\tmov\tr1, r0\n' +
      '\tmul\tr1, r1, r0\n\tadd\tr0, r1, #0\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n' +
      '\tpop\t{r1}\n\tbx\tr1\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n' +
      '\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t0x40000dc\n\t.word\t0x4000006\n';
    const src = decompile('sv1', square, ARMV4T_AGBCC).source;
    expect(src).toContain('    v0 = *(volatile u16 *)67108870;\n    return v0 * v0;\n');
  });

  // …and it stays in the arm it was read in: `if (k && (v = REG_VCOUNT) > 5) h(v);` is not folded
  // into a `&&`, whose fold would hoist the read above the branch, onto the path that skips it.
  test('a volatile device read a branch guards stays in its arm', () => {
    const guarded =
      'sc1:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tmov\tr3, #0x0\n' +
      '\tstrh\tr3, [r4]\n\tldr\tr6, .L4\n\tstr\tr4, [r6]\n\tldr\tr5, .L4+0x4\n' +
      '\tldr\tr4, .L4+0x8\n\tstr\tr4, [r5]\n\tldr\tr3, .L4+0xc\n\tstr\tr0, [r3]\n' +
      '\tmov\tr0, #0x5\n\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r6]\n' +
      '\tstr\tr4, [r5]\n\tstr\tr1, [r3]\n\tcmp\tr2, #0\n\tbeq\t.L3\n\tldr\tr0, .L4+0x10\n' +
      '\tldrh\tr0, [r0]\n\tcmp\tr0, #0x5\n\tbls\t.L3\n\tbl\th\n.L3:\n\tadd\tsp, sp, #0x8\n' +
      '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L5:\n\t.align\t2, 0\n.L4:\n' +
      '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t0x40000dc\n' +
      '\t.word\t0x4000006\n';
    const src = decompile('sc1', guarded, ARMV4T_AGBCC).source;
    expect(src).toContain('    if (a2 != 0) {\n        v0 = *(volatile u16 *)67108870;\n        if (v0 > 5) h(v0');
  });

  // A marked read nothing consumes is still one the machine made: `REG_IF;` stays a statement.
  test('a dead volatile device read is spelled', () => {
    const ack =
      'd1:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr3, sp\n\tmov\tr2, #0x0\n' +
      '\tstrh\tr2, [r3]\n\tldr\tr5, .L3\n\tstr\tr3, [r5]\n\tldr\tr4, .L3+0x4\n' +
      '\tldr\tr3, .L3+0x8\n\tstr\tr3, [r4]\n\tldr\tr2, .L3+0xc\n\tstr\tr0, [r2]\n' +
      '\tmov\tr0, #0x5\n\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r5]\n' +
      '\tstr\tr3, [r4]\n\tstr\tr1, [r2]\n\tldr\tr0, .L3+0x10\n\tldrh\tr0, [r0]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n' +
      '.L3:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t0x40000dc\n' +
      '\t.word\t0x4000202\n';
    const src = decompile('d1', ack, ARMV4T_AGBCC).source;
    expect(src).toContain('    *(volatile u16 *)67109378;\n}');
  });

  // Two device reads stay in the order the machine made them, and neither passes a device store.
  // Verbatim agbcc: `a = TM0CNT_L; b = VCOUNT; gY = b - a;` in one expression lets the recompile
  // read VCOUNT first, and `v = r->ifl; r->ie = d; gY = v;` inlined at `gY` reads REG_IF after
  // writing REG_IE (compiled, both reversed).
  test('a volatile device read keeps its place against the device accesses after it', () => {
    const twoReads =
      'o12:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr3, sp\n\tmov\tr2, #0x0\n' +
      '\tstrh\tr2, [r3]\n\tldr\tr5, .L3\n\tstr\tr3, [r5]\n\tldr\tr4, .L3+0x4\n\tldr\tr3, .L3+0x8\n' +
      '\tstr\tr3, [r4]\n\tldr\tr2, .L3+0xc\n\tstr\tr0, [r2]\n\tmov\tr0, #0x5\n' +
      '\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r5]\n\tstr\tr3, [r4]\n' +
      '\tstr\tr1, [r2]\n\tldr\tr0, .L3+0x10\n\tldrh\tr2, [r0]\n\tsub\tr0, r0, #0xfa\n' +
      '\tldrh\tr0, [r0]\n\tldr\tr1, .L3+0x14\n\tsub\tr0, r0, r2\n\tstr\tr0, [r1]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
      '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t0x40000dc\n' +
      '\t.word\t0x4000100\n\t.word\tgY\n';
    expect(decompile('o12', twoReads, ARMV4T_AGBCC).source).toContain(
      '    v0 = *(volatile u16 *)67109120;\n    gY = *(volatile u16 *)(67109120 - 250) - v0;\n',
    );
    const readThenWrite =
      'o14:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, r8\n\tpush\t{r7}\n\tadd\tsp, sp, #-0x8\n' +
      '\tlsl\tr2, r2, #0x10\n\tlsr\tr2, r2, #0x10\n\tldr\tr5, .L3\n\tmov\tr4, sp\n\tmov\tr3, #0x0\n' +
      '\tstrh\tr3, [r4]\n\tldr\tr3, .L3+0x4\n\tmov\tr8, r3\n\tstr\tr4, [r3]\n\tldr\tr6, .L3+0x8\n' +
      '\tldr\tr4, .L3+0xc\n\tstr\tr4, [r6]\n\tadd\tr3, r3, #0x8\n\tstr\tr0, [r3]\n\tmov\tr0, #0x5\n' +
      '\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tmov\tr7, r8\n\tstr\tr0, [r7]\n' +
      '\tstr\tr4, [r6]\n\tstr\tr1, [r3]\n\tldrh\tr1, [r5, #0x2]\n\tldrh\tr0, [r5]\n' +
      '\tstrh\tr2, [r5]\n\tldr\tr0, .L3+0x10\n\tstr\tr1, [r0]\n\tadd\tsp, sp, #0x8\n\tpop\t{r3}\n' +
      '\tmov\tr8, r3\n\tpop\t{r4, r5, r6, r7}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
      '\t.word\t0x4000200\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\tgY\n';
    expect(decompile('o14', readThenWrite, ARMV4T_AGBCC).source).toContain(
      '    v0 = ((volatile u16 *)67109376)[1];\n    *(volatile u16 *)67109376;\n' +
        '    *(volatile u16 *)67109376 = a2;\n    gY = v0;\n',
    );
  });

  // A function accepted object by object pins the device stores a later store in their block
  // overwrites, which plain agbcc deletes. Verbatim agbcc, `REG_IME = 0; DmaFill16(3, 0x1111, a,
  // 0x40); DmaFill16(3, 0x2222, b, 0x40); REG_IME = 1;`: the first fill and `REG_IME = 0` are
  // pinned, and the recompile keeps the target's 10 stores (7 plain). The other stores stay plain;
  // each fill's closing read of the control is a read, and pinned.
  test('a function accepted object by object pins a device store its block overwrites', () => {
    const twoFills =
      'd3i:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr5, .L3\n\tmov\tr2, #0x0\n\tstrh\tr2, [r5]\n' +
      '\tmov\tr3, sp\n\tldr\tr4, .L3+0x4\n\tadd\tr2, r4, #0\n\tstrh\tr2, [r3]\n\tldr\tr2, .L3+0x8\n\tstr\tr3, [r2]\n' +
      '\tstr\tr0, [r2, #0x4]\n\tldr\tr4, .L3+0xc\n\tstr\tr4, [r2, #0x8]\n\tldr\tr0, [r2, #0x8]\n\tldr\tr6, .L3+0x10\n' +
      '\tadd\tr0, r6, #0\n\tstrh\tr0, [r3]\n\tstr\tr3, [r2]\n\tstr\tr1, [r2, #0x4]\n\tstr\tr4, [r2, #0x8]\n' +
      '\tldr\tr0, [r2, #0x8]\n\tmov\tr0, #0x1\n\tstrh\tr0, [r5]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n' +
      '\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x4000208\n\t.word\t0x1111\n\t.word\t0x40000d4\n' +
      '\t.word\t-0x7effffe0\n\t.word\t0x2222\n';
    const src = decompile('d3i', twoFills, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src).toContain('    *(volatile u16 *)67109384 = 0;\n');
    // pinned through the channel's base local, qualified at each access (l3/basecse.ts `rewrite`)
    expect(src).toContain(
      '    *(volatile s32 *)p0 = &sp0;\n    ((volatile s32 *)p0)[1] = a0;\n' +
        '    ((volatile s32 *)p0)[2] = -2130706400;\n',
    );
    expect(src).toContain('    p0[2] = -2130706400;\n    ((volatile s32 *)p0)[2];\n    *(u16 *)67109384 = 1;\n');
  });

  // …and a read of the channel between the two fills does not stand for the first: agbcc forwards
  // the stored control to a `u32` read of it and deletes the store (a `u16` read would not alias
  // it). Verbatim agbcc, the same two fills with `gY = *(vu32 *)0x40000DC;` between: 11 stores in
  // the target, 10 in a recompile that leaves the first control store plain, 11 in this one's.
  test('a read of an overwritten device store does not unpin it', () => {
    const readBetween =
      'e2:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr5, .L3\n\tmov\tr2, #0x0\n' +
      '\tstrh\tr2, [r5]\n\tmov\tr3, sp\n\tldr\tr4, .L3+0x4\n\tadd\tr2, r4, #0\n\tstrh\tr2, [r3]\n' +
      '\tldr\tr2, .L3+0x8\n\tstr\tr3, [r2]\n\tstr\tr0, [r2, #0x4]\n\tldr\tr4, .L3+0xc\n' +
      '\tstr\tr4, [r2, #0x8]\n\tldr\tr0, [r2, #0x8]\n\tldr\tr3, .L3+0x10\n\tldr\tr0, .L3+0x14\n' +
      '\tldr\tr0, [r0]\n\tstr\tr0, [r3]\n\tmov\tr3, sp\n\tldr\tr6, .L3+0x18\n\tadd\tr0, r6, #0\n' +
      '\tstrh\tr0, [r3]\n\tstr\tr3, [r2]\n\tstr\tr1, [r2, #0x4]\n\tstr\tr4, [r2, #0x8]\n' +
      '\tldr\tr0, [r2, #0x8]\n\tmov\tr0, #0x1\n\tstrh\tr0, [r5]\n\tadd\tsp, sp, #0x4\n' +
      '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x4000208\n' +
      '\t.word\t0x1111\n\t.word\t0x40000d4\n\t.word\t-0x7effffe0\n\t.word\tgY\n\t.word\t0x40000dc\n' +
      '\t.word\t0x2222\n';
    expect(decompile('e2', readBetween, ARMV4T_AGBCC).source).toContain(
      '    ((volatile s32 *)p0)[2] = -2130706400;\n    ((volatile s32 *)p0)[2];\n' +
        '    gY = *(volatile s32 *)67109084;\n',
    );
  });

  // …and every device READ of such a function is pinned: plain, the read that closes a DMA macro
  // (`dmaRegs[2];`) is used by nothing and is not lifted at all, and agbcc hoists a poll out of a
  // loop that stores nothing. Verbatim agbcc, two fills whose control the shift-built `REG_DISPCNT
  // = d` does not re-arm, then `while (REG_VCOUNT != 160);`: plain, the recompile loses both
  // closing reads and spins on a register copy of the first VCOUNT read.
  test('a function accepted object by object keeps every device read', () => {
    const pollAfterFills =
      'd1:\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tlsl\tr1, r1, #0x10\n' +
      '\tlsr\tr1, r1, #0x10\n\tmov\tr2, sp\n\tstrh\tr0, [r2]\n\tldr\tr2, .L7\n\tmov\tr0, sp\n' +
      '\tstr\tr0, [r2]\n\tldr\tr0, .L7+0x4\n\tstr\tr0, [r2, #0x4]\n\tldr\tr0, .L7+0x8\n' +
      '\tstr\tr0, [r2, #0x8]\n\tldr\tr0, [r2, #0x8]\n\tmov\tr0, #0x5\n\tstr\tr0, [sp, #0x4]\n' +
      '\tadd\tr0, sp, #0x4\n\tstr\tr0, [r2]\n\tldr\tr0, .L7+0xc\n\tstr\tr0, [r2, #0x4]\n' +
      '\tldr\tr0, .L7+0x10\n\tstr\tr0, [r2, #0x8]\n\tldr\tr0, [r2, #0x8]\n\tmov\tr0, #0x80\n' +
      '\tlsl\tr0, r0, #0x13\n\tstrh\tr1, [r0]\n\tldr\tr1, .L7+0x14\n.L3:\n\tldrh\tr0, [r1]\n' +
      '\tcmp\tr0, #0xa0\n\tbne\t.L3\t@cond_branch\n\tadd\tsp, sp, #0x8\n\tbx\tlr\n.L8:\n' +
      '\t.align\t2, 0\n.L7:\n\t.word\t0x40000d4\n\t.word\tgDst\n\t.word\t-0x7effffe0\n' +
      '\t.word\tgDst2\n\t.word\t-0x7affffe0\n\t.word\t0x4000006\n';
    const src = decompile('d1', pollAfterFills, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src.match(/^ {4}\(\(volatile s32 \*\)p0\)\[2\];$/gm)).toHaveLength(2);
    expect(src).toContain('    do {\n        v0 = *(volatile u16 *)67108870;\n    } while (v0 != 160);\n');
  });

  // …save a read agbcc could not have made of a `volatile`: it never sign-extends a qualified read
  // in the load (the expander refuses a volatile MEM, recog.c:918 under function.c:5564, and
  // thumb.md:393-409 then loads it zero-extended and shifts), so an `ldrsh` is a plain read in the
  // source and qualified it recompiles to `ldrh; lsl; asr`. Verbatim agbcc but for one pool label, a
  // fill from a frame temporary and then `return *(s16 *)0x4000020;`, and the same with `volatile
  // s16`.
  test('a device read agbcc sign-extended in the load is not pinned', () => {
    const preamble = (name: string) =>
      `${name}:\n\tadd\tsp, sp, #-0x4\n\tmov\tr2, sp\n\tmov\tr1, #0x0\n\tstrh\tr1, [r2]\n` +
      '\tldr\tr1, .L3\n\tstr\tr2, [r1]\n\tadd\tr1, r1, #0x4\n\tstr\tr0, [r1]\n' +
      '\tadd\tr1, r1, #0x4\n\tldr\tr0, .L3+0x4\n\tstr\tr0, [r1]\n\tldr\tr0, [r1]\n\tldr\tr0, .L3+0x8\n';
    const pool =
      '\tadd\tsp, sp, #0x4\n\tbx\tlr\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n' +
      '\t.word\t-0x7efffff0\n\t.word\t0x4000020\n';
    const signedLoad = preamble('rdPlain') + '\tmov\tr1, #0x0\n\tldrsh\tr0, [r0, r1]\n' + pool;
    const extendedAfter = preamble('rdVol') + '\tldrh\tr0, [r0]\n\tlsl\tr0, r0, #0x10\n\tasr\tr0, r0, #0x10\n' + pool;
    expect(decompile('rdPlain', signedLoad, ARMV4T_AGBCC).source).toContain('    return *(s16 *)67108896;\n');
    expect(decompile('rdVol', extendedAfter, ARMV4T_AGBCC).source).toContain(
      '    return (s16)*(volatile u16 *)67108896;\n',
    );
  });

  // A device address agbcc builds without a pool word is placed too: 0x04000000 is `mov #0x80;
  // lsl #0x13`. Verbatim agbcc, two fills whose control nothing bounds, then `REG_DISPCNT = 0x80;
  // gY = 5; REG_DISPCNT = d;`: spelled plain, the recompile drops the first DISPCNT store (11 -> 10).
  test('a shift-built device address is pinned', () => {
    const shiftBuilt =
      'o4:\n\tpush\t{r4, r5, r6, lr}\n\tmov\tr6, r8\n\tpush\t{r6}\n\tadd\tsp, sp, #-0x8\n' +
      '\tlsl\tr2, r2, #0x10\n\tlsr\tr2, r2, #0x10\n\tmov\tr4, sp\n\tmov\tr3, #0x0\n' +
      '\tstrh\tr3, [r4]\n\tldr\tr6, .L3\n\tstr\tr4, [r6]\n\tldr\tr5, .L3+0x4\n\tldr\tr4, .L3+0x8\n' +
      '\tstr\tr4, [r5]\n\tldr\tr3, .L3+0xc\n\tstr\tr0, [r3]\n\tmov\tr0, #0x5\n\tmov\tr8, r0\n' +
      '\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r6]\n\tstr\tr4, [r5]\n' +
      '\tstr\tr1, [r3]\n\tmov\tr1, #0x80\n\tlsl\tr1, r1, #0x13\n\tmov\tr0, #0x80\n' +
      '\tstrh\tr0, [r1]\n\tldr\tr0, .L3+0x10\n\tmov\tr3, r8\n\tstr\tr3, [r0]\n\tstrh\tr2, [r1]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r3}\n\tmov\tr8, r3\n\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n' +
      '\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n' +
      '\t.word\tgDst\n\t.word\t0x40000dc\n\t.word\tgY\n';
    expect(decompile('o4', shiftBuilt, ARMV4T_AGBCC).source).toContain(
      '    *(volatile u16 *)(128 << 19) = 128;\n    gY = 5;\n    *(volatile u16 *)(128 << 19) = a2;\n',
    );
  });

  // one address-taken halfword frame object published to a DMA register — the shape that mints
  // an `sp<off>` name, reused by the two shadowing tests below
  const declaresSp0 =
    'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tldr\tr2, .L1\n\tstr\tr4, [r2]\n' +
    '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';

  test('a callee named sp0 keeps its name — the minted local yields', () => {
    // Call targets are part of the namespace the structurer mints into: a local shadowing a
    // function named sp0 makes `sp0()` a call through a u16 object — a compile error. The minted
    // name steps aside (`sp0_`) exactly as it does for a same-named global or map symbol.
    const callsSp0 =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tldr\tr2, .L1\n\tstr\tr4, [r2]\n' +
      '\tbl\tsp0\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';
    // declared: undeclared, r2 set past an r1 nothing set is a gap the guess refuses
    const src = decompile('f', callsSp0, ARMV4T_AGBCC, { prototypes: { sp0: { params: 0 } } }).source;
    expect(src).toContain('volatile u16 sp0_;');
    expect(src).toContain('&sp0_');
    expect(src).toContain('sp0(');
  });

  test('a MAP symbol named sp0 keeps its name — the minted local yields', () => {
    // The third namespace the minter shares, and the only one nothing else in this layer walks:
    // the project's symbol map. It is CONSULTED rather than copied into the taken set, so this
    // pins the arm — a map name that stops being asked about mints a local that shadows a real
    // project global, and `sp0` would then read the wrong object.
    const mapWithSp0: SymbolMap = new Map([[0x03005220, [{ name: 'sp0', kind: 'data', declared: true }]]]);
    const src = decompile('f', declaresSp0, ARMV4T_AGBCC, { symbols: mapWithSp0 }).source;
    expect(src).toContain('volatile u16 sp0_;');
    expect(src).toContain('&sp0_');
  });

  test('the frame-object audit refuses every use it cannot vouch for, loudly and by name', () => {
    const laddr = /address-taken stack local/;
    const wrap = (body: string) =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${body}\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    // never dereferenced: nothing pins the object's type, and a guessed declaration is the
    // plausible-but-wrong class (here the address escapes into the return value)
    expect(() =>
      decompile(
        'f',
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n',
        ARMV4T_AGBCC,
      ),
    ).toThrow(laddr);
    // accesses disagreeing on width: no single declared type reproduces both — refused where the
    // address escapes to a writer the one object cannot hold, and where nothing escapes, the views
    // of one union, both stores kept
    const twoWidths = '\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tstr\tr1, [r4]\n';
    expect(() => decompile('f', wrap(`${twoWidths}\tmov\tr0, r4\n\tbl\tg\n`), ARMV4T_AGBCC)).toThrow(laddr);
    expect(decompile('f', wrap(twoWidths), ARMV4T_AGBCC).source).toContain('sp0.half[0] = a0;\n    sp0.word[0] = a1;');
    // address arithmetic on the capture that is not a constant move: the object's extent stops
    // being one scalar
    expect(() => decompile('f', wrap('\tmov\tr4, sp\n\tsub\tr4, r4, #0x4\n\tstr\tr0, [r4]\n'), ARMV4T_AGBCC)).toThrow(
      laddr,
    );
    // a word at a nonzero offset through the capture that reaches a call unread: it may be that
    // callee's stack argument, whether or not a prototype states it, since a stated list is a lower
    // bound (frame-objects.ts `storedNeverRead`)…
    const wordAt4 = '\tmov\tr4, sp\n\tstr\tr0, [r4, #0x4]\n';
    const g1 = { prototypes: { g: { params: 1 } } };
    expect(() => decompile('f', wrap(`${wordAt4}\tbl\tg\n`), ARMV4T_AGBCC)).toThrow(laddr);
    expect(() => decompile('f', wrap(`${wordAt4}\tbl\tg\n`), ARMV4T_AGBCC, g1)).toThrow(
      /the 4-byte store at \[sp,#4\) through a captured address reaches the call to `g` unread on every path/,
    );
    // …and with no call, or read back after it, it is a word of the one object
    expect(decompile('f', wrap(wordAt4), ARMV4T_AGBCC).source).toContain('((s32 *)sp0)[1] = a0;');
    const readBack = `${wordAt4}\tbl\tg\n\tldr\tr0, [r4, #0x4]\n`;
    expect(decompile('f', wrap(readBack), ARMV4T_AGBCC, g1).source).toContain('((s32 *)sp0)[1] = a0;');
    // overlap with an SSA slot: one byte, two models — refused where the address escapes to a
    // writer the one object cannot hold (a callee taking it at argument 0 with nothing said of its
    // return)…
    const overSlot = '\tmov\tr4, sp\n\tstr\tr0, [r4]\n\tstr\tr1, [sp]\n\tldr\tr2, [sp]\n\tadd\tr0, r2, #0\n';
    expect(() => decompile('f', wrap(`${overSlot}\tmov\tr0, r4\n\tbl\tg\n`), ARMV4T_AGBCC)).toThrow(
      /the object at \[sp,#0\) overlaps the SSA slot at \[sp,#0\] — one byte, two models/,
    );
    // …and where nothing escapes, kept as one object in memory, every store in it
    expect(decompile('f', wrap(overSlot), ARMV4T_AGBCC).source).toContain(
      '*(s32 *)sp0 = a0;\n    *(s32 *)sp0 = a1;\n    return *(s32 *)sp0;',
    );
    // a RUNTIME offset from sp is an index, read through a cast at its own width — so two widths
    // are two alias sets over bytes the index names none of, refused by the one object too
    expect(() => decompile('f', wrap('\tadd\tr4, sp, r1\n\tstrh\tr0, [r4]\n\tstr\tr0, [r4]\n'), ARMV4T_AGBCC)).toThrow(
      /a runtime index into the bytes \[sp,#0\) to \[sp,#8\) kept as one object accesses 2 and 4 bytes wide/,
    );
  });

  test('a gap in the slots read still yields ABI-correct offsets', () => {
    // frame 8, so [sp,#0xc] is argument 6 (index 5) and argument 5 is never read. Naming downstream
    // is POSITIONAL, so minting only the slot that was read would put the parameter at argument 5's
    // offset — silently the wrong signature. Reading slot k proves the caller pushed 4..k.
    const gap = 'f:\n\tpush\t{r4, lr}\n\tldr\tr0, [sp, #0xc]\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // six parameters: r0-r3 and both stack slots, with the one actually read last and in place
    expect(decompile('f', gap, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n    return a5;\n}\n',
    );
  });

  // Each of these is a refusal, and each keeps a LOCAL from being minted as a parameter.
  test('everything the frame walk cannot vouch for still declines', () => {
    const spAsData = /stack pointer used as data/;
    // below the frame top: a spill slot / local, NOT an argument (the separate slot capability)
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, #4]\n\tbx\tlr\n')).toThrow(spAsData);
    // sub-word: the argument area is word-granular, so a byte/halfword read is not a whole slot
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldrb\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldrh\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    // unaligned: not a slot boundary
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, #0xa]\n\tbx\tlr\n')).toThrow(spAsData);
    // register offset: not a fixed slot
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, r1]\n\tbx\tlr\n')).toThrow(spAsData);
    // a WRITE to the argument area is not a parameter read
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tstr\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    // (outside the entry block: `an incoming stack argument re-read in a loop is the parameter`)
  });
});
