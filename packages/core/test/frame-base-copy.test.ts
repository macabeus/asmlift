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
    expect(lift(SPILL).source).toBe('s32 f(u16 *a0) {\n    u16 sp4;\n    sp4 = *a0;\n    g(a0);\n    return sp4;\n}\n');
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

  test('a capture MOVED BY A CONSTANT is the capture of that offset', () => {
    // `mov r2, sp / add r2, r2, #0x8` is how `sa3:ProcessOamBuffers` spells `&local` at [sp,#8];
    // the two-operand `add rD, #k` moves rD itself. Either way the object is at the sum, and the
    // `mov` left behind names nothing.
    const moved = (move: string) =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr2, sp\n${move}\tstrh\tr0, [r2]\n\tbl\tg\n` +
      `\tmov\tr2, sp\n${move}\tldrh\tr0, [r2]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    const want = 's32 f(s32 a0) {\n    u16 sp4;\n    sp4 = a0;\n    g(a0);\n    return sp4;\n}\n';
    expect(lift(moved('\tadd\tr2, r2, #0x4\n')).source).toBe(want);
    expect(lift(moved('\tadd\tr2, #0x4\n')).source).toBe(want);
    // a move DOWN is not one: nothing spells a negative frame offset, and `sub` stays arithmetic
    expect(() => lift(moved('\tsub\tr2, #0x4\n'))).toThrow(/the captured address flows into `sub`/);
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

  // A capture that was not split is refused with ITS OWN reason. Two captures here: [sp,#0]'s word
  // access is the word refusal, and [sp,#8]'s byte access is refused because that capture also
  // escapes — which the word refusal, reported against it, would misname.
  test('an access through a capture is refused with that capture’s reason', () => {
    const two =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr5, sp, #0x8\n\tstrb\tr1, [r5, #0x1]\n' +
      '\tmov\tr4, sp\n\tstr\tr0, [r4, #0x4]\n\tmov\tr0, r5\n\tbl\tg\n\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5}\n' +
      '\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('f', two, ARMV4T_AGBCC, { prototypes: { g: { params: 1, returnsVoid: true } } })).toThrow(
      /a store at \[\+1\] through the captured address — only a scalar at the captured address is modelled/,
    );
  });

  // …and two captures at ONE offset are two captures. Every direct `[sp,#4]` word access is one of
  // its own, refused for its width; the escaping `add r4, sp, #0x4` beside them reads `[r4, #0x2]`,
  // which no word access touches. agbcc's own output for `struct Q { u8 a; u8 b; u16 c; }; u32
  // e1(u32 x, u32 y){ struct Q q; q.a = x; q.b = y; q.c = x + y; five(x, y, x, y, x); g(&q);
  // return q.a + q.c; }`, at the corpus's flags.
  test('a capture at an offset another capture shares is refused with its own reason', () => {
    const e1 =
      'e1:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r0, #0\n\tadd\tr3, r1, #0\n\tlsl\tr1, r2, #0x18\n' +
      '\tlsr\tr1, r1, #0x18\n\tldr\tr4, .L3\n\tldr\tr0, [sp, #0x4]\n\tand\tr0, r0, r4\n\torr\tr0, r0, r1\n' +
      '\tlsl\tr1, r3, #0x18\n\tlsr\tr1, r1, #0x10\n\tldr\tr4, .L3+0x4\n\tand\tr0, r0, r4\n\torr\tr0, r0, r1\n' +
      '\tadd\tr1, r2, r3\n\tlsl\tr1, r1, #0x10\n\tldr\tr4, .L3+0x8\n\tand\tr0, r0, r4\n\torr\tr0, r0, r1\n' +
      '\tstr\tr0, [sp, #0x4]\n\tstr\tr2, [sp]\n\tadd\tr0, r2, #0\n\tadd\tr1, r3, #0\n\tbl\tfive\n' +
      '\tadd\tr4, sp, #0x4\n\tadd\tr0, r4, #0\n\tbl\tg\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n' +
      '\tldrh\tr1, [r4, #0x2]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t-0x100\n\t.word\t-0xff01\n\t.word\t0xffff\n';
    const prototypes = { five: { params: 5, returnsVoid: true }, g: { params: 1, returnsVoid: true } };
    expect(() => decompile('e1', e1, ARMV4T_AGBCC, { prototypes })).toThrow(
      /a load at \[\+2\] through the captured address — only a scalar at the captured address is modelled/,
    );
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
    // The reload lands in r4, not r2: r4 is callee-saved, and a caller-saved register read back
    // after the `bl` is a value the callee destroyed (frontend/ssa.ts), which would refuse this
    // function ahead of the audit and hide what it is here to show.
    expect(() => lift(frame('\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tmov\tr1, sp\n\tbl\tg\n\tadd\tr0, r0, r4\n'))).toThrow(
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

    // WHERE THE ADDRESS WENT ACQUITS A CALL, not an object. A hidden return pointer is argument 0
    // and nothing else, so a call that took the buffer at argument 1 cannot be one whatever it
    // returns — and a second call that took it at argument 0 is left exactly as ambiguous.
    test('a buffer handed over at argument 1 needs no statement about the return', () => {
      // `void f(void *dst){ u8 b[0x10]; g(dst, b, sizeof b); }`. `g` is declared with an arity and
      // nothing else: three parameters place the buffer at argument 1, and what `g` returns stays
      // unsaid because no hidden pointer is ever passed there.
      const atArg1 = copy('\tmov\tr1, sp\n\tmov\tr2, #0x10\n\tbl\tg\n');
      expect(decompile('f', atArg1, ARMV4T_AGBCC, { prototypes: { g: { params: 3 } } }).source).toContain(
        'u8 sp0[16];',
      );
    });

    test('…and a second call taking it at argument 0 is still unaccounted for', () => {
      const alsoAtArg0 = copy('\tmov\tr1, sp\n\tmov\tr2, #0x10\n\tbl\tg\n\tmov\tr0, sp\n\tbl\th\n');
      expect(() => decompile('f', alsoAtArg0, ARMV4T_AGBCC, { prototypes: { g: { params: 3 } } })).toThrow(
        /`h` takes it at argument 0 and nothing says what that callee returns/,
      );
    });

    test('an address that only reaches memory says so, and is not called an argument', () => {
      // published to a global and handed to no callee: nothing declares what reads it, which is a
      // different gap from a callee whose return is unknown, and reads as a different refusal
      const published =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x10\n\tldr\tr3, .L2\n\tmov\tr2, sp\n\tstr\tr2, [r3]\n' +
        '\tadd\tsp, sp, #0x10\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L2:\n\t.word\tgPtr\n';
      expect(() => lift(published)).toThrow(/the address is published rather than passed as an argument/);
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
        /the one-word frame is never written here, and `fill` takes it at argument 0/,
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

    test('an object that is BOTH published and passed keeps the published spelling', () => {
      // `volatile` keys on PUBLICATION, and an untyped object reaches that rule too: the address
      // goes to a global AND to a callee whose return is declared, so the extent arm accepts and
      // the qualifier lands on an array. It cannot pay volatile's codegen here — the rule's cost
      // is a read the compiler may no longer fold, and this object has no access at all in the
      // function (compiled at the corpus's agbcc flags, the volatile and plain spellings produce
      // BYTE-IDENTICAL objects; the difference is two `discards qualifiers` warnings).
      const publishedAndPassed =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x10\n\tldr\tr3, .L2\n\tmov\tr2, sp\n\tstr\tr2, [r3]\n' +
        '\tmov\tr0, sp\n\tbl\tvf\n\tadd\tsp, sp, #0x10\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L2:\n\t.word\tgPtr\n';
      expect(
        decompile('f', publishedAndPassed, ARMV4T_AGBCC, { prototypes: { vf: { params: 1, returnsVoid: true } } })
          .source,
      ).toContain('volatile u8 sp0[16];');
    });

    test('a slot in the reserved area is not this object`s, and refuses', () => {
      expect(() => lift(copy(`\tstr\tr0, [sp, #0xc]\n${FILL}\tldr\tr0, [sp, #0xc]\n`))).toThrow(
        /the object at \[sp,#0\) overlaps the SSA slot at \[sp,#12\] — one byte, two models/,
      );
    });

    test('a second address-taken object means the reservation is not this one`s', () => {
      const withNeighbour = '\tmov\tr3, sp\n\tstrh\tr1, [r3, #0xc]\n\tmov\tr3, sp\n\tldrh\tr4, [r3, #0xc]\n';
      expect(() => lift(copy(withNeighbour + FILL))).toThrow(
        /another address-taken object shares the frame, so the reservation is not this one alone/,
      );
    });

    // A RUNTIME INDEX into the untyped storage. agbcc's own output for `u32 pick(u32 i){ u8 a[8];
    // memcpy(a, tbl, 8); return a[i]; }` (and `a[i] = v` for the store), at the corpus's flags.
    describe('a runtime index reads one byte element of the untyped storage', () => {
      const indexed = (access: string) =>
        copy(
          '\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x8\n\tbl\tmemcpy\n' +
            `\tmov\tr1, sp\n\tadd\tr0, r1, r4\n${access}`,
          '0x8',
        ) + '.L3:\n\t.word\ttbl\n';

      test('a byte load at the indexed address is an element of the declared bytes', () => {
        expect(lift(indexed('\tldrb\tr0, [r0]\n')).source).toContain('u8 sp0[8];');
        expect(lift(indexed('\tldrb\tr0, [r0]\n')).source).toContain('((u8 *)sp0)[a0]');
      });

      test('a byte store at the indexed address is one too', () => {
        expect(lift(indexed('\tstrb\tr5, [r0]\n\tmov\tr0, #0x0\n')).source).toContain('((u8 *)sp0)[a0] = a1;');
      });

      test('a wider element is another array over the same bytes, and declines naming its width', () => {
        // `u16 a[4]; … return a[i];` — agbcc scales the index and reads a halfword
        expect(() => lift(indexed('\tldrh\tr0, [r0]\n'))).toThrow(
          /a runtime index into the object at \[sp,#0\) accesses 2 bytes/,
        );
      });

      test('an indexed address that is not only accessed declines', () => {
        expect(() => lift(indexed('\tbl\tuse\n'))).toThrow(
          /a runtime index into the object at \[sp,#0\) flows into `call`/,
        );
        expect(() => lift(indexed('\tldrb\tr0, [r0, #0x1]\n'))).toThrow(/flows into `load`/);
      });

      // …and the storage need not escape: its own indexed stores write it. agbcc's own output for
      // `u32 f(u32 i){ u8 a[8]; u32 j; for (j = 0; j < 8; j++) a[j] = tbl[j]; return a[i]; }`.
      test('an indexed object that never escapes is written by its own indexed stores', () => {
        const local =
          'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tmov\tr2, #0x0\n\tldr\tr3, .L8\n' +
          '.L6:\n\tmov\tr1, sp\n\tadd\tr0, r1, r2\n\tadd\tr1, r2, r3\n\tldrb\tr1, [r1]\n\tstrb\tr1, [r0]\n' +
          '\tadd\tr2, r2, #0x1\n\tcmp\tr2, #0x7\n\tbls\t.L6\n\tmov\tr1, sp\n\tadd\tr0, r1, r4\n\tldrb\tr0, [r0]\n' +
          '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L8:\n\t.word\ttbl\n';
        const src = lift(local).source;
        expect(src).toContain('u8 sp0[8];');
        expect(src).toContain('((u8 *)sp0)[v0] = ((u8 *)&tbl)[v0];');
        expect(src).toContain('return ((u8 *)sp0)[a0];');
      });

      test('an object an access of its own types as a scalar is not indexed', () => {
        expect(() => lift(indexed('\tldrb\tr0, [r0]\n\tmov\tr1, sp\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1\n'))).toThrow(
          /a runtime index into the object at \[sp,#0\), which an access of its own types as one scalar/,
        );
      });
    });

    test('an object that does not start at the bottom of the area is not the whole area', () => {
      // `add rD, sp, #k` names an object at [sp,#k), so the bytes below it are something else
      expect(() => lift(copy('\tadd\tr1, r0, #0\n\tadd\tr0, sp, #0x4\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n'))).toThrow(
        /the object does not start at the bottom of the declared area/,
      );
    });

    // AN OUTGOING BLOCK BELOW THE OBJECT. agbcc stages arguments 5+ of a call at the bottom of the
    // frame and lays every local above them, so `struct S t; g(&t, 0, 0, 0, 8, 2, 15, a0);` with
    // an 8-byte `S` reserves 0x18 and puts `t` at [sp,#0x10], over four argument words. The
    // declared range — the frame less the licensed block — is the object's extent.
    describe('above a licensed outgoing block, the declared range is the extent', () => {
      const protos = { prototypes: { g: { params: 8, returnsVoid: true }, h: { params: 1, returnsVoid: true } } };
      const STAGED =
        '\tmov\tr1, #0x8\n\tstr\tr1, [sp]\n\tmov\tr1, #0x2\n\tstr\tr1, [sp, #0x4]\n' +
        '\tmov\tr1, #0xf\n\tstr\tr1, [sp, #0x8]\n\tstr\tr0, [sp, #0xc]\n';
      const fill = (at = '0x10', staged = STAGED) =>
        copy(
          `${staged}\tadd\tr0, sp, #${at}\n\tmov\tr1, #0x0\n\tmov\tr2, #0x0\n\tmov\tr3, #0x0\n\tbl\tg\n` +
            `\tadd\tr0, sp, #${at}\n\tbl\th\n`,
          '0x18',
        );
      const liftWith = (asm: string) => decompile('f', asm, ARMV4T_AGBCC, protos);

      test('the object above the argument words is declared over the rest of the frame', () => {
        const src = liftWith(fill()).source;
        expect(src).toContain('u8 sp16[8];');
        expect(src).toContain('g(sp16, 0, 0, 0, 8, 2, 15, a0);');
        expect(src).toContain('h(sp16);');
      });

      test('an object above the bottom of the declared range is not the whole of it', () => {
        expect(() => liftWith(fill())).not.toThrow();
        expect(() => liftWith(fill('0x14'))).toThrow(/the object does not start at the bottom of the declared area/);
      });

      test('a slot inside the declared range is not this object`s', () => {
        // a local kept across the call at [sp,#0x14], above the argument words
        expect(() => liftWith(fill())).not.toThrow();
        const kept = `${STAGED}\tstr\tr4, [sp, #0x14]\n`;
        expect(() => liftWith(fill('0x10', kept).replace('\tbl\th\n', '\tbl\th\n\tldr\tr0, [sp, #0x14]\n'))).toThrow(
          /the object at \[sp,#16\) overlaps the SSA slot at \[sp,#20\] — one byte, two models/,
        );
      });

      test('a second object above the block means the reservation is not this one`s', () => {
        expect(() => liftWith(fill())).not.toThrow();
        const two = fill().replace('\tadd\tr0, sp, #0x10\n\tbl\th\n', '\tadd\tr0, sp, #0x14\n\tbl\th\n');
        expect(() => liftWith(two)).toThrow(/another address-taken object shares the frame/);
      });

      test('a block not stored on every path licenses nothing, and declines', () => {
        expect(() => liftWith(fill())).not.toThrow();
        const oneArmed = STAGED.replace(
          '\tstr\tr0, [sp, #0xc]\n',
          '\tcmp\tr0, #0x0\n\tbeq\t.L1\n\tstr\tr0, [sp, #0xc]\n.L1:\n',
        );
        expect(() => liftWith(fill('0x10', oneArmed))).toThrow(/\[sp,#12\] is not stored on every path to the call/);
      });
    });

    // THE CLAUSE NOTHING REACHES, pinned as unreachable rather than left unstated: the precaution
    // in `notTheWholeArea` is unreachable because an EARLIER refusal owns the shape — this asserts
    // that the earlier refusal is the one that fires, so a change that relaxes it shows up here as
    // a message that moved.
    test('a capture that neither accesses nor escapes declines where its uses are classified', () => {
      expect(() => lift(copy('\tmov\tr0, sp\n'))).toThrow(
        /the captured address flows into `ret` — not an access, an escape, or a phi/,
      );
    });
  });

  test('an object past the reserved local area declines', () => {
    // above the local area is the callee-saved block the epilogue pops, then the caller's frame
    expect(() => lift(DISJOINT)).not.toThrow();
    expect(() => lift(frame(OBJ.replace(/#0x4/g, '#0x8')))).toThrow(
      /the captured address at \[sp,#8\) is the top of the reserved local area of 8 bytes — one past the end/,
    );
    // …and one that STARTS inside it and runs past its top is refused for its width
    const straddle = '\tmov\tr3, sp\n\tstrh\tr1, [r3, #0x7]\n\tmov\tr3, sp\n\tldrh\tr0, [r3, #0x7]\n';
    expect(() => lift(frame(straddle))).toThrow(
      /the object at \[sp,#7\) of width 2 lies outside the reserved local area/,
    );
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
