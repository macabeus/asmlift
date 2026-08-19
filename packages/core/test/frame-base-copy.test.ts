// The frame base in a register. Thumb-1 gives `ldr`/`str` an `[sp,#imm]` encoding and gives the
// sub-word forms none, so a byte or halfword spill can only be spelled by copying sp into a low
// register and addressing through the copy. That is an addressing mode, not an address capture:
// the copy never becomes a value, and reading it as one sends the frame-object audit looking for a
// wider frame object that the shape does not need.
//
// Every refusal below is a ONE-FACT edit of the accepted fixture, and each runs that fixture first
// as a positive control — a decline for some unrelated reason must not read as a pass. The control
// asserts the ADDRESSING-MODE message and each refusal asserts the CAPTURE message, so the two
// paths are told apart by what the frontend says, not merely by both failing.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

// A halfword spilled to the stack — agbcc's shape when register pressure forces a sub-word value
// off the registers. ONE copy, because a second would answer the audit first and every refusal
// below would then be reporting on the copy it did not edit. `ldr r3, [r0, #0x4]` is the
// redefinition that bounds the copy's live range to this block.
const SPILL = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tldrh\tr2, [r0]
\tmov\tr3, sp
\tstrh\tr2, [r3, #0x4]
\tldr\tr3, [r0, #0x4]
\tadd\tr0, r3, #0
\tadd\tsp, sp, #0x8
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;

const lift = (asm: string) => decompile('f', asm, ARMV4T_AGBCC);
const edit = (from: string, to: string) => {
  const out = SPILL.replace(from, to);
  expect(out).not.toBe(SPILL); // the one-fact edit landed
  return out;
};

// The addressing-mode path names the object's FRAME OFFSET; every capture-path refusal names what
// it could not vouch for about "the captured address". Disjoint strings, so a test cannot pass by
// declining the other way.
const ADDRESSING_MODE = /a capture at frame offset 4\b/;
const CAPTURE = /the captured address/;

describe('a `mov rD, sp` addressed through is a frame base, not a capture', () => {
  test('the sub-word spill names the object at its own frame offset', () => {
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
  });

  test('a copy that ESCAPES as a value stays a capture', () => {
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tstr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a REGISTER-offset access through the copy stays a capture', () => {
    // the offset is not known here, so which frame bytes the access names is not known either;
    // the register-offset lowering makes the capture flow into an `add`, which the audit refuses
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tstrh\tr2, [r3, #0x4]\n', '\tstrh\tr2, [r3, r1]\n'))).toThrow(CAPTURE);
  });

  test('a copy still live at the end of its block stays a capture', () => {
    // without a redefinition the use set is not this block's: a successor may read the copy
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tldr\tr1, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a call inside the copy s live range stays a capture', () => {
    // the scan classifies each instruction it steps over; a call is not one it can classify
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tbl\th\n\tldr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('an sp adjustment inside the copy s live range stays a capture', () => {
    // the access offsets are relative to sp AT THE COPY; a frame that moves invalidates them
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() =>
      lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tadd\tsp, sp, #-0x4\n\tadd\tsp, sp, #0x4\n\tldr\tr3, [r0, #0x4]\n')),
    ).toThrow(CAPTURE);
  });

  test('a copy read as a VALUE by an ALU op stays a capture', () => {
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tadd\tr1, r3, #0\n\tldr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a HIGH-register copy stays a capture', () => {
    // no sub-word access encodes a high base register, so this is never the addressing form —
    // and excluding it keeps the scan away from the `sl`/`ip`/`fp` aliases of the same register
    expect(() => lift(SPILL)).toThrow(ADDRESSING_MODE);
    expect(() => lift(edit('\tmov\tr3, sp\n', '\tmov\tr8, sp\n').replace('[r3, #0x4]', '[r8, #0x4]'))).toThrow(CAPTURE);
  });
});
