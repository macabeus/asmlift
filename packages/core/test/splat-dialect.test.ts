// Splat-dialect MIPS reader (frontend/splat.ts): the pmret/decomp.me `.s` flavour normalises into
// the same DisasmInstr[] the objdump path yields. These pin the dialect-specific behaviour —
// `glabel`/`endlabel` slicing, `/* rom vram bytes */` prefixes, `$`-register stripping, `.L`-label
// branch targets, constant-expression immediates, and `%hi`/`%lo` global recovery (the pair folds
// to a `gaddr`) — plus the loud declines (unpaired `%lo`, PIC relocs, in-code data, tail calls).
import { expect, test } from 'vitest';

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

test('splat: detection is positive on glabel / instruction-comment prefixes, negative on objdump', () => {
  expect(isSplatMips(SPLAT_CLAMP)).toBe(true);
  expect(isSplatMips('00000000 <add1>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n')).toBe(false);
});

test('splat: a full function decompiles — branch, delay slot, .L target, join', () => {
  expect(decompile('func_8000113C_1D3C', SPLAT_CLAMP, MIPS_IDO).source).toBe(
    's32 func_8000113C_1D3C(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    if (a0 <= 0) {\n' +
      '        v0 = 0;\n' +
      '    } else {\n' +
      '        v0 = (a0 << 8 | 255) << 16 >> 16;\n' +
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

test('splat: an escaping interior global pointer (&SYM + N as a value) declines, never element-scales', () => {
  // `addiu a1, rHi, %lo(SYM + 0x18)` makes `&SYM + 24 bytes`; returning it as a VALUE would emit
  // `&SYM + 24`, which C element-scales by sizeof(SYM). The structurer's interior-pointer guard
  // declines rather than silently miscompile. (An addend that stays a load/store BASE is fine —
  // memAccess folds it byte-correctly — so only the escaping form is caught.)
  const interior = `glabel f
    /* 100 80000100 3C05800A */  lui        $a1, %hi(GwPlayer + 0x18)
    /* 104 80000104 24A50018 */  addiu      $a1, $a1, %lo(GwPlayer + 0x18)
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 00A01021 */   addu      $v0, $a1, $zero
endlabel f
`;
  expect(() => decompile('f', interior, MIPS_IDO)).toThrow(/interior pointer arithmetic on the global address/);
});

test('splat: an FP global load (lwc1 %lo) declines loud, never a silently dropped access', () => {
  const fp = `glabel getF
    /* 100 80000100 3C02800A */  lui        $v0, %hi(gFloat)
    /* 104 80000104 C4400000 */  lwc1       $f0, %lo(gFloat)($v0)
    /* 108 80000108 03E00008 */  jr         $ra
    /* 10C 8000010C 00000000 */   nop
endlabel getF
`;
  expect(() => decompile('getF', fp, MIPS_IDO)).toThrow(/unmodelled instruction 'lwc1' with a %hi\/%lo/);
});

test('splat: an unpaired %lo (no matching %hi in scope) declines loud, never a fabricated base', () => {
  const unpaired = `glabel f
    /* 100 80000100 8C820000 */  lw         $v0, %lo(gX)($a0)
    /* 104 80000104 03E00008 */  jr         $ra
    /* 108 80000108 00000000 */   nop
endlabel f
`;
  expect(() => decompile('f', unpaired, MIPS_IDO)).toThrow(/no matching in-scope %hi/);
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
