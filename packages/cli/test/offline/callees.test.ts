import { calleeBodyBoundOf } from '@asmlift/core/pipeline';
import type { SymbolMap } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC, PPC_MWCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { describe, expect, it } from 'vitest';

import { calleeNames, guessedArityCallees, guessedArityNote } from '../../src/callees';

// `LoadBGTilemapData` scored 578 without `--proto '{"thunk_HeapFree":{"params":1}}'` against a
// 547 baseline, and 24 of one session's 79 ranked runs of it were launched without the flag. The
// note exists so the guess is in the log instead of in a doc the runner has to remember.

const LBG = `
	thumb_func_start LoadBGTilemapData
LoadBGTilemapData: @ 0804B4B0
	push {r4, r5, r6, r7, lr}
	bl DecompressAlloc
	b _0804B604
_0804B604:
	bl thunk_HeapFree
	bl _0804B604
	pop {r0}
`;

describe('calleeNames', () => {
  it('takes the bl targets and drops the ones that are labels in the same asm', () => {
    // agbcc emits `bl` as an intra-function LONG BRANCH — one klonoa function is 28 KB of them,
    // so a bl target is not evidence of a callee unless nothing here defines it.
    expect(calleeNames(LBG, 'LoadBGTilemapData')).toEqual(['DecompressAlloc', 'thunk_HeapFree']);
  });

  it('drops the function itself, and reads objdump operands as well as bare symbols', () => {
    const mips = `
glabel func_80012340
/* 0000 */  jal   func_80012340
/* 0004 */  jal   osRecvMesg
    `;
    expect(calleeNames(mips, 'func_80012340')).toEqual(['osRecvMesg']);
    expect(calleeNames('  bl 8004b60 <thunk_HeapFree>\n', 'Fn')).toEqual(['thunk_HeapFree']);
    // `<name+0x12>` is an interior address, not a call to `name`
    expect(calleeNames('  bl 8004b60 <thunk_HeapFree+0x12>\n', 'Fn')).toEqual([]);
  });

  // `objdump -dr` of an O32 object: `jal 0` is unrelocated, so its `<name>` is whatever sits at
  // .text+0, and the relocation under it names the callee; the dump holds every function in the
  // object, and only the lifted one's calls are its callees
  it('reads a call through its relocation, and only in the lifted function of a whole-object dump', () => {
    const dump = [
      '00000000 <rt8>:',
      '   0:\t27bdfff8 \taddiu\tsp,sp,-8',
      '   4:\t03e00008 \tjr\tra',
      '00000054 <ct8>:',
      '  60:\t0c000000 \tjal\t0 <rt8>',
      '\t\t\t60: R_MIPS_26\ttm8',
      '  68:\t0c00000c \tjal\t30 <st>',
      '\t\t\t68: R_MIPS_26\t.text',
      '  70:\t0c000004 \tjal\t10 <rt8+0x10>',
      '\t\t\t70: R_MIPS_26\tother',
    ].join('\n');
    expect(calleeNames(dump, 'ct8')).toEqual(['tm8', 'st', 'other']);
    expect(calleeNames(dump, 'rt8')).toEqual([]);
    // the MIPS dump prints no relocation; the object's side table holds it
    const bare = ['Disassembly of section .text:', ...dump.split('\n').filter((l) => !l.includes('R_MIPS'))].join('\n');
    const relocs = [
      { section: '.text', offset: 0x60, type: 'R_MIPS_26', sym: 'tm8', addend: 0 },
      { section: '.text', offset: 0x68, type: 'R_MIPS_26', sym: '.text', addend: 0 },
    ];
    expect(calleeNames(bare, 'ct8', relocs)).toEqual(['tm8', 'st']);
    expect(calleeNames(bare, 'ct8')).toEqual(['rt8', 'st']);
  });

  it('ignores a register-indirect call and a mnemonic inside a comment', () => {
    expect(calleeNames('  jalr $t9\n  @ bl NotACall\n  # jal NotACall\n', 'Fn')).toEqual([]);
  });

  it('ignores a CTR-indirect PPC call, which names nothing to report an arity for', () => {
    expect(calleeNames('  bctrl\n', 'Fn')).toEqual([]);
    expect(calleeNames('  bcctrl 20, 0, 0\n', 'Fn')).toEqual([]);
    // and it is still not a call when a comment follows the mnemonic on the same line
    expect(calleeNames('  bctrl # call through r12\n', 'Fn')).toEqual([]);
    // THE case that separates this rule from listing `bctrl` among the call mnemonics: a token
    // after `bctrl` is not the callee — the branch goes to CTR whatever follows it — so a rule
    // that matched the mnemonic and read an operand would report a phantom name here.
    expect(calleeNames('  bctrl foo\n', 'Fn')).toEqual([]);
  });
});

describe('guessedArityCallees', () => {
  it('is every callee when nothing declares one', () => {
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC)).toEqual(['DecompressAlloc', 'thunk_HeapFree']);
  });

  // The lowering reads a callee its project does not declare at the compiler's runtime table, then
  // at the C standard's signatures (`calleeDeclaration`), so neither is a guess; a project entry
  // stating no parameter list leaves it there, and one that states one is read instead.
  it('does not count a runtime helper or a C-standard function, whose signature the lowering reads', () => {
    const asm = 'f:\n\tbl\t__addsf3\n\tbl\t__divsi3\n\tbl\tmemcpy\n\tbl\tlogv\n';
    expect(guessedArityCallees(asm, 'f', ARMV4T_AGBCC)).toEqual(['logv']);
    expect(guessedArityCallees(asm, 'f', ARMV4T_AGBCC, { __divsi3: { returnsVoid: true } })).toEqual(['logv']);
    expect(guessedArityCallees(asm, 'f', ARMV4T_AGBCC, { __divsi3: { params: ['Unsized', 'Unsized'] } })).toEqual([
      '__divsi3',
      'logv',
    ]);
    // PowerPC's table names none of agbcc's helpers
    expect(guessedArityCallees(asm, 'f', PPC_MWCC)).toEqual(['__addsf3', '__divsi3', 'logv']);
  });

  it('counts a --proto entry, in both the count and the typed-list form', () => {
    expect(
      guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, {
        thunk_HeapFree: { params: 1 },
        DecompressAlloc: { params: ['void *', 'u32'] },
      }),
    ).toEqual([]);
  });

  it('does NOT count a params the frontend cannot read — the same reader decides both', () => {
    // `params: "1"` decompiles at a GUESSED arity (`declaredCallArgs` returns undefined), so a
    // note that called it declared would be the exact false reassurance this line exists to prevent.
    expect(
      guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, { thunk_HeapFree: { params: '1' } as never }),
    ).toEqual(['DecompressAlloc', 'thunk_HeapFree']);
  });

  // A `double` is two general argument words where the target passes it in them, and no layout
  // where it does not, so the note asks the frontend's question with the target's answer.
  it('counts a double parameter only on a target that passes it in general words', () => {
    const typed = { thunk_HeapFree: { params: ['double'] }, DecompressAlloc: { params: 2 } };
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, typed)).toEqual([]);
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', PPC_MWCC, typed)).toEqual(['thunk_HeapFree']);
  });

  it('counts a struct passed by value that the declaration lays out, where the target passes it in words', () => {
    const layout = { kind: 'struct' as const, members: [{ name: 'a', type: 'u32' }] };
    const typed = {
      thunk_HeapFree: { params: ['struct S'], byValueLayouts: { 0: layout } },
      DecompressAlloc: { params: 2 },
    };
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, typed)).toEqual([]);
  });

  // `byValueRefusal`: the frontend refuses such a call rather than guess its arity, so the note
  // neither calls it guessed nor advises a `params: N` that would read the struct as N words
  it('does not count a struct passed by value that no rule places, which the frontend refuses', () => {
    const layout = { kind: 'struct' as const, members: [{ name: 'a', type: 'u32' }] };
    const typed = {
      thunk_HeapFree: { params: ['struct S'], byValueLayouts: { 0: layout } },
      DecompressAlloc: { params: 2 },
    };
    // a target that passes no struct in words
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', PPC_MWCC, typed)).toEqual([]);
    // a declaration that does not lay the struct out
    const unlaid = { ...typed, thunk_HeapFree: { params: ['s32', 'struct S'] } };
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, unlaid)).toEqual([]);
    expect(guessedArityNote(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, unlaid)).toBe('');
  });

  it('counts a signature the project ELF declares', () => {
    const symbols: SymbolMap = new Map([
      [
        0x08000100,
        [
          {
            name: 'DecompressAlloc',
            addr: 0x08000100,
            kind: 'code' as const,
            signature: { returns: null, params: [] },
          },
        ],
      ],
    ]);
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, undefined, symbols)).toEqual(['thunk_HeapFree']);
  });
});

describe('guessedArityNote', () => {
  it('is empty when every arity is declared — a clean run says nothing', () => {
    expect(
      guessedArityNote(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, {
        DecompressAlloc: { params: 2 },
        thunk_HeapFree: { params: 1 },
      }),
    ).toBe('');
  });

  it('names the callees and shows the flag that fixes it', () => {
    const note = guessedArityNote(LBG, 'LoadBGTilemapData', ARMV4T_AGBCC, { DecompressAlloc: { params: 2 } });
    expect(note).toContain('asmlift: [proto] 1 callee(s)');
    expect(note).toContain('thunk_HeapFree');
    expect(note).toContain('--proto');
    expect(note.endsWith('\n')).toBe(true);
  });
});

// A callee whose body is in the same input bounds its arity (core frontend/callee-body.ts): one that
// reads no argument is called with none and is no guess; one that reads fewer than every argument
// register is still guessed, at most that many.
describe('a callee bounded by its own body in the input', () => {
  // `objdump -dr` of an O32 object holding the callees beside the lifted function
  const dump = [
    '00000000 <rnd>:',
    '   0:\tjr\tra',
    '   4:\tli\tv0,7',
    '00000008 <rd1>:',
    '   8:\tjr\tra',
    '   c:\taddiu\tv0,a0,1',
    '00000010 <f>:',
    '  10:\tjal\t0 <rnd>',
    '\t\t\t10: R_MIPS_26\trnd',
    '  18:\tjal\t8 <rd1>',
    '\t\t\t18: R_MIPS_26\trd1',
    '  20:\tjal\t0 <rnd>',
    '\t\t\t20: R_MIPS_26\tg',
  ].join('\n');
  it('is not named a guess where it reads none, and carries its bound where it reads some', () => {
    const t = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description;
    const bound = calleeBodyBoundOf('f', dump, t, {});
    expect([bound('rnd'), bound('rd1'), bound('g')]).toEqual([0, 1, undefined]);
    expect(guessedArityCallees(dump, 'f', t)).toEqual(['rnd', 'rd1', 'g']);
    expect(guessedArityCallees(dump, 'f', t, undefined, undefined, undefined, bound)).toEqual(['rd1', 'g']);
    const note = guessedArityNote(dump, 'f', t, undefined, undefined, undefined, bound);
    expect(note).toContain('2 callee(s) have no declared arity, guessed from the argument registers: rd1 (at most 1');
    expect(note).toContain('1 callee(s) have no declared arity and are called with no argument, as their own body');
    expect(note).toMatch(/reads none: rnd\n$/);
  });
});
