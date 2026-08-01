// Address-cast macro recognition: the OTHER way a project names a fixed RAM cell, and the one
// that makes an old compiler emit the NUMERIC pool word a target shows. Everything recognized is
// a fact spelled exactly; everything else is refused (a wrong width or a dropped `volatile` is
// the plausible-but-wrong class this project exists to avoid).
import { describe, expect, test } from 'vitest';

import { addressCastMacros } from '../src/macros';

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

  test('REFUSES a volatile alias — the qualifier must never be silently dropped', () => {
    expect(one('#define gPauseFlag (*(vu8 *)0x030034E4)')).toEqual([]);
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

  test('ignores everything that is not the exact shape', () => {
    const text = [
      '#define REG_KEYINPUT (*(vu16 *)REG_ADDR_KEYINPUT)', // two-level
      '#define OBJ_VRAM 0x06010000', // bare constant
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))', // function-like
      '#define gOff (*(u16 *)(0x03001234 + 2))', // offset expression
      'u16 gNotAMacro;',
    ].join('\n');
    expect(one(text)).toEqual([]);
  });

  test('a redefinition of the SAME name at the same address is not a collision', () => {
    const text = '#define g (*(u16 *)0x03001234)\n#define g (*(u16 *)0x03001234)\n';
    expect(one(text)).toHaveLength(1);
  });
});
