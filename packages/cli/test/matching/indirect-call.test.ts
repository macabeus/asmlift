// A CALL THROUGH A FUNCTION POINTER, end to end through the real agbcc: reference C → `bl
// _call_via_<reg>` → lift → the candidate calls the pointer → recompiled → objdiff. Which thunk
// register agbcc picks depends on the argument count and on whether the pointer lives across a
// call, so the shapes below reach r0, r1, r2, r4 and r8.
import { decompile } from '@asmlift/core/pipeline';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { enumerateCandidates, rankBy } from '@asmlift/core/rank';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const CONTEXT = [
  'extern u8 (*const tbl[])();',
  'extern int g1, g2;',
  'extern void h(void);',
  'extern void g4(int, int, int, int);',
  '',
].join('\n');

/** The lift of `sym` out of `body` compiled with agbcc, and its recompile's score. */
function roundTrip(sym: string, body: string) {
  const asm = compileTargetAsm(CONTEXT + body, FLAGS);
  const { source } = decompile(sym, asm, ARMV4T_AGBCC, { prototypes: prototypesFromContext(CONTEXT, 'c') });
  return { asm, source, score: scoreC(CONTEXT + source, sym, assembleTarget(asm), FLAGS) };
}

describe('a call through a function pointer recompiles to its own thunk', () => {
  test.each([
    ['fresh', 'u8 fresh(void *a, s16 *b) { return tbl[b[24]](&g1, &g2); }', '_call_via_r2'],
    ['passthru', 'u8 passthru(void *a, s16 *b) { return ((u8 (*)(void *, s16 *))tbl[b[24]])(a, b); }', '_call_via_r2'],
    ['unary', 'u8 unary(void *a, s16 *b) { return ((u8 (*)())tbl[b[24]])(a); }', '_call_via_r1'],
    ['nullary', 'u8 nullary(void *a, s16 *b) { return ((u8 (*)())tbl[b[24]])(); }', '_call_via_r0'],
    ['afterCall', 'u8 afterCall(void *a, s16 *b) { h(); return ((u8 (*)())tbl[b[24]])(a, b); }', '_call_via_r2'],
    ['kept', 'u8 kept(void *a, s16 *b) { u8 (*p)() = tbl[b[24]]; h(); return p(a, b); }', '_call_via_r4'],
    [
      'high',
      'void high(u8 d, void (*move)(u8), int a, int b, int c) { h(); g4(a, b, c, d); h(); move(d); }',
      '_call_via_r8',
    ],
  ])('%s', (sym, body, thunk) => {
    const { asm, source, score } = roundTrip(sym, body);
    expect(asm).toContain(`bl\t${thunk}`);
    expect(source).not.toContain('_call_via_');
    if (!score.match) {
      console.log(`${sym}:\n${source}`, JSON.stringify(score));
    }
    expect(score.match).toBe(true);
  });
});

describe("an earlier callee's result in r0 at a call through a register", () => {
  const ctx =
    'extern void (*gq)(void);\nextern void (*gq1)(int);\nextern void (*gq0)();\nextern int g(void);\nextern int g2(int);\nextern int gw;\n';
  /** The winner over the whole fan of `sym` out of `body` compiled with agbcc. */
  const winner = (sym: string, body: string) => {
    const asm = compileTargetAsm(ctx + body, FLAGS);
    const obj = assembleTarget(asm);
    const cands = enumerateCandidates(sym, asm, ARMV4T_AGBCC, { prototypes: prototypesFromContext(ctx, 'c') });
    return rankBy(cands, sym, (src) => scoreC(ctx + src, sym, obj, FLAGS)).winner;
  };

  // Under an equality guard agbcc knows r0's value, so a source that passed it would load the
  // constant (`mov r0,#0`) before the thunk: only the narrower reading recompiles.
  test.each([
    ['x7', 'void x7(void) { void (*p)(void) = gq; if (g()) return; p(); }'],
    ['y4', 'void y4(void) { void (*p)(void) = gq; if (g() != 7) return; p(); }'],
    ['x5', 'void x5(void) { void (*p)(void) = gq; while (g()) gw++; p(); }'],
    ['big', 'void big(void) { void (*p)(void) = gq; if (g() == 1000) p(); }'],
    ['loopguard', 'void loopguard(int x) { void (*p)(void) = gq; int v = g(); while (x != 0) x--; if (v == 0) p(); }'],
  ])('is dropped where only the narrower reading matches (%s)', (sym, body) => {
    const w = winner(sym, body);
    expect(w.score.match).toBe(true);
    expect(w.variations).toContain('setup-args');
  });

  // The narrower reading cuts every site at once, so a site that passes the result keeps it there
  // too while another site is the one that needs that reading.
  test.each([
    ['c1', 'void c1(int x) { void (*p)(int) = gq1; if (x == 0) hh(); p(g()); }'],
    ['c2', 'void c2(int x) { void (*p)(int) = gq1; if (x == 0) hh(); gw = 1; p(g()); }'],
    ['d1', 'void d1(void) { void (*p)(void) = gq; void (*q)(int) = gq1; q(g()); if (g()) return; p(); }'],
    ['e3', 'void e3(void) { void (*q)() = gq0; q(g()); if (g() == 3) q(); }'],
  ])('is kept where another site needs the narrower reading (%s)', (sym, body) => {
    const w = winner(sym, body);
    expect(w.score.match).toBe(true);
    expect(w.source).toContain(')(g());');
  });

  // `g(); …; p();` compiles to the same bytes, and ties: the reading that passes it must not drop it.
  test.each([
    ['looped', 'void looped(int x) { int (*p)(int) = (int (*)(int))gq1; int v = g(); while (x != 0) x--; p(v); }'],
    [
      'loopret',
      'int loopret(int x) { int (*p)(int) = (int (*)(int))gq1; int v = g(); while (x != 0) x--; return p(v); }',
    ],
    ['joined', 'void joined(int x) { void (*p)(int) = gq1; int v; if (x) v = g(); else v = g2(x); p(v); }'],
  ])('is kept where it reaches the call by a join (%s)', (sym, body) => {
    const w = winner(sym, body);
    expect(w.score.match).toBe(true);
    expect(w.source).toMatch(/v0\)\(v\d\)/);
  });

  test('is kept where the path to the call proves it only unequal to a constant', () => {
    const w = winner('w2', 'void w2(void) { void (*p)(int) = gq1; int v = g(); if (v == 0) return; p(v); }');
    expect(w.score.match).toBe(true);
    expect(w.variations).not.toContain('setup-args');
    expect(w.source).toContain('v0)(v1)');
  });
});
