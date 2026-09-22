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

  // An object with NO access of its own has no declared type and no extent — but the two ways it
  // gets there are two different gaps, and one refusal for both makes them look like one.
  test('an unpinned object over a byte the slot model already keys names the double model', () => {
    // the word-slot model keeps [sp,#0] in a register, and the capture publishes the same
    // address. The storage is keyed twice, and that is decidable from the object's FIRST BYTE
    // alone — an extent it does not have is not needed to see the disagreement.
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() => lift(frame('\tstr\tr0, [sp]\n\tldr\tr2, [sp]\n\tmov\tr1, sp\n\tbl\tg\n\tadd\tr0, r0, r2\n'))).toThrow(
      /overlaps the SSA slot at \[sp,#0\] — one byte, two models/,
    );
  });

  test('an unpinned object with no slot beneath it is unpinned, and says only that', () => {
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() => lift(frame('\tmov\tr0, sp\n\tbl\tg\n'))).toThrow(
      /the captured address is never dereferenced in this function/,
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

  // THE RESERVATION AS AN EXTENT. An object with no access of its own is untyped, but a frame
  // reserved for it alone still says how many BYTES it is — and bytes are all a block copy needs.
  // Every refusal below runs the accepted fixture first, so a decline for an unrelated reason
  // cannot read as a pass.
  describe('a frame reserved for one untyped object is that object`s extent', () => {
    // `memcpy(sp, a0, 16)` over a 16-byte frame: the buffer is filled by the callee and never read
    // here, so no access in this function types it. agbcc's own shape for `u8 b[0x10];
    // memcpy(b, src, sizeof b);`.
    const copy = (body: string, reserve = '0x10') =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-${reserve}\n${body}\tadd\tsp, sp, #${reserve}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    const FILL = '\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n';

    test('the reservation is the declared extent, and it declares as an array', () => {
      expect(lift(copy(FILL)).source).toBe('s32 f(s32 a0) {\n    u8 sp0[16];\n    return memcpy(sp0, a0, 16);\n}\n');
    });

    test('the extent follows the reservation, not the copy length', () => {
      // the `mov r2, #0x10` is an ARGUMENT, not evidence about the object — a 32-byte frame
      // copied into for 16 bytes is still a 32-byte object
      expect(lift(copy(FILL, '0x20')).source).toContain('u8 sp0[32];');
    });

    const CALL_G = '\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n\tbl\tg\n';

    test('an undeclared callee is no witness: nothing says what it returns', () => {
      // a hidden struct-return pointer occupies argument 0 exactly like an out-parameter does,
      // and `g` is a callee nothing has said anything about
      expect(() => lift(copy(CALL_G))).toThrow(/`g` takes it at argument 0 and nothing says what that callee returns/);
    });

    test('…and the project`s own `returnsVoid` supplies it', () => {
      // the same acceptance `memcpy` reaches through the standard-signature table, reached here
      // through a header instead
      const withProto = decompile('f', copy(CALL_G), ARMV4T_AGBCC, {
        prototypes: { g: { params: 3, returnsVoid: true } },
      });
      expect(withProto.source).toContain('u8 sp0[16];');
    });

    test('an ARITY is not a statement about the return, and does not witness', () => {
      // three declared parameters against the three argument registers the call sets: the count
      // agrees exactly, and it still says nothing about whether `g` returns through a pointer
      expect(() => decompile('f', copy(CALL_G), ARMV4T_AGBCC, { prototypes: { g: { params: 3 } } })).toThrow(
        /`g` takes it at argument 0 and nothing says what that callee returns/,
      );
    });

    test('the argument registers a call WROTE cannot witness it — a pass-through parameter is written by nobody', () => {
      // agbcc's own output for `void f(const void *a, const void *b){ struct Blob64 s =
      // makeblob(b); }`: the callee's declared argument arrives in r1 already, so the only
      // register the function writes is the hidden return pointer in r0. One written register
      // against one declared parameter — a count that agrees while the frame is the CALLEE's.
      expect(() =>
        decompile(
          'f',
          'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x40\n\tmov\tr0, sp\n\tbl\tmakeblob\n' +
            '\tadd\tsp, sp, #0x40\n\tpop\t{r0}\n\tbx\tr0\n',
          ARMV4T_AGBCC,
          { prototypes: { makeblob: { params: 1 } } },
        ),
      ).toThrow(/`makeblob` takes it at argument 0 and nothing says what that callee returns/);
    });

    test('a ONE-WORD frame reaches the extent rule through both arms, and declares its bytes', () => {
      // the reserved area is one word, so `capturedObjectIsTheWholeFrame` holds AND the object
      // has no access of its own — the two arms ask the same question of the same callee and the
      // answer has to be the same one. What it declares is the RESERVATION, not the declared
      // parameter's pointee: a declared width vetoes and never pins (proto.ts `ParamType`).
      const oneWord =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tbl\tfill\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      // the one-word arm asks first, so ITS refusal is the one that fires — the same fact, named
      // at the earlier site
      expect(() => decompile('f', oneWord, ARMV4T_AGBCC, { prototypes: { fill: { params: ['s32 *'] } } })).toThrow(
        /the one-word frame is handed to a callee as argument 0 and never written here/,
      );
      expect(
        decompile('f', oneWord, ARMV4T_AGBCC, { prototypes: { fill: { params: ['s32 *'], returnsVoid: true } } })
          .source,
      ).toContain('u8 sp0[4];');
    });

    test('an array object`s address is spelled by DECAY, not by `&`', () => {
      // `&sp0` on `u8 sp0[16]` is a `u8 (*)[16]` — the same byte at a type every typed pointer
      // parameter rejects. Compiled at the corpus's agbcc flags, `fill(&sp0)` against
      // `void fill(u8 *)` warns `passing arg 1 of 'fill' from incompatible pointer type` and
      // `fill(sp0)` does not, and the two objects are byte-identical — so the `&` buys the
      // diagnostic and nothing else. A SCALAR still takes it: `&sp0` is the only spelling there.
      expect(lift(copy(FILL)).source).toContain('memcpy(sp0, a0, 16)');
      // the SCALAR control, one letter of asm apart: a store of its own types the object, so it
      // declares as `s32 sp0` and `&` is the only spelling of its address
      const typed = copy('\tmov\tr3, sp\n\tstr\tr0, [r3]\n\tmov\tr0, sp\n\tbl\tg\n', '0x4');
      expect(lift(typed).source).toContain('g(&sp0)');
    });

    test('a slot in the reserved area is not this object`s, and refuses', () => {
      expect(() => lift(copy(`\tstr\tr0, [sp, #0xc]\n${FILL}\tldr\tr0, [sp, #0xc]\n`))).toThrow(
        /the slot model keys \[sp,#12\], so part of the reserved area is not this object/,
      );
    });

    test('a second address-taken object means the reservation is not this one`s', () => {
      const withNeighbour = '\tmov\tr3, sp\n\tstrh\tr1, [r3, #0xc]\n\tmov\tr3, sp\n\tldrh\tr4, [r3, #0xc]\n';
      expect(() => lift(copy(withNeighbour + FILL))).toThrow(
        /another address-taken object shares the frame, so the reservation is not this one alone/,
      );
    });

    // THE CLAUSES NOTHING REACHES, pinned as unreachable rather than left unstated. Each is a
    // precaution in `notTheWholeArea`, and each is unreachable because an EARLIER refusal owns
    // the shape — these assert that the earlier refusal is the one that fires, so a change that
    // relaxes one of them shows up here as a message that moved.
    test('a computed capture declines before the extent is ever considered', () => {
      // `off` can only be 0 for an untyped object because this is what happens to any other
      // spelling — the clause guarding a nonzero offset is precaution, not a live rule
      expect(() => lift(copy('\tadd\tr1, r0, #0\n\tadd\tr0, sp, #0x4\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n'))).toThrow(
        /only a plain `mov rD, sp` capture is modelled/,
      );
    });

    test('a capture that neither accesses nor escapes declines where its uses are classified', () => {
      expect(() => lift(copy('\tmov\tr0, sp\n'))).toThrow(
        /the captured address flows into `ret` — not an access, an escape, or a phi/,
      );
    });
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
