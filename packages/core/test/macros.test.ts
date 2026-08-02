// Address-cast macro recognition: the OTHER way a project names a fixed RAM cell, and the one
// that makes an old compiler emit the NUMERIC pool word a target shows. Everything recognized is
// a fact spelled exactly; everything else is refused (a wrong width or a dropped `volatile` is
// the plausible-but-wrong class this project exists to avoid).
import { describe, expect, test } from 'vitest';

import { addressCastMacros, macroDefinesUsedBy } from '../src/macros';

const one = (text: string) => [...addressCastMacros(text).values()];

describe('addressCastMacros', () => {
  test('recognizes the exact shape, with its width and signedness', () => {
    expect(one('#define gCounter (*(u16 *)0x03001234)')).toEqual([
      { name: 'gCounter', address: 0x03001234, body: '(*(u16 *)0x03001234)', size: 2, signed: false },
    ]);
    expect(one('#define gLevel (*(s8 *)0x03000001)')[0]).toMatchObject({ size: 1, signed: true });
  });

  test('carries the body VERBATIM — the declaration must reproduce the header', () => {
    expect(one('#define g   (*( u32 * ) 0x03005290)')[0].body).toBe('(*( u32 * ) 0x03005290)');
  });

  test('ACCEPTS a volatile alias, CARRYING the qualifier', () => {
    // Superseded refusal. The guarantee was "the qualifier is never silently dropped", and it
    // used to be met by refusing the macro outright — which cost every MMIO register name a GBA
    // project has, since those are exactly the cells one declares volatile. It is now met by
    // carrying the fact instead, which is the same guarantee at none of the cost.
    expect(one('#define gPauseFlag (*(vu8 *)0x030034E4)')).toEqual([
      // the body is re-spelled even though the address was already a literal: `vu8` is a PROJECT
      // typedef and the prelude a candidate compiles against has none, so keeping it verbatim
      // republishes a `#define` that does not compile
      {
        name: 'gPauseFlag',
        address: 0x030034e4,
        body: '(*(volatile u8 *)0x30034E4)',
        size: 1,
        signed: false,
        volatile: true,
      },
    ]);
  });

  test('a NON-volatile alias carries no qualifier — the flag is a fact, not a default', () => {
    expect(one('#define gPlain (*(u8 *)0x030034E4)')[0]).not.toHaveProperty('volatile');
  });

  test('REFUSES an unknown type spelling rather than guessing its width', () => {
    expect(one('#define gThing (*(SomeEnum *)0x03001234)')).toEqual([]);
    expect(one('#define gThing (*(struct S *)0x03001234)')).toEqual([]);
  });

  test('REFUSES two names at ONE address — width disagreement flips ldrh to ldrb', () => {
    // REG_VCOUNT / REG_VCOUNT_L at 0x04000006 is the real instance of this.
    const text = '#define REG_VCOUNT (*(u16 *)0x04000006)\n#define REG_VCOUNT_L (*(u8 *)0x04000006)\n';
    expect(one(text)).toEqual([]);
  });

  test('REFUSES one name at two addresses — no spelling can disambiguate it', () => {
    const text = '#define gDup (*(u16 *)0x03001000)\n#define gDup (*(u16 *)0x03002000)\n';
    expect(one(text)).toEqual([]);
  });

  test('ignores everything that is not an address cast', () => {
    const text = [
      '#define OBJ_VRAM 0x06010000', // bare constant — names no cell
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))', // function-like
      '#define gPtrPtr (*(u16 **)0x03001234)', // two-LEVEL indirection, not a cell
      'u16 gNotAMacro;',
    ].join('\n');
    expect(one(text)).toEqual([]);
  });

  test('an ADDRESS EXPRESSION is folded — a literal is not the only spelling', () => {
    // The real Klonoa header shape: the cast names a helper macro, which names a base and an
    // offset, and the base is a `void *` the header does byte arithmetic on. A literal-only
    // recognizer sees none of the 466 REG_* names and reads every MMIO cell as a decimal.
    const text = [
      '#define REG_BASE (void *)0x4000000',
      '#define REG_OFFSET_BLDALPHA 0x52',
      '#define REG_ADDR_BLDALPHA (REG_BASE + REG_OFFSET_BLDALPHA)',
      '#define REG_BLDALPHA (*(vu16 *)REG_ADDR_BLDALPHA)',
    ].join('\n');
    expect(one(text)).toEqual([
      // the body is RE-SPELLED self-contained: it is republished as the definition a reproduction
      // compiles against, and the original names three more macros. `volatile u16`, not `vu16` —
      // the typedef prelude has no volatile aliases.
      {
        name: 'REG_BLDALPHA',
        address: 0x04000052,
        body: '(*(volatile u16 *)0x4000052)',
        size: 2,
        signed: false,
        volatile: true,
      },
    ]);
  });

  test("a literal address keeps the project's OWN body verbatim", () => {
    expect(one('#define gOff (*(u16 *)0x03001234)')[0].body).toBe('(*(u16 *)0x03001234)');
  });

  test('an offset expression over a literal folds too', () => {
    expect(one('#define gOff (*(u16 *)(0x03001234 + 2))')[0].address).toBe(0x03001236);
  });

  test('REFUSES an expression it cannot be sure of', () => {
    // an undefined name, a cycle, a token outside the grammar, and a function-like call
    expect(one('#define g (*(u16 *)UNDEFINED_BASE)')).toEqual([]);
    expect(one('#define A B\n#define B A\n#define g (*(u16 *)A)')).toEqual([]);
    expect(one('#define g (*(u16 *)(0x1000 * 2))')).toEqual([]);
    expect(one('#define MAX(a,b) 1\n#define g (*(u16 *)MAX(1,2))')).toEqual([]);
  });

  test('REFUSES a NEGATIVE result rather than wrapping it into an address', () => {
    expect(one('#define LO 0x10\n#define g (*(u16 *)(LO - 0x20))')).toEqual([]);
  });

  test('a redefinition of the SAME name at the same address is not a collision', () => {
    const text = '#define g (*(u16 *)0x03001234)\n#define g (*(u16 *)0x03001234)\n';
    expect(one(text)).toHaveLength(1);
  });
});

describe('macroDefinesUsedBy — a reproduction must carry what the published source names', () => {
  const map = new Map([
    [0x03005290, [{ name: 'gCollisionMapPtr', macroBody: '(*(u32 *)0x03005290)' }]],
    [0x03007ff8, [{ name: 'gIMEAcknowledge', macroBody: '(*(u16 *)0x03007FF8)' }]],
    [0x03001234, [{ name: 'gPlainExtern' }]],
  ]);

  test('emits a define for each macro the source names, and only those', () => {
    expect(macroDefinesUsedBy(map, 'void f(void) { gCollisionMapPtr = 0; }')).toBe(
      '#define gCollisionMapPtr (*(u32 *)0x03005290)\n',
    );
  });

  test('name-sorted, so the materialized context is byte-stable', () => {
    const src = 'gIMEAcknowledge = gCollisionMapPtr;';
    expect(macroDefinesUsedBy(map, src)).toBe(
      '#define gCollisionMapPtr (*(u32 *)0x03005290)\n#define gIMEAcknowledge (*(u16 *)0x03007FF8)\n',
    );
  });

  test('a non-macro symbol contributes nothing — it is declared, not defined', () => {
    expect(macroDefinesUsedBy(map, 'x = gPlainExtern;')).toBe('');
  });

  test('matches on word boundaries — a longer identifier is not a use', () => {
    expect(macroDefinesUsedBy(map, 'x = gCollisionMapPtrOther;')).toBe('');
  });

  test('a source naming nothing mapped yields an empty context addition', () => {
    expect(macroDefinesUsedBy(map, 'return 0;')).toBe('');
  });
});
