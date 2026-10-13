// The globals a declaration context declares as structs, unions or arrays (src/proto-context.ts
// `aggregateObjectsFromContext`), and the structurer reading them where it would read the map's
// `shape` (structure.ts, the declaration-shape override of `scalarGlobals`). A global the map does
// not describe and the function reads only at offset 0 is otherwise spelled by its bare name, which
// is a compile error over a struct and a read of the address over an array. The compiled proof is
// packages/cli/test/matching/context-aggregate-global.test.ts.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { aggregateObjectsFromContext } from '../src/proto-context';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_GCC } from '../src/target';

describe('aggregate objects a declaration context declares', () => {
  const ctx = `
typedef unsigned char u8;
typedef struct Pos { short x, y; } Pos;
typedef struct Fwd Fwd;
typedef Pos PosAlias;
typedef u8 *Bytes;
typedef enum { A, B } Mode;
struct Info { u8 a:1; u8 b:3; };
union U { int w; short h[2]; };
extern struct Info gInfo;
extern union U gU;
extern Pos gPos;
extern Fwd gFwd;
extern PosAlias gPosAlias;
extern u8 gTab[];
extern u8 *gPtrs[4];
extern struct Info sDefined = { 0 };
struct Inline { int a; } gInline;
extern u8 gByte;
extern u8 *gPtr;
extern struct Info *gInfoPtr;
extern u8 (*gRow)[4];
extern Bytes gBytes;
extern Mode gMode;
extern enum Tag { C } gTagged;
extern UNEXPANDED_MACRO gMacro;
struct Info gFn(void);
u8 gArrFn(void);
`;
  const found = aggregateObjectsFromContext(ctx, 'c');

  test('a struct, a union, an array and a class through a typedef are aggregates', () => {
    expect([...found].sort()).toEqual(
      ['gFwd', 'gInfo', 'gInline', 'gPos', 'gPosAlias', 'gPtrs', 'gTab', 'gU', 'sDefined'].sort(),
    );
  });

  test('a scalar, a pointer, an enum, a function and an unread type are not', () => {
    for (const n of ['gByte', 'gPtr', 'gInfoPtr', 'gRow', 'gBytes', 'gMode', 'gTagged', 'gMacro', 'gFn', 'gArrFn']) {
      expect(found.has(n), n).toBe(false);
    }
  });

  test('a C++ class is an aggregate', () => {
    expect([...aggregateObjectsFromContext('class Obj { int a; }; extern Obj gObj;', 'c++')]).toEqual(['gObj']);
  });
});

/** `ldrb` of a pool-addressed global at offset 0, and nothing else: the bare spelling's only reader */
const READ = 'f:\n\tldr\tr0, .L1\n\tldrb\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\tgInfo\n';
const STORE = 'f:\n\tldr\tr1, .L1\n\tstrb\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgInfo\n';
const INFO = new Set(['gInfo']);

describe('a context-declared aggregate the map does not describe', () => {
  test('an offset-0 read and store are spelled through the address, not the bare name', () => {
    expect(decompile('f', READ, ARMV4T_AGBCC).source).toContain('return gInfo;');
    expect(decompile('f', READ, ARMV4T_AGBCC, { aggregateGlobals: INFO }).source).toContain('return *(u8 *)&gInfo;');
    expect(decompile('f', STORE, ARMV4T_AGBCC).source).toContain('gInfo = a0;');
    expect(decompile('f', STORE, ARMV4T_AGBCC, { aggregateGlobals: INFO }).source).toContain('*(u8 *)&gInfo = a0;');
  });

  test('every ranked candidate takes it, with the map and in the raw-globals setting', () => {
    // a map that knows another name, so the raw-globals setting is enumerated
    const map: SymbolMap = new Map([[0x3000000, [{ name: 'gOther', kind: 'data', shape: 'scalar', size: 1 }]]]);
    const cands = enumerateCandidates('f', READ, ARMV4T_AGBCC, { symbols: map, aggregateGlobals: INFO });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.source, c.variations.join('/')).toContain('*(u8 *)&gInfo');
    }
  });

  test('the spelling is the toolchain-neutral structurer’s: a MIPS read takes it too', () => {
    const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlbu\tv0,0(v0)\n';
    const asmData: AsmData = {
      sections: new Map(),
      relocs: [
        { section: '.text', offset: 0, type: 'R_MIPS_HI16', sym: 'gInfo', addend: 0 },
        { section: '.text', offset: 8, type: 'R_MIPS_LO16', sym: 'gInfo', addend: 0 },
      ],
      symbols: new Map(),
      symbolCount: 0,
      bigEndian: true,
    };
    expect(decompile('getg', asm, MIPS_GCC, { asmData }).source).toContain('return gInfo;');
    expect(decompile('getg', asm, MIPS_GCC, { asmData, aggregateGlobals: INFO }).source).toContain(
      'return *(u8 *)&gInfo;',
    );
  });
});
