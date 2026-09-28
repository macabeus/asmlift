// Callee prototypes read out of a declaration context (src/proto-context.ts): what is read, what is
// skipped, and that every typedef resolves to the SAME type — a spelling here is printed beside the
// project's own headers, where a different type is a conflicting declaration.
import { describe, expect, test } from 'vitest';

import { declaredArgWidths, declaredWidth } from '../src/proto';
import { prototypesFromContext } from '../src/proto-context';

// the CARD block of Pikmin's preprocessed context, as vendored for its benchmark rows
const PIKMIN_CARD = `
# 1 "include/types.h"
typedef signed long s32;
typedef unsigned long u32;
typedef int BOOL;
typedef void (*CARDCallback)(s32 channel, s32 result);
typedef struct CARDMemoryCard { u8 buf[0x8000]; } CARDMemoryCard;
#ifdef __cplusplus
extern "C"{
#endif
s32 CARDCheckAsync(s32 channel, CARDCallback);
s32 CARDGetSectorSize(s32 channel, u32* size);
BOOL CARDProbe(s32 channel);
s32 CARDMountAsync(s32 channel, CARDMemoryCard* workArea, CARDCallback detachCallback, CARDCallback attachCallback);
void CARDInit();
#ifdef __cplusplus
}
#endif
`;

describe('prototypes from a declaration context', () => {
  test('reads a C-linkage block of a C++ context, resolving each typedef to the same type', () => {
    const p = prototypesFromContext(PIKMIN_CARD, 'c++');
    expect(p.CARDProbe).toEqual({ returns: 'int', params: ['s32'] });
    expect(p.CARDGetSectorSize).toEqual({ returns: 's32', params: ['s32', 'u32 *'] });
    expect(p.CARDCheckAsync).toEqual({ returns: 's32', params: ['s32', 'void (*)(s32 channel, s32 result)'] });
    // a struct keeps its name: it sizes only as the pointee of a pointer
    expect(p.CARDMountAsync?.params?.[1]).toBe('CARDMemoryCard *');
    expect(declaredArgWidths(p.CARDMountAsync)).toEqual([32, 32, 32, 32]);
    // `()` is an empty list in C++
    expect(p.CARDInit).toEqual({ returnsVoid: true, params: [] });
  });

  test('an empty list is UNSTATED in C, and `(void)` is empty in both', () => {
    const src = 'int f(); int g(void);';
    expect(prototypesFromContext(src, 'c').f).toEqual({ returns: 'int' });
    expect(prototypesFromContext(src, 'c').g).toEqual({ returns: 'int', params: [] });
    expect(prototypesFromContext(src, 'c++').f).toEqual({ returns: 'int', params: [] });
  });

  test('keeps qualifiers, reads arrays and function-pointer parameters as pointers', () => {
    const p = prototypesFromContext(
      'typedef unsigned long size_t; void *memcpy(void *dst, const void *src, size_t n); int sum(int v[4], int (*cmp)(int, int));',
      'c',
    );
    expect(p.memcpy).toEqual({ returns: 'void *', params: ['void *', 'const void *', 'size_t'] });
    expect(p.sum?.params).toEqual(['int *', 'int (*)(int, int)']);
    expect(declaredArgWidths(p.sum)).toEqual([32, 32]);
  });

  test('a list holding a spelling that cannot be sized is kept, and the frontend abstains on it', () => {
    const p = prototypesFromContext(
      'typedef struct Vec { float x, y; } Vec; float len(Vec v); float sq(float x);',
      'c',
    );
    expect(p.len?.params).toEqual(['Vec']);
    expect(declaredArgWidths(p.len)).toBeUndefined();
    expect(declaredArgWidths(p.sq)).toBeUndefined();
  });

  test('skips members, namespaces, templates, operators and variadics; drops an overloaded name', () => {
    const p = prototypesFromContext(
      `class Card { public: int probe(int chan); };
       namespace zen { int helper(int); }
       template <typename T> T id(T x);
       int operator+(int a, int b);
       int printf(const char *fmt, ...);
       int ov(int); int ov(float);
       int same(int); int same(int);
       int after(int x) { return x; }
       int last(int);`,
      'c++',
    );
    expect(Object.keys(p).sort()).toEqual(['after', 'last', 'printf', 'same']);
    expect(p.printf).toEqual({ returns: 'int' });
    expect(p.after).toEqual({ returns: 'int', params: ['int'] });
  });

  test('C++ default arguments and comments do not reach a spelling', () => {
    const p = prototypesFromContext('/* a */ int f(int a = 3, /* b */ int b = 4); // c', 'c++');
    expect(p.f).toEqual({ returns: 'int', params: ['int', 'int'] });
  });
});

describe('declaredWidth', () => {
  test('a function pointer is register-wide', () => {
    expect(declaredWidth('void (*)(s32 channel, s32 result)')).toBe(32);
    expect(declaredWidth('int (*)(void)')).toBe(32);
  });
});
