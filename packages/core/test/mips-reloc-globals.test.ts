// The objdump relocation fold (frontend/mips.ts + the shared frontend/high-half.ts): in an object
// file a global access shows `lui rX,0x0` with the symbol living only in the R_MIPS_HI16/LO16
// records. Given the asmData side-table the frontend carries each record on its instruction and
// folds the pair, BY SSA VALUE, into one `gaddr` — instead of reading the placeholder immediate as
// address 0 and rendering `*(T *)0`. That is what lets asmlift match global access in the
// benchmark's objdump tier, symmetric with the symbols the harness feeds m2c.
//
// The other half of the file is the refusals: every path that does NOT fold a record must say so,
// because a dropped record leaves the literal 0 standing where the symbol belongs and `*(T *)0`
// compiles — the silent wrong answer this project never ships.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC } from '../src/target';

// A minimal AsmData carrying only .text relocations (the bridge reads nothing else).
const relocs = (rs: { off: number; type: string; sym: string }[]): AsmData => ({
  sections: new Map(),
  relocs: rs.map((r) => ({ section: '.text', offset: r.off, type: r.type, sym: r.sym, addend: 0 })),
  symbols: new Map(),
  bigEndian: true,
});

test('a scalar global load recovers the named symbol via HI16/LO16 relocs (not *(T *)0)', () => {
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gByte' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gByte' },
  ]);
  expect(decompile('getg', asm, MIPS_GCC, { asmData: rs }).source).toContain('return gByte;');
});

test('a global field access folds the LO16 instruction offset into the gaddr access offset', () => {
  // `lw v0,8(v0)` under an LO16 reloc → the global at byte offset 8 → element 2 of an s32 aggregate
  const asm = '00000000 <getf>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlw\tv0,8(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gStruct' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gStruct' },
  ]);
  expect(decompile('getf', asm, MIPS_GCC, { asmData: rs }).source).toContain('((s32 *)&gStruct)[2]');
});

test('an addiu-materialised global base + plain-offset access recovers through the symbol', () => {
  // `lui;addiu %lo` materialises &gArr, then a plain `lw 4(v0)` reads element 1
  const asm = '00000000 <getm>:\n   0:\tlui\tv0,0x0\n   4:\taddiu\tv0,v0,0\n   8:\tjr\tra\n   c:\tlw\tv0,4(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gArr' },
    { off: 4, type: 'R_MIPS_LO16', sym: 'gArr' },
  ]);
  expect(decompile('getm', asm, MIPS_GCC, { asmData: rs }).source).toContain('&gArr');
});

test('a SECTION-symbol reloc is folded and named, never left to render as the literal 0', () => {
  // `.rodata`/`.data` names an offset into a section — an anonymous datum C cannot spell. Leaving
  // it off the carrier would leave the pair raw, and raw is the `lui`'s link-time placeholder: the
  // wrong answer `*(s8 *)0`, which compiles. Folding it is loud twice over downstream instead
  // (rank-declare.ts refuses the declaration and REPORTS the name, and the source does not
  // compile), which is strictly more than a frontend refusal would say.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: '.rodata' },
    { off: 8, type: 'R_MIPS_LO16', sym: '.rodata' },
  ]);
  const src = decompile('getg', asm, MIPS_GCC, { asmData: rs }).source;
  expect(src).toContain('.rodata');
  expect(src).not.toContain('*(s8 *)0');
});

test('two relocations on one instruction refuse rather than silently keeping the last', () => {
  // The carrier is one field. Keeping the last record would leave one symbol standing for the
  // other's operand — the same invariant disasm.ts and frontend/splat.ts enforce on their inputs.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gFirst' },
    { off: 0, type: 'R_MIPS_HI16', sym: 'gSecond' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gFirst' },
  ]);
  expect(() => decompile('getg', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /two relocations on one instruction.*gFirst.*gSecond/s,
  );
});

test('a relocation carrying an addend refuses — MIPS is REL and the addend rides the instruction', () => {
  // The fold reads the addend out of the two instruction immediates. A record that ALSO carries one
  // is a format this reader does not understand, and folding it anyway would count the offset twice.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gByte' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gByte' },
  ]);
  rs.relocs[1] = { ...rs.relocs[1], addend: 0x10 };
  expect(() => decompile('getg', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /carries an addend \(0x10\).*MIPS relocations are REL/s,
  );
});

test('an address BELOW the symbol refuses instead of folding an index-biased base', () => {
  // `lui %hi(gTab-8000)` / `lw %lo(gTab-8000)` recombines to byte offset -8000. The arithmetic is
  // right, but an address below a symbol is an index-biased array base — a capability with its own
  // `memAccess` question, unbuilt and unbenched — and this frontend will not guess at it.
  const asm = '00000000 <getn>:\n   0:\tlui\tv0,0xffff\n   4:\tjr\tra\n   8:\tlw\tv0,-32768(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gTab' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gTab' },
  ]);
  expect(() => decompile('getn', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /completes 'gTab' at byte offset -\d+ — an address BELOW the symbol/s,
  );
});

// ── The high half is not a value ────────────────────────────────────────────────────────────────
// In a relocatable object the `lui` immediate is the literal 0 and the address lives ONLY in the
// R_MIPS_HI16/LO16 records, so every path that fails to fold the pair must REFUSE. Dropping one
// leaves the 0 standing where the symbol belongs, and `*(T *)0` compiles — the silent wrong answer.
// The pairing itself is proven by SSA (frontend/high-half.ts), never by address order.

test('a high half no low half completes REFUSES instead of lifting the placeholder 0', () => {
  // Two `lui`s into one register: the first half is overwritten before anything consumes it. Its
  // address is simply gone, so the lift must say so rather than finish with the 0 objdump printed.
  const asm =
    '00000000 <two>:\n   0:\tlui\tv0,0x0\n   4:\tlui\tv0,0x0\n   8:\tlw\tv0,0(v0)\n   c:\tjr\tra\n  10:\tnop\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gDropped' },
    { off: 4, type: 'R_MIPS_HI16', sym: 'gKept' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gKept' },
  ]);
  expect(() => decompile('two', asm, MIPS_GCC, { asmData: rs })).toThrow(/gDropped.*never completed/s);
});

test('a low half on an UNMODELLED consumer REFUSES and names the relocation it saw', () => {
  // An FP load is not a modelled global consumer, so the `lwc1` would become an opaque and take
  // the global access with it. The relocation nothing consumed must refuse instead.
  const asm = '00000000 <getf>:\n   0:\tlui\tv0,0x0\n   4:\tlwc1\t$f0,0(v0)\n   8:\tjr\tra\n   c:\tnop\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gFloat' },
    { off: 4, type: 'R_MIPS_LO16', sym: 'gFloat' },
  ]);
  expect(() => decompile('getf', asm, MIPS_GCC, { asmData: rs })).toThrow(/lwc1.*gFloat/s);
});

test('two high halves of ONE symbol pair by VALUE, not by address order', () => {
  // One symbol, two `lui`s, two `%lo` consumers whose BASE REGISTERS cross — the shape that shows
  // why address order is the wrong pairing rule. "The first unconsumed same-symbol LO16 after this
  // HI16" hands each `lui` the other one's consumer; asking SSA which value the base register holds
  // here cannot. The N64 checkouts carry the degenerate form, two HI16 against one symbol sharing
  // one LO16.
  const asm =
    '00000000 <cross>:\n' +
    '   0:\tlui\ta0,0x0\n' +
    '   4:\tlui\ta1,0x0\n' +
    '   8:\tlw\tv0,4(a1)\n' +
    '   c:\tlw\tv1,8(a0)\n' +
    '  10:\tjr\tra\n' +
    '  14:\taddu\tv0,v0,v1\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gTbl' },
    { off: 4, type: 'R_MIPS_HI16', sym: 'gTbl' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gTbl' },
    { off: 12, type: 'R_MIPS_LO16', sym: 'gTbl' },
  ]);
  // Both `%lo`s fold to the SAME global, so the two accesses share one recovered pointer — element
  // 1 (byte 4, through a1's half) and element 2 (byte 8, through a0's half), each with the offset
  // its own instruction carried.
  const src = decompile('cross', asm, MIPS_GCC, { asmData: rs }).source;
  expect(src).toContain('(s32 *)&gTbl');
  expect(src).toContain('p0[1] + p0[2]');
});

test('a high half READ AS DATA refuses, naming the lui that produced it', () => {
  // `addu v0,v0,a0` reads the half as an operand. It is a link-time placeholder, not a number.
  const asm = '00000000 <asdata>:\n   0:\tlui\tv0,0x0\n   4:\taddu\tv0,v0,a0\n   8:\tjr\tra\n   c:\tnop\n';
  const rs = relocs([{ off: 0, type: 'R_MIPS_HI16', sym: 'gBase' }]);
  expect(() => decompile('asdata', asm, MIPS_GCC, { asmData: rs })).toThrow(/high half of 'gBase'/);
});

// ── The records never arrived ───────────────────────────────────────────────────────────────────
// The fold above closes every path a CARRIED relocation could be dropped on. These close the other
// side: the side table is OPTIONAL (`decompile` takes no `asmData` from the CLI on raw objdump
// text, and the benchmark's own extraction degrades to `undefined` on a failed dump), and without
// it the `lui` immediate is still the link-time placeholder. Rendering it as the number 0 is the
// same silent wrong answer whether the record was dropped or never supplied.

test('a lui of 0x0 with NO relocation table refuses instead of rendering address 0', () => {
  // The scalar-load input of the first test, lifted with nothing on the side. `lui` of zero writes
  // zero — which `move rD,zero` says in one instruction — so no compiler emits this; an unrelocated
  // high half does, and reading it as the number gives `*(s8 *)0`, which compiles.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  expect(() => decompile('getg', asm, MIPS_GCC)).toThrow(/high half 0x0 with no relocation on it/);
  // and the same input with an EMPTY table is the same case: a table that describes no half here
  expect(() => decompile('getg', asm, MIPS_GCC, { asmData: relocs([]) })).toThrow(
    /high half 0x0 with no relocation on it/,
  );
});

test('a NON-zero lui high half is untouched by that guard', () => {
  // A linked disassembly (or a `lui;ori` 32-bit literal) carries the real high half in the field,
  // and needs no relocation to mean what it says. The guard must not reach it.
  const asm = '00000000 <lit>:\n   0:\tlui\tv0,0x1234\n   4:\tjr\tra\n   8:\tori\tv0,v0,0x5678\n';
  expect(decompile('lit', asm, MIPS_GCC).source).toContain('305419896');
});

test('a relocation INSIDE the function but on no instruction refuses, naming the disagreement', () => {
  // A record whose offset lands in this slice and matches nothing means the table and the
  // disassembly disagree about addressing. Records outside the slice belong to the object's other
  // functions and are skipped, which is why the guard is bounded by the slice rather than global.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 2, type: 'R_MIPS_HI16', sym: 'gByte' },
    { off: 10, type: 'R_MIPS_LO16', sym: 'gByte' },
  ]);
  expect(() => decompile('getg', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /'R_MIPS_HI16 gByte' at 0x2 falls inside the function \(0x0\.\.0x8\) but on no instruction/,
  );
  // the LO16 at 0x a, past the last instruction, is another function's business and is skipped
  const after = relocs([{ off: 10, type: 'R_MIPS_LO16', sym: 'gByte' }]);
  expect(() => decompile('getg', asm, MIPS_GCC, { asmData: after })).toThrow(/high half 0x0 with no relocation on it/);
});
// ── The choke point ─────────────────────────────────────────────────────────────────────────────
// `if (ins.reloc && !relocTaken) relocPlaceholder(ins)` in `decode` catches a record that reached a
// MODELLED arm which never consulted it — the arm lifts happily, the record evaporates, and the
// immediate it described stays the placeholder. Both inputs below take such an arm, so neither is
// caught by `guardRead` or by the `default:` opaque; delete the choke point and both lift a wrong
// answer that compiles.

test('a LO16 on a modelled arm that never reads it refuses at the choke point', () => {
  // `ori rD,zero,%lo(SYM)` — the low half alone, an idiom `ori` models as a plain bitwise-or of a
  // register and an immediate. Nothing in that arm asks about the relocation; without the choke
  // point the function returns the constant 0 where the symbol's low half belongs.
  const asm = '00000000 <lo>:\n   0:\tori\tv0,zero,0x0\n   4:\tjr\tra\n   8:\tnop\n';
  const rs = relocs([{ off: 0, type: 'R_MIPS_LO16', sym: 'gB' }]);
  expect(() => decompile('lo', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /'ori' at 0x0 carries 'R_MIPS_LO16' against 'gB' but is not a modelled consumer of it/,
  );
});

test('a HI16 on a modelled arm that only checks LO16 refuses at the choke point', () => {
  // `addiu` DOES consult `ins.reloc`, but only for the `%lo` that completes an address. A HI16 on
  // it falls through the arm's ordinary add; without the choke point the lift returns `a0 + 0`.
  const asm = '00000000 <hi>:\n   0:\taddiu\tv0,a0,0\n   4:\tjr\tra\n   8:\tnop\n';
  const rs = relocs([{ off: 0, type: 'R_MIPS_HI16', sym: 'gB' }]);
  expect(() => decompile('hi', asm, MIPS_GCC, { asmData: rs })).toThrow(
    /'addiu' at 0x0 carries 'R_MIPS_HI16' against 'gB' but is not a modelled consumer of it/,
  );
});

test('two globals pair ACROSS BLOCKS, one through a delay slot, into the arm each belongs to', () => {
  // The cross-block, SSA-value-keyed pairing is the whole thesis of frontend/high-half.ts, and
  // every other test in this file is one straight-line block, where an address-order reading and a
  // value reading agree. This is IDO 7.1's own output for `x ? gA : gB` (`-mips2 -O2 -32
  // -non_shared -G 0`), relocation offsets and all — and in it they do not:
  //   the `beqz` DELAY SLOT holds gB's `lui v1`, whose `%lo` is at 0x14, in the TAKEN block;
  //   the fall-through's `lui v1` at 0x8 is gA's, and its `%lo` at 0x10 is the `jr ra` delay slot.
  // One register carries both halves, each is completed in a different block, and the object's
  // relocation records arrive in neither address nor arm order (gA's pair is recorded first).
  // Pairing by anything but the SSA value hands an arm the other global, which compiles.
  const asm =
    '00000000 <cb2>:\n' +
    '   0:\tbeqz\ta0,14 <cb2+0x14>\n' +
    '   4:\tlui\tv1,0x0\n' +
    '   8:\tlui\tv1,0x0\n' +
    '   c:\tjr\tra\n' +
    '  10:\tlw\tv0,0(v1)\n' +
    '  14:\tlw\tv1,0(v1)\n' +
    '  18:\tjr\tra\n' +
    '  1c:\tmove\tv0,v1\n';
  const rs = relocs([
    { off: 0x8, type: 'R_MIPS_HI16', sym: 'gA' },
    { off: 0x10, type: 'R_MIPS_LO16', sym: 'gA' },
    { off: 0x4, type: 'R_MIPS_HI16', sym: 'gB' },
    { off: 0x14, type: 'R_MIPS_LO16', sym: 'gB' },
  ]);
  const src = decompile('cb2', asm, MIPS_GCC, { asmData: rs }).source;
  expect(src).toMatch(/if \(a0 != 0\) \{\s*return gA;\s*\} else \{\s*return gB;\s*\}/);
});

// THE BARE NAME SPELLS ONE SIGNEDNESS AS WELL AS ONE WIDTH. `lh` and `lhu` on one cell are a
// type-pun: two declarations, not one, and a source that wrote the bare `gPun` for both would have
// zero-extended twice. The width half of this rule has a Thumb witness (globals.test.ts); the
// signedness half CANNOT have one — Thumb's `ldrsh`/`ldrsb` take a register offset, and the `add`
// that forms it already marks the symbol an aggregate — so it is witnessed here, where `%hi/%lo`
// addressing needs no such add. Without the signedness term this emits `return gPun + gPun;` and
// the zero-extended read is gone.
test('a symbol read SIGNED and UNSIGNED at offset 0 has no bare spelling', () => {
  const asm =
    '00000000 <pun>:\n   0:\tlui\tv0,0x0\n   4:\tlui\tv1,0x0\n   8:\tlh\tv0,0(v0)\n   c:\tlhu\tv1,0(v1)\n  10:\tjr\tra\n  14:\taddu\tv0,v0,v1\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gPun' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gPun' },
    { off: 4, type: 'R_MIPS_HI16', sym: 'gPun' },
    { off: 12, type: 'R_MIPS_LO16', sym: 'gPun' },
  ]);
  const src = decompile('pun', asm, MIPS_GCC, { asmData: rs }).source;
  expect(src).toContain('*(s16 *)&gPun');
  expect(src).toContain('*(u16 *)&gPun');
  expect(src).not.toContain('gPun + gPun');
});
