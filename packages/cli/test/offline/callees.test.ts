import type { SymbolMap } from '@asmlift/core/symbols';
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

  it('ignores a register-indirect call and a mnemonic inside a comment', () => {
    expect(calleeNames('  jalr $t9\n  @ bl NotACall\n  # jal NotACall\n', 'Fn')).toEqual([]);
  });
});

describe('guessedArityCallees', () => {
  it('is every callee when nothing declares one', () => {
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData')).toEqual(['DecompressAlloc', 'thunk_HeapFree']);
  });

  it('counts a --proto entry, in both the count and the typed-list form', () => {
    expect(
      guessedArityCallees(LBG, 'LoadBGTilemapData', {
        thunk_HeapFree: { params: 1 },
        DecompressAlloc: { params: ['void *', 'u32'] },
      }),
    ).toEqual([]);
  });

  it('does NOT count a params the frontend cannot read — the same reader decides both', () => {
    // `params: "1"` decompiles at a GUESSED arity (protoArity returns undefined), so a note that
    // called it declared would be the exact false reassurance this line exists to prevent.
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', { thunk_HeapFree: { params: '1' } as never })).toEqual([
      'DecompressAlloc',
      'thunk_HeapFree',
    ]);
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
    expect(guessedArityCallees(LBG, 'LoadBGTilemapData', undefined, symbols)).toEqual(['thunk_HeapFree']);
  });
});

describe('guessedArityNote', () => {
  it('is empty when every arity is declared — a clean run says nothing', () => {
    expect(
      guessedArityNote(LBG, 'LoadBGTilemapData', { DecompressAlloc: { params: 2 }, thunk_HeapFree: { params: 1 } }),
    ).toBe('');
  });

  it('names the callees and shows the flag that fixes it', () => {
    const note = guessedArityNote(LBG, 'LoadBGTilemapData', { DecompressAlloc: { params: 2 } });
    expect(note).toContain('asmlift: [proto] 1 callee(s)');
    expect(note).toContain('thunk_HeapFree');
    expect(note).toContain('--proto');
    expect(note.endsWith('\n')).toBe(true);
  });
});
