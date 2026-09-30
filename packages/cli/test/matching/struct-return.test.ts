// A CALL TO A FUNCTION RETURNING A STRUCT, end to end through the real agbcc: the reference C calls
// it → target → lift, with the callee's prototype read out of the declarations the reference was
// compiled against → every candidate compiled with the declaration block the scorer prepends → the
// best one matches. Where agbcc returns the struct through memory it hands the callee the storage in
// r0 and moves every declared argument one register up (thumb.h:644-645, 672); where it returns it
// in r0 nothing moves. A lift that got either wrong scores a different call.
//
// Scored in BOTH worlds a candidate is compiled in: self-declared (the declaration block asmlift
// renders, then the source) and inside the project's headers (the headers, then the source, and no
// block). The returned struct is the headers' type, so the source must not define it: a definition
// there is a redefinition in the second world.
import { renderDeclarations } from '@asmlift/core/declare';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { enumerateCandidates } from '@asmlift/core/rank';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const DECLS = `struct Blob64 { u32 w[16]; };
struct Blob64 makeblob(const void *);
extern const u8 gBlob[64];
struct S4 { u8 a, b, c, d; };
struct S4 mk4(s32);
struct S8 { u32 a, b; };
struct S8 mk8r(s32, s32, s32, s32);
typedef struct { u32 w[16]; } BlobT;
BlobT makeblobt(const void *);
struct Mix { u8 a; s16 w[2][3]; const u8 *p; };
struct Mix mkmix(s32);
struct W1 { u32 x; };
struct W1 mkw(s32);
struct W1 fillw(s32 *);
extern void usei(s32);
`;

const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;

/** The best candidate's score for one reference function `f` in each world, and its source. */
function best(src: string): { self: number; headers: number; source: string } {
  const targetAsm = compileTargetAsm(DECLS + src, FLAGS);
  const obj = assembleTarget(targetAsm);
  const prototypes = prototypesFromContext(DECLS, 'c');
  let out = { self: Number.POSITIVE_INFINITY, headers: Number.POSITIVE_INFINITY, source: '' };
  for (const c of enumerateCandidates('f', targetAsm, ARMV4T_AGBCC, { prototypes })) {
    const decls = c.symbolRefs?.length ? renderDeclarations(c.symbolRefs) : '';
    const self = scoreC(decls + c.source, 'f', obj, FLAGS).score;
    if (self < out.self) {
      out = { ...out, self, source: c.source };
    }
    out.headers = Math.min(out.headers, scoreC(DECLS + c.source, 'f', obj, FLAGS).score);
  }
  return out;
}

describe('a call to a function returning a struct', () => {
  test.each([
    ['a 64-byte struct whose storage is never read', 'void f(void) { struct Blob64 b = makeblob(gBlob); }'],
    ['a one-word struct of four members, discarded', 'void f(s32 x) { mk4(x); }'],
    ['the storage above an outgoing stack argument', 'void f(s32 x, s32 y, s32 z, s32 w) { mk8r(x, y, z, w); }'],
    ['two calls, two stores', 'void f(s32 x, s32 y) { mk4(x); mk4(y); }'],
    ['two calls in two arms', 'void f(s32 x) { if (x) mk4(x); else makeblob(gBlob); }'],
    ['a typedef name with no tag', 'void f(void) { BlobT b = makeblobt(gBlob); }'],
    ['members of several widths, an array of arrays and a pointer', 'void f(s32 x) { mkmix(x); }'],
    // agbcc returns a one-member word in r0: no hidden pointer, no argument moves
    ['a struct returned in r0, discarded', 'void f(s32 x) { mkw(x); usei(x + 1); }'],
    // …so a frame word it takes at argument 0 is an out-parameter
    ['an out-parameter of a callee returning a struct in r0', 'void f(void) { s32 v; fillw(&v); usei(v); }'],
  ])('%s', (_label, src) => {
    const r = best(src);
    expect(r.self, r.source).toBe(0);
    expect(r.headers, r.source).toBe(0);
  });
});
