// A CALL THROUGH A FUNCTION POINTER, end to end through the real agbcc: reference C → `bl
// _call_via_<reg>` → lift → the candidate calls the pointer → recompiled → objdiff. Which thunk
// register agbcc picks depends on where the pointer was computed, so each shape below puts it in a
// different one.
import { decompile } from '@asmlift/core/pipeline';
import { prototypesFromContext } from '@asmlift/core/proto-context';
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
