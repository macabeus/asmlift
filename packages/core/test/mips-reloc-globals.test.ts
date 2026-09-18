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
  // without the relocs the symbol is invisible → the honest raw-address read
  expect(decompile('getg', asm, MIPS_GCC).source).toContain('*(s8 *)0');
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
  // `.rodata`/`.data` names an offset into a section — an anonymous datum C cannot spell. Excluding
  // it from the carrier left the pair raw, and raw is the `lui`'s link-time placeholder: this same
  // input used to render `*(s8 *)0`, a wrong answer that compiles. The fold now recovers the name;
  // it is loud twice over downstream (rank-declare.ts refuses the declaration and REPORTS it, and
  // the source does not compile), which is strictly more than a frontend refusal would say.
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
  // An FP load is not a modelled global consumer. Today the pair is left raw and the `lwc1` becomes
  // an opaque — the global access silently deleted. The relocation nothing consumed must refuse.
  const asm = '00000000 <getf>:\n   0:\tlui\tv0,0x0\n   4:\tlwc1\t$f0,0(v0)\n   8:\tjr\tra\n   c:\tnop\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gFloat' },
    { off: 4, type: 'R_MIPS_LO16', sym: 'gFloat' },
  ]);
  expect(() => decompile('getf', asm, MIPS_GCC, { asmData: rs })).toThrow(/lwc1.*gFloat/s);
});

test('two high halves of ONE symbol pair by VALUE, not by address order', () => {
  // One symbol, two `lui`s, two `%lo` consumers whose BASE REGISTERS cross — the shape that shows
  // why address order is the wrong pairing rule. Pairing "the first unconsumed same-symbol LO16
  // after this HI16" hands each `lui` the other one's consumer; asking SSA which value the base
  // register holds cannot. The N64 checkouts carry the degenerate form of this (two HI16 against
  // one symbol sharing a LO16), where greedy pairing rewrites the `lui` that does NOT reach the
  // consumer and the access then declines for a reason that is not the real one.
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
  // its own instruction carried rather than the one greedy pairing would have handed it.
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
