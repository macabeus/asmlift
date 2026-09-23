// Splat-dialect MIPS reader (frontend/splat.ts): the pmret/decomp.me `.s` flavour normalises into
// the same DisasmInstr[] the objdump path yields. These pin the dialect-specific behaviour —
// `glabel`/`endlabel` slicing, `/* rom vram bytes */` prefixes, `$`-register stripping, `.L`-label
// branch targets, constant-expression immediates, and `%hi`/`%lo` global recovery (the pair folds
// to a `gaddr`) — plus the loud declines (unpaired `%lo`, PIC relocs, in-code data, tail calls).
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { classifyAsmText } from '../src/frontend/format';
import { isSplatMips, parseSplatMips } from '../src/frontend/splat';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

// A branch, a delay slot, a `.L` label target, and a fall-through join — the whole dialect at once.
const SPLAT_CLAMP = `nonmatching func_8000113C_1D3C, 0x24

glabel func_8000113C_1D3C
    /* 1D3C 8000113C 18800005 */  blez       $a0, .L80001154_1D54
    /* 1D40 80001140 00041200 */   sll       $v0, $a0, 8
    /* 1D44 80001144 344200FF */  ori        $v0, $v0, 0xFF
    /* 1D48 80001148 00021400 */  sll        $v0, $v0, 16
    /* 1D4C 8000114C 08000456 */  j          .L80001158_1D58
    /* 1D50 80001150 00021403 */   sra       $v0, $v0, 16
  .L80001154_1D54:
    /* 1D54 80001154 00001021 */  addu       $v0, $zero, $zero
  .L80001158_1D58:
    /* 1D58 80001158 03E00008 */  jr         $ra
    /* 1D5C 8000115C 00000000 */   nop
endlabel func_8000113C_1D3C
`;

// `lui;ori` of a constant-expression hi/lo split — the assembler's way of materialising 0x660104.
const SPLAT_CONST = `glabel func_80000EFC_1AFC
    /* 1AFC 80000EFC 3C020066 */  lui        $v0, (0x660104 >> 16)
    /* 1B00 80000F00 03E00008 */  jr         $ra
    /* 1B04 80000F04 34420104 */   ori       $v0, $v0, (0x660104 & 0xFFFF)
endlabel func_80000EFC_1AFC
`;

// Two functions in one listing — the slicer must select exactly the requested one.
const SPLAT_TWO = `glabel add1
    /* 100 80000100 03E00008 */  jr         $ra
    /* 104 80000104 24820001 */   addiu     $v0, $a0, 1
endlabel add1
glabel add2
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 24820002 */   addiu     $v0, $a0, 2
endlabel add2
`;

// A scalar global read via the `%hi`/`%lo` pair — recovers to the bare global name `D_800A2884`.
const SPLAT_GLOBAL = `glabel getGlobal
    /* 200 80000200 3C02800A */  lui        $v0, %hi(D_800A2884)
    /* 204 80000204 03E00008 */  jr         $ra
    /* 208 80000208 8C422884 */   lw        $v0, %lo(D_800A2884)($v0)
endlabel getGlobal
`;

// A `%hi`/`%lo` this reader cannot resolve to a symbol. `%lo(NUM)(reg)` matches the memory-operand
// shape, whose displacement is evaluated as arithmetic, so the address would silently become an
// index into the base register; the half must refuse instead.
const SPLAT_NUMERIC_HILO = `glabel f
    /* 200 80000200 3C02800A */  lui        $v0, %hi(0x800A1234)
    /* 204 80000204 03E00008 */  jr         $ra
    /* 208 80000208 8C422884 */   lw        $v0, %lo(0x800A1234)($v0)
endlabel f
`;

test('splat: a %hi/%lo half with no symbol refuses instead of lifting a null base', () => {
  expect(() => decompile('f', SPLAT_NUMERIC_HILO, MIPS_IDO)).toThrow(
    /relocation operand '%hi\(0x800A1234\)'.*only against a symbol/s,
  );
});

// `020` is 16 to the assembler and 20 to `parseInt(t, 10)`, and the difference reaches the emitted
// C as a different ELEMENT: the `%lo` addend lifted as `((s32 *)&gTab)[5]` where the assembler's
// addend gives `[4]`, and `%lo(gTab + 010)` as the index `2.5`. A wrong address compiles and
// scores, so every reader that turns a digit string into a value here refuses the radix it does
// not model — and there are three of them, which is why this is a table rather than one case. The
// assembler's own readings, measured with `mips-linux-gnu-as` 2.45: `.word 020` is 0x10, `.word
// 010` is 8, `lw $v0, 020($a0)` encodes the displacement 16 and `addiu $v0,$a0,020` the immediate
// 16. Each row's control is the same operand written without the leading zero.
describe('splat: a leading-zero magnitude is a radix this reader does not model', () => {
  const mk = (mid: string) => `glabel f
    /* 200 80000200 3C02800A */  ${mid}
    /* 204 80000204 03E00008 */  jr         $ra
    /* 208 80000208 00000000 */   nop
endlabel f
`;
  test.each([
    // the relocation addend — the pattern that feeds `evalConst`. Its halves travel in a pair, so
    // this row carries both: a lone `%hi` declines on the missing `%lo` whatever its radix.
    [
      'lui        $v0, %hi(gTab + 020)\n    /* 204 80000204 8C422884 */  lw         $v0, %lo(gTab + 020)($v0)',
      'lui        $v0, %hi(gTab + 16)\n    /* 204 80000204 8C422884 */  lw         $v0, %lo(gTab + 16)($v0)',
    ],
    // the memory displacement — `evalConst` again, one caller over
    ['lw         $v0, 020($a0)', 'lw         $v0, 16($a0)'],
    // a bare constant expression, where the zero is buried in an operand that parses
    ['lw         $v0, (0x8+010)($a0)', 'lw         $v0, (0x8+8)($a0)'],
    // and the operand that passes through UNREAD, whose reader is `addiu`'s re-sign
    ['addiu      $v0, $a0, 020', 'addiu      $v0, $a0, 16'],
  ])('%s refuses, and %s still reads', (bad, control) => {
    expect(() => decompile('f', mk(bad), MIPS_IDO)).toThrow(
      /has a leading-zero magnitude \('0\d+'\), which is octal to the assembler/,
    );
    expect(() => decompile('f', mk(control), MIPS_IDO)).not.toThrow();
  });

  // A lone `0` is not an octal marker and `0($sp)` is the commonest displacement there is, so the
  // rule must not reach it. `0x0` and `0x08` are the radix this reader DOES model, spelt with a
  // zero where the eye expects the trap.
  test.each(['lw         $v0, 0($a0)', 'lw         $v0, 0x08($a0)', 'addiu      $v0, $a0, 0'])(
    '%s is not a leading-zero magnitude',
    (good) => {
      expect(() => decompile('f', mk(good), MIPS_IDO)).not.toThrow();
    },
  );
});

test('splat: a non-numeric immediate refuses rather than becoming the literal 0', () => {
  // An assembler-macro name in an immediate slot reaches the frontend as operand text, where bare
  // `parseImm` answers NaN and `constVal` would render that as 0 — the relocation fold's own
  // failure one level down.
  const asm = `glabel f
    /* 200 80000200 24820001 */  addiu      $v0, $a0, MY_CONST
    /* 204 80000204 03E00008 */  jr         $ra
    /* 208 80000208 00000000 */   nop
endlabel f
`;
  expect(() => decompile('f', asm, MIPS_IDO)).toThrow(/non-numeric immediate 'MY_CONST' where a number belongs/);
});

test('splat: detection is positive on glabel / instruction-comment prefixes, negative on objdump', () => {
  expect(isSplatMips(SPLAT_CLAMP)).toBe(true);
  expect(isSplatMips('00000000 <add1>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n')).toBe(false);
});

test('splat: a full function decompiles — branch, delay slot, .L target, join', () => {
  expect(decompile('func_8000113C_1D3C', SPLAT_CLAMP, MIPS_IDO).source).toBe(
    's32 func_8000113C_1D3C(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    if (a0 > 0) {\n' +
      // `(s16)` and not the raw `<< 16 >> 16` because IDO lowers a signed narrowing cast to
      // exactly that pair, so the cast idiom folds here (pattern/engine.ts). BYTE-NEUTRAL, compiled
      // both ways at this row's flags: the two spellings of this whole function are one object,
      // `blez / move / sll 8 / ori / sll 0x10 / jr / sra 0x10 / jr / move`.
      '        v0 = (s16)(a0 << 8 | 255);\n' +
      '    } else {\n' +
      '        v0 = 0;\n' +
      '    }\n' +
      '    return v0;\n' +
      '}\n',
  );
});

test('splat: a lui/ori constant-expression pair folds to the 32-bit literal', () => {
  expect(decompile('func_80000EFC_1AFC', SPLAT_CONST, MIPS_IDO).source).toBe(
    's32 func_80000EFC_1AFC(void) {\n    return 6684932;\n}\n', // 0x660104
  );
});

test('splat: the requested name selects ITS function; an absent symbol declines loud', () => {
  expect(decompile('add1', SPLAT_TWO, MIPS_IDO).source).toBe('s32 add1(s32 a0) {\n    return a0 + 1;\n}\n');
  expect(decompile('add2', SPLAT_TWO, MIPS_IDO).source).toBe('s32 add2(s32 a0) {\n    return a0 + 2;\n}\n');
  expect(() => parseSplatMips(SPLAT_TWO, 'ghost')).toThrow(/functions present: add1, add2/);
});

test('splat: a lui %hi + lw %lo pair recovers a scalar global read (bare name, no NaN)', () => {
  // the whole point of preserving %hi/%lo: they fold to a `gaddr`, not a NaN immediate
  expect(decompile('getGlobal', SPLAT_GLOBAL, MIPS_IDO).source).toBe(
    's32 getGlobal(void) {\n    return D_800A2884;\n}\n',
  );
});

test('splat: a read-modify-write through one global recovers to `g = g + 1`', () => {
  const rmw = `glabel bump
    /* 100 80000100 3C02800A */  lui        $v0, %hi(gCounter)
    /* 104 80000104 8C430000 */  lw         $v1, %lo(gCounter)($v0)
    /* 108 80000108 24630001 */  addiu      $v1, $v1, 1
    /* 10C 8000010C 03E00008 */  jr         $ra
    /* 110 80000110 AC430000 */   sw        $v1, %lo(gCounter)($v0)
endlabel bump
`;
  expect(decompile('bump', rmw, MIPS_IDO).source).toContain('gCounter = gCounter + 1;');
});

test('splat: a %hi/%lo pair with an addend recovers an aggregate access through the symbol', () => {
  // `%hi(SYM + 0x8)` / `%lo(SYM + 0x8)` → the global accessed at byte offset 8 → the `&`-address form
  const agg = `glabel getField
    /* 100 80000100 3C02800A */  lui        $v0, %hi(gStruct + 0x8)
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 8C420008 */   lw        $v0, %lo(gStruct + 0x8)($v0)
endlabel getField
`;
  expect(decompile('getField', agg, MIPS_IDO).source).toContain('&gStruct');
});

test('splat: an escaping interior global pointer (&SYM + N as a value) intifies, never element-scales', () => {
  // `addiu a1, rHi, %lo(SYM + 0x18)` makes `&SYM + 24 bytes`; returning it as a VALUE must not
  // emit `&SYM + 24` (C element-scales by sizeof(SYM), unknowable here). The additive lowering
  // spells the honest integer math on the address instead — `(u32)&SYM + 24`, byte-exact under
  // any project declaration. (An addend that stays a load/store BASE folds byte-correctly via
  // memAccess; this pins the escaping VALUE form, which used to decline the whole function.)
  const interior = `glabel f
    /* 100 80000100 3C05800A */  lui        $a1, %hi(GwPlayer + 0x18)
    /* 104 80000104 24A50018 */  addiu      $a1, $a1, %lo(GwPlayer + 0x18)
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 00A01021 */   addu      $v0, $a1, $zero
endlabel f
`;
  const src = decompile('f', interior, MIPS_IDO).source;
  expect(src).toContain('(u32)&GwPlayer + 24');
  expect(src).not.toMatch(/[^)]&GwPlayer \+/); // the bare, element-scaling form must be gone
});

test('splat: an FP global load (lwc1 %lo) declines loud, never a silently dropped access', () => {
  const fp = `glabel getF
    /* 100 80000100 3C02800A */  lui        $v0, %hi(gFloat)
    /* 104 80000104 C4400000 */  lwc1       $f0, %lo(gFloat)($v0)
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 00000000 */   nop
endlabel getF
`;
  expect(() => decompile('getF', fp, MIPS_IDO)).toThrow(/'lwc1'.*R_MIPS_LO16.*'gFloat'.*not a modelled consumer/s);
});

test('splat: an unpaired %lo (no matching %hi in scope) declines loud, never a fabricated base', () => {
  const unpaired = `glabel f
    /* 100 80000100 8C820000 */  lw         $v0, %lo(gX)($a0)
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 00000000 */   nop
endlabel f
`;
  expect(() => decompile('f', unpaired, MIPS_IDO)).toThrow(/a0 holds no high half here/);
});

test('splat: a GOT/PIC relocation operand still declines loud (small-data access not modelled)', () => {
  const got = `glabel f
    /* 100 80000100 8F820000 */  lw         $v0, %got(gX)($gp)
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 00000000 */   nop
endlabel f
`;
  expect(() => decompile('f', got, MIPS_IDO)).toThrow(FrontendUnsupportedError);
  expect(() => decompile('f', got, MIPS_IDO)).toThrow(/PIC data access/);
});

test('splat: a data directive in the code stream declines (no silent deletion)', () => {
  const withData = `glabel f
    /* 100 80000100 24020001 */  addiu      $v0, $zero, 1
    /* 104 80000104 00000000 */  .word      0xDEADBEEF
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 00000000 */   nop
endlabel f
`;
  expect(() => parseSplatMips(withData, 'f')).toThrow(/data directive '\.word'/);
});

test('splat: a tail-call jump to a non-local target declines loud, never a TypeError crash', () => {
  const tail = `glabel f
    /* 100 80000100 08000456 */  j          func_other
    /* 104 80000104 00000000 */   nop
endlabel f
`;
  // `j func_other` leaves no resolvable local label — must decline, not crash in succ()
  expect(() => decompile('f', tail, MIPS_IDO)).toThrow(FrontendUnsupportedError);
  expect(() => decompile('f', tail, MIPS_IDO)).toThrow(/tail call \/ cross-function branch not modelled/);
});

test('splat: addiu sign-extends a masked low-half ≥ 0x8000 (matches objdump semantics)', () => {
  // `lui 0x8001; addiu -0x5433` materialises 0x8000ABCD; Splat spells the low half as an unsigned
  // mask `(0x8000ABCD & 0xFFFF)` = 0xABCD, which addiu sign-extends to -0x5433. The two spellings
  // (Splat masked vs objdump signed) must fold to the SAME constant.
  const masked = `glabel f
    /* 100 80000100 3C028001 */  lui        $v0, (0x8001ABCD >> 16)
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 2442ABCD */   addiu     $v0, $v0, (0x8001ABCD & 0xFFFF)
endlabel f
`;
  const signed = `glabel f
    /* 100 80000100 3C028001 */  lui        $v0, 0x8001
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 2442ABCD */   addiu     $v0, $v0, -0x5433
endlabel f
`;
  const a = decompile('f', masked, MIPS_IDO).source;
  const b = decompile('f', signed, MIPS_IDO).source;
  expect(a).toBe(b); // 0x8001ABCD - 0x5433 low-half correction → same 32-bit literal
});

test('splat: classifyAsmText names the format so a mis-fed Splat file declines on other frontends', () => {
  expect(classifyAsmText(SPLAT_CLAMP)).toBe('splat');
  // objdump / gnu-as inputs are unaffected by the new signal
  expect(classifyAsmText('00000000 <add1>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n')).toBe('objdump');
  // a Splat file handed to the ARM/agbcc (gnu-as) target declines at the format boundary
  expect(() => decompile('func_8000113C_1D3C', SPLAT_CLAMP, ARMV4T_AGBCC)).toThrow(/looks like Splat/);
});
