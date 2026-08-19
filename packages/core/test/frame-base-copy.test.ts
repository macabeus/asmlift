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

// A halfword spilled to the stack and reloaded — agbcc's shape when register pressure forces a
// sub-word value off the registers, and the shape `sa3:PackSaveSector` is built from. Each copy is
// redefined inside its block (`ldr r3, …`, and the reload's own destination), which is what bounds
// its live range to that block. Both name frame offset 4, so both are the same object.
const SPILL = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tldrh\tr2, [r0]
\tmov\tr3, sp
\tstrh\tr2, [r3, #0x4]
\tldr\tr3, [r0, #0x4]
\tbl\tg
\tmov\tr2, sp
\tldrh\tr2, [r2, #0x4]
\tadd\tr0, r2, #0
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

// A refusal leaves the copy on the capture path, where the object sits at the frame BASE and the
// access it was going to serve is now at [+4] through it — so every refusal below names "the
// captured address", and the accepted fixture names nothing at all.
const CAPTURE = /the captured address/;

describe('a `mov rD, sp` addressed through is a frame base, not a capture', () => {
  test('the sub-word spill round-trips through a declared frame local', () => {
    // `u16` and not `s16`: `ldrh` zero-extends, so that IS the type the machine used. No
    // `volatile` — the address never leaves the function, so nothing outside can observe a store
    // and the object must not pay volatile's codegen.
    expect(lift(SPILL).source).toBe(
      's32 f(u16 * a0) {\n    u16 sp4;\n    sp4 = *a0;\n    g(a0);\n    return sp4;\n}\n',
    );
  });

  test('a copy that ESCAPES as a value stays a capture', () => {
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tstr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a REGISTER-offset access through the copy stays a capture', () => {
    // the offset is not known here, so which frame bytes the access names is not known either;
    // the register-offset lowering makes the capture flow into an `add`, which the audit refuses
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tstrh\tr2, [r3, #0x4]\n', '\tstrh\tr2, [r3, r1]\n'))).toThrow(CAPTURE);
  });

  test('a copy still live at the end of its block stays a capture', () => {
    // without a redefinition the use set is not this block's: a successor may read the copy
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tldr\tr1, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a call inside the copy s live range stays a capture', () => {
    // the scan classifies each instruction it steps over; a call is not one it can classify
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tbl\th\n\tldr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('an sp adjustment inside the copy s live range stays a capture', () => {
    // The access offsets are relative to sp AT THE COPY, so a frame that moves under them names
    // different bytes. The epilogue is where this is reachable: sp unwinding before the last use of
    // a copy is otherwise the slot model's own refusal, but a block that RETURNS is allowed to
    // unwind, and there the scan is the only thing standing between the copy and the wrong address.
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() =>
      lift(
        edit(
          '\tmov\tr2, sp\n\tldrh\tr2, [r2, #0x4]\n\tadd\tr0, r2, #0\n\tadd\tsp, sp, #0x8\n',
          '\tmov\tr2, sp\n\tadd\tsp, sp, #0x8\n\tldrh\tr2, [r2, #0x4]\n\tadd\tr0, r2, #0\n',
        ),
      ),
    ).toThrow(CAPTURE);
  });

  test('a copy read as a VALUE by an ALU op stays a capture', () => {
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tadd\tr1, r3, #0\n\tldr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a HIGH-register copy stays a capture', () => {
    // no sub-word access encodes a high base register, so this is never the addressing form —
    // and excluding it keeps the scan away from the `sl`/`ip`/`fp` aliases of the same register
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tmov\tr3, sp\n', '\tmov\tr8, sp\n').replace('[r3, #0x4]', '[r8, #0x4]'))).toThrow(CAPTURE);
  });
});

// TWO MODELS FOR ONE BYTE is a silent disagreement, so an object at a nonzero frame offset has to
// own its bytes outright. These are the audit's per-object checks, which only become reachable once
// a capture can name an offset other than the frame base.
describe('the audit judges each frame object on its own bytes', () => {
  const frame = (body: string) =>
    `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${body}\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
  // The accepted shape these are all one edit away from: one halfword object at [sp,#4], with the
  // word slot at [sp,#0] beside it — each model owning its own bytes.
  // Stored AND reloaded: a local nothing reads is dead, and DCE reaps it before it can be declared.
  const OBJ = '\tmov\tr3, sp\n\tstrh\tr1, [r3, #0x4]\n\tmov\tr3, sp\n\tldrh\tr3, [r3, #0x4]\n\tadd\tr0, r3, #0\n';
  const DISJOINT = frame(`\tstr\tr0, [sp]\n${OBJ}\tldr\tr2, [sp]\n\tadd\tr0, r0, r2\n`);

  test('an object clear of every slot and every other object lifts', () => {
    expect(lift(DISJOINT).source).toBe(
      's32 f(s32 a0, s32 a1) {\n    u16 sp4;\n    sp4 = a1;\n    return sp4 + a0;\n}\n',
    );
  });

  test('an object overlapping an SSA slot declines', () => {
    // the slot model keeps [sp,#4] in a register, so a store through the object would never be
    // seen there — the two models would disagree about the same four bytes, silently
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() => lift(frame(`\tstr\tr0, [sp, #0x4]\n${OBJ}\tldr\tr2, [sp, #0x4]\n\tadd\tr0, r0, r2\n`))).toThrow(
      /overlaps the SSA slot/,
    );
  });

  test('two objects sharing a byte decline', () => {
    // a word at [sp,#0] and a halfword at [sp,#2] are two declared locals over the same storage
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() =>
      lift(
        frame(
          '\tmov\tr3, sp\n\tstr\tr1, [r3]\n\tmov\tr3, sp\n\tldr\tr0, [r3]\n' +
            '\tmov\tr2, sp\n\tstrh\tr1, [r2, #0x2]\n\tmov\tr2, sp\n\tldrh\tr2, [r2, #0x2]\n\tadd\tr0, r0, r2\n',
        ),
      ),
    ).toThrow(/overlap — one byte, two models/);
  });

  test('an object past the reserved local area declines', () => {
    // above the local area is the callee-saved block the epilogue pops, then the caller's frame
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() => lift(frame(OBJ.replace(/#0x4/g, '#0x8')))).toThrow(/outside the reserved local area/);
  });

  test('two objects of different widths are declared separately', () => {
    // fused into one object — the pre-object audit's model — these two took a single width, so one
    // of the two declarations was the wrong type for the storage the machine addressed
    const src = lift(
      frame(
        '\tmov\tr3, sp\n\tstr\tr1, [r3]\n\tmov\tr3, sp\n\tldr\tr0, [r3]\n' +
          '\tmov\tr2, sp\n\tstrh\tr1, [r2, #0x4]\n\tmov\tr2, sp\n\tldrh\tr2, [r2, #0x4]\n\tadd\tr0, r0, r2\n',
      ),
    ).source;
    expect(src).toContain('s32 sp0;');
    expect(src).toContain('u16 sp4;');
  });
});
