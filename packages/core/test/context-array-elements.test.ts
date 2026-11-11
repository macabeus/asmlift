// The struct element of each array a declaration context declares (src/proto-context.ts
// `globalsFromContext`, `arrayElements`): what the structurer needs to spell an element's member
// through the declaration, `gBgInfo[i].hOfs`, rather than through a cast of the array's address.
import { describe, expect, test } from 'vitest';

import { aggregateType } from '../src/aggregate';
import { globalsFromContext } from '../src/proto-context';
import { ARMV4T_AGBCC } from '../src/target';

const CTX = `
typedef unsigned char u8;
typedef unsigned short u16;
struct BgInfo {
    void *pTiles;
    void *pTilemap;
    u16 hOfs;
    u16 vOfs;
    u16 tileCol;
    u16 tileRow;
    u16 hLength;
    u16 vLength;
    u16 unk14;
    u16 nbrTiles;
    u8 tileSize;
    u8 pad19[0x1C - 0x19];
};
typedef struct Pos { short x, y; } Pos;
typedef struct { u8 a; u16 b; } Anon;
typedef Pos PosAlias;
union U { int w; short h[2]; };
struct Packed { u8 a; u16 b; } __attribute__((packed));
struct Fwd;
extern struct BgInfo gBgInfo[4];
extern struct BgInfo gUnsized[];
extern Pos gPos[3];
extern PosAlias gAlias[2];
extern Anon gAnon[5];
extern Pos gRank2[2][3];
extern union U gU[2];
extern struct Packed gPacked[2];
extern struct Fwd gFwd[2];
extern Pos gMacro[UNEXPANDED_MACRO];
extern Pos gOne;
extern u16 gHalves[4];
extern Pos *gPtrs[4];
`;

describe('the struct element of an array a declaration context declares', () => {
  const { arrayElements } = globalsFromContext(CTX, 'c');
  const el = (n: string) => arrayElements?.get(n);

  test('a tagged struct element, with its extent and members', () => {
    expect(el('gBgInfo')?.spelling).toBe('struct BgInfo');
    expect(el('gBgInfo')?.dims).toEqual([4]);
    expect(el('gBgInfo')?.layout.members?.map((m) => m.name)).toEqual([
      'pTiles',
      'pTilemap',
      'hOfs',
      'vOfs',
      'tileCol',
      'tileRow',
      'hLength',
      'vLength',
      'unk14',
      'nbrTiles',
      'tileSize',
      'pad19',
    ]);
  });

  test('laid out by the target at the offsets the header places them', () => {
    const t = aggregateType('BgInfo', 'struct BgInfo', el('gBgInfo')!.layout, ARMV4T_AGBCC);
    expect(t?.kind === 'struct' && t.size).toBe(28);
    expect(t?.kind === 'struct' && t.fields.map((f) => [f.name, f.off])).toEqual([
      ['pTiles', 0],
      ['pTilemap', 4],
      ['hOfs', 8],
      ['vOfs', 10],
      ['tileCol', 12],
      ['tileRow', 14],
      ['hLength', 16],
      ['vLength', 18],
      ['unk14', 20],
      ['nbrTiles', 22],
      ['tileSize', 24],
      ['pad19', 25],
    ]);
  });

  test('an unsized outermost extent is null', () => {
    expect(el('gUnsized')?.dims).toEqual([null]);
  });

  test('a typedef element, through an alias, and an untagged one', () => {
    expect(el('gPos')?.spelling).toBe('Pos');
    expect(el('gPos')?.layout.members?.map((m) => m.name)).toEqual(['x', 'y']);
    expect(el('gAlias')?.layout.members?.map((m) => m.name)).toEqual(['x', 'y']);
    expect(el('gAnon')?.layout.members?.map((m) => m.name)).toEqual(['a', 'b']);
  });

  test('rank 2 keeps both extents', () => {
    expect(el('gRank2')?.dims).toEqual([2, 3]);
  });

  test('a union element is one, with its kind', () => {
    expect(el('gU')?.layout.kind).toBe('union');
  });

  test('an attributed body, a body the context lacks and an unresolved extent state no element', () => {
    expect(el('gPacked')).toBeUndefined();
    expect(el('gFwd')).toBeUndefined();
    expect(el('gMacro')).toBeUndefined();
  });

  test('a member pointing at a function is a pointer, and a fixed-width member has its stated sign', () => {
    const { arrayElements: els } = globalsFromContext(
      `typedef unsigned short uint16_t; typedef signed char int8_t; typedef unsigned int size_t;
       typedef void (*Fp)(void);
       struct M { Fp f; void (*g)(int); uint16_t h; int8_t b; size_t n; };
       extern struct M gM[2];`,
      'c',
    );
    const t = aggregateType('M', 'struct M', els!.get('gM')!.layout, ARMV4T_AGBCC);
    const field = (n: string) => (t?.kind === 'struct' ? t.fields.find((f) => f.name === n)?.type : undefined);
    expect(field('f')?.kind).toBe('ptr');
    expect(field('g')?.kind).toBe('ptr');
    expect(field('h')).toEqual({ kind: 'int', width: 16, signed: false });
    expect(field('b')).toEqual({ kind: 'int', width: 8, signed: true });
    // `size_t` states no sign this reads, so no read of it is typed
    expect(field('n')).toBeUndefined();
  });

  test('a struct object, a scalar array and an array of pointers are no struct array', () => {
    expect(el('gOne')).toBeUndefined();
    expect(el('gHalves')).toBeUndefined();
    expect(el('gPtrs')).toBeUndefined();
  });
});
