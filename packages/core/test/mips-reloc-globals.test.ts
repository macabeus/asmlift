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
import { makeHighHalves } from '../src/frontend/high-half';
import { mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

// A minimal AsmData carrying only .text relocations (the bridge reads nothing else).
const relocs = (rs: { off: number; type: string; sym: string }[]): AsmData => ({
  sections: new Map(),
  relocs: rs.map((r) => ({ section: '.text', offset: r.off, type: r.type, sym: r.sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
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

test('an address BELOW the symbol completes as S + off, whichever instruction carries the %lo', () => {
  // `return &gTab[i - 1];` on KMC GCC and GCC 2.7.2 completes the base first, the -4 in the `addiu`'s
  // `%lo`, and adds the index after (recompiled byte-identical on both). The address is exactly
  // S - 4 + idx whether the index sits between the halves (below) or after them.
  const negp =
    '00000000 <negp>:\n   0:\tsll\ta0,a0,0x2\n   4:\tlui\tv0,0x0\n   8:\taddiu\tv0,v0,-4\n   c:\tjr\tra\n  10:\taddu\tv0,a0,v0\n';
  const rs = relocs([
    { off: 4, type: 'R_MIPS_HI16', sym: 'gTab' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gTab' },
  ]);
  expect(decompile('negp', negp, MIPS_GCC, { asmData: rs }).source).toContain('(a0 << 2) + ((u32)&gTab + -4)');
  // and with no index at all (hand-written): `lui %hi(gTab-98304)` / `lw %lo(gTab-98304)` is one
  // constant element far below the symbol
  const asm = '00000000 <getn>:\n   0:\tlui\tv0,0xffff\n   4:\tjr\tra\n   8:\tlw\tv0,-32768(v0)\n';
  const rs2 = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gTab' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gTab' },
  ]);
  expect(decompile('getn', asm, MIPS_GCC, { asmData: rs2 }).source).toContain('((s32 *)&gTab)[-24576]');
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
  // `or v0,v0,a0` reads the half as an operand. It is a link-time placeholder, not a number. (An
  // `addu` of an index is the one non-`%lo` reader that keeps it a half; see below.)
  const asm = '00000000 <asdata>:\n   0:\tlui\tv0,0x0\n   4:\tor\tv0,v0,a0\n   8:\tjr\tra\n   c:\tnop\n';
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

// ── An index between the halves ─────────────────────────────────────────────────────────────────
// ido 7.1, KMC GCC and GCC 2.7.2 all address `S[i]` as `lui rH,%hi(S); addu rH,rH,idx;
// l*/s* x,%lo(S)(rH)`: the scaled byte index is added to the HIGH half, and the `%lo` completes the
// sum. The index sits outside both relocated immediates, so the `%lo` carry is the same with and
// without it and the address is exactly `S + lo + idx` (frontend/high-half.ts `index`). Every input
// below is the named compiler's own output at the benchmark's flags, relocation offsets and all,
// unless it says it is hand-written.

const lift = (name: string, asm: string, rs: { off: number; type: string; sym: string }[], ido = false) =>
  decompile(name, asm, ido ? MIPS_IDO : MIPS_GCC, { asmData: relocs(rs) }).source;
const pair = (sym: string, hi: number, lo: number) => [
  { off: hi, type: 'R_MIPS_HI16', sym },
  { off: lo, type: 'R_MIPS_LO16', sym },
];

test('an index added to the high half completes as S[i] (ido u32 load)', () => {
  // `u32 hi_u32(u32 i) { return gTab[i]; }`
  const asm =
    '00000000 <hi_u32>:\n   0:\tsll\tt6,a0,0x2\n   4:\tlui\tv0,0x0\n   8:\taddu\tv0,v0,t6\n   c:\tjr\tra\n  10:\tlw\tv0,0(v0)\n';
  expect(lift('hi_u32', asm, pair('gTab', 4, 0x10), true)).toContain('((s32 *)&gTab)[a0]');
});

test('an indexed STORE through `at` completes as S[i] = v (KMC/GCC 2.7.2 u32 store)', () => {
  // `void st_u32(u32 i, u32 v) { gTab[i] = v; }` — a store's high half lives in the assembler temporary
  const asm =
    '00000000 <st_u32>:\n   0:\tsll\ta0,a0,0x2\n   4:\tlui\tat,0x0\n   8:\taddu\tat,at,a0\n   c:\tjr\tra\n  10:\tsw\ta1,0(at)\n';
  expect(lift('st_u32', asm, pair('gTab', 4, 0x10))).toMatch(/\(\(s32 \*\)&gTab\)\[a0\] = a1;/);
});

test('an indexed s16 load and a struct FIELD ride the %lo immediate (GCC 2.7.2)', () => {
  // `return gTab[i];` on `s16 gTab[]`, and `return gArr[i].b;` on an 8-byte struct (lhu 2(v0))
  const s16 =
    '00000000 <ld_s16>:\n   0:\tsll\ta0,a0,0x1\n   4:\tlui\tv0,0x0\n   8:\taddu\tv0,v0,a0\n   c:\tjr\tra\n  10:\tlh\tv0,0(v0)\n';
  expect(lift('ld_s16', s16, pair('gTab', 4, 0x10))).toContain('((s16 *)&gTab)[a0]');
  const fld =
    '00000000 <fld>:\n   0:\tsll\ta0,a0,0x3\n   4:\tlui\tv0,0x0\n   8:\taddu\tv0,v0,a0\n   c:\tjr\tra\n  10:\tlhu\tv0,2(v0)\n';
  expect(lift('fld', fld, pair('gArr', 4, 0x10))).toContain('((struct Elem0 *)&gArr)[a0].field_2');
});

test('a pre-summed 2-D index, and a load and a store of two globals, each pair to their own symbol (ido)', () => {
  // `return g2[i][j];` on `u8 g2[4][8]`: ido sums (i << 3) + j first, then adds it to the half
  const twoD =
    '00000000 <two_d>:\n   0:\tsll\tt6,a0,0x3\n   4:\taddu\tt7,t6,a1\n   8:\tlui\tv0,0x0\n   c:\taddu\tv0,v0,t7\n  10:\tjr\tra\n  14:\tlbu\tv0,0(v0)\n';
  expect(lift('two_d', twoD, pair('g2', 8, 0x14), true)).toContain('((u8 *)&g2)[(a0 << 3) + a1]');
  // `gA[i] = gB[j];` on u16 tables
  const ldst =
    '00000000 <ldst>:\n   0:\tsll\tt6,a1,0x1\n   4:\tlui\tt7,0x0\n   8:\taddu\tt7,t7,t6\n   c:\tlhu\tt7,0(t7)\n' +
    '  10:\tsll\tt8,a0,0x1\n  14:\tlui\tat,0x0\n  18:\taddu\tat,at,t8\n  1c:\tjr\tra\n  20:\tsh\tt7,0(at)\n';
  const src = lift('ldst', ldst, [...pair('gB', 4, 0xc), ...pair('gA', 0x14, 0x20)], true);
  expect(src).toMatch(
    /\(\(u16 \*\)&gA\)\[a0\] = \(\(u16 \*\)&gB\)\[a1\]|= \(\(u16 \*\)&gB\)\[a1\];[\s\S]*\(\(u16 \*\)&gA\)\[a0\] =/,
  );
});

test('each arm of a branch pairs its own indexed half, the constant element in the %lo (ido)', () => {
  // `if (c) return gTab[i]; return gTab[i + 1];` — the `i + 1` arm reads `lw v0,4(v0)`
  const asm =
    '00000000 <cond>:\n   0:\tbeqz\ta1,1c <cond+0x1c>\n   4:\tsll\tt7,a0,0x2\n   8:\tsll\tt6,a0,0x2\n' +
    '   c:\tlui\tv0,0x0\n  10:\taddu\tv0,v0,t6\n  14:\tjr\tra\n  18:\tlw\tv0,0(v0)\n' +
    '  1c:\tlui\tv0,0x0\n  20:\taddu\tv0,v0,t7\n  24:\tlw\tv0,4(v0)\n  28:\tjr\tra\n  2c:\tnop\n';
  const src = lift('cond', asm, [...pair('gTab', 0xc, 0x18), ...pair('gTab', 0x1c, 0x24)], true);
  expect(src).toMatch(/\[a0 \+ 1\]/);
  expect(src).toMatch(/\[a0\]/);
});

test('the index may come FIRST in the addu — it commutes (hand-written: no compiler measured emits it)', () => {
  const asm =
    '00000000 <rev>:\n   0:\tsll\tt6,a0,0x2\n   4:\tlui\tv0,0x0\n   8:\taddu\tv0,t6,v0\n   c:\tjr\tra\n  10:\tlw\tv0,0(v0)\n';
  expect(lift('rev', asm, pair('gTab', 4, 0x10), true)).toContain('((s32 *)&gTab)[a0]');
});

test('two indexes off ONE high half each complete their own access (hand-written)', () => {
  // No compiler measured shares one `lui` between two indexed accesses, but each derivation is its
  // own `S + idx`, so the sum is exact either way.
  const asm =
    '00000000 <shared>:\n   0:\tlui\tv1,0x0\n   4:\taddu\tt0,v1,a0\n   8:\taddu\tt1,v1,a1\n' +
    '   c:\tlbu\tv0,0(t0)\n  10:\tlbu\tt2,0(t1)\n  14:\tjr\tra\n  18:\taddu\tv0,v0,t2\n';
  const rs = [
    { off: 0, type: 'R_MIPS_HI16', sym: 'gTab' },
    { off: 0xc, type: 'R_MIPS_LO16', sym: 'gTab' },
    { off: 0x10, type: 'R_MIPS_LO16', sym: 'gTab' },
  ];
  const src = lift('shared', asm, rs, true);
  expect(src).toMatch(/\[a0\] \+ [\s\S]*\[a1\]/);
});

test('an INDEXED half may complete below the symbol: S[i - k] puts -k elements in the %lo (ido, KMC, GCC 2.7.2)', () => {
  // `return gTab[i - 1];` is `lw v0,-4(v0)` on all three. With an index between the halves the
  // address is S + idx - 4, which C spells as a subscript. Recompiled byte-identical on all three.
  const asm =
    '00000000 <off_neg>:\n   0:\tsll\tt6,a0,0x2\n   4:\tlui\tv0,0x0\n   8:\taddu\tv0,v0,t6\n   c:\tjr\tra\n  10:\tlw\tv0,-4(v0)\n';
  expect(lift('off_neg', asm, pair('gTab', 4, 0x10), true)).toContain('((s32 *)&gTab)[a0 + -1]');
  // a store two halfwords below: `gTab[i - 2] = v;` on s16 (GCC 2.7.2: `sh a1,-4(at)`)
  const st =
    '00000000 <st_neg>:\n   0:\tsll\ta0,a0,0x1\n   4:\tlui\tat,0x0\n   8:\taddu\tat,at,a0\n   c:\tjr\tra\n  10:\tsh\ta1,-4(at)\n';
  expect(lift('st_neg', st, pair('gTab', 4, 0x10))).toMatch(/\(\(u16 \*\)&gTab\)\[a0 \+ -2\] = a1;/);
});

// The refusals. Every one is hand-written: no compiler measured emits these shapes, and each would
// otherwise lift a placeholder as a number or drop the address it was building.
test('an indexed half READ AS A VALUE refuses', () => {
  const asm =
    '00000000 <v>:\n   0:\tlui\tv0,0x0\n   4:\taddu\tv0,v0,a0\n   8:\tor\tv0,v0,a1\n   c:\tjr\tra\n  10:\tnop\n';
  expect(() => lift('v', asm, [{ off: 0, type: 'R_MIPS_HI16', sym: 'gTab' }])).toThrow(
    /v0 holds the high half of 'gTab' \(the 'addu' at 0x4\) and is read as a value/,
  );
});

test('a COPY of a high half refuses in every spelling, addu with zero included', () => {
  // `addu v1,v0,zero` is the same move as `move v1,v0` and `or v1,v0,zero`; it is no index
  const copy = (op: string) =>
    `00000000 <c>:\n   0:\tlui\tv0,0x0\n   4:\t${op}\n   8:\tlw\tv0,4(v1)\n   c:\tjr\tra\n  10:\tnop\n`;
  for (const op of ['move\tv1,v0', 'or\tv1,v0,zero', 'addu\tv1,v0,zero', 'addu\tv1,zero,v0']) {
    expect(() => lift('c', copy(op), pair('gTab', 0, 8))).toThrow(
      /v0 holds the high half of 'gTab' \(the 'lui' at 0x0\) and is read as a value/,
    );
  }
});

test('an indexed half RETURNED with no %lo refuses: the address is never completed', () => {
  const asm = '00000000 <r>:\n   0:\tlui\tv0,0x0\n   4:\taddu\tv0,v0,a0\n   8:\tjr\tra\n   c:\tnop\n';
  expect(() => lift('r', asm, [{ off: 0, type: 'R_MIPS_HI16', sym: 'gTab' }])).toThrow(
    /'addu' at 0x4 carries the '%hi' half of 'gTab' and no modelled instruction consumes its '%lo' half/,
  );
});

test('an indexed half carried into a MERGE refuses', () => {
  // one arm leaves the indexed half in v0, the other an ordinary value; the join's `lw` cannot pair
  const asm =
    '00000000 <m>:\n   0:\tlui\tv0,0x0\n   4:\tbeqz\ta1,10 <m+0x10>\n   8:\taddu\tv0,v0,a0\n   c:\tmove\tv0,a2\n' +
    '  10:\tlw\tv0,0(v0)\n  14:\tjr\tra\n  18:\tnop\n';
  const rs = [
    { off: 0, type: 'R_MIPS_HI16', sym: 'gTab' },
    { off: 0x10, type: 'R_MIPS_LO16', sym: 'gTab' },
  ];
  expect(() => lift('m', asm, rs)).toThrow(/'%lo' half of 'gTab' but v0 holds no high half here/);
});

test('two high halves added together, and a second index chained on an indexed half, refuse', () => {
  const both =
    '00000000 <b>:\n   0:\tlui\tv0,0x0\n   4:\tlui\tv1,0x0\n   8:\taddu\tv0,v0,v1\n   c:\tjr\tra\n  10:\tlw\tv0,0(v0)\n';
  const rsBoth = [
    { off: 0, type: 'R_MIPS_HI16', sym: 'gA' },
    { off: 4, type: 'R_MIPS_HI16', sym: 'gB' },
    { off: 0x10, type: 'R_MIPS_LO16', sym: 'gA' },
  ];
  expect(() => lift('b', both, rsBoth)).toThrow(/adds a high half to another high half/);
  const chain =
    '00000000 <c>:\n   0:\tlui\tv0,0x0\n   4:\taddu\tv0,v0,a0\n   8:\taddu\tv0,v0,a1\n   c:\tjr\tra\n  10:\tlw\tv0,0(v0)\n';
  expect(() => lift('c', chain, pair('gTab', 0, 0x10))).toThrow(/adds a second index to the high half of 'gTab'/);
});

test('an indexed half completed by the %lo of ANOTHER symbol refuses', () => {
  const asm = '00000000 <o>:\n   0:\tlui\tv0,0x0\n   4:\taddu\tv0,v0,a0\n   8:\tjr\tra\n   c:\tlw\tv0,0(v0)\n';
  const rs = [
    { off: 0, type: 'R_MIPS_HI16', sym: 'gA' },
    { off: 0xc, type: 'R_MIPS_LO16', sym: 'gB' },
  ];
  expect(() => lift('o', asm, rs)).toThrow(/'%lo' half of 'gB' but v0 holds the high half of 'gA'/);
});

test('an indexed half pairs only for a consumer that says it completes the index', () => {
  // The index rides on the SHARED HighHalfInfo, so a consumer that builds `gaddr(sym) + addend`
  // and never reads it (PowerPC's folds today) would drop the index and still compile. pair()
  // makes the opt-in explicit, so such a consumer refuses instead.
  const hh = makeHighHalves({
    hi: '%hi',
    hiArticle: 'a',
    lo: '%lo',
    fail: (m) => {
      throw new Error(m);
    },
  });
  const [half, indexed, idx] = [mkValue(T.unk(32)), mkValue(T.unk(32)), mkValue(T.unk(32))];
  hh.record(half, { sym: 'gTab', addend: 0, addr: 0, mnemonic: 'lui' });
  hh.index(indexed, half, idx, { addr: 4, mnemonic: 'addu' });
  expect(() => hh.pair('the lw at 0xc', 'v0', indexed, 'gTab')).toThrow(
    /plus a runtime index \(the 'addu' at 0x4\), and this consumer completes no index/,
  );
  expect(hh.pair('the lw at 0xc', 'v0', indexed, 'gTab', undefined, true).index).toBe(idx);
});

test('an UNRECOVERED jump-table dispatch through an indexed half still declines', () => {
  // `lui at,%hi(jtbl); addu at,at,t6; lw t6,%lo(jtbl)(at); jr t6` with no `.rodata` contents to
  // recover the table from: the load lifts, and the jump through what it loaded must refuse.
  const asm =
    '00000000 <sw>:\n   0:\tsltiu\tat,a0,4\n   4:\tbeqz\tat,28 <sw+0x28>\n   8:\tsll\tt6,a0,0x2\n' +
    '   c:\tlui\tat,0x0\n  10:\taddu\tat,at,t6\n  14:\tlw\tt6,0(at)\n  18:\tjr\tt6\n  1c:\tnop\n' +
    '  20:\tjr\tra\n  24:\tli\tv0,1\n  28:\tjr\tra\n  2c:\tmove\tv0,zero\n';
  const rs = [
    { off: 0xc, type: 'R_MIPS_HI16', sym: '.rodata' },
    { off: 0x14, type: 'R_MIPS_LO16', sym: '.rodata' },
  ];
  expect(() => lift('sw', asm, rs, true)).toThrow(/indirect jump 'jr t6' at 0x18/);
});
