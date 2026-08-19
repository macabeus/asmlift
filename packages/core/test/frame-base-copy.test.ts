// The frame base in a register. Thumb-1 gives `ldr`/`str` an `[sp,#imm]` encoding and gives the
// sub-word forms none, so a byte or halfword spill can only be spelled by copying sp into a
// register and addressing through the copy. That is an addressing mode, not an address capture:
// what the machine named is one object at that frame offset, and the frame-object audit splits the
// capture into the objects its accesses name.
//
// Most of these tests are about ONE ROLE APPEARING TWICE. `str rD, [rD, #k]` is a base use and an
// escape; `sub rD, #4` reads rD as a value even though rD is also its destination; an edge argument
// is a use that is never an access. Each is a silent wrong answer to anything that decides what an
// instruction does from its base operand alone, and each is why the split enumerates every operand
// and every edge argument instead.
//
// Every refusal runs an accepted fixture first as a positive control, so a decline for an unrelated
// reason cannot read as a pass. Where the refusal is a one-fact edit of `SPILL` it is spelled as
// one (`edit`); four need a shape `SPILL` does not have — a join, a call taking five arguments, two
// objects, two extensions of one byte — and carry their own fixture.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

// A halfword spilled to the stack and reloaded — agbcc's shape when register pressure forces a
// sub-word value off the registers, and the shape `sa3:PackSaveSector` is built from. Both copies
// name frame offset 4, so both are the same object.
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

// A refusal leaves the capture naming the frame BASE, and the access it was going to serve is then
// a reach at [+4] through it — so every refusal below names "the captured address", and the
// accepted fixture names nothing at all.
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

  test('accesses in different blocks name ONE object', () => {
    // Nothing bounds a capture to the block that made it: the split reads the value's uses
    // wherever they are, and two offsets that agree are one local.
    const branched = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tmov\tr3, sp
\tstrh\tr0, [r3, #0x4]
\tcmp\tr1, #0
\tbeq\t.L2
\tmov\tr3, sp
\tstrh\tr1, [r3, #0x4]
.L2:
\tmov\tr3, sp
\tldrh\tr0, [r3, #0x4]
\tadd\tsp, sp, #0x8
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;
    const src = lift(branched).source;
    expect(src).toContain('u16 sp4;');
    expect(src).not.toContain('sp4_'); // one local, not one per capture
  });

  test('a capture STORED THROUGH ITSELF is an escape, not two base uses', () => {
    // `str rD, [rD, #k]` writes the frame address into the frame. Classified by its base operand
    // it reads as an ordinary access and the escape disappears — taking the volatile stamp and the
    // undef retraction with it, and storing whatever rD held BEFORE the copy. The use walk sees
    // both roles because it iterates operands.
    expect(() => lift(SPILL)).not.toThrow(); // control: the base shape IS accepted
    expect(() => lift(edit('\tstrh\tr2, [r3, #0x4]\n', '\tstrh\tr3, [r3, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a capture read by a 2-operand read-modify-write is a value use', () => {
    // Thumb-1 spells `add`/`sub`/`and`/`orr`/`eor`/`mul` as `rD = rD op rM`, so the destination is
    // also a source. That is address arithmetic on the frame base — the shape a computed `add rD,
    // sp, #k` is refused for — and it must not pass as a plain redefinition of rD.
    expect(() => lift(SPILL)).not.toThrow();
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tsub\tr3, #0x4\n'))).toThrow(CAPTURE);
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tand\tr3, r1\n'))).toThrow(CAPTURE);
  });

  test('a WORD access through a capture is not this shape — the outgoing arguments live there', () => {
    // `ldr`/`str` DO have an `[sp,#imm]` encoding, so a word access through a copy is some other
    // shape. What makes it matter is the outgoing-argument area: agbcc stages arguments 5+ at the
    // bottom of the frame with `str`, and the guard that keeps those from being modelled as locals
    // reads `[sp,#k]` accesses — which an access through a copy is not. Read as an object, the
    // argument becomes a dead local and the call loses it.
    expect(() => lift(SPILL)).not.toThrow();
    const outgoing = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tmov\tr4, sp
\tstr\tr0, [r4, #0x4]
\tmov\tr4, r1
\tmov\tr0, r1
\tmov\tr1, r2
\tbl\tg
\tadd\tsp, sp, #0x8
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;
    expect(() => lift(outgoing)).toThrow(CAPTURE);
  });

  test('a capture that ESCAPES keeps the frame base', () => {
    expect(() => lift(SPILL)).not.toThrow();
    expect(() => lift(edit('\tldr\tr3, [r0, #0x4]\n', '\tstr\tr3, [r0, #0x4]\n'))).toThrow(CAPTURE);
  });

  test('a REGISTER-offset access through a capture keeps the frame base', () => {
    // the offset is not known, so which frame bytes the access names is not known either; the
    // lowering makes the capture flow into an `add`, which the audit refuses
    expect(() => lift(SPILL)).not.toThrow();
    expect(() => lift(edit('\tstrh\tr2, [r3, #0x4]\n', '\tstrh\tr2, [r3, r1]\n'))).toThrow(CAPTURE);
  });

  test('a capture that reaches a block PARAMETER keeps the frame base', () => {
    // An edge argument is a use, and never an access: the capture is live past this block, so the
    // taint closure is what judges it. Counted only as an operand it is invisible, the split fires,
    // and the deleted capture leaves the successor argument naming nothing.
    expect(() => lift(SPILL)).not.toThrow();
    const carried = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tmov\tr3, sp
\tstrh\tr0, [r3, #0x4]
\tcmp\tr1, #0
\tbeq\t.L2
\tmov\tr3, r1
.L2:
\tstr\tr3, [r0]
\tadd\tsp, sp, #0x8
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;
    expect(() => lift(carried)).toThrow(CAPTURE);
  });

  test('loads through one object that extend differently decline', () => {
    // One declared type extends one way, so `ldrsb` and `ldrb` of the same byte have no faithful
    // declaration — `sp4 - sp4` folds to 0 where the machine computes sext(b) - zext(b).
    expect(() => lift(SPILL)).not.toThrow();
    const bothSigns = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x10
\tmov\tr4, sp
\tstrb\tr0, [r4, #0x4]
\tldrsb\tr1, [r4, #0x4]
\tldrb\tr2, [r4, #0x4]
\tsub\tr0, r1, r2
\tadd\tsp, sp, #0x10
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;
    expect(() => lift(bothSigns)).toThrow(/disagree on signedness/);
  });

  test('an escape alongside a SECOND object declines', () => {
    // A callee handed one frame address may write any offset from it, and two objects are two
    // separate C locals — so a callee that writes past the one it was given reaches the other on
    // the machine and nothing at all in the emitted source.
    expect(() => lift(SPILL)).not.toThrow();
    const escapes = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x10
\tmov\tr3, sp
\tstrh\tr0, [r3, #0x4]
\tmov\tr0, sp
\tmov\tr3, #0x0
\tstrb\tr3, [r0]
\tmov\tr1, #0x0
\tmov\tr2, #0x10
\tbl\tmemset
\tmov\tr3, sp
\tldrh\tr0, [r3, #0x4]
\tadd\tsp, sp, #0x10
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;
    expect(() => lift(escapes)).toThrow(/including another object/);
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
