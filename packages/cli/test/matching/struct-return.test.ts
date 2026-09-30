// A CALL TO A FUNCTION RETURNING A STRUCT THROUGH MEMORY, end to end through the real agbcc: the
// reference C calls it → target → lift, with the callee's prototype read out of the declarations
// the reference was compiled against → every candidate compiled with the declaration block the
// scorer prepends → the best one matches. agbcc hands the callee the storage in r0 and moves every
// declared argument one register up (thumb.h:644-645, 672), so a lift that got either wrong scores
// a different call.
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
`;

const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;

/** The best candidate's score for one reference function `f`, and its source. */
function best(src: string): { score: number; source: string } {
  const targetAsm = compileTargetAsm(DECLS + src, FLAGS);
  const obj = assembleTarget(targetAsm);
  const prototypes = prototypesFromContext(DECLS, 'c');
  let out = { score: Number.POSITIVE_INFINITY, source: '' };
  for (const c of enumerateCandidates('f', targetAsm, ARMV4T_AGBCC, { prototypes })) {
    const decls = c.symbolRefs?.length ? renderDeclarations(c.symbolRefs) : '';
    const { score } = scoreC(decls + c.source, 'f', obj, FLAGS);
    if (score < out.score) {
      out = { score, source: c.source };
    }
  }
  return out;
}

describe('a struct returned through memory', () => {
  test.each([
    ['a 64-byte struct whose storage is never read', 'void f(void) { struct Blob64 b = makeblob(gBlob); }'],
    ['a one-word struct of four members, discarded', 'void f(s32 x) { mk4(x); }'],
    ['the storage above an outgoing stack argument', 'void f(s32 x, s32 y, s32 z, s32 w) { mk8r(x, y, z, w); }'],
    ['two calls, two stores', 'void f(s32 x, s32 y) { mk4(x); mk4(y); }'],
    ['two calls in two arms', 'void f(s32 x) { if (x) mk4(x); else makeblob(gBlob); }'],
  ])('%s', (_label, src) => {
    const r = best(src);
    expect(r.score, r.source).toBe(0);
  });
});
