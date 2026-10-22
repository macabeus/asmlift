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
import { enumerateCandidates } from '../src/rank';
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

// `g` takes the one argument a guess would count, declared: undeclared, `SPILL`'s r2 and r3 hold
// values past an r1 nothing set, a gap the guessed arity refuses (frontend/ssa.ts `fallbackArgc`).
const lift = (asm: string) => decompile('f', asm, ARMV4T_AGBCC, { prototypes: { g: { params: 1 } } });
const liftUndeclared = (asm: string) => decompile('f', asm, ARMV4T_AGBCC);

// THE PER-OBJECT REFUSALS STAND WHERE THE ONE-OBJECT ANSWER CANNOT HOLD A WRITER. A callee handed a
// captured address that may write through it is a writer that answer holds, and so is a store of
// that same address beside the call, so a fixture whose writers are those lifts the whole declared
// area as one byte array instead. Two writers it cannot hold are used here: an address stored to
// memory that no callee is handed — this publishes the frame address at `off` to a global — and a
// callee taking one at argument 0 with nothing said of what it returns; each refusal here is judged
// per object beside one of them, or with nothing reaching the frame without bound. `r2`/`r3` are
// free at entry where this is used.
const alsoPublished = (asm: string, off = 0): string =>
  asm.replace(
    /(\tadd\tsp, sp, #-0x[0-9a-f]+\n)/,
    `$1\tldr\tr3, .Lpub\n\t${off === 0 ? 'mov\tr2, sp' : `add\tr2, sp, #0x${off.toString(16)}`}\n\tstr\tr2, [r3]\n`,
  ) + '.Lpub:\n\t.word\tgPtr\n';
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
    // The `ldr r3, [r0, #0x4]` nothing uses is no access of the frame object: `g` is declared to
    // take r0 alone, so it is a read nothing uses, kept (frontend/dead-reads.ts).
    expect(lift(SPILL).source).toBe(
      'struct Struct0 { u16 field_0; s32 field_4; };\ns32 f(struct Struct0 *a0) {\n    u16 sp4;\n' +
        '    sp4 = a0->field_0;\n    ((volatile struct Struct0 *)a0)->field_4;\n    g(a0);\n    return sp4;\n}\n',
    );
    // …and undeclared, the same load left in r3 past an r1 nothing set is a gap the guess refuses
    expect(() => liftUndeclared(SPILL)).toThrow(
      /the call 'bl g' in block 'f' has no prototype, r2 holds a value and r1 holds none/,
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

  test('a capture MOVED BY A CONSTANT is the capture of that offset', () => {
    // `mov r2, sp / add r2, r2, #0x8` is how `sa3:ProcessOamBuffers` spells `&local` at [sp,#8];
    // the two-operand `add rD, #k` moves rD itself. Either way the object is at the sum, and the
    // `mov` left behind names nothing.
    const moved = (move: string) =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr2, sp\n${move}\tstrh\tr0, [r2]\n\tbl\tg\n` +
      `\tmov\tr2, sp\n${move}\tldrh\tr0, [r2]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    // `g` is declared: the capture is still in r2 at the `bl`, past a guessed arity that stops at
    // r1, and an undeclared `g` might be handed it (a gap the guess refuses, `fallbackArgc`).
    const G1 = { prototypes: { g: { params: 1 } } };
    const want = 's32 f(s32 a0) {\n    u16 sp4;\n    sp4 = a0;\n    g(a0);\n    return sp4;\n}\n';
    expect(decompile('f', moved('\tadd\tr2, r2, #0x4\n'), ARMV4T_AGBCC, G1).source).toBe(want);
    expect(decompile('f', moved('\tadd\tr2, #0x4\n'), ARMV4T_AGBCC, G1).source).toBe(want);
    expect(() => liftUndeclared(moved('\tadd\tr2, #0x4\n'))).toThrow(
      /the call 'bl g' in block 'f' has no prototype, r2 holds a value and r1 holds none/,
    );
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
    // …so a store through a copy that reaches a call unread is refused as that call's argument
    expect(() => lift(outgoing)).toThrow(
      /the 4-byte store at \[sp,#4\) through a captured address reaches the call to `g` unread on every path/,
    );
  });

  // A capture that was not split is refused with ITS OWN reason. Two captures here: [sp,#0]'s word
  // access is the word refusal, and [sp,#8]'s byte access is refused because that capture also
  // escapes — which the word refusal, reported against it, would misname.
  test('an access through a capture is refused with that capture’s reason', () => {
    const two =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr5, sp, #0x8\n\tstrb\tr1, [r5, #0x1]\n' +
      '\tmov\tr4, sp\n\tstr\tr0, [r4, #0x4]\n\tmov\tr0, r5\n\tbl\tg\n\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5}\n' +
      '\tpop\t{r0}\n\tbx\tr0\n';
    const prototypes = { g: { params: 1, returnsVoid: true } };
    expect(() => decompile('f', alsoPublished(two), ARMV4T_AGBCC, { prototypes })).toThrow(
      /a store at \[\+1\] through the captured address — only a scalar at the captured address is modelled/,
    );
    // …and with the callee the only writer, the word nothing reads before `g` may be `g`'s stack
    // argument — a stated parameter list is a lower bound…
    expect(() => decompile('f', two, ARMV4T_AGBCC, { prototypes })).toThrow(
      /the 4-byte store at \[sp,#4\) through a captured address reaches the call to `g` unread on every path/,
    );
    // …and read back after the call it is a local, and both members are bytes of the one object
    const readBack = two.replace('\tbl\tg\n', '\tbl\tg\n\tldr\tr0, [r4, #0x4]\n');
    const kept = decompile('f', readBack, ARMV4T_AGBCC, { prototypes }).source;
    expect(kept).toContain('u8 sp0[16];');
    expect(kept).toContain('((u8 *)sp0)[9] = a1;');
    expect(kept).toContain('g((u32)sp0 + 8);');
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
    // `g` saying nothing of what it returns is a writer the one object cannot hold, and the refusal
    // names it beside the shape
    expect(() =>
      decompile('e1', e1, ARMV4T_AGBCC, { prototypes: { five: prototypes.five, g: { params: 1 } } }),
    ).toThrow(
      /a load at \[\+2\] through the captured address — only a scalar at the captured address is modelled — and the one object cannot hold every writer: the captured address at \[sp,#4\): `g` takes it at argument 0/,
    );
    // …and kept as one object, the word, the byte and the halfword at one address are the views
    // of one union, each access made through its own
    const kept = decompile('e1', e1, ARMV4T_AGBCC, { prototypes }).source;
    expect(kept).toContain('    union { s32 word; u16 half[2]; u8 byte[4]; } sp4;');
    expect(kept).toContain('g(&sp4);');
    expect(kept).toContain('sp4.half[1]');
  });

  test('a capture that ESCAPES keeps the frame base', () => {
    expect(() => lift(SPILL)).not.toThrow();
    // `g` declared to take `a0` alone, so the capture still in r3 at the call is not handed to it
    // and the escape is the store's (undeclared, the gap past r1 refuses first, `fallbackArgc`)
    const escaped = edit('\tldr\tr3, [r0, #0x4]\n', '\tstr\tr3, [r0, #0x4]\n');
    expect(() => lift(escaped)).toThrow(CAPTURE);
    expect(() => liftUndeclared(escaped)).toThrow(
      /the call 'bl g' in block 'f' has no prototype, r2 holds a value and r1 holds none/,
    );
  });

  test('a REGISTER-offset access through a capture keeps the frame base', () => {
    // the offset is not known, so which frame bytes the access names is not known either; the
    // lowering makes the capture flow into an `add`, which the per-object model refuses…
    expect(() => lift(SPILL)).not.toThrow();
    const indexedStore = edit('\tstrh\tr2, [r3, #0x4]\n', '\tstrh\tr2, [r3, r1]\n');
    expect(() => lift(alsoPublished(indexedStore))).toThrow(CAPTURE);
    // …and where nothing escapes, the frame is one object the store indexes at a byte offset
    expect(lift(indexedStore).source).toContain('*(u16 *)((u32)sp0 + a1) = a0->field_0;');
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
    expect(() => lift(alsoPublished(bothSigns, 4))).toThrow(/disagree on signedness/);
    // …and where nothing escapes, one object whose byte is read through both character types,
    // which alias everything
    expect(lift(bothSigns).source).toContain('return ((s8 *)sp0)[4] - ((u8 *)sp0)[4];');
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

  test('an object overlapping an SSA slot is never two models', () => {
    // the slot model keeps [sp,#4] in a register, so a store through the object would never be
    // seen there — the two models would disagree about the same four bytes, silently. Where an
    // escape names a writer the one object cannot hold, that refuses (the next test, `atArg0`);
    // where nothing escapes, the bytes are kept as one object in memory and judged by its rules —
    // here a word and a halfword at one byte, the two views of one union, every store kept
    expect(() => lift(DISJOINT)).not.toThrow();
    const over = frame(`\tstr\tr0, [sp, #0x4]\n${OBJ}\tldr\tr2, [sp, #0x4]\n\tadd\tr0, r0, r2\n`);
    expect(lift(over).source).toContain(
      '    union { s32 word[2]; u16 half[4]; } sp0;\n    sp0.word[1] = a0;\n    sp0.half[2] = a1;\n' +
        '    return sp0.half[2] + sp0.word[1];',
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
    const keyed = frame('\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tmov\tr1, sp\n\tbl\tg\n\tadd\tr0, r0, r4\n');
    // handed at argument 0 to a `g` nothing says the return of, the one object cannot hold it
    const atArg0 = keyed.replace('\tmov\tr1, sp\n', '\tmov\tr0, sp\n');
    expect(() => lift(atArg0)).toThrow(
      /overlaps the SSA slot at \[sp,#0\] — one byte, two models — and the one object cannot hold every writer/,
    );
    // …and with a callee it holds the only writer, the slot is a word of the one object in memory
    expect(lift(keyed).source).toContain('*(s32 *)sp0 = a0;');
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
    const sharing = frame(
      '\tmov\tr3, sp\n\tstr\tr1, [r3]\n\tmov\tr3, sp\n\tldr\tr0, [r3]\n' +
        '\tmov\tr2, sp\n\tstrh\tr1, [r2, #0x2]\n\tmov\tr2, sp\n\tldrh\tr2, [r2, #0x2]\n\tadd\tr0, r0, r2\n',
    );
    expect(() => lift(alsoPublished(sharing))).toThrow(/overlap — one byte, two models/);
    // …and where nothing escapes, they are the views of one union, the halfword store between the
    // word's load and the halfword's own
    expect(lift(sharing).source).toContain(
      '    sp0.word[0] = a1;\n    v0 = sp0.word[0];\n    sp0.half[1] = a1;\n    return v0 + sp0.half[1];',
    );
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
    // A READER its control word bounds: a 32-bit CpuSet fill reads one word at the object's address
    // and writes none of the frame. With nothing reaching the frame without bound the one-object
    // answer is never on offer, so a refusal beside it is the per-object model's own.
    const READ = '\tmov\tr0, sp\n\tldr\tr1, .Lsrc\n\tldr\tr2, .Lsrc+0x4\n\tbl\tCpuSet\n';
    const readOnly = (asm: string) =>
      decompile('f', `${asm}.Lsrc:\n\t.word\tgDst\n\t.word\t0x05000004\n`, ARMV4T_AGBCC, {
        prototypes: { CpuSet: { params: 3, returnsVoid: true } },
      });
    // an indexed object that never escapes (agbcc's own output, quoted at its test below): nothing
    // outside the function reaches the frame at all
    const LOCAL =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tmov\tr2, #0x0\n\tldr\tr3, .L8\n' +
      '.L6:\n\tmov\tr1, sp\n\tadd\tr0, r1, r2\n\tadd\tr1, r2, r3\n\tldrb\tr1, [r1]\n\tstrb\tr1, [r0]\n' +
      '\tadd\tr2, r2, #0x1\n\tcmp\tr2, #0x7\n\tbls\t.L6\n\tmov\tr1, sp\n\tadd\tr0, r1, r4\n\tldrb\tr0, [r0]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L8:\n\t.word\ttbl\n';
    const atTheIndexedRead = (asm: string) => LOCAL.replace('\tldrb\tr0, [r0]\n\tadd\tsp', `${asm}\tadd\tsp`);

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
      const keyed = copy(`\tstr\tr0, [sp, #0xc]\n${FILL}\tldr\tr0, [sp, #0xc]\n`);
      expect(() => readOnly(copy(`\tstr\tr0, [sp, #0xc]\n${READ}\tldr\tr0, [sp, #0xc]\n`))).toThrow(
        /the object at \[sp,#0\) overlaps the SSA slot at \[sp,#12\] — one byte, two models$/,
      );
      // …kept as one object, the slot is a word of it, reloaded after the copy wrote it
      expect(lift(keyed).source).toContain('memcpy(sp0, a0, 16);\n    return ((s32 *)sp0)[3];');
    });

    test('a second address-taken object means the reservation is not this one`s', () => {
      const withNeighbour = '\tmov\tr3, sp\n\tstrh\tr1, [r3, #0xc]\n\tmov\tr3, sp\n\tldrh\tr4, [r3, #0xc]\n';
      expect(() => readOnly(copy(withNeighbour + READ))).toThrow(
        /another address-taken object shares the frame, so the reservation is not this one alone$/,
      );
      // …kept as one object, the neighbour is a halfword of it
      expect(lift(copy(withNeighbour + FILL)).source).toContain('((u16 *)sp0)[6] = a1;');
    });

    // A RUNTIME INDEX into the untyped storage. agbcc's own output for `u32 pick(u32 i){ u8 a[8];
    // memcpy(a, tbl, 8); return a[i]; }` (and `a[i] = v` for the store), at the corpus's flags.
    describe('a runtime index reads an element of the untyped storage', () => {
      const indexed = (access: string) =>
        copy(
          '\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x8\n\tbl\tmemcpy\n' +
            `\tmov\tr1, sp\n\tadd\tr0, r1, r4\n${access}`,
          '0x8',
        )
          // r5 holds the stored value, so this one saves it too
          .replace('\tpush\t{r4, lr}\n', '\tpush\t{r4, r5, lr}\n')
          .replace('\tpop\t{r4}\n', '\tpop\t{r4, r5}\n') + '.L3:\n\t.word\ttbl\n';

      test('a byte load at the indexed address is an element of the declared bytes', () => {
        expect(lift(indexed('\tldrb\tr0, [r0]\n')).source).toContain('u8 sp0[8];');
        expect(lift(indexed('\tldrb\tr0, [r0]\n')).source).toContain('((u8 *)sp0)[a0]');
      });

      test('a byte store at the indexed address is one too', () => {
        expect(lift(indexed('\tstrb\tr5, [r0]\n\tmov\tr0, #0x0\n')).source).toContain('((u8 *)sp0)[a0] = a1;');
      });

      // A WIDER ELEMENT is the same bytes read wider, through a cast at its own width and sign, so
      // the storage stays `u8` and the index stays a byte offset unless the asm scaled it.
      test('a wider element is read through a cast on the bytes', () => {
        // the bytes are written one at a time, which every type aliases, and read a halfword
        expect(lift(atTheIndexedRead('\tldrh\tr0, [r0]\n')).source).toContain('return *(u16 *)((u32)sp0 + a0);');
        // …and a sign-extending read, of any width, carries its own extension in the cast
        expect(lift(atTheIndexedRead('\tldrsb\tr0, [r0]\n')).source).toContain('return ((s8 *)sp0)[a0];');
        expect(lift(atTheIndexedRead('\tldrsh\tr0, [r0]\n')).source).toContain('return *(s16 *)((u32)sp0 + a0);');
        // agbcc's own output for `void g(void); u16 f(int i, void *q){ void *p[2]; p[i] = q; g();
        // return *(u16 *)p[i]; }` — a POINTER element, written and read by index. Both are spelled
        // as one integer type: agbcc gives every pointer type an alias set of its own
        // (c-common.c:2000), so an integer store beside a pointer load would be two sets.
        const words =
          'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tlsl\tr4, r4, #0x2\n\tadd\tr4, r4, sp\n' +
          '\tstr\tr1, [r4]\n\tbl\tg\n\tldr\tr0, [r4]\n\tldrh\tr0, [r0]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
        const src = lift(words).source;
        expect(src).toContain('p0 = (s32 *)sp0;\n    p0[a0] = a1;');
        expect(src).toContain('return *(u16 *)p0[a0];');
        // …and so in every candidate of the fan: a candidate that typed the element as the pointer
        // it holds would put the store and the load in two sets
        const casts = enumerateCandidates('f', words, ARMV4T_AGBCC).flatMap((c) =>
          [...c.source.matchAll(/\(([^()]+)\)\s*sp0\b/g)].map((m) => m[1]),
        );
        expect(casts.length).toBeGreaterThan(0);
        expect(casts.filter((t) => !/^[us](8|16|32) \*$/.test(t))).toEqual([]);
      });

      test('two wider widths over the bytes are two alias sets, and decline naming both', () => {
        // the per-object model refuses the two widths, and kept as one object (nothing escapes) the
        // second audit refuses them by its own rule
        expect(() => lift(atTheIndexedRead('\tldrh\tr2, [r0]\n\tldr\tr0, [r0]\n\tadd\tr0, r0, r2\n'))).toThrow(
          /a runtime index into the bytes \[sp,#0\) to \[sp,#8\) kept as one object accesses 2 and 4 bytes wide, and type-based alias analysis can let a read of one type pass a store of the other/,
        );
      });

      // KEPT AS ONE OBJECT, a wider index is spelled through a cast on the bytes, as a member is.
      // What it must agree with is every wider access it may reach — all of them, since it names
      // no byte — and agbcc's alias sets say what agreeing is: one set per integer type,
      // signedness shared, a character type in every set (`indexedWidth`).
      test('kept as one object, a wider index reads through a cast at its own byte offset', () => {
        // the index is not scaled, so the halfword is at byte `a0`, not element `a0`
        expect(lift(indexed('\tldrh\tr0, [r0]\n')).source).toContain('return *(u16 *)((u32)sp0 + a0);');
        // …a sign-extending read carries its own extension in the cast
        expect(lift(indexed('\tldrsh\tr0, [r0]\n')).source).toContain('return *(s16 *)((u32)sp0 + a0);');
        // …and a scaled one is an element of a halfword array over the same bytes
        expect(lift(indexed('\tlsl\tr4, r4, #0x1\n\tadd\tr0, r1, r4\n\tldrh\tr0, [r0]\n')).source).toContain(
          'return ((u16 *)sp0)[a0];',
        );
        // a member of the same width, or a byte, shares the index's alias set
        const member = (store: string) => indexed(`\tldrh\tr0, [r0]\n\tmov\tr1, sp\n\t${store}\tr5, [r1, #0x4]\n`);
        expect(lift(member('strh')).source).toContain('((u16 *)sp0)[2] = a1;');
        expect(lift(member('strb')).source).toContain('((u8 *)sp0)[4] = a1;');
      });

      test('kept as one object, an index beside an access of another width declines', () => {
        // a word member the halfword index may reach: two alias sets on one byte
        expect(() => lift(indexed('\tldrh\tr0, [r0]\n\tmov\tr1, sp\n\tstr\tr5, [r1, #0x4]\n'))).toThrow(
          /the byte at \[sp,#4\] of the bytes \[sp,#0\) to \[sp,#8\) kept as one object is accessed 4 bytes wide and by a runtime index 2 bytes wide/,
        );
        // …and two indexed widths, which name no byte at all
        expect(() => lift(indexed('\tldrh\tr2, [r0]\n\tldr\tr0, [r0]\n\tadd\tr0, r0, r2\n'))).toThrow(
          /a runtime index into the bytes \[sp,#0\) to \[sp,#8\) kept as one object accesses 2 and 4 bytes wide/,
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
        const src = lift(LOCAL).source;
        expect(src).toContain('u8 sp0[8];');
        expect(src).toContain('((u8 *)sp0)[v0] = ((u8 *)&tbl)[v0];');
        expect(src).toContain('return ((u8 *)sp0)[a0];');
      });

      test('an object an access of its own types as a scalar is not indexed', () => {
        const typed = indexed('\tldrb\tr0, [r0]\n\tmov\tr1, sp\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1\n');
        const typedHere = atTheIndexedRead('\tldrb\tr0, [r0]\n\tmov\tr1, sp\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1\n');
        expect(() => lift(alsoPublished(typedHere))).toThrow(
          /a runtime index into the object at \[sp,#0\), which an access of its own types as one scalar/,
        );
        // …and where nothing escapes, so is the one object here: the scalar a byte of it
        expect(lift(typedHere).source).toContain('return ((u8 *)sp0)[a0] + *(u8 *)sp0;');
        // …while kept as one object, the scalar is its byte 0 and the index another byte of it
        expect(lift(typed).source).toContain('u8 sp0[8];');
      });

      // agbcc's own output for `int u(int i, int j, int a){ unsigned short t[4][3]; t[i][0] = a;
      // t[i+1][0] = a+1; return t[j][0]; }` — a row of three halfwords, stride 6. agbcc rounds
      // every struct to 4 bytes, so an element struct of 6 would be indexed at 8 and its stores
      // land past the buffer: the stride is spelled as the byte offset it is.
      test('a stride the compiler would round an element struct off is spelled as bytes', () => {
        const rows =
          'u:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x18\n\tlsl\tr3, r0, #0x1\n\tadd\tr3, r3, r0\n\tlsl\tr3, r3, #0x1\n' +
          '\tadd\tr3, r3, sp\n\tstrh\tr2, [r3]\n\tadd\tr0, r0, #0x1\n\tlsl\tr3, r0, #0x1\n\tadd\tr3, r3, r0\n' +
          '\tlsl\tr3, r3, #0x1\n\tmov\tr4, sp\n\tadd\tr0, r4, r3\n\tadd\tr2, r2, #0x1\n\tstrh\tr2, [r0]\n' +
          '\tlsl\tr0, r1, #0x1\n\tadd\tr0, r0, r1\n\tlsl\tr0, r0, #0x1\n\tadd\tr0, r0, sp\n\tldrh\tr0, [r0]\n' +
          '\tadd\tsp, sp, #0x18\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
        const src = decompile('u', rows, ARMV4T_AGBCC).source;
        expect(src).toContain('*(u16 *)((u32)sp0 + a0 * 6) = a2;');
        expect(src).toContain('return *(u16 *)((u32)sp0 + a1 * 6);');
        for (const c of enumerateCandidates('u', rows, ARMV4T_AGBCC)) {
          expect(c.source).not.toMatch(/struct Elem/);
        }
      });

      // agbcc's own output for `struct E { int a; int b; }; void s7(int i, int j, int q){ struct E
      // p[2]; int x; memcpy(p, gT, sizeof p); x = p[i].b; ((int *)p)[j] = q; use(x, p[i].b,
      // p[i].a); }`. The pairs read by index are an element struct over the bytes; a candidate that
      // declared its word field the pointer it may hold would put the read in a set of its own,
      // and agbcc compiles that to one load reused past the `int` store — so no candidate does.
      test('an element struct over the bytes keeps integer fields in every candidate', () => {
        const pairs =
          's7:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr5, r0, #0\n\tadd\tr4, r1, #0\n' +
          '\tadd\tr6, r2, #0\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n\tlsl\tr5, r5, #0x3\n' +
          '\tadd\tr1, sp, #0x4\n\tadd\tr1, r1, r5\n\tldr\tr0, [r1]\n\tlsl\tr4, r4, #0x2\n\tadd\tr4, r4, sp\n' +
          '\tstr\tr6, [r4]\n\tldr\tr1, [r1]\n\tmov\tr3, sp\n\tadd\tr2, r3, r5\n\tldr\tr2, [r2]\n\tbl\tuse\n' +
          '\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgT\n';
        expect(decompile('s7', pairs, ARMV4T_AGBCC).source).toContain('((s32 *)sp0)[a1] = a2;');
        const cands = enumerateCandidates('s7', pairs, ARMV4T_AGBCC);
        expect(cands.some((c) => /\(struct Elem\d+ \*\)\s*\(?(\(u32\))?\s*sp0/.test(c.source))).toBe(true);
        for (const c of cands) {
          for (const [, fields] of c.source.matchAll(/struct Elem\d+ \{([^}]*)\}/g)) {
            expect(fields).not.toMatch(/\*/);
          }
        }
      });
    });

    test('an object that does not start at the bottom of the area is not the whole area', () => {
      // `add rD, sp, #k` names an object at [sp,#k), so the bytes below it are something else
      const above = copy('\tadd\tr1, r0, #0\n\tadd\tr0, sp, #0x4\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n');
      expect(() => readOnly(copy(READ.replace('\tmov\tr0, sp\n', '\tadd\tr0, sp, #0x4\n')))).toThrow(
        /the object does not start at the bottom of the declared area/,
      );
      // …unless they are all one object, which the callee is handed the inside of
      expect(lift(above).source).toContain('memcpy((u32)sp0 + 4, a0, 16)');
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
      // …and with `h` saying nothing of what it returns, a writer the one object cannot hold
      const withUnsaidH = (asm: string) =>
        decompile('f', asm, ARMV4T_AGBCC, { prototypes: { ...protos.prototypes, h: { params: 1 } } });

      test('the object above the argument words is declared over the rest of the frame', () => {
        const src = liftWith(fill()).source;
        expect(src).toContain('u8 sp16[8];');
        expect(src).toContain('g(sp16, 0, 0, 0, 8, 2, 15, a0);');
        expect(src).toContain('h(sp16);');
      });

      test('an object above the bottom of the declared range is not the whole of it', () => {
        expect(() => liftWith(fill())).not.toThrow();
        expect(() => withUnsaidH(fill('0x14'))).toThrow(
          /the object does not start at the bottom of the declared area.* — and the one object cannot hold every writer/,
        );
        expect(liftWith(fill('0x14')).source).toContain('h((u32)sp16 + 4);');
      });

      test('a slot inside the declared range is not this object`s', () => {
        // a local kept across the call at [sp,#0x14], above the argument words
        expect(() => liftWith(fill())).not.toThrow();
        const kept = `${STAGED}\tstr\tr4, [sp, #0x14]\n`;
        const keyed = fill('0x10', kept).replace('\tbl\th\n', '\tbl\th\n\tldr\tr0, [sp, #0x14]\n');
        // and where nothing reaches the frame at all — the object only indexed here, never handed
        // out, and `g` given its staged arguments alone — the slot is no second model either
        const indexedOnly = copy(
          `${kept}\tmov\tr0, #0x0\n\tmov\tr1, #0x0\n\tmov\tr2, #0x0\n\tmov\tr3, #0x0\n\tbl\tg\n` +
            '\tadd\tr1, sp, #0x10\n\tldrb\tr0, [r1, r0]\n\tldr\tr1, [sp, #0x14]\n\tadd\tr0, r0, r1\n',
          '0x18',
        );
        // …it is kept as one object, the slot a word of it, the uninitialised store kept
        expect(liftWith(indexedOnly).source).toContain(
          '((s32 *)sp16)[1] = uninit_r4;\n    return ((u8 *)sp16)[g(0, 0, 0, 0, 8, 2, 15, a0)] + ((s32 *)sp16)[1];',
        );
        expect(liftWith(keyed).source).toContain('return ((s32 *)sp16)[1];');
      });

      test('a runtime index into an object a scalar access types names the declared area', () => {
        const indexed = copy(
          `${STAGED}\tadd\tr4, sp, #0x10\n\tmov\tr0, r4\n\tmov\tr1, #0x0\n\tmov\tr2, #0x0\n\tmov\tr3, #0x0\n` +
            '\tbl\tg\n\tldrb\tr0, [r4]\n\tldrb\tr1, [r4, r0]\n\tmov\tr0, r1\n\tbl\th\n',
          '0x18',
        );
        const unsaidG = { prototypes: { ...protos.prototypes, g: { params: 8 } } };
        expect(() => decompile('f', indexed, ARMV4T_AGBCC, unsaidG)).toThrow(
          /a runtime index into the object at \[sp,#16\), which an access of its own types as one scalar — only the untyped storage of the whole declared area is indexed — and the one object cannot hold every writer/,
        );
        expect(liftWith(indexed).source).toContain('u8 sp16[8];');
      });

      test('a second object above the block means the reservation is not this one`s', () => {
        expect(() => liftWith(fill())).not.toThrow();
        const two = fill().replace('\tadd\tr0, sp, #0x10\n\tbl\th\n', '\tadd\tr0, sp, #0x14\n\tbl\th\n');
        expect(() => withUnsaidH(two)).toThrow(/another address-taken object shares the frame/);
        // …unless both are one object: the frame bytes above the block, handed out at two offsets
        const kept = liftWith(two).source;
        expect(kept).toContain('g(sp16, 0, 0, 0, 8, 2, 15, a0);');
        expect(kept).toContain('h((u32)sp16 + 4);');
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

// A BY-VALUE STRUCT PARAMETER is spilled word by word — `str r0, [sp]`, a store the slot model keys —
// and, Thumb having no sp-relative halfword or byte load, read member by member through `mov rD, sp`,
// which the audit splits into objects. So the objects lie over slots, and nothing escapes: no call
// takes a frame address and none is stored anywhere. With no writer and no reader but this
// function's own accesses, the declared area is kept as ONE object in memory, every spill a store
// to it, rather than declined as two models of one byte. Verbatim agbcc 2.9-arm-000512 at the
// corpus's flags.
describe('a frame nothing escapes from is one object where the slot model and an object meet', () => {
  const byValue = (reads: string) =>
    `f:\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr2, [sp, #0x8]\n${reads}` +
    '\tadd\tsp, sp, #0xc\n\tbx\tlr\n';
  // `struct Q { u8 a[9]; }; int f(struct Q p, int i){ return p.a[1] + p.a[8]; }`
  const BYTES = byValue(
    '\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x1]\n\tmov\tr1, sp\n\tldrb\tr1, [r1, #0x8]\n\tadd\tr0, r0, r1\n',
  );

  test('word spills read back as bytes lift, every spill kept', () => {
    const src = lift(BYTES).source;
    expect(src).toContain('u8 sp0[12];');
    // the declaration is the audit's alone: no struct is recovered over the frame object's address
    // (raise/structs.ts), which nothing would reference
    expect(src).not.toContain('struct Struct');
    expect(src).toContain('*p0 = a0;\n    p0[1] = a1;\n    p0[2] = a2;\n    return p1[1] + p1[8];');
  });

  test('an escape keeps the per-object refusal', () => {
    // the same frame with its base handed to a callee nothing says the return of: a writer the one
    // object cannot hold, so the overlap is refused where it stands
    const handed = BYTES.replace('\tadd\tr0, r0, r1\n', '\tadd\tr0, r0, r1\n\tmov\tr0, sp\n\tbl\tg\n');
    expect(handed).not.toBe(BYTES);
    expect(() => lift(handed)).toThrow(/overlaps the SSA slot at \[sp,#0\] — one byte, two models/);
  });

  test('word spills read back as halfwords are the views of one union', () => {
    // `struct P { u16 a, b, c, d; s8 e; }; int f(struct P p){ return p.a + p.c - p.e; }` — two
    // widths at one byte, which a cast on bytes would let agbcc read stale and a union does not
    const halves = byValue(
      '\tmov\tr0, sp\n\tldrh\tr0, [r0]\n\tmov\tr1, sp\n\tldrh\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1\n' +
        '\tmov\tr1, sp\n\tldrb\tr1, [r1, #0x8]\n\tlsl\tr1, r1, #24\n\tasr\tr1, r1, #24\n\tsub\tr0, r0, r1\n',
    );
    expect(lift(halves).source).toContain(
      's32 f(s32 a0, s32 a1, s32 a2) {\n    union { s32 word[3]; u16 half[6]; u8 byte[12]; } sp0;\n' +
        '    sp0.word[0] = a0;\n    sp0.word[1] = a1;\n    sp0.word[2] = a2;\n' +
        '    return sp0.half[0] + sp0.half[2] - (s8)sp0.byte[8];\n}\n',
    );
  });

  test('two widths and a byte runtime index refuse, as the index', () => {
    // `struct P { u16 a, b; u8 c[8]; }; int f(struct P p, int i){ return p.a + p.c[i]; }` — a char
    // index agrees with every width (`indexedWidth`), but no view of a union is spelled for one
    const indexed = byValue(
      '\tmov\tr0, sp\n\tldrh\tr0, [r0]\n\tadd\tr1, sp, #0x4\n\tadd\tr1, r1, r3\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1\n',
    );
    expect(() => lift(indexed)).toThrow(/accessed 4 and 2 bytes wide, .* and a runtime index reaches them too/);
  });

  // EVERY PER-OBJECT REFUSAL, not only the overlap: with nothing escaping, the one-object answer is
  // on offer before any shape is judged (frame-objects.ts `chooseFrameModel`), so which refusal the
  // per-object model would have reached first does not decide whether the frame lifts.
  test('a member read signed and unsigned is the views of one union', () => {
    // `struct P { s16 a, b, c, d; s8 e; }; int f(struct P p){ return (s16)p.a + p.b + (s16)p.b; }` —
    // the per-object model refuses the signedness disagreement before it reaches the overlap
    const signs = byValue(
      '\tmov\tr0, sp\n\tmov\tr1, #0x0\n\tldrsh\tr0, [r0, r1]\n\tmov\tr1, sp\n\tldrh\tr1, [r1, #0x2]\n' +
        '\tadd\tr0, r0, r1\n\tmov\tr1, sp\n\tmov\tr2, #0x2\n\tldrsh\tr1, [r1, r2]\n\tadd\tr0, r0, r1\n',
    );
    expect(lift(signs).source).not.toContain('struct Struct');
    expect(lift(signs).source).toContain(
      '    union { s32 word[3]; u16 uhalf[6]; s16 shalf[6]; } sp0;\n' +
        '    sp0.word[0] = a0;\n    sp0.word[1] = a1;\n    sp0.word[2] = a2;\n' +
        '    return sp0.shalf[0] + sp0.uhalf[1] + sp0.shalf[1];\n',
    );
  });

  test('a word stored through the captured address is a member of the one object', () => {
    // the parameter copied into a local `struct S { u32 x, y, z, w, v; }` a word at a time through
    // `add r1, sp, #0xc` — the per-object model refuses a word at [+4] through a capture before any
    // shape is judged
    const copied =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x20\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n' +
      '\tstr\tr2, [sp, #0x8]\n\tadd\tr1, sp, #0xc\n\tmov\tr0, sp\n\tldrh\tr0, [r0]\n\tstr\tr0, [sp, #0xc]\n' +
      '\tmov\tr0, sp\n\tldrh\tr5, [r0, #0x2]\n\tstr\tr5, [r1, #0x4]\n\tldrh\tr4, [r0, #0x4]\n\tstr\tr4, [r1, #0x8]\n' +
      '\tldrh\tr3, [r0, #0x6]\n\tstr\tr3, [r1, #0xc]\n\tmov\tr2, #0x8\n\tldrsb\tr2, [r0, r2]\n\tstr\tr2, [r1, #0x10]\n' +
      '\tldr\tr0, [sp, #0xc]\n\tmul\tr0, r0, r5\n\tmov\tr1, r4\n\tmul\tr1, r1, r3\n\tadd\tr0, r0, r1\n' +
      '\tadd\tr0, r0, r2\n\tadd\tsp, sp, #0x20\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n';
    const src = lift(copied).source;
    expect(src).toContain('    union { s32 word[8]; u16 half[16]; s8 byte[32]; } sp0;\n');
    expect(src).toContain('    sp0.word[3] = sp0.half[0];\n');
    expect(src).toContain('    sp0.word[7] = v3;\n    return sp0.word[3] * v0 + v1 * v2 + v3;\n');
  });

  // …EXCEPT A STORE THAT REACHES A CALL UNREAD, ON EVERY PATH AND BENEATH EVERY PROVEN LOCAL.
  // agbcc's own output for `struct W { int a[3]; }; int th(); int q7(struct W *p){ return th(1, 2, 3, 4, *p); }`:
  // the struct ARGUMENT is block-copied into the outgoing words through `mov r1, sp`, and nothing
  // escapes. Kept as one object, the copy is a local's and `th` loses every stack word, silently.
  const STAGED_ARG =
    'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr1, sp\n\tldmia\tr0!, {r2, r3, r4}\n\tstmia\tr1!, {r2, r3, r4}\n' +
    '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tth\n\tadd\tsp, sp, #0xc\n\tpop\t{r4}\n' +
    '\tpop\t{r1}\n\tbx\tr1\n';
  const storedUnread = (width: number, at: number, callee: string) =>
    new RegExp(
      `the ${width}-byte store at \\[sp,#${at}\\) through a captured address reaches the call to \`${callee}\` unread on every path`,
    );

  test('a word copied through a capture and never read is the outgoing-argument guard, and stands', () => {
    expect(() => lift(STAGED_ARG)).toThrow(storedUnread(4, 0, 'th'));
    // …and a prototype holds no store through a capture: a stated list is a LOWER bound on the
    // words a call takes. `int th(int, int, int, int, ...)` states four, and so does DWARF for it,
    // which drops the `...` — the same refusal
    const prefix = (params: number | string[]) =>
      decompile('f', STAGED_ARG, ARMV4T_AGBCC, { prototypes: { th: { params } } });
    expect(() => prefix(4)).toThrow(storedUnread(4, 0, 'th'));
    expect(() => prefix(['s32', 's32', 's32', 's32'])).toThrow(storedUnread(4, 0, 'th'));
    // …and a prototype that states the stack words holds them to `[sp,#k]` stores, loudly
    expect(() => prefix(7)).toThrow(/callee `th` is declared with 7 arguments, so its outgoing stack-argument block/);
  });

  test('a local stored after the only call, or read after a call, is no argument', () => {
    // `int g(); int f(int x, int y){ unsigned char b[4]; g(); b[0] = x; b[1] = y; return b[0]; }` —
    // `b[1]` is never read, but it reaches no call
    const afterCall =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tbl\tg\n\tmov\tr0, sp\n' +
      '\tstrb\tr4, [r0]\n\tstrb\tr5, [r0, #0x1]\n\tldrb\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(liftUndeclared(afterCall).source).toContain('    g(a0, a1);\n    sp0 = a0;\n    return sp0;\n');
    // `int g(); int f(int n, int x){ u8 b[4]; int i, r = 0;
    //   for (i = 0; i < n; i++) { if (g()) { b[1] = x + i; if (x > i) r += b[1]; } } return r; }` —
    // the store reaches the next trip's call unread, but the first trip calls `g` before any store:
    // an argument is staged on every path to its call
    const loop =
      'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr7, r0, #0\n\tadd\tr6, r1, #0\n\tmov\tr1, #0x0\n' +
      '\tmov\tr4, #0x0\n\tcmp\tr1, r7\n\tbge\t.L4\n\tmov\tr5, sp\n.L6:\n\tstr\tr1, [sp, #0x4]\n\tbl\tg\n\tldr\tr1, [sp, #0x4]\n' +
      '\tcmp\tr0, #0\n\tbeq\t.L5\n\tadd\tr0, r6, r4\n\tstrb\tr0, [r5, #0x1]\n\tcmp\tr6, r4\n\tble\t.L5\n\tldrb\tr0, [r5, #0x1]\n' +
      '\tadd\tr1, r1, r0\n.L5:\n\tadd\tr4, r4, #0x1\n\tcmp\tr4, r7\n\tblt\t.L6\n.L4:\n\tadd\tr0, r1, #0\n\tadd\tsp, sp, #0x8\n' +
      '\tpop\t{r4, r5, r6, r7}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(lift(loop).source).toContain('sp1 = a1 + v3;');
  });

  // …AND ANY STORE THAT REACHES A CALL UNREAD, whatever refusal the per-object model meets or none
  // at all. agbcc builds a compound-literal argument IN PLACE with `strb`/`strh` through `mov rD, sp`
  // moved by `add rD, #k`, every access at +0 of its own capture. Verbatim agbcc output, `th`
  // undeclared.
  const inPlace = (calls: string) =>
    `f:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x4\n${calls}\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n`;
  const TH = '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tth\n';
  const BYTES_LITERAL =
    '\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tmov\tr0, sp\n\tstrb\tr4, [r0]\n\tadd\tr0, r0, #0x1\n\tstrb\tr5, [r0]\n' +
    '\tmov\tr6, sp\n\tadd\tr6, r6, #0x2\n\tstrb\tr4, [r6]\n\tadd\tr0, r0, #0x2\n\tstrb\tr5, [r0]\n';
  const STORED_NEVER_READ = storedUnread(1, 0, 'th');

  test('an argument built in place at two widths is not the one object', () => {
    // `struct S { s8 a[4]; }; struct T { u16 h[2]; }; int th();
    //  int f(int x, int y){ th(1, 2, 3, 4, (struct S){{x, y, x, y}}); return th(1, 2, 3, 4, (struct T){{x, y}}); }`
    // — the width disagreement asks for the one object, which would keep both literals as a local's
    // stores and call `th(1, 2, 3, 4)` twice
    const twoWidths = inPlace(`${BYTES_LITERAL}${TH}\tmov\tr0, sp\n\tstrh\tr4, [r0]\n\tstrh\tr5, [r6]\n${TH}`);
    expect(() => lift(twoWidths)).toThrow(STORED_NEVER_READ);
    // …and a prototype that states the stack words leaves it to the stack-argument analysis, loudly
    expect(() => decompile('f', twoWidths, ARMV4T_AGBCC, { prototypes: { th: { params: 5 } } })).toThrow(
      /callee `th` is declared with 5 arguments, so its outgoing stack-argument block is \[sp,#0\]/,
    );
  });

  test('an argument built in place at one width is not a dead local', () => {
    // `struct S { u8 a[4]; }; int th(); int f(int x, int y){ return th(1, 2, 3, 4, (struct S){{x, y, x, y}}); }`
    // — the per-object model refuses nothing here, and would drop four dead locals and the argument
    expect(() => lift(inPlace(`${BYTES_LITERAL}${TH}`))).toThrow(STORED_NEVER_READ);
    // with no call there is nothing to take the bytes, and a store read back is a local's
    expect(lift(inPlace(`${BYTES_LITERAL}\tmov\tr0, #0x0\n`)).source).not.toContain('th(');
    const readBack = '\tmov\tr0, sp\n\tstrb\tr1, [r0]\n' + TH + '\tmov\tr0, sp\n\tldrb\tr0, [r0]\n';
    expect(lift(inPlace(readBack)).source).toContain('th(1, 2, 3, 4);');
    // …and the refusal names the call the bytes reach, not the first call in the function
    // (`int f0(); int th(); int f(int x, int y){ f0(); return th(1, 2, 3, 4, (struct S){{x, y, x, y}}); }`)
    const afterF0 =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tbl\tf0\n\tmov\tr0, sp\n' +
      '\tstrb\tr4, [r0]\n\tadd\tr0, r0, #0x1\n\tstrb\tr5, [r0]\n\tadd\tr0, r0, #0x1\n\tstrb\tr4, [r0]\n' +
      `\tadd\tr0, r0, #0x1\n\tstrb\tr5, [r0]\n${TH}\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(() => lift(afterF0)).toThrow(STORED_NEVER_READ);
  });
});
